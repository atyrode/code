import { describe, expect, test } from "bun:test";
import type { AccountsObservation, PermittedUsageSnapshot } from "@atyrode/manifold-omp";
import { initialAccountChoices, reduceAccountChoices } from "./accounts.ts";
import { compileCatalog } from "./catalog.ts";
import type { CatalogModel, Selection } from "./contracts.ts";
import { paceForecast, quotaPools, roleOutcomes, windowState, type QuotaPool, type QuotaReading, type RoleOutcome } from "./quota.ts";
import { reviewCatalog } from "./routing.ts";
import { projectUsage } from "./usage.ts";

const scope = "machine/broker-scope";
const now = Date.UTC(2026, 9, 3, 12);
const MINUTE = 60_000, HOUR = 3_600_000;

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
  model("spark", "openai-codex", 0, { images: false }),
  model("a1", "anthropic", 1), model("a2", "anthropic", 2), model("a3", "anthropic", 3),
  model("d1", "deepseek", 1, { images: false }),
] });

function selection(changes: Partial<Selection> = {}): Selection {
  return {
    lane: { kind: "provider", family: "openai", blend: "led" }, capability: 2, thinking: "medium", advisor: "off", spark: false,
    priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any", ...changes,
  };
}
const claudeOnly: Selection["lane"] = { kind: "provider", family: "anthropic", blend: "only" };

/** Three Codex subscriptions, one Claude subscription, one DeepSeek key. */
const people = {
  alice: { provider: "openai-codex", credentialId: 1, identityKey: "alice@example.test" },
  bob: { provider: "openai-codex", credentialId: 2, identityKey: "bob@example.test" },
  dave: { provider: "openai-codex", credentialId: 4, identityKey: "dave@example.test" },
  carol: { provider: "anthropic", credentialId: 3, identityKey: "carol@example.test" },
  erin: { provider: "deepseek", credentialId: 5, identityKey: null },
} as const;
type Person = keyof typeof people;
type Window = PermittedUsageSnapshot["accounts"][number]["windows"][number];

function observation(blocks: Partial<Record<Person, { scope: string; until: number }[]>>): AccountsObservation {
  return { scope, observedAt: now, status: "fresh", accounts: (Object.keys(people) as Person[]).map(name => {
    const { provider, credentialId, identityKey } = people[name];
    return identityKey === null
      ? { reference: { kind: "credential", scope, provider, credentialId }, credentialId, identityKey: null, type: "api_key", email: null, disabled: false, blocks: blocks[name] ?? [] }
      : { reference: { kind: "identity", scope, provider, identityKey }, credentialId, identityKey, type: "oauth", email: identityKey, disabled: false, blocks: blocks[name] ?? [] };
  }) };
}

function window(usedFraction: number | null, changes: Partial<Window> = {}): Window {
  return { windowId: "5h", tier: null, usedFraction, quotaStatus: null, resetsAt: now + HOUR, durationMs: 5 * HOUR,
    observedAt: usedFraction === null ? null : now, ...changes };
}

/** A real projection of this usage; Codex accounts not given windows report a quiet one. `readAt` dates one account's own report. */
function reading(windows: Partial<Record<Person, Window[]>>, options: {
  blocks?: Partial<Record<Person, { scope: string; until: number }[]>>; excluded?: Person[]; observedAt?: number; current?: boolean;
  readAt?: Partial<Record<Person, number>>;
} = {}): QuotaReading {
  const accounts = observation(options.blocks ?? {});
  const observedAt = options.observedAt ?? now;
  let choices = initialAccountChoices();
  for (const name of options.excluded ?? []) {
    choices = reduceAccountChoices(choices, { kind: "set-account", reference: accounts.accounts.find(account => account.credentialId === people[name].credentialId)!.reference, enabled: false });
  }
  const reports = (Object.keys(people) as Person[]).map(name => {
    const readAt = options.readAt?.[name] ?? observedAt;
    return {
      provider: people[name].provider, credentialId: people[name].credentialId, identityKey: people[name].identityKey, observedAt: readAt,
      status: name === "erin" ? "no_usage" as const : "reported" as const,
      windows: name === "erin" ? [] : (windows[name] ?? [window(0.1)]).map(entry => entry.observedAt === null ? entry : { ...entry, observedAt: readAt }),
    };
  });
  const view = projectUsage({ scope, observedAt, accounts: reports }, accounts, choices, now, { maxAgeMs: 5 * MINUTE, refreshStatus: "succeeded" });
  return { view, current: options.current ?? true, nowMs: now };
}

function pool(pools: readonly QuotaPool[], id: string): QuotaPool {
  const found = pools.find(candidate => candidate.id === id);
  if (!found) throw new Error(`No pool ${id}`);
  return found;
}
function outcomes(lane: Selection, value: QuotaReading): Map<string, RoleOutcome> {
  const routes = reviewCatalog(catalog, lane, now).routes;
  return new Map(roleOutcomes(catalog, routes, quotaPools(catalog, value)).map(outcome => [outcome.role, outcome]));
}

describe("what each role runs, from its own chain and the pools", () => {
  const blocked = { carol: [{ scope: "", until: now + 5 * HOUR }] };

  test("Claude only with a blocked Claude: fallbacks on still leave no route, until the block ends", () => {
    const team = selection({ lane: claudeOnly });
    expect(reviewCatalog(catalog, team, now).routes.find(route => route.role === "default")!.fallback.length).toBeGreaterThan(0);
    const result = outcomes(team, reading({}, { blocks: blocked }));
    for (const outcome of result.values()) {
      expect(outcome).toEqual({ role: outcome.role, kind: "no-route", until: now + 5 * HOUR });
    }
  });

  test("GPT-led rescues reviews on Codex until Claude reopens; with fallbacks off the same reviews have no route", () => {
    const result = outcomes(selection(), reading({}, { blocks: blocked }));
    expect(result.get("reviewer")).toMatchObject({ kind: "falls-back", model: { key: "o3" }, pool: { id: "openai-codex:codex" }, until: now + 5 * HOUR });
    expect(result.get("default")).toMatchObject({ kind: "leads", model: { key: "o2" }, pool: { id: "openai-codex:codex", verdict: { kind: "room" } } });
    const off = outcomes(selection({ fallback: false }), reading({}, { blocks: blocked }));
    expect(off.get("reviewer")).toEqual({ role: "reviewer", kind: "no-route", until: now + 5 * HOUR });
    expect(off.get("default")?.kind).toBe("leads");
  });

  test("no included account for the lead refuses the role; an unserved fallback is skipped, never a rescue", () => {
    const withoutClaude = reading({}, { excluded: ["carol"] });
    expect(pool(quotaPools(catalog, withoutClaude), "anthropic:claude").verdict).toEqual({ kind: "none" });
    for (const outcome of outcomes(selection({ lane: claudeOnly }), withoutClaude).values()) {
      expect(outcome).toEqual({ role: outcome.role, kind: "no-account", provider: "anthropic" });
    }
    // Codex exhausted everywhere: default's chain runs o1 (exhausted too), then Claude, which nobody serves.
    const spent = [window(1, { resetsAt: now + 2 * HOUR })];
    const result = outcomes(selection(), reading({ alice: spent, bob: spent, dave: [window(1, { resetsAt: now + HOUR })] }, { excluded: ["carol"] }));
    expect(result.get("default")).toEqual({ role: "default", kind: "no-route", until: now + HOUR });
    expect(result.get("reviewer")).toEqual({ role: "reviewer", kind: "no-account", provider: "anthropic" });
  });

  test("with no account signed in at all, every role says so, never that it leads", () => {
    const empty: AccountsObservation = { scope, observedAt: now, status: "fresh", accounts: [] };
    const view = projectUsage({ scope, observedAt: now, accounts: [] }, empty, initialAccountChoices(), now, { maxAgeMs: 5 * MINUTE, refreshStatus: "succeeded" });
    const result = outcomes(selection(), { view, current: true, nowMs: now });
    expect([...result.values()].every(outcome => outcome.kind === "no-account")).toBe(true);
    expect(result.get("default")).toEqual({ role: "default", kind: "no-account", provider: "openai-codex" });
  });

  test("no route waits for the earliest reopening, and says nothing when any pool in the chain has no reported reset", () => {
    const spent = [window(1, { resetsAt: null })];
    const result = outcomes(selection(), reading({ alice: spent, bob: spent, dave: spent }, { blocks: blocked }));
    expect(result.get("default")).toEqual({ role: "default", kind: "no-route", until: null });
  });

  test("Spark is its own pool: a Spark block moves tiny and commit to the regular rung while it lasts", () => {
    const sparkBlocked = { alice: [{ scope: "spark", until: now + 40 * MINUTE }], bob: [{ scope: "spark", until: now + 40 * MINUTE }],
      dave: [{ scope: "tier:spark", until: now + 30 * MINUTE }] };
    const value = reading({}, { blocks: sparkBlocked });
    expect(quotaPools(catalog, value).map(entry => entry.id)).toEqual(["openai-codex:codex", "openai-codex:codex-spark", "anthropic:claude", "deepseek"]);
    expect(pool(quotaPools(catalog, value), "openai-codex:codex-spark").verdict).toEqual({ kind: "blocked", until: now + 30 * MINUTE });
    const result = outcomes(selection({ lane: { kind: "provider", family: "openai", blend: "only" }, spark: true }), value);
    for (const role of ["tiny", "commit"]) expect(result.get(role)).toMatchObject({ kind: "falls-back", model: { key: "o1" }, until: now + 30 * MINUTE });
    expect(result.get("default")?.kind).toBe("leads");
  });

  test("an unmetered provider is served without claiming room, and an account-wide block still stops it", () => {
    expect(pool(quotaPools(catalog, reading({})), "deepseek").verdict).toEqual({ kind: "unmetered" });
    const value = reading({}, { blocks: { erin: [{ scope: "", until: now + 20 * MINUTE }] } });
    expect(pool(quotaPools(catalog, value), "deepseek").verdict).toEqual({ kind: "blocked", until: now + 20 * MINUTE });
    const result = outcomes(selection({ lane: { kind: "provider", family: "deepseek", blend: "only" } }), value);
    expect(result.get("default")).toEqual({ role: "default", kind: "no-route", until: now + 20 * MINUTE });
  });
});

describe("pool verdicts", () => {
  const verdict = (windows: Partial<Record<Person, Window[]>>, id = "openai-codex:codex") => pool(quotaPools(catalog, reading(windows)), id).verdict;

  test("room, thin and tight count accounts with every window under 80%, at the 80% boundary", () => {
    expect(verdict({ alice: [window(0.79)], bob: [window(0.79)], dave: [window(0.79)] })).toEqual({ kind: "room" });
    expect(verdict({ alice: [window(0.8)], bob: [window(0.1)], dave: [window(0.1)] })).toEqual({ kind: "room" });
    expect(verdict({ alice: [window(0.1)], bob: [window(0.8)], dave: [window(0.85)] })).toEqual({ kind: "thin" });
    expect(verdict({ alice: [window(0.8)], bob: [window(0.96)], dave: [window(0.99)] })).toEqual({ kind: "tight" });
    // Any one window over the line takes the account out of room, though the others are low.
    expect(verdict({ alice: [window(0.1), window(0.9, { windowId: "7d", durationMs: 7 * 24 * HOUR })], bob: [window(0.9)], dave: [window(0.9)] })).toEqual({ kind: "tight" });
    // A provider warning is tight whatever the fraction says.
    expect(verdict({ alice: [window(0.5, { quotaStatus: "warning" })], bob: [window(0.9)], dave: [window(0.9)] })).toEqual({ kind: "tight" });
  });

  test("maxed only when exhausted, or full without a verdict; full under a warning is still allowed", () => {
    const full = (quotaStatus: Window["quotaStatus"]) => [window(1, { quotaStatus, resetsAt: now + 3 * HOUR })];
    expect(verdict({ alice: full(null), bob: full(null), dave: full("exhausted") })).toEqual({ kind: "maxed", until: now + 3 * HOUR });
    expect(verdict({ alice: full(null), bob: full(null), dave: full("warning") })).toEqual({ kind: "tight" });
  });

  test("never room over a stale or unknown reading, and a stale one says how old it is", () => {
    const quiet = { alice: [window(0.1)], bob: [window(0.1)], dave: [window(0.1)] };
    expect(pool(quotaPools(catalog, reading(quiet, { current: false })), "openai-codex:codex").verdict).toEqual({ kind: "stale", ageMs: 0 });
    const old = reading(quiet, { observedAt: now - 2 * HOUR });
    expect(pool(quotaPools(catalog, old), "openai-codex:codex").verdict).toEqual({ kind: "stale", ageMs: 2 * HOUR });
    expect(verdict({ alice: [window(null)], bob: [window(null)], dave: [window(null)] })).toEqual({ kind: "unknown" });
    expect(pool(quotaPools(catalog, { view: null, current: true, nowMs: now }), "anthropic:claude").verdict).toEqual({ kind: "unknown" });
    // Exhaustion read two hours ago is history: the role still leads, rather than being told it has no route.
    const exhausted = [window(1, { quotaStatus: "exhausted" })];
    const result = outcomes(selection(), reading({ alice: exhausted, bob: exhausted, dave: exhausted }, { observedAt: now - 2 * HOUR }));
    expect(result.get("default")).toMatchObject({ kind: "leads", pool: { verdict: { kind: "stale", ageMs: 2 * HOUR } } });
  });

  test("each account is judged on its own reading: a stale one counts neither as room nor against it, and its age is said once", () => {
    // Old code counted every included account in the denominator: one fresh room beside two stale readings read as thin.
    const twoOld = reading({ alice: [window(0.1)], bob: [window(0.1)], dave: [window(0.1)] }, { readAt: { bob: now - 2 * HOUR, dave: now - 3 * HOUR } });
    const codex = pool(quotaPools(catalog, twoOld), "openai-codex:codex");
    expect(codex).toMatchObject({ verdict: { kind: "room" }, accounts: 3, room: 1, judged: 1, staleAgeMs: 3 * HOUR });
    expect(codex.standings.map(account => account.standing)).toEqual(["room", "stale", "stale"]);
    expect(codex.windows.map(entry => entry.status)).toEqual(["fresh", "stale", "stale"]);
    // A stale account at 10% never makes a tight pool look roomy; "N of M" counts only what was read fresh.
    const tightBesideOld = pool(quotaPools(catalog, reading({ alice: [window(0.9)], bob: [window(0.1)], dave: [window(0.95)] },
      { readAt: { bob: now - 2 * HOUR } })), "openai-codex:codex");
    expect(tightBesideOld).toMatchObject({ verdict: { kind: "tight" }, room: 0, judged: 2, staleAgeMs: 2 * HOUR });
    expect(pool(quotaPools(catalog, reading({ alice: [window(0.9)], bob: [window(0.1)], dave: [window(0.1)] },
      { readAt: { bob: now - 2 * HOUR, dave: now - 2 * HOUR } })), "openai-codex:codex")).toMatchObject({ verdict: { kind: "tight" }, room: 0, judged: 1 });
    // A whole reading that is not current judges nobody.
    const history = pool(quotaPools(catalog, reading({}, { current: false })), "openai-codex:codex");
    expect(history).toMatchObject({ room: 0, judged: 0, staleAgeMs: 0 });
    expect(history.standings.every(account => account.standing === "stale")).toBe(true);
  });
});

describe("pace forecasts", () => {
  const view = (used: number, changes: Partial<Window> = {}, current = true) => {
    const value = reading({ alice: [window(used, changes)] }, { excluded: ["bob", "dave"], current });
    return pool(quotaPools(catalog, value), "openai-codex:codex").windows[0]!.forecast;
  };

  test("a linear forecast only once a quarter of the window has run, at the boundary exactly", () => {
    // 3h into a 5h window at 90%: the last 10% goes in 20 minutes at this pace.
    expect(view(0.9, { resetsAt: now + 2 * HOUR })).toEqual({ kind: "full", at: now + 20 * MINUTE });
    // At this pace 30% after 3h does not fill before the reset.
    expect(view(0.3, { resetsAt: now + 2 * HOUR })).toEqual({ kind: "lasts" });
    expect(view(0.5, { resetsAt: now + 3.75 * HOUR })).toEqual({ kind: "full", at: now + 1.25 * HOUR });
    expect(view(0.5, { resetsAt: now + 3.75 * HOUR + MINUTE })).toBeNull();
  });

  test("no forecast from a reading that is not current, a window without a span, or one already out", () => {
    expect(view(0.9, { resetsAt: now + 2 * HOUR }, false)).toBeNull();
    expect(view(0.9, { resetsAt: now + 2 * HOUR, durationMs: null })).toBeNull();
    expect(view(1, { resetsAt: now + 2 * HOUR })).toBeNull();
    const value = reading({ alice: [window(0.9, { resetsAt: now + 2 * HOUR })] }, { excluded: ["bob", "dave"], blocks: { alice: [{ scope: "chat", until: now + HOUR }] } });
    const blockedWindow = pool(quotaPools(catalog, value), "openai-codex:codex").windows[0]!;
    expect(blockedWindow.state.word).toBe("blocked");
    expect(blockedWindow.forecast).toBeNull();
  });

  test("the forecast is measured from the time of the reading, not the time it is shown", () => {
    const value = reading({ alice: [window(0.9, { resetsAt: now + 2 * HOUR })] }, { excluded: ["bob", "dave"] });
    const entry = value.view!.providers.find(provider => provider.provider === "openai-codex")!.accounts[0]!;
    const shownLater = paceForecast(entry.windows[0]!, windowState(entry, entry.windows[0]!, "openai-codex"), true, now + 4 * MINUTE);
    expect(shownLater).toEqual({ kind: "full", at: now + 20 * MINUTE });
  });
});
