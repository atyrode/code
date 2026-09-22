import { createOmpClient, OmpSessionRefSchema, OMP_PLUGIN_ID, LAUNCH_OPERATION_ID, MATERIAL_SESSION_OPERATION_ID, RESUME_OPERATION_ID, skillInputBindings, PREPARE_WORKSPACE_OPERATION_ID, VALIDATE_WORKSPACE_OPERATION_ID, type OmpSessionRef, type OmpAction, type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { JobDeploymentApplyArgsSchema, JobDeploymentListArgsSchema, JobDeploymentListResultSchema,
  JobDeploymentReadArgsSchema, JobDeploymentRequestSchema, JobDeploymentReviewSchema, JobDeploymentSchema, ServiceReadArgsSchema, PublicJobSchema, ListJobRunsResultSchema, MachinesResponseSchema, TerminalsResponseSchema, type TerminalSummary, canonicalJobJson } from "@manifold/protocol";
import { z } from "zod";
import { createCodeClient, reviewedSessionOptions, sessionInput, type SessionOptions, type CodeAction, type ActionInput, type ActionResult, type Target } from "./contract.ts";
import { observePermissionPlan, operationReady, type PermissionPlanInput } from "./permission-plan.ts";
import { projectUsage } from "../domain/usage.ts";
import type { AccountChoices, Selection } from "../domain/contracts.ts";

export type Dispatch = (door: string, input: unknown) => Promise<unknown>;
export class WorkflowError extends Error {}
function accepted<T>(reply: T | { refused: string }): T {
  if (typeof reply === "object" && reply !== null && "refused" in reply) throw new WorkflowError(reply.refused);
  return reply as T;
}
const nativeActions = {
  reviewDeployment: { input: JobDeploymentRequestSchema, result: JobDeploymentReviewSchema },
  applyDeployment: { input: JobDeploymentApplyArgsSchema, result: JobDeploymentSchema },
  readDeployment: { input: JobDeploymentReadArgsSchema, result: JobDeploymentSchema },
  listDeployments: { input: JobDeploymentListArgsSchema, result: JobDeploymentListResultSchema },
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
    return { ...receipt, catalog: await code("deriveCatalog", { inventory: inventory.inventory, benchmark: receipt.benchmark, budget }) };
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
    async readJob(node: { kind: "job"; machineId: string; operationId: string; jobId: string }) {
      if (!node.operationId.startsWith(`${OMP_PLUGIN_ID}.`)) throw new WorkflowError("omp_result_unavailable");
      const job = PublicJobSchema.parse(await dispatch("engine.jobs.status", { node }));
      if (job.machineId !== node.machineId || job.pluginId !== OMP_PLUGIN_ID || job.operationId !== node.operationId || job.jobId !== node.jobId)
        throw new WorkflowError("omp_result_unavailable");
      return job;
    },
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
      if (native.operationId !== operationId || native.destination.containerId !== target.containerId ||
        native.destination.machineId !== target.machineId || native.defaultsRevision !== defaults.revision ||
        canonicalJobJson(native.isolation ?? null) !== canonicalJobJson(options.isolation ?? null))
        throw new WorkflowError("omp_review_changed");
      return { destination: { ...target }, composition, native };
    },
    async prepareSession(review: SessionReview): Promise<OmpResult<"prepareSession">> {
      if (review.native.operationId !== LAUNCH_OPERATION_ID) throw new WorkflowError("omp_review_changed");
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
