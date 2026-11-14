import { describe, expect, test } from "bun:test";
import type { AccountsObservation, PermittedUsageSnapshot } from "@atyrode/manifold-omp";
import { initialAccountChoices, reduceAccountChoices } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import type { CatalogModel, Selection } from "../domain/contracts.ts";
import { quotaPools, type QuotaPool } from "../domain/quota.ts";
import { reviewCatalog, type Review } from "../domain/routing.ts";
import { projectUsage } from "../domain/usage.ts";
import { optionConsequence, rescue, seatRole, type OptionContext } from "../code/generator/consequences.ts";
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
  model("o1", "openai-codex", 1), model("o2", "openai-codex", 2), model("o3", "openai-codex", 3), model("o4", "openai-codex", 4),
  model("a1", "anthropic", 1), model("a2", "anthropic", 2), model("a3", "anthropic", 3), model("a4", "anthropic", 4),
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
const known: OptionContext = { served: null, nowMs: now };

type Provider = "openai-codex" | "anthropic" | "deepseek";
/** Pools from a real projection: one Codex and one Claude subscription and a DeepSeek key, quiet and open unless told otherwise. */
function pools(options: { blocked?: Partial<Record<Provider, number>>; codexUsed?: number; claudeExcluded?: boolean } = {}): QuotaPool[] {
  const blocks = (provider: Provider) => {
    const until = options.blocked?.[provider];
    return until === undefined ? [] : [{ scope: "", until }];
  };
  const people = [["openai-codex", 1, "codex@example.test"], ["anthropic", 2, "claude@example.test"]] as const;
  const observation: AccountsObservation = { scope, observedAt: now, status: "fresh", accounts: [
    ...people.map(([provider, credentialId, identityKey]) => ({
      reference: { kind: "identity" as const, scope, provider, identityKey }, credentialId, identityKey, type: "oauth" as const, email: identityKey,
      disabled: false, blocks: blocks(provider),
    })),
    { reference: { kind: "credential", scope, provider: "deepseek", credentialId: 3 }, credentialId: 3, identityKey: null, type: "api_key", email: null,
      disabled: false, blocks: blocks("deepseek") },
  ] };
  const reports: PermittedUsageSnapshot["accounts"] = [
    ...people.map(([provider, credentialId, identityKey]) => ({
      provider, credentialId, identityKey, observedAt: now, status: "reported" as const,
      windows: [{ windowId: "5h", tier: null, usedFraction: provider === "openai-codex" ? options.codexUsed ?? 0.1 : 0.1, quotaStatus: null,
        resetsAt: now + HOUR, durationMs: 5 * HOUR, observedAt: now }],
    })),
    { provider: "deepseek", credentialId: 3, identityKey: null, observedAt: now, status: "no_usage", windows: [] },
  ];
  const choices = options.claudeExcluded
    ? reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference: observation.accounts[1]!.reference, enabled: false })
    : initialAccountChoices();
  const view = projectUsage({ scope, observedAt: now, accounts: reports }, observation, choices, now, { maxAgeMs: 300_000, refreshStatus: "succeeded" });
  return quotaPools(catalog, { view, current: true, nowMs: now });
}

describe("what an option would do before it is chosen", () => {
  test("the roles that move, from and to, and nothing for roles whose only change is their fallback chain", () => {
    const consequence = optionConsequence(catalog, review(), "lane", "mixed", { ...known, pools: pools() });
    // Mixed moves shared planning and slow work across providers, without promoting their selected rung.
    expect(consequence?.moves).toEqual([
      { role: "plan", from: { key: "o2", thinking: "high" }, to: { key: "a2", thinking: "high" } },
      { role: "slow", from: { key: "o2", thinking: "high" }, to: { key: "a2", thinking: "high" } },
    ]);
    expect(consequence?.redline).toBeNull();
    // A provider-led lane changes the chains, not the shared-role leads.
    expect(optionConsequence(catalog, review(), "lane", "gpt-led", { ...known, pools: pools() })?.moves).toEqual([]);
    const advisor = optionConsequence(catalog, review(), "advisor", "glance", { ...known, pools: pools() });
    expect(advisor?.moves).toEqual([{ role: "advisor", from: null, to: { key: "o1", thinking: "low" } }]);
    expect(optionConsequence(catalog, review({ advisor: "glance" }), "advisor", "off", { ...known, pools: pools() })?.moves)
      .toEqual([{ role: "advisor", from: { key: "o1", thinking: "low" }, to: null }]);
  });

  test("a redline when the option would lead on a blocked, tight or unserved pool, naming the roles that would", () => {
    const blocked = pools({ blocked: { anthropic: now + 2 * HOUR } });
    expect(optionConsequence(catalog, review(), "lane", "mixed", { ...known, pools: blocked })?.redline)
      .toMatchObject({ reason: "blocked", pool: { id: "anthropic:claude" }, until: now + 2 * HOUR, roles: ["plan", "slow"] });
    // An option that keeps every lead off the blocked pool is not redlined by it.
    expect(optionConsequence(catalog, review(), "thinking", "high", { ...known, pools: blocked })?.redline).toBeNull();
    expect(optionConsequence(catalog, review(), "thinking", "high", { ...known, pools: pools({ codexUsed: 0.85 }) })?.redline)
      .toMatchObject({ reason: "tight", pool: { id: "openai-codex:codex" } });
    // Unserved outranks tight, and the lane the dial would refuse once accounts are known is not offered at all.
    const unserved = pools({ claudeExcluded: true, codexUsed: 0.85 });
    expect(optionConsequence(catalog, review(), "lane", "mixed", { ...known, pools: unserved })?.redline)
      .toMatchObject({ reason: "no-account", pool: { id: "anthropic:claude" }, roles: ["plan", "slow"] });
    expect(optionConsequence(catalog, review(), "lane", "mixed", { ...known, served: new Set(["openai-codex"]), pools: unserved })).toBeNull();
  });

  test("tier and effort dials preserve explicit premium choices without raising utility effort or hiding a planning promotion", () => {
    const base = review();
    expect(base.routes.filter(route => route.role === "plan" || route.role === "slow").map(route => route.lead))
      .toEqual([{ key: "o2", thinking: "high" }, { key: "o2", thinking: "high" }]);
    for (const [word, key] of [["smart", "o3"], ["elite", "o4"]] as const) {
      const chosen = chooseOption(catalog, base.selection, base, "model", word, known);
      expect(chosen.refusal).toBeNull();
      expect(chosen.review?.routes.filter(route => ["default", "task", "plan", "slow"].includes(route.role)).map(route => route.lead.key))
        .toEqual([key, key, key, key]);
    }
    const max = chooseOption(catalog, base.selection, base, "thinking", "max", known).review!;
    expect(max.selection.thinking).toBe("max");
    expect(max.routes.filter(route => route.role === "default" || route.role === "task").map(route => route.lead.thinking)).toEqual(["max", "max"]);
    expect(max.routes.filter(route => route.role === "plan" || route.role === "slow").map(route => route.lead.thinking)).toEqual(["high", "high"]);
    for (const role of ["smol", "memory"]) expect(max.routes.find(route => route.role === role)?.lead).toEqual({ key: "o1", thinking: "medium" });
    for (const role of ["widget", "tiny", "commit"]) expect(max.routes.find(route => route.role === role)?.lead).toEqual({ key: "o1", thinking: "low" });
    expect(max.routes.find(route => route.role === "vision")?.lead.thinking).toBe("low");
    for (const role of ["memory", "widget"]) expect(max.routes.find(route => route.role === role)?.fallback).toEqual([]);
    const withoutFallbacks = chooseOption(catalog, max.selection, max, "fallbacks", "off", known).review!;
    for (const [role, thinking] of [["memory", "medium"], ["widget", "low"]] as const) {
      expect(withoutFallbacks.routes.find(route => route.role === role)).toMatchObject({ lead: { key: "o1", thinking }, fallback: [] });
    }
    for (const [word, key, thinking] of [["glance", "o1", "low"], ["review", "o2", "medium"], ["audit", "o3", "high"]] as const) {
      expect(chooseOption(catalog, max.selection, max, "advisor", word, known).review?.routes.find(route => route.role === "advisor")?.lead)
        .toEqual({ key, thinking });
    }
  });
});

describe("the smallest dial move that seats a role on a model", () => {
  test("one move when one suffices, preferring the move that disturbs the fewest other roles over dial order", () => {
    expect(seatRole(catalog, review(), "slow", "a2", known)).toMatchObject({ moves: [{ dial: "lane", word: "mixed" }], othersMoved: 1 });
    // From Claude only, GPT only and GPT-led also seat default on o2, but Mixed keeps planning and slow work where they are.
    const fromClaude = seatRole(catalog, review({ lane: claudeOnly }), "default", "o2", known);
    expect(fromClaude?.moves).toEqual([{ dial: "lane", word: "mixed" }]);
    expect(fromClaude?.review.routes.find(route => route.role === "slow")?.lead.key).toBe("a2");
  });

  test("two moves only when no single move reaches the seat", () => {
    expect(seatRole(catalog, review(), "slow", "a3", known, 1)).toBeNull();
    const seating = seatRole(catalog, review(), "slow", "a3", known);
    expect(seating?.moves).toHaveLength(2);
    expect(seating?.review.routes.find(route => route.role === "slow")?.lead.key).toBe("a3");
  });

  test("already seated is zero moves; unreachable or account-refused seats are not found", () => {
    expect(seatRole(catalog, review(), "default", "o2", known)).toMatchObject({ moves: [], othersMoved: 0 });
    // The single-rung DeepSeek family is reachable with one lane move.
    expect(seatRole(catalog, review(), "default", "d1", known, 1)?.moves).toEqual([{ dial: "lane", word: "deepseek-led" }]);
    expect(seatRole(catalog, review(), "default", "nowhere", known)).toBeNull();
    // With no Claude account, every lane that would lead shared slow work there is refused.
    expect(seatRole(catalog, review(), "slow", "a2", { ...known, served: new Set(["openai-codex", "deepseek"]) })).toBeNull();
  });
});

describe("the smallest dial move that gives every role a route", () => {
  const claudeBlocked = pools({ blocked: { anthropic: now + 2 * HOUR } });
  const everyRole = review().routes.map(route => route.role);

  test("Claude only with Claude blocked: GPT only keeps every native shared role on Codex", () => {
    const fix = rescue(catalog, review({ lane: claudeOnly }), claudeBlocked, known);
    expect(fix?.moves).toEqual([{ dial: "lane", word: "gpt-only" }]);
    expect(fix?.rescued.leads).toHaveLength(1);
    expect(fix?.rescued.leads[0]).toMatchObject({ pool: { id: "openai-codex:codex" } });
    expect([...fix!.rescued.leads[0]!.roles].sort()).toEqual([...everyRole].sort());
    expect(fix?.rescued).toMatchObject({ fallsBack: [], removed: [] });
    expect(fix?.waitedOn.map(pool => pool.id)).toEqual(["anthropic:claude"]);
  });

  test("Mixed with Claude blocked: fallbacks carry plan and slow; without them, GPT only seats their leads on an open pool", () => {
    expect(rescue(catalog, review({ lane: { kind: "mixed" } }), claudeBlocked, known))
      .toMatchObject({ moves: [], rescued: { leads: [], fallsBack: [], removed: [] } });
    const fix = rescue(catalog, review({ lane: { kind: "mixed" }, fallback: false }), claudeBlocked, known);
    // Fallbacks on would route them too, but only by OMP falling back; GPT only leads them on an open pool and moves nobody else.
    expect(fix).toMatchObject({ moves: [{ dial: "lane", word: "gpt-only" }], othersMoved: 0 });
    expect(fix?.rescued.leads).toEqual([{ pool: expect.objectContaining({ id: "openai-codex:codex" }), roles: ["plan", "slow"] }]);
  });

  test("when only the advisor waits, a provider-only lane seats it without moving the other shared leads", () => {
    const deepseekLed = review({ lane: { kind: "provider", family: "deepseek", blend: "led" }, advisor: "glance" });
    const fix = rescue(catalog, deepseekLed, claudeBlocked, known);
    expect(fix?.moves).toEqual([{ dial: "lane", word: "deepseek-only" }]);
    expect(fix?.rescued).toEqual({ leads: [{ pool: expect.objectContaining({ id: "deepseek" }), roles: ["advisor"] }], fallsBack: [], removed: [] });
    expect(fix?.othersMoved).toBe(0);
  });

  test("no fix when every reachable team still leaves a role without a route", () => {
    const everythingBlocked = pools({ blocked: { "openai-codex": now + HOUR, anthropic: now + HOUR, deepseek: now + HOUR } });
    expect(rescue(catalog, review({ lane: claudeOnly }), everythingBlocked, known)).toBeNull();
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
