import { describe, expect, test } from "bun:test";
import { compileCatalog, type CompiledCatalog } from "./catalog.ts";
import { type CatalogDocument, type CatalogModel, type Route, type Selection } from "./contracts.ts";
import { familyPolicy, providerPolicy } from "./providers.ts";
import { clampSelection, compileOmpOverlay, defaultSelection, newPremiumLead, reviewCatalog, ReviewSchema, routedModels, routeService, selectionForLane, servedRoutes, unpublishedModels } from "./routing.ts";

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
    expect(review.selection).toMatchObject({ lane: { kind: "provider", family: "vendor-example", blend: "only" }, capability: 1 });
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
    expect(catalog.short).toEqual([]);
    // A family Code requires that lacks a tier fills it from its nearest rung, lower on a tie, and is said short.
    single.models = single.models.filter(value => value.tier !== 2);
    const short = compileCatalog(single);
    expect([short.short, [1, 2, 3, 4].map(tier => short.rung("anthropic", tier))]).toEqual([["anthropic"], ["a1", "a1", "a3", "a4"]]);
    expect(route(reviewCatalog(short, selection({ lane: { kind: "provider", family: "anthropic", blend: "only" }, capability: 2 }), daytime).routes, "default").lead.key).toBe("a1");
  });

  test("optional missing rungs borrow the nearest declared rung, with lower ties", () => {
    const input = document();
    input.models = input.models.filter(value => value.provider !== "deepseek");
    input.models.push(model("d1", "deepseek", 1), model("d3", "deepseek", 3));
    const catalog = compileCatalog(input);
    const review = reviewCatalog(catalog, selection({ lane: { kind: "provider", family: "deepseek", blend: "only" } }), daytime);
    expect(route(review.routes, "default").lead.key).toBe("d1");
    expect(route(review.routes, "plan").lead).toEqual({ key: "d1", thinking: "high" });
    expect(route(review.routes, "default").fallback).toEqual([]);
    // Short is said only of a family Code requires; any other family is as long as its listing.
    expect(catalog.short).toEqual([]);
  });

  test("a thinking regression refuses the catalog at any tier, a smaller context window never does, and price never ranks capability", () => {
    const thinner = document();
    thinner.models = thinner.models.map(value => value.key === "a4" ? { ...value, thinkingLevels: ["high"] as CatalogModel["thinkingLevels"] } : value);
    expect(() => compileCatalog(thinner)).toThrow("code_invalid_catalog");
    // OpenAI's sol and astra sit above terra with smaller windows, as its own tier names place them.
    const narrower = document();
    narrower.models = narrower.models.map(value => value.key === "o3" ? { ...value, contextWindow: 50_000 } : value);
    expect(compileCatalog(narrower).model("o3").contextWindow).toBe(50_000);
    const repriced = document();
    repriced.models = repriced.models.map(value => value.key === "a4" ? { ...value, inputCostPerMillion: 1 } : value);
    const review = reviewCatalog(compileCatalog(repriced), selection({ capability: 3 }), daytime);
    expect(route(review.routes, "plan").lead.key).toBe("a3");
    expect(route(review.routes, "slow").lead.key).toBe("a3");
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

describe("default selection", () => {
  test("starts on Sonnet's second rung at medium, with cheap independent utility effort and no retired Spark", () => {
    const catalog = compileCatalog(document());
    const chosen = defaultSelection(catalog);
    expect(chosen).toEqual({ lane: { kind: "provider", family: "anthropic", blend: "only" },
      capability: 2, thinking: "medium", advisor: "glance", spark: false,
      priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any" });
    const review = reviewCatalog(catalog, chosen, daytime);
    for (const roleName of ["default", "task"]) expect(route(review.routes, roleName).lead).toEqual({ key: "a2", thinking: "medium" });
    for (const roleName of ["plan", "slow"]) expect(route(review.routes, roleName).lead).toEqual({ key: "a2", thinking: "high" });
    expect(route(review.routes, "advisor").lead).toEqual({ key: "a1", thinking: "low" });
    expect(route(review.routes, "smol").lead).toEqual({ key: "a1", thinking: "medium" });
    expect(route(review.routes, "memory").lead).toEqual({ key: "a1", thinking: "medium" });
    for (const roleName of ["widget", "tiny", "commit"]) expect(route(review.routes, roleName).lead).toEqual({ key: "a1", thinking: "low" });
    expect(catalog.models.some(model => model.key === "spark")).toBe(false);
  });

  test("uses the served family without broadening the account pool or rewriting an explicit choice", () => {
    const catalog = compileCatalog(document());
    const onlyOpenai = (provider: string) => providerPolicy(provider).family === "openai";
    const onlyAnthropic = (provider: string) => provider === "anthropic";
    const sol = defaultSelection(catalog, onlyOpenai);
    expect(sol).toMatchObject({ lane: { kind: "provider", family: "openai", blend: "only" }, capability: 3, thinking: "medium" });
    expect(route(reviewCatalog(catalog, sol, daytime).routes, "default").lead).toEqual({ key: "o3", thinking: "medium" });
    expect(defaultSelection(catalog, onlyAnthropic)).toMatchObject({
      lane: { kind: "provider", family: "anthropic", blend: "only" }, capability: 2,
    });
    expect(clampSelection(catalog, null, onlyOpenai)).toEqual(sol);
    const explicit = selection({ lane: { kind: "provider", family: "anthropic", blend: "only" }, capability: 4, thinking: "max" });
    expect(clampSelection(catalog, explicit, onlyOpenai)).toEqual(explicit);
    expect(() => servedRoutes(catalog, reviewCatalog(catalog, explicit, daytime).routes, onlyOpenai)).toThrow("code_account_unavailable");
    expect(() => defaultSelection(catalog, () => false)).toThrow("code_account_unavailable");
    expect(() => clampSelection(catalog, null, () => false)).toThrow("code_account_unavailable");
    const absentFamily = selection({ lane: { kind: "provider", family: "unlisted", blend: "only" }, capability: 4 });
    expect(clampSelection(catalog, absentFamily, onlyOpenai)).toMatchObject({
      lane: { kind: "provider", family: "openai", blend: "only" }, capability: 3,
    });
  });

  test("an unserved vision provider skips an incomplete Sonnet profile for the complete served Sol lane", () => {
    const input = document();
    input.models = input.models.filter(value => value.provider !== "deepseek")
      .map(value => ({ ...value, images: value.provider !== "anthropic" }));
    const catalog = compileCatalog(input), serves = (provider: string) => provider !== "openai-codex";
    const sonnet = selection({ lane: { kind: "provider", family: "anthropic", blend: "only" }, advisor: "glance" });
    const incomplete = reviewCatalog(catalog, sonnet, daytime);
    expect(routeService(catalog, incomplete.routes, serves).lead)
      .toEqual({ provider: "openai-codex", family: "openai", roles: ["vision"] });
    const chosen = defaultSelection(catalog, serves);
    expect(chosen).toMatchObject({ lane: { kind: "provider", family: "openai", blend: "only" }, capability: 3, thinking: "medium" });
    const complete = reviewCatalog(catalog, chosen, daytime);
    expect(routeService(catalog, complete.routes, serves).lead).toBeNull();
    expect(compileOmpOverlay(catalog, chosen, servedRoutes(catalog, complete.routes, serves), serves).modelRoles?.vision)
      .toBe("openai/native-o3:low");
    expect(clampSelection(catalog, null, serves)).toEqual(chosen);
    expect(clampSelection(catalog, sonnet, serves)).toEqual(sonnet);
    expect(() => compileOmpOverlay(catalog, sonnet, incomplete.routes, serves)).toThrow("code_account_unavailable");
    expect(() => defaultSelection(catalog, provider => provider === "anthropic")).toThrow("code_account_unavailable");
    const noVision = compileCatalog({ ...input, models: input.models.map(value => ({ ...value, images: false })) });
    expect(() => defaultSelection(noVision, serves)).toThrow("code_invalid_selection");
  });

  test("a premium-only Anthropic vision route cannot promote an automatic Sonnet profile", () => {
    const input = document();
    input.models = input.models.filter(value => value.provider !== "deepseek")
      .map(value => ({ ...value, images: value.provider !== "anthropic" || value.key === "a4" }));
    const catalog = compileCatalog(input), serves = (provider: string) => provider !== "openai-codex";
    const explicit = selectionForLane({ kind: "provider", family: "anthropic", blend: "only" }, 2);
    const explicitReview = reviewCatalog(catalog, explicit, daytime);
    expect(route(explicitReview.routes, "default").lead).toEqual({ key: "a2", thinking: "medium" });
    expect(route(explicitReview.routes, "vision").lead).toEqual({ key: "a4", thinking: "low" });
    expect(clampSelection(catalog, explicit, serves)).toEqual(explicit);
    expect(compileOmpOverlay(catalog, explicit, explicitReview.routes, serves).modelRoles?.vision).toBe("anthropic/native-a4:low");
    const chosen = defaultSelection(catalog, serves), review = reviewCatalog(catalog, chosen, daytime);
    expect(chosen).toMatchObject({ lane: { kind: "provider", family: "openai", blend: "only" }, capability: 3 });
    expect(review.routes.every(value => catalog.model(value.lead.key).tier <= 3)).toBe(true);
    expect(compileOmpOverlay(catalog, chosen, servedRoutes(catalog, review.routes, serves), serves).modelRoles?.vision)
      .toBe("openai/native-o3:low");
  });

  test("a missing Sonnet rung never silently turns the balanced default into premium Anthropic", () => {
    const input = document();
    input.models = input.models.filter(value => value.provider !== "deepseek" &&
      (value.provider !== "anthropic" || value.tier >= 3));
    const catalog = compileCatalog(input), chosen = defaultSelection(catalog);
    expect(catalog.short).toContain("anthropic");
    expect(catalog.model(catalog.rung("anthropic", 2)).tier).toBe(3);
    expect(chosen).toMatchObject({ lane: { kind: "provider", family: "openai", blend: "only" }, capability: 3, thinking: "medium" });
    expect(clampSelection(catalog, null)).toEqual(chosen);
    const explicit = selection({ lane: { kind: "provider", family: "anthropic", blend: "only" } });
    expect(clampSelection(catalog, explicit)).toEqual(explicit);
    const review = reviewCatalog(catalog, explicit, daytime);
    expect(route(review.routes, "default").lead).toEqual({ key: "a3", thinking: "medium" });
    expect(compileOmpOverlay(catalog, explicit, review.routes).modelRoles?.default).toBe("anthropic/native-a3:medium");
    const premiumOnly = compileCatalog({ ...input, models: input.models.filter(value => value.provider === "anthropic") });
    expect(() => defaultSelection(premiumOnly)).toThrow("code_invalid_selection");
  });

  test("an authored served Sol profile precedes Haiku filling the missing Sonnet rung", () => {
    const catalog = compileCatalog({ schemaVersion: 1, models: [
      model("haiku", "anthropic", 1, { id: "claude-haiku-5-5" }),
      model("opus", "anthropic", 3, { id: "claude-opus-5-5" }),
      model("luna", "openai-codex", 1, { id: "gpt-6-luna" }),
      model("sol", "openai-codex", 3, { id: "gpt-6.1-sol" }),
    ] });
    expect(catalog.model(catalog.rung("anthropic", 2)).tier).toBe(1);
    const chosen = defaultSelection(catalog), review = reviewCatalog(catalog, chosen, daytime);
    expect(chosen).toMatchObject({ lane: { kind: "provider", family: "openai", blend: "only" }, capability: 3, thinking: "medium" });
    expect(catalog.model(route(review.routes, "default").lead.key)).toMatchObject({ provider: "openai-codex", id: "gpt-6.1-sol", tier: 3 });
    expect(compileOmpOverlay(catalog, chosen, review.routes).modelRoles?.default).toBe("openai-codex/gpt-6.1-sol:medium");
    expect(clampSelection(catalog, null)).toEqual(chosen);
    const onlyAnthropic = (provider: string) => provider === "anthropic";
    const lower = defaultSelection(catalog, onlyAnthropic), lowerReview = reviewCatalog(catalog, lower, daytime);
    expect(lower).toMatchObject({ lane: { kind: "provider", family: "anthropic", blend: "only" }, capability: 1 });
    expect(catalog.model(route(lowerReview.routes, "default").lead.key)).toMatchObject({ provider: "anthropic", id: "claude-haiku-5-5", tier: 1 });
    const explicit = selectionForLane({ kind: "provider", family: "anthropic", blend: "only" }, 2);
    expect(clampSelection(catalog, explicit)).toEqual(explicit);
    expect(route(reviewCatalog(catalog, explicit, daytime).routes, "default").lead.key).toBe("haiku");
  });

  test("an unbounded preferred vision profile falls back to a complete lower authored rung", () => {
    const catalog = compileCatalog({ schemaVersion: 1, models: [
      model("a1", "anthropic", 1), model("a2", "anthropic", 2, { images: false }), model("a4", "anthropic", 4),
    ] });
    const explicit = selectionForLane({ kind: "provider", family: "anthropic", blend: "only" }, 2);
    expect(route(reviewCatalog(catalog, explicit, daytime).routes, "vision").lead.key).toBe("a4");
    const chosen = defaultSelection(catalog), review = reviewCatalog(catalog, chosen, daytime);
    expect(chosen).toMatchObject({ lane: { kind: "provider", family: "anthropic", blend: "only" }, capability: 1 });
    expect(review.routes.every(value => value.lead.key === "a1" && value.fallback.length === 0)).toBe(true);
  });

  test("an unserved Sol lead falls back to the actual served Terra tier", () => {
    const catalog = compileCatalog({ schemaVersion: 1, models: [
      model("luna", "openai-codex", 1, { id: "gpt-6-luna" }),
      model("terra", "openai-codex", 2, { id: "gpt-5.6-terra" }),
      model("sol", "openai", 3, { id: "gpt-6.1-sol" }),
    ] });
    const serves = (provider: string) => provider === "openai-codex";
    const chosen = defaultSelection(catalog, serves), review = reviewCatalog(catalog, chosen, daytime);
    expect(chosen).toMatchObject({ lane: { kind: "provider", family: "openai", blend: "only" }, capability: 2 });
    expect(catalog.model(route(review.routes, "default").lead.key)).toMatchObject({ provider: "openai-codex", id: "gpt-5.6-terra", tier: 2 });
    expect(routeService(catalog, review.routes, serves).lead).toBeNull();
    expect(compileOmpOverlay(catalog, chosen, review.routes, serves).modelRoles?.default).toBe("openai-codex/gpt-5.6-terra:medium");
  });

  test("sparse Sol coverage uses a declared lower tier instead of automatically selecting Astra", () => {
    const catalog = compileCatalog({ schemaVersion: 1, models: [model("o1", "openai", 1), model("o4", "openai", 4)] });
    expect(catalog.model(catalog.rung("openai", 3)).tier).toBe(4);
    const chosen = defaultSelection(catalog);
    expect(chosen).toMatchObject({ lane: { kind: "provider", family: "openai", blend: "only" }, capability: 1, thinking: "medium" });
    const review = reviewCatalog(catalog, chosen, daytime);
    expect(review.routes.every(value => value.lead.key === "o1" && value.fallback.length === 0)).toBe(true);
    expect(compileOmpOverlay(catalog, chosen, review.routes).modelRoles?.default).toBe("openai/native-o1:medium");
    const explicit = selectionForLane({ kind: "provider", family: "openai", blend: "only" }, 3);
    expect(clampSelection(catalog, explicit)).toEqual(explicit);
    expect(route(reviewCatalog(catalog, explicit, daytime).routes, "default").lead.key).toBe("o4");
  });

  test("lower-only provider and generic catalogs remain usable without manufacturing a premium rung", () => {
    for (const [provider, id, tier] of [
      ["anthropic", "claude-haiku-5-5", 1], ["openai-codex", "gpt-6-luna", 1],
      ["vendor-example", "generic-1", 1], ["vendor-example", "generic-2", 2], ["vendor-example", "generic-3", 3],
    ] as const) {
      const catalog = compileCatalog({ schemaVersion: 1, models: [model("only", provider, tier, { id })] });
      const serves = (candidate: string) => candidate === provider;
      const chosen = defaultSelection(catalog, serves), review = reviewCatalog(catalog, chosen, daytime);
      expect(chosen).toMatchObject({ lane: { kind: "provider", family: providerPolicy(provider).family, blend: "only" },
        capability: tier, thinking: "medium" });
      expect(catalog.model(route(review.routes, "default").lead.key)).toMatchObject({ provider, id, tier });
      expect(review.routes.every(value => value.lead.key === "only" && value.fallback.length === 0)).toBe(true);
      expect(compileOmpOverlay(catalog, chosen, review.routes, serves).modelRoles?.default).toBe(`${provider}/${id}:medium`);
    }
  });

  test("explicit lane preferences permit reviewed premium adoption without inventing an automatic default", () => {
    const catalog = compileCatalog({ schemaVersion: 1, models: [model("o4", "openai", 4)] });
    expect(() => defaultSelection(catalog)).toThrow("code_invalid_selection");
    const explicit = selectionForLane({ kind: "provider", family: "openai", blend: "only" }, 4);
    expect(explicit).toEqual({ lane: { kind: "provider", family: "openai", blend: "only" }, capability: 4,
      thinking: "medium", advisor: "glance", spark: false, priority: false, prewalk: false, planYolo: false,
      fallback: true, budget: "any" });
    const review = reviewCatalog(catalog, explicit, daytime);
    expect(compileOmpOverlay(catalog, explicit, review.routes).modelRoles?.default).toBe("openai/native-o4:medium");
    const invalid = selectionForLane({ kind: "provider", family: "unlisted", blend: "only" }, 4);
    expect(() => reviewCatalog(catalog, invalid, daytime)).toThrow("code_invalid_selection");
  });

  test("a single-family catalog keeps its own balanced pure lane", () => {
    for (const family of ["anthropic", "openai", "deepseek"]) {
      const single = compileCatalog({ schemaVersion: 1,
        models: document().models.filter(value => providerPolicy(value.provider).family === family)
          .map(value => ({ ...value, images: true })) });
      expect(defaultSelection(single)).toMatchObject({
        lane: { kind: "provider", family, blend: "only" }, capability: family === "openai" ? 3 : 2,
        advisor: "glance", thinking: "medium", spark: false,
      });
    }
  });
});

describe("new premium main-model admission", () => {
  test("a new over-ceiling main needs an explicit tier even when the old catalog already listed it", () => {
    const before = compileCatalog(document());
    const after = compileCatalog({ schemaVersion: 1, models: [model("a4", "anthropic", 4)] });
    const chosen = selectionForLane({ kind: "provider", family: "anthropic", blend: "only" }, 2);
    const proposed = { provider: "anthropic", id: "native-a4", tier: 4 as const };
    expect(newPremiumLead(after, chosen, { catalog: before, selection: chosen })).toEqual(proposed);
    expect(newPremiumLead(after, chosen, null)).toEqual(proposed);
    expect(newPremiumLead(after, { ...chosen, capability: 4 }, null)).toBeNull();
    expect(newPremiumLead(before, chosen, null)).toBeNull();
    expect(newPremiumLead(after, chosen, { catalog: before, selection: { ...chosen, capability: 4 } })).toBeNull();
  });

  test("unchanged legacy active model identity survives key and metadata edits without changing compilation", () => {
    const before = compileCatalog({ schemaVersion: 1, models: [model("a4", "anthropic", 4)] });
    const after = compileCatalog({ schemaVersion: 1, models: [
      model("renamed", "anthropic", 4, { id: "native-a4", inputCostPerMillion: 9, contextWindow: 100_000, tokensPerSecond: 91 }),
    ] });
    const chosen = selectionForLane({ kind: "provider", family: "anthropic", blend: "only" }, 2);
    expect(newPremiumLead(after, chosen, { catalog: before, selection: chosen })).toBeNull();
    const review = reviewCatalog(after, chosen, daytime);
    expect(route(review.routes, "default").lead).toEqual({ key: "renamed", thinking: "medium" });
    expect(compileOmpOverlay(after, chosen, review.routes).modelRoles?.default).toBe("anthropic/native-a4:medium");
  });

  test("the same model id on another provider is a new premium identity", () => {
    const before = compileCatalog({ schemaVersion: 1, models: [model("a4", "anthropic", 4)] });
    const after = compileCatalog({ schemaVersion: 1, models: [model("moved", "openai", 4, { id: "native-a4" })] });
    const previous = selectionForLane({ kind: "provider", family: "anthropic", blend: "only" }, 2);
    const chosen = selectionForLane({ kind: "provider", family: "openai", blend: "only" }, 2);
    expect(newPremiumLead(after, chosen, { catalog: before, selection: previous }))
      .toEqual({ provider: "openai", id: "native-a4", tier: 4 });
  });
});

describe("a stored catalog read at its named families' actual tiers", () => {
  const anthropicOnly = (capability: Selection["capability"]) => selectionForLane({ kind: "provider", family: "anthropic", blend: "only" }, capability);
  const leadKey = (catalog: CompiledCatalog, capability: Selection["capability"]) =>
    route(reviewCatalog(catalog, anthropicOnly(capability), daytime).routes, "default").lead.key;

  test("a cached sparse Anthropic ladder keeps its stored document; only a kept rank whose model would change is refused", () => {
    // Laddered by price before Anthropic's names were its tiers: Sonnet unreachable, Opus took rung 2.
    const stored: CatalogDocument = { schemaVersion: 1, models: [
      model("haiku", "anthropic", 1, { id: "claude-haiku-5" }), model("opus", "anthropic", 2, { id: "claude-opus-5" }),
    ] };
    const untouched = structuredClone(stored);
    const catalog = compileCatalog(stored);
    expect(stored).toEqual(untouched);
    expect(catalog.models.map(value => [value.key, value.tier])).toEqual([["haiku", 1], ["opus", 3]]);
    expect([catalog.isReclassified("haiku"), catalog.isReclassified("opus")]).toEqual([false, true]);
    expect([catalog.short, [1, 2, 3, 4].map(tier => catalog.rung("anthropic", tier))]).toEqual([["anthropic"], ["haiku", "haiku", "opus", "opus"]]);
    // Opus's actual tier resolves the same Opus with no new premium choice; Haiku stays where it was.
    const elite = reviewCatalog(catalog, anthropicOnly(3), daytime);
    expect([route(elite.routes, "default").lead.key, elite.available.capabilities]).toEqual(["opus", [1, 2, 3]]);
    expect(newPremiumLead(catalog, anthropicOnly(3), { catalog, selection: anthropicOnly(2) })).toBeNull();
    expect(leadKey(catalog, 1)).toBe("haiku");
    // A kept rank 2 meant Opus and would now mean Haiku: refused, neither model chosen behind the
    // operator's back. A new explicit rank 2 previews the Haiku it now names, with no premium step.
    expect(() => catalog.assertUnambiguousSelection("anthropic", 2)).toThrow("code_invalid_selection");
    expect(leadKey(catalog, 2)).toBe("haiku");
    expect(clampSelection(catalog, anthropicOnly(2))).toEqual(anthropicOnly(2));
    expect(newPremiumLead(catalog, anthropicOnly(2), { catalog, selection: anthropicOnly(2) })).toBeNull();
    // Reads and an automatic choice are not refused by one ambiguous rank.
    expect(catalog.model("opus")).toMatchObject({ id: "claude-opus-5", tier: 3 });
    expect(defaultSelection(catalog)).toMatchObject({ lane: { kind: "provider", family: "anthropic", blend: "only" }, capability: 1 });
    expect(stored).toEqual(untouched);
  });

  test("a stored third-rung Fable's kept rank is refused rather than silently downgraded to Opus; each actual tier stays explicit", () => {
    const catalog = compileCatalog({ schemaVersion: 1, models: [
      model("haiku", "anthropic", 1, { id: "claude-haiku-5" }), model("opus", "anthropic", 2, { id: "claude-opus-5" }),
      model("fable", "anthropic", 3, { id: "claude-fable-5" }),
    ] });
    expect(catalog.models.map(value => value.tier)).toEqual([1, 3, 4]);
    // Kept ranks 2 and 3 meant Opus and Fable: refused, never silently Haiku and Opus. A kept 4 meant
    // the stored top, Fable, which is still the rung it names.
    for (const capability of [2, 3]) expect(() => catalog.assertUnambiguousSelection("anthropic", capability)).toThrow("code_invalid_selection");
    for (const capability of [1, 4]) expect(() => catalog.assertUnambiguousSelection("anthropic", capability)).not.toThrow();
    // A new explicit choice names each model at its actual tier, Opus at 3 and Fable at 4, with no premium step.
    expect(([1, 2, 3, 4] as const).map(capability => leadKey(catalog, capability))).toEqual(["haiku", "haiku", "opus", "fable"]);
    for (const capability of [2, 3, 4] as const) expect(newPremiumLead(catalog, anthropicOnly(capability), null)).toBeNull();
    expect(reviewCatalog(catalog, anthropicOnly(4), daytime).available.capabilities).toEqual([1, 2, 3, 4]);
  });

  test("a correctly stored model whose rung another model's actual tier takes is never automatically replaced, yet each stays explicit", () => {
    // Opus authored at its own tier 3; Sonnet misranked at 4 is read at 2 and now fills ranks 1 and 2.
    const stored: CatalogDocument = { schemaVersion: 1, models: [
      model("opus", "anthropic", 3, { id: "claude-opus-5" }), model("sonnet", "anthropic", 4, { id: "claude-sonnet-5" }),
    ] };
    const untouched = structuredClone(stored);
    const catalog = compileCatalog(stored);
    expect([catalog.isReclassified("opus"), catalog.model("sonnet").tier, catalog.top("anthropic")]).toEqual([false, 2, 3]);
    // Kept ranks 1 and 2 meant Opus and a kept 4 meant Sonnet: each is refused, never silently another model.
    for (const capability of [1, 2, 4]) expect(() => catalog.assertUnambiguousSelection("anthropic", capability)).toThrow("code_invalid_selection");
    expect(() => catalog.assertUnambiguousSelection("anthropic", 3)).not.toThrow();
    // A new explicit choice previews each model at its actual tier: Sonnet at 2 with no premium step, Opus at 3.
    expect(([1, 2, 3] as const).map(capability => leadKey(catalog, capability))).toEqual(["sonnet", "sonnet", "opus"]);
    expect(clampSelection(catalog, anthropicOnly(2))).toEqual(anthropicOnly(2));
    expect(newPremiumLead(catalog, anthropicOnly(2), { catalog, selection: anthropicOnly(2) })).toBeNull();
    expect(newPremiumLead(catalog, anthropicOnly(1), null)).toEqual({ provider: "anthropic", id: "claude-sonnet-5", tier: 2 });
    expect(() => reviewCatalog(catalog, anthropicOnly(4), daytime)).toThrow("code_invalid_selection");
    // A fresh default is a new effective choice too; whether a kept selector still means it is its caller's to admit.
    expect(defaultSelection(catalog)).toEqual(anthropicOnly(2));
    expect(stored).toEqual(untouched);
  });

  test("a top tier the stored ladder never had is an explicit actual-tier choice, never a kept old rank", () => {
    // Fable laddered cheapest at 1 under Sonnet 2 and Opus 3 is read at 4: the stored top was 3.
    const catalog = compileCatalog({ schemaVersion: 1, models: [
      model("fable", "anthropic", 1, { id: "claude-fable-5" }), model("sonnet", "anthropic", 2, { id: "claude-sonnet-5" }),
      model("opus", "anthropic", 3, { id: "claude-opus-5" }),
    ] });
    expect(catalog.models.map(value => [value.key, value.tier])).toEqual([["fable", 4], ["sonnet", 2], ["opus", 3]]);
    const elite = reviewCatalog(catalog, anthropicOnly(4), daytime);
    expect([route(elite.routes, "default").lead.key, elite.available.capabilities]).toEqual(["fable", [1, 2, 3, 4]]);
    expect(newPremiumLead(catalog, anthropicOnly(4), null)).toBeNull();
    // A kept 4 meant the stored top, Opus, and a kept 1 meant Fable: both refused, never silently changed.
    for (const capability of [1, 4]) expect(() => catalog.assertUnambiguousSelection("anthropic", capability)).toThrow("code_invalid_selection");
    for (const capability of [2, 3]) expect(() => catalog.assertUnambiguousSelection("anthropic", capability)).not.toThrow();
    expect([leadKey(catalog, 2), leadKey(catalog, 3)]).toEqual(["sonnet", "opus"]);
    // A new rank 1 previews Sonnet, read above it: that needs Sonnet's actual tier, whatever came before or proves it.
    const sonnet = { provider: "anthropic", id: "claude-sonnet-5", tier: 2 as const };
    expect(leadKey(catalog, 1)).toBe("sonnet");
    expect(newPremiumLead(catalog, anthropicOnly(1), null)).toEqual(sonnet);
    expect(newPremiumLead(catalog, anthropicOnly(1), { catalog, selection: anthropicOnly(2) })).toEqual(sonnet);
    expect(newPremiumLead(catalog, anthropicOnly(1), { catalog, selection: anthropicOnly(2), resolved: sonnet })).toEqual(sonnet);
    // The automatic choice stays below elite.
    expect(defaultSelection(catalog)).toMatchObject({ lane: { kind: "provider", family: "anthropic", blend: "only" }, capability: 2 });
  });

  test("an under-rank model that keeps its identity stays previewable, but its old rank is never premium consent", () => {
    const lone = compileCatalog({ schemaVersion: 1, models: [model("opus", "anthropic", 1, { id: "claude-opus-5" })] });
    const cheap = anthropicOnly(1), opus = { provider: "anthropic", id: "claude-opus-5" }, premium = { ...opus, tier: 3 as const };
    expect(leadKey(lone, 1)).toBe("opus");
    expect(newPremiumLead(lone, cheap, { catalog: lone, selection: cheap })).toEqual(premium);
    expect(newPremiumLead(lone, cheap, null)).toEqual(premium);
    // An earlier actual-tier choice authorizes no persisted under-rank selection of the same stored rank.
    expect(newPremiumLead(lone, cheap, { catalog: lone, selection: anthropicOnly(3) })).toEqual(premium);
    expect(newPremiumLead(lone, anthropicOnly(2), { catalog: lone, selection: anthropicOnly(3) })).toEqual(premium);
    expect(newPremiumLead(lone, anthropicOnly(2), { catalog: lone, selection: anthropicOnly(3), resolved: opus })).toEqual(premium);
    expect(newPremiumLead(lone, anthropicOnly(3), { catalog: lone, selection: cheap })).toBeNull();
    // The same Opus authored at its own tier keeps the unchanged active identity's existing exemption.
    const authored = compileCatalog({ schemaVersion: 1, models: [model("opus", "anthropic", 3, { id: "claude-opus-5" })] });
    expect(authored.isReclassified("opus")).toBe(false);
    expect(newPremiumLead(authored, cheap, { catalog: authored, selection: cheap })).toBeNull();
    expect(newPremiumLead(lone, cheap, { catalog: authored, selection: cheap })).toEqual(premium);
    expect(newPremiumLead(authored, cheap, { catalog: lone, selection: cheap })).toEqual(premium);
    expect(newPremiumLead(authored, cheap, { catalog: lone, selection: anthropicOnly(3) })).toBeNull();
    expect(newPremiumLead(authored, cheap, { catalog: lone, selection: anthropicOnly(3), resolved: opus })).toBeNull();
    // A proof of the saved Opus under its actual tier is no consent either.
    expect(newPremiumLead(authored, cheap, { catalog: lone, selection: cheap, resolved: opus })).toEqual(premium);
    // Sonnet stored at 1 above an unreachable Haiku keeps rank 1 at its actual tier 2; Opus's kept rank 2 is refused.
    const sparse = compileCatalog({ schemaVersion: 1, models: [
      model("sonnet", "anthropic", 1, { id: "claude-sonnet-5" }), model("opus", "anthropic", 2, { id: "claude-opus-5" }),
    ] });
    expect([leadKey(sparse, 1), leadKey(sparse, 3)]).toEqual(["sonnet", "opus"]);
    expect(newPremiumLead(sparse, cheap, { catalog: sparse, selection: cheap })).toEqual({ provider: "anthropic", id: "claude-sonnet-5", tier: 2 });
    expect(() => sparse.assertUnambiguousSelection("anthropic", 2)).toThrow("code_invalid_selection");
    expect(leadKey(sparse, 2)).toBe("sonnet");
    // An active rank whose model changed names no active identity to exempt, and no proof makes a reclassified model consent.
    const sonnet = { provider: "anthropic", id: "claude-sonnet-5", tier: 2 as const };
    expect(newPremiumLead(sparse, cheap, { catalog: sparse, selection: anthropicOnly(2) })).toEqual(sonnet);
    expect(newPremiumLead(sparse, cheap, { catalog: sparse, selection: anthropicOnly(2), resolved: sonnet })).toEqual(sonnet);
  });

  test("an internal proof of a kept rank's saved choice exempts it only as exactly that model at or under its capability", () => {
    const fable = { provider: "anthropic", id: "claude-fable-5" }, sonnet = { provider: "anthropic", id: "claude-sonnet-5" };
    // Fable laddered at 1 under Sonnet 2 and Opus 3: a kept 4 meant Opus, a kept 1 meant Fable.
    const ranked = compileCatalog({ schemaVersion: 1, models: [
      model("fable", "anthropic", 1, { id: fable.id }), model("sonnet", "anthropic", 2, { id: sonnet.id }),
      model("opus", "anthropic", 3, { id: "claude-opus-5" }),
    ] });
    const authored = compileCatalog({ schemaVersion: 1, models: [model("fable", "anthropic", 4, { id: fable.id })] });
    const elite = { catalog: ranked, selection: anthropicOnly(4) }, premium = { ...fable, tier: 4 as const };
    // Unproved, the kept rank names no active identity; proved as the very Fable it now names at 4, it does.
    expect(newPremiumLead(authored, anthropicOnly(2), elite)).toEqual(premium);
    expect(newPremiumLead(authored, anthropicOnly(2), { ...elite, resolved: fable })).toBeNull();
    // A proof of another model, of the same id on another provider, or of an unknown id is no proof.
    for (const resolved of [{ provider: "anthropic", id: "claude-opus-5" }, { provider: "vendor-example", id: fable.id }, { provider: "anthropic", id: "claude-fable-9" }]) {
      expect(newPremiumLead(authored, anthropicOnly(2), { ...elite, resolved })).toEqual(premium);
    }
    // A proof under its model's actual tier is no proof: kept rank 1 is admitted as strictly as without one,
    // while the unambiguous kept rank 2 keeps the unchanged authored identity's existing exemption.
    const lonelySonnet = compileCatalog({ schemaVersion: 1, models: [model("sonnet", "anthropic", 2, { id: sonnet.id })] });
    expect(newPremiumLead(lonelySonnet, anthropicOnly(1), { catalog: ranked, selection: anthropicOnly(1), resolved: sonnet })).toEqual({ ...sonnet, tier: 2 });
    expect(newPremiumLead(lonelySonnet, anthropicOnly(1), { catalog: ranked, selection: anthropicOnly(2) })).toBeNull();
  });

  test("two stored rungs read at one tier both stay listed, one deterministic rung, the other's kept rank refused", () => {
    const versions = [model("old", "anthropic", 1, { id: "claude-opus-4-6" }), model("new", "anthropic", 2, { id: "claude-opus-5" })];
    for (const models of [versions, [...versions].reverse()]) {
      const catalog = compileCatalog({ schemaVersion: 1, models });
      expect(catalog.models.map(value => [value.key, value.tier]).sort()).toEqual([["new", 3], ["old", 3]]);
      expect(catalog.model("old")).toMatchObject({ id: "claude-opus-4-6", tier: 3 });
      expect([1, 2, 3, 4].map(tier => catalog.rung("anthropic", tier))).toEqual(["new", "new", "new", "new"]);
      // A kept rank 1 meant the old Opus; a new rank 1 names the rung's Opus, above it, and no proof of the old one helps.
      expect(() => catalog.assertUnambiguousSelection("anthropic", 1)).toThrow("code_invalid_selection");
      expect(leadKey(catalog, 1)).toBe("new");
      expect(newPremiumLead(catalog, anthropicOnly(1), { catalog, selection: anthropicOnly(1),
        resolved: { provider: "anthropic", id: "claude-opus-4-6" } })).toEqual({ provider: "anthropic", id: "claude-opus-5", tier: 3 });
      expect([leadKey(catalog, 2), leadKey(catalog, 3)]).toEqual(["new", "new"]);
    }
    // A model read at its own stored tier keeps its rung over one moved onto it.
    const kept = [model("haiku", "anthropic", 1, { id: "claude-haiku-5" }), model("old", "anthropic", 2, { id: "claude-opus-4-6" }),
      model("opus", "anthropic", 3, { id: "claude-opus-5" })];
    for (const models of [kept, [...kept].reverse()]) {
      const catalog = compileCatalog({ schemaVersion: 1, models });
      expect([1, 2, 3].map(tier => catalog.rung("anthropic", tier))).toEqual(["haiku", "haiku", "opus"]);
      expect(catalog.models.map(value => value.key).sort()).toEqual(["haiku", "old", "opus"]);
      expect(() => catalog.assertUnambiguousSelection("anthropic", 2)).toThrow("code_invalid_selection");
      expect(leadKey(catalog, 2)).toBe("haiku");
      expect([leadKey(catalog, 1), leadKey(catalog, 3)]).toEqual(["haiku", "opus"]);
    }
    // A stored tier of its own is still one model per family rung.
    expect(() => compileCatalog({ schemaVersion: 1, models: [versions[0]!, { ...versions[1]!, tier: 1 }] })).toThrow("code_invalid_catalog");
  });

  test("models no family name places keep their stored tiers and are never reclassified", () => {
    const generic = compileCatalog(document());
    expect(generic.models.every(value => !generic.isReclassified(value.key))).toBe(true);
    const unnamed = compileCatalog({ schemaVersion: 1, models: [
      model("e1", "anthropic", 1, { id: "entry1" }), model("e2", "anthropic", 2, { id: "entry2" }),
    ] });
    expect([unnamed.models.map(value => value.tier), unnamed.isReclassified("e2"), leadKey(unnamed, 2)]).toEqual([[1, 2], false, "e2"]);
    // Another family's names are not its own: a generic provider has none.
    const vendor = compileCatalog({ schemaVersion: 1, models: [model("v", "vendor-example", 2, { id: "claude-opus-5" })] });
    expect([vendor.model("v").tier, vendor.isReclassified("v")]).toEqual([2, false]);
    expect(() => vendor.assertUnambiguousSelection("vendor-example", 1)).not.toThrow();
  });
});

describe("structured route selection", () => {
  test("routine deliberation stays at the selected rung; only an explicit elite selection reaches elite", () => {
    const catalog = compileCatalog(document());
    const mixed = reviewCatalog(catalog, selection({ capability: 3 }), daytime);
    expect(mixed.available.capabilities).toEqual([1, 2, 3]);
    expect(route(mixed.routes, "default").lead.key).toBe("o3");
    for (const roleName of ["plan", "slow"]) expect(route(mixed.routes, roleName).lead).toEqual({ key: "a3", thinking: "high" });
    expect(mixed.routes.flatMap(value => [value.lead, ...value.fallback]).some(value => value.key === "a4")).toBe(false);
    expect(() => reviewCatalog(catalog, selection({ capability: 4 }), daytime)).toThrow("code_invalid_selection");
    const elite = reviewCatalog(catalog, selection({ capability: 4, lane: { kind: "provider", family: "anthropic", blend: "only" } }), daytime);
    for (const roleName of ["default", "task", "plan", "slow"]) expect(route(elite.routes, roleName).lead.key).toBe("a4");
    for (const roleName of ["smol", "memory", "widget", "tiny", "commit"]) expect(route(elite.routes, roleName).lead.key).toBe("a1");
  });

  test("sparse cross-family ladders cannot promote a routine fallback into elite", () => {
    const catalog = compileCatalog({ schemaVersion: 1, models: [
      ...document().models.filter(value => value.provider === "anthropic"),
      model("o4", "openai", 4),
    ] });
    const chosen = selection({ lane: { kind: "provider", family: "anthropic", blend: "led" } });
    const routine = reviewCatalog(catalog, chosen, daytime);
    for (const [roleName, thinking] of [["default", "medium"], ["task", "medium"], ["plan", "high"], ["slow", "high"], ["vision", "low"]] as const) {
      expect(route(routine.routes, roleName).fallback).toEqual([{ key: "a1", thinking }]);
    }
    expect(routine.routes.flatMap(value => [value.lead, ...value.fallback]).some(value => value.key === "o4")).toBe(false);
    expect(Object.values(compileOmpOverlay(catalog, chosen, routine.routes).retry?.fallbackChains ?? {}).flat()
      .some(reference => reference.startsWith("openai/"))).toBe(false);
    const elite = reviewCatalog(catalog, { ...chosen, capability: 4 }, daytime);
    expect(route(elite.routes, "default").fallback.map(value => value.key)).toContain("o4");
    const explicitAstra = reviewCatalog(catalog, { ...chosen, lane: { kind: "provider", family: "openai", blend: "only" }, capability: 4 }, daytime);
    expect(compileOmpOverlay(catalog, explicitAstra.selection, explicitAstra.routes).modelRoles?.default).toBe("openai/native-o4:medium");
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
        for (const roleName of ["plan", "slow"]) expect(route(review.routes, roleName).lead).toEqual({ key: `${prefix}${capability}`, thinking: "high" });
      }
      expect(() => reviewCatalog(catalog, selection({ lane: { kind: "provider", family, blend: "only" }, capability: 4 }), daytime))
        .toThrow("code_invalid_selection");
    }
  });

  test("shared deliberation follows the selected lane and only explicit advisors cross led families", () => {
    const catalog = compileCatalog(document());
    for (const blend of ["led", "only"] as const) {
      const review = reviewCatalog(catalog, selection({ advisor: "audit", lane: { kind: "provider", family: "deepseek", blend } }), daytime);
      for (const roleName of ["plan", "slow"]) expect(route(review.routes, roleName).lead).toEqual({ key: "d2", thinking: "high" });
      expect(catalog.family(route(review.routes, "advisor").lead.key)).toBe(blend === "only" ? "deepseek" : "anthropic");
    }
    const noPreferredCross = document();
    noPreferredCross.models = noPreferredCross.models.filter(value => value.provider !== "anthropic");
    const reduced = compileCatalog(noPreferredCross);
    const review = reviewCatalog(reduced, selection({ advisor: "glance", lane: { kind: "provider", family: "openai", blend: "led" } }), daytime);
    expect(catalog.family(route(review.routes, "slow").lead.key)).toBe("openai");
    expect(catalog.family(route(review.routes, "advisor").lead.key)).toBe("deepseek");
  });

  test("deliberation adjusts only effort, preserving explicit extremes and cheap helper routes", () => {
    const catalog = compileCatalog(document());
    for (const [thinking, deliberative] of [
      ["minimal", "minimal"], ["low", "medium"], ["medium", "high"],
      ["high", "xhigh"], ["xhigh", "xhigh"], ["max", "max"],
    ] as const) {
      for (const [lane, mainKey, deliberativeKey, helperKey, advisorKey] of [
        [{ kind: "mixed" }, "o2", "a2", "o1", "a1"],
        [{ kind: "provider", family: "openai", blend: "only" }, "o2", "o2", "o1", "o1"],
        [{ kind: "provider", family: "anthropic", blend: "only" }, "a2", "a2", "a1", "a1"],
        [{ kind: "provider", family: "anthropic", blend: "led" }, "a2", "a2", "a1", "o1"],
      ] as const) {
        const review = reviewCatalog(catalog, selection({ lane, thinking, advisor: "glance" }), daytime);
        expect(review.selection.thinking).toBe(thinking);
        for (const roleName of ["default", "task", "plan", "slow"]) {
          const value = route(review.routes, roleName);
          const deliberates = roleName === "plan" || roleName === "slow";
          const effort = deliberates ? deliberative : thinking;
          expect(value.lead).toEqual({ key: deliberates ? deliberativeKey : mainKey, thinking: effort });
          for (const choice of [value.lead, ...value.fallback]) {
            expect(choice.thinking).toBe(effort);
            expect(catalog.model(choice.key).tier).toBeLessThanOrEqual(2);
          }
        }
        for (const [roleName, effort] of [
          ["smol", "medium"], ["memory", "medium"], ["widget", "low"], ["tiny", "low"], ["commit", "low"],
        ] as const) {
          const value = route(review.routes, roleName);
          expect(value.lead).toEqual({ key: helperKey, thinking: effort });
          expect(value.fallback).toEqual([]);
        }
        expect(route(review.routes, "advisor").lead).toEqual({ key: advisorKey, thinking: "low" });
        const image = route(review.routes, "vision");
        expect([image.lead, ...image.fallback].every(choice => choice.thinking === "low")).toBe(true);
      }
    }
  });

  test("thinking gaps round down and floors round up without propagating main extremes to utility roles", () => {
    const input = document();
    input.models = input.models.map(value => ({ ...value, thinkingLevels: ["low", "medium", "high", "max"] }));
    const catalog = compileCatalog(input);
    for (const [thinking, main, deliberative] of [
      ["minimal", "low", "low"], ["low", "low", "medium"], ["medium", "medium", "high"],
      ["high", "high", "high"], ["xhigh", "high", "high"], ["max", "max", "max"],
    ] as const) {
      const review = reviewCatalog(catalog, selection({ thinking }), daytime);
      for (const [roleName, effort] of [["default", main], ["task", main], ["plan", deliberative], ["slow", deliberative]] as const) {
        const value = route(review.routes, roleName);
        expect([value.lead, ...value.fallback].every(choice => choice.thinking === effort)).toBe(true);
      }
    }
    const maximum = reviewCatalog(catalog, selection({ thinking: "max", advisor: "glance" }), daytime);
    for (const roleName of ["default", "task"]) expect(route(maximum.routes, roleName).lead.thinking).toBe("max");
    for (const roleName of ["plan", "slow"]) expect(route(maximum.routes, roleName).lead.thinking).toBe("max");
    expect(route(maximum.routes, "smol").lead).toEqual({ key: "o1", thinking: "medium" });
    expect(route(maximum.routes, "memory").lead).toEqual({ key: "o1", thinking: "medium" });
    for (const roleName of ["widget", "tiny", "commit"]) expect(route(maximum.routes, roleName).lead).toEqual({ key: "o1", thinking: "low" });
    expect(route(maximum.routes, "advisor").lead).toEqual({ key: "a1", thinking: "low" });
    const image = route(maximum.routes, "vision");
    expect([image.lead, ...image.fallback].every(choice => choice.thinking === "low")).toBe(true);
    const overlay = compileOmpOverlay(catalog, maximum.selection, maximum.routes);
    expect(overlay.modelRoles?.widget).toBe("openai/native-o1:low");
    expect(overlay.retry?.fallbackChains?.widget).toEqual([]);
    expect(overlay.modelRoles?.memory).toBe("openai/native-o1:medium");
    expect(overlay.retry?.fallbackChains?.memory).toEqual([]);
    expect(overlay).not.toHaveProperty("memory");
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

  test("priority requires actual lane availability; a stored Spark is read as off and routes nothing to the retired tier", () => {
    const catalog = compileCatalog(document());
    const review = reviewCatalog(catalog, selection({ spark: true, priority: true, capability: 1 }), daytime);
    expect(review.selection.spark).toBe(false);
    for (const roleName of ["commit", "tiny", "widget", "memory", "smol"]) expect(route(review.routes, roleName).lead.key).toBe("o1");
    const pure = selection({ lane: { kind: "provider", family: "anthropic", blend: "only" } });
    expect(reviewCatalog(catalog, { ...pure, spark: true }, daytime).selection.spark).toBe(false);
    expect(() => reviewCatalog(catalog, { ...pure, priority: true }, daytime)).toThrow("code_invalid_selection");
  });
});

describe("review to OMP boundary", () => {
  test("only native shared roles and their fallback chains reach OMP, preserving exact provider identity", () => {
    const catalog = compileCatalog(document());
    const review = reviewCatalog(catalog, selection({ advisor: "audit", prewalk: true, priority: true, planYolo: true }), daytime);
    expect(ReviewSchema.parse(review)).toEqual(review);
    const overlay = compileOmpOverlay(catalog, review.selection, review.routes);
    const roles = ["default", "task", "plan", "slow", "advisor", "vision", "smol", "memory", "widget", "tiny", "commit"];
    expect(review.routes.map(value => value.role)).toEqual(roles);
    expect(Object.keys(overlay.modelRoles ?? {})).toEqual(roles);
    expect(Object.keys(overlay.retry?.fallbackChains ?? {})).toEqual(roles);
    for (const value of review.routes) {
      const lead = catalog.model(value.lead.key);
      expect(overlay.modelRoles?.[value.role]).toBe(`${lead.provider}/${lead.id}:${value.lead.thinking}`);
      expect(overlay.retry?.fallbackChains?.[value.role]).toEqual(value.fallback.map(fallback => {
        const model = catalog.model(fallback.key);
        return `${model.provider}/${model.id}:${fallback.thinking}`;
      }));
      expect(Object.keys(value)).toEqual(["role", "lead", "fallback"]);
    }
    expect(overlay.modelRoles?.default).toBe("openai-codex/native-o2:medium");
    expect(overlay.retry?.fallbackChains?.default?.[0]).toBe("openai/native-o1:medium");
    expect(overlay.retry?.fallbackChains?.commit).toEqual([]);
    expect(overlay.retry?.fallbackChains?.widget).toEqual([]);
    expect(overlay.retry?.fallbackChains?.memory).toEqual([]);
    expect(overlay).not.toHaveProperty("memory");
    expect(overlay.task?.agentAdvisor).toEqual({ task: "on" });
    expect(overlay.task?.prewalk).toBe(true);
    expect(overlay.task).toEqual({ agentAdvisor: { task: "on" }, prewalk: true });
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
    const review = reviewCatalog(catalog, selection({ capability: 1, advisor: "review", thinking: "max" }), daytime);
    expect(route(review.routes, "advisor")).toMatchObject({ lead: { key: "a2", thinking: "medium" }, fallback: [{ key: "a1", thinking: "low" }] });
    for (const advisor of ["off", "glance", "review"] as const) {
      const ordinary = reviewCatalog(catalog, selection({ advisor }), daytime);
      expect(compileOmpOverlay(catalog, ordinary.selection, ordinary.routes).task).toEqual({});
    }
  });

  test("task options are emitted only when explicitly enabled, without named-agent routing", () => {
    const catalog = compileCatalog(document());
    const prewalk = reviewCatalog(catalog, selection({ prewalk: true }), daytime);
    expect(compileOmpOverlay(catalog, prewalk.selection, prewalk.routes).task).toEqual({ prewalk: true });
    const audit = reviewCatalog(catalog, selection({ advisor: "audit" }), daytime);
    expect(compileOmpOverlay(catalog, audit.selection, audit.routes).task).toEqual({ agentAdvisor: { task: "on" } });
    const off = reviewCatalog(catalog, selection(), daytime);
    expect(off.routes.map(value => value.role)).toEqual(["default", "task", "plan", "slow", "vision", "smol", "memory", "widget", "tiny", "commit"]);
    expect(Object.keys(compileOmpOverlay(catalog, off.selection, off.routes).modelRoles ?? {})).toEqual(off.routes.map(value => value.role));
  });

  test("fallback off removes preview model switches without disabling same-model retries", () => {
    const catalog = compileCatalog(document());
    const review = reviewCatalog(catalog, selection({ fallback: false, advisor: "audit" }), daytime);
    expect(review.routes.every(value => value.fallback.length === 0)).toBe(true);
    expect(compileOmpOverlay(catalog, review.selection, review.routes).retry)
      .toEqual({ enabled: true, modelFallback: false, fallbackChains: { memory: [], widget: [] } });
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
    expect(familyPolicy("openai").priority?.costMultiplier).toBe(2);
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

describe("a verified catalog and the accounts a launch meets", () => {
  test("a preview selection keeps every choice the verified catalog hosts and narrows only the ones it lacks", () => {
    const openaiOnly = compileCatalog({ schemaVersion: 1, models: document().models.filter(entry => providerPolicy(entry.provider).family === "openai") });
    const wanted = selection({ lane: { kind: "provider", family: "anthropic", blend: "led" }, capability: 4, thinking: "high",
      advisor: "review", spark: true, priority: true, prewalk: true, planYolo: true, fallback: false });
    // No Anthropic and no fourth rung: the default lane and the highest capability below 4.
    expect(clampSelection(openaiOnly, wanted)).toEqual({ ...wanted, lane: { kind: "provider", family: "openai", blend: "only" }, capability: 3, spark: false });
    // A family that survived keeps its lane in the blend the catalog still offers.
    expect(clampSelection(openaiOnly, { ...wanted, lane: { kind: "provider", family: "openai", blend: "led" } }).lane)
      .toEqual({ kind: "provider", family: "openai", blend: "only" });
    const full = compileCatalog(document());
    expect(clampSelection(full, wanted)).toEqual({ ...wanted, spark: false });
    // Spark is retired: a preview that asked for it is narrowed to off, never refused.
    expect(clampSelection(full, selection({ spark: true })).spark).toBe(false);
    expect(clampSelection(full, null)).toEqual(defaultSelection(full));
    // The budget is a constraint: a free preview this paid catalog cannot serve refuses rather than spends.
    expect(() => clampSelection(full, selection({ budget: "free" }))).toThrow("code_budget_unsatisfiable");
  });

  // Claude-led at capability 3: the API tier-2 rung appears only in fallbacks; the glance advisor leads on Codex.
  const crossed = () => compileCatalog({ schemaVersion: 1, models: [
    model("o1", "openai-codex", 1), model("o2", "openai", 2, { inputCostPerMillion: 1 }), model("o3", "openai-codex", 3, { inputCostPerMillion: 8 }),
    model("a1", "anthropic", 1), model("a2", "anthropic", 2), model("a3", "anthropic", 3),
  ] });
  const claudeLed = () => selection({ lane: { kind: "provider", family: "anthropic", blend: "led" }, capability: 3, advisor: "glance" });

  test("a fallback no included account serves is pruned exactly, while an unserved lead refuses", () => {
    const catalog = crossed(), chosen = claudeLed();
    const review = reviewCatalog(catalog, chosen, daytime);
    expect(review.routes.some(entry => entry.fallback.some(choice => choice.key === "o2"))).toBe(true);
    expect(review.routes.some(entry => entry.lead.key === "o2")).toBe(false);
    const serves = (provider: string) => provider !== "openai";
    const pruned = servedRoutes(catalog, review.routes, serves);
    expect(pruned.map(entry => entry.lead)).toEqual(review.routes.map(entry => entry.lead));
    expect(pruned.map(entry => entry.fallback)).toEqual(review.routes.map(entry => entry.fallback.filter(choice => choice.key !== "o2")));
    const overlay = compileOmpOverlay(catalog, chosen, pruned, serves);
    expect(Object.values(overlay.retry?.fallbackChains ?? {}).flat().some(reference => reference.startsWith("openai/"))).toBe(false);
    // Exactly the served routes: neither the unpruned ones nor pruned ones without the rule that pruned them.
    expect(() => compileOmpOverlay(catalog, chosen, review.routes, serves)).toThrow("code_invalid_selection");
    expect(() => compileOmpOverlay(catalog, chosen, pruned)).toThrow("code_invalid_selection");
    expect(() => servedRoutes(catalog, review.routes, provider => provider !== "openai-codex")).toThrow("code_account_unavailable");
  });

  test("judged beforehand, the door's rule refuses only an unserved lead and notes the fallbacks it drops", () => {
    const catalog = crossed();
    const review = reviewCatalog(catalog, claudeLed(), daytime);
    const withoutApi = (provider: string) => provider !== "openai";
    const service = routeService(catalog, review.routes, withoutApi);
    expect(service.lead).toBeNull();
    const pruned = servedRoutes(catalog, review.routes, withoutApi);
    expect(service.pruned).toEqual([{ provider: "openai", family: "openai",
      roles: review.routes.filter((entry, index) => entry.fallback.length !== pruned[index]!.fallback.length).map(entry => entry.role) }]);
    // Without Codex the roles it leads are unserved: the door refuses, and the judgement names the provider and those roles.
    const withoutCodex = routeService(catalog, review.routes, provider => provider !== "openai-codex");
    expect(withoutCodex.lead).toEqual({ provider: "openai-codex", family: "openai",
      roles: review.routes.filter(entry => catalog.model(entry.lead.key).provider === "openai-codex").map(entry => entry.role) });
    expect(() => servedRoutes(catalog, review.routes, provider => provider !== "openai-codex")).toThrow("code_account_unavailable");
  });

  test("a published list that lacks a routed model, lead or fallback, names it once, by provider and id together", () => {
    const catalog = compileCatalog(document());
    const review = reviewCatalog(catalog, selection({ capability: 1, advisor: "audit" }), daytime);
    const routed = routedModels(catalog, review.routes);
    expect(unpublishedModels(routed, document().models)).toEqual([]);
    // The audit advisor falls back to a2 and then a1; a2 dropped from what OMP publishes is named once.
    expect(route(review.routes, "advisor").fallback.map(choice => choice.key)).toEqual(["a2", "a1"]);
    expect(unpublishedModels(routed, document().models.filter(entry => entry.key !== "a2"))).toEqual(["anthropic/native-a2"]);
    // The same id under another provider is another model, and several are named in order.
    const opus = { provider: "anthropic", id: "claude-opus" }, terra = { provider: "openai-codex", id: "gpt-terra" };
    expect(unpublishedModels([terra, opus, terra], [{ provider: "openrouter", id: "claude-opus" }])).toEqual(["anthropic/claude-opus", "openai-codex/gpt-terra"]);
  });
});
