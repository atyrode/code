package main

import (
	"github.com/charmbracelet/lipgloss"
)

// ── model ────────────────────────────────────────────────────────────────────
// layout modes, chosen from the terminal size (unless the user collapses):
//
//	split     — wide:   the focused list on the left, routing preview on the
//	            right, and Usage spanning the full bottom width
//	medium    — generator-dominant: the list full width on top (primary), then
//	            Usage and Routing side by side in a secondary row — Usage's
//	            provider groups stacked vertically inside its measured left
//	            column, Routing on the right (and taking the whole row while
//	            ‹s› hides Usage)
//	collapsed — narrow/short or ‹p›: one full-width panel at a time (list, or
//	            routing w/ showResult) — the Generator stays usable instead of
//	            compressing every section into an unreadable split
const (
	modeSplit = iota
	modeMedium
	modeCollapsed
)

// size classes behind mode(): derived from terminal cells and the measured
// rendered minima of each section (atyrode/dotfiles#197) — never from pixels or a hard-coded
// screenshot width.
const (
	sizeWide = iota
	sizeMedium
	sizeNarrow
)

// gut is the left gutter every panel shares, so the whole UI hangs off one
// consistent margin instead of a ragged mix of flush-left and indented rows.
// topGap is the matching vertical breathing room above the section tabs.
// headRows counts the section head (tabs + blank separator) above a list body.
const (
	gut      = 2
	topGap   = 1
	headRows = 2
	// the launch footer pinned under the list: blank + cost + speed + blank +
	// the ⏎ launch action on its own visually separated row.
	launchFooterRows = 5
	// routingMinW is the narrowest useful routing column: pane chrome plus room
	// for a lead chain — below this a side-by-side routing panel stops earning
	// its keep.
	routingMinW = 33
	// secSepW is the one-cell border column between medium's adjacent
	// secondary panes (Usage left, Routing right) — visible separation, same
	// stroke as the wide layout's routing pane border.
	secSepW = 1
	// genMinRows is the fewest facet rows the generator list may be windowed to
	// before the layout must shed secondary sections instead of compressing it.
	genMinRows = 4
	// minRouteRows is the fewest routing viewport rows worth pinning chrome around.
	minRouteRows = 4
)

// genColMinH is the generator column's minimum useful height: the pinned head,
// a windowed-but-usable slice of the facet list, and the pinned launch footer.
const genColMinH = headRows + genMinRows + launchFooterRows

// genRowWidth is the width needed to render the widest generator facet row (all
// options) on a single line — the minimum for the left panel.
func (m model) genRowWidth() int {
	max := 30
	for _, f := range m.facets { // widest over ALL facets, so width is lane-stable
		w := 14 // ▸ + glyph + spaces + padded label
		for _, v := range f.values {
			w += len(v) + 4
		}
		if w > max {
			max = w
		}
	}
	return max + 2
}

// sizeMode classifies the terminal into the wide / medium / narrow-short
// responsive classes. Widths compare against the measured generator row,
// routing, and usage-column minima; heights against the chrome each composition
// pins on screen — breakpoints track content needs, not screenshot numbers.
func (m model) sizeMode() int {
	if m.w >= m.genRowWidth()+routingMinW && m.h >= m.wideMinH() {
		return sizeWide
	}
	if m.w >= m.mediumMinW() && m.h >= m.mediumMinH() {
		return sizeMedium
	}
	return sizeNarrow
}

func (m model) mode() int {
	if m.collapse {
		return modeCollapsed
	}
	switch m.sizeMode() {
	case sizeWide:
		return modeSplit
	case sizeMedium:
		return modeMedium
	default:
		return modeCollapsed
	}
}

// wideMinH is the least height at which the wide composition stays readable:
// a usable generator column above the full-width Usage footer. Shorter than
// this, keeping every section visible would compress them all — shed instead.
func (m model) wideMinH() int {
	return topGap + genColMinH + m.footerH(!m.hideUsage)
}

// mediumMinH stacks the generator over the secondary Routing+Usage row (at its
// measured minimum) with Usage out of the footer.
func (m model) mediumMinH() int {
	return topGap + genColMinH + 1 + m.secondaryMinH() + m.footerH(false)
}

// mediumMinW: the secondary row must seat a useful routing viewport beside the
// measured usage column — plus the one-cell separator between them — without
// clipping either.
func (m model) mediumMinW() int {
	if m.hideUsage {
		return routingMinW
	}
	return routingMinW + secSepW + m.usageColW()
}

// footerH measures the pinned footer for a composition directly from its parts
// — mode selection depends on it, so it must not consult the mode itself.
func (m model) footerH(withUsage bool) int {
	h := 1 + lipgloss.Height(padLeft(m.help.View(keys), gut))
	if withUsage {
		if p := m.usagePanel(); p != "" {
			h += 1 + lipgloss.Height(p)
		}
	}
	return h
}

// bodyH is the height available above the pinned footer.
func (m model) bodyH() int {
	h := m.h - lipgloss.Height(m.footer())
	if h < 1 {
		h = 1
	}
	return h
}

// contentH is the height the panels actually fill — bodyH minus the top gap.
func (m model) contentH() int {
	h := m.bodyH() - topGap
	if h < 1 {
		h = 1
	}
	return h
}

// bodyLines renders the generator's scrolling facet list and reports the cursor's
// line index within it.
func (m model) bodyLines() ([]string, int) {
	return m.genLines()
}

// launchFooter is the cost/speed meters for the current facet combo plus the
// enter-to-launch call to action — so the generator always shows what the choice
// costs, how fast it is, and how Enter will launch it. Enter always launches
// the generated profile for the current facets (the untouched default combo is
// a profile like any other); m runs omp-managed on the managed defaults with
// no overlay, and the sandbox (u) key is always offered. A selected runtime
// target gets the same footer shape with an honest summary instead of meters:
// its tokens are free and code has no measurement to quote.
func (m model) launchFooter() []string {
	// The local lane is checked before the no-provider notice: a machine with
	// no connected provider can still confirm a local model, and telling it
	// there is nothing to do would be wrong (locallane.go).
	if _, on := m.selectedLocalModel(); on {
		return []string{
			"",
			stDim.Render("  cost 0.00 USD · local endpoint · no provider billing"),
			"",
			"",
			lipgloss.NewStyle().Foreground(lipgloss.Color(m.accent())).Bold(true).Render("  ⏎ confirm"),
		}
	}
	if m.noProviders {
		return []string{
			"",
			stDim.Render("  no connected OMP providers"),
			"",
			"",
			stDim.Render("  m open managed OMP to log in"),
		}
	}
	acc := lipgloss.NewStyle().Foreground(lipgloss.Color(m.accent())).Bold(true).Render("  ⏎ launch")
	if _, local := m.selectedRuntime(); local {
		return []string{
			"",
			stDim.Render("  cost free · local inference"),
			"",
			"",
			acc,
		}
	}
	cs, ss := m.costScore(), m.speedScore()
	return []string{
		"",
		m.meter("cost", "$", meterRamp[cs], cs), // dear → red, cheap → green
		m.meter("speed", "»", meterRamp[6-ss], ss), // fast → green, slow → red
		"", // breathing room between the meters and the action row
		acc + stDim.Render("   m managed omp · u sandbox"),
	}
}

// mediumSplit gives the Routing+Usage row only its measured minimum, then lets
// the primary Generator absorb every remaining row. The medium height threshold
// guarantees both sections fit; taller terminals therefore expand Generator
// instead of leaving slack below the compact secondary content.
func (m model) mediumSplit(bodyH int) (genH, secH int) {
	secH = m.secondaryMinH()
	genH = bodyH - 1 - secH
	if genH < genColMinH {
		genH = genColMinH
		secH = bodyH - 1 - genH
	}
	return
}

// previewDims returns the preview viewport's inner (width, height) for the mode.
// The full-width modes reserve the shared gutter; split leaves the preview's own
// border + padding to do the breathing. Every mode reserves prevChromeRows for
// the pinned pill head above and fallback-display hint below the viewport.
func (m model) previewDims() (int, int) {
	bodyH := m.contentH()
	switch m.mode() {
	case modeCollapsed:
		return m.w - gut, bodyH - prevChromeRows
	case modeMedium:
		_, secH := m.mediumSplit(bodyH)
		return m.routingColW() - gut, secH - prevChromeRows
	default: // split — the pane draws a border + prevPadL inside its width, so the
		// viewport (what renderRoute wraps to) gets the inner text area, not the box.
		return m.w - m.listW() - 3 - prevPadL, bodyH - prevChromeRows
	}
}

// usageColShare is the medium secondary row's Usage width: Usage is the
// favored pane — it takes the larger 3/5 proportional share of the row so its
// bars and notes keep breathing room, never dropping below its measured
// stacked minimum. Routing is the pane that shrinks as Usage grows, floored
// at routingMinW (the medium width threshold guarantees both floors seat).
func (m model) usageColShare() int {
	avail := m.w - secSepW
	uw := avail * 3 / 5
	if min := m.usageColW(); uw < min {
		uw = min
	}
	if avail-uw < routingMinW {
		uw = avail - routingMinW
	}
	return uw
}

// routingColW is the medium secondary row's routing share: whatever Usage's
// favored share (and the separator between the panes) leaves free.
func (m model) routingColW() int {
	w := m.w
	if !m.hideUsage {
		w -= m.usageColShare() + secSepW
	}
	if w < routingMinW {
		w = routingMinW
	}
	return w
}

func (m model) listW() int {
	// wide enough for the generator options on one line; capped so a very wide
	// terminal doesn't stretch the list needlessly.
	w := m.genRowWidth()
	if w > m.w-33 {
		w = m.w - 33
	}
	// The optional-pool lanes widen the lane row past this function's old
	// 80-cell aesthetic cap; a wider list beats clipping dial options mid-value.
	if w > 116 {
		w = 116
	}
	return w
}

// Usage bars naturally measure ten cells, then grow or shrink to the width
// assigned by their row group. Styling is deliberately applied after the
// display-cell geometry is settled, so ANSI sequences never enter the math.
