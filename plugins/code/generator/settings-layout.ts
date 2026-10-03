import type { StatementWord } from "./statement-model.ts";

/*
 * The settings' layouts, chosen by measured fit and never by a breakpoint. The panel measures each
 * setting in its own font (its label, and each of its values as drawn, current or not, since every
 * value keeps room for its heavier current form), and these rules decide what fits:
 *
 *  - `pairs`: two settings per line on one shared grid (lane | tier, thinking | advisor, extras |
 *    machine), every value on one line, so each half's values start on one edge;
 *  - `rows`: one setting per line, the labels in one column and each setting's values beside its
 *    label, wrapping within the value column into at most two lines;
 *  - `stacked`: each label above its values, which wrap across the whole width.
 *
 * The widest layout that fits is taken, and a wider one only once it fits with room to spare, so a
 * width that hovers at a threshold (a scrollbar appearing, a panel being dragged) never flips the
 * settings back and forth. The verb, the status lines and the estimates under the settings follow
 * the same rule with their own layouts.
 */

export type SettingsLayout = "pairs" | "rows" | "stacked";
export const SETTINGS_LAYOUTS: readonly SettingsLayout[] = ["pairs", "rows", "stacked"];
/** The pairs layout's lines, each a left and a right setting, in reading order. */
export const PAIRS: readonly (readonly [StatementWord, StatementWord])[] = [["lane", "tier"], ["thinking", "advisor"], ["extras", "machine"]];
/** The gaps the settings' grid draws, read from the page: label to values, and the left half's values to the right half's label in pairs. */
export type SettingsGaps = { readonly label: number; readonly pair: number };
/** The most lines a setting's values may take beside its label before labels go above their values. */
export const ROWS_MAX_LINES = 2;
/** How much room a wider layout needs beyond its own width before the settings grow back into it. */
export const LAYOUT_HYSTERESIS_PX = 24;

/** One setting as drawn: its label's width, each value's width, and the gap between values, in px. */
export type SettingMeasure = { readonly label: number; readonly values: readonly number[]; readonly gap: number };
export type SettingsMeasure = Readonly<Record<StatementWord, SettingMeasure>>;

/** The width of a setting's values on one line. */
export function oneLine(setting: SettingMeasure): number {
  return setting.values.reduce((sum, value) => sum + value, 0) + setting.gap * Math.max(0, setting.values.length - 1);
}

/** How many lines `values` take wrapped into `width`, greedily as flex wrapping does; a value wider than the width takes a line alone. */
export function linesAt(setting: SettingMeasure, width: number): number {
  let lines = 0, used = 0;
  for (const value of setting.values) {
    if (lines === 0 || used + setting.gap + value > width) { lines++; used = value; }
    else used += setting.gap + value;
  }
  return lines;
}

/** The narrowest width at which `setting`'s values take at most `lines` lines, never narrower than its widest value. */
function widthFor(setting: SettingMeasure, lines: number): number {
  let low = Math.max(0, ...setting.values), high = Math.max(low, oneLine(setting));
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (linesAt(setting, middle) <= lines) high = middle;
    else low = middle + 1;
  }
  return Math.ceil(high);
}

/**
 * The width each layout needs, widest layout first: pairs needs both halves' labels and values on
 * one line; rows needs the label column and a value column in which no setting takes more than
 * `ROWS_MAX_LINES` lines; stacked always fits.
 */
export function settingsNeeds(measure: SettingsMeasure, gaps: SettingsGaps): readonly number[] {
  const words = Object.keys(measure) as StatementWord[];
  const label = (list: readonly StatementWord[]) => Math.max(0, ...list.map(word => measure[word].label));
  const half = (side: 0 | 1) => {
    const list = PAIRS.map(pair => pair[side]);
    return label(list) + gaps.label + Math.max(0, ...list.map(word => oneLine(measure[word])));
  };
  const pairs = half(0) + gaps.pair + half(1);
  const rows = label(words) + gaps.label + Math.max(0, ...words.map(word => widthFor(measure[word], ROWS_MAX_LINES)));
  return [Math.ceil(pairs), Math.ceil(rows), 0];
}

/**
 * The conclusion's layouts: the verb, the status lines and the estimates side by side; the verb on
 * its own line above the status lines with the estimates beside them; or each on its own line.
 */
export type ConclusionLayout = "beside" | "under" | "column";
export const CONCLUSION_LAYOUTS: readonly ConclusionLayout[] = ["beside", "under", "column"];
/** The narrowest the status lines may be between the verb and the estimates. */
export const STATUS_MIN = 420;
/** The narrowest the status lines may be beside the estimates alone, under the verb; narrower, the estimates go below them. */
export const STATUS_UNDER_MIN = 280;

/** The width each conclusion layout needs, widest first, from the verb's and the estimates' widths and the gap the conclusion draws between them. */
export function conclusionNeeds(verb: number, estimates: number, gap: number): readonly number[] {
  return [Math.ceil(verb + gap + STATUS_MIN + gap + estimates), Math.ceil(Math.max(verb, STATUS_UNDER_MIN + gap + estimates)), 0];
}

/**
 * The layout to use at `available` px, given each layout's need, widest first. The first that fits
 * is taken when the previous one no longer fits; while the previous one fits it is kept, unless a
 * wider one fits with `margin` to spare. The last layout always fits (need 0), so there is always
 * an answer.
 */
export function chooseLayout(available: number, needs: readonly number[], previous: number | null, margin = LAYOUT_HYSTERESIS_PX): number {
  const first = needs.findIndex(need => need <= available);
  const fallback = first < 0 ? needs.length - 1 : first;
  if (previous === null || previous >= needs.length || needs[previous]! > available) return fallback;
  const wider = needs.findIndex((need, index) => index < previous && need + margin <= available);
  return wider >= 0 ? wider : previous;
}
