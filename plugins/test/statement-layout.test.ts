import { describe, expect, test } from "bun:test";
import {
  CELL_GAP, chooseForm, drumShift, FORM_CHOICES, FORM_HYSTERESIS_PX, MACHINE_EM, measureForm, slotWidth, type SlotText, type TextMeasure,
} from "../code/generator/statement-layout.ts";
import type { StatementWord } from "../code/generator/statement-model.ts";

/** A monospace stand-in: every character is half the size wide, at any weight. */
const measure: TextMeasure = (text, size) => text.length * size / 2;
const plain = (labels: readonly string[], connector: string | null = null): SlotText => ({ connector, labels, marked: false });
const texts: Record<StatementWord, SlotText> = {
  lane: { connector: null, labels: ["GPT only", "Mixed"], marked: true }, tier: plain(["elite", "fast"]), thinking: plain(["minimal", "max"], "thinking"),
  advisor: plain(["off", "review"], "advisor"), extras: plain(["no extras", "fallbacks"]), machine: plain(["Studio"], "on"),
};

describe("the statement's form follows the room it has", () => {
  const needs = [900, 640, 520, 400, 300, 0];

  test("the widest form that fits is taken, and one word per row always fits", () => {
    expect(chooseForm(1000, needs, null)).toBe(0);
    expect(chooseForm(600, needs, null)).toBe(2);
    expect(chooseForm(120, needs, null)).toBe(5);
  });

  test("a width hovering at a threshold keeps the form it has until the wider one fits with room to spare", () => {
    expect(chooseForm(650, needs, 2)).toBe(2);
    expect(chooseForm(640 + FORM_HYSTERESIS_PX, needs, 2)).toBe(1);
    // A form that no longer fits gives way at once, without the margin.
    expect(chooseForm(630, needs, 1)).toBe(2);
  });

  test("each column is as wide as its widest cell in any row, and the inline verb adds its own cell", () => {
    const rows = measureForm({ form: "rows", size: 20 }, texts, ["Launch anyway"], measure);
    // Row two's advisor cell is wider than row one's lane cell, so the first column takes it.
    expect(rows.columns[0]).toBe(slotWidth("advisor", texts.advisor, 20, false, measure));
    const verb = Math.ceil("Launch anyway".length * 15 / 2 + 24);
    expect(rows.need).toBe(verb + CELL_GAP + rows.columns.reduce((sum, width) => sum + width, 0) + CELL_GAP * 2);
    const stack = measureForm({ form: "stack", size: 15 }, texts, ["Launch anyway"], measure);
    expect(stack.need).toBe(Math.max(verb, stack.columns[0]! + stack.columns[1]! + CELL_GAP));
    expect(measureForm(FORM_CHOICES.at(-1)!, texts, ["Launch"], measure).need).toBe(0);
  });

  test("a long machine name is cut at its em cap rather than widening the line", () => {
    const long = plain(["A machine with a very long name indeed"], "on");
    expect(slotWidth("machine", long, 20, false, measure)).toBe(Math.ceil(measure("on", 20, 400) + 6 + MACHINE_EM * 20 + 12));
  });
});

describe("an open drum stays inside the panel and off the verb", () => {
  const bounds = { left: 160, right: 600 };

  test("a drum that fits stays under its word", () => {
    expect(drumShift({ left: 200, right: 400 }, bounds)).toBe(0);
  });

  test("a drum past the right edge slides left only as far as it needs; one that starts over the verb moves right of it", () => {
    expect(drumShift({ left: 500, right: 700 }, bounds)).toBe(-100);
    expect(drumShift({ left: 100, right: 300 }, bounds)).toBe(60);
  });

  test("a drum wider than the room is pinned to the left bound", () => {
    expect(drumShift({ left: 300, right: 900 }, bounds)).toBe(-140);
  });
});
