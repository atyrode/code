import { ServiceConfigurationReadSchema, ServiceConfigurationSchema, type ServiceConfigurationRead } from "@manifold/protocol";
import type { ActionInput, Target } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./context.ts";
import { buildCodeServices } from "./service-policies.ts";
import { authorizeTarget } from "./state.ts";

async function authorizeServiceConfiguration(ctx: CodeContext, target: Target, write = false): Promise<void> {
  await authorizeTarget(ctx, target, write);
  if (!ctx.auth.isRoot || !await ctx.auth.allows("services:configure", { kind: "machine", machineId: target.machineId }))
    throw new CodeRefusal("service_owner_required");
}

export async function readServiceConfiguration(ctx: CodeContext, target: Target): Promise<ServiceConfigurationRead> {
  await authorizeServiceConfiguration(ctx, target);
  return ServiceConfigurationReadSchema.parse(await ctx.services.readConfiguration({ machineId: target.machineId }));
}

function expectServiceRevision(current: ServiceConfigurationRead, expected: string | null): void {
  if (current.configuration.revision !== expected) throw new CodeRefusal("service_configuration_changed");
}

export async function reviewServices(ctx: CodeContext, args: ActionInput<"reviewServices">) {
  const current = await readServiceConfiguration(ctx, args);
  expectServiceRevision(current, args.expectedServiceRevision);
  const replacements = buildCodeServices({ classifier: args.classifier });
  // Explicit null removes only Code's classifier. All unrelated native policies
  // survive the reviewed CAS, including services owned by the OMP plugin.
  const policies = current.configuration.policies.flatMap(policy => policy.serviceId === "suggest" ? replacements : [policy]);
  if (!current.configuration.policies.some(policy => policy.serviceId === "suggest")) policies.push(...replacements);
  const review = { expectedServiceRevision: args.expectedServiceRevision, policies };
  return { ...review, reviewDigest: digestOf({ target: { containerId: args.containerId, machineId: args.machineId }, ...review }),
    current: digestOf(policies) === digestOf(current.configuration.policies) };
}

export async function configureServices(ctx: CodeContext, args: ActionInput<"configureServices">) {
  await authorizeServiceConfiguration(ctx, args, true);
  const reviewed = await reviewServices(ctx, args);
  if (reviewed.reviewDigest !== args.reviewDigest) throw new CodeRefusal("preview_changed");
  try {
    return ServiceConfigurationSchema.parse(await ctx.services.configureConfiguration({
      machineId: args.machineId, expectedRevision: args.expectedServiceRevision, policies: reviewed.policies,
    }));
  } catch (error) {
    expectServiceRevision(await readServiceConfiguration(ctx, args), args.expectedServiceRevision);
    throw error;
  }
}

/** Invocation-only callers observe the exact native policy, not owner configuration
 * or saved runtime pins. Native invocation independently enforces this same pin. */
export async function currentSuggestionService(ctx: CodeContext, machineId: string, expectedRevision: string) {
  const description = await ctx.services.describe({ machineId });
  if (description.machineId !== machineId) throw new CodeRefusal("resources_changed");
  const service = description.services.find(service => service.serviceId === "suggest");
  if (!description.connected || !service) throw new CodeRefusal("resources_incomplete");
  if (service.revision !== expectedRevision) throw new CodeRefusal("service_configuration_changed");
  const operation = service.operations.find(operation => operation.operationId === "classify");
  if (!operation?.ready || !operation.invocable) throw new CodeRefusal("resources_incomplete");
  return { serviceId: service.serviceId, revision: service.revision, policySha256: service.policySha256 };
}
