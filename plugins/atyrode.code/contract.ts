import { JobDescriptionSchema, PublicJobSchema, ServiceConfigurationSchema, ServiceConfigurationReadSchema, ServicePolicySchema, ServiceRuntimeSchema, TerminalRuntimeSchema } from "@manifold/protocol";
import { z } from "zod";
import { AccountChoiceChangeSchema, AccountChoicesSchema, AccountReferenceSchema, AccountsObservationSchema,
  CatalogDocumentSchema, RuntimeAccountPoolSchema, SelectionSchema, epochMilliseconds, identifier } from "../domain/contracts.ts";
import { ReviewSchema } from "../domain/routing.ts";
import { BenchmarkReceiptSchema, CatalogDraftSchema, InventoryReceiptSchema } from "../domain/probe.ts";
import { UsageViewSchema } from "../domain/usage.ts";
import { bundledCredentialProviders } from "./sdk-metadata.macro.ts" with { type: "macro" };

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
export const InventoryResultSchema = z.strictObject({ job: PublicJobSchema, inventory: InventoryReceiptSchema, draft: CatalogDraftSchema });
export const BenchmarkResultSchema = z.strictObject({ job: PublicJobSchema, benchmark: BenchmarkReceiptSchema, catalog: CatalogDocumentSchema });
export const SuggestionSchema = z.strictObject({ revision, selection: SelectionSchema, changed: z.array(z.enum(Object.keys(SelectionSchema.shape) as [keyof z.infer<typeof SelectionSchema>, ...(keyof z.infer<typeof SelectionSchema>)[]])), evaluator: z.string().max(256) });
/** The SDK broker accepts API-key slots generically; upstream key acceptance is not implied. */
export const apiKeyProviders: readonly string[] = Object.freeze(bundledCredentialProviders());
export const ApiKeyProviderSchema = identifier.refine(provider => apiKeyProviders.includes(provider), "Unsupported SDK provider");
export const ApiKeySourcesSchema = z.array(z.strictObject({ provider: ApiKeyProviderSchema, credentialRef: identifier })).max(128)
  .refine(sources => new Set(sources.map(source => source.provider)).size === sources.length, "Duplicate API-key provider");
export const ServiceSetupInputSchema = TargetSchema.extend({
  expectedServiceRevision: digest.nullable(),
  broker: z.strictObject({ origin: z.url().max(4096), credentialRef: identifier }),
  classifier: z.strictObject({ origin: z.url().max(4096), model: z.string().trim().min(1).max(256) }).nullable(),
  apiKeys: ApiKeySourcesSchema,
});
export const GatewayReviewSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready"), runtime: ServiceRuntimeSchema }),
  z.strictObject({ status: z.literal("omitted"),
    reason: z.enum(["machine_disconnected", "not_installed", "installation_disabled", "purge_requested", "resources_unready"]),
    nativeReason: z.string().nullable() }),
]);
export const ServiceConfigurationReviewSchema = z.strictObject({
  expectedServiceRevision: digest.nullable(), policies: z.array(ServicePolicySchema).max(64),
  gateway: GatewayReviewSchema, reviewDigest: digest,
});

export const actionSchemas = {
  readConfiguration: { input: TargetSchema, result: ConfigurationReadSchema },
  initializeConfiguration: { input: RevisionTargetSchema, result: ConfigurationSchema },
  stageCatalog: { input: RevisionTargetSchema.extend({ document: CatalogDocumentSchema }), result: ConfigurationSchema },
  reviewCatalog: { input: CatalogReviewInputSchema, result: CatalogReviewSchema },
  promoteCatalog: { input: RevisionTargetSchema.extend({ source: z.enum(["active", "draft"]), reviewDigest: digest }), result: ConfigurationSchema },
  select: { input: RevisionTargetSchema.extend({ selection: SelectionSchema }), result: ConfigurationSchema },
  changeAccounts: { input: RevisionTargetSchema.extend({ change: AccountChoiceChangeSchema }), result: ConfigurationSchema },
  accounts: { input: TargetSchema, result: AccountsObservationSchema },
  usage: { input: TargetSchema, result: UsageViewSchema },
  clearAccountBlocks: { input: TargetSchema.extend({ reference: AccountReferenceSchema }), result: AccountsObservationSchema },
  disableCredential: { input: TargetSchema.extend({ reference: AccountReferenceSchema }), result: AccountsObservationSchema },
  enrollApiKey: { input: TargetSchema.extend({ provider: ApiKeyProviderSchema }), result: AccountsObservationSchema },
  readSetup: { input: TargetSchema, result: SetupSchema },
  readServiceConfiguration: { input: TargetSchema, result: ServiceConfigurationReadSchema },
  reviewServices: { input: ServiceSetupInputSchema, result: ServiceConfigurationReviewSchema },
  configureServices: { input: ServiceSetupInputSchema.extend({ reviewDigest: digest }), result: ServiceConfigurationSchema },
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
export type CodeAction = keyof typeof actionSchemas;
export type ActionInput<K extends CodeAction> = z.infer<(typeof actionSchemas)[K]["input"]>;
export type ActionResult<K extends CodeAction> = z.infer<(typeof actionSchemas)[K]["result"]>;
