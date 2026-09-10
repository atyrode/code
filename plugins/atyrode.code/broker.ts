import { InstanceServiceDescriptionSchema } from "@manifold/protocol";
import { z } from "zod";
import { projectAccounts } from "../domain/accounts.ts";
import type { AccountReference, AccountsObservation } from "../domain/contracts.ts";
import { normalizeBrokerUsage, projectUsage } from "../domain/usage.ts";
import { BROKER_SERVICE_ID, type SharedBrokerReference } from "./auth-contract.ts";
import { ACCOUNTS_PLUGIN_ID, ServicePinSchema, type Configuration, type ServicePin } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./machine-server.ts";

/** Native describes inherited instance bindings alongside worker-local services. */
export async function currentService(ctx: CodeContext, machineId: string, serviceId: typeof BROKER_SERVICE_ID | "suggest" | "omp", expected?: ServicePin) {
  const description = await ctx.services.describe({ machineId });
  const service = description.services.find(service => service.serviceId === serviceId);
  if (!description.connected || !service) throw new CodeRefusal("resources_incomplete");
  const pin = ServicePinSchema.parse({ serviceId, revision: service.revision, policySha256: service.policySha256 });
  if (expected && digestOf(pin) !== digestOf(expected)) throw new CodeRefusal("resources_changed");
  if (serviceId === BROKER_SERVICE_ID) {
    const shared = await sharedBrokerReference(ctx);
    if (pin.revision !== shared.revision) throw new CodeRefusal("resources_changed");
  }
  return { pin, service };
}
export async function serviceRead(ctx: CodeContext, machineId: string, pin: ServicePin, operationId: string) {
  const response = await ctx.services.read({ machineId, ...pin, operationId, input: {} });
  if (!response.ok) throw new CodeRefusal(response.refusal);
  return response.result;
}
export async function sharedBrokerReference(ctx: CodeContext): Promise<SharedBrokerReference> {
  const description = InstanceServiceDescriptionSchema.parse(await ctx.services.describeInstance({ serviceId: BROKER_SERVICE_ID }));
  if (description.serviceId !== BROKER_SERVICE_ID || description.configuration?.pluginId !== ACCOUNTS_PLUGIN_ID ||
    !description.configuration.enabled || !description.owner?.online || !description.connected || description.state !== "ready")
    throw new CodeRefusal("account_unavailable");
  return { serviceId: BROKER_SERVICE_ID, revision: description.configuration.revision, machineId: description.owner.machineId };
}
async function brokerRead(ctx: CodeContext, reference: SharedBrokerReference, operationId: "metadata" | "usage") {
  const response = await ctx.services.readInstance({ serviceId: reference.serviceId, expectedRevision: reference.revision, operationId, input: {} });
  if (!response.ok) throw new CodeRefusal(response.refusal);
  return response.result;
}
export async function accountObservation(ctx: CodeContext, expected?: SharedBrokerReference): Promise<AccountsObservation> {
  const reference = await sharedBrokerReference(ctx);
  if (expected && digestOf(reference) !== digestOf(expected)) throw new CodeRefusal("resources_changed");
  const metadata = await brokerRead(ctx, reference, "metadata");
  const observedAt = ctx.now();
  return projectAccounts(metadata, digestOf(reference), observedAt, observedAt);
}
export async function usageObservation(ctx: CodeContext, record: Configuration) {
  const reference = await sharedBrokerReference(ctx);
  const accounts = await accountObservation(ctx, reference);
  let raw: unknown = null;
  let refreshStatus: "succeeded" | "failed" = "succeeded";
  try { raw = await brokerRead(ctx, reference, "usage"); }
  catch { refreshStatus = "failed"; }
  const now = ctx.now();
  return projectUsage(normalizeBrokerUsage(raw, accounts, now), accounts, record.accounts, now,
    { maxAgeMs: 5 * 60_000, refreshStatus });
}
export async function mutateCredential(ctx: CodeContext, reference: AccountReference, operationId: "clear-blocks" | "disable") {
  const broker = await sharedBrokerReference(ctx);
  const observation = await accountObservation(ctx, broker);
  const account = observation.accounts.find(account => digestOf(account.reference) === digestOf(reference));
  if (!account) throw new CodeRefusal("account_unavailable");
  const response = await ctx.services.invokeInstance({ serviceId: broker.serviceId, expectedRevision: broker.revision,
    operationId, input: { credentialId: String(account.credentialId) } });
  if (!response.ok) throw new CodeRefusal(response.refusal);
  if (!z.strictObject({ ok: z.literal(true) }).safeParse(response.result).success) throw new CodeRefusal("invalid_service_result");
  return accountObservation(ctx, broker);
}
