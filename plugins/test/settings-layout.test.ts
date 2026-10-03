import { describe, expect, test } from "bun:test";
import {
  chooseLayout, CONCLUSION_LAYOUTS, conclusionNeeds, LAYOUT_HYSTERESIS_PX, linesAt, SETTINGS_LAYOUTS, settingsNeeds, STATUS_MIN, STATUS_UNDER_MIN,
  type SettingMeasure, type SettingsMeasure,
} from "../code/generator/settings-layout.ts";

const LABEL_GAP = 16, PAIR_GAP = 32, GAPS = { label: LABEL_GAP, pair: PAIR_GAP }, CONCLUSION_GAP = 16;

const setting = (label: number, values: readonly number[]): SettingMeasure => ({ label, values, gap: 16 });
/** Six settings with a long lane row, as the real lanes are; each test changes only what it is about. */
function measure(changes: Partial<SettingsMeasure> = {}): SettingsMeasure {
  return {
    lane: setting(30, [70, 60, 50, 80, 90]), tier: setting(30, [30, 50, 40, 40]), thinking: setting(56, [60, 30, 55, 35, 50, 35]),
    advisor: setting(50, [25, 50, 50, 40]), extras: setting(44, [50, 80, 70, 70, 60]), machine: setting(54, [120, 160]), ...changes,
  };
}

describe("which layout the settings take", () => {
  test("pairs need both halves on one line each; rows need every setting within two lines beside the labels; stacked always fits", () => {
    const [pairs, rows, stacked] = settingsNeeds(measure(), GAPS);
    // Left half: the widest left label and the widest left row (lane: 350 + 4 gaps); right half likewise (machine: 280 + 1 gap).
    expect(pairs).toBe(56 + LABEL_GAP + 414 + PAIR_GAP + 54 + LABEL_GAP + 296);
    expect(rows).toBeLessThan(pairs!);
    expect(stacked).toBe(0);
    const labels = 56 + LABEL_GAP;
    for (const entry of Object.values(measure())) expect(linesAt(entry, rows! - labels)).toBeLessThanOrEqual(2);
    expect(Object.values(measure()).some(entry => linesAt(entry, rows! - labels - 1) > 2)).toBe(true);
  });

  test("a value wider than the room takes a line alone, so one long machine name decides how wide rows must be", () => {
    expect(linesAt(setting(0, [300, 20, 20]), 100)).toBe(2);
    const [, rows] = settingsNeeds(measure({ machine: setting(54, [400]) }), GAPS);
    expect(rows).toBe(56 + LABEL_GAP + 400);
  });

  test("the widest layout that fits is taken, a wider one only with room to spare, and a narrower one as soon as the current one stops fitting", () => {
    const needs = settingsNeeds(measure(), GAPS);
    const [pairs, rows] = [needs[0]!, needs[1]!];
    expect(SETTINGS_LAYOUTS[chooseLayout(pairs, needs, null)]).toBe("pairs");
    expect(SETTINGS_LAYOUTS[chooseLayout(pairs - 1, needs, 0)]).toBe("rows");
    expect(SETTINGS_LAYOUTS[chooseLayout(pairs + LAYOUT_HYSTERESIS_PX - 1, needs, 1)]).toBe("rows");
    expect(SETTINGS_LAYOUTS[chooseLayout(pairs + LAYOUT_HYSTERESIS_PX, needs, 1)]).toBe("pairs");
    expect(SETTINGS_LAYOUTS[chooseLayout(rows - 1, needs, 1)]).toBe("stacked");
    expect(SETTINGS_LAYOUTS[chooseLayout(170, needs, null)]).toBe("stacked");
  });

  test("the status lines sit between the verb and the readouts only while they keep their least width, then beside the readouts alone, then above them", () => {
    const needs = conclusionNeeds(150, 160, CONCLUSION_GAP);
    expect(CONCLUSION_LAYOUTS[chooseLayout(150 + CONCLUSION_GAP + STATUS_MIN + CONCLUSION_GAP + 160, needs, null)]).toBe("beside");
    expect(CONCLUSION_LAYOUTS[chooseLayout(150 + CONCLUSION_GAP + STATUS_MIN + CONCLUSION_GAP + 159, needs, null)]).toBe("under");
    expect(CONCLUSION_LAYOUTS[chooseLayout(STATUS_UNDER_MIN + CONCLUSION_GAP + 160, needs, null)]).toBe("under");
    expect(CONCLUSION_LAYOUTS[chooseLayout(STATUS_UNDER_MIN + CONCLUSION_GAP + 159, needs, null)]).toBe("column");
  });
});
