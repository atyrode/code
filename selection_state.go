package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// codeSelectionStateEnv relocates the persisted dial selection.
//
// An empty value used to mean "no persistence at all", which quietly made the
// selection unreachable from the one caller that needs it most: the
// configuration ceremony, which opens Code's dial UI on the operator's terminal
// and mints the profile Babel records (babelconfigure.go). The ceremony reads the
// default location and only the default location — a variable anything in the
// process tree can set must not decide which dials an operator is asked to
// confirm (atyrode/babel#86) — so the dials it shows have to have a place on
// disk that both sides derive independently.
//
// The override still wins for an interactive launch, so a standalone or test run
// can point somewhere explicit; codeSelectionDisabled is the opt-out empty used
// to be.
const codeSelectionStateEnv = "CODE_SELECTION_STATE"

// codeSelectionDisabled is the explicit opt-out, mirroring how
// CODE_SESSION_STATE=off opts out of the session registry: a value, not an
// absence, so forgetting to set the variable never silently disables the feature.
const codeSelectionDisabled = "off"

// defaultSelectionStatePath derives the choice file exactly the way the profile
// store derives its directory (defaultBabelProfileDir): XDG_STATE_HOME, else
// $HOME/.local/state, then under code/. HOME is all a stripped environment
// carries, so a path rooted there is the one seam every mode can derive.
func defaultSelectionStatePath() string {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "state")
	}
	return filepath.Join(base, "code", "selection.json")
}

// selectionStatePath resolves where the dial selection is read from and written
// to. The empty string it can still return is the opt-out both loadSelectionState
// and saveSelectionState already honour as a no-op.
func selectionStatePath() string {
	switch v := os.Getenv(codeSelectionStateEnv); v {
	case codeSelectionDisabled:
		return ""
	case "":
		return defaultSelectionStatePath()
	default:
		return v
	}
}

// selectionStateTargets resolves both places an interactive launch has to keep
// the dials: the path this process reads and owns, and — when an override moved
// that somewhere the ceremony will not look — the default location as well.
//
// The mirror is not a third store, it is the handoff. The operator's wrapper sets
// CODE_SELECTION_STATE to a path of its own, and the ceremony deliberately
// ignores that variable, so a relocated selection would otherwise be invisible to
// it. Writing the default location too is what makes "turn the dials in Code,
// then configure" true for a relocated install as well as a plain one. With no
// override in force the two coincide and this is a single write.
//
// A ceremony does not call this: it reads and writes the default location alone
// (newInteractiveApp), so a dial turned while confirming does not travel back
// into a wrapper's relocated file. The profile is what that keypress produced;
// the dial position is a convenience, and the alternative is honouring the
// variable this whole arrangement exists to ignore.
func selectionStateTargets() (state, handoff string) {
	state = selectionStatePath()
	if def := defaultSelectionStatePath(); state != "" && state != def {
		handoff = def
	}
	return state, handoff
}

// loadSelectionState overlays a persisted choice set onto the current defaults.
// The state is deliberately only facet values: all transient TUI state remains
// owned by the running model.
func loadSelectionState(path string, facets []facet) map[string]string {
	sel := defaultSel()
	if path == "" {
		return sel
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return sel
	}
	var stored map[string]json.RawMessage
	if err := json.Unmarshal(data, &stored); err != nil {
		return sel
	}

	valid := facetValues(facets)
	for key, raw := range stored {
		values, ok := valid[key]
		if !ok {
			continue
		}
		var value string
		if err := json.Unmarshal(raw, &value); err == nil && values[value] {
			sel[key] = value
		}
	}
	repairPersistedSelection(sel)
	return sel
}

func facetValues(facets []facet) map[string]map[string]bool {
	valid := make(map[string]map[string]bool, len(facets))
	for _, f := range facets {
		values := make(map[string]bool, len(f.values))
		for _, value := range f.values {
			values[value] = true
		}
		valid[f.key] = values
	}
	return valid
}

// repairPersistedSelection prevents a hidden special-tier choice from being
// resurrected after loading: spark/fable are forced off when the persisted
// lane's pool-set cannot host them, and main (a subordinate choice that must
// be explicitly remade) never outlives fable.
func repairPersistedSelection(sel map[string]string) {
	repairSelectionSpecials(sel)
}

// repairSelectionSpecials is the one lane-validity rule shared by persisted
// loads and live suggestions: a special-tier facet is forced off iff its
// provider's pool is outside the selected lane's pool-set.
func repairSelectionSpecials(sel map[string]string) {
	for _, facet := range []string{"spark", "fable"} {
		if !laneHostsSpecial(sel["lane"], facet) {
			sel[facet] = "off"
		}
	}
	if sel["fable"] != "on" {
		sel["main"] = "off"
	}
	// relief is only a choice on a metered-led blend; everywhere else the
	// generator writes a single (on) variant, so the selection must match.
	if !laneReliefApplies(sel["lane"]) {
		sel["relief"] = "on"
	}
}

func selectionChoices(sel map[string]string, facets []facet) map[string]string {
	choices := make(map[string]string, len(facets))
	for _, f := range facets {
		if value, ok := sel[f.key]; ok {
			choices[f.key] = value
		}
	}
	return choices
}

// saveSelectionState atomically replaces the choice file. An empty path is the
// standalone-package opt-out: it performs no filesystem work and succeeds.
func saveSelectionState(path string, sel map[string]string, facets []facet) error {
	return saveSelectionStateWithRename(path, sel, facets, os.Rename)
}

func saveSelectionStateWithRename(path string, sel map[string]string, facets []facet, rename func(string, string) error) error {
	if path == "" {
		return nil
	}
	dir := filepath.Dir(path)
	dirMissing := false
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		dirMissing = true
	} else if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	// Tighten only a directory this save created. CODE_SELECTION_STATE is an
	// override and may legitimately name a file beneath an existing shared
	// parent (for example /tmp); mutating that parent's mode is unsafe.
	if dirMissing {
		if err := os.Chmod(dir, 0o700); err != nil {
			return err
		}
	}

	tmp, err := os.CreateTemp(dir, ".code-generator-selection-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)

	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	enc := json.NewEncoder(tmp)
	if err := enc.Encode(selectionChoices(sel, facets)); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := rename(tmpPath, path); err != nil {
		return err
	}

	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	if err := d.Sync(); err != nil && !errors.Is(err, os.ErrInvalid) {
		return err
	}
	return nil
}

// persistSelection writes the turned dials to every location that has to see
// them. selectionHandoff is empty unless an override relocated the selection, in
// which case it is the default location the configuration ceremony reads;
// saveSelectionState treats an empty path as a no-op, so the common case is one
// write.
func (m *model) persistSelection() {
	_ = saveSelectionState(m.selectionState, m.sel, m.facets)
	_ = saveSelectionState(m.selectionHandoff, m.sel, m.facets)
}
