import { z } from "zod";
import { JobDescriptionSchema } from "@manifold/protocol";
import { initialAccountChoices } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { defaultSelection, reviewCatalog } from "../domain/routing.ts";
import { CODE_PLUGIN_ID, CODE_PREFERENCES_EVENT, ConfigurationSchema,
  PromotedResourcesSchema, type Configuration, type Target, type CatalogReview } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./machine-server.ts";

export async function authorizeTarget(ctx: CodeContext, target: Target, write = false): Promise<void> {
  if (await ctx.outsideScope(target.containerId) || !(await ctx.auth.allows(write ? "containers:write" : "containers:read",
    { kind: "container", containerId: target.containerId }))) throw new CodeRefusal("scope_refused");
}
export interface StoredConfiguration {
  key: string;
  raw: string | null;
  record: Configuration | null;
  target: Target;
}
export async function readConfiguration(ctx: CodeContext, target: Target, write = false): Promise<StoredConfiguration> {
  await authorizeTarget(ctx, target, write);
  const scope = { containerId: target.containerId, machineId: target.machineId };
  const key = `configuration/${digestOf(scope)}`;
  const raw = await ctx.storage.get(key);
  const record = raw === null ? null : ConfigurationSchema.parse(JSON.parse(raw));
  if (record && (record.containerId !== target.containerId || record.machineId !== target.machineId)) throw new CodeRefusal("invalid_configuration");
  return { key, raw, record, target: scope };
}
export function expectRevision(previous: StoredConfiguration, expected: number): void {
  if ((previous.record?.revision ?? 0) !== expected || expected === Number.MAX_SAFE_INTEGER) throw new CodeRefusal("stale_preferences");
}
export function requireConfiguration(previous: StoredConfiguration): Configuration {
  if (!previous.record) throw new CodeRefusal("configuration_missing");
  return previous.record;
}
export async function commitConfiguration(ctx: CodeContext, previous: StoredConfiguration, next: Configuration): Promise<Configuration> {
  await authorizeTarget(ctx, previous.target, true);
  const record = ConfigurationSchema.parse({ ...next, revision: (previous.record?.revision ?? 0) + 1,
    updatedBy: ctx.auth.principal.id, updatedAt: ctx.now() });
  const encoded = JSON.stringify(record);
  if (Buffer.byteLength(encoded) > 512 << 10) throw new CodeRefusal("input_too_large");
  if (!(await ctx.storage.compareAndSet(previous.key, previous.raw, encoded))) throw new CodeRefusal("stale_preferences");
  ctx.emit({ kind: "container", containerId: record.containerId }, CODE_PREFERENCES_EVENT);
  return record;
}
export async function initializeConfiguration(ctx: CodeContext, target: Target, expected: number) {
  const previous = await readConfiguration(ctx, target, true);
  expectRevision(previous, expected);
  if (previous.record !== null) throw new CodeRefusal("stale_preferences");
  return commitConfiguration(ctx, previous, {
    ...previous.target, schemaVersion: 1, revision: 1, accounts: initialAccountChoices(), active: null, draft: null,
    selection: null, resources: null, updatedBy: ctx.auth.principal.id, updatedAt: ctx.now(),
  });
}
export async function currentProductSha256(ctx: CodeContext): Promise<string> {
  const product = (await ctx.host.roster()).find(row => row.manifest.id === CODE_PLUGIN_ID);
  if (!product?.enabled || !product.install || product.install.refusal) throw new CodeRefusal("resources_incomplete");
  return product.install.sha256;
}
export async function resourceSnapshot(ctx: CodeContext, machineId: string): Promise<z.infer<typeof PromotedResourcesSchema>> {
  const productSha256 = await currentProductSha256(ctx);
  let execution: z.infer<typeof PromotedResourcesSchema>["execution"] = null;
  try {
    const description = JobDescriptionSchema.parse(await ctx.jobs.describe({ machineId, pluginId: CODE_PLUGIN_ID }));
    const installed = description.installation;
    if (installed?.enabled && !installed.purgeRequested) execution = {
      installationRevision: installed.revision, artifactSha256: installed.artifactSha256,
      operations: Object.fromEntries(Object.entries(description.operations ?? {}).map(([id, value]) => [id, value.resourceBindingDigest])),
    };
  } catch { /* Pure catalog review remains usable without execution authority; it never claims readiness. */ }
  const services: z.infer<typeof PromotedResourcesSchema>["services"] = Object.create(null);
  try {
    for (const service of (await ctx.services.describe({ machineId })).services) {
      if (["broker", "suggest", "omp"].includes(service.serviceId)) {
        const { serviceId, revision, policySha256 } = service;
        services[serviceId] = { serviceId, revision, policySha256 };
      }
    }
  } catch { /* No observed service means no promoted service authority or implicit fallback. */ }
  return PromotedResourcesSchema.parse({ productSha256, execution, services });
}
export async function catalogReview(ctx: CodeContext, record: Configuration, source: "active" | "draft"): Promise<CatalogReview> {
  const catalog = record[source];
  if (!catalog) throw new CodeRefusal("catalog_missing");
  const compiled = compileCatalog(catalog.document);
  const selection = source === "active" && record.selection ? record.selection : defaultSelection(compiled);
  const review = reviewCatalog(compiled, selection, ctx.now());
  const resources = await resourceSnapshot(ctx, record.machineId);
  const facts = { revision: record.revision, source, catalogDigest: catalog.digest, review, resources };
  // Prices may depend on time of day. The exact route/selection is authoritative; an estimate is not a resource revision.
  return { ...facts, reviewDigest: digestOf({ target: { containerId: record.containerId, machineId: record.machineId },
    revision: facts.revision, source, catalogDigest: catalog.digest, selection: review.selection, routes: review.routes, resources }) };
}
