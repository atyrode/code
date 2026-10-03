import { describe, expect, test } from "bun:test";
import type { AccountsObservation, PermittedUsageSnapshot } from "@atyrode/manifold-omp";
import { initialAccountChoices, reduceAccountChoices, servedProviders } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import type { CatalogModel, Selection } from "../domain/contracts.ts";
import { quotaPools, roleOutcomes, type QuotaReading } from "../domain/quota.ts";
import { reviewCatalog, type Review } from "../domain/routing.ts";
import { projectUsage } from "../domain/usage.ts";
import { accountRows, boardView, modelListFailure, poolHead, when, type BoardColumn, type BoardSeat, type BoardView, type PoolForecast } from "../code/generator/board-model.ts";
import { strandsNote } from "../code/generator/earlier-model.ts";

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

function review(changes: Partial<Selection> = {}): Review {
  return reviewCatalog(catalog, {
    lane: { kind: "provider", family: "openai", blend: "only" }, capability: 2, thinking: "medium", advisor: "off", spark: false,
    priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any", ...changes,
  }, now);
}
const gptLed: Selection["lane"] = { kind: "provider", family: "openai", blend: "led" };
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

function window(usedFraction: number | null, changes: Partial<Window> = {}): Window {
  return { windowId: "5h", tier: null, usedFraction, quotaStatus: null, resetsAt: now + HOUR, durationMs: 5 * HOUR,
    observedAt: usedFraction === null ? null : now, ...changes };
}

type Options = {
  windows?: Partial<Record<Person, Window[]>>;
  blocks?: Partial<Record<Person, { scope: string; until: number }[]>>;
  excluded?: Person[];
  absent?: Person[];
  current?: boolean;
  /** When one account's own report was read; older than five minutes is history. */
  readAt?: Partial<Record<Person, number>>;
};

/** A real projection of these accounts; a Codex or Claude account not given windows reports a quiet 5h one. */
function reading(options: Options = {}): QuotaReading & { served: ReadonlySet<string> | null } {
  const names = (Object.keys(people) as Person[]).filter(name => !options.absent?.includes(name));
  const accounts: AccountsObservation = { scope, observedAt: now, status: "fresh", accounts: names.map(name => {
    const { provider, credentialId, identityKey } = people[name];
    const blocks = options.blocks?.[name] ?? [];
    return identityKey === null
      ? { reference: { kind: "credential", scope, provider, credentialId }, credentialId, identityKey: null, type: "api_key", email: null, disabled: false, blocks }
      : { reference: { kind: "identity", scope, provider, identityKey }, credentialId, identityKey, type: "oauth", email: identityKey, disabled: false, blocks };
  }) };
  let choices = initialAccountChoices();
  for (const name of options.excluded ?? []) {
    choices = reduceAccountChoices(choices, { kind: "set-account", reference: accounts.accounts.find(account => account.credentialId === people[name].credentialId)!.reference, enabled: false });
  }
  const reports = names.map(name => {
    const readAt = options.readAt?.[name] ?? now;
    return {
      provider: people[name].provider, credentialId: people[name].credentialId, identityKey: people[name].identityKey, observedAt: readAt,
      status: name === "erin" ? "no_usage" as const : "reported" as const,
      windows: name === "erin" ? [] : (options.windows?.[name] ?? [window(0.1)]).map(entry => entry.observedAt === null ? entry : { ...entry, observedAt: readAt }),
    };
  });
  const view = projectUsage({ scope, observedAt: now, accounts: reports }, accounts, choices, now, { maxAgeMs: 5 * MINUTE, refreshStatus: "succeeded" });
  return { view, current: options.current ?? true, nowMs: now, served: servedProviders(accounts, choices) };
}

function board(team: Review, options: Options = {}, preview: Review | null = null): BoardView {
  const value = reading(options);
  const pools = quotaPools(catalog, value);
  return boardView({ catalog, review: team, preview, pools, outcomes: roleOutcomes(catalog, team.routes, pools), served: value.served, reading: value });
}
function column(view: BoardView, family: string): BoardColumn {
  return view.columns.find(candidate => candidate.family === family)!;
}
function seat(view: BoardView, key: string): BoardSeat {
  return view.columns.flatMap(candidate => candidate.cells).find(cell => cell?.key === key)!;
}

describe("pool heads judge each account on its own reading", () => {
  test("an old reading is left out of the verdict and the level, and its age is said once for the pool", () => {
    const value = reading({ windows: { alice: [window(0.1)], bob: [window(0.97)], dave: [window(0.3)] }, readAt: { bob: now - 2 * HOUR } });
    const head = poolHead("openai", quotaPools(catalog, value), value);
    expect(head.verdict).toEqual({ kind: "room", room: 2, judged: 2 });
    expect(head.stale).toEqual({ count: 1, ageMs: 2 * HOUR });
    const [track] = head.tracks;
    expect(track?.level).toBeCloseTo(20);
    // Present readings first, least used first; history after them.
    expect(track?.segments.map(segment => [segment.credentialId, segment.fresh])).toEqual([[1, true], [4, true], [2, false]]);
  });

  test("the level is the pool's, never its fullest account's: the mean of the present readings beside a verdict that has room", () => {
    const value = reading({ windows: { alice: [window(0.96)], bob: [window(0.1)], dave: [window(0.2)] } });
    const head = poolHead("openai", quotaPools(catalog, value), value);
    expect(head.verdict).toEqual({ kind: "room", room: 2, judged: 3 });
    expect(head.tracks[0]?.level).toBeCloseTo(42);
    expect(head.tracks[0]?.segments.map(segment => segment.who)).toEqual(["bob@example.test", "dave@example.test", "alice@example.test"]);
  });

  test("a reading that is not current judges nothing: the verdict carries its age, with no level, forecast or second age", () => {
    const value = reading({ windows: { alice: [window(0.9)] }, current: false });
    const head = poolHead("openai", quotaPools(catalog, value), value);
    expect(head.verdict).toEqual({ kind: "stale", ageMs: 0 });
    expect(head.stale).toBeNull();
    expect(head.tracks[0]?.level).toBeNull();
    expect(head.forecast).toBeNull();
    expect(head.reset).toBeNull();
  });

  test("a pool nobody serves says whether accounts are signed in but excluded, or absent", () => {
    const excluded = reading({ excluded: ["carol"] });
    expect(poolHead("anthropic", quotaPools(catalog, excluded), excluded).verdict).toEqual({ kind: "none", signedIn: 1 });
    const absent = reading({ absent: ["carol"] });
    expect(poolHead("anthropic", quotaPools(catalog, absent), absent).verdict).toEqual({ kind: "none", signedIn: 0 });
  });

  test("every window lists every included account in one order, an account without that window held by an empty cell", () => {
    const week = 7 * 24 * HOUR;
    const view = board(review(), { windows: { alice: [window(0.2, { windowId: "weekly", durationMs: week, resetsAt: now + week / 2 }), window(0.1)] } });
    const tracks = column(view, "openai").head.tracks;
    expect(tracks.map(track => track.label)).toEqual(["5h", "7d"]);
    expect(tracks[0]?.segments.find(segment => segment.credentialId === 1)?.elapsed).toBeCloseTo(0.8);
    expect(tracks.map(track => track.segments.map(segment => segment.credentialId))).toEqual([[2, 4, 1], [2, 4, 1]]);
    expect(tracks[1]?.segments.map(segment => [segment.absent, segment.elapsed])).toEqual([[true, null], [true, null], [false, 0.5]]);
    expect(tracks[1]?.level).toBeCloseTo(20);
    expect(column(view, "anthropic").head.tracks).toHaveLength(1);
    // Claude and DeepSeek seat nobody on GPT only, so their idle seats take the note row.
    expect(view.headRows).toEqual({ tracks: 2, note: true });
  });

  test("an unmetered pool without a balance says none is reported, but never over a reading the broker could not give", () => {
    expect(column(board(review()), "deepseek").head).toMatchObject({ verdict: { kind: "unmetered" }, balances: [], unreported: true });
    const value = reading();
    const unavailable = { ...value, view: { ...value.view!, accountsStatus: "unavailable" as const, providers: [] } };
    const pools = quotaPools(catalog, unavailable);
    const view = boardView({ catalog, review: review(), preview: null, pools, outcomes: roleOutcomes(catalog, review().routes, pools), served: null, reading: unavailable });
    expect(view.reading).toBe("unavailable");
    expect(column(view, "deepseek").head).toMatchObject({ verdict: { kind: "unknown" }, unreported: false });
    expect(view.headRows.tracks).toBe(0);
  });

  test("the reset is said only for a present window near its limit", () => {
    const late = reading({ windows: { alice: [window(0.9)] } });
    expect(poolHead("openai", quotaPools(catalog, late), late).reset).toEqual({ label: "5h", at: now + HOUR });
    const quiet = reading();
    expect(poolHead("openai", quotaPools(catalog, quiet), quiet).reset).toBeNull();
  });
});

describe("a pool is forecast full only when its last account with room would fill", () => {
  // Three hours into a five-hour window that resets in two: 90% fills in 20 minutes, 80% in 45, 75% in an hour.
  const pace = (used: number, changes: Partial<Window> = {}) => window(used, { resetsAt: now + 2 * HOUR, ...changes });
  const forecast = (options: Options) => {
    const value = reading(options);
    return poolHead("openai", quotaPools(catalog, value), value).forecast;
  };
  const inAnHour = (full: PoolForecast | null) => {
    expect(full?.label).toBe("5h");
    expect(full!.at).toBeCloseTo(now + HOUR, -3);
  };

  test("one account on pace to fill says nothing while the others have room", () => {
    expect(forecast({ windows: { alice: [window(0.9)], bob: [window(0.1)], dave: [window(0.1)] } })).toBeNull();
  });

  test("when every account is on pace to fill, the forecast is the last of them, in its window", () => {
    inAnHour(forecast({ windows: { alice: [pace(0.9)], bob: [pace(0.8)], dave: [pace(0.75)] } }));
  });

  test("an account that resets before the last one fills keeps the pool open: no forecast", () => {
    // Alice fills about 14 minutes from now and resets at 40; by the time Dave fills, she has room again.
    const alice = window(0.95, { resetsAt: now + 40 * MINUTE });
    expect(forecast({ windows: { alice: [alice], bob: [pace(0.8)], dave: [pace(0.75)] } })).toBeNull();
  });

  test("an account already out counts as full only until it reopens", () => {
    const others = { bob: [pace(0.8)], dave: [pace(0.75)] };
    inAnHour(forecast({ windows: others, blocks: { alice: [{ scope: "", until: now + 3 * HOUR }] } }));
    expect(forecast({ windows: others, blocks: { alice: [{ scope: "", until: now + 50 * MINUTE }] } })).toBeNull();
  });

  test("an account read long ago may have room, so nothing is forecast", () => {
    expect(forecast({ windows: { alice: [pace(0.9)], bob: [pace(0.8)], dave: [pace(0.75)] }, readAt: { bob: now - 2 * HOUR } })).toBeNull();
  });

  test("a weekly forecast names its window and, beyond today, its weekday", () => {
    const week = 7 * 24 * HOUR;
    const weekly = window(0.6, { windowId: "weekly", durationMs: week, resetsAt: now + week / 2 });
    const full = forecast({ windows: { alice: [weekly] }, excluded: ["bob", "dave"] });
    expect(full?.label).toBe("7d");
    expect(full!.at).toBeCloseTo(now + 0.4 * (week / 2) / 0.6, -3);
    expect(when(full!.at, now)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/);
    // Past midnight is another day even within hours: it carries its weekday too.
    const tonight = new Date(now).setHours(23, 0, 0, 0), early = new Date(now).setHours(26, 0, 0, 0);
    expect(when(early, tonight)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) 02:00$/);
  });
});

describe("seats", () => {
  test("roles that think and fall back alike share a line, the most thinking first", () => {
    expect(seat(board(review()), "o2").lines.map(line => [line.thinking, line.roles.map(entry => entry.role), line.chain.map(choice => choice.key)])).toEqual([
      ["medium", ["default", "task", "scout", "sonic"], ["o1"]],
      ["low", ["vision"], ["o1"]],
      ["low", ["smol"], []],
    ]);
  });

  test("a blocked lead pool: the first fallback with room takes over until it reopens, or the role has no route", () => {
    const blocked = { blocks: { carol: [{ scope: "", until: now + 5 * HOUR }] } };
    const rescued = seat(board(review({ lane: { kind: "mixed" } }), blocked), "a3");
    expect(rescued.stranded).toBe(false);
    expect(rescued.lines).toEqual([{ thinking: "high", roles: ["plan", "slow", "reviewer", "security-reviewer"].map(role => ({ role, change: null })),
      fate: { kind: "falls-back", model: { key: "o3", thinking: "high" }, until: now + 5 * HOUR }, chain: [], pruned: [] }]);
    const stopped = seat(board(review({ lane: { kind: "mixed" }, fallback: false }), blocked), "a3");
    expect(stopped.stranded).toBe(true);
    expect(stopped.lines[0]?.fate).toEqual({ kind: "no-route", until: now + 5 * HOUR });
  });

  test("fallbacks the session drops for want of an account are named apart from the chain it keeps", () => {
    const view = board(review({ lane: gptLed }), { excluded: ["carol"] });
    const line = seat(view, "o2").lines.find(entry => entry.roles.some(({ role }) => role === "default"))!;
    expect(line.chain.map(choice => choice.key)).toEqual(["o1"]);
    expect(line.pruned).toEqual(["anthropic"]);
    // The reviews still lead on Claude, which nobody serves: the door refuses them, said on their seat.
    expect(seat(view, "a3").stranded).toBe(true);
    expect(seat(view, "a3").lines[0]?.fate).toEqual({ kind: "no-account", provider: "anthropic" });
  });

  test("a provider no role sits with collapses to its head and one idle line, strongest first and Spark after fast", () => {
    const view = board(review({ lane: claudeOnly }));
    expect(view.columns.map(entry => [entry.family, entry.collapsed, entry.idle])).toEqual([["openai", true, true], ["anthropic", false, false], ["deepseek", true, true]]);
    expect(column(view, "openai").bench.map(entry => entry.key)).toEqual(["o3", "o2", "o1", "spark"]);
    expect(column(view, "anthropic").seated.map(entry => entry.key)).toEqual(["a3", "a2", "a1"]);
    expect(view.tiers).toEqual([3, 2, 1, 0]);
    expect(view.rungs).toEqual(["smart", "normal", "fast", "spark"]);
  });

  test("Spark's seat carries its own pool; seats on the head's pool carry none", () => {
    const view = board(review({ spark: true }));
    expect(seat(view, "spark").own?.id).toBe("openai-codex:codex-spark");
    expect(seat(view, "o2").own).toBeNull();
    expect(column(view, "openai").head.pool?.id).toBe("openai-codex:codex");
  });
});

describe("a pointed team", () => {
  test("roles that would move leave their seat and arrive at the new one, said once as a move", () => {
    const view = board(review(), {}, review({ lane: gptLed }));
    expect(view.moves).toEqual([{ kind: "move", roles: ["reviewer", "security-reviewer"], from: "o3", to: "a3" }]);
    expect(seat(view, "o3").lines[0]?.roles).toEqual([
      { role: "plan", change: null }, { role: "slow", change: null }, { role: "reviewer", change: "moves" }, { role: "security-reviewer", change: "moves" },
    ]);
    expect(seat(view, "a3").arriving).toEqual(["reviewer", "security-reviewer"]);
    expect(seat(view, "a3").arrivingStranded).toBe(false);
    // The shown team still decides what collapses: Claude has no role until the pointed team is chosen,
    // but its head is no longer idle while the pointed team would seat roles there.
    expect(column(view, "anthropic")).toMatchObject({ collapsed: true, idle: false });
    expect(column(view, "deepseek")).toMatchObject({ collapsed: true, idle: true });
  });

  test("more thinking marks the roles in place; an added or dropped role is its own move", () => {
    expect(board(review(), {}, review({ thinking: "high" })).moves).toEqual([
      { kind: "effort", roles: ["default", "task"], key: "o2", from: "medium", to: "high" },
      { kind: "effort", roles: ["plan", "slow", "reviewer", "security-reviewer"], key: "o3", from: "high", to: "xhigh" },
      { kind: "effort", roles: ["smol"], key: "o2", from: "low", to: "medium" },
    ]);
    const added = board(review(), {}, review({ advisor: "glance" }));
    expect(added.moves).toEqual([{ kind: "add", roles: ["advisor"], to: "o1" }]);
    expect(seat(added, "o1").arriving).toEqual(["advisor"]);
    const dropped = board(review({ advisor: "glance" }), {}, review());
    expect(dropped.moves).toEqual([{ kind: "remove", roles: ["advisor"], from: "o1" }]);
    expect(seat(dropped, "o1").lines.flatMap(line => line.roles).find(entry => entry.role === "advisor")?.change).toBe("removed");
  });

  test("a seat a pointed team would strand a role on is marked as such", () => {
    const view = board(review({ fallback: false }), { blocks: { carol: [{ scope: "", until: now + 5 * HOUR }] } }, review({ lane: gptLed, fallback: false }));
    expect(seat(view, "a3").arrivingStranded).toBe(true);
    expect(seat(view, "o3").stranded).toBe(false);
  });
});

describe("what a team would strand, as a recent row says it", () => {
  const vocab = { family: (family: string) => family, account: (family: string) => family, time: (at: number) => `+${(at - now) / HOUR}h` };

  test("roles with no route are grouped by when their own routes return, each group with its own time, soonest first", () => {
    const codexOut = [{ scope: "", until: now + HOUR }];
    const value = reading({ blocks: { carol: [{ scope: "", until: now + 5 * HOUR }], alice: codexOut, bob: codexOut, dave: codexOut } });
    const pools = quotaPools(catalog, value);
    const team = review({ lane: { kind: "mixed" }, fallback: false });
    const waiting = (until: number) => roleOutcomes(catalog, team.routes, pools).filter(outcome => outcome.kind === "no-route" && outcome.until === until).length;
    const soon = waiting(now + HOUR), late = waiting(now + 5 * HOUR);
    expect(soon * late).toBeGreaterThan(0);
    expect(strandsNote(catalog, team.routes, pools, vocab)).toBe(`${soon} no route until +1h · ${late} until +5h`);
  });

  test("a lead no included account serves is said as such; a team with a route for every role strands nothing", () => {
    const unserved = reading({ excluded: ["carol"] });
    const team = review({ lane: claudeOnly });
    expect(strandsNote(catalog, team.routes, quotaPools(catalog, unserved), vocab)).toBe(`${team.routes.length} no anthropic account`);
    expect(strandsNote(catalog, review().routes, quotaPools(catalog, reading()), vocab)).toBeNull();
  });
});

describe("accounts under a head", () => {
  test("every signed-in account, included or not, with what stops it and how old a reading that is history is", () => {
    const value = reading({
      windows: { alice: [window(1, { quotaStatus: "exhausted" })], dave: [window(0.85)] }, excluded: ["bob"],
      blocks: { dave: [{ scope: "", until: now + 2 * HOUR }] }, readAt: { alice: now - 3 * HOUR },
    });
    const rows = accountRows("openai", value);
    expect(rows.map(row => [row.who, row.included])).toEqual([["alice@example.test", true], ["bob@example.test", false], ["dave@example.test", true]]);
    // Alice's exhaustion is history, so it stops nothing now; her reading's age says why.
    expect(rows[0]).toMatchObject({ stop: null, tight: false, ageMs: 3 * HOUR });
    expect(rows[2]).toMatchObject({ stop: { word: "blocked", until: now + 2 * HOUR }, ageMs: null, windows: [{ label: "5h", percent: 85 }] });
    expect(accountRows("deepseek", value)).toMatchObject([{ who: "API key 5", included: true, windows: [] }]);
  });
});

describe("the model list failing once a team is on the line", () => {
  test("a team the model holds keeps its seats, with the failure said beside the board", () => {
    // A frozen bundled starter, a local draft or a staged catalog: the list failing later takes none of it away.
    expect(modelListFailure(true, false, true)).toBe("beside");
  });

  test("only with no team to seat does the failure replace the board, and a stored catalog never needs the list", () => {
    expect(modelListFailure(true, false, false)).toBe("instead");
    expect(modelListFailure(true, true, true)).toBe("none");
    expect(modelListFailure(true, true, false)).toBe("none");
    expect(modelListFailure(false, false, true)).toBe("none");
  });
});
