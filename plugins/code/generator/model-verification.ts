import { useEffect, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { BENCHMARK_OPERATION_ID, INVENTORY_OPERATION_ID, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import type { Selection } from "../../domain/contracts.ts";
import type { Exclusion } from "../../domain/probe.ts";
import type { Configuration, Target, VerificationProvenance } from "../contract.ts";
import { VerificationError, WorkflowError, type ChargeReview, type PendingVerification, type VerificationEvidence,
  type VerificationProgress, type VerificationStep } from "../workflow.ts";
import { canWriteCodeWorkspace, codeOperationFailure, codeWorkflow, useWorkflowQuery } from "../machine-web.ts";
import { operationReady } from "../permission-plan.ts";
import { CHECKING_HOLD_MS, confirmsCharge, verificationState, type ConfirmActivation, type VerificationState } from "./verification.ts";

export type ModelVerificationInput = {
  host: HostServices;
  target: Target | null;
  /** The shared policy the verification is compared with: an acknowledged save, else the observation. */
  record: Configuration | null;
  /** The canonical revision a verification starts from: the shown profile's base. */
  revision: number;
  configurationCurrent: boolean;
  /** The selection the operator sees; a confirmed verification saves it, narrowed to what the verified catalog hosts. */
  selection: Selection | null;
  /** The OMP version whose bundled model list OMP serves now, from its passive catalog read. */
  ompVersion: string | null;
  setup: OmpResult<"describeDestination"> | null;
  writable: boolean;
  available: boolean;
  /** The verified, saved configuration, as the final CAS acknowledged it. */
  onVerified: (configuration: Configuration) => void;
};
/** `inventory`: OMP's inventory is running. `charge`: the charge awaits confirmation; nothing has
 * been spent. `benchmark`: confirmed — probing, then deriving and saving (`progress.step` says which). */
export type VerificationPhase = "inventory" | "charge" | "benchmark";
/** Why the last run stopped. `reason` is for a person; `evidence` names the jobs and the last
 * revision it left behind, all still inspectable. */
export type VerificationFailure = { step: VerificationStep; reason: string; cancelled: boolean; evidence: VerificationEvidence | null };
export type ModelVerification = VerificationState & {
  phase: VerificationPhase | null;
  progress: VerificationProgress | null;
  /** The charge under review or being spent; null outside a run. */
  charge: ChargeReview | null;
  /** Why each offered model is absent from the catalog the last completed run saved. */
  exclusions: Exclusion[] | null;
  provenance: VerificationProvenance | null;
  failure: VerificationFailure | null;
  /** Discovery and benchmark are ready on the destination. */
  ready: boolean;
  canPrepare: boolean;
  canConfirm: boolean;
  /** Initialize if needed and run OMP's inventory, ending at the charge. Spends no benchmark request. */
  prepare: () => Promise<void>;
  /** Spend the reviewed charge: benchmark per provider, derive, stage, review, promote, save the selection.
   * Ignored unless the activation is a deliberate single press after the checking hold (`confirmsCharge`). */
  confirm: (activation: ConfirmActivation) => Promise<void>;
  /** Stop: a pending charge is discarded, and the probe job in flight is cancelled at its native owner. */
  cancel: () => void;
};
type Run = { phase: VerificationPhase; progress: VerificationProgress | null; charge: ChargeReview | null };
/** The run in flight: how to stop it, whether it still holds, when its Verify press started it, and its charge while unconfirmed. */
type Session = { controller: AbortController; isCurrent: () => boolean; preparedAt: number; pending: PendingVerification | null };

/**
 * The first-use and re-verification flow of `createCodeWorkflowClient().verifyModels`, for the
 * workbench. Mounting observes only — OMP's account observation and Code's pool composition, to
 * compare with the recorded verification — and nothing runs until `prepare`. A run is bound to
 * the destination, principal, container and write authority it started under; losing any of them
 * stops it, which cancels a probe job still spending.
 */
export function useModelVerification(input: ModelVerificationInput): ModelVerification {
  const { host, target, record, revision, configurationCurrent, ompVersion, setup, writable, available } = input;
  const latest = useRef(input);
  latest.current = input;
  // `pool: null` is an observed absence of any selected account; a null `data` is no observation yet.
  const pool = useWorkflowQuery(host, `verification-pool:${JSON.stringify([host.containerId, record?.revision ?? null, record?.accounts ?? null])}`,
    record !== null && host.containerId !== null,
    async () => ({ pool: await codeWorkflow(host).observeVerification(host.containerId!, record!.revision, record!.accounts) }));
  const [run, setRun] = useState<Run | null>(null);
  const [failure, setFailure] = useState<VerificationFailure | null>(null);
  const [exclusions, setExclusions] = useState<Exclusion[] | null>(null);
  const active = useRef<Session | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.controller.abort(); };
  }, []);
  const provenance = record?.active?.provenance ?? null;
  const state = verificationState(provenance, { ompVersion, pool: pool.data === null ? null : pool.data.pool ?? "none" }, run !== null);
  const ready = operationReady(setup, INVENTORY_OPERATION_ID) && operationReady(setup, BENCHMARK_OPERATION_ID);
  const canPrepare = run === null && writable && available && configurationCurrent && ready && target !== null && host.containerId !== null;

  const owns = (session: Session) => mounted.current && active.current === session;
  function stopped(session: Session, reason: unknown) {
    if (!owns(session)) return;
    active.current = null;
    setRun(null);
    setFailure(reason instanceof VerificationError
      ? { step: reason.step, reason: codeOperationFailure(new WorkflowError(reason.reason)), cancelled: reason.reason.startsWith("code_verification_cancelled"), evidence: reason.evidence }
      : { step: "observe", reason: codeOperationFailure(reason), cancelled: false, evidence: null });
  }
  const progressTo = (session: Session) => (progress: VerificationProgress) => {
    if (owns(session)) setRun(previous => previous && { ...previous, progress });
  };
  async function prepare() {
    if (!canPrepare || !target) return;
    const started = { host, target }, controller = new AbortController();
    const session: Session = { controller, pending: null, preparedAt: Date.now(), isCurrent: () => {
      const now = latest.current;
      return mounted.current && !controller.signal.aborted && now.host.client === started.host.client &&
        now.host.principal.id === started.host.principal.id && now.host.containerId === started.host.containerId &&
        now.target?.machineId === started.target.machineId && now.available && canWriteCodeWorkspace(now.host);
    } };
    active.current = session;
    setFailure(null); setExclusions(null);
    setRun({ phase: "inventory", progress: null, charge: null });
    try {
      // The client is ungated: a stop must still reach the native job owner to cancel the job.
      const pending = await codeWorkflow(host).verifyModels(target, { expectedRevision: revision, budget: input.selection?.budget ?? "any" },
        { signal: controller.signal, isCurrent: session.isCurrent, onProgress: progressTo(session) });
      if (!owns(session)) return;
      session.pending = pending;
      // A fast inventory must not put Confirm under the second click of a double-click on Verify:
      // "Checking models…" stays until the hold has passed, and a cancel meanwhile settles the run.
      const hold = session.preparedAt + CHECKING_HOLD_MS - Date.now();
      if (hold > 0) {
        const { promise, resolve } = Promise.withResolvers<void>();
        const timer = setTimeout(resolve, hold);
        controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        await promise;
      }
      if (!owns(session) || controller.signal.aborted) return;
      setRun(previous => ({ phase: "charge", progress: previous?.progress ?? null, charge: pending.charge }));
    } catch (reason) { stopped(session, reason); }
  }
  async function confirm(activation: ConfirmActivation) {
    const session = active.current, pending = session?.pending;
    if (!session || !pending || run?.phase !== "charge" || !confirmsCharge(activation, session.preparedAt, Date.now())) return;
    session.pending = null;
    setRun(previous => previous && { ...previous, phase: "benchmark" });
    try {
      const verified = await pending.confirm(latest.current.selection,
        { signal: session.controller.signal, isCurrent: session.isCurrent, onProgress: progressTo(session) });
      if (!owns(session)) return;
      active.current = null;
      setRun(null); setExclusions(verified.exclusions);
      latest.current.onVerified(verified.configuration);
    } catch (reason) { stopped(session, reason); }
  }
  function cancel() {
    const session = active.current;
    if (!session) return;
    session.controller.abort();
    // Waiting on the operator, nothing is in flight to report the stop, so it is settled here.
    if (session.pending) {
      active.current = null;
      setRun(null);
      setFailure({ step: "draft", reason: "Verification cancelled before any benchmark request.", cancelled: true, evidence: null });
    }
  }
  return {
    ...state, phase: run?.phase ?? null, progress: run?.progress ?? null, charge: run?.charge ?? null,
    exclusions, provenance, failure, ready, canPrepare, canConfirm: run?.phase === "charge",
    prepare, confirm, cancel,
  };
}
