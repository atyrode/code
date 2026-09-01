package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"
)

var worktreeAdjectives = []string{
	"lazy", "brave", "calm", "eager", "fuzzy", "gentle", "happy", "jolly",
	"keen", "lively", "mellow", "nimble", "proud", "quick", "quiet", "shiny",
	"sleepy", "snug", "sturdy", "swift", "tidy", "witty", "zesty", "bold",
}

var worktreeColors = []string{
	"red", "blue", "green", "amber", "coral", "cyan", "gold", "gray", "ivory",
	"jade", "lilac", "mauve", "olive", "pearl", "plum", "teal", "rust", "sage",
}

var worktreeAnimals = []string{
	"cat", "fox", "owl", "bear", "crab", "crow", "deer", "dove", "duck", "hare",
	"heron", "koala", "lemur", "lynx", "mole", "moth", "newt", "otter", "panda",
	"quail", "seal", "swan", "toad", "wren",
}

type sessionWorktree struct {
	Name     string
	Branch   string
	Repo     string
	Dir      string
	BaseSHA  string
	ChildDir string
}

type worktreeRecord struct {
	Name    string `json:"name"`
	Branch  string `json:"branch"`
	Repo    string `json:"repo"`
	Dir     string `json:"dir"`
	BaseSHA string `json:"base_sha"`
	PID     int    `json:"pid"`
	Created int64  `json:"created"`
}

func gitOut(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			if stderr := strings.TrimSpace(string(exitErr.Stderr)); stderr != "" {
				return "", fmt.Errorf("%w: %s", err, stderr)
			}
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// codeWorktreeDirEnv relocates the session worktree root. It is deliberately a
// CODE_* variable and not omp's OMP_WORKTREE_DIR: the point of owning this path
// is that nothing omp does to its own worktree directory can reach ours, and
// honouring omp's variable would hand that directory back the moment an operator
// set it.
const codeWorktreeDirEnv = "CODE_WORKTREE_DIR"

// defaultWorktreeBase derives the worktree root exactly the way every other
// piece of code state is derived (defaultSessionDir, defaultSelectionStatePath):
// XDG_STATE_HOME, else $HOME/.local/state, then under code/. HOME is all a
// stripped environment carries, so a path rooted there is the one seam every
// mode can derive.
func defaultWorktreeBase() string {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "state")
	}
	return filepath.Join(base, "code", "wt")
}

// worktreeBase resolves where session worktrees are created.
//
// These used to live in omp's own worktree directory (~/.omp/wt, or whatever
// OMP_PROFILE/PI_CONFIG_DIR/XDG_DATA_HOME resolved it to), which is a directory
// omp actively manages: `omp worktree list` enumerates it and `omp worktree
// clear --all` force-deletes every entry in it, live PR checkouts included. omp
// has no knowledge of code's session registry ($XDG_STATE_HOME/code/sessions),
// so it cannot tell a code session's worktree from one of its own abandoned
// task worktrees — a single `omp worktree clear --all` would delete the tree out
// from under a running session and take its uncommitted work with it.
//
// The two features are not redundant and neither can be dropped: omp's are
// in-session, per-subagent task isolation; code's are pre-launch, whole-session
// operator branches. So code keeps its worktrees under its own state root and
// stays out of omp's namespace entirely. Worktrees created before this move are
// still recorded and still listed — see legacyWorktreeRoots.
func worktreeBase() string {
	if raw := strings.TrimSpace(os.Getenv(codeWorktreeDirEnv)); raw != "" {
		if path := expandHome(raw); filepath.IsAbs(path) {
			return filepath.Clean(path)
		}
	}
	return defaultWorktreeBase()
}

// expandHome resolves a leading ~ against HOME. An override is written by a
// human in a shell profile, where ~ is what a human writes.
func expandHome(raw string) string {
	switch {
	case raw == "~":
		return os.Getenv("HOME")
	case strings.HasPrefix(raw, "~/"):
		return filepath.Join(os.Getenv("HOME"), strings.TrimPrefix(raw, "~/"))
	}
	return raw
}

// legacyWorktreeRoots reconstructs the omp-managed directories a pre-move code
// created worktrees in, so `code wt` can still name them. This is the exact
// resolution worktreeBase used to perform, kept only to recognise old paths:
// nothing is ever created here again.
//
// It is used for marking, never for discovery. Discovery stays record-driven
// (loadWorktreeRecords reads code's own state directory, which the move did not
// touch, so every worktree code ever made is still listed with its real Dir).
// Scanning these roots for directories instead would enumerate omp's own task
// worktrees and offer to delete them, which is the same trespass in reverse.
func legacyWorktreeRoots() []string {
	var roots []string
	add := func(path string) {
		if path == "" {
			return
		}
		path = filepath.Clean(path)
		for _, existing := range roots {
			if existing == path {
				return
			}
		}
		roots = append(roots, path)
	}

	if raw := strings.TrimSpace(os.Getenv("OMP_WORKTREE_DIR")); raw != "" {
		if path := expandHome(raw); filepath.IsAbs(path) {
			add(path)
		}
	}

	profile, ok := os.LookupEnv("OMP_PROFILE")
	if !ok {
		profile = os.Getenv("PI_PROFILE")
	}
	profile = strings.TrimSpace(profile)
	defaultProfile := profile == "" || profile == "default"

	configDir := os.Getenv("PI_CONFIG_DIR")
	if configDir == "" {
		configDir = ".omp"
	}

	if xdgData := os.Getenv("XDG_DATA_HOME"); xdgData != "" {
		root := filepath.Join(xdgData, "omp")
		if !defaultProfile {
			root = filepath.Join(root, "profiles", profile)
		}
		add(filepath.Join(root, "wt"))
	}

	if home := os.Getenv("HOME"); home != "" {
		root := filepath.Join(home, configDir)
		if !defaultProfile {
			root = filepath.Join(root, "profiles", profile)
		}
		add(filepath.Join(root, "wt"))
	}
	return roots
}

// underRoot reports whether dir is root itself or lives beneath it. Both sides
// are cleaned, so a trailing slash or a doubled separator in an override does
// not decide whether a worktree is recognised as legacy.
func underRoot(dir, root string) bool {
	if dir == "" || root == "" {
		return false
	}
	dir, root = filepath.Clean(dir), filepath.Clean(root)
	if dir == root {
		return true
	}
	return strings.HasPrefix(dir, root+string(filepath.Separator))
}

func randomWorktreeName() string {
	return strings.Join([]string{
		worktreeAdjectives[rand.IntN(len(worktreeAdjectives))],
		worktreeColors[rand.IntN(len(worktreeColors))],
		worktreeAnimals[rand.IntN(len(worktreeAnimals))],
	}, "-")
}

func worktreeStateDir() string {
	if dir := os.Getenv("CODE_WORKTREE_STATE"); dir != "" {
		return dir
	}
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "state")
	}
	return filepath.Join(base, "code", "worktrees")
}

func worktreeRecordPath(name string) string {
	dir := worktreeStateDir()
	if dir == "" || dir == sessionDisabled {
		return ""
	}
	return filepath.Join(dir, name+".json")
}

func writeWorktreeRecord(w *sessionWorktree) error {
	path := worktreeRecordPath(w.Name)
	if path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	rec := worktreeRecord{
		Name:    w.Name,
		Branch:  w.Branch,
		Repo:    w.Repo,
		Dir:     w.Dir,
		BaseSHA: w.BaseSHA,
		PID:     os.Getpid(),
		Created: time.Now().Unix(),
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func removeWorktreeRecord(name string) error {
	path := worktreeRecordPath(name)
	if path == "" {
		return nil
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func createSessionWorktree(root string) (*sessionWorktree, error) {
	base := worktreeBase()
	if err := os.MkdirAll(base, 0o755); err != nil {
		return nil, fmt.Errorf("create worktree base: %w", err)
	}
	baseSHA, err := gitOut(root, "rev-parse", "HEAD")
	if err != nil {
		return nil, fmt.Errorf("resolve HEAD: %w", err)
	}

	var name string
	chosen := false
	for range 8 {
		name = randomWorktreeName()
		dir := filepath.Join(base, name)
		_, statErr := os.Stat(dir)
		dirExists := statErr == nil || !os.IsNotExist(statErr)
		_, branchErr := gitOut(root, "show-ref", "--verify", "--quiet", "refs/heads/code/"+name)
		if !dirExists && branchErr != nil {
			chosen = true
			break
		}
	}
	if !chosen {
		name += fmt.Sprintf("-%02x", rand.IntN(256))
	}

	w := &sessionWorktree{
		Name:    name,
		Branch:  "code/" + name,
		Repo:    root,
		Dir:     filepath.Join(base, name),
		BaseSHA: baseSHA,
	}
	if _, err := gitOut(root, "worktree", "add", "-b", w.Branch, w.Dir, "HEAD"); err != nil {
		return nil, fmt.Errorf("create %s: %w", w.Dir, err)
	}
	_, _ = gitOut(root, "worktree", "lock", "--reason", fmt.Sprintf("code session %d", os.Getpid()), w.Dir)
	_ = writeWorktreeRecord(w)
	return w, nil
}

func worktreePristine(w *sessionWorktree) bool {
	if w == nil {
		return false
	}
	status, err := gitOut(w.Dir, "status", "--porcelain")
	if err != nil || status != "" {
		return false
	}
	tip, err := gitOut(w.Repo, "rev-parse", "refs/heads/"+w.Branch)
	return err == nil && tip == w.BaseSHA
}

func releaseSessionWorktree(w *sessionWorktree) {
	if w == nil {
		return
	}
	_, _ = gitOut(w.Repo, "worktree", "unlock", w.Dir)
	if worktreePristine(w) {
		if _, err := gitOut(w.Repo, "worktree", "remove", w.Dir); err == nil {
			if _, err := gitOut(w.Repo, "branch", "-D", w.Branch); err == nil {
				if err := removeWorktreeRecord(w.Name); err == nil {
					return
				}
			}
		}
	}
	fmt.Fprintf(os.Stderr, "code: kept worktree %s (branch %s)\n", w.Dir, w.Branch)
}

func worktreeLiveness(dir string) (live bool, pid int, known bool) {
	registry := sessionDir()
	if registry == "" || registry == sessionDisabled {
		return false, 0, false
	}
	for _, session := range loadSessions(registry) {
		if session.Worktree == dir {
			return true, session.PID, true
		}
	}
	return false, 0, true
}

type worktreeEntry struct {
	worktreeRecord
	Path string
}

func loadWorktreeRecords() []worktreeEntry {
	dir := worktreeStateDir()
	if dir == "" || dir == sessionDisabled {
		return nil
	}
	paths, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil
	}
	var entries []worktreeEntry
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var rec worktreeRecord
		if err := json.Unmarshal(data, &rec); err != nil ||
			rec.Name == "" || rec.Branch == "" || rec.Repo == "" || rec.Dir == "" {
			continue
		}
		if _, err := os.Stat(rec.Dir); os.IsNotExist(err) {
			_ = os.Remove(path)
			_, _ = gitOut(rec.Repo, "worktree", "prune")
			continue
		}
		entries = append(entries, worktreeEntry{worktreeRecord: rec, Path: path})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Created != entries[j].Created {
			return entries[i].Created < entries[j].Created
		}
		return entries[i].Name < entries[j].Name
	})
	return entries
}

func (e worktreeEntry) sessionWorktree() *sessionWorktree {
	return &sessionWorktree{
		Name:    e.Name,
		Branch:  e.Branch,
		Repo:    e.Repo,
		Dir:     e.Dir,
		BaseSHA: e.BaseSHA,
	}
}

// worktreeIsLegacy reports whether a recorded worktree still sits in one of the
// omp-managed roots code used before it took ownership of its own. The record is
// code's either way — only the directory is in the wrong place — so remove and
// prune handle such an entry exactly like any other; the listing marks it so an
// operator can see which trees are still exposed to `omp worktree clear --all`
// and retire them deliberately. Nothing on disk is moved: these are the
// operator's git worktrees, and relocating one behind their back would be the
// same unannounced mutation this whole change exists to prevent.
//
// A directory under the current base is never legacy, so pointing
// CODE_WORKTREE_DIR at an omp root — an operator's choice to make — does not
// flag every fresh worktree.
func worktreeIsLegacy(dir, base string, roots []string) bool {
	if underRoot(dir, base) {
		return false
	}
	for _, root := range roots {
		if underRoot(dir, root) {
			return true
		}
	}
	return false
}

func removeWorktreeEntry(e worktreeEntry, force bool) error {
	_, _ = gitOut(e.Repo, "worktree", "unlock", e.Dir)
	args := []string{"worktree", "remove"}
	if force {
		args = append(args, "-f")
	}
	args = append(args, e.Dir)
	if _, err := gitOut(e.Repo, args...); err != nil {
		return fmt.Errorf("remove linked worktree: %w", err)
	}
	if _, err := gitOut(e.Repo, "branch", "-D", e.Branch); err != nil {
		return fmt.Errorf("delete branch %s: %w", e.Branch, err)
	}
	if err := os.Remove(e.Path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove record: %w", err)
	}
	return nil
}

func runWorktree(args []string) int {
	if len(args) == 0 {
		return runWorktreeList(nil)
	}
	switch args[0] {
	case "list":
		return runWorktreeList(args[1:])
	case "remove", "rm":
		return runWorktreeRemove(args[1:])
	case "prune":
		return runWorktreePrune(args[1:])
	case "help", "-h", "--help":
		fmt.Print(worktreeHelp)
		return 2
	default:
		fmt.Fprintf(os.Stderr, "code worktree: unknown subcommand %q\n%s", args[0], worktreeHelp)
		return 2
	}
}

func runWorktreeList(args []string) int {
	if len(args) != 0 {
		fmt.Print(worktreeHelp)
		return 2
	}
	entries := loadWorktreeRecords()
	if len(entries) == 0 {
		fmt.Println("no session worktrees")
		return 0
	}
	writeWorktreeList(os.Stdout, entries, time.Now())
	return 0
}

// writeWorktreeList renders the table. It takes its writer and its clock so the
// rendering — in particular the legacy marking, which is the only part an
// operator has to trust for cleanup — is assertable without a live terminal.
func writeWorktreeList(out io.Writer, entries []worktreeEntry, now time.Time) {
	base := worktreeBase()
	roots := legacyWorktreeRoots()
	legacy := 0
	w := tabwriter.NewWriter(out, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "NAME\tAGE\tBRANCH\tSTATE\tROOT\tDIRECTORY")
	for _, e := range entries {
		age := time.Duration(0)
		if e.Created > 0 {
			age = now.Sub(time.Unix(e.Created, 0))
		}
		live, _, known := worktreeLiveness(e.Dir)
		state := "clean"
		switch {
		case live:
			state = "live"
		case !known:
			state = "unknown"
		case !worktreePristine(e.sessionWorktree()):
			state = "dirty"
		}
		root := "own"
		if worktreeIsLegacy(e.Dir, base, roots) {
			root = "legacy"
			legacy++
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\n", e.Name, fmtAge(age), e.Branch, state, root, e.Dir)
	}
	_ = w.Flush()
	if legacy > 0 {
		fmt.Fprintf(out, "%d legacy worktree(s) predate code's own root and still sit in omp's, where omp worktree clear --all can force-delete them.\n", legacy)
		fmt.Fprintf(out, "Retire them with code wt rm <name>; new worktrees are created in %s.\n", base)
	}
}

func runWorktreeRemove(args []string) int {
	var (
		name  string
		force bool
	)
	for _, arg := range args {
		switch {
		case arg == "--force":
			force = true
		case arg == "-h" || arg == "--help":
			fmt.Print(worktreeHelp)
			return 2
		case strings.HasPrefix(arg, "-") || name != "":
			fmt.Print(worktreeHelp)
			return 2
		default:
			name = arg
		}
	}
	if name == "" {
		fmt.Print(worktreeHelp)
		return 2
	}

	var entry worktreeEntry
	found := false
	for _, candidate := range loadWorktreeRecords() {
		if candidate.Name == name {
			entry, found = candidate, true
			break
		}
	}
	if !found {
		fmt.Fprintf(os.Stderr, "code: unknown worktree: %s\n", name)
		return 1
	}

	live, pid, known := worktreeLiveness(entry.Dir)
	if live {
		fmt.Fprintf(os.Stderr, "code: worktree %s is in use by session %d; reap it first\n", name, pid)
		return 1
	}
	if !known && !force {
		fmt.Fprintln(os.Stderr, worktreeRegistryDisabled)
		return 1
	}
	_, _ = gitOut(entry.Repo, "worktree", "unlock", entry.Dir)
	if !worktreePristine(entry.sessionWorktree()) && !force {
		fmt.Fprintf(os.Stderr, "code: worktree %s has changes or commits; use --force to discard\n", name)
		return 1
	}
	if err := removeWorktreeEntry(entry, force); err != nil {
		fmt.Fprintf(os.Stderr, "code: remove worktree %s: %v\n", name, err)
		return 1
	}
	fmt.Printf("removed %s (branch %s)\n", entry.Dir, entry.Branch)
	return 0
}

func runWorktreePrune(args []string) int {
	confirm := false
	for _, arg := range args {
		switch arg {
		case "--yes":
			confirm = true
		case "-h", "--help":
			fmt.Print(worktreeHelp)
			return 2
		default:
			fmt.Print(worktreeHelp)
			return 2
		}
	}
	if registry := sessionDir(); registry == "" || registry == sessionDisabled {
		fmt.Fprintln(os.Stderr, worktreeRegistryDisabled)
		return 1
	}

	candidates := 0
	status := 0
	for _, entry := range loadWorktreeRecords() {
		live, _, _ := worktreeLiveness(entry.Dir)
		if live {
			continue
		}
		if !worktreePristine(entry.sessionWorktree()) {
			fmt.Printf("kept  %s (has changes)\n", entry.Dir)
			continue
		}
		candidates++
		if !confirm {
			fmt.Printf("would remove  %s\n", entry.Dir)
			continue
		}
		if err := removeWorktreeEntry(entry, false); err != nil {
			fmt.Fprintf(os.Stderr, "code: remove worktree %s: %v\n", entry.Name, err)
			status = 1
			continue
		}
		fmt.Printf("removed %s (branch %s)\n", entry.Dir, entry.Branch)
	}
	if !confirm {
		fmt.Printf("%d worktree(s) would be removed; re-run with --yes.\n", candidates)
	}
	return status
}

const worktreeRegistryDisabled = "code: session registry is disabled; cannot prove the worktree is idle — use --force"

const worktreeHelp = `code worktree — manage isolated session worktrees

  code worktree [list]
  code wt
      List recorded session worktrees, their age, branch, liveness or dirty
      state, root, and directory. A "legacy" root is one left in omp's
      worktree directory by a build older than this one — remove or prune
      clears it like any other.

  code worktree remove <name> [--force]
  code wt rm <name> [--force]
      Remove an idle worktree. Changes or commits are preserved unless
      --force is given; a live session is never removed.

  code worktree prune [--yes]
      Find idle, pristine worktrees. This is a dry run unless --yes is given.

  Worktree base: $XDG_STATE_HOME/code/wt, or CODE_WORKTREE_DIR.
  Records: $XDG_STATE_HOME/code/worktrees, or CODE_WORKTREE_STATE.
  Session liveness: $XDG_STATE_HOME/code/sessions, or CODE_SESSION_STATE.
`
