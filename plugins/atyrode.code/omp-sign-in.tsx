import { useEffect, useId, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { PermissionReview } from "./permission-review.tsx";
import { ACCOUNT_REFRESH_MS, codeWorkflow, canWriteCodeWorkspace, codeOperationFailure, useOmpQuery } from "./machine-web.ts";

type OmpSignInProps = { host: HostServices; onContinue?: () => void; showAccounts?: boolean; active?: boolean };
export function OmpSignIn(props: OmpSignInProps) {
  const activeView = useRef(props.active !== false);
  activeView.current = props.active !== false;
  return activeView.current ? <ScopedOmpSignIn key={JSON.stringify([props.host.principal.id, props.host.containerId])} {...props} activeView={activeView} /> : null;
}

function ScopedOmpSignIn({ host, onContinue, showAccounts = true, activeView }: OmpSignInProps & { activeView: { current: boolean } }) {
  const id = useId();
  const setup = useOmpQuery(host, "readAccountSetup", {}, ACCOUNT_REFRESH_MS);
  const feed = useOmpQuery(host, "accounts", {}, ACCOUNT_REFRESH_MS);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const request = useRef(0);
  const pending = useRef(false);
  const current = useRef(host);
  current.current = host;
  useEffect(() => {
    pending.current = false;
    setBusy(false);
    setOpened(false);
    setMessage(null);
    return () => { request.current += 1; };
  }, [host.client, host.principal.id, host.containerId, host.authoring]);
  const state = setup.data;
  const observation = feed.data;
  const writable = canWriteCodeWorkspace(host);
  const canContinue = observation?.status === "fresh" && observation.accounts.length > 0 && feed.error === null;
  function refresh() { setup.refresh(); feed.refresh(); }
  async function perform(work: (stillCurrent: () => boolean) => Promise<void>) {
    if (pending.current || !activeView.current || !writable || !host.containerId) return;
    const issued = ++request.current;
    const containerId = host.containerId;
    const stillCurrent = () => activeView.current && request.current === issued && current.current.client === host.client &&
      current.current.principal.id === host.principal.id && current.current.containerId === containerId &&
      current.current.authoring === host.authoring && canWriteCodeWorkspace(current.current);
    pending.current = true; setBusy(true); setMessage(null);
    try { await work(stillCurrent); }
    catch (reason) {
      if (stillCurrent()) setMessage(`${codeOperationFailure(reason)} Refresh setup before trying again.`);
    } finally {
      if (stillCurrent()) { pending.current = false; setBusy(false); refresh(); }
    }
  }
  async function openOmp() {
    if (!state?.canSignIn || !state.revision || !host.containerId) return;
    const containerId = host.containerId;
    await perform(async stillCurrent => {
      const prepared = await codeWorkflow(host).prepareSignIn(containerId, state.revision!);
      if (!stillCurrent()) return;
      const machines = await host.client.machines();
      if (!stillCurrent()) return;
      const owner = machines.find(machine => machine.id === prepared.machineId);
      if (!owner || !owner.online || owner.revoked === true) {
        setMessage("OMP’s broker owner is not currently available in your permitted machine list. Review native placement and access; no other machine was used.");
        return;
      }
      const terminal = await host.authoring!.createTerminal(owner, prepared.runtime);
      if (!stillCurrent()) return;
      if (terminal !== null) setOpened(true);
      setMessage(terminal === null
        ? "Terminal placement was refused. Review workspace edit access and terminal permissions."
        : "Use /login in OMP. Accounts appear here automatically; leave OMP open to add more.");
    });
  }
  return <section className="plugin-atyrode_code plugin-atyrode_code__sign-in" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Sign in with OMP</h3>
    <p className="plugin-atyrode_code__muted">Connect your providers in OMP. The same accounts are available across this instance.</p>
    {!state && !setup.error && <p role="status">Reading sign-in availability…</p>}
    {state?.brokerState === "starting" && <p role="status">Starting the account broker…</p>}
    {state && !state.canSignIn && <p role="status">{state.callerRefusal ?? (state.owner
      ? state.owner.online ? `OMP sign-in is unavailable on ${state.owner.machineId}. Review its native setup.`
        : `${state.owner.machineId} is offline. Sign-in will be available when its native owner reconnects.`
      : "An instance service owner must be set up before signing in.")}</p>}
    {state?.canReview && !state.canSignIn && <p role="status">The shared account runtime needs review before sign-in. Native rights and the shared runtime policy are separate approvals; nothing restarts automatically.</p>}
    {host.containerId && !writable && <p role="status">This workspace is read-only. Open an editable workspace to place an OMP terminal.</p>}
    {!host.containerId && <p role="status">Open a workspace to place an OMP sign-in terminal.</p>}
    {setup.error && <p role="status">Sign-in setup could not be read. Open setup details below.</p>}
    <div className="plugin-atyrode_code__account-toolbar">
      {state?.canSignIn && <button type="button" className={onContinue && canContinue ? undefined : "plugin-atyrode_code__primary-action"} disabled={busy || !writable || !host.containerId} onClick={() => void openOmp()}>{busy ? "Opening OMP…" : opened ? "Open another OMP terminal" : "Open OMP to sign in"}</button>}
      <PermissionReview host={host} intent="accounts" label={state?.canReview && !state.canSignIn ? "Review shared runtime" : "Review sign-in permissions"} onReady={refresh} />
    </div>
    {message && <p role="status">{message}</p>}
    {feed.error && state?.state === "ready" && <p role="status">Account discovery is unavailable. Open setup details below.</p>}
    {!observation && !feed.error && <p role="status">Discovering instance accounts…</p>}
    {observation && <p role="status" className={observation.status === "fresh" ? "plugin-atyrode_code__account-meta" : "plugin-atyrode_code__warning"}>{observation.status === "fresh" ? `${observation.accounts.length} account${observation.accounts.length === 1 ? "" : "s"} observed` : "Waiting for a fresh account observation before continuing."}</p>}
    {showAccounts && <div className="plugin-atyrode_code__account-list" aria-label="Instance accounts">
      {observation?.status === "fresh" && observation.accounts.length === 0 && <p>No accounts yet. Add an account in OMP; this list updates automatically.</p>}
      {observation?.accounts.map(account => <article className="plugin-atyrode_code__account-row" key={JSON.stringify([account.reference, account.credentialId])}>
        <div className="plugin-atyrode_code__account-identity"><strong>{account.reference.provider}</strong><span>{account.type === "api_key" ? `API key · slot ${account.credentialId}` : account.email ?? account.identityKey ?? "Identity unavailable"}</span></div>
        <span className="plugin-atyrode_code__account-meta">{account.type === "oauth" ? "OAuth" : "API key"} · {observation.status !== "fresh" ? "availability unknown" : account.disabled ? "credential disabled" : account.blocks.length ? "blocks reported" : "no blocks reported"}</span>
      </article>)}
    </div>}
    {onContinue && canContinue && <div className="plugin-atyrode_code__account-toolbar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={busy} onClick={onContinue}>Continue</button><span className="plugin-atyrode_code__muted">OMP stays open. You can add more accounts at any time.</span></div>}
    <details className="plugin-atyrode_code__details">
      <summary>Sign-in setup and permissions</summary>
      {state?.reason && <p>{state.reason}</p>}
      {setup.error && <p>{setup.error}</p>}
      {feed.error && <p>{feed.error}</p>}
      {state?.owner && <p>Account broker · {state.owner.machineId} · {state.owner.online ? "online" : "offline"} · {state.brokerState}</p>}
      {state?.brokerState === "unconfigured" && <p>Review the instance broker on its native owner before opening OMP, independently of the selected workspace machine.</p>}
      <p>OMP owns login, API keys, credential storage and refresh. Code reads account metadata; closing this view does not close OMP.</p>
      <div className="plugin-atyrode_code__account-toolbar"><button type="button" onClick={refresh}>Refresh accounts and setup</button></div>
    </details>
  </section>;
}
