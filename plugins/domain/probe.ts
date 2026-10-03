import { z } from "zod";
import { BenchmarkInputSchema, BenchmarkReceiptSchema, InventoryReceiptSchema, InventoryModelSchema, ModelCatalogSnapshotSchema,
  PROBE_MODEL_LIMIT, ProbeIdentitySchema, ProbeError, ThinkingLevelSchema, epochMilliseconds, identifier, parseBenchmarkInput, probeAddress,
  type BenchmarkInput, type BenchmarkReceipt, type InventoryReceipt, type ProbeIdentity, type ProbeRefusal } from "@atyrode/manifold-omp";
import { CatalogDocumentSchema, SelectionSchema, DomainError, admittedBy, type Selection, type CatalogDocument, type CatalogModel } from "./contracts.ts";
import { compileCatalog, validTierPair } from "./catalog.ts";
import { orderedFamilies, familyPolicy, providerPolicy } from "./providers.ts";

type InventoryModel = z.infer<typeof InventoryModelSchema>;
export const ScaffoldOptionsSchema = z.strictObject({
  /**
   * Identities a sanctioned quota classification marks as special: today OMP's bundled
   * `quotaTier`, joined by `quotaSpecials`. No usage IO here. A special draws its own quota, so
   * it is never an ordinary rung; one per family becomes tier 0 when it is cheaper than some
   * rung. Every special is an inventory identity, so the inventory bounds the list.
   */
  specials: z.array(ProbeIdentitySchema.extend({ facet: z.literal("spark") })).max(PROBE_MODEL_LIMIT),
  /**
   * WHAT THE LADDER MAY BE BUILT FROM, because a budget applied afterwards can be unsatisfiable
   * even when the observation could satisfy it.
   *
   * `reviewCatalog` admits models by price at selection time (#201), but the rungs are chosen
   * before it looks: `ladder` picks two to four rungs from every eligible candidate. A free model
   * therefore reaches the catalog only where it happens to win a rung, and on a real 256-model
   * listing exactly one did — so `budget: "free"` refused `budget_unsatisfiable` at every
   * capability while the same listing held 32 free models, four of which form a complete ladder.
   * The budget has to reach derivation to be answerable there.
   *
   * Defaulted to `any` so an existing derivation keeps deriving what it derived.
   */
  budget: SelectionSchema.shape.budget,
});
export type ScaffoldOptions = z.infer<typeof ScaffoldOptionsSchema>;
/**
 * WHY AN OFFERED MODEL IS NOT IN THE DERIVED CATALOG, said rather than left to its absence.
 *
 * `superseded`: a newer version of its family is used instead. `unstable_id`: a rolling alias,
 * preview or experiment, never probed or laddered. `not_found` and `client_blocked`: the
 * benchmark's own verdicts; a blocked model is the operator's to fix, so it is named, as the old
 * scaffold's warnings named it. `regression`: as a rung it would lose context or thinking against
 * a cheaper rung. A model that is merely not chosen (a third middle, a model priced above the
 * top) has no such reason and is not listed.
 */
export const ExclusionSchema = z.strictObject({
  provider: ProbeIdentitySchema.shape.provider, id: ProbeIdentitySchema.shape.id,
  reason: z.enum(["superseded", "unstable_id", "not_found", "client_blocked", "regression"]),
});
export type Exclusion = z.infer<typeof ExclusionSchema>;
const ExclusionsSchema = z.array(ExclusionSchema).max(PROBE_MODEL_LIMIT);
/**
 * WHAT AN INVENTORY OFFERS, BEFORE ANYTHING IS PAID FOR: the exact candidates one benchmark
 * request each would probe, and the ids excluded as unstable without being probed. There is no
 * catalog document here, because a ladder built from an unprobed inventory names models no
 * benchmark has shown this operator can call — the same gap the bundled starter had — and a
 * draft that carried one was a draft somebody could stage.
 */
export const CatalogDraftSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("draft"), inventoryObservedAt: epochMilliseconds,
  benchmark: BenchmarkInputSchema, exclusions: ExclusionsSchema,
});
export type CatalogDraft = z.infer<typeof CatalogDraftSchema>;
/** A benchmark-verified catalog, and the named reason each other offered model is absent from it. */
export const DerivedCatalogSchema = z.strictObject({ document: CatalogDocumentSchema, exclusions: ExclusionsSchema });
export type DerivedCatalog = z.infer<typeof DerivedCatalogSchema>;

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
 * worth carrying: `supersede` keys on the family name, and `:free` stays inside the id's last
 * name token, so `model:free` and `model` survive as separate families rather than one erasing
 * the other.
 *
 * A ROLLING ALIAS, PREVIEW OR EXPERIMENT IS NOT A RUNG EITHER. `gpt-daybreak-blue-latest` names
 * whatever generation its source snapshot pins and `deepseek-v4-flash-vision-exp` is an
 * experiment, yet on capability alone they took OpenAI tier 3 and DeepSeek tier 2 and led every
 * profile built on them. Excluded here, they are never benchmarked or paid for either.
 */
const unstable = /(?:^|-)(?:latest|preview|exp|experimental)(?:-|$)/;
function eligible(model: InventoryModel): boolean {
  return (!model.reasoning || model.thinkingLevels.length > 0) && !/-\d{6,8}$/.test(model.id) && !unstable.test(model.id);
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
/**
 * NEWEST VERSION PER FAMILY, WHATEVER ITS PRICE OR PROFILE. Providers keep listing what they
 * replaced, often repriced: `claude-opus-4-6` still lists at $5 beside `claude-opus-5`. Collapsing
 * only identical price/context/thinking profiles let that fossil survive and take Anthropic tier
 * 2 from `claude-sonnet-5`. The family is the policy family plus the id's name tokens, as old
 * Code's `supersede` had it. Callers filter reachability first, so a blocked newest falls back to
 * its callable predecessor instead of taking the family with it.
 */
function supersede(models: readonly InventoryModel[]): { kept: InventoryModel[]; superseded: InventoryModel[] } {
  const latest = new Map<string, InventoryModel>();
  for (const model of models) {
    const family = modelFamily(model.id);
    const key = JSON.stringify([providerPolicy(model.provider).family, family.name]);
    const old = latest.get(key);
    if (!old) { latest.set(key, model); continue; }
    const previous = modelFamily(old.id).version;
    let order = 0;
    for (let i = 0; i < Math.max(previous.length, family.version.length); i++) {
      order = (family.version[i] ?? -1) - (previous[i] ?? -1);
      if (order !== 0) break;
    }
    const providers = providerPolicy(model.provider).providers;
    if (order > 0 || (order === 0 && (providers.indexOf(model.provider) < providers.indexOf(old.provider) ||
      (model.provider === old.provider && compare(model.id, old.id) < 0)))) latest.set(key, model);
  }
  const kept = new Set(latest.values());
  return { kept: [...kept], superseded: models.filter(model => !kept.has(model)) };
}
type Ranked = { readonly model: InventoryModel; readonly price: number; readonly ceiling: number; readonly context: number; readonly address: string };
function ranked(model: InventoryModel): Ranked {
  let ceiling = -1;
  for (const level of model.thinkingLevels) ceiling = Math.max(ceiling, ThinkingLevelSchema.options.indexOf(level));
  return { model, price: model.inputCostPerMillion, ceiling, context: model.contextWindow ?? 0, address: probeAddress(model) };
}
/** Tier order. At one price the weaker model comes first: the only order in which two
 * equal-price rungs can pass `validTierPair`, and the order a free ladder climbs in. */
function tierOrder(a: Ranked, b: Ranked): number {
  return a.price - b.price || a.ceiling - b.ceiling || a.context - b.context || compare(a.address, b.address);
}
/** Capability: thinking ceiling, then context, then price. Price comes last because across
 * generations it lies; among otherwise identical specs it is the only remaining signal of size. */
function moreCapable(a: Ranked, b: Ranked): number {
  return b.ceiling - a.ceiling || b.context - a.context || b.price - a.price || compare(a.address, b.address);
}
/**
 * OLD CODE'S `pickLadder` (`0035b4f:generate_init.go:187-278`), NOT THE LONGEST VALID CHAIN.
 *
 * The bottom is the cheapest model and the top the most capable of the rest; up to two middles
 * are the most capable models priced strictly between them. Maximising the rung count instead let
 * four 272k-context OpenAI rows outvote the 1M-context GPT-5.6 family, because the context rule
 * cut every chain through the newer family to three rungs.
 *
 * One deliberate deviation: old Code took the middles by capability and then refused the file
 * when one regressed. Here a middle is taken only if every pair still passes `validTierPair`, and
 * the one passed over is returned as rejected. A top that regresses on the bottom is not repaired
 * by searching for a different top: the pair is returned, for the caller to refuse or drop.
 *
 * At one price the weaker model is the cheaper rung (`tierOrder`), and the middles the price gap
 * cannot supply come from candidates sharing an end's price, as old Code's median fallback did.
 * That is what lets a free ladder, every rung $0 (#201), progress at all. A twin of an end (same
 * price, ceiling and context) is never a middle.
 */
function ladder(models: readonly InventoryModel[]): { rungs: InventoryModel[]; rejected: InventoryModel[]; regression?: readonly [InventoryModel, InventoryModel] } {
  if (models.length === 0) return { rungs: [], rejected: [] };
  const ordered = models.map(ranked).sort(tierOrder);
  const bottom = ordered[0]!;
  let found: Ranked | undefined;
  for (const candidate of ordered.slice(1)) if (!found || moreCapable(candidate, found) < 0) found = candidate;
  if (!found) return { rungs: [bottom.model], rejected: [] };
  const top = found;
  if (!validTierPair(bottom.model, top.model)) return { rungs: [], rejected: [], regression: [bottom.model, top.model] };
  // Priced strictly inside the gap first; candidates sharing an end's price only fill what is left.
  const gap: Ranked[] = [], shared: Ranked[] = [];
  for (const candidate of ordered.slice(1)) {
    if (candidate === top || tierOrder(candidate, top) >= 0) continue;
    if (candidate.price > bottom.price && candidate.price < top.price) gap.push(candidate);
    else if (![bottom, top].some(end => end.price === candidate.price && end.ceiling === candidate.ceiling &&
      end.context === candidate.context)) shared.push(candidate);
  }
  const middles: Ranked[] = [], rejected: InventoryModel[] = [];
  for (const candidate of [...gap.sort(moreCapable), ...shared.sort(moreCapable)]) {
    if (middles.length === 2) break;
    const rungs = [bottom, ...middles, candidate, top].sort(tierOrder);
    if (rungs.every((lower, index) => rungs.slice(index + 1).every(higher => validTierPair(lower.model, higher.model)))) middles.push(candidate);
    else rejected.push(candidate.model);
  }
  return { rungs: [bottom, ...middles, top].sort(tierOrder).map(value => value.model), rejected };
}
/** The special facet a row's static quota class declares under its family's policy, if any. */
function specialFacet(row: { readonly provider: string; readonly quotaTier: string | null }): "spark" | undefined {
  return familyPolicy(providerPolicy(row.provider).family).special.find(value => value.facet === row.quotaTier)?.facet;
}
function exclusion(model: Pick<ProbeIdentity, "provider" | "id">, reason: Exclusion["reason"]): Exclusion {
  return { provider: model.provider, id: model.id, reason };
}
function scaffold(allowed: InventoryModel[], options: ScaffoldOptions, excluded: readonly Exclusion[],
  facts?: Map<string, BenchmarkReceipt["results"][number]>): DerivedCatalog {
  const models: CatalogModel[] = [];
  const exclusions = [...excluded];
  const specials = unique(options.specials);
  for (const special of options.specials) {
    if (!familyPolicy(providerPolicy(special.provider).family).special.some(value => value.facet === special.facet)) throw new ProbeError("invalid_input");
  }
  const facetOf = (model: InventoryModel): "spark" | undefined => {
    const special = specials.get(probeAddress(model));
    return special && special.api === model.api ? special.facet : undefined;
  };
  for (const family of orderedFamilies(allowed.map(model => providerPolicy(model.provider).family))) {
    const policy = familyPolicy(family);
    const members = allowed.filter(model => providerPolicy(model.provider).family === family);
    const ordinary = supersede(members.filter(model => facetOf(model) === undefined));
    const special = supersede(members.filter(model => facetOf(model) !== undefined));
    for (const model of [...ordinary.superseded, ...special.superseded]) exclusions.push(exclusion(model, "superseded"));
    const { rungs, rejected, regression } = ladder(ordinary.kept);
    for (const model of rejected) exclusions.push(exclusion(model, "regression"));
    if (regression) {
      const [lower, higher] = regression;
      // Named, because the fix is a decision about these two models (probe another, accept a
      // shorter family), never a different top chosen behind the operator's back.
      if (policy.requiredLadder) throw new DomainError("ladder_regression", `${family}: ${probeAddress(higher)} regresses on ${probeAddress(lower)}`);
      // An optional family is left out, with both ends named, rather than laddered on a top nobody chose.
      exclusions.push(exclusion(lower, "regression"), exclusion(higher, "regression"));
      continue;
    }
    if (policy.requiredLadder && rungs.length < 3) throw new ProbeError("insufficient_ladder");
    const add = (model: InventoryModel, tier: CatalogModel["tier"], quotaBucket: string | null): void => {
      const fact = facts?.get(probeAddress(model));
      models.push({ key: candidateKey(model), provider: model.provider, id: model.id, api: model.api, tier, quotaBucket,
        inputCostPerMillion: model.inputCostPerMillion, outputCostPerMillion: model.outputCostPerMillion,
        contextWindow: model.contextWindow, thinkingLevels: model.reasoning ? model.thinkingLevels : ["minimal"], images: model.images,
        tokensPerSecond: fact?.tokensPerSecond ?? null, timeToFirstTokenMs: fact?.timeToFirstTokenMs ?? null });
    };
    for (const declared of policy.special) {
      const choice = special.kept.filter(model => facetOf(model) === declared.facet).map(ranked)
        .sort((a, b) => a.price - b.price || moreCapable(a, b))[0];
      // An idle drain is cheap against the ladder it relieves; a special priced at or above
      // every rung is some other quota window, and it stays off the catalog.
      if (choice && rungs.some(model => model.inputCostPerMillion > choice.price)) add(choice.model, declared.tier, declared.bucket);
    }
    rungs.forEach((model, index) => add(model, (index + 1) as CatalogModel["tier"], policy.meteredProviders.includes(model.provider) ? policy.quotaBucketBase : null));
  }
  const document = parse(CatalogDocumentSchema, { schemaVersion: 1, models });
  try { compileCatalog(document); } catch { throw new ProbeError("insufficient_ladder"); }
  return { document, exclusions: exclusions.sort((a, b) => compare(probeAddress(a), probeAddress(b))) };
}
/** Requested specials are classifications of listed models, never models of their own. */
function requireListed(specials: ScaffoldOptions["specials"], models: readonly InventoryModel[]): void {
  const listed = unique(models);
  for (const special of specials) if (listed.get(probeAddress(special))?.api !== special.api) throw new ProbeError("invalid_input");
}

/**
 * THE QUOTA CLASSIFICATION AN INVENTORY DOES NOT CARRY YET. OMP's inventory rows have no
 * `quotaTier`, so Spark could never be derived from them, and both doors passed no specials at
 * all. OMP's bundled metadata does classify them, and it describes these identities only when it
 * is the same OMP version's metadata: another version's classification is not joined, and the
 * result is simply no special. The join is by exact provider, id and API, and keeps only classes
 * a family policy declares.
 */
export function quotaSpecials(inventoryValue: unknown, metadataValue: unknown): ScaffoldOptions["specials"] {
  if (metadataValue === undefined) return [];
  const inventory = parse(InventoryReceiptSchema, inventoryValue), metadata = parse(ModelCatalogSnapshotSchema, metadataValue);
  if (metadata.ompVersion !== inventory.ompVersion) return [];
  const listed = unique(inventory.models);
  return metadata.models.flatMap(row => {
    const facet = specialFacet(row);
    return facet && listed.get(probeAddress(row))?.api === row.api ? [{ provider: row.provider, id: row.id, api: row.api, facet }] : [];
  });
}
/** The providers whose bundled metadata `quotaSpecials` can use: those whose family declares a special. */
export function quotaProviders(inventory: InventoryReceipt): string[] {
  return [...new Set(inventory.models.map(model => model.provider))].filter(provider => providerPolicy(provider).special.length > 0).sort(compare);
}

/** Passive metadata is policy input, never inventory, reachability or measured performance.
 * Check the whole submitted identity set before narrowing it; silently choosing between
 * aliases would make the same response mean different policies to different callers. */
export function catalogFromMetadata(snapshotValue: unknown, budget: Selection["budget"]): CatalogDocument {
  const snapshot = parse(ModelCatalogSnapshotSchema, snapshotValue);
  if (budget === undefined) throw new ProbeError("invalid_input");
  const options = parse(ScaffoldOptionsSchema, { specials: [], budget }, "invalid_input");
  unique(snapshot.models);
  // A class the family declares as special (Spark) is its off-ladder tier 0; any other non-chat
  // class is some quota this policy does not know how to spend, and stays out.
  const allowed = snapshot.models.filter(model => (model.quotaTier === null || model.quotaTier === "chat" || specialFacet(model) !== undefined) &&
    eligible(model) && admittedBy(options.budget, model));
  // The transport bound is not the policy bound. Refuse before supersession and
  // the ladder's quadratic allocations, without truncating the candidate set.
  if (allowed.length > 256) throw new DomainError("starter_candidate_limit");
  const keys = new Set<string>();
  for (const model of allowed) {
    const key = candidateKey(model);
    if (keys.has(key)) throw new ProbeError("ambiguous_identity");
    keys.add(key);
  }
  const specials = allowed.flatMap(model => {
    const facet = specialFacet(model);
    return facet ? [{ provider: model.provider, id: model.id, api: model.api, facet }] : [];
  });
  return scaffold(allowed, { ...options, specials }, []).document;
}
/** Ids a budget admits that are never probed or laddered because they name no fixed model. */
function unstableExclusions(inventory: InventoryReceipt, budget: Selection["budget"]): Exclusion[] {
  return inventory.models.filter(model => admittedBy(budget, model) && unstable.test(model.id)).map(model => exclusion(model, "unstable_id"));
}
/**
 * The charge an inventory implies, never a catalog: the candidates a benchmark would probe under
 * this budget and the unstable ids it would not. No ladder is attempted, so an inventory whose
 * every-model-reachable ladder would regress still states what probing it costs; only the probed
 * answers decide whether a catalog exists.
 */
export function inventoryDraft(inventoryValue: unknown, budget: Selection["budget"]): CatalogDraft {
  const inventory = parse(InventoryReceiptSchema, inventoryValue);
  const options = parse(ScaffoldOptionsSchema, { specials: [], budget }, "invalid_input");
  return { schemaVersion: 1, kind: "draft", inventoryObservedAt: inventory.observedAt,
    benchmark: benchmarkCandidates(inventory, options),
    exclusions: unstableExclusions(inventory, options.budget).sort((a, b) => compare(probeAddress(a), probeAddress(b))) };
}
/** Every eligible candidate must have an exact probe, before superseding older versions. */
export function catalogFromObservations(inventoryValue: unknown, benchmarkValue: unknown, optionsValue: unknown = { specials: [], budget: "any" }): DerivedCatalog {
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
  requireListed(options.specials, inventory.models);
  const offered = inventory.models.filter(model => eligible(model) && admittedBy(options.budget, model));
  const refused: Exclusion[] = [];
  for (const model of offered) {
    const status = facts.get(probeAddress(model))!.status;
    if (status === "not_found" || status === "client_blocked") refused.push(exclusion(model, status));
  }
  return scaffold(offered.filter(model => facts.get(probeAddress(model))!.status === "reachable"), options,
    [...unstableExclusions(inventory, options.budget), ...refused], facts);
}
