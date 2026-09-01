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

// goldenMixedSmart is the routing the retired `fable` toggle used to produce by
// hand: on a mixed lane at `smart` the deliberative bump (t = base+1, capped at
// the pool's own top rung) lands plan/slow/designer/reviewer on pool A's tier-4
// rung. The toggle is gone; the block it produced must not be.
const goldenMixedSmart = `mixed_smart_medium_sp  mixed · smart · medium · spark
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

// goldenClaudeElite is the other half of what the retired toggles produced: the
// old `fable`+`main` pair put the tier-4 rung in the `default` seat as well as
// the deliberative ones. That is now exactly the `elite` notch — base = 4, so
// every capability seat reads the pool's top rung directly rather than through
// the deliberative bump. The utility seats stay capped (scout/smol/tiny on
// tier 2, commit on tier 1): no notch of the model dial may make a role that
// runs on every keystroke expensive.
const goldenClaudeElite = `claude-only_elite_max_nosp  claude-only · elite · max
  thinking max · fallback on · advisor on
    default    claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
  ● task       claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
    plan       claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
    slow       claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
  ● designer   claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
  ● reviewer   claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
  ● security-reviewer claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
  ● librarian  claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
  ● scout      claude-sonnet-5:max      → claude-haiku-4-5:xhigh
  ● sonic      claude-sonnet-5:max      → claude-haiku-4-5:xhigh
    advisor    claude-sonnet-5:max      → claude-haiku-4-5:xhigh
    vision     claude-fable-5:max       → claude-opus-5:max → claude-sonnet-5:max
    smol       claude-sonnet-5:max
    tiny       claude-sonnet-5:max
    commit     claude-haiku-4-5:xhigh
`

// goldenClaudeSmart is the one combo where the Anthropic smart rung is itself
// the padded lead column, so a change to that model's id shifts the padding
// rather than just swapping a chain token. Every other golden here has a pool-O
// model or the tier-4 rung in the lead.
const goldenClaudeSmart = `claude-only_smart_medium_nosp  claude-only · smart · medium
  thinking medium · fallback on · advisor on
    default    claude-opus-5:medium     → claude-sonnet-5:medium → claude-haiku-4-5:medium
  ● task       claude-opus-5:medium     → claude-sonnet-5:medium → claude-haiku-4-5:medium
    plan       claude-fable-5:high      → claude-opus-5:high → claude-sonnet-5:high
    slow       claude-fable-5:high      → claude-opus-5:high → claude-sonnet-5:high
  ● designer   claude-fable-5:high      → claude-opus-5:high → claude-sonnet-5:high
  ● reviewer   claude-fable-5:high      → claude-opus-5:high → claude-sonnet-5:high
  ● security-reviewer claude-fable-5:high      → claude-opus-5:high → claude-sonnet-5:high
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
		{"mixed_smart_medium_sp", goldenMixedSmart, func() string {
			return c.renderCombo("mixed", "smart", "medium", true)
		}},
		{"claude-only_elite_max_nosp", goldenClaudeElite, func() string {
			return c.renderCombo("claude-only", "elite", "max", false)
		}},
		{"claude-only_smart_medium_nosp", goldenClaudeSmart, func() string {
			return c.renderCombo("claude-only", "smart", "medium", false)
		}},
	} {
		if got := tc.render(); got != tc.want {
			t.Errorf("%s mismatch:\n--- got ---\n%s\n--- want ---\n%s", tc.name, got, tc.want)
		}
	}
}

// eliteLanesInFixture names the lanes the two-pool fixture may carry an `elite`
// combo on, derived by hand from the fixture rather than from the generator:
// pool A ladders to tier 4 (claude-fable-5) and pool O stops at tier 3, and the
// notch is gated on the lane's *lead* pool, so only the A-led lanes qualify.
// Hard-coded on purpose — asking the catalog would make the coverage walk below
// agree with the generator by construction instead of checking it.
var eliteLanesInFixture = map[string]bool{"claude-led": true, "claude-only": true}

func TestRenderCatalogStructure(t *testing.T) {
	c := fixtureCatalog(t)
	out := c.renderCatalog()
	// 180 combos on the full fixture, 6 thinking levels each:
	//   gpt-only    3 mtiers × 2 spark states = 36  (lead O tops at 3: no elite)
	//   gpt-led     3 × 2 = 36
	//   mixed       3 × 2 = 36                      (lead is O, so still no elite)
	//   claude-led  4 × 2 = 48                      (lead A ladders to 4)
	//   claude-only 4 × 1 = 24                      (pure A hosts no spark)
	combos := 0
	for _, l := range strings.Split(out, "\n") {
		if l != "" && l[0] != ' ' && strings.Contains(l, "_") && !strings.HasPrefix(l, "__") {
			combos++
		}
	}
	if combos != 180 {
		t.Errorf("combo blocks = %d, want 180", combos)
	}
	for _, want := range []string{"__advisors__", "__models__", "\ngpt-only_fast_minimal_sp  ", "\nclaude-only_elite_max_nosp  "} {
		if !strings.Contains(out, want) {
			t.Errorf("catalog missing %q", want)
		}
	}
	// The TUI's comboID must find a block for every dial state its facets
	// allow — after applyCatalog trims the lane dial to the lanes this
	// catalog serves (a two-pool catalog never offers optional-pool lanes)
	// and visibleFacets narrows the model dial to the notches each lane
	// serves. Everything else in the facet space must resolve.
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
	misses, eliteSeen := 0, 0
	walk = func(i int) {
		if i == len(facets) {
			if sel["model"] == "elite" {
				if !eliteLanesInFixture[sel["lane"]] {
					return // the dial never offers elite here; no block to find
				}
				eliteSeen++
			}
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
			if facets[i].key == "lane" && !servedLanes[v] {
				continue
			}
			sel[facets[i].key] = v
			walk(i + 1)
		}
	}
	walk(0)
	// The walk is only worth anything if it reached the fourth notch:
	// 2 elite lanes × 6 thinking × 4 advisor × 2 fast × 2 spark × 2 prewalk ×
	// 2 planyolo. Without this a model dial that quietly lost "elite" — or a
	// generator that stopped emitting elite combos on the lanes that can host
	// them — would pass silently.
	if want := 2 * 6 * 4 * 2 * 2 * 2 * 2; eliteSeen != want {
		t.Errorf("coverage walk reached %d elite dial states, want %d", eliteSeen, want)
	}
	// The session-switch dials must never reach comboID. If one did, the
	// generator would owe a grid twice the size for a setting that selects no
	// model — which is the whole reason they are applied at launch instead.
	for _, key := range []string{"prewalk", "planyolo", "advisor", "fast"} {
		on := map[string]string{"lane": "claude-only", "model": "elite", "thinking": "high", "spark": "off", key: "on"}
		off := map[string]string{"lane": "claude-only", "model": "elite", "thinking": "high", "spark": "off", key: "off"}
		if comboID(on) != comboID(off) {
			t.Errorf("dial %q changed comboID: %s vs %s", key, comboID(on), comboID(off))
		}
	}
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
	block := c.renderCombo("mixed", "normal", "medium", false)
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
	block := c.renderCombo("gpt-only", "fast", "medium", false)
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
		// The fourth notch reaches the fourth rung: visionLead scans 4..1, so
		// an A-led lane at `elite` describes images on the top rung.
		{"claude-only", "elite", "claude-fable-5"},
		{"claude-led", "elite", "claude-fable-5"},
		{"mixed", "fast", "gpt-5.6-luna"},
		{"mixed", "normal", "gpt-5.6-terra"},
		{"mixed", "smart", "claude-opus-5"},
	} {
		t.Run(tc.lane+"/"+tc.tier, func(t *testing.T) {
			route := c.genCombo(tc.lane, tc.tier, "medium", false)["vision"]
			if got := c.models[route.lead].ID; got != tc.want {
				t.Errorf("vision lead = %q, want %q", got, tc.want)
			}
		})
	}
}

// withoutModel drops one top-level model entry from a models.yml body — the
// way a real catalog arrives when a provider never shipped that rung.
func withoutModel(yml, key string) string {
	trimmed := ""
	skip := false
	for _, line := range strings.Split(yml, "\n") {
		if strings.HasPrefix(line, "  "+key+":") {
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
	return trimmed
}

// The two optional rungs are independent switches now that the elite dial notch
// is just tier 4 of the ordinary ladder, so they get one property each. They
// used to be tested together as "no spark/tier-4 models ⇒ no spark or elite
// combos", which conflated an off-ladder quota bucket with a capability rung.
func TestCatalogWithoutOptionalTiers(t *testing.T) {
	// (a) No tier-0 model: the spark facet has nothing to lead with, so not one
	// `_sp` combo may be generated — the TUI hides the dial and any `_sp` block
	// it did emit would be an id no dial state can ever reach.
	c, err := catalogFrom(t, withoutModel(fixtureYML, "spark"))
	if err != nil {
		t.Fatalf("loadCatalog without tier 0: %v", err)
	}
	if c.specialKey("spark") != "" {
		t.Fatal("fixture without the tier-0 model still resolves a spark key")
	}
	out := c.renderCatalog()
	if strings.Contains(out, "_sp  ") {
		t.Error("catalog without a tier-0 model must not emit spark combos")
	}
	for _, want := range []string{"\nmixed_smart_medium_nosp  ", "\nclaude-only_elite_medium_nosp  "} {
		if !strings.Contains(out, want) {
			t.Errorf("base combos missing from the tier-0-less catalog: %q", want)
		}
	}

	// (b) No tier-4 rung anywhere: `elite` would clamp back to each pool's best
	// rung and render byte-identical to `smart`, so the notch is not generated
	// at all — while every base combo still renders.
	c, err = catalogFrom(t, withoutModel(fixtureYML, "fable"))
	if err != nil {
		t.Fatalf("loadCatalog without tier 4: %v", err)
	}
	for _, pool := range []string{"O", "A"} {
		if c.top(pool) != 3 {
			t.Fatalf("pool %s should top out at 3 without the tier-4 rung, got %d", pool, c.top(pool))
		}
	}
	out = c.renderCatalog()
	if strings.Contains(out, "_elite_") {
		t.Error("catalog with no tier-4 rung must not emit elite combos")
	}
	for _, want := range []string{"\nmixed_smart_medium_nosp  ", "\ngpt-only_fast_minimal_sp  ", "\nclaude-only_smart_max_nosp  "} {
		if !strings.Contains(out, want) {
			t.Errorf("base combos missing from the tier-4-less catalog: %q", want)
		}
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

// initJSONWithFable51 is the operator's real situation: omp lists both
// claude-fable-5 and its newer sibling claude-fable-5-1 at the same price and
// specs. familyOf() puts them in one family ("claude-fable", versions [5] and
// [5 1]), so supersede() prefers 5-1 — which is exactly why routing to it needs
// no new code, and exactly why a probe that drops 5-1 must leave 5 behind.
const initJSONWithFable51 = `{"models":[
 {"provider":"anthropic","id":"claude-haiku-4-5","contextWindow":200000,"reasoning":true,"thinking":["minimal","low","medium","high","xhigh"],"input":["text","image"],"cost":{"input":1,"output":5}},
 {"provider":"anthropic","id":"claude-sonnet-5","contextWindow":1000000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":2,"output":10}},
 {"provider":"anthropic","id":"claude-opus-5","contextWindow":1000000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":5,"output":25}},
 {"provider":"anthropic","id":"claude-fable-5","contextWindow":1000000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":10,"output":50}},
 {"provider":"anthropic","id":"claude-fable-5-1","contextWindow":1000000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":10,"output":50}},
 {"provider":"openai-codex","id":"gpt-5.6-luna","contextWindow":272000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":1,"output":6}},
 {"provider":"openai-codex","id":"gpt-5.6-terra","contextWindow":272000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":2.5,"output":15}},
 {"provider":"openai-codex","id":"gpt-5.6-sol","contextWindow":272000,"reasoning":true,"thinking":["low","medium","high","xhigh","max"],"input":["text","image"],"cost":{"input":5,"output":30}}
]}`

// initUsage is the shape omp reports: a spark bucket that names its model, and
// a tier-scoped Anthropic window that names only its tier. The scaffolder must
// mine the first for pool O's tier-0 rung and ignore the second — no provider
// declares an Anthropic special facet, so that window is not a ladder signal.
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
				rows = append(rows, fmt.Sprintf(`{"model":%q,"results":[{"ok":false,"error":"404 {\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"model: %s\"}}"}],"stats":null}`, s, id))
				continue
			}
			// A clean pass, in omp 18.x's shape: every run ok, and a `stats`
			// block whose metrics are {mean,…} distributions. The omp 17 shape
			// (a flat `average` object plus a per-model `failures` count) is
			// deliberately not emitted here — it parsed into a nil aggregate
			// against the real payload, which misfiled every reachable model as
			// an incomplete report and made `generate init` refuse every run.
			rows = append(rows, fmt.Sprintf(`{"model":%q,"results":[{"ok":true}],"stats":{"ttftMs":{"mean":1404.2},"generationTps":{"mean":48.94},"tokensPerSecond":{"mean":12.3}}}`, s))
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
	// Pool O ladders to four here purely because this model list offers four
	// usable rungs — the depth is data, never a constant, which is the whole
	// point of the pool-generic ladder (a provider shipping a fourth model
	// lights up its lanes' elite notch with no code change).
	want := map[string][5]string{
		"O": {"gpt-5.3-codex-spark", "gpt-5.4-mini", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"},
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
	// The one tier-scoped bucket left is the spark window: tier 4 is an ordinary
	// capability rung now, so it draws its pool's main window and the usage
	// meter must not be handed a bucket no provider declares.
	if !strings.Contains(text, "bucket: codex-spark") {
		t.Errorf("scaffold should carry the spark bucket omp reported:\n%s", text)
	}
	if strings.Contains(text, "bucket: claude-fable") {
		t.Errorf("the tier-4 rung draws the pool's main window, not an invented one:\n%s", text)
	}
	// A scaffolded catalog must render end-to-end, spark and elite included —
	// and elite on a *gpt* lane, since this model list gives pool O four rungs.
	rendered := c.renderCatalog()
	for _, want := range []string{"\nmixed_smart_medium_nosp  ", "\nmixed_smart_medium_sp  ", "\ngpt-only_elite_medium_nosp  "} {
		if !strings.Contains(rendered, want) {
			t.Errorf("scaffolded catalog missing %q", want)
		}
	}
}

// Without a usage probe the off-ladder spark tier is simply absent — but tier 4
// is not a usage-derived special tier any more, it is the ladder's top rung, so
// it must survive a machine where the quota probe fails. Losing it here would
// silently delete the elite notch for anyone whose `omp usage` is unavailable.
func TestGenerateInitWithoutUsageProbe(t *testing.T) {
	stubOmp(t, "")
	c, _ := scaffoldTo(t)
	if c.ladder["O"][0] != "" {
		t.Errorf("no usage report should mean no spark tier, got %v", c.ladder["O"])
	}
	for _, pool := range []string{"O", "A"} {
		for tier := 1; tier <= 4; tier++ {
			if c.ladder[pool][tier] == "" {
				t.Errorf("pool %s tier %d left empty", pool, tier)
			}
		}
		if c.top(pool) != 4 {
			t.Errorf("pool %s should still ladder to 4 without a usage report, got %d", pool, c.top(pool))
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
	// The probe has to reach every model that can become a rung, or an
	// unreachable one slips through. Spot-check both pools and the top rung.
	// claude-mythos-5 is deliberately NOT here: it is on the skip list, and
	// TestSkippedModelsNeverProbed asserts its absence from these selectors.
	for _, id := range []string{"claude-opus-5", "claude-fable-5", "gpt-5.6-sol"} {
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

// runBench sorts each probe row into exactly one of four outcomes, and the
// distinction is load-bearing: only the provider's 404 (notFound) or its
// client-version gate (blocked) may drop a model, a clean run makes it
// reachable, and everything else — refusals, rate limits, incomplete rows — is
// unresolved and must be neither dropped nor trusted. Collapsing a refusal into
// "unreachable" is what would have deleted claude-fable-5 from a real user's
// ladder.
//
// Every row below is the real omp 18.0.11 payload shape, captured from live
// runs on the operator's machine. That matters more than usual here: omp 18.x
// renamed the per-model aggregate from `average` to `stats`, made each metric a
// {mean,min,p50,p95,max} object instead of a bare float, and dropped the
// per-model `failures` count. The old parse silently produced a nil aggregate
// for every model, so every reachable model was misfiled as "incomplete probe
// report" and `code generate init` refused every ladder it was asked to build.
// A schema-shaped fixture is the only kind that catches that.
func TestRunBenchClassifiesOutcomes(t *testing.T) {
	prev := ompBenchJSON
	t.Cleanup(func() { ompBenchJSON = prev })
	stub := func(row string) {
		ompBenchJSON = func([]string) ([]byte, error) { return []byte(`{"models":[` + row + `]}`), nil }
	}

	// Reachable: verbatim claude-haiku-4-5 stats from a live probe. speed must
	// read generationTps (62.0), NOT tokensPerSecond (5.1) — the latter folds
	// the startup wait into the same figure, and effTPS already composes ttft
	// with the streaming rate itself, so trusting it would charge for
	// time-to-first-token twice and rank a fast model as the slowest in the
	// catalog.
	stub(`{"model":"anthropic/claude-haiku-4-5","results":[{"ok":true}],"stats":{"ttftMs":{"mean":716.7357240000001,"min":716.7,"p50":716.7,"p95":716.7,"max":716.7},"tokensPerSecond":{"mean":5.120137111537292},"generationTps":{"mean":62.02189357337661}}}`)
	facts, err := runBench([]string{"claude-haiku-4-5"})
	if err != nil {
		t.Fatalf("reachable: runBench: %v", err)
	}
	if f := facts["claude-haiku-4-5"]; !f.reachable || f.notFound || f.blocked || f.speed != 62.0 || f.ttft != 0.72 {
		t.Errorf("clean row should be reachable with generationTps/ttft, got %+v", f)
	}

	// Not found: the provider disowns the model — a settled negative that may
	// drop it silently.
	stub(`{"model":"anthropic/claude-ghost-9","results":[{"ok":false,"error":"404 {\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"model: claude-ghost-9\"}}"}],"stats":null}`)
	facts, err = runBench([]string{"claude-ghost-9"})
	if err != nil {
		t.Fatalf("notFound: runBench: %v", err)
	}
	if f := facts["claude-ghost-9"]; !f.notFound || f.reachable || f.blocked {
		t.Errorf("a 404 row should be notFound, got %+v", f)
	}

	// Blocked: claude-fable-5-1 is listed AND entitled on this account, and
	// still uncallable because omp advertises Claude Code 2.1.246 while
	// Anthropic wants 2.1.251 for it. Definitive like a 404, but fixable by the
	// operator, so it drops with a warning instead of poisoning the run.
	stub(`{"model":"anthropic/claude-fable-5-1","results":[{"ok":false,"error":"400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Claude Code 2.1.246 does not support this model; version 2.1.251 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.\",\"details\":{\"error_code\":\"claude_code_version_too_old\"}}}"}],"stats":null}`)
	facts, err = runBench([]string{"claude-fable-5-1"})
	if err != nil {
		t.Fatalf("blocked: runBench: %v", err)
	}
	if f := facts["claude-fable-5-1"]; !f.blocked || f.reachable || f.notFound {
		t.Errorf("a client-version gate should be blocked, got %+v", f)
	}

	// Unresolved: a refusal, an exhausted quota or an incomplete row says
	// nothing either way about entitlement, so it is none of the three settled
	// outcomes. The usage-limit row is verbatim from a live run against an
	// exhausted Codex account, and "legacy average only" is the omp 17 shape —
	// pinned as unresolved so a silent schema regression can never again read as
	// a clean probe.
	for _, tc := range []struct{ name, row string }{
		{"refusal", `{"model":"anthropic/x","results":[{"ok":false,"error":"Refusal (cyber): This request triggered restrictions"}],"stats":null}`},
		{"usage limit", `{"model":"openai-codex/x","results":[{"ok":false,"error":"Codex error event: The usage limit has been reached (code=usage_limit_reached)"}],"stats":null}`},
		{"failed run", `{"model":"anthropic/x","results":[{"ok":true},{"ok":false,"error":"stream closed"}],"stats":{"ttftMs":{"mean":1000},"generationTps":{"mean":40}}}`},
		{"no results", `{"model":"anthropic/x","results":[],"stats":{"ttftMs":{"mean":1000},"generationTps":{"mean":40}}}`},
		{"null stats", `{"model":"anthropic/x","results":[{"ok":true}],"stats":null}`},
		{"legacy average only", `{"model":"anthropic/x","results":[{"ok":true}],"failures":0,"average":{"ttftMs":1404.2,"tokensPerSecond":48.94}}`},
	} {
		stub(tc.row)
		facts, err := runBench([]string{"x"})
		if err != nil {
			t.Fatalf("%s: runBench: %v", tc.name, err)
		}
		if f := facts["x"]; f.reachable || f.notFound || f.blocked {
			t.Errorf("%s: must be unresolved, got %+v", tc.name, f)
		}
	}
}

// A skipped model must never cost a probe call. claude-mythos-5 is settled —
// listed by omp, priced like the top rung, and not entitled on this account —
// and its 404 retries were the slowest rows in the report. So it must be absent
// from the selector list the probe is given, and absent from the scaffold even
// when a probe report generously claims it is reachable.
func TestSkippedModelsNeverProbed(t *testing.T) {
	sels, err := benchSelectors([]byte(initJSON))
	if err != nil {
		t.Fatalf("benchSelectors: %v", err)
	}
	for _, s := range sels {
		if strings.Contains(strings.ToLower(s), "mythos") {
			t.Errorf("skipped model offered to the probe: %q", s)
		}
	}

	stubOmp(t, "")
	probe := passingProbe(t, initJSON)
	probe["claude-mythos-5"] = benchFact{reachable: true, speed: 99, ttft: 0.1}
	yml, err := scaffoldModels([]byte(initJSON), probe)
	if err != nil {
		t.Fatalf("scaffoldModels: %v", err)
	}
	if strings.Contains(yml, "claude-mythos-5") {
		t.Errorf("skipped model reached the scaffold:\n%s", yml)
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
			// every other model answers cleanly. Both rows are omp 18.x
			// shaped — with the omp 17 `average`/`failures` shape this test
			// passed for the wrong reason, because EVERY model then parsed as
			// unresolved and the refusal under test proved nothing.
			if strings.HasSuffix(s, "/claude-fable-5") {
				rows = append(rows, fmt.Sprintf(`{"model":%q,"results":[{"ok":false,"error":"Refusal (cyber): blocked under Anthropic's Usage Policy"}],"stats":null}`, s))
				continue
			}
			rows = append(rows, fmt.Sprintf(`{"model":%q,"results":[{"ok":true}],"stats":{"ttftMs":{"mean":1404.2},"generationTps":{"mean":48.94}}}`, s))
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

// A client-version gate must not behave like an inconclusive probe. This is the
// live claude-fable-5-1 case: listed by omp, entitled on the account, and
// refused with 400 claude_code_version_too_old because omp advertises Claude
// Code 2.1.246 while Anthropic requires 2.1.251 for that model. Before this was
// classified, it landed in the unresolved bucket and took the ENTIRE scaffold
// down with it — the operator could not refresh their ladder at all.
//
// So: the run must succeed, the blocked model must be absent from the ladder,
// its family sibling claude-fable-5 must inherit the top rung (the probe filter
// runs before supersede(), so the newer id being dropped leaves the older one
// as the family's survivor), and the file must SAY why — a silent drop would
// leave the operator hunting for a model omp clearly lists.
func TestGenerateInitBlockedModelWarnsAndKeepsSibling(t *testing.T) {
	stubOmp(t, "")
	stubModels(t, initJSONWithFable51)
	prev := ompBenchJSON
	t.Cleanup(func() { ompBenchJSON = prev })
	ompBenchJSON = func(sels []string) ([]byte, error) {
		rows := make([]string, 0, len(sels))
		for _, s := range sels {
			if strings.HasSuffix(s, "/claude-fable-5-1") {
				rows = append(rows, fmt.Sprintf(`{"model":%q,"results":[{"ok":false,"error":"400 invalid_request_error: Claude Code 2.1.246 does not support this model; version 2.1.251 or newer is required (claude_code_version_too_old)"}],"stats":null}`, s))
				continue
			}
			rows = append(rows, fmt.Sprintf(`{"model":%q,"results":[{"ok":true}],"stats":{"ttftMs":{"mean":1404.2},"generationTps":{"mean":48.94}}}`, s))
		}
		return []byte(`{"models":[` + strings.Join(rows, ",") + `]}`), nil
	}
	out := filepath.Join(t.TempDir(), "models.yml")
	if code := runGenerateInit([]string{"--models-file", out}); code != 0 {
		t.Fatalf("a blocked model must not fail the scaffold, exit %d", code)
	}
	body, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	yml := string(body)
	if strings.Contains(yml, "claude-fable-5-1") && !strings.Contains(yml, "# ") {
		t.Errorf("blocked model must not become a rung:\n%s", yml)
	}
	for _, want := range []string{"claude-fable-5-1", "2.1.251"} {
		if !strings.Contains(yml, want) {
			t.Errorf("scaffold must name the blocked model and the required version (%q missing):\n%s", want, yml)
		}
	}
	c, err := loadCatalogBytes(body, out)
	if err != nil {
		t.Fatalf("the scaffold must still render: %v", err)
	}
	if top := c.ladder["A"][c.top("A")]; c.models[top].ID != "claude-fable-5" {
		t.Errorf("top Anthropic rung = %q, want claude-fable-5 to inherit it", c.models[top].ID)
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
// lanes, which lanes may host the spark facet and the elite notch, the vision
// purity exception, and the ds advisor contexts.
func TestThreePoolCatalog(t *testing.T) {
	c, err := catalogFrom(t, fixtureYMLDeepSeek)
	if err != nil {
		t.Fatalf("loadCatalog: %v", err)
	}
	out := c.renderCatalog()

	for _, lane := range []string{"gpt-only", "gpt-led", "mixed", "claude-led", "claude-only", "ds-led", "ds-only"} {
		if !strings.Contains(out, "\n"+lane+"_normal_medium_nosp  ") {
			t.Errorf("lane %s missing from the three-pool grid", lane)
		}
	}
	// The spark facet follows its pool: it is pool O's tier-0 model, so every
	// lane whose pool-set contains O offers it and the two pure lanes that
	// exclude O do not.
	for _, lane := range []string{"gpt-only", "gpt-led", "mixed", "claude-led", "ds-led"} {
		if !strings.Contains(out, "\n"+lane+"_normal_medium_sp  ") {
			t.Errorf("lane %s hosts pool O but generated no spark combo", lane)
		}
	}
	for _, lane := range []string{"claude-only", "ds-only"} {
		if strings.Contains(out, "\n"+lane+"_normal_medium_sp  ") {
			t.Errorf("pure lane %s generated a spark combo it cannot host", lane)
		}
	}
	// The elite notch follows the lane's *lead* pool's ladder depth. Only A
	// declares a tier-4 rung in this fixture, so only the A-led lanes carry it;
	// D stops at tier 3, so the ds lanes get none — an elite combo there would
	// clamp straight back to the pool's best rung.
	for _, lane := range []string{"claude-led", "claude-only"} {
		if !strings.Contains(out, "\n"+lane+"_elite_medium_nosp  ") {
			t.Errorf("lane %s leads on a pool with a tier-4 rung but generated no elite combo", lane)
		}
	}
	for _, lane := range []string{"gpt-only", "gpt-led", "mixed", "ds-led", "ds-only"} {
		if strings.Contains(out, "\n"+lane+"_elite_") {
			t.Errorf("lane %s leads on a pool that stops at tier 3 but generated an elite combo", lane)
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

	// Pure lanes stay pure: nothing on a single-pool lane may reach into
	// DeepSeek (the vision exception below is the one sanctioned crossing).
	for _, lane := range []string{"gpt-only", "claude-only"} {
		if blk := block(lane + "_normal_medium_nosp"); strings.Contains(blk, "deepseek") {
			t.Errorf("pure lane %s crossed into the DeepSeek pool:\n%s", lane, blk)
		}
	}
	// …and the blends do not either: D is nobody's crossing target but its own
	// lanes', so an O- or A-led chain never spills into a third pool.
	for _, lane := range []string{"gpt-led", "mixed", "claude-led"} {
		if blk := block(lane + "_normal_medium_nosp"); strings.Contains(blk, "deepseek") {
			t.Errorf("blend lane %s spilled into the DeepSeek pool:\n%s", lane, blk)
		}
	}

	// Vision purity exception: every DeepSeek rung is text-only, so ds-only's
	// vision role must cross pools rather than route images to a text model.
	dsOnly := block("ds-only_smart_medium_nosp")
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
	blkStart := strings.Index(out, "\nds-only_smart_medium_nosp  ")
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

// ── retired pools ─────────────────────────────────────────────────────────────

// A models file still declaring a retired pool (R was the OpenRouter/Ox Alpha
// stealth pool) must fail loudly at generation with the valid pool letters —
// never silently generate lanes whose models no longer exist.
func TestRetiredPoolRejected(t *testing.T) {
	retired := fixtureYML + `  ox:
    id: stealth/ox-alpha
    pool: R
    tier: 2
    bucket: openrouter-free
    cost_in: 0
    cost_out: 0
    speed: 27.4
    ttft: 2.1
    thinking: low,high
`
	_, err := catalogFrom(t, retired)
	if err == nil || !strings.Contains(err.Error(), `pool must be one of O, A, D, got "R"`) {
		t.Fatalf("retired pool R accepted or misreported: %v", err)
	}
}

// ── ladder depth ─────────────────────────────────────────────────────────────

// Ladder depth is per-pool data, never a constant. Every tier read goes through
// top/rung precisely so a dial or a deliberative bump can ask a shallow pool for
// tier 4 and get that pool's best rung back — the alternative, indexing the
// ladder array directly, hands back the empty model id and silently drops the
// role out of the rendered profile.
func TestLadderDepthTopAndRung(t *testing.T) {
	c := fixtureCatalog(t)
	// The two-pool fixture: A ships a fourth rung, O stops at three, D is absent.
	for pool, want := range map[string]int{"A": 4, "O": 3, "D": 0} {
		if got := c.top(pool); got != want {
			t.Errorf("top(%s) = %d, want %d", pool, got, want)
		}
	}
	for _, tc := range []struct {
		pool string
		tier int
		want string
	}{
		{"A", 4, "claude-fable-5"}, // the deep pool answers tier 4 for real
		{"O", 4, "gpt-5.6-sol"},    // the shallow pool clamps down to its top
		{"O", 9, "gpt-5.6-sol"},    // …however far past its top it is asked
		{"O", 0, "gpt-5.6-luna"},   // and up to the floor: tier 0 is off-ladder
		{"O", -3, "gpt-5.6-luna"},
	} {
		key := c.rung(tc.pool, tc.tier)
		if key == "" {
			t.Errorf("rung(%s, %d) = \"\" — an empty rung drops the role from the profile", tc.pool, tc.tier)
			continue
		}
		if got := c.models[key].ID; got != tc.want {
			t.Errorf("rung(%s, %d) = %q, want %q", tc.pool, tc.tier, got, tc.want)
		}
	}
	// A pool the catalog never declared has no rungs at all, and must say so
	// rather than clamp into another pool's ladder.
	for tier := 0; tier <= 4; tier++ {
		if got := c.rung("D", tier); got != "" {
			t.Errorf("rung(D, %d) = %q, want \"\" for an absent pool", tier, got)
		}
	}
}

// The `elite` notch is gated on the lane's LEAD pool declaring a tier-4 rung,
// not on the lane's whole pool-set. The reason is duplicate suppression: the
// deliberative bump already lands plan/slow/designer/reviewer on the lead
// pool's top rung at `smart`, so where that pool stops at three there is no
// seat left for elite to change and the block renders byte-identical to smart.
// gpt-led is the clean case — proved below by rendering both. mixed is the
// subtle one: pool A is in its pool-set, yet its lead is O, and the only seat
// that would differ is vision (lanePolicy.visionSmart sends images to A, and
// visionLead(A, 4) is the tier-4 rung where visionLead(A, 3) is tier 3). One
// diverging row is not worth a whole grid of near-duplicate blocks, so mixed is
// gated out too — and gating on the pool-set, as an earlier cut did, emitted
// exactly those near-duplicates.
func TestEliteNotchGatedOnLeadPool(t *testing.T) {
	c := fixtureCatalog(t)
	for lane, want := range map[string]bool{
		"claude-only": true, "claude-led": true,
		"gpt-only": false, "gpt-led": false, "mixed": false,
	} {
		if got := c.laneLeadsTier4(lane); got != want {
			t.Errorf("laneLeadsTier4(%s) = %v, want %v", lane, got, want)
		}
		if got := c.genValid(lane, "elite", false); got != want {
			t.Errorf("genValid(%s, elite) = %v, want %v", lane, got, want)
		}
		// The gate is elite-specific: every lane still serves the lower notches.
		for _, mtier := range []string{"fast", "normal", "smart"} {
			if !c.genValid(lane, mtier, false) {
				t.Errorf("genValid(%s, %s) = false, want true", lane, mtier)
			}
		}
	}
	// The suppressed duplicate, demonstrated rather than asserted by fiat: on a
	// lane whose lead pool stops at three, elite and smart differ only in the
	// id and description on the header line.
	smart := c.renderCombo("gpt-led", "smart", "medium", false)
	elite := c.renderCombo("gpt-led", "elite", "medium", false)
	body := func(s string) string {
		_, rest, _ := strings.Cut(s, "\n")
		return rest
	}
	if body(smart) != body(elite) {
		t.Errorf("gpt-led elite should be a byte-identical duplicate of smart:\n--- smart ---\n%s\n--- elite ---\n%s", smart, elite)
	}
	// And the grid honours the gate: no lane the dial cannot offer elite on may
	// carry an elite block. mixed is the case a pool-set gate got wrong.
	out := c.renderCatalog()
	for _, lane := range []string{"gpt-only", "gpt-led", "mixed"} {
		if strings.Contains(out, "\n"+lane+"_elite_") {
			t.Errorf("lane %s must not carry elite combos — its lead pool tops out at tier 3", lane)
		}
	}
	// The spark facet is gated the same way but on its own pool: pure claude
	// lanes host no pool-O tier-0 model, so no spark combo either.
	for lane, want := range map[string]bool{
		"gpt-only": true, "gpt-led": true, "mixed": true, "claude-led": true, "claude-only": false,
	} {
		if got := c.genValid(lane, "normal", true); got != want {
			t.Errorf("genValid(%s, normal, spark) = %v, want %v", lane, got, want)
		}
	}
}

// The two routings the retired `fable` and `fable`+`main` toggles used to
// produce must still be reachable, now as ordinary consequences of the ladder:
// the deliberative bump (t = base+1, capped at the pool's top) puts the tier-4
// rung in the deliberative seats straight from `smart`, and the `elite` notch
// (base = 4) puts it in the `default` seat as well. Losing either is losing the
// routing the toggles existed to reach, with no dial left to ask for it.
func TestTierFourReachableWithoutTheRetiredToggles(t *testing.T) {
	c := fixtureCatalog(t)
	lead := func(lane, mtier, role string) string {
		rt := c.genCombo(lane, mtier, "medium", false)[role]
		if rt.lead == "" {
			t.Fatalf("%s/%s: role %s has no lead", lane, mtier, role)
		}
		return c.models[rt.lead].ID
	}
	// `smart` on an A-led lane: the deliberative bump reaches tier 4 while the
	// non-deliberative seats stay on tier 3. That split is the whole point —
	// the expensive rung goes where the deliberation happens, not everywhere.
	for _, role := range []string{"plan", "slow", "designer", "reviewer", "security-reviewer"} {
		if got := lead("claude-only", "smart", role); got != "claude-fable-5" {
			t.Errorf("claude-only/smart %s = %q, want the tier-4 rung claude-fable-5", role, got)
		}
	}
	for _, role := range []string{"default", "task", "librarian"} {
		if got := lead("claude-only", "smart", role); got != "claude-opus-5" {
			t.Errorf("claude-only/smart %s = %q, want the tier-3 rung claude-opus-5", role, got)
		}
	}
	// The bump also crosses lanes: on mixed the deliberative roles live on pool
	// A, so they reach A's tier 4 while the O-led seats stay on O's tier 3 —
	// this is exactly the block the `fable` toggle used to gate.
	if got := lead("mixed", "smart", "plan"); got != "claude-fable-5" {
		t.Errorf("mixed/smart plan = %q, want claude-fable-5", got)
	}
	if got := lead("mixed", "smart", "default"); got != "gpt-5.6-sol" {
		t.Errorf("mixed/smart default = %q, want gpt-5.6-sol", got)
	}
	// `elite`: the tier-4 rung takes the default seat too — the old fable+main
	// pair. The bump is already saturated, so the deliberative seats do not
	// climb any further.
	for _, role := range []string{"default", "task", "librarian", "plan", "slow", "designer", "reviewer", "security-reviewer", "vision"} {
		if got := lead("claude-only", "elite", role); got != "claude-fable-5" {
			t.Errorf("claude-only/elite %s = %q, want claude-fable-5", role, got)
		}
	}
}

// The utility roles are tier-capped so that no notch of the model dial can make
// a role that runs on every keystroke expensive. `elite` is the notch that
// would have broken that if the cap table had simply been read with a missing
// key: genUtilModel[r]["elite"] would be the zero value, rung() would clamp it
// up to tier 1, and the caps would silently rewrite themselves.
func TestUtilRolesCappedAtTheEliteNotch(t *testing.T) {
	c := fixtureCatalog(t)
	for role, caps := range genUtilModel {
		if _, ok := caps["elite"]; !ok {
			t.Errorf("utility role %q has no elite cap — the dial's top notch would read tier 0", role)
			continue
		}
		if caps["elite"] != caps["smart"] {
			t.Errorf("utility role %q: elite cap %d must equal the smart cap %d", role, caps["elite"], caps["smart"])
		}
	}
	// Rendered, on the one lane that actually reaches tier 4: no utility role
	// may lead on the tier-4 rung, whatever the dial says.
	roles := c.genCombo("claude-only", "elite", "medium", false)
	for _, tc := range []struct{ role, want string }{
		{"scout", "claude-sonnet-5"},
		{"sonic", "claude-sonnet-5"},
		{"smol", "claude-sonnet-5"},
		{"tiny", "claude-sonnet-5"},
		{"commit", "claude-haiku-4-5"},
	} {
		if got := c.models[roles[tc.role].lead].ID; got != tc.want {
			t.Errorf("claude-only/elite %s = %q, want the capped rung %q", tc.role, got, tc.want)
		}
	}
}

// checkLadder used to validate tiers 1..3 only, so a tier-4 rung that regressed
// on the ladder below it loaded clean and became the `elite` notch's routing —
// the exact failure the check exists to prevent, one rung higher. Tier 4 is the
// same capability ladder's top rung, so it is checked like any other.
func TestCheckLadderValidatesTierFour(t *testing.T) {
	const tier4 = `  fable:
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
	base := withoutModel(fixtureYML, "fable")
	for name, replacement := range map[string]string{
		// A dearer top rung with less context than the rungs below it: the
		// price-ranked scaffold's signature mistake.
		"smaller context at a higher price": strings.Replace(tier4, "    context: 1000000\n", "    context: 200000\n", 1),
		// …or with less thinking headroom.
		"lower thinking ceiling at a higher price": strings.Replace(tier4, "    thinking: low→max\n", "    thinking: low→xhigh\n", 1),
	} {
		_, err := catalogFrom(t, base+replacement)
		if err == nil {
			t.Errorf("%s: a regressing tier-4 rung must be rejected", name)
			continue
		}
		if !strings.Contains(err.Error(), "regression") || !strings.Contains(err.Error(), "tier 4") {
			t.Errorf("%s: error must name tier 4 as the regressing rung, got %v", name, err)
		}
	}
	// The healthy fixture's tier-4 rung costs more while matching the ladder on
	// context and thinking, so the widened check must not reject it.
	if _, err := catalogFrom(t, base+tier4); err != nil {
		t.Errorf("healthy tier-4 rung rejected: %v", err)
	}
}
