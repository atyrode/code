import { describe, expect, test } from "bun:test";
import type { AccountsObservation, PermittedUsageSnapshot } from "@atyrode/manifold-omp";
import { initialAccountChoices, reduceAccountChoices } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import type { CatalogModel, Selection } from "../domain/contracts.ts";
import { quotaPools, type QuotaPool } from "../domain/quota.ts";
import { reviewCatalog, type Review } from "../domain/routing.ts";
import { projectUsage } from "../domain/usage.ts";
import { optionConsequence, seatRole, type OptionContext } from "../code/generator/consequences.ts";
import { chooseOption } from "../code/generator/dial-space.ts";

const scope = "machine/broker-scope";
const now = Date.UTC(2026, 9, 3, 12);
const HOUR = 3_600_000;

function model(key: string, provider: string, tier: CatalogModel["tier"], changes: Partial<CatalogModel> = {}): CatalogModel {
  return {
    key, provider, tier, id: `native-${key}`, api: "test-api", quotaBucket: null,
    inputCostPerMillion: 4, outputCostPerMillion: 12, tokensPerSecond: 30, timeToFirstTokenMs: 100,
    contextWindow: 200_000, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], images: true,
    ...changes,
  };
}
const catalog = compileCatalog({ schemaVersion: 1, models: [
  model("o1", "openai-codex", 1), model("o2", "openai-codex", 2), model("o3", "openai-codex", 3),
  model("a1", "anthropic", 1), model("a2", "anthropic", 2), model("a3", "anthropic", 3),
  model("d1", "deepseek", 1, { images: false }),
] });
const gptOnly: Selection["lane"] = { kind: "provider", family: "openai", blend: "only" };
const claudeOnly: Selection["lane"] = { kind: "provider", family: "anthropic", blend: "only" };

function review(changes: Partial<Selection> = {}): Review {
  return reviewCatalog(catalog, {
    lane: gptOnly, capability: 2, thinking: "medium", advisor: "off", spark: false,
    priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any", ...changes,
  }, now);
}
const known: OptionContext = { served: null, starter: false, nowMs: now };

/** Pools from a real projection: one Codex and one Claude account, both quiet unless told otherwise. */
function pools(options: { claudeBlockedUntil?: number; codexUsed?: number; claudeExcluded?: boolean } = {}): QuotaPool[] {
  const people = [["openai-codex", 1, "codex@example.test"], ["anthropic", 2, "claude@example.test"]] as const;
  const observation: AccountsObservation = { scope, observedAt: now, status: "fresh", accounts: people.map(([provider, credentialId, identityKey]) => ({
    reference: { kind: "identity", scope, provider, identityKey }, credentialId, identityKey, type: "oauth", email: identityKey, disabled: false,
    blocks: provider === "anthropic" && options.claudeBlockedUntil ? [{ scope: "", until: options.claudeBlockedUntil }] : [],
  })) };
  const reports: PermittedUsageSnapshot["accounts"] = people.map(([provider, credentialId, identityKey]) => ({
    provider, credentialId, identityKey, observedAt: now, status: "reported",
    windows: [{ windowId: "5h", tier: null, usedFraction: provider === "openai-codex" ? options.codexUsed ?? 0.1 : 0.1, quotaStatus: null,
      resetsAt: now + HOUR, durationMs: 5 * HOUR, observedAt: now }],
  }));
  const choices = options.claudeExcluded
    ? reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference: observation.accounts[1]!.reference, enabled: false })
    : initialAccountChoices();
  const view = projectUsage({ scope, observedAt: now, accounts: reports }, observation, choices, now, { maxAgeMs: 300_000, refreshStatus: "succeeded" });
  return quotaPools(catalog, { view, current: true, nowMs: now });
}

describe("what an option would do before it is chosen", () => {
  test("the roles that move, from and to, and nothing for roles whose only change is their fallback chain", () => {
    const consequence = optionConsequence(catalog, review(), "lane", "gpt-led", { ...known, pools: pools() });
    // GPT-led sends reviews to Claude; every other role keeps its lead and only gains Claude fallbacks.
    expect(consequence?.moves).toEqual([
      { role: "reviewer", from: { key: "o3", thinking: "high" }, to: { key: "a3", thinking: "high" } },
      { role: "security-reviewer", from: { key: "o3", thinking: "high" }, to: { key: "a3", thinking: "high" } },
    ]);
    expect(consequence?.redline).toBeNull();
    const advisor = optionConsequence(catalog, review(), "advisor", "glance", { ...known, pools: pools() });
    expect(advisor?.moves).toEqual([{ role: "advisor", from: null, to: { key: "o1", thinking: "low" } }]);
  });

  test("a redline when the option would lead on a blocked, tight or unserved pool, naming the roles that would", () => {
    const blocked = pools({ claudeBlockedUntil: now + 2 * HOUR });
    expect(optionConsequence(catalog, review(), "lane", "gpt-led", { ...known, pools: blocked })?.redline)
      .toMatchObject({ reason: "blocked", pool: { id: "anthropic:claude" }, until: now + 2 * HOUR, roles: ["reviewer", "security-reviewer"] });
    // An option that keeps every lead off the blocked pool is not redlined by it.
    expect(optionConsequence(catalog, review(), "thinking", "high", { ...known, pools: blocked })?.redline).toBeNull();
    expect(optionConsequence(catalog, review(), "thinking", "high", { ...known, pools: pools({ codexUsed: 0.85 }) })?.redline)
      .toMatchObject({ reason: "tight", pool: { id: "openai-codex:codex" } });
    // Unserved outranks tight, and the lane the dial would refuse once accounts are known is not offered at all.
    const unserved = pools({ claudeExcluded: true, codexUsed: 0.85 });
    expect(optionConsequence(catalog, review(), "lane", "gpt-led", { ...known, pools: unserved })?.redline)
      .toMatchObject({ reason: "no-account", pool: { id: "anthropic:claude" }, roles: ["reviewer", "security-reviewer"] });
    expect(optionConsequence(catalog, review(), "lane", "gpt-led", { ...known, served: new Set(["openai-codex"]), pools: unserved })).toBeNull();
  });
});

describe("the smallest dial move that seats a role on a model", () => {
  test("one move when one suffices, preferring the move that disturbs the fewest other roles over dial order", () => {
    expect(seatRole(catalog, review(), "reviewer", "a3", known)).toMatchObject({ moves: [{ dial: "lane", word: "gpt-led" }], othersMoved: 1 });
    // From Claude only, GPT only and GPT-led also seat default on o2, but Mixed keeps planning and reviews where they are.
    const fromClaude = seatRole(catalog, review({ lane: claudeOnly }), "default", "o2", known);
    expect(fromClaude?.moves).toEqual([{ dial: "lane", word: "mixed" }]);
    expect(fromClaude?.review.routes.find(route => route.role === "reviewer")?.lead.key).toBe("a3");
  });

  test("two moves only when no single move reaches the seat", () => {
    expect(seatRole(catalog, review(), "reviewer", "a2", known, 1)).toBeNull();
    const seating = seatRole(catalog, review(), "reviewer", "a2", known);
    expect(seating?.moves).toHaveLength(2);
    expect(seating?.review.routes.find(route => route.role === "reviewer")?.lead.key).toBe("a2");
  });

  test("already seated is zero moves; unreachable or account-refused seats are not found", () => {
    expect(seatRole(catalog, review(), "default", "o2", known)).toMatchObject({ moves: [], othersMoved: 0 });
    // DeepSeek-led keeps reviews on GPT where DeepSeek only would move them too.
    expect(seatRole(catalog, review(), "default", "d1", known, 1)?.moves).toEqual([{ dial: "lane", word: "deepseek-led" }]);
    expect(seatRole(catalog, review(), "default", "nowhere", known)).toBeNull();
    // With no Claude account, every lane that would have reviews lead on Claude is refused, so none seats them there.
    expect(seatRole(catalog, review(), "reviewer", "a3", { ...known, served: new Set(["openai-codex", "deepseek"]) })).toBeNull();
  });
});

describe("which options the session door would accept", () => {
  // The API-key tier-1 GPT model is served by no account here; Codex and Claude are.
  const mixedProviders = compileCatalog({ schemaVersion: 1, models: [
    model("o1", "openai", 1), model("o2", "openai-codex", 2), model("o3", "openai-codex", 3),
    model("a1", "anthropic", 1), model("a2", "anthropic", 2), model("a3", "anthropic", 3),
  ] });
  const base = reviewCatalog(mixedProviders, {
    lane: claudeOnly, capability: 1, thinking: "medium", advisor: "off", spark: false,
    priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any",
  }, now);
  const served: OptionContext = { ...known, served: new Set(["anthropic", "openai-codex"]) };

  test("a lane whose only unserved model is a fallback is offered, with the fallbacks it would lose noted", () => {
    // Claude-led at Fast: o1 appears only in fallback chains, so the door prunes it and launches.
    const led = chooseOption(mixedProviders, base.selection, base, "lane", "claude-led", served);
    expect(led.refusal).toBeNull();
    expect(led.review?.routes.some(route => route.lead.key === "o1")).toBe(false);
    expect(led.pruned).toEqual([{ provider: "openai", family: "openai",
      roles: led.review!.routes.filter(route => route.fallback.some(choice => choice.key === "o1")).map(route => route.role) }]);
    expect(led.pruned[0]!.roles.length).toBeGreaterThan(0);
  });

  test("an option that would lead on an unserved provider is refused by name, though its family is served", () => {
    // GPT-led at Fast leads default on o1; Codex accounts serve the family, not the API-key provider.
    expect(chooseOption(mixedProviders, base.selection, base, "lane", "gpt-led", served).refusal)
      .toEqual({ kind: "account", provider: "openai", family: "openai" });
    // Without knowing the pool, nothing is refused or noted on the reading's behalf.
    expect(chooseOption(mixedProviders, base.selection, base, "lane", "gpt-led", known)).toMatchObject({ refusal: null, pruned: [] });
  });
});
