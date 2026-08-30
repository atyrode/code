//go:build linux

package main

// The escape scenarios.
//
// A containment declaration is a claim about what an attacker who owns the
// model cannot do, and the only honest way to hold a claim like that is to try
// it. Every test in this file runs the real backend on the machine the suite is
// running on and attempts the violation the declaration says is impossible:
// writing outside the grant, reaching a host the allowlist does not name,
// forking without limit, allocating without limit, leaving something behind,
// and surviving a cancellation.
//
// Each one also proves it would notice. A test that passes because the payload
// never really tried is worse than no test, so every scenario is paired with a
// control in which the protection is removed — a looser ceiling, no boundary at
// all, a different working directory — and the same payload is shown to
// succeed. Where a control cannot be run, the test says so rather than passing
// quietly.
//
// If the backend cannot come up here, these tests skip loudly and name the
// property that therefore went unverified. A silent skip on this file would
// leave the declaration untested and the suite green, which is precisely the
// failure this file exists to prevent.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// ── the payload ──────────────────────────────────────────────────────────────

// sandboxScenarioArgv marks the argv tail this test binary reads its scenario
// from. The payload has to be a program that already exists inside the sandbox,
// and the only one there is Code's own binary — which, under `go test`, is this
// test binary.
const sandboxScenarioArgv = "--sandbox-scenario"

// sandboxScenarioResult is what a payload reports on stdout, as one JSON line.
type sandboxScenarioResult struct {
	OK      bool     `json:"ok"`
	Err     string   `json:"err,omitempty"`
	Count   int      `json:"count,omitempty"`
	Bytes   int64    `json:"bytes,omitempty"`
	Routes  int      `json:"routes,omitempty"`
	Entries []string `json:"entries,omitempty"`
	Text    string   `json:"text,omitempty"`
	// Tmpfs lists the reported directories the kernel says are tmpfs-backed.
	// It is what makes disposability checkable rather than inferred: a scratch
	// on any host filesystem outlives the mount namespace by definition.
	Tmpfs []string `json:"tmpfs,omitempty"`
}

// sandboxTmpfsMagic is TMPFS_MAGIC from the kernel's magic.h.
const sandboxTmpfsMagic = 0x01021994

func sandboxIsTmpfs(dir string) bool {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(dir, &fs); err != nil {
		return false
	}
	return fs.Type == sandboxTmpfsMagic
}

func sandboxScenarioArgs() []string {
	for i, arg := range os.Args {
		if arg == sandboxScenarioArgv {
			return os.Args[i+1:]
		}
	}
	return nil
}

// TestSandboxScenarioHelper is not an assertion. It is the entry point the
// escape scenarios re-execute inside the sandbox, and it exits before the
// testing package writes anything, because its stdout is the scenario's report.
func TestSandboxScenarioHelper(t *testing.T) {
	args := sandboxScenarioArgs()
	if args == nil {
		t.Skip("this test is the payload the sandbox escape scenarios run inside")
	}
	os.Exit(runSandboxScenario(args))
}

func sandboxScenarioSay(result sandboxScenarioResult) int {
	body, err := json.Marshal(result)
	if err != nil {
		fmt.Fprintln(os.Stderr, "scenario:", err)
		return 2
	}
	os.Stdout.Write(append(body, '\n'))
	return 0
}

// runSandboxScenario is the payload. Every branch is an attempt to do something
// the declaration says cannot be done, reported rather than asserted: the
// assertion belongs to the parent, which knows whether the protection was in
// place.
func runSandboxScenario(args []string) int {
	switch args[0] {
	case "observe":
		entries, _ := os.ReadDir("/")
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		cwd, _ := os.Getwd()
		here, _ := os.ReadDir(cwd)
		for _, entry := range here {
			names = append(names, "cwd/"+entry.Name())
		}
		return sandboxScenarioSay(sandboxScenarioResult{
			OK: true, Entries: names, Routes: sandboxRouteCount(), Text: cwd,
		})

	case "write":
		err := os.WriteFile(args[1], []byte("the sandbox reached a host path\n"), 0o600)
		return sandboxScenarioSay(sandboxScenarioResult{OK: err == nil, Err: errText(err)})

	case "read":
		body, err := os.ReadFile(args[1])
		return sandboxScenarioSay(sandboxScenarioResult{
			OK: err == nil, Err: errText(err), Text: string(body),
		})

	case "connect":
		// Straight TCP, no proxy: the question is whether the sandbox's network
		// namespace has any route to the address at all.
		conn, err := net.DialTimeout("tcp", args[1], 3*time.Second)
		if err == nil {
			conn.Close()
		}
		return sandboxScenarioSay(sandboxScenarioResult{
			OK: err == nil, Err: errText(err), Routes: sandboxRouteCount(),
		})

	case "proxy-connect":
		// One HTTP CONNECT through whatever PI_PROXY names, reported by status
		// line. This is what OMP's fetch does for a provider request.
		status, err := sandboxScenarioConnect(args[1], args[2])
		return sandboxScenarioSay(sandboxScenarioResult{
			OK: err == nil && strings.Contains(status, " 200 "), Err: errText(err), Text: status,
		})

	case "spawn":
		// A fork bomb with a counter. It reports how far it got, which is the
		// only interesting number: unbounded means the ceiling is not there.
		want, _ := strconv.Atoi(args[1])
		started := 0
		var last error
		children := make([]*exec.Cmd, 0, want)
		for range want {
			child := exec.Command(os.Args[0], "-test.run=^TestSandboxScenarioHelper$", "--",
				sandboxScenarioArgv, "hold", "30")
			child.Stdout, child.Stderr = io.Discard, io.Discard
			if err := child.Start(); err != nil {
				last = err
				break
			}
			children = append(children, child)
			started++
		}
		for _, child := range children {
			_ = child.Process.Kill()
			_ = child.Wait()
		}
		return sandboxScenarioSay(sandboxScenarioResult{
			OK: last == nil, Count: started, Err: errText(last),
		})

	case "memhog":
		// Allocate and touch, so the pages are resident and charged to the
		// cgroup rather than merely reserved.
		mib, _ := strconv.Atoi(args[1])
		held := make([][]byte, 0, mib)
		for i := range mib {
			block := make([]byte, 1<<20)
			for offset := 0; offset < len(block); offset += 4096 {
				block[offset] = byte(i)
			}
			held = append(held, block)
		}
		return sandboxScenarioSay(sandboxScenarioResult{OK: true, Count: len(held)})

	case "fill":
		// Write into every scratch directory and report what it cost, so the
		// disposability test has a non-zero number to prove vanished — and what
		// each one is backed by, so "it vanished" cannot mean "it was written
		// somewhere the test did not look".
		var total int64
		var tmpfs []string
		for _, dir := range args[1:] {
			path := filepath.Join(dir, "written-by-the-run")
			body := strings.Repeat("x", 64<<10)
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				return sandboxScenarioSay(sandboxScenarioResult{Err: errText(err)})
			}
			total += int64(len(body))
			if sandboxIsTmpfs(dir) {
				tmpfs = append(tmpfs, dir)
			}
		}
		return sandboxScenarioSay(sandboxScenarioResult{OK: true, Bytes: total, Tmpfs: tmpfs})

	case "hold":
		seconds, _ := strconv.Atoi(args[1])
		time.Sleep(time.Duration(seconds) * time.Second)
		return 0

	case "tree":
		// Two children and then a wait, so the parent has a tree to reap rather
		// than a single process.
		count, _ := strconv.Atoi(args[1])
		for range count {
			child := exec.Command(os.Args[0], "-test.run=^TestSandboxScenarioHelper$", "--",
				sandboxScenarioArgv, "hold", "120")
			child.Stdout, child.Stderr = io.Discard, io.Discard
			if err := child.Start(); err != nil {
				return sandboxScenarioSay(sandboxScenarioResult{Err: errText(err)})
			}
		}
		_ = sandboxScenarioSay(sandboxScenarioResult{OK: true, Count: count})
		time.Sleep(120 * time.Second)
		return 0
	}
	fmt.Fprintln(os.Stderr, "scenario: unknown mode", args[0])
	return 2
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// ── the harness ──────────────────────────────────────────────────────────────

// sandboxTestBackend probes the real backend, or refuses to pretend it ran.
//
// The skip names the property that went unverified and writes to stderr as well
// as to the test log, because a `go test` without -v prints a skip nowhere an
// operator would see it, and an unverified containment claim is exactly the
// thing that must not pass unnoticed.
//
// In CI that is not enough. A skip there retires the gate for everyone: the
// escape scenarios are the only evidence that the boundary Babel refuses runs
// without actually holds, so a green pipeline that ran none of them is worse
// than a red one. Where CI is set, or where the operator asks for the
// guarantee explicitly, an absent backend is a failure instead.
func sandboxTestBackend(t *testing.T) *sandboxBackend {
	t.Helper()
	backend := newSandboxBackend(defaultSandboxCeilings())
	if backend.facts.backend != sandboxBackendFull {
		reason := strings.Join(backend.facts.degraded, "; ")
		message := "UNVERIFIED: the full containment backend (" + sandboxBackendFull +
			") did not come up on this machine, so the filesystem, network, resource-ceiling, " +
			"disposability and reaping properties of Code's sandbox are NOT tested by this run. " +
			"Backend probed as " + backend.facts.backend + ": " + reason
		fmt.Fprintln(os.Stderr, "sandbox escape scenarios: "+message)
		if sandboxGateIsRequired() {
			t.Fatal(message + "\n\nThis is a failure rather than a skip because " +
				sandboxGateReason() + ". Install bubblewrap and provide a user " +
				"systemd session, or unset the variable to accept an unverified boundary.")
		}
		t.Skip(message)
	}
	return backend
}

// sandboxGateIsRequired reports whether an absent backend must fail.
//
// CI is the load-bearing case and needs no opt-in, since a pipeline is exactly
// where a silent skip becomes everyone's problem. CODE_REQUIRE_SANDBOX exists
// for a developer who wants the same guarantee locally, and can be set to "0"
// to opt a CI job out deliberately rather than by accident.
func sandboxGateIsRequired() bool {
	if v, ok := os.LookupEnv("CODE_REQUIRE_SANDBOX"); ok {
		return v != "" && v != "0"
	}
	return os.Getenv("CI") != ""
}

func sandboxGateReason() string {
	if _, ok := os.LookupEnv("CODE_REQUIRE_SANDBOX"); ok {
		return "CODE_REQUIRE_SANDBOX is set"
	}
	return "CI is set, and a skipped gate in CI retires it for every later change"
}

// sandboxWithCeilings copies a probed backend with different limits. The
// scenarios use it to run the production launch path against a ceiling tight
// enough to hit in a test, and against a loose one as the control.
func sandboxWithCeilings(backend *sandboxBackend, ceilings sandboxCeilings) *sandboxBackend {
	copied := *backend
	copied.ceilings = ceilings
	return &copied
}

// sandboxPayloadArgv re-enters this test binary inside the sandbox.
func sandboxPayloadArgv(args ...string) []string {
	return append([]string{sandboxHelperPath, "-test.run=^TestSandboxScenarioHelper$", "--",
		sandboxScenarioArgv}, args...)
}

// sandboxOutcome is one payload run, as the parent sees it.
type sandboxOutcome struct {
	result   sandboxScenarioResult
	reported bool
	exitCode int
	signal   syscall.Signal
	stderr   string
	pid      int
}

// sandboxRunInside launches a payload through the real boundary and waits for
// it. Nothing survives the call: the whole process group is killed on the way
// out whether the payload finished or not.
func sandboxRunInside(t *testing.T, backend *sandboxBackend, mounts sandboxMounts, cwd string,
	env []string, timeout time.Duration, args ...string,
) sandboxOutcome {
	t.Helper()
	argv := backend.enter(mounts, cwd, sandboxPayloadArgv(args...)...)
	// The transient scope is registered over the user session bus, which Babel
	// strips from a worker's environment and sandboxScopeTool therefore derives
	// — so a launch carries it explicitly, and so must this one.
	return sandboxRunArgv(t, argv, append(append([]string(nil), backend.scopeEnv...), env...), timeout, nil)
}

func sandboxRunArgv(t *testing.T, argv, env []string, timeout time.Duration,
	whileRunning func(pid int),
) sandboxOutcome {
	t.Helper()
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Args = argv
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH")}, env...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var out, errOut strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &errOut
	if err := cmd.Start(); err != nil {
		t.Fatalf("the sandbox would not start: %v", err)
	}
	outcome := sandboxOutcome{pid: cmd.Process.Pid}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	if whileRunning != nil {
		whileRunning(cmd.Process.Pid)
	}
	select {
	case <-done:
	case <-time.After(timeout):
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		t.Errorf("the payload did not finish within %s; stderr: %s", timeout, errOut.String())
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)

	outcome.stderr = errOut.String()
	if state := cmd.ProcessState; state != nil {
		outcome.exitCode = state.ExitCode()
		if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			outcome.signal = status.Signal()
		}
	}
	for _, line := range strings.Split(out.String(), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.HasPrefix(line, "{") {
			continue
		}
		var result sandboxScenarioResult
		if json.Unmarshal([]byte(line), &result) == nil {
			outcome.result, outcome.reported = result, true
		}
	}
	return outcome
}

// sandboxRunOutside runs the same payload with no boundary at all. It is the
// control every filesystem and network scenario is measured against: a payload
// that cannot do the thing even unconfined proves nothing about the sandbox.
func sandboxRunOutside(t *testing.T, env []string, timeout time.Duration, args ...string) sandboxOutcome {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	argv := append([]string{self, "-test.run=^TestSandboxScenarioHelper$", "--", sandboxScenarioArgv}, args...)
	return sandboxRunArgv(t, argv, env, timeout, nil)
}

func sandboxTestMounts(t *testing.T, backend *sandboxBackend, extra ...string) sandboxMounts {
	t.Helper()
	mounts := sandboxMounts{scratch: []string{sandboxRoot}}
	mounts.bindSame(sandboxStore)
	for _, path := range extra {
		mounts.bindSame(path)
	}
	mounts.bindAt(backend.helper, sandboxHelperPath)
	return mounts
}

// ── 1. the filesystem ────────────────────────────────────────────────────────

func TestSandboxRefusesAHostPathOutsideTheGrant(t *testing.T) {
	backend := sandboxTestBackend(t)
	host := t.TempDir()
	secret := filepath.Join(host, "host-state")
	original := "state the host keeps and the run must not touch\n"
	if err := os.WriteFile(secret, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	// The control first, so a payload that cannot write anywhere at all cannot
	// masquerade as containment.
	if control := sandboxRunOutside(t, nil, 20*time.Second, "write", secret); !control.result.OK {
		t.Fatalf("the control could not write the host path unconfined (%s), so the sandboxed "+
			"result would prove nothing", control.result.Err)
	}
	if err := os.WriteFile(secret, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	mounts := sandboxTestMounts(t, backend)
	inside := sandboxRunInside(t, backend, mounts, sandboxWorkPath, nil, 30*time.Second, "write", secret)
	if !inside.reported {
		t.Fatalf("the payload never reported; stderr: %s", inside.stderr)
	}
	if inside.result.OK {
		t.Error("the sandbox wrote a host path outside the grant, so filesystem_isolation is a false claim")
	}
	body, err := os.ReadFile(secret)
	if err != nil || string(body) != original {
		t.Errorf("the host path changed under the sandbox: %q (%v)", string(body), err)
	}

	// Reading is denied too, and for the same reason it has to be checked
	// separately: a boundary that stops writes and leaks reads still discloses
	// everything the invoking user can see.
	read := sandboxRunInside(t, backend, mounts, sandboxWorkPath, nil, 30*time.Second, "read", secret)
	if read.result.OK || strings.Contains(read.result.Text, "state the host keeps") {
		t.Error("the sandbox read a host path outside the grant")
	}
}

func TestSandboxBindsTheGrantsCorpusReadOnly(t *testing.T) {
	backend := sandboxTestBackend(t)
	corpus := t.TempDir()
	if err := os.WriteFile(filepath.Join(corpus, "note.md"), []byte("corpus material\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	mounts := sandboxTestMounts(t, backend, corpus)

	read := sandboxRunInside(t, backend, mounts, sandboxWorkPath, nil, 30*time.Second,
		"read", filepath.Join(corpus, "note.md"))
	if !read.result.OK || !strings.Contains(read.result.Text, "corpus material") {
		t.Fatalf("the grant's corpus was not readable inside the sandbox: %+v", read.result)
	}
	write := sandboxRunInside(t, backend, mounts, sandboxWorkPath, nil, 30*time.Second,
		"write", filepath.Join(corpus, "note.md"))
	if write.result.OK {
		t.Error("the sandbox wrote to the corpus, which is bound read-only; an analysis that can " +
			"rewrite its own evidence has no evidence")
	}
	if body, err := os.ReadFile(filepath.Join(corpus, "note.md")); err != nil ||
		!strings.Contains(string(body), "corpus material") {
		t.Errorf("the corpus changed on the host: %q (%v)", string(body), err)
	}
}

// TestSandboxKeepsTheCorpusOutOfTheWorkingDirectory guards the one mount-layout
// property that nothing else can guard.
//
// OMP registers MCP servers from a config file at the root of its working
// directory, even under a private HOME, and an MCP tool reaches the network
// without passing Babel's evidence broker. Archive content is untrusted by
// contract, so a corpus mounted at the working directory would let a .mcp.json
// in archived material register unbrokered egress before the model is asked
// anything at all. The control runs the same corpus as the working directory
// and shows the file does appear at cwd root there, which is what makes this a
// test of the layout rather than of the fixture.
func TestSandboxKeepsTheCorpusOutOfTheWorkingDirectory(t *testing.T) {
	backend := sandboxTestBackend(t)
	corpus := t.TempDir()
	hostile := filepath.Join(corpus, ".mcp.json")
	if err := os.WriteFile(hostile, []byte(`{"mcpServers":{"probe":{"command":"/nonexistent"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	mounts := sandboxTestMounts(t, backend, corpus)

	observed := sandboxRunInside(t, backend, mounts, sandboxWorkPath, nil, 30*time.Second, "observe")
	if !observed.reported {
		t.Fatalf("the payload never reported; stderr: %s", observed.stderr)
	}
	if observed.result.Text != sandboxWorkPath {
		t.Errorf("the working directory is %q, want the sandbox's own %q", observed.result.Text, sandboxWorkPath)
	}
	for _, entry := range observed.result.Entries {
		if strings.HasPrefix(entry, "cwd/") {
			t.Errorf("the working directory is not empty: %s; anything at its root is an MCP "+
				"discovery source", entry)
		}
	}

	// The control: the same corpus, made the working directory. The file is
	// there, which is what the production layout is avoiding.
	control := sandboxRunInside(t, backend, mounts, corpus, nil, 30*time.Second, "observe")
	found := false
	for _, entry := range control.result.Entries {
		if entry == "cwd/.mcp.json" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the control did not see .mcp.json at the working directory root (%v), so the "+
			"assertion above proves nothing about where the corpus is mounted", control.result.Entries)
	}
}

// ── 2. the network ───────────────────────────────────────────────────────────

func TestSandboxHasNoRouteOffTheMachine(t *testing.T) {
	backend := sandboxTestBackend(t)
	// A host-side service the payload will try to reach directly. It is on
	// loopback, which is the strongest form of the question: the sandbox has a
	// loopback of its own, so reaching this one would mean the namespace is not
	// a namespace.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	address := listener.Addr().String()

	control := sandboxRunOutside(t, nil, 20*time.Second, "connect", address)
	if !control.result.OK {
		t.Fatalf("the control could not reach the host service unconfined (%s), so the sandboxed "+
			"result would prove nothing", control.result.Err)
	}
	if control.result.Routes <= 0 {
		t.Fatalf("the host itself reports %d routes, so an empty routing table inside proves nothing",
			control.result.Routes)
	}

	mounts := sandboxTestMounts(t, backend)
	inside := sandboxRunInside(t, backend, mounts, sandboxWorkPath, nil, 30*time.Second, "connect", address)
	if !inside.reported {
		t.Fatalf("the payload never reported; stderr: %s", inside.stderr)
	}
	if inside.result.OK {
		t.Error("the sandbox reached a host service directly, so network_default_deny is a false claim")
	}
	if inside.result.Routes != 0 {
		t.Errorf("the sandbox's network namespace carries %d route(s); it must carry none",
			inside.result.Routes)
	}
}

func TestSandboxEgressAllowsOnlyTheResolvedEndpoint(t *testing.T) {
	backend := sandboxTestBackend(t)

	allowed, allowedAddr := sandboxTestServer(t)
	defer allowed.Close()
	refused, refusedAddr := sandboxTestServer(t)
	defer refused.Close()

	dir := t.TempDir()
	egress, err := newSandboxEgress(filepath.Join(dir, "egress"),
		sandboxEgressPolicy{allowed: []string{allowedAddr}})
	if err != nil {
		t.Fatalf("opening the egress: %v", err)
	}
	defer egress.close()

	mounts := sandboxTestMounts(t, backend)
	mounts.bindAt(egress.proxySocket(), sandboxProxySock)
	spec := sandboxSpec{ProxyPort: sandboxProxyPort, ProxySocket: sandboxProxySock}
	encoded, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	env := []string{sandboxSpecEnv + "=" + string(encoded)}

	// The forwarder has to be running for either half of this, so the payload
	// goes through the production guest command rather than beside it.
	run := func(target string) sandboxScenarioResult {
		t.Helper()
		argv := backend.enter(mounts, sandboxWorkPath,
			append([]string{sandboxHelperPath, sandboxHelperCommand, sandboxHelperEgress, "--"},
				sandboxPayloadArgv("proxy-connect", sandboxProxyURL, target)...)...)
		outcome := sandboxRunArgv(t, argv,
			append(append([]string(nil), backend.scopeEnv...), env...), 30*time.Second, nil)
		if !outcome.reported {
			t.Fatalf("the payload never reported for %s; stderr: %s", target, outcome.stderr)
		}
		return outcome.result
	}

	if got := run(allowedAddr); !got.OK {
		t.Fatalf("the allowlisted endpoint was not reachable through the proxy (%q, %s), so a refusal "+
			"below would prove only that the proxy is broken", got.Text, got.Err)
	}
	if got := run(refusedAddr); got.OK {
		t.Errorf("the proxy tunnelled to a target that is not on the allowlist: %q", got.Text)
	} else if !strings.Contains(got.Text, "403") {
		t.Errorf("the proxy refused with %q; a reviewer reading the record needs a refusal, not a "+
			"connection failure", got.Text)
	}

	// The refusal has to be observable, because an unobservable refusal cannot
	// become the evidence the receipt carries.
	attempts := egress.attemptLog()
	var sawAllowed, sawRefused bool
	for _, attempt := range attempts {
		switch {
		case attempt.Target == allowedAddr && attempt.Allowed:
			sawAllowed = true
		case attempt.Target == refusedAddr && !attempt.Allowed:
			sawRefused = true
		}
	}
	if !sawAllowed || !sawRefused {
		t.Errorf("the egress log does not record both outcomes: %+v", attempts)
	}
}

func sandboxTestServer(t *testing.T) (net.Listener, string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	return listener, listener.Addr().String()
}

// ── 3. tasks ─────────────────────────────────────────────────────────────────

func TestSandboxBoundsAForkBombByTasksMax(t *testing.T) {
	backend := sandboxTestBackend(t)
	mounts := sandboxTestMounts(t, backend)
	const attempts = 60

	// The control runs the identical loop under the production ceiling, which
	// is loose enough for it to finish. Same payload, same boundary, one
	// number different — so a failure below is the ceiling and nothing else.
	control := sandboxRunInside(t, backend, mounts, sandboxWorkPath, nil, 90*time.Second,
		"spawn", strconv.Itoa(attempts))
	if !control.reported {
		t.Fatalf("the control never reported; stderr: %s", control.stderr)
	}
	if control.result.Count < attempts {
		t.Fatalf("the control only started %d of %d children under TasksMax=%d (%s), so a lower count "+
			"under a tight ceiling would not be evidence of the ceiling",
			control.result.Count, attempts, backend.ceilings.TasksMax, control.result.Err)
	}

	tight := defaultSandboxCeilings()
	tight.TasksMax = 24
	bounded := sandboxRunInside(t, sandboxWithCeilings(backend, tight), mounts, sandboxWorkPath,
		nil, 90*time.Second, "spawn", strconv.Itoa(attempts))
	if !bounded.reported {
		t.Fatalf("the bounded run never reported; stderr: %s", bounded.stderr)
	}
	if bounded.result.OK {
		t.Fatalf("a %d-way fork bomb ran to completion under TasksMax=%d, so resource_ceilings is a "+
			"false claim", attempts, tight.TasksMax)
	}
	if bounded.result.Count >= tight.TasksMax {
		t.Errorf("the fork bomb started %d children under TasksMax=%d", bounded.result.Count, tight.TasksMax)
	}
	if !strings.Contains(bounded.result.Err, "resource") && !errors.Is(errors.New(bounded.result.Err), syscall.EAGAIN) &&
		!strings.Contains(bounded.result.Err, "again") {
		t.Logf("fork failed with %q, which is the kernel refusing rather than the ceiling being absent",
			bounded.result.Err)
	}
}

// ── 4. memory ────────────────────────────────────────────────────────────────

func TestSandboxKillsAMemoryHogByMemoryMax(t *testing.T) {
	backend := sandboxTestBackend(t)
	mounts := sandboxTestMounts(t, backend)
	const hogMiB = 512

	loose := defaultSandboxCeilings()
	control := sandboxRunInside(t, sandboxWithCeilings(backend, loose), mounts, sandboxWorkPath,
		nil, 90*time.Second, "memhog", strconv.Itoa(hogMiB))
	if !control.reported || !control.result.OK {
		t.Fatalf("the control could not allocate %d MiB under MemoryMax=%s (%s), so a kill under a "+
			"tight ceiling would not be evidence of the ceiling",
			hogMiB, sandboxBytes(loose.MemoryMaxBytes), control.result.Err)
	}

	tight := defaultSandboxCeilings()
	tight.MemoryMaxBytes = 128 << 20
	bounded := sandboxRunInside(t, sandboxWithCeilings(backend, tight), mounts, sandboxWorkPath,
		nil, 90*time.Second, "memhog", strconv.Itoa(hogMiB))
	if bounded.reported && bounded.result.OK {
		t.Fatalf("a %d MiB allocation succeeded under MemoryMax=%s, so resource_ceilings is a false claim",
			hogMiB, sandboxBytes(tight.MemoryMaxBytes))
	}
	if bounded.exitCode == 0 {
		t.Errorf("the memory hog exited cleanly under MemoryMax=%s; it should have been killed",
			sandboxBytes(tight.MemoryMaxBytes))
	}
}

// ── 5. disposability ─────────────────────────────────────────────────────────

func TestSandboxLeavesNothingBehind(t *testing.T) {
	backend := sandboxTestBackend(t)
	mounts := sandboxTestMounts(t, backend)

	// The control writes the same files with no boundary, into a directory the
	// host keeps, and they are still there afterwards — which is what makes the
	// disappearance below a property of the sandbox rather than of the payload.
	control := t.TempDir()
	if outcome := sandboxRunOutside(t, nil, 20*time.Second, "fill", control); !outcome.result.OK {
		t.Fatalf("the control could not write at all (%s)", outcome.result.Err)
	}
	if _, err := os.Stat(filepath.Join(control, "written-by-the-run")); err != nil {
		t.Fatalf("the control's own write did not persist (%v), so nothing below is evidence", err)
	}

	inside := sandboxRunInside(t, backend, mounts, sandboxWorkPath, nil, 30*time.Second,
		"fill", sandboxWorkPath, sandboxHomePath, "/tmp")
	if !inside.reported || !inside.result.OK {
		t.Fatalf("the payload could not write to its own scratch: %+v (stderr %s)", inside.result, inside.stderr)
	}
	if inside.result.Bytes <= 0 {
		t.Fatal("the payload reported writing nothing, so its disappearance proves nothing")
	}
	// Every writable directory has to be tmpfs. A scratch on a host filesystem
	// would outlive the mount namespace whether or not this test happened to
	// look at the path it landed on.
	for _, dir := range []string{sandboxWorkPath, sandboxHomePath, "/tmp"} {
		backed := false
		for _, tmpfs := range inside.result.Tmpfs {
			if tmpfs == dir {
				backed = true
			}
		}
		if !backed {
			t.Errorf("%s is not tmpfs inside the sandbox (tmpfs: %v), so what the run writes there "+
				"is on a host filesystem", dir, inside.result.Tmpfs)
		}
	}

	// Every path it wrote is a path the host does not have.
	for _, path := range []string{
		filepath.Join(sandboxWorkPath, "written-by-the-run"),
		filepath.Join(sandboxHomePath, "written-by-the-run"),
		"/tmp/written-by-the-run",
		sandboxRoot,
	} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("%s survived the run on the host (stat error %v), so disposable is a false claim",
				path, err)
		}
	}
}

// ── 6. cancellation ──────────────────────────────────────────────────────────

// TestSandboxCancellationReapsTheWholeTree kills the launch the way Babel kills
// a run and then asks the kernel, not the process, whether anything is left.
//
// The scope's cgroup is the right place to ask: it enumerates every process in
// the run regardless of the PID namespace they think they live in, so a
// grandchild that escaped a signal would still be listed. The test records that
// membership while the tree is alive — three processes at least, or there was
// no tree to reap and the assertion would be vacuous — and then requires it to
// be empty afterwards.
func TestSandboxCancellationReapsTheWholeTree(t *testing.T) {
	backend := sandboxTestBackend(t)
	mounts := sandboxTestMounts(t, backend)
	argv := backend.enter(mounts, sandboxWorkPath, sandboxPayloadArgv("tree", "2")...)

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Args = argv
	cmd.Env = append([]string{"PATH=" + os.Getenv("PATH")}, backend.scopeEnv...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var out strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		t.Fatalf("the sandbox would not start: %v", err)
	}
	pid := cmd.Process.Pid
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	// Wait for the tree to exist rather than assuming it does.
	var cgroup string
	var alive []int
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if path, err := sandboxCgroupOf(pid); err == nil && strings.HasSuffix(path, ".scope") {
			cgroup = path
			alive = sandboxCgroupProcs(cgroup)
			if len(alive) >= 3 {
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(alive) < 3 {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		<-done
		t.Fatalf("only %d process(es) ever appeared in %q, so there was no tree to reap and this test "+
			"would pass vacuously; payload output: %s", len(alive), cgroup, out.String())
	}

	// Cancellation, exactly as the session driver performs it: the whole
	// process group, then the kernel's own answer about what is left.
	//
	// The clock starts at the signal and the wait for the parent comes after,
	// deliberately. Waiting first would hide the failure this is about: a tree
	// that is not torn down keeps the child's stdout open, so the parent's own
	// Wait blocks until the grandchildren finish on their own — and a test that
	// measured after that would call a 120-second orphan a clean reap.
	if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil {
		t.Fatalf("signalling the group: %v", err)
	}
	const reapWithin = 15 * time.Second
	signalled := time.Now()
	deadline = signalled.Add(reapWithin)
	var left []int
	for time.Now().Before(deadline) {
		left = sandboxCgroupProcs(cgroup)
		if len(left) == 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(left) != 0 {
		for _, orphan := range left {
			_ = syscall.Kill(orphan, syscall.SIGKILL)
		}
		t.Fatalf("%d process(es) outlived the cancellation by more than %s in %q: %v",
			len(left), reapWithin, cgroup, left)
	}

	// The launch itself has to be reapable in the same window. A parent stuck
	// on a pipe a surviving grandchild still holds is an unreaped tree wearing
	// a dead process's name.
	select {
	case <-done:
	case <-time.After(reapWithin):
		t.Fatalf("the launch was still running %s after the whole group was killed, so something "+
			"below it is holding its descriptors open", reapWithin)
	}
	// And none of the pids that were alive is still running under another
	// parent. A pid that has exited but not yet been reaped is not an orphan —
	// it holds no resources and runs no code — so the check reads the kernel's
	// own state rather than treating a signalable pid as a live one.
	deadline = time.Now().Add(20 * time.Second)
	var running []int
	for time.Now().Before(deadline) {
		running = running[:0]
		for _, was := range alive {
			if sandboxProcessRunning(was) {
				running = append(running, was)
			}
		}
		if len(running) == 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(running) != 0 {
		for _, orphan := range running {
			_ = syscall.Kill(orphan, syscall.SIGKILL)
		}
		t.Errorf("pid(s) %v survived the cancellation as orphans", running)
	}
}

// sandboxProcessRunning reports whether a pid is a process that still exists
// and has not already exited. A zombie has exited: its entry survives only
// until its parent reaps it, and reaping is not something a cancellation can
// wait for.
func sandboxProcessRunning(pid int) bool {
	body, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	// "pid (comm) state ..." — comm may contain spaces and parentheses, so the
	// state is the field after the last ')'.
	close := strings.LastIndex(string(body), ")")
	if close < 0 || close+2 >= len(body) {
		return false
	}
	return string(body)[close+2] != 'Z'
}

func sandboxCgroupProcs(cgroup string) []int {
	body, err := os.ReadFile(filepath.Join("/sys/fs/cgroup", cgroup, "cgroup.procs"))
	if err != nil {
		return nil
	}
	var pids []int
	for _, line := range strings.Fields(string(body)) {
		if pid, err := strconv.Atoi(line); err == nil {
			pids = append(pids, pid)
		}
	}
	return pids
}

// ── the declaration ──────────────────────────────────────────────────────────

// TestSandboxBackendComesUpWhereItsPrerequisitesDo turns every skip in this
// file into a failure on a machine that can actually run the backend.
//
// Without it, any defect the probe detects — a ceiling that is no longer
// requested, a namespace that is no longer unshared, a mount that is no longer
// read-only — would degrade the declaration, make every scenario below skip,
// and leave the suite green. That is the right behaviour on a host with no
// bubblewrap and no user session bus, and it is a silent regression anywhere
// else. So the two prerequisites are checked directly, and if they are both
// present the backend is required to come up whole.
func TestSandboxBackendComesUpWhereItsPrerequisitesDo(t *testing.T) {
	var missing []string
	if _, err := sandboxLookTool("bwrap"); err != nil {
		missing = append(missing, "bubblewrap: "+err.Error())
	}
	if _, _, err := sandboxScopeTool(); err != nil {
		missing = append(missing, "a transient systemd user scope: "+err.Error())
	}
	if len(missing) > 0 {
		message := "UNVERIFIED: this machine cannot run Code's containment backend, so nothing in " +
			"sandbox_linux_test.go tested it. Missing " + strings.Join(missing, "; ")
		fmt.Fprintln(os.Stderr, "sandbox escape scenarios: "+message)
		if sandboxGateIsRequired() {
			t.Fatal(message + "\n\nThis is a failure rather than a skip because " +
				sandboxGateReason() + ". A pipeline that cannot run the escape scenarios " +
				"must say so rather than report success for a boundary it never exercised.")
		}
		t.Skip(message)
	}

	backend := newSandboxBackend(defaultSandboxCeilings())
	if backend.facts.backend != sandboxBackendFull {
		t.Fatalf("bubblewrap and a user scope are both available here, so the backend must come up as "+
			"%q; it came up as %q because: %s. Every escape scenario in this file would otherwise "+
			"skip and the suite would stay green.",
			sandboxBackendFull, backend.facts.backend, strings.Join(backend.facts.degraded, "; "))
	}
	if len(backend.facts.degraded) > 0 {
		t.Errorf("the backend came up but the probe still found gaps: %s",
			strings.Join(backend.facts.degraded, "; "))
	}
}

// TestSandboxDeclaresWhatItEstablished is the tie between the six scenarios
// above and the thing Babel actually records. Each scenario proves a property;
// this proves the declaration reports those properties and no others.
func TestSandboxDeclaresWhatItEstablished(t *testing.T) {
	backend := sandboxTestBackend(t)
	facts := backend.facts
	if facts.backend != sandboxBackendFull {
		t.Fatalf("backend = %q, want %q", facts.backend, sandboxBackendFull)
	}
	for name, got := range map[string]bool{
		"filesystem isolation": facts.filesystemIsolation,
		"network default deny": facts.networkDefaultDeny,
		"resource ceilings":    facts.resourceCeilings,
		"disposable":           facts.disposable,
	} {
		if !got {
			t.Errorf("the probe did not establish %s, though the backend came up: %v", name, facts.degraded)
		}
	}

	declared := facts.declare(sandboxEgressDescription{
		provider: anthropicProvider,
		allowed:  []string{"api.anthropic.com:443"},
		relay:    true,
	})
	if !declared.FilesystemIsolation || !declared.NetworkDefaultDeny ||
		!declared.ResourceCeilings || !declared.Disposable {
		t.Errorf("the declaration dropped a property the probe established: %+v", declared)
	}
	// The escape statement is what a reviewer acts on, so the four residuals
	// the design cannot remove have to be in it by substance, not by heading.
	for _, residual := range []string{
		"api.anthropic.com:443", // egress is restricted, not absent
		"credential",            // the credential is inside the boundary
		"user namespace",        // the isolation rests on unprivileged userns
		"seccomp",               // no syscall filter
		"I/O bandwidth",         // the one ceiling that is measurably absent
	} {
		if !strings.Contains(declared.Escape, residual) {
			t.Errorf("the escape statement never mentions %q:\n%s", residual, declared.Escape)
		}
	}
}

// TestSandboxRefusesToRunWithoutTheCeilingsItDeclared is the failure path the
// declaration depends on: a launch that claims ceilings and does not get them
// must not proceed, because Babel has already recorded the claim.
func TestSandboxRefusesToRunWithoutTheCeilingsItDeclared(t *testing.T) {
	backend := sandboxTestBackend(t)
	// A ceiling the running scope cannot be carrying, checked against this
	// process, which is not in a transient scope of Code's making.
	impossible := sandboxWithCeilings(backend, sandboxCeilings{
		MemoryMaxBytes: 1, CPUQuotaPercent: 1, TasksMax: 1, DiskMaxBytes: 1 << 20,
	})
	run := &sandboxRun{verify: impossible.verifyCeilings}
	err := run.started(os.Getpid())
	if err == nil {
		t.Fatal("a run whose ceilings were never installed was allowed to start")
	}
	if !strings.Contains(err.Error(), "refused") {
		t.Errorf("the refusal does not say the run was refused: %v", err)
	}
}

// ── the production launch path ───────────────────────────────────────────────

// TestOmpDriveLaunchesTheSessionInsideTheSandbox is the production path,
// end to end: the driver resolves a profile, opens the run's egress, builds the
// boundary, and starts a session inside it.
//
// The six escape scenarios above prove the boundary holds. This proves the
// session is actually put behind it — that the working directory, home, config,
// account pool, proxy and broker the child sees are the sandbox's and not the
// host's — which no amount of boundary testing would catch if the launch went
// around it.
func TestOmpDriveLaunchesTheSessionInsideTheSandbox(t *testing.T) {
	backend := sandboxTestBackend(t)

	// A host-side auth broker on loopback, which is the shape Code resolves in
	// practice and the one the sandbox cannot reach without the relay.
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "{}")
	}))
	defer broker.Close()

	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	host := t.TempDir()
	secret := filepath.Join(host, "host-state")
	if err := os.WriteFile(secret, []byte("host state\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	inv := newOmpInvestigator(&fakeProfiles{profile: testProfile()})
	inv.probe = func(sandboxCeilings) *sandboxBackend { return backend }
	inv.lookOmp = func() (string, error) { return self, nil }
	inv.environ = func() []string {
		return append(os.Environ(), sandboxFakeOmpEnv+"=1")
	}
	inv.auth = func() (ompAuth, error) {
		auth := testAuth()
		auth.broker.URL = broker.URL + "/auth"
		return auth, nil
	}
	if _, err := inv.resolveCredential(); err != nil {
		t.Fatalf("resolving the credential: %v", err)
	}

	// The declaration goes out before the run, and it has to be the full one:
	// a run that launched contained while declaring less would be the failure
	// this whole subsystem exists to prevent, in the safe direction.
	declared := inv.containment()
	if !declared.FilesystemIsolation || !declared.NetworkDefaultDeny ||
		!declared.ResourceCeilings || !declared.Disposable {
		t.Fatalf("the driver declared less than the backend established: %+v", declared)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	silent := func(string, string, float64) {}
	deny := func(string, string, string, json.RawMessage) babelDecision {
		return babelDecision{Decision: babelDecisionDeny}
	}
	result, err := inv.drive(ctx, testJob(""), silent, deny)
	if err != nil {
		t.Fatalf("the contained run failed: %v", err)
	}

	var findings ompFindings
	if err := json.Unmarshal(result.Payload, &findings); err != nil {
		t.Fatalf("the result payload does not parse: %v", err)
	}
	var view sandboxGuestView
	if err := json.Unmarshal([]byte(findings.Analysis), &view); err != nil {
		t.Fatalf("the session reported %q, which is not a guest view: %v", findings.Analysis, err)
	}

	if view.Cwd != sandboxWorkPath {
		t.Errorf("the session's working directory is %q, want the sandbox's %q", view.Cwd, sandboxWorkPath)
	}
	if view.Home != sandboxHomePath {
		t.Errorf("the session's HOME is %q, want the sandbox's %q", view.Home, sandboxHomePath)
	}
	if !view.ConfigReadable {
		t.Errorf("the profile's overlay was not readable at %s inside the sandbox", sandboxConfigPath)
	}
	if view.PoolPath != sandboxPoolPath || !view.PoolReadable {
		t.Errorf("the run's account pool is at %q (readable %v), want a readable %q",
			view.PoolPath, view.PoolReadable, sandboxPoolPath)
	}
	if view.Routes != 0 {
		t.Errorf("the session's network namespace carries %d route(s)", view.Routes)
	}
	// The host's home directory is the shortest test of "this is not the host".
	for _, name := range view.Root {
		if name == "home" {
			t.Errorf("the host's /home is visible inside the sandbox: %v", view.Root)
		}
	}
	if view.TokenOnArgv {
		t.Error("the provider credential reached OMP's argv, where a process listing would expose it")
	}

	// The credential still has to work: the relay is what keeps a run that has
	// no network able to authenticate.
	if view.Proxy != sandboxProxyURL {
		t.Errorf("PI_PROXY is %q, want the in-sandbox forwarder at %q", view.Proxy, sandboxProxyURL)
	}
	if !strings.HasPrefix(view.BrokerURL, "http://127.0.0.1:"+strconv.Itoa(sandboxBrokerPort)) {
		t.Errorf("the session's broker URL is %q, want the sandbox's own loopback relay", view.BrokerURL)
	}
	if !strings.Contains(view.BrokerStatus, "200") {
		t.Errorf("the session could not reach its auth broker through the relay: %q", view.BrokerStatus)
	}
	if !strings.Contains(view.RefusedStatus, "403") {
		t.Errorf("a CONNECT to a host the allowlist does not name answered %q, want a refusal",
			view.RefusedStatus)
	}

	// And the refusal is in the payload, where a reviewer reads it.
	var recorded bool
	for _, attempt := range findings.Egress {
		if attempt.Target == "example.invalid:443" && !attempt.Allowed {
			recorded = true
		}
	}
	if !recorded {
		t.Errorf("the refused CONNECT is not in the run's egress record: %+v", findings.Egress)
	}
	// Every dimension the full backend can measure has to be there, because
	// this tier declared resource ceilings and a ceiling is enforced by
	// measuring what it bounds. The sources are the scope's own cgroup for CPU
	// and peak memory and the guest's own walk for the scratch bytes; a nil
	// pointer here means the reporting path stopped reading one of them.
	resources := result.Resources
	switch {
	case resources == nil:
		t.Fatal("a contained run that declared resource ceilings reported no resource use at all")
	case resources.CPUSeconds == nil:
		t.Error("no cpu_seconds: the scope's cgroup cpu.stat was not read before the scope was collected")
	case *resources.CPUSeconds <= 0:
		t.Errorf("cpu_seconds = %v, and starting bwrap and a session inside it costs CPU", *resources.CPUSeconds)
	}
	if resources != nil {
		if resources.MaxRSSBytes == nil {
			t.Error("no max_rss_bytes: the scope's cgroup memory.peak was not read")
		} else if *resources.MaxRSSBytes <= 0 {
			t.Errorf("max_rss_bytes = %d, and a running session occupies memory", *resources.MaxRSSBytes)
		}
		if resources.SandboxBytesWritten == nil {
			t.Error("no sandbox_bytes_written: the in-sandbox helper's scratch measurement never came back")
		}
	}
}

// TestContainedRunMeasuresWhatItActuallyUsed is the check that separates a
// measurement from a number.
//
// Every other test here can be satisfied by a reporting path that returns a
// plausible constant: a positive cpu_seconds proves only that something is
// positive. So this drives two contained runs that differ in exactly one way —
// the second one is told to occupy memory, write to its scratch and spin — and
// requires all three reported figures to move in the direction the extra work
// went. A figure that reads the same for both is not measuring the run.
//
// It is deliberately not an equality or a tolerance check. The figures come off
// a cgroup that also accounts bwrap, the guest's own runtime and the page cache
// for the binary it executed, so their absolute values are not a test's
// business; that they respond is.
func TestContainedRunMeasuresWhatItActuallyUsed(t *testing.T) {
	backend := sandboxTestBackend(t)

	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "{}")
	}))
	defer broker.Close()

	// The loaded run's own figures: how much it makes resident and writes, and
	// how long it spins, are all in the guest. All the host does is ask.
	const loadMiB = 128

	drive := func(t *testing.T, load string) babelResources {
		t.Helper()
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		inv := newOmpInvestigator(&fakeProfiles{profile: testProfile()})
		inv.probe = func(sandboxCeilings) *sandboxBackend { return backend }
		inv.lookOmp = func() (string, error) { return self, nil }
		inv.environ = func() []string {
			return append(os.Environ(), sandboxFakeOmpEnv+"=1", sandboxFakeLoadEnv+"="+load)
		}
		inv.auth = func() (ompAuth, error) {
			auth := testAuth()
			auth.broker.URL = broker.URL + "/auth"
			return auth, nil
		}
		if _, err := inv.resolveCredential(); err != nil {
			t.Fatalf("resolving the credential: %v", err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()
		result, err := inv.drive(ctx, testJob(""), func(string, string, float64) {},
			func(string, string, string, json.RawMessage) babelDecision {
				return babelDecision{Decision: babelDecisionDeny}
			})
		if err != nil {
			t.Fatalf("the contained run failed: %v", err)
		}
		if result.Resources == nil {
			t.Fatal("the contained run reported no resource use")
		}
		return *result.Resources
	}

	idle := drive(t, "0")
	busy := drive(t, strconv.Itoa(loadMiB))
	// Logged because "the figure moved" is only convincing next to the two
	// figures, and because a future reader debugging this test needs to see
	// what the machine actually reported rather than which comparison failed.
	t.Logf("idle run: cpu %v s, peak %v B, wrote %v B",
		sandboxShow(idle.CPUSeconds), sandboxShow(idle.MaxRSSBytes), sandboxShow(idle.SandboxBytesWritten))
	t.Logf("busy run (%d MiB resident and written, %s of spin): cpu %v s, peak %v B, wrote %v B",
		loadMiB, sandboxGuestBurn,
		sandboxShow(busy.CPUSeconds), sandboxShow(busy.MaxRSSBytes), sandboxShow(busy.SandboxBytesWritten))

	for _, dimension := range []struct {
		name       string
		idle, busy *int64
		source     string
	}{
		{"max_rss_bytes", idle.MaxRSSBytes, busy.MaxRSSBytes,
			"the scope's cgroup memory.peak"},
		{"sandbox_bytes_written", idle.SandboxBytesWritten, busy.SandboxBytesWritten,
			"the in-sandbox helper's walk of the scratch tmpfs"},
	} {
		if dimension.idle == nil || dimension.busy == nil {
			t.Errorf("%s went unreported by one of the two runs (idle %v, busy %v)",
				dimension.name, dimension.idle, dimension.busy)
			continue
		}
		if *dimension.busy <= *dimension.idle {
			t.Errorf("%s is %d for a run that made %d MiB resident and wrote it, "+
				"and %d for one that did neither; %s is not tracking the run",
				dimension.name, *dimension.busy, loadMiB, *dimension.idle, dimension.source)
		}
	}
	if idle.CPUSeconds == nil || busy.CPUSeconds == nil {
		t.Fatalf("cpu_seconds went unreported by one of the two runs (idle %v, busy %v)",
			idle.CPUSeconds, busy.CPUSeconds)
	}
	if *busy.CPUSeconds <= *idle.CPUSeconds {
		t.Errorf("cpu_seconds is %v for a run that spun for %s and %v for one that did not; "+
			"the scope's cgroup cpu.stat is not tracking the run",
			*busy.CPUSeconds, sandboxGuestBurn, *idle.CPUSeconds)
	}
}

// TestBwrapOnlyTierReportsNoCeilingFigure holds the middle tier to the same
// standard as the declaration.
//
// bubblewrap without a transient scope is a real boundary with no enforced
// ceiling, so it declares resource_ceilings false — and it therefore has no
// cgroup to read a ceiling-derived figure out of. The failure this guards
// against is a reporting path that keeps reaching for the cgroup anyway and
// lands on some ancestor's counters: the numbers would look fine and would
// describe a different process tree, while the declaration said no ceiling
// existed. What this tier can honestly see is the child's own rusage and the
// guest's own scratch measurement, so that is what it reports and it says so.
func TestBwrapOnlyTierReportsNoCeilingFigure(t *testing.T) {
	full := sandboxTestBackend(t)

	// The same machine, one tier down: bubblewrap exactly as before, with the
	// scope withheld. Nothing else about the launch changes, which is what
	// makes this a test of the tier rather than of a different backend.
	degraded := *full
	degraded.systemd, degraded.scopeEnv = "", nil
	degraded.facts.backend = sandboxBackendBwrap
	degraded.facts.resourceCeilings = false

	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "{}")
	}))
	defer broker.Close()

	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	inv := newOmpInvestigator(&fakeProfiles{profile: testProfile()})
	inv.probe = func(sandboxCeilings) *sandboxBackend { return &degraded }
	inv.lookOmp = func() (string, error) { return self, nil }
	inv.environ = func() []string {
		return append(os.Environ(), sandboxFakeOmpEnv+"=1")
	}
	inv.auth = func() (ompAuth, error) {
		auth := testAuth()
		auth.broker.URL = broker.URL + "/auth"
		return auth, nil
	}
	if _, err := inv.resolveCredential(); err != nil {
		t.Fatalf("resolving the credential: %v", err)
	}

	declared := inv.containment()
	if declared.ResourceCeilings {
		t.Fatal("the bubblewrap-only tier declared a ceiling it cannot install")
	}
	if !declared.FilesystemIsolation || !declared.NetworkDefaultDeny || !declared.Disposable {
		t.Fatalf("the tier lost the three properties bubblewrap does establish: %+v", declared)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	rec := &recorder{}
	result, err := inv.drive(ctx, testJob(""), rec.emit,
		func(string, string, string, json.RawMessage) babelDecision {
			return babelDecision{Decision: babelDecisionDeny}
		})
	if err != nil {
		t.Fatalf("the bubblewrap-only run failed: %v", err)
	}
	if result.Resources == nil {
		t.Fatal("the run reported no resource use, though its child's rusage was there to read")
	}
	if result.Resources.CPUSeconds == nil || result.Resources.MaxRSSBytes == nil {
		t.Errorf("the child's rusage went unreported: %+v", result.Resources)
	}
	if result.Resources.SandboxBytesWritten == nil {
		t.Error("the guest measured its own scratch and the figure was dropped")
	}

	provenance := strings.Join(rec.messages, "\n")
	if strings.Contains(provenance, "cgroup") {
		t.Errorf("a tier that installed no ceiling reported a cgroup figure: %s", provenance)
	}
	if !strings.Contains(provenance, "rusage") || !strings.Contains(provenance, "tmpfs scratch") {
		t.Errorf("the run did not say where its figures came from: %s", provenance)
	}
}

// sandboxShow renders an optional reported figure the way the wire carries it:
// a value when it was measured and "absent" when it was not, so a log line
// cannot make an unmeasured dimension look like a zero one.
func sandboxShow[T float64 | int64](value *T) any {
	if value == nil {
		return "absent"
	}
	return *value
}
