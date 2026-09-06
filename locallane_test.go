package main

// The local model lane, exercised against a fake daemon.
//
// Everything here runs on an httptest server that answers Ollama's model-list
// route and nothing else. That is enough to drive the whole lane — discovery,
// the dial, the mint, the refusal, the run's endpoint wiring and the sandbox's
// relay — because no test needs a model to answer a prompt: what is being
// checked is which endpoint the run was pointed at and what it was allowed to
// reach, and a real model would only make those slower to observe.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// localStub is a fake local daemon. It serves Ollama's native /api/tags and
// refuses everything else, which is exactly what discovery has to tell apart.
type localStub struct {
	server *httptest.Server
	mu     sync.Mutex
	models []string
}

func newLocalStub(t *testing.T, models ...string) *localStub {
	t.Helper()
	stub := &localStub{models: models}
	stub.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tags" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		stub.mu.Lock()
		entries := make([]map[string]string, 0, len(stub.models))
		for _, name := range stub.models {
			entries = append(entries, map[string]string{"name": name, "model": name})
		}
		stub.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"models": entries})
	}))
	t.Cleanup(stub.server.Close)
	return stub
}

func (s *localStub) url() string { return s.server.URL }

// serve replaces what the daemon reports, so a test can take a model away
// between the dial and the mint.
func (s *localStub) serve(models ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.models = models
}

func (s *localStub) close() { s.server.Close() }

// localCeremony builds the configuration ceremony against a stub endpoint,
// which is the only mode the local dial exists in.
func localCeremony(t *testing.T, endpoint string) model {
	t.Helper()
	t.Setenv(localEndpointEnv, endpoint)
	return ceremonyModel(t)
}

// localMintedProfile drives the ceremony to a committed local profile and
// returns the store's copy of it.
func localMintedProfile(t *testing.T, store string, m model) codeProfile {
	t.Helper()
	result := filepath.Join(t.TempDir(), "result.json")
	final := confirm(t, m)
	if !final.configureConfirmed() {
		t.Fatal("Enter did not confirm the local model the operator selected")
	}
	if status := commitConfiguration(final, engineOptions{
		profile: profileRef{ID: defaultProfileID}, resultFile: result,
	}); status != 0 {
		t.Fatalf("committing a confirmed local ceremony exited %d, want 0", status)
	}
	answer, err := os.ReadFile(result)
	if err != nil {
		t.Fatalf("reading the reference the ceremony wrote: %v", err)
	}
	var reference configureResult
	if err := json.Unmarshal(answer, &reference); err != nil {
		t.Fatalf("the reference does not decode: %v (%s)", err, answer)
	}
	saved, err := newProfileStore(store).load(reference.Profile, reference.Revision)
	if err != nil {
		t.Fatalf("the reference does not resolve in the store: %v", err)
	}
	return saved
}

// localTestProfile is a resolved local profile as the store would hand one to
// the investigator: the metadata the ceremony records, and the overlay rendered
// from it.
func localTestProfile(t *testing.T, endpoint, model string) resolvedProfile {
	t.Helper()
	profile := codeProfile{
		ID:         "local",
		Revision:   3,
		Disclosure: disclosureLocal,
		Cost:       profileCost{Currency: "USD"},
		Metadata: map[string]string{
			"lane":             localProvider,
			"provider":         localProvider,
			"model":            model,
			"thinking":         "minimal",
			localMetaEngine:    localEngineOllama,
			localMetaEndpoint:  endpoint,
			localMetaCostBasis: localCostBasis,
		},
	}
	overlay, err := profileOverlay(profile)
	if err != nil {
		t.Fatalf("rendering the local overlay: %v", err)
	}
	return resolvedProfile{
		Ref:        profile.ref(),
		Disclosure: profile.Disclosure,
		Cost:       profile.Cost,
		Metadata:   profile.Metadata,
		ConfigYAML: overlay,
	}
}

// ompFakeGet is the fake OMP's one HTTP request, reported as a string so the
// record carries both outcomes: a status when something answered, and the
// failure when nothing did.
func ompFakeGet(endpoint string) string {
	response, err := http.Get(endpoint)
	if err != nil {
		return "error: " + err.Error()
	}
	defer response.Body.Close()
	return strconv.Itoa(response.StatusCode)
}

// ── discovery ────────────────────────────────────────────────────────────────

// TestLocalLaneDiscoversWhatTheEndpointServes is the lane's first claim: the
// dial's values are the daemon's, not Code's. The unusable ids are in the
// fixture on purpose — a model id travels into a config overlay and a receipt,
// and the endpoint is a daemon serving whatever it was handed.
func TestLocalLaneDiscoversWhatTheEndpointServes(t *testing.T) {
	stub := newLocalStub(t, "qwen2.5:3b", "llama3.2:1b", "qwen2.5:3b", "bad name", "", "quo\"te")
	lane := discoverLocalLane(stub.url())
	if !lane.offered() {
		t.Fatal("a daemon answering with two usable models offered no dial")
	}
	if lane.Engine != localEngineOllama {
		t.Errorf("engine = %q, want %q (the native /api/tags route answered)", lane.Engine, localEngineOllama)
	}
	if lane.Endpoint != stub.url() {
		t.Errorf("endpoint = %q, want %q", lane.Endpoint, stub.url())
	}
	if got := strings.Join(lane.Models, ","); got != "llama3.2:1b,qwen2.5:3b" {
		t.Errorf("models = %q, want the two usable ids, deduplicated and sorted", got)
	}
	dial := localFacet("g", lane)
	if dial.key != localFacetKey || dial.values[0] != localOff {
		t.Fatalf("dial = %+v, want %q with %q first", dial, localFacetKey, localOff)
	}
	if strings.Join(dial.values[1:], ",") != "llama3.2:1b,qwen2.5:3b" {
		t.Errorf("dial values = %v, want off plus the served models", dial.values)
	}
}

// TestLocalLaneDiscoversAnOpenAICompatibleEndpoint covers the other engine: a
// server with no Ollama routes is reached through omp's generic local-engine
// discovery instead, and the environment variable follows.
func TestLocalLaneDiscoversAnOpenAICompatibleEndpoint(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]string{{"id": "mlx-community/qwen3-4b"}},
		})
	}))
	defer server.Close()

	lane := discoverLocalLane(server.URL)
	if lane.Engine != localEngineOpenAI {
		t.Fatalf("engine = %q, want %q", lane.Engine, localEngineOpenAI)
	}
	if len(lane.Models) != 1 || lane.Models[0] != "mlx-community/qwen3-4b" {
		t.Fatalf("models = %v, want the one id the /v1/models route served", lane.Models)
	}
	target := localTarget{Endpoint: lane.Endpoint, Engine: lane.Engine, Model: lane.Models[0]}
	if got, want := target.engineEnv(lane.Endpoint), "LM_STUDIO_BASE_URL="+lane.Endpoint+"/v1"; got != want {
		t.Errorf("engine env = %q, want %q", got, want)
	}
	if got := strings.Split(target.overlayYAML(), "\n")[1]; !strings.Contains(got, localEngineOpenAI+"/") {
		t.Errorf("the overlay's first role is %q, want it qualified by the engine", got)
	}
}

// TestLocalLaneRefusesAnEndpointItCouldNotCallLocal is the disclosure rule as
// code. A local profile tells a client that nothing left the machine and that no
// redaction was needed, so an endpoint on the public internet — or one behind
// TLS that a loopback relay could never be checked against — is not this lane.
func TestLocalLaneRefusesAnEndpointItCouldNotCallLocal(t *testing.T) {
	for _, endpoint := range []string{
		"http://models.example.com:11434",
		"https://127.0.0.1:11434",
		"127.0.0.1:11434",
		"",
	} {
		if _, err := localBaseURL(endpoint); err == nil {
			t.Errorf("%q was accepted as a local endpoint", endpoint)
		}
		if lane := discoverLocalLane(endpoint); lane.offered() {
			t.Errorf("%q offered a dial", endpoint)
		}
	}
	// A loopback endpoint with a path and a trailing slash is the same
	// endpoint: the relay keeps the path, so it has to survive normalization.
	if got, err := localBaseURL("http://127.0.0.1:11434/proxy/"); err != nil || got != "http://127.0.0.1:11434/proxy" {
		t.Errorf("localBaseURL = %q, %v; want the path kept and the slash dropped", got, err)
	}
}

// ── the dial exists only in the ceremony ─────────────────────────────────────

// TestLocalDialExistsOnlyInTheCeremony is decision one of this lane: a local
// model is chosen by a human at the dials or not at all. An ordinary `code`
// never builds the dial, so no environment variable can put a local model into
// a launch — and an engine launch, which builds its dial model from the catalog
// alone (engineCatalogModel), never sees one either.
func TestLocalDialExistsOnlyInTheCeremony(t *testing.T) {
	isolateEngineEnv(t)
	t.Setenv("CODE_GENERATED", engineCatalogFixture(t))
	stub := newLocalStub(t, "qwen2.5:3b")
	t.Setenv(localEndpointEnv, stub.url())

	keepKeybindings(t)
	launch, ok := newInteractiveApp(interactiveLaunch).(model)
	if !ok {
		t.Fatal("a launch mounted something other than the dial UI")
	}
	if facetIndex(launch.facets, localFacetKey) >= 0 {
		t.Error("a launch offers the local dial; it is the ceremony's alone")
	}
	if launch.local.offered() {
		t.Error("a launch discovered the local endpoint")
	}

	ceremony := localCeremony(t, stub.url())
	if facetIndex(ceremony.facets, localFacetKey) < 0 {
		t.Fatal("the ceremony offers no local dial against a reachable endpoint")
	}
	if ceremony.sel[localFacetKey] != localOff {
		t.Errorf("the local dial opened at %q, want %q", ceremony.sel[localFacetKey], localOff)
	}
	if _, on := ceremony.selectedLocalModel(); on {
		t.Error("the ceremony opened with a local model already selected")
	}

	worker := engineCatalogModel()
	if facetIndex(worker.facets, localFacetKey) >= 0 || worker.local.offered() {
		t.Error("the engine built a local dial, which no operator turned")
	}
}

// TestLocalDialIsAbsentWithoutAnEndpoint keeps the ceremony honest on a machine
// with no daemon: no dial rather than a dial whose every value names a model
// nothing could load.
func TestLocalDialIsAbsentWithoutAnEndpoint(t *testing.T) {
	isolateEngineEnv(t)
	t.Setenv("CODE_GENERATED", engineCatalogFixture(t))
	// An endpoint that answers but serves nothing is the same absence.
	empty := newLocalStub(t)
	for _, endpoint := range []string{"http://127.0.0.1:1", empty.url()} {
		m := localCeremony(t, endpoint)
		if facetIndex(m.facets, localFacetKey) >= 0 {
			t.Errorf("endpoint %q produced a local dial", endpoint)
		}
	}
}

// TestLocalDialTakesTheHostedDialsOffScreen: a local model answers every role,
// so the lane, tier and advisor dials describe nothing about the run. Thinking
// stays, narrowed to the levels a local endpoint can honestly be asked for.
func TestLocalDialTakesTheHostedDialsOffScreen(t *testing.T) {
	isolateEngineEnv(t)
	t.Setenv("CODE_GENERATED", engineCatalogFixture(t))
	stub := newLocalStub(t, "qwen2.5:3b")
	m := localCeremony(t, stub.url())
	m.sel["thinking"] = "max"
	m = turnDial(t, m, localFacetKey)
	if chosen, on := m.selectedLocalModel(); !on || chosen != "qwen2.5:3b" {
		t.Fatalf("the dial selected %q, %v; want the served model", chosen, on)
	}

	var keys []string
	for _, f := range m.visibleFacets() {
		keys = append(keys, f.key)
		if f.key == "thinking" && strings.Join(f.values, ",") != strings.Join(localThinkingLevels, ",") {
			t.Errorf("the local thinking dial offers %v, want %v", f.values, localThinkingLevels)
		}
	}
	if strings.Join(keys, ",") != localFacetKey+",thinking" {
		t.Errorf("visible dials = %v, want just the local model and thinking", keys)
	}
	if m.sel["thinking"] != "low" {
		t.Errorf("thinking = %q, want the dial clamped down to a level this lane offers", m.sel["thinking"])
	}
	if !strings.Contains(strings.Join(m.launchFooter(), " "), "0.00 USD") {
		t.Errorf("the footer does not state the zero cost: %q", m.launchFooter())
	}
}

// TestLocalDialSurvivesWithNoConnectedProvider is the case this lane is for: a
// machine with no provider credential at all can still confirm something. The
// hosted dials are gone there — nothing they name could run — and the local one
// must not go with them.
func TestLocalDialSurvivesWithNoConnectedProvider(t *testing.T) {
	isolateEngineEnv(t)
	t.Setenv("CODE_GENERATED", engineCatalogFixture(t))
	stub := newLocalStub(t, "qwen2.5:3b")
	m := localCeremony(t, stub.url())
	m.applyProviderAvailability(map[string]bool{})
	if !m.noProviders {
		t.Fatal("a machine with no connected pools did not read as having no providers")
	}
	visible := m.visibleFacets()
	if len(visible) != 1 || visible[0].key != localFacetKey {
		t.Fatalf("visible dials = %+v, want only the local one", visible)
	}
}

func facetIndex(facets []facet, key string) int {
	for i, f := range facets {
		if f.key == key {
			return i
		}
	}
	return -1
}

// ── minting ──────────────────────────────────────────────────────────────────

// TestLocalCeremonyMintsWhatTheEndpointServes is the mint: the operator turns
// the local dial, confirms, and the profile the client gets a reference to records
// the endpoint, the engine, the model and a zero cost that says why it is zero.
func TestLocalCeremonyMintsWhatTheEndpointServes(t *testing.T) {
	store := isolateEngineEnv(t)
	t.Setenv("CODE_GENERATED", engineCatalogFixture(t))
	stub := newLocalStub(t, "qwen2.5:3b")

	m := localCeremony(t, stub.url())
	m = turnDial(t, m, localFacetKey)
	saved := localMintedProfile(t, store, m)

	if saved.Disclosure != disclosureLocal {
		t.Errorf("disclosure = %q, want %q", saved.Disclosure, disclosureLocal)
	}
	if saved.RedactionRequired {
		t.Error("a profile that sends nothing off the machine still requires redaction")
	}
	if saved.Cost != (profileCost{Currency: "USD"}) {
		t.Errorf("cost = %+v, want zero in USD", saved.Cost)
	}
	want := map[string]string{
		"provider":         localProvider,
		"lane":             localProvider,
		"model":            "qwen2.5:3b",
		localMetaEngine:    localEngineOllama,
		localMetaEndpoint:  stub.url(),
		localMetaCostBasis: localCostBasis,
	}
	for key, value := range want {
		if saved.Metadata[key] != value {
			t.Errorf("metadata[%q] = %q, want %q", key, saved.Metadata[key], value)
		}
	}
	if got := saved.Metadata["thinking"]; got != localThinking(got) {
		t.Errorf("recorded thinking %q is not a level this lane offers", got)
	}
	if len(saved.Selection) != 2 || saved.Selection[localFacetKey] != "qwen2.5:3b" ||
		saved.Selection["thinking"] != saved.Metadata["thinking"] {
		t.Errorf("selection = %v, want just the model and thinking this lane dials", saved.Selection)
	}
	if names := secretShapedMetadata(saved.Metadata); len(names) > 0 {
		t.Errorf("the minted profile declares credential-shaped keys %v", names)
	}

	// The same reference resolves back through the store --describe reads,
	// and renders an overlay pinned to the local model.
	reported, err := newProfileStore("").load(saved.ID, 0)
	if err != nil {
		t.Fatalf("--describe cannot report the local profile: %v", err)
	}
	if reported.Revision != saved.Revision {
		t.Errorf("--describe reports revision %d, want %d", reported.Revision, saved.Revision)
	}
	overlay, err := profileOverlay(saved)
	if err != nil {
		t.Fatalf("rendering the overlay of a minted local profile: %v", err)
	}
	for _, want := range []string{
		"modelRoles:\n",
		`  default: "ollama/qwen2.5:3b"`,
		`    reviewer: "ollama/qwen2.5:3b"`,
		"defaultThinkingLevel: " + saved.Metadata["thinking"] + "\n",
		"advisor:\n  enabled: false\n",
	} {
		if !strings.Contains(overlay, want) {
			t.Errorf("the local overlay lacks %q:\n%s", want, overlay)
		}
	}
	if strings.Contains(overlay, "fallbackChains") {
		t.Errorf("the local overlay claims a fallback chain it has no second model for:\n%s", overlay)
	}
	if strings.Contains(overlay, "advisor: ") {
		t.Errorf("the local overlay routes an advisor role:\n%s", overlay)
	}

	// Minting again without touching a dial is the same revision: a ceremony
	// opened to check the endpoint must not inflate the history.
	again := localCeremony(t, stub.url())
	again.sel[localFacetKey] = "qwen2.5:3b"
	again.sel["thinking"] = saved.Metadata["thinking"]
	repeat, err := mintProfile(confirm(t, again), saved.ID)
	if err != nil {
		t.Fatalf("re-minting the same local configuration: %v", err)
	}
	if repeat.Revision != saved.Revision {
		t.Errorf("an unchanged confirmation minted revision %d, want %d", repeat.Revision, saved.Revision)
	}
}

// TestLocalCeremonyRefusesADeadEndpoint is the refusal, and it is a refusal
// rather than a warning on purpose. A profile minted against a daemon that has
// gone away would resolve, launch, and fail — and the receipt could only report
// that the analysis did not work.
func TestLocalCeremonyRefusesADeadEndpoint(t *testing.T) {
	store := isolateEngineEnv(t)
	t.Setenv("CODE_GENERATED", engineCatalogFixture(t))
	stub := newLocalStub(t, "qwen2.5:3b")

	m := localCeremony(t, stub.url())
	m = turnDial(t, m, localFacetKey)
	final := confirm(t, m)
	if !final.configureConfirmed() {
		t.Fatal("Enter did not confirm the local model")
	}
	// The daemon stops between the confirmation and the commit.
	stub.close()

	result := filepath.Join(t.TempDir(), "result.json")
	if status := commitConfiguration(final, engineOptions{
		profile: profileRef{ID: defaultProfileID}, resultFile: result,
	}); status != 1 {
		t.Fatalf("committing against a dead endpoint exited %d, want 1 (configuration unchanged)", status)
	}
	if _, err := os.Stat(result); err == nil {
		t.Error("a reference was written for a profile that could not be minted")
	}
	if _, err := newProfileStore(store).load(defaultProfileID, 0); err == nil {
		t.Error("a revision was written against an endpoint that is not answering")
	}
}

// TestLocalCeremonyRefusesAModelTheEndpointDropped is the other half of the
// same check: the daemon answers, but no longer serves what was dialled.
func TestLocalCeremonyRefusesAModelTheEndpointDropped(t *testing.T) {
	isolateEngineEnv(t)
	t.Setenv("CODE_GENERATED", engineCatalogFixture(t))
	stub := newLocalStub(t, "qwen2.5:3b")

	m := localCeremony(t, stub.url())
	m = turnDial(t, m, localFacetKey)
	final := confirm(t, m)
	stub.serve("llama3.2:1b")

	_, err := mintProfile(final, defaultProfileID)
	if err == nil {
		t.Fatal("a model the endpoint no longer serves was minted")
	}
	for _, want := range []string{"qwen2.5:3b", "llama3.2:1b"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the refusal does not mention %q: %v", want, err)
		}
	}
}

// TestLocalCeremonyLaunchesNothing keeps the dial out of a session. It exists
// only during a ceremony, and Enter on it there is a confirmation; an
// inconsistent model that reached the launch path must start nothing.
func TestLocalCeremonyLaunchesNothing(t *testing.T) {
	isolateEngineEnv(t)
	stub := newLocalStub(t, "qwen2.5:3b")
	m := model{
		local: discoverLocalLane(stub.url()),
		sel:   map[string]string{localFacetKey: "qwen2.5:3b", "thinking": "low"},
	}
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	final := next.(model)
	if final.genConfig != "" || final.launchRuntime != "" || final.localConfirmed != "" {
		t.Errorf("a launch confirmed the local dial: %+v",
			[]string{final.genConfig, final.launchRuntime, final.localConfirmed})
	}
}

// TestLocalProfileOverlayRefusesBrokenMetadata: a profile that declares this
// lane and cannot be read is an error, never a hosted run. The alternative is a
// launch against whatever the environment's endpoint variables happen to say,
// which is the resolution this lane exists without.
func TestLocalProfileOverlayRefusesBrokenMetadata(t *testing.T) {
	for name, metadata := range map[string]map[string]string{
		"no model": {"provider": localProvider, localMetaEndpoint: "http://127.0.0.1:11434",
			localMetaEngine: localEngineOllama},
		"no endpoint": {"provider": localProvider, "model": "qwen2.5:3b",
			localMetaEngine: localEngineOllama},
		"unknown engine": {"provider": localProvider, "model": "qwen2.5:3b",
			localMetaEndpoint: "http://127.0.0.1:11434", localMetaEngine: "telepathy"},
		"public endpoint": {"provider": localProvider, "model": "qwen2.5:3b",
			localMetaEndpoint: "http://models.example.com", localMetaEngine: localEngineOllama},
	} {
		profile := codeProfile{ID: "local", Revision: 1, Metadata: metadata}
		if _, err := profileOverlay(profile); err == nil {
			t.Errorf("%s: an unusable local profile rendered an overlay", name)
		}
	}
}

// ── the run ──────────────────────────────────────────────────────────────────

// TestLocalRunNeedsNoCredential is the credential gate's exception. The engine
// refuses a launch it cannot authenticate before it starts anything, and a
// local profile is the one configuration that authenticates with nothing — so
// the gate has to ask about the profile rather than about the machine.
func TestLocalRunNeedsNoCredential(t *testing.T) {
	stub := newLocalStub(t, "qwen2.5:3b")
	profile := localTestProfile(t, stub.url(), "qwen2.5:3b")
	l := newOmpLauncher(&fakeProfiles{profile: profile})
	l.probe = noSandboxBackend
	l.auth = func() (ompAuth, error) {
		t.Error("a local run asked the auth broker for a credential")
		return ompAuth{}, errOmpNoCredential
	}
	if err := l.resolveCredential(profile.Ref); err != nil {
		t.Fatalf("resolving a local profile's credential: %v", err)
	}
	if l.redactor.active() {
		t.Error("a keyless run registered secrets to redact")
	}
	if !l.keyless {
		t.Error("the run did not record that it is keyless, so the launch would refuse it")
	}

	// A hosted profile on the same launcher still needs one: the exception is
	// the profile's, not the launcher's.
	strict := newOmpLauncher(&fakeProfiles{profile: testProfile()})
	strict.auth = func() (ompAuth, error) { return ompAuth{}, errOmpNoCredential }
	if err := strict.resolveCredential(testProfile().Ref); !errors.Is(err, errOmpNoCredential) {
		t.Fatalf("a hosted profile resolved without a credential: %v", err)
	}
}

// TestLocalRunReachesTheEndpointItRecorded is the round trip. The fake OMP does
// what a real one does first — ask the local engine what it serves — and the
// test asserts the address it was handed is the profile's, that something
// answered there, and that no provider credential travelled with it.
func TestLocalRunReachesTheEndpointItRecorded(t *testing.T) {
	stub := newLocalStub(t, "qwen2.5:3b")
	profile := localTestProfile(t, stub.url(), "qwen2.5:3b")
	l := newOmpLauncher(&fakeProfiles{profile: profile})
	l.probe = noSandboxBackend
	l.auth = func() (ompAuth, error) { return ompAuth{}, errOmpNoCredential }
	// Nothing ambient: an endpoint in the child's environment can only have
	// come from the profile, and an inherited one must not survive.
	l.environ = func() []string {
		return []string{"PATH=" + os.Getenv("PATH"), "OLLAMA_BASE_URL=http://127.0.0.1:9/decoy",
			"OLLAMA_HOST=127.0.0.1:9"}
	}
	run := serveFake(t, l, "localmodel", "")
	if run.err != nil || run.status != 0 {
		t.Fatalf("launching a local run: %d, %v", run.status, run.err)
	}
	if run.report.Privacy.Disclosure != disclosureLocal || run.report.Privacy.RedactionRequired {
		t.Errorf("the report's privacy = %+v, want a local disclosure needing no redaction", run.report.Privacy)
	}

	got := ompFakeRead(t, run.record)
	if got.ModelEndpoint != stub.url() {
		t.Errorf("the child was told the model is at %q, want the profile's %q", got.ModelEndpoint, stub.url())
	}
	if got.ModelReached != "200" {
		t.Errorf("the child's model-list request answered %q, want 200 from the recorded endpoint", got.ModelReached)
	}
	for _, entry := range got.Env {
		key, value, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "OMP_AUTH_BROKER") {
			t.Errorf("a keyless run handed the child %s", key)
		}
		if key == "OLLAMA_HOST" || (key == "OLLAMA_BASE_URL" && value != stub.url()) {
			t.Errorf("an inherited endpoint survived into the run: %s", entry)
		}
	}
}

// TestLocalRunBinaryWritesALocalReport drives the built executable the way a
// client does, over real pipes, with a local profile in its store and no
// broker credential anywhere in its environment.
//
// That last part is the whole point. Every other test here shares a process
// with the seam it drives; this one proves the launch's credential gate —
// which refuses a run it cannot authenticate before anything is launched —
// lets a local profile through, and that the runtime report a client builds
// its record around says local, costs nothing, and names the endpoint.
//
// The stream is not read: OMP itself is not on PATH here, so the launch ends
// as soon as the child cannot start, and what this test measures is the
// report the launch wrote before that and the reason it gave on stderr.
func TestLocalRunBinaryWritesALocalReport(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go toolchain on PATH to build the binary with")
	}
	binary := filepath.Join(t.TempDir(), "code")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		t.Fatalf("go build: %v", err)
	}

	stub := newLocalStub(t, "qwen2.5:3b")
	store := t.TempDir()
	t.Setenv(profileStateEnv, store)
	dials := model{local: discoverLocalLane(stub.url()), sel: map[string]string{
		localFacetKey: "qwen2.5:3b", "thinking": "minimal",
	}}
	minted, err := newProfileStore(store).save(describeLocalDials(dials, "local-e2e", "qwen2.5:3b"))
	if err != nil {
		t.Fatalf("minting the local profile the engine resolves: %v", err)
	}

	// A stand-in omp that announces itself and waits for stdin to close, so
	// the launch runs to a finished report on a machine with no omp.
	fakeOmp := filepath.Join(t.TempDir(), "omp")
	if err := os.WriteFile(fakeOmp, []byte("#!/bin/sh\necho '{\"type\":\"ready\",\"protocolVersion\":1}'\nwhile IFS= read -r line; do :; done\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	info := filepath.Join(t.TempDir(), "runtime.json")
	cmd := exec.Command(binary, "engine", "--profile", minted.ID, "--runtime-info", info)
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + t.TempDir(),
		"CODE_OMP=" + fakeOmp,
		profileStateEnv + "=" + store,
		"CODE_GENERATED=" + filepath.Join(t.TempDir(), "absent.plain"),
		"CODE_SELECTION_STATE=",
		"XDG_STATE_HOME=" + t.TempDir(),
		"CODE_RUNTIME_BROKER=",
		// No OMP_AUTH_BROKER_*, no vault manifest: a machine with nothing to
		// authenticate with, which is the machine this lane is for.
		"CODE_AUTH_VAULTS=",
		"CODE_AUTH_VAULTS_FILE=" + filepath.Join(t.TempDir(), "absent.json"),
	}
	cmd.Stdin = strings.NewReader("")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("code engine: %v (stderr: %s)", err, stderr.String())
	}
	if !strings.HasPrefix(stdout.String(), `{"type":"ready"`) {
		t.Errorf("stdout is not the child's stream: %q", stdout.String())
	}
	if strings.Contains(stderr.String(), errOmpNoCredential.Error()) {
		t.Errorf("a local run was refused for want of a credential: %s", stderr.String())
	}

	data, err := os.ReadFile(info)
	if err != nil {
		t.Fatalf("the launch wrote no runtime report: %v (stderr: %s)", err, stderr.String())
	}
	var report runtimeReport
	if err := json.Unmarshal(data, &report); err != nil {
		t.Fatalf("the runtime report does not parse: %v", err)
	}
	if report.Privacy.Disclosure != disclosureLocal || report.Privacy.RedactionRequired {
		t.Errorf("privacy = %+v, want a local disclosure needing no redaction", report.Privacy)
	}
	if report.Cost.InputPer1K != 0 || report.Cost.OutputPer1K != 0 {
		t.Errorf("cost = %+v, want zero for a model nobody bills for", report.Cost)
	}
	for key, want := range map[string]string{
		"provider":         localProvider,
		"model":            "qwen2.5:3b",
		localMetaEngine:    localEngineOllama,
		localMetaEndpoint:  stub.url(),
		localMetaCostBasis: localCostBasis,
	} {
		if report.Metadata[key] != want {
			t.Errorf("metadata[%q] = %q, want %q", key, report.Metadata[key], want)
		}
	}
	if report.Containment == nil || report.Containment.Escape == "" {
		t.Error("the report declared no containment, or one with no escape assumption")
	}
	if report.Finished == nil || !*report.Finished || report.ExitCode == nil {
		t.Errorf("the report was not finished with the child's status: %s", data)
	}
}

// ── the boundary ─────────────────────────────────────────────────────────────

// TestLocalRunEgressRelaysRatherThanAllows is the containment half. A hosted
// provider is a name on the internet and gets a CONNECT allowlist; a local
// endpoint is a socket on this host, which OMP would never send through a proxy
// and which does not exist inside the sandbox at all — so it is relayed, and
// the CONNECT allowlist is empty, which is the stronger boundary.
func TestLocalRunEgressRelaysRatherThanAllows(t *testing.T) {
	stub := newLocalStub(t, "qwen2.5:3b")
	profile := localTestProfile(t, stub.url(), "qwen2.5:3b")

	provider, policy, err := sandboxRunEgress(profile, "")
	if err != nil {
		t.Fatalf("resolving a local run's egress: %v", err)
	}
	if provider != localProvider {
		t.Errorf("provider = %q, want %q", provider, localProvider)
	}
	if len(policy.allowed) != 0 {
		t.Errorf("the CONNECT allowlist is %v, want nothing off this machine", policy.allowed)
	}
	if !policy.routed() {
		t.Fatal("a local policy claims no route at all, which would strand the analysis")
	}
	stubURL, err := url.Parse(stub.url())
	if err != nil {
		t.Fatal(err)
	}
	if policy.modelAddr != stubURL.Host {
		t.Errorf("the relay dials %q, want the endpoint's own %q", policy.modelAddr, stubURL.Host)
	}
	wantGuest := "http://127.0.0.1:" + strconv.Itoa(sandboxModelPort)
	if policy.modelURL != wantGuest {
		t.Errorf("the child inside would call %q, want the sandbox's own loopback %q", policy.modelURL, wantGuest)
	}

	// The host side of that relay, end to end: the socket the sandbox would
	// have bind-mounted carries a real request to the daemon.
	egress, err := newSandboxEgress(filepath.Join(t.TempDir(), "egress"), policy)
	if err != nil {
		t.Fatalf("opening a local run's egress: %v", err)
	}
	defer egress.close()
	if egress.modelSocket() == "" {
		t.Fatal("no model socket was opened for a local run")
	}
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", egress.modelSocket())
		},
	}}
	response, err := client.Get("http://relayed/api/tags")
	if err != nil {
		t.Fatalf("the relay did not carry the request: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("the relayed request answered %s", response.Status)
	}

	// And the CONNECT proxy beside it still refuses everything, which is what
	// makes an empty allowlist a boundary rather than a gap.
	status, err := sandboxDialConnect("unix", egress.proxySocket(), stubURL.Host)
	if err != nil {
		t.Fatalf("connecting to the run's proxy: %v", err)
	}
	if !strings.Contains(status, "403") {
		t.Errorf("the proxy answered %q for %s on a local run, want a refusal", status, stubURL.Host)
	}
}

// TestLocalRunEscapeStatementNamesTheRelay: a receipt has to say what a
// compromised worker still has. On a local run that is not a provider token —
// there is none — it is the daemon on this host, so the declaration names it
// instead of repeating a credential paragraph that would be false.
func TestLocalRunEscapeStatementNamesTheRelay(t *testing.T) {
	facts := sandboxFacts{
		backend:             sandboxBackendFull,
		filesystemIsolation: true,
		networkDefaultDeny:  true,
		resourceCeilings:    true,
		disposable:          true,
		ceilings:            defaultSandboxCeilings(),
	}
	local := facts.escape(sandboxEgressDescription{provider: localProvider, local: "127.0.0.1:11434"})
	for _, want := range []string{"127.0.0.1:11434", "no provider credential", "allowlist is empty",
		"no route to the network at large"} {
		if !strings.Contains(local, want) {
			t.Errorf("the local escape statement lacks %q:\n%s", want, local)
		}
	}
	if strings.Contains(local, "open a TLS tunnel to what is allowed") {
		t.Errorf("the local escape statement describes a tunnel to an empty allowlist:\n%s", local)
	}
	hosted := facts.escape(sandboxEgressDescription{
		provider: anthropicProvider, allowed: []string{"api.anthropic.com:443"},
	})
	if strings.Contains(hosted, "no provider credential") {
		t.Errorf("a hosted run's statement denies the credential inside the boundary:\n%s", hosted)
	}
	if !strings.Contains(hosted, "the provider credential is inside the boundary") {
		t.Errorf("a hosted run's statement no longer names the credential inside:\n%s", hosted)
	}
	if !strings.Contains(hosted, "open a TLS tunnel to what is allowed") {
		t.Errorf("a hosted run's statement no longer weighs the one route it has:\n%s", hosted)
	}
}

// TestLocalGuestBaseKeepsThePath: the relay splices bytes, so only the
// authority is the sandbox's. Anything the operator wrote after it still has to
// reach the daemon.
func TestLocalGuestBaseKeepsThePath(t *testing.T) {
	got, err := localGuestBase("http://192.168.1.10:8080/llm", 3130)
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://127.0.0.1:3130/llm" {
		t.Errorf("guest base = %q, want the path kept and the authority rewritten", got)
	}
	if _, err := localHostPort("http://192.168.1.10:8080/llm"); err != nil {
		t.Errorf("the host address of a private endpoint did not resolve: %v", err)
	}
}

// TestLocalThinkingIsClamped covers the level a receipt records. The endpoints
// this lane speaks to take no reasoning-effort parameter, so a profile must not
// record a level nobody will act on.
func TestLocalThinkingIsClamped(t *testing.T) {
	for _, level := range []string{"medium", "high", "xhigh", "max", "", "nonsense"} {
		if got := localThinking(level); got != "low" {
			t.Errorf("localThinking(%q) = %q, want the highest level this lane offers", level, got)
		}
	}
	for _, level := range localThinkingLevels {
		if got := localThinking(level); got != level {
			t.Errorf("localThinking(%q) = %q, want it kept", level, got)
		}
	}
}
