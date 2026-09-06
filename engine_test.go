package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

// testProviderToken is the provider credential these tests resolve. It is long
// and non-dictionary so a substring search over an argv, an environment or a
// stream cannot match it by coincidence.
const testProviderToken = "PROVIDERTOKEN0b7d41e5c93a2f68d150ba7c"

// testAuth is a resolved credential with no broker behind it: the launcher only
// ever hands these values to the child, so a test needs the values and not a
// service.
func testAuth() ompAuth {
	return ompAuth{
		broker: brokerConfig{
			URL:           "http://127.0.0.1:1/auth",
			Token:         testProviderToken,
			SnapshotCache: "/nonexistent/snapshot-cache",
		},
		pool: map[string][]string{anthropicProvider: {"enabled-identity"}},
	}
}

// ── fixtures ─────────────────────────────────────────────────────────────────

// fakeProfiles is a profileSource with no store behind it: the launcher
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
		Ref:        profileRef{ID: "mixed-led", Revision: 4},
		Disclosure: disclosureHosted,
		Cost:       profileCost{Currency: "USD", InputPer1K: 0.003, OutputPer1K: 0.015, EstimatedRun: 0.42},
		Metadata:   map[string]string{"provider": "anthropic", "model": "claude-opus-5", "thinking": "high"},
		ConfigYAML: "modelRoles:\n  default: anthropic/claude-opus-5\n",
	}
}

// testLaunchOptions is a launch of the test profile with a runtime report in
// a private directory.
func testLaunchOptions(t *testing.T) engineOptions {
	t.Helper()
	return engineOptions{
		profile:     testProfile().Ref,
		runtimeInfo: filepath.Join(t.TempDir(), "runtime.json"),
	}
}

func newTestLauncher(t *testing.T) (*ompLauncher, *fakeProfiles) {
	t.Helper()
	profiles := &fakeProfiles{profile: testProfile()}
	l := newOmpLauncher(profiles)
	l.lookOmp = func() (string, error) { return "", errors.New("no omp in this test") }
	l.auth = func() (ompAuth, error) { return testAuth(), nil }
	// The launch tests are about the launch. They run a fake OMP that is a
	// shell script in a temporary directory — nothing a real boundary would
	// have any way to reach — so they take the path Code takes when no
	// backend came up. The boundary itself is exercised by the escape
	// scenarios in sandbox_linux_test.go, against the real thing.
	l.probe = noSandboxBackend
	return l, profiles
}

// noSandboxBackend is a backend that established nothing, which is exactly what
// Code declares on a machine where the boundary will not come up.
func noSandboxBackend(ceilings sandboxCeilings) *sandboxBackend {
	return &sandboxBackend{facts: sandboxFacts{
		backend:  sandboxBackendNone,
		ceilings: ceilings,
		degraded: []string{"this test replaced the backend, so nothing was contained"},
	}}
}

// isolateEngineEnv keeps a test off the developer's real catalog, selection,
// profile store and auth broker. The broker matters as much as the rest: a
// test that inherited the operator's exported broker variables would reach out
// to their real one.
func isolateEngineEnv(t *testing.T) string {
	t.Helper()
	store := t.TempDir()
	t.Setenv(profileStateEnv, store)
	t.Setenv("CODE_GENERATED", filepath.Join(t.TempDir(), "absent.plain"))
	// An unset CODE_SELECTION_STATE resolves to a location under
	// XDG_STATE_HOME, so relocating that root is what keeps a test off the
	// developer's real dials; the explicit "" here says "take the default" and
	// the default is now inside the sandbox.
	t.Setenv("CODE_SELECTION_STATE", "")
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	t.Setenv("CODE_RUNTIME_BROKER", "")
	// A local endpoint that answers would put the local-lane dial on screen
	// (locallane.go) and change what a ceremony test is looking at, so a test
	// points at a port nothing listens on unless it means to.
	t.Setenv(localEndpointEnv, "http://127.0.0.1:1")
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

// engineCatalogFixture renders the three-pool catalog the overlay tests use,
// so the overlay a profile replays is built from a real catalog rather than a
// hand-written approximation of one.
func engineCatalogFixture(t *testing.T) string {
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

// turnedDials builds the dial model a ceremony would show and turns the named
// dials, refusing a value no dial offers: a ceremony could never confirm it.
func turnedDials(t *testing.T, dials map[string]string) model {
	t.Helper()
	m := engineCatalogModel()
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

// mintedProfile stores one revision the way a confirmed ceremony does, for the
// tests whose subject is what happens to a profile that already exists.
func mintedProfile(t *testing.T, id string, dials map[string]string) codeProfile {
	t.Helper()
	saved, err := mintProfile(turnedDials(t, dials), id)
	if err != nil {
		t.Fatalf("minting profile %s: %v", id, err)
	}
	return saved
}

// ── containment ──────────────────────────────────────────────────────────────

// TestEngineContainmentDeclaresOnlyWhatTheBackendEstablished checks the
// direction that matters: a backend that established nothing must produce a
// declaration that claims nothing, and must still say what is therefore
// unprotected. The other direction is asserted in sandbox_linux_test.go
// against the real backend.
func TestEngineContainmentDeclaresOnlyWhatTheBackendEstablished(t *testing.T) {
	l := &ompLauncher{probe: noSandboxBackend}
	got := l.containment()
	if got.Backend == "" {
		t.Error("containment names no backend, and an unnamed mechanism cannot be assessed")
	}
	if got.FilesystemIsolation || got.NetworkDefaultDeny || got.ResourceCeilings || got.Disposable {
		t.Errorf("containment claims isolation the backend never established: %+v", got)
	}
	if got.Escape == "" {
		t.Fatal("containment declares no escape assumption, which the report forbids")
	}
	for _, want := range []string{"no sandbox", "uid", "filesystem", "network", "replaced the backend"} {
		if !strings.Contains(got.Escape, want) {
			t.Errorf("escape statement never mentions %q: %s", want, got.Escape)
		}
	}
}

// TestEngineContainmentNamesTheEndpointItsEgressAllows is the other half of
// the declaration: whichever backend came up, the escape statement has to name
// the one target the boundary opens.
func TestEngineContainmentNamesTheEndpointItsEgressAllows(t *testing.T) {
	l := &ompLauncher{probe: noSandboxBackend}
	l.profile = resolvedProfile{Metadata: map[string]string{"provider": anthropicProvider}}
	got := l.egressDescription()
	if got.provider != anthropicProvider {
		t.Errorf("provider = %q, want %q", got.provider, anthropicProvider)
	}
	if len(got.allowed) == 0 || !strings.HasSuffix(got.allowed[0], ":443") {
		t.Fatalf("the egress description allows %v; a contained run reaches its provider on 443", got.allowed)
	}
	l.profile = resolvedProfile{Metadata: map[string]string{"provider": "a-runtime-nobody-registered"}}
	if unknown := l.egressDescription(); len(unknown.allowed) != 0 {
		t.Errorf("an unplaceable provider produced an allowlist: %v", unknown.allowed)
	}
}

// ── the profile ──────────────────────────────────────────────────────────────

func TestEngineOpenProfileIsResolveOrFail(t *testing.T) {
	for _, tc := range []struct {
		name    string
		profile resolvedProfile
		err     error
		wantErr bool
	}{
		{name: "resolves", profile: testProfile()},
		{name: "store error", err: errors.New("no such profile"), wantErr: true},
		{name: "no id", profile: func() resolvedProfile { p := testProfile(); p.Ref.ID = ""; return p }(), wantErr: true},
		{name: "revision zero", profile: func() resolvedProfile { p := testProfile(); p.Ref.Revision = 0; return p }(), wantErr: true},
		{name: "unknown disclosure", profile: func() resolvedProfile { p := testProfile(); p.Disclosure = "leaky"; return p }(), wantErr: true},
		{name: "no metadata", profile: func() resolvedProfile { p := testProfile(); p.Metadata = nil; return p }(), wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l := newOmpLauncher(&fakeProfiles{profile: tc.profile, err: tc.err})
			got, err := l.openProfile(profileRef{ID: "mixed-led", Revision: 4})
			if tc.wantErr {
				if !errors.Is(err, errOmpProfileUnavailable) {
					t.Fatalf("error = %v; want errOmpProfileUnavailable", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("openProfile: %v", err)
			}
			if got.Ref != tc.profile.Ref {
				t.Errorf("resolved %+v, want %+v", got.Ref, tc.profile.Ref)
			}
		})
	}
	if _, err := (&ompLauncher{}).openProfile(profileRef{ID: "x", Revision: 1}); !errors.Is(err, errOmpProfileUnavailable) {
		t.Fatalf("a launcher with no store resolved something: %v", err)
	}
}

func TestParseProfileRef(t *testing.T) {
	for _, tc := range []struct {
		arg  string
		want profileRef
		bad  bool
	}{
		{arg: "code", want: profileRef{ID: "code"}},
		{arg: "code@7", want: profileRef{ID: "code", Revision: 7}},
		{arg: "code@0", bad: true},
		{arg: "code@x", bad: true},
		{arg: "../x@1", bad: true},
		{arg: "", bad: true},
	} {
		got, err := parseProfileRef(tc.arg)
		if tc.bad {
			if err == nil {
				t.Errorf("parseProfileRef(%q) accepted %+v", tc.arg, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("parseProfileRef(%q) = %+v, %v; want %+v", tc.arg, got, err, tc.want)
		}
	}
}

// TestEngineDescribeReportsTheProfileHalfOnly is the offline half of the
// runtime report: a client can ask what a reference means without launching
// anything, and gets exactly the fields a launch would write before it
// establishes a boundary — and none of the ones it would write after.
func TestEngineDescribeReportsTheProfileHalfOnly(t *testing.T) {
	isolateEngineEnv(t)
	t.Setenv("CODE_GENERATED", engineCatalogFixture(t))
	minted := mintedProfile(t, "code", map[string]string{"thinking": "high"})

	var out bytes.Buffer
	if status := runEngineDescribe(engineOptions{profile: profileRef{ID: "code"}}, &out); status != 0 {
		t.Fatalf("--describe exited %d", status)
	}
	var report map[string]json.RawMessage
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("--describe wrote something that is not JSON: %v\n%s", err, out.String())
	}
	if string(report["schema"]) != `"`+runtimeReportSchema+`"` {
		t.Errorf("schema = %s, want %q", report["schema"], runtimeReportSchema)
	}
	var profile profileRef
	if err := json.Unmarshal(report["profile"], &profile); err != nil || profile != minted.ref() {
		t.Errorf("profile = %s, want %+v", report["profile"], minted.ref())
	}
	for _, want := range []string{"worker", "privacy", "cost", "metadata"} {
		if _, ok := report[want]; !ok {
			t.Errorf("--describe omits %q", want)
		}
	}
	for _, absent := range []string{"containment", "finished", "exit_code", "resources"} {
		if _, ok := report[absent]; ok {
			t.Errorf("--describe claims %q, which only a launch can establish", absent)
		}
	}
	if status := runEngineDescribe(engineOptions{profile: profileRef{ID: "nobody"}}, io.Discard); status != 1 {
		t.Errorf("--describe of a missing profile exited %d, want 1", status)
	}
}

// ── the child's environment ──────────────────────────────────────────────────

func TestOmpChildEnvReplacesTheHome(t *testing.T) {
	base := []string{
		"PATH=/usr/bin",
		"HOME=/home/operator",
		"XDG_CONFIG_HOME=/home/operator/.config",
		"OMP_PROFILE=work",
		"PI_PACKAGE_DIR=/nix/store/omp",
	}
	got := ompChildEnv(base, "/tmp/run/home", testAuth())
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
	if index["PI_PACKAGE_DIR"] != "/nix/store/omp" {
		t.Error("PI_PACKAGE_DIR was dropped; the child needs it to find its own package")
	}
}

// TestOmpChildEnvReplacesAmbientAuthWithTheRunsOwnCredential is the hazard a
// hand-run `code engine` in an operator's shell creates: the shell exports a
// broker and an account-pool file, and a supervised run that inherited them
// would authenticate under a pool this run's account policy never approved.
func TestOmpChildEnvReplacesAmbientAuthWithTheRunsOwnCredential(t *testing.T) {
	auth := testAuth()
	auth.poolPath = "/tmp/run/account-pool.json"
	base := []string{
		"PATH=/usr/bin",
		"OMP_AUTH_BROKER_URL=http://ambient.invalid/auth",
		"OMP_AUTH_BROKER_TOKEN=ambient-token",
		"OMP_AUTH_BROKER_SNAPSHOT_CACHE=/ambient/cache",
		"OMP_AUTH_BROKER_ACCOUNT_POOL_FILE=/ambient/account-pool.json",
	}
	got := ompChildEnv(base, "/tmp/run/home", auth)
	for _, key := range []string{
		"OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN",
		"OMP_AUTH_BROKER_SNAPSHOT_CACHE", "OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
	} {
		var seen []string
		for _, entry := range got {
			if name, value, _ := strings.Cut(entry, "="); name == key {
				seen = append(seen, value)
			}
		}
		if len(seen) != 1 {
			t.Fatalf("%s appears %d times in the child environment: %v", key, len(seen), seen)
		}
		if strings.Contains(seen[0], "ambient") {
			t.Errorf("%s = %q; the inherited value survived into a supervised run", key, seen[0])
		}
	}
	index := map[string]string{}
	for _, entry := range got {
		key, value, _ := strings.Cut(entry, "=")
		index[key] = value
	}
	if index["OMP_AUTH_BROKER_TOKEN"] != testProviderToken {
		t.Errorf("OMP_AUTH_BROKER_TOKEN = %q; the run's own credential must be the one the child gets", index["OMP_AUTH_BROKER_TOKEN"])
	}
	if index["OMP_AUTH_BROKER_ACCOUNT_POOL_FILE"] != auth.poolPath {
		t.Errorf("OMP_AUTH_BROKER_ACCOUNT_POOL_FILE = %q, want the run's own pool %q",
			index["OMP_AUTH_BROKER_ACCOUNT_POOL_FILE"], auth.poolPath)
	}
}

func TestOmpChildEnvWithoutACredentialAddsNoBrokerVariables(t *testing.T) {
	got := ompChildEnv([]string{"PATH=/usr/bin"}, "/tmp/run/home", ompAuth{})
	for _, entry := range got {
		if strings.HasPrefix(entry, "OMP_AUTH_BROKER_") {
			t.Errorf("an unauthenticated child was given %s", entry)
		}
	}
}

// ── the launch ───────────────────────────────────────────────────────────────

// engineRun drives one launch end to end against the fake OMP: the client's
// stdin is what the test writes, the child's stdout is captured, and the
// runtime report is read back from where the launch put it.
type engineRun struct {
	status  int
	err     error
	stdout  []byte
	stderr  []byte
	report  runtimeReport
	rawInfo []byte
	record  string
	info    string
}

func serveFake(t *testing.T, l *ompLauncher, scenario string, stdin string) engineRun {
	t.Helper()
	return serveFakeCtx(t, context.Background(), l, scenario, stdin)
}

func serveFakeCtx(t *testing.T, ctx context.Context, l *ompLauncher, scenario string, stdin string) engineRun {
	t.Helper()
	fake, record := ompFakeBinary(t, scenario)
	l.lookOmp = func() (string, error) { return fake, nil }
	if l.environ == nil {
		l.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	}
	opts := testLaunchOptions(t)
	var out, errw bytes.Buffer
	status, err := l.serve(ctx, opts, strings.NewReader(stdin), &out, &errw)
	run := engineRun{status: status, err: err, stdout: out.Bytes(), stderr: errw.Bytes(), record: record, info: opts.runtimeInfo}
	if data, readErr := os.ReadFile(opts.runtimeInfo); readErr == nil {
		run.rawInfo = data
		if err := json.Unmarshal(data, &run.report); err != nil {
			t.Fatalf("the runtime report does not parse: %v\n%s", err, data)
		}
	}
	return run
}

// TestEngineForwardsTheNativeStreamAndWritesTheReport is the launch's whole
// contract in one run: the client's bytes reach the child unchanged, the
// child's bytes reach the client unchanged, the report exists before the
// first of them and is rewritten with the outcome after the last.
func TestEngineForwardsTheNativeStreamAndWritesTheReport(t *testing.T) {
	l, _ := newTestLauncher(t)
	const command = `{"id":"probe-1","type":"get_state"}` + "\n" +
		`{"id":"tools-1","type":"set_host_tools","tools":[{"name":"client_tool","description":"x","parameters":{"type":"object"}}]}` + "\n"
	run := serveFake(t, l, "echo", command)
	if run.err != nil || run.status != 0 {
		t.Fatalf("serve = %d, %v; stderr: %s", run.status, run.err, run.stderr)
	}

	// What the child received is what the client wrote, byte for byte, and
	// what the client received is what the child wrote: the fake echoes every
	// command it reads as an "echo" frame carrying the original line.
	got := ompFakeRead(t, run.record)
	if strings.Join(rawLines(got.Frames), "\n")+"\n" != command {
		t.Errorf("the child received:\n%s\nwant:\n%s", strings.Join(rawLines(got.Frames), "\n"), command)
	}
	lines := bytes.Split(bytes.TrimSpace(run.stdout), []byte("\n"))
	if len(lines) < 3 || !bytes.HasPrefix(lines[0], []byte(`{"type":"ready"`)) {
		t.Fatalf("stdout does not open with the child's ready frame:\n%s", run.stdout)
	}
	for i, want := range strings.Split(strings.TrimSpace(command), "\n") {
		var echo struct {
			Type string `json:"type"`
			Line string `json:"line"`
		}
		if err := json.Unmarshal(lines[i+1], &echo); err != nil || echo.Type != "echo" || echo.Line != want {
			t.Errorf("stdout line %d = %s; want an echo of %q", i+1, lines[i+1], want)
		}
	}

	// The report: the profile half as --describe would write it, the
	// containment the launch declared, and the outcome.
	if run.report.Schema != runtimeReportSchema || run.report.Profile != testProfile().Ref {
		t.Errorf("report names %s %+v", run.report.Schema, run.report.Profile)
	}
	if run.report.Privacy.Disclosure != disclosureHosted || !run.report.Privacy.RedactionRequired {
		t.Errorf("privacy = %+v; a hosted profile requires redaction", run.report.Privacy)
	}
	if run.report.Metadata["model"] != "claude-opus-5" {
		t.Errorf("metadata = %v", run.report.Metadata)
	}
	if run.report.Worker.Name != engineWorkerName || run.report.Worker.Version == "" {
		t.Errorf("worker = %+v", run.report.Worker)
	}
	if run.report.Containment == nil || run.report.Containment.Backend != sandboxBackendNone {
		t.Errorf("containment = %+v; want the backend this test replaced", run.report.Containment)
	}
	if run.report.Finished == nil || !*run.report.Finished {
		t.Fatalf("the report was not marked finished after the child exited: %s", run.rawInfo)
	}
	if run.report.ExitCode == nil || *run.report.ExitCode != 0 {
		t.Errorf("exit_code = %v, want 0", run.report.ExitCode)
	}
	if run.report.Resources == nil || run.report.ResourcesProvenance == "" {
		t.Errorf("the finished report carries no resources or no provenance: %s", run.rawInfo)
	}
	if strings.Contains(string(run.rawInfo), testProviderToken) {
		t.Fatal("the provider credential is in the runtime report")
	}
	info, err := os.Stat(run.info)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("the runtime report is mode %o, want 0600", info.Mode().Perm())
	}
}

func rawLines(frames []json.RawMessage) []string {
	out := make([]string, 0, len(frames))
	for _, frame := range frames {
		out = append(out, string(frame))
	}
	return out
}

// TestEngineWritesTheReportBeforeForwardingAByte pins the ordering a client
// relies on: when the first byte of the stream is readable, the report is
// already on disk. The fake writes its ready frame immediately; the launch
// must not forward it until the report exists.
func TestEngineWritesTheReportBeforeForwardingAByte(t *testing.T) {
	l, _ := newTestLauncher(t)
	fake, _ := ompFakeBinary(t, "plain")
	l.lookOmp = func() (string, error) { return fake, nil }
	l.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	opts := testLaunchOptions(t)

	stdinR, stdinW := io.Pipe()
	outR, outW := io.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = l.serve(context.Background(), opts, stdinR, outW, io.Discard)
		outW.Close()
	}()
	first := make([]byte, 1)
	if _, err := io.ReadFull(outR, first); err != nil {
		t.Fatalf("no byte reached stdout: %v", err)
	}
	if _, err := os.Stat(opts.runtimeInfo); err != nil {
		t.Fatalf("a byte reached stdout before the runtime report existed: %v", err)
	}
	stdinW.Close()
	_, _ = io.Copy(io.Discard, outR)
	<-done
}

// TestEngineRefusesBeforeStdoutWhenTheProfileIsUnavailable is the failure a
// client can act on: nothing is launched, nothing reaches stdout, no report is
// written, and the status says the launch was refused.
func TestEngineRefusesBeforeStdoutWhenTheProfileIsUnavailable(t *testing.T) {
	l, profiles := newTestLauncher(t)
	profiles.err = errors.New("no such profile")
	fake, record := ompFakeBinary(t, "plain")
	l.lookOmp = func() (string, error) { return fake, nil }
	opts := testLaunchOptions(t)
	var out bytes.Buffer
	status, err := l.serve(context.Background(), opts, strings.NewReader(""), &out, io.Discard)
	if status != 1 || !errors.Is(err, errOmpProfileUnavailable) {
		t.Fatalf("serve = %d, %v; want 1, errOmpProfileUnavailable", status, err)
	}
	if out.Len() != 0 {
		t.Errorf("a refused launch wrote to stdout: %s", out.Bytes())
	}
	if _, statErr := os.Stat(record); statErr == nil {
		t.Error("omp was launched under a profile that did not resolve")
	}
	if _, statErr := os.Stat(opts.runtimeInfo); statErr == nil {
		t.Error("a refused launch wrote a runtime report")
	}
}

// TestEngineWithoutACredentialRefusesToLaunch pins the order: no credential
// means no child, not a child that fails later for a reason nobody can trace.
func TestEngineWithoutACredentialRefusesToLaunch(t *testing.T) {
	l, _ := newTestLauncher(t)
	l.auth = func() (ompAuth, error) { return ompAuth{broker: brokerConfig{URL: "http://broker.invalid"}}, nil }
	fake, record := ompFakeBinary(t, "plain")
	l.lookOmp = func() (string, error) { return fake, nil }
	status, err := l.serve(context.Background(), testLaunchOptions(t), strings.NewReader(""), io.Discard, io.Discard)
	if status != 1 || !errors.Is(err, errOmpNoCredential) {
		t.Fatalf("serve = %d, %v; want 1, errOmpNoCredential", status, err)
	}
	if _, statErr := os.Stat(record); statErr == nil {
		t.Error("omp was launched with nothing to authenticate with")
	}
}

func TestEngineWithoutAnOmpFails(t *testing.T) {
	l, _ := newTestLauncher(t)
	status, err := l.serve(context.Background(), testLaunchOptions(t), strings.NewReader(""), io.Discard, io.Discard)
	if status != 1 || err == nil {
		t.Fatalf("a launch with no omp reported %d, %v", status, err)
	}
}

// TestEngineKeepsTheProviderCredentialOutOfArgvAndGivesItToTheChild holds the
// credential to its one channel: it is in the child's environment, where OMP
// reads it, and nowhere on argv, where a process listing would.
func TestEngineKeepsTheProviderCredentialOutOfArgvAndGivesItToTheChild(t *testing.T) {
	l, _ := newTestLauncher(t)
	l.environ = func() []string {
		return []string{"PATH=" + os.Getenv("PATH"), "HOME=/home/operator"}
	}
	run := serveFake(t, l, "plain", "")
	if run.err != nil {
		t.Fatalf("serve: %v", run.err)
	}
	got := ompFakeRead(t, run.record)
	for _, arg := range got.Argv {
		if strings.Contains(arg, testProviderToken) {
			t.Fatalf("the provider credential is in the child's argv: %s", arg)
		}
	}
	argv := strings.Join(got.Argv, " ")
	for _, want := range []string{"--mode rpc", "--no-tools", "--no-extensions", "--auto-approve", "--config"} {
		if !strings.Contains(argv, want) {
			t.Errorf("argv is missing %q: %s", want, argv)
		}
	}
	index := map[string]string{}
	for _, entry := range got.Env {
		key, value, _ := strings.Cut(entry, "=")
		index[key] = value
	}
	if index["HOME"] == "/home/operator" || !strings.Contains(index["HOME"], "code-engine-run-") {
		t.Errorf("HOME = %q; the child must run in the run's private home", index["HOME"])
	}
	want := testAuth()
	if index["OMP_AUTH_BROKER_URL"] != want.broker.URL || index["OMP_AUTH_BROKER_TOKEN"] != want.broker.Token {
		t.Error("the child received no usable provider credential, so no real run could authenticate")
	}
	if got.Pool == "" {
		t.Fatal("the child could not read the run's account pool")
	}
	var pool map[string][]string
	if err := json.Unmarshal([]byte(got.Pool), &pool); err != nil {
		t.Fatalf("the account pool the child read does not parse: %v", err)
	}
	if !reflect.DeepEqual(pool[anthropicProvider], want.pool[anthropicProvider]) {
		t.Errorf("the child's account pool = %v, want %v", pool, want.pool)
	}
	// The pool carries the run's account policy, so it is disposed of with the
	// run rather than left in a temporary directory nobody owns.
	if _, err := os.Stat(index["OMP_AUTH_BROKER_ACCOUNT_POOL_FILE"]); !os.IsNotExist(err) {
		t.Errorf("the account pool outlived the run at %q (stat error %v)",
			index["OMP_AUTH_BROKER_ACCOUNT_POOL_FILE"], err)
	}
}

// TestEngineRedactsTheProviderCredentialFromTheStream is the one thing the
// engine does to the bytes it forwards. The fake prints the credential on
// stdout — as a frame field, JSON-escaped inside a string, and on stderr the
// way an authentication failure would — and none of the three may reach the
// client.
func TestEngineRedactsTheProviderCredentialFromTheStream(t *testing.T) {
	l, _ := newTestLauncher(t)
	run := serveFake(t, l, "credleak", "")
	if run.err != nil {
		t.Fatalf("serve: %v", run.err)
	}
	if bytes.Contains(run.stdout, []byte(testProviderToken)) {
		t.Fatalf("the provider credential reached stdout:\n%s", run.stdout)
	}
	if bytes.Contains(run.stderr, []byte(testProviderToken)) {
		t.Fatalf("the provider credential reached stderr:\n%s", run.stderr)
	}
	if !bytes.Contains(run.stdout, engineRedacted) || !bytes.Contains(run.stderr, engineRedacted) {
		t.Errorf("nothing was redacted, so the leak scenario did not leak:\nstdout %s\nstderr %s", run.stdout, run.stderr)
	}
	// The frames around the leak are untouched: redaction is a substitution,
	// not a re-encoding, so the client's own decoder still reads them.
	for _, line := range bytes.Split(bytes.TrimSpace(run.stdout), []byte("\n")) {
		if !json.Valid(line) {
			t.Errorf("a forwarded line is no longer JSON: %s", line)
		}
	}
}

// TestEngineHonoursADisabledAccount runs the resolution the operator's machine
// runs — broker snapshot, selection file, pool — and checks the account they
// disabled is absent from what the child is routed through.
func TestEngineHonoursADisabledAccount(t *testing.T) {
	const snapshot = `{"credentials":[
		{"provider":"anthropic","identityKey":"kept","credential":{"type":"oauth","email":"kept@example.com"}},
		{"provider":"anthropic","identityKey":"retired","credential":{"type":"oauth","email":"retired@example.com"}}
	]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(snapshot))
	}))
	defer server.Close()

	state := filepath.Join(t.TempDir(), "accounts.json")
	selections := defaultAccountSelectionState()
	selections.SetManualDisabled(map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "retired"}: true})
	if err := writeAccountSelectionState(state, selections); err != nil {
		t.Fatalf("writing the account selection: %v", err)
	}
	t.Setenv("OMP_AUTH_BROKER_URL", server.URL)
	t.Setenv("OMP_AUTH_BROKER_TOKEN", testProviderToken)
	t.Setenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE", "")
	t.Setenv("CODE_AUTH_ACCOUNT_STATE", state)

	l, _ := newTestLauncher(t)
	l.auth = ompResolveAuth
	run := serveFake(t, l, "plain", "")
	if run.err != nil {
		t.Fatalf("serve: %v", run.err)
	}
	var pool map[string][]string
	if err := json.Unmarshal([]byte(ompFakeRead(t, run.record).Pool), &pool); err != nil {
		t.Fatalf("the account pool the child read does not parse: %v", err)
	}
	if !reflect.DeepEqual(pool[anthropicProvider], []string{"kept"}) {
		t.Errorf("the run's anthropic pool = %v, want only the account the operator left enabled", pool[anthropicProvider])
	}
}

// TestOmpResolveAuthWithNoBrokerNamesTheRemedy is the honest failure. A launch
// that proceeded anyway would produce an authentication error from inside OMP
// with no way back to the cause.
func TestOmpResolveAuthWithNoBrokerNamesTheRemedy(t *testing.T) {
	t.Setenv("OMP_AUTH_BROKER_URL", "")
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "")
	t.Setenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE", "")
	t.Setenv("CODE_AUTH_VAULTS", "")
	t.Setenv("CODE_AUTH_VAULTS_FILE", "")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	l := newOmpLauncher(&fakeProfiles{profile: testProfile()})
	err := l.resolveCredential(testProfile().Ref)
	if !errors.Is(err, errOmpNoCredential) {
		t.Fatalf("error = %v; want errOmpNoCredential", err)
	}
	for _, remedy := range []string{"OMP_AUTH_BROKER_TOKEN", ompVaultManifestName, "CODE_AUTH_VAULTS_FILE"} {
		if !strings.Contains(err.Error(), remedy) {
			t.Errorf("the failure does not name %q, so an operator cannot act on it: %v", remedy, err)
		}
	}
}

// TestOmpResolveAuthReadsCodesOwnVaultManifest is why the failure above is not
// the only outcome under a client: a curated environment exports no broker
// variables by design, but it does hand the engine the operator's real HOME,
// and the manifest and the token file it names live there.
func TestOmpResolveAuthReadsCodesOwnVaultManifest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"credentials":[]}`))
	}))
	defer server.Close()

	home := t.TempDir()
	tokenFile := filepath.Join(home, "token")
	if err := os.WriteFile(tokenFile, []byte(testProviderToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(home, ".config", "code")
	if err := os.MkdirAll(config, 0o700); err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal([]map[string]string{{"brokerUrl": server.URL, "tokenFile": tokenFile}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config, ompVaultManifestName), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OMP_AUTH_BROKER_URL", "")
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "")
	t.Setenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE", "")
	t.Setenv("CODE_AUTH_VAULTS", "")
	t.Setenv("CODE_AUTH_VAULTS_FILE", "")
	t.Setenv("CODE_AUTH_ACCOUNT_STATE", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", home)

	auth, err := ompResolveAuth()
	if err != nil {
		t.Fatalf("ompResolveAuth: %v", err)
	}
	if auth.broker.Token != testProviderToken {
		t.Error("the credential Code stores under the operator's HOME did not resolve")
	}
}

// TestEngineStdinCloseEndsTheRun is the shutdown path a client uses: it closes
// stdin, the child's stdin closes in turn, the child exits, and the finished
// report carries its status.
func TestEngineStdinCloseEndsTheRun(t *testing.T) {
	l, _ := newTestLauncher(t)
	run := serveFake(t, l, "plain", "")
	if run.err != nil || run.status != 0 {
		t.Fatalf("serve = %d, %v", run.status, run.err)
	}
	if run.report.ExitCode == nil || *run.report.ExitCode != 0 || run.report.Finished == nil || !*run.report.Finished {
		t.Errorf("finished report = %s", run.rawInfo)
	}
}

// TestEngineExitCodeIsTheChilds passes the child's own status through, so a
// client reads OMP's verdict rather than Code's opinion of it.
func TestEngineExitCodeIsTheChilds(t *testing.T) {
	l, _ := newTestLauncher(t)
	run := serveFake(t, l, "exit7", "")
	if run.err != nil || run.status != 7 {
		t.Fatalf("serve = %d, %v; want the child's 7", run.status, run.err)
	}
	if run.report.ExitCode == nil || *run.report.ExitCode != 7 {
		t.Errorf("report exit_code = %v, want 7", run.report.ExitCode)
	}
}

// ── the runtime report file ──────────────────────────────────────────────────

func TestWriteRuntimeReportIsAtomicAndPrivate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.json")
	report := runtimeReportOf(testProfile())
	if err := writeRuntimeReport(path, report); err != nil {
		t.Fatalf("writeRuntimeReport: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("mode = %o, want 0600", info.Mode().Perm())
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".code-runtime-") {
			t.Errorf("a temporary file was left behind: %s", entry.Name())
		}
	}
	finished := true
	report.Finished = &finished
	if err := writeRuntimeReport(path, report); err != nil {
		t.Fatalf("rewriting: %v", err)
	}
	data, _ := os.ReadFile(path)
	if !strings.Contains(string(data), `"finished":true`) {
		t.Errorf("the rewrite did not replace the report: %s", data)
	}
}

// ── redaction ────────────────────────────────────────────────────────────────

func TestSecretRedactorCoversRawAndEscapedForms(t *testing.T) {
	secret := "tok/en\"with\\escapes"
	r := newSecretRedactor([]string{secret, ""})
	raw := []byte("before " + secret + " after")
	if got := r.redact(raw); bytes.Contains(got, []byte(secret)) || !bytes.Contains(got, engineRedacted) {
		t.Errorf("raw form survived: %s", got)
	}
	encoded, _ := json.Marshal(map[string]string{"error": "rejected " + secret})
	if got := r.redact(encoded); bytes.Contains(got, encoded[10:len(encoded)-2]) || !bytes.Contains(got, engineRedacted) {
		t.Errorf("JSON-escaped form survived: %s", got)
	}
	if !json.Valid(r.redact(encoded)) {
		t.Errorf("redaction broke the JSON: %s", r.redact(encoded))
	}
	if newSecretRedactor(nil).active() {
		t.Error("a redactor with no secrets reports active")
	}
}

// TestSecretRedactorReassemblesChunkedFrames is the framing v2 case: a secret
// inside a chunked object is base64 and may straddle two chunks, so it is
// invisible to a line search. The object has to come out redacted and
// re-chunked exactly as OMP's own encoder would chunk it.
func TestSecretRedactorReassemblesChunkedFrames(t *testing.T) {
	r := newSecretRedactor([]string{testProviderToken})
	// An object above the physical frame cap, with the secret placed so it
	// straddles a segment boundary.
	padding := strings.Repeat("x", ompChunkSegmentBytes-30)
	object := []byte(`{"type":"big","pad":"` + padding + testProviderToken + strings.Repeat("y", ompChunkFrameBytes) + `"}`)
	var in bytes.Buffer
	in.Write(ompChunkEncode("c1", object))
	in.WriteString(`{"type":"after"}` + "\n")

	var out bytes.Buffer
	if err := r.forward(&out, &in); err != nil {
		t.Fatalf("forward: %v", err)
	}
	if bytes.Contains(out.Bytes(), []byte(testProviderToken)) {
		t.Fatal("the secret reached the output in the clear")
	}
	// Decode the output the way OMP's decoder would.
	lines := bytes.Split(bytes.TrimSpace(out.Bytes()), []byte("\n"))
	var run []ompChunkFrame
	var reassembled []byte
	for _, line := range lines[:len(lines)-1] {
		var chunk ompChunkFrame
		if err := json.Unmarshal(line, &chunk); err != nil || chunk.Type != "rpc_chunk" {
			t.Fatalf("output line is not a chunk: %s", line[:min(len(line), 80)])
		}
		if err := ompChunkValid(chunk, run); err != nil {
			t.Fatalf("re-chunked output is not a run OMP's decoder accepts: %v", err)
		}
		run = append(run, chunk)
		segment, _ := base64.StdEncoding.DecodeString(chunk.Data)
		reassembled = append(reassembled, segment...)
	}
	if len(run) != run[0].Count || len(reassembled) != run[0].ByteLength {
		t.Fatalf("re-chunked run has %d of %d chunks, %d of %d bytes", len(run), run[0].Count, len(reassembled), run[0].ByteLength)
	}
	want := bytes.ReplaceAll(object, []byte(testProviderToken), engineRedacted)
	if !bytes.Equal(reassembled, want) {
		t.Error("the reassembled object is not the original with the secret redacted")
	}
	if string(lines[len(lines)-1]) != `{"type":"after"}` {
		t.Errorf("the line after the run was altered: %s", lines[len(lines)-1])
	}

	// A redacted object that shrinks below the cap goes out as one line.
	small := []byte(`{"type":"small","pad":"` + strings.Repeat("z", ompChunkFrameBytes-40) + testProviderToken + `"}`)
	in.Reset()
	in.Write(ompChunkEncode("c2", small))
	if len(bytes.Split(bytes.TrimSpace(in.Bytes()), []byte("\n"))) < 2 {
		t.Fatal("the fixture did not chunk; the object is not above the cap")
	}
	out.Reset()
	if err := r.forward(&out, &in); err != nil {
		t.Fatalf("forward: %v", err)
	}
	if bytes.Count(out.Bytes(), []byte("\n")) != 1 || bytes.HasPrefix(out.Bytes(), ompChunkPrefix) {
		t.Errorf("an object that shrank below the frame cap was still chunked")
	}
}

func TestSecretRedactorRefusesAnInterruptedChunkRun(t *testing.T) {
	r := newSecretRedactor([]string{testProviderToken})
	object := []byte(`{"pad":"` + strings.Repeat("x", ompChunkFrameBytes+1) + `"}`)
	chunks := bytes.Split(bytes.TrimSpace(ompChunkEncode("c3", object)), []byte("\n"))
	var in bytes.Buffer
	in.Write(chunks[0])
	in.WriteString("\n" + `{"type":"interloper"}` + "\n")
	if err := r.forward(io.Discard, &in); err == nil {
		t.Error("an interrupted chunk run was forwarded")
	}
}

// TestSecretRedactorForwardsAnOversizedLine is the degraded path for a child
// that writes a line longer than any OMP frame: it is forwarded rather than
// refused, and a secret straddling two pieces is still redacted.
func TestSecretRedactorForwardsAnOversizedLine(t *testing.T) {
	for name, prefix := range map[string]int{
		"reader boundary": ompFrameBytes - 10,
		"carry boundary":  2*ompFrameBytes - len(testProviderToken),
	} {
		t.Run(name, func(t *testing.T) {
			r := newSecretRedactor([]string{testProviderToken})
			line := strings.Repeat("a", prefix) + testProviderToken + strings.Repeat("b", ompFrameBytes) + "\n"
			var out bytes.Buffer
			if err := r.forward(&out, strings.NewReader(line)); err != nil {
				t.Fatalf("forward: %v", err)
			}
			if bytes.Contains(out.Bytes(), []byte(testProviderToken)) {
				t.Fatal("a secret straddling a streaming boundary reached the output")
			}
			if want := strings.ReplaceAll(line, testProviderToken, string(engineRedacted)); out.String() != want {
				t.Error("forwarding changed bytes outside the credential")
			}
		})
	}
}

// ── the fake OMP ─────────────────────────────────────────────────────────────
//
// The launch needs a counterpart that opens with a ready frame, records what
// it was given, and can be left running so a cancellation has a tree to kill.
// Nothing about that needs a provider, so the fake is this test binary
// re-executed through a one-line shell wrapper: a real process, with a real
// argv, a real environment and real children.

const ompFakeArgv = "--omp-fake"

type ompFakeRecord struct {
	Argv    []string          `json:"argv"`
	Env     []string          `json:"env"`
	Frames  []json.RawMessage `json:"frames"`
	Sleeper int               `json:"sleeper"`
	// Pool is the account-pool document as the child managed to read it. The
	// launch deletes the run directory when the run ends, so a test that only
	// looked at the path afterwards could not tell a readable pool from a
	// name.
	Pool string `json:"pool"`
	// ModelEndpoint is where the child was told the model is served, and
	// ModelReached is what it got by asking. Together they are the local
	// lane's whole claim (locallane.go).
	ModelEndpoint string `json:"model_endpoint,omitempty"`
	ModelReached  string `json:"model_reached,omitempty"`
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

// TestOmpFakeHelper is not an assertion. It is the entry point the wrapper
// re-executes, and it exits before the testing package writes anything, because
// its stdout is the client's stream.
func TestOmpFakeHelper(t *testing.T) {
	args := ompFakeArgs()
	if args == nil {
		t.Skip("this test is the fake omp the launch tests spawn")
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
	if pool, err := os.ReadFile(os.Getenv("OMP_AUTH_BROKER_ACCOUNT_POOL_FILE")); err == nil {
		state.Pool = string(pool)
	}
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
	if scenario == "localmodel" {
		// A real OMP discovers a local engine's models at this route before it
		// calls one. What matters is which address the child was handed, and
		// whether anything answers there.
		state.ModelEndpoint = os.Getenv("OLLAMA_BASE_URL")
		state.ModelReached = ompFakeGet(state.ModelEndpoint + "/api/tags")
		save()
	}

	emit := func(frame string) {
		_, _ = os.Stdout.WriteString(frame + "\n")
	}
	emit(`{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576}`)

	if scenario == "credleak" {
		// The child prints the provider credential everywhere a real OMP
		// might: on stderr the way an authentication failure would, as a raw
		// frame field, and JSON-escaped inside a string. From here only the
		// engine's own redaction keeps it off the client's stream.
		token := os.Getenv("OMP_AUTH_BROKER_TOKEN")
		_, _ = os.Stderr.WriteString("omp: authentication rejected for " + token + "\n")
		emit(`{"type":"diag","token":"` + token + `"}`)
		escaped, _ := json.Marshal("rejected \"" + token + "\"")
		emit(`{"type":"diag","message":` + string(escaped) + `}`)
	}
	if scenario == "hang" {
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
	}

	lines := bufio.NewScanner(os.Stdin)
	lines.Buffer(make([]byte, 0, 64<<10), ompFrameBytes)
	for lines.Scan() {
		line := bytes.TrimSpace(lines.Bytes())
		if len(line) == 0 {
			continue
		}
		state.Frames = append(state.Frames, json.RawMessage(append([]byte(nil), line...)))
		save()
		if scenario == "echo" {
			encoded, _ := json.Marshal(string(line))
			emit(`{"type":"echo","line":` + string(encoded) + `}`)
		}
	}
	if scenario == "hang" {
		time.Sleep(10 * time.Minute)
	}
	if scenario == "exit7" {
		os.Exit(7)
	}
	os.Exit(0)
}
