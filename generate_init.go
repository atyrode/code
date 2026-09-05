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

// poolOf maps an omp provider id to its catalog pool letter via the registry;
// providers outside the registry (google, groq, ollama, …) map to "" and are
// dropped from the scaffold, as ever.
func poolOf(provider string) string {
	if p := providerByID(provider); p != nil {
		return p.Pool
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

// pickLadder chooses the capability ladder for one pool from an already-
// superseded candidate set: the cheapest candidate is tier 1, the most capable
// is the top tier, and the tiers between them are the most capable candidates
// priced strictly in between, ordered by price ascending.
//
// The depth is pool-generic, not per-provider: a pool with three usable
// candidates gets three rungs and a pool with four or more gets four, so a
// provider shipping a fourth model needs no code change here. Four is the hard
// cap — the catalog's ladder array runs tiers 0..4 and the model dial has four
// notches, so a fifth rung would be unreachable by any combo.
func pickLadder(cands []ompModel) []ompModel {
	if len(cands) < 3 {
		return cands
	}
	sort.Slice(cands, func(i, j int) bool { return cheaper(cands[i], cands[j]) })
	depth := len(cands)
	if depth > 4 {
		depth = 4
	}
	t1, rest := cands[0], cands[1:]
	top := rest[0]
	for _, m := range rest[1:] {
		if moreCapable(m, top) {
			top = m
		}
	}
	// Everything priced strictly between the two ends, most capable first.
	// rest is already in price order and the sort is stable, so a tie on
	// capability keeps the cheaper model — the same choice the single-slot
	// scan made before this generalised to more than one middle rung.
	var mid []ompModel
	for _, m := range rest {
		if m.ID == top.ID || m.Cost.Input <= t1.Cost.Input || m.Cost.Input >= top.Cost.Input {
			continue
		}
		mid = append(mid, m)
	}
	sort.SliceStable(mid, func(i, j int) bool { return moreCapable(mid[i], mid[j]) })
	need := depth - 2
	if len(mid) > need {
		mid = mid[:need]
	}
	if len(mid) < need {
		// No room between the rungs — the remaining candidates all sit at the
		// cheap end's price or at/above the top's. Fall back to the price-
		// ordered remainder starting at the median, which for a three-candidate
		// pool is exactly the one model that is neither end.
		used := map[string]bool{t1.ID: true, top.ID: true}
		for _, m := range mid {
			used[m.ID] = true
		}
		var pool []ompModel
		for _, m := range rest {
			if !used[m.ID] {
				pool = append(pool, m)
			}
		}
		for i := 0; len(mid) < need && i < len(pool); i++ {
			mid = append(mid, pool[(len(pool)/2+i)%len(pool)])
		}
	}
	sort.Slice(mid, func(i, j int) bool { return cheaper(mid[i], mid[j]) })
	return append(append([]ompModel{t1}, mid...), top)
}

// ompUsageJSON fetches the provider quota report; a var so tests and the
// onboarding flow can stub it. Failure is never fatal — the special tiers it
// feeds are optional.
var ompUsageJSON = func() ([]byte, error) {
	return exec.Command("omp", "usage", "--json").Output()
}

// specialTier is a quota bucket omp scopes to a subset of a provider's models
// rather than to the provider as a whole — today that is the codex spark drain
// bucket. omp names the bucket itself, so the scaffolder reads it rather than
// guessing which model is the cheap idle drain; the guess used to be "nobody,
// ever", which left the spark dial dead on every scaffold.
//
// The scope carries a `tier` string (omp 18.0.11 still reports it — Anthropic's
// retired 7d fable window arrived as tier "fable"), which is what this parse
// keys on. Window identity (scope.windowId, window.id) is the usage meter's
// business, not the scaffolder's, and is deliberately not read here.
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
// matched against the model family, which is where the label comes from (a
// "spark" tier names the gpt-*-codex-spark family, and Anthropic's retired
// "Claude 7 Day (Fable)" window named the claude-fable-* family the same way).
// A match here is not itself a promotion: the caller still requires the pool to
// declare a lead tier of that shape, so a scoped bucket for a pool with no
// declared lead — pool A since the 7d fable window was retired — resolves fine
// and then changes nothing. Matching by name and not by price matters:
// claude-mythos-5 lists at claude-fable-5's exact price but is not served on
// every account.
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
	base := providerByPool(pool).BucketBase
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

// benchFact is one model's probe outcome, and the four-way split is this file's
// central safety property — each outcome licenses a different action and they
// must never be collapsed:
//
//   - reachable: the model answered. It may become a rung, and its measured
//     speed/ttft go into the scaffold.
//   - notFound: the provider denies the model exists for this account. A
//     definitive negative verdict on entitlement, so the model is dropped
//     silently — it was never ours to route to.
//   - blocked: the model exists and this account is entitled to it, but the
//     provider refuses the call for a reason the operator can fix. The live
//     case is Anthropic's client-version gate: claude-fable-5-1 is listed and
//     entitled, yet every call returns 400 invalid_request_error with
//     "claude_code_version_too_old" and "Claude Code 2.1.246 does not support
//     this model; version 2.1.251 or newer is required". Like notFound this is
//     definitive and permanent — retrying changes nothing until the client is
//     upgraded — so the model is dropped rather than poisoning the run. Unlike
//     notFound it is not the operator's settled state, so the drop must be
//     announced: scaffoldModels writes a named warning into models.yml.
//   - unresolved (neither flag, reachable false): a transport, auth or rate
//     failure. It says nothing either way about entitlement, so it must not be
//     guessed in either direction and the whole scaffold refuses.
type benchFact struct {
	speed, ttft float64
	reachable   bool
	notFound    bool
	blocked     bool
	why         string
}

// notFoundProbe matches the failure that is genuinely disqualifying: the
// provider denying the model exists. claude-mythos-5 answers exactly this way
// while listing at claude-fable-5's price, context and thinking range.
var notFoundProbe = regexp.MustCompile(`(?i)not_found|model_not_found|no such model|unknown model|does not exist`)

// versionBlockedProbe matches the client-version gate. The provider is saying
// the model is real and entitled but this client build cannot speak to it, so
// it is neither a 404 nor a blip. Matched ahead of notFoundProbe because the
// wording ("does not support this model") sits uncomfortably close to it.
var versionBlockedProbe = regexp.MustCompile(`(?i)claude_code_version_too_old|does not support this model`)

// ompBenchJSON probes models with omp's own benchmark; a var so tests can stub
// it. One short run per model: this is mandatory on every init and every
// first-run onboarding, and reachability is binary — extra runs or tokens would
// only steady a throughput figure at the cost of a longer wait.
//
// The prompt is overridden deliberately. omp's bundled bench prompt reads as
// cyber content to Anthropic's safety layer, and the claude-fable-* models
// refuse it — which would have deleted a perfectly callable top rung from the
// ladder. A probe that decides eligibility has to ask something nothing can
// object to. --profile chat is not optional cosmetics: since omp 18.x, `--prompt`
// without a profile fails the whole invocation with "--prompt requires --profile
// chat or generation", which took `code generate init` down on every run.
var ompBenchJSON = func(selectors []string) ([]byte, error) {
	args := append([]string{"bench"}, selectors...)
	return exec.Command("omp", append(args,
		"--json", "--runs", "1", "--max-tokens", "4",
		"--profile", "chat",
		"--prompt", "Reply with the single word: ok")...).Output()
}

// runBench sorts each model into the outcomes benchFact describes and records
// throughput for the ones that answered. It deliberately does not collapse
// "refused" or "rate limited" into "unreachable": omp lists models an account
// cannot call (claude-mythos-5, at claude-fable-5's exact price), but a failed
// request is evidence of that only when the provider says the model does not
// exist, or names a client-version gate. Everything else is unresolved, and the
// caller must not guess.
func runBench(selectors []string) (map[string]benchFact, error) {
	raw, err := ompBenchJSON(selectors)
	if len(raw) == 0 {
		if err == nil {
			err = fmt.Errorf("no output")
		}
		return nil, fmt.Errorf("running `omp bench`: %w", err)
	}
	// omp 18.x renamed the per-model aggregate from `average` to `stats` and
	// turned every metric into a distribution object ({mean,min,p50,p95,max})
	// rather than a bare float, and dropped the per-model `failures` count. The
	// old shape parsed into zero values against the new payload, so `Average`
	// was always nil and EVERY reachable model fell through to "incomplete
	// probe report" — which made the run refuse the whole ladder. Reachability
	// is therefore derived from the runs themselves (all ok, at least one),
	// never from an aggregate that a schema change can quietly empty.
	type metric struct {
		Mean float64 `json:"mean"`
	}
	var parsed struct {
		Models []struct {
			Model   string `json:"model"`
			Results []struct {
				OK    bool   `json:"ok"`
				Error string `json:"error"`
			} `json:"results"`
			Stats *struct {
				TTFTMs *metric `json:"ttftMs"`
				// generationTps is the streaming rate; tokensPerSecond folds
				// the startup wait into the same figure. effTPS (facets.go)
				// already composes ttft with the streaming rate itself, so
				// taking tokensPerSecond here would charge for time-to-first
				// token twice and read a 62 t/s haiku as 5 t/s.
				GenerationTps   *metric `json:"generationTps"`
				TokensPerSecond *metric `json:"tokensPerSecond"`
			} `json:"stats"`
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
		ok := len(m.Results) > 0
		for _, r := range m.Results {
			if !r.OK {
				ok = false
			}
		}
		speed, ttft, measured := 0.0, 0.0, false
		if m.Stats != nil {
			if m.Stats.GenerationTps != nil {
				speed, measured = m.Stats.GenerationTps.Mean, true
			} else if m.Stats.TokensPerSecond != nil {
				speed, measured = m.Stats.TokensPerSecond.Mean, true
			}
			if m.Stats.TTFTMs != nil {
				ttft = m.Stats.TTFTMs.Mean
			}
		}
		switch {
		case why == "" && ok && measured:
			out[id] = benchFact{
				speed:     math.Round(speed*10) / 10,
				ttft:      math.Round(ttft/10) / 100,
				reachable: true,
			}
		case versionBlockedProbe.MatchString(why):
			out[id] = benchFact{blocked: true, why: why}
		case notFoundProbe.MatchString(why):
			out[id] = benchFact{notFound: true, why: why}
		default:
			if why == "" {
				why = "incomplete probe report — no timing stats or no runs recorded"
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
	var unresolved, blocked, unpriced []string
	byPool := map[string][]ompModel{}
	siblings := siblingPrices(parsed.Models)
	for _, m := range parsed.Models {
		pool := poolOf(m.Provider)
		if pool == "" || !m.Reasoning || len(m.Thinking) == 0 ||
			datedID.MatchString(m.ID) || skipModel(m.ID) {
			continue
		}
		// A price-ranked ladder cannot place a model that has no price, and
		// the meters would read it as free. omp's own table lags a launch by
		// a release or two, so a brand-new flagship arrives at $0 — which used
		// to drop it silently, and a silent drop of the operator's newest model
		// is the one outcome worse than a wrong rung. Fill the blank from the
		// same model's priced row under another provider (siblingPrices);
		// otherwise drop it, but say so in the file.
		if !priced(&m, siblings) {
			unpriced = append(unpriced, m.ID)
			continue
		}
		// A model omp lists but the account cannot call is worse than useless on
		// the ladder: it looks top-spec and 404s at launch, and no metadata
		// distinguishes it. claude-mythos-5 is the standing example — it lists at
		// claude-fable-5's exact price, context and thinking range, and 404s
		// here. That one is now settled and skipped outright (skippedModels), so
		// it never reaches this filter; the general shape of the problem is not
		// settled, and only a live call separates a top rung from a lookalike.
		// This probe, not a price heuristic, is what decides: the old "anything
		// priced at or above the elite is a sibling elite" guard is gone, so the
		// probe is the sole remaining defence and must never be bypassed.
		//
		// Only two verdicts are the scaffolder's to act on unilaterally, and
		// they act differently (see benchFact): notFound drops the model
		// silently, blocked drops it with a warning the operator can act on, and
		// anything else is unresolved and forfeits the whole run.
		//
		// This filter runs before supersede(), which matters: dropping a blocked
		// claude-fable-5-1 leaves its family sibling claude-fable-5 — which
		// probes fine — as the family's newest survivor, so it becomes the top
		// rung. Graceful degradation to the best callable model, not a hole in
		// the ladder.
		if probe != nil {
			f, seen := probe[strings.ToLower(m.ID)]
			switch {
			case f.notFound:
				continue
			case f.blocked:
				blocked = append(blocked, m.ID+": "+f.why)
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
	// operator decide. Models the provider explicitly disowned, and models a
	// client-version gate blocks, are already gone above and deliberately absent
	// from this list — both are settled verdicts, not open questions.
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
	for _, pool := range fallbackPoolOrder {
		required := providerByPool(pool).Required
		cands := supersede(byPool[pool])
		if !required && len(cands) == 0 {
			// A missing optional provider is the normal state: the catalog
			// simply grows no lanes for its pool.
			continue
		}
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
		// A tier-scoped bucket is only a lead when the pool declares that kind
		// of lead and the model's price agrees. Today the sole declared kind is
		// tier 0, the idle drain bucket: its model is cheap relative to the rest
		// of the pool, so a scoped bucket whose model prices like the pool's top
		// is some other quota window and stays on the ordinary ladder.
		//
		// There used to be a tier-4 arm here that lifted Anthropic's fable model
		// off the ladder into a "scarce elite" of its own, because it drew a
		// separate 7d quota window. Anthropic retired that window: the top model
		// now spends the same quota as the rest of the pool, so it is simply the
		// ladder's top rung and pickLadder places it. Nothing special about it
		// survives except its reachability, which the probe above decides.
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
			if poolDeclaresSpecialTier(pool, 0) && c < top {
				specialTierNo = 0
			}
		}
		// The bucket label always comes from the quota scope, since a lead only
		// exists when a scope named one.
		specialBucket := ""
		if specialTierNo >= 0 {
			specialBucket = bucketName(pool, pick.tier)
		}
		var ladderCands []ompModel
		for _, m := range cands {
			if specialTierNo < 0 || m.ID != pickID {
				ladderCands = append(ladderCands, m)
				continue
			}
			rungs[pool] = append(rungs[pool], rung{m, specialTierNo, specialBucket})
		}
		ladder := pickLadder(ladderCands)
		if len(ladder) < 3 && required {
			name := providerByPool(pool).Label
			hint := "code assumes " + requiredProviderNames() + " are set up in omp"
			if probe != nil {
				hint += "; models the provider reported as non-existent, or refused for a client-version reason, were dropped by the probe"
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
#   pool:   O = OpenAI/Codex   ·   A = Anthropic   ·   D = DeepSeek
#   tier:   1..N = the per-pool capability ladder, cheapest first (N is 3 or 4,
#           depending on how many usable models the pool offers). Tier 4 is the
#           optional top rung the model dial's 'elite' notch reaches; a pool
#           without one simply stops at 3 and 'elite' routes like 'smart'.
#           tier 0 = a fast idle-bucket model the 'spark' toggle drains,
#           detected from the quota buckets omp reports and simply absent when
#           your providers expose no such bucket.
#   bucket: the quota window the model draws — drives the usage meter.
#   image:  false marks a text-only model, which the vision role then avoids.
#
# Re-render the catalog after any edit:  code generate
# Re-derive the tiers after a provider ships new models:  code generate init --refresh
`)
	// A blocked model is dropped from the ladder, but never quietly: the
	// operator's newest model is missing from a file they are about to review,
	// and unlike a 404 the cause is on their side of the wire and fixable. Name
	// each one and quote the provider's own verdict so the fix is self-service.
	if len(blocked) > 0 {
		sort.Strings(blocked)
		b.WriteString(`#
# WARNING — models dropped because your client cannot call them. Your provider
# lists them and your account is entitled to them, but every call was refused:
`)
		for _, s := range blocked {
			b.WriteString("#   " + strings.Join(strings.Fields(s), " ") + "\n")
		}
		b.WriteString("# Upgrade the client it names, then re-run 'code generate init --refresh'.\n")
	}
	// An unpriced model is dropped for the scaffolder's sake, not the
	// operator's: omp will price it in a later release, and until then the
	// operator can write the rung in by hand. Name it so they know to.
	if len(unpriced) > 0 {
		sort.Strings(unpriced)
		b.WriteString(`#
# WARNING — models dropped because omp lists no price for them under any
# provider, and a ladder ranked by price cannot place what it cannot price:
`)
		for _, id := range unpriced {
			b.WriteString("#   " + id + "\n")
		}
		b.WriteString("# Add the rung by hand with the provider's published cost_in/cost_out, or\n# upgrade omp once its model table carries a price and re-run 'code generate init --refresh'.\n")
	}
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
	for _, pool := range fallbackPoolOrder {
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

// skippedModels are model ids the scaffolder must not even probe. This is the
// only place in the tree that spells a model id, and it earns the exception
// by encoding a fact no metadata expresses.
//
// claude-mythos-5 is the standing case. It advertises claude-fable-5's exact
// price, context window and thinking range, and 404s here — the operator has
// confirmed there is no entitlement and none is expected. The probe already
// dropped it on the 404, so this list is not what keeps it off the ladder; what
// this buys is the probe call itself. A denied model is the slowest row in the
// report by a wide margin (its 404 retries dominated a seven-minute run), for a
// verdict that is known in advance.
//
// Keep it short and keep it justified: a model belongs here only while its
// unavailability is settled and expected. Anything provisional should stay in
// the probe's hands, which is where an outcome that might change belongs.
var skippedModels = map[string]bool{
	"claude-mythos-5": true,
}

func skipModel(id string) bool { return skippedModels[strings.ToLower(id)] }

// siblingPrices indexes every priced row of the payload by bare model id — the
// id with any reseller prefix stripped, so openrouter's "openai/gpt-6-astra"
// files under "gpt-6-astra". It is the fill for a pool row omp lists at $0.
//
// omp's model table lags a launch, but unevenly: the provider's own row
// (openai-codex, the one the pool registry reads) arrived with cost 0 and every
// spec of the top rung, while the same model under openrouter carried the
// price from day one. A price-ranked scaffolder would drop the flagship or
// crown it the cheap rung; asking omp's other rows keeps omp the only source
// of prices and needs no table of rates to retire when the row catches up.
// Where siblings disagree the highest wins: a reseller discounts, it does not
// mark up, so the highest is the one nearest the provider's own rate.
func siblingPrices(models []ompModel) map[string][2]float64 {
	out := map[string][2]float64{}
	for _, m := range models {
		if m.Cost.Input <= 0 {
			continue
		}
		id := strings.ToLower(m.ID)
		if i := strings.LastIndexByte(id, '/'); i >= 0 {
			id = id[i+1:]
		}
		if cur, ok := out[id]; !ok || m.Cost.Input > cur[0] {
			out[id] = [2]float64{m.Cost.Input, m.Cost.Output}
		}
	}
	return out
}

// priced reports whether the model carries a usable price, filling omp's blank
// from a priced sibling row first. Everything the scaffolder ranks or probes
// goes through here so the two agree on which models exist.
func priced(m *ompModel, siblings map[string][2]float64) bool {
	if m.Cost.Input <= 0 {
		if sp, ok := siblings[strings.ToLower(m.ID)]; ok {
			m.Cost.Input, m.Cost.Output = sp[0], sp[1]
		}
	}
	return m.Cost.Input > 0
}

// benchSelectors lists every model the scaffolder would consider, as
// provider-qualified selectors so `omp bench` cannot fuzzy-match the wrong one.
func benchSelectors(raw []byte) ([]string, error) {
	var parsed ompModels
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("parsing model list: %w", err)
	}
	var out []string
	siblings := siblingPrices(parsed.Models)
	for _, m := range parsed.Models {
		if poolOf(m.Provider) == "" || !m.Reasoning || !priced(&m, siblings) ||
			datedID.MatchString(m.ID) || skipModel(m.ID) {
			continue
		}
		out = append(out, m.Provider+"/"+m.ID)
	}
	sort.Strings(out)
	return out, nil
}
