import { formatManifoldUri, type JobDescription } from "@manifold/protocol";
import manifest from "./manifest.json";

export type SetupOperation = "prepare-workspace" | "validate-workspace" | "catalog-inventory" | "launch";

/** A UI prerequisite, never admission: native describe scopes enabled consents to its
 * machine, installation revision and artifact. Consent revision is the decision revision.
 * Direct Code jobs need run authority; setup/probe paths also read their native receipts.
 * Cancellation and parent-operation invocation are separate, unused rights here. */
export function codeOperationReady(description: JobDescription | null | undefined, machineId: string, operation: SetupOperation): boolean {
  const installation = description?.installation;
  const operationId = `${manifest.id}.${operation}`;
  if (!description || description.machineId !== machineId || description.pluginId !== manifest.id || !description.connected ||
    !installation?.enabled || installation.purgeRequested || !description.operations?.[operationId]?.ready) return false;
  const declaration = manifest.machine.operations[`atyrode.code.${operation}`];
  const node = formatManifoldUri({ kind: "operation", machineId, operationId });
  const approved = (node: string, cap: string) => description.consents.some(consent => consent.node === node && consent.cap === cap && consent.enabled);
  return approved(node, "machines:run") && (operation === "launch" || approved(node, "jobs:read")) &&
    (declaration.network !== "host" || approved(node, "network:host")) &&
    declaration.locations.every(location => approved(formatManifoldUri({ kind: "location", machineId, locationId: location.locationId }), `locations:${location.access}`));
}
