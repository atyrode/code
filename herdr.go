package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const herdrRequestTimeout = 3 * time.Second

type herdrAgentStartParams struct {
	Name        string            `json:"name"`
	CWD         string            `json:"cwd"`
	Argv        []string          `json:"argv"`
	Env         map[string]string `json:"env,omitempty"`
	Focus       bool              `json:"focus"`
	WorkspaceID string            `json:"workspace_id,omitempty"`
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
// session. Custom command popups carry HERDR_ACTIVE_* rather than HERDR_ENV;
// CODE_HERDR=0 is the escape hatch and CODE_HERDR=1 forces socket use.
func herdrSpawnEnabled() bool {
	if os.Getenv("CODE_HERDR") == "0" || os.Getenv("HERDR_SOCKET_PATH") == "" {
		return false
	}
	if os.Getenv("CODE_HERDR") == "1" {
		return true
	}
	return os.Getenv("HERDR_ENV") == "1" ||
		os.Getenv("HERDR_ACTIVE_PANE_ID") != "" ||
		os.Getenv("HERDR_ACTIVE_WORKSPACE_ID") != ""
}

func herdrWorkspaceID() string {
	if workspaceID := os.Getenv("HERDR_ACTIVE_WORKSPACE_ID"); workspaceID != "" {
		return workspaceID
	}
	return os.Getenv("HERDR_WORKSPACE_ID")
}

func herdrCWD() (string, error) {
	if cwd := os.Getenv("HERDR_ACTIVE_PANE_CWD"); cwd != "" {
		return cwd, nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("herdr agent.start: current working directory: %w", err)
	}
	return cwd, nil
}

func herdrAgentStartAttempt(req herdrAgentStartRequest, deadline time.Time) (herdrAgentStartResponse, error) {
	var response herdrAgentStartResponse
	conn, err := net.Dial("unix", os.Getenv("HERDR_SOCKET_PATH"))
	if err != nil {
		return response, fmt.Errorf("herdr agent.start: connect: %w", err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(deadline); err != nil {
		return response, fmt.Errorf("herdr agent.start: deadline: %w", err)
	}
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return response, fmt.Errorf("herdr agent.start: write request: %w", err)
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return response, fmt.Errorf("herdr agent.start: read response: %w", err)
	}
	if err := json.Unmarshal(line, &response); err != nil {
		return response, fmt.Errorf("herdr agent.start: decode response: %w", err)
	}
	return response, nil
}

// herdrAgentStart exchanges one request and response line per connection. A
// name collision retries through a fresh API connection with readable numeric
// suffixes; all other socket and protocol failures remain terminal.
func herdrAgentStart(name string, argv []string, env map[string]string) error {
	cwd, err := herdrCWD()
	if err != nil {
		return err
	}
	baseName := fmt.Sprintf("%s @%s", name, filepath.Base(cwd))
	params := herdrAgentStartParams{
		CWD:         cwd,
		Argv:        argv,
		Env:         env,
		Focus:       true,
		WorkspaceID: herdrWorkspaceID(),
	}
	deadline := time.Now().Add(herdrRequestTimeout)
	for attempt := 1; attempt <= 9; attempt++ {
		params.Name = baseName
		if attempt > 1 {
			params.Name = fmt.Sprintf("%s (%d)", baseName, attempt)
		}
		req := herdrAgentStartRequest{
			ID:     fmt.Sprintf("code:agent:start:%d", time.Now().UnixNano()),
			Method: "agent.start",
			Params: params,
		}
		response, err := herdrAgentStartAttempt(req, deadline)
		if err != nil {
			return err
		}
		if response.Error != nil {
			if response.Error.Code == "agent_name_taken" && attempt < 9 {
				continue
			}
			return fmt.Errorf("herdr agent.start: %s: %s", response.Error.Code, response.Error.Message)
		}
		if response.Result != nil {
			return nil
		}
		return fmt.Errorf("herdr agent.start: response missing result or error")
	}
	return fmt.Errorf("herdr agent.start: exhausted name attempts")
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
// Once herdr mode is selected, an error remains a herdr launch error: callers
// must not turn the invoking popup into an exec-replaced omp session.
func tryHerdrLaunch(envVar string, fallbacks []string, argv func(string) []string, extraEnv []string) (bool, error) {
	if !herdrSpawnEnabled() {
		return false, nil
	}
	path, err := resolveLaunchPath(envVar, fallbacks)
	if err != nil {
		return true, err
	}
	return true, herdrAgentStart("omp", argv(path), herdrEnvMap(extraEnv))
}

// launchHerdrOrExit is the post-TUI boundary: disabled herdr mode leaves the
// normal exec path available, while an attempted herdr launch either succeeds
// or terminates with an error.
func launchHerdrOrExit(envVar string, fallbacks []string, argv func(string) []string, extraEnv []string) bool {
	attempted, err := tryHerdrLaunch(envVar, fallbacks, argv, extraEnv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: herdr launch failed:", err)
		os.Exit(1)
	}
	if attempted {
		fmt.Fprintln(os.Stdout, "code: launched omp via herdr")
	}
	return attempted
}
