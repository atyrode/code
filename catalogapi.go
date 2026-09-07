package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"
)

// These projections are the public one-shot contract, not serialized TUI state.
// In particular, session records' account pools and runtime error text stay local.
type inspectSnapshot struct {
	SchemaVersion   int                   `json:"schema_version"`
	ObservedAt      time.Time             `json:"observed_at"`
	Observation     string                `json:"observation"`
	Catalog         inspectCatalog        `json:"catalog"`
	Selection       map[string]string     `json:"selection"`
	Facets          []inspectFacet        `json:"facets"`
	Routing         []inspectRoute        `json:"routing"`
	Estimates       *inspectEstimates     `json:"estimates"`
	Providers       []inspectProvider     `json:"providers"`
	LaunchModes     []inspectLaunchMode   `json:"launch_modes"`
	RuntimeTargets  []inspectRuntime      `json:"runtime_targets"`
	SessionRegistry string                `json:"session_registry"`
	Sessions        []inspectSession      `json:"sessions"`
	SavedSessions   []inspectSavedSession `json:"saved_sessions"`
	Worktrees       []inspectWorktree     `json:"worktrees"`
}

type inspectCatalog struct {
	State        string   `json:"state"`
	Path         string   `json:"path"`
	ModelsPath   string   `json:"models_path"`
	GeneratePath string   `json:"generate_path"`
	InitArgv     []string `json:"init_argv"`
	GenerateArgv []string `json:"generate_argv"`
}

type inspectFacet struct {
	Key    string   `json:"key"`
	Values []string `json:"values"`
}

type inspectRoute struct {
	Role          string   `json:"role"`
	Primary       string   `json:"primary"`
	Fallbacks     []string `json:"fallbacks"`
	AgentOverride bool     `json:"agent_override"`
}

type inspectEstimates struct {
	Cost     int `json:"cost"`
	Speed    int `json:"speed"`
	ScaleMin int `json:"scale_min"`
	ScaleMax int `json:"scale_max"`
}

type inspectProvider struct {
	ID              string `json:"id"`
	CredentialState string `json:"credential_state"`
}

type inspectLaunchMode struct {
	Mode      string `json:"mode"`
	Available bool   `json:"available"`
}

type inspectRuntime struct {
	Name               string `json:"name"`
	Label              string `json:"label"`
	Phase              string `json:"phase"`
	Model              string `json:"model"`
	ContextWindow      int    `json:"context_window"`
	Provisioned        bool   `json:"provisioned"`
	Running            bool   `json:"running"`
	Healthy            bool   `json:"healthy"`
	DiskBytes          int64  `json:"disk_bytes"`
	EstimatedDiskBytes int64  `json:"estimated_disk_bytes"`
}

type inspectSession struct {
	PID      int       `json:"pid"`
	Profile  string    `json:"profile"`
	Cwd      string    `json:"cwd"`
	Worktree string    `json:"worktree"`
	Resume   string    `json:"resume"`
	Started  time.Time `json:"started"`
	Liveness string    `json:"liveness"`
}

type inspectSavedSession struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Cwd      string    `json:"cwd"`
	Root     string    `json:"root"`
	Worktree string    `json:"worktree"`
	Started  time.Time `json:"started"`
	Activity time.Time `json:"activity"`
	LivePID  int       `json:"live_pid,omitempty"`
}

type inspectWorktree struct {
	Name     string    `json:"name"`
	Branch   string    `json:"branch"`
	Repo     string    `json:"repo"`
	Dir      string    `json:"dir"`
	Created  time.Time `json:"created"`
	Liveness string    `json:"liveness"`
	LivePID  int       `json:"live_pid,omitempty"`
}

func runInspect(args []string) int {
	fs := flag.NewFlagSet("code inspect", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	var selection map[string]string
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
	if fs.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "code inspect: unexpected arguments")
		return 2
	}
	m, err := loadHeadlessModel()
	if err != nil {
		fmt.Fprintf(os.Stderr, "code inspect: %v\n", err)
		return 1
	}
	if (len(catalogLanes(m.generated)) > 0 && !m.noProviders) || len(selection) > 0 {
		m, err = selectHeadlessModel(m, selection)
		if err != nil {
			fmt.Fprintf(os.Stderr, "code inspect: %v\n", err)
			return 2
		}
	}
	snapshot := projectInspect(m, time.Now())
	observeInspectSessions(&snapshot)
	if err := json.NewEncoder(os.Stdout).Encode(snapshot); err != nil {
		fmt.Fprintln(os.Stderr, "code inspect: cannot write snapshot")
		return 1
	}
	return 0
}

func projectInspect(m model, now time.Time) inspectSnapshot {
	path := os.Getenv("CODE_GENERATED")
	if path == "" {
		path = defaultCatalogPath()
	}
	s := inspectSnapshot{
		SchemaVersion: 1, ObservedAt: now.UTC(), Observation: "one_shot",
		Catalog: inspectCatalog{State: "missing", Path: path, ModelsPath: defaultModelsPath(), GeneratePath: defaultCatalogPath(),
			InitArgv: []string{"code", "generate", "init"}, GenerateArgv: []string{"code", "generate"}},
		Selection: map[string]string{}, Facets: []inspectFacet{}, Routing: []inspectRoute{},
		Providers: []inspectProvider{}, LaunchModes: []inspectLaunchMode{}, RuntimeTargets: []inspectRuntime{},
		Sessions: []inspectSession{}, SavedSessions: []inspectSavedSession{}, Worktrees: []inspectWorktree{},
	}
	hasCatalog := len(catalogLanes(m.generated)) > 0
	hostedAvailable := hasCatalog && !m.noProviders
	_, delegated := m.selectedRuntime()
	if hasCatalog {
		s.Catalog.State = "ready"
	}
	if hostedAvailable {
		s.Selection = selectionChoices(m.sel, m.facets)
	}
	for _, f := range m.facets {
		if !hostedAvailable && f.key != "runtime" && !(delegated && f.key == "thinking") {
			continue
		}
		if delegated && f.key != "runtime" && f.key != "thinking" {
			continue
		}
		values := []string{}
		for _, value := range f.values {
			if hasCatalog && m.noProviders && f.key == "runtime" && value == "hosted" {
				continue
			}
			if _, err := selectHeadlessModel(m, map[string]string{f.key: value}); err == nil {
				values = append(values, value)
				if m.sel[f.key] == value {
					s.Selection[f.key] = value
				}
			}
		}
		if len(values) > 0 {
			s.Facets = append(s.Facets, inspectFacet{Key: f.key, Values: values})
		}
	}
	if hostedAvailable && !delegated {
		s.Routing = inspectRouting(m)
		if len(s.Routing) > 0 {
			s.Estimates = &inspectEstimates{Cost: m.costScore(), Speed: m.speedScore(), ScaleMin: 1, ScaleMax: 5}
		}
	}
	if hasCatalog && !delegated {
		pools := map[string]bool{}
		for id := range m.facts {
			pools[m.poolOfModel(id)] = true
		}
		for _, p := range providerRegistry {
			if !pools[p.Pool] {
				continue
			}
			state := "unknown"
			if m.providersResolved {
				state = "unavailable"
				if m.connected[p.Pool] {
					state = "available"
				}
			}
			s.Providers = append(s.Providers, inspectProvider{ID: p.ID, CredentialState: state})
		}
	}
	_, launchErr := resolveLaunchPath("CODE_OMP", []string{"omp"})
	_, managedErr := resolveLaunchPath("CODE_OMP", []string{"omp-managed", "omp"})
	_, untrustedErr := resolveLaunchPath("CODE_OMP_UNTRUSTED", []string{"ompu"})
	s.LaunchModes = []inspectLaunchMode{
		{Mode: "generated", Available: hasCatalog && !delegated && !m.noProviders && launchErr == nil && len(s.Routing) > 0},
		{Mode: "managed", Available: managedErr == nil},
		{Mode: "untrusted", Available: untrustedErr == nil},
		{Mode: "runtime", Available: len(m.runtimeTargets) > 0},
	}
	for _, target := range m.runtimeTargets {
		s.RuntimeTargets = append(s.RuntimeTargets, inspectRuntime{
			Name: target.Name, Label: target.Label, Phase: target.Phase, Model: target.Model,
			ContextWindow: target.ContextWindow, Provisioned: target.Provisioned,
			Running: target.Running, Healthy: target.Healthy, DiskBytes: target.DiskBytes,
			EstimatedDiskBytes: target.EstimatedDiskBytes,
		})
	}
	return s
}

func inspectRouting(m model) []inspectRoute {
	routes := []inspectRoute{}
	for _, row := range m.currentRows() {
		fields := strings.Fields(strings.ReplaceAll(row, "→", " "))
		marked := len(fields) > 0 && fields[0] == "●"
		if marked {
			fields = fields[1:]
		}
		if len(fields) < 2 {
			continue
		}
		route := inspectRoute{Role: fields[0], Fallbacks: []string{}, AgentOverride: marked && fields[0] != "advisor"}
		for _, token := range fields[1:] {
			if !modelRe.MatchString(token) {
				continue
			}
			if route.Primary == "" {
				route.Primary = m.prefixed(token)
			} else if m.sel["fallback"] != "off" {
				route.Fallbacks = append(route.Fallbacks, m.prefixed(token))
			}
		}
		if route.Primary != "" {
			routes = append(routes, route)
		}
	}
	return routes
}

// Use the established registry readers, including their stale-record cleanup.
// No publisher heartbeat is interpreted here. Missing live attribution means
// only that this observation did not find a held registry lock, not a dead PID.
func observeInspectSessions(s *inspectSnapshot) {
	registry := sessionDir()
	s.SessionRegistry = "enabled"
	if registry == "" || registry == sessionDisabled {
		s.SessionRegistry = "disabled"
	}
	live := loadSessions(registry)
	for _, entry := range live {
		s.Sessions = append(s.Sessions, inspectSession{PID: entry.PID, Profile: entry.Profile,
			Cwd: entry.Cwd, Worktree: entry.Worktree, Resume: entry.Resume,
			Started: time.Unix(entry.Started, 0).UTC(), Liveness: "lock_held"})
	}
	cwd, _ := os.Getwd()
	saved := repoSavedSessions(cwd, trustedSessionRoots(""))
	attributed := liveSavedSessions(saved, live)
	for _, entry := range saved {
		s.SavedSessions = append(s.SavedSessions, inspectSavedSession{ID: entry.ID, Title: entry.Title,
			Cwd: entry.Cwd, Root: entry.Root, Worktree: entry.Worktree, Started: entry.Started.UTC(),
			Activity: entry.Activity.UTC(), LivePID: attributed[entry.Path]})
	}
	for _, entry := range loadWorktreeRecords() {
		wt := inspectWorktree{Name: entry.Name, Branch: entry.Branch, Repo: entry.Repo, Dir: entry.Dir,
			Created: time.Unix(entry.Created, 0).UTC(), Liveness: "not_observed"}
		if s.SessionRegistry == "disabled" {
			wt.Liveness = "unknown"
		}
		for _, session := range live {
			if session.Worktree == entry.Dir || session.Cwd == entry.Dir {
				wt.Liveness, wt.LivePID = "lock_held", session.PID
				break
			}
		}
		s.Worktrees = append(s.Worktrees, wt)
	}
}
