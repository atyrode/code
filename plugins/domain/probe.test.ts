import { describe, expect, test } from "bun:test";
import { PROBE_MODEL_LIMIT, ThinkingLevelSchema, parseBenchmarkObservation, parseInventoryObservation, type InventoryReceipt, type ModelCatalogSnapshot,
  type ThinkingLevel } from "@atyrode/manifold-omp";
import { benchmarkCandidates, catalogFromMetadata, catalogFromObservations, inventoryDraft, quotaSpecials, type ScaffoldOptions } from "./probe.ts";
import { compileCatalog } from "./catalog.ts";
import { compileOmpOverlay, defaultSelection, reviewCatalog } from "./routing.ts";

const identity = { provider: "anthropic", id: "claude-sonnet-5", api: "anthropic-messages" };
function row(provider = identity.provider, id = identity.id) {
  return { provider, id, selector: `${provider}/${id}`, name: "not part of the receipt", contextWindow: 200000, maxTokens: 64000,
    reasoning: true, thinking: ["low", "high"], input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
}
const inventory = (): InventoryReceipt => parseInventoryObservation({ models: [row()] }, [identity], 100, "18.1.14");
function report(input = benchmarkCandidates(inventory())) {
  return { runs: 1, maxTokens: 4, profile: "chat", failures: 0,
    models: input.candidates.map(candidate => ({ selector: `${candidate.provider}/${candidate.id}`, model: `${candidate.provider}/${candidate.id}`,
      results: [{ ok: true, challenge: "chat", ttftMs: 700, generationTps: 62, tokensPerSecond: 5 }],
      stats: Object.fromEntries([["ttftMs", 700], ["generationTps", 62], ["tokensPerSecond", 5]].map(([key, value]) =>
        [key, { mean: value, min: value, p50: value, p95: value, max: value }])) })) };
}
function fullInventory(): InventoryReceipt {
  const models = [
    { provider: "anthropic", id: "claude-haiku-5", cost: 1, level: "low" },
    { provider: "anthropic", id: "claude-sonnet-5", cost: 3, level: "high" },
    { provider: "anthropic", id: "claude-opus-5", cost: 5, level: "max" },
    { provider: "openai-codex", id: "gpt-mini-6", cost: 1, level: "low" },
    { provider: "openai-codex", id: "gpt-standard-6", cost: 3, level: "high" },
    { provider: "openai-codex", id: "gpt-pro-6", cost: 5, level: "max" },
  ];
  return parseInventoryObservation({ models: models.map(model => ({ ...row(model.provider, model.id), thinking: [model.level], cost: { input: model.cost, output: model.cost * 5, cacheRead: 0, cacheWrite: 0 } })) },
    models.map(({ provider, id }) => ({ provider, id, api: provider === "anthropic" ? "anthropic-messages" : "openai-codex-responses" })), 100, "18.1.14");
}

function fourLevelInventory(): InventoryReceipt {
  const inv = fullInventory(), levels = ["low", "medium", "high", "max"] as const;
  // Four families, not four versions: `series-1`..`series-4` would be one family, and
  // supersession keeps only its newest member.
  inv.models = ["openai-codex", "anthropic"].flatMap(provider => {
    const model = inv.models.find(value => value.provider === provider)!;
    return levels.map((level, index) => ({ ...model, id: `series${index + 1}`,
      inputCostPerMillion: index + 1, outputCostPerMillion: (index + 1) * 5,
      contextWindow: (index + 1) * 100000, thinkingLevels: [level] }));
  });
  return inv;
}

type Row = InventoryReceipt["models"][number];
const apis: Record<string, string> = { "openai-codex": "openai-codex-responses", anthropic: "anthropic-messages", deepseek: "openai-completions" };
/** A row with the input price, context window, thinking range and image support OMP 18.1.14's
 * bundled `pi-catalog` lists for it; no rule here reads the output price. */
function listed(provider: string, id: string, input: number, context: number, low: ThinkingLevel, high: ThinkingLevel, images = true): Row {
  const scale = ThinkingLevelSchema.options;
  return { provider, id, api: apis[provider]!, inputCostPerMillion: input, outputCostPerMillion: input * 5, contextWindow: context,
    maxTokens: 128000, reasoning: true, thinkingLevels: scale.slice(scale.indexOf(low), scale.indexOf(high) + 1), images };
}
function receiptOf(models: Row[]): InventoryReceipt {
  return { schemaVersion: 1, kind: "inventory", ompVersion: "18.1.14", observedAt: 100, models };
}
/** A benchmark of every candidate: reachable, except the ids given another verdict. */
function observed(inv: InventoryReceipt, verdicts: Record<string, "not_found" | "client_blocked"> = {},
  options: ScaffoldOptions = { specials: [], budget: "any" }) {
  const input = benchmarkCandidates(inv, options), receipt = parseBenchmarkObservation(report(input), input, 101, 200);
  return { ...receipt, results: receipt.results.map(result => verdicts[result.id]
    ? { ...result, status: verdicts[result.id], tokensPerSecond: null, timeToFirstTokenMs: null } : result) };
}
/** The catalog an inventory derives when every candidate answers: the ladder rules alone. */
function derived(inv: InventoryReceipt, options: ScaffoldOptions = { specials: [], budget: "any" }) {
  return catalogFromObservations(inv, observed(inv, {}, options), options);
}
/** OMP 18.1.14's bundled OpenAI chat rows: what the starter and today's pinned inventory list. */
function openai1814(): Row[] {
  return [
    listed("openai-codex", "gpt-5.4", 2.5, 272_000, "low", "xhigh"),
    listed("openai-codex", "gpt-5.4-mini", 0.75, 272_000, "low", "xhigh"),
    listed("openai-codex", "gpt-5.5", 5, 272_000, "low", "xhigh"),
    listed("openai-codex", "gpt-5.6-luna", 0.2, 1_000_000, "low", "max"),
    listed("openai-codex", "gpt-5.6-sol", 4, 1_000_000, "low", "max"),
    listed("openai-codex", "gpt-5.6-terra", 2, 1_000_000, "low", "max"),
    listed("openai-codex", "gpt-6-astra", 10, 272_000, "low", "max"),
    listed("openai-codex", "gpt-daybreak-blue-latest", 5, 272_000, "low", "max"),
  ];
}
/** The 18.1.14 Anthropic rows that decide its ladder, including the superseded `claude-opus-4-6`. */
function anthropic1814(): Row[] {
  return [
    listed("anthropic", "claude-haiku-4-5", 1, 200_000, "minimal", "xhigh"),
    listed("anthropic", "claude-sonnet-5", 2, 1_000_000, "low", "max"),
    { ...listed("anthropic", "claude-opus-4-6", 5, 1_000_000, "low", "max"), thinkingLevels: ["low", "medium", "high", "max"] },
    listed("anthropic", "claude-opus-5", 5, 1_000_000, "low", "max"),
    listed("anthropic", "claude-fable-5-1", 10, 1_000_000, "low", "max"),
  ];
}
const tiers = (document: { models: readonly { provider: string; tier: number; id: string }[] }, provider: string) =>
  document.models.filter(model => model.provider === provider).map(model => [model.tier, model.id]);


describe("pure typed scaffolding", () => {
  test("a draft is the charge and never a catalog, even where no ladder exists yet; certified documents keep family tiers and quota buckets", () => {
    const inv = fullInventory(), draft = inventoryDraft(inv, "any");
    expect(draft).toEqual({ schemaVersion: 1, kind: "draft", inventoryObservedAt: 100, benchmark: benchmarkCandidates(inv), exclusions: [] });
    expect(inventoryDraft({ ...inv, models: [...inv.models].reverse() }, "any")).toEqual(draft);
    // One Anthropic row cannot form a required ladder, yet what probing it costs is still stated.
    const single = { ...inv, models: inv.models.filter(model => model.id === "claude-haiku-5") };
    expect(inventoryDraft(single, "any").benchmark.candidates.map(candidate => candidate.id)).toEqual(["claude-haiku-5"]);
    expect(() => derived(single)).toThrow("probe_insufficient_ladder");
    const receipt = parseBenchmarkObservation(report(draft.benchmark), draft.benchmark, 101, 200);
    const { document } = catalogFromObservations(inv, receipt);
    expect(document.models.filter(model => model.provider === "anthropic").map(model => [model.tier, model.id, model.quotaBucket])).toEqual([
      [1, "claude-haiku-5", "claude"], [2, "claude-sonnet-5", "claude"], [3, "claude-opus-5", "claude"],
    ]);
    expect(document.models.filter(model => model.provider === "openai-codex").map(model => model.quotaBucket)).toEqual(["codex", "codex", "codex"]);
    expect(document.models.every(model => model.tokensPerSecond === 62 && model.timeToFirstTokenMs === 700)).toBe(true);
  });
  test("generic zero-cost nonreasoning providers produce a reviewed exact route", () => {
    const genericIdentity = { provider: "vendor-example", id: "free-model", api: "vendor-chat" };
    const inv = parseInventoryObservation({ models: [{
      ...row(genericIdentity.provider, genericIdentity.id), reasoning: false, thinking: null,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }] }, [genericIdentity], 100, "18.1.14");
    const draft = inventoryDraft(inv, "any");
    expect(draft.benchmark.candidates).toEqual([{ ...genericIdentity, key: "vendor-example.free-model" }]);
    const receipt = parseBenchmarkObservation(report(draft.benchmark), draft.benchmark, 101, 200);
    const { document } = catalogFromObservations(inv, receipt);
    expect(document.models).toEqual([expect.objectContaining({
      key: "vendor-example.free-model", provider: "vendor-example", id: "free-model", api: "vendor-chat",
      tier: 1, quotaBucket: null, inputCostPerMillion: 0, outputCostPerMillion: 0,
      thinkingLevels: ["minimal"],
    })]);
    const catalog = compileCatalog(document), review = reviewCatalog(catalog, defaultSelection(catalog), 200);
    expect(compileOmpOverlay(catalog, review.selection, review.routes).modelRoles?.default)
      .toBe("vendor-example/free-model:minimal");
  });
  test("four distinct families produce four reviewed and routable levels in both provider families", () => {
    const inv = fourLevelInventory(), draft = inventoryDraft(inv, "any");
    const receipt = parseBenchmarkObservation(report(draft.benchmark), draft.benchmark, 101, 200);
    const result = catalogFromObservations(inv, receipt), catalog = compileCatalog(result.document);
    for (const [family, provider] of [["openai", "openai-codex"], ["anthropic", "anthropic"]] as const) {
      expect(draft.benchmark.candidates.filter(model => model.provider === provider).map(model => model.id))
        .toEqual(["series1", "series2", "series3", "series4"]);
      expect(result.document.models.filter(model => model.provider === provider).map(model => [model.tier, model.id]))
        .toEqual([[1, "series1"], [2, "series2"], [3, "series3"], [4, "series4"]]);
      for (const capability of [1, 2, 3, 4] as const) {
        const review = reviewCatalog(catalog, { ...defaultSelection(catalog), capability, thinking: "max",
          lane: { kind: "provider", family, blend: "only" } }, 200);
        expect(review.available.capabilities).toEqual([1, 2, 3, 4]);
        const overlay = compileOmpOverlay(catalog, review.selection, review.routes);
        expect(overlay.modelRoles?.default).toBe(`${provider}/series${capability}:${["low", "medium", "high", "max"][capability - 1]}`);
        expect(review.routes.find(route => route.role === "plan")?.lead.key).toBe(`${provider}.series${Math.min(4, capability + 1)}`);
        if (capability === 4) {
          expect(review.routes.find(route => route.role === "task")?.fallback.map(choice => choice.key))
            .toEqual([`${provider}.series3`, `${provider}.series2`]);
          expect(review.routes.find(route => route.role === "scout")?.lead.key).toBe(`${provider}.series2`);
          expect(review.routes.find(route => route.role === "commit")?.lead.key).toBe(`${provider}.series1`);
        }
      }
    }
    expect(inventoryDraft({ ...inv, models: [...inv.models].reverse() }, "any")).toEqual(draft);
    expect(catalogFromObservations({ ...inv, models: [...inv.models].reverse() },
      { ...receipt, results: [...receipt.results].reverse() })).toEqual(result);
  });
  test("equal prices do not reverse observed capability progression", () => {
    const inv = fourLevelInventory();
    inv.models = inv.models.filter(model => model.provider === "anthropic").map(model => ({ ...model, inputCostPerMillion: 1 }));
    const catalog = compileCatalog(derived(inv).document);
    expect([1, 2, 3, 4].map(tier => catalog.model(catalog.rung("anthropic", tier)).id)).toEqual(["series1", "series2", "series3", "series4"]);
    const review = reviewCatalog(catalog, { ...defaultSelection(catalog), capability: 4 }, 200);
    expect(compileOmpOverlay(catalog, review.selection, review.routes).modelRoles?.default).toBe("anthropic/series4:max");
  });
  test("a rung of unknown context is admitted, while a known context regression is rejected by name", () => {
    const inv = fourLevelInventory(), base = inv.models[0]!;
    inv.models = [
      { ...base, id: "entry", inputCostPerMillion: 1, contextWindow: 100000, thinkingLevels: ["low"] },
      { ...base, id: "bridge", inputCostPerMillion: 2, contextWindow: null, thinkingLevels: ["medium"] },
      { ...base, id: "narrow", inputCostPerMillion: 3, contextWindow: 50000, thinkingLevels: ["high"] },
      { ...base, id: "top", inputCostPerMillion: 4, contextWindow: 500000, thinkingLevels: ["max"] },
    ];
    const result = derived(inv);
    expect(result.document.models.map(model => [model.tier, model.id])).toEqual([[1, "entry"], [2, "bridge"], [3, "top"]]);
    expect(result.exclusions).toEqual([{ provider: "openai-codex", id: "narrow", reason: "regression" }]);
  });
  test("the maximum inventory of three antichains retains the preferred real fallback independent of order", () => {
    const inv = fourLevelInventory(), base = inv.models[0]!;
    const levels = ["low", "high", "max"] as const;
    // Across groups every edge is valid; within each group context decreases
    // as price rises. There are many middle pairs but no four-rung ladder.
    inv.models = Array.from({ length: PROBE_MODEL_LIMIT }, (_, index) => {
      const group = index < 85 ? 0 : index < 171 ? 1 : 2;
      return { ...base, id: `adversary${index + 1}`, inputCostPerMillion: index + 1,
        contextWindow: (group + 1) * 100000 - index, thinkingLevels: [levels[group]!] };
    });
    const result = derived(inv);
    expect(result.document.models.map(model => [model.tier, model.id]))
      .toEqual([[1, "adversary1"], [2, "adversary86"], [3, "adversary172"]]);
    expect(inventoryDraft(inv, "any").benchmark.candidates.map(model => model.id)).toEqual(inv.models.map(model => model.id).sort());
    expect(derived({ ...inv, models: [...inv.models].reverse() })).toEqual(result);
  });
  test("an unavailable fourth model preserves three-level selections and clamps cross-provider routes", () => {
    const inv = fourLevelInventory(), input = benchmarkCandidates(inv);
    const receipt = parseBenchmarkObservation(report(input), input, 101, 200);
    for (const [lower, provider, primary] of [["anthropic", "anthropic", "openai"], ["openai", "openai-codex", "anthropic"]] as const) {
      const blocked = { ...receipt, results: receipt.results.map(result => result.provider === provider && result.id === "series4"
        ? { ...result, status: "client_blocked", tokensPerSecond: null, timeToFirstTokenMs: null } : result) };
      const catalog = compileCatalog(catalogFromObservations(inv, blocked).document);
      const selection = { ...defaultSelection(catalog), lane: { kind: "provider", family: lower, blend: "only" } as const };
      for (const capability of [1, 2, 3] as const) {
        const review = reviewCatalog(catalog, { ...selection, capability }, 200);
        expect(review.available.capabilities).toEqual([1, 2, 3]);
        expect(review.routes.find(route => route.role === "default")?.lead.key).toBe(`${provider}.series${capability}`);
      }
      expect(() => reviewCatalog(catalog, { ...selection, capability: 4 }, 200)).toThrow("code_invalid_selection");
      const review = reviewCatalog(catalog, { ...selection, capability: 4,
        lane: { kind: "provider", family: primary, blend: "led" } }, 200);
      expect(review.available.capabilities).toEqual([1, 2, 3, 4]);
      expect(catalog.model(review.routes.find(route => route.role === "default")!.lead.key).tier).toBe(4);
      expect(review.routes.find(route => route.role === "reviewer")?.lead.key).toBe(`${provider}.series3`);
      expect(review.routes.find(route => route.role === "default")?.fallback.map(choice => choice.key))
        .toContain(`${provider}.series3`);
      const mixed = { ...selection, lane: { kind: "mixed" } as const };
      expect(reviewCatalog(catalog, mixed, 200).available.capabilities).toEqual(primary === "openai" ? [1, 2, 3, 4] : [1, 2, 3]);
    }
  });
  test("one configured provider can form a ladder without inventing a missing provider", () => {
    const inv = fullInventory();
    inv.models = inv.models.filter(model => model.provider === "anthropic");
    expect(derived(inv).document.models.map(model => [model.provider, model.tier])).toEqual([
      ["anthropic", 1], ["anthropic", 2], ["anthropic", 3],
    ]);
    expect(() => derived({ ...inv, models: inv.models.slice(1) })).toThrow("probe_insufficient_ladder");
  });
  test("a shorter valid ladder beats extra rungs that lose context or thinking", () => {
    const inv = fullInventory(), model = inv.models.find(value => value.provider === "openai-codex")!;
    inv.models = [
      { ...model, id: "gpt-efficient", inputCostPerMillion: 0.2, contextWindow: 1000000, thinkingLevels: ["max"] },
      { ...model, id: "gpt-compact", inputCostPerMillion: 0.75, contextWindow: 272000, thinkingLevels: ["max"] },
      { ...model, id: "gpt-shallow", inputCostPerMillion: 1, contextWindow: 1000000, thinkingLevels: ["xhigh"] },
      { ...model, id: "gpt-standard", inputCostPerMillion: 2, contextWindow: 1000000, thinkingLevels: ["max"] },
      { ...model, id: "gpt-powerful", inputCostPerMillion: 4, contextWindow: 1000000, thinkingLevels: ["max"] },
      { ...model, id: "gpt-pricey", inputCostPerMillion: 10, contextWindow: 922000, thinkingLevels: ["max"] },
    ];
    expect(derived(inv).document.models.map(value => [value.tier, value.id])).toEqual([
      [1, "gpt-efficient"], [2, "gpt-standard"], [3, "gpt-powerful"],
    ]);
  });
  test("missing, stale, wrong API and inconclusive probes refuse promotion", () => {
    const inv = fullInventory(), input = benchmarkCandidates(inv), receipt = parseBenchmarkObservation(report(input), input, 101, 200);
    expect(() => catalogFromObservations(inv, { ...receipt, results: receipt.results.slice(1) })).toThrow("probe_missing_probe");
    expect(() => catalogFromObservations(inv, { ...receipt, inventoryObservedAt: 99 })).toThrow("probe_missing_probe");
    expect(() => catalogFromObservations(inv, { ...receipt, results: receipt.results.map((result, i) => i ? result : { ...result, api: "other" }) })).toThrow("probe_missing_probe");
    for (const status of ["unresolved", "unmatched"]) {
      expect(() => catalogFromObservations(inv, { ...receipt, results: receipt.results.map((result, i) => i ? result : { ...result, status, tokensPerSecond: null, timeToFirstTokenMs: null }) })).toThrow("probe_inconclusive_probe");
    }
  });
  test("every old version is probed before supersession, blocked newest cannot displace callable older", () => {
    const inv = fullInventory();
    inv.models.push({ ...inv.models.find(model => model.id === "claude-opus-5")!, id: "claude-opus-6" });
    const input = benchmarkCandidates(inv), receipt = parseBenchmarkObservation(report(input), input, 101, 200);
    expect(catalogFromObservations(inv, receipt).document.models.filter(model => model.provider === "anthropic").map(model => model.id))
      .toEqual(["claude-haiku-5", "claude-sonnet-5", "claude-opus-6"]);
    const blocked = { ...receipt, results: receipt.results.map(result => result.id === "claude-opus-6" ? { ...result, status: "client_blocked", tokensPerSecond: null, timeToFirstTokenMs: null } : result) };
    expect(catalogFromObservations(inv, blocked).document.models.filter(model => model.provider === "anthropic").map(model => model.id)).toEqual(["claude-haiku-5", "claude-sonnet-5", "claude-opus-5"]);
    expect(() => catalogFromObservations(inv, { ...receipt, results: receipt.results.filter(result => result.id !== "claude-opus-5") })).toThrow("probe_missing_probe");
  });
  test("special tier requires sanctioned exact identity, optional family can supply one rung", () => {
    const inv = fullInventory();
    inv.models.push({ ...inv.models[0]!, provider: "openai-codex", api: "openai-codex-responses", id: "gpt-spark-6", inputCostPerMillion: 0.5 });
    inv.models.push({ ...inv.models[0]!, provider: "deepseek", api: "openai-completions", id: "deepseek-v4" });
    const special = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-spark-6", facet: "spark" as const };
    const result = derived(inv, { specials: [special], budget: "any" });
    expect(result.document.models.find(model => model.id === special.id)).toMatchObject({ tier: 0, quotaBucket: "spark" });
    expect(result.document.models.find(model => model.provider === "deepseek")).toMatchObject({ tier: 1, quotaBucket: null });
    expect(() => derived(inv, { specials: [{ ...special, id: "gpt-missing-6" }], budget: "any" })).toThrow("probe_invalid_input");
  });

  /**
   * A provider addresses its free tier with a variant suffix (`vendor/model:free`), and the two
   * facts this test pins are that such an address reaches a catalog at all, and that a budget
   * decides WHAT IS LADDERED rather than filtering afterwards. Before the fix the same inventory
   * derived a catalog whose free budget was unsatisfiable at every capability, while the
   * inventory itself held a complete free ladder — the constraint was answerable and unanswered.
   */
  function mixedInventory(): InventoryReceipt {
    // The live shape: one free model, which wins the cheapest rung and only that rung, while the
    // tiers the routes actually need are paid. A free budget applied after this ladder is chosen
    // has nothing to route to above tier 1, even though the listing could have laddered free.
    const models = [
      { id: "alpha-1:free", cost: 0, level: "low", context: 100_000 },
      { id: "delta-2", cost: 1, level: "medium", context: 200_000 },
      { id: "delta-3", cost: 2, level: "high", context: 300_000 },
      { id: "delta-4", cost: 3, level: "max", context: 400_000 },
    ];
    return parseInventoryObservation(
      { models: models.map(model => ({ ...row("openrouter", model.id), thinking: [model.level], contextWindow: model.context,
        cost: { input: model.cost, output: model.cost * 5, cacheRead: 0, cacheWrite: 0 } })) },
      models.map(({ id }) => ({ provider: "openrouter", id, api: "openai-completions" })), 100, "18.1.14");
  }
  function freeLadderInventory(): InventoryReceipt {
    // The same listing's free tier, which does carry separating evidence of its own.
    const models = [
      { id: "alpha-1:free", level: "low", context: 100_000 },
      { id: "beta-2:free", level: "high", context: 200_000 },
      { id: "gamma-3:free", level: "max", context: 400_000 },
    ];
    return parseInventoryObservation(
      { models: models.map(model => ({ ...row("openrouter", model.id), thinking: [model.level], contextWindow: model.context,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) },
      models.map(({ id }) => ({ provider: "openrouter", id, api: "openai-completions" })), 100, "18.1.14");
  }

  test("a free budget ladders only what costs nothing, and a variant address is not a disqualification", () => {
    const mixed = mixedInventory();

    // Derived under `any`, the free model is tier 1 and every tier above it is paid, so the
    // constraint cannot be met by a catalog that was laddered without it.
    const paid = compileCatalog(derived(mixed, { specials: [], budget: "any" }).document);
    expect(paid.models.filter(model => model.inputCostPerMillion === 0).map(model => model.tier)).toEqual([1]);
    expect(() => reviewCatalog(paid, { ...defaultSelection(paid), budget: "free" }, 101)).toThrow("budget_unsatisfiable");

    // Derived under `free`, the same free tier ladders on its own evidence — variant addresses
    // and all — and the constraint is met rather than refused.
    const inv = freeLadderInventory();
    const result = derived(inv, { specials: [], budget: "free" });
    expect(result.document.models.map(model => [model.tier, model.id])).toEqual([[1, "alpha-1:free"], [2, "beta-2:free"], [3, "gamma-3:free"]]);
    const free = compileCatalog(result.document);
    const review = reviewCatalog(free, { ...defaultSelection(free), budget: "free" }, 101);
    expect(review.selection.budget).toBe("free");
    // Nothing paid may appear anywhere in a route, lead or fallback: that is the whole constraint.
    const routed = review.routes.flatMap(route => [route.lead, ...route.fallback]);
    expect(routed.length).toBeGreaterThan(0);
    expect(routed.every(choice => free.model(choice.key).inputCostPerMillion === 0 && free.model(choice.key).outputCostPerMillion === 0)).toBe(true);

    // The budget also bounds what a benchmark would probe, which is what a probe run spends.
    expect(benchmarkCandidates(mixed, { specials: [], budget: "free" }).candidates.map(candidate => candidate.id)).toEqual(["alpha-1:free"]);
    expect(benchmarkCandidates(mixed, { specials: [], budget: "any" }).candidates).toHaveLength(4);
  });

  test("addresses differing only by a character outside the key alphabet keep distinct keys", () => {
    const inv = mixedInventory();
    // `:` and `-` both fell outside the identifier alphabet and both folded to `-`, so these two
    // distinct models produced one key. Folding made them indistinguishable; escaping does not.
    inv.models.push({ ...inv.models[0]!, id: "alpha-1-free" });
    const keys = benchmarkCandidates(inv, { specials: [], budget: "any" }).candidates.map(candidate => candidate.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("openrouter.alpha-1_3Afree");
    expect(keys).toContain("openrouter.alpha-1-free");
  });
});

/*
  The rules old Code's `code generate init` derived ladders with (0035b4f), restored because the
  web generator's own rules picked a rolling alias, a superseded Opus and the 272k-context OpenAI
  rows out of the same OMP 18.1.14 listing, and dropped Spark. The fixtures are those rows.
*/
describe("old Code derivation rules over OMP's bundled rows", () => {
  test("only the newest version of a family is laddered, whatever its price or thinking profile", () => {
    // `claude-opus-4-6` lacks `xhigh` and costs what `claude-opus-5` costs; profile-keyed
    // supersession kept it, and it took tier 2 from `claude-sonnet-5`.
    const result = derived(receiptOf(anthropic1814()));
    expect(tiers(result.document, "anthropic"))
      .toEqual([[1, "claude-haiku-4-5"], [2, "claude-sonnet-5"], [3, "claude-opus-5"], [4, "claude-fable-5-1"]]);
    expect(result.exclusions).toEqual([{ provider: "anthropic", id: "claude-opus-4-6", reason: "superseded" }]);
  });
  test("a client-blocked newest falls back to its callable predecessor, and is named as blocked", () => {
    const inv = receiptOf([...anthropic1814(), listed("anthropic", "claude-fable-5", 10, 1_000_000, "low", "max")]);
    const derived = catalogFromObservations(inv, observed(inv, { "claude-fable-5-1": "client_blocked" }));
    expect(tiers(derived.document, "anthropic"))
      .toEqual([[1, "claude-haiku-4-5"], [2, "claude-sonnet-5"], [3, "claude-opus-5"], [4, "claude-fable-5"]]);
    expect(derived.exclusions).toEqual([
      { provider: "anthropic", id: "claude-fable-5-1", reason: "client_blocked" },
      { provider: "anthropic", id: "claude-opus-4-6", reason: "superseded" },
    ]);
  });
  test("version tokens decide the newest GPT, including a major version spelled before the name", () => {
    const gpt = derived(receiptOf(openai1814().filter(model => ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-6-astra"].includes(model.id))));
    expect(tiers(gpt.document, "openai-codex")).toEqual([[1, "gpt-5.4-mini"], [2, "gpt-5.5"], [3, "gpt-6-astra"]]);
    expect(gpt.exclusions).toEqual([{ provider: "openai-codex", id: "gpt-5.4", reason: "superseded" }]);
    const luna = derived(receiptOf([listed("openai-codex", "gpt-6-luna", 0.1, 1_000_000, "low", "max"),
      ...openai1814().filter(model => ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"].includes(model.id))]));
    expect(tiers(luna.document, "openai-codex")).toEqual([[1, "gpt-6-luna"], [2, "gpt-5.6-terra"], [3, "gpt-5.6-sol"]]);
    expect(luna.exclusions).toEqual([{ provider: "openai-codex", id: "gpt-5.6-luna", reason: "superseded" }]);
  });
  test("rolling aliases and experiments are never probed or laddered, even as their family's most capable rows", () => {
    const deepseek = (id: string, context: number, images: boolean): Row =>
      ({ ...listed("deepseek", id, id.endsWith("-pro") ? 0.435 : 0.14, context, "low", "max", images), thinkingLevels: ["low", "high", "max"] });
    const inv = receiptOf([
      ...openai1814().filter(model => ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"].includes(model.id)),
      // Given the widest context of their families, either would be the top if it were a candidate.
      listed("openai-codex", "gpt-daybreak-blue-latest", 5, 2_000_000, "low", "max"),
      deepseek("deepseek-v4-flash", 1_000_000, false), deepseek("deepseek-v4-pro", 1_000_000, false),
      deepseek("deepseek-v4-flash-vision-exp", 2_000_000, true),
    ]);
    const draft = inventoryDraft(inv, "any"), result = derived(inv);
    expect(draft.benchmark.candidates.map(model => model.id))
      .toEqual(["deepseek-v4-flash", "deepseek-v4-pro", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(tiers(result.document, "openai-codex")).toEqual([[1, "gpt-5.6-luna"], [2, "gpt-5.6-terra"], [3, "gpt-5.6-sol"]]);
    expect(tiers(result.document, "deepseek")).toEqual([[1, "deepseek-v4-flash"], [2, "deepseek-v4-pro"]]);
    // The draft already names them, so the charge an operator confirms never includes them.
    for (const exclusions of [draft.exclusions, result.exclusions]) {
      expect(exclusions).toEqual([
        { provider: "deepseek", id: "deepseek-v4-flash-vision-exp", reason: "unstable_id" },
        { provider: "openai-codex", id: "gpt-daybreak-blue-latest", reason: "unstable_id" },
      ]);
    }
    // DeepSeek is then text-only, so its vision role crosses to an image-capable family as intended.
    const catalog = compileCatalog(result.document);
    const review = reviewCatalog(catalog, { ...defaultSelection(catalog), lane: { kind: "provider", family: "deepseek", blend: "only" } }, 200);
    expect(catalog.family(review.routes.find(route => route.role === "vision")!.lead.key)).toBe("openai");
  });
  test("OpenAI's 18.1.14 rows ladder the GPT-5.6 family rather than the longest 272k-context chain", () => {
    const result = derived(receiptOf(openai1814()));
    expect(tiers(result.document, "openai-codex")).toEqual([[1, "gpt-5.6-luna"], [2, "gpt-5.6-terra"], [3, "gpt-5.6-sol"]]);
    expect(result.exclusions).toEqual([
      { provider: "openai-codex", id: "gpt-5.4", reason: "superseded" },
      { provider: "openai-codex", id: "gpt-5.4-mini", reason: "regression" },
      { provider: "openai-codex", id: "gpt-daybreak-blue-latest", reason: "unstable_id" },
    ]);
  });
  test("an 18.4.x-like listing ladders luna, terra, sol and astra, ordering equal-price middles by address", () => {
    // The operator's curated facts for the models it routes, beside the older rows OMP still lists.
    // `gpt-5.6-terra` and `gpt-6.1-sol` share an input price, so only their addresses order them.
    const current = [
      listed("openai-codex", "gpt-6-luna", 0.1, 1_000_000, "low", "max"), listed("openai-codex", "gpt-5.6-terra", 2, 1_000_000, "low", "max"),
      listed("openai-codex", "gpt-6.1-sol", 2, 1_000_000, "low", "max"), listed("openai-codex", "gpt-6-astra", 10, 1_000_000, "low", "max"),
    ];
    const inv = receiptOf([...current, ...openai1814().filter(model => !current.some(value => value.id === model.id))]);
    const result = derived(inv);
    expect(tiers(result.document, "openai-codex"))
      .toEqual([[1, "gpt-6-luna"], [2, "gpt-5.6-terra"], [3, "gpt-6.1-sol"], [4, "gpt-6-astra"]]);
    expect(derived({ ...inv, models: [...inv.models].reverse() })).toEqual(result);
  });
  test("a required family whose most capable model regresses on its cheapest refuses, naming both", () => {
    // Only luna and the 272k-context rows answer. Their most capable, gpt-5.5, would sit a smaller
    // context above luna, and quietly choosing another top would hide that from the operator.
    const inv = receiptOf(openai1814());
    const callable = ["gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.5", "gpt-5.4"];
    const verdicts = Object.fromEntries(inv.models.filter(model => !callable.includes(model.id)).map(model => [model.id, "not_found" as const]));
    expect(() => catalogFromObservations(inv, observed(inv, verdicts)))
      .toThrow("code_ladder_regression: openai: openai-codex/gpt-5.5 regresses on openai-codex/gpt-5.6-luna");
  });
  test("OMP's Spark quota class, joined to an inventory, derives the tier 0 the default selection drains", () => {
    const inv = receiptOf([...openai1814(), listed("openai-codex", "gpt-5.3-codex-spark", 1.75, 128_000, "low", "xhigh", false), ...anthropic1814()]);
    const metadata: ModelCatalogSnapshot = { schemaVersion: 1, source: "bundled", ompVersion: "18.1.14", revision: "a".repeat(64),
      models: inv.models.map(model => ({ ...model,
        quotaTier: model.id === "gpt-5.3-codex-spark" ? "spark" : model.provider === "openai-codex" ? "chat" : null })) };
    const specials = quotaSpecials(inv, metadata);
    expect(specials).toEqual([{ provider: "openai-codex", id: "gpt-5.3-codex-spark", api: "openai-codex-responses", facet: "spark" }]);
    const { document } = catalogFromObservations(inv, observed(inv), { specials, budget: "any" });
    expect(document.models.filter(model => model.tier === 0))
      .toEqual([expect.objectContaining({ id: "gpt-5.3-codex-spark", quotaBucket: "spark" })]);
    const catalog = compileCatalog(document), review = reviewCatalog(catalog, defaultSelection(catalog), 200);
    expect([review.selection.spark, review.available.spark]).toEqual([true, true]);
    for (const role of ["tiny", "commit"]) {
      expect(review.routes.find(route => route.role === role)?.lead.key).toBe("openai-codex.gpt-5.3-codex-spark");
    }
    // Another OMP version's classification does not describe this inventory, so nothing is joined.
    expect(quotaSpecials(inv, { ...metadata, ompVersion: "18.4.4" })).toEqual([]);
  });
});

describe("passive starter metadata", () => {
  function metadata(): ModelCatalogSnapshot {
    return { schemaVersion: 1, source: "bundled", ompVersion: "18.1.14", revision: "a".repeat(64),
      models: fullInventory().models.map(model => ({ ...model, quotaTier: model.provider === "openai-codex" ? "chat" : null })) };
  }

  test("unmeasured exact metadata derives complete routes without inventory evidence", () => {
    const snapshot = metadata(), document = catalogFromMetadata(snapshot, "any");
    const compiled = compileCatalog(document), selection = defaultSelection(compiled);
    const review = reviewCatalog(compiled, selection, 1000);
    expect(review.routes.map(route => route.role)).toEqual([
      "default", "task", "plan", "slow", "reviewer", "security-reviewer", "scout", "sonic", "advisor", "vision", "smol", "tiny", "commit",
    ]);
    for (const model of document.models) {
      const source = snapshot.models.find(row => row.provider === model.provider && row.id === model.id)!;
      expect(model).toMatchObject({ provider: source.provider, id: source.id, api: source.api,
        inputCostPerMillion: source.inputCostPerMillion, outputCostPerMillion: source.outputCostPerMillion,
        tokensPerSecond: null, timeToFirstTokenMs: null });
    }
    expect(catalogFromMetadata({ ...snapshot, models: [...snapshot.models].reverse() }, "any")).toEqual(document);
  });

  test("a declared Spark class is the off-ladder tier 0 only below some rung; unknown classes never enter", () => {
    const snapshot = metadata(), ordinary = catalogFromMetadata(snapshot, "any");
    const base = snapshot.models.find(model => model.provider === "openai-codex")!;
    snapshot.models.push(...["spark", "future-resource"].map((quotaTier, index) => ({
      ...base, id: `cheap-special-${index}`, inputCostPerMillion: 0, outputCostPerMillion: 0, quotaTier,
    })));
    const document = catalogFromMetadata(snapshot, "any");
    expect(document.models.filter(model => model.tier !== 0)).toEqual(ordinary.models);
    expect(document.models.filter(model => model.tier === 0)).toEqual([expect.objectContaining({ id: "cheap-special-0", quotaBucket: "spark" })]);
    const catalog = compileCatalog(document);
    expect(reviewCatalog(catalog, { ...defaultSelection(catalog), spark: true }, 1000).selection.spark).toBe(true);
    // Priced like the top rung, a Spark-class model is some other quota window: neither tier 0 nor a rung.
    const top = Math.max(...ordinary.models.filter(model => model.provider === "openai-codex").map(model => model.inputCostPerMillion));
    snapshot.models = snapshot.models.map(model => model.id === "cheap-special-0" ? { ...model, inputCostPerMillion: top } : model);
    expect(catalogFromMetadata(snapshot, "any")).toEqual(ordinary);
  });

  test("candidate 257 refuses before supersession, while budget and resource exclusions precede the bound", () => {
    const snapshot = metadata(), base = { ...snapshot.models[0]!, provider: "vendor", api: "vendor-chat" };
    snapshot.models = Array.from({ length: 256 }, (_, index) => ({ ...base, id: `series-${index + 1}` }));
    expect(catalogFromMetadata(snapshot, "any").models.map(model => model.id)).toEqual(["series-256"]);
    snapshot.models.push({ ...base, id: "series-257" });
    expect(() => catalogFromMetadata(snapshot, "any")).toThrow("code_starter_candidate_limit");
    snapshot.models.push({ ...base, id: "free", inputCostPerMillion: 0, outputCostPerMillion: 0 });
    expect(catalogFromMetadata(snapshot, "free").models.map(model => model.id)).toEqual(["free"]);
    snapshot.models = snapshot.models.map(model => ({ ...model, quotaTier: model.id === "free" ? null : "unrecognized" }));
    expect(catalogFromMetadata(snapshot, "any").models.map(model => model.id)).toEqual(["free"]);
  });

  test("duplicate, case-folded and API aliases refuse even when excluded by quota", () => {
    for (const change of [{}, { id: "CLAUDE-HAIKU-5" }, { api: "other-api" }]) {
      const snapshot = metadata();
      snapshot.models.push({ ...snapshot.models[0]!, ...change, quotaTier: "spark" });
      expect(() => catalogFromMetadata(snapshot, "any")).toThrow("probe_ambiguous_identity");
    }
    const snapshot = metadata(), base = snapshot.models[0]!;
    snapshot.models = [{ ...base, provider: "vendor.part", id: "model" }, { ...base, provider: "vendor", id: "part.model" }];
    expect(() => catalogFromMetadata(snapshot, "any")).toThrow("probe_ambiguous_identity");
  });
});
