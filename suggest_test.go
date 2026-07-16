package main

import (
	"strings"
	"testing"

	clikit "github.com/atyrode/cli-kit"
)

func TestValidFacetActions(t *testing.T) {
	facets := facetDefs(map[string]string{})
	in := []clikit.Action{
		{Key: "model", Value: "fast"},    // valid
		{Key: "thinking", Value: "high"}, // valid
		{Key: "lane", Value: "purple"},   // invalid value → dropped
		{Key: "nonsense", Value: "x"},    // unknown facet → dropped
		{Key: "spark", Value: "on"},      // valid
		{Key: "main", Value: "on"},       // manual-only facet → dropped
	}
	got := validFacetActions(facets, in)
	want := []clikit.Action{{Key: "model", Value: "fast"}, {Key: "thinking", Value: "high"}, {Key: "spark", Value: "on"}}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("action %d = %v, want %v", i, got[i], want[i])
		}
	}
}

func TestClassifyMessage(t *testing.T) {
	msg := classifyMessage("check the docs for X")
	// The difficulty rubric and the sizing facets it maps to must be present.
	for _, s := range []string{"difficulty", "trivial", "critical", "model=", "thinking=", "advisor="} {
		if !strings.Contains(msg, s) {
			t.Errorf("classifyMessage missing %q", s)
		}
	}
	// lane is NOT suggested (a 3B can't pick a pool; it invented "lane: smart").
	if strings.Contains(msg, "lane") {
		t.Errorf("classifyMessage should not mention lane, got:\n%s", msg)
	}
	// The user's prompt must be embedded as delimited data, not a bare instruction.
	if !strings.Contains(msg, "\"\"\"\ncheck the docs for X\n\"\"\"") {
		t.Errorf("classifyMessage must embed the prompt as delimited data, got:\n%s", msg)
	}
}

func TestEvalCommanderParseFiltersInvalid(t *testing.T) {
	// The wrapper must drop values the generator can't apply, so the box shows only
	// what will actually change (no hallucinated lane value leaking through).
	c := evalCommander{facets: facetDefs(map[string]string{})}
	got, err := c.Parse(`{"model":"smart","thinking":"high","lane":"smart"}`)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	for _, a := range got {
		if a.Key == "lane" {
			t.Errorf("invalid lane value should be filtered, got %v", got)
		}
	}
	if len(got) != 2 {
		t.Errorf("want 2 valid actions (model, thinking), got %v", got)
	}
}

func TestTruncateForClassify(t *testing.T) {
	// A short prompt is passed through untouched.
	if got := truncateForClassify("small"); got != "small" {
		t.Errorf("short prompt altered: %q", got)
	}
	// A long paste is capped (bounding the CPU prompt-eval cost) and marked.
	long := strings.Repeat("x", maxClassifyChars+50)
	got := truncateForClassify(long)
	if len([]rune(got)) > maxClassifyChars+2 || !strings.HasSuffix(got, "…") {
		t.Errorf("long prompt not truncated+marked, len=%d", len([]rune(got)))
	}
}

func TestAppliedDiff(t *testing.T) {
	// The diff must include every changed facet (model's picks + derived toggles),
	// in facet order, and skip unchanged ones.
	m := model{facets: facetDefs(map[string]string{}),
		savedSel: map[string]string{"model": "normal", "thinking": "medium", "spark": "on", "fable": "off"},
		sel:      map[string]string{"model": "smart", "thinking": "xhigh", "spark": "on", "fable": "on"}}
	got := m.appliedDiff()
	want := []clikit.Action{{Key: "model", Value: "smart"}, {Key: "thinking", Value: "xhigh"}, {Key: "fable", Value: "on"}}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("action %d = %v, want %v", i, got[i], want[i])
		}
	}
}

func TestDeriveToggles(t *testing.T) {
	avail := func() availability { return availability{bucket: map[string]string{}} }
	// critical-tier sizing, Claude-capable lane, fable free → fable on, fast off.
	m := &model{sel: map[string]string{"model": "smart", "thinking": "xhigh", "lane": "mixed"}, avail: avail()}
	m.deriveToggles()
	if m.sel["fable"] != "on" || m.sel["fast"] != "off" {
		t.Errorf("critical: want fable on/fast off, got fable=%q fast=%q", m.sel["fable"], m.sel["fast"])
	}
	// trivial sizing → fast on, fable off.
	m = &model{sel: map[string]string{"model": "fast", "thinking": "minimal", "lane": "mixed"}, avail: avail()}
	m.deriveToggles()
	if m.sel["fast"] != "on" || m.sel["fable"] != "off" {
		t.Errorf("trivial: want fast on/fable off, got fast=%q fable=%q", m.sel["fast"], m.sel["fable"])
	}
	// critical but fable bucket maxed → fable stays off (never suggest a maxed model).
	m = &model{sel: map[string]string{"model": "smart", "thinking": "max", "lane": "mixed"},
		avail: availability{bucket: map[string]string{"claude-fable": "maxed"}}}
	m.deriveToggles()
	if m.sel["fable"] != "off" {
		t.Errorf("fable must stay off when its bucket is maxed, got %q", m.sel["fable"])
	}
	// critical but gpt-only lane can't host Claude → fable off.
	m = &model{sel: map[string]string{"model": "smart", "thinking": "xhigh", "lane": "gpt-only"}, avail: avail()}
	m.deriveToggles()
	if m.sel["fable"] != "off" {
		t.Errorf("fable must be off on a gpt-only lane, got %q", m.sel["fable"])
	}
}

func TestRepairConstraintsValidity(t *testing.T) {
	// spark can't coexist with a pure-Claude lane; fable can't with a pure-GPT one.
	m := &model{sel: map[string]string{"lane": "claude-only", "spark": "on", "fable": "on"},
		avail: availability{bucket: map[string]string{}}}
	m.repairConstraints()
	if m.sel["spark"] != "off" {
		t.Errorf("spark must be off under claude-only, got %q", m.sel["spark"])
	}
	m = &model{sel: map[string]string{"lane": "gpt-only", "spark": "on", "fable": "on"},
		avail: availability{bucket: map[string]string{}}}
	m.repairConstraints()
	if m.sel["fable"] != "off" {
		t.Errorf("fable must be off under gpt-only, got %q", m.sel["fable"])
	}
}

func TestRepairConstraintsQuota(t *testing.T) {
	// A maxed/unauthed bucket forces its toggle off regardless of lane.
	m := &model{sel: map[string]string{"lane": "mixed", "spark": "on", "fable": "on"},
		avail: availability{bucket: map[string]string{"claude-fable": "maxed", "codex-spark": "unauthed"}}}
	m.repairConstraints()
	if m.sel["fable"] != "off" {
		t.Errorf("fable must be off when its bucket is maxed, got %q", m.sel["fable"])
	}
	if m.sel["spark"] != "off" {
		t.Errorf("spark must be off when its bucket is unauthed, got %q", m.sel["spark"])
	}
}

// TestRepairConstraintsMainCascade: fable-as-main can never outlive fable — any
// repair path that ends with fable off (lane, quota, or a derived toggle) must
// clear main too, so a later fable=on never resurrects the escalation unasked.
func TestRepairConstraintsMainCascade(t *testing.T) {
	// gpt-only forces fable off → main follows.
	m := &model{sel: map[string]string{"lane": "gpt-only", "fable": "on", "main": "on"},
		avail: availability{bucket: map[string]string{}}}
	m.repairConstraints()
	if m.sel["main"] != "off" {
		t.Errorf("main must cascade off with fable under gpt-only, got %q", m.sel["main"])
	}
	// a maxed fable bucket forces fable off → main follows.
	m = &model{sel: map[string]string{"lane": "mixed", "fable": "on", "main": "on"},
		avail: availability{bucket: map[string]string{"claude-fable": "maxed"}}}
	m.repairConstraints()
	if m.sel["main"] != "off" {
		t.Errorf("main must cascade off when fable's bucket is maxed, got %q", m.sel["main"])
	}
	// fable already off (e.g. deriveToggles sized down) → stale main clears.
	m = &model{sel: map[string]string{"lane": "mixed", "fable": "off", "main": "on"},
		avail: availability{bucket: map[string]string{}}}
	m.repairConstraints()
	if m.sel["main"] != "off" {
		t.Errorf("main must clear whenever fable is off, got %q", m.sel["main"])
	}
	// fable on and available → a manually chosen main survives repair.
	m = &model{sel: map[string]string{"lane": "mixed", "fable": "on", "main": "on"},
		avail: availability{bucket: map[string]string{}}}
	m.repairConstraints()
	if m.sel["main"] != "on" {
		t.Errorf("a manual main must survive repair while fable stays on, got %q", m.sel["main"])
	}
}

func TestEvalSystemPromptIsSizerRole(t *testing.T) {
	s := string(evalSystemPrompt)
	if !strings.Contains(s, "difficulty") || !strings.Contains(s, "never") {
		t.Errorf("evalSystemPrompt should pin the difficulty-rating, sizer-only role, got: %q", s)
	}
}
