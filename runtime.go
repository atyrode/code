package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

const runtimeDiscoveryTimeout = 2 * time.Second

// runtimeTarget is the small, versioned contract exposed by an external runtime
// broker. The broker owns hardware detection, provisioning, secrets, and the
// model server; code only discovers applicable targets and delegates launches.
type runtimeTarget struct {
	SchemaVersion      int    `json:"schemaVersion"`
	Name               string `json:"name"`
	Label              string `json:"label"`
	Phase              string `json:"phase"`
	Reason             string `json:"reason"`
	Model              string `json:"model"`
	ContextWindow      int    `json:"contextWindow"`
	Applicable         bool   `json:"applicable"`
	Provisioned        bool   `json:"provisioned"`
	Running            bool   `json:"running"`
	Healthy            bool   `json:"healthy"`
	DiskBytes          int64  `json:"diskBytes"`
	EstimatedDiskBytes int64  `json:"estimatedDiskBytes"`
}

func loadRuntimeTargets() []runtimeTarget {
	broker := strings.TrimSpace(os.Getenv("CODE_RUNTIME_BROKER"))
	if broker == "" {
		return nil
	}
	path, err := exec.LookPath(broker)
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), runtimeDiscoveryTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "runtime", "list", "--json").Output()
	if err != nil {
		return nil
	}
	return parseRuntimeTargets(out)
}

func parseRuntimeTargets(data []byte) []runtimeTarget {
	var targets []runtimeTarget
	if json.Unmarshal(data, &targets) != nil {
		return nil
	}
	out := targets[:0]
	for _, target := range targets {
		if target.SchemaVersion != 1 || strings.TrimSpace(target.Name) == "" || !target.Applicable {
			continue
		}
		if target.Label == "" {
			target.Label = target.Name
		}
		out = append(out, target)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Label < out[j].Label })
	return out
}

func runtimeFacet(glyph string, targets []runtimeTarget) facet {
	values := []string{"hosted"}
	for _, target := range targets {
		values = append(values, target.Name)
	}
	return facet{key: "runtime", values: values, glyph: glyph}
}

func (m model) selectedRuntime() (runtimeTarget, bool) {
	selected := m.sel["runtime"]
	if selected == "" || selected == "hosted" {
		return runtimeTarget{}, false
	}
	for _, target := range m.runtimeTargets {
		if target.Name == selected {
			return target, true
		}
	}
	return runtimeTarget{}, false
}

func (m model) runtimeValueLabel(value string) string {
	if value == "hosted" {
		return value
	}
	for _, target := range m.runtimeTargets {
		if target.Name == value {
			return target.Label
		}
	}
	return value
}

func runtimeLaunchArgv(path, target, thinking string, forwarded []string, prompt string) []string {
	args := []string{"runtime", "run", target, "--", "--thinking", thinking}
	args = append(args, stripRuntimeArgs(forwarded)...)
	if prompt != "" {
		args = append(args, prompt)
	}
	return append([]string{path}, args...)
}

// stripRuntimeArgs removes caller-supplied routing flags. A local runtime owns
// both its OMP profile and config; arguments after -- remain literal prompt text.
func stripRuntimeArgs(args []string) []string {
	clean := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			return append(clean, args[i:]...)
		}
		if arg == "--profile" || arg == "--config" {
			if i+1 < len(args) {
				i++
			}
			continue
		}
		if strings.HasPrefix(arg, "--profile=") || strings.HasPrefix(arg, "--config=") {
			continue
		}
		clean = append(clean, arg)
	}
	return clean
}

func runRuntimeTarget(target, thinking, prompt, dir string) int {
	path, err := resolveLaunchPath("CODE_RUNTIME_BROKER", nil)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: runtime broker not found:", err)
		return 1
	}
	err = runChild(path, runtimeLaunchArgv(path, target, thinking, os.Args[1:], prompt), withoutAuthEnv(os.Environ()), dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: local runtime:", err)
	}
	return childStatus(err)
}

func formatBytes(n int64) string {
	if n <= 0 {
		return ""
	}
	const gib = int64(1024 * 1024 * 1024)
	return fmt.Sprintf("%.0f GiB", float64(n)/float64(gib))
}

func (target runtimeTarget) statusLine() string {
	switch {
	case target.Healthy:
		return "ready"
	case target.Running:
		return "starting"
	case target.Provisioned:
		return "installed · starts on launch"
	default:
		size := formatBytes(target.EstimatedDiskBytes)
		if size != "" {
			return "downloads on first launch · about " + size
		}
		return "downloads on first launch"
	}
}
