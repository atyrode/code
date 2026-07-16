package main

// The catalog generator: `code generate` renders the facet-grid catalog the TUI
// browses (see loadBlocks) from a models file, and `code generate init`
// scaffolds that models file from the user's own omp instance.
//
// This is the Go port of the dotfiles' generate-profiles.py (atyrode/dotfiles,
// pkgs/omp-configured), generalised from that setup's hard-coded model keys to
// pure pool/tier logic so it works against anyone's catalog:
//
//   - pools O (OpenAI/Codex) and A (Anthropic) must each fill tiers 1..3 —
//     the per-pool fallback ladder (cheap, regular, smart). code assumes both
//     providers are present; generation fails loudly otherwise.
//   - tier 0 (an idle-bucket speed model, "spark") and tier 4 (a scarce elite,
//     "fable") are optional; without them the corresponding facet combos are
//     simply not generated and the TUI reports "no profile for this
//     combination" when dialed there.
//
// The output format is byte-compatible with the Python generator so a catalog
// produced by either renders identically in the TUI.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// ── model catalog ─────────────────────────────────────────────────────────────

type catModel struct {
	ID       string  `yaml:"id"`
	Pool     string  `yaml:"pool"`
	Tier     int     `yaml:"tier"`
	CostIn   float64 `yaml:"cost_in"`
	CostOut  float64 `yaml:"cost_out"`
	Speed    float64 `yaml:"speed"`
	TTFT     float64 `yaml:"ttft"`
	Thinking string  `yaml:"thinking"`
}

type catalog struct {
	keys   []string            // declaration order (drives __models__ rows)
	models map[string]catModel // short key -> model
	ladder map[string][5]string
	// ladder[pool][tier] for tiers 0..4; "" = absent. Tiers 1..3 are the
	// fallback ladder; 0 is the drain/speed lead, 4 the elite lead.
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
	var modelsNode *yaml.Node
	root := doc.Content[0]
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value == "models" {
			modelsNode = root.Content[i+1]
		}
	}
	if modelsNode == nil {
		return nil, fmt.Errorf("%s: no `models:` mapping", path)
	}
	c := &catalog{models: map[string]catModel{}, ladder: map[string][5]string{"O": {}, "A": {}}}
	for i := 0; i+1 < len(modelsNode.Content); i += 2 {
		key := modelsNode.Content[i].Value
		var m catModel
		if err := modelsNode.Content[i+1].Decode(&m); err != nil {
			return nil, fmt.Errorf("%s: model %q: %w", path, key, err)
		}
		if m.Pool != "O" && m.Pool != "A" {
			return nil, fmt.Errorf("%s: model %q: pool must be O or A, got %q", path, key, m.Pool)
		}
		if m.Tier < 0 || m.Tier > 4 {
			return nil, fmt.Errorf("%s: model %q: tier must be 0..4, got %d", path, key, m.Tier)
		}
		if _, _, err := parseThinkingRange(m.Thinking); err != nil {
			return nil, fmt.Errorf("%s: model %q: %w", path, key, err)
		}
		c.keys = append(c.keys, key)
		c.models[key] = m
		l := c.ladder[m.Pool]
		if l[m.Tier] != "" {
			return nil, fmt.Errorf("%s: pool %s tier %d claimed by both %q and %q", path, m.Pool, m.Tier, l[m.Tier], key)
		}
		l[m.Tier] = key
		c.ladder[m.Pool] = l
	}
	for _, pool := range []string{"O", "A"} {
		for t := 1; t <= 3; t++ {
			if c.ladder[pool][t] == "" {
				return nil, fmt.Errorf("%s: pool %s has no tier-%d model — code assumes both an OpenAI and an Anthropic pool with tiers 1..3 filled (cheap, regular, smart)", path, pool, t)
			}
		}
	}
	return c, nil
}

func parseThinkingRange(s string) (lo, hi int, err error) {
	parts := strings.Split(s, "→")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("thinking must be \"lo→hi\" (e.g. low→max), got %q", s)
	}
	lo, okLo := thIdx(strings.TrimSpace(parts[0]))
	hi, okHi := thIdx(strings.TrimSpace(parts[1]))
	if !okLo || !okHi || lo > hi {
		return 0, 0, fmt.Errorf("invalid thinking range %q", s)
	}
	return lo, hi, nil
}

// clampTh resolves a requested level to one the model actually offers.
func (c *catalog) clampTh(key, level string) string {
	lo, hi, _ := parseThinkingRange(c.models[key].Thinking)
	i, _ := thIdx(level)
	if i < lo {
		i = lo
	}
	if i > hi {
		i = hi
	}
	return thScale[i]
}

func otherPool(p string) string {
	if p == "O" {
		return "A"
	}
	return "O"
}

// sibDown is the same-pool fallback rung below a lead: the elite (tier 4)
// falls to its pool's smart tier, tiers 2..3 fall one rung, the rest have no
// same-pool net.
func (c *catalog) sibDown(key string) string {
	m := c.models[key]
	if m.Tier == 4 {
		return c.ladder[m.Pool][3]
	}
	if m.Tier >= 2 {
		return c.ladder[m.Pool][m.Tier-1]
	}
	return ""
}

// cross is the equivalent rung on the opposite pool (elites cross to smart).
func (c *catalog) cross(key string) string {
	m := c.models[key]
	t := m.Tier
	if t > 3 {
		t = 3
	}
	return c.ladder[otherPool(m.Pool)][t]
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

// ── the facet grid ────────────────────────────────────────────────────────────

var (
	genRoleOrder = []string{"default", "task", "plan", "slow", "designer", "reviewer",
		"librarian", "sonic", "advisor", "smol", "tiny", "commit"}
	genAgentRoles = map[string]bool{"designer": true, "librarian": true, "reviewer": true, "sonic": true, "task": true}
	genDelib      = map[string]bool{"plan": true, "slow": true, "designer": true, "reviewer": true}
	// Anti-tunnel-vision: on a *-led lane the reviewer crosses to the opposite
	// provider so the output always gets an independent second eye (the advisor
	// crosses too, in its own branch).
	genCrossLed = map[string]bool{"reviewer": true}
	genUtil     = map[string]bool{"sonic": true, "smol": true, "tiny": true, "commit": true}
	// Utility roles respond to the dials but are tier-capped so none can ever
	// become expensive.
	genUtilModel = map[string]map[string]int{
		"commit": {"fast": 1, "normal": 1, "smart": 1},
		"tiny":   {"fast": 1, "normal": 1, "smart": 2},
		"smol":   {"fast": 1, "normal": 2, "smart": 2},
		"sonic":  {"fast": 1, "normal": 2, "smart": 2},
	}
	genUtilThink = map[string]map[string]string{
		"commit": {"low": "minimal", "medium": "minimal", "high": "minimal", "xhigh": "low"},
		"tiny":   {"low": "minimal", "medium": "low", "high": "low", "xhigh": "low"},
		"smol":   {"low": "low", "medium": "low", "high": "medium", "xhigh": "medium"},
		"sonic":  {"low": "low", "medium": "medium", "high": "medium", "xhigh": "medium"},
	}
	genTierMap  = map[string]int{"fast": 1, "normal": 2, "smart": 3}
	genBump     = map[string]string{"minimal": "low", "low": "medium", "medium": "high", "high": "xhigh", "xhigh": "xhigh"}
	genLanes    = []string{"gpt-only", "gpt-led", "mixed", "claude-led", "claude-only"}
	genMTiers   = []string{"fast", "normal", "smart"}
	genThinking = []string{"minimal", "low", "medium", "high", "xhigh", "max"}
	genExtremes = map[string]bool{"minimal": true, "max": true}
)

func lanePrimary(lane string) string {
	if lane == "gpt-only" || lane == "gpt-led" || lane == "mixed" {
		return "O"
	}
	return "A"
}

func lanePure(lane string) bool { return lane == "gpt-only" || lane == "claude-only" }

type roleRoute struct {
	lead  string // short key; "" = role omitted (advisor off)
	level string
	chain []string // short keys; chain levels tracked separately
	chLvl []string
}

// genCombo computes {role -> route} for one facet combination. A direct port
// of generate-profiles.py's gen(), with the hard-coded model keys generalised
// to pool/tier lookups.
func (c *catalog) genCombo(lane, mtier, thinking string, spark, fable, fableMain bool) map[string]roleRoute {
	p := lanePrimary(lane)
	base := genTierMap[mtier]
	isPure := lanePure(lane)
	extreme := genExtremes[thinking]
	sparkKey := c.ladder["O"][0]
	eliteKey := c.ladder["A"][4]

	rprov := func(r string) string {
		if isPure {
			return p
		}
		if lane == "mixed" {
			if genDelib[r] {
				return "A"
			}
			return "O"
		}
		if genCrossLed[r] {
			return otherPool(p)
		}
		return p
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
				fb = []string{c.ladder[rp][t]}
			} else {
				lead = c.ladder[rp][t]
				if r == "sonic" { // only sonic keeps a net
					if sd := c.sibDown(lead); sd != "" {
						fb = []string{sd}
					}
				}
			}
			chain := dedup(fb, lead)
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
				ap = otherPool(p)
			}
			amod := c.ladder[ap][1]
			if mtier == "smart" {
				amod = c.ladder[ap][2]
			}
			lvl, fbl := thinking, thinking
			if !extreme {
				fbl = "low"
				if mtier == "smart" {
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
			t = base + 1
			if t > 3 {
				t = 3
			}
		}
		th := thinking
		if !extreme && genDelib[r] {
			th = genBump[thinking]
		}
		// The elite leads the deliberative Claude roles when on — gated to the
		// smart/normal tiers. fable-as-main is an override: the elite takes the
		// default role on every tier, regardless of lane preference.
		fableHere := fable && eliteKey != "" &&
			((fableMain && r == "default") ||
				(genDelib[r] && rp == "A" && (mtier == "smart" || mtier == "normal")))
		lead := c.ladder[rp][t]
		if fableHere {
			lead = eliteKey
		}
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

func genComboID(lane, mtier, thinking string, spark, fable, fableMain bool) string {
	sp, fa := "nosp", "nofa"
	if spark {
		sp = "sp"
	}
	if fable {
		fa = "fa"
		if fableMain {
			fa = "famain"
		}
	}
	return fmt.Sprintf("%s_%s_%s_%s_%s", lane, mtier, thinking, sp, fa)
}

func genValid(lane string, spark, fable, fableMain bool) bool {
	if lane == "gpt-only" && fable {
		return false // no elite on pure GPT
	}
	if lane == "claude-only" && spark {
		return false // no spark on pure Claude
	}
	if fableMain && !fable {
		return false // fable-as-main only exists on top of fable
	}
	return true
}

// ── rendering (byte-compatible with generate-profiles.py) ────────────────────

func (c *catalog) renderCombo(lane, mtier, thinking string, spark, fable, fableMain bool) string {
	roles := c.genCombo(lane, mtier, thinking, spark, fable, fableMain)
	cid := genComboID(lane, mtier, thinking, spark, fable, fableMain)
	desc := []string{lane, mtier, thinking}
	if spark {
		desc = append(desc, "spark")
	}
	if fable {
		desc = append(desc, "fable")
	}
	if fable && fableMain {
		desc = append(desc, "main")
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
		for i, m := range rt.chain {
			row += fmt.Sprintf(" → %s:%s", c.models[m].ID, c.clampTh(m, rt.chLvl[i]))
		}
		lines = append(lines, strings.TrimRight(row, " "))
	}
	lines = append(lines, "")
	return strings.Join(lines, "\n")
}

func (c *catalog) renderModelFacts() string {
	lines := []string{"__models__  model facts (id in out speed ttft — $/1M in·out, tok/s, s)"}
	for _, k := range c.keys {
		m := c.models[k]
		lines = append(lines, fmt.Sprintf("  %s %s %s %s %s",
			m.ID, trimFloat(m.CostIn), trimFloat(m.CostOut), trimFloat(m.Speed), trimFloat(m.TTFT)))
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
	for _, ctx := range []struct{ name, pool string }{{"gpt", "O"}, {"claude", "A"}} {
		for _, d := range dial {
			var parts []string
			for _, rg := range d.chain {
				k := c.ladder[ctx.pool][rg.tier]
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
	b.WriteString("bundled agents: designer librarian reviewer sonic task — ● marks an agent-backed role\n\n")
	b.WriteString(c.renderAdvisors() + "\n")
	b.WriteString(c.renderModelFacts() + "\n")
	hasSpark := c.ladder["O"][0] != ""
	hasElite := c.ladder["A"][4] != ""
	for _, lane := range genLanes {
		for _, mtier := range genMTiers {
			for _, thinking := range genThinking {
				for _, spark := range []bool{true, false} {
					if spark && !hasSpark {
						continue
					}
					for _, fable := range []bool{true, false} {
						if fable && !hasElite {
							continue
						}
						for _, fableMain := range []bool{false, true} {
							if genValid(lane, spark, fable, fableMain) {
								b.WriteString(c.renderCombo(lane, mtier, thinking, spark, fable, fableMain) + "\n")
							}
						}
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

  code generate init [--from-json FILE] [--models-file OUT]
      Scaffold a models file from your omp instance (runs 'omp models --json',
      or reads FILE). Auto-guesses the pool/tier assignments — review them!

  code generate [--models-file FILE] [--out FILE|-]
      Render the catalog. Defaults: models file at
      $XDG_CONFIG_HOME/code/models.yml, output at
      $XDG_DATA_HOME/code/generated.plain (the TUI's fallback when
      CODE_GENERATED is unset).
`
