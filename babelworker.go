package main

// `code babel` — Code's side of Babel's analysis-worker protocol.
//
// babelwire.go holds the wire format and the investigator seam; this file is
// everything around that seam: the handshake, the event stream, the tool-request
// round trip, configure mode, and worker mode's wiring. Nothing here knows about
// OMP, and nothing below the seam knows about the wire.
//
// The invariants this file owns exist because Babel checks them and fails the
// run rather than tolerating a near miss. They are enforced here, once, rather
// than trusted to an investigator:
//
//   - hello is written and flushed before the first read, so Babel can refuse an
//     incompatible counterpart before any job material — and therefore any
//     credential — is written to this process;
//   - seq is allocated in exactly one place (nextSeq, called only from event),
//     so no code path can skip or reuse one;
//   - the first stream event is the resolved configuration, there is exactly one
//     terminal event, and nothing follows it;
//   - every line written fits the accepted line budget, because an oversized
//     line is a protocol violation rather than a large message;
//   - the job's broker credential is scrubbed out of every byte this process
//     writes to stdout or stderr.
//
// A denial is not a failure. Babel denies a tool request that falls outside the
// run's grant before it consults any policy, so asking for something Code was
// not granted is a normal outcome the investigation adapts to — it returns to the
// caller as a denial and the run still delivers a terminal event.
//
// Exit status: 0 after a result, 1 after an error event, 2 when the protocol
// itself broke, 3 when Babel refused the handshake. Babel owns the run's final
// status either way, so these are for an operator reading a shell, not for Babel.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"reflect"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	// babelWorkerName is how this binary identifies itself to Babel. Babel
	// records it so a run can be attributed to a build.
	babelWorkerName = "code"

	// babelDefaultMaxLineBytes bounds written lines when Babel's accept names no
	// budget. It matches the value in Babel's own documentation.
	babelDefaultMaxLineBytes = 1 << 20

	// babelInboundLineCap bounds what this worker is willing to buffer from
	// stdin. Babel's own budget is smaller by design; this is the ceiling past
	// which an inbound line is a protocol violation rather than a big message,
	// and it is fixed at startup because the handshake is read through the same
	// buffered reader as everything after it.
	babelInboundLineCap = 8 << 20

	// babelResultSchema names the payload shape a result carries.
	babelResultSchema = "babel.analysis-result/1"

	babelTruncationMarker = "…[truncated]"
)

// babelRedacted replaces a job secret anywhere it would otherwise be written.
var babelRedacted = []byte("[redacted]")

// babelWorkerCapabilities are the capabilities Code's analysis actually asks
// for. Configure mode reports them so Babel knows what a grant would have to
// cover; the run's grant is Babel's to set and is always narrower or equal.
func babelWorkerCapabilities() []string {
	return []string{babelCapabilityCorpusSearch, babelCapabilityRepoRead}
}

// babelWorkerVersion reports this build. Code carries no version constant and is
// not stamped by its Nix wrapper, so the build info the toolchain embeds is the
// only honest answer: a module version for a released build, the VCS revision
// for a source build. It is never empty — Babel's conformance suite treats a
// worker that cannot name its build as unattributable.
func babelWorkerVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	if v := info.Main.Version; v != "" && v != "(devel)" {
		return v
	}
	revision, dirty := "", ""
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			revision = setting.Value
		case "vcs.modified":
			if setting.Value == "true" {
				dirty = "+dirty"
			}
		}
	}
	if revision == "" {
		return "devel"
	}
	if len(revision) > 12 {
		revision = revision[:12]
	}
	return "devel-" + revision + dirty
}

// ── the seam ─────────────────────────────────────────────────────────────────

// babelInvestigatorConformance is the --investigator value that selects the
// in-tree conformance stub.
const babelInvestigatorConformance = "conformance"

// newInvestigator selects the investigator worker mode drives. This is the one
// place OMP is wired in: the OMP driver is a separate file implementing the
// investigator interface from babelwire.go, and it lands by replacing the single
// return below with a call to its constructor.
//
// Until then a worker-mode run has nothing to run, and says so with a terminal
// error rather than pretending. A default placeholder that answered like an
// investigator would put fabricated analysis into a receipt a reviewer is meant
// to trust, which is worse than an honest failure — so the conformance stub,
// which does exactly that on purpose, is reachable only through an explicit
// --investigator=conformance.
func newInvestigator() investigator {
	// ← OMP driver plugs in here. Its constructor takes a profile source, and
	// the adapter below belongs in this file because it is the one that names
	// the store's types:
	//
	//	return newOmpInvestigator(babelStoreSource{store: newProfileStore("")})
	return nil
}

// syntheticResolver is the conformance exception, at the only layer that can
// apply it. babelwire.go's resolve seam is resolve-or-fail and is handed a
// profile reference rather than the job, so an investigator cannot tell a
// production job naming a missing profile — which must fail with
// profile-unavailable — from one of Babel's obligations, which names a synthetic
// profile on purpose and must proceed with no store at all.
//
// The protocol layer has the job, so it makes that call: an investigator that
// implements this gets asked for a synthetic configuration when
// job.conformanceRequested() reports true, and resolve stays strict for every
// real run. An investigator that does not implement it is simply never offered
// the exception.
type syntheticResolver interface {
	syntheticConfiguration(job babelJob) babelConfiguration
}

// ── argv ─────────────────────────────────────────────────────────────────────

type babelOptions struct {
	profileID    string
	sets         map[string]string
	investigator string
}

const babelHelp = `code babel — speak Babel's analysis-worker protocol on stdin/stdout

  code babel [--profile ID] [--set KEY=VALUE]... [--investigator KIND]

      Babel (github.com/atyrode/babel) supervises this process as its analysis
      worker. The protocol is newline-delimited JSON: this process writes hello
      first, Babel replies accept or refuse, and the accepted mode decides what
      happens next. Nothing is read from a terminal and nothing is printed for a
      human — stdout is the protocol and stderr is diagnostics.

      Configure mode resolves Code's dials, saves the result as an immutable
      profile revision, reports the reference, and exits without launching OMP.
      Worker mode runs one analysis job through the investigator.

        --profile ID       profile to save or report (default %s)
        --set KEY=VALUE    override one dial, repeatable: --set thinking=high
        --investigator K   worker-mode investigator. %s selects the
                           in-tree stub Babel's conformance suite grades; it
                           runs no analysis and must never do real work

      The dials are resolved without a terminal: --set wins, then the persisted
      selection, then Code's defaults. See the note at babelResolveDials.

  Profile store: $XDG_STATE_HOME/code/babel/profiles, or %s.
`

func babelHelpText() string {
	return fmt.Sprintf(babelHelp, defaultBabelProfileID, babelInvestigatorConformance, babelProfileStateEnv)
}

// runBabel is the `code babel` subcommand.
func runBabel(args []string) int {
	opts := babelOptions{profileID: defaultBabelProfileID, sets: map[string]string{}}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--profile":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "code babel: --profile needs an id")
				return 2
			}
			opts.profileID = args[i]
		case "--set":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "code babel: --set needs KEY=VALUE")
				return 2
			}
			key, value, ok := strings.Cut(args[i], "=")
			if !ok || key == "" {
				fmt.Fprintf(os.Stderr, "code babel: --set %q is not KEY=VALUE\n", args[i])
				return 2
			}
			opts.sets[key] = value
		case "--investigator":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "code babel: --investigator needs a kind")
				return 2
			}
			opts.investigator = args[i]
		case "-h", "--help":
			fmt.Print(babelHelpText())
			return 0
		default:
			fmt.Fprintf(os.Stderr, "code babel: unknown flag %q\n", args[i])
			return 2
		}
	}
	if opts.investigator != "" && opts.investigator != babelInvestigatorConformance {
		fmt.Fprintf(os.Stderr, "code babel: unknown investigator %q\n", opts.investigator)
		return 2
	}
	// Babel cancels by closing this process's stdin and then killing the tree;
	// honouring the signals too means a run interrupted from a shell tears down
	// on the same path rather than a second one.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return newBabelSession(os.Stdin, os.Stdout, os.Stderr).run(ctx, opts)
}

// ── the session ──────────────────────────────────────────────────────────────

// babelSession is one conversation with Babel. It owns every byte written to
// stdout, which is what lets the ordering, sequencing and budget rules be
// invariants rather than conventions.
type babelSession struct {
	out  *bufio.Writer
	errw io.Writer
	scan *bufio.Scanner

	limits babelLimits
	mode   string

	seq        int
	events     int
	configured bool
	terminal   string

	requests int
	issued   map[string]bool

	// secrets are the job's, scrubbed out of everything written. Empty until
	// the job is read, which is the first moment a secret exists.
	secrets []string

	// inbound carries stdin lines after the handshake. stdin is read by one
	// goroutine so that its close can cancel the run promptly even while the
	// investigation is busy, without that goroutine ever consuming a decision
	// the tool-request path is waiting for.
	inbound   chan babelInbound
	stdinDone chan struct{}

	// ctx and cancel are the run's. requestTool has a fixed signature with no
	// context parameter, so the session holds the one it must block on.
	ctx    context.Context
	cancel context.CancelFunc

	// fatal records a protocol violation observed where no error could be
	// returned — inside the emit and request callbacks handed to an
	// investigator. The run then ends with an error event instead of a result.
	fatal error
}

type babelInbound struct {
	line []byte
	err  error
}

func newBabelSession(in io.Reader, out, errw io.Writer) *babelSession {
	scan := bufio.NewScanner(in)
	scan.Buffer(make([]byte, 0, 64<<10), babelInboundLineCap)
	return &babelSession{
		out:       bufio.NewWriter(out),
		errw:      errw,
		scan:      scan,
		issued:    map[string]bool{},
		inbound:   make(chan babelInbound, 8),
		stdinDone: make(chan struct{}),
		ctx:       context.Background(),
		cancel:    func() {},
	}
}

// diag writes one scrubbed diagnostic. stderr is never parsed by Babel, but it
// is captured into the receipt's failure record, so a credential must not reach
// it either.
func (s *babelSession) diag(format string, args ...any) {
	fmt.Fprintln(s.errw, s.scrubString("code babel: "+fmt.Sprintf(format, args...)))
}

// scrub removes every job secret from b. It scrubs both the raw bytes and the
// JSON-escaped encoding, because a secret needing an escape travels as a
// different byte sequence than the one the job carried.
func (s *babelSession) scrub(b []byte) []byte {
	for _, secret := range s.secrets {
		if secret == "" {
			continue
		}
		b = bytes.ReplaceAll(b, []byte(secret), babelRedacted)
		if encoded, err := json.Marshal(secret); err == nil && len(encoded) > 2 {
			if inner := encoded[1 : len(encoded)-1]; !bytes.Equal(inner, []byte(secret)) {
				b = bytes.ReplaceAll(b, inner, babelRedacted)
			}
		}
	}
	return b
}

func (s *babelSession) scrubString(str string) string {
	if len(s.secrets) == 0 {
		return str
	}
	return string(s.scrub([]byte(str)))
}

// nextSeq allocates the one strictly increasing sequence number shared by every
// event type. It is called from event and nowhere else.
func (s *babelSession) nextSeq() int {
	s.seq++
	return s.seq
}

// put writes one complete line. Babel reads a line at a time and then blocks on
// the next, so an unflushed event is an event that never happened.
func (s *babelSession) put(line []byte) error {
	if _, err := s.out.Write(line); err != nil {
		return err
	}
	if err := s.out.WriteByte('\n'); err != nil {
		return err
	}
	return s.out.Flush()
}

// writeLine emits one message, scrubbed and bounded. An oversized line is a
// protocol violation rather than a large message, so a payload that does not fit
// the accepted budget is shrunk — losing detail — instead of breaking the run.
// v must be a pointer, because that is what babelShrink needs to give something
// up.
func (s *babelSession) writeLine(v any) error {
	for {
		data, err := json.Marshal(v)
		if err != nil {
			return err
		}
		data = s.scrub(data)
		budget := s.limits.MaxLineBytes
		if budget <= 0 || len(data)+1 <= budget {
			return s.put(data)
		}
		if !babelShrink(v, len(data)+1-budget) {
			return fmt.Errorf("a %d-byte message does not fit the %d-byte line budget", len(data), budget)
		}
	}
}

// babelShrink gives up the least valuable part of an oversized event and reports
// whether it managed to. Each type sacrifices free text before structure and
// structure before identity: a progress event may lose its message, a result may
// lose its payload, but a tool-request never loses the request_id that makes it
// answerable. Every branch shrinks strictly, so writeLine's loop terminates.
func babelShrink(v any, over int) bool {
	switch ev := v.(type) {
	case *babelConfiguration:
		// The configuration is the one event with no expendable text, so the
		// only thing to give up is metadata beyond what a receipt needs.
		core := map[string]bool{"provider": true, "model": true, "thinking": true}
		for key := range ev.Metadata {
			if !core[key] {
				delete(ev.Metadata, key)
				return true
			}
		}
		for key, value := range ev.Metadata {
			if babelTrim(&value, over) {
				ev.Metadata[key] = value
				return true
			}
		}
		return false
	case *babelProgress:
		if ev.Resources != nil {
			ev.Resources = nil
			return true
		}
		return babelTrim(&ev.Message, over) || babelTrim(&ev.Stage, over)
	case *babelToolRequest:
		if babelTrim(&ev.Reason, over) {
			return true
		}
		return babelTruncateJSON(&ev.Arguments)
	case *babelResult:
		if ev.Resources != nil {
			ev.Resources = nil
			return true
		}
		return babelTruncateJSON(&ev.Payload)
	case *babelError:
		return babelTrim(&ev.Message, over)
	}
	return false
}

// babelTrim cuts over bytes off the end of *p and marks the cut, guaranteeing a
// strictly shorter string so a caller can loop on it. It reports false only when
// there is nothing left to give.
func babelTrim(p *string, over int) bool {
	old := *p
	if old == "" {
		return false
	}
	keep := len(old) - over - len(babelTruncationMarker)
	if keep < 0 {
		keep = 0
	}
	for keep > 0 && !utf8.RuneStart(old[keep]) {
		keep--
	}
	next := ""
	if keep > 0 {
		next = old[:keep] + babelTruncationMarker
	}
	if len(next) >= len(old) {
		next = ""
	}
	*p = next
	return true
}

// babelTruncateJSON replaces an oversized JSON document with a note of what was
// dropped. Babel hands tool arguments to its authorizer and records only their
// digest, so a truncated argument changes what the authorizer sees — which is
// still better than a line Babel rejects outright, and the note says so on the
// wire rather than pretending the document was small.
func babelTruncateJSON(p *json.RawMessage) bool {
	if len(*p) == 0 {
		return false
	}
	if bytes.Contains(*p, []byte(`"babel.truncated"`)) {
		*p = nil
		return true
	}
	note := json.RawMessage(fmt.Sprintf(`{"babel.truncated":true,"original_bytes":%d}`, len(*p)))
	if len(note) >= len(*p) {
		*p = nil
		return true
	}
	*p = note
	return true
}

// ── inbound ──────────────────────────────────────────────────────────────────

// readSync reads one line during the handshake, before the pump owns stdin.
func (s *babelSession) readSync() ([]byte, error) {
	if !s.scan.Scan() {
		if err := s.scan.Err(); err != nil {
			return nil, err
		}
		return nil, io.EOF
	}
	line := make([]byte, len(s.scan.Bytes()))
	copy(line, s.scan.Bytes())
	return line, nil
}

// startPump hands stdin to one goroutine for the rest of the run. It closes
// stdinDone when stdin ends, which is how a cancellation reaches an
// investigation that is not currently waiting for a decision: Babel closes this
// process's stdin as it tears the run down.
func (s *babelSession) startPump() {
	go func() {
		defer close(s.stdinDone)
		defer close(s.inbound)
		for {
			line, err := s.readSync()
			if err != nil {
				if !errors.Is(err, io.EOF) {
					s.inbound <- babelInbound{err: err}
				}
				return
			}
			s.inbound <- babelInbound{line: line}
		}
	}()
}

// nextLine returns the next line Babel wrote, or the reason there will not be
// one. A cancelled context wins over a line that may never arrive.
func (s *babelSession) nextLine() ([]byte, error) {
	select {
	case in, ok := <-s.inbound:
		if !ok {
			return nil, io.EOF
		}
		if in.err != nil {
			return nil, in.err
		}
		return in.line, nil
	case <-s.ctx.Done():
		return nil, s.ctx.Err()
	}
}

// babelMessageType reads just the type of an inbound line, so a message can be
// dispatched before it is decoded into a shape that may not fit it.
func babelMessageType(line []byte) (string, error) {
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(line, &probe); err != nil {
		return "", fmt.Errorf("undecodable line: %w", err)
	}
	return probe.Type, nil
}

// ── handshake ────────────────────────────────────────────────────────────────

// babelRefusal reports that Babel refused this worker. A refused worker emits
// nothing further and exits rather than waiting for a job that will never
// arrive.
type babelRefusal struct {
	reason    string
	supported []int
}

func (r *babelRefusal) Error() string {
	if len(r.supported) == 0 {
		return "refused by babel: " + r.reason
	}
	return fmt.Sprintf("refused by babel: %s (babel supports %v)", r.reason, r.supported)
}

// handshake writes hello and reads Babel's answer. hello goes out before the
// first read, so an incompatible counterpart is refused before any job material
// reaches this process.
func (s *babelSession) handshake() error {
	hello := babelHello{
		Type:     babelMessageHello,
		Protocol: babelProtocolName,
		Versions: []int{babelProtocolVersion},
		Modes:    []string{babelModeConfigure, babelModeWorker},
		Worker:   babelIdentity{Name: babelWorkerName, Version: babelWorkerVersion()},
	}
	if err := s.writeLine(&hello); err != nil {
		return fmt.Errorf("writing hello: %w", err)
	}

	line, err := s.readSync()
	if err != nil {
		return fmt.Errorf("reading babel's answer: %w", err)
	}
	kind, err := babelMessageType(line)
	if err != nil {
		return err
	}
	switch kind {
	case babelMessageRefuse:
		var refuse babelRefuse
		if err := json.Unmarshal(line, &refuse); err != nil {
			return fmt.Errorf("undecodable refusal: %w", err)
		}
		return &babelRefusal{reason: refuse.Reason, supported: refuse.Supported}
	case babelMessageAccept:
		// Unknown fields inside a known version are never fatal, which is
		// exactly what encoding/json does by default here.
		var accept babelAccept
		if err := json.Unmarshal(line, &accept); err != nil {
			return fmt.Errorf("undecodable accept: %w", err)
		}
		if accept.Protocol != babelProtocolName {
			return fmt.Errorf("accept names protocol %q, not %q", accept.Protocol, babelProtocolName)
		}
		if accept.Version != babelProtocolVersion {
			return fmt.Errorf("accept names version %d, which this build does not speak", accept.Version)
		}
		switch accept.Mode {
		case babelModeConfigure, babelModeWorker:
		default:
			return fmt.Errorf("accept names mode %q, which this worker did not advertise", accept.Mode)
		}
		// MaxLineBytes, MaxEvents and MaxToolRequests are budgets this worker
		// spends and therefore has to enforce on itself. IdleSeconds and
		// ExitGraceSecs are Babel's timers on this process, not allowances to
		// ration, so they are recorded and deliberately not acted on: closing
		// stdin is what Babel does when either expires, and that is already the
		// signal this worker tears down on.
		s.mode, s.limits = accept.Mode, accept.Limits
		if s.limits.MaxLineBytes <= 0 {
			s.limits.MaxLineBytes = babelDefaultMaxLineBytes
		}
		return nil
	default:
		return fmt.Errorf("expected accept or refuse, got %q", kind)
	}
}

// ── the event stream ─────────────────────────────────────────────────────────

// event writes one stream event, enforcing the ordering Babel checks. A bug in
// an investigator therefore cannot produce an invalid stream: it produces an
// error here instead, which becomes this run's terminal event.
func (s *babelSession) event(kind string, build func(seq int, at time.Time) any) error {
	if s.terminal != "" {
		return fmt.Errorf("%s after the %s event", kind, s.terminal)
	}
	terminal := kind == babelMessageResult || kind == babelMessageError
	switch {
	case kind == babelMessageConfiguration:
		if s.configured {
			return errors.New("a second configuration event")
		}
	case kind == babelMessageError:
		// An error is the one event Babel accepts before a configuration: a run
		// that fails while resolving the profile — or before an investigator
		// exists to resolve it — still owes a terminal event, and owing one it
		// cannot deliver would leave Babel waiting for a stream that ended.
	case !s.configured:
		return fmt.Errorf("%s before the resolved configuration", kind)
	}
	if budget := s.limits.MaxEvents; budget > 0 {
		// One slot is held back for the terminal event: a run that spent its
		// whole budget on progress could not report how it ended.
		reserve := 1
		if terminal {
			reserve = 0
		}
		if s.events+reserve >= budget {
			return fmt.Errorf("the %d-event budget is exhausted", budget)
		}
	}
	at := time.Now().UTC()
	if err := s.writeLine(build(s.nextSeq(), at)); err != nil {
		return err
	}
	s.events++
	switch {
	case kind == babelMessageConfiguration:
		s.configured = true
	case terminal:
		s.terminal = kind
	}
	return nil
}

// emitConfiguration writes the resolved configuration: the first event of the
// run and the one Babel builds its receipt around.
func (s *babelSession) emitConfiguration(cfg babelConfiguration) error {
	return s.event(babelMessageConfiguration, func(seq int, at time.Time) any {
		out := cfg
		out.Type, out.Seq, out.Time = babelMessageConfiguration, seq, &at
		return &out
	})
}

// emitProgress is the investigator's progress callback. It cannot return an
// error — an investigator has nothing useful to do with one — so a failure is
// recorded and ends the run with an error event instead.
func (s *babelSession) emitProgress(stage, message string, fraction float64) {
	err := s.event(babelMessageProgress, func(seq int, at time.Time) any {
		return &babelProgress{
			Type: babelMessageProgress, Seq: seq, Time: &at,
			Stage: stage, Message: message, Fraction: fraction,
		}
	})
	if err != nil {
		s.markFatal("progress: %v", err)
	}
}

func (s *babelSession) emitResult(result babelResult) error {
	if result.Status == "" {
		result.Status = babelStatusOK
	}
	if result.Schema == "" {
		result.Schema = babelResultSchema
	}
	return s.event(babelMessageResult, func(seq int, at time.Time) any {
		out := result
		out.Type, out.Seq, out.Time = babelMessageResult, seq, &at
		return &out
	})
}

func (s *babelSession) emitError(code, message string, retryable bool) error {
	return s.event(babelMessageError, func(seq int, at time.Time) any {
		return &babelError{
			Type: babelMessageError, Seq: seq, Time: &at,
			Code: code, Message: message, Retryable: retryable,
		}
	})
}

// markFatal records the first protocol violation seen where no error could be
// returned, and cancels the run so the investigation stops rather than piling
// more events onto a stream that is already broken.
func (s *babelSession) markFatal(format string, args ...any) {
	if s.fatal == nil {
		s.fatal = errors.New(s.scrubString(fmt.Sprintf(format, args...)))
	}
	s.cancel()
}

// requestTool asks Babel for evidence and blocks until it decides. It is the
// callback handed to an investigator, so its signature cannot carry a context or
// an error: cancellation comes from the session's context and a protocol
// violation is recorded with markFatal.
//
// A denial — whether Babel's or this worker's own budget guard — returns to the
// caller as a denial. It must not end the run.
func (s *babelSession) requestTool(capability, tool, reason string, arguments json.RawMessage) babelDecision {
	deny := func(code, why string) babelDecision {
		return babelDecision{
			Type: babelMessageToolDecision, Decision: babelDecisionDeny,
			Code: code, Reason: s.scrubString(why),
		}
	}
	if s.fatal != nil {
		return deny("protocol", "the run is already failing: "+s.fatal.Error())
	}
	if budget := s.limits.MaxToolRequests; budget > 0 && s.requests >= budget {
		// Babel would deny this with "limit" anyway; refusing here keeps the
		// event stream inside the budget it accepted.
		return deny("limit", fmt.Sprintf("this run's %d tool requests are spent", budget))
	}
	s.requests++
	id := fmt.Sprintf("t-%d", s.requests)

	err := s.event(babelMessageToolRequest, func(seq int, at time.Time) any {
		return &babelToolRequest{
			Type: babelMessageToolRequest, Seq: seq, Time: &at,
			RequestID: id, Capability: capability, Tool: tool,
			Arguments: arguments, Reason: reason,
		}
	})
	if err != nil {
		s.markFatal("tool-request %s: %v", id, err)
		return deny("protocol", err.Error())
	}
	s.issued[id] = true

	for {
		line, err := s.nextLine()
		if err != nil {
			s.markFatal("tool-request %s: waiting for a decision: %v", id, err)
			return deny("protocol", "no decision arrived")
		}
		kind, err := babelMessageType(line)
		if err != nil {
			s.markFatal("tool-request %s: %v", id, err)
			return deny("protocol", "undecodable decision")
		}
		if kind != babelMessageToolDecision {
			s.markFatal("tool-request %s: expected a tool-decision, got %q", id, kind)
			return deny("protocol", "unexpected message while awaiting a decision")
		}
		var decision babelDecision
		if err := json.Unmarshal(line, &decision); err != nil {
			s.markFatal("tool-request %s: undecodable tool-decision: %v", id, err)
			return deny("protocol", "undecodable decision")
		}
		if decision.RequestID == id {
			// The request is answered; a second decision naming it is a
			// violation, which is what leaving it in issued detects.
			return decision
		}
		// A decision naming a request this worker never made, or one it has
		// already had answered, means the two sides disagree about the stream.
		// There is nothing to adapt to, so the run fails.
		what := "a request this worker never made"
		if s.issued[decision.RequestID] {
			what = "a request that was already answered"
		}
		s.markFatal("tool-decision for %q names %s while %s was outstanding", decision.RequestID, what, id)
		return deny("protocol", "a decision named the wrong request")
	}
}

// ── run ──────────────────────────────────────────────────────────────────────

func (s *babelSession) run(ctx context.Context, opts babelOptions) int {
	if err := s.handshake(); err != nil {
		s.diag("%v", err)
		var refusal *babelRefusal
		if errors.As(err, &refusal) {
			return 3
		}
		return 2
	}
	switch s.mode {
	case babelModeConfigure:
		return s.runConfigure(opts)
	default:
		return s.runWorker(ctx, opts)
	}
}

// runConfigure resolves Code's dials, saves the profile, and reports the
// reference. It emits exactly one message and needs no seq: there is no stream
// to order. Nothing is launched.
func (s *babelSession) runConfigure(opts babelOptions) int {
	profile, err := babelResolveProfile(opts)
	if err != nil {
		s.diag("configure: %v", err)
		return 1
	}
	cfg := profile.configuration(babelWorkerCapabilities())
	if err := s.writeLine(&cfg); err != nil {
		s.diag("configure: writing the configuration: %v", err)
		return 1
	}
	s.diag("configured profile %s@%d (%s)", profile.ID, profile.Revision, profile.digest())
	return 0
}

// runWorker runs one analysis job to a terminal event.
func (s *babelSession) runWorker(parent context.Context, opts babelOptions) int {
	s.ctx, s.cancel = context.WithCancel(parent)
	defer s.cancel()
	s.startPump()
	// Babel closes this process's stdin as it tears a run down, so stdin's end
	// is a cancellation in its own right — and the only one an investigation
	// that is not waiting for a decision would otherwise notice.
	go func() {
		select {
		case <-s.stdinDone:
			s.cancel()
		case <-s.ctx.Done():
		}
	}()

	job, err := s.readJob()
	if err != nil {
		s.diag("worker: reading the job: %v", err)
		return 2
	}
	// From here on the broker credential exists in this process, so everything
	// written is scrubbed.
	s.secrets = job.secrets()

	inv := newInvestigator()
	if opts.investigator == babelInvestigatorConformance {
		inv = conformanceInvestigator{}
	}
	if inv == nil {
		return s.fail(babelErrInvestigator,
			"this build has no investigator wired in, so worker mode has nothing to run", false)
	}

	// Containment is declared before any job material is used: Babel refuses an
	// insufficient declaration, and there is no point resolving a profile for a
	// run that cannot start.
	containment := inv.containment()
	if strings.TrimSpace(containment.Backend) == "" {
		return s.fail(babelErrContainment, "the investigator declared no sandbox backend", false)
	}
	if strings.TrimSpace(containment.Escape) == "" {
		return s.fail(babelErrContainment,
			"the investigator declared no escape assumption, and a sandbox with no stated residual risk has not been examined", false)
	}

	// A conformance job names a profile no store will ever hold, so it takes the
	// synthetic path when the investigator offers one. Every real run goes
	// through resolve, which is resolve-or-fail.
	var cfg babelConfiguration
	if synthetic, ok := inv.(syntheticResolver); ok && job.conformanceRequested() {
		cfg = synthetic.syntheticConfiguration(job)
	} else {
		resolved, err := inv.resolve(s.ctx, job.Profile)
		if err != nil {
			return s.fail(babelErrProfileUnavailable, s.scrubString(err.Error()), false)
		}
		cfg = resolved
	}
	// Babel requires the configuration to name the profile the job named, and
	// checking it here means an investigator that resolves the wrong profile
	// fails visibly instead of producing a stream Babel rejects.
	if cfg.Profile != job.Profile {
		return s.fail(babelErrProfileUnavailable, fmt.Sprintf(
			"the job named profile %s@%d but the investigator resolved %s@%d",
			job.Profile.ID, job.Profile.Revision, cfg.Profile.ID, cfg.Profile.Revision), false)
	}
	cfg.Containment = &containment
	if err := s.emitConfiguration(cfg); err != nil {
		s.diag("worker: %v", err)
		return 2
	}

	result, invErr := inv.investigate(s.ctx, job, s.emitProgress, s.requestTool)

	switch {
	case s.fatal != nil:
		// A protocol violation outranks whatever the investigation returned:
		// its outcome was produced against a stream that had already broken.
		return s.fail(babelErrInternal, s.fatal.Error(), false)
	case s.ctx.Err() != nil:
		// Babel cancelled and is about to kill this tree. A terminal event is
		// still owed, so it is written best-effort before exiting.
		return s.fail(babelErrInternal, "the run was cancelled", true)
	case invErr != nil:
		return s.fail(babelErrInvestigator, s.scrubString(invErr.Error()), false)
	}
	if err := s.emitResult(result); err != nil {
		s.diag("worker: %v", err)
		return 2
	}
	return 0
}

// fail writes the run's terminal error event. Babel accepts an error as the
// first event, so this is usable before a configuration was ever resolved.
func (s *babelSession) fail(code, message string, retryable bool) int {
	if err := s.emitError(code, message, retryable); err != nil {
		s.diag("could not report %s: %v", code, err)
		return 2
	}
	s.diag("%s: %s", code, message)
	return 1
}

// readJob reads the one job Babel writes after accept. Top-level fields this
// build does not define are preserved in Extra, so a newer Babel can add one
// without this worker losing it.
func (s *babelSession) readJob() (babelJob, error) {
	line, err := s.nextLine()
	if err != nil {
		return babelJob{}, err
	}
	kind, err := babelMessageType(line)
	if err != nil {
		return babelJob{}, err
	}
	if kind != babelMessageJob {
		return babelJob{}, fmt.Errorf("expected a job, got %q", kind)
	}
	var job babelJob
	if err := json.Unmarshal(line, &job); err != nil {
		return babelJob{}, fmt.Errorf("undecodable job: %w", err)
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(line, &all); err != nil {
		return babelJob{}, fmt.Errorf("undecodable job: %w", err)
	}
	for name := range babelJobFields() {
		delete(all, name)
	}
	if len(all) > 0 {
		job.Extra = all
	}
	return job, nil
}

// babelJobFields is the set of top-level job field names this build defines,
// read from the struct tags so the list cannot drift from the contract.
var babelJobFields = func() func() map[string]struct{} {
	var once sync.Once
	var fields map[string]struct{}
	return func() map[string]struct{} {
		once.Do(func() {
			t := reflect.TypeOf(babelJob{})
			fields = make(map[string]struct{}, t.NumField())
			for i := range t.NumField() {
				name, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ",")
				if name == "" || name == "-" {
					continue
				}
				fields[name] = struct{}{}
			}
		})
		return fields
	}
}()

// ── dials ────────────────────────────────────────────────────────────────────

// babelCatalogModel builds the dial model from Code's own state — the catalog,
// the runtime targets and the persisted selection — with none of the TUI's
// transient fields. Everything below reads dials through it, so a profile is
// resolved and later replayed against the same construction the interactive run
// uses.
//
// providersResolved stays false: credential discovery is a live probe the TUI
// runs against OMP, and a worker under Babel must not silently move a dial
// because a credential happened to be missing at that instant. The catalog's own
// clamping still applies.
func babelCatalogModel() model {
	glyphs := defaultGlyphs()
	catalogPath := os.Getenv("CODE_GENERATED")
	if catalogPath == "" {
		catalogPath = defaultCatalogPath()
	}
	generated := loadBlocks(catalogPath)
	runtimeTargets := loadRuntimeTargets()
	facets := facetDefs(glyphs)
	if len(runtimeTargets) > 0 {
		facets = append([]facet{runtimeFacet(glyphs["runtime"], runtimeTargets)}, facets...)
	}
	selection := loadSelectionState(os.Getenv("CODE_SELECTION_STATE"), facets)
	if len(runtimeTargets) > 0 {
		if _, ok := selection["runtime"]; !ok {
			selection["runtime"] = "hosted"
		}
	}
	m := model{
		generated:      generated,
		advisors:       parseAdvisors(generated["__advisors__"]),
		facts:          parseFacts(generated["__models__"]),
		glyphs:         glyphs,
		runtimeTargets: runtimeTargets,
		facets:         facets,
		sel:            selection,
	}
	m.applyCatalog()
	return m
}

// babelResolveDials resolves Code's dials without a terminal, in the order
// --set, then the persisted selection, then Code's defaults, and clamps the
// result to what the catalog can actually serve.
//
// Configure mode is non-interactive on purpose. Code's dial UI is a Bubble Tea
// TUI mounted through clikit.Run, which takes stdin and stdout unconditionally
// and offers no way to redirect them; under Babel those two file descriptors are
// the protocol. Driving the TUI on /dev/tty instead would mean rebuilding main's
// app construction against a raw tea.NewProgram, diverging from the path every
// interactive run takes — and it would still be the wrong shape, because Babel
// spawns this process with pipes and no controlling terminal, so a mode that
// needed one would hang in exactly the environment it exists for.
//
// So the dials are resolved from the same three sources the TUI seeds itself
// from, through the same validity rules (repairSelectionSpecials, clampSel). An
// operator who wants to turn a dial interactively runs `code`, which persists
// the selection; configure mode then reports it. A run with no catalog and no
// persisted state still resolves — to Code's defaults — rather than failing or
// waiting for input.
func babelResolveDials(sets map[string]string) (model, error) {
	m := babelCatalogModel()

	for key, value := range sets {
		known := false
		for _, f := range m.facets {
			if f.key != key {
				continue
			}
			for _, candidate := range f.values {
				if candidate == value {
					known = true
					break
				}
			}
			if !known {
				return model{}, fmt.Errorf("dial %s has no value %q (have %s)",
					key, value, strings.Join(f.values, ", "))
			}
			break
		}
		if !known {
			return model{}, fmt.Errorf("no dial named %q", key)
		}
		m.sel[key] = value
	}
	// The same repairs a persisted selection goes through: a special-tier dial
	// the chosen lane cannot host is forced off, and the catalog gets the last
	// word on every dial it does not serve.
	repairSelectionSpecials(m.sel)
	m.clampSel()
	return m, nil
}

// babelResolveProfile resolves the dials, describes them the way Babel records
// them, and saves the result as a profile revision.
func babelResolveProfile(opts babelOptions) (codeProfile, error) {
	m, err := babelResolveDials(opts.sets)
	if err != nil {
		return codeProfile{}, err
	}
	profile := babelDescribeDials(m, opts.profileID)
	saved, err := newProfileStore("").save(profile)
	if err != nil {
		return codeProfile{}, err
	}
	return saved, nil
}

// babelDescribeDials turns a resolved selection into the profile Babel records.
// Everything here is non-secret by construction: the provider credential lives
// in the central broker and the vault and is never part of a selection.
func babelDescribeDials(m model, id string) codeProfile {
	rows := m.currentRows()
	metadata := map[string]string{
		"lane":     m.sel["lane"],
		"tier":     m.sel["model"],
		"thinking": m.sel["thinking"],
		"advisor":  m.sel["advisor"],
		"combo":    comboID(m.sel, m.hasRelief),
	}
	disclosure := babelDisclosureHosted
	if target, ok := m.selectedRuntime(); ok {
		// A delegated local runtime keeps material on this machine, which is a
		// different disclosure class than a provider API.
		disclosure = babelDisclosureLocal
		metadata["runtime"] = target.Name
		metadata["provider"] = target.Name
		metadata["model"] = target.Name
	}
	if lead := babelLeadModel(m, rows); lead != "" {
		metadata["model"] = lead
		if pool := m.poolOfModel(lead); pool != "" {
			if provider := providerByPool(pool); provider != nil {
				metadata["provider"] = provider.ID
			}
		}
	}
	if metadata["provider"] == "" {
		// An empty catalog resolves dials but no chain, so there is no provider
		// to name. Saying so is honest; guessing one would not be.
		metadata["provider"] = "unresolved"
	}
	if metadata["model"] == "" {
		metadata["model"] = "unresolved"
	}
	return codeProfile{
		ID:         id,
		Selection:  m.sel,
		ComboID:    comboID(m.sel, m.hasRelief),
		Disclosure: disclosure,
		// Material that leaves this machine for a provider API has to be
		// redacted before it goes; material a local runtime handles does not.
		RedactionRequired: disclosure == babelDisclosureHosted,
		Cost:              babelDialCost(m, rows),
		Metadata:          metadata,
	}
}

// babelLeadModel names the model the default agent role runs, which is the one a
// receipt means by "the model this profile uses".
func babelLeadModel(m model, rows []string) string {
	lead := ""
	m.weightedModels(rows, func(_ float64, id, _ string) {
		if lead == "" {
			lead = id
		}
	})
	for _, row := range rows {
		fields := strings.Fields(strings.ReplaceAll(row, "→", " "))
		if len(fields) > 0 && fields[0] == "●" {
			fields = fields[1:]
		}
		if len(fields) == 0 || fields[0] != "default" {
			continue
		}
		for _, token := range fields[1:] {
			if modelRe.MatchString(token) {
				id, _, _ := strings.Cut(token, ":")
				return id
			}
		}
	}
	return lead
}

// babelDialCost is the profile's own cost estimate, not a measurement: the
// catalog's per-model prices ($/1M tokens) weighted by the token volume each
// role drives, which is the same basis the cost meter reads. EstimatedRun stays
// zero because a run's size is a property of the job, which a profile cannot
// know — and Babel treats the estimate as the profile's claim, so inventing one
// would be a claim Code has no basis for.
func babelDialCost(m model, rows []string) babelCost {
	var inNum, outNum, den float64
	m.weightedModels(rows, func(weight float64, id, level string) {
		fact, ok := m.facts[id]
		if !ok {
			return
		}
		mult, ok := thinkMult[level]
		if !ok {
			mult = 1
		}
		inNum += weight * fact.in * mult
		outNum += weight * fact.out * mult
		den += weight
	})
	cost := babelCost{Currency: "USD"}
	if den == 0 {
		return cost
	}
	// The catalog prices per million tokens; the wire is per thousand.
	cost.InputPer1K = inNum / den / 1000
	cost.OutputPer1K = outNum / den / 1000
	return cost
}

// profileOverlay renders the omp config overlay a saved profile launches with —
// the same document the TUI's Enter key hands to omp, rebuilt from the stored
// selection rather than from whatever the dials happen to read now. An
// investigator that launches OMP needs this and must not reconstruct it: the
// overlay is the profile, and two renderings of it would drift.
//
// A catalog that no longer generates the profile's combination is an error rather
// than an empty overlay. genConfigYAML would happily walk a missing block and
// emit a modelRoles map with no routing at all, handing omp a session that
// silently runs on its own defaults — the same trap update.go guards Enter
// against.
//
// The omp version is unknown here (nothing probes it in a worker), so the
// omp ≥ 17.3 advisor key is omitted. That is the safe direction by design: an
// older omp hard-errors on the unknown key, and a newer one simply does not get
// the audit-tier agent advisor.
func profileOverlay(p codeProfile) (string, error) {
	if len(p.Selection) == 0 {
		return "", fmt.Errorf("profile %s@%d saved no selection to render", p.ID, p.Revision)
	}
	m := babelCatalogModel()
	m.sel = make(map[string]string, len(p.Selection))
	for key, value := range p.Selection {
		m.sel[key] = value
	}
	combo := comboID(m.sel, m.hasRelief)
	if _, ok := m.generated[combo]; !ok {
		return "", fmt.Errorf("profile %s@%d selects combination %s, which this catalog does not generate",
			p.ID, p.Revision, combo)
	}
	return m.genConfigYAML(), nil
}

// ── the conformance stub ─────────────────────────────────────────────────────

// conformanceInvestigator produces each state Babel's conformance suite needs to
// observe, and no analysis whatsoever. It exists because the obligations that
// matter most — that a denial does not end a run, that no result follows an
// error, that cancellation is prompt — cannot be graded unless the worker can be
// asked to reach those states, and grading them must not require OMP, a provider
// credential or a corpus.
//
// It is reachable only through --investigator=conformance. Nothing it returns is
// evidence about anything.
type conformanceInvestigator struct{}

// containment describes the stub, not Code. The declaration is maximal because
// the stub executes nothing at all — no subprocess, no filesystem write, no
// network — which is the one case where every claim is trivially true. Escape
// says so, because a reviewer reading this in a receipt must not mistake it for
// a statement about the sandbox real analysis runs in.
func (conformanceInvestigator) containment() babelContainment {
	return babelContainment{
		Backend:             "none (conformance stub: no analysis is executed)",
		FilesystemIsolation: true,
		NetworkDefaultDeny:  true,
		ResourceCeilings:    true,
		Disposable:          true,
		Escape: "this stub runs no analysis, so it contains nothing and this " +
			"declaration is evidence about the protocol only, never about the " +
			"boundary a real investigation runs behind",
	}
}

// resolve is strict, like every investigator's: this stub owns no store, so
// there is no profile it can resolve and saying otherwise would be claiming one
// it cannot back. The conformance path never reaches here — the protocol layer
// routes a conformance job to syntheticConfiguration — so this is what a real
// job handed to the stub by mistake gets, which is a refusal.
func (conformanceInvestigator) resolve(_ investigatorContext, ref babelProfileRef) (babelConfiguration, error) {
	return babelConfiguration{}, fmt.Errorf(
		"the conformance stub resolves no profile, so %s@%d is unavailable through it",
		ref.ID, ref.Revision)
}

// syntheticConfiguration is the exception the contract carves out for a
// conformance job: the suite names a synthetic profile on purpose so a worker
// with no store at all can still be graded, so the reference is echoed and the
// metadata describes the stub rather than any provider.
func (conformanceInvestigator) syntheticConfiguration(job babelJob) babelConfiguration {
	return babelConfiguration{
		Profile:      job.Profile,
		Privacy:      babelPrivacy{Disclosure: babelDisclosureLocal},
		Cost:         babelCost{Currency: "USD"},
		Capabilities: babelWorkerCapabilities(),
		Metadata: map[string]string{
			"provider":    "none",
			"model":       "conformance-stub",
			"thinking":    "none",
			"conformance": job.conformanceDirective(),
		},
	}
}

// conformanceReport is the stub's result payload. Decisions carries the verbatim
// decision values so Babel's suite can confirm the worker actually saw what it
// was told.
type conformanceReport struct {
	Directive  string   `json:"directive"`
	Decisions  []string `json:"decisions,omitempty"`
	DenyCodes  []string `json:"deny_codes,omitempty"`
	Recipes    int      `json:"recipes"`
	Sources    int      `json:"sources"`
	UnknownJob []string `json:"unknown_job_fields,omitempty"`
}

func (conformanceInvestigator) investigate(ctx investigatorContext, job babelJob,
	emit func(stage, message string, fraction float64),
	request func(capability, tool, reason string, arguments json.RawMessage) babelDecision,
) (babelResult, error) {
	directive := job.conformanceDirective()
	report := conformanceReport{
		Directive: directive,
		Recipes:   len(job.Recipes),
		Sources:   len(job.Sources),
	}
	for name := range job.Extra {
		report.UnknownJob = append(report.UnknownJob, name)
	}
	emit("discover", "reading the job", 0.25)

	switch directive {
	case babelConformanceErrorOnly:
		return babelResult{}, errors.New("conformance stub: the error-only directive fails on purpose")

	case babelConformanceSlow:
		// Slow enough for Babel to cancel mid-flight, and checked often enough
		// that the teardown is prompt when it does.
		for i := range 600 {
			select {
			case <-ctx.Done():
				return babelResult{}, ctx.Err()
			case <-time.After(50 * time.Millisecond):
			}
			if i%10 == 0 {
				emit("analyse", "still working", 0.5)
			}
		}

	case babelConformanceRequestTool, babelConformanceRequestUngranted:
		capability, tool := babelCapabilityCorpusSearch, "search"
		if directive == babelConformanceRequestUngranted {
			// Deliberately outside the suite's grant: the grant is the boundary
			// and Babel must deny this before any policy is consulted.
			capability, tool = babelCapabilitySandboxExec, "exec"
		}
		decision := request(capability, tool,
			"conformance stub: exercising the tool-request round trip",
			json.RawMessage(`{"query":"conformance"}`))
		report.Decisions = append(report.Decisions, decision.Decision)
		if decision.Code != "" {
			report.DenyCodes = append(report.DenyCodes, decision.Code)
		}
		// A denial is not a termination: the run carries on and still delivers
		// a terminal event.
		emit("adapt", "continuing after the decision", 0.75)
	}

	emit("report", "assembling the result", 1)
	payload, err := json.Marshal(report)
	if err != nil {
		return babelResult{}, err
	}
	return babelResult{
		Status:    babelStatusOK,
		Schema:    babelResultSchema,
		Payload:   payload,
		Resources: &babelResources{ToolCalls: len(report.Decisions)},
	}, nil
}
