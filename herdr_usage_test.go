package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type herdrUsageBroker struct {
	server   *httptest.Server
	requests atomic.Int32
}

func newHerdrUsageBroker(t *testing.T, snapshot, usage string) *herdrUsageBroker {
	t.Helper()
	fixture := &herdrUsageBroker{}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.requests.Add(1)
		if got := r.Header.Get("Authorization"); got != "Bearer fixture-token" {
			t.Errorf("authorization = %q, want fixture token", got)
		}
		switch r.URL.Path {
		case "/v1/snapshot":
			_, _ = io.WriteString(w, snapshot)
		case "/v1/usage":
			_, _ = io.WriteString(w, usage)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(fixture.server.Close)
	return fixture
}

func herdrUsageTokenFile(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "broker-token")
	if err := os.WriteFile(path, []byte("fixture-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func configureHerdrUsageVaults(t *testing.T, vaults []vault, state string) {
	t.Helper()
	dir := t.TempDir()
	manifestPath := filepath.Join(dir, "auth-vaults.json")
	manifest, err := json.Marshal(vaults)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(dir, "auth-state.json")
	if err := os.WriteFile(statePath, []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_AUTH_VAULTS", "")
	t.Setenv("CODE_AUTH_VAULTS_FILE", manifestPath)
	t.Setenv("CODE_AUTH_STATE", statePath)
}

func serveHerdrUsageSocket(t *testing.T, sessionsDir, session, response string) <-chan herdrTestCapture {
	t.Helper()
	dir := filepath.Join(sessionsDir, session)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", filepath.Join(dir, "herdr.sock"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	captured := make(chan herdrTestCapture, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			captured <- herdrTestCapture{err: err}
			return
		}
		defer conn.Close()
		line, err := bufio.NewReader(conn).ReadBytes('\n')
		if err == nil {
			_, err = io.WriteString(conn, response+"\n")
		}
		captured <- herdrTestCapture{line: line, err: err}
	}()
	return captured
}

func TestHerdrUsageGoldenRows(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tokenFile := herdrUsageTokenFile(t)
	first := newHerdrUsageBroker(t,
		`{"credentials":[
			{"provider":"openai-codex","identityKey":"codex-shared","credential":{"email":"Operator@example.test"}},
			{"provider":"anthropic","identityKey":"claude-ada","credential":{"email":"Ada@example.test"}}
		]}`,
		fmt.Sprintf(`{"reports":[
			{"provider":"openai-codex","limits":[
				{"label":"Codex 5 Hour","amount":{"usedFraction":0.20},"window":{"durationMs":18000000,"resetsAt":%d}}
			]},
			{"provider":"anthropic","limits":[
				{"label":"Claude core","amount":{"usedFraction":0.45},"window":{"id":"5h","resetsAt":%d}},
				{"label":"Claude weekly","amount":{"usedFraction":0.12},"window":{"durationMs":604800000,"resetsAt":%d}},
				{"label":"Claude 7 Day (Fable)","amount":{"usedFraction":0.67},"window":{"durationMs":604800000}},
				{"label":"Claude short","scope":{"tier":"spark"},"amount":{"usedFraction":0.25},"window":{"durationMs":18000000,"resetsAt":%d}},
				{"label":"Spark weekly","amount":{"usedFraction":0.75},"window":{"id":"7d","resetsAt":%d}}
			]}
		]}`,
			now.Add(30*time.Minute).UnixMilli(),
			now.Add(90*time.Minute).UnixMilli(),
			now.Add(8*24*time.Hour+5*time.Hour).UnixMilli(),
			now.Add(-time.Minute).UnixMilli(),
			now.Add(26*time.Hour).UnixMilli(),
		),
	)
	second := newHerdrUsageBroker(t,
		`{"credentials":[
			{"provider":"anthropic","identityKey":"claude-bea","credential":{"email":"Bea@example.test"}},
			{"provider":"openai-codex","identityKey":"codex-shared","credential":{"email":"operator@example.test"}}
		]}`,
		fmt.Sprintf(`{"reports":[
			{"provider":"anthropic","limits":[
				{"label":"Claude 7 Day","amount":{"usedFraction":0.50},"window":{"durationMs":604800000,"resetsAt":%d}}
			]},
			{"provider":"openai-codex","limits":[
				{"label":"Codex 5 Hour","amount":{"usedFraction":0.99},"window":{"durationMs":18000000,"resetsAt":%d}},
				{"label":"Codex 7 Day","amount":{"usedFraction":0.45},"window":{"durationMs":604800000,"resetsAt":%d}}
			]}
		]}`,
			now.Add(time.Hour).UnixMilli(),
			now.Add(10*time.Minute).UnixMilli(),
			now.Add(7*24*time.Hour).UnixMilli(),
		),
	)
	third := newHerdrUsageBroker(t,
		`{"credentials":[{"provider":"anthropic","identityKey":"claude-cygnus","credential":{}}]}`,
		fmt.Sprintf(`{"reports":[{"provider":"anthropic","limits":[
			{"label":"Claude 5 Hour","amount":{"usedFraction":1.20},"window":{"durationMs":18000000,"resetsAt":%d}}
		]}]}`,
			now.Add(59*time.Minute).UnixMilli(),
		),
	)
	configureHerdrUsageVaults(t, []vault{
		{ID: "alpha", Label: "Alpha", BrokerURL: first.server.URL, TokenFile: tokenFile},
		{ID: "beta", Label: "Beta", BrokerURL: second.server.URL, TokenFile: tokenFile},
		{ID: "cygnus", Label: "Cygnus", BrokerURL: third.server.URL, TokenFile: tokenFile},
	}, `{"selected":"alpha","disabled":[]}`)

	sessionsDir := t.TempDir()
	captured := serveHerdrUsageSocket(t, sessionsDir, "fixture", `{"id":"accepted","result":{}}`)
	result := runHerdrUsageCycle(now, sessionsDir, io.Discard)
	if result != (herdrUsageCycleResult{Rows: 12, Attempts: 1, Successes: 1}) {
		t.Fatalf("cycle result = %+v", result)
	}
	wire := readHerdrCapture(t, captured).line
	if len(wire) == 0 || wire[len(wire)-1] != '\n' || bytes.Count(wire, []byte{'\n'}) != 1 {
		t.Fatalf("request must be one newline-terminated JSON line: %q", wire)
	}
	var request struct {
		ID     string `json:"id"`
		Method string `json:"method"`
		Params struct {
			SectionID string          `json:"section_id"`
			Source    string          `json:"source"`
			Seq       int64           `json:"seq"`
			TTLMillis int             `json:"ttl_ms"`
			Rows      json.RawMessage `json:"rows"`
		} `json:"params"`
	}
	if err := json.Unmarshal(wire, &request); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(request.ID, "code:sidebar:report_section:") {
		t.Errorf("request id = %q", request.ID)
	}
	if request.Method != "sidebar.report_section" || request.Params.SectionID != "usage" ||
		request.Params.Source != "atyrode:usage" || request.Params.Seq != now.Unix() ||
		request.Params.TTLMillis != herdrUsageTTLMillis {
		t.Fatalf("socket envelope = method %q params %+v", request.Method, request.Params)
	}
	const wantRows = `[{"bar":{"fraction":0.45,"title":"ad* 5h","title_color":"#ff9f52","label":"45% ↻1h30m","fill":"#e1c846","empty":"#78829b"}},{"bar":{"fraction":0.12,"title":"ad* 7d","title_color":"#ff9f52","label":"12% ↻8d5h","fill":"#7ec846","empty":"#78829b"}},{"bar":{"fraction":0.67,"title":"ad* fa","title_color":"#ff9f52","label":"67%","fill":"#eb9546","empty":"#78829b"}},{"bar":{"fraction":0.25,"title":"ad* sp 5h","title_color":"#ff9f52","label":"25% ↻0m","fill":"#a5c846","empty":"#78829b"}},{"bar":{"fraction":0.75,"title":"ad* sp 7d","title_color":"#ff9f52","label":"75% ↻1d2h","fill":"#eb7d46","empty":"#78829b"}},{"spans":[]},{"bar":{"fraction":0.5,"title":"be* 7d","title_color":"#ff9f52","label":"50% ↻1h0m","fill":"#ebc846","empty":"#78829b"}},{"spans":[]},{"bar":{"fraction":1,"title":"cy* 5h","title_color":"#ff9f52","label":"100% ↻59m","fill":"#eb3c46","empty":"#78829b"}},{"spans":[]},{"bar":{"fraction":0.2,"title":"op* 5h","title_color":"#62a7ff","label":"20% ↻30m","fill":"#96c846","empty":"#78829b"}},{"bar":{"fraction":0.45,"title":"op* 7d","title_color":"#62a7ff","label":"45% ↻7d0h","fill":"#e1c846","empty":"#78829b"}}]`
	if got := string(request.Params.Rows); got != wantRows {
		t.Fatalf("rows JSON:\n got %s\nwant %s", got, wantRows)
	}
	if first.requests.Load() != 2 || second.requests.Load() != 2 || third.requests.Load() != 2 {
		t.Fatalf("broker calls = first %d second %d third %d, want snapshot+usage each",
			first.requests.Load(), second.requests.Load(), third.requests.Load())
	}
}

func TestHerdrUsageNameCollisions(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tokenFile := herdrUsageTokenFile(t)
	limit := `{"reports":[{"provider":"anthropic","limits":[{"label":"5 hours","amount":{"usedFraction":0.1},"window":{"durationMs":18000000}}]}]}`
	mum := newHerdrUsageBroker(t,
		`{"credentials":[{"provider":"anthropic","identityKey":"mum","credential":{"email":"mum@example.test"}}]}`,
		limit,
	)
	muriel := newHerdrUsageBroker(t,
		`{"credentials":[{"provider":"anthropic","identityKey":"muriel","credential":{"email":"muriel@example.test"}}]}`,
		limit,
	)
	rows := collectHerdrUsageRows([]vault{
		{ID: "mum", Label: "Mum", BrokerURL: mum.server.URL, TokenFile: tokenFile},
		{ID: "muriel", Label: "Muriel", BrokerURL: muriel.server.URL, TokenFile: tokenFile},
	}, nil, now, io.Discard)
	if len(rows) != 3 || rows[0].Bar == nil || rows[1].Spans == nil || rows[2].Bar == nil {
		t.Fatalf("collision rows = %#v", rows)
	}
	if rows[0].Bar.Title != "mum 5h" || rows[2].Bar.Title != "mur 5h" {
		t.Fatalf("collision titles = %q, %q, want mum and mur", rows[0].Bar.Title, rows[2].Bar.Title)
	}
}

func TestHerdrUsageDisabledVaultAndAbsentWindows(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tokenFile := herdrUsageTokenFile(t)
	enabled := newHerdrUsageBroker(t,
		`{"credentials":[{"provider":"anthropic","identityKey":"enabled","credential":{"email":"enabled@example.test"}}]}`,
		`{"reports":[{"provider":"anthropic","limits":[
			{"label":"Claude 5 Hour","amount":{"usedFraction":0.4},"window":{"durationMs":18000000}},
			{"label":"Claude 7 Day","amount":{},"window":{"durationMs":604800000}}
		]}]}`,
	)
	disabled := newHerdrUsageBroker(t,
		`{"credentials":[{"provider":"anthropic","identityKey":"disabled","credential":{"email":"disabled@example.test"}}]}`,
		`{"reports":[{"provider":"anthropic","limits":[{"label":"Claude 7 Day","amount":{"usedFraction":0.9},"window":{"durationMs":604800000}}]}]}`,
	)
	configureHerdrUsageVaults(t, []vault{
		{ID: "enabled", Label: "Enabled", BrokerURL: enabled.server.URL, TokenFile: tokenFile},
		{ID: "disabled", Label: "Disabled", BrokerURL: disabled.server.URL, TokenFile: tokenFile},
	}, `{"selected":"enabled","disabled":["disabled"]}`)
	sessionsDir := t.TempDir()
	captured := serveHerdrUsageSocket(t, sessionsDir, "only", `{"id":"accepted","result":{}}`)
	result := runHerdrUsageCycle(now, sessionsDir, io.Discard)
	if result != (herdrUsageCycleResult{Rows: 1, Attempts: 1, Successes: 1}) {
		t.Fatalf("cycle result = %+v", result)
	}
	var request struct {
		Params struct {
			Rows []herdrUsageRow `json:"rows"`
		} `json:"params"`
	}
	if err := json.Unmarshal(readHerdrCapture(t, captured).line, &request); err != nil {
		t.Fatal(err)
	}
	if len(request.Params.Rows) != 1 || request.Params.Rows[0].Bar == nil || request.Params.Rows[0].Bar.Title != "en* 5h" {
		t.Fatalf("reported-only rows = %#v", request.Params.Rows)
	}
	if disabled.requests.Load() != 0 {
		t.Fatalf("disabled vault received %d requests, want zero", disabled.requests.Load())
	}
}

func TestHerdrUsageRowCapWarns(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tokenFile := herdrUsageTokenFile(t)
	credentials := make([]string, 5)
	for i := range credentials {
		credentials[i] = fmt.Sprintf(`{"provider":"anthropic","identityKey":"account-%d","credential":{"email":"account%d@example.test"}}`, i, i)
	}
	broker := newHerdrUsageBroker(t,
		`{"credentials":[`+strings.Join(credentials, ",")+`]}`,
		`{"reports":[{"provider":"anthropic","limits":[
			{"label":"5 hours","amount":{"usedFraction":0.1},"window":{"durationMs":18000000}},
			{"label":"7 days","amount":{"usedFraction":0.2},"window":{"durationMs":604800000}},
			{"label":"Fable 7 days","amount":{"usedFraction":0.3},"window":{"durationMs":604800000}},
			{"label":"Spark 5 hours","amount":{"usedFraction":0.4},"window":{"durationMs":18000000}},
			{"label":"Spark 7 days","amount":{"usedFraction":0.5},"window":{"durationMs":604800000}}
		]}]}`,
	)
	var stderr bytes.Buffer
	rows := collectHerdrUsageRows([]vault{{
		ID: "accounts", Label: "Accounts", BrokerURL: broker.server.URL, TokenFile: tokenFile,
	}}, nil, now, &stderr)
	if len(rows) != herdrUsageMaxRows {
		t.Fatalf("row count = %d, want %d", len(rows), herdrUsageMaxRows)
	}
	if rows[len(rows)-1].Spans == nil {
		t.Fatal("cap must keep the literal first 24 rows, including the trailing separator")
	}
	if got := stderr.String(); !strings.Contains(got, "truncated from 29 to 24") {
		t.Fatalf("truncation warning = %q", got)
	}
}

func TestHerdrUsageZeroRowsDoesNotPublish(t *testing.T) {
	configureHerdrUsageVaults(t, []vault{{ID: "empty", Label: "Empty"}}, `{"selected":"empty","disabled":[]}`)
	sessionsDir := t.TempDir()
	socketDir := filepath.Join(sessionsDir, "uncontacted")
	if err := os.MkdirAll(socketDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(socketDir, "herdr.sock"), []byte("not contacted"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := runHerdrUsageCycle(time.Unix(1_700_000_000, 0), sessionsDir, io.Discard)
	if result != (herdrUsageCycleResult{}) {
		t.Fatalf("zero-row cycle attempted a publish: %+v", result)
	}
}

func TestHerdrUsageEverySocketFailureIsTerminal(t *testing.T) {
	tokenFile := herdrUsageTokenFile(t)
	broker := newHerdrUsageBroker(t,
		`{"credentials":[{"provider":"anthropic","identityKey":"account","credential":{"email":"account@example.test"}}]}`,
		`{"reports":[{"provider":"anthropic","limits":[{"label":"5 hours","amount":{"usedFraction":0.1},"window":{"durationMs":18000000}}]}]}`,
	)
	configureHerdrUsageVaults(t, []vault{{
		ID: "account", Label: "Account", BrokerURL: broker.server.URL, TokenFile: tokenFile,
	}}, `{"selected":"account","disabled":[]}`)
	sessionsDir := t.TempDir()
	for _, session := range []string{"first", "second"} {
		dir := filepath.Join(sessionsDir, session)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "herdr.sock"), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var stderr bytes.Buffer
	result := runHerdrUsageCycle(time.Unix(1_700_000_000, 0), sessionsDir, &stderr)
	if result != (herdrUsageCycleResult{Rows: 1, Attempts: 2}) || !result.allPublishesFailed() {
		t.Fatalf("failed publish result = %+v", result)
	}
	if got := strings.Count(stderr.String(), "code herdr-usage: publish "); got != 2 {
		t.Fatalf("socket errors = %d, want 2: %q", got, stderr.String())
	}
}

func TestHerdrRequestErrorEnvelope(t *testing.T) {
	socketPath, captured := serveHerdrResponse(t, `{"id":"x","error":{"code":"section_rejected","message":"bad rows"}}`)
	err := herdrRequest(socketPath, "sidebar.report_section", map[string]any{"rows": []any{}})
	readHerdrCapture(t, captured)
	if err == nil || !strings.Contains(err.Error(), "section_rejected") || !strings.Contains(err.Error(), "bad rows") {
		t.Fatalf("error envelope = %v", err)
	}
}

func TestHerdrRequestUsesOneConnectionPerRequest(t *testing.T) {
	socketPath, captured := serveHerdrResponses(t,
		`{"id":"one","result":{}}`,
		`{"id":"two","result":{}}`,
	)
	for seq := range 2 {
		if err := herdrRequest(socketPath, "sidebar.report_section", map[string]int{"seq": seq}); err != nil {
			t.Fatal(err)
		}
	}
	exchange := readHerdrSequence(t, captured)
	if len(exchange.lines) != 2 {
		t.Fatalf("connections captured %d requests, want 2", len(exchange.lines))
	}
	for i, line := range exchange.lines {
		if len(line) == 0 || line[len(line)-1] != '\n' || bytes.Count(line, []byte{'\n'}) != 1 {
			t.Fatalf("request %d is not one JSON line: %q", i, line)
		}
	}
}

func TestHerdrUsageIntervalJitter(t *testing.T) {
	interval, err := parseHerdrUsageInterval("300")
	if err != nil || interval != 5*time.Minute {
		t.Fatalf("300 second interval = %v, %v", interval, err)
	}
	for range 1000 {
		got := jitterHerdrUsageInterval(interval)
		if got < 270*time.Second || got > 330*time.Second {
			t.Fatalf("jittered interval = %v, outside ±10%%", got)
		}
	}
	for _, invalid := range []string{"", "nope", "0", "-1"} {
		if _, err := parseHerdrUsageInterval(invalid); err == nil {
			t.Errorf("interval %q was accepted", invalid)
		}
	}
}
