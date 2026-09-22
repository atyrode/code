/**
 * Code's session doors, for a plugin that depends on Code. A Code profile is a WORKSPACE whose
 * generator has been configured — its catalog, its selection and its account choices are the
 * container's shared configuration — so a dependent plugin names a container and a prompt, and
 * everything else is read here: the account observation from OMP's accounts owner, OMP's own
 * defaults, the composition the generator's dials describe. The caller never composes a
 * session, never chooses an account and never reaches OMP itself.
 */
import { JobInputBindingSchema, SessionInputSchema, OMP_PLUGIN_ID, LAUNCH_OPERATION_ID, SESSION_OPERATION_ID, MATERIAL_SESSION_OPERATION_ID, RefusalSchema as ompRefusal,
  actionDoor as ompDoor, actionSchemas as ompActionSchemas, epochMilliseconds, skillInputBindings,
  type AccountsObservation, type ActionInput as OmpInput, type ActionResult as OmpResult,
  type OmpAction } from "@atyrode/manifold-omp";
import type { ActionCallRefusal } from "@manifold/protocol";
import { z } from "zod";
import { selectedAccountPool } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { DomainError, type AccountChoices, type CatalogDocument, type Selection } from "../domain/contracts.ts";
import { compileOmpOverlay, reviewCatalog } from "../domain/routing.ts";
import { digest, id, revision, reviewedSessionOptions, sessionInput, type ActionInput, type ActionResult,
  type Profile, type SessionComposition } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./context.ts";
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
  // A session retained before bound inputs existed has none, which is what an absent key is.
  inputs: z.array(JobInputBindingSchema).max(16).default([]),
  inferenceLimits: SessionInputSchema.shape.inferenceLimits,
  isolation: SessionInputSchema.shape.isolation,
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

/** The host's classes for a call onto a declared dependency (ADR 0041), in the order it walks
 * them. A record over the published union, so a class Manifold adds or retires is a compile
 * error here rather than a silent `refused`. */
const callRefusals: Readonly<Record<ActionCallRefusal, true>> = {
  dispatch_cycle: true, dispatch_depth: true, undeclared_dependency: true, dependency_unavailable: true,
  unknown_action: true, caller_ceiling: true, capability: true, refused: true,
};
/**
 * One door of one OMP plugin, under the principal of the request Code is answering. Which OMP
 * plugin publishes the door is OMP's own mapping: `actionDoor` spells `${plugin}.${action}`,
 * so Code never repeats which of the family owns what.
 *
 * A refusal is a REJECTION, never a value: the host settles a callee handler's own
 * `{ refused }` as its `refused` class and throws `${class}: ${caller} -> ${door} (${detail})`
 * at this edge. OMP's word survives because a `refused` detail that OMP's OWN published
 * grammar admits is re-raised whole — `omp_review_changed` reads `code_omp_review_changed`.
 * A door that threw (`failed`) or was called wrong (`invalid_args: …`) is the host's account
 * of the edge and stays `code_omp_refused`; every other class keeps the callee and the class,
 * so a withheld install grant reads `code_omp_caller_ceiling` rather than a bare refusal.
 */
async function ompCall<K extends OmpAction>(ctx: CodeContext, action: K, input: OmpInput<K>): Promise<OmpResult<K>> {
  const schema = ompActionSchemas[action];
  const door = ompDoor(action);
  const plugin = door.slice(0, door.length - action.length - 1);
  const args = schema.input.parse(input);
  let reply: unknown;
  try {
    reply = await ctx.actions.call({ plugin, action, input: args });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const separator = message.indexOf(": ");
    const named = separator === -1 ? message : message.slice(0, separator);
    const refused = Object.hasOwn(callRefusals, named) ? named : "refused";
    const detail = refused === "refused" ? /\(([^()]*)\)$/.exec(message)?.[1] : undefined;
    if (detail !== undefined && ompRefusal.safeParse({ refused: detail }).success) throw new CodeRefusal(detail);
    throw new CodeRefusal(`${plugin.replace(/^atyrode\./, "").replace(/\./g, "_")}_${refused}`);
  }
  const parsed = schema.result.safeParse(reply);
  if (!parsed.success) throw new CodeRefusal("invalid_omp_result");
  return parsed.data as OmpResult<K>;
}
/** The composition and the OMP input it produces, both re-observed from scratch: the account
 * observation and OMP's defaults are facts of the moment, not of the caller's request. */
async function observedSession(ctx: CodeContext, args: ActionInput<"runSession">) {
  const accounts = await ompCall(ctx, "accounts", {});
  const defaults = await ompCall(ctx, "readDefaults", {});
  const composition = await composeSession(ctx, { containerId: args.containerId,
    expectedRevision: args.expectedRevision, accounts, prompt: args.prompt });
  return { composition, input: sessionInput({ containerId: args.containerId, machineId: args.machineId }, composition, defaults.revision,
    { skills: args.skills, automation: args.automation, inferenceLimits: args.inferenceLimits, isolation: args.isolation }) };
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
  // One observation for the whole list: the accounts owner is asked once, and an owner that
  // cannot answer leaves every row unresolved rather than failing a list of profiles that
  // exist either way.
  let observed: AccountsObservation | null = null;
  try {
    observed = await ompCall(ctx, "accounts", {});
  } catch (error) {
    if (!(error instanceof CodeRefusal)) throw error;
  }
  const profiles: Profile[] = [];
  for (const record of await readableConfigurations(ctx)) {
    if (!record.active || !record.selection) continue;
    profiles.push({ containerId: record.containerId, revision: record.revision,
      selected: selectedModel(record.active.document, record.selection, ctx.now()),
      machineId: await lastDestination(ctx, record.containerId),
      ...spentAccounts(observed, record.accounts) });
  }
  return { profiles };
}
/**
 * The accounts this profile spends, which is what `selectedAccountPool` would put in a run's
 * pool. Code's choices are exclusions over an observation, so an observation is what makes
 * them nameable: without one — or with one the choices no longer resolve against, which is
 * the same refusal a launch would meet — the answer is `resolved: false` and no names, never
 * a guess and never the exclusions themselves.
 */
function spentAccounts(observed: AccountsObservation | null, choices: AccountChoices): Pick<Profile, "accounts" | "resolved"> {
  if (observed === null) return { accounts: [], resolved: false };
  try {
    const pool = selectedAccountPool(observed, choices);
    const logins = new Map(observed.accounts.map(account => [account.credentialId, account.email]));
    const accounts = Object.entries(pool).flatMap(([provider, entries]) => entries.map(entry => {
      const label = logins.get(entry.credentialId) ?? null;
      return { provider, identityKey: entry.identityKey, ...(label === null ? {} : { label }) };
    }));
    // A pool wider than a display row can carry is not truncated into a half-truth: the
    // profile spends all of them, and a caller that needs every one composes a session.
    return accounts.length > 64 ? { accounts: [], resolved: false } : { accounts, resolved: true };
  } catch (error) {
    if (error instanceof DomainError) return { accounts: [], resolved: false };
    throw error;
  }
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
 *
 * Ordinary reviews name the interactive content operation; their jobs use its one-shot
 * sibling. Material-only reviews and jobs both name the isolated operation. Neither
 * placement may silently substitute for the other.
 */
export async function runSession(ctx: CodeContext, args: ActionInput<"runSession">): Promise<ActionResult<"runSession">> {
  // The workspace is authorized as `composeSession` authorizes it, and for writing: a posted
  // job is retained under Code's own storage before its handle is answered.
  await authorizeTarget(ctx, args, true);
  const first = await observedSession(ctx, args);
  const review = await ompCall(ctx, "reviewSession", first.input);
  if (review.destination.containerId !== args.containerId || review.destination.machineId !== args.machineId ||
    review.operationId !== (args.isolation === undefined ? LAUNCH_OPERATION_ID : MATERIAL_SESSION_OPERATION_ID) ||
    review.defaultsRevision !== first.input.expectedDefaultsRevision ||
    digestOf(review.inferenceLimits ?? null) !== digestOf(args.inferenceLimits ?? null) ||
    digestOf(review.isolation ?? null) !== digestOf(args.isolation ?? null))
    throw new CodeRefusal("omp_review_changed");
  const latest = await observedSession(ctx, args);
  if (latest.composition.compositionDigest !== first.composition.compositionDigest ||
    latest.input.expectedDefaultsRevision !== first.input.expectedDefaultsRevision) throw new CodeRefusal("composition_changed");
  // Material remains the caller's binding; optional slots come only from OMP's reviewed union.
  const bound = [...(args.inputs ?? []), ...skillInputBindings(review.skills)];
  const job = await ompCall(ctx, "runSession", {
    ...sessionInput({ containerId: args.containerId, machineId: args.machineId }, latest.composition, latest.input.expectedDefaultsRevision, reviewedSessionOptions(review)),
    reviewDigest: review.reviewDigest, ...(args.inputs === undefined ? {} : { inputs: args.inputs }) });
  const operationId = args.isolation === undefined ? SESSION_OPERATION_ID : MATERIAL_SESSION_OPERATION_ID;
  if (job.machineId !== args.machineId || job.pluginId !== OMP_PLUGIN_ID || job.operationId !== operationId ||
    digestOf(job.inputs ?? []) !== digestOf(bound) ||
    Object.entries(args.inferenceLimits ?? {}).some(([key, value]) =>
      job.limits?.inference?.[key as keyof NonNullable<typeof args.inferenceLimits>] !== value))
    throw new CodeRefusal("omp_review_changed");
  const provenance = SessionProvenanceSchema.parse({ door: "runSession", containerId: args.containerId,
    machineId: args.machineId, jobId: job.jobId, operationId: job.operationId, revision: latest.composition.revision,
    compositionDigest: latest.composition.compositionDigest, reviewDigest: review.reviewDigest,
    defaultsRevision: latest.input.expectedDefaultsRevision, requester: ctx.auth.principal.id,
    postedAt: ctx.now(), inputs: bound,
    ...(args.inferenceLimits === undefined ? {} : { inferenceLimits: args.inferenceLimits }),
    ...(args.isolation === undefined ? {} : { isolation: args.isolation }) });
  // OMP mints the job id, so retention is the step between the post and the answer rather than
  // before it. A job whose provenance did not commit is one Code will not speak for; it is
  // still OMP's job, and OMP's own retained provenance still reads it.
  if (!(await ctx.storage.compareAndSet(`sessions/${digestOf({ containerId: args.containerId })}/${job.jobId}`, null, JSON.stringify(provenance))))
    throw new CodeRefusal("session_conflict");
  return job;
}
/** The session Code retained under this workspace. Both job doors start here: a job id alone
 * is nothing, and the destination is the one Code recorded rather than one a caller supplies,
 * so no job id ever widens to another machine's run. */
async function retainedSession(ctx: CodeContext, args: { containerId: string; jobId: string }): Promise<SessionProvenance> {
  const raw = await ctx.storage.get(`sessions/${digestOf({ containerId: args.containerId })}/${args.jobId}`);
  if (raw === null) throw new CodeRefusal("session_unknown");
  const provenance = SessionProvenanceSchema.parse(JSON.parse(raw));
  const operationId = provenance.isolation === undefined ? SESSION_OPERATION_ID : MATERIAL_SESSION_OPERATION_ID;
  if (provenance.containerId !== args.containerId || provenance.jobId !== args.jobId ||
    provenance.operationId !== operationId) throw new CodeRefusal("session_unknown");
  return provenance;
}
/** The job OMP answered for the session Code retained, whatever its state. */
function sameJob(job: ActionResult<"cancelSession">["job"], provenance: SessionProvenance, requireLimits = true): boolean {
  return job.jobId === provenance.jobId && job.machineId === provenance.machineId &&
    job.pluginId === OMP_PLUGIN_ID && job.operationId === provenance.operationId &&
    (!requireLimits || (digestOf(job.inputs ?? []) === digestOf(provenance.inputs) &&
      Object.entries(provenance.inferenceLimits ?? {}).every(([key, value]) =>
        job.limits?.inference?.[key as keyof NonNullable<SessionProvenance["inferenceLimits"]>] === value)));
}
/**
 * The run Code posted, read back through OMP at any point in its life. `job` is the job's own
 * state — queued, started, cancelled, exited — and `session` is the receipt, which exists only
 * once the run exited 0 and its transcript was sealed. A running or failed session is therefore
 * an ANSWER with `session: null`, not a refusal: a caller watching a run reads `job.state` and
 * `job.result`, and only a job Code never posted is refused.
 */
export async function readSession(ctx: CodeContext, args: ActionInput<"readSession">): Promise<ActionResult<"readSession">> {
  await authorizeTarget(ctx, args);
  const provenance = await retainedSession(ctx, args);
  const reply = await ompCall(ctx, "readSession", { containerId: provenance.containerId,
    machineId: provenance.machineId, jobId: provenance.jobId });
  if (!sameJob(reply.job, provenance)) throw new CodeRefusal("omp_review_changed");
  // EXACTLY ONE OF THE TWO IS NULL, and a reply that breaks it is named as OMP's, not the
  // caller's. Code forwards the word it is given — it does not map, rename or collapse the
  // silences — but a reply carrying both a receipt and a reason it has none, or neither, is not
  // a shape any caller can read. Letting it through to the door's own result schema would refuse
  // `code_invalid_request`, blaming the request for the peer's answer.
  if ((reply.session === null) === (reply.silence === null)) throw new CodeRefusal("invalid_omp_result");
  return reply;
}

/** Native meter/progress for the exact session retained under this Code workspace. */
export async function followSession(ctx: CodeContext, args: ActionInput<"followSession">): Promise<ActionResult<"followSession">> {
  await authorizeTarget(ctx, args);
  const provenance = await retainedSession(ctx, args);
  const reply = await ompCall(ctx, "followSession", { containerId: provenance.containerId,
    machineId: provenance.machineId, jobId: provenance.jobId });
  if (!sameJob(reply.job, provenance)) throw new CodeRefusal("omp_review_changed");
  return reply;
}
/**
 * End the run Code posted. OMP cancels its own job, so a settled one answers itself rather
 * than failing: cancelling twice, or cancelling a run that already exited, is the same answer
 * both times. Code writes nothing here — the provenance is what it already retained — but the
 * door is a write because ending someone's run is not a read of it.
 */
export async function cancelSession(ctx: CodeContext, args: ActionInput<"cancelSession">): Promise<ActionResult<"cancelSession">> {
  await authorizeTarget(ctx, args, true);
  const provenance = await retainedSession(ctx, args);
  const reply = await ompCall(ctx, "cancelSession", { containerId: provenance.containerId,
    machineId: provenance.machineId, jobId: provenance.jobId });
  if (!sameJob(reply.job, provenance, false)) throw new CodeRefusal("omp_review_changed");
  return reply;
}
