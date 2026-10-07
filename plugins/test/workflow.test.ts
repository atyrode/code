import { expect, test } from "bun:test";
import { actionDoor, actionSchemas as ompActionSchemas, BENCHMARK_OPERATION_ID, INVENTORY_OPERATION_ID, OMP_PLUGIN_ID, OMP_VERSION,
  type AccountsObservation, type BenchmarkInput, type InventoryReceipt, type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { createCodeWorkflowClient, VerificationError, type VerificationProgress } from "../code/workflow.ts";
import { PublicJobSchema, type PublicJob, type TerminalSummary } from "@manifold/protocol";
import { actionSchemas, type ActionResult, type Configuration } from "../code/contract.ts";
import { compileCatalog } from "../domain/catalog.ts";
import type { Selection } from "../domain/contracts.ts";
import { compileOmpOverlay, defaultSelection, reviewCatalog } from "../domain/routing.ts";
import { handlers } from "../code/server.ts";
import type { CodeContext } from "../code/context.ts";
import { z } from "zod";

const target = { containerId: "workspace", machineId: "destination" };
const unavailable = async (): Promise<never> => { throw new Error("Unexpected native operation"); };
const JobNodeInput = z.strictObject({ node: z.strictObject({ kind: z.literal("job"), machineId: z.string(), operationId: z.string(), jobId: z.string() }) });
/** The verification error a run stopped with; any other outcome fails the test. */
async function stopOf(run: Promise<unknown>): Promise<VerificationError> {
  const outcome = await run.then(() => null, (error: unknown) => error);
  if (!(outcome instanceof VerificationError)) throw new Error(`expected a verification stop, got ${String(outcome)}`);
  return outcome;
}

function probeJob(jobId: string, operationId: string, state: PublicJob["state"]): PublicJob {
  return PublicJobSchema.parse({ jobId, machineId: target.machineId, operationId, pluginId: OMP_PLUGIN_ID,
    installationRevision: "native-installation", artifactSha256: "c".repeat(64), inputDigest: "e".repeat(64),
    resourceBindingDigest: "d".repeat(64), state, nextInputSeq: null,
    result: state === "exited" ? { jobId, requestDigest: "f".repeat(64), ownerId: "owner", ownerGeneration: 1, state, exitCode: 0, reason: null,
      startedAt: 1, finishedAt: 2, usage: null, outputs: [], limits: { timeoutMs: 600_000, memoryBytes: 1 << 30, processes: 64, outputBytes: 1 << 20 } } : null,
    authority: { origin: { kind: "action", traceId: "trace-1", door: `${OMP_PLUGIN_ID}.startInventory` }, requester: "writer", executor: null, decision: null } });
}
function row(provider: string, id: string, input: number, context: number, levels: readonly ("low" | "medium" | "high" | "xhigh" | "max")[], images: boolean) {
  return { provider, id, api: provider === "anthropic" ? "anthropic-messages" : "openai-completions", inputCostPerMillion: input,
    outputCostPerMillion: input * 5, contextWindow: context, maxTokens: 64_000, reasoning: true, thinkingLevels: [...levels], images, quotaTier: null };
}
/**
 * Real Code doors over an in-memory container, and an OMP that answers inventory and benchmark
 * jobs from fixed facts. `states` scripts what `engine.jobs.status` answers for a job, and
 * `hooks` run when a door answers, which is where the world moves under a verification.
 */
function verificationFixture() {
  const store = new Map<string, string>(), calls: string[] = [], cancelled: string[] = [], benchmarked: BenchmarkInput[] = [];
  const hooks: Partial<Record<string, () => void | Promise<void>>> = {};
  const states = new Map<string, PublicJob["state"][]>();
  const exitCodes = new Map<string, number>();
  const verdicts: Record<string, "not_found" | "client_blocked"> = {};
  const ctx: CodeContext = {
    now: () => 10_000, emit() {}, outsideScope: async () => null,
    auth: { principal: { id: "writer", kind: "human", name: "Writer", color: "#123456" },
      caps: ["containers:read", "containers:write"], containerScope: null, isRoot: false,
      allows: async (cap, node) => node?.kind === "container" && node.containerId === target.containerId &&
        (cap === "containers:read" || cap === "containers:write") },
    storage: { pluginId: "atyrode.code", get: async key => store.get(key) ?? null,
      set: unavailable, delete: unavailable, keys: unavailable,
      compareAndSet: async (key, expected, value) => {
        if ((store.get(key) ?? null) !== expected) return false;
        store.set(key, value); return true;
      } },
    services: { describe: unavailable, read: unavailable, invoke: unavailable,
      readConfiguration: unavailable, configureConfiguration: unavailable,
      describeInstance: unavailable, readInstance: unavailable, listInstances: unavailable,
      readInstanceConfiguration: unavailable, configureInstance: unavailable, invokeInstance: unavailable },
    actions: { call: unavailable },
  };
  const scope = "shared-instance";
  const slot = (provider: string, credentialId: number): AccountsObservation["accounts"][number] => ({
    reference: { kind: "credential", scope, provider, credentialId }, credentialId, identityKey: null, type: "api_key", email: null, disabled: false, blocks: [] });
  const omp = {
    accounts: { scope, observedAt: 5_000, status: "fresh", accounts: [slot("anthropic", 1), slot("deepseek", 2)] } as AccountsObservation,
    defaults: { revision: 3, overlay: {}, updatedAt: null, updatedBy: null } as OmpResult<"readDefaults">,
    inventory: { schemaVersion: 1, kind: "inventory", ompVersion: OMP_VERSION, observedAt: 6_000, models: [
      row("anthropic", "claude-haiku-5", 1, 200_000, ["low", "medium", "high"], true),
      row("anthropic", "claude-sonnet-5", 3, 200_000, ["low", "medium", "high", "xhigh"], true),
      row("anthropic", "claude-opus-5", 5, 200_000, ["low", "medium", "high", "xhigh", "max"], true),
      row("deepseek", "deepseek-flash", 0.14, 128_000, ["low", "high"], false),
      row("deepseek", "deepseek-pro", 0.5, 128_000, ["low", "high", "max"], false),
      row("deepseek", "deepseek-vision-exp", 0.2, 128_000, ["low", "high"], true),
    ] } as InventoryReceipt,
  };
  let benchmarks = 0;
  const job = (jobId: string, operationId: string) => {
    const scripted = states.get(jobId);
    const state = scripted && scripted.length > 0 ? scripted.shift()! : "exited";
    const value = probeJob(jobId, operationId, state);
    const exitCode = exitCodes.get(jobId);
    return exitCode === undefined || value.result === null ? value : { ...value, result: { ...value.result, exitCode } };
  };
  async function answer(door: string, raw: unknown): Promise<unknown> {
    if (door === actionDoor("accounts")) return structuredClone(omp.accounts);
    if (door === actionDoor("readDefaults")) return omp.defaults;
    if (door === actionDoor("startInventory")) return job("inventory-1", INVENTORY_OPERATION_ID);
    if (door === actionDoor("readInventory")) return { job: probeJob("inventory-1", INVENTORY_OPERATION_ID, "exited"), inventory: omp.inventory };
    if (door === actionDoor("startBenchmark")) {
      benchmarked.push(ompActionSchemas.startBenchmark.input.parse(raw).candidates);
      return job(`benchmark-${++benchmarks}`, BENCHMARK_OPERATION_ID);
    }
    if (door === actionDoor("readBenchmark")) {
      const { jobId } = ompActionSchemas.readBenchmark.input.parse(raw);
      const candidates = benchmarked[Number(jobId.slice("benchmark-".length)) - 1]!.candidates;
      return { job: probeJob(jobId, BENCHMARK_OPERATION_ID, "exited"), benchmark: { schemaVersion: 1, kind: "benchmark", ompVersion: OMP_VERSION,
        inventoryObservedAt: omp.inventory.observedAt, startedAt: 7_000 + benchmarks, completedAt: 8_000 + benchmarks,
        results: candidates.map(candidate => verdicts[candidate.id]
          ? { ...candidate, status: verdicts[candidate.id], tokensPerSecond: null, timeToFirstTokenMs: null }
          : { ...candidate, status: "reachable", tokensPerSecond: 50, timeToFirstTokenMs: 300 }) } };
    }
    if (door === "engine.jobs.status") {
      const { node } = JobNodeInput.parse(raw);
      return job(node.jobId, node.operationId);
    }
    if (door === "engine.jobs.cancel") { cancelled.push(JobNodeInput.parse(raw).node.jobId); return { accepted: true }; }
    const name = door.startsWith("atyrode.code.") ? door.slice("atyrode.code.".length) as keyof typeof handlers : null;
    if (!name || !handlers[name]) throw new Error(`Unexpected owner/action: ${door}`);
    return handlers[name]!(ctx, raw);
  }
  const workflow = createCodeWorkflowClient(async (door, raw) => {
    calls.push(door);
    const result = await answer(door, raw);
    await hooks[door]?.();
    return result;
  });
  const configuration = async () => actionSchemas.readConfiguration.result.parse(await handlers.readConfiguration!(ctx, { containerId: target.containerId }));
  return { workflow, store, calls, cancelled, benchmarked, hooks, states, exitCodes, verdicts, omp, ctx, configuration, slot };
}
/** The operator's preview, made against a catalog with OpenAI and a fourth rung. */
const preview: Selection = { lane: { kind: "mixed" }, capability: 4, thinking: "high", advisor: "review", spark: true,
  priority: false, prewalk: true, planYolo: false, fallback: true, budget: "any" };
const effects = ["atyrode.code.initializeConfiguration", actionDoor("startInventory"), actionDoor("startBenchmark"),
  "atyrode.code.stageCatalog", "atyrode.code.promoteCatalog", "atyrode.code.select", "atyrode.code.changeAccounts", "engine.jobs.cancel"];

test("verification prepares a charge without spending, and one confirmation saves a verified catalog and the narrowed preview", async () => {
  const f = verificationFixture(), progress: VerificationProgress[] = [];
  const pending = await f.workflow.verifyModels(target, { expectedRevision: 0, budget: "any" }, { onProgress: value => progress.push(value) });
  expect(pending.charge).toMatchObject({ target, revision: 1, budget: "any", inventoryJobId: "inventory-1", requests: 5, replacesDraft: false,
    defaultsRevision: 3, providers: [{ provider: "anthropic", requests: 3 }, { provider: "deepseek", requests: 2 }],
    exclusions: [{ provider: "deepseek", id: "deepseek-vision-exp", reason: "unstable_id" }],
    pool: { providers: ["anthropic", "deepseek"] } });
  // Preparing initialized the workspace and ran OMP's inventory; no benchmark request was made.
  expect(f.calls.filter(door => effects.includes(door))).toEqual(["atyrode.code.initializeConfiguration", actionDoor("startInventory")]);
  expect((await f.configuration()).configuration).toMatchObject({ revision: 1, active: null, draft: null });
  const verified = await pending.confirm(preview, { onProgress: value => progress.push(value) });
  expect(f.calls.filter(door => effects.includes(door))).toEqual(["atyrode.code.initializeConfiguration", actionDoor("startInventory"),
    actionDoor("startBenchmark"), actionDoor("startBenchmark"), "atyrode.code.stageCatalog", "atyrode.code.promoteCatalog", "atyrode.code.select"]);
  // One job per provider, each probing only that provider's candidates.
  expect(f.benchmarked.map(input => [...new Set(input.candidates.map(candidate => candidate.provider))])).toEqual([["anthropic"], ["deepseek"]]);
  const saved = verified.configuration;
  expect((await f.configuration()).configuration).toEqual(saved);
  expect(saved.active?.provenance).toEqual({ ompVersion: OMP_VERSION, inventoryObservedAt: 6_000, benchmarkCompletedAt: 8_002,
    providers: ["anthropic", "deepseek"], poolIdentityDigest: pending.charge.pool.poolIdentityDigest });
  expect(saved.draft).toBeNull();
  // No OpenAI so no mixed lane, no fourth Anthropic rung and no Spark: those narrow to the catalog's
  // own default lane and highest capability; every other choice is the operator's.
  expect(saved.selection).toEqual({ ...preview, lane: { kind: "provider", family: "anthropic", blend: "only" }, capability: 3, spark: false });
  expect(verified.exclusions).toEqual([{ provider: "deepseek", id: "deepseek-vision-exp", reason: "unstable_id" }]);
  expect([...new Set(progress.map(value => value.step))]).toEqual(["observe", "initialize", "inventory", "draft", "benchmark", "derive", "stage", "review", "promote", "select"]);
  expect(progress.filter(value => value.step === "benchmark").map(value => value.providers.map(entry => `${entry.provider} ${entry.done}/${entry.total}`)))
    .toEqual([[], ["anthropic 0/3", "deepseek 0/2"], ["anthropic 3/3", "deepseek 0/2"], ["anthropic 3/3", "deepseek 2/2"]]);
  // A charge is spent once; a second confirmation never repeats it.
  await expect(pending.confirm(preview)).rejects.toThrow("code_verification_confirmed");
  expect(f.calls.filter(door => door === actionDoor("startBenchmark"))).toHaveLength(2);
});

test("a confirmation refuses to spend against a revision, pool or OMP defaults that moved since the charge", async () => {
  for (const move of ["revision", "pool", "defaults"] as const) {
    const f = verificationFixture();
    const pending = await f.workflow.verifyModels(target, { expectedRevision: 0, budget: "any" });
    if (move === "revision") await f.workflow.code("changeAccounts", { containerId: target.containerId, expectedRevision: 1,
      change: { kind: "create-preset", preset: { id: "other", name: "Other", disabled: [] } } });
    if (move === "pool") f.omp.accounts.accounts = [f.slot("anthropic", 1)];
    if (move === "defaults") f.omp.defaults = { ...f.omp.defaults, revision: 4 };
    const before = (await f.configuration()).configuration;
    const stopped = await stopOf(pending.confirm(preview));
    expect(stopped.step).toBe("benchmark");
    expect(stopped.reason).toContain({ revision: "code_stale_preferences", pool: "code_accounts_changed", defaults: "omp_defaults_changed" }[move]);
    expect(f.calls).not.toContain(actionDoor("startBenchmark"));
    expect((await f.configuration()).configuration).toEqual(before);
  }
  // Preparing from a revision the workspace has left spends nothing at all.
  const f = verificationFixture();
  await expect(f.workflow.verifyModels(target, { expectedRevision: 3, budget: "any" })).rejects.toThrow("observe: code_stale_preferences");
  expect(f.calls.filter(door => effects.includes(door))).toEqual([]);
});

test("a pool that moves while the benchmark runs is never recorded as the verified one", async () => {
  const f = verificationFixture();
  const pending = await f.workflow.verifyModels(target, { expectedRevision: 0, budget: "any" });
  f.hooks[actionDoor("readBenchmark")] = () => { f.omp.accounts.accounts = [f.slot("anthropic", 1), f.slot("deepseek", 2), f.slot("deepseek", 3)]; };
  const stopped = await stopOf(pending.confirm(preview));
  expect([stopped.step, stopped.reason]).toEqual(["stage", "code_accounts_changed"]);
  // The spent jobs are named for inspection; nothing was staged.
  expect(stopped.evidence).toEqual({ inventoryJobId: "inventory-1", benchmarkJobIds: ["benchmark-1", "benchmark-2"], revision: 1 });
  expect(f.calls).not.toContain("atyrode.code.stageCatalog");
});

test("a stop cancels the probe job in flight, and a failed one names its step and leaves its work inspectable", async () => {
  const cancelling = verificationFixture(), controller = new AbortController();
  cancelling.states.set("inventory-1", ["started", "started"]);
  cancelling.hooks[actionDoor("startInventory")] = () => { controller.abort(); };
  await expect(cancelling.workflow.verifyModels(target, { expectedRevision: 0, budget: "any" }, { signal: controller.signal }))
    .rejects.toThrow("inventory: code_verification_cancelled");
  expect(cancelling.cancelled).toEqual(["inventory-1"]);
  expect(cancelling.calls).not.toContain(actionDoor("readInventory"));
  // Revocation is a stop like cancellation: the running benchmark is cancelled, not abandoned.
  const revoked = verificationFixture();
  let current = true;
  const pending = await revoked.workflow.verifyModels(target, { expectedRevision: 0, budget: "any" }, { isCurrent: () => current });
  revoked.states.set("benchmark-1", ["started"]);
  revoked.hooks[actionDoor("startBenchmark")] = () => { current = false; };
  await expect(pending.confirm(preview)).rejects.toThrow("benchmark: code_verification_changed");
  expect(revoked.cancelled).toEqual(["benchmark-1"]);
  expect(revoked.benchmarked).toHaveLength(1);
  // A probe job that fails stops the run at its step, with the job named.
  const failing = verificationFixture();
  failing.exitCodes.set("benchmark-2", 1);
  const failed = await stopOf((await failing.workflow.verifyModels(target, { expectedRevision: 0, budget: "any" })).confirm(preview));
  expect([failed.step, failed.reason]).toEqual(["benchmark", "job benchmark-2 exited with exit code 1"]);
  expect(failed.evidence.benchmarkJobIds).toEqual(["benchmark-1", "benchmark-2"]);
  expect((await failing.configuration()).configuration).toMatchObject({ revision: 1, active: null, draft: null });
});

test("a status read that fails while a probe runs cancels the probe, and a cancellation that fails is named", async () => {
  const unread = verificationFixture();
  const pending = await unread.workflow.verifyModels(target, { expectedRevision: 0, budget: "any" });
  unread.states.set("benchmark-1", ["started"]);
  unread.hooks["engine.jobs.status"] = () => { throw new Error("engine_job_status_unavailable"); };
  const stopped = await stopOf(pending.confirm(preview));
  expect([stopped.step, stopped.reason]).toEqual(["benchmark", "engine_job_status_unavailable"]);
  expect(unread.cancelled).toEqual(["benchmark-1"]);
  // The cancellation is attempted even when it then fails, and the error keeps both what stopped the wait and that the job runs on.
  const stuck = verificationFixture();
  const again = await stuck.workflow.verifyModels(target, { expectedRevision: 0, budget: "any" });
  stuck.states.set("benchmark-1", ["started"]);
  stuck.hooks["engine.jobs.status"] = () => { throw new Error("engine_job_status_unavailable"); };
  stuck.hooks["engine.jobs.cancel"] = () => { throw new Error("timeout"); };
  const left = await stopOf(again.confirm(preview));
  expect(left.reason).toBe("engine_job_status_unavailable; job benchmark-1 was not cancelled: timeout");
  expect(stuck.cancelled).toEqual(["benchmark-1"]);
  expect(left.evidence.benchmarkJobIds).toEqual(["benchmark-1"]);
});

test("a derivation or selection the verified catalog cannot serve stops before anything is staged", async () => {
  const blocked = verificationFixture();
  blocked.verdicts["claude-sonnet-5"] = "not_found"; blocked.verdicts["claude-opus-5"] = "client_blocked";
  const refused = await stopOf((await blocked.workflow.verifyModels(target, { expectedRevision: 0, budget: "any" })).confirm(preview));
  expect([refused.step, refused.reason]).toEqual(["derive", "code_probe_insufficient_ladder"]);
  expect(blocked.calls).not.toContain("atyrode.code.stageCatalog");
  // A free preview against a catalog derived under `any` with nothing free: the budget is never widened.
  const paid = verificationFixture();
  const unsatisfiable = await stopOf((await paid.workflow.verifyModels(target, { expectedRevision: 0, budget: "any" })).confirm({ ...preview, budget: "free" }));
  expect([unsatisfiable.step, unsatisfiable.reason]).toEqual(["derive", "code_budget_unsatisfiable"]);
  expect(paid.calls).not.toContain("atyrode.code.stageCatalog");
});

test("a write that loses its race after staging stops at its step and keeps the verified draft for review", async () => {
  const f = verificationFixture();
  const pending = await f.workflow.verifyModels(target, { expectedRevision: 0, budget: "any" });
  f.hooks["atyrode.code.reviewCatalog"] = async () => {
    const current = (await f.configuration()).revision;
    await f.workflow.code("changeAccounts", { containerId: target.containerId, expectedRevision: current,
      change: { kind: "create-preset", preset: { id: "other", name: "Other", disabled: [] } } });
  };
  const stopped = await stopOf(pending.confirm(preview));
  expect([stopped.step, stopped.reason]).toEqual(["promote", "code_stale_preferences"]);
  const kept = (await f.configuration()).configuration!;
  expect(stopped.evidence.revision).toBe(2);
  expect(kept.active).toBeNull();
  expect(kept.draft?.provenance).toMatchObject({ providers: ["anthropic", "deepseek"], poolIdentityDigest: pending.charge.pool.poolIdentityDigest });
});

test("the verification observation names the pool a verification would record, and an empty one as none", async () => {
  const f = verificationFixture();
  const pending = await f.workflow.verifyModels(target, { expectedRevision: 0, budget: "any" });
  const record: Configuration = (await f.configuration()).configuration!;
  expect(await f.workflow.observeVerification(target.containerId, record.revision, record.accounts))
    .toEqual({ providers: ["anthropic", "deepseek"], poolIdentityDigest: pending.charge.pool.poolIdentityDigest });
  f.omp.accounts.accounts = [];
  expect(await f.workflow.observeVerification(target.containerId, record.revision, record.accounts)).toBeNull();
});

function sessionFixture() {
  const catalog = compileCatalog({ schemaVersion: 1, models: ([1, 2, 3] as const).map(tier => ({
    key: `model-${tier}`, provider: "anthropic", id: `model-${tier}`, api: "anthropic-messages", tier,
    quotaBucket: null, inputCostPerMillion: tier, outputCostPerMillion: tier * 3,
    tokensPerSecond: 30, timeToFirstTokenMs: 100, contextWindow: 200_000, thinkingLevels: ["medium"], images: true,
  })) });
  const selection = defaultSelection(catalog);
  const review = reviewCatalog(catalog, selection, 1000);
  const composition: ActionResult<"composeSession"> = { revision: 1, review,
    accountPool: { anthropic: [{ scope: "shared-instance", credentialId: 7, identityKey: "identity" }] },
    overlay: compileOmpOverlay(catalog, selection, review.routes), prompt: "Keep this exact task", planYolo: false, compositionDigest: "a".repeat(64) };
  const accounts: OmpResult<"accounts"> = { scope: "shared-instance", observedAt: 1000, status: "fresh", accounts: [{
    reference: { kind: "identity", scope: "shared-instance", provider: "anthropic", identityKey: "identity" },
    credentialId: 7, identityKey: "identity", type: "oauth", email: null, disabled: false, blocks: [],
  }] };
  const defaults: OmpResult<"readDefaults"> = { revision: 3, overlay: {}, updatedAt: null, updatedBy: null };
  const sessionId = "7ab82ad4-8c9e-4166-8130-472c7cae1559";
  const prepared: OmpResult<"prepareSession"> = { destination: target, reviewDigest: "b".repeat(64), runtime: {
    machineId: target.machineId,
    pluginId: "atyrode.omp", operationId: "atyrode.omp.launch", installationRevision: "native-installation",
    artifactSha256: "c".repeat(64), resourceBindingDigest: "d".repeat(64), input: { opaqueNativeInput: "preserved", sessionId },
    session: { harness: "atyrode.omp", machineId: target.machineId, sessionId },
  } };
  let preparations = 0;
  const resumeInputs: OmpInput<"resumeSession">[] = [];
  const resumed: OmpResult<"resumeSession"> = { machineId: target.machineId, sessionId,
    runtime: { ...prepared.runtime, pluginId: "atyrode.omp", operationId: "atyrode.omp.resume",
      session: { harness: "atyrode.omp", machineId: target.machineId, sessionId }, input: { sessionId } } };
  let refusal: string | null = null;
  const reviewOverride: Partial<OmpResult<"reviewSession">> = {};
  const terminals: TerminalSummary[] = [];
  const machines = [{ id: target.machineId, name: "Destination", online: true }];
  const workflow = createCodeWorkflowClient(async (door, raw) => {
    if (door === "core.machines.list") return { machines };
    if (door === "core.terminals.listAll") return { terminals };
    if (door === actionDoor("accounts")) return accounts;
    if (door === actionDoor("readDefaults")) return defaults;
    if (door === "atyrode.code.composeSession") return composition;
    if (door === actionDoor("reviewSession")) {
      const input = raw as OmpInput<"reviewSession">;
      return { destination: target, operationId: "atyrode.omp.launch", reviewDigest: prepared.reviewDigest,
        pins: { installationRevision: prepared.runtime.installationRevision, artifactSha256: prepared.runtime.artifactSha256, resourceBindingDigest: prepared.runtime.resourceBindingDigest },
        defaultsRevision: input.expectedDefaultsRevision, effectiveOverlay: input.overlay, accountPool: input.accountPool,
        automation: input.automation ?? { mode: "ordinary" },
        skills: { mode: input.skills?.mode === "disabled" ? "disabled" : "preserve", catalogRevision: null, selected: [] },
        ...reviewOverride } satisfies OmpResult<"reviewSession">;
    }
    if (door === actionDoor("prepareSession")) { preparations++; return refusal ? { refused: refusal } : prepared; }
    if (door === actionDoor("resumeSession")) { resumeInputs.push(raw as OmpInput<"resumeSession">); return refusal ? { refused: refusal } : resumed; }
    if (door === actionDoor("listSessions")) return [{ id: sessionId, title: "Saved work", cwd: "/workspace", updatedAt: 1000 }];
    throw new Error(`Unexpected owner/action: ${door}`);
  });
  return { workflow, composition, defaults, prepared, resumed, resumeInputs, sessionId, terminals, machines, reviewOverride, preparations: () => preparations, refuse: (reason: string) => { refusal = reason; } };
}

test("session composition changing at the same Code revision prevents native preparation", async () => {
  const fixture = sessionFixture();
  const review = await fixture.workflow.reviewSession(target, 1, fixture.composition.prompt);
  fixture.composition.compositionDigest = "e".repeat(64);
  await expect(fixture.workflow.prepareSession(review)).rejects.toThrow("code_composition_changed");
  expect(fixture.preparations()).toBe(0);
});

test("a defaults revision change invalidates a review even with an identical effective overlay", async () => {
  const fixture = sessionFixture();
  const review = await fixture.workflow.reviewSession(target, 1, fixture.composition.prompt);
  fixture.defaults.revision++;
  await expect(fixture.workflow.prepareSession(review)).rejects.toThrow("code_composition_changed");
  expect(fixture.preparations()).toBe(0);
});

test("ordinary session clients retain the native terminal descriptor without needing account-owner setup", async () => {
  const fixture = sessionFixture();
  const review = await fixture.workflow.reviewSession(target, 1, fixture.composition.prompt);
  expect(await fixture.workflow.prepareSession(review)).toEqual(fixture.prepared);
  fixture.refuse("omp_account_owner_unavailable");
  await expect(fixture.workflow.prepareSession(review)).rejects.toThrow("omp_account_owner_unavailable");
});

test("a native session response for a different destination cannot be placed", async () => {
  const fixture = sessionFixture();
  const review = await fixture.workflow.reviewSession(target, 1, fixture.composition.prompt);
  fixture.prepared.destination = { ...target, machineId: "different-machine" };
  await expect(fixture.workflow.prepareSession(review)).rejects.toThrow();
});

test("terminal preparation rejects operation, artifact, skill and session bindings not covered by its review", async () => {
  const mutations: ((runtime: OmpResult<"prepareSession">["runtime"]) => void)[] = [
    runtime => { runtime.pluginId = "another.plugin"; },
    runtime => { runtime.operationId = "atyrode.omp.resume"; },
    runtime => { runtime.installationRevision = "another-installation"; },
    runtime => { runtime.artifactSha256 = "e".repeat(64); },
    runtime => { runtime.resourceBindingDigest = "f".repeat(64); },
    runtime => { runtime.inputs = [{ name: "optionalSkill0", from: { jobId: "unreviewed-job", output: "skill" } }]; },
    runtime => { delete runtime.session; },
    runtime => { runtime.session!.harness = "another.plugin"; },
    runtime => { runtime.session!.sessionId = "fca82ad4-8c9e-4166-8130-472c7cae1559"; },
  ];
  for (const mutate of mutations) {
    const fixture = sessionFixture();
    const review = await fixture.workflow.reviewSession(target, 1, fixture.composition.prompt);
    mutate(fixture.prepared.runtime);
    await expect(fixture.workflow.prepareSession(review)).rejects.toThrow();
  }
});

test("a different operation or existing-Run selection cannot be substituted into an interactive launch review", async () => {
  const fixture = sessionFixture();
  const review = await fixture.workflow.reviewSession(target, 1, fixture.composition.prompt);
  review.native.operationId = "atyrode.omp.session";
  await expect(fixture.workflow.prepareSession(review)).rejects.toThrow("omp_review_changed");
  review.native.operationId = "atyrode.omp.launch";
  review.native.agentTools = { runId: "run-authorized" };
  await expect(fixture.workflow.prepareSession(review)).rejects.toThrow("omp_review_changed");
  expect(fixture.preparations()).toBe(0);
});

test("terminal review refuses an unsolicited existing-Run selection", async () => {
  const fixture = sessionFixture();
  fixture.reviewOverride.agentTools = { runId: "run-unrequested" };
  await expect(fixture.workflow.reviewSession(target, 1, fixture.composition.prompt)).rejects.toThrow("omp_review_changed");
  expect(fixture.preparations()).toBe(0);
});

test("saved-state resume omits replacement settings while explicit profile overrides the persisted selection", async () => {
  const f = sessionFixture();
  const ref = { harness: "atyrode.omp" as const, machineId: target.machineId, sessionId: f.sessionId };
  expect(await f.workflow.listSessions(target.machineId)).toEqual([{ id: f.sessionId, title: "Saved work", cwd: "/workspace", updatedAt: 1000 }]);
  expect(await f.workflow.resumeSession(ref)).toEqual({ kind: "prepared", prepared: f.resumed });
  expect(f.resumeInputs[0]).toEqual({ machineId: target.machineId, sessionId: f.sessionId });
  await f.workflow.resumeSession(ref, { profile: { target, expectedRevision: 1 }, skills: { mode: "disabled" },
    automation: { mode: "restricted", toolNames: ["read"], delegation: "disabled" } });
  expect(f.resumeInputs[1]).toEqual({ machineId: target.machineId, sessionId: f.sessionId, containerId: target.containerId,
    overlay: f.composition.overlay, accountPool: f.composition.accountPool,
    overrides: { model: f.composition.overlay.modelRoles!.default, thinking: f.composition.review.routes.find(route => route.role === "default")!.lead.thinking },
    skills: { mode: "disabled" }, automation: { mode: "restricted", toolNames: ["read"], delegation: "disabled" } });
});

test("resume rejects cross-machine profile or returned identity and preserves native refusal", async () => {
  const f = sessionFixture();
  const ref = { harness: "atyrode.omp" as const, machineId: target.machineId, sessionId: f.sessionId };
  await expect(f.workflow.resumeSession(ref, { profile: { target: { ...target, machineId: "another-machine" }, expectedRevision: 1 } })).rejects.toThrow("omp_session_binding_changed");
  expect(f.resumeInputs).toEqual([]);
  f.resumed.sessionId = "fca82ad4-8c9e-4166-8130-472c7cae1559";
  f.resumed.runtime.input.sessionId = f.resumed.sessionId;
  f.resumed.runtime.session!.sessionId = f.resumed.sessionId;
  await expect(f.workflow.resumeSession(ref)).rejects.toThrow("omp_session_binding_changed");
  f.refuse("omp_session_unavailable");
  await expect(f.workflow.resumeSession(ref)).rejects.toThrow("omp_session_unavailable");
});

test("explicit profile resume refuses Plan YOLO instead of silently changing policy", async () => {
  const fixture = sessionFixture();
  fixture.composition.planYolo = true;
  await expect(fixture.workflow.resumeSession(
    { harness: "atyrode.omp", machineId: target.machineId, sessionId: fixture.sessionId },
    { profile: { target, expectedRevision: 1 } },
  )).rejects.toThrow("omp_resume_plan_unsupported");
  expect(fixture.resumeInputs).toEqual([]);
});

test("resume cannot return a terminal for another plugin or operation", async () => {
  for (const field of ["pluginId", "operationId"] as const) {
    const fixture = sessionFixture();
    Object.assign(fixture.resumed.runtime, { [field]: "another.native-operation" });
    await expect(fixture.workflow.resumeSession(
      { harness: "atyrode.omp", machineId: target.machineId, sessionId: fixture.sessionId },
    )).rejects.toThrow();
  }
});

test("an exact running terminal reopens before unsupported profile-resume policy is considered", async () => {
  const fixture = sessionFixture();
  fixture.composition.planYolo = true;
  const ref = { harness: "atyrode.omp" as const, machineId: target.machineId, sessionId: fixture.sessionId };
  const terminal: TerminalSummary = { id: "already-running", machineId: target.machineId, name: "Saved work",
    createdAt: 1, status: "running", exitCode: null, homeId: "actual-home", unplaced: false, session: ref };
  fixture.terminals.push(terminal);
  expect(await fixture.workflow.resumeSession(ref, { profile: { target, expectedRevision: 1 } }))
    .toEqual({ kind: "reopen", terminals: [terminal] });
  expect(fixture.resumeInputs).toEqual([]);
});

test("fleet resume reopens only an exact running tuple and refuses offline destinations", async () => {
  const f = sessionFixture();
  const ref = { harness: "atyrode.omp" as const, machineId: target.machineId, sessionId: f.sessionId };
  const terminal: TerminalSummary = { id: "terminal", machineId: target.machineId, name: "Saved work", createdAt: 1,
    status: "running", exitCode: null, homeId: "actual-home", unplaced: false };
  f.terminals.push(terminal, { ...terminal, id: "other-machine", machineId: "other", session: { ...ref, machineId: "other" } },
    { ...terminal, id: "wrong-binding", machineId: "other", session: ref }, { ...terminal, id: "exited", status: "exited", session: ref });
  expect(await f.workflow.runningSession(ref)).toEqual([]);
  expect((await f.workflow.resumeSession(ref)).kind).toBe("prepared");
  expect(f.resumeInputs).toHaveLength(1);
  f.terminals.push({ ...terminal, id: "exact", session: ref });
  const reopened = await f.workflow.resumeSession(ref);
  expect(reopened).toEqual({ kind: "reopen", terminals: [{ ...terminal, id: "exact", session: ref }] });
  expect(f.resumeInputs).toHaveLength(1);
  f.machines[0]!.online = false;
  await expect(f.workflow.resumeSession(ref)).rejects.toThrow("offline or inaccessible");
  expect(f.resumeInputs).toHaveLength(1);
});

test("a stale destination guard refuses before native resume", async () => {
  const f = sessionFixture();
  const ref = { harness: "atyrode.omp" as const, machineId: target.machineId, sessionId: f.sessionId };
  let observations = 0;
  await expect(f.workflow.resumeSession(ref, {}, () => ++observations === 1)).rejects.toThrow("Destination or session choices changed");
  expect(f.resumeInputs).toEqual([]);
});

test("a ready shared broker never requires another deployment receipt", async () => {
  const workflow = createCodeWorkflowClient(async door => {
    if (door === actionDoor("readAccountSetup")) return { revision: "broker-revision", owner: { machineId: "account-owner", online: true },
      state: "ready", reason: null, brokerState: "ready", nativeReady: true, callerRefusal: null, canSignIn: true, canReview: true, deployment: null } satisfies OmpResult<"readAccountSetup">;
    if (door === actionDoor("accounts")) return { scope: "shared", observedAt: 1000, status: "fresh", accounts: [] } satisfies OmpResult<"accounts">;
    throw new Error(`A ready broker must not require ${door}`);
  });
  const input = { containerId: "workspace", machineId: null, intent: "accounts" as const, choices: ["accounts" as const], requestId: "request" };
  const plan = await workflow.permissionPlan(input);
  expect((await workflow.reviewPermissionStep(input, plan.scopeDigest, 0)).phase).toBe("step-ready");
  expect((await workflow.reviewPermissionStep(input, plan.scopeDigest, 1)).phase).toBe("ready");
});

test("ordinary session readiness does not require owner-only account or gateway setup", async () => {
  const workflow = createCodeWorkflowClient(async door => {
    if (door === actionDoor("readAccountSetup") || door === actionDoor("readGatewaySetup")) return { refused: "omp_service_owner_required" };
    if (door === actionDoor("accounts")) return { scope: "shared", observedAt: 1000, status: "fresh", accounts: [] } satisfies OmpResult<"accounts">;
    if (door === actionDoor("describeDestination")) return { ...target, pluginId: "atyrode.omp", state: "ready", reason: null, deployment: null,
      services: [{ serviceId: "omp", state: "ready", reason: null }],
      operations: [{ operationId: "atyrode.omp.launch", state: "ready", nativeReady: true, callerRefusal: null, reason: null,
        pins: { installationRevision: "native", artifactSha256: "a".repeat(64), resourceBindingDigest: "b".repeat(64) } }] } satisfies OmpResult<"describeDestination">;
    throw new Error(`Ordinary readiness must not require ${door}`);
  });
  const input = { ...target, intent: "session" as const, choices: null, requestId: "ordinary-client" };
  const plan = await workflow.permissionPlan(input);
  expect(plan.features.filter(feature => feature.selected).map(feature => feature.id)).toEqual(["session"]);
  expect((await workflow.reviewPermissionStep(input, plan.scopeDigest, 1)).phase).toBe("ready");
});
