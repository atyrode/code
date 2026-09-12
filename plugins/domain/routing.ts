import { z } from "zod";
import {
  CapabilitySchema, DomainError, epochMilliseconds, EstimatesSchema, LaneSchema, RouteSchema, SelectionSchema,
  ThinkingLevelSchema, type Estimates, type Lane, type ModelChoice, type OmpOverlay, type Route,
  type Selection, type ThinkingLevel,
} from "./contracts.ts";
import type { CompiledCatalog } from "./catalog.ts";
import { advisorFamilyOrder, familyPolicy, providerPolicy } from "./providers.ts";

export const ReviewSchema = z.strictObject({
  selection: SelectionSchema,
  routes: z.array(RouteSchema).min(1).max(32),
  estimates: EstimatesSchema,
  available: z.strictObject({
    lanes: z.array(LaneSchema).min(1),
    capabilities: z.array(CapabilitySchema).min(1),
    spark: z.boolean(),
    priority: z.boolean(),
  }),
});
export type Review = z.infer<typeof ReviewSchema>;

const roles = ["default", "task", "plan", "slow", "reviewer", "security-reviewer", "scout", "sonic",
  "advisor", "vision", "smol", "tiny", "commit"] as const;
type Role = typeof roles[number];
const agentRoles: Partial<Record<Role, true>> = { task: true, reviewer: true, "security-reviewer": true, scout: true, sonic: true };
const deliberative: Partial<Record<Role, true>> = { plan: true, slow: true, reviewer: true, "security-reviewer": true };
const utilityCaps: Partial<Record<Role, readonly number[]>> = {
  commit: [1, 1, 1, 1], tiny: [1, 1, 2, 2], smol: [1, 2, 2, 2], sonic: [1, 2, 2, 2], scout: [1, 2, 2, 2],
};
const utilityThinking: Partial<Record<Role, readonly ThinkingLevel[]>> = {
  commit: ["minimal", "minimal", "minimal", "low"], tiny: ["minimal", "low", "low", "low"],
  smol: ["low", "low", "medium", "medium"], sonic: ["low", "medium", "medium", "medium"],
  scout: ["low", "medium", "medium", "medium"],
};
const weights: Record<Role, number> = {
  default: 10, task: 6, plan: 3, slow: 2, reviewer: 3, "security-reviewer": 1, scout: 2, sonic: 3,
  advisor: 4, vision: 0.5, smol: 1, tiny: 0.5, commit: 0.5,
};
const thinkingCost: Record<ThinkingLevel, number> = { minimal: 0.6, low: 0.8, medium: 1, high: 1.3, xhigh: 1.6, max: 2 };
const thinkingSpeed: Record<ThinkingLevel, number> = { minimal: 1.4, low: 1.2, medium: 1, high: 0.8, xhigh: 0.65, max: 0.5 };

function lanesFor(catalog: CompiledCatalog): Lane[] {
  const lanes: Lane[] = [];
  for (const family of catalog.families) {
    lanes.push({ kind: "provider", family, blend: "only" });
    if (catalog.families.length > 1) lanes.push({ kind: "provider", family, blend: "led" });
  }
  if (catalog.families.includes("openai") && catalog.families.includes("anthropic")) lanes.push({ kind: "mixed" });
  return lanes;
}

function selectionFacts(catalog: CompiledCatalog, input: Selection): { selection: Selection; available: Review["available"] } {
  const parsed = SelectionSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("invalid_selection");
  const selection = parsed.data;
  const lane = selection.lane;
  const lanes = lanesFor(catalog);
  if (!lanes.some(candidate => candidate.kind === lane.kind && (candidate.kind === "mixed" ||
      (lane.kind === "provider" && candidate.family === lane.family && candidate.blend === lane.blend)))) {
    throw new DomainError("invalid_selection");
  }
  const primary = lane.kind === "mixed" ? "openai" : lane.family;
  const hosted = lane.kind === "provider" && lane.blend === "only" ? [primary] : catalog.families;
  const special = catalog.special("spark");
  const capabilities: Review["available"]["capabilities"] = catalog.top(primary) === 4 ? [1, 2, 3, 4] : [1, 2, 3];
  const available = {
    lanes, capabilities,
    spark: special !== undefined && hosted.includes(catalog.family(special)),
    priority: hosted.some(family => familyPolicy(family)!.priority !== undefined),
  };
  if (!capabilities.includes(selection.capability) || (selection.spark && !available.spark) ||
      (selection.priority && !available.priority)) throw new DomainError("invalid_selection");
  return { selection, available };
}

export function defaultSelection(catalog: CompiledCatalog): Selection {
  const lane: Lane = catalog.families.includes("openai") && catalog.families.includes("anthropic")
    ? { kind: "mixed" } : { kind: "provider", family: catalog.families[0]!, blend: "only" };
  const selection: Selection = {
    lane, capability: 2, thinking: "medium", advisor: "off", spark: false, priority: false,
    prewalk: false, planYolo: false, fallback: true,
  };
  // A catalog without any image-capable model has no complete default profile.
  selectedRoutes(catalog, selection);
  return selection;
}

function selectedRoutes(catalog: CompiledCatalog, selection: Selection): Route[] {
  const { lane, capability, thinking } = selection;
  const primary = lane.kind === "mixed" ? "openai" : lane.family;
  const pure = lane.kind === "provider" && lane.blend === "only";
  const extreme = thinking === "minimal" || thinking === "max";
  const special = catalog.special("spark");
  const crossingFamily = (family: string): string | undefined => {
    const preferred = familyPolicy(family)!.crossTo;
    return catalog.families.includes(preferred) ? preferred : catalog.families.find(candidate => candidate !== family);
  };
  const sibling = (key: string): string | undefined => {
    const model = catalog.model(key);
    return model.tier >= 2 ? catalog.rung(catalog.family(key), model.tier - 1) : undefined;
  };
  const chain = (lead: string): (string | undefined)[] => {
    const lower = sibling(lead);
    if (pure) return [lower, lower ? sibling(lower) : undefined];
    const family = crossingFamily(catalog.family(lead));
    const cross = family ? catalog.rung(family, catalog.model(lead).tier) : undefined;
    return [lower, cross, cross ? sibling(cross) : undefined];
  };
  const vision = (family: string): string | undefined => {
    for (let tier = capability; tier <= catalog.top(family); tier++) {
      const key = catalog.rung(family, tier);
      if (catalog.model(key).images) return key;
    }
    for (let tier = Math.min(capability - 1, catalog.top(family)); tier >= 1; tier--) {
      const key = catalog.rung(family, tier);
      if (catalog.model(key).images) return key;
    }
    return undefined;
  };
  const choice = (key: string, level: ThinkingLevel): ModelChoice => ({ key, thinking: catalog.clampThinking(key, level) });
  const routes: Route[] = [];
  for (const role of roles) {
    let lead: string;
    let level = thinking;
    let fallbacks: (string | undefined)[] = [];
    let fallbackLevels: ThinkingLevel[] | undefined;
    if (role === "advisor") {
      if (selection.advisor === "off") continue;
      const family = pure ? primary : advisorFamilyOrder.find(candidate => candidate !== primary && catalog.families.includes(candidate));
      if (!family) throw new DomainError("invalid_selection");
      const tiers = selection.advisor === "glance" ? [1] : selection.advisor === "review" ? [2, 1] : [3, 2, 1];
      const levels: ThinkingLevel[] = selection.advisor === "glance" ? ["low"] : selection.advisor === "review" ? ["medium", "low"] : ["high", "high", "low"];
      lead = catalog.rung(family, tiers[0]!);
      level = levels[0]!;
      fallbacks = tiers.slice(1).map(tier => catalog.rung(family, tier));
      fallbackLevels = levels.slice(1);
    } else if (role === "vision") {
      const family = lane.kind === "mixed" && capability >= 3 ? "anthropic" : primary;
      let imageLead = vision(family);
      if (imageLead === undefined) {
        for (const candidate of catalog.families) {
          if (candidate === family) continue;
          imageLead = vision(candidate);
          if (imageLead !== undefined) break;
        }
      }
      if (!imageLead) throw new DomainError("invalid_selection");
      lead = imageLead;
      level = extreme ? thinking : "low";
      fallbacks = chain(lead).filter(key => key !== undefined && catalog.model(key).images);
    } else if (utilityCaps[role]) {
      const tier = utilityCaps[role]![capability - 1]!;
      if (!extreme) level = utilityThinking[role]![ThinkingLevelSchema.options.indexOf(thinking) - 1]!;
      if (selection.spark && special && (role === "tiny" || role === "commit" || (role === "sonic" && capability === 1))) {
        lead = special;
        if (!extreme) level = "low";
        fallbacks = [catalog.rung(primary, tier)];
      } else {
        lead = catalog.rung(primary, tier);
        if (role === "scout" || role === "sonic") fallbacks = [sibling(lead)];
      }
    } else {
      let family = primary;
      if (!pure && deliberative[role]) {
        if (lane.kind === "mixed") family = "anthropic";
        else if (role === "reviewer" || role === "security-reviewer") {
          const cross = crossingFamily(primary);
          if (!cross) throw new DomainError("invalid_selection");
          family = cross;
        }
      }
      lead = catalog.rung(family, capability + (deliberative[role] ? 1 : 0));
      if (!extreme && deliberative[role]) level = ThinkingLevelSchema.options[Math.min(4, ThinkingLevelSchema.options.indexOf(thinking) + 1)]!;
      fallbacks = chain(lead);
    }
    const seen = new Set([lead]);
    const fallback: ModelChoice[] = [];
    if (selection.fallback) {
      for (let index = 0; index < fallbacks.length; index++) {
        const key = fallbacks[index];
        if (!key || seen.has(key)) continue;
        seen.add(key);
        fallback.push(choice(key, fallbackLevels?.[index] ?? level));
      }
    }
    routes.push({ role, agentBacked: agentRoles[role] === true, lead: choice(lead, level), fallback });
  }
  return routes;
}

function estimate(catalog: CompiledCatalog, selection: Selection, routes: readonly Route[], nowMs: number): Estimates {
  let costSum = 0, costWeight = 0, speedSum = 0, speedWeight = 0;
  const minute = Math.floor(nowMs / 60_000) % (24 * 60);
  const hosted = selection.lane.kind === "provider" && selection.lane.blend === "only"
    ? [selection.lane.family] : catalog.families;
  for (const route of routes) {
    const model = catalog.model(route.lead.key);
    const policy = providerPolicy(model.provider)!;
    const weight = weights[route.role as Role];
    const priority = selection.priority && hosted.includes(policy.family) ? policy.priority : undefined;
    const offPeak = policy.offPeak;
    const discounted = offPeak && (offPeak.startMinutesUtc > offPeak.endMinutesUtc
      ? minute >= offPeak.startMinutesUtc || minute < offPeak.endMinutesUtc
      : minute >= offPeak.startMinutesUtc && minute < offPeak.endMinutesUtc);
    costSum += weight * (model.inputCostPerMillion * 0.25 + model.outputCostPerMillion * 0.75) *
      thinkingCost[route.lead.thinking] * (priority?.costMultiplier ?? 1) * (discounted ? offPeak.multiplier : 1);
    costWeight += weight;
    if (model.tokensPerSecond !== null && model.tokensPerSecond > 0) {
      const throughput = 300 / ((model.timeToFirstTokenMs ?? 0) / 1000 + 300 / model.tokensPerSecond);
      speedSum += weight * throughput * thinkingSpeed[route.lead.thinking] * (priority?.speedMultiplier ?? 1);
      speedWeight += weight;
    }
  }
  return {
    costScore: logScore(costSum / costWeight, 1.27, 4.42),
    speedScore: speedWeight === 0 ? 3 : logScore(speedSum / speedWeight, 2.49, 4.20),
  };
}

function logScore(value: number, lower: number, upper: number): number {
  return Math.round(Math.max(1, Math.min(5, 1 + 4 * (Math.log(value) - lower) / (upper - lower))));
}

export function reviewCatalog(catalog: CompiledCatalog, input: Selection, nowMs: number): Review {
  if (!epochMilliseconds.safeParse(nowMs).success) throw new DomainError("invalid_selection");
  const { selection, available } = selectionFacts(catalog, input);
  const routes = selectedRoutes(catalog, selection);
  return { selection, routes, estimates: estimate(catalog, selection, routes, nowMs), available };
}

/** Encode only a complete, exact selection; arbitrary or stale route lists are not overlays. */
export function compileOmpOverlay(catalog: CompiledCatalog, input: Selection, routes: readonly Route[]): OmpOverlay {
  const { selection } = selectionFacts(catalog, input);
  const expected = selectedRoutes(catalog, selection);
  const parsed = z.array(RouteSchema).max(32).safeParse(routes);
  if (!parsed.success || parsed.data.length !== expected.length) throw new DomainError("invalid_selection");
  const supplied = new Map(parsed.data.map(route => [route.role, route]));
  for (const route of expected) {
    const actual = supplied.get(route.role);
    if (!actual || actual.agentBacked !== route.agentBacked || actual.lead.key !== route.lead.key ||
        actual.lead.thinking !== route.lead.thinking || actual.fallback.length !== route.fallback.length ||
        actual.fallback.some((value, index) => value.key !== route.fallback[index]!.key || value.thinking !== route.fallback[index]!.thinking)) {
      throw new DomainError("invalid_selection");
    }
  }
  const reference = (value: ModelChoice): string => {
    const model = catalog.model(value.key);
    return `${model.provider}/${model.id}:${value.thinking}`;
  };
  const modelRoles: Record<string, string> = {};
  const fallbackChains: Record<string, string[]> = {};
  const agentModelOverrides: Record<string, string> = {};
  for (const route of expected) {
    modelRoles[route.role] = reference(route.lead);
    // Even an empty chain is explicit, avoiding OMP's default-role inheritance.
    fallbackChains[route.role] = route.fallback.map(reference);
    if (route.agentBacked) agentModelOverrides[route.role] = `@${route.role}`;
  }
  const overlay: OmpOverlay = {
    modelRoles,
    retry: selection.fallback
      ? { enabled: true, modelFallback: true, fallbackRevertPolicy: "cooldown-expiry", fallbackChains }
      : { enabled: true, modelFallback: false },
    task: { agentModelOverrides },
    defaultThinkingLevel: selection.thinking,
    advisor: { enabled: selection.advisor !== "off" },
  };
  if (selection.advisor === "audit") overlay.task!.agentAdvisor = { task: "on" };
  if (selection.prewalk) {
    overlay.task!.prewalk = true;
    overlay.prewalk = { enabled: true };
  }
  if (selection.priority) {
    const families = selection.lane.kind === "provider" && selection.lane.blend === "only" ? [selection.lane.family] : catalog.families;
    const tier: Record<string, string> = {};
    for (const family of families) {
      const priority = familyPolicy(family)!.priority;
      if (priority) tier[priority.key] = priority.value;
    }
    overlay.tier = tier;
  }
  return overlay;
}
