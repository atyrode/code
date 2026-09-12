import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import type { MachineSummary } from "@manifold/protocol";
import { ControlIcon, ScrollRegion } from "@manifold/ui";
import { compileCatalog } from "../../domain/catalog.ts";
import { reviewCatalog } from "../../domain/routing.ts";
import type { Selection } from "../../domain/contracts.ts";
import { familyPolicy, providerPolicy } from "../../domain/providers.ts";
import { CODE_PLUGIN_ID, GENERATOR_PLUGIN_ID, LAUNCHER_PANEL, type ActionResult, type LaunchPreview, type Target } from "../contract.ts";
import { callCodeAction, canWriteCodeWorkspace, codeOperationFailure, useCodeQuery, useCodeTarget } from "../machine-web.ts";
import { codeOperationReady } from "../operation-readiness.ts";
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
  const viewContent = useRef<HTMLDivElement>(null);
  const previousView = useRef(view);
  const current = useRef({ host, machine, available });
  current.current = { host, machine, available };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    viewContent.current?.scrollIntoView({ block: "start" });
  }, [view]);
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
  const writable = canWriteCodeWorkspace(host);
  const canSuggest = setup.data?.services.some(service => service.serviceId === "suggest" && service.operations.some(operation => operation.operationId === "classify" && operation.ready && operation.invocable)) === true;
  const productCurrent = record?.resources !== null && record?.resources?.productSha256 === setup.data?.productSha256;
  const execution = setup.data?.execution;
  const launchPins = record?.resources?.execution;
  const launchReady = productCurrent && codeOperationReady(execution, target.machineId, "launch") &&
    launchPins?.installationRevision === execution?.installation?.revision && launchPins?.artifactSha256 === execution?.installation?.artifactSha256 &&
    launchPins?.operations[`${CODE_PLUGIN_ID}.launch`] === execution?.operations?.[`${CODE_PLUGIN_ID}.launch`]?.resourceBindingDigest;
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
    if (!record || !previewCurrent || !preview || !available || !launchReady) return;
    await perform(async () => {
      // A refused attempt must return to explicit review, even if the shared profile
      // revision did not change (for example, the account pool changed independently).
      setPreview(null);
      const prepared = await callCodeAction(host, "prepareLaunch", { ...target, expectedRevision: preview.revision, previewDigest: preview.previewDigest, prompt });
      const latest = current.current;
      if (!mounted.current || latest.host.client !== host.client || latest.host.principal.id !== host.principal.id || latest.host.authoring !== host.authoring || latest.host.containerId !== target.containerId || !latest.available || latest.machine?.id !== target.machineId || !latest.host.authoring || !canWriteCodeWorkspace(latest.host)) throw new Error("Destination changed");
      if (await latest.host.authoring.createTerminal(latest.machine, prepared.runtime) === null) throw new Error("Terminal placement refused");
      if (mounted.current) { setPreview(null); setMessage({ text: "Terminal opened. Follow the session in OMP.", failed: false }); }
    });
  }
  const profileState = stale ? "conflict" : dials ? "local" : "saved";
  const stateLabel = stale ? "Shared profile changed" : dials ? "Local changes" : "Saved profile";
  const navigation = <header className="plugin-atyrode_code_generator__workspace-nav">
    <nav aria-label="Code workspace">
      <button type="button" aria-current={view === "profile" ? "page" : undefined} disabled={busy} onClick={back}>Profile</button>
      <button type="button" aria-current={view === "accounts" ? "page" : undefined} disabled={busy} onClick={() => { setView("accounts"); refresh(); }}>Accounts</button>
      <button type="button" aria-current={view === "catalog" ? "page" : undefined} disabled={busy} onClick={() => { setView("catalog"); refresh(); }}>Models</button>
      <button type="button" aria-current={view === "setup" ? "page" : undefined} disabled={busy} onClick={() => { setView("setup"); refresh(); }}><ControlIcon kind="settings" size={14} />Setup</button>
    </nav>
    {record?.active && <span className="plugin-atyrode_code_generator__profile-state" data-state={profileState} role="status"><span aria-hidden="true" />{stateLabel}</span>}
  </header>;
  if (view !== "profile") return <div className="plugin-atyrode_code_generator__workbench">
    {navigation}
    <div ref={viewContent} className="plugin-atyrode_code_generator__view" key={view}>
      {view === "accounts" ? <AccountsView host={host} target={target} available={available} onDone={back} />
        : view === "catalog" ? <CatalogWorkbench host={host} target={target} available={available} onDone={back} />
          : <Onboarding host={host} target={target} available={available} settings onDone={back} />}
    </div>
  </div>;
  if (!configuration.data) return <div className="plugin-atyrode_code_generator__workbench">{navigation}<section className="plugin-atyrode_code__notice" role="status">{configuration.error ?? "Reading your Code profile…"}{configuration.error && <button type="button" onClick={refresh}>Try again</button>}</section></div>;
  if (!record?.active) return <div className="plugin-atyrode_code_generator__workbench">{navigation}<div ref={viewContent} className="plugin-atyrode_code_generator__view"><Onboarding host={host} target={target} available={available} onDone={back} /></div></div>;
  const lead = shownReview?.routes.find(route => route.role === "default");
  const leadModel = lead && compiled?.model(lead.lead.key);
  const laneLabel = selection?.lane.kind === "mixed" ? "Mixed providers" : selection?.lane.kind === "provider" ? `${familyPolicy(selection.lane.family)?.label ?? selection.lane.family} ${selection.lane.blend}` : null;
  return <div className="plugin-atyrode_code_generator__workbench">
    {navigation}
    <div ref={viewContent} className="plugin-atyrode_code_generator__view">
      <section className="plugin-atyrode_code_generator__session-summary" aria-label="Session profile summary">
        <div className="plugin-atyrode_code_generator__session-identity">
          <h2 className="plugin-atyrode_code__section-label">Next session</h2>
          <p className="plugin-atyrode_code_generator__session-model">{leadModel?.key ?? "Review your model catalog"}{lead && <span>{lead.lead.thinking} thinking</span>}</p>
          <p className="plugin-atyrode_code_generator__session-context">{laneLabel && <span>{laneLabel}</span>}<span>{record.active.document.models.length} catalog models</span><span>Revision {record.revision}</span></p>
        </div>
        <div className="plugin-atyrode_code_generator__session-readiness" data-reviewed={previewCurrent}>
          <span>{stale ? "Draft preserved" : dials ? "Previewing your changes" : previewCurrent ? "Launch reviewed" : "Review before launch"}</span>
          <p>{stale ? "Your local choices are safe. Discard them to use the shared profile." : dials ? "Changes stay local until you save. Routing updates as you adjust." : previewCurrent ? "Check the account pool below, then explicitly launch." : "Adjust the profile, review accounts and runtime, then open OMP."}</p>
        </div>
      </section>
      {message && <p role="status" className={`plugin-atyrode_code_generator__feedback ${message.failed ? "plugin-atyrode_code__warning" : "plugin-atyrode_code__muted"}`} data-failed={message.failed}>{message.text}</p>}
      {!writable && <p role="status" className="plugin-atyrode_code__notice">Read-only workspace. Profile changes and launch require edit access.</p>}
      {configuration.error && <p role="status" className="plugin-atyrode_code__warning">{configuration.error}</p>}
      <div className="plugin-atyrode_code_generator__profile-grid">
        <section className="plugin-atyrode_code_generator__controls" aria-labelledby={`${id}-profile`}>
          <header className="plugin-atyrode_code_generator__profile-header"><h2 id={`${id}-profile`} className="plugin-atyrode_code__section-label">Shape the session</h2><span>Choose, drag, or use arrow keys</span></header>
          {compiled && selection && localReview ? <Dials selection={selection} review={localReview} catalog={compiled} disabled={busy || !writable} update={value => { if (record) { setDials({ selection: value, revision: dials?.revision ?? record.revision }); setPreview(null); setSuggestion(null); setMessage(null); } }} /> : <p role="status" className="plugin-atyrode_code__warning">This profile no longer fits its catalog. Open Models to review its catalog.</p>}
          {dials && <div className="plugin-atyrode_code_generator__draft" data-stale={stale}>
            <div><strong>{stale ? "Shared changes need your attention" : "Local profile changes"}</strong><p role="status">{stale ? `Based on revision ${dials.revision}; shared profile is now revision ${record.revision}. Your draft cannot overwrite it.` : "Save to make these choices available to the workspace."}</p></div>
            <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || stale || !localReview} onClick={() => void perform(async () => { await callCodeAction(host, "select", { ...target, expectedRevision: dials.revision, selection: dials.selection }); if (mounted.current) { setDials(null); setMessage({ text: "Profile saved. Review the launch when you're ready.", failed: false }); } })}>{busy ? "Working…" : "Save profile"}</button><button type="button" disabled={busy} onClick={() => { setDials(null); setPreview(null); }}>Discard changes</button></div>
            {stale && <details className="plugin-atyrode_code__details"><summary>Keep a copy of your draft</summary><pre>{JSON.stringify(dials.selection, null, 2)}</pre></details>}
          </div>}
          {canSuggest && <div className="plugin-atyrode_code_generator__suggestion">
            {!suggesting ? <button type="button" aria-expanded={false} onClick={() => setSuggesting(true)}>Suggest a profile from my task <span aria-hidden="true">→</span></button> : <>
              <label htmlFor={`${id}-suggest`}>What are you working on?</label><textarea id={`${id}-suggest`} value={suggestionPrompt} rows={2} maxLength={16384} placeholder="A quick fix, a design review, a larger refactor…" onChange={event => setSuggestionPrompt(event.target.value)} />
              <div className="plugin-atyrode_code__toolbar"><button type="button" disabled={busy || !writable || !available || !record || !suggestionPrompt.trim()} onClick={() => { if (record) void perform(async () => { const value = await callCodeAction(host, "suggest", { ...target, expectedRevision: record.revision, prompt: suggestionPrompt }); if (mounted.current) setSuggestion(value); }); }}>{busy ? "Working…" : "Suggest profile"}</button><button type="button" disabled={busy} onClick={() => { setSuggesting(false); setSuggestion(null); }}>Close suggestion</button></div>
              <p className="plugin-atyrode_code__muted">Sends this description to the configured classifier; does not change your profile.</p>
              {suggestion && <div className="plugin-atyrode_code__notice"><p>{suggestion.changed.length ? `Suggested changes: ${suggestion.changed.join(", ")}` : "Your current profile already fits."}</p>
                <dl className="plugin-atyrode_code_generator__suggested-values">{suggestion.changed.map(key => <div key={key}><dt>{key}</dt><dd>{typeof suggestion.selection[key] === "object" ? JSON.stringify(suggestion.selection[key]) : String(suggestion.selection[key])}</dd></div>)}</dl>
                <button type="button" disabled={busy || !!dials || suggestion.revision !== record?.revision} onClick={() => { setDials({ selection: suggestion.selection, revision: suggestion.revision }); setPreview(null); setSuggesting(false); }}>Try this profile</button>
                {!!dials && <p>Save or discard your local changes before trying a suggestion.</p>}
                {suggestion.revision !== record?.revision && <p role="status">Shared choices changed. Request a new suggestion.</p>}
              </div>}
            </>}
          </div>}
          {shownReview && <Estimates value={shownReview.estimates} />}
        </section>
        <section className="plugin-atyrode_code_generator__launch" aria-labelledby={`${id}-launch-heading`} data-reviewed={previewCurrent}>
          <div className="plugin-atyrode_code_generator__launch-bar">
            <div><h2 id={`${id}-launch-heading`} className="plugin-atyrode_code__section-label">Start a session</h2><p>{previewCurrent ? "2 / 2 · Confirm and open OMP" : "1 / 2 · Review before opening"}</p></div>
            <button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !available || !launchReady || !!dials || !localReview} aria-describedby={`${id}-launch-status`} onClick={() => {
              if (previewCurrent) { void launch(); return; }
              if (record) void perform(async () => { const value = await callCodeAction(host, "previewLaunch", { ...target, expectedRevision: record.revision }); if (mounted.current) setPreview(value); });
            }}>{busy ? "Working…" : previewCurrent ? "Launch OMP" : "Review launch"}<span aria-hidden="true">{previewCurrent ? "↗" : "→"}</span></button>
          </div>
          <p id={`${id}-launch-status`} className="plugin-atyrode_code_generator__launch-status">{!writable ? "Edit access is required to review and launch." : dials ? "Save your profile first. Local changes are not launched." : !available ? "The workspace machine is offline." : !productCurrent ? "Code updated. Review the runtime setup." : !launchReady ? "Runtime approval is needed before launch." : !localReview ? "Resolve the profile's model catalog before launch." : previewCurrent ? "Reviewed against this saved revision. Opens a terminal in this workspace." : "Checks the current account pool and pinned runtime. No terminal opens yet."}</p>
          {previewCurrent && <div className="plugin-atyrode_code_generator__launch-review" role="status"><h3>Reviewed account pool</h3>
            <ul>{Object.entries(preview.accountPool).map(([provider, accounts]) => <li key={provider} data-family={providerPolicy(provider)?.family ?? provider}><span>{providerPolicy(provider)?.label ?? provider}</span><span>{accounts.length} account{accounts.length === 1 ? "" : "s"}</span></li>)}</ul>
            <details className="plugin-atyrode_code__details"><summary>Exact accounts and runtime review</summary><pre>{JSON.stringify({ accounts: preview.accountPool, resources: preview.resources, reviewDigest: preview.previewDigest }, null, 2)}</pre></details>
          </div>}
          <label htmlFor={`${id}-prompt`}>First prompt <span className="plugin-atyrode_code__dim">optional</span></label>
          <textarea id={`${id}-prompt`} rows={2} maxLength={16384} value={prompt} placeholder="What should this session work on?" onChange={event => setPrompt(event.target.value)} />
          {!launchReady && <button type="button" disabled={busy} onClick={() => setView("setup")}>Review runtime setup <span aria-hidden="true">→</span></button>}
          {setup.error && <p role="status" className="plugin-atyrode_code__warning">{setup.error}</p>}
        </section>
        {compiled && shownReview && <div className="plugin-atyrode_code_generator__route-preview"><Routing value={shownReview} catalog={compiled} local={dials !== null} /></div>}
      </div>
      <div className="plugin-atyrode_code_generator__insights"><UsageOverview host={host} target={target} /></div>
      <footer className="plugin-atyrode_code_generator__footer"><span>Shared workspace profile · revision {record.revision}</span><span>{machine?.name ?? "Workspace machine"} · {available ? "connected" : "offline"}</span></footer>
    </div>
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
