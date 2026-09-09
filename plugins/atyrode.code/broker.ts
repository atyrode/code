import { z } from "zod";
import { projectAccounts } from "../domain/accounts.ts";
import type { AccountReference, AccountsObservation } from "../domain/contracts.ts";
import { normalizeBrokerUsage, projectUsage } from "../domain/usage.ts";
import { ServicePinSchema, type ActionInput, type Configuration, type ServicePin } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./machine-server.ts";
import { authorizeTarget } from "./state.ts";

export async function currentService(ctx: CodeContext, machineId: string, serviceId: string, expected?: ServicePin) {
  const description = await ctx.services.describe({ machineId });
  const service = description.services.find(service => service.serviceId === serviceId);
  if (!description.connected || !service) throw new CodeRefusal("resources_incomplete");
  const pin = ServicePinSchema.parse({ serviceId, revision: service.revision, policySha256: service.policySha256 });
  if (expected && digestOf(pin) !== digestOf(expected)) throw new CodeRefusal("resources_changed");
  return { pin, service };
}
export async function serviceRead(ctx: CodeContext, machineId: string, pin: ServicePin, operationId: string) {
  const response = await ctx.services.read({ machineId, ...pin, operationId, input: {} });
  if (!response.ok) throw new CodeRefusal(response.refusal);
  return response.result;
}
export async function accountObservation(ctx: CodeContext, machineId: string, expected?: ServicePin): Promise<AccountsObservation> {
  const { pin, service } = await currentService(ctx, machineId, "broker", expected);
  if (!service.operations.some(operation => operation.operationId === "metadata" && operation.readable && operation.ready)) throw new CodeRefusal("account_unavailable");
  const raw = await serviceRead(ctx, machineId, pin, "metadata");
  const observedAt = ctx.now();
  return projectAccounts(raw, digestOf({ machineId, ...pin }), observedAt, observedAt);
}
export async function usageObservation(ctx: CodeContext, record: Configuration) {
  const { pin } = await currentService(ctx, record.machineId, "broker");
  const accounts = await accountObservation(ctx, record.machineId, pin);
  let raw: unknown = null;
  let refreshStatus: "succeeded" | "failed" = "succeeded";
  try { raw = await serviceRead(ctx, record.machineId, pin, "usage"); }
  catch { refreshStatus = "failed"; }
  const now = ctx.now();
  return projectUsage(normalizeBrokerUsage(raw, accounts, now), accounts, record.accounts, now,
    { maxAgeMs: 5 * 60_000, refreshStatus });
}
export async function mutateCredential(ctx: CodeContext, machineId: string, reference: AccountReference, operationId: "clear-blocks" | "disable") {
  const { pin } = await currentService(ctx, machineId, "broker");
  const observation = await accountObservation(ctx, machineId, pin);
  const account = observation.accounts.find(account => digestOf(account.reference) === digestOf(reference));
  if (!account) throw new CodeRefusal("account_unavailable");
  const response = await ctx.services.invoke({ machineId, ...pin, operationId, input: { credentialId: String(account.credentialId) } });
  if (!response.ok) throw new CodeRefusal(response.refusal);
  if (!z.strictObject({ ok: z.literal(true) }).safeParse(response.result).success) throw new CodeRefusal("invalid_service_result");
  return accountObservation(ctx, machineId, pin);
}

export async function enrollApiKey(ctx: CodeContext, args: ActionInput<"enrollApiKey">): Promise<AccountsObservation> {
  await authorizeTarget(ctx, args, true);
  const { pin, service } = await currentService(ctx, args.machineId, "broker");
  const operationId = `enroll-key-${args.provider}`;
  const operation = service.operations.find(candidate => candidate.operationId === operationId);
  if (!operation?.invocable || !operation.ready) throw new CodeRefusal("api_key_enrollment_unavailable");
  // Only the root-installed native policy selects the source and provider. This
  // action cannot accept a credential, a source override, or a transport parameter.
  const response = await ctx.services.invoke({ machineId: args.machineId, ...pin, operationId, input: {} });
  if (!response.ok) throw new CodeRefusal(response.refusal);
  const result = z.strictObject({ entries: z.array(z.strictObject({
    id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    provider: z.literal(args.provider), identityKey: z.string().max(2048).nullable(),
  })).min(1).max(1024) }).safeParse(response.result);
  if (!result.success) throw new CodeRefusal("invalid_service_result");
  return accountObservation(ctx, args.machineId, pin);
}
