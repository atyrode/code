package main

import (
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// ── trackpad / mouse wheel ───────────────────────────────────────────────────
// The wheel drives the generator directly: vertical scroll moves the facet
// selection, horizontal scroll changes the selected facet's value. Terminal
// mouse protocols expose direction-only press events rather than trackpad
// distance, so require a small burst before committing one generator step.
// This gives fine Mac trackpad motion room to settle without making every raw
// event select a new row or option. Routing remains continuous and ungated.
const (
	wheelStepEvents = 5
	wheelGestureGap = 200 * time.Millisecond
)

const (
	wheelAxisNone = iota
	wheelAxisV
	wheelAxisH
)

// admittedWheelMsg marks a generator wheel event whose same-direction burst
// crossed the step threshold before Bubble Tea's Update/render cycle.
type admittedWheelMsg struct{ tea.MouseMsg }

// wheelTarget is the layout state the pre-dispatch filter needs. Keeping this
// interface narrow also lets the raw-input regression test wrap model while
// preserving the exact production filter path.
type wheelTarget interface {
	wheelInRouting(int, int) bool
	routingWheelCanMove(tea.MouseButton) bool
}

// wheelInputFilter removes mouse traffic before Bubble Tea's unconditional
// redraw-after-Update. Generator motion accumulates by axis and direction;
// only each complete threshold reaches Update. Motion, non-wheel presses,
// routing horizontal wheel, and clamped routing scroll are dropped because
// none can change the view.
type wheelInputFilter struct {
	axis   int
	button tea.MouseButton
	count  int
	last   time.Time
}

func (f *wheelInputFilter) Filter(app tea.Model, msg tea.Msg) tea.Msg {

	mouse, ok := msg.(tea.MouseMsg)
	if !ok {
		return msg
	}
	if mouse.Action != tea.MouseActionPress {
		return nil
	}
	target, ok := app.(wheelTarget)
	if !ok {
		return msg
	}
	if target.wheelInRouting(mouse.X, mouse.Y) {
		switch mouse.Button {
		case tea.MouseButtonWheelUp, tea.MouseButtonWheelDown:
			if target.routingWheelCanMove(mouse.Button) {
				return mouse
			}
		}
		return nil
	}

	axis := wheelAxisNone
	switch mouse.Button {
	case tea.MouseButtonWheelUp, tea.MouseButtonWheelDown:
		axis = wheelAxisV
	case tea.MouseButtonWheelLeft, tea.MouseButtonWheelRight:
		axis = wheelAxisH
	default:
		return nil
	}
	now := time.Now()
	if f.count > 0 && now.Sub(f.last) <= wheelGestureGap && axis != f.axis {
		// Ignore brief orthogonal trackpad jitter without discarding progress
		// along the operator's dominant gesture axis.
		return nil
	}
	if axis != f.axis || mouse.Button != f.button || now.Sub(f.last) > wheelGestureGap {
		f.axis = axis
		f.button = mouse.Button
		f.count = 0
	}
	f.last = now
	f.count++
	if f.count < wheelStepEvents {
		return nil
	}
	f.count = 0
	return admittedWheelMsg{MouseMsg: mouse}
}
