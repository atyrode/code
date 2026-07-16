package main

// `code generate init` — scaffold a models.yml from the user's own omp
// instance. The factual fields (id, cost, thinking) come straight from
// `omp models --json`; the judgment fields (which model fills which tier) are
// auto-guessed from cost and MUST be reviewed by the user. speed/ttft are
// rough placeholder estimates until measured.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type ompModel struct {
	Provider      string   `json:"provider"`
	ID            string   `json:"id"`
	ContextWindow int      `json:"contextWindow"`
	Reasoning     bool     `json:"reasoning"`
	Thinking      []string `json:"thinking"`
	Cost          struct {
		Input  float64 `json:"input"`
		Output float64 `json:"output"`
	} `json:"cost"`
}

type ompModels struct {
	Models []ompModel `json:"models"`
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

// shortKey derives a memorable key from a model id: the last dash-separated
// token that isn't purely a version (e.g. claude-sonnet-5 → sonnet,
// gpt-5.6-terra → terra, gpt-5.3-codex-spark → spark).
func shortKey(id string) string {
	toks := strings.Split(id, "-")
	for i := len(toks) - 1; i >= 0; i-- {
		if !regexp.MustCompile(`^[\d.]+$`).MatchString(toks[i]) {
			return strings.ToLower(toks[i])
		}
	}
	return strings.ToLower(strings.NewReplacer(".", "-", ":", "-").Replace(id))
}

// pickLadder guesses tiers 1..3 for one pool: candidates ranked by input cost,
// cheapest → tier 1, priciest → tier 3, the distinct cost nearest the middle →
// tier 2. Same-cost ties prefer the larger context window, then the shorter id
// (the canonical alias rather than a dated variant).
func pickLadder(cands []ompModel) []ompModel {
	if len(cands) == 0 {
		return nil
	}
	sort.Slice(cands, func(i, j int) bool {
		if cands[i].Cost.Input != cands[j].Cost.Input {
			return cands[i].Cost.Input < cands[j].Cost.Input
		}
		if cands[i].ContextWindow != cands[j].ContextWindow {
			return cands[i].ContextWindow > cands[j].ContextWindow
		}
		return len(cands[i].ID) < len(cands[j].ID)
	})
	// first model per distinct cost
	var distinct []ompModel
	seen := map[float64]bool{}
	for _, m := range cands {
		if !seen[m.Cost.Input] {
			seen[m.Cost.Input] = true
			distinct = append(distinct, m)
		}
	}
	switch len(distinct) {
	case 1:
		return distinct
	case 2:
		return distinct
	default:
		return []ompModel{distinct[0], distinct[len(distinct)/2], distinct[len(distinct)-1]}
	}
}

func runGenerateInit(args []string) int {
	fromJSON, out := "", defaultModelsPath()
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
		raw, err = exec.Command("omp", "models", "--json").Output()
		if err != nil {
			fmt.Fprintln(os.Stderr, "code generate init: running `omp models --json` failed — is oh-my-pi installed? (or pass --from-json)")
			return 1
		}
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "code generate init: %v\n", err)
		return 1
	}
	var parsed ompModels
	if err := json.Unmarshal(raw, &parsed); err != nil {
		fmt.Fprintf(os.Stderr, "code generate init: parsing model list: %v\n", err)
		return 1
	}

	byPool := map[string][]ompModel{}
	for _, m := range parsed.Models {
		pool := poolOf(m.Provider)
		if pool == "" || !m.Reasoning || len(m.Thinking) == 0 ||
			m.Cost.Input <= 0 || datedID.MatchString(m.ID) {
			continue
		}
		byPool[pool] = append(byPool[pool], m)
	}
	ladders := map[string][]ompModel{"O": pickLadder(byPool["O"]), "A": pickLadder(byPool["A"])}
	for pool, name := range map[string]string{"O": "OpenAI/Codex", "A": "Anthropic"} {
		if len(ladders[pool]) < 3 {
			fmt.Fprintf(os.Stderr, "code generate init: found %d usable %s model(s), need 3 (cheap/regular/smart) — code assumes both Anthropic and OpenAI are set up in omp\n", len(ladders[pool]), name)
			return 1
		}
	}

	var b strings.Builder
	b.WriteString(`# Model catalog for code's routing generator — scaffolded by 'code generate init'.
#
# REVIEW THIS FILE. The ids, costs, and thinking ranges come from your omp;
# the tier assignments are auto-guessed from price and the speed/ttft numbers
# are placeholder estimates (they only drive the TUI's speed meter).
#
#   pool:   O = OpenAI/Codex   ·   A = Anthropic
#   tier:   1 cheap · 2 regular · 3 smart  (the per-pool fallback ladder)
#           Optional extras: tier 0 on pool O = a fast idle-bucket model the
#           'spark' toggle drains; tier 4 on pool A = a scarce elite the
#           'fable' toggle leads with. Add them if you have such models.
#
# Re-render the catalog after any edit:  code generate
models:
`)
	used := map[string]bool{}
	for _, pool := range []string{"O", "A"} {
		for i, m := range ladders[pool] {
			key := shortKey(m.ID)
			for used[key] {
				key += fmt.Sprintf("%d", i+1)
			}
			used[key] = true
			b.WriteString(fmt.Sprintf(`  %s:
    id: %s
    pool: %s
    tier: %d
    cost_in: %s
    cost_out: %s
    speed: 50    # placeholder — measured tok/s if you have it
    ttft: 2.0    # placeholder — measured seconds to first token
    thinking: %s→%s
`, key, m.ID, pool, i+1, trimFloat(m.Cost.Input), trimFloat(m.Cost.Output),
				m.Thinking[0], m.Thinking[len(m.Thinking)-1]))
		}
	}

	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "code generate init: %v\n", err)
		return 1
	}
	if _, err := os.Stat(out); err == nil {
		fmt.Fprintf(os.Stderr, "code generate init: %s already exists — review or delete it first\n", out)
		return 1
	}
	if err := os.WriteFile(out, []byte(b.String()), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "code generate init: %v\n", err)
		return 1
	}
	fmt.Printf("wrote %s — review the tier guesses, then run `code generate`\n", out)
	return 0
}
