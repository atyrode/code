import { createOmpClient, OmpHarnessProfileSchema, OmpSessionRefSchema, OMP_PLUGIN_ID, LAUNCH_OPERATION_ID, MATERIAL_SESSION_OPERATION_ID, RESUME_OPERATION_ID, skillInputBindings, PREPARE_WORKSPACE_OPERATION_ID, VALIDATE_WORKSPACE_OPERATION_ID,
  INVENTORY_OPERATION_ID, BENCHMARK_OPERATION_ID, ThinkingSelectorSchema,
  type BenchmarkInput, type BenchmarkReceipt, type InventoryReceipt, type OmpHarnessProfile, type OmpSessionRef, type OmpAction, type RunDials, type ThinkingSelector,
  type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { JobDeploymentApplyArgsSchema, JobDeploymentListArgsSchema, JobDeploymentListResultSchema,
  JobDeploymentReadArgsSchema, JobDeploymentRequestSchema, JobDeploymentReviewSchema, JobDeploymentSchema, ServiceReadArgsSchema, PublicJobSchema, ListJobRunsResultSchema, MachinesResponseSchema, TerminalsResponseSchema, type PublicJob, type TerminalSummary, canonicalJobJson,
  AGENT_RUN_MAX_LIFETIME_MS, AGENT_RUN_MAX_RENEWALS, CreateRunV2ResultSchema, FinishAgentRunV2ResultSchema, InspectRunV2ResultSchema, LaunchRunResultSchema, ListAgentsV2ResultSchema,
  ListRunsV2ResultSchema, RegisterAgentV2ResultSchema, UpdateAgentV2ResultSchema, formatManifoldUri,
  type AgentRunV2, type AgentV2, type AuthorityScope, type InspectRunV2Result, type LaunchRunResult, type ListRunsV2Result, type RunModel } from "@manifold/protocol";
import { z } from "zod";
import { createCodeClient, reviewedSessionOptions, sessionInput, type SessionOptions, type CodeAction, type ActionInput, type ActionResult, type Configuration, type Target, type VerificationProvenance } from "./contract.ts";
import { HARNESS_OPERATION_ID, observePermissionPlan, operationReady, type PermissionPlanInput } from "./permission-plan.ts";
import { selectedAccountPool } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { projectUsage } from "../domain/usage.ts";
import type { Exclusion } from "../domain/probe.ts";
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
  code_omp_changed: "OMP or its model list changed on the machine since the inventory. Verify again.",
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
  omp_tui_plan_unsupported: "OMP's terminal UI under an agent cannot approve plans automatically.",
  omp_harness_runtime_unsupported: "OMP's agent harness on that machine predates live dials. Review sessions in Setup again.",
  omp_run_control_forbidden: "Only the run's launcher or its agent's sponsor turns its dials.",
  omp_model_unavailable: "The session does not serve that model.",
  omp_run_control_unsupported: "That run has no live dials.",
  omp_run_control_unconfirmed: "The session did not answer within 20 seconds; the change may still apply.",
  code_agent_disabled: "Code's agent for this workspace is disabled in Agents. Enable it there to launch with live dials.",
  code_agent_retired: "Code's agents for this workspace are retired in Agents.",
  code_agent_options_unsupported: "Session options and automatic plans run without an agent, so this launch cannot be an agent run.",
  code_run_changed: "Manifold launched a different run than Code asked for. Nothing was opened.",
};
/**
 * Manifold's own refusals of the Agent doors (`core.access`), which carry no `code_`/`omp_` prefix,
 * in a person's words. They are matched whole, so a message Manifold words differently is said as it
 * is rather than mistaken for one of these.
 */
const agentRefusals: Readonly<Record<string, string>> = {
  agent_registration_requires_human: "Only a person can sponsor Code's agent.",
  sponsor_authority_unavailable: "Your access does not cover sponsoring an agent in this workspace.",
  agent_sponsor_confined: "Your access does not cover sponsoring an agent in this workspace.",
  agent_unavailable: "Code's agent or its run is not yours to use.",
  agent_disabled: "Code's agent for this workspace is disabled in Agents.",
  agent_retired: "Code's agent for this workspace is retired in Agents.",
  grant_expired: "Code's agent grant has expired. Launch again to renew it.",
  scope_exceeds_grant: "The run asks for more than Code's agent may hold.",
  lifetime_exceeds_grant: "The run asks for more than Code's agent may hold.",
  agent_run_unavailable: "That run has ended or its lease has run out.",
  run_launch_protocol_unsupported: "That machine cannot launch an agent run: its native job owner is missing or predates agent runs.",
  run_launch_owner_unavailable: "That machine's native job owner is not ready to launch an agent run.",
  run_launch_binding_required: "The run's launch expired before its terminal opened.",
  "run launch binding expired or revoked": "The run's launch expired before its terminal opened.",
  "run launch credential unavailable": "The run's launch expired before its terminal opened.",
  "run launch already in progress": "That run is already launching.",
  "harness launch target changed": "The run was created for another machine or workspace.",
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
 * reported under, and its refusal token becomes words: the known ones from `messages` and Manifold's
 * Agent refusals, any other as who refused, so no raw token reaches a person. A detail written for a
 * person after the token stays.
 */
export function failureWords(message: string): string {
  const denial = DOOR_DENIAL.exec(message)?.[1] ?? message;
  if (Object.hasOwn(agentRefusals, denial)) return agentRefusals[denial]!;
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
 * catalog this workspace holds will be replaced. `inventoryArtifactSha256` and `catalogRevision`
 * are the OMP the inventory ran under: the artifact its job ran from and the model catalog OMP
 * bundled when it started, which the verification records.
 */
export type ChargeReview = {
  target: Target;
  revision: number;
  budget: Selection["budget"];
  inventoryJobId: string;
  inventory: InventoryReceipt;
  inventoryArtifactSha256: string;
  catalogRevision: string;
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
/**
 * The artifact a destination's OMP inventory operation is installed from, as `describeDestination`
 * pins it: the identity of the OMP runtime an inventory there runs, whatever version it reports.
 * Null when the operation is not installed.
 */
export function inventoryArtifact(destination: OmpResult<"describeDestination">): string | null {
  return destination.operations.find(operation => operation.operationId === INVENTORY_OPERATION_ID)?.pins?.artifactSha256 ?? null;
}
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
export function runningSessionTerminals(ref: Pick<OmpSessionRef, "machineId" | "sessionId"> & { readonly harness: string }, terminals: readonly TerminalSummary[]): TerminalSummary[] {
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

// ---------------------------------------------------------------- the agent a launch runs as
/*
 * A launch runs as an Agent Run when it can: Code registers one Agent per sponsor and workspace
 * profile with OMP's harness (`tui: true`), updates it when the profile changes, creates a Run for
 * the destination and has `core.access.launchRun` prepare OMP's terminal UI under it. The Run's
 * own credential, renewal and activity stay with OMP's harness and Manifold; Code holds nothing but
 * the sponsor's session and reads the Run back for display. The one-time runner credential a first
 * registration returns is never kept: a browser launch never needs it.
 */

/** A Code Run's lease: Manifold's longest. OMP's TUI harness renews it at half of it, for the same length. */
export const AGENT_LEASE_MS = AGENT_RUN_MAX_LIFETIME_MS;
/** Manifold's renewals per Run; the 25th is refused. */
export const AGENT_RENEWALS = AGENT_RUN_MAX_RENEWALS;
/** How long a Run can stay attributed: its first lease, then each renewal at half a lease moves its expiry half a lease on. */
export const AGENT_RUN_WINDOW_MS = AGENT_LEASE_MS + AGENT_RENEWALS * (AGENT_LEASE_MS / 2);
/** A grant outlasts the whole window of a Run created now by one more lease, so a launch never meets a grant about to end. */
const AGENT_GRANT_MS = AGENT_RUN_WINDOW_MS + AGENT_LEASE_MS;
/** A retired Agent never runs again, so its name passes to the next generation; this many retirements end Code's agent launches here. */
const AGENT_GENERATIONS = 8;
/** How long an ended Run stays listed, and how many at most: the recent ones a person may want to resume. */
const ENDED_RUNS_MS = 86_400_000, ENDED_RUNS = 3;
/** The states of a Run that has not settled: a TUI Run stays `pending_policy` for life, since its harness never acknowledges. */
export const OPEN_RUN_STATES: Readonly<Partial<Record<AgentRunV2["state"], true>>> = { pending_policy: true, active: true, policy_stale: true };

/** The name of Code's Agent for a workspace: deterministic, so every launch of the same sponsor finds the same Agent. */
export async function codeAgentName(containerId: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(containerId));
  return `Code ${Array.from(new Uint8Array(bytes).slice(0, 8), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}
/** Whether `name` is one of the generations of the Agent named `base`. */
function codeAgentGeneration(name: string, base: string): boolean {
  return name === base || (name.startsWith(`${base} `) && /^[2-9]$/.test(name.slice(base.length + 1)));
}
/** The Run's one scope rectangle: the container it launches into. Manifold hands OMP's hardened harness the V1 projection, which needs one. */
function agentScope(containerId: string): AuthorityScope {
  return [{ target: formatManifoldUri({ kind: "container", containerId }), reach: "subtree", caps: ["containers:read"] }];
}
function agentGrant(containerId: string, now: number) {
  return { scope: agentScope(containerId), maxRunLifetimeMs: AGENT_LEASE_MS, delegation: { maxDepth: 0, maxDescendants: 0 }, expiresAt: now + AGENT_GRANT_MS };
}
/** OMP's TUI harness profile of a composition: the durable dials alone, never a prompt, skills or automation. */
export function agentProfile(composition: Pick<ActionResult<"composeSession">, "accountPool" | "overlay" | "planYolo">): OmpHarnessProfile {
  if (composition.planYolo) throw new WorkflowError("omp_tui_plan_unsupported");
  return OmpHarnessProfileSchema.parse({ accountPool: composition.accountPool, overlay: composition.overlay, planYolo: false, tui: true });
}

/** The main agent's dials as `controlRun` answers them: a `provider/id` and a thinking selector, either unknown. */
export type Dials = { readonly model: string | null; readonly thinking: ThinkingSelector | null };
/**
 * The launch's main-agent selector, recorded on the Run as OMP spells it (`provider` and `id:thinking`):
 * `Run.model` is written once at creation, and only its sponsor's browser hears what `controlRun`
 * changes afterwards, so the launch value is what every other reader is left with.
 */
export function runModel(composition: Pick<ActionResult<"composeSession">, "overlay">): RunModel {
  const reference = composition.overlay.modelRoles?.default;
  const slash = reference?.indexOf("/") ?? -1;
  if (!reference || slash < 1) throw new WorkflowError("code_composition_changed");
  return { provider: reference.slice(0, slash), model: reference.slice(slash + 1) };
}
/** A Run's recorded model as dials: the `provider/id`, and the thinking a trailing `:selector` names. */
export function runDials(model: RunModel | undefined): Dials {
  if (!model) return { model: null, thinking: null };
  const reference = `${model.provider}/${model.model}`, colon = reference.lastIndexOf(":");
  const thinking = colon > 0 ? ThinkingSelectorSchema.safeParse(reference.slice(colon + 1)) : null;
  return thinking?.success ? { model: reference.slice(0, colon), thinking: thinking.data } : { model: reference, thinking: null };
}

/** Why a reviewed launch cannot be an Agent Run, or null when it can. */
export type AgentLaunchBlocker = "plans" | "options" | "harness" | "sponsor" | "agents";
/**
 * Whether an Agent Run can carry this launch. OMP's TUI harness refuses automatic plans
 * (`omp_tui_plan_unsupported`); `core.access.launchRun` hands the harness only its destination,
 * so optional skills and restricted automation cannot reach it; the destination must have OMP's
 * harness operation ready; and the caller must be able to sponsor an Agent (`canRegister`, null
 * while the Agents are unread). Any of them leaves the launch to OMP's ordinary reviewed terminal,
 * without a Run or live dials.
 */
export function agentLaunchBlocker(review: SessionReview, harnessReady: boolean, canSponsor: boolean | null): AgentLaunchBlocker | null {
  if (review.composition.planYolo) return "plans";
  if (review.native.skills.mode !== "preserve" || review.native.automation.mode === "restricted") return "options";
  if (!harnessReady) return "harness";
  if (canSponsor === null) return "agents";
  return canSponsor ? null : "sponsor";
}
/**
 * Whether a launch failed because this caller cannot sponsor Code's Agent here. Manifold refuses
 * that at registration or at Run creation, before any Run exists, so the reviewed session remains
 * the honest way to launch; `canRegister` alone cannot tell, since it holds for delegation anywhere.
 */
export function sponsorRefused(error: unknown): boolean {
  if (!(error instanceof WorkflowError)) return false;
  const denial = DOOR_DENIAL.exec(error.message);
  return denial !== null && /^core\.access\.(?:registerAgentV2|updateAgentV2|createRunV2):/.test(error.message) &&
    ["agent_registration_requires_human", "sponsor_authority_unavailable", "agent_sponsor_confined"].includes(denial[1]!);
}

/** A launched Run's terminal, for the caller to open with `host.authoring.createTerminal` within the minute Manifold binds it for. */
export type AgentLaunch = { readonly run: AgentRunV2; readonly launched: LaunchRunResult };
/** One of a workspace's Code Runs as the Sessions view reads it. */
export type CodeRun = {
  readonly run: ListRunsV2Result["runs"][number];
  /** Its Agent's lease, which its harness renews at half for the same length. */
  readonly leaseMs: number;
  /** What its inspection adds: renewals so far, when it settled, and the exit code its terminal or job reported; null when unread. */
  readonly inspection: { readonly renewals: number; readonly finishedAt: number | null; readonly exitCode: number | null } | null;
  /** The running terminal that carries its session; null when none does (not started, ended, or the inventory is unread). */
  readonly terminal: TerminalSummary | null;
};
/** The workspace's Code Runs at one observation, and whether the caller can sponsor a new one. */
export type CodeRuns = { readonly observedAt: number; readonly canSponsor: boolean; readonly runs: readonly CodeRun[] };

/**
 * The Runs worth listing: every open one, every expired one whose terminal still runs (detached: its
 * TUI outlived its lease), then the newest few that ended in the last day, never a Run cancelled
 * before it launched. Open ones first, each group newest first.
 */
export function listedRuns<T extends { readonly run: { readonly state: AgentRunV2["state"]; readonly createdAt: number; readonly session: unknown } }>(
  runs: readonly T[], running: (entry: T) => boolean, now: number): T[] {
  const newest = (left: T, right: T) => right.run.createdAt - left.run.createdAt;
  const open = runs.filter(entry => OPEN_RUN_STATES[entry.run.state] === true || (entry.run.state === "expired" && running(entry)));
  const ended = runs.filter(entry => !open.includes(entry) && entry.run.createdAt > now - ENDED_RUNS_MS &&
    !(entry.run.state === "cancelled" && entry.run.session === null)).sort(newest).slice(0, ENDED_RUNS);
  return [...open.sort(newest), ...ended];
}
function inspected(inspection: InspectRunV2Result): NonNullable<CodeRun["inspection"]> {
  const terminal = [...inspection.terminals].sort((left, right) => right.createdAt - left.createdAt)[0];
  const job = inspection.jobs.find(entry => entry.operationId === HARNESS_OPERATION_ID && entry.exitCode !== null);
  return { renewals: inspection.run.renewals, finishedAt: inspection.run.cleanup.finishedAt, exitCode: terminal?.exitCode ?? job?.exitCode ?? null };
}

/** One Code action through the ordinary caller transport: its result, or its refusal thrown in a person's words. */
export type CodeCall = <K extends CodeAction>(name: K, input: ActionInput<K>) => Promise<ActionResult<K>>;

/** Ordinary caller transport only. No server contexts, credentials, shell descriptors,
 * grants or React state are available to this browser/headless decision path. */
export function createCodeWorkflowClient(dispatch: Dispatch) {
  const codeClient = createCodeClient(dispatch);
  const ompClient = createOmpClient(dispatch);
  const code: CodeCall = async (name, input) => accepted(await codeClient.call(name, input));
  const omp = async <K extends OmpAction>(name: K, input: OmpInput<K>): Promise<OmpResult<K>> => accepted(await ompClient.call(name, input));
  async function native<K extends keyof typeof nativeActions>(name: K, input: z.infer<(typeof nativeActions)[K]["input"]>): Promise<z.infer<(typeof nativeActions)[K]["result"]>> {
    return nativeActions[name].result.parse(await dispatch(`engine.jobs.${name}`, nativeActions[name].input.parse(input))) as z.infer<(typeof nativeActions)[K]["result"]>;
  }
  // The bundled list the render-only preview is drawn from. Never a source of a saved profile.
  const readStarterCatalog = () => omp("readModelCatalog", { providers: ["anthropic", "deepseek", "openai-codex"] });
  async function readJob(node: JobNode) {
    if (!node.operationId.startsWith(`${OMP_PLUGIN_ID}.`)) throw new WorkflowError("omp_result_unavailable");
    const job = PublicJobSchema.parse(await dispatch("engine.jobs.status", { node }));
    if (job.machineId !== node.machineId || job.pluginId !== OMP_PLUGIN_ID || job.operationId !== node.operationId || job.jobId !== node.jobId)
      throw new WorkflowError("omp_result_unavailable");
    return job;
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
    const derived = await code("deriveCatalog", { inventory: inventory.inventory, benchmark: receipt.benchmark, budget });
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
   * A probe job followed to its end. Anything that ends the wait while the job is still active —
   * a stop before a wait or during one, or a status read that fails or answers malformed — cancels
   * the job through the native job owner, because a benchmark still running after its caller left
   * is still spending; a cancellation that fails is named in the error beside what stopped the
   * wait. The job and whatever it already answered stay in OMP's history either way.
   */
  async function settledJob(job: PublicJob, node: JobNode, run: VerificationRun): Promise<void> {
    if (job.jobId !== node.jobId || job.machineId !== node.machineId || job.operationId !== node.operationId || job.pluginId !== OMP_PLUGIN_ID)
      throw run.fail("omp_result_unavailable");
    let current = job;
    while (activeJobStates.includes(current.state)) {
      try {
        run.check();
        await run.wait(PROBE_POLL_MS);
        current = await run.call(() => readJob(node), false);
      } catch (stop) {
        try { await native("cancel", { node }); }
        catch (error) { throw run.fail(`${stop instanceof VerificationError ? stop.reason : "code_verification_changed"}; job ${job.jobId} was not cancelled: ${error instanceof Error ? error.message : "unknown"}`); }
        throw stop;
      }
    }
    if (current.state !== "exited" || current.result?.exitCode !== 0)
      throw run.fail(`job ${job.jobId} ${current.state}${current.result?.exitCode == null ? "" : ` with exit code ${current.result.exitCode}`}`);
  }
  // An empty filter selects no rows; the revision still covers OMP's whole unfiltered model catalog.
  const readCatalogRevision = async () => (await omp("readModelCatalog", { providers: [] })).revision;
  /** The world a charge was reviewed in, still: the same Code revision, the same exact account
   * pool, the same OMP defaults and the same OMP — the destination's inventory operation installed
   * from the artifact the inventory ran from, and the same bundled model catalog. Anything else
   * would spend or save against a different one. */
  async function unchangedCharge(charge: ChargeReview, run: VerificationRun) {
    const [defaults, pool, destination, catalogRevision] = await run.call(() => Promise.all([omp("readDefaults", {}),
      observePool(charge.target.containerId, charge.revision), omp("describeDestination", charge.target), readCatalogRevision()]));
    if (defaults.revision !== charge.defaultsRevision) throw run.fail("omp_defaults_changed");
    if (inventoryArtifact(destination) !== charge.inventoryArtifactSha256 || catalogRevision !== charge.catalogRevision) throw run.fail("code_omp_changed");
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
   * Every step re-observes before it acts and stops, naming itself, on a moved revision, pool,
   * OMP defaults or OMP, a refusal, a cancelled `signal` or a revoked `isCurrent`. A stop never undoes:
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
    // The model list OMP bundles now is the one the inventory picks its models from when it starts, so its revision is read
    // before the start: one republished while the inventory runs is then a moved OMP, refused before the charge is answered.
    const [defaults, pool, catalogRevision] = await run.call(() => Promise.all([omp("readDefaults", {}), observePool(target.containerId, revision),
      readCatalogRevision()]));
    // The start is checked by the job's own wait, so a stop that lands now cancels the job rather than abandoning it.
    const job = await run.call(() => omp("startInventory", { ...target, expectedDefaultsRevision: defaults.revision, accountPool: pool.accountPool }), false);
    evidence.inventoryJobId = job.jobId;
    await settledJob(job, { kind: "job", machineId: target.machineId, operationId: INVENTORY_OPERATION_ID, jobId: job.jobId }, run);
    // The verification records the OMP this inventory ran under: its job's artifact, and the model list read before it started.
    const { job: inventoryJob, inventory } = await run.call(() => omp("readInventory", { ...target, jobId: job.jobId }));
    run.enter("draft");
    const draft = await run.call(() => code("draftInventory", { inventory, budget: input.budget }));
    const requests = new Map<string, number>();
    for (const candidate of draft.benchmark.candidates) requests.set(candidate.provider, (requests.get(candidate.provider) ?? 0) + 1);
    const charge: ChargeReview = { target: { ...target }, revision, budget: input.budget, inventoryJobId: job.jobId, inventory,
      inventoryArtifactSha256: inventoryJob.artifactSha256, catalogRevision,
      candidates: draft.benchmark, providers: [...requests].sort(([left], [right]) => left < right ? -1 : 1).map(([provider, count]) => ({ provider, requests: count })),
      requests: draft.benchmark.candidates.length, exclusions: draft.exclusions,
      pool: { providers: pool.providers, poolIdentityDigest: pool.poolIdentityDigest }, defaultsRevision: defaults.revision, replacesDraft };
    // The charge is answered only for a world that still holds, so the operator never confirms a
    // spend against a pool, defaults or OMP that moved while the inventory ran.
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
    const derived = await run.call(() => code("deriveCatalog", { inventory: charge.inventory, benchmark, budget: charge.budget }));
    // Narrowed before anything is written, so a selection the verified catalog cannot serve stops
    // here with nothing staged, rather than after a promotion saved its default instead.
    let selection: Selection;
    try { selection = clampSelection(compileCatalog(derived.document), wanted); }
    catch (error) { throw run.fail(error instanceof Error ? error.message : "code_invalid_selection"); }
    run.enter("stage");
    const pool = await unchangedCharge(charge, run);
    const staged = await run.call(() => code("stageCatalog", { containerId: target.containerId, expectedRevision: charge.revision, document: derived.document,
      verification: { ompVersion: charge.inventory.ompVersion, inventoryArtifactSha256: charge.inventoryArtifactSha256, catalogRevision: charge.catalogRevision,
        inventoryObservedAt: charge.inventory.observedAt, benchmarkCompletedAt: benchmark.completedAt, accounts: pool.accounts,
        poolIdentityDigest: charge.pool.poolIdentityDigest } }));
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
  /**
   * A reviewed session's composition read again at the moment of an effect: the same Code digest
   * and the same OMP defaults revision, or the review no longer describes what would run.
   */
  async function reviewedComposition(review: SessionReview) {
    if (review.native.agentTools !== undefined || review.native.operationId !== LAUNCH_OPERATION_ID) throw new WorkflowError("omp_review_changed");
    const [composition, defaults] = await Promise.all([
      composeSession(review.destination, review.composition.revision, review.composition.prompt), omp("readDefaults", {}),
    ]);
    if (composition.compositionDigest !== review.composition.compositionDigest || defaults.revision !== review.native.defaultsRevision)
      throw new WorkflowError("code_composition_changed");
    return { composition, defaults };
  }
  /** One `core.access` door, its result parsed by Manifold's own schema; a refusal is thrown as the dispatch reports it. */
  async function access<T>(action: string, input: unknown, result: z.ZodType<T>): Promise<T> {
    return result.parse(await dispatch(`core.access.${action}`, input));
  }
  /**
   * Code's Agent for this sponsor and workspace, with this composition as its profile: registered
   * when absent, its profile and grant updated when they no longer match. Registration is
   * idempotent per sponsor and name, so a repeat finds the same Agent unchanged; a retired one
   * passes its name to the next generation, and a disabled one is the operator's to enable.
   */
  async function ensureAgent(target: Target, composition: ActionResult<"composeSession">): Promise<AgentV2> {
    const base = await codeAgentName(target.containerId);
    const context = { profile: agentProfile(composition) };
    for (let generation = 1; generation <= AGENT_GENERATIONS; generation++) {
      const now = Date.now(), grant = agentGrant(target.containerId, now);
      const registered = await access("registerAgentV2", {
        name: generation === 1 ? base : `${base} ${generation}`, harness: OMP_PLUGIN_ID, grant, context,
        purpose: `Code's workspace profile for container ${target.containerId}, launched as OMP's terminal UI with live dials.`,
      }, RegisterAgentV2ResultSchema);
      const agent = registered.agent;
      if (agent.state === "retired") continue;
      if (agent.state === "disabled") throw new WorkflowError("code_agent_disabled");
      if (agent.harness !== OMP_PLUGIN_ID) throw new WorkflowError("code_run_changed");
      if (registered.created) return agent;
      const profileChanged = canonicalJobJson(agent.context) !== canonicalJobJson(context);
      // An edited grant goes back to Code's, and one too short for a full Run window is renewed.
      const grantChanged = canonicalJobJson({ ...agent.grant, expiresAt: 0 }) !== canonicalJobJson({ ...grant, expiresAt: 0 }) ||
        agent.grant.expiresAt < now + AGENT_RUN_WINDOW_MS;
      if (!profileChanged && !grantChanged) return agent;
      return (await access("updateAgentV2", { agentId: agent.agentId, ...(profileChanged ? { context } : {}), ...(grantChanged ? { grant } : {}) },
        UpdateAgentV2ResultSchema)).agent;
    }
    throw new WorkflowError("code_agent_retired");
  }
  async function cancelRun(runId: string) {
    return (await access("finishAgentRunV2", { runId, outcome: "cancelled" }, FinishAgentRunV2ResultSchema)).run;
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
      const { composition, defaults } = await reviewedComposition(review);
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
    /**
     * LAUNCH AS AN AGENT RUN, the reviewed session's twin: read the composition again (same digest,
     * same OMP defaults), make Code's Agent carry it as its profile, create a Run for the destination
     * with its one scope rectangle and the launch's model, and have Manifold launch it through OMP's
     * TUI harness. What returns is the Run and the terminal runtime Manifold bound to this caller for
     * one minute, which the caller opens. A refusal or a mismatch once the Run exists cancels the Run
     * before it is thrown, so no unlaunched Run is left behind, and a cancellation that fails is named.
     */
    async launchAgent(review: SessionReview, isCurrent: () => boolean = () => true): Promise<AgentLaunch> {
      if (review.native.skills.mode !== "preserve" || review.native.automation.mode === "restricted") throw new WorkflowError("code_agent_options_unsupported");
      const { composition } = await reviewedComposition(review);
      const agent = await ensureAgent(review.destination, composition);
      const target = { machineId: review.destination.machineId, containerId: review.destination.containerId };
      if (!isCurrent()) throw new WorkflowError("code_destination_changed");
      const { run } = await access("createRunV2", { agentId: agent.agentId, target, reach: "subtree", lifetimeMs: agent.grant.maxRunLifetimeMs,
        scope: agentScope(target.containerId), model: runModel(composition) }, CreateRunV2ResultSchema);
      try {
        const launched = await access("launchRun", { runId: run.id, target }, LaunchRunResultSchema);
        const { runtime, session } = launched;
        if (launched.destination.machineId !== target.machineId || runtime.machineId !== target.machineId || runtime.pluginId !== OMP_PLUGIN_ID ||
          runtime.operationId !== HARNESS_OPERATION_ID || runtime.input.tui !== true || session.harness !== OMP_PLUGIN_ID || session.machineId !== target.machineId ||
          runtime.session?.harness !== session.harness || runtime.session.machineId !== session.machineId || runtime.session.sessionId !== session.sessionId)
          throw new WorkflowError("code_run_changed");
        if (!isCurrent()) throw new WorkflowError("code_destination_changed");
        return { run, launched };
      } catch (error) {
        try { await cancelRun(run.id); }
        catch (cancelError) {
          const words = (reason: unknown) => reason instanceof WorkflowError ? failureWords(reason.message) : "The Code action could not be completed.";
          throw new WorkflowError(`${words(error)} The run it created could not be cancelled (${words(cancelError)}); it ends with its lease.`);
        }
        throw error;
      }
    },
    /** Cancels a Run that never opened its terminal (`finishAgentRunV2`, outcome `cancelled`). A Run's TUI that already runs is not stopped by it. */
    cancelRun,
    /**
     * The workspace's Code Runs for the Sessions view: the caller's Code Agents for this workspace
     * (every generation), their Runs as Manifold lists them, the inspection of each listed Run for its
     * renewals and settlement, and the terminal inventory for the TUIs still running. It reads only;
     * Manifold's own visibility decides what appears. An inspection that fails leaves its Run unread.
     */
    async readRuns(containerId: string): Promise<CodeRuns> {
      const [base, listed, inventory] = await Promise.all([codeAgentName(containerId), access("listAgentsV2", {}, ListAgentsV2ResultSchema),
        dispatch("core.terminals.listAll", {}).then(value => TerminalsResponseSchema.parse(value).terminals)]);
      const agents = listed.agents.filter(agent => agent.harness === OMP_PLUGIN_ID && codeAgentGeneration(agent.name, base));
      const lists = await Promise.all(agents.map(agent => access("listRunsV2", { agentId: agent.agentId }, ListRunsV2ResultSchema)));
      const observedAt = lists.reduce((latest, list) => Math.max(latest, list.observedAt), 0) || Date.now();
      const entries = lists.flatMap((list, index) => list.runs.map(run => ({ run, leaseMs: agents[index]!.grant.maxRunLifetimeMs,
        terminal: run.session === null ? null : runningSessionTerminals(run.session, inventory)[0] ?? null })));
      const shown = listedRuns(entries, entry => entry.terminal !== null, observedAt);
      const inspections = await Promise.all(shown.map(entry => access("inspectRunV2", { runId: entry.run.id, limit: 1 }, InspectRunV2ResultSchema)
        .then(inspected, () => null)));
      return { observedAt, canSponsor: listed.canRegister, runs: shown.map((entry, index) => ({ ...entry, inspection: inspections[index] ?? null })) };
    },
    /** Turns a running TUI Run's main-agent dials (`atyrode.omp.controlRun`): the session's dials after the change, or its refusal thrown. */
    controlRun: (runId: string, change: Omit<OmpInput<"controlRun">, "runId">): Promise<RunDials> => omp("controlRun", { runId, ...change }),
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
