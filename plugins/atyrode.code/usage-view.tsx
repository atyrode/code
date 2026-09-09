import type { HostServices } from "@manifold/plugin";
import type { UsageView } from "../domain/usage.ts";
import type { Target } from "./contract.ts";
import { useCodeQuery } from "./machine-web.ts";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const percentFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const statuses: Readonly<Record<string, string>> = {
  fresh: "Observed", stale: "Stale", unknown: "Unknown", unavailable: "Unavailable",
  reported: "Reported", no_usage: "Unreported", blocked: "Blocked", credential_disabled: "Credential disabled",
  selection_disabled: "Selection disabled", available: "Available at observation", maxed: "Exhausted", disabled: "Selection disabled",
};
function status(value: string): string { return statuses[value] ?? "Unknown"; }
function time(value: number | null): string { return value === null ? "Unknown" : dateFormat.format(new Date(value)); }
function resetTime(value: number | null, now: number): string {
  if (value === null) return "reset unknown";
  const remaining = value - now;
  if (remaining <= 0) return "reset due · verify";
  const minutes = Math.ceil(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  return `reset in ${days ? `${days}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`}`;
}

type UsageAccount = UsageView["providers"][number]["accounts"][number];
type UsageWindow = UsageAccount["windows"][number];

function QuotaWindow({ window, inactive, now }: { window: UsageWindow; inactive: boolean; now: number }) {
  const percent = window.usedFraction === null || window.status === "unknown" ? null : window.usedFraction * 100;
  const label = `${window.windowId}${window.tier ? ` ${window.tier}` : ""}`;
  const state = inactive ? "inactive" : window.status;
  return <li className="plugin-atyrode_code__usage-window" data-state={state} data-level={percent === null ? "unknown" : percent >= 100 ? "exhausted" : percent >= 90 ? "high" : "normal"}>
    <span className="plugin-atyrode_code__usage-window-label">{label}</span>
    {percent === null ? <span className="plugin-atyrode_code__usage-meter-unknown" aria-hidden="true" /> :
      <meter className="plugin-atyrode_code__usage-meter" min={0} max={100} value={Math.min(100, percent)}
        aria-label={`${label}: ${percentFormat.format(percent)}% used, ${inactive ? "disabled or blocked account, " : ""}${status(window.status).toLowerCase()}`}>{percentFormat.format(percent)}% used</meter>}
    <span className="plugin-atyrode_code__usage-percent">{percent === null ? "Unknown" : `${percentFormat.format(percent)}% used`}</span>
    <span className="plugin-atyrode_code__usage-reset" title={`Reset: ${time(window.resetsAt)}`}>
      {window.status === "stale" && <span className="plugin-atyrode_code__warning">stale · </span>}{resetTime(window.resetsAt, now)}
    </span>
  </li>;
}

function AccountUsage({ entry, now }: { entry: UsageAccount; now: number }) {
  const { account } = entry;
  const inactive = !entry.selected || account.disabled || entry.status === "credential_disabled" || entry.status === "blocked";
  const identity = account.email ?? (account.type === "api_key" ? `API key · slot ${account.credentialId}` : account.identityKey ?? "Identity unavailable");
  return <article className="plugin-atyrode_code__usage-account">
    <div className="plugin-atyrode_code__usage-identity">
      <h4>{identity}</h4>
      {entry.status !== "reported" && <span className={entry.status === "stale" || entry.status === "blocked" ? "plugin-atyrode_code__warning" : "plugin-atyrode_code__muted"}>{status(entry.status)}</span>}
    </div>
    {entry.windows.length === 0 ? <p className="plugin-atyrode_code__muted">Quota unreported</p> :
      <ul className="plugin-atyrode_code__usage-windows">{entry.windows.map((window, index) =>
        <QuotaWindow key={`${window.windowId}:${window.tier}:${index}`} window={window} inactive={inactive} now={now} />)}</ul>}
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

function UsageSnapshot({ value }: { value: UsageView }) {
  const now = Date.now();
  return <>
    <div className="plugin-atyrode_code__usage-observation">
      <span className={value.status === "fresh" ? "plugin-atyrode_code__muted" : "plugin-atyrode_code__warning"}>{value.status === "fresh" ? `Observed ${time(value.observedAt)}` : `${status(value.status)} usage · quotas not current`}</span>
      {value.accountsStatus !== "fresh" && <span className="plugin-atyrode_code__warning">Accounts {status(value.accountsStatus).toLowerCase()}</span>}
    </div>
    {value.providers.length === 0 && <p className="plugin-atyrode_code__muted">No provider observations · quota unknown</p>}
    <div className="plugin-atyrode_code__usage-providers">{value.providers.map(provider =>
      <section key={provider.provider} className="plugin-atyrode_code__usage-provider" aria-label={`${provider.provider} usage`}>
        <h3 className={provider.family === "openai" ? "plugin-atyrode_code__provider-blue" : provider.family === "anthropic" ? "plugin-atyrode_code__provider-amber" : ""}>{provider.provider === "openai-codex" ? "Codex" : provider.provider === "anthropic" ? "Claude" : provider.provider}</h3>
        {provider.accounts.length === 0 && <p className="plugin-atyrode_code__muted">No account observations · quota unknown</p>}
        {provider.accounts.map(entry => <AccountUsage key={JSON.stringify([entry.account.reference.scope, entry.account.reference.provider, entry.account.credentialId])} entry={entry} now={now} />)}
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

function TargetUsageOverview({ host, target }: { host: HostServices; target: Target | null }) {
  const configuration = useCodeQuery(host, "readConfiguration", target);
  const current = configuration.data?.configuration;
  const feed = useCodeQuery(host, "usage", current ? target : null);
  const activeProfile = current ? current.accounts.activePreset === null ? "Manual" : current.accounts.presets.find(preset => preset.id === current.accounts.activePreset)?.name ?? "Unavailable profile" : null;
  const error = configuration.error ?? feed.error;
  return <section className="plugin-atyrode_code plugin-atyrode_code__usage" aria-label="Code usage">
    <header className="plugin-atyrode_code__section-heading">
      <h2 className="plugin-atyrode_code__section-label">usage</h2>
      {activeProfile !== null && <span className="plugin-atyrode_code__muted" title="Saved account pool">{activeProfile === "Manual" ? "Manual account pool" : activeProfile}</span>}
      <div className="plugin-atyrode_code__toolbar">
        <button type="button" disabled={target === null} onClick={() => { configuration.refresh(); feed.refresh(); }} title="Refresh native observations only">Refresh</button>
      </div>
    </header>
    {!target ? <p className="plugin-atyrode_code__muted" role="status">Select a machine in a mounted workspace to read usage.</p> : error ?
      <div className="plugin-atyrode_code__notice plugin-atyrode_code__warning" role="status"><p>Usage unavailable</p><p>{error}</p></div> :
      configuration.data?.configuration === null ? <p className="plugin-atyrode_code__muted" role="status">Usage appears after Code setup.</p> :
      !configuration.data || !feed.data ? <p className="plugin-atyrode_code__muted" role="status">Reading usage…</p> : <UsageSnapshot value={feed.data} />}
  </section>;
}

export function UsageOverview({ host, target }: { host: HostServices; target: Target | null }) {
  return <TargetUsageOverview key={JSON.stringify([host.principal.id, target?.containerId, target?.machineId])} host={host} target={target} />;
}
