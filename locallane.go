package main

// The local model lane — an analysis run by a model served on this machine
// (atyrode/babel#95).
//
// Every other lane Code offers is a hosted one: the catalog names models, a
// provider bills for them, and a credential from the central broker is what
// makes a run possible at all. This lane has none of that. The model is served
// over plain HTTP by a daemon on loopback (or on the operator's own network),
// there is no API key, and the cost estimate is zero because nobody is billing
// — which is a different claim than "cheap" and is recorded as such.
//
// Three properties are load-bearing.
//
// It is reachable only through the configuration ceremony. The lane is a dial
// like any other, and the dial only exists while `code babel --configure` has
// the operator's terminal (main.go): worker mode never builds it, so no
// environment variable and no flag can put a local model into a run. What the
// operator confirms is minted into a profile revision, and the recorded
// endpoint — not the environment the worker happens to be spawned with — is
// what the run then talks to. CODE_OLLAMA_ENDPOINT relocates the daemon the
// ceremony *discovers*, the way CODE_RUNTIME_BROKER names the broker binary
// whose targets the runtime dial offers; it selects nothing and mints nothing.
//
// The models are the endpoint's, not Code's. A hosted lane's dial values come
// from the catalog's curated ladder; here they are whatever tags the daemon
// reports, so a model the operator pulled ten minutes ago is selectable without
// regenerating anything.
//
// A profile is minted only against an endpoint that answers, and only for a
// model it still serves (babelMintProfile). The alternative — minting now and
// hoping the daemon is up when Babel next schedules a run — buys nothing: the
// profile would resolve, the run would launch, and the failure would land in a
// receipt as an analysis that failed for no stated reason. Refusing at mint
// time is the same judgement the ceremony already makes about a combination the
// catalog does not generate.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/atyrode/cli-kit/ollama"
)

// localEndpointEnv relocates the daemon the ceremony discovers. It is the same
// variable the ctrl+o classifier already reads (suggest.go), because there is
// one local daemon on a machine and two names for it would drift.
const localEndpointEnv = "CODE_OLLAMA_ENDPOINT"

// localProbeTimeout bounds every probe. A daemon that will not answer within a
// couple of seconds is one an operator would call down, and the ceremony must
// not hang on it — the same budget runtime discovery allows a broker.
const localProbeTimeout = 2 * time.Second

// localFacetKey is the dial, and localOff is the value that means "this run is
// not local". "off" rather than "hosted" (the runtime dial's word) because the
// hosted lane dials are still on screen beside it: turning this one off leaves
// them deciding the run, and turning it on takes them out of it.
const (
	localFacetKey = "local"
	localOff      = "off"
)

// The two local engines omp discovers without configuration, keyed by the route
// their model list answers on. Code names an engine rather than declaring a
// custom provider because omp already ships both as keyless implicit providers:
// the endpoint goes in one environment variable, `auth: none` is the default
// there, and the models the daemon serves are discovered at launch. A custom
// `models.yml` provider would need a file inside the run's private home and a
// bind mount into the sandbox to say the same thing.
const (
	// localEngineOllama is an Ollama daemon: native /api/tags discovery, base
	// URL from OLLAMA_BASE_URL.
	localEngineOllama = "ollama"
	// localEngineOpenAI is any other OpenAI-compatible server (llama.cpp's
	// server, oMLX, vLLM, LM Studio itself): /v1/models discovery, base URL
	// from LM_STUDIO_BASE_URL, which is the route omp documents for exactly
	// this case.
	localEngineOpenAI = "lm-studio"
)

// localEngineEnvKeys are the endpoint variables a local run replaces rather
// than inherits. An ambient OLLAMA_HOST from the operator's shell must not
// decide where a supervised run's model calls go: the profile decides.
var localEngineEnvKeys = map[string]bool{
	"OLLAMA_BASE_URL":    true,
	"OLLAMA_HOST":        true,
	"LM_STUDIO_BASE_URL": true,
}

// localLane is a local endpoint that answered: where it is, which engine it
// speaks, and what it serves right now.
type localLane struct {
	Endpoint string
	Engine   string
	Models   []string
}

// offered reports whether this lane can be put on a dial. An endpoint that
// answers but serves nothing is not an offer: every value would name a model no
// run could load.
func (l localLane) offered() bool { return l.Endpoint != "" && len(l.Models) > 0 }

func (l localLane) serves(model string) bool {
	for _, id := range l.Models {
		if id == model {
			return true
		}
	}
	return false
}

// statusLine is the one-line summary the preview shows, mirroring the runtime
// dial's: what is on the other end, in the operator's terms.
func (l localLane) statusLine() string {
	models := "1 model"
	if len(l.Models) != 1 {
		models = fmt.Sprintf("%d models", len(l.Models))
	}
	return l.Engine + " at " + l.Endpoint + " · " + models + " served · no credential"
}

// localEndpoint resolves where to look for the daemon.
func localEndpoint() string {
	if endpoint := strings.TrimSpace(os.Getenv(localEndpointEnv)); endpoint != "" {
		return endpoint
	}
	// cli-kit's constant, which the ctrl+o classifier and the dotfiles' local
	// classifier already agree on (see AGENTS.md).
	return ollama.DefaultEndpoint
}

// discoverLocalLane probes the endpoint and reports what it offers. A failure
// is an absence rather than an error: nothing answered, so there is no dial,
// which is the same shape runtime discovery has (loadRuntimeTargets).
func discoverLocalLane(endpoint string) localLane {
	lane, err := probeLocalLane(endpoint)
	if err != nil {
		return localLane{}
	}
	return lane
}

// probeLocalLane is discovery with its reason kept, for the mint-time check
// that has to say why it refused.
func probeLocalLane(endpoint string) (localLane, error) {
	base, err := localBaseURL(endpoint)
	if err != nil {
		return localLane{}, err
	}
	client := &http.Client{Timeout: localProbeTimeout}
	// Ollama first, and by its native route: an Ollama daemon also answers
	// /v1/models, so asking the generic question first would label every
	// machine in this fleet as a generic OpenAI-compatible server and point
	// omp's discovery at the wrong one of its two implicit providers.
	models, err := localList(client, base+"/api/tags", localOllamaTags)
	if err == nil {
		return localLane{Endpoint: base, Engine: localEngineOllama, Models: models}, nil
	}
	models, openErr := localList(client, localOpenAIBase(base)+"/models", localOpenAIModels)
	if openErr == nil {
		return localLane{Endpoint: base, Engine: localEngineOpenAI, Models: models}, nil
	}
	return localLane{}, fmt.Errorf("%s answered neither Ollama's /api/tags (%v) nor an "+
		"OpenAI-compatible /v1/models (%v)", base, err, openErr)
}

// localBaseURL validates the endpoint and returns it without a trailing slash.
//
// Two of the three rules are about honesty rather than parsing. A local profile
// declares disclosure "local" and needs no redaction, and that is only true
// while the endpoint is on this machine or the operator's own network — a
// public address would be a hosted provider wearing this lane's name. And the
// scheme has to be http: a contained run reaches the daemon through a raw
// loopback relay (sandboxegress.go), so an https endpoint would be verified
// against the relay's address rather than the daemon's and could not be
// trusted anyway.
func localBaseURL(endpoint string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(endpoint), "/")
	if trimmed == "" {
		return "", errors.New("no local endpoint is configured")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("the local endpoint %q is not a URL: %w", endpoint, err)
	}
	if parsed.Scheme != "http" {
		return "", fmt.Errorf("the local endpoint %q uses scheme %q; this lane speaks plain HTTP to a "+
			"daemon on this machine, and a contained run reaches it through a loopback relay that no "+
			"certificate could be checked against", endpoint, parsed.Scheme)
	}
	if parsed.Hostname() == "" {
		return "", fmt.Errorf("the local endpoint %q names no host", endpoint)
	}
	if !sandboxLocalAddr(parsed.Hostname()) {
		return "", fmt.Errorf("the local endpoint %q is not on this machine or a private network; a "+
			"model reached over the public internet is a hosted provider, and a profile that called it "+
			"local would understate what leaves this host", endpoint)
	}
	return trimmed, nil
}

// localOpenAIBase is the OpenAI-compatible base for an endpoint, whether or not
// the operator already spelled the /v1 out.
func localOpenAIBase(base string) string {
	if strings.HasSuffix(base, "/v1") {
		return base
	}
	return base + "/v1"
}

// localHostPort is the address the sandbox relay dials on the host.
func localHostPort(base string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	return sandboxHostPort(parsed)
}

// localGuestBase rewrites an endpoint's authority to the sandbox's own
// loopback, keeping scheme and path: the relay splices bytes, so anything after
// the authority still has to reach the daemon as the operator wrote it.
func localGuestBase(base string, port int) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	parsed.Host = net.JoinHostPort("127.0.0.1", fmt.Sprint(port))
	return strings.TrimRight(parsed.String(), "/"), nil
}

// localList fetches one model list. A non-200 is a route the server does not
// serve, which is how the engine is told apart.
func localList(client *http.Client, endpoint string, decode func([]byte) ([]string, error)) ([]string, error) {
	response, err := client.Get(endpoint)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %s", endpoint, response.Status)
	}
	// Bounded: a model list is a few kilobytes, and a daemon that streams
	// megabytes at the ceremony is not one to hand a terminal to.
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	return decode(body)
}

func localOllamaTags(body []byte) ([]string, error) {
	var payload struct {
		Models []struct {
			Name  string `json:"name"`
			Model string `json:"model"`
		} `json:"models"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(payload.Models))
	for _, entry := range payload.Models {
		name := entry.Name
		if name == "" {
			name = entry.Model
		}
		names = append(names, name)
	}
	return localModelNames(names), nil
}

func localOpenAIModels(body []byte) ([]string, error) {
	var payload struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(payload.Data))
	for _, entry := range payload.Data {
		names = append(names, entry.ID)
	}
	return localModelNames(names), nil
}

// localModelNames keeps the usable tags, deduplicated and sorted so the dial's
// order is stable across probes.
//
// The filter is not cosmetic. A model id from the endpoint travels into an omp
// config overlay and into a receipt's metadata, and the endpoint is a daemon
// serving whatever it was handed — so an id carrying a newline, a quote or a
// space is dropped here rather than quoted at each of the places it lands.
func localModelNames(names []string) []string {
	seen := make(map[string]bool, len(names))
	kept := make([]string, 0, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] || !localModelNameOK(name) {
			continue
		}
		seen[name] = true
		kept = append(kept, name)
	}
	sort.Strings(kept)
	return kept
}

func localModelNameOK(name string) bool {
	if len(name) > 128 {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case strings.ContainsRune("._:/@+-", r):
		default:
			return false
		}
	}
	return true
}

// ── the dial ─────────────────────────────────────────────────────────────────

// localFacet builds the dial: off, then one value per served model.
func localFacet(glyph string, lane localLane) facet {
	values := append([]string{localOff}, lane.Models...)
	return facet{key: localFacetKey, values: values, glyph: glyph}
}

// selectedLocalModel reports the model the local dial names, and whether this
// run is a local one at all.
func (m model) selectedLocalModel() (string, bool) {
	selected := m.sel[localFacetKey]
	if selected == "" || selected == localOff || !m.local.serves(selected) {
		return "", false
	}
	return selected, true
}

// localThinkingLevels is the whole thinking dial for this lane. The endpoints
// these daemons expose take no reasoning-effort parameter, and omp clamps a
// level a model does not offer, so offering the full six would be six labels
// for one behaviour. Two are kept rather than one because a local model that
// does think is asked to think a little, and because a dial with a single value
// is a label pretending to be a choice.
var localThinkingLevels = []string{"minimal", "low"}

// localThinking clamps a thinking level to what this lane offers, downward: an
// operator who left the dial at "max" on a hosted lane and then went local gets
// the highest level that is still honest here rather than a level the profile
// would record and the endpoint would ignore.
func localThinking(level string) string {
	for _, allowed := range localThinkingLevels {
		if level == allowed {
			return level
		}
	}
	return localThinkingLevels[len(localThinkingLevels)-1]
}

// ── the profile ──────────────────────────────────────────────────────────────

// The metadata keys a local profile records beside the provider/model/thinking
// triple every profile carries. They are the whole configuration of this lane:
// worker mode rebuilds the overlay and the endpoint from them, so a profile
// minted months ago runs against the daemon the operator confirmed rather than
// whatever the environment says today.
const (
	localMetaEndpoint  = "endpoint"
	localMetaEngine    = "engine"
	localMetaCostBasis = "cost_basis"
)

// localCostBasis is the explicit marker a receipt carries in place of a price.
// The zero cost is a fact about who is billing rather than a cheap estimate,
// and a reviewer reading a run that cost nothing has to be able to tell the
// two apart.
const localCostBasis = "local endpoint · no provider billing · zero by construction"

// localTarget is a local profile's configuration, read back out of what was
// recorded.
type localTarget struct {
	Endpoint string
	Engine   string
	Model    string
	Thinking string
}

// isLocalProfile reports whether a profile's metadata declares this lane.
func isLocalProfile(metadata map[string]string) bool {
	return metadata["provider"] == localProvider
}

// localTargetOf reads the lane back. A profile that declares the lane and then
// misses a field is an error rather than a hosted run: the alternative is a
// launch against whatever the environment's endpoint variables happen to say,
// which is the resolution this lane exists without.
func localTargetOf(metadata map[string]string) (localTarget, error) {
	target := localTarget{
		Endpoint: metadata[localMetaEndpoint],
		Engine:   metadata[localMetaEngine],
		Model:    metadata["model"],
		Thinking: metadata["thinking"],
	}
	base, err := localBaseURL(target.Endpoint)
	if err != nil {
		return localTarget{}, fmt.Errorf("the profile declares the local lane but %w", err)
	}
	target.Endpoint = base
	if target.Model == "" {
		return localTarget{}, errors.New("the profile declares the local lane but names no model")
	}
	if !localModelNameOK(target.Model) {
		return localTarget{}, fmt.Errorf("the profile's local model %q is not a usable model id", target.Model)
	}
	switch target.Engine {
	case localEngineOllama, localEngineOpenAI:
	default:
		return localTarget{}, fmt.Errorf("the profile declares local engine %q, and Code speaks %s or %s",
			target.Engine, localEngineOllama, localEngineOpenAI)
	}
	target.Thinking = localThinking(target.Thinking)
	return target, nil
}

// localRunProfile reads the lane out of a resolved profile, for the two places
// that have to know before anything is launched: where the child's endpoint
// variable points, and which hole the boundary opens (ompinvestigator.go,
// sandbox.go).
//
// A profile that declares the lane and cannot be read is an error rather than a
// hosted run, for the same reason localTargetOf refuses one: the fallback would
// be a launch against whatever the environment says.
func localRunProfile(profile resolvedProfile) (localTarget, bool, error) {
	if !isLocalProfile(profile.Metadata) {
		return localTarget{}, false, nil
	}
	target, err := localTargetOf(profile.Metadata)
	if err != nil {
		return localTarget{}, false, err
	}
	return target, true, nil
}

// describeLocalDials records the local lane as the profile Babel keeps.
//
// The cost is zero and says why in a field of its own; the disclosure is local
// and redaction is therefore not required, which is the same reasoning a
// delegated runtime target gets (babelDescribeDials) and for the same reason:
// material that never leaves the machine has no third party to be redacted
// for.
//
// The selection is the two dials this lane actually has — the model and the
// thinking level — and not the hosted set the ceremony carries beside them. A
// local profile is never replayed through the catalog (profileOverlay), so a
// recorded lane, tier or advisor would be a dial that decided nothing about
// this run, and the derived halves the lane dial renders as (lead, blend) would
// make the revision's identity depend on whether the operator happened to look
// at the hosted dials on the way past.
func describeLocalDials(m model, id, chosen string) codeProfile {
	thinking := localThinking(m.sel["thinking"])
	selection := map[string]string{localFacetKey: chosen, "thinking": thinking}
	combo := localComboID(chosen)
	return codeProfile{
		ID:         id,
		Selection:  selection,
		ComboID:    combo,
		Disclosure: babelDisclosureLocal,
		// Nothing leaves this machine, so there is nothing to redact before it
		// does.
		RedactionRequired: false,
		Cost:              babelCost{Currency: "USD"},
		Metadata: map[string]string{
			"lane":             localProvider,
			"provider":         localProvider,
			"model":            chosen,
			"thinking":         thinking,
			"combo":            combo,
			localMetaEngine:    m.local.Engine,
			localMetaEndpoint:  m.local.Endpoint,
			localMetaCostBasis: localCostBasis,
		},
	}
}

// localComboID names the combination for a lane the catalog does not generate.
// It is not a lookup key — nothing indexes the catalog by it — but it is what
// the profile's identity is partly defined by, so two local models have to
// produce two revisions.
func localComboID(model string) string { return localProvider + "_" + model }

// confirmLocalEndpoint is the mint-time check: the daemon still answers, and it
// still serves the model the operator confirmed.
func confirmLocalEndpoint(target localTarget) error {
	lane, err := probeLocalLane(target.Endpoint)
	if err != nil {
		return fmt.Errorf("the local endpoint is not answering, so this profile would name a model no "+
			"run could load: %w", err)
	}
	if !lane.serves(target.Model) {
		return fmt.Errorf("%s no longer serves %q (it serves %s), so this profile would name a model no "+
			"run could load", lane.Endpoint, target.Model, localServedList(lane))
	}
	return nil
}

func localServedList(lane localLane) string {
	if len(lane.Models) == 0 {
		return "nothing"
	}
	return strings.Join(lane.Models, ", ")
}

// ── the run ──────────────────────────────────────────────────────────────────

// overlayYAML is the omp configuration a local profile launches with, in the
// same grammar genConfigYAML renders for a hosted one: every role this
// installation routes, pinned to the one model the endpoint serves.
//
// Every role rather than just the default, deliberately. A role left unmapped
// falls to omp's own defaults, which name a hosted provider — and a run that
// resolved no credential would then fail its first call for a reason a receipt
// cannot explain, or, on a machine where something ambient did resolve, quietly
// send the corpus to a provider this profile promised it would not. There is no
// fallback chain: one endpoint serving one model has nothing to fall back to,
// and an empty chain claiming otherwise would be worse than none.
func (t localTarget) overlayYAML() string {
	qualified := yamlQuote(t.Engine + "/" + t.Model)
	var roles, agents strings.Builder
	for _, role := range genRoleOrder {
		if role == "advisor" {
			// The advisor is a second opinion from a different model, which a
			// single-model endpoint cannot give. It is off below.
			continue
		}
		roles.WriteString("  " + role + ": " + qualified + "\n")
		if genAgentRoles[role] {
			agents.WriteString("    " + role + ": " + qualified + "\n")
		}
	}
	var b strings.Builder
	b.WriteString("modelRoles:\n" + roles.String())
	if agents.Len() > 0 {
		b.WriteString("task:\n  agentModelOverrides:\n" + agents.String())
	}
	b.WriteString("defaultThinkingLevel: " + t.Thinking + "\n")
	b.WriteString("advisor:\n  enabled: false\n")
	return b.String()
}

// yamlQuote renders a string as a YAML double-quoted scalar. A model id is the
// endpoint's word, not Code's, and a tag like "qwen2.5:3b" is a plain scalar
// only by luck of where the colon falls.
func yamlQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// engineEnv points omp's implicit local engine at base — the daemon's own
// address for an uncontained run, the sandbox's relay for a contained one.
func (t localTarget) engineEnv(base string) string {
	if t.Engine == localEngineOpenAI {
		return "LM_STUDIO_BASE_URL=" + localOpenAIBase(base)
	}
	return "OLLAMA_BASE_URL=" + base
}

// localChildEnv is the child's environment with the endpoint replaced rather
// than added: whatever the operator's shell exports must not decide where a
// supervised run's model calls go.
func localChildEnv(base []string, target localTarget, endpoint string) []string {
	return append(removeEnvKeys(base, localEngineEnvKeys), target.engineEnv(endpoint))
}
