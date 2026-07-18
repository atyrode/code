package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
)

const herdrRequestTimeout = 3 * time.Second

type herdrAgentStartParams struct {
	Name  string            `json:"name"`
	Argv  []string          `json:"argv"`
	Env   map[string]string `json:"env,omitempty"`
	Focus bool              `json:"focus"`
}

type herdrAgentStartRequest struct {
	ID     string                `json:"id"`
	Method string                `json:"method"`
	Params herdrAgentStartParams `json:"params"`
}

type herdrAgentStartError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type herdrAgentStartResponse struct {
	Result json.RawMessage       `json:"result"`
	Error  *herdrAgentStartError `json:"error"`
}

// herdrSpawnEnabled reports whether launches should use the active herdr
// session. CODE_HERDR=0 is an escape hatch; CODE_HERDR=1 permits callers that
// have the socket but not HERDR_ENV in their inherited environment.
func herdrSpawnEnabled() bool {
	if os.Getenv("HERDR_SOCKET_PATH") == "" {
		return false
	}
	switch os.Getenv("CODE_HERDR") {
	case "0":
		return false
	case "1":
		return true
	default:
		return os.Getenv("HERDR_ENV") == "1"
	}
}

// herdrAgentStart sends exactly one agent.start request and reads exactly one
// response line. The deadline bounds the whole socket exchange.
func herdrAgentStart(name string, argv []string, env map[string]string) error {
	conn, err := net.Dial("unix", os.Getenv("HERDR_SOCKET_PATH"))
	if err != nil {
		return fmt.Errorf("herdr agent.start: connect: %w", err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(herdrRequestTimeout)); err != nil {
		return fmt.Errorf("herdr agent.start: deadline: %w", err)
	}

	req := herdrAgentStartRequest{
		ID:     fmt.Sprintf("code:agent:start:%d", time.Now().UnixNano()),
		Method: "agent.start",
		Params: herdrAgentStartParams{
			Name:  name,
			Argv:  argv,
			Env:   env,
			Focus: true,
		},
	}
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return fmt.Errorf("herdr agent.start: write request: %w", err)
	}

	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return fmt.Errorf("herdr agent.start: read response: %w", err)
	}
	var response herdrAgentStartResponse
	if err := json.Unmarshal(line, &response); err != nil {
		return fmt.Errorf("herdr agent.start: decode response: %w", err)
	}
	if response.Error != nil {
		return fmt.Errorf("herdr agent.start: %s: %s", response.Error.Code, response.Error.Message)
	}
	if response.Result != nil {
		return nil
	}
	return fmt.Errorf("herdr agent.start: response missing result or error")
}

// herdrEnvMap converts brokerEnv's KEY=VALUE entries to herdr's JSON env map.
// Values are cut only at the first '=' so bearer tokens remain byte-for-byte
// unchanged, and never enter the launched process's argv.
func herdrEnvMap(entries []string) map[string]string {
	if len(entries) == 0 {
		return nil
	}
	env := make(map[string]string, len(entries))
	for _, entry := range entries {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			env[key] = value
		}
	}
	if len(env) == 0 {
		return nil
	}
	return env
}

// tryHerdrLaunch resolves the executable with the same rules as runExec, then
// sends the already-built argv and broker overlay through herdr's unix socket.
// A socket or protocol failure is non-fatal: the caller retains the exec path.
func tryHerdrLaunch(envVar string, fallbacks []string, argv func(string) []string, extraEnv []string) bool {
	if !herdrSpawnEnabled() {
		return false
	}
	path, err := resolveLaunchPath(envVar, fallbacks)
	if err == nil {
		err = herdrAgentStart("omp", argv(path), herdrEnvMap(extraEnv))
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "code: herdr launch: %v; falling back to exec\n", err)
		return false
	}
	fmt.Fprintln(os.Stdout, "code: launched omp via herdr")
	return true
}
