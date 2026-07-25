package main

// Session registry.
//
// `code` is the live parent of every session it launches: runChild blocks in
// cmd.Run for the session's whole life, so a session's liveness is exactly this
// process's liveness. Each launch records itself under the session directory and
// holds an exclusive flock on that record until it exits.
//
// The lock — not the PID — is the liveness signal. A PID alone is unsafe: PIDs
// are recycled, and a reaper that signals a recycled PID kills an unrelated
// process. The kernel releases the lock however the owner dies, including
// SIGKILL and power loss, so a record whose lock can be acquired is provably
// dead and its PID must never be signalled. That invariant is what makes it safe
// for reap to send signals at all.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"
)

// sessionDisabled is the CODE_SESSION_STATE value that turns recording off.
const sessionDisabled = "off"

// sessionRecord is the on-disk description of one launched session. PID is the
// `code` process, which is the root of the session's process tree — omp and
// everything omp spawns (language servers, browsers, workers) descend from it.
type sessionRecord struct {
	PID     int    `json:"pid"`
	Binary  string `json:"binary,omitempty"`
	Profile string `json:"profile"`
	Cwd     string `json:"cwd,omitempty"`
	Started int64  `json:"started"`
}

// sessionEntry is a record plus what the registry could determine about it.
type sessionEntry struct {
	sessionRecord
	Path string
}

func defaultSessionDir() string {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "state")
	}
	return filepath.Join(base, "code", "sessions")
}

// sessionDir resolves the registry location. Unlike the other CODE_* state
// variables an empty value is NOT an opt-out here: the dotfiles wrapper does not
// set this one, so defaulting to disabled would ship a feature that silently
// never records anything. CODE_SESSION_STATE=off is the explicit opt-out.
func sessionDir() string {
	if v := os.Getenv("CODE_SESSION_STATE"); v != "" {
		return v
	}
	return defaultSessionDir()
}

// sessionHandle owns a live record: the open descriptor holds the flock, so the
// handle must outlive the session it describes.
type sessionHandle struct {
	path string
	file *os.File
}

// openSession writes the record and takes its liveness lock. A nil handle is a
// valid no-op result (recording disabled), so Close tolerates a nil receiver.
func openSession(dir string, rec sessionRecord) (*sessionHandle, error) {
	if dir == "" || dir == sessionDisabled {
		return nil, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, strconv.Itoa(rec.PID)+".json")
	// A same-PID record can only be a leftover from a dead process — the lock
	// below is what proves it — so truncating here is safe.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, err
	}
	data, err := json.Marshal(rec)
	if err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
		os.Remove(path)
		return nil, err
	}
	return &sessionHandle{path: path, file: f}, nil
}

// Close retires the record. Removing before unlocking keeps any concurrent
// reader from seeing an unlocked-but-present record and reporting it dead.
func (h *sessionHandle) Close() {
	if h == nil {
		return
	}
	os.Remove(h.path)
	syscall.Flock(int(h.file.Fd()), syscall.LOCK_UN)
	h.file.Close()
}

// sessionLive reports whether a record's owner still holds its lock. Acquiring
// the lock means nobody owns it, which means the owner is gone.
func sessionLive(path string) bool {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return false
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return true
	}
	syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return false
}

// loadSessions returns the live sessions, oldest first, pruning records whose
// owner is gone. Pruning on read is what keeps a crashed session (SIGKILL, power
// loss) from lingering in the listing forever; a dead record describes nothing
// that can still be acted on.
func loadSessions(dir string) []sessionEntry {
	if dir == "" || dir == sessionDisabled {
		return nil
	}
	paths, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil
	}
	var entries []sessionEntry
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var rec sessionRecord
		if err := json.Unmarshal(data, &rec); err != nil || rec.PID <= 0 {
			// Unparseable records are pruned only when nothing holds them, so a
			// half-written record from a live launch survives to its next read.
			if !sessionLive(path) {
				os.Remove(path)
			}
			continue
		}
		if !sessionLive(path) {
			os.Remove(path)
			continue
		}
		entries = append(entries, sessionEntry{sessionRecord: rec, Path: path})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Started != entries[j].Started {
			return entries[i].Started < entries[j].Started
		}
		return entries[i].PID < entries[j].PID
	})
	return entries
}

// currentBinary is the launcher the next session would use — the reference for
// deciding a running session is on a superseded build.
func currentBinary() string {
	path, err := resolveLaunchPath("CODE_OMP", []string{"omp"})
	if err != nil {
		return ""
	}
	return path
}

// Superseded reports that this session runs a different launcher than a new one
// would. With Nix store paths that is an exact comparison rather than a version
// heuristic: a rebuilt or upgraded launcher lands on a new path.
func (e sessionEntry) Superseded(current string) bool {
	return current != "" && e.Binary != "" && e.Binary != current
}

func (e sessionEntry) Age(now time.Time) time.Duration {
	if e.Started <= 0 {
		return 0
	}
	return now.Sub(time.Unix(e.Started, 0))
}

// fmtAge renders a duration at two units of precision, which is all a triage
// listing needs ("3d4h" reads better than an exact second count).
func fmtAge(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh%dm", int(d.Hours()), int(d.Minutes())%60)
	default:
		return fmt.Sprintf("%dd%dh", int(d.Hours())/24, int(d.Hours())%24)
	}
}

// parseAge accepts Go durations plus a day suffix, because the ages that matter
// for abandoned sessions are measured in days and time.ParseDuration has no 'd'.
func parseAge(s string) (time.Duration, error) {
	if strings.HasSuffix(s, "d") {
		days, err := strconv.ParseFloat(strings.TrimSuffix(s, "d"), 64)
		if err != nil {
			return 0, fmt.Errorf("invalid duration %q", s)
		}
		return time.Duration(days * float64(24*time.Hour)), nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return 0, fmt.Errorf("invalid duration %q", s)
	}
	return d, nil
}

// processTree returns root followed by every descendant, parents before
// children. Reaping only the recorded root would orphan the children onto init
// and leave the memory that motivated the reap still allocated, so callers need
// the whole tree.
func processTree(root int, snapshot func() map[int][]int) []int {
	children := snapshot()
	seen := map[int]bool{root: true}
	order := []int{root}
	// Deliberately not `range order`: the slice grows as descendants are
	// discovered, and range would freeze the bound at its initial length.
	for i := 0; i < len(order); i++ {
		for _, child := range children[order[i]] {
			if !seen[child] {
				seen[child] = true
				order = append(order, child)
			}
		}
	}
	return order
}

// psChildren maps parent PID to children via ps, which is present and
// consistent on both supported platforms (procfs is Linux-only, and this is a
// once-per-invocation cost, not a hot path).
func psChildren() map[int][]int {
	out, err := exec.Command("ps", "-eo", "pid=,ppid=").Output()
	if err != nil {
		return nil
	}
	children := map[int][]int{}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		ppid, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil || pid <= 0 {
			continue
		}
		children[ppid] = append(children[ppid], pid)
	}
	return children
}

func pidAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

// signaller abstracts process signalling so the escalation policy is testable
// without spawning real processes, mirroring saveSelectionStateWithRename's
// injected rename.
type signaller struct {
	kill  func(pid int, sig syscall.Signal) error
	alive func(pid int) bool
	sleep func(time.Duration)
}

func osSignaller() signaller {
	return signaller{
		kill:  func(pid int, sig syscall.Signal) error { return syscall.Kill(pid, sig) },
		alive: pidAlive,
		sleep: time.Sleep,
	}
}

// reapTree stops a session politely, then insistently: SIGTERM so omp can
// persist its state, SIGKILL only for what is still standing after grace.
// Children are signalled before their parents so a supervisor cannot observe a
// child dying and restart it mid-reap.
func reapTree(pids []int, grace time.Duration, s signaller) (signalled int) {
	for i := len(pids) - 1; i >= 0; i-- {
		if s.kill(pids[i], syscall.SIGTERM) == nil {
			signalled++
		}
	}
	for deadline := grace; deadline > 0; {
		if !anyAlive(pids, s.alive) {
			return signalled
		}
		step := 100 * time.Millisecond
		if step > deadline {
			step = deadline
		}
		s.sleep(step)
		deadline -= step
	}
	for i := len(pids) - 1; i >= 0; i-- {
		if s.alive(pids[i]) {
			s.kill(pids[i], syscall.SIGKILL)
		}
	}
	return signalled
}

func anyAlive(pids []int, alive func(int) bool) bool {
	for _, pid := range pids {
		if alive(pid) {
			return true
		}
	}
	return false
}

// runSession implements `code session …` (and the `code ls` shorthand).
func runSession(args []string) int {
	if len(args) == 0 {
		fmt.Print(sessionHelp)
		return 2
	}
	switch args[0] {
	case "list":
		return runSessionList(args[1:])
	case "reap":
		return runSessionReap(args[1:])
	case "-h", "--help":
		fmt.Print(sessionHelp)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "code session: unknown subcommand %q\n%s", args[0], sessionHelp)
		return 2
	}
}

func runSessionList(args []string) int {
	for _, arg := range args {
		switch arg {
		case "-h", "--help":
			fmt.Print(sessionHelp)
			return 0
		default:
			fmt.Fprintf(os.Stderr, "code session list: unknown flag %q\n%s", arg, sessionHelp)
			return 2
		}
	}
	entries := loadSessions(sessionDir())
	if len(entries) == 0 {
		fmt.Println("no live sessions")
		return 0
	}
	current := currentBinary()
	now := time.Now()
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "PID\tAGE\tPROFILE\tLAUNCHER\tDIRECTORY")
	for _, e := range entries {
		launcher := "current"
		if e.Superseded(current) {
			launcher = "superseded"
		} else if e.Binary == "" {
			launcher = "unknown"
		}
		fmt.Fprintf(w, "%d\t%s\t%s\t%s\t%s\n", e.PID, fmtAge(e.Age(now)), e.Profile, launcher, e.Cwd)
	}
	w.Flush()
	return 0
}

func runSessionReap(args []string) int {
	var (
		olderThan  time.Duration
		haveOlder  bool
		superseded bool
		all        bool
		confirm    bool
		grace      = 10 * time.Second
	)
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--older-than":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "code session reap: --older-than needs a duration")
				return 2
			}
			d, err := parseAge(args[i])
			if err != nil {
				fmt.Fprintf(os.Stderr, "code session reap: %v\n", err)
				return 2
			}
			olderThan, haveOlder = d, true
		case "--grace":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "code session reap: --grace needs a duration")
				return 2
			}
			d, err := parseAge(args[i])
			if err != nil {
				fmt.Fprintf(os.Stderr, "code session reap: %v\n", err)
				return 2
			}
			grace = d
		case "--superseded":
			superseded = true
		case "--all":
			all = true
		case "--yes":
			confirm = true
		case "-h", "--help":
			fmt.Print(sessionHelp)
			return 0
		default:
			fmt.Fprintf(os.Stderr, "code session reap: unknown flag %q\n%s", args[i], sessionHelp)
			return 2
		}
	}
	// An unfiltered reap would end every running session, so it has to be asked
	// for by name rather than reached by forgetting a flag.
	if !haveOlder && !superseded && !all {
		fmt.Fprintln(os.Stderr, "code session reap: refusing to reap without a filter — pass --older-than, --superseded, or --all")
		return 2
	}

	entries := loadSessions(sessionDir())
	current := currentBinary()
	now := time.Now()
	self := os.Getpid()

	var targets []sessionEntry
	for _, e := range entries {
		if e.PID == self {
			continue
		}
		if !all {
			if haveOlder && e.Age(now) < olderThan {
				continue
			}
			if superseded && !e.Superseded(current) {
				continue
			}
			// With only --superseded set, age never filters; with only
			// --older-than, supersession never does. Both set means both must
			// hold, which is the conservative reading of two filters.
			if !haveOlder && !superseded {
				continue
			}
		}
		targets = append(targets, e)
	}
	if len(targets) == 0 {
		fmt.Println("no sessions match")
		return 0
	}

	for _, e := range targets {
		pids := processTree(e.PID, psChildren)
		if !confirm {
			fmt.Printf("would reap pid %d (%s, %s, %d processes)\n",
				e.PID, e.Profile, fmtAge(e.Age(now)), len(pids))
			continue
		}
		reapTree(pids, grace, osSignaller())
		fmt.Printf("reaped pid %d (%s, %s, %d processes)\n",
			e.PID, e.Profile, fmtAge(e.Age(now)), len(pids))
	}
	if !confirm {
		fmt.Printf("\n%d session(s) matched; nothing was killed. Re-run with --yes to reap.\n", len(targets))
	}
	return 0
}

// withSession records a launch for the lifetime of its child. Bookkeeping never
// blocks a launch: the session is the product, the record is not, so a registry
// failure is silently tolerated rather than surfaced as a launch error.
func withSession(profile, envName string, fallbacks []string, run func() int) int {
	rec := sessionRecord{
		PID:     os.Getpid(),
		Profile: profile,
		Started: time.Now().Unix(),
	}
	if path, err := resolveLaunchPath(envName, fallbacks); err == nil {
		rec.Binary = path
	}
	if cwd, err := os.Getwd(); err == nil {
		rec.Cwd = cwd
	}
	handle, err := openSession(sessionDir(), rec)
	if err == nil {
		defer handle.Close()
	}
	return run()
}

const sessionHelp = `code session — inspect and retire running code sessions

  code session list
  code ls
      List live sessions: age, profile, whether the launcher has since been
      superseded, and the directory each was started in. Only sessions started
      by a code that records them appear; older ones are invisible here.

  code session reap [--older-than DUR] [--superseded] [--all] [--yes]
                    [--grace DUR]
      Retire sessions. Prints what it would do and kills nothing unless --yes
      is given. At least one filter is required.

        --older-than DUR  sessions started more than DUR ago (accepts 3d)
        --superseded      sessions whose launcher is no longer the current one
        --all             every session (ignores the other filters)
        --grace DUR       SIGTERM-to-SIGKILL window (default 10s)

      Each match is reaped as a whole process tree, so the language servers,
      browsers, and workers a session spawned go with it instead of being
      orphaned onto init.

  Registry location: $XDG_STATE_HOME/code/sessions, or CODE_SESSION_STATE.
  Set CODE_SESSION_STATE=off to disable recording.
`
