import type { CompiledCatalog } from "../../domain/catalog.ts";
import type { Lane } from "../../domain/contracts.ts";
import { familyPolicy } from "../../domain/providers.ts";
import type { Review } from "../../domain/routing.ts";
import { laneGroups, laneWord } from "./dial-space.ts";
import { laneLabel, type LaneMark, type QuotaNote, type Slot, type SlotOption, type StatementWord } from "./statement-model.ts";

/*
 * The generator's rows as data: one row per dial and per extra, each a line of plain option words
 * in order, the chosen one marked. Drawn over the statement's slots, so every
 * value's availability, reason, consequence and quota note is the slot's own; this only decides
 * which words a row shows, what they read and how a chosen one is coloured. Pure, so the rules (the
 * model row's aliases per tier, which lanes hide, how a switch reads) are tested apart from the DOM.
 */

export type RowId = "lane" | "tier" | "thinking" | "advisor" | "fallbacks";
/** Who leads (the lane row, with its `only` box), a level whose fill grows from the first word, or an on/off switch. */
export type RowKind = "lead" | "level" | "switch";
/** How a chosen word is coloured: its provider's hue, Mixed's, the lane's accent, or the text colour (an off value). */
export type WordTone = { readonly kind: "family"; readonly family: string } | { readonly kind: "mixed" } | { readonly kind: "accent" } | { readonly kind: "plain" };

export type RowWord = {
  /** Stable within its row: a dial word, or `on`/`off`. */
  readonly key: string;
  readonly text: string;
  /** The model row's tier word under its alias; null elsewhere. */
  readonly sub: string | null;
  /** The value as the readout and assistive technology name it ("sol, smart", "GPT-led", "fallbacks on"). */
  readonly name: string;
  readonly selected: boolean;
  readonly available: boolean;
  /** Why it cannot be chosen; null when it can. */
  readonly reason: string | null;
  /** What choosing it does; for the chosen word, what it means as it stands (empty when its own word says it all). */
  readonly says: string;
  readonly quota: QuotaNote | null;
  /** The slot option a press commits: the dial value, or the extra to turn; null for the chosen word and a refused one. */
  readonly option: SlotOption | null;
  readonly tone: WordTone;
  /** Chosen, the row's glider dims: an off value. */
  readonly quiet: boolean;
  /** Refused because the model list has no model of a family someone has signed in for: verifying models is what finds them. */
  readonly verifies: boolean;
};
/**
 * The lead row's `only` box: whether the lane keeps every role on its lead, and the word a press
 * commits, its lead's other variant. `enabled` is false where there is no other variant (Mixed, or a
 * lead the catalog forms one way only); the word then carries why. Enabled with a variant that cannot
 * run, it is struck and the word carries the variant's reason.
 */
export type OnlyBox = { readonly checked: boolean; readonly enabled: boolean; readonly struck: boolean; readonly word: RowWord };
export type GeneratorRow = {
  readonly id: RowId; readonly word: Exclude<StatementWord, "machine">; readonly label: string; readonly kind: RowKind; readonly words: readonly RowWord[];
  /** The lead row's `only` box; null on every other row. */
  readonly only: OnlyBox | null;
};

export type RowsInput = {
  readonly slots: Readonly<Record<StatementWord, Slot>>;
  readonly catalog: CompiledCatalog;
  /** The review the routing shows, whose default role names the chosen tier's model. */
  readonly shown: Review;
  readonly aliases: ReadonlyMap<string, string>;
  /** Families with at least one signed-in account, included or not; null when the reading cannot say. */
  readonly connected: ReadonlySet<string> | null;
  /** How the panel names a family (`Claude`). */
  readonly familyWord: (family: string) => string;
};

const NO_WORD = { sub: null, reason: null, quota: null, option: null, verifies: false } as const;

function laneFamilies(mark: LaneMark | null): readonly string[] {
  return mark === null ? [] : mark.kind === "mixed" ? ["openai", "anthropic"] : [mark.family];
}

/** A dial value as a word: chosen, refused with its reason, or what choosing it does. */
function dialWord(option: SlotOption, text: string, name: string, tone: WordTone, quiet: boolean): RowWord {
  return {
    ...NO_WORD, key: option.value, text, name, selected: option.current, available: option.available, reason: option.available ? null : option.reason,
    says: option.current ? option.meaning : option.note, quota: option.quota,
    option: option.current || !option.available ? null : option, tone, quiet,
  };
}

/** Every lane a set of families could form: each family alone and led, and Mixed over GPT and Claude. */
function lanesOf(families: readonly string[]): Lane[] {
  const lanes: Lane[] = families.flatMap(family => [{ kind: "provider", family, blend: "only" } as const,
    ...familyPolicy(family).crossTo !== null ? [{ kind: "provider", family, blend: "led" } as const] : []]);
  return families.includes("openai") && families.includes("anthropic") ? [...lanes, { kind: "mixed" }] : lanes;
}
/** The families a lane leads on: both of Mixed's, a led lane's own and the one it crosses to. */
const familiesOf = (lane: Lane): string[] => lane.kind === "mixed" ? ["openai", "anthropic"]
  : lane.blend === "led" ? [lane.family, ...familyPolicy(lane.family).crossTo !== null ? [familyPolicy(lane.family).crossTo!] : []] : [lane.family];

/** A lane as the lead row reads it: who leads (`mixed`, or a family) and whether that family runs every role. Mixed reads as led, so a lead change from it lands on a led lane. */
export function splitLane(lane: Lane): { readonly lead: string; readonly only: boolean } {
  return lane.kind === "mixed" ? { lead: "mixed", only: false } : { lead: lane.family, only: lane.blend === "only" };
}

/**
 * Every lane the row can offer, as a word: its slot option, or, for a family someone has signed in
 * for that the model list lacks, a word struck with that reason, one verification away. A lane is
 * hidden only while its family has no signed-in account at all, unless its lead is the one in use:
 * that lead keeps both its lanes, so its box still says why the other cannot run. A family whose
 * accounts are all excluded stays, refused with the domain's reason.
 */
function laneWords({ slots, catalog, connected, familyWord }: RowsInput): { readonly lane: Lane; readonly word: RowWord }[] {
  const listed = new Set(catalog.families);
  const missing = connected === null ? [] : [...connected].filter(family => !listed.has(family));
  const lanes = laneGroups(lanesOf([...catalog.families, ...missing])).flat();
  const inUse = lanes.find(lane => slots.lane.options.some(option => option.current && option.value === laneWord(lane)));
  const leadInUse = inUse ? splitLane(inUse).lead : null;
  return lanes.flatMap(lane => {
    const option = slots.lane.options.find(candidate => candidate.value === laneWord(lane));
    const mark: LaneMark = lane.kind === "mixed" ? { kind: "mixed" } : { kind: "provider", family: lane.family, cross: null };
    const tone: WordTone = lane.kind === "mixed" ? { kind: "mixed" } : { kind: "family", family: lane.family };
    if (option) {
      if (connected !== null && splitLane(lane).lead !== leadInUse && !laneFamilies(option.mark ?? mark).every(family => connected.has(family))) return [];
      return [{ lane, word: dialWord(option, option.value, option.label, tone, false) }];
    }
    const absent = familiesOf(lane).find(family => missing.includes(family));
    if (!absent) return [];
    const reason = `No ${familyWord(absent)} models in your model list`;
    return [{ lane, word: { ...NO_WORD, key: laneWord(lane), text: laneWord(lane), name: laneLabel(lane, familyWord), selected: false, available: false,
      reason, says: reason, tone, quiet: false, verifies: true } }];
  });
}

/**
 * The lead row: Mixed, then each family the offered lanes lead on, with an `only` box at its end. A
 * lead word commits its lead's variant on the box's side (`gpt-only` with Claude pressed is
 * `claude-only`); where the lead does not offer that variant, or it cannot run while the other can,
 * it commits the other, and says so. A lead is struck, with its variant's reason as a lane was, only
 * when neither of its lanes can run, so a runnable lane is never out of reach behind a struck lead.
 * A lead word's key is its family, or `mixed`.
 */
function leadRow(input: RowsInput): GeneratorRow {
  const { familyWord } = input;
  const offered = laneWords(input);
  const variants = new Map<string, { only?: RowWord; led?: RowWord }>();
  for (const { lane, word } of offered) {
    const { lead, only } = splitLane(lane);
    variants.set(lead, { ...variants.get(lead), [only ? "only" : "led"]: word });
  }
  const chosen = offered.find(entry => entry.word.selected);
  const current = chosen ? splitLane(chosen.lane) : { lead: "mixed", only: false };
  const leads = [...variants.keys()].sort((left, right) => Number(right === "mixed") - Number(left === "mixed"));
  const words = leads.map((lead): RowWord => {
    const { only, led } = variants.get(lead)!;
    const wanted = current.only ? only : led, other = current.only ? led : only;
    const word = (wanted && (wanted.selected || wanted.available || !other?.available) ? wanted : other ?? wanted)!;
    const text = lead === "mixed" ? "mixed" : familyWord(lead);
    // The other variant is said beside what choosing it does, so a lead change never moves the box silently.
    const nearest = word === wanted || lead === "mixed" ? null
      : wanted === undefined ? `no ${current.only ? `${text} only` : `${text}-led`} lane, so ${word.name}` : `${wanted.name} cannot run, so ${word.name}`;
    return { ...word, key: lead, text, says: [nearest, word.says].filter(Boolean).join(" · ") };
  });
  const { only, led } = variants.get(current.lead) ?? {};
  const other = current.only ? led : only;
  const leadText = current.lead === "mixed" ? "mixed" : familyWord(current.lead);
  const why = current.lead === "mixed" ? "mixed leads on GPT and Claude together"
    : `no ${current.only ? `${leadText}-led` : `${leadText} only`} lane`;
  const word: RowWord = other
    ? { ...other, key: "only", text: "only" }
    : { ...NO_WORD, key: "only", text: "only", name: "only", selected: false, available: false, reason: why, says: why,
      tone: chosen?.word.tone ?? { kind: "mixed" }, quiet: false };
  return {
    id: "lane", word: "lane", label: "lead", kind: "lead", words,
    only: { checked: current.only, enabled: other !== undefined, struck: other !== undefined && !other.available, word },
  };
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
  return { id: "tier", word: "tier", label: "model", kind: "level", words, only: null };
}

function levelRow(slot: Slot, word: "thinking" | "advisor"): GeneratorRow {
  const words = slot.options.map(option => option.value === "off"
    ? dialWord(option, option.value, option.label, { kind: "plain" }, true)
    : dialWord(option, option.value, option.label, { kind: "accent" }, false));
  return { id: word, word, label: word, kind: "level", words, only: null };
}

/** An extra as its own row of two words, on then off; the chosen one says what it means, the other what turning it does. */
function switchRow(extra: SlotOption): GeneratorRow {
  const side = (on: boolean): RowWord => {
    const chosen = extra.on === on;
    return {
      ...NO_WORD, key: on ? "on" : "off", text: on ? "on" : "off", name: `${extra.label} ${on ? "on" : "off"}`, selected: chosen,
      available: chosen || extra.available, reason: chosen || extra.available ? null : extra.reason, says: chosen ? extra.meaning : extra.note,
      quota: chosen ? null : extra.quota, option: chosen || !extra.available ? null : extra,
      tone: on ? { kind: "accent" } : { kind: "plain" }, quiet: !on,
    };
  };
  return { id: extra.value as RowId, word: "extras", label: extra.label, kind: "switch", words: [side(true), side(false)], only: null };
}

/** The extras the generator keeps as rows; the others are switches in the session options sheet. */
export const ROW_EXTRAS: readonly string[] = ["fallbacks"];

/** Every row, top to bottom: lead, model, thinking, advisor, fallbacks. The machine is the launch's own word (machine-picker.tsx). */
export function generatorRows(input: RowsInput): GeneratorRow[] {
  const { slots } = input;
  return [leadRow(input), tierRow(input), levelRow(slots.thinking, "thinking"), levelRow(slots.advisor, "advisor"),
    ...slots.extras.options.filter(extra => ROW_EXTRAS.includes(extra.value)).map(switchRow)];
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
