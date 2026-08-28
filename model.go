package main

import (
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/help"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
)

type model struct {
	generated      map[string][]string
	advisors       map[string][]string  // "level/ctx" → advisor model chain
	facts          map[string]modelFact // model id → cost ($/1M) + curated speed (tok/s)
	avail          availability
	glyphs         map[string]string
	runtimeTargets []runtimeTarget

	// Catalog capability, phrased as absence so the zero value keeps every dial:
	// a model with no catalog yet (the onboarding shell, tests) must behave as it
	// always did. applyCatalog sets these only from a catalog it actually read.
	noSpark bool // no _sp_ combos exist — hide the spark dial and force it off
	noFable bool // no _fa_/_famain_ combos — same for fable and its main child
	// hasRelief is positive-polarity: the relief segment only exists in
	// catalogs with an optional pool, so the zero value keeps old ids intact.
	hasRelief         bool // _rel_/_norel combos exist — show the relief dial
	providersResolved bool // connected-provider discovery completed
	noProviders       bool // discovery found no provider usable by this catalog
	// connected maps pool letters to "OMP holds a usable credential" — the
	// probe result behind laneUsable and the struck lane rendering.
	connected map[string]bool

	depth        int  // 0 lead · 1 full
	collapse     bool // p: hide the Routing section
	showResult   bool // in collapsed mode: show the preview full-width
	hideUsage    bool // s: hide the Usage section (atyrode/dotfiles#198); fetch state keeps running unseen
	showUsage    bool // narrow mode: show Usage full-screen instead of silently shedding it
	fullUsageIDs bool // i: expand compact Usage identities to full account addresses

	facets         []facet
	fcur           int
	sel            map[string]string
	selectionState string // CODE_SELECTION_STATE; empty keeps standalone runs stateless

	vp   viewport.Model
	spin spinner.Model
	help help.Model
	w, h int
	rdy  bool

	broker             brokerConfig
	usageCache         string
	accountState       string
	accountSelections  accountSelectionState
	accountErr         string
	manager            bool
	mgrCursor          int
	managerPreset      managerPresetState
	managerLogin       bool
	managerLoginCursor int

	fetching    bool      // a usage fetch is in flight (manual or auto)
	nextRefresh time.Time // when the next auto-refresh fires
	hadUsage    bool      // a successful central fetch has landed
	usageStale  bool      // the last central refresh failed; prior data is retained
	barAnim     int       // first-load fill frame (1..barAnimSteps-1 = partial); 0 = inactive, bars at full value

	launchManaged      bool              // m: run CODE_OMP with no overlay (the managed defaults)
	launchUntrusted    bool              // u: run the CODE_OMP_UNTRUSTED sandbox
	launchRuntime      string            // delegated local runtime target selected via CODE_RUNTIME_BROKER
	hasSandbox         bool              // a sandbox binary exists; gates the u key
	gitRoot, gitPrefix string            // repository location for isolated worktree launches
	worktreeMode       bool              // w: launch the selected session in a fresh worktree
	genConfig          string            // generated config YAML to launch omp with (generator Enter)
	firstPrompt        string            // prompt from the suggest box, forwarded as omp's first message
	savedSel           map[string]string // selection snapshot before a live suggest preview (for revert)
	// The probed omp version (omp/<semver> from `omp --version`), fetched
	// async at startup. Zero = unknown: 17.3-only overlay keys are omitted so
	// a lagging CODE_OMP wrapper never hard-errors at launch.
	ompMajor, ompMinor int
}

// usage auto-refreshes on this cadence; a 1s tick drives the countdown.
const refreshEvery = 5 * time.Minute

type refreshTickMsg struct{}

func tickCmd() tea.Cmd {
	return tea.Tick(time.Second, func(time.Time) tea.Msg { return refreshTickMsg{} })
}

// usageMsg carries the single central account/usage snapshot fetched off the
// main thread so startup and refresh never block the TUI.
type usageMsg struct {
	avail availability
}

func fetchUsageCmd(broker brokerConfig) tea.Cmd {
	if broker.URL == "" || broker.Token == "" {
		return nil
	}
	return func() tea.Msg { return usageMsg{avail: loadAvailability(broker)} }
}

type providerAvailabilityMsg struct {
	pools map[string]bool
}

// probeProviderAvailabilityCmd asks the same OMP binary Code launches which
// providers have usable local credentials. Broker-backed installations get
// this information from their account snapshot instead.
func probeProviderAvailabilityCmd() tea.Cmd {
	return func() tea.Msg {
		pools := map[string]bool{}
		path, err := resolveLaunchPath("CODE_OMP", []string{"omp"})
		if err != nil {
			return providerAvailabilityMsg{pools: pools}
		}
		for _, provider := range providerRegistry {
			cmd := exec.Command(path, "token", provider.ID)
			cmd.Env = withoutAuthEnv(os.Environ())
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			if cmd.Run() == nil {
				pools[provider.Pool] = true
			}
		}
		return providerAvailabilityMsg{pools: pools}
	}
}

func (m *model) startUsageFetch() tea.Cmd {
	cmd := fetchUsageCmd(m.broker)
	if cmd != nil {
		m.fetching = true
	}
	return cmd
}

// First-load bar fill grows each central usage bar from empty when the first
// successful fetch replaces the loading skeleton. A dedicated bounded tick
// sequence renders labels and numbers immediately and animates only the fill.
// Manual and automatic refreshes never re-run it.
const (
	barAnimSteps    = 8
	barAnimInterval = 25 * time.Millisecond
)

// barAnimMsg advances the first-load fill to the given frame (2..barAnimSteps).
type barAnimMsg struct{ step int }

func barAnimCmd(step int) tea.Cmd {
	return tea.Tick(barAnimInterval, func(time.Time) tea.Msg { return barAnimMsg{step} })
}

// ompVersionMsg carries the probed omp version; ok=false leaves it unknown.
type ompVersionMsg struct {
	major, minor int
	ok           bool
}

// ompVersionRe parses `omp/<major>.<minor>...` anywhere in --version output.
var ompVersionRe = regexp.MustCompile(`omp/(\d+)\.(\d+)`)

// probeOmpVersionCmd resolves the same binary Enter launches and asks it for
// its version, off the main thread. A drift guard, not a feature flag: any
// failure just reads as "unknown" and version-gated keys stay off.
func probeOmpVersionCmd() tea.Cmd {
	return func() tea.Msg {
		path, err := resolveLaunchPath("CODE_OMP", []string{"omp"})
		if err != nil {
			return ompVersionMsg{}
		}
		out, err := exec.Command(path, "--version").Output()
		if err != nil {
			return ompVersionMsg{}
		}
		match := ompVersionRe.FindSubmatch(out)
		if match == nil {
			return ompVersionMsg{}
		}
		major, _ := strconv.Atoi(string(match[1]))
		minor, _ := strconv.Atoi(string(match[2]))
		return ompVersionMsg{major: major, minor: minor, ok: true}
	}
}

type gitRepoMsg struct {
	root, prefix string
	linked, ok   bool
}

func probeGitRepoCmd() tea.Cmd {
	return func() tea.Msg {
		out, err := exec.Command("git", "rev-parse", "--path-format=absolute",
			"--show-toplevel", "--show-prefix", "--git-dir", "--git-common-dir").Output()
		if err != nil {
			return gitRepoMsg{}
		}
		lines := strings.Split(strings.TrimSuffix(string(out), "\n"), "\n")
		if len(lines) != 4 {
			return gitRepoMsg{}
		}
		return gitRepoMsg{
			root:   lines[0],
			prefix: lines[1],
			linked: lines[2] != lines[3],
			ok:     true,
		}
	}
}

// ompVersionAtLeast reports a probed version ≥ major.minor; unknown is never
// "at least" anything.
func (m model) ompVersionAtLeast(major, minor int) bool {
	if m.ompMajor == 0 && m.ompMinor == 0 {
		return false
	}
	return m.ompMajor > major || (m.ompMajor == major && m.ompMinor >= minor)
}

func (m model) Init() tea.Cmd {
	cmds := []tea.Cmd{probeOmpVersionCmd(), probeGitRepoCmd()}
	if m.broker.configured() {
		cmds = append(cmds, m.startUsageFetch(), m.spin.Tick, tickCmd())
	} else if !m.providersResolved {
		cmds = append(cmds, probeProviderAvailabilityCmd())
	}
	return tea.Batch(cmds...)
}
