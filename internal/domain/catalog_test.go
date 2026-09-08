package domain

import (
	"testing"
	"strings"
	"fmt"
)

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

func catalogFrom(t *testing.T,yml string)(*catalog,error){t.Helper();return loadCatalogBytes([]byte(yml),"fixture")}
func fixtureCatalog(t *testing.T) *catalog {
	t.Helper()
	c, err := catalogFrom(t, fixtureYML)
	if err != nil {
		t.Fatalf("loadCatalog: %v", err)
	}
	return c
}
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
	}
	// The healthy fixture's tier-4 rung costs more while matching the ladder on
	// context and thinking, so the widened check must not reject it.
	if _, err := catalogFrom(t, base+tier4); err != nil {
		t.Errorf("healthy tier-4 rung rejected: %v", err)
	}
}
