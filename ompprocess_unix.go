//go:build unix

package main

import (
	"os/exec"
	"runtime"
	"syscall"
)

// Process-tree control for the OMP child. Babel owns process-tree lifetime and
// will kill whatever Code leaves behind, so the investigator has to be able to
// reach every descendant of the OMP it launched: OMP spawns subagents, MCP
// servers and language servers of its own, and signalling only the direct child
// would leave those running against a cancelled run.

// ompSetProcessGroup makes the OMP child the leader of its own process group.
// Everything it spawns inherits that group, which is what turns a cancellation
// into a tree kill rather than an orphan farm.
func ompSetProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// ompProcessGroup reads back the group the child actually landed in. The value
// is read rather than assumed to equal the child's pid, because a Setpgid the
// kernel refused would otherwise aim a whole-group signal at a group Code does
// not own — the one mistake a tree kill must never make.
func ompProcessGroup(cmd *exec.Cmd) int {
	if cmd.Process == nil {
		return 0
	}
	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil || pgid != cmd.Process.Pid {
		return 0
	}
	return pgid
}

// ompTerminateTree signals the child's whole process group: SIGTERM when
// graceful, SIGKILL otherwise. A negative pid addresses the group.
//
// The failure path is the point. If the group signal fails — the group is
// already empty, or Setpgid did not take — the direct child is signalled
// instead, so a cancellation never silently does nothing.
func ompTerminateTree(cmd *exec.Cmd, pgid int, graceful bool) error {
	signal := syscall.SIGKILL
	if graceful {
		signal = syscall.SIGTERM
	}
	if pgid > 0 {
		if err := syscall.Kill(-pgid, signal); err == nil {
			return nil
		}
	}
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Signal(signal)
}

// ompChildUsage reports what the kernel accounted to the OMP child once it has
// been waited for. It is the second-best source for a contained run and the
// only one for an uncontained one, so what it does not cover is named in the
// provenance rather than glossed: wait4 fills the rusage of the process that
// was reaped, so a tree that forked is understated, and ru_maxrss is that one
// process's high-water mark rather than the tree's sum.
//
// An unmeasured reading is the honest answer whenever the kernel handed back no
// usable rusage, because Babel treats an absent figure as unknown and a zero as
// a claim.
func ompChildUsage(cmd *exec.Cmd) runUsage {
	if cmd.ProcessState == nil {
		return runUsage{}
	}
	usage, ok := cmd.ProcessState.SysUsage().(*syscall.Rusage)
	if !ok || usage == nil {
		return runUsage{}
	}
	return runUsage{
		cpuSeconds: ompRusageSeconds(usage),
		cpuSource: "the omp child's rusage (wait4 ru_utime+ru_stime, seconds, " +
			"the direct child only, so a tree that forked is understated)",
		maxRSSBytes:  ompMaxRSSBytes(int64(usage.Maxrss)),
		maxRSSSource: "the omp child's rusage (wait4 ru_maxrss, one process's peak rather than the tree's)",
	}
}

// ompSelfUsage reports what the kernel has accounted to this worker process.
//
// It is the source for a run that launches nothing — the conformance
// directives reach Babel's observable states without OMP, a provider or a
// network, and the work they do happens right here — and it is a real reading
// of the process that did that work rather than a stand-in for a cgroup that
// does not exist.
//
// CPU is a cumulative counter, so a caller that wants the run's own share takes
// two readings and subtracts. ru_maxrss cannot be treated that way and is not:
// it is this process's high-water mark for its whole lifetime, which the
// provenance says.
func ompSelfUsage() runUsage {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return runUsage{}
	}
	return runUsage{
		cpuSeconds: ompRusageSeconds(&usage),
		cpuSource: "this worker process's own rusage (getrusage RUSAGE_SELF " +
			"ru_utime+ru_stime, seconds, differenced across the run)",
		maxRSSBytes: ompMaxRSSBytes(int64(usage.Maxrss)),
		maxRSSSource: "this worker process's own rusage (getrusage RUSAGE_SELF ru_maxrss, " +
			"the process's lifetime peak rather than this run's alone)",
	}
}

func ompRusageSeconds(usage *syscall.Rusage) float64 {
	seconds := func(tv syscall.Timeval) float64 {
		return float64(tv.Sec) + float64(tv.Usec)/1e6
	}
	return seconds(usage.Utime) + seconds(usage.Stime)
}

// ompMaxRSSBytes converts ru_maxrss to bytes. getrusage(2) reports kilobytes on
// Linux and bytes on Darwin, so the unit is resolved from the platform rather
// than assumed: a factor-of-1024 error in a receipt is worse than no number.
func ompMaxRSSBytes(maxrss int64) int64 {
	if runtime.GOOS == "darwin" {
		return maxrss
	}
	return maxrss * 1024
}
