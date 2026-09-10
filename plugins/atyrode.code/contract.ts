import { JobDescriptionSchema, PublicJobSchema, ServiceConfigurationReadSchema, ServiceConfigurationSchema,
  ServicePolicySchema, TerminalRuntimeSchema } from "@manifold/protocol";
import { z } from "zod";
import { AccountChoiceChangeSchema, AccountChoicesSchema, AccountReferenceSchema, AccountsObservationSchema,
  CatalogDocumentSchema, RuntimeAccountPoolSchema, SelectionSchema, epochMilliseconds, identifier } from "../domain/contracts.ts";
import { ReviewSchema } from "../domain/routing.ts";
import { BenchmarkReceiptSchema, CatalogDraftSchema, InventoryReceiptSchema } from "../domain/probe.ts";
import { UsageViewSchema } from "../domain/usage.ts";

export const CODE_PLUGIN_ID = "atyrode.code";
export const GATEWAY_PLUGIN_ID = "atyrode.code.gateway";
export const GATEWAY_OPERATION_ID = `${GATEWAY_PLUGIN_ID}.serve`;
export const GENERATOR_PLUGIN_ID = "atyrode.code.generator";
export const USAGE_PLUGIN_ID = "atyrode.code.usage";
export const ACCOUNTS_PLUGIN_ID = "atyrode.code.accounts";
export const LAUNCHER_PANEL = "launcher";
export const CODE_PREFERENCES_EVENT = "preferences_changed";
export const CODE_JOB_TOPIC = { kind: "plugin", pluginId: "engine.jobs" } as const;
export const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(128);
export const TargetSchema = z.strictObject({ containerId: id, machineId: id });
export type Target = z.infer<typeof TargetSchema>;
export const RevisionTargetSchema = TargetSchema.extend({ expectedRevision: revision });
export const ResourcePinsSchema = z.strictObject({
  installationRevision: id, artifactSha256: digest,
  operations: z.record(id, digest),
});
export const ServicePinSchema = z.strictObject({ serviceId: identifier, revision: id, policySha256: digest });
export type ServicePin = z.infer<typeof ServicePinSchema>;
export const PromotedResourcesSchema = z.strictObject({
  productSha256: digest, execution: ResourcePinsSchema.nullable(),
  services: z.record(identifier, ServicePinSchema),
});
export const CatalogRevisionSchema = z.strictObject({ document: CatalogDocumentSchema, digest });
export const ConfigurationSchema = TargetSchema.extend({
  schemaVersion: z.literal(1), revision: revision.positive(),
  accounts: AccountChoicesSchema,
  draft: CatalogRevisionSchema.nullable(), active: CatalogRevisionSchema.nullable(),
  selection: SelectionSchema.nullable(), resources: PromotedResourcesSchema.nullable(),
  updatedBy: id, updatedAt: epochMilliseconds,
});
export type Configuration = z.infer<typeof ConfigurationSchema>;
export const ConfigurationReadSchema = z.strictObject({ revision, configuration: ConfigurationSchema.nullable() });
export const CatalogReviewInputSchema = RevisionTargetSchema.extend({ source: z.enum(["active", "draft"]) });
export const CatalogReviewSchema = z.strictObject({
  revision, source: z.enum(["active", "draft"]), catalogDigest: digest,
  review: ReviewSchema, resources: PromotedResourcesSchema, reviewDigest: digest,
});
export type CatalogReview = z.infer<typeof CatalogReviewSchema>;
export const LaunchPreviewSchema = z.strictObject({
  revision, review: ReviewSchema, accountPool: RuntimeAccountPoolSchema,
  resources: PromotedResourcesSchema, previewDigest: digest,
});
export type LaunchPreview = z.infer<typeof LaunchPreviewSchema>;
export const PrepareLaunchInputSchema = RevisionTargetSchema.extend({ previewDigest: digest, prompt: z.string().max(16384) });
export type PrepareLaunchInput = z.infer<typeof PrepareLaunchInputSchema>;
export const PrepareLaunchResultSchema = z.strictObject({ runtime: TerminalRuntimeSchema });
export const SetupSchema = z.strictObject({ productSha256: digest, execution: JobDescriptionSchema.nullable(), services: z.array(z.strictObject({
  ...ServicePinSchema.shape, operations: z.array(z.strictObject({ operationId: identifier, readable: z.boolean(), invocable: z.boolean(), ready: z.boolean(), reason: z.string().nullable() })),
})), connected: z.boolean() });
export const AccountSetupSchema = z.strictObject({
  revision: id.nullable(),
  owner: z.strictObject({ machineId: id, name: z.string().min(1).max(256), online: z.boolean() }).nullable(),
  state: z.enum(["unconfigured", "starting", "ready", "unavailable"]),
  canSignIn: z.boolean(),
  canUpdateRuntime: z.boolean(),
  reason: z.string().max(256).nullable(),
});
export const PrepareSignInInputSchema = z.strictObject({ containerId: id, expectedBrokerRevision: id.nullable() });
export const PrepareSignInResultSchema = z.strictObject({ machineId: id, runtime: TerminalRuntimeSchema });
export const AccountRuntimeReviewInputSchema = z.strictObject({ expectedBrokerRevision: id });
export const AccountRuntimeReviewSchema = z.strictObject({
  expectedBrokerRevision: id, owner: AccountSetupSchema.shape.owner.unwrap(), policy: ServicePolicySchema, reviewDigest: digest,
});
export const InventoryResultSchema = z.strictObject({ job: PublicJobSchema, inventory: InventoryReceiptSchema, draft: CatalogDraftSchema });
export const BenchmarkResultSchema = z.strictObject({ job: PublicJobSchema, benchmark: BenchmarkReceiptSchema, catalog: CatalogDocumentSchema });
export const SuggestionSchema = z.strictObject({ revision, selection: SelectionSchema, changed: z.array(z.enum(Object.keys(SelectionSchema.shape) as [keyof z.infer<typeof SelectionSchema>, ...(keyof z.infer<typeof SelectionSchema>)[]])), evaluator: z.string().max(256) });
export const accountActionSchemas = {
  readAccountSetup: { input: z.strictObject({}), result: AccountSetupSchema },
  prepareSignIn: { input: PrepareSignInInputSchema, result: PrepareSignInResultSchema },
  reviewAccountRuntime: { input: AccountRuntimeReviewInputSchema, result: AccountRuntimeReviewSchema },
  promoteAccountRuntime: { input: AccountRuntimeReviewInputSchema.extend({ containerId: id, reviewDigest: digest }),
    result: z.strictObject({ revision: id }) },
} as const;
export type AccountAction = keyof typeof accountActionSchemas;
export const ClassifierSchema = z.strictObject({
  origin: z.string(), model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,511}$/),
});
export const ServicesReviewInputSchema = TargetSchema.extend({
  expectedServiceRevision: ServiceConfigurationSchema.shape.revision,
  classifier: ClassifierSchema.nullable().optional(),
});
export const ServicesReviewSchema = z.strictObject({
  expectedServiceRevision: ServiceConfigurationSchema.shape.revision, policies: z.array(ServicePolicySchema), reviewDigest: digest,
});
export const rootActionSchemas = {
  readConfiguration: { input: TargetSchema, result: ConfigurationReadSchema },
  initializeConfiguration: { input: RevisionTargetSchema, result: ConfigurationSchema },
  stageCatalog: { input: RevisionTargetSchema.extend({ document: CatalogDocumentSchema }), result: ConfigurationSchema },
  reviewCatalog: { input: CatalogReviewInputSchema, result: CatalogReviewSchema },
  promoteCatalog: { input: RevisionTargetSchema.extend({ source: z.enum(["active", "draft"]), reviewDigest: digest }), result: ConfigurationSchema },
  select: { input: RevisionTargetSchema.extend({ selection: SelectionSchema }), result: ConfigurationSchema },
  changeAccounts: { input: RevisionTargetSchema.extend({ change: AccountChoiceChangeSchema }), result: ConfigurationSchema },
  accounts: { input: z.strictObject({}), result: AccountsObservationSchema },
  usage: { input: TargetSchema, result: UsageViewSchema },
  clearAccountBlocks: { input: TargetSchema.extend({ reference: AccountReferenceSchema }), result: AccountsObservationSchema },
  disableCredential: { input: TargetSchema.extend({ reference: AccountReferenceSchema }), result: AccountsObservationSchema },
  readSetup: { input: TargetSchema, result: SetupSchema },
  readServiceConfiguration: { input: TargetSchema, result: ServiceConfigurationReadSchema },
  reviewServices: { input: ServicesReviewInputSchema, result: ServicesReviewSchema },
  configureServices: { input: ServicesReviewInputSchema.extend({ reviewDigest: digest }), result: ServiceConfigurationSchema },
  reviewResources: { input: RevisionTargetSchema, result: z.strictObject({ resources: PromotedResourcesSchema, reviewDigest: digest }) },
  promoteResources: { input: RevisionTargetSchema.extend({ reviewDigest: digest }), result: ConfigurationSchema },
  prepareWorkspace: { input: RevisionTargetSchema, result: PublicJobSchema },
  startInventory: { input: RevisionTargetSchema, result: PublicJobSchema },
  inventory: { input: TargetSchema.extend({ jobId: id }), result: InventoryResultSchema },
  startBenchmark: { input: RevisionTargetSchema.extend({ inventoryJobId: id }), result: PublicJobSchema },
  benchmark: { input: TargetSchema.extend({ inventoryJobId: id, jobId: id }), result: BenchmarkResultSchema },
  stageBenchmark: { input: RevisionTargetSchema.extend({ inventoryJobId: id, jobId: id }), result: ConfigurationSchema },
  suggest: { input: RevisionTargetSchema.extend({ prompt: z.string().trim().min(1).max(16384) }), result: SuggestionSchema },
  previewLaunch: { input: RevisionTargetSchema, result: LaunchPreviewSchema },
  prepareLaunch: { input: PrepareLaunchInputSchema, result: PrepareLaunchResultSchema },
} as const;
export type RootAction = keyof typeof rootActionSchemas;
export const actionSchemas = { ...rootActionSchemas, ...accountActionSchemas } as const;
export type CodeAction = keyof typeof actionSchemas;
export type ActionInput<K extends CodeAction> = z.infer<(typeof actionSchemas)[K]["input"]>;
export type ActionResult<K extends CodeAction> = z.infer<(typeof actionSchemas)[K]["result"]>;
export function actionDoor(name: CodeAction): string {
  return `${Object.hasOwn(accountActionSchemas, name) ? ACCOUNTS_PLUGIN_ID : CODE_PLUGIN_ID}.${name}`;
}
