import { createHash } from "node:crypto";
import { defineAction } from "@manifold/plugin";
import type { GuestJobFollow, GuestJobNode } from "@manifold/plugin-kit/server";
import { canonicalJobJson, JobFollowSnapshotSchema, PublicJobSchema, type JobFollowSnapshot, type PublicJob } from "@manifold/protocol";
import { z } from "zod";
import { CONTROL_FRAME_BYTES } from "../workers/auth/control.ts";
import { enrollmentProviders } from "../workers/auth/providers.ts";
import { CODE_PLUGIN_ID } from "./contract.ts";
import { currentResources, requireCurrentJob, type CodeContext } from "./machine-server.ts";
import {
  AUTH_OPERATION, AUTH_START_DOOR, EnrollmentControlResultSchema, EnrollmentFrameSchema, EnrollmentObservationSchema,
  EnrollmentObserveSchema, EnrollmentPinsSchema, EnrollmentProviderSchema, EnrollmentRespondSchema, EnrollmentStartSchema,
  EnrollmentTargetSchema, type EnrollmentFrame, type EnrollmentProvider, type EnrollmentState,
} from "./auth-contract.ts";

const providers = z.array(EnrollmentProviderSchema).max(128).parse(enrollmentProviders());
const active: Readonly<Record<string, true>> = { queued: true, admitted: true, "start-committed": true, started: true };
const maxOutputBytes = 256 << 10;
const nodeFor = (machineId: string, jobId: string) => ({ kind: "job" as const, machineId, operationId: AUTH_OPERATION, jobId });
const providerDigest = (provider: string) => createHash("sha256").update(canonicalJobJson({ provider })).digest("hex");
const providerInputs = new Map(providers.map(provider => [providerDigest(provider.id), provider]));
class AuthRefusal extends Error {}
function refused(reason: unknown) {
  if (reason instanceof Error && reason.message === "code_resources_changed") return { refused: "code_auth_resources_changed" };
  return { refused: reason instanceof AuthRefusal ? reason.message : "code_auth_unavailable" };
}

/** Only jobs actually created by the governed start action can receive Code controls. */
export function enrollmentProvenance(job: PublicJob, machineId: string, jobId: string, provider?: string): EnrollmentProvider {
  const entry = providerInputs.get(job.inputDigest);
  if (job.machineId !== machineId || job.jobId !== jobId || job.pluginId !== CODE_PLUGIN_ID || job.operationId !== AUTH_OPERATION || job.terminal ||
    (job.authority.executor !== null && job.authority.executor.machineId !== machineId) ||
    (job.result !== null && (job.result.jobId !== jobId || job.result.state !== job.state || job.authority.executor === null ||
      job.result.ownerId !== job.authority.executor.ownerId || job.result.ownerGeneration !== job.authority.executor.ownerGeneration)) ||
    job.authority.origin.kind !== "action" || job.authority.origin.door !== AUTH_START_DOOR || !entry || (provider !== undefined && entry.id !== provider)) {
    throw new AuthRefusal("code_auth_provenance");
  }
  return entry;
}

/** Bounded transient projector. Native output, never a Code registry, owns recovery. */
export class EnrollmentTranscript {
  #pending = Buffer.alloc(0);
  #decoder = new TextDecoder("utf-8", { fatal: true });
  #bytes = 0;
  #frames = 0;
  #started = false;
  #terminal = false;
  #ids = new Set<string>();
  auth: Extract<EnrollmentFrame, { type: "auth" }> | null = null;
  prompt: Extract<EnrollmentFrame, { type: "prompt" }> | null = null;
  complete: Extract<EnrollmentFrame, { type: "complete" }> | null = null;
  refusal: string | null = null;
  constructor(readonly provider: EnrollmentProvider) {}

  push(bytes: Uint8Array): void {
    this.#bytes += bytes.length;
    if (this.#bytes > maxOutputBytes) throw new AuthRefusal("code_auth_history_invalid");
    const input = Buffer.concat([this.#pending, bytes]);
    let offset = 0;
    while (offset < input.length) {
      const end = input.indexOf(10, offset);
      if (end === -1) break;
      if (end - offset >= CONTROL_FRAME_BYTES || ++this.#frames > 128) throw new AuthRefusal("code_auth_history_invalid");
      let frame: EnrollmentFrame;
      try { frame = EnrollmentFrameSchema.parse(JSON.parse(this.#decoder.decode(input.subarray(offset, end)))); }
      catch { throw new AuthRefusal("code_auth_history_invalid"); }
      this.accept(frame);
      offset = end + 1;
    }
    this.#pending = Buffer.from(input.subarray(offset));
    if (this.#pending.length >= CONTROL_FRAME_BYTES) throw new AuthRefusal("code_auth_history_invalid");
  }

  private accept(frame: EnrollmentFrame): void {
    // finish() can retract an outstanding prompt immediately after a refusal.
    if (frame.type === "prompt_closed") {
      if (!this.prompt || this.prompt.promptId !== frame.promptId) throw new AuthRefusal("code_auth_history_invalid");
      this.prompt = null;
      return;
    }
    if (this.#terminal) throw new AuthRefusal("code_auth_history_invalid");
    if (frame.type === "refused") {
      this.refusal = frame.code; this.#terminal = true; this.auth = null;
      return;
    }
    if (frame.type === "started") {
      if (this.#started || frame.provider !== this.provider.id) throw new AuthRefusal("code_auth_history_invalid");
      this.#started = true;
      return;
    }
    if (!this.#started) throw new AuthRefusal("code_auth_history_invalid");
    if (frame.type === "auth") {
      if (this.provider.callback === (frame.challenge !== undefined)) throw new AuthRefusal("code_auth_history_invalid");
      this.auth = frame;
    } else if (frame.type === "prompt") {
      if (!this.provider.callback || !this.auth || this.prompt || this.#ids.has(frame.promptId) || this.#ids.size >= 16) throw new AuthRefusal("code_auth_history_invalid");
      this.#ids.add(frame.promptId); this.prompt = frame;
    } else {
      if (this.prompt || frame.provider !== this.provider.credentialProvider) throw new AuthRefusal("code_auth_history_invalid");
      this.complete = frame; this.#terminal = true; this.auth = null;
    }
  }

  state(job: PublicJob): EnrollmentState {
    const ended = !Object.hasOwn(active, job.state) && !(job.state === "exited" && job.result === null);
    if (ended && (this.#pending.length !== 0 || !this.#terminal)) throw new AuthRefusal("code_auth_history_incomplete");
    if (this.complete && ended && (job.state !== "exited" || job.result?.exitCode !== 0)) throw new AuthRefusal("code_auth_completion_unconfirmed");
    const partial = this.#pending.length !== 0;
    const state = this.refusal ? "refused" : this.complete && ended ? "complete" : !partial && !this.#terminal && this.auth && job.state === "started" ? "challenge" : "pending";
    return { job, provider: this.provider.id, state, auth: state === "challenge" ? this.auth : null,
      prompt: state === "challenge" ? this.prompt : null, complete: state === "complete" ? this.complete : null, refusal: this.refusal };
  }
}

/** Reject any missing native event, cross-job channel or byte-stream sequence. */
export function readEnrollmentFollow(job: PublicJob, provider: EnrollmentProvider, raw: JobFollowSnapshot): EnrollmentState {
  const snapshot = JobFollowSnapshotSchema.parse(raw);
  const executor = job.authority.executor;
  if (snapshot.jobId !== job.jobId || snapshot.unavailable !== null || snapshot.firstSeq !== (snapshot.events.length ? 1 : null) ||
    snapshot.seq !== snapshot.events.length) throw new AuthRefusal("code_auth_history_incomplete");
  const transcript = new EnrollmentTranscript(provider);
  let outputSeq = 0;
  let requestDigest: string | undefined;
  const closed = new Set<string>();
  for (let index = 0; index < snapshot.events.length; index++) {
    const item = snapshot.events[index]!;
    if (item.seq !== index + 1) throw new AuthRefusal("code_auth_history_incomplete");
    const event = item.event;
    if (event.type === "result") {
      if (!executor || event.result.jobId !== job.jobId || event.result.ownerId !== executor.ownerId ||
        event.result.ownerGeneration !== executor.ownerGeneration || (requestDigest !== undefined && requestDigest !== event.result.requestDigest)) throw new AuthRefusal("code_auth_history_invalid");
    } else {
      if (event.jobId !== job.jobId) throw new AuthRefusal("code_auth_history_invalid");
      if (event.type === "state") {
        if (!executor || event.ownerId !== executor.ownerId || event.ownerGeneration !== executor.ownerGeneration ||
          (requestDigest !== undefined && event.requestDigest !== requestDigest)) throw new AuthRefusal("code_auth_history_invalid");
        requestDigest = event.requestDigest;
      } else if (event.type === "output") {
        const bytes = Buffer.from(event.data, "base64");
        if (!executor || event.requestId !== job.jobId || !["stdout", "stderr"].includes(event.outputId) || event.seq !== ++outputSeq ||
          closed.has(event.outputId) || bytes.toString("base64") !== event.data || (event.eof && bytes.length !== 0) ||
          (event.outputId === "stderr" && bytes.length !== 0)) throw new AuthRefusal("code_auth_history_invalid");
        if (event.outputId === "stdout") transcript.push(bytes);
        if (event.eof) closed.add(event.outputId);
      }
    }
  }
  if (snapshot.result && (!executor || snapshot.result.state !== snapshot.state || snapshot.result.jobId !== job.jobId || snapshot.result.ownerId !== executor.ownerId ||
    snapshot.result.ownerGeneration !== executor.ownerGeneration || (requestDigest !== undefined && snapshot.result.requestDigest !== requestDigest))) throw new AuthRefusal("code_auth_history_invalid");
  return transcript.state(PublicJobSchema.parse({ ...job, state: snapshot.state, result: snapshot.result }));
}

async function readEnrollment(ctx: CodeContext, args: z.infer<typeof EnrollmentTargetSchema>): Promise<EnrollmentState> {
  const node = nodeFor(args.machineId, args.jobId);
  const job = PublicJobSchema.parse(await ctx.jobs.status(node));
  const provider = enrollmentProvenance(job, args.machineId, args.jobId, args.provider);
  await requireCurrentJob(ctx, job);
  if (["cancelled", "interrupted", "refused"].includes(job.state)) return {
    job, provider: provider.id, state: "refused", auth: null, prompt: null, complete: null, refusal: `native_${job.state}`,
  };
  let observation: EnrollmentState;
  if (Object.hasOwn(active, job.state) || (job.state === "exited" && job.result === null)) {
    let invalidated = false;
    const follow = await ctx.jobs.follow(node, update => { if (update.type === "closed" && update.reason !== "closed") invalidated = true; });
    try {
      if (invalidated) throw new AuthRefusal("code_auth_history_incomplete");
      observation = readEnrollmentFollow(job, provider, follow.snapshot);
    } finally { await follow.close(); }
    if (invalidated) throw new AuthRefusal("code_auth_history_incomplete");
  } else {
    // Sealed stdout supplies complete byte history even after the live replay ring expires.
    const output = job.result?.outputs.find(output => output.name === "stdout");
    if (!output || output.bytes === 0 || output.bytes > maxOutputBytes || job.result?.outputs.some(output => output.name === "stderr" && output.bytes !== 0)) throw new AuthRefusal("code_auth_history_incomplete");
    const transcript = new EnrollmentTranscript(provider);
    const digest = createHash("sha256");
    let offset = 0;
    while (offset < output.bytes) {
      const maxBytes = Math.min(65536, output.bytes - offset);
      const event = await ctx.jobs.output({ node: { ...node, kind: "output", outputId: output.outputId }, offset, maxBytes });
      const bytes = Buffer.from(event.data, "base64");
      if (event.jobId !== job.jobId || event.outputId !== output.outputId || event.seq !== offset || bytes.length === 0 || bytes.length > maxBytes ||
        bytes.toString("base64") !== event.data || event.eof !== (offset + bytes.length === output.bytes)) throw new AuthRefusal("code_auth_history_invalid");
      digest.update(bytes); transcript.push(bytes); offset += bytes.length;
    }
    if (digest.digest("hex") !== output.sha256) throw new AuthRefusal("code_auth_history_invalid");
    observation = transcript.state(job);
  }
  await requireCurrentJob(ctx, job);
  // Current native authority is checked again after asynchronous output reads.
  const current = PublicJobSchema.parse(await ctx.jobs.status(node));
  enrollmentProvenance(current, args.machineId, args.jobId, args.provider);
  if (current.nextInputSeq !== observation.job.nextInputSeq || current.state !== observation.job.state) throw new AuthRefusal("code_auth_observation_changed");
  return observation;
}

async function waitForStart(ctx: CodeContext, job: PublicJob): Promise<void> {
  const ready = Promise.withResolvers<void>();
  const state = (value: string) => {
    if (value === "started") ready.resolve();
    else if (!Object.hasOwn(active, value)) ready.reject(new AuthRefusal("code_auth_start_refused"));
  };
  const timer = setTimeout(() => ready.reject(new AuthRefusal("code_auth_start_timeout")), 10_000);
  // A closed update can arrive before the follow RPC resolves.
  void ready.promise.catch(() => undefined);
  let follow: GuestJobFollow | undefined;
  try {
    follow = await ctx.jobs.follow(nodeFor(job.machineId, job.jobId), update => {
      if (update.type === "closed") ready.reject(new AuthRefusal("code_auth_start_refused"));
      else if (update.event.type === "state" && update.event.jobId === job.jobId) state(update.event.state);
      else if (update.event.type === "result" || update.event.type === "refusal") ready.reject(new AuthRefusal("code_auth_start_refused"));
    });
    if (follow.snapshot.jobId !== job.jobId) throw new AuthRefusal("code_auth_provenance");
    state(follow.snapshot.state);
    await ready.promise;
  } finally { clearTimeout(timer); await follow?.close(); }
}

export const authActions = [
  defineAction({ name: "startEnrollment", title: "Begin a fresh provider OAuth enrollment", caps: [], trace: "opaque", input: EnrollmentStartSchema, result: PublicJobSchema }),
  defineAction({ name: "observeEnrollment", title: "Read current native OAuth enrollment", caps: [], trace: "opaque", input: EnrollmentObserveSchema, result: EnrollmentObservationSchema }),
  defineAction({ name: "respondEnrollment", title: "Respond once to a correlated OAuth callback", caps: [], trace: "opaque", input: EnrollmentRespondSchema, result: EnrollmentControlResultSchema }),
  defineAction({ name: "cancelEnrollment", title: "Cancel the native OAuth enrollment lifetime", caps: [], trace: "opaque", input: EnrollmentTargetSchema, result: EnrollmentControlResultSchema }),
];
export const authHandlers = {
  async startEnrollment(ctx: CodeContext, input: z.infer<typeof EnrollmentStartSchema>) {
    let cleanupTarget: GuestJobNode | undefined;
    try {
      const args = EnrollmentStartSchema.parse(input);
      if (!providers.some(provider => provider.id === args.provider)) throw new AuthRefusal("code_auth_provider_unavailable");
      if (!(await ctx.auth.allows("machines:run", { kind: "operation", machineId: args.machineId, operationId: AUTH_OPERATION }))) throw new AuthRefusal("code_auth_unavailable");
      const { description, installation } = await currentResources(ctx, args.machineId);
      const operation = description.operations?.[AUTH_OPERATION];
      if (!operation?.ready || args.installationRevision !== installation.revision || args.artifactSha256 !== installation.artifactSha256 ||
        args.resourceBindingDigest !== operation.resourceBindingDigest) throw new AuthRefusal("code_auth_resources_changed");
      const jobId = await ctx.newId();
      cleanupTarget = nodeFor(args.machineId, jobId);
      const started = PublicJobSchema.parse(await ctx.jobs.execute({ jobId, machineId: args.machineId, operationId: AUTH_OPERATION,
        ...EnrollmentPinsSchema.parse({ installationRevision: args.installationRevision, artifactSha256: args.artifactSha256, resourceBindingDigest: args.resourceBindingDigest }),
        input: { provider: args.provider }, outputs: [] }));
      enrollmentProvenance(started, args.machineId, jobId, args.provider);
      if (started.installationRevision !== args.installationRevision || started.artifactSha256 !== args.artifactSha256 ||
        started.resourceBindingDigest !== args.resourceBindingDigest) throw new AuthRefusal("code_auth_resources_changed");
      await waitForStart(ctx, started);
      const job = PublicJobSchema.parse(await ctx.jobs.status(nodeFor(args.machineId, started.jobId)));
      enrollmentProvenance(job, args.machineId, started.jobId, args.provider);
      await requireCurrentJob(ctx, job);
      if (job.state !== "started" || job.nextInputSeq !== 0) throw new AuthRefusal("code_auth_input_conflict");
      await ctx.jobs.input({ node: nodeFor(job.machineId, job.jobId), seq: job.nextInputSeq, data: Buffer.from(JSON.stringify({ type: "start", provider: args.provider }) + "\n").toString("base64"), eof: false });
      return PublicJobSchema.parse(await ctx.jobs.status(nodeFor(job.machineId, job.jobId)));
    } catch (reason) {
      if (cleanupTarget) {
        try { await ctx.jobs.cancel(cleanupTarget); }
        catch { return { refused: "code_auth_start_uncertain_cancel_unconfirmed" }; }
      }
      return refused(reason);
    }
  },
  async observeEnrollment(ctx: CodeContext, input: z.infer<typeof EnrollmentObserveSchema>) {
    try {
      const args = EnrollmentObserveSchema.parse(input);
      if (!(await ctx.auth.allows("jobs:read", { kind: "operation", machineId: args.machineId, operationId: AUTH_OPERATION }))) throw new AuthRefusal("code_auth_unavailable");
      let pins: z.infer<typeof EnrollmentPinsSchema> | null = null;
      try {
        const { description, installation } = await currentResources(ctx, args.machineId);
        const operation = description.operations?.[AUTH_OPERATION];
        if (operation?.ready) pins = EnrollmentPinsSchema.parse({ installationRevision: installation.revision, artifactSha256: installation.artifactSha256, resourceBindingDigest: operation.resourceBindingDigest });
      } catch { /* Read-only availability is not permission to provision resources. */ }
      const listed = await ctx.jobs.listRuns({ machineId: args.machineId, operationId: AUTH_OPERATION, limit: 50, ...(args.cursor ? { cursor: args.cursor } : {}) });
      const runs = listed.runs.flatMap(({ job }) => {
        if (job === null) return [];
        try { const provider = enrollmentProvenance(job, args.machineId, job.jobId); return [{ jobId: job.jobId, provider: provider.id, state: job.state }]; }
        catch { return []; }
      });
      let enrollment: EnrollmentState | null = null;
      if (args.jobId) {
        const job = PublicJobSchema.parse(await ctx.jobs.status(nodeFor(args.machineId, args.jobId)));
        const provider = enrollmentProvenance(job, args.machineId, args.jobId);
        enrollment = await readEnrollment(ctx, { machineId: args.machineId, jobId: args.jobId, provider: provider.id });
      }
      return EnrollmentObservationSchema.parse({ providers, pins, availability: pins ? "available" : "unavailable", runs, nextCursor: listed.nextCursor, enrollment });
    } catch (reason) { return refused(reason); }
  },
  async respondEnrollment(ctx: CodeContext, input: z.infer<typeof EnrollmentRespondSchema>) {
    try {
      const args = EnrollmentRespondSchema.parse(input);
      if (Buffer.byteLength(args.value) > 8192) throw new AuthRefusal("code_auth_invalid_callback");
      const observation = await readEnrollment(ctx, args);
      const job = observation.job;
      if (observation.state !== "challenge" || observation.prompt?.promptId !== args.promptId || job.state !== "started") throw new AuthRefusal("code_auth_stale_response");
      if (job.nextInputSeq !== args.nextInputSeq) throw new AuthRefusal("code_auth_input_conflict");
      const frame = Buffer.from(JSON.stringify({ type: "response", promptId: args.promptId, value: args.value }) + "\n");
      if (frame.length > CONTROL_FRAME_BYTES) throw new AuthRefusal("code_auth_invalid_callback");
      try {
        await ctx.jobs.input({ node: nodeFor(args.machineId, args.jobId), seq: job.nextInputSeq,
          data: frame.toString("base64"), eof: false });
      } catch { throw new AuthRefusal("code_auth_input_refused"); }
      return { accepted: true as const, jobId: job.jobId };
    } catch (reason) { return refused(reason); }
  },
  async cancelEnrollment(ctx: CodeContext, input: z.infer<typeof EnrollmentTargetSchema>) {
    try {
      const args = EnrollmentTargetSchema.parse(input);
      const job = PublicJobSchema.parse(await ctx.jobs.status(nodeFor(args.machineId, args.jobId)));
      enrollmentProvenance(job, args.machineId, args.jobId, args.provider);
      await requireCurrentJob(ctx, job);
      await ctx.jobs.cancel(nodeFor(args.machineId, args.jobId));
      return { accepted: true as const, jobId: args.jobId };
    } catch (reason) { return refused(reason); }
  },
};
