import { z } from "zod";
import { epochMilliseconds, probeAddress } from "@atyrode/manifold-omp";
import { selectedAccountPool } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { CatalogDocumentSchema, DomainError, SelectionSchema, type CatalogDocument, type Selection } from "../domain/contracts.ts";
import { clampSelection } from "../domain/routing.ts";
import { ChecksSchema, MAX_CHECKS, VerificationProvenanceSchema, digest, id, revision, type ActionInput, type Checks,
  type Configuration, type ModelCheck, type VerificationProvenance } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./context.ts";
import { commitConfiguration, expectRevision, poolIdentity, readConfiguration, requireConfiguration } from "./state.ts";

/*
  A PERSON'S MODEL CHECKS. Which models answer through an account pool is a fact about those
  accounts, not about the workspace a check happened to run in, so a list a verification stages is
  also kept for the person who checked it, under the exact pool it was verified with and the budget
  it was derived under, and any workspace whose saved choices select that pool adopts it instead of
  spending another check. The person's standing approval of what checks spend lives beside them.
  Both are keyed by the caller's own principal: nobody reads or writes another person's, and an
  agent, a service or a token confined to one container keeps none. Workspaces keep their own
  copies, so a `runSession` caller still reads a workspace.
*/

type Budget = Selection["budget"];
const StoredCheckSchema = z.strictObject({
  schemaVersion: z.literal(1), principalId: id, poolIdentityDigest: digest, budget: SelectionSchema.shape.budget,
  document: CatalogDocumentSchema, digest, provenance: VerificationProvenanceSchema, recordedAt: epochMilliseconds,
});
type StoredCheck = z.infer<typeof StoredCheckSchema>;
const StoredApprovalSchema = z.strictObject({
  schemaVersion: z.literal(1), principalId: id, revision: revision.positive(),
  requests: ChecksSchema.shape.approvedRequests, approvedAt: epochMilliseconds,
});
/** Plugin storage holds at most this many bytes per value (plugin-kit `MAX_STORAGE_VALUE_BYTES`). */
const MAX_VALUE_BYTES = 64 << 10;

/** Why a caller keeps no checks: not a person, or a person whose sign-in reaches less than the whole workspace tree. */
type Keeper = { person: string } | { refused: "person_required" | "checks_confined" };
/**
 * The caller's records are filed under a digest of their principal, cut to 40 hex characters so a
 * check's key (`checks/<person>/<budget>/<pool>`) stays within the 128 characters plugin storage
 * keys may have; every record also names its principal, which every read compares. Only a person
 * whose sign-in reaches the workspace root keeps checks, asked where an unconfined credential is
 * anchored: a token confined to one container, or by an authority ceiling, keeps none, since a
 * check and the approval to spend on checks are the person's own, never one container's.
 */
async function keeperOf(ctx: CodeContext): Promise<Keeper> {
  if (ctx.auth.principal.kind !== "human") return { refused: "person_required" };
  if (ctx.auth.containerScope !== null || !(await ctx.auth.allows("containers:read"))) return { refused: "checks_confined" };
  return { person: digestOf({ principalId: ctx.auth.principal.id }).slice(0, 40) };
}
async function personOf(ctx: CodeContext): Promise<string | null> {
  const keeper = await keeperOf(ctx);
  return "person" in keeper ? keeper.person : null;
}
const checkKey = (person: string, budget: Budget, pool: string) => `checks/${person}/${budget}/${pool}`;
const approvalKey = (person: string) => `approvals/${person}`;

/** A stored record that names another principal, or another key than its own, is corruption, never someone's data. */
function bound<T extends { principalId: string }>(ctx: CodeContext, record: T): T {
  if (record.principalId !== ctx.auth.principal.id) throw new CodeRefusal("invalid_configuration");
  return record;
}
async function readApproval(ctx: CodeContext, person: string) {
  const raw = await ctx.storage.get(approvalKey(person));
  return raw === null ? null : { raw, approval: bound(ctx, StoredApprovalSchema.parse(JSON.parse(raw))) };
}
function parseCheck(ctx: CodeContext, person: string, key: string, raw: string): StoredCheck {
  const check = bound(ctx, StoredCheckSchema.parse(JSON.parse(raw)));
  if (key !== checkKey(person, check.budget, check.poolIdentityDigest)) throw new CodeRefusal("invalid_configuration");
  return check;
}
async function readCheck(ctx: CodeContext, person: string, budget: Budget, pool: string) {
  const key = checkKey(person, budget, pool), raw = await ctx.storage.get(key);
  return raw === null ? null : { raw, check: parseCheck(ctx, person, key, raw) };
}
async function storedChecks(ctx: CodeContext, person: string): Promise<StoredCheck[]> {
  const checks: StoredCheck[] = [];
  for (const key of await ctx.storage.keys(`checks/${person}/`)) {
    const raw = await ctx.storage.get(key);
    if (raw !== null) checks.push(parseCheck(ctx, person, key, raw));
  }
  return checks.sort((left, right) => right.recordedAt - left.recordedAt);
}
/** Every model a list ladders, as `provider/id`. Spark's retired rung (tier 0) is never routed, so no later check needs to keep it. */
function checkedModels(document: CatalogDocument): string[] {
  return [...new Set(document.models.filter(model => model.tier !== 0).map(probeAddress))].sort();
}
function summary(check: StoredCheck): ModelCheck {
  return { poolIdentityDigest: check.poolIdentityDigest, budget: check.budget, digest: check.digest, provenance: check.provenance,
    recordedAt: check.recordedAt, models: checkedModels(check.document) };
}

export async function readChecks(ctx: CodeContext): Promise<Checks> {
  const person = await personOf(ctx);
  if (person === null) return { keeps: false, revision: 0, approvedRequests: 0, approvedAt: null, checks: [] };
  const [held, checks] = await Promise.all([readApproval(ctx, person), storedChecks(ctx, person)]);
  return { keeps: true, revision: held?.approval.revision ?? 0, approvedRequests: held?.approval.requests ?? 0, approvedAt: held?.approval.approvedAt ?? null,
    checks: checks.slice(0, MAX_CHECKS).map(summary) };
}

/** Records how much checks may spend without asking, at the approval's exact revision; `requests: 0` withdraws it. */
export async function approveChecks(ctx: CodeContext, args: ActionInput<"approveChecks">): Promise<Checks> {
  const keeper = await keeperOf(ctx);
  if (!("person" in keeper)) throw new CodeRefusal(keeper.refused);
  const { person } = keeper;
  const held = await readApproval(ctx, person);
  if ((held?.approval.revision ?? 0) !== args.expectedRevision) throw new CodeRefusal("stale_preferences");
  const next = StoredApprovalSchema.parse({ schemaVersion: 1, principalId: ctx.auth.principal.id, revision: args.expectedRevision + 1,
    requests: args.requests, approvedAt: ctx.now() });
  if (!(await ctx.storage.compareAndSet(approvalKey(person), held?.raw ?? null, JSON.stringify(next)))) throw new CodeRefusal("stale_preferences");
  return readChecks(ctx);
}

/**
 * Keeps a verified list being staged as the checking person's check of its pool and budget, unless
 * they already keep one whose benchmark completed no earlier. Only the most recent `MAX_CHECKS` are
 * kept. A caller that keeps no checks records nothing, and neither does a write that loses a race
 * with another of the person's checks: the stage itself is never refused for it.
 */
export async function recordCheck(ctx: CodeContext, list: { document: CatalogDocument; digest: string; provenance: VerificationProvenance },
  budget: Budget): Promise<void> {
  const person = await personOf(ctx);
  if (person === null) return;
  const pool = list.provenance.poolIdentityDigest, key = checkKey(person, budget, pool);
  const held = await readCheck(ctx, person, budget, pool);
  if (held !== null && held.check.provenance.benchmarkCompletedAt >= list.provenance.benchmarkCompletedAt) return;
  const encoded = JSON.stringify(StoredCheckSchema.parse({ schemaVersion: 1, principalId: ctx.auth.principal.id, poolIdentityDigest: pool, budget,
    document: list.document, digest: list.digest, provenance: list.provenance, recordedAt: ctx.now() }));
  if (Buffer.byteLength(encoded) > MAX_VALUE_BYTES) throw new CodeRefusal("input_too_large");
  if (!(await ctx.storage.compareAndSet(key, held?.raw ?? null, encoded))) return;
  for (const stale of (await storedChecks(ctx, person)).slice(MAX_CHECKS)) await ctx.storage.delete(checkKey(person, stale.budget, stale.poolIdentityDigest));
}

/**
 * Puts the caller's check of the workspace's present pool, derived under `budget`, in use: the pool
 * is recomputed from the observation and the saved choices and must be the one the caller found a
 * check for. A list the workspace already holds for that pool, measured no earlier, refuses
 * `check_current`; the workspace's staged list stays as it is.
 */
export async function adoptCheck(ctx: CodeContext, args: ActionInput<"adoptCheck">): Promise<Configuration> {
  const previous = await readConfiguration(ctx, args, true); expectRevision(previous, args.expectedRevision);
  const record = requireConfiguration(previous);
  if (args.accounts.observedAt !== null && args.accounts.observedAt > ctx.now()) throw new DomainError("invalid_accounts");
  const pool = poolIdentity(selectedAccountPool(args.accounts, record.accounts));
  if (pool.providers.length === 0) throw new CodeRefusal("account_unavailable");
  if (pool.poolIdentityDigest !== args.poolIdentityDigest) throw new CodeRefusal("accounts_changed");
  const person = await personOf(ctx);
  const held = person === null ? null : await readCheck(ctx, person, args.budget, pool.poolIdentityDigest);
  if (held === null) throw new CodeRefusal("check_missing");
  const { check } = held, inUse = record.active?.provenance;
  // The key binds the check to this pool; a list naming a provider the pool does not cover is still never put in use.
  if (check.document.models.some(model => !pool.providers.includes(model.provider))) throw new CodeRefusal("invalid_provenance");
  if (inUse && inUse.poolIdentityDigest === check.poolIdentityDigest && inUse.benchmarkCompletedAt >= check.provenance.benchmarkCompletedAt)
    throw new CodeRefusal("check_current");
  const selection = clampSelection(compileCatalog(check.document), args.selection ?? record.selection);
  return commitConfiguration(ctx, previous, { ...record,
    active: { document: check.document, digest: check.digest, provenance: check.provenance }, selection });
}
