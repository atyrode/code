import { z } from "zod";
import type { GuestStorage, ServerMigration } from "@manifold/plugin-kit/server";
import type { RuntimeAccountPool } from "@atyrode/manifold-omp";
import { initialAccountChoices, selectedAccountPool } from "../domain/accounts.ts";
import { compileCatalog, type CompiledCatalog } from "../domain/catalog.ts";
import { CatalogModelSchema, DomainError, type CatalogDocument, type Selection } from "../domain/contracts.ts";
import { defaultSelection, newPremiumLead, reviewCatalog, type ModelAddress } from "../domain/routing.ts";
import { CODE_PREFERENCES_EVENT, CatalogRevisionSchema, ConfigurationSchema, VerificationProvenanceSchema,
  ConfigurationLookupSchema, TargetSchema, digest, type Configuration, type Workspace, type CatalogReview,
  type ActionInput, type VerificationProvenance } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./context.ts";

/** Whether this principal reaches the workspace at all. `authorizeTarget` is the refusing
 * form; a list of workspaces needs the question answered without refusing the whole list. */
export async function allowsWorkspace(ctx: CodeContext, target: Workspace, write = false): Promise<boolean> {
  return !(await ctx.outsideScope(target.containerId)) && await ctx.auth.allows(write ? "containers:write" : "containers:read",
    { kind: "container", containerId: target.containerId });
}
export async function authorizeTarget(ctx: CodeContext, target: Workspace, write = false): Promise<void> {
  if (!(await allowsWorkspace(ctx, target, write))) throw new CodeRefusal("scope_refused");
}
/**
 * THE RESOLVED INTENT OF A SAVED SELECTION, private to storage. A selection is only numbers — a
 * lane, a tier and preferences — so a capability saved before a catalog's tiers were read by name
 * cannot say which model it chose. A selection someone chose explicitly against the canonical
 * tiers records the model it resolved to here, bound to the exact catalog bytes (`catalogDigest`),
 * the whole saved selection (`selectionDigest`) and that model's provider/id; it is written in the
 * same CAS as the selection and never leaves storage. A witness that is malformed, or that no
 * longer binds the record's active catalog, selection and canonical model, is no witness at all:
 * the saved selection then answers to the strict stored-identity guard.
 */
const ResolvedSelectionSchema = z.strictObject({ catalogDigest: digest, selectionDigest: digest,
  provider: CatalogModelSchema.shape.provider, id: CatalogModelSchema.shape.id });
export type ResolvedSelection = z.infer<typeof ResolvedSelectionSchema>;
export interface StoredConfiguration {
  key: string;
  raw: string | null;
  record: Configuration | null;
  /** The stored witness as it parsed, not yet checked against the record; see `resolvedIntent`. */
  resolved: ResolvedSelection | null;
  workspace: Workspace;
  legacyMachineId: string | null;
}
/** A canonical configuration as stored: its public record and, beside it, its private witness. */
export interface ConfigurationEntry { record: Configuration; resolved: ResolvedSelection | null }
// Schema 3 is schema 4 without verification provenance on either catalog.
const Version3CatalogSchema = CatalogRevisionSchema.omit({ provenance: true });
const Version3ConfigurationSchema = ConfigurationSchema.extend({
  schemaVersion: z.literal(3), draft: Version3CatalogSchema.nullable(), active: Version3CatalogSchema.nullable(),
});
// Old native resource pins are discarded, never interpreted as present authority.
const Version2ConfigurationSchema = Version3ConfigurationSchema.extend({
  schemaVersion: z.literal(2), resourcesByMachine: z.record(TargetSchema.shape.machineId, z.unknown()),
});
const LegacyConfigurationSchema = Version3ConfigurationSchema.extend({
  schemaVersion: z.literal(1), machineId: TargetSchema.shape.machineId, resources: z.unknown(),
});
const Version2To3Schema = Version2ConfigurationSchema.transform(({ resourcesByMachine: _pins, ...record }) =>
  Version3ConfigurationSchema.parse({ ...record, schemaVersion: 3 }));
/**
 * Schema 3 to 4 happens on read, never in a bulk pass. A catalog promoted before verification
 * existed was derived from bundled metadata, an unprobed inventory or an operator's hand, and
 * nothing recorded which, so it reads as unverified: `provenance: null`, never a provenance
 * presumed current. The next CAS write persists schema 4.
 *
 * A native migration stages the plugin's whole store, and retained session receipts already
 * exceed the host's migration staging bound, so the data version does not move. The host
 * therefore cannot refuse a rollback to code older than schema 4; that code fails to parse a
 * rewritten record and refuses, rather than overwriting it.
 */
function unverified(record: Omit<z.infer<typeof Version3ConfigurationSchema>, "schemaVersion">): Configuration {
  return ConfigurationSchema.parse({ ...record, schemaVersion: 4,
    draft: record.draft && { ...record.draft, provenance: null }, active: record.active && { ...record.active, provenance: null } });
}
/**
 * Schema 4 as first written recorded a verification without the OMP runtime artifact and model
 * catalog revision it ran against. Nothing can compare such a record with the OMP present now, so
 * it reads as unverified, like a schema-3 catalog, and the next CAS write persists `null`. The
 * schema version does not move: schema 4 already admits `provenance: null`.
 */
const { inventoryArtifactSha256: _artifact, catalogRevision: _catalog, ...unidentified } = VerificationProvenanceSchema.shape;
const StoredCatalogSchema = CatalogRevisionSchema.extend({
  provenance: z.union([VerificationProvenanceSchema, z.strictObject(unidentified).transform(() => null)]).nullable(),
});
const StoredVersion4Schema = ConfigurationSchema.extend({ draft: StoredCatalogSchema.nullable(), active: StoredCatalogSchema.nullable() });
const StoredConfigurationSchema = z.union([StoredVersion4Schema, Version3ConfigurationSchema.transform(unverified),
  Version2To3Schema.transform(unverified)]);
const ConfigurationVersionSchema = z.object({ schemaVersion: z.number().int() });
/** The stored envelope split in two: the private witness is read leniently (malformed reads as
 * none) and removed before the public record meets its strict schema, whose corruption rules are
 * unchanged. Nothing is rewritten on read. */
function hydrate(value: unknown): ConfigurationEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, "resolvedSelection"))
    return { record: StoredConfigurationSchema.parse(value), resolved: null };
  const { resolvedSelection, ...record } = value as Record<string, unknown>;
  const witness = ResolvedSelectionSchema.safeParse(resolvedSelection);
  return { record: StoredConfigurationSchema.parse(record), resolved: witness.success ? witness.data : null };
}

/** One migration's pass: every canonical record below schema `target` is rewritten by `upgrade`
 * under exact CAS, and every record is checked to be bound to its own container's key. Schema-1
 * machine records stay untouched recovery data, which `readConfiguration` adopts only on request. */
async function upgradeConfigurations(storage: GuestStorage, target: number, upgrade: (value: unknown) => Workspace): Promise<void> {
  for (const key of await storage.keys("configuration/")) {
    const raw = await storage.get(key);
    if (raw === null) continue;
    const value: unknown = JSON.parse(raw);
    const { schemaVersion } = ConfigurationVersionSchema.parse(value);
    if (schemaVersion === 1) continue;
    const record = schemaVersion < target ? upgrade(value) : hydrate(value).record;
    if (key !== `configuration/${digestOf({ containerId: record.containerId })}`) throw new CodeRefusal("invalid_configuration");
    if (schemaVersion >= target) continue;
    if (!await storage.compareAndSet(key, raw, JSON.stringify(record))) throw new CodeRefusal("stale_preferences");
  }
}
/** Native install/ledger transaction owns this one-time major-version change: schema 2 to 3.
 * It never adopts machine-local records or advances the container's policy revision. */
export const configurationMigration: ServerMigration = {
  name: "canonical-configuration-v3", to: { major: 2, minor: 0 },
  migrate: storage => upgradeConfigurations(storage, 3, value => Version2To3Schema.parse(value)),
};

export async function readConfiguration(ctx: CodeContext, input: z.infer<typeof ConfigurationLookupSchema>, write = false): Promise<StoredConfiguration> {
  await authorizeTarget(ctx, input, write);
  const workspace = { containerId: input.containerId };
  const key = `configuration/${digestOf(workspace)}`;
  const raw = await ctx.storage.get(key);
  const stored = raw === null ? null : hydrate(JSON.parse(raw));
  let record = stored?.record ?? null;
  let legacyMachineId: string | null = null;
  if (record && record.containerId !== input.containerId) throw new CodeRefusal("invalid_configuration");
  // Only an explicitly selected legacy destination may be adopted. The canonical
  // CAS remains null until mutation; legacy bytes are immutable recovery data.
  if (raw === null && input.legacyMachineId !== undefined) {
    const legacyRaw = await ctx.storage.get(`configuration/${digestOf({ ...workspace, machineId: input.legacyMachineId })}`);
    if (legacyRaw !== null) {
      const { machineId, resources: _pins, ...legacy } = LegacyConfigurationSchema.parse(JSON.parse(legacyRaw));
      if (legacy.containerId !== input.containerId || machineId !== input.legacyMachineId) throw new CodeRefusal("invalid_configuration");
      record = unverified(legacy);
      legacyMachineId = machineId;
    }
  }
  return { key, raw, record, resolved: stored?.resolved ?? null, workspace, legacyMachineId };
}
/**
 * Every canonical configuration this principal may read, ordered by container. A schema-1
 * machine record stays recovery data — `readConfiguration` adopts one only when a caller
 * names it — and a record whose key does not bind its own container refuses the read here as
 * it does there, because a misbound record is corruption and not a workspace.
 */
export async function readableConfigurations(ctx: CodeContext): Promise<ConfigurationEntry[]> {
  const entries: ConfigurationEntry[] = [];
  for (const key of await ctx.storage.keys("configuration/")) {
    const raw = await ctx.storage.get(key);
    if (raw === null) continue;
    const value: unknown = JSON.parse(raw);
    if (ConfigurationVersionSchema.parse(value).schemaVersion === 1) continue;
    const entry = hydrate(value);
    if (key !== `configuration/${digestOf({ containerId: entry.record.containerId })}`) throw new CodeRefusal("invalid_configuration");
    if (await allowsWorkspace(ctx, entry.record)) entries.push(entry);
  }
  return entries.sort((left, right) => left.record.containerId.localeCompare(right.record.containerId));
}
export function expectRevision(previous: StoredConfiguration, expected: number): void {
  if ((previous.record?.revision ?? 0) !== expected || expected === Number.MAX_SAFE_INTEGER) throw new CodeRefusal("stale_preferences");
}
export function requireConfiguration(previous: StoredConfiguration): Configuration {
  if (!previous.record) throw new CodeRefusal("configuration_missing");
  return previous.record;
}
/**
 * One CAS of the public record and, beside it, the private witness. `resolved` is the witness an
 * explicit choice derived (or `null`: none); left out, the stored witness carries across this
 * write while it still binds the next record. Either way only a witness that binds the record
 * written is written, and only the public record is answered.
 */
export async function commitConfiguration(ctx: CodeContext, previous: StoredConfiguration, next: Configuration,
  resolved?: ResolvedSelection | null): Promise<Configuration> {
  await authorizeTarget(ctx, previous.workspace, true);
  if (next.containerId !== previous.workspace.containerId) throw new CodeRefusal("invalid_configuration");
  const record = ConfigurationSchema.parse({ ...next, revision: (previous.record?.revision ?? 0) + 1,
    updatedBy: ctx.auth.principal.id, updatedAt: ctx.now() });
  const witness = resolved === undefined ? previous.resolved : resolved;
  const bound = witness !== null && resolvedIntent(witness, record.active, record.selection) !== null;
  const encoded = JSON.stringify(bound ? { ...record, resolvedSelection: witness } : record);
  if (Buffer.byteLength(encoded) > 512 << 10) throw new CodeRefusal("input_too_large");
  if (!(await ctx.storage.compareAndSet(previous.key, previous.raw, encoded))) throw new CodeRefusal("stale_preferences");
  ctx.emit({ kind: "container", containerId: record.containerId }, CODE_PREFERENCES_EVENT);
  return record;
}
export async function initializeConfiguration(ctx: CodeContext, input: z.infer<typeof ConfigurationLookupSchema>, expected: number) {
  const previous = await readConfiguration(ctx, input, true);
  expectRevision(previous, expected);
  if (previous.raw !== null) throw new CodeRefusal("stale_preferences");
  return commitConfiguration(ctx, previous, previous.record ?? {
    ...previous.workspace, schemaVersion: 4, revision: 1, accounts: initialAccountChoices(), active: null, draft: null,
    selection: null, updatedBy: ctx.auth.principal.id, updatedAt: ctx.now(),
  });
}

type CatalogRevision = NonNullable<Configuration["active"]>;
/** The witness of `selection` resolved on `catalog` — the main model routing leads it with, its primary
 * family's rung at its capability — or null when that model sits above the requested tier: an
 * over-ceiling lead is at most a kept legacy identity, never a resolved choice. */
function witnessOf(catalog: CatalogRevision, compiled: CompiledCatalog, selection: Selection): ResolvedSelection | null {
  const lane = selection.lane;
  const model = compiled.model(compiled.rung(lane.kind === "mixed" ? "openai" : lane.family, selection.capability));
  return model.tier > selection.capability ? null
    : { catalogDigest: catalog.digest, selectionDigest: digestOf(selection), provider: model.provider, id: model.id };
}
/**
 * The model a stored witness vouches `selection` on `catalog` resolves to, or null when there is
 * no witness or it binds anything else: other catalog bytes, any other selection, or a model the
 * canonical tiers no longer resolve it to. Null is the strict stored-identity guard's case, never
 * a refusal of its own.
 */
export function resolvedIntent(resolved: ResolvedSelection | null, catalog: CatalogRevision | null, selection: Selection | null,
  compiled?: CompiledCatalog): ModelAddress | null {
  if (resolved === null || catalog === null || selection === null || resolved.catalogDigest !== catalog.digest ||
    resolved.selectionDigest !== digestOf(selection)) return null;
  try {
    const expected = witnessOf(catalog, compiled ?? compileCatalog(catalog.document), selection);
    return expected !== null && expected.provider === resolved.provider && expected.id === resolved.id
      ? { provider: resolved.provider, id: resolved.id } : null;
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}
/**
 * A stored or automatic selection without a valid witness must still name the model its catalog's
 * stored tiers named (`assertUnambiguousSelection`): a rank saved under an older tier reading is no
 * choice of the model the canonical tiers give it. Refuses `invalid_selection`.
 */
export function admitStored(compiled: CompiledCatalog, selection: Selection, intent: ModelAddress | null): void {
  if (intent !== null) return;
  const lane = selection.lane;
  compiled.assertUnambiguousSelection(lane.kind === "mixed" ? "openai" : lane.family, selection.capability);
}
/**
 * The witness an EXPLICIT choice records, derived here and never supplied by a caller; the caller
 * has already applied every review, premium, budget and pool guard. A choice whose model sits above
 * its tier records none, and is admitted unwitnessed only where its stored identity is unambiguous.
 */
export function explicitWitness(catalog: CatalogRevision, compiled: CompiledCatalog, selection: Selection): ResolvedSelection | null {
  const witness = witnessOf(catalog, compiled, selection);
  if (witness === null) admitStored(compiled, selection, null);
  return witness;
}
/** The saved choice `newPremiumLead` weighs a new one against, with the model its valid witness
 * vouches for; null without an active catalog and selection. */
export function previousChoice(record: Configuration, resolved: ResolvedSelection | null,
  compiledActive?: CompiledCatalog): Parameters<typeof newPremiumLead>[2] {
  if (!record.active || !record.selection) return null;
  const catalog = compiledActive ?? compileCatalog(record.active.document);
  const intent = resolvedIntent(resolved, record.active, record.selection, catalog);
  return { catalog, selection: record.selection, ...(intent === null ? {} : { resolved: intent }) };
}
/**
 * A catalog's review and the witness promoting it would write. An optional `wanted` selection is a
 * new explicit choice: reviewed canonically, weighed against the saved choice, and witnessed. Without
 * one the saved (or default) selection is automatic: its valid witness, or the strict stored-identity
 * guard, admits it, and a valid witness carries to the selection as reviewed but is never created.
 */
export function catalogReview(ctx: CodeContext, previous: StoredConfiguration, source: "active" | "draft",
  wanted?: Selection): { review: CatalogReview; resolved: ResolvedSelection | null } {
  const record = requireConfiguration(previous);
  const catalog = record[source];
  if (!catalog) throw new CodeRefusal("catalog_missing");
  const compiled = compileCatalog(catalog.document);
  const prior = previousChoice(record, previous.resolved, source === "active" ? compiled : undefined);
  let selection: Selection, intent: ModelAddress | null = null;
  if (wanted !== undefined) selection = wanted;
  else {
    const providers = catalog.provenance?.providers;
    selection = source === "active" && record.selection ? record.selection
      : defaultSelection(compiled, providers ? provider => providers.includes(provider) : undefined);
    intent = resolvedIntent(previous.resolved, catalog, selection, compiled);
    admitStored(compiled, selection, intent);
  }
  const review = reviewCatalog(compiled, selection, ctx.now());
  if (newPremiumLead(compiled, review.selection, prior)) throw new DomainError("invalid_selection");
  const resolved = wanted !== undefined ? explicitWitness(catalog, compiled, review.selection)
    : intent && witnessOf(catalog, compiled, review.selection);
  const facts = { revision: record.revision, source, catalogDigest: catalog.digest, provenance: catalog.provenance, review };
  // Time-dependent estimates do not change the reviewed route and selection. Provenance is bound:
  // promoting a reviewed catalog promotes the verification it was reviewed with, and no other.
  return { resolved, review: { ...facts, reviewDigest: digestOf({ containerId: record.containerId, revision: facts.revision, source,
    catalogDigest: catalog.digest, provenance: catalog.provenance, selection: review.selection, routes: review.routes }) } };
}

/**
 * THE IDENTITY OF AN ACCOUNT POOL, as a verification records it: the providers it covers and a
 * digest of exactly which slots — scope, credential and login — serve each. Slots are ordered by
 * credential, so OMP listing the same accounts in another order is the same pool, while an added,
 * removed or re-identified slot is a different one.
 */
export function poolIdentity(pool: RuntimeAccountPool): { providers: string[]; poolIdentityDigest: string } {
  const providers = Object.keys(pool).filter(provider => pool[provider]!.length > 0).sort();
  return { providers, poolIdentityDigest: digestOf(providers.map(provider =>
    [provider, [...pool[provider]!].sort((left, right) => left.credentialId - right.credentialId)])) };
}

/**
 * The provenance a staged catalog records, read from the caller's verification. The pool is
 * recomputed here from the observation and the saved choices, and must be the very pool the
 * caller probed with: a slot added, removed or re-identified since refuses `accounts_changed`
 * rather than recording a pool the benchmark never ran against. A verified catalog names only
 * providers that pool covers, because OMP's inventory lists nothing else.
 */
export function verificationProvenance(ctx: CodeContext, record: Configuration, document: CatalogDocument,
  verification: NonNullable<ActionInput<"stageCatalog">["verification"]>): VerificationProvenance {
  if (verification.accounts.observedAt !== null && verification.accounts.observedAt > ctx.now()) throw new DomainError("invalid_accounts");
  const pool = poolIdentity(selectedAccountPool(verification.accounts, record.accounts));
  if (pool.providers.length === 0) throw new CodeRefusal("account_unavailable");
  if (pool.poolIdentityDigest !== verification.poolIdentityDigest) throw new CodeRefusal("accounts_changed");
  if (document.models.some(model => !pool.providers.includes(model.provider))) throw new CodeRefusal("invalid_provenance");
  const provenance = VerificationProvenanceSchema.safeParse({ ompVersion: verification.ompVersion,
    inventoryArtifactSha256: verification.inventoryArtifactSha256, catalogRevision: verification.catalogRevision,
    inventoryObservedAt: verification.inventoryObservedAt, benchmarkCompletedAt: verification.benchmarkCompletedAt, ...pool });
  if (!provenance.success) throw new CodeRefusal("invalid_provenance");
  return provenance.data;
}
