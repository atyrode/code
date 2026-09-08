package domain

import (
	"fmt"
	"math"
	"strings"
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
	"scout": 2, "smol": 1, "tiny": 0.5, "commit": 0.5, "vision": 0.5,
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


// costScore rates the current config from 1 (cheap) to 5 (dear).
func (m model) costScore() int {
	fast := m.sel["fast"] == "on" && len(laneServiceTiers(m.sel["lane"])) > 0
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
		pool := m.poolOfModel(id)
		if _, sells := poolServiceTier(pool); fast && sells {
			cost *= priorityMult
		}
		cost *= poolOffPeak(pool, m.now.UTC())
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
	fast := m.sel["fast"] == "on" && len(laneServiceTiers(m.sel["lane"])) > 0
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
		if _, sells := poolServiceTier(m.poolOfModel(id)); fast && sells {
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
			if pool != "" && m.connected[pool] {
				kept = append(kept, t)
			}
		}
		out = append(out, strings.Join(kept, " → "))
	}
	return out
}

// prefixed qualifies only models in the authoritative native catalog.
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
	return ""
}

// poolOfModel reads the authoritative catalog, never model-family heuristics.
func (m model) poolOfModel(id string) string {
	bare := id
	if i := strings.IndexByte(bare, ':'); i >= 0 {
		bare = bare[:i]
	}
	if f, ok := m.facts[bare]; ok && f.pool != "" {
		return f.pool
	}
	return ""
}

// genConfigYAML reconstructs an omp config (modelRoles, task-agent model
// overrides for the ●-marked agent-backed roles, fallback chains unless the
// fallback dial is off, thinking, advisor, and the priority tier when fast is
// on) for Manifold's native OMP runtime. The agent overrides mirror the preview:
// static managed defaults would keep agent-backed types pinned regardless of
// the generated profile (issue atyrode/dotfiles#173).
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
			// Preserve role identity: native child fallback lookup is role-keyed,
			// and two agents can share a lead while having different chains.
			ao.WriteString("    " + role + ": '@" + strings.ReplaceAll(role, "'", "''") + "'\n")
		}
		mr.WriteString("  " + role + ": " + m.prefixed(models[0]) + "\n")
		var fbs []string
		for _, x := range models[1:] {
			fbs = append(fbs, m.prefixed(x))
		}
		// An explicit empty chain prevents native inheritance of default's
		// chain for a role whose preview advertises only its lead.
		fc.WriteString("    " + role + ": [" + strings.Join(fbs, ", ") + "]\n")
	}
	var b strings.Builder
	b.WriteString("modelRoles:\n" + mr.String())
	// The fallback dial is omp's retry.modelFallback: every model switch omp
	// makes on retry — the error path, the usage-aware preflight, the
	// advisor's — is gated on that one key (verified against the 18.1.10
	// bundle), so false is enough to keep every role on its lead. The chains
	// are left out rather than emptied because they are inert under it, and
	// an overlay that carried them would put a route in front of the operator
	// that cannot run. retry.enabled stays: same-model retries are not
	// fallback, and turning them off would make a transient error terminal.
	// The account/broker fallback is a different system and is untouched.
	if m.sel["fallback"] == "off" {
		b.WriteString("retry:\n  enabled: true\n  modelFallback: false\n")
	} else {
		b.WriteString("retry:\n  enabled: true\n  modelFallback: true\n  fallbackRevertPolicy: cooldown-expiry\n  fallbackChains:\n" + fc.String())
	}
	// At the audit dial, spawned task agents get their own advisor. Supported
	// OMP runtimes register this setting; emission must not depend on an async
	// version probe or differ when replaying a saved profile.
	// Merge it into the one task: block: duplicate YAML keys are invalid.
	agentAdvisor := m.sel["advisor"] == "audit"
	// prewalk drops the run from the active model to the "smol" role at the
	// first edit once the plan's todo list exists. The dial is one switch, so
	// both the main session (prewalk.enabled) and spawned task agents
	// (task.prewalk) move: shifting only half a run onto the cheap model would
	// make the dial mean something the label does not say. omp defaults the
	// target to the smol role, which modelRoles above already routes, so there
	// is no second model for this dial to choose.
	prewalk := m.sel["prewalk"] == "on"
	if ao.Len() > 0 || agentAdvisor || prewalk {
		b.WriteString("task:\n")
		if ao.Len() > 0 {
			b.WriteString("  agentModelOverrides:\n" + ao.String())
		}
		if agentAdvisor {
			b.WriteString("  agentAdvisor:\n    task: \"on\"\n")
		}
		if prewalk {
			b.WriteString("  prewalk: true\n")
		}
	}
	if prewalk {
		b.WriteString("prewalk:\n  enabled: true\n")
	}
	b.WriteString("defaultThinkingLevel: " + m.sel["thinking"] + "\n")
	if advisorOn {
		b.WriteString("advisor:\n  enabled: true\n")
	} else {
		b.WriteString("advisor:\n  enabled: false\n")
	}
	// The fast dial buys every priority tier the lane's pools sell, keyed by
	// whichever provider sells it — not pool O's, which is what this used to
	// hard-code. Anthropic already ships `tier.anthropic` in omp 18, so a
	// registry entry gaining ServiceTier now lights up here with no edit.
	if m.sel["fast"] == "on" {
		if tiers := laneServiceTiers(m.sel["lane"]); len(tiers) > 0 {
			b.WriteString("tier:\n")
			for _, t := range tiers {
				b.WriteString("  " + t[0] + ": " + t[1] + "\n")
			}
		}
	}
	return b.String()
}

// sessionFlags are the omp argv flags the routing-neutral dials ask for.
// prewalk has config keys so it rides the generated overlay; plan-yolo has
// none — omp exposes it on the command line only — so it rides argv. Same
// principle either way: set omp's own switch, wherever omp put it.
func (m model) sessionFlags() []string {
	var out []string
	if m.sel["planyolo"] == "on" {
		out = append(out, "--plan-yolo")
	}
	return out
}
