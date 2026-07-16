package main

// First-run onboarding: when code starts with no catalog (and no explicit
// CODE_GENERATED), the TUI explains why a catalog is needed and builds it
// interactively — scan the user's omp for models, show the guessed ladders
// for review, render the catalog, then hand off to the normal generator.
// The whole generator is in-process Go (see generate.go), so no subprocess
// beyond `omp models --json` is involved.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	clikit "github.com/atyrode/cli-kit"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
)

type obStep int

const (
	obIntro obStep = iota
	obScanning
	obReview
	obGenerating
	obError
)

type onboarding struct {
	m    model // the real TUI, handed off once the catalog exists
	step obStep
	spin spinner.Model
	w, h int

	modelsPath  string
	catalogPath string
	existing    bool     // a models file was already there — skip the omp scan
	cat         *catalog // what the review screen shows
	scaffold    string   // pending models.yml content (when !existing)
	errMsg      string
	remedy      string
}

func newOnboarding(m model) onboarding {
	sp := spinner.New()
	sp.Spinner = spinner.Dot
	o := onboarding{m: m, spin: sp, modelsPath: defaultModelsPath(), catalogPath: defaultCatalogPath()}
	if _, err := os.Stat(o.modelsPath); err == nil {
		o.existing = true
	}
	return o
}

// The suggest-box capabilities pass through to the real TUI: clikit.Run
// detects them once at mount, so the wrapper must expose them for ctrl+o to
// stay alive after the hand-off.
func (o onboarding) Commander() clikit.Commander { return o.m.Commander() }
func (o onboarding) BoxTitle() string            { return o.m.BoxTitle() }

func (o onboarding) Init() tea.Cmd { return o.spin.Tick }

type obScanDoneMsg struct {
	scaffold string
	err      error
}

type obGeneratedMsg struct{ err error }

// obScan reads the user's omp model list and scaffolds a models file from it.
func obScan() tea.Msg {
	raw, err := ompModelsJSON()
	if err != nil {
		return obScanDoneMsg{err: fmt.Errorf("running `omp models --json`: %w", err)}
	}
	yml, err := scaffoldModels(raw)
	return obScanDoneMsg{scaffold: yml, err: err}
}

// begin advances from the intro (or a retried error) to whichever step the
// disk state calls for: review an existing models file, or scan omp.
func (o onboarding) begin() (tea.Model, tea.Cmd) {
	if _, err := os.Stat(o.modelsPath); err == nil {
		cat, err := loadCatalog(o.modelsPath)
		if err != nil {
			return o.fail(err), nil
		}
		o.existing, o.cat, o.step = true, cat, obReview
		return o, nil
	}
	o.existing, o.step = false, obScanning
	return o, tea.Batch(o.spin.Tick, obScan)
}

func (o onboarding) fail(err error) onboarding {
	o.step, o.errMsg = obError, err.Error()
	switch {
	case strings.Contains(o.errMsg, "omp models"):
		o.remedy = "Install oh-my-pi (omp) and make sure it is on PATH, then press enter to retry."
	case strings.Contains(o.errMsg, "need 3"):
		o.remedy = "code assumes omp has BOTH Anthropic and OpenAI providers set up. Add the missing provider (or hand-write " + o.modelsPath + "), then press enter to retry."
	default:
		o.remedy = "Fix the above (the models file lives at " + o.modelsPath + "), then press enter to retry."
	}
	return o
}

// generateCmd writes the models file (unless it already existed) and renders
// the catalog — the same work `code generate init` + `code generate` do.
func (o onboarding) generateCmd() tea.Cmd {
	scaffold, existing := o.scaffold, o.existing
	modelsPath, catalogPath := o.modelsPath, o.catalogPath
	return func() tea.Msg {
		if !existing {
			if err := os.MkdirAll(filepath.Dir(modelsPath), 0o755); err != nil {
				return obGeneratedMsg{err}
			}
			if err := os.WriteFile(modelsPath, []byte(scaffold), 0o644); err != nil {
				return obGeneratedMsg{err}
			}
		}
		cat, err := loadCatalog(modelsPath)
		if err != nil {
			return obGeneratedMsg{err}
		}
		if err := os.MkdirAll(filepath.Dir(catalogPath), 0o755); err != nil {
			return obGeneratedMsg{err}
		}
		return obGeneratedMsg{os.WriteFile(catalogPath, []byte(cat.renderCatalog()), 0o644)}
	}
}

func (o onboarding) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		o.w, o.h = msg.Width, msg.Height
		// Keep the real TUI's layout current so the hand-off renders right.
		if next, _ := o.m.Update(msg); next != nil {
			if mm, ok := next.(model); ok {
				o.m = mm
			}
		}
		return o, nil
	case spinner.TickMsg:
		var cmd tea.Cmd
		o.spin, cmd = o.spin.Update(msg)
		return o, cmd
	case obScanDoneMsg:
		if msg.err != nil {
			return o.fail(msg.err), nil
		}
		cat, err := loadCatalogBytes([]byte(msg.scaffold), o.modelsPath)
		if err != nil {
			return o.fail(err), nil
		}
		o.scaffold, o.cat, o.step = msg.scaffold, cat, obReview
		return o, nil
	case obGeneratedMsg:
		if msg.err != nil {
			return o.fail(msg.err), nil
		}
		// Hand off: load what was written exactly like a normal startup, then
		// the real TUI takes over for good.
		blocks := loadBlocks(o.catalogPath)
		o.m.generated = blocks
		o.m.advisors = parseAdvisors(blocks["__advisors__"])
		o.m.facts = parseFacts(blocks["__models__"])
		o.m.syncPreview()
		return o.m, o.m.Init()
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return o, tea.Quit
		case "enter":
			switch o.step {
			case obIntro, obError:
				return o.begin()
			case obReview:
				o.step = obGenerating
				return o, tea.Batch(o.spin.Tick, o.generateCmd())
			}
		}
	}
	return o, nil
}

// ladderLines renders the review table: per pool, the tiers in play with the
// model each was assigned and its input price.
func (o onboarding) ladderLines() []string {
	tierName := map[int]string{0: "spark", 1: "cheap", 2: "regular", 3: "smart", 4: "elite"}
	var out []string
	for _, p := range []struct{ label, pool string }{{"OpenAI", "O"}, {"Claude", "A"}} {
		out = append(out, clikit.StHead.Render("  "+p.label))
		for tier := 0; tier <= 4; tier++ {
			key := o.cat.ladder[p.pool][tier]
			if key == "" {
				continue
			}
			m := o.cat.models[key]
			out = append(out, fmt.Sprintf("    %-8s %-26s %s",
				tierName[tier], m.ID, clikit.StDim.Render("$"+trimFloat(m.CostIn)+"/1M in")))
		}
	}
	return out
}

func (o onboarding) View() string {
	head := clikit.StHead.Render("code · first run")
	var body []string
	switch o.step {
	case obIntro:
		src := "read your model list from omp (`omp models --json`)"
		if o.existing {
			src = "use your existing models file (" + o.modelsPath + ")"
		}
		body = []string{
			"The dials need a routing catalog — a pre-computed map of which models",
			"handle which roles for every dial combination. It doesn't exist yet.",
			"",
			"code will now:",
			"  1. " + src,
			"  2. show you which model it picked for each rung — you review",
			"  3. render the catalog and drop you into the generator",
			"",
			clikit.StDim.Render("Nothing in your omp configuration is touched. Files written:"),
			clikit.StDim.Render("  " + o.modelsPath),
			clikit.StDim.Render("  " + o.catalogPath),
			"",
			clikit.StHead.Render("enter") + " continue · " + clikit.StHead.Render("q") + " quit",
		}
	case obScanning:
		body = []string{o.spin.View() + " reading your omp model list…"}
	case obReview:
		verb := "guessed from price — sanity-check it"
		if o.existing {
			verb = "from your models file"
		}
		body = append([]string{"Model ladder (" + verb + "):", ""}, o.ladderLines()...)
		body = append(body, "",
			clikit.StDim.Render("Refine anytime: edit "+o.modelsPath+" then run `code generate`."),
			"",
			clikit.StHead.Render("enter")+" build the catalog · "+clikit.StHead.Render("q")+" quit",
		)
	case obGenerating:
		body = []string{o.spin.View() + " rendering the routing catalog…"}
	case obError:
		body = []string{
			clikit.StBrk.Render("✗ " + o.errMsg),
			"",
			o.remedy,
			"",
			clikit.StHead.Render("enter") + " retry · " + clikit.StHead.Render("q") + " quit",
		}
	}
	return "\n" + head + "\n\n" + clikit.PadLeft(strings.Join(body, "\n"), 2) + "\n"
}
