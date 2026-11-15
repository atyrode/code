import type { ProviderPolicy } from "./contracts.ts";

function policy(value: ProviderPolicy): ProviderPolicy {
  // A tier name is a tier, 1 to 4: a fifth name or a repeated one would place a model nowhere real.
  if (value.tierNames && (value.tierNames.length > 4 || new Set(value.tierNames).size !== value.tierNames.length))
    throw new Error(`${value.family}: tier names are at most four distinct words`);
  Object.freeze(value.providers);
  Object.freeze(value.meteredProviders);
  if (value.tierNames) Object.freeze(value.tierNames);
  if (value.priority) Object.freeze(value.priority);
  if (value.offPeak) Object.freeze(value.offPeak);
  return Object.freeze(value);
}

export const providerPolicies: readonly ProviderPolicy[] = Object.freeze([
  policy({
    family: "anthropic", providers: ["anthropic"], label: "Anthropic", accountLabel: "Anthropic",
    requiredLadder: true, meteredProviders: ["anthropic"], quotaBucketBase: "claude",
    crossTo: "openai",
    // Anthropic's reviewed family names, fast to elite, each held at its own tier so a missing
    // haiku or sonnet leaves that tier empty rather than moving opus or fable down to fill it.
    // The order is the provider's naming, not a price or intelligence measurement.
    tierNames: ["haiku", "sonnet", "opus", "fable"],
  }),
  policy({
    family: "openai", providers: ["openai-codex", "openai"], label: "OpenAI", accountLabel: "OpenAI",
    requiredLadder: true, meteredProviders: ["openai-codex"], quotaBucketBase: "codex",
    crossTo: "anthropic",
    // OpenAI names its tiers luna, terra, sol and astra, fast to elite. Its newer models carry
    // smaller context windows than the older terra and are priced alike, so neither price nor
    // context recovers that order; the names are the provider's own statement of it.
    tierNames: ["luna", "terra", "sol", "astra"],
    // The API priority price is twice standard pricing, not an OAuth subscription bill.
    // The speed multiplier is an estimate heuristic, not measured priority throughput.
    priority: { key: "openai", value: "priority", costMultiplier: 2.0, speedMultiplier: 1.3 },
  }),
  policy({
    family: "deepseek", providers: ["deepseek"], label: "DeepSeek", accountLabel: "DeepSeek",
    requiredLadder: false, meteredProviders: [], quotaBucketBase: "deepseek",
    crossTo: "openai",
    offPeak: { startMinutesUtc: 16 * 60 + 30, endMinutesUtc: 30, multiplier: 0.5 },
  }),
]);

export const familyOrder: readonly string[] = Object.freeze(["openai", "anthropic", "deepseek"]);
export const advisorFamilyOrder: readonly string[] = Object.freeze(["anthropic", "openai", "deepseek"]);

export function providerPolicy(providerId: string): ProviderPolicy {
  return providerPolicies.find(value => value.providers.includes(providerId)) ?? policy({
    family: providerId, providers: [providerId], label: providerId, accountLabel: providerId,
    requiredLadder: false, meteredProviders: [], quotaBucketBase: providerId,
    crossTo: null,
  });
}

export function familyPolicy(family: string): ProviderPolicy {
  return providerPolicies.find(value => value.family === family) ?? providerPolicy(family);
}

/**
 * The word a provider's tier names (`ProviderPolicy.tierNames`) are matched against: the id's last
 * name token, version tokens skipped (`gpt-6.1-sol` is `sol`, `claude-opus-4-6` is `opus`). The
 * probe ladders by it and a compiled catalog reads its effective tiers by it.
 */
export function tierWord(id: string): string {
  return id.split("-").filter(token => !/^\d+(?:\.\d+)*$/.test(token)).at(-1)?.toLowerCase() ?? "";
}

export function orderedFamilies(families: Iterable<string>, order: readonly string[] = familyOrder): readonly string[] {
  const remaining = new Set(families);
  const ordered = order.filter(family => remaining.delete(family));
  return Object.freeze([...ordered, ...[...remaining].sort()]);
}
