package main

// The provider registry: the single table every provider-aware code path
// consults. Adding a provider is a new entry here (plus a lane pool letter);
// nothing else in the tree may hard-code a provider id, pool letter, model
// prefix, bucket name, or brand color.

import "strings"

const (
	anthropicProvider  = "anthropic"
	openAIProvider     = "openai-codex"
	deepseekProvider   = "deepseek"
	openRouterProvider = "openrouter"
)

// specialFacet is a provider's tier-scoped lead: a facet dial ("spark",
// "fable") that swaps a dedicated ladder tier in as a role lead, drawing a
// separate quota bucket.
type specialFacet struct {
	Facet  string // facet key: "spark" | "fable"
	Tier   int    // ladder index: 0 | 4
	Bucket string // bucket suffix; full name = BucketBase + "-" + Bucket
}

type providerDesc struct {
	ID            string     // broker/omp provider id
	Aliases       []string   // extra omp ids mapping to the same pool
	Pool          string     // catalog pool letter
	Lane          string     // lane-name segment used in lane facet values
	Label         string     // UI label (product name: Codex, Claude, DeepSeek)
	AccountLabel  string     // account-manager heading (company name: OpenAI, Anthropic)
	Color         string     // UI heading hex
	LaneOnly      string     // deeper shade for the pure "<lane>-only" lane
	LaneLed       string     // lighter shade for the "<lane>-led" lane
	PaintRGB      [3]float64 // routing-token tint base (paintModel)
	ModelPrefixes []string   // model-id prefix matchers (legacy-catalog fallback)
	BucketBase    string     // bucket name base; main bucket = BucketBase + "-main"
	Metered       bool       // false => no quota windows; never gates launches
	Required      bool       // generate-init: must fill tiers 1..3, else hard error
	StrictLadder  bool       // optional-pool ladder must be complete when declared (no nearest-rung borrow)
	CrossTo       string     // pool this pool's crossing roles divert to (reviewer, advisor)
	SkeletonWins  []string   // usage-panel loading skeleton windows; nil when unmetered
	Special       []specialFacet
	ServiceTier   [2]string // omp overlay `tier:` key/value when the `fast` facet is on
}

// providerRegistry order is the account/usage display order (Claude first,
// matching the established Usage panel). Generator-side pool iteration uses
// fallbackPoolOrder instead, so the two orders are independent knobs.
var providerRegistry = []providerDesc{
	{ID: anthropicProvider, Pool: "A", Lane: "claude", Label: "Claude", AccountLabel: "Anthropic",
		Color: "#ff9f52", LaneOnly: "#ff8534", LaneLed: "#ffb277", PaintRGB: [3]float64{240, 160, 105},
		ModelPrefixes: []string{"claude", "sonnet", "haiku", "opus"}, BucketBase: "claude",
		Metered: true, Required: true, CrossTo: "O",
		SkeletonWins: []string{"5h", "7d", "7d fable"},
		Special:      []specialFacet{{Facet: "fable", Tier: 4, Bucket: "fable"}}},
	{ID: openAIProvider, Aliases: []string{"openai"}, Pool: "O", Lane: "gpt", Label: "Codex", AccountLabel: "OpenAI",
		Color: "#62a7ff", LaneOnly: "#3f8ef0", LaneLed: "#7ab6ff", PaintRGB: [3]float64{110, 170, 240},
		ModelPrefixes: []string{"gpt", "codex"}, BucketBase: "codex",
		Metered: true, Required: true, CrossTo: "A",
		SkeletonWins: []string{"5h", "7d"},
		Special:      []specialFacet{{Facet: "spark", Tier: 0, Bucket: "spark"}},
		ServiceTier:  [2]string{"openai", "priority"}},
	{ID: deepseekProvider, Pool: "D", Lane: "ds", Label: "DeepSeek", AccountLabel: "DeepSeek",
		Color: "#4d6bfe", LaneOnly: "#3a55f0", LaneLed: "#7d92ff", PaintRGB: [3]float64{77, 107, 254},
		ModelPrefixes: []string{"deepseek"}, BucketBase: "deepseek", CrossTo: "O"},
	{ID: openRouterProvider, Pool: "R", Lane: "ox", Label: "Ox Alpha", AccountLabel: "OpenRouter",
		Color: "#5fce96", LaneOnly: "#1f9d5b", LaneLed: "#5fce96", PaintRGB: [3]float64{95, 206, 150},
		ModelPrefixes: []string{"stealth/ox-alpha"}, BucketBase: "openrouter",
		StrictLadder: true, CrossTo: "A"},
}

// fallbackPoolOrder is the generator-side pool order: non-lead pools appear in
// fallback chains (and cross-provider role dispatch) in this order.
var fallbackPoolOrder = []string{"O", "A", "D", "R"}

// advisorPoolOrder decides the advisor's context: the first entry that is not
// the lead pool (pure lanes keep their own pool).
var advisorPoolOrder = []string{"A", "O", "D", "R"}

// providerByID matches a provider id or alias; nil when unknown.
func providerByID(id string) *providerDesc {
	for i := range providerRegistry {
		p := &providerRegistry[i]
		if p.ID == id {
			return p
		}
		for _, a := range p.Aliases {
			if a == id {
				return p
			}
		}
	}
	return nil
}

func providerByPool(pool string) *providerDesc {
	for i := range providerRegistry {
		if providerRegistry[i].Pool == pool {
			return &providerRegistry[i]
		}
	}
	return nil
}

// providerByModel resolves a model id by its longest matching prefix; nil when
// no provider claims it. It is the legacy-catalog fallback — catalogs now
// carry an explicit provider column that wins over this guess.
func providerByModel(modelID string) *providerDesc {
	var best *providerDesc
	bestLen := 0
	for i := range providerRegistry {
		for _, pre := range providerRegistry[i].ModelPrefixes {
			if len(pre) > bestLen && strings.HasPrefix(modelID, pre) {
				best, bestLen = &providerRegistry[i], len(pre)
			}
		}
	}
	return best
}

// providerByLane maps a lane facet value ("gpt-only", "ds-led") to its
// provider; nil for "mixed" or an unknown lane.
func providerByLane(lane string) *providerDesc {
	seg, _, ok := strings.Cut(lane, "-")
	if !ok {
		return nil
	}
	for i := range providerRegistry {
		if providerRegistry[i].Lane == seg {
			return &providerRegistry[i]
		}
	}
	return nil
}

// providerBySpecial finds the provider owning a special-tier facet ("spark",
// "fable"); nil when no provider declares it.
func providerBySpecial(facet string) *providerDesc {
	for i := range providerRegistry {
		for _, s := range providerRegistry[i].Special {
			if s.Facet == facet {
				return &providerRegistry[i]
			}
		}
	}
	return nil
}

// special returns the provider's special-tier declaration for a facet.
func (p *providerDesc) special(facet string) *specialFacet {
	for i := range p.Special {
		if p.Special[i].Facet == facet {
			return &p.Special[i]
		}
	}
	return nil
}

// mainBucket is the provider's ordinary quota window name.
func (p *providerDesc) mainBucket() string { return p.BucketBase + "-main" }

// buckets lists every quota bucket the provider draws: main first, then each
// special tier's window.
func (p *providerDesc) buckets() []string {
	out := []string{p.mainBucket()}
	for _, s := range p.Special {
		out = append(out, p.BucketBase+"-"+s.Bucket)
	}
	return out
}

// meteredProviderIDs lists the quota-windowed providers in registry (display)
// order — the providers the usage panel, skeleton, and launch gating track.
func meteredProviderIDs() []string {
	var out []string
	for i := range providerRegistry {
		if providerRegistry[i].Metered {
			out = append(out, providerRegistry[i].ID)
		}
	}
	return out
}

// optionalPoolLabels names the pay-as-you-go pools ("DeepSeek"), joined for
// display — the pools relief can spill into.
func optionalPoolLabels() string {
	var out []string
	for i := range providerRegistry {
		if !providerRegistry[i].Required {
			out = append(out, providerRegistry[i].Label)
		}
	}
	return strings.Join(out, "/")
}

// poolDeclaresSpecialTier reports whether the pool's provider declares a
// special facet at the given ladder tier (O's spark at 0, A's fable at 4).
func poolDeclaresSpecialTier(pool string, tier int) bool {
	p := providerByPool(pool)
	if p == nil {
		return false
	}
	for _, s := range p.Special {
		if s.Tier == tier {
			return true
		}
	}
	return false
}

// requiredPoolLanes is the lane list over just the Required pools — the
// classic five-lane dial, and the pre-catalog default.
func requiredPoolLanes() []string {
	var pools []string
	for _, pool := range fallbackPoolOrder {
		if p := providerByPool(pool); p != nil && p.Required {
			pools = append(pools, pool)
		}
	}
	return laneOrderForPools(pools)
}

// lanePure reports whether a lane is a single-pool lane.
func lanePure(lane string) bool { return strings.HasSuffix(lane, "-only") }

// laneHasPool reports whether a lane's pool-set contains the pool: a pure lane
// hosts only its own pool; every other lane (led, mixed) hosts all pools.
func laneHasPool(lane, pool string) bool {
	if !lanePure(lane) {
		return true
	}
	p := providerByLane(lane)
	return p != nil && p.Pool == pool
}

// laneReliefApplies reports whether relief tails are a real choice on this
// lane: a metered-led blend can spill into a pay-as-you-go pool, so the
// relief dial exists there. Pure lanes never take tails, and a lane led by
// the optional pool already spends it deliberately.
func laneReliefApplies(lane string) bool {
	if lanePure(lane) {
		return false
	}
	if p := providerByLane(lane); p != nil && !p.Required {
		return false
	}
	return true
}

// laneBlends is the blend dial's canonical order: led (the lead pool drives
// everything), lean (the lead pool keeps the deliberative work and drains the
// rest elsewhere), only (pure). A lead offers the subset its catalog serves.
var laneBlends = []string{"led", "lean", "only"}

// laneSplit decomposes a lane into the two dials the TUI renders: the lead
// (a provider's lane segment, or "mixed") and the blend ("led" | "lean" |
// "only" — the lane's suffix). mixed has no blend of its own; it reports
// "led" so a later lead change lands on the -led lane.
func laneSplit(lane string) (lead, blend string) {
	if lane == "mixed" {
		return "mixed", "led"
	}
	lead = lane
	blend = "led"
	if seg, suffix, ok := strings.Cut(lane, "-"); ok {
		lead, blend = seg, suffix
	}
	if p := providerByLane(lane); p != nil {
		lead = p.Lane
	}
	return lead, blend
}

// laneJoin is laneSplit's inverse: the canonical lane a lead+blend pair names.
func laneJoin(lead, blend string) string {
	if lead == "mixed" {
		return "mixed"
	}
	return lead + "-" + blend
}

// laneAvailable reports whether the connected credentials can serve the lane:
// a pure lane needs only its own provider, every blend needs the pools its
// policy leads roles on plus the Required pools its chains cross into. An
// optional pool nobody logged into therefore blocks exactly its own lanes —
// never the blends between the providers that are connected.
func laneAvailable(lane string, connected map[string]bool) bool {
	pol, known := genLanePolicies[lane]
	if !known {
		// A lane this binary predates: require its own provider (if named)
		// and the Required pools — the conservative reading of a blend.
		if p := providerByLane(lane); p != nil {
			if lanePure(lane) {
				return connected[p.Pool]
			}
			if !connected[p.Pool] {
				return false
			}
		}
	} else {
		if pol.pure {
			return connected[pol.primary]
		}
		for _, pool := range []string{pol.primary, pol.delib, pol.util, pol.vision, pol.visionSmart} {
			if pool != "" && !connected[pool] {
				return false
			}
		}
	}
	for i := range providerRegistry {
		if providerRegistry[i].Required && !connected[providerRegistry[i].Pool] {
			return false
		}
	}
	return true
}

// laneHostsSpecial reports whether a special-tier facet ("spark", "fable") can
// be on for the lane: its provider's pool must be in the lane's pool-set.
func laneHostsSpecial(lane, facet string) bool {
	p := providerBySpecial(facet)
	return p != nil && laneHasPool(lane, p.Pool)
}

// laneOrderForPools is the canonical lane-dial order over the given pools
// (subset of fallbackPoolOrder, in that order): the first pool's pure lane
// leads, mixed sits in the middle, the second pool mirrors, and every further
// pool appends its led/only pair.
func laneOrderForPools(pools []string) []string {
	var lanes []string
	name := func(pool string) string { return providerByPool(pool).Lane }
	if len(pools) == 0 {
		return nil
	}
	lanes = append(lanes, name(pools[0])+"-only", name(pools[0])+"-led")
	if len(pools) > 1 {
		lanes = append(lanes, "mixed", name(pools[1])+"-led", name(pools[1])+"-only")
	}
	for _, pool := range pools[2:] {
		lanes = append(lanes, name(pool)+"-led", name(pool)+"-only")
	}
	return lanes
}
