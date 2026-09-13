import { z } from "zod";
import type { ServerMigration } from "@manifold/plugin-kit/server";
import { initialAccountChoices } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { defaultSelection, reviewCatalog } from "../domain/routing.ts";
import { CODE_PREFERENCES_EVENT, ConfigurationSchema,
  ConfigurationLookupSchema, TargetSchema, type Configuration, type Workspace, type CatalogReview } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./context.ts";

export async function authorizeTarget(ctx: CodeContext, target: Workspace, write = false): Promise<void> {
  if (await ctx.outsideScope(target.containerId) || !(await ctx.auth.allows(write ? "containers:write" : "containers:read",
    { kind: "container", containerId: target.containerId }))) throw new CodeRefusal("scope_refused");
}
export interface StoredConfiguration {
  key: string;
  raw: string | null;
  record: Configuration | null;
  workspace: Workspace;
  legacyMachineId: string | null;
}
// Old native resource pins are discarded, never interpreted as present authority.
const Version2ConfigurationSchema = ConfigurationSchema.extend({
  schemaVersion: z.literal(2), resourcesByMachine: z.record(TargetSchema.shape.machineId, z.unknown()),
});
const LegacyConfigurationSchema = ConfigurationSchema.extend({
  schemaVersion: z.literal(1), machineId: TargetSchema.shape.machineId, resources: z.unknown(),
});
const StoredConfigurationSchema = z.union([ConfigurationSchema, Version2ConfigurationSchema.transform(({ resourcesByMachine: _pins, ...record }) =>
  ConfigurationSchema.parse({ ...record, schemaVersion: 3 }))]);
const ConfigurationVersionSchema = z.object({ schemaVersion: z.number().int() });

/** Native install/ledger transaction owns this one-time major-version change.
 * It never adopts machine-local records or advances the container's policy revision. */
export const configurationMigration: ServerMigration = {
  name: "canonical-configuration-v3", to: { major: 2, minor: 0 },
  async migrate(storage) {
    for (const key of await storage.keys("configuration/")) {
      const raw = await storage.get(key);
      if (raw === null) continue;
      const value: unknown = JSON.parse(raw);
      const { schemaVersion } = ConfigurationVersionSchema.parse(value);
      if (schemaVersion === 1) continue;
      const record = StoredConfigurationSchema.parse(value);
      if (key !== `configuration/${digestOf({ containerId: record.containerId })}`) throw new CodeRefusal("invalid_configuration");
      if (schemaVersion === 3) continue;
      if (!await storage.compareAndSet(key, raw, JSON.stringify(record))) throw new CodeRefusal("stale_preferences");
    }
  },
};

export async function readConfiguration(ctx: CodeContext, input: z.infer<typeof ConfigurationLookupSchema>, write = false): Promise<StoredConfiguration> {
  await authorizeTarget(ctx, input, write);
  const workspace = { containerId: input.containerId };
  const key = `configuration/${digestOf(workspace)}`;
  const raw = await ctx.storage.get(key);
  let record = raw === null ? null : StoredConfigurationSchema.parse(JSON.parse(raw));
  let legacyMachineId: string | null = null;
  if (record && record.containerId !== input.containerId) throw new CodeRefusal("invalid_configuration");
  // Only an explicitly selected legacy destination may be adopted. The canonical
  // CAS remains null until mutation; legacy bytes are immutable recovery data.
  if (raw === null && input.legacyMachineId !== undefined) {
    const legacyRaw = await ctx.storage.get(`configuration/${digestOf({ ...workspace, machineId: input.legacyMachineId })}`);
    if (legacyRaw !== null) {
      const { machineId, resources: _pins, ...legacy } = LegacyConfigurationSchema.parse(JSON.parse(legacyRaw));
      if (legacy.containerId !== input.containerId || machineId !== input.legacyMachineId) throw new CodeRefusal("invalid_configuration");
      record = ConfigurationSchema.parse({ ...legacy, schemaVersion: 3 });
      legacyMachineId = machineId;
    }
  }
  return { key, raw, record, workspace, legacyMachineId };
}
export function expectRevision(previous: StoredConfiguration, expected: number): void {
  if ((previous.record?.revision ?? 0) !== expected || expected === Number.MAX_SAFE_INTEGER) throw new CodeRefusal("stale_preferences");
}
export function requireConfiguration(previous: StoredConfiguration): Configuration {
  if (!previous.record) throw new CodeRefusal("configuration_missing");
  return previous.record;
}
export async function commitConfiguration(ctx: CodeContext, previous: StoredConfiguration, next: Configuration): Promise<Configuration> {
  await authorizeTarget(ctx, previous.workspace, true);
  if (next.containerId !== previous.workspace.containerId) throw new CodeRefusal("invalid_configuration");
  const record = ConfigurationSchema.parse({ ...next, revision: (previous.record?.revision ?? 0) + 1,
    updatedBy: ctx.auth.principal.id, updatedAt: ctx.now() });
  const encoded = JSON.stringify(record);
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
    ...previous.workspace, schemaVersion: 3, revision: 1, accounts: initialAccountChoices(), active: null, draft: null,
    selection: null, updatedBy: ctx.auth.principal.id, updatedAt: ctx.now(),
  });
}
export function catalogReview(ctx: CodeContext, record: Configuration, source: "active" | "draft"): CatalogReview {
  const catalog = record[source];
  if (!catalog) throw new CodeRefusal("catalog_missing");
  const compiled = compileCatalog(catalog.document);
  const selection = source === "active" && record.selection ? record.selection : defaultSelection(compiled);
  const review = reviewCatalog(compiled, selection, ctx.now());
  const facts = { revision: record.revision, source, catalogDigest: catalog.digest, review };
  // Time-dependent estimates do not change the reviewed route and selection.
  return { ...facts, reviewDigest: digestOf({ containerId: record.containerId,
    revision: facts.revision, source, catalogDigest: catalog.digest, selection: review.selection, routes: review.routes }) };
}
