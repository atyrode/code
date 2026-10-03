/*
 * The main view's keys and wheel, as decisions over plain facts so the rules can be read and
 * tested apart from the DOM. Code's keys are panel-local: in-realm plugins share one document, so a
 * key pressed in another plugin must never act on Code, and a key Code consumes must not also act
 * on another plugin's global binding. The wheel belongs to scrolling unless a dial holds focus and
 * the page is at rest, so scrolling past the dials never edits the team.
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

/** How long the page must have been still, from scrolling and from wheel turns it kept, before a wheel turns a dial. */
export const WHEEL_REST_MS = 300;
/** Wheel travel per dial step: one mouse notch is usually 100 px; a trackpad gathers its small deltas into steps. */
export const WHEEL_STEP_PX = 40;
/** A pause after which partial travel is dropped, so a stray nudge never completes a later step. */
export const WHEEL_IDLE_MS = 220;

export type WheelGate = {
  /** Focus is inside the dial the pointer is over. */
  readonly focused: boolean;
  /** Ctrl or Cmd is held: the browser's zoom gesture. */
  readonly zoom: boolean;
  /** Since the panel last scrolled. */
  readonly sinceScrollMs: number;
  /** Since a wheel event was last left to scroll the page. */
  readonly sincePassedMs: number;
};
/**
 * Whether the wheel may turn the dial under the pointer rather than scroll. A scroll gesture that
 * reaches a focused dial keeps scrolling: each event it passes renews the rest it must wait out.
 */
export function wheelTurnsDial(gate: WheelGate): boolean {
  return gate.focused && !gate.zoom && gate.sinceScrollMs >= WHEEL_REST_MS && gate.sincePassedMs >= WHEEL_REST_MS;
}

/** Travel toward the next option in px: wheel up or right is more, the knob's direction; lines and pages scale to px. */
export function wheelTravel(event: { readonly deltaX: number; readonly deltaY: number; readonly deltaMode: number }, pagePx: number): number {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pagePx : 1;
  return (Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? -event.deltaY : event.deltaX) * unit;
}

export type WheelTurn = { readonly travel: number; readonly at: number };
export const WHEEL_AT_REST: WheelTurn = { travel: 0, at: Number.NEGATIVE_INFINITY };
/** Gather travel into whole steps: +1 for the next option, -1 for the previous, 0 while a step is still gathering. */
export function turnWheel(turn: WheelTurn, travel: number, nowMs: number): { turn: WheelTurn; step: -1 | 0 | 1 } {
  const gathered = (nowMs - turn.at > WHEEL_IDLE_MS || Math.sign(turn.travel) !== Math.sign(travel) ? 0 : turn.travel) + travel;
  if (Math.abs(gathered) < WHEEL_STEP_PX) return { turn: { travel: gathered, at: nowMs }, step: 0 };
  return { turn: { travel: 0, at: nowMs }, step: gathered > 0 ? 1 : -1 };
}
