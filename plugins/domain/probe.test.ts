import { describe, expect, test } from "bun:test";
import { benchmarkCandidates, catalogFromObservations, parseBenchmarkInput, parseBenchmarkObservation, parseInventoryObservation, projectProbeIdentities, scaffoldInventory, type InventoryReceipt } from "./probe.ts";

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

describe("exact OMP observations", () => {
  test("provider and backend API come from exact registry identity, not model spelling", () => {
    const registry = [{ provider: "openai", id: "claude-sonnet-5", api: "openai-responses", extra: "private" }];
    const identities = projectProbeIdentities(registry, ["openai"]);
    const receipt = parseInventoryObservation({ models: [row("openai")] }, identities, 100, "18.1.14");
    expect(receipt.models[0]).toMatchObject({ provider: "openai", api: "openai-responses", images: true, thinkingLevels: ["low", "high"] });
    expect(JSON.stringify(receipt)).not.toContain("private");
    expect(JSON.stringify(receipt)).not.toContain("not part of the receipt");
    expect(parseInventoryObservation({ models: [row()] }, identities, 100, "18.1.14").models).toEqual([]);
  });
  test("duplicate API, case-folded identities and wrong selectors are refused", () => {
    expect(() => parseInventoryObservation({ models: [row()] }, [identity, { ...identity, api: "openai-responses" }], 100, "18.1.14")).toThrow("probe_ambiguous_identity");
    expect(() => parseInventoryObservation({ models: [row(), row("Anthropic")] }, [identity], 100, "18.1.14")).toThrow("probe_ambiguous_identity");
    expect(() => parseInventoryObservation({ models: [{ ...row(), selector: "openai/claude-sonnet-5" }] }, [identity], 100, "18.1.14")).toThrow("probe_ambiguous_identity");
  });
  test("unknown thinking/modalities, absent context metadata and version drift fail closed", () => {
    for (const change of [{ thinking: ["off", "turbo"] }, { input: ["audio"] }, { contextWindow: undefined }, { cost: { input: -1, output: 15 } }]) {
      expect(() => parseInventoryObservation({ models: [{ ...row(), ...change }] }, [identity], 100, "18.1.14")).toThrow("probe_invalid_observation");
    }
    expect(() => parseInventoryObservation({ models: [row()] }, [identity], 100, "18.2.0")).toThrow("probe_unsupported_version");
  });
  test("benchmark observes exact resolution and streaming rate, never aggregate total rate", () => {
    const input = benchmarkCandidates(inventory());
    const receipt = parseBenchmarkObservation(report(input), input, 101, 200);
    expect(receipt.results[0]).toMatchObject({ ...input.candidates[0], status: "reachable", tokensPerSecond: 62, timeToFirstTokenMs: 700 });
    const raw = report(input);
    raw.models[0]!.model = "openai/claude-sonnet-5";
    expect(parseBenchmarkObservation(raw, input, 101, 200).results[0]).toMatchObject({ status: "unmatched", tokensPerSecond: null, timeToFirstTokenMs: null });
    expect(parseBenchmarkObservation({ ...raw, models: [] }, input, 101, 200).results[0]!.status).toBe("unmatched");
  });
  test("failed runs never retain error bodies or fabricate metrics", () => {
    const input = benchmarkCandidates(inventory());
    for (const [error, status] of [["401 secret-provider-token", "unresolved"], ["not_found_error private-body", "not_found"], ["claude_code_version_too_old private-body", "client_blocked"]]) {
      const raw = report(input);
      const receipt = parseBenchmarkObservation({ ...raw, failures: 1, models: [{ ...raw.models[0], results: [{ ok: false, error }], stats: null }] }, input, 101, 200);
      expect(receipt.results[0]).toMatchObject({ status, tokensPerSecond: null, timeToFirstTokenMs: null });
      expect(JSON.stringify(receipt)).not.toContain("private-body");
      expect(JSON.stringify(receipt)).not.toContain("secret-provider-token");
    }
  });
  test("partial metrics and duplicate reports cannot certify a successful probe", () => {
    const input = benchmarkCandidates(inventory()), raw = report(input);
    expect(parseBenchmarkObservation({ ...raw, models: [{ ...raw.models[0], stats: null }] }, input, 101, 200).results[0]!.status).toBe("unresolved");
    expect(() => parseBenchmarkObservation({ ...raw, models: [raw.models[0], raw.models[0]] }, input, 101, 200)).toThrow("probe_ambiguous_identity");
    expect(() => parseBenchmarkInput({ ...input, candidates: [{ ...input.candidates[0], id: "sonnet:high" }] })).toThrow("probe_invalid_input");
    expect(() => parseBenchmarkInput({ ...input, argv: ["--help"] })).toThrow("probe_invalid_input");
  });
});

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
