import { z } from "zod";
import { AccountRecordSchema, PermittedUsageSnapshotSchema, epochMilliseconds, identifier, type AccountsObservation } from "@atyrode/manifold-omp";
import { DomainError, type AccountChoices } from "./contracts.ts";
import { accountSelectionDisabled, checkedAccountsObservation, disabledAccountReferences } from "./accounts.ts";
import { providerPolicy } from "./providers.ts";

const sourceStatus = z.enum(["fresh", "stale", "unknown"]);
const permittedAccount = PermittedUsageSnapshotSchema.shape.accounts.element;
const usageWindow = permittedAccount.shape.windows.element;
const resetCredits = permittedAccount.shape.resetCredits.unwrap();
const publicBalance = permittedAccount.shape.balance.unwrap();
type PermittedUsageSnapshot = z.infer<typeof PermittedUsageSnapshotSchema>;

/** The caller supplies policy and read outcome; timestamps never imply live authority. */
export const UsageFreshnessSchema = z.strictObject({
  maxAgeMs: epochMilliseconds,
  refreshStatus: z.enum(["succeeded", "failed", "unavailable"]),
});
export type UsageFreshness = z.infer<typeof UsageFreshnessSchema>;

const usageAccount = z.strictObject({
  account: AccountRecordSchema,
  selected: z.boolean(),
  status: z.enum(["reported", "unknown", "stale", "no_usage", "credential_disabled", "selection_disabled", "blocked"]),
  freshness: sourceStatus,
  observedAt: epochMilliseconds.nullable(),
  disabledAt: epochMilliseconds.nullable(),
  windows: z.array(usageWindow.extend({ status: sourceStatus, bucket: z.string().nullable() })),
  resetCredits: resetCredits.extend({ status: sourceStatus, observedAt: epochMilliseconds }).nullable(),
  balance: publicBalance.extend({ status: sourceStatus }).nullable(),
});
const usageBucket = z.strictObject({
  name: z.string(),
  status: z.enum(["available", "maxed", "blocked", "unknown", "stale", "disabled"]),
  resetsAt: epochMilliseconds.nullable(),
});
export const UsageViewSchema = z.strictObject({
  scope: z.string().min(1).max(1024),
  observedAt: epochMilliseconds.nullable(),
  status: z.enum(["fresh", "stale", "unavailable"]),
  accountsStatus: z.enum(["fresh", "stale", "unavailable"]),
  providers: z.array(z.strictObject({
    provider: identifier,
    family: z.string().nullable(),
    accounts: z.array(usageAccount),
    buckets: z.array(usageBucket),
  })),
});
export type UsageView = z.infer<typeof UsageViewSchema>;
type UsageAccount = z.infer<typeof usageAccount>;
type UsageBucket = z.infer<typeof usageBucket>;

function quotaBucket(provider: string, tier: string | null): string | null {
  const policy = providerPolicy(provider);
  if (!policy?.meteredProviders.includes(provider)) return null;
  if (tier === null) return policy.quotaBucketBase;
  const special = policy.special.find(value => value.bucket === tier);
  return special ? `${policy.quotaBucketBase}-${special.bucket}` : null;
}

/** Observations inform views only; OMP still owns fallback, retries, and quota enforcement. */
export function projectUsage(
  rawPermittedUsageSnapshot: unknown, accounts: AccountsObservation, choices: AccountChoices,
  nowMs: number, freshness: UsageFreshness,
): UsageView {
  const checked = checkedAccountsObservation(accounts);
  const disabled = disabledAccountReferences(choices);
  const parsedFreshness = UsageFreshnessSchema.safeParse(freshness);
  if (!parsedFreshness.success || !epochMilliseconds.safeParse(nowMs).success ||
    (checked.observedAt !== null && checked.observedAt > nowMs)) throw new DomainError("invalid_usage");
  const policy = parsedFreshness.data;
  let snapshot: PermittedUsageSnapshot | null = null;
  if (rawPermittedUsageSnapshot !== null) {
    const parsed = PermittedUsageSnapshotSchema.safeParse(rawPermittedUsageSnapshot);
    if (!parsed.success || parsed.data.scope !== checked.scope || parsed.data.observedAt > nowMs) throw new DomainError("invalid_usage");
    snapshot = parsed.data;
  }
  const sourceFresh = (observedAt: number | null): boolean => observedAt !== null &&
    policy.refreshStatus === "succeeded" && nowMs - observedAt <= policy.maxAgeMs;
  const snapshotFresh = snapshot !== null && sourceFresh(snapshot.observedAt);
  const accountFactsFresh = checked.status === "fresh" && checked.observedAt !== null &&
    nowMs - checked.observedAt <= policy.maxAgeMs;
  const reports = new Map<number, PermittedUsageSnapshot["accounts"][number]>();
  const identities = new Set<string>();
  for (const report of snapshot?.accounts ?? []) {
    const identity = JSON.stringify([report.provider, report.identityKey]);
    if (reports.has(report.credentialId) || (report.identityKey !== null && identities.has(identity)) ||
      report.observedAt > snapshot!.observedAt ||
      (report.disabledAt !== undefined && (report.status !== "credential_disabled" || report.disabledAt > report.observedAt)) ||
      (report.status === "no_usage" && report.windows.length !== 0)) throw new DomainError("invalid_usage");
    reports.set(report.credentialId, report);
    if (report.identityKey !== null) identities.add(identity);
    const windows = new Set<string>();
    for (const window of report.windows) {
      const key = JSON.stringify([window.tier, window.windowId]);
      if (windows.has(key) || (window.observedAt !== null && window.observedAt > report.observedAt) ||
        (window.usedFraction !== null && window.observedAt === null)) throw new DomainError("invalid_usage");
      windows.add(key);
    }
    if (report.balance && report.balance.observedAt > report.observedAt) throw new DomainError("invalid_usage");
  }
  const providers = new Map<string, UsageView["providers"][number]>();
  for (const account of checked.accounts) {
    const provider = account.reference.provider;
    let group = providers.get(provider);
    if (!group) {
      const providerRules = providerPolicy(provider);
      const buckets: UsageBucket[] = providerRules?.meteredProviders.includes(provider) ?
        [providerRules.quotaBucketBase, ...providerRules.special.map(special => `${providerRules.quotaBucketBase}-${special.bucket}`)]
          .map(name => ({ name, status: "unknown", resetsAt: null })) : [];
      group = { provider, family: providerRules?.family ?? null, accounts: [], buckets };
      providers.set(provider, group);
    }
    const candidate = reports.get(account.credentialId);
    // A reused slot, different provider, or re-login does not inherit another identity's usage.
    const report = candidate?.provider === provider && candidate.identityKey === account.identityKey ? candidate : undefined;
    const selected = !accountSelectionDisabled(account, disabled);
    const fresh = snapshotFresh && accountFactsFresh && report !== undefined && sourceFresh(report.observedAt);
    const row: UsageAccount = {
      account: { ...account, blocks: account.blocks.filter(block => block.until > nowMs) }, selected,
      status: "unknown", freshness: report ? fresh ? "fresh" : "stale" : "unknown",
      observedAt: report?.observedAt ?? null, disabledAt: report?.disabledAt ?? null,
      windows: [], resetCredits: null, balance: null,
    };
    for (const window of report?.windows ?? []) {
      const status = window.usedFraction === null || window.quotaStatus === "unknown" ? "unknown" :
        fresh && sourceFresh(window.observedAt) && (window.resetsAt === null || window.resetsAt > nowMs) ? "fresh" : "stale";
      row.windows.push({ ...window, status, bucket: quotaBucket(provider, window.tier) });
    }
    if (report?.resetCredits) row.resetCredits = { ...report.resetCredits,
      expiresAt: [...report.resetCredits.expiresAt].sort((left, right) => left - right),
      status: fresh && report.resetCredits.expiresAt.every(time => time > nowMs) ? "fresh" : "stale", observedAt: report.observedAt };
    if (report?.balance) row.balance = { ...report.balance,
      status: fresh && sourceFresh(report.balance.observedAt) ? "fresh" : "stale" };
    if (report) row.status = fresh ? report.status : "stale";
    if (row.status === "reported" && row.windows.some(window => window.status !== "fresh")) {
      row.status = row.windows.some(window => window.status === "stale") ? "stale" : "unknown";
    }
    if (row.status === "reported" && row.windows.length === 0) row.status = "unknown";
    if (accountFactsFresh && row.account.blocks.some(block => block.scope === "")) row.status = "blocked";
    if (account.disabled || (fresh && report?.status === "credential_disabled")) row.status = "credential_disabled";
    if (!selected) row.status = "selection_disabled";
    group.accounts.push(row);
  }
  for (const group of providers.values()) {
    for (const bucket of group.buckets) {
      const votes: UsageBucket[] = [];
      const providerRules = providerPolicy(group.provider)!;
      for (const row of group.accounts) {
        if (!row.selected || row.account.disabled || (row.freshness === "fresh" && row.status === "credential_disabled")) continue;
        const windows = row.windows.filter(window => window.bucket === bucket.name);
        const blocks = accountFactsFresh ? row.account.blocks.filter(block => block.scope === "" ||
          (bucket.name === providerRules.quotaBucketBase ? block.scope === "chat" :
            providerRules.special.some(special => bucket.name === `${providerRules.quotaBucketBase}-${special.bucket}` &&
              (block.scope === special.bucket || block.scope === `tier:${special.bucket}`)))) : [];
        // OMP can report 100% as warning while the provider still permits use.
        // Only meters without a provider verdict fall back to their fraction.
        const exhausted = windows.filter(window => window.status === "fresh" &&
          (window.quotaStatus === "exhausted" ||
            (window.quotaStatus === null && window.usedFraction !== null && window.usedFraction >= 1)));
        if (blocks.length || exhausted.length) {
          const unknownReset = exhausted.some(window => window.resetsAt === null);
          votes.push({ name: bucket.name, status: blocks.length ? "blocked" : "maxed", resetsAt: unknownReset ? null :
            Math.max(...blocks.map(block => block.until), ...exhausted.map(window => window.resetsAt!)) });
        } else if (windows.length && windows.every(window => window.status === "fresh")) {
          votes.push({ name: bucket.name, status: "available", resetsAt: null });
        } else {
          votes.push({ name: bucket.name, status: !accountFactsFresh || row.freshness === "stale" ||
            windows.some(window => window.status === "stale") ? "stale" : "unknown", resetsAt: null });
        }
      }
      if (votes.length === 0) bucket.status = "disabled";
      else if (votes.some(vote => vote.status === "available")) bucket.status = "available";
      else if (votes.some(vote => vote.status === "unknown")) bucket.status = "unknown";
      else if (votes.some(vote => vote.status === "stale")) bucket.status = "stale";
      else {
        bucket.status = votes.every(vote => vote.status === "blocked") ? "blocked" : "maxed";
        const resets = votes.flatMap(vote => vote.resetsAt === null ? [] : [vote.resetsAt]);
        bucket.resetsAt = resets.length ? Math.min(...resets) : null;
      }
    }
  }
  return { scope: checked.scope, observedAt: snapshot?.observedAt ?? null,
    status: snapshot === null ? "unavailable" : snapshotFresh && accountFactsFresh ? "fresh" : "stale",
    accountsStatus: accountFactsFresh ? "fresh" : checked.status === "unavailable" ? "unavailable" : "stale",
    providers: [...providers.values()] };
}
