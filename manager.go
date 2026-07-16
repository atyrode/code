package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"

	clikit "github.com/atyrode/cli-kit"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// loginDoneMsg reports that a suspended login handoff for a vault has finished.
type loginDoneMsg struct {
	vault string
	err   error
}

var errLoginCancelled = errors.New("login cancelled")

// loginProcess keeps upstream stderr buffered until the handoff finishes. OMP
// v17 can close readline while cancelling browser authentication, then print an
// ERR_USE_AFTER_CLOSE stack trace and exit non-zero. Treat that exact failure
// as cancellation; preserve every other diagnostic verbatim.
type loginProcess struct {
	cmd            *exec.Cmd
	stderr         bytes.Buffer
	terminalStderr io.Writer
}

func (p *loginProcess) SetStdin(r io.Reader)  { p.cmd.Stdin = r }
func (p *loginProcess) SetStdout(w io.Writer) { p.cmd.Stdout = w }
func (p *loginProcess) SetStderr(w io.Writer) { p.terminalStderr = w }

func (p *loginProcess) Run() error {
	p.cmd.Stderr = &p.stderr
	err := p.cmd.Run()
	diagnostic := p.stderr.String()
	if strings.Contains(diagnostic, "ERR_USE_AFTER_CLOSE") &&
		strings.Contains(diagnostic, "readline was closed") {
		return errLoginCancelled
	}
	if p.terminalStderr != nil && diagnostic != "" {
		_, _ = io.WriteString(p.terminalStderr, diagnostic)
	}
	return err
}

// loginCmd suspends Bubble Tea and runs the plain-OMP login handoff for the
// cursored vault in the terminal, then reports completion so the vault can be
// refreshed. Login reaches the vault's OWN profile store (never the shared
// default) because it establishes the credentials the broker later serves.
func (m model) loginCmd(i int, provider string) tea.Cmd {
	if i < 0 || i >= len(m.vaults) {
		return nil
	}
	v := m.vaults[i]
	raw := os.Getenv("CODE_OMP_RAW")
	if raw == "" {
		raw = "omp"
	}
	c := exec.Command(raw, loginArgv(v.Profile, provider)...)
	p := &loginProcess{cmd: c}
	return tea.Exec(p, func(err error) tea.Msg {
		return loginDoneMsg{vault: v.ID, err: err}
	})
}

const managerEditDisabled = "vault editing is disabled: no writable machine-local manifest (CODE_AUTH_VAULTS JSON overrides are read-only)"

func syntheticFallback(vaults []vault) bool {
	return len(vaults) == 1 && vaults[0].ID == "default" &&
		vaults[0].BrokerURL == "" && vaults[0].TokenFile == "" && vaults[0].SnapshotCache == ""
}

// commitManagerInput writes the complete validated manifest before changing
// model state. Create derives metadata only; rename changes only Label.
func (m *model) commitManagerInput() error {
	switch m.managerInput {
	case "create":
		existing := m.vaults
		replacingFallback := syntheticFallback(existing)
		if replacingFallback {
			existing = nil
		}
		v, err := newVault(m.managerText, existing)
		if err != nil {
			return err
		}
		next := append(append([]vault(nil), existing...), v)
		if err := writeVaultManifest(m.vaultManifest, next); err != nil {
			return err
		}
		m.vaults = next
		m.mgrCursor = len(next) - 1
		if replacingFallback {
			m.selected = v.ID
			m.disabled = map[string]bool{}
		}
		if m.vaultUsage == nil {
			m.vaultUsage = map[string]availability{}
		}
	case "rename":
		if m.mgrCursor < 0 || m.mgrCursor >= len(m.vaults) {
			return errors.New("no vault is selected")
		}
		label := strings.TrimSpace(m.managerText)
		if label == "" {
			return errors.New("vault name cannot be empty")
		}
		next := append([]vault(nil), m.vaults...)
		next[m.mgrCursor].Label = label
		if err := writeVaultManifest(m.vaultManifest, next); err != nil {
			return err
		}
		m.vaults = next
	default:
		return errors.New("no vault edit is active")
	}
	m.managerInput = ""
	m.managerText = ""
	return nil
}

func (m model) updateManagerInput(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "esc":
		m.managerInput, m.managerText, m.vaultErr = "", "", ""
	case "enter":
		if err := m.commitManagerInput(); err != nil {
			m.vaultErr = err.Error()
		} else {
			m.vaultErr = ""
		}
	case " ":
		m.managerText += " "
	case "backspace", "ctrl+h":
		runes := []rune(m.managerText)
		if len(runes) > 0 {
			m.managerText = string(runes[:len(runes)-1])
		}
	default:
		if msg.Type == tea.KeyRunes {
			m.managerText += string(msg.Runes)
		}
	}
	return m, nil
}

// updateManager handles keys while the vault manager is open. Every action is
// scoped to the manager; the generator keys stay inert until it closes.
func (m model) updateManager(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.loginRunning {
		return m, nil
	}
	if m.managerInput != "" {
		return m.updateManagerInput(msg)
	}
	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "esc", "v":
		m.manager = false
		m.relayout()
		return m, nil
	case "up", "k":
		if m.mgrCursor > 0 {
			m.mgrCursor--
		}
		return m, nil
	case "down", "j":
		if m.mgrCursor < len(m.vaults)-1 {
			m.mgrCursor++
		}
		return m, nil
	case "s":
		m.hideUsage = !m.hideUsage
		m.showUsage = false
		m.relayout()
		return m, nil
	case "a":
		prev := m.selected
		changed, err := m.cycleVault()
		if err != nil {
			m.vaultErr = err.Error()
			return m, nil
		}
		if changed {
			m.mgrCursor = m.activeIndex()
			m.vaultErr = ""
		}
		return m, m.afterSelectionChange(prev)
	case "enter":
		prev := m.selected
		if _, err := m.activateVault(m.mgrCursor); err != nil {
			m.vaultErr = err.Error()
			return m, nil
		}
		m.vaultErr = ""
		return m, m.afterSelectionChange(prev)
	case " ":
		prev := m.selected
		if _, err := m.toggleVault(m.mgrCursor); err != nil {
			m.vaultErr = err.Error()
			return m, nil
		}
		m.vaultErr = ""
		return m, m.afterSelectionChange(prev)
	case "n":
		if m.vaultManifest == "" {
			m.vaultErr = managerEditDisabled
			return m, nil
		}
		m.managerInput, m.managerText, m.vaultErr = "create", "", ""
		return m, nil
	case "e":
		if m.vaultManifest == "" {
			m.vaultErr = managerEditDisabled
			return m, nil
		}
		if m.mgrCursor < 0 || m.mgrCursor >= len(m.vaults) {
			m.vaultErr = "no vault is selected"
			return m, nil
		}
		m.managerInput, m.managerText, m.vaultErr = "rename", m.vaults[m.mgrCursor].Label, ""
		return m, nil
	case "r":
		return m, m.startUsageFetchAll(m.vaults)
	case "c":
		cmd := m.loginCmd(m.mgrCursor, "anthropic")
		m.loginRunning = cmd != nil
		return m, cmd
	case "o":
		cmd := m.loginCmd(m.mgrCursor, "openai-codex")
		m.loginRunning = cmd != nil
		return m, cmd
	}
	return m, nil
}

// afterSelectionChange restores cached usage without fetching. An uncached
// vault joins an existing startup prefetch when present, otherwise it starts
// one request and keeps its own loading state.
func (m *model) afterSelectionChange(prev string) tea.Cmd {
	if m.selected == prev || m.usageCmd == "" {
		return nil
	}
	id := m.activeVault().ID
	if _, cached := m.vaultUsage[id]; cached || m.vaultFetching[id] {
		m.fetching = m.vaultFetching[id]
		return nil
	}
	return m.startUsageFetch(m.activeVault())
}

// managerUsageModel scopes the existing full Usage layout to the highlighted
// vault without selecting it. Cached snapshots stay per-vault; an uncached row
// uses the same loading shape as the generator's Usage panel.
func (m model) managerUsageModel() model {
	scoped := m
	if m.mgrCursor < 0 || m.mgrCursor >= len(m.vaults) {
		return scoped
	}
	v := m.vaults[m.mgrCursor]
	scoped.selected = v.ID
	scoped.fetching = m.vaultFetching[v.ID]
	scoped.nextRefresh = m.vaultUsageNext[v.ID]
	scoped.usageStale = m.vaultUsageStale[v.ID]
	if a, ok := m.vaultUsage[v.ID]; ok {
		scoped.avail = a
		scoped.hadUsage = a.ok
	} else if v.ID != m.selected {
		scoped.avail = availability{bucket: map[string]string{}, reset: map[string]int64{}}
		scoped.hadUsage = false
	}
	return scoped
}

func (m model) managerUsagePanel() string {
	scoped := m.managerUsageModel()
	return scoped.usagePanel()
}

// managerView renders a compact vault list above the same full Usage footer
// used by the generator. The highlighted row owns that detailed panel; inline
// account and aggregate usage duplication is deliberately absent.
func (m model) managerView() string {
	title := padLeft(m.pill("vaults")+"  "+stCue.Render("isolated auth vaults · the trusted profile stays shared"), gut)
	lines := []string{title, ""}
	for i := range m.vaults {
		lines = append(lines, padLeft(m.managerRow(i, m.w-gut), gut))
	}
	if m.managerInput != "" {
		label := "New vault name"
		if m.managerInput == "rename" {
			label = "Rename vault"
		}
		lines = append(lines, "", padLeft(stKey.Render(label+": ")+m.managerText+"█", gut))
	}
	if m.vaultErr != "" {
		lines = append(lines, "", padLeft(stBrk.Render(m.vaultErr), gut))
	}
	body := strings.Join(lines, "\n")

	controls := padLeft(m.managerControls(m.w-gut), gut)
	usage := ""
	if !m.hideUsage {
		usage = m.managerUsagePanel()
	}
	controlsFooterH := lipgloss.Height(clikit.SeparatedSections(m.w, controls))
	maxUsageH := m.h - controlsFooterH - 1 - topGap - 2 // one Usage boundary plus a usable body
	if maxUsageH < 0 {
		maxUsageH = 0
	}
	if lipgloss.Height(usage) > maxUsageH {
		usage = lipgloss.NewStyle().MaxHeight(maxUsageH).Render(usage)
	}
	footer := clikit.SeparatedSections(m.w, usage, controls)
	ch := m.h - lipgloss.Height(footer)
	if ch < 1 {
		ch = 1
	}
	placed := lipgloss.Place(m.w, ch, lipgloss.Left, lipgloss.Top,
		strings.Repeat("\n", topGap)+body)
	return lipgloss.NewStyle().MaxWidth(m.w).MaxHeight(m.h).Render(
		lipgloss.JoinVertical(lipgloss.Left, placed, footer))
}

// managerRow renders only list state and immutable profile context. Provider
// accounts and usage live once in the highlighted row's full Usage panel.
func (m model) managerRow(i, w int) string {
	v := m.vaults[i]
	acc := m.accent()

	cursor := "  "
	if i == m.mgrCursor {
		cursor = lipgloss.NewStyle().Foreground(lipgloss.Color(acc)).Render("▸ ")
	}
	var mark string
	switch {
	case v.ID == m.selected:
		mark = lipgloss.NewStyle().Foreground(lipgloss.Color(cGreen)).Render("● ")
	case !m.isEnabled(i):
		mark = stDim.Render("· ")
	default:
		mark = stDim.Render("○ ")
	}
	label := v.Label
	if label == "" {
		label = v.ID
	}
	labelPlain := pad(label, 10)
	var labelCol string
	switch {
	case !m.isEnabled(i):
		labelCol = stStruck.Render(labelPlain)
	case v.ID == m.selected:
		labelCol = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(cHead)).Render(labelPlain)
	default:
		labelCol = stHead.Render(labelPlain)
	}
	row := cursor + mark + labelCol
	profile := stDim.Render("  profile " + v.Profile)
	if lipgloss.Width(row)+lipgloss.Width(profile) <= w {
		row += profile
	}
	if disabled := stDim.Render("  disabled"); !m.isEnabled(i) &&
		lipgloss.Width(row)+lipgloss.Width(disabled) <= w {
		row += disabled
	}
	return row
}

// managerControls wraps labelled actions without dropping create, rename, Usage
// visibility, or provider/profile login context.
func (m model) managerControls(w int) string {
	v := m.activeVault()
	if m.mgrCursor >= 0 && m.mgrCursor < len(m.vaults) {
		v = m.vaults[m.mgrCursor]
	}
	if m.managerInput != "" {
		return clikit.WrapHelp(m.help, w, []clikit.HelpItem{
			{Key: "⏎", Description: "save"},
			{Key: "esc", Description: "cancel"},
		})
	}
	usageAction := "hide usage"
	if m.hideUsage {
		usageAction = "show usage"
	}
	items := []clikit.HelpItem{
		{Key: "↑↓", Description: "move"},
		{Key: "⏎", Description: "select"},
		{Key: "space", Description: "enable"},
		{Key: "n", Description: "new vault"},
		{Key: "e", Description: "rename"},
		{Key: "s", Description: usageAction},
		{Key: "r", Description: "refresh"},
		{Key: "v", Description: "close"},
		{Key: "o", Description: "login Codex in profile " + v.Profile},
		{Key: "c", Description: "login Claude in profile " + v.Profile},
	}
	for _, item := range items {
		if lipgloss.Width(clikit.WrapHelp(m.help, 0, []clikit.HelpItem{item})) > w {
			items = []clikit.HelpItem{
				{Key: "↑↓", Description: "move"},
				{Key: "⏎", Description: "select"},
				{Key: "spc", Description: "enable"},
				{Key: "n", Description: "new"},
				{Key: "e", Description: "rename"},
				{Key: "s", Description: usageAction},
				{Key: "r", Description: "refresh"},
				{Key: "v", Description: "close"},
				{Key: "o", Description: "Codex login"},
				{Key: "c", Description: "Claude login"},
			}
			break
		}
	}
	return clikit.WrapHelp(m.help, w, items)
}
