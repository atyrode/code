package main

import (
	"encoding/json"
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
const fixtureYML = `probed: true
models:
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
const goldenFacts = `__models__  model facts (id in out speed ttft bucket provider — $/1M in·out, tok/s, s)
  gpt-5.6-luna 1 6 52.3 1.18 codex-main openai-codex
  gpt-5.6-terra 2.5 15 51.8 1.74 codex-main openai-codex
  gpt-5.6-sol 5 30 31.5 4.59 codex-main openai-codex
  gpt-5.3-codex-spark 1.75 14 286.7 5.56 codex-spark openai-codex
  claude-haiku-4-5 1 5 48.9 1.7 claude-main anthropic
  claude-sonnet-5 2 10 35.2 3.84 claude-main anthropic
  claude-opus-5 5 25 46.6 1.77 claude-main anthropic
  claude-fable-5 10 50 54 6.9 claude-fable anthropic
`

const goldenMixedSmart = `mixed_smart_medium_sp_fa  mixed · smart · medium · spark · fable
  thinking medium · fallback on · advisor on
    default    gpt-5.6-sol:medium       → gpt-5.6-terra:medium → claude-opus-5:medium → claude-sonnet-5:medium
  ● task       gpt-5.6-sol:medium       → gpt-5.6-terra:medium → claude-opus-5:medium → claude-sonnet-5:medium
    plan       claude-fable-5:high      → claude-opus-5:high → gpt-5.6-sol:high → gpt-5.6-terra:high
    slow       claude-fable-5:high      → claude-opus-5:high → gpt-5.6-sol:high → gpt-5.6-terra:high
  ● designer   claude-fable-5:high      → claude-opus-5:high → gpt-5.6-sol:high → gpt-5.6-terra:high
  ● reviewer   claude-fable-5:high      → claude-opus-5:high → gpt-5.6-sol:high → gpt-5.6-terra:high
  ● security-reviewer claude-fable-5:high      → claude-opus-5:high → gpt-5.6-sol:high → gpt-5.6-terra:high
  ● librarian  gpt-5.6-sol:medium       → gpt-5.6-terra:medium → claude-opus-5:medium → claude-sonnet-5:medium
  ● scout      gpt-5.6-terra:medium     → gpt-5.6-luna:medium
  ● sonic      gpt-5.6-terra:medium     → gpt-5.6-luna:medium
    advisor    claude-sonnet-5:high     → claude-haiku-4-5:low → gpt-5.6-terra:low → gpt-5.6-luna:low
    vision     claude-opus-5:low        → claude-sonnet-5:low → gpt-5.6-sol:low → gpt-5.6-terra:low
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
  ● security-reviewer claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
  ● librarian  claude-sonnet-5:max      → claude-haiku-4-5:xhigh
  ● scout      claude-sonnet-5:max      → claude-haiku-4-5:xhigh
  ● sonic      claude-sonnet-5:max      → claude-haiku-4-5:xhigh
    advisor    claude-haiku-4-5:xhigh
    vision     claude-sonnet-5:max      → claude-haiku-4-5:xhigh
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
  ● security-reviewer claude-opus-5:high       → claude-sonnet-5:high → claude-haiku-4-5:high
  ● librarian  claude-opus-5:medium     → claude-sonnet-5:medium → claude-haiku-4-5:medium
  ● scout      claude-sonnet-5:medium   → claude-haiku-4-5:medium
  ● sonic      claude-sonnet-5:medium   → claude-haiku-4-5:medium
    advisor    claude-sonnet-5:high     → claude-haiku-4-5:low
    vision     claude-opus-5:low        → claude-sonnet-5:low → claude-haiku-4-5:low
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

// A catalog that declares no bucket for a model still renders all seven
// columns: the pool's main window is the derived bucket, so the TUI never has
// to guess from the model family for a freshly generated catalog.
func TestModelFactsWithoutBuckets(t *testing.T) {
	c, err := catalogFrom(t, strings.ReplaceAll(fixtureYML, "    bucket: codex-main\n", ""))
	if err != nil {
		t.Fatalf("loadCatalog: %v", err)
	}
	if !strings.Contains(c.renderModelFacts(), "  gpt-5.6-luna 1 6 52.3 1.18 codex-main openai-codex\n") {
		t.Errorf("bucketless model row should derive the pool's main bucket:\n%s", c.renderModelFacts())
	}
}

func TestGoldenCombos(t *testing.T) {
	c := fixtureCatalog(t)
	for _, tc := range []struct {
		name, want string
		render     func() string
	}{
		{"mixed_smart_medium_sp_fa", goldenMixedSmart, func() string {
			return c.renderCombo("mixed", "smart", "medium", true, true, false, true, false)
		}},
		{"claude-only_normal_max_nosp_famain", goldenClaudeMax, func() string {
			return c.renderCombo("claude-only", "normal", "max", false, true, true, true, false)
		}},
		{"claude-only_smart_medium_nosp_nofa", goldenClaudeSmart, func() string {
			return c.renderCombo("claude-only", "smart", "medium", false, false, false, true, false)
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
	// allow — after applyCatalog trims the lane dial to the lanes this
	// catalog serves (an ox-less catalog never offers ox lanes).
	servedLanes := map[string]bool{}
	for _, l := range strings.Split(out, "\n") {
		if l != "" && l[0] != ' ' && !strings.HasPrefix(l, "__") {
			if i := strings.IndexByte(l, '_'); i >= 0 {
				servedLanes[l[:i]] = true
			}
		}
	}
	facets := facetDefs(defaultGlyphs())
	sel := map[string]string{}
	var walk func(i int)
	misses := 0
	walk = func(i int) {
		if i == len(facets) {
			id := comboID(sel, false)
			if !strings.Contains(out, "\n"+id+"  ") {
				misses++
				if misses < 5 {
					t.Errorf("no block for dial state %v (id %s)", sel, id)
				}
			}
			return
		}
		for _, v := range facets[i].values {
			if facets[i].key == "lane" && !servedLanes[v] {
				continue
			}
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

// scout is an agent-backed role; it must carry the agent marker so
// genConfigYAML mirrors it into task.agentModelOverrides.
func TestScoutIsAgentBacked(t *testing.T) {
	c := fixtureCatalog(t)
	block := c.renderCombo("mixed", "normal", "medium", false, false, false, true, false)
	if !strings.Contains(block, "● scout ") {
		t.Errorf("scout must render as an agent-backed role:\n%s", block)
	}
}

// The header legend tells the reader which roles the ● marker can appear on.
// It used to be a hand-typed list beside genAgentRoles, so adding scout marked
// a row the header denied existed. Derive-or-drift: the legend must name
// exactly the roles the grid actually marks.
func TestAgentLegendMatchesMarkedRoles(t *testing.T) {
	c := fixtureCatalog(t)
	out := c.renderCatalog()
	var legend string
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(l, "agent-backed roles: ") {
			legend = strings.TrimPrefix(l, "agent-backed roles: ")
			break
		}
	}
	if legend == "" {
		t.Fatal("catalog header must carry an agent-backed-roles legend")
	}
	named := map[string]bool{}
	for _, f := range strings.Fields(legend) {
		if f == "—" {
			break
		}
		named[f] = true
	}
	marked := map[string]bool{}
	for _, l := range strings.Split(out, "\n") {
		if f := strings.Fields(l); len(f) > 1 && f[0] == "●" {
			marked[f[1]] = true
		}
	}
	if len(marked) == 0 {
		t.Fatal("no ● rows rendered - the marker or the fixture regressed")
	}
	for r := range marked {
		if !named[r] {
			t.Errorf("role %q renders with ● but the legend omits it", r)
		}
	}
	for r := range named {
		if !marked[r] {
			t.Errorf("legend names %q but no row carries the marker", r)
		}
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
	if lead := c.visionLead("O", 1); lead == "" || c.models[lead].ID != "gpt-5.6-terra" {
		t.Errorf("visionLead(O, 1) = %q, want the next image-capable rung (terra)", lead)
	}
	block := c.renderCombo("gpt-only", "fast", "medium", false, false, false, true, false)
	for _, l := range strings.Split(block, "\n") {
		if strings.Contains(l, " vision ") && strings.Contains(l, "codex-spark") {
			t.Errorf("vision must not route to a text-only model: %s", l)
		}
	}
}

func TestVisionFollowsModelTier(t *testing.T) {
	c := fixtureCatalog(t)
	for _, tc := range []struct {
		lane, tier, want string
	}{
		{"gpt-only", "fast", "gpt-5.6-luna"},
		{"gpt-only", "normal", "gpt-5.6-terra"},
		{"gpt-only", "smart", "gpt-5.6-sol"},
		{"claude-only", "fast", "claude-haiku-4-5"},
		{"claude-only", "normal", "claude-sonnet-5"},
		{"claude-only", "smart", "claude-opus-5"},
		{"mixed", "fast", "gpt-5.6-luna"},
		{"mixed", "normal", "gpt-5.6-terra"},
		{"mixed", "smart", "claude-opus-5"},
	} {
		t.Run(tc.lane+"/"+tc.tier, func(t *testing.T) {
			route := c.genCombo(tc.lane, tc.tier, "medium", false, false, false, true)["vision"]
			if got := c.models[route.lead].ID; got != tc.want {
				t.Errorf("vision lead = %q, want %q", got, tc.want)
			}
		})
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
		"missing ladder": "probed: true\nmodels:\n  a:\n    id: x\n    pool: A\n    tier: 1\n    thinking: low→max\n",
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

// stubModels points the scaffolder's model-list probe at a fixed payload for
// the duration of a test, so the live init path never shells out to omp.
func stubModels(t *testing.T, models string) {
	t.Helper()
	prev := ompModelsJSON
	ompModelsJSON = func() ([]byte, error) { return []byte(models), nil }
	t.Cleanup(func() { ompModelsJSON = prev })
}

// benchProbe records what stubBench was asked to measure, so a test can prove
// the reachability probe actually fired rather than being skipped.
type benchProbe struct {
	calls int
	sels  []string
}

// stubBench points ompBenchJSON at a synthetic report that passes every
// selector it is handed, except those named in fail (matched on the whole
// selector or the bare id after the "provider/" prefix), which report the 404
// not-found shape — the one failure runBench may read as unreachable and drop.
// It asserts benchSelectors' contract that every selector is provider-qualified
// (omp fuzzy-matches a bare id otherwise) and records the calls it served.
func stubBench(t *testing.T, fail ...string) *benchProbe {
	t.Helper()
	failSet := map[string]bool{}
	for _, f := range fail {
		failSet[f] = true
	}
	rec := &benchProbe{}
	prev := ompBenchJSON
	ompBenchJSON = func(sels []string) ([]byte, error) {
		rec.calls++
		rec.sels = append(rec.sels, sels...)
		rows := make([]string, 0, len(sels))
		for _, s := range sels {
			if !strings.Contains(s, "/") {
				t.Errorf("benchSelectors must hand omp provider-qualified selectors, got %q", s)
			}
			id := s[strings.LastIndexByte(s, '/')+1:]
			if failSet[s] || failSet[id] {
				// The 404 not-found shape: the provider disowns the model. That is
				// the only failure runBench may read as unreachable, so these drop.
				rows = append(rows, fmt.Sprintf(`{"model":%q,"results":[{"ok":false,"error":"404 {\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"model: %s\"}}"}],"failures":1,"average":null}`, s, id))
				continue
			}
			// A clean pass: every run ok, zero failures, a measured average.
			rows = append(rows, fmt.Sprintf(`{"model":%q,"results":[{"ok":true}],"failures":0,"average":{"ttftMs":1404.2,"tokensPerSecond":48.94}}`, s))
		}
		return []byte(`{"models":[` + strings.Join(rows, ",") + `]}`), nil
	}
	t.Cleanup(func() { ompBenchJSON = prev })
	return rec
}

// passingProbe builds the reachability map a live bench would return when every
// listed model answers — the all-clear scaffoldModels gates rungs on.
func passingProbe(t *testing.T, modelsJSON string) map[string]benchFact {
	t.Helper()
	var models ompModels
	if err := json.Unmarshal([]byte(modelsJSON), &models); err != nil {
		t.Fatal(err)
	}
	probe := map[string]benchFact{}
	for _, m := range models.Models {
		probe[strings.ToLower(m.ID)] = benchFact{speed: 48.9, ttft: 1.4, reachable: true}
	}
	return probe
}

func scaffoldTo(t *testing.T, args ...string) (*catalog, string) {
	t.Helper()
	out := filepath.Join(t.TempDir(), "models.yml")
	// The scaffolder's live path is mandatory-probe now. Stub the model list
	// and a bench that passes every model, so init writes probed: true and the
	// file loads back cleanly — all without a real API call. (--from-json is no
	// longer usable here: it stamps probed: false, which loadCatalog rejects.)
	stubModels(t, initJSON)
	stubBench(t)
	if code := runGenerateInit(append([]string{"--models-file", out}, args...)); code != 0 {
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

// The reachability probe is what stops omp's catalog quirks from becoming live
// routing: omp lists claude-mythos-5 at claude-fable-5's exact price, but mythos
// answers a 404 not-found on accounts that lack it and no metadata tells the two
// apart. A model the provider disowns must be dropped, and the scaffold that
// remains must still certify as probed.
func TestGenerateInitBenchDropsUnreachableModels(t *testing.T) {
	stubOmp(t, "")
	stubModels(t, initJSON)
	stubBench(t, "claude-mythos-5")
	out := filepath.Join(t.TempDir(), "models.yml")
	if code := runGenerateInit([]string{"--models-file", out}); code != 0 {
		t.Fatalf("runGenerateInit exit %d", code)
	}
	c, err := loadCatalog(out)
	if err != nil {
		body, _ := os.ReadFile(out)
		t.Fatalf("scaffold does not load back: %v\n%s", err, body)
	}
	for _, k := range c.keys {
		if c.models[k].ID == "claude-mythos-5" {
			t.Error("a model the provider 404s must not reach the ladder")
		}
	}
	body, _ := os.ReadFile(out)
	// A not-found drop is not a partial probe: every survivor answered, so the
	// file is certified rather than left unprobed.
	if !strings.Contains(string(body), "probed: true") {
		t.Errorf("dropping a 404 model must still yield a certified scaffold:\n%s", body)
	}
	if strings.Contains(string(body), "placeholder") {
		t.Error("a live probe should replace the placeholder speed/ttft, not annotate them")
	}
	if !strings.Contains(string(body), "speed: 48.9") || !strings.Contains(string(body), "ttft: 1.4") {
		t.Errorf("measured figures missing from scaffold:\n%s", body)
	}
}

func TestGenerateInitRefresh(t *testing.T) {
	stubOmp(t, initUsage)
	stubModels(t, initJSON)
	stubBench(t)
	out := filepath.Join(t.TempDir(), "models.yml")
	base := []string{"--models-file", out}
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

// The probe marker is a hard gate: `code generate` must refuse a models file
// that was never verified as callable, and the rejection must name the
// remediation so the user is not left guessing. The remediation string is
// user-facing contract.
func TestLoadCatalogRequiresProbedMarker(t *testing.T) {
	// fixtureYML is a healthy ladder carrying `probed: true`; strip or flip the
	// marker to model the two unverified shapes a pre-gate scaffold produced.
	body := strings.TrimPrefix(fixtureYML, "probed: true\n")
	for _, tc := range []struct{ name, yml string }{
		{"no probed key", body},
		{"probed false", "probed: false\n" + body},
	} {
		_, err := catalogFrom(t, tc.yml)
		if err == nil {
			t.Errorf("%s: an unverified models file must be rejected", tc.name)
			continue
		}
		if !strings.Contains(err.Error(), "probed: true") {
			t.Errorf("%s: rejection must name the `probed: true` remedy, got %v", tc.name, err)
		}
	}
	// The marker present and true is the whole point: that file must load.
	if _, err := catalogFrom(t, fixtureYML); err != nil {
		t.Errorf("probed: true file rejected: %v", err)
	}
}

// A model the provider 404s is the one probe failure scaffoldModels may act on
// unilaterally: it drops the model and certifies the rest. claude-mythos-5 is
// the live trap — omp lists it at claude-fable-5's exact price, context and
// thinking, it 404s on accounts that lack it, and nothing in the metadata tells
// them apart, so only the probe can.
func TestScaffoldDropsNotFoundModels(t *testing.T) {
	stubOmp(t, "") // scaffoldModels reads the usage report; keep it offline
	probe := passingProbe(t, initJSON)
	probe["claude-mythos-5"] = benchFact{notFound: true, why: "not_found_error"}
	yml, err := scaffoldModels([]byte(initJSON), probe)
	if err != nil {
		t.Fatalf("a not-found model should drop cleanly, not error: %v", err)
	}
	if strings.Contains(yml, "claude-mythos-5") {
		t.Errorf("a 404 model must be dropped from the scaffold:\n%s", yml)
	}
	if !strings.Contains(yml, "probed: true") {
		t.Errorf("dropping a 404 model must still certify the scaffold:\n%s", yml)
	}
}

// The fable incident: omp's bundled bench prompt trips Anthropic's safety layer,
// so a perfectly callable claude-fable-5 comes back "Refusal (cyber)…". A
// refusal is evidence of nothing about entitlement, so it must NOT be collapsed
// into "unreachable" and silently delete the user's chosen elite. It has to
// surface as an unresolved error, while a genuine 404 (mythos) is still dropped
// — so the error names fable and never mentions mythos.
func TestScaffoldRefusalSurfacesNotDropped(t *testing.T) {
	stubOmp(t, "")
	probe := passingProbe(t, initJSON)
	probe["claude-fable-5"] = benchFact{why: "Refusal (cyber): This request triggered restrictions"}
	probe["claude-mythos-5"] = benchFact{notFound: true, why: "not_found_error"}
	_, err := scaffoldModels([]byte(initJSON), probe)
	if err == nil {
		t.Fatal("a refused (unresolved) probe must not certify a ladder")
	}
	if !strings.Contains(err.Error(), "claude-fable-5") || !strings.Contains(err.Error(), "Refusal") {
		t.Errorf("the refusal must surface, naming the model and reason: %v", err)
	}
	if strings.Contains(err.Error(), "claude-mythos-5") {
		t.Errorf("a genuine 404 is dropped, not reported as unresolved: %v", err)
	}
}

// Anything the probe cannot resolve — a candidate missing from the report, or
// one that failed for a reason other than 404 — must refuse the whole scaffold
// rather than guess. Dropping silently would write probed: true over a partial
// answer; keeping would crown a model that never replied.
func TestScaffoldUnresolvedProbeRefuses(t *testing.T) {
	stubOmp(t, "")
	for _, tc := range []struct {
		name   string
		mutate func(map[string]benchFact)
		want   string
	}{
		{"missing from report", func(p map[string]benchFact) { delete(p, "claude-opus-5") }, "missing from the probe report"},
		{"failed but not 404", func(p map[string]benchFact) { p["claude-opus-5"] = benchFact{why: "rate_limited"} }, "rate_limited"},
	} {
		probe := passingProbe(t, initJSON)
		tc.mutate(probe)
		_, err := scaffoldModels([]byte(initJSON), probe)
		if err == nil {
			t.Fatalf("%s: an unresolved probe must refuse the scaffold", tc.name)
		}
		if !strings.Contains(err.Error(), "claude-opus-5") || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: error must name the model and reason, got %v", tc.name, err)
		}
	}
}

// The --from-json offline path (probe nil) is the one way to scaffold without a
// probe, so it must not become a bypass: it takes every listed model on faith
// yet stamps the file probed: false, and loadCatalog then refuses it. Both
// halves matter — retention keeps the path useful, the marker keeps it safe.
func TestScaffoldOfflineRetainsButMarksUnprobed(t *testing.T) {
	stubOmp(t, initUsage)
	yml, err := scaffoldModels([]byte(initJSON), nil)
	if err != nil {
		t.Fatalf("offline scaffold: %v", err)
	}
	// Retention: nothing is filtered on reachability, so the full ladder still
	// scaffolds — the models a live probe would keep when everything passes.
	for _, id := range []string{"claude-opus-5", "claude-fable-5", "gpt-5.6-sol"} {
		if !strings.Contains(yml, id) {
			t.Errorf("probe==nil must retain models; %s missing:\n%s", id, yml)
		}
	}
	// Marking: yet the file is stamped unverified.
	if !strings.Contains(yml, "probed: false") {
		t.Errorf("offline scaffold must stamp probed: false:\n%s", yml)
	}
	// Bypass closure: an unverified file must not load.
	p := filepath.Join(t.TempDir(), "models.yml")
	if err := os.WriteFile(p, []byte(yml), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := loadCatalog(p); err == nil {
		t.Error("loadCatalog must refuse a probed: false scaffold")
	} else if !strings.Contains(err.Error(), "probed: true") {
		t.Errorf("rejection should point at the remediation, got %v", err)
	}
}

// The live path must actually invoke the probe, not merely be capable of
// filtering. A unit test of scaffoldModels alone would miss an accidental nil
// facts at the call site, so assert through the stub that init handed omp
// provider-qualified selectors covering the models that can become rungs.
func TestGenerateInitLiveProbesModels(t *testing.T) {
	stubOmp(t, initUsage)
	stubModels(t, initJSON)
	probe := stubBench(t)
	out := filepath.Join(t.TempDir(), "models.yml")
	if code := runGenerateInit([]string{"--models-file", out}); code != 0 {
		t.Fatalf("runGenerateInit exit %d", code)
	}
	if probe.calls == 0 {
		t.Fatal("live init must run the reachability probe")
	}
	// The probe has to reach the trap models, or an unreachable one slips
	// through. Spot-check both pools, the elite, and the mythos look-alike.
	for _, id := range []string{"claude-opus-5", "claude-fable-5", "claude-mythos-5", "gpt-5.6-sol"} {
		found := false
		for _, s := range probe.sels {
			if strings.HasSuffix(s, "/"+id) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("probe selectors did not cover %s: %v", id, probe.sels)
		}
	}
	// And the facts reached the file: a live scaffold is stamped probed: true.
	body, _ := os.ReadFile(out)
	if !strings.Contains(string(body), "probed: true") {
		t.Errorf("live init must stamp probed: true:\n%s", body)
	}
}

// runBench sorts each probe row into exactly one of three outcomes, and the
// distinction is load-bearing: only the provider's 404 (notFound) may drop a
// model, a clean run makes it reachable, and everything else — refusals, rate
// limits, incomplete rows — is unresolved and must be neither dropped nor
// trusted. Collapsing a refusal into "unreachable" is what would have deleted
// claude-fable-5 from a real user's ladder.
func TestRunBenchClassifiesOutcomes(t *testing.T) {
	prev := ompBenchJSON
	t.Cleanup(func() { ompBenchJSON = prev })
	stub := func(row string) {
		ompBenchJSON = func([]string) ([]byte, error) { return []byte(`{"models":[` + row + `]}`), nil }
	}

	// Reachable: every run answered, so the measured figures come through.
	stub(`{"model":"anthropic/x","results":[{"ok":true}],"failures":0,"average":{"ttftMs":1404.2,"tokensPerSecond":48.94}}`)
	facts, err := runBench([]string{"anthropic/x"})
	if err != nil {
		t.Fatalf("reachable: runBench: %v", err)
	}
	if f := facts["x"]; !f.reachable || f.notFound || f.speed != 48.9 || f.ttft != 1.4 {
		t.Errorf("clean row should be reachable with measured figures, got %+v", f)
	}

	// Not found: the provider disowns the model — the one droppable failure.
	stub(`{"model":"anthropic/x","results":[{"ok":false,"error":"404 not_found_error: model does not exist"}],"failures":1,"average":null}`)
	facts, err = runBench([]string{"anthropic/x"})
	if err != nil {
		t.Fatalf("notFound: runBench: %v", err)
	}
	if f := facts["x"]; !f.notFound || f.reachable {
		t.Errorf("a 404 row should be notFound, got %+v", f)
	}

	// Unresolved: a refusal or an incomplete row says nothing about entitlement,
	// so it is neither reachable nor notFound.
	for _, tc := range []struct{ name, row string }{
		{"refusal", `{"model":"anthropic/x","results":[{"ok":false,"error":"Refusal (cyber): This request triggered restrictions"}],"failures":1,"average":null}`},
		{"failed run", `{"model":"anthropic/x","results":[{"ok":true},{"ok":false,"error":"stream closed"}],"failures":0,"average":{"ttftMs":1000,"tokensPerSecond":40}}`},
		{"nonzero failures", `{"model":"anthropic/x","results":[{"ok":true}],"failures":2,"average":{"ttftMs":1000,"tokensPerSecond":40}}`},
		{"no results", `{"model":"anthropic/x","results":[],"failures":0,"average":{"ttftMs":1000,"tokensPerSecond":40}}`},
		{"null average", `{"model":"anthropic/x","results":[{"ok":true}],"failures":0,"average":null}`},
	} {
		stub(tc.row)
		facts, err := runBench([]string{"anthropic/x"})
		if err != nil {
			t.Fatalf("%s: runBench: %v", tc.name, err)
		}
		if f := facts["x"]; f.reachable || f.notFound {
			t.Errorf("%s: must be unresolved (neither reachable nor notFound), got %+v", tc.name, f)
		}
	}
}

// End to end, the live path must refuse rather than certify a partial probe: a
// refusal (the fable case) leaves no models file behind, so an unverified ladder
// can never reach `code generate`.
func TestGenerateInitRefusesUnresolvedProbe(t *testing.T) {
	stubOmp(t, "")
	stubModels(t, initJSON)
	prev := ompBenchJSON
	t.Cleanup(func() { ompBenchJSON = prev })
	ompBenchJSON = func(sels []string) ([]byte, error) {
		rows := make([]string, 0, len(sels))
		for _, s := range sels {
			// claude-fable-5 is callable, but omp's prompt trips a refusal;
			// every other model answers cleanly.
			if strings.HasSuffix(s, "/claude-fable-5") {
				rows = append(rows, fmt.Sprintf(`{"model":%q,"results":[{"ok":false,"error":"Refusal (cyber): blocked under Anthropic's Usage Policy"}],"failures":1,"average":null}`, s))
				continue
			}
			rows = append(rows, fmt.Sprintf(`{"model":%q,"results":[{"ok":true}],"failures":0,"average":{"ttftMs":1404.2,"tokensPerSecond":48.94}}`, s))
		}
		return []byte(`{"models":[` + strings.Join(rows, ",") + `]}`), nil
	}
	out := filepath.Join(t.TempDir(), "models.yml")
	if code := runGenerateInit([]string{"--models-file", out}); code == 0 {
		t.Error("init must fail when the probe is inconclusive")
	}
	if _, err := os.Stat(out); !os.IsNotExist(err) {
		t.Errorf("no models file may be written from an unresolved probe (stat err: %v)", err)
	}
}

// fixtureYMLDeepSeek extends the two-pool fixture with a full DeepSeek pool
// (three text-only rungs) — the three-pool grid the ds lanes are generated
// from.
const fixtureYMLDeepSeek = fixtureYML + `  lite:
    id: deepseek-v4-lite
    pool: D
    tier: 1
    bucket: deepseek-main
    cost_in: 0.1
    cost_out: 0.4
    speed: 60
    ttft: 1.5
    context: 128000
    thinking: low→high
    image: false
  v4:
    id: deepseek-v4
    pool: D
    tier: 2
    bucket: deepseek-main
    cost_in: 0.3
    cost_out: 1.2
    speed: 45
    ttft: 2.1
    context: 128000
    thinking: low→high
    image: false
  pro:
    id: deepseek-v4-pro
    pool: D
    tier: 3
    bucket: deepseek-main
    cost_in: 0.6
    cost_out: 2.4
    speed: 38
    ttft: 2.8
    context: 128000
    thinking: low→high
    image: false
`

// fixtureYMLDeepSeekOneRung brings a single DeepSeek model: the optional-pool
// fill must complete tiers 1..3 from it, and chain dedupe must collapse the
// duplicates.
const fixtureYMLDeepSeekOneRung = fixtureYML + `  v4:
    id: deepseek-v4
    pool: D
    tier: 2
    bucket: deepseek-main
    cost_in: 0.3
    cost_out: 1.2
    speed: 45
    ttft: 2.1
    context: 128000
    thinking: low→high
    image: false
`

// TestGoldenCatalogTwoPool is the byte-compat contract of the N-pool
// generalisation: a two-pool models file renders the exact catalog the old
// binary-pool renderer produced (modulo the reviewed additions the golden
// carries: the __models__ bucket+provider columns and the security-reviewer
// role).
func TestGoldenCatalogTwoPool(t *testing.T) {
	want, err := os.ReadFile(filepath.Join("testdata", "two-pool-golden.plain"))
	if err != nil {
		t.Fatal(err)
	}
	c := fixtureCatalog(t)
	if got := c.renderCatalog(); got != string(want) {
		t.Errorf("two-pool catalog is no longer byte-identical to the golden (diff it against testdata/two-pool-golden.plain to review)\ngot %d bytes, want %d", len(got), len(want))
	}
}

// TestThreePoolCatalog locks the DeepSeek pool's grid semantics: the two new
// lanes, special-tier validity, relief tails on led/mixed heavyweight chains
// (and only there), the vision purity exception, and the ds advisor contexts.
func TestThreePoolCatalog(t *testing.T) {
	c, err := catalogFrom(t, fixtureYMLDeepSeek)
	if err != nil {
		t.Fatalf("loadCatalog: %v", err)
	}
	out := c.renderCatalog()

	for _, lane := range []string{"gpt-only", "gpt-led", "mixed", "claude-led", "claude-only", "ds-led", "ds-only"} {
		if !strings.Contains(out, "\n"+lane+"_normal_medium_nosp_nofa_rel  ") {
			t.Errorf("lane %s missing from the three-pool grid", lane)
		}
	}
	// Special tiers follow their pool: none on ds-only, both on ds-led.
	if strings.Contains(out, "\nds-only_normal_medium_sp_") || strings.Contains(out, "_medium_nosp_fa\nds-only") ||
		strings.Contains(out, "\nds-only_normal_medium_nosp_fa") {
		t.Error("ds-only generated spark/fable combos it cannot host")
	}
	for _, id := range []string{"ds-led_normal_medium_sp_nofa_rel", "ds-led_normal_medium_nosp_fa_rel", "ds-led_normal_medium_nosp_famain_rel"} {
		if !strings.Contains(out, "\n"+id+"  ") {
			t.Errorf("ds-led combo %s missing", id)
		}
	}

	block := func(id string) string {
		i := strings.Index(out, "\n"+id+"  ")
		if i < 0 {
			t.Fatalf("combo %s missing", id)
		}
		rest := out[i+1:]
		if j := strings.Index(rest, "\n\n"); j >= 0 {
			rest = rest[:j]
		}
		return rest
	}
	row := func(blk, role string) string {
		for _, ln := range strings.Split(blk, "\n") {
			f := strings.Fields(ln)
			if len(f) > 1 && f[0] == "●" {
				f = f[1:]
			}
			if len(f) > 0 && f[0] == role {
				return ln
			}
		}
		t.Fatalf("role %s missing from block:\n%s", role, blk)
		return ""
	}

	// Relief tails: led/mixed heavyweight chains end on the DeepSeek regular
	// rung; pure lanes stay pure.
	for _, lane := range []string{"gpt-led", "mixed", "claude-led"} {
		blk := block(lane + "_normal_medium_nosp_nofa_rel")
		for _, role := range []string{"default", "task", "plan", "slow"} {
			if r := row(blk, role); !strings.HasSuffix(r, "→ deepseek-v4:medium") && !strings.HasSuffix(r, "→ deepseek-v4:high") {
				t.Errorf("%s %s chain lacks the DeepSeek relief tail: %q", lane, role, r)
			}
		}
		if r := row(blk, "reviewer"); strings.Contains(r, "deepseek") {
			t.Errorf("%s reviewer must not gain a relief tail: %q", lane, r)
		}
	}
	for _, lane := range []string{"gpt-only", "claude-only"} {
		if blk := block(lane + "_normal_medium_nosp_nofa_rel"); strings.Contains(blk, "deepseek") {
			t.Errorf("pure lane %s crossed into the DeepSeek pool:\n%s", lane, blk)
		}
	}

	// Vision purity exception: every DeepSeek rung is text-only, so ds-only's
	// vision role must cross pools rather than route images to a text model.
	dsOnly := block("ds-only_smart_medium_nosp_nofa_rel")
	if r := row(dsOnly, "vision"); strings.Contains(r, "deepseek") || !strings.Contains(r, "gpt-5.6-sol:low") {
		t.Errorf("ds-only vision must cross to an image-capable pool: %q", r)
	}
	// …and every other ds-only role stays on DeepSeek.
	for _, role := range []string{"default", "task", "plan", "reviewer", "advisor", "commit"} {
		if r := row(dsOnly, role); strings.Contains(r, "gpt") || strings.Contains(r, "claude") {
			t.Errorf("ds-only %s left the pool: %q", role, r)
		}
	}

	// The advisor dial gains one context per pool.
	for _, want := range []string{
		"  glance ds deepseek-v4-lite:low",
		"  review ds deepseek-v4:medium → deepseek-v4-lite:low",
		"  audit ds deepseek-v4-pro:high → deepseek-v4:high → deepseek-v4-lite:low",
	} {
		if !strings.Contains(out, want+"\n") {
			t.Errorf("advisors block lacks %q", want)
		}
	}

	// The facts table carries the provider column for every pool.
	if !strings.Contains(out, "  deepseek-v4 0.3 1.2 45 2.1 deepseek-main deepseek\n") {
		t.Error("facts table lacks the deepseek provider row")
	}
}

// TestOneRungOptionalPool: a single verified DeepSeek model is enough to grow
// the ds lanes — the fill borrows it for every ladder tier and dedupe keeps
// the chains single-entry.
func TestOneRungOptionalPool(t *testing.T) {
	c, err := catalogFrom(t, fixtureYMLDeepSeekOneRung)
	if err != nil {
		t.Fatalf("loadCatalog: %v", err)
	}
	for tier := 1; tier <= 3; tier++ {
		if got := c.ladder["D"][tier]; got != "v4" {
			t.Fatalf("optional-pool fill: ladder[D][%d] = %q, want v4", tier, got)
		}
	}
	out := c.renderCatalog()
	blkStart := strings.Index(out, "\nds-only_smart_medium_nosp_nofa_rel  ")
	if blkStart < 0 {
		t.Fatal("one-rung D pool generated no ds-only lane")
	}
	blk := out[blkStart:]
	if i := strings.Index(blk[1:], "\n\n"); i >= 0 {
		blk = blk[:i+1]
	}
	if strings.Contains(blk, "deepseek-v4:medium → deepseek-v4:medium") {
		t.Errorf("borrowed rungs must dedupe out of the chains:\n%s", blk)
	}
	if !strings.Contains(blk, "    default    deepseek-v4:medium\n") {
		t.Errorf("one-rung ds-only default should be the single model, got:\n%s", blk)
	}
}

// TestReliefToggle: _norel combos exist only on metered-led blends, and the
// off variant strips exactly the DeepSeek tail while everything else in the
// block stays identical.
func TestReliefToggle(t *testing.T) {
	c, err := catalogFrom(t, fixtureYMLDeepSeek)
	if err != nil {
		t.Fatalf("loadCatalog: %v", err)
	}
	out := c.renderCatalog()
	for _, lane := range []string{"gpt-led", "mixed", "claude-led"} {
		if !strings.Contains(out, "\n"+lane+"_normal_medium_nosp_nofa_norel  ") {
			t.Errorf("%s lacks a relief-off combo", lane)
		}
	}
	for _, lane := range []string{"gpt-only", "claude-only", "ds-led", "ds-only"} {
		if strings.Contains(out, "\n"+lane+"_normal_medium_nosp_nofa_norel  ") {
			t.Errorf("%s generated a relief-off combo it cannot use", lane)
		}
	}
	on := c.renderCombo("gpt-led", "normal", "medium", false, false, false, true, true)
	off := c.renderCombo("gpt-led", "normal", "medium", false, false, false, false, true)
	if !strings.Contains(on, "deepseek") {
		t.Fatalf("relief-on block lost its tail:\n%s", on)
	}
	if strings.Contains(off, "deepseek") {
		t.Errorf("relief-off block still spills into DeepSeek:\n%s", off)
	}
	strip := func(s string) string {
		s = strings.ReplaceAll(s, " → deepseek-v4:medium", "")
		s = strings.ReplaceAll(s, " → deepseek-v4:high", "")
		s = strings.ReplaceAll(s, "_rel  ", "  ")
		s = strings.ReplaceAll(s, "_norel  ", "  ")
		return strings.ReplaceAll(s, " · no-relief", "")
	}
	if strip(on) != strip(off) {
		t.Errorf("relief must only add/remove tails; blocks diverge:\n--- on ---\n%s\n--- off ---\n%s", on, off)
	}
}

// ── pool R (OpenRouter) ───────────────────────────────────────────────────────

// oxEntries declares a one-model family the only way the loader accepts: once
// per tier, with ascending thinking ceilings. Same id everywhere — the tiers
// ARE the thinking variations.
const oxEntries = `
  oxfast:
    id: stealth/ox-alpha
    pool: R
    tier: 1
    bucket: openrouter-free
    cost_in: 0
    cost_out: 0
    speed: 27.4
    ttft: 2.1
    context: 1048576
    thinking: low→low
  ox:
    id: stealth/ox-alpha
    pool: R
    tier: 2
    bucket: openrouter-free
    cost_in: 0
    cost_out: 0
    speed: 27.4
    ttft: 2.1
    context: 1048576
    thinking: low,high
  oxmax:
    id: stealth/ox-alpha
    pool: R
    tier: 3
    bucket: openrouter-free
    cost_in: 0
    cost_out: 0
    speed: 27.4
    ttft: 2.1
    context: 1048576
    thinking: low,high,max
`

func catalogWithOx(t *testing.T) *catalog {
	t.Helper()
	c, err := catalogFrom(t, fixtureYML+oxEntries)
	if err != nil {
		t.Fatalf("loadCatalog with ox ladder: %v", err)
	}
	return c
}

func TestOxLadderGatesLanes(t *testing.T) {
	base := fixtureCatalog(t)
	if got := base.lanes(); len(got) != len(genBaseLanes) {
		t.Errorf("base catalog serves %d lanes, want %d: %v", len(got), len(genBaseLanes), got)
	}
	withOx := catalogWithOx(t)
	want := append(append([]string{}, genBaseLanes...), "ox-only", "ox-led", "ox-lean")
	if got := withOx.lanes(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("ox catalog serves %v, want %v", got, want)
	}
}

func TestOxLadderAllOrNothing(t *testing.T) {
	// Drop the tier-3 entry: a two-of-three ladder must be refused outright.
	partial := strings.Split(oxEntries, "  oxmax:")[0]
	if _, err := catalogFrom(t, fixtureYML+partial); err == nil || !strings.Contains(err.Error(), "pool R must fill tiers 1..3") {
		t.Errorf("partial ox ladder accepted (err: %v)", err)
	}
}

func TestGenValidOxLanes(t *testing.T) {
	for _, tc := range []struct {
		lane                string
		spark, fable, main_ bool
		want                bool
	}{
		{"ox-only", false, false, false, true},
		{"ox-only", true, false, false, false}, // no O drain bucket to lead with
		{"ox-only", false, true, false, false}, // no A elite on a pure ox lane
		{"ox-led", false, false, false, true},
		{"ox-led", false, true, true, false}, // fable-as-main defeats the free worker
		{"ox-lean", false, false, false, true},
		{"ox-lean", true, false, false, false}, // utility is ox here; spark has nothing to drain
		{"ox-lean", false, true, false, true},  // deliberative roles stay Claude; fable may lead them
		{"ox-lean", false, true, true, true},   // fable-as-default is exactly what lean is for
	} {
		if got := genValid(tc.lane, tc.spark, tc.fable, tc.main_, true); got != tc.want {
			t.Errorf("genValid(%s, sp=%v, fa=%v, famain=%v) = %v, want %v",
				tc.lane, tc.spark, tc.fable, tc.main_, got, tc.want)
		}
	}
}

// The ox lanes route by policy, not price: everything high-volume stays on the
// free pool; deliberative work crosses to Anthropic; the reviewer never shares
// its lead's provider.
func TestOxLaneRoutingPolicy(t *testing.T) {
	c := catalogWithOx(t)
	combo := c.genCombo("ox-led", "smart", "high", false, true, false, false)
	for _, r := range []string{"default", "task", "scout", "sonic", "smol", "tiny", "commit", "vision"} {
		if id := c.models[combo[r].lead].ID; id != "stealth/ox-alpha" {
			t.Errorf("ox-led %s lead = %s, want stealth/ox-alpha", r, id)
		}
	}
	for _, r := range []string{"plan", "slow", "designer", "reviewer"} {
		pool := c.models[combo[r].lead].Pool
		if pool != "A" {
			t.Errorf("ox-led deliberative role %s routes to pool %s, want A", r, pool)
		}
	}
	// Fable is on: it leads plan/slow/designer/reviewer outright.
	for _, r := range []string{"plan", "slow", "designer", "reviewer"} {
		if id := c.models[combo[r].lead].ID; id != "claude-fable-5" {
			t.Errorf("ox-led smart + fable: %s lead = %s, want claude-fable-5", r, id)
		}
	}
	// Pure ox: every role including advisor and reviewer stays on R.
	pure := c.genCombo("ox-only", "normal", "medium", false, false, false, false)
	for _, r := range genRoleOrder {
		rt := pure[r]
		if rt.lead == "" {
			continue
		}
		if id := c.models[rt.lead].ID; id != "stealth/ox-alpha" {
			t.Errorf("ox-only %s lead = %s, want stealth/ox-alpha", r, id)
		}
	}
}

// ox-lean is ox-led's mirror: paid providers answer for the work, the free
// pool absorbs the background. Fable-as-main is allowed — handing the default
// seat to the elite is exactly what an operator on this lane may want.
func TestOxLeanRoutingPolicy(t *testing.T) {
	c := catalogWithOx(t)
	combo := c.genCombo("ox-lean", "smart", "high", false, true, true, false)
	// fable-as-main hands only the default seat to the elite; task and
	// librarian follow the lane's OpenAI primary.
	for _, r := range []string{"task", "librarian"} {
		if pool := c.models[combo[r].lead].Pool; pool != "O" {
			t.Errorf("ox-lean %s lead pool = %s, want O", r, pool)
		}
	}
	if id := c.models[combo["default"].lead].ID; id != "claude-fable-5" {
		t.Errorf("ox-lean famain default = %s, want claude-fable-5", id)
	}
	for _, r := range []string{"scout", "sonic", "smol", "tiny", "commit", "vision"} {
		if id := c.models[combo[r].lead].ID; id != "stealth/ox-alpha" {
			t.Errorf("ox-lean %s lead = %s, want stealth/ox-alpha", r, id)
		}
	}
	for _, r := range []string{"plan", "slow", "designer", "reviewer"} {
		if pool := c.models[combo[r].lead].Pool; pool != "A" {
			t.Errorf("ox-lean deliberative %s pool = %s, want A", r, pool)
		}
	}
	// Without fable, workers stay on the OpenAI primary.
	base := c.genCombo("ox-lean", "normal", "medium", false, false, false, false)
	for _, r := range []string{"default", "task"} {
		if pool := c.models[base[r].lead].Pool; pool != "O" {
			t.Errorf("ox-lean %s pool = %s, want O", r, pool)
		}
	}
}

func TestAdvisorsIncludeOxContext(t *testing.T) {
	withOx := catalogWithOx(t)
	got := withOx.renderAdvisors()
	if !strings.Contains(got, "glance ox stealth/ox-alpha:low") {
		t.Errorf("advisor table missing ox context:\n%s", got)
	}
	base := fixtureCatalog(t)
	if strings.Contains(base.renderAdvisors(), " ox ") {
		t.Error("base catalog must not advertise an ox advisor context")
	}
}
