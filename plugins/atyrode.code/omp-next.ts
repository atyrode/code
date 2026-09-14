/**
 * THE OMP DOORS THIS PIN DOES NOT PUBLISH YET.
 *
 * `package.json` pins `@atyrode/manifold-omp` at 19223eb, which publishes `reviewSession` and
 * `prepareSession` but not the job-shaped pair (manifold-omp#24, open as PR #26, head
 * e70d224). The two door names and the receipt below mirror that branch's `plugins/api`
 * verbatim — `index.ts` for the doors, `session.ts` for `SessionReceiptSchema`. Everything
 * else the doors take is already published at the pin and is imported rather than copied:
 * `SessionInputSchema` is exactly the input `reviewSession` already takes.
 *
 * Delete this file when the pin moves to a commit carrying manifold-omp#24: the action names
 * become the OMP client's own, and the receipt is imported from `@atyrode/manifold-omp`.
 */
import { PublicJobSchema } from "@manifold/protocol";
import { SessionInputSchema, TargetSchema, digest, identifier, modelId } from "@atyrode/manifold-omp";
import { z } from "zod";

export const RUN_SESSION_ACTION = "runSession";
export const READ_SESSION_ACTION = "readSession";
/** The receipt quotes the agent's last words, never the whole transcript. */
const SESSION_MESSAGE_LIMIT = 16384;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().finite().nonnegative();
export const SessionUsageSchema = z.strictObject({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  cost: amount.optional(),
});
/** Bounded summary of one governed OMP run, read from the transcript the job retained. */
export const SessionReceiptSchema = z.strictObject({
  sessionId: identifier,
  sessionPath: z.string().min(1).max(4096),
  model: modelId,
  finalMessage: z.string().max(SESSION_MESSAGE_LIMIT),
  usage: SessionUsageSchema.nullable(),
  exitCode: z.number().int(),
});
export type SessionReceipt = z.infer<typeof SessionReceiptSchema>;
/** `prepareSession`'s input and reviewed digest, placed as a job instead of a terminal. */
export const OmpRunSessionInputSchema = SessionInputSchema.extend({ reviewDigest: digest });
export const OmpReadSessionInputSchema = TargetSchema.extend({ jobId: z.string().min(1).max(128) });
export const OmpSessionSchema = z.strictObject({ job: PublicJobSchema, session: SessionReceiptSchema });
