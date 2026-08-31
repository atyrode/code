package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// babelTestToken is the synthetic broker credential every worker-mode test
// plants. It must never come back out of the process, on either stream.
const babelTestToken = "babel-broker-token-3f8a1c"

// syncBuffer collects a stream written by the session goroutine and read by the
// test. The mutex is what makes reading it before the session exits safe.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// babelHarness drives a babelSession the way Babel drives the process: it owns
// the far end of both pipes. Events are decoded into generic maps rather than
// Code's own structs, so a test sees exactly what went over the wire — including
// the fields Code does not define.
type babelHarness struct {
	t      *testing.T
	stdin  *io.PipeWriter
	events chan map[string]any
	stdout *syncBuffer
	stderr *syncBuffer
	status chan int
}

func newBabelHarness(t *testing.T, opts babelOptions) *babelHarness {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	h := &babelHarness{
		t:      t,
		stdin:  inW,
		events: make(chan map[string]any, 64),
		stdout: &syncBuffer{},
		stderr: &syncBuffer{},
		status: make(chan int, 1),
	}
	go func() {
		defer close(h.events)
		scan := bufio.NewScanner(outR)
		scan.Buffer(make([]byte, 0, 64<<10), 8<<20)
		for scan.Scan() {
			line := append([]byte(nil), scan.Bytes()...)
			h.stdout.Write(append(line, '\n'))
			var decoded map[string]any
			if err := json.Unmarshal(line, &decoded); err != nil {
				decoded = map[string]any{"type": "<undecodable>", "raw": string(line)}
			}
			h.events <- decoded
		}
	}()
	go func() {
		status := newBabelSession(inR, outW, h.stderr).run(context.Background(), opts)
		outW.Close()
		h.status <- status
	}()
	t.Cleanup(func() { inW.Close() })
	return h
}

// next returns the next line the worker wrote. A timeout is a failure, not a
// hang: a worker that stops writing is a worker Babel would give up on.
func (h *babelHarness) next() map[string]any {
	h.t.Helper()
	select {
	case ev, ok := <-h.events:
		if !ok {
			h.t.Fatal("the worker closed stdout before writing the expected line")
		}
		return ev
	case <-time.After(20 * time.Second):
		h.t.Fatal("timed out waiting for the worker to write a line")
		return nil
	}
}

// drain collects every remaining line, so a test can assert that nothing
// followed the terminal event.
func (h *babelHarness) drain() []map[string]any {
	h.t.Helper()
	var rest []map[string]any
	for {
		select {
		case ev, ok := <-h.events:
			if !ok {
				return rest
			}
			rest = append(rest, ev)
		case <-time.After(20 * time.Second):
			h.t.Fatal("timed out waiting for the worker to close stdout")
			return rest
		}
	}
}

func (h *babelHarness) write(v any) {
	h.t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err := h.stdin.Write(append(data, '\n')); err != nil {
		h.t.Fatalf("writing to the worker: %v", err)
	}
}

// writeRaw writes a line verbatim, which is how a test sends fields Code's own
// structs cannot express.
func (h *babelHarness) writeRaw(line string) {
	h.t.Helper()
	if _, err := h.stdin.Write([]byte(line + "\n")); err != nil {
		h.t.Fatalf("writing to the worker: %v", err)
	}
}

func (h *babelHarness) wait() int {
	h.t.Helper()
	select {
	case status := <-h.status:
		return status
	case <-time.After(20 * time.Second):
		h.t.Fatal("the worker did not exit")
		return -1
	}
}

// expectHello reads and checks the opening line every run begins with.
func (h *babelHarness) expectHello() map[string]any {
	h.t.Helper()
	hello := h.next()
	if hello["type"] != babelMessageHello {
		h.t.Fatalf("first line is %v, want hello", hello["type"])
	}
	if hello["protocol"] != babelProtocolName {
		h.t.Errorf("hello names protocol %v", hello["protocol"])
	}
	worker, _ := hello["worker"].(map[string]any)
	if worker["name"] != babelWorkerName {
		h.t.Errorf("hello worker name = %v", worker["name"])
	}
	if version, _ := worker["version"].(string); version == "" {
		h.t.Error("hello reports no worker version; a run could not be attributed to a build")
	}
	modes := fmt.Sprint(hello["modes"])
	if !strings.Contains(modes, babelModeConfigure) || !strings.Contains(modes, babelModeWorker) {
		h.t.Errorf("hello advertises modes %v, want both", modes)
	}
	return hello
}

func babelAcceptLine(mode string) babelAccept {
	return babelAccept{
		Type: babelMessageAccept, Protocol: babelProtocolName,
		Version: babelProtocolVersion, Mode: mode,
		Limits: babelLimits{
			MaxLineBytes: 1 << 20, MaxEvents: 1000, MaxToolRequests: 16,
			IdleSeconds: 60, ExitGraceSecs: 5,
		},
	}
}

// babelTestJob mirrors the job Babel's conformance suite writes: one recipe, one
// source, a grant covering corpus search and repository reads but deliberately
// not sandbox execution, and a synthetic broker credential.
//
// The grant's tools mapping is part of the mirror and is spelled the way Babel
// spells it: corpus-search names the one operation Babel brokers, and repo-read
// gets no key at all, because Babel brokers no repository facility and a key
// with an empty array would say something different from saying nothing.
func babelTestJob(directive string) map[string]any {
	return map[string]any{
		"type":    babelMessageJob,
		"job_id":  "test-job",
		"run_id":  "test-run",
		"profile": map[string]any{"id": "synthetic-profile", "revision": 1},
		"recipes": []map[string]any{{"id": "outcome-integrity", "version": 1}},
		"grant": map[string]any{
			"capabilities": []string{babelCapabilityCorpusSearch, babelCapabilityRepoRead},
			"disclosure":   babelDisclosureLocal,
			"tools":        map[string][]string{babelCapabilityCorpusSearch: {"search"}},
		},
		"sources": []map[string]any{{"kind": "session", "selector": "omp/synthetic"}},
		"broker":  map[string]any{"endpoint": "http://127.0.0.1:1/evidence", "token": babelTestToken},
		"params":  map[string]string{babelParamConformance: directive},
	}
}

// isolateBabelEnv keeps a test off the developer's real catalog, selection,
// profile store and auth broker. The broker matters as much as the rest now
// that worker mode resolves a credential: a test that inherited the operator's
// exported broker variables would reach out to their real one.
func isolateBabelEnv(t *testing.T) string {
	t.Helper()
	store := t.TempDir()
	t.Setenv(babelProfileStateEnv, store)
	t.Setenv("CODE_GENERATED", filepath.Join(t.TempDir(), "absent.plain"))
	// An unset CODE_SELECTION_STATE now resolves to a location under
	// XDG_STATE_HOME, so relocating that root is what keeps a test off the
	// developer's real dials; the explicit "" here says "take the default" and
	// the default is now inside the sandbox.
	t.Setenv("CODE_SELECTION_STATE", "")
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	t.Setenv("CODE_RUNTIME_BROKER", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("OMP_AUTH_BROKER_URL", "")
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "")
	t.Setenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE", "")
	t.Setenv("CODE_AUTH_VAULTS", "")
	t.Setenv("CODE_AUTH_VAULTS_FILE", "")
	t.Setenv("CODE_AUTH_ACCOUNT_STATE", "")
	return store
}

// babelProductionJob is babelTestJob without the conformance directive and
// naming a profile the store actually holds. The directive is what routes a run
// away from OMP, so a job that has to reach the real path must carry none.
func babelProductionJob(id string, revision int) map[string]any {
	job := babelTestJob("")
	delete(job, "params")
	job["profile"] = map[string]any{"id": id, "revision": revision}
	return job
}

func conformanceOpts() babelOptions {
	return babelOptions{
		profileID:    defaultBabelProfileID,
		investigator: babelInvestigatorConformance,
	}
}

// babelTurnedDials builds the model a ceremony hands to the store: the catalog's
// dials with the named ones turned, repaired and clamped exactly as the
// interactive UI does it.
//
// It stands in for the operator's hands, so it only accepts a value some dial
// actually offers: cycling a facet moves between its own values, and the
// persisted position is filtered through the same list on load, so a value no
// dial carries is not a state the ceremony can reach. It replaces
// babelResolveDials, which took its dials from argv and the environment — the
// two sources atyrode/babel#86 removed, because a profile either of them minted
// is one no operator confirmed.
func babelTurnedDials(t *testing.T, dials map[string]string) model {
	t.Helper()
	m := babelCatalogModel()
	for key, value := range dials {
		if !slices.ContainsFunc(m.facets, func(f facet) bool {
			return f.key == key && slices.Contains(f.values, value)
		}) {
			t.Fatalf("no dial %q offers %q, so no ceremony could confirm it", key, value)
		}
		m.sel[key] = value
	}
	repairSelectionSpecials(m.sel)
	m.clampSel()
	return m
}

// babelMintedProfile stores one revision the way a confirmed ceremony does, for
// the tests whose subject is what happens to a profile that already exists.
func babelMintedProfile(t *testing.T, id string, dials map[string]string) codeProfile {
	t.Helper()
	saved, err := babelMintProfile(babelTurnedDials(t, dials), id)
	if err != nil {
		t.Fatalf("minting profile %s: %v", id, err)
	}
	return saved
}

// ── handshake ────────────────────────────────────────────────────────────────

// TestBabelHelloPrecedesAnyRead is the rule that makes the whole boundary work:
// Babel must be able to refuse an incompatible counterpart before any job
// material — and therefore any credential — is written to this process. stdin
// here never produces a byte, so a worker that read before it spoke would block
// forever and this test would time out rather than pass.
func TestBabelHelloPrecedesAnyRead(t *testing.T) {
	isolateBabelEnv(t)
	silent, silentW := io.Pipe()
	t.Cleanup(func() { silentW.Close() })
	outR, outW := io.Pipe()

	go func() {
		newBabelSession(silent, outW, io.Discard).run(context.Background(), conformanceOpts())
		outW.Close()
	}()

	line := make(chan string, 1)
	go func() {
		scan := bufio.NewScanner(outR)
		if scan.Scan() {
			line <- scan.Text()
		}
		close(line)
	}()
	select {
	case got, ok := <-line:
		if !ok {
			t.Fatal("the worker wrote nothing before reading stdin")
		}
		var hello babelHello
		if err := json.Unmarshal([]byte(got), &hello); err != nil {
			t.Fatalf("first line is not a hello: %v (%s)", err, got)
		}
		if hello.Type != babelMessageHello || hello.Protocol != babelProtocolName {
			t.Errorf("first line = %+v", hello)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the worker read stdin before writing hello")
	}
}

// TestBabelRefusalIsFinal covers the other half of the handshake: a refused
// worker emits nothing further and exits, rather than waiting for a job that
// will never arrive.
func TestBabelRefusalIsFinal(t *testing.T) {
	isolateBabelEnv(t)
	h := newBabelHarness(t, conformanceOpts())
	h.expectHello()
	h.write(babelRefuse{
		Type: babelMessageRefuse, Protocol: babelProtocolName,
		Reason: "no mutually supported protocol version", Supported: []int{9001},
	})

	if rest := h.drain(); len(rest) != 0 {
		t.Errorf("a refused worker emitted %d further events: %v", len(rest), rest)
	}
	if status := h.wait(); status == 0 {
		t.Error("a refused worker exited 0")
	}
	if !strings.Contains(h.stderr.String(), "no mutually supported protocol version") {
		t.Errorf("the refusal reason never reached stderr: %q", h.stderr.String())
	}
}

// TestBabelHandshakeRejections covers the answers this worker must not act on.
// Babel would not send them, but a worker that trusted them would run a job it
// cannot speak the protocol for.
func TestBabelHandshakeRejections(t *testing.T) {
	cases := []struct {
		name string
		line string
	}{
		{"wrong protocol", `{"type":"accept","protocol":"something.else","version":1,"mode":"worker"}`},
		{"unsupported version", `{"type":"accept","protocol":"babel.analysis-worker","version":9001,"mode":"worker"}`},
		{"unadvertised mode", `{"type":"accept","protocol":"babel.analysis-worker","version":1,"mode":"teleport"}`},
		{"not a handshake", `{"type":"job","job_id":"j"}`},
		{"not json", `this is not a line babel would write`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			isolateBabelEnv(t)
			h := newBabelHarness(t, conformanceOpts())
			h.expectHello()
			h.writeRaw(tc.line)
			if rest := h.drain(); len(rest) != 0 {
				t.Errorf("the worker emitted %d events after a bad handshake: %v", len(rest), rest)
			}
			if status := h.wait(); status != 2 {
				t.Errorf("exit status = %d, want 2 for a broken handshake", status)
			}
		})
	}
}

// ── configure mode ───────────────────────────────────────────────────────────

// TestBabelConfigureMode checks what Babel persists: exactly one configuration
// message, a reference it can re-resolve, non-secret metadata, and an exit —
// configure mode promises not to launch anything, and a process that keeps
// running has.
//
// The profile is minted first, by hand, because that is now the only way one
// exists: this mode reports the configuration an operator confirmed in the
// ceremony and has no way to produce one of its own (atyrode/babel#86).
func TestBabelConfigureMode(t *testing.T) {
	store := isolateBabelEnv(t)
	minted := babelMintedProfile(t, "code", map[string]string{"thinking": "high"})

	h := newBabelHarness(t, babelOptions{profileID: "code"})
	h.expectHello()
	h.write(babelAcceptLine(babelModeConfigure))

	event := h.next()
	if event["type"] != babelMessageConfiguration {
		t.Fatalf("configure mode answered with %v", event["type"])
	}
	if _, ok := event["seq"]; ok {
		t.Error("configure mode carries a seq; there is no stream to order")
	}
	profile, _ := event["profile"].(map[string]any)
	if profile["id"] != "code" {
		t.Errorf("configuration reports profile id %v, want code", profile["id"])
	}
	revision, _ := profile["revision"].(float64)
	if revision < 1 {
		t.Errorf("profile revision = %v, want a positive revision Babel can record", profile["revision"])
	}
	if int(revision) != minted.Revision {
		t.Errorf("configure mode reported revision %v, want the minted %d — it must report the "+
			"configuration that exists, not one of its own", profile["revision"], minted.Revision)
	}
	privacy, _ := event["privacy"].(map[string]any)
	switch privacy["disclosure"] {
	case babelDisclosureLocal, babelDisclosureHosted:
	default:
		t.Errorf("disclosure = %v, want local or hosted", privacy["disclosure"])
	}
	metadata, _ := event["metadata"].(map[string]any)
	if len(metadata) == 0 {
		t.Fatal("configuration reports no metadata; a receipt requires provider/model metadata")
	}
	if metadata["thinking"] != "high" {
		t.Errorf("the confirmed dials did not reach the configuration: %v", metadata)
	}
	if names := secretShapedMetadataKeys(metadata); len(names) > 0 {
		t.Errorf("configuration metadata declares credential-shaped keys %v", names)
	}
	if _, ok := event["containment"]; ok {
		t.Error("configure mode declared containment; nothing runs, so there is nothing to contain")
	}

	if rest := h.drain(); len(rest) != 0 {
		t.Errorf("configure mode emitted %d further messages: %v", len(rest), rest)
	}
	if status := h.wait(); status != 0 {
		t.Errorf("configure mode exited %d, want 0", status)
	}

	// The reference it reported resolves in the store it read.
	saved, err := newProfileStore(store).load("code", int(revision))
	if err != nil {
		t.Fatalf("the reported reference does not resolve: %v", err)
	}
	if saved.Selection["thinking"] != "high" {
		t.Errorf("saved selection = %v", saved.Selection)
	}
	// And reporting it minted nothing: the history Babel holds references into
	// is exactly as long as the number of ceremonies that produced it.
	if latest, err := newProfileStore(store).latestRevision("code"); err != nil || latest != minted.Revision {
		t.Errorf("after reporting, latest revision = %d (%v), want the minted %d — configure mode "+
			"wrote a revision of its own", latest, err, minted.Revision)
	}
}

// secretShapedMetadataKeys is the assertion form of secretShapedMetadata for the
// generic maps a decoded event carries.
func secretShapedMetadataKeys(metadata map[string]any) []string {
	flat := make(map[string]string, len(metadata))
	for key, value := range metadata {
		flat[key] = fmt.Sprint(value)
	}
	return secretShapedMetadata(flat)
}

// TestBabelConfigureModeWithoutACeremony is the refusal that replaces the old
// fallback. A worker whose store is empty has no configuration to report, and
// the three sources it used to fall back to — an argument, an environment
// variable, Code's compiled defaults — each produced a profile that a receipt
// would attribute to an operator who never saw it. So it says so, names the
// ceremony, writes no configuration event and mints nothing.
func TestBabelConfigureModeWithoutACeremony(t *testing.T) {
	store := isolateBabelEnv(t)
	h := newBabelHarness(t, babelOptions{profileID: "code"})
	h.expectHello()
	h.write(babelAcceptLine(babelModeConfigure))

	if rest := h.drain(); len(rest) != 0 {
		t.Errorf("an unconfigured worker answered with %v; it has no configuration to report", rest)
	}
	if status := h.wait(); status == 0 {
		t.Error("an unconfigured worker exited 0 without reporting a configuration")
	}
	if diagnostics := h.stderr.String(); !strings.Contains(diagnostics, "babel analysis profile configure") {
		t.Errorf("the refusal does not name the ceremony that produces a configuration: %q", diagnostics)
	}
	if latest, err := newProfileStore(store).latestRevision("code"); err != nil || latest != 0 {
		t.Errorf("latest revision = %d (%v), want none: an unconfigured worker must not mint one",
			latest, err)
	}
}

// TestBabelConfigureModeIsIdempotent checks the revision rule end to end: two
// configure runs against the same confirmed dials must report the same
// reference, because Babel records it and a gratuitous bump invalidates nothing
// but its own history.
func TestBabelConfigureModeIsIdempotent(t *testing.T) {
	isolateBabelEnv(t)
	babelMintedProfile(t, "code", nil)
	run := func() (string, float64) {
		h := newBabelHarness(t, babelOptions{profileID: "code"})
		h.expectHello()
		h.write(babelAcceptLine(babelModeConfigure))
		event := h.next()
		h.drain()
		if status := h.wait(); status != 0 {
			t.Fatalf("configure exited %d", status)
		}
		profile, _ := event["profile"].(map[string]any)
		id, _ := profile["id"].(string)
		revision, _ := profile["revision"].(float64)
		return id, revision
	}
	firstID, firstRevision := run()
	secondID, secondRevision := run()
	if firstID != secondID || firstRevision != secondRevision {
		t.Errorf("two identical configure runs reported %s@%v then %s@%v",
			firstID, firstRevision, secondID, secondRevision)
	}
}

// TestBabelWorkerTakesNoDialsFromTheEnvironment is the deletion, asserted. The
// worker-side dial model used to seed itself from the persisted selection, which
// made CODE_SELECTION_STATE — a variable any process in the tree can set — a
// channel into what a run launches. Nothing reads it now: the only dials this
// process may act on are the ones a stored profile carries.
//
// Both locations are planted, because there were two: the override the variable
// names and the default location the old fallback read when it was absent.
func TestBabelWorkerTakesNoDialsFromTheEnvironment(t *testing.T) {
	isolateBabelEnv(t)
	t.Setenv("CODE_GENERATED", babelCatalogFixture(t))

	planted := `{"lane":"claude-led","model":"fast","thinking":"low","advisor":"off"}`
	writeSelectionFixture(t, defaultSelectionStatePath(), planted)
	override := filepath.Join(t.TempDir(), "selection.json")
	writeSelectionFixture(t, override, planted)
	t.Setenv(codeSelectionStateEnv, override)

	m := babelCatalogModel()
	defaults := defaultSel()
	for _, key := range []string{"lane", "model", "thinking", "advisor"} {
		if m.sel[key] != defaults[key] {
			t.Errorf("dial %s = %q, want the compiled default %q: a planted selection reached "+
				"the worker's dial model", key, m.sel[key], defaults[key])
		}
	}
	// Non-vacuity: the fixture really does hold dials that differ from the
	// defaults, so reading it would have been visible above.
	if !strings.Contains(planted, `"lane":"claude-led"`) || defaults["lane"] == "claude-led" {
		t.Fatal("the planted selection matches the defaults, so this test could not fail")
	}

	// And a stored profile still replays exactly: the compiled default is a map
	// for applyCatalog to clamp, never a dial anything acts on.
	stored := babelMintedProfile(t, "code", map[string]string{"lane": "ds-led", "thinking": "high"})
	overlay, err := profileOverlay(stored)
	if err != nil {
		t.Fatalf("profileOverlay: %v", err)
	}
	if !strings.Contains(overlay, "defaultThinkingLevel: high\n") {
		t.Errorf("the replayed overlay lost the profile's own dials:\n%s", overlay)
	}
}

// TestBabelWorkerRunsAProfileWithNoCatalogPosition is the honest half of having
// no dial source: a worker that has never seen a selection file still resolves
// the profile it was told to run, because everything it needs is in the stored
// revision.
func TestBabelWorkerRunsAProfileWithNoCatalogPosition(t *testing.T) {
	isolateBabelEnv(t)
	m := babelTurnedDials(t, nil)
	defaults := defaultSel()
	for _, key := range []string{"lane", "model", "thinking"} {
		if m.sel[key] != defaults[key] {
			t.Errorf("dial %s = %q, want the default %q", key, m.sel[key], defaults[key])
		}
	}
	profile := babelDescribeDials(m, "code")
	if profile.Metadata["provider"] == "" || profile.Metadata["model"] == "" {
		t.Errorf("metadata leaves provider or model unnamed: %v", profile.Metadata)
	}
	if names := secretShapedMetadata(profile.Metadata); len(names) > 0 {
		t.Errorf("described dials declare credential-shaped keys %v", names)
	}
}

// TestBabelDescribesTheDialsAsConfirmed pins what a minted profile records: the
// dials as they stand in the model that was on screen, and the provider and
// combination they resolve to. A receipt that reported anything else would
// describe a run that never happened.
func TestBabelDescribesTheDialsAsConfirmed(t *testing.T) {
	isolateBabelEnv(t)
	t.Setenv("CODE_GENERATED", babelCatalogFixture(t))

	m := babelTurnedDials(t, map[string]string{"lane": "claude-led", "model": "fast", "thinking": "low"})
	profile := babelDescribeDials(m, "code")
	for _, key := range []string{"lane", "thinking"} {
		if profile.Metadata[key] != m.sel[key] {
			t.Errorf("metadata reports %s = %q, want the confirmed %q",
				key, profile.Metadata[key], m.sel[key])
		}
	}
	if got := profile.Metadata["provider"]; got == "openai-codex" || got == "unresolved" {
		t.Errorf("metadata provider = %q, want the Anthropic-led lane's provider", got)
	}
	if got := profile.Metadata["combo"]; !strings.HasPrefix(got, "claude-led_fast_low_") {
		t.Errorf("metadata combo = %q, want the cheapest Anthropic-led combo", got)
	}
	if profile.ComboID != comboID(m.sel, m.hasRelief) {
		t.Errorf("combo id = %q, want the confirmed selection's own %q",
			profile.ComboID, comboID(m.sel, m.hasRelief))
	}

	// A value no dial offers cannot reach a profile, because it cannot reach the
	// UI: a persisted position is filtered through each facet's own values on
	// load, and cycling a dial only ever lands on one of them. So the clamping
	// question a profile can actually pose is about combinations, not values.
	writeSelectionFixture(t, defaultSelectionStatePath(),
		`{"lane":"moon-led","model":"fast","thinking":"telepathic","advisor":"off"}`)
	loaded := loadSelectionState(defaultSelectionStatePath(), m.facets)
	if loaded["lane"] == "moon-led" || loaded["thinking"] == "telepathic" {
		t.Errorf("a value no dial offers survived the load: %v", loaded)
	}
	if loaded["model"] != "fast" || loaded["advisor"] != "off" {
		t.Errorf("the load dropped values the dials do offer: %v", loaded)
	}
}

// babelCatalogFixture renders the three-pool catalog the launch overlay tests
// use, so the overlay a profile replays is built from a real catalog rather than
// a hand-written approximation of one.
func babelCatalogFixture(t *testing.T) string {
	t.Helper()
	c, err := catalogFrom(t, fixtureYMLDeepSeek)
	if err != nil {
		t.Fatalf("catalogFrom: %v", err)
	}
	path := filepath.Join(t.TempDir(), "generated.plain")
	if err := os.WriteFile(path, []byte(c.renderCatalog()), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestBabelProfileOverlay is what makes a saved reference worth recording: the
// profile has to render the same omp overlay months later that the dials
// rendered when it was saved, and a catalog that can no longer serve it has to
// say so instead of handing omp a session with no routing.
func TestBabelProfileOverlay(t *testing.T) {
	isolateBabelEnv(t)
	t.Setenv("CODE_GENERATED", babelCatalogFixture(t))

	m := babelTurnedDials(t, map[string]string{"lane": "ds-led", "thinking": "high", "advisor": "audit"})
	saved, err := babelMintProfile(m, "code")
	if err != nil {
		t.Fatalf("minting the confirmed dials: %v", err)
	}
	if saved.Metadata["provider"] != "deepseek" {
		t.Errorf("metadata provider = %q, want the lane's leading provider", saved.Metadata["provider"])
	}

	overlay, err := profileOverlay(saved)
	if err != nil {
		t.Fatalf("profileOverlay: %v", err)
	}
	if overlay != m.genConfigYAML() {
		t.Errorf("the replayed overlay differs from the one the dials rendered:\n%s\n---\n%s",
			overlay, m.genConfigYAML())
	}
	for _, want := range []string{"modelRoles:\n", "  default: deepseek/", "defaultThinkingLevel: high\n"} {
		if !strings.Contains(overlay, want) {
			t.Errorf("overlay lacks %q:\n%s", want, overlay)
		}
	}
	// Nothing probes omp's version in a worker, so the 17.3-only key stays out:
	// an older omp hard-errors on it, and omitting it is the safe direction.
	if strings.Contains(overlay, "agentAdvisor") {
		t.Errorf("overlay emitted a version-gated key with no probed version:\n%s", overlay)
	}

	t.Run("a combination the catalog no longer generates", func(t *testing.T) {
		stale := saved
		stale.Selection = map[string]string{
			"lane": "ds-led", "model": "smart", "thinking": "telepathic",
			"spark": "off", "fable": "off", "main": "off", "advisor": "off", "relief": "on",
		}
		if _, err := profileOverlay(stale); err == nil {
			t.Error("profileOverlay rendered an overlay for a combination the catalog does not carry")
		}
	})

	t.Run("a profile with no selection", func(t *testing.T) {
		if _, err := profileOverlay(codeProfile{ID: "code", Revision: 1}); err == nil {
			t.Error("profileOverlay rendered an overlay from nothing")
		}
	})
}

// TestBabelSyntheticPathIsConformanceOnly pins where the contract's one
// exception applies. babelwire.go's resolve seam is resolve-or-fail and never
// sees the job, so the protocol layer is the only place that can tell a
// conformance obligation — which names a synthetic profile on purpose — from a
// production job naming a profile that is simply missing.
func TestBabelSyntheticPathIsConformanceOnly(t *testing.T) {
	t.Run("a conformance job takes the synthetic path", func(t *testing.T) {
		isolateBabelEnv(t)
		stream := runBabelWorkerStream(t, babelTestJob(babelConformanceWellBehaved), nil)
		stream.check(t)
		metadata, _ := stream.events[0]["metadata"].(map[string]any)
		if metadata["conformance"] != babelConformanceWellBehaved {
			t.Errorf("the configuration did not come from the synthetic path: %v", metadata)
		}
	})

	t.Run("a production job must resolve or fail", func(t *testing.T) {
		isolateBabelEnv(t)
		job := babelTestJob(babelConformanceWellBehaved)
		// No conformance parameter at all: this is what a real Babel run looks
		// like, and the stub owns no store, so it must refuse rather than echo a
		// reference it cannot back.
		delete(job, "params")
		stream := runBabelWorkerStream(t, job, nil)
		stream.check(t)
		if kind, _ := stream.terminal["type"].(string); kind != babelMessageError {
			t.Fatalf("terminal event is %q, want an error", kind)
		}
		if code, _ := stream.terminal["code"].(string); code != babelErrProfileUnavailable {
			t.Errorf("error code = %q, want %q", code, babelErrProfileUnavailable)
		}
		if len(stream.events) != 1 {
			t.Errorf("a run that never resolved a profile emitted %d events: %v",
				len(stream.events), stream.types())
		}
	})
}

// ── worker mode ──────────────────────────────────────────────────────────────

// babelStream is a recorded worker-mode event stream plus the checks every
// stream must pass, so each obligation test asserts its own point rather than
// re-deriving the invariants.
type babelStream struct {
	events   []map[string]any
	terminal map[string]any
	status   int
}

func (s babelStream) types() []string {
	out := make([]string, 0, len(s.events))
	for _, ev := range s.events {
		kind, _ := ev["type"].(string)
		out = append(out, kind)
	}
	return out
}

// check enforces the stream rules Babel enforces: the first event is the
// configuration, seq starts at 1 and strictly increases across every event type,
// there is exactly one terminal event, and nothing follows it.
//
// The one exemption is Babel's own: an error may be the first event, because a
// run that fails before it can resolve a profile still owes a terminal event
// (internal/worker/worker.go requires sawConfig for progress, tool-request and
// result, but not for error).
func (s babelStream) check(t *testing.T) {
	t.Helper()
	if len(s.events) == 0 {
		t.Fatal("the worker emitted no events")
	}
	switch kind, _ := s.events[0]["type"].(string); kind {
	case babelMessageConfiguration, babelMessageError:
	default:
		t.Errorf("first event is %q, want the resolved configuration or a terminal error", kind)
	}
	last := 0
	terminals := 0
	for i, ev := range s.events {
		kind, _ := ev["type"].(string)
		seq, ok := ev["seq"].(float64)
		if !ok {
			t.Fatalf("event %d (%s) carries no seq", i, kind)
		}
		if int(seq) <= last {
			t.Errorf("event %d (%s) has seq %v, which does not follow %d", i, kind, seq, last)
		}
		last = int(seq)
		if kind == babelMessageResult || kind == babelMessageError {
			terminals++
			if i != len(s.events)-1 {
				t.Errorf("event %d is terminal (%s) but %d events follow it", i, kind, len(s.events)-i-1)
			}
		}
	}
	if first, _ := s.events[0]["seq"].(float64); first != 1 {
		t.Errorf("the first event has seq %v, want 1", first)
	}
	if terminals != 1 {
		t.Errorf("the stream has %d terminal events, want exactly 1: %v", terminals, s.types())
	}
}

// runBabelWorkerStream drives one worker-mode run. respond answers each
// tool-request; nil denies nothing because nothing is asked.
func runBabelWorkerStream(t *testing.T, job map[string]any, respond func(requestID string) any) babelStream {
	t.Helper()
	h := newBabelHarness(t, conformanceOpts())
	h.expectHello()
	h.write(babelAcceptLine(babelModeWorker))
	h.write(job)

	var stream babelStream
	for {
		ev, ok := <-h.events
		if !ok {
			break
		}
		stream.events = append(stream.events, ev)
		kind, _ := ev["type"].(string)
		switch kind {
		case babelMessageToolRequest:
			if respond == nil {
				t.Fatalf("the worker asked for a tool this test does not answer: %v", ev)
			}
			id, _ := ev["request_id"].(string)
			if id == "" {
				t.Fatal("tool-request carries no request_id, so it could not be answered")
			}
			h.write(respond(id))
		case babelMessageResult, babelMessageError:
			stream.terminal = ev
		}
	}
	stream.status = h.wait()
	// Nothing this worker wrote, on either stream, may contain the credential
	// the job carried. Checked on every run rather than once, because a leak is
	// the one failure that must be impossible instead of merely unlikely.
	if strings.Contains(h.stdout.String(), babelTestToken) {
		t.Error("the broker credential appeared on stdout")
	}
	if strings.Contains(h.stderr.String(), babelTestToken) {
		t.Errorf("the broker credential appeared on stderr: %q", h.stderr.String())
	}
	return stream
}

func allowDecision(requestID string) any {
	return babelDecision{Type: babelMessageToolDecision, RequestID: requestID, Decision: babelDecisionAllow}
}

func denyDecision(requestID string) any {
	return babelDecision{
		Type: babelMessageToolDecision, RequestID: requestID, Decision: babelDecisionDeny,
		Code: "policy", Reason: "the test's policy denies this request",
	}
}

// TestBabelWorkerWellBehaved is the baseline stream: configuration first,
// progress as work happens, exactly one result, exit 0.
func TestBabelWorkerWellBehaved(t *testing.T) {
	isolateBabelEnv(t)
	stream := runBabelWorkerStream(t, babelTestJob(babelConformanceWellBehaved), nil)
	stream.check(t)

	if kind, _ := stream.terminal["type"].(string); kind != babelMessageResult {
		t.Fatalf("terminal event is %q, want a result", kind)
	}
	if status, _ := stream.terminal["status"].(string); status != babelStatusOK {
		t.Errorf("result status = %q", status)
	}
	if stream.status != 0 {
		t.Errorf("exit status = %d, want 0 after a result", stream.status)
	}
	progress := 0
	for _, kind := range stream.types() {
		if kind == babelMessageProgress {
			progress++
		}
	}
	if progress == 0 {
		t.Error("no progress event; Babel cannot keep an interface responsive without them")
	}

	// Worker mode must declare the boundary the work runs behind, and the
	// escape assumption may not be empty.
	containment, _ := stream.events[0]["containment"].(map[string]any)
	if containment == nil {
		t.Fatal("the configuration declares no containment")
	}
	if backend, _ := containment["backend"].(string); strings.TrimSpace(backend) == "" {
		t.Error("containment names no backend")
	}
	if escape, _ := containment["escape"].(string); strings.TrimSpace(escape) == "" {
		t.Error("containment states no escape assumption")
	}
	// The configuration must name the profile the job named.
	profile, _ := stream.events[0]["profile"].(map[string]any)
	if profile["id"] != "synthetic-profile" {
		t.Errorf("the configuration resolved profile %v, not the one the job named", profile["id"])
	}
}

// TestBabelWorkerDenialIsNotTerminal is the obligation a worker most easily gets
// wrong: Babel denies a request outside the run's grant before it consults any
// policy, so a denial is a normal outcome the investigation adapts to and the
// run must still deliver a terminal event.
func TestBabelWorkerDenialIsNotTerminal(t *testing.T) {
	isolateBabelEnv(t)
	for _, tc := range []struct {
		name    string
		respond func(string) any
		want    string
	}{
		{"allowed", allowDecision, babelDecisionAllow},
		{"denied", denyDecision, babelDecisionDeny},
	} {
		t.Run(tc.name, func(t *testing.T) {
			isolateBabelEnv(t)
			stream := runBabelWorkerStream(t, babelTestJob(babelConformanceRequestTool), tc.respond)
			stream.check(t)

			requests := 0
			for _, kind := range stream.types() {
				if kind == babelMessageToolRequest {
					requests++
				}
			}
			if requests != 1 {
				t.Fatalf("the run made %d tool requests, want 1: %v", requests, stream.types())
			}
			if kind, _ := stream.terminal["type"].(string); kind != babelMessageResult {
				t.Fatalf("terminal event is %q, want a result: a decision must not end the run", kind)
			}
			payload, _ := json.Marshal(stream.terminal["payload"])
			if !strings.Contains(string(payload), tc.want) {
				t.Errorf("the result does not report the %s decision it received: %s", tc.want, payload)
			}
			if stream.status != 0 {
				t.Errorf("exit status = %d, want 0 after a result", stream.status)
			}
		})
	}
}

// TestBabelWorkerRequestsTheToolNameTheJobPublished is the outermost assertion
// of the fix: not the constant the worker holds, but the "tool" field of the
// message it actually writes to Babel.
//
// The name is Babel's to state. A worker that chose its own got every request
// denied with `corpus-search has no tool "babel_corpus_search"` and delivered a
// run with no retrievals, no observations and no hypotheses, while the
// conformance suite scored it full marks — so the emitted string is what has to
// be checked here, and checking it against the grant the job carried is what
// makes the two repositories unable to drift apart again.
func TestBabelWorkerRequestsTheToolNameTheJobPublished(t *testing.T) {
	isolateBabelEnv(t)

	toolRequest := func(t *testing.T, stream babelStream) map[string]any {
		t.Helper()
		for _, event := range stream.events {
			if kind, _ := event["type"].(string); kind == babelMessageToolRequest {
				return event
			}
		}
		t.Fatalf("the run wrote no tool-request at all: %v", stream.types())
		return nil
	}

	t.Run("published", func(t *testing.T) {
		isolateBabelEnv(t)
		stream := runBabelWorkerStream(t, babelTestJob(babelConformanceRequestTool), allowDecision)
		stream.check(t)

		request := toolRequest(t, stream)
		if request["capability"] != babelCapabilityCorpusSearch {
			t.Errorf("capability = %v; want %q", request["capability"], babelCapabilityCorpusSearch)
		}
		// The job published exactly ["search"] for corpus-search, so that is the
		// only string Babel will serve and the only one this may be.
		if request["tool"] != "search" {
			t.Errorf("tool = %v; the job published [\"search\"] and Babel denies anything else",
				request["tool"])
		}
		payload, _ := json.Marshal(stream.terminal["payload"])
		var report conformanceReport
		if err := json.Unmarshal(payload, &report); err != nil {
			t.Fatalf("payload does not decode: %v", err)
		}
		if report.ToolName != "search" || report.ToolNameSource != ompToolNamePublished {
			t.Errorf("report = %+v; a receipt must say the name came out of the grant", report)
		}
	})

	t.Run("unpublished", func(t *testing.T) {
		isolateBabelEnv(t)
		// A Babel predating the mapping. The worker still asks, because a run
		// that refuses to ask reaches the same zero-evidence receipt from the
		// other direction — but the payload has to say the name was its own.
		job := babelTestJob(babelConformanceRequestTool)
		grant, _ := job["grant"].(map[string]any)
		delete(grant, "tools")
		stream := runBabelWorkerStream(t, job, allowDecision)
		stream.check(t)

		if got := toolRequest(t, stream)["tool"]; got != "search" {
			t.Errorf("tool = %v; want the operation the worker implements", got)
		}
		payload, _ := json.Marshal(stream.terminal["payload"])
		var report conformanceReport
		if err := json.Unmarshal(payload, &report); err != nil {
			t.Fatalf("payload does not decode: %v", err)
		}
		if report.ToolNameSource != ompToolNameUnpublished {
			t.Errorf("tool_name_source = %q; want %q, so the fallback cannot be silent",
				report.ToolNameSource, ompToolNameUnpublished)
		}
	})

	t.Run("published nothing", func(t *testing.T) {
		isolateBabelEnv(t)
		// Babel spoke and named nothing for the capability it granted. That is
		// an answer, not a silence, so there is no fallback and no request.
		job := babelTestJob(babelConformanceRequestTool)
		grant, _ := job["grant"].(map[string]any)
		grant["tools"] = map[string][]string{babelCapabilityCorpusSearch: {}}
		stream := runBabelWorkerStream(t, job, allowDecision)
		stream.check(t)

		for _, kind := range stream.types() {
			if kind == babelMessageToolRequest {
				t.Fatalf("the run requested a tool Babel published none for: %v", stream.events)
			}
		}
		if kind, _ := stream.terminal["type"].(string); kind != babelMessageResult {
			t.Errorf("terminal event is %q; having nothing to ask for is not a failure", kind)
		}
		payload, _ := json.Marshal(stream.terminal["payload"])
		if !strings.Contains(string(payload), ompToolNamePublished) {
			t.Errorf("the payload does not say why no request was made: %s", payload)
		}
	})
}

// TestBabelWorkerReadsTheEvidenceServedWithADecision is the wire-level half of
// the payload change: the decision is written to this process's stdin as bytes,
// exactly as Babel writes it, and the assertion is on the terminal result the
// process wrote back. Nothing here constructs a babelDecision in memory, so it
// grades the decode rather than the struct.
func TestBabelWorkerReadsTheEvidenceServedWithADecision(t *testing.T) {
	isolateBabelEnv(t)

	const digest = "5c0b7e3a19d84f26bc35a7018e4d9f2036b1c8ea75d40f93a2617cb8e05d3f4a"
	served := func(requestID string) any {
		return babelDecision{
			Type: babelMessageToolDecision, RequestID: requestID, Decision: babelDecisionAllow,
			Reason: "served 1 hit from the corpus index",
			Results: json.RawMessage(`{"schema":"babel.corpus-search/1","query":"probe","limit":10,` +
				`"hits":[{"harness":"omp","source_id":"session-` + babelTestNonce + `","index":42,` +
				`"kind":"tool-observation","excerpt":"the archive says ` + babelTestNonce + `",` +
				`"truncated":false,"locator":{"path":"sessions/omp/` + babelTestNonce + `.jsonl",` +
				`"line":12,"byte_offset":3456,"digest":"` + digest + `"}}]}`),
		}
	}

	t.Run("served", func(t *testing.T) {
		isolateBabelEnv(t)
		stream := runBabelWorkerStream(t, babelTestJob(babelConformanceEchoEvidence), served)
		stream.check(t)

		payload, _ := json.Marshal(stream.terminal["payload"])
		var report conformanceReport
		if err := json.Unmarshal(payload, &report); err != nil {
			t.Fatalf("payload does not decode: %v", err)
		}
		if report.ServedEvidence == nil {
			t.Fatalf(`the run reports no "served_evidence": %s`, payload)
		}
		want := []string{"omp|session-" + babelTestNonce + "|42|sessions/omp/" + babelTestNonce +
			".jsonl|12|3456|" + digest + "|the archive says " + babelTestNonce}
		if !reflect.DeepEqual(report.ServedEvidence.Hits, want) {
			t.Errorf("the worker reports %q, the decision served %q", report.ServedEvidence.Hits, want)
		}
	})

	t.Run("allowed with nothing served", func(t *testing.T) {
		isolateBabelEnv(t)
		// What an older Babel sends. The key is still there, holding nothing,
		// because "this worker read no hits" and "this worker does not
		// implement the directive" are answers to different questions.
		stream := runBabelWorkerStream(t, babelTestJob(babelConformanceEchoEvidence), allowDecision)
		stream.check(t)

		payload, _ := json.Marshal(stream.terminal["payload"])
		var report conformanceReport
		if err := json.Unmarshal(payload, &report); err != nil {
			t.Fatalf("payload does not decode: %v", err)
		}
		if report.ServedEvidence == nil || len(report.ServedEvidence.Hits) != 0 {
			t.Errorf("served_evidence = %+v; want a present, empty answer", report.ServedEvidence)
		}
	})
}

// TestBabelWorkerErrorIsTerminal checks the other terminal event: no result may
// follow it, and the exit status must not claim success.
func TestBabelWorkerErrorIsTerminal(t *testing.T) {
	isolateBabelEnv(t)
	stream := runBabelWorkerStream(t, babelTestJob(babelConformanceErrorOnly), nil)
	stream.check(t)

	if kind, _ := stream.terminal["type"].(string); kind != babelMessageError {
		t.Fatalf("terminal event is %q, want an error", kind)
	}
	if code, _ := stream.terminal["code"].(string); code == "" {
		t.Error("the error event carries no code")
	}
	for _, kind := range stream.types() {
		if kind == babelMessageResult {
			t.Error("a result was emitted in a run that failed")
		}
	}
	if stream.status == 0 {
		t.Error("exit status = 0 after an error event")
	}
}

// TestBabelWorkerUngrantedRequest checks that asking for a capability outside
// the run's grant is survivable rather than fatal: the grant is the boundary,
// and being told no is a normal answer.
func TestBabelWorkerUngrantedRequest(t *testing.T) {
	isolateBabelEnv(t)
	stream := runBabelWorkerStream(t, babelTestJob(babelConformanceRequestUngranted),
		func(id string) any {
			return babelDecision{
				Type: babelMessageToolDecision, RequestID: id, Decision: babelDecisionDeny,
				Code: "not-granted", Reason: "sandbox-exec is outside this run's grant",
			}
		})
	stream.check(t)

	var request map[string]any
	for _, ev := range stream.events {
		if kind, _ := ev["type"].(string); kind == babelMessageToolRequest {
			request = ev
		}
	}
	if request == nil {
		t.Fatal("the run made no tool request")
	}
	if request["capability"] != babelCapabilitySandboxExec {
		t.Errorf("request capability = %v, want the ungranted one", request["capability"])
	}
	if kind, _ := stream.terminal["type"].(string); kind != babelMessageResult {
		t.Errorf("terminal event is %q, want a result after an out-of-grant denial", kind)
	}
}

// TestBabelWorkerEchoTokenIsDisclosedAndThenScrubbed asserts both halves of the
// echo-token directive, because either half alone is worthless. A stream with no
// credential in it proves nothing if the investigator never wrote one, and an
// investigator that wrote one proves nothing if the stream still carries it.
//
// runBabelWorkerStream fails any run whose stdout or stderr contains the
// credential, so it already owns the scrubbing half. What this test adds is the
// evidence that there was something to scrub: the redaction marker appears only
// where a job secret was, so finding it in the payload and in a progress message
// is proof the investigator disclosed the token in both places the directive
// requires — and that this session's writer, not the investigator's restraint,
// is what kept it off the wire.
func TestBabelWorkerEchoTokenIsDisclosedAndThenScrubbed(t *testing.T) {
	isolateBabelEnv(t)
	stream := runBabelWorkerStream(t, babelTestJob(babelConformanceEchoToken), nil)
	stream.check(t)

	if kind, _ := stream.terminal["type"].(string); kind != babelMessageResult {
		t.Fatalf("terminal event is %q, want a result", kind)
	}
	payload, _ := json.Marshal(stream.terminal["payload"])
	if !strings.Contains(string(payload), string(babelRedacted)) {
		t.Errorf("the result payload carries no redaction, so the investigator never "+
			"disclosed the token and the leak this directive exists to create did not "+
			"happen: %s", payload)
	}
	redactedProgress := 0
	for _, ev := range stream.events {
		if kind, _ := ev["type"].(string); kind != babelMessageProgress {
			continue
		}
		if message, _ := ev["message"].(string); strings.Contains(message, string(babelRedacted)) {
			redactedProgress++
		}
	}
	if redactedProgress == 0 {
		t.Error("no progress message carries a redaction; the directive requires the " +
			"token in at least one of them")
	}
	if stream.status != 0 {
		t.Errorf("exit status = %d, want 0 after a result", stream.status)
	}
}

// babelTestNonce stands in for the per-run value Babel plants in the material
// the echo-job directive asks about. Babel randomizes it per run so a worker
// cannot answer with a constant read out of the published fixture; a test needs
// only a value that is not that fixture, so this one is fixed and reproducible.
const babelTestNonce = "9d41c7f2"

// babelEchoJobFixture is the job Babel's run/decodes-the-job obligation sends:
// two recipes and two sources carrying the nonce, one source archived and one
// not, so a worker that drops "snapshot" is caught by the first and one that
// invents it is caught by the second.
func babelEchoJobFixture() map[string]any {
	job := babelTestJob(babelConformanceEchoJob)
	job["recipes"] = []map[string]any{
		{"id": "outcome-integrity", "version": 1},
		{"id": "evidence-" + babelTestNonce, "version": 7},
	}
	job["sources"] = []map[string]any{{
		"kind":     "session",
		"selector": "omp/synthetic-" + babelTestNonce,
		"digest":   "sha256:" + strings.Repeat("0", 64),
		"snapshot": "snapshot-" + babelTestNonce,
	}, {
		"kind":     "repository",
		"selector": "synthetic/repository-" + babelTestNonce,
		"digest":   "sha256:" + strings.Repeat("1", 64),
	}}
	return job
}

// babelEchoJobAnswer is what a worker that decoded babelEchoJobFixture must
// report. It is spelled out from the directive rather than computed with
// decodedEcho, so the expectation is an independent statement of Babel's format
// instead of the implementation grading itself.
func babelEchoJobAnswer() babelJobEcho {
	return babelJobEcho{
		Recipes: []string{"outcome-integrity@1", "evidence-" + babelTestNonce + "@7"},
		Sources: []string{
			"session|omp/synthetic-" + babelTestNonce + "|sha256:" + strings.Repeat("0", 64) +
				"|snapshot-" + babelTestNonce,
			// The trailing separator with nothing after it is the contract for
			// a source that was never archived: four parts always, the absent
			// one empty.
			"repository|synthetic/repository-" + babelTestNonce + "|sha256:" + strings.Repeat("1", 64) + "|",
		},
	}
}

// babelStaleEchoAnswer is what a worker that hardcoded the published conformance
// job would report instead. It is the answer the nonce exists to reject, so
// every echo assertion checks against it too: an equality test that passed for
// this value as well would be measuring nothing.
func babelStaleEchoAnswer() babelJobEcho {
	return babelJobEcho{
		Recipes: []string{"outcome-integrity@1"},
		Sources: []string{"session|omp/synthetic||"},
	}
}

// TestBabelConformanceDirectiveRecognizesEveryDirectiveItImplements is the guard
// on a failure mode that is invisible from the outside. A directive missing from
// conformanceDirective's switch is reported as well-behaved, so the worker runs
// a perfectly correct analysis of the wrong question and Babel grades it as not
// implementing the obligation at all. Every constant is checked because the
// omission is silent for whichever one is forgotten.
func TestBabelConformanceDirectiveRecognizesEveryDirectiveItImplements(t *testing.T) {
	for _, directive := range []string{
		babelConformanceWellBehaved,
		babelConformanceEchoJob,
		babelConformanceRequestTool,
		babelConformanceRequestUngranted,
		babelConformanceErrorOnly,
		babelConformanceSlow,
		babelConformanceEchoToken,
		babelConformanceEchoEvidence,
	} {
		job := babelJob{Params: map[string]string{babelParamConformance: directive}}
		if got := job.conformanceDirective(); got != directive {
			t.Errorf("directive %q reads back as %q; an unrecognized directive falls through to "+
				"well-behaved, so the worker answers a question it was never asked", directive, got)
		}
	}

	// The fall-through itself is the contract for anything this build has not
	// heard of: a newer suite must not be able to fail an older worker by
	// naming a directive it never implemented.
	for _, unknown := range []string{"", "request-unknown", "echo-jobs"} {
		job := babelJob{Params: map[string]string{babelParamConformance: unknown}}
		if got := job.conformanceDirective(); got != babelConformanceWellBehaved {
			t.Errorf("unknown directive %q reads back as %q, want well-behaved", unknown, got)
		}
	}
}

// TestBabelDecodedEchoRendersEveryPartBabelCompares checks the rendering against
// the format written out by hand, including the empty final segment an
// unarchived source must produce: Babel compares these strings literally, so a
// separator this build omits is a mismatch on every entry rather than a cosmetic
// difference.
func TestBabelDecodedEchoRendersEveryPartBabelCompares(t *testing.T) {
	job := babelJob{
		Recipes: []babelRecipeRef{
			{ID: "outcome-integrity", Version: 1},
			{ID: "evidence-" + babelTestNonce, Version: 7},
		},
		Sources: []babelSource{{
			Kind:     "session",
			Selector: "omp/synthetic-" + babelTestNonce,
			Digest:   "sha256:" + strings.Repeat("0", 64),
			Snapshot: "snapshot-" + babelTestNonce,
		}, {
			Kind:     "repository",
			Selector: "synthetic/repository-" + babelTestNonce,
			Digest:   "sha256:" + strings.Repeat("1", 64),
		}},
	}
	if got, want := job.decodedEcho(), babelEchoJobAnswer(); !reflect.DeepEqual(got, want) {
		t.Errorf("decodedEcho() = %+v, want %+v", got, want)
	}

	// A job with nothing in it answers with empty arrays rather than nulls, so
	// the record says the worker decoded nothing instead of saying nothing.
	empty := babelJob{}.decodedEcho()
	if empty.Recipes == nil || empty.Sources == nil {
		t.Errorf("an empty job echoes %+v; a null reads as no answer where an empty array "+
			"reads as nothing decoded", empty)
	}
}

// TestBabelDecodedEchoDistinguishesEveryFieldBabelCompares is what makes the
// equality assertions elsewhere worth making. Babel grades the echo by comparing
// it against the job it sent, so the rendering has to be sensitive to every part
// of every entry: one that dropped a field would render two genuinely different
// jobs identically, and every comparison built on it would pass while proving
// nothing. Each case below is one field misread, and each must be visible.
func TestBabelDecodedEchoDistinguishesEveryFieldBabelCompares(t *testing.T) {
	base := babelJob{
		Recipes: []babelRecipeRef{{ID: "outcome-integrity", Version: 1}, {ID: "evidence", Version: 7}},
		Sources: []babelSource{
			{Kind: "session", Selector: "omp/one", Digest: "sha256:aa", Snapshot: "snap"},
			{Kind: "repository", Selector: "synthetic/two", Digest: "sha256:bb"},
		},
	}
	for _, tc := range []struct {
		name  string
		wrong func(babelJob) babelJob
	}{
		{"a recipe id", func(j babelJob) babelJob {
			j.Recipes = []babelRecipeRef{{ID: "outcome-integrity", Version: 1}, {ID: "evidence-other", Version: 7}}
			return j
		}},
		{"a recipe version", func(j babelJob) babelJob {
			j.Recipes = []babelRecipeRef{{ID: "outcome-integrity", Version: 1}, {ID: "evidence", Version: 8}}
			return j
		}},
		{"the recipe order", func(j babelJob) babelJob {
			j.Recipes = []babelRecipeRef{{ID: "evidence", Version: 7}, {ID: "outcome-integrity", Version: 1}}
			return j
		}},
		{"a dropped recipe", func(j babelJob) babelJob {
			j.Recipes = j.Recipes[:1]
			return j
		}},
		{"a source kind", func(j babelJob) babelJob {
			j.Sources = append([]babelSource(nil), j.Sources...)
			j.Sources[0].Kind = "repository"
			return j
		}},
		{"a source selector", func(j babelJob) babelJob {
			j.Sources = append([]babelSource(nil), j.Sources...)
			j.Sources[0].Selector = "omp/other"
			return j
		}},
		{"a source digest", func(j babelJob) babelJob {
			j.Sources = append([]babelSource(nil), j.Sources...)
			j.Sources[0].Digest = "sha256:cc"
			return j
		}},
		{"a source snapshot", func(j babelJob) babelJob {
			j.Sources = append([]babelSource(nil), j.Sources...)
			j.Sources[0].Snapshot = "other-snap"
			return j
		}},
		{"an invented snapshot on an unarchived source", func(j babelJob) babelJob {
			j.Sources = append([]babelSource(nil), j.Sources...)
			j.Sources[1].Snapshot = "invented"
			return j
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.wrong(base).decodedEcho(); reflect.DeepEqual(got, base.decodedEcho()) {
				t.Errorf("a job differing in %s echoes identically as %+v; Babel compares the "+
					"echo against what it sent, so a field this rendering drops can never be graded",
					tc.name, got)
			}
		})
	}
}

// TestBabelWorkerEchoJobReportsTheJobItDecoded drives the whole worker — real
// binary, real stream, conformance investigator — through the echo-job directive
// and grades the answer the way Babel does.
//
// The job carries a nonce in both recipes and both sources, which is the only
// thing separating this assertion from one a worker could satisfy by printing
// the published fixture. So the answer is checked against the fixture too: it
// must not be that.
func TestBabelWorkerEchoJobReportsTheJobItDecoded(t *testing.T) {
	isolateBabelEnv(t)
	stream := runBabelWorkerStream(t, babelEchoJobFixture(), nil)
	stream.check(t)

	if kind, _ := stream.terminal["type"].(string); kind != babelMessageResult {
		t.Fatalf("terminal event is %q, want a result; a run that produces none has reported "+
			"no reading of the job", kind)
	}
	got := babelEchoOfPayload(t, stream.terminal["payload"])
	if want := babelEchoJobAnswer(); !reflect.DeepEqual(got, want) {
		t.Errorf("the worker reports %+v, the job carried %+v", got, want)
	}
	if stale := babelStaleEchoAnswer(); reflect.DeepEqual(got, stale) {
		t.Errorf("the worker reports the published conformance job rather than the one that "+
			"arrived: %+v", got)
	}
}

// TestBabelWorkerEchoJobIsAskedForAndNotVolunteered checks the other half of the
// key's contract. Babel reads the presence of "job" as the worker answering, so
// a payload that carried it on every run would be answering a question nobody
// put — and the counts the stub reports are not that answer, because two matching
// counts are exactly what a worker that read the array lengths and nothing
// inside them produces.
func TestBabelWorkerEchoJobIsAskedForAndNotVolunteered(t *testing.T) {
	isolateBabelEnv(t)
	stream := runBabelWorkerStream(t, babelTestJob(babelConformanceWellBehaved), nil)
	stream.check(t)

	payload, err := json.Marshal(stream.terminal["payload"])
	if err != nil {
		t.Fatalf("marshalling the terminal payload: %v", err)
	}
	var answered struct {
		Job *babelJobEcho `json:"job"`
	}
	if err := json.Unmarshal(payload, &answered); err != nil {
		t.Fatalf("the result payload is not a JSON object: %v", err)
	}
	if answered.Job != nil {
		t.Errorf("a well-behaved run volunteered a job echo: %+v", *answered.Job)
	}
}

// babelEchoOfPayload reads the echo out of a terminal result payload exactly as
// Babel does: through JSON, under the "job" key, with an absent key treated as
// the worker having reported no reading at all rather than as an empty one.
func babelEchoOfPayload(t *testing.T, payload any) babelJobEcho {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshalling the terminal payload: %v", err)
	}
	var answered struct {
		Job *babelJobEcho `json:"job"`
	}
	if err := json.Unmarshal(encoded, &answered); err != nil {
		t.Fatalf("the result payload is not a JSON object: %v", err)
	}
	if answered.Job == nil {
		t.Fatalf(`the result payload carries no "job" object: %s`, encoded)
	}
	return *answered.Job
}

// TestBabelWorkerConfigurationDeclaresTheProfileThatRan defends the three claims
// Babel reads out of a worker-mode configuration event.
//
// The capability list is the one that regressed: neither resolve nor
// syntheticConfiguration is handed the run, so both left it empty and the worker
// declared a profile that can do nothing — then made a request that profile never
// claimed. Babel catches that as a profile which is not the profile that ran, and
// it is invisible from inside a run because the request is still answered.
//
// The metadata keys are checked by their literal names because that is how
// Babel's receipt consumers read them: a renamed "model" is recorded as an empty
// model rather than as an error, which is a durable record of the wrong thing.
func TestBabelWorkerConfigurationDeclaresTheProfileThatRan(t *testing.T) {
	isolateBabelEnv(t)
	stream := runBabelWorkerStream(t, babelTestJob(babelConformanceRequestTool), allowDecision)
	stream.check(t)

	var cfg babelConfiguration
	for _, ev := range stream.events {
		if kind, _ := ev["type"].(string); kind != babelMessageConfiguration {
			continue
		}
		encoded, err := json.Marshal(ev)
		if err != nil {
			t.Fatalf("marshalling the configuration event: %v", err)
		}
		if err := json.Unmarshal(encoded, &cfg); err != nil {
			t.Fatalf("the configuration event does not decode: %v", err)
		}
	}

	for _, key := range []string{"provider", "model", "thinking"} {
		if strings.TrimSpace(cfg.Metadata[key]) == "" {
			t.Errorf("resolved metadata names no %q; Babel reads the three under exactly "+
				"those keys, so a renamed one is recorded as absent: %v", key, cfg.Metadata)
		}
	}

	// Every capability declared has to be one Babel defines. A name Babel has
	// no boundary for can never be granted, so declaring it tells an operator
	// the profile can do something no run will ever authorize.
	known := map[string]bool{
		babelCapabilityCorpusSearch: true, babelCapabilityRepoRead: true,
		babelCapabilitySandboxExec: true, babelCapabilityPublicResearch: true,
	}
	for _, capability := range cfg.Capabilities {
		if !known[capability] {
			t.Errorf("the configuration declares capability %q, which Babel does not define",
				capability)
		}
	}

	// And the claim must cover what the run actually did: this directive makes
	// one corpus-search request, and the request is the evidence.
	for _, ev := range stream.events {
		if kind, _ := ev["type"].(string); kind != babelMessageToolRequest {
			continue
		}
		asked, _ := ev["capability"].(string)
		if !slices.Contains(cfg.Capabilities, asked) {
			t.Errorf("the run exercised %q but the configuration declares only %v; a profile "+
				"that omits what the run did is not the profile that ran", asked, cfg.Capabilities)
		}
	}

	// Cost is the profile's own estimate and never a measurement, so the only
	// two things wrong on their face are a negative figure and a figure with no
	// unit: a cost guard reads the first as a discount and drops the second.
	if cfg.Cost.InputPer1K < 0 || cfg.Cost.OutputPer1K < 0 || cfg.Cost.EstimatedRun < 0 {
		t.Errorf("declared cost carries a negative figure: %+v", cfg.Cost)
	}
	if cfg.Cost.Currency == "" &&
		(cfg.Cost.InputPer1K != 0 || cfg.Cost.OutputPer1K != 0 || cfg.Cost.EstimatedRun != 0) {
		t.Errorf("declared cost quotes %+v in no currency, so Babel drops the whole figure",
			cfg.Cost)
	}
}

// TestBabelWorkerUnknownFieldsSurvive is the forward-compatibility rule in both
// directions: unknown fields in accept, job and tool-decision are never fatal,
// and a job's unknown top-level fields are preserved rather than dropped, so a
// newer Babel can add one without this build losing it.
func TestBabelWorkerUnknownFieldsSurvive(t *testing.T) {
	isolateBabelEnv(t)
	h := newBabelHarness(t, conformanceOpts())
	h.expectHello()
	h.writeRaw(`{"type":"accept","protocol":"babel.analysis-worker","version":1,"mode":"worker",` +
		`"limits":{"max_line_bytes":1048576,"max_events":1000,"max_tool_requests":16,"x-future":7},` +
		`"x-babel-future":{"added":"later"}}`)

	job := babelTestJob(babelConformanceRequestTool)
	job["x-babel-future"] = map[string]any{"unknown": "to this worker"}
	job["x-babel-scalar"] = 42
	h.write(job)

	var stream babelStream
	for {
		ev, ok := <-h.events
		if !ok {
			break
		}
		stream.events = append(stream.events, ev)
		kind, _ := ev["type"].(string)
		switch kind {
		case babelMessageToolRequest:
			id, _ := ev["request_id"].(string)
			// An unknown field in the decision must not stop it being honoured.
			h.writeRaw(fmt.Sprintf(
				`{"type":"tool-decision","request_id":%q,"decision":"allow","x-babel-future":true}`, id))
		case babelMessageResult, babelMessageError:
			stream.terminal = ev
		}
	}
	stream.status = h.wait()
	stream.check(t)

	if kind, _ := stream.terminal["type"].(string); kind != babelMessageResult {
		t.Fatalf("terminal event is %q, want a result", kind)
	}
	payload, _ := json.Marshal(stream.terminal["payload"])
	for _, want := range []string{"x-babel-future", "x-babel-scalar", babelDecisionAllow} {
		if !strings.Contains(string(payload), want) {
			t.Errorf("the result payload does not carry %q: %s", want, payload)
		}
	}
	if stream.status != 0 {
		t.Errorf("exit status = %d, want 0", stream.status)
	}
}

// TestBabelWorkerMisdirectedDecision covers the two ways a decision can name the
// wrong request. Neither is survivable: the sides disagree about the stream, so
// the run fails with a terminal event rather than adapting to an answer that was
// never given.
func TestBabelWorkerMisdirectedDecision(t *testing.T) {
	for _, tc := range []struct {
		name string
		id   func(outstanding string) string
	}{
		{"unknown request", func(string) string { return "t-999" }},
		{"empty request", func(string) string { return "" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			isolateBabelEnv(t)
			stream := runBabelWorkerStream(t, babelTestJob(babelConformanceRequestTool),
				func(outstanding string) any {
					return babelDecision{
						Type: babelMessageToolDecision, RequestID: tc.id(outstanding),
						Decision: babelDecisionAllow,
					}
				})
			stream.check(t)
			if kind, _ := stream.terminal["type"].(string); kind != babelMessageError {
				t.Errorf("terminal event is %q, want an error after a misdirected decision", kind)
			}
			if stream.status == 0 {
				t.Error("exit status = 0 after a protocol violation")
			}
		})
	}
}

// TestBabelWorkerRepeatedDecision checks the already-answered case specifically:
// the second decision for a request that was answered is a violation, and it is
// reported as one rather than being applied to whatever is outstanding.
func TestBabelWorkerRepeatedDecision(t *testing.T) {
	isolateBabelEnv(t)
	h := newBabelHarness(t, conformanceOpts())
	h.expectHello()
	h.write(babelAcceptLine(babelModeWorker))
	h.write(babelTestJob(babelConformanceRequestTool))

	var stream babelStream
	answered := ""
	for {
		ev, ok := <-h.events
		if !ok {
			break
		}
		stream.events = append(stream.events, ev)
		kind, _ := ev["type"].(string)
		if kind == babelMessageToolRequest {
			answered, _ = ev["request_id"].(string)
			h.write(allowDecision(answered))
			// A second decision for the same request, which the worker is not
			// waiting for and must not accept.
			h.write(allowDecision(answered))
		}
		if kind == babelMessageResult || kind == babelMessageError {
			stream.terminal = ev
		}
	}
	stream.status = h.wait()
	stream.check(t)
	// The extra decision arrives after the request was answered, so the run may
	// legitimately have finished before reading it. What must never happen is a
	// stream that breaks its own rules, which check already asserted, or a
	// silent second answer being applied to a later request.
	if answered == "" {
		t.Fatal("no tool request was made")
	}
	if kind, _ := stream.terminal["type"].(string); kind != babelMessageResult && kind != babelMessageError {
		t.Errorf("terminal event is %q", kind)
	}
}

// TestBabelWorkerCancellationOnStdinClose checks the teardown path Babel
// actually uses: it closes the worker's stdin and then kills the tree, so a
// worker that only noticed cancellation while waiting for a decision would run
// on until it was killed.
func TestBabelWorkerCancellationOnStdinClose(t *testing.T) {
	isolateBabelEnv(t)
	h := newBabelHarness(t, conformanceOpts())
	h.expectHello()
	h.write(babelAcceptLine(babelModeWorker))
	h.write(babelTestJob(babelConformanceSlow))

	// Wait until the run is demonstrably working, then cancel the way Babel
	// does.
	for {
		ev := h.next()
		if kind, _ := ev["type"].(string); kind == babelMessageProgress {
			break
		}
	}
	started := time.Now()
	h.stdin.Close()

	status := h.wait()
	if elapsed := time.Since(started); elapsed > 15*time.Second {
		t.Errorf("the worker took %s to tear down after stdin closed", elapsed)
	}
	if status == 0 {
		t.Error("exit status = 0 after a cancelled run")
	}
	if !strings.Contains(h.stdout.String(), `"type":"error"`) {
		t.Error("a cancelled run owed a terminal event and wrote none")
	}
}

// TestBabelWorkerWithoutInvestigator is the honest failure the seam is built
// around: until the OMP driver is wired into newInvestigator, worker mode says
// it has nothing to run instead of answering with something invented.
func TestBabelWorkerWithoutInvestigator(t *testing.T) {
	isolateBabelEnv(t)
	if inv := newInvestigator(); inv != nil {
		t.Skip("an investigator is wired in; this test only describes the unwired state")
	}
	h := newBabelHarness(t, babelOptions{profileID: "code"})
	h.expectHello()
	h.write(babelAcceptLine(babelModeWorker))
	h.write(babelTestJob(babelConformanceWellBehaved))

	event := h.next()
	if event["type"] != babelMessageError {
		t.Fatalf("worker mode with no investigator answered with %v", event["type"])
	}
	if event["code"] != babelErrInvestigator {
		t.Errorf("error code = %v, want %q", event["code"], babelErrInvestigator)
	}
	if rest := h.drain(); len(rest) != 0 {
		t.Errorf("%d events followed the terminal error: %v", len(rest), rest)
	}
	if status := h.wait(); status == 0 {
		t.Error("exit status = 0 after an error event")
	}
}

// ── the provider credential ──────────────────────────────────────────────────

// TestBabelWorkerWithoutACredentialEndsInATerminalError is the honest failure
// for a run that could never have authenticated. Babel gets exactly one
// terminal event either way, and an error naming the missing credential is
// worth more than an OMP that starts and fails its first model call.
func TestBabelWorkerWithoutACredentialEndsInATerminalError(t *testing.T) {
	isolateBabelEnv(t)
	if _, ok := newInvestigator().(credentialResolver); !ok {
		t.Fatal("the wired investigator resolves no credential, so no real exploration can authenticate")
	}
	h := newBabelHarness(t, babelOptions{profileID: "code"})
	h.expectHello()
	h.write(babelAcceptLine(babelModeWorker))
	h.write(babelProductionJob("code", 1))

	event := h.next()
	if event["type"] != babelMessageError {
		t.Fatalf("a run with no credential answered with %v, want a terminal error", event["type"])
	}
	if event["code"] != babelErrInvestigator {
		t.Errorf("error code = %v, want %q", event["code"], babelErrInvestigator)
	}
	message, _ := event["message"].(string)
	for _, remedy := range []string{"OMP_AUTH_BROKER_TOKEN", ompVaultManifestName} {
		if !strings.Contains(message, remedy) {
			t.Errorf("the terminal error does not name %q, so an operator cannot act on it: %q", remedy, message)
		}
	}
	if rest := h.drain(); len(rest) != 0 {
		t.Errorf("%d events followed the terminal error: %v", len(rest), rest)
	}
	if status := h.wait(); status == 0 {
		t.Error("exit status = 0 after an error event")
	}
}

// TestBabelWorkerScrubsTheProviderCredentialItHandedToOmp closes the route
// wiring the credential opens. OMP now holds it, OMP's stderr tail is how a
// failed run is explained, and that explanation goes to Babel as a durable
// event — so the credential is registered with the same scrubber the job's is,
// and this drives a child that prints it where a real one prints an auth
// failure.
func TestBabelWorkerScrubsTheProviderCredentialItHandedToOmp(t *testing.T) {
	isolateBabelEnv(t)
	t.Setenv("CODE_GENERATED", babelCatalogFixture(t))

	saved := babelMintedProfile(t, "code",
		map[string]string{"lane": "ds-led", "thinking": "high", "advisor": "audit"})

	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"credentials":[]}`))
	}))
	defer broker.Close()
	t.Setenv("OMP_AUTH_BROKER_URL", broker.URL)
	t.Setenv("OMP_AUTH_BROKER_TOKEN", testProviderToken)
	// A static fake, because this run goes through the real investigator and so
	// through the real sandbox: a shell-script stand-in has no interpreter in
	// there, and the containment would refuse it before it could print
	// anything. The credential's route to a durable event is the same either
	// way — the child's stderr, folded into the run's terminal error.
	fake, _ := ompFakeStaticBinary(t, "credleak")
	t.Setenv("CODE_OMP", fake)

	h := newBabelHarness(t, babelOptions{profileID: "code"})
	h.expectHello()
	h.write(babelAcceptLine(babelModeWorker))
	h.write(babelProductionJob(saved.ID, saved.Revision))

	var terminal map[string]any
	for terminal == nil {
		event := h.next()
		if kind, _ := event["type"].(string); kind == babelMessageResult || kind == babelMessageError {
			terminal = event
		}
	}
	h.drain()
	h.wait()

	message, _ := terminal["message"].(string)
	// The child has to have printed it, or the scrub proves nothing.
	if !strings.Contains(message, "authentication rejected for") {
		t.Fatalf("omp's diagnostics never reached the terminal event, so nothing was scrubbed: %v", terminal)
	}
	if !strings.Contains(message, string(babelRedacted)) {
		t.Errorf("the credential omp printed was not redacted: %q", message)
	}
	for name, stream := range map[string]string{"stdout": h.stdout.String(), "stderr": h.stderr.String()} {
		if strings.Contains(stream, testProviderToken) {
			t.Errorf("the provider credential reached %s: %s", name, stream)
		}
	}
}

// ── the invariants, at their enforcement point ───────────────────────────────

// TestBabelEventOrdering exercises the ordering rules directly, because their
// whole purpose is to hold when an investigator misbehaves — and no investigator
// this package ships does.
func TestBabelEventOrdering(t *testing.T) {
	session := func() (*babelSession, *bytes.Buffer) {
		var out bytes.Buffer
		s := newBabelSession(strings.NewReader(""), &out, io.Discard)
		s.limits = babelLimits{MaxLineBytes: 1 << 20, MaxEvents: 100}
		return s, &out
	}
	configuration := babelConfiguration{
		Profile:  babelProfileRef{ID: "p", Revision: 1},
		Privacy:  babelPrivacy{Disclosure: babelDisclosureLocal},
		Metadata: map[string]string{"provider": "none"},
	}

	t.Run("progress before configuration", func(t *testing.T) {
		s, out := session()
		if err := s.event(babelMessageProgress, func(seq int, at time.Time) any {
			return &babelProgress{Type: babelMessageProgress, Seq: seq, Time: &at, Stage: "s"}
		}); err == nil {
			t.Error("a progress event was allowed before the resolved configuration")
		}
		if out.Len() != 0 {
			t.Errorf("the rejected event was written anyway: %q", out.String())
		}
	})

	t.Run("second configuration", func(t *testing.T) {
		s, _ := session()
		if err := s.emitConfiguration(configuration); err != nil {
			t.Fatal(err)
		}
		if err := s.emitConfiguration(configuration); err == nil {
			t.Error("a second configuration event was allowed")
		}
	})

	t.Run("two terminal events", func(t *testing.T) {
		s, _ := session()
		if err := s.emitConfiguration(configuration); err != nil {
			t.Fatal(err)
		}
		if err := s.emitResult(babelResult{}); err != nil {
			t.Fatal(err)
		}
		if err := s.emitResult(babelResult{}); err == nil {
			t.Error("a second result was allowed")
		}
		if err := s.emitError("x", "y", false); err == nil {
			t.Error("an error was allowed after a result")
		}
		if err := s.event(babelMessageProgress, func(seq int, at time.Time) any {
			return &babelProgress{Type: babelMessageProgress, Seq: seq, Time: &at}
		}); err == nil {
			t.Error("a progress event was allowed after the terminal event")
		}
	})

	t.Run("seq is allocated once per written event", func(t *testing.T) {
		s, out := session()
		if err := s.emitConfiguration(configuration); err != nil {
			t.Fatal(err)
		}
		for range 3 {
			s.emitProgress("stage", "message", 0.5)
		}
		if s.fatal != nil {
			t.Fatal(s.fatal)
		}
		if err := s.emitResult(babelResult{Payload: json.RawMessage(`{}`)}); err != nil {
			t.Fatal(err)
		}
		var seqs []int
		for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
			var ev struct{ Seq int }
			if err := json.Unmarshal([]byte(line), &ev); err != nil {
				t.Fatal(err)
			}
			seqs = append(seqs, ev.Seq)
		}
		want := []int{1, 2, 3, 4, 5}
		if len(seqs) != len(want) {
			t.Fatalf("wrote %d events, want %d", len(seqs), len(want))
		}
		for i, seq := range seqs {
			if seq != want[i] {
				t.Errorf("event %d has seq %d, want %d (seqs: %v)", i, seq, want[i], seqs)
			}
		}
	})

	t.Run("the terminal event keeps its budget slot", func(t *testing.T) {
		s, _ := session()
		s.limits.MaxEvents = 2
		if err := s.emitConfiguration(configuration); err != nil {
			t.Fatal(err)
		}
		s.emitProgress("stage", "message", 0)
		if s.fatal == nil {
			t.Error("progress spent the slot the terminal event needs")
		}
		s.fatal = nil
		if err := s.emitError(babelErrInternal, "budget", false); err != nil {
			t.Errorf("the terminal event had no slot left: %v", err)
		}
	})
}

// TestBabelWriteLineBoundsAndScrubs covers the two rules every written line
// obeys: it fits the accepted budget, because an oversized line is a protocol
// violation rather than a large message, and it carries no job secret.
func TestBabelWriteLineBoundsAndScrubs(t *testing.T) {
	const budget = 512

	t.Run("an oversized progress message is truncated", func(t *testing.T) {
		var out bytes.Buffer
		s := newBabelSession(strings.NewReader(""), &out, io.Discard)
		s.limits = babelLimits{MaxLineBytes: budget, MaxEvents: 10}
		s.configured = true
		s.emitProgress("discover", strings.Repeat("verbose ", 500), 0.5)
		if s.fatal != nil {
			t.Fatal(s.fatal)
		}
		line := strings.TrimSpace(out.String())
		if len(line)+1 > budget {
			t.Fatalf("wrote a %d-byte line against a %d-byte budget", len(line)+1, budget)
		}
		var ev babelProgress
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatal(err)
		}
		if ev.Stage != "discover" {
			t.Errorf("truncation lost the stage: %q", ev.Stage)
		}
		if !strings.Contains(ev.Message, babelTruncationMarker) {
			t.Errorf("the truncated message does not say so: %q", ev.Message)
		}
	})

	t.Run("an oversized result payload is replaced with a note", func(t *testing.T) {
		var out bytes.Buffer
		s := newBabelSession(strings.NewReader(""), &out, io.Discard)
		s.limits = babelLimits{MaxLineBytes: budget, MaxEvents: 10}
		s.configured = true
		payload, err := json.Marshal(map[string]string{"finding": strings.Repeat("x", 4000)})
		if err != nil {
			t.Fatal(err)
		}
		if err := s.emitResult(babelResult{Payload: payload}); err != nil {
			t.Fatal(err)
		}
		line := strings.TrimSpace(out.String())
		if len(line)+1 > budget {
			t.Fatalf("wrote a %d-byte line against a %d-byte budget", len(line)+1, budget)
		}
		if !strings.Contains(line, "babel.truncated") {
			t.Errorf("the replaced payload does not say what happened: %s", line)
		}
		var ev babelResult
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatal(err)
		}
		if ev.Status != babelStatusOK || ev.Seq != 1 {
			t.Errorf("truncation damaged the result's own fields: %+v", ev)
		}
	})

	t.Run("a secret never reaches either stream", func(t *testing.T) {
		var out bytes.Buffer
		var errOut bytes.Buffer
		s := newBabelSession(strings.NewReader(""), &out, &errOut)
		s.limits = babelLimits{MaxLineBytes: 1 << 20, MaxEvents: 10}
		s.secrets = []string{babelTestToken}
		s.configured = true
		// An investigator that echoes the credential into a message, an
		// argument and a diagnostic — every route out of the process.
		s.emitProgress("leak", "the token is "+babelTestToken, 0)
		if err := s.emitResult(babelResult{
			Payload: json.RawMessage(fmt.Sprintf(`{"token":%q,"quoted":"a\"b %s"}`, babelTestToken, babelTestToken)),
		}); err != nil {
			t.Fatal(err)
		}
		s.diag("failed while using %s", babelTestToken)
		if strings.Contains(out.String(), babelTestToken) {
			t.Errorf("the credential reached stdout: %s", out.String())
		}
		if strings.Contains(errOut.String(), babelTestToken) {
			t.Errorf("the credential reached stderr: %s", errOut.String())
		}
		if !strings.Contains(out.String(), string(babelRedacted)) {
			t.Errorf("the credential was dropped rather than marked: %s", out.String())
		}
	})
}

// TestBabelShrinkTerminates guards writeLine's loop: every shrink step must make
// the encoded event strictly smaller, or an oversized event would spin forever
// instead of failing. The encoded length is the measure because that is what
// writeLine compares against the accepted budget.
func TestBabelShrinkTerminates(t *testing.T) {
	encoded := func(v any) int {
		t.Helper()
		data, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return len(data)
	}
	for _, tc := range []struct {
		name  string
		event any
	}{
		{"progress", &babelProgress{
			Type: babelMessageProgress, Stage: "stage", Message: strings.Repeat("x", 4096),
			Resources: &babelResources{ToolCalls: 1},
		}},
		{"tool-request", &babelToolRequest{
			Type: babelMessageToolRequest, RequestID: "t-1", Capability: babelCapabilityCorpusSearch,
			Tool: "search", Reason: strings.Repeat("y", 4096),
			Arguments: json.RawMessage(`{"query":"` + strings.Repeat("z", 4096) + `"}`),
		}},
		{"result", &babelResult{
			Type: babelMessageResult, Status: babelStatusOK, Schema: babelResultSchema,
			Payload:   json.RawMessage(`{"finding":"` + strings.Repeat("w", 4096) + `"}`),
			Resources: &babelResources{ToolCalls: 1},
		}},
		{"error", &babelError{
			Type: babelMessageError, Code: babelErrInternal, Message: strings.Repeat("v", 4096),
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// An over of 8 is the worst case worth checking: each step gives up
			// only what it was asked for, so termination is driven by the
			// strict-shrink property rather than by a big first cut.
			start := encoded(tc.event)
			previous := start
			for steps := 0; babelShrink(tc.event, 8); steps++ {
				size := encoded(tc.event)
				if size >= previous {
					t.Fatalf("step %d did not shrink the event: %d ≥ %d", steps, size, previous)
				}
				previous = size
				if steps > start {
					t.Fatalf("babelShrink took more than %d steps to run out of things to give up", start)
				}
			}
		})
	}

	// A tool-request never gives up the identity that makes it answerable, even
	// when it has nothing left to trim.
	request := &babelToolRequest{
		Type: babelMessageToolRequest, RequestID: "t-1",
		Capability: babelCapabilityCorpusSearch, Tool: "search",
	}
	if babelShrink(request, 8) {
		t.Error("babelShrink gave something up from a tool-request with nothing expendable")
	}
	if request.RequestID != "t-1" || request.Capability == "" || request.Tool == "" {
		t.Errorf("babelShrink damaged a tool-request's identity: %+v", request)
	}
}

// TestBabelShrinkKeepsTheResourceClaimUntilLast checks the order the result
// branch gives things up in. The payload is the reason a result is oversized and
// the resource object is a few dozen bytes, so a shrink that dropped the
// measurement first would trade a claim this worker is obliged to make for a
// saving it did not need.
func TestBabelShrinkKeepsTheResourceClaimUntilLast(t *testing.T) {
	cpu, bytes := 1.5, int64(4096)
	result := &babelResult{
		Type: babelMessageResult, Status: babelStatusOK, Schema: babelResultSchema,
		Payload:   json.RawMessage(`{"finding":"` + strings.Repeat("w", 4096) + `"}`),
		Resources: &babelResources{CPUSeconds: &cpu, SandboxBytesWritten: &bytes, ToolCalls: 3},
	}
	if !babelShrink(result, 8) {
		t.Fatal("an oversized result gave up nothing")
	}
	if result.Resources == nil {
		t.Error("the first thing given up was the measurement rather than the payload")
	}
	if strings.Contains(string(result.Payload), "wwww") {
		t.Errorf("the payload was not the thing truncated: %s", result.Payload)
	}
	// Only once the payload has nothing left does the claim go.
	for babelShrink(result, 8) {
	}
	if result.Resources != nil {
		t.Error("a result that ran out of payload kept a claim it could still have given up")
	}
}

// TestReportedResourcesOmitWhatWasNotMeasured is the honesty invariant of the
// resource report, checked where it is observable: the bytes on the wire.
//
// Babel's struct declares plain numbers, so an omitted key and a zero key both
// arrive there as zero. The distinction is what Code writes, and it is the whole
// defence against the cheapest way to satisfy a resource obligation — filling in
// figures nobody read off anything. A dimension with no source must be absent, a
// dimension measured as zero must be present as zero, and the two must never
// look alike.
func TestReportedResourcesOmitWhatWasNotMeasured(t *testing.T) {
	// Nothing measurable: only the count the driver keeps itself survives.
	body, err := json.Marshal(runUsage{}.report(2))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(body), `{"tool_calls":2}`; got != want {
		t.Errorf("an unmeasured reading rendered as %s, want %s", got, want)
	}

	// A run that looked and found nothing said exactly that: the zero is
	// present, because it is a measurement.
	body, err = json.Marshal(runUsage{bytesSource: "a host walk of the run directory"}.report(0))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(body), `{"sandbox_bytes_written":0,"tool_calls":0}`; got != want {
		t.Errorf("a measured zero rendered as %s, want %s", got, want)
	}

	// And a full reading carries every key, in the units the sources report.
	full := runUsage{
		cpuSeconds: 2.5, cpuSource: "cgroup cpu.stat",
		maxRSSBytes: 1 << 20, maxRSSSource: "cgroup memory.peak",
		bytesWritten: 4096, bytesSource: "the guest's own walk",
	}
	body, err = json.Marshal(full.report(1))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"cpu_seconds":2.5,"max_rss_bytes":1048576,"sandbox_bytes_written":4096,"tool_calls":1}`
	if string(body) != want {
		t.Errorf("a full reading rendered as %s, want %s", body, want)
	}
}

// TestRunUsagePrefersTheBetterSourceAndNeverGoesBackwards covers the two
// compositions the reporting path performs: filling a dimension the best source
// could not supply from a weaker one, and turning two readings of a cumulative
// counter into the run's own share.
func TestRunUsagePrefersTheBetterSourceAndNeverGoesBackwards(t *testing.T) {
	cgroup := runUsage{cpuSeconds: 9, cpuSource: "cgroup cpu.stat"}
	child := runUsage{
		cpuSeconds: 3, cpuSource: "child rusage",
		maxRSSBytes: 2048, maxRSSSource: "child rusage",
	}
	merged := cgroup.fillFrom(child)
	if merged.cpuSeconds != 9 || merged.cpuSource != "cgroup cpu.stat" {
		t.Errorf("the weaker source overwrote the better one: %+v", merged)
	}
	if merged.maxRSSBytes != 2048 || merged.maxRSSSource != "child rusage" {
		t.Errorf("a dimension the cgroup could not supply was not filled in: %+v", merged)
	}

	span := runUsage{cpuSeconds: 4, cpuSource: "self"}.since(runUsage{cpuSeconds: 1.5, cpuSource: "self"})
	if span.cpuSeconds != 2.5 {
		t.Errorf("the run's own CPU share = %v, want the difference 2.5", span.cpuSeconds)
	}
	// A start reading that never happened cannot make the end reading a span.
	whole := runUsage{cpuSeconds: 4, cpuSource: "self"}.since(runUsage{})
	if whole.cpuSeconds != 4 {
		t.Errorf("differencing against an unmeasured start changed the figure: %v", whole.cpuSeconds)
	}
	// And nothing may leave here negative, because a negative counter in a
	// receipt is a wrong measurement rather than a small one.
	clamped := runUsage{cpuSeconds: 1, cpuSource: "self"}.since(runUsage{cpuSeconds: 5, cpuSource: "self"})
	if clamped.cpuSeconds != 0 {
		t.Errorf("a contradictory pair of readings produced %v, want a clamped 0", clamped.cpuSeconds)
	}
}

// TestBabelRepeatedToolRequests covers a real run rather than a conformance
// directive: a model that retries a refused tool asks again, so one run holds
// several requests. Each has to get its own request_id and its own decision, and
// a stale decision for a request that was already answered must not be applied
// to whichever one is outstanding.
func TestBabelRepeatedToolRequests(t *testing.T) {
	inbound := strings.Join([]string{
		`{"type":"tool-decision","request_id":"t-1","decision":"deny","code":"policy","reason":"refused once"}`,
		`{"type":"tool-decision","request_id":"t-2","decision":"allow"}`,
	}, "\n") + "\n"
	var out bytes.Buffer
	s := newBabelSession(strings.NewReader(inbound), &out, io.Discard)
	s.limits = babelLimits{MaxLineBytes: 1 << 20, MaxEvents: 100, MaxToolRequests: 2}
	s.configured = true
	s.startPump()

	first := s.requestTool(babelCapabilityCorpusSearch, "search", "first try", json.RawMessage(`{"q":1}`))
	second := s.requestTool(babelCapabilityCorpusSearch, "search", "retry", json.RawMessage(`{"q":2}`))
	if s.fatal != nil {
		t.Fatalf("two ordinary requests were treated as a violation: %v", s.fatal)
	}
	if first.allowed() || first.Code != "policy" {
		t.Errorf("first decision = %+v, want the denial Babel sent", first)
	}
	if !second.allowed() {
		t.Errorf("second decision = %+v, want the allow Babel sent", second)
	}

	var ids []string
	var seqs []int
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var ev babelToolRequest
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, ev.RequestID)
		seqs = append(seqs, ev.Seq)
	}
	if len(ids) != 2 {
		t.Fatalf("wrote %d tool requests, want 2: %q", len(ids), out.String())
	}
	if ids[0] == ids[1] {
		t.Errorf("both requests used request_id %q, so a decision could name either", ids[0])
	}
	if seqs[0] >= seqs[1] {
		t.Errorf("request seqs %v do not strictly increase", seqs)
	}

	// The run's tool budget is spent. Babel would deny a third with "limit", so
	// refusing here keeps the stream inside the budget it accepted — and it is a
	// denial, not a failure.
	before := out.Len()
	third := s.requestTool(babelCapabilityCorpusSearch, "search", "one too many", nil)
	if third.allowed() || third.Code != "limit" {
		t.Errorf("third decision = %+v, want a limit denial", third)
	}
	if out.Len() != before {
		t.Errorf("the over-budget request was written anyway: %q", out.String()[before:])
	}
	if s.fatal != nil {
		t.Errorf("an over-budget request was treated as a violation: %v", s.fatal)
	}
}

// TestBabelJobExtraPreservesUnknownFields pins the decode rule the wire contract
// states: every documented field lands in its own place and everything else is
// preserved, so nothing is silently dropped and nothing documented is duplicated
// into Extra.
func TestBabelJobExtraPreservesUnknownFields(t *testing.T) {
	line := `{"type":"job","protocol":"babel.analysis-worker","job_id":"j","run_id":"r",` +
		`"profile":{"id":"p","revision":3},"grant":{"capabilities":["corpus-search"],"disclosure":"local"},` +
		`"params":{"babel.conformance":"well-behaved"},"x-one":1,"x-two":{"nested":true}}`
	s := newBabelSession(strings.NewReader(line+"\n"), io.Discard, io.Discard)
	s.startPump()
	job, err := s.readJob()
	if err != nil {
		t.Fatal(err)
	}
	if job.JobID != "j" || job.Profile.Revision != 3 || !job.Grant.allows(babelCapabilityCorpusSearch) {
		t.Fatalf("documented fields did not decode: %+v", job)
	}
	if !job.conformanceRequested() {
		t.Error("the conformance parameter did not decode")
	}
	if len(job.Extra) != 2 {
		t.Fatalf("Extra = %v, want exactly the two unknown fields", job.Extra)
	}
	if string(job.Extra["x-one"]) != "1" || string(job.Extra["x-two"]) != `{"nested":true}` {
		t.Errorf("Extra lost the raw values: %v", job.Extra)
	}
	for _, documented := range []string{"type", "job_id", "profile", "grant", "params"} {
		if _, dup := job.Extra[documented]; dup {
			t.Errorf("documented field %q was also treated as unknown", documented)
		}
	}
}

// ── the real binary ──────────────────────────────────────────────────────────

// TestBabelBinaryEndToEnd drives the built executable over real pipes, because
// every test above shares a process with the session it drives: only a real
// child proves the subcommand is reachable, that stdout carries nothing but the
// protocol, and that the process exits on its own.
func TestBabelBinaryEndToEnd(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go toolchain on PATH to build the binary with")
	}
	binary := filepath.Join(t.TempDir(), "code")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		t.Fatalf("go build: %v", err)
	}

	store := t.TempDir()
	cmd := exec.Command(binary, "babel", "--investigator", babelInvestigatorConformance)
	cmd.Env = append(os.Environ(),
		babelProfileStateEnv+"="+store,
		"CODE_GENERATED="+filepath.Join(t.TempDir(), "absent.plain"),
		// This child inherits os.Environ(), so the default selection location
		// has to be moved out of the developer's real state root too.
		"CODE_SELECTION_STATE=",
		"XDG_STATE_HOME="+t.TempDir(),
		"CODE_RUNTIME_BROKER=",
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	// transcript is the readable exchange; written is only what the worker
	// itself produced, which is what the credential must never appear in.
	var transcript, written bytes.Buffer
	scan := bufio.NewScanner(stdout)
	scan.Buffer(make([]byte, 0, 64<<10), 8<<20)
	readLine := func() map[string]any {
		t.Helper()
		if !scan.Scan() {
			t.Fatalf("the worker stopped writing: %v (stderr: %s)", scan.Err(), stderr.String())
		}
		transcript.Write(append(append([]byte("worker → babel  "), scan.Bytes()...), '\n'))
		written.Write(append(append([]byte(nil), scan.Bytes()...), '\n'))
		var decoded map[string]any
		if err := json.Unmarshal(scan.Bytes(), &decoded); err != nil {
			t.Fatalf("undecodable line %q: %v", scan.Text(), err)
		}
		return decoded
	}
	writeLine := func(v any) {
		t.Helper()
		data, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		transcript.Write(append(append([]byte("babel → worker  "), data...), '\n'))
		if _, err := stdin.Write(append(data, '\n')); err != nil {
			t.Fatalf("writing to the worker: %v", err)
		}
	}

	if hello := readLine(); hello["type"] != babelMessageHello {
		t.Fatalf("first line is %v, want hello", hello["type"])
	}
	writeLine(babelAcceptLine(babelModeWorker))
	writeLine(babelTestJob(babelConformanceRequestTool))

	var kinds []string
	var terminal map[string]any
	for {
		event := readLine()
		kind, _ := event["type"].(string)
		kinds = append(kinds, kind)
		if kind == babelMessageToolRequest {
			id, _ := event["request_id"].(string)
			writeLine(allowDecision(id))
		}
		if kind == babelMessageResult || kind == babelMessageError {
			terminal = event
			break
		}
	}
	stdin.Close()
	if scan.Scan() {
		t.Errorf("the worker wrote %q after its terminal event", scan.Text())
	}
	if err := cmd.Wait(); err != nil {
		t.Errorf("the worker exited %v after a result (stderr: %s)", err, stderr.String())
	}

	t.Logf("NDJSON exchange with the real binary:\n%s", transcript.String())
	if terminal["type"] != babelMessageResult {
		t.Fatalf("terminal event is %v, want a result", terminal["type"])
	}
	want := []string{babelMessageConfiguration, babelMessageProgress, babelMessageToolRequest,
		babelMessageProgress, babelMessageProgress, babelMessageResult}
	if strings.Join(kinds, ",") != strings.Join(want, ",") {
		t.Errorf("event sequence = %v, want %v", kinds, want)
	}
	if strings.Contains(written.String(), babelTestToken) {
		// The job line Babel wrote carries the token; nothing the worker wrote may.
		t.Error("the credential appeared in something the worker wrote")
	}
	if strings.Contains(stderr.String(), babelTestToken) {
		t.Errorf("the credential appeared on stderr: %s", stderr.String())
	}

	// Configure mode, in the same built binary: one message, then exit 0. The
	// profile has to exist first — this mode reports a configuration and can no
	// longer produce one — so it is minted here, into the same store the child
	// reads, the way a confirmed ceremony would.
	t.Setenv("CODE_GENERATED", filepath.Join(t.TempDir(), "absent.plain"))
	minted, err := newProfileStore(store).save(babelDescribeDials(babelTurnedDials(t, nil), "e2e"))
	if err != nil {
		t.Fatalf("minting the profile configure mode reports: %v", err)
	}
	configure := exec.Command(binary, "babel", "--profile", "e2e")
	configure.Env = cmd.Env
	configureIn, err := configure.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	configureOut, err := configure.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	configure.Stderr = io.Discard
	if err := configure.Start(); err != nil {
		t.Fatal(err)
	}
	configureScan := bufio.NewScanner(configureOut)
	if !configureScan.Scan() {
		t.Fatal("configure mode wrote no hello")
	}
	accept, err := json.Marshal(babelAcceptLine(babelModeConfigure))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := configureIn.Write(append(accept, '\n')); err != nil {
		t.Fatal(err)
	}
	if !configureScan.Scan() {
		t.Fatal("configure mode wrote no configuration")
	}
	var cfg map[string]any
	if err := json.Unmarshal(configureScan.Bytes(), &cfg); err != nil {
		t.Fatal(err)
	}
	t.Logf("configure mode: %s", configureScan.Text())
	if cfg["type"] != babelMessageConfiguration {
		t.Errorf("configure mode answered with %v", cfg["type"])
	}
	if configureScan.Scan() {
		t.Errorf("configure mode wrote a second message: %q", configureScan.Text())
	}
	configureIn.Close()
	if err := configure.Wait(); err != nil {
		t.Errorf("configure mode exited %v, want 0", err)
	}
	if profile, _ := cfg["profile"].(map[string]any); profile["id"] != "e2e" {
		t.Errorf("configure mode reported profile %v, want e2e", profile["id"])
	}
	if profile, _ := cfg["profile"].(map[string]any); profile["revision"] != float64(minted.Revision) {
		t.Errorf("configure mode reported revision %v, want the minted %d",
			profile["revision"], minted.Revision)
	}
	if _, err := newProfileStore(store).load("e2e", 0); err != nil {
		t.Errorf("configure mode reported a reference that does not resolve: %v", err)
	}

	// The two ways an unattended caller could still have minted a profile, in
	// the real binary. Both have to fail before anything is written, because
	// Babel would record whatever came out of them.
	t.Run("a dial set from argv is refused", func(t *testing.T) {
		rejected := exec.Command(binary, "babel", "--set", "thinking=high")
		rejected.Env = cmd.Env
		var out bytes.Buffer
		rejected.Stderr = &out
		rejected.Stdout = &out
		err := rejected.Run()
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			t.Fatalf("--set exited %v, want a refusal: %s", err, out.String())
		}
		if !strings.Contains(out.String(), "babel analysis profile configure") {
			t.Errorf("the refusal does not name the ceremony dials come from: %q", out.String())
		}
	})

	t.Run("the ceremony refuses without a terminal", func(t *testing.T) {
		result := filepath.Join(t.TempDir(), "result.json")
		// Pipes on both descriptors — which is exactly what Babel hands a
		// worker in every mode but this one, and what an unattended caller has.
		refused := exec.Command(binary, "babel", "--configure", "--result-file", result)
		refused.Env = cmd.Env
		var out bytes.Buffer
		refused.Stderr = &out
		refused.Stdout = &out
		err := refused.Run()
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			t.Fatalf("--configure with no terminal exited %v, want a refusal: %s", err, out.String())
		}
		if !strings.Contains(out.String(), "terminal") {
			t.Errorf("the refusal does not say a terminal is missing: %q", out.String())
		}
		if _, err := os.Stat(result); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("a refused ceremony wrote a result file: %v", err)
		}
	})
}
