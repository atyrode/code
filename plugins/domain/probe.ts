import { z } from "zod";
import { BenchmarkInputSchema, BenchmarkReceiptSchema, InventoryReceiptSchema, InventoryModelSchema,
  ProbeIdentitySchema, ProbeError, ThinkingLevelSchema, epochMilliseconds, identifier, parseBenchmarkInput, probeAddress,
  type BenchmarkInput, type BenchmarkReceipt, type ProbeIdentity, type ProbeRefusal } from "@atyrode/manifold-omp";
import { CatalogDocumentSchema, SelectionSchema, admittedBy, type CatalogDocument, type CatalogModel } from "./contracts.ts";
import { compileCatalog, validTierPair } from "./catalog.ts";
import { orderedFamilies, familyPolicy, providerPolicy } from "./providers.ts";

type InventoryModel = z.infer<typeof InventoryModelSchema>;
export const ScaffoldOptionsSchema = z.strictObject({
  // A sanctioned quota observation may identify a special model. No usage IO here.
  specials: z.array(ProbeIdentitySchema.extend({ facet: z.literal("spark") })).max(3),
  /**
   * WHAT THE LADDER MAY BE BUILT FROM, because a budget applied afterwards can be unsatisfiable
   * even when the observation could satisfy it.
   *
   * `reviewCatalog` admits models by price at selection time (#201), but the rungs are chosen
   * before it looks: `ladder` sorts every eligible candidate by price and keeps the two-to-four
   * that carry separating evidence. A free model therefore reaches the catalog only where it
   * happens to win a rung, and on a real 256-model listing exactly one did — so `budget: "free"`
   * refused `budget_unsatisfiable` at every capability while the same listing held 32 free
   * models, four of which form a complete ladder. The budget has to reach derivation to be
   * answerable there.
   *
   * Defaulted to `any` so an existing derivation keeps deriving what it derived.
   */
  budget: SelectionSchema.shape.budget,
});
export type ScaffoldOptions = z.infer<typeof ScaffoldOptionsSchema>;
export const CatalogDraftSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("draft"), inventoryObservedAt: epochMilliseconds,
  document: CatalogDocumentSchema, benchmark: BenchmarkInputSchema,
});
export type CatalogDraft = z.infer<typeof CatalogDraftSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown, code: ProbeRefusal = "invalid_observation"): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProbeError(code);
  return result.data;
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function unique<T extends ProbeIdentity>(models: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  const folded = new Set<string>();
  for (const model of models) {
    const address = probeAddress(model);
    // OMP resolution folds case; case-only variants and API aliases are ambiguous.
    if (folded.has(address.toLowerCase())) throw new ProbeError("ambiguous_identity");
    folded.add(address.toLowerCase()); out.set(address, model);
  }
  return out;
}


/**
 * A DATED SNAPSHOT AND A MISSING THINKING LADDER ARE DISQUALIFYING. A VARIANT SUFFIX IS NOT.
 *
 * This test used to read `model.inputCostPerMillion > 0`, which excluded free models on purpose.
 * #194 removed that clause and kept `!model.id.includes(":")`, which excludes the same models by
 * spelling: every OpenRouter free model is addressed `vendor/model:free`, and the colon is how
 * that provider spells a routing variant. So the exclusion survived its own retirement, no
 * longer saying what it did — and #201's `budget: "free"` then became a dial no catalog could
 * satisfy, because the only models that could satisfy it were filtered out before selection saw
 * them. On a live listing of 256 models the clause discarded 77, including all 32 free ones.
 *
 * A variant is a distinct routable identity with its own price, which is precisely why it is
 * worth carrying: `supersede` already keys on the observed price profile, so `model:free` and
 * `model` survive as separate candidates rather than one erasing the other.
 */
function eligible(model: InventoryModel): boolean {
  return (!model.reasoning || model.thinkingLevels.length > 0) && !/-\d{6,8}$/.test(model.id);
}
function candidateKey(model: InventoryModel): string {
  // Full exact identities remain separate fields. A stable index-free safe key.
  //
  // Escaped rather than folded, because folding is not injective: the identifier alphabet
  // excludes both `/` and `:`, so `vendor/model`, `vendor:model` and `vendor-model` all fold to
  // one key. Two admitted models sharing a key are rejected by `compileCatalog` as a duplicate,
  // which `scaffold` reports as `insufficient_ladder` — a refusal naming the wrong cause. Now
  // that variant ids are admitted, that collision is reachable from a real listing.
  const address = `${model.provider}.${model.id}`;
  // Non-ASCII would make a fixed-width escape ambiguous, and no provider spells an id this way.
  if (!/^[\x20-\x7E]*$/.test(address)) throw new ProbeError("invalid_observation");
  const key = [...address].map(character => character === "_" ? "__"
    : /[A-Za-z0-9._-]/.test(character) ? character
    : `_${character.codePointAt(0)!.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  return parse(identifier, key, "invalid_input");
}
/**
 * The candidate set a benchmark would probe, which is also what a derived catalog may ladder.
 *
 * The budget narrows it here rather than after the ladder, so deriving for `free` also probes
 * only what `free` can use: on the live listing that is 32 identities instead of 179, which is
 * the difference between a benchmark worth pricing and one worth stopping.
 */
export function benchmarkCandidates(inventoryValue: unknown, optionsValue: unknown = { specials: [], budget: "any" }): BenchmarkInput {
  const inventory = parse(InventoryReceiptSchema, inventoryValue);
  const options = parse(ScaffoldOptionsSchema, optionsValue, "invalid_input");
  unique(inventory.models);
  return parseBenchmarkInput({ schemaVersion: 1, inventoryObservedAt: inventory.observedAt, ompVersion: inventory.ompVersion,
    candidates: inventory.models.filter(model => eligible(model) && admittedBy(options.budget, model)).sort((a, b) => compare(probeAddress(a), probeAddress(b)))
      .map(model => ({ provider: model.provider, id: model.id, api: model.api, key: candidateKey(model) })) });
}
function modelFamily(id: string): { name: string; version: number[] } {
  const name: string[] = [], version: number[] = [];
  for (const token of id.split("-")) {
    if (/^\d+(?:\.\d+)*$/.test(token)) {
      const numbers = token.split(".").map(Number);
      if (numbers.some(value => !Number.isSafeInteger(value))) throw new ProbeError("invalid_observation");
      version.push(...numbers);
    } else name.push(token.toLowerCase());
  }
  return { name: name.join("-"), version };
}
function supersede(models: InventoryModel[]): InventoryModel[] {
  const latest = new Map<string, InventoryModel>();
  for (const model of models) {
    const family = modelFamily(model.id);
    // Version spelling alone cannot erase a distinct observed capability/price profile.
    // All identities remain in the inventory and benchmark, including equivalent versions.
    const profile = JSON.stringify([family.name, model.inputCostPerMillion, model.outputCostPerMillion,
      model.contextWindow, model.maxTokens, model.images, [...new Set(model.thinkingLevels)].sort(compare)]);
    const old = latest.get(profile);
    if (!old) { latest.set(profile, model); continue; }
    const previous = modelFamily(old.id).version;
    let order = 0;
    for (let i = 0; i < Math.max(previous.length, family.version.length); i++) {
      order = (family.version[i] ?? -1) - (previous[i] ?? -1);
      if (order !== 0) break;
    }
    const providers = providerPolicy(model.provider).providers;
    if (order > 0 || (order === 0 && (providers.indexOf(model.provider) < providers.indexOf(old.provider) ||
      (model.provider === old.provider && compare(model.id, old.id) < 0)))) latest.set(profile, model);
  }
  return [...latest.values()];
}
function ladder(models: InventoryModel[]): InventoryModel[] {
  if (models.length === 0) return [];
  const ordered = models.map(model => {
    let ceiling = -1;
    for (const level of model.thinkingLevels) ceiling = Math.max(ceiling, ThinkingLevelSchema.options.indexOf(level));
    return { model, ceiling, context: model.contextWindow ?? 0, address: probeAddress(model), strength: 0 };
  }).sort((a, b) => a.model.inputCostPerMillion - b.model.inputCostPerMillion || a.ceiling - b.ceiling ||
    a.context - b.context || compare(a.address, b.address));
  // Equal-price evidence orders weak -> strong, independently of selection preference.
  const ranked = [...ordered].sort((a, b) => b.ceiling - a.ceiling || b.context - a.context ||
    b.model.inputCostPerMillion - a.model.inputCostPerMillion || compare(a.address, b.address));
  for (let index = 0; index < ranked.length; index++) ranked[index]!.strength = index;
  const cheaper = (a: number, b: number): number => ordered[a]!.model.inputCostPerMillion - ordered[b]!.model.inputCostPerMillion ||
    ordered[a]!.strength - ordered[b]!.strength;
  const size = ordered.length, width = size + 1;
  const edges = new Uint8Array(size * size);
  for (let lower = 0; lower < size; lower++) {
    for (let higher = lower + 1; higher < size; higher++) {
      edges[lower * size + higher] = Number(validTierPair(ordered[lower]!.model, ordered[higher]!.model));
    }
  }

  // A prefix is identified by its last model and last non-null context (0 = none).
  // Adjacent thinking ceilings are transitive; nullable contexts are not. Keeping
  // the last known context makes an extension compatible with every earlier rung.
  // For each state, retain only the preferred two- and three-rung prefixes.
  const firstOfTwo = new Int16Array(size * width).fill(-1);
  const firstOfThree = new Int16Array(size * width).fill(-1);
  const middleOfThree = new Int16Array(size * width).fill(-1);
  let bestLength = 1, bestFirst = 0, bestMiddle = -1, bestUpper = -1, bestTop = 0;
  for (let index = 1; index < size; index++) {
    if (cheaper(index, bestFirst) < 0) bestFirst = bestTop = index;
  }
  const consider = (length: number, first: number, middle: number, upper: number, top: number): void => {
    if (length < bestLength) return;
    if (length === bestLength) {
      let preference = cheaper(first, bestFirst) || ordered[top]!.strength - ordered[bestTop]!.strength;
      if (preference === 0 && length === 3) preference = ordered[middle]!.strength - ordered[bestMiddle]!.strength;
      if (preference === 0 && length === 4) {
        const a = ordered[middle]!.strength, b = ordered[upper]!.strength;
        const oldA = ordered[bestMiddle]!.strength, oldB = ordered[bestUpper]!.strength;
        preference = Math.min(a, b) - Math.min(oldA, oldB) || Math.max(a, b) - Math.max(oldA, oldB);
      }
      if (preference >= 0) return;
    }
    bestLength = length;
    bestFirst = first;
    bestMiddle = middle;
    bestUpper = upper;
    bestTop = top;
  };

  // O(n²) evidence checks and storage, O(n³) cached-edge state transitions.
  // A state's preferred prefix remains preferred under any common extension:
  // cheapest start first, then strongest intermediates; the top is shared.
  for (let top = 1; top < size; top++) {
    const topKnown = ordered[top]!.model.contextWindow !== null;
    for (let lower = 0; lower < top; lower++) {
      if (!edges[lower * size + top]) continue;
      consider(2, lower, -1, -1, top);
      const lowerKnown = ordered[lower]!.model.contextWindow !== null;
      const pairState = top * width + (topKnown ? top + 1 : lowerKnown ? lower + 1 : 0);
      const oldFirst = firstOfTwo[pairState]!;
      if (oldFirst < 0 || cheaper(lower, oldFirst) < 0) firstOfTwo[pairState] = lower;
      for (let known = lowerKnown ? lower + 1 : 0; known <= (lowerKnown ? lower + 1 : lower); known++) {
        const state = lower * width + known;
        const firstTwo = firstOfTwo[state]!, firstThree = firstOfThree[state]!;
        if (firstTwo < 0 && firstThree < 0) continue;
        if (known > 0 && !edges[(known - 1) * size + top]) continue;
        if (firstThree >= 0) consider(4, firstThree, middleOfThree[state]!, lower, top);
        if (firstTwo < 0) continue;
        consider(3, firstTwo, lower, -1, top);
        const next = top * width + (topKnown ? top + 1 : known);
        const previous = firstOfThree[next]!;
        const preference = previous < 0 ? -1 : cheaper(firstTwo, previous) ||
          ordered[lower]!.strength - ordered[middleOfThree[next]!]!.strength;
        if (preference < 0) {
          firstOfThree[next] = firstTwo;
          middleOfThree[next] = lower;
        }
      }
    }
  }
  const result = [ordered[bestFirst]!.model];
  if (bestLength >= 3) result.push(ordered[bestMiddle]!.model);
  if (bestLength === 4) result.push(ordered[bestUpper]!.model);
  if (bestLength >= 2) result.push(ordered[bestTop]!.model);
  return result;
}
function scaffold(allowed: InventoryModel[], options: ScaffoldOptions, facts?: Map<string, BenchmarkReceipt["results"][number]>): CatalogDocument {
  const models: CatalogModel[] = [];
  unique(options.specials);
  for (const family of orderedFamilies(allowed.map(model => providerPolicy(model.provider).family))) {
    const policy = familyPolicy(family);
    const candidates = supersede(allowed.filter(model => providerPolicy(model.provider).family === family));
    const specialChoices = options.specials.filter(special => providerPolicy(special.provider).family === family);
    if (specialChoices.length > 1) throw new ProbeError("ambiguous_identity");
    const requested = specialChoices[0];
    if (!candidates.length && !requested) continue;
    const special = requested && candidates.find(model => probeAddress(model) === probeAddress(requested) && model.api === requested.api);
    if (requested && (!special || !policy.special.some(value => value.facet === requested.facet) || !candidates.some(model => model.inputCostPerMillion > special.inputCostPerMillion))) throw new ProbeError("invalid_input");
    const rungs = ladder(candidates.filter(model => model !== special));
    if (policy.requiredLadder && rungs.length < 3) throw new ProbeError("insufficient_ladder");
    const add = (model: InventoryModel, tier: CatalogModel["tier"], quotaBucket: string | null): void => {
      const fact = facts?.get(probeAddress(model));
      models.push({ key: candidateKey(model), provider: model.provider, id: model.id, api: model.api, tier, quotaBucket,
        inputCostPerMillion: model.inputCostPerMillion, outputCostPerMillion: model.outputCostPerMillion,
        contextWindow: model.contextWindow, thinkingLevels: model.reasoning ? model.thinkingLevels : ["minimal"], images: model.images,
        tokensPerSecond: fact?.tokensPerSecond ?? null, timeToFirstTokenMs: fact?.timeToFirstTokenMs ?? null });
    };
    if (special) add(special, 0, policy.special.find(value => value.facet === requested!.facet)!.bucket);
    rungs.forEach((model, index) => add(model, (index + 1) as CatalogModel["tier"], policy.meteredProviders.includes(model.provider) ? policy.quotaBucketBase : null));
  }
  const document = parse(CatalogDocumentSchema, { schemaVersion: 1, models });
  try { compileCatalog(document); } catch { throw new ProbeError("insufficient_ladder"); }
  return document;
}
/** Offline choices are a draft, never an inventory job and never a reachability claim. */
export function scaffoldInventory(inventoryValue: unknown, optionsValue: unknown = { specials: [], budget: "any" }): CatalogDraft {
  const inventory = parse(InventoryReceiptSchema, inventoryValue), options = parse(ScaffoldOptionsSchema, optionsValue, "invalid_input");
  const benchmark = benchmarkCandidates(inventory, options);
  return { schemaVersion: 1, kind: "draft", inventoryObservedAt: inventory.observedAt,
    document: scaffold(inventory.models.filter(model => eligible(model) && admittedBy(options.budget, model)), options), benchmark };
}
/** Every eligible candidate must have an exact probe, before superseding older versions. */
export function catalogFromObservations(inventoryValue: unknown, benchmarkValue: unknown, optionsValue: unknown = { specials: [], budget: "any" }): CatalogDocument {
  const inventory = parse(InventoryReceiptSchema, inventoryValue), benchmark = parse(BenchmarkReceiptSchema, benchmarkValue);
  const options = parse(ScaffoldOptionsSchema, optionsValue, "invalid_input");
  const candidates = benchmarkCandidates(inventory, options).candidates;
  if (benchmark.inventoryObservedAt !== inventory.observedAt) throw new ProbeError("missing_probe");
  const facts = unique(benchmark.results);
  if (facts.size !== candidates.length) throw new ProbeError("missing_probe");
  for (const candidate of candidates) {
    const fact = facts.get(probeAddress(candidate));
    if (!fact || fact.api !== candidate.api || fact.key !== candidate.key) throw new ProbeError("missing_probe");
    if (fact.status === "unmatched" || fact.status === "unresolved") throw new ProbeError("inconclusive_probe");
  }
  return scaffold(inventory.models.filter(model => eligible(model) && admittedBy(options.budget, model) && facts.get(probeAddress(model))?.status === "reachable"), options, facts);
}
