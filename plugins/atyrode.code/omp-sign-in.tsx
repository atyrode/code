import { useEffect, useId, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { CODE_PLUGIN_ID } from "./contract.ts";
import { ACCOUNT_REFRESH_MS, callCodeAction, codeOperationFailure, useCodeQuery } from "./machine-web.ts";

type OmpSignInProps = { host: HostServices; onContinue?: () => void; showAccounts?: boolean };
export function OmpSignIn(props: OmpSignInProps) {
  return <ScopedOmpSignIn key={JSON.stringify([props.host.principal.id, props.host.containerId])} {...props} />;
}

function ScopedOmpSignIn({ host, onContinue, showAccounts = true }: OmpSignInProps) {
  const id = useId();
  const setup = useCodeQuery(host, "readAccountSetup", {}, ACCOUNT_REFRESH_MS);
  const feed = useCodeQuery(host, "accounts", {}, ACCOUNT_REFRESH_MS);
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
  const writable = host.authoring !== null;
  const canContinue = observation?.status === "fresh" && observation.accounts.length > 0 && feed.error === null;
  function refresh() { setup.refresh(); feed.refresh(); }
  async function openOmp() {
    if (pending.current || !writable || !host.containerId || !state?.canSignIn) return;
    const issued = ++request.current;
    const containerId = host.containerId;
    const stillCurrent = () => request.current === issued && current.current.client === host.client &&
      current.current.principal.id === host.principal.id && current.current.containerId === containerId &&
      current.current.authoring === host.authoring;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      const prepared = await callCodeAction(host, "prepareSignIn", { containerId, expectedBrokerRevision: state.revision });
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
    } catch (reason) {
      if (stillCurrent()) setMessage(`${codeOperationFailure(reason)} Refresh setup before trying again.`);
    } finally {
      if (stillCurrent()) { pending.current = false; setBusy(false); refresh(); }
    }
  }
  return <section className="plugin-atyrode_code plugin-atyrode_code__sign-in" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Sign in with OMP</h3>
    <p className="plugin-atyrode_code__muted">Connect your providers in OMP. The same accounts are available across this instance.</p>
    {!state && !setup.error && <p role="status">Reading sign-in availability…</p>}
    {state?.state === "starting" && <p role="status">Starting the account broker…</p>}
    {state?.reason && <p role="status">{state.reason}</p>}
    {state && !state.canSignIn && !state.reason && <p role="status">Sign-in is unavailable under current native placement, runtime or account administration permissions. Ask the instance owner to review native setup.</p>}
    {!writable && <p role="status">Read-only workspace. Account discovery remains available; opening OMP requires workspace edit access and account administration permission.</p>}
    {!host.containerId && <p role="status">Open an editable workspace to place the OMP terminal. Instance accounts can still be observed here.</p>}
    {setup.error && <p role="status">{setup.error}</p>}
    <div className="plugin-atyrode_code__account-toolbar">
      <button type="button" className={onContinue && canContinue ? undefined : "plugin-atyrode_code__primary-action"} disabled={busy || !writable || !host.containerId || !state?.canSignIn} onClick={() => void openOmp()}>{busy ? "Opening OMP…" : opened ? "Open another OMP terminal" : "Open OMP to sign in"}</button>
    </div>
    {message && <p role="status">{message}</p>}
    {feed.error && <p role="status">{feed.error}</p>}
    {!observation && !feed.error && <p role="status">Discovering instance accounts…</p>}
    {observation && <p role="status" className={observation.status === "fresh" ? "plugin-atyrode_code__account-meta" : "plugin-atyrode_code__warning"}>{observation.status === "fresh" ? `${observation.accounts.length} account${observation.accounts.length === 1 ? "" : "s"} observed` : `${observation.status} · waiting for a fresh account observation${onContinue ? " before continuing" : ""}`}</p>}
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
      {state?.owner && <p>Account broker · {state.owner.name} · {state.owner.online ? "online" : "offline"} · {state.state}</p>}
      {state?.state === "unconfigured" && <p>Opening OMP prepares the instance broker on its native owner, independently of the selected workspace machine.</p>}
      <p>OMP owns login, API keys, credential storage and refresh. Code reads account metadata; closing this view does not close OMP.</p>
      <div className="plugin-atyrode_code__account-toolbar"><button type="button" onClick={refresh}>Refresh accounts and setup</button><button type="button" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>Open native permissions</button></div>
    </details>
  </section>;
}
