// code-machine is the narrow product-operation boundary inside a Manifold job.
// The runtime owns the executable binding, environment, sandbox and job lifetime.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

const (
	codeTool = "/runtime/bin/code"
	maxInput = 64 << 10
	maxOutput = 1 << 20
	failureMessage = "code-machine: operation failed"
)

var errInvalid = errors.New("invalid operation data")

type selectionPayload struct {
	Selection map[string]string `json:"selection,omitempty"`
	State *accountChoiceState `json:"state,omitempty"`
	BaseRevision *int64 `json:"baseRevision,omitempty" nullable:"true"`
}

type suggestPayload struct {
	Selection map[string]string `json:"selection,omitempty"`
	Prompt string `json:"prompt"`
	State *accountChoiceState `json:"state,omitempty"`
	BaseRevision *int64 `json:"baseRevision,omitempty" nullable:"true"`
}

type accountPayload struct {
	Provider string `json:"provider"`
	Identity string `json:"identity"`
}

type accountChoiceState struct {
	SchemaVersion int `json:"schemaVersion"`
	ActivePreset string `json:"activePreset"`
	ManualDisabled []accountReference `json:"manualDisabled"`
	Presets []preset `json:"presets"`
}

type accountListPayload struct {
	State *accountChoiceState `json:"state,omitempty"`
	BaseRevision *int64 `json:"baseRevision,omitempty" nullable:"true"`
}

type accountSetPayload struct {
	Provider string `json:"provider"`
	Identity string `json:"identity"`
	Enabled bool `json:"enabled"`
	State accountChoiceState `json:"state"`
	BaseRevision int64 `json:"baseRevision"`
}

type presetPayload struct {
	Name string `json:"name"`
	State accountChoiceState `json:"state"`
	BaseRevision int64 `json:"baseRevision"`
}

type presetWritePayload struct {
	Name string `json:"name"`
	Disabled []accountReference `json:"disabled"`
	State accountChoiceState `json:"state"`
	BaseRevision int64 `json:"baseRevision"`
}

// Values are always attached to fixed flag names, never parsed as additional
// flags or shell syntax. Code, not this adapter, validates product selections.
func operationArgs(operation, payload string) ([]string, *int64, error) {
	if len(payload) > maxInput {
		return nil, nil, errInvalid
	}
	data := []byte(payload)
	selectionArgs := func(args []string, selection map[string]string) []string {
		if selection != nil {
			encoded, _ := json.Marshal(selection)
			args = append(args, "--selection="+string(encoded))
		}
		return args
	}
	stateArgs := func(args []string, state *accountChoiceState, revision *int64) ([]string, *int64, error) {
		if revision != nil && (*revision < 0 || *revision > 9007199254740991) {
			return nil, nil, errInvalid
		}
		if state != nil {
			if state.SchemaVersion != 1 {
				return nil, nil, errInvalid
			}
			encoded, _ := json.Marshal(state)
			args = append(args, "--state="+string(encoded))
		}
		return args, revision, nil
	}
	switch operation {
	case "inspect":
		var p selectionPayload
		if decodeDocument(data, &p, true) != nil { return nil, nil, errInvalid }
		return stateArgs(selectionArgs([]string{"inspect"}, p.Selection), p.State, p.BaseRevision)
	case "suggest":
		var p suggestPayload
		if decodeDocument(data, &p, true) != nil || strings.TrimSpace(p.Prompt) == "" { return nil, nil, errInvalid }
		return stateArgs(selectionArgs([]string{"suggest", "--prompt="+p.Prompt}, p.Selection), p.State, p.BaseRevision)
	case "usage":
		var p accountListPayload
		if decodeDocument(data, &p, true) != nil { return nil, nil, errInvalid }
		return stateArgs([]string{"usage"}, p.State, p.BaseRevision)
	case "accounts-list":
		var p accountListPayload
		if decodeDocument(data, &p, true) != nil { return nil, nil, errInvalid }
		return stateArgs([]string{"accounts", "list"}, p.State, p.BaseRevision)
	case "account-set":
		var p accountSetPayload
		if decodeDocument(data, &p, true) != nil || p.Provider == "" || p.Identity == "" { return nil, nil, errInvalid }
		return stateArgs([]string{"accounts", "set", "--provider="+p.Provider, "--identity="+p.Identity, "--enabled="+strconv.FormatBool(p.Enabled)}, &p.State, &p.BaseRevision)
	case "account-clear-blocks":
		var p accountPayload
		if decodeDocument(data, &p, true) != nil || p.Provider == "" || p.Identity == "" { return nil, nil, errInvalid }
		return []string{"accounts", "clear-blocks", "--provider="+p.Provider, "--identity="+p.Identity}, nil, nil
	case "preset-create", "preset-update":
		var p presetWritePayload
		if decodeDocument(data, &p, true) != nil || strings.TrimSpace(p.Name) == "" { return nil, nil, errInvalid }
		for _, reference := range p.Disabled {
			if reference.Provider == "" || reference.IdentityKey == "" { return nil, nil, errInvalid }
		}
		disabled, _ := json.Marshal(p.Disabled)
		return stateArgs([]string{"accounts", "presets", strings.TrimPrefix(operation, "preset-"), "--name="+p.Name, "--disabled="+string(disabled)}, &p.State, &p.BaseRevision)
	case "preset-activate", "preset-delete":
		var p presetPayload
		if decodeDocument(data, &p, true) != nil || strings.TrimSpace(p.Name) == "" { return nil, nil, errInvalid }
		return stateArgs([]string{"accounts", "presets", strings.TrimPrefix(operation, "preset-"), "--name="+p.Name}, &p.State, &p.BaseRevision)
	default:
		return nil, nil, errInvalid
	}
}

// An overflow is sticky: neither a partial prefix nor later writes can become
// a successful snapshot, even if the child ignores its broken stdout pipe.
type boundedOutput struct {
	buffer bytes.Buffer
	overflow bool
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	if b.overflow || len(p) > maxOutput-b.buffer.Len() {
		b.overflow = true
		return 0, errInvalid
	}
	return b.buffer.Write(p)
}

func execute(args []string) ([]byte, error) {
	if len(args) != 2 { return nil, errInvalid }
	argv, baseRevision, err := operationArgs(args[0], args[1])
	if err != nil { return nil, errInvalid }
	var stdout boundedOutput
	cmd := exec.Command(codeTool, argv...)
	cmd.Stdout = &stdout
	// Nil stdin/stderr attach to the null device. Raw child output and errors
	// never reach the job's public streams. The sandbox supplies the environment.
	if cmd.Run() != nil || stdout.overflow { return nil, errInvalid }
	return projectResult(args[0], stdout.buffer.Bytes(), baseRevision)
}

func main() {
	result, err := execute(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, failureMessage)
		os.Exit(1)
	}
	// Nothing is written until the entire child result has passed validation.
	result = append(result, '\n')
	if _, err := os.Stdout.Write(result); err != nil {
		fmt.Fprintln(os.Stderr, failureMessage)
		os.Exit(1)
	}
}
