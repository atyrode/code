/**
 * THE SDK MEMBER THIS PIN DOES NOT SERVE YET.
 *
 * `plugins/MANIFOLD_REV` is c731aa2, which predates manifold#575: the one verb a server
 * handler has onto a plugin its own manifest declares as a dependency, dispatched under the
 * principal of the request the handler is answering (ADR 0041). `GuestActions` and the refusal
 * vocabulary below are copied from that branch — `packages/plugin-kit/src/server.ts` and
 * `packages/protocol/src/plugin.ts` at c4c7947, PR #576's head — so Code's doors are written
 * against the shape the hub will serve, and a hub without it refuses by name.
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
  "dependency_unavailable", "unknown_action", "caller_ceiling", "capability", "refused"] as const;

/**
 * One door of one declared dependency. A refusal is a REJECTION, never a value: a callee
 * handler's own `{ refused }` is settled as the `refused` class and thrown at this edge, so a
 * resolved reply is always that door's published result.
 *
 * The refusal a caller gets keeps both facts it can act on: the callee's name and the host's
 * class, so `atyrode.omp.accounts` being off reads
 * `code_omp_accounts_dependency_unavailable`. Only the vendor label every plugin here shares
 * is dropped, as each refusal vocabulary drops it.
 *
 * `refusals` is the callee's OWN refusal grammar, and it is what lets its word survive the
 * edge: a `refused` sentence ends in the callee's token, and a token that grammar admits is
 * re-raised whole — `omp_review_changed` reads `code_omp_review_changed`. Anything else in
 * those parentheses is the host's account of a door that broke or was called wrong (`failed`,
 * `invalid_args: …`), which is the edge's word and not the callee's.
 */
export async function dependencyCall(ctx: DependencyContext, args: {
  plugin: string; action: string; input: unknown; refusals?: (detail: string) => boolean;
}): Promise<unknown> {
  // manifold#575 is what serves this member. Without it there is no in-process door call to
  // make, so the answer is the hub's age rather than a composition Code could correct.
  if (typeof ctx.actions?.call !== "function") throw new CodeRefusal("hub_too_old");
  try {
    return await ctx.actions.call({ plugin: args.plugin, action: args.action, input: args.input });
  } catch (error) {
    // The host's sentence is `${class}: ${caller} -> ${door} (${detail})`; an unrecognized one
    // is still a refusal.
    const message = error instanceof Error ? error.message : "";
    const refused = callRefusals.find(name => message === name || message.startsWith(`${name}: `)) ?? "refused";
    const detail = refused === "refused" ? /\(([^()]*)\)$/.exec(message)?.[1] : undefined;
    if (detail !== undefined && args.refusals?.(detail) === true) throw new CodeRefusal(detail);
    throw new CodeRefusal(`${args.plugin.replace(/^atyrode\./, "").replace(/\./g, "_")}_${refused}`);
  }
}
