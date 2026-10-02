import { useEffect, useMemo, useRef } from "react";
import type { HostServices } from "@manifold/plugin";
import type { AccountsObservation } from "@atyrode/manifold-omp";
import type { AccountChoices } from "../domain/contracts.ts";
import type { UsageView } from "../domain/usage.ts";
import { ACCOUNTS_PLUGIN_ID } from "./contract.ts";
import { ACCOUNT_REFRESH_MS, codeWorkflow, useCodeQuery, useOmpQuery, useWorkflowQuery } from "./machine-web.ts";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const percentFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const usageRefreshMs = 60_000;
const statuses: Readonly<Record<string, string>> = {
  fresh: "Fresh at observation", stale: "Cached reading", unknown: "Unknown", unavailable: "Unavailable",
  reported: "Reported", no_usage: "Unreported", blocked: "Blocked at observation", credential_disabled: "Credential disabled at observation",
  selection_disabled: "Excluded", available: "Allowed at observation", maxed: "Exhausted at observation", disabled: "No included enabled credentials",
};
function status(value: string): string { return statuses[value] ?? value; }
function historicalStatus(value: string, cached: boolean): string {
  return cached || value === "stale" ? `Historical · source status: ${status(value).toLowerCase()}` : status(value);
}
function time(value: number | null): string { return value === null ? "Unknown" : dateFormat.format(new Date(value)); }
function observedAgo(value: number | null, now: number): string {
  if (value === null) return "not reported";
  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return relativeTimeFormat.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return relativeTimeFormat.format(-Math.floor(seconds / 3600), "hour");
  return relativeTimeFormat.format(-Math.floor(seconds / 86400), "day");
}
function resetTime(value: number | null, now: number): string {
  if (value === null) return "reset unknown";
  const remaining = value - now;
  if (remaining <= 0) return "reset deadline passed · not confirmed";
  const minutes = Math.ceil(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  return `reset in ${days ? `${days}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`}`;
}

type UsageAccount = UsageView["providers"][number]["accounts"][number];
type UsageWindow = UsageAccount["windows"][number];
function accountKey(entry: UsageAccount): string {
  const { reference, credentialId } = entry.account;
  return JSON.stringify([reference.scope, reference.provider, reference.kind,
    reference.kind === "identity" ? reference.identityKey : reference.credentialId, credentialId]);
}

/** Retention never crosses an observed scope or exact saved choice set. Account
 * metadata changes invalidate current usage, even before the next quota read. */
export function useAccountUsage(host: HostServices, choices: AccountChoices | null, observation: AccountsObservation | null) {
  const choiceKey = choices === null ? null : JSON.stringify(choices);
  const scope = useRef<string | null>(null);
  if (observation) scope.current = observation.scope;
  const accountsKey = observation ? JSON.stringify(observation.accounts) : null;
  const feed = useWorkflowQuery(host, `usage:${JSON.stringify([host.containerId, choiceKey, scope.current, accountsKey])}`, choices !== null,
    async () => ({ choices: choiceKey!, accounts: accountsKey, value: await codeWorkflow(host).usage(choices!) }), usageRefreshMs);
  const retained = useRef<{ choices: string; accounts: string | null; value: UsageView } | null>(null);
  if (retained.current && (retained.current.choices !== choiceKey || (scope.current !== null && retained.current.value.scope !== scope.current))) retained.current = null;
  if (feed.data?.choices === choiceKey && (scope.current === null || feed.data.value.scope === scope.current)) retained.current = feed.data;
  const value = retained.current?.value ?? null;
  const cached = feed.error !== null || feed.data?.value !== value || observation?.status !== "fresh" ||
    retained.current?.accounts !== accountsKey || value?.status !== "fresh" || value?.accountsStatus !== "fresh";
  return { ...feed, value, cached };
}

function QuotaWindow({ window, inactive, now, cached }: { window: UsageWindow; inactive: boolean; now: number; cached: boolean }) {
  const percent = window.usedFraction === null || window.status === "unknown" ? null : window.usedFraction * 100;
  const label = `${window.windowId}${window.tier ? ` · ${window.tier}` : ""}`;
  const historical = cached || window.status === "stale";
  const exhausted = window.quotaStatus === "exhausted" || (window.quotaStatus === null && percent !== null && percent >= 100);
  return <li className="plugin-atyrode_code__usage-window" data-state={inactive ? "inactive" : historical ? "stale" : window.status}
    data-level={percent === null ? "unknown" : exhausted ? "exhausted" : window.quotaStatus === "warning" || percent >= 90 ? "high" : "normal"}>
    <span className="plugin-atyrode_code__usage-window-label">{label}</span>
    <span className="plugin-atyrode_code__usage-amount">
      {percent !== null && <meter className="plugin-atyrode_code__usage-meter" min={0} max={100} value={Math.min(100, percent)}
        aria-label={`${label}: ${percentFormat.format(percent)}% used${historical ? ", historical reading" : " at observation"}${inactive ? ", excluded, disabled or blocked account" : ""}`} />}
      <span className="plugin-atyrode_code__usage-percent">{percent === null ? "Usage unknown" : `${percentFormat.format(percent)}% used`}</span>
    </span>
    <span className="plugin-atyrode_code__usage-reset" title={`Observed: ${time(window.observedAt)} · Reset: ${time(window.resetsAt)}`}>
      {historical ? `Historical reset: ${time(window.resetsAt)}` : resetTime(window.resetsAt, now)}
      <span className="plugin-atyrode_code__usage-source">{historical ? "Historical" : "Observed"} · {observedAgo(window.observedAt, now)}{window.quotaStatus !== null ? ` · provider: ${window.quotaStatus}` : ""}</span>
    </span>
  </li>;
}

/** Shared by the account editor and the read-only usage ledger. */
export function AccountUsageReadings({ entry, now, cached, details = true }: { entry: UsageAccount; now: number; cached: boolean; details?: boolean }) {
  const { account } = entry;
  const historical = cached || entry.freshness === "stale";
  const inactive = !entry.selected || account.disabled || entry.status === "credential_disabled" || entry.status === "blocked";
  const creditsHistorical = historical || entry.resetCredits?.status === "stale";
  const balanceHistorical = historical || entry.balance?.status === "stale";
  return <div className="plugin-atyrode_code__usage-readings">
    {entry.windows.length === 0 ? <p className="plugin-atyrode_code__muted">{historical ? "Historical · quota unreported" : "Quota unreported · no capacity estimate"}</p> :
      <ul className="plugin-atyrode_code__usage-windows">{entry.windows.map(window =>
        <QuotaWindow key={JSON.stringify([window.windowId, window.tier])} window={window} inactive={inactive} now={now} cached={historical} />)}</ul>}
    {details && <details className="plugin-atyrode_code__details plugin-atyrode_code__usage-account-details">
      <summary>{historical ? "Historical account & usage facts" : "Account & usage facts"}
        {entry.resetCredits !== null ? ` · ${creditsHistorical ? "historical " : ""}${entry.resetCredits.available.toLocaleString()} reset credits` : ""}
        {entry.balance !== null ? ` · ${balanceHistorical ? "historical " : ""}${entry.balance.total} ${entry.balance.currency}` : ""}</summary>
      <dl className="plugin-atyrode_code__usage-facts">
        <dt>Identity</dt><dd>{account.type === "api_key" ? "API key" : "OAuth"} · slot {account.credentialId}{account.identityKey !== null ? ` · ${account.identityKey}` : ""}</dd>
        <dt>Scope</dt><dd><code>{account.reference.scope}</code></dd>
        <dt>Saved inclusion</dt><dd>{historical ? "Historical · " : ""}{entry.selected ? "Included" : "Excluded"} · not launch approval</dd>
        <dt>Credential</dt><dd>{historical ? "Historical · " : ""}{account.disabled ? "Disabled" : "Not disabled"} at observation</dd>
        <dt>Account status</dt><dd>{historicalStatus(entry.status, historical)}</dd>
        <dt>Provider reading</dt><dd>{historicalStatus(entry.freshness, historical)} · {time(entry.observedAt)}</dd>
        {entry.disabledAt !== null && <><dt>Disabled at</dt><dd>{historical ? "Historical · " : ""}{time(entry.disabledAt)}</dd></>}
        <dt>Native blocks</dt><dd>{historical ? "Historical · " : ""}{account.blocks.length === 0 ? "None reported at observation" : account.blocks.map(block => <div key={block.scope}>{block.scope || "All"} · until {time(block.until)}</div>)}</dd>
        <dt>Reset credits</dt><dd>{entry.resetCredits === null ? `${historical ? "Historical · " : ""}Unreported` : <>{entry.resetCredits.available.toLocaleString()} · {historicalStatus(entry.resetCredits.status, historical)} · observed {time(entry.resetCredits.observedAt)}<br />{creditsHistorical ? "Historical expiry" : "Reported expiry"}: {entry.resetCredits.expiresAt.length === 0 ? "Unreported" : entry.resetCredits.expiresAt.map(time).join("; ")}</>}</dd>
        <dt>Balance</dt><dd>{entry.balance === null ? `${historical ? "Historical · " : ""}Unreported` : <>{entry.balance.total} {entry.balance.currency} · {historicalStatus(entry.balance.status, historical)} · observed {time(entry.balance.observedAt)}</>}</dd>
      </dl>
      {entry.windows.map(window => <div className="plugin-atyrode_code__usage-window-detail" key={JSON.stringify([window.windowId, window.tier])}>
        <strong>{window.windowId}{window.tier ? ` · ${window.tier}` : ""}</strong>
        <p>{historical || window.status === "stale" ? "Historical bucket" : "Bucket"}: {window.bucket ?? "Unreported"} · {historicalStatus(window.status, historical)}</p>
        <p>{historical || window.status === "stale" ? "Historical provider verdict" : "Provider verdict"}: {window.quotaStatus ?? "Unreported"}</p>
        <p>{historical || window.status === "stale" ? "Historical observation" : "Observed"}: {time(window.observedAt)} · Reported reset: {time(window.resetsAt)}</p>
        <p>{historical || window.status === "stale" ? "Historical duration" : "Duration"}: {window.durationMs === null ? "Unknown" : `${(window.durationMs / 1000).toLocaleString()} seconds`}</p>
      </div>)}
    </details>}
  </div>;
}

function AccountUsage({ entry, now, cached, compact }: { entry: UsageAccount; now: number; cached: boolean; compact: boolean }) {
  const { account } = entry;
  const historical = cached || entry.freshness === "stale";
  return <article className="plugin-atyrode_code__usage-account" data-compact={compact || undefined}>
    <div className="plugin-atyrode_code__usage-identity">
      <h4>{account.email ?? (account.type === "api_key" ? "API key" : "OAuth account")}</h4>
      <span className="plugin-atyrode_code__usage-exact-identity">{account.identityKey ?? "API key"} · slot {account.credentialId}</span>
      <span>{historical ? "Historical · " : ""}{entry.selected ? "Included" : "Excluded"} · {account.disabled || entry.status === "credential_disabled" ? "credential disabled at observation" : account.blocks.length > 0 ? "native blocks at observation" : "no native blocks at observation"}</span>
      <span title={`Provider reading: ${time(entry.observedAt)}`}>{historical ? "Cached" : "Provider reading"} · {observedAgo(entry.observedAt, now)}</span>
    </div>
    <AccountUsageReadings entry={entry} now={now} cached={cached} details={!compact} />
  </article>;
}

function UsageSnapshot({ value, cached, compact = false }: { value: UsageView; cached: boolean; compact?: boolean }) {
  const now = Date.now();
  return <>
    <div className="plugin-atyrode_code__usage-observation">
      <span title={`Broker response: ${time(value.observedAt)}`}>{cached ? "Historical broker response" : "Broker checked"} · {observedAgo(value.observedAt, now)}</span>
      <span>{cached ? "Current availability unknown" : "Included does not mean ready · launch review required"}</span>
    </div>
    {value.providers.length === 0 && <p className="plugin-atyrode_code__muted">{cached ? "Historical · " : ""}No account observations · quota unknown.</p>}
    <div className="plugin-atyrode_code__usage-providers">{value.providers.map(provider =>
      <section key={provider.provider} className="plugin-atyrode_code__usage-provider" aria-label={`${provider.provider} usage`}>
        <h3 className={provider.family === "openai" ? "plugin-atyrode_code__provider-blue" : provider.family === "anthropic" ? "plugin-atyrode_code__provider-amber" : ""}>{provider.provider}</h3>
        {provider.accounts.map(entry => <AccountUsage key={accountKey(entry)} entry={entry} now={now} cached={cached} compact={compact} />)}
        {!compact && provider.buckets.length > 0 && <details className="plugin-atyrode_code__details plugin-atyrode_code__usage-pool">
          <summary>{cached ? "Historical pool assessment" : "Pool assessment at observation"} · not an aggregate quota</summary>
          <ul>{provider.buckets.map(bucket => <li key={bucket.name}><strong>{bucket.name}</strong> · {historicalStatus(bucket.status, cached)} · {cached || bucket.status === "stale" ? "Historical reset" : "Reported reset"}: {time(bucket.resetsAt)}</li>)}</ul>
        </details>}
      </section>)}</div>
    <details className="plugin-atyrode_code__details plugin-atyrode_code__usage-observation-details">
      <summary>{compact ? "All account facts & pool assessments" : "Observation details"}{cached ? " · historical" : ""}</summary>
      {compact ? <UsageSnapshot value={value} cached={cached} /> : <>
        <p>{cached ? "Historical scope" : "Scope"}: <code>{value.scope}</code></p>
        <p>Usage: {historicalStatus(value.status, cached)} · {time(value.observedAt)}. Accounts: {historicalStatus(value.accountsStatus, cached)}.</p>
        <p>Checks every minute. The broker may reuse provider readings for up to five minutes. Each account and window keeps its own source time. Cached facts do not confirm current availability.</p>
        <p>Windows are separate limits, never averaged. Reset deadlines do not confirm restored quota; unknown and unreported are not zero. Code inclusion does not enable a disabled native credential.</p>
      </>}
    </details>
  </>;
}

type UsageOverviewProps = { host: HostServices; compact?: boolean; onAccounts?: () => void; onObservation?: (signature: string) => void };

function WorkspaceUsageOverview({ host, compact = false, onAccounts, onObservation }: UsageOverviewProps) {
  const workspace = host.containerId ? { containerId: host.containerId } : null;
  const configuration = useCodeQuery(host, "readConfiguration", workspace);
  const lastConfiguration = useRef(configuration.data);
  if (configuration.data) lastConfiguration.current = configuration.data;
  const current = (configuration.data ?? lastConfiguration.current)?.configuration ?? null;
  const accounts = useOmpQuery(host, "accounts", {}, ACCOUNT_REFRESH_MS);
  const usage = useAccountUsage(host, current?.accounts ?? null, accounts.data);
  const { value } = usage;
  const historicalChoices = configuration.data === null && current !== null;
  const cached = usage.cached || historicalChoices || configuration.error !== null || accounts.error !== null;
  const manual = current?.accounts.activePreset === null;
  const activeProfile = current ? manual ? "Manual · immediate edits" : `Saved preset: ${current.accounts.presets.find(preset => preset.id === current.accounts.activePreset)?.name ?? "Unavailable"}` : null;
  const error = configuration.error ?? accounts.error ?? usage.error;
  const observationKey = useMemo(() => JSON.stringify([configuration.error !== null, accounts.error !== null, usage.error !== null,
    accounts.data?.status, accounts.data?.scope, accounts.data?.accounts]), [configuration.error, accounts.error, usage.error, accounts.data]);
  useEffect(() => { onObservation?.(observationKey); }, [onObservation, observationKey]);
  return <section className="plugin-atyrode_code plugin-atyrode_code__usage" data-compact={compact || undefined} aria-label="Account and quota ledger" aria-busy={configuration.refreshing || usage.refreshing}>
    <header className="plugin-atyrode_code__section-heading">
      <h2 className="plugin-atyrode_code__section-label">{compact ? "accounts / usage" : "usage"}</h2>
      {activeProfile !== null && <span className="plugin-atyrode_code__muted" data-account-pool={historicalChoices ? "historical" : "saved"}>{historicalChoices ? "Last saved · " : ""}{activeProfile}</span>}
      <div className="plugin-atyrode_code__toolbar">
        <button type="button" onClick={onAccounts ?? (() => host.navigate(`manifold://plugin/${ACCOUNTS_PLUGIN_ID}`))}>Manage accounts</button>
        <button type="button" data-action="atyrode.omp.accounts.usage" disabled={!workspace || configuration.refreshing || usage.refreshing} onClick={() => { configuration.refresh(); accounts.refresh(); usage.refresh(); }} title="Check the broker; provider readings may be reused for up to five minutes">{configuration.refreshing || usage.refreshing ? "Checking…" : error ? "Retry check" : "Check usage"}</button>
      </div>
    </header>
    {error && <div className="plugin-atyrode_code__notice plugin-atyrode_code__warning" role="status">
      <p>Observation failed{value ? " · all retained facts are historical; current availability is unknown" : " · current availability is unknown"}.</p>
      <details className="plugin-atyrode_code__details"><summary>Error details</summary><pre>{error}</pre></details>
    </div>}
    {!workspace ? <p className="plugin-atyrode_code__muted" role="status">Open a workspace to view shared usage.</p> :
      configuration.data?.configuration === null ? <p className="plugin-atyrode_code__muted" role="status">Account choices not initialized. Native accounts are managed separately in Accounts.</p> :
      value ? <UsageSnapshot value={value} cached={cached} compact={compact} /> :
      !error && <p className="plugin-atyrode_code__muted" role="status">Reading account choices and usage…</p>}
  </section>;
}

export function UsageOverview(props: UsageOverviewProps) {
  return <WorkspaceUsageOverview key={JSON.stringify([props.host.principal.id, props.host.containerId])} {...props} />;
}
