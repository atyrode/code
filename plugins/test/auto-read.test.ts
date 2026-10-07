import { describe, expect, test } from "bun:test";
import { AUTO_READ_MS, EDIT_QUIET_MS, HOLD_RECHECK_MS, PASS_READS, readAll, readHeld, runReads, SHOWN_AGAIN_MS, tickClock, tickReads,
  type Observation, type PanelClocks, type ReadClock } from "../code/generator/auto-read.ts";
import { USAGE_FRESH_MS } from "../code/generator/usage-model.ts";

const start: ReadClock = { at: 0, owed: false };
const look = (clock: ReadClock, nowMs: number, changes: { visible?: boolean; shown?: boolean; held?: boolean } = {}) =>
  tickClock(clock, { nowMs, periodMs: AUTO_READ_MS, visible: true, shown: false, held: false, ...changes });

describe("the workbench reads its inputs again on its own", () => {
  test("a read comes due a period after the last one, and waits for nothing else", () => {
    expect(look(start, AUTO_READ_MS - 1)).toEqual({ read: false, clock: start, wakeAt: AUTO_READ_MS });
    expect(look(start, AUTO_READ_MS)).toEqual({ read: true, clock: { at: AUTO_READ_MS, owed: false }, wakeAt: 2 * AUTO_READ_MS });
  });

  test("a read never happens while the person is mid-edit, a step runs or a sheet is open; it is owed and happens once the hold lifts", () => {
    for (const hold of [{ step: true }, { open: true }, { editing: true }, { unsaved: true }]) {
      const facts = { step: false, open: false, editing: false, unsaved: false, inputAt: -EDIT_QUIET_MS, ...hold };
      const held = look(start, AUTO_READ_MS, { held: readHeld(facts, AUTO_READ_MS) });
      expect(held).toEqual({ read: false, clock: { at: 0, owed: true }, wakeAt: AUTO_READ_MS + HOLD_RECHECK_MS });
      // Still held a minute later: still owed, never read.
      expect(look(held.clock, 2 * AUTO_READ_MS, { held: true }).read).toBe(false);
      expect(look(held.clock, 2 * AUTO_READ_MS, { held: false })).toMatchObject({ read: true, clock: { at: 2 * AUTO_READ_MS, owed: false } });
    }
    // A press a moment ago is an edit in progress; a few seconds later it is over.
    const idle = { step: false, open: false, editing: false, unsaved: false };
    expect(readHeld({ ...idle, inputAt: AUTO_READ_MS - 1000 }, AUTO_READ_MS)).toBe(true);
    expect(readHeld({ ...idle, inputAt: AUTO_READ_MS - EDIT_QUIET_MS }, AUTO_READ_MS)).toBe(false);
    // An edit left unsaved, the field blurred and the panel quiet for minutes, still holds.
    expect(readHeld({ ...idle, unsaved: true, inputAt: 0 }, 10 * AUTO_READ_MS)).toBe(true);
  });

  test("a hidden panel reads nothing, and reads once when it shows again unless it read a moment ago", () => {
    const hidden = look(start, 3 * AUTO_READ_MS, { visible: false });
    expect(hidden).toEqual({ read: false, clock: { at: 0, owed: true }, wakeAt: null });
    expect(look(hidden.clock, 3 * AUTO_READ_MS, { shown: true }).read).toBe(true);
    // A quick look elsewhere and back costs no read; a longer absence does.
    expect(look(start, SHOWN_AGAIN_MS - 1, { shown: true }).read).toBe(false);
    expect(look(start, SHOWN_AGAIN_MS, { shown: true }).read).toBe(true);
    expect(look(start, SHOWN_AGAIN_MS, { shown: true, held: true }).read).toBe(false);
  });
});

describe("the panel's two clocks share one pass", () => {
  const started: PanelClocks = readAll(0).clocks;
  /** Runs a pass against readers that count each underlying read. */
  function counted(pass: { reads: Parameters<typeof runReads>[0] }) {
    const counts = new Map<Observation, number>();
    const readers = Object.fromEntries(Object.values(PASS_READS).flat().map(name => [name, () => { counts.set(name, (counts.get(name) ?? 0) + 1); }]));
    runReads(pass.reads, readers as Record<Observation, () => void>);
    return Object.fromEntries(counts);
  }
  const once = (...kinds: (keyof typeof PASS_READS)[]) => Object.fromEntries(kinds.flatMap(kind => PASS_READS[kind]).map(name => [name, 1]));
  const facts = { visible: true, shown: false, held: false };

  test("when both come due together, every observation is read once", () => {
    const due = tickReads(started, { ...facts, nowMs: USAGE_FRESH_MS });
    expect(due.reads).toEqual(["inputs", "usage"]);
    expect(counted(due)).toEqual(once("inputs", "usage"));
    expect(due.clocks).toEqual(readAll(USAGE_FRESH_MS).clocks);
  });

  test("a panel shown again after a long absence reads its inputs and its usage once each", () => {
    const hidden = tickReads(started, { ...facts, nowMs: 2 * USAGE_FRESH_MS, visible: false });
    expect(hidden).toMatchObject({ reads: [], wakeAt: null, clocks: { inputs: { at: 0, owed: true }, usage: { at: 0, owed: true } } });
    expect(counted(tickReads(hidden.clocks, { ...facts, nowMs: 2 * USAGE_FRESH_MS, shown: true }))).toEqual(once("inputs", "usage"));
    // Held when it shows, both wait, then read together once the hold lifts.
    const held = tickReads(hidden.clocks, { ...facts, nowMs: 2 * USAGE_FRESH_MS, shown: true, held: true });
    expect(held.reads).toEqual([]);
    expect(counted(tickReads(held.clocks, { ...facts, nowMs: 2 * USAGE_FRESH_MS + HOLD_RECHECK_MS }))).toEqual(once("inputs", "usage"));
  });

  test("the minute clock reads the inputs alone, the usage clock the usage and the sessions alone", () => {
    const minute = tickReads(started, { ...facts, nowMs: AUTO_READ_MS });
    expect(counted(minute)).toEqual(once("inputs"));
    const usage = tickReads({ ...started, inputs: { at: USAGE_FRESH_MS - 1, owed: false } }, { ...facts, nowMs: USAGE_FRESH_MS });
    expect(counted(usage)).toEqual(once("usage"));
    // A panel shown again reads its inputs, never the usage only for that.
    expect(tickReads(started, { ...facts, nowMs: SHOWN_AGAIN_MS, shown: true }).reads).toEqual(["inputs"]);
  });

  test("Refresh now reads everything once and answers both clocks, owed or not, so neither reads again right after", () => {
    // Both owed and held: a press reads at once all the same, and the owed reads are answered by it.
    expect(tickReads(started, { ...facts, nowMs: USAGE_FRESH_MS, held: true }).reads).toEqual([]);
    const refreshed = readAll(USAGE_FRESH_MS + 1);
    expect(counted(refreshed)).toEqual(once("inputs", "usage"));
    const after = tickReads(refreshed.clocks, { ...facts, nowMs: USAGE_FRESH_MS + 1 + HOLD_RECHECK_MS });
    expect(after.reads).toEqual([]);
    expect(after.wakeAt).toBe(USAGE_FRESH_MS + 1 + AUTO_READ_MS);
  });
});
