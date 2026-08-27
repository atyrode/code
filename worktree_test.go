package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

func isolateWorktreeTest(t *testing.T) string {
	t.Helper()
	base := t.TempDir()
	t.Setenv("OMP_WORKTREE_DIR", filepath.Join(base, "worktrees"))
	t.Setenv("CODE_WORKTREE_STATE", filepath.Join(base, "worktree-state"))
	t.Setenv("CODE_SESSION_STATE", filepath.Join(base, "session-state"))
	return base
}

func initWorktreeTestRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not available")
	}
	base := isolateWorktreeTest(t)
	repo := filepath.Join(base, "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "init", "-q")
	mustGit(t, repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init")
	return repo
}

func mustGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	out, err := gitOut(dir, args...)
	if err != nil {
		t.Fatalf("git %s: %v", strings.Join(args, " "), err)
	}
	return out
}

func requirePath(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected %s to exist: %v", path, err)
	}
}

func requireNoPath(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected %s to be absent, got %v", path, err)
	}
}

func requireBranch(t *testing.T, repo, branch string, exists bool) {
	t.Helper()
	_, err := gitOut(repo, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	if exists && err != nil {
		t.Fatalf("expected branch %s to exist: %v", branch, err)
	}
	if !exists && err == nil {
		t.Fatalf("expected branch %s to be absent", branch)
	}
}

func waitForPath(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(path); err == nil {
			return
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", path)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWorktreeNameFormat(t *testing.T) {
	pattern := regexp.MustCompile(`^[a-z]+-[a-z]+-[a-z]+$`)
	for range 100 {
		if name := randomWorktreeName(); !pattern.MatchString(name) {
			t.Fatalf("worktree name %q does not match adj-color-animal", name)
		}
	}
}

func TestProbeGitRepoCmd(t *testing.T) {
	repo := initWorktreeTestRepo(t)
	originalDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := os.Chdir(originalDir); err != nil {
			t.Errorf("restore working directory: %v", err)
		}
	}()

	subdir := filepath.Join(repo, "subdir")
	if err := os.Mkdir(subdir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(subdir); err != nil {
		t.Fatal(err)
	}
	primary := probeGitRepoCmd()().(gitRepoMsg)
	if !primary.ok || primary.linked || primary.root != repo || primary.prefix != "subdir/" {
		t.Fatalf("primary probe = %+v, want root %q prefix subdir/ and linked false", primary, repo)
	}

	linkedDir := filepath.Join(filepath.Dir(repo), "linked")
	mustGit(t, repo, "worktree", "add", "-b", "probe-linked", linkedDir, "HEAD")
	if err := os.Chdir(linkedDir); err != nil {
		t.Fatal(err)
	}
	linked := probeGitRepoCmd()().(gitRepoMsg)
	if !linked.ok || !linked.linked || linked.root != linkedDir || linked.prefix != "" {
		t.Fatalf("linked probe = %+v, want root %q and linked true", linked, linkedDir)
	}

	if err := os.Chdir(repo); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "worktree", "remove", linkedDir)
	mustGit(t, repo, "branch", "-D", "probe-linked")
	if err := os.Chdir(filepath.Dir(repo)); err != nil {
		t.Fatal(err)
	}
	if outside := probeGitRepoCmd()().(gitRepoMsg); outside.ok {
		t.Fatalf("non-repository probe unexpectedly succeeded: %+v", outside)
	}
}

func TestCreateAndReleasePristineWorktree(t *testing.T) {
	repo := initWorktreeTestRepo(t)
	wt, err := createSessionWorktree(repo)
	if err != nil {
		t.Fatal(err)
	}
	record := worktreeRecordPath(wt.Name)

	requirePath(t, wt.Dir)
	requirePath(t, record)
	requireBranch(t, repo, wt.Branch, true)
	if listed := mustGit(t, repo, "worktree", "list", "--porcelain"); !strings.Contains(listed, "worktree "+wt.Dir) {
		t.Fatalf("git worktree list omitted %s:\n%s", wt.Dir, listed)
	}

	releaseSessionWorktree(wt)

	requireNoPath(t, wt.Dir)
	requireNoPath(t, record)
	requireBranch(t, repo, wt.Branch, false)
	if listed := mustGit(t, repo, "worktree", "list", "--porcelain"); strings.Contains(listed, "worktree "+wt.Dir) {
		t.Fatalf("git worktree list retained %s:\n%s", wt.Dir, listed)
	}
}

func TestWorktreeLaunchLifecycle(t *testing.T) {
	repo := initWorktreeTestRepo(t)
	wt, err := createSessionWorktree(repo)
	if err != nil {
		t.Fatal(err)
	}
	wt.ChildDir = wt.Dir

	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_TEST_LAUNCHER", executable)
	base := filepath.Dir(repo)
	capture := filepath.Join(base, "child-location")
	release := filepath.Join(base, "release-child")
	childEnv := append(os.Environ(),
		"CODE_WORKTREE_TEST_CHILD=1",
		"CODE_WORKTREE_TEST_CAPTURE="+capture,
		"CODE_WORKTREE_TEST_RELEASE="+release,
	)
	status := make(chan int, 1)
	go func() {
		status <- withSession("managed", "CODE_TEST_LAUNCHER", nil, wt, func() int {
			err := runChild(executable,
				[]string{executable, "-test.run=^TestWorktreeLaunchChildProcess$"},
				childEnv, wt.ChildDir)
			return childStatus(err)
		})
	}()
	defer os.WriteFile(release, nil, 0o600)

	waitForPath(t, capture)
	location, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(location)), "\n")
	if len(lines) != 2 || lines[0] != wt.ChildDir || lines[1] != wt.ChildDir {
		t.Fatalf("child location = %q, want cwd and PWD %q", lines, wt.ChildDir)
	}
	if branch := mustGit(t, wt.Dir, "branch", "--show-current"); branch != wt.Branch {
		t.Fatalf("child branch = %q, want %q", branch, wt.Branch)
	}
	if live, pid, known := worktreeLiveness(wt.Dir); !known || !live || pid != os.Getpid() {
		t.Fatalf("worktree liveness = live %v pid %d known %v", live, pid, known)
	}
	if removeStatus := runWorktree([]string{"remove", wt.Name}); removeStatus != 1 {
		t.Fatalf("live removal status = %d, want 1", removeStatus)
	}

	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case childStatus := <-status:
		if childStatus != 0 {
			t.Fatalf("child status = %d, want 0", childStatus)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for child exit")
	}
	releaseSessionWorktree(wt)

	requireNoPath(t, wt.Dir)
	requireNoPath(t, worktreeRecordPath(wt.Name))
	requireBranch(t, repo, wt.Branch, false)
	if sessions := loadSessions(sessionDir()); len(sessions) != 0 {
		t.Fatalf("session record survived child exit: %+v", sessions)
	}
}

func TestReleaseKeepsDirtyWorktree(t *testing.T) {
	repo := initWorktreeTestRepo(t)
	wt, err := createSessionWorktree(repo)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wt.Dir, "untracked"), []byte("keep me\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	releaseSessionWorktree(wt)

	requirePath(t, wt.Dir)
	requirePath(t, worktreeRecordPath(wt.Name))
	requireBranch(t, repo, wt.Branch, true)
	if status := runWorktree([]string{"remove", wt.Name}); status != 1 {
		t.Fatalf("dirty removal status = %d, want 1", status)
	}
	requirePath(t, wt.Dir)
	if status := runWorktree([]string{"remove", wt.Name, "--force"}); status != 0 {
		t.Fatalf("forced dirty removal status = %d, want 0", status)
	}
	requireNoPath(t, wt.Dir)
	requireNoPath(t, worktreeRecordPath(wt.Name))
	requireBranch(t, repo, wt.Branch, false)
}

func TestReleaseKeepsCommittedWork(t *testing.T) {
	repo := initWorktreeTestRepo(t)
	wt, err := createSessionWorktree(repo)
	if err != nil {
		t.Fatal(err)
	}
	mustGit(t, wt.Dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "session work")

	releaseSessionWorktree(wt)

	requirePath(t, wt.Dir)
	requirePath(t, worktreeRecordPath(wt.Name))
	requireBranch(t, repo, wt.Branch, true)
}

func TestWorktreeRemoveRefusesLive(t *testing.T) {
	repo := initWorktreeTestRepo(t)
	wt, err := createSessionWorktree(repo)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := openSession(sessionDir(), sessionRecord{
		PID:      os.Getpid(),
		Profile:  "managed",
		Cwd:      wt.Dir,
		Worktree: wt.Dir,
		Started:  time.Now().Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if handle != nil {
			handle.Close()
		}
	}()

	if status := runWorktree([]string{"remove", wt.Name}); status != 1 {
		t.Fatalf("live worktree removal status = %d, want 1", status)
	}
	requirePath(t, wt.Dir)

	handle.Close()
	handle = nil
	if status := runWorktree([]string{"remove", wt.Name}); status != 0 {
		t.Fatalf("idle worktree removal status = %d, want 0", status)
	}
	requireNoPath(t, wt.Dir)
	requireNoPath(t, worktreeRecordPath(wt.Name))
}

func TestWorktreePruneDryRunThenYes(t *testing.T) {
	repo := initWorktreeTestRepo(t)
	wt, err := createSessionWorktree(repo)
	if err != nil {
		t.Fatal(err)
	}

	if status := runWorktree([]string{"prune"}); status != 0 {
		t.Fatalf("dry-run prune status = %d, want 0", status)
	}
	requirePath(t, wt.Dir)
	requirePath(t, worktreeRecordPath(wt.Name))

	if status := runWorktree([]string{"prune", "--yes"}); status != 0 {
		t.Fatalf("confirmed prune status = %d, want 0", status)
	}
	requireNoPath(t, wt.Dir)
	requireNoPath(t, worktreeRecordPath(wt.Name))
	requireBranch(t, repo, wt.Branch, false)
}

func TestWithSessionRecordsWorktree(t *testing.T) {
	base := isolateWorktreeTest(t)
	wt := &sessionWorktree{
		Dir:      filepath.Join(base, "worktrees", "calm-blue-owl"),
		ChildDir: filepath.Join(base, "worktrees", "calm-blue-owl", "child"),
	}
	var got sessionRecord
	status := withSession("managed", "CODE_TEST_LAUNCHER", nil, wt, func() int {
		path := filepath.Join(sessionDir(), strconv.Itoa(os.Getpid())+".json")
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatal(err)
		}
		return 0
	})
	if status != 0 {
		t.Fatalf("withSession status = %d, want 0", status)
	}
	if got.Cwd != wt.ChildDir || got.Worktree != wt.Dir {
		t.Fatalf("session location = cwd %q worktree %q, want %q and %q", got.Cwd, got.Worktree, wt.ChildDir, wt.Dir)
	}
	requireNoPath(t, filepath.Join(sessionDir(), strconv.Itoa(os.Getpid())+".json"))
}

func TestWorktreeLaunchChildProcess(t *testing.T) {
	if os.Getenv("CODE_WORKTREE_TEST_CHILD") != "1" {
		return
	}
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	capture := os.Getenv("CODE_WORKTREE_TEST_CAPTURE")
	if err := os.WriteFile(capture, []byte(cwd+"\n"+os.Getenv("PWD")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitForPath(t, os.Getenv("CODE_WORKTREE_TEST_RELEASE"))
}
