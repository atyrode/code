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
			Name:  "omp",
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

func TestHerdrAgentStartErrorResponse(t *testing.T) {
	socketPath, captured := serveHerdrResponse(t, `{"id":"x","error":{"code":"bad","message":"nope"}}`)
	t.Setenv("HERDR_SOCKET_PATH", socketPath)

	err := herdrAgentStart("omp", []string{"/bin/omp"}, nil)
	readHerdrCapture(t, captured)
	if err == nil {
		t.Fatal("error response was accepted")
	}
	for _, want := range []string{"bad", "nope"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q does not contain %q", err, want)
		}
	}
}

func TestTryHerdrLaunchReturnsAttemptError(t *testing.T) {
	socketPath, captured := serveHerdrResponse(t, `{"id":"x","error":{"code":"busy","message":"pane unavailable"}}`)
	executable := fakeHerdrExecutable(t)
	t.Setenv("HERDR_ENV", "1")
	t.Setenv("HERDR_SOCKET_PATH", socketPath)
	t.Setenv("CODE_HERDR", "")
	t.Setenv("CODE_OMP", executable)

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
		name     string
		herdrEnv string
		socket   string
		override string
		want     bool
	}{
		{name: "inside session", herdrEnv: "1", socket: "/tmp/herdr.sock", want: true},
		{name: "outside session", herdrEnv: "0", socket: "/tmp/herdr.sock", want: false},
		{name: "missing session marker", socket: "/tmp/herdr.sock", want: false},
		{name: "missing socket", herdrEnv: "1", want: false},
		{name: "forced off", herdrEnv: "1", socket: "/tmp/herdr.sock", override: "0", want: false},
		{name: "forced on", socket: "/tmp/herdr.sock", override: "1", want: true},
		{name: "forced on still needs socket", herdrEnv: "1", override: "1", want: false},
		{name: "unknown override uses session gate", herdrEnv: "1", socket: "/tmp/herdr.sock", override: "other", want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("HERDR_ENV", tt.herdrEnv)
			t.Setenv("HERDR_SOCKET_PATH", tt.socket)
			t.Setenv("CODE_HERDR", tt.override)
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
			t.Setenv("HERDR_ENV", "1")
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

func TestLaunchGeneratedWritesConfigBeforeHerdrStart(t *testing.T) {
	socketPath, captured := serveHerdrResponse(t, `{"id":"x","result":{}}`)
	executable := fakeHerdrExecutable(t)
	t.Setenv("HERDR_ENV", "1")
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
