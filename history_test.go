package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// isolateHistoryTest points every state root — code's and omp's — into a
// temporary HOME so discovery sees only what the test writes.
func isolateHistoryTest(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", filepath.Join(home, "state"))
	t.Setenv("XDG_DATA_HOME", "")
	t.Setenv("PI_CODING_AGENT_DIR", "")
	t.Setenv("PI_CONFIG_DIR", "")
	t.Setenv("OMP_PROFILE", "")
	t.Setenv("PI_PROFILE", "")
	t.Setenv("CODE_WORKTREE_DIR", "")
	t.Setenv("CODE_WORKTREE_STATE", "")
	t.Setenv("CODE_SESSION_STATE", filepath.Join(home, "session-state"))
	return home
}

// writeSavedSession fabricates a transcript the way omp lays one out: a title
// record, the session record, then conversation. The conversation line is
// deliberately not JSON so a reader that strays past the headers fails loudly.
func writeSavedSession(t *testing.T, root, id, cwd, title string, started time.Time) string {
	t.Helper()
	bucket := filepath.Join(root, "-"+strings.ReplaceAll(strings.TrimPrefix(cwd, "/"), "/", "-"))
	if err := os.MkdirAll(bucket, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(bucket, started.UTC().Format("2006-01-02T15-04-05-000Z")+"_"+id+".jsonl")
	body := `{"type":"title","v":1,"title":"` + title + `","source":"auto"}` + "\n" +
		`{"type":"session","version":3,"id":"` + id + `","timestamp":"` + started.UTC().Format(time.RFC3339Nano) + `","cwd":"` + cwd + `","title":"initial title"}` + "\n" +
		"this is not a header record and must never be parsed\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestWorktreeResumeRecoversInterruptedSessions is the reproduction from #108:
// two managed worktrees of one repository, each with a persisted session whose
// process is gone, one tree dirty. From the main checkout both must be
// discoverable and each must resume into its own tree, an ambiguous selector
// and a missing tree must be named errors, and the dirty tree must come out
// exactly as it went in.
func TestWorktreeResumeRecoversInterruptedSessions(t *testing.T) {
	home := isolateHistoryTest(t)
	repo := filepath.Join(home, "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := gitOut(repo, "init", "-q"); err != nil {
		t.Skip("git is not available:", err)
	}
	mustGit(t, repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init")

	first, err := createSessionWorktree(repo)
	if err != nil {
		t.Fatal(err)
	}
	second, err := createSessionWorktree(repo)
	if err != nil {
		t.Fatal(err)
	}
	// The second tree is the dirty one: an uncommitted file discovery and
	// resume must leave alone.
	if err := os.WriteFile(filepath.Join(second.Dir, "wip.txt"), []byte("half done\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dirtyBefore := mustGit(t, second.Dir, "status", "--porcelain")
	if dirtyBefore == "" {
		t.Fatal("second worktree should be dirty")
	}

	root := filepath.Join(home, ".omp", "agent", "sessions")
	base := time.Date(2026, 9, 5, 10, 0, 0, 0, time.UTC)
	const (
		firstID  = "01a00000-aaaa-7000-8000-000000000001"
		secondID = "01a00000-bbbb-7000-8000-000000000002"
		thirdID  = "01a00000-bbbb-7000-8000-000000000003"
		goneID   = "01a00000-cccc-7000-8000-000000000004"
	)
	writeSavedSession(t, root, firstID, first.Dir, "First tree", base)
	writeSavedSession(t, root, secondID, second.Dir, "Second tree", base.Add(time.Hour))
	writeSavedSession(t, root, thirdID, second.Dir, "Second tree again", base.Add(2*time.Hour))
	gone := filepath.Join(worktreeBase(), "gone-jade-owl")
	writeSavedSession(t, root, goneID, gone, "Removed tree", base)
	// A transcript in the untrusted launcher's own state, and a stray file in a
	// trusted root, are both invisible.
	writeSavedSession(t, filepath.Join(home, ".ompu", "agent", "sessions"), "01a00000-dddd-7000-8000-000000000005", first.Dir, "Untrusted", base)
	if err := os.WriteFile(filepath.Join(root, "notes.jsonl"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	roots := trustedSessionRoots("")
	if len(roots) != 1 || roots[0] != root {
		t.Fatalf("trusted roots = %v, want [%s]", roots, root)
	}
	found := repoSavedSessions(repo, roots)
	byID := map[string]savedSession{}
	for _, s := range found {
		byID[s.ID] = s
	}
	if len(found) != 3 {
		t.Fatalf("discovered %d sessions from the main checkout, want 3: %+v", len(found), found)
	}
	if got := byID[firstID]; got.Worktree != canonicalPath(first.Dir) || got.Title != "First tree" {
		t.Fatalf("first session = %+v", got)
	}
	if got := byID[secondID]; got.Worktree != canonicalPath(second.Dir) {
		t.Fatalf("second session = %+v", got)
	}
	// Discovery is by recorded cwd, so a session for a worktree that no longer
	// exists cannot be attributed to the repository; resume names it below.
	if _, ok := byID[goneID]; ok {
		t.Fatal("session of a removed worktree attributed to the repository")
	}

	records := loadWorktreeRecords()
	all := scanSavedSessions(roots)
	var live []sessionEntry

	// Each session resolves to its own tree, by id prefix and by worktree name.
	plan, err := planWorktreeResume("01a00000-aaaa", records, all, live, root)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Dir != first.Dir || strings.Join(plan.Args, " ") != "--resume "+firstID {
		t.Fatalf("first plan = dir %q args %v", plan.Dir, plan.Args)
	}
	plan, err = planWorktreeResume(first.Name, records, all, live, root)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Dir != first.Dir || plan.Session.ID != firstID {
		t.Fatalf("plan by worktree name = dir %q id %s", plan.Dir, plan.Session.ID)
	}
	plan, err = planWorktreeResume(thirdID, records, all, live, root)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Dir != second.Dir || strings.Join(plan.Args, " ") != "--resume "+thirdID {
		t.Fatalf("third plan = dir %q args %v", plan.Dir, plan.Args)
	}

	// Ambiguity is refused and the candidates are named — a shared id prefix
	// and a worktree holding two sessions alike.
	var ambiguous *ambiguousSessionError
	if _, err := planWorktreeResume("01a00000-bbbb", records, all, live, root); !errors.As(err, &ambiguous) || len(ambiguous.Candidates) != 2 {
		t.Fatalf("ambiguous prefix error = %v", err)
	}
	if msg := ambiguous.Error(); !strings.Contains(msg, secondID) || !strings.Contains(msg, thirdID) {
		t.Fatalf("ambiguity does not name both candidates: %s", msg)
	}
	if _, err := planWorktreeResume(second.Name, records, all, live, root); !errors.As(err, &ambiguous) || len(ambiguous.Candidates) != 2 {
		t.Fatalf("ambiguous worktree error = %v", err)
	}

	// A missing tree is reported by path, not recreated.
	if _, err := planWorktreeResume(goneID, records, all, live, root); err == nil || !strings.Contains(err.Error(), gone) {
		t.Fatalf("missing worktree error = %v", err)
	}
	if _, err := os.Stat(gone); !os.IsNotExist(err) {
		t.Fatalf("resume created the missing worktree: %v", err)
	}
	if _, err := planWorktreeResume("nope", records, all, live, root); err == nil {
		t.Fatal("unknown selector resolved")
	}

	// A session the registry is running is refused rather than started twice.
	live = []sessionEntry{{sessionRecord: sessionRecord{PID: 4242, Cwd: first.Dir, Resume: firstID, Started: time.Now().Add(time.Hour).Unix()}}}
	if _, err := planWorktreeResume(firstID, records, all, live, root); err == nil || !strings.Contains(err.Error(), "4242") {
		t.Fatalf("live session error = %v", err)
	}

	// The listing tells the two trees' sessions apart and marks the running one.
	var out strings.Builder
	writeWorktreeList(&out, records, all, live, time.Now())
	rendered := out.String()
	rows := map[string]string{}
	for _, line := range strings.Split(rendered, "\n") {
		if fields := strings.Fields(line); len(fields) > 3 && strings.HasPrefix(fields[1], "01a00000-") {
			rows[fields[1]] = fields[0] + " " + fields[2]
		}
	}
	for id, want := range map[string]string{
		firstID:  first.Name + " live",
		secondID: second.Name + " interrupted",
		thirdID:  second.Name + " interrupted",
	} {
		if rows[id] != want {
			t.Fatalf("listing row for %s = %q, want %q:\n%s", id, rows[id], want, rendered)
		}
	}
	if !strings.Contains(rendered, "Second tree again") {
		t.Fatalf("listing lacks the title:\n%s", rendered)
	}
	if strings.Contains(rendered, goneID) || strings.Contains(rendered, "Untrusted") {
		t.Fatalf("listing shows what it must not:\n%s", rendered)
	}

	if dirtyAfter := mustGit(t, second.Dir, "status", "--porcelain"); dirtyAfter != dirtyBefore {
		t.Fatalf("dirty worktree changed: before %q, after %q", dirtyBefore, dirtyAfter)
	}
	if len(loadWorktreeRecords()) != 2 {
		t.Fatal("discovery changed the worktree records")
	}
}

// TestReadSessionHeaderStopsAtConversation pins the allowlist: the title record
// wins over the session record's initial title, and reading stops at the first
// conversation line, which here is not even JSON.
func TestReadSessionHeaderStopsAtConversation(t *testing.T) {
	root := t.TempDir()
	started := time.Date(2026, 9, 5, 12, 30, 0, 0, time.UTC)
	path := writeSavedSession(t, root, "01a00000-aaaa-7000-8000-000000000001", "/work/tree", "Renamed later", started)
	s, ok := readSessionHeader(path)
	if !ok {
		t.Fatal("header not read")
	}
	if s.Title != "Renamed later" || s.Cwd != "/work/tree" || !s.Started.Equal(started) {
		t.Fatalf("header = %+v", s)
	}

	// The session record alone is a session; a title alone is not.
	untitled := filepath.Join(root, "untitled.jsonl")
	if err := os.WriteFile(untitled, []byte(`{"type":"session","version":3,"id":"01a00000-aaaa-7000-8000-000000000002","cwd":"/x","title":"only here"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if s, ok := readSessionHeader(untitled); !ok || s.Title != "only here" {
		t.Fatalf("session-only header = %+v ok %v", s, ok)
	}
	titleOnly := filepath.Join(root, "title.jsonl")
	if err := os.WriteFile(titleOnly, []byte(`{"type":"title","title":"x"}`+"\n"+`{"type":"message"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := readSessionHeader(titleOnly); ok {
		t.Fatal("a transcript without a session record was accepted")
	}
}

func TestReadSessionHeaderReorderedAndBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "header.jsonl")
	for _, body := range []string{
		"  {\"title\":\"current\",\"type\":\"title\"}\n" +
			`{"cwd":"/work","id":"ordered","title":"initial","type":"session"}` + "\n",
		`{"id":"ordered","cwd":"/work","type":"session"}` + "\n" +
			`{"title":"current","type":"title"}` + "\n",
	} {
		// A later title must never override either leading-header layout.
		body += `{"title":"private later title","type":"title"}` + "\n" + strings.Repeat("private body", sessionHeaderLimit)
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if s, ok := readSessionHeader(path); !ok || s.ID != "ordered" || s.Title != "current" || s.Cwd != "/work" {
			t.Fatalf("reordered headers = %+v, %v", s, ok)
		}
	}
	// A session beyond the bounded prefix is not metadata discovery.
	body := `{"title":"` + strings.Repeat("x", sessionHeaderLimit) + `","type":"title"}` + "\n" +
		`{"id":"hidden","cwd":"/work","type":"session"}` + "\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := readSessionHeader(path); ok {
		t.Fatal("read a session header past the byte limit")
	}
}

// With CODE_OMP_DIRS_SOURCE=/absolute/omp/packages/utils/src/dirs.ts this same
// matrix also compares against the real upstream getSessionsDir API in Bun.
// Importing dirs alone is read-only and never initializes providers or transcripts.
func TestOmpSessionRootLayouts(t *testing.T) {
	source := os.Getenv("CODE_OMP_DIRS_SOURCE")
	for _, tc := range []struct {
		name string
		env  map[string]string
		dirs []string
		want string
	}{
		{"legacy", nil, nil, ".omp/agent/sessions"},
		{"xdg-not-migrated", map[string]string{"XDG_DATA_HOME": "$HOME/data"}, nil, ".omp/agent/sessions"},
		{"xdg-migrated", map[string]string{"XDG_DATA_HOME": "$HOME/data"}, []string{"data/omp"}, "data/omp/sessions"},
		{"profile-new-under-xdg", map[string]string{"XDG_DATA_HOME": "$HOME/data", "OMP_PROFILE": "work"}, []string{"data/omp"}, ".omp/profiles/work/agent/sessions"},
		{"profile-migrated", map[string]string{"XDG_DATA_HOME": "$HOME/data", "OMP_PROFILE": "work"}, []string{"data/omp/profiles/work"}, "data/omp/profiles/work/sessions"},
		{"profile-legacy", map[string]string{"OMP_PROFILE": "work"}, []string{".omp/profiles/work/agent"}, ".omp/profiles/work/agent/sessions"},
		{"profile-overrides-agent", map[string]string{"OMP_PROFILE": "work", "PI_CODING_AGENT_DIR": "$HOME/custom"}, nil, ".omp/profiles/work/agent/sessions"},
		{"agent-overrides-xdg", map[string]string{"XDG_DATA_HOME": "$HOME/data", "PI_CODING_AGENT_DIR": "$HOME/custom"}, []string{"data/omp"}, "custom/sessions"},
		{"default-agent-still-xdg", map[string]string{"XDG_DATA_HOME": "$HOME/data", "PI_CODING_AGENT_DIR": "$HOME/.omp/agent"}, []string{"data/omp"}, "data/omp/sessions"},
		{"empty-canonical-profile", map[string]string{"OMP_PROFILE": "", "PI_PROFILE": "work"}, nil, ".omp/agent/sessions"},
		{"legacy-profile-env", map[string]string{"PI_PROFILE": "work"}, nil, ".omp/profiles/work/agent/sessions"},
		{"canonical-profile-wins", map[string]string{"OMP_PROFILE": "other", "PI_PROFILE": "work"}, nil, ".omp/profiles/other/agent/sessions"},
		{"inherited-agent-default", map[string]string{"OMP_PROFILE": "", "PI_PROFILE": "work", "PI_CODING_AGENT_DIR": "$HOME/.omp/profiles/work/agent"}, nil, ".omp/agent/sessions"},
		{"custom-config", map[string]string{"PI_CONFIG_DIR": ".custom"}, nil, ".custom/agent/sessions"},
		{"absolute-config-is-joined", map[string]string{"PI_CONFIG_DIR": "/custom"}, nil, "custom/agent/sessions"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, xdg := tc.env["XDG_DATA_HOME"]; xdg && runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
				t.Skip("native XDG resolution is Linux/macOS only")
			}
			home := isolateHistoryTest(t)
			// OMP_PROFILE absence differs from an explicitly empty value.
			if err := os.Unsetenv("OMP_PROFILE"); err != nil {
				t.Fatal(err)
			}
			for key, value := range tc.env {
				t.Setenv(key, strings.ReplaceAll(value, "$HOME", home))
			}
			for _, dir := range tc.dirs {
				if err := os.MkdirAll(filepath.Join(home, dir), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			want := filepath.Join(home, tc.want)
			if got := defaultSessionRoot(); got != want {
				t.Fatalf("session root = %s, want %s", got, want)
			}
			if source != "" {
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				cmd := exec.CommandContext(ctx, "bun", "--eval",
					`const dirs = await import(process.env.CODE_OMP_DIRS_SOURCE); console.log(dirs.getSessionsDir());`)
				cmd.Dir = home
				out, err := cmd.CombinedOutput()
				if err != nil {
					t.Fatalf("native getSessionsDir: %v: %s", err, out)
				}
				if native := strings.TrimSpace(string(out)); native != want {
					t.Fatalf("native root = %s, Code root = %s", native, want)
				}
			}
		})
	}
}

func TestMigratedSessionDiscoveryAndResume(t *testing.T) {
	home := isolateHistoryTest(t)
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, "data"))
	cwd := filepath.Join(home, "project")
	if err := os.MkdirAll(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	roots := []string{
		filepath.Join(home, "data", "omp", "sessions"),
		filepath.Join(home, "data", "omp", "profiles", "work", "sessions"),
		filepath.Join(home, ".omp", "agent", "sessions"),
		filepath.Join(home, ".omp", "profiles", "work", "agent", "sessions"),
	}
	for i, root := range roots {
		writeSavedSession(t, root, "saved-"+string(rune('a'+i)), cwd, "Public title", time.Now())
	}
	writeSavedSession(t, filepath.Join(home, ".ompu", "agent", "sessions"), "untrusted", cwd, "Do not list", time.Now())
	sessions := scanSavedSessions(trustedSessionRoots(""))
	if len(sessions) != len(roots) {
		t.Fatalf("migrated and historical sessions = %+v", sessions)
	}
	for i, root := range roots {
		id := "saved-" + string(rune('a'+i))
		plan, err := planWorktreeResume(id, nil, sessions, nil, defaultSessionRoot())
		if err != nil {
			t.Fatal(err)
		}
		want := "--resume " + id
		if root != roots[0] {
			want = "--session-dir " + root + " " + want
		}
		if plan.Dir != cwd || strings.Join(plan.Args, " ") != want {
			t.Fatalf("resume %s = %+v, want %s", id, plan, want)
		}
	}
	if selected := scanSavedSessions(trustedSessionRoots(roots[1])); len(selected) != 1 || selected[0].ID != "saved-b" {
		t.Fatalf("explicit root must replace discovery: %+v", selected)
	}
	if err := os.Remove(cwd); err != nil {
		t.Fatal(err)
	}
	if _, err := planWorktreeResume("saved-b", nil, sessions, nil, defaultSessionRoot()); err == nil {
		t.Fatal("resumed into a missing recorded cwd")
	}
	if _, err := os.Stat(cwd); !os.IsNotExist(err) {
		t.Fatalf("resume changed missing cwd: %v", err)
	}
}

// TestTrustedSessionRootsCoverProfilesAndExplicitDir pins which roots are
// searched: the default agent directory and every named profile, or only the
// explicit --session-dir when one is given.
func TestTrustedSessionRootsCoverProfilesAndExplicitDir(t *testing.T) {
	home := isolateHistoryTest(t)
	defaultRoot := filepath.Join(home, ".omp", "agent", "sessions")
	workRoot := filepath.Join(home, ".omp", "profiles", "work", "agent", "sessions")
	for _, dir := range []string{defaultRoot, workRoot, filepath.Join(home, ".omp", "profiles", "empty")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if got := trustedSessionRoots(""); strings.Join(got, ",") != defaultRoot+","+workRoot {
		t.Fatalf("roots = %v", got)
	}

	explicit := filepath.Join(home, "elsewhere")
	if err := os.MkdirAll(explicit, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := trustedSessionRoots(explicit); len(got) != 1 || got[0] != explicit {
		t.Fatalf("explicit roots = %v", got)
	}

	agentDir := filepath.Join(home, "agent-override")
	if err := os.MkdirAll(filepath.Join(agentDir, "sessions"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PI_CODING_AGENT_DIR", agentDir)
	if got := trustedSessionRoots(""); len(got) == 0 || got[0] != filepath.Join(agentDir, "sessions") {
		t.Fatalf("PI_CODING_AGENT_DIR roots = %v", got)
	}
}

// TestResolveSavedSessionAcrossRoots: the same id persisted under two roots is
// ambiguous, because which transcript continues depends on which root is
// resumed, and a prefix only ever selects one session.
func TestResolveSavedSessionAcrossRoots(t *testing.T) {
	const id = "01a00000-aaaa-7000-8000-000000000001"
	sessions := []savedSession{
		{Root: "/a", ID: id},
		{Root: "/b", ID: id},
		{Root: "/a", ID: "01a00000-bbbb-7000-8000-000000000002"},
	}
	var ambiguous *ambiguousSessionError
	if _, err := resolveSavedSession(sessions, id); !errors.As(err, &ambiguous) {
		t.Fatalf("duplicate id across roots = %v", err)
	}
	got, err := resolveSavedSession(sessions, "01a00000-bbbb")
	if err != nil || got.Root != "/a" {
		t.Fatalf("prefix resolve = %+v, %v", got, err)
	}
	if _, err := resolveSavedSession(sessions, "01a00000"); !errors.As(err, &ambiguous) || len(ambiguous.Candidates) != 3 {
		t.Fatalf("shared prefix = %v", err)
	}
}

// TestRankSavedSessionsPrefersCurrentDirectory pins the deterministic order:
// the current directory, then the rest of the repository, then parent or child
// directories, then everything else — recency breaking ties within a rank.
func TestRankSavedSessionsPrefersCurrentDirectory(t *testing.T) {
	home := t.TempDir()
	main := filepath.Join(home, "repo")
	linked := filepath.Join(home, "wt", "tree")
	for _, dir := range []string{main, linked, filepath.Join(main, "sub")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	sessions := []savedSession{
		{ID: "elsewhere", Cwd: filepath.Join(home, "other"), Activity: now},
		{ID: "parent", Cwd: home, Activity: now},
		{ID: "linked-old", Cwd: linked, Activity: now.Add(-time.Hour)},
		{ID: "linked-new", Cwd: linked, Activity: now},
		{ID: "exact", Cwd: main, Activity: now.Add(-24 * time.Hour)},
		{ID: "child", Cwd: filepath.Join(main, "sub"), Activity: now},
	}
	ranked := rankSavedSessions(sessions, main, []string{main, linked})
	var order []string
	for _, s := range ranked {
		order = append(order, s.ID)
	}
	// "child" sits inside the main worktree, so it ranks as repository, and
	// the two linked-tree sessions are ordered newest first.
	want := "exact,child,linked-new,linked-old,parent,elsewhere"
	if got := strings.Join(order, ","); got != want {
		t.Fatalf("order = %s, want %s", got, want)
	}
}

// TestLiveSavedSessionAttribution pins how a running process is tied to one
// saved session: same directory, then the transcript most recently written
// since the launch — which is how a session /new switched to wins over the one
// it resumed — falling back to the recorded resume id when nothing has been
// written yet. A process in another directory proves nothing.
func TestLiveSavedSessionAttribution(t *testing.T) {
	dir := t.TempDir()
	started := time.Now().Add(-time.Hour)
	entry := sessionEntry{sessionRecord: sessionRecord{PID: 7, Cwd: dir, Started: started.Unix()}}
	resumed := savedSession{Path: "resumed", ID: "01a0-resumed", Cwd: dir, Activity: started.Add(time.Minute)}
	switched := savedSession{Path: "switched", ID: "01a0-switched", Cwd: dir, Activity: time.Now()}
	stale := savedSession{Path: "stale", ID: "01a0-stale", Cwd: dir, Activity: started.Add(-time.Hour)}
	all := []savedSession{stale, resumed, switched}

	got := liveSavedSessions(all, []sessionEntry{entry})
	if len(got) != 1 || got["switched"] != 7 {
		t.Fatalf("attribution = %v, want only the newest transcript", got)
	}

	// Resumed and idle since: nothing written after the launch, so the
	// recorded id decides.
	entry.Resume = "01a0-stale"
	if got := liveSavedSessions([]savedSession{stale}, []sessionEntry{entry}); got["stale"] != 7 {
		t.Fatalf("recorded resume target not attributed: %v", got)
	}
	// A write since the launch outranks the recorded id: the process moved on.
	if got := liveSavedSessions(all, []sessionEntry{entry}); len(got) != 1 || got["switched"] != 7 {
		t.Fatalf("attribution with resume recorded = %v", got)
	}

	entry.Cwd = filepath.Join(dir, "elsewhere")
	if got := liveSavedSessions(all, []sessionEntry{entry}); len(got) != 0 {
		t.Fatalf("a process in another directory attributed: %v", got)
	}
}

func TestForwardedResume(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"--resume", "abc"}, "abc"},
		{[]string{"--model", "x", "--resume=abc"}, "abc"},
		{[]string{"-r", "abc"}, "abc"},
		{[]string{"--", "--resume", "abc"}, ""},
		{[]string{"--resume"}, ""},
		{nil, ""},
	} {
		if got := forwardedResume(tc.args); got != tc.want {
			t.Errorf("forwardedResume(%v) = %q, want %q", tc.args, got, tc.want)
		}
	}
}
