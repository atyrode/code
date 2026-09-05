package main

import (
	"fmt"
	"strings"

	clikit "github.com/atyrode/cli-kit"
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/viewport"
	"github.com/charmbracelet/lipgloss"
)

func (m *model) footer() string {
	usage := ""
	if m.usageInFooter() {
		usage = m.usagePanel()
	}
	return clikit.SeparatedSections(
		m.w,
		usage,
		padLeft(m.help.View(m.contextHelp()), gut),
	)
}

// usageInFooter says where Usage lives: the wide layout keeps it as the
// full-width bottom band; medium moves it into the secondary column (back to
// the footer while ‹p› hides that row); narrow/short hides it entirely so the
// Generator stays usable first — fetch state and the refresh cadence keep
// running unseen, and nothing is refetched when it reappears.
func (m *model) usageInFooter() bool {
	if m.hideUsage {
		return false
	}
	switch m.sizeMode() {
	case sizeWide:
		return true
	case sizeMedium:
		return m.collapse
	default:
		return false
	}
}

// routingShown reports whether the Routing section (and so its title-local
// p · hide cue) is on screen in the current composition.
func (m model) routingShown() bool {
	if m.showUsage && m.sizeMode() == sizeNarrow {
		return false
	}
	if m.collapse {
		return false
	}
	if m.mode() == modeCollapsed {
		return m.showResult
	}
	return true
}

// usageShown reports whether the Usage panel is rendered anywhere — the
// wide/collapsed footer band, medium's secondary column, or narrow's dedicated
// full-screen view.
func (m model) usageShown() bool {
	if m.hideUsage {
		return false
	}
	if m.sizeMode() == sizeNarrow {
		return m.showUsage
	}
	return m.usageInFooter() || m.mode() == modeMedium
}

// usageCanShow reports whether restoring Usage would actually render it.
// Narrow terminals use a dedicated full-width view when they can seat the
// stacked Usage column; extremely small terminals still suppress a dead cue.
func (m model) usageCanShow() bool {
	if m.sizeMode() == sizeNarrow {
		return m.w >= m.usageColW()
	}
	t := m
	t.hideUsage = false
	return t.usageShown()
}

// generatorShown: the Generator (and its launch footer advertising ⏎/m/u) is
// visible in every composition except a narrow full-screen secondary view.
func (m model) generatorShown() bool {
	if m.sizeMode() == sizeNarrow && m.showUsage {
		return false
	}
	return !(m.mode() == modeCollapsed && !m.collapse && m.showResult)
}

// helpKeys is the state-derived key map handed to the bubbles help view: the
// compact line lists only what contextHelp selected, while ? always exposes
// the complete static reference.
type helpKeys struct {
	short []key.Binding
	full  [][]key.Binding
}

func (h helpKeys) ShortHelp() []key.Binding  { return h.short }
func (h helpKeys) FullHelp() [][]key.Binding { return h.full }

// contextHelp derives the compact footer from the model state (atyrode/dotfiles#198):
//   - navigation, reset, full-help discovery, and quit are always offered;
//   - a hidden section contributes its recovery action (show routing/usage) —
//     usage only when the current terminal could actually seat it again;
//   - account management and manual refresh surface while Usage is off screen,
//     with refresh hidden while its one central request is in flight;
//   - the launch trio surfaces only while the Generator launch footer is
//     hidden (the narrow routing-full-screen swap).
//
// Everything else lives in visible section chrome or behind ?.
func (m model) contextHelp() helpKeys {
	short := []key.Binding{keys.Move, keys.Change}
	// The generator title advertises d · defaults itself; the compact line
	// repeats it only while that chrome is off screen (routing full-screen).
	if !m.generatorShown() {
		short = append(short, keys.Reset)
	}
	if !m.routingShown() {
		short = append(short, key.NewBinding(key.WithKeys("p"), key.WithHelp("p", "show routing")))
	}
	if !m.usageShown() && m.usageCanShow() {
		short = append(short, key.NewBinding(key.WithKeys("s"), key.WithHelp("s", "show usage")))
	}
	// Keep full-help discovery and quit ahead of optional contextual actions:
	// bubbles truncates a compact line from the right on narrow terminals.
	short = append(short, keys.Help, keys.Quit)
	if !m.usageShown() {
		short = append(short, keys.Manager)
		if m.broker.URL != "" && !m.fetching {
			short = append(short, keys.Refresh)
		}
	}
	if !m.generatorShown() {
		short = append(short, keys.Launch, keys.Managed, keys.Untrusted, keys.Worktree)
	}
	return helpKeys{short: short, full: keys.FullHelp()}
}

func (m *model) relayout() {
	m.help.Width = m.w - gut // the footer help is gutter-inset on every line; wrap inside the padded width
	pw, ph := m.previewDims()
	if pw < 10 {
		pw = 10
	}
	if ph < 3 {
		ph = 3
	}
	if !m.rdy {
		m.vp = viewport.New(pw, ph)
		m.rdy = true
	} else {
		m.vp.Width, m.vp.Height = pw, ph
	}
	m.syncPreviewKeepScroll()
}

const prevPadL = 2

func (m model) previewPane(w, h int) string {
	return lipgloss.NewStyle().
		Border(lipgloss.NormalBorder(), false, false, false, true).
		BorderForeground(lipgloss.Color(cBord)).PaddingLeft(prevPadL).
		Width(w).Height(h).
		Render(m.previewColumn())
}

// accent is the context colour — the selected lane in the generator.
// Blue / purple / orange.
func (m model) accent() string {
	// On-device inference reads green, whichever route reaches it: a delegated
	// runtime target or the local endpoint lane.
	if _, on := m.selectedLocalModel(); on {
		return cGreen
	}
	if _, local := m.selectedRuntime(); local {
		return cGreen
	}
	return laneColor(m.sel["lane"])
}

// pill renders an accent-backed section label, coloured by the active lane —
// the shared shape of the generator (left) and routing (right) column heads.
func (m model) pill(label string) string {
	return lipgloss.NewStyle().Padding(0, 1).
		Background(lipgloss.Color(m.accent())).Foreground(lipgloss.Color("#12161d")).Bold(true).
		Render(label)
}

// sectionTitle is the accent-pilled "generator" label at the top of the left
// column.
func (m model) sectionTitle() string {
	return m.pill("generator")
}

// sectionHead is the gutter-inset title row — the pill plus its local
// reset-to-defaults cue (d · defaults) — and a blank separator (headRows
// tall); it stays pinned above the scrolling facet list.
func (m model) sectionHead() string {
	head := m.sectionTitle() + "  " + stCueKey.Render("d") + stCue.Render(" · defaults")
	if m.gitRoot != "" {
		if m.worktreeMode {
			head += "  " + stKey.Render("w") + stWtOn.Render(" · worktree on")
		} else {
			head += "  " + stCueKey.Render("w") + stCue.Render(" · worktree")
		}
	}
	return padLeft(head, gut) + "\n\n"
}

// prevChromeRows is the Routing column's pinned chrome around the scrolling
// viewport: the title row with its local collapse cue and a blank separator
// above, plus the fallback-display cue pinned beneath the viewport.
const prevChromeRows = headRows + 1

// previewColumn assembles the Routing section: the pinned title row carrying
// the section-local collapse cue (p · hide), the scrolling routing viewport,
// then the display cues pinned at the section's bottom edge — bottom chrome,
// where the chains they toggle end. The f wording makes clear it only
// changes what is DISPLAYED: the launched profile always keeps its fallback
// chains. n reads the same way: it swaps the short model keys for the
// catalog's full ids, and routes nothing differently.
func (m model) previewColumn() string {
	verb := "show"
	if m.depth == 1 {
		verb = "hide"
	}
	ids := "full ids"
	if m.showFullIDs {
		ids = "short ids"
	}
	return m.pill("routing") + "  " + stCueKey.Render("p") + stCue.Render(" · hide") + "\n\n" +
		m.vp.View() + "\n" +
		stKey.Render("f") + stDim.Render(" · "+verb+" fallback chains") +
		"   " + stKey.Render("n") + stDim.Render(" · "+ids)
}

// leftColumn renders the pinned section head plus the scrolling list body, the
// whole column inset by the shared gutter, sized to totalH rows and w columns.
func (m model) leftColumn(w, totalH int) string {
	iw := w - gut
	body, bcur := m.bodyLines()
	listH := totalH - headRows - launchFooterRows
	if listH < 1 {
		listH = 1
	}
	list := padLeft(windowList(body, bcur, listH, iw), gut)
	footer := padLeft(strings.Join(m.launchFooter(), "\n"), gut)
	return m.sectionHead() + list + "\n" + footer
}

// mediumContent is the generator-dominant layout: the full-width facet list on
// top (primary), a divider, then Usage (left) and Routing (right) side by side
// in a secondary row, separated by a one-cell border column. Usage stacks its
// provider groups vertically inside the measured-width left column; Routing
// keeps its own scrolling viewport in whatever the row leaves free.
func (m model) mediumContent(bodyH int) string {
	genH, secH := m.mediumSplit(bodyH)
	top := m.leftColumn(m.w, genH)
	div := stDim.Render(strings.Repeat("─", m.w))
	rw := m.routingColW()
	// clip each column before fixing its width — Width() alone would wrap any
	// over-wide line onto an extra physical row and break the row's height.
	routing := lipgloss.NewStyle().Width(rw).MaxHeight(secH).Render(
		lipgloss.NewStyle().MaxWidth(rw).Render(padLeft(m.previewColumn(), gut)))
	sec := routing
	if !m.hideUsage {
		uw := m.w - rw - secSepW // the measured usage column's share, left of the border
		sep := lipgloss.NewStyle().Foreground(lipgloss.Color(cBord)).Render(
			strings.TrimSuffix(strings.Repeat("│\n", secH), "\n"))
		usage := lipgloss.NewStyle().Width(uw).MaxHeight(secH).Render(
			lipgloss.NewStyle().MaxWidth(uw).Render(m.usagePanelStackedFor(uw)))
		sec = lipgloss.JoinHorizontal(lipgloss.Top, usage, sep, routing)
	}
	return lipgloss.JoinVertical(lipgloss.Left, top, div, sec)
}

func (m model) View() string {
	if !m.rdy {
		return "loading…"
	}
	if m.manager {
		return m.managerView()
	}
	foot := m.footer()
	bodyH := m.bodyH()
	ch := m.contentH()
	var content string
	switch m.mode() {
	case modeCollapsed:
		switch {
		case m.showUsage && m.sizeMode() == sizeNarrow:
			content = padLeft(m.usagePanelFor(m.w-gut), gut)
		case m.showResult && !m.collapse:
			content = padLeft(m.previewColumn(), gut)
		default:
			content = m.leftColumn(m.w, ch)
		}
	case modeMedium:
		content = m.mediumContent(ch)
	default: // split
		content = lipgloss.JoinHorizontal(lipgloss.Top,
			m.leftColumn(m.listW(), ch),
			m.previewPane(m.w-m.listW()-3, ch))
	}
	// Pin the body into a fixed box (top-left) with lipgloss, then clip: any
	// stray overflow (e.g. a glyph a terminal renders wider than measured) is
	// absorbed here, never pushing the pinned footer off-screen. A top gap above
	// the content gives the section tabs vertical breathing room.
	body := lipgloss.NewStyle().MaxHeight(bodyH).Render(
		strings.Repeat("\n", topGap) +
			lipgloss.Place(m.w, ch, lipgloss.Left, lipgloss.Top, content))
	return lipgloss.NewStyle().MaxWidth(m.w).MaxHeight(m.h).Render(
		lipgloss.JoinVertical(lipgloss.Left, body, foot))
}

// labelW is the facet label column: wide enough for the longest key
// ("planyolo") to sit in a child slot, where the tree connector takes two
// cells off the front.
const labelW = 10

func (m model) genLines() ([]string, int) {
	acc := m.accent()
	var lines []string
	cursor := 0
	selected := m.selectedLaunchAvailability()
	shown, folded := m.facetRows()
	lastFolded := ""
	if len(folded) > 0 {
		lastFolded = folded[len(folded)-1].key
	}
	for i, f := range shown {
		onRow := i == m.fcur
		glyCol := laneColor(m.sel["lane"])
		gly := lipgloss.NewStyle().Foreground(lipgloss.Color(glyCol)).Width(2).Render(f.glyph)
		ptr := "  "
		if onRow {
			ptr = lipgloss.NewStyle().Foreground(lipgloss.Color(acc)).Render("▸ ")
			cursor = len(lines)
		}
		// Child rows carry a tree connector before the glyph, like the `tree`
		// CLI: blend is lane's sub-setting (the lead row picks who drives,
		// this child picks how exclusively), and the folded switches hang off
		// the `more` row, the last one closing the branch.
		label, childPad, childW := f.key, "", 0
		switch {
		case f.key == "blend", f.key == lastFolded:
			childPad, childW = stDim.Render("└ "), 2
		case moreFacets[f.key]:
			childPad, childW = stDim.Render("├ "), 2
		}
		row := fmt.Sprintf("%s%s%s%s", ptr, childPad, gly, stDim.Render(pad(label, labelW-childW)))
		switch {
		case f.key == "thinking", f.key == "model", f.key == "advisor":
			row += "  " + m.segmentGauge(f, onRow, acc)
		case f.key == moreFacetKey:
			row += "  " + m.moreCell(folded, onRow, acc)
		default:
			for _, v := range f.values {
				display := v
				if f.key == "runtime" {
					display = m.runtimeValueLabel(v)
				}
				// A lead/blend value whose composed lane the connected
				// credentials cannot run stays visible — struck, unpickable —
				// so a missing login reads as "log in", never as a gone dial.
				usable := true
				switch f.key {
				case "lead":
					usable = m.laneUsable(m.composeLane(v, m.sel["blend"]))
				case "blend":
					usable = m.laneUsable(laneJoin(m.sel["lead"], v))
				}
				switch {
				case !usable && v != m.sel[f.key]:
					row += "   " + stStruck.Render(display)
				case v == m.sel[f.key]:
					col := acc
					if f.key == "lead" {
						col = laneColor(m.sel["lane"])
					} else if f.key == "spark" && v == "on" {
						col = cGreen
					}
					st := lipgloss.NewStyle().Foreground(lipgloss.Color(col)).Bold(true)
					if onRow { // the cursor sits on the selected value of the focused row
						st = st.Background(lipgloss.Color(cSelBg))
					}
					row += "  " + st.Render(" "+display+" ")
				default:
					row += "   " + stDim.Render(display)
				}
			}
		}
		if f.key == "lead" {
			if missing := m.disconnectedLeads(f.values); missing != "" {
				row += "   " + stDim.Render(missing+" — not logged in")
			}
		}
		switch {
		case f.key == "spark" && m.sel[f.key] == "on":
			// The spark dial drains a quota window of its own, so a maxed
			// window has to say so on the dial itself — the preview strikes the
			// model through, but the dial is where the choice is made. The
			// bucket comes from the registry (bucketOf resolves the bare facet
			// name), never from a name typed here.
			bkt := bucketOf(f.key)
			lbl := strings.ToUpper(f.key[:1]) + f.key[1:]
			if selected.down(bkt) {
				w := lbl + " maxed · " + gReset + " " + fmtReset(selected.reset[bkt])
				if selected.bucket[bkt] == "unauthed" {
					w = lbl + " unavailable"
				}
				row += "   " + stWarn.Render(gWarn+" "+w+" — no usage left")
			}
		case f.key == "fast" && m.sel["fast"] == "on":
			row += "   " + stDim.Render("GPT only")
		}
		lines = append(lines, row)
	}
	return lines, cursor
}

// segmentGauge renders a stepped dial (model, thinking, advisor) as a notched
// meter: one cell per selectable option, filled to the selection, with the
// selected word riding along so the level still reads at a glance. A leading
// "off" value is the dial's zero — it takes no cell, so off renders an empty
// track and the first real step lights exactly one. ←/→ behave exactly as on
// a word dial — only the rendering differs; the facet's values are untouched.
func (m model) segmentGauge(f facet, onRow bool, acc string) string {
	sel := -1
	for i, v := range f.values {
		if v == m.sel[f.key] {
			sel = i
		}
	}
	steps := f.values
	fill := sel + 1
	if len(steps) > 0 && steps[0] == "off" {
		steps = steps[1:]
		fill = sel // off (sel 0) lights nothing
	}
	if fill < 0 {
		fill = 0
	}
	lit := lipgloss.NewStyle().Foreground(lipgloss.Color(acc)).Bold(true)
	var b strings.Builder
	// The leading space mirrors the word dials' selected-cell padding, so the
	// track starts on the same column the value words do.
	b.WriteString(" ")
	for i := range steps {
		if i < fill {
			b.WriteString(lit.Render("▰"))
		} else {
			b.WriteString(stDim.Render("▱"))
		}
	}
	word := lit
	if onRow {
		word = word.Background(lipgloss.Color(cSelBg))
	}
	label := m.sel[f.key]
	if sel < 0 && label == "" {
		label = "?"
	}
	return b.String() + " " + word.Render(" "+label+" ")
}

// moreCell renders the fold row's value: a chevron pointing where the hidden
// rows are (right while collapsed, down once open), followed — only while
// collapsed — by the names of the switches it hides, each lit when on. The
// fold exists to keep rarely-turned switches out of the way, not out of
// sight: a switch an operator (or a ctrl+o suggestion) left on behind it has
// to read from the row itself, or the launch does something the dials on
// screen do not say.
func (m model) moreCell(folded []facet, onRow bool, acc string) string {
	lit := lipgloss.NewStyle().Foreground(lipgloss.Color(acc)).Bold(true)
	pill := lit
	if onRow {
		pill = pill.Background(lipgloss.Color(cSelBg))
	}
	if m.sel[moreFacetKey] == moreExpanded {
		return pill.Render(" ▾ ")
	}
	var b strings.Builder
	b.WriteString(pill.Render(" ▸ "))
	for i, f := range folded {
		if i == 0 {
			b.WriteString("  ")
		} else {
			b.WriteString(stDim.Render(" · "))
		}
		// The on state is spelled, not merely coloured: a pipe, an ascii
		// terminal, or a headless capture has to read it too.
		if m.sel[f.key] == "on" {
			b.WriteString(lit.Render(f.key + " on"))
		} else {
			b.WriteString(stDim.Render(f.key))
		}
	}
	return b.String()
}

// The facet-glyph presets. Every table MUST define every glyph key, because a
// missing entry renders as an empty cell in a two-column slot and silently
// misaligns the whole dial list; resolveGlyphs (main.go) picks between them.
//
// defaultGlyphs is the Nerd Font set (Font Awesome PUA range), written as
// explicit \u escapes so the codepoints stay visible and verifiable in source —
// a literal PUA glyph is invisible in most editors and was once wiped by an edit
// exactly because of that. CODE_FACET_GLYPHS may override any entry (see main).
//
//	runtime 🖥 (f108)  local 💻 (f109)  lane ⇄ (f127)  model ⚙ (f085)
//	thinking 💡 (f0eb)  advisor 🧭 (f14e)  spark 🚀 (f135)  fast ⚡ (f0e7)
//	prewalk ↓ (f063)  planyolo ▶ (f04b)  more ⋯ (f141)
func defaultGlyphs() map[string]string {
	return map[string]string{
		"runtime": "\uf108", "local": "\uf109", "lane": "\uf127", "model": "\uf085",
		"thinking": "\uf0eb", "advisor": "\uf14e",
		"spark": "\uf135", "fast": "\uf0e7",
		"prewalk": "\uf063", "planyolo": "\uf04b",
		moreFacetKey: "\uf141",
	}
}

// unicodeGlyphs is the no-patched-font set: plain BMP symbols every modern
// terminal font carries, so an unpatched terminal shows shapes instead of tofu.
// Deliberately geometric rather than emoji — an emoji-presentation codepoint is
// double-width in some terminals and single in others, which would move the
// whole dial list sideways depending on the host.
func unicodeGlyphs() map[string]string {
	return map[string]string{
		"runtime": "▣", "local": "▢", "lane": "⇄", "model": "⚙",
		"thinking": "✦", "advisor": "◎",
		"spark": "✧", "fast": "»",
		"prewalk": "↓", "planyolo": "›",
		moreFacetKey: "⋯",
	}
}

// asciiGlyphs is the last resort — for terminals, pipes and CI logs where any
// non-ASCII byte is a liability.
//
// One letter, not two. The glyph slot is two cells wide, and the nerd/unicode
// sets put a single-cell character in it, so the second cell reads as the gap
// before the label. A two-letter tag fills both and the row renders as
// "mdmodel" — which is how this was first written, and how a headless capture
// caught it. The letter is only a hint anyway: the facet's name is spelled out
// immediately to its right.
func asciiGlyphs() map[string]string {
	return map[string]string{
		"runtime": "r", "local": "l", "lane": "n", "model": "m",
		"thinking": "t", "advisor": "a",
		"spark": "s", "fast": "f",
		"prewalk": "p", "planyolo": "y",
		moreFacetKey: "o",
	}
}
