import { describe, expect, test } from "bun:test";
import type { AccountsObservation, PermittedUsageSnapshot } from "@atyrode/manifold-omp";
import { initialAccountChoices, reduceAccountChoices } from "../domain/accounts.ts";
import type { AccountChoices } from "../domain/contracts.ts";
import type { QuotaReading } from "../domain/quota.ts";
import { projectUsage } from "../domain/usage.ts";
import { usageState, type UsageGroup, type UsageState } from "../code/generator/usage-model.ts";

const scope = "machine/broker-scope";
const now = Date.UTC(2026, 9, 3, 12);
const MINUTE = 60_000, HOUR = 3_600_000;

type Report = PermittedUsageSnapshot["accounts"][number];
type Window = Report["windows"][number];
type Person = { provider: string; credentialId: number; identityKey: string | null };
const alice: Person = { provider: "openai-codex", credentialId: 1, identityKey: "alice@example.test" };
const bob: Person = { provider: "openai-codex", credentialId: 2, identityKey: "bob@example.test" };
const carol: Person = { provider: "anthropic", credentialId: 3, identityKey: "carol@example.test" };
const erin: Person = { provider: "deepseek", credentialId: 5, identityKey: null };
const frank: Person = { provider: "openrouter", credentialId: 6, identityKey: null };
const grace: Person = { provider: "openai", credentialId: 7, identityKey: null };

function window(usedFraction: number | null, changes: Partial<Window> = {}): Window {
  return { windowId: "5h", tier: null, usedFraction, quotaStatus: null, resetsAt: now + HOUR, durationMs: 5 * HOUR,
    observedAt: usedFraction === null ? null : now, ...changes };
}
function observation(people: readonly Person[], blocks: ReadonlyMap<Person, { scope: string; until: number }[]> = new Map()): AccountsObservation {
  return { scope, observedAt: now, status: "fresh", accounts: people.map(person => {
    const { provider, credentialId, identityKey } = person;
    const shared = { credentialId, disabled: false, blocks: blocks.get(person) ?? [] };
    return identityKey === null
      ? { ...shared, reference: { kind: "credential", scope, provider, credentialId }, identityKey: null, type: "api_key", email: null }
      : { ...shared, reference: { kind: "identity", scope, provider, identityKey }, identityKey, type: "oauth", email: identityKey };
  }) };
}
function report(person: Person, windows: Window[], changes: Partial<Report> = {}): Report {
  return { provider: person.provider, credentialId: person.credentialId, identityKey: person.identityKey, observedAt: now, status: "reported", windows, ...changes };
}
/** A real projection of these reports over the observation, judged current unless said otherwise. */
function reading(accounts: AccountsObservation, reports: Report[], choices: AccountChoices = initialAccountChoices(), current = true): QuotaReading {
  return { view: projectUsage({ scope, observedAt: now, accounts: reports }, accounts, choices, now, { maxAgeMs: 5 * MINUTE, refreshStatus: "succeeded" }), current, nowMs: now };
}
function groups(state: UsageState): readonly UsageGroup[] {
  if (state.kind !== "groups") throw new Error(`expected groups, got ${state.kind}`);
  return state.groups;
}

describe("the usage pane and the accounts view read the projection as it stands", () => {
  test("a switch shows the saved choice while the reading still holds the pool it was made under", () => {
    const accounts = observation([alice, bob]);
    const before = reading(accounts, [report(alice, [window(0.2)]), report(bob, [window(0.4)])]);
    // The saved edit landed; the model has not read usage under it yet, so the pane still draws the earlier reading.
    const saved = reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference: accounts.accounts[0]!.reference, enabled: false });
    const [codex] = groups(usageState(before, saved));
    expect(codex!.accounts.map(row => [row.who, row.included])).toEqual([["alice@example.test", false], ["bob@example.test", true]]);
  });

  test("a window metering a quota of its own is no row of the account's usage; a provider Code does not meter keeps its windows", () => {
    const accounts = observation([alice, erin]);
    const value = reading(accounts, [report(alice, [window(0.4), window(1, { tier: "codex-spark" })]), report(erin, [window(0.3)])]);
    const [codex, deepseek] = groups(usageState(value, initialAccountChoices()));
    expect(codex!.accounts[0]!.windows.map(row => [row.label, row.percent, row.level])).toEqual([["5h", 40, "ok"]]);
    expect(deepseek!.accounts[0]!.windows.map(row => row.percent)).toEqual([30]);
  });

  test("providers come in the panel's family order, a family's own provider first, whatever order the reading lists them", () => {
    const accounts = observation([frank, erin, carol, grace, alice]);
    const value = reading(accounts, [report(alice, [window(0.1)]), report(carol, [window(0.1)])]);
    expect(groups(usageState(value, initialAccountChoices())).map(group => group.provider)).toEqual(["openai-codex", "openai", "anthropic", "deepseek", "openrouter"]);
  });

  test("an account read before the freshness window says its age beside present ones; a provider all in history says one age", () => {
    const accounts = observation([alice, bob]);
    const mixed = reading(accounts, [report(alice, [window(0.2)]), report(bob, [window(0.97, { observedAt: now - 2 * HOUR })], { observedAt: now - 2 * HOUR })]);
    const [codex] = groups(usageState(mixed, initialAccountChoices()));
    expect(codex!.history).toBeNull();
    expect(codex!.accounts.map(row => row.ageMs)).toEqual([null, 2 * HOUR]);
    const old = reading(accounts, [report(alice, [window(0.2, { observedAt: now - 3 * HOUR })], { observedAt: now - 3 * HOUR }), report(bob, [window(0.4)])], initialAccountChoices(), false);
    const [cached] = groups(usageState(old, initialAccountChoices()));
    expect(cached!.history).toEqual({ ageMs: 3 * HOUR });
    expect(cached!.accounts.map(row => row.ageMs)).toEqual([null, null]);
  });

  test("a prepaid balance with only unknown windows says just its balance, and an account reporting nothing says so", () => {
    const accounts = observation([erin, frank]);
    const value = reading(accounts, [report(erin, [window(null)], { balance: { currency: "USD", total: "18.40", observedAt: now } })]);
    const [deepseek, openrouter] = groups(usageState(value, initialAccountChoices()));
    expect(deepseek!.accounts[0]).toMatchObject({ who: "API key 5", windows: [], unreported: false, balance: { total: "18.40", currency: "USD" } });
    expect(openrouter!.accounts[0]).toMatchObject({ who: "API key 6", windows: [], unreported: true, balance: null });
  });

  test("a block over a window blocks it until it lifts; a block on a scope no window meters is said on its own", () => {
    const blocks = new Map([[carol, [{ scope: "", until: now + 2 * HOUR }]], [alice, [{ scope: "spark", until: now + 3 * HOUR }]]]);
    const accounts = observation([alice, carol], blocks);
    const value = reading(accounts, [report(alice, [window(0.5)]), report(carol, [window(0.3), window(0.6, { windowId: "7d", durationMs: 168 * HOUR })])]);
    const [codex, claude] = groups(usageState(value, initialAccountChoices()));
    expect(claude!.accounts[0]!.windows.map(entry => [entry.label, entry.word, entry.until])).toEqual([["5h", "blocked", now + 2 * HOUR], ["7d", "blocked", now + 2 * HOUR]]);
    expect(claude!.accounts[0]!.blocks).toEqual([]);
    expect(codex!.accounts[0]!.windows.map(entry => entry.word)).toEqual([""]);
    expect(codex!.accounts[0]!.blocks).toEqual([{ scope: "spark", until: now + 3 * HOUR }]);
  });

  test("a reading not made yet is never an empty pool, and no account choices is neither", () => {
    expect(usageState({ view: null, current: false, nowMs: now }, initialAccountChoices())).toEqual({ kind: "unread" });
    expect(usageState({ view: null, current: false, nowMs: now }, null)).toEqual({ kind: "unset" });
    expect(usageState(reading(observation([]), []), initialAccountChoices())).toEqual({ kind: "empty" });
  });
});
