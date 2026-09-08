import { useEffect, useId, useRef, useState, type ComponentType, type FormEvent } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import type { PublicJob } from "@manifold/protocol";
import { Cluster, ScrollRegion, Stack } from "@manifold/ui";
import { ACCOUNTS_PLUGIN_ID, CODE_PLUGIN_ID } from "../contract.ts";
import { CodeAccountChangeOperationSchema, type CodeAccounts, type CodeApplyAccountChoicesResult, type CodeRunInput } from "../machine-contract.ts";
import { applyCodeAccountChoices, codeOperationFailure, runCodeOperation, useCodeMachines, useCodeOperation } from "../machine-web.ts";

type AccountOperation = "accounts-list" | "account-import" | "account-set" | "preset-create" | "preset-update" | "preset-activate" | "preset-delete" | "account-clear-blocks";
type Request = Extract<CodeRunInput, { operation: AccountOperation }>;
type Disabled = CodeAccounts["manualDisabled"];
type Draft = { kind: "preset-create" | "preset-update"; name: string; disabled: Disabled; baseObservation: string };
type Confirmation = { request: Request; title: string; baseObservation: string };
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
function time(value?: number): string {
  if (value === undefined || value <= 0) return "Unknown";
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : "Unknown";
}
function jobStatus(job: PublicJob): string {
  if (job.state === "exited") return job.result?.exitCode === 0 ? "Execution exited successfully; result verification is separate" : "Execution failed";
  return ({ queued: "Queued", admitted: "Admitted; not completed", "start-committed": "Starting", started: "Running", interrupted: "Interrupted", cancelled: "Cancelled", refused: "Refused" } as const)[job.state];
}

function MachineAccounts({ host, machineId, available }: { host: HostServices; machineId: string | null; available: boolean }) {
  const id = useId();
  const accountFeed = useCodeOperation(host, machineId, "accounts-list");
  const [operation, setOperation] = useState<AccountOperation>("accounts-list");
  const [submitted, setSubmitted] = useState<PublicJob | null>(null);
  const resultFeed = useCodeOperation(host, machineId, operation, submitted?.jobId);
  const [applied, setApplied] = useState<CodeApplyAccountChoicesResult | null>(null);
  const [applying, setApplying] = useState(false);
  const autoApply = useRef<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const observation = accountFeed.observation;
  const snapshot = accountFeed.error === null ? observation?.snapshot ?? null : null;
  const value = snapshot?.value ?? null;
  const result = resultFeed.observation;
  const observedJob = submitted === null ? null : result?.latest?.jobId === submitted.jobId ? result.latest : result?.snapshot?.job.jobId === submitted.jobId ? result.snapshot.job : null;
  const busy = submitting || applying || result?.state === "pending" || observation?.state === "pending";
  const canEdit = available && !busy && snapshot !== null && observation?.state === "ready";
  const observationKey = snapshot === null ? null : `${snapshot.job.jobId}:${snapshot.value.preferenceRevision}`;
  const draftStale = draft !== null && draft.baseObservation !== observationKey;
  const confirmationStale = confirmation !== null && confirmation.baseObservation !== observationKey;

  async function applyProposal(job: PublicJob) {
    if (machineId === null || job.machineId !== machineId || pending.current || !job.operationId.startsWith(`${CODE_PLUGIN_ID}.`)) return;
    const operation = CodeAccountChangeOperationSchema.safeParse(job.operationId.slice(CODE_PLUGIN_ID.length + 1));
    if (!operation.success) return;
    pending.current = true;
    setApplying(true);
    setRequestError(null);
    try {
      const receipt = await applyCodeAccountChoices(host, { machineId, operation: operation.data, jobId: job.jobId });
      if (mounted.current) setApplied(receipt);
    } catch (reason) {
      if (mounted.current) setRequestError(codeOperationFailure(reason));
    } finally {
      pending.current = false;
      if (mounted.current) { setApplying(false); accountFeed.refresh(); resultFeed.refresh(); }
    }
  }

  useEffect(() => {
    const proposal = result?.snapshot;
    if (result?.state !== "ready" || proposal === null || proposal === undefined ||
      proposal.job.jobId !== autoApply.current || proposal.job.jobId !== submitted?.jobId) return;
    // Only a locally confirmed request continues automatically. Reloaded proposals need review.
    autoApply.current = null;
    void applyProposal(proposal.job);
  }, [result, submitted?.jobId, host, machineId]);

  async function submit(request: Request) {
    if (machineId === null || request.machineId !== machineId || !available || pending.current || busy) return;
    pending.current = true;
    setSubmitting(true);
    setRequestError(null);
    setSubmitted(null);
    setApplied(null);
    autoApply.current = null;
    setOperation(request.operation);
    try {
      const job = await runCodeOperation(host, request.machineId, request.operation, request.input);
      if (request.operation !== "account-import" && CodeAccountChangeOperationSchema.safeParse(request.operation).success) autoApply.current = job.jobId;
      if (mounted.current) {
        setSubmitted(job);
        setConfirmation(null);
        if (request.operation === "preset-create" || request.operation === "preset-update") setDraft(null);
      }
    } catch (reason) {
      if (mounted.current) setRequestError(codeOperationFailure(reason));
    } finally {
      pending.current = false;
      if (mounted.current) { setSubmitting(false); accountFeed.refresh(); resultFeed.refresh(); }
    }
  }
  function confirm(request: Request, title: string) {
    if (!canEdit || snapshot === null || observationKey === null) return;
    setConfirmation({ request, title, baseObservation: observationKey });
    setRequestError(null);
  }
  function reviewPreset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft === null || draftStale || machineId === null || snapshot === null || draft.name.trim() === "") return;
    confirm({ machineId, operation: draft.kind, input: {
      name: draft.name.trim(), disabled: draft.disabled,
      expectedRevision: snapshot.value.preferenceRevision, baselineJobId: snapshot.job.jobId,
    } }, `${draft.kind === "preset-create" ? "Create and activate" : "Save changes to"} preset “${draft.name.trim()}”`);
  }

  return <Stack gap="1rem">
    <Cluster gap="0.5rem">
      <button type="button" disabled={!available || busy} onClick={() => { if (machineId !== null) void submit({ machineId, operation: "accounts-list", input: {} }); }}>Request account refresh</button>
      <button type="button" disabled={machineId === null} onClick={() => { accountFeed.refresh(); resultFeed.refresh(); }}>Read shared status</button>
      <button type="button" disabled={!available || busy} onClick={() => { if (machineId !== null) void submit({ machineId, operation: "account-import", input: {} }); }}>Review import from machine</button>
    </Cluster>
    <p className="plugin-atyrode_code_accounts__muted">Code evaluates account choices on the machine; Manifold stores the verified public selection atomically. Credentials and standalone CLI state stay on the machine. The first saved change adopts the reviewed public choices, without moving or rewriting the original file.</p>
    <div role="status" aria-live="polite" aria-atomic="true">
      {submitting && <p>Requesting admission; the operation has not completed.</p>}
      {applying && <p>Applying the verified proposal to shared Manifold choices…</p>}
      {applied !== null && <p>Shared account choices saved as revision {applied.revision}. Running sessions and standalone CLI settings were not changed.</p>}
      {requestError !== null && <p>{requestError}</p>}
      {submitted !== null && <p>Requested job <code>{submitted.jobId}</code>: {jobStatus(observedJob ?? submitted)}.{observedJob === null ? " Shared status for this job has not yet been observed; this is its submission status." : ""}</p>}
      {submitted !== null && resultFeed.error !== null && <p>Requested operation observation is unavailable under the current authority.</p>}
      {submitted !== null && result?.latest?.jobId === submitted.jobId && result.state === "failed" && <p>The requested operation failed; its change is not confirmed.</p>}
      {submitted !== null && result?.latest?.jobId === submitted.jobId && result.state === "unavailable" && <p>The requested result is unavailable or could not be verified; its change is not confirmed.</p>}
      {submitted !== null && result?.snapshot?.job.jobId === submitted.jobId && <p>{result.operation === "account-clear-blocks" ? `Block clearing completed for ${result.snapshot.value.account.provider} · ${result.snapshot.value.account.identityKey}. Request account refresh to observe current restrictions.` : result.operation === "accounts-list" ? "Account snapshot verified." : "Choice evaluation completed. Shared settings change only after the atomic apply succeeds."}</p>}
      {accountFeed.error !== null ? <p>Account observation unavailable under the current authority.</p> : machineId === null ? <p>Select a machine to read its shared account observation.</p> : observation === null ? <p>Reading shared account observation…</p> : <>
        {observation.state === "empty" && <p>No completed account snapshot. Request account refresh explicitly.</p>}
        {observation.state === "pending" && <p>An account operation is pending. No new account snapshot is confirmed.</p>}
        {observation.state === "failed" && <p>The latest account operation failed. Any retained snapshot is historical.</p>}
        {observation.state === "unavailable" && <p>The latest account result is unavailable or could not be verified.</p>}
        {observation.latest !== null && <p>Latest shared account job <code>{observation.latest.jobId}</code>: {jobStatus(observation.latest)}.</p>}
      </>}
    </div>
    {result?.operation === "account-import" && result.state === "ready" && result.snapshot !== null && <section className="plugin-atyrode_code_accounts__notice" aria-labelledby={`${id}-import`}>
      <Stack gap="0.75rem">
        <h3 id={`${id}-import`}>Review machine choices before replacing shared settings</h3>
        <p>This replaces the complete shared selection and preset list with the following machine snapshot. It does not write the CLI state file or move credentials. It can recover settings whose original job consent is no longer valid.</p>
        <p>Active preset: {result.snapshot.value.activePreset}. Base Manifold revision: {result.snapshot.value.baseRevision}.</p>
        <p>Manual exclusions:</p>
        {result.snapshot.value.manualDisabled.length === 0 ? <p>None.</p> : <ul>{result.snapshot.value.manualDisabled.map((entry, index) => <li key={index}>{entry.provider} · {entry.identityKey}</li>)}</ul>}
        <h4>Named presets</h4>
        {result.snapshot.value.presets.length === 0 ? <p>None.</p> : result.snapshot.value.presets.map((preset) => <div key={preset.name}>
          <strong>{preset.name}</strong>
          {preset.disabled.length === 0 ? <p>No exclusions.</p> : <ul>{preset.disabled.map((entry, index) => <li key={index}>{entry.provider} · {entry.identityKey}</li>)}</ul>}
        </div>)}
        <button type="button" disabled={!available || busy || applied?.jobId === result.snapshot.job.jobId} onClick={() => { if (result.snapshot !== null) void applyProposal(result.snapshot.job); }}>Replace shared choices with this import</button>
      </Stack>
    </section>}
    {snapshot !== null && value !== null && <>
      <section className="plugin-atyrode_code_accounts__notice" aria-label="Account snapshot freshness">
        <p>{observation?.state === "ready" && available ? "Last successful account snapshot" : "Historical account snapshot — not current"} · job <code>{snapshot.job.jobId}</code></p>
        <p>Observed: {time(value.observedAt)} · Active preset: <strong>{value.activePreset || "Unknown"}</strong> · Manifold revision {value.preferenceRevision}</p>
        <p>Enabled means selected, not necessarily usable. Blocks and restrictions are reported separately.</p>
      </section>
      <section aria-labelledby={`${id}-identities`}>
        <Stack gap="0.75rem">
          <h3 id={`${id}-identities`}>Accounts</h3>
          {value.accounts.length === 0 && <p>No identities reported.</p>}
          {value.accounts.map((account, index) => <article key={`${account.provider}:${account.identityKey}:${index}`} className="plugin-atyrode_code_accounts__card">
            <Stack gap="0.5rem">
              <h4>{account.provider} · {account.email || account.identityKey || "Identity unavailable"}</h4>
              {account.email && account.identityKey && <p>Identity: {account.identityKey}</p>}
              <p>{account.selectable ? "Selectable" : "Not selectable"} · {account.enabled ? "Enabled" : "Disabled"} · {account.blocked ? `Blocked until ${time(account.blockedUntil)}` : "No block reported"}</p>
              {account.restrictions.length === 0 ? <p>No restrictions reported.</p> : <ul aria-label="Restrictions">{account.restrictions.map((restriction, i) => <li key={i}>{restriction.scope}: restricted until {time(restriction.until)}</li>)}</ul>}
              <Cluster gap="0.5rem">
                <button type="button" disabled={!canEdit || !account.selectable || !account.identityKey || confirmation !== null} aria-label={`${account.enabled ? "Disable" : "Enable"} ${account.provider} ${account.email || account.identityKey || "unavailable identity"}`}
                  onClick={() => { if (machineId !== null) confirm({ machineId, operation: "account-set", input: {
                    provider: account.provider, identity: account.identityKey, enabled: !account.enabled,
                    expectedRevision: value.preferenceRevision, baselineJobId: snapshot.job.jobId,
                  } }, `${account.enabled ? "Disable" : "Enable"} ${account.provider} · ${account.email || account.identityKey}`); }}>{account.enabled ? "Disable" : "Enable"}</button>
                <button type="button" disabled={!canEdit || !account.selectable || !account.identityKey || confirmation !== null} aria-label={`Clear blocks for ${account.provider} ${account.email || account.identityKey || "unavailable identity"}`}
                  onClick={() => { if (machineId !== null) confirm({ machineId, operation: "account-clear-blocks", input: { provider: account.provider, identity: account.identityKey } }, `Clear blocks for ${account.provider} · ${account.email || account.identityKey}`); }}>Clear account blocks</button>
              </Cluster>
            </Stack>
          </article>)}
        </Stack>
      </section>
      <section aria-labelledby={`${id}-presets`}>
        <Stack gap="0.75rem">
          <h3 id={`${id}-presets`}>Named presets</h3>
          <p>Presets store an exact list of disabled provider + identity pairs. Editing checkboxes only changes a draft. Creating a preset also activates it; saving an active preset changes the active selection.</p>
          {value.presets.length === 0 && <p>No named presets reported.</p>}
          <article className="plugin-atyrode_code_accounts__card">
            <h4>Manual{value.activePreset === "Manual" ? " (active)" : ""}</h4>
            <p>Saved manual exclusions: {value.manualDisabled.length === 0 ? "None" : value.manualDisabled.length}.</p>
            {value.manualDisabled.length > 0 && <ul>{value.manualDisabled.map((entry, index) => <li key={index}>{entry.provider} · {entry.identityKey}</li>)}</ul>}
            <button type="button" disabled={!canEdit || confirmation !== null || value.activePreset === "Manual"} onClick={() => {
              if (machineId !== null) confirm({ machineId, operation: "preset-activate", input: {
                name: "Manual", expectedRevision: value.preferenceRevision, baselineJobId: snapshot.job.jobId,
              } }, "Activate the saved Manual selection");
            }}>Activate Manual</button>
          </article>
          {value.presets.map((preset) => <article key={preset.name} className="plugin-atyrode_code_accounts__card">
            <Stack gap="0.5rem">
              <h4>{preset.name}{value.activePreset === preset.name ? " (active)" : ""}</h4>
              <p>Disabled identities: {preset.disabled.length === 0 ? "None" : preset.disabled.length}</p>
              {preset.disabled.length > 0 && <ul>{preset.disabled.map((entry, index) => <li key={index}>{entry.provider} · {entry.identityKey}</li>)}</ul>}
              <Cluster gap="0.5rem">
                <button type="button" disabled={!canEdit || draft !== null || confirmation !== null || observationKey === null} aria-label={`Edit preset ${preset.name}`} onClick={() => { if (observationKey !== null) setDraft({ kind: "preset-update", name: preset.name, disabled: preset.disabled.map((entry) => ({ ...entry })), baseObservation: observationKey }); }}>Edit</button>
                <button type="button" disabled={!canEdit || confirmation !== null || value.activePreset === preset.name} aria-label={`Activate preset ${preset.name}`} onClick={() => { if (machineId !== null) confirm({ machineId, operation: "preset-activate", input: {
                  name: preset.name, expectedRevision: value.preferenceRevision, baselineJobId: snapshot.job.jobId,
                } }, `Activate preset “${preset.name}”`); }}>Activate</button>
                <button type="button" disabled={!canEdit || confirmation !== null} aria-label={`Delete preset ${preset.name}`} onClick={() => { if (machineId !== null) confirm({ machineId, operation: "preset-delete", input: {
                  name: preset.name, expectedRevision: value.preferenceRevision, baselineJobId: snapshot.job.jobId,
                } }, `Delete preset “${preset.name}”`); }}>Delete…</button>
              </Cluster>
            </Stack>
          </article>)}
          <button type="button" disabled={!canEdit || draft !== null || confirmation !== null || observationKey === null} onClick={() => { if (observationKey !== null) setDraft({ kind: "preset-create", name: "", disabled: (value.presets.find((preset) => preset.name === value.activePreset)?.disabled ?? value.manualDisabled).map((entry) => ({ ...entry })), baseObservation: observationKey }); }}>Create named preset</button>
        </Stack>
      </section>
      {value.proposalsUnavailable && <p role="status">Some evaluated changes could not be read under the current authority. Native Plugins contains the full job history.</p>}
      {value.proposals.length > 0 && <section aria-labelledby={`${id}-proposals`}>
        <Stack gap="0.75rem">
          <h3 id={`${id}-proposals`}>Review evaluated changes</h3>
          <p>These recent proposals have not been applied. After a reload, review one and apply it explicitly. A competing save makes its base revision stale.</p>
          {value.proposals.map((proposal) => <article key={proposal.job.jobId} className="plugin-atyrode_code_accounts__card">
            <p>{proposal.job.operationId} · job <code>{proposal.job.jobId}</code> · base revision {proposal.value.baseRevision}</p>
            <p>Resulting preset: {proposal.value.activePreset}. Named presets: {proposal.value.presets.map((preset) => preset.name).join(", ") || "None"}.</p>
            <p>Resulting disabled identities:</p>
            <ul>{(proposal.value.activePreset === "Manual" ? proposal.value.manualDisabled : proposal.value.presets.find((preset) => preset.name === proposal.value.activePreset)?.disabled ?? []).map((entry, index) => <li key={index}>{entry.provider} · {entry.identityKey}</li>)}</ul>
            <button type="button" disabled={!canEdit || confirmation !== null} onClick={() => { void applyProposal(proposal.job); }}>Apply this evaluated change</button>
          </article>)}
        </Stack>
      </section>}
    </>}
    {draft !== null && <form onSubmit={reviewPreset} className="plugin-atyrode_code_accounts__card" aria-label="Preset draft">
      <Stack gap="0.75rem">
        <h3>{draft.kind === "preset-create" ? "New preset draft" : "Edit preset draft"}</h3>
        <label htmlFor={`${id}-preset-name`}>Preset name</label>
        <input id={`${id}-preset-name`} value={draft.name} required maxLength={120} readOnly={draft.kind === "preset-update"} disabled={busy || confirmation !== null} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        {draft.kind === "preset-create" && value?.presets.some((preset) => preset.name.toLowerCase() === draft.name.trim().toLowerCase()) && <p role="alert">That name already exists. Edit the existing preset or choose a different name.</p>}
        {draftStale && <p role="alert">The shared account snapshot changed. Discard this draft and reopen it from the latest snapshot before saving.</p>}
        <fieldset disabled={!canEdit || draftStale || confirmation !== null}>
          <legend>Disabled identities — checked means excluded</legend>
          {value?.accounts.filter((account) => account.selectable && account.identityKey !== "").map((account, index) => {
            const checked = draft.disabled.some((entry) => entry.provider === account.provider && entry.identityKey === account.identityKey);
            return <label key={`${account.provider}:${account.identityKey}:${index}`} className="plugin-atyrode_code_accounts__checkbox">
              <input type="checkbox" checked={checked} onChange={(event) => setDraft({ ...draft, disabled: event.target.checked ? [...draft.disabled, { provider: account.provider, identityKey: account.identityKey }] : draft.disabled.filter((entry) => entry.provider !== account.provider || entry.identityKey !== account.identityKey) })} />
              {account.provider} · {account.email || account.identityKey}{account.email ? ` · ${account.identityKey}` : ""}
            </label>;
          })}
          {draft.disabled.filter((entry) => !value?.accounts.some((account) => account.selectable && account.provider === entry.provider && account.identityKey === entry.identityKey)).map((entry, index) => <label key={`absent:${index}`} className="plugin-atyrode_code_accounts__checkbox">
            <input type="checkbox" checked onChange={() => setDraft({ ...draft, disabled: draft.disabled.filter((item) => item.provider !== entry.provider || item.identityKey !== entry.identityKey) })} />
            {entry.provider} · {entry.identityKey} (not currently selectable; retained in draft)
          </label>)}
        </fieldset>
        <p>No account state changes until you review and confirm save. Unlisted or unselectable disabled identities remain in the exact list unless explicitly unchecked. Code may refuse identities that are no longer selectable.</p>
        <Cluster gap="0.5rem">
          <button type="submit" disabled={!canEdit || draftStale || confirmation !== null || draft.name.trim() === "" || (draft.kind === "preset-create" && (value?.presets.some((preset) => preset.name.toLowerCase() === draft.name.trim().toLowerCase()) ?? false))}>Review save…</button>
          <button type="button" disabled={submitting} onClick={() => { setDraft(null); setConfirmation(null); }}>Discard draft</button>
        </Cluster>
      </Stack>
    </form>}
    {confirmation !== null && <section className="plugin-atyrode_code_accounts__notice" aria-labelledby={`${id}-confirmation`}>
      <Stack gap="0.75rem">
        <h3 id={`${id}-confirmation`}>{confirmation.title}?</h3>
        <p>Target machine: {confirmation.request.machineId}. Choice changes are evaluated there and saved in Manifold only if the reviewed revision is still current. Admission alone is not completion.</p>
        {(confirmation.request.operation === "preset-create" || confirmation.request.operation === "preset-update") && <>
          <p>Save this exact disabled identity list:</p>
          {confirmation.request.input.disabled.length === 0 ? <p>No disabled identities.</p> : <ul>{confirmation.request.input.disabled.map((entry, index) => <li key={index}>{entry.provider} · {entry.identityKey}</li>)}</ul>}
        </>}
        {confirmation.request.operation === "preset-delete" && <p>This deletes the named preset, not its accounts. The completed account snapshot will report the resulting active selection.</p>}
        {confirmation.request.operation === "account-set" && <p>This changes manual account selection. The completed snapshot will report which preset is active.</p>}
        {confirmation.request.operation === "account-clear-blocks" && <p>Only this account’s blocks are targeted. This does not enable the account or guarantee that its credentials work.</p>}
        {confirmationStale && <p role="alert">The account snapshot changed since this review. Cancel and review the current state before submitting.</p>}
        <Cluster gap="0.5rem">
          <button type="button" disabled={!canEdit || confirmationStale} onClick={() => { void submit(confirmation.request); }}>{confirmation.request.operation === "preset-delete" ? "Confirm delete" : confirmation.request.operation === "preset-create" || confirmation.request.operation === "preset-update" ? "Confirm save" : "Confirm request"}</button>
          <button type="button" disabled={submitting} onClick={() => setConfirmation(null)}>Cancel</button>
        </Cluster>
      </Stack>
    </section>}
  </Stack>;
}

function AccountsPanel({ host }: PanelProps) {
  const id = useId();
  const [selection, setSelection] = useState<string | null>(null);
  const { machines, error, refresh } = useCodeMachines(host);
  const machine = machines?.find((entry) => entry.id === selection);
  const available = error === null && machine !== undefined && machine.online && machine.revoked !== true;
  return <ScrollRegion className="plugin-atyrode_code_accounts" aria-label="Code accounts">
    <Stack gap="1rem" className="plugin-atyrode_code_accounts__body">
      <header><h2>Code accounts</h2><p>Shared public account choices and named presets for one machine.</p></header>
      <Stack gap="0.5rem">
        <label htmlFor={`${id}-machine`}>Accounts machine</label>
        <select id={`${id}-machine`} value={selection ?? ""} onChange={(event) => setSelection(event.target.value || null)} aria-describedby={`${id}-machine-status`}>
          <option value="">Choose a machine</option>
          {selection !== null && machine === undefined && <option value={selection}>Selected machine unavailable ({selection})</option>}
          {machines?.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.id}{entry.revoked === true ? " (revoked)" : entry.online ? " (online)" : " (offline)"}</option>)}
        </select>
        <p id={`${id}-machine-status`} role="status">{error !== null ? "Machine list unavailable; requests are disabled." : machines === null ? "Reading machines…" : selection === null ? "Choose a machine; no automatic selection or execution." : machine === undefined ? "Selected machine is no longer visible. It will not be replaced by a machine with the same name." : machine.revoked === true ? "Selected machine is revoked. Execution is unavailable." : !machine.online ? "Selected machine is offline. Only historical observations may be available." : "Selected immutable machine ID retained. Availability does not imply runtime consent."}</p>
        <button type="button" onClick={refresh}>Read machine availability</button>
      </Stack>
      <MachineAccounts key={`${host.principal.id}:${selection ?? "none"}`} host={host} machineId={selection} available={available} />
      <aside className="plugin-atyrode_code_accounts__notice">
        <p>Missing consent or backend? Open native Plugins, select Code, then its machine administration. Review this machine’s Code operation consent, installation and backend availability with its administrator.</p>
        <button type="button" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>Open Code in Plugins</button>
      </aside>
    </Stack>
  </ScrollRegion>;
}

export default { id: ACCOUNTS_PLUGIN_ID, panels: { accounts: AccountsPanel } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
