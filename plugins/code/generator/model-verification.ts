import { useEffect, useMemo, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { BENCHMARK_OPERATION_ID, INVENTORY_OPERATION_ID, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import type { Selection } from "../../domain/contracts.ts";
import { unpublishedModels, type ModelAddress } from "../../domain/routing.ts";
import type { Exclusion } from "../../domain/probe.ts";
import { CODE_PLUGIN_ID, type Configuration, type Target, type VerificationProvenance } from "../contract.ts";
import { approvalCovers, VerificationError, WorkflowError, inventoryArtifact, type ChargeReview, type PendingVerification, type VerificationEvidence,
  type VerificationProgress, type VerificationStep, type VerifiedModels } from "../workflow.ts";
import { canWriteCodeWorkspace, codeOperationFailure, codeWorkflow, useOmpQuery, useWorkflowQuery } from "../machine-web.ts";
import { operationReady } from "../permission-plan.ts";
import { CHECKING_HOLD_MS, confirmsCharge, ownInitialization, verificationState, type ConfirmActivation, type VerificationState,
  type VerificationStatus } from "./verification.ts";

export type ModelVerificationInput = {
  host: HostServices;
  target: Target | null;
  /** The shared policy the verification is compared with: an acknowledged save, else the observation. */
  record: Configuration | null;
  /** The canonical revision a verification starts from: the shown profile's base. */
  revision: number;
  configurationCurrent: boolean;
  /** The selection the operator sees; a check they start saves it, narrowed to what the verified catalog hosts. */
  selection: Selection | null;
  /** The models the shown team's routes name, leads and fallbacks; null while no team is formed. */
  routed: readonly ModelAddress[] | null;
  /** The destination as OMP describes it now; null until it answers. */
  setup: OmpResult<"describeDestination"> | null;
  /** The revision of the model catalog OMP bundles now (`readModelCatalog`); null until it answers. */
  catalogRevision: string | null;
  writable: boolean;
  available: boolean;
  /** The rows hold an edit not yet saved. No check starts on its own then, since a check saves the profile it checks. */
  edited: boolean;
  /** Nothing else is in flight (a save, review, launch, resume or Models write): a check starts on its own only then. */
  idle: boolean;
  /** The verified, saved configuration, as the final CAS acknowledged it, and who started the check. */
  onVerified: (configuration: Configuration, mode: VerificationMode) => void;
  /**
   * A run that found the workspace without shared choices created them (`from` → `to`) and then
   * stopped or was cancelled: the panel's own write, which the shown first-use profile may follow.
   */
  onInitialized: (from: number, to: number) => void;
};
/**
 * Who started a check. `launch`: the Launch press, which goes on to the launch once the check is
 * done. `manual`: Models. `background`: the panel itself, once the list in use no longer holds;
 * it never asks the person anything, and never holds up a launch the list in use can still serve.
 */
export type VerificationMode = "launch" | "manual" | "background";
/** `inventory`: OMP's inventory is running. `charge`: the charge awaits the person's approval; nothing has
 * been spent. `benchmark`: approved — probing, then deriving and saving (`progress.step` says which). */
export type VerificationPhase = "inventory" | "charge" | "benchmark";
/** Why the last run stopped, and who started it. `reason` is for a person; `evidence` names the jobs and
 * the last revision it left behind, all still inspectable. */
export type VerificationFailure = { step: VerificationStep; reason: string; cancelled: boolean; evidence: VerificationEvidence | null; mode: VerificationMode };
export type ModelVerification = VerificationState & {
  /** The standing of the list in use, set aside any check in flight: never `verifying`. */
  held: VerificationStatus;
  /** The list in use records a verification, whatever its standing now: a list that passed a check once. */
  passed: boolean;
  phase: VerificationPhase | null;
  progress: VerificationProgress | null;
  /** The charge under review or being spent; null outside a run. */
  charge: ChargeReview | null;
  /** Who started the run in flight; null when none runs. */
  mode: VerificationMode | null;
  /** The run in flight is writing the workspace's choices or model list, which nothing else may touch meanwhile. */
  writing: boolean;
  /** Why each offered model is absent from the catalog the last completed run saved. */
  exclusions: Exclusion[] | null;
  provenance: VerificationProvenance | null;
  failure: VerificationFailure | null;
  /** Discovery and benchmark are ready on the destination. */
  ready: boolean;
  canPrepare: boolean;
  /** A charge of at least one request waits for the person's approval. */
  canConfirm: boolean;
  /** The largest charge, in requests, the person approved checks to spend without asking: 0 when every check asks, null until read. */
  approvedRequests: number | null;
  /**
   * Initialize if needed, then put the person's own newer check of this pool in use, or run OMP's
   * inventory and answer the charge. A charge the standing approval covers is spent at once; any
   * other waits for `confirm`, except a background run's, which ends there and spends nothing.
   */
  prepare: (mode: VerificationMode) => Promise<void>;
  /**
   * Approve the waiting charge `shown`, which records the person's standing approval so later checks
   * within it ask nothing (workflow.ts `approvalCovers`), then spend it: benchmark per provider,
   * derive, stage, review, promote, save the selection. Ignored unless `shown` is the very charge
   * waiting, of at least one request, and the activation a deliberate single press after the checking
   * hold (`confirmsCharge`).
   */
  confirm: (activation: ConfirmActivation, shown: ChargeReview) => Promise<void>;
  /** Stop: a pending charge is discarded, and the probe job in flight is cancelled at its native owner. */
  cancel: () => void;
  /** Withdraw the standing approval, so every later check asks again. */
  withdraw: () => Promise<void>;
};
type ChargedVerification = Extract<PendingVerification, { kind: "charge" }>;
type Run = { phase: VerificationPhase; progress: VerificationProgress | null; charge: ChargeReview | null; mode: VerificationMode };
/**
 * The run in flight: who started it, how to stop it, whether it still holds, when its press started
 * it, its charge while unapproved, the revision it started from, whether the workspace had no choices
 * then, and the revision its answered charge was made at.
 */
type Session = {
  mode: VerificationMode; controller: AbortController; isCurrent: () => boolean; preparedAt: number; pending: ChargedVerification | null;
  from: number; absent: boolean; charged: number | null;
};

/** The steps at which a check writes the workspace's choices or model list. */
const WRITE_STEPS: ReadonlySet<VerificationStep> = new Set(["initialize", "adopt", "stage", "review", "promote", "select"]);
/**
 * The model checks of `createCodeWorkflowClient().verifyModels`, for the workbench. Mounting
 * observes — OMP's account observation and Code's pool composition, the person's own checks and
 * approval, the destination and model catalog the workbench already reads, and, once that catalog
 * has moved, what it publishes for the routed providers — and starts a background check only when
 * the list in use no longer holds and the person's own check or standing approval can renew it. A
 * run is bound to the destination, principal, container and write authority it started under;
 * losing any of them stops it, which cancels a probe job still spending.
 */
export function useModelVerification(input: ModelVerificationInput): ModelVerification {
  const { host, target, record, revision, configurationCurrent, setup, catalogRevision, routed, writable, available } = input;
  const latest = useRef(input);
  latest.current = input;
  // `pool: null` is an observed absence of any selected account; a null `data` is no observation yet.
  const pool = useWorkflowQuery(host, `verification-pool:${JSON.stringify([host.containerId, record?.revision ?? null, record?.accounts ?? null])}`,
    record !== null && host.containerId !== null,
    async () => ({ pool: await codeWorkflow(host).observeVerification(host.containerId!, record!.revision, record!.accounts) }));
  // The person's own checks and standing approval. A caller refused them (a token confined to one container) keeps none,
  // so every check it starts asks, as before checks were kept.
  const kept = useWorkflowQuery(host, `${CODE_PLUGIN_ID}.readChecks`, host.containerId !== null, () => codeWorkflow(host).readChecks());
  const approvedRequests = kept.data?.approvedRequests ?? (kept.error !== null ? 0 : null);
  const [run, setRun] = useState<Run | null>(null);
  const [failure, setFailure] = useState<VerificationFailure | null>(null);
  const [exclusions, setExclusions] = useState<Exclusion[] | null>(null);
  const active = useRef<Session | null>(null);
  const mounted = useRef(false);
  // The background runs already started, by what they would renew: none is retried for the same standing.
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.controller.abort(); };
  }, []);
  const provenance = record?.active?.provenance ?? null;
  // A routed model OMP's catalog no longer publishes is refused at launch. The revision the
  // verification recorded publishes every model it laddered, so what OMP publishes is read only
  // once the catalog has moved past it, and judged only when it answers for that same revision.
  const moved = provenance !== null && catalogRevision !== null && catalogRevision !== provenance.catalogRevision;
  const providers = useMemo(() => [...new Set((routed ?? []).map(model => model.provider))].sort(), [routed]);
  const published = useOmpQuery(host, "readModelCatalog", moved && providers.length > 0 ? { providers } : null);
  const unpublished = !moved || !routed?.length ? [] : published.data === null || published.data.revision !== catalogRevision ? null
    : unpublishedModels(routed, published.data.models);
  // The OMP a verification recorded is compared by content, the artifact the destination's inventory
  // operation is installed from and the bundled model catalog's revision, so an update is seen
  // whatever version it reports and without a new Code build.
  const held = verificationState(provenance, { inventoryArtifactSha256: setup === null ? null : inventoryArtifact(setup), catalogRevision,
    unpublished, pool: pool.data === null ? null : pool.data.pool ?? "none" }, false);
  const state: VerificationState = run === null ? held : { status: "verifying", changes: held.changes };
  const ready = operationReady(setup, INVENTORY_OPERATION_ID) && operationReady(setup, BENCHMARK_OPERATION_ID);
  const canPrepare = run === null && writable && available && configurationCurrent && ready && target !== null && host.containerId !== null;

  // The standing a background run would renew. A list the person imported (in use without a verification) or a staged list
  // waiting in Models is theirs to decide on, so neither is replaced on its own.
  const poolDigest = pool.data?.pool?.poolIdentityDigest ?? null;
  const adoptable = kept.data !== null && (record === null ? kept.data.checks.length > 0
    : poolDigest !== null && kept.data.checks.some(check => check.poolIdentityDigest === poolDigest && (provenance === null ||
      provenance.poolIdentityDigest !== poolDigest || provenance.benchmarkCompletedAt < check.provenance.benchmarkCompletedAt)));
  const renewable = held.status !== "current" && record?.draft == null && !(record?.active && provenance === null);
  const standing = JSON.stringify([host.containerId, target?.machineId ?? null, held.status, poolDigest, catalogRevision,
    record?.active?.digest ?? null, approvedRequests]);
  const due = renewable && canPrepare && input.idle && !input.edited && approvedRequests !== null && (approvedRequests > 0 || adoptable) &&
    !attempted.current.has(standing);
  useEffect(() => {
    if (!due) return;
    attempted.current.add(standing);
    void prepare("background");
  }, [due, standing]);
  // A background run yields to an edit of the rows before it writes anything: the check it would save is no longer the one
  // shown. While it writes, the gate holds edits instead (`writing`), so nothing lands between its writes.
  const writing = run !== null && run.progress !== null && WRITE_STEPS.has(run.progress.step);
  useEffect(() => {
    if (input.edited && run?.mode === "background" && !writing) cancel();
  }, [input.edited, run?.mode, writing]);

  const owns = (session: Session) => mounted.current && active.current === session;
  const selectionFor = (mode: VerificationMode) => mode === "background" ? latest.current.record?.selection ?? null : latest.current.selection;
  function stopped(session: Session, reason: unknown) {
    if (!owns(session)) return;
    active.current = null;
    // Whatever stopped, nothing starts again on its own for the standing it stopped in.
    attempted.current.add(standing);
    setRun(null);
    setFailure(reason instanceof VerificationError
      ? { step: reason.step, reason: codeOperationFailure(new WorkflowError(reason.reason)), cancelled: reason.reason.startsWith("code_verification_cancelled"),
        evidence: reason.evidence, mode: session.mode }
      : { step: "observe", reason: codeOperationFailure(reason), cancelled: false, evidence: null, mode: session.mode });
    const made = ownInitialization(session.absent, session.charged, reason instanceof VerificationError ? reason.evidence?.revision ?? null : null);
    if (made !== null) latest.current.onInitialized(session.from, made);
  }
  // An adopted check says nothing of what it left out, so the reasons are then unknown rather than none.
  function finished(session: Session, verified: VerifiedModels, measured = true) {
    if (!owns(session)) return;
    active.current = null;
    setRun(null); setExclusions(measured ? verified.exclusions : null);
    kept.refresh();
    latest.current.onVerified(verified.configuration, session.mode);
  }
  const progressTo = (session: Session) => (progress: VerificationProgress) => {
    if (owns(session)) setRun(previous => previous && { ...previous, progress });
  };
  async function spend(session: Session, pending: ChargedVerification) {
    session.pending = null;
    setRun(previous => previous && { ...previous, phase: "benchmark", charge: pending.charge });
    try {
      finished(session, await pending.confirm(selectionFor(session.mode),
        { signal: session.controller.signal, isCurrent: session.isCurrent, onProgress: progressTo(session) }));
    } catch (reason) { stopped(session, reason); }
  }
  async function prepare(mode: VerificationMode) {
    if (!canPrepare || !target) return;
    const started = { host, target }, controller = new AbortController();
    const session: Session = { mode, controller, pending: null, preparedAt: Date.now(), from: revision, absent: record === null, charged: null, isCurrent: () => {
      const now = latest.current;
      return mounted.current && !controller.signal.aborted && now.host.client === started.host.client &&
        now.host.principal.id === started.host.principal.id && now.host.containerId === started.host.containerId &&
        now.target?.machineId === started.target.machineId && now.available && canWriteCodeWorkspace(now.host);
    } };
    active.current = session;
    setFailure(null); setExclusions(null);
    setRun({ phase: "inventory", progress: null, charge: null, mode });
    try {
      // The client is ungated: a stop must still reach the native job owner to cancel the job.
      const selection = selectionFor(mode);
      const pending = await codeWorkflow(host).verifyModels(target, { expectedRevision: revision, budget: selection?.budget ?? "any", selection },
        { signal: controller.signal, isCurrent: session.isCurrent, onProgress: progressTo(session) });
      if (!owns(session)) return;
      if (pending.kind === "adopted") { finished(session, pending.verified, false); return; }
      session.charged = pending.charge.revision;
      if (approvalCovers(pending.approvedRequests, pending.charge.requests)) { await spend(session, pending); return; }
      if (mode === "background") {
        // A background run never asks: a charge the approval does not cover ends it here, with nothing spent.
        active.current = null;
        setRun(null);
        const made = ownInitialization(session.absent, session.charged, null);
        if (made !== null) latest.current.onInitialized(session.from, made);
        return;
      }
      session.pending = pending;
      // A fast inventory must not put Approve under the second click of a double-click on Launch:
      // "Checking models…" stays until the hold has passed, and a cancel meanwhile settles the run.
      const hold = session.preparedAt + CHECKING_HOLD_MS - Date.now();
      if (hold > 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        const timer = setTimeout(resolve, hold);
        controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        await promise;
      }
      if (!owns(session) || controller.signal.aborted) return;
      setRun(previous => ({ phase: "charge", progress: previous?.progress ?? null, charge: pending.charge, mode }));
    } catch (reason) { stopped(session, reason); }
  }
  async function confirm(activation: ConfirmActivation, shown: ChargeReview) {
    const session = active.current, pending = session?.pending;
    if (!session || !pending || run?.phase !== "charge" ||
      !confirmsCharge(activation, shown, { charge: pending.charge, preparedAt: session.preparedAt }, Date.now())) return;
    session.pending = null;
    setRun(previous => previous && { ...previous, phase: "benchmark" });
    // The press approves this charge whatever happens to the standing approval: one that cannot be recorded (a caller
    // confined to one container keeps none) only means the next check asks again.
    try {
      const workflow = codeWorkflow(host), now = await workflow.readChecks();
      await workflow.approveChecks(now.revision, Math.max(now.approvedRequests, pending.charge.requests));
      kept.refresh();
    } catch { /* The next check asks again; this one was approved by the press. */ }
    await spend(session, pending);
  }
  function cancel() {
    const session = active.current;
    if (!session) return;
    session.controller.abort();
    // Waiting on the operator, nothing is in flight to report the stop, so it is settled here.
    if (session.pending) {
      active.current = null;
      attempted.current.add(standing);
      setRun(null);
      setFailure({ step: "draft", reason: "Model check cancelled before any benchmark request.", cancelled: true, evidence: null, mode: session.mode });
      const made = ownInitialization(session.absent, session.charged, null);
      if (made !== null) latest.current.onInitialized(session.from, made);
    }
  }
  async function withdraw() {
    const workflow = codeWorkflow(host), now = await workflow.readChecks();
    await workflow.approveChecks(now.revision, 0);
    kept.refresh();
  }
  return {
    ...state, held: held.status, passed: provenance !== null, phase: run?.phase ?? null, progress: run?.progress ?? null, charge: run?.charge ?? null,
    mode: run?.mode ?? null, writing, exclusions, provenance, failure, ready, canPrepare, canConfirm: run?.phase === "charge" && (run.charge?.requests ?? 0) > 0,
    approvedRequests, prepare, confirm, cancel, withdraw,
  };
}
