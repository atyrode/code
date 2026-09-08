package domain

import (
	"strings"
 )

type facet struct {
	key    string
	values []string
	glyph  string
}

// facetDefs seeds the facet dials. The lane facet starts empty: its values are
// catalog-driven (applyCatalog collects the lanes the catalog actually
// generated), so a two-pool catalog shows exactly the classic five lanes and a
// richer one adds its own.
func facetDefs(glyphs map[string]string) []facet {
	return []facet{
		// Seeded with the required pools' lanes so a catalog-less run (the
		// onboarding shell, a broken CODE_GENERATED) keeps a working dial;
		// applyCatalog replaces the list with the lanes the catalog generated.
		{"lane", requiredPoolLanes(), glyphs["lane"]},
		// The model dial is the capability ladder, one notch per rung. "elite"
		// reaches a pool's tier-4 rung — claude-fable-5 on A, gpt-6-astra on
		// O, and any pool that later gains a fourth. It is only offered on
		// lanes whose combos actually carry it (visibleFacets narrows the
		// values to m.mtiers): on a lane whose lead pool stops at tier 3 the
		// generator writes no elite combo, because it would be byte-identical
		// to smart.
		{"model", []string{"fast", "normal", "smart", "elite"}, glyphs["model"]},
		{"thinking", []string{"minimal", "low", "medium", "high", "xhigh", "max"}, glyphs["thinking"]},
		// advisor as a power/cost dial: a quick glance, a proper review, or a
		// deep (expensive) audit — off spends nothing.
		{"advisor", []string{"off", "glance", "review", "audit"}, glyphs["advisor"]},
		{"spark", []string{"on", "off"}, glyphs["spark"]},
		// omp's own session switches, folded under the generator's `more` row
		// (moreFacets). None of them is routing: fast buys a provider's
		// priority service tier as an omp `tier:` overlay key, prewalk and
		// planyolo neither appear in comboID and are applied where the launch
		// is assembled — prewalk as omp config keys, planyolo as an argv flag.
		// Both target the "smol" role by default, which this grid already
		// routes, so there is no second model to choose. fallback is the same
		// kind of switch pointed the other way: on by default, and off turns
		// omp's model fallback (retry.modelFallback) off for the launch, so
		// every role stays on its lead. The catalog block is untouched — the
		// chains it carries simply do not reach the overlay.
		{"fast", []string{"on", "off"}, glyphs["fast"]},
		{"prewalk", []string{"on", "off"}, glyphs["prewalk"]},
		{"planyolo", []string{"on", "off"}, glyphs["planyolo"]},
		{"fallback", []string{"on", "off"}, glyphs["fallback"]},
	}
}

func parseAdvisors(rows []string) map[string][]string {
	out := map[string][]string{}
	for _, r := range rows {
		f := strings.Fields(strings.ReplaceAll(r, "→", " "))
		if len(f) < 3 {
			continue
		}
		var chain []string
		for _, t := range f[2:] {
			if modelRe.MatchString(t) {
				chain = append(chain, t)
			}
		}
		if len(chain) > 0 {
			out[f[0]+"/"+f[1]] = chain
		}
	}
	return out
}

// modelFact is a model's measured facts from omp (via the catalog): pricing
// ($/1M tokens), output throughput (tok/s), time-to-first-token (seconds), the
// quota bucket it draws from ("" when the catalog declares none), and the pool
// it belongs to ("" in catalogs that predate the column — the provider-prefix
// heuristic covers those).
type modelFact struct {
	in, out, speed, ttft float64
	bucket               string
	pool                 string // catalog pool letter ("" in legacy catalogs — the family guess covers those)
}

// effTPS folds ttft into throughput — the effective tok/s for a representative
// reply of effTokens: total time = ttft (startup) + tokens/speed (streaming), so
// a blazing-but-slow-to-start model (spark: 287 t/s, 5.6s ttft) reads honestly.
const effTokens = 300.0

func (f modelFact) effTPS() float64 {
	if f.speed <= 0 {
		return 0
	}
	return effTokens / (f.ttft + effTokens/f.speed)
}
