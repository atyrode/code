import { CodeRefusal, digestOf, type CodeContext } from "./context.ts";

/*
  A PERSON'S OWN RECORDS: their model checks and standing approval (checks.ts) and whether they have
  seen the panel's tutorial (tutorial.ts). They are keyed by the caller's own principal, so nobody
  reads or writes another person's, and only a person whose sign-in reaches the whole workspace tree
  keeps any: an agent, a service, or a token confined to one container or by an authority ceiling
  keeps none, since these records are the person's, never one container's.
*/

/** Why a caller keeps no records: not a person, or a person whose sign-in reaches less than the whole workspace tree. */
export type Keeper = { person: string } | { refused: "person_required" | "checks_confined" };
/**
 * The caller's records are filed under a digest of their principal, cut to 40 hex characters so a
 * record's key (`checks/<person>/<budget>/<pool>` the longest) stays within the 128 characters plugin
 * storage keys may have; every record also names its principal, which every read compares. Whether
 * the sign-in reaches the workspace root is asked where an unconfined credential is anchored.
 */
export async function keeperOf(ctx: CodeContext): Promise<Keeper> {
  if (ctx.auth.principal.kind !== "human") return { refused: "person_required" };
  if (ctx.auth.containerScope !== null || !(await ctx.auth.allows("containers:read"))) return { refused: "checks_confined" };
  return { person: digestOf({ principalId: ctx.auth.principal.id }).slice(0, 40) };
}
/** The caller's person digest, or null when they keep no records. */
export async function personOf(ctx: CodeContext): Promise<string | null> {
  const keeper = await keeperOf(ctx);
  return "person" in keeper ? keeper.person : null;
}
/** A stored record that names another principal is corruption, never someone's data. */
export function bound<T extends { principalId: string }>(ctx: CodeContext, record: T): T {
  if (record.principalId !== ctx.auth.principal.id) throw new CodeRefusal("invalid_configuration");
  return record;
}
