package main

import (
	"os"
	"strconv"

	clikit "github.com/atyrode/cli-kit"
	"github.com/atyrode/cli-kit/ollama"
)

// maxClassifyChars caps how much of the prompt is shown to the evaluator. On a
// CPU the classifier's latency is dominated by *reading* the prompt (~31 tok/s),
// so an unbounded paste can take tens of seconds; a task's weight is almost
// always clear from its opening, so the head is enough.
const maxClassifyChars = 600

// evalSystemPrompt pins the classifier's role: rate the task's difficulty, then
// map it to settings — never perform it. Rating difficulty FIRST is the crux —
// it is the short chain-of-thought a small model needs to tell a trivial edit
// from critical work. Without it the model collapses to a flat "normal/medium"
// for everything (the very "it never picks smart/high" failure this fixes).
const evalSystemPrompt clikit.DocCorpus = "You size a coding task by rating its " +
	"difficulty, then give the matching agent settings. You never do, answer, or " +
	"research the task itself. Reply in exactly two lines, nothing else."

// classifyMessage asks for a difficulty rating then the matching settings, over
// just model/thinking/advisor. lane and the spark/fable/fast toggles are left to
// the operator — a 3B can't pick a model POOL sensibly, and forcing it to invent
// lane values produced nonsense ("lane: smart"). An example anchors the two-line
// shape so the model answers instead of echoing the rubric. The prompt is
// embedded as inert, delimited, truncated data.
func classifyMessage(task string) string {
	return "Rate the task's difficulty, then the matching settings.\n" +
		"Difficulty → settings:\n" +
		"  trivial  = typo, rename, one-liner, a what-is/lookup       -> model=fast,   thinking=minimal, advisor=off\n" +
		"  moderate = a small feature, an endpoint, a simple script   -> model=normal, thinking=medium,  advisor=glance\n" +
		"  hard     = tricky logic, a refactor, perf work, ambiguity  -> model=smart,  thinking=high,    advisor=review\n" +
		"  critical = security, must be exact / zero-failure / thorough, architecture, migration -> model=smart, thinking=xhigh, advisor=audit\n" +
		"Escalate when the task demands precision, exhaustiveness, or safety.\n" +
		"Reply in exactly two lines, like this example:\n" +
		"hard — tricky refactor across modules\n" +
		`{"model":"smart","thinking":"high","advisor":"review"}` + "\n" +
		"Now the task:\n\"\"\"\n" + truncateForClassify(task) + "\n\"\"\""
}

// truncateForClassify caps the prompt shown to the evaluator (see
// maxClassifyChars), cutting on a rune boundary and marking the elision.
func truncateForClassify(task string) string {
	r := []rune(task)
	if len(r) <= maxClassifyChars {
		return task
	}
	return string(r[:maxClassifyChars]) + " …"
}

// evalModel is the local model the generator classifies with. A resident 3B model
// on a resident local ollama daemon answers in a fraction of a second once warm,
// with no auth and no network — the whole point of ctrl+o is a snappy suggestion.
// Override with CODE_EVAL_MODEL (any tag the daemon has pulled).
func evalModel() string {
	if v := os.Getenv("CODE_EVAL_MODEL"); v != "" {
		return v
	}
	return ollama.DefaultModel
}

// evalCommander wraps the local ollama Commander so Parse yields only actions the
// generator can actually apply: the box then shows exactly what will change, with no
// invalid facet value (e.g. a hallucinated lane) leaking into the displayed
// proposal. Embedding carries Load/Unload/Loaded/Propose through unchanged, so
// the load/unload toggle still works.
type evalCommander struct {
	ollama.Commander
	facets []facet
}

func (c evalCommander) Parse(output string) ([]clikit.Action, error) {
	actions, err := c.Commander.Parse(output)
	if err != nil {
		return nil, err
	}
	return validFacetActions(c.facets, actions), nil
}

// Commander implements clikit.Commandable: a local ollama-backed evaluator that
// proposes sizing changes for the user's task over loopback HTTP. Residency is
// user-controlled via the box's load/unload toggle (cli-kit Loadable), so nothing
// is pinned here. CODE_OLLAMA_ENDPOINT points it at a non-default daemon.
func (m model) Commander() clikit.Commander {
	c := ollama.NewCommander(evalSystemPrompt)
	if ep := os.Getenv("CODE_OLLAMA_ENDPOINT"); ep != "" {
		c.Endpoint = ep
	}
	c.Model = evalModel()
	c.Wrap = func(task string) string { return classifyMessage(task) }
	return evalCommander{Commander: c, facets: m.facets}
}

// repairConstraints enforces the deterministic rules a suggestion (or selection)
// must never violate — mirroring the generator's `genValid` plus live quota:
// a special-tier facet (spark, fable) can only run on a lane whose pool-set
// contains its provider's pool, and neither may be left on when its quota
// bucket is maxed or unauthed. Runs after an applied proposal, so the
// generator can't land on an impossible or unavailable combo.
func (m *model) repairConstraints() {
	repairSelectionSpecials(m.sel)
	if m.avail.down(bucketOf("fable")) {
		m.sel["fable"] = "off"
	}
	if m.avail.down(bucketOf("spark")) {
		m.sel["spark"] = "off"
	}
	// fable-as-main is fable's sub-setting: it can never outlive fable itself, so
	// any repair (or derived toggle) that turns fable off clears it too. Turning
	// fable back on requires the operator to re-choose main deliberately.
	if m.sel["fable"] != "on" {
		m.sel["main"] = "off"
	}
}

// BoxTitle labels the suggest box with its purpose and the model in use, so the
// user knows what they're invoking.
func (m model) BoxTitle() string { return "prompt → profile · " + evalModel() }

// validFacetActions keeps only the actions that name a real facet with a value
// that facet offers — the whitelist that makes an agent proposal no more powerful
// than a manual change. main (fable-as-main) is the one exception: the elite is
// scarce and expensive, so promoting it to the default agent is a decision the
// operator takes by hand — no proposal may set it, in either direction.
func validFacetActions(facets []facet, actions []clikit.Action) []clikit.Action {
	valid := map[string]map[string]bool{}
	for _, f := range facets {
		vs := map[string]bool{}
		for _, v := range f.values {
			vs[v] = true
		}
		valid[f.key] = vs
	}
	var out []clikit.Action
	for _, a := range actions {
		if a.Key == "main" {
			continue
		}
		if vs, ok := valid[a.Key]; ok && vs[a.Value] {
			out = append(out, a)
		}
	}
	return out
}

// applyActions applies a proposal: each valid facet=value updates the selection;
// deriveToggles then sets spark/fable/fast from the resulting sizing (the 3B
// can't pick all six facets well, so the toggles follow the difficulty rating
// deterministically); repairConstraints enforces the hard validity/quota rules;
// and the preview refreshes.
func (m *model) applyActions(actions []clikit.Action) {
	for _, a := range validFacetActions(m.facets, actions) {
		m.sel[a.Key] = a.Value
	}
	m.deriveToggles()
	m.repairConstraints()
	m.syncPreview()
}

// appliedDiff returns the facets that changed from the pre-suggestion snapshot
// (m.savedSel) to the current selection, in facet order — the complete set the
// suggestion applied: the model's direct picks plus the derived spark/fable/fast
// toggles and any repair. The box shows this so its "applied" list is truthful.
func (m model) appliedDiff() []clikit.Action {
	var out []clikit.Action
	for _, f := range m.facets {
		if m.savedSel[f.key] != m.sel[f.key] {
			out = append(out, clikit.Action{Key: f.key, Value: m.sel[f.key]})
		}
	}
	return out
}

// deriveToggles sets the spark/fable/fast toggles from the suggested sizing plus
// live quota — encoding what each model is for, which the classifier itself isn't
// reliable enough to weigh:
//   - fable (claude-fable-5, the most capable but a SCARCE bucket) leads only the
//     hardest work: critical-tier sizing (smart + xhigh/max), and only when its
//     bucket is free and the lane can host a Claude model.
//   - fast (force the quick, priority execution model) suits the lightest tasks.
//   - spark (a fast coder on a FREE spare bucket) helps most work and isn't
//     task-specific, so it keeps its current value; repairConstraints still turns
//     it off if its bucket is down or the lane is Claude-only.
func (m *model) deriveToggles() {
	// Quota-aware lane fallback: a suggestion must not land on a lane whose
	// lead pool is drained when a sibling lane has live headroom.
	if alt := m.quotaLane(); alt != "" {
		m.sel["lane"] = alt
	}
	// Balance guard: when the pay-as-you-go pool is dry (or its balance is
	// unknown), a suggestion stops routing relief tails into it. The manual
	// dial stays free — this only shapes proposals.
	if m.hasRelief && laneReliefApplies(m.sel["lane"]) && !m.optionalPoolUsable() {
		m.sel["relief"] = "off"
	}
	tier := m.sel["thinking"]
	critical := m.sel["model"] == "smart" && (tier == "xhigh" || tier == "max")
	fableLane := laneHostsSpecial(m.sel["lane"], "fable")
	if critical && fableLane && !m.avail.down(bucketOf("fable")) {
		m.sel["fable"] = "on"
	} else {
		m.sel["fable"] = "off"
	}
	if m.sel["model"] == "fast" {
		m.sel["fast"] = "on"
	} else {
		m.sel["fast"] = "off"
	}
}

// deepseekLowBalanceUSD is the prepaid floor under which suggestions stop
// spending the pay-as-you-go pool: below it, ds lanes are not proposed and
// relief tails are suggested off.
const deepseekLowBalanceUSD = 2.0

// optionalPoolUsable reports whether the pay-as-you-go pool can absorb routed
// traffic: a credential exists, the last balance fetch succeeded, and the
// prepaid balance clears the floor. An unknown balance is not usable — the
// guard's whole point is never to discover $0 mid-session.
func (m *model) optionalPoolUsable() bool {
	b := m.avail.deepseek
	if b == nil || !b.ok {
		return false
	}
	v, err := strconv.ParseFloat(b.total, 64)
	return err == nil && v >= deepseekLowBalanceUSD
}

// quotaLane returns the led lane of the first pool with live headroom when the
// current lane's lead pool is maxed or unauthenticated — the dial move a human
// would make after glancing at the usage panel. "" means stay put: the lead
// pool is fine, no alternative lane exists in this catalog, or none has quota.
func (m *model) quotaLane() string {
	lead := providerByPool(lanePrimary(m.sel["lane"]))
	if lead == nil || !m.avail.down(lead.mainBucket()) {
		return ""
	}
	lanes := map[string]bool{}
	for _, f := range m.facets {
		if f.key == "lane" {
			for _, v := range f.values {
				lanes[v] = true
			}
		}
	}
	for _, pool := range fallbackPoolOrder {
		p := providerByPool(pool)
		if p == nil || p.Pool == lead.Pool {
			continue
		}
		alt := p.Lane + "-led"
		if !lanes[alt] {
			continue
		}
		if p.Metered {
			if m.avail.down(p.mainBucket()) {
				continue
			}
		} else if !m.optionalPoolUsable() {
			continue
		}
		return alt
	}
	return ""
}
