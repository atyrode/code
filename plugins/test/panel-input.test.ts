import { describe, expect, test } from "bun:test";
import {
  panelWheel, wheelScrolled, wheelTravel, WHEEL_IDLE_MS, WHEEL_REST_MS, WHEEL_STEP_PX, WHEEL_STILL, type WheelInput, type WheelRest,
} from "../code/generator/panel-input.ts";

describe("the wheel in the panel", () => {
  /** A keyboard-focused control the pointer has rested on: the one state, besides an open drum, that turns. */
  const engaged = { open: false, keyboardFocused: true, restedMs: WHEEL_REST_MS, zoom: false, travel: 100 };
  /** Feeds wheel events through one panel-wide rest tracker, as the panel root's listener does. */
  function wheel(events: readonly (Partial<WheelInput> & { nowMs: number })[], start: WheelRest = WHEEL_STILL) {
    let rest = start;
    return events.map(event => {
      const result = panelWheel(rest, { ...engaged, ...event });
      rest = result.rest;
      return result;
    });
  }

  test("a word just clicked keeps focus, but the wheel over it scrolls, from its first notch on", () => {
    // Click focus is not keyboard focus, however long the pointer stays.
    const clicked = Array.from({ length: 4 }, (_, index) => ({ nowMs: 5_000 + index * 120, keyboardFocused: false, restedMs: 5_000 }));
    expect(wheel(clicked).every(result => !result.take && result.step === 0)).toBe(true);
    // The same word focused by the keyboard turns once the pointer has rested on it, and not before.
    expect(wheel([{ nowMs: 5_000, restedMs: WHEEL_REST_MS - 1 }])[0]).toMatchObject({ take: false, step: 0 });
    expect(wheel([{ nowMs: 5_000 }])[0]).toMatchObject({ take: true, step: 1 });
  });

  test("an open drum turns without a rest or keyboard focus, but never while the panel scrolls", () => {
    expect(wheel([{ nowMs: 5_000, open: true, keyboardFocused: false, restedMs: 0 }])[0]).toMatchObject({ take: true, step: 1 });
    const scrolled = wheelScrolled(WHEEL_STILL, 5_000);
    expect(wheel([{ nowMs: 5_000 + WHEEL_REST_MS - 1, open: true }], scrolled)[0]?.take).toBe(false);
    expect(wheel([{ nowMs: 5_000 + WHEEL_REST_MS, open: true }], scrolled)[0]).toMatchObject({ take: true, step: 1 });
    expect(wheel([{ nowMs: 5_000, zoom: true, open: true }])[0]).toMatchObject({ take: false, step: 0 });
    expect(wheel([{ nowMs: 5_000, open: false, keyboardFocused: false }])[0]).toMatchObject({ take: false, step: 0 });
  });

  test("a gesture that begins outside the dials and drifts onto an engaged dial keeps scrolling, even where nothing scrolls", () => {
    // At a scroll boundary no scroll event fires: only the wheel events themselves, first over the
    // masthead or the routing table, then over the dial, sixteen milliseconds apart.
    const outside = Array.from({ length: 4 }, (_, index) => ({ nowMs: 1_000 + index * 16, keyboardFocused: false, restedMs: 0 }));
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
    const after = (nowMs: number, travel: number) => panelWheel(partial[0]!.rest, { ...engaged, travel, nowMs }).step;
    expect(after(1_000 + WHEEL_IDLE_MS + 1, 2)).toBe(0);
    expect(after(1_000 + WHEEL_IDLE_MS - 1, 2)).toBe(1);
    // Reversing direction starts over rather than cancelling travel already gathered.
    expect(after(1_010, -2)).toBe(0);
  });
});
