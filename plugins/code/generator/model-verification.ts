import { useEffect, useMemo, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { BENCHMARK_OPERATION_ID, INVENTORY_OPERATION_ID, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import type { Selection } from "../../domain/contracts.ts";
import { unpublishedModels, type ModelAddress } from "../../domain/routing.ts";
import type { Exclusion } from "../../domain/probe.ts";
import { CODE_PLUGIN_ID, type Configuration, type Target, type VerificationProvenance } from "../contract.ts";
import { VerificationError, WorkflowError, inventoryArtifact, type ChargeReview, type PendingVerification, type VerificationEvidence,
  type VerificationProgress, type VerificationStep, type VerifiedModels } from "../workflow.ts";
import { canWriteCodeWorkspace, codeOperationFailure, codeWorkflow, useOmpQuery, useWorkflowQuery } from "../machine-web.ts";
import { operationReady } from "../permission-plan.ts";
import { adoptsOnly, backgroundCheckDue, CHECKING_HOLD_MS, confirmsCharge, ownInitialization, spendsWithoutAsking, verificationState, type ConfirmActivation,
  type VerificationMode, type VerificationState, type VerificationStatus } from "./verification.ts";

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
  /**
   * The verified, saved configuration, as the final CAS acknowledged it, who started the check, and
   * whether it adopted the person's kept check rather than measuring anything here.
   */
  onVerified: (configuration: Configuration, mode: VerificationMode, adopted: boolean) => void;
  /**
   * A run that found the workspace without shared choices created them (`from` → `to`) and then
   * stopped or was cancelled: the panel's own write, which the shown first-use profile may follow.
   */
  onInitialized: (from: number, to: number) => void;
};
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
  /** The person keeps checks and their approval at all (`readChecks().keeps`); null until read. */
  keepsChecks: boolean | null;
  /**
   * Initialize if needed, then put the person's own newer check of this pool in use, or run OMP's
   * inventory and answer the charge. A charge the standing approval covers is spent at once; any
   * other waits for `confirm`. A background run never waits: it spends only a covered charge that
   * renews a list which passed a check, and otherwise ends there with nothing spent.
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
 * then, the revision its answered charge was made at, whether the person approved its charge with
 * their own press, and whether they withdrew the standing approval while it ran.
 */
type Session = {
  mode: VerificationMode; controller: AbortController; isCurrent: () => boolean; preparedAt: number; pending: ChargedVerification | null;
  from: number; absent: boolean; charged: number | null; approvedByPress: boolean; withdrawn: boolean;
  /** The step the run last reported, as it happens rather than as last rendered. */
  step: VerificationStep | null;
  /** The list in use passed a check when the run started: only such a list may a background run spend to renew. */
  renews: boolean;
};

/** The steps at which a check writes the workspace's choices or model list. */
const WRITE_STEPS: ReadonlySet<VerificationStep> = new Set(["initialize", "adopt", "stage", "review", "promote", "select"]);
/**
 * The model checks of `createCodeWorkflowClient().verifyModels`, for the workbench. Mounting
 * observes — OMP's account observation and Code's pool composition, the person's own checks and
 * approval, the destination and model catalog the workbench already reads, and, once that catalog
 * has moved, what it publishes for the routed providers — and starts a background check only when
 * the list in use no longer holds and either the person keeps a check of the pool to adopt, or the
 * list passed a check and the standing approval can pay to renew it. A run is bound to the
 * destination, principal, container and write authority it started under; losing any of them stops
 * it, which cancels a probe job still spending.
 */
export function useModelVerification(input: ModelVerificationInput): ModelVerification {
  const { host, target, record, revision, configurationCurrent, setup, catalogRevision, routed, writable, available } = input;
  const latest = useRef(input);
  latest.current = input;
  // `pool: null` is an observed absence of any selected account; a null `data` is no observation yet.
  const pool = useWorkflowQuery(host, `verification-pool:${JSON.stringify([host.containerId, record?.revision ?? null, record?.accounts ?? null])}`,
    record !== null && host.containerId !== null,
    async () => ({ pool: await codeWorkflow(host).observeVerification(host.containerId!, record!.revision, record!.accounts) }));
  // The person's own checks and standing approval. A caller that keeps none (a token confined to one container) reads empty,
  // so every check it starts asks, as before checks were kept.
  const kept = useWorkflowQuery(host, `${CODE_PLUGIN_ID}.readChecks`, host.containerId !== null, () => codeWorkflow(host).readChecks());
  const approvedRequests = kept.data?.approvedRequests ?? null;
  const [run, setRun] = useState<Run | null>(null);
  const [failure, setFailure] = useState<VerificationFailure | null>(null);
  const [exclusions, setExclusions] = useState<Exclusion[] | null>(null);
  const active = useRef<Session | null>(null);
  const mounted = useRef(false);
  // After any check stops, is cancelled or ends unspent, nothing starts on its own again until the person starts a check
  // that completes: a retry behind their back could spend again, its own writes can change what it would renew, and the
  // person has the launch to try again.
  const quiet = useRef(false);
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

  // The person's kept check of this pool and budget, newer than the list in use, which the workspace could adopt without spending.
  const poolDigest = pool.data?.pool?.poolIdentityDigest ?? null, budget = record?.selection?.budget ?? "any";
  const adoptable = kept.data !== null && poolDigest !== null && kept.data.checks.some(check => check.poolIdentityDigest === poolDigest &&
    check.budget === budget && (provenance === null || provenance.poolIdentityDigest !== poolDigest ||
      provenance.benchmarkCompletedAt < check.provenance.benchmarkCompletedAt));
  const due = backgroundCheckDue({ held: held.status, initialized: record !== null, staged: record?.draft != null,
    imported: record?.active != null && provenance === null, passed: provenance !== null, adoptable, approvedRequests,
    ready: canPrepare && input.idle && !input.edited, quiet: quiet.current });
  useEffect(() => {
    if (due) void prepare("background");
  }, [due]);
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
    quiet.current = true;
    setRun(null);
    setFailure(reason instanceof VerificationError
      ? { step: reason.step, reason: codeOperationFailure(new WorkflowError(reason.reason)), cancelled: reason.reason.startsWith("code_verification_cancelled"),
        evidence: reason.evidence, mode: session.mode }
      : { step: "observe", reason: codeOperationFailure(reason), cancelled: false, evidence: null, mode: session.mode });
    const made = ownInitialization(session.absent, session.charged, reason instanceof VerificationError ? reason.evidence?.revision ?? null : null);
    if (made !== null) latest.current.onInitialized(session.from, made);
  }
  // An adopted check says nothing of what it left out, so the reasons are then unknown rather than none.
  function finished(session: Session, verified: VerifiedModels, adopted: boolean) {
    if (!owns(session)) return;
    active.current = null;
    quiet.current = false;
    setRun(null); setExclusions(adopted ? null : verified.exclusions);
    kept.refresh();
    latest.current.onVerified(verified.configuration, session.mode, adopted);
  }
  /** Ends a run that started nothing to spend or was not allowed to spend, with nothing spent, keeping the initialization it made. */
  function unspent(session: Session) {
    active.current = null;
    quiet.current = true;
    setRun(null);
    const made = ownInitialization(session.absent, session.charged, null);
    if (made !== null) latest.current.onInitialized(session.from, made);
  }
  const progressTo = (session: Session) => (progress: VerificationProgress) => {
    session.step = progress.step;
    if (owns(session)) setRun(previous => previous && { ...previous, progress });
  };
  /**
   * Spends the charge. One the person did not approve with their press is spent unasked, which the
   * workflow spends only within the standing approval as it reads it again.
   */
  async function spend(session: Session, pending: ChargedVerification) {
    session.pending = null;
    setRun(previous => previous && { ...previous, phase: "benchmark", charge: pending.charge });
    try {
      finished(session, await pending.confirm(selectionFor(session.mode), { signal: session.controller.signal, isCurrent: session.isCurrent,
        onProgress: progressTo(session), beforeWrite: holdFor(session), unasked: !session.approvedByPress }), false);
    } catch (reason) { stopped(session, reason); }
  }
  /**
   * A background run holds its first write until nothing the person started is in flight, so it never
   * changes the model list under a save, review, launch or resume; an edit meanwhile cancels it. A run
   * the person started holds nothing: every other step waits for it instead.
   */
  function holdFor(session: Session): () => Promise<void> {
    return () => new Promise<void>(resolve => {
      const signal = session.controller.signal;
      const tick = () => { if (session.mode !== "background" || signal.aborted || latest.current.idle) resolve(); else timer = setTimeout(tick, 250); };
      let timer = setTimeout(tick, 0);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  async function prepare(mode: VerificationMode) {
    if (!canPrepare || !target) return;
    const started = { host, target }, controller = new AbortController();
    const session: Session = { mode, controller, pending: null, preparedAt: Date.now(), from: revision, absent: record === null, charged: null,
      approvedByPress: false, withdrawn: false, step: null, renews: provenance !== null, isCurrent: () => {
        const now = latest.current;
        return mounted.current && !controller.signal.aborted && now.host.client === started.host.client &&
          now.host.principal.id === started.host.principal.id && now.host.containerId === started.host.containerId &&
          now.target?.machineId === started.target.machineId && now.available && canWriteCodeWorkspace(now.host);
      } };
    active.current = session;
    // A background run leaves on show what the last measured check left out, until it measures something itself.
    setFailure(null);
    if (mode !== "background") setExclusions(null);
    setRun({ phase: "inventory", progress: null, charge: null, mode });
    try {
      // The client is ungated: a stop must still reach the native job owner to cancel the job. A background run that may not
      // spend only adopts: it starts no inventory, and writes nothing, unless the person keeps a check.
      const selection = selectionFor(mode);
      const pending = await codeWorkflow(host).verifyModels(target, { expectedRevision: revision, budget: selection?.budget ?? "any", selection,
        adoptOnly: adoptsOnly(mode, session.renews, approvedRequests ?? 0) },
        { signal: controller.signal, isCurrent: session.isCurrent, onProgress: progressTo(session), beforeWrite: holdFor(session) });
      if (!owns(session)) return;
      if (pending.kind === "none") { unspent(session); return; }
      if (pending.kind === "adopted") { finished(session, pending.verified, true); return; }
      session.charged = pending.charge.revision;
      // An approval withdrawn while the inventory ran is honoured here, and one withdrawn after by the workflow's own read.
      if (!session.withdrawn && spendsWithoutAsking(mode, session.renews, pending.approvedRequests, pending.charge.requests)) {
        await spend(session, pending);
        return;
      }
      // A background run never asks: any charge it may not spend ends it here, with nothing spent.
      if (mode === "background") { unspent(session); return; }
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
    session.pending = null; session.approvedByPress = true;
    setRun(previous => previous && { ...previous, phase: "benchmark" });
    // The press approves this charge whatever happens to the standing approval: one that cannot be recorded (a sign-in that
    // keeps no checks) only means the next check asks again.
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
      quiet.current = true;
      setRun(null);
      setFailure({ step: "draft", reason: "Model check cancelled before any benchmark request.", cancelled: true, evidence: null, mode: session.mode });
      const made = ownInitialization(session.absent, session.charged, null);
      if (made !== null) latest.current.onInitialized(session.from, made);
    }
  }
  /**
   * Withdraws the standing approval. A check the person did not approve with a press then spends
   * nothing more: one still listing models asks instead (or, in the background, ends unspent), and
   * one measuring under the approval is stopped. A check already past measuring keeps what it paid for.
   */
  async function withdraw() {
    const session = active.current;
    if (session && !session.approvedByPress) {
      session.withdrawn = true;
      if (session.charged !== null && session.pending === null && session.step === "benchmark") cancel();
    }
    const workflow = codeWorkflow(host), now = await workflow.readChecks();
    await workflow.approveChecks(now.revision, 0);
    kept.refresh();
  }
  return {
    ...state, held: held.status, passed: provenance !== null, phase: run?.phase ?? null, progress: run?.progress ?? null, charge: run?.charge ?? null,
    mode: run?.mode ?? null, writing, exclusions, provenance, failure, ready, canPrepare, canConfirm: run?.phase === "charge" && (run.charge?.requests ?? 0) > 0,
    approvedRequests, keepsChecks: kept.data?.keeps ?? null, prepare, confirm, cancel, withdraw,
  };
}
