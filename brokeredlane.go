package main

// The brokered model lane — an analysis run whose model calls are paid for,
// metered and recorded by the machine that runs it (manifold#530, ADR 0038 §6).
//
// The local lane (locallane.go) was Code's first keyless configuration: a
// daemon on this machine, plain HTTP, no key, nobody billing. This is the
// second, and it is keyless in the sense a governed job needs: the run holds no
// provider credential because there is no provider on the other end of its
// socket. What it holds is a URL on the machine owner's loopback and a bearer
// minted for this one job, delivered in a file the job's sandbox generated —
// and the provider, the credential, the price, the ceiling and the record
// behind that URL are all the owner's.
//
// Four properties are load-bearing.
//
// The endpoint is a loopback origin or the launch is refused. The bearer
// authenticates to the owner's proxy and to nothing else, so a URL that is not
// on this machine would be a credential handed to whatever answered it. The
// check is a refusal before any model work rather than a warning, because the
// alternative is a run that discloses something on its first call.
//
// The profile still names the model, the thinking level and the disclosure
// class, and nothing else. Its lane metadata is ignored: a local-lane profile
// and a hosted one produce the same brokered run, because what a profile can no
// longer decide under --brokered is where the calls go. So the overlay is
// rendered here rather than taken from the profile — every role pinned to the
// one model the owner prices, over omp's OpenAI-compatible provider, with
// omp's model fallback off. A role left pointing at a hosted provider would
// fail its first call for a reason a receipt cannot explain, or, on a machine
// with an ambient credential, reach a provider this run promised it would not.
//
// Two refusals end the run rather than being retried. The owner answers 429
// service_ceiling_exceeded when a call would cross a ceiling the job named, and
// 422 service_price_unknown when a cost ceiling meets a model it has no price
// for. Both are final by construction: the meter latches, so the relay stops
// dialling the owner and no second call reaches the provider, and the reason
// travels in the runtime report as `failure` rather than only as prose —
// a client decides differently between "the model refused" and "the budget is
// spent".
//
// The meter reads the response's status line and, for those two statuses, its
// body. It frames every other response only well enough to find where the next
// one starts, and it forwards every byte untouched on the way past: the bytes
// are the child's stream, and a lane that buffered a model's answer to inspect
// it would be a lane that changed what the run is.
//
// One thing the meter cannot see, stated rather than left to be discovered: it
// rides on the sandbox's model relay, so a run on a machine where no boundary
// came up talks to the owner's proxy directly and nothing watches its
// responses. Such a run is still refused at every ceiling — the owner enforces
// its own, which is the enforcement that counts — but it ends on omp's error
// rather than on a named reason, and its report carries no failure. A client
// that accepts a declaration with no containment has already accepted more
// than that (sandbox.go), and a governed job never does.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
)

// brokeredFileMax bounds the endpoint file. It holds a URL and a bearer, so
// something larger is not this file and reading it whole would be reading
// something else.
const brokeredFileMax = 8 << 10

// brokeredKeyEnv is where omp reads the API key of its OpenAI-compatible
// provider, and brokeredBaseEnv — the local lane's own (locallane.go) — is
// where it reads the base URL.
//
// Measured against omp/18.1.14: the lm-studio provider takes LM_STUDIO_BASE_URL
// as its base, sends LM_STUDIO_API_KEY as a bearer on model discovery and on
// every completion, and requires no credential to be configured at all. That is
// why one variable, one overlay and no code inside omp are the whole lane.
const brokeredKeyEnv = "LM_STUDIO_API_KEY"

// The refusals the owner's proxy answers with, and the terminal reasons they
// become. They are separate vocabularies on purpose: the code is Manifold's
// wire word (packages/protocol/src/services.ts) and the reason is what a
// client records for the run, so neither one moves when the other does.
const (
	brokeredCodeCeiling      = "service_ceiling_exceeded"
	brokeredCodePriceUnknown = "service_price_unknown"

	brokeredReasonCeiling      = "ceiling"
	brokeredReasonPriceUnknown = "price_unknown"
)

// brokeredEndpoint is the generated input file whole: where the owner's proxy
// listens, and the bearer minted for this job.
type brokeredEndpoint struct {
	URL    string `json:"url"`
	Bearer string `json:"bearer"`
}

// loadBrokeredEndpoint reads the file --brokered names, once, before anything is
// resolved or launched.
//
// Nothing here checks the file's mode. The job sandbox that generated it owns
// its permissions, and a launch that second-guessed them would refuse runs over
// a property it cannot fix. The content is another matter: a malformed file, an
// empty bearer or an endpoint that is not a loopback origin each end as a model
// call that failed for a reason no receipt could explain — or, for the endpoint,
// as this job's bearer sent to whatever answered.
func loadBrokeredEndpoint(path string) (brokeredEndpoint, error) {
	file, err := os.Open(path)
	if err != nil {
		return brokeredEndpoint{}, fmt.Errorf("the brokered endpoint file could not be read: %w", err)
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, brokeredFileMax+1))
	if err != nil {
		return brokeredEndpoint{}, fmt.Errorf("the brokered endpoint file %s could not be read: %w", path, err)
	}
	if len(data) > brokeredFileMax {
		return brokeredEndpoint{}, fmt.Errorf("the brokered endpoint file %s is larger than %d bytes, so it "+
			"is not the {\"url\",\"bearer\"} document this lane reads", path, brokeredFileMax)
	}
	var endpoint brokeredEndpoint
	if err := json.Unmarshal(data, &endpoint); err != nil {
		return brokeredEndpoint{}, fmt.Errorf("the brokered endpoint file %s is not the {\"url\",\"bearer\"} "+
			"document this lane reads: %w", path, err)
	}
	base, err := brokeredBaseURL(endpoint.URL)
	if err != nil {
		return brokeredEndpoint{}, err
	}
	endpoint.URL = base
	if err := brokeredBearerOK(endpoint.Bearer); err != nil {
		return brokeredEndpoint{}, err
	}
	return endpoint, nil
}

// brokeredBaseURL validates the owner's endpoint and returns it without a
// trailing slash.
//
// The rule is narrow on purpose — plain HTTP, a loopback host, an explicit
// port, and no path, query or credentials of its own — and every violation gets
// the same sentence, because they are the same mistake: a bearer that
// authenticates only to the owner's proxy, pointed at something that is not it.
func brokeredBaseURL(raw string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	refused := func() error {
		return fmt.Errorf("brokered endpoint must be a loopback origin such as http://127.0.0.1:PORT "+
			"or http://localhost:PORT, and %q is not one: the bearer this lane carries authenticates to "+
			"the machine owner's proxy and to nothing else", raw)
	}
	if trimmed == "" {
		return "", refused()
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", refused()
	}
	if parsed.Scheme != "http" || parsed.User != nil || parsed.Path != "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", refused()
	}
	if parsed.Port() == "" {
		return "", refused()
	}
	if host := parsed.Hostname(); !strings.EqualFold(host, "localhost") {
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			return "", refused()
		}
	}
	return trimmed, nil
}

// brokeredBearerOK refuses a bearer that could not be carried or could not be
// scrubbed. It travels in the child's environment and is redacted out of every
// byte the engine forwards (engineredact.go), and both of those are byte-exact.
func brokeredBearerOK(bearer string) error {
	if bearer == "" {
		return errors.New("the brokered endpoint file carries no bearer, and a brokered run has nothing " +
			"else to authenticate with")
	}
	for _, r := range bearer {
		if r < 0x20 || r == 0x7f {
			return errors.New("the brokered endpoint file's bearer carries a control character, which no " +
				"header could hold and no redaction could match")
		}
	}
	return nil
}

// ── the run ──────────────────────────────────────────────────────────────────

// brokeredTarget is a brokered run's whole provider configuration: the owner's
// endpoint, the model the profile names, and the thinking level it confirmed.
type brokeredTarget struct {
	endpoint brokeredEndpoint
	Model    string
	Thinking string
}

// brokeredThinkingFallback stands in for a profile that recorded no thinking
// level. Every minted revision records one (profile.go), and an empty one would
// render a null level that omp refuses the whole overlay for, so the middle of
// the dial is the substitute rather than a refused run.
const brokeredThinkingFallback = "medium"

// brokeredTargetOf reads the run's configuration out of the profile the launch
// named and the endpoint the file delivered.
//
// Only the model and the thinking level are taken. A profile's lane metadata
// says where its own calls would have gone, and under --brokered that has been
// decided elsewhere — so neither the local lane's endpoint nor the hosted
// lane's provider is consulted, and a profile of either kind runs brokered.
func brokeredTargetOf(profile resolvedProfile, endpoint brokeredEndpoint) (brokeredTarget, error) {
	model := strings.TrimSpace(profile.Metadata["model"])
	if model == "" {
		return brokeredTarget{}, errors.New("the resolved profile names no model, so a brokered run has " +
			"nothing to ask the owner's proxy for")
	}
	// The same filter the local lane applies, for the same reason: the id
	// travels into an omp overlay and an environment variable, so one carrying
	// a quote, a newline or a space is refused here rather than quoted at each
	// of the places it lands.
	if !localModelNameOK(model) {
		return brokeredTarget{}, fmt.Errorf("the resolved profile's model %q is not a usable model id", model)
	}
	thinking := strings.TrimSpace(profile.Metadata["thinking"])
	if thinking == "" {
		thinking = brokeredThinkingFallback
	}
	return brokeredTarget{endpoint: endpoint, Model: model, Thinking: thinking}, nil
}

// bind fills in what only the resolved profile can say. It is a second step
// rather than a constructor argument because the endpoint is read before the
// profile is — a file the launch cannot use is refused before any store is
// touched — and because until it has run, the target names a route and no
// model, which is not a run.
func (t *brokeredTarget) bind(profile resolvedProfile) error {
	bound, err := brokeredTargetOf(profile, t.endpoint)
	if err != nil {
		return err
	}
	*t = bound
	return nil
}

// engine restates the brokered run as the OpenAI-compatible shape omp is
// actually given: a base URL, a model id and a thinking level. The two lanes
// differ in what is behind the URL and in nothing omp can see, so the overlay
// and the endpoint variable are rendered once, in locallane.go.
func (t brokeredTarget) engine() localTarget {
	return localTarget{
		Endpoint: t.endpoint.URL,
		Engine:   localEngineOpenAI,
		Model:    t.Model,
		Thinking: t.Thinking,
	}
}

// overlayYAML is the omp configuration a brokered run launches with: the local
// lane's single-model routing, plus omp's model fallback turned off.
//
// The fallback matters more here than there. A brokered run has exactly one
// priced model and one route; a retry that switched models would be a call the
// owner has no price for, refused as service_price_unknown after the run had
// already been told its ceiling. Turning it off makes the refusal impossible
// rather than handled.
func (t brokeredTarget) overlayYAML() string {
	return t.engine().overlayYAML() + "retry:\n  modelFallback: false\n"
}

// brokeredEnvKeys are the variables a brokered run replaces rather than
// inherits: the local lane's endpoint variables and the key beside them. An
// ambient LM_STUDIO_BASE_URL from an operator's shell must not decide where a
// job's metered calls go, and an ambient key must not travel with them.
var brokeredEnvKeys = func() map[string]bool {
	keys := map[string]bool{brokeredKeyEnv: true}
	for key := range localEngineEnvKeys {
		keys[key] = true
	}
	return keys
}()

// childEnv is the child's environment with the brokered endpoint and bearer in
// place of whatever it inherited. base is the endpoint the child can actually
// reach: the owner's proxy for an uncontained run, the sandbox's own loopback
// relay for a contained one (sandboxegress.go).
func (t brokeredTarget) childEnv(env []string, base string) []string {
	return append(removeEnvKeys(env, brokeredEnvKeys),
		t.engine().engineEnv(base), brokeredKeyEnv+"="+t.endpoint.Bearer)
}

// ── the meter ────────────────────────────────────────────────────────────────

// brokeredMeter is one run's refusal latch, shared by every connection the
// relay carries.
//
// It holds the first refusal and nothing else — no counts, no tokens, no cost.
// Those are the owner's numbers, recorded by the owner from the same responses
// this watches pass by; a second tally kept here would be a number that
// disagrees with the bill.
//
// Latching is what makes the two refusals terminal. A ceiling that refused one
// call would otherwise refuse the retry, the fallback and every call after it,
// each one a request the owner has to answer; once the latch is closed the
// relay stops dialling at all, so the provider is asked exactly once and the
// run ends on the reason rather than on a timeout.
type brokeredMeter struct {
	mu       sync.Mutex
	reason   string
	refusals chan string
}

func newBrokeredMeter() *brokeredMeter {
	return &brokeredMeter{refusals: make(chan string, 1)}
}

// latched reports whether a refusal has already ended this run's inference. A
// nil meter is a lane with nothing to meter — the local one — and never latches.
func (m *brokeredMeter) latched() bool { return m.refusal() != "" }

func (m *brokeredMeter) refusal() string {
	if m == nil {
		return ""
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.reason
}

// refused announces the first refusal exactly once. The channel is how the
// launch hears about it while the child is still running; the field is how the
// runtime report reads it afterwards.
func (m *brokeredMeter) refused(reason string) {
	m.mu.Lock()
	first := m.reason == ""
	if first {
		m.reason = reason
	}
	m.mu.Unlock()
	if !first {
		return
	}
	select {
	case m.refusals <- reason:
	default:
	}
}

// refused exposes the announcement to the launch. A nil meter never announces
// anything, so a caller needs no branch of its own.
func (m *brokeredMeter) announced() <-chan string {
	if m == nil {
		return nil
	}
	return m.refusals
}

// reader wraps the owner's half of one relayed connection. The bytes are
// returned to the caller untouched; what the meter takes from them is the
// status line of each response and, for the two refusals, the body that names
// which one. A nil meter returns the reader it was given, so the local lane's
// relay stays a plain splice.
func (m *brokeredMeter) reader(src io.Reader) io.Reader {
	if m == nil {
		return src
	}
	return &brokeredReader{src: src, meter: m}
}

// brokeredReader is the pass-through half of the meter: one connection's worth
// of response bytes, watched on the way to the child.
type brokeredReader struct {
	src   io.Reader
	meter *brokeredMeter
	watch brokeredWatch
	ended bool
}

func (r *brokeredReader) Read(p []byte) (int, error) {
	if r.ended {
		return 0, io.EOF
	}
	n, err := r.src.Read(p)
	reason := ""
	if n > 0 {
		reason = r.watch.observe(p[:n])
	}
	if reason == "" && err != nil {
		// The connection ended. A refusal whose body the close delimited — the
		// owner sends a length, but a proxy between them need not — is complete
		// exactly now, and this is the last chance to read it.
		reason = r.watch.flush()
	}
	if reason != "" {
		r.meter.refused(reason)
		r.ended = true
		// The refusal has now been delivered whole, so the child has its
		// complete answer and this run has no further call to make. Ending the
		// stream closes the connection here rather than leaving it open for a
		// retry that the latch would refuse anyway.
		if err == nil {
			err = io.EOF
		}
	}
	return n, err
}

// ── one connection's responses ───────────────────────────────────────────────

// brokeredWatch frames the responses on one connection well enough to find the
// two refusals among them, and no further.
//
// Framing is necessary rather than fussy: a keep-alive connection carries the
// stream that spent the budget and then the refusal that names it, so a watch
// that only read the first response would see every ceiling as a successful
// call. What it does not do is decode a body. A response that is not one of the
// two statuses is skipped by length — counted, chunked, or, when it is
// delimited by the connection closing, not framed at all, which retires the
// watch rather than guessing where the next response begins.
type brokeredWatch struct {
	phase brokeredPhase
	// pending collects the bytes of the element being read whole: a header
	// section, a chunk-size line, or a trailer line. It is released the moment
	// that element ends.
	pending []byte
	// body collects a refusal's body, bounded, for the one JSON object this
	// lane reads.
	body []byte
	// left is how many bytes of the current counted body or chunk are still to
	// come.
	left int64
	// collect records that the response being framed is a refusal, so its body
	// is kept as it goes past.
	collect bool
}

type brokeredPhase int

const (
	// brokeredPhaseHead is a status line and its headers, up to the blank line.
	brokeredPhaseHead brokeredPhase = iota
	// brokeredPhaseCounted is a body whose length the headers stated.
	brokeredPhaseCounted
	// brokeredPhaseChunkSize, brokeredPhaseChunkData, brokeredPhaseChunkCRLF
	// and brokeredPhaseTrailer are the chunked framing, which streamed
	// responses arrive in.
	brokeredPhaseChunkSize
	brokeredPhaseChunkData
	brokeredPhaseChunkCRLF
	brokeredPhaseTrailer
	// brokeredPhaseBlind is a connection whose framing was lost: the bytes
	// still flow, and nothing further is read from them.
	brokeredPhaseBlind
)

// brokeredHeadMax bounds a header section and brokeredBodyMax a refusal's body.
// Both are far above what the owner's proxy sends and below what would let a
// misbehaving upstream grow this state without limit.
const (
	brokeredHeadMax = 32 << 10
	brokeredBodyMax = 8 << 10
	// brokeredLineMax bounds a chunk-size or trailer line. A chunk size is at
	// most sixteen hex digits and an extension; anything longer is not framing.
	brokeredLineMax = 1 << 10
)

// observe takes one slice of the bytes the owner's proxy sent — already on
// their way to the child — and reports the reason the run is over, if this
// slice completed a refusal.
func (w *brokeredWatch) observe(p []byte) string {
	for len(p) > 0 {
		switch w.phase {
		case brokeredPhaseBlind:
			return ""
		case brokeredPhaseHead:
			p = w.readHead(p)
		case brokeredPhaseCounted:
			p = w.readCounted(p)
		case brokeredPhaseChunkSize:
			p = w.readChunkSize(p)
		case brokeredPhaseChunkData:
			p = w.readChunkData(p)
		case brokeredPhaseChunkCRLF:
			p = w.readChunkCRLF(p)
		case brokeredPhaseTrailer:
			p = w.readTrailer(p)
		}
		if w.phase == brokeredPhaseHead && w.collect {
			// A response ended and it was one of the two refusal statuses: its
			// body is whole, so either the reason is readable now or the
			// response was never a refusal this lane acts on.
			if reason := w.readRefusal(); reason != "" {
				return reason
			}
		}
	}
	return ""
}

// flush reads a refusal whose body the end of the connection delimited. It is
// the same read observe does at a response boundary, at the only other place a
// body can be known to be complete.
func (w *brokeredWatch) flush() string { return w.readRefusal() }

// readRefusal takes the reason off a collected body and retires the watch when
// it found one: a refusal is the last thing this connection carries, and the
// run it belongs to is over.
func (w *brokeredWatch) readRefusal() string {
	if !w.collect {
		return ""
	}
	reason := brokeredRefusalReason(w.body)
	w.body, w.collect = nil, false
	if reason != "" {
		w.phase = brokeredPhaseBlind
	}
	return reason
}

// blind retires the watch. It is reached only where the bytes stop being
// framable — an oversized header section, a status line that is not one, a body
// the connection's close delimits — and it is deliberately silent: the run
// keeps working, the owner keeps enforcing its own ceiling, and this lane
// simply stops claiming to know where the next response starts.
func (w *brokeredWatch) blind() {
	w.phase = brokeredPhaseBlind
	w.pending, w.body, w.collect = nil, nil, false
}

// readHead collects a header section and decides how the body that follows is
// framed.
func (w *brokeredWatch) readHead(p []byte) []byte {
	for i := range p {
		w.pending = append(w.pending, p[i])
		if len(w.pending) > brokeredHeadMax {
			w.blind()
			return nil
		}
		if !brokeredHeadComplete(w.pending) {
			continue
		}
		head := w.pending
		w.pending = nil
		w.startBody(head)
		return p[i+1:]
	}
	return nil
}

// brokeredHeadComplete reports whether b ends at the blank line that closes a
// header section. Both line endings are accepted: HTTP says CRLF, and a
// response that used bare LF is still one whose body has to be found.
func brokeredHeadComplete(b []byte) bool {
	if len(b) < 2 || b[len(b)-1] != '\n' {
		return false
	}
	if b[len(b)-2] == '\n' {
		return true
	}
	return len(b) >= 4 && b[len(b)-2] == '\r' && b[len(b)-3] == '\n'
}

// startBody reads the one status line and the two headers this lane needs, and
// enters the phase that walks past the body they describe.
func (w *brokeredWatch) startBody(head []byte) {
	status := brokeredStatus(head)
	if status == 0 {
		// Not a response. Either the upstream is not speaking HTTP or the
		// framing has already drifted, and guessing would be worse than
		// stopping.
		w.blind()
		return
	}
	w.collect = brokeredRefusalStatus(status)
	chunked := brokeredChunked(head)
	length, counted := brokeredContentLength(head)
	switch {
	case status < 200 || status == 204 || status == 304:
		// An interim or bodiless response: the next one starts immediately.
		w.collect = false
		w.phase = brokeredPhaseHead
	case chunked:
		w.phase = brokeredPhaseChunkSize
	case counted:
		w.left = length
		w.phase = brokeredPhaseCounted
		if length == 0 {
			w.phase = brokeredPhaseHead
		}
	default:
		// A body the connection's close delimits. It is forwarded like any
		// other, but nothing follows it that could be framed.
		if w.collect {
			// A refusal with no length is still readable: the body runs to the
			// close, and the close is what ends this connection.
			w.phase = brokeredPhaseCounted
			w.left = brokeredBodyMax
			return
		}
		w.blind()
	}
}

func (w *brokeredWatch) readCounted(p []byte) []byte {
	take := int64(len(p))
	if take > w.left {
		take = w.left
	}
	if w.collect {
		w.keep(p[:take])
	}
	w.left -= take
	if w.left == 0 {
		w.phase = brokeredPhaseHead
	}
	return p[take:]
}

func (w *brokeredWatch) readChunkSize(p []byte) []byte {
	line, rest, done := w.readLine(p)
	if !done {
		return rest
	}
	size, err := brokeredChunkSize(line)
	if err != nil {
		w.blind()
		return nil
	}
	if size == 0 {
		w.phase = brokeredPhaseTrailer
		return rest
	}
	w.left = size
	w.phase = brokeredPhaseChunkData
	return rest
}

func (w *brokeredWatch) readChunkData(p []byte) []byte {
	take := int64(len(p))
	if take > w.left {
		take = w.left
	}
	if w.collect {
		w.keep(p[:take])
	}
	w.left -= take
	if w.left == 0 {
		w.phase = brokeredPhaseChunkCRLF
	}
	return p[take:]
}

func (w *brokeredWatch) readChunkCRLF(p []byte) []byte {
	_, rest, done := w.readLine(p)
	if done {
		w.phase = brokeredPhaseChunkSize
	}
	return rest
}

func (w *brokeredWatch) readTrailer(p []byte) []byte {
	line, rest, done := w.readLine(p)
	if !done {
		return rest
	}
	if len(bytes.TrimRight(line, "\r")) == 0 {
		w.phase = brokeredPhaseHead
	}
	return rest
}

// readLine collects bytes up to and including the next newline. It returns the
// line without its newline, the bytes after it, and whether a line was
// completed; an oversized line retires the watch.
func (w *brokeredWatch) readLine(p []byte) (line, rest []byte, done bool) {
	i := bytes.IndexByte(p, '\n')
	if i < 0 {
		w.pending = append(w.pending, p...)
		if len(w.pending) > brokeredLineMax {
			w.blind()
			return nil, nil, false
		}
		return nil, nil, false
	}
	w.pending = append(w.pending, p[:i]...)
	if len(w.pending) > brokeredLineMax {
		w.blind()
		return nil, nil, false
	}
	line, w.pending = w.pending, nil
	return line, p[i+1:], true
}

// keep appends to the refusal body being collected, up to the cap. A body that
// overflows is not read at all rather than read in part: half a JSON document
// names nothing.
func (w *brokeredWatch) keep(p []byte) {
	room := brokeredBodyMax - len(w.body)
	if room <= 0 {
		w.collect = false
		w.body = nil
		return
	}
	if len(p) > room {
		p = p[:room]
	}
	w.body = append(w.body, p...)
}

// brokeredRefusalStatus reports whether a status is one of the two the owner
// refuses a metered call with.
func brokeredRefusalStatus(status int) bool {
	return status == 429 || status == 422
}

// brokeredStatus reads the status code off a status line, or 0 when the section
// does not begin with one.
func brokeredStatus(head []byte) int {
	line := head
	if i := bytes.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	line = bytes.TrimRight(line, "\r")
	if !bytes.HasPrefix(line, []byte("HTTP/")) {
		return 0
	}
	fields := bytes.SplitN(line, []byte(" "), 3)
	if len(fields) < 2 {
		return 0
	}
	status, err := strconv.Atoi(string(fields[1]))
	if err != nil || status < 100 || status > 599 {
		return 0
	}
	return status
}

// brokeredChunked reports whether the response's body is chunked.
func brokeredChunked(head []byte) bool {
	value, ok := brokeredHeader(head, "transfer-encoding")
	if !ok {
		return false
	}
	return strings.Contains(strings.ToLower(value), "chunked")
}

// brokeredContentLength reads a declared body length.
func brokeredContentLength(head []byte) (int64, bool) {
	value, ok := brokeredHeader(head, "content-length")
	if !ok {
		return 0, false
	}
	length, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil || length < 0 {
		return 0, false
	}
	return length, true
}

// brokeredHeader reads one header out of a section, case-insensitively. It
// returns the last occurrence, which is what a body framed against the wrong
// one of two would need to be read with anyway.
func brokeredHeader(head []byte, name string) (string, bool) {
	var value string
	var found bool
	for _, line := range bytes.Split(head, []byte("\n")) {
		key, rest, ok := bytes.Cut(bytes.TrimRight(line, "\r"), []byte(":"))
		if !ok {
			continue
		}
		if !strings.EqualFold(string(bytes.TrimSpace(key)), name) {
			continue
		}
		value, found = string(bytes.TrimSpace(rest)), true
	}
	return value, found
}

// brokeredChunkSize reads a chunk-size line: hex digits, and an extension this
// lane ignores.
func brokeredChunkSize(line []byte) (int64, error) {
	digits := bytes.TrimSpace(line)
	if i := bytes.IndexByte(digits, ';'); i >= 0 {
		digits = bytes.TrimSpace(digits[:i])
	}
	if len(digits) == 0 || len(digits) > 16 {
		return 0, fmt.Errorf("%q is not a chunk size", line)
	}
	size, err := strconv.ParseInt(string(digits), 16, 64)
	if err != nil || size < 0 {
		return 0, fmt.Errorf("%q is not a chunk size", line)
	}
	return size, nil
}

// brokeredRefusalReason names the terminal reason a refusal body carries, or
// nothing when the body is not one of the owner's two refusals.
//
// The pairing is exact: a 429 is only a ceiling and a 422 only an unknown
// price, so a body that names something else — a rate limit from a provider
// the owner forwarded, say — is a call that failed rather than a budget that
// ended, and it is left to omp's own retry to deal with.
func brokeredRefusalReason(body []byte) string {
	var document struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(bytes.TrimSpace(body), &document) != nil {
		return ""
	}
	switch document.Error.Code {
	case brokeredCodeCeiling:
		return brokeredReasonCeiling
	case brokeredCodePriceUnknown:
		return brokeredReasonPriceUnknown
	}
	return ""
}
