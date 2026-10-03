import { ThinkingLevelSchema } from "@atyrode/manifold-omp";
import type { MachineSummary } from "@manifold/protocol";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import type { Lane, ModelChoice, Route, Selection } from "../../domain/contracts.ts";
import { familyPolicy, providerPolicy } from "../../domain/providers.ts";
import { modelBucket, poolId, roleOutcomes, type QuotaPool, type RoleOutcome } from "../../domain/quota.ts";
import type { Review } from "../../domain/routing.ts";
import { movesText, type ListFailure } from "./board-model.ts";
import { optionConsequence, redline, routeChanges, type DialMove, type OptionContext, type Redline, type Rescue, type RoleMove } from "./consequences.ts";
import { chooseOption, laneWord, SPECS, type DialId, type MoreDial, type OptionRefusal } from "./dial-space.ts";
import type { GateRefusal, GateVerdict, LaunchStep, ProfileSource } from "./launch-step.ts";
import type { VerificationPhase } from "./model-verification.ts";
import type { VerificationStatus } from "./verification.ts";

/*
 * The statement line as data: its six words, each word's options with what choosing one would do,
 * the verb's label for the workbench's step, and the two status lines under it. Pure, so the rules
 * (which option carries a redline, what the verb says, which status outranks which) are tested apart
 * from the DOM; statement.tsx and slot.tsx only draw what this returns. Quota and gate facts come
 * from the domain and the workbench model; nothing here judges either.
 */

// ---------------------------------------------------------------- words

export type StatementWord = "lane" | "tier" | "thinking" | "advisor" | "extras" | "machine";
/** The words a team is made of; the machine is the destination, not part of the team. */
export type TeamWord = Exclude<StatementWord, "machine">;
export type TeamWords = Readonly<Record<TeamWord, string>>;
/** Reading order, which is also the order ←/→ walk and every width form fills its rows in. */
export const STATEMENT_WORDS: readonly StatementWord[] = ["lane", "tier", "thinking", "advisor", "extras", "machine"];
type DialWord = "lane" | "tier" | "thinking" | "advisor";
const DIAL_OF: Readonly<Record<DialWord, DialId>> = { lane: "lane", tier: "model", thinking: "thinking", advisor: "advisor" };
export const WORD_NAMES: Readonly<Record<StatementWord, string>> = {
  lane: "Lane", tier: "Tier", thinking: "Thinking", advisor: "Advisor", extras: "Extras", machine: "Machine",
};
/** Words read before a value ("thinking high", "on Studio"); never part of the value itself. */
export const CONNECTORS: Readonly<Partial<Record<StatementWord, string>>> = { thinking: "thinking", advisor: "advisor", machine: "on" };

/**
 * How the panel names providers and times; the view passes ui.tsx's words and the local clock. A
 * provider is named by its family ("GPT"), never by its account group ("Codex"), so the main view
 * uses one provider word per glance.
 */
export type Vocabulary = {
  readonly family: (family: string) => string;
  readonly time: (epochMs: number) => string;
};

function thinkingWord(level: string): string {
  return level === "xhigh" ? "x-high" : level;
}
function laneLabel(lane: Lane, familyWord: (family: string) => string): string {
  if (lane.kind === "mixed") return "Mixed";
  return lane.blend === "led" ? `${familyWord(lane.family)}-led` : `${familyWord(lane.family)} only`;
}
const CAPABILITY_LABELS = ["fast", "normal", "smart", "elite"] as const;

/**
 * The six More switches, in the order the extras word lists them, with the dial words that mean on
 * and off and what turning each on or off does to a session (routing.ts `compileOmpOverlay`).
 */
const EXTRAS: readonly { readonly dial: MoreDial; readonly word: string; readonly on: string; readonly off: string; readonly does: { readonly on: string; readonly off: string } }[] = [
  { dial: "spark", word: "spark", on: "on", off: "off",
    does: { on: "Tiny and commit run on Spark's own quota, sonic too at fast", off: "Tiny, commit and sonic leave Spark for the lane's models" } },
  { dial: "fallbacks", word: "fallbacks", on: "on", off: "off",
    does: { on: "A role whose model is out falls back along its chain", off: "A role whose model is out waits for it" } },
  { dial: "priority", word: "priority", on: "on", off: "off",
    does: { on: "Requests ask for priority service: faster, at a higher rate", off: "Requests use ordinary service" } },
  { dial: "prewalk", word: "prewalk", on: "on", off: "off",
    does: { on: "Tasks and subagents start with OMP's prewalk", off: "Tasks and subagents start without a prewalk" } },
  { dial: "plans", word: "auto plans", on: "auto", off: "ask",
    does: { on: "Plans are approved without asking you", off: "Plans wait for your approval" } },
  { dial: "budget", word: "free only", on: "free", off: "any",
    does: { on: "Only free routes are used", off: "Any route may be used, free or paid" } },
];
function extraOn(selection: Selection, dial: MoreDial): boolean {
  const extra = EXTRAS.find(entry => entry.dial === dial)!;
  return SPECS[dial].get(selection) === extra.on;
}
/** The words of the switches that are on, in the extras word's order ("spark", "free only"). */
export function extrasOn(selection: Selection): string[] {
  return EXTRAS.flatMap(extra => extraOn(selection, extra.dial) ? [extra.word] : []);
}
/** "no extras", the switches that are on by name up to two ("spark · fallbacks"), else how many are. */
function extrasLabel(on: readonly string[]): string {
  return on.length === 0 ? "no extras" : on.length <= 2 ? on.join(" · ") : `${on.length} extras`;
}
/** Every label the extras word can wear, so a measure of the line holds whichever is on. */
export const EXTRAS_LABELS: readonly string[] = [
  extrasLabel([]), extrasLabel(EXTRAS.map(extra => extra.word)),
  ...EXTRAS.flatMap((first, index) => [extrasLabel([first.word]), ...EXTRAS.slice(index + 1).map(second => extrasLabel([first.word, second.word]))]),
];

/**
 * A team in the line's words, which the statement, the earlier statements and every control name
 * share. The machine is not part of a team: the caller adds its name.
 */
export function teamWords(selection: Selection, familyWord: (family: string) => string): TeamWords {
  return {
    lane: laneLabel(selection.lane, familyWord), tier: CAPABILITY_LABELS[selection.capability - 1]!,
    thinking: thinkingWord(selection.thinking), advisor: selection.advisor, extras: extrasLabel(extrasOn(selection)),
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => [key, canonical(entry)]));
}
/**
 * Two selections are one team when every field agrees, whatever order their keys were written in.
 * Every field, including any the schema gains later, so a new switch can never make two teams compare equal.
 */
export function sameTeam(left: Selection, right: Selection): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Up to three roles by name, else the first two and how many more. */
export function roleList(roles: readonly string[]): string {
  if (roles.length <= 3) return roles.join(", ");
  return `${roles.slice(0, 2).join(", ")} and ${roles.length - 2} more`;
}

// ---------------------------------------------------------------- quota as the team meets it

function stranded(outcome: RoleOutcome): boolean {
  return outcome.kind === "no-route" || outcome.kind === "no-account";
}
function poolOf(catalog: CompiledCatalog, choice: ModelChoice, pools: readonly QuotaPool[]): QuotaPool | null {
  const model = catalog.model(choice.key);
  const id = poolId(model.provider, modelBucket(model.provider, model.tier));
  return pools.find(pool => pool.id === id) ?? null;
}

/**
 * Roles with no route at all, and every pool they wait on: the leads' pools in route order (out, or
 * serving no included account), then the pools of their served fallbacks, which are out too. Each
 * pool carries its own verdict and reopening, so no pool is ever said with another's time.
 */
export type Standstill = {
  readonly roles: readonly string[];
  readonly waits: readonly QuotaPool[];
};

/** The roles of `routes` that nothing can serve now (`roleOutcomes`), or null when every role has a route. */
export function standstill(catalog: CompiledCatalog, routes: readonly Route[], pools: readonly QuotaPool[]): Standstill | null {
  const outcomes = roleOutcomes(catalog, routes, pools).filter(stranded);
  if (outcomes.length === 0) return null;
  const held = routes.filter(route => outcomes.some(outcome => outcome.role === route.role));
  const leads = held.map(route => poolOf(catalog, route.lead, pools));
  // A no-route role's served fallbacks are out as well (roleOutcomes), so their pools hold it too; a no-account role has no chain.
  const fallbacks = held.flatMap(route => outcomes.find(outcome => outcome.role === route.role)!.kind === "no-route"
    ? route.fallback.map(choice => poolOf(catalog, choice, pools)).filter(pool => pool?.verdict.kind === "blocked" || pool?.verdict.kind === "maxed") : []);
  const waits = new Map<string, QuotaPool>();
  for (const pool of [...leads, ...fallbacks]) if (pool && !waits.has(pool.id)) waits.set(pool.id, pool);
  return { roles: outcomes.map(outcome => outcome.role), waits: [...waits.values()] };
}

/**
 * The redline an option carries, kept only where choosing it is the cause: it leaves without a
 * route a role that has one now, or it leads on a blocked, maxed, tight or unserved pool the current
 * team does not already lead on. A pool the team already strains marks every option that keeps it,
 * which would mark nearly every option and say nothing about any one of them.
 */
export function causalRedline(catalog: CompiledCatalog, current: Review, consequence: { readonly review: Review; readonly redline: Redline | null } | null,
  pools: readonly QuotaPool[]): Redline | null {
  if (!consequence?.redline) return null;
  const before = new Set(roleOutcomes(catalog, current.routes, pools).filter(stranded).map(outcome => outcome.role));
  if (roleOutcomes(catalog, consequence.review.routes, pools).some(outcome => stranded(outcome) && !before.has(outcome.role))) return consequence.redline;
  const strainedNow = new Set(current.routes.flatMap(route => {
    const pool = poolOf(catalog, route.lead, pools);
    const kind = pool?.verdict.kind;
    // Stale and unknown readings say nothing current about a pool, so they never count as strain.
    return pool && (kind === "none" || kind === "blocked" || kind === "maxed" || kind === "tight") ? [pool.id] : [];
  }));
  return strainedNow.has(consequence.redline.pool.id) ? null : consequence.redline;
}

/** What choosing an option does to quota, when it does anything worth a line. */
export type QuotaNote =
  | { readonly kind: "strands"; readonly stop: Standstill }
  | { readonly kind: "strains"; readonly redline: Redline }
  | { readonly kind: "clears"; readonly roles: readonly string[] };

function quotaNote(catalog: CompiledCatalog, current: Review, next: Review, marked: Redline | null, pools: readonly QuotaPool[]): QuotaNote | null {
  const before = standstill(catalog, current.routes, pools);
  const after = standstill(catalog, next.routes, pools);
  if (after && after.roles.some(role => !before?.roles.includes(role))) return { kind: "strands", stop: after };
  if (before && !after) return { kind: "clears", roles: before.roles };
  return marked ? { kind: "strains", redline: marked } : null;
}

// ---------------------------------------------------------------- consequence sentences

/** One sentence of what a team change does: which roles rise, fall, move provider, appear or go. List-price cost and speed indices are left out: they mean nothing on a subscription. */
export function changeSentence(catalog: CompiledCatalog, before: Review, after: Review, familyWord: (family: string) => string): string {
  const raised: string[] = [], lowered: string[] = [], added: string[] = [], removed: string[] = [];
  let chains = 0;
  const moved = new Map<string, string[]>();
  const thinking = ThinkingLevelSchema.options;
  for (const change of routeChanges(before.routes, after.routes)) {
    if (change.kind === "added") added.push(change.role);
    else if (change.kind === "removed") removed.push(change.role);
    else if (change.kind === "fallback") chains++;
    else {
      const from = change.from!.lead, to = change.to!.lead;
      const fromFamily = catalog.family(from.key), toFamily = catalog.family(to.key);
      if (fromFamily !== toFamily) moved.set(toFamily, [...moved.get(toFamily) ?? [], change.role]);
      else {
        const tier = catalog.model(to.key).tier - catalog.model(from.key).tier;
        const effort = thinking.indexOf(to.thinking) - thinking.indexOf(from.thinking);
        ((Math.sign(tier) || Math.sign(effort)) > 0 ? raised : lowered).push(change.role);
      }
    }
  }
  const list = (roles: readonly string[]) => roles.length > 8 ? `${roles.length} roles` : roles.join(", ");
  const parts: string[] = [];
  if (raised.length) parts.push(`raises ${list(raised)}`);
  if (lowered.length) parts.push(`lowers ${list(lowered)}`);
  for (const [family, roles] of moved) parts.push(`moves ${list(roles)} to ${familyWord(family)}`);
  if (added.length) parts.push(`adds ${list(added)}`);
  if (removed.length) parts.push(`drops ${list(removed)}`);
  if (chains && !parts.length) parts.push(after.selection.fallback ? `adds fallback chains to ${chains} roles` : `drops fallback chains from ${chains} roles`);
  const sentence = parts.length ? parts.join("; ") : "no route changes";
  return `${sentence[0]!.toUpperCase()}${sentence.slice(1)}`;
}

/** What moving the line's team to `next` would do, for a team pointed outside the line (a recent team, a fix): its sentence and quota note. */
export function teamChange(catalog: CompiledCatalog, current: Review, next: Review, pools: readonly QuotaPool[], familyWord: (family: string) => string):
  { readonly sentence: string; readonly quota: QuotaNote | null } {
  const marked = causalRedline(catalog, current, { review: next, redline: redline(catalog, next.routes, pools) }, pools);
  return { sentence: changeSentence(catalog, current, next, familyWord), quota: quotaNote(catalog, current, next, marked, pools) };
}

function refusalText(word: StatementWord, value: string, selection: Selection, refusal: OptionRefusal, vocab: Vocabulary): string {
  if (refusal.kind === "account") return `Needs a ${vocab.family(refusal.family)} account`;
  const lead = selection.lane.kind === "mixed" ? "openai" : selection.lane.family;
  if (word === "tier") return `No ${value} ${vocab.family(lead)} model`;
  if (value === "spark" || value === "priority") return `${value === "spark" ? "Spark" : "Priority"} needs a GPT lane`;
  if (value === "budget") return "No free route for this team";
  return "Not among the current models";
}

// ---------------------------------------------------------------- the words' options

/** A lane option's mark: its family's square, a small one for the family it crosses to when led, or both for Mixed. */
export type LaneMark = { readonly kind: "mixed" } | { readonly kind: "provider"; readonly family: string; readonly cross: string | null };

export type SlotOption = {
  /** The stable value: a dial word, an extra's dial id, or a machine id. */
  readonly value: string;
  readonly label: string;
  readonly mark: LaneMark | null;
  /** The value on the line. Extras have none: each switch is `on` or not. */
  readonly current: boolean;
  /** Extras only: the switch is on. */
  readonly on: boolean;
  /** It can be chosen; the current option always can. */
  readonly available: boolean;
  /** Why it cannot be chosen, in the word's own terms. */
  readonly reason: string | null;
  /** The team choosing it commits; null for machines, refused options and the current one. */
  readonly selection: Selection | null;
  /** The review that team produces when it can be previewed: what the board draws while the option is pointed. */
  readonly review: Review | null;
  readonly moves: readonly RoleMove[];
  /** Only where choosing it is the cause (`causalRedline`); never on the current value. */
  readonly redline: Redline | null;
  /** The last launch had this value here (for extras: the switch was the other way round). */
  readonly last: boolean;
  /** What choosing it does ("Raises plan, slow"; for advisor levels and switches, what the session does), its refusal, or a machine's state. */
  readonly note: string;
  readonly quota: QuotaNote | null;
};
/** One word: its options in drum order (the top is more), and where the line's value sits among them. */
export type Slot = {
  readonly word: StatementWord;
  readonly options: readonly SlotOption[];
  /** Index of the current option; -1 for extras, which have no single value. */
  readonly current: number;
  /** The label on the line. */
  readonly label: string;
  /** The value on the line differs from the last launch. */
  readonly changed: boolean;
  /** The value on the line differs from the saved workspace team, which the verb's save would change. */
  readonly edited: boolean;
};

export type StatementContext = OptionContext & {
  readonly catalog: CompiledCatalog;
  /** The team on the line. */
  readonly selection: Selection;
  /** The review the controls show, which names the lanes on offer (`controlsReview`). */
  readonly review: Review;
  readonly pools: readonly QuotaPool[];
  /** The newest team this browser launched, if any. */
  readonly lastLaunch: Selection | null;
  /** The saved workspace team while the line holds an unsaved edit of it; null otherwise. */
  readonly saved: Selection | null;
  readonly machines: readonly MachineSummary[] | null;
  /** The machine list could not be read; `machines` is the last list read, or null when none was. */
  readonly rosterError: boolean;
  readonly machineId: string;
};

/** Ordinal words run strongest at the top of the drum, so up is more; lanes keep their spectrum, machines the roster. */
const DESCENDING: Readonly<Partial<Record<StatementWord, true>>> = { tier: true, thinking: true, advisor: true };

function laneMark(lane: Lane | undefined): LaneMark | null {
  if (!lane) return null;
  if (lane.kind === "mixed") return { kind: "mixed" };
  return { kind: "provider", family: lane.family, cross: lane.blend === "led" ? familyPolicy(lane.family).crossTo : null };
}
function optionLabel(word: DialWord, value: string, review: Review, vocab: Vocabulary): string {
  if (word === "lane") {
    const lane = review.available.lanes.find(candidate => laneWord(candidate) === value);
    return lane ? laneLabel(lane, vocab.family) : value;
  }
  return word === "thinking" ? thinkingWord(value) : value;
}

/** What an advisor level does, from the advisor route the level forms: its model's tier, family and thinking. */
const ADVISOR_DOES: Readonly<Record<string, string>> = { glance: "glances at the work", review: "reviews the work", audit: "audits the work and every subagent's task" };
function advisorNote(catalog: CompiledCatalog, value: string, review: Review | null, vocab: Vocabulary): string {
  if (value === "off") return "No advisor";
  const route = review?.routes.find(entry => entry.role === "advisor");
  if (!route) return `An advisor ${ADVISOR_DOES[value]}`;
  const model = catalog.model(route.lead.key);
  return `A ${CAPABILITY_LABELS[model.tier - 1]} ${vocab.family(catalog.family(route.lead.key))} advisor ${ADVISOR_DOES[value]}, thinking ${thinkingWord(route.lead.thinking)}`;
}

function dialSlot(word: DialWord, context: StatementContext, vocab: Vocabulary): Slot {
  const { catalog, selection, review, pools, lastLaunch, saved } = context;
  const dial = DIAL_OF[word];
  const spec = SPECS[dial];
  const now = spec.get(selection);
  const last = lastLaunch ? spec.get(lastLaunch) : null;
  const options = spec.words(review).flat().map((value): SlotOption => {
    const label = optionLabel(word, value, review, vocab);
    const mark = word === "lane" ? laneMark(review.available.lanes.find(lane => laneWord(lane) === value)) : null;
    const base = { value, label, mark, on: false, last: last === value && value !== now };
    if (value === now) {
      return { ...base, current: true, available: true, reason: null, selection: null, review: null, moves: [], redline: null, note: "now", quota: null };
    }
    const choice = chooseOption(catalog, selection, review, dial, value, context);
    if (choice.refusal || !choice.selection) {
      const reason = choice.refusal ? refusalText(word, value, selection, choice.refusal, vocab) : "Not among the current models";
      return { ...base, current: false, available: false, reason, selection: null, review: null, moves: [], redline: null, note: reason, quota: null };
    }
    const consequence = optionConsequence(catalog, review, dial, value, context);
    const marked = causalRedline(catalog, review, consequence, pools);
    const pruned = choice.pruned.map(gap => `fallbacks on ${vocab.family(gap.family)} dropped: no account`);
    const does = word === "advisor" ? advisorNote(catalog, value, consequence?.review ?? null, vocab)
      : consequence ? changeSentence(catalog, review, consequence.review, vocab.family) : null;
    return {
      ...base, current: false, available: true, reason: null, selection: choice.selection, review: consequence?.review ?? null,
      moves: consequence?.moves ?? [], redline: marked, note: [...does ? [does] : [], ...pruned].join("; "),
      quota: consequence ? quotaNote(catalog, review, consequence.review, marked, pools) : null,
    };
  });
  const ordered = DESCENDING[word] ? options.reverse() : options;
  const current = ordered.findIndex(option => option.current);
  return { word, options: ordered, current, label: ordered[current]?.label ?? now, changed: last !== null && last !== now,
    edited: saved !== null && spec.get(saved) !== now };
}

function extrasSlot(context: StatementContext, vocab: Vocabulary): Slot {
  const { catalog, selection, review, pools, lastLaunch, saved } = context;
  const options = EXTRAS.map((extra): SlotOption => {
    const on = extraOn(selection, extra.dial);
    const target = on ? extra.off : extra.on;
    const choice = chooseOption(catalog, selection, review, extra.dial, target, context);
    const base = { value: extra.dial, label: extra.word, mark: null, current: false, on, last: lastLaunch !== null && extraOn(lastLaunch, extra.dial) !== on };
    if (choice.refusal || !choice.selection) {
      const reason = choice.refusal ? refusalText("extras", extra.dial, selection, choice.refusal, vocab) : "Not among the current models";
      return { ...base, available: false, reason, selection: null, review: null, moves: [], redline: null, note: reason, quota: null };
    }
    const consequence = optionConsequence(catalog, review, extra.dial, target, context);
    const marked = causalRedline(catalog, review, consequence, pools);
    return {
      ...base, available: true, reason: null, selection: choice.selection, review: consequence?.review ?? null, moves: consequence?.moves ?? [],
      redline: marked, note: on ? extra.does.off : extra.does.on, quota: consequence ? quotaNote(catalog, review, consequence.review, marked, pools) : null,
    };
  });
  const differs = (team: Selection) => EXTRAS.some(extra => extraOn(team, extra.dial) !== extraOn(selection, extra.dial));
  return { word: "extras", options, current: -1, label: extrasLabel(extrasOn(selection)),
    changed: lastLaunch !== null && differs(lastLaunch), edited: saved !== null && differs(saved) };
}

function machineSlot(context: StatementContext): Slot {
  const { machines, machineId, rosterError } = context;
  const options = (machines ?? []).map((machine): SlotOption => {
    const current = machine.id === machineId;
    const reason = machine.revoked ? "access revoked" : machine.online ? null : "offline";
    return {
      value: machine.id, label: machine.name, mark: null, current, on: false, available: reason === null || current, reason,
      selection: null, review: null, moves: [], redline: null, last: false, note: reason ?? "online", quota: null,
    };
  });
  // A destination the roster does not list is still the line's value: said as such, never replaced.
  if (!options.some(option => option.current)) {
    const label = machines === null ? rosterError ? "unread machines" : "reading machines" : machineId ? "unlisted machine" : "no machine";
    const note = machines === null && rosterError ? "the machine list could not be read" : machineId ? "not in your machine list" : "choose where sessions run";
    options.unshift({ value: machineId, label, mark: null, current: true, on: false, available: true, reason: null, selection: null, review: null,
      moves: [], redline: null, last: false, note, quota: null });
  }
  const current = options.findIndex(option => option.current);
  return { word: "machine", options, current, label: options[current]!.label, changed: false, edited: false };
}

/** Every word of the line with its options, consequences and redlines, computed once per team, pool and roster. */
export function statementSlots(context: StatementContext, vocab: Vocabulary): Readonly<Record<StatementWord, Slot>> {
  return {
    lane: dialSlot("lane", context, vocab), tier: dialSlot("tier", context, vocab), thinking: dialSlot("thinking", context, vocab),
    advisor: dialSlot("advisor", context, vocab), extras: extrasSlot(context, vocab), machine: machineSlot(context),
  };
}

/** The nearest option that can be chosen, one step up the drum (`more`) or down; null at the end. */
export function stepOption(slot: Slot, more: boolean): SlotOption | null {
  if (slot.current < 0) return null;
  const direction = more ? -1 : 1;
  for (let at = slot.current + direction; at >= 0 && at < slot.options.length; at += direction) {
    if (slot.options[at]!.available) return slot.options[at]!;
  }
  return null;
}
/** The topmost (`top`) or bottommost option that can be chosen, unless it is already the value. */
export function edgeOption(slot: Slot, top: boolean): SlotOption | null {
  const available = slot.options.filter(option => option.available);
  const edge = top ? available[0] : available.at(-1);
  return edge && !edge.current ? edge : null;
}

/** The team Backspace returns a word to: the last launch's value there, or every extra as it was. Null when nothing differs or the catalog refuses it. */
export function lastLaunchTeam(word: StatementWord, slot: Slot, context: StatementContext): Selection | null {
  const { lastLaunch, catalog } = context;
  if (!lastLaunch || !slot.changed || word === "machine") return null;
  if (word !== "extras") return slot.options.find(option => option.last && option.available)?.selection ?? null;
  // Each switch that differs is turned as the extras word turns it, so the result is a team the dials would form.
  let selection = context.selection, review = context.review;
  for (const extra of EXTRAS) {
    if (extraOn(selection, extra.dial) === extraOn(lastLaunch, extra.dial)) continue;
    const choice = chooseOption(catalog, selection, review, extra.dial, extraOn(lastLaunch, extra.dial) ? extra.on : extra.off, context);
    if (choice.refusal || !choice.selection) return null;
    // A starter's budget cannot be previewed on its catalog; the lanes the next switch reads stay the same.
    selection = choice.selection; review = choice.review ?? review;
  }
  return selection;
}

/**
 * How a new team should land. Back on the saved team, an edit of the active profile is discarded
 * rather than kept as a local draft identical to what is saved, which would ask to save nothing.
 */
export function commitKind(next: Selection, current: Selection, saved: Selection | null, draft: ProfileSource | null): "none" | "discard" | "update" {
  if (sameTeam(next, current)) return "none";
  return draft === "active" && saved !== null && sameTeam(next, saved) ? "discard" : "update";
}

// ---------------------------------------------------------------- the fix for roles with no route

function moveLabel(move: DialMove, review: Review, vocab: Vocabulary): string {
  const word = (Object.keys(DIAL_OF) as DialWord[]).find(key => DIAL_OF[key] === move.dial);
  if (word === "lane") return optionLabel("lane", move.word, review, vocab);
  if (word === "tier") return move.word;
  if (word === "thinking") return `${thinkingWord(move.word)} thinking`;
  if (word === "advisor") return `advisor ${move.word}`;
  const extra = EXTRAS.find(entry => entry.dial === move.dial)!;
  return move.word === extra.on ? extra.word : `no ${extra.word}`;
}
/** A pool in the line's provider words: the family ("GPT"), or the family and its own bucket ("GPT spark"). */
function poolWord(pool: QuotaPool | null, vocab: Vocabulary): string {
  if (!pool) return "its pool";
  const special = pool.bucket !== null && pool.bucket !== providerPolicy(pool.provider).quotaBucketBase;
  return special ? `${vocab.family(pool.family)} ${pool.bucket!.split("-").at(-1)}` : vocab.family(pool.family);
}

/** The one-press fix: the dial move as words ("GPT only") and what it does for the roles that had no route. */
export type FixView = { readonly label: string; readonly result: string; readonly selection: Selection; readonly review: Review };

/**
 * "Claude-led keeps all 12 on GPT" when the move puts every role on one pool ("GPT only gives all 12
 * a route" where the label already names it); otherwise each group of rescued roles by name. A move
 * onto a pool whose availability is not known now says so: a rescue is not measured room.
 */
export function fixView(fix: Rescue, catalog: CompiledCatalog, pools: readonly QuotaPool[], vocab: Vocabulary): FixView | null {
  if (fix.moves.length === 0) return null;
  const label = fix.moves.map(move => moveLabel(move, fix.review, vocab)).join(" + ");
  // Keyed by pool id; a lead whose pool is unknown is its own group, so it never reads as "all on" anything.
  const leading = new Map(fix.review.routes.map(route => {
    const pool = poolOf(catalog, route.lead, pools);
    return [pool?.id ?? `?${route.role}`, pool] as const;
  }));
  const only = leading.size === 1 ? [...leading.values()][0]! : null;
  let result: string;
  let targets: readonly (QuotaPool | null)[];
  if (only && fix.rescued.removed.length === 0 && fix.rescued.fallsBack.length === 0) {
    const count = fix.review.routes.length;
    const lane = fix.review.selection.lane;
    // "GPT only keeps all 12 on GPT" says the pool twice; a lane move that names the pool's family only needs the result.
    const named = fix.moves.some(move => move.dial === "lane") && lane.kind === "provider" && lane.family === only.family &&
      only.bucket === providerPolicy(only.provider).quotaBucketBase;
    result = named ? `gives all ${count} a route` : `keeps all ${count} on ${poolWord(only, vocab)}`;
    targets = [only];
  } else {
    result = [
      ...fix.rescued.leads.map(group => `puts ${roleList(group.roles)} on ${poolWord(group.pool, vocab)}`),
      ...fix.rescued.removed.length ? [`drops ${roleList(fix.rescued.removed)}`] : [],
      ...fix.rescued.fallsBack.length ? [`${roleList(fix.rescued.fallsBack)} fall back`] : [],
    ].join(", ");
    targets = fix.rescued.leads.map(group => group.pool);
  }
  // A rescue onto a pool read long ago, or never, is not measured room.
  if (targets.some(pool => !pool || pool.verdict.kind === "stale" || pool.verdict.kind === "unknown")) result += " · availability unknown";
  return { label, result, selection: fix.selection, review: fix.review };
}

// ---------------------------------------------------------------- the verb

/** Whether a launch's projection rests on present readings: every lead's pool judged fresh, and the served providers known. */
export function grounded(catalog: CompiledCatalog, routes: readonly Route[], pools: readonly QuotaPool[], served: ReadonlySet<string> | null): boolean {
  if (served === null) return false;
  return routes.every(route => {
    const kind = poolOf(catalog, route.lead, pools)?.verdict.kind;
    return kind !== undefined && kind !== "stale" && kind !== "unknown";
  });
}

export type VerbFacts = {
  readonly step: LaunchStep;
  /** The gate's verdict on the step (`WorkbenchModel.verb`). */
  readonly verdict: GateVerdict;
  readonly busy: boolean;
  readonly inFlight: "save" | "review" | "launch" | "resume" | null;
  readonly chaining: boolean;
  readonly unsaved: boolean;
  readonly draft: boolean;
  readonly phase: VerificationPhase | null;
  readonly verification: VerificationStatus;
  /** Some role of the team has no route now because its pools are out (`standstill`), which a launch may go ahead with. */
  readonly stranded: boolean;
  /** The panel's projection rests on present readings (`grounded`). */
  readonly grounded: boolean;
  /** A canvas beside the panel can place a terminal, so a save can go on to a launch here. */
  readonly placeable: boolean;
  /** A Save & launch press waits for its review before launching. */
  readonly launching: boolean;
};
export type VerbView = {
  readonly label: string;
  /** `ready`: a press runs it. `busy`: a step runs. `waiting`: a charge waits on its own Confirm. `refused`: the gate says no. */
  readonly state: "ready" | "busy" | "waiting" | "refused";
  readonly refusal: GateRefusal | null;
  /** A press saves the workspace team first. */
  readonly saves: boolean;
  /** A press goes on from the review to the launch when the review shows what the panel projected. */
  readonly launches: boolean;
  /** A press opens this place instead of taking a step: a staged model list is reviewed in Models. */
  readonly opens: "models" | null;
};

const RUNNING_LABELS: Readonly<Record<"save" | "review" | "launch" | "resume", string>> = {
  save: "Saving…", review: "Reviewing…", launch: "Launching…", resume: "Resuming…",
};
/** Every label the verb can wear: its cell is as wide as the widest, so it never moves the line. */
export const VERB_LABELS: readonly string[] = [
  "Verify models", "Checking…", "Verifying…", "Review", "Save", "Save & review", "Save & launch", "Launch", "Launch anyway",
  "Review in Models", "Saving…", "Reviewing…", "Launching…", "Resuming…", "Working…",
];

/**
 * The verb for the workbench's step. The step and the gate are the model's (`nextLaunchStep`,
 * `actionGate`); this only names them. An edited team saves first: `Save & launch` when the
 * projection rests on present readings, so the press continues through the review to the launch,
 * else `Save & review`, which stops at the review to show the pool, and only `Save` where no canvas
 * can place the terminal. A team with a role that pools leave without a route launches `anyway`,
 * never one whose lead the session door refuses. A staged model list is the one place the verb
 * sends the person: `Review in Models` opens it. A refused step keeps the label of what it would
 * do, with the reason.
 */
export function verbView(facts: VerbFacts): VerbView {
  const view = (label: string, state: VerbView["state"], extra: Partial<Pick<VerbView, "saves" | "launches" | "opens">> = {}): VerbView =>
    ({ label, state, refusal: null, saves: false, launches: false, opens: null, ...extra });
  if (facts.phase === "inventory") return view("Checking…", "busy");
  if (facts.phase === "benchmark") return view("Verifying…", "busy");
  if (facts.phase === "charge") return view("Verify models", "waiting");
  if (facts.busy) return view(facts.inFlight ? RUNNING_LABELS[facts.inFlight] : "Working…", "busy");
  if (facts.chaining) return view("Reviewing…", "busy");
  if (facts.launching) return view("Launching…", "busy");
  if (facts.step.step === "blocked" && facts.step.reason.code === "staged") return view("Review in Models", "ready", { opens: "models" });
  const step = facts.step.step;
  const saves = step === "save" || (step === "blocked" && facts.draft && facts.unsaved && facts.verification === "current");
  const launches = saves && facts.grounded && facts.placeable;
  const anyway = facts.stranded && (facts.verdict.open || facts.verdict.refusal.code !== "no-account");
  const label = step === "verify" ? "Verify models"
    : step === "review" ? "Review"
    : step === "save" ? (!facts.placeable ? "Save" : facts.grounded ? (anyway ? "Launch anyway" : "Save & launch") : "Save & review")
    : step === "launch" ? (anyway ? "Launch anyway" : "Launch")
    : facts.verification === "verifying" ? "Verifying…"
    : facts.verification !== "current" ? "Verify models"
    : saves ? (facts.placeable ? "Save & launch" : "Save") : "Launch";
  if (facts.verdict.open) return view(label, "ready", { saves, launches });
  return { ...view(label, facts.verdict.refusal.code === "running" ? "busy" : "refused", { saves, launches }), refusal: facts.verdict.refusal };
}

/** What the panel projected for a launch: each role's served lead, and the providers its account pool serves (null: unknown). */
export type Projection = { readonly leads: readonly string[]; readonly providers: readonly string[] | null };

export function projectionOf(review: Pick<Review, "routes">, served: ReadonlySet<string> | null): Projection {
  return { leads: review.routes.map(route => `${route.role}:${route.lead.key}:${route.lead.thinking}`).sort(), providers: served ? [...served].sort() : null };
}
/**
 * Whether a session review shows what the panel projected, so `Save & launch` may go on to the
 * launch. A different lead for any role, a different set of providers in the account pool, or a
 * pool the panel did not know stops the press at the review.
 */
export function reviewMatches(projection: Projection, reviewed: { readonly review: Pick<Review, "routes">; readonly accountPool: Readonly<Record<string, readonly unknown[]>> }): boolean {
  if (projection.providers === null) return false;
  const providers = Object.keys(reviewed.accountPool).filter(provider => reviewed.accountPool[provider]!.length > 0);
  const shown = projectionOf(reviewed.review, new Set(providers));
  return shown.leads.length === projection.leads.length && shown.leads.every((lead, index) => lead === projection.leads[index]) &&
    shown.providers!.length === projection.providers.length && shown.providers!.every((provider, index) => provider === projection.providers![index]);
}
/**
 * What a session review shows unlike the projection a Save & launch was pressed on, in the line's
 * words: the roles whose lead moved, seat by seat, and the providers whose accounts joined or left
 * the pool; that the pool was not known when there was no projection of it.
 */
export function reviewDifferences(catalog: CompiledCatalog, projected: Review, providers: readonly string[] | null,
  reviewed: { readonly review: Review; readonly accountPool: Readonly<Record<string, readonly unknown[]>> }, vocab: Vocabulary): string[] {
  const moves = movesText(catalog, projected, reviewed.review);
  const now = Object.keys(reviewed.accountPool).filter(provider => reviewed.accountPool[provider]!.length > 0);
  const families = (list: readonly string[]) => [...new Set(list.map(provider => vocab.family(providerPolicy(provider).family)))];
  if (providers === null) return [...moves ? [moves] : [], "the pool was not known before the review"];
  return [
    ...moves ? [moves] : [],
    ...families(now.filter(provider => !providers.includes(provider))).map(family => `${family} accounts join the pool`),
    ...families(providers.filter(provider => !now.includes(provider))).map(family => `no ${family} account in the pool`),
  ];
}

// ---------------------------------------------------------------- the team at rest

/** What the line's team meets now: where its roles lead, which fall back, which pools are tight, and whether any reading is not current. */
export type TeamFacts = {
  readonly counts: readonly { readonly family: string; readonly count: number }[];
  /** Roles a fallback serves while their own lead's pool is out, one group per such pool with that pool's own reopening. */
  readonly fallsBack: readonly { readonly roles: readonly string[]; readonly pool: QuotaPool | null; readonly until: number | null }[];
  readonly tight: readonly QuotaPool[];
  /** A lead's pool is stale, unknown or not in the reading: its availability is not known now. */
  readonly unread: boolean;
};

export function teamFacts(catalog: CompiledCatalog, routes: readonly Route[], pools: readonly QuotaPool[]): TeamFacts {
  const counts = new Map<string, number>();
  const tight = new Map<string, QuotaPool>();
  let unread = false;
  for (const route of routes) {
    const family = providerPolicy(catalog.model(route.lead.key).provider).family;
    counts.set(family, (counts.get(family) ?? 0) + 1);
    const pool = poolOf(catalog, route.lead, pools);
    if (!pool || pool.verdict.kind === "stale" || pool.verdict.kind === "unknown") unread = true;
    else if (pool.verdict.kind === "tight") tight.set(pool.id, pool);
  }
  const fallsBack = new Map<string, { roles: string[]; pool: QuotaPool | null; until: number | null }>();
  for (const outcome of roleOutcomes(catalog, routes, pools)) {
    if (outcome.kind !== "falls-back") continue;
    const pool = poolOf(catalog, routes.find(route => route.role === outcome.role)!.lead, pools);
    const id = pool?.id ?? "";
    fallsBack.set(id, { roles: [...fallsBack.get(id)?.roles ?? [], outcome.role], pool, until: outcome.until });
  }
  return {
    counts: catalog.families.flatMap(family => counts.has(family) ? [{ family, count: counts.get(family)! }] : []),
    fallsBack: [...fallsBack.values()], tight: [...tight.values()], unread,
  };
}

/** Accounts per family in a reviewed pool, for the families the reviewed routes draw on (leads and fallbacks), in catalog order. */
export function poolCounts(catalog: CompiledCatalog, routes: readonly Route[], accountPool: Readonly<Record<string, readonly unknown[]>>): { family: string; count: number }[] {
  const used = new Set(routes.flatMap(route => [route.lead, ...route.fallback].map(choice => catalog.family(choice.key))));
  const counts = new Map<string, number>();
  for (const [provider, accounts] of Object.entries(accountPool)) {
    const family = providerPolicy(provider).family;
    if (used.has(family) && accounts.length) counts.set(family, (counts.get(family) ?? 0) + accounts.length);
  }
  return catalog.families.flatMap(family => counts.has(family) ? [{ family, count: counts.get(family)! }] : []);
}

/** The lane the included accounts can serve nearest the line's: the same leading family first, then a single-provider lane. */
export function laneFix(slot: Slot, selection: Selection): SlotOption | null {
  const lead = selection.lane.kind === "mixed" ? "openai" : selection.lane.family;
  const score = (option: SlotOption) => {
    const lane = option.selection!.lane;
    return (lane.kind === "provider" && lane.family === lead ? 2 : 0) + (lane.kind === "provider" && lane.blend === "only" ? 1 : 0);
  };
  const candidates = slot.options.filter(option => option.available && !option.current && option.selection);
  return candidates.reduce<SlotOption | null>((best, option) => best === null || score(option) > score(best) ? option : best, null);
}

// ---------------------------------------------------------------- the two status lines

export type StatusTone = "plain" | "strong" | "busy" | "attention" | "warn" | "neutral" | "done" | "meta";
export type StatusPart = { readonly text: string; readonly tone: StatusTone };
/** What a fix does when pressed: a team (through the edit gate), a machine, a place to go, a re-read, or dropping the local draft. */
export type StatusFix =
  | { readonly kind: "team"; readonly selection: Selection; readonly review: Review | null }
  | { readonly kind: "machine"; readonly machineId: string }
  | { readonly kind: "open"; readonly place: "models" | "setup" | "options" | "accounts"; readonly family?: string }
  | { readonly kind: "refresh" }
  | { readonly kind: "discard" };
export type StatusAction =
  | { readonly kind: "confirm"; readonly requests: number }
  | { readonly kind: "cancel" }
  | { readonly kind: "fix"; readonly key: string; readonly label: string; readonly fix: StatusFix };
export type StatusLine = { readonly parts: readonly StatusPart[]; readonly actions: readonly StatusAction[] };

/** What the pointer or keyboard points at, written over the status lines while it is pointed. */
export type Pointed =
  | { readonly kind: "option"; readonly word: StatementWord; readonly option: SlotOption }
  | { readonly kind: "team"; readonly label: string; readonly sentence: string; readonly quota: QuotaNote | null }
  | { readonly kind: "fix"; readonly fix: FixView; readonly sentence: string };

/** One word the verb's save would change on the workspace team, in the line's words ("thinking high → max"). */
export type TeamEdit = { readonly word: TeamWord; readonly from: string; readonly to: string };
/** The words that differ between the saved workspace team and the line's, in reading order. */
export function teamEdits(saved: Selection, selection: Selection, familyWord: (family: string) => string): TeamEdit[] {
  const before = teamWords(saved, familyWord), after = teamWords(selection, familyWord);
  return (Object.keys(after) as TeamWord[]).flatMap(word => before[word] === after[word] ? [] : [{ word, from: before[word], to: after[word] }]);
}

export type StatusFacts = {
  readonly verb: VerbView;
  readonly phase: VerificationPhase | null;
  /** Benchmark requests done and in all, while verifying. */
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly charge: { readonly requests: number; readonly providers: readonly { readonly provider: string; readonly requests: number }[] } | null;
  readonly inFlight: VerbFacts["inFlight"];
  readonly busy: boolean;
  readonly chaining: boolean;
  readonly launching: boolean;
  /** The destination's name and whether it is reachable; null when none is chosen or the roster does not list it. */
  readonly machine: { readonly name: string; readonly online: boolean; readonly revoked: boolean } | null;
  /** A destination is chosen, listed or not. */
  readonly machineChosen: boolean;
  /** The machine list could not be read, so nothing it said about a machine is current. */
  readonly rosterUnread: boolean;
  /** Another online machine, for an offline destination's fix. */
  readonly otherMachine: { readonly id: string; readonly name: string } | null;
  readonly message: { readonly text: string; readonly failed: boolean } | null;
  readonly outcome: { readonly kind: "launched" | "resumed"; readonly machine: string } | null;
  /** The model's status sentence (`launchStatusText`). */
  readonly launchStatus: string;
  readonly stop: Standstill | null;
  readonly fix: FixView | null;
  readonly team: TeamFacts;
  /** What the verb's save would change on the saved workspace team; empty when it saves nothing. */
  readonly edits: readonly TeamEdit[];
  /** The launch review on display, with its pool, until the team, machine or pool changes. */
  readonly reviewed: { readonly machine: string; readonly pool: readonly { readonly family: string; readonly count: number }[] } | null;
  /** A Save & launch press stopped at a review that differs from the projection: what differs, in the line's words. */
  readonly differs: readonly string[] | null;
  /** For an unserved lead: the nearest lane the accounts serve. */
  readonly laneFix: SlotOption | null;
  /** No included account serves anything (the pool is known and empty). */
  readonly nobodyServes: boolean;
  /** The bundled model list could not be read: the seats beside it are still the team on the line, or instead there is no team. */
  readonly listFailure: ListFailure;
  readonly pointed: Pointed | null;
  /** The pointed team's moves seat by seat, written in place of its sentence while the board is a roster, which does not draw them. */
  readonly moves: string | null;
};

const part = (text: string, tone: StatusTone = "plain"): StatusPart => ({ text, tone });
const line = (parts: readonly StatusPart[], actions: readonly StatusAction[] = []): StatusLine => ({ parts, actions });
const EMPTY = line([]);

/** A pool that is out, with its own reopening when one is reported. */
function outWord(pool: QuotaPool, vocab: Vocabulary): string {
  const { verdict } = pool;
  if (verdict.kind === "none") return `No ${poolWord(pool, vocab)} account included`;
  const until = verdict.kind === "blocked" || verdict.kind === "maxed" ? verdict.until : null;
  return `${poolWord(pool, vocab)} ${verdict.kind}${until !== null ? ` until ${vocab.time(until)}` : ""}`;
}
/** Every pool the stranded roles wait on, each with its own state and time. */
function stopHead(stop: Standstill, vocab: Vocabulary): string {
  return stop.waits.length ? stop.waits.map(pool => outWord(pool, vocab)).join(" · ") : "No route";
}
/** A tight pool: no account judged has room, and how many were not judged at all, when any were not. */
function tightWord(pool: QuotaPool, vocab: Vocabulary): string {
  const unjudged = pool.accounts - pool.judged;
  return unjudged > 0 ? `${poolWord(pool, vocab)} tight · ${unjudged} unread` : `${poolWord(pool, vocab)} has no account with room`;
}
function quotaParts(note: QuotaNote | null, vocab: Vocabulary): StatusPart[] {
  if (!note) return [];
  if (note.kind === "strands") return [part(`${stopHead(note.stop, vocab)}: ${roleList(note.stop.roles)} no route`, "attention")];
  if (note.kind === "clears") return [part(`gives ${roleList(note.roles)} a route again`)];
  const { reason, pool, roles } = note.redline;
  if (reason === "tight") return [part(tightWord(pool, vocab), "warn")];
  if (reason === "no-account") return [part(`No ${poolWord(pool, vocab)} account included`, "attention")];
  return [part(`${outWord(pool, vocab)}: ${roleList(roles)} fall back`, "warn")];
}

/** A refused verb: the reason, in neutral grey for read-only and placement and in the attention colour otherwise, and its one-press fix. */
function refusalLines(refusal: GateRefusal, facts: StatusFacts, vocab: Vocabulary): [StatusLine, StatusLine] {
  const fix = (label: string, value: StatusFix, key = label): StatusAction => ({ kind: "fix", key, label, fix: value });
  const attention = (text: string, actions: readonly StatusAction[] = [], aside?: string): [StatusLine, StatusLine] =>
    [line([part(text, "attention")]), line(aside ? [part(aside, "meta")] : [], actions)];
  const where = facts.machine?.name ?? "this machine";
  switch (refusal.code) {
    case "read-only": return [line([part("Read-only workspace", "neutral")]), line([part("changes stay a local preview", "meta")])];
    case "placement": return [line([part("Open Code beside the workspace canvas to launch", "neutral")]), line([part("the team and accounts still save from here", "meta")])];
    case "unavailable": {
      // A failed read says nothing current about any machine: neither offline nor another to use.
      if (facts.rosterUnread) return attention("Machine list unreadable", [fix("retry", { kind: "refresh" })]);
      const use = facts.otherMachine ? [fix(`use ${facts.otherMachine.name}`, { kind: "machine", machineId: facts.otherMachine.id }, "machine")] : [];
      if (!facts.machine) return attention(facts.machineChosen ? "The chosen machine is not in your machine list" : "No machine chosen", use);
      const { name, online, revoked } = facts.machine;
      return attention(revoked ? `${name}: access revoked` : online ? `${name} is unavailable` : `${name} is offline`, use);
    }
    case "accounts": return attention("Accounts not readable", [fix("refresh", { kind: "refresh" })]);
    case "no-accounts": return attention("No account is included", [fix("show accounts", { kind: "open", place: "accounts" }, "accounts")]);
    case "no-account": {
      if (facts.nobodyServes || !refusal.gap) return attention("No account is included", [fix("show accounts", { kind: "open", place: "accounts" }, "accounts")]);
      const word = vocab.family(refusal.gap.family);
      const lane = facts.laneFix?.selection
        ? [fix(`use ${facts.laneFix.label}`, { kind: "team", selection: facts.laneFix.selection, review: facts.laneFix.review }, "lane")] : [];
      return attention(`No ${word} account included`, [...lane, fix(`show ${word} accounts`, { kind: "open", place: "accounts", family: refusal.gap.family }, "accounts")]);
    }
    case "configuration": return attention("The workspace team needs a fresh read", [fix("retry", { kind: "refresh" })]);
    case "staged": return attention("A staged model list waits in Models", [fix("review in Models", { kind: "open", place: "models" })]);
    case "unsaved": return attention("No model list in use", [fix("open Models", { kind: "open", place: "models" })]);
    case "conflict": return attention("The workspace team changed elsewhere", [fix("use theirs", { kind: "discard" })]);
    case "models": return attention("These choices need a model review", [fix("open Models", { kind: "open", place: "models" })]);
    case "verify-status": return attention(`Verification readiness unknown on ${where}`, [fix("retry", { kind: "refresh" })]);
    case "verify-permissions": return attention("Discovery is not enabled", [fix("enable in Setup", { kind: "open", place: "setup" })], "verifying needs it");
    case "sessions": return attention(`Sessions unavailable on ${where}`, [fix("open Setup", { kind: "open", place: "setup" })]);
    case "permissions": return attention(`Sessions not enabled on ${where}`, [fix("enable in Setup", { kind: "open", place: "setup" })]);
    case "skills": return attention("Skill choices need attention", [fix("open options", { kind: "open", place: "options" })]);
    default: return attention(refusal.text.replace(/\.$/, ""));
  }
}

/**
 * The failed model list holds the second line while it fails, whatever else the lines say: beside the
 * seats the line still holds, or as the reason there is no team, with the read again and Models one
 * press away. Whatever the second line offered a press for moves up beside the first, so a refusal's
 * fix, the rescue and the revert stay one press away; words with nothing to press give way.
 */
function withListFailure([first, second]: [StatusLine, StatusLine], failure: ListFailure): [StatusLine, StatusLine] {
  if (failure === "none") return [first, second];
  const kept = second.actions.length ? line([...first.parts, ...second.parts], [...first.actions, ...second.actions]) : first;
  return [kept, line([part(failure === "beside" ? "Model list unavailable · the seats are the team on the line" : "Model list unavailable · no team can be formed without it", "warn")], [
    { kind: "fix", key: "list-retry", label: "retry", fix: { kind: "refresh" } },
    { kind: "fix", key: "list-models", label: "Models", fix: { kind: "open", place: "models" } },
  ])];
}
const REVERT: StatusAction = { kind: "fix", key: "revert", label: "revert", fix: { kind: "discard" } };

/**
 * The line's team at rest: where its roles lead, then the one thing worth saying next (what the
 * save changes, quota, the review). A press that saves the workspace team offers to revert the edit
 * beside what it would change.
 */
function restLines(facts: StatusFacts, vocab: Vocabulary): [StatusLine, StatusLine] {
  const { team, verb } = facts;
  const first = line([part(team.counts.map(({ family, count }) => `${count} on ${vocab.family(family)}`).join(" · "))]);
  const actions = verb.saves ? [REVERT] : [];
  const notes: StatusPart[] = [];
  if (verb.saves) {
    const count = facts.edits.length;
    notes.push(part(count ? `${count} ${count === 1 ? "change" : "changes"}: ${facts.edits.map(edit => `${WORD_NAMES[edit.word].toLowerCase()} ${edit.from} → ${edit.to}`).join(", ")}`
      : `${verb.label} saves the workspace team`));
  }
  for (const { pool, roles } of team.fallsBack) notes.push(part(`${pool ? outWord(pool, vocab) : "A pool is out"}: ${roleList(roles)} fall back`, "warn"));
  if (team.fallsBack.length === 0 && team.tight.length) notes.push(part(team.tight.map(pool => tightWord(pool, vocab)).join(" · "), "warn"));
  if (facts.reviewed) {
    const pool = facts.reviewed.pool.map(({ family, count }) => `${vocab.family(family)} ${count}`).join(" · ");
    notes.push(part(`reviewed on ${facts.reviewed.machine}${pool ? `: ${pool}` : ""}`));
  } else if (team.unread && (verb.label === "Review" || verb.label === "Save & review")) notes.push(part("the review shows the pool before anything runs", "meta"));
  return [first, line(notes, actions)];
}

/**
 * The two status lines, in precedence: a verification running or its charge (never written over),
 * a step in flight, the pointed option or team, the verb's refusal with its fix, a staged model list
 * the verb opens, a review that differs from the projection, a failure, the outcome of the last
 * step, the verification still to do, roles with no route and the fix that routes them, and at rest
 * the team's own consequence. From the verb's refusal on, a failed model list takes the second line.
 */
export function statusLines(facts: StatusFacts, vocab: Vocabulary): readonly [StatusLine, StatusLine] {
  const cancel: StatusAction = { kind: "cancel" };
  if (facts.phase === "inventory") return [line([part("Checking which models your accounts can reach", "busy")]), line([], [cancel])];
  if (facts.phase === "charge" && facts.charge) {
    const { requests, providers } = facts.charge;
    if (requests === 0) return [line([part("Nothing to verify through these accounts")]), line([], [cancel])];
    const spend = providers.filter(entry => entry.requests > 0)
      .map(entry => `${vocab.family(providerPolicy(entry.provider).family)} ${entry.requests}`).join(" · ");
    return [line([part(`Verifying spends ${requests} tiny ${requests === 1 ? "request" : "requests"}`), part(spend)]),
      line([part("nothing is spent until you confirm", "meta")], [{ kind: "confirm", requests }, cancel])];
  }
  if (facts.phase === "benchmark") {
    const progress = facts.progress ? [part(`${facts.progress.done} of ${facts.progress.total} requests`, "meta")] : [];
    return [line([part("Verifying models with your accounts", "busy"), ...progress]), line([], [cancel])];
  }
  if (facts.busy || facts.chaining || facts.launching) {
    const where = facts.machine?.name ?? "the machine";
    const text = facts.launching || facts.inFlight === "launch" ? `Opening a terminal on ${where}`
      : facts.inFlight === "save" ? "Saving the workspace team"
      : facts.inFlight === "review" || facts.chaining ? `Reviewing the session on ${where}`
      : facts.inFlight === "resume" ? `Resuming on ${where}` : "Working";
    return [line([part(text, "busy")]), EMPTY];
  }
  const base = withListFailure(baseLines(facts, vocab), facts.listFailure);
  const pointed = facts.pointed;
  if (!pointed) return base;
  // While the board is a roster, the pointed team's moves are said here seat by seat; in columns the board draws them.
  const said = (sentence: string) => facts.moves || sentence;
  if (pointed.kind === "fix") return [line([part(pointed.fix.label, "strong"), part(said(pointed.sentence))]), base[1]];
  if (pointed.kind === "team") return [line([part(pointed.label, "strong"), part(said(pointed.sentence))]), line(quotaParts(pointed.quota, vocab))];
  const { word, option } = pointed;
  const name = word === "extras" ? `${option.on ? "Turn off" : "Turn on"} ${option.label}` : `${WORD_NAMES[word]} ${option.label}`;
  if (option.current) return [line([part(name, "strong"), part("on the line now", "meta")]), base[1]];
  const note = option.available ? said(option.note) : option.note;
  return [line([part(name, "strong"), part(note || "no route changes", option.available ? "plain" : "attention")]), line(quotaParts(option.quota, vocab))];
}

function baseLines(facts: StatusFacts, vocab: Vocabulary): [StatusLine, StatusLine] {
  const { verb } = facts;
  if (verb.state === "refused" && verb.refusal) return refusalLines(verb.refusal, facts, vocab);
  if (verb.opens === "models") return [line([part("A staged model list waits in Models")]), line([part(`${verb.label} opens it; the line keeps its team`, "meta")])];
  // A stop is a choice, not a failure: what the review shows instead, and both ways on.
  if (facts.differs) return [line([part("The review differs", "warn"), ...facts.differs.map(text => part(text))]),
    line([part("Launch to use the reviewed pool, or change a word first", "meta")])];
  if (facts.message?.failed) return [line([part(facts.message.text, "attention")]), EMPTY];
  if (facts.outcome) return [line([part(`${facts.outcome.kind === "launched" ? "Launched" : "Resumed"} on ${facts.outcome.machine}`, "done")]), EMPTY];
  if (facts.message) return [line([part(facts.message.text, "done")]), EMPTY];
  if (verb.label === "Verify models") return [line([part(facts.launchStatus)]), restLines(facts, vocab)[0]];
  if (facts.stop) {
    const scope = verb.saves ? [part(`${verb.label} saves the workspace team`, "meta")] : [];
    const head = [part(stopHead(facts.stop, vocab), "attention"), part(`${roleList(facts.stop.roles)} ${facts.stop.roles.length === 1 ? "has" : "have"} no route`), ...scope];
    const fix = facts.fix
      ? line([], [{ kind: "fix", key: "rescue", label: `${facts.fix.label} ${facts.fix.result}`, fix: { kind: "team", selection: facts.fix.selection, review: facts.fix.review } }])
      : line([part("no dial move gives every role a route", "meta")]);
    return [line(head), fix];
  }
  return restLines(facts, vocab);
}
