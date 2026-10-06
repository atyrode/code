/*
 * The panel's own re-reads, as rules: when the workbench reads its inputs again without being
 * asked, and when it waits. React-free, so the rules are tested apart from timers and the DOM.
 */

/**
 * How often the workbench reads its inputs again while it shows: once a minute. The host's feeds
 * read Code's own configuration again on its events, but OMP's observations (setup, defaults, the
 * bundled model list, skills, accounts) and the machine list change without one. A minute keeps a
 * panel left open current within a glance's patience. It costs a handful of small reads a minute,
 * and none while the panel is hidden.
 */
export const AUTO_READ_MS = 60_000;
/** A panel shown again reads again, unless it read this recently: a quick look elsewhere and back costs nothing. */
export const SHOWN_AGAIN_MS = 15_000;
/** How long after a press or a key the person still counts as in the middle of an edit. */
export const EDIT_QUIET_MS = 4_000;
/** How soon a held read looks again whether its hold has lifted. */
export const HOLD_RECHECK_MS = 1_000;

/** When the clock last read, and whether a read is owed: one came due while the panel was hidden or held. */
export type ReadClock = { readonly at: number; readonly owed: boolean };

/** What the person is in the middle of, which a read on its own never interrupts. */
export type ReadHoldFacts = {
  /** A step runs or a verification charge waits. */
  readonly step: boolean;
  /** A sheet, the shortcuts, the More menu or the machine list is open. */
  readonly open: boolean;
  /** A row is being scrubbed, a text field has focus or an account change is saving. */
  readonly editing: boolean;
  /** When the person last pressed a key or the pointer in the panel. */
  readonly inputAt: number;
};

/** Whether a read on its own must wait now. */
export function readHeld(facts: ReadHoldFacts, nowMs: number): boolean {
  return facts.step || facts.open || facts.editing || nowMs - facts.inputAt < EDIT_QUIET_MS;
}

export type ClockFacts = {
  readonly nowMs: number;
  readonly periodMs: number;
  /** The panel shows: its page is not hidden and the panel is on screen. */
  readonly visible: boolean;
  /** The panel has just come back into view. */
  readonly shown: boolean;
  readonly held: boolean;
};

/**
 * One look at the clock. A read comes due a period after the last one, and when the panel is
 * shown again (unless it read within `SHOWN_AGAIN_MS`). A read that comes due while the panel is
 * hidden or held is owed: it happens once the panel shows and nothing holds it, never before.
 * `wakeAt` is when to look again; null waits for the panel to show.
 */
export function tickClock(clock: ReadClock, facts: ClockFacts): { readonly read: boolean; readonly clock: ReadClock; readonly wakeAt: number | null } {
  const elapsed = facts.nowMs - clock.at;
  const owed = clock.owed || elapsed >= facts.periodMs || (facts.shown && elapsed >= SHOWN_AGAIN_MS);
  if (!facts.visible) return { read: false, clock: { at: clock.at, owed }, wakeAt: null };
  if (!owed) return { read: false, clock, wakeAt: clock.at + facts.periodMs };
  if (facts.held) return { read: false, clock: { at: clock.at, owed: true }, wakeAt: facts.nowMs + HOLD_RECHECK_MS };
  return { read: true, clock: { at: facts.nowMs, owed: false }, wakeAt: facts.nowMs + facts.periodMs };
}
