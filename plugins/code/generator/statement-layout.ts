import type { StatementWord } from "./statement-model.ts";

/*
 * The statement's width forms, chosen by measurement. Every column of every form is one value grid:
 * a connector track ("thinking", "advisor", "on", right-aligned, or the lane mark's gutter) and a
 * value track, both as wide as the widest in that column across its rows, so every value, ghost and
 * drum option of a column starts on one edge. A value track holds its longest value (and, in the
 * ghosted row, its longest ghost with its redline glyph), so a value change never moves a neighbour;
 * a rare long ghost that also carries the `last` tag ellipsizes its text. A form fits when its
 * columns and the verb fit the panel; the widest form that fits is taken, and a wider one only once
 * it fits with room to spare, so a width that hovers at a threshold (a scrollbar appearing, a panel
 * being dragged) never flips the line back and forth. Font sizes come from the type scale, never
 * from a viewport threshold, and only ever step down as the room narrows.
 */

export type StatementForm = "line" | "rows" | "stack" | "list";
/** The line's type size: 20px with 15px ghosts, or a step down, 15px with 13px ghosts. */
export type LineSize = 20 | 15;
export type FormChoice = { readonly form: StatementForm; readonly size: LineSize };
/**
 * Tried in order, widest first: the whole statement on one line; two rows on one grid with the verb
 * before the first; the verb on its own row above aligned pairs of word cells; one word per row.
 * The size never grows on the way down, so narrowing the panel never makes the line larger.
 */
export const FORM_CHOICES: readonly FormChoice[] = [
  { form: "line", size: 20 }, { form: "rows", size: 20 }, { form: "rows", size: 15 },
  { form: "stack", size: 15 }, { form: "list", size: 15 },
];
export const FORM_ROWS: Readonly<Record<StatementForm, readonly (readonly StatementWord[])[]>> = {
  line: [["lane", "tier", "thinking", "advisor", "extras", "machine"]],
  rows: [["lane", "tier", "thinking"], ["advisor", "extras", "machine"]],
  stack: [["lane", "tier"], ["thinking", "advisor"], ["extras", "machine"]],
  list: [["lane"], ["tier"], ["thinking"], ["advisor"], ["extras"], ["machine"]],
};
/** Forms whose verb sits before the first row of words; the others put it on a row of its own. */
export const VERB_INLINE: Readonly<Record<StatementForm, boolean>> = { line: true, rows: true, stack: false, list: false };
const GHOST_SIZE: Readonly<Record<LineSize, number>> = { 20: 15, 15: 13 };
/** The verb's type size in every form. */
const VERB_SIZE = 15;
/** Space between word cells, and between the verb and the first word: the 4px base, four times. */
export const CELL_GAP = 16;
/** Space between a connector and its value, on the 4px base: two steps at 20px, one at 15px. */
export const CONNECTOR_GAP: Readonly<Record<LineSize, number>> = { 20: 8, 15: 4 };
/** The lane mark's box and its gap to the lane text, in px at every size (styles.css `--stmt-mark`, `--stmt-mark-gap`). */
export const MARK_PX = 18;
export const MARK_GAP = 8;
/** The room after the widest value of a column, before the next column's gap. */
const VALUE_ROOM = 12;
/** How much room a wider form needs beyond its own width before the line grows back into it. */
export const FORM_HYSTERESIS_PX = 24;
/** A long machine name is cut at this many ems on the line; the drum and the status line say it whole. */
export const MACHINE_EM = 8;

/** Text width in px at a size and weight, in the panel's own font (a canvas in the view; anything deterministic in tests). */
export type TextMeasure = (text: string, size: number, weight: number) => number;
/** What a word cell must hold: its connector, every value it can show, and whether it wears a lane mark. */
export type SlotText = { readonly connector: string | null; readonly labels: readonly string[]; readonly marked: boolean };

/** The words that show ±1 ghosts at rest: those of the first row, among lane, tier and thinking; none when one word sits per row. */
export function ghostedWords(form: StatementForm): readonly StatementWord[] {
  if (form === "list") return [];
  return FORM_ROWS[form][0]!.filter(word => word === "lane" || word === "tier" || word === "thinking");
}

/**
 * One word cell at a line size: its connector track (the connector and its gap, or the lane mark's
 * gutter) and its value track (the widest value or ghost, and the room after it).
 */
export function cellWidths(word: StatementWord, text: SlotText, size: LineSize, ghosted: boolean, measure: TextMeasure): Column {
  const connector = Math.max(text.connector ? measure(text.connector, size, 400) + CONNECTOR_GAP[size] : 0, text.marked ? MARK_PX + MARK_GAP : 0);
  let value = Math.max(0, ...text.labels.map(label => measure(label, size, 650)));
  if (word === "machine") value = Math.min(value, MACHINE_EM * size);
  if (ghosted) {
    // A ghost carries its value and the 6px redline glyph after a small gap. The `last` tag is not
    // reserved: on the rare ghost that is both the longest value and the last launch's, its text yields.
    value = Math.max(value, Math.max(0, ...text.labels.map(label => measure(label, GHOST_SIZE[size], 450))) + 10);
  }
  return { connector: Math.ceil(connector), value: Math.ceil(value + VALUE_ROOM) };
}

/** A column of the value grid: its connector track and its value track, in px. */
export type Column = { readonly connector: number; readonly value: number };
export type FormMeasure = { readonly columns: readonly Column[]; readonly verb: number; readonly need: number };

/** The grid a form needs: each column's tracks as wide as the widest in any of its rows, the verb as wide as its widest label. */
export function measureForm(choice: FormChoice, texts: Readonly<Record<StatementWord, SlotText>>, verbLabels: readonly string[], measure: TextMeasure): FormMeasure {
  const rows = FORM_ROWS[choice.form];
  const ghosted = ghostedWords(choice.form);
  const verb = Math.ceil(Math.max(...verbLabels.map(label => measure(label, VERB_SIZE, 650))) + 24);
  const columns = rows[0]!.map((_, index) => {
    const cells = rows.flatMap(row => row[index] ? [cellWidths(row[index]!, texts[row[index]!], choice.size, ghosted.includes(row[index]!), measure)] : []);
    return { connector: Math.max(...cells.map(cell => cell.connector)), value: Math.max(...cells.map(cell => cell.value)) };
  });
  const words = columns.reduce((sum, column) => sum + column.connector + column.value, 0) + CELL_GAP * (columns.length - 1);
  if (choice.form === "list") return { columns, verb, need: 0 };
  return { columns, verb, need: VERB_INLINE[choice.form] ? verb + CELL_GAP + words : Math.max(verb, words) };
}

/**
 * The form to use at `available` px. The first that fits is taken when the previous one no longer
 * fits; while the previous one fits it is kept, unless a wider one fits with `margin` to spare. The
 * last form always fits (`need` 0), so there is always an answer.
 */
export function chooseForm(available: number, needs: readonly number[], previous: number | null, margin = FORM_HYSTERESIS_PX): number {
  const first = needs.findIndex(need => need <= available);
  const fallback = first < 0 ? needs.length - 1 : first;
  if (previous === null || previous >= needs.length || needs[previous]! > available) return fallback;
  const wider = needs.findIndex((need, index) => index < previous && need + margin <= available);
  return wider >= 0 ? wider : previous;
}

/**
 * How far to slide an open drum so it stays inside `bounds`: left only as far as the right edge
 * needs, never past the left bound (which in the inline forms is the verb's right edge, so the drum
 * never covers the verb), and pinned to the left bound when it is wider than the room.
 */
export function drumShift(drum: { readonly left: number; readonly right: number }, bounds: { readonly left: number; readonly right: number }): number {
  if (drum.right - drum.left >= bounds.right - bounds.left) return bounds.left - drum.left;
  if (drum.right > bounds.right) return bounds.right - drum.right;
  if (drum.left < bounds.left) return bounds.left - drum.left;
  return 0;
}
