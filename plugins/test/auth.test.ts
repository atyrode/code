import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJobJson, PublicJobSchema, type JobFollowSnapshot, type PublicJob } from "@manifold/protocol";
import { authHandlers, enrollmentProvenance, EnrollmentTranscript, readEnrollmentFollow } from "../atyrode.code/auth-server.ts";
import { AUTH_OPERATION, AUTH_START_DOOR, type EnrollmentFrame } from "../atyrode.code/auth-contract.ts";
import type { CodeContext } from "../atyrode.code/machine-server.ts";

const pins = { installationRevision: "install-1", artifactSha256: "a".repeat(64), resourceBindingDigest: "d".repeat(64) };
const promptId = "ab439cff-4dc7-4c19-bd68-6b822b27e765";
const anotherPromptId = "94705fe9-1be2-46d9-8a35-b4bf1027c9bc";
const frames: EnrollmentFrame[] = [
  { type: "started", provider: "anthropic" },
  { type: "auth", url: "https://claude.ai/oauth/authorize?state=fixture-state", instructions: "Complete provider authorization." },
  { type: "prompt", promptId, kind: "oauth_callback", message: "Paste the final callback including state." },
];
const encode = (values: readonly EnrollmentFrame[]) => Buffer.from(values.map(value => JSON.stringify(value) + "\n").join(""));
function job(jobId = "auth-job"): PublicJob {
  return PublicJobSchema.parse({ jobId, machineId: "m1", operationId: AUTH_OPERATION, pluginId: "atyrode.code", ...pins,
    inputDigest: createHash("sha256").update(canonicalJobJson({ provider: "anthropic" })).digest("hex"), nextInputSeq: 1,
    state: "started", result: null,
    authority: { origin: { kind: "action", traceId: `trace-${jobId}`, door: AUTH_START_DOOR }, requester: "p1",
      executor: { machineId: "m1", ownerId: "owner", ownerGeneration: 1 }, decision: null },
  });
}
function snapshot(job: PublicJob, bytes = encode(frames)): JobFollowSnapshot {
  return { jobId: job.jobId, state: job.state, result: job.result, firstSeq: 1, seq: 1, unavailable: null,
    events: [{ seq: 1, event: { type: "output", jobId: job.jobId, outputId: "stdout", requestId: job.jobId, seq: 1, data: bytes.toString("base64"), eof: false } }],
  };
}
function fixture() {
  let current = job();
  let bytes = encode(frames);
  const state = { readsAllowed: true, binding: pins.resourceBindingDigest, inputConflict: false, acceptedResponses: 0, attempts: 0, cancels: 0, gap: false };
  const unavailable = async (): Promise<never> => { throw new Error("Not part of enrollment state"); };
  const ctx: CodeContext = {
    auth: { principal: { id: "p1", kind: "human", name: "Tester", color: "#123456" }, caps: ["machines:run", "jobs:read", "jobs:input", "jobs:cancel"],
      containerScope: null, isRoot: false, allows: async () => state.readsAllowed },
    storage: { pluginId: "atyrode.code", get: unavailable, set: unavailable, delete: unavailable, keys: unavailable, compareAndSet: unavailable },
    newId: async () => "auth-job", emit() {},
    jobs: {
      describe: async () => ({ machineId: "m1", pluginId: "atyrode.code", connected: true, platforms: ["linux-amd64"], admissionPublicKey: "-----BEGIN PUBLIC KEY-----test",
        installation: { revision: pins.installationRevision, artifactSha256: pins.artifactSha256, enabled: true, ready: true, purgeRequested: false }, retainedInstallations: [], consents: [],
        operations: { [AUTH_OPERATION]: { ready: true, reason: null, resourceBindingDigest: state.binding } } }),
      execute: async args => {
        current = { ...job(args.jobId), inputDigest: createHash("sha256").update(canonicalJobJson(args.input)).digest("hex"), nextInputSeq: 0 };
        bytes = Buffer.alloc(0);
        return current;
      },
      status: async node => {
        if (!state.readsAllowed || node.jobId !== current.jobId) throw new Error("Native current authority denied");
        return { ...current };
      },
      listRuns: async () => ({ runs: state.readsAllowed ? [{ job: current, occurrence: null }] : [], nextCursor: null }),
      follow: async node => {
        if (!state.readsAllowed || node.jobId !== current.jobId) throw new Error("Native current authority denied");
        const view = snapshot(current, bytes);
        if (state.gap) view.unavailable = { fromSeq: 1, toSeq: 1 };
        return { snapshot: view, close: async () => {} };
      },
      input: async args => {
        state.attempts++;
        if (state.inputConflict || args.seq !== current.nextInputSeq || current.state !== "started") throw new Error("Native sequence conflict");
        current = { ...current, nextInputSeq: args.seq + 1 };
        const frame = JSON.parse(Buffer.from(args.data, "base64").toString());
        if (frame.type === "response") {
          state.acceptedResponses++;
          bytes = Buffer.concat([bytes, encode([{ type: "prompt_closed", promptId }])]);
        } else if (frame.type === "start") bytes = encode(frames);
        return { accepted: true as const };
      },
      cancel: async node => {
        if (!state.readsAllowed || node.jobId !== current.jobId) throw new Error("Native cancellation denied");
        state.cancels++; current = { ...current, state: "cancelled" };
      },
      output: async ({ node, offset, maxBytes }) => {
        if (!state.readsAllowed || node.jobId !== current.jobId) throw new Error("Native current output authority denied");
        const chunk = bytes.subarray(offset, offset + maxBytes);
        return { type: "output", jobId: current.jobId, outputId: node.outputId, requestId: "read", seq: offset,
          data: chunk.toString("base64"), eof: offset + chunk.length === bytes.length };
      },
    },
  };
  function finish(exitCode = 0) {
    bytes = encode([...frames, { type: "prompt_closed", promptId }, { type: "complete", provider: "anthropic", identity: { type: "oauth", email: "fresh@example.test" } }]);
    current = PublicJobSchema.parse({ ...current, state: "exited", result: {
      jobId: current.jobId, requestDigest: "b".repeat(64), ownerId: "owner", ownerGeneration: 1, state: "exited", exitCode, reason: null,
      startedAt: 1000, finishedAt: 1100, usage: null,
      limits: { timeoutMs: 300000, memoryBytes: 536870912, processes: 32, outputBytes: 262144 },
      outputs: [{ outputId: "sealed-stdout", name: "stdout", bytes: bytes.length, files: 1, sha256: createHash("sha256").update(bytes).digest("hex") }],
    } });
  }
  return { ctx, state, finish, current: () => current, replace: (value: PublicJob) => { current = value; } };
}
const response = { machineId: "m1", jobId: "auth-job", provider: "anthropic", promptId, nextInputSeq: 1, value: "code=fixture-code&state=fixture-state" };

describe("governed native OAuth controls", () => {
  test("only exact governed provider provenance can expose a callback or accept controls", async () => {
    const f = fixture();
    const forged = job();
    if (forged.authority.origin.kind !== "action") throw new Error("fixture");
    forged.authority.origin.door = "engine.jobs.execute";
    f.replace(forged);
    expect(await authHandlers.respondEnrollment(f.ctx, response)).toEqual({ refused: "code_auth_provenance" });
    expect(await authHandlers.cancelEnrollment(f.ctx, { machineId: "m1", jobId: "auth-job", provider: "anthropic" })).toEqual({ refused: "code_auth_provenance" });
    expect(f.state.acceptedResponses).toBe(0);
    expect(f.state.cancels).toBe(0);
    expect(() => enrollmentProvenance(job(), "m1", "other-job", "anthropic")).toThrow("code_auth_provenance");
    expect(() => enrollmentProvenance(job(), "m1", "auth-job", "openai-codex")).toThrow("code_auth_provenance");
  });

  test("start pins native resources and recovers the active enrollment from jobs without storage", async () => {
    const f = fixture();
    expect(await authHandlers.startEnrollment(f.ctx, { machineId: "m1", provider: "anthropic", ...pins, resourceBindingDigest: "e".repeat(64) })).toEqual({ refused: "code_auth_resources_changed" });
    const started = await authHandlers.startEnrollment(f.ctx, { machineId: "m1", provider: "anthropic", ...pins });
    expect(started).toMatchObject({ jobId: "auth-job", nextInputSeq: 1 });
    const observed = await authHandlers.observeEnrollment(f.ctx, { machineId: "m1", jobId: "auth-job" });
    expect(observed).toMatchObject({ enrollment: { state: "challenge", provider: "anthropic", prompt: { promptId } }, runs: [{ jobId: "auth-job", state: "started" }] });
  });

  test("stale and cross-job responses cannot satisfy the current request", async () => {
    const f = fixture();
    expect(await authHandlers.respondEnrollment(f.ctx, { ...response, promptId: anotherPromptId })).toEqual({ refused: "code_auth_stale_response" });
    expect(await authHandlers.respondEnrollment(f.ctx, { ...response, jobId: "another-job" })).toEqual({ refused: "code_auth_unavailable" });
    expect(f.state.acceptedResponses).toBe(0);
    expect(await authHandlers.respondEnrollment(f.ctx, response)).toEqual({ accepted: true, jobId: "auth-job" });
    expect(await authHandlers.respondEnrollment(f.ctx, response)).toEqual({ refused: "code_auth_stale_response" });
    expect(f.state.acceptedResponses).toBe(1);
  });

  test("unknown or competing native input sequences refuse without replaying a callback", async () => {
    const f = fixture();
    f.replace({ ...f.current(), nextInputSeq: null });
    expect(await authHandlers.respondEnrollment(f.ctx, response)).toEqual({ refused: "code_auth_input_unconfirmed" });
    expect(f.state.attempts).toBe(0);
    f.replace({ ...f.current(), nextInputSeq: 1 });
    expect(await authHandlers.respondEnrollment(f.ctx, { ...response, nextInputSeq: 0 })).toEqual({ refused: "code_auth_input_conflict" });
    expect(f.state.attempts).toBe(0);
    f.state.inputConflict = true;
    expect(await authHandlers.respondEnrollment(f.ctx, response)).toEqual({ refused: "code_auth_input_refused" });
    expect(f.state.attempts).toBe(1);
    expect(f.state.acceptedResponses).toBe(0);
  });

  test("authority revocation and changed resource bindings disable previously observed callbacks", async () => {
    const f = fixture();
    f.state.readsAllowed = false;
    expect(await authHandlers.respondEnrollment(f.ctx, response)).toEqual({ refused: "code_auth_unavailable" });
    f.state.readsAllowed = true; f.state.binding = "e".repeat(64);
    expect(await authHandlers.respondEnrollment(f.ctx, response)).toEqual({ refused: "code_auth_resources_changed" });
    expect(f.state.acceptedResponses).toBe(0);
  });

  test("cancellation remains possible with gapped worker history and removes callback availability", async () => {
    const f = fixture(); f.state.gap = true;
    expect(await authHandlers.respondEnrollment(f.ctx, response)).toEqual({ refused: "code_auth_history_incomplete" });
    expect(await authHandlers.cancelEnrollment(f.ctx, { machineId: "m1", jobId: "auth-job", provider: "anthropic" })).toEqual({ accepted: true, jobId: "auth-job" });
    expect(f.state.cancels).toBe(1);
    expect(await authHandlers.observeEnrollment(f.ctx, { machineId: "m1", jobId: "auth-job" })).toMatchObject({ enrollment: { state: "refused", refusal: "native_cancelled", prompt: null } });
    expect(await authHandlers.respondEnrollment(f.ctx, response)).toEqual({ refused: "code_auth_stale_response" });
    expect(f.state.acceptedResponses).toBe(0);
  });
});

describe("safe enrollment output history", () => {
  test("completion requires both sealed safe output and successful native exit", async () => {
    const f = fixture(); f.finish();
    expect(await authHandlers.observeEnrollment(f.ctx, { machineId: "m1", jobId: "auth-job" })).toMatchObject({
      enrollment: { state: "complete", auth: null, prompt: null, complete: { provider: "anthropic", identity: { email: "fresh@example.test" } } },
    });
    f.finish(1);
    expect(await authHandlers.observeEnrollment(f.ctx, { machineId: "m1", jobId: "auth-job" })).toEqual({ refused: "code_auth_completion_unconfirmed" });
    f.finish();
    const current = f.current();
    current.result!.outputs[0]!.sha256 = "f".repeat(64);
    f.replace(current);
    expect(await authHandlers.observeEnrollment(f.ctx, { machineId: "m1", jobId: "auth-job" })).toEqual({ refused: "code_auth_history_invalid" });
  });

  test("split UTF-8 is decoded only at complete frames; incomplete terminal history cannot complete", () => {
    const current = job(); const provider = enrollmentProvenance(current, "m1", "auth-job");
    const transcript = new EnrollmentTranscript(provider);
    const bytes = encode([frames[0]!, { ...frames[1]!, instructions: "Complete café authorization." } as EnrollmentFrame]);
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    transcript.push(bytes.subarray(0, split));
    expect(transcript.state(current)).toMatchObject({ state: "pending", prompt: null, auth: null });
    expect(() => transcript.state({ ...current, state: "interrupted" })).toThrow("code_auth_history_incomplete");
    transcript.push(bytes.subarray(split));
    expect(transcript.state(current)).toMatchObject({ state: "challenge", auth: { instructions: "Complete café authorization." } });
  });

  test("gaps, cross-job output and malformed frames never expose a prompt", () => {
    const current = job(); const provider = enrollmentProvenance(current, "m1", "auth-job");
    const gap = snapshot(current); gap.unavailable = { fromSeq: 1, toSeq: 1 };
    expect(() => readEnrollmentFollow(current, provider, gap)).toThrow("code_auth_history_incomplete");
    const crossJob = snapshot(job("other-job")); crossJob.jobId = current.jobId;
    expect(() => readEnrollmentFollow(current, provider, crossJob)).toThrow("code_auth_history_invalid");
    const streamGap = snapshot(current); const event = streamGap.events[0]!.event;
    if (event.type !== "output") throw new Error("fixture");
    event.seq = 2;
    expect(() => readEnrollmentFollow(current, provider, streamGap)).toThrow("code_auth_history_invalid");
    expect(() => readEnrollmentFollow(current, provider, snapshot(current, Buffer.from('{"type":"prompt","access_token":"not-public"}\n')))).toThrow("code_auth_history_invalid");
    expect(() => readEnrollmentFollow(current, provider, snapshot(current, Buffer.from([0xff, 10])))).toThrow("code_auth_history_invalid");
  });

  test("a closed request cannot reopen under its old ID or finish as a different provider", () => {
    const current = job(); const provider = enrollmentProvenance(current, "m1", "auth-job");
    expect(() => readEnrollmentFollow(current, provider, snapshot(current, encode([...frames, { type: "prompt_closed", promptId }, frames[2]!])))).toThrow("code_auth_history_invalid");
    expect(() => readEnrollmentFollow(current, provider, snapshot(current, encode([...frames, { type: "prompt_closed", promptId }, { type: "complete", provider: "openai-codex", identity: { type: "oauth" } }])))).toThrow("code_auth_history_invalid");
  });
});
