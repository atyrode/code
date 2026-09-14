import { describe, expect, test } from "bun:test";
import { PublicJobSchema, type PublicJob } from "@manifold/protocol";
import { LAUNCH_OPERATION_ID, OMP_PLUGIN_ID, SessionInputSchema, actionDoor,
  type AccountsObservation, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { actionSchemas, sessionInput, type ActionInput, type ActionResult, type CodeAction,
  type Target } from "../atyrode.code/contract.ts";
import { CODE_PLUGIN_ID } from "../atyrode.code/contract.ts";
import { digestOf, type CodeContext } from "../atyrode.code/context.ts";
import { OmpReadSessionInputSchema, OmpRunSessionInputSchema, type SessionReceipt } from "../atyrode.code/omp-next.ts";
import { handlers } from "../atyrode.code/server.ts";
import type { CatalogDocument } from "../domain/contracts.ts";

const target: Target = { containerId: "container-a", machineId: "machine-a" };
const workspace = { containerId: target.containerId };
const now = Date.UTC(2026, 0, 1, 12);
const unavailable = async (): Promise<never> => { throw new Error("Unexpected native operation"); };
const reviewDigest = "b".repeat(64);
const accountsDoor = actionDoor("accounts");

function document(): CatalogDocument {
  return { schemaVersion: 1, models: ([1, 2, 3] as const).map(tier => ({
    key: `model-${tier}`, provider: "anthropic", id: `native-model-${tier}`, api: "anthropic-messages", tier,
    quotaBucket: null, inputCostPerMillion: tier, outputCostPerMillion: tier * 3,
    tokensPerSecond: 30, timeToFirstTokenMs: 100, contextWindow: 200_000,
    thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], images: true,
  })) };
}
function observation(): AccountsObservation {
  const scope = "explicit-caller-observation";
  return { scope, observedAt: now, status: "fresh", accounts: [
    { reference: { kind: "identity", scope, provider: "anthropic", identityKey: "email:alice@example.test|org:original" },
      credentialId: 1, identityKey: "email:alice@example.test|org:original", type: "oauth", email: null, disabled: false, blocks: [] },
  ] };
}
function job(jobId = "job-a"): PublicJob {
  return PublicJobSchema.parse({
    jobId, machineId: target.machineId, operationId: LAUNCH_OPERATION_ID, pluginId: OMP_PLUGIN_ID,
    installationRevision: "native-installation", artifactSha256: "c".repeat(64), inputDigest: "e".repeat(64),
    resourceBindingDigest: "d".repeat(64), state: "started", nextInputSeq: null, result: null,
    authority: { origin: { kind: "action", traceId: "trace-1", door: `${CODE_PLUGIN_ID}.runSession` },
      requester: "writer", executor: null, decision: null },
  });
}
function receipt(): SessionReceipt {
  return { sessionId: "01a0a008-88ed-7186-b28f-6356df68f8ed", model: "anthropic/native-model-3",
    sessionPath: "/home/job/omp-sessions/job-a/2026-09-14T13-08-29-037Z_01a0a008-88ed-7186-b28f-6356df68f8ed.jsonl",
    finalMessage: "The change is in place.", usage: { input: 91, output: 12, cacheRead: 0, cacheWrite: 0, cost: 0.004 }, exitCode: 0 };
}

interface Fixture {
  ctx: CodeContext;
  access: { readable: Set<string>; writable: Set<string>; containerScope: string | null };
  store: Map<string, string>;
  calls: string[];
  omp: {
    accounts: AccountsObservation; defaults: OmpResult<"readDefaults">; job: PublicJob; session: SessionReceipt;
    refuse: Map<string, string>; reject: Map<string, string>; during: Map<string, () => Promise<void>>;
    reviewed: unknown[]; posted: unknown[]; read: unknown[];
  };
}
function fixture(hub = true): Fixture {
  const store = new Map<string, string>();
  const access = { readable: new Set(["container-a", "container-b", "container-c"]),
    writable: new Set(["container-a", "container-b", "container-c"]), containerScope: null as string | null };
  const calls: string[] = [];
  const omp: Fixture["omp"] = { accounts: observation(),
    defaults: { revision: 3, overlay: {}, updatedAt: null, updatedBy: null }, job: job(), session: receipt(),
    refuse: new Map(), reject: new Map(), during: new Map(), reviewed: [], posted: [], read: [] };
  const call = async ({ plugin, action, input }: { plugin: string; action: string; input: unknown }): Promise<unknown> => {
    const door = `${plugin}.${action}`;
    calls.push(door);
    const rejection = omp.reject.get(door);
    if (rejection !== undefined) throw new Error(rejection);
    await omp.during.get(door)?.();
    const refused = omp.refuse.get(door);
    if (refused !== undefined) return { refused };
    // The fake parses every input against OMP's own published schema, so a door that composed
    // something OMP would reject fails here rather than in a claim about it.
    if (door === accountsDoor) return omp.accounts;
    if (door === actionDoor("readDefaults")) return omp.defaults;
    if (door === actionDoor("reviewSession")) {
      const value = SessionInputSchema.parse(input);
      omp.reviewed.push(value);
      return { destination: { containerId: value.containerId, machineId: value.machineId }, operationId: LAUNCH_OPERATION_ID,
        reviewDigest, pins: { installationRevision: "native-installation", artifactSha256: "c".repeat(64), resourceBindingDigest: "d".repeat(64) },
        defaultsRevision: value.expectedDefaultsRevision, effectiveOverlay: value.overlay,
        accountPool: value.accountPool } satisfies OmpResult<"reviewSession">;
    }
    if (door === `${OMP_PLUGIN_ID}.runSession`) {
      omp.posted.push(OmpRunSessionInputSchema.parse(input));
      return omp.job;
    }
    if (door === `${OMP_PLUGIN_ID}.readSession`) {
      omp.read.push(OmpReadSessionInputSchema.parse(input));
      return { job: omp.job, session: omp.session };
    }
    throw new Error(`unknown_action: ${CODE_PLUGIN_ID} -> ${door}`);
  };
  const ctx: CodeContext = {
    now: () => now,
    emit() {},
    outsideScope: async containerId => access.containerScope !== null && access.containerScope !== containerId ? { refused: "outside_scope" } : null,
    auth: {
      principal: { id: "writer", kind: "human", name: "Writer", color: "#123456" },
      caps: ["containers:read", "containers:write"], containerScope: null, isRoot: false,
      allows: async (cap, node) => node?.kind === "container" &&
        ((cap === "containers:read" && access.readable.has(node.containerId)) ||
          (cap === "containers:write" && access.writable.has(node.containerId))),
    },
    storage: {
      pluginId: CODE_PLUGIN_ID,
      get: async key => store.get(key) ?? null,
      set: unavailable, delete: unavailable,
      keys: async prefix => [...store.keys()].filter(key => key.startsWith(prefix ?? "")),
      compareAndSet: async (key, expected, value) => {
        if ((store.get(key) ?? null) !== expected) return false;
        store.set(key, value);
        return true;
      },
    },
    services: {
      describe: unavailable, read: unavailable, invoke: unavailable,
      readConfiguration: unavailable, configureConfiguration: unavailable,
      describeInstance: unavailable, readInstance: unavailable, listInstances: unavailable,
      readInstanceConfiguration: unavailable, configureInstance: unavailable, invokeInstance: unavailable,
    },
    ...(hub ? { actions: { call } } : {}),
  };
  return { ctx, access, store, calls, omp };
}
async function invoke<K extends CodeAction>(f: Fixture, name: K, input: ActionInput<K>): Promise<unknown> {
  return handlers[name]!(f.ctx, input);
}
async function accepted<K extends CodeAction>(f: Fixture, name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
  return actionSchemas[name].result.parse(await invoke(f, name, input)) as ActionResult<K>;
}
/** A workspace whose generator has been configured: a promoted catalog and a saved selection. */
async function configured(f: Fixture, containerId = target.containerId) {
  await accepted(f, "initializeConfiguration", { containerId, expectedRevision: 0 });
  const staged = await accepted(f, "stageCatalog", { containerId, expectedRevision: 1, document: document() });
  const review = await accepted(f, "reviewCatalog", { containerId, expectedRevision: staged.revision, source: "draft" });
  return accepted(f, "promoteCatalog", { containerId, expectedRevision: staged.revision, source: "draft", reviewDigest: review.reviewDigest });
}

describe("Code profiles a dependent plugin may offer", () => {
  test("only configured workspaces this principal reads are profiles, summarised as the dials show them", async () => {
    const f = fixture();
    const record = await configured(f);
    const other = await configured(f, "container-b");
    await accepted(f, "initializeConfiguration", { containerId: "container-c", expectedRevision: 0 });
    f.access.readable.delete("container-b");
    const listed = await accepted(f, "listProfiles", {});
    expect(listed.profiles).toEqual([{ containerId: target.containerId, revision: record.revision, machineId: null,
      selected: { model: "anthropic/native-model-2", thinking: record.selection!.thinking,
        capability: record.selection!.capability, advisor: record.selection!.advisor } }]);
    f.access.readable.add("container-b");
    expect((await accepted(f, "listProfiles", {})).profiles.map(profile => profile.containerId))
      .toEqual([target.containerId, other.containerId]);
    f.access.containerScope = target.containerId;
    expect((await accepted(f, "listProfiles", {})).profiles.map(profile => profile.containerId)).toEqual([target.containerId]);
  });

  test("a selection its catalog no longer supports is listed without a model rather than as one", async () => {
    const f = fixture();
    const record = await configured(f);
    const narrowed = document();
    narrowed.models = [{ ...narrowed.models[0]!, thinkingLevels: ["minimal"] }];
    f.store.set(`configuration/${digestOf(workspace)}`, JSON.stringify({ ...record,
      active: { document: narrowed, digest: digestOf(narrowed) } }));
    expect((await accepted(f, "listProfiles", {})).profiles).toEqual([
      { containerId: target.containerId, revision: record.revision, machineId: null, selected: null },
    ]);
  });
});

describe("the session a dependent plugin posts through Code", () => {
  test("the posted input is composeSession's own composition, reviewed at OMP before the job", async () => {
    const f = fixture();
    const record = await configured(f);
    const composition = await accepted(f, "composeSession", { ...workspace, expectedRevision: record.revision,
      accounts: observation(), prompt: "Implement the change" });
    const posted = await accepted(f, "runSession", { ...target, expectedRevision: record.revision, prompt: "Implement the change" });
    expect(posted).toEqual(f.omp.job);
    expect(f.calls).toEqual([accountsDoor, actionDoor("readDefaults"), actionDoor("reviewSession"),
      accountsDoor, actionDoor("readDefaults"), `${OMP_PLUGIN_ID}.runSession`]);
    expect(f.omp.posted).toEqual([{ ...sessionInput(target, composition, f.omp.defaults.revision), reviewDigest }]);
    expect(f.omp.reviewed).toEqual([sessionInput(target, composition, f.omp.defaults.revision)]);
    const provenance: unknown = JSON.parse(f.store.get(`sessions/${digestOf(workspace)}/${f.omp.job.jobId}`)!);
    expect(provenance).toEqual({ door: "runSession", containerId: target.containerId, machineId: target.machineId,
      jobId: f.omp.job.jobId, operationId: LAUNCH_OPERATION_ID, revision: record.revision,
      compositionDigest: composition.compositionDigest, reviewDigest, defaultsRevision: f.omp.defaults.revision,
      requester: "writer", postedAt: now });
    expect((await accepted(f, "listProfiles", {})).profiles[0]?.machineId).toBe(target.machineId);
  });

  test("a stale revision, an empty prompt, and choices or defaults that move mid-post never reach OMP's job door", async () => {
    const f = fixture();
    const record = await configured(f);
    const input = { ...target, expectedRevision: record.revision, prompt: "Implement the change" };
    expect(await invoke(f, "runSession", { ...input, expectedRevision: record.revision + 1 })).toEqual({ refused: "code_stale_preferences" });
    expect(await invoke(f, "runSession", { ...input, prompt: "" })).toEqual({ refused: "code_invalid_request" });
    f.omp.during.set(actionDoor("reviewSession"), async () => {
      await accepted(f, "select", { ...workspace, expectedRevision: record.revision,
        selection: { ...record.selection!, planYolo: !record.selection!.planYolo } });
    });
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_stale_preferences" });
    f.omp.during.clear();
    const current = await accepted(f, "readConfiguration", workspace);
    f.omp.during.set(actionDoor("reviewSession"), async () => { f.omp.defaults = { ...f.omp.defaults, revision: 4 }; });
    expect(await invoke(f, "runSession", { ...input, expectedRevision: current.revision })).toEqual({ refused: "code_composition_changed" });
    expect(f.omp.posted).toEqual([]);
  });

  test("a review OMP no longer stands behind, and a job it re-identified, are never vouched for", async () => {
    const f = fixture();
    const record = await configured(f);
    const input = { ...target, expectedRevision: record.revision, prompt: "Implement the change" };
    f.omp.refuse.set(actionDoor("reviewSession"), "omp_review_changed");
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_omp_review_changed" });
    f.omp.refuse.clear();
    f.omp.job = { ...job(), machineId: "machine-b" };
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_omp_review_changed" });
    expect(f.store.has(`sessions/${digestOf(workspace)}/${f.omp.job.jobId}`)).toBe(false);
    f.omp.job = job();
    f.store.set(`sessions/${digestOf(workspace)}/${f.omp.job.jobId}`, "retained by an earlier run");
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_session_conflict" });
  });

  test("a hub without manifold#575 refuses by age, and a refused edge keeps the plugin that refused", async () => {
    const f = fixture(false);
    const record = await configured(f);
    const input = { ...target, expectedRevision: record.revision, prompt: "Implement the change" };
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_hub_too_old" });
    expect(await invoke(f, "readSession", { ...workspace, jobId: "job-a" })).toEqual({ refused: "code_session_unknown" });
    const live = fixture();
    const saved = await configured(live);
    live.omp.reject.set(accountsDoor, `dependency_unavailable: ${CODE_PLUGIN_ID} -> atyrode.omp.accounts`);
    expect(await invoke(live, "runSession", { ...input, expectedRevision: saved.revision }))
      .toEqual({ refused: "code_omp_accounts_dependency_unavailable" });
    live.omp.reject.set(accountsDoor, "the host said nothing a caller can act on");
    expect(await invoke(live, "runSession", { ...input, expectedRevision: saved.revision }))
      .toEqual({ refused: "code_omp_accounts_refused" });
  });
});

describe("reading back a session Code posted", () => {
  test("OMP's receipt passes through unchanged for the job Code retained, and for no other", async () => {
    const f = fixture();
    const record = await configured(f);
    await configured(f, "container-b");
    await accepted(f, "runSession", { ...target, expectedRevision: record.revision, prompt: "Implement the change" });
    expect(await accepted(f, "readSession", { ...workspace, jobId: f.omp.job.jobId })).toEqual({ job: f.omp.job, session: receipt() });
    expect(f.omp.read).toEqual([{ ...target, jobId: f.omp.job.jobId }]);
    expect(await invoke(f, "readSession", { ...workspace, jobId: "job-nobody-posted" })).toEqual({ refused: "code_session_unknown" });
    expect(await invoke(f, "readSession", { containerId: "container-b", jobId: f.omp.job.jobId })).toEqual({ refused: "code_session_unknown" });
    f.access.readable.delete(target.containerId);
    expect(await invoke(f, "readSession", { ...workspace, jobId: f.omp.job.jobId })).toEqual({ refused: "code_scope_refused" });
    f.access.readable.add(target.containerId);
    f.omp.job = job("job-another-door-placed");
    expect(await invoke(f, "readSession", { ...workspace, jobId: "job-a" })).toEqual({ refused: "code_omp_review_changed" });
  });
});
