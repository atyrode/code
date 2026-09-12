import { useRef } from "react";
import type { HostServices } from "@manifold/plugin";
import type { UsageView } from "../domain/usage.ts";
import { useCodeQuery } from "./machine-web.ts";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const percentFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const usageRefreshMs = 60_000;
const statuses: Readonly<Record<string, string>> = {
  fresh: "Current usage", stale: "Cached usage", unknown: "Unknown", unavailable: "Unavailable",
  reported: "Reported", no_usage: "Unreported", blocked: "Blocked", credential_disabled: "Credential disabled",
  selection_disabled: "Selection disabled", available: "Available at observation", maxed: "Exhausted", disabled: "Selection disabled",
};
function status(value: string): string { return statuses[value] ?? "Unknown"; }
function time(value: number | null): string { return value === null ? "Unknown" : dateFormat.format(new Date(value)); }
function observedAgo(value: number | null, now: number): string {
  if (value === null) return "not yet checked";
  const seconds = Math.max(0, Math.floor((now - value) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return relativeTimeFormat.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return relativeTimeFormat.format(-Math.floor(seconds / 3600), "hour");
  return relativeTimeFormat.format(-Math.floor(seconds / 86400), "day");
}
function resetTime(value: number | null, now: number): string {
  if (value === null) return "reset unknown";
  const remaining = value - now;
  if (remaining <= 0) return "reset time passed · awaiting provider update";
  const minutes = Math.ceil(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  return `reset in ${days ? `${days}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`}`;
}

type UsageAccount = UsageView["providers"][number]["accounts"][number];
type UsageWindow = UsageAccount["windows"][number];

function QuotaWindow({ window, inactive, now, cached }: { window: UsageWindow; inactive: boolean; now: number; cached: boolean }) {
  const percent = window.usedFraction === null || window.status === "unknown" ? null : window.usedFraction * 100;
  const label = `${window.windowId}${window.tier ? ` ${window.tier}` : ""}`;
  const readingStatus = cached && window.status !== "unknown" ? "stale" : window.status;
  const state = inactive ? "inactive" : readingStatus;
  return <li className="plugin-atyrode_code__usage-window" data-state={state} data-level={percent === null ? "unknown" : percent >= 100 ? "exhausted" : percent >= 90 ? "high" : "normal"}>
    <span className="plugin-atyrode_code__usage-window-label">{label}</span>
    {percent === null ? <span className="plugin-atyrode_code__usage-meter-unknown" aria-hidden="true" /> :
      <meter className="plugin-atyrode_code__usage-meter" min={0} max={100} value={Math.min(100, percent)}
        aria-label={`${label}: ${percentFormat.format(percent)}% used, ${inactive ? "disabled or blocked account, " : ""}${status(readingStatus).toLowerCase()}`} />}
    <span className="plugin-atyrode_code__usage-percent">{percent === null ? "Unknown" : `${percentFormat.format(percent)}% used`}</span>
    <span className="plugin-atyrode_code__usage-reset" title={`Reset: ${time(window.resetsAt)}`}>
      {window.status === "stale" && !cached && window.resetsAt !== null && window.resetsAt > now && <span className="plugin-atyrode_code__warning">Cached reading · </span>}{resetTime(window.resetsAt, now)}
    </span>
  </li>;
}

function AccountUsage({ entry, now, refreshFailed }: { entry: UsageAccount; now: number; refreshFailed: boolean }) {
  const { account } = entry;
  const inactive = !entry.selected || account.disabled || entry.status === "credential_disabled" || entry.status === "blocked";
  const identity = account.email ?? (account.type === "api_key" ? `API key · slot ${account.credentialId}` : account.identityKey ?? "Identity unavailable");
  const cached = refreshFailed || entry.freshness === "stale";
  return <article className="plugin-atyrode_code__usage-account">
    <div className="plugin-atyrode_code__usage-identity">
      <h4>{identity}</h4>
      <span className={cached ? "plugin-atyrode_code__warning" : "plugin-atyrode_code__muted"} title={`Last successful provider reading: ${time(entry.observedAt)}`}>
        {entry.observedAt === null ? "Usage not reported" : `${cached ? "Cached usage" : "Updated"} · ${observedAgo(entry.observedAt, now)}`}
      </span>
      {entry.status !== "reported" && entry.status !== "stale" && entry.status !== "unknown" && <span className={entry.status === "blocked" ? "plugin-atyrode_code__warning" : "plugin-atyrode_code__muted"}>{status(entry.status)}</span>}
    </div>
    {entry.windows.length === 0 ? <p className="plugin-atyrode_code__muted">Quota unreported</p> :
      <ul className="plugin-atyrode_code__usage-windows">{entry.windows.map((window, index) =>
        <QuotaWindow key={`${window.windowId}:${window.tier}:${index}`} window={window} inactive={inactive} now={now} cached={cached} />)}</ul>}
    <details className="plugin-atyrode_code__details plugin-atyrode_code__usage-account-details">
      <summary>Details{entry.resetCredits !== null ? ` · ${entry.resetCredits.available.toLocaleString()} reset credits (${status(entry.resetCredits.status).toLowerCase()})` : ""}{entry.balance !== null ? ` · ${entry.balance.total} ${entry.balance.currency} (${status(entry.balance.status).toLowerCase()})` : ""}</summary>
      <dl className="plugin-atyrode_code__usage-facts">
        <dt>Identity</dt><dd>{account.type === "api_key" ? "API key" : "OAuth"} · slot {account.credentialId}{account.identityKey !== null ? ` · ${account.identityKey}` : ""}</dd>
        <dt>Scope</dt><dd><code>{account.reference.scope}</code></dd>
        <dt>Selection</dt><dd>{entry.selected ? "Enabled" : "Disabled"} · credential {account.disabled ? "disabled" : "not disabled"} at observation</dd>
        <dt>Observation</dt><dd>{status(entry.freshness)} · {time(entry.observedAt)}</dd>
        {entry.disabledAt !== null && <><dt>Disabled at</dt><dd>{time(entry.disabledAt)}</dd></>}
        <dt>Blocks</dt><dd>{account.blocks.length === 0 ? "None reported" : account.blocks.map((block, index) => <div key={index}>{block.scope || "All"} · until {time(block.until)}</div>)}</dd>
        <dt>Reset credits</dt><dd>{entry.resetCredits === null ? "Unreported" : <>{entry.resetCredits.available.toLocaleString()} · {status(entry.resetCredits.status)} · observed {time(entry.resetCredits.observedAt)}<br />Expiry: {entry.resetCredits.expiresAt.length === 0 ? "Unreported" : entry.resetCredits.expiresAt.map(time).join("; ")}</>}</dd>
        <dt>Balance</dt><dd>{entry.balance === null ? "Unreported" : <>{entry.balance.total} {entry.balance.currency} · {status(entry.balance.status)} · observed {time(entry.balance.observedAt)}</>}</dd>
      </dl>
      {entry.windows.map((window, index) => <div className="plugin-atyrode_code__usage-window-detail" key={`${window.windowId}:${window.tier}:${index}`}>
        <strong>{window.windowId}{window.tier ? ` · ${window.tier}` : ""}</strong>
        <p>Bucket: {window.bucket ?? "Unreported"} · {status(window.status)}</p>
        <p>Observed: {time(window.observedAt)} · Reset: {time(window.resetsAt)}</p>
        <p>Duration: {window.durationMs === null ? "Unknown" : `${(window.durationMs / 1000).toLocaleString()} seconds`}</p>
      </div>)}
    </details>
  </article>;
}

function UsageSnapshot({ value, refreshFailed }: { value: UsageView; refreshFailed: boolean }) {
  const now = Date.now();
  const cached = refreshFailed || value.status !== "fresh" || value.providers.some(provider => provider.accounts.some(entry => entry.freshness === "stale"));
  return <>
    <div className="plugin-atyrode_code__usage-observation">
      <span className={refreshFailed ? "plugin-atyrode_code__warning" : "plugin-atyrode_code__muted"} title={`Last broker response: ${time(value.observedAt)}`}>
        {refreshFailed ? "Last known usage" : "Checked"} {observedAgo(value.observedAt, now)} · checks every minute
      </span>
      {value.accountsStatus !== "fresh" && <span className="plugin-atyrode_code__warning">Accounts {status(value.accountsStatus).toLowerCase()}</span>}
    </div>
    {cached && <p className="plugin-atyrode_code__notice">Cached usage is the last successful quota reading, not a sign-in problem. Refresh to check for an update; the broker may reuse provider readings for up to five minutes.</p>}
    {value.providers.length === 0 && <p className="plugin-atyrode_code__muted">No provider observations · quota unknown</p>}
    <div className="plugin-atyrode_code__usage-providers">{value.providers.map(provider =>
      <section key={provider.provider} className="plugin-atyrode_code__usage-provider" aria-label={`${provider.provider} usage`}>
        <h3 className={provider.family === "openai" ? "plugin-atyrode_code__provider-blue" : provider.family === "anthropic" ? "plugin-atyrode_code__provider-amber" : ""}>{provider.provider === "openai-codex" ? "Codex" : provider.provider === "anthropic" ? "Claude" : provider.provider}</h3>
        {provider.accounts.length === 0 && <p className="plugin-atyrode_code__muted">No account observations · quota unknown</p>}
        {provider.accounts.map(entry => <AccountUsage key={JSON.stringify([entry.account.reference.scope, entry.account.reference.provider, entry.account.credentialId])} entry={entry} now={now} refreshFailed={refreshFailed} />)}
        {provider.buckets.filter(bucket => bucket.status === "maxed" || bucket.status === "blocked").map(bucket => <p key={bucket.name} className="plugin-atyrode_code__warning">{bucket.name} · selected pool {status(bucket.status).toLowerCase()}</p>)}
        {provider.buckets.length > 0 && <details className="plugin-atyrode_code__details plugin-atyrode_code__usage-pool">
          <summary>Selected pool · limits &amp; status</summary>
          <ul>{provider.buckets.map(bucket => <li key={bucket.name}><strong>{bucket.name}</strong> · {status(bucket.status)} · Reset: {time(bucket.resetsAt)}</li>)}</ul>
        </details>}
      </section>)}</div>
    <details className="plugin-atyrode_code__details">
      <summary>Observation details</summary>
      <p>Scope: <code>{value.scope}</code></p>
      <p>Usage: {status(value.status)} · {time(value.observedAt)}. Accounts: {status(value.accountsStatus)}.</p>
      <p>Point-in-time observations, not a live quota guarantee. Profile choices and usage are separate observations. Reset deadlines do not confirm a reset; unknown and unreported values are not zero.</p>
    </details>
  </>;
}

function WorkspaceUsageOverview({ host }: { host: HostServices }) {
  const workspace = host.containerId ? { containerId: host.containerId } : null;
  const configuration = useCodeQuery(host, "readConfiguration", workspace);
  const current = configuration.data?.configuration;
  const feed = useCodeQuery(host, "usage", current ? workspace : null, usageRefreshMs);
  const retained = useRef<{ choices: string; value: UsageView } | null>(null);
  const choices = current ? JSON.stringify(current.accounts) : "";
  if (feed.data && (retained.current?.value !== feed.data || retained.current.choices !== choices)) retained.current = { choices, value: feed.data };
  const value = feed.data ?? (retained.current?.choices === choices ? retained.current.value : null);
  const activeProfile = current ? current.accounts.activePreset === null ? "Manual" : current.accounts.presets.find(preset => preset.id === current.accounts.activePreset)?.name ?? "Unavailable profile" : null;
  const error = configuration.error ?? feed.error;
  return <section className="plugin-atyrode_code plugin-atyrode_code__usage" aria-label="Code usage" aria-busy={feed.refreshing}>
    <header className="plugin-atyrode_code__section-heading">
      <h2 className="plugin-atyrode_code__section-label">usage</h2>
      {activeProfile !== null && <span className="plugin-atyrode_code__muted" title="Saved account pool">{activeProfile === "Manual" ? "Manual account pool" : activeProfile}</span>}
      <div className="plugin-atyrode_code__toolbar">
        <button type="button" disabled={!workspace || configuration.refreshing || feed.refreshing} onClick={() => { configuration.refresh(); feed.refresh(); }} title="Check the broker for updated provider quota readings">{configuration.refreshing || feed.refreshing ? "Checking usage…" : error ? "Retry usage" : "Refresh usage"}</button>
      </div>
    </header>
    {error && <div className="plugin-atyrode_code__notice plugin-atyrode_code__warning" role="status"><p>Usage could not be refreshed{value ? " · showing the last known readings" : ""}.</p><p>{error}</p></div>}
    {!workspace ? <p className="plugin-atyrode_code__muted" role="status">Open a workspace to read usage for its shared account choices.</p> :
      configuration.data?.configuration === null ? <p className="plugin-atyrode_code__muted" role="status">Usage appears after Code setup.</p> :
      value ? <UsageSnapshot value={value} refreshFailed={error !== null} /> :
      !error && <p className="plugin-atyrode_code__muted" role="status">Reading usage…</p>}
  </section>;
}

export function UsageOverview({ host }: { host: HostServices }) {
  return <WorkspaceUsageOverview key={JSON.stringify([host.principal.id, host.containerId])} host={host} />;
}
