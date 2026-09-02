package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"
	"time"
)

func writeSessionFixture(t *testing.T, dir string, rec sessionRecord) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, string(rune('0'+rec.PID%10))+"-fixture.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSessionRecordIsListedWhileHeld(t *testing.T) {
	dir := t.TempDir()
	rec := sessionRecord{PID: os.Getpid(), Profile: "mixed", Binary: "/nix/store/a/omp", Started: time.Now().Unix()}
	handle, err := openSession(dir, rec)
	if err != nil {
		t.Fatalf("openSession: %v", err)
	}
	defer handle.Close()

	entries := loadSessions(dir)
	if len(entries) != 1 {
		t.Fatalf("live session count = %d, want 1", len(entries))
	}
	if entries[0].PID != rec.PID || entries[0].Profile != "mixed" {
		t.Fatalf("round-tripped record = %+v, want pid %d profile mixed", entries[0].sessionRecord, rec.PID)
	}
}

func TestSessionHandleUpdatePersistsPool(t *testing.T) {
	dir := t.TempDir()
	rec := sessionRecord{PID: os.Getpid(), Profile: "managed", Started: time.Now().Unix()}
	handle, err := openSession(dir, rec)
	if err != nil {
		t.Fatalf("openSession: %v", err)
	}
	defer handle.Close()

	pool := map[string][]string{"anthropic": {"alex"}}
	if err := handle.Update(func(r *sessionRecord) {
		r.Pool = pool
		r.PoolAt = 42
	}); err != nil {
		t.Fatalf("Update: %v", err)
	}

	entries := loadSessions(dir)
	if len(entries) != 1 {
		t.Fatalf("live session count = %d, want 1", len(entries))
	}
	if !reflect.DeepEqual(entries[0].Pool, pool) || entries[0].PoolAt != 42 {
		t.Fatalf("round-tripped record = %+v, want pool %#v poolAt 42", entries[0].sessionRecord, pool)
	}
	if !sessionLive(entries[0].Path) {
		t.Fatal("Update must not release the liveness lock")
	}

	var nilHandle *sessionHandle
	if err := nilHandle.Update(func(r *sessionRecord) { r.Profile = "should not run" }); err != nil {
		t.Fatalf("nil handle Update must be a no-op, got error: %v", err)
	}
}

func TestSessionRecordRemovedOnClose(t *testing.T) {
	dir := t.TempDir()
	handle, err := openSession(dir, sessionRecord{PID: os.Getpid(), Profile: "mixed", Started: time.Now().Unix()})
	if err != nil {
		t.Fatalf("openSession: %v", err)
	}
	handle.Close()
	if entries := loadSessions(dir); len(entries) != 0 {
		t.Fatalf("closed session still listed: %+v", entries)
	}
	if _, err := os.Stat(handle.path); !os.IsNotExist(err) {
		t.Fatalf("record file survived Close: %v", err)
	}
}

// A record nobody holds a lock on describes a process that is gone — the case a
// crashed or SIGKILLed session leaves behind. It must never be reported live,
// because its PID may since have been recycled onto an unrelated process.
func TestSessionUnlockedRecordIsPrunedNotListed(t *testing.T) {
	dir := t.TempDir()
	// PID 1 is certainly alive, so liveness cannot be coming from the PID here:
	// only the absent lock can classify this record as dead.
	path := writeSessionFixture(t, dir, sessionRecord{PID: 1, Profile: "stale", Started: time.Now().Unix()})

	if entries := loadSessions(dir); len(entries) != 0 {
		t.Fatalf("unlocked record reported live: %+v", entries)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("dead record was not pruned: %v", err)
	}
}

func TestSessionCorruptRecordIsPruned(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "corrupt.json")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if entries := loadSessions(dir); len(entries) != 0 {
		t.Fatalf("corrupt record listed: %+v", entries)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("corrupt record was not pruned: %v", err)
	}
}

func TestSessionRecordingDisabled(t *testing.T) {
	handle, err := openSession(sessionDisabled, sessionRecord{PID: os.Getpid()})
	if err != nil {
		t.Fatalf("disabled openSession returned error: %v", err)
	}
	if handle != nil {
		t.Fatal("disabled openSession returned a handle")
	}
	handle.Close() // must tolerate a nil receiver
	if entries := loadSessions(sessionDisabled); entries != nil {
		t.Fatalf("disabled loadSessions returned %+v", entries)
	}
}

func TestSessionsSortedOldestFirst(t *testing.T) {
	dir := t.TempDir()
	now := time.Now().Unix()
	first, err := openSession(dir, sessionRecord{PID: os.Getpid(), Profile: "newer", Started: now})
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	// A second live record needs a second lock holder; a child process is the
	// honest way to get one, so drive the ordering through a fixture the parent
	// keeps locked instead.
	older := sessionRecord{PID: os.Getpid(), Profile: "older", Started: now - 3600}
	data, err := json.Marshal(older)
	if err != nil {
		t.Fatal(err)
	}
	olderPath := filepath.Join(dir, "older.json")
	f, err := os.OpenFile(olderPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatal(err)
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)

	entries := loadSessions(dir)
	if len(entries) != 2 {
		t.Fatalf("session count = %d, want 2", len(entries))
	}
	if entries[0].Profile != "older" || entries[1].Profile != "newer" {
		t.Fatalf("order = [%s %s], want [older newer]", entries[0].Profile, entries[1].Profile)
	}
}

func TestSupersededComparesLauncherPath(t *testing.T) {
	entry := sessionEntry{sessionRecord: sessionRecord{Binary: "/nix/store/old/omp"}}
	if !entry.Superseded("/nix/store/new/omp") {
		t.Fatal("different launcher path not reported superseded")
	}
	if entry.Superseded("/nix/store/old/omp") {
		t.Fatal("identical launcher path reported superseded")
	}
	// Unknown on either side must never be guessed into a reap candidate.
	if entry.Superseded("") {
		t.Fatal("unresolvable current launcher reported superseded")
	}
	if (sessionEntry{}).Superseded("/nix/store/new/omp") {
		t.Fatal("record without a recorded launcher reported superseded")
	}
}

func TestProcessTreeIncludesDescendantsParentsFirst(t *testing.T) {
	snapshot := func() map[int][]int {
		return map[int][]int{
			10: {20, 21},
			20: {30},
			30: {40},
			99: {98}, // unrelated branch must not be swept in
		}
	}
	got := processTree(10, snapshot)
	want := []int{10, 20, 21, 30, 40}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("processTree = %v, want %v", got, want)
	}
}

// A malformed ps snapshot must not hang the reaper.
func TestProcessTreeTerminatesOnCycle(t *testing.T) {
	snapshot := func() map[int][]int {
		return map[int][]int{10: {20}, 20: {10}}
	}
	got := processTree(10, snapshot)
	want := []int{10, 20}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("processTree = %v, want %v", got, want)
	}
}

type recordedSignal struct {
	pid int
	sig syscall.Signal
}

// Children must be signalled before their parents, so a parent cannot observe a
// child dying and respawn it while the reap is still in progress.
func TestReapTreeSignalsChildrenBeforeParents(t *testing.T) {
	var sent []recordedSignal
	s := signaller{
		kill: func(pid int, sig syscall.Signal) error {
			sent = append(sent, recordedSignal{pid, sig})
			return nil
		},
		alive: func(int) bool { return false },
		sleep: func(time.Duration) { t.Fatal("slept despite every process being gone") },
	}
	reapTree([]int{10, 20, 30}, time.Second, s)

	want := []recordedSignal{
		{30, syscall.SIGTERM}, {20, syscall.SIGTERM}, {10, syscall.SIGTERM},
	}
	if !reflect.DeepEqual(sent, want) {
		t.Fatalf("signals = %v, want %v", sent, want)
	}
}

// SIGTERM is the polite path: a process that exits within grace must never be
// SIGKILLed, so omp keeps the chance to persist its state.
func TestReapTreeSkipsKillWhenTermSucceeds(t *testing.T) {
	var sent []recordedSignal
	s := signaller{
		kill: func(pid int, sig syscall.Signal) error {
			sent = append(sent, recordedSignal{pid, sig})
			return nil
		},
		alive: func(int) bool { return false },
		sleep: func(time.Duration) {},
	}
	reapTree([]int{7}, time.Second, s)
	for _, got := range sent {
		if got.sig == syscall.SIGKILL {
			t.Fatalf("SIGKILL sent to a process that exited on SIGTERM: %v", sent)
		}
	}
}

// Anything still standing after grace must be SIGKILLed, or the reap silently
// frees nothing — the failure mode that made the original incident unrecoverable.
func TestReapTreeEscalatesToKillAfterGrace(t *testing.T) {
	var sent []recordedSignal
	slept := time.Duration(0)
	s := signaller{
		kill: func(pid int, sig syscall.Signal) error {
			sent = append(sent, recordedSignal{pid, sig})
			return nil
		},
		alive: func(int) bool { return true },
		sleep: func(d time.Duration) { slept += d },
	}
	reapTree([]int{7}, 300*time.Millisecond, s)

	want := []recordedSignal{{7, syscall.SIGTERM}, {7, syscall.SIGKILL}}
	if !reflect.DeepEqual(sent, want) {
		t.Fatalf("signals = %v, want %v", sent, want)
	}
	if slept != 300*time.Millisecond {
		t.Fatalf("waited %v, want the full 300ms grace", slept)
	}
}

func TestParseAge(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want time.Duration
		bad  bool
	}{
		{in: "90m", want: 90 * time.Minute},
		{in: "24h", want: 24 * time.Hour},
		{in: "3d", want: 72 * time.Hour},
		{in: "0.5d", want: 12 * time.Hour},
		{in: "", bad: true},
		{in: "xd", bad: true},
		{in: "banana", bad: true},
	} {
		got, err := parseAge(tc.in)
		if tc.bad {
			if err == nil {
				t.Fatalf("parseAge(%q) accepted an invalid duration", tc.in)
			}
			continue
		}
		if err != nil {
			t.Fatalf("parseAge(%q): %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("parseAge(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
}

func TestFmtAge(t *testing.T) {
	for _, tc := range []struct {
		in   time.Duration
		want string
	}{
		{in: 5 * time.Second, want: "5s"},
		{in: 90 * time.Second, want: "1m"},
		{in: 2*time.Hour + 30*time.Minute, want: "2h30m"},
		{in: 26 * time.Hour, want: "1d2h"},
	} {
		if got := fmtAge(tc.in); got != tc.want {
			t.Fatalf("fmtAge(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// Reaping every session must be asked for explicitly; a forgotten flag must not
// be a way to end all running work.
func TestReapRefusesWithoutFilter(t *testing.T) {
	t.Setenv("CODE_SESSION_STATE", t.TempDir())
	if code := runSessionReap(nil); code != 2 {
		t.Fatalf("unfiltered reap exit = %d, want 2", code)
	}
}

func TestSessionRejectsUnknownSubcommand(t *testing.T) {
	if code := runSession([]string{"destroy"}); code != 2 {
		t.Fatalf("unknown subcommand exit = %d, want 2", code)
	}
	if code := runSession(nil); code != 2 {
		t.Fatalf("bare session exit = %d, want 2", code)
	}
	if code := runSession([]string{"--help"}); code != 0 {
		t.Fatalf("help exit = %d, want 0", code)
	}
}

func TestSessionDirPrefersOverride(t *testing.T) {
	t.Setenv("CODE_SESSION_STATE", "/tmp/explicit-session-dir")
	if got := sessionDir(); got != "/tmp/explicit-session-dir" {
		t.Fatalf("sessionDir = %q, want the override", got)
	}
	// Empty must fall back to the default rather than disable recording: the
	// dotfiles wrapper does not set this variable.
	t.Setenv("CODE_SESSION_STATE", "")
	t.Setenv("XDG_STATE_HOME", "/tmp/xdg-state")
	if got := sessionDir(); got != filepath.Join("/tmp/xdg-state", "code", "sessions") {
		t.Fatalf("sessionDir = %q, want the XDG default", got)
	}
}
