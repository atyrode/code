import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { HostServices } from "@manifold/plugin";
import type { AccountsObservation } from "@atyrode/manifold-omp";
import type { AccountChoiceChange, AccountChoices } from "../domain/contracts.ts";
import { accountSelectionDisabled } from "../domain/accounts.ts";
import { providerPolicy } from "../domain/providers.ts";
import type { UsageView } from "../domain/usage.ts";
import { ACCOUNTS_PLUGIN_ID } from "./contract.ts";
import { ACCOUNT_REFRESH_MS, callCodeAction, canWriteCodeWorkspace, codeOperationFailure, codeWorkflow, useCodeQuery, useOmpQuery, useWorkflowQuery } from "./machine-web.ts";
import { ControlIcon, Spinner } from "@manifold/ui";
import {
  accountWord, ago, Button, Check, clock, countdown, hhmm, hueOf, Menu, MenuHeader, MenuItem, MenuRule, Notice, SectionBand, State, UsageBar,
  useMenu, useMinuteTick, withKey,
} from "./ui.tsx";

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

// ---------------------------------------------------------------- the main view's usage section

type WindowState = { level: "ok" | "warn" | "error" | "unknown"; word: "" | "tight" | "maxed" | "blocked"; until: number | null; percent: number | null };
const FAMILY_ORDER = ["openai", "anthropic", "deepseek"];

/** Whether a provider block covers this window's quota bucket, by the same scope rules the pool assessment uses. */
function covers(block: { scope: string }, window: UsageWindow, provider: string): boolean {
  const policy = providerPolicy(provider);
  return block.scope === "" || (window.bucket === policy.quotaBucketBase ? block.scope === "chat" :
    policy.special.some(special => window.bucket === `${policy.quotaBucketBase}-${special.bucket}` && (block.scope === special.bucket || block.scope === `tier:${special.bucket}`)));
}
/** The latest end of a provider block covering this window. High usage alone never reads as blocked. */
function windowBlock(entry: UsageAccount, window: UsageWindow, provider: string): number | null {
  const until = entry.account.blocks.filter(block => covers(block, window, provider)).map(block => block.until);
  return until.length ? Math.max(...until) : null;
}
/** Quota words: `tight` from 80% (red from 95%), `maxed` when exhausted, `blocked` only for a provider block. */
function windowState(entry: UsageAccount, window: UsageWindow, provider: string): WindowState {
  const percent = window.usedFraction === null || window.status === "unknown" ? null : window.usedFraction * 100;
  const until = windowBlock(entry, window, provider);
  if (until !== null) return { level: "error", word: "blocked", until, percent };
  if (percent === null) return { level: "unknown", word: "", until: null, percent };
  // OMP can report 100% as a warning while the provider still serves; only a verdict-less meter falls back to its fraction.
  if (window.quotaStatus === "exhausted" || (window.quotaStatus === null && percent >= 100)) return { level: "error", word: "maxed", until: null, percent };
  if (percent >= 95) return { level: "error", word: "tight", until: null, percent };
  if (percent >= 80 || window.quotaStatus === "warning") return { level: "warn", word: "tight", until: null, percent };
  return { level: "ok", word: "", until: null, percent };
}
/** `5h`, `7d`, or the special bucket a window meters (`spark`). */
function windowLabel(window: UsageWindow, provider: string): string {
  const duration = window.durationMs;
  const span = duration === null ? ({ "5-hour": "5h", weekly: "7d", daily: "1d" } as Readonly<Record<string, string>>)[window.windowId] ?? window.windowId
    : duration % 86_400_000 === 0 ? `${duration / 86_400_000}d` : duration % 3_600_000 === 0 ? `${duration / 3_600_000}h` : `${Math.round(duration / 60_000)}m`;
  if (window.tier !== null && providerPolicy(provider).special.some(special => special.bucket === window.tier)) return window.tier.toLowerCase();
  // A plan tier (`Max`) is a fact about the account, not the window; it belongs in the readout, not the 6ch label.
  return span;
}
function identityOf(entry: UsageAccount): string {
  const { account } = entry;
  return account.email ?? (account.type === "api_key" ? `API key ${account.credentialId}` : account.identityKey ?? `OAuth ${account.credentialId}`);
}
function balanceText(balance: NonNullable<UsageAccount["balance"]>): string {
  return balance.currency === "USD" ? `$${balance.total}` : `${balance.total} ${balance.currency}`;
}

type UsageZoneProps = {
  host: HostServices;
  className?: string | undefined;
  /** Opens the accounts surface; the generator shows it as a sheet. */
  onAccounts: () => void;
  /** Any change to the account observation revokes a reviewed launch (workbench `setAccountObservation`). */
  onObservation?: ((signature: string) => void) | undefined;
  /** Families with at least one included account, from a fresh reading; null whenever that is not known. Must be stable. */
  onFamilies?: ((families: ReadonlySet<string> | null) => void) | undefined;
  /** Receives this zone's refresh so a panel-level `r` key reaches it. */
  refresher?: RefObject<(() => void) | null> | undefined;
};

/** The main view's usage section: provider columns, account rows and quota windows on the same data as `UsageOverview`. */
export function UsageZone(props: UsageZoneProps) {
  return <WorkspaceUsageZone key={JSON.stringify([props.host.principal.id, props.host.containerId])} {...props} />;
}

const U = "plugin-atyrode_code__";

function WorkspaceUsageZone({ host, className, onAccounts, onObservation, onFamilies, refresher }: UsageZoneProps) {
  const now = Date.now();
  useMinuteTick();
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
  const error = configuration.error ?? accounts.error ?? usage.error;
  const historicalAccounts = historicalChoices || accounts.data === null || accounts.data.status !== "fresh" || configuration.error !== null || accounts.error !== null;
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [tab, setTab] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const poolMenu = useMenu();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const observationKey = useMemo(() => JSON.stringify([configuration.error !== null, accounts.error !== null, usage.error !== null,
    accounts.data?.status, accounts.data?.scope, accounts.data?.accounts]), [configuration.error, accounts.error, usage.error, accounts.data]);
  useEffect(() => { onObservation?.(observationKey); }, [onObservation, observationKey]);
  const familiesKey = useMemo(() => {
    if (!value || cached || !value.providers.some(provider => provider.accounts.length)) return null;
    return JSON.stringify(value.providers.filter(provider => provider.family !== null && provider.accounts.some(entry =>
      entry.selected && !entry.account.disabled && entry.status !== "credential_disabled")).map(provider => provider.family).sort());
  }, [value, cached]);
  useEffect(() => { onFamilies?.(familiesKey === null ? null : new Set(JSON.parse(familiesKey) as string[])); }, [onFamilies, familiesKey]);
  function refresh() { configuration.refresh(); accounts.refresh(); usage.refresh(); }
  useEffect(() => {
    if (!refresher) return;
    refresher.current = refresh;
    return () => { refresher.current = null; };
  });
  const writable = canWriteCodeWorkspace(host);
  const canEdit = writable && workspace !== null && current !== null && configuration.data !== null && !pending;
  const manual = current?.accounts.activePreset === null;
  /** The same guarded `changeAccounts` edit the accounts view makes: exact revision, no retry, never on historical inventory. */
  async function change(edit: AccountChoiceChange) {
    if (!workspace || !canEdit || !current || busy.current || (edit.kind === "set-account" && historicalAccounts)) return;
    busy.current = true; setPending(true); setFailure(null);
    try {
      await callCodeAction(host, "changeAccounts", { ...workspace, expectedRevision: current.revision, change: edit });
    } catch (reason) {
      if (mounted.current) setFailure(`${codeOperationFailure(reason)} Nothing was retried.`);
    } finally { busy.current = false; if (mounted.current) { setPending(false); refresh(); } }
  }
  const presets = current?.accounts.presets ?? [];
  const poolName = !current ? null : manual ? "Manual" : presets.find(preset => preset.id === current.accounts.activePreset)?.name ?? "Unavailable preset";
  const observed = accounts.data?.accounts ?? [];
  const included = (disabled: AccountChoices["manualDisabled"]) => `${observed.filter(account => !accountSelectionDisabled(account, disabled)).length} of ${observed.length}`;
  const providers = [...value?.providers ?? []].sort((left, right) =>
    (FAMILY_ORDER.indexOf(left.family ?? "") + 1 || 99) - (FAMILY_ORDER.indexOf(right.family ?? "") + 1 || 99));
  const idents = providers.flatMap(provider => provider.accounts.map(entry => accountKey(entry)));
  const tabKey = tab && idents.includes(tab) ? tab : idents[0];
  // An unavailable observation is not an empty one: zero accounts is only said when the broker freshly reports zero.
  const unavailable = accounts.data?.status === "unavailable" || value?.accountsStatus === "unavailable";
  const status = unavailable ? null : error && value ? "Last check failed" : value?.observedAt ? (now - value.observedAt < 60_000 ? "Updated just now" : `Updated ${ago(now - value.observedAt)} ago`) : null;
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const element = event.target as HTMLElement;
    const line = element.closest<HTMLElement>("[data-acct]");
    if (!line) return;
    const ident = line.querySelector<HTMLElement>("[data-ident]"), toggle = line.querySelector<HTMLElement>("[data-incl]");
    const all = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-ident]")];
    const index = all.indexOf(ident!);
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : null;
    if (next !== null) {
      event.preventDefault();
      const target = all[Math.max(0, Math.min(all.length - 1, next))];
      if (target) { setTab(target.closest<HTMLElement>("[data-acct]")!.dataset.acct!); target.focus(); }
    } else if (event.key === "ArrowLeft" && element === ident && toggle) { event.preventDefault(); toggle.focus(); }
    else if (event.key === "ArrowRight" && element === toggle) { event.preventDefault(); ident?.focus(); }
    else if (event.key === " " && element === ident && toggle) { event.preventDefault(); toggle.click(); }
  }
  const accountCount = providers.reduce((total, provider) => total + provider.accounts.length, 0);
  let body;
  if (!workspace) body = <p className={`${U}usage-empty`}>Open a workspace to see usage.</p>;
  else if (configuration.data?.configuration === null) body = <div className={`${U}usage-empty`}><p>Account choices are not initialized yet.</p><Button onClick={onAccounts}>Open Accounts</Button></div>;
  // The band's own Retry stays beside every failure below, so the notices carry only the facts.
  else if (!value && error) {
    body = <Notice kind="error" details={error}>Accounts are unavailable.</Notice>;
  } else if (!value) {
    body = <Spinner label="Checking accounts…" />;
  } else if (!accountCount) {
    body = unavailable ? <Notice kind="error" details={error ?? "The account broker reported no current observation; current capacity is unknown, not zero."}>Accounts are unavailable.</Notice>
      : <div className={`${U}usage-empty`}><p>No accounts are connected yet.</p><Button onClick={onAccounts}>Sign in</Button></div>;
  } else {
    body = <div className={`${U}ugroups`} onKeyDown={keys}>{providers.filter(provider => provider.accounts.length).map(provider => {
      const rows = provider.accounts;
      const historicalOf = (entry: UsageAccount) => cached || entry.freshness === "stale";
      const groupHistorical = rows.every(historicalOf);
      const oldest = Math.min(...rows.map(entry => entry.observedAt ?? value.observedAt ?? now));
      const count = rows.filter(entry => entry.selected).length;
      const limit = rows.length > 5 && !expanded.has(provider.provider) ? 4 : rows.length;
      const word = accountWord(provider.family, provider.provider);
      return <section key={provider.provider} className={`${U}ugroup`} data-hist={groupHistorical || undefined} aria-label={`${word} accounts`}>
        <div className={`${U}ghead`}>
          <span className={`${U}mark`} data-fam={hueOf(provider.family)} aria-hidden="true" />
          <h3 className={`${U}pname`}>{word}</h3>
          <span className={`${U}count`} title={`${count} of ${rows.length} included in the pool`}>{count === rows.length ? count : `${count} of ${rows.length}`}</span>
          {groupHistorical && <State title="Historical reading; current availability unknown">{ago(now - oldest)} old</State>}
        </div>
        {rows.slice(0, limit).map(entry => {
          const key = accountKey(entry);
          const who = identityOf(entry);
          const historical = historicalOf(entry);
          const disabled = entry.account.disabled || entry.status === "credential_disabled";
          const windows = entry.windows.map(window => ({ window, state: windowState(entry, window, provider.provider), label: windowLabel(window, provider.provider) }));
          // A block on a scope no shown window meters still stops work there; it gets its own line rather than vanishing.
          const otherBlocks = entry.account.blocks.filter(block => !entry.windows.some(window => covers(block, window, provider.provider)));
          const blockedUntil = Math.max(0, ...windows.filter(({ state }) => state.word === "blocked").map(({ state }) => state.until!));
          const worst = blockedUntil ? <State tone="attention">Blocked until {hhmm(blockedUntil)}</State>
            : windows.some(({ state }) => state.word === "maxed") ? <State tone="attention">Maxed</State>
            : windows.some(({ state }) => state.word === "tight") ? <State tone="warn">Tight</State> : null;
          const editable = manual && canEdit && !historicalAccounts;
          return <div key={key} className={`${U}acct`} data-acct={key} data-excluded={!entry.selected || undefined} data-hist={historical || undefined}>
            <div className={`${U}idline`} title={manual ? undefined : `Set by the ${poolName} preset`}>
              {editable && <Check className={`${U}incl`} data-incl="" tabIndex={-1} data-action="atyrode.code.changeAccounts" checked={entry.selected}
                aria-label={`Include ${who} in the next launch`} title={entry.selected ? "Included: the next launch may use it" : "Excluded: the next launch will not use it; it stays signed in"}
                onChange={enabled => void change({ kind: "set-account", reference: entry.account.reference, enabled })} />}
              <button type="button" className={`${U}ident`} data-ident="" tabIndex={key === tabKey ? 0 : -1} onClick={onAccounts}
                title={`Open ${who} in Accounts (${entry.account.type === "api_key" ? "API key" : "OAuth"}${entry.selected ? "" : ", excluded"}${disabled ? ", credential disabled" : ""})`}>
                {who}{!entry.selected && <span className={`${U}sr`}>, excluded</span>}
              </button>
              <span className={`${U}idstate`}>
                {!entry.selected && !editable && <State>Excluded</State>}
                {disabled && <State>Disabled</State>}
                {worst}
                {historical && !groupHistorical && <State title="Historical reading; current availability unknown">{entry.observedAt === null ? "Age unknown" : `${ago(now - entry.observedAt)} old`}</State>}
              </span>
            </div>
            {entry.balance && <div className={`${U}balance`}>
              <span className={`${U}wl`}>Balance</span><span className={`${U}amount`}>{balanceText(entry.balance)}</span>
              {historical && <span className={`${U}rs`}>as of {ago(now - entry.balance.observedAt)} ago</span>}
            </div>}
            {/* A prepaid balance with only unknown windows says just the balance: unknown windows add noise, not facts. */}
            {windows.filter(({ state }) => !entry.balance || state.level !== "unknown").map(({ window, state, label }) => {
              const reset = window.resetsAt !== null && window.resetsAt > now ? window.resetsAt : null;
              return <div key={JSON.stringify([window.windowId, window.tier])} className={`${U}win`} data-level={state.level}
                title={[state.percent === null ? "Usage unknown" : `${Math.round(state.percent)}% used`, state.word === "blocked" ? `blocked until ${clock(state.until!)} local` : state.word,
                  reset !== null ? `resets ${clock(reset)} local` : "reset unknown", historical && window.observedAt !== null ? `as of ${ago(now - window.observedAt)} ago` : "",
                  window.tier && window.tier.toLowerCase() !== label ? `${window.tier} tier` : ""].filter(Boolean).join(", ")}>
                <span className={`${U}wl`}>{label}</span>
                <UsageBar percent={state.percent ?? 0} level={state.level} />
                <span className={`${U}pct`}>{state.percent === null ? "—" : `${Math.round(state.percent)}%`}</span>
                <span className={`${U}rs`}>{state.word === "blocked" ? `blocked until ${hhmm(state.until!)}` : reset !== null ? `resets in ${countdown(reset - now)}` : "reset unknown"}</span>
              </div>;
            })}
            {!entry.balance && entry.windows.length === 0 && <p className={`${U}unreported`}>No quota windows reported; capacity unknown, not zero.</p>}
            {otherBlocks.map(block => <div key={block.scope} className={`${U}block`}>
              <State tone="attention" title={`Blocked until ${clock(block.until)} local`}>Blocked until {hhmm(block.until)}</State>
              <span>{block.scope ? `${block.scope} requests` : "All requests"}</span>
            </div>)}
          </div>;
        })}
        {limit < rows.length && <Button className={`${U}show-more`} onClick={() => setExpanded(new Set([...expanded, provider.provider]))}>Show {rows.length - limit} more</Button>}
      </section>;
    })}</div>;
  }
  return <section className={className} data-zone="usage" aria-labelledby={`${U}usage-title`} aria-busy={configuration.refreshing || usage.refreshing || undefined}>
    <SectionBand id={`${U}usage-title`} title="Usage" count={accountCount ? `${accountCount} ${accountCount === 1 ? "account" : "accounts"}` : undefined} actions={<>
      {poolName !== null && <>
        <button ref={poolMenu.anchor} type="button" className={`${U}button ${U}pool`} aria-haspopup="menu" aria-expanded={poolMenu.open} onClick={poolMenu.toggle}
          aria-label={`Account pool: ${poolName}`} title="Which accounts the next launch may use">
          <span className={`${U}pool-name`}>{poolName}</span><ControlIcon kind="disclosed" size={12} />
        </button>
        <Menu menu={poolMenu} label="Account pool" align="end">
          <MenuHeader>Account pool</MenuHeader>
          <MenuItem current={manual} aside={included(current!.accounts.manualDisabled)} disabled={!canEdit} onSelect={() => void change({ kind: "activate-preset", id: null })}>Manual</MenuItem>
          {presets.map(preset => <MenuItem key={preset.id} current={current!.accounts.activePreset === preset.id} aside={included(preset.disabled)} disabled={!canEdit}
            onSelect={() => void change({ kind: "activate-preset", id: preset.id })}>{preset.name}</MenuItem>)}
          <MenuRule />
          <MenuItem onSelect={onAccounts}>Manage accounts…</MenuItem>
        </Menu>
      </>}
      {status && <span className={`${U}updated`}>{status}</span>}
      <Button icon="restart" onClick={refresh} title={withKey("Check the account broker again; provider readings may be up to five minutes old", "r")}>{error || unavailable ? "Retry" : "Refresh"}</Button>
    </>} />
    {failure && <Notice kind="error">{failure}</Notice>}
    {error && value && <Notice kind="warn" details={error}>The last check failed; showing retained readings.</Notice>}
    {body}
  </section>;
}

