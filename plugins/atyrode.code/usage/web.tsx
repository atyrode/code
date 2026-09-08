import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import type { PublicJob } from "@manifold/protocol";
import { Cluster, ScrollRegion, Stack } from "@manifold/ui";
import { CODE_PLUGIN_ID, USAGE_PLUGIN_ID } from "../contract.ts";
import type { CodeUsage } from "../machine-contract.ts";
import { codeOperationFailure, runCodeOperation, useCodeMachines, useCodeOperation } from "../machine-web.ts";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const statuses: Record<string, string> = {
  fresh: "Fresh at observation", stale: "Stale", partial: "Partially available", failed: "Failed",
  unknown: "Unknown", missing: "Unavailable", unavailable: "Unavailable", no_accounts: "No accounts reported",
  reported: "Usage reported", no_usage: "Usage unavailable", blocked: "Blocked", credential_disabled: "Credential fault",
  selection_disabled: "Disabled for selection", succeeded: "Succeeded", ok: "Available", exhausted: "Exhausted",
  available: "Available", limited: "Limited", maxed: "Exhausted", unauthed: "No enabled authenticated account",
};
function status(value: string): string { return Object.hasOwn(statuses, value) ? statuses[value]! : "Unknown"; }
function time(value?: number): string {
  if (value === undefined || value <= 0) return "Unknown";
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : "Unknown";
}
function jobStatus(job: PublicJob): string {
  if (job.state === "exited") return job.result?.exitCode === 0 ? "Execution exited successfully; result verification is separate" : "Execution failed";
  return ({ queued: "Queued", admitted: "Admitted; not completed", "start-committed": "Starting", started: "Running", interrupted: "Interrupted", cancelled: "Cancelled", refused: "Refused" } as const)[job.state];
}

function UsageSnapshot({ value }: { value: CodeUsage }) {
  return <Stack gap="1rem">
    <section aria-label="Snapshot freshness">
      <h3>{status(value.status)}</h3>
      <p>Observed: {time(value.observedAt)} · Requested: {time(value.requestedAt)}</p>
      <p>Usage refresh: {status(value.usageRefresh)} · Account refresh: {status(value.accountRefresh)}</p>
      <p>Active preset: <strong>{value.activePreset || "Unknown"}</strong> · account revision {value.baseRevision ?? "machine defaults"}</p>
      <p className="plugin-atyrode_code_usage__muted">This is a point-in-time snapshot, not a live quota guarantee. Reset times are reported deadlines, not confirmation that quota has reset.</p>
    </section>
    {value.providers.length === 0 && <p>No provider observations are available. Quotas are unknown.</p>}
    {value.providers.map((provider) => <section key={provider.provider} className="plugin-atyrode_code_usage__card" aria-label={`${provider.provider} usage`}>
      <Stack gap="0.75rem">
        <Cluster justify="space-between"><h3>{provider.provider}</h3><span>{status(provider.status)}</span></Cluster>
        <h4>Selected pool windows</h4>
        {provider.buckets.length === 0 ? <p>No pool windows reported.</p> : <ul>{provider.buckets.map((bucket) => <li key={bucket.name}>
          <strong>{bucket.name}</strong>: {status(bucket.status)} · Reset: {time(bucket.resetsAt)}
        </li>)}</ul>}
        {provider.accounts.length === 0 && <p>No account usage reported. This does not mean unused quota.</p>}
        {provider.accounts.map((account, index) => <article key={`${account.provider}:${account.identityKey}:${index}`} className="plugin-atyrode_code_usage__account">
          <Stack gap="0.5rem">
            <h4>{account.email || account.identityKey || "Identity unavailable"}</h4>
            {account.email && account.identityKey && <p>Identity: {account.identityKey}</p>}
            <p>{account.selectable ? "Selectable" : "Not selectable"} · {account.enabled ? "Enabled" : "Disabled"} · {status(account.status)}</p>
            <p>Account snapshot: {status(account.snapshotStatus)} · {account.blocked ? `Blocked until ${time(account.blockedUntil)}` : "No block reported"}</p>
            {account.faultAt !== undefined && <p role="status">Credential fault observed: {time(account.faultAt)}. Review this account on its machine.</p>}
            {account.restrictions.length > 0 && <ul aria-label="Restrictions">{account.restrictions.map((restriction, i) => <li key={i}>{restriction.scope}: restricted until {time(restriction.until)}</li>)}</ul>}
            {account.windows.length === 0 ? <p>Account windows unavailable; utilization is unknown.</p> : <ul className="plugin-atyrode_code_usage__windows">{account.windows.map((window, i) => {
              const measured = (window.status === "fresh" || window.status === "stale") && window.observedAt > 0 && window.usedPercent >= 0 && window.usedPercent <= 100;
              return <li key={`${window.windowId}:${i}`}>
                <strong>{window.label || window.windowId || "Unnamed window"}</strong>{window.tier ? ` · ${window.tier}` : ""}
                <p>{measured ? `${window.usedPercent}% used${window.status === "stale" ? " (stale measurement)" : " at observation"}` : "Utilization unavailable"} · {status(window.status)}</p>
                <p>Reset: {time(window.resetsAt)} · Observed: {time(window.observedAt)}</p>
                <p>Window duration: {window.durationSeconds > 0 ? `${window.durationSeconds.toLocaleString()} seconds` : "Unknown"}</p>
              </li>;
            })}</ul>}
            <p>Reset credits: {account.resetCredits === undefined || account.resetCredits.available < 0 ? "Unavailable" : account.resetCredits.available.toLocaleString()}</p>
            {account.resetCredits !== undefined && <p>Credit expiry: {account.resetCredits.expiresAt.length > 0 ? account.resetCredits.expiresAt.map(time).join("; ") : "Not reported"}</p>}
          </Stack>
        </article>)}
      </Stack>
    </section>)}
    <section aria-label="Balances" className="plugin-atyrode_code_usage__card">
      <h3>Balances</h3>
      {value.balances.length === 0 ? <p>Balances unavailable.</p> : <ul>{value.balances.map((balance, index) => <li key={`${balance.provider}:${index}`}>
        <strong>{balance.provider}</strong>: {(balance.status === "fresh" || balance.status === "stale") && balance.totalBalance !== undefined && balance.totalBalance !== "" ? balance.totalBalance : "Balance unavailable"} {balance.currency || "(currency unknown)"}
        <p>{status(balance.status)} · Observed: {time(balance.observedAt)}</p>
      </li>)}</ul>}
    </section>
  </Stack>;
}

function MachineUsage({ host, machineId, available }: { host: HostServices; machineId: string | null; available: boolean }) {
  const { observation, error, refresh } = useCodeOperation(host, machineId, "usage");
  const [submitted, setSubmitted] = useState<PublicJob | null>(null);
  const submittedFeed = useCodeOperation(host, machineId, "usage", submitted?.jobId);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const observedJob = submittedFeed.observation?.latest?.jobId === submitted?.jobId ? submittedFeed.observation?.latest ?? null : null;
  const busy = submitting || observation?.state === "pending" || submittedFeed.observation?.state === "pending";
  async function requestRefresh() {
    if (machineId === null || !available || pending.current || busy) return;
    pending.current = true;
    setSubmitting(true);
    setRequestError(null);
    try {
      const job = await runCodeOperation(host, machineId, "usage", {});
      if (mounted.current) setSubmitted(job);
    } catch (reason) {
      if (mounted.current) setRequestError(codeOperationFailure(reason));
    } finally {
      pending.current = false;
      if (mounted.current) { setSubmitting(false); refresh(); submittedFeed.refresh(); }
    }
  }
  return <Stack gap="1rem">
    <Cluster gap="0.5rem">
      <button type="button" disabled={!available || busy} onClick={() => { void requestRefresh(); }}>Request usage refresh</button>
      <button type="button" disabled={machineId === null} onClick={() => { refresh(); submittedFeed.refresh(); }}>Read shared status</button>
    </Cluster>
    <p className="plugin-atyrode_code_usage__muted">Refresh submits one governed usage job on this exact machine. Reading status never starts a job.</p>
    <div role="status" aria-live="polite" aria-atomic="true">
      {submitting && <p>Requesting admission; execution has not been confirmed.</p>}
      {requestError !== null && <p>{requestError}</p>}
      {submitted !== null && <p>Requested job <code>{submitted.jobId}</code>: {jobStatus(observedJob ?? submitted)}.{observedJob === null ? " Shared status for this job has not yet been observed; this is its submission status." : ""}</p>}
      {submitted !== null && submittedFeed.error !== null && <p>The requested job’s current status is unavailable.</p>}
      {error !== null ? <p>Usage observation unavailable under the current authority.</p> : machineId === null ? <p>Select a machine to read its shared observation.</p> : observation === null ? <p>Reading shared usage observation…</p> : <>
        {observation.state === "empty" && <p>No completed usage snapshot. Request a refresh explicitly.</p>}
        {observation.state === "pending" && <p>A usage job is pending. No new snapshot is confirmed.</p>}
        {observation.state === "failed" && <p>The latest usage job failed. No new snapshot is confirmed.</p>}
        {observation.state === "unavailable" && <p>The latest usage result is unavailable or could not be verified.</p>}
        {observation.failure === "stale_preferences" && <p>Shared account choices changed after this snapshot. Request a new usage observation for the current selection.</p>}
        {observation.latest !== null && <p>Latest shared job <code>{observation.latest.jobId}</code>: {jobStatus(observation.latest)}.</p>}
      </>}
    </div>
    {error === null && observation?.snapshot != null && <>
      <p className="plugin-atyrode_code_usage__notice">{observation.state === "ready" && available ? "Last successful snapshot" : "Historical snapshot — not current; the machine or latest observation is unavailable, pending, or failed"} · job <code>{observation.snapshot.job.jobId}</code></p>
      <UsageSnapshot value={observation.snapshot.value} />
    </>}
  </Stack>;
}

function UsagePanel({ host }: PanelProps) {
  const id = useId();
  const [selection, setSelection] = useState<string | null>(null);
  const { machines, error, refresh } = useCodeMachines(host);
  const machine = machines?.find((entry) => entry.id === selection);
  const available = error === null && machine !== undefined && machine.online && machine.revoked !== true;
  return <ScrollRegion className="plugin-atyrode_code_usage" aria-label="Code usage">
    <Stack gap="1rem" className="plugin-atyrode_code_usage__body">
      <header><h2>Code usage</h2><p>Provider and account observations on one machine.</p></header>
      <Stack gap="0.5rem">
        <label htmlFor={`${id}-machine`}>Usage machine</label>
        <select id={`${id}-machine`} value={selection ?? ""} onChange={(event) => setSelection(event.target.value || null)} aria-describedby={`${id}-machine-status`}>
          <option value="">Choose a machine</option>
          {selection !== null && machine === undefined && <option value={selection}>Selected machine unavailable ({selection})</option>}
          {machines?.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.id}{entry.revoked === true ? " (revoked)" : entry.online ? " (online)" : " (offline)"}</option>)}
        </select>
        <p id={`${id}-machine-status`} role="status">{error !== null ? "Machine list unavailable; requests are disabled." : machines === null ? "Reading machines…" : selection === null ? "Choose a machine; no automatic selection or execution." : machine === undefined ? "Selected machine is no longer visible. It will not be replaced by a machine with the same name." : machine.revoked === true ? "Selected machine is revoked. Execution is unavailable." : !machine.online ? "Selected machine is offline. Only historical observations may be available." : "Selected immutable machine ID retained. Availability does not imply runtime consent."}</p>
        <button type="button" onClick={refresh}>Read machine availability</button>
      </Stack>
      <MachineUsage key={`${host.principal.id}:${selection ?? "none"}`} host={host} machineId={selection} available={available} />
      <aside className="plugin-atyrode_code_usage__notice">
        <p>Manage installation, backend bindings and consent in native Plugins. Automatic refresh uses Manifold’s native schedules for the usage operation; this panel has no separate polling daemon or scheduler.</p>
        <button type="button" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>Open Code in Plugins</button>
      </aside>
    </Stack>
  </ScrollRegion>;
}

export default { id: USAGE_PLUGIN_ID, panels: { usage: UsagePanel } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
