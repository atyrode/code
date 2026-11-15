import { ThinkingLevelSchema, type ThinkingLevel } from "@atyrode/manifold-omp";
import { CatalogDocumentSchema, DomainError, type CatalogDocument, type CatalogModel } from "./contracts.ts";
import { familyPolicy, orderedFamilies, providerPolicy, tierWord } from "./providers.ts";

type Model = Readonly<Omit<CatalogModel, "thinkingLevels">> & { readonly thinkingLevels: readonly ThinkingLevel[] };
type Ladder = readonly (string | undefined)[];
type TierCandidate = Pick<Model, "inputCostPerMillion" | "thinkingLevels">;

/**
 * Whether `higher` may sit on a higher tier than `lower`: unless it is the cheaper of the two, it
 * must reach every thinking level `lower` does, so a role a higher tier takes over never has to
 * think less. A context window is not a capability and never refuses a tier: OpenAI's sol and
 * astra carry smaller windows than the older terra beneath them.
 */
export function validTierPair(lower: TierCandidate, higher: TierCandidate): boolean {
  if (higher.inputCostPerMillion < lower.inputCostPerMillion) return true;
  let ceiling = -1;
  for (const level of higher.thinkingLevels) ceiling = Math.max(ceiling, ThinkingLevelSchema.options.indexOf(level));
  for (const level of lower.thinkingLevels) if (ThinkingLevelSchema.options.indexOf(level) > ceiling) return false;
  return true;
}

/**
 * Fill a family's missing tiers 1 to 3 from its nearest declared rung, lower on a tie, borrowing
 * only from declared rungs, never an earlier fill. Whether any tier was filled.
 */
function fill(ladder: (string | undefined)[]): boolean {
  const declared = [1, 2, 3, 4].filter(tier => ladder[tier] !== undefined);
  if (declared.length === 0) throw new DomainError("invalid_catalog");
  let filled = false;
  for (const tier of [1, 2, 3]) {
    if (ladder[tier] !== undefined) continue;
    const nearest = declared.reduce((best, candidate) =>
      Math.abs(candidate - tier) < Math.abs(best - tier) ? candidate : best);
    ladder[tier] = ladder[nearest];
    filled = true;
  }
  return filled;
}

/**
 * Owned snapshots and private indexes prevent a caller mutating a reviewed catalog.
 *
 * THE EFFECTIVE TIER, NOT THE STORED ONE. A model whose id carries one of its family's own tier
 * names (`ProviderPolicy.tierNames`, matched by `tierWord` exactly as the probe ladders) is read at
 * that name's tier; any other model keeps the tier its document gives it. A catalog stored before
 * its family was laddered by those names, a sparse Anthropic one laddered by price, so keeps its
 * raw document, digest and provenance untouched and is still read at actual tiers. The stored tier
 * and the ladder it built are kept privately, only to refuse a selector whose model that reading
 * would silently change (`assertUnambiguousSelection`).
 */
export class CompiledCatalog {
  readonly models: readonly Model[];
  readonly families: readonly string[];
  /**
   * The families Code requires (`requiredLadder`) that lack a rung of their own at tier 1, 2 or 3,
   * in family order. Such a family is filled like any other, so its missing tiers route to its
   * nearest real rung; this says so, where the ladder alone would only show the gap.
   */
  readonly short: readonly string[];
  readonly #models: ReadonlyMap<string, Model>;
  readonly #ladders: ReadonlyMap<string, Ladder>;
  /** Each family's ladder as its document's own tiers built it, filled alike. */
  readonly #stored: ReadonlyMap<string, Ladder>;
  /** Each model's tier as its document gives it. */
  readonly #storedTiers: ReadonlyMap<string, number>;

  constructor(document: CatalogDocument) {
    const parsed = CatalogDocumentSchema.safeParse(document);
    if (!parsed.success) throw new DomainError("invalid_catalog");
    const models = new Map<string, Model>();
    const storedTiers = new Map<string, number>();
    const stored = new Map<string, (string | undefined)[]>();
    const identities = new Set<string>();
    for (const model of parsed.data.models) {
      // Tier 0 was Spark's own rung, which is retired: a stored catalog that still lists it keeps
      // parsing, and the model is simply never placed or routed.
      if (model.tier === 0) continue;
      const policy = providerPolicy(model.provider);
      // OMP addresses provider/id, so two API declarations for that address are ambiguous.
      const identity = `${model.provider}/${model.id}`;
      if (models.has(model.key) || identities.has(identity)) throw new DomainError("invalid_catalog");
      identities.add(identity);
      const ladder = stored.get(policy.family) ?? new Array<string | undefined>(5);
      if (ladder[model.tier] !== undefined) throw new DomainError("invalid_catalog");
      ladder[model.tier] = model.key;
      stored.set(policy.family, ladder);
      const named = policy.tierNames?.indexOf(tierWord(model.id)) ?? -1;
      const thinkingLevels = [...new Set(model.thinkingLevels)]
        .sort((a, b) => ThinkingLevelSchema.options.indexOf(a) - ThinkingLevelSchema.options.indexOf(b));
      storedTiers.set(model.key, model.tier);
      models.set(model.key, Object.freeze({ ...model, tier: named < 0 ? model.tier : (named + 1) as CatalogModel["tier"],
        thinkingLevels: Object.freeze(thinkingLevels) }));
    }
    const ladders = new Map<string, Ladder>();
    const short = new Set<string>();
    for (const [family, original] of stored) {
      // Two stored rungs read at one tier (two versions of one name, or a named model moved onto an
      // unnamed one's rung) both stay listed. The rung goes to the model whose tier did not move,
      // else to the higher stored rung, whatever the document's order; a selector that named the
      // other is refused, not silently given this one (`assertUnambiguousSelection`).
      const ladder = new Array<string | undefined>(5);
      for (const key of original) {
        if (key === undefined) continue;
        const tier = models.get(key)!.tier, held = ladder[tier];
        if (held === undefined || storedTiers.get(held) !== tier) ladder[tier] = key;
      }
      // A family Code requires fills like any other. The accounts may reach only part of it, a
      // plan serving two GPT tiers for one, and its nearest real rung is a profile where refusing
      // the whole catalog left none.
      if (fill(ladder) && familyPolicy(family).requiredLadder) short.add(family);
      fill(original);
      for (let lower = 1; lower < 4; lower++) {
        for (let higher = lower + 1; higher <= 4; higher++) {
          const loKey = ladder[lower], hiKey = ladder[higher];
          if (!loKey || !hiKey) continue;
          const lo = models.get(loKey)!, hi = models.get(hiKey)!;
          if (!validTierPair(lo, hi)) throw new DomainError("invalid_catalog");
        }
      }
      Object.freeze(original);
      ladders.set(family, Object.freeze(ladder));
    }
    this.#models = models;
    this.#ladders = ladders;
    this.#stored = stored;
    this.#storedTiers = storedTiers;
    this.models = Object.freeze([...models.values()]);
    this.families = orderedFamilies(ladders.keys());
    this.short = orderedFamilies(short);
    Object.freeze(this);
  }

  model(key: string): Model {
    const model = this.#models.get(key);
    if (!model) throw new DomainError("invalid_selection");
    return model;
  }

  family(key: string): string {
    return providerPolicy(this.model(key).provider).family;
  }

  top(family: string): number {
    const ladder = this.#ladders.get(family);
    if (!ladder) return 0;
    return ladder[4] === undefined ? 3 : 4;
  }

  rung(family: string, tier: number): string {
    const key = this.#ladders.get(family)?.[Math.max(1, Math.min(this.top(family), tier))];
    if (!key) throw new DomainError("invalid_selection");
    return key;
  }

  /** Whether a model is read at a tier other than the one its document stores. */
  isReclassified(key: string): boolean {
    return this.#storedTiers.get(key) !== this.model(key).tier;
  }

  /**
   * Refuse (`invalid_selection`) a family and capability whose rung the stored tiers gave to one
   * model and the effective tiers give to another: Opus stored at 2 over Haiku at 1 is read at 3,
   * so a capability 2 that meant Opus would now mean Haiku; Sonnet stored at 4 over Opus at 3 is
   * read at 2, so a capability 2 that meant Opus would now mean Sonnet. Neither model is chosen for
   * the caller; the tier each now holds still resolves it explicitly. A rung that keeps its model
   * is never refused, and where no model of the family moved, none changes. A capability above the
   * stored ladder's top named no model before, so a new actual tier (Fable read at 4) is never refused.
   */
  assertUnambiguousSelection(family: string, capability: number): void {
    const original = this.#stored.get(family);
    if (!original || capability > (original[4] === undefined ? 3 : 4)) return;
    const before = original[Math.max(1, capability)];
    if (before !== undefined && before !== this.rung(family, capability)) throw new DomainError("invalid_selection");
  }

  clampThinking(key: string, requested: ThinkingLevel): ThinkingLevel {
    const levels = this.model(key).thinkingLevels;
    const ceiling = ThinkingLevelSchema.options.indexOf(requested);
    let best = levels[0]!;
    for (const level of levels) {
      if (ThinkingLevelSchema.options.indexOf(level) <= ceiling) best = level;
    }
    return best;
  }
}

export function compileCatalog(document: CatalogDocument): CompiledCatalog {
  return new CompiledCatalog(document);
}
