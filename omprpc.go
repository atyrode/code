package main

// Launching `omp --mode rpc` as a supervised child.
//
// The engine does not speak OMP's RPC protocol; the client on the other end of
// `code engine` does, natively, and this process forwards the bytes. What this
// file owns is everything around the child rather than anything in its
// stream: the private run directory and configuration overlay, the process
// group and its shutdown, the environment that keeps the operator's own OMP
// configuration out of the run and the run's provider credential in it, and
// the bounded tail of stderr that names a failure.
//
// Nothing here parses a frame. OMP's protocol grows between releases and a
// client may negotiate any version of it; a wrapper that decoded the stream in
// order to forward it would be one more implementation of that protocol to
// keep in step, and would be the one nobody asked for.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Budgets for the child. The run's own deadline lives with the client that
// supervises it; these bound only the shutdown handshake, so a wedged OMP
// cannot hold a finished run open.
const (
	// ompExitGrace is how long a closed stdin is given to end the child on its
	// own. docs/rpc.md: when stdin closes, OMP drains, disposes the session and
	// exits 0.
	ompExitGrace = 5 * time.Second
	// ompKillGrace is how long SIGTERM is given before SIGKILL. A client's own
	// exit grace is longer, so the tree is gone before it starts counting.
	ompKillGrace = 2 * time.Second
	// ompFrameBytes bounds one line of the child's stdout as the redaction
	// pass buffers it. OMP caps a physical stdout frame at 1 MiB (advertised
	// in the ready frame); the slack absorbs a frame at exactly that size
	// plus its envelope. A longer line is forwarded in pieces rather than
	// refused, because the stream is the client's to judge.
	ompFrameBytes = 2 << 20
)

// ── the child ────────────────────────────────────────────────────────────────

// ompSession is one running `omp --mode rpc` child: its pipes, its process
// group, and the bounded tail of its diagnostics.
type ompSession struct {
	cmd    *exec.Cmd
	pgid   int
	stdin  io.WriteCloser
	stdout io.Reader
	stderr *ompTail

	stopWatch chan struct{}
	watchOnce sync.Once
	waitOnce  sync.Once
	waitErr   error
}

// ompLaunch is everything the child needs that is not a constant: where the
// binary is, what overlay configures it, which directories it may treat as its
// own, and the sandbox it runs inside.
//
// When contain is set, config, home and work name paths inside the sandbox
// rather than on the host: the boundary binds Code's files in at fixed places
// and the session never sees where they came from. A nil contain is a launch
// with no boundary at all, which happens only when the backend established
// none — and Code declares exactly that, so such a run reaches here only for a
// client that accepted the declaration anyway.
type ompLaunch struct {
	binary  string
	config  string
	home    string
	work    string
	env     []string
	contain *sandboxRun
	// stderr, when set, receives the child's diagnostics as they are written,
	// beside the tail the session keeps for itself. The engine hands it the
	// redacting writer that fronts its own stderr.
	stderr io.Writer
}

// cwdHostDir names the host directory whose contents become the child's
// working directory. It reports false for a contained launch, where the
// working directory is a tmpfs the sandbox creates empty and no host directory
// backs it — which is the stronger guarantee, not a weaker one: OMP registers
// MCP servers from a config file at its working directory's root, and a
// directory that only ever exists inside the boundary cannot hold one.
func (l ompLaunch) cwdHostDir() (string, bool) {
	if l.contain != nil {
		return "", false
	}
	return l.work, true
}

// ompStartSession launches OMP with built-in tools disabled and a private OMP
// home, so the session's tool registry holds nothing but the host tools the
// client registers.
//
// --no-tools alone is not that lockdown. Measured against omp/18.0.11, it drops
// the documented built-ins but leaves learn, manage_skill, tts and every
// mcp__* tool the discovered configuration brings; a private HOME is what
// removes those, because it removes the configuration they are discovered from.
// The provider credential survives that lockdown, and has to: ompChildEnv adds
// it to the child's environment as the auth-broker variables, which name a
// service and a run-private pool file rather than anything under HOME, so
// replacing HOME does not reach it. It is added there rather than discovered,
// because the private home is exactly what makes discovery impossible.
func ompStartSession(ctx context.Context, launch ompLaunch) (*ompSession, error) {
	argv := ompArgv(launch)
	env := launch.env
	dir := launch.work
	var extra []*os.File
	if launch.contain != nil {
		argv = launch.contain.command(argv)
		env = launch.contain.childEnv(launch.env)
		extra = launch.contain.extraFiles()
		// The child's working directory is set inside the boundary; launch.work
		// names a path in the sandbox, which does not exist out here.
		dir = ""
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Args = argv
	cmd.Env = env
	cmd.Dir = dir
	cmd.ExtraFiles = extra
	ompSetProcessGroup(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	tail := &ompTail{}
	if launch.stderr != nil {
		cmd.Stderr = io.MultiWriter(tail, launch.stderr)
	} else {
		cmd.Stderr = tail
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("omp did not start: %w", err)
	}
	// The boundary is checked before the session is used, not after: a run that
	// declared ceilings it did not get is torn down here rather than allowed to
	// run behind a weaker boundary than the client was told about.
	if launch.contain != nil {
		if err := launch.contain.started(cmd.Process.Pid); err != nil {
			pgid := ompProcessGroup(cmd)
			_ = ompTerminateTree(cmd, pgid, false)
			_ = cmd.Wait()
			return nil, err
		}
	}

	session := &ompSession{
		cmd:       cmd,
		pgid:      ompProcessGroup(cmd),
		stdin:     stdin,
		stdout:    stdout,
		stderr:    tail,
		stopWatch: make(chan struct{}),
	}
	go session.watch(ctx)
	return session, nil
}

// ompArgv is the child's command line, and a fixed list on purpose. It carries
// no secret and never will: argv is visible in any process listing, so the
// provider credential reaches OMP through its environment, which a process
// listing does not read, and nothing a client sends reaches argv at all.
//
// --auto-approve is safe here and nowhere else: the only tools in the registry
// are the host tools the client registers, and the client is the authorizer
// of every call on them. An approval prompt would ask a question no RPC host
// in this design can answer, and would deadlock the run.
func ompArgv(launch ompLaunch) []string {
	return []string{
		launch.binary,
		"--mode", "rpc",
		"--no-tools",
		"--no-lsp",
		"--no-session",
		"--no-extensions",
		"--no-rules",
		"--no-skills",
		"--no-title",
		"--auto-approve",
		"--config", launch.config,
		"--cwd", launch.work,
	}
}

// watch turns a cancelled context into a dead process tree: SIGTERM to the
// group, then SIGKILL if the group is still there. A client will kill what
// remains anyway, so the only thing at stake is whether Code leaves it to.
func (s *ompSession) watch(ctx context.Context) {
	select {
	case <-ctx.Done():
	case <-s.stopWatch:
		return
	}
	_ = ompTerminateTree(s.cmd, s.pgid, true)
	timer := time.NewTimer(ompKillGrace)
	defer timer.Stop()
	select {
	case <-timer.C:
		_ = ompTerminateTree(s.cmd, s.pgid, false)
	case <-s.stopWatch:
	}
}

// stop releases the child: stdin is closed so OMP can exit on its own, and the
// tree is killed if it does not. It reports what the kernel accounted to the
// child, which is only available once the child has been reaped — so a caller
// that also wants the run's cgroup figures has to read those before calling
// this, because stopping the tree is what collects the scope.
func (s *ompSession) stop() runUsage {
	_ = s.stdin.Close()
	done := make(chan struct{})
	go func() {
		s.wait()
		close(done)
	}()
	timer := time.NewTimer(ompExitGrace)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		_ = ompTerminateTree(s.cmd, s.pgid, false)
		<-done
	}
	s.watchOnce.Do(func() { close(s.stopWatch) })

	return ompChildUsage(s.cmd)
}

func (s *ompSession) wait() {
	s.waitOnce.Do(func() { s.waitErr = s.cmd.Wait() })
}

// exitCode is the child's exit status once it has been reaped: -1 for a child
// that a signal ended, which is what a client reads as "the tree was torn
// down" rather than as an answer OMP gave.
func (s *ompSession) exitCode() int {
	s.wait()
	if s.cmd.ProcessState == nil {
		return -1
	}
	return s.cmd.ProcessState.ExitCode()
}

// diagnostics is the tail of OMP's stderr, for naming a failure.
func (s *ompSession) diagnostics() string { return s.stderr.String() }

// ── bounded diagnostics ──────────────────────────────────────────────────────

// ompTailBytes is how much of OMP's stderr is kept. Diagnostics are unbounded
// and irrelevant until something fails, and a failure is explained by its last
// few lines.
const ompTailBytes = 4 << 10

// ompTail keeps the last ompTailBytes written to it. exec copies stderr from
// its own goroutine, so the mutex is load-bearing rather than defensive.
type ompTail struct {
	mu  sync.Mutex
	buf []byte
}

func (t *ompTail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > ompTailBytes {
		t.buf = t.buf[len(t.buf)-ompTailBytes:]
	}
	return len(p), nil
}

func (t *ompTail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(string(t.buf))
}

// ── the private run directory ────────────────────────────────────────────────

// ompRunDir is one run's private filesystem: the OMP config overlay, the OMP
// home that keeps the operator's configuration out of the run, and the working
// directory the child is started in.
//
// It is not containment. Nothing stops the child from writing outside it; the
// directory exists so that what the child writes by default lands somewhere
// Code deletes, and so that OMP discovers no configuration but this run's.
type ompRunDir struct {
	root   string
	config string
	home   string
	work   string
}

func ompNewRunDir(configYAML string) (*ompRunDir, error) {
	root, err := os.MkdirTemp("", "code-engine-run-*")
	if err != nil {
		return nil, err
	}
	dir := &ompRunDir{
		root:   root,
		config: filepath.Join(root, "config.yml"),
		home:   filepath.Join(root, "home"),
		work:   filepath.Join(root, "work"),
	}
	for _, path := range []string{dir.home, dir.work} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			dir.remove()
			return nil, err
		}
	}
	// 0600: the overlay names models and dials, not credentials, but it is the
	// profile's resolved configuration and no other user has business reading
	// it.
	if err := os.WriteFile(dir.config, []byte(configYAML), 0o600); err != nil {
		dir.remove()
		return nil, err
	}
	return dir, nil
}

func (d *ompRunDir) remove() {
	if d == nil || d.root == "" {
		return
	}
	_ = os.RemoveAll(d.root)
}

// writeAccountPool materialises the run's account pool where the child can read
// it. OMP's auth broker takes a path rather than a document, so the pool has to
// exist on disk; putting it here is what keeps it disposable. 0600 inside a
// 0700 temporary root, and removed with everything else the run leaves behind.
//
// The file names account identities rather than credentials, but it is the
// run's account policy, and a policy any other user could read or rewrite would
// not be one.
func (d *ompRunDir) writeAccountPool(pool map[string][]string) (string, error) {
	body, err := json.Marshal(pool)
	if err != nil {
		return "", err
	}
	path := filepath.Join(d.root, "account-pool.json")
	if err := os.WriteFile(path, append(body, '\n'), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// bytesWritten sums what the run left in its private directory, so the report
// carries a measured figure rather than an assumption. An unreadable entry is
// skipped: a partial sum is worth more than none, and this is a report rather
// than a limit.
func (d *ompRunDir) bytesWritten() int64 {
	var total int64
	_ = filepath.WalkDir(d.root, func(_ string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if info, err := entry.Info(); err == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}

// ── the provider credential ──────────────────────────────────────────────────

// ompAuth is what a run authenticates with: the central auth broker OMP asks
// for provider tokens, and the pool of account identities the operator's
// selection leaves enabled.
//
// The engine has to resolve this for itself. An interactive `code` inherits
// the broker variables from the operator's shell, but a supervising client
// spawns the engine with a curated environment — HOME, PATH, TMPDIR, LANG —
// precisely so that no credential rides in ambiently, and ompChildEnv then
// replaces HOME so the child discovers nothing of its own either. Between
// those two, a run that did not resolve a credential here would reach the
// provider with nothing at all.
type ompAuth struct {
	broker brokerConfig
	// pool is the account-pool document, keyed by provider: the OAuth
	// identities the operator's current selection leaves enabled. Rebuilding it
	// per run rather than inheriting one is the whole point — an account the
	// operator disabled must stay out of a supervised run too.
	pool map[string][]string
	// poolPath is where pool was written for this run, set once the run
	// directory exists, because that directory is what disposes of it.
	poolPath string
}

func (a ompAuth) configured() bool { return a.broker.configured() }

// errOmpNoCredential is the failure a run with nothing to authenticate with
// ends in before anything is launched, and it names the remedy. The
// alternative is an OMP child that starts and fails its first model call for a
// reason nobody can connect to a missing credential.
var errOmpNoCredential = errors.New("no provider credential is resolvable, so the run could not " +
	"authenticate: export OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN into the environment this " +
	"engine is spawned with, or leave Code's vault manifest readable at " +
	"${XDG_CONFIG_HOME:-$HOME/.config}/code/" + ompVaultManifestName + " (CODE_AUTH_VAULTS_FILE overrides " +
	"the path); neither route resolved a broker")

// ompVaultManifestName is Code's own credential store, in Code's own config
// directory beside models.yml.
const ompVaultManifestName = "auth-vaults.json"

// ompVaultManifest locates that store. The engine needs a HOME-relative
// default where the interactive path needs none: an operator's shell exports
// the broker variables, and a client's curated environment is exactly what
// leaves them out — but the client does hand the engine the operator's real
// HOME, so the manifest and the token file it names are still reachable.
func ompVaultManifest() string {
	if path := os.Getenv("CODE_AUTH_VAULTS_FILE"); path != "" {
		return path
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, "code", ompVaultManifestName)
}

// ompResolveAuth resolves the run's credential the way an interactive trusted
// launch resolves it — the same broker, the same account snapshot, the same
// disabled-account selection — rather than growing a second resolution beside
// it. The environment names are main's, repeated here because the engine has
// no model to read them through.
func ompResolveAuth() (ompAuth, error) {
	broker := resolveBroker(os.Getenv("CODE_AUTH_VAULTS"), ompVaultManifest())
	if !broker.configured() {
		return ompAuth{}, nil
	}
	accounts, err := loadAccounts(broker)
	if err != nil {
		// Wrapping the reason is safe: the broker's token travels in an
		// Authorization header, and no error loadAccounts builds formats it.
		return ompAuth{}, fmt.Errorf("the account snapshot is unavailable, so the run would launch "+
			"with no account policy at all: %w", err)
	}
	// A disabled account stays disabled. The selection is the operator's, and
	// an engine that ignored it would route a supervised run through an
	// account they had deliberately taken out of service.
	disabled := loadAccountSelectionState(os.Getenv("CODE_AUTH_ACCOUNT_STATE")).CurrentDisabled()
	pool := launchAccountReport(accounts, disabled, launchIntent{}, time.Now()).pool()
	return ompAuth{broker: broker, pool: pool}, nil
}

// ── the child's environment ──────────────────────────────────────────────────

// ompPrivateEnvKeys are the variables the run replaces rather than inherits.
// Each one names a place OMP would otherwise read the operator's configuration,
// sessions or caches from, and the point of the private home is that it reads
// none of them.
var ompPrivateEnvKeys = map[string]bool{
	"HOME":                true,
	"OMP_PROFILE":         true,
	"PI_CONFIG_DIR":       true,
	"PI_CODING_AGENT_DIR": true,
	"XDG_CONFIG_HOME":     true,
	"XDG_DATA_HOME":       true,
	"XDG_STATE_HOME":      true,
	"XDG_CACHE_HOME":      true,
}

// ompChildEnv builds the child's environment: the inherited one with the
// private-home keys replaced, and the run's own provider credential added.
//
// The provider credential is the one secret that is added, and withAuthEnv is
// the single place that names it. That it strips the inherited auth-broker
// variables first is the load-bearing part: an ambient
// OMP_AUTH_BROKER_ACCOUNT_POOL_FILE from an operator's shell would otherwise
// survive into a supervised run and route it through a pool this run's account
// policy never approved.
//
// Nothing scrubs the credential back out of what Code writes, because nothing
// writes it: it exists here as broker.Token, is formatted exactly once — into
// the entry below — and a child's environment is not something Code logs,
// reports or puts on the wire. What OMP itself prints is a separate question,
// and the engine answers it by redacting the credential from every byte of the
// child's output it forwards (engineredact.go).
func ompChildEnv(base []string, home string, auth ompAuth) []string {
	out := make([]string, 0, len(base)+len(ompPrivateEnvKeys)+len(authEnvKeys))
	for _, entry := range base {
		key, _, _ := strings.Cut(entry, "=")
		if ompPrivateEnvKeys[key] {
			continue
		}
		out = append(out, entry)
	}
	config := filepath.Join(home, ".omp")
	out = append(out,
		"HOME="+home,
		"PI_CONFIG_DIR="+config,
		"PI_CODING_AGENT_DIR="+filepath.Join(config, "agent"),
		"XDG_CONFIG_HOME="+filepath.Join(home, ".config"),
		"XDG_DATA_HOME="+filepath.Join(home, ".local", "share"),
		"XDG_STATE_HOME="+filepath.Join(home, ".local", "state"),
		"XDG_CACHE_HOME="+filepath.Join(home, ".cache"),
	)
	if !auth.configured() {
		// Unreachable from a run, which refuses to launch without a credential.
		// Returning the environment untouched keeps it that way instead of
		// handing OMP empty broker variables that read as a configured broker.
		return out
	}
	return withAuthEnv(out, auth.broker, auth.poolPath)
}
