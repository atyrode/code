import { InstanceServiceDescriptionSchema, ServiceConfigurationReadSchema, ServiceConfigurationSchema,
  ServiceRuntimeSchema, TerminalRuntimeSchema, type InstanceServiceDescription, type ServiceConfigurationRead } from "@manifold/protocol";
import { BROKER_OPERATION_ID, BROKER_SERVICE_ID, SIGN_IN_OPERATION_ID } from "./auth-contract.ts";
import { ACCOUNTS_PLUGIN_ID, GATEWAY_OPERATION_ID, GATEWAY_PLUGIN_ID, type ActionInput, type Target } from "./contract.ts";
import { CodeRefusal, currentResources, digestOf, type CodeContext } from "./machine-server.ts";
import { buildCodeServices, buildSharedBrokerPolicy } from "./service-policies.ts";
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
  const { description, installation } = await currentResources(ctx, args.machineId, GATEWAY_PLUGIN_ID);
  const operation = description.operations?.[GATEWAY_OPERATION_ID];
  const candidates = current.runtimeCandidates.filter(candidate => candidate.runtime.pluginId === GATEWAY_PLUGIN_ID &&
    candidate.runtime.operationId === GATEWAY_OPERATION_ID && candidate.runtime.scope !== "instance");
  const candidate = candidates[0];
  if (!current.connected || candidates.length !== 1 || !candidate?.ready || !operation?.ready)
    throw new CodeRefusal("resources_incomplete");
  const runtime = candidate.runtime;
  if (runtime.installationRevision !== installation.revision || runtime.artifactSha256 !== installation.artifactSha256 ||
    runtime.resourceBindingDigest !== operation.resourceBindingDigest) throw new CodeRefusal("resources_changed");
  const gateway = ServiceRuntimeSchema.parse({ ...runtime, input: { accountPool: { input: "accountPool" } } });
  const replacements = buildCodeServices({ classifier: args.classifier ?? null, gateway });
  // Only Code's execution services are replaced. In particular, omission is not
  // permission to remove an existing classifier or any machine broker policy.
  const policies = current.configuration.policies.flatMap(policy => {
    const replacement = replacements.find(value => value.serviceId === policy.serviceId);
    if (replacement) return [replacement];
    return policy.serviceId === "suggest" && args.classifier === null ? [] : [policy];
  });
  for (const policy of replacements) {
    if (!policies.some(value => value.serviceId === policy.serviceId)) policies.push(policy);
  }
  const review = { expectedServiceRevision: args.expectedServiceRevision, policies };
  return { ...review, reviewDigest: digestOf({ target: { containerId: args.containerId, machineId: args.machineId }, ...review }) };
}

export async function configureServices(ctx: CodeContext, args: ActionInput<"configureServices">) {
  await authorizeServiceConfiguration(ctx, args, true);
  const reviewed = await reviewServices(ctx, args);
  if (reviewed.reviewDigest !== args.reviewDigest) throw new CodeRefusal("preview_changed");
  // Native CAS owns configuration races. Reobserve the candidate and installed
  // resource pins as well: the native write does not compare those revisions.
  await authorizeServiceConfiguration(ctx, args, true);
  const latest = await reviewServices(ctx, args);
  if (latest.reviewDigest !== reviewed.reviewDigest) throw new CodeRefusal("resources_changed");
  try {
    return ServiceConfigurationSchema.parse(await ctx.services.configureConfiguration({
      machineId: args.machineId, expectedRevision: args.expectedServiceRevision, policies: latest.policies,
    }));
  } catch (error) {
    expectServiceRevision(await readServiceConfiguration(ctx, args), args.expectedServiceRevision);
    throw error;
  }
}

export async function describeSharedBroker(ctx: CodeContext): Promise<InstanceServiceDescription> {
  const description = InstanceServiceDescriptionSchema.parse(await ctx.services.describeInstance({ serviceId: BROKER_SERVICE_ID }));
  if (description.serviceId !== BROKER_SERVICE_ID ||
    (description.configuration && description.configuration.pluginId !== ACCOUNTS_PLUGIN_ID)) throw new CodeRefusal("resources_changed");
  return description;
}
export function brokerOwner(description: InstanceServiceDescription) {
  return description.configuration ? description.owner : description.defaultOwner;
}
export function expectBrokerRevision(description: InstanceServiceDescription, expected: string | null): void {
  if ((description.configuration?.revision ?? null) !== expected) throw new CodeRefusal("broker_revision_changed");
}
export async function canAdministerBroker(ctx: CodeContext, machineId: string): Promise<boolean> {
  return ctx.auth.isRoot && await ctx.auth.allows("services:configure", { kind: "machine", machineId });
}

/** One native description pins both installed operations and their promoted resource
 * bindings. The installed artifact declares their common owner-local OMP home. */
export async function sharedOmpRuntimes(ctx: CodeContext, machineId: string) {
  const { description, installation } = await currentResources(ctx, machineId, ACCOUNTS_PLUGIN_ID);
  const broker = description.operations?.[BROKER_OPERATION_ID];
  const signIn = description.operations?.[SIGN_IN_OPERATION_ID];
  if (!broker?.ready || !signIn?.ready) throw new CodeRefusal("resources_incomplete");
  const pins = { installationRevision: installation.revision, artifactSha256: installation.artifactSha256 };
  return {
    broker: ServiceRuntimeSchema.parse({ scope: "instance", pluginId: ACCOUNTS_PLUGIN_ID, operationId: BROKER_OPERATION_ID,
      ...pins, resourceBindingDigest: broker.resourceBindingDigest, input: {} }),
    signIn: TerminalRuntimeSchema.parse({ pluginId: ACCOUNTS_PLUGIN_ID, operationId: SIGN_IN_OPERATION_ID,
      ...pins, resourceBindingDigest: signIn.resourceBindingDigest, input: {} }),
  };
}

export async function prepareSharedBroker(ctx: CodeContext, expectedRevision: string | null) {
  let description = await describeSharedBroker(ctx);
  expectBrokerRevision(description, expectedRevision);
  const owner = brokerOwner(description);
  if (!owner?.online || !description.connected) throw new CodeRefusal("account_owner_unavailable");
  if (!await canAdministerBroker(ctx, owner.machineId)) throw new CodeRefusal("service_owner_required");
  const runtimes = await sharedOmpRuntimes(ctx, owner.machineId);
  const policy = buildSharedBrokerPolicy(runtimes.broker);
  if (description.configuration) {
    if (!description.configuration.enabled || !["ready", "starting"].includes(description.state))
      throw new CodeRefusal("account_unavailable");
    const current = await ctx.services.readInstanceConfiguration({ serviceId: BROKER_SERVICE_ID });
    expectBrokerRevision(current.description, expectedRevision);
    // Registry revisions are opaque and native-owned. Compare the policy contract
    // without mistaking that registry identity for the builder's initial revision.
    if (!current.policy || digestOf({ ...current.policy, revision: policy.revision }) !== digestOf(policy))
      throw new CodeRefusal("resources_changed");
  } else {
    try {
      description = InstanceServiceDescriptionSchema.parse(await ctx.services.configureInstance({ serviceId: BROKER_SERVICE_ID,
        expectedRevision, machineId: owner.machineId, policy, enabled: true }));
    } catch (error) {
      // A concurrent first setup is a conflict, never permission to adopt the winner.
      expectBrokerRevision(await describeSharedBroker(ctx), expectedRevision);
      throw error;
    }
    if (description.serviceId !== BROKER_SERVICE_ID || description.configuration?.pluginId !== ACCOUNTS_PLUGIN_ID ||
      !description.configuration.enabled || description.owner?.machineId !== owner.machineId)
      throw new CodeRefusal("resources_changed");
  }
  const latest = await sharedOmpRuntimes(ctx, owner.machineId);
  if (digestOf(latest) !== digestOf(runtimes)) throw new CodeRefusal("resources_changed");
  const revision = description.configuration!.revision;
  const current = await describeSharedBroker(ctx);
  expectBrokerRevision(current, revision);
  if (current.owner?.machineId !== owner.machineId || !current.owner.online || !current.connected ||
    !current.configuration?.enabled || !["ready", "starting"].includes(current.state)) throw new CodeRefusal("account_unavailable");
  return { machineId: owner.machineId, runtime: runtimes.signIn };
}
