package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixtureYML mirrors the reference catalog the Go port was byte-parity
// verified against (the Python generator's output on the same input matched
// renderCatalog exactly, diff-clean, 2026-07-16). The golden strings below
// come from that verified output.
const fixtureYML = `models:
  luna:
    id: gpt-5.6-luna
    pool: O
    tier: 1
    cost_in: 1
    cost_out: 6
    speed: 52.3
    ttft: 1.18
    thinking: low→max
  terra:
    id: gpt-5.6-terra
    pool: O
    tier: 2
    cost_in: 2.5
    cost_out: 15
    speed: 51.8
    ttft: 1.74
    thinking: low→max
  sol:
    id: gpt-5.6-sol
    pool: O
    tier: 3
    cost_in: 5
    cost_out: 30
    speed: 31.5
    ttft: 4.59
    thinking: low→max
  spark:
    id: gpt-5.3-codex-spark
    pool: O
    tier: 0
    cost_in: 1.75
    cost_out: 14
    speed: 286.7
    ttft: 5.56
    thinking: low→xhigh
  haiku:
    id: claude-haiku-4-5
    pool: A
    tier: 1
    cost_in: 1
    cost_out: 5
    speed: 48.9
    ttft: 1.7
    thinking: minimal→xhigh
  sonnet:
    id: claude-sonnet-5
    pool: A
    tier: 2
    cost_in: 2
    cost_out: 10
    speed: 35.2
    ttft: 3.84
    thinking: low→max
  opus:
    id: claude-opus-4-8
    pool: A
    tier: 3
    cost_in: 5
    cost_out: 25
    speed: 46.6
    ttft: 1.77
    thinking: low→max
  fable:
    id: claude-fable-5
    pool: A
    tier: 4
    cost_in: 10
    cost_out: 50
    speed: 54
    ttft: 6.9
    thinking: low→max
`

func fixtureCatalog(t *testing.T) *catalog {
	t.Helper()
	p := filepath.Join(t.TempDir(), "models.yml")
	if err := os.WriteFile(p, []byte(fixtureYML), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := loadCatalog(p)
	if err != nil {
		t.Fatalf("loadCatalog: %v", err)
	}
	return c
}

const goldenAdvisors = `__advisors__  advisor dial (level context → chain)
  glance gpt gpt-5.6-luna:low
  review gpt gpt-5.6-terra:medium → gpt-5.6-luna:low
  audit gpt gpt-5.6-sol:high → gpt-5.6-terra:high → gpt-5.6-luna:low
  glance claude claude-haiku-4-5:low
  review claude claude-sonnet-5:medium → claude-haiku-4-5:low
  audit claude claude-opus-4-8:high → claude-sonnet-5:high → claude-haiku-4-5:low
`

const goldenMixedSmart = `mixed_smart_medium_sp_fa  mixed · smart · medium · spark · fable
  thinking medium · fallback on · advisor on
    default    gpt-5.6-sol:medium       → gpt-5.6-terra:medium → claude-opus-4-8:medium → claude-sonnet-5:medium
  ● task       gpt-5.6-sol:medium       → gpt-5.6-terra:medium → claude-opus-4-8:medium → claude-sonnet-5:medium
    plan       claude-fable-5:high      → claude-opus-4-8:high → gpt-5.6-sol:high → gpt-5.6-terra:high
    slow       claude-fable-5:high      → claude-opus-4-8:high → gpt-5.6-sol:high → gpt-5.6-terra:high
  ● designer   claude-fable-5:high      → claude-opus-4-8:high → gpt-5.6-sol:high → gpt-5.6-terra:high
  ● reviewer   claude-fable-5:high      → claude-opus-4-8:high → gpt-5.6-sol:high → gpt-5.6-terra:high
  ● librarian  gpt-5.6-sol:medium       → gpt-5.6-terra:medium → claude-opus-4-8:medium → claude-sonnet-5:medium
  ● sonic      gpt-5.6-terra:medium     → gpt-5.6-luna:medium
    advisor    claude-sonnet-5:high     → claude-haiku-4-5:low → gpt-5.6-terra:low → gpt-5.6-luna:low
    smol       gpt-5.6-terra:low
    tiny       gpt-5.3-codex-spark:low  → gpt-5.6-terra:low
    commit     gpt-5.3-codex-spark:low  → gpt-5.6-luna:low
`

const goldenClaudeMax = `claude-only_normal_max_nosp_famain  claude-only · normal · max · fable · main
  thinking max · fallback on · advisor on
    default    claude-fable-5:max       → claude-opus-4-8:max → claude-sonnet-5:max
  ● task       claude-sonnet-5:max      → claude-haiku-4-5:xhigh
    plan       claude-fable-5:max       → claude-opus-4-8:max → claude-sonnet-5:max
    slow       claude-fable-5:max       → claude-opus-4-8:max → claude-sonnet-5:max
  ● designer   claude-fable-5:max       → claude-opus-4-8:max → claude-sonnet-5:max
  ● reviewer   claude-fable-5:max       → claude-opus-4-8:max → claude-sonnet-5:max
  ● librarian  claude-sonnet-5:max      → claude-haiku-4-5:xhigh
  ● sonic      claude-sonnet-5:max      → claude-haiku-4-5:xhigh
    advisor    claude-haiku-4-5:xhigh
    smol       claude-sonnet-5:max
    tiny       claude-haiku-4-5:xhigh
    commit     claude-haiku-4-5:xhigh
`

func TestGoldenAdvisors(t *testing.T) {
	c := fixtureCatalog(t)
	if got := c.renderAdvisors(); got != goldenAdvisors {
		t.Errorf("renderAdvisors mismatch:\n--- got ---\n%s--- want ---\n%s", got, goldenAdvisors)
	}
}

func TestGoldenCombos(t *testing.T) {
	c := fixtureCatalog(t)
	if got := c.renderCombo("mixed", "smart", "medium", true, true, false); got != goldenMixedSmart {
		t.Errorf("mixed_smart_medium_sp_fa mismatch:\n--- got ---\n%s--- want ---\n%s", got, goldenMixedSmart)
	}
	if got := c.renderCombo("claude-only", "normal", "max", false, true, true); got != goldenClaudeMax {
		t.Errorf("claude-only_normal_max_nosp_famain mismatch:\n--- got ---\n%s--- want ---\n%s", got, goldenClaudeMax)
	}
}

func TestRenderCatalogStructure(t *testing.T) {
	c := fixtureCatalog(t)
	out := c.renderCatalog()
	// 414 combos on the full fixture — the count the verified reference
	// produced (5 lanes × 3 tiers × 6 thinking × spark/fable/main validity).
	combos := 0
	for _, l := range strings.Split(out, "\n") {
		if l != "" && l[0] != ' ' && strings.Contains(l, "_") && !strings.HasPrefix(l, "__") {
			combos++
		}
	}
	if combos != 414 {
		t.Errorf("combo blocks = %d, want 414", combos)
	}
	for _, want := range []string{"__advisors__", "__models__", "\ngpt-only_fast_minimal_sp_nofa  ", "\nclaude-only_smart_max_nosp_famain  "} {
		if !strings.Contains(out, want) {
			t.Errorf("catalog missing %q", want)
		}
	}
	// The TUI's comboID must find a block for every dial state its facets
	// allow (lane-suppressed spark/fable included).
	facets := facetDefs(defaultGlyphs())
	sel := map[string]string{}
	var walk func(i int)
	misses := 0
	walk = func(i int) {
		if i == len(facets) {
			id := comboID(sel)
			if !strings.Contains(out, "\n"+id+"  ") {
				misses++
				if misses < 5 {
					t.Errorf("no block for dial state %v (id %s)", sel, id)
				}
			}
			return
		}
		for _, v := range facets[i].values {
			sel[facets[i].key] = v
			walk(i + 1)
		}
	}
	walk(0)
}

func TestCatalogWithoutOptionalTiers(t *testing.T) {
	trimmed := ""
	skip := false
	for _, line := range strings.Split(fixtureYML, "\n") {
		if strings.HasPrefix(line, "  spark:") || strings.HasPrefix(line, "  fable:") {
			skip = true
			continue
		}
		if skip && strings.HasPrefix(line, "  ") && !strings.HasPrefix(line, "    ") {
			skip = false
		}
		if !skip {
			trimmed += line + "\n"
		}
	}
	p := filepath.Join(t.TempDir(), "models.yml")
	if err := os.WriteFile(p, []byte(trimmed), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := loadCatalog(p)
	if err != nil {
		t.Fatalf("loadCatalog without tier 0/4: %v", err)
	}
	out := c.renderCatalog()
	if strings.Contains(out, "_sp_") || strings.Contains(out, "_fa\n") || strings.Contains(out, "_famain") {
		t.Error("catalog without spark/elite models must not emit spark/fable combos")
	}
	if !strings.Contains(out, "\nmixed_smart_medium_nosp_nofa  ") {
		t.Error("base combos missing from trimmed catalog")
	}
}

func TestLoadCatalogValidation(t *testing.T) {
	cases := map[string]string{
		"missing ladder": "models:\n  a:\n    id: x\n    pool: A\n    tier: 1\n    thinking: low→max\n",
		"bad pool":       strings.Replace(fixtureYML, "pool: O", "pool: X", 1),
		"dup tier":       strings.Replace(fixtureYML, "tier: 2", "tier: 1", 1),
		"bad thinking":   strings.Replace(fixtureYML, "low→max", "low-max", 1),
	}
	for name, yml := range cases {
		p := filepath.Join(t.TempDir(), name+".yml")
		if err := os.WriteFile(p, []byte(yml), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := loadCatalog(p); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestClampTh(t *testing.T) {
	c := fixtureCatalog(t)
	for _, tc := range [][3]string{
		{"haiku", "minimal", "minimal"}, // haiku's floor really is minimal
		{"luna", "minimal", "low"},      // luna has no minimal
		{"spark", "max", "xhigh"},       // spark tops out at xhigh
		{"opus", "max", "max"},
	} {
		if got := c.clampTh(tc[0], tc[1]); got != tc[2] {
			t.Errorf("clampTh(%s, %s) = %s, want %s", tc[0], tc[1], got, tc[2])
		}
	}
}

func TestTrimFloat(t *testing.T) {
	for f, want := range map[float64]string{1: "1", 2.5: "2.5", 52.3: "52.3", 286.7: "286.7", 0.25: "0.25"} {
		if got := trimFloat(f); got != want {
			t.Errorf("trimFloat(%v) = %q, want %q", f, got, want)
		}
	}
}

const initJSON = `{"models":[
 {"provider":"anthropic","id":"claude-haiku-4-5","contextWindow":200000,"reasoning":true,"thinking":["minimal","low","medium","high","xhigh"],"cost":{"input":1,"output":5}},
 {"provider":"anthropic","id":"claude-sonnet-5","contextWindow":1000000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"cost":{"input":2,"output":10}},
 {"provider":"anthropic","id":"claude-opus-4-8","contextWindow":1000000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"cost":{"input":5,"output":25}},
 {"provider":"anthropic","id":"claude-opus-4-5-20251101","contextWindow":200000,"reasoning":true,"thinking":["low","high"],"cost":{"input":5,"output":25}},
 {"provider":"anthropic","id":"claude-3-sonnet-20240229","contextWindow":200000,"reasoning":false,"thinking":null,"cost":{"input":3,"output":15}},
 {"provider":"openai-codex","id":"gpt-5.6-luna","contextWindow":272000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"cost":{"input":1,"output":6}},
 {"provider":"openai-codex","id":"gpt-5.6-terra","contextWindow":272000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"cost":{"input":2.5,"output":15}},
 {"provider":"openai-codex","id":"gpt-5.6-sol","contextWindow":272000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"cost":{"input":5,"output":30}},
 {"provider":"ollama","id":"qwen2.5:3b","contextWindow":32768,"reasoning":false,"thinking":null,"cost":{"input":0,"output":0}}
]}`

func TestGenerateInitScaffold(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "omp.json")
	out := filepath.Join(dir, "models.yml")
	if err := os.WriteFile(src, []byte(initJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	if code := runGenerateInit([]string{"--from-json", src, "--models-file", out}); code != 0 {
		t.Fatalf("runGenerateInit exit %d", code)
	}
	c, err := loadCatalog(out)
	if err != nil {
		t.Fatalf("scaffold does not load back: %v", err)
	}
	for _, pool := range []string{"O", "A"} {
		for tier := 1; tier <= 3; tier++ {
			if c.ladder[pool][tier] == "" {
				t.Errorf("scaffold left pool %s tier %d empty", pool, tier)
			}
		}
	}
	// Cost-ranked guesses on this fixture: cheapest→1, priciest→3; dated and
	// non-reasoning variants excluded.
	if c.models[c.ladder["A"][1]].ID != "claude-haiku-4-5" || c.models[c.ladder["A"][3]].ID != "claude-opus-4-8" {
		t.Errorf("unexpected A ladder: %v", c.ladder["A"])
	}
	if c.models[c.ladder["O"][3]].ID != "gpt-5.6-sol" {
		t.Errorf("unexpected O ladder: %v", c.ladder["O"])
	}
	// A scaffolded catalog must render end-to-end.
	if !strings.Contains(c.renderCatalog(), "\nmixed_smart_medium_nosp_nofa  ") {
		t.Error("scaffolded catalog fails to render")
	}
	// Refuses to clobber an existing file.
	if code := runGenerateInit([]string{"--from-json", src, "--models-file", out}); code == 0 {
		t.Error("init must refuse to overwrite an existing models file")
	}
}
