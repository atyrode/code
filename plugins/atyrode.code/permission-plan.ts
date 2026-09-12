import { JobDeploymentDescriptionSchema, JobDescriptionSchema } from "@manifold/protocol";
import { BROKER_OPERATION_ID, SIGN_IN_OPERATION_ID } from "./auth-contract.ts";
import { describeSharedBroker } from "./broker.ts";
import { ACCOUNTS_PLUGIN_ID, CODE_PLUGIN_ID, GATEWAY_OPERATION_ID, GATEWAY_PLUGIN_ID,
  type ActionInput, type ActionResult, type PermissionFeatureId } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./machine-server.ts";
import { brokerOwner } from "./service-setup.ts";
import { callerRequirementRefusal, codeOperationReady, codeOperationRequirements, type SetupOperation } from "./operation-readiness.ts";
import { readConfiguration, resourceSnapshot } from "./state.ts";

/** Product workflow metadata, not grants. Native review alone resolves declaration,
 * resources and consent. Keeping owner identities here allows the account consumer
 * cutover without duplicating a permission workflow in each surface. */
const features: readonly {
  id: PermissionFeatureId; title: string; effect: string; deferredEffect: string;
  prerequisites: readonly PermissionFeatureId[]; pluginId: string; operations: readonly string[];
  configuration: ActionResult<"readPermissionPlan">["steps"][number]["configuration"];
}[] = [
  { id: "accounts", title: "Shared accounts and sign-in", pluginId: ACCOUNTS_PLUGIN_ID,
    operations: [BROKER_OPERATION_ID, SIGN_IN_OPERATION_ID], configuration: "account-runtime", prerequisites: [],
    effect: "Run the shared account broker and OMP sign-in on the instance’s declared owner. OMP keeps custody of credentials; no credentials are copied. Shared runtime policy is reviewed separately.",
    deferredEffect: "Existing account access is unchanged. Unprepared sign-in remains unavailable; review it later from Accounts." },
  { id: "gateway", title: "Model gateway", pluginId: GATEWAY_PLUGIN_ID,
    operations: [GATEWAY_OPERATION_ID], configuration: "connection", prerequisites: ["accounts"],
    effect: "Run the gateway on the selected machine to use shared accounts. Connecting Code to this runtime is a separate service-policy review; this does not send a model request.",
    deferredEffect: "Existing connections remain intact. Discovery and sessions need a ready connection before use." },
  { id: "workspace-create", title: "Create workspace folders", pluginId: CODE_PLUGIN_ID,
    operations: [`${CODE_PLUGIN_ID}.prepare-workspace`], configuration: "resources", prerequisites: ["gateway"],
    effect: "Allow creation of native workspace and session folders. Creation still requires its own explicit action and never overwrites existing folders. The Code artifact also requires the gateway resource binding.",
    deferredEffect: "No folders are created. You can instead review the existing-folder check or reconsider creation later." },
  { id: "workspace-existing", title: "Check existing workspace folders", pluginId: CODE_PLUGIN_ID,
    operations: [`${CODE_PLUGIN_ID}.validate-workspace`], configuration: "resources", prerequisites: ["gateway"],
    effect: "Allow checking existing workspace and session folders without changing their contents. The check is separate from this rights review; the Code artifact requires the gateway resource binding.",
    deferredEffect: "Existing folder access is not revoked. An unprepared check remains available for later review." },
  { id: "discovery", title: "Discover available models", pluginId: CODE_PLUGIN_ID,
    operations: [`${CODE_PLUGIN_ID}.catalog-inventory`], configuration: "resources", prerequisites: ["gateway"],
    effect: "Read model inventory through your account gateway. Discovery does not benchmark models or replace your catalog; results are reviewed separately.",
    deferredEffect: "You can still edit or import models. Discovery can be reviewed directly from the catalog editor later." },
  { id: "benchmark", title: "Benchmark models", pluginId: CODE_PLUGIN_ID,
    operations: [`${CODE_PLUGIN_ID}.catalog-benchmark`], configuration: "resources", prerequisites: ["gateway", "discovery"],
    effect: "Allow model measurements using your accounts. Running a benchmark is a separate explicit action and may incur provider charges; measurements never replace a catalog automatically.",
    deferredEffect: "No benchmark is run. Existing benchmark access is unchanged and measured performance can be reconsidered from the catalog." },
  { id: "session", title: "Open coding sessions", pluginId: CODE_PLUGIN_ID,
    operations: [`${CODE_PLUGIN_ID}.launch`], configuration: "resources", prerequisites: ["gateway"],
    effect: "Allow OMP sessions to read and write the reviewed workspace and session locations using your model connection. Launch and its account pool are reviewed separately; your prompt stays a draft.",
    deferredEffect: "No session is opened. Saved profiles and prompts remain available while session prerequisites await review." },
];

export async function readPermissionPlan(ctx: CodeContext, args: ActionInput<"readPermissionPlan">): Promise<ActionResult<"readPermissionPlan">> {
  if (await ctx.outsideScope(args.containerId) || !await ctx.auth.allows("containers:read", { kind: "container", containerId: args.containerId }))
    throw new CodeRefusal("scope_refused");
  let owner: ActionResult<"readAccountSetup">["owner"] = null;
  let ownerError: string | null = null;
  let accountsPrepared = false;
  let gatewayPrepared = false;
  let execution: ActionResult<"readSetup">["execution"] = null;
  let resourcesCurrent = false;
  const callerRefusals: Partial<Record<PermissionFeatureId, string | null>> = {};
  try {
    const broker = await describeSharedBroker(ctx);
    owner = brokerOwner(broker);
    accountsPrepared = broker.state === "ready" && broker.connected && owner?.online === true && broker.configuration?.enabled === true;
  } catch { ownerError = "The native shared account destination could not be read with your current authority."; }
  if (args.machineId) {
    const target = { containerId: args.containerId, machineId: args.machineId };
    try {
      const services = await ctx.services.describe({ machineId: target.machineId });
      const gateway = services.services.find(service => service.serviceId === "omp");
      gatewayPrepared = services.connected && ["models", "stream"].every(id =>
        gateway?.operations.some(operation => operation.operationId === id && operation.ready && operation.invocable));
      const callerRefusal = await callerRequirementRefusal(ctx.auth, ["models", "stream"].map(operationId => ({
        cap: "services:invoke", ref: { kind: "service", machineId: target.machineId, serviceId: "omp", operationId },
      })));
      callerRefusals.gateway = callerRefusal;
      gatewayPrepared &&= callerRefusal === null;
    } catch { /* Absence of an authorized observation is never readiness. */ }
    try {
      const description = JobDescriptionSchema.parse(await ctx.jobs.describe({ machineId: target.machineId, pluginId: CODE_PLUGIN_ID }));
      const deployment = JobDeploymentDescriptionSchema.parse(await ctx.jobs.describeDeployment({ machineId: target.machineId, pluginId: CODE_PLUGIN_ID }));
      const declaration = (await ctx.host.roster()).find(row => row.manifest.id === CODE_PLUGIN_ID)?.manifest.machine;
      if (declaration && deployment.installation && digestOf(declaration) === digestOf(deployment.installation.machine)) execution = description;
      const previous = await readConfiguration(ctx, target);
      const resources = previous.record?.resourcesByMachine[target.machineId];
      resourcesCurrent = resources !== undefined && digestOf(resources) === digestOf(await resourceSnapshot(ctx, target.machineId));
    } catch { /* An unavailable or stale native declaration must be reviewed. */ }
  }
  for (const feature of features) {
    const machineId = feature.pluginId === ACCOUNTS_PLUGIN_ID ? owner?.machineId : args.machineId;
    if (!machineId || feature.pluginId === GATEWAY_PLUGIN_ID) continue;
    const requirements = feature.pluginId === CODE_PLUGIN_ID ? feature.operations.flatMap(operation =>
      codeOperationRequirements(machineId, operation.slice(CODE_PLUGIN_ID.length + 1) as SetupOperation)) : [];
    if (feature.id === "session" || feature.id === "accounts") requirements.push(
      { cap: "containers:write", ref: { kind: "container", containerId: args.containerId } },
      { cap: "terminals:spawn", ref: { kind: "container", containerId: args.containerId } },
    );
    callerRefusals[feature.id] = await callerRequirementRefusal(ctx.auth, requirements);
  }
  // Contextual suggestions include only unprepared prerequisites. A reader of an
  // already configured catalog is not redirected into instance administration.
  const selected = new Set(args.choices ?? []);
  if (args.choices === null && args.intent !== "setup") {
    const select = (id: PermissionFeatureId) => {
      if (selected.has(id)) return;
      selected.add(id);
      for (const prerequisite of features.find(feature => feature.id === id)!.prerequisites) {
        if (prerequisite === "accounts" && accountsPrepared || prerequisite === "gateway" && gatewayPrepared ||
          prerequisite === "discovery" && args.machineId && !callerRefusals.discovery && codeOperationReady(execution, args.machineId, "catalog-inventory")) continue;
        select(prerequisite);
      }
    };
    select(args.intent);
  }
  const rows = features.map(feature => ({
    id: feature.id, title: feature.title, effect: feature.effect, deferredEffect: feature.deferredEffect,
    prerequisites: [...feature.prerequisites], selected: selected.has(feature.id),
    destination: feature.pluginId === ACCOUNTS_PLUGIN_ID ? owner && { machineId: owner.machineId, label: owner.name } :
      args.machineId ? { machineId: args.machineId, label: args.machineId } : null,
  }));
  const steps: ActionResult<"readPermissionPlan">["steps"] = [];
  const blockers: string[] = [];
  for (const feature of features) {
    if (!selected.has(feature.id)) continue;
    const callerRefusal = callerRefusals[feature.id];
    if (callerRefusal) blockers.push(`${feature.title}: ${callerRefusal}`);
    const destination = rows.find(row => row.id === feature.id)!.destination;
    if (!destination) {
      blockers.push(feature.pluginId === ACCOUNTS_PLUGIN_ID ? ownerError ?? "The native instance has no declared account owner. No alternate destination was selected." : "Choose a workspace machine to review this capability.");
      continue;
    }
    let step = steps.find(step => step.request.pluginId === feature.pluginId && step.request.targets[0]?.machineId === destination.machineId);
    if (!step) {
      step = { request: { deploymentId: `${args.requestId}-${steps.length}`, pluginId: feature.pluginId,
        targets: [{ machineId: destination.machineId }], operationIds: [] }, featureIds: [], configuration: feature.configuration,
        // Accounts owns its native jobs handle. Null requires readAccountSetup,
        // not a deployment and not caller-supplied readiness sent back to this door.
        nativeReady: feature.pluginId === ACCOUNTS_PLUGIN_ID ? null : feature.pluginId === GATEWAY_PLUGIN_ID && gatewayPrepared,
        configurationCurrent: feature.pluginId === GATEWAY_PLUGIN_ID ? gatewayPrepared : feature.pluginId === CODE_PLUGIN_ID && resourcesCurrent };
      steps.push(step);
    }
    step.featureIds.push(feature.id);
    for (const operation of feature.operations) if (!step.request.operationIds.includes(operation)) step.request.operationIds.push(operation);
  }
  for (const step of steps) if (step.request.pluginId === CODE_PLUGIN_ID && args.machineId)
    step.nativeReady = step.featureIds.every(feature => !callerRefusals[feature]) &&
      step.request.operationIds.every(operation => codeOperationReady(execution, args.machineId!, operation.slice(CODE_PLUGIN_ID.length + 1) as SetupOperation));
  // Observation changes advance the workflow; only destination/choice changes
  // invalidate its scope. Native review digests separately bind exact evidence.
  const scope = { containerId: args.containerId, machineId: args.machineId, features: rows,
    steps: steps.map(({ nativeReady: _nativeReady, configurationCurrent: _configurationCurrent, ...step }) => step), blockers };
  return { scopeDigest: digestOf(scope), ownerApprovalRequired: !ctx.auth.isRoot &&
    steps.some(step => !step.nativeReady || step.configuration !== "resources" && !step.configurationCurrent),
    features: rows, steps, blockers };
}
