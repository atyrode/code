package main

import (
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"
	"time"

	clikit "github.com/atyrode/cli-kit"
)

// ── cost + speed meters ──────────────────────────────────────────────────────
// A profile's price and pace are dominated by the models on its heaviest roles,
// so each role is weighted by the token volume it drives over a session: the
// default agent and its task sub-agents move the needle; commit/tiny barely
// register — so the top rung on a commit role stays cheap while the same rung
// leading the default agent is dear (and slow). Per role, cost blends
// input+output pricing while speed reads the model's effective throughput
// (tok/s folded with time-to-first-token — see effTPS); both
// scale with thinking effort (more reasoning = pricier + slower) and take OpenAI's
// priority tier under fast mode (pricier but quicker). The weighted averages map
// onto 1..5 log scales (both perceived multiplicatively), calibrated across every
// valid facet × advisor × fast combination. Every role the generator emits must
// appear here: weightedModels silently skips a role it cannot weigh, so an
// omission drops that model out of both meters with no trace.
var roleWeight = map[string]float64{
	"default": 10, "task": 6, "reviewer": 3, "sonic": 3, "plan": 3, "advisor": 4, "slow": 2,
	"designer": 2, "librarian": 2, "scout": 2, "smol": 1, "tiny": 0.5, "commit": 0.5, "vision": 0.5,
	// security-reviewer routes like reviewer but is spawned far more rarely
	// (ad-hoc scans), so it barely moves the needle.
	"security-reviewer": 1,
}
var thinkMult = map[string]float64{ // reasoning tokens grow with effort → pricier
	"minimal": 0.6, "low": 0.8, "medium": 1.0, "high": 1.3, "xhigh": 1.6, "max": 2.0,
}
var thinkSpeed = map[string]float64{ // more reasoning before the answer → slower
	"minimal": 1.4, "low": 1.2, "medium": 1.0, "high": 0.8, "xhigh": 0.65, "max": 0.5,
}

const (
	priorityMult = 1.9 // OpenAI priority tier costs more under fast mode …
	fastSpeed    = 1.3 // … but responds quicker
)

// Ln endpoints of the grid-wide min/max weighted indices, calibrated over every
// valid facet × advisor × fast combination (cost dear→ high, speed fast→ high).
const (
	costLnLo, costLnHi   = 1.27, 4.42
	speedLnLo, speedLnHi = 2.49, 4.20
)

// weightedModels walks the current config's rows and calls fn(weight, id, level)
// for each role's lead model — the shared basis for both meters.
// currentRows is the routing block the cost/speed meters score: the generator's
// facet combo with the advisor dial applied.
func (m model) currentRows() []string {
	return m.filterRows(m.applyAdvisor(m.generated[comboID(m.sel)], m.sel["advisor"]))
}

func (m model) weightedModels(rows []string, fn func(w float64, id, lvl string)) {
	for _, r := range rows {
		f := strings.Fields(strings.ReplaceAll(r, "→", " "))
		i := 0
		if len(f) > 0 && f[0] == "●" {
			i = 1
		}
		if i >= len(f) {
			continue
		}
		w, ok := roleWeight[f[i]]
		if !ok {
			continue
		}
		var lead string
		for _, t := range f[i+1:] {
			if modelRe.MatchString(t) {
				lead = t
				break
			}
		}
		id, lvl, _ := strings.Cut(lead, ":")
		if id != "" {
			fn(w, id, lvl)
		}
	}
}

func logScore(idx, lnLo, lnHi float64) int {
	s := 1 + 4*(math.Log(idx)-lnLo)/(lnHi-lnLo)
	return int(math.Round(math.Max(1, math.Min(5, s))))
}

// DeepSeek discounts the pay-as-you-go API during its off-peak window,
// UTC 16:30–00:30 (deepseek.com/pricing). The meter prices D rungs by the
// clock so a cheap window reads as the discount it is. offPeakNow is a var
// for tests only.
const deepseekOffPeakMult = 0.5

var offPeakNow = time.Now

func deepseekOffPeak(utc time.Time) bool {
	m := utc.Hour()*60 + utc.Minute()
	return m >= 16*60+30 || m < 30
}

// costScore rates the current config from 1 (cheap) to 5 (dear).
func (m model) costScore() int {
	if _, ok := m.selectedRuntime(); ok {
		return 1
	}
	fast := m.sel["fast"] == "on" && laneHasPool(m.sel["lane"], "O")
	var num, den float64
	m.weightedModels(m.currentRows(), func(w float64, id, lvl string) {
		c, ok := m.facts[id]
		if !ok {
			return
		}
		mult, ok := thinkMult[lvl]
		if !ok {
			mult = 1
		}
		cost := (0.25*c.in + 0.75*c.out) * mult
		if fast && m.poolOfModel(id) == "O" {
			cost *= priorityMult
		}
		if m.poolOfModel(id) == "D" && deepseekOffPeak(offPeakNow().UTC()) {
			cost *= deepseekOffPeakMult
		}
		num += w * cost
		den += w
	})
	if den == 0 {
		return 1
	}
	return logScore(num/den, costLnLo, costLnHi)
}

// speedScore rates the current config from 1 (slow) to 5 (fast).
func (m model) speedScore() int {
	if _, ok := m.selectedRuntime(); ok {
		return 3
	}
	fast := m.sel["fast"] == "on" && laneHasPool(m.sel["lane"], "O")
	var num, den float64
	m.weightedModels(m.currentRows(), func(w float64, id, lvl string) {
		c, ok := m.facts[id]
		if !ok || c.speed == 0 {
			return
		}
		mult, ok := thinkSpeed[lvl]
		if !ok {
			mult = 1
		}
		sp := c.effTPS() * mult
		if fast && m.poolOfModel(id) == "O" {
			sp *= fastSpeed
		}
		num += w * sp
		den += w
	})
	if den == 0 {
		return 3
	}
	return logScore(num/den, speedLnLo, speedLnHi)
}

// meter renders a labelled 1..5 scale — n glyphs in the fill colour, the rest in
// the dim "empty" colour — always five glyphs so the fill (and the headroom) read
// at a glance.
func (m model) meter(label, glyph, fill string, n int) string {
	return clikit.Meter(label, glyph, fill, n)
}

// advisorChain returns the advisor role's model chain for an intensity, sourced
// from the baked __advisors__ table. The advisor is the independent second
// opinion, so it crosses to another provider whenever the lane allows it: the
// first advisorPoolOrder pool that is not the lead's. Only the pure lanes stay
// on their own provider.
func (m model) advisorChain(level string) []string {
	lane := m.sel["lane"]
	if p := providerByLane(lane); p != nil && lanePure(lane) {
		return m.advisors[level+"/"+p.Lane]
	}
	lead := genLanePolicies[m.sel["lane"]].primary
	for _, pool := range advisorPoolOrder {
		if pool == lead {
			continue
		}
		p := providerByPool(pool)
		if p == nil {
			continue
		}
		chain := m.advisors[level+"/"+p.Lane]
		if len(chain) == 0 {
			continue
		}
		return chain
	}
	return nil
}

// roleOf returns the role name of a routing row ("● task" → "task").
func roleOf(row string) string {
	f := strings.Fields(row)
	if len(f) > 0 && f[0] == "●" {
		f = f[1:]
	}
	if len(f) > 0 {
		return f[0]
	}
	return ""
}

// applyAdvisor replaces the baked advisor row with one synthesised from the
// chosen intensity (dropping it entirely when off), so the generated preview and
// the launched config both reflect the advisor facet.
func (m model) applyAdvisor(rows []string, level string) []string {
	chain := m.advisorChain(level)
	newRow := ""
	if len(chain) > 0 {
		newRow = "    advisor    " + strings.Join(chain, " → ")
	}
	var out []string
	replaced := false
	for _, r := range rows {
		if roleOf(r) == "advisor" {
			replaced = true
			if newRow != "" {
				out = append(out, newRow)
			}
			continue
		}
		out = append(out, r)
	}
	if !replaced && newRow != "" {
		out = append(out, newRow)
	}
	return out
}

// visibleFacets drops facets that don't apply to the current lane, so the
// generator only ever shows actionable options: no spark/fast on a pure lane
// of another pool. A dial value this catalog generated no combo for is dropped
// the same way — it is not a choice. That is what narrows the model dial: pool
// ladders are variable-depth, so a lane whose pools stop at tier 3 carries no
// elite combo and must not show the notch.
//
// The lane facet renders as two rows: lead (one segment per pool, plus mixed)
// and blend (led | only, hidden for mixed). sel["lane"] stays the canonical
// value — lead/blend are derived here and recomposed by cycleFacet, and are
// never persisted (saveSelectionState filters on m.facets, which carries only
// "lane").
func (m model) visibleFacets() []facet {
	// A local model answers every role, so the hosted dials — lane, tier,
	// advisor, spark — describe nothing about this run and are
	// taken off screen, exactly as a delegated runtime target takes them off.
	// The thinking dial stays, narrowed to what a local endpoint can honestly
	// be asked for (locallane.go).
	if _, on := m.selectedLocalModel(); on {
		var out []facet
		for _, f := range m.facets {
			switch f.key {
			case localFacetKey:
				out = append(out, f)
			case "thinking":
				out = append(out, facet{key: f.key, values: localThinkingLevels, glyph: f.glyph})
			}
		}
		return out
	}
	if _, local := m.selectedRuntime(); local {
		var out []facet
		for _, f := range m.facets {
			if f.key == "runtime" || f.key == "thinking" {
				out = append(out, f)
			}
		}
		return out
	}
	if m.noProviders {
		// The local lane needs no provider credential, so it is the one dial a
		// machine with no connected provider still has a use for: hiding it
		// would leave the ceremony with nothing to confirm on a host that can
		// in fact run an analysis.
		for _, f := range m.facets {
			if f.key == localFacetKey {
				return []facet{f}
			}
		}
		return nil
	}
	lane := m.sel["lane"]
	var out []facet
	for _, f := range m.facets {
		if f.key == "lane" {
			lead, blend := laneSplit(lane)
			m.sel["lead"], m.sel["blend"] = lead, blend
			var leads []string
			seen := map[string]bool{}
			for _, v := range f.values {
				if v == "mixed" {
					leads = append(leads, "mixed")
					seen["mixed"] = true
					break
				}
			}
			for _, v := range f.values {
				l, _ := laneSplit(v)
				if !seen[l] {
					seen[l] = true
					leads = append(leads, l)
				}
			}
			out = append(out, facet{"lead", leads, f.glyph})
			if lead != "mixed" {
				availableBlends := map[string]bool{}
				for _, v := range f.values {
					l, b := laneSplit(v)
					if l == lead {
						availableBlends[b] = true
					}
				}
				var blends []string
				for _, b := range laneBlends {
					if availableBlends[b] {
						blends = append(blends, b)
					}
				}
				if len(blends) > 1 {
					out = append(out, facet{"blend", blends, f.glyph})
				}
			}
			continue
		}
		switch f.key {
		case "spark":
			if !laneHostsSpecial(lane, "spark") || m.noSpark {
				continue
			}
		case "fast":
			// The fast dial is the priority service tier — an OpenAI pool
			// feature, meaningless on a pure lane of any other pool or where
			// no OpenAI token leads the work.
			if p := providerByLane(lane); lanePure(lane) && p != nil && p.ServiceTier[0] == "" {
				continue
			}
		case "model":
			// Narrow the ladder notches to the ones this lane's combos cover
			// (mirroring how the local lane rewrites the thinking facet's
			// values). Unknown lane, or no catalog read yet: leave the dial
			// whole, exactly as it behaved before any catalog was applied.
			if served := m.mtiers[lane]; len(served) > 0 {
				out = append(out, facet{key: f.key, values: served, glyph: f.glyph})
				continue
			}
		}
		out = append(out, f)
	}
	return out
}

// comboID is the catalog key for a dial state: <lane>_<mtier>_<thinking>_<sp|nosp>.
// The spark segment is lane-suppressed — a lane whose pool-set excludes the
// spark provider's pool has only the "nosp" variant generated, whatever the
// dial says — and the mtier segment is whatever the model dial holds, which
// visibleFacets has already narrowed to the notches this lane serves.
func comboID(sel map[string]string) string {
	lane := sel["lane"]
	spid := "nosp"
	if sel["spark"] == "on" && laneHostsSpecial(lane, "spark") {
		spid = "sp"
	}
	return fmt.Sprintf("%s_%s_%s_%s", lane, sel["model"], sel["thinking"], spid)
}

func connectedPools(accounts map[string][]account) map[string]bool {
	pools := map[string]bool{}
	for providerID, providerAccounts := range accounts {
		if len(providerAccounts) == 0 {
			continue
		}
		if provider := providerByID(providerID); provider != nil {
			pools[provider.Pool] = true
		}
	}
	return pools
}

// laneValues is the lane facet's current value list — the catalog's lanes.
func (m model) laneValues() []string {
	for _, f := range m.facets {
		if f.key == "lane" {
			return f.values
		}
	}
	return nil
}

// laneUsable reports whether a lane is a real stop on the dial right now: the
// catalog serves it AND — once discovery has resolved — the connected
// credentials can run it. Before discovery resolves, everything served is
// usable, so the dial never flickers on startup.
func (m model) laneUsable(lane string) bool {
	if !slices.Contains(m.laneValues(), lane) {
		return false
	}
	return !m.providersResolved || laneAvailable(lane, m.connected)
}

// disconnectedLeads names the lead-dial providers the credentials cannot run
// ("DeepSeek") — the lead row's "log in to unlock" note. Empty
// before discovery resolves or when everything is connected.
func (m model) disconnectedLeads(leads []string) string {
	if !m.providersResolved {
		return ""
	}
	var out []string
	for _, lead := range leads {
		if lead == "mixed" {
			continue
		}
		if p := providerByLane(lead + "-led"); p != nil && !m.connected[p.Pool] {
			out = append(out, p.AccountLabel)
		}
	}
	return strings.Join(out, ", ")
}

// filterRows drops fallback rungs the connected credentials cannot serve from
// routing rows (a fallback rung in a pool nobody logged into), so the
// preview and the launched overlay never name a model OMP cannot route. The
// lead token always stays — an unusable lead means an unusable lane, which
// laneUsable already keeps the selection off of.
func (m model) filterRows(rows []string) []string {
	if !m.providersResolved {
		return rows
	}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		toks := strings.Split(r, " → ")
		if len(toks) < 2 {
			out = append(out, r)
			continue
		}
		kept := toks[:1]
		for _, t := range toks[1:] {
			id := t
			if i := strings.LastIndexByte(t, ':'); i >= 0 {
				id = t[:i]
			}
			pool := m.poolOfModel(strings.TrimSpace(id))
			if pool == "" || m.connected[pool] {
				kept = append(kept, t)
			}
		}
		out = append(out, strings.Join(kept, " → "))
	}
	return out
}

// composeLane joins a lead and a preferred blend into a lane the catalog
// serves: the preferred blend when that lane exists, else the first served
// blend for the lead (a lead switch never lands on a combo that was never
// generated).
func (m model) composeLane(lead, blend string) string {
	if lead == "mixed" {
		return "mixed"
	}
	served := m.laneValues()
	if lane := laneJoin(lead, blend); slices.Contains(served, lane) {
		return lane
	}
	for _, b := range laneBlends {
		if lane := laneJoin(lead, b); slices.Contains(served, lane) {
			return lane
		}
	}
	return laneJoin(lead, blend)
}

// applyProviderAvailability records which credentials OMP can actually use.
// The dial keeps every catalog lane — unavailable ones render struck and
// unpickable (see laneUsable) instead of vanishing, so a missing optional
// login never silently shrinks the dial; only the selection is moved off an
// unusable lane, preferring the canonical defaults.
func (m *model) applyProviderAvailability(connected map[string]bool) {
	m.providersResolved = true
	m.connected = connected
	usable := false
	for _, lane := range catalogLanes(m.generated) {
		if laneAvailable(lane, connected) {
			usable = true
		}
	}
	m.noProviders = !usable
	if m.noProviders {
		return
	}
	m.clampSel()
}

// applyCatalog records which dials this catalog can actually serve, then forces
// the rest off. A models file with no tier-0 model yields no _sp_ combos at all,
// so the shipped default (spark on) would open the TUI on a combo that was never
// written — and a selection persisted against a richer catalog does the same.
// Ids are <lane>_<mtier>_<thinking>_<sp|nosp>, so match whole segments: "nosp"
// contains the very substring being looked for.
//
// The model dial is catalog-driven per lane for the same reason, and the reason
// is structural rather than optional: pool ladders are variable-depth, so the
// mtier segments a lane's combos carry are the only truth about which notches
// exist there (a lane whose pools stop at tier 3 has no elite combo, because it
// would be a byte-identical duplicate of smart).
//
// The lane facet's value list is the catalog's too: the distinct lane segments
// of the combo ids, ordered canonically (laneOrderForPools), so a catalog with
// a DeepSeek pool grows ds-led/ds-only dials and an old one shows exactly the
// classic five.
func (m *model) applyCatalog() {
	if len(m.generated) == 0 {
		return // no catalog read yet: onboarding, or a broken CODE_GENERATED
	}
	spark := false
	served := map[string]bool{}
	tiers := map[string]map[string]bool{}
	for id := range m.generated {
		if strings.HasPrefix(id, "__") {
			continue // a metadata block (__models__, __advisors__), not a combo
		}
		segs := strings.Split(id, "_")
		lane := segs[0]
		served[lane] = true
		if slices.Contains(segs, "sp") {
			spark = true
		}
		if len(segs) < 2 {
			continue
		}
		if tiers[lane] == nil {
			tiers[lane] = map[string]bool{}
		}
		tiers[lane][segs[1]] = true
	}
	m.noSpark = !spark
	m.mtiers = make(map[string][]string, len(tiers))
	for lane, set := range tiers {
		var values []string
		for _, t := range genMTiers {
			if set[t] {
				values = append(values, t)
			}
		}
		if len(values) > 0 {
			m.mtiers[lane] = values
		}
	}
	if lanes := catalogLanes(m.generated); len(lanes) > 0 {
		for i := range m.facets {
			if m.facets[i].key == "lane" {
				m.facets[i].values = lanes
			}
		}
	}
	m.trimLanes(served)

	m.clampSel()
}

// catalogLanes collects the distinct lane values the catalog generated, in
// canonical dial order; unknown lane names (a newer catalog) trail sorted so
// they are still reachable.
func catalogLanes(generated map[string][]string) []string {
	seen := map[string]bool{}
	for id := range generated {
		if strings.HasPrefix(id, "__") {
			continue
		}
		lane, rest, ok := strings.Cut(id, "_")
		if !ok || lane == "" || rest == "" {
			continue
		}
		seen[lane] = true
	}
	if len(seen) == 0 {
		return nil
	}
	var lanes []string
	for _, lane := range laneOrderForPools(fallbackPoolOrder) {
		if seen[lane] {
			lanes = append(lanes, lane)
			delete(seen, lane)
		}
	}
	var extra []string
	for lane := range seen {
		extra = append(extra, lane)
	}
	sort.Strings(extra)
	return append(lanes, extra...)
}

// trimLanes narrows the lane dial to the lanes this catalog actually serves,
// and lands the selection on a served lane when a persisted or default choice
// points at an optional pool that vanished. This is the consumer side of the
// optional-pool switches: no optional-pool entries in models.yml means no
// corresponding values on the dial.
func (m *model) trimLanes(served map[string]bool) {
	for i, f := range m.facets {
		if f.key != "lane" {
			continue
		}
		var values []string
		for _, v := range f.values {
			if served[v] {
				values = append(values, v)
			}
		}
		if len(values) == len(f.values) {
			continue // nothing to trim
		}
		if len(values) > 0 {
			m.facets[i].values = values
		}
		break
	}
	if !served[m.sel["lane"]] {
		for _, fallback := range []string{"mixed", "gpt-only", "claude-only"} {
			if served[fallback] {
				m.sel["lane"] = fallback
				break
			}
		}
	}
}

// clampSel turns off every dial the catalog cannot serve, and snaps the rest
// onto a value it does.
func (m *model) clampSel() {
	if m.noSpark {
		m.sel["spark"] = "off"
	}
	// A persisted lane the applied catalog no longer generates (or one from a
	// richer catalog) resets to the dial's first lane.
	for _, f := range m.facets {
		if f.key != "lane" || len(f.values) == 0 {
			continue
		}
		known := false
		for _, v := range f.values {
			if v == m.sel["lane"] {
				known = true
				break
			}
		}
		if !known {
			m.sel["lane"] = f.values[0]
		}
	}
	// A lane the connected credentials cannot run moves to the first usable
	// one, preferring the canonical defaults — the dial keeps showing it,
	// struck, but the selection never rests on it.
	if m.providersResolved && !m.noProviders && !laneAvailable(m.sel["lane"], m.connected) {
		for _, lane := range append([]string{"mixed", "gpt-only", "claude-only"}, m.laneValues()...) {
			if m.laneUsable(lane) {
				m.sel["lane"] = lane
				break
			}
		}
	}
	// The model dial last, because the lane clamps above can move it: a selection
	// persisted against a richer catalog (or made on a deeper lane) must not rest
	// on an mtier this lane never generated — "elite" on a lane whose pools stop
	// at tier 3 is a combo that does not exist. Snap DOWN to the nearest served
	// notch, so a too-capable choice degrades to this lane's top rung instead of
	// jumping to its cheapest.
	if served := m.mtiers[m.sel["lane"]]; len(served) > 0 && !slices.Contains(served, m.sel["model"]) {
		want := len(genMTiers) // an unknown value reads as "the most capable"
		for i, t := range genMTiers {
			if t == m.sel["model"] {
				want = i
			}
		}
		m.sel["model"] = served[0]
		for i := len(served) - 1; i >= 0; i-- {
			if slices.Index(genMTiers, served[i]) <= want {
				m.sel["model"] = served[i]
				break
			}
		}
	}
}

// laneColor tints the accent by lane: each provider carries a deeper shade for
// its pure lane and a lighter one for its led lane; mixed keeps its purple.
func laneColor(lane string) string {
	if lane == "mixed" {
		return "#aa96e1"
	}
	if p := providerByLane(lane); p != nil {
		if lanePure(lane) {
			return p.LaneOnly
		}
		return p.LaneLed
	}
	return "#ff9f52"
}

// prefixed qualifies a model id with its omp provider: the catalog column when
// present, else the registry's family guess. The unknown-model fallback stays
// openai-codex so a legacy catalog launches exactly as before.
func (m model) prefixed(model string) string {
	// Routing tokens carry a thinking level ("id:level"); the catalog is
	// keyed on the bare id. Qualify the full token either way.
	id := model
	if i := strings.IndexByte(id, ':'); i >= 0 {
		id = id[:i]
	}
	if f, ok := m.facts[id]; ok {
		if p := providerByPool(f.pool); p != nil {
			return p.ID + "/" + model
		}
	}
	if p := providerByModel(model); p != nil {
		return p.ID + "/" + model
	}
	return openAIProvider + "/" + model
}

// poolOfModel is the model's registry pool letter: the catalog column first
// (leveled tokens are stripped before the lookup), the family guess second;
// "" when nobody claims it.
func (m model) poolOfModel(id string) string {
	bare := id
	if i := strings.IndexByte(bare, ':'); i >= 0 {
		bare = bare[:i]
	}
	if f, ok := m.facts[bare]; ok && f.pool != "" {
		return f.pool
	}
	if p := providerByModel(bare); p != nil {
		return p.Pool
	}
	return ""
}

// genConfigYAML reconstructs an omp config (modelRoles, task-agent model
// overrides for the ●-marked agent-backed roles, fallback chains, thinking,
// advisor, and the priority tier when fast is on) from the generated routing
// block for the current facets — what Enter launches omp with. The agent
// overrides mirror the preview: without them the static managed defaults
// would keep the five agent-backed types pinned regardless of the generated
// profile (issue atyrode/dotfiles#173).
func (m model) genConfigYAML() string {
	rows := m.currentRows()
	var mr, fc, ao strings.Builder
	advisorOn := false
	for _, r := range rows {
		f := strings.Fields(strings.ReplaceAll(r, "→", " "))
		i := 0
		if len(f) > 0 && f[0] == "●" {
			i = 1
		}
		if i >= len(f) {
			continue
		}
		role := f[i]
		var models []string
		for _, t := range f[i+1:] {
			if modelRe.MatchString(t) {
				models = append(models, t)
			}
		}
		if len(models) == 0 {
			continue
		}
		if role == "advisor" {
			advisorOn = true
		}
		if i == 1 && role != "advisor" {
			// ●-marked agent-backed role: mirror its lead route as the task-agent
			// model override so spawned agents follow the generated profile.
			ao.WriteString("    " + role + ": " + m.prefixed(models[0]) + "\n")
		}
		mr.WriteString("  " + role + ": " + m.prefixed(models[0]) + "\n")
		if len(models) > 1 {
			var fbs []string
			for _, x := range models[1:] {
				fbs = append(fbs, m.prefixed(x))
			}
			fc.WriteString("    " + role + ": [" + strings.Join(fbs, ", ") + "]\n")
		}
	}
	var b strings.Builder
	b.WriteString("modelRoles:\n" + mr.String())
	b.WriteString("retry:\n  enabled: true\n  modelFallback: true\n  fallbackRevertPolicy: cooldown-expiry\n  fallbackChains:\n" + fc.String())
	// task.agentAdvisor (omp ≥ 17.3; earlier omps hard-error on the unknown
	// key, and CODE_OMP wrappers can lag the store during a dotfiles rollout,
	// so the probed version gates the emission): at the audit dial, spawned
	// task agents get their own advisor. Merged into the one task: block —
	// overlays are strict YAML and two task: keys would be invalid.
	agentAdvisor := m.sel["advisor"] == "audit" && m.ompVersionAtLeast(17, 3)
	if ao.Len() > 0 || agentAdvisor {
		b.WriteString("task:\n")
		if ao.Len() > 0 {
			b.WriteString("  agentModelOverrides:\n" + ao.String())
		}
		if agentAdvisor {
			b.WriteString("  agentAdvisor:\n    task: \"on\"\n")
		}
	}
	b.WriteString("defaultThinkingLevel: " + m.sel["thinking"] + "\n")
	if advisorOn {
		b.WriteString("advisor:\n  enabled: true\n")
	} else {
		b.WriteString("advisor:\n  enabled: false\n")
	}
	if m.sel["fast"] == "on" && laneHasPool(m.sel["lane"], "O") {
		if p := providerByPool("O"); p != nil && p.ServiceTier[0] != "" {
			b.WriteString("tier:\n  " + p.ServiceTier[0] + ": " + p.ServiceTier[1] + "\n")
		}
	}
	return b.String()
}
