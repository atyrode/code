package main

// OMP's RPC transport, as much of it as driving one analysis run needs.
//
// `omp --mode rpc` is newline-delimited JSON over stdin/stdout: OMP opens with a
// ready frame, answers commands correlated by id, streams session events, and —
// the mechanism this whole file exists for — calls back out to host-owned tools
// registered with set_host_tools. That callback is what makes brokered evidence
// possible: the model can only reach material the host chooses to serve, and the
// host is Code, which asks Babel first.
//
// Only the surface the driver uses is modelled, and every struct ignores fields
// it does not know, because OMP's protocol grows between releases and an unknown
// field must never be fatal (docs/rpc.md, "Error Model and Recoverability").
//
// Protocol v2 is deliberately not negotiated. v2 exists to carry stdout objects
// above 1 MiB losslessly by chunking them, and Babel caps a worker's own line
// length far below that; staying on v1 keeps one framing rule in play instead of
// two, and an rpc_chunk frame arriving unrequested is treated as a protocol
// violation rather than silently dropped.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// OMP frame and command types this driver speaks.
const (
	ompFrameReady          = "ready"
	ompFrameResponse       = "response"
	ompFrameChunk          = "rpc_chunk"
	ompFrameHostToolCall   = "host_tool_call"
	ompFrameHostToolCancel = "host_tool_cancel"
	ompFrameHostToolResult = "host_tool_result"
	ompFrameAgentStart     = "agent_start"
	ompFrameAgentEnd       = "agent_end"
	ompFrameTurnStart      = "turn_start"
	ompFrameTurnEnd        = "turn_end"
	ompFrameMessageUpdate  = "message_update"
	ompFrameToolStart      = "tool_execution_start"
	ompFrameToolEnd        = "tool_execution_end"

	ompCommandSetHostTools = "set_host_tools"
	ompCommandPrompt       = "prompt"
)

// ompTextDelta is the assistantMessageEvent kind that carries visible output.
// Thinking deltas arrive on the same channel and are not the analysis, so the
// accumulator matches on this exactly rather than on any delta at all.
const ompTextDelta = "text_delta"

// Budgets for the child. The run's own deadline lives in the context Babel
// supervises; these bound only the shutdown handshake, so a wedged OMP cannot
// hold a cancelled run open.
const (
	// ompExitGrace is how long a closed stdin is given to end the child on its
	// own. docs/rpc.md: when stdin closes, OMP drains, disposes the session and
	// exits 0.
	ompExitGrace = 5 * time.Second
	// ompKillGrace is how long SIGTERM is given before SIGKILL. Babel's own
	// exit grace is longer, so the tree is gone before Babel starts counting.
	ompKillGrace = 2 * time.Second
	// ompFrameBytes bounds one inbound line. OMP caps a physical stdout frame
	// at 1 MiB (advertised in the ready frame); the slack absorbs a frame at
	// exactly that size plus its envelope.
	ompFrameBytes = 2 << 20
)

// ── frames ───────────────────────────────────────────────────────────────────

// ompFrame is one line of OMP's stdout, decoded down to the fields the driver
// acts on. Everything else is ignored by construction.
type ompFrame struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Command string `json:"command"`
	// Success is a pointer so a missing field reads as "not a command
	// response" rather than as a failure.
	Success *bool           `json:"success"`
	Error   string          `json:"error"`
	Code    string          `json:"code"`
	Data    json.RawMessage `json:"data"`

	// Host-tool callback fields.
	ToolCallID string          `json:"toolCallId"`
	ToolName   string          `json:"toolName"`
	Arguments  json.RawMessage `json:"arguments"`
	TargetID   string          `json:"targetId"`

	// Session-event fields.
	Assistant  *ompAssistantEvent `json:"assistantMessageEvent"`
	IsTerminal *bool              `json:"isTerminal"`
}

// ompAssistantEvent is the streaming delta carried by message_update.
type ompAssistantEvent struct {
	Type  string `json:"type"`
	Delta string `json:"delta"`
}

func (f *ompFrame) succeeded() bool { return f.Success != nil && *f.Success }

// terminal reports whether an agent_end frame ends the run. isTerminal:false
// means maintenance or async delivery scheduled more work, so the session will
// resume; an absent field is terminal, which keeps older OMPs compatible.
func (f *ompFrame) terminal() bool { return f.IsTerminal == nil || *f.IsTerminal }

// ompSetHostToolsCommand registers the host-owned tools for the session. OMP
// adds them to the tool registry before the next model call, and re-sending
// replaces the previous set.
type ompSetHostToolsCommand struct {
	ID    string            `json:"id"`
	Type  string            `json:"type"`
	Tools []ompHostToolWire `json:"tools"`
}

// ompHostToolWire is one host tool as OMP wants it declared.
type ompHostToolWire struct {
	Name        string          `json:"name"`
	Label       string          `json:"label,omitempty"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
	// LoadMode "essential" keeps a brokered tool in the model's initial tool
	// set. The default for a host tool is "discoverable", which would hide the
	// only evidence route this run has behind a discovery step.
	LoadMode string `json:"loadMode,omitempty"`
}

type ompPromptCommand struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Message string `json:"message"`
}

// ompHostToolResult completes one host_tool_call. IsError rejects the call and
// surfaces the text to the model as a tool error, which is exactly the shape a
// refusal needs: the model sees why, adapts, and keeps working.
type ompHostToolResult struct {
	Type    string            `json:"type"`
	ID      string            `json:"id"`
	IsError bool              `json:"isError,omitempty"`
	Result  ompHostToolOutput `json:"result"`
}

type ompHostToolOutput struct {
	Content []ompHostToolText `json:"content"`
}

type ompHostToolText struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func ompToolText(text string) ompHostToolOutput {
	return ompHostToolOutput{Content: []ompHostToolText{{Type: "text", Text: text}}}
}

// ── the child ────────────────────────────────────────────────────────────────

// ompSession is one running `omp --mode rpc` child: its pipes, its process
// group, and the bounded tail of its diagnostics.
type ompSession struct {
	cmd    *exec.Cmd
	pgid   int
	stdin  io.WriteCloser
	enc    *json.Encoder
	lines  *bufio.Scanner
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
// none — and Code declares exactly that, so such a run reaches here only for an
// operator who relaxed it deliberately.
type ompLaunch struct {
	binary  string
	config  string
	home    string
	work    string
	env     []string
	contain *sandboxRun
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
// grant produced.
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
	cmd.Stderr = tail

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("omp did not start: %w", err)
	}
	// The boundary is checked before the session is used, not after: a run that
	// declared ceilings it did not get is torn down here rather than allowed to
	// produce evidence behind a weaker boundary than Babel recorded.
	if launch.contain != nil {
		if err := launch.contain.started(cmd.Process.Pid); err != nil {
			pgid := ompProcessGroup(cmd)
			_ = ompTerminateTree(cmd, pgid, false)
			_ = cmd.Wait()
			return nil, err
		}
	}
	lines := bufio.NewScanner(stdout)
	lines.Buffer(make([]byte, 0, 64<<10), ompFrameBytes)

	session := &ompSession{
		cmd:       cmd,
		pgid:      ompProcessGroup(cmd),
		stdin:     stdin,
		enc:       json.NewEncoder(stdin),
		lines:     lines,
		stderr:    tail,
		stopWatch: make(chan struct{}),
	}
	go session.watch(ctx)
	return session, nil
}

// ompArgv is the child's command line, and a fixed list on purpose. It carries
// no secret and never will: argv is visible in any process listing, so the job
// — and therefore the run-scoped broker credential — reaches this process on
// stdin and reaches OMP not at all, while the provider credential reaches OMP
// through its environment, which a process listing does not read.
//
// --auto-approve is safe here and nowhere else: the only tools in the registry
// are Babel-brokered, and Babel is the authorizer. An approval prompt would ask
// a question no RPC host in this design can answer, and would deadlock the run.
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
// group, then SIGKILL if the group is still there. Babel will kill what remains
// anyway, so the only thing at stake is whether Code leaves it to.
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

func (s *ompSession) send(command any) error {
	return s.enc.Encode(command)
}

// next reads the next frame. A line that does not parse is a protocol
// violation rather than something to skip: the driver's whole grip on the run
// is this stream, and guessing past a malformed frame would mean guessing about
// a tool call.
func (s *ompSession) next() (*ompFrame, error) {
	for s.lines.Scan() {
		line := bytes.TrimSpace(s.lines.Bytes())
		if len(line) == 0 {
			continue
		}
		var frame ompFrame
		if err := json.Unmarshal(line, &frame); err != nil {
			return nil, fmt.Errorf("omp wrote an unparseable frame: %w", err)
		}
		if frame.Type == ompFrameChunk {
			return nil, errors.New("omp chunked a frame on protocol v1, which was never negotiated")
		}
		return &frame, nil
	}
	if err := s.lines.Err(); err != nil {
		return nil, fmt.Errorf("omp stream ended: %w", err)
	}
	return nil, io.EOF
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

// diagnostics is the tail of OMP's stderr, for naming a failure. It cannot
// carry the run's broker credential, because OMP is never given it.
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
	if extra := len(t.buf) - ompTailBytes; extra > 0 {
		t.buf = t.buf[:copy(t.buf, t.buf[extra:])]
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
	root, err := os.MkdirTemp("", "code-babel-run-*")
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

// bytesWritten sums what the run left in its private directory, so the receipt
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
// Worker mode has to resolve this for itself. An interactive `code` inherits
// the broker variables from the operator's shell, but Babel spawns a worker
// with a curated environment — HOME, PATH, TMPDIR, LANG — precisely so that no
// credential rides in ambiently, and ompChildEnv then replaces HOME so the
// child discovers nothing of its own either. Between those two, a run that did
// not resolve a credential here would reach the provider with nothing at all.
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

// errOmpNoCredential is the terminal failure a run with nothing to authenticate
// with ends in, and it names the remedy. The alternative is an OMP child that
// starts, fails its first model call, and reports that as an analysis failure
// in a receipt where nobody can connect it to a missing credential.
var errOmpNoCredential = errors.New("no provider credential is resolvable, so the analysis could not " +
	"authenticate: export OMP_AUTH_BROKER_URL and OMP_AUTH_BROKER_TOKEN into the environment this " +
	"worker is spawned with, or leave Code's vault manifest readable at " +
	"${XDG_CONFIG_HOME:-$HOME/.config}/code/" + ompVaultManifestName + " (CODE_AUTH_VAULTS_FILE overrides " +
	"the path); neither route resolved a broker")

// ompVaultManifestName is Code's own credential store, in Code's own config
// directory beside models.yml.
const ompVaultManifestName = "auth-vaults.json"

// ompVaultManifest locates that store. Worker mode needs a HOME-relative
// default where the interactive path needs none: an operator's shell exports
// the broker variables, and Babel's curated environment is exactly what leaves
// them out — but Babel does hand the worker the operator's real HOME, so the
// manifest and the token file it names are still reachable.
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
// it. The environment names are main's, repeated here because a worker has no
// model to read them through.
func ompResolveAuth() (ompAuth, error) {
	broker := resolveBroker(os.Getenv("CODE_AUTH_VAULTS"), ompVaultManifest())
	if !broker.configured() {
		return ompAuth{}, errOmpNoCredential
	}
	accounts, err := loadAccounts(broker)
	if err != nil {
		// Wrapping the reason is safe: the broker's token travels in an
		// Authorization header, and no error loadAccounts builds formats it.
		return ompAuth{}, fmt.Errorf("the account snapshot is unavailable, so the run would launch "+
			"with no account policy at all: %w", err)
	}
	// A disabled account stays disabled. The selection is the operator's, and a
	// worker that ignored it would route a supervised run through an account
	// they had deliberately taken out of service.
	disabled := loadAccountSelectionState(os.Getenv("CODE_AUTH_ACCOUNT_STATE")).CurrentDisabled()
	return ompAuth{broker: broker, pool: buildAccountPool(accounts, disabled)}, nil
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
// private-home keys replaced, any entry whose value carries a job secret
// dropped, and the run's own provider credential added.
//
// The drop is a guard, not a transport. The run-scoped broker credential
// arrives on stdin and stays in this process's memory; it reaches Babel's
// evidence API through an HTTP request Code makes itself, and reaches OMP only
// as the response body of a host tool. Nothing in this design would ever put it
// in the environment — which is exactly why the guard is cheap to keep and
// worth keeping, because "never" is a property to enforce rather than assume.
//
// The provider credential is the one secret that is added rather than removed,
// and withAuthEnv is the single place that names it. That it strips the
// inherited auth-broker variables first is the load-bearing part: an ambient
// OMP_AUTH_BROKER_ACCOUNT_POOL_FILE from an operator's shell would otherwise
// survive into a supervised run and route it through a pool this run's account
// policy never approved.
//
// Nothing scrubs the credential back out of what Code writes, because nothing
// writes it: it exists here as broker.Token, is formatted exactly once — into
// the entry below — and a child's environment is not something Code logs,
// reports or puts on the wire. What OMP itself prints is a separate question,
// and the protocol layer answers it by registering this credential with the
// scrubber that already covers the job's (see credentialResolver).
func ompChildEnv(base []string, home string, job babelJob, auth ompAuth) []string {
	secrets := job.secrets()
	out := make([]string, 0, len(base)+len(ompPrivateEnvKeys)+len(authEnvKeys))
	for _, entry := range base {
		key, value, _ := strings.Cut(entry, "=")
		if ompPrivateEnvKeys[key] || ompCarriesSecret(value, secrets) {
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

func ompCarriesSecret(value string, secrets []string) bool {
	for _, secret := range secrets {
		if secret != "" && strings.Contains(value, secret) {
			return true
		}
	}
	return false
}

// ── Babel's evidence API ─────────────────────────────────────────────────────

// ompEvidenceTimeout bounds one brokered request. A blocked broker must not
// hold a host tool open indefinitely: OMP is waiting for the result, and the
// model can be told the evidence was unavailable and carry on.
const ompEvidenceTimeout = 30 * time.Second

// ompEvidenceBody is the maximum evidence a single request may return. Babel
// caps a worker's line length, and an unbounded body would let the broker
// dictate this process's memory.
const ompEvidenceBody = 256 << 10

// ompEvidenceRequest is one allowed evidence request, as Babel's broker
// receives it.
type ompEvidenceRequest struct {
	RunID      string          `json:"run_id"`
	JobID      string          `json:"job_id"`
	Capability string          `json:"capability"`
	Tool       string          `json:"tool"`
	Arguments  json.RawMessage `json:"arguments,omitempty"`
}

// ompEvidenceClient is a transport of its own rather than the shared default,
// so broker traffic — the only traffic carrying the run-scoped credential —
// never shares a connection pool with anything else Code talks to.
var ompEvidenceClient = &http.Client{}

// fetchBrokeredEvidence services one allowed request against Babel's
// capability-gated evidence API and returns the evidence as text.
//
// This is the whole reason the credential never needs to leave the process. The
// bearer token is placed on a request Code makes itself; OMP receives only the
// response body, over the stdio it is already answering a host tool on. There
// is no file, no argument and no environment variable in the path.
//
// A non-2xx answer is reported by status alone. The body might explain more,
// but a credential coming back to the model is the one failure that has to be
// impossible rather than unlikely, and a broker that echoed the Authorization
// header into an error page would otherwise do exactly that.
func fetchBrokeredEvidence(ctx context.Context, broker babelBroker, evidence ompEvidenceRequest) (string, error) {
	if strings.TrimSpace(broker.Endpoint) == "" {
		return "", errors.New("the job named no evidence broker")
	}
	body, err := json.Marshal(evidence)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, ompEvidenceTimeout)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, broker.Endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/plain, application/json")
	if broker.Token != "" {
		request.Header.Set("Authorization", "Bearer "+broker.Token)
	}
	response, err := ompEvidenceClient.Do(request)
	if err != nil {
		// url.Error renders the endpoint, never a header, so this is safe to
		// pass on to the model as the reason the evidence is missing.
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return "", fmt.Errorf("the evidence broker answered %s", response.Status)
	}
	served, err := io.ReadAll(io.LimitReader(response.Body, ompEvidenceBody))
	if err != nil {
		return "", err
	}
	return string(served), nil
}
