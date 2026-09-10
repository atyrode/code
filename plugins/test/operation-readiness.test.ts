import { expect, test } from "bun:test";
import { formatManifoldUri, type Cap, type JobDescription } from "@manifold/protocol";
import { codeOperationReady, type SetupOperation } from "../atyrode.code/operation-readiness.ts";

function description(operation: SetupOperation, rights: readonly Cap[]): JobDescription {
  const operationId = `atyrode.code.${operation}`;
  return {
    machineId: "machine-a", pluginId: "atyrode.code", connected: true, admissionPublicKey: "unused", platforms: [],
    installation: { revision: "installation-2", artifactSha256: "a".repeat(64), enabled: true, ready: true, purgeRequested: false },
    retainedInstallations: [], operations: { [operationId]: { ready: true, reason: null, resourceBindingDigest: "b".repeat(64) } },
    consents: rights.flatMap(cap => (cap.startsWith("locations:")
      ? ["atyrode.code.workspace", "atyrode.code.sessions"].map(locationId => formatManifoldUri({ kind: "location", machineId: "machine-a", locationId }))
      : [formatManifoldUri({ kind: "operation", machineId: "machine-a", operationId })])
      .map(node => ({ node, cap, enabled: true, revision: "decision-9" }))),
  };
}

test("resource readiness cannot substitute for scoped enabled consent", () => {
  const value = description("launch", []);
  expect(codeOperationReady(value, "machine-a", "launch")).toBe(false);
  value.consents = description("launch", ["machines:run", "network:host", "locations:write"]).consents;
  // Native decision revisions are not installation revisions.
  expect(codeOperationReady(value, "machine-a", "launch")).toBe(true);
  expect(codeOperationReady(value, "machine-b", "launch")).toBe(false);
  value.consents[0]!.enabled = false;
  expect(codeOperationReady(value, "machine-a", "launch")).toBe(false);
});

test("existing-folder access works independently of creation but requires readable receipts", () => {
  const value = description("validate-workspace", ["machines:run", "jobs:read", "locations:read"]);
  value.operations!["atyrode.code.prepare-workspace"] = { ready: true, reason: null, resourceBindingDigest: "b".repeat(64) };
  expect(codeOperationReady(value, "machine-a", "validate-workspace")).toBe(true);
  expect(codeOperationReady(value, "machine-a", "prepare-workspace")).toBe(false);
  value.consents = value.consents.filter(consent => consent.cap !== "jobs:read");
  expect(codeOperationReady(value, "machine-a", "validate-workspace")).toBe(false);
});

test("launch requires its network and exact location access, not status or cancellation", () => {
  const value = description("launch", ["machines:run", "locations:write"]);
  expect(codeOperationReady(value, "machine-a", "launch")).toBe(false);
  value.consents = description("launch", ["machines:run", "network:host", "locations:write"]).consents;
  expect(codeOperationReady(value, "machine-a", "launch")).toBe(true);
  value.consents = value.consents.map(consent => consent.cap === "locations:write" ? { ...consent, cap: "locations:read" } : consent);
  expect(codeOperationReady(value, "machine-a", "launch")).toBe(false);
});
