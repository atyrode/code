import { describe, expect, test } from "bun:test";
import { compileCatalog } from "../domain/catalog.ts";
import type { CatalogModel, Selection } from "../domain/contracts.ts";
import { reviewCatalog } from "../domain/routing.ts";
import { displayAliases } from "../code/generator/aliases.ts";
import { generatorRows, splitLane, stepWord, type GeneratorRow, type RowWord } from "../code/generator/rows-model.ts";
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

function rows(selection: Selection, connected: ReadonlySet<string> | null = null, list = catalog, served: ReadonlySet<string> | null = null): GeneratorRow[] {
  const review = reviewCatalog(list, selection, now);
  const slots = statementSlots({ catalog: list, selection, review, served, nowMs: now, pools: [], machines: [], rosterError: false, machineId: "studio", omp: null }, vocab);
  return generatorRows({ slots, catalog: list, shown: review, aliases: displayAliases(list), connected, familyWord: vocab.family });
}
const row = (list: readonly GeneratorRow[], id: GeneratorRow["id"]) => list.find(entry => entry.id === id)!;
const lead = (selection: Selection, connected: ReadonlySet<string> | null = null, list = catalog, served: ReadonlySet<string> | null = null) =>
  row(rows(selection, connected, list, served), "lane");
const gptLed: Selection["lane"] = { kind: "provider", family: "openai", blend: "led" };
const claudeOnly: Selection["lane"] = { kind: "provider", family: "anthropic", blend: "only" };
/** GPT and Claude, and a provider with no policy of its own, whose lanes cross to nobody: it is formed alone, never led. */
const withAcme = compileCatalog({ schemaVersion: 1, models: [...catalog.models.map(entry => model(entry.key, entry.provider, entry.tier)),
  model("x1", "acme", 1), model("x2", "acme", 2), model("x3", "acme", 3)] });

describe("the generator's rows", () => {
  test("the model row names each tier by the model its default role would lead on, and a tier no model fills reads as its word, refused", () => {
    const tier = row(rows(team()), "tier");
    expect(tier.words.map(word => [word.text, word.sub, word.available, word.selected])).toEqual([
      ["o1", "fast", true, false], ["o2", "normal", true, true], ["o3", "smart", true, false], ["elite", null, false, false],
    ]);
    // On another lane the same tiers name that lane's models.
    expect(row(rows(team({ lane: { kind: "provider", family: "anthropic", blend: "only" } })), "tier").words.map(word => word.text)).toEqual(["a1", "a2", "a3", "elite"]);
  });

  test("a lead is hidden only while its family has no signed-in account at all, and never the lead in use", () => {
    expect(lead(team()).words.map(word => word.key)).toEqual(["mixed", "openai", "anthropic"]);
    expect(lead(team(), new Set(["openai"])).words.map(word => word.key)).toEqual(["openai"]);
    expect(lead(team({ lane: claudeOnly }), new Set(["openai"])).words.map(word => word.key)).toEqual(["openai", "anthropic"]);
  });

  test("a lane splits into its lead and whether that lead runs every role; Mixed reads as led", () => {
    expect(splitLane({ kind: "mixed" })).toEqual({ lead: "mixed", only: false });
    expect(splitLane(gptLed)).toEqual({ lead: "openai", only: false });
    expect(splitLane(claudeOnly)).toEqual({ lead: "anthropic", only: true });
  });

  test("changing the lead keeps the only box: gpt-only with Claude pressed is claude-only, gpt-led is claude-led", () => {
    const pressed = (selection: Selection, key: string) => lead(selection).words.find(word => word.key === key)!.option!.selection!.lane;
    expect(pressed(team(), "anthropic")).toEqual(claudeOnly);
    expect(pressed(team({ lane: gptLed }), "anthropic")).toEqual({ kind: "provider", family: "anthropic", blend: "led" });
    // From Mixed the box is unchecked, so a lead lands on its led lane.
    expect(pressed(team({ lane: { kind: "mixed" } }), "openai")).toEqual(gptLed);
    expect(pressed(team({ lane: claudeOnly }), "mixed")).toEqual({ kind: "mixed" });
  });

  test("a lead that does not offer the box's variant lands on the one it does, and its word says so", () => {
    const acme = lead(team({ lane: gptLed }), null, withAcme).words.find(word => word.key === "acme")!;
    expect(acme.option?.selection?.lane).toEqual({ kind: "provider", family: "acme", blend: "only" });
    expect(acme.says).toMatch(/^no acme-led lane, so /);
    // With the box checked the same lead is the variant asked for, said plainly.
    expect(lead(team(), null, withAcme).words.find(word => word.key === "acme")!.says).not.toMatch(/^no /);
  });

  test("the only box commits the lead's other variant, and is disabled for Mixed or a lead with one variant", () => {
    const only = (selection: Selection, list = catalog) => lead(selection, null, list).only!;
    expect(only(team())).toMatchObject({ checked: true, enabled: true, struck: false });
    expect(only(team()).word.option?.selection?.lane).toEqual(gptLed);
    expect(only(team({ lane: gptLed }))).toMatchObject({ checked: false, enabled: true });
    expect(only(team({ lane: gptLed })).word.option?.selection?.lane).toEqual({ kind: "provider", family: "openai", blend: "only" });
    expect(only(team({ lane: { kind: "mixed" } }))).toMatchObject({ checked: false, enabled: false, struck: false, word: { available: false, option: null } });
    const acme = only(team({ lane: { kind: "provider", family: "acme", blend: "only" } }), withAcme);
    expect(acme).toMatchObject({ checked: true, enabled: false, struck: false, word: { available: false, reason: "no acme-led lane" } });
  });

  test("a lead or an only box whose variant the included accounts cannot run is struck, with the variant's reason", () => {
    const codexOnly = lead(team(), null, catalog, new Set(["openai-codex"]));
    // GPT-led reviews on Claude, which no included account serves.
    expect(codexOnly.only).toMatchObject({ checked: true, enabled: true, struck: true, word: { available: false, option: null } });
    expect(codexOnly.only!.word.reason).toBeTruthy();
    expect(codexOnly.words.find(word => word.key === "anthropic")).toMatchObject({ available: false, option: null });
  });

  test("a lead whose variant on the box's side cannot run lands on the one that can, and says so; it is struck only when neither can", () => {
    // On Mixed with Claude unserved, GPT-led cannot run but GPT only can, so GPT stays pickable and says where it lands.
    const codexOnly = lead(team({ lane: { kind: "mixed" } }), null, catalog, new Set(["openai-codex"]));
    const gpt = codexOnly.words.find(word => word.key === "openai")!;
    expect(gpt).toMatchObject({ available: true, reason: null });
    expect(gpt.option?.selection?.lane).toEqual({ kind: "provider", family: "openai", blend: "only" });
    expect(gpt.says).toMatch(/^GPT-led cannot run, so GPT only/);
    expect(codexOnly.words.find(word => word.key === "anthropic")).toMatchObject({ available: false, option: null });
  });

  test("an extra is a row of on then off: the chosen word says what it means, the other what turning it does or why it cannot", () => {
    const list = rows(team({ fallback: true }));
    const fallbacks = row(list, "fallbacks");
    expect(fallbacks.words.map(word => [word.text, word.selected, word.available])).toEqual([["on", true, true], ["off", false, true]]);
    expect(fallbacks.words[0]!.says).toMatch(/falls back/);
    expect(fallbacks.words[1]!.says).toMatch(/waits/);
    expect(fallbacks.words[1]!.option?.value).toBe("fallbacks");
    // The generator keeps five rows; priority, prewalk and auto plans are the session options sheet's switches, and the budget is no control.
    expect(list.map(entry => entry.id)).toEqual(["lane", "tier", "thinking", "advisor", "fallbacks"]);
  });

  test("a family with a signed-in account but no listed model keeps its lanes, struck with the reason and one verification away", () => {
    const gptOnly = compileCatalog({ schemaVersion: 1, models: [model("o1", "openai-codex", 1), model("o2", "openai-codex", 2), model("o3", "openai-codex", 3)] });
    const selection = team();
    const review = reviewCatalog(gptOnly, selection, now);
    const slots = statementSlots({ catalog: gptOnly, selection, review, served: null, nowMs: now, pools: [], machines: [], rosterError: false, machineId: "studio", omp: null }, vocab);
    const words = (connected: ReadonlySet<string> | null) => generatorRows({ slots, catalog: gptOnly, shown: review, aliases: displayAliases(gptOnly), connected, familyWord: vocab.family })[0]!;
    const both = words(new Set(["openai", "anthropic"]));
    expect(both.words.map(word => [word.key, word.available])).toEqual([["mixed", false], ["openai", true], ["anthropic", false]]);
    expect(both.words.find(word => word.key === "anthropic")).toMatchObject({ reason: "No Claude models in your model list", verifies: true, option: null });
    // The box on GPT only would select GPT-led, which needs the Claude models the list lacks: struck, one verification away.
    expect(both.only).toMatchObject({ enabled: true, struck: true, word: { verifies: true } });
    // A family nobody has signed in for is not offered at all, and with no reading nothing is claimed missing.
    expect(words(new Set(["openai"])).words.map(word => word.key)).toEqual(["openai"]);
    expect(words(null).words.map(word => word.key)).toEqual(["openai"]);
    expect(words(null).only).toMatchObject({ enabled: false, word: { reason: "no GPT-led lane" } });
  });

  test("a step passes over words that cannot be chosen and stops at the end of the row", () => {
    const word = (key: string, available: boolean, selected = false) => ({ key, available, selected }) as RowWord;
    const level: GeneratorRow = { id: "tier", word: "tier", label: "model", kind: "level", words: [word("normal", true, true), word("smart", false), word("elite", true)], only: null };
    expect(stepWord(level, true)?.key).toBe("elite");
    expect(stepWord({ ...level, words: [word("smart", false), word("elite", true, true)] }, false)).toBeNull();
    expect(stepWord({ ...level, words: [word("normal", true), word("smart", true, true)] }, true)).toBeNull();
  });
});
