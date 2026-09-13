import { JobDeploymentRequestSchema, ServiceConfigurationReadSchema, ServiceConfigurationSchema, ServicePolicySchema } from "@manifold/protocol";
import { AccountsObservationSchema, BenchmarkReceiptSchema, InventoryReceiptSchema, OverlaySchema,
  RuntimeAccountPoolSchema, epochMilliseconds } from "@atyrode/manifold-omp";
import { z } from "zod";
import { AccountChoiceChangeSchema, AccountChoicesSchema, CatalogDocumentSchema, SelectionSchema } from "../domain/contracts.ts";
import { ReviewSchema } from "../domain/routing.ts";
import { CatalogDraftSchema } from "../domain/probe.ts";

export const CODE_PLUGIN_ID = "atyrode.code";
export const GENERATOR_PLUGIN_ID = "atyrode.code.generator";
export const USAGE_PLUGIN_ID = "atyrode.code.usage";
export const ACCOUNTS_PLUGIN_ID = "atyrode.code.accounts";
export const LAUNCHER_PANEL = "launcher";
export const CODE_PREFERENCES_EVENT = "preferences_changed";
export const CODE_JOB_TOPIC = { kind: "plugin", pluginId: "engine.jobs" } as const;
export const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(128);
export const WorkspaceSchema = z.strictObject({ containerId: id });
export type Workspace = z.infer<typeof WorkspaceSchema>;
export const RevisionWorkspaceSchema = WorkspaceSchema.extend({ expectedRevision: revision });
export const ConfigurationLookupSchema = WorkspaceSchema.extend({ legacyMachineId: id.optional() });
export const TargetSchema = WorkspaceSchema.extend({ machineId: id });
export type Target = z.infer<typeof TargetSchema>;
export const RevisionTargetSchema = TargetSchema.extend({ expectedRevision: revision });
export const CatalogRevisionSchema = z.strictObject({ document: CatalogDocumentSchema, digest });
export const ConfigurationSchema = WorkspaceSchema.extend({
  schemaVersion: z.literal(3), revision: revision.positive(),
  accounts: AccountChoicesSchema,
  draft: CatalogRevisionSchema.nullable(), active: CatalogRevisionSchema.nullable(),
  selection: SelectionSchema.nullable(), updatedBy: id, updatedAt: epochMilliseconds,
});
export type Configuration = z.infer<typeof ConfigurationSchema>;
export const ConfigurationReadSchema = z.strictObject({ revision, configuration: ConfigurationSchema.nullable(), legacyMachineId: id.nullable() });
export const CatalogReviewInputSchema = RevisionWorkspaceSchema.extend({ source: z.enum(["active", "draft"]) });
export const CatalogReviewSchema = z.strictObject({
  revision, source: z.enum(["active", "draft"]), catalogDigest: digest, review: ReviewSchema, reviewDigest: digest,
});
export type CatalogReview = z.infer<typeof CatalogReviewSchema>;
export const SessionCompositionSchema = z.strictObject({
  revision, review: ReviewSchema, accountPool: RuntimeAccountPoolSchema, overlay: OverlaySchema,
  prompt: z.string().max(16384), planYolo: z.boolean(), compositionDigest: digest,
});
export const SuggestionSchema = z.strictObject({ revision, serviceRevision: id, selection: SelectionSchema,
  changed: z.array(z.enum(Object.keys(SelectionSchema.shape) as [keyof z.infer<typeof SelectionSchema>, ...(keyof z.infer<typeof SelectionSchema>)[]])),
  evaluator: z.string().max(256) });
export const ClassifierSchema = z.strictObject({
  origin: z.string(), model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,511}$/),
});
export const ServicesReviewInputSchema = TargetSchema.extend({
  expectedServiceRevision: ServiceConfigurationSchema.shape.revision, classifier: ClassifierSchema.nullable(),
});
export const ServicesReviewSchema = z.strictObject({
  expectedServiceRevision: ServiceConfigurationSchema.shape.revision, policies: z.array(ServicePolicySchema), reviewDigest: digest, current: z.boolean(),
});
export const PermissionFeatureIdSchema = z.enum(["accounts", "gateway", "workspace-create", "workspace-existing", "discovery", "benchmark", "session"]);
export type PermissionFeatureId = z.infer<typeof PermissionFeatureIdSchema>;
export const PermissionPlanInputSchema = z.strictObject({
  containerId: id, machineId: id.nullable(),
  intent: z.union([z.literal("setup"), PermissionFeatureIdSchema]),
  choices: z.array(PermissionFeatureIdSchema).max(7).refine(values => new Set(values).size === values.length).nullable(),
  requestId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
});
// Client-side composition only: native readiness belongs to each OMP operation's owner.
export const PermissionPlanSchema = z.strictObject({
  scopeDigest: digest,
  ownerApprovalRequired: z.boolean(),
  features: z.array(z.strictObject({
    id: PermissionFeatureIdSchema, title: z.string(), effect: z.string(), deferredEffect: z.string(),
    prerequisites: z.array(PermissionFeatureIdSchema), selected: z.boolean(),
    destination: z.strictObject({ machineId: id, label: z.string() }).nullable(),
  })),
  steps: z.array(z.strictObject({
    request: JobDeploymentRequestSchema, featureIds: z.array(PermissionFeatureIdSchema),
    configuration: z.enum(["account-runtime", "gateway", "none"]),
    nativeReady: z.boolean(), configurationCurrent: z.boolean(),
  })),
  blockers: z.array(z.string()),
});
export const rootActionSchemas = {
  readConfiguration: { input: ConfigurationLookupSchema, result: ConfigurationReadSchema },
  initializeConfiguration: { input: ConfigurationLookupSchema.extend({ expectedRevision: revision }), result: ConfigurationSchema },
  stageCatalog: { input: RevisionWorkspaceSchema.extend({ document: CatalogDocumentSchema }), result: ConfigurationSchema },
  reviewCatalog: { input: CatalogReviewInputSchema, result: CatalogReviewSchema },
  promoteCatalog: { input: CatalogReviewInputSchema.extend({ reviewDigest: digest }), result: ConfigurationSchema },
  select: { input: RevisionWorkspaceSchema.extend({ selection: SelectionSchema }), result: ConfigurationSchema },
  changeAccounts: { input: RevisionWorkspaceSchema.extend({ change: AccountChoiceChangeSchema }), result: ConfigurationSchema },
  composeProbe: { input: RevisionWorkspaceSchema.extend({ accounts: AccountsObservationSchema }),
    result: z.strictObject({ revision, accountPool: RuntimeAccountPoolSchema }) },
  draftInventory: { input: z.strictObject({ inventory: InventoryReceiptSchema }), result: CatalogDraftSchema },
  deriveCatalog: { input: z.strictObject({ inventory: InventoryReceiptSchema, benchmark: BenchmarkReceiptSchema }), result: CatalogDocumentSchema },
  composeSession: { input: RevisionWorkspaceSchema.extend({ accounts: AccountsObservationSchema, prompt: z.string().max(16384) }), result: SessionCompositionSchema },
  readServiceConfiguration: { input: TargetSchema, result: ServiceConfigurationReadSchema },
  reviewServices: { input: ServicesReviewInputSchema, result: ServicesReviewSchema },
  configureServices: { input: ServicesReviewInputSchema.extend({ reviewDigest: digest }), result: ServiceConfigurationSchema },
  suggest: { input: RevisionTargetSchema.extend({ expectedServiceRevision: id, prompt: z.string().trim().min(1).max(16384) }), result: SuggestionSchema },
} as const;
export type RootAction = keyof typeof rootActionSchemas;
export const actionSchemas = rootActionSchemas;
export type CodeAction = keyof typeof actionSchemas;
export type ActionInput<K extends CodeAction> = z.infer<(typeof actionSchemas)[K]["input"]>;
export type ActionResult<K extends CodeAction> = z.infer<(typeof actionSchemas)[K]["result"]>;
export const RefusalSchema = z.strictObject({ refused: z.string().regex(/^code_[a-z0-9_]+$/) });
export type ActionReply<K extends CodeAction> = ActionResult<K> | z.infer<typeof RefusalSchema>;
export function actionDoor(name: CodeAction): string { return `${CODE_PLUGIN_ID}.${name}`; }
/** Ordinary caller dispatch only; this adapter neither grants nor proxies native authority. */
export function createCodeClient(dispatch: (door: string, input: unknown) => Promise<unknown>) {
  return { async call<K extends CodeAction>(name: K, input: ActionInput<K>): Promise<ActionReply<K>> {
    const args = actionSchemas[name].input.parse(input);
    const raw = await dispatch(actionDoor(name), args);
    const refused = RefusalSchema.safeParse(raw);
    return (refused.success ? refused.data : actionSchemas[name].result.parse(raw)) as ActionReply<K>;
  } };
}
