import { createHash } from "node:crypto";
import { defineAction } from "@manifold/plugin";
import type { GuestCtx } from "@manifold/plugin-kit/server";
import { canonicalJobJson, JobDescriptionSchema, PublicJobSchema, type PublicJob } from "@manifold/protocol";
import { z } from "zod";
import { CODE_PLUGIN_ID, CODE_PREFERENCES_EVENT, CODE_PREFERENCES_TOPIC } from "./contract.ts";
import {
  CODE_ACCOUNT_CHANGE_OPERATIONS, CodeAccountStateSchema, CodeAccountViewSchema,
  CodeApplyAccountChoicesInputSchema, CodeApplyAccountChoicesResultSchema, CodeObservationSchema,
  CodeObserveInputSchema, CodeOperationResultSchemas, CodeRunInputSchema, CodeConfigurationSchema,
  CodeConfigurationReadInputSchema, CodeConfigurationReadSchema, CodeInitializeInputSchema,
  CodeStageInputSchema, CodePromoteInputSchema, CodeSelectInputSchema,
  type CodeAccounts, type CodeAccountState, type CodeApplyAccountChoicesInput,
  type CodeApplyAccountChoicesResult, type CodeObservation, type CodeObserveInput,
  type CodeOperation, type CodeOperationResult, type CodeRunInput, type CodeConfiguration,
} from "./machine-contract.ts";

const maxResultBytes = 1 << 20;
const activeStates = new Set(["queued", "admitted", "start-committed", "started"]);
export type CodeContext = Pick<GuestCtx, "jobs" | "newId" | "storage" | "auth" | "emit">;
// Same key and exact old format: adoption is an explicit CAS action, never a read-side migration.
const PreviousChoicesSchema = z.strictObject({
  schemaVersion: z.literal(1), machineId: z.string().min(1).max(128),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), state: CodeAccountStateSchema,
  source: z.strictObject({ operation: z.string().min(1), jobId: z.string().min(1).max(128) }),
});
const StoredSchema = z.union([CodeConfigurationSchema, PreviousChoicesSchema]);
export const machineActions = [
  defineAction({ name: "run", title: "Run a declared Code operation", caps: [], trace: "opaque", input: CodeRunInputSchema, result: PublicJobSchema }),
  defineAction({ name: "observe", title: "Read an authorized Code observation", caps: [], trace: "opaque", input: CodeObserveInputSchema, result: CodeObservationSchema }),
  defineAction({ name: "applyAccountChoices", title: "Apply a verified choice proposal", caps: [], trace: "opaque", input: CodeApplyAccountChoicesInputSchema, result: CodeApplyAccountChoicesResultSchema }),
  defineAction({ name: "readConfiguration", title: "Read shared Code configuration", caps: [], trace: "opaque", input: CodeConfigurationReadInputSchema, result: CodeConfigurationReadSchema }),
  defineAction({ name: "readSetup", title: "Read native machine setup and consent", caps: [], trace: "opaque", input: CodeConfigurationReadInputSchema, result: JobDescriptionSchema }),
  defineAction({ name: "initializeConfiguration", title: "Initialize or transition native Code configuration", caps: [], trace: "opaque", input: CodeInitializeInputSchema, result: CodeConfigurationSchema }),
  defineAction({ name: "stageConfiguration", title: "Stage a catalog candidate", caps: [], trace: "opaque", input: CodeStageInputSchema, result: CodeConfigurationSchema }),
  defineAction({ name: "promoteConfiguration", title: "Promote the exact reviewed catalog", caps: [], trace: "opaque", input: CodePromoteInputSchema, result: CodeConfigurationSchema }),
  defineAction({ name: "selectConfiguration", title: "Commit shared Code dials", caps: [], trace: "opaque", input: CodeSelectInputSchema, result: CodeConfigurationSchema }),
];
export function accountStateFromSnapshot(value: CodeAccounts): CodeAccountState {
  return CodeAccountStateSchema.parse({ schemaVersion: value.schemaVersion, activePreset: value.activePreset, manualDisabled: value.manualDisabled, presets: value.presets });
}
function refusal(reason: unknown, fallback = "code_operation_unavailable") {
  const message = reason instanceof Error ? reason.message : "";
  return { refused: message.startsWith("code_") ? message : fallback };
}
async function authority(ctx: CodeContext, machineId: string, operation: string, capability: "jobs:read" | "machines:run") {
  if (!(await ctx.auth.allows(capability, { kind: "operation", machineId, operationId: `${CODE_PLUGIN_ID}.${operation}` }))) throw new Error("code_operation_unavailable");
}
async function authorizeSource(ctx: CodeContext, machineId: string, source: { operation: string; jobId: string }) {
  const operationId = `${CODE_PLUGIN_ID}.${source.operation}`;
  const job = PublicJobSchema.parse(await ctx.jobs.status({ kind: "job", machineId, operationId, jobId: source.jobId }));
  if (job.machineId !== machineId || job.pluginId !== CODE_PLUGIN_ID || job.operationId !== operationId || job.jobId !== source.jobId || job.state !== "exited" || job.result?.exitCode !== 0) throw new Error("invalid_result");
  // A metadata grant alone must not disclose material copied from sealed stdout.
  const output = job.result.outputs.find((entry) => entry.name === "stdout");
  if (!output || output.bytes < 1) throw new Error("invalid_result");
  const access = await ctx.jobs.output({
    node: { kind: "output", machineId, operationId, jobId: job.jobId, outputId: output.outputId }, offset: 0, maxBytes: 1,
  });
  if (access.jobId !== job.jobId || access.outputId !== output.outputId || access.seq !== 0 || Buffer.from(access.data, "base64").length !== 1)
    throw new Error("invalid_result");
}
export async function readCodeConfiguration(ctx: CodeContext, machineId: string) {
  await authority(ctx, machineId, "inspect", "jobs:read");
  const key = `account-preferences/${createHash("sha256").update(machineId).digest("hex")}`;
  const raw = await ctx.storage.get(key);
  const stored = raw === null ? null : StoredSchema.parse(JSON.parse(raw));
  if (stored !== null && stored.machineId !== machineId) throw new Error("invalid_result");
  if (stored?.schemaVersion === 1) await authorizeSource(ctx, machineId, stored.source);
  if (stored?.schemaVersion === 2) {
    if (stored.choiceSource) await authorizeSource(ctx, machineId, stored.choiceSource);
    for (const catalog of [stored.active, stored.draft]) {
      if (catalog?.generation) await authorizeSource(ctx, machineId, catalog.generation);
      if (catalog?.review) await authorizeSource(ctx, machineId, catalog.review);
    }
  }
  return { key, raw, stored, record: stored?.schemaVersion === 2 ? stored : null };
}
function requireRecord(value: Awaited<ReturnType<typeof readCodeConfiguration>>) {
  if (value.record === null) throw new Error(value.stored === null ? "code_configuration_missing" : "code_configuration_transition_required");
  return value.record;
}
function expectRevision(record: CodeConfiguration, expected: number) {
  if (record.revision !== expected || expected === Number.MAX_SAFE_INTEGER) throw new Error("code_stale_preferences");
}
async function commit(ctx: CodeContext, previous: Awaited<ReturnType<typeof readCodeConfiguration>>, next: CodeConfiguration) {
  const record = CodeConfigurationSchema.parse({ ...next, updatedBy: ctx.auth.principal.id });
  const encoded = JSON.stringify(record);
  if (Buffer.byteLength(encoded) > 256 << 10) throw new Error("code_input_too_large");
  if (!(await ctx.storage.compareAndSet(previous.key, previous.raw, encoded))) throw new Error("code_stale_preferences");
  ctx.emit(CODE_PREFERENCES_TOPIC, CODE_PREFERENCES_EVENT);
  return record;
}
export function catalogPayload(record: CodeConfiguration, draft = false) {
  const catalog = draft ? record.draft : record.active;
  if (catalog === null) throw new Error("code_catalog_missing");
  if (!draft && record.selection === null) throw new Error("code_catalog_missing");
  return { modelsYaml: catalog.modelsYaml, catalogRevision: catalog.catalogRevision,
    ...(draft ? {} : { selection: record.selection! }), state: record.state, baseRevision: record.revision };
}
export function matchesCatalog(record: CodeConfiguration, value: { baseRevision: number; catalogRevision: string; selection: unknown }, draft = false) {
  const catalog = draft ? record.draft : record.active;
  return catalog !== null && value.baseRevision === record.revision && value.catalogRevision === catalog.catalogRevision &&
    (draft || JSON.stringify(value.selection) === JSON.stringify(record.selection));
}
export function requireGovernedJob(job: PublicJob) {
  if (job.authority.origin.kind !== "action" || job.authority.origin.door !== `${CODE_PLUGIN_ID}.run`) throw new Error("invalid_result");
}
export function requirePayload(job: PublicJob, payload: unknown) {
  const inputDigest = createHash("sha256").update(canonicalJobJson({ payload: JSON.stringify(payload) })).digest("hex");
  if (job.inputDigest !== inputDigest) throw new Error("code_preview_changed");
}
export async function currentResources(ctx: CodeContext, machineId: string) {
  const description = await ctx.jobs.describe({ machineId, pluginId: CODE_PLUGIN_ID });
  const installation = description.installation;
  if (description.machineId !== machineId || description.pluginId !== CODE_PLUGIN_ID || !description.connected ||
    installation === null || !installation.enabled || !installation.ready || installation.purgeRequested) throw new Error("code_resources_incomplete");
  return { description, installation };
}
export async function requireCurrentJob(ctx: CodeContext, job: PublicJob) {
  const current = await currentResources(ctx, job.machineId);
  const operation = current.description.operations?.[job.operationId];
  if (job.installationRevision !== current.installation.revision || job.artifactSha256 !== current.installation.artifactSha256 ||
    !operation || !operation.ready || job.resourceBindingDigest !== operation.resourceBindingDigest) throw new Error("code_resources_changed");
  return current;
}
export async function requireConfigurationResources(ctx: CodeContext, record: CodeConfiguration, operationId: string) {
  const current = await currentResources(ctx, record.machineId);
  const pins = record.resourcePins;
  const operation = current.description.operations?.[operationId];
  if (!pins || !operation || !operation.ready || !pins.operations[operationId]) throw new Error("code_resources_incomplete");
  if (pins.installationRevision !== current.installation.revision || pins.artifactSha256 !== current.installation.artifactSha256 ||
    pins.operations[operationId] !== operation.resourceBindingDigest) throw new Error("code_resources_changed");
  return { installationRevision: pins.installationRevision, artifactSha256: pins.artifactSha256, resourceBindingDigest: operation.resourceBindingDigest };
}
async function readResult(ctx: CodeContext, job: PublicJob): Promise<unknown> {
  const output = job.result?.outputs.find((item) => item.name === "stdout");
  if (!output || output.bytes < 1 || output.bytes > maxResultBytes) throw new Error("invalid_result");
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < output.bytes) {
    const maxBytes = Math.min(64 << 10, output.bytes - offset);
    const chunk = await ctx.jobs.output({
      node: {
        kind: "output", machineId: job.machineId, operationId: job.operationId,
        jobId: job.jobId, outputId: output.outputId,
      }, offset, maxBytes,
    });
    const bytes = Buffer.from(chunk.data, "base64");
    if (chunk.jobId !== job.jobId || chunk.outputId !== output.outputId || chunk.seq !== offset ||
      bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== chunk.data ||
      chunk.eof !== (offset + bytes.length === output.bytes)) throw new Error("invalid_result");
    chunks.push(bytes);
    offset += bytes.length;
  }
  const bytes = Buffer.concat(chunks, offset);
  if (createHash("sha256").update(bytes).digest("hex") !== output.sha256) throw new Error("invalid_result");
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("invalid_result"); }
}

/** Status and every output chunk use the caller's current native authority and original consent. */
export async function readCodeSnapshot<K extends CodeOperation>(ctx: CodeContext, machineId: string, operation: K, jobId: string) {
  const job = PublicJobSchema.parse(await ctx.jobs.status({
    kind: "job", machineId, operationId: `${CODE_PLUGIN_ID}.${operation}`, jobId,
  }));
  if (job.machineId !== machineId || job.pluginId !== CODE_PLUGIN_ID || job.jobId !== jobId ||
    job.operationId !== `${CODE_PLUGIN_ID}.${operation}`) throw new Error("invalid_result");
  if (job.state !== "exited" || job.result?.exitCode !== 0) throw new Error("operation_failed");
  requireGovernedJob(job);
  const result = CodeOperationResultSchemas[operation].safeParse(await readResult(ctx, job));
  if (!result.success) throw new Error("invalid_result");
  return { job, value: result.data as CodeOperationResult<K> };
}

export const machineHandlers = {
  async readSetup(ctx: CodeContext, args: z.infer<typeof CodeConfigurationReadInputSchema>) {
    try { return JobDescriptionSchema.parse(await ctx.jobs.describe({ machineId: args.machineId, pluginId: CODE_PLUGIN_ID })); }
    catch (reason) { return refusal(reason, "code_observation_unavailable"); }
  },
  async readConfiguration(ctx: CodeContext, args: z.infer<typeof CodeConfigurationReadInputSchema>) {
    try {
      const state = await readCodeConfiguration(ctx, args.machineId);
      return CodeConfigurationReadSchema.parse({ status: state.stored === null ? "missing" : state.record === null ? "transition_required" : "ready",
        revision: state.stored?.revision ?? 0, configuration: state.record, previousChoices: state.stored?.schemaVersion === 1 ? state.stored.state : null });
    } catch (reason) { return refusal(reason, "code_observation_unavailable"); }
  },
  async initializeConfiguration(ctx: CodeContext, args: z.infer<typeof CodeInitializeInputSchema>) {
    try {
      await authority(ctx, args.machineId, "inspect", "machines:run");
      const previous = await readCodeConfiguration(ctx, args.machineId);
      if (previous.record !== null || (previous.stored?.revision ?? 0) !== args.expectedRevision || args.expectedRevision === Number.MAX_SAFE_INTEGER) throw new Error("code_stale_preferences");
      const old = previous.stored?.schemaVersion === 1 ? previous.stored : null;
      return await commit(ctx, previous, { schemaVersion: 2, machineId: args.machineId, revision: args.expectedRevision + 1,
        state: old?.state ?? { schemaVersion: 1, activePreset: "Manual", manualDisabled: [], presets: [] },
        choiceSource: old?.source ?? null, active: null, draft: null, selection: null, resourcePins: null, updatedBy: ctx.auth.principal.id });
    } catch (reason) { return refusal(reason); }
  },
  async stageConfiguration(ctx: CodeContext, args: z.infer<typeof CodeStageInputSchema>) {
    try {
      await authority(ctx, args.machineId, "catalog-review", "machines:run");
      const previous = await readCodeConfiguration(ctx, args.machineId);
      const record = requireRecord(previous); expectRevision(record, args.expectedRevision);
      const generation = args.source.kind === "generation" ? await readCodeSnapshot(ctx, args.machineId, "catalog-generate", args.source.jobId) : null;
      const modelsYaml = args.source.kind === "edit" ? args.source.modelsYaml : generation!.value.modelsYaml;
      // Bound the actual encoded job payload, not merely UTF-16 source length.
      const candidate = { ...record, revision: record.revision + 1, draft: { modelsYaml,
        catalogRevision: createHash("sha256").update(modelsYaml).digest("hex"), review: null,
        generation: generation === null ? null : { operation: "catalog-generate", jobId: generation.job.jobId } } };
      if (Buffer.byteLength(JSON.stringify({ payload: JSON.stringify(catalogPayload(candidate, true)) })) > 64 << 10) throw new Error("code_input_too_large");
      return await commit(ctx, previous, candidate);
    } catch (reason) { return refusal(reason); }
  },
  async promoteConfiguration(ctx: CodeContext, args: z.infer<typeof CodePromoteInputSchema>) {
    try {
      await authority(ctx, args.machineId, "catalog-review", "machines:run");
      const previous = await readCodeConfiguration(ctx, args.machineId);
      const record = requireRecord(previous); expectRevision(record, args.expectedRevision);
      const review = await readCodeSnapshot(ctx, args.machineId, "catalog-review", args.reviewJobId);
      if (!matchesCatalog(record, review.value, true)) throw new Error("code_stale_preferences");
      requirePayload(review.job, catalogPayload(record, true));
      const resources = await requireCurrentJob(ctx, review.job);
      const resourcePins = { installationRevision: resources.installation.revision, artifactSha256: resources.installation.artifactSha256,
        operations: Object.fromEntries(Object.entries(resources.description.operations ?? {}).map(([id, value]) => [id, value.resourceBindingDigest])) };
      return await commit(ctx, previous, { ...record, revision: record.revision + 1,
        active: { ...record.draft!, review: { operation: "catalog-review", jobId: review.job.jobId } }, draft: null, selection: review.value.selection, resourcePins });
    } catch (reason) { return refusal(reason); }
  },
  async selectConfiguration(ctx: CodeContext, args: z.infer<typeof CodeSelectInputSchema>) {
    try {
      await authority(ctx, args.machineId, "inspect", "machines:run");
      const previous = await readCodeConfiguration(ctx, args.machineId);
      const record = requireRecord(previous); expectRevision(record, args.expectedRevision);
      if (record.active === null) throw new Error("code_catalog_missing");
      return await commit(ctx, previous, { ...record, revision: record.revision + 1, selection: args.selection });
    } catch (reason) { return refusal(reason); }
  },
  async run(ctx: CodeContext, args: CodeRunInput): Promise<PublicJob | { refused: string }> {
    try {
      let payload: unknown = args.input;
      let pins: { installationRevision: string; artifactSha256: string; resourceBindingDigest: string } | undefined;
      if (!["catalog-generate", "auth-status", "account-clear-blocks", "account-disable"].includes(args.operation)) {
        const record = requireRecord(await readCodeConfiguration(ctx, args.machineId));
        if ("expectedRevision" in args.input) expectRevision(record, args.input.expectedRevision);
        if (args.operation === "catalog-review") payload = catalogPayload(record, true);
        else if (args.operation === "inspect" || args.operation === "analysis-plan" || args.operation === "suggest") {
          payload = { ...catalogPayload(record), ...(args.operation === "suggest" ? { prompt: args.input.prompt } : {}) };
          pins = await requireConfigurationResources(ctx, record, `${CODE_PLUGIN_ID}.${args.operation}`);
          if (args.operation === "analysis-plan") {
            const inspection = await readCodeSnapshot(ctx, args.machineId, "inspect", args.input.inspectionJobId);
            if (!matchesCatalog(record, inspection.value)) throw new Error("code_stale_preferences");
            if (!inspection.value.ready) throw new Error("code_resources_incomplete");
            requirePayload(inspection.job, catalogPayload(record));
            await requireCurrentJob(ctx, inspection.job);
          }
        } else if ("baselineJobId" in args.input) {
          const baseline = await readCodeSnapshot(ctx, args.machineId, "accounts-list", args.input.baselineJobId);
          if (baseline.value.baseRevision !== record.revision) throw new Error("code_stale_preferences");
          const { expectedRevision: _revision, baselineJobId: _baseline, ...choice } = args.input;
          payload = { ...choice, state: record.state, baseRevision: record.revision };
        } else payload = { state: record.state, baseRevision: record.revision };
      }
      const input = JSON.stringify(payload);
      if (Buffer.byteLength(JSON.stringify({ payload: input })) > 64 << 10) throw new Error("code_input_too_large");
      return PublicJobSchema.parse(await ctx.jobs.execute({ jobId: await ctx.newId(), machineId: args.machineId,
        operationId: `${CODE_PLUGIN_ID}.${args.operation}`, input: { payload: input }, outputs: [], ...pins }));
    } catch (reason) { return refusal(reason); }
  },
  async applyAccountChoices(ctx: CodeContext, args: CodeApplyAccountChoicesInput): Promise<CodeApplyAccountChoicesResult | { refused: string }> {
    try {
      await authority(ctx, args.machineId, args.operation, "machines:run");
      const previous = await readCodeConfiguration(ctx, args.machineId);
      const record = requireRecord(previous);
      const proposal = await readCodeSnapshot(ctx, args.machineId, args.operation, args.jobId);
      if (record.choiceSource?.jobId === args.jobId && record.choiceSource.operation === args.operation) return { revision: record.revision, jobId: args.jobId };
      expectRevision(record, proposal.value.baseRevision);
      const next = await commit(ctx, previous, { ...record, revision: record.revision + 1, state: accountStateFromSnapshot(proposal.value), choiceSource: { operation: args.operation, jobId: args.jobId } });
      return { revision: next.revision, jobId: args.jobId };
    } catch (reason) { return refusal(reason); }
  },
  async observe(ctx: CodeContext, args: CodeObserveInput): Promise<CodeObservation | { refused: string }> {
    let latest: PublicJob | null = null;
    let snapshot: { job: PublicJob; value: unknown } | null = null;
    let failure: CodeObservation["failure"] = null;
    let cursor: string | undefined;
    try {
      const configuration = await readCodeConfiguration(ctx, args.machineId);
      const record = configuration.record;
      pages: for (let page = 0; page < 4; page++) {
        const history = args.jobId === undefined ? await ctx.jobs.listRuns({ machineId: args.machineId, operationId: `${CODE_PLUGIN_ID}.${args.operation}`, limit: 50, ...(cursor === undefined ? {} : { cursor }) }) : {
          runs: [{ job: PublicJobSchema.parse(await ctx.jobs.status({ kind: "job", machineId: args.machineId, operationId: `${CODE_PLUGIN_ID}.${args.operation}`, jobId: args.jobId })), occurrence: null }], nextCursor: null,
        };
        for (const run of history.runs) {
          const job = run.job;
          if (!job || job.pluginId !== CODE_PLUGIN_ID || job.machineId !== args.machineId || job.operationId !== `${CODE_PLUGIN_ID}.${args.operation}` || (args.jobId !== undefined && job.jobId !== args.jobId)) continue;
          latest ??= job;
          if (job.state !== "exited" || job.result?.exitCode !== 0) continue;
          try {
            requireGovernedJob(job);
            const result = CodeOperationResultSchemas[args.operation].safeParse(await readResult(ctx, job));
            if (!result.success) { failure ??= "invalid_result"; continue; }
            if ("baseRevision" in result.data && (record === null || result.data.baseRevision !== record.revision)) failure = "stale_preferences";
            if ("catalogRevision" in result.data && record !== null) {
              const catalog = args.operation === "catalog-review" ? record.draft : record.active;
              if (catalog?.catalogRevision !== result.data.catalogRevision ||
                (args.operation !== "suggest" && args.operation !== "catalog-review" && !matchesCatalog(record, result.data))) failure = "stale_preferences";
            }
            snapshot = { job, value: result.data }; break pages;
          } catch (reason) { failure ??= reason instanceof Error && reason.message === "invalid_result" ? "invalid_result" : "output_unavailable"; }
        }
        if (history.nextCursor === null) { cursor = undefined; break; }
        cursor = history.nextCursor;
      }
      if (args.operation === "accounts-list" && snapshot !== null && record !== null) {
        const candidates = await Promise.allSettled(CODE_ACCOUNT_CHANGE_OPERATIONS.map(async (operation) => {
          const history = await ctx.jobs.listRuns({ machineId: args.machineId, operationId: `${CODE_PLUGIN_ID}.${operation}`, limit: 1 });
          const job = history.runs[0]?.job;
          if (!job || job.state !== "exited" || job.result?.exitCode !== 0 || job.jobId === record.choiceSource?.jobId) return null;
          const proposal = await readCodeSnapshot(ctx, args.machineId, operation, job.jobId);
          return proposal.value.baseRevision === record.revision ? proposal : null;
        }));
        snapshot.value = CodeAccountViewSchema.parse({ ...(snapshot.value as CodeAccounts), preferenceRevision: record.revision,
          appliedJobId: record.choiceSource?.jobId ?? null,
          proposals: candidates.flatMap((candidate) => candidate.status === "fulfilled" && candidate.value !== null ? [candidate.value] : []),
          proposalsUnavailable: candidates.some((candidate) => candidate.status === "rejected") });
      }
      let state: CodeObservation["state"] = cursor === undefined ? "empty" : "unavailable";
      if (latest) {
        if (activeStates.has(latest.state)) state = "pending";
        else if (latest.state !== "exited" || latest.result?.exitCode !== 0) { state = "failed"; failure = "operation_failed"; }
        else if (snapshot !== null && snapshot.job.jobId === latest.jobId) state = failure === "stale_preferences" ? "unavailable" : "ready";
        else state = failure === "invalid_result" ? "failed" : "unavailable";
      }
      return CodeObservationSchema.parse({ operation: args.operation, state, latest, snapshot, failure });
    } catch (reason) { return refusal(reason, "code_observation_unavailable"); }
  },
};
