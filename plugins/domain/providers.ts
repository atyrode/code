import type { ProviderPolicy } from "./contracts.ts";

function policy(value: ProviderPolicy): ProviderPolicy {
  Object.freeze(value.providers);
  Object.freeze(value.meteredProviders);
  for (const special of value.special) Object.freeze(special);
  Object.freeze(value.special);
  if (value.priority) Object.freeze(value.priority);
  if (value.offPeak) Object.freeze(value.offPeak);
  return Object.freeze(value);
}

export const providerPolicies: readonly ProviderPolicy[] = Object.freeze([
  policy({
    family: "anthropic", providers: ["anthropic"], label: "Anthropic", accountLabel: "Anthropic",
    requiredLadder: true, meteredProviders: ["anthropic"], quotaBucketBase: "claude",
    crossTo: "openai", special: [],
  }),
  policy({
    family: "openai", providers: ["openai-codex", "openai"], label: "OpenAI", accountLabel: "OpenAI",
    requiredLadder: true, meteredProviders: ["openai-codex"], quotaBucketBase: "codex",
    crossTo: "anthropic", special: [{ facet: "spark", tier: 0, bucket: "spark" }],
    priority: { key: "openai", value: "priority", costMultiplier: 1.9, speedMultiplier: 1.3 },
  }),
  policy({
    family: "deepseek", providers: ["deepseek"], label: "DeepSeek", accountLabel: "DeepSeek",
    requiredLadder: false, meteredProviders: [], quotaBucketBase: "deepseek",
    crossTo: "openai", special: [],
    offPeak: { startMinutesUtc: 16 * 60 + 30, endMinutesUtc: 30, multiplier: 0.5 },
  }),
]);

export const familyOrder: readonly string[] = Object.freeze(["openai", "anthropic", "deepseek"]);
export const advisorFamilyOrder: readonly string[] = Object.freeze(["anthropic", "openai", "deepseek"]);

export function providerPolicy(providerId: string): ProviderPolicy | undefined {
  return providerPolicies.find(value => value.providers.includes(providerId));
}

export function familyPolicy(family: string): ProviderPolicy | undefined {
  return providerPolicies.find(value => value.family === family);
}
