package main

// The egress boundary, tested without a sandbox.
//
// The escape scenarios in sandbox_linux_test.go drive this code from inside a
// real bubblewrap namespace, which is the only way to show that the sandbox has
// no other route out. These tests are the other half: they hold the proxy
// itself to its allowlist, directly, so a refusal that the scenarios would only
// see as "the connection failed" is checked here as the specific refusal it has
// to be — and so the rules survive on a platform where no sandbox can be built
// at all.

import (
	"fmt"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// sandboxDialConnect asks a proxy for a tunnel and returns its status line. It
// speaks the wire directly because that is what OMP's fetch does, and a Go HTTP
// client would hide the refusal behind its own error.
func sandboxDialConnect(network, address, target string) (string, error) {
	conn, err := net.DialTimeout(network, address, 10*time.Second)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target); err != nil {
		return "", err
	}
	return sandboxReadStatusLine(conn)
}

func sandboxReadStatusLine(conn net.Conn) (string, error) {
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	line := make([]byte, 0, 128)
	buf := make([]byte, 1)
	for len(line) < 128 {
		if _, err := conn.Read(buf); err != nil {
			break
		}
		if buf[0] == '\n' {
			break
		}
		line = append(line, buf[0])
	}
	return strings.TrimSpace(string(line)), nil
}

// sandboxScenarioConnect asks the proxy PI_PROXY names for a tunnel, the way
// OMP's fetch would, and returns its status line.
func sandboxScenarioConnect(proxy, target string) (string, error) {
	return sandboxDialConnect("tcp", strings.TrimPrefix(proxy, "http://"), target)
}

func sandboxTestEgress(t *testing.T, policy sandboxEgressPolicy) *sandboxEgress {
	t.Helper()
	egress, err := newSandboxEgress(filepath.Join(t.TempDir(), "egress"), policy)
	if err != nil {
		t.Fatalf("opening the egress: %v", err)
	}
	t.Cleanup(egress.close)
	return egress
}

// ── the allowlist ────────────────────────────────────────────────────────────

func TestSandboxEgressServesOnlyTheAllowlistedTarget(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	allowed := listener.Addr().String()

	egress := sandboxTestEgress(t, sandboxEgressPolicy{allowed: []string{allowed}})
	socket := egress.proxySocket()

	// The allowed target first. Without this the refusals below would be
	// consistent with a proxy that simply does not work.
	status, err := sandboxDialConnect("unix", socket, allowed)
	if err != nil {
		t.Fatalf("connecting to the proxy: %v", err)
	}
	if !strings.Contains(status, "200") {
		t.Fatalf("the allowlisted target answered %q, so a refusal proves nothing", status)
	}

	for _, target := range []string{
		"example.invalid:443", // a different host
		"127.0.0.1:1",         // a different port on a host that is allowed
		net.JoinHostPort(strings.Split(allowed, ":")[0], "22"), // the allowed host, unallowed port
	} {
		status, err := sandboxDialConnect("unix", socket, target)
		if err != nil {
			t.Fatalf("connecting to the proxy for %s: %v", target, err)
		}
		if !strings.Contains(status, "403") {
			t.Errorf("CONNECT %s answered %q; the allowlist must refuse it", target, status)
		}
	}

	// Every attempt is observable, because a refusal nobody can see cannot
	// become the evidence a receipt carries.
	log := egress.attemptLog()
	if len(log) != 4 {
		t.Fatalf("the egress recorded %d attempt(s), want 4: %+v", len(log), log)
	}
	if !log[0].Allowed {
		t.Errorf("the allowed attempt is recorded as refused: %+v", log[0])
	}
	for _, attempt := range log[1:] {
		if attempt.Allowed {
			t.Errorf("a refused attempt is recorded as allowed: %+v", attempt)
		}
		if attempt.Reason == "" {
			t.Errorf("a refusal was recorded with no reason: %+v", attempt)
		}
	}
}

func TestSandboxEgressServesNothingButConnect(t *testing.T) {
	egress := sandboxTestEgress(t, sandboxEgressPolicy{allowed: []string{"api.example:443"}})
	conn, err := net.Dial("unix", egress.proxySocket())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// An absolute-form GET is what a plain-HTTP proxy request looks like. It is
	// a route off the machine that never passes the CONNECT allowlist, so it
	// has to be refused rather than forwarded.
	if _, err := fmt.Fprint(conn, "GET http://example.invalid/ HTTP/1.1\r\nHost: example.invalid\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	status, err := sandboxReadStatusLine(conn)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(status, "405") {
		t.Errorf("a proxied GET answered %q; only CONNECT may be served", status)
	}
	if log := egress.attemptLog(); len(log) != 1 || log[0].Allowed {
		t.Errorf("the proxied GET was not recorded as a refusal: %+v", log)
	}
}

// ── the auth broker ──────────────────────────────────────────────────────────

// TestSandboxEgressRelaysALoopbackBroker covers the case this machine actually
// has: an auth broker on the host's own loopback, which OMP would never send
// through a proxy and which the sandbox has no host to reach. The relay is what
// keeps a networkless run able to authenticate.
func TestSandboxEgressRelaysALoopbackBroker(t *testing.T) {
	upstream := httptest.NewServer(nil)
	defer upstream.Close()

	policy, err := sandboxResolveEgress("api.example:443", upstream.URL+"/auth")
	if err != nil {
		t.Fatalf("resolving the egress: %v", err)
	}
	if len(policy.allowed) != 1 || policy.allowed[0] != "api.example:443" {
		t.Errorf("a loopback broker widened the CONNECT allowlist to %v; it must not", policy.allowed)
	}
	if policy.brokerAddr != strings.TrimPrefix(upstream.URL, "http://") {
		t.Errorf("the relay points at %q, want %q", policy.brokerAddr, strings.TrimPrefix(upstream.URL, "http://"))
	}
	want := "http://127.0.0.1:" + strconv.Itoa(sandboxBrokerPort) + "/auth"
	if policy.brokerURL != want {
		t.Errorf("the child would be told to use %q, want the sandbox's own loopback %q", policy.brokerURL, want)
	}

	// And the relay carries bytes, not just a path.
	egress := sandboxTestEgress(t, policy)
	conn, err := net.Dial("unix", egress.brokerSocket())
	if err != nil {
		t.Fatalf("dialling the broker relay: %v", err)
	}
	defer conn.Close()
	if _, err := fmt.Fprintf(conn, "GET /auth HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", policy.brokerAddr); err != nil {
		t.Fatal(err)
	}
	status, err := sandboxReadStatusLine(conn)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(status, "HTTP/1.1 ") {
		t.Errorf("the broker relay answered %q, which is not the broker", status)
	}
}

// TestSandboxEgressAllowlistsARemoteBroker is the other shape: a broker off this
// machine is an ordinary proxy target, so it joins the allowlist instead of
// getting a socket of its own.
func TestSandboxEgressAllowlistsARemoteBroker(t *testing.T) {
	policy, err := sandboxResolveEgress("api.example:443", "https://broker.example/auth")
	if err != nil {
		t.Fatalf("resolving the egress: %v", err)
	}
	if policy.brokerAddr != "" || policy.brokerURL != "" {
		t.Errorf("a remote broker was given a loopback relay: %+v", policy)
	}
	if len(policy.allowed) != 2 || policy.allowed[1] != "broker.example:443" {
		t.Errorf("the allowlist is %v, want the provider endpoint plus the broker", policy.allowed)
	}
}

func TestSandboxEgressNeedsAnEndpoint(t *testing.T) {
	if _, err := sandboxResolveEgress("", "http://127.0.0.1:9/auth"); err == nil {
		t.Fatal("an empty allowlist was accepted; a proxy with no target is either a stranded run " +
			"or an open boundary, and neither may be the default")
	}
	if _, err := newSandboxEgress(t.TempDir(), sandboxEgressPolicy{}); err == nil {
		t.Fatal("a proxy was opened with no allowlist at all")
	}
}

// ── the endpoint the allowlist comes from ────────────────────────────────────

func TestSandboxProviderEndpointFollowsTheProfile(t *testing.T) {
	for _, tc := range []struct {
		provider string
		want     string
	}{
		{anthropicProvider, "api.anthropic.com:443"},
		{openAIProvider, "chatgpt.com:443"},
		{deepseekProvider, "api.deepseek.com:443"},
	} {
		profile := resolvedProfile{Metadata: map[string]string{"provider": tc.provider}}
		got, endpoint, err := sandboxProviderEndpoint(profile)
		if err != nil {
			t.Fatalf("%s: %v", tc.provider, err)
		}
		if got != tc.provider || endpoint != tc.want {
			t.Errorf("%s resolved to %s/%s, want %s", tc.provider, got, endpoint, tc.want)
		}
	}

	// A provider Code cannot place is a refusal. Falling back to a default
	// vendor would allow a host this run has no business reaching, and falling
	// back to nothing would be an open proxy dressed as an empty one.
	for _, unknown := range []string{"", "unresolved", "some-local-runtime"} {
		profile := resolvedProfile{Metadata: map[string]string{"provider": unknown}}
		if _, endpoint, err := sandboxProviderEndpoint(profile); err == nil {
			t.Errorf("provider %q resolved to %q instead of failing", unknown, endpoint)
		}
	}
}

// ── the corpus ───────────────────────────────────────────────────────────────

func TestSandboxCorpusPathsBindOnlyRealPathsOutsideTheGuestLayout(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "transcript.jsonl")
	if err := os.WriteFile(file, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := sandboxCorpusPaths([]babelSource{
		{Kind: "path", Selector: dir},
		{Kind: "path", Selector: dir}, // a duplicate binds once
		{Kind: "path", Selector: file},
		{Kind: "session", Selector: "omp/synthetic-session"},     // not a path
		{Kind: "url", Selector: "https://example.invalid/thing"}, // not a path
		{Kind: "path", Selector: filepath.Join(dir, "absent")},   // does not exist
		{Kind: "path", Selector: sandboxWorkPath},                // the session's own cwd
		{Kind: "path", Selector: sandboxRoot},                    // the guest layout itself
	})
	want := []string{dir, file}
	if len(got) != len(want) {
		t.Fatalf("bound %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("bound[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

// TestSandboxCorpusNeverLandsOnTheSessionsWorkingDirectory is the rule that
// keeps untrusted archive material out of OMP's MCP discovery path. OMP
// registers MCP servers — which reach the network without passing Babel's
// evidence broker — from a config file at the root of its working directory,
// and archive content is untrusted by contract, so a corpus path that resolved
// into the guest layout would be a disclosure route opened by a file rather
// than by a decision.
func TestSandboxCorpusNeverLandsOnTheSessionsWorkingDirectory(t *testing.T) {
	for _, selector := range []string{
		sandboxRoot,
		sandboxWorkPath,
		sandboxHomePath,
		sandboxEgressDir,
		sandboxWorkPath + "/nested/corpus",
	} {
		if got := sandboxCorpusPaths([]babelSource{{Kind: "path", Selector: selector}}); len(got) != 0 {
			t.Errorf("selector %q was bound as corpus at %v, inside the sandbox's own layout", selector, got)
		}
	}
}
