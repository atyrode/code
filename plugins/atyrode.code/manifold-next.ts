/**
 * THE SDK MEMBER THIS PIN DOES NOT SERVE YET.
 *
 * `plugins/MANIFOLD_REV` is c731aa2, which predates manifold#575: the one verb a server
 * handler has onto a plugin its own manifest declares as a dependency, dispatched under the
 * principal of the request the handler is answering (ADR 0041). `GuestActions` and the refusal
 * vocabulary below are copied from that branch — `packages/plugin-kit/src/server.ts` and
 * `packages/protocol/src/plugin.ts` at fadda133 — so Code's doors are written against the
 * shape the hub will serve rather than against a guess, and a hub without it refuses by name.
 *
 * Delete this file when `MANIFOLD_REV` moves to a main commit carrying manifold#575: the ctx
 * narrows to `GuestCtx` again, `ctx.actions.call` is always there, and `code_hub_too_old` has
 * nothing left to refuse.
 */
import { CodeRefusal } from "./context.ts";

/** Copied from manifold#575 `packages/plugin-kit/src/server.ts`. */
export interface GuestActions {
  call(args: { plugin: string; action: string; input: unknown }): Promise<unknown>;
}
/** What a handler needs of its ctx to reach a dependency; absent on a hub without #575. */
export type DependencyContext = { readonly actions?: GuestActions | undefined };
/** manifold#575 `ACTION_CALL_REFUSALS`, in the order the host walks them. */
const callRefusals = ["dispatch_cycle", "dispatch_depth", "undeclared_dependency",
  "dependency_unavailable", "unknown_action", "capability", "refused"] as const;

/**
 * One door of one declared dependency. The reply is whatever that door answered — including
 * its own `{ refused }`, which is an answer and not a rejection — so the caller parses it
 * against the callee's published schema.
 *
 * A host refusal keeps both facts a caller can act on: the callee's name and the host's class,
 * so `atyrode.omp.accounts` being off reads `code_omp_accounts_dependency_unavailable`. Only
 * the vendor label every plugin here shares is dropped, as each refusal vocabulary drops it.
 */
export async function dependencyCall(ctx: DependencyContext,
  args: { plugin: string; action: string; input: unknown }): Promise<unknown> {
  // manifold#575 is what serves this member. Without it there is no in-process door call to
  // make, so the answer is the hub's age rather than a composition Code could correct.
  if (typeof ctx.actions?.call !== "function") throw new CodeRefusal("hub_too_old");
  try {
    return await ctx.actions.call({ plugin: args.plugin, action: args.action, input: args.input });
  } catch (error) {
    // The host's sentence is `${class}: ${offenders}`; an unrecognized one is still a refusal.
    const message = error instanceof Error ? error.message : "";
    const refused = callRefusals.find(name => message === name || message.startsWith(`${name}: `)) ?? "refused";
    throw new CodeRefusal(`${args.plugin.replace(/^atyrode\./, "").replace(/\./g, "_")}_${refused}`);
  }
}
