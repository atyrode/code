import { USAGE_FRESH_MS } from "./usage-model.ts";

/*
 * The panel's own re-reads, as rules: when the workbench reads its inputs and its usage again
 * without being asked, and when it waits. React-free, so the rules are tested apart from timers and
 * the DOM.
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
  /**
   * An edit not yet saved or discarded: a changed profile (draft-store.ts `editedDraft`) or a saved
   * pool's draft. It holds however long it is left, focused or not, so a read never lands under it.
   */
  readonly unsaved: boolean;
  /** When the person last pressed a key or the pointer in the panel. */
  readonly inputAt: number;
};

/** Whether a read on its own must wait now. */
export function readHeld(facts: ReadHoldFacts, nowMs: number): boolean {
  return facts.step || facts.open || facts.editing || facts.unsaved || nowMs - facts.inputAt < EDIT_QUIET_MS;
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

/**
 * What a pass reads, by the clock that asks for it. `inputs`, once a minute and when the panel shows
 * again: the workbench's observations and the machine list. `usage`, every usage freshness window:
 * the usage reading, the sessions already read and Code's Runs, whose access-topic events can be
 * missed across a reconnect. A panel shown again leaves the usage to its feed's own read on return,
 * so the bars do not drain at every look back.
 */
export const PASS_READS = {
  inputs: ["configuration", "metadata", "setup", "defaults", "skills", "accounts", "machines"],
  usage: ["usage", "sessions", "runs"],
} as const;
export type ReadKind = keyof typeof PASS_READS;
/** One underlying read: a query or feed read again. */
export type Observation = (typeof PASS_READS)[ReadKind][number];
export type PanelClocks = Readonly<Record<ReadKind, ReadClock>>;
const READ_KINDS = Object.keys(PASS_READS) as ReadKind[];
const PERIODS: Readonly<Record<ReadKind, number>> = { inputs: AUTO_READ_MS, usage: USAGE_FRESH_MS };

/** When each clock reads next. */
export function nextReads(clocks: PanelClocks): Readonly<Record<ReadKind, number>> {
  return { inputs: clocks.inputs.at + PERIODS.inputs, usage: clocks.usage.at + PERIODS.usage };
}

/** Both clocks just read: at first, and after Refresh now, `r` or a sheet's open or close, which read everything. */
export function readAll(nowMs: number): { readonly reads: readonly ReadKind[]; readonly clocks: PanelClocks } {
  return { reads: READ_KINDS, clocks: { inputs: { at: nowMs, owed: false }, usage: { at: nowMs, owed: false } } };
}

/**
 * One look at both clocks, so whatever comes due together reads in one pass: a panel shown again
 * after a long absence reads its inputs and its usage once each, never the inputs twice. The clocks
 * come back unchanged, the same object, when neither moved.
 */
export function tickReads(clocks: PanelClocks, facts: Omit<ClockFacts, "periodMs">): { readonly reads: readonly ReadKind[]; readonly clocks: PanelClocks; readonly wakeAt: number | null } {
  const reads: ReadKind[] = [];
  const next = { ...clocks };
  let moved = false, wakeAt: number | null = null;
  for (const kind of READ_KINDS) {
    const step = tickClock(clocks[kind], { ...facts, periodMs: PERIODS[kind], shown: facts.shown && kind === "inputs" });
    if (step.read) reads.push(kind);
    if (step.clock.at !== clocks[kind].at || step.clock.owed !== clocks[kind].owed) { next[kind] = step.clock; moved = true; }
    if (step.wakeAt !== null) wakeAt = wakeAt === null ? step.wakeAt : Math.min(wakeAt, step.wakeAt);
  }
  return { reads, clocks: moved ? next : clocks, wakeAt };
}

/** Reads a pass: every observation its kinds name, each once. */
export function runReads(reads: readonly ReadKind[], readers: Readonly<Record<Observation, () => void>>): void {
  for (const observation of new Set(reads.flatMap(kind => PASS_READS[kind]))) readers[observation]();
}
