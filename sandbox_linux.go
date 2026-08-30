//go:build linux

package main

// The Linux containment backend: bubblewrap inside a transient systemd user
// scope.
//
// The two halves do different jobs and neither substitutes for the other.
// bubblewrap builds the boundary — unprivileged user, mount, PID, IPC, UTS,
// cgroup and network namespaces over a tmpfs root — which is what makes the run
// isolated, networkless and disposable. The scope is a cgroup systemd owns,
// which is the only way an unprivileged process on this machine can install a
// memory, CPU or task ceiling that the kernel actually enforces. bwrap alone is
// three of the four properties; the scope alone is one of them.
//
// Nothing here trusts either tool's exit status for a claim. Before a run is
// declared contained, the backend launches the whole chain with a probe payload
// that tries, from inside, to read and write a host path, to write the Nix
// store, and to find a route off the machine — and the parent reads the scope's
// own cgroup files back to see that the ceilings it asked for are the ones the
// kernel installed. A property that survives that is declared; a property that
// does not is declared false, and Babel refuses the run.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// sandboxProbeTimeout bounds the probe. A backend that cannot report in this
// long is not one a run should wait on, and the fallback — declaring less — is
// always available.
const sandboxProbeTimeout = 30 * time.Second

// sandboxBackend is the probed backend. It is built once per worker process,
// because probing is a launch and a run has no reason to do it twice, and the
// facts it holds are what containment() declares.
type sandboxBackend struct {
	helper   string
	bwrap    string
	systemd  string
	scopeEnv []string
	ceilings sandboxCeilings
	facts    sandboxFacts
}

// newSandboxBackend probes this machine and reports what it can actually
// contain a run in.
//
// The order is deliberate: the full backend is tried first, and each fallback
// is taken only after the stronger one demonstrably failed, with the reason
// recorded so the declaration can say why a boolean is false.
func newSandboxBackend(ceilings sandboxCeilings) *sandboxBackend {
	b := &sandboxBackend{ceilings: ceilings, facts: sandboxFacts{backend: sandboxBackendNone, ceilings: ceilings}}

	helper, err := os.Executable()
	if err != nil {
		b.facts.degraded = []string{"Code cannot locate its own binary (" + err.Error() +
			"), and the sandbox needs it inside to forward egress"}
		return b
	}
	b.helper = helper

	bwrap, err := sandboxLookTool("bwrap")
	if err != nil {
		b.facts.degraded = []string{"bubblewrap is not installed (" + err.Error() +
			"), so no namespace boundary can be built at all"}
		return b
	}
	b.bwrap = bwrap

	var degraded []string
	if systemd, env, err := sandboxScopeTool(); err != nil {
		degraded = append(degraded, "no transient systemd scope is available ("+err.Error()+
			"), so no resource ceiling could be installed")
	} else {
		b.systemd, b.scopeEnv = systemd, env
	}

	// The scoped backend first. A probe that comes back with the boundary
	// intact and the ceilings installed is the only thing that earns the full
	// declaration.
	if b.systemd != "" {
		report, ceilingsOK, err := b.probe(true)
		switch {
		case err != nil:
			degraded = append(degraded, "the scoped backend would not start ("+err.Error()+")")
		case !ceilingsOK:
			degraded = append(degraded, "the transient scope started but its cgroup did not carry the "+
				"ceilings that were requested, so none is claimed")
		default:
			b.facts = sandboxFacts{
				backend:             sandboxBackendFull,
				filesystemIsolation: report.isolated(),
				networkDefaultDeny:  report.networkDenied(),
				resourceCeilings:    true,
				disposable:          report.isolated(),
				ceilings:            ceilings,
			}
			b.facts.degraded = sandboxDedupe(append(b.facts.degraded, sandboxProbeGaps(report)...))
			if b.facts.contained() {
				return b
			}
			degraded = append(degraded, "the scoped backend started but did not isolate: "+
				strings.Join(sandboxProbeGaps(report), "; "))
		}
	}

	// bubblewrap alone. Three of the four properties are still real, and saying
	// so beats claiming a ceiling that was never installed — Babel refuses this
	// declaration under the strict default, which is the correct outcome, and
	// an operator who relaxes a run deliberately still gets the boundary.
	report, _, err := b.probe(false)
	if err != nil {
		degraded = append(degraded, "bubblewrap would not start either ("+err.Error()+")")
		b.facts = sandboxFacts{backend: sandboxBackendNone, ceilings: ceilings, degraded: sandboxDedupe(degraded)}
		return b
	}
	b.systemd, b.scopeEnv = "", nil
	b.facts = sandboxFacts{
		backend:             sandboxBackendBwrap,
		filesystemIsolation: report.isolated(),
		networkDefaultDeny:  report.networkDenied(),
		resourceCeilings:    false,
		disposable:          report.isolated(),
		ceilings:            ceilings,
		degraded:            sandboxDedupe(append(degraded, sandboxProbeGaps(report)...)),
	}
	if !b.facts.contained() {
		b.facts.backend = sandboxBackendNone
	}
	return b
}

// sandboxDedupe keeps a degraded list readable. The scoped attempt and the
// bubblewrap-only fallback observe the same machine, so a real gap is seen
// twice and a reviewer should be told it once.
func sandboxDedupe(reasons []string) []string {
	seen := make(map[string]bool, len(reasons))
	out := reasons[:0]
	for _, reason := range reasons {
		if seen[reason] {
			continue
		}
		seen[reason] = true
		out = append(out, reason)
	}
	return out
}

// sandboxProbeGaps names, in an operator's words, each thing the probe saw that
// the declaration would otherwise have claimed.
func sandboxProbeGaps(report sandboxProbeReport) []string {
	var gaps []string
	if report.OutsideReadable {
		gaps = append(gaps, "a host path outside the grant was readable from inside the sandbox")
	}
	if report.OutsideWritable {
		gaps = append(gaps, "a host path outside the grant was writable from inside the sandbox")
	}
	if report.StoreWritable {
		gaps = append(gaps, "the Nix store was writable from inside the sandbox")
	}
	if !report.ScratchWritable {
		gaps = append(gaps, "the sandbox's own scratch directory was not writable, so a run could not proceed")
	}
	if report.Routes != 0 {
		gaps = append(gaps, "the sandbox's network namespace still carried "+strconv.Itoa(report.Routes)+
			" route(s) off the machine")
	}
	if !report.Loopback {
		gaps = append(gaps, "the sandbox has no usable loopback, so the egress forwarder cannot listen")
	}
	return gaps
}

// ── locating the tools ───────────────────────────────────────────────────────

// sandboxLookTool finds one of the backend's binaries.
//
// PATH first, then the two places a Nix-provisioned machine keeps them. The
// fallback exists because Babel spawns this worker with a curated environment
// carrying only HOME, PATH, TMPDIR and LANG, and that PATH is whatever Babel
// itself inherited — which on a machine where these tools live in a user
// profile may well not include them. Nothing is claimed on the strength of a
// path being found: the probe still has to run.
func sandboxLookTool(name string) (string, error) {
	if path, err := exec.LookPath(name); err == nil {
		return path, nil
	}
	candidates := []string{
		filepath.Join(os.Getenv("HOME"), ".nix-profile", "bin", name),
		filepath.Join("/run/current-system/sw/bin", name),
		filepath.Join("/usr/bin", name),
		filepath.Join("/bin", name),
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%s is not on PATH and is not in any well-known location", name)
}

// sandboxScopeTool locates systemd-run and the session bus it needs.
//
// The bus address is derived rather than required, for the same reason: Babel
// strips XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS from the worker's
// environment, so insisting on them would refuse a ceiling this machine can
// perfectly well install. The derivation is the documented one — the user
// manager's runtime directory is /run/user/$UID and its bus socket is `bus`
// inside it — and it is checked by stat and then proven by actually creating a
// scope in the probe. A guess that is wrong degrades the declaration; it cannot
// inflate it.
func sandboxScopeTool() (string, []string, error) {
	path, err := sandboxLookTool("systemd-run")
	if err != nil {
		return "", nil, err
	}
	runtimeDir := os.Getenv("XDG_RUNTIME_DIR")
	if runtimeDir == "" {
		uid := os.Getuid()
		runtimeDir = "/run/user/" + strconv.Itoa(uid)
		if current, err := user.Current(); err == nil && current.Uid != "" {
			runtimeDir = "/run/user/" + current.Uid
		}
	}
	bus := os.Getenv("DBUS_SESSION_BUS_ADDRESS")
	if bus == "" {
		socket := filepath.Join(runtimeDir, "bus")
		info, err := os.Stat(socket)
		if err != nil {
			return "", nil, fmt.Errorf("the user session bus is not at %s, so systemd-run --user has "+
				"nothing to talk to", socket)
		}
		if info.Mode()&os.ModeSocket == 0 {
			return "", nil, fmt.Errorf("%s is not a socket", socket)
		}
		bus = "unix:path=" + socket
	}
	return path, []string{
		"XDG_RUNTIME_DIR=" + runtimeDir,
		"DBUS_SESSION_BUS_ADDRESS=" + bus,
	}, nil
}

// ── the mount plan ───────────────────────────────────────────────────────────

// sandboxMounts is the guest filesystem, as bwrap arguments are built from it.
// Only three kinds exist, which is the point: read-only host paths, sized
// tmpfs, and the egress sockets. Nothing a run writes can land on a host
// filesystem because no writable host path is ever in this structure.
type sandboxMounts struct {
	// same binds a host path read-only at the identical path inside, which is
	// what the Nix store, the CA bundle and the grant's corpus need: the omp
	// wrapper resolves absolute store paths, and a corpus path a finding cites
	// must mean the same thing on both sides.
	same []string
	// at binds a host path read-only somewhere else inside, in insertion order.
	at []sandboxBind
	// scratch is a sized tmpfs, writable, gone with the mount namespace.
	scratch []string
}

type sandboxBind struct{ host, guest string }

func (m *sandboxMounts) bindSame(host string) {
	if host == "" {
		return
	}
	for _, existing := range m.same {
		if existing == host {
			return
		}
	}
	m.same = append(m.same, host)
}

func (m *sandboxMounts) bindAt(host, guest string) {
	if host == "" || guest == "" {
		return
	}
	m.at = append(m.at, sandboxBind{host: host, guest: guest})
}

// args renders the mount plan. Order is load-bearing: bwrap applies operations
// in sequence, so the root tmpfs comes first, the writable tmpfs next, and the
// read-only binds last so that a bind under a tmpfs lands on the tmpfs rather
// than under it.
func (m sandboxMounts) args(ceilings sandboxCeilings) []string {
	// The root tmpfs holds nothing but mount points, so it is tiny on purpose:
	// a run that writes into a directory nobody mounted anything on hits a wall
	// immediately rather than filling RAM.
	args := []string{
		"--size", strconv.FormatInt(sandboxRootTmpfsBytes, 10), "--tmpfs", "/",
		"--proc", "/proc",
		"--dev", "/dev",
	}
	for _, dir := range append([]string{"/tmp"}, m.scratch...) {
		args = append(args, "--size", strconv.FormatInt(ceilings.DiskMaxBytes, 10), "--tmpfs", dir)
	}
	for _, host := range m.same {
		args = append(args, "--ro-bind", host, host)
	}
	for _, bind := range m.at {
		args = append(args, "--ro-bind", bind.host, bind.guest)
	}
	return args
}

// sandboxRootTmpfsBytes sizes the root tmpfs. It carries mount points and
// nothing else, so eight mebibytes is generous.
const sandboxRootTmpfsBytes = 8 << 20

// ── building a run ───────────────────────────────────────────────────────────

// contain resolves one launch into the command prefix that puts it inside the
// boundary. A backend that established no boundary returns nil, and the caller
// launches OMP directly — which Babel only ever allows for a run the operator
// explicitly relaxed, because the declaration says exactly that.
func (b *sandboxBackend) contain(request sandboxRequest) (*sandboxRun, error) {
	if b.facts.backend == sandboxBackendNone {
		return nil, nil
	}
	mounts := sandboxMounts{scratch: []string{sandboxRoot}}
	mounts.bindSame(sandboxStore)
	mounts.bindSame(request.caBundle)
	if !strings.HasPrefix(request.ompBinary, sandboxStore+"/") {
		// A binary outside the store — an operator's own build, or a test's
		// stand-in — still has to be reachable, at the path the argv names.
		mounts.bindSame(request.ompBinary)
	}
	for _, path := range request.corpus {
		mounts.bindSame(path)
	}
	mounts.bindAt(b.helper, sandboxHelperPath)
	mounts.bindAt(request.configHost, sandboxConfigPath)
	mounts.bindAt(request.poolHost, sandboxPoolPath)
	mounts.bindAt(request.egress.proxySocket(), sandboxProxySock)
	if socket := request.egress.brokerSocket(); socket != "" {
		mounts.bindAt(socket, sandboxBrokerSock)
	}

	spec := sandboxSpec{
		ProxyPort:   sandboxProxyPort,
		ProxySocket: sandboxProxySock,
		Scratch:     []string{sandboxHomePath, sandboxWorkPath},
	}
	if request.egress.brokerSocket() != "" {
		spec.BrokerPort = sandboxBrokerPort
		spec.BrokerSocket = sandboxBrokerSock
	}
	encoded, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}

	reportR, reportW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	run := &sandboxRun{
		egress:  request.egress,
		spec:    spec,
		reportR: reportR,
		reportW: reportW,
		env: append([]string{sandboxSpecEnv + "=" + string(encoded)},
			b.scopeEnv...),
		prefix: b.enter(mounts, sandboxWorkPath,
			sandboxHelperPath, sandboxHelperCommand, sandboxHelperEgress, "--"),
	}
	if b.systemd != "" {
		run.verify = b.verifyCeilings
	}
	return run, nil
}

// enter builds the command that puts guest inside the boundary: the transient
// scope, then bwrap with the mount plan, then the guest itself.
//
// cwd is the working directory the guest starts in. It is a parameter rather
// than a constant because the escape scenarios have to be able to point it
// somewhere else to show that where it points matters: OMP registers MCP
// servers — which reach the network without passing Babel's broker — from a
// config file at the root of its working directory, so a run whose cwd was the
// corpus would let archived material register unbrokered egress. Every
// production launch passes sandboxWorkPath, a tmpfs the sandbox creates empty.
func (b *sandboxBackend) enter(mounts sandboxMounts, cwd string, guest ...string) []string {
	var argv []string
	if b.systemd != "" {
		argv = append(argv, b.systemd, "--user", "--scope", "--quiet", "--collect",
			"-p", "MemoryMax="+strconv.FormatInt(b.ceilings.MemoryMaxBytes, 10),
			// A memory ceiling a run can page around is not a ceiling.
			"-p", "MemorySwapMax=0",
			"-p", "CPUQuota="+strconv.Itoa(b.ceilings.CPUQuotaPercent)+"%",
			"-p", "TasksMax="+strconv.Itoa(b.ceilings.TasksMax),
			"--")
	}
	argv = append(argv, b.bwrap,
		// Every namespace at once. --unshare-net is the one the network
		// declaration rests on: the sandbox gets a fresh network namespace
		// whose only interface is its own loopback.
		"--unshare-all",
		// The whole tree dies with bwrap, and bwrap dies with Code. Combined
		// with the PID namespace this is what makes a cancellation reap
		// everything rather than orphan a subagent.
		"--die-with-parent",
		// A session of its own, so nothing inside can push characters back
		// onto a terminal Code might be attached to.
		"--new-session",
	)
	argv = append(argv, mounts.args(b.ceilings)...)
	argv = append(argv,
		"--dir", sandboxHomePath,
		"--dir", sandboxWorkPath,
		"--chdir", cwd,
		// The scope needs these to reach the user manager; the guest must not
		// see a runtime directory that does not exist inside.
		"--unsetenv", "XDG_RUNTIME_DIR",
		"--unsetenv", "DBUS_SESSION_BUS_ADDRESS",
		"--")
	return append(argv, guest...)
}

// ── verifying the ceilings ───────────────────────────────────────────────────

// verifyCeilings reads the scope's cgroup back and reports whether the kernel
// installed what systemd was asked for, together with the directory it read.
//
// It reads the live cgroup of the process that was started rather than
// computing a unit path, because the slice layout is a systemd implementation
// detail and /proc/PID/cgroup is the process's own answer. The poll exists
// because a scope is registered over D-Bus a moment after the process starts,
// so the first read can legitimately land before the move.
//
// The directory is returned rather than kept here because a backend outlives a
// run and a scope does not: the same cgroup that proved the ceiling is where
// this run's usage is read from, and the next run's scope is a different one.
func (b *sandboxBackend) verifyCeilings(pid int) (string, error) {
	deadline := time.Now().Add(5 * time.Second)
	var last error
	for {
		path, err := sandboxCgroupOf(pid)
		if err == nil && strings.HasSuffix(path, ".scope") {
			dir := "/sys/fs/cgroup" + path
			if err := b.checkCgroup(dir); err == nil {
				return dir, nil
			} else {
				last = err
			}
		} else if err != nil {
			last = err
		} else {
			last = fmt.Errorf("the process is in cgroup %q, which is not a transient scope", path)
		}
		if time.Now().After(deadline) {
			if last == nil {
				last = errors.New("the scope's cgroup never appeared")
			}
			return "", last
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func sandboxCgroupOf(pid int) (string, error) {
	body, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cgroup")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(strings.TrimSpace(string(body)), "\n") {
		// cgroup v2 writes exactly one line, "0::<path>".
		if strings.HasPrefix(line, "0::") {
			return strings.TrimPrefix(line, "0::"), nil
		}
	}
	return "", errors.New("the process has no cgroup v2 membership, so no unified ceiling can be enforced")
}

// checkCgroup compares the three ceilings against the files the kernel exposes.
// Each one is read rather than assumed, because systemd accepts a property it
// cannot install and reports success.
func (b *sandboxBackend) checkCgroup(dir string) error {
	memory, err := sandboxCgroupInt(dir, "memory.max")
	if err != nil {
		return err
	}
	if memory != b.ceilings.MemoryMaxBytes {
		return fmt.Errorf("memory.max is %d, not the %d that was requested", memory, b.ceilings.MemoryMaxBytes)
	}
	tasks, err := sandboxCgroupInt(dir, "pids.max")
	if err != nil {
		return err
	}
	if tasks != int64(b.ceilings.TasksMax) {
		return fmt.Errorf("pids.max is %d, not the %d that was requested", tasks, b.ceilings.TasksMax)
	}
	quota, err := os.ReadFile(filepath.Join(dir, "cpu.max"))
	if err != nil {
		return fmt.Errorf("cpu.max is not readable, so no CPU ceiling is installed: %w", err)
	}
	fields := strings.Fields(string(quota))
	if len(fields) != 2 || fields[0] == "max" {
		return fmt.Errorf("cpu.max is %q, which is not a quota", strings.TrimSpace(string(quota)))
	}
	allowed, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil {
		return err
	}
	period, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return err
	}
	if want := period * int64(b.ceilings.CPUQuotaPercent) / 100; allowed != want {
		return fmt.Errorf("cpu.max allows %d per %d, not the %d%% that was requested",
			allowed, period, b.ceilings.CPUQuotaPercent)
	}
	return nil
}

func sandboxCgroupInt(dir, name string) (int64, error) {
	body, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return 0, fmt.Errorf("%s is not readable, so no ceiling of that kind is installed: %w", name, err)
	}
	text := strings.TrimSpace(string(body))
	if text == "max" {
		return 0, fmt.Errorf("%s is unlimited", name)
	}
	return strconv.ParseInt(text, 10, 64)
}

// ── the probe ────────────────────────────────────────────────────────────────

// probe launches the real backend with a payload that tries to break out, and
// reports what it saw. It is the only thing containment() believes.
//
// The payload writes its report and then blocks on stdin. That handshake is
// what makes the ceiling check deterministic: the parent reads the report,
// knows the process is alive, reads the scope's cgroup, and only then lets the
// payload exit. Polling a process that may already have finished would make the
// strongest claim in the declaration depend on a race.
func (b *sandboxBackend) probe(withScope bool) (sandboxProbeReport, bool, error) {
	root, err := os.MkdirTemp("", "code-sandbox-probe-*")
	if err != nil {
		return sandboxProbeReport{}, false, err
	}
	defer os.RemoveAll(root)
	outside := filepath.Join(root, "host-state")
	if err := os.WriteFile(outside, []byte("host state the sandbox must not reach\n"), 0o600); err != nil {
		return sandboxProbeReport{}, false, err
	}

	spec := sandboxSpec{Outside: outside, Scratch: []string{sandboxWorkPath}}
	encoded, err := json.Marshal(spec)
	if err != nil {
		return sandboxProbeReport{}, false, err
	}

	mounts := sandboxMounts{scratch: []string{sandboxRoot}}
	mounts.bindSame(sandboxStore)
	mounts.bindAt(b.helper, sandboxHelperPath)

	systemd := b.systemd
	if !withScope {
		systemd = ""
	}
	probe := &sandboxBackend{helper: b.helper, bwrap: b.bwrap, systemd: systemd,
		scopeEnv: b.scopeEnv, ceilings: b.ceilings}
	// The probe enters through the same door as a run and carries a different
	// payload: the same namespaces, the same mounts, the same scope, and no
	// egress at all, because a probe has nothing to say to a provider.
	argv := probe.enter(mounts, sandboxWorkPath,
		sandboxHelperPath, sandboxHelperCommand, sandboxHelperProbe)

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Args = argv
	cmd.Env = append([]string{
		"PATH=" + os.Getenv("PATH"),
		sandboxSpecEnv + "=" + string(encoded),
	}, probe.scopeEnv...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return sandboxProbeReport{}, false, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return sandboxProbeReport{}, false, err
	}
	var diagnostics bytes.Buffer
	cmd.Stderr = &diagnostics
	if err := cmd.Start(); err != nil {
		return sandboxProbeReport{}, false, err
	}
	// Whatever happens below, nothing the probe started outlives this function.
	defer func() {
		_ = stdin.Close()
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	}()

	type answer struct {
		report sandboxProbeReport
		err    error
	}
	answers := make(chan answer, 1)
	go func() {
		line, err := bufio.NewReader(stdout).ReadBytes('\n')
		if err != nil && len(line) == 0 {
			answers <- answer{err: err}
			return
		}
		var report sandboxProbeReport
		if err := json.Unmarshal(bytes.TrimSpace(line), &report); err != nil {
			answers <- answer{err: err}
			return
		}
		answers <- answer{report: report}
	}()

	var got answer
	select {
	case got = <-answers:
	case <-time.After(sandboxProbeTimeout):
		return sandboxProbeReport{}, false, errors.New("the sandbox probe did not report in time")
	}
	if got.err != nil {
		detail := strings.TrimSpace(diagnostics.String())
		if detail == "" {
			detail = got.err.Error()
		}
		return sandboxProbeReport{}, false, errors.New(detail)
	}

	// The payload is blocked on stdin now, so the scope is certainly still
	// alive and its cgroup is certainly still there. That is the whole point of
	// the handshake: the ceiling check reads a running process rather than
	// racing one that has already reported and gone.
	ceilingsOK := false
	if withScope && b.systemd != "" {
		if _, err := b.verifyCeilings(cmd.Process.Pid); err == nil {
			ceilingsOK = true
		}
	}
	// Release it; the deferred kill is the backstop, not the plan.
	_, _ = stdin.Write([]byte("\n"))
	return got.report, ceilingsOK, nil
}
