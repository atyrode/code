import { JobDeploymentRequestSchema, PublicJobSchema, ServiceConfigurationReadSchema, ServiceConfigurationSchema, ServicePolicySchema } from "@manifold/protocol";
import { AccountRecordSchema, AccountsObservationSchema, BenchmarkReceiptSchema, InventoryReceiptSchema,
  JobInputBindingSchema, OverlaySchema, RuntimeAccountPoolSchema, SessionInputSchema, SessionReceiptSchema,
  SessionSilenceSchema,
  ThinkingLevelSchema, epochMilliseconds, identifier, modelId, type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { z } from "zod";
import { AccountChoiceChangeSchema, AccountChoicesSchema, CapabilitySchema, CatalogDocumentSchema, SelectionSchema } from "../domain/contracts.ts";
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
export const id = z.string().min(1).max(128);
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
/** The prompt bound is OMP's, in bytes, because the prompt reaches the machine as one entry
 * of the job input map the hub bounds (`PROMPT_MAX_BYTES`, 44 KiB). Code takes the schema
 * itself rather than the number, so the two can never disagree. */
const sessionPrompt = SessionInputSchema.shape.prompt;
export const SessionCompositionSchema = z.strictObject({
  revision, review: ReviewSchema, accountPool: RuntimeAccountPoolSchema, overlay: OverlaySchema,
  prompt: sessionPrompt, planYolo: z.boolean(), compositionDigest: digest,
});
export type SessionComposition = z.infer<typeof SessionCompositionSchema>;
export type SessionOptions = Pick<OmpInput<"reviewSession">, "skills" | "automation">;
/** OMP's reviewed session input, composed from one Code composition and OMP's own defaults.
 * The web's review, the web's preparation and the `runSession` door all pass through here, so
 * a job-shaped session is reviewed against the very input a terminal one is. */
export function sessionInput(target: Target, composition: SessionComposition,
  expectedDefaultsRevision: number, options: SessionOptions = {}): OmpInput<"reviewSession"> {
  return { ...target, expectedDefaultsRevision, accountPool: composition.accountPool,
    overlay: composition.overlay, prompt: composition.prompt, planYolo: composition.planYolo,
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    ...(options.automation === undefined ? {} : { automation: options.automation }) };
}
/** Prepare the effective native selection, not the caller's potentially overlapping sets. */
export function reviewedSkillSelection(skills: OmpResult<"reviewSession">["skills"]): OmpInput<"reviewSession">["skills"] {
  if (skills.mode === "preserve") return undefined;
  if (skills.mode === "disabled") return { mode: "disabled" };
  if (skills.catalogRevision === null) throw new Error("omp_review_changed");
  return { mode: "select", expectedCatalogRevision: skills.catalogRevision, skillIds: skills.selected.map(entry => entry.id), setIds: [] };
}
/** Policy is native-owned: carry the reviewed restricted object intact, never rebuild a tool list. */
export function reviewedSessionOptions(review: OmpResult<"reviewSession">): SessionOptions {
  return { skills: reviewedSkillSelection(review.skills),
    ...(review.automation.mode === "restricted" ? { automation: review.automation } : {}) };
}
/** What the generator's dials show for a saved selection: the model leading the default role,
 * spelled as the OMP overlay spells it, and the depth that role thinks at. */
export const ProfileModelSchema = z.strictObject({
  model: modelId, thinking: ThinkingLevelSchema, capability: CapabilitySchema, advisor: SelectionSchema.shape.advisor,
});
/** One account a profile spends. `identityKey` is null for an API-key slot, which has a
 * credential and no login, and `label` is the login the observation named when it named one.
 * Both bounds are OMP's own record's, so a long login narrows nothing here and one account
 * can never refuse the whole list. */
export const ProfileAccountSchema = z.strictObject({
  provider: identifier,
  identityKey: AccountRecordSchema.shape.identityKey,
  label: AccountRecordSchema.shape.email.unwrap().optional(),
});
export type ProfileAccount = z.infer<typeof ProfileAccountSchema>;
/** A configured workspace, which is what a Code profile is: its catalog, selection and
 * account choices are the container's, and `machineId` is where Code last posted a session
 * for it — a destination is the caller's choice, never a saved pin.
 *
 * `accounts` is what this profile spends: the container's saved choices resolved against the
 * live account observation. Code's choices are stored as EXCLUSIONS, so without an
 * observation there is no list to give — `resolved` is false and `accounts` is empty, rather
 * than exclusions dressed up as selections. A caller displays what Code says and nothing it
 * inferred; `resolved: false` means ask again, never "spends nothing". */
export const ProfileSchema = z.strictObject({
  containerId: id, revision: revision.positive(), selected: ProfileModelSchema.nullable(), machineId: id.nullable(),
  accounts: z.array(ProfileAccountSchema).max(64), resolved: z.boolean(),
});
export type Profile = z.infer<typeof ProfileSchema>;
export const ProfileListSchema = z.strictObject({ profiles: z.array(ProfileSchema).max(4096) });
/** `inputs` binds sealed outputs of earlier jobs on the same machine to the run's declared
 * inputs (ADR 0044). Code passes them to OMP verbatim and reads none of them: what the
 * material is, and how the prompt refers to it, is the caller's own business. */
export const SessionRunInputSchema = RevisionTargetSchema.extend({
  // A one-shot needs a prompt; how long it may be is OMP's rule, not a number restated here.
  prompt: sessionPrompt.refine(value => value.length > 0, "a one-shot session needs a prompt"),
  inputs: z.array(JobInputBindingSchema).max(16).optional(),
  skills: SessionInputSchema.shape.skills,
  automation: SessionInputSchema.shape.automation,
});
export const SessionReadInputSchema = WorkspaceSchema.extend({ jobId: id });
export const SessionCancelInputSchema = WorkspaceSchema.extend({ jobId: id });
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
  // The budget DERIVES the catalog: `free` ladders the free models rather than hoping one of them
  // wins a rung against paid ones. Stated on every call, because a catalog's admissible set is
  // part of what it is, and a default would let two derivations differ without saying so.
  draftInventory: { input: z.strictObject({ inventory: InventoryReceiptSchema, budget: SelectionSchema.shape.budget }), result: CatalogDraftSchema },
  deriveCatalog: { input: z.strictObject({ inventory: InventoryReceiptSchema, benchmark: BenchmarkReceiptSchema, budget: SelectionSchema.shape.budget }), result: CatalogDocumentSchema },
  composeSession: { input: RevisionWorkspaceSchema.extend({ accounts: AccountsObservationSchema, prompt: sessionPrompt }), result: SessionCompositionSchema },
  listProfiles: { input: z.strictObject({}), result: ProfileListSchema },
  runSession: { input: SessionRunInputSchema, result: PublicJobSchema },
  /**
   * EXACTLY ONE OF `session` AND `silence` IS NULL, and Code carries the word it is given.
   *
   * The receipt exists only once a run exited 0 and its transcript was sealed. What used to sit
   * beside it was an absence answering five facts at once — still running, exited non-zero,
   * destination filled, transcript unsealed, never started — so a caller settling a claim on it
   * could not tell them apart (atyrode/manifold-omp#43). OMP now names which one, and this door
   * ADMITS that word rather than interpreting it: no mapping, no renaming, no deciding which
   * silences are interesting. Whether one means "wait" or "give up" is the caller's judgement,
   * and a door in the middle that made it would be answering a question it cannot see the claim
   * behind.
   *
   * Named explicitly rather than passed through: a strict result is what caught OMP's added
   * field at all, and `z.object` here would trade a named refusal for silent drift.
   */
  readSession: {
    input: SessionReadInputSchema,
    result: z
      .strictObject({
        job: PublicJobSchema,
        session: SessionReceiptSchema.nullable(),
        silence: SessionSilenceSchema.nullable(),
      })
      .refine(
        (read) => (read.session === null) !== (read.silence === null),
        "a session read answers with a receipt or with the word that stopped it, never both or neither",
      ),
  },
  cancelSession: { input: SessionCancelInputSchema, result: z.strictObject({ job: PublicJobSchema }) },
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
