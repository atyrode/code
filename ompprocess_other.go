//go:build !unix

package main

import "os/exec"

// ompSetProcessGroup is a no-op off Unix.
//
// Code ships on Linux and macOS, both Unix. This file exists so the package
// still compiles elsewhere, and it deliberately does not pretend to offer the
// process-tree guarantee Babel requires: without a process group there is
// nothing portable to signal but the direct child.
func ompSetProcessGroup(*exec.Cmd) {}

// ompProcessGroup reports no group, so ompTerminateTree takes its child-only
// path rather than aiming a group signal at a group that was never created.
func ompProcessGroup(*exec.Cmd) int { return 0 }

// ompTerminateTree kills the direct child only. Anything OMP spawned survives,
// which is why this platform is unsupported rather than quietly degraded: a
// caller relying on the tree guarantee must run on Linux or macOS.
func ompTerminateTree(cmd *exec.Cmd, _ int, _ bool) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}

// ompChildUsage and ompSelfUsage report nothing. Off Unix there is no rusage to
// read, and reporting zeroes would turn "unknown" into a claim in Babel's
// receipt. A run on this platform therefore reports only the tool calls it
// counted and the bytes it can see on disk, which is exactly as much as this
// platform can honestly say — and it declares no containment at all, so there
// is no ceiling here whose enforcement a missing figure would leave unproven.
func ompChildUsage(*exec.Cmd) runUsage { return runUsage{} }

func ompSelfUsage() runUsage { return runUsage{} }
