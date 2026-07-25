package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixtureYML mirrors the shape of a real catalog: both pools filled, the
// optional spark/elite tiers present, an explicit quota bucket per model, and a
// text-only model (the codex spark variants really are text-only) so the vision
// role has something to route around.
const fixtureYML = `models:
  luna:
    id: gpt-5.6-luna
    pool: O
    tier: 1
    bucket: codex-main
    cost_in: 1
    cost_out: 6
    speed: 52.3
    ttft: 1.18
    context: 272000
    thinking: low→max
  terra:
    id: gpt-5.6-terra
    pool: O
    tier: 2
    bucket: codex-main
    cost_in: 2.5
    cost_out: 15
    speed: 51.8
    ttft: 1.74
    context: 272000
    thinking: low→max
  sol:
    id: gpt-5.6-sol
    pool: O
    tier: 3
    bucket: codex-main
    cost_in: 5
    cost_out: 30
    speed: 31.5
    ttft: 4.59
    context: 272000
    thinking: low→max
  spark:
    id: gpt-5.3-codex-spark
    pool: O
    tier: 0
    bucket: codex-spark
    cost_in: 1.75
    cost_out: 14
    speed: 286.7
    ttft: 5.56
    context: 128000
    thinking: low→xhigh
    image: false
  haiku:
    id: claude-haiku-4-5
    pool: A
    tier: 1
    bucket: claude-main
    cost_in: 1
    cost_out: 5
    speed: 48.9
    ttft: 1.7
    context: 200000
    thinking: minimal→xhigh
  sonnet:
    id: claude-sonnet-5
    pool: A
    tier: 2
    bucket: claude-main
    cost_in: 2
    cost_out: 10
    speed: 35.2
    ttft: 3.84
    context: 1000000
    thinking: low→max
  opus:
    id: claude-opus-5
    pool: A
    tier: 3
    bucket: claude-main
    cost_in: 5
    cost_out: 25
    speed: 46.6
    ttft: 1.77
    context: 1000000
    thinking: low→max
  fable:
    id: claude-fable-5
    pool: A
    tier: 4
    bucket: claude-fable
    cost_in: 10
    cost_out: 50
    speed: 54
    ttft: 6.9
    context: 1000000
    thinking: low→max
`

func catalogFrom(t *testing.T, yml string) (*catalog, error) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "models.yml")
	if err := os.WriteFile(p, []byte(yml), 0o644); err != nil {
		t.Fatal(err)
	}
	return loadCatalog(p)
}

func fixtureCatalog(t *testing.T) *catalog {
	t.Helper()
	c, err := catalogFrom(t, fixtureYML)
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
  audit claude claude-opus-5:high → claude-sonnet-5:high → claude-haiku-4-5:low
`

// goldenFacts pins the trailing bucket column the TUI's quota meter reads.
const goldenFacts = `__models__  model facts (id in out speed ttft bucket — $/1M in·out, tok/s, s)
  gpt-5.6-luna 1 6 52.3 1.18 codex-main
  gpt-5.6-terra 2.5 15 51.8 1.74 codex-main
  gpt-5.6-sol 5 30 31.5 4.59 codex-main
  gpt-5.3-codex-spark 1.75 14 286.7 5.56 codex-spark
  claude-haiku-4-5 1 5 48.9 1.7 claude-main
  claude-sonnet-5 2 10 35.2 3.84 claude-main
  claude-opus-5 5 25 46.6 1.77 claude-main
  claude-fable-5 10 50 54 6.9 claude-fable
`

const goldenMixedSmart = `mixed_smart_medium_sp_fa  mixed · smart · medium · spark · fable
  thinking medium · fallback on · advisor on
    default    gpt-5.6-sol:medium       → gpt-5.6-terra:medium → claude-opus-5:medium → claude-sonnet-5:medium
  ● task       gpt-5.6-sol:medium       → gpt-5.6-terra:medium → claude-opus-5:medium → claude-sonnet-5:medium
    plan       claude-fable-5:high      → claude-opus-5:high → gpt-5.6-sol:high → gpt-5.6-terra:high
    slow       claude-fable-5:high      → claude-opus-5:high → gpt-5.6-sol:high → gpt-5.6-terra:high
  ● designer   claude-fable-5:high      → claude-opus-5:high → gpt-5.6-sol:high → gpt-5.6-terra:high
  ● reviewer   claude-fable-5:high      → claude-opus-5:high → gpt-5.6-sol:high → gpt-5.6-terra:high
  ● librarian  gpt-5.6-sol:medium       → gpt-5.6-terra:medium → claude-opus-5:medium → claude-sonnet-5:medium
  ● scout      gpt-5.6-terra:medium     → gpt-5.6-luna:medium
  ● sonic      gpt-5.6-terra:medium     → gpt-5.6-luna:medium
    advisor    claude-sonnet-5:high     → claude-haiku-4-5:low → gpt-5.6-terra:low → gpt-5.6-luna:low
    vision     gpt-5.6-luna:low         → claude-haiku-4-5:low
    smol       gpt-5.6-terra:low
    tiny       gpt-5.3-codex-spark:low  → gpt-5.6-terra:low
    commit     gpt-5.3-codex-spark:low  → gpt-5.6-luna:low
`

const goldenClaudeMax = `claude-only_normal_max_nosp_famain  claude-only · normal · max · fable · main
  thinking max · fallback on · advisor on
    default    claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
  ● task       claude-sonnet-5:max      → claude-haiku-4-5:xhigh
    plan       claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
    slow       claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
  ● designer   claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
  ● reviewer   claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
  ● librarian  claude-sonnet-5:max      → claude-haiku-4-5:xhigh
  ● scout      claude-sonnet-5:max      → claude-haiku-4-5:xhigh
  ● sonic      claude-sonnet-5:max      → claude-haiku-4-5:xhigh
    advisor    claude-haiku-4-5:xhigh
    vision     claude-haiku-4-5:xhigh
    smol       claude-sonnet-5:max
    tiny       claude-haiku-4-5:xhigh
    commit     claude-haiku-4-5:xhigh
`

// goldenClaudeSmart is the one combo where the Anthropic smart rung is itself
// the padded lead column, so a change to that model's id shifts the padding
// rather than just swapping a chain token. Every other golden here has a pool-O
// model or the elite in the lead.
const goldenClaudeSmart = `claude-only_smart_medium_nosp_nofa  claude-only · smart · medium
  thinking medium · fallback on · advisor on
    default    claude-opus-5:medium     → claude-sonnet-5:medium → claude-haiku-4-5:medium
  ● task       claude-opus-5:medium     → claude-sonnet-5:medium → claude-haiku-4-5:medium
    plan       claude-opus-5:high       → claude-sonnet-5:high → claude-haiku-4-5:high
    slow       claude-opus-5:high       → claude-sonnet-5:high → claude-haiku-4-5:high
  ● designer   claude-opus-5:high       → claude-sonnet-5:high → claude-haiku-4-5:high
  ● reviewer   claude-opus-5:high       → claude-sonnet-5:high → claude-haiku-4-5:high
  ● librarian  claude-opus-5:medium     → claude-sonnet-5:medium → claude-haiku-4-5:medium
  ● scout      claude-sonnet-5:medium   → claude-haiku-4-5:medium
  ● sonic      claude-sonnet-5:medium   → claude-haiku-4-5:medium
    advisor    claude-sonnet-5:high     → claude-haiku-4-5:low
    vision     claude-haiku-4-5:low
    smol       claude-sonnet-5:low
    tiny       claude-sonnet-5:low
    commit     claude-haiku-4-5:minimal
`

func TestGoldenAdvisors(t *testing.T) {
	c := fixtureCatalog(t)
	if got := c.renderAdvisors(); got != goldenAdvisors {
		t.Errorf("advisors mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, goldenAdvisors)
	}
}

func TestGoldenModelFacts(t *testing.T) {
	c := fixtureCatalog(t)
	if got := c.renderModelFacts(); got != goldenFacts {
		t.Errorf("model facts mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, goldenFacts)
	}
}

// A catalog that declares no buckets keeps the old five-column rows, so the
// consumer's fallback path stays exercised.
func TestModelFactsWithoutBuckets(t *testing.T) {
	c, err := catalogFrom(t, strings.ReplaceAll(fixtureYML, "    bucket: codex-main\n", ""))
	if err != nil {
		t.Fatalf("loadCatalog: %v", err)
	}
	if !strings.Contains(c.renderModelFacts(), "  gpt-5.6-luna 1 6 52.3 1.18\n") {
		t.Errorf("bucketless model row should stop after ttft:\n%s", c.renderModelFacts())
	}
}

func TestGoldenCombos(t *testing.T) {
	c := fixtureCatalog(t)
	for _, tc := range []struct {
		name, want string
		render     func() string
	}{
		{"mixed_smart_medium_sp_fa", goldenMixedSmart, func() string {
			return c.renderCombo("mixed", "smart", "medium", true, true, false)
		}},
		{"claude-only_normal_max_nosp_famain", goldenClaudeMax, func() string {
			return c.renderCombo("claude-only", "normal", "max", false, true, true)
		}},
		{"claude-only_smart_medium_nosp_nofa", goldenClaudeSmart, func() string {
			return c.renderCombo("claude-only", "smart", "medium", false, false, false)
		}},
	} {
		if got := tc.render(); got != tc.want {
			t.Errorf("%s mismatch:\n--- got ---\n%s\n--- want ---\n%s", tc.name, got, tc.want)
		}
	}
}

func TestRenderCatalogStructure(t *testing.T) {
	c := fixtureCatalog(t)
	out := c.renderCatalog()
	// 414 combos on the full fixture: 5 lanes × 3 tiers × 6 thinking levels,
	// times the spark/fable/main combinations genValid admits.
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

// Every role the generator emits must be weighted, or weightedModels drops it
// from both meters without a trace.
func TestEveryEmittedRoleIsWeighted(t *testing.T) {
	for _, r := range genRoleOrder {
		if _, ok := roleWeight[r]; !ok {
			t.Errorf("role %q is emitted but has no roleWeight entry", r)
		}
	}
}

// scout is one of omp's six bundled agents; it must carry the agent marker so
// genConfigYAML mirrors it into task.agentModelOverrides.
func TestScoutIsAgentBacked(t *testing.T) {
	c := fixtureCatalog(t)
	block := c.renderCombo("mixed", "normal", "medium", false, false, false)
	if !strings.Contains(block, "● scout ") {
		t.Errorf("scout must render as an agent-backed role:\n%s", block)
	}
}

// The vision role feeds omp's image-describe fallback, so it must never lead on
// a text-only model even when that model is the cheapest rung available.
func TestVisionSkipsTextOnlyModels(t *testing.T) {
	// Promote the text-only spark to tier 1 and demote luna out of the way.
	yml := strings.Replace(fixtureYML, "    id: gpt-5.6-luna\n    pool: O\n    tier: 1", "    id: gpt-5.6-luna\n    pool: O\n    tier: 0", 1)
	yml = strings.Replace(yml, "    id: gpt-5.3-codex-spark\n    pool: O\n    tier: 0", "    id: gpt-5.3-codex-spark\n    pool: O\n    tier: 1", 1)
	c, err := catalogFrom(t, yml)
	if err != nil {
		t.Fatalf("loadCatalog: %v", err)
	}
	if lead := c.visionLead("O"); lead == "" || c.models[lead].ID != "gpt-5.6-terra" {
		t.Errorf("visionLead(O) = %q, want the cheapest image-capable rung (terra)", lead)
	}
	block := c.renderCombo("gpt-only", "fast", "medium", false, false, false)
	for _, l := range strings.Split(block, "\n") {
		if strings.Contains(l, " vision ") && strings.Contains(l, "codex-spark") {
			t.Errorf("vision must not route to a text-only model: %s", l)
		}
	}
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
	c, err := catalogFrom(t, trimmed)
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
		"unknown level":  strings.Replace(fixtureYML, "thinking: low→max", "thinking: low,medium,enormous", 1),
	}
	for name, yml := range cases {
		if _, err := catalogFrom(t, yml); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

// A dearer rung offering less context or less thinking headroom is the exact
// shape a price-ranked scaffold used to produce, so the catalog refuses it.
func TestLadderRegressionRejected(t *testing.T) {
	cases := map[string]string{
		"smaller context at a higher price": strings.Replace(fixtureYML,
			"    id: claude-opus-5\n    pool: A\n    tier: 3\n    bucket: claude-main\n    cost_in: 5\n    cost_out: 25\n    speed: 46.6\n    ttft: 1.77\n    context: 1000000\n    thinking: low→max\n",
			"    id: claude-opus-4-1\n    pool: A\n    tier: 3\n    bucket: claude-main\n    cost_in: 15\n    cost_out: 75\n    speed: 46.6\n    ttft: 1.77\n    context: 200000\n    thinking: minimal→xhigh\n", 1),
		"lower thinking ceiling at a higher price": strings.Replace(fixtureYML,
			"    id: claude-opus-5\n    pool: A\n    tier: 3\n    bucket: claude-main\n    cost_in: 5\n    cost_out: 25\n    speed: 46.6\n    ttft: 1.77\n    context: 1000000\n    thinking: low→max\n",
			"    id: claude-opus-4-1\n    pool: A\n    tier: 3\n    bucket: claude-main\n    cost_in: 15\n    cost_out: 75\n    speed: 46.6\n    ttft: 1.77\n    context: 1000000\n    thinking: low→xhigh\n", 1),
	}
	for name, yml := range cases {
		_, err := catalogFrom(t, yml)
		if err == nil {
			t.Errorf("%s: expected the ladder check to reject this catalog", name)
			continue
		}
		if !strings.Contains(err.Error(), "regression") {
			t.Errorf("%s: error should name the regression, got %v", name, err)
		}
	}
	// The healthy fixture must not trip it: tier 3 costs more than tier 2 while
	// matching it on context and thinking, which is the ladder working.
	if _, err := catalogFrom(t, fixtureYML); err != nil {
		t.Errorf("healthy ladder rejected: %v", err)
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

// A hole in the middle of a model's scale must not be smoothed over: asking for
// the missing level rounds down to one the model really offers. claude-opus-4-6
// is the live example — low, medium, high, max, but no xhigh.
func TestClampThHonoursGaps(t *testing.T) {
	c, err := catalogFrom(t, strings.Replace(fixtureYML,
		"    id: claude-opus-5\n    pool: A\n    tier: 3\n    bucket: claude-main\n    cost_in: 5\n    cost_out: 25\n    speed: 46.6\n    ttft: 1.77\n    context: 1000000\n    thinking: low→max\n",
		"    id: claude-opus-4-6\n    pool: A\n    tier: 3\n    bucket: claude-main\n    cost_in: 5\n    cost_out: 25\n    speed: 46.6\n    ttft: 1.77\n    context: 1000000\n    thinking: low,medium,high,max\n", 1))
	if err != nil {
		t.Fatalf("comma-list thinking should load: %v", err)
	}
	for _, tc := range [][2]string{{"xhigh", "high"}, {"max", "max"}, {"minimal", "low"}, {"medium", "medium"}} {
		if got := c.clampTh("opus", tc[0]); got != tc[1] {
			t.Errorf("clampTh(opus, %s) = %s, want %s", tc[0], got, tc[1])
		}
	}
	if strings.Contains(c.renderCatalog(), "claude-opus-4-6:xhigh") {
		t.Error("generator emitted a thinking level the model does not offer")
	}
}

func TestThinkingField(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"low medium high xhigh max", "low→max"},
		{"low medium high max", "low,medium,high,max"},
		{"minimal", "minimal→minimal"},
	} {
		if got := thinkingField(strings.Fields(tc.in)); got != tc.want {
			t.Errorf("thinkingField(%q) = %q, want %q", tc.in, got, tc.want)
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

func TestFamilyAndSupersede(t *testing.T) {
	for _, tc := range []struct {
		id, fam string
		ver     []int
	}{
		{"claude-opus-4-8", "claude-opus", []int{4, 8}},
		{"claude-opus-5", "claude-opus", []int{5}},
		{"gpt-5.6-terra", "gpt-terra", []int{5, 6}},
		{"gpt-5.4-mini", "gpt-mini", []int{5, 4}},
		{"gpt-5.5", "gpt", []int{5, 5}},
	} {
		fam, ver := familyOf(tc.id)
		if fam != tc.fam || fmt.Sprint(ver) != fmt.Sprint(tc.ver) {
			t.Errorf("familyOf(%s) = %q %v, want %q %v", tc.id, fam, ver, tc.fam, tc.ver)
		}
	}
	// Version components compare numerically, not as a decimal: 5.10 is newer
	// than 5.9 even though 5.1 < 5.9.
	if _, a := familyOf("gpt-5.10"); func() bool { _, b := familyOf("gpt-5.9"); return !newer(a, b) }() {
		t.Error("gpt-5.10 must supersede gpt-5.9")
	}
	mk := func(id string, cost float64) ompModel {
		m := ompModel{ID: id, Provider: "anthropic", Reasoning: true, Thinking: []string{"low", "max"}}
		m.Cost.Input = cost
		return m
	}
	// The whole point: the $15 fossil never reaches the ladder.
	got := supersede([]ompModel{mk("claude-opus-4-1", 15), mk("claude-opus-5", 5), mk("claude-opus-4-8", 5), mk("claude-haiku-4-5", 1)})
	var ids []string
	for _, m := range got {
		ids = append(ids, m.ID)
	}
	want := "claude-haiku-4-5 claude-opus-5"
	if strings.Join(ids, " ") != want {
		t.Errorf("supersede = %v, want %q", ids, want)
	}
}

func TestShortKeyDisambiguation(t *testing.T) {
	for _, tc := range [][2]string{
		{"claude-opus-5", "opus"},
		{"claude-opus-4-8", "opus"},
		{"gpt-5.6-sol", "sol"},
		{"gpt-5.3-codex-spark", "spark"},
	} {
		if got := shortKey(tc[0]); got != tc[1] {
			t.Errorf("shortKey(%s) = %s, want %s", tc[0], got, tc[1])
		}
	}
	// Same-family ids collide on the short key; the version breaks the tie in a
	// way a reader can actually interpret.
	for _, tc := range [][2]string{{"claude-opus-5", "5"}, {"claude-opus-4-8", "48"}, {"gpt-5.6-terra", "56"}} {
		if got := versionSuffix(tc[0]); got != tc[1] {
			t.Errorf("versionSuffix(%s) = %s, want %s", tc[0], got, tc[1])
		}
	}
}

// initJSON models the real catalog's awkward shape: four same-priced Opus
// variants, a legacy Opus that never got delisted and still lists at 3x the
// price, two identically priced elites, a text-only spark, dated snapshots, a
// non-reasoning model, and a free local model.
const initJSON = `{"models":[
 {"provider":"anthropic","id":"claude-haiku-4-5","contextWindow":200000,"reasoning":true,"thinking":["minimal","low","medium","high","xhigh"],"input":["text","image"],"cost":{"input":1,"output":5}},
 {"provider":"anthropic","id":"claude-sonnet-4-5","contextWindow":1000000,"reasoning":true,"thinking":["minimal","low","medium","high","xhigh"],"input":["text","image"],"cost":{"input":3,"output":15}},
 {"provider":"anthropic","id":"claude-sonnet-5","contextWindow":1000000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":2,"output":10}},
 {"provider":"anthropic","id":"claude-opus-4-5","contextWindow":200000,"reasoning":true,"thinking":["minimal","low","medium","high","xhigh"],"input":["text","image"],"cost":{"input":5,"output":25}},
 {"provider":"anthropic","id":"claude-opus-4-6","contextWindow":1000000,"reasoning":true,"thinking":["low","medium","high","max"],"input":["text","image"],"cost":{"input":5,"output":25}},
 {"provider":"anthropic","id":"claude-opus-4-8","contextWindow":1000000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":5,"output":25}},
 {"provider":"anthropic","id":"claude-opus-5","contextWindow":1000000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":5,"output":25}},
 {"provider":"anthropic","id":"claude-opus-4-1","contextWindow":200000,"reasoning":true,"thinking":["minimal","low","medium","high","xhigh"],"input":["text","image"],"cost":{"input":15,"output":75}},
 {"provider":"anthropic","id":"claude-fable-5","contextWindow":1000000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":10,"output":50}},
 {"provider":"anthropic","id":"claude-mythos-5","contextWindow":1000000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":10,"output":50}},
 {"provider":"anthropic","id":"claude-opus-4-5-20251101","contextWindow":200000,"reasoning":true,"thinking":["low","high"],"input":["text","image"],"cost":{"input":5,"output":25}},
 {"provider":"anthropic","id":"claude-3-sonnet-20240229","contextWindow":200000,"reasoning":false,"thinking":null,"input":["text","image"],"cost":{"input":3,"output":15}},
 {"provider":"openai-codex","id":"gpt-5.4-mini","contextWindow":272000,"reasoning":true,"thinking":["low","medium","high","xhigh"],"input":["text","image"],"cost":{"input":0.75,"output":4.5}},
 {"provider":"openai-codex","id":"gpt-5.6-luna","contextWindow":272000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":1,"output":6}},
 {"provider":"openai-codex","id":"gpt-5.3-codex-spark","contextWindow":128000,"reasoning":true,"thinking":["low","medium","high","xhigh"],"input":["text"],"cost":{"input":1.75,"output":14}},
 {"provider":"openai-codex","id":"gpt-5.6-terra","contextWindow":272000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":2.5,"output":15}},
 {"provider":"openai-codex","id":"gpt-5.4","contextWindow":1000000,"reasoning":true,"thinking":["low","medium","high","xhigh"],"input":["text","image"],"cost":{"input":2.5,"output":15}},
 {"provider":"openai-codex","id":"gpt-5.5","contextWindow":272000,"reasoning":true,"thinking":["low","medium","high","xhigh"],"input":["text","image"],"cost":{"input":5,"output":30}},
 {"provider":"openai-codex","id":"gpt-5.6-sol","contextWindow":272000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":5,"output":30}},
 {"provider":"ollama","id":"qwen2.5:3b","contextWindow":32768,"reasoning":false,"thinking":null,"input":["text"],"cost":{"input":0,"output":0}}
]}`

// initUsage is the shape omp reports: a spark bucket that names its model, and
// an elite bucket that only names its tier.
const initUsage = `{"reports":[
 {"provider":"openai-codex","limits":[
   {"id":"openai-codex:primary","scope":{"provider":"openai-codex"}},
   {"id":"openai-codex:spark:primary","scope":{"provider":"openai-codex","tier":"spark","modelId":"GPT-5.3-Codex-Spark"}}]},
 {"provider":"anthropic","limits":[
   {"id":"anthropic:7d","scope":{"provider":"anthropic"}},
   {"id":"anthropic:7d:fable","scope":{"provider":"anthropic","tier":"fable"}}]}
]}`

// stubOmp points the scaffolder's omp probes at fixtures for the duration of a
// test. usage may be "" to simulate a machine where the probe fails.
func stubOmp(t *testing.T, usage string) {
	t.Helper()
	prev := ompUsageJSON
	ompUsageJSON = func() ([]byte, error) {
		if usage == "" {
			return nil, fmt.Errorf("no usage")
		}
		return []byte(usage), nil
	}
	t.Cleanup(func() { ompUsageJSON = prev })
}

func scaffoldTo(t *testing.T, args ...string) (*catalog, string) {
	t.Helper()
	dir := t.TempDir()
	src := filepath.Join(dir, "omp.json")
	out := filepath.Join(dir, "models.yml")
	if err := os.WriteFile(src, []byte(initJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	if code := runGenerateInit(append([]string{"--from-json", src, "--models-file", out}, args...)); code != 0 {
		t.Fatalf("runGenerateInit exit %d", code)
	}
	c, err := loadCatalog(out)
	if err != nil {
		body, _ := os.ReadFile(out)
		t.Fatalf("scaffold does not load back: %v\n%s", err, body)
	}
	return c, out
}

func TestGenerateInitScaffold(t *testing.T) {
	stubOmp(t, initUsage)
	c, out := scaffoldTo(t)

	// The headline property: the newest model in each family wins its rung, so
	// the undelisted $15 claude-opus-4-1 never outranks the $5 claude-opus-5.
	want := map[string][5]string{
		"O": {"gpt-5.3-codex-spark", "gpt-5.4-mini", "gpt-5.6-terra", "gpt-5.6-sol", ""},
		"A": {"", "claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5", "claude-fable-5"},
	}
	for pool, ids := range want {
		for tier, id := range ids {
			key := c.ladder[pool][tier]
			got := ""
			if key != "" {
				got = c.models[key].ID
			}
			if got != id {
				t.Errorf("pool %s tier %d = %q, want %q", pool, tier, got, id)
			}
		}
	}
	// Two models collapse to the short key "opus" only if a superseded sibling
	// survives; none should, so the key stays clean.
	if _, ok := c.models["opus"]; !ok {
		t.Errorf("expected a clean 'opus' key, got %v", c.keys)
	}

	body, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	text := string(body)
	// The text-only spark must be marked so the vision role avoids it.
	if !strings.Contains(text, "image: false") {
		t.Error("scaffold should mark the text-only codex spark")
	}
	if !strings.Contains(text, "bucket: codex-spark") || !strings.Contains(text, "bucket: claude-fable") {
		t.Errorf("scaffold should carry the tier-scoped buckets omp reported:\n%s", text)
	}
	// A scaffolded catalog must render end-to-end, spark and fable included.
	rendered := c.renderCatalog()
	for _, want := range []string{"\nmixed_smart_medium_nosp_nofa  ", "\nmixed_smart_medium_sp_fa  "} {
		if !strings.Contains(rendered, want) {
			t.Errorf("scaffolded catalog missing %q", want)
		}
	}
}

// Without a usage probe the special tiers are simply absent — the scaffold must
// still be a valid, loadable ladder rather than a hard failure.
func TestGenerateInitWithoutUsageProbe(t *testing.T) {
	stubOmp(t, "")
	c, _ := scaffoldTo(t)
	if c.ladder["O"][0] != "" || c.ladder["A"][4] != "" {
		t.Errorf("no usage report should mean no special tiers, got %v / %v", c.ladder["O"], c.ladder["A"])
	}
	for _, pool := range []string{"O", "A"} {
		for tier := 1; tier <= 3; tier++ {
			if c.ladder[pool][tier] == "" {
				t.Errorf("pool %s tier %d left empty", pool, tier)
			}
		}
	}
}

// --bench doubles as a reachability probe: omp lists claude-mythos-5 at
// claude-fable-5's exact price, but it 404s on accounts that do not have it,
// and no metadata distinguishes the two.
func TestGenerateInitBenchDropsUnreachableModels(t *testing.T) {
	stubOmp(t, "")
	prev := ompBenchJSON
	ompBenchJSON = func(sels []string) ([]byte, error) {
		var rows []string
		for _, s := range sels {
			id := s[strings.LastIndexByte(s, '/')+1:]
			if id == "claude-mythos-5" {
				rows = append(rows, fmt.Sprintf(`{"model":%q,"average":null}`, s))
				continue
			}
			rows = append(rows, fmt.Sprintf(`{"model":%q,"average":{"ttftMs":1404.2,"tokensPerSecond":48.94}}`, s))
		}
		return []byte(`{"models":[` + strings.Join(rows, ",") + `]}`), nil
	}
	t.Cleanup(func() { ompBenchJSON = prev })

	c, out := scaffoldTo(t, "--bench")
	for _, k := range c.keys {
		if c.models[k].ID == "claude-mythos-5" {
			t.Error("a model whose bench probe failed must not reach the ladder")
		}
	}
	body, _ := os.ReadFile(out)
	if strings.Contains(string(body), "placeholder") {
		t.Error("--bench should replace the placeholder speed/ttft, not annotate them")
	}
	if !strings.Contains(string(body), "speed: 48.9") || !strings.Contains(string(body), "ttft: 1.4") {
		t.Errorf("measured figures missing from scaffold:\n%s", body)
	}
}

func TestGenerateInitRefresh(t *testing.T) {
	stubOmp(t, initUsage)
	dir := t.TempDir()
	src := filepath.Join(dir, "omp.json")
	out := filepath.Join(dir, "models.yml")
	if err := os.WriteFile(src, []byte(initJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	base := []string{"--from-json", src, "--models-file", out}
	if code := runGenerateInit(base); code != 0 {
		t.Fatalf("first init exit %d", code)
	}
	// Without --refresh an existing file is left alone, so a stale catalog can
	// never be clobbered by accident.
	if code := runGenerateInit(base); code == 0 {
		t.Error("init must refuse to overwrite an existing models file")
	}
	if err := os.WriteFile(out, []byte("models: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code := runGenerateInit(append(base, "--refresh")); code != 0 {
		t.Fatalf("refresh exit %d", code)
	}
	c, err := loadCatalog(out)
	if err != nil {
		t.Fatalf("refreshed scaffold does not load: %v", err)
	}
	if c.models[c.ladder["A"][3]].ID != "claude-opus-5" {
		t.Error("--refresh should re-derive the tiers from the current model list")
	}
}
