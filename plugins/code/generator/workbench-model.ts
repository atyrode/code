import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { formatManifoldUri, type MachineSummary } from "@manifold/protocol";
import { compileCatalog, type CompiledCatalog } from "../../domain/catalog.ts";
import { servedProviders } from "../../domain/accounts.ts";
import { defaultSelection, routeService, type Review, type ServiceGap } from "../../domain/routing.ts";
import { catalogFromMetadata } from "../../domain/probe.ts";
import type { AccountChoiceChange, CatalogDocument, Selection } from "../../domain/contracts.ts";
import type { ActionResult, Configuration, Target } from "../contract.ts";
import { LAUNCH_OPERATION_ID, OMP_PLUGIN_ID, type ActionResult as OmpResult, type ModelCatalogSnapshot } from "@atyrode/manifold-omp";
import type { ChargeReview, SessionReview } from "../workflow.ts";
import { ACCOUNT_REFRESH_MS, callCodeAction, codeWorkflow, canWriteCodeWorkspace, codeOperationFailure, useCodeQuery, useOmpQuery, useWorkflowQuery } from "../machine-web.ts";
import { operationReady } from "../permission-plan.ts";
import { useMinuteTick } from "../ui.tsx";
import { useAccountUsage } from "../usage-view.tsx";
import type { BoardUsage } from "./board-model.ts";
import { skillDraft, type SkillChoice } from "./skill-draft.ts";
import type { AutomationChoice } from "./automation.tsx";
import { actionGate, autoReviewDue, AUTO_REVIEW_SETTLE_MS, launchStatusText, nextLaunchStep,
  type GateFacts, type GateVerdict, type LaunchStep, type ProfileSource, type WorkbenchIntent } from "./launch-step.ts";
import { previewSelection } from "./dial-space.ts";
import { browserTeamStorage, readRecentTeams, recentTeamsKey, rememberLaunch, type RecentTeam } from "./recent-teams.ts";
import { useModelVerification, type ModelVerification } from "./model-verification.ts";
import type { ConfirmActivation } from "./verification.ts";

/** The profile the controls show: the frozen local draft, or one derived from the shared record
 * or the bundled preview. A `starter` profile is render-only: verification is what saves it. */
export type ProfileDraft = {
  source: ProfileSource;
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
/** A polled observation (machine-web.ts `useWorkflowQuery`): `data` and `error` are mutually exclusive. */
export type WorkbenchQuery<T> = { data: T | null; error: string | null; refreshing: boolean; refresh: () => void };
export type WorkbenchQueries = {
  configuration: WorkbenchQuery<ActionResult<"readConfiguration">>;
  metadata: WorkbenchQuery<ModelCatalogSnapshot>;
  setup: WorkbenchQuery<OmpResult<"describeDestination">>;
  defaults: WorkbenchQuery<OmpResult<"readDefaults">>;
  skillCatalog: WorkbenchQuery<OmpResult<"readSkillCatalog">>;
  /** OMP's account observation: who is signed in, which the saved choices include, and its freshness. */
  accounts: WorkbenchQuery<OmpResult<"accounts">>;
};
export type WorkbenchMessage = { text: string; failed: boolean };
/** A step in flight, for the verb to name it. */
export type WorkbenchStep = "save" | "review" | "launch" | "resume";
/** What the last launch or resume opened, until the team, machine or pool changes. */
export type WorkbenchOutcome = { kind: "launched" | "resumed"; machine: string };
export type ProfileState = "conflict" | "local" | "saved";
export type EffectiveSkillMode = SessionReview["native"]["skills"]["mode"] | NonNullable<SkillChoice>["mode"];
export type WorkbenchInput = { host: HostServices; target: Target | null; machine: MachineSummary | null; rosterError: string | null; available: boolean };

/**
 * Every effect the workbench can start. Each asks the one gate (launch-step.ts `actionGate`) before
 * it starts and, in a chain, again before each later step; a refused one does nothing.
 */
export type WorkbenchActions = {
  /** Edit the profile controls. Re-derives a starter document for a new budget; revokes the review. */
  updateSelection: (value: Selection) => void;
  /** Recall a team this browser launched, if the current catalog still forms it exactly; otherwise say so. */
  recallTeam: (team: RecentTeam) => void;
  /** Drop the local draft and any acknowledged CAS receipt; return to the observed shared profile. */
  discardChanges: () => void;
  /** The verb: prepare a verification, save then review once the save is observed, review, or launch. */
  next: () => void;
  /** Prepare a verification: inventory, then the charge, which spends nothing until `confirmCharge`. */
  verify: () => void;
  /** CAS-save a local edit of the active profile, without reviewing it. */
  save: () => Promise<void>;
  /** Spend the verification charge the control showed (model-verification.ts `confirm`). */
  confirmCharge: (activation: ConfirmActivation, shown: ChargeReview) => void;
  /** Resume the selected saved session, optionally replacing its model choices with this saved team. */
  resume: (withTeam: boolean) => Promise<void>;
  /**
   * Edit the saved account choices (`changeAccounts`) at the exact observed revision, never retried,
   * never an inclusion on a historical inventory; one edit at a time, through the accounts gate.
   */
  changeAccounts: (edit: AccountChoiceChange) => void;
  /** Re-observe every query, accounts and usage included. */
  refresh: () => void;
};

export type WorkbenchModel = {
  queries: WorkbenchQueries;
  /** Last canonical configuration observation, retained while a poll fails. */
  observed: ActionResult<"readConfiguration"> | null;
  /** Shared workspace policy: an acknowledged save receipt until a read catches up with it, else the observation. */
  record: Configuration | null;
  machineId: string;
  document: CatalogDocument | null;
  /** Why the bundled preview could not be derived, if it could not. */
  starterError: string | null;
  compiled: CompiledCatalog | null;
  selection: Selection | null;
  profile: ProfileDraft | null;
  /** The frozen local draft (starter or edit); null while the shown profile is the shared record. */
  localDraft: ProfileDraft | null;
  /** The review to display: the reviewed launch composition while `previewCurrent`, else `localReview`. */
  review: Review | null;
  localReview: Review | null;
  /** `localReview`, or the default selection at the chosen budget so the controls stay usable when it fails. */
  controlsReview: Review | null;
  /** The reviewed session; non-null exactly while `previewCurrent`. */
  launchReview: SessionReview | null;
  configurationCurrent: boolean;
  unsaved: boolean;
  stale: boolean;
  writable: boolean;
  available: boolean;
  /** Native session launch permission is ready on the destination. */
  launchReady: boolean;
  previewCurrent: boolean;
  /** An action is in flight (`perform`); the verb shows `inFlight`. */
  busy: boolean;
  inFlight: WorkbenchStep | null;
  /** A save waits for its revision to be observed before its review (the verb's "Save & review"). */
  chaining: boolean;
  profileState: ProfileState;
  stateLabel: string;
  /** The launch status sentence; `nextLaunchStep`'s precedence (launch-step.ts). */
  launchStatus: string;
  message: WorkbenchMessage | null;
  /** Copyable JSON of the local profile; empty when there is nothing local to export. */
  exportedDraft: string;
  /**
   * Whether an action may start now: the one gate every action path asks (launch-step.ts
   * `actionGate`). A resume names the session it would resume, so a row can be judged before it is
   * chosen; without one, the chosen session is judged.
   */
  gate: (intent: WorkbenchIntent, sessionId?: string) => GateVerdict;
  /** The verb's next step, and the gate's verdict on it (a blocked step's verdict carries its reason). */
  step: LaunchStep;
  verb: GateVerdict;
  /** The providers a launch's pool would serve (accounts.ts `servedProviders`), when known. Stable while they are the same. */
  served: ReadonlySet<string> | null;
  /** A lead of the shown team no included account serves, which the session door refuses. */
  unservedLead: ServiceGap | null;
  outcome: WorkbenchOutcome | null;
  /** The usage reading every pool is judged on, and the saved account choices with their guarded edit. */
  usage: BoardUsage;
  skillChoice: SkillChoice;
  /** Choices revoke the current review and clear the message. */
  setSkillChoice: (value: SkillChoice) => void;
  skillProblems: string[];
  effectiveSkillMode: EffectiveSkillMode;
  effectiveSkillCount: number;
  automation: AutomationChoice;
  /** Choices revoke the current review and clear the message. */
  setAutomation: (value: AutomationChoice) => void;
  savedSessionId: string;
  /** Stable identity: consumers use it as an effect dependency. */
  setSavedSessionId: (id: string) => void;
  actions: WorkbenchActions;
  /** Whether the active catalog's verification holds, and the verify flow that renews it. */
  verification: ModelVerification;
  /** Teams this browser launched in this workspace, newest first. Device-local and never shared (recent-teams.ts). */
  recentTeams: readonly RecentTeam[];
};

/** Owns the workbench's state, observations, safety checks and actions; presentation stays with the caller. */
export function useWorkbench({ host, target, machine, rosterError, available }: WorkbenchInput): WorkbenchModel {
  const machineId = target?.machineId ?? "";
  const configuration = useCodeQuery(host, "readConfiguration", { containerId: host.containerId! });
  const metadata = useWorkflowQuery(host, "bundled-model-catalog", true, () => codeWorkflow(host).readStarterCatalog());
  const setup = useOmpQuery(host, "describeDestination", target);
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
  // The account observation and its usage reading: every pool head, fate and redline is judged on
  // them, and the session door builds its pool from the same observation and saved choices.
  const accounts = useOmpQuery(host, "accounts", {}, ACCOUNT_REFRESH_MS);
  const choices = observed?.configuration?.accounts ?? null;
  const reading = useAccountUsage(host, choices, accounts.data);
  const historicalChoices = configuration.data === null && choices !== null;
  const historicalAccounts = historicalChoices || accounts.data === null || accounts.data.status !== "fresh" ||
    configuration.error !== null || accounts.error !== null;
  // Ages and elapsed ticks move once a minute; within one, every pool is judged on the same clock.
  const minute = useMinuteTick();
  const nowMs = useMemo(() => Date.now(), [minute]);
  // Any change to the account observation revokes a reviewed launch, so it is part of the review's scope.
  const accountObservation = useMemo(() => JSON.stringify([configuration.error !== null, accounts.error !== null, reading.error !== null,
    accounts.data?.status, accounts.data?.scope, accounts.data?.accounts]), [configuration.error, accounts.error, reading.error, accounts.data]);
  // The pool the session door would build: from the account observation and the saved choices, not
  // from usage readings. A fresh observation with nothing included is an empty set, never unknown.
  const servedKey = useMemo(() => {
    if (!accounts.data || !configuration.data?.configuration || accounts.error !== null || configuration.error !== null) return null;
    const providers = servedProviders(accounts.data, configuration.data.configuration.accounts);
    return providers === null ? null : JSON.stringify([...providers].sort());
  }, [accounts.data, accounts.error, configuration.data, configuration.error]);
  const served = useMemo<ReadonlySet<string> | null>(() => servedKey === null ? null : new Set(JSON.parse(servedKey) as string[]), [servedKey]);
  const [accountsPending, setAccountsPending] = useState(false);
  const [accountsFailure, setAccountsFailure] = useState<string | null>(null);
  const accountsBusy = useRef(false);
  const [dials, setDials] = useState<ProfileDraft | null>(null);
  const [preview, setPreview] = useState<SessionReview | null>(null);
  const [skillChoice, setSkillChoice] = useState<SkillChoice>(undefined);
  const [automation, setAutomation] = useState<AutomationChoice>(undefined);
  const [savedSessionId, setSavedSessionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [inFlight, setInFlight] = useState<WorkbenchStep | null>(null);
  const [chaining, setChaining] = useState(false);
  const [message, setMessage] = useState<WorkbenchMessage | null>(null);
  const [outcome, setOutcome] = useState<WorkbenchOutcome | null>(null);
  const recentKey = recentTeamsKey(host.principal.id, host.containerId!);
  const [recentTeams, setRecentTeams] = useState(() => readRecentTeams(browserTeamStorage(), recentKey));
  const pending = useRef(false);
  const mounted = useRef(false);
  const destination = useRef({ machineId: machineId, generation: 0 });
  if (destination.current.machineId !== machineId) destination.current = { machineId: machineId, generation: destination.current.generation + 1 };
  const generation = destination.current.generation;
  const current = useRef({ host, machine, available, target });
  current.current = { host, machine, available, target };
  function destinationCurrent() {
    return mounted.current && generation === destination.current.generation &&
      current.current.host.client === host.client && current.current.host.authoring === host.authoring &&
      current.current.target?.machineId === machineId && current.current.available;
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { setPreview(null); setSkillChoice(undefined); setAutomation(undefined); setSavedSessionId(""); }, [machineId]);
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
    return previewSelection(compiled, selection);
  }, [compiled, selection]);
  const controlsReview = useMemo(() => {
    if (localReview || !compiled || !selection || !initialSelection) return localReview;
    return previewSelection(compiled, { ...initialSelection, budget: selection.budget });
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
  const launchReady = operationReady(setup.data, LAUNCH_OPERATION_ID);
  // A confirmed verification is itself the save of the shown selection: the bundled preview's
  // dials, or the active profile's, narrowed to what the verified catalog hosts.
  const verification = useModelVerification({ host, target, record, revision: profile?.revision ?? observed?.revision ?? 0,
    configurationCurrent, selection, ompVersion: metadata.data?.ompVersion ?? null, setup: setup.data, writable, available,
    onVerified: saved => {
      setSavedPolicy(saved); setDials(null); setPreview(null);
      setMessage({ text: "Models verified with your accounts and the profile saved. Review the launch when you're ready.", failed: false });
    } });
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
    setup.error !== null, setup.data === null, accountObservation, skillChoice, automation, savedSessionId, verification.status]);
  const reviewScope = useRef({ key: reviewKey, epoch: 0 });
  if (reviewScope.current.key !== reviewKey) reviewScope.current = { key: reviewKey, epoch: reviewScope.current.epoch + 1 };
  // Exact CAS arbitrates shared revision changes. Observing this save's own
  // successful revision must not revoke its acknowledgement. Lost observations
  // and changed local intent still revoke policy confirmation monotonically.
  const policyKey = JSON.stringify([generation, authority.current.epoch, draftGeneration.current.epoch, sourceGeneration.current.epoch,
    configuration.data === null, configuration.error !== null, skillChoice, automation, savedSessionId]);
  const policyScope = useRef({ key: policyKey, epoch: 0 });
  if (policyScope.current.key !== policyKey) policyScope.current = { key: policyKey, epoch: policyScope.current.epoch + 1 };
  const policyEpoch = policyScope.current.epoch;
  const reviewedEpoch = useRef(-1);
  const reviewEpoch = reviewScope.current.epoch;
  const previewCurrent = preview !== null && reviewedEpoch.current === reviewEpoch && writable && available && configurationCurrent &&
    defaults.error === null && skillCatalog.error === null && setup.error === null && !!record?.active &&
    preview.destination.machineId === machineId && preview.composition.revision === record?.revision &&
    preview.native.defaultsRevision === defaults.data?.revision && !unsaved &&
    skillProblems.length === 0 && (preview.native.skills.mode !== "selected" || preview.native.skills.catalogRevision === skillCatalog.data?.revision);
  const effectiveSkillMode = previewCurrent ? preview.native.skills.mode : skillChoice?.mode ?? (automation ? "disabled" : "preserve");
  const effectiveSkillCount = previewCurrent ? preview.native.skills.selected.length : draftSkills.selected.length;
  const shownReview = previewCurrent ? preview.composition.review : localReview;
  // The session door's rule on the team the verb acts on: a lead nobody serves refuses, fallbacks are pruned.
  const unservedLead = served && compiled && shownReview ? routeService(compiled, shownReview.routes, provider => served.has(provider)).lead : null;
  const verifyRunning = verification.phase === "inventory" || verification.phase === "benchmark";
  const facts: GateFacts = { configurationCurrent, profile, localDraft: dials, record, unsaved, stale, writable, available, launchReady,
    previewCurrent, localReview, skillProblems, queries: { setup }, verification,
    running: busy || chaining || verifyRunning, charge: verification.phase === "charge" ? verification.charge : null,
    unservedLead, savedSessionId, planYolo: record?.selection?.planYolo ?? false };
  // A chain's later steps ask the gate again on the facts of the latest render, its own step set aside.
  const latestFacts = useRef(facts);
  latestFacts.current = facts;
  function stillOpen(intent: WorkbenchIntent): GateVerdict {
    return actionGate({ ...latestFacts.current, running: false }, intent);
  }
  /** An action starts only when the gate lets it and nothing started earlier in this same turn. */
  function allowed(intent: WorkbenchIntent): boolean {
    return !pending.current && actionGate(facts, intent).open;
  }
  const step = nextLaunchStep(facts);
  const verb: GateVerdict = step.step === "blocked" ? { open: false, refusal: step.reason } : actionGate(facts, step.step);
  function policyCurrent() {
    return mounted.current && policyScope.current.epoch === policyEpoch && current.current.host.client === host.client &&
      current.current.host.principal.id === host.principal.id && current.current.host.containerId === host.containerId &&
      canWriteCodeWorkspace(current.current.host);
  }
  /** The catalog a selection is shown against: a bundled starter is re-derived for a new budget. Null, with the reason said, when that fails. */
  function documentFor(value: Selection): CatalogDocument | null {
    if (!profile) return null;
    if (!profile.metadata || value.budget === profile.selection.budget) return profile.document;
    try { return catalogFromMetadata(profile.metadata, value.budget); }
    catch (reason) { setMessage({ text: reason instanceof Error ? reason.message : codeOperationFailure(reason), failed: true }); return null; }
  }
  function applySelection(document: CatalogDocument, value: Selection) {
    if (!profile) return;
    setDials({ ...profile, document, selection: value });
    setPreview(null); setMessage(null);
  }
  function updateSelection(value: Selection) {
    if (!profile || !allowed("edit-team")) return;
    const document = documentFor(value);
    if (document) applySelection(document, value);
  }
  function recallTeam(team: RecentTeam) {
    if (!profile || !allowed("edit-team")) return;
    const document = documentFor(team.selection);
    if (!document) return;
    let formed: Review | null = null;
    try { formed = previewSelection(compileCatalog(document), team.selection); } catch { /* A catalog that does not compile forms no team. */ }
    // Recalled exactly or not at all: a team quietly narrowed to the current catalog is not the team that was launched.
    if (!formed) { setMessage({ text: "That team is not in the current catalog; nothing changed.", failed: true }); return; }
    applySelection(document, team.selection);
  }
  function discardChanges() {
    if (!allowed("edit-team")) return;
    setDials(null); setSavedPolicy(null); setPreview(null); setMessage(null);
  }
  async function save() {
    // Only a local edit of a verified active profile saves here; the bundled preview has no save.
    if (!profile || !allowed("save")) return;
    await perform("save", async () => {
      const saved = await codeWorkflow(host, policyCurrent).code("select", {
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
  function refresh() {
    configuration.refresh(); metadata.refresh(); setup.refresh(); defaults.refresh(); skillCatalog.refresh(); accounts.refresh(); reading.refresh();
  }
  async function perform(kind: WorkbenchStep | null, work: () => Promise<void>) {
    if (pending.current || !writable) return;
    pending.current = true; setBusy(true); setInFlight(kind); setMessage(null); setOutcome(null);
    try { await work(); }
    catch (reason) { if (mounted.current) setMessage({ text: codeOperationFailure(reason), failed: true }); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); setInFlight(null); refresh(); } }
  }
  // The scope of the last review attempt, explicit or automatic: a refused one waits for a press or a changed input.
  const reviewAttempt = useRef<number | null>(null);
  // The workbench opens interactive sessions: the task is typed in the session itself, so the composition carries no prompt.
  async function review() {
    if (!record || !target) return;
    reviewAttempt.current = reviewEpoch;
    await perform("review", async () => {
      const value = await codeWorkflow(host, () => destinationCurrent() && reviewScope.current.epoch === reviewEpoch && canWriteCodeWorkspace(current.current.host))
        .reviewSession(target, record.revision, "", { skills: skillChoice, automation });
      if (destinationCurrent() && reviewScope.current.epoch === reviewEpoch && value.destination.machineId === machineId) { reviewedEpoch.current = reviewEpoch; setPreview(value); }
    });
  }
  async function launch() {
    const reviewed = preview;
    if (!target || !record || !reviewed) return;
    await perform("launch", async () => {
      try {
        const prepared = await codeWorkflow(host).prepareSession(reviewed);
        // Asked again on the latest facts: a team, machine, pool or authority change while preparing stops the launch here.
        const verdict = stillOpen("launch");
        if (!verdict.open) throw new Error(`Nothing was opened: ${verdict.refusal.text}`);
        const latest = current.current;
        if (!destinationCurrent() || reviewScope.current.epoch !== reviewEpoch || prepared.destination.machineId !== latest.target?.machineId || prepared.destination.containerId !== latest.host.containerId ||
          latest.host.principal.id !== host.principal.id || latest.machine?.id !== prepared.destination.machineId || !latest.host.authoring || !canWriteCodeWorkspace(latest.host)) throw new Error("Destination changed");
        if (await latest.host.authoring.createTerminal(latest.machine, prepared.runtime) === null) throw new Error("Terminal placement refused");
        const teams = rememberLaunch(browserTeamStorage(), recentKey, reviewed.composition.review.selection, Date.now());
        if (mounted.current) setRecentTeams(teams);
        if (destinationCurrent()) {
          setSkillChoice(undefined); setAutomation(undefined); setSavedSessionId("");
          setMessage({ text: "Terminal opened. Follow the session in OMP. Optional choices were cleared for the next independent launch.", failed: false });
          setOutcome({ kind: "launched", machine: latest.machine.name });
        }
      } finally {
        // One review, one launch attempt: whether it opened a terminal or was refused, the next launch reviews again.
        if (mounted.current) setPreview(null);
      }
    });
  }
  function verify() {
    if (allowed("verify")) void verification.prepare();
  }
  /** The verb: whatever the next step is, if the gate lets it start. */
  function next() {
    if (pending.current || step.step === "blocked" || !verb.open) return;
    switch (step.step) {
      case "verify": verify(); return;
      case "save": setChaining(true); void save(); return;
      case "review": void review(); return;
      case "launch": void launch(); return;
    }
  }
  // `Save & review` is one gesture: the review follows once the saved revision is observed, never before,
  // and only if the gate, asked again then, lets it; otherwise the chain stops and the verb says why.
  useEffect(() => {
    if (!chaining || busy) return;
    if (message?.failed) { setChaining(false); return; }
    if (!configurationCurrent) return;
    setChaining(false);
    if (stillOpen("review").open) void review();
  });
  // The saved team reviews itself once its inputs settle, so Launch is one press; an edit never does (launch-step.ts).
  const autoReview = autoReviewDue(facts, reviewEpoch, reviewAttempt.current);
  useEffect(() => {
    if (!autoReview) return;
    const timer = window.setTimeout(() => { void review(); }, AUTO_REVIEW_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [autoReview, reviewEpoch]);
  function confirmCharge(activation: ConfirmActivation, shown: ChargeReview) {
    if (actionGate(facts, "confirm").open) void verification.confirm(activation, shown);
  }
  async function resume(withTeam: boolean) {
    const intent = withTeam ? "resume-with-team" : "resume";
    if (!target || !record || !allowed(intent)) return;
    await perform("resume", async () => {
      setPreview(null);
      const result = await codeWorkflow(host).resumeSession({ harness: OMP_PLUGIN_ID, machineId, sessionId: savedSessionId }, {
        ...(withTeam ? { profile: { target, expectedRevision: record.revision } } : {}),
        ...(skillChoice === undefined ? {} : { skills: skillChoice }), ...(automation === undefined ? {} : { automation }),
      }, () => destinationCurrent() && reviewScope.current.epoch === reviewEpoch && canWriteCodeWorkspace(current.current.host));
      if (result.kind === "reopen") {
        if (destinationCurrent()) host.navigate(formatManifoldUri({ kind: "terminal", terminalId: result.terminals[0]!.id }));
        return;
      }
      const verdict = stillOpen(intent);
      if (!verdict.open) throw new Error(`Nothing was opened: ${verdict.refusal.text}`);
      const prepared = result.prepared;
      const latest = current.current;
      if (!destinationCurrent() || reviewScope.current.epoch !== reviewEpoch || latest.host.principal.id !== host.principal.id ||
        prepared.machineId !== latest.target?.machineId || prepared.sessionId !== savedSessionId || latest.machine?.id !== prepared.machineId ||
        !latest.host.authoring || !canWriteCodeWorkspace(latest.host)) throw new Error("Destination or session choices changed");
      if (await latest.host.authoring.createTerminal(latest.machine, prepared.runtime) === null) throw new Error("Terminal placement refused");
      if (destinationCurrent()) {
        setPreview(null); setSkillChoice(undefined); setAutomation(undefined); setSavedSessionId("");
        setMessage({ text: "Saved session opened in OMP. Per-session choices were cleared.", failed: false });
        setOutcome({ kind: "resumed", machine: latest.machine.name });
      }
    });
  }
  async function changeAccounts(edit: AccountChoiceChange) {
    if (!record || !configurationCurrent || accountsBusy.current || !allowed("edit-accounts") || (edit.kind === "set-account" && historicalAccounts)) return;
    accountsBusy.current = true; setAccountsPending(true); setAccountsFailure(null);
    try {
      await callCodeAction(host, "changeAccounts", { containerId: host.containerId!, expectedRevision: record.revision, change: edit });
    } catch (reason) {
      if (mounted.current) setAccountsFailure(`${codeOperationFailure(reason)} Nothing was retried.`);
    } finally {
      accountsBusy.current = false;
      if (mounted.current) { setAccountsPending(false); configuration.refresh(); accounts.refresh(); reading.refresh(); }
    }
  }
  function changeSkillChoice(value: SkillChoice) { setSkillChoice(value); setPreview(null); setMessage(null); }
  function changeAutomation(value: AutomationChoice) { setAutomation(value); setPreview(null); setMessage(null); }
  // Outcome and refusal lines describe a premise: the team, the machine and the account pool. Any change to
  // one of them clears them, unless the change came with the line itself (a verification saving its team).
  const premise = JSON.stringify([selection, machineId, record?.accounts ?? null, accountObservation, served ? [...served].sort() : null]);
  const linePremise = useRef(premise);
  useLayoutEffect(() => { linePremise.current = premise; }, [message, outcome]);
  useLayoutEffect(() => {
    if (linePremise.current === premise) return;
    linePremise.current = premise;
    setMessage(null); setOutcome(null);
  }, [premise]);
  const profileState: ProfileState = stale ? "conflict" : unsaved ? "local" : "saved";
  const stateLabel = !configurationCurrent ? "Shared choices unavailable" : stale ? "Shared profile changed" :
    profile?.source === "starter" ? "Bundled preview · verify to save" : profile?.source === "draft" ? "Staged catalog preview" : dials ? "Local changes" : "Saved profile";
  const usage: BoardUsage = {
    view: reading.value, current: !(reading.cached || historicalChoices || configuration.error !== null || accounts.error !== null), nowMs,
    accounts: choices && {
      choices, historical: historicalAccounts, pending: accountsPending, failure: accountsFailure,
      change: edit => void changeAccounts(edit),
    },
  };
  return {
    queries: { configuration, metadata, setup, defaults, skillCatalog, accounts },
    observed, record, machineId, document, starterError: starter.error, compiled, selection,
    profile, localDraft: dials, review: shownReview, localReview, controlsReview, launchReview: previewCurrent ? preview : null,
    configurationCurrent, unsaved, stale, writable, available, launchReady, previewCurrent, busy, inFlight, chaining,
    profileState, stateLabel, launchStatus: launchStatusText(facts), message, exportedDraft,
    gate: (intent, sessionId) => actionGate(sessionId === undefined ? facts : { ...facts, savedSessionId: sessionId }, intent),
    step, verb, served, unservedLead, outcome, usage,
    skillChoice, setSkillChoice: changeSkillChoice, skillProblems, effectiveSkillMode, effectiveSkillCount,
    automation, setAutomation: changeAutomation,
    savedSessionId, setSavedSessionId,
    actions: { updateSelection, recallTeam, discardChanges, next, verify, save, confirmCharge, resume, changeAccounts: edit => void changeAccounts(edit), refresh },
    verification, recentTeams,
  };
}
