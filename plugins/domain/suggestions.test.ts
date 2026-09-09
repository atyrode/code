import { describe, expect, test } from "bun:test";
import { compileCatalog } from "./catalog.ts";
import type { CatalogDocument, CatalogModel, Selection } from "./contracts.ts";
import { defaultSelection, reviewCatalog } from "./routing.ts";
import { buildSuggestionRequest, parseSuggestionResponse } from "./suggestions.ts";

function document(): CatalogDocument {
  const models: CatalogModel[] = [];
  for (const [prefix, provider] of [["o", "openai-codex"], ["a", "anthropic"]] as const) {
    for (const tier of [1, 2, 3] as const) {
      models.push({
        key: `${prefix}${tier}`, provider, tier, id: `native-${prefix}${tier}`, api: "test-api",
        quotaBucket: null, inputCostPerMillion: 4, outputCostPerMillion: 12,
        tokensPerSecond: 30, timeToFirstTokenMs: 100, contextWindow: 200_000,
        thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], images: true,
      });
    }
  }
  models.push({ ...models[0]!, key: "spark", id: "native-spark", tier: 0, images: false });
  return { schemaVersion: 1, models };
}

const nowMs = Date.UTC(2026, 0, 1, 12);
const hard = 'hard — tricky refactor across modules\n{"model":"smart","thinking":"high","advisor":"review"}';
function response(content = hard) {
  return { message: { role: "assistant", content }, done: true, model: "qwen2.5:3b" };
}

describe("governed classifier suggestions", () => {
  test("refuses incomplete or unprojected classifier replies", () => {
    const catalog = compileCatalog(document());
    const selection = defaultSelection(catalog);
    for (const raw of [
      null,
      { ...response(), done: false },
      { message: response().message },
      { ...response(), message: { role: "user", content: hard } },
      { ...response(), message: { ...response().message, tool_calls: [] } },
      { ...response(), error: "private upstream failure" },
      { ...response(), model: "invalid\nevaluator" },
      response('hard\n{"model":"smart","thinking":"high"}'),
    ]) {
      expect(() => parseSuggestionResponse(catalog, selection, raw, nowMs)).toThrow("code_suggestion_invalid_response");
    }
  });

  test("refuses malformed sizing, refusals, and ambiguous duplicate keys", () => {
    const catalog = compileCatalog(document());
    const selection = defaultSelection(catalog);
    for (const content of [
      '{"model":"smart","thinking":"high","advisor":"review"}',
      hard + "\nextra output",
      'I cannot classify this task\n{"model":"smart","thinking":"high","advisor":"review"}',
      'hard\n{"model":"smart","thinking":"high","advisor":"review",}',
      'hard\n{"model":"unknown","thinking":"high","advisor":"review"}',
      'hard\n{"model":"smart","thinking":"maximum","advisor":"review"}',
      'hard\n{"model":"smart","thinking":"high","advisor":"unknown"}',
      'hard\n{"model":"fast","model":"smart","thinking":"high","advisor":"review"}',
      'hard\n{"model":"fast","\\u006dodel":"smart","thinking":"high","advisor":"review"}',
      "hard " + "界".repeat(22_000) + '\n{"model":"smart","thinking":"high","advisor":"review"}',
    ]) {
      expect(() => parseSuggestionResponse(catalog, selection, response(content), nowMs)).toThrow("code_suggestion_invalid_response");
    }
  });

  test("rejects model attempts to change operator controls rather than ignoring them", () => {
    const catalog = compileCatalog(document());
    const selection = defaultSelection(catalog);
    for (const change of [
      { lane: "mixed" }, { capability: 3 }, { priority: true }, { fast: "on" },
      { spark: true }, { prewalk: true }, { planYolo: true }, { fallback: false },
      { accounts: ["other-account"] },
    ]) {
      const content = "hard\n" + JSON.stringify({ model: "smart", thinking: "high", advisor: "review", ...change });
      expect(() => parseSuggestionResponse(catalog, selection, response(content), nowMs)).toThrow("code_suggestion_invalid_response");
    }
  });

  test("refuses an unavailable elite rung without moving to another provider", () => {
    const input = document();
    input.models.push({ ...input.models.find(model => model.key === "a3")!, key: "a4", id: "native-a4", tier: 4 });
    const catalog = compileCatalog(input);
    const selection = defaultSelection(catalog);
    const elite = response('critical — security migration\n{"model":"elite","thinking":"xhigh","advisor":"audit"}');
    expect(() => parseSuggestionResponse(catalog, selection, elite, nowMs)).toThrow("code_suggestion_unavailable");
    const only: Selection = { ...selection, lane: { kind: "provider", family: "anthropic", blend: "only" } };
    const suggested = parseSuggestionResponse(catalog, only, elite, nowMs);
    expect(suggested.selection).toEqual({ ...only, capability: 4, thinking: "xhigh", advisor: "audit" });
  });

  test("preserves provider blend and session controls while reporting only real sizing changes", () => {
    const catalog = compileCatalog(document());
    for (const blend of ["only", "led"] as const) {
      const selection: Selection = {
        ...defaultSelection(catalog), lane: { kind: "provider", family: "openai", blend },
        spark: true, priority: true, prewalk: true, planYolo: true, fallback: false,
      };
      const snapshot = structuredClone(selection);
      const result = parseSuggestionResponse(catalog, selection, response(), nowMs);
      expect(result.selection).toEqual({ ...snapshot, capability: 3, thinking: "high", advisor: "review" });
      expect(result.changed).toEqual(["capability", "thinking", "advisor"]);
      expect(result.evaluator).toBe("qwen2.5:3b");
      expect(selection).toEqual(snapshot);
      expect(reviewCatalog(catalog, result.selection, nowMs).selection).toEqual(result.selection);
      expect(parseSuggestionResponse(catalog, result.selection, response(), nowMs).changed).toEqual([]);
    }
  });

  test("trivial sizing does not buy priority or enable Spark", () => {
    const catalog = compileCatalog(document());
    const selection = defaultSelection(catalog);
    const result = parseSuggestionResponse(catalog, selection,
      response('trivial — typo\n{"model":"fast","thinking":"minimal","advisor":"off"}'), nowMs);
    expect(result.selection).toEqual({ ...selection, capability: 1, thinking: "minimal" });
    expect(result.changed).toEqual(["capability", "thinking"]);
  });

  test("refuses invalid inputs before requesting or accepting suggestions", () => {
    const catalog = compileCatalog(document());
    const selection = defaultSelection(catalog);
    expect(() => buildSuggestionRequest(catalog, selection, " \n\t", nowMs)).toThrow("code_suggestion_invalid_request");
    expect(() => buildSuggestionRequest(catalog, selection, "size a refactor", NaN)).toThrow("code_suggestion_invalid_request");
    const invalid: Selection = { ...selection, lane: { kind: "provider", family: "anthropic", blend: "only" }, spark: true };
    expect(() => buildSuggestionRequest(catalog, invalid, "size a refactor", nowMs)).toThrow("code_suggestion_invalid_request");
    expect(() => parseSuggestionResponse(catalog, invalid, response(), nowMs)).toThrow("code_suggestion_invalid_request");
    const noVision = compileCatalog({ schemaVersion: 1, models: document().models.map(model => ({ ...model, images: false })) });
    expect(() => parseSuggestionResponse(noVision, selection, response(), nowMs)).toThrow("code_suggestion_invalid_request");
  });
});
