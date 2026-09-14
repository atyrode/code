/**
 * Code's session doors, for a plugin that depends on Code. A Code profile is a WORKSPACE whose
 * generator has been configured — its catalog, its selection and its account choices are the
 * container's shared configuration — so a dependent plugin names a container and a prompt, and
 * everything else is read here: the account observation from OMP's accounts owner, OMP's own
 * defaults, the composition the generator's dials describe. The caller never composes a
 * session, never chooses an account and never reaches OMP itself.
 */
import { ACCOUNTS_PLUGIN_ID, AccountsObservationSchema, DefaultsSchema, OMP_PLUGIN_ID,
  RefusalSchema as OmpRefusalSchema, SessionReviewSchema, epochMilliseconds } from "@atyrode/manifold-omp";
import { PublicJobSchema } from "@manifold/protocol";
import { z } from "zod";
import { selectedAccountPool } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { DomainError, type CatalogDocument, type Selection } from "../domain/contracts.ts";
import { compileOmpOverlay, reviewCatalog } from "../domain/routing.ts";
import { digest, id, revision, sessionInput, type ActionInput, type ActionResult,
  type Profile, type SessionComposition } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./context.ts";
import { dependencyCall } from "./manifold-next.ts";
import { OmpReadSessionInputSchema, OmpRunSessionInputSchema, OmpSessionSchema,
  READ_SESSION_ACTION, RUN_SESSION_ACTION } from "./omp-next.ts";
import { authorizeTarget, expectRevision, readConfiguration,
  readableConfigurations, requireConfiguration } from "./state.ts";

/** What Code keeps of a session it posted: the composition it was, the workspace it belongs
 * to, and the OMP job that carries it. It is the whole basis on which `readSession` speaks for
 * a run; a job Code did not post is not Code's to read back. */
const SessionProvenanceSchema = z.strictObject({
  door: z.literal("runSession"),
  containerId: id, machineId: id, jobId: id, operationId: id,
  revision: revision.positive(), compositionDigest: digest, reviewDigest: digest,
  defaultsRevision: revision, requester: id, postedAt: epochMilliseconds,
});
type SessionProvenance = z.infer<typeof SessionProvenanceSchema>;

/**
 * One workspace's saved catalog, selection and account choices against one caller-supplied
 * observation. The `composeSession` door and the `runSession` door call exactly this, so a
 * posted job carries the composition the generator previewed and nothing else.
 */
export async function composeSession(ctx: CodeContext, args: ActionInput<"composeSession">): Promise<SessionComposition> {
  const previous = await readConfiguration(ctx, args); expectRevision(previous, args.expectedRevision);
  const record = requireConfiguration(previous);
  if (!record.active || !record.selection) throw new CodeRefusal("catalog_missing");
  if (args.accounts.observedAt !== null && args.accounts.observedAt > ctx.now()) throw new DomainError("invalid_accounts");
  const accountPool = selectedAccountPool(args.accounts, record.accounts);
  const catalog = compileCatalog(record.active.document);
  const review = reviewCatalog(catalog, record.selection, ctx.now());
  for (const route of review.routes) {
    for (const choice of [route.lead, ...route.fallback]) {
      if (!accountPool[catalog.model(choice.key).provider]?.length) throw new CodeRefusal("account_unavailable");
    }
  }
  const overlay = compileOmpOverlay(catalog, review.selection, review.routes);
  const facts = { revision: record.revision, review, accountPool, overlay, prompt: args.prompt, planYolo: review.selection.planYolo };
  const compositionDigest = digestOf({ containerId: record.containerId, revision: record.revision,
    catalog: record.active.digest, selection: review.selection, routes: review.routes, accountPool,
    overlay, prompt: args.prompt, planYolo: facts.planYolo });
  if ((await readConfiguration(ctx, args)).raw !== previous.raw) throw new CodeRefusal("stale_preferences");
  return { ...facts, compositionDigest };
}

/** One door of one OMP plugin. A refusal OMP answered keeps its own name — `omp_review_changed`
 * reads `code_omp_review_changed` — so a caller learns which side refused and why. */
async function ompReply<T>(ctx: CodeContext, plugin: string, action: string, input: unknown, result: z.ZodType<T>): Promise<T> {
  const reply = await dependencyCall(ctx, { plugin, action, input });
  const refused = OmpRefusalSchema.safeParse(reply);
  if (refused.success) throw new CodeRefusal(refused.data.refused);
  const parsed = result.safeParse(reply);
  if (!parsed.success) throw new CodeRefusal("invalid_omp_result");
  return parsed.data;
}
/** The composition and the OMP input it produces, both re-observed from scratch: the account
 * observation and OMP's defaults are facts of the moment, not of the caller's request. */
async function observedSession(ctx: CodeContext, args: ActionInput<"runSession">) {
  const accounts = await ompReply(ctx, ACCOUNTS_PLUGIN_ID, "accounts", {}, AccountsObservationSchema);
  const defaults = await ompReply(ctx, OMP_PLUGIN_ID, "readDefaults", {}, DefaultsSchema);
  const composition = await composeSession(ctx, { containerId: args.containerId,
    expectedRevision: args.expectedRevision, accounts, prompt: args.prompt });
  return { composition, input: sessionInput({ containerId: args.containerId, machineId: args.machineId }, composition, defaults.revision) };
}

/**
 * The profiles a dependent plugin may offer. A configuration without an active catalog or a
 * saved selection is a workspace the generator has not finished, and is no profile at all.
 *
 * The door is a container door although the list spans containers, because every row is asked
 * about one: a container-scoped caller is answered with its own container and nothing else,
 * which is the obligation `scope: "container"` puts on a handler rather than a hole in it.
 */
export async function listProfiles(ctx: CodeContext, _args: ActionInput<"listProfiles">): Promise<ActionResult<"listProfiles">> {
  const profiles: Profile[] = [];
  for (const record of await readableConfigurations(ctx)) {
    if (!record.active || !record.selection) continue;
    profiles.push({ containerId: record.containerId, revision: record.revision,
      selected: selectedModel(record.active.document, record.selection, ctx.now()),
      machineId: await lastDestination(ctx, record.containerId) });
  }
  return { profiles };
}
/** A selection its catalog no longer supports summarises as nothing: the generator is where it
 * is resolved, and a caller must not read a stale dial as the model a run would use. */
function selectedModel(document: CatalogDocument, selection: Selection, now: number): Profile["selected"] {
  try {
    const catalog = compileCatalog(document);
    const review = reviewCatalog(catalog, selection, now);
    const lead = review.routes.find(route => route.role === "default")?.lead;
    if (!lead) return null;
    const model = catalog.model(lead.key);
    return { model: `${model.provider}/${model.id}`, thinking: lead.thinking,
      capability: review.selection.capability, advisor: review.selection.advisor };
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}
/** Where Code last posted a session for this workspace, read from the provenance `readSession`
 * relies on. Code stores no destination of its own: choosing one is the caller's, and this is
 * only the destination it chose last. */
async function lastDestination(ctx: CodeContext, containerId: string): Promise<string | null> {
  let newest: SessionProvenance | null = null;
  for (const key of await ctx.storage.keys(`sessions/${digestOf({ containerId })}/`)) {
    const raw = await ctx.storage.get(key);
    if (raw === null) continue;
    const provenance = SessionProvenanceSchema.parse(JSON.parse(raw));
    if (!newest || provenance.postedAt > newest.postedAt) newest = provenance;
  }
  return newest?.machineId ?? null;
}

/**
 * The reviewed session, posted as an OMP job. The double preparation is `prepareSession`'s:
 * compose, review at OMP, compose again, and refuse rather than post when the workspace, the
 * accounts or OMP's defaults moved between the two. The prompt is required because a job-shaped
 * session is one-shot — without one the run would never end.
 */
export async function runSession(ctx: CodeContext, args: ActionInput<"runSession">): Promise<ActionResult<"runSession">> {
  // The workspace is authorized as `composeSession` authorizes it, and for writing: a posted
  // job is retained under Code's own storage before its handle is answered.
  await authorizeTarget(ctx, args, true);
  const first = await observedSession(ctx, args);
  const review = await ompReply(ctx, OMP_PLUGIN_ID, "reviewSession", first.input, SessionReviewSchema);
  if (review.destination.containerId !== args.containerId || review.destination.machineId !== args.machineId ||
    review.defaultsRevision !== first.input.expectedDefaultsRevision) throw new CodeRefusal("omp_review_changed");
  const latest = await observedSession(ctx, args);
  if (latest.composition.compositionDigest !== first.composition.compositionDigest ||
    latest.input.expectedDefaultsRevision !== first.input.expectedDefaultsRevision) throw new CodeRefusal("composition_changed");
  const job = await ompReply(ctx, OMP_PLUGIN_ID, RUN_SESSION_ACTION,
    OmpRunSessionInputSchema.parse({ ...latest.input, reviewDigest: review.reviewDigest }), PublicJobSchema);
  if (job.machineId !== args.machineId || job.pluginId !== OMP_PLUGIN_ID || job.operationId !== review.operationId)
    throw new CodeRefusal("omp_review_changed");
  const provenance = SessionProvenanceSchema.parse({ door: "runSession", containerId: args.containerId,
    machineId: args.machineId, jobId: job.jobId, operationId: job.operationId, revision: latest.composition.revision,
    compositionDigest: latest.composition.compositionDigest, reviewDigest: review.reviewDigest,
    defaultsRevision: latest.input.expectedDefaultsRevision, requester: ctx.auth.principal.id, postedAt: ctx.now() });
  // OMP mints the job id, so retention is the step between the post and the answer rather than
  // before it. A job whose provenance did not commit is one Code will not speak for; it is
  // still OMP's job, and OMP's own retained provenance still reads it.
  if (!(await ctx.storage.compareAndSet(`sessions/${digestOf({ containerId: args.containerId })}/${job.jobId}`, null, JSON.stringify(provenance))))
    throw new CodeRefusal("session_conflict");
  return job;
}
/** The run Code posted, read back through OMP. The destination is the one Code retained, not
 * one the caller supplies: a job id alone never widens to another machine's run. */
export async function readSession(ctx: CodeContext, args: ActionInput<"readSession">): Promise<ActionResult<"readSession">> {
  await authorizeTarget(ctx, args);
  const raw = await ctx.storage.get(`sessions/${digestOf({ containerId: args.containerId })}/${args.jobId}`);
  if (raw === null) throw new CodeRefusal("session_unknown");
  const provenance = SessionProvenanceSchema.parse(JSON.parse(raw));
  if (provenance.containerId !== args.containerId || provenance.jobId !== args.jobId) throw new CodeRefusal("session_unknown");
  const reply = await ompReply(ctx, OMP_PLUGIN_ID, READ_SESSION_ACTION, OmpReadSessionInputSchema.parse({
    containerId: provenance.containerId, machineId: provenance.machineId, jobId: provenance.jobId }), OmpSessionSchema);
  if (reply.job.jobId !== provenance.jobId || reply.job.machineId !== provenance.machineId ||
    reply.job.pluginId !== OMP_PLUGIN_ID || reply.job.operationId !== provenance.operationId)
    throw new CodeRefusal("omp_review_changed");
  return reply;
}
