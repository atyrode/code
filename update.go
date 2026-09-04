package main

import (
	"fmt"
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
	case gitRepoMsg:
		if msg.ok && !msg.linked && msg.root != "" {
			m.gitRoot, m.gitPrefix = msg.root, msg.prefix
			// A ceremony launches nothing, so an isolated worktree has nothing
			// to hold: the key stays hidden even where a repository was found.
			if !m.configuring {
				keys.Worktree.SetEnabled(true)
			}
		}
		return m, nil
	case credentialBlocksClearedMsg:
		if msg.credentialID != m.blockRetryingID {
			return m, nil
		}
		if msg.err != nil {
			m.blockRetryingID = ""
			m.accountErr = fmt.Sprintf("retry failed: %v", msg.err)
			return m, nil
		}
		m.accountErr = ""
		if m.broker.configured() {
			return m, m.startUsageFetch()
		}
		m.blockRetryingID = ""
		return m, nil
	case authLoginFinishedMsg:
		m.managerLogin = false
		if msg.err != nil {
			m.accountErr = fmt.Sprintf("%s login failed: %v", msg.provider, msg.err)
			return m, nil
		}
		m.accountErr = ""
		if m.broker.configured() {
			return m, m.startUsageFetch()
		}
		return m, probeProviderAvailabilityCmd()
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
		m.blockRetryingID = ""
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
		case "n":
			// Reveal the routing preview's full model ids. A view preference,
			// not routing: nothing about the selection or the launched profile
			// changes, so it is never persisted — only the preview repaints.
			m.showFullIDs = !m.showFullIDs
			m.syncPreviewKeepScroll()
		case "?":
			m.help.ShowAll = !m.help.ShowAll
			m.relayout() // the taller/shorter footer changes the body height
		case "d":
			m.sel = defaultSel()
			if len(m.runtimeTargets) > 0 {
				m.sel["runtime"] = "hosted"
			}
			if m.local.offered() {
				m.sel[localFacetKey] = localOff
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
		case "w":
			if m.gitRoot == "" || m.configuring {
				return m, nil
			}
			m.worktreeMode = !m.worktreeMode
			return m, nil
		case "u":
			// Untrusted sandbox: hand off to CODE_OMP_UNTRUSTED (ompu), which owns its
			// own routing/policy — no generated --config is passed to it. Inert when
			// no sandbox binary exists (the help hides the key too), so a stranger
			// can't kill the TUI with a stray keypress.
			// A ceremony is answered with a profile, and this launcher owns its
			// own routing: there is nothing here Code could describe to Babel.
			if !m.hasSandbox || m.configuring {
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
			// Inert during a ceremony: omp's own defaults are not a Code
			// profile, so confirming them would mint a reference to dials Code
			// never resolved.
			if m.configuring {
				return m, nil
			}
			m.launchManaged = true
			return m, tea.Quit
		case "enter":
			// The local lane is confirmed before the hosted checks below, and
			// needs none of them: it resolves no catalog combination and no
			// provider credential, so a machine with neither can still mint a
			// profile that runs (locallane.go).
			if chosen, on := m.selectedLocalModel(); on {
				if !m.configuring {
					// A launch is not this lane's business: the dial exists
					// only in the ceremony, and reaching here otherwise would
					// mean an inconsistent model rather than a session to run.
					return m, nil
				}
				m.localConfirmed = chosen
				m.sel["thinking"] = localThinking(m.sel["thinking"])
				return m, tea.Quit
			}
			if target, local := m.selectedRuntime(); local {
				m.launchRuntime = target.Name
				return m, tea.Quit
			}
			if m.noProviders {
				return m, nil
			}
			// Enter always launches the generated profile for the current facets —
			// the untouched default combo is a generated profile like any other.
			// During a ceremony the same key confirms that profile instead, and
			// the model it leaves behind is what gets minted.
			// Never for a combo the catalog doesn't carry, though: genConfigYAML
			// would walk a nil block and emit an overlay whose modelRoles map is
			// empty, handing omp a session with no routing at all. The preview
			// already says "no profile for this combination", so the key does
			// nothing rather than launching something broken.
			if _, ok := m.generated[comboID(m.sel)]; !ok {
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
		// a proposal can size the model dial past the notch this lane's combos
		// carry. Clamp and re-render before reporting what was applied.
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

// clampFacetCursor keeps the row cursor inside the visible facets.
//
// No visible facets is a legitimate state, not an impossible one: a generator
// with no connected credentials renders no dials at all (see
// applyProviderAvailability), which is exactly the state a fresh machine opens
// in. The floor of zero is what makes it legitimate — a bare len-1 is -1 there,
// and a negative cursor is not merely out of range for the read that happens
// next, it survives in the model and crashes a later keypress made in a
// perfectly ordinary state.
func (m *model) clampFacetCursor(visible int) {
	if m.fcur >= visible {
		m.fcur = max(visible-1, 0)
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
	if len(vf) == 0 {
		return // no dials rendered, so there is no dial to turn
	}
	m.clampFacetCursor(len(vf))
	f := vf[m.fcur]
	cur := m.sel[f.key]
	idx := 0
	for i, v := range f.values {
		if v == cur {
			idx = i
		}
	}
	// lead/blend recompose the canonical lane; a value whose composed lane
	// the connected credentials cannot run is visible but not a stop — keep
	// stepping past it (and clamp at the ends like any other dial).
	composed := func(i int) string {
		switch f.key {
		case "lead":
			return m.composeLane(f.values[i], m.sel["blend"])
		case "blend":
			return laneJoin(m.sel["lead"], f.values[i])
		}
		return ""
	}
	next := idx + dir
	for f.key == "lead" || f.key == "blend" {
		if next < 0 || next >= len(f.values) {
			return // every further stop is out of range or unusable
		}
		if m.laneUsable(composed(next)) {
			break
		}
		next += dir
	}
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
	switch f.key {
	case "lead":
		m.sel["lane"] = composed(next)
	case "blend":
		m.sel["lane"] = laneJoin(m.sel["lead"], m.sel["blend"])
	}
	// A lane switch can land on a shallower ladder (a lane whose pools stop at
	// tier 3), where the notch just left behind was never generated. clampSel
	// snaps the model dial back onto a served rung, so what the dial shows is
	// always a combination the catalog carries.
	if f.key == "lead" || f.key == "blend" {
		m.clampSel()
	}
	// The local lane's thinking dial is two levels wide (locallane.go), so
	// turning it on with the hosted dial parked at "max" would leave a value
	// this endpoint cannot be asked for selected — and minted. Clamping here
	// means the dial the operator sees is the dial that gets recorded.
	if _, on := m.selectedLocalModel(); on {
		m.sel["thinking"] = localThinking(m.sel["thinking"])
	}
	// changing the lane can hide/show facets; keep the cursor in range.
	m.clampFacetCursor(len(m.visibleFacets()))
	m.syncPreview()
	m.persistSelection()
}

// prevPadL is the split preview pane's left padding. Width() counts it, so the
// viewport's usable text width is the box width minus this — the viewport must
// be sized to that inner area (see previewDims), else lines wrap 1:1 with the
// box and their tail overflows to the pane's left edge.
