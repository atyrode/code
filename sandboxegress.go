package main

// The sandbox's only route off the machine.
//
// The sandbox has no network interface but its own loopback, which is the
// property the containment declaration calls network default-deny. An analysis
// still has to reach a provider, so the boundary has exactly one hole and this
// file is all of it:
//
//	OMP ──▶ 127.0.0.1:3128 ──▶ unix socket ──▶ CONNECT proxy ──▶ provider:443
//	    (in the sandbox)      (bind-mounted)   (on the host, Code's)
//
// The split matters. The listener inside the sandbox forwards bytes and decides
// nothing; the proxy that decides is outside, in Code's own process, where a
// compromised OMP cannot rewrite its allowlist. The bind-mounted unix socket is
// what lets the two halves meet without giving the sandbox an interface, a
// route or a resolver — the provider's name is resolved host-side, by the
// proxy, because inside there is nothing to resolve it with.
//
// Every CONNECT target is recorded, allowed or refused, and the record travels
// in the run's result payload. A refusal that nobody can see is not evidence.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// sandboxDialTimeout bounds one upstream connection. A provider that will not
// answer must fail the tunnel rather than hold a sandbox connection open.
const sandboxDialTimeout = 20 * time.Second

// sandboxSocketPathMax is the usable length of a unix socket address. sun_path
// is 108 bytes and the last one is the terminator.
const sandboxSocketPathMax = 107

// ── the host side ────────────────────────────────────────────────────────────

// sandboxConnect is one CONNECT the sandbox attempted. Refused is the
// interesting case: it is the observable form of the boundary holding.
type sandboxConnect struct {
	Target  string `json:"target"`
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason,omitempty"`
}

// sandboxEgress is the host-side half: one listening unix socket that speaks
// HTTP CONNECT against a fixed allowlist, and optionally further sockets that
// relay straight through to a service on this host — the auth broker Code
// itself uses, and the local model endpoint a local-lane run is served from.
//
// Those need their own sockets rather than allowlist entries because a loopback
// or private target is one OMP's fetch never sends to a proxy — the bypass rule
// is exactly right for a host-side service and exactly wrong for a sandbox that
// has no such host. Relaying them as raw streams, and rewriting the URL the
// child is given to point at the sandbox's own loopback, is what keeps the run
// working without opening the proxy to anything private.
type sandboxEgress struct {
	dir    string
	proxy  net.Listener
	broker net.Listener
	model  net.Listener
	policy sandboxEgressPolicy
	allow  map[string]bool

	mu       sync.Mutex
	attempts []sandboxConnect

	closeOnce sync.Once
}

// sandboxEgressPolicy is what the run may reach, decided before any socket
// exists. It is separated from the listeners because the containment
// declaration has to describe the boundary before Babel has accepted the run,
// and opening a proxy for a run that is then refused would be a hole punched
// for nothing.
type sandboxEgressPolicy struct {
	// allowed is every host:port the CONNECT proxy will dial: the provider
	// endpoint, plus the auth broker when it lives off this machine. It is
	// empty for a local-lane run, which reaches nothing off this machine at
	// all.
	allowed []string
	// brokerAddr is the host-side address the second socket relays to, empty
	// when no relay is needed.
	brokerAddr string
	// brokerURL is what the child is told to use instead of the real one, so
	// its requests land on the sandbox's own loopback.
	brokerURL string
	// modelAddr is the host-side address of a local-lane run's model endpoint,
	// relayed the same way, and modelURL is what the child is told to call
	// instead (locallane.go). Both empty for a hosted run.
	modelAddr string
	modelURL  string
}

// routed reports whether the policy gives the run any way to reach a model at
// all. An allowlist can legitimately be empty — a local run reaches nothing off
// this machine — but a policy with no allowlist and no relay would strand the
// analysis behind a boundary with no hole in it.
func (p sandboxEgressPolicy) routed() bool {
	return len(p.allowed) > 0 || p.brokerAddr != "" || p.modelAddr != ""
}

// sandboxResolveEgress decides the run's allowlist.
//
// endpoint is the provider the resolved profile names. brokerURL is the auth
// broker Code resolved for this run: a broker on this machine is relayed as a
// raw stream, because OMP never sends a loopback or private target through a
// proxy and there is no such host inside the sandbox anyway; a broker anywhere
// else is an ordinary proxy target and joins the allowlist. Either way the run
// can authenticate and nothing else becomes reachable.
func sandboxResolveEgress(endpoint, brokerURL string) (sandboxEgressPolicy, error) {
	if endpoint == "" {
		return sandboxEgressPolicy{}, errors.New("the sandbox egress needs an allowed endpoint; an empty " +
			"allowlist would either strand the analysis or, read as no restriction, open the boundary")
	}
	policy := sandboxEgressPolicy{allowed: []string{endpoint}}
	if brokerURL == "" {
		return policy, nil
	}
	parsed, err := url.Parse(brokerURL)
	if err != nil {
		return sandboxEgressPolicy{}, fmt.Errorf("the auth broker URL is unusable, so the sandbox cannot "+
			"be given a route to it: %w", err)
	}
	addr, err := sandboxHostPort(parsed)
	if err != nil {
		return sandboxEgressPolicy{}, err
	}
	if sandboxLocalAddr(parsed.Hostname()) {
		policy.brokerAddr = addr
		rewritten := *parsed
		rewritten.Host = net.JoinHostPort("127.0.0.1", strconv.Itoa(sandboxBrokerPort))
		policy.brokerURL = rewritten.String()
		return policy, nil
	}
	if addr != endpoint {
		policy.allowed = append(policy.allowed, addr)
	}
	return policy, nil
}

// sandboxResolveLocalEgress decides a local-lane run's egress: nothing on the
// CONNECT allowlist at all, and a raw relay to the model endpoint on this host
// (locallane.go).
//
// An empty allowlist is the stronger boundary rather than a gap in one. The
// proxy still runs and still refuses — and records — every target, so a
// compromised session has no route to the network whatsoever; the one thing it
// can reach is the daemon this run's own model is served by, which the escape
// statement names.
//
// The auth broker is not relayed because a local run resolves no credential to
// authenticate with (locallane.go, resolveCredential): there is nothing for it
// to ask a broker for.
func sandboxResolveLocalEgress(endpoint string) (sandboxEgressPolicy, error) {
	addr, err := localHostPort(endpoint)
	if err != nil {
		return sandboxEgressPolicy{}, fmt.Errorf("the local endpoint %q has no address the sandbox could "+
			"be given a route to: %w", endpoint, err)
	}
	guest, err := localGuestBase(endpoint, sandboxModelPort)
	if err != nil {
		return sandboxEgressPolicy{}, fmt.Errorf("the local endpoint %q cannot be rewritten to the "+
			"sandbox's loopback: %w", endpoint, err)
	}
	return sandboxEgressPolicy{modelAddr: addr, modelURL: guest}, nil
}

// newSandboxEgress opens the run's egress sockets in dir and starts serving
// them. Nothing here decides anything the policy did not already decide.
func newSandboxEgress(dir string, policy sandboxEgressPolicy) (*sandboxEgress, error) {
	if !policy.routed() {
		return nil, errors.New("the sandbox egress was given no route at all: no allowlist, no broker " +
			"relay and no model relay, which would strand the analysis behind a boundary with no hole")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	// sun_path is 108 bytes on Linux and the kernel truncates rather than
	// complains, so a long TMPDIR would otherwise surface as "invalid argument"
	// on a listen and be diagnosed as anything but the path length.
	if longest := filepath.Join(dir, "broker.sock"); len(longest) >= sandboxSocketPathMax {
		return nil, fmt.Errorf("the run's egress socket path is %d bytes (%s), past the %d a unix "+
			"socket address holds; set TMPDIR to something shorter for this worker",
			len(longest), dir, sandboxSocketPathMax)
	}
	e := &sandboxEgress{dir: dir, policy: policy, allow: make(map[string]bool, len(policy.allowed))}
	for _, target := range policy.allowed {
		e.allow[target] = true
	}
	proxy, err := net.Listen("unix", filepath.Join(dir, "proxy.sock"))
	if err != nil {
		return nil, err
	}
	e.proxy = proxy
	if policy.brokerAddr != "" {
		broker, err := net.Listen("unix", filepath.Join(dir, "broker.sock"))
		if err != nil {
			_ = proxy.Close()
			return nil, err
		}
		e.broker = broker
	}
	if policy.modelAddr != "" {
		local, err := net.Listen("unix", filepath.Join(dir, "model.sock"))
		if err != nil {
			_ = proxy.Close()
			if e.broker != nil {
				_ = e.broker.Close()
			}
			return nil, err
		}
		e.model = local
	}
	go e.serveProxy()
	if e.broker != nil {
		go e.serveBroker()
	}
	if e.model != nil {
		go e.serveModel()
	}
	return e, nil
}

// sandboxHostPort renders a URL's authority with the scheme's default port
// filled in, because an allowlist entry and a dial target have to be the same
// string.
func sandboxHostPort(u *url.URL) (string, error) {
	host := u.Hostname()
	if host == "" {
		return "", fmt.Errorf("the URL %q names no host", u.Redacted())
	}
	port := u.Port()
	if port == "" {
		switch u.Scheme {
		case "https":
			port = "443"
		case "http":
			port = "80"
		default:
			return "", fmt.Errorf("the URL %q uses scheme %q, which has no default port", u.Redacted(), u.Scheme)
		}
	}
	return net.JoinHostPort(host, port), nil
}

// sandboxLocalAddr reports whether a host is one OMP would refuse to send
// through a proxy: loopback, link-local, or an RFC1918 range. It is the same
// question OMP's bypass rule asks, asked here so the two agree.
func sandboxLocalAddr(host string) bool {
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsPrivate() || ip.IsUnspecified()
}

func (e *sandboxEgress) proxySocket() string { return filepath.Join(e.dir, "proxy.sock") }

func (e *sandboxEgress) brokerSocket() string {
	if e.broker == nil {
		return ""
	}
	return filepath.Join(e.dir, "broker.sock")
}

func (e *sandboxEgress) modelSocket() string {
	if e.model == nil {
		return ""
	}
	return filepath.Join(e.dir, "model.sock")
}

// describe is the non-secret summary the escape statement names.
func (e *sandboxEgress) describe(provider string) sandboxEgressDescription {
	return sandboxEgressDescription{
		provider: provider,
		allowed:  append([]string(nil), e.policy.allowed...),
		relay:    e.broker != nil,
		local:    e.policy.modelAddr,
	}
}

// attemptLog is every CONNECT the sandbox made, in order. It is copied into the
// run's result payload so a reviewer can see what the worker tried to reach.
func (e *sandboxEgress) attemptLog() []sandboxConnect {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]sandboxConnect(nil), e.attempts...)
}

func (e *sandboxEgress) record(target string, allowed bool, reason string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.attempts = append(e.attempts, sandboxConnect{Target: target, Allowed: allowed, Reason: reason})
}

func (e *sandboxEgress) close() {
	e.closeOnce.Do(func() {
		if e.proxy != nil {
			_ = e.proxy.Close()
		}
		if e.broker != nil {
			_ = e.broker.Close()
		}
		if e.model != nil {
			_ = e.model.Close()
		}
		_ = os.RemoveAll(e.dir)
	})
}

func (e *sandboxEgress) serveProxy() {
	for {
		conn, err := e.proxy.Accept()
		if err != nil {
			return
		}
		go e.handleConnect(conn)
	}
}

func (e *sandboxEgress) serveBroker() {
	for {
		conn, err := e.broker.Accept()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			upstream, err := net.DialTimeout("tcp", e.policy.brokerAddr, sandboxDialTimeout)
			if err != nil {
				return
			}
			defer upstream.Close()
			sandboxSplice(conn, upstream)
		}()
	}
}

// serveModel relays a local-lane run's model calls to the endpoint on this
// host. It is serveBroker's twin and decides nothing either: the address it
// dials was fixed by the policy before any socket existed.
func (e *sandboxEgress) serveModel() {
	for {
		conn, err := e.model.Accept()
		if err != nil {
			return
		}
		go func() {
			defer conn.Close()
			upstream, err := net.DialTimeout("tcp", e.policy.modelAddr, sandboxDialTimeout)
			if err != nil {
				return
			}
			defer upstream.Close()
			sandboxSplice(conn, upstream)
		}()
	}
}

// handleConnect serves one request from inside the sandbox. Only CONNECT to an
// allowlisted target is served; everything else — a different method, an
// absolute-form request, an unlisted host, a port other than the one allowed —
// is refused with a status the client can read and recorded so the refusal
// becomes evidence.
func (e *sandboxEgress) handleConnect(conn net.Conn) {
	defer conn.Close()
	reader := bufio.NewReader(conn)
	request, err := http.ReadRequest(reader)
	if err != nil {
		return
	}
	if request.Method != http.MethodConnect {
		target := request.Method + " " + request.URL.Redacted()
		e.record(target, false, "only CONNECT is served")
		sandboxRefuse(conn, http.StatusMethodNotAllowed,
			"this proxy serves CONNECT only; the sandbox has no other route off the machine")
		return
	}
	target := request.URL.Host
	if target == "" {
		target = request.Host
	}
	if !e.allow[target] {
		e.record(target, false, "not on the run's allowlist")
		sandboxRefuse(conn, http.StatusForbidden,
			"the sandbox may reach "+strings.Join(e.policy.allowed, ", ")+" and nothing else")
		return
	}
	upstream, err := net.DialTimeout("tcp", target, sandboxDialTimeout)
	if err != nil {
		e.record(target, true, "allowed but unreachable")
		sandboxRefuse(conn, http.StatusBadGateway, "the allowed endpoint did not answer")
		return
	}
	defer upstream.Close()
	e.record(target, true, "")
	if _, err := io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	// reader may already hold the client's first TLS bytes, so the tunnel reads
	// through it rather than from the connection.
	sandboxSpliceReader(conn, reader, upstream)
}

func sandboxRefuse(conn net.Conn, status int, reason string) {
	body := reason + "\n"
	fmt.Fprintf(conn, "HTTP/1.1 %d %s\r\nContent-Type: text/plain\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s",
		status, http.StatusText(status), len(body), body)
}

// sandboxSplice copies in both directions until either side ends, then tears
// the other down so neither half can hold a goroutine open.
func sandboxSplice(a, b net.Conn) { sandboxSpliceReader(a, a, b) }

func sandboxSpliceReader(a net.Conn, aRead io.Reader, b net.Conn) {
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(b, aRead); done <- struct{}{} }()
	go func() { _, _ = io.Copy(a, b); done <- struct{}{} }()
	<-done
	_ = a.SetDeadline(time.Now())
	_ = b.SetDeadline(time.Now())
	<-done
}

// ── the sandbox side ─────────────────────────────────────────────────────────

// runSandboxEgressHelper is Code, inside the sandbox, wrapping the OMP session.
//
// It exists because two things have to be true at once in there: a loopback
// address has to answer as a proxy, and the process Babel is really interested
// in has to own stdin, stdout and stderr. So this starts the forwarders, spawns
// OMP with the descriptors it was given, and becomes a thin parent that
// forwards a signal down and exits with the child's status.
//
// It also measures the scratch tmpfs on the way out. That measurement is
// unobservable from the host — which is the whole point of the tmpfs — so a
// receipt would otherwise have to report zero bytes written, and zero is a
// claim rather than an absence.
func runSandboxEgressHelper(spec sandboxSpec, argv []string) int {
	if spec.ProxyPort > 0 && spec.ProxySocket != "" {
		if err := sandboxForward(spec.ProxyPort, spec.ProxySocket); err != nil {
			fmt.Fprintln(os.Stderr, "code: __sandbox egress: proxy forwarder:", err)
			return 2
		}
	}
	if spec.BrokerPort > 0 && spec.BrokerSocket != "" {
		if err := sandboxForward(spec.BrokerPort, spec.BrokerSocket); err != nil {
			fmt.Fprintln(os.Stderr, "code: __sandbox egress: broker forwarder:", err)
			return 2
		}
	}
	if spec.ModelPort > 0 && spec.ModelSocket != "" {
		if err := sandboxForward(spec.ModelPort, spec.ModelSocket); err != nil {
			fmt.Fprintln(os.Stderr, "code: __sandbox egress: model forwarder:", err)
			return 2
		}
	}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "code: __sandbox egress:", err)
		return 2
	}
	// The helper may be the first process in the sandbox's PID namespace, where
	// a default signal disposition does not exist, so termination is forwarded
	// explicitly rather than relied upon.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer signal.Stop(signals)
	go func() {
		for sig := range signals {
			if cmd.Process != nil {
				_ = cmd.Process.Signal(sig)
			}
		}
	}()

	status := childStatus(cmd.Wait())
	sandboxWriteExitReport(spec)
	return status
}

// sandboxForward puts a TCP listener on the sandbox's loopback in front of a
// bind-mounted unix socket. It decides nothing: the allowlist lives outside,
// where this process cannot reach it.
func sandboxForward(port int, socket string) error {
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return err
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				upstream, err := net.Dial("unix", socket)
				if err != nil {
					return
				}
				defer upstream.Close()
				sandboxSplice(conn, upstream)
			}()
		}
	}()
	return nil
}

// sandboxWriteExitReport hands the scratch measurement back over the descriptor
// Code kept the read end of. A closed or absent descriptor is not an error: the
// report is a nicety and the run's outcome does not depend on it.
func sandboxWriteExitReport(spec sandboxSpec) {
	if len(spec.Scratch) == 0 {
		return
	}
	pipe := os.NewFile(sandboxReportFD, "sandbox-report")
	if pipe == nil {
		return
	}
	defer pipe.Close()
	body, err := json.Marshal(sandboxExitReport{BytesWritten: sandboxScratchBytes(spec.Scratch)})
	if err != nil {
		return
	}
	_, _ = pipe.Write(append(body, '\n'))
}

// sandboxReadExitReport reads what the helper wrote, bounded and without
// blocking the run: the pipe is closed when the sandbox dies, so a helper that
// never reported simply yields nothing.
func sandboxReadExitReport(ctx context.Context, pipe *os.File) (sandboxExitReport, bool) {
	if pipe == nil {
		return sandboxExitReport{}, false
	}
	type outcome struct {
		report sandboxExitReport
		ok     bool
	}
	results := make(chan outcome, 1)
	go func() {
		body, err := io.ReadAll(io.LimitReader(pipe, 4<<10))
		if err != nil || len(body) == 0 {
			results <- outcome{}
			return
		}
		var report sandboxExitReport
		if json.Unmarshal([]byte(strings.TrimSpace(string(body))), &report) != nil {
			results <- outcome{}
			return
		}
		results <- outcome{report: report, ok: true}
	}()
	select {
	case got := <-results:
		return got.report, got.ok
	case <-ctx.Done():
		return sandboxExitReport{}, false
	}
}
