import type { StatementWord } from "./statement-model.ts";

/*
 * The statement's width forms, chosen by measurement. Every word's cell is as wide as its longest
 * value (and, in the ghosted row, its longest ghost with its redline glyph), so a value change
 * never moves a neighbour; a rare long ghost that also carries the `last` tag ellipsizes its text.
 * A form fits when its cells and the verb fit the panel; the
 * widest form that fits is taken, and a wider one only once it fits with room to spare, so a width
 * that hovers at a threshold (a scrollbar appearing, a panel being dragged) never flips the line
 * back and forth. Font sizes come from the type scale, never from a viewport threshold.
 */

export type StatementForm = "line" | "rows" | "stack" | "list";
/** The line's type size: 20px with 15px ghosts, or a step down, 15px with 13px ghosts. */
export type LineSize = 20 | 15;
export type FormChoice = { readonly form: StatementForm; readonly size: LineSize };
/**
 * Tried in order, widest first: the whole statement on one line; two rows on one grid with the verb
 * before the first; the verb on its own row above aligned pairs of word cells; one word per row.
 */
export const FORM_CHOICES: readonly FormChoice[] = [
  { form: "line", size: 20 }, { form: "rows", size: 20 }, { form: "rows", size: 15 },
  { form: "stack", size: 20 }, { form: "stack", size: 15 }, { form: "list", size: 15 },
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

/** One word cell's width at a line size: connector, the widest value or ghost, the room after it. */
export function slotWidth(word: StatementWord, text: SlotText, size: LineSize, ghosted: boolean, measure: TextMeasure): number {
  const connector = text.connector ? measure(text.connector, size, 400) + 0.3 * size : 0;
  // A lane mark is 0.9em wide (statement.css `stmt-lane-mark`) and sits 0.3em before its value.
  const mark = text.marked ? 1.2 * size : 0;
  let value = Math.max(0, ...text.labels.map(label => measure(label, size, 650)));
  if (word === "machine") value = Math.min(value, MACHINE_EM * size);
  let inner = value + mark;
  if (ghosted) {
    const ghost = GHOST_SIZE[size];
    // A ghost carries its value and the 6px redline glyph after a small gap. The `last` tag is not
    // reserved: on the rare ghost that is both the longest value and the last launch's, its text yields.
    inner = Math.max(inner, Math.max(0, ...text.labels.map(label => measure(label, ghost, 450))) + (text.marked ? 1.2 * ghost : 0) + 10);
  }
  return Math.ceil(connector + inner + 12);
}

export type FormMeasure = { readonly columns: readonly number[]; readonly verb: number; readonly need: number };

/** The grid a form needs: each column as wide as its widest cell, the verb as wide as its widest label. */
export function measureForm(choice: FormChoice, texts: Readonly<Record<StatementWord, SlotText>>, verbLabels: readonly string[], measure: TextMeasure): FormMeasure {
  const rows = FORM_ROWS[choice.form];
  const ghosted = ghostedWords(choice.form);
  const verb = Math.ceil(Math.max(...verbLabels.map(label => measure(label, VERB_SIZE, 650))) + 24);
  const columns = rows[0]!.map((_, index) => Math.max(...rows.map(row => {
    const word = row[index];
    return word ? slotWidth(word, texts[word], choice.size, ghosted.includes(word), measure) : 0;
  })));
  const words = columns.reduce((sum, width) => sum + width, 0) + CELL_GAP * (columns.length - 1);
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
