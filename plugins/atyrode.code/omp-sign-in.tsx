import { useEffect, useId, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { ACCOUNTS_PLUGIN_ID, type ActionResult } from "./contract.ts";
import { ACCOUNT_REFRESH_MS, callCodeAction, codeOperationFailure, useCodeQuery } from "./machine-web.ts";

type OmpSignInProps = { host: HostServices; onContinue?: () => void; showAccounts?: boolean; active?: boolean };
export function OmpSignIn(props: OmpSignInProps) {
  const activeView = useRef(props.active !== false);
  activeView.current = props.active !== false;
  return activeView.current ? <ScopedOmpSignIn key={JSON.stringify([props.host.principal.id, props.host.containerId])} {...props} activeView={activeView} /> : null;
}

function ScopedOmpSignIn({ host, onContinue, showAccounts = true, activeView }: OmpSignInProps & { activeView: { current: boolean } }) {
  const id = useId();
  const setup = useCodeQuery(host, "readAccountSetup", {}, ACCOUNT_REFRESH_MS);
  const feed = useCodeQuery(host, "accounts", {}, ACCOUNT_REFRESH_MS);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [runtimeReview, setRuntimeReview] = useState<ActionResult<"reviewAccountRuntime"> | null>(null);
  const request = useRef(0);
  const pending = useRef(false);
  const current = useRef(host);
  current.current = host;
  useEffect(() => {
    pending.current = false;
    setBusy(false);
    setOpened(false);
    setMessage(null);
    setRuntimeReview(null);
    return () => { request.current += 1; };
  }, [host.client, host.principal.id, host.containerId, host.authoring]);
  const state = setup.data;
  const observation = feed.data;
  const writable = host.authoring !== null;
  const canContinue = observation?.status === "fresh" && observation.accounts.length > 0 && feed.error === null;
  const runtimeReviewCurrent = runtimeReview !== null && state?.revision === runtimeReview.expectedBrokerRevision &&
    state.owner?.machineId === runtimeReview.owner.machineId && state.owner.online && state.canUpdateRuntime;
  function refresh() { setup.refresh(); feed.refresh(); }
  async function perform(work: (stillCurrent: () => boolean) => Promise<void>) {
    if (pending.current || !activeView.current || !writable || !host.containerId) return;
    const issued = ++request.current;
    const containerId = host.containerId;
    const stillCurrent = () => activeView.current && request.current === issued && current.current.client === host.client &&
      current.current.principal.id === host.principal.id && current.current.containerId === containerId &&
      current.current.authoring === host.authoring;
    pending.current = true; setBusy(true); setMessage(null);
    try { await work(stillCurrent); }
    catch (reason) {
      if (stillCurrent()) setMessage(`${codeOperationFailure(reason)} Refresh setup before trying again.`);
    } finally {
      if (stillCurrent()) { pending.current = false; setBusy(false); refresh(); }
    }
  }
  async function openOmp() {
    if (!state?.canSignIn || !host.containerId) return;
    const containerId = host.containerId;
    await perform(async stillCurrent => {
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
    });
  }
  async function reviewRuntime() {
    if (!state?.canUpdateRuntime || !state.revision) return;
    await perform(async stillCurrent => {
      const reviewed = await callCodeAction(host, "reviewAccountRuntime", { expectedBrokerRevision: state.revision! });
      if (stillCurrent()) setRuntimeReview(reviewed);
    });
  }
  async function updateRuntime() {
    if (!runtimeReview || !runtimeReviewCurrent || !host.containerId) return;
    const containerId = host.containerId;
    await perform(async stillCurrent => {
      await callCodeAction(host, "promoteAccountRuntime", { containerId,
        expectedBrokerRevision: runtimeReview.expectedBrokerRevision, reviewDigest: runtimeReview.reviewDigest });
      if (stillCurrent()) { setRuntimeReview(null); setMessage("Shared runtime applied. Waiting for OMP readiness…"); }
    });
  }
  return <section className="plugin-atyrode_code plugin-atyrode_code__sign-in" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Sign in with OMP</h3>
    <p className="plugin-atyrode_code__muted">Connect your providers in OMP. The same accounts are available across this instance.</p>
    {!state && !setup.error && <p role="status">Reading sign-in availability…</p>}
    {state?.state === "starting" && <p role="status">Starting the account broker…</p>}
    {state && !state.canSignIn && !state.canUpdateRuntime && <p role="status">{state.owner
      ? state.owner.online ? `OMP sign-in is unavailable on ${state.owner.name}. Review its native setup.`
        : `${state.owner.name} is offline. Sign-in will be available when its native owner reconnects.`
      : "An instance service owner must be set up before signing in."}</p>}
    {state?.canUpdateRuntime && !runtimeReview && <p role="status">The shared account runtime needs review before sign-in. Applying the reviewed configuration can restore an unavailable broker; nothing restarts automatically.</p>}
    {host.containerId && !writable && <p role="status">This workspace is read-only. Open an editable workspace to place an OMP terminal.</p>}
    {!host.containerId && <p role="status">Open a workspace to place an OMP sign-in terminal.</p>}
    {setup.error && <p role="status">Sign-in setup could not be read. Open setup details below.</p>}
    {runtimeReview ? <>
      <p>Apply the reviewed shared account runtime on <strong>{runtimeReview.owner.name}</strong>. This affects every machine using it. The reviewed OMP store remains native-owned; no credentials are copied.</p>
      {!runtimeReviewCurrent && <p role="status">Shared runtime setup changed. Review its current revision again.</p>}
      <details className="plugin-atyrode_code__details"><summary>Exact shared runtime policy</summary><pre>{JSON.stringify(runtimeReview.policy, null, 2)}</pre></details>
      <div className="plugin-atyrode_code__account-toolbar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !host.containerId || !runtimeReviewCurrent} onClick={() => void updateRuntime()}>{busy ? "Applying…" : "Apply reviewed runtime"}</button><button type="button" disabled={busy} onClick={() => setRuntimeReview(null)}>back</button></div>
    </> : <div className="plugin-atyrode_code__account-toolbar">
      {state?.canUpdateRuntime ? <button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !host.containerId} onClick={() => void reviewRuntime()}>{busy ? "Reviewing…" : "Review shared runtime"}</button> : state?.canSignIn
        ? <button type="button" className={onContinue && canContinue ? undefined : "plugin-atyrode_code__primary-action"} disabled={busy || !writable || !host.containerId} onClick={() => void openOmp()}>{busy ? "Opening OMP…" : opened ? "Open another OMP terminal" : "Open OMP to sign in"}</button>
        : state?.owner?.online && <button type="button" onClick={() => host.navigate(`manifold://plugin/${ACCOUNTS_PLUGIN_ID}`)}>Review OMP setup</button>}
    </div>}
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
      {state?.owner && <p>Account broker · {state.owner.name} · {state.owner.online ? "online" : "offline"} · {state.state}</p>}
      {state?.state === "unconfigured" && <p>Opening OMP prepares the instance broker on its native owner, independently of the selected workspace machine.</p>}
      <p>OMP owns login, API keys, credential storage and refresh. Code reads account metadata; closing this view does not close OMP.</p>
      <div className="plugin-atyrode_code__account-toolbar"><button type="button" onClick={refresh}>Refresh accounts and setup</button><button type="button" onClick={() => host.navigate(`manifold://plugin/${ACCOUNTS_PLUGIN_ID}`)}>Open native permissions</button></div>
    </details>
  </section>;
}
