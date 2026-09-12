import { InstanceServiceDescriptionSchema, JobDescriptionSchema, ServiceConfigurationReadSchema, ServiceConfigurationSchema,
  ServiceRuntimeSchema, TerminalRuntimeSchema, type InstanceServiceDescription, type ServiceConfigurationRead, type ServicePolicy } from "@manifold/protocol";
import { BROKER_OPERATION_ID, BROKER_SERVICE_ID, SIGN_IN_OPERATION_ID } from "./auth-contract.ts";
import { describeSharedBroker } from "./broker.ts";
import { ACCOUNTS_PLUGIN_ID, GATEWAY_OPERATION_ID, GATEWAY_PLUGIN_ID, type ActionInput, type Target } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./machine-server.ts";
import { buildCodeServices, buildSharedBrokerPolicy } from "./service-policies.ts";
import { authorizeTarget } from "./state.ts";
import { accountOperationRefusal } from "./operation-readiness.ts";

const signInConfig = JSON.stringify({ startup: { setupWizard: false } });

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
  const candidates = current.runtimeCandidates.filter(candidate => candidate.runtime.pluginId === GATEWAY_PLUGIN_ID &&
    candidate.runtime.operationId === GATEWAY_OPERATION_ID && candidate.runtime.scope !== "instance");
  const candidate = candidates[0];
  if (!current.connected || candidates.length !== 1 || !candidate?.ready)
    throw new CodeRefusal("resources_incomplete");
  const runtime = candidate.runtime;
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
  return { ...review, reviewDigest: digestOf({ target: { containerId: args.containerId, machineId: args.machineId }, ...review }),
    current: digestOf(policies) === digestOf(current.configuration.policies) };
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
export async function sharedOmpRuntimes(ctx: CodeContext, machineId: string, clientAccess = "{}") {
  const description = JobDescriptionSchema.parse(await ctx.jobs.describe({ machineId, pluginId: ACCOUNTS_PLUGIN_ID }));
  const refusal = accountOperationRefusal(description, machineId, "broker") ?? accountOperationRefusal(description, machineId, "sign-in");
  if (refusal !== null) throw new CodeRefusal(refusal);
  const installation = description.installation!;
  const broker = description.operations![BROKER_OPERATION_ID]!;
  const signIn = description.operations![SIGN_IN_OPERATION_ID]!;
  const pins = { installationRevision: installation.revision, artifactSha256: installation.artifactSha256 };
  return {
    broker: ServiceRuntimeSchema.parse({ scope: "instance", pluginId: ACCOUNTS_PLUGIN_ID, operationId: BROKER_OPERATION_ID,
      ...pins, resourceBindingDigest: broker.resourceBindingDigest, input: { clientAccess: { literal: clientAccess } } }),
    signIn: TerminalRuntimeSchema.parse({ pluginId: ACCOUNTS_PLUGIN_ID, operationId: SIGN_IN_OPERATION_ID,
      ...pins, resourceBindingDigest: signIn.resourceBindingDigest, input: { config: signInConfig } }),
  };
}

export function matchesSharedBrokerPolicy(current: ServicePolicy | null, policy: ServicePolicy): boolean {
  // The native registry revision is not the policy builder's initial revision.
  return current !== null && digestOf({ ...current, revision: policy.revision }) === digestOf(policy);
}

function brokerClientAccess(policy: ServicePolicy | null): string {
  const value = policy?.runtime?.input.clientAccess;
  if (value === undefined) return "{}";
  if (!("literal" in value) || typeof value.literal !== "string")
    throw new CodeRefusal("resources_changed");
  return value.literal;
}

function requireExistingBroker(description: InstanceServiceDescription, expectedRevision: string, machineId?: string) {
  expectBrokerRevision(description, expectedRevision);
  if (description.serviceId !== BROKER_SERVICE_ID || description.configuration?.pluginId !== ACCOUNTS_PLUGIN_ID)
    throw new CodeRefusal("resources_changed");
  const owner = brokerOwner(description);
  if (!owner?.online || !description.connected) throw new CodeRefusal("account_owner_unavailable");
  if (machineId !== undefined && owner.machineId !== machineId) throw new CodeRefusal("resources_changed");
  if (!description.configuration.enabled) throw new CodeRefusal("broker_unavailable");
  return owner;
}

/** Read-only inspection of an existing broker on its declared owner. An enabled
 * stale runtime may be stopped; its replacement still requires native readiness. */
export async function inspectSharedBrokerRuntime(ctx: CodeContext, expectedRevision: string) {
  const description = await describeSharedBroker(ctx);
  const owner = requireExistingBroker(description, expectedRevision);
  if (!await canAdministerBroker(ctx, owner.machineId)) throw new CodeRefusal("service_owner_required");
  const current = await ctx.services.readInstanceConfiguration({ serviceId: BROKER_SERVICE_ID });
  requireExistingBroker(current.description, expectedRevision, owner.machineId);
  if (!current.policy) throw new CodeRefusal("resources_changed");
  const runtimes = await sharedOmpRuntimes(ctx, owner.machineId, brokerClientAccess(current.policy));
  const policy = buildSharedBrokerPolicy(runtimes.broker);
  const latest = await describeSharedBroker(ctx);
  requireExistingBroker(latest, expectedRevision, owner.machineId);
  return { description: latest, owner, currentPolicy: current.policy, runtimes, policy };
}

export async function reviewSharedBrokerRuntime(ctx: CodeContext, expectedRevision: string | null) {
  if (expectedRevision === null) {
    const description = await describeSharedBroker(ctx);
    expectBrokerRevision(description, null);
    const owner = brokerOwner(description);
    if (!owner?.online || !description.connected) throw new CodeRefusal("account_owner_unavailable");
    if (!await canAdministerBroker(ctx, owner.machineId)) throw new CodeRefusal("service_owner_required");
    const runtimes = await sharedOmpRuntimes(ctx, owner.machineId);
    const policy = buildSharedBrokerPolicy(runtimes.broker);
    return { expectedBrokerRevision: null, owner, policy, current: false,
      reviewDigest: digestOf({ ownerMachineId: owner.machineId, expectedBrokerRevision: null, currentPolicy: null, policy, runtimes }) };
  }
  const { description, owner, currentPolicy, runtimes, policy: installedPolicy } = await inspectSharedBrokerRuntime(ctx, expectedRevision);
  // Native treats an identical enabled configuration as a no-op. A reviewed
  // recovery needs a fresh policy revision without an intermediate disabled state.
  const recovering = ["stopped", "unavailable"].includes(description.state) && matchesSharedBrokerPolicy(currentPolicy, installedPolicy);
  const policy = recovering ? { ...installedPolicy, revision: digestOf({ expectedRevision, policy: installedPolicy }) } : installedPolicy;
  const review = { expectedBrokerRevision: expectedRevision, owner, policy };
  // Bind both operations: a sign-in-only resource change also invalidates consent.
  return { ...review, current: !recovering && matchesSharedBrokerPolicy(currentPolicy, policy) && ["ready", "starting"].includes(description.state),
    reviewDigest: digestOf({ ownerMachineId: owner.machineId,
    expectedBrokerRevision: expectedRevision, currentPolicy, policy, runtimes }) };
}

export async function promoteSharedBrokerRuntime(ctx: CodeContext, args: ActionInput<"promoteAccountRuntime">) {
  const reviewed = await reviewSharedBrokerRuntime(ctx, args.expectedBrokerRevision);
  if (reviewed.reviewDigest !== args.reviewDigest) throw new CodeRefusal("preview_changed");
  const latest = await reviewSharedBrokerRuntime(ctx, args.expectedBrokerRevision);
  if (latest.reviewDigest !== reviewed.reviewDigest) throw new CodeRefusal("resources_changed");
  await authorizeServiceConfiguration(ctx, { containerId: args.containerId, machineId: latest.owner.machineId }, true);
  const before = await describeSharedBroker(ctx);
  expectBrokerRevision(before, args.expectedBrokerRevision);
  const owner = brokerOwner(before);
  if (owner?.machineId !== latest.owner.machineId || !owner.online || !before.connected)
    throw new CodeRefusal("account_owner_unavailable");
  if (args.expectedBrokerRevision !== null) requireExistingBroker(before, args.expectedBrokerRevision, latest.owner.machineId);
  let configured: InstanceServiceDescription;
  try {
    // Native CAS protects registry/owner changes, but does not atomically compare
    // installation/resource pins with this write. Reobserve those above.
    configured = InstanceServiceDescriptionSchema.parse(await ctx.services.configureInstance({
      serviceId: BROKER_SERVICE_ID, machineId: latest.owner.machineId, expectedRevision: args.expectedBrokerRevision,
      policy: latest.policy, enabled: true,
    }));
  } catch (error) {
    expectBrokerRevision(await describeSharedBroker(ctx), args.expectedBrokerRevision);
    throw error;
  }
  if (configured.serviceId !== BROKER_SERVICE_ID || configured.configuration?.pluginId !== ACCOUNTS_PLUGIN_ID ||
    !configured.configuration.enabled || configured.owner?.machineId !== latest.owner.machineId)
    throw new CodeRefusal("resources_changed");
  // Registry acceptance is not runtime readiness; the normal read path observes it.
  return { revision: configured.configuration.revision };
}

export async function prepareSharedBroker(ctx: CodeContext, expectedRevision: string | null) {
  let description = await describeSharedBroker(ctx);
  expectBrokerRevision(description, expectedRevision);
  const owner = brokerOwner(description);
  if (!owner?.online || !description.connected) throw new CodeRefusal("account_owner_unavailable");
  if (!await canAdministerBroker(ctx, owner.machineId)) throw new CodeRefusal("service_owner_required");
  let currentPolicy: ServicePolicy | null = null;
  if (description.configuration) {
    if (!description.configuration.enabled || !["ready", "starting"].includes(description.state))
      throw new CodeRefusal("broker_unavailable");
    const current = await ctx.services.readInstanceConfiguration({ serviceId: BROKER_SERVICE_ID });
    expectBrokerRevision(current.description, expectedRevision);
    currentPolicy = current.policy;
  }
  const clientAccess = brokerClientAccess(currentPolicy);
  const runtimes = await sharedOmpRuntimes(ctx, owner.machineId, clientAccess);
  const policy = buildSharedBrokerPolicy(runtimes.broker);
  if (description.configuration) {
    if (!matchesSharedBrokerPolicy(currentPolicy, policy))
      throw new CodeRefusal("resources_changed");
  } else {
    const latest = await sharedOmpRuntimes(ctx, owner.machineId, clientAccess);
    if (digestOf(latest) !== digestOf(runtimes)) throw new CodeRefusal("resources_changed");
    const current = await describeSharedBroker(ctx);
    expectBrokerRevision(current, expectedRevision);
    const currentOwner = brokerOwner(current);
    if (currentOwner?.machineId !== owner.machineId || !currentOwner.online || !current.connected)
      throw new CodeRefusal("account_owner_unavailable");
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
  const latest = await sharedOmpRuntimes(ctx, owner.machineId, clientAccess);
  if (digestOf(latest) !== digestOf(runtimes)) throw new CodeRefusal("resources_changed");
  const revision = description.configuration!.revision;
  const current = await describeSharedBroker(ctx);
  expectBrokerRevision(current, revision);
  if (current.owner?.machineId !== owner.machineId || !current.owner.online || !current.connected ||
    !current.configuration?.enabled || !["ready", "starting"].includes(current.state)) throw new CodeRefusal("broker_unavailable");
  return { machineId: owner.machineId, runtime: runtimes.signIn };
}
