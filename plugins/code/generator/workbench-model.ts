import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { formatManifoldUri, type MachineSummary, type ServiceReadArgs } from "@manifold/protocol";
import { compileCatalog, type CompiledCatalog } from "../../domain/catalog.ts";
import { defaultSelection, reviewCatalog, type Review } from "../../domain/routing.ts";
import { catalogFromMetadata } from "../../domain/probe.ts";
import type { CatalogDocument, Selection } from "../../domain/contracts.ts";
import type { ActionResult, Configuration, Target } from "../contract.ts";
import { LAUNCH_OPERATION_ID, OMP_PLUGIN_ID, type ActionResult as OmpResult, type ModelCatalogSnapshot } from "@atyrode/manifold-omp";
import type { SessionReview } from "../workflow.ts";
import { callCodeAction, codeWorkflow, canWriteCodeWorkspace, codeOperationFailure, useCodeQuery, useOmpQuery, useWorkflowQuery } from "../machine-web.ts";
import { operationReady } from "../permission-plan.ts";
import { skillDraft, type SkillChoice } from "./skill-draft.ts";
import type { AutomationChoice } from "./automation.tsx";

/** The suggest door's prompt limit (contract.ts `suggest` input); longer tasks are kept, never truncated. */
const SUGGESTION_PROMPT_MAX = 16384;

/** The profile the controls show: the frozen local draft, or one derived from the shared record or bundled starter facts. */
export type ProfileDraft = {
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
/** A polled observation (machine-web.ts `useWorkflowQuery`): `data` and `error` are mutually exclusive. */
export type WorkbenchQuery<T> = { data: T | null; error: string | null; refreshing: boolean; refresh: () => void };
/** The ready `suggest`/`classify` service that `codeWorkflow(host).classifier` finds on the destination (workflow.ts). */
export type ClassifierService = Pick<ServiceReadArgs, "serviceId" | "revision"> & {
  operations: (Pick<ServiceReadArgs, "operationId"> & { ready: boolean; invocable: boolean })[];
};
export type WorkbenchQueries = {
  configuration: WorkbenchQuery<ActionResult<"readConfiguration">>;
  metadata: WorkbenchQuery<ModelCatalogSnapshot>;
  setup: WorkbenchQuery<OmpResult<"describeDestination">>;
  classifier: WorkbenchQuery<ClassifierService | null>;
  defaults: WorkbenchQuery<OmpResult<"readDefaults">>;
  skillCatalog: WorkbenchQuery<OmpResult<"readSkillCatalog">>;
};
export type WorkbenchMessage = { text: string; failed: boolean };
export type ProfileState = "conflict" | "local" | "saved";
export type EffectiveSkillMode = SessionReview["native"]["skills"]["mode"] | NonNullable<SkillChoice>["mode"];
export type WorkbenchInput = { host: HostServices; target: Target | null; machine: MachineSummary | null; rosterError: string | null; available: boolean };

/** Every effect the workbench can start. All of them keep today's guards; enablement flags are separate. */
export type WorkbenchActions = {
  /** Edit the profile controls. Re-derives a starter document for a new budget; revokes review and suggestion. */
  updateSelection: (value: Selection) => void;
  /** Drop the local draft and any acknowledged CAS receipt; return to the observed shared profile. */
  discardChanges: () => void;
  /** CAS-save the local profile (adopting starter material when frozen from it). No-op unless saveable. */
  saveProfile: () => Promise<void>;
  /** Review the launch for the saved profile. Like today's handler it relies on the caller honouring `canReview`. */
  review: () => Promise<void>;
  /** Launch the current review. No-op unless `previewCurrent`. */
  launch: () => Promise<void>;
  /** Resume the selected saved session, optionally replacing its model choices with this saved profile. */
  resume: (withProfile: boolean) => Promise<void>;
  /** Show the suggestion panel; nothing is sent until `suggest`. */
  openSuggestion: () => void;
  /** Close the suggestion panel and drop its result. */
  closeSuggestion: () => void;
  /** Explicitly send the task to the configured classifier. Nothing is saved. */
  suggest: () => Promise<void>;
  /** Apply the shown suggestion as a local edit and close the panel. */
  applySuggestion: () => void;
  /** Re-observe every query. */
  refresh: () => void;
};

export type WorkbenchModel = {
  queries: WorkbenchQueries;
  /** Last canonical configuration observation, retained while a poll fails. */
  observed: ActionResult<"readConfiguration"> | null;
  /** Shared workspace policy: an acknowledged save receipt until a read catches up with it, else the observation. */
  record: Configuration | null;
  machineId: string;
  /** Increments whenever the destination machine changes; scopes per-destination children. */
  destinationGeneration: number;
  document: CatalogDocument | null;
  /** Why bundled starter material could not be derived, if it could not. */
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
  busy: boolean;
  profileState: ProfileState;
  stateLabel: string;
  /** Today's launch status sentence; same precedence as `nextLaunchStep`. */
  launchStatus: string;
  message: WorkbenchMessage | null;
  /** Copyable JSON of the local profile; empty when there is nothing local to export. */
  exportedDraft: string;
  // Enablement, excluding `busy` (callers disable everything while busy).
  /** A Save profile control is offered and its preconditions hold. */
  canSave: boolean;
  /** The Review/Launch control may proceed. */
  canReview: boolean;
  /** Resume saved state may proceed (callers also exclude running sessions). */
  canResume: boolean;
  /** Resume with this profile may proceed (callers also exclude running sessions). */
  canResumeWithProfile: boolean;
  /** A saved profile and a ready classifier exist, so suggestion is offered. */
  canSuggest: boolean;
  canRequestSuggestion: boolean;
  canApplySuggestion: boolean;
  suggestionPromptTooLong: boolean;
  /** The shown suggestion was made against a different profile revision or classifier policy. */
  suggestionStale: boolean;
  prompt: string;
  /** Edits revoke the current review and suggestion. */
  setPrompt: (value: string) => void;
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
  /** Stable identity: consumers use it as an effect dependency. Any change revokes the review. */
  setAccountObservation: (signature: string) => void;
  suggestion: ActionResult<"suggest"> | null;
  suggesting: boolean;
  actions: WorkbenchActions;
};

/** The facts `nextLaunchStep` reads. A `WorkbenchModel` satisfies it. */
export type LaunchFacts = Pick<WorkbenchModel, "configurationCurrent" | "unsaved" | "stale" | "writable" | "available" | "launchReady" | "previewCurrent"> & {
  profile: Pick<ProfileDraft, "source"> | null;
  localDraft: { source: ProfileDraft["source"]; metadata: object | null } | null;
  record: { active?: unknown } | null;
  localReview: object | null;
  skillProblems: readonly string[];
  queries: { setup: Pick<WorkbenchQuery<unknown>, "error">; metadata: Pick<WorkbenchQuery<unknown>, "data" | "error"> };
};
export type LaunchBlockerCode =
  | "configuration" | "staged" | "unsaved" | "read-only" | "conflict" | "models" | "source"
  | "unavailable" | "sessions" | "permissions" | "skills";
/** What fixes a blocker: re-observe, open Models, discard the local draft, review native permissions, or open launch options. */
export type LaunchBlockerAction = "refresh" | "models" | "discard" | "permissions" | "options";
export type LaunchBlocker = { code: LaunchBlockerCode; text: string; action?: LaunchBlockerAction };
export type LaunchStep =
  | { step: "save" | "review" | "launch"; reason: null }
  | { step: "blocked"; reason: LaunchBlocker };

const blockerText: Readonly<Record<LaunchBlockerCode, string>> = {
  configuration: "Shared choices need a fresh observation.",
  staged: "Review and promote the staged catalog first.",
  unsaved: "Save this profile before launch review.",
  "read-only": "Edit access needed.",
  conflict: "Shared profile changed.",
  models: "Review your models.",
  source: "Bundled model source unavailable.",
  unavailable: "Runtime unavailable · profile and task are retained.",
  sessions: "Sessions unavailable on this machine.",
  permissions: "Review native session permissions when you're ready to run.",
  skills: "Skill choices need attention.",
};
const blockerAction: Readonly<Partial<Record<LaunchBlockerCode, LaunchBlockerAction>>> = {
  configuration: "refresh", staged: "models", conflict: "discard", models: "models", source: "refresh",
  sessions: "permissions", permissions: "permissions", skills: "options",
};
function blocked(code: LaunchBlockerCode): LaunchStep {
  const action = blockerAction[code];
  return { step: "blocked", reason: action ? { code, text: blockerText[code], action } : { code, text: blockerText[code] } };
}
/** Precedence of the launch status sentence: the first unmet launch precondition, or null when review/launch may proceed. */
function launchGate(facts: LaunchFacts): LaunchBlockerCode | null {
  if (!facts.configurationCurrent) return "configuration";
  if (facts.profile?.source === "draft") return "staged";
  if (facts.unsaved || !facts.record?.active) return "unsaved";
  if (!facts.writable) return "read-only";
  if (!facts.available) return "unavailable";
  if (facts.queries.setup.error) return "sessions";
  if (!facts.launchReady) return "permissions";
  if (!facts.localReview) return "models";
  if (facts.skillProblems.length) return "skills";
  return null;
}
/** Save profile preconditions after a current configuration, in the Save control's order; null when saving may proceed. */
function saveGate(facts: LaunchFacts): LaunchBlockerCode | null {
  // Only a frozen local draft that is not a staged-catalog preview offers Save.
  if (!facts.localDraft || facts.localDraft.source === "draft") return "unsaved";
  if (!facts.writable) return "read-only";
  if (facts.stale) return "conflict";
  if (!facts.localReview) return "models";
  if (facts.localDraft.metadata && (facts.queries.metadata.data === null || facts.queries.metadata.error !== null)) return "source";
  return null;
}

/**
 * The next step the primary launch control should take, and why it cannot when blocked.
 *
 * Precedence is the launch status sentence's (`launchStatus`): configuration not current →
 * staged catalog previewed → unsaved profile (or no saved active catalog) → read-only → runtime
 * unavailable → sessions unavailable → launch permission not ready → no local model review →
 * skill problems → `launch` when the review is current, else `review`. For every model the hook
 * produces, `review`/`launch` are returned exactly when today's Review/Launch button is enabled
 * apart from `busy` (`canReview`): a staged preview is always unsaved, and a sessions error
 * leaves launch permission unobserved. Blocked reasons carry the sentence's text.
 *
 * The unsaved branch folds in the Save control: `save` when it would be enabled (`canSave`),
 * otherwise the first failing Save precondition in its order (read-only → conflict → models →
 * source), whose reason replaces the generic sentence. With no frozen local draft there is
 * nothing to save, so the step stays blocked on `unsaved`.
 *
 * `reason` is non-null exactly when `step` is `blocked`. `busy` is deliberately not a step:
 * callers disable the control while busy and label the step in flight themselves.
 */
export function nextLaunchStep(facts: LaunchFacts): LaunchStep {
  const gate = launchGate(facts);
  if (gate === null) return { step: facts.previewCurrent ? "launch" : "review", reason: null };
  if (gate !== "unsaved") return blocked(gate);
  const save = saveGate(facts);
  return save === null ? { step: "save", reason: null } : blocked(save);
}

/**
 * The local catalog review a hypothetical selection would produce, or null when the domain
 * refuses it. Pure apart from reading the clock when `nowMs` is omitted (time of day feeds the
 * estimates); performs no effects, so map-mode previews can call it on every hover.
 */
export function previewSelection(compiled: CompiledCatalog, selection: Selection, nowMs = Date.now()): Review | null {
  try { return reviewCatalog(compiled, selection, nowMs); } catch { return null; }
}

/** Owns the workbench's state, observations, safety checks and actions; presentation stays with the caller. */
export function useWorkbench({ host, target, machine, rosterError, available }: WorkbenchInput): WorkbenchModel {
  const machineId = target?.machineId ?? "";
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
  const [accountObservation, setAccountObservation] = useState("");
  const [dials, setDials] = useState<ProfileDraft | null>(null);
  const [preview, setPreview] = useState<SessionReview | null>(null);
  const [skillChoice, setSkillChoice] = useState<SkillChoice>(undefined);
  const [automation, setAutomation] = useState<AutomationChoice>(undefined);
  const [savedSessionId, setSavedSessionId] = useState("");
  const [suggestion, setSuggestion] = useState<ActionResult<"suggest"> | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<WorkbenchMessage | null>(null);
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
  useLayoutEffect(() => { setPreview(null); setSuggestion(null); setSkillChoice(undefined); setAutomation(undefined); setSavedSessionId(""); }, [machineId]);
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
  function refresh() { configuration.refresh(); metadata.refresh(); setup.refresh(); classifier.refresh(); defaults.refresh(); skillCatalog.refresh(); }
  async function perform(work: () => Promise<void>) {
    if (pending.current || !writable) return;
    pending.current = true; setBusy(true); setMessage(null);
    try { await work(); }
    catch (reason) { if (mounted.current) setMessage({ text: codeOperationFailure(reason), failed: true }); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); refresh(); } }
  }
  async function review() {
    if (record && target) await perform(async () => { const value = await codeWorkflow(host, () => destinationCurrent() && reviewScope.current.epoch === reviewEpoch && canWriteCodeWorkspace(current.current.host)).reviewSession(target, record.revision, prompt, { skills: skillChoice, automation }); if (destinationCurrent() && reviewScope.current.epoch === reviewEpoch && value.destination.machineId === machineId) { reviewedEpoch.current = reviewEpoch; setPreview(value); } });
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
  async function suggest() {
    if (record && target && classifier.data) await perform(async () => {
      const value = await callCodeAction(host, "suggest", { ...target, expectedRevision: record.revision, expectedServiceRevision: classifier.data!.revision, prompt });
      if (destinationCurrent() && reviewScope.current.epoch === reviewEpoch) setSuggestion(value);
    });
  }
  function applySuggestion() {
    if (!suggestion) return;
    updateSelection(suggestion.selection); setSuggesting(false);
  }
  function closeSuggestion() { setSuggesting(false); setSuggestion(null); }
  function changePrompt(value: string) { setPrompt(value); setPreview(null); setSuggestion(null); }
  function changeSkillChoice(value: SkillChoice) { setSkillChoice(value); setPreview(null); setMessage(null); }
  function changeAutomation(value: AutomationChoice) { setAutomation(value); setPreview(null); setMessage(null); }
  const profileState: ProfileState = stale ? "conflict" : unsaved ? "local" : "saved";
  const stateLabel = !configurationCurrent ? "Shared choices unavailable" : stale ? "Shared profile changed" :
    profile?.source === "starter" ? "Local starter · not saved" : profile?.source === "draft" ? "Staged catalog preview" : dials ? "Local changes" : "Saved profile";
  const facts: LaunchFacts = { configurationCurrent, profile, localDraft: dials, record, unsaved, stale, writable, available, launchReady,
    previewCurrent, localReview, skillProblems, queries: { setup, metadata } };
  const gate = launchGate(facts);
  const launchStatus = gate ? blockerText[gate] : previewCurrent ? "Ready to open a terminal." : "Review before opening a terminal.";
  const suggestionPromptTooLong = prompt.length > SUGGESTION_PROMPT_MAX;
  const suggestionStale = suggestion !== null && (suggestion.revision !== record?.revision || suggestion.serviceRevision !== classifier.data?.revision);
  return {
    queries: { configuration, metadata, setup, classifier, defaults, skillCatalog },
    observed, record, machineId, destinationGeneration: generation, document, starterError: starter.error, compiled, selection,
    profile, localDraft: dials, review: shownReview, localReview, controlsReview, launchReview: previewCurrent ? preview : null,
    configurationCurrent, unsaved, stale, writable, available, launchReady, previewCurrent, busy,
    profileState, stateLabel, launchStatus, message, exportedDraft,
    canSave: configurationCurrent && saveGate(facts) === null,
    canReview: writable && available && configurationCurrent && !!record?.active && launchReady && !unsaved && !!localReview && skillProblems.length === 0,
    canResume: writable && available && !!savedSessionId && skillProblems.length === 0,
    canResumeWithProfile: writable && available && !!savedSessionId && configurationCurrent && !!record?.active && !unsaved && !!localReview && skillProblems.length === 0,
    canSuggest,
    canRequestSuggestion: writable && available && configurationCurrent && !!prompt.trim() && !suggestionPromptTooLong && !!classifier.data,
    canApplySuggestion: suggestion !== null && !unsaved && !suggestionStale,
    suggestionPromptTooLong, suggestionStale,
    prompt, setPrompt: changePrompt,
    skillChoice, setSkillChoice: changeSkillChoice, skillProblems, effectiveSkillMode, effectiveSkillCount,
    automation, setAutomation: changeAutomation,
    savedSessionId, setSavedSessionId, setAccountObservation,
    suggestion, suggesting,
    actions: {
      updateSelection, discardChanges, saveProfile, review, launch, resume,
      openSuggestion: () => setSuggesting(true), closeSuggestion, suggest, applySuggestion, refresh,
    },
  };
}
