package main

// The catalog generator: `code generate` renders the facet-grid catalog the TUI
// browses (see loadBlocks) from a models file, and `code generate init`
// scaffolds that models file from the user's own omp instance.
//
// This began as a Go port of the dotfiles' generate-profiles.py (atyrode/dotfiles,
// pkgs/omp-configured), generalised from that setup's hard-coded model keys to
// pure pool/tier logic so it works against anyone's catalog:
//
//   - required pools (see providerRegistry: O = OpenAI/Codex, A = Anthropic)
//     must each fill tiers 1..3 — the per-pool fallback ladder (cheap,
//     regular, smart); generation fails loudly otherwise. Optional pools
//     participate when present: D (DeepSeek, pay-as-you-go) needs one
//     verified rung — missing tiers borrow the nearest existing one. An
//     absent optional pool's lanes are simply not generated and the TUI
//     never offers them; catalog presence is the whole on/off switch.
//   - tier 4 is the optional top rung of that same capability ladder. Pools
//     ladder to different depths (see catalog.top) — one provider ships a
//     fourth model, another stops at three, a third may ship its own fourth
//     later — and the model dial's `elite` notch reaches tier 4 wherever a
//     pool declares one. Requests for a rung a pool does not have clamp to
//     its best (see catalog.rung), and a lane whose pools all stop at three
//     gets no elite combo at all: it would be byte-identical to smart.
//   - tier 0 (an idle-bucket speed model, "spark") is off the capability
//     ladder entirely — it is a quota-bucket drain lead, picked for speed,
//     not capability. It is optional; without it the spark facet combos are
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
	// ladder[pool][tier] for tiers 0..4; "" = absent. Tiers 1..4 are the
	// capability/fallback ladder, of per-pool depth (see top); 0 is the
	// bucket-drain lead, deliberately off that ladder.
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
	ladder := map[string][5]string{}
	for _, p := range providerRegistry {
		ladder[p.Pool] = [5]string{}
	}
	c := &catalog{models: map[string]catModel{}, levels: map[string][]int{}, ladder: ladder}
	for i := 0; i+1 < len(modelsNode.Content); i += 2 {
		key := modelsNode.Content[i].Value
		var m catModel
		if err := modelsNode.Content[i+1].Decode(&m); err != nil {
			return nil, fmt.Errorf("%s: model %q: %w", path, key, err)
		}
		if providerByPool(m.Pool) == nil {
			return nil, fmt.Errorf("%s: model %q: pool must be one of %s, got %q", path, key, strings.Join(fallbackPoolOrder, ", "), m.Pool)
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
	for _, pool := range fallbackPoolOrder {
		prov := providerByPool(pool)
		if !prov.Required {
			continue
		}
		for t := 1; t <= 3; t++ {
			if c.ladder[pool][t] == "" {
				return nil, fmt.Errorf("%s: pool %s has no tier-%d model — code assumes %s with tiers 1..3 filled (cheap, regular, smart)", path, pool, t, requiredProviderNames())
			}
		}
	}
	c.fillOptionalLadders()
	if err := c.checkLadder(path); err != nil {
		return nil, err
	}
	return c, nil
}

// requiredProviderNames names the pools generation cannot proceed without —
// the registry's Required providers, joined for error text.
func requiredProviderNames() string {
	var names []string
	for _, pool := range fallbackPoolOrder {
		if p := providerByPool(pool); p != nil && p.Required {
			names = append(names, p.Label)
		}
	}
	return "both " + strings.Join(names, " and ") + " pools"
}

// pools lists the catalog's usable pools in fallbackPoolOrder: a pool is
// present once tiers 1..3 are filled (fillOptionalLadders completes partial
// optional pools first, so one verified rung is enough to participate).
func (c *catalog) pools() []string {
	var out []string
	for _, pool := range fallbackPoolOrder {
		l := c.ladder[pool]
		if l[1] != "" && l[2] != "" && l[3] != "" {
			out = append(out, pool)
		}
	}
	return out
}

// fillOptionalLadders completes a non-Required pool that brought at least one
// ladder rung but not all three: each missing tier borrows the nearest
// existing rung, preferring the lower tier index. Chain dedupe absorbs the
// duplicates, so a one-model pool still yields working lanes.
func (c *catalog) fillOptionalLadders() {
	for _, p := range providerRegistry {
		if p.Required {
			continue
		}
		l := c.ladder[p.Pool]
		if l[1] == "" && l[2] == "" && l[3] == "" {
			continue
		}
		for t := 1; t <= 3; t++ {
			if l[t] != "" {
				continue
			}
			for _, s := range []int{t - 1, t + 1, t - 2, t + 2} {
				if s >= 1 && s <= 3 && l[s] != "" {
					l[t] = l[s]
					break
				}
			}
		}
		c.ladder[p.Pool] = l
	}
}

// top is a pool's highest non-empty capability rung (1..4), or 0 when the pool
// brought no ladder at all. Ladder depth is per-pool data, never a constant:
// providers ship their fourth model on their own schedule, so every tier read
// asks the catalog how deep the pool goes instead of assuming.
func (c *catalog) top(pool string) int {
	l := c.ladder[pool]
	for t := 4; t >= 1; t-- {
		if l[t] != "" {
			return t
		}
	}
	return 0
}

// rung reads a pool's ladder with the requested tier clamped into what that
// pool actually has. Lanes and dials ask for tiers, not models: a deliberative
// bump or the `elite` notch can ask a pool for tier 4 when that pool only
// ladders to 3, and the answer must be that pool's best rung — never the empty
// model id, which would silently drop a role out of a rendered profile.
func (c *catalog) rung(pool string, tier int) string {
	t := c.top(pool)
	if t == 0 {
		return ""
	}
	if tier > t {
		tier = t
	}
	if tier < 1 {
		tier = 1
	}
	return c.ladder[pool][tier]
}

// checkLadder rejects a ladder whose rungs are out of order. Input price used
// to be a fair proxy for capability, so the scaffolder ranked by it — then
// providers started repricing new models below predecessors they never
// delisted, and a $15 claude-opus-4-1 (200k context, no max thinking) outranked
// a $5 claude-opus-5 (1M, max) on price alone. Rather than trust the ranking,
// assert the property it is supposed to produce: a dearer rung must not offer
// less. Tiers 1..4 are one capability ladder — tier 4 is simply its optional
// top rung, so it must not regress on tier 3 either. Tier 0 stays off the
// ladder: it is a bucket-drain lead chosen for speed, not for capability.
func (c *catalog) checkLadder(path string) error {
	// Optional pools join only when declared; an absent pool has no rungs to
	// compare and the empty-rung guard below skips it.
	for _, pool := range fallbackPoolOrder {
		for lo := 1; lo <= 4; lo++ {
			for hi := lo + 1; hi <= 4; hi++ {
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
// the reviewer's independent second eye, the advisor's minimum diversity.
// Declared per provider in the registry (providerDesc.CrossTo): O and A cross
// to each other, D crosses to O.
func otherPool(p string) string {
	if d := providerByPool(p); d != nil {
		return d.CrossTo
	}
	return ""
}

// specialKey resolves a special-tier facet ("spark") to its ladder rung — ""
// when the owning pool never filled that tier. Special tiers sit outside the
// capability ladder, so this indexes the ladder directly rather than via rung:
// an absent special tier must read as absent, not clamp to a capability rung.
func (c *catalog) specialKey(facet string) string {
	p := providerBySpecial(facet)
	if p == nil {
		return ""
	}
	return c.ladder[p.Pool][p.special(facet).Tier]
}

// advisorPool picks the advisor's context pool: the first advisorPoolOrder
// entry present in the catalog that is not the lead pool.
func (c *catalog) advisorPool(lead string) string {
	present := map[string]bool{}
	for _, p := range c.pools() {
		present[p] = true
	}
	for _, p := range advisorPoolOrder {
		if p != lead && present[p] {
			return p
		}
	}
	return lead
}

// sibDown is the same-pool fallback rung below a lead: tier 2 and up fall one
// rung, tier 1 and the off-ladder tier 0 have no same-pool net.
func (c *catalog) sibDown(key string) string {
	m := c.models[key]
	if m.Tier >= 2 {
		return c.rung(m.Pool, m.Tier-1)
	}
	return ""
}

// cross is the equivalent rung on the crossing target pool, clamped to that
// pool's own depth: the target may ladder deeper or shallower than the source,
// so a top-rung lead crosses to tier 4 where the target has one and to the
// target's best rung where it does not.
func (c *catalog) cross(key string) string {
	m := c.models[key]
	cp := otherPool(m.Pool)
	if cp == "" {
		return ""
	}
	return c.rung(cp, m.Tier)
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
// Both scans index the ladder directly rather than through rung: here an empty
// rung must read as absent so the walk continues, where rung would clamp.
func (c *catalog) visionLead(pool string, tier int) string {
	for t := tier; t <= 4; t++ {
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

// visionCross finds an image-capable rung on any other catalog pool, in
// fallbackPoolOrder — vision correctness beats lane purity, so even a pure
// lane crosses when its own pool is text-only at every rung.
func (c *catalog) visionCross(pool string, tier int) string {
	for _, p := range c.pools() {
		if p == pool {
			continue
		}
		if k := c.visionLead(p, tier); k != "" {
			return k
		}
	}
	return ""
}

// ── the facet grid ────────────────────────────────────────────────────────────

var (
	genRoleOrder = []string{"default", "task", "plan", "slow", "reviewer",
		"security-reviewer", "librarian", "scout", "sonic", "advisor", "vision", "smol", "tiny", "commit"}
	// The bundled agents this grid routes: every ●-marked role is mirrored
	// into task.agentModelOverrides. security-reviewer gets reviewer's exact
	// routing membership; note `omp security` still injects the scan's own
	// model into task.agentModelOverrides at runtime, superseding this value
	// inside that workflow — the catalog route covers ad-hoc spawns.
	genAgentRoles = map[string]bool{"librarian": true, "reviewer": true,
		"security-reviewer": true, "scout": true, "sonic": true, "task": true}
	genDelib = map[string]bool{"plan": true, "slow": true,
		"reviewer": true, "security-reviewer": true}
	// Anti-tunnel-vision: on a *-led lane the reviewers cross to the opposite
	// provider so the output always gets an independent second eye (the advisor
	// crosses too, in its own branch).
	genCrossLed = map[string]bool{"reviewer": true, "security-reviewer": true}
	genUtil     = map[string]bool{"scout": true, "sonic": true, "smol": true, "tiny": true, "commit": true}
	// Utility roles respond to the dials but are tier-capped so none can ever
	// become expensive. `elite` therefore shares `smart`'s cap exactly: the cap
	// exists so that no notch of the model dial — not even the top one — can
	// make a role that runs on every keystroke cost real money.
	genUtilModel = map[string]map[string]int{
		"commit": {"fast": 1, "normal": 1, "smart": 1, "elite": 1},
		"tiny":   {"fast": 1, "normal": 1, "smart": 2, "elite": 2},
		"smol":   {"fast": 1, "normal": 2, "smart": 2, "elite": 2},
		"sonic":  {"fast": 1, "normal": 2, "smart": 2, "elite": 2},
		"scout":  {"fast": 1, "normal": 2, "smart": 2, "elite": 2},
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
	genTierMap   = map[string]int{"fast": 1, "normal": 2, "smart": 3, "elite": 4}
	genBump      = map[string]string{"minimal": "low", "low": "medium", "medium": "high", "high": "xhigh", "xhigh": "xhigh"}
	genBaseLanes = []string{"gpt-only", "gpt-led", "mixed", "claude-led", "claude-only"}
	genMTiers    = []string{"fast", "normal", "smart", "elite"}
	genThinking  = []string{"minimal", "low", "medium", "high", "xhigh", "max"}
	genExtremes  = map[string]bool{"minimal": true, "max": true}
)

// lanePolicy is a lane's whole role-mapping, as data. primary answers for
// default/task/librarian; delib hosts plan/slow/reviewer ("" = the
// primary); visionSmart overrides the image rung's pool at the top of the model
// dial (smart or elite — mixed prefers Claude's top rung there). pure lanes
// never cross: reviewer and advisor stay in-primary.
//
// This table is the whole generator's sense of "a lane". A new setup — a new
// pool pairing, a new emphasis — is a row here, not new branches in genCombo;
// keep it that way. The reviewer always ends up off its lead pool unless the
// lane is pure (the anti-tunnel-vision rule), and the advisor leads on the
// minimum-diversity pool (delib when set, else the crossing target).
type lanePolicy struct {
	primary     string
	delib       string
	visionSmart string
	pure        bool
}

var genLanePolicies = map[string]lanePolicy{
	"gpt-only":    {primary: "O", pure: true},
	"gpt-led":     {primary: "O"},
	"mixed":       {primary: "O", delib: "A", visionSmart: "A"},
	"claude-led":  {primary: "A"},
	"claude-only": {primary: "A", pure: true},
	// DeepSeek lanes: pay-as-you-go capacity. The blend lane leads the work
	// and lets reviewers cross to GPT; the pure lane is text-only end to end,
	// so vision alone borrows an image-capable pool.
	"ds-led":  {primary: "D"},
	"ds-only": {primary: "D", pure: true},
}

func (p lanePolicy) pool(role string) string {
	if p.pure {
		return p.primary
	}
	if genDelib[role] && p.delib != "" {
		return p.delib
	}
	if genCrossLed[role] {
		return otherPool(p.primary)
	}
	return p.primary
}

// lanes lists the lanes this catalog serves: the five base lanes always, plus
// each optional pool's lanes once its ladder qualifies — the ds pair when a
// DeepSeek ladder participates (one verified rung suffices). This is the
// generator side of each optional pool's on/off switch. Order follows the
// dial: base lanes first, optional-pool lanes appended.
func (c *catalog) lanes() []string {
	out := append([]string{}, genBaseLanes...)
	present := map[string]bool{}
	for _, p := range c.pools() {
		present[p] = true
	}
	if present["D"] {
		out = append(out, "ds-led", "ds-only")
	}
	return out
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
func (c *catalog) genCombo(lane, mtier, thinking string, spark bool) map[string]roleRoute {
	pol := genLanePolicies[lane]
	p := pol.primary
	base := genTierMap[mtier]
	isPure := pol.pure
	extreme := genExtremes[thinking]
	sparkKey := c.specialKey("spark")

	// Roles that used to branch on mtier == "smart" branch on this instead:
	// the top of the model dial now has two notches, and both mean "the
	// operator asked for capability", so neither may fall through to the cheap
	// arm that fast/normal take.
	topDial := base >= 3

	rprov := func(r string) string {
		return pol.pool(r)
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
				fb = []string{c.rung(rp, t)}
			} else {
				lead = c.rung(rp, t)
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
			vp := p
			if topDial && pol.visionSmart != "" {
				vp = pol.visionSmart
			}
			lead := c.visionLead(vp, base)
			if lead == "" {
				// No image-capable rung on the lead pool at all: cross pools
				// even on a pure lane — vision correctness beats lane purity.
				lead = c.visionCross(vp, base)
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
				ap = c.advisorPool(p)
			}
			amod := c.rung(ap, 1)
			if topDial {
				amod = c.rung(ap, 2)
			}
			lvl, fbl := thinking, thinking
			if !extreme {
				fbl = "low"
				if topDial {
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
			// The deliberative bump: one rung above the dial, capped at the
			// pool's own top. On a pool that ladders to 4 this is how a
			// deliberative role reaches the top rung straight from the `smart`
			// notch — the routing the retired elite-lead toggle produced by hand.
			t = base + 1
			if top := c.top(rp); t > top {
				t = top
			}
		}
		th := thinking
		if !extreme && genDelib[r] {
			th = genBump[thinking]
		}
		lead := c.rung(rp, t)
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

func genComboID(lane, mtier, thinking string, spark bool) string {
	sp := "nosp"
	if spark {
		sp = "sp"
	}
	return fmt.Sprintf("%s_%s_%s_%s", lane, mtier, thinking, sp)
}

// genValid rejects facet combos the lane cannot host. The spark facet is valid
// only when its provider's pool is in the lane's pool-set — a pure lane hosts
// only its own pool.
//
// The `elite` notch is gated on the lane's LEAD pool, not its whole pool-set,
// and the distinction is not pedantic: the deliberative bump (t = base+1,
// capped at the pool's top rung) already hands plan/slow/reviewer the
// tier-4 rung at `smart`, which is precisely the routing the retired `fable`
// toggle used to produce. So on a lane led by a pool that tops out at 3, every
// seat elite could change is already saturated at `smart`. On gpt-led and
// gpt-only that makes elite render byte-identical to smart. On mixed one seat
// does diverge — its visionSmart override points at A, so the vision role would
// lead on the tier-4 rung — but a whole notch of the model dial whose only
// effect is which model describes an image is not a routing choice worth
// offering, and it would carry a full grid of otherwise-identical blocks.
// What elite genuinely means is "put the lead pool's best model in the lead
// seats", so it exists only where the lead pool has a fourth rung to give.
func (c *catalog) genValid(lane, mtier string, spark bool) bool {
	if spark && !laneHostsSpecial(lane, "spark") {
		return false // no spark outside its pool's lanes
	}
	if mtier == "elite" && !c.laneLeadsTier4(lane) {
		return false // elite would duplicate smart where the lead tops out at 3
	}
	return true
}

// laneLeadsTier4 reports whether the lane's lead pool declares a top rung at
// tier 4. Pool-generic on purpose: a second provider shipping a fourth model
// lights up its own lanes' elite notch with no code change here.
func (c *catalog) laneLeadsTier4(lane string) bool {
	pol, ok := genLanePolicies[lane]
	if !ok {
		return false
	}
	return c.ladder[pol.primary][4] != ""
}

// ── rendering (byte-compatible with generate-profiles.py) ────────────────────

func (c *catalog) renderCombo(lane, mtier, thinking string, spark bool) string {
	roles := c.genCombo(lane, mtier, thinking, spark)
	cid := genComboID(lane, mtier, thinking, spark)
	desc := []string{lane, mtier, thinking}
	if spark {
		desc = append(desc, "spark")
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

// renderModelFacts emits the per-model table the TUI's meters read: seven
// fixed columns — id, pricing, speed, ttft, quota bucket, provider id. The
// provider column is the authoritative provider for launched configs,
// replacing the name heuristic wherever present. Old catalogs with five- or
// six-column rows still parse; the consumer falls back to guessing bucket and
// provider from the model family for those.
func (c *catalog) renderModelFacts() string {
	lines := []string{"__models__  model facts (id in out speed ttft bucket provider — $/1M in·out, tok/s, s)"}
	for _, k := range c.keys {
		m := c.models[k]
		prov := providerByPool(m.Pool)
		bucket := m.Bucket
		if bucket == "" {
			bucket = prov.mainBucket()
		}
		row := fmt.Sprintf("  %s %s %s %s %s %s %s",
			m.ID, trimFloat(m.CostIn), trimFloat(m.CostOut), trimFloat(m.Speed), trimFloat(m.TTFT),
			bucket, prov.ID)
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
	for _, pool := range c.pools() {
		ctx := struct{ name, pool string }{providerByPool(pool).Lane, pool}
		for _, d := range dial {
			var parts []string
			for _, rg := range d.chain {
				k := c.rung(ctx.pool, rg.tier)
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
	hasSpark := c.specialKey("spark") != ""
	for _, lane := range c.lanes() {
		for _, mtier := range genMTiers {
			for _, thinking := range genThinking {
				for _, spark := range []bool{true, false} {
					if spark && !hasSpark {
						continue
					}
					if c.genValid(lane, mtier, spark) {
						b.WriteString(c.renderCombo(lane, mtier, thinking, spark) + "\n")
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
