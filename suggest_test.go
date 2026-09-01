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
		{Key: "spark", Value: "maybe"},   // value the facet does not offer → dropped
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
	// The diff must include every changed facet (the classifier's picks plus the
	// derived toggles and any repair), in FACET order, and skip unchanged ones —
	// the box's "applied" list is only truthful if it mirrors the dial order the
	// user sees. Note fast sits before spark in facetDefs, so an unchanged fast
	// must not shift spark's position.
	m := model{facets: facetDefs(map[string]string{}),
		savedSel: map[string]string{"model": "normal", "thinking": "medium", "fast": "off", "spark": "on"},
		sel:      map[string]string{"model": "elite", "thinking": "xhigh", "fast": "off", "spark": "off"}}
	got := m.appliedDiff()
	want := []clikit.Action{{Key: "model", Value: "elite"}, {Key: "thinking", Value: "xhigh"}, {Key: "spark", Value: "off"}}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("action %d = %v, want %v", i, got[i], want[i])
		}
	}
}

// TestDeriveToggles: the fast toggle is DERIVED from the sizing pick, never
// carried over. The classifier only answers model/thinking/advisor, so a stale
// fast=on left from a trivial prompt used to survive the next proposal and keep
// routing the cheap priority model at critical sizing. spark is the opposite
// contract — it is not task-specific, so deriveToggles must leave the
// operator's value alone; repairConstraints is the only thing that clears it.
func TestDeriveToggles(t *testing.T) {
	for _, tc := range []struct {
		mtier string
		want  string
	}{
		{"fast", "on"},
		{"normal", "off"},
		{"smart", "off"},
		{"elite", "off"},
	} {
		for _, was := range []string{"on", "off"} {
			m := &model{sel: map[string]string{"model": tc.mtier, "thinking": "medium", "lane": "mixed", "fast": was, "spark": "on"},
				avail: availability{bucket: map[string]string{}}}
			m.deriveToggles()
			if got := m.sel["fast"]; got != tc.want {
				t.Errorf("model=%s (fast was %s): fast = %q, want %q", tc.mtier, was, got, tc.want)
			}
			if got := m.sel["spark"]; got != "on" {
				t.Errorf("model=%s: deriveToggles must not touch spark, got %q", tc.mtier, got)
			}
		}
	}
}

func TestRepairConstraintsValidity(t *testing.T) {
	// spark can't coexist with a pure-Claude lane: its pool is outside that
	// lane's pool-set, so the generator writes no such combo at all.
	m := &model{sel: map[string]string{"lane": "claude-only", "spark": "on"},
		avail: availability{bucket: map[string]string{}}}
	m.repairConstraints()
	if m.sel["spark"] != "off" {
		t.Errorf("spark must be off under claude-only, got %q", m.sel["spark"])
	}
	// ...but a blend that does host its pool keeps a deliberate spark on.
	m = &model{sel: map[string]string{"lane": "claude-led", "spark": "on"},
		avail: availability{bucket: map[string]string{}}}
	m.repairConstraints()
	if m.sel["spark"] != "on" {
		t.Errorf("spark must survive on a lane whose pool-set hosts it, got %q", m.sel["spark"])
	}
}

func TestRepairConstraintsQuota(t *testing.T) {
	// A maxed/unauthed bucket forces spark off regardless of lane — a suggestion
	// must never land on a model whose quota window is already spent.
	for _, state := range []string{"maxed", "unauthed"} {
		m := &model{sel: map[string]string{"lane": "mixed", "spark": "on"},
			avail: availability{bucket: map[string]string{bucketOf("spark"): state}}}
		m.repairConstraints()
		if m.sel["spark"] != "off" {
			t.Errorf("spark must be off when its bucket is %s, got %q", state, m.sel["spark"])
		}
	}
}

// TestApplyActionsNeverEnablesUnavailableSpark walks the whole proposal path
// (whitelist → deriveToggles → repairConstraints), because that is where the
// two properties the old fable tests encoded actually live now: a proposal may
// not switch on a special tier the lane cannot host, nor one whose quota bucket
// is down. A proposal must be no more powerful than a manual change.
func TestApplyActionsNeverEnablesUnavailableSpark(t *testing.T) {
	for _, tc := range []struct {
		name   string
		lane   string
		bucket map[string]string
	}{
		{"lane cannot host spark", "claude-only", map[string]string{}},
		{"spark bucket maxed", "mixed", map[string]string{bucketOf("spark"): "maxed"}},
		{"spark bucket unauthed", "mixed", map[string]string{bucketOf("spark"): "unauthed"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := &model{facets: facetDefs(map[string]string{}),
				sel:   map[string]string{"lane": tc.lane, "model": "smart", "thinking": "medium", "spark": "off", "fast": "off"},
				avail: availability{bucket: tc.bucket}}
			m.applyActions([]clikit.Action{{Key: "spark", Value: "on"}})
			if m.sel["spark"] != "off" {
				t.Errorf("applied proposal left spark on: %v", m.sel)
			}
		})
	}
}

func TestEvalSystemPromptIsSizerRole(t *testing.T) {
	s := string(evalSystemPrompt)
	if !strings.Contains(s, "difficulty") || !strings.Contains(s, "never") {
		t.Errorf("evalSystemPrompt should pin the difficulty-rating, sizer-only role, got: %q", s)
	}
}

// suggestModel builds a three-pool-shaped model for suggestion-path tests:
// all seven lanes on the dial and a controllable quota map.
func suggestModel() model {
	m := model{facets: facetDefs(defaultGlyphs()), sel: defaultSel()}
	for i := range m.facets {
		if m.facets[i].key == "lane" {
			m.facets[i].values = []string{"gpt-only", "gpt-led", "mixed", "claude-led", "claude-only", "ds-led", "ds-only"}
		}
	}
	m.avail = availability{ok: true, bucket: map[string]string{}, reset: map[string]int64{}}
	return m
}

// TestQuotaLaneSuggestion: a suggestion never lands on a lane whose lead pool
// is drained while a sibling lane has headroom - in fallbackPoolOrder, gated
// by the prepaid balance for the pay-as-you-go pool.
func TestQuotaLaneSuggestion(t *testing.T) {
	m := suggestModel()
	m.avail.deepseek = &deepseekBalance{ok: true, currency: "USD", total: "18.03"}

	// Lead pool fine: stay put.
	m.sel["lane"] = "gpt-led"
	m.deriveToggles()
	if m.sel["lane"] != "gpt-led" {
		t.Fatalf("healthy lead pool must not move the lane, got %q", m.sel["lane"])
	}

	// Codex maxed: the first pool in fallbackPoolOrder with headroom leads.
	m.avail.bucket["codex-main"] = "maxed"
	m.deriveToggles()
	if m.sel["lane"] != "claude-led" {
		t.Fatalf("maxed lead pool should fall to claude-led, got %q", m.sel["lane"])
	}

	// Claude maxed too: DeepSeek is the last lane standing (balance is fine).
	m.sel["lane"] = "gpt-led"
	m.avail.bucket["claude-main"] = "maxed"
	m.deriveToggles()
	if m.sel["lane"] != "ds-led" {
		t.Fatalf("both metered pools maxed should fall to ds-led, got %q", m.sel["lane"])
	}

	// ...but not when the balance is under the floor.
	m.sel["lane"] = "gpt-led"
	m.avail.deepseek = &deepseekBalance{ok: true, currency: "USD", total: "1.17"}
	m.deriveToggles()
	if m.sel["lane"] != "gpt-led" {
		t.Fatalf("a dry prepaid pool must not be suggested, got %q", m.sel["lane"])
	}

	// A two-pool catalog (no ds lanes on the dial) never proposes one.
	m2 := suggestModel()
	for i := range m2.facets {
		if m2.facets[i].key == "lane" {
			m2.facets[i].values = []string{"gpt-only", "gpt-led", "mixed", "claude-led", "claude-only"}
		}
	}
	m2.avail.deepseek = &deepseekBalance{ok: true, currency: "USD", total: "50"}
	m2.avail.bucket["codex-main"] = "maxed"
	m2.avail.bucket["claude-main"] = "maxed"
	m2.sel["lane"] = "gpt-led"
	m2.deriveToggles()
	if m2.sel["lane"] != "gpt-led" {
		t.Fatalf("no alternative lane on the dial: stay put, got %q", m2.sel["lane"])
	}
}

// TestBalanceGuardOptionalLane: the prepaid pool's led lane is only ever
// proposed when its balance is known-good. A dry or unknown balance must leave
// the selection where it is — the guard exists so a suggestion never discovers
// $0 mid-session. (This was the relief dial's guard; the dial is gone, the
// lane-fallback path it protected is not.)
func TestBalanceGuardOptionalLane(t *testing.T) {
	for _, tc := range []struct {
		name string
		bal  *deepseekBalance
		want string
	}{
		{"healthy", &deepseekBalance{ok: true, currency: "USD", total: "18.03"}, "ds-led"},
		{"low", &deepseekBalance{ok: true, currency: "USD", total: "0.42"}, "gpt-led"},
		{"fetch failed", &deepseekBalance{ok: false}, "gpt-led"},
		{"no credential", nil, "gpt-led"},
	} {
		m := suggestModel()
		m.sel["lane"] = "gpt-led"
		// Both metered pools spent: the prepaid pool is the only candidate
		// left, so the balance guard alone decides.
		m.avail.bucket["codex-main"] = "maxed"
		m.avail.bucket["claude-main"] = "maxed"
		m.avail.deepseek = tc.bal
		m.deriveToggles()
		if got := m.sel["lane"]; got != tc.want {
			t.Errorf("%s: lane = %q, want %q", tc.name, got, tc.want)
		}
	}
}
