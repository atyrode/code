package main

// Saved-session discovery.
//
// omp persists trusted sessions under its effective profile's data root, or
// wherever --session-dir points. Transcripts begin with a session header and
// optionally a title slot. Code reads at most these two bounded leading records:
// prompts, tool output and credentials below them are never used for discovery.
//
// The resolver here is the one place that knows which roots are trusted and how
// an id or prefix maps to exactly one (root, full id) pair. Both the listing
// verbs and `code wt resume` go through it, so a session that is discoverable
// is resumable by the same name, and an ambiguous prefix is refused the same
// way everywhere.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

// savedSession is the allowlisted metadata of one persisted omp session. Nothing
// here comes from below the transcript's header records.
type savedSession struct {
	Root     string    // the sessions directory the transcript lives in
	Path     string    // the transcript itself
	ID       string    // full session id, what omp --resume takes
	Title    string    // omp's current auto-title, or the initial one
	Cwd      string    // the directory the session was started in, as recorded
	Started  time.Time // the session record's timestamp
	Activity time.Time // transcript mtime: the last time omp wrote to it
	// Worktree is the repository worktree containing Cwd once discovery has
	// attributed the session to one; empty until then and for sessions outside
	// every known worktree.
	Worktree string
}

// sessionHeaderRecord is the union of the two header records' allowlisted
// fields. Any other field on those lines is decoded into nothing.
type sessionHeaderRecord struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Cwd       string `json:"cwd"`
	Title     string `json:"title"`
}

// sessionHeaderLimit bounds how much of a transcript is ever read. Both header
// records fit in a few hundred bytes; the limit exists so a transcript whose
// first non-header record is a large message cannot pull that message into
// memory through the line reader.
const sessionHeaderLimit = 64 << 10

// readSessionHeader parses a transcript's leading title and session records and
// stops at the first line of any other type. A transcript without a session
// record — an empty or foreign file — is not a session.
func readSessionHeader(path string) (savedSession, bool) {
	f, err := os.Open(path)
	if err != nil {
		return savedSession{}, false
	}
	defer f.Close()
	r := bufio.NewReader(io.LimitReader(f, sessionHeaderLimit))
	var s savedSession
	titled := false
	for i := 0; i < 2; i++ {
		line, err := r.ReadBytes('\n')
		if len(line) == 0 && err != nil {
			break
		}
		var rec sessionHeaderRecord
		if json.Unmarshal(line, &rec) != nil {
			break
		}
		switch rec.Type {
		case "title":
			if rec.Title != "" {
				s.Title, titled = rec.Title, true
			}
		case "session":
			if rec.ID == "" {
				return savedSession{}, false
			}
			s.ID, s.Cwd = rec.ID, rec.Cwd
			if !titled {
				s.Title = rec.Title
			}
			if ts, err := time.Parse(time.RFC3339Nano, rec.Timestamp); err == nil {
				s.Started = ts
			}
		default:
			// Do not inspect subsequent records for titles or other metadata.
			line = nil
		}
		if line == nil || err != nil {
			break
		}
	}
	if s.ID == "" {
		return savedSession{}, false
	}
	s.Path = path
	s.Root = filepath.Dir(filepath.Dir(path))
	if info, err := os.Stat(path); err == nil {
		s.Activity = info.ModTime()
	}
	return s, true
}

// ompConfigDirs is the historical root inventory, also used solely to recognize
// old Code worktree records. An XDG root has flattened sessions/, unlike the
// legacy config root's agent/sessions. Presence here does not select an active root.
func ompConfigDirs() []string {
	configDir := os.Getenv("PI_CONFIG_DIR")
	if configDir == "" {
		configDir = ".omp"
	}
	var dirs []string
	if xdgData := os.Getenv("XDG_DATA_HOME"); xdgData != "" {
		dirs = append(dirs, filepath.Join(xdgData, "omp"))
	}
	if filepath.IsAbs(configDir) {
		dirs = append(dirs, configDir)
	}
	if root := ompConfigRoot(); root != "" {
		dirs = append(dirs, root)
	}
	return dirs
}

func ompConfigRoot() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	config := os.Getenv("PI_CONFIG_DIR")
	if config == "" {
		config = ".omp"
	}
	// Node path.join keeps an absolute-looking PI_CONFIG_DIR beneath home.
	return filepath.Join(home, config)
}

// ompSessionRoot follows getSessionsDir in OMP v18.1.14 utils/dirs.ts.
// `omp config path` returns the config agent directory, NOT this data path.
// The native completion/list APIs read message bodies (and can recover backups),
// so they cannot implement Code's metadata-only, non-mutating history contract.
func ompSessionRoot(profile string) string {
	config := ompConfigRoot()
	if config == "" {
		return ""
	}
	base := config
	if profile != "" {
		base = filepath.Join(base, "profiles", profile)
	}
	agent := filepath.Join(base, "agent")
	if profile == "" {
		override := os.Getenv("PI_CODING_AGENT_DIR")
		// setProfile propagates a derived agent dir to children. An explicit
		// default profile must not mistake that inherited path for an override.
		inherited := ompProfile()
		if inherited == "" {
			inherited = validOmpProfile(os.Getenv("PI_PROFILE"))
		}
		if inherited != "" && override == filepath.Join(config, "profiles", inherited, "agent") {
			override = ""
		}
		if override != "" {
			resolved, err := filepath.Abs(override)
			if err == nil && resolved != agent {
				return filepath.Join(resolved, "sessions")
			}
		}
	}
	if runtime.GOOS == "linux" || runtime.GOOS == "darwin" {
		if data := os.Getenv("XDG_DATA_HOME"); data != "" {
			root := filepath.Join(data, "omp")
			if profile != "" {
				root = filepath.Join(root, "profiles", profile)
			}
			if _, err := os.Stat(root); err == nil {
				return filepath.Join(root, "sessions")
			}
		}
	}
	return filepath.Join(agent, "sessions")
}

var ompProfileNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
var ompReservedProfile = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$`)

func validOmpProfile(profile string) string {
	profile = strings.TrimSpace(profile)
	if profile == "default" || strings.HasSuffix(profile, ".") ||
		!ompProfileNamePattern.MatchString(profile) || ompReservedProfile.MatchString(profile) {
		return ""
	}
	return profile
}

func ompProfile() string {
	profile, ok := os.LookupEnv("OMP_PROFILE")
	if !ok {
		profile = os.Getenv("PI_PROFILE")
	}
	return validOmpProfile(profile)
}

// defaultSessionRoot is the native launch's default session-dir. Trusted argv
// strips forwarded --profile but inherits the environment's selected profile.
func defaultSessionRoot() string {
	return ompSessionRoot(ompProfile())
}

// trustedSessionRoots enumerates every sessions directory code will discover
// and resume from: the default root, then each named profile under every omp
// config directory. An explicit --session-dir is the operator naming the root
// and replaces the scan, as it does in omp. Only directories that exist are
// returned. The untrusted launcher's state is deliberately not among them — an
// untrusted session is isolated by design and never resumed from here.
func trustedSessionRoots(explicit string) []string {
	var roots []string
	add := func(dir string) {
		if dir == "" {
			return
		}
		dir = filepath.Clean(dir)
		for _, existing := range roots {
			if existing == dir {
				return
			}
		}
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			return
		}
		roots = append(roots, dir)
	}
	if explicit != "" {
		add(expandHome(explicit))
		return roots
	}
	add(defaultSessionRoot())
	add(ompSessionRoot(""))
	for _, config := range ompConfigDirs() {
		// Keep both layouts discoverable after an explicit XDG migration.
		// Resume passes a historical root explicitly; no transcript is moved.
		if config == filepath.Join(os.Getenv("XDG_DATA_HOME"), "omp") && os.Getenv("XDG_DATA_HOME") != "" {
			add(filepath.Join(config, "sessions"))
		}
		add(filepath.Join(config, "agent", "sessions"))
		profiles, err := os.ReadDir(filepath.Join(config, "profiles"))
		if err != nil {
			continue
		}
		for _, profile := range profiles {
			if profile.IsDir() && validOmpProfile(profile.Name()) != "" {
				add(ompSessionRoot(profile.Name()))
				if config == filepath.Join(os.Getenv("XDG_DATA_HOME"), "omp") && os.Getenv("XDG_DATA_HOME") != "" {
					add(filepath.Join(config, "profiles", profile.Name(), "sessions"))
				}
				add(filepath.Join(config, "profiles", profile.Name(), "agent", "sessions"))
			}
		}
	}
	return roots
}

// scanSavedSessions reads the header of every transcript under the given roots.
// A root holds one bucket directory per recorded cwd; the bucket name is omp's
// own encoding of that path and is not trusted here — the session record's cwd
// is what discovery matches on.
func scanSavedSessions(roots []string) []savedSession {
	var sessions []savedSession
	for _, root := range roots {
		buckets, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, bucket := range buckets {
			if !bucket.IsDir() {
				continue
			}
			files, err := os.ReadDir(filepath.Join(root, bucket.Name()))
			if err != nil {
				continue
			}
			for _, file := range files {
				if file.IsDir() || !strings.HasSuffix(file.Name(), ".jsonl") {
					continue
				}
				if s, ok := readSessionHeader(filepath.Join(root, bucket.Name(), file.Name())); ok {
					s.Root = root
					sessions = append(sessions, s)
				}
			}
		}
	}
	return sessions
}

// canonicalPath resolves symlinks where the path exists and cleans it where it
// does not, so a deleted cwd still compares by name and a symlinked one
// compares by target.
func canonicalPath(path string) string {
	if path == "" {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return filepath.Clean(resolved)
	}
	return filepath.Clean(path)
}

// repoWorktrees returns the main checkout of the repository containing dir and
// every directory that repository is checked out in: git's own worktree list,
// plus code's records for that repository, which cover a managed worktree git
// has forgotten (pruned) but whose directory is still on disk.
func repoWorktrees(dir string) (main string, dirs []string, err error) {
	out, err := gitOut(dir, "worktree", "list", "--porcelain")
	if err != nil {
		return "", nil, err
	}
	add := func(path string) {
		path = canonicalPath(path)
		for _, existing := range dirs {
			if existing == path {
				return
			}
		}
		dirs = append(dirs, path)
	}
	for _, line := range strings.Split(out, "\n") {
		if path, ok := strings.CutPrefix(line, "worktree "); ok {
			if main == "" {
				main = canonicalPath(path)
			}
			add(path)
		}
	}
	if main == "" {
		return "", nil, errors.New("git worktree list named no worktree")
	}
	for _, rec := range loadWorktreeRecords() {
		if canonicalPath(rec.Repo) == main {
			add(rec.Dir)
		}
	}
	return main, dirs, nil
}

// sessionRank orders discovery results: the operator's own directory first,
// then the rest of the repository, then directories above or below the current
// one, then everything else by recency.
type sessionRank int

const (
	rankExact sessionRank = iota
	rankRepo
	rankRelated
	rankElsewhere
)

// containingWorktree returns the longest worktree directory that holds cwd, or
// "" when none does. Longest wins so a worktree nested under another directory
// in the list is attributed to itself rather than its container.
func containingWorktree(cwd string, worktrees []string) string {
	best := ""
	for _, wt := range worktrees {
		if underRoot(cwd, wt) && len(wt) > len(best) {
			best = wt
		}
	}
	return best
}

// rankSavedSessions attributes each session to a worktree and sorts the list:
// by rank, then most recent activity first, then id, so two runs over the same
// files always produce the same order.
func rankSavedSessions(sessions []savedSession, cwd string, worktrees []string) []savedSession {
	cwd = canonicalPath(cwd)
	type ranked struct {
		session savedSession
		rank    sessionRank
	}
	rows := make([]ranked, 0, len(sessions))
	for _, s := range sessions {
		recorded := canonicalPath(s.Cwd)
		s.Worktree = containingWorktree(recorded, worktrees)
		rank := rankElsewhere
		switch {
		case recorded == cwd:
			rank = rankExact
		case s.Worktree != "":
			rank = rankRepo
		case underRoot(cwd, recorded) || underRoot(recorded, cwd):
			rank = rankRelated
		}
		rows = append(rows, ranked{session: s, rank: rank})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].rank != rows[j].rank {
			return rows[i].rank < rows[j].rank
		}
		if !rows[i].session.Activity.Equal(rows[j].session.Activity) {
			return rows[i].session.Activity.After(rows[j].session.Activity)
		}
		return rows[i].session.ID < rows[j].session.ID
	})
	for i := range rows {
		sessions[i] = rows[i].session
	}
	return sessions
}

// repoSavedSessions is discovery for the repository containing cwd: every
// trusted session whose recorded cwd is one of that repository's worktrees (or
// a directory inside one), ranked. Outside a repository it returns nothing.
func repoSavedSessions(cwd string, roots []string) []savedSession {
	_, worktrees, err := repoWorktrees(cwd)
	if err != nil {
		return nil
	}
	var inRepo []savedSession
	for _, s := range scanSavedSessions(roots) {
		if containingWorktree(canonicalPath(s.Cwd), worktrees) != "" {
			inRepo = append(inRepo, s)
		}
	}
	return rankSavedSessions(inRepo, cwd, worktrees)
}

// ambiguousSessionError names every session a selector could have meant. It is
// an error rather than a first match because resuming the wrong one of two
// concurrent sessions in the same worktree is exactly the mistake the operator
// is asking code to prevent.
type ambiguousSessionError struct {
	Selector   string
	Candidates []savedSession
}

func (e *ambiguousSessionError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%q matches %d sessions; name one by id:", e.Selector, len(e.Candidates))
	for _, c := range e.Candidates {
		fmt.Fprintf(&b, "\n  %s  %s  %s", c.ID, c.Cwd, sessionTitleOrUntitled(c))
	}
	return b.String()
}

// resolveSavedSession maps a full id or prefix to exactly one session. The same
// id under two roots is ambiguous too: which root is resumed decides which
// transcript continues, and that is not a choice to make silently.
func resolveSavedSession(sessions []savedSession, selector string) (savedSession, error) {
	selector = strings.TrimSpace(selector)
	if selector == "" {
		return savedSession{}, errors.New("empty session id")
	}
	var matches []savedSession
	for _, s := range sessions {
		if strings.HasPrefix(s.ID, selector) {
			matches = append(matches, s)
		}
	}
	switch len(matches) {
	case 0:
		return savedSession{}, fmt.Errorf("no saved session matches %q", selector)
	case 1:
		return matches[0], nil
	}
	return savedSession{}, &ambiguousSessionError{Selector: selector, Candidates: matches}
}

func sessionTitleOrUntitled(s savedSession) string {
	if s.Title == "" {
		return "(untitled)"
	}
	return s.Title
}

// liveSavedSessions attributes each live registry entry to the one transcript
// it is driving, keyed by transcript path. The registry proves a code process
// is alive in a directory; a process drives one transcript at a time, and omp
// writes to that transcript as the conversation moves, so among the
// directory's transcripts modified since the process started the most recently
// written one is its — a fresh launch's new transcript, or the one /new
// switched to. A resume that has not written anything yet is known from the id
// the launch recorded. Every other transcript in the directory is a different
// session, interrupted or not.
func liveSavedSessions(saved []savedSession, live []sessionEntry) map[string]int {
	owned := make(map[string]int, len(live))
	for _, e := range live {
		cwd := canonicalPath(e.Cwd)
		started := time.Unix(e.Started, 0)
		best := -1
		for i, s := range saved {
			if canonicalPath(s.Cwd) != cwd || e.Started <= 0 || s.Activity.Before(started) {
				continue
			}
			if best < 0 || s.Activity.After(saved[best].Activity) {
				best = i
			}
		}
		if best < 0 && e.Resume != "" {
			for i, s := range saved {
				if canonicalPath(s.Cwd) == cwd && strings.HasPrefix(s.ID, e.Resume) {
					best = i
					break
				}
			}
		}
		if best >= 0 {
			owned[saved[best].Path] = e.PID
		}
	}
	return owned
}

// resumePlan is what `code wt resume` is about to exec: the directory the
// session recorded and the omp arguments that continue it there. It is a value
// so the decision can be asserted without running omp.
type resumePlan struct {
	Session savedSession
	Dir     string   // the recorded cwd, verified to exist
	Args    []string // omp arguments after the binary
}

// planWorktreeResume resolves a selector — a managed worktree's name, or a
// session id or prefix — to one saved session and the exact exec that resumes
// it. It never creates, prunes or touches a worktree: a missing directory is
// reported, not recreated, and a session that is already running is refused
// rather than started twice.
func planWorktreeResume(selector string, records []worktreeEntry, sessions []savedSession, live []sessionEntry, defaultRoot string) (resumePlan, error) {
	var chosen savedSession
	named := false
	for _, rec := range records {
		if rec.Name != selector {
			continue
		}
		named = true
		var candidates []savedSession
		for _, s := range sessions {
			if underRoot(canonicalPath(s.Cwd), canonicalPath(rec.Dir)) {
				candidates = append(candidates, s)
			}
		}
		switch len(candidates) {
		case 0:
			return resumePlan{}, fmt.Errorf("worktree %s has no saved session", selector)
		case 1:
			chosen = candidates[0]
		default:
			return resumePlan{}, &ambiguousSessionError{Selector: selector, Candidates: candidates}
		}
	}
	if !named {
		var err error
		if chosen, err = resolveSavedSession(sessions, selector); err != nil {
			return resumePlan{}, err
		}
	}
	if chosen.Cwd == "" {
		return resumePlan{}, fmt.Errorf("session %s recorded no working directory; resume it with omp --resume %s from where it ran", chosen.ID, chosen.ID)
	}
	if info, err := os.Stat(chosen.Cwd); err != nil || !info.IsDir() {
		return resumePlan{}, fmt.Errorf("session %s ran in %s, which no longer exists; nothing was resumed", chosen.ID, chosen.Cwd)
	}
	if pid, isLive := liveSavedSessions(sessions, live)[chosen.Path]; isLive {
		return resumePlan{}, fmt.Errorf("session %s is already running as pid %d", chosen.ID, pid)
	}
	plan := resumePlan{Session: chosen, Dir: chosen.Cwd}
	// A session outside the default root would not be found by a bare
	// --resume, so its root is named explicitly rather than left to omp's
	// active profile.
	if canonicalPath(chosen.Root) != canonicalPath(defaultRoot) {
		plan.Args = append(plan.Args, "--session-dir", chosen.Root)
	}
	plan.Args = append(plan.Args, "--resume", chosen.ID)
	return plan, nil
}

// forwardedResume extracts the session a forwarded omp command line resumes, so
// the registry can record which saved session a launch is running. Arguments
// after -- are prompt text.
func forwardedResume(args []string) string {
	for i, arg := range args {
		switch {
		case arg == "--":
			return ""
		case arg == "--resume" || arg == "-r":
			if i+1 < len(args) {
				return args[i+1]
			}
			return ""
		case strings.HasPrefix(arg, "--resume="):
			return strings.TrimPrefix(arg, "--resume=")
		}
	}
	return ""
}

// forwardedSessionDir mirrors forwardedResume for --session-dir, so discovery
// honours an explicit root the operator forwards to omp.
func forwardedSessionDir(args []string) string {
	for i, arg := range args {
		switch {
		case arg == "--":
			return ""
		case arg == "--session-dir":
			if i+1 < len(args) {
				return args[i+1]
			}
			return ""
		case strings.HasPrefix(arg, "--session-dir="):
			return strings.TrimPrefix(arg, "--session-dir=")
		}
	}
	return ""
}
