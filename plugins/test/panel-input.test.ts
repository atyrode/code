import { describe, expect, test } from "bun:test";
import {
  panelShortcut, turnWheel, wheelTravel, wheelTurnsDial, WHEEL_AT_REST, WHEEL_IDLE_MS, WHEEL_REST_MS, WHEEL_STEP_PX, type PanelKey,
} from "../code/generator/panel-input.ts";

/** A key pressed on a dial inside the panel; each test changes only what it is about. */
function press(key: string, changes: Partial<PanelKey> = {}): PanelKey {
  return { key, mod: false, alt: false, repeat: false, defaultPrevented: false, inPanel: true, inField: false, inPopover: false, inTask: false, pinned: false, ...changes };
}

describe("the panel's keys", () => {
  test("a key pressed in another plugin never acts on Code, not even the next-step chord or Escape", () => {
    for (const key of ["Enter", "Escape", "d", "f", "i", "r", "/", "?"]) {
      expect(panelShortcut(press(key, { inPanel: false }))).toBeNull();
      expect(panelShortcut(press(key, { inPanel: false, mod: true }))).toBeNull();
    }
    expect(panelShortcut(press("Escape", { inPanel: false, inTask: true, pinned: true }))).toBeNull();
  });

  test("Mod+Enter takes the next step from anywhere in the panel, once per press", () => {
    expect(panelShortcut(press("Enter", { mod: true }))).toBe("next-step");
    expect(panelShortcut(press("Enter", { mod: true, inTask: true, inField: true }))).toBe("next-step");
    expect(panelShortcut(press("Enter", { mod: true, inPopover: true }))).toBe("next-step");
    expect(panelShortcut(press("Enter", { mod: true, repeat: true }))).toBeNull();
    expect(panelShortcut(press("Enter"))).toBeNull();
  });

  test("Escape leaves the task or unpins roles, and otherwise does nothing: it never discards edits", () => {
    expect(panelShortcut(press("Escape", { inTask: true, inField: true, pinned: true }))).toBe("leave-task");
    expect(panelShortcut(press("Escape", { pinned: true }))).toBe("unpin");
    expect(panelShortcut(press("Escape"))).toBeNull();
    expect(panelShortcut(press("Escape", { inPopover: true, pinned: true }))).toBeNull();
  });

  test("bare keys act on the panel but never while typing, under a modifier, in a popover or once handled", () => {
    expect([..."/dfir?"].map(key => panelShortcut(press(key)))).toEqual(["task", "defaults", "fallbacks", "ids", "refresh", "keys"]);
    for (const changes of [{ inField: true }, { mod: true }, { alt: true }, { inPopover: true }, { defaultPrevented: true }, { repeat: true }]) {
      expect(panelShortcut(press("d", changes))).toBeNull();
    }
    expect(panelShortcut(press("x"))).toBeNull();
  });
});

describe("the wheel over a dial", () => {
  const rested = { focused: true, zoom: false, sinceScrollMs: WHEEL_REST_MS, sincePassedMs: WHEEL_REST_MS };

  test("turns a dial only while it holds focus and the page has rested from scrolling", () => {
    expect(wheelTurnsDial(rested)).toBe(true);
    expect(wheelTurnsDial({ ...rested, focused: false })).toBe(false);
    expect(wheelTurnsDial({ ...rested, zoom: true })).toBe(false);
    expect(wheelTurnsDial({ ...rested, sinceScrollMs: WHEEL_REST_MS - 1 })).toBe(false);
    // A scroll gesture that reaches a focused dial at the end of the page keeps scrolling, not turning.
    expect(wheelTurnsDial({ ...rested, sincePassedMs: WHEEL_REST_MS - 1 })).toBe(false);
  });

  test("up or right is the next option; lines are scaled to pixels", () => {
    expect(wheelTravel({ deltaX: 0, deltaY: -100, deltaMode: 0 }, 600)).toBe(100);
    expect(wheelTravel({ deltaX: 30, deltaY: 4, deltaMode: 0 }, 600)).toBe(30);
    expect(wheelTravel({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 600)).toBe(-48);
    expect(wheelTravel({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 600)).toBe(-600);
  });

  test("one mouse notch is one step; a trackpad's small deltas gather into steps and a pause drops a partial one", () => {
    expect(turnWheel(WHEEL_AT_REST, 100, 0).step).toBe(1);
    expect(turnWheel(WHEEL_AT_REST, -100, 0).step).toBe(-1);
    let turn = WHEEL_AT_REST, steps = 0;
    for (let at = 0; at < 10; at++) {
      const result = turnWheel(turn, 8, at * 16);
      turn = result.turn;
      steps += result.step;
    }
    expect(steps).toBe(Math.floor(80 / WHEEL_STEP_PX));
    const partial = turnWheel(WHEEL_AT_REST, WHEEL_STEP_PX - 1, 0).turn;
    expect(turnWheel(partial, 2, WHEEL_IDLE_MS + 1).step).toBe(0);
    expect(turnWheel(partial, 2, WHEEL_IDLE_MS - 1).step).toBe(1);
    // Reversing direction starts over rather than cancelling travel already gathered.
    expect(turnWheel(partial, -2, 10).step).toBe(0);
  });
});
