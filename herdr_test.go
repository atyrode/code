package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

type herdrTestCapture struct {
	line []byte
	err  error
}

func serveHerdrResponse(t *testing.T, response string) (string, <-chan herdrTestCapture) {
	t.Helper()
	socketPath := filepath.Join(t.TempDir(), "herdr.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })

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
	return socketPath, captured
}

func readHerdrCapture(t *testing.T, captured <-chan herdrTestCapture) herdrTestCapture {
	t.Helper()
	got := <-captured
	if got.err != nil {
		t.Fatal(got.err)
	}
	return got
}

type herdrTestSequenceCapture struct {
	lines [][]byte
	err   error
}

func serveHerdrResponses(t *testing.T, responses ...string) (string, <-chan herdrTestSequenceCapture) {
	t.Helper()
	socketPath := filepath.Join(t.TempDir(), "herdr-sequence.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })

	captured := make(chan herdrTestSequenceCapture, 1)
	go func() {
		lines := make([][]byte, 0, len(responses))
		for _, response := range responses {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				captured <- herdrTestSequenceCapture{lines: lines, err: acceptErr}
				return
			}
			line, readErr := bufio.NewReader(conn).ReadBytes('\n')
			if readErr != nil {
				conn.Close()
				captured <- herdrTestSequenceCapture{lines: lines, err: readErr}
				return
			}
			lines = append(lines, line)
			_, writeErr := io.WriteString(conn, response+"\n")
			conn.Close()
			if writeErr != nil {
				captured <- herdrTestSequenceCapture{lines: lines, err: writeErr}
				return
			}
		}
		captured <- herdrTestSequenceCapture{lines: lines}
	}()
	return socketPath, captured
}

func readHerdrSequence(t *testing.T, captured <-chan herdrTestSequenceCapture) herdrTestSequenceCapture {
	t.Helper()
	got := <-captured
	if got.err != nil {
		t.Fatal(got.err)
	}
	return got
}

func fakeHerdrExecutable(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "omp")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestHerdrAgentStartRequest(t *testing.T) {
	socketPath, captured := serveHerdrResponse(t, `{"id":"x","result":{"type":"agent_started"}}`)
	t.Setenv("HERDR_SOCKET_PATH", socketPath)
	t.Setenv("HERDR_ACTIVE_WORKSPACE_ID", "")
	t.Setenv("HERDR_WORKSPACE_ID", "")
	t.Setenv("HERDR_ACTIVE_PANE_CWD", "/work/checkout")

	argv := []string{"/bin/omp", "--profile", "default", "--resume", "hello"}
	env := herdrEnvMap([]string{
		"OMP_AUTH_BROKER_URL=http://broker.test",
		"OMP_AUTH_BROKER_TOKEN=secret=part",
	})
	if err := herdrAgentStart("omp", argv, env); err != nil {
		t.Fatal(err)
	}
	wire := readHerdrCapture(t, captured).line
	if len(wire) == 0 || wire[len(wire)-1] != '\n' || bytes.Count(wire, []byte{'\n'}) != 1 {
		t.Fatalf("request must be exactly one newline-terminated JSON line: %q", wire)
	}

	var got herdrAgentStartRequest
	if err := json.Unmarshal(wire, &got); err != nil {
		t.Fatal(err)
	}
	const idPrefix = "code:agent:start:"
	if !strings.HasPrefix(got.ID, idPrefix) {
		t.Fatalf("request id = %q, want prefix %q", got.ID, idPrefix)
	}
	if _, err := strconv.ParseInt(strings.TrimPrefix(got.ID, idPrefix), 10, 64); err != nil {
		t.Fatalf("request id must end in unix nanoseconds: %q", got.ID)
	}
	want := herdrAgentStartRequest{
		ID:     got.ID,
		Method: "agent.start",
		Params: herdrAgentStartParams{
			Name:  "omp @checkout",
			CWD:   "/work/checkout",
			Argv:  argv,
			Env:   map[string]string{"OMP_AUTH_BROKER_URL": "http://broker.test", "OMP_AUTH_BROKER_TOKEN": "secret=part"},
			Focus: true,
		},
	}

	// Compare decoded generic values as well as the typed request so unexpected
	// JSON fields cannot hide behind encoding/json's default unknown-field rule.
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	var gotValue, wantValue any
	if err := json.Unmarshal(wire, &gotValue); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(wantJSON, &wantValue); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotValue, wantValue) {
		t.Fatalf("agent.start request = %s, want %s", wire, wantJSON)
	}
}

func TestHerdrAgentStartWorkspacePlacement(t *testing.T) {
	processCWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name            string
		activeWorkspace string
		workspace       string
		want            string
	}{
		{name: "popup workspace", activeWorkspace: "w-popup", workspace: "w-pane", want: "w-popup"},
		{name: "regular pane workspace", workspace: "w-pane", want: "w-pane"},
		{name: "no workspace omits field"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			socketPath, captured := serveHerdrResponse(t, `{"id":"x","result":{}}`)
			t.Setenv("HERDR_SOCKET_PATH", socketPath)
			t.Setenv("HERDR_ACTIVE_WORKSPACE_ID", tt.activeWorkspace)
			t.Setenv("HERDR_WORKSPACE_ID", tt.workspace)
			t.Setenv("HERDR_ACTIVE_PANE_CWD", "")

			if err := herdrAgentStart("omp", []string{"/bin/omp"}, nil); err != nil {
				t.Fatal(err)
			}
			wire := readHerdrCapture(t, captured).line
			var envelope struct {
				Params map[string]json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(wire, &envelope); err != nil {
				t.Fatal(err)
			}
			rawCWD, present := envelope.Params["cwd"]
			if !present {
				t.Fatalf("cwd missing from request: %s", wire)
			}
			var cwd string
			if err := json.Unmarshal(rawCWD, &cwd); err != nil {
				t.Fatal(err)
			}
			if cwd != processCWD {
				t.Fatalf("cwd = %q, want process cwd %q", cwd, processCWD)
			}
			rawWorkspace, present := envelope.Params["workspace_id"]
			if tt.want == "" {
				if present {
					t.Fatalf("workspace_id must be omitted without workspace context: %s", wire)
				}
				return
			}
			if !present {
				t.Fatalf("workspace_id missing from request: %s", wire)
			}
			var workspace string
			if err := json.Unmarshal(rawWorkspace, &workspace); err != nil {
				t.Fatal(err)
			}
			if workspace != tt.want {
				t.Fatalf("workspace_id = %q, want %q", workspace, tt.want)
			}
		})
	}
}

func TestHerdrAgentStartErrorResponse(t *testing.T) {
	socketPath, captured := serveHerdrResponses(t, `{"id":"x","error":{"code":"bad","message":"nope"}}`)
	t.Setenv("HERDR_SOCKET_PATH", socketPath)
	t.Setenv("HERDR_ACTIVE_PANE_CWD", "/work/code")

	err := herdrAgentStart("omp", []string{"/bin/omp"}, nil)
	exchange := readHerdrSequence(t, captured)
	if len(exchange.lines) != 1 {
		t.Fatalf("non-duplicate error sent %d requests, want 1", len(exchange.lines))
	}
	if err == nil {
		t.Fatal("error response was accepted")
	}
	for _, want := range []string{"bad", "nope"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not contain %q", err, want)
		}
	}
}

func TestHerdrAgentStartRetriesDuplicateName(t *testing.T) {
	socketPath, captured := serveHerdrResponses(t,
		`{"id":"x","error":{"code":"agent_name_taken","message":"duplicate"}}`,
		`{"id":"y","result":{"type":"agent_started"}}`,
	)
	t.Setenv("HERDR_SOCKET_PATH", socketPath)
	t.Setenv("HERDR_ACTIVE_PANE_CWD", "/work/code")
	t.Setenv("HERDR_ACTIVE_WORKSPACE_ID", "w1")
	t.Setenv("HERDR_WORKSPACE_ID", "")

	argv := []string{"/bin/omp", "--profile", "default"}
	env := map[string]string{"OMP_AUTH_BROKER_TOKEN": "secret"}
	if err := herdrAgentStart("omp", argv, env); err != nil {
		t.Fatal(err)
	}
	exchange := readHerdrSequence(t, captured)
	if len(exchange.lines) != 2 {
		t.Fatalf("agent.start sent %d requests, want 2", len(exchange.lines))
	}
	var first, second herdrAgentStartRequest
	if err := json.Unmarshal(exchange.lines[0], &first); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(exchange.lines[1], &second); err != nil {
		t.Fatal(err)
	}
	wantFirst := herdrAgentStartParams{
		Name:        "omp @code",
		CWD:         "/work/code",
		Argv:        argv,
		Env:         env,
		Focus:       true,
		WorkspaceID: "w1",
	}
	if !reflect.DeepEqual(first.Params, wantFirst) {
		t.Fatalf("first params = %#v, want %#v", first.Params, wantFirst)
	}
	wantSecond := wantFirst
	wantSecond.Name = "omp @code (2)"
	if !reflect.DeepEqual(second.Params, wantSecond) {
		t.Fatalf("retry params = %#v, want %#v", second.Params, wantSecond)
	}
}

func TestHerdrAgentStartStopsAfterNinthDuplicate(t *testing.T) {
	responses := make([]string, 9)
	for i := range responses {
		responses[i] = `{"id":"x","error":{"code":"agent_name_taken","message":"duplicate"}}`
	}
	socketPath, captured := serveHerdrResponses(t, responses...)
	t.Setenv("HERDR_SOCKET_PATH", socketPath)
	t.Setenv("HERDR_ACTIVE_PANE_CWD", "/work/code")

	err := herdrAgentStart("omp", []string{"/bin/omp"}, nil)
	exchange := readHerdrSequence(t, captured)
	if err == nil || !strings.Contains(err.Error(), "agent_name_taken") {
		t.Fatalf("ninth duplicate error = %v, want agent_name_taken", err)
	}
	if len(exchange.lines) != 9 {
		t.Fatalf("agent.start sent %d requests, want 9", len(exchange.lines))
	}
	var last herdrAgentStartRequest
	if err := json.Unmarshal(exchange.lines[8], &last); err != nil {
		t.Fatal(err)
	}
	if last.Params.Name != "omp @code (9)" {
		t.Fatalf("ninth request name = %q, want %q", last.Params.Name, "omp @code (9)")
	}
}

func TestTryHerdrLaunchReturnsAttemptError(t *testing.T) {
	socketPath, captured := serveHerdrResponse(t, `{"id":"x","error":{"code":"busy","message":"pane unavailable"}}`)
	executable := fakeHerdrExecutable(t)
	t.Setenv("HERDR_ENV", "")
	t.Setenv("HERDR_SOCKET_PATH", socketPath)
	t.Setenv("CODE_HERDR", "")
	t.Setenv("CODE_OMP", executable)
	t.Setenv("HERDR_ACTIVE_PANE_ID", "w1:p1")
	t.Setenv("HERDR_ACTIVE_WORKSPACE_ID", "w1")
	t.Setenv("HERDR_WORKSPACE_ID", "")

	attempted, err := tryHerdrLaunch("CODE_OMP", []string{"omp"}, func(path string) []string {
		return managedLaunchArgv(path, nil, "")
	}, nil)
	readHerdrCapture(t, captured)
	if !attempted {
		t.Fatal("enabled herdr mode must remain selected after agent.start fails")
	}
	if err == nil {
		t.Fatal("agent.start failure must be returned instead of exposing the exec path")
	}
	for _, want := range []string{"busy", "pane unavailable"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not contain %q", err, want)
		}
	}
}

func TestHerdrSpawnEnabled(t *testing.T) {
	tests := []struct {
		name            string
		herdrEnv        string
		socket          string
		override        string
		activePane      string
		activeWorkspace string
		workspace       string
		want            bool
	}{
		{name: "regular pane execs in place", herdrEnv: "1", socket: "/tmp/herdr.sock", want: false},
		{name: "popup markers with pane env stay in pane", herdrEnv: "1", socket: "/tmp/herdr.sock", activePane: "w1:p1", want: false},
		{name: "forced on overrides pane exec", herdrEnv: "1", socket: "/tmp/herdr.sock", override: "1", want: true},
		{name: "popup active pane", socket: "/tmp/herdr.sock", activePane: "w1:p1", want: true},
		{name: "popup active workspace", socket: "/tmp/herdr.sock", activeWorkspace: "w1", want: true},
		{name: "outside session", herdrEnv: "0", socket: "/tmp/herdr.sock", want: false},
		{name: "missing session markers", socket: "/tmp/herdr.sock", want: false},
		{name: "regular workspace alone is not a gate", socket: "/tmp/herdr.sock", workspace: "w1", want: false},
		{name: "missing socket", herdrEnv: "1", activePane: "w1:p1", want: false},
		{name: "forced off regular pane", herdrEnv: "1", socket: "/tmp/herdr.sock", override: "0", want: false},
		{name: "forced off popup", socket: "/tmp/herdr.sock", override: "0", activeWorkspace: "w1", want: false},
		{name: "forced on", socket: "/tmp/herdr.sock", override: "1", want: true},
		{name: "forced on still needs socket", override: "1", want: false},
		{name: "unknown override uses popup gate", socket: "/tmp/herdr.sock", override: "other", activePane: "w1:p1", want: true},
		{name: "unknown override without marker", socket: "/tmp/herdr.sock", override: "other", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("HERDR_ENV", tt.herdrEnv)
			t.Setenv("HERDR_SOCKET_PATH", tt.socket)
			t.Setenv("CODE_HERDR", tt.override)
			t.Setenv("HERDR_ACTIVE_PANE_ID", tt.activePane)
			t.Setenv("HERDR_ACTIVE_WORKSPACE_ID", tt.activeWorkspace)
			t.Setenv("HERDR_WORKSPACE_ID", tt.workspace)
			if got := herdrSpawnEnabled(); got != tt.want {
				t.Fatalf("herdrSpawnEnabled() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHerdrLaunchArgvParity(t *testing.T) {
	forwarded := []string{"--config", "/tmp/x.yml", "--profile", "secondary", "--resume"}
	prompt := "hello"
	cfgPath := "/tmp/gen.yml"
	extraEnv := []string{
		"OMP_AUTH_BROKER_URL=http://broker.test",
		"OMP_AUTH_BROKER_TOKEN=secret",
	}
	tests := []struct {
		name      string
		envVar    string
		fallbacks []string
		build     func(string, []string, string) []string
		extraEnv  []string
	}{
		{
			name:      "managed",
			envVar:    "CODE_OMP",
			fallbacks: []string{"omp-managed", "omp"},
			build:     managedLaunchArgv,
			extraEnv:  extraEnv,
		},
		{
			name:      "untrusted",
			envVar:    "CODE_OMP_UNTRUSTED",
			fallbacks: []string{"ompu"},
			build:     sandboxLaunchArgv,
		},
		{
			name:      "generated",
			envVar:    "CODE_OMP",
			fallbacks: []string{"omp"},
			build: func(path string, forwarded []string, prompt string) []string {
				return generatedLaunchArgv(path, cfgPath, forwarded, prompt)
			},
			extraEnv: extraEnv,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			socketPath, captured := serveHerdrResponse(t, `{"id":"x","result":{}}`)
			executable := fakeHerdrExecutable(t)
			t.Setenv("HERDR_ENV", "")
			t.Setenv("HERDR_ACTIVE_PANE_ID", "w1:p1")
			t.Setenv("HERDR_ACTIVE_WORKSPACE_ID", "")
			t.Setenv("HERDR_SOCKET_PATH", socketPath)
			t.Setenv("CODE_HERDR", "")
			t.Setenv("CODE_OMP", "")
			t.Setenv("CODE_OMP_UNTRUSTED", "")
			t.Setenv(tt.envVar, executable)

			oldArgs := os.Args
			os.Args = append([]string{"code"}, forwarded...)
			t.Cleanup(func() { os.Args = oldArgs })
			attempted, err := tryHerdrLaunch(tt.envVar, tt.fallbacks, func(path string) []string {
				return tt.build(path, os.Args[1:], prompt)
			}, tt.extraEnv)
			if err != nil {
				t.Fatal(err)
			}
			if !attempted {
				t.Fatal("herdr launch was not attempted")
			}

			wire := readHerdrCapture(t, captured).line
			var got herdrAgentStartRequest
			if err := json.Unmarshal(wire, &got); err != nil {
				t.Fatal(err)
			}
			wantArgv := tt.build(executable, forwarded, prompt)
			if !reflect.DeepEqual(got.Params.Argv, wantArgv) {
				t.Fatalf("herdr argv = %#v, existing launch builder = %#v", got.Params.Argv, wantArgv)
			}
			if wantEnv := herdrEnvMap(tt.extraEnv); !reflect.DeepEqual(got.Params.Env, wantEnv) {
				t.Fatalf("herdr env = %#v, want %#v", got.Params.Env, wantEnv)
			}
			var raw struct {
				Params map[string]json.RawMessage `json:"params"`
			}
			if err := json.Unmarshal(wire, &raw); err != nil {
				t.Fatal(err)
			}
			_, hasEnv := raw.Params["env"]
			if wantEnv := len(tt.extraEnv) > 0; hasEnv != wantEnv {
				t.Fatalf("env field present = %v, want %v; request = %s", hasEnv, wantEnv, wire)
			}
		})
	}
}

func TestRegularPaneLaunchStaysInPane(t *testing.T) {
	socketPath, captured := serveHerdrResponse(t, `{"id":"x","result":{}}`)
	executable := fakeHerdrExecutable(t)
	t.Setenv("HERDR_ENV", "1")
	t.Setenv("HERDR_SOCKET_PATH", socketPath)
	t.Setenv("CODE_HERDR", "")
	t.Setenv("HERDR_ACTIVE_PANE_ID", "")
	t.Setenv("HERDR_ACTIVE_WORKSPACE_ID", "")
	t.Setenv("CODE_OMP", executable)

	attempted, err := tryHerdrLaunch("CODE_OMP", []string{"omp"}, func(path string) []string {
		return []string{path}
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if attempted {
		t.Fatal("regular pane launch must leave the exec path selected")
	}
	select {
	case capture := <-captured:
		t.Fatalf("regular pane launch sent a socket request: %s", capture.line)
	default:
	}
}

func TestLaunchGeneratedWritesConfigBeforeHerdrStart(t *testing.T) {
	socketPath, captured := serveHerdrResponse(t, `{"id":"x","result":{}}`)
	executable := fakeHerdrExecutable(t)
	t.Setenv("HERDR_ENV", "")
	t.Setenv("HERDR_ACTIVE_PANE_ID", "w1:p1")
	t.Setenv("HERDR_SOCKET_PATH", socketPath)
	t.Setenv("CODE_HERDR", "")
	t.Setenv("CODE_OMP", executable)

	forwarded := []string{"--profile", "secondary", "--resume"}
	oldArgs := os.Args
	os.Args = append([]string{"code"}, forwarded...)
	t.Cleanup(func() { os.Args = oldArgs })
	const config = "models:\n  review: gpt-test\n"
	launchGenerated(config, "hello", []string{"OMP_AUTH_BROKER_TOKEN=secret"})

	wire := readHerdrCapture(t, captured).line
	var got herdrAgentStartRequest
	if err := json.Unmarshal(wire, &got); err != nil {
		t.Fatal(err)
	}
	var generatedPath string
	for i, arg := range got.Params.Argv {
		if arg == "--config" && i+1 < len(got.Params.Argv) {
			generatedPath = got.Params.Argv[i+1]
			break
		}
	}
	if generatedPath == "" {
		t.Fatalf("generated argv has no --config path: %#v", got.Params.Argv)
	}
	t.Cleanup(func() { os.Remove(generatedPath) })
	contents, err := os.ReadFile(generatedPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != config {
		t.Fatalf("generated config = %q, want %q", contents, config)
	}
	wantArgv := generatedLaunchArgv(executable, generatedPath, forwarded, "hello")
	if !reflect.DeepEqual(got.Params.Argv, wantArgv) {
		t.Fatalf("herdr generated argv = %#v, existing launch builder = %#v", got.Params.Argv, wantArgv)
	}
}
