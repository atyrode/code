import { PublicJobSchema } from "@manifold/protocol";
import { selectedAccountPool } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import type { RuntimeAccountPool } from "../domain/contracts.ts";
import { BenchmarkReceiptSchema, InventoryReceiptSchema, benchmarkCandidates, catalogFromObservations,
  projectProbeIdentities, scaffoldInventory } from "../domain/probe.ts";
import { compileOmpOverlay, reviewCatalog } from "../domain/routing.ts";
import { accountObservation, sharedBrokerReference } from "./broker.ts";
import { CODE_PLUGIN_ID, type Configuration, type LaunchPreview } from "./contract.ts";
import { CodeRefusal, currentOperation, digestOf, readJobResult, type CodeContext } from "./machine-server.ts";
import { bundledProbeModels } from "./sdk-metadata.macro.ts" with { type: "macro" };
import { expectRevision, readConfiguration, resourceSnapshot } from "./state.ts";

const bundledModels = bundledProbeModels();
const bundledProviders = Object.keys(bundledModels);

export async function requirePromotedOperation(ctx: CodeContext, record: Configuration, machineId: string, operation: string) {
  const resources = record.resourcesByMachine[machineId];
  if (!resources?.execution || digestOf(resources) !== digestOf(await resourceSnapshot(ctx, machineId))) throw new CodeRefusal("resources_changed");
  const operationId = `${CODE_PLUGIN_ID}.${operation}`;
  const pins = await currentOperation(ctx, machineId, operationId);
  if (pins.installationRevision !== resources.execution.installationRevision || pins.artifactSha256 !== resources.execution.artifactSha256 ||
    pins.resourceBindingDigest !== resources.execution.operations[operationId]) throw new CodeRefusal("resources_changed");
  return pins;
}
export function nativeModelConfiguration(pool: RuntimeAccountPool) {
  const providers = Object.keys(pool).filter(provider => pool[provider]!.length > 0);
  if (providers.length === 0) throw new CodeRefusal("account_unavailable");
  // Native owner substitutes only these declared capability leaves into sealed files.
  const models = { providers: Object.fromEntries(providers.map(provider => [provider, {
    baseUrl: "", apiKey: "", transport: "pi-native", discovery: { type: "proxy" },
  }])) };
  const config = { extensions: [], disabledProviders: bundledProviders.filter(provider => !providers.includes(provider)), extendedContext: true };
  return { models, config, providers };
}
async function executionAccountPool(ctx: CodeContext, record: Configuration, machineId: string) {
  const broker = record.resourcesByMachine[machineId]?.services.broker;
  if (!broker) throw new CodeRefusal("resources_incomplete");
  const reference = await sharedBrokerReference(ctx, broker);
  return selectedAccountPool(await accountObservation(ctx, reference), record.accounts);
}
async function probeInput(ctx: CodeContext, record: Configuration, machineId: string) {
  const pool = await executionAccountPool(ctx, record, machineId);
  const { models, config, providers } = nativeModelConfiguration(pool);
  const registry = bundledProviders.filter(provider => providers.includes(provider)).flatMap(provider => bundledModels[provider]!);
  const identities = projectProbeIdentities(registry, providers);
  return { models: JSON.stringify(models), config: JSON.stringify(config), modelIdentities: JSON.stringify(identities), accountPool: JSON.stringify(pool) };
}
export async function startInventory(ctx: CodeContext, record: Configuration, machineId: string) {
  const pins = await requirePromotedOperation(ctx, record, machineId, "catalog-inventory");
  const input = await probeInput(ctx, record, machineId);
  const jobId = await ctx.newId();
  expectRevision(await readConfiguration(ctx, record), record.revision);
  return PublicJobSchema.parse(await ctx.jobs.execute({ jobId, machineId,
    operationId: `${CODE_PLUGIN_ID}.catalog-inventory`, ...pins, input, outputs: [] }));
}
export async function inventoryResult(ctx: CodeContext, machineId: string, jobId: string) {
  const { job, value } = await readJobResult(ctx, machineId, "catalog-inventory", jobId, "startInventory");
  const inventory = InventoryReceiptSchema.parse(value);
  return { job, inventory, draft: scaffoldInventory(inventory) };
}
export async function startBenchmark(ctx: CodeContext, record: Configuration, machineId: string, inventoryJobId: string) {
  const pins = await requirePromotedOperation(ctx, record, machineId, "catalog-benchmark");
  const source = await inventoryResult(ctx, machineId, inventoryJobId);
  if (source.job.installationRevision !== pins.installationRevision || source.job.artifactSha256 !== pins.artifactSha256) throw new CodeRefusal("resources_changed");
  const input = { ...await probeInput(ctx, record, machineId), candidates: JSON.stringify(benchmarkCandidates(source.inventory)) };
  const jobId = await ctx.newId();
  expectRevision(await readConfiguration(ctx, record), record.revision);
  return PublicJobSchema.parse(await ctx.jobs.execute({ jobId, machineId,
    operationId: `${CODE_PLUGIN_ID}.catalog-benchmark`, ...pins, input, outputs: [] }));
}
export async function benchmarkResult(ctx: CodeContext, machineId: string, inventoryJobId: string, jobId: string) {
  const source = await inventoryResult(ctx, machineId, inventoryJobId);
  const result = await readJobResult(ctx, machineId, "catalog-benchmark", jobId, "startBenchmark");
  if (source.job.installationRevision !== result.job.installationRevision || source.job.artifactSha256 !== result.job.artifactSha256) throw new CodeRefusal("resources_changed");
  const benchmark = BenchmarkReceiptSchema.parse(result.value);
  return { job: result.job, benchmark, catalog: catalogFromObservations(source.inventory, benchmark) };
}
export async function launchPreview(ctx: CodeContext, record: Configuration, machineId: string): Promise<LaunchPreview> {
  await requirePromotedOperation(ctx, record, machineId, "launch");
  if (!record.active || !record.selection) throw new CodeRefusal("catalog_missing");
  const accountPool = await executionAccountPool(ctx, record, machineId);
  const catalog = compileCatalog(record.active.document);
  const review = reviewCatalog(catalog, record.selection, ctx.now());
  for (const route of review.routes) {
    for (const choice of [route.lead, ...route.fallback]) {
      if (!accountPool[catalog.model(choice.key).provider]?.length) throw new CodeRefusal("account_unavailable");
    }
  }
  const resources = record.resourcesByMachine[machineId]!;
  return { machineId, revision: record.revision, review, accountPool, resources,
    previewDigest: digestOf({ containerId: record.containerId, machineId, revision: record.revision,
      catalog: record.active.digest, selection: review.selection, routes: review.routes, accountPool, resources }) };
}
export function launchInput(record: Configuration, preview: LaunchPreview, prompt: string) {
  if (!record.active || !record.selection) throw new CodeRefusal("catalog_missing");
  const catalog = compileCatalog(record.active.document);
  const native = nativeModelConfiguration(preview.accountPool);
  // Code's governed web flow owns setup; the sealed OMP home is already configured.
  const config = { ...native.config, ...compileOmpOverlay(catalog, preview.review.selection, preview.review.routes),
    startup: { setupWizard: false } };
  // OMP treats even an empty positional argument as a request, so absence must omit the argv slot.
  const input = { config: JSON.stringify(config), models: JSON.stringify(native.models),
    accountPool: JSON.stringify(preview.accountPool), prompt, hasPrompt: prompt.length > 0, planYolo: record.selection.planYolo };
  if (Buffer.byteLength(JSON.stringify(input)) > 64 << 10) throw new CodeRefusal("input_too_large");
  return input;
}
