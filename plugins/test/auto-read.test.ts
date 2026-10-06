import { describe, expect, test } from "bun:test";
import { AUTO_READ_MS, EDIT_QUIET_MS, HOLD_RECHECK_MS, readHeld, SHOWN_AGAIN_MS, tickClock, type ReadClock } from "../code/generator/auto-read.ts";

const start: ReadClock = { at: 0, owed: false };
const look = (clock: ReadClock, nowMs: number, changes: { visible?: boolean; shown?: boolean; held?: boolean } = {}) =>
  tickClock(clock, { nowMs, periodMs: AUTO_READ_MS, visible: true, shown: false, held: false, ...changes });

describe("the workbench reads its inputs again on its own", () => {
  test("a read comes due a period after the last one, and waits for nothing else", () => {
    expect(look(start, AUTO_READ_MS - 1)).toEqual({ read: false, clock: start, wakeAt: AUTO_READ_MS });
    expect(look(start, AUTO_READ_MS)).toEqual({ read: true, clock: { at: AUTO_READ_MS, owed: false }, wakeAt: 2 * AUTO_READ_MS });
  });

  test("a read never happens while the person is mid-edit, a step runs or a sheet is open; it is owed and happens once the hold lifts", () => {
    for (const hold of [{ step: true }, { open: true }, { editing: true }]) {
      const facts = { step: false, open: false, editing: false, inputAt: -EDIT_QUIET_MS, ...hold };
      const held = look(start, AUTO_READ_MS, { held: readHeld(facts, AUTO_READ_MS) });
      expect(held).toEqual({ read: false, clock: { at: 0, owed: true }, wakeAt: AUTO_READ_MS + HOLD_RECHECK_MS });
      // Still held a minute later: still owed, never read.
      expect(look(held.clock, 2 * AUTO_READ_MS, { held: true }).read).toBe(false);
      expect(look(held.clock, 2 * AUTO_READ_MS, { held: false })).toMatchObject({ read: true, clock: { at: 2 * AUTO_READ_MS, owed: false } });
    }
    // A press a moment ago is an edit in progress; a few seconds later it is over.
    const idle = { step: false, open: false, editing: false };
    expect(readHeld({ ...idle, inputAt: AUTO_READ_MS - 1000 }, AUTO_READ_MS)).toBe(true);
    expect(readHeld({ ...idle, inputAt: AUTO_READ_MS - EDIT_QUIET_MS }, AUTO_READ_MS)).toBe(false);
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
