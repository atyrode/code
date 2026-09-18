import { z } from "zod";
import { AccountReferenceSchema, AccountsObservationSchema, ThinkingLevelSchema, identifier } from "@atyrode/manifold-omp";

export class DomainError extends Error {
  constructor(readonly code: "invalid_catalog" | "invalid_selection" | "invalid_accounts" |
    "invalid_choices" | "account_unavailable" | "preset_exists" | "preset_missing" | "invalid_usage" |
    "budget_unsatisfiable") {
    super(`code_${code}`);
  }
}

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
  /**
   * WHAT MAY BE SPENT, stated as a property rather than as the models that happen to satisfy it.
   *
   * `free` admits only models whose input AND output price per million are zero; `any` admits
   * the catalog. It is a constraint and not a preference: a selection no admitted model can
   * serve refuses `budget_unsatisfiable` rather than resolving to the cheapest paid model, which
   * is the difference between "we are not spending" and "we thought we were not spending".
   *
   * `free` rather than a numeric ceiling because a single number would have to say WHICH number
   * it bounds — input, output, or the 0.25/0.75 blend `estimate` scores with, before or after
   * the thinking, priority and off-peak multipliers that only exist in that pass — and that
   * choice would then live in code rather than in the selection. "Costs nothing" needs no such
   * rule, and a free tier's real limit is a request rate rather than a price, so this is also
   * where rate-aware routing would hang if it is ever needed.
   *
   * Defaulted, so a selection persisted before this existed parses as `any` and nothing has to
   * be migrated to keep meaning what it meant.
   */
  budget: z.enum(["free", "any"]).default("any"),
});
export type Selection = z.infer<typeof SelectionSchema>;
export type Lane = z.infer<typeof LaneSchema>;

/**
 * THE BUDGET'S ADMISSION TEST, in one place because two copies of "free" can disagree.
 *
 * Selection admits by this at routing time and derivation builds the ladder from it, so a
 * catalog derived for a budget is a catalog that budget can actually serve. Priced per million
 * on both sides: a model that charges for output is not free because its input is.
 */
export function admittedBy(
  budget: Selection["budget"],
  model: { readonly inputCostPerMillion: number; readonly outputCostPerMillion: number },
): boolean {
  return budget === "any" || (model.inputCostPerMillion === 0 && model.outputCostPerMillion === 0);
}

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
  readonly crossTo: string | null;
  readonly special: readonly { readonly facet: "spark"; readonly tier: 0; readonly bucket: string }[];
  readonly priority?: { readonly key: string; readonly value: string; readonly costMultiplier: number; readonly speedMultiplier: number };
  readonly offPeak?: { readonly startMinutesUtc: number; readonly endMinutesUtc: number; readonly multiplier: number };
}

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
  z.strictObject({ kind: z.literal("rebind-scope"), previous: AccountsObservationSchema, current: AccountsObservationSchema }),
]);
export type AccountChoiceChange = z.infer<typeof AccountChoiceChangeSchema>;
