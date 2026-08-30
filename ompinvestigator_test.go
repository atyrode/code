package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// testBrokerToken is the run-scoped credential these tests plant in every job.
// It is long and non-dictionary so a substring search over an argv, an
// environment or a payload cannot match it by coincidence.
const testBrokerToken = "BROKERTOKEN4f19c8d3a72b6e05f8341ca9"

// ── fixtures ─────────────────────────────────────────────────────────────────

// fakeProfiles is a profileSource with no store behind it: the investigator
// depends on the interface, so a test never needs the real one.
type fakeProfiles struct {
	profile resolvedProfile
	err     error
	askedID string
	askedAt int
}

func (f *fakeProfiles) resolveProfile(id string, revision int) (resolvedProfile, error) {
	f.askedID, f.askedAt = id, revision
	return f.profile, f.err
}

func testProfile() resolvedProfile {
	return resolvedProfile{
		Ref:        babelProfileRef{ID: "mixed-led", Revision: 4},
		Disclosure: babelDisclosureHosted,
		Cost:       babelCost{Currency: "USD", InputPer1K: 0.003, OutputPer1K: 0.015, EstimatedRun: 0.42},
		Metadata:   map[string]string{"provider": "anthropic", "model": "claude-opus-5", "thinking": "high"},
		ConfigYAML: "modelRoles:\n  default: anthropic/claude-opus-5\n",
	}
}

func testJob(directive string, capabilities ...string) babelJob {
	job := babelJob{
		Type:     babelMessageJob,
		Protocol: babelProtocolName,
		JobID:    "job-1",
		RunID:    "run-1",
		Profile:  babelProfileRef{ID: "mixed-led", Revision: 4},
		Recipes:  []babelRecipeRef{{ID: "outcome-integrity", Version: 1}},
		Grant: babelGrant{
			Capabilities: capabilities,
			Disclosure:   babelDisclosureLocal,
		},
		Sources: []babelSource{{Kind: "session", Selector: "omp/synthetic-session"}},
		Broker:  &babelBroker{Endpoint: "http://127.0.0.1:1/evidence", Token: testBrokerToken},
	}
	if directive != "" {
		job.Params = map[string]string{babelParamConformance: directive}
	}
	return job
}

// recorder collects everything the protocol layer would have written, so a test
// can assert on the stream the investigator produced rather than on its
// internals.
type recorder struct {
	stages   []string
	messages []string
	asks     []babelToolRequest
	decide   func(babelToolRequest) babelDecision
}

func (r *recorder) emit(stage, message string, _ float64) {
	r.stages = append(r.stages, stage)
	r.messages = append(r.messages, message)
}

func (r *recorder) request(capability, tool, reason string, arguments json.RawMessage) babelDecision {
	ask := babelToolRequest{
		Capability: capability,
		Tool:       tool,
		Reason:     reason,
		Arguments:  arguments,
		RequestID:  "req-" + string(rune('0'+len(r.asks))),
	}
	r.asks = append(r.asks, ask)
	if r.decide != nil {
		return r.decide(ask)
	}
	return babelDecision{Type: babelMessageToolDecision, RequestID: ask.RequestID, Decision: babelDecisionAllow}
}

func newTestInvestigator(t *testing.T) (*ompInvestigator, *fakeProfiles) {
	t.Helper()
	profiles := &fakeProfiles{profile: testProfile()}
	inv := newOmpInvestigator(profiles)
	inv.pace = time.Millisecond
	inv.slowBudget = 50 * time.Millisecond
	inv.lookOmp = func() (string, error) { return "", errors.New("no omp in this test") }
	return inv, profiles
}

// ── containment ──────────────────────────────────────────────────────────────

func TestOmpContainmentDeclaresWhatCodeActuallyProvides(t *testing.T) {
	got := (&ompInvestigator{}).containment()
	if got.Backend == "" {
		t.Error("containment names no backend, and an unnamed mechanism cannot be assessed")
	}
	if got.FilesystemIsolation || got.NetworkDefaultDeny || got.ResourceCeilings || got.Disposable {
		t.Errorf("containment claims isolation Code does not implement: %+v", got)
	}
	if got.Escape == "" {
		t.Fatal("containment declares no escape assumption, which the contract forbids")
	}
	// The escape text is the whole value of an all-false declaration: it has to
	// say what is not contained, not merely that something is not.
	for _, want := range []string{"uid", "seccomp", "rlimit", "network", "filesystem"} {
		if !strings.Contains(got.Escape, want) {
			t.Errorf("escape statement never mentions %q: %s", want, got.Escape)
		}
	}
}

// ── resolve ──────────────────────────────────────────────────────────────────

func TestOmpResolveIsResolveOrFail(t *testing.T) {
	for _, tc := range []struct {
		name    string
		profile resolvedProfile
		err     error
		wantErr bool
	}{
		{name: "resolved", profile: testProfile()},
		{name: "store failed", err: errors.New("no such profile"), wantErr: true},
		{
			name: "no revision",
			profile: resolvedProfile{
				Ref: babelProfileRef{ID: "mixed-led"}, Disclosure: babelDisclosureLocal,
				Metadata: map[string]string{"model": "x"},
			},
			wantErr: true,
		},
		{
			name: "unknown disclosure",
			profile: resolvedProfile{
				Ref: babelProfileRef{ID: "mixed-led", Revision: 1}, Disclosure: "private",
				Metadata: map[string]string{"model": "x"},
			},
			wantErr: true,
		},
		{
			name: "no metadata",
			profile: resolvedProfile{
				Ref: babelProfileRef{ID: "mixed-led", Revision: 1}, Disclosure: babelDisclosureLocal,
			},
			wantErr: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inv := newOmpInvestigator(&fakeProfiles{profile: tc.profile, err: tc.err})
			got, err := inv.resolve(context.Background(), babelProfileRef{ID: "mixed-led", Revision: 4})
			if tc.wantErr {
				if err == nil {
					t.Fatalf("resolve succeeded with %+v; want a failure", got)
				}
				if !errors.Is(err, errOmpProfileUnavailable) {
					t.Errorf("error = %v; want it to wrap errOmpProfileUnavailable so Babel gets a code", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolve: %v", err)
			}
			if got.Profile != tc.profile.Ref {
				t.Errorf("profile = %+v; want the reference actually resolved %+v", got.Profile, tc.profile.Ref)
			}
			if got.Privacy.Disclosure != babelDisclosureHosted || !got.Privacy.RedactionRequired {
				t.Errorf("privacy = %+v; a hosted profile requires redaction", got.Privacy)
			}
			if got.Cost != tc.profile.Cost {
				t.Errorf("cost = %+v; want %+v", got.Cost, tc.profile.Cost)
			}
			if got.Metadata["model"] != "claude-opus-5" {
				t.Errorf("metadata = %v; want the resolved provider metadata", got.Metadata)
			}
			if got.Containment != nil {
				t.Error("resolve attached containment; that belongs to the protocol layer in worker mode")
			}
		})
	}
}

func TestOmpResolveWithoutAStoreFails(t *testing.T) {
	inv := &ompInvestigator{}
	if _, err := inv.resolve(context.Background(), babelProfileRef{ID: "x", Revision: 1}); !errors.Is(err, errOmpProfileUnavailable) {
		t.Fatalf("error = %v; want errOmpProfileUnavailable", err)
	}
}

func TestOmpSyntheticConfigurationEchoesOnlyForConformance(t *testing.T) {
	// The protocol layer discovers the exception through a method set, so the
	// method has to exist under exactly this shape or the exception is silently
	// never offered and the suite's synthetic profile fails to resolve.
	var resolver interface {
		syntheticConfiguration(job babelJob) babelConfiguration
	} = (*ompInvestigator)(nil)

	job := testJob(babelConformanceWellBehaved, babelCapabilityCorpusSearch)
	job.Profile = babelProfileRef{ID: "synthetic-profile", Revision: 1}
	got := resolver.syntheticConfiguration(job)
	if got.Profile != job.Profile {
		t.Errorf("profile = %+v; the suite's synthetic reference must be echoed", got.Profile)
	}
	if len(got.Metadata) == 0 {
		t.Fatal("synthetic configuration carries no metadata; a receipt requires some")
	}
	if got.Metadata["provider"] != "none" {
		t.Errorf("metadata names provider %q; nothing was resolved, so naming one would be a claim",
			got.Metadata["provider"])
	}
}

// ── capability mapping ───────────────────────────────────────────────────────

func TestOmpToolsForGrantRegistersOnlyGrantedCapabilities(t *testing.T) {
	for _, tc := range []struct {
		name         string
		capabilities []string
		want         []string
	}{
		{name: "none", capabilities: nil, want: []string{}},
		{
			name:         "corpus and repo",
			capabilities: []string{babelCapabilityRepoRead, babelCapabilityCorpusSearch},
			want:         []string{"babel_corpus_search", "babel_repo_read"},
		},
		{
			name: "all four",
			capabilities: []string{
				babelCapabilityCorpusSearch, babelCapabilitySandboxExec,
				babelCapabilityRepoRead, babelCapabilityPublicResearch,
			},
			want: []string{"babel_corpus_search", "babel_repo_read", "babel_sandbox_exec", "babel_public_research"},
		},
		{
			name:         "unknown capability grants nothing",
			capabilities: []string{"corpus-write"},
			want:         []string{},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tools := ompToolsFor(babelGrant{Capabilities: tc.capabilities})
			got := make([]string, 0, len(tools))
			for _, tool := range tools {
				got = append(got, tool.name)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("tools = %v; want %v", got, tc.want)
			}
		})
	}
}

func TestOmpHostToolParametersAreValidSchemas(t *testing.T) {
	for _, tool := range ompEvidenceTools {
		var schema map[string]any
		if err := json.Unmarshal([]byte(tool.parameters), &schema); err != nil {
			t.Errorf("%s: parameters are not valid JSON: %v", tool.name, err)
			continue
		}
		if schema["type"] != "object" {
			t.Errorf("%s: parameter schema is not an object schema", tool.name)
		}
	}
}

// ── the child's environment ──────────────────────────────────────────────────

func TestOmpChildEnvReplacesTheHomeAndDropsSecretBearingEntries(t *testing.T) {
	job := testJob("", babelCapabilityCorpusSearch)
	base := []string{
		"PATH=/usr/bin",
		"HOME=/home/operator",
		"XDG_CONFIG_HOME=/home/operator/.config",
		"OMP_PROFILE=work",
		"AMBIENT=" + testBrokerToken,
		"PI_PACKAGE_DIR=/nix/store/omp",
	}
	got := ompChildEnv(base, "/tmp/run/home", job)

	index := map[string]string{}
	for _, entry := range got {
		key, value, _ := strings.Cut(entry, "=")
		index[key] = value
	}
	if index["HOME"] != "/tmp/run/home" {
		t.Errorf("HOME = %q; want the run's private home", index["HOME"])
	}
	if index["XDG_CONFIG_HOME"] != "/tmp/run/home/.config" {
		t.Errorf("XDG_CONFIG_HOME = %q; the operator's configuration must not be discoverable", index["XDG_CONFIG_HOME"])
	}
	if _, present := index["OMP_PROFILE"]; present {
		t.Error("OMP_PROFILE survived; an ambient profile would reintroduce the operator's configuration")
	}
	if _, present := index["AMBIENT"]; present {
		t.Error("an environment entry carrying the broker token reached the child")
	}
	if index["PI_PACKAGE_DIR"] != "/nix/store/omp" {
		t.Error("PI_PACKAGE_DIR was dropped; the child needs it to find its own package")
	}
	for _, entry := range got {
		if strings.Contains(entry, testBrokerToken) {
			t.Fatalf("the broker token is in the child environment: %s", entry)
		}
	}
}

// ── Babel's evidence API ─────────────────────────────────────────────────────

func TestFetchBrokeredEvidenceCarriesTheTokenInAHeaderOnly(t *testing.T) {
	var gotAuth, gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(r.Body)
		gotBody = buf.String()
		_, _ = w.Write([]byte("three matching excerpts"))
	}))
	defer server.Close()

	got, err := fetchBrokeredEvidence(context.Background(),
		babelBroker{Endpoint: server.URL, Token: testBrokerToken},
		ompEvidenceRequest{RunID: "run-1", Capability: babelCapabilityCorpusSearch, Tool: "babel_corpus_search"})
	if err != nil {
		t.Fatalf("fetchBrokeredEvidence: %v", err)
	}
	if got != "three matching excerpts" {
		t.Errorf("evidence = %q", got)
	}
	if gotAuth != "Bearer "+testBrokerToken {
		t.Errorf("Authorization = %q; the run-scoped credential belongs in the header", gotAuth)
	}
	if strings.Contains(gotBody, testBrokerToken) {
		t.Error("the request body repeats the credential")
	}
}

func TestFetchBrokeredEvidenceReportsStatusWithoutTheBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		// A broker that echoed the header would leak it through the error path
		// if the body were reported. It must not be.
		_, _ = w.Write([]byte("denied for " + r.Header.Get("Authorization")))
	}))
	defer server.Close()

	_, err := fetchBrokeredEvidence(context.Background(),
		babelBroker{Endpoint: server.URL, Token: testBrokerToken}, ompEvidenceRequest{})
	if err == nil {
		t.Fatal("a 403 answer produced no error")
	}
	if strings.Contains(err.Error(), testBrokerToken) {
		t.Fatalf("the broker's body reached the error text: %v", err)
	}
	if !strings.Contains(err.Error(), "403") {
		t.Errorf("error = %v; want the status named", err)
	}
}

// ── the conformance directives ───────────────────────────────────────────────

func TestOmpConformanceDirectivesReachEachState(t *testing.T) {
	for _, tc := range []struct {
		name        string
		directive   string
		decide      func(babelToolRequest) babelDecision
		wantErr     bool
		wantStatus  string
		wantAsks    int
		wantAskedOn string
		wantPayload string
	}{
		{
			name: "well behaved", directive: babelConformanceWellBehaved,
			wantStatus: babelStatusOK,
		},
		{
			name: "unrecognized directive is well behaved", directive: "invented-by-a-newer-suite",
			wantStatus: babelStatusOK,
		},
		{
			name: "request tool allowed", directive: babelConformanceRequestTool,
			wantAsks: 1, wantAskedOn: babelCapabilityCorpusSearch,
			wantStatus: babelStatusOK, wantPayload: babelDecisionAllow,
		},
		{
			name: "request tool denied", directive: babelConformanceRequestTool,
			decide: func(babelToolRequest) babelDecision {
				return babelDecision{Decision: babelDecisionDeny, Code: "policy", Reason: "policy denies this"}
			},
			wantAsks: 1, wantAskedOn: babelCapabilityCorpusSearch,
			wantStatus: babelStatusPartial, wantPayload: babelDecisionDeny,
		},
		{
			name: "request ungranted", directive: babelConformanceRequestUngranted,
			decide: func(babelToolRequest) babelDecision {
				return babelDecision{Decision: babelDecisionDeny, Code: "not-granted"}
			},
			wantAsks: 1, wantAskedOn: babelCapabilitySandboxExec,
			wantStatus: babelStatusPartial, wantPayload: babelDecisionDeny,
		},
		{
			name: "error only", directive: babelConformanceErrorOnly,
			wantErr: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inv, profiles := newTestInvestigator(t)
			rec := &recorder{decide: tc.decide}
			// The conformance grant covers corpus search and repository reads
			// and deliberately not sandbox execution.
			job := testJob(tc.directive, babelCapabilityCorpusSearch, babelCapabilityRepoRead)
			// The allowed path is serviced against the job's broker, which the
			// suite points at a closed port. That must not stop the run.
			served := 0
			inv.evidence = func(context.Context, babelBroker, ompEvidenceRequest) (string, error) {
				served++
				return "one matching excerpt", nil
			}

			result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
			if profiles.askedID != "" {
				t.Error("a conformance run resolved a profile; the suite names one no store holds")
			}
			if tc.wantErr {
				if err == nil {
					t.Fatalf("directive %s produced a result instead of an error: %+v", tc.directive, result)
				}
				if result.Status != "" || result.Payload != nil {
					t.Errorf("a result accompanied the error: %+v", result)
				}
				if len(rec.stages) == 0 {
					t.Error("the failing run emitted no progress at all")
				}
				return
			}
			if err != nil {
				t.Fatalf("investigate: %v", err)
			}
			if len(rec.stages) == 0 {
				t.Error("no progress event was emitted; Babel keeps its interface responsive from these")
			}
			if result.Status != tc.wantStatus {
				t.Errorf("status = %q; want %q", result.Status, tc.wantStatus)
			}
			// The literal rather than the constant: a test that compares the
			// emitted schema against the same constant the emitter used agrees
			// with itself whatever either of them says.
			if result.Schema != "babel.analysis-result/1" {
				t.Errorf("schema = %q; Babel refuses a result declaring any other value", result.Schema)
			}
			if len(rec.asks) != tc.wantAsks {
				t.Fatalf("made %d tool requests, want %d: %+v", len(rec.asks), tc.wantAsks, rec.asks)
			}
			if tc.wantAsks == 1 {
				if rec.asks[0].Capability != tc.wantAskedOn {
					t.Errorf("asked for %q; want %q", rec.asks[0].Capability, tc.wantAskedOn)
				}
				if rec.asks[0].Reason == "" {
					t.Error("the tool request carried no reason for Babel's authorizer")
				}
			}
			if tc.wantPayload != "" && !strings.Contains(string(result.Payload), tc.wantPayload) {
				t.Errorf("payload does not report the decision received (%s): %s", tc.wantPayload, result.Payload)
			}
			if strings.Contains(string(result.Payload), testBrokerToken) {
				t.Fatal("the run-scoped broker credential is in the result payload")
			}
			for _, message := range rec.messages {
				if strings.Contains(message, testBrokerToken) {
					t.Fatal("the run-scoped broker credential is in a progress message")
				}
			}
		})
	}
}

func TestOmpConformanceSlowKeepsWorkingUntilCancelled(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	ctx, cancel := context.WithCancel(context.Background())
	rec := &recorder{}
	emitted := 0
	emit := func(stage, message string, fraction float64) {
		rec.emit(stage, message, fraction)
		// Cancel as soon as the run is demonstrably working, which is what
		// Babel's cancellation obligation does.
		emitted++
		if emitted == 1 {
			cancel()
		}
	}

	started := time.Now()
	_, err := inv.investigate(ctx, testJob(babelConformanceSlow, babelCapabilityCorpusSearch), emit, rec.request)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v; want context.Canceled", err)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Errorf("the slow run took %s to notice cancellation", elapsed)
	}
	if len(rec.stages) == 0 {
		t.Error("the slow run emitted no progress before being cancelled")
	}
}

func TestOmpConformanceSlowEndsOnItsOwnBudget(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	rec := &recorder{}
	// The budget is what a run nobody cancels ends on, rather than hanging
	// until Babel's idle timeout fires.
	inv.slowBudget = 5 * time.Millisecond
	result, err := inv.conformSlow(context.Background(), rec.emit, ompFindingsOf(testJob("", "")))
	if err != nil {
		t.Fatalf("conformSlow: %v", err)
	}
	if result.Status != babelStatusPartial {
		t.Errorf("status = %q; a run that gave up on its own schedule stopped short", result.Status)
	}
}

// TestOmpConformanceEchoTokenDisclosesTheTokenOnPurpose defends the property
// that makes Babel's redaction obligation gradeable at all. The directive asks
// this worker to leak the run's broker credential; if the worker quietly
// behaved instead, Babel's search for that token in the receipt could not fail
// and would pass without testing anything. So the assertion here is the inverse
// of the one every other directive gets above: the token must be present, in
// both of the two places a real leak reaches.
func TestOmpConformanceEchoTokenDisclosesTheTokenOnPurpose(t *testing.T) {
	inv, profiles := newTestInvestigator(t)
	rec := &recorder{}
	job := testJob(babelConformanceEchoToken, babelCapabilityCorpusSearch)

	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	if profiles.askedID != "" {
		t.Error("a conformance run resolved a profile; the suite names one no store holds")
	}
	if result.Status != babelStatusOK {
		t.Errorf("status = %q; the run did what it was asked and cut nothing short", result.Status)
	}
	if !strings.Contains(string(result.Payload), testBrokerToken) {
		t.Errorf("the result payload does not carry the token verbatim, so a redaction "+
			"downstream would have nothing to find: %s", result.Payload)
	}
	disclosed := false
	for _, message := range rec.messages {
		if strings.Contains(message, testBrokerToken) {
			disclosed = true
		}
	}
	if !disclosed {
		t.Errorf("no progress message carried the token; the directive requires at least one: %v", rec.messages)
	}
	if len(rec.asks) != 0 {
		t.Errorf("the directive made %d tool requests and needs none: %+v", len(rec.asks), rec.asks)
	}
}

// ── the real run, against a fake OMP ─────────────────────────────────────────

func TestOmpDriveRegistersOnlyTheGrantedToolsAndReportsAResult(t *testing.T) {
	inv, profiles := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "plain")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{}

	job := testJob("", babelCapabilityRepoRead, babelCapabilityCorpusSearch)
	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	if profiles.askedID != "mixed-led" || profiles.askedAt != 4 {
		t.Errorf("resolved %q@%d; want the job's profile", profiles.askedID, profiles.askedAt)
	}
	if result.Status != babelStatusOK {
		t.Errorf("status = %q; the fake run finished cleanly with output", result.Status)
	}
	if !strings.Contains(string(result.Payload), "the corpus supports the finding") {
		t.Errorf("payload carries no analysis: %s", result.Payload)
	}
	if result.Resources == nil || result.Resources.CPUSeconds <= 0 {
		t.Errorf("resources = %+v; the child's rusage was available and should be reported", result.Resources)
	}
	if len(rec.stages) == 0 {
		t.Error("the run emitted no progress")
	}

	registered := ompFakeToolNames(t, record)
	want := []string{"babel_corpus_search", "babel_repo_read"}
	if !reflect.DeepEqual(registered, want) {
		t.Fatalf("registered %v; want exactly the granted tools %v", registered, want)
	}
}

// TestOmpProductionResultDeclaresTheSchemaBabelAccepts is the check the two
// divergent schema constants got past. Babel's explore package compares the
// stored record's schema against "babel.analysis-result/1" and rejects the
// result on anything else, so a production investigator naming a format of its
// own produces runs that are all discarded after the work is done — while a
// conformance stub declaring the right one passes the suite and hides it.
//
// The value is read out of the marshalled result rather than off a constant,
// because these bytes are the real wire value: the protocol layer's emitResult
// fills Schema in only when the investigator left it empty and then writes this
// struct through writeLine unchanged, so the schema field here is the field
// Babel parses. Comparing against babelResultSchema instead would restate the
// emitter rather than check it.
//
// The job carries no conformance directive, so this reaches drive — the real
// production path — and the fake omp is the narrowest seam that gets there
// without a provider credential or a network.
func TestOmpProductionResultDeclaresTheSchemaBabelAccepts(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, _ := ompFakeBinary(t, "plain")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{}

	job := testJob("", babelCapabilityCorpusSearch)
	if job.conformanceRequested() {
		t.Fatal("the job took the conformance path, so this test never reached the production investigator")
	}
	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	line, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshalling the result the protocol layer writes: %v", err)
	}
	var onTheWire struct {
		Schema  string          `json:"schema"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(line, &onTheWire); err != nil {
		t.Fatalf("decoding the emitted result: %v", err)
	}
	if onTheWire.Schema != "babel.analysis-result/1" {
		t.Fatalf("the production investigator emitted schema %q; Babel accepts only "+
			"babel.analysis-result/1 and discards the run on anything else", onTheWire.Schema)
	}
	if len(onTheWire.Payload) == 0 {
		t.Error("the result carried no payload, so the declared schema describes nothing")
	}
}

func TestOmpDriveRegistersNothingForAnEmptyGrant(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "plain")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{}

	if _, err := inv.investigate(context.Background(), testJob(""), rec.emit, rec.request); err != nil {
		t.Fatalf("investigate: %v", err)
	}
	for _, frame := range ompFakeFrames(t, record) {
		var probe struct{ Type string }
		_ = json.Unmarshal(frame, &probe)
		if probe.Type == ompCommandSetHostTools {
			t.Fatalf("a grant with no capabilities still registered tools: %s", frame)
		}
	}
}

func TestOmpDriveServesAllowedEvidenceThroughTheBroker(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "hosttool")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }

	var gotEvidence ompEvidenceRequest
	var gotBroker babelBroker
	inv.evidence = func(_ context.Context, broker babelBroker, request ompEvidenceRequest) (string, error) {
		gotBroker, gotEvidence = broker, request
		return "excerpt: the archive agrees", nil
	}
	rec := &recorder{}

	job := testJob("", babelCapabilityCorpusSearch)
	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	if len(rec.asks) != 1 {
		t.Fatalf("made %d tool requests, want 1: %+v", len(rec.asks), rec.asks)
	}
	ask := rec.asks[0]
	if ask.Capability != babelCapabilityCorpusSearch || ask.Tool != "babel_corpus_search" {
		t.Errorf("request = %+v; want the corpus-search capability", ask)
	}
	if !strings.Contains(string(ask.Arguments), "outcome integrity") {
		t.Errorf("the model's arguments did not reach Babel's authorizer: %s", ask.Arguments)
	}
	if gotBroker.Token != testBrokerToken || gotEvidence.Capability != babelCapabilityCorpusSearch {
		t.Errorf("broker call = %+v %+v", gotBroker, gotEvidence)
	}

	answer := ompFakeHostToolResult(t, record)
	if answer.IsError {
		t.Fatalf("an allowed request was answered as a tool error: %+v", answer)
	}
	if len(answer.Result.Content) == 0 || answer.Result.Content[0].Text != "excerpt: the archive agrees" {
		t.Errorf("the evidence did not reach the model: %+v", answer.Result)
	}
	if result.Status != babelStatusOK {
		t.Errorf("status = %q; nothing was refused", result.Status)
	}
	if !strings.Contains(string(result.Payload), babelDecisionAllow) {
		t.Errorf("payload does not report the decision received: %s", result.Payload)
	}
	if result.Resources == nil || result.Resources.ToolCalls != 1 {
		t.Errorf("resources = %+v; one brokered tool call was made", result.Resources)
	}
}

func TestOmpDriveContinuesToAResultAfterADenial(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "hosttool")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	inv.evidence = func(context.Context, babelBroker, ompEvidenceRequest) (string, error) {
		t.Error("a denied request was serviced against the broker anyway")
		return "", nil
	}
	rec := &recorder{decide: func(babelToolRequest) babelDecision {
		return babelDecision{Decision: babelDecisionDeny, Code: "policy", Reason: "the corpus is out of scope"}
	}}

	job := testJob("", babelCapabilityCorpusSearch)
	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("a denial ended the run: %v", err)
	}

	answer := ompFakeHostToolResult(t, record)
	if !answer.IsError {
		t.Fatal("the refusal was not surfaced as a tool error, so the model could not adapt to it")
	}
	text := answer.Result.Content[0].Text
	for _, want := range []string{"refused", "policy", "out of scope", "without it"} {
		if !strings.Contains(text, want) {
			t.Errorf("the refusal text never mentions %q: %s", want, text)
		}
	}
	if result.Status != babelStatusPartial {
		t.Errorf("status = %q; a refused piece of evidence leaves the run short of its scope", result.Status)
	}
	if !strings.Contains(string(result.Payload), babelDecisionDeny) {
		t.Errorf("payload does not report the denial: %s", result.Payload)
	}
	if !strings.Contains(string(result.Payload), "refused") {
		t.Errorf("payload records no gap for the refused evidence: %s", result.Payload)
	}
}

func TestOmpDriveRefusesAnUnregisteredToolWithoutSpendingADecision(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "unregistered")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{}

	job := testJob("", babelCapabilityCorpusSearch)
	if _, err := inv.investigate(context.Background(), job, rec.emit, rec.request); err != nil {
		t.Fatalf("investigate: %v", err)
	}
	if len(rec.asks) != 0 {
		t.Errorf("a tool nobody registered was still put to Babel: %+v", rec.asks)
	}
	answer := ompFakeHostToolResult(t, record)
	if !answer.IsError {
		t.Fatal("an unregistered tool call was answered as a success")
	}
}

func TestOmpDriveKeepsTheBrokerTokenOutOfTheChildsArgvAndEnvironment(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "plain")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string {
		return []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=/home/operator",
			"AMBIENT_TOKEN=" + testBrokerToken,
		}
	}
	rec := &recorder{}

	job := testJob("", babelCapabilityCorpusSearch)
	if _, err := inv.investigate(context.Background(), job, rec.emit, rec.request); err != nil {
		t.Fatalf("investigate: %v", err)
	}
	got := ompFakeRead(t, record)

	for _, arg := range got.Argv {
		if strings.Contains(arg, testBrokerToken) {
			t.Fatalf("the broker token is in the child's argv: %s", arg)
		}
	}
	for _, entry := range got.Env {
		if strings.Contains(entry, testBrokerToken) {
			t.Fatalf("the broker token is in the child's environment: %s", entry)
		}
	}
	argv := strings.Join(got.Argv, " ")
	for _, want := range []string{"--mode rpc", "--no-tools", "--auto-approve", "--config"} {
		if !strings.Contains(argv, want) {
			t.Errorf("argv is missing %q: %s", want, argv)
		}
	}
	home := ""
	for _, entry := range got.Env {
		if key, value, _ := strings.Cut(entry, "="); key == "HOME" {
			home = value
		}
	}
	if home == "/home/operator" || !strings.Contains(home, "code-babel-run-") {
		t.Errorf("HOME = %q; the child must run in the run's private home", home)
	}
}

func TestOmpDriveWithoutAnOmpFails(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	rec := &recorder{}
	_, err := inv.investigate(context.Background(), testJob("", babelCapabilityCorpusSearch), rec.emit, rec.request)
	if err == nil {
		t.Fatal("a run with no omp to drive reported success")
	}
}

// ── the fake OMP ─────────────────────────────────────────────────────────────
//
// The driver needs a counterpart that speaks OMP's RPC frames, calls a host
// tool, and can be left running so a cancellation has a tree to kill. Nothing
// about that needs a provider, so the fake is this test binary re-executed
// through a one-line shell wrapper: a real process, with a real argv, a real
// environment and real children, which is what the argv, environment and
// process-tree assertions above are actually about.

// ompFakeArgv is the sentinel the wrapper plants. It is an argument rather than
// an environment variable because the driver owns the child's environment and a
// test hook has no business in it.
const ompFakeArgv = "--omp-fake"

type ompFakeRecord struct {
	Argv    []string          `json:"argv"`
	Env     []string          `json:"env"`
	Frames  []json.RawMessage `json:"frames"`
	Sleeper int               `json:"sleeper"`
}

// ompFakeBinary writes a wrapper that re-executes this test binary as the fake
// OMP, and returns the wrapper's path plus the file it records to.
func ompFakeBinary(t *testing.T, scenario string) (binary, record string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	dir := t.TempDir()
	record = filepath.Join(dir, "record.json")
	binary = filepath.Join(dir, "fake-omp")
	script := "#!/bin/sh\nexec " + shellSingleQuote(self) +
		" -test.run='^TestOmpFakeHelper$' -- " + ompFakeArgv + " " + scenario + " " +
		shellSingleQuote(record) + " \"$0\" \"$@\"\n"
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatalf("writing the fake omp: %v", err)
	}
	return binary, record
}

func shellSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func ompFakeRead(t *testing.T, record string) ompFakeRecord {
	t.Helper()
	data, err := os.ReadFile(record)
	if err != nil {
		t.Fatalf("the fake omp recorded nothing: %v", err)
	}
	var got ompFakeRecord
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("the fake omp's record does not parse: %v", err)
	}
	return got
}

func ompFakeFrames(t *testing.T, record string) []json.RawMessage {
	t.Helper()
	return ompFakeRead(t, record).Frames
}

func ompFakeToolNames(t *testing.T, record string) []string {
	t.Helper()
	for _, frame := range ompFakeFrames(t, record) {
		var command ompSetHostToolsCommand
		if err := json.Unmarshal(frame, &command); err != nil || command.Type != ompCommandSetHostTools {
			continue
		}
		names := make([]string, 0, len(command.Tools))
		for _, tool := range command.Tools {
			names = append(names, tool.Name)
		}
		return names
	}
	t.Fatal("the fake omp never received set_host_tools")
	return nil
}

func ompFakeHostToolResult(t *testing.T, record string) ompHostToolResult {
	t.Helper()
	for _, frame := range ompFakeFrames(t, record) {
		var answer ompHostToolResult
		if err := json.Unmarshal(frame, &answer); err != nil || answer.Type != ompFrameHostToolResult {
			continue
		}
		if len(answer.Result.Content) == 0 {
			t.Fatalf("the host tool result carried no content: %s", frame)
		}
		return answer
	}
	t.Fatal("the fake omp never received a host tool result")
	return ompHostToolResult{}
}

// TestOmpFakeHelper is not an assertion. It is the entry point the wrapper
// re-executes, and it exits before the testing package writes anything, because
// its stdout is the driver's RPC stream.
func TestOmpFakeHelper(t *testing.T) {
	args := ompFakeArgs()
	if args == nil {
		t.Skip("this test is the fake omp the driver tests spawn")
	}
	ompFakeMain(args)
}

func ompFakeArgs() []string {
	for i, arg := range os.Args {
		if arg == ompFakeArgv && i+2 < len(os.Args) {
			return os.Args[i+1:]
		}
	}
	return nil
}

func ompFakeMain(args []string) {
	scenario, record := args[0], args[1]
	state := ompFakeRecord{Argv: args[2:], Env: os.Environ()}
	save := func() {
		body, err := json.Marshal(state)
		if err == nil {
			_ = os.WriteFile(record, body, 0o600)
		}
	}
	save()

	if scenario == "sleeper" {
		state.Sleeper = os.Getpid()
		save()
		time.Sleep(10 * time.Minute)
		os.Exit(0)
	}

	emit := func(frame string) {
		_, _ = os.Stdout.WriteString(frame + "\n")
	}
	emit(`{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576}`)

	lines := bufio.NewScanner(os.Stdin)
	lines.Buffer(make([]byte, 0, 64<<10), ompFrameBytes)
	for lines.Scan() {
		line := bytes.TrimSpace(lines.Bytes())
		if len(line) == 0 {
			continue
		}
		state.Frames = append(state.Frames, json.RawMessage(append([]byte(nil), line...)))
		save()

		var command struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		_ = json.Unmarshal(line, &command)
		switch command.Type {
		case ompCommandSetHostTools:
			emit(`{"id":"` + command.ID + `","type":"response","command":"set_host_tools",` +
				`"success":true,"data":{"toolNames":[]}}`)
		case ompCommandPrompt:
			emit(`{"id":"` + command.ID + `","type":"response","command":"prompt",` +
				`"success":true,"data":{"agentInvoked":true}}`)
			ompFakePlay(scenario, record, &state, save, emit)
		case ompFrameHostToolResult:
			ompFakeFinish(emit)
		}
	}
	os.Exit(0)
}

// ompFakePlay is the scenario: what the fake does once it has been prompted.
func ompFakePlay(scenario, record string, state *ompFakeRecord, save func(), emit func(string)) {
	emit(`{"type":"agent_start"}`)
	emit(`{"type":"turn_start"}`)
	switch scenario {
	case "hosttool":
		emit(`{"type":"host_tool_call","id":"host_1","toolCallId":"toolu_1",` +
			`"toolName":"babel_corpus_search","arguments":{"query":"outcome integrity","limit":3}}`)
	case "unregistered":
		emit(`{"type":"host_tool_call","id":"host_1","toolCallId":"toolu_1",` +
			`"toolName":"bash","arguments":{"command":"whoami"}}`)
	case "hang":
		// A grandchild in the same process group, so a cancellation that only
		// signals the direct child leaves something measurable behind.
		self, err := os.Executable()
		if err == nil {
			child := exec.Command(self, "-test.run=^TestOmpFakeHelper$", "--",
				ompFakeArgv, "sleeper", record+".sleeper")
			if child.Start() == nil {
				state.Sleeper = child.Process.Pid
				save()
			}
		}
	default:
		ompFakeFinish(emit)
	}
}

func ompFakeFinish(emit func(string)) {
	emit(`{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"ignore me"},` +
		`"message":{"role":"assistant","content":[]}}`)
	emit(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta",` +
		`"delta":"the corpus supports the finding"},"message":{"role":"assistant","content":[]}}`)
	emit(`{"type":"turn_end"}`)
	emit(`{"type":"agent_end","messages":[],"isTerminal":true}`)
}
