import { expect, test } from "bun:test";
import { actionDoor, type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { createCodeWorkflowClient } from "../atyrode.code/workflow.ts";
import type { ActionResult } from "../atyrode.code/contract.ts";
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
  const prepared: OmpResult<"prepareSession"> = { destination: target, reviewDigest: "b".repeat(64), runtime: {
    machineId: target.machineId,
    pluginId: "atyrode.omp", operationId: "atyrode.omp.launch", installationRevision: "native-installation",
    artifactSha256: "c".repeat(64), resourceBindingDigest: "d".repeat(64), input: { opaqueNativeInput: "preserved" },
  } };
  let preparations = 0;
  let refusal: string | null = null;
  const workflow = createCodeWorkflowClient(async (door, raw) => {
    if (door === actionDoor("accounts")) return accounts;
    if (door === actionDoor("readDefaults")) return defaults;
    if (door === "atyrode.code.composeSession") return composition;
    if (door === actionDoor("reviewSession")) {
      const input = raw as OmpInput<"reviewSession">;
      return { destination: target, operationId: "atyrode.omp.launch", reviewDigest: prepared.reviewDigest,
        pins: { installationRevision: prepared.runtime.installationRevision, artifactSha256: prepared.runtime.artifactSha256, resourceBindingDigest: prepared.runtime.resourceBindingDigest },
        defaultsRevision: input.expectedDefaultsRevision, effectiveOverlay: input.overlay, accountPool: input.accountPool } satisfies OmpResult<"reviewSession">;
    }
    if (door === actionDoor("prepareSession")) { preparations++; return refusal ? { refused: refusal } : prepared; }
    throw new Error(`Unexpected owner/action: ${door}`);
  });
  return { workflow, composition, defaults, prepared, preparations: () => preparations, refuse: (reason: string) => { refusal = reason; } };
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
