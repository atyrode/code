package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func testFacets() []facet { return facetDefs(map[string]string{}) }

func writeSelectionFixture(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestSelectionStateFirstRun(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing", "selection.json")
	if got := loadSelectionState(path, testFacets()); !reflect.DeepEqual(got, defaultSel()) {
		t.Fatalf("first run selection = %v, want defaults %v", got, defaultSel())
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("load created state file or returned unexpected error: %v", err)
	}
}

func TestSelectionStateRoundTripStoresOnlyFacets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "selection.json")
	sel := defaultSel()
	sel["lane"] = "claude-led"
	sel["thinking"] = "xhigh"
	sel["transient-cursor"] = "7"
	if err := saveSelectionState(path, sel, testFacets()); err != nil {
		t.Fatal(err)
	}
	if got := loadSelectionState(path, testFacets()); !reflect.DeepEqual(got, map[string]string{
		"lane": "claude-led", "model": "smart", "thinking": "xhigh", "advisor": "glance",
		"fast": "off", "spark": "on", "prewalk": "off", "planyolo": "off",
	}) {
		t.Fatalf("round-trip selection = %v", got)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]string
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	if _, ok := stored["transient-cursor"]; ok {
		t.Fatalf("non-facet state was persisted: %v", stored)
	}
	if len(stored) != len(testFacets()) {
		t.Fatalf("stored %d keys, want one choice for each of %d facets", len(stored), len(testFacets()))
	}
}

func TestSelectionStateInvalidEntriesKeepCurrentDefaults(t *testing.T) {
	facets := testFacets()
	cases := []struct {
		name string
		body string
		want map[string]string
	}{
		{
			name: "partial and unknown",
			body: `{"thinking":"high","future-facet":"enabled"}`,
			want: func() map[string]string { s := defaultSel(); s["thinking"] = "high"; return s }(),
		},
		{
			name: "invalid value",
			body: `{"lane":"sideways","model":"normal"}`,
			want: func() map[string]string { s := defaultSel(); s["model"] = "normal"; return s }(),
		},
		{
			name: "invalid type does not discard valid siblings",
			body: `{"lane":7,"thinking":"xhigh"}`,
			want: func() map[string]string { s := defaultSel(); s["thinking"] = "xhigh"; return s }(),
		},
		{name: "corrupt JSON", body: `{"lane":`, want: defaultSel()},
		{name: "wrong JSON shape", body: `["lane","mixed"]`, want: defaultSel()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "selection.json")
			writeSelectionFixture(t, path, tc.body)
			if got := loadSelectionState(path, facets); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("selection = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSelectionStatePrivateModes(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "code")
	path := filepath.Join(dir, "selection.json")
	if err := saveSelectionState(path, defaultSel(), testFacets()); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]os.FileMode{dir: 0o700, path: 0o600} {
		info, err := os.Stat(name)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("%s mode = %04o, want %04o", name, got, want)
		}
	}
}

func TestSelectionStatePreservesExistingParentMode(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "shared")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "selection.json")
	if err := saveSelectionState(path, defaultSel(), testFacets()); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o755 {
		t.Fatalf("existing parent mode = %04o, want unchanged 0755", got)
	}
	if info, err = os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("state file mode = %04o, want 0600", got)
	}
}

func TestSelectionStateAtomicReplacementFailureKeepsLastGoodFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "code", "selection.json")
	old := defaultSel()
	old["thinking"] = "low"
	if err := saveSelectionState(path, old, testFacets()); err != nil {
		t.Fatal(err)
	}
	replacement := defaultSel()
	replacement["thinking"] = "high"
	renamed := false
	err := saveSelectionStateWithRename(path, replacement, testFacets(), func(from, to string) error {
		renamed = true
		if filepath.Dir(from) != filepath.Dir(to) {
			t.Fatalf("temporary file %q is not beside destination %q", from, to)
		}
		return os.Rename(from, to)
	})
	if err != nil {
		t.Fatal(err)
	}
	if !renamed {
		t.Fatal("atomic save did not rename a completed temporary file")
	}
	if got := loadSelectionState(path, testFacets()); got["thinking"] != "high" {
		t.Fatalf("replacement stored thinking %q, want high", got["thinking"])
	}
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	next := defaultSel()
	next["thinking"] = "max"
	wantErr := errors.New("injected rename failure")
	err = saveSelectionStateWithRename(path, next, testFacets(), func(_, _ string) error { return wantErr })
	if !errors.Is(err, wantErr) {
		t.Fatalf("save error = %v, want injected rename error", err)
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("failed replacement changed last good file\nbefore: %s\nafter: %s", before, after)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".code-generator-selection-") {
			t.Fatalf("failed replacement leaked temporary file %q", entry.Name())
		}
	}
}

// TestSelectionStateImpossibleSparkNotResurrected: a persisted combination the
// generator can never emit must not come back to life on load. spark's pool
// sits outside a pure-Claude lane's pool-set, so a selection file carrying
// spark:on under claude-only names a combo that was never written — loading it
// verbatim used to leave the dial pointing at a profile the catalog does not
// carry. (Successor to the fable/main invariant test: both those facets are
// gone, spark is the last special tier and keeps the property.)
func TestSelectionStateImpossibleSparkNotResurrected(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"claude-only cannot host spark", `{"lane":"claude-only","spark":"on"}`, "off"},
		{"a lane that hosts it keeps it", `{"lane":"claude-led","spark":"on"}`, "on"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "selection.json")
			writeSelectionFixture(t, path, tc.body)
			got := loadSelectionState(path, testFacets())
			if got["spark"] != tc.want {
				t.Fatalf("loaded spark = %q, want %q: %v", got["spark"], tc.want, got)
			}
		})
	}
}

func TestFacetChangeAndResetPersistSelection(t *testing.T) {
	path := filepath.Join(t.TempDir(), "code", "selection.json")
	m := model{facets: testFacets(), sel: defaultSel(), selectionState: path}

	changedModel, _ := m.Update(tea.KeyMsg{Type: tea.KeyRight})
	changed := changedModel.(model)
	// changed.sel also carries the transient lead/blend derivations of lane;
	// what persists (and reloads) is the facet-only projection.
	if got := loadSelectionState(path, testFacets()); !reflect.DeepEqual(got, selectionChoices(changed.sel, testFacets())) {
		t.Fatalf("facet change persisted %v, want %v", got, selectionChoices(changed.sel, testFacets()))
	}

	resetModel, _ := changed.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'d'}})
	reset := resetModel.(model)
	if got := selectionChoices(reset.sel, testFacets()); !reflect.DeepEqual(got, defaultSel()) {
		t.Fatalf("reset selection = %v, want defaults", got)
	}
	if got := loadSelectionState(path, testFacets()); !reflect.DeepEqual(got, defaultSel()) {
		t.Fatalf("reset persisted %v, want defaults", got)
	}
}

func TestSelectionPersistenceFailureDoesNotBlockFacetChange(t *testing.T) {
	blockedParent := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blockedParent, []byte("block"), 0o600); err != nil {
		t.Fatal(err)
	}
	m := model{
		facets:         testFacets(),
		sel:            defaultSel(),
		selectionState: filepath.Join(blockedParent, "selection.json"),
	}
	before := m.sel["lane"]
	updatedModel, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRight})
	updated := updatedModel.(model)
	if updated.sel["lane"] == before {
		t.Fatalf("facet did not change after persistence failure: %v", updated.sel)
	}
	if cmd != nil {
		t.Fatalf("facet change unexpectedly returned a command after persistence failure")
	}
}

func TestSelectionStateDisabledPath(t *testing.T) {
	sel := defaultSel()
	sel["thinking"] = "max"
	if err := saveSelectionState("", sel, testFacets()); err != nil {
		t.Fatalf("disabled save returned error: %v", err)
	}
	if got := loadSelectionState("", testFacets()); !reflect.DeepEqual(got, defaultSel()) {
		t.Fatalf("disabled load = %v, want defaults", got)
	}
}

// TestSelectionStatePathResolution pins the resolution order the Babel seam
// depends on. The default location is what makes worker mode possible at all —
// Babel strips CODE_SELECTION_STATE — so an unset variable must resolve to a
// path under the state root rather than to the old "stateless" empty string.
func TestSelectionStatePathResolution(t *testing.T) {
	state, home := t.TempDir(), t.TempDir()

	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", state)
	t.Setenv(codeSelectionStateEnv, "")
	if got, want := selectionStatePath(), filepath.Join(state, "code", "selection.json"); got != want {
		t.Errorf("unset selection state = %q, want the XDG default %q", got, want)
	}

	t.Setenv("XDG_STATE_HOME", "")
	if got, want := selectionStatePath(), filepath.Join(home, ".local", "state", "code", "selection.json"); got != want {
		t.Errorf("unset selection state without XDG_STATE_HOME = %q, want the HOME default %q", got, want)
	}

	override := filepath.Join(t.TempDir(), "elsewhere.json")
	t.Setenv(codeSelectionStateEnv, override)
	if got := selectionStatePath(); got != override {
		t.Errorf("override = %q, want it to win outright (%q)", got, override)
	}

	t.Setenv(codeSelectionStateEnv, codeSelectionDisabled)
	if got := selectionStatePath(); got != "" {
		t.Errorf("%s=%s = %q, want the opt-out empty path", codeSelectionStateEnv, codeSelectionDisabled, got)
	}
}

// TestInteractiveDialChangeWritesTheDefaultLocation closes the loop the fix
// exists for: the TUI is the only thing that writes a selection, so a dial
// turned interactively has to land exactly where a worker with a stripped
// environment will look for it.
func TestInteractiveDialChangeWritesTheDefaultLocation(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	t.Setenv(codeSelectionStateEnv, "")

	path := defaultSelectionStatePath()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("default selection location already exists before any dial was turned: %v", err)
	}

	// Constructed the way main does: the resolved targets, not the raw variable.
	state, handoff := selectionStateTargets()
	if handoff != "" {
		t.Fatalf("no override is in force, so nothing should need mirroring: %q", handoff)
	}
	m := model{facets: testFacets(), sel: defaultSel(), selectionState: state}
	turnedModel, _ := m.Update(tea.KeyMsg{Type: tea.KeyRight})
	turned := turnedModel.(model)

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("turning a dial did not write %s: %v", path, err)
	}
	// A second process, resolving the location for itself, must see the choice.
	reloaded := loadSelectionState(selectionStatePath(), testFacets())
	if !reflect.DeepEqual(reloaded, selectionChoices(turned.sel, testFacets())) {
		t.Fatalf("reloaded %v, want the turned dials %v", reloaded, selectionChoices(turned.sel, testFacets()))
	}
}

// TestRelocatedSelectionIsMirroredForTheWorker is the case the operator is
// actually in: his wrapper points CODE_SELECTION_STATE at a path of its own, and
// Babel's worker is handed no such variable. The override still owns the read, so
// the default location has to be kept current or configure mode would keep
// reporting defaults while the TUI showed something else.
func TestRelocatedSelectionIsMirroredForTheWorker(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	override := filepath.Join(t.TempDir(), "wrapper", "code-generator-selection.json")
	t.Setenv(codeSelectionStateEnv, override)

	state, handoff := selectionStateTargets()
	if state != override {
		t.Fatalf("read target = %q, want the override %q", state, override)
	}
	if handoff != defaultSelectionStatePath() {
		t.Fatalf("mirror target = %q, want the default location %q", handoff, defaultSelectionStatePath())
	}

	m := model{facets: testFacets(), sel: defaultSel(), selectionState: state, selectionHandoff: handoff}
	turnedModel, _ := m.Update(tea.KeyMsg{Type: tea.KeyRight})
	want := selectionChoices(turnedModel.(model).sel, testFacets())

	// The override keeps owning the read this process does.
	if got := loadSelectionState(override, testFacets()); !reflect.DeepEqual(got, want) {
		t.Errorf("override holds %v, want the turned dials %v", got, want)
	}
	// And a worker resolving the location with a stripped environment — no
	// override at all — sees the same dials.
	if err := os.Unsetenv(codeSelectionStateEnv); err != nil {
		t.Fatal(err)
	}
	if got := loadSelectionState(selectionStatePath(), testFacets()); !reflect.DeepEqual(got, want) {
		t.Errorf("a stripped-environment reader sees %v, want the turned dials %v", got, want)
	}
}
