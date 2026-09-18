import { describe, expect, test } from "bun:test";
import { compileCatalog } from "./catalog.ts";
import { type CatalogDocument, type CatalogModel, type Route, type Selection } from "./contracts.ts";
import { familyPolicy, providerPolicy } from "./providers.ts";
import { compileOmpOverlay, defaultSelection, reviewCatalog, ReviewSchema } from "./routing.ts";

function model(key: string, provider: string, tier: CatalogModel["tier"], changes: Partial<CatalogModel> = {}): CatalogModel {
  return {
    key, provider, tier, id: `native-${key}`, api: "test-api", quotaBucket: null,
    inputCostPerMillion: 4, outputCostPerMillion: 12, tokensPerSecond: 30, timeToFirstTokenMs: 100,
    contextWindow: 200_000, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], images: true,
    ...changes,
  };
}

function document(): CatalogDocument {
  return { schemaVersion: 1, models: [
    model("o1", "openai", 1), model("o2", "openai-codex", 2), model("o3", "openai", 3),
    model("a1", "anthropic", 1), model("a2", "anthropic", 2), model("a3", "anthropic", 3),
    model("a4", "anthropic", 4), model("spark", "openai-codex", 0, { images: false }),
    model("d2", "deepseek", 2, { images: false, inputCostPerMillion: 5, outputCostPerMillion: 15 }),
  ] };
}

function route(routes: readonly Route[], role: string): Route {
  const value = routes.find(candidate => candidate.role === role);
  if (!value) throw new Error(`Missing required role ${role}`);
  return value;
}

function selection(changes: Partial<Selection> = {}): Selection {
  return {
    lane: { kind: "mixed" }, capability: 2, thinking: "medium", advisor: "off", spark: false,
    priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any", ...changes,
  };
}

const daytime = Date.UTC(2026, 0, 1, 12);

describe("catalog capabilities and identity", () => {
  test("explicit provider policies coexist with isolated generic provider families", () => {
    expect(providerPolicy("openai").family).toBe("openai");
    expect(providerPolicy("openai-codex").family).toBe("openai");
    expect(familyPolicy("openai").providers).toEqual(["openai-codex", "openai"]);
    expect(providerPolicy("vendor-example")).toMatchObject({
      family: "vendor-example", providers: ["vendor-example"], requiredLadder: false, crossTo: null,
    });
    const generic = compileCatalog({ schemaVersion: 1, models: [
      model("future", "vendor-example", 1, {
        id: "free-model", inputCostPerMillion: 0, outputCostPerMillion: 0, thinkingLevels: ["minimal"],
      }),
    ] });
    const review = reviewCatalog(generic, defaultSelection(generic), daytime);
    expect(generic.families).toEqual(["vendor-example"]);
    expect(review.available.lanes).toEqual([{ kind: "provider", family: "vendor-example", blend: "only" }]);
    expect(review.routes.every(value => value.lead.key === "future" && value.lead.thinking === "minimal" && value.fallback.length === 0)).toBe(true);
    expect(compileOmpOverlay(generic, review.selection, review.routes).modelRoles?.default)
      .toBe("vendor-example/free-model:minimal");
  });

  test("absent required families do not block a complete single-family catalog", () => {
    const single = document();
    single.models = single.models.filter(value => value.provider === "anthropic");
    const catalog = compileCatalog(single);
    const review = reviewCatalog(catalog, defaultSelection(catalog), daytime);
    expect(review.available.lanes).toEqual([{ kind: "provider", family: "anthropic", blend: "only" }]);
    expect(review.routes.every(value => catalog.family(value.lead.key) === "anthropic")).toBe(true);
    expect(() => reviewCatalog(catalog, selection(), daytime)).toThrow("code_invalid_selection");
    single.models = single.models.filter(value => value.tier !== 2);
    expect(() => compileCatalog(single)).toThrow("code_invalid_catalog");
  });

  test("optional missing rungs borrow the nearest declared rung, with lower ties", () => {
    const input = document();
    input.models = input.models.filter(value => value.provider !== "deepseek");
    input.models.push(model("d1", "deepseek", 1), model("d3", "deepseek", 3));
    const catalog = compileCatalog(input);
    const review = reviewCatalog(catalog, selection({ lane: { kind: "provider", family: "deepseek", blend: "only" } }), daytime);
    expect(route(review.routes, "default").lead.key).toBe("d1");
    expect(route(review.routes, "plan").lead.key).toBe("d3");
    expect(route(review.routes, "default").fallback).toEqual([]);
  });

  test("context and thinking regressions include tier four but never use price as capability rank", () => {
    for (const changes of [{ contextWindow: 100_000 }, { thinkingLevels: ["high"] as CatalogModel["thinkingLevels"] }]) {
      const input = document();
      input.models = input.models.map(value => value.key === "a4" ? { ...value, ...changes } : value);
      expect(() => compileCatalog(input)).toThrow("code_invalid_catalog");
    }
    const repriced = document();
    repriced.models = repriced.models.map(value => value.key === "a4" ? { ...value, inputCostPerMillion: 1 } : value);
    expect(route(reviewCatalog(compileCatalog(repriced), selection({ capability: 3 }), daytime).routes, "plan").lead.key).toBe("a4");
  });

  test("duplicate keys, family tiers and ambiguous provider/model addresses are refused", () => {
    const input = document();
    input.models.push({ ...input.models[0]!, key: "duplicate", api: "other-api", tier: 4 });
    expect(() => compileCatalog(input)).toThrow("code_invalid_catalog");
    input.models[input.models.length - 1] = model("another", "openai-codex", 2);
    expect(() => compileCatalog(input)).toThrow("code_invalid_catalog");
    input.models[input.models.length - 1] = model("a1", "deepseek", 4);
    expect(() => compileCatalog(input)).toThrow("code_invalid_catalog");
  });

  test("compilation isolates model identities and thinking support from later input edits", () => {
    const input = document();
    const catalog = compileCatalog(input);
    input.models[0]!.id = "changed";
    input.models[0]!.thinkingLevels.splice(0);
    const review = reviewCatalog(catalog, selection({ capability: 1 }), daytime);
    expect(compileOmpOverlay(catalog, review.selection, review.routes).modelRoles?.default).toBe("openai/native-o1:medium");
  });
});

describe("structured route selection", () => {
  test("elite depends on the lead family, deliberative roles bump, and utilities remain capped", () => {
    const catalog = compileCatalog(document());
    const mixed = reviewCatalog(catalog, selection({ capability: 3 }), daytime);
    expect(mixed.available.capabilities).toEqual([1, 2, 3]);
    expect(route(mixed.routes, "default").lead.key).toBe("o3");
    expect(route(mixed.routes, "plan").lead.key).toBe("a4");
    expect(() => reviewCatalog(catalog, selection({ capability: 4 }), daytime)).toThrow("code_invalid_selection");
    const elite = reviewCatalog(catalog, selection({ capability: 4, lane: { kind: "provider", family: "anthropic", blend: "only" } }), daytime);
    expect(route(elite.routes, "default").lead.key).toBe("a4");
    for (const roleName of ["scout", "sonic", "smol", "tiny"]) expect(route(elite.routes, roleName).lead.key).toBe("a2");
    expect(route(elite.routes, "commit").lead.key).toBe("a1");
  });

  test("saved three-level catalogs keep operator-assigned tiers rather than being reclassified", () => {
    const input = document();
    input.models = input.models.filter(value => value.tier >= 1 && value.tier <= 3 && value.provider !== "deepseek")
      .map(value => ({ ...value, inputCostPerMillion: 10 - value.tier, contextWindow: (4 - value.tier) * 100000 }))
      .reverse();
    const catalog = compileCatalog(input);
    for (const [family, prefix] of [["openai", "o"], ["anthropic", "a"]] as const) {
      for (const capability of [1, 2, 3] as const) {
        const saved = selection({ lane: { kind: "provider", family, blend: "only" }, capability });
        const review = reviewCatalog(catalog, saved, daytime);
        expect(review.available.capabilities).toEqual([1, 2, 3]);
        expect(route(review.routes, "default").lead.key).toBe(`${prefix}${capability}`);
        expect(route(review.routes, "plan").lead.key).toBe(`${prefix}${Math.min(3, capability + 1)}`);
      }
      expect(() => reviewCatalog(catalog, selection({ lane: { kind: "provider", family, blend: "only" }, capability: 4 }), daytime))
        .toThrow("code_invalid_selection");
    }
  });

  test("led reviewers and advisors cross families while pure routes stay within family", () => {
    const catalog = compileCatalog(document());
    for (const blend of ["led", "only"] as const) {
      const review = reviewCatalog(catalog, selection({ advisor: "audit", lane: { kind: "provider", family: "deepseek", blend } }), daytime);
      const reviewer = route(review.routes, "reviewer");
      expect(catalog.family(reviewer.lead.key)).toBe(blend === "only" ? "deepseek" : "openai");
      expect(route(review.routes, "security-reviewer").lead).toEqual(reviewer.lead);
      expect(catalog.family(route(review.routes, "advisor").lead.key)).toBe(blend === "only" ? "deepseek" : "anthropic");
    }
    const noPreferredCross = document();
    noPreferredCross.models = noPreferredCross.models.filter(value => value.provider !== "anthropic");
    const reduced = compileCatalog(noPreferredCross);
    const review = reviewCatalog(reduced, selection({ lane: { kind: "provider", family: "openai", blend: "led" } }), daytime);
    expect(catalog.family(route(review.routes, "reviewer").lead.key)).toBe("deepseek");
  });

  test("thinking gaps round down, floors round up, and extremes apply to utility roles", () => {
    const input = document();
    input.models = input.models.map(value => ({ ...value, thinkingLevels: ["low", "medium", "high", "max"] }));
    const catalog = compileCatalog(input);
    const gap = reviewCatalog(catalog, selection({ thinking: "xhigh" }), daytime);
    expect(route(gap.routes, "default").lead.thinking).toBe("high");
    expect(route(gap.routes, "plan").lead.thinking).toBe("high");
    const floor = reviewCatalog(catalog, selection({ thinking: "minimal" }), daytime);
    expect(floor.routes.every(value => value.lead.thinking === "low")).toBe(true);
    const maximum = reviewCatalog(catalog, selection({ thinking: "max" }), daytime);
    expect(route(maximum.routes, "commit").lead.thinking).toBe("max");
  });

  test("vision prefers an image-capable higher rung, filters its net, and deliberately crosses pure lanes", () => {
    const input = document();
    input.models = input.models.map(value => value.key === "o2" ? { ...value, images: false } : value);
    const catalog = compileCatalog(input);
    const review = reviewCatalog(catalog, selection({ lane: { kind: "provider", family: "openai", blend: "led" } }), daytime);
    const image = route(review.routes, "vision");
    expect(image.lead.key).toBe("o3");
    expect(image.fallback.some(value => value.key === "o2")).toBe(false);
    const pure = reviewCatalog(catalog, selection({ lane: { kind: "provider", family: "deepseek", blend: "only" } }), daytime);
    expect(route(pure.routes, "vision").lead.key).toBe("o3");
    expect(route(pure.routes, "vision").fallback.every(value => catalog.model(value.key).images)).toBe(true);
    const impossible = compileCatalog({ ...input, models: input.models.map(value => ({ ...value, images: false })) });
    expect(() => reviewCatalog(impossible, selection(), daytime)).toThrow("code_invalid_selection");
    expect(() => defaultSelection(impossible)).toThrow("code_invalid_selection");
  });

  test("alternate vision families retain priority across asymmetric three- and four-rung ladders", () => {
    const input = document();
    input.models = input.models.map(value => ({ ...value, images: value.key === "a4" || value.key === "d2" }));
    const pure = selection({ lane: { kind: "provider", family: "openai", blend: "only" }, capability: 3 });
    const review = reviewCatalog(compileCatalog(input), pure, daytime);
    expect(route(review.routes, "default").lead.key).toBe("o3");
    expect(route(review.routes, "vision")).toMatchObject({ lead: { key: "a4" }, fallback: [] });
    input.models = input.models.filter(value => value.key !== "a4");
    const shorter = reviewCatalog(compileCatalog(input), pure, daytime);
    expect(route(shorter.routes, "vision")).toMatchObject({ lead: { key: "d2" }, fallback: [] });
  });

  test("spark and priority require actual lane availability and spark drains only its utility seats", () => {
    const catalog = compileCatalog(document());
    const review = reviewCatalog(catalog, selection({ spark: true, priority: true, capability: 1 }), daytime);
    for (const roleName of ["commit", "tiny", "sonic"]) {
      expect(route(review.routes, roleName).lead.key).toBe("spark");
      expect(route(review.routes, roleName).fallback[0]?.key).toBe("o1");
    }
    expect(route(review.routes, "default").lead.key).toBe("o1");
    const pure = selection({ lane: { kind: "provider", family: "anthropic", blend: "only" } });
    expect(() => reviewCatalog(catalog, { ...pure, spark: true }, daytime)).toThrow("code_invalid_selection");
    expect(() => reviewCatalog(catalog, { ...pure, priority: true }, daytime)).toThrow("code_invalid_selection");
    const noSpark = compileCatalog({ schemaVersion: 1, models: document().models.filter(value => value.tier !== 0) });
    expect(() => reviewCatalog(noSpark, selection({ spark: true }), daytime)).toThrow("code_invalid_selection");
  });
});

describe("review to OMP boundary", () => {
  test("every role and fallback retains its actual provider identity; agents retain role-keyed overrides", () => {
    const catalog = compileCatalog(document());
    const review = reviewCatalog(catalog, selection({ advisor: "audit", prewalk: true, priority: true, planYolo: true }), daytime);
    expect(ReviewSchema.parse(review)).toEqual(review);
    const overlay = compileOmpOverlay(catalog, review.selection, review.routes);
    for (const value of review.routes) {
      const lead = catalog.model(value.lead.key);
      expect(overlay.modelRoles?.[value.role]).toBe(`${lead.provider}/${lead.id}:${value.lead.thinking}`);
      expect(overlay.retry?.fallbackChains?.[value.role]).toEqual(value.fallback.map(fallback => {
        const model = catalog.model(fallback.key);
        return `${model.provider}/${model.id}:${fallback.thinking}`;
      }));
      if (value.agentBacked) expect(overlay.task?.agentModelOverrides?.[value.role]).toBe(`@${value.role}`);
    }
    expect(overlay.modelRoles?.default).toBe("openai-codex/native-o2:medium");
    expect(overlay.retry?.fallbackChains?.default?.[0]).toBe("openai/native-o1:medium");
    expect(overlay.retry?.fallbackChains?.commit).toEqual([]);
    expect(overlay.task?.agentAdvisor).toEqual({ task: "on" });
    expect(overlay.task?.prewalk).toBe(true);
    expect(overlay.prewalk?.enabled).toBe(true);
    expect(overlay.tier).toEqual({ openai: "priority" });
    expect(overlay.advisor?.enabled).toBe(true);
  });

  test("advisor intensity selects independent power, separate from the model dial", () => {
    const catalog = compileCatalog(document());
    const audit = reviewCatalog(catalog, selection({ capability: 1, advisor: "audit" }), daytime);
    expect(route(audit.routes, "advisor")).toMatchObject({ lead: { key: "a3", thinking: "high" }, fallback: [
      { key: "a2", thinking: "high" }, { key: "a1", thinking: "low" },
    ] });
    const glance = reviewCatalog(catalog, selection({ capability: 3, advisor: "glance" }), daytime);
    expect(route(glance.routes, "advisor").lead).toEqual({ key: "a1", thinking: "low" });
  });

  test("fallback off removes preview model switches without disabling same-model retries", () => {
    const catalog = compileCatalog(document());
    const review = reviewCatalog(catalog, selection({ fallback: false, advisor: "audit" }), daytime);
    expect(review.routes.every(value => value.fallback.length === 0)).toBe(true);
    expect(compileOmpOverlay(catalog, review.selection, review.routes).retry).toEqual({ enabled: true, modelFallback: false });
  });

  test("overlay compilation refuses missing roles, altered thinking, and mismatched selections", () => {
    const catalog = compileCatalog(document());
    const review = reviewCatalog(catalog, selection(), daytime);
    expect(() => compileOmpOverlay(catalog, review.selection, review.routes.slice(1))).toThrow("code_invalid_selection");
    const changed = review.routes.map(value => value.role === "default" ? { ...value, lead: { ...value.lead, thinking: "low" as const } } : value);
    expect(() => compileOmpOverlay(catalog, review.selection, changed)).toThrow("code_invalid_selection");
    expect(() => compileOmpOverlay(catalog, { ...review.selection, capability: 3 }, review.routes)).toThrow("code_invalid_selection");
  });

  test("priority and off-peak estimates are deterministic at millisecond UTC boundaries", () => {
    const catalog = compileCatalog(document());
    const ordinary = reviewCatalog(catalog, selection({ lane: { kind: "provider", family: "openai", blend: "only" } }), daytime);
    const priority = reviewCatalog(catalog, { ...ordinary.selection, priority: true }, daytime);
    expect(priority.estimates.costScore).toBeGreaterThan(ordinary.estimates.costScore);
    expect(priority.estimates.speedScore).toBeGreaterThan(ordinary.estimates.speedScore);
    const deepseek = selection({ lane: { kind: "provider", family: "deepseek", blend: "only" } });
    const start = Date.UTC(2026, 0, 1, 16, 30);
    const end = Date.UTC(2026, 0, 2, 0, 30);
    const before = reviewCatalog(catalog, deepseek, start - 1).estimates.costScore;
    const during = reviewCatalog(catalog, deepseek, start).estimates.costScore;
    expect(during).toBeLessThan(before);
    expect(reviewCatalog(catalog, deepseek, end - 1).estimates.costScore).toBe(during);
    expect(reviewCatalog(catalog, deepseek, end).estimates.costScore).toBe(before);
    expect(() => reviewCatalog(catalog, deepseek, -1)).toThrow("code_invalid_selection");
  });
});

/*
  A selection that encodes today's answer expires when the catalog changes; a selection that
  states a property does not. `budget` is the property, and these cases hold it to that: the
  operator says "free", never a list of models that happen to be free today (#200).

  A free catalog is built by zeroing prices on an otherwise identical document, so the ONLY
  difference between the cases is a price the provider owns.
*/
describe("a cost constraint is a property, not a list of names", () => {
  const freeDocument = (): CatalogDocument => ({
    schemaVersion: 1,
    models: document().models.map(entry => ({ ...entry, inputCostPerMillion: 0, outputCostPerMillion: 0 })),
  });

  test("a paid catalog refuses a free budget by its own name, rather than resolving to the cheapest paid model", () => {
    const catalog = compileCatalog(document());
    expect(() => reviewCatalog(catalog, selection({ budget: "free" }), daytime))
      .toThrow("code_budget_unsatisfiable");
    // The same selection without the constraint resolves, so the refusal is the constraint's and
    // not a broken profile.
    expect(reviewCatalog(catalog, selection(), daytime).routes.length).toBeGreaterThan(0);
  });

  test("the same selection resolves once the provider makes those models free, with no configuration edit", () => {
    const asked = selection({ budget: "free" });
    expect(() => reviewCatalog(compileCatalog(document()), asked, daytime)).toThrow("code_budget_unsatisfiable");
    // Identical selection, identical catalog shape, one price changed by the provider.
    const review = reviewCatalog(compileCatalog(freeDocument()), asked, daytime);
    expect(review.selection.budget).toBe("free");
    expect(review.routes.length).toBeGreaterThan(0);
    expect(ReviewSchema.parse(review).available.budgets).toEqual(["free", "any"]);
  });

  test("no route under a free budget carries a paid model, lead or fallback", () => {
    // One model stays paid in an otherwise free catalog: it must appear in no route at all,
    // because a paid fallback is exactly the substitution the constraint exists to prevent.
    const mixed: CatalogDocument = {
      schemaVersion: 1,
      models: freeDocument().models.map(entry =>
        entry.key === "a2" ? { ...entry, inputCostPerMillion: 7, outputCostPerMillion: 21 } : entry),
    };
    const catalog = compileCatalog(mixed);
    const review = reviewCatalog(catalog, selection({ capability: 3, budget: "free" }), daytime);
    const keys = review.routes.flatMap(entry => [entry.lead.key, ...entry.fallback.map(item => item.key)]);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).not.toContain("a2");
    for (const key of keys) {
      const model = catalog.model(key);
      expect(model.inputCostPerMillion).toBe(0);
      expect(model.outputCostPerMillion).toBe(0);
    }
  });

  test("a budget the catalog cannot serve is not offered, and `any` always is", () => {
    expect(reviewCatalog(compileCatalog(document()), selection(), daytime).available.budgets).toEqual(["any"]);
    expect(reviewCatalog(compileCatalog(freeDocument()), selection(), daytime).available.budgets)
      .toEqual(["free", "any"]);
  });

  test("a selection persisted before the constraint existed still means what it meant", () => {
    const { budget: _budget, ...legacy } = selection();
    const review = reviewCatalog(compileCatalog(document()), legacy as Selection, daytime);
    expect(review.selection.budget).toBe("any");
  });

  test("the constraint composes with fallback rather than duplicating it", () => {
    // `fallback` governs whether to substitute at all; the budget governs what is admissible.
    const catalog = compileCatalog(freeDocument());
    const withFallback = reviewCatalog(catalog, selection({ budget: "free", fallback: true }), daytime);
    const without = reviewCatalog(catalog, selection({ budget: "free", fallback: false }), daytime);
    expect(withFallback.routes.some(entry => entry.fallback.length > 0)).toBe(true);
    expect(without.routes.every(entry => entry.fallback.length === 0)).toBe(true);
  });
});
