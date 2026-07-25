package main

// `code generate init` — scaffold a models.yml from the user's own omp
// instance. The factual fields (id, cost, thinking) come straight from
// `omp models --json`; the judgment fields (which model fills which tier) are
// auto-guessed from cost and MUST be reviewed by the user. speed/ttft are
// rough placeholder estimates until measured.

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type ompModel struct {
	Provider      string   `json:"provider"`
	ID            string   `json:"id"`
	ContextWindow int      `json:"contextWindow"`
	Reasoning     bool     `json:"reasoning"`
	Thinking      []string `json:"thinking"`
	Input         []string `json:"input"` // modalities; "image" gates the vision role
	Cost          struct {
		Input  float64 `json:"input"`
		Output float64 `json:"output"`
	} `json:"cost"`
}

type ompModels struct {
	Models []ompModel `json:"models"`
}

// ompModelsJSON fetches the user's model list; a var so tests and the
// onboarding flow can stub the omp dependency.
var ompModelsJSON = func() ([]byte, error) {
	return exec.Command("omp", "models", "--json").Output()
}

var datedID = regexp.MustCompile(`-\d{6,8}$`)

func poolOf(provider string) string {
	switch provider {
	case "anthropic":
		return "A"
	case "openai-codex", "openai":
		return "O"
	}
	return ""
}

var versionToken = regexp.MustCompile(`^[\d.]+$`)

// shortKey derives a memorable key from a model id: the last dash-separated
// token that isn't purely a version (e.g. claude-sonnet-5 → sonnet,
// gpt-5.6-terra → terra, gpt-5.3-codex-spark → spark). Same-family ids collapse
// to the same key, which scaffoldModels resolves with versionSuffix.
func shortKey(id string) string {
	toks := strings.Split(id, "-")
	for i := len(toks) - 1; i >= 0; i-- {
		if !versionToken.MatchString(toks[i]) {
			return strings.ToLower(toks[i])
		}
	}
	return strings.ToLower(strings.NewReplacer(".", "-", ":", "-").Replace(id))
}

// versionSuffix compacts an id's version tokens for disambiguating two models
// of one family: claude-opus-5 → "5", claude-opus-4-8 → "48". The old
// disambiguator was the ladder index, which named the newer model `opus` and
// the older one `opus3` — no help at all to someone hand-editing the file.
func versionSuffix(id string) string {
	var b strings.Builder
	for _, t := range strings.Split(id, "-") {
		if versionToken.MatchString(t) {
			b.WriteString(strings.ReplaceAll(t, ".", ""))
		}
	}
	return b.String()
}

// familyOf splits an id into its name tokens and its version components:
// claude-opus-4-8 → "claude-opus", [4 8]; gpt-5.6-terra → "gpt-terra", [5 6].
// Two ids share a family when their name tokens match, which is what makes
// "claude-opus-5 supersedes claude-opus-4-8" decidable without a curated list.
// Dotted tokens split into separate components rather than parsing as a float,
// so a future gpt-5.10 outranks gpt-5.9 instead of reading as 5.1.
func familyOf(id string) (string, []int) {
	var name []string
	var ver []int
	for _, t := range strings.Split(id, "-") {
		if versionToken.MatchString(t) {
			parts := strings.Split(t, ".")
			nums := make([]int, 0, len(parts))
			for _, p := range parts {
				n, err := strconv.Atoi(p)
				if err != nil {
					nums = nil
					break
				}
				nums = append(nums, n)
			}
			if nums != nil {
				ver = append(ver, nums...)
				continue
			}
		}
		name = append(name, strings.ToLower(t))
	}
	return strings.Join(name, "-"), ver
}

// newer compares version vectors component-wise; a longer vector wins only
// where it agrees on every shared component (4.8 beats 4.1, and 5 beats 4.8).
func newer(a, b []int) bool {
	for i := range min(len(a), len(b)) {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return len(a) > len(b)
}

// supersede keeps only the newest member of each family. Providers reprice new
// models below predecessors they never delist — claude-opus-4-1 still lists at
// $15/1M while its successor claude-opus-5 costs $5 — so a price-ranked ladder
// crowns the fossil. Dropping superseded siblings removes the trap at source.
func supersede(cands []ompModel) []ompModel {
	type entry struct {
		m   ompModel
		fam string
		ver []int
	}
	es := make([]entry, 0, len(cands))
	for _, m := range cands {
		fam, ver := familyOf(m.ID)
		es = append(es, entry{m, fam, ver})
	}
	sort.Slice(es, func(i, j int) bool {
		if es[i].fam != es[j].fam {
			return es[i].fam < es[j].fam
		}
		if newer(es[i].ver, es[j].ver) {
			return true
		}
		if newer(es[j].ver, es[i].ver) {
			return false
		}
		return es[i].m.ID < es[j].m.ID
	})
	var out []ompModel
	seen := map[string]bool{}
	for _, e := range es {
		if seen[e.fam] {
			continue
		}
		seen[e.fam] = true
		out = append(out, e.m)
	}
	return out
}

// ceiling is the highest thinking level a model offers — the capability signal
// omp exposes that, unlike price, does not go stale.
func ceiling(m ompModel) int {
	hi := -1
	for _, lv := range m.Thinking {
		if i, ok := thIdx(lv); ok && i > hi {
			hi = i
		}
	}
	return hi
}

// moreCapable ranks by thinking ceiling, then context, then price. Price is the
// last word rather than the first: among models with identical published specs
// it is the only remaining signal of size, but across generations it lies.
func moreCapable(a, b ompModel) bool {
	if ceiling(a) != ceiling(b) {
		return ceiling(a) > ceiling(b)
	}
	if a.ContextWindow != b.ContextWindow {
		return a.ContextWindow > b.ContextWindow
	}
	if a.Cost.Input != b.Cost.Input {
		return a.Cost.Input > b.Cost.Input
	}
	return a.ID < b.ID
}

// cheaper orders by price, most capable first within a price, then by id so the
// result never depends on sort stability.
func cheaper(a, b ompModel) bool {
	if a.Cost.Input != b.Cost.Input {
		return a.Cost.Input < b.Cost.Input
	}
	if ceiling(a) != ceiling(b) {
		return ceiling(a) > ceiling(b)
	}
	if a.ContextWindow != b.ContextWindow {
		return a.ContextWindow > b.ContextWindow
	}
	return a.ID < b.ID
}

// pickLadder chooses tiers 1..3 for one pool from an already-superseded
// candidate set: cheapest is tier 1, the most capable is tier 3, and tier 2 is
// the most capable model priced strictly between them.
func pickLadder(cands []ompModel) []ompModel {
	if len(cands) < 3 {
		return cands
	}
	sort.Slice(cands, func(i, j int) bool { return cheaper(cands[i], cands[j]) })
	t1, rest := cands[0], cands[1:]
	t3 := rest[0]
	for _, m := range rest[1:] {
		if moreCapable(m, t3) {
			t3 = m
		}
	}
	t2, found := ompModel{}, false
	for _, m := range rest {
		if m.ID == t3.ID || m.Cost.Input <= t1.Cost.Input || m.Cost.Input >= t3.Cost.Input {
			continue
		}
		if !found || moreCapable(m, t2) {
			t2, found = m, true
		}
	}
	if !found { // no room between the rungs — take the median by price
		t2 = rest[len(rest)/2]
		if t2.ID == t3.ID {
			t2 = rest[0]
		}
	}
	return []ompModel{t1, t2, t3}
}

// ompUsageJSON fetches the provider quota report; a var so tests and the
// onboarding flow can stub it. Failure is never fatal — the special tiers it
// feeds are optional.
var ompUsageJSON = func() ([]byte, error) {
	return exec.Command("omp", "usage", "--json").Output()
}

// specialTier is a quota bucket omp scopes to a subset of a provider's models:
// the codex spark drain bucket, and Anthropic's scarce elite bucket. omp names
// these itself, so the scaffolder reads them rather than guessing which model
// is the cheap drain and which is the scarce elite — the guess used to be
// "nobody, ever", which left the spark and fable dials dead on every scaffold.
type specialTier struct {
	pool, tier, modelID string
}

func readSpecialTiers() []specialTier {
	raw, err := ompUsageJSON()
	if err != nil {
		return nil
	}
	var u struct {
		Reports []struct {
			Provider string `json:"provider"`
			Limits   []struct {
				Scope struct {
					Provider string `json:"provider"`
					Tier     string `json:"tier"`
					ModelID  string `json:"modelId"`
				} `json:"scope"`
			} `json:"limits"`
		} `json:"reports"`
	}
	if json.Unmarshal(raw, &u) != nil {
		return nil
	}
	var out []specialTier
	seen := map[string]bool{}
	for _, r := range u.Reports {
		for _, l := range r.Limits {
			if l.Scope.Tier == "" {
				continue
			}
			pool := poolOf(l.Scope.Provider)
			if pool == "" {
				pool = poolOf(r.Provider)
			}
			if pool == "" || seen[pool+l.Scope.Tier] {
				continue
			}
			seen[pool+l.Scope.Tier] = true
			out = append(out, specialTier{pool, l.Scope.Tier, l.Scope.ModelID})
		}
	}
	return out
}

// matchSpecial resolves a tier-scoped bucket to one of the pool's candidates. A
// scope that names its model wins outright; otherwise the bucket's tier name is
// matched against the model family, which is where the label comes from (omp's
// "Claude 7 Day (Fable)" is the claude-fable-* family). Matching by name and
// not by price matters: claude-mythos-5 lists at claude-fable-5's exact price
// but is not served on every account.
func matchSpecial(st specialTier, cands []ompModel) string {
	if st.modelID != "" {
		for _, m := range cands {
			if strings.EqualFold(m.ID, st.modelID) {
				return m.ID
			}
		}
	}
	for _, m := range cands {
		if fam, _ := familyOf(m.ID); strings.Contains(fam, strings.ToLower(st.tier)) {
			return m.ID
		}
	}
	return ""
}

// bucketName follows the catalog's existing convention: the pool's own quota
// window, or a tier-scoped one when the model draws a separate bucket.
func bucketName(pool, tier string) string {
	base := "codex"
	if pool == "A" {
		base = "claude"
	}
	if tier == "" {
		return base + "-main"
	}
	return base + "-" + tier
}

// thinkingField renders a model's levels for models.yml: the compact "lo→hi"
// range when the levels are contiguous, and an explicit comma list when they
// are not. claude-opus-4-6 offers low/medium/high/max but not xhigh, and a
// range would promise a level the API rejects.
func thinkingField(levels []string) string {
	idx := make([]int, 0, len(levels))
	for _, lv := range levels {
		if i, ok := thIdx(lv); ok {
			idx = append(idx, i)
		}
	}
	sort.Ints(idx)
	contiguous := true
	for i := 1; i < len(idx); i++ {
		if idx[i] != idx[i-1]+1 {
			contiguous = false
			break
		}
	}
	if contiguous {
		return thScale[idx[0]] + "→" + thScale[idx[len(idx)-1]]
	}
	names := make([]string, len(idx))
	for i, v := range idx {
		names[i] = thScale[v]
	}
	return strings.Join(names, ",")
}

// benchFact is one model's probe outcome. reachable means it answered; notFound
// means the provider says it does not exist for this account; anything else is
// unresolved — a transport, auth or rate failure that says nothing either way
// about entitlement, and so must not be guessed in either direction.
type benchFact struct {
	speed, ttft float64
	reachable   bool
	notFound    bool
	why         string
}

// notFoundProbe matches the one failure that is genuinely disqualifying: the
// provider denying the model exists. claude-mythos-5 answers exactly this way
// while listing at claude-fable-5's price, context and thinking range.
var notFoundProbe = regexp.MustCompile(`(?i)not_found|model_not_found|no such model|unknown model|does not exist`)

// ompBenchJSON probes models with omp's own benchmark; a var so tests can stub
// it. One short run per model: this is mandatory on every init and every
// first-run onboarding, and reachability is binary — extra runs or tokens would
// only steady a throughput figure at the cost of a longer wait.
//
// The prompt is overridden deliberately. omp's bundled bench prompt reads as
// cyber content to Anthropic's safety layer, and claude-fable-5 refuses it —
// which would have deleted a perfectly callable elite from the ladder. A probe
// that decides eligibility has to ask something nothing can object to.
var ompBenchJSON = func(selectors []string) ([]byte, error) {
	args := append([]string{"bench"}, selectors...)
	return exec.Command("omp", append(args,
		"--json", "--runs", "1", "--max-tokens", "4",
		"--prompt", "Reply with the single word: ok")...).Output()
}

// runBench sorts each model into the three outcomes benchFact describes and
// records throughput for the ones that answered. It deliberately does not
// collapse "refused" or "rate limited" into "unreachable": omp lists models an
// account cannot call (claude-mythos-5, at claude-fable-5's exact price), but a
// failed request is evidence of that only when the provider says the model does
// not exist. Everything else is unresolved, and the caller must not guess.
func runBench(selectors []string) (map[string]benchFact, error) {
	raw, err := ompBenchJSON(selectors)
	if len(raw) == 0 {
		if err == nil {
			err = fmt.Errorf("no output")
		}
		return nil, fmt.Errorf("running `omp bench`: %w", err)
	}
	var parsed struct {
		Models []struct {
			Model   string `json:"model"`
			Results []struct {
				OK    bool   `json:"ok"`
				Error string `json:"error"`
			} `json:"results"`
			Failures float64 `json:"failures"`
			Average  *struct {
				TTFTMs          float64 `json:"ttftMs"`
				TokensPerSecond float64 `json:"tokensPerSecond"`
			} `json:"average"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("parsing bench report: %w", err)
	}
	out := map[string]benchFact{}
	for _, m := range parsed.Models {
		id := m.Model
		if i := strings.LastIndexByte(id, '/'); i >= 0 {
			id = id[i+1:]
		}
		// omp is not consistent about id casing across surfaces (usage scopes
		// report "GPT-5.3-Codex-Spark"), so key on a folded id at both ends.
		id = strings.ToLower(id)
		why := ""
		for _, r := range m.Results {
			if !r.OK {
				if why = r.Error; why == "" {
					why = "run failed without an error message"
				}
				break
			}
		}
		switch {
		case why == "" && m.Failures == 0 && len(m.Results) > 0 && m.Average != nil:
			out[id] = benchFact{
				speed:     math.Round(m.Average.TokensPerSecond*10) / 10,
				ttft:      math.Round(m.Average.TTFTMs/10) / 100,
				reachable: true,
			}
		case notFoundProbe.MatchString(why):
			out[id] = benchFact{notFound: true, why: why}
		default:
			if why == "" {
				why = "incomplete probe report — no average or no runs recorded"
			}
			out[id] = benchFact{why: why}
		}
	}
	return out, nil
}

// scaffoldModels turns an `omp models --json` payload into models.yml content.
// Pure but for the quota probe, so the CLI and the first-run onboarding share
// it. probe, when non-nil, is a reachability report: it supplies measured
// speed/ttft and decides which models may become rungs. nil means no probe ran
// (the --from-json path), and every listed model is taken on faith — output from
// that path is marked unprobed and `code generate` refuses it.
func scaffoldModels(raw []byte, probe map[string]benchFact) (string, error) {
	var parsed ompModels
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", fmt.Errorf("parsing model list: %w", err)
	}
	var unresolved []string
	byPool := map[string][]ompModel{}
	for _, m := range parsed.Models {
		pool := poolOf(m.Provider)
		if pool == "" || !m.Reasoning || len(m.Thinking) == 0 ||
			m.Cost.Input <= 0 || datedID.MatchString(m.ID) {
			continue
		}
		// A model omp lists but the account cannot call is worse than useless on
		// the ladder: it looks top-spec and 404s at launch, and no metadata
		// distinguishes it (claude-mythos-5 lists at claude-fable-5's exact
		// price, context and thinking range). Only a live probe knows, and only
		// its verdict is actionable: a model the provider says does not exist is
		// dropped, while a model that merely failed to answer is unresolved and
		// must not be silently treated as either fine or absent.
		if probe != nil {
			f, seen := probe[strings.ToLower(m.ID)]
			switch {
			case f.notFound:
				continue
			case !seen:
				unresolved = append(unresolved, m.ID+": missing from the probe report")
				continue
			case !f.reachable:
				unresolved = append(unresolved, m.ID+": "+f.why)
				continue
			}
		}
		// Keep only thinking levels the generator's scale knows (omp can expose
		// provider-specific extras like "off"); without this the scaffold would
		// write a level 'code generate' rejects one step later.
		var levels []string
		for _, lv := range m.Thinking {
			if _, ok := thIdx(lv); ok {
				levels = append(levels, lv)
			}
		}
		if len(levels) == 0 {
			continue
		}
		m.Thinking = levels
		byPool[pool] = append(byPool[pool], m)
	}

	// An unresolved probe is not a licence to proceed. Dropping these silently
	// would write `probed: true` over a partial answer, and keeping them could
	// crown a model that never replied — so refuse, name each one, and let the
	// operator decide. Models the provider explicitly disowned are already gone
	// above and deliberately absent from this list.
	if len(unresolved) > 0 {
		sort.Strings(unresolved)
		return "", fmt.Errorf("the reachability probe came back inconclusive for %d model(s), so the ladder cannot be certified:\n  %s\nre-run once the provider is answering, or pass --from-json to scaffold offline without a probe",
			len(unresolved), strings.Join(unresolved, "\n  "))
	}

	specials := readSpecialTiers()
	type rung struct {
		m      ompModel
		tier   int
		bucket string
	}
	rungs := map[string][]rung{}
	for _, pool := range []string{"O", "A"} {
		cands := supersede(byPool[pool])
		// Lift a tier-scoped model out before ranking: it is a lead, not a rung
		// on the capability ladder. At most one per pool — two would both claim
		// the same tier and loadCatalog would refuse the file — preferring the
		// bucket whose scope names its model, then the first by name so the
		// choice never depends on report ordering.
		var pick *specialTier
		var pickID string
		for i := range specials {
			st := &specials[i]
			if st.pool != pool {
				continue
			}
			id := matchSpecial(*st, cands)
			if id == "" {
				continue
			}
			if pick == nil || (st.modelID != "" && pick.modelID == "") ||
				(st.modelID != "" == (pick.modelID != "") && st.tier < pick.tier) {
				pick, pickID = st, id
			}
		}
		// The grid reads tier 0 off pool O and tier 4 off pool A, so the pool
		// decides which kind of lead this is — but only price confirms it. An
		// elite is the scarce top of its pool, a drain bucket is not; a scoped
		// bucket that fits neither shape is some other quota window and is left
		// on the ordinary ladder.
		var top float64
		for _, m := range cands {
			if m.ID != pickID && m.Cost.Input > top {
				top = m.Cost.Input
			}
		}
		specialTierNo := -1
		if pick != nil {
			c := cands[0].Cost.Input
			for _, m := range cands {
				if m.ID == pickID {
					c = m.Cost.Input
				}
			}
			if pool == "A" && c >= top {
				specialTierNo = 4
			} else if pool == "O" && c < top {
				specialTierNo = 0
			}
		}
		// Fallback when no bucket named an elite. The quota report is not always
		// there to ask — it turns out to vary with the ambient auth environment,
		// and the failure is silent and expensive: with the elite left on the
		// ordinary ladder it becomes tier 3, so every routine "smart" request
		// drains the scarce bucket that exists precisely to be spent on purpose.
		// Price is legitimate evidence here. It says nothing about entitlement,
		// which is why the reachability probe exists, but a model in its own
		// price class is by definition not the everyday workhorse.
		if specialTierNo < 0 && pool == "A" && len(cands) > 1 {
			lead, next := cands[0], 0.0
			for _, m := range cands {
				if m.Cost.Input > lead.Cost.Input {
					lead = m
				}
			}
			for _, m := range cands {
				if m.ID != lead.ID && m.Cost.Input > next {
					next = m.Cost.Input
				}
			}
			if next > 0 && lead.Cost.Input >= 2*next {
				specialTierNo, pickID = 4, lead.ID
			}
		}
		// The bucket label comes from the quota scope when one named this lead.
		// The price fallback has no scope to read, so it names the bucket after
		// the tier it inferred — tier 4 is the elite window by construction.
		specialBucket := ""
		switch {
		case pick != nil:
			specialBucket = bucketName(pool, pick.tier)
		case specialTierNo == 4:
			specialBucket = bucketName(pool, "fable")
		case specialTierNo == 0:
			specialBucket = bucketName(pool, "spark")
		}
		var elite ompModel
		var ladderCands []ompModel
		for _, m := range cands {
			if specialTierNo < 0 || m.ID != pickID {
				ladderCands = append(ladderCands, m)
				continue
			}
			if specialTierNo == 4 {
				elite = m
			}
			rungs[pool] = append(rungs[pool], rung{m, specialTierNo, specialBucket})
		}
		// An elite defines the scarce, expensive class. Anything priced at or
		// above it is a sibling elite rather than a tier-3 workhorse, and must
		// not be crowned "smart" — claude-mythos-5 is exactly that trap: same
		// price as claude-fable-5, and 404 on accounts that do not have it.
		if elite.ID != "" {
			var kept []ompModel
			for _, m := range ladderCands {
				if m.Cost.Input < elite.Cost.Input {
					kept = append(kept, m)
				}
			}
			ladderCands = kept
		}
		ladder := pickLadder(ladderCands)
		if len(ladder) < 3 {
			name := "OpenAI/Codex"
			if pool == "A" {
				name = "Anthropic"
			}
			hint := "code assumes both Anthropic and OpenAI are set up in omp"
			if probe != nil {
				hint += "; models the provider reported as non-existent were dropped by the probe"
			}
			return "", fmt.Errorf("found %d usable %s model(s), need 3 (cheap/regular/smart) — %s", len(ladder), name, hint)
		}
		for i, m := range ladder {
			rungs[pool] = append(rungs[pool], rung{m, i + 1, bucketName(pool, "")})
		}
		sort.Slice(rungs[pool], func(i, j int) bool { return rungs[pool][i].tier < rungs[pool][j].tier })
	}

	var b strings.Builder
	b.WriteString(`# Model catalog for code's routing generator — scaffolded by 'code generate init'.
#
# REVIEW THIS FILE. The ids, costs, context and thinking levels come from your
# omp; the tier assignments are derived (newest model per family, then ranked by
# thinking ceiling, context and price) and worth a sanity check.
#
#   pool:   O = OpenAI/Codex   ·   A = Anthropic
#   tier:   1 cheap · 2 regular · 3 smart  (the per-pool fallback ladder)
#           tier 0 = a fast idle-bucket model the 'spark' toggle drains;
#           tier 4 = a scarce elite the 'fable' toggle leads with. Both are
#           detected from the quota buckets omp reports, and simply absent when
#           your providers expose no such bucket.
#   bucket: the quota window the model draws — drives the usage meter.
#   image:  false marks a text-only model, which the vision role then avoids.
#
# Re-render the catalog after any edit:  code generate
# Re-derive the tiers after a provider ships new models:  code generate init --refresh
`)
	// The marker is the whole point of probing: without it `code generate`
	// refuses the file, so an offline scaffold can never quietly become live
	// routing that names a model this account cannot call.
	if probe != nil {
		b.WriteString(`# Every model below answered a live probe, so 'code generate' will render it.
probed: true
`)
	} else {
		b.WriteString(`# NOT PROBED — scaffolded offline from --from-json, so no model here has been
# confirmed callable on your account and 'code generate' will refuse this file.
# Re-run 'code generate init --refresh' live, or flip this to true once you have
# checked each id yourself.
probed: false
`)
	}
	b.WriteString("models:\n")
	used := map[string]bool{}
	for _, pool := range []string{"O", "A"} {
		for _, r := range rungs[pool] {
			key := shortKey(r.m.ID)
			if used[key] {
				key += versionSuffix(r.m.ID)
			}
			for used[key] {
				key += "x"
			}
			used[key] = true
			speed, ttft := "50", "2.0"
			note := "    # placeholder — no probe ran (--from-json); re-run `code generate init` live to measure"
			if f, ok := probe[strings.ToLower(r.m.ID)]; ok {
				speed, ttft, note = trimFloat(f.speed), trimFloat(f.ttft), ""
			}
			b.WriteString(fmt.Sprintf(`  %s:
    id: %s
    pool: %s
    tier: %d
    bucket: %s
    cost_in: %s
    cost_out: %s
    speed: %s%s
    ttft: %s%s
    context: %d
    thinking: %s
`, key, r.m.ID, pool, r.tier, r.bucket, trimFloat(r.m.Cost.Input), trimFloat(r.m.Cost.Output),
				speed, note, ttft, note, r.m.ContextWindow, thinkingField(r.m.Thinking)))
			if !imageCapable(r.m) {
				b.WriteString("    image: false\n")
			}
		}
	}
	return b.String(), nil
}

// imageCapable reports whether omp lists image input for the model. Absent
// input data is treated as capable: every model in both pools accepts images
// today except the codex spark variants.
func imageCapable(m ompModel) bool {
	if len(m.Input) == 0 {
		return true
	}
	for _, in := range m.Input {
		if in == "image" {
			return true
		}
	}
	return false
}

func runGenerateInit(args []string) int {
	fromJSON, out := "", defaultModelsPath()
	refresh := false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--from-json":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "code generate init: --from-json needs a path")
				return 2
			}
			fromJSON = args[i]
		case "--models-file":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "code generate init: --models-file needs a path")
				return 2
			}
			out = args[i]
		case "--refresh":
			refresh = true
		case "-h", "--help":
			fmt.Print(generateHelp)
			return 0
		default:
			fmt.Fprintf(os.Stderr, "code generate init: unknown flag %q\n%s", args[i], generateHelp)
			return 2
		}
	}

	var raw []byte
	var err error
	if fromJSON != "" {
		raw, err = os.ReadFile(fromJSON)
	} else {
		raw, err = ompModelsJSON()
		if err != nil {
			fmt.Fprintln(os.Stderr, "code generate init: running `omp models --json` failed — is oh-my-pi installed? (or pass --from-json)")
			return 1
		}
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "code generate init: %v\n", err)
		return 1
	}

	// Reachability is not optional: omp lists models an account cannot call and
	// nothing in the metadata marks them, so a scaffold that skipped the probe
	// can crown a model that 404s on every launch. The live path always probes;
	// --from-json is an offline inspection path and labels its output as such.
	var facts map[string]benchFact
	if fromJSON == "" {
		sels, err := benchSelectors(raw)
		if err != nil {
			fmt.Fprintf(os.Stderr, "code generate init: %v\n", err)
			return 1
		}
		fmt.Fprintf(os.Stderr, "probing %d models for reachability and speed — real API calls, takes a minute…\n", len(sels))
		facts, err = runBench(sels)
		if err != nil {
			fmt.Fprintf(os.Stderr, "code generate init: the reachability probe failed (%v) — refusing to write a ladder that may name models your account cannot call; fix the provider credentials, or pass --from-json to scaffold offline\n", err)
			return 1
		}
	}

	yml, err := scaffoldModels(raw, facts)
	if err != nil {
		fmt.Fprintf(os.Stderr, "code generate init: %v\n", err)
		return 1
	}

	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "code generate init: %v\n", err)
		return 1
	}
	if _, err := os.Stat(out); err == nil && !refresh {
		fmt.Fprintf(os.Stderr, "code generate init: %s already exists — pass --refresh to re-derive the tiers from your current model list, or delete it first\n", out)
		return 1
	}
	if err := os.WriteFile(out, []byte(yml), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "code generate init: %v\n", err)
		return 1
	}
	verb := "wrote"
	if refresh {
		verb = "refreshed"
	}
	fmt.Printf("%s %s — review the tiers, then run `code generate`\n", verb, out)
	return 0
}

// benchSelectors lists every model the scaffolder would consider, as
// provider-qualified selectors so `omp bench` cannot fuzzy-match the wrong one.
func benchSelectors(raw []byte) ([]string, error) {
	var parsed ompModels
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("parsing model list: %w", err)
	}
	var out []string
	for _, m := range parsed.Models {
		if poolOf(m.Provider) == "" || !m.Reasoning || m.Cost.Input <= 0 || datedID.MatchString(m.ID) {
			continue
		}
		out = append(out, m.Provider+"/"+m.ID)
	}
	sort.Strings(out)
	return out, nil
}
