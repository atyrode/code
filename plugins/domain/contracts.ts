import { z } from "zod";

export const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine(value => !["constructor", "prototype", "__proto__"].includes(value));
export const epochMilliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const ThinkingLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;
export const CapabilitySchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const LaneSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("mixed") }),
  z.strictObject({ kind: z.literal("provider"), family: identifier, blend: z.enum(["led", "only"]) }),
]);
export const SelectionSchema = z.strictObject({
  lane: LaneSchema,
  capability: CapabilitySchema,
  thinking: ThinkingLevelSchema,
  advisor: z.enum(["off", "glance", "review", "audit"]),
  spark: z.boolean(),
  priority: z.boolean(),
  prewalk: z.boolean(),
  planYolo: z.boolean(),
  fallback: z.boolean(),
});
export type Selection = z.infer<typeof SelectionSchema>;
export type Lane = z.infer<typeof LaneSchema>;

/** Provider identity is explicit; a model name or presentation label never selects it. */
export const CatalogModelSchema = z.strictObject({
  key: identifier,
  provider: identifier,
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,511}$/),
  api: identifier,
  tier: z.union([z.literal(0), CapabilitySchema]),
  quotaBucket: identifier.nullable(),
  inputCostPerMillion: z.number().finite().nonnegative(),
  outputCostPerMillion: z.number().finite().nonnegative(),
  tokensPerSecond: z.number().finite().nonnegative().nullable(),
  timeToFirstTokenMs: z.number().finite().nonnegative().nullable(),
  contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  thinkingLevels: z.array(ThinkingLevelSchema).min(1).max(6),
  images: z.boolean(),
});
export const CatalogDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  models: z.array(CatalogModelSchema).min(1).max(1024),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export type CatalogDocument = z.infer<typeof CatalogDocumentSchema>;
export const ModelChoiceSchema = z.strictObject({ key: identifier, thinking: ThinkingLevelSchema });
export const RouteSchema = z.strictObject({
  role: identifier,
  agentBacked: z.boolean(),
  lead: ModelChoiceSchema,
  fallback: z.array(ModelChoiceSchema).max(32),
});
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;
export type Route = z.infer<typeof RouteSchema>;
export const EstimatesSchema = z.strictObject({
  costScore: z.number().int().min(1).max(5),
  speedScore: z.number().int().min(1).max(5),
});
export type Estimates = z.infer<typeof EstimatesSchema>;

export interface ProviderPolicy {
  readonly family: string;
  readonly providers: readonly string[];
  readonly label: string;
  readonly accountLabel: string;
  readonly requiredLadder: boolean;
  readonly meteredProviders: readonly string[];
  readonly quotaBucketBase: string;
  readonly crossTo: string;
  readonly special: readonly { readonly facet: "spark"; readonly tier: 0; readonly bucket: string }[];
  readonly priority?: { readonly key: string; readonly value: string; readonly costMultiplier: number; readonly speedMultiplier: number };
  readonly offPeak?: { readonly startMinutesUtc: number; readonly endMinutesUtc: number; readonly multiplier: number };
}

/** Only the final OMP boundary turns structured routes into its model-reference strings. */
export interface OmpOverlay {
  modelRoles: Record<string, string>;
  retry: {
    enabled: true;
    modelFallback: boolean;
    fallbackRevertPolicy?: "cooldown-expiry";
    fallbackChains?: Record<string, string[]>;
  };
  task?: { agentModelOverrides?: Record<string, string>; agentAdvisor?: { task: "on" }; prewalk?: true };
  prewalk?: { enabled: true };
  defaultThinkingLevel: ThinkingLevel;
  advisor: { enabled: boolean };
  tier?: Record<string, string>;
}

const accountScope = z.string().min(1).max(1024);
const identityKey = z.string().min(1).max(1024);
const credentialId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** An API key has no OAuth identity key; its native service-scoped credential slot is explicit. */
export const AccountReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("identity"), scope: accountScope, provider: identifier, identityKey }),
  z.strictObject({ kind: z.literal("credential"), scope: accountScope, provider: identifier, credentialId }),
]);
export type AccountReference = z.infer<typeof AccountReferenceSchema>;
export const AccountPresetSchema = z.strictObject({
  id: identifier,
  name: z.string().trim().min(1).max(120),
  disabled: z.array(AccountReferenceSchema).max(1024),
});
export const AccountChoicesSchema = z.strictObject({
  activePreset: identifier.nullable(),
  manualDisabled: z.array(AccountReferenceSchema).max(1024),
  presets: z.array(AccountPresetSchema).max(128),
});
export type AccountChoices = z.infer<typeof AccountChoicesSchema>;
export const AccountChoiceChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("set-account"), reference: AccountReferenceSchema, enabled: z.boolean() }),
  z.strictObject({ kind: z.literal("create-preset"), preset: AccountPresetSchema }),
  z.strictObject({ kind: z.literal("update-preset"), preset: AccountPresetSchema }),
  z.strictObject({ kind: z.literal("activate-preset"), id: identifier.nullable() }),
  z.strictObject({ kind: z.literal("delete-preset"), id: identifier }),
]);
export type AccountChoiceChange = z.infer<typeof AccountChoiceChangeSchema>;
export const AccountRecordSchema = z.strictObject({
  reference: AccountReferenceSchema,
  credentialId,
  type: z.enum(["oauth", "api_key"]),
  identityKey: identityKey.nullable(),
  email: z.string().max(512).nullable(),
  disabled: z.boolean(),
  blocks: z.array(z.strictObject({ scope: z.string().max(128), until: epochMilliseconds })).max(64),
});
export type AccountRecord = z.infer<typeof AccountRecordSchema>;
export const AccountsObservationSchema = z.strictObject({
  scope: accountScope,
  observedAt: epochMilliseconds.nullable(),
  status: z.enum(["fresh", "stale", "unavailable"]),
  accounts: z.array(AccountRecordSchema).max(1024),
});
export type AccountsObservation = z.infer<typeof AccountsObservationSchema>;
/** A launch freezes concrete slots and their observed identities, never an open-ended provider pool. */
export const RuntimeAccountPoolSchema = z.record(identifier, z.array(z.strictObject({
  credentialId,
  identityKey: identityKey.nullable(),
})).max(1024)).refine(value => Object.keys(value).length <= 64);
export type RuntimeAccountPool = z.infer<typeof RuntimeAccountPoolSchema>;
