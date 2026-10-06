import { createOmpClient, OmpSessionRefSchema, OMP_PLUGIN_ID, LAUNCH_OPERATION_ID, MATERIAL_SESSION_OPERATION_ID, RESUME_OPERATION_ID, skillInputBindings, PREPARE_WORKSPACE_OPERATION_ID, VALIDATE_WORKSPACE_OPERATION_ID,
  INVENTORY_OPERATION_ID, BENCHMARK_OPERATION_ID,
  type BenchmarkInput, type BenchmarkReceipt, type InventoryReceipt, type OmpSessionRef, type OmpAction, type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { JobDeploymentApplyArgsSchema, JobDeploymentListArgsSchema, JobDeploymentListResultSchema,
  JobDeploymentReadArgsSchema, JobDeploymentRequestSchema, JobDeploymentReviewSchema, JobDeploymentSchema, ServiceReadArgsSchema, PublicJobSchema, ListJobRunsResultSchema, MachinesResponseSchema, TerminalsResponseSchema, type PublicJob, type TerminalSummary, canonicalJobJson } from "@manifold/protocol";
import { z } from "zod";
import { createCodeClient, reviewedSessionOptions, sessionInput, type SessionOptions, type CodeAction, type ActionInput, type ActionResult, type Configuration, type Target, type VerificationProvenance } from "./contract.ts";
import { observePermissionPlan, operationReady, type PermissionPlanInput } from "./permission-plan.ts";
import { selectedAccountPool } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { projectUsage } from "../domain/usage.ts";
import { quotaProviders, type Exclusion } from "../domain/probe.ts";
import { clampSelection } from "../domain/routing.ts";
import { DomainError, type AccountChoices, type Selection } from "../domain/contracts.ts";

export type Dispatch = (door: string, input: unknown) => Promise<unknown>;
export class WorkflowError extends Error {}
/** Refusal tokens in a person's words. A token missing here is still never shown raw (`failureWords`). */
const messages: Readonly<Record<string, string>> = {
  code_stale_preferences: "The workspace profile changed. Read it again before saving your edit.",
  code_composition_changed: "The workspace profile, account pool or OMP defaults changed. Review the session again before launching.",
  code_configuration_missing: "This workspace has no Code choices yet.",
  code_catalog_missing: "No model list is in use yet. Review one in Models.",
  code_account_unavailable: "The selected accounts are unavailable or no longer resolve exactly. Review the account choices.",
  code_accounts_changed: "The accounts changed. Read them again before continuing.",
  code_invalid_accounts: "The account observation could not be used. Read the accounts again.",
  code_invalid_selection: "This profile cannot be formed from the current models.",
  code_budget_unsatisfiable: "No free route serves this profile.",
  code_invalid_catalog: "The model list could not be used.",
  code_preview_changed: "The reviewed model list changed. Review it again.",
  code_starter_candidate_limit: "The bundled model list is too large to verify at once.",
  code_verification_cancelled: "Verification cancelled.",
  code_verification_changed: "The machine, workspace or edit access changed, so the verification stopped.",
  code_verification_confirmed: "That charge was already confirmed.",
  code_operation_unavailable: "The Code action could not be completed.",
  code_scope_refused: "Your current authority does not cover this container.",
  code_service_configuration_changed: "Native service configuration changed. Read and review its current revision again.",
  code_service_owner_required: "Native service setup requires the root owner's current machine configuration authority.",
  code_invalid_service_result: "The native service returned an invalid or undisclosed result.",
  code_destination_changed: "The destination changed. Review the current machine before continuing.",
  omp_review_changed: "OMP's review changed. Review again.",
  omp_result_unavailable: "OMP's result is unavailable.",
  omp_defaults_changed: "OMP defaults changed. Review again.",
  omp_session_unavailable: "That saved session is no longer on the machine.",
  omp_session_binding_changed: "That saved session moved or changed. Read the machine again.",
  omp_resume_plan_unsupported: "Resuming with the current profile cannot approve plans automatically.",
  omp_operation_unavailable: "OMP is not installed on that machine.",
};
/** How a browser's dispatch reports a refused door (machine-web.ts `codeWorkflow`): `<plugin>.<action>: <denial>. No approval or readiness is assumed.` */
const DOOR_DENIAL = /^[a-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+: ([^]*?)(?:\. No approval or readiness is assumed\.)?$/;
/** A refusal token (`code_account_unavailable`), and the detail for a person that may follow it. */
const REFUSAL_TOKEN = /^((?:code|omp)_[a-z0-9_]+)(?:[:;] ([^]*))?$/;
/** The refusal token a failure carries (`omp_operation_unavailable`), with its door's name stripped; null when it carries none. */
export function refusalToken(message: string): string | null {
  return REFUSAL_TOKEN.exec(DOOR_DENIAL.exec(message)?.[1] ?? message)?.[1] ?? null;
}

/**
 * A workflow failure in a person's words. A refused door's message loses the door name it was
 * reported under, and its refusal token becomes words: the known ones from `messages`, any other as
 * who refused, so no raw token reaches a person. A detail written for a person after the token stays.
 */
export function failureWords(message: string): string {
  const denial = DOOR_DENIAL.exec(message)?.[1] ?? message;
  const refusal = REFUSAL_TOKEN.exec(denial);
  if (!refusal) return denial;
  const [, token, detail] = refusal;
  const words = messages[token!] ?? (token!.startsWith("omp_") ? "OMP refused the step." : "Code refused the step.");
  return detail ? `${words} ${detail.charAt(0).toUpperCase()}${detail.slice(1)}` : words;
}

/** The steps of a model verification, in the order they run; a failure names the one it stopped at. */
export type VerificationStep = "observe" | "initialize" | "inventory" | "draft" | "benchmark" | "derive" | "stage" | "review" | "promote" | "select";
/** Requests a provider's benchmark has answered out of those it was charged. */
export type ProviderProgress = { provider: string; done: number; total: number };
export type VerificationProgress = { step: VerificationStep; providers: ProviderProgress[] };
/** What a verification has left behind so far, for a person to inspect whatever happens next:
 * OMP retains every probe job it started, and `revision` is the last configuration it wrote. */
export type VerificationEvidence = { inventoryJobId: string | null; benchmarkJobIds: string[]; revision: number | null };
export class VerificationError extends WorkflowError {
  constructor(readonly step: VerificationStep, readonly reason: string, readonly evidence: VerificationEvidence) {
    super(`${step}: ${reason}`);
  }
}
/** `signal` cancels, `isCurrent` revokes; either stops the run before its next effect and
 * cancels the probe job it is waiting on. `onProgress` hears every step and per-provider count. */
export type VerificationOptions = { isCurrent?: () => boolean; signal?: AbortSignal; onProgress?: (progress: VerificationProgress) => void };
/**
 * What confirming a verification will spend, shown before anything is: one tiny benchmark
 * request per candidate, per provider, through the exact pool and OMP defaults the inventory
 * used. `exclusions` are the ids never probed, with their reason: unstable ids, and in a family
 * Code does not require, the versions its newest supersedes and the models that would regress its
 * ladder (domain/probe.ts `probeSet`). `replacesDraft` says the staged
 * catalog this workspace holds will be replaced.
 */
export type ChargeReview = {
  target: Target;
  revision: number;
  budget: Selection["budget"];
  inventoryJobId: string;
  inventory: InventoryReceipt;
  candidates: BenchmarkInput;
  providers: { provider: string; requests: number }[];
  requests: number;
  exclusions: Exclusion[];
  pool: { providers: string[]; poolIdentityDigest: string };
  defaultsRevision: number;
  replacesDraft: boolean;
};
export type VerifiedModels = { configuration: Configuration; exclusions: Exclusion[]; provenance: VerificationProvenance };
/** A prepared verification: its charge, and the one explicit confirmation that spends it. */
export type PendingVerification = {
  charge: ChargeReview;
  confirm: (selection: Selection | null, options?: VerificationOptions) => Promise<VerifiedModels>;
};
/** How often a verification re-reads the probe job it waits on. OMP reports no progress inside
 * a job, so the per-provider progress a verification reports is the provider jobs it finished. */
const PROBE_POLL_MS = 1_000;
const activeJobStates: readonly PublicJob["state"][] = ["queued", "admitted", "start-committed", "started"];

/** One verification's bookkeeping: the step it is at, what it has left behind, and the single
 * place cancellation and revocation are checked, before and after every effect. */
interface VerificationRun {
  readonly evidence: VerificationEvidence;
  fail(reason: string): VerificationError;
  check(): void;
  enter(next: VerificationStep): void;
  progress(next: ProviderProgress[]): void;
  /** One door call: refused at this step if it fails, and checked again once it answers unless
   * `checkAfter` is false — for a call that started a job, whose wait checks and cancels instead. */
  call<T>(work: () => Promise<T>, checkAfter?: boolean): Promise<T>;
  /** A pause that a cancellation ends early, and that checks currency when it ends. */
  wait(ms: number): Promise<void>;
}
function verificationRun(options: VerificationOptions, evidence: VerificationEvidence): VerificationRun {
  let step: VerificationStep = "observe";
  let providers: ProviderProgress[] = [];
  const report = () => options.onProgress?.({ step, providers: providers.map(entry => ({ ...entry })) });
  const fail = (reason: string) => new VerificationError(step, reason, evidence);
  const check = () => {
    if (options.signal?.aborted) throw fail("code_verification_cancelled");
    if (options.isCurrent && !options.isCurrent()) throw fail("code_verification_changed");
  };
  return {
    evidence, fail, check,
    enter(next: VerificationStep) { check(); step = next; report(); },
    progress(next: ProviderProgress[]) { providers = next; report(); },
    async call<T>(work: () => Promise<T>, checkAfter = true): Promise<T> {
      check();
      let value: T;
      try { value = await work(); }
      catch (error) {
        if (error instanceof VerificationError) throw error;
        throw fail(error instanceof Error ? error.message : "code_operation_unavailable");
      }
      if (checkAfter) check();
      return value;
    },
    wait(ms: number): Promise<void> {
      return new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, ms);
        options.signal?.addEventListener("abort", done, { once: true });
      }).then(check);
    },
  };
}
function accepted<T>(reply: T | { refused: string }): T {
  if (typeof reply === "object" && reply !== null && "refused" in reply) throw new WorkflowError(reply.refused);
  return reply as T;
}
const jobNode = z.strictObject({ kind: z.literal("job"), machineId: z.string().min(1), operationId: z.string().min(1), jobId: z.string().min(1) });
type JobNode = z.infer<typeof jobNode>;
const nativeActions = {
  reviewDeployment: { input: JobDeploymentRequestSchema, result: JobDeploymentReviewSchema },
  applyDeployment: { input: JobDeploymentApplyArgsSchema, result: JobDeploymentSchema },
  readDeployment: { input: JobDeploymentReadArgsSchema, result: JobDeploymentSchema },
  listDeployments: { input: JobDeploymentListArgsSchema, result: JobDeploymentListResultSchema },
  cancel: { input: z.strictObject({ node: jobNode }), result: z.strictObject({ accepted: z.literal(true) }) },
} as const;
export type SessionReview = {
  destination: Target;
  composition: ActionResult<"composeSession">;
  native: OmpResult<"reviewSession">;
};
export type ResumeSessionOptions = Pick<OmpInput<"resumeSession">, "skills" | "automation"> & { profile?: { target: Target; expectedRevision: number } };
export function runningSessionTerminals(ref: OmpSessionRef, terminals: readonly TerminalSummary[]): TerminalSummary[] {
  return terminals.filter(terminal => terminal.status === "running" && terminal.machineId === ref.machineId &&
    terminal.session?.harness === ref.harness && terminal.session.machineId === ref.machineId && terminal.session.sessionId === ref.sessionId);
}
export type ResumeSessionResult =
  | { kind: "reopen"; terminals: TerminalSummary[] }
  | { kind: "prepared"; prepared: OmpResult<"resumeSession"> };
export type RuntimeConfigurationReview =
  | { kind: "account-runtime"; input: OmpInput<"reviewAccountRuntime">; result: OmpResult<"reviewAccountRuntime"> }
  | { kind: "gateway"; input: OmpInput<"reviewGateway">; result: OmpResult<"reviewGateway"> };
const serviceObservation = z.object({ machineId: ServiceReadArgsSchema.shape.machineId, connected: z.boolean(),
  services: z.array(z.object({ serviceId: ServiceReadArgsSchema.shape.serviceId, revision: ServiceReadArgsSchema.shape.revision,
    operations: z.array(z.object({ operationId: ServiceReadArgsSchema.shape.operationId, ready: z.boolean(), invocable: z.boolean() })) })) });

/** Ordinary caller transport only. No server contexts, credentials, shell descriptors,
 * grants or React state are available to this browser/headless decision path. */
export function createCodeWorkflowClient(dispatch: Dispatch) {
  const codeClient = createCodeClient(dispatch);
  const ompClient = createOmpClient(dispatch);
  const code = async <K extends CodeAction>(name: K, input: ActionInput<K>): Promise<ActionResult<K>> => accepted(await codeClient.call(name, input));
  const omp = async <K extends OmpAction>(name: K, input: OmpInput<K>): Promise<OmpResult<K>> => accepted(await ompClient.call(name, input));
  async function native<K extends keyof typeof nativeActions>(name: K, input: z.infer<(typeof nativeActions)[K]["input"]>): Promise<z.infer<(typeof nativeActions)[K]["result"]>> {
    return nativeActions[name].result.parse(await dispatch(`engine.jobs.${name}`, nativeActions[name].input.parse(input))) as z.infer<(typeof nativeActions)[K]["result"]>;
  }
  // The bundled list the render-only preview is drawn from, and whose `ompVersion` says which
  // OMP a verified catalog is compared against. Never a source of a saved profile.
  const readStarterCatalog = () => omp("readModelCatalog", { providers: ["anthropic", "deepseek", "openai-codex"] });
  async function readJob(node: JobNode) {
    if (!node.operationId.startsWith(`${OMP_PLUGIN_ID}.`)) throw new WorkflowError("omp_result_unavailable");
    const job = PublicJobSchema.parse(await dispatch("engine.jobs.status", { node }));
    if (job.machineId !== node.machineId || job.pluginId !== OMP_PLUGIN_ID || job.operationId !== node.operationId || job.jobId !== node.jobId)
      throw new WorkflowError("omp_result_unavailable");
    return job;
  }
  // Inventory rows carry no quota class yet, so which models draw a quota of their own (Spark) is
  // read from OMP's bundled metadata; the derivation joins it only at the inventory's OMP version.
  async function quotaMetadata(inventory: OmpResult<"readInventory">["inventory"]): Promise<{ metadata?: OmpResult<"readModelCatalog"> }> {
    const providers = quotaProviders(inventory);
    return providers.length === 0 ? {} : { metadata: await omp("readModelCatalog", { providers }) };
  }
  // The budget is the one already selected, not a separate choice: deriving a catalog under a
  // free budget while the selection asks for free is the same question asked once. Required
  // rather than defaulted, because "which budget was this catalog derived under" is not a
  // question a caller should be able to leave unanswered.
  async function readInventory(input: OmpInput<"readInventory">, budget: Selection["budget"]) {
    const receipt = await omp("readInventory", input);
    return { ...receipt, draft: await code("draftInventory", { inventory: receipt.inventory, budget }) };
  }
  async function readBenchmark(input: OmpInput<"readBenchmark">, budget: Selection["budget"]) {
    const [inventory, receipt] = await Promise.all([omp("readInventory", { containerId: input.containerId, machineId: input.machineId, jobId: input.inventoryJobId }), omp("readBenchmark", input)]);
    const derived = await code("deriveCatalog", { inventory: inventory.inventory, benchmark: receipt.benchmark, budget, ...await quotaMetadata(inventory.inventory) });
    // The bare document is what gets staged; the exclusions say why each other offered model is absent.
    return { ...receipt, catalog: derived.document, exclusions: derived.exclusions };
  }
  /** The account pool this workspace's saved choices select from a fresh observation, as Code
   * composes it for a probe; `composeProbe` refuses a moved revision or an empty pool. */
  async function observePool(containerId: string, expectedRevision: number) {
    const accounts = await omp("accounts", {});
    const probe = await code("composeProbe", { containerId, expectedRevision, accounts });
    return { accounts, accountPool: probe.accountPool, poolIdentityDigest: probe.poolIdentityDigest,
      providers: Object.keys(probe.accountPool).filter(provider => probe.accountPool[provider]!.length > 0).sort() };
  }
  /**
   * A probe job followed to its end. A stop — before a wait or during one — cancels the job
   * through the native job owner, because a benchmark still running after its caller left is
   * still spending; the job and whatever it already answered stay in OMP's history either way.
   */
  async function settledJob(job: PublicJob, node: JobNode, run: VerificationRun): Promise<void> {
    if (job.jobId !== node.jobId || job.machineId !== node.machineId || job.operationId !== node.operationId || job.pluginId !== OMP_PLUGIN_ID)
      throw run.fail("omp_result_unavailable");
    let current = job;
    while (activeJobStates.includes(current.state)) {
      try {
        run.check();
        await run.wait(PROBE_POLL_MS);
      } catch (stop) {
        try { await native("cancel", { node }); }
        catch (error) { throw run.fail(`${stop instanceof VerificationError ? stop.reason : "code_verification_changed"}; job ${job.jobId} was not cancelled: ${error instanceof Error ? error.message : "unknown"}`); }
        throw stop;
      }
      current = await run.call(() => readJob(node), false);
    }
    if (current.state !== "exited" || current.result?.exitCode !== 0)
      throw run.fail(`job ${job.jobId} ${current.state}${current.result?.exitCode == null ? "" : ` with exit code ${current.result.exitCode}`}`);
  }
  /** The world a charge was reviewed in, still: the same Code revision, the same exact account
   * pool and the same OMP defaults. Anything else would spend or save against a different one. */
  async function unchangedCharge(charge: ChargeReview, run: VerificationRun) {
    const [defaults, pool] = await run.call(() => Promise.all([omp("readDefaults", {}), observePool(charge.target.containerId, charge.revision)]));
    if (defaults.revision !== charge.defaultsRevision) throw run.fail("omp_defaults_changed");
    if (pool.poolIdentityDigest !== charge.pool.poolIdentityDigest) throw run.fail("code_accounts_changed");
    return pool;
  }
  /**
   * VERIFY MODELS WITH THE OPERATOR'S ACCOUNTS, through OMP's own inventory and benchmark: the one
   * way a Code catalog comes to name models, because only a probe shows which this operator can
   * call. Preparing reads the workspace at `expectedRevision` (initializing an absent one), runs
   * OMP's inventory with the pool Code composes, and answers the charge — nothing has been probed
   * or paid for yet. Only `confirm` spends: one benchmark job per provider, then derive, stage,
   * review, promote, and save the caller's selection narrowed to what the verified catalog hosts.
   *
   * Every step re-observes before it acts and stops, naming itself, on a moved revision, pool or
   * OMP defaults, a refusal, a cancelled `signal` or a revoked `isCurrent`. A stop never undoes:
   * probe jobs stay in OMP's history and a staged catalog stays staged, both named in the error's
   * evidence. A failed or uncertain confirmation is never replayed; observe the workspace first.
   */
  async function verifyModels(target: Target, input: { expectedRevision: number; budget: Selection["budget"] },
    options: VerificationOptions = {}): Promise<PendingVerification> {
    const evidence: VerificationEvidence = { inventoryJobId: null, benchmarkJobIds: [], revision: null };
    const run = verificationRun(options, evidence);
    run.enter("observe");
    const observed = await run.call(() => code("readConfiguration", { containerId: target.containerId }));
    if (observed.revision !== input.expectedRevision) throw run.fail("code_stale_preferences");
    let record = observed.configuration;
    if (record === null) {
      run.enter("initialize");
      record = await run.call(() => code("initializeConfiguration", { containerId: target.containerId, expectedRevision: input.expectedRevision }));
      evidence.revision = record.revision;
    }
    const revision = record.revision, replacesDraft = record.draft !== null;
    run.enter("inventory");
    const [defaults, pool] = await run.call(() => Promise.all([omp("readDefaults", {}), observePool(target.containerId, revision)]));
    // The start is checked by the job's own wait, so a stop that lands now cancels the job rather than abandoning it.
    const job = await run.call(() => omp("startInventory", { ...target, expectedDefaultsRevision: defaults.revision, accountPool: pool.accountPool }), false);
    evidence.inventoryJobId = job.jobId;
    await settledJob(job, { kind: "job", machineId: target.machineId, operationId: INVENTORY_OPERATION_ID, jobId: job.jobId }, run);
    const { inventory } = await run.call(() => omp("readInventory", { ...target, jobId: job.jobId }));
    run.enter("draft");
    const draft = await run.call(() => code("draftInventory", { inventory, budget: input.budget }));
    const requests = new Map<string, number>();
    for (const candidate of draft.benchmark.candidates) requests.set(candidate.provider, (requests.get(candidate.provider) ?? 0) + 1);
    const charge: ChargeReview = { target: { ...target }, revision, budget: input.budget, inventoryJobId: job.jobId, inventory,
      candidates: draft.benchmark, providers: [...requests].sort(([left], [right]) => left < right ? -1 : 1).map(([provider, count]) => ({ provider, requests: count })),
      requests: draft.benchmark.candidates.length, exclusions: draft.exclusions,
      pool: { providers: pool.providers, poolIdentityDigest: pool.poolIdentityDigest }, defaultsRevision: defaults.revision, replacesDraft };
    // The charge is answered only for a world that still holds, so the operator never confirms a
    // spend against a pool or defaults that moved while the inventory ran.
    await unchangedCharge(charge, run);
    run.progress(charge.providers.map(({ provider, requests: total }) => ({ provider, done: 0, total })));
    let confirmed = false;
    return {
      charge,
      confirm: (selection, confirmOptions = options) => {
        if (confirmed) return Promise.reject(new WorkflowError("code_verification_confirmed"));
        confirmed = true;
        return confirmVerification(charge, selection, verificationRun(confirmOptions, { ...evidence, benchmarkJobIds: [] }));
      },
    };
  }
  async function confirmVerification(charge: ChargeReview, wanted: Selection | null, run: VerificationRun): Promise<VerifiedModels> {
    const { target } = charge;
    run.enter("benchmark");
    await unchangedCharge(charge, run);
    const progress: ProviderProgress[] = charge.providers.map(({ provider, requests }) => ({ provider, done: 0, total: requests }));
    run.progress(progress);
    const receipts: BenchmarkReceipt[] = [];
    // One job per provider, in turn: OMP reports nothing from inside a job, so this is the
    // granularity at which progress can be stated rather than invented.
    for (const entry of progress) {
      const candidates = { ...charge.candidates, candidates: charge.candidates.candidates.filter(candidate => candidate.provider === entry.provider) };
      const job = await run.call(() => omp("startBenchmark", { ...target, inventoryJobId: charge.inventoryJobId, candidates }), false);
      run.evidence.benchmarkJobIds.push(job.jobId);
      await settledJob(job, { kind: "job", machineId: target.machineId, operationId: BENCHMARK_OPERATION_ID, jobId: job.jobId }, run);
      const { benchmark } = await run.call(() => omp("readBenchmark", { ...target, inventoryJobId: charge.inventoryJobId, jobId: job.jobId }));
      receipts.push(benchmark);
      entry.done = benchmark.results.length;
      run.progress(progress);
    }
    run.enter("derive");
    // The providers' receipts are one benchmark of one inventory: the union of their verdicts.
    const benchmark: BenchmarkReceipt = { schemaVersion: 1, kind: "benchmark", ompVersion: charge.inventory.ompVersion,
      inventoryObservedAt: charge.inventory.observedAt, startedAt: Math.min(...receipts.map(receipt => receipt.startedAt)),
      completedAt: Math.max(...receipts.map(receipt => receipt.completedAt)), results: receipts.flatMap(receipt => receipt.results) };
    const derived = await run.call(async () => code("deriveCatalog", { inventory: charge.inventory, benchmark, budget: charge.budget, ...await quotaMetadata(charge.inventory) }));
    // Narrowed before anything is written, so a selection the verified catalog cannot serve stops
    // here with nothing staged, rather than after a promotion saved its default instead.
    let selection: Selection;
    try { selection = clampSelection(compileCatalog(derived.document), wanted); }
    catch (error) { throw run.fail(error instanceof Error ? error.message : "code_invalid_selection"); }
    run.enter("stage");
    const pool = await unchangedCharge(charge, run);
    const staged = await run.call(() => code("stageCatalog", { containerId: target.containerId, expectedRevision: charge.revision, document: derived.document,
      verification: { ompVersion: charge.inventory.ompVersion, inventoryObservedAt: charge.inventory.observedAt,
        benchmarkCompletedAt: benchmark.completedAt, accounts: pool.accounts, poolIdentityDigest: charge.pool.poolIdentityDigest } }));
    run.evidence.revision = staged.revision;
    run.enter("review");
    const review = await run.call(() => code("reviewCatalog", { containerId: target.containerId, expectedRevision: staged.revision, source: "draft" }));
    if (review.catalogDigest !== staged.draft?.digest || canonicalJobJson(review.provenance) !== canonicalJobJson(staged.draft.provenance))
      throw run.fail("code_preview_changed");
    run.enter("promote");
    const promoted = await run.call(() => code("promoteCatalog", { containerId: target.containerId, expectedRevision: staged.revision, source: "draft", reviewDigest: review.reviewDigest }));
    run.evidence.revision = promoted.revision;
    run.enter("select");
    const configuration = canonicalJobJson(promoted.selection) === canonicalJobJson(selection) ? promoted
      : await run.call(() => code("select", { containerId: target.containerId, expectedRevision: promoted.revision, selection }));
    run.evidence.revision = configuration.revision;
    if (!configuration.active?.provenance) throw run.fail("code_preview_changed");
    return { configuration, exclusions: derived.exclusions, provenance: configuration.active.provenance };
  }
  /**
   * The pool a verification would record today, for comparing with the one it did record. Null
   * when the saved choices select no account from the current observation, which is itself a
   * change from any verification; other failures are failures to observe, and throw.
   */
  async function observeVerification(containerId: string, expectedRevision: number, choices: AccountChoices) {
    const accounts = await omp("accounts", {});
    try {
      if (!Object.values(selectedAccountPool(accounts, choices)).some(slots => slots.length > 0)) return null;
    } catch (error) {
      if (error instanceof DomainError) return null;
      throw error;
    }
    const probe = await code("composeProbe", { containerId, expectedRevision, accounts });
    return { providers: Object.keys(probe.accountPool).filter(provider => probe.accountPool[provider]!.length > 0).sort(),
      poolIdentityDigest: probe.poolIdentityDigest };
  }
  async function composeSession(target: Target, expectedRevision: number, prompt: string) {
    const accounts = await omp("accounts", {});
    return code("composeSession", { containerId: target.containerId, expectedRevision, accounts, prompt });
  }
  async function readMachines() {
    return MachinesResponseSchema.parse(await dispatch("core.machines.list", {})).machines;
  }
  async function availableMachine(machineId: string) {
    const machine = (await readMachines()).find(machine => machine.id === machineId);
    if (!machine || !machine.online || machine.revoked) throw new WorkflowError("The selected machine is offline or inaccessible. Choose a destination explicitly; nothing was resumed.");
    return machine;
  }
  async function listSessions(machineId: string) {
    await availableMachine(machineId);
    return omp("listSessions", { machineId });
  }
  async function runningSession(ref: OmpSessionRef) {
    const session = OmpSessionRefSchema.parse(ref);
    await availableMachine(session.machineId);
    return runningSessionTerminals(session, TerminalsResponseSchema.parse(await dispatch("core.terminals.listAll", {})).terminals);
  }
  return {
    code, omp, native,
    readStarterCatalog, verifyModels, observeVerification,
    readSkillCatalog: (target: Target) => omp("readSkillCatalog", target),
    listSessions, runningSession,
    async resumeSession(ref: OmpSessionRef, options: ResumeSessionOptions = {}, isCurrent: () => boolean = () => true): Promise<ResumeSessionResult> {
      const session = OmpSessionRefSchema.parse(ref);
      const assertCurrent = () => { if (!isCurrent()) throw new WorkflowError("Destination or session choices changed. Nothing was placed."); };
      assertCurrent();
      const { profile, ...policy } = options;
      const input: OmpInput<"resumeSession"> = { machineId: session.machineId, sessionId: session.sessionId, ...policy };
      // Existing terminals take precedence over options that only apply to a new resume.
      // Missing correlation remains unknown activity, not evidence that OMP stopped.
      const sessions = await listSessions(session.machineId);
      const terminals = await runningSession(session);
      assertCurrent();
      if (terminals.length) return { kind: "reopen", terminals };
      if (!sessions.some(candidate => candidate.id === session.sessionId)) throw new WorkflowError("omp_session_unavailable");
      if (profile) {
        if (profile.target.machineId !== session.machineId) throw new WorkflowError("omp_session_binding_changed");
        const composition = await composeSession(profile.target, profile.expectedRevision, "");
        const appeared = await runningSession(session);
        assertCurrent();
        if (appeared.length) return { kind: "reopen", terminals: appeared };
        if (composition.planYolo) throw new WorkflowError("omp_resume_plan_unsupported");
        const model = composition.overlay.modelRoles?.default;
        const thinking = composition.review.routes.find(route => route.role === "default")?.lead.thinking;
        if (!model || !thinking) throw new WorkflowError("code_composition_changed");
        Object.assign(input, { containerId: profile.target.containerId, overlay: composition.overlay,
          accountPool: composition.accountPool, overrides: { model, thinking } });
      }
      const prepared = await omp("resumeSession", input);
      if (prepared.machineId !== session.machineId || prepared.sessionId !== session.sessionId ||
        prepared.runtime.pluginId !== OMP_PLUGIN_ID || prepared.runtime.operationId !== RESUME_OPERATION_ID ||
        prepared.runtime.machineId !== session.machineId || prepared.runtime.session?.harness !== session.harness ||
        prepared.runtime.session.machineId !== session.machineId || prepared.runtime.session.sessionId !== session.sessionId)
        throw new WorkflowError("omp_session_binding_changed");
      assertCurrent();
      const appeared = await runningSession(session);
      assertCurrent();
      return appeared.length ? { kind: "reopen", terminals: appeared } : { kind: "prepared", prepared };
    },
    permissionPlan: (input: PermissionPlanInput) => observePermissionPlan(omp, input),
    async reviewPermissionStep(input: PermissionPlanInput, scopeDigest: string, index: number) {
      const plan = await observePermissionPlan(omp, input);
      if (plan.scopeDigest !== scopeDigest) throw new WorkflowError("The destination or requested scope changed. Review the current choices again.");
      if (plan.blockers.length) throw new WorkflowError(plan.blockers.join(" "));
      const step = plan.steps[index];
      if (!step) {
        if (plan.steps.some(step => !step.nativeReady || !step.configurationCurrent)) throw new WorkflowError("Native capability readiness changed. Review again.");
        return { phase: "ready" as const, plan };
      }
      if (step.nativeReady && step.configurationCurrent) return { phase: "step-ready" as const, plan };
      if (step.nativeReady) return { phase: "configuration" as const, plan };
      const history = await native("listDeployments", { pluginId: step.request.pluginId, limit: 100 });
      const deployment = history.deployments.find(deployment => !deployment.cancelled && deployment.review.request.pluginId === step.request.pluginId &&
        canonicalJobJson(deployment.review.request.targets) === canonicalJobJson(step.request.targets) &&
        [...deployment.review.request.operationIds].sort().join("\n") === [...step.request.operationIds].sort().join("\n") &&
        deployment.targets.every(target => ["pending", "installing", "ready"].includes(target.state)));
      if (deployment) return { phase: "progress" as const, plan, deployment, review: deployment.review };
      const review = await native("reviewDeployment", step.request);
      if (canonicalJobJson(review.request) !== canonicalJobJson(step.request)) throw new WorkflowError("Native review returned a different request scope. Nothing was approved.");
      return { phase: "review" as const, plan, review };
    },
    readJob,
    async listRuns(target: Target, operationId: string) {
      if (!operationId.startsWith(`${OMP_PLUGIN_ID}.`)) throw new WorkflowError("omp_result_unavailable");
      const result = ListJobRunsResultSchema.parse(await dispatch("engine.jobs.listRuns", { machineId: target.machineId, pluginId: OMP_PLUGIN_ID, operationId, limit: 100 }));
      if (result.runs.some(run => {
        const identity = run.job ?? run.occurrence;
        return identity && (identity.machineId !== target.machineId || identity.pluginId !== OMP_PLUGIN_ID || identity.operationId !== operationId);
      })) throw new WorkflowError("omp_result_unavailable");
      return result;
    },
    async classifier(target: Target) {
      const observed = serviceObservation.parse(await dispatch("engine.services.describe", { machineId: target.machineId }));
      if (observed.machineId !== target.machineId) throw new WorkflowError("code_service_configuration_changed");
      return observed.connected ? observed.services.find(service => service.serviceId === "suggest" &&
        service.operations.some(operation => operation.operationId === "classify" && operation.ready && operation.invocable)) ?? null : null;
    },
    async reviewRuntimeConfiguration(kind: RuntimeConfigurationReview["kind"], target: Target): Promise<RuntimeConfigurationReview> {
      if (kind === "account-runtime") {
        const setup = await omp("readAccountSetup", {});
        if (setup.callerRefusal) throw new WorkflowError(setup.callerRefusal);
        const input = { expectedBrokerRevision: setup.revision };
        return { kind, input, result: await omp("reviewAccountRuntime", input) };
      }
      const setup = await omp("readGatewaySetup", target);
      if (setup.callerRefusal) throw new WorkflowError(setup.callerRefusal);
      const input = { ...target, expectedServiceRevision: setup.revision };
      return { kind, input, result: await omp("reviewGateway", input) };
    },
    async applyRuntimeConfiguration(containerId: string, reviewed: RuntimeConfigurationReview) {
      if (reviewed.kind === "account-runtime") {
        const current = await omp("readAccountSetup", {});
        if (current.callerRefusal || current.revision !== reviewed.input.expectedBrokerRevision || current.owner?.machineId !== reviewed.result.ownerMachineId)
          throw new WorkflowError(current.callerRefusal ?? "omp_review_changed");
        return omp("promoteAccountRuntime", { ...reviewed.input, containerId, reviewDigest: reviewed.result.reviewDigest });
      }
      const current = await omp("readGatewaySetup", { containerId: reviewed.input.containerId, machineId: reviewed.input.machineId });
      if (current.callerRefusal || current.revision !== reviewed.input.expectedServiceRevision) throw new WorkflowError(current.callerRefusal ?? "omp_review_changed");
      return omp("configureGateway", { ...reviewed.input, reviewDigest: reviewed.result.reviewDigest });
    },
    async prepareWorkspace(target: Target, mode: "create" | "existing") {
      const input = { ...target, mode: mode === "existing" ? "validate" as const : "create" as const };
      const review = await omp("reviewWorkspace", input);
      const current = await omp("describeDestination", target);
      const operationId = mode === "existing" ? VALIDATE_WORKSPACE_OPERATION_ID : PREPARE_WORKSPACE_OPERATION_ID;
      const pins = current.operations.find(operation => operation.operationId === operationId)?.pins;
      if (review.destination.machineId !== target.machineId || review.destination.containerId !== target.containerId || review.operationId !== operationId ||
        !operationReady(current, operationId) || canonicalJobJson(pins) !== canonicalJobJson(review.pins)) throw new WorkflowError("omp_review_changed");
      return omp("prepareWorkspace", { ...input, reviewDigest: review.reviewDigest });
    },
    async startInventory(target: Target, expectedRevision: number) {
      const [defaults, accounts] = await Promise.all([omp("readDefaults", {}), omp("accounts", {})]);
      const composition = await code("composeProbe", { containerId: target.containerId, expectedRevision, accounts });
      return omp("startInventory", { ...target, expectedDefaultsRevision: defaults.revision, accountPool: composition.accountPool });
    },
    readInventory, readBenchmark,
    // The budget reaches the BENCHMARK too, because the candidate set is what gets probed: under
    // `free` this posts 32 probes instead of 179, and under any budget it probes only models the
    // resulting catalog could actually ladder.
    async startBenchmark(target: Target, inventoryJobId: string, budget: Selection["budget"]) {
      const inventory = await readInventory({ ...target, jobId: inventoryJobId }, budget);
      return omp("startBenchmark", { ...target, inventoryJobId, candidates: inventory.draft.benchmark });
    },
    async stageBenchmark(input: OmpInput<"readBenchmark">, expectedRevision: number, budget: Selection["budget"]) {
      const receipt = await readBenchmark(input, budget);
      return code("stageCatalog", { containerId: input.containerId, expectedRevision, document: receipt.catalog });
    },
    async reviewSession(target: Target, expectedRevision: number, prompt: string, options: SessionOptions = {}): Promise<SessionReview> {
      const [composition, defaults] = await Promise.all([composeSession(target, expectedRevision, prompt), omp("readDefaults", {})]);
      const native = await omp("reviewSession", sessionInput(target, composition, defaults.revision, options));
      const operationId = options.isolation === undefined ? LAUNCH_OPERATION_ID : MATERIAL_SESSION_OPERATION_ID;
      if (native.agentTools !== undefined || native.operationId !== operationId || native.destination.containerId !== target.containerId ||
        native.destination.machineId !== target.machineId || native.defaultsRevision !== defaults.revision ||
        canonicalJobJson(native.isolation ?? null) !== canonicalJobJson(options.isolation ?? null))
        throw new WorkflowError("omp_review_changed");
      return { destination: { ...target }, composition, native };
    },
    async prepareSession(review: SessionReview): Promise<OmpResult<"prepareSession">> {
      if (review.native.agentTools !== undefined || review.native.operationId !== LAUNCH_OPERATION_ID) throw new WorkflowError("omp_review_changed");
      const [composition, defaults] = await Promise.all([
        composeSession(review.destination, review.composition.revision, review.composition.prompt), omp("readDefaults", {}),
      ]);
      if (composition.compositionDigest !== review.composition.compositionDigest || defaults.revision !== review.native.defaultsRevision)
        throw new WorkflowError("code_composition_changed");
      const prepared = await omp("prepareSession", { ...sessionInput(review.destination, composition, defaults.revision, reviewedSessionOptions(review.native)), reviewDigest: review.native.reviewDigest });
      const runtime = prepared.runtime;
      if (prepared.destination.containerId !== review.destination.containerId || prepared.destination.machineId !== review.destination.machineId || prepared.reviewDigest !== review.native.reviewDigest ||
        runtime.pluginId !== OMP_PLUGIN_ID || runtime.operationId !== review.native.operationId ||
        runtime.installationRevision !== review.native.pins.installationRevision ||
        runtime.artifactSha256 !== review.native.pins.artifactSha256 ||
        runtime.resourceBindingDigest !== review.native.pins.resourceBindingDigest ||
        canonicalJobJson(runtime.inputs ?? []) !== canonicalJobJson(skillInputBindings(review.native.skills)) ||
        !OmpSessionRefSchema.safeParse(runtime.session).success ||
        runtime.session?.machineId !== review.destination.machineId || runtime.session.sessionId !== runtime.input.sessionId)
        throw new WorkflowError("omp_review_changed");
      return prepared;
    },
    async prepareSignIn(containerId: string, expectedBrokerRevision: string) {
      const current = await omp("readAccountSetup", {});
      if (!current.canSignIn || current.callerRefusal || current.revision !== expectedBrokerRevision) throw new WorkflowError(current.callerRefusal ?? "omp_review_changed");
      const prepared = await omp("prepareSignIn", { containerId, expectedBrokerRevision });
      if (prepared.machineId !== current.owner?.machineId) throw new WorkflowError("omp_review_changed");
      return prepared;
    },
    async usage(choices: AccountChoices) {
      const value = await omp("usage", {});
      return projectUsage(value.snapshot, value.accounts, choices, Date.now(), { maxAgeMs: 300_000, refreshStatus: value.refreshStatus });
    },
  };
}
