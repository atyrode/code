import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import { formatManifoldUri, type MachineSummary } from "@manifold/protocol";
import { ControlIcon, ScrollRegion } from "@manifold/ui";
import { compileCatalog } from "../../domain/catalog.ts";
import { reviewCatalog } from "../../domain/routing.ts";
import type { Selection } from "../../domain/contracts.ts";
import { familyPolicy, providerPolicy } from "../../domain/providers.ts";
import { GENERATOR_PLUGIN_ID, LAUNCHER_PANEL, type ActionResult, type Target } from "../contract.ts";
import { LAUNCH_OPERATION_ID, OMP_PLUGIN_ID, PROMPT_MAX_BYTES } from "@atyrode/manifold-omp";
import type { SessionReview } from "../workflow.ts";
import { callCodeAction, codeWorkflow, canWriteCodeWorkspace, codeOperationFailure, useCodeQuery, useOmpQuery, useWorkflowQuery, useCodeTarget } from "../machine-web.ts";
import { operationReady } from "../permission-plan.ts";
import { AccountsView } from "../accounts-view.tsx";
import { UsageOverview } from "../usage-view.tsx";
import { CatalogWorkbench } from "./catalog-editor.tsx";
import { ContextHelp, DialIcon, Dials, Estimates, Routing } from "./dials.tsx";
import { RuntimeSettings } from "./runtime-settings.tsx";
import { PermissionReview } from "../permission-review.tsx";
import { OptionalSkills } from "./skills.tsx";
import { skillDraft, type SkillChoice } from "./skill-draft.ts";
import { Automation, type AutomationChoice } from "./automation.tsx";
import { FleetSessions } from "./fleet.tsx";

type View = "profile" | "accounts" | "catalog" | "setup";
function Workbench({ host, target, machine, machines, rosterError, available }: { host: HostServices; target: Target | null; machine: MachineSummary | null; machines: readonly MachineSummary[] | null; rosterError: string | null; available: boolean }) {
  const machineId = target?.machineId ?? "";
  const id = useId();
  const configuration = useCodeQuery(host, "readConfiguration", { containerId: host.containerId! });
  const setup = useOmpQuery(host, "describeDestination", target);
  const classifier = useWorkflowQuery(host, `classifier:${JSON.stringify(target)}`, target !== null, () => codeWorkflow(host).classifier(target!));
  const defaults = useOmpQuery(host, "readDefaults", {});
  const skillCatalog = useWorkflowQuery(host, `skills:${JSON.stringify(target)}`, target !== null, () => codeWorkflow(host).readSkillCatalog(target!));
  const record = configuration.data?.configuration ?? null;
  const [navigationState, setNavigationState] = useState<{ view: View; visited: readonly View[] }>({ view: "profile", visited: ["profile"] });
  const { view, visited } = navigationState;
  const [focus, setFocus] = useState<"generator" | "profiles" | "usage" | null>(null);
  function setView(next: View) {
    setNavigationState(previous => previous.view === next ? previous : {
      view: next, visited: previous.visited.includes(next) ? previous.visited : [...previous.visited, next],
    });
  }
  const [dials, setDials] = useState<{ selection: Selection; revision: number; baseSelection: Selection | null; catalogDigest: string | null } | null>(null);
  const [preview, setPreview] = useState<SessionReview | null>(null);
  const [skillChoice, setSkillChoice] = useState<SkillChoice>(undefined);
  const [automation, setAutomation] = useState<AutomationChoice>(undefined);
  const [savedSessionId, setSavedSessionId] = useState("");
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
  const destination = useRef({ machineId: machineId, generation: 0 });
  if (destination.current.machineId !== machineId) destination.current = { machineId: machineId, generation: destination.current.generation + 1 };
  const generation = destination.current.generation;
  const current = useRef({ host, machine, available, view, target });
  current.current = { host, machine, available, view, target };
  function destinationCurrent() {
    return mounted.current && generation === destination.current.generation &&
      current.current.host.client === host.client && current.current.host.authoring === host.authoring &&
      current.current.target?.machineId === machineId && current.current.available;
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { setPreview(null); setSuggestion(null); setSkillChoice(undefined); setAutomation(undefined); setSavedSessionId(""); }, [machineId]);
  useEffect(() => {
    if (previousView.current === view) return;
    previousView.current = view;
    viewContent.current?.scrollIntoView({ block: "start" });
  }, [view]);
  useEffect(() => {
    if (!record) return;
    setDials(previous => previous && previous.revision !== record.revision &&
      previous.catalogDigest === (record.active?.digest ?? null) && JSON.stringify(previous.baseSelection) === JSON.stringify(record.selection)
      ? { ...previous, revision: record.revision } : previous);
  }, [record]);
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
  const draftSkills = skillDraft(skillCatalog.data, skillChoice);
  const skillProblems = draftSkills.problems;
  // A monotonic epoch also fences a policy/prompt round trip while native review is in flight.
  const reviewKey = JSON.stringify([generation, target, record?.revision, defaults.data?.revision, skillCatalog.data?.revision, prompt, skillChoice, automation, dials, savedSessionId]);
  const reviewScope = useRef({ key: reviewKey, epoch: 0 });
  if (reviewScope.current.key !== reviewKey) reviewScope.current = { key: reviewKey, epoch: reviewScope.current.epoch + 1 };
  const reviewedEpoch = useRef(-1);
  const reviewEpoch = reviewScope.current.epoch;
  const previewCurrent = preview !== null && reviewedEpoch.current === reviewEpoch && preview.destination.machineId === machineId && preview.composition.revision === record?.revision &&
    preview.composition.prompt === prompt && preview.native.defaultsRevision === defaults.data?.revision && dials === null &&
    skillProblems.length === 0 && (preview.native.skills.mode !== "selected" || preview.native.skills.catalogRevision === skillCatalog.data?.revision);
  const effectiveSkillMode = previewCurrent ? preview.native.skills.mode : skillChoice?.mode ?? (automation ? "disabled" : "preserve");
  const effectiveSkillCount = previewCurrent ? preview.native.skills.selected.length : draftSkills.selected.length;
  const shownReview = previewCurrent ? preview.composition.review : localReview;
  const writable = canWriteCodeWorkspace(host);
  const canSuggest = classifier.data !== null && classifier.data !== undefined;
  const launchReady = operationReady(setup.data, LAUNCH_OPERATION_ID);
  function refresh() { configuration.refresh(); setup.refresh(); classifier.refresh(); defaults.refresh(); skillCatalog.refresh(); }
  function back() { setFocus(null); setView("profile"); refresh(); }
  async function perform(work: () => Promise<void>) {
    if (pending.current || !writable) return;
    pending.current = true; setBusy(true); setMessage(null);
    try { await work(); }
    catch (reason) { if (mounted.current) setMessage({ text: codeOperationFailure(reason), failed: true }); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); refresh(); } }
  }
  async function launch() {
    if (!target || !record || !previewCurrent || !preview || !available || !launchReady) return;
    await perform(async () => {
      // A refused attempt must return to explicit review, even if the shared profile
      // revision did not change (for example, the account pool changed independently).
      setPreview(null);
      const prepared = await codeWorkflow(host).prepareSession(preview);
      const latest = current.current;
      if (!destinationCurrent() || reviewScope.current.epoch !== reviewEpoch || prepared.destination.machineId !== latest.target?.machineId || prepared.destination.containerId !== latest.host.containerId ||
        latest.host.principal.id !== host.principal.id || latest.machine?.id !== prepared.destination.machineId || !latest.host.authoring || !canWriteCodeWorkspace(latest.host)) throw new Error("Destination changed");
      if (await latest.host.authoring.createTerminal(latest.machine, prepared.runtime) === null) throw new Error("Terminal placement refused");
      if (destinationCurrent()) { setPreview(null); setSkillChoice(undefined); setAutomation(undefined); setSavedSessionId(""); setMessage({ text: "Terminal opened. Follow the session in OMP. Optional choices were cleared for the next independent launch.", failed: false }); }
    });
  }
  async function resume(withProfile: boolean) {
    if (!target || !savedSessionId || !available ||
      (withProfile && (!record || dials || !localReview))) return;
    await perform(async () => {
      setPreview(null);
      const result = await codeWorkflow(host).resumeSession({ harness: OMP_PLUGIN_ID, machineId, sessionId: savedSessionId }, {
        ...(withProfile ? { profile: { target, expectedRevision: record!.revision } } : {}),
        ...(skillChoice === undefined ? {} : { skills: skillChoice }), ...(automation === undefined ? {} : { automation }),
      }, () => destinationCurrent() && reviewScope.current.epoch === reviewEpoch && canWriteCodeWorkspace(current.current.host));
      if (result.kind === "reopen") {
        if (destinationCurrent()) host.navigate(formatManifoldUri({ kind: "terminal", terminalId: result.terminals[0]!.id }));
        return;
      }
      const prepared = result.prepared;
      const latest = current.current;
      if (!destinationCurrent() || reviewScope.current.epoch !== reviewEpoch || latest.host.principal.id !== host.principal.id ||
        prepared.machineId !== latest.target?.machineId || prepared.sessionId !== savedSessionId || latest.machine?.id !== prepared.machineId ||
        !latest.host.authoring || !canWriteCodeWorkspace(latest.host)) throw new Error("Destination or session choices changed");
      if (await latest.host.authoring.createTerminal(latest.machine, prepared.runtime) === null) throw new Error("Terminal placement refused");
      if (destinationCurrent()) {
        setPreview(null); setSkillChoice(undefined); setAutomation(undefined); setSavedSessionId("");
        setMessage({ text: "Saved session opened in OMP. Per-session choices were cleared.", failed: false });
      }
    });
  }
  const savedSessionPanel = <details className="plugin-atyrode_code_generator__disclosure" data-saved-sessions><summary>Saved sessions <span>{savedSessionId ? "Session selected" : "Resume or reopen"}</span></summary><FleetSessions key={generation} host={host} machines={machines} rosterError={rosterError} machineId={machineId}
    sessionId={savedSessionId} choose={setSavedSessionId} busy={busy}>
    {running => <>
      <p>Resume on {machine?.name ?? (machineId || "no selected destination")} in this workspace.</p>
      <details className="plugin-atyrode_code__details"><summary>How resuming works</summary>
        <p>Saved state preserves its model and thinking. This profile replaces them with the saved Code choices and exact account pool. Neither action restores historical tool or skill restrictions: current session options apply, with ordinary automation and ambient skills when omitted.</p>
        <p>Native permission is still required. Code refreshes inventory and reopens a known running terminal instead of starting a replacement. Workspace: {host.containerId}.</p>
      </details>
      <div className="plugin-atyrode_code__toolbar">
        <button type="button" data-action="atyrode.omp.resumeSession" disabled={busy || !writable || !available || !savedSessionId || running || skillProblems.length > 0} onClick={() => void resume(false)}>Resume saved state</button>
        <button type="button" data-action="atyrode.omp.resumeSession" disabled={busy || !writable || !available || !savedSessionId || running || !record || !!dials || !localReview || skillProblems.length > 0} onClick={() => void resume(true)}>Resume with this profile</button>
      </div>
    </>}
  </FleetSessions></details>;
  const profileState = stale ? "conflict" : dials ? "local" : "saved";
  const stateLabel = stale ? "Shared profile changed" : dials ? "Local changes" : "Saved profile";
  const navigation = <header className="plugin-atyrode_code_generator__workspace-nav">
    <nav aria-label="Code workspace">
      <button type="button" aria-current={view === "profile" ? "page" : undefined} disabled={busy} onClick={back}><DialIcon kind="model" />Workbench</button>
      <button type="button" aria-current={view === "accounts" ? "page" : undefined} disabled={busy} onClick={() => { setView("accounts"); refresh(); }}><DialIcon kind="advisor" />Accounts</button>
      <button type="button" aria-current={view === "catalog" ? "page" : undefined} disabled={busy} onClick={() => { setView("catalog"); refresh(); }}><DialIcon kind="lane" />Models</button>
      <button type="button" aria-current={view === "setup" ? "page" : undefined} disabled={busy} onClick={() => { setView("setup"); refresh(); }}><ControlIcon kind="settings" size={14} />Setup</button>
    </nav>
    {record?.active && <span className="plugin-atyrode_code_generator__profile-state" data-state={profileState} role="status"><span aria-hidden="true" />{stateLabel}</span>}
  </header>;
  function finish(source: View) {
    if (current.current.view === source) back();
    else refresh();
  }
  // Keep visited editors mounted so navigation cannot discard drafts, pending
  // failures or native job receipts. Hidden views cannot receive keyboard input.
  function frame(profile: ReactNode) {
    return <div className="plugin-atyrode_code_generator__workbench">
      {navigation}
      {message && <p role="status" className={`plugin-atyrode_code_generator__feedback ${message.failed ? "plugin-atyrode_code__warning" : "plugin-atyrode_code__muted"}`} data-failed={message.failed}>{message.text}</p>}
      <div hidden={view !== "profile"} ref={view === "profile" ? viewContent : undefined} className="plugin-atyrode_code_generator__view">{profile}{savedSessionPanel}</div>
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
  const lead = shownReview?.routes.find(route => route.role === "default");
  const leadModel = lead && compiled?.model(lead.lead.key);
  const laneLabel = selection?.lane.kind === "mixed" ? "Mixed providers" : selection?.lane.kind === "provider" ? `${familyPolicy(selection.lane.family)?.label ?? selection.lane.family} ${selection.lane.blend}` : null;
  function focusButton(section: "generator" | "profiles" | "usage") {
    return <button type="button" className="plugin-atyrode_code_generator__focus" aria-label={focus === section ? "Show workbench" : `Focus ${section}`} title={focus === section ? "Show workbench" : `Focus ${section}`} onClick={() => setFocus(focus === section ? null : section)}><DialIcon kind={focus === section ? "collapse" : "expand"} /></button>;
  }
  return frame(<>
      <div className="plugin-atyrode_code_generator__dashboard" data-focused={focus ?? "none"}>
      <section className="plugin-atyrode_code_generator__pane plugin-atyrode_code_generator__generator-pane" aria-label="Generator" hidden={focus !== null && focus !== "generator"}>
      <header className="plugin-atyrode_code_generator__pane-heading"><h2><DialIcon kind="model" />Generator</h2><ContextHelp label="generator"><p>Choose the profile for your next session. Add models first; accounts and runtime can be connected when you need them.</p></ContextHelp>{focusButton("generator")}</header>
      <section className="plugin-atyrode_code_generator__session-summary" aria-label="Session profile summary">
        <div className="plugin-atyrode_code_generator__session-identity">
          <h3 className="plugin-atyrode_code__section-label">Next session</h3>
          <p className="plugin-atyrode_code_generator__session-model">{leadModel?.key ?? "Your next session"}{lead && <span>{lead.lead.thinking} thinking</span>}</p>
          <p className="plugin-atyrode_code_generator__session-context">{laneLabel && <span>{laneLabel}</span>}</p>
        </div>
      </section>
      {!writable && <p role="status" className="plugin-atyrode_code__notice">Read-only workspace. Profile changes and launch require edit access.</p>}
      {configuration.error && <div className="plugin-atyrode_code__notice" role="status"><p>Workspace choices unavailable.</p><button type="button" onClick={configuration.refresh}>Try again</button><details className="plugin-atyrode_code__details"><summary>Details</summary><pre>{configuration.error}</pre></details></div>}
      <div className="plugin-atyrode_code_generator__profile-grid">
        <section className="plugin-atyrode_code_generator__controls" aria-label="Profile controls">
          {!configuration.data ? <p role="status">Loading models…</p> : !record?.active ? <div className="plugin-atyrode_code_generator__empty"><DialIcon kind="lane" /><span>Add models to shape your agent profiles.</span><button type="button" className="plugin-atyrode_code__primary-action" onClick={() => setView("catalog")}><DialIcon kind="add" />Add models</button></div> : null}
          {compiled && selection && localReview ? <Dials selection={selection} review={localReview} catalog={compiled} disabled={busy || !writable} update={value => { if (record) { setDials({ selection: value, revision: dials?.revision ?? record.revision,
            baseSelection: dials ? dials.baseSelection : record.selection, catalogDigest: dials ? dials.catalogDigest : record.active?.digest ?? null }); setPreview(null); setSuggestion(null); setMessage(null); } }} /> : record?.active ? <p role="status" className="plugin-atyrode_code__warning">Profile needs a model review. <button type="button" onClick={() => setView("catalog")}>Open models</button></p> : null}
          {dials && record && <div className="plugin-atyrode_code_generator__draft" data-stale={stale}>
            <div><strong>{stale ? "Shared changes need your attention" : "Local profile changes"}</strong><p role="status">{stale ? `Based on revision ${dials.revision}; shared profile is now revision ${record.revision}. Your draft cannot overwrite it.` : "Save to make these choices available to the workspace."}</p></div>
            <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" data-action="atyrode.code.select" disabled={busy || !writable || stale || !localReview} onClick={() => void perform(async () => { await callCodeAction(host, "select", { containerId: host.containerId!, expectedRevision: dials.revision, selection: dials.selection }); if (mounted.current) { setDials(null); setMessage({ text: "Profile saved. Review the launch when you're ready.", failed: false }); } })}>{busy ? "Working…" : "Save profile"}</button><button type="button" disabled={busy} onClick={() => { setDials(null); setPreview(null); }}>Discard changes</button></div>
            {stale && <details className="plugin-atyrode_code__details"><summary>Keep a copy of your draft</summary><pre>{JSON.stringify(dials.selection, null, 2)}</pre></details>}
          </div>}
          {record && canSuggest && <div className="plugin-atyrode_code_generator__suggestion">
            {!suggesting ? <button type="button" aria-expanded={false} onClick={() => setSuggesting(true)}>Suggest a profile from my task <span aria-hidden="true">→</span></button> : <>
              <label htmlFor={`${id}-suggest`}>What are you working on?</label><textarea id={`${id}-suggest`} value={suggestionPrompt} rows={2} maxLength={16384} placeholder="A quick fix, a design review, a larger refactor…" onChange={event => setSuggestionPrompt(event.target.value)} />
              <div className="plugin-atyrode_code__toolbar"><button type="button" data-action="atyrode.code.suggest" disabled={busy || !writable || !available || !record || !suggestionPrompt.trim() || !classifier.data} onClick={() => { if (record && target && classifier.data) void perform(async () => { const value = await callCodeAction(host, "suggest", { ...target, expectedRevision: record.revision, expectedServiceRevision: classifier.data!.revision, prompt: suggestionPrompt }); if (destinationCurrent()) setSuggestion(value); }); }}>{busy ? "Working…" : "Suggest profile"}</button><button type="button" disabled={busy} onClick={() => { setSuggesting(false); setSuggestion(null); }}>Close suggestion</button></div>
              <p className="plugin-atyrode_code__muted">Sends this description to the configured classifier; does not change your profile.</p>
              {suggestion && <div className="plugin-atyrode_code__notice"><p>{suggestion.changed.length ? `Suggested changes: ${suggestion.changed.join(", ")}` : "Your current profile already fits."}</p>
                <dl className="plugin-atyrode_code_generator__suggested-values">{suggestion.changed.map(key => <div key={key}><dt>{key}</dt><dd>{typeof suggestion.selection[key] === "object" ? JSON.stringify(suggestion.selection[key]) : String(suggestion.selection[key])}</dd></div>)}</dl>
                <button type="button" disabled={busy || !!dials || suggestion.revision !== record?.revision || suggestion.serviceRevision !== classifier.data?.revision} onClick={() => { setDials({ selection: suggestion.selection, revision: suggestion.revision, baseSelection: record.selection, catalogDigest: record.active?.digest ?? null }); setPreview(null); setSuggesting(false); }}>Try this profile</button>
                {!!dials && <p>Save or discard your local changes before trying a suggestion.</p>}
                {(suggestion.revision !== record?.revision || suggestion.serviceRevision !== classifier.data?.revision) && <p role="status">Shared choices or classifier policy changed. Request a new suggestion.</p>}
              </div>}
            </>}
          </div>}
          {shownReview && <Estimates value={shownReview.estimates} />}
        </section>
        <section className="plugin-atyrode_code_generator__launch" aria-labelledby={`${id}-launch-heading`} data-reviewed={previewCurrent}>
          <h3 id={`${id}-launch-heading`} className="plugin-atyrode_code__section-label">{previewCurrent ? "Confirm launch" : "Task"}</h3>
          <label htmlFor={`${id}-prompt`} className="plugin-atyrode_code_generator__sr-only">Task · optional</label>
          {/* Characters, because a textarea counts characters: the door's rule is bytes and
              refuses a multibyte prompt over it by name. */}
          <textarea id={`${id}-prompt`} rows={3} maxLength={PROMPT_MAX_BYTES} value={prompt} placeholder="What should we tackle?" onChange={event => { setPrompt(event.target.value); setPreview(null); }} />
          <div className="plugin-atyrode_code_generator__launch-bar">
            <button type="button" className="plugin-atyrode_code__primary-action" data-action={previewCurrent ? "atyrode.omp.prepareSession" : "atyrode.omp.reviewSession"} disabled={busy || !writable || !available || !launchReady || !!dials || !localReview || skillProblems.length > 0} aria-describedby={`${id}-launch-status`} onClick={() => {
              if (previewCurrent) { void launch(); return; }
              if (record && target) void perform(async () => { const value = await codeWorkflow(host).reviewSession(target, record.revision, prompt, { skills: skillChoice, automation }); if (destinationCurrent() && reviewScope.current.epoch === reviewEpoch && value.destination.machineId === machineId) { reviewedEpoch.current = reviewEpoch; setPreview(value); } });
            }}>{busy ? "Working…" : previewCurrent ? "Launch OMP" : "Review launch"}<span aria-hidden="true">{previewCurrent ? "↗" : "→"}</span></button>
          </div>
          <p id={`${id}-launch-status`} className="plugin-atyrode_code_generator__launch-status">{!record?.active ? "Choose models first." : !writable ? "Edit access needed." : dials ? "Save your profile first." : !available ? "Machine offline." : setup.error ? "Sessions unavailable on this machine." : !launchReady ? "Enable sessions when you're ready to run." : !localReview ? "Review your models." : skillProblems.length ? "Skill choices need attention." : previewCurrent ? "Ready to open a terminal." : "Review before opening a terminal."}</p>
          {previewCurrent && <div className="plugin-atyrode_code_generator__launch-review" role="status"><h3>Reviewed account pool</h3>
            <ul>{Object.entries(preview.composition.accountPool).map(([provider, accounts]) => <li key={provider} data-family={providerPolicy(provider)?.family ?? provider}><span>{providerPolicy(provider)?.label ?? provider}</span><span>{accounts.length} account{accounts.length === 1 ? "" : "s"}</span></li>)}</ul>
            <details className="plugin-atyrode_code__details"><summary>Exact accounts and runtime review</summary><pre>{JSON.stringify({ composition: preview.composition, native: preview.native }, null, 2)}</pre></details>
          </div>}
          <details className="plugin-atyrode_code_generator__disclosure" data-session-options><summary>Session options <span>{automation ? `Restricted · ${automation.toolNames.length} tools` : "Ordinary"} · {effectiveSkillMode === "disabled" ? "Skills off" : effectiveSkillMode === "preserve" ? "Default skills" : `${effectiveSkillCount} ${automation ? "sealed" : "selected"} skills`}</span></summary>
          <Automation choice={automation} reviewed={previewCurrent ? preview.native.automation : null} disabled={busy || !writable || !available}
            change={value => { setAutomation(value); setPreview(null); setMessage(null); }} />
          <OptionalSkills catalog={skillCatalog.data} error={skillCatalog.error} choice={skillChoice} restricted={automation?.mode === "restricted"} reviewed={previewCurrent ? preview.native.skills : null}
            disabled={busy || !writable || !available} refresh={skillCatalog.refresh} change={value => { setSkillChoice(value); setPreview(null); setMessage(null); }} />
          </details>
          {automation && <p className="plugin-atyrode_code__warning">Restricted OMP tools; not an OS or network sandbox.</p>}
          {record?.active && skillCatalog.error && <p role="status" className="plugin-atyrode_code__warning">Skills unavailable · see session options.</p>}
          {!!skillProblems.length && <p role="status" className="plugin-atyrode_code__warning">Optional skill choices need attention. Open session options to resolve them.</p>}
          {record?.active && !launchReady && <div className="plugin-atyrode_code_generator__next-action"><PermissionReview host={host} target={target} intent="session" label={setup.error ? "Check connection" : "Enable sessions"} onReady={refresh} /></div>}
          {record?.active && setup.error && <details className="plugin-atyrode_code__details"><summary>Connection details</summary><pre>{setup.error}</pre></details>}
        </section>
      </div>
      </section>
      <section className="plugin-atyrode_code_generator__pane plugin-atyrode_code_generator__profiles-pane" aria-label="Generated profiles" hidden={focus !== null && focus !== "profiles"}>
        <header className="plugin-atyrode_code_generator__pane-heading"><h2><DialIcon kind="lane" />Profiles <span>{shownReview ? `${shownReview.routes.length} roles` : "per agent"}</span></h2>{focusButton("profiles")}</header>
        {compiled && shownReview ? <Routing value={shownReview} catalog={compiled} local={dials !== null} compact={focus !== "profiles"} /> : <div className="plugin-atyrode_code_generator__empty"><DialIcon kind="thinking" /><span>Models for each agent will appear here.</span></div>}
      </section>
      <section className="plugin-atyrode_code_generator__pane plugin-atyrode_code_generator__usage-pane" aria-label="Usage overview" hidden={focus !== null && focus !== "usage"}>
        <header className="plugin-atyrode_code_generator__pane-heading"><h2><DialIcon kind="usage" />Usage</h2>{focusButton("usage")}</header>
        <UsageOverview host={host} compact={focus !== "usage"} onAccounts={() => setView("accounts")} />
      </section>
      </div>
      {record?.active && <footer className="plugin-atyrode_code_generator__footer"><details className="plugin-atyrode_code__details"><summary>Workspace details</summary><dl className="plugin-atyrode_code_generator__setup-facts"><dt>Shared revision</dt><dd>{record.revision}</dd><dt>Catalog models</dt><dd>{record.active.document.models.length}</dd><dt>Workspace</dt><dd>{host.containerId}</dd><dt>Destination</dt><dd>{machine?.name ?? "None"} · {machineId || "not selected"} · {available ? "connected" : "unavailable"}</dd></dl></details></footer>}
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
