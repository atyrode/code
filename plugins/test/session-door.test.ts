import { describe, expect, test } from "bun:test";
import { PublicJobSchema, type PublicJob } from "@manifold/protocol";
import { LAUNCH_OPERATION_ID, OMP_PLUGIN_ID, PROMPT_MAX_BYTES, SESSION_GUEST_PATH,
  SESSION_OPERATION_ID, MATERIAL_SESSION_OPERATION_ID, SessionInputSchema, SessionSilenceSchema, actionDoor, actionSchemas as ompActionSchemas,
  type AccountsObservation, type ActionInput as OmpInput, type ActionResult as OmpResult,
  type JobInputBinding, type SessionReceipt, type SessionSilence } from "@atyrode/manifold-omp";
import { actionSchemas, CODE_PLUGIN_ID, type ActionInput, type ActionResult,
  type CodeAction, type Target } from "../code/contract.ts";
import { digestOf, type CodeContext } from "../code/context.ts";
import { handlers } from "../code/server.ts";
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
  const alice = "email:alice@example.test|org:original";
  const bob = "email:bob@example.test|org:original";
  return { scope, observedAt: now, status: "fresh", accounts: [
    { reference: { kind: "identity", scope, provider: "anthropic", identityKey: alice },
      credentialId: 1, identityKey: alice, type: "oauth", email: "alice@example.test", disabled: false, blocks: [] },
    { reference: { kind: "credential", scope, provider: "anthropic", credentialId: 2 },
      credentialId: 2, identityKey: null, type: "api_key", email: null, disabled: false, blocks: [] },
    { reference: { kind: "identity", scope, provider: "anthropic", identityKey: bob },
      credentialId: 3, identityKey: bob, type: "oauth", email: "bob@example.test", disabled: false, blocks: [] },
  ] };
}
/** Every account the observation names, as `listProfiles` reports them. */
const everyAccount = [
  { provider: "anthropic", identityKey: "email:alice@example.test|org:original", label: "alice@example.test" },
  { provider: "anthropic", identityKey: null },
  { provider: "anthropic", identityKey: "email:bob@example.test|org:original", label: "bob@example.test" },
];
function job(jobId = "job-a"): PublicJob {
  return PublicJobSchema.parse({
    jobId, machineId: target.machineId, operationId: SESSION_OPERATION_ID, pluginId: OMP_PLUGIN_ID,
    installationRevision: "native-installation", artifactSha256: "c".repeat(64), inputDigest: "e".repeat(64),
    resourceBindingDigest: "d".repeat(64), state: "started", nextInputSeq: null, result: null,
    authority: { origin: { kind: "action", traceId: "trace-1", door: `${CODE_PLUGIN_ID}.runSession` },
      requester: "writer", executor: null, decision: null },
  });
}
function receipt(): SessionReceipt {
  return { sessionId: "01a0a008-88ed-7186-b28f-6356df68f8ed", model: "anthropic/native-model-3",
    // What the overlay asked for, which OMP now reports beside what served (manifold-omp#50).
    // Equal here: a substitution is that repository's contract to refuse, not this one's to model.
    configuredModel: "anthropic/native-model-3",
    sessionPath: `${SESSION_GUEST_PATH}/2026-09-14T13-08-29-037Z_01a0a008-88ed-7186-b28f-6356df68f8ed.jsonl`,
    finalMessage: "The change is in place.", usage: { input: 91, output: 12, cacheRead: 0, cacheWrite: 0, cost: 0.004 },
    exitCode: 0, failure: null };
}

interface Fixture {
  ctx: CodeContext;
  access: { readable: Set<string>; writable: Set<string>; containerScope: string | null };
  store: Map<string, string>;
  calls: string[];
  omp: {
    accounts: AccountsObservation; defaults: OmpResult<"readDefaults">; job: PublicJob; session: SessionReceipt | null;
    /** The word OMP answers beside an absent receipt; exactly one of the two is ever null. */
    silence: SessionSilence | null;
    echo: "asked" | JobInputBinding[];
    skills: OmpResult<"reviewSession">["skills"] | null;
    dropReviewLimits: boolean;
    dropReviewIsolation: boolean;
    reviewOperation: OmpResult<"reviewSession">["operationId"] | null;
    refuse: Map<string, string>; reject: Map<string, string>; during: Map<string, () => Promise<void>>;
    reviewed: unknown[]; posted: OmpInput<"runSession">[]; read: unknown[]; cancelled: unknown[];
  };
}
function fixture(): Fixture {
  const store = new Map<string, string>();
  const access = { readable: new Set(["container-a", "container-b", "container-c"]),
    writable: new Set(["container-a", "container-b", "container-c"]), containerScope: null as string | null };
  const calls: string[] = [];
  const omp: Fixture["omp"] = { accounts: observation(),
    defaults: { revision: 3, overlay: {}, updatedAt: null, updatedBy: null }, job: job(), session: receipt(),
    silence: null, skills: null, dropReviewLimits: false, dropReviewIsolation: false, reviewOperation: null,
    echo: "asked", refuse: new Map(), reject: new Map(), during: new Map(),
    reviewed: [], posted: [], read: [], cancelled: [] };
  const call = async ({ plugin, action, input }: { plugin: string; action: string; input: unknown }): Promise<unknown> => {
    const door = `${plugin}.${action}`;
    calls.push(door);
    const rejection = omp.reject.get(door);
    if (rejection !== undefined) throw new Error(rejection);
    await omp.during.get(door)?.();
    const refused = omp.refuse.get(door);
    // manifold#576's own shape: a callee handler's `{ refused }` is settled as the `refused`
    // class and thrown at the edge, never answered to the caller as a value.
    if (refused !== undefined) throw new Error(`refused: ${CODE_PLUGIN_ID} -> ${door} (${refused})`);
    // The fake parses every input against OMP's own published schema, so a door that composed
    // something OMP would reject fails here rather than in a claim about it.
    if (door === accountsDoor) return omp.accounts;
    if (door === actionDoor("readDefaults")) return omp.defaults;
    if (door === actionDoor("reviewSession")) {
      const value = SessionInputSchema.parse(input);
      omp.reviewed.push(value);
      return { destination: { containerId: value.containerId, machineId: value.machineId },
        operationId: omp.reviewOperation ?? (value.isolation ? MATERIAL_SESSION_OPERATION_ID : LAUNCH_OPERATION_ID),
        reviewDigest, pins: { installationRevision: "native-installation", artifactSha256: "c".repeat(64), resourceBindingDigest: "d".repeat(64) },
        defaultsRevision: value.expectedDefaultsRevision, effectiveOverlay: value.overlay,
        automation: value.isolation ? { mode: "restricted", toolNames: [], delegation: "disabled" } : value.automation ?? { mode: "ordinary" },
        ...(!omp.dropReviewIsolation && value.isolation ? { isolation: value.isolation } : {}),
        ...(!omp.dropReviewLimits && value.inferenceLimits !== undefined ? { inferenceLimits: value.inferenceLimits } : {}),
        accountPool: value.accountPool, skills: omp.skills ?? { mode: value.isolation || value.skills?.mode === "disabled" ? "disabled" : "preserve", catalogRevision: null, selected: [] } } satisfies OmpResult<"reviewSession">;
    }
    if (door === `${OMP_PLUGIN_ID}.runSession`) {
      const value = ompActionSchemas.runSession.input.parse(input);
      omp.posted.push(value);
      // The hub echoes the bindings it admitted on the job it answers.
      const bindings = omp.echo === "asked" ? value.inputs : omp.echo;
      omp.job = { ...omp.job, ...(bindings === undefined ? {} : { inputs: bindings }) };
      return omp.job;
    }
    if (door === `${OMP_PLUGIN_ID}.readSession`) {
      omp.read.push(ompActionSchemas.readSession.input.parse(input));
      return { job: omp.job, session: omp.session, silence: omp.silence };
    }
    if (door === `${OMP_PLUGIN_ID}.cancelSession`) {
      omp.cancelled.push(ompActionSchemas.cancelSession.input.parse(input));
      // OMP cancels its own job and answers it; a settled one answers itself unchanged.
      omp.job = { ...omp.job, state: omp.job.state === "exited" ? "exited" : "cancelled" };
      return { job: omp.job };
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
    actions: { call },
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
        capability: record.selection!.capability, advisor: record.selection!.advisor },
      accounts: everyAccount, resolved: true }]);
    f.access.readable.add("container-b");
    f.calls.length = 0;
    const both = await accepted(f, "listProfiles", {});
    expect(both.profiles.map(profile => profile.containerId)).toEqual([target.containerId, other.containerId]);
    // The accounts owner is asked once for the whole list, never once per profile.
    expect(f.calls).toEqual([accountsDoor]);
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
      { containerId: target.containerId, revision: record.revision, machineId: null, selected: null,
        accounts: everyAccount, resolved: true },
    ]);
  });

  test("a profile names the accounts its choices resolve to, and says so when nothing resolved them", async () => {
    const f = fixture();
    const record = await configured(f);
    // The workspace excludes one login; the two it still spends are the ones reported, with the
    // login the observation named and the API-key slot's absent one.
    const chosen = await accepted(f, "changeAccounts", { ...workspace, expectedRevision: record.revision,
      change: { kind: "set-account", reference: observation().accounts[2]!.reference, enabled: false } });
    const spending = (await accepted(f, "listProfiles", {})).profiles[0];
    expect(spending).toMatchObject({ revision: chosen.revision, resolved: true });
    expect(spending?.accounts).toEqual(everyAccount.slice(0, 2));
    // No observation, and a stale one, are the same answer: Code names nothing it cannot resolve.
    f.omp.refuse.set(accountsDoor, "omp_broker_unavailable");
    expect((await accepted(f, "listProfiles", {})).profiles[0]).toMatchObject({ accounts: [], resolved: false });
    f.omp.refuse.clear();
    f.omp.accounts = { ...observation(), status: "stale" };
    expect((await accepted(f, "listProfiles", {})).profiles[0]).toMatchObject({ accounts: [], resolved: false });
  });
});

describe("the session a dependent plugin posts through Code", () => {
  test("a successful session updates the profile's last destination machine", async () => {
    const f = fixture();
    const record = await configured(f);
    expect((await accepted(f, "listProfiles", {})).profiles[0]?.machineId).toBeNull();
    await accepted(f, "runSession", { ...target, expectedRevision: record.revision, prompt: "Implement the change" });
    expect((await accepted(f, "listProfiles", {})).profiles[0]?.machineId).toBe(target.machineId);
  });

  test("a requested ceiling must survive review and receipt reads without preventing cancellation", async () => {
    const f = fixture();
    const record = await configured(f);
    const inferenceLimits = { calls: 2, costMicros: 20_000 };
    const input = { ...target, expectedRevision: record.revision, prompt: "Bounded analysis", inferenceLimits };
    f.omp.dropReviewLimits = true;
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_omp_review_changed" });
    expect(f.omp.posted).toEqual([]);
    f.omp.dropReviewLimits = false;
    f.omp.job.limits = { timeoutMs: 60_000, memoryBytes: 64 * 1024 * 1024, processes: 8,
      outputBytes: 64 * 1024, inference: inferenceLimits };
    const posted = await accepted(f, "runSession", input);
    expect(posted.limits?.inference).toEqual(inferenceLimits);
    delete f.omp.job.limits;
    expect(await invoke(f, "readSession", { ...workspace, jobId: posted.jobId }))
      .toEqual({ refused: "code_omp_review_changed" });
    expect((await accepted(f, "cancelSession", { ...workspace, jobId: posted.jobId })).job.state).toBe("cancelled");
  });

  test("substituted material cannot be vouched for during posting or a retained read", async () => {
    const f = fixture();
    const record = await configured(f);
    const inputs: JobInputBinding[] = [{ name: "material", from: { jobId: "job-earlier", output: "session" } }];
    const input = { ...target, expectedRevision: record.revision, prompt: "Read the material", inputs };
    const substituted = [{ name: "material", from: { jobId: "job-somebody-elses", output: "session" } }];
    f.omp.echo = substituted;
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_omp_review_changed" });
    expect(await invoke(f, "readSession", { ...workspace, jobId: f.omp.job.jobId }))
      .toEqual({ refused: "code_session_unknown" });
    f.omp.echo = "asked";
    const posted = await accepted(f, "runSession", input);
    f.omp.job.inputs = substituted;
    expect(await invoke(f, "readSession", { ...workspace, jobId: posted.jobId }))
      .toEqual({ refused: "code_omp_review_changed" });
    expect((await accepted(f, "cancelSession", { ...workspace, jobId: posted.jobId })).job.state).toBe("cancelled");
  });

  test("material-only isolation cannot be dropped in review or replaced by an ordinary operation", async () => {
    const f = fixture();
    const record = await configured(f);
    const input = { ...target, expectedRevision: record.revision, prompt: "Summarize the sealed material",
      inputs: [{ name: "material", from: { jobId: "job-material", output: "material" } }],
      isolation: { mode: "material-only" as const, file: "transcript-map.json", sha256: "a".repeat(64), bytes: 128 } };
    f.omp.dropReviewIsolation = true;
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_omp_review_changed" });
    f.omp.dropReviewIsolation = false;
    f.omp.reviewOperation = LAUNCH_OPERATION_ID;
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_omp_review_changed" });
    expect(f.omp.posted).toEqual([]);
    f.omp.reviewOperation = null;
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_omp_review_changed" });
    expect(await invoke(f, "readSession", { ...workspace, jobId: f.omp.job.jobId }))
      .toEqual({ refused: "code_session_unknown" });
    f.omp.job.operationId = MATERIAL_SESSION_OPERATION_ID;
    const posted = await accepted(f, "runSession", input);
    f.omp.job.operationId = SESSION_OPERATION_ID;
    expect(await invoke(f, "readSession", { ...workspace, jobId: posted.jobId }))
      .toEqual({ refused: "code_omp_review_changed" });
    f.omp.job.operationId = MATERIAL_SESSION_OPERATION_ID;
    expect((await accepted(f, "cancelSession", { ...workspace, jobId: posted.jobId })).job.state).toBe("cancelled");
  });

  test("Code accepts reviewed optional bindings beside material but refuses a substituted skill source", async () => {
    const f = fixture();
    const record = await configured(f);
    const source = { jobId: "job-reviewed-skill", output: "skill", sha256: "a".repeat(64) };
    f.omp.skills = { mode: "selected", catalogRevision: 4, selected: [{ id: "review", name: "review", title: "Review",
      purpose: "Review changes", revision: "source-v1", source, license: { spdx: "MIT" },
      review: { reviewedBy: "owner", reviewedAt: now, reference: "review-1" }, conflicts: [] }] };
    const material: JobInputBinding = { name: "material", from: { jobId: "job-material", output: "session" } };
    const input = { ...target, expectedRevision: record.revision, prompt: "Review this material", inputs: [material],
      skills: { mode: "select" as const, expectedCatalogRevision: 4, skillIds: [], setIds: ["review-set"] } };
    f.omp.echo = [material, { name: "optionalSkill0", from: { jobId: "job-unreviewed-skill", output: source.output } }];
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_omp_review_changed" });
    expect(f.store.has(`sessions/${digestOf(workspace)}/${f.omp.job.jobId}`)).toBe(false);
    f.omp.echo = [material, { name: "optionalSkill0", from: { jobId: source.jobId, output: source.output } }];
    const posted = await accepted(f, "runSession", input);
    expect(posted.inputs).toEqual(f.omp.echo);
    expect((await accepted(f, "readSession", { ...workspace, jobId: posted.jobId })).job.jobId).toBe(posted.jobId);
  });

  test("unsupported tools and delegation refuse before native review or posting", async () => {
    const f = fixture();
    const record = await configured(f);
    const input = { ...target, expectedRevision: record.revision, prompt: "Read only" };
    for (const automation of [
      { mode: "restricted", toolNames: ["task"], delegation: "disabled" },
      { mode: "restricted", toolNames: ["read", "read"], delegation: "disabled" },
      { mode: "restricted", toolNames: ["read"], delegation: "enabled" },
      { mode: "ordinary", toolNames: [], delegation: "disabled" },
    ]) expect(await handlers.runSession!(f.ctx, { ...input, automation })).toEqual({ refused: "code_invalid_request" });
    expect(f.omp.reviewed).toEqual([]);
    expect(f.omp.posted).toEqual([]);
  });

  test("the prompt a run carries is bounded by OMP's bytes, at Code's door", async () => {
    const f = fixture();
    const record = await configured(f);
    const input = { ...target, expectedRevision: record.revision };
    // Exactly the bound in ASCII is one byte per character, and it reaches OMP whole.
    const full = "x".repeat(PROMPT_MAX_BYTES);
    const posted = await accepted(f, "runSession", { ...input, prompt: full });
    expect(posted).toEqual(f.omp.job);
    expect(f.omp.posted[0]?.prompt).toBe(full);
    // One byte over is refused here, before OMP is asked anything at all.
    const over = fixture();
    const saved = await configured(over);
    expect(await invoke(over, "runSession", { ...input, expectedRevision: saved.revision, prompt: `${full}x` }))
      .toEqual({ refused: "code_invalid_request" });
    // Bytes, not characters: three-byte UTF-8 passes a character count three times over.
    const wide = "あ".repeat(Math.ceil((PROMPT_MAX_BYTES + 1) / 3));
    expect(wide.length).toBeLessThan(PROMPT_MAX_BYTES);
    expect(await invoke(over, "runSession", { ...input, expectedRevision: saved.revision, prompt: wide }))
      .toEqual({ refused: "code_invalid_request" });
    expect(over.calls).toEqual([]);
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

  test("a review OMP no longer stands behind, an interactive placement and a re-identified job are never vouched for", async () => {
    const f = fixture();
    const record = await configured(f);
    const input = { ...target, expectedRevision: record.revision, prompt: "Implement the change" };
    f.omp.refuse.set(actionDoor("reviewSession"), "omp_review_changed");
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_omp_review_changed" });
    f.omp.refuse.clear();
    f.omp.job = { ...job(), machineId: "machine-b" };
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_omp_review_changed" });
    // The review names `atyrode.omp.launch` because a session's content is placement-agnostic;
    // a job on that interactive operation is a terminal's, and Code does not speak for it.
    f.omp.job = { ...job(), operationId: LAUNCH_OPERATION_ID };
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_omp_review_changed" });
    expect(f.store.has(`sessions/${digestOf(workspace)}/${f.omp.job.jobId}`)).toBe(false);
    f.omp.job = job();
    f.store.set(`sessions/${digestOf(workspace)}/${f.omp.job.jobId}`, "retained by an earlier run");
    expect(await invoke(f, "runSession", input)).toEqual({ refused: "code_session_conflict" });
  });

  test("only OMP's own word survives the edge: the host's classes and a broken door are named apart", async () => {
    const live = fixture();
    const saved = await configured(live);
    const posted = { ...target, expectedRevision: saved.revision, prompt: "Implement the change" };
    const refusals: Readonly<Record<string, string>> = {
      [`dependency_unavailable: ${CODE_PLUGIN_ID} -> atyrode.omp.accounts`]: "code_omp_accounts_dependency_unavailable",
      [`caller_ceiling: ${CODE_PLUGIN_ID} -> ${accountsDoor} (services:read)`]: "code_omp_accounts_caller_ceiling",
      [`capability: ${CODE_PLUGIN_ID} -> ${accountsDoor} (omp_scope_refused)`]: "code_omp_accounts_capability",
      // A door that threw, and a door called wrong, are the host's account of the edge — never
      // a word OMP published, so neither may be re-raised as one.
      [`refused: ${CODE_PLUGIN_ID} -> ${accountsDoor} (failed)`]: "code_omp_accounts_refused",
      [`refused: ${CODE_PLUGIN_ID} -> ${accountsDoor} (invalid_args: accounts takes no arguments)`]: "code_omp_accounts_refused",
      [`refused: ${CODE_PLUGIN_ID} -> ${accountsDoor} (omp_broker_unavailable)`]: "code_omp_broker_unavailable",
      "the host said nothing a caller can act on": "code_omp_accounts_refused",
    };
    for (const [sentence, refused] of Object.entries(refusals)) {
      live.omp.reject.set(accountsDoor, sentence);
      expect(await invoke(live, "runSession", posted)).toEqual({ refused });
    }
    expect(live.omp.posted).toEqual([]);
  });
});

describe("reading back and ending a session Code posted", () => {
  test("OMP's receipt passes through unchanged for the job Code retained, and for no other", async () => {
    const f = fixture();
    const record = await configured(f);
    await configured(f, "container-b");
    await accepted(f, "runSession", { ...target, expectedRevision: record.revision, prompt: "Implement the change" });
    expect(await accepted(f, "readSession", { ...workspace, jobId: f.omp.job.jobId }))
      .toEqual({ job: f.omp.job, session: receipt(), silence: null });
    expect(f.omp.read).toEqual([{ ...target, jobId: f.omp.job.jobId }]);
    expect(await invoke(f, "readSession", { ...workspace, jobId: "job-nobody-posted" })).toEqual({ refused: "code_session_unknown" });
    expect(await invoke(f, "readSession", { containerId: "container-b", jobId: f.omp.job.jobId })).toEqual({ refused: "code_session_unknown" });
    f.access.readable.delete(target.containerId);
    expect(await invoke(f, "readSession", { ...workspace, jobId: f.omp.job.jobId })).toEqual({ refused: "code_scope_refused" });
    f.access.readable.add(target.containerId);
    f.omp.job = job("job-another-door-placed");
    expect(await invoke(f, "readSession", { ...workspace, jobId: "job-a" })).toEqual({ refused: "code_omp_review_changed" });
  });

  test("a session with no receipt reaches the caller with the word that stopped it", async () => {
    const f = fixture();
    const record = await configured(f);
    await accepted(f, "runSession", { ...target, expectedRevision: record.revision, prompt: "Implement the change" });
    // A run OMP has not sealed a transcript for: the answer is the job's own state, not a
    // refusal, so a caller can watch a session it started. WHICH fact stopped it travels with
    // it — an absence answered five at once, and a caller settling a claim could not tell a run
    // that is still going from one whose destination filled under it
    // (atyrode/manifold-omp#43). Code carries the word and does not interpret it.
    f.omp.session = null;
    f.omp.silence = "omp_session_running";
    expect(await accepted(f, "readSession", { ...workspace, jobId: "job-a" }))
      .toEqual({ job: { ...job(), state: "started" }, session: null, silence: "omp_session_running" });
    // Every word OMP can answer reaches the caller as itself: no mapping, no collapsing, and no
    // door in the middle deciding which silences are worth reporting.
    for (const silence of SessionSilenceSchema.options) {
      f.omp.silence = silence;
      const read = await accepted(f, "readSession", { ...workspace, jobId: "job-a" });
      expect(read.silence).toBe(silence);
      expect(read.session).toBeNull();
    }
    // EXACTLY ONE OF THE TWO IS NULL, asserted here because Code is where a caller reads it: a
    // reply carrying both, or neither, is refused rather than passed on as a shape no consumer
    // can interpret.
    f.omp.session = receipt();
    f.omp.silence = "omp_session_failed";
    expect(await invoke(f, "readSession", { ...workspace, jobId: "job-a" })).toEqual({
      refused: "code_invalid_omp_result",
    });
    f.omp.session = null;
    f.omp.silence = null;
    expect(await invoke(f, "readSession", { ...workspace, jobId: "job-a" })).toEqual({
      refused: "code_invalid_omp_result",
    });
    f.omp.silence = "omp_session_failed";
    const failed = { ...job(), state: "exited" as const, result: { jobId: "job-a", requestDigest: "f".repeat(64),
      ownerId: "owner", ownerGeneration: 1, state: "exited" as const, exitCode: 1, reason: null,
      startedAt: now, finishedAt: now + 1_000, usage: null, outputs: [],
      limits: { timeoutMs: 600_000, memoryBytes: 1 << 30, processes: 64, outputBytes: 1 << 20 } } };
    f.omp.job = PublicJobSchema.parse(failed);
    const answered = await accepted(f, "readSession", { ...workspace, jobId: "job-a" });
    expect(answered.session).toBeNull();
    expect(answered.job.result?.exitCode).toBe(1);
  });

  test("cancelling ends the run Code posted, twice over, and never another plugin's job", async () => {
    const f = fixture();
    const record = await configured(f);
    await configured(f, "container-b");
    await accepted(f, "runSession", { ...target, expectedRevision: record.revision, prompt: "Implement the change" });
    const ended = await accepted(f, "cancelSession", { ...workspace, jobId: "job-a" });
    expect(ended.job.state).toBe("cancelled");
    expect(f.omp.cancelled).toEqual([{ ...target, jobId: "job-a" }]);
    // Idempotent at OMP: a settled job answers itself, so a second call is the same answer.
    expect((await accepted(f, "cancelSession", { ...workspace, jobId: "job-a" })).job.state).toBe("cancelled");
    expect(await invoke(f, "cancelSession", { ...workspace, jobId: "job-nobody-posted" })).toEqual({ refused: "code_session_unknown" });
    expect(await invoke(f, "cancelSession", { containerId: "container-b", jobId: "job-a" })).toEqual({ refused: "code_session_unknown" });
    expect(f.omp.cancelled).toHaveLength(2);
    // Ending someone's run is a write, not a read of it.
    f.access.writable.delete(target.containerId);
    expect(await invoke(f, "cancelSession", { ...workspace, jobId: "job-a" })).toEqual({ refused: "code_scope_refused" });
    f.access.writable.add(target.containerId);
    f.omp.job = job("job-another-door-placed");
    expect(await invoke(f, "cancelSession", { ...workspace, jobId: "job-a" })).toEqual({ refused: "code_omp_review_changed" });
  });
});
