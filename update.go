package main

import (
	"time"

	tea "github.com/charmbracelet/bubbletea"

	clikit "github.com/atyrode/cli-kit"
	"github.com/charmbracelet/bubbles/spinner"
)

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
		m.relayout()
	case ompVersionMsg:
		if msg.ok {
			m.ompMajor, m.ompMinor = msg.major, msg.minor
		}
		return m, nil
	case providerAvailabilityMsg:
		m.applyProviderAvailability(msg.pools)
		m.relayout()
		return m, nil
	case usageMsg:
		scoped, scopedStale := reconcileUsage(m.avail, msg.avail)
		refreshAt := time.Now().Add(refreshEvery)
		first := !m.hadUsage && msg.avail.ok
		m.avail, m.usageStale = scoped, scopedStale
		m.hadUsage = m.hadUsage || msg.avail.ok
		m.fetching = false
		if msg.avail.ok {
			saveUsageCache(m.usageCache, scoped)
		}
		m.nextRefresh = refreshAt
		if msg.avail.accountsOK {
			m.applyProviderAvailability(connectedPools(msg.avail.accounts))
		}
		m.relayout()
		if first {
			// The first real data replaces the skeleton: run the one-time
			// bounded bar fill. Refreshes never reach this branch again.
			m.barAnim = 1
			return m, barAnimCmd(2)
		}
	case barAnimMsg:
		// Bounded and self-terminating: apply the frame, arm the next tick,
		// and stop at the final step (barAnim 0 = inactive, bars at value).
		if m.barAnim == 0 {
			return m, nil
		}
		if msg.step >= barAnimSteps {
			m.barAnim = 0
			return m, nil
		}
		m.barAnim = msg.step
		return m, barAnimCmd(msg.step + 1)
	case refreshTickMsg:
		// re-arm the 1s tick; auto-refresh once the interval elapses.
		cmds := []tea.Cmd{tickCmd()}
		if !m.fetching && !m.nextRefresh.IsZero() && !time.Now().Before(m.nextRefresh) {
			cmds = append(cmds, m.startUsageFetch())
		}
		return m, tea.Batch(cmds...)
	case spinner.TickMsg:
		if m.fetching || !m.avail.ok {
			var cmd tea.Cmd
			m.spin, cmd = m.spin.Update(msg)
			return m, cmd
		}
	case admittedWheelMsg:
		m.applyWheelStep(msg.Button)
		return m, nil
	case tea.MouseMsg:
		// Wheel dispatch by pointer position: inside the visible Routing pane
		// the viewport owns vertical scrolling — continuous, ungated, clamped
		// by the viewport itself, with horizontal wheel deliberately inert.
		// Everywhere else direct Update calls apply one generator step; live
		// input is coalesced before dispatch by wheelInputFilter.
		if msg.Action == tea.MouseActionPress {
			if m.wheelInRouting(msg.X, msg.Y) {
				switch msg.Button {
				case tea.MouseButtonWheelUp:
					m.vp.LineDown(1) // inverted: operator-confirmed trackpad direction
				case tea.MouseButtonWheelDown:
					m.vp.LineUp(1)
				}
				return m, nil
			}
			m.applyWheelStep(msg.Button)
		}
	case tea.KeyMsg:
		if m.manager {
			return m.updateManager(msg)
		}
		switch msg.String() {
		case "q", "esc", "ctrl+c":
			return m, tea.Quit
		case "p":
			switch {
			case m.showUsage && m.sizeMode() == sizeNarrow:
				m.showUsage = false
				m.showResult = true
				m.collapse = false
			case m.collapse:
				m.collapse = false // restore the hidden preview
			case m.mode() == modeCollapsed:
				m.showResult = !m.showResult // narrow+short: swap list ↔ result full-screen
			default:
				m.collapse = true // split/stacked: hide the preview, list full-screen
			}
			m.relayout()
		case "s":
			// Toggle the rendered section, not the pre-toggle size class. Usage
			// changes the responsive minima, so a layout that fits while it is
			// hidden may become narrow when it returns. In that case open the
			// dedicated view atomically. It overlays the existing generator /
			// Routing state so closing it restores that exact composition.
			switch {
			case m.showUsage:
				m.showUsage = false
				m.hideUsage = true
			case !m.usageShown():
				m.hideUsage = false
				m.showUsage = m.sizeMode() == sizeNarrow
			default:
				m.showUsage = false
				m.hideUsage = true
			}
			m.relayout()
		case "i":
			m.fullUsageIDs = !m.fullUsageIDs
			m.relayout()
		case "?":
			m.help.ShowAll = !m.help.ShowAll
			m.relayout() // the taller/shorter footer changes the body height
		case "d":
			m.sel = defaultSel()
			if len(m.runtimeTargets) > 0 {
				m.sel["runtime"] = "hosted"
			}
			m.clampSel() // the defaults assume a full catalog; this one may not be
			m.persistSelection()
			m.syncPreview()
		case "f":
			m.depth = (m.depth + 1) % 2
			m.syncPreview()
		case "r":
			if m.broker.URL != "" && !m.fetching {
				return m, m.startUsageFetch()
			}
		case "v":
			m.manager = true
			m.clampManagerCursor()
			m.relayout()
		case "up", "k":
			m.moveUp()
		case "down", "j":
			m.moveDown()
		case "left", "h":
			m.cycleFacet(-1)
		case "right", "l":
			m.cycleFacet(1)
		case "u":
			// Untrusted sandbox: hand off to CODE_OMP_UNTRUSTED (ompu), which owns its
			// own routing/policy — no generated --config is passed to it. Inert when
			// no sandbox binary exists (the help hides the key too), so a stranger
			// can't kill the TUI with a stray keypress.
			if !m.hasSandbox {
				return m, nil
			}
			m.launchUntrusted = true
			return m, tea.Quit
		case "pgup", "ctrl+u":
			m.vp.HalfViewUp() // scroll the preview (mouse capture is off, see main)
		case "pgdown", "ctrl+d":
			m.vp.HalfViewDown()
		case "m":
			// Managed-defaults omp: omp-managed with no generated overlay. The
			// explicit keybind keeps every Enter launch a generated profile.
			m.launchManaged = true
			return m, tea.Quit
		case "enter":
			if target, local := m.selectedRuntime(); local {
				m.launchRuntime = target.Name
				return m, tea.Quit
			}
			if m.noProviders {
				return m, nil
			}
			// Enter always launches the generated profile for the current facets —
			// the untouched default combo is a generated profile like any other.
			// Never for a combo the catalog doesn't carry, though: genConfigYAML
			// would walk a nil block and emit an overlay whose modelRoles map is
			// empty, handing omp a session with no routing at all. The preview
			// already says "no profile for this combination", so the key does
			// nothing rather than launching something broken.
			if _, ok := m.generated[comboID(m.sel, m.hasRelief)]; !ok {
				return m, nil
			}
			m.genConfig = m.genConfigYAML()
			return m, tea.Quit
		}

	case clikit.ActionsProposedMsg:
		// Live preview: snapshot the current selection, then apply the proposal to
		// the generator so the user sees the change while deciding. Report the FULL
		// applied diff back to the box (the model's picks plus the derived toggles),
		// so its "applied" list reflects everything that changed, not just the three
		// facets the model named directly.
		m.savedSel = map[string]string{}
		for k, v := range m.sel {
			m.savedSel[k] = v
		}
		m.applyActions(msg.Actions)
		// applyActions' repair rules know lanes and quota, not catalog contents:
		// a "critical" proposal switches fable on even where no fable combo was
		// generated. Clamp and re-render before reporting what was applied.
		m.clampSel()
		m.syncPreview()
		return m, func() tea.Msg { return clikit.AppliedActionsMsg{Actions: m.appliedDiff()} }

	case clikit.ActionsConfirmedMsg:
		// Kept: the preview stays; remember the prompt for the launched session.
		m.savedSel = nil
		m.firstPrompt = msg.Prompt
		m.persistSelection()

	case clikit.ActionsRevertedMsg:
		// Rejected: restore the pre-preview selection.
		if m.savedSel != nil {
			m.sel = m.savedSel
			m.savedSel = nil
			m.syncPreview()
		}
	}
	return m, nil
}

// wheelInRouting reports whether a pointer position (terminal cells, 0-based)
// falls inside the visible Routing pane, whose viewport then owns vertical
// wheel scrolling: the wide split's right pane, medium's lower-right pane, or
// the narrow routing-only swap's full body. Hidden/collapsed routing claims
// nothing, so the generator keeps the wheel everywhere else.
func (m model) wheelInRouting(x, y int) bool {
	if !m.routingShown() {
		return false
	}
	ch := m.contentH()
	switch m.mode() {
	case modeCollapsed: // routing-only swap: the whole body is Routing
		return y >= topGap && y < topGap+ch
	case modeMedium: // the secondary row's right column, under the divider
		genH, secH := m.mediumSplit(ch)
		secTop := topGap + genH + 1
		return y >= secTop && y < secTop+secH && x >= m.w-m.routingColW()
	default: // split: the right pane, from the list's right edge on
		return y >= topGap && y < topGap+ch && x >= m.listW()
	}
}

// routingWheelCanMove reports whether a vertical routing scroll would change
// the viewport. No-op events at either clamp are filtered before redraw.
func (m model) routingWheelCanMove(b tea.MouseButton) bool {
	switch b {
	case tea.MouseButtonWheelUp:
		return m.vp.YOffset < m.vp.TotalLineCount()-m.vp.Height
	case tea.MouseButtonWheelDown:
		return m.vp.YOffset > 0
	default:
		return false
	}
}

// applyWheelStep translates one admitted wheel event into the matching facet
// action: vertical scroll moves the selection, horizontal scroll changes the
// value. The raw mapping is INVERTED on both axes — operator-confirmed trackpad
// direction: WheelUp moves the selection down, WheelDown up; WheelLeft cycles
// to the next (right) option, WheelRight to the previous. Arrow keys keep their
// literal semantics.
func (m *model) applyWheelStep(b tea.MouseButton) {
	switch b {
	case tea.MouseButtonWheelUp:
		m.moveDown()
	case tea.MouseButtonWheelDown:
		m.moveUp()
	case tea.MouseButtonWheelLeft:
		m.cycleFacet(1)
	case tea.MouseButtonWheelRight:
		m.cycleFacet(-1)
	}
}

func (m *model) moveUp() {
	if m.fcur > 0 {
		m.fcur--
	}
}
func (m *model) moveDown() {
	if m.fcur < len(m.visibleFacets())-1 {
		m.fcur++
	}
}
func (m *model) cycleFacet(dir int) {
	vf := m.visibleFacets()
	if m.fcur >= len(vf) {
		m.fcur = len(vf) - 1
	}
	f := vf[m.fcur]
	cur := m.sel[f.key]
	idx := 0
	for i, v := range f.values {
		if v == cur {
			idx = i
		}
	}
	next := idx + dir
	if next < 0 {
		next = 0
	} else if next >= len(f.values) {
		next = len(f.values) - 1
	}
	if next == idx {
		return
	}
	m.sel[f.key] = f.values[next]
	// lead/blend are lane's rendered halves: recompose the canonical value
	// before anything re-derives them (visibleFacets syncs from lane).
	if f.key == "lead" || f.key == "blend" {
		m.sel["lane"] = laneJoin(m.sel["lead"], m.sel["blend"])
	}
	// main is fable's sub-setting: whenever fable leaves "on" it must clear too,
	// so a later fable re-enable never silently resurrects the (expensive)
	// fable-as-main escalation — it is re-chosen deliberately every time.
	if m.sel["fable"] != "on" {
		m.sel["main"] = "off"
	}
	// changing the lane can hide/show facets; keep the cursor in range.
	if nv := len(m.visibleFacets()); m.fcur >= nv {
		m.fcur = nv - 1
	}
	m.syncPreview()
	m.persistSelection()
}

// prevPadL is the split preview pane's left padding. Width() counts it, so the
// viewport's usable text width is the box width minus this — the viewport must
// be sized to that inner area (see previewDims), else lines wrap 1:1 with the
// box and their tail overflows to the pane's left edge.
