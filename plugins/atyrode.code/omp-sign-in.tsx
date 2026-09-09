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
  const [message, setMessage] = useState<string | null>(null);
  const request = useRef(0);
  const pending = useRef(false);
  const current = useRef(host);
  current.current = host;
  useEffect(() => {
    pending.current = false;
    setBusy(false);
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
      setMessage(terminal === null
        ? "Native terminal placement was refused. Check workspace edit access and terminal permissions; OMP was not opened by Code."
        : "OMP opened alongside Code. Use /login there to add accounts. You can continue after one account, or leave OMP open to add more.");
    } catch (reason) {
      if (stillCurrent()) setMessage(`${codeOperationFailure(reason)} Nothing was retried. Refresh setup before trying again.`);
    } finally {
      if (stillCurrent()) { pending.current = false; setBusy(false); refresh(); }
    }
  }
  return <section className="plugin-atyrode_code plugin-atyrode_code__sign-in" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Sign in with OMP</h3>
    <p>OMP owns account login, API keys, storage and refresh for this instance. Sign in in the real OMP terminal; Code only reads account metadata.</p>
    {state?.owner && <p className="plugin-atyrode_code__account-meta">Account broker · {state.owner.name} · {state.owner.online ? "online" : "offline"} · {state.state}</p>}
    {!state && !setup.error && <p role="status">Reading instance account setup…</p>}
    {state?.state === "unconfigured" && <p role="status">The shared broker has not been prepared. Opening OMP prepares the instance broker on its native owner, not this workspace’s selected machine.</p>}
    {state?.state === "starting" && <p role="status">The shared account broker is starting. Discovery will keep updating.</p>}
    {state?.reason && <p role="status">{state.reason}</p>}
    {state && !state.canSignIn && !state.reason && <p role="status">Sign-in is unavailable under current native placement, runtime or account administration permissions. Ask the instance owner to review native setup.</p>}
    {!writable && <p role="status">Read-only workspace. Account discovery remains available; opening OMP requires workspace edit access and account administration permission.</p>}
    {!host.containerId && <p role="status">Open an editable workspace to place the OMP terminal. Instance accounts can still be observed here.</p>}
    {setup.error && <p role="status">{setup.error}</p>}
    <div className="plugin-atyrode_code__account-toolbar">
      <button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !host.containerId || !state?.canSignIn} onClick={() => void openOmp()}>{busy ? "Opening OMP…" : "Open OMP to sign in"}</button>
      <button type="button" onClick={refresh}>refresh accounts / setup</button>
      <button type="button" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>native setup / permissions</button>
    </div>
    {message && <p role="status">{message}</p>}
    {feed.error && <p role="status">{feed.error}</p>}
    {!observation && !feed.error && <p role="status">Discovering instance accounts…</p>}
    {observation && <p role="status" className="plugin-atyrode_code__account-meta">{observation.status === "fresh" ? `${observation.accounts.length} instance account${observation.accounts.length === 1 ? "" : "s"} observed · discovery continues while OMP is open` : `${observation.status} · current accounts are not confirmed; Continue is unavailable`}</p>}
    {showAccounts && <div className="plugin-atyrode_code__account-list" aria-label="Instance accounts">
      {observation?.status === "fresh" && observation.accounts.length === 0 && <p>No accounts yet. Add an account in OMP; this list updates automatically.</p>}
      {observation?.accounts.map(account => <article className="plugin-atyrode_code__account-row" key={JSON.stringify([account.reference, account.credentialId])}>
        <div className="plugin-atyrode_code__account-identity"><strong>{account.reference.provider}</strong><span>{account.type === "api_key" ? `API key · slot ${account.credentialId}` : account.email ?? account.identityKey ?? "Identity unavailable"}</span></div>
        <span className="plugin-atyrode_code__account-meta">{account.type === "oauth" ? "OAuth" : "API key"} · {observation.status !== "fresh" ? "availability unknown" : account.disabled ? "credential disabled" : account.blocks.length ? "blocks reported" : "no blocks reported"}</span>
      </article>)}
    </div>}
    {onContinue && canContinue && <div className="plugin-atyrode_code__account-toolbar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={busy} onClick={onContinue}>Continue</button><span className="plugin-atyrode_code__muted">OMP stays open. You can add more accounts at any time.</span></div>}
  </section>;
}
