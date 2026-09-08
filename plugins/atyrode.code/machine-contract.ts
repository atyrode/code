import { PublicJobSchema } from "@manifold/protocol";
import { z } from "zod";
import { CodeRevisionSchema, CodeSelectionSchema } from "./contract.ts";

const text = z.string();
const identity = z.string().min(1).max(512);
const timestamp = z.number().int();
const selection = CodeSelectionSchema;
const accountReference = z.strictObject({ provider: text, identityKey: text });
const disabled = z.array(accountReference);
const revision = CodeRevisionSchema;
const jobId = z.string().min(1).max(128);
const machineId = z.string().min(1).max(128);
const changeBase = { expectedRevision: revision, baselineJobId: jobId };
export const CODE_ACCOUNT_CHANGE_OPERATIONS = ["account-set", "preset-create", "preset-update", "preset-activate", "preset-delete"] as const;
export const CodeAccountChangeOperationSchema = z.enum(CODE_ACCOUNT_CHANGE_OPERATIONS);
export const CodeOperationInputSchemas = {
  inspect: z.strictObject({ expectedRevision: revision }),
  "analysis-plan": z.strictObject({ expectedRevision: revision, inspectionJobId: jobId }),
  "catalog-review": z.strictObject({ expectedRevision: revision }),
  "catalog-generate": z.strictObject({}),
  "auth-status": z.strictObject({}),
  usage: z.strictObject({}),
  "accounts-list": z.strictObject({}),
  "account-set": z.strictObject({ ...changeBase, provider: identity, identity, enabled: z.boolean() }),
  "preset-create": z.strictObject({ ...changeBase, name: z.string().min(1).max(120), disabled }),
  "preset-update": z.strictObject({ ...changeBase, name: z.string().min(1).max(120), disabled }),
  "preset-activate": z.strictObject({ ...changeBase, name: z.string().min(1).max(120) }),
  "preset-delete": z.strictObject({ ...changeBase, name: z.string().min(1).max(120) }),
  "account-clear-blocks": z.strictObject({ provider: identity, identity }),
  "account-disable": z.strictObject({ provider: identity, identity }),
  suggest: z.strictObject({ expectedRevision: revision, prompt: z.string().min(1).max(16384) }),
} as const;
export type CodeOperation = keyof typeof CodeOperationInputSchemas;
export type CodeOperationInput<K extends CodeOperation> = z.infer<(typeof CodeOperationInputSchemas)[K]>;
const AccountSchema = accountReference.extend({
  email: text.optional(), selectable: z.boolean(), enabled: z.boolean(), blocked: z.boolean(),
  blockedUntil: timestamp.optional(), restrictions: z.array(z.strictObject({ scope: text, until: timestamp })),
});
export const CodeAccountStateSchema = z.strictObject({
  schemaVersion: z.literal(1), activePreset: text,
  presets: z.array(z.strictObject({ name: text, disabled })), manualDisabled: disabled,
});
export type CodeAccountState = z.infer<typeof CodeAccountStateSchema>;
export const CodeAccountsSchema = CodeAccountStateSchema.extend({ operation: text, observedAt: timestamp, accounts: z.array(AccountSchema), baseRevision: revision });
export type CodeAccounts = z.infer<typeof CodeAccountsSchema>;
export const CodeAccountProposalSchema = CodeAccountsSchema;
export const CodeAccountViewSchema = CodeAccountsSchema.extend({
  preferenceRevision: revision, appliedJobId: jobId.nullable(),
  proposals: z.array(z.strictObject({ job: PublicJobSchema, value: CodeAccountProposalSchema })).max(CODE_ACCOUNT_CHANGE_OPERATIONS.length),
  proposalsUnavailable: z.boolean(),
});
export const CodeApplyAccountChoicesInputSchema = z.strictObject({ machineId, operation: CodeAccountChangeOperationSchema, jobId });
export type CodeApplyAccountChoicesInput = z.infer<typeof CodeApplyAccountChoicesInputSchema>;
export const CodeApplyAccountChoicesResultSchema = z.strictObject({ revision, jobId });
export type CodeApplyAccountChoicesResult = z.infer<typeof CodeApplyAccountChoicesResultSchema>;
export const CodeBlockResultSchema = z.strictObject({ schemaVersion: z.literal(1), operation: text, account: accountReference, ok: z.literal(true) });
export const CodeInspectionSchema = z.strictObject({
  schemaVersion: z.literal(1), observedAt: timestamp, baseRevision: revision, catalogRevision: text.min(1), selection,
  facets: z.array(z.strictObject({ key: text, values: z.array(text) })),
  routing: z.array(z.strictObject({ role: text, agentBacked: z.boolean(), lead: text, fallback: z.array(text) })),
  estimates: z.strictObject({ costScore: z.number().int(), speedScore: z.number().int(), scaleMin: z.literal(1), scaleMax: z.literal(5) }),
  ready: z.boolean(), refusals: z.array(text),
});
export type CodeInspection = z.infer<typeof CodeInspectionSchema>;
export const CodeAnalysisPlanSchema = CodeInspectionSchema.extend({ configYaml: text, flags: z.array(text), accountPool: z.record(text, z.array(text)) });
const UsageAccountSchema = AccountSchema.extend({
  status: text,
  snapshotStatus: text,
  faultAt: timestamp.optional(),
  windows: z.array(z.strictObject({
    windowId: text, label: text, tier: text.optional(),
    usedPercent: z.number().int(), resetsAt: timestamp,
    durationSeconds: z.number().int(), observedAt: timestamp, status: text,
  })),
  resetCredits: z.strictObject({
    available: z.number().int(), expiresAt: z.array(timestamp),
  }).optional(),
});

export const CodeUsageSchema = z.strictObject({
  schemaVersion: z.literal(1),
  baseRevision: revision,
  requestedAt: timestamp,
  observedAt: timestamp,
  status: text,
  usageRefresh: text,
  accountRefresh: text,
  activePreset: text,
  providers: z.array(z.strictObject({
    provider: text, status: text,
    buckets: z.array(z.strictObject({ name: text, status: text, resetsAt: timestamp.optional() })),
    accounts: z.array(UsageAccountSchema),
  })),
  balances: z.array(z.strictObject({
    provider: text, status: text, currency: text.optional(),
    totalBalance: text.optional(), observedAt: timestamp.optional(),
  })),
});
export type CodeUsage = z.infer<typeof CodeUsageSchema>;

export const CodeSuggestionSchema = z.strictObject({
  schemaVersion: z.literal(1), observedAt: timestamp, baseRevision: revision, catalogRevision: text.min(1), evaluator: text,
  actions: z.array(z.strictObject({ key: text, value: text })), selection,
});
export type CodeSuggestion = z.infer<typeof CodeSuggestionSchema>;
export const CodeGenerationSchema = z.strictObject({ schemaVersion: z.literal(1), modelsYaml: text.min(1), probed: z.literal(true) });
export const CodeOperationResultSchemas = {
  inspect: CodeInspectionSchema, "analysis-plan": CodeAnalysisPlanSchema, "catalog-review": CodeInspectionSchema,
  "catalog-generate": CodeGenerationSchema, "auth-status": z.strictObject({ ok: z.boolean(), version: text.optional() }),
  usage: CodeUsageSchema, "accounts-list": CodeAccountsSchema,
  "account-set": CodeAccountProposalSchema, "preset-create": CodeAccountProposalSchema,
  "preset-update": CodeAccountProposalSchema, "preset-activate": CodeAccountProposalSchema, "preset-delete": CodeAccountProposalSchema,
  "account-clear-blocks": CodeBlockResultSchema, "account-disable": CodeBlockResultSchema, suggest: CodeSuggestionSchema,
} as const;
export type CodeOperationResult<K extends CodeOperation> = z.infer<(typeof CodeOperationResultSchemas)[K]>;
export const CODE_RUN_DOOR = "atyrode.code.run";
export const CODE_OBSERVE_DOOR = "atyrode.code.observe";
export const CODE_APPLY_ACCOUNT_CHOICES_DOOR = "atyrode.code.applyAccountChoices";
export const CODE_JOB_TOPIC = { kind: "plugin", pluginId: "engine.jobs" } as const;
export const CodeOperationSchema = z.enum(Object.keys(CodeOperationInputSchemas) as [CodeOperation, ...CodeOperation[]]);
function requestSchema<N extends CodeOperation, S extends z.ZodType>(operation: N, input: S) {
  return z.strictObject({ machineId, operation: z.literal(operation), input });
}
export const CodeRunInputSchema = z.discriminatedUnion("operation", [
  requestSchema("inspect", CodeOperationInputSchemas["inspect"]),
  requestSchema("analysis-plan", CodeOperationInputSchemas["analysis-plan"]),
  requestSchema("catalog-review", CodeOperationInputSchemas["catalog-review"]),
  requestSchema("catalog-generate", CodeOperationInputSchemas["catalog-generate"]),
  requestSchema("auth-status", CodeOperationInputSchemas["auth-status"]),
  requestSchema("usage", CodeOperationInputSchemas["usage"]),
  requestSchema("accounts-list", CodeOperationInputSchemas["accounts-list"]),
  requestSchema("account-set", CodeOperationInputSchemas["account-set"]),
  requestSchema("preset-create", CodeOperationInputSchemas["preset-create"]),
  requestSchema("preset-update", CodeOperationInputSchemas["preset-update"]),
  requestSchema("preset-activate", CodeOperationInputSchemas["preset-activate"]),
  requestSchema("preset-delete", CodeOperationInputSchemas["preset-delete"]),
  requestSchema("account-clear-blocks", CodeOperationInputSchemas["account-clear-blocks"]),
  requestSchema("account-disable", CodeOperationInputSchemas["account-disable"]),
  requestSchema("suggest", CodeOperationInputSchemas["suggest"]),
]);
export type CodeRunInput = z.infer<typeof CodeRunInputSchema>;
export const CodeObserveInputSchema = z.strictObject({ machineId, operation: CodeOperationSchema, jobId: jobId.optional() });
export type CodeObserveInput = z.infer<typeof CodeObserveInputSchema>;
function observationSchema<N extends CodeOperation, S extends z.ZodType>(operation: N, value: S) {
  return z.strictObject({ operation: z.literal(operation), state: z.enum(["empty", "pending", "ready", "failed", "unavailable"]),
    latest: PublicJobSchema.nullable(), snapshot: z.strictObject({ job: PublicJobSchema, value }).nullable(),
    failure: z.enum(["operation_failed", "output_unavailable", "invalid_result", "stale_preferences"]).nullable() });
}
export const CodeObservationSchema = z.discriminatedUnion("operation", [
  observationSchema("inspect", CodeOperationResultSchemas["inspect"]),
  observationSchema("analysis-plan", CodeOperationResultSchemas["analysis-plan"]),
  observationSchema("catalog-review", CodeOperationResultSchemas["catalog-review"]),
  observationSchema("catalog-generate", CodeOperationResultSchemas["catalog-generate"]),
  observationSchema("auth-status", CodeOperationResultSchemas["auth-status"]),
  observationSchema("usage", CodeOperationResultSchemas["usage"]),
  observationSchema("accounts-list", CodeAccountViewSchema),
  observationSchema("account-set", CodeOperationResultSchemas["account-set"]),
  observationSchema("preset-create", CodeOperationResultSchemas["preset-create"]),
  observationSchema("preset-update", CodeOperationResultSchemas["preset-update"]),
  observationSchema("preset-activate", CodeOperationResultSchemas["preset-activate"]),
  observationSchema("preset-delete", CodeOperationResultSchemas["preset-delete"]),
  observationSchema("account-clear-blocks", CodeOperationResultSchemas["account-clear-blocks"]),
  observationSchema("account-disable", CodeOperationResultSchemas["account-disable"]),
  observationSchema("suggest", CodeOperationResultSchemas["suggest"]),
]);
export type CodeObservation = z.infer<typeof CodeObservationSchema>;

const source = z.strictObject({ operation: text.min(1), jobId });
export const CodeCatalogSchema = z.strictObject({
  catalogRevision: text.min(1).max(128), modelsYaml: text.min(1).max(100000),
  generation: source.nullable(), review: source.nullable(),
});
export const CodeConfigurationSchema = z.strictObject({
  schemaVersion: z.literal(2), machineId, revision: revision.refine((value) => value > 0),
  state: CodeAccountStateSchema, choiceSource: source.nullable(),
  active: CodeCatalogSchema.nullable(), draft: CodeCatalogSchema.nullable(), selection: selection.nullable(),
  resourcePins: z.strictObject({
    installationRevision: text.min(1), artifactSha256: text.regex(/^[a-f0-9]{64}$/),
    operations: z.record(text, text.regex(/^[a-f0-9]{64}$/)),
  }).nullable(),
  updatedBy: text.min(1),
});
export type CodeConfiguration = z.infer<typeof CodeConfigurationSchema>;
export const CodeConfigurationReadInputSchema = z.strictObject({ machineId });
export const CodeConfigurationReadSchema = z.strictObject({
  status: z.enum(["missing", "transition_required", "ready"]), revision,
  configuration: CodeConfigurationSchema.nullable(), previousChoices: CodeAccountStateSchema.nullable(),
});
export const CodeInitializeInputSchema = z.strictObject({ machineId, expectedRevision: revision });
export const CodeStageInputSchema = z.strictObject({ machineId, expectedRevision: revision,
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("edit"), modelsYaml: text.min(1).max(100000) }),
    z.strictObject({ kind: z.literal("generation"), jobId }),
  ]),
});
export const CodePromoteInputSchema = z.strictObject({ machineId, expectedRevision: revision, reviewJobId: jobId });
export const CodeSelectInputSchema = z.strictObject({ machineId, expectedRevision: revision, selection });
