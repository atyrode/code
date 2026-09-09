import { defineAction } from "@manifold/plugin";
import { PublicJobSchema, type Cap } from "@manifold/protocol";
import { z } from "zod";
import { reduceAccountChoices } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { DomainError } from "../domain/contracts.ts";
import { ProbeError } from "../domain/probe.ts";
import { reviewCatalog } from "../domain/routing.ts";
import { buildSuggestionRequest, parseSuggestionResponse, SuggestionError } from "../domain/suggestions.ts";
import { prepareSignIn, readAccountSetup } from "./auth-server.ts";
import { accountObservation, currentService, mutateCredential, usageObservation } from "./broker.ts";
import { actionSchemas, CODE_PLUGIN_ID, PrepareLaunchResultSchema, type ActionInput, type ActionResult, type CodeAction } from "./contract.ts";
import { benchmarkResult, inventoryResult, launchInput, launchPreview, requirePromotedOperation, startBenchmark, startInventory } from "./execution.ts";
import { CodeRefusal, currentResources, digestOf, type CodeContext } from "./machine-server.ts";
import { authorizeTarget, catalogReview, commitConfiguration, expectRevision, initializeConfiguration,
  currentProductSha256, readConfiguration, requireConfiguration, resourceSnapshot } from "./state.ts";

const mutating: Partial<Record<CodeAction, true>> = {
  initializeConfiguration: true, stageCatalog: true, promoteCatalog: true, select: true, changeAccounts: true,
  stageBenchmark: true, promoteResources: true, clearAccountBlocks: true, disableCredential: true,
  prepareWorkspace: true, prepareSignIn: true,
};
const instanceReads: Partial<Record<CodeAction, true>> = { accounts: true, readAccountSetup: true };
// Native APIs resolve stored resource pins and enforce the caller's concrete authority.
const actionDelegates: Partial<Record<CodeAction, readonly Cap[]>> = {
  reviewCatalog: ["machines:run", "services:read"],
  promoteCatalog: ["machines:run", "services:read"],
  accounts: ["services:read"],
  readAccountSetup: ["services:read", "machines:run"],
  prepareSignIn: ["services:read", "services:configure", "machines:run"],
  usage: ["services:read"],
  clearAccountBlocks: ["services:read", "services:invoke"],
  disableCredential: ["services:read", "services:invoke"],
  readSetup: ["machines:run", "services:read"],
  reviewResources: ["machines:run", "services:read"],
  promoteResources: ["machines:run", "services:read"],
  prepareWorkspace: ["machines:run", "services:read", "locations:create"],
  startInventory: ["machines:run", "services:read", "services:invoke", "operations:invoke", "network:host"],
  inventory: ["machines:run", "jobs:read"],
  startBenchmark: ["machines:run", "jobs:read", "services:read", "services:invoke", "operations:invoke", "network:host"],
  benchmark: ["machines:run", "jobs:read"],
  stageBenchmark: ["machines:run", "jobs:read"],
  suggest: ["services:invoke"],
  previewLaunch: ["machines:run", "services:read"],
  prepareLaunch: ["machines:run", "services:read"],
};
function refusal(error: unknown) {
  if (error instanceof CodeRefusal || error instanceof SuggestionError) return { refused: error.message };
  if (error instanceof DomainError) return { refused: `code_${error.code}` };
  if (error instanceof ProbeError) return { refused: `code_probe_${error.code}` };
  if (error instanceof z.ZodError) return { refused: "code_invalid_request" };
  return { refused: "code_operation_unavailable" };
}
type ProductHandlers = { [K in CodeAction]: (ctx: CodeContext, args: ActionInput<K>) => Promise<ActionResult<K>> };
const productHandlers: ProductHandlers = {
  async readConfiguration(ctx, args) {
    const { record } = await readConfiguration(ctx, args);
    return { revision: record?.revision ?? 0, configuration: record };
  },
  initializeConfiguration: (ctx, args) => initializeConfiguration(ctx, args, args.expectedRevision),
  async stageCatalog(ctx, args) {
    const previous = await readConfiguration(ctx, args, true); expectRevision(previous, args.expectedRevision);
    const record = requireConfiguration(previous);
    compileCatalog(args.document);
    return commitConfiguration(ctx, previous, { ...record, draft: { document: args.document, digest: digestOf(args.document) } });
  },
  async reviewCatalog(ctx, args) {
    const previous = await readConfiguration(ctx, args); expectRevision(previous, args.expectedRevision);
    return catalogReview(ctx, requireConfiguration(previous), args.source);
  },
  async promoteCatalog(ctx, args) {
    const previous = await readConfiguration(ctx, args, true); expectRevision(previous, args.expectedRevision);
    const record = requireConfiguration(previous);
    const reviewed = await catalogReview(ctx, record, args.source);
    if (reviewed.reviewDigest !== args.reviewDigest) throw new CodeRefusal("preview_changed");
    return commitConfiguration(ctx, previous, { ...record, active: record[args.source],
      draft: args.source === "draft" ? null : record.draft, selection: reviewed.review.selection, resources: reviewed.resources });
  },
  async select(ctx, args) {
    const previous = await readConfiguration(ctx, args, true); expectRevision(previous, args.expectedRevision);
    const record = requireConfiguration(previous);
    if (!record.active) throw new CodeRefusal("catalog_missing");
    reviewCatalog(compileCatalog(record.active.document), args.selection, ctx.now());
    return commitConfiguration(ctx, previous, { ...record, selection: args.selection });
  },
  async changeAccounts(ctx, args) {
    const previous = await readConfiguration(ctx, args, true); expectRevision(previous, args.expectedRevision);
    const record = requireConfiguration(previous);
    return commitConfiguration(ctx, previous, { ...record, accounts: reduceAccountChoices(record.accounts, args.change) });
  },
  accounts: ctx => accountObservation(ctx),
  readAccountSetup,
  prepareSignIn,
  async usage(ctx, args) { return usageObservation(ctx, requireConfiguration(await readConfiguration(ctx, args))); },
  async clearAccountBlocks(ctx, args) { await authorizeTarget(ctx, args, true); return mutateCredential(ctx, args.reference, "clear-blocks"); },
  async disableCredential(ctx, args) { await authorizeTarget(ctx, args, true); return mutateCredential(ctx, args.reference, "disable"); },
  async readSetup(ctx, args) {
    await authorizeTarget(ctx, args);
    const services = await ctx.services.describe({ machineId: args.machineId });
    let execution = null;
    try { execution = (await currentResources(ctx, args.machineId)).description; }
    catch { /* Service-only readiness is useful before worker installation. */ }
    return { productSha256: await currentProductSha256(ctx), execution, services: services.services, connected: services.connected };
  },
  async reviewResources(ctx, args) {
    const previous = await readConfiguration(ctx, args); expectRevision(previous, args.expectedRevision); requireConfiguration(previous);
    const resources = await resourceSnapshot(ctx, args.machineId);
    return { resources, reviewDigest: digestOf({ ...previous.target, revision: args.expectedRevision, resources }) };
  },
  async promoteResources(ctx, args) {
    const previous = await readConfiguration(ctx, args, true); expectRevision(previous, args.expectedRevision);
    const record = requireConfiguration(previous), resources = await resourceSnapshot(ctx, args.machineId);
    if (args.reviewDigest !== digestOf({ ...previous.target, revision: args.expectedRevision, resources })) throw new CodeRefusal("preview_changed");
    return commitConfiguration(ctx, previous, { ...record, resources });
  },
  async prepareWorkspace(ctx, args) {
    const previous = await readConfiguration(ctx, args, true); expectRevision(previous, args.expectedRevision);
    const pins = await requirePromotedOperation(ctx, requireConfiguration(previous), "prepare-workspace");
    if ((await readConfiguration(ctx, args)).raw !== previous.raw) throw new CodeRefusal("stale_preferences");
    return PublicJobSchema.parse(await ctx.jobs.execute({ jobId: await ctx.newId(), machineId: args.machineId,
      operationId: `${CODE_PLUGIN_ID}.prepare-workspace`, ...pins, input: {}, outputs: [] }));
  },
  async startInventory(ctx, args) {
    const previous = await readConfiguration(ctx, args); expectRevision(previous, args.expectedRevision);
    return startInventory(ctx, requireConfiguration(previous));
  },
  async inventory(ctx, args) { await authorizeTarget(ctx, args); return inventoryResult(ctx, args.machineId, args.jobId); },
  async startBenchmark(ctx, args) {
    const previous = await readConfiguration(ctx, args); expectRevision(previous, args.expectedRevision);
    return startBenchmark(ctx, requireConfiguration(previous), args.inventoryJobId);
  },
  async benchmark(ctx, args) { await authorizeTarget(ctx, args); return benchmarkResult(ctx, args.machineId, args.inventoryJobId, args.jobId); },
  async stageBenchmark(ctx, args) {
    const previous = await readConfiguration(ctx, args, true); expectRevision(previous, args.expectedRevision);
    const record = requireConfiguration(previous);
    const { catalog } = await benchmarkResult(ctx, args.machineId, args.inventoryJobId, args.jobId);
    return commitConfiguration(ctx, previous, { ...record, draft: { document: catalog, digest: digestOf(catalog) } });
  },
  async suggest(ctx, args) {
    const previous = await readConfiguration(ctx, args); expectRevision(previous, args.expectedRevision);
    const record = requireConfiguration(previous);
    if (!record.active || !record.selection) throw new CodeRefusal("catalog_missing");
    const pin = record.resources?.services.suggest;
    if (!pin) throw new CodeRefusal("resources_incomplete");
    await currentService(ctx, args.machineId, "suggest", pin);
    const catalog = compileCatalog(record.active.document);
    const input = buildSuggestionRequest(catalog, record.selection, args.prompt, ctx.now());
    const response = await ctx.services.invoke({ machineId: args.machineId, ...pin, operationId: "classify", input });
    if (!response.ok) throw new CodeRefusal(response.refusal);
    const suggestion = parseSuggestionResponse(catalog, record.selection, response.result, ctx.now());
    if ((await readConfiguration(ctx, args)).raw !== previous.raw) throw new CodeRefusal("stale_preferences");
    return { revision: record.revision, ...suggestion };
  },
  async previewLaunch(ctx, args) {
    const previous = await readConfiguration(ctx, args); expectRevision(previous, args.expectedRevision);
    const result = await launchPreview(ctx, requireConfiguration(previous));
    if ((await readConfiguration(ctx, args)).raw !== previous.raw) throw new CodeRefusal("stale_preferences");
    return result;
  },
  async prepareLaunch(ctx, args) {
    const previous = await readConfiguration(ctx, args); expectRevision(previous, args.expectedRevision);
    const record = requireConfiguration(previous), preview = await launchPreview(ctx, record);
    if (preview.previewDigest !== args.previewDigest) throw new CodeRefusal("preview_changed");
    const pins = await requirePromotedOperation(ctx, record, "launch");
    if ((await readConfiguration(ctx, args)).raw !== previous.raw) throw new CodeRefusal("stale_preferences");
    return PrepareLaunchResultSchema.parse({ runtime: { pluginId: CODE_PLUGIN_ID, operationId: `${CODE_PLUGIN_ID}.launch`,
      ...pins, input: launchInput(record, preview, args.prompt) } });
  },
};
export const handlers = Object.fromEntries((Object.keys(actionSchemas) as CodeAction[]).map(name => [name,
  async (ctx: CodeContext, raw: unknown) => {
    try {
      const args = actionSchemas[name].input.parse(raw);
      const handler = productHandlers[name] as (context: CodeContext, input: typeof args) => Promise<unknown>;
      return actionSchemas[name].result.parse(await handler(ctx, args));
    } catch (error) { return refusal(error); }
  },
]));
export default { actions: (Object.keys(actionSchemas) as CodeAction[]).map(name => defineAction({
  name, title: name.replace(/([A-Z])/g, " $1"),
  caps: [instanceReads[name] ? "services:read" : mutating[name] ? "containers:write" : "containers:read"],
  ...(actionDelegates[name] ? { delegates: actionDelegates[name]! } : {}),
  scope: instanceReads[name] ? "workspace" : "container", trace: "opaque",
  input: actionSchemas[name].input as z.ZodType<unknown>, result: actionSchemas[name].result as z.ZodType<unknown>,
})), handlers };
