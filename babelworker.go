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
//   - under a negotiated version 2, the resolved configuration — which carries
//     the containment declaration — is produced from the job's preamble alone,
//     because the recipes, the grant, the sources and the broker token are the
//     stage Babel writes in answer to it (atyrode/babel#71). Nothing above
//     emitConfiguration may need them, and nothing below may assume they
//     arrived: a declaration a version 2 Babel will not accept is answered
//     with a refusal instead of the material. A negotiated version 1 writes
//     the whole document before this worker declares anything, which is the
//     exposure version 2 exists to close (babelwire.go);
//   - every line written fits the accepted line budget, because an oversized
//     line is a protocol violation rather than a large message;
//   - the job's broker credential is scrubbed out of every byte this process
//     writes to stdout or stderr, from the moment the stage carrying it is read.
//
// A denial is not a failure. Babel denies a tool request that falls outside the
// run's grant before it consults any policy, so asking for something Code was
// not granted is a normal outcome the investigation adapts to — it returns to the
// caller as a denial and the run still delivers a terminal event.
//
// Exit status: 0 after a result, 1 after an error event, 2 when the protocol
// itself broke, 3 when Babel refused this worker — at the handshake, or by
// declining the containment it declared. Babel owns the run's final status
// either way, so these are for an operator reading a shell, not for Babel.

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

// babelStoreSource adapts the profile store to the narrow source the OMP
// investigator depends on. It lives here because it is the only code that names
// types from both sides: the store's codeProfile and the driver's
// resolvedProfile. The driver deliberately knows nothing about how profiles are
// stored, named or versioned.
//
// The reference, disclosure, cost and metadata come from the profile's own
// configuration rendering rather than being re-derived here, so there is one
// place that decides what a saved profile reports to Babel.
type babelStoreSource struct{ store *profileStore }

func (s babelStoreSource) resolveProfile(id string, revision int) (resolvedProfile, error) {
	profile, err := s.store.load(id, revision)
	if err != nil {
		return resolvedProfile{}, err
	}
	overlay, err := profileOverlay(profile)
	if err != nil {
		return resolvedProfile{}, err
	}
	rendered := profile.configuration(nil)
	return resolvedProfile{
		Ref:        rendered.Profile,
		Disclosure: rendered.Privacy.Disclosure,
		Cost:       rendered.Cost,
		Metadata:   rendered.Metadata,
		ConfigYAML: overlay,
	}, nil
}

// newInvestigator selects the investigator worker mode drives. This is the one
// place OMP is wired in: the driver lives in its own file, implements the
// investigator interface from babelwire.go, and reaches the profile store only
// through the adapter above.
//
// The conformance stub answers like an investigator without analysing anything,
// which is exactly what a receipt must never contain by accident, so it stays
// reachable only through an explicit --investigator=conformance.
func newInvestigator() investigator {
	return newOmpInvestigator(babelStoreSource{store: newProfileStore("")})
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

// credentialResolver is the investigator that must authenticate a provider
// before it can run anything. Worker mode asks it to do so before any job
// material becomes a launch, and adds whatever secrets that produced to the set
// every byte this process writes is scrubbed against.
//
// The registration matters at least as much as the resolution. A job secret is
// scrubbed because Babel handed it over; the provider credential is Code's own
// and Babel never sees it — but the moment it is handed to a child, that
// child's diagnostics become something this worker forwards, and an OMP stderr
// tail is exactly how a failed run gets explained. Registering the credential
// closes that route with the mechanism already guarding the other one.
//
// It is given the profile the job named because whether a credential is needed
// at all is a property of that profile: a local-lane profile runs against an
// endpoint on this machine that takes no key (locallane.go), and refusing such
// a run for want of a broker would refuse the one configuration that cannot
// need one. Nothing else about the profile is resolved here — that is resolve's
// job — and a reference this resolver cannot open leaves the credential
// required, which is the stricter answer.
//
// An investigator that does not implement this is never asked, which is what
// keeps the conformance stub gradeable on a machine with no provider at all.
type credentialResolver interface {
	resolveCredential(ref babelProfileRef) (secrets []string, err error)
}

// ── argv ─────────────────────────────────────────────────────────────────────

type babelOptions struct {
	profileID    string
	investigator string
	// configure and resultFile are the configuration ceremony, which is not a
	// protocol mode at all: --configure runs Code's dial UI on the terminal
	// Babel inherited to this process, and the reference the operator confirms
	// is written to resultFile (babelconfigure.go).
	configure  bool
	resultFile string
}

const babelHelp = `code babel — speak Babel's analysis-worker protocol on stdin/stdout

  code babel [--profile ID] [--investigator KIND]
  code babel --configure --result-file PATH [--profile ID]

      Babel (github.com/atyrode/babel) supervises this process as its analysis
      worker. The protocol is newline-delimited JSON: this process writes hello
      first, Babel replies accept or refuse, and the accepted mode decides what
      happens next. Nothing is read from a terminal and nothing is printed for a
      human — stdout is the protocol and stderr is diagnostics.

      Configure mode reports the profile revision the ceremony below minted, and
      exits without launching OMP. Worker mode runs one analysis job through the
      investigator. Neither resolves a dial: the configuration a run is
      attributed to is the one an operator confirmed, so a mode that could
      compute one for itself would be a mode that mints configurations nobody
      chose (atyrode/babel#86).

        --profile ID       profile to report or mint (default %s)
        --investigator K   worker-mode investigator. %s selects the
                           in-tree stub Babel's conformance suite grades; it
                           runs no analysis and must never do real work

  The ceremony:

        --configure        run Code's dial UI on the terminal on stdin/stdout —
                           the operator's own, inherited from Babel — and mint a
                           profile revision out of what they confirm. Refuses
                           without a terminal; there is no fallback, because a
                           fallback is what this replaces. Exits 0 after writing
                           the reference, and nonzero — which Babel reads as
                           "unchanged" — after a cancelled or failed one
        --result-file PATH where the confirmed reference is written, as
                           {"profile":"ID","revision":N}, mode 0600

      %s is not read in either mode, and no flag sets a dial.
      An environment variable and an argument are both channels an unattended
      process can reach, and a profile minted through either would carry an
      operator's authority without their knowledge. The dials come from the
      ceremony and nowhere else.

  Profiles: $XDG_STATE_HOME/code/babel/profiles, or %s
  Dials:    $XDG_STATE_HOME/code/selection.json — the ceremony opens on it and
            writes it back, exactly as an interactive "code" does.
`

func babelHelpText() string {
	return fmt.Sprintf(babelHelp, defaultBabelProfileID, babelInvestigatorConformance,
		codeSelectionStateEnv, babelProfileStateEnv)
}

// runBabel is the `code babel` subcommand.
func runBabel(args []string) int {
	opts := babelOptions{profileID: defaultBabelProfileID}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--profile":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "code babel: --profile needs an id")
				return 2
			}
			opts.profileID = args[i]
		case "--configure":
			opts.configure = true
		case "--result-file":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "code babel: --result-file needs a path")
				return 2
			}
			opts.resultFile = args[i]
		case "--set":
			// Refused, not ignored, and refused in every mode. A dial set from
			// argv mints a profile no operator confirmed, and Babel records that
			// profile in a receipt a reviewer trusts — so the flag that used to
			// do this now says where the dials come from instead of quietly
			// doing nothing (atyrode/babel#86).
			fmt.Fprintln(os.Stderr, "code babel: --set is refused: a dial is turned by an "+
				"operator in the configuration ceremony (`babel analysis profile configure`, "+
				"which runs `code babel --configure` on your terminal) and nowhere else")
			return 2
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
	if opts.resultFile != "" && !opts.configure {
		fmt.Fprintln(os.Stderr, "code babel: --result-file is only answered by --configure")
		return 2
	}
	// The ceremony owns stdin and stdout as a terminal, so it is dispatched
	// before anything that would treat them as the protocol. It handles its own
	// interruption: Bubble Tea reads the keys, and ctrl+c there is a cancelled
	// ceremony rather than a signal this process has to translate.
	if opts.configure {
		return runBabelConfigure(opts)
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
	// version is the protocol version accept named, out of what hello offered
	// (babelSupportedVersions). It decides which of the two job-document shapes
	// runWorker speaks: 2 stages it, 1 writes the whole thing up front.
	version int

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
//
// Resource use is given up last, after the payload has already been reduced to a
// truncation note. It is a few dozen bytes and it is a measurement: this worker
// declares that it bounds its own resources, and a bound is only a bound if the
// usage it bounded is reported, so trading the whole claim away to save a
// fraction of what an oversized payload costs would buy line budget with the
// integrity of the receipt. It is still expendable rather than sacred — a line
// that cannot be sent at all is worse — which is why it goes last and not never.
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
		if babelTrim(&ev.Message, over) || babelTrim(&ev.Stage, over) {
			return true
		}
		if ev.Resources != nil {
			ev.Resources = nil
			return true
		}
		return false
	case *babelToolRequest:
		if babelTrim(&ev.Reason, over) {
			return true
		}
		return babelTruncateJSON(&ev.Arguments)
	case *babelResult:
		if babelTruncateJSON(&ev.Payload) {
			return true
		}
		if ev.Resources != nil {
			ev.Resources = nil
			return true
		}
		return false
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
		Versions: babelSupportedVersions(),
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
		if !babelVersionSupported(accept.Version) {
			return fmt.Errorf("accept names version %d, which this build does not speak (offered %v)",
				accept.Version, babelSupportedVersions())
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
		s.mode, s.limits, s.version = accept.Mode, accept.Limits, accept.Version
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

// runConfigure reports the profile the ceremony minted. It emits exactly one
// message and needs no seq: there is no stream to order. Nothing is launched and
// nothing is resolved.
//
// That it only reports is the change atyrode/babel#86 made. This mode runs on
// pipes, with no operator to ask, so any configuration it produced by itself
// would be one nobody chose — resolved from an environment variable, an
// argument, or Code's compiled defaults. Babel's own `analysis profile
// configure` therefore no longer speaks this mode at all; it runs the ceremony
// (babelconfigure.go) on the operator's terminal. What is left here is the
// question Babel's conformance suite asks — "what are you configured as?" — and
// an unconfigured worker answers it by refusing rather than by inventing one.
func (s *babelSession) runConfigure(opts babelOptions) int {
	profile, err := babelStoredProfile(opts.profileID)
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

// runWorker runs one analysis job to a terminal event, in whichever of the two
// job-document shapes handshake negotiated (s.version).
//
// Under version 2 the job arrives in two stages and this worker's own
// configuration event sits between them (atyrode/babel#71): stage one carries
// the run's identity, the profile to resolve and the run's parameters; Babel
// writes stage two — the recipes, the grant, the sources and the run-scoped
// broker token — only after it has accepted the containment declared here, and
// a declaration it will not accept is answered with a refusal in place of the
// material. Under version 1 the whole document arrives before this worker
// declares anything, which is the exposure version 2 exists to close; this
// worker still runs it; it just declares nothing that ordering could have
// protected.
func (s *babelSession) runWorker(parent context.Context, opts babelOptions) int {
	s.ctx, s.cancel = context.WithCancel(parent)
	defer s.cancel()
	s.startPump()
	// Babel closes this process's stdin as it tears a run down, so stdin's end
	// is a cancellation in its own right — and the only one an investigation
	// that is not currently waiting for a decision would otherwise notice.
	go func() {
		select {
		case <-s.stdinDone:
			s.cancel()
		case <-s.ctx.Done():
		}
	}()

	if s.version <= 1 {
		return s.runWorkerV1(opts)
	}
	return s.runWorkerV2(opts)
}

// runWorkerV1 speaks the version 1 exchange: the whole job document arrives in
// one "job" message, so the containment declaration this worker's first event
// carries is produced from material it already holds in full — the run's
// credential included. This is what atyrode/babel#71 stopped doing for a
// version 2 counterpart; a version 1 one still gets it, at the same exposure
// version 1 always had.
func (s *babelSession) runWorkerV1(opts babelOptions) int {
	job, err := s.readJob()
	if err != nil {
		s.diag("worker: reading the job: %v", err)
		return 2
	}
	// From here on the broker credential exists in this process, so everything
	// written is scrubbed.
	s.secrets = job.secrets()

	inv, code, ok := s.declareAndConfigure(job, opts)
	if !ok {
		return code
	}
	return s.investigateAndFinish(inv, job)
}

// runWorkerV2 speaks the staged version 2 exchange: the preamble alone is
// enough to declare containment against, and the material — including the
// run's broker credential — arrives only once Babel has accepted that
// declaration (atyrode/babel#71).
func (s *babelSession) runWorkerV2(opts babelOptions) int {
	job, err := s.readPreamble()
	if err != nil {
		s.diag("worker: reading the job preamble: %v", err)
		return 2
	}

	inv, code, ok := s.declareAndConfigure(job, opts)
	if !ok {
		return code
	}

	// Stage two, or the refusal that replaces it. Everything the run needs to
	// do any work at all arrives here, which is why nothing above this line
	// could have read the corpus or reached the broker.
	job, err = s.readMaterial(job)
	if err != nil {
		var refused *babelRefusal
		switch {
		case errors.As(err, &refused):
			// Babel would not accept the declaration, so there is no run, and
			// no terminal event is owed for one: Babel is not reading for an
			// answer to a message it refused. It said why; this process says so
			// on stderr and leaves, rather than waiting for material it has just
			// been told is not coming.
			s.diag("worker: %v", err)
			return 3
		case errors.Is(err, io.EOF), s.ctx.Err() != nil:
			// Stdin ended while this worker was waiting for the material, which
			// is how Babel tears a run down. The declaration is already on the
			// wire, so this run has started as far as Babel is concerned and
			// owes exactly one terminal event; it is written best-effort before
			// exiting, the same way a cancellation mid-investigation is.
			return s.fail(babelErrInternal, "the run was cancelled before the job material arrived", true)
		default:
			// A material stage that could not be read at all: undecodable, the
			// wrong message, or a pairing from another run. The stream is live,
			// so the failure is reported on it rather than only on stderr.
			return s.fail(babelErrInternal, s.scrubString("the job material did not arrive: "+err.Error()), false)
		}
	}
	// From here on the broker credential exists in this process, so everything
	// written is scrubbed. The provider credential, if there was one, was added
	// to this list above.
	s.secrets = append(s.secrets, job.secrets()...)

	return s.investigateAndFinish(inv, job)
}

// declareAndConfigure is the part of running a job that version 1 and version 2
// share: pick the investigator, resolve the provider credential, resolve or
// synthesize the profile's configuration, declare containment and emit it as
// the run's first event. It is everything from the profile reference to
// emitConfiguration, on whatever job it is handed — a version 1 job already
// carries its recipes, grant, sources and broker token at this point; a
// version 2 job carries only what its preamble did, which is exactly what this
// step needs and no more.
//
// ok is false whenever the caller must return code immediately, which lets a
// caller stop without inspecting cfg or matching on error types itself.
func (s *babelSession) declareAndConfigure(job babelJob, opts babelOptions) (inv investigator, code int, ok bool) {
	inv = newInvestigator()
	if opts.investigator == babelInvestigatorConformance {
		inv = conformanceInvestigator{}
	}
	if inv == nil {
		return nil, s.fail(babelErrInvestigator,
			"this build has no investigator wired in, so worker mode has nothing to run", false), false
	}

	// The credential comes first: a run that cannot authenticate is refused
	// here rather than discovered three events later as an analysis that failed
	// for no stated cause. The profile goes with the question, because a
	// profile can be one that needs no credential. A conformance job is exempt
	// because it launches nothing — that exemption is what lets Babel grade a
	// worker on a machine with no provider.
	if resolver, okR := inv.(credentialResolver); okR && !job.conformanceRequested() {
		secrets, err := resolver.resolveCredential(job.Profile)
		if err != nil {
			// Not retryable: the credential is resolved out of the environment
			// and the HOME Babel spawned this worker with, and respawning it
			// resolves the same ones.
			return nil, s.fail(babelErrInvestigator, s.scrubString(err.Error()), false), false
		}
		// The provider credential is scrubbed from here on. It is not a job
		// secret — a version 2 job has not even sent its own yet — and it is
		// about to be handed to a child whose diagnostics this worker forwards.
		s.secrets = append(s.secrets, secrets...)
	}

	// A conformance job names a profile no store will ever hold, so it takes the
	// synthetic path when the investigator offers one. Every real run goes
	// through resolve, which is resolve-or-fail.
	var cfg babelConfiguration
	if synthetic, okS := inv.(syntheticResolver); okS && job.conformanceRequested() {
		cfg = synthetic.syntheticConfiguration(job)
	} else {
		resolved, err := inv.resolve(s.ctx, job.Profile)
		if err != nil {
			return nil, s.fail(babelErrProfileUnavailable, s.scrubString(err.Error()), false), false
		}
		cfg = resolved
	}
	// Babel requires the configuration to name the profile the job named, and
	// checking it here means an investigator that resolves the wrong profile
	// fails visibly instead of producing a stream Babel rejects.
	if cfg.Profile != job.Profile {
		return nil, s.fail(babelErrProfileUnavailable, fmt.Sprintf(
			"the job named profile %s@%d but the investigator resolved %s@%d",
			job.Profile.ID, job.Profile.Revision, cfg.Profile.ID, cfg.Profile.Revision), false), false
	}
	// Containment is declared here, after the profile and before the first
	// event, and the order is deliberate. An investigator's declaration is
	// about a boundary it establishes rather than a constant it holds, so
	// asking for it late means asking a backend that has been probed against
	// this machine and, for the OMP investigator, one that can name the
	// provider endpoint its egress will actually allow. Nothing is lost by
	// waiting: under version 2 the declaration is what Babel is waiting for
	// before it writes anything else, so a run whose profile is unavailable now
	// fails without having probed a sandbox it was never going to use.
	containment := inv.containment()
	if strings.TrimSpace(containment.Backend) == "" {
		return nil, s.fail(babelErrContainment, "the investigator declared no sandbox backend", false), false
	}
	if strings.TrimSpace(containment.Escape) == "" {
		return nil, s.fail(babelErrContainment,
			"the investigator declared no escape assumption, and a sandbox with no stated residual risk has not been examined", false), false
	}
	// The one directive that asks this worker to declare less than it provides.
	// Babel's refusal path decides whether the run's credential travels at all,
	// and it cannot be graded against a worker that always declares enough, so
	// the suite asks for a declaration it will then refuse. It is applied here
	// rather than inside an investigator because the directive is a fact about
	// the run, which is in the job, and the investigator seam is handed the
	// profile rather than the job (see syntheticResolver for the same reason).
	if job.conformanceDirective() == babelConformanceUnderDeclare {
		containment = babelUnderDeclaredContainment(containment.Backend)
	}
	// Containment and capabilities are the protocol layer's to attach. Neither
	// resolve nor syntheticConfiguration is given the run, so neither can state
	// what this worker will ask Babel for, and both left the list empty — which
	// Babel reads as a profile that can do nothing, then catches the moment the
	// run makes a request the profile never claimed. Configure mode already
	// reports exactly this list, so declaring it from the same function is what
	// keeps the two modes' answers the same claim rather than two that drift.
	cfg.Containment = &containment
	cfg.Capabilities = babelWorkerCapabilities()
	if err := s.emitConfiguration(cfg); err != nil {
		s.diag("worker: %v", err)
		return nil, 2, false
	}
	return inv, 0, true
}

// investigateAndFinish runs the job through inv to a terminal event, in the
// precedence version 1 and version 2 share: a protocol violation outranks
// whatever the investigation returned, cancellation outranks a reported error,
// and only then does the investigator's own outcome decide the exit status.
func (s *babelSession) investigateAndFinish(inv investigator, job babelJob) int {
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

// babelUnderDeclaredContainment is the declaration the under-declare directive
// asks for: everything a declaration must state, and none of the properties a
// sandboxed run requires. The backend name is the real one the investigator
// named, suffixed, so a receipt of such a run cannot be mistaken for a claim
// about the sandbox real analysis runs behind.
func babelUnderDeclaredContainment(backend string) babelContainment {
	return babelContainment{
		Backend:             backend + "-under-declared",
		FilesystemIsolation: false,
		NetworkDefaultDeny:  false,
		ResourceCeilings:    false,
		Disposable:          false,
		Escape: "under-declared on request: Babel's conformance suite asked for a declaration " +
			"short of a sandboxed run so that its refusal path could be graded. This run contains nothing.",
	}
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

// readJob reads the one job message a version 1 counterpart writes after
// accept: the whole document at once, which is what version 1 was before
// atyrode/babel#71 staged it for version 2. It exists so this build can still
// run a job for a Babel that negotiated version 1, and readStage and
// decodeJobStage are the same two calls readPreamble makes below — there is
// one job decoder either way, it is only ever called a different number of
// times.
func (s *babelSession) readJob() (babelJob, error) {
	line, kind, err := s.readStage()
	if err != nil {
		return babelJob{}, err
	}
	if kind != babelMessageJob {
		return babelJob{}, fmt.Errorf("expected a %s, got %q", babelMessageJob, kind)
	}
	return decodeJobStage(line, babelJob{})
}

// readPreamble reads stage one of the job document: the run's identity, the
// profile to resolve, and the parameters that say what kind of run this is.
// The Recipes, Grant, Sources and Broker fields of what it returns are zero —
// Babel has not written them yet, and will not until this worker has declared
// the sandbox it provides.
func (s *babelSession) readPreamble() (babelJob, error) {
	line, kind, err := s.readStage()
	if err != nil {
		return babelJob{}, err
	}
	if kind != babelMessageJobPreamble {
		return babelJob{}, fmt.Errorf("expected a %s, got %q", babelMessageJobPreamble, kind)
	}
	return decodeJobStage(line, babelJob{})
}

// readMaterial reads stage two into the job the preamble began: the recipes,
// the grant, the sources and the run-scoped broker token.
//
// A refusal here is not a malformed exchange. It is what Babel writes instead
// of the material when it will not accept the containment this worker declared,
// and it is returned as a *babelRefusal so the caller exits with the refused
// status rather than reporting a protocol failure the operator cannot act on.
//
// The two stages must name the same run. Nothing in the protocol pairs them
// otherwise, and a job assembled from two runs' halves would analyse one run's
// material under the other's identity — a receipt nobody wrote.
func (s *babelSession) readMaterial(preamble babelJob) (babelJob, error) {
	line, kind, err := s.readStage()
	if err != nil {
		return babelJob{}, err
	}
	switch kind {
	case babelMessageJob:
	case babelMessageRefuse:
		var refuse babelRefuse
		if err := json.Unmarshal(line, &refuse); err != nil {
			return babelJob{}, fmt.Errorf("undecodable refusal: %w", err)
		}
		return babelJob{}, &babelRefusal{reason: refuse.Reason, supported: refuse.Supported}
	default:
		return babelJob{}, fmt.Errorf("expected a %s or a %s, got %q",
			babelMessageJob, babelMessageRefuse, kind)
	}
	job, err := decodeJobStage(line, preamble)
	if err != nil {
		return babelJob{}, err
	}
	if job.JobID != preamble.JobID || job.RunID != preamble.RunID {
		return babelJob{}, fmt.Errorf("the job material names job %q of run %q, the preamble named job %q of run %q",
			job.JobID, job.RunID, preamble.JobID, preamble.RunID)
	}
	return job, nil
}

// readStage reads one inbound line and reports its message type, which is what
// both stage readers need before they can decide whether the line is theirs.
func (s *babelSession) readStage() ([]byte, string, error) {
	line, err := s.nextLine()
	if err != nil {
		return nil, "", err
	}
	kind, err := babelMessageType(line)
	if err != nil {
		return nil, "", err
	}
	return line, kind, nil
}

// decodeJobStage decodes one stage over the job assembled so far. Fields the
// stage does not carry are left as they were, which is what makes the material
// stage add to the preamble rather than replace it; top-level fields this build
// does not define are preserved in Extra, so a newer Babel can add one to
// either stage without this worker losing it.
func decodeJobStage(line []byte, job babelJob) (babelJob, error) {
	if err := json.Unmarshal(line, &job); err != nil {
		return babelJob{}, fmt.Errorf("undecodable job stage: %w", err)
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(line, &all); err != nil {
		return babelJob{}, fmt.Errorf("undecodable job stage: %w", err)
	}
	for name := range babelJobFields() {
		delete(all, name)
	}
	if len(all) == 0 {
		return job, nil
	}
	if job.Extra == nil {
		job.Extra = make(map[string]json.RawMessage, len(all))
	}
	for name, value := range all {
		job.Extra[name] = value
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

// babelCatalogModel builds the dial model from Code's own state — the catalog
// and the runtime targets — with none of the TUI's transient fields, and with no
// dial position of its own. A stored profile is replayed against it, so a
// profile is rendered months later by the same construction that produced it.
//
// The selection it starts with is Code's compiled default, and it is there only
// so applyCatalog has a map to clamp: the one caller replaces it wholesale with
// the selection the stored profile carries. Reading the persisted position here
// — let alone CODE_SELECTION_STATE — would mean a dial nobody confirmed could
// decide what a run launches, which is what atyrode/babel#86 removed. A dial
// this process may act on comes from a profile an operator minted, and there is
// no other source left.
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
	m := model{
		generated:      generated,
		advisors:       parseAdvisors(generated["__advisors__"]),
		facts:          parseFacts(generated["__models__"]),
		glyphs:         glyphs,
		runtimeTargets: runtimeTargets,
		facets:         facets,
		sel:            defaultSel(),
	}
	m.applyCatalog()
	return m
}

// babelStoredProfile reads the configuration this installation was given, which
// is the latest revision the ceremony minted for id.
//
// The failure is the interesting half. A worker with an empty store is not
// misconfigured, it is unconfigured, and the two need different words: there is
// no dial resolution left that could paper over it, so the answer names the
// ceremony that produces one instead. Babel's conformance suite grades this
// mode, so a machine where nobody has run the ceremony yet fails
// handshake/accept — honestly, because a worker that cannot say what it is
// configured as has nothing a receipt could attribute a run to.
func babelStoredProfile(id string) (codeProfile, error) {
	profile, err := newProfileStore("").load(id, 0)
	if err != nil {
		return codeProfile{}, fmt.Errorf("profile %s has no configuration to report (%w); mint one "+
			"with `babel analysis profile configure`, which runs Code's dial UI on your terminal", id, err)
	}
	return profile, nil
}

// babelDescribeDials turns a resolved selection into the profile Babel records.
// Everything here is non-secret by construction: the provider credential lives
// in the central broker and the vault and is never part of a selection.
//
// The local lane is described elsewhere (locallane.go) because it shares none
// of this: it resolves no catalog rows, so there is no lead model to find and
// no per-model price to weight, and the fields it does record — the endpoint,
// the engine — mean nothing to a hosted profile.
func babelDescribeDials(m model, id string) codeProfile {
	if chosen, on := m.selectedLocalModel(); on {
		return describeLocalDials(m, id, chosen)
	}
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
// A local profile is rendered from what it recorded rather than from the
// catalog, because the catalog never generated it: the endpoint's model, the
// engine it speaks and the thinking level are the whole configuration, and
// they are in the profile (locallane.go). Reading the environment for them
// instead would let a variable decide what a minted profile runs.
//
// The omp version is unknown here (nothing probes it in a worker), so the
// omp ≥ 17.3 advisor key is omitted. That is the safe direction by design: an
// older omp hard-errors on the unknown key, and a newer one simply does not get
// the audit-tier agent advisor.
func profileOverlay(p codeProfile) (string, error) {
	if isLocalProfile(p.Metadata) {
		target, err := localTargetOf(p.Metadata)
		if err != nil {
			return "", fmt.Errorf("profile %s@%d: %w", p.ID, p.Revision, err)
		}
		return target.overlayYAML(), nil
	}
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
//
// Capabilities are absent because worker mode attaches them: two copies of the
// same claim is one that can drift, and the stub's copy would be the one no
// production run ever exercises.
func (conformanceInvestigator) syntheticConfiguration(job babelJob) babelConfiguration {
	return babelConfiguration{
		Profile: job.Profile,
		Privacy: babelPrivacy{Disclosure: babelDisclosureLocal},
		Cost:    babelCost{Currency: "USD"},
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

	// ToolName is the tool name the tool-request directives actually sent, and
	// ToolNameSource says how it was chosen. They are on the payload because a
	// receipt otherwise records only the decision, and the decision looks the
	// same whether the worker obeyed the grant's published mapping or guessed
	// a name that happened to match.
	ToolName       string `json:"tool_name,omitempty"`
	ToolNameSource string `json:"tool_name_source,omitempty"`

	// Job answers the echo-job directive: the recipes and sources this run
	// decoded, in the flat shape Babel compares against the job it sent. It
	// is a pointer so it is absent under every other directive — the key's
	// presence is what Babel reads as "the worker answered", so an empty
	// object under a directive that never asked would be a claim about a
	// question nobody put.
	//
	// The counts above are not a substitute. Two counts match a worker that
	// read the array lengths and nothing inside them, which is the reading
	// this directive exists to distinguish from a real one.
	Job *babelJobEcho `json:"job,omitempty"`

	// ServedEvidence answers the echo-evidence directive: the hits this run
	// decoded off the decision it was given, flattened the way Babel compares
	// them. It is a pointer for the reason Job above is, and it is emitted
	// even when it is empty once the directive has asked, because a missing
	// key and an empty array report different failures.
	//
	// Decisions is not a substitute here either. It records that an allowed
	// decision arrived, which is exactly what a worker that threw away every
	// hit also records.
	ServedEvidence *babelServedEcho `json:"served_evidence,omitempty"`

	// EchoedToken carries the run's broker credential when the echo-token
	// directive asks for it, and is the only field here that is not a fact
	// about the run. The directive asks for a leak so Babel can be graded on
	// what it does with a real one.
	EchoedToken string `json:"echoed_token,omitempty"`
}

func (conformanceInvestigator) investigate(ctx investigatorContext, job babelJob,
	emit func(stage, message string, fraction float64),
	request func(capability, tool, reason string, arguments json.RawMessage) babelDecision,
) (babelResult, error) {
	// The stub declares resource ceilings — it executes nothing, so every
	// containment claim is trivially true — and a declared ceiling has to be
	// reported against. This process is the whole run here, exactly as on the
	// investigator's conformance path, so the reading is this process's own and
	// the span is the difference across the directive.
	started := ompSelfUsage()
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
	case babelConformanceEchoJob:
		// The run is otherwise well-behaved; the whole answer is the echo,
		// which travels in the terminal result assembled below.
		echo := job.decodedEcho()
		report.Job = &echo
		emit("analyse", "reporting the job this run decoded", 0.5)

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

	case babelConformanceRequestTool, babelConformanceRequestUngranted, babelConformanceEchoEvidence:
		// The name comes out of the job's grant, not out of this file. Babel
		// publishes the tool names it serves per capability and denies anything
		// else, so a constant here would be a second place for the two repos to
		// drift apart — which is exactly how a whole exploration came to have
		// every evidence request refused.
		capability := babelCapabilityCorpusSearch
		if directive == babelConformanceRequestUngranted {
			// Deliberately outside the suite's grant: the grant is the boundary
			// and Babel must deny this before any policy is consulted, so the
			// name is immaterial and the grant publishes none.
			capability = babelCapabilitySandboxExec
		}
		if directive == babelConformanceEchoEvidence {
			// Answered before the request so that a run which never gets to
			// make one still says "implemented, and nothing was served"
			// rather than going silent, which Babel reads as a worker that
			// does not implement the directive at all.
			report.ServedEvidence = &babelServedEcho{Hits: []string{}}
		}
		known, _ := ompEvidenceToolFor(capability)
		tool, source, note := ompOutOfGrantProbeTool, ompToolNameProbe, ""
		if job.Grant.allows(capability) {
			tool, source, note = ompResolveToolName(job.Grant, known)
		}
		report.ToolName, report.ToolNameSource = tool, source
		if tool == "" {
			// Babel published no tool for a capability it granted. Requesting
			// anything under it would be the guess this mechanism removes, so
			// the stub reports the reason and makes no request.
			report.ToolNameSource = source + ": " + note
			emit("adapt", "no tool is published for "+capability+"; asking for nothing", 0.75)
			break
		}
		decision := request(capability, tool,
			"conformance stub: exercising the tool-request round trip",
			json.RawMessage(`{"query":"conformance"}`))
		report.Decisions = append(report.Decisions, decision.Decision)
		if decision.Code != "" {
			report.DenyCodes = append(report.DenyCodes, decision.Code)
		}
		if directive == babelConformanceEchoEvidence {
			// Off the decision that just arrived and nothing else: Babel
			// plants a per-run nonce through the hits it serves, so an answer
			// assembled from anything held here answers with the wrong bytes.
			served, _ := decision.servedEvidence()
			echo := served.echo()
			report.ServedEvidence = &echo
		}
		// A denial is not a termination: the run carries on and still delivers
		// a terminal event.
		emit("adapt", "continuing after the decision", 0.75)

	case babelConformanceEchoToken:
		// Deliberate misbehaviour, which is the directive's whole point: the
		// token goes into a progress message and into the payload verbatim, so
		// Babel has a real leak to redact instead of a hypothetical one.
		//
		// This session's own writer scrubs every job secret out of every byte
		// the process writes, so what actually reaches the wire here is the
		// redaction. That is the intended outcome rather than a defeat of the
		// directive: Code's defence stops the leak here, Babel's redaction
		// stops it for a worker that has no such defence, and the directive is
		// how either side gets to find out.
		token := job.brokerToken()
		report.EchoedToken = token
		emit("analyse", "echoing the run credential on purpose: "+token, 0.5)
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
		Resources: ompSelfUsage().since(started).report(len(report.Decisions)),
	}, nil
}
