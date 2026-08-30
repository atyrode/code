package main

// The OMP side of Babel's analysis-worker seam.
//
// Everything above the investigator interface speaks Babel's wire format and
// knows nothing about OMP. Everything here drives OMP and knows nothing about
// the wire: it is handed a job value, an emit function and a request function,
// and it hands back a result. That split is what lets worker mode be tested
// without OMP installed and this file be tested without a Babel on the other
// end.
//
// The design in one sentence: the model gets exactly the tools the run's grant
// justifies, every call on one of them is asked of Babel before it is served,
// and a refusal is a fact the model is told about rather than a reason to stop.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// ── the profile this investigator needs ──────────────────────────────────────

// profileSource is the narrow view of Code's profile store the investigator
// depends on. It is deliberately one method: the investigator needs a resolved
// profile and nothing else about how profiles are stored, named, versioned or
// written, so the store can change shape without this file noticing.
type profileSource interface {
	// resolveProfile opens one saved profile. A revision of 0 asks for the
	// current one. A profile that does not exist must fail rather than be
	// invented: Babel records what this returns in a receipt.
	resolveProfile(id string, revision int) (resolvedProfile, error)
}

// resolvedProfile is one saved Code profile, opened. Everything in it is
// non-secret by contract — Babel refuses a configuration whose metadata looks
// like it holds a credential, and the provider credential reaches OMP through
// the auth broker, never through here.
type resolvedProfile struct {
	// Ref is the reference actually resolved, with the revision filled in.
	Ref babelProfileRef
	// Disclosure is babelDisclosureLocal or babelDisclosureHosted.
	Disclosure string
	// Cost is the profile's own estimate, never a measurement.
	Cost babelCost
	// Metadata is the provider/model/thinking triple Babel puts in the
	// receipt, plus whatever else the store considers non-secret.
	Metadata map[string]string
	// ConfigYAML is the OMP configuration overlay this profile launches with,
	// as genConfigYAML renders it.
	ConfigYAML string
}

// errOmpProfileUnavailable marks the resolve failure Babel has a code for, so
// the protocol layer can map it to babelErrProfileUnavailable instead of
// guessing from the message.
var errOmpProfileUnavailable = errors.New("profile unavailable")

// ── capability → host tool ───────────────────────────────────────────────────

// ompEvidenceTool is one Babel capability expressed as a tool the model can
// call. The parameters are a literal JSON Schema rather than a built map: they
// are constant, and OMP wants them verbatim.
type ompEvidenceTool struct {
	capability  string
	name        string
	label       string
	description string
	parameters  string
	// reason is what Babel's authorizer is told when the model calls this
	// tool. It is a fixed sentence about the capability rather than a summary
	// of the arguments, because a tool-request's reason travels to Babel and a
	// summary could carry a private locator into a place Babel logs.
	reason string
}

// ompEvidenceTools is the whole capability-to-tool mapping, in registration
// order. A capability with no entry here cannot be reached at all, which is the
// intended failure mode for a capability Babel grows before Code does: the
// model simply has no way to ask.
var ompEvidenceTools = []ompEvidenceTool{
	{
		capability: babelCapabilityCorpusSearch,
		name:       "babel_corpus_search",
		label:      "Babel corpus search",
		description: "Search Babel's archived-session corpus. Returns matching excerpts with their " +
			"source identifiers. Every call is authorized by Babel before it runs and may be refused.",
		parameters: `{"type":"object","properties":{` +
			`"query":{"type":"string","description":"What to look for, as a search expression."},` +
			`"limit":{"type":"integer","minimum":1,"maximum":50,"description":"Maximum excerpts to return."}` +
			`},"required":["query"],"additionalProperties":false}`,
		reason: "the analysis needs archived corpus material to support a finding",
	},
	{
		capability: babelCapabilityRepoRead,
		name:       "babel_repo_read",
		label:      "Babel repository read",
		description: "Read one approved repository file through Babel. Only paths inside the run's " +
			"approved sources can be served; anything else is refused.",
		parameters: `{"type":"object","properties":{` +
			`"path":{"type":"string","description":"Repository-relative path to read."},` +
			`"lines":{"type":"string","description":"Optional line selector, for example 40-120."}` +
			`},"required":["path"],"additionalProperties":false}`,
		reason: "the analysis needs the contents of an approved repository file",
	},
	{
		capability: babelCapabilitySandboxExec,
		name:       "babel_sandbox_exec",
		label:      "Babel sandbox execution",
		description: "Run one command in Babel's disposable sandbox and return its output. There is " +
			"no shell, no network and no persistence between calls.",
		parameters: `{"type":"object","properties":{` +
			`"command":{"type":"string","description":"The command to run."},` +
			`"argv":{"type":"array","items":{"type":"string"},"description":"Arguments, unquoted."}` +
			`},"required":["command"],"additionalProperties":false}`,
		reason: "the analysis needs to execute a command to verify a claim",
	},
	{
		capability: babelCapabilityPublicResearch,
		name:       "babel_public_research",
		label:      "Babel public research",
		description: "Search public sources through Babel's egress broker. This run has no network of " +
			"its own, so this is the only route to anything outside the corpus.",
		parameters: `{"type":"object","properties":{` +
			`"query":{"type":"string","description":"What to research."}` +
			`},"required":["query"],"additionalProperties":false}`,
		reason: "the analysis needs public material that is not in the corpus",
	},
}

// ompToolsFor is the tools one grant justifies. A capability the grant does not
// carry produces no tool, so the model is never shown a route it would only be
// refused on — a denial is survivable, but an avoidable one wastes a turn and
// pollutes the receipt.
func ompToolsFor(grant babelGrant) []ompEvidenceTool {
	tools := make([]ompEvidenceTool, 0, len(ompEvidenceTools))
	for _, tool := range ompEvidenceTools {
		if grant.allows(tool.capability) {
			tools = append(tools, tool)
		}
	}
	return tools
}

// ompHostToolWires renders the tools for set_host_tools. loadMode "essential"
// keeps them in the model's initial tool set: a host tool defaults to
// "discoverable", which would hide the run's only evidence route behind a
// discovery step.
func ompHostToolWires(tools []ompEvidenceTool) []ompHostToolWire {
	wires := make([]ompHostToolWire, len(tools))
	for i, tool := range tools {
		wires[i] = ompHostToolWire{
			Name:        tool.name,
			Label:       tool.label,
			Description: tool.description,
			Parameters:  json.RawMessage(tool.parameters),
			LoadMode:    "essential",
		}
	}
	return wires
}

// ── the result payload ───────────────────────────────────────────────────────

// ompFindings is the analysis output. The evidence log is part of it on
// purpose: a finding a reviewer cannot trace to the evidence behind it, or to
// the refusal that left a hole, is not worth recording.
type ompFindings struct {
	RunID     string           `json:"run_id"`
	Directive string           `json:"directive,omitempty"`
	Recipes   []string         `json:"recipes,omitempty"`
	Sources   []string         `json:"sources,omitempty"`
	Evidence  []ompEvidenceLog `json:"evidence,omitempty"`
	Analysis  string           `json:"analysis,omitempty"`
	Gaps      []string         `json:"gaps,omitempty"`
}

// ompEvidenceLog is one evidence request and what became of it. Decision holds
// Babel's own word — "allow" or "deny" — so the payload reports the decision
// received rather than the worker's interpretation of it.
type ompEvidenceLog struct {
	Capability string `json:"capability"`
	Tool       string `json:"tool"`
	Decision   string `json:"decision"`
	Code       string `json:"code,omitempty"`
	Reason     string `json:"reason,omitempty"`
	Served     bool   `json:"served"`
	Note       string `json:"note,omitempty"`
}

// Progress stages. Babel keeps an interface responsive from these, so they name
// what the run is doing rather than which function is on the stack.
const (
	ompStageResolve  = "resolve"
	ompStageLaunch   = "launch"
	ompStageAnalyse  = "analyse"
	ompStageEvidence = "evidence"
	ompStageReport   = "report"
)

// ompFraction maps a step count onto a progress fraction that rises fast at
// first and never reaches 1. A run's length is unknown, so claiming completion
// before the terminal event would put a number on Babel's interface that the
// run then has to contradict.
func ompFraction(step int) float64 {
	if step < 0 {
		step = 0
	}
	return 0.9 - 0.8/float64(step+1)
}

// ── the investigator ─────────────────────────────────────────────────────────

// ompInvestigator runs one analysis job by driving `omp --mode rpc` as a child
// and brokering every tool call through Babel.
//
// The function-valued fields are seams, not configuration: they let the driver
// be exercised against a fake OMP and a fake broker, which is the only way to
// test a denial mid-run without a provider.
type ompInvestigator struct {
	profiles profileSource
	lookOmp  func() (string, error)
	environ  func() []string
	evidence func(ctx context.Context, broker babelBroker, request ompEvidenceRequest) (string, error)
	// pace and slowBudget shape a conformance "slow" run: how often it reports
	// progress, and when it gives up on being cancelled.
	pace       time.Duration
	slowBudget time.Duration
}

// The seam is checked at compile time: the protocol layer plugs this in behind
// the investigator interface, and a signature drifting out from under that
// plug should fail the build here rather than at the one call site.
var _ investigator = (*ompInvestigator)(nil)

func newOmpInvestigator(profiles profileSource) *ompInvestigator {
	return &ompInvestigator{
		profiles:   profiles,
		lookOmp:    func() (string, error) { return resolveLaunchPath("CODE_OMP", []string{"omp"}) },
		environ:    os.Environ,
		evidence:   fetchBrokeredEvidence,
		pace:       time.Second,
		slowBudget: ompSlowBudget,
	}
}

// ── containment ──────────────────────────────────────────────────────────────

// ompContainmentEscape is Code's statement of what it does not contain. It is
// long because it is the honest answer, and Babel's receipt is read by someone
// deciding whether to trust evidence produced behind this boundary.
const ompContainmentEscape = "OMP runs as an ordinary child process under the same uid as Code: no namespace, " +
	"no chroot, no seccomp filter and no rlimit. Code has no sandbox to offer — runSandbox only execs an " +
	"operator-named launcher with the auth environment stripped — so nothing here enforces a boundary. " +
	"The investigator does narrow what the model can reach: --no-tools plus a private OMP home leaves the " +
	"session's tool registry holding only the Babel-brokered host tools, and the run's writes default into " +
	"a temporary directory Code deletes at teardown. That is a tool-surface restriction, not containment. " +
	"Any OMP defect, extension, MCP server or provider-side capability has the full filesystem and the full " +
	"network of the invoking user, the run can exhaust CPU, memory and disk, and nothing outside the " +
	"temporary directory is disposed of."

// containment declares what this investigator actually runs inside.
//
// Every field is false, and that is the finding rather than an omission. Babel
// requires filesystem isolation, network default-deny, resource ceilings and a
// disposable environment for an exploration run, and Code provides none of the
// four today: the OMP child is a plain fork of the same user with the same
// filesystem and the same network. Declaring otherwise would start runs that
// Babel would then record as sandboxed in a receipt a reviewer trusts, which is
// a worse outcome than a refusal. Babel refusing this declaration is the
// mechanism working.
func (o *ompInvestigator) containment() babelContainment {
	return babelContainment{
		Backend:             "process",
		FilesystemIsolation: false,
		NetworkDefaultDeny:  false,
		ResourceCeilings:    false,
		Disposable:          false,
		Escape:              ompContainmentEscape,
	}
}

// ── resolve ──────────────────────────────────────────────────────────────────

// resolve opens the named profile and returns what Babel records.
//
// The rule is resolve-or-fail. A profile Code cannot find produces
// errOmpProfileUnavailable rather than an echo of the reference, because a
// reference Code cannot back is a claim about a profile it does not have and
// Babel writes claims into receipts. The context is unused: a profile resolves
// out of local state with no cancellable work in it, and pretending otherwise
// would suggest this call can block.
func (o *ompInvestigator) resolve(_ investigatorContext, ref babelProfileRef) (babelConfiguration, error) {
	profile, err := o.openProfile(ref)
	if err != nil {
		return babelConfiguration{}, err
	}
	return ompConfigurationOf(profile.Ref, profile.Disclosure, profile.Cost, profile.Metadata), nil
}

// openProfile resolves and validates one profile. The validation is Babel's
// contract restated locally: a receipt needs a positive revision, a known
// disclosure class and some provider metadata, and finding that out here beats
// finding it out as a refused event three messages later.
func (o *ompInvestigator) openProfile(ref babelProfileRef) (resolvedProfile, error) {
	if o.profiles == nil {
		return resolvedProfile{}, fmt.Errorf("%w: no profile store is wired into the investigator", errOmpProfileUnavailable)
	}
	profile, err := o.profiles.resolveProfile(ref.ID, ref.Revision)
	if err != nil {
		return resolvedProfile{}, fmt.Errorf("%w: %s: %w", errOmpProfileUnavailable, ompProfileName(ref), err)
	}
	if profile.Ref.ID == "" {
		return resolvedProfile{}, fmt.Errorf("%w: %s resolved to a profile with no id",
			errOmpProfileUnavailable, ompProfileName(ref))
	}
	if profile.Ref.Revision <= 0 {
		return resolvedProfile{}, fmt.Errorf("%w: %s resolved to revision %d, and a receipt needs a positive one",
			errOmpProfileUnavailable, ompProfileName(ref), profile.Ref.Revision)
	}
	switch profile.Disclosure {
	case babelDisclosureLocal, babelDisclosureHosted:
	default:
		return resolvedProfile{}, fmt.Errorf("%w: %s declares disclosure class %q",
			errOmpProfileUnavailable, ompProfileName(ref), profile.Disclosure)
	}
	if len(profile.Metadata) == 0 {
		return resolvedProfile{}, fmt.Errorf("%w: %s resolved no provider metadata, and a receipt requires it",
			errOmpProfileUnavailable, ompProfileName(ref))
	}
	return profile, nil
}

func ompProfileName(ref babelProfileRef) string {
	if ref.ID == "" {
		return "the current profile"
	}
	if ref.Revision <= 0 {
		return "profile " + ref.ID
	}
	return "profile " + ref.ID + "@" + strconv.Itoa(ref.Revision)
}

// ompConfigurationOf assembles the configuration event's non-secret half.
//
// Seq, Time and Capabilities are left to the protocol layer: sequencing is its
// business, and the run's capability list comes from the job's grant, which
// resolve is not given. In worker mode the protocol layer also attaches
// containment.
//
// Redaction is required exactly when the profile is hosted. A hosted profile
// sends material to a third party, which is the thing redaction protects
// against; a local profile discloses nothing off the machine, so requiring
// redaction of it would be ceremony.
func ompConfigurationOf(ref babelProfileRef, disclosure string, cost babelCost, metadata map[string]string) babelConfiguration {
	return babelConfiguration{
		Type:    babelMessageConfiguration,
		Profile: ref,
		Privacy: babelPrivacy{
			Disclosure:        disclosure,
			RedactionRequired: disclosure == babelDisclosureHosted,
		},
		Cost:     cost,
		Metadata: ompCloneMetadata(metadata),
	}
}

func ompCloneMetadata(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

// syntheticConfiguration is resolve's conformance exception, kept off resolve
// because resolve is not given the job and therefore cannot tell a conformance
// run from a production one. Only the protocol layer holds the job, so it owns
// the choice: it calls this when job.conformanceRequested() reports true and
// calls resolve strictly otherwise. Declaring the method is how this
// investigator opts in; an investigator that declares nothing is simply never
// offered the exception.
//
// The suite names a profile no local store will ever hold, on purpose, so it can
// grade a worker with no store at all. Echoing the reference is correct here and
// only here. The metadata says so rather than naming a provider: nothing is
// resolved, nothing is charged, and no model is called, so a provider name would
// be the very kind of claim the resolve-or-fail rule exists to prevent.
func (o *ompInvestigator) syntheticConfiguration(job babelJob) babelConfiguration {
	disclosure := job.Grant.Disclosure
	if disclosure != babelDisclosureHosted {
		disclosure = babelDisclosureLocal
	}
	return ompConfigurationOf(job.Profile, disclosure, babelCost{Currency: "USD"}, map[string]string{
		"provider":     "none",
		"model":        "none",
		"thinking":     "off",
		"investigator": "omp-rpc",
		"conformance":  job.conformanceDirective(),
	})
}

// ── investigate ──────────────────────────────────────────────────────────────

// investigate runs the job to a terminal outcome.
//
// A conformance job takes the synthetic path: the obligations Babel needs to
// observe — that a denial does not end a run, that no result follows an error,
// that cancellation is prompt — have to be reachable on a machine with no
// provider and no network, so they are reached without launching OMP at all.
// The gate is conformanceRequested rather than the directive, because the
// directive defaults an absent key to well-behaved and so reads identically for
// a production job.
func (o *ompInvestigator) investigate(ctx investigatorContext, job babelJob,
	emit func(stage, message string, fraction float64),
	request func(capability, tool, reason string, arguments json.RawMessage) babelDecision,
) (babelResult, error) {
	var base context.Context = ctx
	if job.conformanceRequested() {
		return o.conform(base, job, emit, request)
	}
	return o.drive(base, job, emit, request)
}

// ompFindingsOf seeds the payload with what the job itself says, so a receipt
// records which recipes ran over which sources even when the analysis produced
// little else.
func ompFindingsOf(job babelJob) ompFindings {
	findings := ompFindings{RunID: job.RunID}
	for _, recipe := range job.Recipes {
		findings.Recipes = append(findings.Recipes, recipe.ID+"@"+strconv.Itoa(recipe.Version))
	}
	for _, source := range job.Sources {
		findings.Sources = append(findings.Sources, source.Kind+":"+source.Selector)
	}
	return findings
}

// ompResultOf builds the terminal result. It is the only place this
// investigator names a schema, and the schema is the protocol's own
// babelResultSchema rather than a format of Code's choosing: Babel compares
// what it receives against that exact string and refuses the result on any
// other value, so a worker-specific schema is not a variant Babel tolerates —
// it is a run discarded after all the work was done.
func ompResultOf(status string, findings ompFindings, resources *babelResources) (babelResult, error) {
	payload, err := json.Marshal(findings)
	if err != nil {
		return babelResult{}, err
	}
	return babelResult{
		Type:      babelMessageResult,
		Status:    status,
		Schema:    babelResultSchema,
		Payload:   payload,
		Resources: resources,
	}, nil
}

// ── the conformance paths ────────────────────────────────────────────────────

// ompSlowBudget bounds the conformance "slow" directive. The obligation is to
// keep working long enough to be cancelled; a run nobody cancels must still
// end, so it ends with a partial result rather than hanging until Babel's idle
// timeout fires.
const ompSlowBudget = 60 * time.Second

// ompConformanceQuery is the evidence request the conformance directives make.
// It is a fixed, meaningless locator: the obligation is about the decision
// round trip, and a plausible-looking selector would suggest the suite reads
// something.
const ompConformanceQuery = `{"query":"babel conformance probe","limit":1}`

// conform reaches one of Babel's observable states without a model, a network
// or a profile.
func (o *ompInvestigator) conform(ctx context.Context, job babelJob,
	emit func(stage, message string, fraction float64),
	request func(capability, tool, reason string, arguments json.RawMessage) babelDecision,
) (babelResult, error) {
	directive := job.conformanceDirective()
	findings := ompFindingsOf(job)
	findings.Directive = directive
	emit(ompStageResolve, "conformance directive "+directive, ompFraction(0))

	switch directive {
	case babelConformanceErrorOnly:
		emit(ompStageAnalyse, "this directive asks the run to fail instead of finishing", ompFraction(1))
		// No result may follow an error, so this returns without building one.
		return babelResult{}, fmt.Errorf("conformance directive %s: the run reports a failure", directive)

	case babelConformanceSlow:
		return o.conformSlow(ctx, emit, findings)

	case babelConformanceRequestTool:
		return o.conformRequest(ctx, job, emit, request, findings,
			babelCapabilityCorpusSearch, "babel_corpus_search")

	case babelConformanceRequestUngranted:
		// sandbox-exec is outside the conformance grant on purpose: asking for
		// a capability Code was not granted has to be survivable, and the
		// grant — not the policy — is what must refuse it.
		return o.conformRequest(ctx, job, emit, request, findings,
			babelCapabilitySandboxExec, "babel_sandbox_exec")

	case babelConformanceEchoToken:
		return o.conformEchoToken(job, emit, findings)
	}

	emit(ompStageAnalyse, "a well-behaved run with nothing to investigate", ompFraction(1))
	emit(ompStageReport, "delivering the result", ompFraction(2))
	findings.Analysis = "The conformance directive " + directive +
		" asks for a minimal successful run, so this result carries no analysis of its own."
	return ompResultOf(babelStatusOK, findings, nil)
}

// conformSlow emits progress and then keeps working until it is cancelled. The
// first event goes out before the first wait, so a Babel that cancels on its
// first progress record does not have to wait a tick for one.
func (o *ompInvestigator) conformSlow(ctx context.Context, emit func(stage, message string, fraction float64),
	findings ompFindings,
) (babelResult, error) {
	pace := o.pace
	if pace <= 0 {
		pace = time.Second
	}
	ticker := time.NewTicker(pace)
	defer ticker.Stop()
	budget := o.slowBudget
	if budget <= 0 {
		budget = ompSlowBudget
	}
	deadline := time.Now().Add(budget)

	for step := 1; ; step++ {
		emit(ompStageAnalyse, "still working; step "+strconv.Itoa(step), ompFraction(step))
		select {
		case <-ctx.Done():
			return babelResult{}, ctx.Err()
		case <-ticker.C:
		}
		if !time.Now().Before(deadline) {
			break
		}
	}
	findings.Analysis = "The run exhausted its own budget without being cancelled, so it stopped short."
	findings.Gaps = append(findings.Gaps, "the run was not cancelled and gave up on its own schedule")
	return ompResultOf(babelStatusPartial, findings, nil)
}

// conformRequest makes exactly one evidence request, records the decision it
// received, and delivers a result either way. Recording Babel's own decision
// word is the point: the obligation is that the worker adapts to the answer it
// was given, and a payload that reported the worker's summary instead would not
// show that it heard it.
func (o *ompInvestigator) conformRequest(ctx context.Context, job babelJob,
	emit func(stage, message string, fraction float64),
	request func(capability, tool, reason string, arguments json.RawMessage) babelDecision,
	findings ompFindings, capability, tool string,
) (babelResult, error) {
	emit(ompStageEvidence, "asking Babel for "+capability+" evidence", ompFraction(1))
	reason := "the analysis needs " + capability + " evidence"
	for _, known := range ompEvidenceTools {
		if known.capability == capability {
			reason = known.reason
			break
		}
	}
	decision := request(capability, tool, reason, json.RawMessage(ompConformanceQuery))
	entry := ompEvidenceLog{
		Capability: capability,
		Tool:       tool,
		Decision:   decision.Decision,
		Code:       decision.Code,
		Reason:     decision.Reason,
	}
	status := babelStatusPartial
	switch {
	case !decision.allowed():
		entry.Note = "Babel refused the evidence; the run continued without it"
		findings.Gaps = append(findings.Gaps, capability+" evidence was refused")
		emit(ompStageAnalyse, "the evidence was refused; continuing without it", ompFraction(2))
	default:
		served, err := o.serveEvidence(ctx, job, capability, tool, json.RawMessage(ompConformanceQuery))
		if err != nil {
			entry.Note = "the evidence was allowed but the broker did not answer: " + err.Error()
			findings.Gaps = append(findings.Gaps, capability+" evidence was allowed but unavailable")
			emit(ompStageAnalyse, "the broker did not answer; continuing without the evidence", ompFraction(2))
		} else {
			entry.Served = true
			entry.Note = "the broker served " + strconv.Itoa(len(served)) + " bytes"
			status = babelStatusOK
			emit(ompStageAnalyse, "the evidence was served", ompFraction(2))
		}
	}
	findings.Evidence = append(findings.Evidence, entry)
	findings.Analysis = "The conformance directive " + findings.Directive +
		" exercised one " + capability + " request, which Babel decided: " + decision.Decision + "."
	emit(ompStageReport, "delivering the result", ompFraction(3))
	return ompResultOf(status, findings, nil)
}

// conformEchoToken puts the run's broker credential exactly where a leak would
// put it. The directive asks for misbehaviour because Babel's obligation — that
// a run-scoped credential never survives into a durable receipt — cannot be
// graded against a worker that behaves: a search for a token nothing ever wrote
// cannot fail, so it would pass without testing anything. So the token goes
// into the analysis text and into a progress message, verbatim, which are the
// two places a real leak happens: free text a model wrote, and a stage
// description built by concatenation.
//
// The protocol layer above this seam scrubs every job secret out of every byte
// the process writes, so in Code it is the redaction that reaches the wire.
// That is the intended outcome rather than a defeat of the directive: Code's
// own defence stops the leak here, Babel's redaction stops it for a worker that
// has none, and the directive is how either side gets to find out.
//
// The status is ok because the run did what it was asked and cut nothing short.
// A gap would say evidence was missing, which would be a second lie on top of
// the one the directive requested.
func (o *ompInvestigator) conformEchoToken(job babelJob,
	emit func(stage, message string, fraction float64), findings ompFindings,
) (babelResult, error) {
	token := job.brokerToken()
	emit(ompStageAnalyse, "echoing the run credential on purpose: "+token, ompFraction(1))
	findings.Analysis = "The conformance directive " + babelConformanceEchoToken +
		" asks this run to disclose its own broker credential, so it is reproduced here " +
		"verbatim: " + token
	emit(ompStageReport, "delivering the result", ompFraction(2))
	return ompResultOf(babelStatusOK, findings, nil)
}

// serveEvidence performs one allowed request against Babel's broker. A job with
// no broker is not an error in the run: it means there is nothing to fetch, and
// the caller reports the gap.
func (o *ompInvestigator) serveEvidence(ctx context.Context, job babelJob,
	capability, tool string, arguments json.RawMessage,
) (string, error) {
	if job.Broker == nil {
		return "", errors.New("the job named no evidence broker")
	}
	fetch := o.evidence
	if fetch == nil {
		fetch = fetchBrokeredEvidence
	}
	return fetch(ctx, *job.Broker, ompEvidenceRequest{
		RunID:      job.RunID,
		JobID:      job.JobID,
		Capability: capability,
		Tool:       tool,
		Arguments:  arguments,
	})
}

// ── the real run ─────────────────────────────────────────────────────────────

// drive resolves the profile, launches OMP with the run's tools and nothing
// else, and turns the session into progress, brokered evidence and a result.
func (o *ompInvestigator) drive(ctx context.Context, job babelJob,
	emit func(stage, message string, fraction float64),
	request func(capability, tool, reason string, arguments json.RawMessage) babelDecision,
) (babelResult, error) {
	emit(ompStageResolve, "opening "+ompProfileName(job.Profile), ompFraction(0))
	profile, err := o.openProfile(job.Profile)
	if err != nil {
		return babelResult{}, err
	}

	binary, err := o.lookOmp()
	if err != nil {
		return babelResult{}, fmt.Errorf("no omp to drive: %w", err)
	}
	dir, err := ompNewRunDir(profile.ConfigYAML)
	if err != nil {
		return babelResult{}, fmt.Errorf("the run directory could not be created: %w", err)
	}
	defer dir.remove()

	tools := ompToolsFor(job.Grant)
	emit(ompStageLaunch, "launching omp with "+strconv.Itoa(len(tools))+" brokered tools and no built-ins", ompFraction(1))

	session, err := ompStartSession(ctx, ompLaunch{
		binary: binary,
		config: dir.config,
		home:   dir.home,
		work:   dir.work,
		env:    ompChildEnv(o.environ(), dir.home, job),
	})
	if err != nil {
		return babelResult{}, err
	}

	run := &ompRun{
		ctx:      ctx,
		session:  session,
		job:      job,
		emit:     emit,
		request:  request,
		serve:    o.serveEvidence,
		tools:    make(map[string]ompEvidenceTool, len(tools)),
		findings: ompFindingsOf(job),
		step:     2,
	}
	for _, tool := range tools {
		run.tools[tool.name] = tool
	}

	runErr := run.play(tools, profile)
	resources := session.stop()
	if resources != nil {
		resources.SandboxBytesWritten = dir.bytesWritten()
		resources.ToolCalls = run.calls
	}
	if runErr != nil {
		if ctx.Err() != nil {
			return babelResult{}, ctx.Err()
		}
		if diagnostics := session.diagnostics(); diagnostics != "" {
			return babelResult{}, fmt.Errorf("%w: omp said: %s", runErr, diagnostics)
		}
		return babelResult{}, runErr
	}

	emit(ompStageReport, "delivering the result", 0.95)
	run.findings.Analysis = run.analysis()
	return ompResultOf(run.status(), run.findings, resources)
}

// ── the session driver ───────────────────────────────────────────────────────

// ompRun is one OMP session being driven to a terminal event. It holds the
// accumulating analysis text and the evidence log, because both are built from
// the same frame stream.
type ompRun struct {
	ctx      context.Context
	session  *ompSession
	job      babelJob
	emit     func(stage, message string, fraction float64)
	request  func(capability, tool, reason string, arguments json.RawMessage) babelDecision
	serve    func(ctx context.Context, job babelJob, capability, tool string, arguments json.RawMessage) (string, error)
	tools    map[string]ompEvidenceTool
	findings ompFindings

	text  strings.Builder
	calls int
	turns int
	step  int
	done  bool
}

// play runs the whole session: ready, register, prompt, then frames until a
// terminal agent_end.
func (r *ompRun) play(tools []ompEvidenceTool, profile resolvedProfile) error {
	ready, err := r.session.next()
	if err != nil {
		return fmt.Errorf("omp never announced itself: %w", err)
	}
	if ready.Type != ompFrameReady {
		return fmt.Errorf("omp opened with %q instead of a ready frame", ready.Type)
	}

	if len(tools) > 0 {
		if err := r.session.send(ompSetHostToolsCommand{
			ID:    "tools-1",
			Type:  ompCommandSetHostTools,
			Tools: ompHostToolWires(tools),
		}); err != nil {
			return fmt.Errorf("the brokered tools could not be registered: %w", err)
		}
		response, err := r.awaitResponse("tools-1")
		if err != nil {
			return err
		}
		if !response.succeeded() {
			return fmt.Errorf("omp refused the brokered tools: %s", response.Error)
		}
	}

	if err := r.session.send(ompPromptCommand{
		ID:      "prompt-1",
		Type:    ompCommandPrompt,
		Message: ompBrief(r.job, tools, profile),
	}); err != nil {
		return fmt.Errorf("the investigation brief could not be sent: %w", err)
	}
	response, err := r.awaitResponse("prompt-1")
	if err != nil {
		return err
	}
	if !response.succeeded() {
		return fmt.Errorf("omp refused the investigation brief: %s", response.Error)
	}

	for !r.done {
		frame, err := r.session.next()
		if err != nil {
			if errors.Is(err, io.EOF) && r.text.Len() > 0 {
				// OMP closed after producing output. The run stopped short of
				// its own terminal event, which is what a partial result is
				// for, so this is not a failure.
				return nil
			}
			return err
		}
		if err := r.handle(frame); err != nil {
			return err
		}
	}
	return nil
}

// awaitResponse waits for one command response, handling every frame that
// arrives in the meantime. Ordering across concurrent commands is not
// guaranteed by OMP, so correlation is by id and nothing else.
func (r *ompRun) awaitResponse(id string) (*ompFrame, error) {
	for {
		frame, err := r.session.next()
		if err != nil {
			return nil, fmt.Errorf("omp never answered %s: %w", id, err)
		}
		if frame.Type == ompFrameResponse && frame.ID == id {
			return frame, nil
		}
		if err := r.handle(frame); err != nil {
			return nil, err
		}
	}
}

// handle turns one frame into progress, evidence or the end of the run.
// Anything unrecognized is ignored: OMP's event set grows between releases, and
// an unknown event is not a protocol violation.
func (r *ompRun) handle(frame *ompFrame) error {
	switch frame.Type {
	case ompFrameAgentStart:
		r.progress(ompStageAnalyse, "the model began work")
	case ompFrameTurnStart:
		r.turns++
		r.progress(ompStageAnalyse, "turn "+strconv.Itoa(r.turns))
	case ompFrameTurnEnd:
		r.progress(ompStageAnalyse, "turn "+strconv.Itoa(r.turns)+" finished")
	case ompFrameMessageUpdate:
		if frame.Assistant != nil && frame.Assistant.Type == ompTextDelta {
			r.text.WriteString(frame.Assistant.Delta)
		}
	case ompFrameToolStart:
		r.progress(ompStageEvidence, "a tool call started")
	case ompFrameToolEnd:
		r.progress(ompStageEvidence, "a tool call finished")
	case ompFrameHostToolCall:
		return r.serveHostTool(frame)
	case ompFrameHostToolCancel:
		// Host tool calls are answered synchronously, so by the time a cancel
		// could arrive the result is already on its way. Nothing to undo.
	case ompFrameAgentEnd:
		if frame.terminal() {
			r.done = true
		}
	}
	return nil
}

func (r *ompRun) progress(stage, message string) {
	r.emit(stage, message, ompFraction(r.step))
	r.step++
}

// serveHostTool is the whole brokered-evidence path: one tool call from the
// model becomes one request to Babel, and Babel's answer becomes either the
// evidence or a tool error the model is expected to work around.
func (r *ompRun) serveHostTool(frame *ompFrame) error {
	tool, known := r.tools[frame.ToolName]
	if !known {
		// Nothing registered this tool, so no capability backs it. Refusing
		// locally is not a shortcut past Babel: an unregistered name is
		// outside every grant by construction, and sending it to Babel would
		// spend a decision on a question with one answer.
		return r.reject(frame.ID, "The tool "+frame.ToolName+" is not part of this run. "+
			"Use only the tools you were given, and state any gap that leaves in your findings.")
	}
	r.calls++
	r.progress(ompStageEvidence, "asking Babel for "+tool.capability+" evidence")

	decision := r.request(tool.capability, tool.name, tool.reason, frame.Arguments)
	entry := ompEvidenceLog{
		Capability: tool.capability,
		Tool:       tool.name,
		Decision:   decision.Decision,
		Code:       decision.Code,
		Reason:     decision.Reason,
	}
	if !decision.allowed() {
		entry.Note = "Babel refused the evidence; the run continued without it"
		r.findings.Evidence = append(r.findings.Evidence, entry)
		r.findings.Gaps = append(r.findings.Gaps, tool.capability+" evidence was refused")
		r.progress(ompStageAnalyse, tool.capability+" evidence was refused; continuing without it")
		return r.reject(frame.ID, ompDenialText(tool, decision))
	}

	served, err := r.serve(r.ctx, r.job, tool.capability, tool.name, frame.Arguments)
	if err != nil {
		entry.Note = "the evidence was allowed but the broker did not answer: " + err.Error()
		r.findings.Evidence = append(r.findings.Evidence, entry)
		r.findings.Gaps = append(r.findings.Gaps, tool.capability+" evidence was allowed but unavailable")
		r.progress(ompStageAnalyse, "the broker did not answer; continuing without the evidence")
		return r.reject(frame.ID, "Babel allowed this request, but its evidence broker did not answer: "+
			err.Error()+". Do not retry; continue without this evidence and state the gap in your findings.")
	}
	entry.Served = true
	r.findings.Evidence = append(r.findings.Evidence, entry)
	r.progress(ompStageEvidence, tool.capability+" evidence served")
	return r.session.send(ompHostToolResult{
		Type:   ompFrameHostToolResult,
		ID:     frame.ID,
		Result: ompToolText(served),
	})
}

// reject answers a host tool call with a tool error. isError is what makes a
// refusal survivable: OMP surfaces the text to the model as a failed tool call,
// so the model reads why, adapts, and keeps working — which is exactly Babel's
// requirement that a denial not end the run.
func (r *ompRun) reject(id, text string) error {
	return r.session.send(ompHostToolResult{
		Type:    ompFrameHostToolResult,
		ID:      id,
		IsError: true,
		Result:  ompToolText(text),
	})
}

// ompDenialText tells the model what happened in terms it can act on. It names
// the refusal, forbids the retry, and asks for the gap to be stated, because a
// finding built on evidence that was refused has to say so.
func ompDenialText(tool ompEvidenceTool, decision babelDecision) string {
	var b strings.Builder
	b.WriteString("Babel refused this evidence request.")
	if decision.Code != "" {
		b.WriteString(" Code: ")
		b.WriteString(decision.Code)
		b.WriteString(".")
	}
	if decision.Reason != "" {
		b.WriteString(" Reason: ")
		b.WriteString(decision.Reason)
		b.WriteString(".")
	}
	b.WriteString(" The ")
	b.WriteString(tool.capability)
	b.WriteString(" evidence is unavailable for this run, so do not call ")
	b.WriteString(tool.name)
	b.WriteString(" again. Continue the analysis without it and state the gap explicitly in your findings.")
	return b.String()
}

// analysis is the model's output: the accumulated text deltas, trimmed.
func (r *ompRun) analysis() string { return strings.TrimSpace(r.text.String()) }

// status is ok only for a run that reached its own terminal event, produced
// output, and left no gap. A refused or unavailable piece of evidence means the
// run stopped short of the job's scope, which is what partial reports.
func (r *ompRun) status() string {
	if r.done && r.analysis() != "" && len(r.findings.Gaps) == 0 {
		return babelStatusOK
	}
	return babelStatusPartial
}

// ── the brief ────────────────────────────────────────────────────────────────

// ompBrief is the prompt the model works from. It carries the run's identity,
// its approved sources, the recipes to apply and the evidence routes available,
// and it carries no credential: the broker's endpoint and token stay in this
// process.
func ompBrief(job babelJob, tools []ompEvidenceTool, profile resolvedProfile) string {
	var b strings.Builder
	b.WriteString("You are running as Babel's analysis worker for run ")
	b.WriteString(job.RunID)
	b.WriteString(" under profile ")
	b.WriteString(profile.Ref.ID)
	b.WriteString(".\n\n")

	if len(job.Recipes) > 0 {
		b.WriteString("Apply these cookbook recipes, at these versions:\n")
		for _, recipe := range job.Recipes {
			b.WriteString("  - ")
			b.WriteString(recipe.ID)
			b.WriteString(" v")
			b.WriteString(strconv.Itoa(recipe.Version))
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}

	if len(job.Sources) > 0 {
		b.WriteString("These are the only approved inputs for this run:\n")
		for _, source := range job.Sources {
			b.WriteString("  - ")
			b.WriteString(source.Kind)
			b.WriteString(" ")
			b.WriteString(source.Selector)
			if source.Digest != "" {
				b.WriteString(" (")
				b.WriteString(source.Digest)
				b.WriteString(")")
			}
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}

	b.WriteString("You have no filesystem, shell or network tools. ")
	if len(tools) == 0 {
		b.WriteString("This run granted no evidence tools at all, so work from the brief alone " +
			"and say plainly what you could not check.\n\n")
	} else {
		b.WriteString("Every piece of evidence comes through these tools, and every call is " +
			"authorized by Babel before it runs:\n")
		for _, tool := range tools {
			b.WriteString("  - ")
			b.WriteString(tool.name)
			b.WriteString(": ")
			b.WriteString(tool.description)
			b.WriteString("\n")
		}
		b.WriteString("\nA refusal is normal and is not a failure. When a call is refused, do not retry " +
			"it: carry on without that evidence and state the gap it leaves.\n\n")
	}

	b.WriteString("Disclosure class for this run: ")
	b.WriteString(job.Grant.Disclosure)
	b.WriteString(". Do not restate material outside it.\n\n")
	b.WriteString("Write your findings as your final message: what you established, what evidence " +
		"supports each point, and what you could not establish and why. Be specific and do not pad.")
	return b.String()
}
