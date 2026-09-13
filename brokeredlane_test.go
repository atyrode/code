package main

// The brokered lane, tested in the three places it can go wrong: the file the
// launch is pointed at, the configuration the child is handed, and the refusal
// that ends a run.
//
// The relay is exercised directly against a fake owner proxy rather than
// through a sandbox, for the same reason the egress tests are
// (sandboxegress_test.go): a refusal that a contained run would only see as
// "the connection failed" is checked here as the specific thing it has to be,
// and it stays checked on a machine where no sandbox can be built.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

// testBrokeredBearer is the per-job bearer these tests carry. Like the provider
// token beside it, it is long and non-dictionary so a substring search over an
// argv, an environment, a stream or a report cannot match it by coincidence.
const testBrokeredBearer = "JOBBEARER7c41e9d0b58a236fe1740cab"

// brokeredTestFile writes the endpoint file a job's sandbox would have
// generated.
func brokeredTestFile(t *testing.T, url, bearer string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "inference")
	body, err := json.Marshal(brokeredEndpoint{URL: url, Bearer: bearer})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o400); err != nil {
		t.Fatal(err)
	}
	return path
}

// ownerProxy is the machine owner's metered inference proxy, as much of it as
// this side of the contract can see: it answers the OpenAI-compatible routes,
// records the bearer it was presented, and counts the requests that reached it.
type ownerProxy struct {
	server  *httptest.Server
	calls   atomic.Int64
	bearers []string
	// refuse, when set, is the JSON body every call is refused with, under
	// status.
	status int
	refuse string
}

func newOwnerProxy(t *testing.T) *ownerProxy {
	t.Helper()
	owner := &ownerProxy{}
	owner.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		owner.calls.Add(1)
		owner.bearers = append(owner.bearers, r.Header.Get("Authorization"))
		if owner.refuse != "" {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Connection", "close")
			w.WriteHeader(owner.status)
			_, _ = io.WriteString(w, owner.refuse)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"object":"list","data":[{"id":"claude-opus-5","object":"model"}]}`)
	}))
	t.Cleanup(owner.server.Close)
	return owner
}

func (o *ownerProxy) url() string { return o.server.URL }

// ── the endpoint file ────────────────────────────────────────────────────────

// TestBrokeredEndpointRefusesAnythingButALoopbackOrigin is the check that
// stands between this job's bearer and whatever else could be named in a file.
// Every refusal here is the same mistake — a credential that authenticates only
// to the owner's proxy, pointed somewhere else — so they are one table.
func TestBrokeredEndpointRefusesAnythingButALoopbackOrigin(t *testing.T) {
	for _, tc := range []struct {
		name string
		url  string
	}{
		{"https", "https://127.0.0.1:8080"},
		{"a public host", "http://inference.example.com:443"},
		{"a private address", "http://192.168.1.10:8080"},
		{"no port", "http://127.0.0.1"},
		{"a path", "http://127.0.0.1:8080/v1"},
		{"a query", "http://127.0.0.1:8080?bearer=x"},
		{"credentials of its own", "http://user:pass@127.0.0.1:8080"},
		{"not a URL", "127.0.0.1:8080"},
		{"empty", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := brokeredBaseURL(tc.url); err == nil {
				t.Fatalf("%q was accepted as a brokered endpoint", tc.url)
			} else if !strings.Contains(err.Error(), "brokered endpoint must be a loopback origin") {
				t.Errorf("the refusal of %q does not name the rule: %v", tc.url, err)
			}
		})
	}
	for _, accepted := range []string{
		"http://127.0.0.1:8080",
		"http://127.0.0.1:8080/",
		" http://localhost:9000 ",
		"http://[::1]:8080",
	} {
		if _, err := brokeredBaseURL(accepted); err != nil {
			t.Errorf("the loopback origin %q was refused: %v", accepted, err)
		}
	}
}

// TestBrokeredEndpointFileMustBeReadableAndComplete: a launch that cannot read
// its endpoint has no route to a model, and saying so costs a sentence instead
// of a run that fails on its first call.
func TestBrokeredEndpointFileMustBeReadableAndComplete(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body), 0o400); err != nil {
			t.Fatal(err)
		}
		return path
	}
	for _, tc := range []struct {
		name string
		path string
	}{
		{"absent", filepath.Join(dir, "nothing-here")},
		{"not JSON", write("garbage", "this is not a document\n")},
		{"a JSON array", write("array", `["http://127.0.0.1:8080","bearer"]`)},
		{"no bearer", write("nobearer", `{"url":"http://127.0.0.1:8080"}`)},
		{"an empty bearer", write("emptybearer", `{"url":"http://127.0.0.1:8080","bearer":""}`)},
		{"a bearer with a newline", write("newline", `{"url":"http://127.0.0.1:8080","bearer":"a\nb"}`)},
		{"no url", write("nourl", `{"bearer":"`+testBrokeredBearer+`"}`)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := loadBrokeredEndpoint(tc.path); err == nil {
				t.Fatal("the launch accepted an endpoint file it cannot run with")
			}
		})
	}

	good := write("inference", `{"url":"http://127.0.0.1:8080/","bearer":"`+testBrokeredBearer+`"}`)
	endpoint, err := loadBrokeredEndpoint(good)
	if err != nil {
		t.Fatalf("a well-formed endpoint file was refused: %v", err)
	}
	if endpoint.URL != "http://127.0.0.1:8080" || endpoint.Bearer != testBrokeredBearer {
		t.Errorf("the endpoint read back as %+v", endpoint)
	}
}

// ── the run's configuration ──────────────────────────────────────────────────

// TestBrokeredOverlayPinsTheOneModelItIsPricedis the routing half: the profile
// names a model, the owner prices that model, and every role has to run it. A
// role left on the profile's own provider would be a call with no route and no
// price, and a fallback would be the same thing after a refusal.
func TestBrokeredOverlayPinsTheOneModelItIsPriced(t *testing.T) {
	target, err := brokeredTargetOf(testProfile(), brokeredEndpoint{
		URL: "http://127.0.0.1:8080", Bearer: testBrokeredBearer,
	})
	if err != nil {
		t.Fatalf("reading the brokered target off a hosted profile: %v", err)
	}
	overlay := target.overlayYAML()
	for _, want := range []string{
		"modelRoles:\n",
		`  default: "lm-studio/claude-opus-5"`,
		"defaultThinkingLevel: high\n",
		"advisor:\n  enabled: false\n",
		"retry:\n  modelFallback: false\n",
	} {
		if !strings.Contains(overlay, want) {
			t.Errorf("the brokered overlay lacks %q:\n%s", want, overlay)
		}
	}
	if strings.Contains(overlay, "anthropic/") {
		t.Errorf("a role still names the profile's own provider:\n%s", overlay)
	}

	// A local-lane profile runs brokered too, and its recorded endpoint decides
	// nothing: under --brokered the calls go where the file says.
	local := resolvedProfile{
		Ref:        profileRef{ID: "local-led", Revision: 2},
		Disclosure: disclosureLocal,
		Metadata: map[string]string{
			"provider": localProvider, "model": "qwen2.5:3b", "thinking": "low",
			localMetaEngine: localEngineOllama, localMetaEndpoint: "http://127.0.0.1:11434",
		},
	}
	localTargeted, err := brokeredTargetOf(local, brokeredEndpoint{
		URL: "http://127.0.0.1:8080", Bearer: testBrokeredBearer,
	})
	if err != nil {
		t.Fatalf("reading the brokered target off a local profile: %v", err)
	}
	if localTargeted.endpoint.URL != "http://127.0.0.1:8080" {
		t.Errorf("the run's endpoint is %q; the profile's own must not decide it", localTargeted.endpoint.URL)
	}
	if !strings.Contains(localTargeted.overlayYAML(), `"lm-studio/qwen2.5:3b"`) {
		t.Errorf("a local profile's model did not survive into the brokered overlay:\n%s",
			localTargeted.overlayYAML())
	}

	// And a profile with no model at all is a refusal rather than a run that
	// asks the owner's proxy for nothing.
	empty := testProfile()
	empty.Metadata = map[string]string{"provider": "anthropic"}
	if _, err := brokeredTargetOf(empty, brokeredEndpoint{URL: "http://127.0.0.1:8080", Bearer: "x"}); err == nil {
		t.Error("a profile naming no model was accepted for a brokered run")
	}
}

// TestBrokeredRunNeedsNoCredential is the lane's whole claim about custody: the
// auth broker, the vault manifest and the account pool are not consulted, and
// the bearer that is consulted is registered for redaction.
func TestBrokeredRunNeedsNoCredential(t *testing.T) {
	l := newOmpLauncher(&fakeProfiles{profile: testProfile()})
	l.auth = func() (ompAuth, error) {
		t.Error("a brokered run asked the auth broker for a credential")
		return ompAuth{}, errOmpNoCredential
	}
	if err := l.openBrokered(brokeredTestFile(t, "http://127.0.0.1:8080", testBrokeredBearer)); err != nil {
		t.Fatalf("opening the endpoint file: %v", err)
	}
	if err := l.resolveCredential(testProfile().Ref); err != nil {
		t.Fatalf("resolving a brokered run's credential: %v", err)
	}
	if l.credential.configured() || l.keyless {
		t.Errorf("a brokered run resolved a credential (%v) or claimed the local lane (%v)",
			l.credential.configured(), l.keyless)
	}
	if !l.redactor.active() {
		t.Fatal("the job's bearer was not registered for redaction")
	}
	if got := l.redactor.redactString("bearer " + testBrokeredBearer); strings.Contains(got, testBrokeredBearer) {
		t.Errorf("the redactor does not cover the bearer: %q", got)
	}
}

// ── the boundary ─────────────────────────────────────────────────────────────

// TestBrokeredEgressRelaysTheOwnersProxyAndNothingElse: the lane's egress is
// the local one's shape — an empty CONNECT allowlist and a raw relay to a
// loopback endpoint — and the endpoint is the owner's proxy.
func TestBrokeredEgressRelaysTheOwnersProxyAndNothingElse(t *testing.T) {
	owner := newOwnerProxy(t)
	l := newOmpLauncher(&fakeProfiles{profile: testProfile()})
	l.auth = func() (ompAuth, error) {
		t.Error("a brokered run's egress consulted the auth broker")
		return ompAuth{}, errOmpNoCredential
	}
	if err := l.openBrokered(brokeredTestFile(t, owner.url(), testBrokeredBearer)); err != nil {
		t.Fatalf("opening the endpoint file: %v", err)
	}
	lane, policy, err := l.runEgress()
	if err != nil {
		t.Fatalf("resolving a brokered run's egress: %v", err)
	}
	if lane != laneBrokered {
		t.Errorf("the egress names lane %q, want %q", lane, laneBrokered)
	}
	if len(policy.allowed) != 0 {
		t.Errorf("the CONNECT allowlist is %v, want nothing off this machine", policy.allowed)
	}
	if policy.brokerAddr != "" || policy.brokerURL != "" {
		t.Errorf("a brokered run was given an auth-broker relay: %+v", policy)
	}
	ownerURL, err := url.Parse(owner.url())
	if err != nil {
		t.Fatal(err)
	}
	if policy.modelAddr != ownerURL.Host {
		t.Errorf("the relay dials %q, want the owner's proxy %q", policy.modelAddr, ownerURL.Host)
	}
	wantGuest := "http://127.0.0.1:" + strconv.Itoa(sandboxModelPort)
	if policy.modelURL != wantGuest {
		t.Errorf("the child inside would call %q, want the sandbox's own loopback %q", policy.modelURL, wantGuest)
	}
	if policy.modelMeter != l.meter {
		t.Error("the relay was given a different meter than the one the report reads")
	}

	// The escape statement has to say which credential is inside the boundary,
	// because "no provider credential" and "a provider credential" are both
	// false for this lane.
	facts := sandboxFacts{
		backend: sandboxBackendFull, filesystemIsolation: true, networkDefaultDeny: true,
		resourceCeilings: true, disposable: true, ceilings: defaultSandboxCeilings(),
	}
	escape := facts.escape(l.egressDescription())
	for _, want := range []string{
		ownerURL.Host, "metered", "minted for this " + "job alone", "No provider token is in here",
	} {
		if !strings.Contains(escape, want) {
			t.Errorf("the brokered escape statement lacks %q:\n%s", want, escape)
		}
	}
}

// TestBrokeredRelayEndsTheRunAtACeiling is the refusal, end to end over the
// relay a contained run uses: the owner answers 429, the child gets that answer
// whole, the meter names the reason, and the next call is not forwarded at all
// — so the provider is asked exactly once for a budget that is spent.
func TestBrokeredRelayEndsTheRunAtACeiling(t *testing.T) {
	owner := newOwnerProxy(t)
	owner.status = http.StatusTooManyRequests
	owner.refuse = `{"error":{"code":"service_ceiling_exceeded","ceiling":"costMicros"}}`

	meter := newBrokeredMeter()
	policy, err := sandboxResolveLocalEgress(owner.url())
	if err != nil {
		t.Fatalf("resolving the brokered egress: %v", err)
	}
	policy.modelMeter = meter
	egress, err := newSandboxEgress(filepath.Join(t.TempDir(), "egress"), policy)
	if err != nil {
		t.Fatalf("opening the brokered egress: %v", err)
	}
	defer egress.close()

	call := func() (*http.Response, error) {
		// A fresh transport per call, because a retry after a refusal with
		// Connection: close is a new connection and that is the case under
		// test.
		client := &http.Client{Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", egress.modelSocket())
			},
		}}
		return client.Post("http://relayed/v1/chat/completions", "application/json",
			strings.NewReader(`{"model":"claude-opus-5","messages":[]}`))
	}

	response, err := call()
	if err != nil {
		t.Fatalf("the relay did not carry the call: %v", err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatalf("reading the refusal the child would have read: %v", err)
	}
	if response.StatusCode != http.StatusTooManyRequests || string(body) != owner.refuse {
		t.Fatalf("the child got %s %q; a refusal must reach it whole and unaltered", response.Status, body)
	}
	if got := meter.refusal(); got != brokeredReasonCeiling {
		t.Fatalf("the meter read the refusal as %q, want %q", got, brokeredReasonCeiling)
	}
	select {
	case reason := <-meter.announced():
		if reason != brokeredReasonCeiling {
			t.Errorf("the launch was told %q", reason)
		}
	default:
		t.Error("the refusal was never announced, so the launch would wait out omp's retries")
	}

	// The second call is the one that matters: nothing is dialled, so the
	// owner — and the provider behind it — is asked once and only once.
	if _, err := call(); err == nil {
		t.Error("a call after the ceiling was relayed; the run must have no route left")
	}
	if got := owner.calls.Load(); got != 1 {
		t.Errorf("the owner's proxy saw %d call(s), want exactly 1", got)
	}
	log := egress.attemptLog()
	if len(log) != 1 || log[0].Allowed || !strings.Contains(log[0].Reason, brokeredReasonCeiling) {
		t.Errorf("the refused call is not in the run's egress record: %+v", log)
	}
}

// TestBrokeredRelayForwardsAnOrdinaryFailure is the other direction: a call the
// owner could not serve for an ordinary reason is not a spent budget, so the
// lane leaves it to omp's own retry and keeps the route open.
func TestBrokeredRelayForwardsAnOrdinaryFailure(t *testing.T) {
	owner := newOwnerProxy(t)
	owner.status = http.StatusBadGateway
	owner.refuse = `{"error":"service_upstream_unavailable"}`

	meter := newBrokeredMeter()
	policy, err := sandboxResolveLocalEgress(owner.url())
	if err != nil {
		t.Fatalf("resolving the brokered egress: %v", err)
	}
	policy.modelMeter = meter
	egress, err := newSandboxEgress(filepath.Join(t.TempDir(), "egress"), policy)
	if err != nil {
		t.Fatalf("opening the brokered egress: %v", err)
	}
	defer egress.close()

	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", egress.modelSocket())
		},
	}}
	for attempt := range 2 {
		response, err := client.Post("http://relayed/v1/chat/completions", "application/json",
			strings.NewReader(`{"model":"claude-opus-5","messages":[]}`))
		if err != nil {
			t.Fatalf("attempt %d was not relayed: %v", attempt+1, err)
		}
		_, _ = io.Copy(io.Discard, response.Body)
		response.Body.Close()
	}
	if meter.latched() {
		t.Errorf("an ordinary failure ended the run as %q", meter.refusal())
	}
	if got := owner.calls.Load(); got != 2 {
		t.Errorf("the owner's proxy saw %d call(s), want both attempts", got)
	}
}

// ── framing the owner's responses ────────────────────────────────────────────

// TestBrokeredWatchFindsTheRefusalAfterWhateverCameBefore is why the watch
// frames responses at all. A keep-alive connection carries the streamed answers
// that spent the budget and then the refusal that names it, so a watch that
// only read the first response would see every ceiling as a successful call.
func TestBrokeredWatchFindsTheRefusalAfterWhateverCameBefore(t *testing.T) {
	counted := func(status int, body string) string {
		return fmt.Sprintf("HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s",
			status, http.StatusText(status), len(body), body)
	}
	chunked := func(status int, chunks ...string) string {
		var b strings.Builder
		fmt.Fprintf(&b, "HTTP/1.1 %d %s\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
			status, http.StatusText(status))
		for _, chunk := range chunks {
			fmt.Fprintf(&b, "%x\r\n%s\r\n", len(chunk), chunk)
		}
		b.WriteString("0\r\n\r\n")
		return b.String()
	}
	ceiling := counted(429, `{"error":{"code":"service_ceiling_exceeded","ceiling":"calls"}}`)
	price := counted(422, `{"error":{"code":"service_price_unknown","model":"claude-opus-5"}}`)

	for _, tc := range []struct {
		name   string
		stream string
		want   string
	}{
		{"a refusal on its own", ceiling, brokeredReasonCeiling},
		{"an unpriced model", price, brokeredReasonPriceUnknown},
		{
			"after a counted answer",
			counted(200, `{"id":"c1","usage":{"prompt_tokens":9}}`) + ceiling,
			brokeredReasonCeiling,
		},
		{
			"after a streamed answer",
			chunked(200, "data: {\"choices\":[]}\n\n", "data: [DONE]\n\n") + ceiling,
			brokeredReasonCeiling,
		},
		{
			"after a model list and a stream",
			counted(200, `{"object":"list","data":[]}`) +
				chunked(200, "data: {}\n\n") + price,
			brokeredReasonPriceUnknown,
		},
		{
			"after an interim response",
			"HTTP/1.1 100 Continue\r\n\r\n" + ceiling,
			brokeredReasonCeiling,
		},
		{"a 429 the owner did not send", counted(429, `{"error":"rate_limited"}`), ""},
		{
			"a refusal code under the wrong status",
			counted(500, `{"error":{"code":"service_ceiling_exceeded"}}`),
			"",
		},
		{
			"a ceiling body a provider forwarded as text",
			counted(429, `{"error":{"code":"rate_limit_exceeded"}}`),
			"",
		},
		{"an answer with no refusal after it", counted(200, `{"id":"c1"}`), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// One byte at a time is the interesting shape: every boundary this
			// frames — status line, header, chunk size, body — straddles a read
			// on a real socket sooner or later.
			for _, size := range []int{1, 7, len(tc.stream)} {
				var watch brokeredWatch
				got := ""
				for i := 0; i < len(tc.stream) && got == ""; i += size {
					end := min(i+size, len(tc.stream))
					got = watch.observe([]byte(tc.stream[i:end]))
				}
				if got != tc.want {
					t.Errorf("reads of %d byte(s) read the stream as %q, want %q", size, got, tc.want)
				}
			}
		})
	}
}

// TestBrokeredWatchReadsARefusalTheCloseDelimited: the owner sends a length,
// but a proxy between it and the sandbox need not, and a refusal is only
// readable once. The end of the connection is the other place a body is known
// to be complete, so it is read there too — through the reader the relay uses,
// because that is what sees the end.
func TestBrokeredWatchReadsARefusalTheCloseDelimited(t *testing.T) {
	meter := newBrokeredMeter()
	stream := "HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" +
		`{"error":{"code":"service_ceiling_exceeded","ceiling":"calls"}}`
	relayed, err := io.ReadAll(meter.reader(strings.NewReader(stream)))
	if err != nil {
		t.Fatalf("relaying the refusal: %v", err)
	}
	if string(relayed) != stream {
		t.Errorf("the child would have received %q, want the bytes unaltered", relayed)
	}
	if got := meter.refusal(); got != brokeredReasonCeiling {
		t.Errorf("the meter read the close-delimited refusal as %q, want %q", got, brokeredReasonCeiling)
	}
}

// TestBrokeredWatchStopsRatherThanGuessing: a response this cannot frame must
// retire the watch instead of hunting for a status line in a model's answer,
// where the bytes are whatever the model wrote.
func TestBrokeredWatchStopsRatherThanGuessing(t *testing.T) {
	body := `{"error":{"code":"service_ceiling_exceeded","ceiling":"calls"}}`
	ceiling := fmt.Sprintf("HTTP/1.1 429 Too Many Requests\r\nContent-Length: %d\r\n\r\n%s", len(body), body)
	for _, tc := range []struct {
		name   string
		stream string
	}{
		{
			"a body the close delimits",
			"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nHTTP/1.1 429 Too Many Requests\r\n\r\n" + ceiling,
		},
		{
			"not HTTP at all",
			"\x16\x03\x01 this is a TLS record, not a response\r\n\r\n" + ceiling,
		},
		{
			"a header section past the cap",
			"HTTP/1.1 200 OK\r\nX-Pad: " + strings.Repeat("p", brokeredHeadMax) + "\r\n\r\n" + ceiling,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var watch brokeredWatch
			if got := watch.observe([]byte(tc.stream)); got != "" {
				t.Errorf("the watch claimed %q from a stream it cannot frame", got)
			}
			if watch.phase != brokeredPhaseBlind {
				t.Errorf("the watch is still framing (phase %d) after losing the framing", watch.phase)
			}
		})
	}
}

// ── the launch ───────────────────────────────────────────────────────────────

// TestBrokeredLaunchGivesTheChildTheOwnersProxyAndTheJobsBearer is the run: the
// child is configured with the endpoint the file named and the bearer beside
// it, it reaches the owner's proxy with that bearer, no auth broker is
// consulted, and the report says which lane this was.
func TestBrokeredLaunchGivesTheChildTheOwnersProxyAndTheJobsBearer(t *testing.T) {
	owner := newOwnerProxy(t)
	l, _ := newTestLauncher(t)
	l.auth = func() (ompAuth, error) {
		t.Error("a brokered launch asked the auth broker for a credential")
		return ompAuth{}, errOmpNoCredential
	}
	// Nothing ambient decides anything: an inherited endpoint, key or broker
	// token must not survive into a supervised run.
	l.environ = func() []string {
		return []string{
			"PATH=" + os.Getenv("PATH"),
			"LM_STUDIO_BASE_URL=http://127.0.0.1:9/decoy",
			"LM_STUDIO_API_KEY=ambient-key",
			"OLLAMA_BASE_URL=http://127.0.0.1:9/decoy",
			"OMP_AUTH_BROKER_TOKEN=ambient-token",
			"OMP_AUTH_BROKER_URL=http://ambient.invalid/auth",
		}
	}
	opts := testLaunchOptions(t)
	opts.brokered = brokeredTestFile(t, owner.url(), testBrokeredBearer)
	run := serveFakeOpts(t, context.Background(), l, "brokeredmodel", "", opts)
	if run.err != nil || run.status != 0 {
		t.Fatalf("a brokered launch = %d, %v; stderr: %s", run.status, run.err, run.stderr)
	}

	got := ompFakeRead(t, run.record)
	if want := owner.url() + "/v1"; got.ModelEndpoint != want {
		t.Errorf("the child was told the model is at %q, want the owner's %q", got.ModelEndpoint, want)
	}
	if got.ModelKey != testBrokeredBearer {
		t.Errorf("the child's API key is %q, want this job's bearer", got.ModelKey)
	}
	if got.ModelReached != "200" {
		t.Errorf("the child's model-list request answered %q, want 200 from the owner's proxy", got.ModelReached)
	}
	if calls := owner.calls.Load(); calls != 1 {
		t.Fatalf("the owner's proxy saw %d call(s), want the child's one", calls)
	}
	if owner.bearers[0] != "Bearer "+testBrokeredBearer {
		t.Errorf("the owner was presented %q, want this job's bearer", owner.bearers[0])
	}
	for _, entry := range got.Env {
		key, value, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(key, "OMP_AUTH_BROKER") {
			t.Errorf("a brokered run handed the child %s", key)
		}
		if key == "LM_STUDIO_BASE_URL" && value != owner.url()+"/v1" {
			t.Errorf("an inherited endpoint survived into the run: %s", entry)
		}
		if key == "LM_STUDIO_API_KEY" && value != testBrokeredBearer {
			t.Errorf("an inherited key survived into the run: %s=%q", key, value)
		}
		if key == "OLLAMA_BASE_URL" {
			t.Errorf("the run kept a local-lane endpoint it does not use: %s", entry)
		}
	}

	// The overlay the child was launched with routes to the owner's proxy and
	// nowhere else.
	argv := strings.Join(got.Argv, " ")
	config := ""
	for i, arg := range got.Argv {
		if arg == "--config" && i+1 < len(got.Argv) {
			config = got.Argv[i+1]
		}
	}
	if config == "" {
		t.Fatalf("the child was launched with no overlay: %s", argv)
	}

	if run.report.Lane != laneBrokered {
		t.Errorf("the report names lane %q, want %q", run.report.Lane, laneBrokered)
	}
	if run.report.Failure != "" {
		t.Errorf("a run that was never refused reports failure %q", run.report.Failure)
	}
}

// TestBrokeredLaunchRedactsTheJobsBearer: the bearer is a credential, and the
// child's diagnostics are something this process forwards. A run that echoed it
// must not put it on the client's stream, its stderr or its report.
func TestBrokeredLaunchRedactsTheJobsBearer(t *testing.T) {
	owner := newOwnerProxy(t)
	l, _ := newTestLauncher(t)
	l.auth = func() (ompAuth, error) { return ompAuth{}, errOmpNoCredential }
	opts := testLaunchOptions(t)
	opts.brokered = brokeredTestFile(t, owner.url(), testBrokeredBearer)
	run := serveFakeOpts(t, context.Background(), l, "brokeredleak", "", opts)
	if run.err != nil {
		t.Fatalf("the launch failed: %v (stderr: %s)", run.err, run.stderr)
	}
	for name, stream := range map[string][]byte{
		"the client's stream": run.stdout,
		"stderr":              run.stderr,
		"the runtime report":  run.rawInfo,
	} {
		if strings.Contains(string(stream), testBrokeredBearer) {
			t.Errorf("the job's bearer reached %s:\n%s", name, stream)
		}
	}
	if !strings.Contains(string(run.stdout), string(engineRedacted)) {
		t.Errorf("nothing was redacted from a stream that carried the bearer:\n%s", run.stdout)
	}
}

// TestBrokeredLaunchRefusesAnEndpointItCannotUse: the refusal comes before the
// child, so a client gets a reason instead of a run that fails on its first
// call — and no report is written, because there was no launch to report.
func TestBrokeredLaunchRefusesAnEndpointItCannotUse(t *testing.T) {
	for _, tc := range []struct {
		name string
		file func(t *testing.T) string
	}{
		{
			"a non-loopback endpoint",
			func(t *testing.T) string {
				return brokeredTestFile(t, "https://api.example.com:443", testBrokeredBearer)
			},
		},
		{
			"a malformed file",
			func(t *testing.T) string {
				path := filepath.Join(t.TempDir(), "inference")
				if err := os.WriteFile(path, []byte("{not json"), 0o400); err != nil {
					t.Fatal(err)
				}
				return path
			},
		},
		{
			"a file that is not there",
			func(t *testing.T) string { return filepath.Join(t.TempDir(), "absent") },
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l, profiles := newTestLauncher(t)
			l.auth = func() (ompAuth, error) {
				t.Error("a refused brokered launch consulted the auth broker")
				return ompAuth{}, errOmpNoCredential
			}
			opts := testLaunchOptions(t)
			opts.brokered = tc.file(t)
			fake, record := ompFakeBinary(t, "plain")
			l.lookOmp = func() (string, error) { return fake, nil }
			var out, errw strings.Builder
			status, err := l.serve(context.Background(), opts, strings.NewReader(""), &out, &errw)
			if err == nil {
				t.Fatal("the launch accepted an endpoint it cannot use")
			}
			if status != 1 {
				t.Errorf("status = %d, want 1: a refusal before any byte reached stdout", status)
			}
			if out.Len() != 0 {
				t.Errorf("a refused launch wrote to the client's stream: %q", out.String())
			}
			if _, err := os.Stat(record); err == nil {
				t.Error("a refused launch started a child anyway")
			}
			if _, err := os.Stat(opts.runtimeInfo); err == nil {
				t.Error("a refused launch wrote a runtime report")
			}
			if profiles.askedID != "" {
				t.Errorf("the profile store was read for a launch with no route: %q", profiles.askedID)
			}
		})
	}
}

// TestBrokeredCeilingReachesTheRuntimeReport is the reason's wire path. The
// client that launched the run decides differently between a model that would
// not answer and a budget that is spent, and the only machine-readable place
// this engine can say which it was is the report it rewrites when the run ends.
func TestBrokeredCeilingReachesTheRuntimeReport(t *testing.T) {
	// The bodies are framed by their measured length, because a hand-counted
	// Content-Length that disagreed with the body would be testing this lane's
	// tolerance for a broken owner rather than its reading of a working one.
	refusal := func(status int, body string) string {
		return fmt.Sprintf("HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nConnection: close\r\n"+
			"Content-Length: %d\r\n\r\n%s", status, http.StatusText(status), len(body), body)
	}
	for _, tc := range []struct {
		name     string
		response string
		want     string
	}{
		{
			"a ceiling",
			refusal(429, `{"error":{"code":"service_ceiling_exceeded","ceiling":"costMicros"}}`),
			brokeredReasonCeiling,
		},
		{
			"an unpriced model",
			refusal(422, `{"error":{"code":"service_price_unknown","model":"claude-opus-5"}}`),
			brokeredReasonPriceUnknown,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			owner := newOwnerProxy(t)
			l, _ := newTestLauncher(t)
			l.auth = func() (ompAuth, error) { return ompAuth{}, errOmpNoCredential }
			// The refusal arrives the way the relay delivers one: through the
			// reader the meter puts in front of the owner's half of a
			// connection, byte for byte as the owner wrote it.
			l.meter = newBrokeredMeter()
			if _, err := io.Copy(io.Discard, l.meter.reader(strings.NewReader(tc.response))); err != nil {
				t.Fatalf("relaying the refusal: %v", err)
			}
			if got := l.meter.refusal(); got != tc.want {
				t.Fatalf("the meter read the refusal as %q, want %q", got, tc.want)
			}

			opts := testLaunchOptions(t)
			opts.brokered = brokeredTestFile(t, owner.url(), testBrokeredBearer)
			run := serveFakeOpts(t, context.Background(), l, "plain", "", opts)
			if run.report.Failure != tc.want {
				t.Errorf("the report's failure is %q, want %q:\n%s", run.report.Failure, tc.want, run.rawInfo)
			}
			if run.report.Lane != laneBrokered {
				t.Errorf("the report names lane %q", run.report.Lane)
			}
		})
	}
}

// TestRuntimeReportNamesTheLane covers the field a client reads before it reads
// a cost. It is a property of the launch, not of the profile alone: the same
// hosted profile is a hosted run or a brokered one depending on the flag.
func TestRuntimeReportNamesTheLane(t *testing.T) {
	hosted := runtimeReportOf(testProfile())
	if hosted.Lane != laneHosted {
		t.Errorf("a hosted profile's report names lane %q", hosted.Lane)
	}
	local := runtimeReportOf(resolvedProfile{
		Ref:        profileRef{ID: "local-led", Revision: 1},
		Disclosure: disclosureLocal,
		Metadata:   map[string]string{"provider": localProvider, "model": "qwen2.5:3b"},
	})
	if local.Lane != laneLocal {
		t.Errorf("a local profile's report names lane %q", local.Lane)
	}

	owner := newOwnerProxy(t)
	l, _ := newTestLauncher(t)
	l.auth = func() (ompAuth, error) { return ompAuth{}, errOmpNoCredential }
	opts := testLaunchOptions(t)
	opts.brokered = brokeredTestFile(t, owner.url(), testBrokeredBearer)
	run := serveFakeOpts(t, context.Background(), l, "plain", "", opts)
	if run.report.Lane != laneBrokered {
		t.Errorf("the same hosted profile launched brokered reports lane %q", run.report.Lane)
	}
	// And the key stays in the document rather than being omitted when it is
	// the commonest value: a client that cannot find the field cannot tell a
	// build that does not write it from a run that was hosted.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(run.rawInfo, &raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw["lane"]; !ok {
		t.Errorf("the report has no lane key at all:\n%s", run.rawInfo)
	}
}
