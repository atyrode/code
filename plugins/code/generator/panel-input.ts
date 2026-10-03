/*
 * The main view's keys and wheel, as decisions over plain facts so the rules can be read and
 * tested apart from the DOM. Code's keys are panel-local: in-realm plugins share one document, so a
 * key pressed in another plugin must never act on Code, and a key Code consumes must not also act
 * on another plugin's global binding. The wheel belongs to scrolling unless a control holds focus and
 * the whole panel is at rest, so scrolling past the dials never edits the team.
 */

export type PanelShortcut = "next-step" | "leave-task" | "unpin" | "task" | "defaults" | "fallbacks" | "ids" | "refresh" | "keys";
export type PanelKey = {
  readonly key: string;
  /** Ctrl or Cmd: the platform's `Mod`. */
  readonly mod: boolean;
  readonly alt: boolean;
  readonly repeat: boolean;
  readonly defaultPrevented: boolean;
  /** The event's target is inside this panel's root (its popovers included). */
  readonly inPanel: boolean;
  /** The target edits text, where bare keys are typing. */
  readonly inField: boolean;
  /** The target is inside one of the panel's menus or popovers, which own their own keys. */
  readonly inPopover: boolean;
  /** The target is the task field. */
  readonly inTask: boolean;
  /** Roles are pinned open in the routing table. */
  readonly pinned: boolean;
};
const BARE_KEYS: Readonly<Record<string, PanelShortcut>> = { "/": "task", d: "defaults", f: "fallbacks", i: "ids", r: "refresh", "?": "keys" };

/**
 * The shortcut a key press means, or null when Code must leave it alone: anything from outside
 * the panel; a held key's repeats, so holding Mod+Enter cannot take one step after another; bare
 * keys while typing; keys a popover already handled. Escape leaves the task or unpins roles and
 * never discards edits.
 */
export function panelShortcut(press: PanelKey): PanelShortcut | null {
  if (!press.inPanel || press.repeat) return null;
  if (press.mod && press.key === "Enter") return "next-step";
  if (press.defaultPrevented || press.inPopover) return null;
  if (press.key === "Escape") return press.inTask ? "leave-task" : press.pinned ? "unpin" : null;
  if (press.inField || press.mod || press.alt) return null;
  return BARE_KEYS[press.key] ?? null;
}

/**
 * How long the whole panel must have been still, from scrolling and from wheel events left to
 * scroll, before a wheel turns anything; and how long the pointer must have rested on a keyboard-
 * focused control before the wheel turns it.
 */
export const WHEEL_REST_MS = 300;
/** Wheel travel per step: one mouse notch is usually 100 px; a trackpad gathers its small deltas into steps. */
export const WHEEL_STEP_PX = 40;
/** A pause after which partial travel is dropped, so a stray nudge never completes a later step. */
export const WHEEL_IDLE_MS = 220;

/** Travel toward the next option in px: wheel up or right is more, the knob's direction; lines and pages scale to px. */
export function wheelTravel(event: { readonly deltaX: number; readonly deltaY: number; readonly deltaMode: number }, pagePx: number): number {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pagePx : 1;
  return (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? -event.deltaY : event.deltaX) * unit;
}

/** The panel's wheel memory: when it last scrolled, when a wheel event was last left to scroll, and travel gathering toward a step. */
export type WheelRest = { readonly scrolledAt: number; readonly passedAt: number; readonly travel: number; readonly turnedAt: number };
export const WHEEL_STILL: WheelRest = {
  scrolledAt: Number.NEGATIVE_INFINITY, passedAt: Number.NEGATIVE_INFINITY, travel: 0, turnedAt: Number.NEGATIVE_INFINITY,
};

/** Anything in the panel scrolled: a turn waits for rest again, and partial travel is dropped. */
export function wheelScrolled(rest: WheelRest, nowMs: number): WheelRest {
  return { ...rest, scrolledAt: nowMs, travel: 0 };
}

export type WheelInput = {
  /** The event is over an open drum or menu, in the region allowed to turn. */
  readonly open: boolean;
  /** The event is over a control holding focus the keyboard gave it (`:focus-visible`); focus from a click never counts. */
  readonly keyboardFocused: boolean;
  /** How long the pointer has rested on that control: since it moved onto it, reset whenever the panel scrolls under it. */
  readonly restedMs: number;
  /** Ctrl or Cmd is held: the browser's zoom gesture. */
  readonly zoom: boolean;
  /** `wheelTravel` of the event. */
  readonly travel: number;
  readonly nowMs: number;
};

/**
 * One wheel event anywhere in the panel. It is taken only while the panel has been still for
 * `WHEEL_REST_MS`, and only over an open drum or menu, or over a control the keyboard focused that
 * the pointer has rested on for `WHEEL_REST_MS`: a word just clicked holds focus, but the wheel
 * over it scrolls, its first notch included. A taken event turns one step (+1 next, -1 previous)
 * once a notch of travel has gathered. Every other event is left to scroll and renews the rest
 * wherever in the panel it lands, so a scroll gesture that drifts onto a control keeps scrolling,
 * even at a scroll boundary where nothing moves and no scroll event fires.
 */
export function panelWheel(rest: WheelRest, input: WheelInput): { rest: WheelRest; take: boolean; step: -1 | 0 | 1 } {
  const { nowMs, travel } = input;
  const engaged = input.open || (input.keyboardFocused && input.restedMs >= WHEEL_REST_MS);
  if (!engaged || input.zoom || nowMs - rest.scrolledAt < WHEEL_REST_MS || nowMs - rest.passedAt < WHEEL_REST_MS) {
    return { rest: { ...rest, passedAt: nowMs, travel: 0 }, take: false, step: 0 };
  }
  const gathered = (nowMs - rest.turnedAt > WHEEL_IDLE_MS || Math.sign(rest.travel) !== Math.sign(travel) ? 0 : rest.travel) + travel;
  if (Math.abs(gathered) < WHEEL_STEP_PX) return { rest: { ...rest, travel: gathered, turnedAt: nowMs }, take: true, step: 0 };
  return { rest: { ...rest, travel: 0, turnedAt: nowMs }, take: true, step: gathered > 0 ? 1 : -1 };
}
