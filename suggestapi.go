package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	clikit "github.com/atyrode/cli-kit"
	"github.com/atyrode/cli-kit/ollama"
)

type suggestSnapshot struct {
	SchemaVersion int               `json:"schema_version"`
	ObservedAt    time.Time         `json:"observed_at"`
	Observation   string            `json:"observation"`
	Evaluator     string            `json:"evaluator"`
	Actions       []suggestAction   `json:"actions"`
	Selection     map[string]string `json:"selection"`
}

type suggestAction struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

func runSuggest(args []string) int {
	fs := flag.NewFlagSet("code suggest", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var selection map[string]string
	var prompt string
	promptSet := false
	fs.Func("prompt", "task to size (or pass positional prompt after flags)", func(value string) error {
		prompt, promptSet = value, true
		return nil
	})
	fs.Func("selection", "JSON object of explicit facet choices", func(raw string) error {
		var err error
		selection, err = decodeLaunchSelection(raw)
		return err
	})
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if promptSet && fs.NArg() > 0 {
		fmt.Fprintln(os.Stderr, "code suggest: use --prompt or positional prompt, not both")
		return 2
	}
	if !promptSet {
		prompt = strings.Join(fs.Args(), " ")
	}
	if strings.TrimSpace(prompt) == "" {
		fmt.Fprintln(os.Stderr, "code suggest: a prompt is required")
		return 2
	}
	m, err := loadHeadlessModel(nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "code suggest: %v\n", err)
		return 1
	}
	m, err = selectHeadlessModel(m, selection)
	if err != nil {
		fmt.Fprintf(os.Stderr, "code suggest: %v\n", err)
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	result, err := proposeHeadlessSelection(ctx, m, prompt)
	if err != nil {
		fmt.Fprintf(os.Stderr, "code suggest: %v\n", err)
		return 1
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, "code suggest: cannot write proposal")
		return 1
	}
	return 0
}

// Keep the existing classifier, stream parser and deterministic sizing rules.
// Its TUI Parse wrapper drops unknown actions; this API instead refuses the
// complete proposal so an invalid provider cannot disappear behind a success.
func proposeHeadlessSelection(ctx context.Context, m model, prompt string) (suggestSnapshot, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if len(catalogLanes(m.generated)) == 0 {
		return suggestSnapshot{}, errors.New("no catalog; run code generate init, then code generate")
	}
	if _, delegated := m.selectedRuntime(); delegated {
		return suggestSnapshot{}, errors.New("suggestions require hosted catalog routing")
	}
	commander := m.Commander().(evalCommander).Commander
	endpoint, err := suggestionLoopbackEndpoint(commander.Endpoint)
	if err != nil {
		return suggestSnapshot{}, err
	}
	commander.Endpoint = endpoint
	// No proxy or redirect can carry the task outside the loopback endpoint.
	transport := &http.Transport{}
	defer transport.CloseIdleConnections()
	commander.Client = &http.Client{Transport: suggestionResponseTransport{transport}, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	stream, err := commander.Propose(ctx, prompt)
	if err != nil {
		return suggestSnapshot{}, errors.New("local evaluator unavailable")
	}
	var output strings.Builder
	for chunk := range stream {
		if output.Len()+len(chunk) > 64<<10 {
			return suggestSnapshot{}, errors.New("local evaluator response too large")
		}
		output.WriteString(chunk)
	}
	if ctx.Err() != nil {
		return suggestSnapshot{}, errors.New("local evaluator timed out or was cancelled")
	}
	actions, err := commander.Parse(output.String())
	if err != nil || len(actions) == 0 {
		return suggestSnapshot{}, errors.New("local evaluator returned no valid proposal")
	}
	proposed, err := applyHeadlessSuggestion(m, actions)
	if err != nil {
		return suggestSnapshot{}, err
	}
	result := suggestSnapshot{SchemaVersion: 1, ObservedAt: time.Now().UTC(), Observation: "one_shot",
		Evaluator: evalModel(), Actions: []suggestAction{}, Selection: selectionChoices(proposed.sel, proposed.facets)}
	for _, f := range proposed.facets {
		if proposed.sel[f.key] != m.sel[f.key] {
			result.Actions = append(result.Actions, suggestAction{Key: f.key, Value: proposed.sel[f.key]})
		}
	}
	return result, nil
}

// cli-kit v0.1.0's Commander stream drops decoder errors and the done flag,
// and emits upstream errors as command text. Validate the bounded wire response
// before giving it to that existing parser; EOF alone is not successful completion.
type suggestionResponseTransport struct {
	base http.RoundTripper
}

func (t suggestionResponseTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return resp, nil
	}
	defer resp.Body.Close()
	const maxResponse = 64 << 10
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil {
		return nil, errors.New("local evaluator response incomplete")
	}
	if len(body) > maxResponse {
		return nil, errors.New("local evaluator response too large")
	}
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 8192), maxResponse+1)
	done := false
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var frame struct {
			Message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"message"`
			Done  bool   `json:"done"`
			Error string `json:"error"`
		}
		if done || json.Unmarshal(line, &frame) != nil || frame.Error != "" {
			return nil, errors.New("local evaluator response invalid")
		}
		done = frame.Done
	}
	if scanner.Err() != nil || !done {
		return nil, errors.New("local evaluator response incomplete")
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))
	return resp, nil
}

func applyHeadlessSuggestion(m model, actions []clikit.Action) (model, error) {
	updates := make(map[string]string, len(actions))
	for _, action := range actions {
		if _, duplicate := updates[action.Key]; duplicate {
			return model{}, errors.New("local evaluator returned duplicate dial actions")
		}
		updates[action.Key] = action.Value
	}
	proposed, err := selectHeadlessModel(m, updates)
	if err != nil {
		return model{}, errors.New("local evaluator proposed unavailable facet or provider choices")
	}
	proposed.deriveToggles()
	for key, value := range updates {
		proposed.sel[key] = value
	}
	// Derived sizing is advisory: a lane without priority service cannot use
	// fast:on. Explicit evaluator choices were checked above and remain binding.
	if _, explicit := updates["fast"]; !explicit && len(laneServiceTiers(proposed.sel["lane"])) == 0 {
		proposed.sel["fast"] = "off"
	}
	proposed.repairConstraints()
	for key, value := range updates {
		if proposed.sel[key] != value {
			return model{}, errors.New("local evaluator proposed unavailable routing")
		}
	}
	// Validate every emitted choice, not only defaults: the result must roundtrip
	// through launch without silently clamping a derived switch or caller choice.
	proposed, err = selectHeadlessModel(proposed, selectionChoices(proposed.sel, proposed.facets))
	if err != nil {
		return model{}, errors.New("local evaluator proposed unavailable routing")
	}
	return proposed, nil
}

func suggestionLoopbackEndpoint(endpoint string) (string, error) {
	if endpoint == "" {
		endpoint = ollama.DefaultEndpoint
	}
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("CODE_OLLAMA_ENDPOINT must be a loopback HTTP URL without credentials, query or fragment")
	}
	host := u.Hostname()
	if strings.EqualFold(host, "localhost") {
		host = "127.0.0.1"
		if u.Port() != "" {
			u.Host = net.JoinHostPort(host, u.Port())
		} else {
			u.Host = host
		}
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return "", errors.New("CODE_OLLAMA_ENDPOINT must use a loopback address")
	}
	return strings.TrimRight(u.String(), "/"), nil
}
