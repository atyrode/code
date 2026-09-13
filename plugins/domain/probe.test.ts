import { describe, expect, test } from "bun:test";
import { PROBE_MODEL_LIMIT, parseBenchmarkObservation, parseInventoryObservation, type InventoryReceipt } from "@atyrode/manifold-omp";
import { benchmarkCandidates, catalogFromObservations, scaffoldInventory } from "./probe.ts";
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
  inv.models = ["openai-codex", "anthropic"].flatMap(provider => {
    const model = inv.models.find(value => value.provider === provider)!;
    return levels.map((level, index) => ({ ...model, id: `series-${index + 1}`,
      inputCostPerMillion: index + 1, outputCostPerMillion: (index + 1) * 5,
      contextWindow: (index + 1) * 100000, thinkingLevels: [level] }));
  });
  return inv;
}


describe("pure typed scaffolding", () => {
  test("drafts are unmeasured; certified documents preserve family tiers and registry quota buckets", () => {
    const inv = fullInventory(), draft = scaffoldInventory(inv);
    expect(draft.kind).toBe("draft");
    expect(draft.document.models.every(model => model.tokensPerSecond === null && model.timeToFirstTokenMs === null)).toBe(true);
    const receipt = parseBenchmarkObservation(report(draft.benchmark), draft.benchmark, 101, 200);
    const document = catalogFromObservations(inv, receipt);
    expect(document.models.filter(model => model.provider === "anthropic").map(model => [model.tier, model.id, model.quotaBucket])).toEqual([
      [1, "claude-haiku-5", "claude"], [2, "claude-sonnet-5", "claude"], [3, "claude-opus-5", "claude"],
    ]);
    expect(document.models.filter(model => model.provider === "openai-codex").map(model => model.quotaBucket)).toEqual(["codex", "codex", "codex"]);
    expect(document.models.every(model => model.tokensPerSecond === 62 && model.timeToFirstTokenMs === 700)).toBe(true);
    expect(scaffoldInventory({ ...inv, models: [...inv.models].reverse() })).toEqual(draft);
  });
  test("distinct version evidence produces four reviewed and routable levels in both provider families", () => {
    const inv = fourLevelInventory(), draft = scaffoldInventory(inv);
    const receipt = parseBenchmarkObservation(report(draft.benchmark), draft.benchmark, 101, 200);
    const document = catalogFromObservations(inv, receipt), catalog = compileCatalog(document);
    for (const [family, provider] of [["openai", "openai-codex"], ["anthropic", "anthropic"]] as const) {
      expect(draft.benchmark.candidates.filter(model => model.provider === provider).map(model => model.id))
        .toEqual(["series-1", "series-2", "series-3", "series-4"]);
      expect(draft.document.models.filter(model => model.provider === provider).map(model => [model.tier, model.id]))
        .toEqual([[1, "series-1"], [2, "series-2"], [3, "series-3"], [4, "series-4"]]);
      for (const capability of [1, 2, 3, 4] as const) {
        const review = reviewCatalog(catalog, { ...defaultSelection(catalog), capability, thinking: "max",
          lane: { kind: "provider", family, blend: "only" } }, 200);
        expect(review.available.capabilities).toEqual([1, 2, 3, 4]);
        const overlay = compileOmpOverlay(catalog, review.selection, review.routes);
        expect(overlay.modelRoles?.default).toBe(`${provider}/series-${capability}:${["low", "medium", "high", "max"][capability - 1]}`);
        expect(review.routes.find(route => route.role === "plan")?.lead.key).toBe(`${provider}.series-${Math.min(4, capability + 1)}`);
        if (capability === 4) {
          expect(review.routes.find(route => route.role === "task")?.fallback.map(choice => choice.key))
            .toEqual([`${provider}.series-3`, `${provider}.series-2`]);
          expect(review.routes.find(route => route.role === "scout")?.lead.key).toBe(`${provider}.series-2`);
          expect(review.routes.find(route => route.role === "commit")?.lead.key).toBe(`${provider}.series-1`);
        }
      }
    }
    expect(scaffoldInventory({ ...inv, models: [...inv.models].reverse() })).toEqual(draft);
    expect(catalogFromObservations({ ...inv, models: [...inv.models].reverse() },
      { ...receipt, results: [...receipt.results].reverse() })).toEqual(document);
  });
  test("a greedy intermediate cannot crowd out two compatible middle rungs", () => {
    const inv = fourLevelInventory(), base = inv.models[0]!;
    inv.models = [
      { ...base, id: "entry", inputCostPerMillion: 1, contextWindow: 100000, thinkingLevels: ["low"] },
      { ...base, id: "detour", inputCostPerMillion: 2, contextWindow: 800000, thinkingLevels: ["xhigh"] },
      { ...base, id: "middle", inputCostPerMillion: 3, contextWindow: 200000, thinkingLevels: ["medium"] },
      { ...base, id: "upper", inputCostPerMillion: 4, contextWindow: 400000, thinkingLevels: ["high"] },
      { ...base, id: "top", inputCostPerMillion: 5, contextWindow: 1000000, thinkingLevels: ["max"] },
    ];
    const draft = scaffoldInventory(inv), receipt = parseBenchmarkObservation(report(draft.benchmark), draft.benchmark, 101, 200);
    expect(draft.benchmark.candidates.map(model => model.id)).toEqual(["detour", "entry", "middle", "top", "upper"]);
    const catalog = compileCatalog(catalogFromObservations(inv, receipt));
    expect([1, 2, 3, 4].map(tier => catalog.model(catalog.rung("openai", tier)).id)).toEqual(["entry", "middle", "upper", "top"]);
    const review = reviewCatalog(catalog, { ...defaultSelection(catalog), capability: 4 }, 200);
    expect(review.routes.find(route => route.role === "default")?.lead.key).toBe("openai-codex.top");
    expect(review.routes.find(route => route.role === "default")?.fallback.map(choice => choice.key))
      .toEqual(["openai-codex.upper", "openai-codex.middle"]);
  });
  test("a preferred three-rung top does not hide a complete four-rung alternative", () => {
    const inv = fourLevelInventory(), base = inv.models.find(model => model.provider === "anthropic")!;
    inv.models = [
      { ...base, id: "entry", inputCostPerMillion: 1, contextWindow: 100000, thinkingLevels: ["low"] },
      { ...base, id: "middle", inputCostPerMillion: 2, contextWindow: 200000, thinkingLevels: ["medium"] },
      { ...base, id: "wide", inputCostPerMillion: 3, contextWindow: 900000, thinkingLevels: ["max"] },
      { ...base, id: "upper", inputCostPerMillion: 4, contextWindow: 600000, thinkingLevels: ["high"] },
      { ...base, id: "top", inputCostPerMillion: 5, contextWindow: 800000, thinkingLevels: ["max"] },
    ];
    const catalog = compileCatalog(scaffoldInventory(inv).document);
    expect([1, 2, 3, 4].map(tier => catalog.model(catalog.rung("anthropic", tier)).id)).toEqual(["entry", "middle", "upper", "top"]);
    const review = reviewCatalog(catalog, { ...defaultSelection(catalog), capability: 4 }, 200);
    expect(review.available.capabilities).toEqual([1, 2, 3, 4]);
    expect(review.routes.find(route => route.role === "default")?.lead.key).toBe("anthropic.top");
  });
  test("an incompatible cheapest model does not veto an otherwise complete provider ladder", () => {
    const inv = fourLevelInventory();
    inv.models = inv.models.filter(model => model.provider === "openai-codex");
    inv.models.push({ ...inv.models[0]!, id: "wide", inputCostPerMillion: 0.5, contextWindow: 1000000 });
    const draft = scaffoldInventory(inv), catalog = compileCatalog(draft.document);
    expect(draft.benchmark.candidates.map(model => model.id)).toEqual(["series-1", "series-2", "series-3", "series-4", "wide"]);
    const review = reviewCatalog(catalog, { ...defaultSelection(catalog), capability: 1 }, 200);
    expect(review.available.capabilities).toEqual([1, 2, 3, 4]);
    expect(review.routes.find(route => route.role === "default")?.lead.key).toBe("openai-codex.series-1");
    expect(review.routes.find(route => route.role === "plan")?.lead.key).toBe("openai-codex.series-2");
  });
  test("equal prices do not reverse observed capability progression", () => {
    const inv = fourLevelInventory();
    inv.models = inv.models.filter(model => model.provider === "anthropic").map(model => ({ ...model, inputCostPerMillion: 1 }));
    const catalog = compileCatalog(scaffoldInventory(inv).document);
    expect([1, 2, 3, 4].map(tier => catalog.model(catalog.rung("anthropic", tier)).id)).toEqual(["series-1", "series-2", "series-3", "series-4"]);
    const review = reviewCatalog(catalog, { ...defaultSelection(catalog), capability: 4 }, 200);
    expect(compileOmpOverlay(catalog, review.selection, review.routes).modelRoles?.default).toBe("anthropic/series-4:max");
  });
  test("unknown context preserves earlier evidence without discarding a viable prefix", () => {
    const inv = fourLevelInventory(), base = inv.models[0]!;
    inv.models = [
      { ...base, id: "wide", inputCostPerMillion: 0.5, contextWindow: 900000, thinkingLevels: ["low"] },
      { ...base, id: "entry", inputCostPerMillion: 1, contextWindow: 100000, thinkingLevels: ["low"] },
      { ...base, id: "bridge", inputCostPerMillion: 2, contextWindow: null, thinkingLevels: ["medium"] },
      { ...base, id: "upper", inputCostPerMillion: 3, contextWindow: 200000, thinkingLevels: ["high"] },
      { ...base, id: "top", inputCostPerMillion: 4, contextWindow: 500000, thinkingLevels: ["max"] },
    ];
    expect(scaffoldInventory(inv).document.models.map(model => [model.tier, model.id]))
      .toEqual([[1, "entry"], [2, "bridge"], [3, "upper"], [4, "top"]]);
    inv.models = inv.models.filter(model => model.id !== "entry");
    expect(scaffoldInventory(inv).document.models.map(model => [model.tier, model.id]))
      .toEqual([[1, "bridge"], [2, "upper"], [3, "top"]]);
  });
  test("the maximum inventory of three antichains retains the preferred real fallback independent of order", () => {
    const inv = fourLevelInventory(), base = inv.models[0]!;
    const levels = ["low", "high", "max"] as const;
    // Across groups every edge is valid; within each group context decreases
    // as price rises. There are many middle pairs but no four-rung ladder.
    inv.models = Array.from({ length: PROBE_MODEL_LIMIT }, (_, index) => {
      const group = index < 85 ? 0 : index < 171 ? 1 : 2;
      return { ...base, id: `adversary-${index + 1}`, inputCostPerMillion: index + 1,
        contextWindow: (group + 1) * 100000 - index, thinkingLevels: [levels[group]!] };
    });
    const draft = scaffoldInventory(inv);
    expect(draft.document.models.map(model => [model.tier, model.id]))
      .toEqual([[1, "adversary-1"], [2, "adversary-86"], [3, "adversary-172"]]);
    expect(draft.benchmark.candidates.map(model => model.id)).toEqual(inv.models.map(model => model.id).sort());
    expect(scaffoldInventory({ ...inv, models: [...inv.models].reverse() })).toEqual(draft);
  });
  test("an unavailable fourth model preserves three-level selections and clamps cross-provider routes", () => {
    const inv = fourLevelInventory(), input = benchmarkCandidates(inv);
    const receipt = parseBenchmarkObservation(report(input), input, 101, 200);
    for (const [lower, provider, primary] of [["anthropic", "anthropic", "openai"], ["openai", "openai-codex", "anthropic"]] as const) {
      const blocked = { ...receipt, results: receipt.results.map(result => result.provider === provider && result.id === "series-4"
        ? { ...result, status: "client_blocked", tokensPerSecond: null, timeToFirstTokenMs: null } : result) };
      const catalog = compileCatalog(catalogFromObservations(inv, blocked));
      const selection = { ...defaultSelection(catalog), lane: { kind: "provider", family: lower, blend: "only" } as const };
      for (const capability of [1, 2, 3] as const) {
        const review = reviewCatalog(catalog, { ...selection, capability }, 200);
        expect(review.available.capabilities).toEqual([1, 2, 3]);
        expect(review.routes.find(route => route.role === "default")?.lead.key).toBe(`${provider}.series-${capability}`);
      }
      expect(() => reviewCatalog(catalog, { ...selection, capability: 4 }, 200)).toThrow("code_invalid_selection");
      const review = reviewCatalog(catalog, { ...selection, capability: 4,
        lane: { kind: "provider", family: primary, blend: "led" } }, 200);
      expect(review.available.capabilities).toEqual([1, 2, 3, 4]);
      expect(catalog.model(review.routes.find(route => route.role === "default")!.lead.key).tier).toBe(4);
      expect(review.routes.find(route => route.role === "reviewer")?.lead.key).toBe(`${provider}.series-3`);
      expect(review.routes.find(route => route.role === "default")?.fallback.map(choice => choice.key))
        .toContain(`${provider}.series-3`);
      const mixed = { ...selection, lane: { kind: "mixed" } as const };
      expect(reviewCatalog(catalog, mixed, 200).available.capabilities).toEqual(primary === "openai" ? [1, 2, 3, 4] : [1, 2, 3]);
    }
  });
  test("one configured provider can form a ladder without inventing a missing provider", () => {
    const inv = fullInventory();
    inv.models = inv.models.filter(model => model.provider === "anthropic");
    const draft = scaffoldInventory(inv);
    expect(draft.document.models.map(model => [model.provider, model.tier])).toEqual([
      ["anthropic", 1], ["anthropic", 2], ["anthropic", 3],
    ]);
    expect(() => scaffoldInventory({ ...inv, models: inv.models.slice(1) })).toThrow("probe_insufficient_ladder");
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
    expect(scaffoldInventory(inv).document.models.map(value => [value.tier, value.id])).toEqual([
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
    expect(catalogFromObservations(inv, receipt).models.filter(model => model.provider === "anthropic").map(model => model.id))
      .toEqual(["claude-haiku-5", "claude-sonnet-5", "claude-opus-6"]);
    const blocked = { ...receipt, results: receipt.results.map(result => result.id === "claude-opus-6" ? { ...result, status: "client_blocked", tokensPerSecond: null, timeToFirstTokenMs: null } : result) };
    expect(catalogFromObservations(inv, blocked).models.filter(model => model.provider === "anthropic").map(model => model.id)).toEqual(["claude-haiku-5", "claude-sonnet-5", "claude-opus-5"]);
    expect(() => catalogFromObservations(inv, { ...receipt, results: receipt.results.filter(result => result.id !== "claude-opus-5") })).toThrow("probe_missing_probe");
  });
  test("special tier requires sanctioned exact identity, optional family can supply one rung", () => {
    const inv = fullInventory();
    inv.models.push({ ...inv.models[0]!, provider: "openai-codex", api: "openai-codex-responses", id: "gpt-spark-6", inputCostPerMillion: 0.5 });
    inv.models.push({ ...inv.models[0]!, provider: "deepseek", api: "openai-completions", id: "deepseek-v4" });
    const special = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-spark-6", facet: "spark" };
    const draft = scaffoldInventory(inv, { specials: [special] });
    expect(draft.document.models.find(model => model.id === special.id)).toMatchObject({ tier: 0, quotaBucket: "spark" });
    expect(draft.document.models.find(model => model.provider === "deepseek")).toMatchObject({ tier: 1, quotaBucket: null });
    expect(() => scaffoldInventory(inv, { specials: [{ ...special, id: "gpt-missing-6" }] })).toThrow("probe_invalid_input");
  });
});
