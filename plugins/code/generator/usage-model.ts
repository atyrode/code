import { accountSelectionDisabled, disabledAccountReferences } from "../../domain/accounts.ts";
import type { AccountChoices } from "../../domain/contracts.ts";
import { orderedFamilies, providerPolicy } from "../../domain/providers.ts";
import { blockCovers, windowLabel, windowState, type QuotaReading, type WindowState } from "../../domain/quota.ts";
import type { UsageView } from "../../domain/usage.ts";

/*
 * The usage pane and the accounts view as data: per provider, then per account, each window with
 * its level, its word and when it resets, the balance, and what a window cannot say. Everything
 * reads the projected `UsageView` and the saved account choices; nothing here is judged anew.
 */

type UsageProvider = UsageView["providers"][number];
type UsageAccount = UsageProvider["accounts"][number];
type AccountReference = UsageAccount["account"]["reference"];
type Balance = NonNullable<UsageAccount["balance"]>;

/**
 * Code's usage freshness window (workflow.ts `usage`, `maxAgeMs`): a reading older than this is
 * history. The pane re-reads on this cadence, and an account read longer ago says its age.
 */
export const USAGE_FRESH_MS = 300_000;

/** One window: its label (`5h`, `7d`), its tier, how much is used, Code's word for it, and when it resets or its block lifts. */
export type UsageWindowRow = {
  readonly key: string;
  readonly label: string;
  /**
   * The limit of its own the window meters (`fable`, `base-model-inference`), named beside the
   * label so `7d` and `7d fable` are told apart; null for the account's shared windows. Only those
   * judge the provider's pool (domain/usage.ts `quotaBucket`): whether a tiered limit stops every
   * route or one model's is not reported yet, and Code does not guess.
   */
  readonly tier: string | null;
  readonly percent: number | null;
  readonly level: WindowState["level"];
  readonly word: WindowState["word"];
  /** When a covering block lifts; set only for `blocked`. */
  readonly until: number | null;
  /** The reported reset; null when the provider reports none. */
  readonly resetsAt: number | null;
};
/** A block on a scope no shown window meters: it still stops work there, so it is said on its own. */
export type UsageBlock = { readonly scope: string; readonly until: number };
export type UsageAccountRow = {
  readonly key: string;
  readonly reference: AccountReference;
  readonly who: string;
  /** In the saved pool: the saved choices decide it, so a switch shows a saved edit before the next reading. */
  readonly included: boolean;
  /** The credential itself is disabled; no inclusion can make it serve. */
  readonly disabled: boolean;
  /** How old this account's reading is when it alone is history beside present ones; null otherwise (`UsageGroup.history` covers the rest). */
  readonly ageMs: number | null;
  readonly windows: readonly UsageWindowRow[];
  readonly balance: Balance | null;
  /** Neither a window nor a balance is reported. */
  readonly unreported: boolean;
  readonly blocks: readonly UsageBlock[];
};
export type UsageGroup = {
  readonly provider: string;
  readonly family: string;
  /** Every reported reading of the provider is history: the age of its oldest, null when no reading says when it was made. */
  readonly history: { readonly ageMs: number | null } | null;
  readonly accounts: readonly UsageAccountRow[];
};
/**
 * What the pane can say. `unset`: the workspace has no account choices yet, so no reading is made.
 * `unread`: choices exist and no reading has arrived. `unavailable`: the account observation could
 * not be made. `empty`: nobody is signed in.
 */
export type UsageState =
  | { readonly kind: "unset" | "unread" | "unavailable" | "empty" }
  | { readonly kind: "groups"; readonly groups: readonly UsageGroup[] };

/** What an account is called wherever usage names it: its email, else its key or identity. */
function accountName(entry: UsageAccount): string {
  return entry.account.email ?? (entry.account.type === "api_key" ? `API key ${entry.account.credentialId}` : entry.account.identityKey ?? `OAuth ${entry.account.credentialId}`);
}

/** A provider's place within its family: the family's own provider first (`openai-codex` before `openai`). */
function providerRank(provider: string): number {
  const index = providerPolicy(provider).providers.indexOf(provider);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * The usage reading as the pane draws it. Providers come in the panel's family order (GPT, Claude,
 * DeepSeek, then the rest), each provider's accounts as the reading lists them. An account's reading
 * is history when the reading is not current, when its source was stale, or when it is older than the
 * freshness window by the reading's clock; a prepaid balance with only unknown windows shows just the
 * balance. `choices` are the saved choices, which decide inclusion; null keeps the reading's own.
 */
export function usageState(reading: QuotaReading, choices: AccountChoices | null): UsageState {
  const { view, nowMs } = reading;
  if (view === null) return { kind: choices === null ? "unset" : "unread" };
  if (view.accountsStatus === "unavailable") return { kind: "unavailable" };
  const providers = view.providers.filter(provider => provider.accounts.length > 0);
  if (providers.length === 0) return { kind: "empty" };
  const current = reading.current && view.accountsStatus === "fresh";
  const disabled = choices === null ? null : disabledAccountReferences(choices);
  const order = orderedFamilies(providers.map(provider => provider.family ?? provider.provider));
  const sorted = [...providers].sort((left, right) => order.indexOf(left.family ?? left.provider) - order.indexOf(right.family ?? right.provider) ||
    providerRank(left.provider) - providerRank(right.provider) || left.provider.localeCompare(right.provider));
  const groups = sorted.map((provider): UsageGroup => {
    const history = (entry: UsageAccount) => entry.freshness !== "unknown" &&
      (!current || entry.freshness === "stale" || (entry.observedAt !== null && nowMs - entry.observedAt > USAGE_FRESH_MS));
    const reported = provider.accounts.filter(entry => entry.freshness !== "unknown");
    const allHistory = reported.length > 0 && reported.every(history);
    const observed = reported.flatMap(entry => entry.observedAt === null ? [] : [entry.observedAt]);
    const accounts = provider.accounts.map((entry): UsageAccountRow => {
      // Every reported window is a row, a tiered one named by its tier.
      const states = entry.windows.map(window => ({ window, state: windowState(entry, window, provider.provider) }));
      const shown = states.filter(({ state }) => entry.balance === null || state.level !== "unknown");
      return {
        key: JSON.stringify([entry.account.reference, entry.account.credentialId]), reference: entry.account.reference, who: accountName(entry),
        included: disabled === null ? entry.selected : !accountSelectionDisabled(entry.account, disabled),
        disabled: entry.account.disabled || entry.status === "credential_disabled",
        ageMs: !allHistory && history(entry) && entry.observedAt !== null ? Math.max(0, nowMs - entry.observedAt) : null,
        windows: shown.map(({ window, state }) => ({
          key: JSON.stringify([window.windowId, window.tier]), label: windowLabel(window), tier: window.tier,
          percent: state.percent, level: state.level, word: state.word, until: state.until, resetsAt: window.resetsAt,
        })),
        balance: entry.balance,
        unreported: entry.balance === null && entry.windows.length === 0,
        blocks: entry.account.blocks.filter(block => !entry.windows.some(window => blockCovers(block, window, provider.provider)))
          .map(block => ({ scope: block.scope, until: block.until })),
      };
    });
    return {
      provider: provider.provider, family: provider.family ?? provider.provider,
      history: allHistory ? { ageMs: observed.length ? Math.max(0, nowMs - Math.min(...observed)) : null } : null,
      accounts,
    };
  });
  return { kind: "groups", groups };
}
