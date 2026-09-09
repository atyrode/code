import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { HostServices } from "@manifold/plugin";
import { accountSelectionDisabled, disabledAccountReferences } from "../domain/accounts.ts";
import type { AccountChoiceChange, AccountReference } from "../domain/contracts.ts";
import { CODE_PLUGIN_ID, ApiKeyProviderSchema, type ActionInput, type Target } from "./contract.ts";
import { callCodeAction, codeOperationFailure, useCodeQuery } from "./machine-web.ts";
import { AccountEnrollment } from "./account-enrollment.tsx";

type PresetDraft = { kind: "create-preset" | "update-preset"; preset: { id: string; name: string; disabled: AccountReference[] }; revision: number };
type Confirmation = { title: string } & (
  | { action: "clearAccountBlocks" | "disableCredential"; input: ActionInput<"clearAccountBlocks">; credentialId: number }
  | { action: "enrollApiKey"; input: ActionInput<"enrollApiKey"> }
);
type AccountsViewProps = { host: HostServices; target: Target | null; available: boolean; onDone?: () => void };
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
function time(value: number | null): string { return value === null ? "Unknown" : dateFormat.format(new Date(value)); }
function referenceKey(reference: AccountReference): string {
  return JSON.stringify([reference.scope, reference.provider, reference.kind, reference.kind === "identity" ? reference.identityKey : reference.credentialId]);
}
function referenceLabel(reference: AccountReference): string {
  return `${reference.provider} · ${reference.kind === "identity" ? reference.identityKey : `key ${reference.credentialId}`} · ${reference.scope}`;
}

export function AccountsView(props: AccountsViewProps) {
  return <ScopedAccountsView key={JSON.stringify([props.host.principal.id, props.target?.containerId, props.target?.machineId])} {...props} />;
}

function ScopedAccountsView({ host, target, available, onDone }: AccountsViewProps) {
  const id = useId();
  const configuration = useCodeQuery(host, "readConfiguration", target);
  const accountFeed = useCodeQuery(host, "accounts", target);
  const setup = useCodeQuery(host, "readSetup", target);
  const keyOperations = setup.data?.services.find(service => service.serviceId === "broker")?.operations.flatMap(operation => {
    if (!operation.operationId.startsWith("enroll-key-")) return [];
    const provider = ApiKeyProviderSchema.safeParse(operation.operationId.slice("enroll-key-".length));
    return provider.success ? [{ ...operation, provider: provider.data }] : [];
  }) ?? [];
  const current = configuration.data?.configuration ?? null;
  const observation = accountFeed.data;
  const choices = current?.accounts ?? null;
  const disabled = choices ? disabledAccountReferences(choices) : [];
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [adding, setAdding] = useState(false);
  const [method, setMethod] = useState<"oauth" | "key">("oauth");
  const [keyProvider, setKeyProvider] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const canEdit = target !== null && available && current !== null && !busy;
  const canAdminister = canEdit && observation?.status === "fresh";
  const draftStale = draft !== null && draft.revision !== current?.revision;
  const observedConfirmation = confirmation && confirmation.action !== "enrollApiKey" ? observation?.accounts.find(account =>
    account.credentialId === confirmation.credentialId && referenceKey(account.reference) === referenceKey(confirmation.input.reference)) : null;
  const confirmedKeyOperation = confirmation?.action === "enrollApiKey" ? keyOperations.find(operation => operation.provider === confirmation.input.provider) : null;
  const canConfirm = confirmation?.action === "enrollApiKey"
    ? available && !busy && setup.data?.connected === true && confirmedKeyOperation?.ready === true && confirmedKeyOperation.invocable
    : canAdminister && observedConfirmation != null;
  function refresh() { configuration.refresh(); accountFeed.refresh(); setup.refresh(); }
  async function saveChoice(change: AccountChoiceChange, revision = current?.revision) {
    if (!target || !canEdit || revision === undefined || revision !== current?.revision || pending.current || confirmation) return;
    if (change.kind === "set-account" && observation?.status !== "fresh") return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      await callCodeAction(host, "changeAccounts", { ...target, expectedRevision: revision, change });
      if (mounted.current) {
        setMessage(change.kind === "create-preset" ? "Profile saved. Select it to use this account pool." : "Account choices saved.");
        if (change.kind === "create-preset" || change.kind === "update-preset") setDraft(null);
      }
    } catch (reason) {
      if (mounted.current) setMessage(`${codeOperationFailure(reason)} Nothing was retried; your draft is kept.`);
    } finally { pending.current = false; if (mounted.current) { setBusy(false); refresh(); } }
  }
  async function initialize() {
    if (!target || !available || !configuration.data || current || pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      await callCodeAction(host, "initializeConfiguration", { ...target, expectedRevision: configuration.data.revision });
      if (mounted.current) setMessage("Account choices initialized.");
    } catch (reason) { if (mounted.current) setMessage(codeOperationFailure(reason)); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); refresh(); } }
  }
  async function commit() {
    if (!confirmation || !canConfirm || pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      const result = confirmation.action === "enrollApiKey"
        ? await callCodeAction(host, "enrollApiKey", confirmation.input)
        : await callCodeAction(host, confirmation.action, confirmation.input);
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
    if (!draft || draftStale || duplicateName || !draft.preset.name.trim()) return;
    void saveChoice({ kind: draft.kind, preset: { ...draft.preset, name: draft.preset.name.trim() } }, draft.revision);
  }
  const duplicateName = draft !== null && (choices?.presets.some(preset => preset.id !== draft.preset.id && preset.name.toLowerCase() === draft.preset.name.trim().toLowerCase()) ?? false);
  const selectedPreset = choices?.presets.find(preset => preset.id === choices.activePreset);
  return <section className="plugin-atyrode_code plugin-atyrode_code__accounts" aria-labelledby={`${id}-title`}>
    <header className="plugin-atyrode_code__account-toolbar">
      <h2 id={`${id}-title`} className="plugin-atyrode_code__section-label">accounts</h2>
      <button type="button" disabled={!target} onClick={refresh}>refresh</button>
      <button type="button" aria-expanded={adding} disabled={!target || busy || confirmation !== null} onClick={() => setAdding(!adding)}>{adding ? "close sign-in" : "+ add account"}</button>
      {onDone && <button type="button" disabled={busy} onClick={onDone}>done</button>}
    </header>
    {!target && <p role="status">Choose a workspace and machine to view accounts.</p>}
    {target && !available && <p role="status">Machine unavailable. Shown accounts may be historical; actions are disabled.</p>}
    {configuration.error && <p role="status">{configuration.error}</p>}
    {accountFeed.error && <p role="status">{accountFeed.error}</p>}
    {target && configuration.data === null && !configuration.error && <p role="status">Reading account choices…</p>}
    {target && observation === null && !accountFeed.error && <p role="status">Reading native accounts…</p>}
    {configuration.data && current === null && <div className="plugin-atyrode_code__account-notice">
      <p>Set up account choices for this workspace. Existing credentials are not imported.</p>
      <button type="button" disabled={!available || busy} onClick={() => void initialize()}>Initialize choices</button>
    </div>}
    {(busy || message) && <p role="status" aria-live="polite">{busy ? "Saving…" : message}</p>}
    {observation && <p className="plugin-atyrode_code__account-meta" role="status">{observation.status === "fresh" ? `Observed ${time(observation.observedAt)}` : `${observation.status} · current availability unknown; credential actions disabled`}</p>}
    {choices && current && <>
      <div className="plugin-atyrode_code__account-toolbar">
        <label htmlFor={`${id}-profile`}>profile</label>
        <select id={`${id}-profile`} value={choices.activePreset ?? ""} disabled={!canEdit || draft !== null || confirmation !== null} onChange={event => void saveChoice({ kind: "activate-preset", id: event.target.value || null })}>
          <option value="">Manual</option>
          {choices.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
        </select>
        <button type="button" disabled={!canEdit || draft !== null || confirmation !== null} onClick={() => setDraft({ kind: "create-preset", preset: { id: crypto.randomUUID(), name: "", disabled: [...disabled] }, revision: current.revision })}>save as…</button>
        {selectedPreset && <>
          <button type="button" disabled={!canEdit || draft !== null || confirmation !== null} onClick={() => setDraft({ kind: "update-preset", preset: { ...selectedPreset, disabled: [...selectedPreset.disabled] }, revision: current.revision })}>edit</button>
          <button type="button" disabled={!canEdit || draft !== null || confirmation !== null} onClick={() => void saveChoice({ kind: "delete-preset", id: selectedPreset.id })}>delete profile</button>
        </>}
      </div>
      <div className="plugin-atyrode_code__account-list" aria-label="Account pool">
        {observation?.accounts.length === 0 && <p>No accounts reported. Add an account to begin; saved exclusions are kept.</p>}
        {observation?.accounts.map(account => {
          const excluded = accountSelectionDisabled(account, disabled);
          const status = !available || observation.status !== "fresh" ? "unknown" : account.disabled ? "credential disabled" : account.blocks.length ? "blocks reported" : "no blocks reported";
          return <article key={`${referenceKey(account.reference)}:${account.credentialId}`} className="plugin-atyrode_code__account-row">
            <label className="plugin-atyrode_code__account-identity">
              <input type="checkbox" checked={!excluded} aria-label={`Include ${account.reference.provider} ${account.email ?? `credential ${account.credentialId}`} in ${selectedPreset?.name ?? "Manual"}`} disabled={!canEdit || observation.status !== "fresh" || confirmation !== null || draft !== null} onChange={() => void saveChoice({ kind: "set-account", reference: account.reference, enabled: excluded })} />
              <strong data-provider-tone={/anthropic|claude/.test(account.reference.provider) ? "amber" : /openai|codex/.test(account.reference.provider) ? "blue" : undefined}>{account.reference.provider}</strong>
              <span>{account.email ?? (account.type === "api_key" ? `API key ${account.credentialId}` : account.identityKey ?? "Identity unavailable")}</span>
            </label>
            <span className="plugin-atyrode_code__account-meta">{excluded ? "excluded" : "included"} · {status}</span>
            <details className="plugin-atyrode_code__account-details">
              <summary>details / credential actions</summary>
              <p>{account.type === "oauth" ? "OAuth" : "API key"} · slot {account.credentialId} · scope <code>{account.reference.scope}</code></p>
              {account.blocks.map((block, index) => <p key={index}>{block.scope} · blocked until {time(block.until)}</p>)}
              <div className="plugin-atyrode_code__account-toolbar">
                <button type="button" disabled={!canAdminister || confirmation !== null || draft !== null} onClick={() => { if (target) setConfirmation({ action: "clearAccountBlocks", input: { ...target, reference: account.reference }, credentialId: account.credentialId, title: `Reset blocks for ${account.reference.provider}` }); }}>reset blocks…</button>
                <button type="button" disabled={!canAdminister || account.disabled || confirmation !== null || draft !== null} onClick={() => { if (target) setConfirmation({ action: "disableCredential", input: { ...target, reference: account.reference }, credentialId: account.credentialId, title: `Disable ${account.reference.provider} credential` }); }}>disable credential…</button>
              </div>
            </details>
          </article>;
        })}
      </div>
      <details className="plugin-atyrode_code__account-details">
        <summary>saved exclusions · {disabled.length}</summary>
        {disabled.length === 0 ? <p>No saved exclusions.</p> : <ul>{disabled.map(reference => <li key={referenceKey(reference)}>{referenceLabel(reference)}{!observation?.accounts.some(account => referenceKey(account.reference) === referenceKey(reference)) ? " · not observed; preserved" : ""}</li>)}</ul>}
        <p>Inclusion edits the selected account pool, not credentials. Deleting a profile keeps its active exclusions in Manual.</p>
      </details>
      <details className="plugin-atyrode_code__account-details">
        <summary>manage profiles</summary>
        <details>
          <summary>Manual · {choices.manualDisabled.length} exclusions</summary>
          {choices.manualDisabled.length === 0 ? <p>No saved exclusions.</p> : <ul>{choices.manualDisabled.map(reference => <li key={referenceKey(reference)}>{referenceLabel(reference)}</li>)}</ul>}
        </details>
        {choices.presets.map(preset => <div key={preset.id} className="plugin-atyrode_code__account-profile">
          <details>
            <summary>{preset.name}{choices.activePreset === preset.id ? " · active" : ""} · {preset.disabled.length} exclusions</summary>
            {preset.disabled.length === 0 ? <p>No saved exclusions.</p> : <ul>{preset.disabled.map(reference => <li key={referenceKey(reference)}>{referenceLabel(reference)}</li>)}</ul>}
          </details>
          <div className="plugin-atyrode_code__account-toolbar">
            <button type="button" disabled={!canEdit || draft !== null || confirmation !== null} onClick={() => setDraft({ kind: "update-preset", preset: { ...preset, disabled: [...preset.disabled] }, revision: current.revision })}>edit {preset.name}</button>
            <button type="button" disabled={!canEdit || draft !== null || confirmation !== null} onClick={() => void saveChoice({ kind: "delete-preset", id: preset.id })}>delete</button>
          </div>
        </div>)}
      </details>
    </>}
    {draft && <form onSubmit={savePreset} className="plugin-atyrode_code__account-editor" aria-label="Profile editor">
      <h3>{draft.kind === "create-preset" ? "Save account profile" : "Edit account profile"}</h3>
      <label htmlFor={`${id}-preset-name`}>Name</label>
      <input id={`${id}-preset-name`} value={draft.preset.name} required maxLength={120} disabled={busy || confirmation !== null} onChange={event => setDraft({ ...draft, preset: { ...draft.preset, name: event.target.value } })} />
      {duplicateName && <p role="alert">That profile name already exists.</p>}
      {draftStale && <p role="alert">Account choices changed. Review them before keeping this draft against the latest version; saving replaces this profile’s exclusions.</p>}
      <fieldset disabled={busy || confirmation !== null}>
        <legend>Excluded accounts</legend>
        {draft.preset.disabled.map(reference => <label key={referenceKey(reference)} className="plugin-atyrode_code__account-check">
          <input type="checkbox" checked onChange={() => setDraft({ ...draft, preset: { ...draft.preset, disabled: draft.preset.disabled.filter(entry => referenceKey(entry) !== referenceKey(reference)) } })} />
          {referenceLabel(reference)}{!observation?.accounts.some(account => referenceKey(account.reference) === referenceKey(reference)) ? " · not observed; preserved" : ""}
        </label>)}
        {observation?.accounts.filter(account => !draft.preset.disabled.some(reference => referenceKey(reference) === referenceKey(account.reference))).map(account => <label key={`${referenceKey(account.reference)}:${account.credentialId}`} className="plugin-atyrode_code__account-check">
          <input type="checkbox" checked={false} disabled={observation.status !== "fresh"} onChange={() => setDraft({ ...draft, preset: { ...draft.preset, disabled: [...draft.preset.disabled, account.reference] } })} />
          {referenceLabel(account.reference)}
        </label>)}
      </fieldset>
      <div className="plugin-atyrode_code__account-toolbar">
        <button type="submit" className="plugin-atyrode_code__primary-action" disabled={!canEdit || draftStale || confirmation !== null || duplicateName || !draft.preset.name.trim()}>Save profile</button>
        {draftStale && <button type="button" disabled={!canEdit || confirmation !== null} onClick={() => { if (current) setDraft({ ...draft, revision: current.revision }); }}>Keep draft with current choices</button>}
        <button type="button" disabled={busy} onClick={() => setDraft(null)}>discard</button>
      </div>
    </form>}
    {adding && <section className="plugin-atyrode_code__account-editor" aria-label="Add account">
      <div className="plugin-atyrode_code__account-toolbar" aria-label="Sign-in method">
        <button type="button" aria-pressed={method === "oauth"} disabled={busy || confirmation !== null} onClick={() => setMethod("oauth")}>provider sign-in</button>
        <button type="button" aria-pressed={method === "key"} disabled={busy || confirmation !== null} onClick={() => setMethod("key")}>native API key</button>
      </div>
      <div hidden={method !== "oauth"}><AccountEnrollment host={host} machineId={target?.machineId ?? null} available={available} onDone={() => { refresh(); setAdding(false); }} /></div>
      {method === "key" && <>
        <p>Enroll an owner-configured key. The key stays in native credential storage; nothing is pasted here.</p>
        {setup.error && <p role="status">{setup.error}</p>}
        {keyOperations.length === 0 && <p role="status">No visible API-key mapping. Configure a native credential reference in service setup first.</p>}
        <label htmlFor={`${id}-key-provider`}>Provider</label>
        <select id={`${id}-key-provider`} value={keyProvider} disabled={busy || confirmation !== null} onChange={event => setKeyProvider(event.target.value)}>
          <option value="">Choose provider</option>
          {keyOperations.map(operation => <option key={operation.operationId} value={operation.provider}>{operation.provider}{!operation.ready || !operation.invocable ? " · unavailable" : ""}</option>)}
        </select>
        {keyOperations.filter(operation => operation.provider === keyProvider).map(operation => <div key={operation.operationId}>
          {(!operation.ready || !operation.invocable) && <p role="status">{operation.reason ?? "This native enrollment operation is not ready or admitted."}</p>}
          <button type="button" disabled={!target || !available || busy || confirmation !== null || draft !== null || !setup.data?.connected || !operation.ready || !operation.invocable} onClick={() => { if (target) setConfirmation({ action: "enrollApiKey", input: { ...target, provider: operation.provider }, title: `Enroll ${operation.provider} API key` }); }}>Review enrollment…</button>
        </div>)}
        {setup.data && !setup.data.connected && <p role="status">Machine disconnected; key enrollment is unavailable.</p>}
      </>}
    </section>}
    {confirmation && <section className="plugin-atyrode_code__account-notice" aria-labelledby={`${id}-confirmation`}>
      <h3 id={`${id}-confirmation`}>{confirmation.title}?</h3>
      {confirmation.action === "enrollApiKey" ? <p>This sends the owner-configured native reference to this machine’s broker. Provider acceptance is not guaranteed; account selection will not change.</p> : <>
        <p>{referenceLabel(confirmation.input.reference)} · slot {confirmation.credentialId}</p>
        <p>{confirmation.action === "clearAccountBlocks" ? "Clear this account’s native blocks. This does not enable its selection or repair credentials." : "Disable this credential for every consumer of this native service scope, not only Code. This does not revoke the provider grant."}</p>
        {!observedConfirmation && <p role="alert">This exact account is no longer observed. Cancel and refresh accounts.</p>}
      </>}
      {!canConfirm && <p role="status">Current availability or authority is not confirmed. This action is disabled.</p>}
      <div className="plugin-atyrode_code__account-toolbar">
        <button type="button" className="plugin-atyrode_code__primary-action" disabled={!canConfirm} onClick={() => void commit()}>Confirm {confirmation.action === "enrollApiKey" ? "enrollment" : confirmation.action === "clearAccountBlocks" ? "reset" : "disable"}</button>
        <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>cancel</button>
      </div>
    </section>}
    <details className="plugin-atyrode_code__account-details">
      <summary>scope / diagnostics</summary>
      <p>Workspace <code>{target?.containerId ?? "none"}</code> · machine <code>{target?.machineId ?? "none"}</code></p>
      <p>Native scope <code>{observation?.scope ?? "unknown"}</code> · configuration revision {current?.revision ?? "unknown"}</p>
      <p>Reads do not start jobs. Saved choices do not change running sessions. OAuth re-login exclusions follow the same identity; API-key slots remain separate.</p>
      <button type="button" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>native setup / consent</button>
    </details>
  </section>;
}
