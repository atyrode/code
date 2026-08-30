package main

// Babel's analysis-worker protocol, Code's side.
//
// Babel (github.com/atyrode/babel) supervises Code as its analysis worker:
// Babel owns the corpus, the capability grant and the durable record, and Code
// owns the profile, the provider credential and the OMP controller. Neither
// program trusts the other's good behaviour, so this file mirrors Babel's wire
// format exactly and nothing else in Code encodes it.
//
// Transport is newline-delimited JSON: one message per line, worker to Babel on
// stdout, Babel to worker on stdin. stderr is diagnostics only and is never
// parsed. Two rules make the boundary real rather than nominal:
//
//   - The job arrives on stdin and nowhere else, because it carries the
//     run-scoped broker credential. It must never reach argv or a child's
//     environment, where a process listing would expose it.
//   - Unknown fields are ignored inside a known version, in both directions.
//     A newer Babel adding a field must not break this build.
//
// The authoritative definition is Babel's internal/worker package doc plus its
// Conformance suite, which drives this binary through every obligation. When
// the two disagree, Babel is right and this file is wrong.

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// The protocol this file speaks. A counterpart declaring a different name is a
// different program, not an older version of this one.
const (
	babelProtocolName    = "babel.analysis-worker"
	babelProtocolVersion = 1

	// babelResultSchema is the schema every terminal result must declare.
	// Babel fails closed on anything else: its explore package compares the
	// stored record's schema against this exact string and rejects the result
	// rather than recording an analysis it cannot read, so a worker that names
	// its own format produces runs that are all discarded at the far end.
	//
	// It lives here, beside the protocol's name and version, because it is wire
	// surface rather than a property of any one payload — and it must not be
	// duplicated. Defining it next to its first user is exactly how this build
	// came to carry two schemas: the conformance stub declared Babel's and
	// passed, while the real investigator declared its own and would have had
	// every production result refused.
	babelResultSchema = "babel.analysis-result/1"
)

// Message types on the wire. Code writes hello, configuration, progress,
// tool-request, result and error; Babel writes accept, refuse, job and
// tool-decision.
const (
	babelMessageHello         = "hello"
	babelMessageAccept        = "accept"
	babelMessageRefuse        = "refuse"
	babelMessageJob           = "job"
	babelMessageToolDecision  = "tool-decision"
	babelMessageConfiguration = "configuration"
	babelMessageProgress      = "progress"
	babelMessageToolRequest   = "tool-request"
	babelMessageResult        = "result"
	babelMessageError         = "error"
)

// Modes Babel can accept this worker into. Configure opens Code's own dials,
// saves the result under Code's ownership and exits without launching OMP.
// Worker runs one analysis job.
const (
	babelModeConfigure = "configure"
	babelModeWorker    = "worker"
)

// Terminal result statuses. Partial reports work that stopped short of the
// job's scope but produced usable output — a finite run deferring its
// remainder, not a failure.
const (
	babelStatusOK      = "ok"
	babelStatusPartial = "partial"
)

// Disclosure classes. The class is fixed before material is sent, so it
// travels in the job rather than being negotiated.
const (
	babelDisclosureLocal  = "local"
	babelDisclosureHosted = "hosted"
)

// Capabilities Babel defines. A request outside the run's grant is denied
// before any policy is consulted, so asking for one Code was not granted is
// normal and survivable rather than fatal.
const (
	babelCapabilityCorpusSearch   = "corpus-search"
	babelCapabilitySandboxExec    = "sandbox-exec"
	babelCapabilityRepoRead       = "repo-read"
	babelCapabilityPublicResearch = "public-research"
)

// babelParamConformance is the job parameter through which Babel's conformance
// suite tells this worker which obligation is being exercised. It is part of
// the contract rather than a testing hook: that a denial does not end a run,
// that no result follows an error, and that cancellation is prompt cannot be
// observed unless the worker can be asked to reach those states. A production
// job never sets it, and an unrecognized value means well-behaved.
const babelParamConformance = "babel.conformance"

// Conformance directives, each a state Babel needs to observe.
//
// babelConformanceEchoJob asks for the one thing about a run Babel cannot see
// for itself: what this worker made of the job it was handed. A receipt records
// the recipes and sources Babel sent, never the ones the worker read, so a
// worker that ignored both arrays produces a receipt indistinguishable from one
// that honoured them — which means the reading can only be graded by asking for
// it. A worker receiving this directive runs an otherwise ordinary well-behaved
// analysis and reports, under the "job" key of the terminal result's payload,
// the recipes as "ID@VERSION" and the sources as "KIND|SELECTOR|DIGEST|SNAPSHOT":
// one entry per element, in the job's own order, an absent digest or snapshot
// rendered as the empty string between its separators. Babel plants a per-run
// nonce in that material, so the answer has to be built from the job that
// arrived and cannot be a constant transcribed out of this file.
//
// Nothing else is asked for. The job's identifiers, profile and grant are each
// already held to something else — Babel correlates the run, refuses a resolved
// profile that does not match the one it named, and denies a request outside
// the grant — so echoing them would be a second contract over material that
// already has one.
//
// babelConformanceEchoToken is the one directive that asks this worker to
// misbehave, and it has to. Babel's obligation is that a run-scoped credential
// never survives into a durable receipt, and that obligation cannot be graded
// against a worker that behaves: searching a receipt built from a well-behaved
// run for a token nothing ever wrote cannot fail, so it proves nothing. So the
// suite asks for the leak and grades what Babel does with it. A worker
// receiving it puts the job's broker token verbatim into the terminal result's
// payload and into at least one progress message, which are the two places a
// real leak happens — free text a model wrote and a stage description built by
// concatenation.
//
// babelConformanceEchoEvidence is the directive that grades the one thing a
// decision's own fields cannot show: whether the worker read the evidence
// Babel served with it. An allowed decision used to carry nothing but a
// sentence, so a worker could report "allow" and hand the model no corpus
// material at all, and the receipt would read the same as a worker that served
// every hit. It is the same blind spot echo-job closes for the job document,
// and it is closed the same way: by asking.
//
// A worker receiving it makes one ordinary corpus-search request, blocks for
// the decision, and reports the hits it decoded off that decision under the
// "served_evidence" key of the terminal result's payload — one entry per hit,
// in served order, each flattened to
// "HARNESS|SOURCE_ID|INDEX|PATH|LINE|BYTE_OFFSET|DIGEST|EXCERPT". The key is
// its own rather than the payload's existing "evidence" array, which is the
// request log a reviewer reads and is not this.
//
// The flat rendering is the evidence of the decode, exactly as it is for
// echo-job: a worker that produces those eight fields has walked into the
// locator object and out to the excerpt, and Babel plants a per-run nonce in
// five of them, so the answer cannot be a constant written here. The array is
// emitted even when it is empty, because "implemented and served nothing" and
// "never implemented" are two different failures and Babel grades them apart.
const (
	babelConformanceWellBehaved      = "well-behaved"
	babelConformanceEchoJob          = "echo-job"
	babelConformanceRequestTool      = "request-tool"
	babelConformanceRequestUngranted = "request-ungranted"
	babelConformanceErrorOnly        = "error-only"
	babelConformanceSlow             = "slow"
	babelConformanceEchoToken        = "echo-token"
	babelConformanceEchoEvidence     = "echo-evidence"
)

// babelHello is the worker's opening line. It is written before reading
// anything, so Babel can refuse an incompatible counterpart before any job
// material — and therefore any credential — is written to this process.
type babelHello struct {
	Type     string        `json:"type"`
	Protocol string        `json:"protocol"`
	Versions []int         `json:"versions"`
	Modes    []string      `json:"modes"`
	Worker   babelIdentity `json:"worker"`
}

// babelIdentity is Code's non-secret self-description. Babel records it so a
// run can be attributed to a build.
type babelIdentity struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// babelAccept names the negotiated version, the mode, and the budgets this
// worker must respect. A line longer than MaxLineBytes is a protocol violation
// rather than a large message, so emitters must bound what they write.
type babelAccept struct {
	Type     string      `json:"type"`
	Protocol string      `json:"protocol"`
	Version  int         `json:"version"`
	Mode     string      `json:"mode"`
	Limits   babelLimits `json:"limits"`
}

type babelLimits struct {
	MaxLineBytes    int     `json:"max_line_bytes"`
	MaxEvents       int     `json:"max_events"`
	MaxToolRequests int     `json:"max_tool_requests"`
	IdleSeconds     float64 `json:"idle_seconds"`
	ExitGraceSecs   float64 `json:"exit_grace_seconds"`
}

// babelRefuse tells a rejected worker why. A refused worker emits nothing
// further and exits, rather than waiting for a job that will never arrive.
type babelRefuse struct {
	Type      string `json:"type"`
	Protocol  string `json:"protocol"`
	Reason    string `json:"reason"`
	Supported []int  `json:"supported"`
}

// babelProfileRef identifies one saved Code profile. Babel persists this
// reference and the non-secret metadata beside it, never the provider
// configuration behind it.
type babelProfileRef struct {
	ID       string `json:"id"`
	Revision int    `json:"revision"`
}

// babelRecipeRef identifies one cookbook asset at a version.
type babelRecipeRef struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
}

// babelSource is one approved input the run may read.
type babelSource struct {
	Kind     string `json:"kind"`
	Selector string `json:"selector"`
	Digest   string `json:"digest,omitempty"`
	Snapshot string `json:"snapshot,omitempty"`
}

// babelGrant is the run's capability boundary, fixed before work starts.
//
// Tools is Babel's published capability-to-tool-name mapping: for each granted
// capability, the tool names Babel will actually serve under it. It exists
// because a capability names a facility while a tool names one operation
// inside it, and Babel denies an operation it does not recognize. Code used to
// choose that name itself, which is how a whole exploration came to make three
// evidence requests and have all three refused for naming a tool Babel never
// served. The name is now Babel's to state and Code's to obey.
//
// Absence is meaningful at both levels and the two absences are different
// facts. A nil map means this Babel published no mapping at all — an older
// build that predates the field — and says nothing about any capability. A
// present map with no entry for a granted capability, or an entry holding no
// names, is this Babel stating that nothing it brokers serves that capability.
// Code treats the first as unanswered and the second as answered "nothing",
// and records which one it acted on.
type babelGrant struct {
	Capabilities []string            `json:"capabilities"`
	Disclosure   string              `json:"disclosure"`
	Tools        map[string][]string `json:"tools,omitempty"`
	Expires      *time.Time          `json:"expires,omitempty"`
}

// allows reports whether c is inside the grant. Code checks this to avoid
// pointless requests; Babel checks it as the boundary.
func (g babelGrant) allows(c string) bool {
	for _, have := range g.Capabilities {
		if have == c {
			return true
		}
	}
	return false
}

// publishesTools reports whether this grant carries a tool-name mapping at all.
// It is the difference between a Babel that stated nothing serves a capability
// and a Babel too old to have been asked.
func (g babelGrant) publishesTools() bool { return g.Tools != nil }

// toolNames is the tool names Babel published for capability c, in the order
// Babel gave them. An empty result means either that this grant publishes no
// mapping or that the mapping names nothing for c; publishesTools tells the two
// apart, and every caller here needs both answers.
func (g babelGrant) toolNames(c string) []string { return g.Tools[c] }

// babelBroker locates Babel's capability-gated evidence API for this run.
// Token is the one secret the job carries. It must never be logged, never
// reach argv or a child environment, and never appear in an event.
type babelBroker struct {
	Endpoint string `json:"endpoint"`
	Token    string `json:"token"`
}

// babelJob is one analysis job. Extra preserves top-level fields this build
// does not know so a newer Babel can add them without breaking this one.
type babelJob struct {
	Type     string            `json:"type"`
	Protocol string            `json:"protocol"`
	JobID    string            `json:"job_id"`
	RunID    string            `json:"run_id"`
	Profile  babelProfileRef   `json:"profile"`
	Recipes  []babelRecipeRef  `json:"recipes,omitempty"`
	Grant    babelGrant        `json:"grant"`
	Sources  []babelSource     `json:"sources,omitempty"`
	Broker   *babelBroker      `json:"broker,omitempty"`
	Params   map[string]string `json:"params,omitempty"`

	Extra map[string]json.RawMessage `json:"-"`
}

// conformanceDirective reports which obligation this job exercises. An
// unrecognized value is well-behaved by contract, so a newer suite cannot make
// an older worker fail by naming a directive it has never heard of.
//
// The list below is load-bearing rather than documentation: a directive missing
// from it reads as well-behaved, so the worker answers a question it was never
// asked and looks like it simply does not implement the obligation. Adding a
// directive means adding it here as well as handling it.
func (j babelJob) conformanceDirective() string {
	switch d := j.Params[babelParamConformance]; d {
	case babelConformanceEchoJob, babelConformanceRequestTool, babelConformanceRequestUngranted,
		babelConformanceErrorOnly, babelConformanceSlow, babelConformanceEchoToken,
		babelConformanceEchoEvidence:
		return d
	default:
		return babelConformanceWellBehaved
	}
}

// conformanceRequested reports whether this job is one of Babel's conformance
// obligations rather than a real analysis run.
//
// It is deliberately separate from conformanceDirective, which cannot answer
// this: that method defaults an absent key to well-behaved, so it reads the
// same for a production job and for the suite's well-behaved obligation. The
// distinction matters in exactly one place. The suite's job names a profile no
// local store will ever hold, so a conformance run must proceed without
// resolving one, while a production job naming a profile Code cannot find must
// fail with babelErrProfileUnavailable. A worker that echoed the job's profile
// reference in both cases would be claiming a profile it does not have, and
// Babel would record that claim in a receipt a reviewer trusts.
func (j babelJob) conformanceRequested() bool {
	_, requested := j.Params[babelParamConformance]
	return requested
}

// secrets lists the values that must not appear in any event, diagnostic or
// child environment for this job.
func (j babelJob) secrets() []string {
	if j.Broker == nil || j.Broker.Token == "" {
		return nil
	}
	return []string{j.Broker.Token}
}

// brokered reports whether this job named an evidence API to fetch from. It is
// the second of the two routes an allowed request can take, and it is asked
// before the fetch rather than discovered from its failure: "this run has no
// broker" and "the broker did not answer" are different things to tell a model
// and different things to leave in a receipt.
func (j babelJob) brokered() bool {
	return j.Broker != nil && strings.TrimSpace(j.Broker.Endpoint) != ""
}

// brokerToken is the run's broker credential, or empty when the job carries
// none. It exists for the echo-token conformance directive and nothing else:
// every other handling of the token goes through secrets(), which is the list
// of values that must never be written, or through the broker request itself.
// Naming the one deliberate read keeps it findable, so a reviewer auditing what
// touches the credential does not have to trust that a Broker.Token dereference
// somewhere was the intended one.
func (j babelJob) brokerToken() string {
	if j.Broker == nil {
		return ""
	}
	return j.Broker.Token
}

// babelJobEcho is the answer the echo-job directive asks for: the recipes and
// sources this worker decoded, each flattened to one string.
//
// The flat shape is Babel's rather than a choice made here — it compares these
// strings against the job it sent — and it is flat for a reason. A worker that
// renders "ID@VERSION" has read both halves of a recipe reference, and one that
// renders "KIND|SELECTOR|DIGEST|SNAPSHOT" has read all four parts of a source,
// so producing the string is itself the evidence of the decode instead of a
// claim about it.
type babelJobEcho struct {
	Recipes []string `json:"recipes"`
	Sources []string `json:"sources"`
}

// decodedEcho renders this job's recipes and sources for the echo-job
// directive.
//
// It reads the typed job, which in this build is the decode: readJob
// unmarshals the wire line straight into babelJob, and the generic map it
// builds beside that exists only to spot top-level fields this build does not
// define, is reduced to those fields in Extra, and is then dropped. There is no
// second copy of the job to prefer, so every string below came from the bytes
// Babel wrote — which is the only reason the answer is worth anything.
//
// The slices are allocated rather than left nil so a job carrying no recipes or
// no sources answers with an empty array. Babel reads either as zero entries,
// but a null in the record says the worker had nothing to say where an empty
// array says it decoded nothing.
func (j babelJob) decodedEcho() babelJobEcho {
	echo := babelJobEcho{
		Recipes: make([]string, 0, len(j.Recipes)),
		Sources: make([]string, 0, len(j.Sources)),
	}
	for _, recipe := range j.Recipes {
		echo.Recipes = append(echo.Recipes, recipe.ID+"@"+strconv.Itoa(recipe.Version))
	}
	for _, source := range j.Sources {
		echo.Sources = append(echo.Sources,
			strings.Join([]string{source.Kind, source.Selector, source.Digest, source.Snapshot}, "|"))
	}
	return echo
}

// babelDecision is Babel's answer to one tool-request. A denial is not a
// termination: the worker adapts and still delivers a terminal event.
type babelDecision struct {
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
	Decision  string `json:"decision"`
	Code      string `json:"code,omitempty"`
	Reason    string `json:"reason,omitempty"`

	// Results is the evidence Babel served with an allowed decision, as Babel
	// wrote it. It is held as raw JSON and forwarded to the model unchanged,
	// which is not laziness: Babel is the authority on what was served, it has
	// already redacted and bounded every excerpt, and any field this build
	// does not model still reaches the model instead of being dropped by a
	// re-encode. Code decodes it only to count what arrived and to answer the
	// echo-evidence directive.
	//
	// Absence is a fact of its own and is never an empty result set. No
	// payload means this decision served no evidence at all — an older Babel,
	// a denial, or a capability whose facility is not the corpus index —
	// whereas a payload carrying an empty hits array means Babel searched and
	// the corpus matched nothing. Conflating the two would let a run report
	// the archive as silent on a question nobody ever put to it, so the
	// omitempty here and the pointer in babelServed exist for the same reason.
	Results json.RawMessage `json:"results,omitempty"`
}

const (
	babelDecisionAllow = "allow"
	babelDecisionDeny  = "deny"
)

func (d babelDecision) allowed() bool { return d.Decision == babelDecisionAllow }

// carriesResults reports whether the decision came with a payload. A JSON null
// counts as no payload: it is what a marshaller emits for an absent value, and
// reading it as "served, empty" would invent the very distinction this
// predicate exists to keep.
func (d babelDecision) carriesResults() bool {
	trimmed := bytes.TrimSpace(d.Results)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null"))
}

// babelServed is the corpus evidence one allowed decision served. It mirrors
// Babel's babel.corpus-search/1 object and deliberately models less of it than
// arrives: the payload reaches the model verbatim, so a field named here is a
// field Code itself reads rather than one it passes on.
type babelServed struct {
	Schema string `json:"schema"`
	Query  string `json:"query"`

	// Limit is the page bound Babel applied, which is not the limit that was
	// asked for: a request for fifty hits is served ten. It is the only thing
	// that makes a short page readable — as many hits as the limit means the
	// page was full and more may lie behind an offset, fewer means the matches
	// ran out — and without it a worker reads a full page as the whole corpus.
	Limit int `json:"limit"`

	// Hits is a pointer because its absence and its emptiness are different
	// answers. A payload with an empty array is Babel saying the corpus
	// matched nothing; a payload with no array at all is a shape this build
	// does not recognize, and reporting that as "nothing matched" would put a
	// finding's weight on a decode that never happened.
	Hits *[]babelServedHit `json:"hits"`
}

// babelServedHit is one served hit: which session it came from, where in that
// session it sits, the locator that reopens it against the archive, and the
// bounded excerpt Babel redacted before serving.
//
// Index is the event's place in its session's event order, never its position
// in the hits array. Retrieval rank is not evidence strength and Babel serves
// no score for one to be inferred from, so nothing here or downstream may
// order anything by array position.
type babelServedHit struct {
	Harness  string `json:"harness"`
	SourceID string `json:"source_id"`
	Index    int    `json:"index"`

	// Excerpt is a clip and is named as one. Truncated says Babel cut it, and
	// a reader that ignores that flag can conclude a record says only what its
	// first two kilobytes say.
	Excerpt   string `json:"excerpt"`
	Truncated bool   `json:"truncated"`

	Locator babelLocator `json:"locator"`
}

// babelLocator is what reopens a hit against the archive: path and line find
// the record, and the digest proves the bytes found are the bytes served.
// SPEC.md requires every claim to be reopenable, so a rendering that drops
// this turns a citation into an assertion.
type babelLocator struct {
	Path       string `json:"path"`
	Line       int    `json:"line"`
	ByteOffset int64  `json:"byte_offset"`
	Digest     string `json:"digest"`
}

// servedEvidence decodes the payload. The boolean reports whether this build
// recognized the shape, which is not the same as whether the decode errored: a
// payload that unmarshals cleanly but carries no hits array is a shape from
// some other Babel, and it is reported as unrecognized rather than as a search
// that found nothing.
//
// Neither outcome is fatal, in either direction. The protocol's rule is that
// unknown fields are ignored inside a known version, and its consequence here
// is that an unreadable payload is still Babel's served evidence: the caller
// forwards the bytes and says it could not read them, rather than discarding
// what a newer Babel took the disclosure risk of sending.
func (d babelDecision) servedEvidence() (babelServed, bool) {
	if !d.carriesResults() {
		return babelServed{}, false
	}
	var served babelServed
	if err := json.Unmarshal(d.Results, &served); err != nil {
		return babelServed{}, false
	}
	return served, served.Hits != nil
}

// hits is the served hits, or none when the payload carried no array.
func (s babelServed) hits() []babelServedHit {
	if s.Hits == nil {
		return nil
	}
	return *s.Hits
}

// babelServedEcho is the answer the echo-evidence directive asks for: every
// hit this worker decoded off the decision, flattened to one string each.
//
// Flat for the reason babelJobEcho is flat. Producing
// "HARNESS|SOURCE_ID|INDEX|PATH|LINE|BYTE_OFFSET|DIGEST|EXCERPT" requires
// having walked the whole hit — into the nested locator and back out to the
// excerpt — so the string is the evidence of the decode rather than a claim
// about it, and Babel compares it against the bytes it served.
type babelServedEcho struct {
	Hits []string `json:"hits"`
}

// echo renders the served hits for the echo-evidence directive. The slice is
// allocated rather than left nil so a decision that served nothing answers
// with an empty array: Babel reads a null as a worker that never implemented
// the directive, and an empty array as one that implemented it and was served
// nothing, which are two different failures of two different programs.
func (s babelServed) echo() babelServedEcho {
	served := s.hits()
	echo := babelServedEcho{Hits: make([]string, 0, len(served))}
	for _, hit := range served {
		echo.Hits = append(echo.Hits, strings.Join([]string{
			hit.Harness,
			hit.SourceID,
			strconv.Itoa(hit.Index),
			hit.Locator.Path,
			strconv.Itoa(hit.Locator.Line),
			strconv.FormatInt(hit.Locator.ByteOffset, 10),
			hit.Locator.Digest,
			hit.Excerpt,
		}, "|"))
	}
	return echo
}

// ── what Babel records ───────────────────────────────────────────────────────

// The structured half of babel.analysis-result/1.
//
// Everything above this line is what Babel serves a worker. Everything below is
// what a worker gives back for Babel to keep, and it is a different kind of
// object: the analysis field beside it is prose nobody can reopen, while these
// become durable frontier records with lineage, status histories and
// consolidations hanging off them. A run that emits only prose has, as far as
// Babel is concerned, emitted nothing — which is exactly what happened on the
// exploration that produced eleven allowed corpus searches, five turns of
// reasoning, an essay, and every count at zero.
//
// These are Babel's own payload shapes, field for field, and they are declared
// here rather than assembled ad hoc where they are filled in, because a field
// Babel validates and Code never names is a field Code silently never sends.
// Babel's §4.3 minima are enforced on its side — an observation with no
// evidence locator is refused, and exactly one of counter_evidence and
// counter_evidence_absent must be set — so a shape that cannot express them is
// a run discarded after the model has already been paid for.

// babelCandidate is one emitted hypothesis and the claims developed against it.
// Ref is Code's own reference for it, unique within the result, and Babel binds
// it to the durable record it creates so a resumed run recognizes the same
// candidate instead of writing a second copy.
type babelCandidate struct {
	Ref          string               `json:"ref"`
	Hypothesis   babelHypothesisClaim `json:"hypothesis"`
	Observations []babelObservation   `json:"observations,omitempty"`
}

// babelHypothesisClaim is a candidate in the model's own wording plus the
// signals Babel sorts the frontier by. Novelty and Priority are ordering
// signals in [0,1] and never gate whether a candidate exists, which is why they
// are plain values with no absent state: a candidate Babel cannot sort is still
// a candidate Babel keeps.
type babelHypothesisClaim struct {
	Statement         string   `json:"statement"`
	OriginCues        []string `json:"origin_cues,omitempty"`
	ProvisionalLabels []string `json:"provisional_labels,omitempty"`
	Novelty           float64  `json:"novelty"`
	Priority          float64  `json:"priority"`
	Notes             string   `json:"notes,omitempty"`
}

// babelObservation is one provenance-bearing claim developed against a
// candidate. Recipe is §5.1 provenance and must name a recipe the run actually
// selected: Babel compares both the id and the version against the stage's
// assets and refuses the claim on a mismatch, so neither half may be guessed.
type babelObservation struct {
	Ref    string         `json:"ref"`
	Recipe babelRecipeRef `json:"recipe"`
	Claim  babelClaim     `json:"claim"`
}

// babelClaim is what an observation asserts, with the provenance that makes it
// reopenable.
//
// CounterEvidence and CounterEvidenceAbsent implement §4.3's "explicit
// counter-evidence or absence thereof", and exactly one of them is set so that
// an empty list can never be read as an unasked question. Nothing may write
// either field alone, which is why babelClaimOf below is the only place they are
// written at all.
type babelClaim struct {
	Claim                 string          `json:"claim"`
	Category              string          `json:"category,omitempty"`
	Confidence            string          `json:"confidence"`
	Impact                string          `json:"impact"`
	Evidence              []babelCitation `json:"evidence"`
	CounterEvidence       []babelCitation `json:"counter_evidence,omitempty"`
	CounterEvidenceAbsent bool            `json:"counter_evidence_absent,omitempty"`
	TemporalStatus        string          `json:"temporal_status,omitempty"`
}

// babelClaimOf assembles a claim, deriving the counter-evidence position from
// the citations rather than taking it as an argument. §4.3 requires exactly one
// of the two to be set and Babel refuses a payload that sets both or neither, so
// deriving it is what makes the contradiction unrepresentable instead of merely
// unlikely.
func babelClaimOf(claim, category, confidence, impact, temporal string,
	evidence, counter []babelCitation,
) babelClaim {
	return babelClaim{
		Claim:                 claim,
		Category:              category,
		Confidence:            confidence,
		Impact:                impact,
		Evidence:              evidence,
		CounterEvidence:       counter,
		CounterEvidenceAbsent: len(counter) == 0,
		TemporalStatus:        temporal,
	}
}

// babelCitation is one evidence locator and what the citing claim says those
// bytes show. Babel decodes it through a type whose fields are unexported
// precisely so that no citation can exist without a locator, so a note with no
// locator does not become a weaker citation — it fails to decode and takes the
// whole result with it.
type babelCitation struct {
	Locator babelLocator `json:"locator"`
	Note    string       `json:"note,omitempty"`
}

// babelGradings is the accepted value set for §4.3's confidence and impact, in
// the order a reader should see them offered. They are coarse and closed rather
// than numeric because confidence never substitutes for evidence and a spurious
// decimal invites exactly that, and Babel refuses any other value. One list
// serves both fields because the two vocabularies are the same three words, and
// a second copy of them could only ever become a divergence.
var babelGradings = []string{"low", "moderate", "high"}

// babelTemporalStatuses are §5.4's present-reality readings. The empty value is
// valid and means the question was not assessed, which is a different statement
// from "unverifiable" — where it was assessed and no answer was reachable — so
// it is absent from this list rather than a member of it.
var babelTemporalStatuses = []string{
	"historical",
	"still-applicable",
	"resolved",
	"regressed",
	"contradicted",
	"unverifiable",
}

// babelPrivacy is the profile's disclosure class and redaction requirement.
type babelPrivacy struct {
	Disclosure        string `json:"disclosure"`
	RedactionRequired bool   `json:"redaction_required"`
}

// babelCost is the profile's own non-secret cost estimate, never a
// measurement. Babel records it to support cost guards.
type babelCost struct {
	Currency     string  `json:"currency"`
	InputPer1K   float64 `json:"input_per_1k"`
	OutputPer1K  float64 `json:"output_per_1k"`
	EstimatedRun float64 `json:"estimated_run"`
}

// babelResources is self-reported resource use. Babel treats an absent value
// as unknown rather than zero, so reporting nothing is honest and reporting
// zero is a claim.
//
// The same reasoning applies one level down, which is why three of the four
// fields are pointers. Babel's struct declares them as plain numbers, so an
// omitted key arrives there as zero either way; the difference is what Code
// puts on the wire. A dimension this run had no way to measure is absent from
// the JSON, and a dimension that was measured as zero is present as zero, so
// the bytes a reviewer reads distinguish "nothing wrote anything" from "nobody
// looked". Filling an unmeasured dimension with a zero would be the cheapest
// possible way to satisfy a resource obligation with a number nobody read off
// anything, which is the failure this shape exists to make impossible.
//
// ToolCalls is not a pointer because the driver always knows it: every request
// this worker makes goes through one counter, so there is no state in which the
// count is unavailable.
type babelResources struct {
	CPUSeconds          *float64 `json:"cpu_seconds,omitempty"`
	MaxRSSBytes         *int64   `json:"max_rss_bytes,omitempty"`
	SandboxBytesWritten *int64   `json:"sandbox_bytes_written,omitempty"`
	ToolCalls           int      `json:"tool_calls"`
}

// babelContainment is the sandbox this worker declares it provides. Babel does
// not implement one — Code owns the disposable sandbox and credential
// isolation — so this declaration is what Babel holds the run to, and a
// declaration short of the run's requirement is refused before any job
// material arrives.
//
// Every field is a claim Code makes about itself, and Babel cannot verify it
// from outside the process. That is exactly why Escape is mandatory and may not
// be empty: a sandbox whose author claims no residual risk has not been
// examined. Declaring less than is true is safe; declaring more is a lie that
// ends up in a receipt a reviewer will trust.
type babelContainment struct {
	Backend             string `json:"backend"`
	FilesystemIsolation bool   `json:"filesystem_isolation"`
	NetworkDefaultDeny  bool   `json:"network_default_deny"`
	ResourceCeilings    bool   `json:"resource_ceilings"`
	Disposable          bool   `json:"disposable"`
	Escape              string `json:"escape"`
}

// babelConfiguration is the first event of any run and the only event of
// configure mode: the profile this worker actually resolved, with the
// non-secret metadata Babel records in the receipt. In worker mode it must also
// declare containment.
//
// Metadata carries provider, model and thinking level. A key whose name looks
// like a credential is refused outright by Babel, so nothing that could hold
// one belongs here.
type babelConfiguration struct {
	Type         string            `json:"type"`
	Seq          int               `json:"seq,omitempty"`
	Time         *time.Time        `json:"time,omitempty"`
	Profile      babelProfileRef   `json:"profile"`
	Privacy      babelPrivacy      `json:"privacy"`
	Cost         babelCost         `json:"cost"`
	Capabilities []string          `json:"capabilities"`
	Metadata     map[string]string `json:"metadata"`
	Containment  *babelContainment `json:"containment,omitempty"`
}

// babelProgress reports a stage of work. Babel keeps its own interface
// responsive from these, so they are emitted as work happens rather than
// batched at the end.
type babelProgress struct {
	Type      string          `json:"type"`
	Seq       int             `json:"seq"`
	Time      *time.Time      `json:"time"`
	Stage     string          `json:"stage"`
	Message   string          `json:"message,omitempty"`
	Fraction  float64         `json:"fraction,omitempty"`
	Resources *babelResources `json:"resources,omitempty"`
}

// babelToolRequest asks Babel for evidence. The worker blocks until the
// decision arrives. Arguments are given to Babel's authorizer and never
// recorded, so a private locator in an argument cannot reach a durable record —
// but it also means Babel cannot recover them later, and the worker must not
// rely on it doing so.
type babelToolRequest struct {
	Type       string          `json:"type"`
	Seq        int             `json:"seq"`
	Time       *time.Time      `json:"time"`
	RequestID  string          `json:"request_id"`
	Capability string          `json:"capability"`
	Tool       string          `json:"tool"`
	Arguments  json.RawMessage `json:"arguments,omitempty"`
	Reason     string          `json:"reason,omitempty"`
}

// babelResult is one of the two terminal events. Exactly one terminal event
// per run, nothing after it, and the process exits promptly: 0 after a result.
type babelResult struct {
	Type      string          `json:"type"`
	Seq       int             `json:"seq"`
	Time      *time.Time      `json:"time"`
	Status    string          `json:"status"`
	Schema    string          `json:"schema"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Resources *babelResources `json:"resources,omitempty"`
}

// babelError is the other terminal event. No result may follow it, and Babel
// owns the run's final status either way, so any exit code is acceptable after
// one.
type babelError struct {
	Type      string     `json:"type"`
	Seq       int        `json:"seq"`
	Time      *time.Time `json:"time"`
	Code      string     `json:"code"`
	Message   string     `json:"message"`
	Retryable bool       `json:"retryable"`
}

// Error codes Code emits. Babel treats them as opaque, but a stable set keeps
// receipts comparable across runs.
const (
	babelErrProfileUnavailable = "profile-unavailable"
	babelErrInvestigator       = "investigator-failed"
	babelErrContainment        = "containment-unavailable"
	babelErrInternal           = "internal"
)

// investigator runs one analysis job. It is the seam between the protocol and
// OMP: everything above it speaks Babel's wire format and knows nothing about
// OMP, and everything below it drives OMP and knows nothing about the wire.
// Worker mode is therefore testable without OMP installed, and the OMP driver
// is testable without a Babel on the other end.
type investigator interface {
	// containment declares what this investigator actually runs inside. It is
	// called before any job material is used, because Babel refuses an
	// insufficient declaration and there is no point resolving a profile for a
	// run that cannot start.
	containment() babelContainment

	// resolve opens the named profile and returns what Babel records: the
	// reference actually resolved, its disclosure class, its cost estimate and
	// its provider metadata. It must not execute analysis and must not return
	// anything secret.
	//
	// The rule is resolve-or-fail, not echo. Babel refuses a configuration
	// naming a different profile than the job named, which makes echoing the
	// job's reference the tempting way to satisfy it -- and the wrong one: a
	// profile Code cannot find must produce babelErrProfileUnavailable rather
	// than a reference Code cannot back. The one exception is a job where
	// conformanceRequested reports true, which names a synthetic profile on
	// purpose so the suite can grade a worker with no store at all.
	resolve(ctx investigatorContext, ref babelProfileRef) (babelConfiguration, error)

	// investigate runs the job to a terminal outcome.
	//
	// Progress goes to emit as it happens. Every request for evidence goes to
	// request, which blocks until Babel decides; a denial is not fatal and the
	// investigation must carry on without that evidence. Returning an error
	// means the run failed; returning a result means it finished, possibly
	// partially.
	investigate(ctx investigatorContext, job babelJob,
		emit func(stage, message string, fraction float64),
		request func(capability, tool, reason string, arguments json.RawMessage) babelDecision,
	) (babelResult, error)
}

// investigatorContext is the cancellation and deadline an investigator must
// honour. It is context.Context; the alias exists so this file documents the
// obligation rather than leaving it implicit: when Babel cancels, the whole
// process tree below the investigator goes away promptly, because Babel owns
// process-tree lifetime and will kill what remains.
type investigatorContext = interface {
	Deadline() (deadline time.Time, ok bool)
	Done() <-chan struct{}
	Err() error
	Value(key any) any
}
