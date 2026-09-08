import { z } from "zod";
import { CatalogDocumentSchema, CatalogModelSchema, ThinkingLevelSchema, epochMilliseconds, identifier, type CatalogDocument, type CatalogModel } from "./contracts.ts";
import { compileCatalog } from "./catalog.ts";
import { familyOrder, familyPolicy, providerPolicy } from "./providers.ts";

export const OMP_VERSION = "18.1.14" as const;
export const PROBE_MODEL_LIMIT = 256;
const number = z.number().finite().nonnegative();
const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();
export const ProbeIdentitySchema = z.strictObject({ provider: identifier, id: CatalogModelSchema.shape.id, api: identifier });
export type ProbeIdentity = z.infer<typeof ProbeIdentitySchema>;
export const ProbeIdentitiesSchema = z.array(ProbeIdentitySchema).min(1).max(PROBE_MODEL_LIMIT);
export const InventoryModelSchema = ProbeIdentitySchema.extend({
  inputCostPerMillion: number, outputCostPerMillion: number, contextWindow: limit, maxTokens: limit,
  reasoning: z.boolean(), thinkingLevels: z.array(ThinkingLevelSchema).max(6), images: z.boolean(),
});
export const InventoryReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("inventory"), ompVersion: z.literal(OMP_VERSION),
  observedAt: epochMilliseconds, models: z.array(InventoryModelSchema).max(PROBE_MODEL_LIMIT),
});
export type InventoryReceipt = z.infer<typeof InventoryReceiptSchema>;
type InventoryModel = z.infer<typeof InventoryModelSchema>;
export const ProbeCandidateSchema = ProbeIdentitySchema.extend({ key: identifier });
export type ProbeCandidate = z.infer<typeof ProbeCandidateSchema>;
export const BenchmarkInputSchema = z.strictObject({
  schemaVersion: z.literal(1), inventoryObservedAt: epochMilliseconds, ompVersion: z.literal(OMP_VERSION),
  candidates: z.array(ProbeCandidateSchema).min(1).max(PROBE_MODEL_LIMIT),
});
export type BenchmarkInput = z.infer<typeof BenchmarkInputSchema>;
export const ProbeRefusalSchema = z.enum(["invalid_input", "unsupported_version", "invalid_observation", "ambiguous_identity", "missing_probe", "inconclusive_probe", "insufficient_ladder", "cancelled", "timeout", "output_limit", "target_failed"]);
export type ProbeRefusal = z.infer<typeof ProbeRefusalSchema>;
export class ProbeError extends Error {
  constructor(readonly code: ProbeRefusal) { super(`probe_${code}`); }
}
export const ProbeFailureReceiptSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal("refused"), code: ProbeRefusalSchema });
const metricShape = { tokensPerSecond: number, timeToFirstTokenMs: number };
export const BenchmarkResultSchema = z.discriminatedUnion("status", [
  ProbeCandidateSchema.extend({ status: z.literal("reachable"), ...metricShape }),
  ProbeCandidateSchema.extend({ status: z.enum(["not_found", "client_blocked", "unresolved", "unmatched"]), tokensPerSecond: z.null(), timeToFirstTokenMs: z.null() }),
]);
export const BenchmarkReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("benchmark"), ompVersion: z.literal(OMP_VERSION),
  inventoryObservedAt: epochMilliseconds, startedAt: epochMilliseconds, completedAt: epochMilliseconds,
  results: z.array(BenchmarkResultSchema).min(1).max(PROBE_MODEL_LIMIT),
}).refine(value => value.completedAt >= value.startedAt && value.startedAt >= value.inventoryObservedAt);
export type BenchmarkReceipt = z.infer<typeof BenchmarkReceiptSchema>;
export const ScaffoldOptionsSchema = z.strictObject({
  // A sanctioned quota observation may identify a special model. No usage IO here.
  specials: z.array(ProbeIdentitySchema.extend({ facet: z.literal("spark") })).max(3),
});
export type ScaffoldOptions = z.infer<typeof ScaffoldOptionsSchema>;
export const CatalogDraftSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal("draft"), inventoryObservedAt: epochMilliseconds,
  document: CatalogDocumentSchema, benchmark: BenchmarkInputSchema,
});
export type CatalogDraft = z.infer<typeof CatalogDraftSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown, code: ProbeRefusal = "invalid_observation"): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ProbeError(code);
  return result.data;
}
export function probeAddress(value: Pick<ProbeIdentity, "provider" | "id">): string { return `${value.provider}/${value.id}`; }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function unique<T extends ProbeIdentity>(models: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  const folded = new Set<string>();
  for (const model of models) {
    const address = probeAddress(model);
    // OMP resolution folds case; case-only variants and API aliases are ambiguous.
    if (folded.has(address.toLowerCase())) throw new ProbeError("ambiguous_identity");
    folded.add(address.toLowerCase()); out.set(address, model);
  }
  return out;
}

/** Pure projection of the pinned gateway registry, with an explicit provider permission set. */
export function projectProbeIdentities(registry: readonly { readonly provider: string; readonly id: string; readonly api: string }[], permittedProviders: readonly string[]): ProbeIdentity[] {
  const permitted = parse(z.array(identifier).min(1).max(16), permittedProviders, "invalid_input");
  const identities = parse(ProbeIdentitiesSchema, registry.filter(model => permitted.includes(model.provider))
    .map(({ provider, id, api }) => ({ provider, id, api })), "invalid_input");
  unique(identities);
  return identities.sort((a, b) => compare(probeAddress(a), probeAddress(b)));
}
export function parseBenchmarkInput(value: unknown): BenchmarkInput {
  const input = parse(BenchmarkInputSchema, value, "invalid_input");
  unique(input.candidates);
  if (new Set(input.candidates.map(candidate => candidate.key)).size !== input.candidates.length) throw new ProbeError("ambiguous_identity");
  // ':' has OMP thinking-suffix semantics. Do not permit an ambiguous selector.
  if (input.candidates.some(candidate => candidate.id.includes(":"))) throw new ProbeError("invalid_input");
  return input;
}
export function parseOmpVersion(raw: string): typeof OMP_VERSION {
  if (raw.trim() !== OMP_VERSION) throw new ProbeError("unsupported_version");
  return OMP_VERSION;
}

// v18.1.14 models-cli.ts toModelJson does NOT emit api or version. API is joined
// only from exact, sealed native models configuration identities, never spelling.
const RawInventorySchema = z.object({ models: z.array(z.object({
  provider: identifier, id: CatalogModelSchema.shape.id, selector: z.string().max(650),
  contextWindow: limit, maxTokens: limit, reasoning: z.boolean(),
  thinking: z.array(ThinkingLevelSchema).max(6).nullable(), input: z.array(z.enum(["text", "image"])).max(2),
  cost: z.object({ input: number, output: number, cacheRead: number, cacheWrite: number }),
})).max(16384) });
export function parseInventoryObservation(raw: unknown, identitiesValue: unknown, observedAt: number, version: string): InventoryReceipt {
  parseOmpVersion(version);
  const identities = unique(parse(ProbeIdentitiesSchema, identitiesValue, "invalid_input"));
  const rawModels = parse(RawInventorySchema, raw).models;
  unique(rawModels.map(model => ({ ...model, api: "unreported" })));
  const models: InventoryModel[] = [];
  for (const model of rawModels) {
    if (model.selector !== probeAddress(model)) throw new ProbeError("ambiguous_identity");
    const identity = identities.get(model.selector);
    if (!identity) continue; // Inventory is explicitly limited to the sealed permission set.
    if ((!model.reasoning && (model.thinking?.length ?? 0) > 0) || new Set(model.thinking ?? []).size !== (model.thinking?.length ?? 0)) throw new ProbeError("invalid_observation");
    models.push({ ...identity, inputCostPerMillion: model.cost.input, outputCostPerMillion: model.cost.output,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning,
      thinkingLevels: [...(model.thinking ?? [])].sort((a, b) => ThinkingLevelSchema.options.indexOf(a) - ThinkingLevelSchema.options.indexOf(b)),
      images: model.input.includes("image") });
  }
  models.sort((a, b) => compare(probeAddress(a), probeAddress(b)));
  return parse(InventoryReceiptSchema, { schemaVersion: 1, kind: "inventory", ompVersion: OMP_VERSION, observedAt, models });
}

const RawRunSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), ttftMs: number, generationTps: number, tokensPerSecond: number, challenge: z.literal("chat") }),
  z.object({ ok: z.literal(false), error: z.string().max(65536), challenge: z.literal("chat").optional() }),
]);
const distribution = z.object({ mean: number, min: number, p50: number, p95: number, max: number });
const RawBenchmarkSchema = z.object({
  runs: z.literal(1), maxTokens: z.literal(4), profile: z.literal("chat"), failures: z.number().int().nonnegative(),
  models: z.array(z.object({ selector: z.string().max(650), model: z.string().max(650),
    results: z.array(RawRunSchema).length(1), stats: z.object({ ttftMs: distribution, generationTps: distribution, tokensPerSecond: distribution }).nullable(),
  })).max(PROBE_MODEL_LIMIT),
});
export function parseBenchmarkObservation(raw: unknown, inputValue: unknown, startedAt: number, completedAt: number): BenchmarkReceipt {
  const input = parseBenchmarkInput(inputValue);
  const report = parse(RawBenchmarkSchema, raw);
  const expected = new Map(input.candidates.map(candidate => [probeAddress(candidate), candidate]));
  const rows = new Map<string, typeof report.models[number]>();
  for (const row of report.models) {
    if (!expected.has(row.selector) || rows.has(row.selector)) throw new ProbeError("ambiguous_identity");
    rows.set(row.selector, row);
  }
  if (report.failures !== report.models.filter(row => !row.results[0]!.ok).length) throw new ProbeError("invalid_observation");
  const results = input.candidates.map(candidate => {
    const row = rows.get(probeAddress(candidate));
    const failure = (status: "not_found" | "client_blocked" | "unresolved" | "unmatched") => ({ ...candidate, status, tokensPerSecond: null, timeToFirstTokenMs: null });
    if (!row || row.model !== probeAddress(candidate)) return failure("unmatched");
    const run = row.results[0]!;
    if (!run.ok) {
      if (row.stats !== null) throw new ProbeError("invalid_observation");
      // Raw error text is inspected privately and is never retained in receipts.
      if (/claude_code_version_too_old/i.test(run.error)) return failure("client_blocked");
      if (/\b(?:not_found_error|model_not_found|not_found)\b/i.test(run.error)) return failure("not_found");
      return failure("unresolved");
    }
    if (!row.stats || row.stats.generationTps.mean !== run.generationTps || row.stats.ttftMs.mean !== run.ttftMs) return failure("unresolved");
    return { ...candidate, status: "reachable" as const, tokensPerSecond: run.generationTps, timeToFirstTokenMs: run.ttftMs };
  });
  return parse(BenchmarkReceiptSchema, { schemaVersion: 1, kind: "benchmark", ompVersion: OMP_VERSION,
    inventoryObservedAt: input.inventoryObservedAt, startedAt, completedAt, results });
}

function eligible(model: InventoryModel): boolean {
  return Boolean(providerPolicy(model.provider)) && model.reasoning && model.thinkingLevels.length > 0 && model.inputCostPerMillion > 0 && !/-\d{6,8}$/.test(model.id) && !model.id.includes(":");
}
function candidateKey(model: InventoryModel): string {
  // Full exact identities remain separate fields. A stable index-free safe key.
  const key = `${model.provider}.${model.id.replace(/[^A-Za-z0-9._-]/g, "-")}`;
  return parse(identifier, key, "invalid_input");
}
export function benchmarkCandidates(inventoryValue: unknown): BenchmarkInput {
  const inventory = parse(InventoryReceiptSchema, inventoryValue);
  unique(inventory.models);
  return parseBenchmarkInput({ schemaVersion: 1, inventoryObservedAt: inventory.observedAt, ompVersion: inventory.ompVersion,
    candidates: inventory.models.filter(eligible).sort((a, b) => compare(probeAddress(a), probeAddress(b)))
      .map(model => ({ provider: model.provider, id: model.id, api: model.api, key: candidateKey(model) })) });
}
function modelFamily(id: string): { name: string; version: number[] } {
  const name: string[] = [], version: number[] = [];
  for (const token of id.split("-")) {
    if (/^\d+(?:\.\d+)*$/.test(token)) {
      const numbers = token.split(".").map(Number);
      if (numbers.some(value => !Number.isSafeInteger(value))) throw new ProbeError("invalid_observation");
      version.push(...numbers);
    } else name.push(token.toLowerCase());
  }
  return { name: name.join("-"), version };
}
function supersede(models: InventoryModel[]): InventoryModel[] {
  const latest = new Map<string, InventoryModel>();
  for (const model of models) {
    const family = modelFamily(model.id), old = latest.get(family.name);
    if (!old) { latest.set(family.name, model); continue; }
    const previous = modelFamily(old.id).version;
    let order = 0;
    for (let i = 0; i < Math.max(previous.length, family.version.length); i++) {
      order = (family.version[i] ?? -1) - (previous[i] ?? -1);
      if (order !== 0) break;
    }
    const providers = providerPolicy(model.provider)!.providers;
    if (order > 0 || (order === 0 && (providers.indexOf(model.provider) < providers.indexOf(old.provider) ||
      (model.provider === old.provider && compare(model.id, old.id) < 0)))) latest.set(family.name, model);
  }
  return [...latest.values()];
}
const ceiling = (model: InventoryModel): number => Math.max(...model.thinkingLevels.map(level => ThinkingLevelSchema.options.indexOf(level)));
const capable = (a: InventoryModel, b: InventoryModel): number => ceiling(b) - ceiling(a) || (b.contextWindow ?? 0) - (a.contextWindow ?? 0) || b.inputCostPerMillion - a.inputCostPerMillion || compare(probeAddress(a), probeAddress(b));
const cheaper = (a: InventoryModel, b: InventoryModel): number => a.inputCostPerMillion - b.inputCostPerMillion || capable(a, b);
function ladder(models: InventoryModel[]): InventoryModel[] {
  const sorted = [...models].sort(cheaper);
  if (sorted.length < 3) return sorted;
  const first = sorted[0]!, rest = sorted.slice(1), top = [...rest].sort(capable)[0]!;
  const need = Math.min(4, sorted.length) - 2;
  const middle = rest.filter(model => model !== top && model.inputCostPerMillion > first.inputCostPerMillion && model.inputCostPerMillion < top.inputCostPerMillion).sort(capable).slice(0, need);
  const remaining = rest.filter(model => model !== top && !middle.includes(model));
  for (let i = 0; middle.length < need && i < remaining.length; i++) middle.push(remaining[(Math.floor(remaining.length / 2) + i) % remaining.length]!);
  return [first, ...middle.sort(cheaper), top];
}
function scaffold(allowed: InventoryModel[], options: ScaffoldOptions, facts?: Map<string, BenchmarkReceipt["results"][number]>): CatalogDocument {
  const models: CatalogModel[] = [];
  unique(options.specials);
  for (const family of familyOrder) {
    const policy = familyPolicy(family)!;
    const candidates = supersede(allowed.filter(model => providerPolicy(model.provider)?.family === family));
    const specialChoices = options.specials.filter(special => providerPolicy(special.provider)?.family === family);
    if (specialChoices.length > 1) throw new ProbeError("ambiguous_identity");
    const requested = specialChoices[0];
    const special = requested && candidates.find(model => probeAddress(model) === probeAddress(requested) && model.api === requested.api);
    if (requested && (!special || !policy.special.some(value => value.facet === requested.facet) || !candidates.some(model => model.inputCostPerMillion > special.inputCostPerMillion))) throw new ProbeError("invalid_input");
    const rungs = ladder(candidates.filter(model => model !== special));
    if (policy.requiredLadder && rungs.length < 3) throw new ProbeError("insufficient_ladder");
    const add = (model: InventoryModel, tier: CatalogModel["tier"], quotaBucket: string | null): void => {
      const fact = facts?.get(probeAddress(model));
      models.push({ key: candidateKey(model), provider: model.provider, id: model.id, api: model.api, tier, quotaBucket,
        inputCostPerMillion: model.inputCostPerMillion, outputCostPerMillion: model.outputCostPerMillion,
        contextWindow: model.contextWindow, thinkingLevels: model.thinkingLevels, images: model.images,
        tokensPerSecond: fact?.tokensPerSecond ?? null, timeToFirstTokenMs: fact?.timeToFirstTokenMs ?? null });
    };
    if (special) add(special, 0, policy.special.find(value => value.facet === requested!.facet)!.bucket);
    rungs.forEach((model, index) => add(model, (index + 1) as CatalogModel["tier"], policy.meteredProviders.includes(model.provider) ? policy.quotaBucketBase : null));
  }
  const document = parse(CatalogDocumentSchema, { schemaVersion: 1, models });
  try { compileCatalog(document); } catch { throw new ProbeError("insufficient_ladder"); }
  return document;
}
/** Offline choices are a draft, never an inventory job and never a reachability claim. */
export function scaffoldInventory(inventoryValue: unknown, optionsValue: unknown = { specials: [] }): CatalogDraft {
  const inventory = parse(InventoryReceiptSchema, inventoryValue), options = parse(ScaffoldOptionsSchema, optionsValue, "invalid_input");
  const benchmark = benchmarkCandidates(inventory);
  return { schemaVersion: 1, kind: "draft", inventoryObservedAt: inventory.observedAt,
    document: scaffold(inventory.models.filter(eligible), options), benchmark };
}
/** Every eligible candidate must have an exact probe, before superseding older versions. */
export function catalogFromObservations(inventoryValue: unknown, benchmarkValue: unknown, optionsValue: unknown = { specials: [] }): CatalogDocument {
  const inventory = parse(InventoryReceiptSchema, inventoryValue), benchmark = parse(BenchmarkReceiptSchema, benchmarkValue);
  const options = parse(ScaffoldOptionsSchema, optionsValue, "invalid_input");
  const candidates = benchmarkCandidates(inventory).candidates;
  if (benchmark.inventoryObservedAt !== inventory.observedAt) throw new ProbeError("missing_probe");
  const facts = unique(benchmark.results);
  if (facts.size !== candidates.length) throw new ProbeError("missing_probe");
  for (const candidate of candidates) {
    const fact = facts.get(probeAddress(candidate));
    if (!fact || fact.api !== candidate.api || fact.key !== candidate.key) throw new ProbeError("missing_probe");
    if (fact.status === "unmatched" || fact.status === "unresolved") throw new ProbeError("inconclusive_probe");
  }
  return scaffold(inventory.models.filter(model => eligible(model) && facts.get(probeAddress(model))?.status === "reachable"), options, facts);
}
