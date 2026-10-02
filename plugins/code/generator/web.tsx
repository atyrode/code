import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import type { MachineSummary } from "@manifold/protocol";
import { ControlIcon, ScrollRegion } from "@manifold/ui";
import { familyPolicy, providerPolicy } from "../../domain/providers.ts";
import { GENERATOR_PLUGIN_ID, LAUNCHER_PANEL, type Target } from "../contract.ts";
import { PROMPT_MAX_BYTES } from "@atyrode/manifold-omp";
import { useCodeTarget } from "../machine-web.ts";
import { AccountsView } from "../accounts-view.tsx";
import { UsageOverview } from "../usage-view.tsx";
import { CatalogWorkbench } from "./catalog-editor.tsx";
import { ContextHelp, DialIcon, Dials, Estimates, Routing } from "./dials.tsx";
import { RuntimeSettings } from "./runtime-settings.tsx";
import { PermissionReview } from "../permission-review.tsx";
import { OptionalSkills } from "./skills.tsx";
import { Automation } from "./automation.tsx";
import { FleetSessions } from "./fleet.tsx";
import { useWorkbench } from "./workbench-model.ts";

type View = "profile" | "accounts" | "catalog" | "setup";
function Workbench({ host, target, machine, machines, rosterError, available }: { host: HostServices; target: Target | null; machine: MachineSummary | null; machines: readonly MachineSummary[] | null; rosterError: string | null; available: boolean }) {
  const id = useId();
  const {
    queries: { configuration, metadata, setup, skillCatalog }, observed, record, machineId, destinationGeneration, document, starterError,
    compiled, selection, profile, localDraft, review, controlsReview, launchReview, configurationCurrent, unsaved, stale, writable,
    launchReady, previewCurrent, busy, profileState, stateLabel, launchStatus, message, exportedDraft, canSave, canReview, canResume,
    canResumeWithProfile, canSuggest, canRequestSuggestion, canApplySuggestion, suggestionPromptTooLong, suggestionStale,
    prompt, setPrompt, skillChoice, setSkillChoice, skillProblems, effectiveSkillMode, effectiveSkillCount, automation, setAutomation,
    savedSessionId, setSavedSessionId, setAccountObservation, suggestion, suggesting, actions,
  } = useWorkbench({ host, target, machine, rosterError, available });
  const [navigationState, setNavigationState] = useState<{ view: View; visited: readonly View[] }>({ view: "profile", visited: ["profile"] });
  const { view, visited } = navigationState;
  const [focus, setFocus] = useState<"generator" | "profiles" | "usage" | null>(null);
  const focusOrigin = useRef<HTMLButtonElement | null>(null);
  function setView(next: View) {
    setNavigationState(previous => previous.view === next ? previous : {
      view: next, visited: previous.visited.includes(next) ? previous.visited : [...previous.visited, next],
    });
  }
  const viewContent = useRef<HTMLDivElement>(null);
  const previousView = useRef(view);
  const currentView = useRef(view);
  currentView.current = view;
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    viewContent.current?.scrollIntoView({ block: "start" });
  }, [view]);
  function leaveFocus() {
    setFocus(null);
    focusOrigin.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (!focus) return;
    const document = focusOrigin.current?.ownerDocument;
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); leaveFocus(); }
    }
    document?.addEventListener("keydown", escape);
    return () => document?.removeEventListener("keydown", escape);
  }, [focus]);
  function back() { setFocus(null); setView("profile"); actions.refresh(); }
  const savedSessionPanel = <details className="plugin-atyrode_code_generator__disclosure" data-saved-sessions><summary>Saved sessions <span>{savedSessionId ? "Session selected" : "Resume or reopen"}</span></summary><FleetSessions key={destinationGeneration} host={host} machines={machines} rosterError={rosterError} machineId={machineId}
    sessionId={savedSessionId} choose={setSavedSessionId} busy={busy}>
    {running => <>
      <p>Resume on {machine?.name ?? (machineId || "no selected destination")} in this workspace.</p>
      <details className="plugin-atyrode_code__details"><summary>How resuming works</summary>
        <p>Saved state preserves its model and thinking. This profile replaces them with the saved Code choices and exact account pool. Neither action restores historical tool or skill restrictions: current session options apply, with ordinary automation and ambient skills when omitted.</p>
        <p>Native permission is still required. Code refreshes inventory and reopens a known running terminal instead of starting a replacement. Workspace: {host.containerId}.</p>
      </details>
      <div className="plugin-atyrode_code__toolbar">
        <button type="button" data-action="atyrode.omp.resumeSession" disabled={busy || !canResume || running} onClick={() => void actions.resume(false)}>Resume saved state</button>
        <button type="button" data-action="atyrode.omp.resumeSession" disabled={busy || !canResumeWithProfile || running} onClick={() => void actions.resume(true)}>Resume with this profile</button>
      </div>
    </>}
  </FleetSessions></details>;
  const navigation = <header className="plugin-atyrode_code_generator__workspace-nav">
    <nav aria-label="Code workspace">
      <button type="button" aria-current={view === "profile" ? "page" : undefined} disabled={busy} onClick={back}><DialIcon kind="model" />Workbench</button>
      <button type="button" aria-current={view === "accounts" ? "page" : undefined} disabled={busy} onClick={() => { setView("accounts"); actions.refresh(); }}><DialIcon kind="advisor" />Accounts</button>
      <button type="button" aria-current={view === "catalog" ? "page" : undefined} disabled={busy} onClick={() => { setView("catalog"); actions.refresh(); }}><DialIcon kind="lane" />Models</button>
      <button type="button" aria-current={view === "setup" ? "page" : undefined} disabled={busy} onClick={() => { setView("setup"); actions.refresh(); }}><ControlIcon kind="settings" size={14} />Setup</button>
    </nav>
    {profile && <span className="plugin-atyrode_code_generator__profile-state" data-state={profileState} role="status"><span aria-hidden="true" />{stateLabel}</span>}
  </header>;
  function finish(source: View) {
    if (currentView.current === source) back();
    else actions.refresh();
  }
  // Keep visited editors mounted so navigation cannot discard drafts, pending
  // failures or native job receipts. Hidden views cannot receive keyboard input.
  function frame(profile: ReactNode) {
    return <div className="plugin-atyrode_code_generator__workbench">
      {navigation}
      {message && <p role="status" className={`plugin-atyrode_code_generator__feedback ${message.failed ? "plugin-atyrode_code__warning" : "plugin-atyrode_code__muted"}`} data-failed={message.failed}>{message.text}</p>}
      <div hidden={view !== "profile"} ref={view === "profile" ? viewContent : undefined} className="plugin-atyrode_code_generator__view">{profile}<div hidden={focus !== null}>{savedSessionPanel}</div></div>
      {visited.includes("accounts") && <div hidden={view !== "accounts"} ref={view === "accounts" ? viewContent : undefined} className="plugin-atyrode_code_generator__view">
        <AccountsView host={host} target={target} available={available} onDone={() => finish("accounts")} />
      </div>}
      {visited.includes("catalog") && <div hidden={view !== "catalog"} ref={view === "catalog" ? viewContent : undefined} className="plugin-atyrode_code_generator__view">
        <CatalogWorkbench host={host} target={target} available={available} onDone={() => finish("catalog")} />
      </div>}
      {visited.includes("setup") && <div hidden={view !== "setup"} ref={view === "setup" ? viewContent : undefined} className="plugin-atyrode_code_generator__view">
        <RuntimeSettings host={host} target={target} available={available} onDone={() => finish("setup")} />
      </div>}
    </div>;
  }
  const lead = review?.routes.find(route => route.role === "default");
  const leadModel = lead && compiled?.model(lead.lead.key);
  const laneLabel = selection?.lane.kind === "mixed" ? "Mixed providers" : selection?.lane.kind === "provider" ? `${familyPolicy(selection.lane.family)?.label ?? selection.lane.family} ${selection.lane.blend}` : null;
  function focusButton(section: "generator" | "profiles" | "usage") {
    return <button type="button" className="plugin-atyrode_code_generator__focus" data-focus-panel={section} data-focus-return={focus === section ? "" : undefined}
      aria-label={focus === section ? "Show workbench" : `Focus ${section}`} title={focus === section ? "Show workbench" : `Focus ${section}`}
      onClick={event => { if (focus === section) leaveFocus(); else { focusOrigin.current = event.currentTarget; setFocus(section); } }}>
      <DialIcon kind={focus === section ? "collapse" : "expand"} />
    </button>;
  }
  return frame(<>
      <div className="plugin-atyrode_code_generator__dashboard" data-focused={focus ?? "none"}>
      <section className="plugin-atyrode_code_generator__pane plugin-atyrode_code_generator__generator-pane" aria-label="Generator controls" hidden={focus !== null && focus !== "generator"}>
      <header className="plugin-atyrode_code_generator__pane-heading"><h2><span className="plugin-atyrode_code_generator__section-number">01</span>Generator</h2><ContextHelp label="generator"><p>Four shared controls shape the whole roster. Inspect exact models, thinking and ordered fallbacks beside them; the task remains independent.</p><p>First use starts from OMP's bundled model facts without discovery or credentials. Save the catalog and your chosen profile together. Model metadata is not reachability, quota or launch permission.</p><p>Models keeps custom catalogs, import/export, discovery, benchmark and explicit staged review. Accounts and Setup remain separate native boundaries.</p></ContextHelp>{focusButton("generator")}</header>
      {leadModel && <section className="plugin-atyrode_code_generator__session-summary" aria-label="Session profile summary">
        <div className="plugin-atyrode_code_generator__session-identity">
          <p className="plugin-atyrode_code_generator__session-model">{leadModel.key}{lead && <span>{lead.lead.thinking} thinking</span>}</p>
          {laneLabel && <p className="plugin-atyrode_code_generator__session-context">{laneLabel}</p>}
        </div>
      </section>}
      {!writable && <p role="status" className="plugin-atyrode_code__notice">Read-only workspace. Inspect local choices; saving and launching require edit access.</p>}
      {configuration.error && <div className="plugin-atyrode_code__notice" role="status"><p>Shared choices unavailable{profile ? " · local material retained" : " · absence has not been established"}.</p><button type="button" data-action="atyrode.code.readConfiguration" onClick={configuration.refresh}>Retry shared choices</button><details className="plugin-atyrode_code__details"><summary>Details</summary><pre>{configuration.error}</pre></details></div>}
      {(metadata.error || starterError) && <div className="plugin-atyrode_code__notice" role="status"><p>Bundled model source unavailable{profile ? " · displayed material is retained, not a fresh source observation" : ""}.</p><button type="button" data-action="atyrode.omp.readModelCatalog" onClick={metadata.refresh}>Retry model source</button><details className="plugin-atyrode_code__details"><summary>Details</summary><pre>{metadata.error ?? starterError}</pre></details></div>}
      <div className="plugin-atyrode_code_generator__controls" aria-label="Profile controls">
        {!profile && !document && !configuration.error && !starterError && !metadata.error && <p role="status">{!configuration.data ? "Reading shared choices…" : "Reading bundled model facts…"}</p>}
        {compiled && selection && controlsReview ? <Dials selection={selection} review={controlsReview} catalog={compiled} disabled={busy} update={actions.updateSelection} /> :
          document ? <p role="status" className="plugin-atyrode_code__warning">These choices need a model review. <button type="button" onClick={() => setView("catalog")}>Review in Models</button></p> : null}
        {(profile?.source === "draft" || (!localDraft && !!record?.draft && !record.active)) && <div className="plugin-atyrode_code__notice"><p>Previewing the saved staged catalog. It has not replaced the active workspace policy.</p><button type="button" onClick={() => setView("catalog")}>Review staged catalog in Models</button></div>}
        {localDraft && <div className="plugin-atyrode_code_generator__draft" data-stale={stale}>
          {stale && <p role="status">Shared policy or model facts changed. This local draft is still based on revision {localDraft.revision}; it cannot overwrite revision {configuration.data?.revision}. Keep a copy, or explicitly discard and use the current source.</p>}
          <div className="plugin-atyrode_code__toolbar">
            {localDraft.source !== "draft" && <button type="button" className="plugin-atyrode_code__primary-action"
              data-action={localDraft.metadata ? "atyrode.code.adoptStarterProfile" : "atyrode.code.select"}
              disabled={busy || !canSave}
              onClick={() => void actions.saveProfile()}>{busy ? "Saving…" : "Save profile"}</button>}
            <button type="button" disabled={busy} onClick={actions.discardChanges}>{stale ? "Discard and use current" : "Discard changes"}</button>
          </div>
          <details className="plugin-atyrode_code__details plugin-atyrode_code_generator__source-details">
            <summary data-starter-details={localDraft.metadata ? "" : undefined}>Local profile &amp; source</summary>
            <p>Not persisted. Task text is independent and excluded from this export. {localDraft.metadata ? `Bundled OMP ${localDraft.metadata.ompVersion} · metadata revision ${localDraft.metadata.revision}. Performance is unmeasured; availability and accounts require their own observations.` : "This draft retains the exact stored catalog it was based on. Its historical source provenance is unrecorded."}</p>
            <label htmlFor={`${id}-export`}>Copy local profile</label>
            <textarea id={`${id}-export`} data-starter-export={localDraft.metadata ? "" : undefined} data-profile-export readOnly rows={5} value={exportedDraft} />
          </details>
        </div>}
        {review && compiled && <Estimates value={review.estimates} measured={review.routes.every(route => compiled.model(route.lead.key).tokensPerSecond !== null)} />}
      </div>
      </section>
      <section className="plugin-atyrode_code_generator__pane plugin-atyrode_code_generator__profiles-pane" aria-label="Generated profiles" hidden={focus !== null && focus !== "profiles"}>
        <header className="plugin-atyrode_code_generator__pane-heading"><h2><span className="plugin-atyrode_code_generator__section-number">02</span>Agent profiles <span>{review ? `${review.routes.length} roles` : "per agent"}</span></h2>{focusButton("profiles")}</header>
        {compiled && review ? <Routing value={review} catalog={compiled} local={unsaved} compact={focus !== "profiles"} /> : <p className="plugin-atyrode_code_generator__empty" role="status">{document ? "This catalog cannot resolve a complete per-agent profile for these choices. Review Models; no default has been substituted." : "Profiles appear after shared choices and model facts are read."}</p>}
      </section>
      <section className="plugin-atyrode_code_generator__pane plugin-atyrode_code_generator__usage-pane" aria-label="Usage overview" hidden={focus !== null && focus !== "usage"}>
        <header className="plugin-atyrode_code_generator__pane-heading"><h2><span className="plugin-atyrode_code_generator__section-number">03</span>Accounts / usage</h2>{focusButton("usage")}</header>
        <UsageOverview host={host} compact={focus !== "usage"} onAccounts={() => setView("accounts")} onObservation={setAccountObservation} />
      </section>
      </div>
        <section className="plugin-atyrode_code_generator__launch" aria-labelledby={`${id}-launch-heading`} data-reviewed={previewCurrent} hidden={focus !== null}>
          <h3 id={`${id}-launch-heading`} className="plugin-atyrode_code__section-label"><span className="plugin-atyrode_code_generator__section-number">04</span>{previewCurrent ? "Confirm launch" : "Task / launch"}</h3>
          <label htmlFor={`${id}-prompt`} className="plugin-atyrode_code_generator__sr-only">Task · optional</label>
          {/* Characters, because a textarea counts characters: the door's rule is bytes and
              refuses a multibyte prompt over it by name. */}
          <textarea id={`${id}-prompt`} rows={2} maxLength={PROMPT_MAX_BYTES} value={prompt} placeholder="What should we tackle?" onChange={event => setPrompt(event.target.value)} />
          {canSuggest && <div className="plugin-atyrode_code_generator__suggestion">
            {!suggesting ? <button type="button" aria-expanded={false} onClick={actions.openSuggestion}>Suggest a profile from this task <span aria-hidden="true">→</span></button> : <>
              <p className="plugin-atyrode_code__muted">Explicitly sends this task to the configured classifier. Nothing is saved; inspect its proposed changes first.</p>
              <div className="plugin-atyrode_code__toolbar"><button type="button" data-action="atyrode.code.suggest" disabled={busy || !canRequestSuggestion} onClick={() => void actions.suggest()}>{busy ? "Working…" : "Suggest profile"}</button><button type="button" disabled={busy} onClick={actions.closeSuggestion}>Close suggestion</button></div>
              {suggestionPromptTooLong && <p role="status">The classifier accepts up to 16,384 characters. The task is retained in full, never truncated.</p>}
              {suggestion && <div className="plugin-atyrode_code__notice"><p>{suggestion.changed.length ? `Suggested changes: ${suggestion.changed.join(", ")}` : "Your current profile already fits."}</p>
                <dl className="plugin-atyrode_code_generator__suggested-values">{suggestion.changed.map(key => <div key={key}><dt>{key}</dt><dd>{typeof suggestion.selection[key] === "object" ? JSON.stringify(suggestion.selection[key]) : String(suggestion.selection[key])}</dd></div>)}</dl>
                <button type="button" disabled={busy || !canApplySuggestion}
                  onClick={actions.applySuggestion}>Try this profile</button>
                {unsaved && <p>Save or discard your local changes before trying a suggestion.</p>}
                {suggestionStale && <p role="status">Shared choices or classifier policy changed. Request a new suggestion.</p>}
              </div>}
            </>}
          </div>}
          <div className="plugin-atyrode_code_generator__launch-bar">
            <button type="button" className="plugin-atyrode_code__primary-action" data-action={previewCurrent ? "atyrode.omp.prepareSession" : "atyrode.omp.reviewSession"} disabled={busy || !canReview} aria-describedby={`${id}-launch-status`} onClick={() => {
              if (previewCurrent) { void actions.launch(); return; }
              void actions.review();
            }}>{busy ? "Working…" : previewCurrent ? "Launch OMP" : "Review launch"}<span aria-hidden="true">{previewCurrent ? "↗" : "→"}</span></button>
          </div>
          <p id={`${id}-launch-status`} className="plugin-atyrode_code_generator__launch-status">{launchStatus}</p>
          {launchReview && <div className="plugin-atyrode_code_generator__launch-review" role="status"><h3>Reviewed account pool</h3>
            <ul>{Object.entries(launchReview.composition.accountPool).map(([provider, accounts]) => <li key={provider} data-family={providerPolicy(provider)?.family ?? provider}><span>{providerPolicy(provider)?.label ?? provider}</span><span>{accounts.length} account{accounts.length === 1 ? "" : "s"}</span></li>)}</ul>
            <details className="plugin-atyrode_code__details"><summary>Exact accounts and runtime review</summary><pre>{JSON.stringify({ composition: launchReview.composition, native: launchReview.native }, null, 2)}</pre></details>
          </div>}
          <details className="plugin-atyrode_code_generator__disclosure" data-session-options><summary>This launch options <span>{automation ? `Restricted · ${automation.toolNames.length} tools` : "Ordinary"} · {effectiveSkillMode === "disabled" ? "Skills off" : effectiveSkillMode === "preserve" ? "Default skills" : `${effectiveSkillCount} ${automation ? "sealed" : "selected"} skills`}</span></summary>
          <Automation choice={automation} reviewed={launchReview ? launchReview.native.automation : null} disabled={busy || !writable || !available}
            change={setAutomation} />
          <OptionalSkills catalog={skillCatalog.data} error={skillCatalog.error} choice={skillChoice} restricted={automation?.mode === "restricted"} reviewed={launchReview ? launchReview.native.skills : null}
            disabled={busy || !writable || !available} refresh={skillCatalog.refresh} change={setSkillChoice} />
          </details>
          {automation && <p className="plugin-atyrode_code__warning">Restricted OMP tools; not an OS or network sandbox.</p>}
          {record?.active && skillCatalog.error && <p role="status" className="plugin-atyrode_code__warning">Skills unavailable · see session options.</p>}
          {!!skillProblems.length && <p role="status" className="plugin-atyrode_code__warning">Optional skill choices need attention. Open session options to resolve them.</p>}
          {record?.active && !launchReady && <div className="plugin-atyrode_code_generator__next-action"><PermissionReview host={host} target={target} intent="session" label={setup.error ? "Check connection" : "Enable sessions"} onReady={actions.refresh} /></div>}
          {record?.active && setup.error && <details className="plugin-atyrode_code__details"><summary>Connection details</summary><pre>{setup.error}</pre></details>}
        </section>
      {profile && <footer className="plugin-atyrode_code_generator__footer" hidden={focus !== null}><details className="plugin-atyrode_code__details"><summary>Workspace / source details</summary><dl className="plugin-atyrode_code_generator__setup-facts"><dt>Shared revision</dt><dd>{record?.revision ?? observed?.revision ?? "not observed"}{!configurationCurrent && " · last known, not current"}</dd><dt>Displayed catalog</dt><dd>{profile.document.models.length} models · {profile.source === "starter" ? "local bundled starter" : profile.source === "draft" ? "staged preview" : "stored policy"}</dd><dt>Saved historical provenance</dt><dd>Unrecorded · current metadata does not authenticate how a stored catalog was made</dd><dt>Current bundled source</dt><dd>{metadata.data ? `OMP ${metadata.data.ompVersion} · ${metadata.data.revision}` : "Not currently observed"}</dd><dt>Workspace</dt><dd>{host.containerId}</dd><dt>Destination</dt><dd>{machine?.name ?? "None"} · {machineId || "not selected"} · {available ? "connected" : "unavailable"}</dd></dl></details></footer>}
  </>);
}

function Launcher({ host }: PanelProps) {
  const id = useId();
  const { machines, machine, machineId, target, available, error, select, refresh } = useCodeTarget(host);
  return <ScrollRegion className="plugin-atyrode_code plugin-atyrode_code_generator" aria-label="Code workspace"><div className="plugin-atyrode_code_generator__body">
    <header className="plugin-atyrode_code_generator__masthead"><h1>code<span aria-hidden="true">_</span></h1>
      {host.containerId && <div className="plugin-atyrode_code_generator__machine"><span className="plugin-atyrode_code_generator__connection" data-online={available} aria-hidden="true" />
        <label htmlFor={`${id}-machine`}>Run on</label><select id={`${id}-machine`} value={machineId ?? ""} onChange={event => { if (event.target.value) select(event.target.value); }}><option value="" disabled>choose a machine</option>
          {machineId && !machine && <option value={machineId}>selected machine unavailable</option>}
          {machines?.map(entry => <option key={entry.id} value={entry.id}>{entry.name}{entry.revoked ? " · revoked" : entry.online ? "" : " · offline"}</option>)}
        </select>
        <button type="button" aria-label="Refresh machines" title="Refresh machines" onClick={refresh}><DialIcon kind="fallback" /><span className="plugin-atyrode_code_generator__sr-only">Refresh machines</span></button>
      </div>}
    </header>
    {error && <p role="status" className="plugin-atyrode_code__warning">{error} <button type="button" onClick={refresh}>refresh</button></p>}
    {!host.containerId && <p role="status">Open or create a workspace in Manifold to use Code here.</p>}
    {host.containerId && <Workbench key={JSON.stringify([host.principal.id, host.containerId])} host={host} target={target} machine={machine} machines={machines} rosterError={error} available={available} />}
  </div></ScrollRegion>;
}
export default { id: GENERATOR_PLUGIN_ID, panels: { [LAUNCHER_PANEL]: Launcher } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
