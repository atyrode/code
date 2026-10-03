import { ThinkingLevelSchema } from "@atyrode/manifold-omp";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import type { Lane, Selection } from "../../domain/contracts.ts";
import { reviewCatalog, type Review } from "../../domain/routing.ts";

/*
 * The dials as data: every dial, its words, and the selection choosing a word commits. Pure, so
 * the controls, map-mode previews, option consequences and the inverse search all read one
 * definition of what a dial move does.
 */

const THINKING = ThinkingLevelSchema.options;
type Thinking = (typeof THINKING)[number];

/**
 * The local catalog review a hypothetical selection would produce, or null when the domain
 * refuses it. Pure apart from reading the clock when `nowMs` is omitted (time of day feeds the
 * estimates); performs no effects, so map-mode previews can call it on every hover.
 */
export function previewSelection(compiled: CompiledCatalog, selection: Selection, nowMs = Date.now()): Review | null {
  try { return reviewCatalog(compiled, selection, nowMs); } catch { return null; }
}

export type DialId = "lane" | "model" | "thinking" | "advisor" | "budget" | "priority" | "spark" | "prewalk" | "plans" | "fallbacks";
export const MAIN_DIALS: readonly DialId[] = ["lane", "model", "thinking", "advisor"];
export type MoreDial = "budget" | "priority" | "spark" | "prewalk" | "plans" | "fallbacks";
export const MORE_DIALS: readonly MoreDial[] = ["budget", "priority", "spark", "prewalk", "plans", "fallbacks"];
export const CAPABILITY_WORDS = ["fast", "normal", "smart", "elite"] as const;

/** The lane's stable word (`gpt-led`), which map mode and the routing preview key on; never shown. */
const LANE_KEYS: Readonly<Record<string, string>> = { openai: "gpt", anthropic: "claude" };
export const laneWord = (lane: Lane) => lane.kind === "mixed" ? "mixed" : `${LANE_KEYS[lane.family] ?? lane.family}-${lane.blend}`;
/** A spectrum: the two providers `mixed` blends on either side of it, then every other provider. */
export function laneGroups(lanes: readonly Lane[]): Lane[][] {
  const find = (family: string, blend: "only" | "led") => lanes.find(lane => lane.kind === "provider" && lane.family === family && lane.blend === blend);
  const mixed = lanes.find(lane => lane.kind === "mixed");
  const spectrum = mixed ? [find("openai", "only"), find("openai", "led"), mixed, find("anthropic", "led"), find("anthropic", "only")].filter((lane): lane is Lane => lane !== undefined) : [];
  const used = new Set(spectrum);
  const groups = spectrum.length ? [spectrum] : [];
  for (const family of new Set(lanes.flatMap(lane => lane.kind === "provider" ? [lane.family] : []))) {
    const group = [find(family, "led"), find(family, "only")].filter((lane): lane is Lane => lane !== undefined && !used.has(lane));
    if (group.length) groups.push(group);
  }
  return groups;
}

/** A lane change keeps what the new lane can serve and steps the rest down, as choosing it by hand would. */
function withLane(catalog: CompiledCatalog, selection: Selection, lane: Lane): Selection {
  const probe = previewSelection(catalog, { ...selection, lane, capability: 1, spark: false, priority: false, budget: "any" });
  if (!probe) return { ...selection, lane };
  const { capabilities, spark, priority, budgets } = probe.available;
  return {
    ...selection, lane,
    capability: capabilities.includes(selection.capability) ? selection.capability : capabilities.at(-1)!,
    spark: selection.spark && spark, priority: selection.priority && priority,
    budget: budgets.includes(selection.budget) ? selection.budget : "any",
  };
}

type Spec = { label: string; words: (review: Review) => string[][]; get: (selection: Selection) => string; set: (catalog: CompiledCatalog, selection: Selection, word: string, review: Review) => Selection | null };
const binary = (label: string, key: "priority" | "spark" | "prewalk" | "fallback"): Spec => ({
  label, words: () => [["off", "on"]], get: selection => selection[key] ? "on" : "off", set: (_, selection, word) => ({ ...selection, [key]: word === "on" }),
});
export const SPECS: Readonly<Record<DialId, Spec>> = {
  lane: {
    label: "Lane", words: review => laneGroups(review.available.lanes).map(group => group.map(laneWord)), get: selection => laneWord(selection.lane),
    set: (catalog, selection, word, review) => { const lane = review.available.lanes.find(candidate => laneWord(candidate) === word); return lane ? withLane(catalog, selection, lane) : null; },
  },
  model: {
    label: "Model", words: () => [[...CAPABILITY_WORDS]], get: selection => CAPABILITY_WORDS[selection.capability - 1]!,
    set: (_, selection, word) => { const index = CAPABILITY_WORDS.indexOf(word as typeof CAPABILITY_WORDS[number]); return index < 0 ? null : { ...selection, capability: (index + 1) as Selection["capability"] }; },
  },
  thinking: { label: "Thinking", words: () => [[...THINKING]], get: selection => selection.thinking, set: (_, selection, word) => THINKING.includes(word as Thinking) ? { ...selection, thinking: word as Thinking } : null },
  advisor: {
    label: "Advisor", words: () => [["off", "glance", "review", "audit"]], get: selection => selection.advisor,
    set: (_, selection, word) => word === "off" || word === "glance" || word === "review" || word === "audit" ? { ...selection, advisor: word } : null,
  },
  budget: { label: "Budget", words: () => [["any", "free"]], get: selection => selection.budget, set: (_, selection, word) => word === "any" || word === "free" ? { ...selection, budget: word } : null },
  priority: binary("Priority", "priority"),
  spark: binary("Spark", "spark"),
  prewalk: binary("Prewalk", "prewalk"),
  plans: { label: "Plans", words: () => [["ask", "auto"]], get: selection => selection.planYolo ? "auto" : "ask", set: (_, selection, word) => ({ ...selection, planYolo: word === "auto" }) },
  fallbacks: binary("Fallbacks", "fallback"),
};

/**
 * The first family this review would route to (lead or fallback) with no included account, mirroring
 * the session door, which refuses a composition whose any routed provider lacks pool accounts.
 */
export function missingFamily(catalog: CompiledCatalog, review: Review, families: ReadonlySet<string>): string | undefined {
  return [...new Set(review.routes.flatMap(route => [route.lead, ...route.fallback]).map(choice => catalog.family(choice.key)))].find(family => !families.has(family));
}

/** Why an option cannot be chosen: the catalog cannot form it, or it routes to a family no included account serves. */
export type OptionRefusal = { kind: "catalog" } | { kind: "account"; family: string };
export type OptionChoice = {
  /** The selection choosing the option commits; null when the dial has no such word. */
  selection: Selection | null;
  /** The review it produces; null when refused, or when it cannot be previewed (a starter's budget re-derives the catalog). */
  review: Review | null;
  refusal: OptionRefusal | null;
};
/**
 * What choosing `word` on `dial` does from `selection`, exactly as the dial commits it. `base` is
 * the review the controls show, which names the lanes on offer. `families` holds the families with
 * at least one included account when that is known, so a lane routing to a family nobody serves is
 * refused instead of failing at review; `starter` marks a bundled catalog, which is re-derived for
 * a new budget, so the current catalog cannot preview a budget change.
 */
export function chooseOption(catalog: CompiledCatalog, selection: Selection, base: Review, dial: DialId, word: string,
  context: { families: ReadonlySet<string> | null; starter: boolean; nowMs: number }): OptionChoice {
  let candidate = SPECS[dial].set(catalog, selection, word, base);
  let review = candidate && previewSelection(catalog, candidate, context.nowMs);
  // A free budget a new lane cannot serve steps back to any, rather than refusing the lane.
  if (!review && candidate && dial === "lane" && candidate.budget === "free") {
    candidate = { ...candidate, budget: "any" };
    review = previewSelection(catalog, candidate, context.nowMs);
  }
  let refusal: OptionRefusal | null = null;
  if (dial === "budget" && word === "free" && context.starter) refusal = base.available.budgets.includes("free") ? null : { kind: "catalog" };
  else if (!review) refusal = { kind: "catalog" };
  else if (dial === "lane" && context.families) {
    const missing = missingFamily(catalog, review, context.families);
    if (missing) refusal = { kind: "account", family: missing };
  }
  const previewable = review !== null && !(dial === "budget" && context.starter);
  return { selection: candidate, review: refusal === null && previewable ? review : null, refusal };
}
