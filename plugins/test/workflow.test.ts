import { expect, test } from "bun:test";
import { actionDoor, type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { createCodeWorkflowClient } from "../code/workflow.ts";
import type { TerminalSummary } from "@manifold/protocol";
import type { ActionResult } from "../code/contract.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { compileOmpOverlay, defaultSelection, reviewCatalog } from "../domain/routing.ts";

const target = { containerId: "workspace", machineId: "destination" };
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
    runtime: { ...prepared.runtime, operationId: "atyrode.omp.resume",
      session: { harness: "atyrode.omp", machineId: target.machineId, sessionId }, input: { sessionId } } };
  let refusal: string | null = null;
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
        skills: { mode: input.skills?.mode === "disabled" ? "disabled" : "preserve", catalogRevision: null, selected: [] } } satisfies OmpResult<"reviewSession">;
    }
    if (door === actionDoor("prepareSession")) { preparations++; return refusal ? { refused: refusal } : prepared; }
    if (door === actionDoor("resumeSession")) { resumeInputs.push(raw as OmpInput<"resumeSession">); return refusal ? { refused: refusal } : resumed; }
    if (door === actionDoor("listSessions")) return [{ id: sessionId, title: "Saved work", cwd: "/workspace", updatedAt: 1000 }];
    throw new Error(`Unexpected owner/action: ${door}`);
  });
  return { workflow, composition, defaults, prepared, resumed, resumeInputs, sessionId, terminals, machines, preparations: () => preparations, refuse: (reason: string) => { refusal = reason; } };
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

test("a different native operation cannot be substituted into an interactive launch review", async () => {
  const fixture = sessionFixture();
  const review = await fixture.workflow.reviewSession(target, 1, fixture.composition.prompt);
  review.native.operationId = "atyrode.omp.session";
  await expect(fixture.workflow.prepareSession(review)).rejects.toThrow("omp_review_changed");
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
