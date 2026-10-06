import { describe, expect, test } from "bun:test";
import type { AccountsObservation, PermittedUsageSnapshot } from "@atyrode/manifold-omp";
import { initialAccountChoices, reduceAccountChoices, servedProviders } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import type { CatalogModel, Selection } from "../domain/contracts.ts";
import { quotaPools, roleOutcomes, type QuotaReading } from "../domain/quota.ts";
import { reviewCatalog, type Review } from "../domain/routing.ts";
import { projectUsage } from "../domain/usage.ts";
import { displayAliases } from "../code/generator/aliases.ts";
import { modelListFailure } from "../code/generator/board-model.ts";
import { strandsNote } from "../code/generator/earlier-model.ts";
import { profileGroups, routeLedger } from "../code/generator/routing-model.ts";

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

const vocab = { family: (family: string) => ({ openai: "GPT", anthropic: "Claude" })[family] ?? family, time: (at: number) => `+${(at - now) / HOUR}h` };
const aliases = displayAliases(catalog);
const ledger = (team: Review, options: Options = {}) => routeLedger(catalog, team, aliases, quotaPools(catalog, reading(options)), vocab);

describe("the routing", () => {
  test("every role on one line as its lead's alias and thinking, and the advisor's line held after sonic while it is off", () => {
    const off = ledger(review());
    const at = off.findIndex(row => row.role === "advisor");
    expect(off[at - 1]?.role).toBe("sonic");
    expect(off[at]).toMatchObject({ off: true, lead: null });
    // Turning the advisor on fills its line in place rather than adding one.
    const on = ledger(review({ advisor: "glance" }));
    expect(on.map(row => row.role)).toEqual(off.map(row => row.role));
    expect(on[at]).toMatchObject({ off: false, lead: { alias: expect.any(String) } });
    expect(off.find(row => row.role === "default")?.lead).toMatchObject({ alias: "o2", thinking: "medium", family: "openai", id: "openai-codex/native-o2" });
  });

  test("a lead whose pool is out is struck with that pool's reopening and what the role does meanwhile; the rest stand", () => {
    const claudeOut = { blocks: { carol: [{ scope: "", until: now + 5 * HOUR }] } };
    const led = ledger(review({ lane: gptLed }), claudeOut);
    const reviewer = led.find(row => row.role === "reviewer")!;
    expect(reviewer.lead?.family).toBe("anthropic");
    expect(reviewer.down).toMatch(/^Claude blocked until \+5h · falls back to o3:/);
    expect(led.filter(row => row.lead?.family === "openai").every(row => row.down === null)).toBe(true);
    // Without fallbacks the role has no route, and says so.
    expect(ledger(review({ lane: gptLed, fallback: false }), claudeOut).find(row => row.role === "reviewer")?.down).toBe("Claude blocked until +5h · no route");
    // No included account is the same strike, for its own reason.
    expect(ledger(review({ lane: claudeOnly }), { excluded: ["carol"] }).find(row => row.role === "default")?.down).toBe("No Claude account included");
  });

  test("the narrow profile groups the team by what it runs, in the order each group first appears, and leaves an off advisor out", () => {
    const rows = ledger(review());
    const groups = profileGroups(rows);
    expect(groups.flatMap(group => group.roles.map(role => role.role)).sort()).toEqual(rows.filter(row => !row.off).map(row => row.role).sort());
    expect(groups[0]?.roles[0]?.role).toBe(rows[0]?.role);
    expect(new Set(groups.map(group => group.key)).size).toBe(groups.length);
    expect(groups.every(group => group.roles.every(role => rows.find(row => row.role === role.role)?.lead?.key === group.lead.key))).toBe(true);
  });
});

describe("what a team would strand, as a recent row says it", () => {
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

  test("a lead no included account serves is said in the family word of the status lines; a team with a route for every role strands nothing", () => {
    const unserved = reading({ excluded: ["alice", "bob", "dave"] });
    const team = review();
    expect(strandsNote(catalog, team.routes, quotaPools(catalog, unserved), vocab)).toBe(`${team.routes.length} no GPT account`);
    expect(strandsNote(catalog, review().routes, quotaPools(catalog, reading()), vocab)).toBeNull();
  });
});

describe("the model list failing once a profile is shown", () => {
  test("a profile the model holds keeps its routes, with the failure said beside them", () => {
    // A frozen bundled starter, a local draft or a staged catalog: the list failing later takes none of it away.
    expect(modelListFailure(true, false, true)).toBe("beside");
  });

  test("only with no profile does the failure take its place, and a stored catalog never needs the list", () => {
    expect(modelListFailure(true, false, false)).toBe("instead");
    expect(modelListFailure(true, true, true)).toBe("none");
    expect(modelListFailure(true, true, false)).toBe("none");
    expect(modelListFailure(false, false, true)).toBe("none");
  });
});
