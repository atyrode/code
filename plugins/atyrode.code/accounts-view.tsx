import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { HostServices } from "@manifold/plugin";
import { hasCap } from "@manifold/protocol";
import { accountSelectionDisabled, disabledAccountReferences } from "../domain/accounts.ts";
import type { AccountChoiceChange, AccountRecord, AccountReference } from "../domain/contracts.ts";
import type { ActionInput, ActionResult, Target } from "./contract.ts";
import { ACCOUNT_REFRESH_MS, callCodeAction, canWriteCodeWorkspace, codeOperationFailure, useCodeQuery } from "./machine-web.ts";
import { OmpSignIn } from "./omp-sign-in.tsx";
import { PermissionReview } from "./permission-review.tsx";

type PresetDraft = { kind: "create-preset" | "update-preset"; preset: { id: string; name: string; disabled: AccountReference[] }; revision: number };
type Confirmation = { title: string; action: "clearAccountBlocks" | "disableCredential"; input: ActionInput<"clearAccountBlocks"> };
type AccountsViewProps = { host: HostServices; target: Target | null; available: boolean; onDone?: () => void };
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
function time(value: number | null): string { return value === null ? "Unknown" : dateFormat.format(new Date(value)); }
function referenceKey(reference: AccountReference): string {
  return JSON.stringify([reference.scope, reference.provider, reference.kind, reference.kind === "identity" ? reference.identityKey : reference.credentialId]);
}
function referenceLabel(reference: AccountReference): string {
  return `${reference.provider} · ${reference.kind === "identity" ? reference.identityKey : `key ${reference.credentialId}`} · ${reference.scope}`;
}
function accountLabel(account: AccountRecord): string {
  return account.email ?? `${account.type === "oauth" ? "OAuth account" : "API key"} ${account.credentialId}`;
}

/** Recovery is explicit and destination-specific; normal reads only use the container key. */
export function LegacyWorkspaceAdoption({ host, target, onAdopt }: { host: HostServices; target: Target; onAdopt: () => void }) {
  const [review, setReview] = useState<ActionResult<"readConfiguration"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function perform(work: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    try { await work(); }
    catch (reason) { if (mounted.current) setMessage(codeOperationFailure(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <details className="plugin-atyrode_code__details">
    <summary>Recover choices from an older machine-scoped workspace</summary>
    <p>Read only this destination’s legacy record, then explicitly adopt its choices for the container. No other machine is searched or merged; the original remains recovery data.</p>
    <button type="button" disabled={busy} onClick={() => void perform(async () => {
      const value = await callCodeAction(host, "readConfiguration", { containerId: host.containerId!, legacyMachineId: target.machineId });
      if (!mounted.current) return;
      setReview(value);
      if (value.configuration && value.legacyMachineId === null) onAdopt();
    })}>Read this destination’s legacy choices</button>
    {review && (review.legacyMachineId && review.configuration ? <>
      <pre>{JSON.stringify(review.configuration, null, 2)}</pre>
      <button type="button" disabled={busy || !canWriteCodeWorkspace(host)} onClick={() => void perform(async () => {
        await callCodeAction(host, "initializeConfiguration", { containerId: host.containerId!, legacyMachineId: review.legacyMachineId!, expectedRevision: review.revision });
        if (mounted.current) onAdopt();
      })}>Adopt these choices for the workspace</button>
    </> : <p role="status">{review.configuration ? "This container already has shared choices. They take precedence." : "No legacy choices are stored for this destination."}</p>)}
    {message && <p role="status">{message}</p>}
  </details>;
}

export function AccountsView(props: AccountsViewProps) {
  return <ScopedAccountsView key={JSON.stringify([props.host.principal.id, props.host.containerId])} {...props} />;
}

function ScopedAccountsView({ host, target, available, onDone }: AccountsViewProps) {
  const id = useId();
  const workspace = host.containerId ? { containerId: host.containerId } : null;
  const configuration = useCodeQuery(host, "readConfiguration", workspace);
  const accountFeed = useCodeQuery(host, "accounts", {}, ACCOUNT_REFRESH_MS);
  const current = configuration.data?.configuration ?? null;
  const observation = accountFeed.data;
  const choices = current?.accounts ?? null;
  const disabled = choices ? disabledAccountReferences(choices) : [];
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [signInExpanded, setSignInExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const editorName = useRef<HTMLInputElement>(null);
  const confirmCancel = useRef<HTMLButtonElement>(null);
  const activePool = useRef<HTMLSelectElement>(null);
  const hadDraft = useRef(false);
  const draftId = draft?.preset.id;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (draftId) editorName.current?.focus();
    else if (hadDraft.current) activePool.current?.focus();
    hadDraft.current = draftId !== undefined;
  }, [draftId]);
  useEffect(() => { if (confirmation) confirmCancel.current?.focus(); }, [confirmation]);
  useEffect(() => { setConfirmation(null); }, [target?.machineId]);
  const writable = canWriteCodeWorkspace(host);
  const canEdit = writable && workspace !== null && current !== null && !busy;
  const canAdminister = writable && hasCap(host.client.selfCaps(), "services:invoke") && target !== null && !busy && observation?.status === "fresh";
  const draftStale = draft !== null && draft.revision !== current?.revision;
  const observedConfirmation = confirmation ? observation?.accounts.find(account =>
    account.credentialId === confirmation.input.credentialId && referenceKey(account.reference) === referenceKey(confirmation.input.reference)) : null;
  const canConfirm = canAdminister && observedConfirmation != null && confirmation?.input.machineId === target?.machineId;
  function refresh() { configuration.refresh(); accountFeed.refresh(); }
  async function saveChoice(change: AccountChoiceChange, revision = current?.revision) {
    if (!workspace || !canEdit || revision === undefined || revision !== current?.revision || pending.current || confirmation) return;
    if (change.kind === "set-account" && observation?.status !== "fresh") return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      await callCodeAction(host, "changeAccounts", { ...workspace, expectedRevision: revision, change });
      if (mounted.current) {
        setMessage(change.kind === "create-preset" ? "Preset saved. Select it as the active pool when you want to use it." :
          change.kind === "update-preset" ? "Preset saved. Running sessions are unchanged." :
          change.kind === "activate-preset" ? "Active pool changed for your next launch." :
          change.kind === "delete-preset" ? "Preset deleted. Its active exclusions, if any, are kept in Manual." : "Manual inclusion saved. Running sessions are unchanged.");
        if (change.kind === "create-preset" || change.kind === "update-preset") setDraft(null);
      }
    } catch (reason) {
      if (mounted.current) setMessage(`${codeOperationFailure(reason)} Nothing was retried.${draft ? " Your draft is kept." : ""}`);
    } finally { pending.current = false; if (mounted.current) { setBusy(false); refresh(); } }
  }
  async function initialize() {
    if (!writable || !workspace || !configuration.data || current || pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      await callCodeAction(host, "initializeConfiguration", { ...workspace, expectedRevision: configuration.data.revision });
      if (mounted.current) setMessage("Account choices initialized.");
    } catch (reason) { if (mounted.current) setMessage(codeOperationFailure(reason)); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); refresh(); } }
  }
  async function commit() {
    if (!confirmation || !canConfirm || pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      const result = await callCodeAction(host, confirmation.action, confirmation.input);
      if (mounted.current) {
        setMessage(`Native action returned ${result.status} accounts. ${result.status === "fresh" ? "Review the account rows below." : "Current account availability is not confirmed."}`);
        setConfirmation(null);
      }
    } catch (reason) {
      if (mounted.current) setMessage(`${codeOperationFailure(reason)} Read current accounts before trying again; nothing was retried.`);
    } finally { pending.current = false; if (mounted.current) { setBusy(false); refresh(); } }
  }
  function savePreset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || draftStale || draftMissing || duplicateName || !draft.preset.name.trim()) return;
    void saveChoice({ kind: draft.kind, preset: { ...draft.preset, name: draft.preset.name.trim() } }, draft.revision);
  }
  const duplicateName = draft !== null && (choices?.presets.some(preset => preset.id !== draft.preset.id && preset.name.toLowerCase() === draft.preset.name.trim().toLowerCase()) ?? false);
  const selectedPreset = choices?.presets.find(preset => preset.id === choices.activePreset);
  const draftMissing = draft?.kind === "update-preset" && current !== null && !choices?.presets.some(preset => preset.id === draft.preset.id);
  const draftCurrentPreset = draft?.kind === "update-preset" ? choices?.presets.find(preset => preset.id === draft.preset.id) : null;
  const shownDisabled = draft?.preset.disabled ?? disabled;
  const poolName = draft ? draft.preset.name.trim() || "New preset" : selectedPreset?.name ?? "Manual";
  const groups = new Map<string, { account: AccountRecord; excluded: boolean }[]>();
  const observedReferences = new Set<string>();
  let includedCount = 0;
  let unblockedCount = 0;
  for (const account of observation?.accounts ?? []) {
    observedReferences.add(referenceKey(account.reference));
    const activeExcluded = accountSelectionDisabled(account, disabled);
    if (!activeExcluded) {
      includedCount++;
      if (!account.disabled && account.blocks.length === 0) unblockedCount++;
    }
    const row = { account, excluded: draft ? accountSelectionDisabled(account, shownDisabled) : activeExcluded };
    const group = groups.get(account.reference.provider);
    if (group) group.push(row);
    else groups.set(account.reference.provider, [row]);
  }
  const unobservedExclusions = shownDisabled.filter(reference => !observedReferences.has(referenceKey(reference)));
  function changeInclusion(account: AccountRecord, enabled: boolean) {
    if (!canEdit || confirmation || observation?.status !== "fresh") return;
    if (!draft) {
      if (!selectedPreset) void saveChoice({ kind: "set-account", reference: account.reference, enabled });
      return;
    }
    setDraft(value => value && {
      ...value, preset: {
        ...value.preset,
        disabled: enabled ? value.preset.disabled.filter(reference => !accountSelectionDisabled(account, [reference])) :
          value.preset.disabled.some(reference => referenceKey(reference) === referenceKey(account.reference)) ? value.preset.disabled : [...value.preset.disabled, account.reference],
      },
    });
  }
  const accountList = <div className="plugin-atyrode_code__account-list" aria-label={draft ? `Draft account pool: ${poolName}` : "Account pool"} aria-describedby={`${id}-inclusion-help`}>
    {observation?.accounts.length === 0 && <div className="plugin-atyrode_code__account-empty">
      <strong>{observation.status === "fresh" ? "No accounts reported yet" : "Account availability is unknown"}</strong>
      <p>{observation.status === "fresh" ? "Add an account in OMP below. This pool updates automatically; saved exclusions are kept." : "Refresh or review native setup below. Your saved pool has not been changed."}</p>
    </div>}
    {[...groups].map(([provider, rows]) => <section key={provider} className="plugin-atyrode_code__account-group" aria-label={`${provider} accounts`} data-provider-tone={/anthropic|claude/i.test(provider) ? "amber" : /openai|codex/i.test(provider) ? "blue" : undefined}>
      <header className="plugin-atyrode_code__account-group-heading">
        <h3>{provider}</h3>
        <span>{rows.reduce((count, row) => count + Number(!row.excluded), 0)} of {rows.length} included{observation?.status !== "fresh" ? " · last reported" : ""}</span>
      </header>
      {rows.map(({ account, excluded }) => <article key={`${referenceKey(account.reference)}:${account.credentialId}`} className="plugin-atyrode_code__account-row" data-included={!excluded}>
        <label className="plugin-atyrode_code__account-identity">
          <input type="checkbox" checked={!excluded} aria-label={`Include ${account.reference.provider} ${accountLabel(account)} in ${poolName}${draft ? " draft" : ""}`}
            disabled={!canEdit || observation?.status !== "fresh" || confirmation !== null || (!draft && selectedPreset !== undefined)}
            onChange={event => changeInclusion(account, event.target.checked)} />
          <span className="plugin-atyrode_code__account-identity-text">
            <strong>{accountLabel(account)}</strong>
            <span>{account.type === "oauth" ? "OAuth" : "API key"} · credential {account.credentialId}</span>
          </span>
        </label>
        <div className="plugin-atyrode_code__account-chips">
          <span className="plugin-atyrode_code__account-chip" data-state={excluded ? "muted" : "included"}>{excluded ? "Excluded" : "Included"}</span>
          <span className="plugin-atyrode_code__account-chip" data-state={observation?.status !== "fresh" ? "muted" : account.disabled ? "danger" : account.blocks.length ? "warning" : "positive"}>
            {observation?.status !== "fresh" ? "Availability unknown" : account.disabled ? "Credential disabled" : account.blocks.length ? "Native blocks" : "No blocks"}
          </span>
        </div>
        <details className="plugin-atyrode_code__account-details plugin-atyrode_code__account-record">
          <summary>Account details<span className="plugin-atyrode_code__account-meta"> · identity &amp; native controls</span></summary>
          <dl className="plugin-atyrode_code__account-facts">
            <dt>Provider</dt><dd><code>{account.reference.provider}</code></dd>
            <dt>Credential</dt><dd>{account.credentialId} · {account.type === "oauth" ? "OAuth" : "API key"}</dd>
            <dt>Identity</dt><dd><code>{account.identityKey ?? "None — API keys use a credential slot"}</code></dd>
            <dt>Scope</dt><dd><code>{account.reference.scope}</code></dd>
          </dl>
          {account.blocks.length > 0 && <div className="plugin-atyrode_code__account-blocks">
            <p>Native blocks{observation?.status !== "fresh" ? " from the last observation" : ""}</p>
            <ul>{account.blocks.map(block => <li key={block.scope}><code>{block.scope}</code><span>until {time(block.until)}</span></li>)}</ul>
          </div>}
          <details className="plugin-atyrode_code__account-details plugin-atyrode_code__account-credential-actions">
            <summary>Instance-wide credential actions</summary>
            <p>These act on the native broker, not just this pool. To leave an account out of Code, change its inclusion instead.</p>
            {!canAdminister && <p>Requires workspace edit access, native service permission, a selected machine and fresh account metadata.</p>}
            {draft && <p>Save or discard your preset draft before changing native credentials.</p>}
            <div className="plugin-atyrode_code__account-toolbar">
              <button type="button" disabled={!canAdminister || confirmation !== null || draft !== null} onClick={() => { if (target) setConfirmation({ action: "clearAccountBlocks", input: { ...target, reference: account.reference, credentialId: account.credentialId }, title: `Reset blocks for ${account.reference.provider} · ${accountLabel(account)}` }); }}>Reset blocks…</button>
              <button type="button" className="plugin-atyrode_code__account-danger-action" disabled={!canAdminister || account.disabled || confirmation !== null || draft !== null} onClick={() => { if (target) setConfirmation({ action: "disableCredential", input: { ...target, reference: account.reference, credentialId: account.credentialId }, title: `Disable ${account.reference.provider} · ${accountLabel(account)}` }); }}>Disable credential…</button>
            </div>
          </details>
        </details>
      </article>)}
    </section>)}
    <details className="plugin-atyrode_code__account-details plugin-atyrode_code__account-exclusions">
      <summary>{draft ? "Draft exclusions" : "Saved exclusions"} · {shownDisabled.length}{unobservedExclusions.length > 0 ? ` · ${unobservedExclusions.length} not observed` : ""}</summary>
      <p>Exclusions are kept even when an account is not reported. OAuth exclusions follow the same identity after re-login; API-key slots stay separate.</p>
      {unobservedExclusions.length > 0 && <p className="plugin-atyrode_code__account-caution">Some references no longer resolve exactly. Launch review may require attention; they are never silently removed.</p>}
      {shownDisabled.length === 0 ? <p>No saved exclusions.</p> : <ul className="plugin-atyrode_code__account-reference-list">{shownDisabled.map(reference => <li key={referenceKey(reference)}>
        <span><code>{referenceLabel(reference)}</code>{!observedReferences.has(referenceKey(reference)) && <span className="plugin-atyrode_code__account-chip" data-state="warning">Not observed · kept</span>}</span>
        {draft && <button type="button" disabled={!canEdit || confirmation !== null} aria-label={`Remove exclusion for ${referenceLabel(reference)}`} onClick={() => setDraft(value => value && { ...value, preset: { ...value.preset, disabled: value.preset.disabled.filter(entry => referenceKey(entry) !== referenceKey(reference)) } })}>Remove exclusion</button>}
      </li>)}</ul>}
    </details>
  </div>;
  return <section className="plugin-atyrode_code plugin-atyrode_code__accounts" aria-labelledby={`${id}-title`}>
    <header className="plugin-atyrode_code__account-toolbar plugin-atyrode_code__account-heading">
      <div><h2 id={`${id}-title`}>Account pools</h2><p>Choose the accounts Code can use for your next launch.</p></div>
      <div className="plugin-atyrode_code__account-toolbar">
        <button type="button" onClick={refresh}>Refresh</button>
        {onDone && <button type="button" disabled={busy || draft !== null || confirmation !== null} onClick={onDone}>Done</button>}
      </div>
    </header>
    {!workspace && <p className="plugin-atyrode_code__account-notice" role="status">Open a workspace to edit shared account choices. Instance accounts and OMP sign-in do not depend on an execution destination.</p>}
    {target && !available && <p className="plugin-atyrode_code__account-notice" role="status">Execution destination unavailable. Shared account choices, instance account discovery and OMP sign-in remain available.</p>}
    {!writable && <p className="plugin-atyrode_code__account-notice" role="status">Read-only workspace. Project choices and credential actions require edit access.</p>}
    {configuration.error && <p className="plugin-atyrode_code__account-notice" role="status">{configuration.error}</p>}
    {accountFeed.error && <p className="plugin-atyrode_code__account-notice" role="status">{accountFeed.error}</p>}
    {workspace && configuration.data === null && !configuration.error && <p role="status">Reading account choices…</p>}
    {observation === null && !accountFeed.error && <p role="status">Reading instance accounts…</p>}
    {configuration.data && current === null && <div className="plugin-atyrode_code__account-notice">
      <p>Set up account choices for this workspace. Existing credentials are not imported.</p>
      <button type="button" disabled={!writable || busy} onClick={() => void initialize()}>Initialize choices</button>
      {target && <LegacyWorkspaceAdoption key={target.machineId} host={host} target={target} onAdopt={refresh} />}
    </div>}
    <p className="plugin-atyrode_code__account-feedback" role="status" aria-live="polite" data-pending={busy}>{busy ? confirmation ? "Applying native action…" : "Saving account choices…" : message}</p>
    {choices && current && <section className="plugin-atyrode_code__account-pool" aria-label="Active account pool">
      <div className="plugin-atyrode_code__account-pool-heading">
        <div className="plugin-atyrode_code__account-pool-choice">
          <label htmlFor={`${id}-profile`}>Active pool</label>
          <select ref={activePool} id={`${id}-profile`} value={choices.activePreset ?? ""} disabled={!canEdit || draft !== null || confirmation !== null} onChange={event => void saveChoice({ kind: "activate-preset", id: event.target.value || null })}>
            <option value="">Manual</option>
            {choices.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </div>
        <div className="plugin-atyrode_code__account-toolbar">
          {selectedPreset && <button type="button" className="plugin-atyrode_code__account-outline-action" disabled={!canEdit || draft !== null || confirmation !== null} onClick={() => setDraft({ kind: "update-preset", preset: { ...selectedPreset, disabled: [...selectedPreset.disabled] }, revision: current.revision })}>Edit pool</button>}
          <button type="button" className="plugin-atyrode_code__account-outline-action" disabled={!canEdit || draft !== null || confirmation !== null} onClick={() => setDraft({ kind: "create-preset", preset: { id: crypto.randomUUID(), name: "", disabled: [...disabled] }, revision: current.revision })}>Save as preset…</button>
        </div>
      </div>
      <dl className="plugin-atyrode_code__account-pool-stats">
        <div><dt>Included</dt><dd>{observation && observation.status !== "unavailable" ? <>{includedCount}<span> / {observation.accounts.length}</span></> : "—"}</dd></div>
        <div><dt>Unblocked</dt><dd data-state={observation?.status === "fresh" ? "positive" : undefined}>{observation?.status === "fresh" ? unblockedCount : "—"}</dd></div>
        <div><dt>Excluded</dt><dd>{observation && observation.status !== "unavailable" ? observation.accounts.length - includedCount : "—"}</dd></div>
      </dl>
      <p className="plugin-atyrode_code__account-meta">{selectedPreset ? "Saved preset · use Edit pool to review changes before saving." : "Manual · inclusion changes save immediately to this workspace."} Running sessions are unchanged.</p>
    </section>}
    {observation && <div className="plugin-atyrode_code__account-observation">
      <span className="plugin-atyrode_code__account-chip" data-state={observation.status === "fresh" ? "positive" : "warning"}>{observation.status === "fresh" ? "Native observation" : observation.status === "stale" ? "Last known accounts" : "Accounts unavailable"}</span>
      <span>{observation.status === "fresh" ? `Observed ${time(observation.observedAt)}` : "Availability unknown · inclusion and credential actions paused"}</span>
    </div>}
    {(choices || draft) && <p id={`${id}-inclusion-help`} className="plugin-atyrode_code__account-meta">
      {draft ? `Editing “${poolName}” locally. Check an account to include it; nothing changes until you save.` : selectedPreset ? `Showing “${selectedPreset.name}”. Choose Edit pool to change its inclusion, or switch to Manual for immediate edits.` : "Check an account to include it in Manual. Excluding it here does not disable its credential."}
    </p>}
    {draft ? <form id={`${id}-preset-form`} onSubmit={savePreset} className="plugin-atyrode_code__account-editor" aria-label="Profile editor">
      <header className="plugin-atyrode_code__account-toolbar plugin-atyrode_code__account-editor-heading">
        <h3>{draft.kind === "create-preset" ? "New saved pool" : "Edit saved pool"}</h3>
        <span className="plugin-atyrode_code__account-chip" data-state="draft">Unsaved draft</span>
      </header>
      <div className="plugin-atyrode_code__account-name-field">
        <label htmlFor={`${id}-preset-name`}>Preset name</label>
        <input ref={editorName} id={`${id}-preset-name`} value={draft.preset.name} required maxLength={120} disabled={busy || confirmation !== null} aria-invalid={duplicateName || undefined} aria-describedby={duplicateName ? `${id}-duplicate-name` : undefined} placeholder="Give this pool a name" onChange={event => setDraft({ ...draft, preset: { ...draft.preset, name: event.target.value } })} />
      </div>
      {duplicateName && <p id={`${id}-duplicate-name`} className="plugin-atyrode_code__account-caution" role="alert">That preset name already exists. Choose another name.</p>}
      {draftStale && <div className="plugin-atyrode_code__account-notice">
        <p role="alert">{draftMissing ? "This preset was deleted elsewhere. Your draft is kept; save it as a new preset to continue." : "Shared choices changed. Your draft is kept and cannot overwrite the new revision until you review it."}</p>
        <details className="plugin-atyrode_code__account-details">
          <summary>Review current saved choices · revision {current?.revision ?? "unavailable"}</summary>
          <p>Draft started at revision {draft.revision}. Active pool is now {selectedPreset?.name ?? "Manual"}.</p>
          {draftCurrentPreset && <><p>Current preset: {draftCurrentPreset.name} · {draftCurrentPreset.disabled.length} exclusions. Saving this draft replaces its name and exclusions.</p><ul>{draftCurrentPreset.disabled.map(reference => <li key={referenceKey(reference)}><code>{referenceLabel(reference)}</code></li>)}</ul></>}
        </details>
      </div>}
      {accountList}
      <footer className="plugin-atyrode_code__account-editor-footer">
        <p>{draft.kind === "create-preset" ? "Saving creates a preset; your active pool stays unchanged." : choices?.activePreset === draft.preset.id ? "Saving updates the active pool for the next launch only." : "Saving updates this preset without switching your active pool."}</p>
        <div className="plugin-atyrode_code__account-toolbar">
          <button type="submit" className="plugin-atyrode_code__primary-action" disabled={!canEdit || draftStale || draftMissing || confirmation !== null || duplicateName || !draft.preset.name.trim()}>Save preset</button>
          {draftStale && !draftMissing && <button type="button" className="plugin-atyrode_code__account-outline-action" disabled={!canEdit || confirmation !== null} onClick={() => { if (current) setDraft({ ...draft, revision: current.revision }); }}>Keep draft with current choices</button>}
          {draftMissing && <button type="button" className="plugin-atyrode_code__account-outline-action" disabled={!canEdit || confirmation !== null} onClick={() => { if (current) setDraft({ ...draft, kind: "create-preset", preset: { ...draft.preset, id: crypto.randomUUID() }, revision: current.revision }); }}>Keep as new preset</button>}
          <button type="button" disabled={busy} onClick={() => setDraft(null)}>Discard draft</button>
        </div>
        {onDone && <p className="plugin-atyrode_code__account-meta">Save or discard your draft before leaving this editor.</p>}
      </footer>
    </form> : choices && accountList}
    {choices && current && <details className="plugin-atyrode_code__account-details plugin-atyrode_code__account-library">
      <summary>Saved presets <span className="plugin-atyrode_code__account-chip" data-state="muted">{choices.presets.length}</span></summary>
      <p>Switch pools with the Active pool selector. A preset stores exclusions, not a fixed account list; newly reported accounts are included unless excluded.</p>
      {choices.presets.length === 0 && <p>No presets yet. “Save as preset…” keeps a reusable copy of your current pool.</p>}
      <details className="plugin-atyrode_code__account-details plugin-atyrode_code__account-profile">
        <summary>Manual <span className="plugin-atyrode_code__account-meta">· {choices.manualDisabled.length} exclusions</span>{!selectedPreset && <span className="plugin-atyrode_code__account-chip" data-state="included">Active</span>}</summary>
        {choices.manualDisabled.length === 0 ? <p>No saved exclusions.</p> : <ul>{choices.manualDisabled.map(reference => <li key={referenceKey(reference)}><code>{referenceLabel(reference)}</code></li>)}</ul>}
      </details>
      {choices.presets.map(preset => <details key={preset.id} className="plugin-atyrode_code__account-details plugin-atyrode_code__account-profile">
        <summary>{preset.name} <span className="plugin-atyrode_code__account-meta">· {preset.disabled.length} exclusions</span>{choices.activePreset === preset.id && <span className="plugin-atyrode_code__account-chip" data-state="included">Active</span>}</summary>
        {preset.disabled.length === 0 ? <p>No saved exclusions.</p> : <ul>{preset.disabled.map(reference => <li key={referenceKey(reference)}><code>{referenceLabel(reference)}</code></li>)}</ul>}
        <div className="plugin-atyrode_code__account-toolbar">
          <button type="button" className="plugin-atyrode_code__account-outline-action" disabled={!canEdit || draft !== null || confirmation !== null} onClick={() => setDraft({ kind: "update-preset", preset: { ...preset, disabled: [...preset.disabled] }, revision: current.revision })}>Edit {preset.name}</button>
          <button type="button" disabled={!canEdit || choices.activePreset === preset.id || draft !== null || confirmation !== null} onClick={() => void saveChoice({ kind: "activate-preset", id: preset.id })}>Use this pool</button>
        </div>
        <details className="plugin-atyrode_code__account-details">
          <summary>Delete preset…</summary>
          <p>Delete “{preset.name}”? If active, its exclusions are kept in Manual. Credentials and running sessions are not changed.</p>
          <button type="button" className="plugin-atyrode_code__account-danger-action" disabled={!canEdit || draft !== null || confirmation !== null} onClick={() => void saveChoice({ kind: "delete-preset", id: preset.id })}>Delete {preset.name}</button>
        </details>
      </details>)}
    </details>}
    {confirmation && <section className="plugin-atyrode_code__account-notice plugin-atyrode_code__account-confirmation" aria-labelledby={`${id}-confirmation`}>
      <span className="plugin-atyrode_code__account-chip" data-state="danger">Instance-wide action</span>
      <h3 id={`${id}-confirmation`}>{confirmation.title}?</h3>
      <p><code>{referenceLabel(confirmation.input.reference)}</code> · credential {confirmation.input.credentialId}</p>
      <p>{confirmation.action === "clearAccountBlocks" ? "Clear this account’s native blocks. This does not enable its selection or repair credentials." : "Disable this credential for every consumer of this instance broker, not only Code. This does not revoke the provider grant."}</p>
      {!observedConfirmation && <p role="alert">This exact account is no longer observed. Cancel and refresh accounts.</p>}
      {!canConfirm && <p role="status">Current availability or authority is not confirmed. This action is disabled.</p>}
      <div className="plugin-atyrode_code__account-toolbar">
        <button type="button" className={confirmation.action === "disableCredential" ? "plugin-atyrode_code__account-danger-action" : "plugin-atyrode_code__account-outline-action"} disabled={!canConfirm} onClick={() => void commit()}>Confirm {confirmation.action === "clearAccountBlocks" ? "reset" : "disable"}</button>
        <button ref={confirmCancel} type="button" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</button>
      </div>
    </section>}
    {choices ? <details className="plugin-atyrode_code__account-details plugin-atyrode_code__account-connect" onToggle={event => setSignInExpanded(event.currentTarget.open)}><summary>Add or manage accounts in OMP</summary><OmpSignIn host={host} showAccounts={false} active={signInExpanded} /></details> : <OmpSignIn host={host} />}
    <details className="plugin-atyrode_code__account-details plugin-atyrode_code__account-diagnostics">
      <summary>Scope &amp; diagnostics</summary>
      <dl className="plugin-atyrode_code__account-facts">
        <dt>Workspace</dt><dd><code>{host.containerId ?? "none"}</code></dd>
        <dt>Execution destination</dt><dd><code>{target?.machineId ?? "none"}</code></dd>
        <dt>Account scope</dt><dd><code>{observation?.scope ?? "unknown"}</code></dd>
        <dt>Revision</dt><dd>{current?.revision ?? "unknown"}</dd>
        <dt>Last observed</dt><dd>{time(observation?.observedAt ?? null)}</dd>
      </dl>
      <p>Unblocked counts included, enabled credentials with no native blocks reported. It is not a quota or provider-availability guarantee. Included and excluded counts refer to reported accounts; unobserved exclusions are kept separately.</p>
      <p>Reads do not start jobs. Saved choices do not change running sessions. Account observations refresh automatically; OMP owns credential storage and sign-in.</p>
      <PermissionReview host={host} target={target} intent="accounts" label="Review account capabilities" onReady={refresh} />
    </details>
  </section>;
}
