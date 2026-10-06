import type { CompiledCatalog } from "../../domain/catalog.ts";
import type { Review } from "../../domain/routing.ts";
import { SPECS } from "./dial-space.ts";
import type { LaneMark, QuotaNote, Slot, SlotOption, StatementWord } from "./statement-model.ts";

/*
 * The generator's rows as data: one row per dial and per extra, then the machine, each a line of
 * plain option words in order, the chosen one marked. Drawn over the statement's slots, so every
 * value's availability, reason, consequence and quota note is the slot's own; this only decides
 * which words a row shows, what they read and how a chosen one is coloured. Pure, so the rules (the
 * model row's aliases per tier, which lanes hide, how a switch reads) are tested apart from the DOM.
 */

export type RowId = "lane" | "tier" | "thinking" | "advisor" | "spark" | "fallbacks" | "priority" | "prewalk" | "plans" | "budget" | "machine";
/** A lane spectrum, a level whose fill grows from the first word, an on/off switch, or the destination. */
export type RowKind = "lane" | "level" | "switch" | "machine";
/** How a chosen word is coloured: its provider's hue, Mixed's, the lane's accent, or the text colour (an off value, a machine). */
export type WordTone = { readonly kind: "family"; readonly family: string } | { readonly kind: "mixed" } | { readonly kind: "accent" } | { readonly kind: "plain" };

export type RowWord = {
  /** Stable within its row: a dial word, `on`/`off`, or a machine id. */
  readonly key: string;
  readonly text: string;
  /** The model row's tier word under its alias; null elsewhere. */
  readonly sub: string | null;
  /** The value as the readout and assistive technology name it ("sol, smart", "GPT-led", "spark on"). */
  readonly name: string;
  readonly selected: boolean;
  readonly available: boolean;
  /** Why it cannot be chosen; null when it can. */
  readonly reason: string | null;
  /** What choosing it does; for the chosen word, what it means as it stands (empty when its own word says it all). */
  readonly says: string;
  readonly quota: QuotaNote | null;
  /** Choosing it is the cause of a strained or stranded pool (`causalRedline`). */
  readonly strains: boolean;
  /** The slot option a press commits: the dial value, the extra to turn, or the machine; null for the chosen word and a refused one. */
  readonly option: SlotOption | null;
  readonly tone: WordTone;
  /** Chosen, the row's glider dims: an off value. */
  readonly quiet: boolean;
  /** The first lane of another provider's group, which starts its own line when the row wraps. */
  readonly gap: boolean;
  /** Machines only: online now; null for every other word and a destination the roster does not list. */
  readonly online: boolean | null;
};
export type GeneratorRow = { readonly id: RowId; readonly word: StatementWord; readonly label: string; readonly kind: RowKind; readonly words: readonly RowWord[] };

export type RowsInput = {
  readonly slots: Readonly<Record<StatementWord, Slot>>;
  readonly catalog: CompiledCatalog;
  /** The review the controls show, which names the lanes on offer (`controlsReview`). */
  readonly controls: Review;
  /** The review the routing shows, whose default role names the chosen tier's model. */
  readonly shown: Review;
  readonly aliases: ReadonlyMap<string, string>;
  /** Families with at least one signed-in account, included or not; null when the reading cannot say. */
  readonly connected: ReadonlySet<string> | null;
};

const NO_WORD = { sub: null, reason: null, quota: null, strains: false, option: null, gap: false, online: null } as const;

function laneFamilies(mark: LaneMark | null): readonly string[] {
  return mark === null ? [] : mark.kind === "mixed" ? ["openai", "anthropic"] : [mark.family];
}

/** A dial value as a word: chosen, refused with its reason, or what choosing it does. */
function dialWord(option: SlotOption, text: string, name: string, tone: WordTone, quiet: boolean): RowWord {
  return {
    ...NO_WORD, key: option.value, text, name, selected: option.current, available: option.available, reason: option.available ? null : option.reason,
    says: option.current ? option.meaning : option.note, quota: option.quota, strains: option.redline !== null,
    option: option.current || !option.available ? null : option, tone, quiet,
  };
}

/**
 * Lanes in their spectrum, then each other provider's group. A lane is hidden only while its
 * family has no signed-in account at all, unless it is the lane in use; a family whose accounts
 * are all excluded stays, refused with the domain's reason.
 */
function laneRow({ slots, controls, connected }: RowsInput): GeneratorRow {
  const group = new Map(SPECS.lane.words(controls).flatMap((words, index) => words.map(word => [word, index] as const)));
  const shown = slots.lane.options.filter(option => option.current || connected === null || laneFamilies(option.mark).every(family => connected.has(family)));
  const words = shown.map((option, index): RowWord => {
    const tone: WordTone = option.mark?.kind === "mixed" ? { kind: "mixed" } : option.mark ? { kind: "family", family: option.mark.family } : { kind: "accent" };
    const gap = index > 0 && group.get(option.value) !== group.get(shown[index - 1]!.value);
    return { ...dialWord(option, option.value, option.label, tone, false), gap };
  });
  return { id: "lane", word: "lane", label: "lane", kind: "lane", words };
}

/**
 * Each tier reads as the model its `default` role would lead on, from the review choosing it forms
 * (the chosen tier's from the routing's own review), with the tier's word under it. A tier no
 * model fills reads as its word alone, refused.
 */
function tierRow({ slots, catalog, shown, aliases }: RowsInput): GeneratorRow {
  const leadOf = (review: Review | null) => {
    const route = review?.routes.find(entry => entry.role === "default") ?? review?.routes[0];
    return route ? { alias: aliases.get(route.lead.key) ?? route.lead.key, family: catalog.family(route.lead.key) } : null;
  };
  const words = slots.tier.options.map(option => {
    const lead = leadOf(option.current ? shown : option.review);
    if (!lead) return dialWord(option, option.value, option.value, { kind: "accent" }, false);
    return { ...dialWord(option, lead.alias, `${lead.alias}, ${option.value}`, { kind: "family", family: lead.family }, false), sub: option.value };
  });
  return { id: "tier", word: "tier", label: "model", kind: "level", words };
}

function levelRow(slot: Slot, word: "thinking" | "advisor"): GeneratorRow {
  const words = slot.options.map(option => option.value === "off"
    ? dialWord(option, option.value, option.label, { kind: "plain" }, true)
    : dialWord(option, option.value, option.label, { kind: "accent" }, false));
  return { id: word, word, label: word, kind: "level", words };
}

/** An extra as its own row of two words, on then off; the chosen one says what it means, the other what turning it does. */
function switchRow(extra: SlotOption): GeneratorRow {
  const side = (on: boolean): RowWord => {
    const chosen = extra.on === on;
    return {
      ...NO_WORD, key: on ? "on" : "off", text: on ? "on" : "off", name: `${extra.label} ${on ? "on" : "off"}`, selected: chosen,
      available: chosen || extra.available, reason: chosen || extra.available ? null : extra.reason, says: chosen ? extra.meaning : extra.note,
      quota: chosen ? null : extra.quota, strains: !chosen && extra.redline !== null, option: chosen || !extra.available ? null : extra,
      tone: on ? { kind: "accent" } : { kind: "plain" }, quiet: !on,
    };
  };
  return { id: extra.value as RowId, word: "extras", label: extra.label, kind: "switch", words: [side(true), side(false)] };
}

function machineRow(slot: Slot): GeneratorRow {
  const words = slot.options.map((option): RowWord => ({
    ...NO_WORD, key: option.value, text: option.label, name: option.label, selected: option.current, available: option.available,
    reason: option.available ? null : option.reason, says: option.current ? option.meaning : option.note,
    option: option.current || !option.available ? null : option, tone: { kind: "plain" }, quiet: false, online: option.online,
  }));
  return { id: "machine", word: "machine", label: "machine", kind: "machine", words };
}

/** Every row, top to bottom: lane, model, thinking, advisor, each extra, then the machine. */
export function generatorRows(input: RowsInput): GeneratorRow[] {
  const { slots } = input;
  return [laneRow(input), tierRow(input), levelRow(slots.thinking, "thinking"), levelRow(slots.advisor, "advisor"),
    ...slots.extras.options.map(switchRow), machineRow(slots.machine)];
}

/** The nearest word that can be chosen one step right (`forward`) or left of the chosen one; null at the end of the row. */
export function stepWord(row: GeneratorRow, forward: boolean): RowWord | null {
  const at = row.words.findIndex(word => word.selected);
  const direction = forward ? 1 : -1;
  for (let index = at + direction; at >= 0 && index >= 0 && index < row.words.length; index += direction) {
    if (row.words[index]!.available) return row.words[index]!;
  }
  return null;
}

/** The leftmost word (or with `last`, the rightmost) that can be chosen, unless it is already chosen. */
export function edgeWord(row: GeneratorRow, last: boolean): RowWord | null {
  const available = row.words.filter(word => word.available);
  const edge = last ? available.at(-1) : available[0];
  return edge && !edge.selected ? edge : null;
}
