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
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
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
	if result != (herdrUsageCycleResult{Rows: 13, Attempts: 1, Successes: 1}) {
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
		request.Params.Source != "atyrode:usage" || request.Params.Seq != now.UnixMilli() ||
		request.Params.TTLMillis != herdrUsageTTLMillis {
		t.Fatalf("socket envelope = method %q params %+v", request.Method, request.Params)
	}
	const wantRows = `[` +
		`{"spans":[]},` +
		`{"bar":{"fraction":0.2,"title":"op* 5h","title_spans":[{"text":"op* ","color":"#62a7ff","dim":true},{"text":"5h","color":"#62a7ff"}],"title_color":"#62a7ff","label":" 20% ↻   30m","label_spans":[{"text":" 20%","color":"subtext0"},{"text":" ↻   30m","color":"#c8d0dc"}],"match_values":["broker:first","broker:second"],"fill":"#96c846","empty":"#78829b"}},` +
		`{"bar":{"fraction":0.45,"title":"op* 7d","title_spans":[{"text":"op* ","color":"#62a7ff","dim":true},{"text":"7d","color":"#62a7ff"}],"title_color":"#62a7ff","label":" 45% ↻  7d0h","label_spans":[{"text":" 45%","color":"subtext0"},{"text":" ↻  7d0h","color":"#78829b","dim":true}],"match_values":["broker:first","broker:second"],"fill":"#e1c846","empty":"#78829b"}},` +
		`{"spans":[]},` +
		`{"bar":{"fraction":0.45,"title":"ad* 5h","title_spans":[{"text":"ad* ","color":"#ff9f52","dim":true},{"text":"5h","color":"#ff9f52"}],"title_color":"#ff9f52","label":" 45% ↻ 1h30m","label_spans":[{"text":" 45%","color":"subtext0"},{"text":" ↻ 1h30m","color":"#78829b","dim":true}],"match_values":["broker:first"],"fill":"#e1c846","empty":"#78829b"}},` +
		`{"bar":{"fraction":0.12,"title":"ad* 7d","title_spans":[{"text":"ad* ","color":"#ff9f52","dim":true},{"text":"7d","color":"#ff9f52"}],"title_color":"#ff9f52","label":" 12% ↻  8d5h","label_spans":[{"text":" 12%","color":"subtext0"},{"text":" ↻  8d5h","color":"#78829b","dim":true}],"match_values":["broker:first"],"fill":"#7ec846","empty":"#78829b"}},` +
		`{"bar":{"fraction":0.67,"title":"ad* 7d fa","title_spans":[{"text":"ad* ","color":"#ff9f52","dim":true},{"text":"7d fa","color":"#ff9f52"}],"title_color":"#ff9f52","label":" 67%        ","label_spans":[{"text":" 67%        ","color":"subtext0"}],"match_values":["broker:first"],"fill":"#eb9546","empty":"#78829b"}},` +
		`{"bar":{"fraction":0.25,"title":"ad* 5h sp","title_spans":[{"text":"ad* ","color":"#ff9f52","dim":true},{"text":"5h sp","color":"#ff9f52"}],"title_color":"#ff9f52","label":" 25% ↻    0m","label_spans":[{"text":" 25%","color":"subtext0"},{"text":" ↻    0m","color":"#c8d0dc","bold":true}],"match_values":["broker:first"],"fill":"#a5c846","empty":"#78829b"}},` +
		`{"bar":{"fraction":0.75,"title":"ad* 7d sp","title_spans":[{"text":"ad* ","color":"#ff9f52","dim":true},{"text":"7d sp","color":"#ff9f52"}],"title_color":"#ff9f52","label":" 75% ↻  1d2h","label_spans":[{"text":" 75%","color":"subtext0"},{"text":" ↻  1d2h","color":"#78829b","dim":true}],"match_values":["broker:first"],"fill":"#eb7d46","empty":"#78829b"}},` +
		`{"spans":[]},` +
		`{"bar":{"fraction":0.5,"title":"be* 7d","title_spans":[{"text":"be* ","color":"#ff9f52","dim":true},{"text":"7d","color":"#ff9f52"}],"title_color":"#ff9f52","label":" 50% ↻  1h0m","label_spans":[{"text":" 50%","color":"subtext0"},{"text":" ↻  1h0m","color":"#c8d0dc","bold":true}],"match_values":["broker:second"],"fill":"#ebc846","empty":"#78829b"}},` +
		`{"spans":[]},` +
		`{"bar":{"fraction":1,"title":"cy* 5h","title_spans":[{"text":"cy* ","color":"#ff9f52","dim":true},{"text":"5h","color":"#ff9f52"}],"title_color":"#ff9f52","label":"100% ↻   59m","label_spans":[{"text":"100%","color":"subtext0"},{"text":" ↻   59m","color":"#c8d0dc"}],"match_values":["broker:third"],"fill":"#eb3c46","empty":"#78829b"}}` +
		`]`
	gotRows := strings.NewReplacer(
		first.server.URL, "broker:first",
		second.server.URL, "broker:second",
		third.server.URL, "broker:third",
	).Replace(string(request.Params.Rows))
	if gotRows != wantRows {
		t.Fatalf("rows JSON:\n got %s\nwant %s", gotRows, wantRows)
	}
	if first.requests.Load() != 2 || second.requests.Load() != 2 || third.requests.Load() != 2 {
		t.Fatalf("broker calls = first %d second %d third %d, want snapshot+usage each",
			first.requests.Load(), second.requests.Load(), third.requests.Load())
	}
}

func TestHerdrUsageLabelsShareDisplayWidth(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tokenFile := herdrUsageTokenFile(t)
	broker := newHerdrUsageBroker(t,
		`{"credentials":[{"provider":"anthropic","identityKey":"grid","credential":{"email":"grid@example.test"}}]}`,
		fmt.Sprintf(`{"reports":[{"provider":"anthropic","limits":[
			{"label":"5 hours","amount":{"usedFraction":0.05},"window":{"durationMs":18000000,"resetsAt":%d}},
			{"label":"7 days","amount":{"usedFraction":0.42},"window":{"durationMs":604800000,"resetsAt":%d}},
			{"label":"Fable 7 days","amount":{"usedFraction":1},"window":{"durationMs":604800000,"resetsAt":%d}},
			{"label":"Spark 5 hours","amount":{"usedFraction":0.08},"window":{"durationMs":18000000}}
		]}]}`,
			now.Add(30*time.Minute).UnixMilli(),
			now.Add(4*time.Hour+29*time.Minute).UnixMilli(),
			now.Add(13*time.Hour+39*time.Minute).UnixMilli(),
		),
	)

	rows := collectHerdrUsageRows([]vault{{
		ID: "grid", Label: "Grid", BrokerURL: broker.server.URL, TokenFile: tokenFile,
	}}, nil, now, io.Discard)
	wantLabels := []string{
		"  5% \u21bb    30m",
		" 42% \u21bb  4h29m",
		"100% \u21bb 13h39m",
		"  8%\x20\x20\x20\x20\x20\x20\x20\x20\x20",
	}
	wantTitles := []string{"gr* 5h", "gr* 7d", "gr* 7d fa", "gr* 5h sp"}
	wantLabelSpans := [][]herdrUsageSpan{
		{
			{Text: "  5%", Color: "subtext0"},
			{Text: " \u21bb    30m", Color: "#c8d0dc"},
		},
		{
			{Text: " 42%", Color: "subtext0"},
			{Text: " \u21bb  4h29m", Color: "#c8d0dc", Bold: true},
		},
		{
			{Text: "100%", Color: "subtext0"},
			{Text: " \u21bb 13h39m", Color: "#c8d0dc", Bold: true},
		},
		{{Text: wantLabels[3], Color: "subtext0"}},
	}
	if len(rows) != len(wantLabels) {
		t.Fatalf("row count = %d, want %d", len(rows), len(wantLabels))
	}
	const wantDisplayWidth = 13
	for i, expected := range wantLabels {
		if rows[i].Bar == nil {
			t.Fatalf("row %d = %#v, want bar", i, rows[i])
		}
		if got := rows[i].Bar.Label; got != expected {
			t.Errorf("label %d = %q, want %q", i, got, expected)
		}
		if got := rows[i].Bar.Title; got != wantTitles[i] {
			t.Errorf("title %d = %q, want %q", i, got, wantTitles[i])
		}
		spans := rows[i].Bar.TitleSpans
		if len(spans) != 2 {
			t.Fatalf("title spans %d = %#v, want account + window", i, spans)
		}
		accountTitle := "gr* "
		windowTitle := strings.TrimPrefix(wantTitles[i], accountTitle)
		if spans[0] != (herdrUsageSpan{
			Text: accountTitle, Color: "#ff9f52", Dim: true,
		}) || spans[1] != (herdrUsageSpan{
			Text: windowTitle, Color: "#ff9f52",
		}) {
			t.Errorf("title spans %d = %#v", i, spans)
		}
		labelSpans := rows[i].Bar.LabelSpans
		if len(labelSpans) != len(wantLabelSpans[i]) {
			t.Fatalf("label spans %d = %#v, want %#v", i, labelSpans, wantLabelSpans[i])
		}
		for spanIndex, want := range wantLabelSpans[i] {
			if got := labelSpans[spanIndex]; got != want {
				t.Errorf("label span %d:%d = %#v, want %#v", i, spanIndex, got, want)
			}
		}
		var joined strings.Builder
		for _, span := range labelSpans {
			joined.WriteString(span.Text)
		}
		if got := joined.String(); got != expected {
			t.Errorf("joined label spans %d = %q, want %q", i, got, expected)
		}
		if got := rows[i].Bar.MatchValues; len(got) != 1 || got[0] != broker.server.URL {
			t.Errorf("match values %d = %#v, want broker URL", i, got)
		}
		// Labels contain ASCII plus one-cell ↻, so rune count is terminal width.
		if got := utf8.RuneCountInString(rows[i].Bar.Label); got != wantDisplayWidth {
			t.Errorf("label %d display width = %d, want %d", i, got, wantDisplayWidth)
		}
	}
}

func TestHerdrUsageResetSpanUrgency(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	duration := int64((5 * time.Hour) / time.Millisecond)
	tests := []struct {
		name      string
		remaining time.Duration
		duration  int64
		want      herdrUsageSpan
	}{
		{
			name:      "unknown duration remains dim",
			remaining: 30 * time.Minute,
			want:      herdrUsageSpan{Text: " \u21bb 30m", Color: "#78829b", Dim: true},
		},
		{
			name:      "far reset remains dim",
			remaining: 3 * time.Hour,
			duration:  duration,
			want:      herdrUsageSpan{Text: " \u21bb 3h0m", Color: "#78829b", Dim: true},
		},
		{
			name:      "reset under quarter window is bright",
			remaining: time.Hour,
			duration:  duration,
			want:      herdrUsageSpan{Text: " \u21bb 1h0m", Color: "#c8d0dc"},
		},
		{
			name:      "reset under tenth window is bright and bold",
			remaining: 20 * time.Minute,
			duration:  duration,
			want:      herdrUsageSpan{Text: " \u21bb 20m", Color: "#c8d0dc", Bold: true},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resetsAt := now.Add(test.remaining).UnixMilli()
			window := herdrUsageWindow{ResetsAt: &resetsAt, DurationMs: test.duration}
			if got := herdrUsageResetSpan(test.want.Text, window, now); got != test.want {
				t.Errorf("reset span = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestHerdrUsageWindowTokensAreDurationFirst(t *testing.T) {
	tests := []struct {
		label      string
		durationMs int64
		want       string
	}{
		{label: "Claude 5 Hour", durationMs: 18_000_000, want: "5h"},
		{label: "Claude 7 Day", durationMs: 604_800_000, want: "7d"},
		{label: "Fable 7 Day", durationMs: 604_800_000, want: "7d fa"},
		{label: "Spark 7 Day", durationMs: 604_800_000, want: "7d sp"},
		{label: "Spark 5 Hour", durationMs: 18_000_000, want: "5h sp"},
	}
	for _, test := range tests {
		t.Run(test.want, func(t *testing.T) {
			var limit herdrUsageLimit
			limit.Label = test.label
			limit.Window.DurationMs = test.durationMs
			got, ok := herdrUsageWindowToken(limit)
			if !ok || got != test.want {
				t.Fatalf("window token = %q, %v; want %q, true", got, ok, test.want)
			}
		})
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
	if result != (herdrUsageCycleResult{Rows: 2, Attempts: 1, Successes: 1}) {
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
	if len(request.Params.Rows) != 2 || request.Params.Rows[0].Spans == nil || request.Params.Rows[0].Bar != nil ||
		request.Params.Rows[1].Bar == nil || request.Params.Rows[1].Bar.Title != "en* 5h" {
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
	if len(rows) != herdrUsageMaxRows-1 {
		t.Fatalf("row count = %d, want %d", len(rows), herdrUsageMaxRows-1)
	}
	if rows[len(rows)-1].Bar == nil {
		t.Fatal("cap must keep the literal first 23 rows, even mid-group")
	}
	if got := stderr.String(); !strings.Contains(got, "truncated from 29 to 23") {
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
	if result != (herdrUsageCycleResult{Rows: 2, Attempts: 2}) || !result.allPublishesFailed() {
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

func serveHerdrSocketAt(t *testing.T, dir, response string) <-chan herdrTestCapture {
	t.Helper()
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

func TestHerdrUsageDiscoversDefaultRootSocket(t *testing.T) {
	broker := newHerdrUsageBroker(t,
		`{"credentials":[{"provider":"anthropic","identityKey":"id-only","credential":{"email":"only@example.com"}}]}`,
		`{"reports":[{"provider":"anthropic","limits":[{"label":"5-hour","scope":{"tier":"-"},"amount":{"usedFraction":0.5},"window":{"durationMs":18000000}}]}]}`,
	)
	configureHerdrUsageVaults(t, []vault{{
		ID:        "only",
		Label:     "Only",
		BrokerURL: broker.server.URL,
		TokenFile: herdrUsageTokenFile(t),
	}}, `{"selected":"only","disabled":[]}`)
	root := t.TempDir()
	sessionsDir := filepath.Join(root, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	named := serveHerdrUsageSocket(t, sessionsDir, "named", `{"id":"a","result":{}}`)
	defaultRoot := serveHerdrSocketAt(t, root, `{"id":"b","result":{}}`)
	result := runHerdrUsageCycle(time.Unix(1_700_000_000, 0), sessionsDir, io.Discard)
	if result.Attempts != 2 || result.Successes != 2 {
		t.Fatalf("expected both the named and default root sockets to be published to, got %+v", result)
	}
	for name, captured := range map[string]<-chan herdrTestCapture{"named": named, "root": defaultRoot} {
		capture := <-captured
		if capture.err != nil || len(capture.line) == 0 {
			t.Fatalf("%s socket capture failed: %+v", name, capture)
		}
	}
}

func TestHerdrUsageSeqAdvancesWithinOneSecond(t *testing.T) {
	// Herdr rejects seq <= last as a silent no-op, so two cycles inside the
	// same wall-clock second (rapid restart, manual --once) must still carry
	// strictly increasing sequence numbers.
	broker := newHerdrUsageBroker(t,
		`{"credentials":[{"provider":"anthropic","identityKey":"id-seq","credential":{"email":"seq@example.com"}}]}`,
		`{"reports":[{"provider":"anthropic","limits":[{"label":"5-hour","scope":{"tier":"-"},"amount":{"usedFraction":0.5},"window":{"durationMs":18000000}}]}]}`,
	)
	configureHerdrUsageVaults(t, []vault{{
		ID:        "seq",
		Label:     "Seq",
		BrokerURL: broker.server.URL,
		TokenFile: herdrUsageTokenFile(t),
	}}, `{"selected":"seq","disabled":[]}`)
	sessionsDir := t.TempDir()
	base := time.Unix(1_700_000_000, 0)
	var seqs []int64
	for cycle, offset := range []time.Duration{0, 250 * time.Millisecond} {
		captured := serveHerdrUsageSocket(t, sessionsDir, fmt.Sprintf("cycle-%d", cycle), `{"id":"a","result":{}}`)
		result := runHerdrUsageCycle(base.Add(offset), sessionsDir, io.Discard)
		if result.Successes == 0 {
			t.Fatalf("cycle %d did not publish: %+v", cycle, result)
		}
		capture := <-captured
		if capture.err != nil {
			t.Fatal(capture.err)
		}
		var request struct {
			Params struct {
				Seq int64 `json:"seq"`
			} `json:"params"`
		}
		if err := json.Unmarshal(capture.line, &request); err != nil {
			t.Fatal(err)
		}
		seqs = append(seqs, request.Params.Seq)
	}
	if seqs[1] <= seqs[0] {
		t.Fatalf("seq must advance within one second: %v", seqs)
	}
}

func TestHerdrUsageCodexFirstCrossProviderTagsShareAndKeepStar(t *testing.T) {
	// The same human's Codex and Claude accounts share `al*`; provider color
	// distinguishes them, and the Codex provider block renders first.
	broker := newHerdrUsageBroker(t,
		`{"credentials":[
			{"provider":"anthropic","identityKey":"id-claude","credential":{"email":"alex@example.com"}},
			{"provider":"openai-codex","identityKey":"id-codex","credential":{"email":"alex@example.com"}}
		]}`,
		`{"reports":[
			{"provider":"anthropic","limits":[{"label":"5-hour","scope":{"tier":"-"},"amount":{"usedFraction":0.5},"window":{"durationMs":18000000}}]},
			{"provider":"openai-codex","limits":[{"label":"7-day","scope":{"tier":"-"},"amount":{"usedFraction":0.25},"window":{"durationMs":604800000}}]}
		]}`,
	)
	rows := collectHerdrUsageRows([]vault{{
		ID: "mine", Label: "Mine", BrokerURL: broker.server.URL, TokenFile: herdrUsageTokenFile(t),
	}}, nil, time.Unix(1_700_000_000, 0), io.Discard)
	if len(rows) != 3 || rows[0].Bar == nil || rows[2].Bar == nil {
		t.Fatalf("rows = %#v", rows)
	}
	if rows[0].Bar.Title != "al* 7d" || rows[0].Bar.TitleColor != "#62a7ff" {
		t.Fatalf("codex row = %+v", rows[0].Bar)
	}
	if rows[2].Bar.Title != "al* 5h" || rows[2].Bar.TitleColor != "#ff9f52" {
		t.Fatalf("claude row = %+v", rows[2].Bar)
	}
}

func TestHerdrUsageSurvivesBrokerRestartWithinOneProcess(t *testing.T) {
	// The daemon is long-lived while brokers restart underneath it (Home
	// Manager reconciliation). A second cycle in the same process must reach
	// the restarted broker instead of wedging on remembered connections.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/snapshot":
			_, _ = io.WriteString(w, `{"credentials":[{"provider":"anthropic","identityKey":"id-r","credential":{"email":"restart@example.com"}}]}`)
		case "/v1/usage":
			_, _ = io.WriteString(w, `{"reports":[{"provider":"anthropic","limits":[{"label":"5-hour","scope":{"tier":"-"},"amount":{"usedFraction":0.5},"window":{"durationMs":18000000}}]}]}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	first := &httptest.Server{Listener: listener, Config: &http.Server{Handler: handler}}
	first.Start()
	vaults := []vault{{
		ID: "restart", Label: "Restart",
		BrokerURL: "http://" + address,
		TokenFile: herdrUsageTokenFile(t),
	}}
	now := time.Unix(1_700_000_000, 0)
	if rows := collectHerdrUsageRows(vaults, nil, now, io.Discard); len(rows) == 0 {
		t.Fatal("first cycle produced no rows")
	}
	first.Close()

	var relisten net.Listener
	for range 50 {
		relisten, err = net.Listen("tcp", address)
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("rebind %s: %v", address, err)
	}
	second := &httptest.Server{Listener: relisten, Config: &http.Server{Handler: handler}}
	second.Start()
	t.Cleanup(second.Close)

	if rows := collectHerdrUsageRows(vaults, nil, now.Add(time.Minute), io.Discard); len(rows) == 0 {
		t.Fatal("second cycle after broker restart produced no rows")
	}
}

func TestHerdrUsageMatchValuesEqualLauncherBrokerEnv(t *testing.T) {
	// The focused-pane mark joins on exact string equality between the pane
	// token (the extension republishes OMP_AUTH_BROKER_URL from the launcher
	// env, trimmed) and a row's match_values (this daemon). Both must carry
	// the manifest's brokerUrl byte-identically, so whitespace is normalized
	// once at parseVaults; slash forms flow verbatim through both paths and
	// cannot diverge by construction.
	broker := newHerdrUsageBroker(t,
		`{"credentials":[{"provider":"anthropic","identityKey":"id-a","credential":{"email":"alex@example.com"}}]}`,
		`{"reports":[{"provider":"anthropic","limits":[{"label":"5-hour","scope":{"tier":"-"},"amount":{"usedFraction":0.5},"window":{"durationMs":18000000}}]}]}`,
	)
	raw := fmt.Sprintf(
		`[{"id":"mine","label":"Mine","brokerUrl":"  %s  ","tokenFile":"  %s  "}]`,
		broker.server.URL, herdrUsageTokenFile(t),
	)
	vaults := loadVaults(raw, "")
	if len(vaults) != 1 || vaults[0].BrokerURL != broker.server.URL {
		t.Fatalf("normalized vaults = %#v", vaults)
	}
	env, err := brokerEnv(vaults[0])
	if err != nil {
		t.Fatal(err)
	}
	var launched string
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, "OMP_AUTH_BROKER_URL="); ok {
			launched = value
		}
	}
	if launched == "" {
		t.Fatalf("launcher env missing broker URL: %v", env)
	}
	if strings.TrimSpace(launched) != launched {
		t.Fatalf("extension trim must be a no-op, got %q", launched)
	}
	rows := collectHerdrUsageRows(vaults, nil, time.Unix(1_700_000_000, 0), io.Discard)
	var matched bool
	for _, row := range rows {
		if row.Bar == nil {
			continue
		}
		if len(row.Bar.MatchValues) != 1 || row.Bar.MatchValues[0] != launched {
			t.Fatalf("match_values = %#v, want exactly [%q]", row.Bar.MatchValues, launched)
		}
		matched = true
	}
	if !matched {
		t.Fatal("no bar rows emitted")
	}
}

func TestHerdrUsageStatusRowStates(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	accounts := map[string][]*herdrUsageAccount{"anthropic": {{}}}
	tests := []struct {
		name  string
		state *herdrUsageState
		want  []herdrUsageSpan
	}{
		{"zero state renders a pure spacer", &herdrUsageState{}, nil},
		{"healthy schedule counts down", &herdrUsageState{
			accounts:    accounts,
			fetchedAt:   now.Add(-time.Minute),
			nextFetchAt: now.Add(4*time.Minute + 30*time.Second),
		}, []herdrUsageSpan{{Text: "↻ 4m", Color: "#78829b", Dim: true}}},
		{"imminent fetch renders <1m", &herdrUsageState{
			accounts:    accounts,
			fetchedAt:   now,
			nextFetchAt: now.Add(20 * time.Second),
		}, []herdrUsageSpan{{Text: "↻ <1m", Color: "#78829b", Dim: true}}},
		{"hint decorates the countdown", &herdrUsageState{
			accounts:    accounts,
			fetchedAt:   now,
			nextFetchAt: now.Add(5 * time.Minute),
			refreshHint: "^a u",
		}, []herdrUsageSpan{{Text: "↻ 5m · ^a u", Color: "#78829b", Dim: true}}},
		{"failure outranks the countdown", &herdrUsageState{
			accounts:    accounts,
			fetchedAt:   now.Add(-3 * time.Minute),
			fetchFailed: true,
			nextFetchAt: now.Add(5 * time.Minute),
			refreshHint: "^a u",
		}, []herdrUsageSpan{{Text: "cached 3m ago · ^a u", Color: "#e1c846"}}},
		{"aged-out data is stale without a failure", &herdrUsageState{
			accounts:    accounts,
			fetchedAt:   now.Add(-16 * time.Minute),
			nextFetchAt: now.Add(5 * time.Minute),
		}, []herdrUsageSpan{{Text: "cached 16m ago", Color: "#e1c846"}}},
	}
	for _, test := range tests {
		row := herdrUsageStatusRow(test.state, now)
		if row.Bar != nil || row.Spans == nil || len(*row.Spans) != 0 {
			t.Errorf("%s: left cluster = %#v, want empty spans", test.name, row)
		}
		if !slices.Equal(row.Right, test.want) {
			t.Errorf("%s: right cluster = %#v, want %#v", test.name, row.Right, test.want)
		}
	}
}

func TestHerdrUsageFetchFailureRetainsCachedRows(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tokenFile := herdrUsageTokenFile(t)
	healthy := true
	broker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !healthy {
			http.Error(w, "broker draining", http.StatusServiceUnavailable)
			return
		}
		switch r.URL.Path {
		case "/v1/snapshot":
			fmt.Fprint(w, `{"credentials":[{"provider":"anthropic","identityKey":"acct","credential":{"email":"acct@example.test"}}]}`)
		case "/v1/usage":
			fmt.Fprint(w, `{"reports":[{"provider":"anthropic","limits":[{"label":"5 hours","amount":{"usedFraction":0.4},"window":{"durationMs":18000000}}]}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(broker.Close)
	configureHerdrUsageVaults(t, []vault{{
		ID: "acct", Label: "Acct", BrokerURL: broker.URL, TokenFile: tokenFile,
	}}, `{"selected":"acct","disabled":[]}`)

	state := &herdrUsageState{refreshHint: "^a u", nextFetchAt: now.Add(5 * time.Minute)}
	firstDir := t.TempDir()
	first := serveHerdrUsageSocket(t, firstDir, "one", `{"id":"a","result":{}}`)
	if result := runHerdrUsageFetch(state, now, firstDir, io.Discard); result != (herdrUsageCycleResult{Rows: 2, Attempts: 1, Successes: 1}) {
		t.Fatalf("healthy fetch result = %+v", result)
	}
	readHerdrCapture(t, first)

	healthy = false
	later := now.Add(5 * time.Minute)
	state.nextFetchAt = later.Add(5 * time.Minute)
	secondDir := t.TempDir()
	second := serveHerdrUsageSocket(t, secondDir, "two", `{"id":"b","result":{}}`)
	if result := runHerdrUsageFetch(state, later, secondDir, io.Discard); result != (herdrUsageCycleResult{Rows: 2, Attempts: 1, Successes: 1}) {
		t.Fatalf("degraded fetch result = %+v", result)
	}
	if !state.fetchFailed {
		t.Fatal("errorful fetch must mark retained data stale")
	}
	var request struct {
		Params struct {
			Rows []herdrUsageRow `json:"rows"`
		} `json:"params"`
	}
	if err := json.Unmarshal(readHerdrCapture(t, second).line, &request); err != nil {
		t.Fatal(err)
	}
	rows := request.Params.Rows
	if len(rows) != 2 || rows[1].Bar == nil || rows[1].Bar.Title != "ac* 5h" {
		t.Fatalf("retained rows = %#v", rows)
	}
	if len(rows[0].Right) != 1 || rows[0].Right[0].Text != "cached 5m ago · ^a u" || rows[0].Right[0].Color != "#e1c846" {
		t.Fatalf("status row = %#v", rows[0].Right)
	}
}

func TestHerdrUsageStateSeqAdvancesWithinOneMilli(t *testing.T) {
	state := &herdrUsageState{}
	now := time.Unix(1_700_000_000, 0)
	if first, second := state.seq(now), state.seq(now); second <= first {
		t.Fatalf("same-milli publishes must advance seq: %d then %d", first, second)
	}
}

func TestHerdrUsageRefreshHintFlagNeedsLabel(t *testing.T) {
	if got := runHerdrUsage([]string{"--refresh-hint"}); got != 2 {
		t.Fatalf("bare --refresh-hint exit = %d, want 2", got)
	}
}
