import { z } from "zod";
import { epochMilliseconds, probeAddress } from "@atyrode/manifold-omp";
import { selectedAccountPool } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { CatalogDocumentSchema, DomainError, type CatalogDocument } from "../domain/contracts.ts";
import { clampSelection } from "../domain/routing.ts";
import { ChecksSchema, MAX_CHECKS, VerificationProvenanceSchema, digest, id, revision, type ActionInput, type Checks,
  type Configuration, type ModelCheck, type VerificationProvenance } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./context.ts";
import { commitConfiguration, expectRevision, poolIdentity, readConfiguration, requireConfiguration } from "./state.ts";

/*
  A PERSON'S MODEL CHECKS. Which models answer through an account pool is a fact about those
  accounts, not about the workspace a check happened to run in, so a verified list put in use is
  also kept for the person who promoted it, under the exact pool it was verified with, and any
  workspace whose saved choices select that pool adopts it without spending another check. The
  person's standing approval of what checks may spend lives beside them. Both are keyed by the
  caller's own principal: nobody reads or writes another person's, and an agent or a service
  keeps none. Workspaces keep their own copies, so a `runSession` caller still reads a workspace.
*/

const StoredCheckSchema = z.strictObject({
  schemaVersion: z.literal(1), principalId: id, poolIdentityDigest: digest,
  document: CatalogDocumentSchema, digest, provenance: VerificationProvenanceSchema, recordedAt: epochMilliseconds,
});
type StoredCheck = z.infer<typeof StoredCheckSchema>;
const StoredApprovalSchema = z.strictObject({
  schemaVersion: z.literal(1), principalId: id, revision: revision.positive(),
  requests: ChecksSchema.shape.approvedRequests, approvedAt: epochMilliseconds,
});

/**
 * The caller's records are filed under a digest of their principal, cut to 40 hex characters so a
 * check's key (`checks/<person>/<pool>`) stays within the 128 characters plugin storage keys may
 * have; every record also names its principal, which every read compares. Null for an agent or a
 * service, which keep none.
 */
function personOf(ctx: CodeContext): string | null {
  return ctx.auth.principal.kind === "human" ? digestOf({ principalId: ctx.auth.principal.id }).slice(0, 40) : null;
}
const checkKey = (person: string, pool: string) => `checks/${person}/${pool}`;
const approvalKey = (person: string) => `approvals/${person}`;

async function readApproval(ctx: CodeContext, person: string) {
  const raw = await ctx.storage.get(approvalKey(person));
  if (raw === null) return null;
  const approval = StoredApprovalSchema.parse(JSON.parse(raw));
  // A record that does not name the principal its key is filed under is corruption, never someone's approval.
  if (approval.principalId !== ctx.auth.principal.id) throw new CodeRefusal("invalid_configuration");
  return { raw, approval };
}
async function storedChecks(ctx: CodeContext, person: string): Promise<StoredCheck[]> {
  const checks: StoredCheck[] = [];
  for (const key of await ctx.storage.keys(`checks/${person}/`)) {
    const raw = await ctx.storage.get(key);
    if (raw === null) continue;
    const check = StoredCheckSchema.parse(JSON.parse(raw));
    if (check.principalId !== ctx.auth.principal.id || key !== checkKey(person, check.poolIdentityDigest)) throw new CodeRefusal("invalid_configuration");
    checks.push(check);
  }
  return checks.sort((left, right) => right.recordedAt - left.recordedAt);
}
/** Every model a list ladders, as `provider/id`. Spark's retired rung (tier 0) is never routed, so no later check needs to keep it. */
export function checkedModels(document: CatalogDocument): string[] {
  return [...new Set(document.models.filter(model => model.tier !== 0).map(probeAddress))].sort();
}
function summary(check: StoredCheck): ModelCheck {
  return { poolIdentityDigest: check.poolIdentityDigest, digest: check.digest, provenance: check.provenance, recordedAt: check.recordedAt,
    models: checkedModels(check.document) };
}

export async function readChecks(ctx: CodeContext): Promise<Checks> {
  const person = personOf(ctx);
  if (person === null) return { revision: 0, approvedRequests: 0, approvedAt: null, checks: [] };
  const [held, checks] = await Promise.all([readApproval(ctx, person), storedChecks(ctx, person)]);
  return { revision: held?.approval.revision ?? 0, approvedRequests: held?.approval.requests ?? 0, approvedAt: held?.approval.approvedAt ?? null,
    checks: checks.slice(0, MAX_CHECKS).map(summary) };
}

/** Records how much checks may spend without asking, at the approval's exact revision; `requests: 0` withdraws it. */
export async function approveChecks(ctx: CodeContext, args: ActionInput<"approveChecks">): Promise<Checks> {
  const person = personOf(ctx);
  if (person === null) throw new CodeRefusal("person_required");
  const held = await readApproval(ctx, person);
  if ((held?.approval.revision ?? 0) !== args.expectedRevision) throw new CodeRefusal("stale_preferences");
  const next = StoredApprovalSchema.parse({ schemaVersion: 1, principalId: ctx.auth.principal.id, revision: args.expectedRevision + 1,
    requests: args.requests, approvedAt: ctx.now() });
  if (!(await ctx.storage.compareAndSet(approvalKey(person), held?.raw ?? null, JSON.stringify(next)))) throw new CodeRefusal("stale_preferences");
  return readChecks(ctx);
}

/**
 * Keeps a verified list being put in use as the promoting person's check of its pool, unless they
 * already keep one measured no earlier. Only the most recent `MAX_CHECKS` pools are kept.
 */
export async function recordCheck(ctx: CodeContext, list: { document: CatalogDocument; digest: string; provenance: VerificationProvenance }): Promise<void> {
  const person = personOf(ctx);
  if (person === null) return;
  const key = checkKey(person, list.provenance.poolIdentityDigest);
  const newer = (raw: string | null) => raw === null ||
    StoredCheckSchema.parse(JSON.parse(raw)).provenance.benchmarkCompletedAt < list.provenance.benchmarkCompletedAt;
  const raw = await ctx.storage.get(key);
  if (!newer(raw)) return;
  const encoded = JSON.stringify(StoredCheckSchema.parse({ schemaVersion: 1, principalId: ctx.auth.principal.id,
    poolIdentityDigest: list.provenance.poolIdentityDigest, document: list.document, digest: list.digest, provenance: list.provenance,
    recordedAt: ctx.now() }));
  if (Buffer.byteLength(encoded) > 512 << 10) throw new CodeRefusal("input_too_large");
  if (!(await ctx.storage.compareAndSet(key, raw, encoded))) {
    // Another of this person's promotions kept its own list first: it stands if it was measured no earlier.
    if (newer(await ctx.storage.get(key))) throw new CodeRefusal("stale_preferences");
    return;
  }
  for (const stale of (await storedChecks(ctx, person)).slice(MAX_CHECKS)) await ctx.storage.delete(checkKey(person, stale.poolIdentityDigest));
}

/**
 * Puts the caller's check of the workspace's present pool in use: the pool is recomputed from the
 * observation and the saved choices and must be the one the caller found a check for. A list the
 * workspace already holds for that pool, measured no earlier, refuses `check_current`; the
 * workspace's staged list stays as it is.
 */
export async function adoptCheck(ctx: CodeContext, args: ActionInput<"adoptCheck">): Promise<Configuration> {
  const previous = await readConfiguration(ctx, args, true); expectRevision(previous, args.expectedRevision);
  const record = requireConfiguration(previous);
  if (args.accounts.observedAt !== null && args.accounts.observedAt > ctx.now()) throw new DomainError("invalid_accounts");
  const pool = poolIdentity(selectedAccountPool(args.accounts, record.accounts));
  if (pool.providers.length === 0) throw new CodeRefusal("account_unavailable");
  if (pool.poolIdentityDigest !== args.poolIdentityDigest) throw new CodeRefusal("accounts_changed");
  const person = personOf(ctx);
  const raw = person === null ? null : await ctx.storage.get(checkKey(person, pool.poolIdentityDigest));
  if (raw === null) throw new CodeRefusal("check_missing");
  const check = StoredCheckSchema.parse(JSON.parse(raw));
  if (check.principalId !== ctx.auth.principal.id || check.poolIdentityDigest !== pool.poolIdentityDigest) throw new CodeRefusal("invalid_configuration");
  const held = record.active?.provenance;
  if (held && held.poolIdentityDigest === check.poolIdentityDigest && held.benchmarkCompletedAt >= check.provenance.benchmarkCompletedAt)
    throw new CodeRefusal("check_current");
  const selection = clampSelection(compileCatalog(check.document), args.selection ?? record.selection);
  return commitConfiguration(ctx, previous, { ...record,
    active: { document: check.document, digest: check.digest, provenance: check.provenance }, selection });
}
