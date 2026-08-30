//go:build unix

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"syscall"
	"testing"
	"time"
)

// TestOmpDriveCancellationKillsTheWholeProcessTree is the obligation Babel
// cannot verify from outside: cancellation must reach what OMP spawned, not just
// OMP. The fake OMP starts a grandchild in its own process group and then stops
// answering, which is the shape of a real run wedged inside a subagent.
func TestOmpDriveCancellationKillsTheWholeProcessTree(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "hang")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	type outcome struct {
		result babelResult
		err    error
	}
	finished := make(chan outcome, 1)
	go func() {
		result, err := inv.investigate(ctx, testJob("", babelCapabilityCorpusSearch), rec.emit, rec.request)
		finished <- outcome{result, err}
	}()

	// Cancel only once the tree demonstrably exists, so the kill is measured
	// against something rather than racing the launch.
	grandchild := waitForSleeper(t, record)
	if !alive(grandchild) {
		t.Fatalf("grandchild %d was already gone before cancellation, so this test would prove nothing", grandchild)
	}
	cancel()

	select {
	case got := <-finished:
		if !errors.Is(got.err, context.Canceled) {
			t.Fatalf("error = %v; want context.Canceled", got.err)
		}
		if got.result.Status != "" {
			t.Errorf("a cancelled run still produced a result: %+v", got.result)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the run did not return after cancellation")
	}

	deadline := time.Now().Add(15 * time.Second)
	for alive(grandchild) {
		if time.Now().After(deadline) {
			t.Fatalf("grandchild %d survived cancellation; only the direct child was signalled", grandchild)
		}
		time.Sleep(20 * time.Millisecond)
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
