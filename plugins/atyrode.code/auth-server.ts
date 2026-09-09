import type { ActionInput, ActionResult } from "./contract.ts";
import { CodeRefusal, type CodeContext } from "./machine-server.ts";
import { brokerOwner, canAdministerBroker, describeSharedBroker, prepareSharedBroker, sharedOmpRuntimes } from "./service-setup.ts";

export async function readAccountSetup(ctx: CodeContext): Promise<ActionResult<"readAccountSetup">> {
  const description = await describeSharedBroker(ctx);
  const owner = brokerOwner(description);
  const available = owner?.online === true && description.connected;
  let reason = description.reason;
  let canSignIn = false;
  if (!owner || !available) reason ??= "The native account broker owner is unavailable.";
  else if (!await canAdministerBroker(ctx, owner.machineId)) reason ??= "Instance account administration requires the native owner’s authority.";
  else if (description.configuration && (!description.configuration.enabled || !["ready", "starting"].includes(description.state)))
    reason ??= "The native account broker is unavailable. Review its instance configuration.";
  else {
    try { await sharedOmpRuntimes(ctx, owner.machineId); canSignIn = true; }
    catch { reason ??= "The owner’s installed OMP sign-in and broker resources are not ready or permitted."; }
  }
  return { revision: description.configuration?.revision ?? null, owner,
    state: !available || description.state === "stopped" ? "unavailable" : description.state,
    canSignIn, reason };
}

export async function prepareSignIn(ctx: CodeContext, args: ActionInput<"prepareSignIn">): Promise<ActionResult<"prepareSignIn">> {
  if (await ctx.outsideScope(args.containerId) || !await ctx.auth.allows("containers:write", { kind: "container", containerId: args.containerId }))
    throw new CodeRefusal("scope_refused");
  // This is an ordinary native terminal handoff. OMP /login writes its local
  // shared store; the independent native instance service owns broker lifetime.
  return prepareSharedBroker(ctx, args.expectedBrokerRevision);
}
