import { describe, expect, test } from "bun:test";
import { initialAccountChoices, projectAccounts, reduceAccountChoices } from "../domain/accounts.ts";
import { normalizeBrokerUsage, projectUsage, UsageViewSchema, type PermittedUsageSnapshot } from "../domain/usage.ts";
import { DomainError } from "../domain/contracts.ts";

const scope = "machine/broker-scope";
const now = 1_700_000_000_000;
const freshness = { maxAgeMs: 60_000, refreshStatus: "succeeded" as const };
const accounts = projectAccounts({ credentials: [
  { id: 1, provider: "openai-codex", identityKey: "alice@example.test", credential: { type: "oauth", email: "alice@example.test" } },
  { id: 2, provider: "openai-codex", identityKey: "bob@example.test", credential: { type: "oauth", email: "bob@example.test" } },
] }, scope, now, now);
const choices = initialAccountChoices();
function report(id: number, windows: PermittedUsageSnapshot["accounts"][number]["windows"]): PermittedUsageSnapshot["accounts"][number] {
  return { provider: "openai-codex", credentialId: id, identityKey: id === 1 ? "alice@example.test" : "bob@example.test",
    observedAt: now, status: "reported", windows };
}
function window(id: string, usedFraction: number | null, resetsAt = now + 60_000, tier: string | null = null) {
  return { windowId: id, tier, usedFraction, resetsAt, durationMs: 3_600_000, observedAt: usedFraction === null ? null : now };
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
    const prepaid = projectAccounts({ credentials: [
      { id: 7, provider: "deepseek", identityKey: null, credential: { type: "api_key" } },
      { id: 8, provider: "deepseek", identityKey: null, credential: { type: "api_key" } },
    ] }, scope, now, now);
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

const brokerReport = {
  provider: "openai-codex", fetchedAt: now - 10,
  metadata: { email: "ALICE@example.test", accountId: "provider-account-uuid", endpoint: "https://provider.invalid" },
  limits: [{ id: "openai-codex:primary", label: "5 Hour", scope: { provider: "openai-codex", windowId: "5h" },
    window: { id: "5h", label: "5 Hour", resetsAt: now + 60_000, durationMs: 18_000_000 },
    amount: { unit: "percent", usedFraction: 0.7 }, status: "ok" }],
};

describe("actual broker usage adapter", () => {
  test("joins native broker metadata, preserves source times and drops secret/error bodies", () => {
    const raw = { generatedAt: now, reports: [{ ...brokerReport,
      raw: { accessToken: "PRIVATE" }, notes: ["PRIVATE provider error body"],
      metadata: { ...brokerReport.metadata, authorization: "PRIVATE" },
      resetCredits: { availableCount: 1, credits: [{ status: "available", expiresAt: new Date(now + 50_000).toISOString() }] },
    }] };
    const normalized = normalizeBrokerUsage(raw, accounts, now)!;
    expect(normalized.accounts[0]!.credentialId).toBe(1);
    expect(normalized.accounts[0]!.windows[0]!.observedAt).toBe(now - 10);
    expect(normalized.accounts[0]!.resetCredits).toEqual({ available: 1, expiresAt: [now + 50_000] });
    expect(JSON.stringify(projectUsage(normalized, accounts, choices, now, freshness))).not.toContain("PRIVATE");
  });

  test("leaves ambiguous email unknown but accepts explicit same-scope identity and org qualification", () => {
    const shared = projectAccounts({ credentials: [
      { id: 1, provider: "anthropic", identityKey: "email:shared@example.test|org:a", credential: { type: "oauth", email: "shared@example.test" } },
      { id: 2, provider: "anthropic", identityKey: "email:shared@example.test|org:b", credential: { type: "oauth", email: "shared@example.test" } },
    ] }, scope, now, now);
    const report = { provider: "anthropic", fetchedAt: now, limits: [], metadata: { email: "shared@example.test" } };
    expect(normalizeBrokerUsage({ generatedAt: now, reports: [report] }, shared, now)!.accounts).toEqual([]);
    const org = normalizeBrokerUsage({ generatedAt: now, reports: [{ ...report, metadata: { ...report.metadata, orgId: "b" } }] }, shared, now)!;
    expect(org.accounts.map(account => account.credentialId)).toEqual([2]);
    const exact = normalizeBrokerUsage({ generatedAt: now, reports: [{ ...report,
      metadata: { accountId: "email:shared@example.test|org:a" } }] }, shared, now)!;
    expect(exact.accounts.map(account => account.credentialId)).toEqual([1]);
  });

  test("refuses duplicate matched reports, keeps missing identity unknown, and honors amount precedence", () => {
    expect(() => normalizeBrokerUsage({ generatedAt: now, reports: [brokerReport, brokerReport] }, accounts, now)).toThrow(DomainError);
    const unmapped = { ...brokerReport, metadata: {} };
    expect(normalizeBrokerUsage({ generatedAt: now, reports: [unmapped] }, accounts, now)!.accounts).toEqual([]);
    const overage = { ...brokerReport, limits: [{ ...brokerReport.limits[0]!, amount: { unit: "tokens", used: 12, limit: 10 } }] };
    expect(normalizeBrokerUsage({ generatedAt: now, reports: [overage] }, accounts, now)!.accounts[0]!.windows[0]!.usedFraction).toBe(1.2);
  });

  test("an exact identity cannot override conflicting email or organization evidence", () => {
    const conflict = { ...brokerReport, metadata: { accountId: "alice@example.test", email: "bob@example.test" } };
    expect(normalizeBrokerUsage({ generatedAt: now, reports: [conflict] }, accounts, now)!.accounts).toEqual([]);
  });

  test("native disabled API-key facts target only their concrete slot", () => {
    const keys = projectAccounts({ credentials: [
      { id: 10, provider: "openai", identityKey: null, credential: { type: "api_key" } },
      { id: 11, provider: "openai", identityKey: null, credential: { type: "api_key" } },
    ] }, scope, now, now);
    const normalized = normalizeBrokerUsage({ generatedAt: now, reports: [], disabledCredentials: [
      { id: 11, provider: "openai", type: "api_key", disabledAtMs: now - 100, cause: "PRIVATE" },
    ] }, keys, now)!;
    expect(projectUsage(normalized, keys, choices, now, freshness).providers[0]!.accounts.map(account => account.status))
      .toEqual(["unknown", "credential_disabled"]);
  });

  test("copies health verdict only, never arbitrary cause text", () => {
    const normalized = normalizeBrokerUsage({ generatedAt: now, reports: [], disabledCredentials: [
      { provider: "openai-codex", accountId: "alice@example.test", disabledAtMs: now - 100, cause: "PRIVATE refresh token" },
    ], accountsWithoutUsage: [{ provider: "openai-codex", email: "bob@example.test" }] }, accounts, now)!;
    const result = projectUsage(normalized, accounts, choices, now, freshness);
    expect(result.providers[0]!.accounts.map(account => account.status)).toEqual(["credential_disabled", "no_usage"]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
});
