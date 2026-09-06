//go:build unix

package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestEngineCancellationKillsTheWholeProcessTree is the obligation a client
// cannot verify from outside: cancellation must reach what OMP spawned, not
// just OMP. The fake OMP starts a grandchild in its own process group and then
// ignores everything, which is the shape of a real run wedged inside a
// subagent. Two cancellations are tried, because a client has two: the
// engine's context (a signal to the wrapper) and closing its stdin.
func TestEngineCancellationKillsTheWholeProcessTree(t *testing.T) {
	for _, tc := range []struct {
		name   string
		cancel func(cancel context.CancelFunc, stdin io.WriteCloser)
	}{
		{"by context", func(cancel context.CancelFunc, _ io.WriteCloser) { cancel() }},
		{"by closing stdin", func(_ context.CancelFunc, stdin io.WriteCloser) { stdin.Close() }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l, _ := newTestLauncher(t)
			fake, record := ompFakeBinary(t, "hang")
			l.lookOmp = func() (string, error) { return fake, nil }
			l.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
			opts := testLaunchOptions(t)

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stdinR, stdinW := io.Pipe()
			finished := make(chan int, 1)
			go func() {
				status, _ := l.serve(ctx, opts, stdinR, io.Discard, io.Discard)
				finished <- status
			}()

			// Cancel only once the tree demonstrably exists, so the kill is
			// measured against something rather than racing the launch.
			grandchild := waitForSleeper(t, record)
			if !alive(grandchild) {
				t.Fatalf("grandchild %d was already gone before cancellation, so this test would prove nothing", grandchild)
			}
			tc.cancel(cancel, stdinW)

			select {
			case status := <-finished:
				if status != 3 {
					t.Errorf("a killed child reported status %d, want 3 for a child that left no status", status)
				}
			case <-time.After(30 * time.Second):
				t.Fatal("the launch did not return after cancellation")
			}
			deadline := time.Now().Add(15 * time.Second)
			for alive(grandchild) {
				if time.Now().After(deadline) {
					t.Fatalf("grandchild %d survived cancellation; only the direct child was signalled", grandchild)
				}
				time.Sleep(20 * time.Millisecond)
			}
			data, err := os.ReadFile(opts.runtimeInfo)
			if err != nil {
				t.Fatalf("no runtime report after a torn-down run: %v", err)
			}
			if !strings.Contains(string(data), `"finished":true`) || !strings.Contains(string(data), `"exit_code":-1`) {
				t.Errorf("the finished report does not say the child was killed: %s", data)
			}
		})
	}
}

// waitForSleeper blocks until the fake OMP records the grandchild it started.
func waitForSleeper(t *testing.T, record string) int {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(record); err == nil {
			var got ompFakeRecord
			if json.Unmarshal(data, &got) == nil && got.Sleeper > 0 {
				return got.Sleeper
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the fake omp never started a grandchild")
	return 0
}

// alive reports whether a pid still names a live or unreaped process. Signal 0
// performs the permission and existence checks without delivering anything.
func alive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}
