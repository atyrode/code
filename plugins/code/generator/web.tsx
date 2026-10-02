import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import { formatManifoldUri, type MachineSummary } from "@manifold/protocol";
import { ControlIcon, ScrollRegion } from "@manifold/ui";
import { compileCatalog } from "../../domain/catalog.ts";
import { defaultSelection, reviewCatalog } from "../../domain/routing.ts";
import { catalogFromMetadata } from "../../domain/probe.ts";
import type { CatalogDocument, Selection } from "../../domain/contracts.ts";
import { familyPolicy, providerPolicy } from "../../domain/providers.ts";
import { GENERATOR_PLUGIN_ID, LAUNCHER_PANEL, type ActionResult, type Configuration, type Target } from "../contract.ts";
import { LAUNCH_OPERATION_ID, OMP_PLUGIN_ID, PROMPT_MAX_BYTES, type ModelCatalogSnapshot } from "@atyrode/manifold-omp";
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
type ProfileDraft = {
  source: "starter" | "active" | "draft";
  document: CatalogDocument;
  selection: Selection;
  revision: number;
  initialized: boolean;
  baseSelection: Selection | null;
  catalogDigest: string | null;
  draftDigest: string | null;
  metadata: ModelCatalogSnapshot | null;
  metadataKey: string | null;
};
function Workbench({ host, target, machine, machines, rosterError, available }: { host: HostServices; target: Target | null; machine: MachineSummary | null; machines: readonly MachineSummary[] | null; rosterError: string | null; available: boolean }) {
  const machineId = target?.machineId ?? "";
  const id = useId();
  const configuration = useCodeQuery(host, "readConfiguration", { containerId: host.containerId! });
  const metadata = useWorkflowQuery(host, "bundled-model-catalog", true, () => codeWorkflow(host).readStarterCatalog());
  const setup = useOmpQuery(host, "describeDestination", target);
  const classifier = useWorkflowQuery(host, `classifier:${JSON.stringify(target)}`, target !== null, () => codeWorkflow(host).classifier(target!));
  const defaults = useOmpQuery(host, "readDefaults", {});
  const skillCatalog = useWorkflowQuery(host, `skills:${JSON.stringify(target)}`, target !== null, () => codeWorkflow(host).readSkillCatalog(target!));
  const lastConfiguration = useRef(configuration.data);
  if (configuration.data) lastConfiguration.current = configuration.data;
  const [savedPolicy, setSavedPolicy] = useState<Configuration | null>(null);
  const observed = configuration.data ?? lastConfiguration.current;
  // An acknowledged CAS can precede its polled read. Keep the actual receipt,
  // but require a new canonical observation before reviewing another effect.
  const record = savedPolicy && (observed?.revision ?? -1) < savedPolicy.revision ? savedPolicy : observed?.configuration ?? null;
  const configurationCurrent = configuration.data !== null && configuration.error === null &&
    (savedPolicy === null || configuration.data.revision >= savedPolicy.revision);
  const [navigationState, setNavigationState] = useState<{ view: View; visited: readonly View[] }>({ view: "profile", visited: ["profile"] });
  const { view, visited } = navigationState;
  const [focus, setFocus] = useState<"generator" | "profiles" | "usage" | null>(null);
  const focusOrigin = useRef<HTMLButtonElement | null>(null);
  const [accountObservation, setAccountObservation] = useState("");
  function setView(next: View) {
    setNavigationState(previous => previous.view === next ? previous : {
      view: next, visited: previous.visited.includes(next) ? previous.visited : [...previous.visited, next],
    });
  }
  const [dials, setDials] = useState<ProfileDraft | null>(null);
  const [preview, setPreview] = useState<SessionReview | null>(null);
  const [skillChoice, setSkillChoice] = useState<SkillChoice>(undefined);
  const [automation, setAutomation] = useState<AutomationChoice>(undefined);
  const [savedSessionId, setSavedSessionId] = useState("");
  const [suggestion, setSuggestion] = useState<ActionResult<"suggest"> | null>(null);
  const [suggesting, setSuggesting] = useState(false);
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
  const storedDocument = useMemo(() => record?.active?.document ?? record?.draft?.document ?? null,
    [record?.active?.digest, record?.draft?.digest]);
  const metadataKey = useMemo(() => metadata.data === null ? null : JSON.stringify(metadata.data), [metadata.data]);
  const starter = useMemo(() => {
    if (dials || storedDocument || !configurationCurrent || !metadata.data) return { document: null, error: null };
    try { return { document: catalogFromMetadata(metadata.data, "any"), error: null }; }
    catch (reason) { return { document: null, error: reason instanceof Error ? reason.message : codeOperationFailure(reason) }; }
  }, [dials !== null, storedDocument, configurationCurrent, metadata.data]);
  const document = dials?.document ?? storedDocument ?? starter.document;
  const compiled = useMemo(() => {
    if (!document) return null;
    try { return compileCatalog(document); } catch { return null; }
  }, [document]);
  const initialSelection = useMemo(() => {
    if (!compiled) return null;
    try { return defaultSelection(compiled); } catch { return null; }
  }, [compiled]);
  const selection = dials?.selection ?? record?.selection ?? initialSelection;
  const profile = useMemo<ProfileDraft | null>(() => dials ?? (document && selection ? {
    source: record?.active ? "active" : record?.draft ? "draft" : "starter",
    document, selection, revision: record?.revision ?? observed?.revision ?? 0, initialized: record !== null,
    baseSelection: record?.selection ?? null, catalogDigest: record?.active?.digest ?? null,
    draftDigest: record?.draft?.digest ?? null, metadata: storedDocument ? null : metadata.data,
    metadataKey: storedDocument ? null : metadataKey,
  } : null), [dials, document, selection, record, observed?.revision, storedDocument, metadata.data, metadataKey]);
  // Freeze first-use material before the controls become interactive. Polls and
  // competing initialization can invalidate it, never silently replace it.
  useLayoutEffect(() => {
    if (dials === null && profile?.source === "starter") setDials(profile);
  }, [dials, profile]);
  const localReview = useMemo(() => {
    if (!compiled || !selection) return null;
    try { return reviewCatalog(compiled, selection, Date.now()); } catch { return null; }
  }, [compiled, selection]);
  const controlsReview = useMemo(() => {
    if (localReview || !compiled || !selection || !initialSelection) return localReview;
    try { return reviewCatalog(compiled, { ...initialSelection, budget: selection.budget }, Date.now()); } catch { return null; }
  }, [localReview, compiled, selection, initialSelection]);
  const stale = dials !== null && configurationCurrent && (
    dials.revision !== configuration.data!.revision || dials.initialized !== (configuration.data!.configuration !== null) ||
    dials.catalogDigest !== (record?.active?.digest ?? null) || dials.draftDigest !== (record?.draft?.digest ?? null) ||
    JSON.stringify(dials.baseSelection) !== JSON.stringify(record?.selection ?? null) ||
    (dials.source === "starter" && metadataKey !== null && dials.metadataKey !== metadataKey));
  const unsaved = dials !== null || profile?.source !== "active";
  const draftSkills = skillDraft(skillCatalog.data, skillChoice);
  const skillProblems = draftSkills.problems;
  const writable = canWriteCodeWorkspace(host);
  const canSuggest = !!record?.active && classifier.data !== null && classifier.data !== undefined;
  const launchReady = operationReady(setup.data, LAUNCH_OPERATION_ID);
  const authority = useRef({ client: host.client, authoring: host.authoring, writable, epoch: 0 });
  if (authority.current.client !== host.client || authority.current.authoring !== host.authoring || authority.current.writable !== writable)
    authority.current = { client: host.client, authoring: host.authoring, writable, epoch: authority.current.epoch + 1 };
  const draftGeneration = useRef({ value: dials, epoch: 0 });
  if (draftGeneration.current.value !== dials) draftGeneration.current = { value: dials, epoch: draftGeneration.current.epoch + 1 };
  const sourceGeneration = useRef({ key: metadataKey, failed: metadata.error !== null, epoch: 0 });
  if (sourceGeneration.current.key !== metadataKey || sourceGeneration.current.failed !== (metadata.error !== null))
    sourceGeneration.current = { key: metadataKey, failed: metadata.error !== null, epoch: sourceGeneration.current.epoch + 1 };
  // Loss and identical recovery are distinct generations. Neither can revive an
  // old confirmation, even when every durable revision stays the same.
  const reviewKey = JSON.stringify([generation, authority.current.epoch, draftGeneration.current.epoch, sourceGeneration.current.epoch,
    machineId, available, rosterError !== null, configurationCurrent, record?.revision, record?.active?.digest, record?.draft?.digest,
    record?.selection, defaults.data?.revision, defaults.error !== null, skillCatalog.data?.revision, skillCatalog.error !== null,
    setup.error !== null, setup.data === null, accountObservation, prompt, skillChoice, automation, savedSessionId]);
  const reviewScope = useRef({ key: reviewKey, epoch: 0 });
  if (reviewScope.current.key !== reviewKey) reviewScope.current = { key: reviewKey, epoch: reviewScope.current.epoch + 1 };
  // Exact CAS arbitrates shared revision changes. Observing this save's own
  // successful revision must not revoke its acknowledgement. Lost observations
  // and changed local intent still revoke policy confirmation monotonically.
  const policyKey = JSON.stringify([generation, authority.current.epoch, draftGeneration.current.epoch, sourceGeneration.current.epoch,
    configuration.data === null, configuration.error !== null, prompt, skillChoice, automation, savedSessionId]);
  const policyScope = useRef({ key: policyKey, epoch: 0 });
  if (policyScope.current.key !== policyKey) policyScope.current = { key: policyKey, epoch: policyScope.current.epoch + 1 };
  const policyEpoch = policyScope.current.epoch;
  const reviewedEpoch = useRef(-1);
  const reviewEpoch = reviewScope.current.epoch;
  const previewCurrent = preview !== null && reviewedEpoch.current === reviewEpoch && writable && available && configurationCurrent &&
    defaults.error === null && skillCatalog.error === null && setup.error === null && !!record?.active &&
    preview.destination.machineId === machineId && preview.composition.revision === record?.revision &&
    preview.composition.prompt === prompt && preview.native.defaultsRevision === defaults.data?.revision && !unsaved &&
    skillProblems.length === 0 && (preview.native.skills.mode !== "selected" || preview.native.skills.catalogRevision === skillCatalog.data?.revision);
  const effectiveSkillMode = previewCurrent ? preview.native.skills.mode : skillChoice?.mode ?? (automation ? "disabled" : "preserve");
  const effectiveSkillCount = previewCurrent ? preview.native.skills.selected.length : draftSkills.selected.length;
  const shownReview = previewCurrent ? preview.composition.review : localReview;
  function policyCurrent() {
    return mounted.current && policyScope.current.epoch === policyEpoch && current.current.host.client === host.client &&
      current.current.host.principal.id === host.principal.id && current.current.host.containerId === host.containerId &&
      canWriteCodeWorkspace(current.current.host);
  }
  function updateSelection(value: Selection) {
    if (!profile) return;
    let nextDocument = profile.document;
    if (profile.metadata && value.budget !== profile.selection.budget) {
      try { nextDocument = catalogFromMetadata(profile.metadata, value.budget); }
      catch (reason) { setMessage({ text: reason instanceof Error ? reason.message : codeOperationFailure(reason), failed: true }); return; }
    }
    setDials({ ...profile, document: nextDocument, selection: value });
    setPreview(null); setSuggestion(null); setMessage(null);
  }
  function discardChanges() {
    setDials(null); setSavedPolicy(null); setPreview(null); setSuggestion(null); setMessage(null);
  }
  async function saveProfile() {
    if (!profile || !configurationCurrent || stale || !localReview || (profile.source === "starter" && (metadata.data === null || metadata.error !== null))) return;
    await perform(async () => {
      const saved = profile.metadata ? await codeWorkflow(host, policyCurrent).adoptStarterProfile({
        containerId: host.containerId!, expectedRevision: profile.revision, metadata: profile.metadata, selection: profile.selection,
      }, policyCurrent) : await codeWorkflow(host, policyCurrent).code("select", {
        containerId: host.containerId!, expectedRevision: profile.revision, selection: profile.selection,
      });
      if (!policyCurrent()) throw new Error("Profile confirmation changed. Observe the shared result before trying again.");
      setSavedPolicy(saved); setDials(null); setPreview(null);
      setMessage({ text: "Profile saved. Review the launch when you're ready.", failed: false });
    });
  }
  const exportedDraft = useMemo(() => profile?.metadata ? JSON.stringify({
    baseRevision: profile.revision, metadata: profile.metadata, document: profile.document, selection: profile.selection,
  }, null, 2) : profile && dials ? JSON.stringify({ baseRevision: profile.revision, document: profile.document, selection: profile.selection }, null, 2) : "", [profile, dials]);
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
  function refresh() { configuration.refresh(); metadata.refresh(); setup.refresh(); classifier.refresh(); defaults.refresh(); skillCatalog.refresh(); }
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
      (withProfile && (!configurationCurrent || !record?.active || unsaved || !localReview))) return;
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
        <button type="button" data-action="atyrode.omp.resumeSession" disabled={busy || !writable || !available || !savedSessionId || running || !configurationCurrent || !record?.active || unsaved || !localReview || skillProblems.length > 0} onClick={() => void resume(true)}>Resume with this profile</button>
      </div>
    </>}
  </FleetSessions></details>;
  const profileState = stale ? "conflict" : unsaved ? "local" : "saved";
  const stateLabel = !configurationCurrent ? "Shared choices unavailable" : stale ? "Shared profile changed" :
    profile?.source === "starter" ? "Local starter · not saved" : profile?.source === "draft" ? "Staged catalog preview" : dials ? "Local changes" : "Saved profile";
  const navigation = <header className="plugin-atyrode_code_generator__workspace-nav">
    <nav aria-label="Code workspace">
      <button type="button" aria-current={view === "profile" ? "page" : undefined} disabled={busy} onClick={back}><DialIcon kind="model" />Workbench</button>
      <button type="button" aria-current={view === "accounts" ? "page" : undefined} disabled={busy} onClick={() => { setView("accounts"); refresh(); }}><DialIcon kind="advisor" />Accounts</button>
      <button type="button" aria-current={view === "catalog" ? "page" : undefined} disabled={busy} onClick={() => { setView("catalog"); refresh(); }}><DialIcon kind="lane" />Models</button>
      <button type="button" aria-current={view === "setup" ? "page" : undefined} disabled={busy} onClick={() => { setView("setup"); refresh(); }}><ControlIcon kind="settings" size={14} />Setup</button>
    </nav>
    {profile && <span className="plugin-atyrode_code_generator__profile-state" data-state={profileState} role="status"><span aria-hidden="true" />{stateLabel}</span>}
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
  const lead = shownReview?.routes.find(route => route.role === "default");
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
      {(metadata.error || starter.error) && <div className="plugin-atyrode_code__notice" role="status"><p>Bundled model source unavailable{profile ? " · displayed material is retained, not a fresh source observation" : ""}.</p><button type="button" data-action="atyrode.omp.readModelCatalog" onClick={metadata.refresh}>Retry model source</button><details className="plugin-atyrode_code__details"><summary>Details</summary><pre>{metadata.error ?? starter.error}</pre></details></div>}
      <div className="plugin-atyrode_code_generator__controls" aria-label="Profile controls">
        {!profile && !document && !configuration.error && !starter.error && !metadata.error && <p role="status">{!configuration.data ? "Reading shared choices…" : "Reading bundled model facts…"}</p>}
        {compiled && selection && controlsReview ? <Dials selection={selection} review={controlsReview} catalog={compiled} disabled={busy} update={updateSelection} /> :
          document ? <p role="status" className="plugin-atyrode_code__warning">These choices need a model review. <button type="button" onClick={() => setView("catalog")}>Review in Models</button></p> : null}
        {(profile?.source === "draft" || (!dials && !!record?.draft && !record.active)) && <div className="plugin-atyrode_code__notice"><p>Previewing the saved staged catalog. It has not replaced the active workspace policy.</p><button type="button" onClick={() => setView("catalog")}>Review staged catalog in Models</button></div>}
        {dials && <div className="plugin-atyrode_code_generator__draft" data-stale={stale}>
          {stale && <p role="status">Shared policy or model facts changed. This local draft is still based on revision {dials.revision}; it cannot overwrite revision {configuration.data?.revision}. Keep a copy, or explicitly discard and use the current source.</p>}
          <div className="plugin-atyrode_code__toolbar">
            {dials.source !== "draft" && <button type="button" className="plugin-atyrode_code__primary-action"
              data-action={dials.metadata ? "atyrode.code.adoptStarterProfile" : "atyrode.code.select"}
              disabled={busy || !writable || !configurationCurrent || stale || !localReview || (!!dials.metadata && (metadata.data === null || metadata.error !== null))}
              onClick={() => void saveProfile()}>{busy ? "Saving…" : "Save profile"}</button>}
            <button type="button" disabled={busy} onClick={discardChanges}>{stale ? "Discard and use current" : "Discard changes"}</button>
          </div>
          <details className="plugin-atyrode_code__details plugin-atyrode_code_generator__source-details">
            <summary data-starter-details={dials.metadata ? "" : undefined}>Local profile &amp; source</summary>
            <p>Not persisted. Task text is independent and excluded from this export. {dials.metadata ? `Bundled OMP ${dials.metadata.ompVersion} · metadata revision ${dials.metadata.revision}. Performance is unmeasured; availability and accounts require their own observations.` : "This draft retains the exact stored catalog it was based on. Its historical source provenance is unrecorded."}</p>
            <label htmlFor={`${id}-export`}>Copy local profile</label>
            <textarea id={`${id}-export`} data-starter-export={dials.metadata ? "" : undefined} data-profile-export readOnly rows={5} value={exportedDraft} />
          </details>
        </div>}
        {shownReview && compiled && <Estimates value={shownReview.estimates} measured={shownReview.routes.every(route => compiled.model(route.lead.key).tokensPerSecond !== null)} />}
      </div>
      </section>
      <section className="plugin-atyrode_code_generator__pane plugin-atyrode_code_generator__profiles-pane" aria-label="Generated profiles" hidden={focus !== null && focus !== "profiles"}>
        <header className="plugin-atyrode_code_generator__pane-heading"><h2><span className="plugin-atyrode_code_generator__section-number">02</span>Agent profiles <span>{shownReview ? `${shownReview.routes.length} roles` : "per agent"}</span></h2>{focusButton("profiles")}</header>
        {compiled && shownReview ? <Routing value={shownReview} catalog={compiled} local={unsaved} compact={focus !== "profiles"} /> : <p className="plugin-atyrode_code_generator__empty" role="status">{document ? "This catalog cannot resolve a complete per-agent profile for these choices. Review Models; no default has been substituted." : "Profiles appear after shared choices and model facts are read."}</p>}
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
          <textarea id={`${id}-prompt`} rows={2} maxLength={PROMPT_MAX_BYTES} value={prompt} placeholder="What should we tackle?" onChange={event => { setPrompt(event.target.value); setPreview(null); setSuggestion(null); }} />
          {canSuggest && record && <div className="plugin-atyrode_code_generator__suggestion">
            {!suggesting ? <button type="button" aria-expanded={false} onClick={() => setSuggesting(true)}>Suggest a profile from this task <span aria-hidden="true">→</span></button> : <>
              <p className="plugin-atyrode_code__muted">Explicitly sends this task to the configured classifier. Nothing is saved; inspect its proposed changes first.</p>
              <div className="plugin-atyrode_code__toolbar"><button type="button" data-action="atyrode.code.suggest" disabled={busy || !writable || !available || !configurationCurrent || !prompt.trim() || prompt.length > 16384 || !classifier.data} onClick={() => {
                if (target && classifier.data) void perform(async () => {
                  const value = await callCodeAction(host, "suggest", { ...target, expectedRevision: record.revision, expectedServiceRevision: classifier.data!.revision, prompt });
                  if (destinationCurrent() && reviewScope.current.epoch === reviewEpoch) setSuggestion(value);
                });
              }}>{busy ? "Working…" : "Suggest profile"}</button><button type="button" disabled={busy} onClick={() => { setSuggesting(false); setSuggestion(null); }}>Close suggestion</button></div>
              {prompt.length > 16384 && <p role="status">The classifier accepts up to 16,384 characters. The task is retained in full, never truncated.</p>}
              {suggestion && <div className="plugin-atyrode_code__notice"><p>{suggestion.changed.length ? `Suggested changes: ${suggestion.changed.join(", ")}` : "Your current profile already fits."}</p>
                <dl className="plugin-atyrode_code_generator__suggested-values">{suggestion.changed.map(key => <div key={key}><dt>{key}</dt><dd>{typeof suggestion.selection[key] === "object" ? JSON.stringify(suggestion.selection[key]) : String(suggestion.selection[key])}</dd></div>)}</dl>
                <button type="button" disabled={busy || unsaved || suggestion.revision !== record.revision || suggestion.serviceRevision !== classifier.data?.revision}
                  onClick={() => { updateSelection(suggestion.selection); setSuggesting(false); }}>Try this profile</button>
                {unsaved && <p>Save or discard your local changes before trying a suggestion.</p>}
                {(suggestion.revision !== record.revision || suggestion.serviceRevision !== classifier.data?.revision) && <p role="status">Shared choices or classifier policy changed. Request a new suggestion.</p>}
              </div>}
            </>}
          </div>}
          <div className="plugin-atyrode_code_generator__launch-bar">
            <button type="button" className="plugin-atyrode_code__primary-action" data-action={previewCurrent ? "atyrode.omp.prepareSession" : "atyrode.omp.reviewSession"} disabled={busy || !writable || !available || !configurationCurrent || !record?.active || !launchReady || unsaved || !localReview || skillProblems.length > 0} aria-describedby={`${id}-launch-status`} onClick={() => {
              if (previewCurrent) { void launch(); return; }
              if (record && target) void perform(async () => { const value = await codeWorkflow(host, () => destinationCurrent() && reviewScope.current.epoch === reviewEpoch && canWriteCodeWorkspace(current.current.host)).reviewSession(target, record.revision, prompt, { skills: skillChoice, automation }); if (destinationCurrent() && reviewScope.current.epoch === reviewEpoch && value.destination.machineId === machineId) { reviewedEpoch.current = reviewEpoch; setPreview(value); } });
            }}>{busy ? "Working…" : previewCurrent ? "Launch OMP" : "Review launch"}<span aria-hidden="true">{previewCurrent ? "↗" : "→"}</span></button>
          </div>
          <p id={`${id}-launch-status`} className="plugin-atyrode_code_generator__launch-status">{!configurationCurrent ? "Shared choices need a fresh observation." : profile?.source === "draft" ? "Review and promote the staged catalog first." : unsaved || !record?.active ? "Save this profile before launch review." : !writable ? "Edit access needed." : !available ? "Runtime unavailable · profile and task are retained." : setup.error ? "Sessions unavailable on this machine." : !launchReady ? "Review native session permissions when you're ready to run." : !localReview ? "Review your models." : skillProblems.length ? "Skill choices need attention." : previewCurrent ? "Ready to open a terminal." : "Review before opening a terminal."}</p>
          {previewCurrent && <div className="plugin-atyrode_code_generator__launch-review" role="status"><h3>Reviewed account pool</h3>
            <ul>{Object.entries(preview.composition.accountPool).map(([provider, accounts]) => <li key={provider} data-family={providerPolicy(provider)?.family ?? provider}><span>{providerPolicy(provider)?.label ?? provider}</span><span>{accounts.length} account{accounts.length === 1 ? "" : "s"}</span></li>)}</ul>
            <details className="plugin-atyrode_code__details"><summary>Exact accounts and runtime review</summary><pre>{JSON.stringify({ composition: preview.composition, native: preview.native }, null, 2)}</pre></details>
          </div>}
          <details className="plugin-atyrode_code_generator__disclosure" data-session-options><summary>This launch options <span>{automation ? `Restricted · ${automation.toolNames.length} tools` : "Ordinary"} · {effectiveSkillMode === "disabled" ? "Skills off" : effectiveSkillMode === "preserve" ? "Default skills" : `${effectiveSkillCount} ${automation ? "sealed" : "selected"} skills`}</span></summary>
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
