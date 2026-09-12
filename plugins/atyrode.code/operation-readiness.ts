import { formatManifoldUri, type Cap, type JobDescription, type ManifoldRef } from "@manifold/protocol";
import type { GuestAuth } from "@manifold/plugin-kit/server";
import manifest from "./manifest.json";
import accountsManifest from "./accounts/manifest.json";

export type SetupOperation = "prepare-workspace" | "validate-workspace" | "catalog-inventory" | "catalog-benchmark" | "launch";
type OperationManifest = {
  id: string;
  machine: { operations: Record<string, { network: string; locations: readonly { locationId: string; access: string }[];
    services?: readonly { serviceId: string; operationIds: readonly string[] }[] }> };
};
type NativeRequirement = { cap: Exclude<Cap, "*">; ref: ManifoldRef };

/** Exact native admission references, plus the receipt access used by the consumer. */
function operationRequirements(machineId: string, definition: OperationManifest, operationId: string, readOutput: boolean): NativeRequirement[] {
  const operation = definition.machine.operations[operationId]!;
  const ref = { kind: "operation" as const, machineId, operationId };
  return [
    { cap: "machines:run", ref },
    ...(readOutput ? [{ cap: "jobs:read" as const, ref }] : []),
    ...operation.locations.map(location => ({ cap: `locations:${location.access}` as NativeRequirement["cap"],
      ref: { kind: "location" as const, machineId, locationId: location.locationId } })),
    ...(operation.network === "host" ? [{ cap: "network:host" as const, ref }] : []),
    ...(operation.services ?? []).flatMap(service => service.operationIds.map(operationId => ({
      cap: "services:invoke" as const, ref: { kind: "service" as const, machineId, serviceId: service.serviceId, operationId },
    }))),
  ];
}

export function codeOperationRequirements(machineId: string, operation: SetupOperation): NativeRequirement[] {
  return operationRequirements(machineId, manifest, `${manifest.id}.${operation}`, operation !== "launch");
}

export function accountOperationRequirements(machineId: string, operation: "broker" | "sign-in"): NativeRequirement[] {
  return operationRequirements(machineId, accountsManifest, `${accountsManifest.id}.${operation}`, false);
}

/** Observation only: native admission still rechecks grants and installed consent. */
export async function callerRequirementRefusal(auth: Pick<GuestAuth, "caps" | "allows">, requirements: readonly NativeRequirement[]): Promise<string | null> {
  for (const { cap, ref } of requirements) {
    if ((!auth.caps.includes("*") && !auth.caps.includes(cap)) || !await auth.allows(cap, ref))
      return `Your current identity lacks ${cap} at ${formatManifoldUri(ref)}. Native installation approval does not grant this caller access.`;
  }
  return null;
}

/** A UI prerequisite, never admission: native describe scopes enabled consents to its
 * machine, installation revision and artifact. Consent revision is the decision revision.
 * Direct Code jobs need run authority; setup/probe paths also read their native receipts.
 * Cancellation and parent-operation invocation are separate, unused rights here. */
function operationRefusal(description: JobDescription | null | undefined, machineId: string, definition: OperationManifest, operationId: string, readOutput: boolean): string | null {
  const installation = description?.installation;
  const declaration = definition.machine.operations[operationId];
  if (!description || description.machineId !== machineId || description.pluginId !== definition.id || !description.connected ||
    !installation || !declaration) return "resources_incomplete";
  if (installation.purgeRequested) return "purge_requested";
  // Native masks consent visibility while an installation is disabled. That is
  // an installation recovery prerequisite, not evidence that consent was revoked.
  if (!installation.enabled) return "installation_disabled";
  const operation = description.operations?.[operationId];
  if (!operation?.ready) return operation?.reason ?? "resources_incomplete";
  if (!installation.ready) return "resources_incomplete";
  // Service consent belongs to its native policy, not the installation consent rows.
  return operationRequirements(machineId, definition, operationId, readOutput).every(({ cap, ref }) =>
    ref.kind === "service" || description.consents.some(consent => consent.node === formatManifoldUri(ref) && consent.cap === cap && consent.enabled))
    ? null : "native_consent_required";
}

export function codeOperationReady(description: JobDescription | null | undefined, machineId: string, operation: SetupOperation): boolean {
  return operationRefusal(description, machineId, manifest, `${manifest.id}.${operation}`, operation !== "launch") === null;
}

export function accountOperationRefusal(description: JobDescription | null | undefined, machineId: string, operation: "broker" | "sign-in"): string | null {
  return operationRefusal(description, machineId, accountsManifest, `${accountsManifest.id}.${operation}`, false);
}
