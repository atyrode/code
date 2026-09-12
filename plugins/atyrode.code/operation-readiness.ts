import { formatManifoldUri, type JobDescription } from "@manifold/protocol";
import manifest from "./manifest.json";
import accountsManifest from "./accounts/manifest.json";

export type SetupOperation = "prepare-workspace" | "validate-workspace" | "catalog-inventory" | "launch";
type OperationManifest = {
  id: string;
  machine: { operations: Record<string, { network: string; locations: readonly { locationId: string; access: string }[] }> };
};

/** A UI prerequisite, never admission: native describe scopes enabled consents to its
 * machine, installation revision and artifact. Consent revision is the decision revision.
 * Direct Code jobs need run authority; setup/probe paths also read their native receipts.
 * Cancellation and parent-operation invocation are separate, unused rights here. */
function operationReady(description: JobDescription | null | undefined, machineId: string, definition: OperationManifest, operationId: string, readOutput: boolean): boolean {
  const installation = description?.installation;
  const declaration = definition.machine.operations[operationId];
  if (!description || description.machineId !== machineId || description.pluginId !== definition.id || !description.connected ||
    !installation?.enabled || !installation.ready || installation.purgeRequested || !declaration || !description.operations?.[operationId]?.ready) return false;
  const node = formatManifoldUri({ kind: "operation", machineId, operationId });
  const approved = (node: string, cap: string) => description.consents.some(consent => consent.node === node && consent.cap === cap && consent.enabled);
  return approved(node, "machines:run") && (!readOutput || approved(node, "jobs:read")) &&
    (declaration.network !== "host" || approved(node, "network:host")) &&
    declaration.locations.every(location => approved(formatManifoldUri({ kind: "location", machineId, locationId: location.locationId }), `locations:${location.access}`));
}

export function codeOperationReady(description: JobDescription | null | undefined, machineId: string, operation: SetupOperation): boolean {
  return operationReady(description, machineId, manifest, `${manifest.id}.${operation}`, operation !== "launch");
}

export function accountOperationReady(description: JobDescription | null | undefined, machineId: string, operation: "broker" | "sign-in"): boolean {
  return operationReady(description, machineId, accountsManifest, `${accountsManifest.id}.${operation}`, false);
}
