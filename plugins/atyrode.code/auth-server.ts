import type { ActionInput, ActionResult } from "./contract.ts";
import { CodeRefusal, type CodeContext } from "./machine-server.ts";
import { brokerOwner, canAdministerBroker, describeSharedBroker, inspectSharedBrokerRuntime, matchesSharedBrokerPolicy,
  prepareSharedBroker, promoteSharedBrokerRuntime, reviewSharedBrokerRuntime, sharedOmpRuntimes } from "./service-setup.ts";

export async function readAccountSetup(ctx: CodeContext): Promise<ActionResult<"readAccountSetup">> {
  let description = await describeSharedBroker(ctx);
  const owner = brokerOwner(description);
  const available = owner?.online === true && description.connected;
  let reason = description.reason;
  let canSignIn = false;
  let canUpdateRuntime = false;
  if (!owner || !available) reason ??= "The native account broker owner is unavailable.";
  else if (!await canAdministerBroker(ctx, owner.machineId)) reason ??= "Instance account administration requires the native owner’s authority.";
  else if (description.configuration && !description.configuration.enabled)
    reason ??= "The native account broker is disabled. Review its instance configuration.";
  else {
    try {
      if (description.configuration) {
        const current = await inspectSharedBrokerRuntime(ctx, description.configuration.revision);
        description = current.description;
        canUpdateRuntime = !matchesSharedBrokerPolicy(current.currentPolicy, current.policy) ||
          ["stopped", "unavailable"].includes(current.description.state);
        canSignIn = !canUpdateRuntime && ["ready", "starting"].includes(current.description.state);
        if (canUpdateRuntime) reason ??= "Review the shared broker runtime before starting or restoring it.";
        else if (!canSignIn) reason ??= "The native account broker is unavailable. Review its instance configuration.";
      } else {
        await sharedOmpRuntimes(ctx, owner.machineId);
        canSignIn = true;
      }
    } catch { reason ??= "The owner’s installed OMP sign-in and broker resources are not ready or permitted."; }
  }
  return { revision: description.configuration?.revision ?? null, owner,
    state: !available || description.configuration?.enabled === false || description.state === "stopped" ? "unavailable" : description.state,
    canSignIn, canUpdateRuntime, reason };
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
