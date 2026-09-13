import { canonicalJobJson } from "@manifold/protocol";
import { ACCOUNTS_PLUGIN_ID, GATEWAY_PLUGIN_ID, OMP_PLUGIN_ID, BROKER_OPERATION_ID, SIGN_IN_OPERATION_ID,
  GATEWAY_OPERATION_ID, PREPARE_WORKSPACE_OPERATION_ID, VALIDATE_WORKSPACE_OPERATION_ID, INVENTORY_OPERATION_ID,
  BENCHMARK_OPERATION_ID, LAUNCH_OPERATION_ID, type ActionInput, type ActionResult, type OmpAction } from "@atyrode/manifold-omp";
import type { z } from "zod";
import { PermissionPlanInputSchema, PermissionPlanSchema, type PermissionFeatureId } from "./contract.ts";

export type PermissionPlanInput = z.infer<typeof PermissionPlanInputSchema>;
export type PermissionPlan = z.infer<typeof PermissionPlanSchema>;
type Call = <K extends OmpAction>(name: K, input: ActionInput<K>) => Promise<ActionResult<K>>;
const features: readonly {
  id: PermissionFeatureId; title: string; effect: string; deferredEffect: string;
  prerequisites: readonly PermissionFeatureId[]; pluginId: string; operations: readonly string[];
  configuration: PermissionPlan["steps"][number]["configuration"];
}[] = [
  { id: "accounts", title: "Shared accounts and sign-in", pluginId: ACCOUNTS_PLUGIN_ID,
    operations: [BROKER_OPERATION_ID, SIGN_IN_OPERATION_ID], configuration: "account-runtime", prerequisites: [],
    effect: "Run the shared account broker and OMP sign-in on the instance’s declared owner. OMP keeps custody of credentials; no credentials are copied. Shared runtime policy is reviewed separately.",
    deferredEffect: "Existing account access is unchanged. Unprepared sign-in remains unavailable; review it later from Accounts." },
  { id: "gateway", title: "Model gateway", pluginId: GATEWAY_PLUGIN_ID,
    operations: [GATEWAY_OPERATION_ID], configuration: "gateway", prerequisites: ["accounts"],
    effect: "Run the gateway on the selected machine to use shared accounts. Its OMP service policy is reviewed separately; this does not send a model request.",
    deferredEffect: "Existing connections remain intact. Discovery and sessions need a ready connection before use." },
  { id: "workspace-create", title: "Create workspace folders", pluginId: OMP_PLUGIN_ID,
    operations: [PREPARE_WORKSPACE_OPERATION_ID], configuration: "none", prerequisites: ["gateway"],
    effect: "Allow creation of native workspace and session folders. Creation still requires its own explicit action and never overwrites existing folders.",
    deferredEffect: "No folders are created. You can instead review the existing-folder check or reconsider creation later." },
  { id: "workspace-existing", title: "Check existing workspace folders", pluginId: OMP_PLUGIN_ID,
    operations: [VALIDATE_WORKSPACE_OPERATION_ID], configuration: "none", prerequisites: ["gateway"],
    effect: "Allow checking existing workspace and session folders without changing their contents. The check is separate from this rights review.",
    deferredEffect: "Existing folder access is not revoked. An unprepared check remains available for later review." },
  { id: "discovery", title: "Discover available models", pluginId: OMP_PLUGIN_ID,
    operations: [INVENTORY_OPERATION_ID], configuration: "none", prerequisites: ["gateway"],
    effect: "Read model inventory through your account gateway. Discovery does not benchmark models or replace your catalog; results are reviewed separately.",
    deferredEffect: "You can still edit or import models. Discovery can be reviewed directly from the catalog editor later." },
  { id: "benchmark", title: "Benchmark models", pluginId: OMP_PLUGIN_ID,
    operations: [BENCHMARK_OPERATION_ID], configuration: "none", prerequisites: ["gateway", "discovery"],
    effect: "Allow model measurements using your accounts. Running a benchmark is a separate explicit action and may incur provider charges; measurements never replace a catalog automatically.",
    deferredEffect: "No benchmark is run. Existing benchmark access is unchanged and measured performance can be reconsidered from the catalog." },
  { id: "session", title: "Open coding sessions", pluginId: OMP_PLUGIN_ID,
    operations: [LAUNCH_OPERATION_ID], configuration: "none", prerequisites: ["gateway"],
    effect: "Allow OMP sessions to read and write the reviewed workspace and session locations using your model connection. Launch and its account pool are reviewed separately; your prompt stays a draft.",
    deferredEffect: "No session is opened. Saved profiles and prompts remain available while session prerequisites await review." },
];
export function operationReady(destination: ActionResult<"describeDestination"> | null | undefined, operationId: string): boolean {
  return destination?.operations.some(operation => operation.operationId === operationId && operation.state === "ready" && operation.nativeReady && operation.callerRefusal === null) === true;
}
export async function observePermissionPlan(call: Call, raw: PermissionPlanInput): Promise<PermissionPlan> {
  const args = PermissionPlanInputSchema.parse(raw);
  const target = args.machineId ? { containerId: args.containerId, machineId: args.machineId } : null;
  const observe = async <T>(work: Promise<T>): Promise<{ value: T | null; error: string | null }> => {
    try { return { value: await work, error: null }; }
    catch (error) { return { value: null, error: error instanceof Error ? error.message : "Native observation unavailable" }; }
  };
  const [accountSetup, accounts, destination, gateway] = await Promise.all([
    observe(call("readAccountSetup", {})), observe(call("accounts", {})),
    target ? observe(call("describeDestination", target)) : { value: null, error: null },
    target ? observe(call("readGatewaySetup", target)) : { value: null, error: null },
  ]);
  const sharedAccountsReady = accounts.value?.status === "fresh";
  const gatewayConfigured = destination.value?.services.some(service => service.serviceId === "omp" && service.state === "ready") === true;
  const prepared = (id: PermissionFeatureId): boolean => id === "accounts" ? sharedAccountsReady : id === "gateway" ? gatewayConfigured :
    features.find(feature => feature.id === id)!.operations.every(operation => operationReady(destination.value, operation));
  const selected = new Set(args.choices ?? []);
  if (args.choices === null && args.intent !== "setup") {
    const select = (id: PermissionFeatureId) => {
      if (selected.has(id)) return;
      selected.add(id);
      for (const prerequisite of features.find(feature => feature.id === id)!.prerequisites) if (!prepared(prerequisite)) select(prerequisite);
    };
    select(args.intent);
  }
  const rows = features.map(feature => ({
    id: feature.id, title: feature.title, effect: feature.effect, deferredEffect: feature.deferredEffect,
    prerequisites: [...feature.prerequisites], selected: selected.has(feature.id),
    destination: feature.id === "accounts" ? accountSetup.value?.owner ? { machineId: accountSetup.value.owner.machineId, label: accountSetup.value.owner.machineId } : null :
      target ? { machineId: target.machineId, label: target.machineId } : null,
  }));
  const steps: PermissionPlan["steps"] = [], blockers: string[] = [];
  for (const feature of features) {
    if (!selected.has(feature.id)) continue;
    const location = rows.find(row => row.id === feature.id)!.destination;
    if (!location) { blockers.push(feature.id === "accounts" ? accountSetup.error ?? "The native instance has no declared account owner. No alternate destination was selected." : "Choose a workspace machine to review this capability."); continue; }
    const refusal = feature.id === "accounts" ? accountSetup.value?.callerRefusal ?? accountSetup.error : feature.id === "gateway" ?
      gateway.value?.callerRefusal ?? gateway.error :
      destination.error ?? destination.value?.operations.find(operation => feature.operations.includes(operation.operationId) && operation.callerRefusal)?.callerRefusal;
    if (refusal) blockers.push(`${feature.title}: ${refusal}`);
    let step = steps.find(step => step.request.pluginId === feature.pluginId && step.request.targets[0]?.machineId === location.machineId);
    if (!step) {
      step = { request: { deploymentId: `${args.requestId}-${steps.length}`, pluginId: feature.pluginId, targets: [{ machineId: location.machineId }], operationIds: [] },
        featureIds: [], configuration: feature.configuration, nativeReady: true, configurationCurrent: true };
      steps.push(step);
    }
    step.featureIds.push(feature.id);
    step.request.operationIds.push(...feature.operations.filter(operation => !step!.request.operationIds.includes(operation)));
    step.nativeReady &&= !refusal && (feature.id === "accounts" ? accountSetup.value?.nativeReady === true : feature.id === "gateway" ? gateway.value?.nativeReady === true : prepared(feature.id));
    step.configurationCurrent &&= feature.id === "accounts" ? accountSetup.value?.canSignIn === true && accountSetup.value.state === "ready" && !refusal : feature.id === "gateway" ? gatewayConfigured && !refusal : true;
  }
  // Native health and caller refusals are reobserved, not grant caches. Only the
  // requested destination/choices define scope; native digests bind exact revisions.
  const scope = { containerId: args.containerId, machineId: args.machineId, features: rows,
    steps: steps.map(({ nativeReady: _nativeReady, configurationCurrent: _configurationCurrent, ...step }) => step) };
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJobJson(scope)));
  const scopeDigest = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
  return PermissionPlanSchema.parse({ scopeDigest, features: rows, steps, blockers,
    ownerApprovalRequired: steps.some(step => !step.nativeReady || !step.configurationCurrent) });
}
