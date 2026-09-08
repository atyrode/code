import { PublicJobSchema } from "@manifold/protocol";
import { z } from "zod";
import { CodeSelectionSchema } from "./contract.ts";

const text = z.string();
const identity = z.string().min(1).max(512);
const timestamp = z.number().int();
const selection = CodeSelectionSchema;
const accountReference = z.strictObject({ provider: text, identityKey: text });
const disabled = z.array(accountReference);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const jobId = z.string().min(1).max(128);
const changeBase = { expectedRevision: revision, baselineJobId: jobId };
const accountSource = z.enum(["plugin", "machine"]);
export const CODE_ACCOUNT_CHANGE_OPERATIONS = [
  "account-set", "preset-create", "preset-update", "preset-activate", "preset-delete", "account-import",
] as const;
export const CodeAccountChangeOperationSchema = z.enum(CODE_ACCOUNT_CHANGE_OPERATIONS);

/** Code validates product choices; Manifold validates who may run the declared operation. */
export const CodeOperationInputSchemas = {
  inspect: z.strictObject({ selection: selection.optional(), accountSource }),
  usage: z.strictObject({}),
  "accounts-list": z.strictObject({}),
  "account-import": z.strictObject({}),
  "account-set": z.strictObject({ ...changeBase, provider: identity, identity, enabled: z.boolean() }),
  "preset-create": z.strictObject({ ...changeBase, name: z.string().min(1).max(120), disabled }),
  "preset-update": z.strictObject({ ...changeBase, name: z.string().min(1).max(120), disabled }),
  "preset-activate": z.strictObject({ ...changeBase, name: z.string().min(1).max(120) }),
  "preset-delete": z.strictObject({ ...changeBase, name: z.string().min(1).max(120) }),
  "account-clear-blocks": z.strictObject({ provider: identity, identity }),
  suggest: z.strictObject({ selection: selection.optional(), prompt: z.string().min(1).max(16384), accountSource }),
} as const;
export type CodeOperation = keyof typeof CodeOperationInputSchemas;
export type CodeOperationInput<K extends CodeOperation> = z.infer<(typeof CodeOperationInputSchemas)[K]>;

const AccountSchema = accountReference.extend({
  // An unselectable account can legitimately have no public identity selector.
  email: text.optional(),
  selectable: z.boolean(),
  enabled: z.boolean(),
  blocked: z.boolean(),
  blockedUntil: timestamp.optional(),
  restrictions: z.array(z.strictObject({ scope: text, until: timestamp })),
});

export const CodeAccountsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: text,
  observedAt: timestamp,
  activePreset: text,
  accounts: z.array(AccountSchema),
  presets: z.array(z.strictObject({ name: text, disabled })),
  manualDisabled: disabled,
});
export type CodeAccounts = z.infer<typeof CodeAccountsSchema>;

export const CodeAccountStateSchema = CodeAccountsSchema.pick({
  schemaVersion: true, activePreset: true, presets: true, manualDisabled: true,
});
export type CodeAccountState = z.infer<typeof CodeAccountStateSchema>;
export const CodeAccountReadSchema = CodeAccountsSchema.extend({ baseRevision: revision.nullable() });
export const CodeAccountProposalSchema = CodeAccountsSchema.extend({ baseRevision: revision });
export const CodeAccountViewSchema = CodeAccountReadSchema.extend({
  preferenceRevision: revision,
  appliedJobId: jobId.nullable(),
  proposals: z.array(z.strictObject({ job: PublicJobSchema, value: CodeAccountProposalSchema })).max(CODE_ACCOUNT_CHANGE_OPERATIONS.length),
  proposalsUnavailable: z.boolean(),
});
export const CodeApplyAccountChoicesInputSchema = z.strictObject({
  machineId: z.string().min(1).max(128), operation: CodeAccountChangeOperationSchema, jobId,
});
export type CodeApplyAccountChoicesInput = z.infer<typeof CodeApplyAccountChoicesInputSchema>;
export const CodeApplyAccountChoicesResultSchema = z.strictObject({ revision, jobId });
export type CodeApplyAccountChoicesResult = z.infer<typeof CodeApplyAccountChoicesResultSchema>;

export const CodeBlockResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operation: z.literal("clear-blocks"),
  account: accountReference,
  cleared: z.literal(true),
});

/** This is deliberately narrower than local `code inspect`: paths and session metadata stay local. */
export const CodeInspectionSchema = z.strictObject({
  schema_version: z.literal(1),
  baseRevision: revision.nullable(),
  observed_at: z.iso.datetime(),
  observation: z.literal("one_shot"),
  catalog: z.strictObject({ state: z.enum(["ready", "missing"]) }),
  selection,
  facets: z.array(z.strictObject({ key: text, values: z.array(text) })),
  routing: z.array(z.strictObject({
    role: text,
    primary: text,
    fallbacks: z.array(text),
    agent_override: z.boolean(),
  })),
  estimates: z.strictObject({
    cost: z.number().int(), speed: z.number().int(),
    scale_min: z.number().int(), scale_max: z.number().int(),
  }).nullable(),
  providers: z.array(z.strictObject({
    id: text, credential_state: z.enum(["unknown", "available", "unavailable"]),
  })),
  launch_modes: z.array(z.strictObject({
    mode: z.enum(["generated", "managed", "untrusted", "runtime"]), available: z.boolean(),
  })),
  runtime_targets: z.array(z.strictObject({
    name: text, label: text, phase: text, model: text,
    context_window: z.number().int(),
    provisioned: z.boolean(), running: z.boolean(), healthy: z.boolean(),
    disk_bytes: z.number().int(), estimated_disk_bytes: z.number().int(),
  })),
});
export type CodeInspection = z.infer<typeof CodeInspectionSchema>;

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
  baseRevision: revision.nullable(),
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
  schema_version: z.literal(1),
  baseRevision: revision.nullable(),
  observed_at: z.iso.datetime(),
  observation: z.literal("one_shot"),
  evaluator: text,
  actions: z.array(z.strictObject({ key: text, value: text })),
  selection,
});
export type CodeSuggestion = z.infer<typeof CodeSuggestionSchema>;

export const CodeOperationResultSchemas = {
  inspect: CodeInspectionSchema,
  usage: CodeUsageSchema,
  "accounts-list": CodeAccountReadSchema,
  "account-import": CodeAccountProposalSchema,
  "account-set": CodeAccountProposalSchema,
  "preset-create": CodeAccountProposalSchema,
  "preset-update": CodeAccountProposalSchema,
  "preset-activate": CodeAccountProposalSchema,
  "preset-delete": CodeAccountProposalSchema,
  "account-clear-blocks": CodeBlockResultSchema,
  suggest: CodeSuggestionSchema,
} as const;
export type CodeOperationResult<K extends CodeOperation> = z.infer<(typeof CodeOperationResultSchemas)[K]>;

export const CODE_RUN_DOOR = "atyrode.code.run";
export const CODE_OBSERVE_DOOR = "atyrode.code.observe";
export const CODE_APPLY_ACCOUNT_CHOICES_DOOR = "atyrode.code.applyAccountChoices";
export const CODE_JOB_TOPIC = { kind: "plugin", pluginId: "engine.jobs" } as const;
export const CodeOperationSchema = z.enum(Object.keys(CodeOperationInputSchemas) as [CodeOperation, ...CodeOperation[]]);

function requestSchema<N extends CodeOperation, S extends z.ZodType>(operation: N, input: S) {
  return z.strictObject({
    machineId: z.string().min(1).max(128),
    operation: z.literal(operation),
    input,
  });
}

export const CodeRunInputSchema = z.discriminatedUnion("operation", [
  requestSchema("inspect", CodeOperationInputSchemas.inspect),
  requestSchema("usage", CodeOperationInputSchemas.usage),
  requestSchema("accounts-list", CodeOperationInputSchemas["accounts-list"]),
  requestSchema("account-import", CodeOperationInputSchemas["account-import"]),
  requestSchema("account-set", CodeOperationInputSchemas["account-set"]),
  requestSchema("preset-create", CodeOperationInputSchemas["preset-create"]),
  requestSchema("preset-update", CodeOperationInputSchemas["preset-update"]),
  requestSchema("preset-activate", CodeOperationInputSchemas["preset-activate"]),
  requestSchema("preset-delete", CodeOperationInputSchemas["preset-delete"]),
  requestSchema("account-clear-blocks", CodeOperationInputSchemas["account-clear-blocks"]),
  requestSchema("suggest", CodeOperationInputSchemas.suggest),
]);
export type CodeRunInput = z.infer<typeof CodeRunInputSchema>;

export const CodeObserveInputSchema = z.strictObject({
  machineId: z.string().min(1).max(128),
  operation: CodeOperationSchema,
  jobId: jobId.optional(),
});
export type CodeObserveInput = z.infer<typeof CodeObserveInputSchema>;

function observationSchema<N extends CodeOperation, S extends z.ZodType>(operation: N, value: S) {
  return z.strictObject({
    operation: z.literal(operation),
    state: z.enum(["empty", "pending", "ready", "failed", "unavailable"]),
    latest: PublicJobSchema.nullable(),
    snapshot: z.strictObject({ job: PublicJobSchema, value }).nullable(),
    failure: z.enum(["operation_failed", "output_unavailable", "invalid_result", "stale_preferences"]).nullable(),
  });
}

export const CodeObservationSchema = z.discriminatedUnion("operation", [
  observationSchema("inspect", CodeInspectionSchema),
  observationSchema("usage", CodeUsageSchema),
  observationSchema("accounts-list", CodeAccountViewSchema),
  observationSchema("account-import", CodeAccountProposalSchema),
  observationSchema("account-set", CodeAccountProposalSchema),
  observationSchema("preset-create", CodeAccountProposalSchema),
  observationSchema("preset-update", CodeAccountProposalSchema),
  observationSchema("preset-activate", CodeAccountProposalSchema),
  observationSchema("preset-delete", CodeAccountProposalSchema),
  observationSchema("account-clear-blocks", CodeBlockResultSchema),
  observationSchema("suggest", CodeSuggestionSchema),
]);
export type CodeObservation = z.infer<typeof CodeObservationSchema>;
