import {
  CatalogDocumentSchema, DomainError, ThinkingLevelSchema,
  type CatalogDocument, type CatalogModel, type ThinkingLevel,
} from "./contracts.ts";
import { familyOrder, familyPolicy, providerPolicy } from "./providers.ts";

type Model = Readonly<Omit<CatalogModel, "thinkingLevels">> & { readonly thinkingLevels: readonly ThinkingLevel[] };
type Ladder = readonly (string | undefined)[];

/** Owned snapshots and private indexes prevent a caller mutating a reviewed catalog. */
export class CompiledCatalog {
  readonly models: readonly Model[];
  readonly families: readonly string[];
  readonly #models: ReadonlyMap<string, Model>;
  readonly #ladders: ReadonlyMap<string, Ladder>;

  constructor(document: CatalogDocument) {
    const parsed = CatalogDocumentSchema.safeParse(document);
    if (!parsed.success) throw new DomainError("invalid_catalog");
    const models = new Map<string, Model>();
    const ladders = new Map<string, (string | undefined)[]>();
    const identities = new Set<string>();
    for (const model of parsed.data.models) {
      const policy = providerPolicy(model.provider);
      // OMP addresses provider/id, so two API declarations for that address are ambiguous.
      const identity = `${model.provider}/${model.id}`;
      if (!policy || models.has(model.key) || identities.has(identity) ||
          (model.tier === 0 && !policy.special.some(special => special.tier === model.tier))) {
        throw new DomainError("invalid_catalog");
      }
      identities.add(identity);
      const ladder = ladders.get(policy.family) ?? new Array<string | undefined>(5);
      if (ladder[model.tier] !== undefined) throw new DomainError("invalid_catalog");
      ladder[model.tier] = model.key;
      ladders.set(policy.family, ladder);
      const thinkingLevels = [...new Set(model.thinkingLevels)]
        .sort((a, b) => ThinkingLevelSchema.options.indexOf(a) - ThinkingLevelSchema.options.indexOf(b));
      models.set(model.key, Object.freeze({ ...model, thinkingLevels: Object.freeze(thinkingLevels) }));
    }
    for (const [family, ladder] of ladders) {
      const policy = familyPolicy(family)!;
      if (policy.requiredLadder) {
        if ([1, 2, 3].some(tier => ladder[tier] === undefined)) throw new DomainError("invalid_catalog");
      } else {
        // Borrow only from declared rungs, not an earlier synthetic fill. Ties prefer lower tiers.
        const declared = [1, 2, 3, 4].filter(tier => ladder[tier] !== undefined);
        if (declared.length === 0) throw new DomainError("invalid_catalog");
        for (const tier of [1, 2, 3]) {
          if (ladder[tier] !== undefined) continue;
          const nearest = declared.reduce((best, candidate) =>
            Math.abs(candidate - tier) < Math.abs(best - tier) ? candidate : best);
          ladder[tier] = ladder[nearest];
        }
      }
      for (let lower = 1; lower < 4; lower++) {
        for (let higher = lower + 1; higher <= 4; higher++) {
          const loKey = ladder[lower], hiKey = ladder[higher];
          if (!loKey || !hiKey) continue;
          const lo = models.get(loKey)!, hi = models.get(hiKey)!;
          if (hi.inputCostPerMillion < lo.inputCostPerMillion) continue;
          if ((lo.contextWindow !== null && hi.contextWindow !== null && hi.contextWindow < lo.contextWindow) ||
              ThinkingLevelSchema.options.indexOf(hi.thinkingLevels[hi.thinkingLevels.length - 1]!) <
              ThinkingLevelSchema.options.indexOf(lo.thinkingLevels[lo.thinkingLevels.length - 1]!)) {
            throw new DomainError("invalid_catalog");
          }
        }
      }
      Object.freeze(ladder);
    }
    this.#models = models;
    this.#ladders = ladders;
    this.models = Object.freeze([...models.values()]);
    this.families = Object.freeze(familyOrder.filter(family => ladders.has(family)));
    Object.freeze(this);
  }

  model(key: string): Model {
    const model = this.#models.get(key);
    if (!model) throw new DomainError("invalid_selection");
    return model;
  }

  family(key: string): string {
    return providerPolicy(this.model(key).provider)!.family;
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

  special(facet: "spark"): string | undefined {
    for (const family of this.families) {
      const special = familyPolicy(family)!.special.find(value => value.facet === facet);
      if (special) return this.#ladders.get(family)?.[special.tier];
    }
    return undefined;
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
