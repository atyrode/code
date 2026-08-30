package main

// The analysis sandbox: what `code babel` actually contains an OMP session in,
// and what it tells Babel about that containment.
//
// Babel cannot inspect this process, so the babelContainment declaration Code
// writes at the first event of a run is the whole basis on which a reviewer
// later trusts — or discounts — the evidence the run produced. That makes one
// rule absolute here: nothing in this file may state a property the machine did
// not establish. Every boolean in the declaration is read off a probe that ran
// the real backend moments earlier and looked, from inside the sandbox and from
// the host's cgroup tree, for the thing it is about to claim. A property the
// probe could not establish is declared false and Babel refuses the run, which
// is the mechanism working rather than a defect to route around.
//
// This file is the portable half: the ceilings, the guest filesystem layout,
// the declaration, the provider endpoint the egress allowlist is resolved from,
// and the in-sandbox helper that Code re-enters itself as. sandbox_linux.go
// holds the backend that launches any of it; sandbox_other.go refuses.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

// ── ceilings ─────────────────────────────────────────────────────────────────

// sandboxCeilings are the resource limits a contained run is held to: three
// installed by the transient systemd user scope on the run's cgroup, and one
// installed by bubblewrap on every writable mount.
//
// Babel supplies none of them, and that is a fact about the wire contract
// rather than an omission here: the accept message carries babelLimits, which
// bounds the protocol — line bytes, event count, tool requests, idle seconds,
// exit grace — and names no memory, CPU, task or disk dimension at all. There
// is therefore nothing in a job to derive a ceiling from, so these are Code's
// own defaults and are documented as such:
//
//   - 4 GiB of memory, with swap denied. A driven OMP session with a few
//     subagents peaks well under a gigabyte; four leaves room for a large
//     context without leaving room for a leak to reach the machine's own
//     working set. Swap is denied because a memory ceiling a run can page
//     around is a throughput dial rather than a ceiling.
//   - 200% CPU, two cores' worth. Analysis waits on a provider far more than it
//     computes, so this bounds a runaway rather than shaping throughput.
//   - 512 tasks. OMP spawns subagents and language servers, which a few hundred
//     covers with margin, while a fork bomb reaches the wall in milliseconds.
//   - 1 GiB per writable mount. The sandbox writes only to tmpfs, and an
//     unsized tmpfs is bounded by the machine's RAM rather than by this run, so
//     each one is given an explicit size. A gigabyte is far more than an
//     analysis writes and far less than a disk-filling loop needs.
//
// One ceiling is deliberately absent. systemd accepts IOReadBandwidthMax and
// friends with exit status 0 and then silently drops them, because the io
// controller is not delegated into the user manager's slice on an ordinary
// desktop or CI host: io.max simply does not appear in the leaf. Setting one
// and believing the exit status would put a ceiling in the declaration that the
// kernel never installed, so none is set and the gap is named in the escape
// statement instead. Anyone adding one later must read io.max back before
// declaring anything on the strength of it.
//
// The numbers live here rather than inline so the escape statement, the scope
// invocation, the mount plan and the post-start verification all read the same
// four.
type sandboxCeilings struct {
	MemoryMaxBytes  int64
	CPUQuotaPercent int
	TasksMax        int
	// DiskMaxBytes sizes each writable tmpfs. tmpfs pages are charged to the
	// cgroup's memory, so this ceiling is enforced twice over: once by the
	// mount's own size and once by MemoryMaxBytes.
	DiskMaxBytes int64
}

func defaultSandboxCeilings() sandboxCeilings {
	return sandboxCeilings{
		MemoryMaxBytes:  4 << 30,
		CPUQuotaPercent: 200,
		TasksMax:        512,
		DiskMaxBytes:    1 << 30,
	}
}

// describeCgroup names the three ceilings the transient scope installs.
func (c sandboxCeilings) describeCgroup() string {
	return fmt.Sprintf("MemoryMax=%s with swap denied, CPUQuota=%d%% and TasksMax=%d",
		sandboxBytes(c.MemoryMaxBytes), c.CPUQuotaPercent, c.TasksMax)
}

// describeDisk names the one bubblewrap installs.
func (c sandboxCeilings) describeDisk() string {
	return sandboxBytes(c.DiskMaxBytes)
}

func sandboxBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return strconv.FormatInt(n>>30, 10) + "G"
	case n >= 1<<20:
		return strconv.FormatInt(n>>20, 10) + "M"
	default:
		return strconv.FormatInt(n, 10)
	}
}

// ── measuring what was bounded ───────────────────────────────────────────────

// runUsage is the resource use one run actually measured. It is the other half
// of sandboxCeilings and it sits next to it deliberately: a ceiling is enforced
// by comparing usage against it, so a worker that can hold a line is a worker
// that can say where the line was, and one that declares a bound while
// measuring nothing has made a claim it never checked.
//
// Each dimension carries the place it came from rather than a bare "ok" flag,
// and the empty string is what "unmeasured" means. That makes the rule this
// file lives by structural instead of remembered: a figure reaches a receipt
// only together with the file or syscall it was read off, so there is no way to
// add a number here without also naming its source. The provenance is not
// decoration — cgroup memory.peak and getrusage ru_maxrss are different
// measurements of different things, and a reviewer holding a receipt has to
// know which one the run reported.
//
// Nothing in here is ever synthesised. A dimension with no source is absent
// from the wire, not zero, because a zero in a receipt reads as a measurement.
type runUsage struct {
	// cpuSeconds is CPU time, in seconds, and cpuSource says whose.
	cpuSeconds float64
	cpuSource  string
	// maxRSSBytes is a peak resident figure, in bytes, already converted from
	// whatever unit its source reports. Conversion happens at the source, so a
	// value in here is always bytes.
	maxRSSBytes  int64
	maxRSSSource string
	// bytesWritten is what the run left on the filesystem it was allowed to
	// write, in bytes.
	bytesWritten int64
	bytesSource  string
}

// fillFrom completes the dimensions this reading has no source for from a
// second, weaker one. It never overwrites: the caller passes the readings in
// order of quality, so the cgroup's whole-tree figures win over a direct
// child's rusage wherever both exist.
func (u runUsage) fillFrom(other runUsage) runUsage {
	if u.cpuSource == "" {
		u.cpuSeconds, u.cpuSource = other.cpuSeconds, other.cpuSource
	}
	if u.maxRSSSource == "" {
		u.maxRSSBytes, u.maxRSSSource = other.maxRSSBytes, other.maxRSSSource
	}
	if u.bytesSource == "" {
		u.bytesWritten, u.bytesSource = other.bytesWritten, other.bytesSource
	}
	return u
}

// since turns a pair of readings of the same cumulative counter into the span
// between them, which is what a run's own CPU time is when the process doing
// the work outlives the run.
//
// Only CPU is a difference. A peak is a high-water mark and the difference of
// two high-water marks is not a smaller peak, it is nothing at all, so the
// later reading is kept and its source says whose peak it is. The clamp is not
// a fallback: utime and stime are monotonic, so a negative span would mean the
// kernel contradicted itself, and the one thing that must never leave here is a
// negative counter.
func (u runUsage) since(start runUsage) runUsage {
	if u.cpuSource == "" || start.cpuSource == "" {
		return u
	}
	if u.cpuSeconds -= start.cpuSeconds; u.cpuSeconds < 0 {
		u.cpuSeconds = 0
	}
	return u
}

// report renders what was measured into the wire's resource object, with every
// unmeasured dimension left off. calls is passed separately because it is not a
// resource reading at all: the driver counts every request it puts to Babel, so
// it is known whatever the machine could measure.
func (u runUsage) report(calls int) *babelResources {
	out := &babelResources{ToolCalls: calls}
	if u.cpuSource != "" {
		out.CPUSeconds = &u.cpuSeconds
	}
	if u.maxRSSSource != "" {
		out.MaxRSSBytes = &u.maxRSSBytes
	}
	if u.bytesSource != "" {
		out.SandboxBytesWritten = &u.bytesWritten
	}
	return out
}

// provenance names, for the operator, where each reported figure came from and
// which dimensions went unmeasured. It travels in the run's last progress
// message, which is the only place a receipt can carry it without changing the
// wire contract — and it has to be carried somewhere, because "4.1 seconds of
// CPU" is a fact about a cgroup or about a process and the two are not
// interchangeable.
func (u runUsage) provenance() string {
	parts := make([]string, 0, 3)
	if u.cpuSource != "" {
		parts = append(parts, "cpu from "+u.cpuSource)
	}
	if u.maxRSSSource != "" {
		parts = append(parts, "peak memory from "+u.maxRSSSource)
	}
	if u.bytesSource != "" {
		parts = append(parts, "bytes written from "+u.bytesSource)
	}
	if len(parts) == 0 {
		return "nothing this machine could measure, so no resource figure is reported"
	}
	return strings.Join(parts, ", ")
}

// The cgroup v2 counters a run's own scope exposes, and the units they are in.
// usage_usec is microseconds of CPU for every task that has ever been in the
// cgroup; memory.peak is the high-water mark in bytes of the same memory
// footprint that memory.max bounds.
const (
	sandboxCgroupCPUFile  = "cpu.stat"
	sandboxCgroupCPUKey   = "usage_usec"
	sandboxCgroupPeakFile = "memory.peak"
)

// sandboxCgroupUsage reads the usage counters of one cgroup v2 directory.
//
// This is the best source available for a contained run, and the reason is the
// thing that was bounded: MemoryMax and CPUQuota are installed on the scope's
// cgroup, so the cgroup's own counters cover the entire process tree inside it.
// A per-process figure would understate a tree that forked, which is precisely
// the tree a fork bomb produces and precisely the case the ceiling exists for.
//
// Every counter is optional and each one is treated separately. memory.peak is
// newer than memory.current, so a kernel without it reports no peak and the
// dimension is left unmeasured rather than filled from memory.current: current
// footprint and peak footprint are different measurements, and substituting one
// under the other's name would put a figure in a receipt that means something
// other than what the receipt says it means.
func sandboxCgroupUsage(dir string) runUsage {
	var usage runUsage
	if dir == "" {
		return usage
	}
	if usec, ok := sandboxCgroupKey(filepath.Join(dir, sandboxCgroupCPUFile), sandboxCgroupCPUKey); ok {
		usage.cpuSeconds = float64(usec) / 1e6
		usage.cpuSource = "the run's cgroup (" + sandboxCgroupCPUFile + " " + sandboxCgroupCPUKey +
			", microseconds, whole process tree)"
	}
	if peak, ok := sandboxCgroupValue(filepath.Join(dir, sandboxCgroupPeakFile)); ok {
		usage.maxRSSBytes = peak
		usage.maxRSSSource = "the run's cgroup (" + sandboxCgroupPeakFile +
			", bytes, whole process tree, the same footprint memory.max bounds)"
	}
	return usage
}

// sandboxCgroupKey reads one key out of a cgroup flat-keyed file, which is
// lines of "name value".
func sandboxCgroupKey(path, key string) (int64, bool) {
	body, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(body), "\n") {
		name, value, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok || name != key {
			continue
		}
		n, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		return n, err == nil
	}
	return 0, false
}

// sandboxCgroupValue reads a cgroup single-value file. "max" is a ceiling that
// is not set rather than a measurement, so it is not a usage figure and cannot
// appear in one.
func sandboxCgroupValue(path string) (int64, bool) {
	body, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(body)), 10, 64)
	return n, err == nil && n >= 0
}

// ── the guest filesystem ─────────────────────────────────────────────────────

// Where a contained run finds things. The paths are fixed because the sandbox
// is built for exactly one guest: a mount plan negotiated per run would be one
// more thing that could differ from what the declaration describes.
//
// Everything under sandboxRoot except home, work and the egress sockets is
// mounted read-only. home and work are tmpfs, so what the run writes exists
// only in the kernel's page cache for the lifetime of the mount namespace.
const (
	sandboxRoot       = "/run/code"
	sandboxHelperPath = sandboxRoot + "/bin/code"
	sandboxConfigPath = sandboxRoot + "/config.yml"
	sandboxPoolPath   = sandboxRoot + "/account-pool.json"
	sandboxHomePath   = sandboxRoot + "/home"
	sandboxWorkPath   = sandboxRoot + "/work"
	sandboxEgressDir  = sandboxRoot + "/egress"
	sandboxProxySock  = sandboxEgressDir + "/proxy.sock"
	sandboxBrokerSock = sandboxEgressDir + "/broker.sock"
)

// The loopback ports the in-sandbox forwarder listens on. The sandbox has a
// network namespace of its own with nothing in it but loopback, so these
// cannot collide with anything and do not need to be negotiated.
const (
	sandboxProxyPort  = 3128
	sandboxBrokerPort = 3129
)

// sandboxProxyURL is what PI_PROXY is set to inside. OMP bypasses its proxy for
// loopback targets, but that rule is about the target of a request rather than
// the address of the proxy, so a provider request still goes through here.
var sandboxProxyURL = "http://127.0.0.1:" + strconv.Itoa(sandboxProxyPort)

// sandboxProxyKeys are the proxy variables a contained session must not
// inherit. Every one of them names an address on the host, which inside the
// sandbox is either nothing at all or, worse, something else's loopback.
var sandboxProxyKeys = map[string]bool{
	"PI_PROXY":    true,
	"HTTP_PROXY":  true,
	"HTTPS_PROXY": true,
	"ALL_PROXY":   true,
	"NO_PROXY":    true,
	"http_proxy":  true,
	"https_proxy": true,
	"all_proxy":   true,
	"no_proxy":    true,
}

// sandboxProxyEnv points the session's fetch at the in-sandbox forwarder and
// strips every inherited proxy setting on the way.
//
// PI_PROXY is OMP's own hook: it is installed on the process-wide fetch at CLI
// startup, so it covers provider requests, OAuth refresh, login, usage probes
// and model discovery alike — which is the property that makes one variable
// enough to route a whole session through a boundary it cannot see.
func sandboxProxyEnv(base []string) []string {
	return append(removeEnvKeys(base, sandboxProxyKeys), "PI_PROXY="+sandboxProxyURL)
}

// ── the declaration ──────────────────────────────────────────────────────────

// Backend names. They are the string Babel records and a reviewer reads, so
// each one names a mechanism rather than an intention: "bwrap+systemd-scope" is
// namespaces plus an enforced cgroup, "bwrap" is namespaces with no ceilings,
// and "process" is no boundary at all.
const (
	sandboxBackendFull  = "bwrap+systemd-scope"
	sandboxBackendBwrap = "bwrap"
	sandboxBackendNone  = "process"
)

// sandboxFacts is what a live probe established, and the only thing the
// declaration is built from. Each boolean was observed: the filesystem and
// network claims by a payload that ran inside the sandbox and tried to violate
// them, the ceiling claim by reading the scope's cgroup back off the host.
type sandboxFacts struct {
	backend             string
	filesystemIsolation bool
	networkDefaultDeny  bool
	resourceCeilings    bool
	disposable          bool
	ceilings            sandboxCeilings
	// degraded lists, in the operator's words, every property the probe could
	// not establish and why. It is empty for a fully contained backend and is
	// appended to the escape statement otherwise, because a declaration that
	// drops a boolean without saying why is a puzzle rather than a warning.
	degraded []string
}

func (f sandboxFacts) contained() bool {
	return f.filesystemIsolation && f.networkDefaultDeny && f.disposable
}

// declare renders the containment Babel is held to. Nothing is added here that
// the probe did not establish; the prose only explains what the booleans mean.
func (f sandboxFacts) declare(egress sandboxEgressDescription) babelContainment {
	return babelContainment{
		Backend:             f.backend,
		FilesystemIsolation: f.filesystemIsolation,
		NetworkDefaultDeny:  f.networkDefaultDeny,
		ResourceCeilings:    f.resourceCeilings,
		Disposable:          f.disposable,
		Escape:              f.escape(egress),
	}
}

// sandboxEgressDescription is the non-secret half of the run's egress plan, as
// the escape statement needs to name it. It is passed in rather than read from
// a constant because the allowlist is resolved from the profile's provider, and
// a reviewer has to be told which endpoint the boundary actually opens.
type sandboxEgressDescription struct {
	provider string
	// allowed is every host:port the CONNECT proxy will dial, in the order the
	// run resolved them: the provider endpoint always, plus the auth broker
	// when it is off this machine and therefore an ordinary proxy target.
	allowed []string
	// relay reports that a second unix socket carries the run's auth-broker
	// traffic straight through, which is the case for a broker on loopback.
	relay bool
}

// escape is Code's statement of what it does not contain.
//
// It is prose rather than a checklist because a reviewer holding a receipt is
// deciding whether to believe a finding, and the useful form of that answer is
// "here is what an attacker who owns the model still has", in the order those
// things matter. The four residuals below are inherent to this design and do
// not go away by being written down; the degraded notes are specific to the
// machine this run happened on.
func (f sandboxFacts) escape(egress sandboxEgressDescription) string {
	var b strings.Builder
	if !f.contained() {
		b.WriteString("There is no sandbox. OMP runs as an ordinary child process under the same uid as " +
			"Code, with that user's whole filesystem and whole network, free to exhaust CPU, memory and " +
			"disk, and nothing it writes outside Code's temporary run directory is cleaned up. ")
		b.WriteString("Code tried to contain it and could not: ")
		b.WriteString(strings.Join(f.degraded, "; "))
		b.WriteString(". Treat every finding from this run as produced by unconfined code that held the " +
			"provider credential.")
		return b.String()
	}

	b.WriteString("OMP runs inside a bubblewrap sandbox — unprivileged user, mount, PID, IPC, UTS, cgroup " +
		"and network namespaces — on a tmpfs root. ")
	if f.resourceCeilings {
		b.WriteString("A transient systemd user scope holds the whole tree and installs " +
			f.ceilings.describeCgroup() + " on its cgroup; every writable mount is a tmpfs of at most " +
			f.ceilings.describeDisk() + ". ")
	}
	b.WriteString("The only host paths inside are read-only: the Nix store the binaries come from, the " +
		"profile's OMP overlay, the run's account pool, the system CA bundle, and the corpus paths the run's " +
		"grant named. The session's home and working directory are tmpfs and go away with the mount " +
		"namespace. There is no network interface but the sandbox's own loopback and no route off the " +
		"machine.\n\n")

	b.WriteString("Four things it does not contain, in the order they should be weighed.\n\n")

	b.WriteString("First, egress is restricted, not absent. A host-side HTTP CONNECT proxy that Code owns, " +
		"reached over a unix socket bind-mounted into the sandbox, is the single route out, and its " +
		"allowlist is ")
	switch len(egress.allowed) {
	case 0:
		b.WriteString("empty")
	case 1:
		b.WriteString("exactly one target, " + egress.allowed[0])
	default:
		b.WriteString(strconv.Itoa(len(egress.allowed)) + " targets: " + strings.Join(egress.allowed, ", "))
	}
	if egress.provider != "" {
		b.WriteString(" (the resolved profile's provider is " + egress.provider + ")")
	}
	b.WriteString(". Every other CONNECT target is refused and recorded. So a worker that compromises OMP " +
		"cannot reach this machine or the network at large, but it can still open a TLS tunnel to what is " +
		"allowed and put anything it can read into it.")
	if egress.relay {
		b.WriteString(" A second unix socket relays the run's auth-broker calls to the broker Code itself " +
			"uses, which is a service on this host, so a compromised worker can also drive that broker for " +
			"as long as the run lasts.")
	}
	b.WriteString("\n\n")

	b.WriteString("Second, the provider credential is inside the boundary. OMP authenticates for itself, so " +
		"the auth-broker token this run was issued is in the sandbox's environment. Anything that " +
		"compromises the session has it, and it is valid outside this run.\n\n")

	b.WriteString("Third, the isolation rests on unprivileged user namespaces. There is no hypervisor and no " +
		"privileged helper, and the sandbox runs under the same uid as Code, so a kernel defect in the " +
		"user-, mount- or network-namespace machinery defeats the entire boundary at once and lands the " +
		"attacker as the invoking user.\n\n")

	b.WriteString("Fourth, no seccomp filter is applied. Every syscall the kernel offers this uid is " +
		"reachable from inside; the containment is the namespaces and the cgroup and nothing narrower.")

	if f.resourceCeilings {
		b.WriteString("\n\nOne measured gap beyond those four. The ceilings bound memory, CPU, task count " +
			"and the space each writable mount can hold, but not I/O bandwidth: the io controller is not " +
			"delegated into the user manager's slice on this class of host, and systemd accepts an " +
			"IOReadBandwidthMax with exit status 0 and then drops it, so no such ceiling is set rather " +
			"than declared and not installed. A run can therefore saturate the disk it reads the corpus " +
			"from, which slows the machine without exhausting it.")
	}

	if len(f.degraded) > 0 {
		b.WriteString("\n\nOn this machine the backend also came up short: ")
		b.WriteString(strings.Join(f.degraded, "; "))
		b.WriteString(". The booleans above already reflect that.")
	}
	return b.String()
}

// ── one contained launch ─────────────────────────────────────────────────────

// sandboxRequest is everything a contained launch needs that is not fixed by
// the guest layout: which binaries and files the run has to be able to read,
// which corpus paths the grant named, the environment the session runs with,
// and the egress it is allowed to talk through.
type sandboxRequest struct {
	ompBinary  string
	configHost string
	poolHost   string
	caBundle   string
	corpus     []string
	egress     *sandboxEgress
}

// sandboxRun is one launch resolved into data: the command prefix that puts a
// guest argv inside the boundary, the environment that chain runs with, the
// descriptor the in-sandbox helper reports on, and the post-start check that
// confirms the ceilings the declaration claims.
//
// It is a portable value with a platform-specific constructor, so the parts of
// Code that launch a session — which are the same on every platform — do not
// need to know how the boundary is built or whether one exists.
type sandboxRun struct {
	prefix []string
	// env is what the sandbox adds to the launch's own environment: the
	// helper's instructions, and whatever the transient scope needs to reach
	// the user manager. bwrap unsets the latter again on the way in, so the
	// session never sees a runtime directory that does not exist inside.
	env     []string
	egress  *sandboxEgress
	spec    sandboxSpec
	reportR *os.File
	reportW *os.File
	// verify runs once the chain has started and reports whether the resource
	// ceilings the declaration claims are the ones the kernel installed, and
	// where it read them. It is nil when none were claimed.
	//
	// The cgroup directory it returns is kept rather than discarded because
	// the same files that prove a ceiling was installed are the ones that
	// report the usage it bounded. Resolving it twice would mean resolving it
	// a second time from a pid, and by then the run is over.
	verify func(pid int) (string, error)
	// cgroup is where verify found the run's ceilings, or empty for a tier
	// that installed none. A tier with no cgroup reports no cgroup figure,
	// which is what keeps the declaration and the report describing the same
	// machine.
	cgroup string
}

// command puts the guest argv inside the boundary.
func (r *sandboxRun) command(guest []string) []string {
	return append(append([]string(nil), r.prefix...), guest...)
}

// childEnv is the launch's environment with the sandbox's additions. The
// credential in base travels by inheritance, never on argv, which is why the
// spec is the only thing this adds by name.
func (r *sandboxRun) childEnv(base []string) []string {
	return append(append(make([]string, 0, len(base)+len(r.env)), base...), r.env...)
}

// extraFiles is the report pipe, which the helper writes its scratch
// measurement to. It lands on the child as sandboxReportFD.
func (r *sandboxRun) extraFiles() []*os.File {
	if r.reportW == nil {
		return nil
	}
	return []*os.File{r.reportW}
}

// started is called once the chain is running. It drops the parent's copy of
// the report pipe's write end — without that the read end never sees EOF — and
// then holds the run to the ceilings it declared.
//
// A failed verification is a hard error rather than a downgrade. The
// declaration went out before the launch, so a run that cannot establish what
// it claimed must not proceed: Babel has already recorded the claim.
func (r *sandboxRun) started(pid int) error {
	if r.reportW != nil {
		_ = r.reportW.Close()
		r.reportW = nil
	}
	if r.verify == nil {
		return nil
	}
	cgroup, err := r.verify(pid)
	if err != nil {
		return fmt.Errorf("this run declared resource ceilings and the sandbox did not install them, so "+
			"it is refused rather than run outside the boundary Babel was told about: %w", err)
	}
	r.cgroup = cgroup
	return nil
}

// usage is what the run's own cgroup says it used. It must be read while the
// tree is still alive: the transient scope is collected when its last task
// exits, and the cgroup directory goes with it, so a caller that stops the
// session first finds nothing to read.
//
// A run with no cgroup — the bubblewrap-only tier, or any platform with no
// backend — returns an unmeasured reading rather than a zero one. That is the
// same coherence the declaration is held to: a tier that could not install a
// ceiling has no cgroup to read a ceiling-derived figure out of, so it reports
// none and the caller falls back to what it can actually see.
func (r *sandboxRun) usage() runUsage {
	if r == nil {
		return runUsage{}
	}
	return sandboxCgroupUsage(r.cgroup)
}

// bytesWritten is what the run left in its scratch tmpfs, as measured from
// inside just before the helper exited. It is unobservable from the host once
// the mount namespace is gone, which is exactly the property that makes the
// sandbox disposable.
func (r *sandboxRun) bytesWritten(ctx context.Context) (int64, bool) {
	report, ok := sandboxReadExitReport(ctx, r.reportR)
	return report.BytesWritten, ok
}

// egressLog is every CONNECT the sandbox attempted, allowed or refused.
func (r *sandboxRun) egressLog() []sandboxConnect {
	if r == nil || r.egress == nil {
		return nil
	}
	return r.egress.attemptLog()
}

func (r *sandboxRun) close() {
	if r == nil {
		return
	}
	if r.reportW != nil {
		_ = r.reportW.Close()
		r.reportW = nil
	}
	if r.reportR != nil {
		_ = r.reportR.Close()
		r.reportR = nil
	}
	if r.egress != nil {
		r.egress.close()
	}
}

// ── the provider endpoint the allowlist is resolved from ─────────────────────

// sandboxProviderEndpoints maps a provider in Code's registry to the host its
// API is served from. The allowlist is resolved through this table from the
// profile Babel's job named, so the boundary follows the run's own provider
// rather than a vendor chosen here — and a provider with no entry is a refusal
// rather than a proxy that would forward anywhere.
//
// The table lives beside the sandbox rather than in providers.go because it is
// a containment parameter: it decides what the one hole in the network boundary
// points at, and it belongs where the person auditing that hole will look.
var sandboxProviderEndpoints = map[string]string{
	anthropicProvider: "api.anthropic.com",
	openAIProvider:    "chatgpt.com",
	deepseekProvider:  "api.deepseek.com",
}

// sandboxProviderPort is the only port the proxy will connect to. The provider
// APIs are HTTPS and a CONNECT proxy that would dial an arbitrary port is not
// an allowlist.
const sandboxProviderPort = 443

// sandboxProviderEndpoint resolves the one endpoint this run's egress allows.
//
// An unresolvable endpoint is terminal. The alternative — launching with a
// proxy that allows nothing, or worse, one that allows everything — would
// either fail the run three events later for a reason the receipt cannot
// explain, or open the boundary the declaration says is closed.
func sandboxProviderEndpoint(profile resolvedProfile) (provider, endpoint string, err error) {
	provider = strings.TrimSpace(profile.Metadata["provider"])
	if provider == "" {
		return "", "", errors.New("the resolved profile names no provider, so there is no endpoint to " +
			"allow and the sandbox has no route the analysis could use")
	}
	host, ok := sandboxProviderEndpoints[provider]
	if !ok {
		known := make([]string, 0, len(sandboxProviderEndpoints))
		for id := range sandboxProviderEndpoints {
			known = append(known, id)
		}
		sort.Strings(known)
		return "", "", fmt.Errorf("the resolved profile's provider %q has no known API endpoint, so the "+
			"sandbox cannot allow one; a contained run is possible only for %s",
			provider, strings.Join(known, ", "))
	}
	return provider, net.JoinHostPort(host, strconv.Itoa(sandboxProviderPort)), nil
}

// ── the corpus the grant named ───────────────────────────────────────────────

// sandboxCorpusPaths is the set of host paths the run's sources name, cleaned
// and deduplicated, that exist and can therefore be bound read-only.
//
// A selector that is not an absolute path — a URL, a repository name, an index
// key — binds nothing. That is not a silent drop: the model reaches such a
// source through Babel's brokered evidence tools, which is the route the grant
// exists for, and mounting the filesystem under a guess about a selector's
// shape would widen the boundary on a guess.
//
// Nothing is ever bound inside sandboxRoot, and that rule is load-bearing
// rather than tidy. OMP registers MCP servers from a config file sitting at the
// root of its working directory — measured against omp 18.0.11 across a dozen
// file shapes — and an MCP tool reaches the network without passing Babel's
// evidence broker at all. Archive content is untrusted by contract, so a corpus
// that landed at the session's working directory would let a `.mcp.json` in
// archived material register unbrokered egress before the model is even asked
// anything. The working directory is a tmpfs the sandbox creates empty, the
// corpus is bound at its own path, and discovery neither ascends nor descends,
// so the two can never meet.
func sandboxCorpusPaths(sources []babelSource) []string {
	seen := make(map[string]bool, len(sources))
	paths := make([]string, 0, len(sources))
	for _, source := range sources {
		selector := strings.TrimSpace(source.Selector)
		if selector == "" || !filepath.IsAbs(selector) {
			continue
		}
		path := filepath.Clean(selector)
		if seen[path] || path == sandboxRoot || strings.HasPrefix(path, sandboxRoot+"/") {
			continue
		}
		if _, err := os.Stat(path); err != nil {
			continue
		}
		seen[path] = true
		paths = append(paths, path)
	}
	return paths
}

// sandboxCABundle locates the trust store the session needs. The CONNECT proxy
// terminates nothing — it splices bytes — so TLS is verified inside the
// sandbox, and a sandbox with no CA bundle cannot talk to the provider it is
// allowed to reach. Exactly one file is bound, at the path it already has, so
// nothing else in /etc becomes visible.
func sandboxCABundle() string {
	for _, candidate := range []string{
		os.Getenv("NIX_SSL_CERT_FILE"),
		os.Getenv("SSL_CERT_FILE"),
		"/etc/ssl/certs/ca-certificates.crt",
		"/etc/pki/tls/certs/ca-bundle.crt",
	} {
		if candidate == "" {
			continue
		}
		if info, err := os.Stat(candidate); err == nil && info.Mode().IsRegular() {
			return candidate
		}
	}
	return ""
}

// ── the in-sandbox helper ────────────────────────────────────────────────────

// Code re-enters itself inside the sandbox. The helper is Code's own binary,
// bind-mounted read-only, because the sandbox has no network and the two jobs
// that have to happen inside — forwarding loopback to the host's unix sockets,
// and reporting what the run wrote — need a program that is already trusted and
// already there.
const (
	sandboxHelperCommand = "__sandbox"
	sandboxHelperEgress  = "egress"
	sandboxHelperProbe   = "probe"
)

// sandboxSpecEnv carries the helper's instructions. It holds ports and socket
// paths and no secret, and it travels in the environment rather than argv for
// consistency with everything else in this worker, not because it needs to.
const sandboxSpecEnv = "CODE_SANDBOX_SPEC"

// sandboxReportFD is the descriptor the helper writes its exit report on. It is
// a pipe Code holds the read end of: stdout is the OMP session's RPC stream and
// stderr is diagnostics, so a third channel is the only way the inside of the
// sandbox can report a measurement without corrupting either.
const sandboxReportFD = 3

// sandboxSpec is what the helper is told. Scratch is measured at exit so the
// receipt can carry what the run actually wrote, which is otherwise
// unobservable from the host once the mount namespace is gone.
type sandboxSpec struct {
	ProxyPort   int    `json:"proxy_port"`
	ProxySocket string `json:"proxy_socket"`
	// BrokerPort is zero when no auth broker needs relaying.
	BrokerPort   int      `json:"broker_port,omitempty"`
	BrokerSocket string   `json:"broker_socket,omitempty"`
	Scratch      []string `json:"scratch,omitempty"`
	// Outside is a host path the probe tries to read and write. It is the
	// filesystem-isolation claim's evidence: a probe that cannot reach it is
	// the only reason Code declares the boundary exists.
	Outside string `json:"outside,omitempty"`
}

// sandboxProbeReport is what the probe payload saw from inside. Every field is
// an observation, and containment() turns them into booleans without adding
// anything.
type sandboxProbeReport struct {
	Root            []string `json:"root"`
	Routes          int      `json:"routes"`
	OutsideReadable bool     `json:"outside_readable"`
	OutsideWritable bool     `json:"outside_writable"`
	ScratchWritable bool     `json:"scratch_writable"`
	StoreWritable   bool     `json:"store_writable"`
	Loopback        bool     `json:"loopback"`
}

// isolated reports whether the probe observed a filesystem boundary: the host
// path it was pointed at is neither readable nor writable, the read-only mounts
// are read-only, and the scratch it is supposed to write to works.
func (r sandboxProbeReport) isolated() bool {
	return !r.OutsideReadable && !r.OutsideWritable && !r.StoreWritable && r.ScratchWritable
}

// networkDenied reports the absence of a route off the machine. /proc/net/route
// carries one header line and one line per route, so an empty routing table is
// a namespace with nowhere to send a packet.
func (r sandboxProbeReport) networkDenied() bool { return r.Routes == 0 && r.Loopback }

// sandboxExitReport is what the helper writes on sandboxReportFD as it exits.
type sandboxExitReport struct {
	BytesWritten int64 `json:"bytes_written"`
}

// runSandboxHelper is Code running inside its own sandbox. It is reached only
// through the hidden `__sandbox` subcommand, which nothing but this file's
// backend ever spawns.
func runSandboxHelper(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "code: __sandbox needs a mode")
		return 2
	}
	var spec sandboxSpec
	if raw := os.Getenv(sandboxSpecEnv); raw != "" {
		if err := json.Unmarshal([]byte(raw), &spec); err != nil {
			fmt.Fprintln(os.Stderr, "code: __sandbox: unreadable spec:", err)
			return 2
		}
	}
	switch args[0] {
	case sandboxHelperProbe:
		return runSandboxProbe(spec)
	case sandboxHelperEgress:
		rest := args[1:]
		if len(rest) > 0 && rest[0] == "--" {
			rest = rest[1:]
		}
		if len(rest) == 0 {
			fmt.Fprintln(os.Stderr, "code: __sandbox egress needs a command")
			return 2
		}
		return runSandboxEgressHelper(spec, rest)
	default:
		fmt.Fprintln(os.Stderr, "code: __sandbox: unknown mode", args[0])
		return 2
	}
}

// runSandboxProbe attempts, from inside the sandbox, every violation the
// declaration is about to say is impossible, and reports what happened. It
// writes JSON to stdout and nothing else, because its caller parses it.
func runSandboxProbe(spec sandboxSpec) int {
	report := sandboxProbeReport{
		Root:   sandboxRootEntries(),
		Routes: sandboxRouteCount(),
	}
	if spec.Outside != "" {
		if _, err := os.ReadFile(spec.Outside); err == nil {
			report.OutsideReadable = true
		}
		if err := os.WriteFile(spec.Outside, []byte("escaped"), 0o600); err == nil {
			report.OutsideWritable = true
		}
	}
	for _, dir := range spec.Scratch {
		if err := os.WriteFile(filepath.Join(dir, "probe"), []byte("ok"), 0o600); err == nil {
			report.ScratchWritable = true
			break
		}
	}
	// A writable Nix store would mean the binaries the next run executes can be
	// rewritten by this one, which is the loudest possible failure of a
	// read-only bind.
	if err := os.WriteFile(filepath.Join(sandboxStore, ".code-sandbox-probe"), []byte("x"), 0o600); err == nil {
		report.StoreWritable = true
		_ = os.Remove(filepath.Join(sandboxStore, ".code-sandbox-probe"))
	}
	if listener, err := net.Listen("tcp", "127.0.0.1:0"); err == nil {
		report.Loopback = true
		_ = listener.Close()
	}
	body, err := json.Marshal(report)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: __sandbox probe:", err)
		return 2
	}
	os.Stdout.Write(append(body, '\n'))
	// Then hold until the parent lets go. The parent verifies the transient
	// scope's ceilings by reading the cgroup of a process it knows is running,
	// and a payload that exited the moment it reported would make the strongest
	// claim in the declaration depend on winning a race against its own teardown.
	_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
	return 0
}

// sandboxStore is the one host tree the sandbox needs to execute anything: the
// Nix store the omp wrapper, its interpreter and Code's own binary come from.
const sandboxStore = "/nix/store"

func sandboxRootEntries() []string {
	entries, err := os.ReadDir("/")
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

// sandboxRouteCount counts the routes the current network namespace has.
// /proc/net/route is a header line followed by one line per route, so a count
// of zero is a namespace that cannot send a packet anywhere.
func sandboxRouteCount() int {
	body, err := os.ReadFile("/proc/net/route")
	if err != nil {
		// No procfs is not evidence of a boundary, so it reads as routed.
		return -1
	}
	lines := 0
	for _, line := range strings.Split(strings.TrimSpace(string(body)), "\n") {
		if strings.TrimSpace(line) != "" {
			lines++
		}
	}
	if lines <= 1 {
		return 0
	}
	return lines - 1
}

// sandboxScratchBytes sums what the run left in its tmpfs scratch. It runs
// inside, where the tmpfs still exists; from the host it is unobservable once
// the mount namespace is gone, which is the point of the tmpfs.
func sandboxScratchBytes(dirs []string) int64 {
	var total int64
	for _, dir := range dirs {
		_ = filepath.WalkDir(dir, func(_ string, entry os.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return nil
			}
			if info, err := entry.Info(); err == nil {
				total += info.Size()
			}
			return nil
		})
	}
	return total
}

// sandboxRefusal names the platform whose backend has not been qualified. Only
// Linux has one; on anything else exploration is refused legibly rather than
// run behind a boundary nobody has tested.
func sandboxRefusal() string {
	return "no analysis sandbox exists for " + runtime.GOOS +
		": Code's containment backend is bubblewrap inside a transient systemd user scope, which is Linux " +
		"only, and running an analysis unconfined on a platform whose backend has not been qualified would " +
		"put a boundary in a receipt that was never built"
}
