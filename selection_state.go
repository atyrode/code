package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

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

// repairPersistedSelection prevents a hidden fable/main choice from being
// resurrected after loading. Other hidden facets retain their ordinary model
// semantics; only main is a subordinate choice that must be explicitly remade.
func repairPersistedSelection(sel map[string]string) {
	if sel["lane"] == "gpt-only" {
		sel["fable"] = "off"
	}
	if sel["fable"] != "on" {
		sel["main"] = "off"
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

func (m *model) persistSelection() {
	_ = saveSelectionState(m.selectionState, m.sel, m.facets)
}
