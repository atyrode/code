package main

import (
	"strconv"
	"strings"
)

// ── generator facets ─────────────────────────────────────────────────────────
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
		// routes, so there is no second model to choose.
		{"fast", []string{"on", "off"}, glyphs["fast"]},
		{"prewalk", []string{"on", "off"}, glyphs["prewalk"]},
		{"planyolo", []string{"on", "off"}, glyphs["planyolo"]},
	}
}

// moreFacetKey names the generator's fold: a synthetic row visibleFacets
// appends after the routing dials, holding the facets in moreFacets. It is
// derived, never a facetDefs entry, so it is never persisted (saveSelectionState
// filters on m.facets) and every run opens with the fold closed. Its value
// lives in m.sel like lead/blend's do, so ←/→ turn it exactly like any other
// dial: moreCollapsed on the left, moreExpanded on the right.
const (
	moreFacetKey  = "more"
	moreCollapsed = "collapsed"
	moreExpanded  = "expanded"
)

// moreFacets are the dials the fold hides: omp's own session switches, which
// change how a run behaves but never what the routing grid says. The routing
// dials above the fold are what an operator turns on nearly every launch;
// these are opt-in and off by default, and a list that always shows them
// buries the dials that matter under the ones that rarely change.
var moreFacets = map[string]bool{"fast": true, "prewalk": true, "planyolo": true}

// parseAdvisors reads the __advisors__ block (rows: "<level> <ctx> <chain>")
// into a map keyed "level/ctx" — the advisor model table, sourced from
// generate-profiles.py so the catalog stays a single source of truth.
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

// parseFacts reads the __models__ block (rows: "<id> <in> <out> <speed> <ttft>
// [<bucket> [<provider>]]") into a per-model table, sourced from the catalog
// so meters and routing agree. The trailing columns are optionals so legacy
// five- and six-token catalogs keep working: column six is the quota bucket,
// column seven the provider — accepted as the registry id (current renderer)
// or the bare pool letter (older renderers), resolved to a pool either way;
// unknown values fall back to the model-family guess.

// catalogPool resolves the __models__ trailing column to a pool letter. The
// current renderer writes the registry provider id there; an older one wrote
// the bare pool letter. Either parses; anything unknown falls back to the
// model-family guess so mixed-age catalogs keep working.
func catalogPool(col, id string) string {
	if len(col) == 1 {
		if providerByPool(col) != nil {
			return col
		}
	}
	if p := providerByID(col); p != nil {
		return p.Pool
	}
	if p := providerByModel(id); p != nil {
		return p.Pool
	}
	return ""
}

func parseFacts(rows []string) map[string]modelFact {
	out := map[string]modelFact{}
	for _, r := range rows {
		f := strings.Fields(r)
		if len(f) < 5 {
			continue
		}
		in, e1 := strconv.ParseFloat(f[1], 64)
		outc, e2 := strconv.ParseFloat(f[2], 64)
		sp, e3 := strconv.ParseFloat(f[3], 64)
		tt, e4 := strconv.ParseFloat(f[4], 64)
		bucket, pool := "", ""
		if len(f) >= 6 {
			bucket = f[5]
		}
		if len(f) >= 7 {
			pool = catalogPool(f[6], f[0])
		}
		if e1 == nil && e2 == nil && e3 == nil && e4 == nil {
			out[f[0]] = modelFact{in, outc, sp, tt, bucket, pool}
		}
	}
	return out
}
