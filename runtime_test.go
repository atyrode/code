package main

import (
	"reflect"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestParseRuntimeTargetsFiltersUnsupportedAndUnknownSchema(t *testing.T) {
	got := parseRuntimeTargets([]byte(`[
  {"schemaVersion":1,"name":"z-local","label":"Z local","applicable":true},
  {"schemaVersion":1,"name":"unsupported","applicable":false},
  {"schemaVersion":2,"name":"future","applicable":true},
  {"schemaVersion":1,"name":"a-local","label":"A local","applicable":true}
]`))
	if len(got) != 2 || got[0].Name != "a-local" || got[1].Name != "z-local" {
		t.Fatalf("unexpected targets: %#v", got)
	}
}

func TestRuntimeFacetAndSelection(t *testing.T) {
	targets := []runtimeTarget{{Name: "local-qwen", Label: "Local Qwen", Applicable: true}}
	f := runtimeFacet("R", targets)
	if !reflect.DeepEqual(f.values, []string{"hosted", "local-qwen"}) {
		t.Fatalf("runtime values = %#v", f.values)
	}
	m := model{runtimeTargets: targets, sel: map[string]string{"runtime": "local-qwen"}}
	target, ok := m.selectedRuntime()
	if !ok || target.Name != "local-qwen" || m.runtimeValueLabel(target.Name) != "Local Qwen" {
		t.Fatalf("selected target = %#v, %v", target, ok)
	}
}

func TestRuntimeLaunchArgvOwnsProfileAndThinking(t *testing.T) {
	got := runtimeLaunchArgv("/bin/atyrode", "local-qwen", "high",
		[]string{"--profile", "cloud", "--config=old.yml", "--resume"}, "hello")
	want := []string{"/bin/atyrode", "runtime", "run", "local-qwen", "--", "--thinking", "high", "--resume", "hello"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("argv = %#v; want %#v", got, want)
	}
}

func TestRuntimeStatusLine(t *testing.T) {
	if got := (runtimeTarget{Healthy: true}).statusLine(); got != "ready" {
		t.Fatalf("healthy status = %q", got)
	}
	if got := (runtimeTarget{EstimatedDiskBytes: 40 * 1024 * 1024 * 1024}).statusLine(); got != "downloads on first launch · about 40 GiB" {
		t.Fatalf("first-launch status = %q", got)
	}
}

func TestLocalRuntimeHidesHostedDialsAndLaunchesWithoutCatalog(t *testing.T) {
	targets := []runtimeTarget{{Name: "local-qwen", Label: "Local Qwen", Applicable: true}}
	facets := append([]facet{runtimeFacet("R", targets)}, facetDefs(defaultGlyphs())...)
	sel := defaultSel()
	sel["runtime"] = "local-qwen"
	m := model{runtimeTargets: targets, facets: facets, sel: sel, generated: map[string][]string{}}

	visible := m.visibleFacets()
	if len(visible) != 2 || visible[0].key != "runtime" || visible[1].key != "thinking" {
		t.Fatalf("local facets = %#v", visible)
	}
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	got := next.(model)
	if got.launchRuntime != "local-qwen" || got.genConfig != "" || cmd == nil {
		t.Fatalf("local enter: target=%q config=%q quit=%v", got.launchRuntime, got.genConfig, cmd != nil)
	}
}
