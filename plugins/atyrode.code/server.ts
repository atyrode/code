import { defineAction } from "@manifold/plugin";
import type { Cap } from "@manifold/protocol";
import { ProbeError } from "@atyrode/manifold-omp";
import { z } from "zod";
import { reduceAccountChoices, selectedAccountPool } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { DomainError } from "../domain/contracts.ts";
import { catalogFromObservations, scaffoldInventory } from "../domain/probe.ts";
import { compileOmpOverlay, reviewCatalog } from "../domain/routing.ts";
import { buildSuggestionRequest, parseSuggestionResponse, SuggestionError } from "../domain/suggestions.ts";
import { rootActionSchemas, type ActionInput, type ActionResult, type RootAction } from "./contract.ts";
import { CodeRefusal, digestOf, type CodeContext } from "./context.ts";
import { catalogReview, commitConfiguration, configurationMigration, expectRevision, initializeConfiguration,
  readConfiguration, requireConfiguration } from "./state.ts";
import { configureServices, currentSuggestionService, readServiceConfiguration, reviewServices } from "./service-setup.ts";

const mutating: Partial<Record<RootAction, true>> = {
  initializeConfiguration: true, stageCatalog: true, promoteCatalog: true, select: true, changeAccounts: true, configureServices: true,
};
const pure: Partial<Record<RootAction, true>> = { draftInventory: true, deriveCatalog: true };
// Only Code's external suggestion policy needs native authority. Policy
// composition never delegates OMP execution, jobs, accounts or terminals.
const actionDelegates: Partial<Record<RootAction, readonly Cap[]>> = {
  readServiceConfiguration: ["services:configure"],
  reviewServices: ["services:configure"],
  configureServices: ["services:configure"],
  suggest: ["services:invoke"],
};
function refusal(error: unknown) {
  if (error instanceof CodeRefusal || error instanceof SuggestionError) return { refused: error.message };
  if (error instanceof DomainError) return { refused: `code_${error.code}` };
  if (error instanceof ProbeError) return { refused: `code_probe_${error.code}` };
  if (error instanceof z.ZodError) return { refused: "code_invalid_request" };
  return { refused: "code_operation_unavailable" };
}
type ProductHandlers = { [K in RootAction]: (ctx: CodeContext, args: ActionInput<K>) => Promise<ActionResult<K>> };
const productHandlers: ProductHandlers = {
  readServiceConfiguration,
  reviewServices,
  configureServices,
  async readConfiguration(ctx, args) {
    const { record, legacyMachineId } = await readConfiguration(ctx, args);
    return { revision: record?.revision ?? 0, configuration: record, legacyMachineId };
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
    const reviewed = catalogReview(ctx, record, args.source);
    if (reviewed.reviewDigest !== args.reviewDigest) throw new CodeRefusal("preview_changed");
    return commitConfiguration(ctx, previous, { ...record, active: record[args.source],
      draft: args.source === "draft" ? null : record.draft, selection: reviewed.review.selection });
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
  async composeProbe(ctx, args) {
    const previous = await readConfiguration(ctx, args); expectRevision(previous, args.expectedRevision);
    const record = requireConfiguration(previous);
    if (args.accounts.observedAt !== null && args.accounts.observedAt > ctx.now()) throw new DomainError("invalid_accounts");
    const accountPool = selectedAccountPool(args.accounts, record.accounts);
    if (!Object.values(accountPool).some(accounts => accounts.length > 0)) throw new CodeRefusal("account_unavailable");
    if ((await readConfiguration(ctx, args)).raw !== previous.raw) throw new CodeRefusal("stale_preferences");
    return { revision: record.revision, accountPool };
  },
  async draftInventory(_ctx, args) { return scaffoldInventory(args.inventory); },
  async deriveCatalog(_ctx, args) { return catalogFromObservations(args.inventory, args.benchmark); },
  async composeSession(ctx, args) {
    const previous = await readConfiguration(ctx, args); expectRevision(previous, args.expectedRevision);
    const record = requireConfiguration(previous);
    if (!record.active || !record.selection) throw new CodeRefusal("catalog_missing");
    if (args.accounts.observedAt !== null && args.accounts.observedAt > ctx.now()) throw new DomainError("invalid_accounts");
    const accountPool = selectedAccountPool(args.accounts, record.accounts);
    const catalog = compileCatalog(record.active.document);
    const review = reviewCatalog(catalog, record.selection, ctx.now());
    for (const route of review.routes) {
      for (const choice of [route.lead, ...route.fallback]) {
        if (!accountPool[catalog.model(choice.key).provider]?.length) throw new CodeRefusal("account_unavailable");
      }
    }
    const overlay = compileOmpOverlay(catalog, review.selection, review.routes);
    const facts = { revision: record.revision, review, accountPool, overlay, prompt: args.prompt, planYolo: review.selection.planYolo };
    const compositionDigest = digestOf({ containerId: record.containerId, revision: record.revision,
      catalog: record.active.digest, selection: review.selection, routes: review.routes, accountPool,
      overlay, prompt: args.prompt, planYolo: facts.planYolo });
    if ((await readConfiguration(ctx, args)).raw !== previous.raw) throw new CodeRefusal("stale_preferences");
    return { ...facts, compositionDigest };
  },
  async suggest(ctx, args) {
    const previous = await readConfiguration(ctx, args); expectRevision(previous, args.expectedRevision);
    const record = requireConfiguration(previous);
    if (!record.active || !record.selection) throw new CodeRefusal("catalog_missing");
    const pin = await currentSuggestionService(ctx, args.machineId, args.expectedServiceRevision);
    const catalog = compileCatalog(record.active.document);
    const input = buildSuggestionRequest(catalog, record.selection, args.prompt, ctx.now());
    if ((await readConfiguration(ctx, args)).raw !== previous.raw) throw new CodeRefusal("stale_preferences");
    const response = await ctx.services.invoke({ machineId: args.machineId, ...pin, operationId: "classify", input });
    if (!response.ok) throw new CodeRefusal(response.refusal);
    const suggestion = parseSuggestionResponse(catalog, record.selection, response.result, ctx.now());
    const current = await currentSuggestionService(ctx, args.machineId, args.expectedServiceRevision);
    if (digestOf(current) !== digestOf(pin)) throw new CodeRefusal("resources_changed");
    if ((await readConfiguration(ctx, args)).raw !== previous.raw) throw new CodeRefusal("stale_preferences");
    return { revision: record.revision, serviceRevision: pin.revision, ...suggestion };
  },
};
export const handlers = Object.fromEntries((Object.keys(rootActionSchemas) as RootAction[]).map(name => [name,
  async (ctx: CodeContext, raw: unknown) => {
    try {
      const args = rootActionSchemas[name].input.parse(raw);
      const handler = productHandlers[name] as (context: CodeContext, input: typeof args) => Promise<unknown>;
      return rootActionSchemas[name].result.parse(await handler(ctx, args));
    } catch (error) { return refusal(error); }
  },
]));
export default { actions: (Object.keys(rootActionSchemas) as RootAction[]).map(name => defineAction({
  name, title: name.replace(/([A-Z])/g, " $1"),
  caps: pure[name] ? [] : [mutating[name] ? "containers:write" : "containers:read"],
  ...(actionDelegates[name] ? { delegates: actionDelegates[name]! } : {}),
  scope: pure[name] ? "workspace" : "container", trace: "opaque",
  input: rootActionSchemas[name].input as z.ZodType<unknown>, result: rootActionSchemas[name].result as z.ZodType<unknown>,
})), handlers, migrations: [configurationMigration] };
