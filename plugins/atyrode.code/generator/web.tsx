import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import type { MachineSummary } from "@manifold/protocol";
import { ControlIcon, ScrollRegion } from "@manifold/ui";
import { compileCatalog } from "../../domain/catalog.ts";
import { reviewCatalog } from "../../domain/routing.ts";
import type { Selection } from "../../domain/contracts.ts";
import { CODE_PLUGIN_ID, GENERATOR_PLUGIN_ID, LAUNCHER_PANEL, type ActionResult, type LaunchPreview, type Target } from "../contract.ts";
import { callCodeAction, codeOperationFailure, useCodeQuery, useCodeTarget } from "../machine-web.ts";
import { AccountsView } from "../accounts-view.tsx";
import { UsageOverview } from "../usage-view.tsx";
import { CatalogWorkbench } from "./catalog-editor.tsx";
import { Dials, Estimates, Routing } from "./dials.tsx";
import { Onboarding } from "./onboarding.tsx";
import { OmpSignIn } from "../omp-sign-in.tsx";

type View = "profile" | "accounts" | "catalog" | "setup";
function Workbench({ host, target, machine, available }: { host: HostServices; target: Target; machine: MachineSummary | null; available: boolean }) {
  const id = useId();
  const configuration = useCodeQuery(host, "readConfiguration", target);
  const setup = useCodeQuery(host, "readSetup", target);
  const record = configuration.data?.configuration ?? null;
  const [view, setView] = useState<View>("profile");
  const [dials, setDials] = useState<{ selection: Selection; revision: number } | null>(null);
  const [preview, setPreview] = useState<LaunchPreview | null>(null);
  const [suggestion, setSuggestion] = useState<ActionResult<"suggest"> | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionPrompt, setSuggestionPrompt] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const current = useRef({ host, machine, available });
  current.current = { host, machine, available };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const active = record?.active;
  const compiled = useMemo(() => {
    if (!active) return null;
    try { return compileCatalog(active.document); } catch { return null; }
  }, [active]);
  const selection = dials?.selection ?? record?.selection;
  const localReview = useMemo(() => {
    if (!compiled || !selection) return null;
    try { return reviewCatalog(compiled, selection, Date.now()); } catch { return null; }
  }, [compiled, selection]);
  const stale = dials !== null && dials.revision !== record?.revision;
  const previewCurrent = preview !== null && preview.revision === record?.revision && dials === null;
  const shownReview = previewCurrent ? preview.review : localReview;
  const writable = host.authoring !== null;
  const canSuggest = setup.data?.services.some(service => service.serviceId === "suggest" && service.operations.some(operation => operation.operationId === "classify" && operation.ready && operation.invocable)) === true;
  const productCurrent = record?.resources !== null && record?.resources?.productSha256 === setup.data?.productSha256;
  const launchReady = productCurrent && setup.data?.execution?.operations?.[`${CODE_PLUGIN_ID}.launch`]?.ready === true;
  function refresh() { configuration.refresh(); setup.refresh(); }
  function back() { setView("profile"); refresh(); }
  async function perform(work: () => Promise<void>) {
    if (pending.current || !writable) return;
    pending.current = true; setBusy(true); setMessage(null);
    try { await work(); }
    catch (reason) { if (mounted.current) setMessage({ text: codeOperationFailure(reason), failed: true }); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); refresh(); } }
  }
  async function launch() {
    if (!record || !previewCurrent || !preview || !available) return;
    await perform(async () => {
      const prepared = await callCodeAction(host, "prepareLaunch", { ...target, expectedRevision: preview.revision, previewDigest: preview.previewDigest, prompt });
      const latest = current.current;
      if (!mounted.current || latest.host.client !== host.client || latest.host.principal.id !== host.principal.id || latest.host.authoring !== host.authoring || latest.host.containerId !== target.containerId || !latest.available || latest.machine?.id !== target.machineId || !latest.host.authoring) throw new Error("Destination changed");
      if (await latest.host.authoring.createTerminal(latest.machine, prepared.runtime) === null) throw new Error("Terminal placement refused");
      if (mounted.current) { setPreview(null); setMessage({ text: "Terminal opened. Follow the session in OMP.", failed: false }); }
    });
  }
  if (view === "accounts") return <AccountsView host={host} target={target} available={available} onDone={back} />;
  if (view === "catalog") return <CatalogWorkbench host={host} target={target} available={available} onDone={back} />;
  if (view === "setup") return <Onboarding host={host} target={target} available={available} settings onDone={back} />;
  if (!configuration.data) return <section className="plugin-atyrode_code__notice" role="status">{configuration.error ?? "Reading your Code profile…"}{configuration.error && <button type="button" onClick={refresh}>Try again</button>}</section>;
  if (!record?.active) return <Onboarding host={host} target={target} available={available} onDone={back} />;
  return <div className="plugin-atyrode_code_generator__workbench">
    <header className="plugin-atyrode_code_generator__profile-header"><h2 className="plugin-atyrode_code__section-label">profile</h2>
      <span className="plugin-atyrode_code__muted">{record?.active?.document.models.length ?? 0} models</span>
      <nav className="plugin-atyrode_code__toolbar" aria-label="Code workspace"><button type="button" disabled={busy} onClick={() => setView("accounts")}>Accounts</button><button type="button" disabled={busy} onClick={() => setView("catalog")}>Models</button><button type="button" disabled={busy} title="Runtime setup and permissions" onClick={() => setView("setup")}><ControlIcon kind="settings" size={14} />Setup</button></nav>
    </header>
      {message && <p role="status" className={message.failed ? "plugin-atyrode_code__warning" : "plugin-atyrode_code__muted"}>{message.text}</p>}
    {!writable && <p role="status" className="plugin-atyrode_code__notice">Read-only workspace. Profile changes and launch require edit access.</p>}
    {configuration.error && <p role="status">{configuration.error}</p>}
    {compiled && selection && localReview ? <Dials selection={selection} review={localReview} catalog={compiled} disabled={busy || !writable} update={value => { if (record) { setDials({ selection: value, revision: dials?.revision ?? record.revision }); setPreview(null); setSuggestion(null); setMessage(null); } }} /> : <p role="status" className="plugin-atyrode_code__warning">This profile no longer fits its catalog. Open the catalog to review its models.</p>}
    {dials && <div className="plugin-atyrode_code_generator__draft">
      <p role="status" className={stale ? "plugin-atyrode_code__warning" : "plugin-atyrode_code__muted"}>{stale ? "Shared choices changed. Your draft is kept and cannot overwrite them." : "Unsaved profile · preview updated"}</p>
      <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || stale || !localReview} onClick={() => void perform(async () => { await callCodeAction(host, "select", { ...target, expectedRevision: dials.revision, selection: dials.selection }); if (mounted.current) setDials(null); })}>{busy ? "Saving…" : "Save profile"}</button><button type="button" disabled={busy} onClick={() => setDials(null)}>discard</button></div>
      {stale && <details className="plugin-atyrode_code__details"><summary>Keep a copy of your draft</summary><pre>{JSON.stringify(dials.selection, null, 2)}</pre></details>}
    </div>}
    {canSuggest && <div className="plugin-atyrode_code_generator__suggestion">
      {!suggesting ? <button type="button" onClick={() => setSuggesting(true)}>suggest a profile from my task</button> : <>
        <label htmlFor={`${id}-suggest`}>What are you working on?</label><textarea id={`${id}-suggest`} value={suggestionPrompt} rows={2} maxLength={16384} placeholder="A quick fix, a design review, a larger refactor…" onChange={event => setSuggestionPrompt(event.target.value)} />
        <div className="plugin-atyrode_code__toolbar"><button type="button" disabled={busy || !writable || !available || !record || !suggestionPrompt.trim()} onClick={() => { if (record) void perform(async () => { const value = await callCodeAction(host, "suggest", { ...target, expectedRevision: record.revision, prompt: suggestionPrompt }); if (mounted.current) setSuggestion(value); }); }}>{busy ? "Thinking…" : "Suggest profile"}</button><button type="button" disabled={busy} onClick={() => { setSuggesting(false); setSuggestion(null); }}>close</button></div>
        <p className="plugin-atyrode_code__muted">Sends this description to the configured classifier; does not change your profile.</p>
        {suggestion && <div className="plugin-atyrode_code__notice"><p>{suggestion.changed.length ? `Suggested changes: ${suggestion.changed.join(", ")}` : "Your current profile already fits."}</p>
          <dl className="plugin-atyrode_code_generator__suggested-values">{suggestion.changed.map(key => <div key={key}><dt>{key}</dt><dd>{typeof suggestion.selection[key] === "object" ? JSON.stringify(suggestion.selection[key]) : String(suggestion.selection[key])}</dd></div>)}</dl>
          <button type="button" disabled={busy || !!dials || suggestion.revision !== record?.revision} onClick={() => { setDials({ selection: suggestion.selection, revision: suggestion.revision }); setPreview(null); setSuggesting(false); }}>Try this profile</button>
          {suggestion.revision !== record?.revision && <p role="status">Shared choices changed. Request a new suggestion.</p>}
        </div>}
      </>}
    </div>}
    <div className="plugin-atyrode_code_generator__insights">
      {compiled && shownReview && <div className="plugin-atyrode_code_generator__route-preview">
        <Estimates value={shownReview.estimates} />
        <Routing value={shownReview} catalog={compiled} local={dials !== null} />
      </div>}
      <UsageOverview host={host} target={target} />
    </div>
    <section className="plugin-atyrode_code_generator__launch" aria-label="Launch Code">
      {previewCurrent && <div className="plugin-atyrode_code_generator__launch-review"><h3>Reviewed account pool</h3>
        <ul>{Object.entries(preview.accountPool).map(([provider, accounts]) => <li key={provider}><span>{provider}</span><span>{accounts.length} account{accounts.length === 1 ? "" : "s"}</span></li>)}</ul>
        <details className="plugin-atyrode_code__details"><summary>Exact accounts and runtime review</summary><pre>{JSON.stringify({ accounts: preview.accountPool, resources: preview.resources, reviewDigest: preview.previewDigest }, null, 2)}</pre></details>
      </div>}
      <label htmlFor={`${id}-prompt`}>first prompt <span className="plugin-atyrode_code__dim">optional</span></label>
      <textarea id={`${id}-prompt`} rows={2} maxLength={16384} value={prompt} placeholder="What should this session work on?" onChange={event => setPrompt(event.target.value)} />
      <div className="plugin-atyrode_code_generator__launch-bar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !available || !launchReady || !!dials || !localReview} onClick={() => {
        if (previewCurrent) { void launch(); return; }
        if (record) void perform(async () => { const value = await callCodeAction(host, "previewLaunch", { ...target, expectedRevision: record.revision }); if (mounted.current) setPreview(value); });
      }}>{busy ? "Working…" : previewCurrent ? "Launch" : "Review launch"}</button><span className="plugin-atyrode_code__muted">{dials ? "save your profile first" : !available ? "machine offline" : !productCurrent ? "Code updated · review runtime setup" : !launchReady ? "runtime approval needed" : previewCurrent ? "opens a terminal in this workspace" : "check accounts and runtime before opening"}</span>
      </div>
      {!launchReady && <button type="button" disabled={busy} onClick={() => setView("setup")}>Review runtime setup</button>}
      {setup.error && <p role="status" className="plugin-atyrode_code__warning">{setup.error}</p>}
    </section>
    <footer className="plugin-atyrode_code_generator__footer">shared profile</footer>
  </div>;
}

function Launcher({ host }: PanelProps) {
  const id = useId();
  const { machines, machine, machineId, target, available, error, select, refresh } = useCodeTarget(host);
  return <ScrollRegion className="plugin-atyrode_code plugin-atyrode_code_generator" aria-label="Code workspace"><div className="plugin-atyrode_code_generator__body">
    <header className="plugin-atyrode_code_generator__masthead"><h1>code<span aria-hidden="true">_</span></h1>
      {host.containerId && <div className="plugin-atyrode_code_generator__machine"><span className="plugin-atyrode_code_generator__connection" data-online={available} aria-hidden="true" />
        <label htmlFor={`${id}-machine`}>workspace machine</label><select id={`${id}-machine`} value={machineId ?? ""} onChange={event => select(event.target.value || null)}><option value="">choose a machine</option>
          {machineId && !machine && <option value={machineId}>selected machine unavailable</option>}
          {machines?.map(entry => <option key={entry.id} value={entry.id}>{entry.name}{entry.revoked ? " · revoked" : entry.online ? "" : " · offline"}</option>)}
        </select>
      </div>}
    </header>
    {error && <p role="status" className="plugin-atyrode_code__warning">{error} <button type="button" onClick={refresh}>refresh</button></p>}
    {!host.containerId && <p role="status">Open or create a workspace in Manifold to use Code here.</p>}
    {host.containerId && !target && <p role="status">{machines === null ? "Reading machines…" : machines.length ? "Choose the machine for this workspace." : "Enroll a machine in Manifold to get started."}</p>}
    {host.containerId && !target && <OmpSignIn host={host} onContinue={() => { document.getElementById(`${id}-machine`)?.focus(); }} />}
    {target && <Workbench key={JSON.stringify([host.principal.id, target.containerId, target.machineId])} host={host} target={target} machine={machine} available={available} />}
  </div></ScrollRegion>;
}
export default { id: GENERATOR_PLUGIN_ID, panels: { [LAUNCHER_PANEL]: Launcher } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
