import { createHash } from "node:crypto";
import { defineAction } from "@manifold/plugin";
import type { GuestCtx } from "@manifold/plugin-kit/server";
import { PublicJobSchema, type PublicJob } from "@manifold/protocol";
import { z } from "zod";
import { CODE_PLUGIN_ID, CODE_PREFERENCES_EVENT, CODE_PREFERENCES_TOPIC } from "./contract.ts";
import {
  CODE_ACCOUNT_CHANGE_OPERATIONS, CodeAccountChangeOperationSchema,
  CodeAccountStateSchema, CodeAccountViewSchema, CodeApplyAccountChoicesInputSchema,
  CodeApplyAccountChoicesResultSchema, CodeObservationSchema, CodeObserveInputSchema,
  CodeOperationResultSchemas, CodeRunInputSchema,
  type CodeAccounts, type CodeAccountState, type CodeApplyAccountChoicesInput,
  type CodeApplyAccountChoicesResult, type CodeObservation, type CodeObserveInput,
  type CodeOperation, type CodeOperationResult, type CodeRunInput,
} from "./machine-contract.ts";

const maxResultBytes = 1 << 20;
const activeStates = new Set(["queued", "admitted", "start-committed", "started"]);
export type CodeContext = Pick<GuestCtx, "jobs" | "newId" | "storage" | "auth" | "emit">;
const StoredPreferencesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  machineId: z.string().min(1).max(128),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: CodeAccountStateSchema,
  source: z.strictObject({ operation: CodeAccountChangeOperationSchema, jobId: z.string().min(1).max(128) }),
});

export const machineActions = [
  defineAction({
    name: "run", title: "Run a declared Code operation on a machine", caps: [], trace: "opaque",
    input: CodeRunInputSchema, result: PublicJobSchema,
  }),
  defineAction({
    name: "observe", title: "Read an authorized Code observation", caps: [], trace: "opaque",
    input: CodeObserveInputSchema, result: CodeObservationSchema,
  }),
  defineAction({
    name: "applyAccountChoices", title: "Apply a verified account-choice proposal", caps: [], trace: "opaque",
    input: CodeApplyAccountChoicesInputSchema, result: CodeApplyAccountChoicesResultSchema,
  }),
];

/** Only product choices are persisted; broker facts and machine-job history stay runtime-owned. */
export function accountStateFromSnapshot(value: CodeAccounts): CodeAccountState {
  return CodeAccountStateSchema.parse({
    schemaVersion: value.schemaVersion, activePreset: value.activePreset,
    manualDisabled: value.manualDisabled, presets: value.presets,
  });
}

async function readStoredPreferences(ctx: CodeContext, machineId: string) {
  const key = `account-preferences/${createHash("sha256").update(machineId).digest("hex")}`;
  const raw = await ctx.storage.get(key);
  const record = raw === null ? null : StoredPreferencesSchema.parse(JSON.parse(raw));
  if (record !== null && record.machineId !== machineId) throw new Error("invalid_result");
  return { key, raw, record };
}

export async function readCodePreferences(ctx: CodeContext, machineId: string) {
  const preferences = await readStoredPreferences(ctx, machineId);
  const { record } = preferences;
  if (record !== null) {
    // A saved choice is not a publication bypass for the job that supplied its identities.
    const source = PublicJobSchema.parse(await ctx.jobs.status({
      kind: "job", machineId, operationId: `${CODE_PLUGIN_ID}.${record.source.operation}`, jobId: record.source.jobId,
    }));
    if (source.machineId !== machineId || source.pluginId !== CODE_PLUGIN_ID ||
      source.operationId !== `${CODE_PLUGIN_ID}.${record.source.operation}` || source.jobId !== record.source.jobId ||
      source.state !== "exited" || source.result?.exitCode !== 0) throw new Error("invalid_result");
    const output = source.result.outputs.find((item) => item.name === "stdout");
    if (!output || output.bytes < 1) throw new Error("invalid_result");
    // Metadata permission alone does not authorize the identities copied from sealed stdout.
    const access = await ctx.jobs.output({
      node: { kind: "output", machineId, operationId: source.operationId, jobId: source.jobId, outputId: output.outputId },
      offset: 0, maxBytes: 1,
    });
    if (access.jobId !== source.jobId || access.outputId !== output.outputId || access.seq !== 0)
      throw new Error("invalid_result");
  }
  return preferences;
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
  const result = CodeOperationResultSchemas[operation].safeParse(await readResult(ctx, job));
  if (!result.success) throw new Error("invalid_result");
  return { job, value: result.data as CodeOperationResult<K> };
}

export const machineHandlers = {
  async run(ctx: CodeContext, args: CodeRunInput): Promise<PublicJob | { refused: string }> {
    try {
      let payload: unknown = args.input;
      if (args.operation === "account-import") {
        // An explicit import can replace inaccessible old choices without disclosing them.
        const preferences = await readStoredPreferences(ctx, args.machineId);
        payload = { baseRevision: preferences.record?.revision ?? 0 };
      } else if ("expectedRevision" in args.input) {
        const { expectedRevision, baselineJobId, ...choice } = args.input;
        const preferences = await readCodePreferences(ctx, args.machineId);
        if (expectedRevision !== (preferences.record?.revision ?? 0)) return { refused: "code_stale_preferences" };
        let state = preferences.record?.state;
        if (state === undefined) {
          const baseline = await readCodeSnapshot(ctx, args.machineId, "accounts-list", baselineJobId);
          if (baseline.value.baseRevision !== expectedRevision) return { refused: "code_stale_preferences" };
          state = accountStateFromSnapshot(baseline.value);
        }
        payload = { ...choice, state, baseRevision: expectedRevision };
      } else if (args.operation !== "account-clear-blocks") {
        const { accountSource, ...input } = "accountSource" in args.input ? args.input : { ...args.input, accountSource: "plugin" };
        if (accountSource === "machine") payload = { ...input, baseRevision: null };
        else {
          const preferences = await readCodePreferences(ctx, args.machineId);
          if (preferences.record === null && (args.operation === "inspect" || args.operation === "suggest"))
            return { refused: "code_preferences_missing" };
          payload = { ...input, baseRevision: preferences.record?.revision ?? (args.operation === "accounts-list" ? 0 : null),
            ...(preferences.record === null ? {} : { state: preferences.record.state }) };
        }
      }
      const input = JSON.stringify(payload);
      if (Buffer.byteLength(JSON.stringify({ payload: input })) > 64 << 10) return { refused: "code_input_too_large" };
      return PublicJobSchema.parse(await ctx.jobs.execute({
        jobId: await ctx.newId(), machineId: args.machineId,
        operationId: `${CODE_PLUGIN_ID}.${args.operation}`, input: { payload: input }, outputs: [],
      }));
    } catch {
      return { refused: "code_operation_unavailable" };
    }
  },

  async applyAccountChoices(ctx: CodeContext, args: CodeApplyAccountChoicesInput): Promise<CodeApplyAccountChoicesResult | { refused: string }> {
    try {
      if (!(await ctx.auth.allows("machines:run", {
        kind: "operation", machineId: args.machineId, operationId: `${CODE_PLUGIN_ID}.${args.operation}`,
      }))) return { refused: "code_operation_unavailable" };
      const preferences = args.operation === "account-import"
        ? await readStoredPreferences(ctx, args.machineId)
        : await readCodePreferences(ctx, args.machineId);
      const proposal = await readCodeSnapshot(ctx, args.machineId, args.operation, args.jobId);
      if (preferences.record?.source.jobId === args.jobId && preferences.record.source.operation === args.operation)
        return { revision: preferences.record.revision, jobId: args.jobId };
      const revision = preferences.record?.revision ?? 0;
      if (proposal.value.baseRevision !== revision || revision === Number.MAX_SAFE_INTEGER)
        return { refused: "code_stale_preferences" };
      const record = StoredPreferencesSchema.parse({
        schemaVersion: 1, machineId: args.machineId, revision: revision + 1,
        state: accountStateFromSnapshot(proposal.value), source: { operation: args.operation, jobId: args.jobId },
      });
      if (!(await ctx.storage.compareAndSet(preferences.key, preferences.raw, JSON.stringify(record))))
        return { refused: "code_stale_preferences" };
      // Invalidate authorized reads without broadcasting account identities or private job metadata.
      ctx.emit(CODE_PREFERENCES_TOPIC, CODE_PREFERENCES_EVENT);
      return { revision: record.revision, jobId: args.jobId };
    } catch {
      return { refused: "code_operation_unavailable" };
    }
  },

  async observe(ctx: CodeContext, args: CodeObserveInput): Promise<CodeObservation | { refused: string }> {
    let latest: PublicJob | null = null;
    let snapshot: { job: PublicJob; value: unknown } | null = null;
    let failure: CodeObservation["failure"] = null;
    let cursor: string | undefined;
    try {
      let preferences = args.operation === "accounts-list" ? await readCodePreferences(ctx, args.machineId) : undefined;
      pages: for (let page = 0; page < 4; page++) {
        const history = args.jobId === undefined ? await ctx.jobs.listRuns({
          machineId: args.machineId, operationId: `${CODE_PLUGIN_ID}.${args.operation}`, limit: 50,
          ...(cursor === undefined ? {} : { cursor }),
        }) : {
          runs: [{ job: PublicJobSchema.parse(await ctx.jobs.status({
            kind: "job", machineId: args.machineId, operationId: `${CODE_PLUGIN_ID}.${args.operation}`, jobId: args.jobId,
          })), occurrence: null }],
          nextCursor: null,
        };
        for (const run of history.runs) {
          const job = run.job;
          if (!job || job.pluginId !== CODE_PLUGIN_ID || job.machineId !== args.machineId ||
            job.operationId !== `${CODE_PLUGIN_ID}.${args.operation}` || (args.jobId !== undefined && job.jobId !== args.jobId)) continue;
          latest ??= job;
          if (job.state !== "exited" || job.result?.exitCode !== 0) continue;
          try {
            const result = CodeOperationResultSchemas[args.operation].safeParse(await readResult(ctx, job));
            if (!result.success) { failure ??= "invalid_result"; continue; }
            if (args.operation === "accounts-list" && "baseRevision" in result.data &&
              result.data.baseRevision !== (preferences?.record?.revision ?? 0)) {
              failure ??= "stale_preferences";
              continue;
            }
            snapshot = { job, value: result.data };
            break pages;
          } catch (reason) {
            failure ??= reason instanceof Error && reason.message === "invalid_result" ? "invalid_result" : "output_unavailable";
          }
        }
        if (history.nextCursor === null) { cursor = undefined; break; }
        cursor = history.nextCursor;
      }
      if (args.operation === "accounts-list" && preferences !== undefined) {
        if (snapshot === null && preferences.record !== null) {
          const committed = await readCodeSnapshot(ctx, args.machineId, preferences.record.source.operation, preferences.record.source.jobId);
          snapshot = committed;
          latest ??= committed.job;
        }
        if (snapshot !== null) {
          const revision = preferences.record?.revision ?? 0;
          const candidates = await Promise.allSettled(CODE_ACCOUNT_CHANGE_OPERATIONS.map(async (operation) => {
            const history = await ctx.jobs.listRuns({ machineId: args.machineId, operationId: `${CODE_PLUGIN_ID}.${operation}`, limit: 1 });
            const job = history.runs[0]?.job;
            if (!job || job.state !== "exited" || job.result?.exitCode !== 0 || job.jobId === preferences?.record?.source.jobId) return null;
            const proposal = await readCodeSnapshot(ctx, args.machineId, operation, job.jobId);
            return proposal.value.baseRevision === revision ? proposal : null;
          }));
          const proposals = candidates.flatMap((candidate) => candidate.status === "fulfilled" && candidate.value !== null ? [candidate.value] : []);
          snapshot.value = CodeAccountViewSchema.parse({
            ...(snapshot.value as CodeAccounts), preferenceRevision: revision,
            appliedJobId: preferences.record?.source.jobId ?? null, proposals,
            proposalsUnavailable: candidates.some((candidate) => candidate.status === "rejected"),
          });
        }
      }
      if (args.operation === "usage" && snapshot !== null) {
        const result = CodeOperationResultSchemas.usage.parse(snapshot.value);
        preferences ??= await readCodePreferences(ctx, args.machineId);
        if (result.baseRevision !== (preferences.record?.revision ?? null)) failure = "stale_preferences";
      }
      let state: CodeObservation["state"] = cursor === undefined ? "empty" : "unavailable";
      if (latest) {
        if (activeStates.has(latest.state)) state = "pending";
        else if (latest.state !== "exited" || latest.result?.exitCode !== 0) {
          state = "failed";
          failure = "operation_failed";
        } else if (snapshot !== null && (args.operation === "accounts-list" || snapshot.job.jobId === latest.jobId)) {
          state = args.operation === "usage" && failure === "stale_preferences" ? "unavailable" : "ready";
        } else state = failure === "invalid_result" ? "failed" : "unavailable";
      }
      return CodeObservationSchema.parse({ operation: args.operation, state, latest, snapshot, failure });
    } catch {
      return { refused: "code_observation_unavailable" };
    }
  },
};
