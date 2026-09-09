import { ServiceConfigurationReadSchema, ServiceConfigurationSchema, ServiceRuntimeSchema } from "@manifold/protocol";
import { GATEWAY_PLUGIN_ID, GATEWAY_OPERATION_ID, type ActionInput, type ActionResult, type Target } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./machine-server.ts";
import { buildCodeServices } from "./service-policies.ts";
import { authorizeTarget } from "./state.ts";

async function authorizeOwner(ctx: CodeContext, target: Target, write: boolean): Promise<void> {
  await authorizeTarget(ctx, target, write);
  if (!ctx.auth.isRoot || !(await ctx.auth.allows("services:configure", { kind: "machine", machineId: target.machineId })))
    throw new CodeRefusal("service_owner_required");
}
export async function readNativeServices(ctx: CodeContext, target: Target): Promise<ActionResult<"readServiceConfiguration">> {
  await authorizeOwner(ctx, target, false);
  return ServiceConfigurationReadSchema.parse(await ctx.services.readConfiguration({ machineId: target.machineId }));
}
function reviewGateway(current: ActionResult<"readServiceConfiguration">): ActionResult<"reviewServices">["gateway"] {
  const candidate = current.runtimeCandidates.find(({ runtime }) =>
    runtime.pluginId === GATEWAY_PLUGIN_ID && runtime.operationId === GATEWAY_OPERATION_ID);
  if (!current.connected) return { status: "omitted", reason: "machine_disconnected", nativeReason: candidate?.reason ?? null };
  if (!candidate) return { status: "omitted", reason: "not_installed", nativeReason: null };
  if (!candidate.ready) return { status: "omitted",
    reason: candidate.reason === "installation_disabled" ? "installation_disabled"
      : candidate.reason === "purge_requested" ? "purge_requested" : "resources_unready",
    nativeReason: candidate.reason };
  return { status: "ready", runtime: ServiceRuntimeSchema.parse({
    ...candidate.runtime, input: { accountPool: { input: "accountPool" } },
  }) };
}
export async function reviewNativeServices(ctx: CodeContext, args: ActionInput<"reviewServices">): Promise<ActionResult<"reviewServices">> {
  const current = await readNativeServices(ctx, args);
  if (current.configuration.revision !== args.expectedServiceRevision) throw new CodeRefusal("service_configuration_changed");
  const selectedReferences = [args.broker.credentialRef, ...args.apiKeys.map(source => source.credentialRef)];
  if (selectedReferences.some(ref => !current.credentialReferences.some(reference =>
    reference.ref === ref && reference.available && reference.origins.includes(args.broker.origin))))
    throw new CodeRefusal("credential_reference_unavailable");
  const gateway = reviewGateway(current);
  const desired = buildCodeServices({ broker: args.broker, classifier: args.classifier, apiKeys: args.apiKeys,
    gateway: gateway.status === "ready" ? gateway.runtime : null });
  // Other native services belong to their own owners; this review never replaces them.
  // An unavailable gateway explicitly removes omp; stale runtime authority is never retained.
  const policies = [...current.configuration.policies.filter(policy => !["broker", "suggest", "omp"].includes(policy.serviceId)), ...desired];
  const validated = ServiceConfigurationSchema.parse({ revision: digestOf(policies), policies });
  return { expectedServiceRevision: args.expectedServiceRevision, policies: validated.policies, gateway,
    reviewDigest: digestOf({ target: { containerId: args.containerId, machineId: args.machineId },
      expectedServiceRevision: args.expectedServiceRevision, policies: validated.policies, gateway }) };
}
export async function configureNativeServices(ctx: CodeContext, args: ActionInput<"configureServices">): Promise<ActionResult<"configureServices">> {
  await authorizeOwner(ctx, args, true);
  const reviewed = await reviewNativeServices(ctx, args);
  if (reviewed.reviewDigest !== args.reviewDigest) throw new CodeRefusal("preview_changed");
  return ServiceConfigurationSchema.parse(await ctx.services.configureConfiguration({ machineId: args.machineId,
    expectedRevision: reviewed.expectedServiceRevision, policies: reviewed.policies }));
}
