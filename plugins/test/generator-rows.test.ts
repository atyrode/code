import { describe, expect, test } from "bun:test";
import { compileCatalog } from "../domain/catalog.ts";
import type { CatalogModel, Selection } from "../domain/contracts.ts";
import { reviewCatalog } from "../domain/routing.ts";
import { displayAliases } from "../code/generator/aliases.ts";
import { generatorRows, stepWord, type GeneratorRow, type RowWord } from "../code/generator/rows-model.ts";
import { statementSlots, type Vocabulary } from "../code/generator/statement-model.ts";

const now = Date.UTC(2026, 9, 3, 12);

function model(key: string, provider: string, tier: CatalogModel["tier"]): CatalogModel {
  return {
    key, provider, tier, id: `native-${key}`, api: "test-api", quotaBucket: null, inputCostPerMillion: 4, outputCostPerMillion: 12,
    tokensPerSecond: 30, timeToFirstTokenMs: 100, contextWindow: 200_000, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], images: true,
  };
}
const catalog = compileCatalog({ schemaVersion: 1, models: [
  model("o1", "openai-codex", 1), model("o2", "openai-codex", 2), model("o3", "openai-codex", 3),
  model("a1", "anthropic", 1), model("a2", "anthropic", 2), model("a3", "anthropic", 3),
] });
const team = (changes: Partial<Selection> = {}): Selection => ({
  lane: { kind: "provider", family: "openai", blend: "only" }, capability: 2, thinking: "medium", advisor: "off", spark: false, priority: false,
  prewalk: false, planYolo: false, fallback: false, budget: "any", ...changes,
});
const vocab: Vocabulary = { family: family => ({ openai: "GPT", anthropic: "Claude" })[family] ?? family, time: at => String(at) };

function rows(selection: Selection, connected: ReadonlySet<string> | null = null): GeneratorRow[] {
  const review = reviewCatalog(catalog, selection, now);
  const slots = statementSlots({ catalog, selection, review, served: null, starter: false, nowMs: now, pools: [], machines: [], rosterError: false, machineId: "studio" }, vocab);
  return generatorRows({ slots, catalog, controls: review, shown: review, aliases: displayAliases(catalog), connected });
}
const row = (list: readonly GeneratorRow[], id: GeneratorRow["id"]) => list.find(entry => entry.id === id)!;

describe("the generator's rows", () => {
  test("the model row names each tier by the model its default role would lead on, and a tier no model fills reads as its word, refused", () => {
    const tier = row(rows(team()), "tier");
    expect(tier.words.map(word => [word.text, word.sub, word.available, word.selected])).toEqual([
      ["o1", "fast", true, false], ["o2", "normal", true, true], ["o3", "smart", true, false], ["elite", null, false, false],
    ]);
    // On another lane the same tiers name that lane's models.
    expect(row(rows(team({ lane: { kind: "provider", family: "anthropic", blend: "only" } })), "tier").words.map(word => word.text)).toEqual(["a1", "a2", "a3", "elite"]);
  });

  test("a lane is hidden only while its family has no signed-in account at all, and never the lane in use", () => {
    const all = row(rows(team()), "lane").words.map(word => word.key);
    expect(all).toEqual(["gpt-only", "gpt-led", "mixed", "claude-led", "claude-only"]);
    expect(row(rows(team(), new Set(["openai"])), "lane").words.map(word => word.key)).toEqual(["gpt-only", "gpt-led"]);
    const claude = team({ lane: { kind: "provider", family: "anthropic", blend: "only" } });
    expect(row(rows(claude, new Set(["openai"])), "lane").words.map(word => word.key)).toEqual(["gpt-only", "gpt-led", "claude-only"]);
  });

  test("an extra is a row of on then off: the chosen word says what it means, the other what turning it does or why it cannot", () => {
    const list = rows(team({ fallback: true }));
    const fallbacks = row(list, "fallbacks");
    expect(fallbacks.words.map(word => [word.text, word.selected, word.available])).toEqual([["on", true, true], ["off", false, true]]);
    expect(fallbacks.words[0]!.says).toMatch(/falls back/);
    expect(fallbacks.words[1]!.says).toMatch(/waits/);
    expect(fallbacks.words[1]!.option?.value).toBe("fallbacks");
    // No Spark model in this catalog: turning it on is refused with the reason, and off stays chosen.
    const spark = row(list, "spark");
    expect(spark.words[0]).toMatchObject({ text: "on", available: false, option: null });
    expect(spark.words[0]!.reason).not.toBeNull();
    expect(list.map(entry => entry.id)).toEqual(["lane", "tier", "thinking", "advisor", "spark", "fallbacks", "priority", "prewalk", "plans", "budget"]);
  });

  test("a step passes over words that cannot be chosen and stops at the end of the row", () => {
    const word = (key: string, available: boolean, selected = false) => ({ key, available, selected }) as RowWord;
    const level: GeneratorRow = { id: "tier", word: "tier", label: "model", kind: "level", words: [word("normal", true, true), word("smart", false), word("elite", true)] };
    expect(stepWord(level, true)?.key).toBe("elite");
    expect(stepWord({ ...level, words: [word("smart", false), word("elite", true, true)] }, false)).toBeNull();
    expect(stepWord({ ...level, words: [word("normal", true), word("smart", true, true)] }, true)).toBeNull();
  });
});
