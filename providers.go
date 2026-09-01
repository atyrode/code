package main

// The provider registry: the single table every provider-aware code path
// consults. Adding a provider is a new entry here (plus a lane pool letter);
// nothing else in the tree may hard-code a provider id, pool letter, model
// prefix, bucket name, or brand color.

import (
	"strings"
	"time"
)

const (
	anthropicProvider = "anthropic"
	openAIProvider    = "openai-codex"
	deepseekProvider  = "deepseek"
)

// localProvider is the lane for a model served on this machine (locallane.go).
// The id lives here because this is where provider ids are spelled, and
// nowhere else may spell one.
//
// It is deliberately not a providerRegistry entry. Every field of a
// providerDesc is about a hosted pool — a catalog pool letter, a quota bucket,
// a lane blend other pools' chains cross into, an account the manager logs in
// to — and this lane has none of them: its models come from the endpoint
// rather than the catalog, it bills nothing, and it blends with nothing. An
// entry would put a phantom pool into every pool iteration in the tree to
// describe a lane that is not one of them.
const localProvider = "local"

// specialFacet is a provider's tier-scoped lead: a facet dial ("spark") that
// swaps a dedicated ladder tier in as a role lead, drawing a separate quota
// bucket.
//
// Only the idle-drain shape remains. Anthropic's scarce elite used to be one of
// these (facet "fable", tier 4, its own "7d fable" quota window); Anthropic
// retired that window, so the model is now simply the top rung of pool A's
// ordinary ladder and the "elite" notch on the model dial reaches it. Nothing
// about it is special any more — which is why no fable-shaped entry exists here.
type specialFacet struct {
	Facet  string // facet key: "spark"
	Tier   int    // ladder index: 0
	Bucket string // bucket suffix; full name = BucketBase + "-" + Bucket
}

// offPeakDiscount is a pay-as-you-go pool's clock-based price break, in minutes
// past UTC midnight. The window wraps when StartMin > EndMin (DeepSeek's runs
// 16:30 through 00:30). It lives here rather than in the meter because it is a
// fact about a provider's billing, and the registry is where provider facts are
// spelled — a second pool with a discount window is a field, not a new branch.
type offPeakDiscount struct {
	StartMin, EndMin int
	Mult             float64
}

// active reports whether utc falls inside the window.
func (o offPeakDiscount) active(utc time.Time) bool {
	m := utc.Hour()*60 + utc.Minute()
	if o.StartMin > o.EndMin {
		return m >= o.StartMin || m < o.EndMin
	}
	return m >= o.StartMin && m < o.EndMin
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
	OAuth         bool       // provider supports interactive `omp auth-broker login`
	Required      bool       // generate-init: must fill tiers 1..3, else hard error
	CrossTo       string     // pool this pool's crossing roles divert to (reviewer, advisor)
	SkeletonWins  []string   // usage-panel loading skeleton windows; nil when unmetered
	Special       []specialFacet
	ServiceTier   [2]string        // omp overlay `tier:` key/value when the `fast` facet is on
	OffPeak       *offPeakDiscount // clock-based price break; nil when the pool bills flat
}

// providerRegistry order is the account/usage display order (Claude first,
// matching the established Usage panel). Generator-side pool iteration uses
// fallbackPoolOrder instead, so the two orders are independent knobs.
var providerRegistry = []providerDesc{
	{ID: anthropicProvider, Pool: "A", Lane: "claude", Label: "Claude", AccountLabel: "Anthropic",
		Color: "#ff9f52", LaneOnly: "#ff8534", LaneLed: "#ffb277", PaintRGB: [3]float64{240, 160, 105},
		ModelPrefixes: []string{"claude", "sonnet", "haiku", "opus"}, BucketBase: "claude",
		Metered: true, OAuth: true, Required: true, CrossTo: "O",
		SkeletonWins: []string{"5h", "7d"}},
	{ID: openAIProvider, Aliases: []string{"openai"}, Pool: "O", Lane: "gpt", Label: "Codex", AccountLabel: "OpenAI",
		Color: "#62a7ff", LaneOnly: "#3f8ef0", LaneLed: "#7ab6ff", PaintRGB: [3]float64{110, 170, 240},
		ModelPrefixes: []string{"gpt", "codex"}, BucketBase: "codex",
		Metered: true, OAuth: true, Required: true, CrossTo: "A",
		SkeletonWins: []string{"5h", "7d"},
		Special:      []specialFacet{{Facet: "spark", Tier: 0, Bucket: "spark"}},
		ServiceTier:  [2]string{"openai", "priority"}},
	{ID: deepseekProvider, Pool: "D", Lane: "ds", Label: "DeepSeek", AccountLabel: "DeepSeek",
		Color: "#4d6bfe", LaneOnly: "#3a55f0", LaneLed: "#7d92ff", PaintRGB: [3]float64{77, 107, 254},
		ModelPrefixes: []string{"deepseek"}, BucketBase: "deepseek", CrossTo: "O",
		// UTC 16:30–00:30, half price (deepseek.com/pricing).
		OffPeak: &offPeakDiscount{StartMin: 16*60 + 30, EndMin: 30, Mult: 0.5}},
}

// fallbackPoolOrder is the generator-side pool order: non-lead pools appear in
// fallback chains (and cross-provider role dispatch) in this order.
var fallbackPoolOrder = []string{"O", "A", "D"}

// advisorPoolOrder decides the advisor's context: the first entry that is not
// the lead pool (pure lanes keep their own pool).
var advisorPoolOrder = []string{"A", "O", "D"}

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

// poolDeclaresSpecialTier reports whether the pool's provider declares a
// special facet at the given ladder tier (O's spark at 0).
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

// laneBlends is the blend dial's canonical order: led (the lead pool drives
// everything), only (pure). A lead offers the subset its catalog serves.
var laneBlends = []string{"led", "only"}

// laneSplit decomposes a lane into the two dials the TUI renders: the lead
// (a provider's lane segment, or "mixed") and the blend ("led" | "only" —
// the lane's suffix). mixed has no blend of its own; it reports
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
		for _, pool := range []string{pol.primary, pol.delib, pol.visionSmart} {
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
//
// A single pool yields only its own pure pair: there is nothing to blend with,
// so "mixed" and every further pair are absent. That case is reachable by
// editing the registry down to one Required provider — the extension the file
// header promises — so the tail slice is taken inside the len > 1 branch rather
// than as pools[2:], which panics on a one-pool slice.
func laneOrderForPools(pools []string) []string {
	if len(pools) == 0 {
		return nil
	}
	name := func(pool string) string { return providerByPool(pool).Lane }
	lanes := []string{name(pools[0]) + "-only", name(pools[0]) + "-led"}
	if len(pools) > 1 {
		lanes = append(lanes, "mixed", name(pools[1])+"-led", name(pools[1])+"-only")
		for _, pool := range pools[2:] {
			lanes = append(lanes, name(pool)+"-led", name(pool)+"-only")
		}
	}
	return lanes
}

// poolServiceTier returns the pool's provider's omp `tier:` overlay key/value,
// and whether it declares one at all. The `fast` dial is exactly "ask every
// pool that sells a priority tier for it", so every call site that used to test
// pool == "O" asks this instead: a second provider gaining a tier is then a
// registry field, as the file header promises, not another literal.
func poolServiceTier(pool string) ([2]string, bool) {
	p := providerByPool(pool)
	if p == nil || p.ServiceTier[0] == "" {
		return [2]string{}, false
	}
	return p.ServiceTier, true
}

// laneServiceTiers lists the omp `tier:` overlays the lane's pools sell, in
// registry order. Empty means the `fast` dial buys nothing on this lane.
func laneServiceTiers(lane string) [][2]string {
	var out [][2]string
	for i := range providerRegistry {
		p := providerRegistry[i]
		if p.ServiceTier[0] == "" || !laneHasPool(lane, p.Pool) {
			continue
		}
		out = append(out, p.ServiceTier)
	}
	return out
}

// poolOffPeak returns the pool's clock-based discount multiplier for utc, or 1
// when the pool bills flat or the window is closed.
func poolOffPeak(pool string, utc time.Time) float64 {
	p := providerByPool(pool)
	if p == nil || p.OffPeak == nil || !p.OffPeak.active(utc) {
		return 1
	}
	return p.OffPeak.Mult
}
