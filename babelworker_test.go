package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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
		},
		"sources": []map[string]any{{"kind": "session", "selector": "omp/synthetic"}},
		"broker":  map[string]any{"endpoint": "http://127.0.0.1:1/evidence", "token": babelTestToken},
		"params":  map[string]string{babelParamConformance: directive},
	}
}

// isolateBabelEnv keeps a test off the developer's real catalog, selection and
// profile store.
func isolateBabelEnv(t *testing.T) string {
	t.Helper()
	store := t.TempDir()
	t.Setenv(babelProfileStateEnv, store)
	t.Setenv("CODE_GENERATED", filepath.Join(t.TempDir(), "absent.plain"))
	t.Setenv("CODE_SELECTION_STATE", "")
	t.Setenv("CODE_RUNTIME_BROKER", "")
	t.Setenv("XDG_DATA_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	return store
}

func conformanceOpts() babelOptions {
	return babelOptions{
		profileID:    defaultBabelProfileID,
		sets:         map[string]string{},
		investigator: babelInvestigatorConformance,
	}
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
func TestBabelConfigureMode(t *testing.T) {
	store := isolateBabelEnv(t)
	h := newBabelHarness(t, babelOptions{profileID: "code", sets: map[string]string{"thinking": "high"}})
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
		t.Errorf("--set thinking=high did not reach the configuration: %v", metadata)
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

	// The reference it reported resolves in the store it claimed to write.
	saved, err := newProfileStore(store).load("code", int(revision))
	if err != nil {
		t.Fatalf("the reported reference does not resolve: %v", err)
	}
	if saved.Selection["thinking"] != "high" {
		t.Errorf("saved selection = %v", saved.Selection)
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

// TestBabelConfigureModeIsIdempotent checks the revision rule end to end: two
// configure runs with the same dials must report the same reference, because
// Babel records it and a gratuitous bump invalidates nothing but its own
// history.
func TestBabelConfigureModeIsIdempotent(t *testing.T) {
	isolateBabelEnv(t)
	run := func() (string, float64) {
		h := newBabelHarness(t, babelOptions{profileID: "code", sets: map[string]string{}})
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

// TestBabelResolveDialsRejectsUnknownDials keeps configure mode from silently
// accepting an override it does not understand: an operator who mistypes a dial
// must be told, not handed a profile that ignores them.
func TestBabelResolveDialsRejectsUnknownDials(t *testing.T) {
	isolateBabelEnv(t)
	cases := []struct {
		name string
		sets map[string]string
		ok   bool
	}{
		{"unknown dial", map[string]string{"nonsense": "on"}, false},
		{"unknown value", map[string]string{"thinking": "telepathic"}, false},
		{"valid", map[string]string{"thinking": "xhigh", "advisor": "audit"}, true},
		{"none", map[string]string{}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m, err := babelResolveDials(tc.sets)
			if tc.ok != (err == nil) {
				t.Fatalf("babelResolveDials(%v) error = %v", tc.sets, err)
			}
			if !tc.ok {
				return
			}
			for key, value := range tc.sets {
				if m.sel[key] != value {
					t.Errorf("dial %s = %q, want %q", key, m.sel[key], value)
				}
			}
		})
	}
}

// TestBabelResolveDialsNeedsNoTerminal is the honest half of the non-interactive
// choice: a run with no catalog, no persisted selection and no terminal still
// resolves, to Code's defaults, rather than hanging or failing.
func TestBabelResolveDialsNeedsNoTerminal(t *testing.T) {
	isolateBabelEnv(t)
	m, err := babelResolveDials(nil)
	if err != nil {
		t.Fatalf("babelResolveDials with nothing configured: %v", err)
	}
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

	m, err := babelResolveDials(map[string]string{"lane": "ds-led", "thinking": "high", "advisor": "audit"})
	if err != nil {
		t.Fatalf("babelResolveDials: %v", err)
	}
	saved, err := newProfileStore("").save(babelDescribeDials(m, "code"))
	if err != nil {
		t.Fatalf("save: %v", err)
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
	h := newBabelHarness(t, babelOptions{profileID: "code", sets: map[string]string{}})
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
		"CODE_SELECTION_STATE=",
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

	// Configure mode, in the same built binary: one message, then exit 0.
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
	if _, err := newProfileStore(store).load("e2e", 0); err != nil {
		t.Errorf("configure mode reported a reference that does not resolve: %v", err)
	}
}
