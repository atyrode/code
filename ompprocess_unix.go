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

// ompChildUsage reports the child's CPU time and peak resident size once it has
// been waited for. Babel treats an absent resource record as unknown and a zero
// as a claim, so ok=false is the honest answer whenever the kernel handed back
// no usable rusage.
func ompChildUsage(cmd *exec.Cmd) (cpuSeconds float64, maxRSSBytes int64, ok bool) {
	if cmd.ProcessState == nil {
		return 0, 0, false
	}
	usage, ok := cmd.ProcessState.SysUsage().(*syscall.Rusage)
	if !ok || usage == nil {
		return 0, 0, false
	}
	seconds := func(tv syscall.Timeval) float64 {
		return float64(tv.Sec) + float64(tv.Usec)/1e6
	}
	return seconds(usage.Utime) + seconds(usage.Stime), ompMaxRSSBytes(int64(usage.Maxrss)), true
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
