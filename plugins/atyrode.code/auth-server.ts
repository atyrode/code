import type { ActionInput, ActionResult } from "./contract.ts";
import { describeSharedBroker } from "./broker.ts";
import { CodeRefusal, type CodeContext } from "./machine-server.ts";
import { brokerOwner, canAdministerBroker, inspectSharedBrokerRuntime, matchesSharedBrokerPolicy,
  prepareSharedBroker, promoteSharedBrokerRuntime, reviewSharedBrokerRuntime, sharedOmpRuntimes } from "./service-setup.ts";
import { accountOperationRequirements, callerRequirementRefusal } from "./operation-readiness.ts";

export async function readAccountSetup(ctx: CodeContext): Promise<ActionResult<"readAccountSetup">> {
  let description = await describeSharedBroker(ctx);
  const owner = brokerOwner(description);
  const available = owner?.online === true && description.connected;
  let reason = description.reason;
  let requirement: string | null = null;
  let canSignIn = false;
  let canUpdateRuntime = false;
  let nativeReady = false;
  let callerRefusal: string | null = null;
  if (!owner || !available) reason ??= "The native account broker owner is unavailable.";
  else if (!await canAdministerBroker(ctx, owner.machineId)) reason ??= "Instance account administration requires the native owner’s authority.";
  else if (description.configuration && !description.configuration.enabled)
    reason ??= "The native account broker is disabled. Review its instance configuration.";
  else if (description.reason === "machine_draining")
    reason = "The account owner is in maintenance. Sign-in remains unavailable until native admission reopens.";
  else {
    try {
      if (description.configuration) {
        const current = await inspectSharedBrokerRuntime(ctx, description.configuration.revision);
        description = current.description;
        reason = description.reason;
        canUpdateRuntime = !matchesSharedBrokerPolicy(current.currentPolicy, current.policy) ||
          ["stopped", "unavailable"].includes(current.description.state);
        canSignIn = !canUpdateRuntime && ["ready", "starting"].includes(current.description.state);
        if (canUpdateRuntime) requirement = "Review the shared broker runtime before starting or restoring it.";
        else if (!canSignIn) requirement = "The native account broker is unavailable. Review its instance configuration.";
      } else {
        await sharedOmpRuntimes(ctx, owner.machineId);
        canSignIn = true;
      }
      callerRefusal = await callerRequirementRefusal(ctx.auth, [
        ...accountOperationRequirements(owner.machineId, "broker"), ...accountOperationRequirements(owner.machineId, "sign-in"),
      ]);
      nativeReady = callerRefusal === null;
      if (callerRefusal) { canSignIn = false; canUpdateRuntime = false; }
    } catch (error) {
      if (error instanceof CodeRefusal && error.code === "native_consent_required")
        requirement = "Native permissions for the account broker and OMP sign-in are not approved. Review OMP setup before continuing.";
      else if (error instanceof CodeRefusal && error.code === "installation_disabled")
        requirement = "The owner’s native OMP installation is disabled (installation_disabled). Restore that existing installation before reviewing account-runtime recovery.";
      else requirement = `The owner’s installed OMP sign-in and broker resources are not ready or permitted${error instanceof CodeRefusal ? ` (${error.code})` : ""}.`;
    }
  }
  // A previous job's terminal reason is history, not the current recovery prerequisite.
  if (requirement) reason = reason ? `${requirement} Broker status: ${reason}.` : requirement;
  return { revision: description.configuration?.revision ?? null, owner,
    state: !available || description.configuration?.enabled === false || description.state === "stopped" || description.state === "stopping" ? "unavailable" : description.state,
    canSignIn, canUpdateRuntime, nativeReady, callerRefusal, reason };
}

async function authorizeAccountContainer(ctx: CodeContext, containerId: string): Promise<void> {
  if (await ctx.outsideScope(containerId) || !await ctx.auth.allows("containers:write", { kind: "container", containerId }))
    throw new CodeRefusal("scope_refused");
}

export async function reviewAccountRuntime(ctx: CodeContext, args: ActionInput<"reviewAccountRuntime">): Promise<ActionResult<"reviewAccountRuntime">> {
  return reviewSharedBrokerRuntime(ctx, args.expectedBrokerRevision);
}

export async function promoteAccountRuntime(ctx: CodeContext, args: ActionInput<"promoteAccountRuntime">): Promise<ActionResult<"promoteAccountRuntime">> {
  await authorizeAccountContainer(ctx, args.containerId);
  return promoteSharedBrokerRuntime(ctx, args);
}

export async function prepareSignIn(ctx: CodeContext, args: ActionInput<"prepareSignIn">): Promise<ActionResult<"prepareSignIn">> {
  await authorizeAccountContainer(ctx, args.containerId);
  // This is an ordinary native terminal handoff. OMP /login writes its local
  // shared store; the independent native instance service owns broker lifetime.
  return prepareSharedBroker(ctx, args.expectedBrokerRevision);
}
