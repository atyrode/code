package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func obTestModel() model {
	glyphs := defaultGlyphs()
	facets := facetDefs(glyphs)
	return model{
		glyphs: glyphs,
		facets: facets,
		sel:    defaultSel(),
		avail:  availability{bucket: map[string]string{}, reset: map[string]int64{}},
	}
}

func enter() tea.KeyMsg { return tea.KeyMsg{Type: tea.KeyEnter} }

// TestOnboardingScanFlow drives the full first-run path: intro → scan (stubbed
// omp) → review → generate → hand-off to the real model with a live catalog.
func TestOnboardingScanFlow(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), "cfg"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(t.TempDir(), "data"))
	orig := ompModelsJSON
	ompModelsJSON = func() ([]byte, error) { return []byte(initJSON), nil }
	defer func() { ompModelsJSON = orig }()

	o := newOnboarding(obTestModel())
	if o.step != obIntro || o.existing {
		t.Fatalf("fresh onboarding: step=%v existing=%v", o.step, o.existing)
	}
	if !strings.Contains(o.View(), "first run") {
		t.Error("intro view missing header")
	}

	next, _ := o.Update(enter())
	o = next.(onboarding)
	if o.step != obScanning {
		t.Fatalf("after intro enter: step=%v", o.step)
	}

	next, _ = o.Update(obScan())
	o = next.(onboarding)
	if o.step != obReview || o.cat == nil {
		t.Fatalf("after scan: step=%v cat=%v", o.step, o.cat)
	}
	view := o.View()
	for _, want := range []string{"claude-opus-4-8", "gpt-5.6-sol", "sanity-check"} {
		if !strings.Contains(view, want) {
			t.Errorf("review view missing %q", want)
		}
	}

	next, _ = o.Update(enter())
	o = next.(onboarding)
	if o.step != obGenerating {
		t.Fatalf("after review enter: step=%v", o.step)
	}

	final, _ := o.Update(o.generateCmd()())
	m, ok := final.(model)
	if !ok {
		t.Fatalf("expected hand-off to model, got %T (err: %s)", final, o.errMsg)
	}
	if len(m.generated) == 0 || len(m.facts) == 0 || len(m.advisors) == 0 {
		t.Errorf("handed-off model has no catalog: %d blocks, %d facts, %d advisors",
			len(m.generated), len(m.facts), len(m.advisors))
	}
	if _, err := os.Stat(defaultModelsPath()); err != nil {
		t.Errorf("models file not written: %v", err)
	}
	if _, err := os.Stat(defaultCatalogPath()); err != nil {
		t.Errorf("catalog not written: %v", err)
	}
}

// TestOnboardingExistingModelsFile skips the scan when a models file already
// exists and reviews it directly.
func TestOnboardingExistingModelsFile(t *testing.T) {
	cfg := filepath.Join(t.TempDir(), "cfg")
	t.Setenv("XDG_CONFIG_HOME", cfg)
	t.Setenv("XDG_DATA_HOME", filepath.Join(t.TempDir(), "data"))
	if err := os.MkdirAll(filepath.Join(cfg, "code"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg, "code", "models.yml"), []byte(fixtureYML), 0o644); err != nil {
		t.Fatal(err)
	}

	o := newOnboarding(obTestModel())
	if !o.existing {
		t.Fatal("existing models file not detected")
	}
	next, _ := o.Update(enter())
	o = next.(onboarding)
	if o.step != obReview {
		t.Fatalf("existing file should go straight to review, got step=%v (err %s)", o.step, o.errMsg)
	}
	if !strings.Contains(o.View(), "from your models file") {
		t.Error("review view should say the ladder came from the existing file")
	}
	next, _ = o.Update(enter())
	o = next.(onboarding)
	final, _ := o.Update(o.generateCmd()())
	if _, ok := final.(model); !ok {
		t.Fatalf("expected hand-off, got %T (err: %s)", final, o.errMsg)
	}
}

// TestOnboardingErrorAndRetry surfaces a failed scan with a remedy and lets
// enter retry.
func TestOnboardingErrorAndRetry(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(t.TempDir(), "cfg"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(t.TempDir(), "data"))
	calls := 0
	orig := ompModelsJSON
	ompModelsJSON = func() ([]byte, error) {
		calls++
		if calls == 1 {
			return nil, errors.New("exec: omp: not found")
		}
		return []byte(initJSON), nil
	}
	defer func() { ompModelsJSON = orig }()

	o := newOnboarding(obTestModel())
	next, _ := o.Update(enter())
	o = next.(onboarding)
	next, _ = o.Update(obScan())
	o = next.(onboarding)
	if o.step != obError {
		t.Fatalf("failed scan should land on obError, got %v", o.step)
	}
	if !strings.Contains(o.View(), "PATH") {
		t.Error("omp-missing error should mention PATH in the remedy")
	}

	next, _ = o.Update(enter()) // retry
	o = next.(onboarding)
	if o.step != obScanning {
		t.Fatalf("retry should rescan, got %v", o.step)
	}
	next, _ = o.Update(obScan())
	o = next.(onboarding)
	if o.step != obReview {
		t.Fatalf("second scan should succeed, got %v (err %s)", o.step, o.errMsg)
	}
}

// TestOnboardingQuitReturnsWrapper: quitting mid-onboarding must NOT hand off —
// main() type-asserts the final model and a wrapper yields no launch flags.
func TestOnboardingQuitReturnsWrapper(t *testing.T) {
	o := newOnboarding(obTestModel())
	next, cmd := o.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	if _, ok := next.(onboarding); !ok {
		t.Fatalf("quit should keep the wrapper, got %T", next)
	}
	if cmd == nil {
		t.Fatal("quit should produce a command")
	}
}
