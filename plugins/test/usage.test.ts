import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { PermittedUsageSnapshotSchema, type AccountsObservation } from "@atyrode/manifold-omp";
import { initialAccountChoices, reduceAccountChoices } from "../domain/accounts.ts";
import { projectUsage, UsageViewSchema } from "../domain/usage.ts";
type PermittedUsageSnapshot = z.infer<typeof PermittedUsageSnapshotSchema>;
import { DomainError } from "../domain/contracts.ts";

const scope = "machine/broker-scope";
const now = 1_700_000_000_000;
const freshness = { maxAgeMs: 60_000, refreshStatus: "succeeded" as const };
const accounts: AccountsObservation = { scope, observedAt: now, status: "fresh",
  accounts: ["alice@example.test", "bob@example.test"].map((identityKey, index) => ({
    reference: { kind: "identity", scope, provider: "openai-codex", identityKey }, credentialId: index + 1,
    identityKey, type: "oauth", email: identityKey, disabled: false, blocks: [],
  })) };
const choices = initialAccountChoices();
function report(id: number, windows: PermittedUsageSnapshot["accounts"][number]["windows"]): PermittedUsageSnapshot["accounts"][number] {
  return { provider: "openai-codex", credentialId: id, identityKey: id === 1 ? "alice@example.test" : "bob@example.test",
    observedAt: now, status: "reported", windows };
}
function window(id: string, usedFraction: number | null, resetsAt = now + 60_000, tier: string | null = null) {
  return { windowId: id, tier, usedFraction, quotaStatus: null, resetsAt, durationMs: 3_600_000,
    observedAt: usedFraction === null ? null : now };
}
function view(rows: PermittedUsageSnapshot["accounts"]) {
  return projectUsage({ scope, observedAt: now, accounts: rows }, accounts, choices, now, freshness);
}

describe("sanctioned usage observations", () => {
  test("aggregates exhaustion per account, not per window, and uses earliest fully unblocked account", () => {
    const exhausted = [report(1, [window("5h", 1, now + 100), window("7d", 1, now + 900)]),
      report(2, [window("30d", 1, now + 500)])];
    const bucket = view(exhausted).providers[0]!.buckets[0]!;
    expect(bucket.status).toBe("maxed");
    expect(bucket.resetsAt).toBe(now + 500);
    exhausted[1]!.windows[0]!.usedFraction = 0.2;
    expect(view(exhausted).providers[0]!.buckets[0]!.status).toBe("available");
    exhausted[0]!.windows[1]!.usedFraction = 0;
    exhausted[1]!.windows[0]!.usedFraction = 1.2;
    expect(view(exhausted).providers[0]!.buckets[0]!.status).toBe("maxed");
  });

  test("unknown tiers cannot exhaust a known main bucket and real window IDs survive", () => {
    const result = view([report(1, [window("provider-custom-30d", 0.2), window("future-window", 1, now + 500, "unknown-tier")]),
      report(2, [window("monthly", 0.1)])]);
    const group = result.providers[0]!;
    expect(group.buckets[0]!.status).toBe("available");
    expect(group.accounts[0]!.windows[1]!.bucket).toBeNull();
    expect(group.accounts[0]!.windows[0]!.windowId).toBe("provider-custom-30d");
    expect(group.accounts[0]!.windows[0]!.observedAt).toBe(now);
    expect(UsageViewSchema.parse(result)).toEqual(result);
  });

  test("missing reports and unknown fractions never become zero, no-usage or unauthenticated", () => {
    const result = view([report(1, [window("5h", 1)])]);
    expect(result.providers[0]!.accounts[1]!.status).toBe("unknown");
    expect(result.providers[0]!.buckets[0]!.status).toBe("unknown");
    const unknown = view([report(1, [window("5h", null)]), { ...report(2, []), status: "no_usage" }]);
    expect(unknown.providers[0]!.accounts[0]!.windows[0]!.usedFraction).toBeNull();
    expect(unknown.providers[0]!.accounts[1]!.status).toBe("no_usage");
    expect(projectUsage(null, accounts, choices, now, freshness).status).toBe("unavailable");
  });

  test("checks source times, cache refresh outcome, and elapsed quota resets independently", () => {
    const rows = [report(1, [window("5h", 1)]), report(2, [window("7d", 1)])];
    rows[0]!.windows[0]!.observedAt = now - 60_001;
    const result = view(rows);
    expect(result.providers[0]!.accounts[0]!.windows[0]!.status).toBe("stale");
    expect(result.providers[0]!.accounts[0]!.windows[0]!.observedAt).toBe(now - 60_001);
    expect(result.providers[0]!.buckets[0]!.status).toBe("stale");
    const failed = projectUsage({ scope, observedAt: now, accounts: rows }, accounts, choices, now,
      { ...freshness, refreshStatus: "failed" });
    expect(failed.status).toBe("stale");
    expect(failed.providers[0]!.buckets[0]!.status).toBe("stale");
    rows[0]!.windows[0] = window("5h", 1, now);
    expect(view(rows).providers[0]!.accounts[0]!.windows[0]!.status).toBe("stale");
  });

  test("scoped blocks never take the whole provider out and disabled accounts do not vote", () => {
    const restricted = structuredClone(accounts);
    restricted.accounts[0]!.blocks = [{ scope: "spark", until: now + 1000 }];
    const rows = [report(1, [window("5h", 0.2), window("spark", 0.2, now + 5000, "spark")])];
    const selected = reduceAccountChoices(choices, { kind: "set-account", reference: accounts.accounts[1]!.reference, enabled: false });
    const result = projectUsage({ scope, observedAt: now, accounts: rows }, restricted, selected, now, freshness);
    expect(result.providers[0]!.buckets[0]!.status).toBe("available");
    expect(result.providers[0]!.buckets.find(bucket => bucket.name.endsWith("-spark"))!.status).toBe("blocked");
    expect(result.providers[0]!.accounts[1]!.status).toBe("selection_disabled");
    restricted.accounts[0]!.blocks[0]!.scope = "";
    expect(projectUsage({ scope, observedAt: now, accounts: rows }, restricted, selected, now, freshness)
      .providers[0]!.buckets[0]!.status).toBe("blocked");
  });

  test("reused slots and wrong provider identities do not inherit old usage", () => {
    const rows = [report(1, [window("5h", 1)]), report(2, [window("5h", 1)])];
    rows[0]!.identityKey = "old-login@example.test";
    rows[1]!.provider = "anthropic";
    const result = view(rows);
    expect(result.providers[0]!.accounts.map(account => account.status)).toEqual(["unknown", "unknown"]);
    expect(result.providers[0]!.buckets[0]!.status).toBe("unknown");
    expect(() => projectUsage({ scope: "other", observedAt: now, accounts: rows }, accounts, choices, now, freshness)).toThrow(DomainError);
    expect(() => view([rows[0]!, rows[0]!])).toThrow(DomainError);
  });

  test("projects scoped prepaid balance and reset credits with source freshness, without fetching", () => {
    const prepaid: AccountsObservation = { scope, observedAt: now, status: "fresh", accounts: [7, 8].map(credentialId => ({
      reference: { kind: "credential", scope, provider: "deepseek", credentialId }, credentialId,
      identityKey: null, type: "api_key", email: null, disabled: false, blocks: [],
    })) };
    const result = projectUsage({ scope, observedAt: now, accounts: [{
      provider: "deepseek", credentialId: 7, identityKey: null, observedAt: now, status: "no_usage", windows: [],
      balance: { currency: "USD", total: "12.3400", observedAt: now },
    }] }, prepaid, choices, now, freshness);
    expect(result.providers[0]!.accounts[0]!.balance).toEqual({ currency: "USD", total: "12.3400", observedAt: now, status: "fresh" });
    expect(result.providers[0]!.accounts[1]!.balance).toBeNull();
    const credits = view([{ ...report(1, [window("5h", 0.2)]), resetCredits: { available: 2, expiresAt: [now + 500, now + 100] } }]);
    expect(credits.providers[0]!.accounts[0]!.resetCredits).toEqual({ available: 2, expiresAt: [now + 100, now + 500], observedAt: now, status: "fresh" });
  });
});

describe("Code quota policy over OMP usage facts", () => {
  test("provider verdict distinguishes allowed-at-limit from exhausted for one selected account", () => {
    const selected = reduceAccountChoices(choices, { kind: "set-account", reference: accounts.accounts[1]!.reference, enabled: false });
    const snapshot: PermittedUsageSnapshot = { scope, observedAt: now, accounts: [report(1, [{
      ...window("5h", 1), quotaStatus: "warning",
    }])] };
    const bucket = () => projectUsage(snapshot, accounts, selected, now, freshness).providers[0]!.buckets[0]!;
    expect(bucket().status).toBe("available");
    snapshot.accounts[0]!.windows[0]!.quotaStatus = "exhausted";
    expect(bucket()).toMatchObject({ status: "maxed", resetsAt: now + 60_000 });
    snapshot.accounts[0]!.windows[0]!.usedFraction = 0.99;
    expect(bucket().status).toBe("maxed");
    snapshot.accounts[0]!.windows.push({ ...window("7d", 1, now + 120_000), quotaStatus: "exhausted" });
    snapshot.accounts[0]!.windows[0]!.quotaStatus = "warning";
    expect(bucket()).toMatchObject({ status: "maxed", resetsAt: now + 120_000 });
  });

  test("a provider verdict cannot make stale account, quota, reset or refresh facts authoritative", () => {
    const selected = reduceAccountChoices(choices, { kind: "set-account", reference: accounts.accounts[1]!.reference, enabled: false });
    for (const quotaStatus of ["warning", "exhausted"] as const) {
      const snapshot: PermittedUsageSnapshot = { scope, observedAt: now, accounts: [report(1, [{
        ...window("5h", 1), quotaStatus,
      }])] };
      const bucket = (observed = accounts) => projectUsage(snapshot, observed, selected, now, freshness).providers[0]!.buckets[0]!.status;
      expect(projectUsage(snapshot, accounts, selected, now, { ...freshness, refreshStatus: "failed" })
        .providers[0]!.buckets[0]!.status).toBe("stale");
      expect(bucket({ ...accounts, status: "stale" })).toBe("stale");
      expect(bucket({ ...accounts, observedAt: now - 60_001 })).toBe("stale");
      snapshot.accounts[0]!.windows[0]!.observedAt = now - 60_001;
      expect(bucket()).toBe("stale");
      snapshot.accounts[0]!.windows[0]!.observedAt = now;
      snapshot.accounts[0]!.windows[0]!.resetsAt = now;
      expect(bucket()).toBe("stale");
    }
  });

  test("unknown verdicts never claim availability; absent verdicts use the observed fraction", () => {
    const selected = reduceAccountChoices(choices, { kind: "set-account", reference: accounts.accounts[1]!.reference, enabled: false });
    const bucket = (quotaStatus: PermittedUsageSnapshot["accounts"][number]["windows"][number]["quotaStatus"], usedFraction: number | null = 1) =>
      projectUsage({ scope, observedAt: now, accounts: [report(1, [{ ...window("5h", usedFraction), quotaStatus }])] },
        accounts, selected, now, freshness).providers[0]!.buckets[0]!.status;
    expect(bucket("unknown")).toBe("unknown");
    expect(bucket(null)).toBe("maxed");
    expect(bucket(null, 0.2)).toBe("available");
    expect(bucket("warning", null)).toBe("unknown");
  });

  test("credential-disabled facts apply only to the exact concrete API-key slot", () => {
    const keys: AccountsObservation = { scope, observedAt: now, status: "fresh", accounts: [10, 11].map(credentialId => ({
      reference: { kind: "credential", scope, provider: "openai", credentialId }, credentialId,
      identityKey: null, type: "api_key", email: null, disabled: false, blocks: [],
    })) };
    const snapshot: PermittedUsageSnapshot = { scope, observedAt: now, accounts: [{
      provider: "openai", credentialId: 11, identityKey: null, observedAt: now,
      status: "credential_disabled", disabledAt: now - 100, windows: [],
    }] };
    expect(projectUsage(snapshot, keys, choices, now, freshness).providers[0]!.accounts.map(account => account.status))
      .toEqual(["unknown", "credential_disabled"]);
  });
});
