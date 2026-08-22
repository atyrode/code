package main

// The catalog generator: `code generate` renders the facet-grid catalog the TUI
// browses (see loadBlocks) from a models file, and `code generate init`
// scaffolds that models file from the user's own omp instance.
//
// This began as a Go port of the dotfiles' generate-profiles.py (atyrode/dotfiles,
// pkgs/omp-configured), generalised from that setup's hard-coded model keys to
// pure pool/tier logic so it works against anyone's catalog:
//
//   - pools O (OpenAI/Codex) and A (Anthropic) must each fill tiers 1..3 —
//     the per-pool fallback ladder (cheap, regular, smart). code assumes both
//     providers are present; generation fails loudly otherwise.
//   - pool R (OpenRouter) is optional: a free/aggregator lane. When any R model
//     is declared, its tiers 1..3 must all be filled (a one-model family
//     declares the same id three times with ascending thinking ceilings); when
//     none is, the ox lanes are simply not generated and the TUI never offers
//     them. That presence is the whole on/off switch — no dial of its own.
//   - tier 0 (an idle-bucket speed model, "spark") and tier 4 (a scarce elite,
//     "fable") are optional; without them the corresponding facet combos are
//     simply not generated and the TUI hides the dial.
//
// The dotfiles build now invokes this binary rather than keeping its own copy
// of the renderer, so this file is the single source of the catalog format.

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// ── model catalog ─────────────────────────────────────────────────────────────

type catModel struct {
	ID      string  `yaml:"id"`
	Pool    string  `yaml:"pool"`
	Tier    int     `yaml:"tier"`
	Bucket  string  `yaml:"bucket"`
	CostIn  float64 `yaml:"cost_in"`
	CostOut float64 `yaml:"cost_out"`
	Speed   float64 `yaml:"speed"`
	TTFT    float64 `yaml:"ttft"`
	Context int     `yaml:"context"`
	// "lo→hi" for the usual contiguous case, or a comma list when the model
	// has a hole in the scale (see parseThinkingLevels).
	Thinking string `yaml:"thinking"`
	// Absent means "accepts images" — true of every model in both pools today
	// except the codex spark variants, which `generate init` marks explicitly.
	Image *bool `yaml:"image"`
}

func (m catModel) multimodal() bool { return m.Image == nil || *m.Image }

type catalog struct {
	keys   []string            // declaration order (drives __models__ rows)
	models map[string]catModel // short key -> model
	levels map[string][]int    // short key -> thinking levels it truly offers
	ladder map[string][5]string
	// ladder[pool][tier] for tiers 0..4; "" = absent. Tiers 1..3 are the
	// fallback ladder; 0 is the drain/speed lead, 4 the elite lead.
}

var thScale = []string{"minimal", "low", "medium", "high", "xhigh", "max"}

func thIdx(level string) (int, bool) {
	for i, l := range thScale {
		if l == level {
			return i, true
		}
	}
	return 0, false
}

// loadCatalog parses a models.yml (see `code generate init`) preserving model
// declaration order, and validates the two-pool ladder invariant.
func loadCatalog(path string) (*catalog, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return loadCatalogBytes(raw, path)
}

// loadCatalogBytes is loadCatalog over in-memory content (name only labels
// errors) — the first-run onboarding reviews a scaffold before it hits disk.
func loadCatalogBytes(raw []byte, path string) (*catalog, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if len(doc.Content) == 0 {
		return nil, fmt.Errorf("%s: empty document", path)
	}
	var modelsNode, probedNode *yaml.Node
	root := doc.Content[0]
	for i := 0; i+1 < len(root.Content); i += 2 {
		switch root.Content[i].Value {
		case "models":
			modelsNode = root.Content[i+1]
		case "probed":
			probedNode = root.Content[i+1]
		}
	}
	if modelsNode == nil {
		return nil, fmt.Errorf("%s: no `models:` mapping", path)
	}
	// Reachability is a property of the file, not of the renderer. omp lists
	// models an account cannot actually call and nothing in their metadata says
	// so, and a rung that 404s breaks every profile it leads. `code generate
	// init` sets this once it has probed; an offline scaffold leaves it false.
	if probedNode == nil || probedNode.Value != "true" {
		return nil, fmt.Errorf("%s: missing `probed: true` — these models were never verified as callable by your account. Re-run `code generate init --refresh`, which probes every model, or set `probed: true` yourself once you have confirmed each one", path)
	}
	c := &catalog{models: map[string]catModel{}, levels: map[string][]int{}, ladder: map[string][5]string{"O": {}, "A": {}, "R": {}}}
	for i := 0; i+1 < len(modelsNode.Content); i += 2 {
		key := modelsNode.Content[i].Value
		var m catModel
		if err := modelsNode.Content[i+1].Decode(&m); err != nil {
			return nil, fmt.Errorf("%s: model %q: %w", path, key, err)
		}
		if m.Pool != "O" && m.Pool != "A" && m.Pool != "R" {
			return nil, fmt.Errorf("%s: model %q: pool must be O, A, or R (optional OpenRouter), got %q", path, key, m.Pool)
		}
		if m.Tier < 0 || m.Tier > 4 {
			return nil, fmt.Errorf("%s: model %q: tier must be 0..4, got %d", path, key, m.Tier)
		}
		levels, err := parseThinkingLevels(m.Thinking)
		if err != nil {
			return nil, fmt.Errorf("%s: model %q: %w", path, key, err)
		}
		c.keys = append(c.keys, key)
		c.models[key] = m
		c.levels[key] = levels
		l := c.ladder[m.Pool]
		if l[m.Tier] != "" {
			return nil, fmt.Errorf("%s: pool %s tier %d claimed by both %q and %q", path, m.Pool, m.Tier, l[m.Tier], key)
		}
		l[m.Tier] = key
		c.ladder[m.Pool] = l
	}
	for _, pool := range []string{"O", "A"} {
		for t := 1; t <= 3; t++ {
			if c.ladder[pool][t] == "" {
				return nil, fmt.Errorf("%s: pool %s has no tier-%d model — code assumes both an OpenAI and an Anthropic pool with tiers 1..3 filled (cheap, regular, smart)", path, pool, t)
			}
		}
	}
	// Pool R is all-or-nothing: a half-declared ox ladder would generate lanes
	// whose fallback rungs silently vanish. One-model families declare the same
	// id at every tier with ascending thinking ceilings — that repetition is
	// the encoding, not a mistake.
	if c.hasOxLadderPart() && !c.hasOxLadder() {
		return nil, fmt.Errorf("%s: pool R must fill tiers 1..3 when present — declare the model once per tier with ascending thinking ceilings, or remove the pool entirely", path)
	}
	if err := c.checkLadder(path); err != nil {
		return nil, err
	}
	return c, nil
}

// checkLadder rejects a ladder whose rungs are out of order. Input price used
// to be a fair proxy for capability, so the scaffolder ranked by it — then
// providers started repricing new models below predecessors they never
// delisted, and a $15 claude-opus-4-1 (200k context, no max thinking) outranked
// a $5 claude-opus-5 (1M, max) on price alone. Rather than trust the ranking,
// assert the property it is supposed to produce: a dearer rung must not offer
// less. Only tiers 1..3 are the capability ladder — tier 0 is a bucket-drain
// lead and tier 4 an elite lead, both deliberately off it.
func (c *catalog) checkLadder(path string) error {
	// R joins only when declared; an absent pool has no rungs to compare and
	// the empty-ladder guard below skips it.
	for _, pool := range []string{"O", "A", "R"} {
		for lo := 1; lo <= 3; lo++ {
			for hi := lo + 1; hi <= 3; hi++ {
				a, b := c.ladder[pool][lo], c.ladder[pool][hi]
				if a == "" || b == "" {
					continue
				}
				if why := c.regression(a, b); why != "" {
					return fmt.Errorf("%s: pool %s tier %d (%s) is a regression on tier %d (%s): %s — reorder the tiers, or drop the superseded model and re-run `code generate init --refresh`",
						path, pool, hi, c.models[b].ID, lo, c.models[a].ID, why)
				}
			}
		}
	}
	return nil
}

// hasOxLadder reports whether the optional OpenRouter pool is fully declared.
// The ox lanes exist exactly when this is true — catalog presence is their
// on/off switch.
func (c *catalog) hasOxLadder() bool {
	for t := 1; t <= 3; t++ {
		if c.ladder["R"][t] == "" {
			return false
		}
	}
	return true
}

// hasOxLadderPart reports whether any R model is declared at all. The loader
// pairs it with hasOxLadder to reject half-declared pools.
func (c *catalog) hasOxLadderPart() bool {
	for t := 0; t <= 4; t++ {
		if c.ladder["R"][t] != "" {
			return true
		}
	}
	return false
}

// regression reports why rung hi is worse than the cheaper rung lo, or "" when
// it isn't. A pricier model with more context and more thinking headroom is the
// ladder working; a pricier model with less of either is a stale pick.
func (c *catalog) regression(lo, hi string) string {
	l, h := c.models[lo], c.models[hi]
	if h.CostIn < l.CostIn {
		return "" // cheaper up the ladder is odd but not a capability loss
	}
	if l.Context > 0 && h.Context > 0 && h.Context < l.Context {
		return fmt.Sprintf("%d context at $%s/1M vs %d at $%s", h.Context, trimFloat(h.CostIn), l.Context, trimFloat(l.CostIn))
	}
	ll, hl := c.levels[lo], c.levels[hi]
	if hl[len(hl)-1] < ll[len(ll)-1] {
		return fmt.Sprintf("thinking tops out at %s vs %s, and costs $%s/1M vs $%s", thScale[hl[len(hl)-1]], thScale[ll[len(ll)-1]], trimFloat(h.CostIn), trimFloat(l.CostIn))
	}
	return ""
}

// parseThinkingLevels resolves a thinking declaration to the sorted set of
// levels the model truly offers. Two forms: "lo→hi" for the usual contiguous
// run, and a comma list for a model with a hole in the scale — claude-opus-4-6
// offers low/medium/high/max but not xhigh, and a range would claim a level the
// API rejects.
func parseThinkingLevels(s string) ([]int, error) {
	if strings.Contains(s, ",") {
		var out []int
		for _, part := range strings.Split(s, ",") {
			name := strings.TrimSpace(part)
			i, ok := thIdx(name)
			if !ok {
				return nil, fmt.Errorf("unknown thinking level %q in %q", name, s)
			}
			out = append(out, i)
		}
		sort.Ints(out)
		return out, nil
	}
	parts := strings.Split(s, "→")
	if len(parts) != 2 {
		return nil, fmt.Errorf("thinking must be \"lo→hi\" or a comma list (e.g. low→max, or low,medium,high,max), got %q", s)
	}
	lo, okLo := thIdx(strings.TrimSpace(parts[0]))
	hi, okHi := thIdx(strings.TrimSpace(parts[1]))
	if !okLo || !okHi || lo > hi {
		return nil, fmt.Errorf("invalid thinking range %q", s)
	}
	out := make([]int, 0, hi-lo+1)
	for i := lo; i <= hi; i++ {
		out = append(out, i)
	}
	return out, nil
}

// clampTh resolves a requested level to the nearest one the model actually
// offers, rounding down so a dial never buys more thinking than was asked for.
// A request below the model's floor takes the floor.
func (c *catalog) clampTh(key, level string) string {
	levels := c.levels[key]
	i, _ := thIdx(level)
	best := levels[0]
	for _, l := range levels {
		if l <= i {
			best = l
		}
	}
	return thScale[best]
}

// otherPool is the crossing target for roles that must leave their lead pool:
// the reviewer's independent second eye, the advisor's minimum diversity. O
// and A cross to each other; R crosses to A — the strongest judgment pool,
// which is what every crossing on an ox lane is for.
func otherPool(p string) string {
	if p == "O" || p == "R" {
		return "A"
	}
	return "O"
}

// sibDown is the same-pool fallback rung below a lead: the elite (tier 4)
// falls to its pool's smart tier, tiers 2..3 fall one rung, the rest have no
// same-pool net.
func (c *catalog) sibDown(key string) string {
	m := c.models[key]
	if m.Tier == 4 {
		return c.ladder[m.Pool][3]
	}
	if m.Tier >= 2 {
		return c.ladder[m.Pool][m.Tier-1]
	}
	return ""
}

// cross is the equivalent rung on the opposite pool (elites cross to smart).
func (c *catalog) cross(key string) string {
	m := c.models[key]
	t := m.Tier
	if t > 3 {
		t = 3
	}
	return c.ladder[otherPool(m.Pool)][t]
}

func dedup(seq []string, lead string) []string {
	var out []string
	for _, x := range seq {
		if x == "" || x == lead {
			continue
		}
		dup := false
		for _, o := range out {
			if o == x {
				dup = true
			}
		}
		if !dup {
			out = append(out, x)
		}
	}
	return out
}

func (c *catalog) buildChain(lead string, isPure bool) []string {
	sib := c.sibDown(lead)
	if isPure {
		var sibSib string
		if sib != "" {
			sibSib = c.sibDown(sib)
		}
		return dedup([]string{sib, sibSib}, lead)
	}
	cr := c.cross(lead)
	return dedup([]string{sib, cr, c.sibDown(cr)}, lead)
}

// visionLead returns the requested capability rung when it accepts images.
// If that rung is text-only, prefer a more capable rung before stepping down;
// the model dial must still influence vision without ever routing images to a
// model that cannot consume them.
func (c *catalog) visionLead(pool string, tier int) string {
	for t := tier; t <= 3; t++ {
		if k := c.ladder[pool][t]; k != "" && c.models[k].multimodal() {
			return k
		}
	}
	for t := tier - 1; t >= 1; t-- {
		if k := c.ladder[pool][t]; k != "" && c.models[k].multimodal() {
			return k
		}
	}
	return ""
}

// ── the facet grid ────────────────────────────────────────────────────────────

var (
	genRoleOrder = []string{"default", "task", "plan", "slow", "designer", "reviewer",
		"librarian", "scout", "sonic", "advisor", "vision", "smol", "tiny", "commit"}
	// The bundled agents this grid routes: every ●-marked role is mirrored
	// into task.agentModelOverrides. omp bundles a seventh since 17.2.1,
	// security-reviewer, deliberately unrouted: security scans inject the
	// scan's own model into task.agentModelOverrides per session, so a
	// generated route would only skew ad-hoc spawns. scout was the one this
	// grid never routed, so it silently inherited @smol and never appeared
	// in the preview.
	genAgentRoles = map[string]bool{"designer": true, "librarian": true, "reviewer": true,
		"scout": true, "sonic": true, "task": true}
	genDelib = map[string]bool{"plan": true, "slow": true, "designer": true, "reviewer": true}
	// Anti-tunnel-vision: on a *-led lane the reviewer crosses to the opposite
	// provider so the output always gets an independent second eye (the advisor
	// crosses too, in its own branch).
	genCrossLed = map[string]bool{"reviewer": true}
	genUtil     = map[string]bool{"scout": true, "sonic": true, "smol": true, "tiny": true, "commit": true}
	// Utility roles respond to the dials but are tier-capped so none can ever
	// become expensive.
	genUtilModel = map[string]map[string]int{
		"commit": {"fast": 1, "normal": 1, "smart": 1},
		"tiny":   {"fast": 1, "normal": 1, "smart": 2},
		"smol":   {"fast": 1, "normal": 2, "smart": 2},
		"sonic":  {"fast": 1, "normal": 2, "smart": 2},
		"scout":  {"fast": 1, "normal": 2, "smart": 2},
	}
	genUtilThink = map[string]map[string]string{
		"commit": {"low": "minimal", "medium": "minimal", "high": "minimal", "xhigh": "low"},
		"tiny":   {"low": "minimal", "medium": "low", "high": "low", "xhigh": "low"},
		"smol":   {"low": "low", "medium": "low", "high": "medium", "xhigh": "medium"},
		"sonic":  {"low": "low", "medium": "medium", "high": "medium", "xhigh": "medium"},
		// omp's bundled scout runs at medium; it reads broadly, so it keeps a
		// step more thinking than smol at the same rung.
		"scout": {"low": "low", "medium": "medium", "high": "medium", "xhigh": "medium"},
	}
	genTierMap   = map[string]int{"fast": 1, "normal": 2, "smart": 3}
	genBump      = map[string]string{"minimal": "low", "low": "medium", "medium": "high", "high": "xhigh", "xhigh": "xhigh"}
	genBaseLanes = []string{"gpt-only", "gpt-led", "mixed", "claude-led", "claude-only"}
	genMTiers    = []string{"fast", "normal", "smart"}
	genThinking  = []string{"minimal", "low", "medium", "high", "xhigh", "max"}
	genExtremes  = map[string]bool{"minimal": true, "max": true}
)

func lanePrimary(lane string) string {
	if lane == "ox-only" || lane == "ox-led" {
		return "R"
	}
	if lane == "gpt-only" || lane == "gpt-led" || lane == "mixed" {
		return "O"
	}
	return "A"
}

func lanePure(lane string) bool {
	return lane == "gpt-only" || lane == "claude-only" || lane == "ox-only"
}

// lanes lists the lanes this catalog serves: the five base lanes always, plus
// the ox pair only when the optional OpenRouter ladder is fully declared. This
// is the generator side of the ox on/off switch.
func (c *catalog) lanes() []string {
	if !c.hasOxLadder() {
		return genBaseLanes
	}
	return append(append([]string{}, genBaseLanes...), "ox-only", "ox-led")
}

type roleRoute struct {
	lead  string // short key; "" = role omitted (advisor off)
	level string
	chain []string // short keys; chain levels tracked separately
	chLvl []string
}

// genCombo computes {role -> route} for one facet combination. A direct port
// of generate-profiles.py's gen(), with the hard-coded model keys generalised
// to pool/tier lookups.
func (c *catalog) genCombo(lane, mtier, thinking string, spark, fable, fableMain bool) map[string]roleRoute {
	p := lanePrimary(lane)
	base := genTierMap[mtier]
	isPure := lanePure(lane)
	extreme := genExtremes[thinking]
	sparkKey := c.ladder["O"][0]
	eliteKey := c.ladder["A"][4]

	rprov := func(r string) string {
		if isPure {
			return p
		}
		if lane == "mixed" {
			if genDelib[r] {
				return "A"
			}
			return "O"
		}
		// ox-led keeps the free pool on everything high-volume (workers,
		// utility, vision) and spends the paid judgment where it pays:
		// deliberative roles cross to Anthropic. The reviewer crossing below
		// lands there too, which still satisfies the anti-tunnel-vision rule —
		// the second eye never shares the lead's pool.
		if lane == "ox-led" && genDelib[r] {
			return "A"
		}
		if genCrossLed[r] {
			return otherPool(p)
		}
		return p
	}

	out := map[string]roleRoute{}
	for _, r := range genRoleOrder {
		if genUtil[r] {
			rp := rprov(r)
			t := genUtilModel[r][mtier]
			th := thinking
			if !extreme {
				th = genUtilThink[r][thinking]
			}
			sparkHere := spark && sparkKey != "" &&
				(r == "tiny" || r == "commit" || (r == "sonic" && mtier == "fast"))
			var lead string
			var fb []string
			if sparkHere {
				lead = sparkKey
				if !extreme {
					th = "low"
				}
				fb = []string{c.ladder[rp][t]}
			} else {
				lead = c.ladder[rp][t]
				// scout and sonic are spawned constantly and block their caller,
				// so they keep a net; the rest are cheap enough to just retry.
				if r == "sonic" || r == "scout" {
					if sd := c.sibDown(lead); sd != "" {
						fb = []string{sd}
					}
				}
			}
			chain := dedup(fb, lead)
			out[r] = roleRoute{lead, th, chain, repeatLvl(th, len(chain))}
			continue
		}
		if r == "vision" {
			// omp falls back @vision → @default → active model when it needs an
			// image described, and describeForTextModels is on by default — so
			// this rung must be a model that actually accepts images. Vision
			// follows the model tier; mixed smart prefers Claude's smart rung.
			vp := p
			if lane == "mixed" && mtier == "smart" {
				vp = "A"
			}
			lead := c.visionLead(vp, base)
			if lead == "" && !isPure {
				lead = c.visionLead(otherPool(vp), base)
			}
			if lead == "" {
				out[r] = roleRoute{}
				continue
			}
			// Describing an image is not a reasoning task; keep it cheap unless
			// the dial sits at an extreme, where the operator asked for uniformity.
			th := "low"
			if extreme {
				th = thinking
			}
			var chain []string
			for _, k := range c.buildChain(lead, isPure) {
				if c.models[k].multimodal() {
					chain = append(chain, k)
				}
			}
			out[r] = roleRoute{lead, th, chain, repeatLvl(th, len(chain))}
			continue
		}
		if r == "advisor" {
			if mtier == "fast" {
				out[r] = roleRoute{}
				continue
			}
			// The advisor leads on the opposite provider whenever the lane
			// allows crossing — the minimum diversity guarantee.
			ap := p
			if !isPure {
				ap = otherPool(p)
			}
			amod := c.ladder[ap][1]
			if mtier == "smart" {
				amod = c.ladder[ap][2]
			}
			lvl, fbl := thinking, thinking
			if !extreme {
				fbl = "low"
				if mtier == "smart" {
					lvl = "high"
				} else {
					lvl = "low"
				}
			}
			chain := c.buildChain(amod, isPure)
			out[r] = roleRoute{amod, lvl, chain, repeatLvl(fbl, len(chain))}
			continue
		}
		rp := rprov(r)
		t := base
		if genDelib[r] {
			t = base + 1
			if t > 3 {
				t = 3
			}
		}
		th := thinking
		if !extreme && genDelib[r] {
			th = genBump[thinking]
		}
		// The elite leads the deliberative Claude roles when on — gated to the
		// smart/normal tiers. fable-as-main is an override: the elite takes the
		// default role on every tier, regardless of lane preference.
		fableHere := fable && eliteKey != "" &&
			((fableMain && r == "default") ||
				(genDelib[r] && rp == "A" && (mtier == "smart" || mtier == "normal")))
		lead := c.ladder[rp][t]
		if fableHere {
			lead = eliteKey
		}
		chain := c.buildChain(lead, isPure)
		out[r] = roleRoute{lead, th, chain, repeatLvl(th, len(chain))}
	}
	return out
}

func repeatLvl(lvl string, n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = lvl
	}
	return out
}

func genComboID(lane, mtier, thinking string, spark, fable, fableMain bool) string {
	sp, fa := "nosp", "nofa"
	if spark {
		sp = "sp"
	}
	if fable {
		fa = "fa"
		if fableMain {
			fa = "famain"
		}
	}
	return fmt.Sprintf("%s_%s_%s_%s_%s", lane, mtier, thinking, sp, fa)
}

func genValid(lane string, spark, fable, fableMain bool) bool {
	if lane == "gpt-only" && fable {
		return false // no elite on pure GPT
	}
	if lane == "claude-only" && spark {
		return false // no spark on pure Claude
	}
	if lane == "ox-only" && (spark || fable) {
		return false // a pure ox lane has no O drain bucket or A elite to lead with
	}
	if lane == "ox-led" && (spark || fableMain) {
		return false // utility already lives on the free pool; fable-as-main would defeat the lane
	}
	if fableMain && !fable {
		return false // fable-as-main only exists on top of fable
	}
	return true
}

// ── rendering (byte-compatible with generate-profiles.py) ────────────────────

func (c *catalog) renderCombo(lane, mtier, thinking string, spark, fable, fableMain bool) string {
	roles := c.genCombo(lane, mtier, thinking, spark, fable, fableMain)
	cid := genComboID(lane, mtier, thinking, spark, fable, fableMain)
	desc := []string{lane, mtier, thinking}
	if spark {
		desc = append(desc, "spark")
	}
	if fable {
		desc = append(desc, "fable")
	}
	if fable && fableMain {
		desc = append(desc, "main")
	}
	lines := []string{fmt.Sprintf("%s  %s", cid, strings.Join(desc, " · "))}
	advOn := roles["advisor"].lead != ""
	adv := "off"
	if advOn {
		adv = "on"
	}
	lines = append(lines, fmt.Sprintf("  thinking %s · fallback on · advisor %s", thinking, adv))
	for _, r := range genRoleOrder {
		rt := roles[r]
		if rt.lead == "" {
			continue
		}
		marker := " "
		if genAgentRoles[r] {
			marker = "●"
		}
		model := fmt.Sprintf("%s:%s", c.models[rt.lead].ID, c.clampTh(rt.lead, rt.level))
		row := fmt.Sprintf("  %s %-10s %-24s", marker, r, model)
		prev := model
		for i, m := range rt.chain {
			tok := fmt.Sprintf("%s:%s", c.models[m].ID, c.clampTh(m, rt.chLvl[i]))
			if tok == prev {
				continue // sibling rungs of a one-model family can clamp to the same level
			}
			prev = tok
			row += " → " + tok
		}
		lines = append(lines, strings.TrimRight(row, " "))
	}
	lines = append(lines, "")
	return strings.Join(lines, "\n")
}

// renderModelFacts emits the per-model table the TUI's meters read. The bucket
// is a trailing optional column: the consumer falls back to guessing from the
// model family when a catalog omits it. The pool column after it is the
// authoritative provider prefix for launched configs, replacing that same
// name heuristic wherever present — this renderer always writes it, but both
// columns are optional on the parsing side, so catalogs and binaries of mixed
// age keep working together.
func (c *catalog) renderModelFacts() string {
	lines := []string{"__models__  model facts (id in out speed ttft [bucket] [pool] — $/1M in·out, tok/s, s)"}
	for _, k := range c.keys {
		m := c.models[k]
		row := fmt.Sprintf("  %s %s %s %s %s",
			m.ID, trimFloat(m.CostIn), trimFloat(m.CostOut), trimFloat(m.Speed), trimFloat(m.TTFT))
		if m.Bucket != "" {
			row += " " + m.Bucket
		}
		row += " " + m.Pool
		lines = append(lines, row)
	}
	lines = append(lines, "")
	return strings.Join(lines, "\n")
}

// trimFloat formats like Python's str() on YAML numbers: integers bare, floats
// with their decimals.
func trimFloat(f float64) string {
	if f == float64(int64(f)) {
		return fmt.Sprintf("%d", int64(f))
	}
	return strings.TrimRight(fmt.Sprintf("%f", f), "0")
}

// renderAdvisors emits the advisor dial table. Chains are tier-derived per
// pool: glance = [t1:low], review = [t2:medium, t1:low],
// audit = [t3:high, t2:high, t1:low].
func (c *catalog) renderAdvisors() string {
	type rung struct {
		tier int
		lvl  string
	}
	dial := []struct {
		level string
		chain []rung
	}{
		{"glance", []rung{{1, "low"}}},
		{"review", []rung{{2, "medium"}, {1, "low"}}},
		{"audit", []rung{{3, "high"}, {2, "high"}, {1, "low"}}},
	}
	lines := []string{"__advisors__  advisor dial (level context → chain)"}
	advisorContexts := []struct{ name, pool string }{{"gpt", "O"}, {"claude", "A"}}
	if c.hasOxLadder() {
		advisorContexts = append(advisorContexts, struct{ name, pool string }{"ox", "R"})
	}
	for _, ctx := range advisorContexts {
		for _, d := range dial {
			var parts []string
			for _, rg := range d.chain {
				k := c.ladder[ctx.pool][rg.tier]
				parts = append(parts, fmt.Sprintf("%s:%s", c.models[k].ID, c.clampTh(k, rg.lvl)))
			}
			lines = append(lines, fmt.Sprintf("  %s %s %s", d.level, ctx.name, strings.Join(parts, " → ")))
		}
	}
	lines = append(lines, "")
	return strings.Join(lines, "\n")
}

// renderCatalog produces the complete generated.plain byte stream.
func (c *catalog) renderCatalog() string {
	var b strings.Builder
	b.WriteString("OMP generated routing — first-principles facet grid\n")
	// Derived, not retyped: this legend named five agents while genAgentRoles
	// carried six, so the grid marked a scout row the header denied existed.
	var agents []string
	for _, r := range genRoleOrder {
		if genAgentRoles[r] {
			agents = append(agents, r)
		}
	}
	b.WriteString("agent-backed roles: " + strings.Join(agents, " ") +
		" — ● marks a role mirrored into task.agentModelOverrides\n\n")
	b.WriteString(c.renderAdvisors() + "\n")
	b.WriteString(c.renderModelFacts() + "\n")
	hasSpark := c.ladder["O"][0] != ""
	hasElite := c.ladder["A"][4] != ""
	for _, lane := range c.lanes() {
		for _, mtier := range genMTiers {
			for _, thinking := range genThinking {
				for _, spark := range []bool{true, false} {
					if spark && !hasSpark {
						continue
					}
					for _, fable := range []bool{true, false} {
						if fable && !hasElite {
							continue
						}
						for _, fableMain := range []bool{false, true} {
							if genValid(lane, spark, fable, fableMain) {
								b.WriteString(c.renderCombo(lane, mtier, thinking, spark, fable, fableMain) + "\n")
							}
						}
					}
				}
			}
		}
	}
	return b.String()
}

// ── CLI ───────────────────────────────────────────────────────────────────────

func defaultModelsPath() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, "code", "models.yml")
}

func defaultCatalogPath() string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "share")
	}
	return filepath.Join(base, "code", "generated.plain")
}

// runGenerate implements `code generate [init]`. Returns a process exit code.
func runGenerate(args []string) int {
	if len(args) > 0 && args[0] == "init" {
		return runGenerateInit(args[1:])
	}
	modelsFile, out := defaultModelsPath(), defaultCatalogPath()
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--models-file":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "code generate: --models-file needs a path")
				return 2
			}
			modelsFile = args[i]
		case "--out":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "code generate: --out needs a path (or - for stdout)")
				return 2
			}
			out = args[i]
		case "-h", "--help":
			fmt.Print(generateHelp)
			return 0
		default:
			fmt.Fprintf(os.Stderr, "code generate: unknown flag %q\n%s", args[i], generateHelp)
			return 2
		}
	}
	cat, err := loadCatalog(modelsFile)
	if err != nil {
		if os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "code generate: no models file at %s — run `code generate init` first (or pass --models-file)\n", modelsFile)
			return 1
		}
		fmt.Fprintf(os.Stderr, "code generate: %v\n", err)
		return 1
	}
	rendered := cat.renderCatalog()
	if out == "-" {
		fmt.Print(rendered)
		return 0
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "code generate: %v\n", err)
		return 1
	}
	if err := os.WriteFile(out, []byte(rendered), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "code generate: %v\n", err)
		return 1
	}
	fmt.Printf("wrote %s (%d combos, %d models)\n", out, strings.Count(rendered, "\n\n")-2, len(cat.keys))
	return 0
}

const generateHelp = `code generate — render the facet-grid catalog the TUI browses

  code generate init [--models-file OUT] [--refresh] [--from-json FILE]
      Scaffold a models file from your omp instance. Reads 'omp models --json'
      and 'omp usage --json', then probes every candidate with 'omp bench' to
      confirm your account can actually call it — omp lists models it cannot,
      and nothing in their metadata says so. Only verified models become rungs,
      and the file is marked 'probed: true' so 'code generate' will accept it.
      The probe makes one real request per model, so this takes a minute.
      Derives the pool/tier assignments — review them!

      --refresh    re-derive the tiers over an existing models file. Without it
                   init refuses to touch one, so a months-old scaffold keeps
                   naming models your providers have since retired.
      --from-json  read the model list from FILE instead of omp, and skip the
                   probe. Offline inspection only: the result is marked
                   'probed: false' and 'code generate' will refuse to render it.

  code generate [--models-file FILE] [--out FILE|-]
      Render the catalog. Defaults: models file at
      $XDG_CONFIG_HOME/code/models.yml, output at
      $XDG_DATA_HOME/code/generated.plain (the TUI's fallback when
      CODE_GENERATED is unset).
`
