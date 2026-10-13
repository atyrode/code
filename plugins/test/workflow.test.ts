import { expect, test } from "bun:test";
import { actionDoor, actionSchemas as ompActionSchemas, BENCHMARK_OPERATION_ID, INVENTORY_OPERATION_ID, OMP_PLUGIN_ID, OMP_VERSION,
  type AccountsObservation, type BenchmarkInput, type InventoryReceipt, type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { approvalCovers, createCodeWorkflowClient, inventoryArtifact, VerificationError, type VerificationOptions, type VerificationProgress } from "../code/workflow.ts";
import { verificationState } from "../code/generator/verification.ts";
import { PublicJobSchema, type PublicJob, type TerminalSummary } from "@manifold/protocol";
import { actionSchemas, type ActionResult, type Configuration } from "../code/contract.ts";
import { compileCatalog } from "../domain/catalog.ts";
import type { Selection } from "../domain/contracts.ts";
import { compileOmpOverlay, defaultSelection, reviewCatalog, routedModels, unpublishedModels } from "../domain/routing.ts";
import { handlers } from "../code/server.ts";
import type { CodeContext } from "../code/context.ts";
import { z } from "zod";

const target = { containerId: "workspace", machineId: "destination" };
/** Another workspace on the same destination, for checks kept across workspaces. */
const second = { containerId: "workspace-2", machineId: "destination" };
const unavailable = async (): Promise<never> => { throw new Error("Unexpected native operation"); };
const JobNodeInput = z.strictObject({ node: z.strictObject({ kind: z.literal("job"), machineId: z.string(), operationId: z.string(), jobId: z.string() }) });
/** The verification error a run stopped with; any other outcome fails the test. */
async function stopOf(run: Promise<unknown>): Promise<VerificationError> {
  const outcome = await run.then(() => null, (error: unknown) => error);
  if (!(outcome instanceof VerificationError)) throw new Error(`expected a verification stop, got ${String(outcome)}`);
  return outcome;
}
/** A prepared verification's charge, from the workspace's present revision; one that adopted a kept check instead fails the test. */
async function prepared(f: ReturnType<typeof verificationFixture>, expectedRevision: number, options: VerificationOptions = {}, at: typeof target = target) {
  const pending = await f.workflow.verifyModels(at, { expectedRevision, budget: "any", selection: null }, options);
  if (pending.kind !== "charge") throw new Error("expected a charge, not an adopted check");
  return pending;
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
 * jobs from fixed facts. Its runtime artifact (`omp.artifact`, which the inventory runs from and
 * the destination pins) and its bundled catalog belong to one OMP whose command line and model
 * list report different versions, as OMP 18.4.12's command line beside its 18.7.0 SDK's list once
 * did. `states` scripts what `engine.jobs.status` answers for a job, and
 * `hooks` run when a door answers, which is where the world moves under a verification.
 */
function verificationFixture() {
  const store = new Map<string, string>(), calls: string[] = [], cancelled: string[] = [], benchmarked: BenchmarkInput[] = [];
  const hooks: Partial<Record<string, () => void | Promise<void>>> = {};
  const states = new Map<string, PublicJob["state"][]>();
  const exitCodes = new Map<string, number>();
  const verdicts: Record<string, "not_found" | "client_blocked" | "unresolved" | "unmatched"> = {};
  // Who calls: a person with an unconfined token unless a test says otherwise, as a session would carry them. `ceiling` is a
  // credential confined by an authority ceiling: still unscoped, but refused at the workspace root.
  const caller = { principal: { id: "writer", kind: "human", name: "Writer", color: "#123456" } as CodeContext["auth"]["principal"],
    containerScope: null as string | null, ceiling: false };
  const ctx: CodeContext = {
    now: () => 10_000, emit() {}, outsideScope: async () => null,
    auth: { get principal() { return caller.principal; },
      caps: ["containers:read", "containers:write"], get containerScope() { return caller.containerScope; }, isRoot: false,
      allows: async (cap, node) => (cap === "containers:read" || cap === "containers:write") && (node === undefined
        ? caller.containerScope === null && !caller.ceiling
        : node.kind === "container" && (node.containerId === target.containerId || node.containerId === second.containerId)) },
    storage: { pluginId: "atyrode.code", get: async key => store.get(key) ?? null,
      set: unavailable, delete: async key => { store.delete(key); }, keys: async prefix => [...store.keys()].filter(key => key.startsWith(prefix ?? "")).sort(),
      compareAndSet: async (key, expected, value) => {
        // Plugin storage refuses a key outside this shape (plugin-kit `STORAGE_KEY_PATTERN`), so a write here does too.
        if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(key)) throw new Error(`invalid storage key: ${key}`);
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
    artifact: "c".repeat(64),
    catalog: { schemaVersion: 1, source: "bundled", ompVersion: "18.7.0", revision: "a".repeat(64), models: [] } as OmpResult<"readModelCatalog">,
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
    if (door === actionDoor("describeDestination")) return { ...target, pluginId: OMP_PLUGIN_ID, state: "ready", reason: null, deployment: null, services: [],
      operations: [INVENTORY_OPERATION_ID, BENCHMARK_OPERATION_ID].map(operationId => ({ operationId, state: "ready", reason: null, nativeReady: true, callerRefusal: null,
        pins: { installationRevision: "native-installation", artifactSha256: omp.artifact, resourceBindingDigest: "d".repeat(64) } })) } satisfies OmpResult<"describeDestination">;
    if (door === actionDoor("readModelCatalog")) return omp.catalog;
    if (door === actionDoor("startInventory")) return job("inventory-1", INVENTORY_OPERATION_ID);
    if (door === actionDoor("readInventory")) return { job: { ...probeJob("inventory-1", INVENTORY_OPERATION_ID, "exited"), artifactSha256: omp.artifact }, inventory: omp.inventory };
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
  const configuration = async (at: typeof target = target) => actionSchemas.readConfiguration.result.parse(await handlers.readConfiguration!(ctx, { containerId: at.containerId }));
  return { workflow, store, calls, cancelled, benchmarked, hooks, states, exitCodes, verdicts, omp, ctx, caller, configuration, slot };
}
/** The operator's preview, made against a catalog with OpenAI and a fourth rung. */
const preview: Selection = { lane: { kind: "mixed" }, capability: 4, thinking: "high", advisor: "review", spark: true,
  priority: false, prewalk: true, planYolo: false, fallback: true, budget: "any" };
const effects = ["atyrode.code.initializeConfiguration", actionDoor("startInventory"), actionDoor("startBenchmark"),
  "atyrode.code.stageCatalog", "atyrode.code.promoteCatalog", "atyrode.code.select", "atyrode.code.changeAccounts", "engine.jobs.cancel"];

test("verification prepares a charge without spending, and one confirmation saves a verified catalog and the narrowed preview", async () => {
  const f = verificationFixture(), progress: VerificationProgress[] = [];
  const pending = await prepared(f, 0, { onProgress: value => progress.push(value) });
  expect(pending.charge).toMatchObject({ target, revision: 1, budget: "any", inventoryJobId: "inventory-1", requests: 5, replacesDraft: false,
    defaultsRevision: 3, providers: [{ provider: "anthropic", requests: 3 }, { provider: "deepseek", requests: 2 }],
    exclusions: [{ provider: "deepseek", id: "deepseek-vision-exp", reason: "unstable_id" }],
    pool: { providers: ["anthropic", "deepseek"] }, inventoryArtifactSha256: "c".repeat(64), catalogRevision: "a".repeat(64) });
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
  expect(saved.active?.provenance).toEqual({ ompVersion: OMP_VERSION, inventoryArtifactSha256: "c".repeat(64), catalogRevision: "a".repeat(64),
    inventoryObservedAt: 6_000, benchmarkCompletedAt: 8_002, providers: ["anthropic", "deepseek"], poolIdentityDigest: pending.charge.pool.poolIdentityDigest });
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

test("a confirmation refuses to spend against a revision, pool, OMP defaults or OMP that moved since the charge", async () => {
  for (const move of ["revision", "pool", "defaults", "runtime", "catalog"] as const) {
    const f = verificationFixture();
    const pending = await prepared(f, 0);
    if (move === "revision") await f.workflow.code("changeAccounts", { containerId: target.containerId, expectedRevision: 1,
      change: { kind: "create-preset", preset: { id: "other", name: "Other", disabled: [] } } });
    if (move === "pool") f.omp.accounts.accounts = [f.slot("anthropic", 1)];
    if (move === "defaults") f.omp.defaults = { ...f.omp.defaults, revision: 4 };
    if (move === "runtime") f.omp.artifact = "9".repeat(64);
    if (move === "catalog") f.omp.catalog = { ...f.omp.catalog, revision: "b".repeat(64) };
    const before = (await f.configuration()).configuration;
    const stopped = await stopOf(pending.confirm(preview));
    expect(stopped.step).toBe("benchmark");
    expect(stopped.reason).toContain({ revision: "code_stale_preferences", pool: "code_accounts_changed", defaults: "omp_defaults_changed",
      runtime: "code_omp_changed", catalog: "code_omp_changed" }[move]);
    expect(f.calls).not.toContain(actionDoor("startBenchmark"));
    expect((await f.configuration()).configuration).toEqual(before);
  }
  // Preparing from a revision the workspace has left spends nothing at all.
  const f = verificationFixture();
  await expect(prepared(f, 3)).rejects.toThrow("observe: code_stale_preferences");
  expect(f.calls.filter(door => effects.includes(door))).toEqual([]);
});

test("a pool that moves while the benchmark runs is never recorded as the verified one", async () => {
  const f = verificationFixture();
  const pending = await prepared(f, 0);
  f.hooks[actionDoor("readBenchmark")] = () => { f.omp.accounts.accounts = [f.slot("anthropic", 1), f.slot("deepseek", 2), f.slot("deepseek", 3)]; };
  const stopped = await stopOf(pending.confirm(preview));
  expect([stopped.step, stopped.reason]).toEqual(["stage", "code_accounts_changed"]);
  // The spent jobs are named for inspection; nothing was staged.
  expect(stopped.evidence).toEqual({ inventoryJobId: "inventory-1", benchmarkJobIds: ["benchmark-1", "benchmark-2"], revision: 1 });
  expect(f.calls).not.toContain("atyrode.code.stageCatalog");
});

test("an OMP upgraded while the benchmark runs is never recorded as the one verified", async () => {
  const f = verificationFixture();
  const pending = await prepared(f, 0);
  f.hooks[actionDoor("readBenchmark")] = () => { f.omp.artifact = "9".repeat(64); };
  const stopped = await stopOf(pending.confirm(preview));
  expect([stopped.step, stopped.reason]).toEqual(["stage", "code_omp_changed"]);
  expect(f.calls).not.toContain("atyrode.code.stageCatalog");
});

test("a model list republished while the inventory runs stops the verification before its charge is answered", async () => {
  const f = verificationFixture();
  // OMP picked the inventory's models from the list it bundled when the inventory started; another list is published after.
  f.hooks[actionDoor("startInventory")] = () => { f.omp.catalog = { ...f.omp.catalog, revision: "b".repeat(64) }; };
  const stopped = await stopOf(prepared(f, 0));
  expect([stopped.step, stopped.reason]).toEqual(["draft", "code_omp_changed"]);
  expect(stopped.evidence).toEqual({ inventoryJobId: "inventory-1", benchmarkJobIds: [], revision: 1 });
  expect(f.calls).not.toContain(actionDoor("startBenchmark"));
  expect((await f.configuration()).configuration).toMatchObject({ revision: 1, active: null, draft: null });
});

test("a verification outlives an OMP update its routed models survive, and a model list that dropped one asks for another", async () => {
  const f = verificationFixture();
  // OMP publishes the models its inventory listed, as its bundled catalog does.
  f.omp.catalog = { ...f.omp.catalog, models: f.omp.inventory.models };
  const { configuration } = await (await prepared(f, 0)).confirm(preview);
  const catalog = compileCatalog(configuration.active!.document);
  const routed = routedModels(catalog, reviewCatalog(catalog, configuration.selection!, 0).routes);
  // What the workbench compares the saved verification with: the destination's pins, the bundled list's revision, what that
  // list publishes for the routed providers, and the pool.
  const present = async () => verificationState(configuration.active!.provenance, {
    inventoryArtifactSha256: inventoryArtifact(await f.workflow.omp("describeDestination", target)),
    catalogRevision: (await f.workflow.omp("readModelCatalog", { providers: [] })).revision,
    unpublished: unpublishedModels(routed, (await f.workflow.omp("readModelCatalog", { providers: [...new Set(routed.map(model => model.provider))] })).models),
    pool: await f.workflow.observeVerification(target.containerId, configuration.revision, configuration.accounts) ?? "none" }, false);
  // The command line answered the inventory as `OMP_VERSION` while the bundled list reports another version: one present OMP,
  // so a fresh verification is current.
  expect([configuration.active?.provenance?.ompVersion, f.omp.catalog.ompVersion]).toEqual([OMP_VERSION, "18.7.0"]);
  expect(await present()).toMatchObject({ status: "current" });
  // OMP upgraded on the machine, with the same accounts, model list and Code build: only the runtime artifact moved.
  f.omp.artifact = "9".repeat(64);
  expect(await present()).toMatchObject({ status: "current", changes: { runtimeChanged: true, catalogChanged: false, identitiesChanged: false } });
  // The model list republished under another revision that still lists every routed model.
  f.omp.catalog = { ...f.omp.catalog, revision: "b".repeat(64) };
  expect(await present()).toMatchObject({ status: "current", changes: { catalogChanged: true, unpublished: [] } });
  // Republished again without Claude Opus, which the saved team routes.
  f.omp.catalog = { ...f.omp.catalog, revision: "d".repeat(64), models: f.omp.catalog.models.filter(model => model.id !== "claude-opus-5") };
  expect(await present()).toMatchObject({ status: "unpublished", changes: { catalogChanged: true, unpublished: ["anthropic/claude-opus-5"] } });
});

test("a stop cancels the probe job in flight, and a failed one names its step and leaves its work inspectable", async () => {
  const cancelling = verificationFixture(), controller = new AbortController();
  cancelling.states.set("inventory-1", ["started", "started"]);
  cancelling.hooks[actionDoor("startInventory")] = () => { controller.abort(); };
  await expect(prepared(cancelling, 0, { signal: controller.signal }))
    .rejects.toThrow("inventory: code_verification_cancelled");
  expect(cancelling.cancelled).toEqual(["inventory-1"]);
  expect(cancelling.calls).not.toContain(actionDoor("readInventory"));
  // Revocation is a stop like cancellation: the running benchmark is cancelled, not abandoned.
  const revoked = verificationFixture();
  let current = true;
  const pending = await prepared(revoked, 0, { isCurrent: () => current });
  revoked.states.set("benchmark-1", ["started"]);
  revoked.hooks[actionDoor("startBenchmark")] = () => { current = false; };
  await expect(pending.confirm(preview)).rejects.toThrow("benchmark: code_verification_changed");
  expect(revoked.cancelled).toEqual(["benchmark-1"]);
  expect(revoked.benchmarked).toHaveLength(1);
  // A probe job that fails stops the run at its step, with the job named.
  const failing = verificationFixture();
  failing.exitCodes.set("benchmark-2", 1);
  const failed = await stopOf((await prepared(failing, 0)).confirm(preview));
  expect([failed.step, failed.reason]).toEqual(["benchmark", "job benchmark-2 exited with exit code 1"]);
  expect(failed.evidence.benchmarkJobIds).toEqual(["benchmark-1", "benchmark-2"]);
  expect((await failing.configuration()).configuration).toMatchObject({ revision: 1, active: null, draft: null });
});

test("a status read that fails while a probe runs cancels the probe, and a cancellation that fails is named", async () => {
  const unread = verificationFixture();
  const pending = await prepared(unread, 0);
  unread.states.set("benchmark-1", ["started"]);
  unread.hooks["engine.jobs.status"] = () => { throw new Error("engine_job_status_unavailable"); };
  const stopped = await stopOf(pending.confirm(preview));
  expect([stopped.step, stopped.reason]).toEqual(["benchmark", "engine_job_status_unavailable"]);
  expect(unread.cancelled).toEqual(["benchmark-1"]);
  // The cancellation is attempted even when it then fails, and the error keeps both what stopped the wait and that the job runs on.
  const stuck = verificationFixture();
  const again = await prepared(stuck, 0);
  stuck.states.set("benchmark-1", ["started"]);
  stuck.hooks["engine.jobs.status"] = () => { throw new Error("engine_job_status_unavailable"); };
  stuck.hooks["engine.jobs.cancel"] = () => { throw new Error("timeout"); };
  const left = await stopOf(again.confirm(preview));
  expect(left.reason).toBe("engine_job_status_unavailable; job benchmark-1 was not cancelled: timeout");
  expect(stuck.cancelled).toEqual(["benchmark-1"]);
  expect(left.evidence.benchmarkJobIds).toEqual(["benchmark-1"]);
});

test("a family Code requires that the accounts reach only in part is verified short, not refused", async () => {
  const short = verificationFixture();
  short.verdicts["claude-sonnet-5"] = "not_found"; short.verdicts["claude-opus-5"] = "client_blocked";
  const verified = await (await prepared(short, 0)).confirm(preview);
  expect(verified.configuration.active?.document.models.map(model => [model.tier, model.id]))
    .toEqual([[1, "claude-haiku-5"], [1, "deepseek-flash"], [2, "deepseek-pro"]]);
  expect(verified.exclusions).toEqual([{ provider: "anthropic", id: "claude-opus-5", reason: "client_blocked" },
    { provider: "anthropic", id: "claude-sonnet-5", reason: "not_found" }, { provider: "deepseek", id: "deepseek-vision-exp", reason: "unstable_id" }]);
  // Claude's tiers above its one rung route to that rung, so the preview keeps its highest three-tier capability.
  expect(verified.configuration.selection).toEqual({ ...preview, lane: { kind: "provider", family: "anthropic", blend: "only" }, capability: 3, spark: false });
});

test("a model with no clear answer is left out of a first list, but never shortens a list these accounts verified", async () => {
  // A first list: a provider that could not be checked at all is left out and named, and what answered is saved.
  const f = verificationFixture();
  f.verdicts["deepseek-flash"] = "unresolved"; f.verdicts["deepseek-pro"] = "unmatched";
  const first = await (await prepared(f, 0)).confirm(preview);
  expect(first.configuration.active?.document.models.map(model => model.id)).toEqual(["claude-haiku-5", "claude-sonnet-5", "claude-opus-5"]);
  expect(first.exclusions.filter(exclusion => exclusion.reason === "inconclusive").map(exclusion => exclusion.id)).toEqual(["deepseek-flash", "deepseek-pro"]);
  // Verifying again while a model of the list in use gives no clear answer stops before anything is staged; the list and team stay.
  f.verdicts["claude-opus-5"] = "unresolved";
  const before = await f.configuration();
  const again = await stopOf((await prepared(f, before.revision)).confirm(first.configuration.selection));
  expect([again.step, again.reason]).toEqual(["derive", "code_models_unanswered: anthropic/claude-opus-5"]);
  expect(await f.configuration()).toEqual(before);
  // Another pool's verification vouches for nothing these accounts could keep, so the same non-answer only leaves the model out.
  f.omp.accounts.accounts.push(f.slot("anthropic", 3));
  const otherPool = await (await prepared(f, before.revision)).confirm(first.configuration.selection);
  expect(otherPool.configuration.active?.document.models.map(model => model.id)).toEqual(["claude-haiku-5", "claude-sonnet-5"]);
});

test("a list in use that no verification made vouches for nothing either", async () => {
  // An imported list, put in use before any check of these accounts was kept.
  const f = verificationFixture();
  const initialized = await f.workflow.code("initializeConfiguration", { containerId: target.containerId, expectedRevision: 0 });
  const document = { schemaVersion: 1 as const, models: (["claude-haiku-5", "claude-sonnet-5", "claude-opus-5"] as const).map((id, index) => ({
    key: id, provider: "anthropic", id, api: "anthropic-messages", tier: (index + 1) as 1 | 2 | 3, quotaBucket: null, inputCostPerMillion: index + 1,
    outputCostPerMillion: (index + 1) * 5, tokensPerSecond: null, timeToFirstTokenMs: null, contextWindow: 200_000, thinkingLevels: ["low" as const, "high" as const], images: true })) };
  const staged = await f.workflow.code("stageCatalog", { containerId: target.containerId, expectedRevision: initialized.revision, document });
  const review = await f.workflow.code("reviewCatalog", { containerId: target.containerId, expectedRevision: staged.revision, source: "draft" });
  const imported = await f.workflow.code("promoteCatalog", { containerId: target.containerId, expectedRevision: staged.revision, source: "draft", reviewDigest: review.reviewDigest });
  expect(imported.active?.provenance).toBeNull();
  f.verdicts["claude-opus-5"] = "unresolved";
  const replaced = await (await prepared(f, imported.revision)).confirm(imported.selection);
  expect(replaced.configuration.active?.document.models.map(model => model.id)).toEqual(["claude-haiku-5", "claude-sonnet-5", "deepseek-flash", "deepseek-pro"]);
});

test("a first list stops rather than move the team off a family it chose that gave no clear answer at all", async () => {
  // The mixed lane names Claude: with no Claude model answering, saving would leave the team on another family.
  const mixed = verificationFixture();
  for (const id of ["claude-haiku-5", "claude-sonnet-5", "claude-opus-5"]) mixed.verdicts[id] = "unresolved";
  const blended = await stopOf((await prepared(mixed, 0)).confirm(preview));
  expect([blended.step, blended.reason]).toEqual(["derive", "code_models_unanswered: anthropic/claude-haiku-5, anthropic/claude-opus-5, anthropic/claude-sonnet-5"]);
  expect(mixed.calls).not.toContain("atyrode.code.stageCatalog");
  // A team that chose DeepSeek alone stops the same way when DeepSeek does not answer.
  const chosen = verificationFixture();
  chosen.verdicts["deepseek-flash"] = "unresolved"; chosen.verdicts["deepseek-pro"] = "unresolved";
  const deepseekOnly: Selection = { ...preview, lane: { kind: "provider", family: "deepseek", blend: "only" } };
  const refused = await stopOf((await prepared(chosen, 0)).confirm(deepseekOnly));
  expect([refused.step, refused.reason]).toEqual(["derive", "code_models_unanswered: deepseek/deepseek-flash, deepseek/deepseek-pro"]);
  expect(chosen.calls).not.toContain("atyrode.code.stageCatalog");
});

test("a derivation or selection the verified catalog cannot serve stops before anything is staged", async () => {
  // Nothing the accounts offer answers, so there is no catalog to stage.
  const blocked = verificationFixture();
  for (const id of ["claude-haiku-5", "claude-sonnet-5", "claude-opus-5", "deepseek-flash", "deepseek-pro"]) blocked.verdicts[id] = "not_found";
  const refused = await stopOf((await prepared(blocked, 0)).confirm(preview));
  expect([refused.step, refused.reason]).toEqual(["derive", "code_probe_insufficient_ladder"]);
  expect(blocked.calls).not.toContain("atyrode.code.stageCatalog");
  // A free preview against a catalog derived under `any` with nothing free: the budget is never widened.
  const paid = verificationFixture();
  const unsatisfiable = await stopOf((await prepared(paid, 0)).confirm({ ...preview, budget: "free" }));
  expect([unsatisfiable.step, unsatisfiable.reason]).toEqual(["derive", "code_budget_unsatisfiable"]);
  expect(paid.calls).not.toContain("atyrode.code.stageCatalog");
});

test("a write that loses its race after staging stops at its step and keeps the verified draft for review", async () => {
  const f = verificationFixture();
  const pending = await prepared(f, 0);
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
  const pending = await prepared(f, 0);
  const record: Configuration = (await f.configuration()).configuration!;
  expect(await f.workflow.observeVerification(target.containerId, record.revision, record.accounts))
    .toEqual({ providers: ["anthropic", "deepseek"], poolIdentityDigest: pending.charge.pool.poolIdentityDigest });
  f.omp.accounts.accounts = [];
  expect(await f.workflow.observeVerification(target.containerId, record.revision, record.accounts)).toBeNull();
});

test("a staged verification is kept as the person's own check of its pool and budget, which nobody else reads", async () => {
  const f = verificationFixture();
  expect(await f.workflow.readChecks()).toEqual({ keeps: true, revision: 0, approvedRequests: 0, approvedAt: null, checks: [] });
  const verified = await (await prepared(f, 0)).confirm(preview);
  expect((await f.workflow.readChecks()).checks).toEqual([{ poolIdentityDigest: verified.provenance.poolIdentityDigest, budget: "any",
    digest: verified.configuration.active!.digest, provenance: verified.provenance, recordedAt: 10_000,
    models: ["anthropic/claude-haiku-5", "anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "deepseek/deepseek-flash", "deepseek/deepseek-pro"] }]);
  // Another person, an agent or a service sees none of it.
  f.caller.principal = { id: "reader", kind: "human", name: "Reader", color: "#abcdef" };
  expect((await f.workflow.readChecks()).checks).toEqual([]);
  f.caller.principal = { id: "agent-1", kind: "agent", name: "Agent", color: "#654321" };
  expect((await f.workflow.readChecks()).checks).toEqual([]);
});

test("a workspace whose saved choices select a kept pool adopts the person's check without spending, narrowed to its profile", async () => {
  const f = verificationFixture();
  const first = await (await prepared(f, 0)).confirm(preview);
  const from = f.calls.length;
  const deepseekOnly: Selection = { ...preview, lane: { kind: "provider", family: "deepseek", blend: "only" } };
  const adopted = await f.workflow.verifyModels(second, { expectedRevision: 0, budget: "any", selection: deepseekOnly });
  expect(adopted.kind).toBe("adopted");
  // Initialized and adopted: no inventory, no benchmark, nothing staged.
  expect(f.calls.slice(from).filter(door => effects.includes(door) || door === "atyrode.code.adoptCheck"))
    .toEqual(["atyrode.code.initializeConfiguration", "atyrode.code.adoptCheck"]);
  const saved = (await f.configuration(second)).configuration!;
  expect(saved.active).toEqual(first.configuration.active);
  expect(saved.selection?.lane).toEqual(deepseekOnly.lane);
  // Holding the check now, that workspace checks for real when asked again.
  expect((await prepared(f, saved.revision, {}, second)).charge.requests).toBe(5);
});

test("adopting refuses another pool, a pool with no kept check, and a workspace already holding one no older", async () => {
  const f = verificationFixture();
  const first = await (await prepared(f, 0)).confirm(preview);
  const accounts = await f.workflow.omp("accounts", {});
  const initialized = await f.workflow.code("initializeConfiguration", { containerId: second.containerId, expectedRevision: 0 });
  const adopt = (containerId: string, expectedRevision: number, poolIdentityDigest = first.provenance.poolIdentityDigest, budget: Selection["budget"] = "any") =>
    handlers.adoptCheck!(f.ctx, { containerId, expectedRevision, accounts, poolIdentityDigest, budget, selection: null });
  // The pool the caller found a check for must be the one the saved choices select now.
  expect(await adopt(second.containerId, initialized.revision, "b".repeat(64))).toEqual({ refused: "code_accounts_changed" });
  // The workspace the check came from already holds it.
  expect(await adopt(target.containerId, first.configuration.revision)).toEqual({ refused: "code_check_current" });
  // A list derived under another budget is not the check of this one: a free list never replaces a paid one, or the reverse.
  expect(await adopt(second.containerId, initialized.revision, first.provenance.poolIdentityDigest, "free")).toEqual({ refused: "code_check_missing" });
  // A token confined to one container keeps no checks, so it adopts none either.
  f.caller.containerScope = second.containerId;
  expect(await adopt(second.containerId, initialized.revision)).toEqual({ refused: "code_check_missing" });
  f.caller.containerScope = null;
  // A kept list naming a provider these accounts do not include is never put in use, whatever key it is filed under.
  const key = [...f.store.keys()].find(entry => entry.startsWith("checks/"))!, original = f.store.get(key)!, stored = JSON.parse(original);
  f.store.set(key, JSON.stringify({ ...stored, document: { ...stored.document, models: [...stored.document.models,
    { ...stored.document.models[0], key: "elsewhere", provider: "openrouter", id: "elsewhere" }] } }));
  expect(await adopt(second.containerId, initialized.revision)).toEqual({ refused: "code_invalid_provenance" });
  f.store.set(key, original);
  // Another person keeps no check of this pool.
  f.caller.principal = { id: "reader", kind: "human", name: "Reader", color: "#abcdef" };
  expect(await adopt(second.containerId, initialized.revision)).toEqual({ refused: "code_check_missing" });
  expect((await f.configuration(second)).configuration).toEqual(initialized);
});

test("the standing approval is the caller's own, written at its exact revision, and bounds what checks spend without asking", async () => {
  const f = verificationFixture();
  expect(await f.workflow.approveChecks(0, 19)).toMatchObject({ revision: 1, approvedRequests: 19, approvedAt: 10_000 });
  await expect(f.workflow.approveChecks(0, 40)).rejects.toThrow("code_stale_preferences");
  expect((await f.workflow.approveChecks(1, 0)).approvedRequests).toBe(0);
  // Checks run without asking up to twice the approved charge, never with none approved, and never for nothing.
  expect([approvalCovers(19, 38), approvalCovers(19, 39), approvalCovers(0, 1), approvalCovers(19, 0)]).toEqual([true, false, false, false]);
  // A prepared charge carries the approval as read while preparing it.
  await f.workflow.approveChecks(2, 5);
  expect((await prepared(f, 0)).approvedRequests).toBe(5);
  // Another person's approval is theirs; an agent approves nothing.
  f.caller.principal = { id: "reader", kind: "human", name: "Reader", color: "#abcdef" };
  expect((await f.workflow.readChecks()).approvedRequests).toBe(0);
  f.caller.principal = { id: "agent-1", kind: "agent", name: "Agent", color: "#654321" };
  await expect(f.workflow.approveChecks(0, 19)).rejects.toThrow("code_person_required");
});

test("a check never drops a model the person's own check of the pool listed when it merely gave no clear answer", async () => {
  const f = verificationFixture();
  // The person's check of this pool lists Claude Opus.
  await (await prepared(f, 0)).confirm(preview);
  // In another workspace, someone else put a newer list of the same pool in use without Opus: theirs, not this person's check.
  f.caller.principal = { id: "reader", kind: "human", name: "Reader", color: "#abcdef" };
  f.verdicts["claude-opus-5"] = "not_found";
  const theirs = await (await prepared(f, 0, {}, second)).confirm(preview);
  expect(theirs.configuration.active?.document.models.map(model => model.id)).not.toContain("claude-opus-5");
  // Checking that workspace again, Opus gives no clear answer: the person's own check keeps it from being dropped.
  f.caller.principal = { id: "writer", kind: "human", name: "Writer", color: "#123456" };
  f.verdicts["claude-opus-5"] = "unresolved";
  const before = await f.configuration(second);
  const stopped = await stopOf((await prepared(f, before.revision, {}, second)).confirm(theirs.configuration.selection));
  expect([stopped.step, stopped.reason]).toEqual(["derive", "code_models_unanswered: anthropic/claude-opus-5"]);
  expect(await f.configuration(second)).toEqual(before);
});

test("a check survives its own run losing a race after it was staged, and the next run adopts it instead of spending", async () => {
  const f = verificationFixture();
  const pending = await prepared(f, 0);
  f.hooks["atyrode.code.reviewCatalog"] = async () => {
    const current = (await f.configuration()).revision;
    await f.workflow.code("changeAccounts", { containerId: target.containerId, expectedRevision: current,
      change: { kind: "create-preset", preset: { id: "other", name: "Other", disabled: [] } } });
  };
  expect((await stopOf(pending.confirm(preview))).step).toBe("promote");
  delete f.hooks["atyrode.code.reviewCatalog"];
  const benchmarks = f.benchmarked.length, now = await f.configuration();
  const again = await f.workflow.verifyModels(target, { expectedRevision: now.revision, budget: "any", selection: preview });
  expect(again.kind).toBe("adopted");
  expect(f.benchmarked).toHaveLength(benchmarks);
});

test("an adopt-only run writes and starts nothing unless the person keeps a check of the pool", async () => {
  const f = verificationFixture();
  // A workspace never set up is left alone: not even initialized.
  expect(await f.workflow.verifyModels(target, { expectedRevision: 0, budget: "any", selection: null, adoptOnly: true })).toEqual({ kind: "none" });
  expect(f.calls.filter(door => effects.includes(door))).toEqual([]);
  // A set-up workspace with no kept check of its pool starts no inventory.
  const initialized = await f.workflow.code("initializeConfiguration", { containerId: target.containerId, expectedRevision: 0 });
  expect(await f.workflow.verifyModels(target, { expectedRevision: initialized.revision, budget: "any", selection: null, adoptOnly: true })).toEqual({ kind: "none" });
  expect(f.calls).not.toContain(actionDoor("startInventory"));
  // With a check of the pool kept from another workspace, it adopts it.
  await (await prepared(f, 0, {}, second)).confirm(preview);
  expect((await f.workflow.verifyModels(target, { expectedRevision: initialized.revision, budget: "any", selection: null, adoptOnly: true })).kind).toBe("adopted");
});

test("stored checks and approvals are bound to their principal: a record naming anyone else is refused as corruption", async () => {
  const f = verificationFixture();
  await (await prepared(f, 0)).confirm(preview);
  await f.workflow.approveChecks(0, 19);
  for (const prefix of ["checks/", "approvals/"]) {
    const key = [...f.store.keys()].find(entry => entry.startsWith(prefix))!;
    const original = f.store.get(key)!;
    f.store.set(key, JSON.stringify({ ...JSON.parse(original), principalId: "reader" }));
    await expect(f.workflow.readChecks()).rejects.toThrow("code_invalid_configuration");
    f.store.set(key, original);
  }
  // A check filed under another pool's key is not that pool's check: read or adopted, it is refused as corruption.
  const key = [...f.store.keys()].find(entry => entry.startsWith("checks/"))!, original = f.store.get(key)!;
  const moved = key.replace(/[0-9a-f]{64}$/, "b".repeat(64));
  f.store.delete(key); f.store.set(moved, original);
  await expect(f.workflow.readChecks()).rejects.toThrow("code_invalid_configuration");
  f.store.delete(moved); f.store.set(key, original);
  // A token confined to one container, or by an authority ceiling, reads none of them and approves nothing.
  f.caller.containerScope = target.containerId;
  expect(await f.workflow.readChecks()).toEqual({ keeps: false, revision: 0, approvedRequests: 0, approvedAt: null, checks: [] });
  await expect(f.workflow.approveChecks(0, 5)).rejects.toThrow("code_checks_confined");
  f.caller.containerScope = null; f.caller.ceiling = true;
  expect(await f.workflow.readChecks()).toEqual({ keeps: false, revision: 0, approvedRequests: 0, approvedAt: null, checks: [] });
  await expect(f.workflow.approveChecks(1, 5)).rejects.toThrow("code_checks_confined");
});

test("the tutorial is seen once per person: recorded when first seen, kept as it was, and never another person's", async () => {
  const f = verificationFixture();
  expect(await f.workflow.readTutorial()).toEqual({ keeps: true, seenAt: null });
  expect(await f.workflow.seeTutorial()).toEqual({ keeps: true, seenAt: 10_000 });
  // A second mark, from another tab or device, leaves the first record as it was.
  const key = [...f.store.keys()].find(entry => entry.startsWith("tutorial/"))!;
  f.store.set(key, JSON.stringify({ ...JSON.parse(f.store.get(key)!), seenAt: 5_000 }));
  expect(await f.workflow.seeTutorial()).toEqual({ keeps: true, seenAt: 5_000 });
  // Another person has not seen it; an agent and a confined sign-in keep no record, so their browser keeps it instead.
  f.caller.principal = { id: "reader", kind: "human", name: "Reader", color: "#abcdef" };
  expect(await f.workflow.readTutorial()).toEqual({ keeps: true, seenAt: null });
  f.caller.principal = { id: "agent-1", kind: "agent", name: "Agent", color: "#654321" };
  expect(await f.workflow.seeTutorial()).toEqual({ keeps: false, seenAt: null });
  f.caller.principal = { id: "reader", kind: "human", name: "Reader", color: "#abcdef" };
  f.caller.containerScope = target.containerId;
  expect(await f.workflow.seeTutorial()).toEqual({ keeps: false, seenAt: null });
  f.caller.containerScope = null; f.caller.ceiling = true;
  expect(await f.workflow.seeTutorial()).toEqual({ keeps: false, seenAt: null });
  f.caller.ceiling = false;
  expect(await f.workflow.readTutorial()).toEqual({ keeps: true, seenAt: null });
  // A record filed under the reader's key that names another principal is corruption, never the reader's.
  await f.workflow.seeTutorial();
  const readers = [...f.store.keys()].find(entry => entry.startsWith("tutorial/") && entry !== key)!;
  f.store.set(readers, f.store.get(key)!);
  await expect(f.workflow.readTutorial()).rejects.toThrow("code_invalid_configuration");
});

test("a check derived under another budget is never adopted: the workspace checks for itself", async () => {
  const f = verificationFixture();
  await (await prepared(f, 0)).confirm(preview);
  const from = f.calls.length;
  // The fixture's models are all paid, so the free inventory's own draft refuses; what matters is that it ran instead of adopting.
  await f.workflow.verifyModels(second, { expectedRevision: 0, budget: "free", selection: null }).catch(() => null);
  expect(f.calls.slice(from)).toContain(actionDoor("startInventory"));
  expect(f.calls.slice(from)).not.toContain("atyrode.code.adoptCheck");
});

test("a charge spent without asking is spent only while the approval, read again, still covers it", async () => {
  const f = verificationFixture();
  await f.workflow.approveChecks(0, 5);
  const pending = await prepared(f, 0);
  // Withdrawn after the charge was answered: nothing is benchmarked.
  await f.workflow.approveChecks(1, 0);
  const stopped = await stopOf(pending.confirm(preview, { unasked: true }));
  expect([stopped.step, stopped.reason]).toEqual(["benchmark", "code_approval_withdrawn"]);
  expect(f.benchmarked).toEqual([]);
  // Still covered, it spends.
  await f.workflow.approveChecks(2, 5);
  const again = await prepared(f, (await f.configuration()).revision);
  expect((await again.confirm(preview, { unasked: true })).configuration.active?.provenance).not.toBeNull();
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
      // Sessions are the reviewed launch and OMP's TUI harness for agent runs, enabled together.
      operations: ["atyrode.omp.launch", "atyrode.omp.harness"].map(operationId => ({ operationId, state: "ready" as const, nativeReady: true, callerRefusal: null, reason: null,
        pins: { installationRevision: "native", artifactSha256: "a".repeat(64), resourceBindingDigest: "b".repeat(64) } })) } satisfies OmpResult<"describeDestination">;
    throw new Error(`Ordinary readiness must not require ${door}`);
  });
  const input = { ...target, intent: "session" as const, choices: null, requestId: "ordinary-client" };
  const plan = await workflow.permissionPlan(input);
  expect(plan.features.filter(feature => feature.selected).map(feature => feature.id)).toEqual(["session"]);
  expect((await workflow.reviewPermissionStep(input, plan.scopeDigest, 1)).phase).toBe("ready");
});
