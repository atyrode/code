package main

import (
	"fmt"
	"strings"
	"time"

	clikit "github.com/atyrode/cli-kit"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

var managerProviders = []string{"anthropic", "openai-codex"}

// managerPresetState holds only transient account-manager UI state. Persisted
// selections live in model.accountSelections; a draft is never launch-visible.
type managerPresetState struct {
	editing  bool
	naming   bool
	deleting string
	name     []rune
	draft    map[accountKey]bool
}

func cloneAccountSelectionState(state accountSelectionState) accountSelectionState {
	return accountSelectionState{
		active:         state.ActiveName(),
		manualDisabled: state.ManualDisabled(),
		presets:        state.Presets(),
	}
}

func (m model) managerDisplayedDisabled() map[accountKey]bool {
	if m.managerPreset.editing {
		return m.managerPreset.draft
	}
	return m.accountSelections.CurrentDisabled()
}

func (m *model) commitAccountSelections(candidate accountSelectionState) error {
	if err := writeAccountSelectionState(m.accountState, candidate); err != nil {
		return err
	}
	m.accountSelections = candidate
	return nil
}

func (m model) managerPresetNames() []string {
	presets := m.accountSelections.Presets()
	names := make([]string, 1, len(presets)+1)
	names[0] = accountSelectionManualName
	for _, preset := range presets {
		names = append(names, preset.Name)
	}
	return names
}

func (m *model) cycleManagerPreset(delta int) error {
	names := m.managerPresetNames()
	if len(names) < 2 {
		return nil
	}
	current := 0
	for i, name := range names {
		if strings.EqualFold(name, m.accountSelections.ActiveName()) {
			current = i
			break
		}
	}
	next := (current + delta) % len(names)
	if next < 0 {
		next += len(names)
	}
	candidate := cloneAccountSelectionState(m.accountSelections)
	candidate.Activate(names[next])
	return m.commitAccountSelections(candidate)
}

func (m *model) beginManagerPresetEdit() {
	if strings.EqualFold(m.accountSelections.ActiveName(), accountSelectionManualName) {
		return
	}
	m.managerPreset = managerPresetState{
		editing: true,
		draft:   copyDisabledAccounts(m.accountSelections.CurrentDisabled()),
	}
	m.accountErr = ""
}

func (m *model) saveManagerPresetEdit() error {
	name := m.accountSelections.ActiveName()
	candidate := cloneAccountSelectionState(m.accountSelections)
	if err := candidate.UpsertPreset(name, m.managerPreset.draft); err != nil {
		return err
	}
	if err := m.commitAccountSelections(candidate); err != nil {
		return err
	}
	m.managerPreset = managerPresetState{}
	return nil
}

func (m *model) beginManagerPresetName() {
	m.managerPreset = managerPresetState{
		naming: true,
		draft:  copyDisabledAccounts(m.accountSelections.CurrentDisabled()),
	}
	m.accountErr = ""
}

func (m *model) saveNamedManagerPreset() error {
	name := strings.TrimSpace(string(m.managerPreset.name))
	if _, exists := m.accountSelections.Preset(name); exists {
		return fmt.Errorf("account preset %q already exists", name)
	}
	candidate := cloneAccountSelectionState(m.accountSelections)
	if err := candidate.UpsertPreset(name, m.managerPreset.draft); err != nil {
		return err
	}
	candidate.Activate(name)
	if err := m.commitAccountSelections(candidate); err != nil {
		return err
	}
	m.managerPreset = managerPresetState{}
	return nil
}

func (m *model) beginManagerPresetDelete() error {
	name := m.accountSelections.ActiveName()
	if strings.EqualFold(name, accountSelectionManualName) {
		return fmt.Errorf("%s cannot be deleted", accountSelectionManualName)
	}
	m.managerPreset = managerPresetState{deleting: name}
	m.accountErr = ""
	return nil
}

func (m *model) deleteActiveManagerPreset() error {
	name := m.accountSelections.ActiveName()
	if strings.EqualFold(name, accountSelectionManualName) {
		return fmt.Errorf("%s cannot be deleted", accountSelectionManualName)
	}
	if m.managerPreset.deleting != name {
		return fmt.Errorf("delete confirmation required for account preset %q", name)
	}
	visible := m.accountSelections.CurrentDisabled()
	candidate := cloneAccountSelectionState(m.accountSelections)
	candidate.SetManualDisabled(visible)
	if !candidate.DeletePreset(name) {
		return fmt.Errorf("unknown account preset %q", name)
	}
	candidate.Activate(accountSelectionManualName)
	return m.commitAccountSelections(candidate)
}

// managerAccounts is the stable, selectable account order. Provider headings
// and accounts without a broker identity key are deliberately not selectable.
func (m model) managerAccounts() []account {
	accounts := make([]account, 0)
	for _, provider := range managerProviders {
		for _, a := range m.avail.accounts[provider] {
			if a.IdentityKey != "" {
				accounts = append(accounts, a)
			}
		}
	}
	return accounts
}

func (m *model) clampManagerCursor() {
	count := len(m.managerAccounts())
	if count == 0 {
		m.mgrCursor = 0
		return
	}
	if m.mgrCursor < 0 {
		m.mgrCursor = 0
	}
	if m.mgrCursor >= count {
		m.mgrCursor = count - 1
	}
}

func (m *model) toggleManagerAccount() error {
	accounts := m.managerAccounts()
	m.clampManagerCursor()
	if len(accounts) == 0 {
		return nil
	}
	a := accounts[m.mgrCursor]
	key := accountKey{Provider: a.Provider, IdentityKey: a.IdentityKey}
	disabled := copyDisabledAccounts(m.managerDisplayedDisabled())
	if disabled[key] {
		delete(disabled, key)
	} else {
		disabled[key] = true
	}
	if m.managerPreset.editing {
		m.managerPreset.draft = disabled
		return nil
	}
	if !strings.EqualFold(m.accountSelections.ActiveName(), accountSelectionManualName) {
		return nil
	}
	candidate := cloneAccountSelectionState(m.accountSelections)
	candidate.SetManualDisabled(disabled)
	return m.commitAccountSelections(candidate)
}

// updateManager handles only account-manager controls. The generator's global
// actions remain inert until the manager closes.
func (m model) updateManager(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	m.clampManagerCursor()

	if m.managerPreset.deleting != "" {
		switch msg.String() {
		case "esc":
			m.managerPreset = managerPresetState{}
			m.accountErr = ""
		case "y":
			if err := m.deleteActiveManagerPreset(); err != nil {
				m.accountErr = err.Error()
			} else {
				m.managerPreset = managerPresetState{}
				m.accountErr = ""
			}
		}
		return m, nil
	}

	if m.managerPreset.naming {
		switch msg.String() {
		case "esc":
			m.managerPreset = managerPresetState{}
			m.accountErr = ""
		case "enter":
			if err := m.saveNamedManagerPreset(); err != nil {
				m.accountErr = err.Error()
			} else {
				m.accountErr = ""
			}
		case " ":
			m.managerPreset.name = append(m.managerPreset.name, ' ')
			m.accountErr = ""
		case "backspace", "ctrl+h":
			if count := len(m.managerPreset.name); count > 0 {
				m.managerPreset.name = m.managerPreset.name[:count-1]
			}
			m.accountErr = ""
		default:
			if msg.Type == tea.KeyRunes {
				m.managerPreset.name = append(m.managerPreset.name, msg.Runes...)
				m.accountErr = ""
			}
		}
		return m, nil
	}

	if m.managerPreset.editing {
		switch msg.String() {
		case "esc":
			m.managerPreset = managerPresetState{}
			m.accountErr = ""
		case "up", "k":
			if m.mgrCursor > 0 {
				m.mgrCursor--
			}
		case "down", "j":
			if m.mgrCursor+1 < len(m.managerAccounts()) {
				m.mgrCursor++
			}
		case " ":
			if err := m.toggleManagerAccount(); err != nil {
				m.accountErr = err.Error()
			} else {
				m.accountErr = ""
			}
		case "s":
			if err := m.saveManagerPresetEdit(); err != nil {
				m.accountErr = err.Error()
			} else {
				m.accountErr = ""
			}
		}
		return m, nil
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
		if m.mgrCursor+1 < len(m.managerAccounts()) {
			m.mgrCursor++
		}
		return m, nil
	case "left":
		if err := m.cycleManagerPreset(-1); err != nil {
			m.accountErr = err.Error()
		} else {
			m.accountErr = ""
		}
		return m, nil
	case "right":
		if err := m.cycleManagerPreset(1); err != nil {
			m.accountErr = err.Error()
		} else {
			m.accountErr = ""
		}
		return m, nil
	case " ":
		if !strings.EqualFold(m.accountSelections.ActiveName(), accountSelectionManualName) {
			m.accountErr = "press e to edit"
			return m, nil
		}
		if err := m.toggleManagerAccount(); err != nil {
			m.accountErr = err.Error()
		} else {
			m.accountErr = ""
		}
		return m, nil
	case "e":
		m.beginManagerPresetEdit()
		return m, nil
	case "n":
		m.beginManagerPresetName()
		return m, nil
	case "d":
		if err := m.beginManagerPresetDelete(); err != nil {
			m.accountErr = err.Error()
		}
		return m, nil
	case "i":
		m.fullUsageIDs = !m.fullUsageIDs
		return m, nil
	case "s":
		inlineFits := m.managerUsageFitsInline()
		switch {
		case !m.hideUsage && inlineFits:
			m.hideUsage = true
			m.showUsage = false
		case m.hideUsage:
			m.hideUsage = false
			m.showUsage = !inlineFits
		case m.showUsage:
			m.hideUsage = true
			m.showUsage = false
		default:
			m.showUsage = true
		}
		return m, nil
	case "r":
		m.accountErr = ""
		return m, m.startUsageFetch()
	}
	return m, nil
}

type managerLine struct {
	text        string
	selectable  int
	group       int
	groupHeader bool
	spacer      bool
	provider    string
}

type managerProviderRange struct {
	provider string
	start    int
	end      int
}

const (
	managerProviderBoxBorderWidth = 2
	managerProviderBoxFrameWidth  = 4
	managerAnthropicColor         = "#ff9f52"
	managerOpenAIColor            = "#62a7ff"
)

func managerAccountLabel(a account) string {
	if a.Email != "" {
		return a.Email
	}
	if a.IdentityKey != "" {
		return a.IdentityKey
	}
	return "authenticated · identity unavailable"
}

func managerProviderColor(provider string) string {
	if provider == "openai-codex" {
		return managerOpenAIColor
	}
	return managerAnthropicColor
}

func managerProviderHeading(provider string) string {
	label := "Anthropic"
	if provider == "openai-codex" {
		label = "OpenAI"
	}
	return lipgloss.NewStyle().
		Foreground(lipgloss.Color(managerProviderColor(provider))).
		Bold(true).
		Render(label)
}

func managerClipCell(text string, width int) string {
	if width <= 0 {
		return ""
	}
	return lipgloss.NewStyle().MaxWidth(width).Render(text)
}

func managerProviderContentWidth(width int) int {
	return max(0, width-managerProviderBoxFrameWidth)
}

func managerProviderRanges(lines []managerLine) []managerProviderRange {
	ranges := make([]managerProviderRange, 0, len(managerProviders))
	for start := 0; start < len(lines); {
		provider := lines[start].provider
		end := start + 1
		for end < len(lines) && lines[end].provider == provider {
			end++
		}
		if provider != "" {
			ranges = append(ranges, managerProviderRange{
				provider: provider,
				start:    start,
				end:      end,
			})
		}
		start = end
	}
	return ranges
}

func managerProviderBoxesHeight(lines []managerLine) int {
	ranges := managerProviderRanges(lines)
	if len(ranges) == 0 {
		return 0
	}
	return len(lines) + 2*len(ranges) + len(ranges) - 1
}

func managerProviderBoxes(width int, lines []managerLine, focusedProvider string) string {
	if width <= 0 || len(lines) == 0 {
		return ""
	}
	innerWidth := managerProviderContentWidth(width)
	ranges := managerProviderRanges(lines)
	boxes := make([]string, 0, len(ranges))
	for _, providerRange := range ranges {
		text := make([]string, 0, providerRange.end-providerRange.start)
		for _, line := range lines[providerRange.start:providerRange.end] {
			text = append(text, managerClipCell(line.text, innerWidth))
		}
		borderColor := cBord
		if providerRange.provider == focusedProvider {
			borderColor = managerProviderColor(providerRange.provider)
		}
		box := lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(borderColor)).
			Padding(0, 1).
			Width(max(0, width-managerProviderBoxBorderWidth)).
			Render(strings.Join(text, "\n"))
		boxes = append(boxes, managerClipCell(box, width))
	}
	return strings.Join(boxes, "\n\n")
}

func (m model) managerFocusedProvider() string {
	if !m.avail.accountsOK {
		return ""
	}
	accounts := m.managerAccounts()
	if m.mgrCursor < 0 || m.mgrCursor >= len(accounts) {
		return ""
	}
	return accounts[m.mgrCursor].Provider
}

func (m model) managerPresetSelector(width int) string {
	if name := m.managerPreset.deleting; name != "" {
		prompt := stWarn.Render("delete preset") + "  " + stHead.Render("‹ "+name+" ›")
		question := stWarn.Render("are you sure?")
		return managerClipCell(prompt, width) + "\n" + managerClipCell(question, width)
	}

	if m.managerPreset.naming {
		name := string(m.managerPreset.name)
		if name == "" {
			name = stDim.Render("type a name")
		} else {
			name = stHead.Render(name)
		}
		line := stDim.Render("new preset") + "  " + name +
			lipgloss.NewStyle().Foreground(lipgloss.Color(m.accent())).Render("▏")
		return managerClipCell(line, width)
	}

	name := m.accountSelections.ActiveName()
	line := stDim.Render("preset") + "  " + stHead.Render("‹ "+name+" ›")
	switch {
	case m.managerPreset.editing:
		line += "  " + stWarn.Render("editing draft")
	case strings.EqualFold(name, accountSelectionManualName):
		line += "  " + stDim.Render("editable")
	default:
		line += "  " + stDim.Render("read-only")
	}
	return managerClipCell(line, width)
}

func (m model) managerTitle(width int) string {
	pill := managerClipCell(m.pill("accounts"), width)
	pillWidth := lipgloss.Width(pill)
	selectorWidth := width - pillWidth - 2
	if selectorWidth <= 0 {
		return pill
	}
	selector := strings.Split(m.managerPresetSelector(selectorWidth), "\n")
	title := pill + "  " + selector[0]
	if len(selector) > 1 {
		title += "\n" + strings.Repeat(" ", pillWidth+2) + selector[1]
	}
	return managerClipCell(title, width)
}

func (m *model) managerUsageLayout(width int) (barWidth, noteWidth int) {
	lineWidth := managerProviderContentWidth(width)
	specs := make([]usageRowSpec, 0)
	for _, provider := range managerProviders {
		for _, acct := range m.avail.accounts[provider] {
			key := accountKey{Provider: acct.Provider, IdentityKey: acct.IdentityKey}
			for _, win := range m.avail.accountUsage[key] {
				if win.missing {
					continue
				}
				if m.avail.accountsStale {
					win.stale = true
				}
				specs = append(specs, m.usageRowSpec(win, "      "))
			}
		}
	}
	return usageRowsLayout(lineWidth, specs)
}

func (m model) managerLines(width int) []managerLine {
	lineWidth := managerProviderContentWidth(width)
	barWidth, noteWidth := m.managerUsageLayout(width)
	lines := make([]managerLine, 0, len(m.managerAccounts())*4+4)
	disabledAccounts := m.managerDisplayedDisabled()
	selectable := 0
	group := 0
	for _, provider := range managerProviders {
		lines = append(lines, managerLine{
			text: managerProviderHeading(provider), selectable: -1, group: -1, provider: provider,
		})
		accounts := m.avail.accounts[provider]
		switch {
		case !m.avail.accountsOK:
			lines = append(lines, managerLine{
				text: stWarn.Render("  account status unavailable"), selectable: -1, group: -1, provider: provider,
			})
		case len(accounts) == 0:
			lines = append(lines, managerLine{
				text: stBrk.Render("  not authenticated"), selectable: -1, group: -1, provider: provider,
			})
		default:
			for accountIndex, a := range accounts {
				index := -1
				if a.IdentityKey != "" {
					index = selectable
					selectable++
				}
				key := accountKey{Provider: a.Provider, IdentityKey: a.IdentityKey}
				disabled := a.IdentityKey != "" && disabledAccounts[key]
				status := "enabled"
				if disabled {
					status = "off"
				} else if a.IdentityKey == "" {
					status = "unavailable"
				}

				cursor := "  "
				if index == m.mgrCursor {
					cursor = lipgloss.NewStyle().
						Foreground(lipgloss.Color(m.accent())).
						Render("▸ ")
				}
				mark := lipgloss.NewStyle().
					Foreground(lipgloss.Color(cGreen)).
					Render("● ")
				labelStyle, statusStyle := stHead, stHead
				if disabled {
					mark = stDim.Render("○ ")
					labelStyle, statusStyle = stStruck, stDim
				} else if a.IdentityKey == "" {
					mark = stDim.Render("· ")
				}
				prefix := cursor + mark
				gap := "  "
				identityWidth := max(0, lineWidth-lipgloss.Width(prefix)-lipgloss.Width(gap)-lipgloss.Width(status))
				header := prefix +
					labelStyle.Render(managerClipCell(managerAccountLabel(a), identityWidth)) +
					gap + statusStyle.Render(status)
				lines = append(lines, managerLine{
					text:        managerClipCell(header, lineWidth),
					selectable:  index,
					group:       group,
					groupHeader: true,
					provider:    provider,
				})

				usageSpecs := make([]usageRowSpec, 0, len(m.avail.accountUsage[key]))
				for _, win := range m.avail.accountUsage[key] {
					if win.missing {
						continue
					}
					if m.avail.accountsStale {
						win.stale = true
					}
					usageSpecs = append(usageSpecs, m.usageRowSpec(win, "      "))
				}
				// Every account child in the pane uses one shared bar width.
				// Percentages already reserve three digits ("%3d%%"); the widest
				// optional note (tight, idle, maxed, cached) is what determines
				// the common remaining bar width.
				for _, usage := range usageSpecs {
					usage := usage.render(barWidth, noteWidth)
					lines = append(lines, managerLine{
						text:       managerClipCell(usage, lineWidth),
						selectable: -1,
						group:      group,
						provider:   provider,
					})
				}
				if len(usageSpecs) == 0 {
					unavailable := "      " + stWarn.Render("usage unavailable")
					if m.avail.accountsStale {
						unavailable += "  " + stWarn.Render("cached")
					}
					lines = append(lines, managerLine{
						text:       managerClipCell(unavailable, lineWidth),
						selectable: -1,
						group:      group,
						provider:   provider,
					})
				}
				if credits, ok := m.avail.accountCredits[key]; ok {
					if credit := creditSummary(credits); credit != "" {
						lines = append(lines, managerLine{
							text:       managerClipCell("      "+credit, lineWidth),
							selectable: -1,
							group:      group,
							provider:   provider,
						})
					}
				}
				group++
				if accountIndex+1 < len(accounts) {
					lines = append(lines, managerLine{
						text: "", selectable: -1, group: -1, spacer: true, provider: provider,
					})
				}
			}
		}
	}
	return lines
}

func windowManagerAccountLines(lines []managerLine, cursor, height int) []managerLine {
	if height <= 0 {
		return nil
	}
	if len(lines) <= height {
		return lines
	}
	selected := -1
	for i, line := range lines {
		if line.selectable == cursor {
			selected = i
			break
		}
	}
	if selected < 0 {
		for end := min(height, len(lines)); end > 0; end-- {
			if !lines[end-1].spacer {
				return lines[:end]
			}
		}
		return nil
	}

	selectedEnd := selected + 1
	for selectedEnd < len(lines) && lines[selectedEnd].group == lines[selected].group {
		selectedEnd++
	}
	start := selected - height/2
	if start < 0 {
		start = 0
	}
	// When the selected account's full group fits, reserve room for all of its
	// usage children before adding surrounding context.
	if selectedEnd-selected <= height && start < selectedEnd-height {
		start = selectedEnd - height
	}

	// Never begin with usage children detached from their account header. Move
	// back to that header if the selected group still fits; otherwise skip the
	// incomplete preceding group rather than showing orphaned bars.
	if start < len(lines) && lines[start].group >= 0 && !lines[start].groupHeader {
		orphanGroup := lines[start].group
		header := start
		for header > 0 && lines[header-1].group == orphanGroup {
			header--
		}
		if selectedEnd-header <= height {
			start = header
		} else {
			for start < len(lines) && lines[start].group == orphanGroup {
				start++
			}
		}
	}
	if start < len(lines) && lines[start].spacer {
		start++
	}

	end := min(len(lines), start+height)
	for end > start && lines[end-1].spacer {
		end--
	}
	return lines[start:end]
}

func windowManagerProviderLines(lines []managerLine, cursor, height int) []managerLine {
	if height <= 0 || len(lines) == 0 {
		return nil
	}
	if len(lines) <= height {
		return lines
	}
	if height == 1 {
		return lines[:1]
	}
	window := windowManagerAccountLines(lines[1:], cursor, height-1)
	result := make([]managerLine, 1, len(window)+1)
	result[0] = lines[0]
	return append(result, window...)
}

func windowManagerLines(lines []managerLine, cursor, height int) []managerLine {
	if height <= 0 || len(lines) == 0 {
		return nil
	}
	if managerProviderBoxesHeight(lines) <= height {
		return lines
	}
	ranges := managerProviderRanges(lines)
	if len(ranges) == 0 {
		return nil
	}
	selectedProvider := 0
	for i, providerRange := range ranges {
		for _, line := range lines[providerRange.start:providerRange.end] {
			if line.selectable == cursor {
				selectedProvider = i
				break
			}
		}
	}
	selected := ranges[selectedProvider]
	selectedLines := lines[selected.start:selected.end]
	if len(selectedLines)+2 > height {
		return windowManagerProviderLines(selectedLines, cursor, max(0, height-2))
	}

	start, end := selectedProvider, selectedProvider+1
	result := append([]managerLine(nil), selectedLines...)
	for {
		grew := false
		if start > 0 {
			candidateRange := ranges[start-1]
			candidate := append([]managerLine(nil), lines[candidateRange.start:candidateRange.end]...)
			candidate = append(candidate, result...)
			if managerProviderBoxesHeight(candidate) <= height {
				result = candidate
				start--
				grew = true
			}
		}
		if end < len(ranges) {
			candidateRange := ranges[end]
			candidate := append(append([]managerLine(nil), result...),
				lines[candidateRange.start:candidateRange.end]...)
			if managerProviderBoxesHeight(candidate) <= height {
				result = candidate
				end++
				grew = true
			}
		}
		if !grew {
			break
		}
	}
	return result
}

func (m model) managerAccountBody(width int, rows []managerLine) string {
	body := padLeft(m.managerTitle(width), gut)
	if boxes := managerProviderBoxes(width, rows, m.managerFocusedProvider()); boxes != "" {
		body += "\n\n" + padLeft(boxes, gut)
	}
	if m.accountErr != "" {
		body += "\n\n" + padLeft(stBrk.Render(m.accountErr), gut)
	}
	return body
}

// managerUsageFitsInline measures the complete, unwindowed account manager
// above the same pinned Usage-and-controls footer used by Generator. The
// footer's two divider rows are part of the exact-fit geometry.
func (m model) managerUsageFitsInlineFor(accounts, footer string) bool {
	content := strings.Repeat("\n", topGap) + accounts
	return lipgloss.Height(content)+lipgloss.Height(footer) <= m.h
}

func (m model) managerUsageFitsInline() bool {
	width := max(0, m.w-2*gut)
	accounts := m.managerAccountBody(width, m.managerLines(width))
	usage := m.usagePanelFor(m.w)
	controls := padLeft(m.managerControlsFor(width, "hide usage"), gut)
	footer := clikit.SeparatedSections(m.w, usage, controls)
	return m.managerUsageFitsInlineFor(accounts, footer)
}

func (m model) managerUsageAction(inlineFits bool) string {
	if !m.hideUsage && (inlineFits || m.showUsage) {
		return "hide usage"
	}
	return "show usage"
}

func (m model) managerView() string {
	m.clampManagerCursor()
	width := max(0, m.w-2*gut)
	rows := m.managerLines(width)
	accounts := m.managerAccountBody(width, rows)
	usage := m.usagePanelFor(m.w)
	inlineControls := padLeft(m.managerControlsFor(width, "hide usage"), gut)
	inlineFooter := clikit.SeparatedSections(m.w, usage, inlineControls)
	inlineFits := m.managerUsageFitsInlineFor(accounts, inlineFooter)
	usageAction := m.managerUsageAction(inlineFits)
	controls := inlineControls
	if usageAction != "hide usage" {
		controls = padLeft(m.managerControlsFor(width, usageAction), gut)
	}
	footer := clikit.SeparatedSections(m.w, controls)
	inlineUsage := !m.hideUsage && inlineFits
	if inlineUsage {
		footer = clikit.SeparatedSections(m.w, usage, controls)
	}
	alternateUsage := m.managerPreset.deleting == "" &&
		!m.hideUsage && m.showUsage && !inlineFits
	contentHeight := m.h - lipgloss.Height(footer)
	if contentHeight < 1 {
		contentHeight = 1
	}

	var body string
	if alternateUsage {
		body = usage
	} else {
		if !inlineUsage {
			available := m.h - lipgloss.Height(footer) - topGap -
				lipgloss.Height(m.managerTitle(width)) - 1
			if m.accountErr != "" {
				available -= 2
			}
			if available < 0 {
				available = 0
			}
			rows = windowManagerLines(rows, m.mgrCursor, available)
			accounts = m.managerAccountBody(width, rows)
		}
		body = accounts
	}

	placed := lipgloss.Place(m.w, contentHeight, lipgloss.Left, lipgloss.Top,
		strings.Repeat("\n", topGap)+body)
	return lipgloss.NewStyle().MaxWidth(m.w).MaxHeight(m.h).Render(
		lipgloss.JoinVertical(lipgloss.Left, placed, footer))
}

func (m model) managerControls(w int) string {
	return m.managerControlsFor(w, m.managerUsageAction(m.managerUsageFitsInline()))
}

func (m model) managerRefreshDescription() string {
	switch {
	case !m.avail.ok && (m.fetching || m.nextRefresh.IsZero()):
		return "fetching usage…"
	case m.fetching:
		return "refreshing…"
	case m.usageStale:
		return "retry · stale"
	case !m.nextRefresh.IsZero():
		remaining := time.Until(m.nextRefresh)
		if remaining < 0 {
			remaining = 0
		}
		seconds := int(remaining.Seconds())
		return fmt.Sprintf("now · next %d:%02d", seconds/60, seconds%60)
	default:
		return "refresh"
	}
}

func (m model) managerControlsFor(w int, usageAction string) string {
	compact := w < 48
	var items []clikit.HelpItem
	switch {
	case m.managerPreset.deleting != "":
		items = []clikit.HelpItem{
			{Key: "y", Description: "confirm delete"},
			{Key: "esc", Description: "cancel"},
		}
		if compact {
			items[0].Description = "delete"
		}
	case m.managerPreset.naming:
		items = []clikit.HelpItem{
			{Key: "enter", Description: "save preset"},
			{Key: "esc", Description: "cancel"},
		}
		if compact {
			items[0].Description = "save"
		}
	case m.managerPreset.editing:
		items = []clikit.HelpItem{
			{Key: "↑↓", Description: "move"},
			{Key: "space", Description: "change draft"},
			{Key: "s", Description: "save preset"},
			{Key: "esc", Description: "cancel"},
		}
		if compact {
			items[1] = clikit.HelpItem{Key: "spc", Description: "change"}
			items[2].Description = "save"
		}
	default:
		items = []clikit.HelpItem{
			{Key: "←→", Description: "preset"},
			{Key: "↑↓", Description: "move"},
		}
		if strings.EqualFold(m.accountSelections.ActiveName(), accountSelectionManualName) {
			items = append(items,
				clikit.HelpItem{Key: "space", Description: "toggle account"},
				clikit.HelpItem{Key: "n", Description: "new preset"},
			)
		} else {
			items = append(items,
				clikit.HelpItem{Key: "e", Description: "edit preset"},
				clikit.HelpItem{Key: "n", Description: "new preset"},
				clikit.HelpItem{Key: "d", Description: "delete preset"},
			)
		}
		identityAction := "full ids"
		if m.fullUsageIDs {
			identityAction = "short ids"
		}
		items = append(items,
			clikit.HelpItem{Key: "s", Description: usageAction},
			clikit.HelpItem{Key: "i", Description: identityAction},
			clikit.HelpItem{Key: "r", Description: m.managerRefreshDescription()},
			clikit.HelpItem{Key: "v", Description: "close"},
		)
		if compact {
			for i := range items {
				switch items[i].Key {
				case "space":
					items[i] = clikit.HelpItem{Key: "spc", Description: "toggle"}
				case "n":
					items[i].Description = "new"
				case "e":
					items[i].Description = "edit"
				case "d":
					items[i].Description = "delete"
				}
			}
		}
	}
	help := m.help
	help.Styles.ShortDesc = stHead
	return clikit.WrapHelp(help, w, items)
}
