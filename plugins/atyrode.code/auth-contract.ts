import { PublicJobSchema } from "@manifold/protocol";
import { z } from "zod";
import { CODE_PLUGIN_ID } from "./contract.ts";

export const AUTH_OPERATION = `${CODE_PLUGIN_ID}.auth-enroll`;
export const AUTH_START_DOOR = `${CODE_PLUGIN_ID}.startEnrollment`;
const id = z.string().min(1).max(256);
const provider = z.string().regex(/^[a-z0-9][a-z0-9-]{0,95}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const safeText = z.string().max(2048).regex(/^[^\u0000-\u001f\u007f]*$/);
const identityText = safeText.min(1).max(512).refine(value => !/Bearer\s|eyJ[A-Za-z0-9_-]+\./i.test(value));
export const EnrollmentPinsSchema = z.strictObject({
  installationRevision: id, artifactSha256: z.string().regex(/^[a-f0-9]{64}$/), resourceBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const EnrollmentProviderSchema = z.strictObject({ id: provider, name: safeText, credentialProvider: provider, callback: z.boolean() });
export const EnrollmentWorkerRefusalSchema = z.enum([
  "invalid_control", "stale_response", "cancelled", "disconnected", "timeout", "provider_unavailable", "flow_unsupported", "api_key_unsupported",
  "prompt_unsupported", "unsafe_auth_metadata", "invalid_callback", "credential_unsupported", "enrollment_failed", "upload_failed", "service_unavailable",
]);
const authorizationUrl = z.string().max(8192).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && !/[\u0000-\u0020\u007f]/.test(value) &&
      ![...url.searchParams.keys()].some(key => /access.token|refresh.token|client.secret|authorization|api.key|password/i.test(key));
  } catch { return false; }
});
export const EnrollmentAuthSchema = z.strictObject({ type: z.literal("auth"), url: authorizationUrl, instructions: safeText, challenge: z.string().regex(/^[A-Z0-9-]{4,32}$/).optional() });
export const EnrollmentPromptSchema = z.strictObject({ type: z.literal("prompt"), promptId: z.uuid(), kind: z.literal("oauth_callback"), message: safeText });
export const EnrollmentCompleteSchema = z.strictObject({ type: z.literal("complete"), provider,
  identity: z.strictObject({ type: z.literal("oauth"), email: identityText.optional(), accountId: identityText.optional(), orgId: identityText.optional(), orgName: identityText.optional() }),
});
export const EnrollmentFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("started"), provider }), EnrollmentAuthSchema, EnrollmentPromptSchema,
  z.strictObject({ type: z.literal("prompt_closed"), promptId: z.uuid() }), EnrollmentCompleteSchema,
  z.strictObject({ type: z.literal("refused"), code: EnrollmentWorkerRefusalSchema }),
]);
export const EnrollmentStartSchema = z.strictObject({ machineId: id, provider, ...EnrollmentPinsSchema.shape });
export const EnrollmentObserveSchema = z.strictObject({ machineId: id, jobId: id.optional(), cursor: z.string().min(1).max(2048).optional() });
export const EnrollmentTargetSchema = z.strictObject({ machineId: id, jobId: id, provider });
export const EnrollmentRespondSchema = z.strictObject({ ...EnrollmentTargetSchema.shape, promptId: z.uuid(), nextInputSeq: count, value: z.string().min(1).max(8192) });
export const EnrollmentControlResultSchema = z.strictObject({ accepted: z.literal(true), jobId: id });
export const EnrollmentStateSchema = z.strictObject({
  job: PublicJobSchema, provider,
  state: z.enum(["pending", "challenge", "complete", "refused"]),
  auth: EnrollmentAuthSchema.nullable(), prompt: EnrollmentPromptSchema.nullable(), complete: EnrollmentCompleteSchema.nullable(),
  refusal: z.string().max(96).nullable(),
});
export const EnrollmentObservationSchema = z.strictObject({
  providers: z.array(EnrollmentProviderSchema).max(128), pins: EnrollmentPinsSchema.nullable(),
  availability: z.enum(["available", "unavailable"]),
  runs: z.array(z.strictObject({ jobId: id, provider, state: PublicJobSchema.shape.state })).max(50), nextCursor: z.string().nullable(),
  enrollment: EnrollmentStateSchema.nullable(),
});
export type EnrollmentProvider = z.infer<typeof EnrollmentProviderSchema>;
export type EnrollmentFrame = z.infer<typeof EnrollmentFrameSchema>;
export type EnrollmentState = z.infer<typeof EnrollmentStateSchema>;
export type EnrollmentObservation = z.infer<typeof EnrollmentObservationSchema>;
