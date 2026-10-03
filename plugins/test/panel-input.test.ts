import { describe, expect, test } from "bun:test";
import {
  panelShortcut, panelWheel, wheelScrolled, wheelTravel, WHEEL_IDLE_MS, WHEEL_REST_MS, WHEEL_STEP_PX, WHEEL_STILL, type PanelKey, type WheelInput, type WheelRest,
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

describe("the wheel in the panel", () => {
  /** Feeds wheel events through one panel-wide rest tracker, as the panel root's listener does. */
  function wheel(events: readonly (Partial<WheelInput> & { nowMs: number })[], start: WheelRest = WHEEL_STILL) {
    let rest = start;
    return events.map(event => {
      const result = panelWheel(rest, { focusedControl: true, zoom: false, travel: 100, ...event });
      rest = result.rest;
      return result;
    });
  }

  test("turns a focused control only once the whole panel has rested from scrolling", () => {
    expect(wheel([{ nowMs: 1_000 }])[0]).toMatchObject({ take: true, step: 1 });
    expect(wheel([{ nowMs: 1_000, focusedControl: false }])[0]).toMatchObject({ take: false, step: 0 });
    expect(wheel([{ nowMs: 1_000, zoom: true }])[0]).toMatchObject({ take: false, step: 0 });
    const scrolled = wheelScrolled(WHEEL_STILL, 1_000);
    expect(wheel([{ nowMs: 1_000 + WHEEL_REST_MS - 1 }], scrolled)[0]?.take).toBe(false);
    expect(wheel([{ nowMs: 1_000 + WHEEL_REST_MS }], scrolled)[0]).toMatchObject({ take: true, step: 1 });
  });

  test("a gesture that begins outside the dials and drifts onto a focused dial keeps scrolling, even where nothing scrolls", () => {
    // At a scroll boundary no scroll event fires: only the wheel events themselves, first over the
    // masthead or the routing table, then over the focused dial, sixteen milliseconds apart.
    const outside = Array.from({ length: 4 }, (_, index) => ({ nowMs: 1_000 + index * 16, focusedControl: false }));
    const onDial = Array.from({ length: 30 }, (_, index) => ({ nowMs: 1_064 + index * 16 }));
    const results = wheel([...outside, ...onDial]);
    expect(results.every(result => !result.take && result.step === 0)).toBe(true);
    // Once the gesture has stopped for the rest period, the same dial turns.
    const last = onDial.at(-1)!.nowMs;
    expect(wheel([...outside, ...onDial, { nowMs: last + WHEEL_REST_MS }]).at(-1)).toMatchObject({ take: true, step: 1 });
  });

  test("up or right is the next option; lines are scaled to pixels", () => {
    expect(wheelTravel({ deltaX: 0, deltaY: -100, deltaMode: 0 }, 600)).toBe(100);
    expect(wheelTravel({ deltaX: 30, deltaY: 4, deltaMode: 0 }, 600)).toBe(30);
    expect(wheelTravel({ deltaX: 0, deltaY: 3, deltaMode: 1 }, 600)).toBe(-48);
    expect(wheelTravel({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 600)).toBe(-600);
  });

  test("one mouse notch is one step; a trackpad's small deltas gather into steps and a pause drops a partial one", () => {
    expect(wheel([{ nowMs: 1_000, travel: -100 }])[0]?.step).toBe(-1);
    const trackpad = wheel(Array.from({ length: 10 }, (_, index) => ({ nowMs: 1_000 + index * 16, travel: 8 })));
    expect(trackpad.every(result => result.take)).toBe(true);
    expect(trackpad.reduce((steps, result) => steps + result.step, 0)).toBe(Math.floor(80 / WHEEL_STEP_PX));
    const partial = wheel([{ nowMs: 1_000, travel: WHEEL_STEP_PX - 1 }]);
    const after = (nowMs: number, travel: number) => panelWheel(partial[0]!.rest, { focusedControl: true, zoom: false, travel, nowMs }).step;
    expect(after(1_000 + WHEEL_IDLE_MS + 1, 2)).toBe(0);
    expect(after(1_000 + WHEEL_IDLE_MS - 1, 2)).toBe(1);
    // Reversing direction starts over rather than cancelling travel already gathered.
    expect(after(1_010, -2)).toBe(0);
  });
});
