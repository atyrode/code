package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// ── routing render (depth: 0 lead · 1 full) ──────────────────────────────────
// renderRoute lays out each role's chain, wrapping cleanly at `width`: when a
// chain doesn't fit, it breaks after an arrow and the continuation is indented
// to align under the first model, so it reads as one hanging block rather than a
// ragged wrap. Down (maxed/unauthed) models are struck through — which bucket a
// model draws from is a catalog fact, hence the receiver.
func (m model) renderRoute(rows []string, depth int, a availability, width int) string {
	if width < 24 {
		width = 24
	}
	arrow := stDim.Render(" → ")
	var out []string
	for _, r := range rows {
		locs := modelRe.FindAllStringIndex(r, -1)
		if len(locs) == 0 { // a note/meta line with no models — pass through
			out = append(out, colorizeRoute(r))
			continue
		}
		label := r[:locs[0][0]] // role + its alignment padding, kept verbatim
		labelW := lipgloss.Width(label)
		indent := strings.Repeat(" ", labelW)

		type tok struct {
			text string
			down bool
		}
		var toks []tok
		for _, loc := range locs {
			mt := r[loc[0]:loc[1]]
			toks = append(toks, tok{mt, a.ok && a.down(m.bucketFor(mt))})
		}
		// how many to show: full → all; lead → primary, or up to the first live
		// model when the lead is down (the one that actually runs).
		last := len(toks) - 1
		if depth == 0 {
			last = 0
			for i, t := range toks {
				last = i
				if !t.down {
					break
				}
			}
		}
		// render a token as it displays (short name), returning the styled
		// string and its display width — struck if the model is down.
		render := func(t tok) (string, int) {
			c := strings.LastIndexByte(t.text, ':')
			short := shortModel(t.text[:c]) + t.text[c:]
			if t.down {
				s := stStruck.Render(short)
				return s, lipgloss.Width(s)
			}
			s := colorizeRoute(t.text) // paintModel shortens + colours
			return s, lipgloss.Width(s)
		}
		s0, w0 := render(toks[0])
		line, lineW := label+s0, labelW+w0
		for i := 1; i <= last; i++ {
			si, wi := render(toks[i])
			// Reserve 2 cols for a trailing " →" whenever more models follow, so a
			// break line's continuation arrow always fits within width instead of
			// being clipped at the edge; the final model needs no such reserve.
			budget := width
			if i < last {
				budget -= 2
			}
			if lineW+3+wi > budget { // won't fit — break after a trailing arrow
				out = append(out, line+stDim.Render(" →"))
				line, lineW = indent+si, labelW+wi
			} else {
				line += arrow + si
				lineW += 3 + wi
			}
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n") + "\n"
}

// splitMeta peels the "thinking … · fallback … · advisor …" summary line off a
// routing block (if present), returning it trimmed plus the remaining role rows.
func splitMeta(rows []string) (string, []string) {
	if len(rows) > 0 && strings.Contains(rows[0], "·") && !modelRe.MatchString(rows[0]) {
		return strings.TrimSpace(rows[0]), rows[1:]
	}
	return "", rows
}

func (m *model) syncPreview() {
	m.syncPreviewAt(0)
}

// syncPreviewKeepScroll re-renders while preserving the scroll position where
// still valid — resizes and background usage refreshes must never yank the view.
func (m *model) syncPreviewKeepScroll() {
	m.syncPreviewAt(m.vp.YOffset)
}

func (m *model) syncPreviewAt(yoff int) {
	if !m.rdy || m.collapse {
		return
	}
	rw := m.vp.Width
	// No settings summary here: every dial is already visible (selected) in the
	// generator list on the left, so the preview shows only what that selection
	// produces — the role → model routing itself.
	var b strings.Builder
	if target, local := m.selectedRuntime(); local {
		b.WriteString(lipgloss.NewStyle().Bold(true).Render(target.Label) + "\n")
		b.WriteString(stDim.Render(target.statusLine()) + "\n\n")
		if target.ContextWindow > 0 {
			b.WriteString(fmt.Sprintf("context     %dk tokens\n\n", target.ContextWindow/1000))
		}
		// Same grammar as a hosted profile: every role the broker's generated
		// profile routes (all of them but the advisor, which stays off), led by
		// the one local model at the dialed thinking — the flag is forwarded
		// verbatim and omp clamps it to what the model offers.
		rows := []string{fmt.Sprintf("  thinking %s · fallback off · advisor off", m.sel["thinking"])}
		for _, r := range genRoleOrder {
			if r == "advisor" {
				continue
			}
			marker := " "
			if genAgentRoles[r] {
				marker = "●"
			}
			rows = append(rows, fmt.Sprintf("  %s %-10s %s:%s", marker, r, target.Model, m.sel["thinking"]))
		}
		b.WriteString(m.renderRoute(rows, m.depth, m.selectedLaunchAvailability(), rw))
		b.WriteString("\n" + stDim.Render("broker-owned profile · cloud auth excluded · weights provisioned by the runtime") + "\n")
		content := lipgloss.NewStyle().MaxWidth(m.vp.Width).Render(b.String())
		m.vp.SetContent(content)
		m.vp.SetYOffset(yoff)
		return
	}
	id := comboID(m.sel, m.hasRelief)
	if m.noProviders {
		b.WriteString(stDim.Render("no connected OMP providers") + "\n")
	} else if base, ok := m.generated[id]; ok {
		_, roles := splitMeta(base)
		roles = m.applyAdvisor(roles, m.sel["advisor"])
		b.WriteString(m.renderRoute(roles, m.depth, m.selectedLaunchAvailability(), rw))
	} else {
		b.WriteString(stDim.Render("no profile for this combination") + "\n")
	}
	// clip (don't wrap) to pane width — renderRoute already wrapped the chains.
	content := lipgloss.NewStyle().MaxWidth(m.vp.Width).Render(b.String())
	m.vp.SetContent(content)
	m.vp.SetYOffset(yoff) // clamps into the new content and viewport height
}

// footer is the pinned bottom block: the usage panel (when this composition
// keeps Usage in the footer) then the controls help, each under a rule. Built
// once here so relayout and View stay in sync.
