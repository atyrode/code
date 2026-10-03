import type { CompiledCatalog } from "./catalog.ts";
import type { ModelChoice, Route } from "./contracts.ts";
import { providerPolicy } from "./providers.ts";
import type { UsageView } from "./usage.ts";

/*
 * Quota as a team meets it: Code's words for one usage window, each pool a catalog model draws on
 * with its verdict, and what every role runs given its actual fallback chain and those verdicts.
 * Everything here reads the projected `UsageView`; OMP still owns retries, fallback and enforcement,
 * so an outcome says what the observation implies, never what OMP was seen doing.
 */

type UsageProvider = UsageView["providers"][number];
type UsageAccount = UsageProvider["accounts"][number];
type UsageWindow = UsageAccount["windows"][number];

// ---------------------------------------------------------------- one window

/** `tight` from 80% (error level from 95%), `maxed` when exhausted, `blocked` only for a provider block. */
export type WindowState = { level: "ok" | "warn" | "error" | "unknown"; word: "" | "tight" | "maxed" | "blocked"; until: number | null; percent: number | null };

/** Whether a provider block covers this window's quota bucket, by the scope rules the bucket projection uses. */
export function blockCovers(block: { scope: string }, window: UsageWindow, provider: string): boolean {
  const policy = providerPolicy(provider);
  return block.scope === "" || (window.bucket === policy.quotaBucketBase ? block.scope === "chat" :
    policy.special.some(special => window.bucket === `${policy.quotaBucketBase}-${special.bucket}` && (block.scope === special.bucket || block.scope === `tier:${special.bucket}`)));
}

/** The words for one window. High usage alone never reads as blocked. */
export function windowState(entry: UsageAccount, window: UsageWindow, provider: string): WindowState {
  const percent = window.usedFraction === null || window.status === "unknown" ? null : window.usedFraction * 100;
  const until = entry.account.blocks.filter(block => blockCovers(block, window, provider)).map(block => block.until);
  if (until.length) return { level: "error", word: "blocked", until: Math.max(...until), percent };
  if (percent === null) return { level: "unknown", word: "", until: null, percent };
  // OMP can report 100% as a warning while the provider still serves; only a verdict-less meter falls back to its fraction.
  if (window.quotaStatus === "exhausted" || (window.quotaStatus === null && percent >= 100)) return { level: "error", word: "maxed", until: null, percent };
  if (percent >= 95) return { level: "error", word: "tight", until: null, percent };
  if (percent >= 80 || window.quotaStatus === "warning") return { level: "warn", word: "tight", until: null, percent };
  return { level: "ok", word: "", until: null, percent };
}

/** `5h`, `7d`, or the special bucket a window meters (`spark`). A plan tier (`Max`) describes the account, not the window. */
export function windowLabel(window: UsageWindow, provider: string): string {
  const duration = window.durationMs;
  const span = duration === null ? ({ "5-hour": "5h", weekly: "7d", daily: "1d" } as Readonly<Record<string, string>>)[window.windowId] ?? window.windowId
    : duration % 86_400_000 === 0 ? `${duration / 86_400_000}d` : duration % 3_600_000 === 0 ? `${duration / 3_600_000}h` : `${Math.round(duration / 60_000)}m`;
  if (window.tier !== null && providerPolicy(provider).special.some(special => special.bucket === window.tier)) return window.tier.toLowerCase();
  return span;
}

/** Early in a window a linear pace says little, so nothing is forecast before a quarter of it has passed. */
export const PACE_MIN_ELAPSED = 0.25;
/** At the window's pace so far: full at `at`, or still short of full when it resets. */
export type PaceForecast = { readonly kind: "full"; readonly at: number } | { readonly kind: "lasts" };

/**
 * A linear forecast from this one reading (no history is served): the used fraction over the time
 * the window had run when it was read. Null unless the reading is fresh and current, the window
 * has a known span and reset still ahead, is neither blocked nor maxed, and a quarter of it has
 * elapsed, because a forecast from too little of the window or from an old reading is a guess.
 */
export function paceForecast(window: UsageWindow, state: WindowState, current: boolean, nowMs: number): PaceForecast | null {
  const { usedFraction: used, resetsAt, durationMs, observedAt } = window;
  if (!current || window.status !== "fresh" || state.word === "blocked" || state.word === "maxed" || used === null ||
    resetsAt === null || durationMs === null || durationMs <= 0 || observedAt === null || resetsAt <= nowMs) return null;
  const elapsed = durationMs - (resetsAt - observedAt);
  if (elapsed < durationMs * PACE_MIN_ELAPSED || used >= 1) return null;
  if (used === 0) return { kind: "lasts" };
  const fullAt = observedAt + (1 - used) * elapsed / used;
  return fullAt < resetsAt ? { kind: "full", at: fullAt } : { kind: "lasts" };
}

// ---------------------------------------------------------------- pools

/**
 * A pool's standing at the reading, judged only over accounts whose own reading is fresh: an account
 * read long ago or never counts neither as room nor as tight. `room`: at least half the judged
 * accounts have every window under 80%. `thin`: some, but fewer than half, do. `tight`: none does,
 * though one is still allowed. `blocked`/`maxed`: no account can serve until `until` (null when no
 * reset is reported). `stale`: no current judgement is possible, the oldest reading `ageMs` old;
 * `unknown`: nothing reported. `none`: no included, enabled account serves it. `unmetered`: served by
 * accounts whose provider reports no quota windows.
 */
export type PoolVerdict =
  | { readonly kind: "room" | "thin" | "tight" | "unknown" | "none" | "unmetered" }
  | { readonly kind: "blocked" | "maxed"; readonly until: number | null }
  | { readonly kind: "stale"; readonly ageMs: number | null };
export type PoolWindow = {
  readonly credentialId: number;
  readonly windowId: string;
  readonly label: string;
  readonly state: WindowState;
  /** Whether this reading is current; a stale one keeps its percentage as history, never as standing. */
  readonly status: "fresh" | "stale" | "unknown";
  readonly resetsAt: number | null;
  readonly durationMs: number | null;
  readonly forecast: PaceForecast | null;
};
/**
 * One included account in one pool. `room` and `tight` come from fresh readings of every window it
 * has there; `out` is a block, or a fresh exhausted window. `stale` and `unknown` are judged neither
 * way: the account is history (`observedAt` says how old) or unread.
 */
export type PoolAccount = { readonly credentialId: number; readonly standing: "room" | "tight" | "out" | "stale" | "unknown"; readonly observedAt: number | null };
/** What one provider's metered bucket, or one unmetered provider, offers the team. */
export type QuotaPool = {
  /** `provider:bucket` for a metered bucket, the provider alone otherwise; identifiers cannot contain `:`. */
  readonly id: string;
  readonly provider: string;
  readonly family: string;
  /** The usage bucket (`codex`, `codex-spark`, `claude`); null for a provider that meters no windows. */
  readonly bucket: string | null;
  readonly verdict: PoolVerdict;
  /** Included, enabled accounts serving it at the reading. */
  readonly accounts: number;
  /** Each of those accounts' standing; empty for an unmetered provider. */
  readonly standings: readonly PoolAccount[];
  /** "N of M with room": accounts with room, of the accounts whose reading is fresh enough to judge. */
  readonly room: number;
  readonly judged: number;
  /** The age of the oldest reading not judged for being stale, said once for the pool; null when none is stale. */
  readonly staleAgeMs: number | null;
  /** The included, enabled accounts' windows metering this bucket. */
  readonly windows: readonly PoolWindow[];
};
/**
 * A usage projection and whether it is the present one. `current` is false when the read that
 * produced `view` failed or was superseded (a retained value, a failed poll, changed choices or
 * accounts): such a view is history, whatever its own statuses say.
 */
export type QuotaReading = { readonly view: UsageView | null; readonly current: boolean; readonly nowMs: number };

/** The usage bucket a model's requests meter: its provider's base bucket, Spark's own at tier 0; null when the provider meters no windows. */
export function modelBucket(provider: string, tier: number): string | null {
  const policy = providerPolicy(provider);
  if (!policy.meteredProviders.includes(provider)) return null;
  const special = policy.special.find(entry => entry.tier === tier);
  return special ? `${policy.quotaBucketBase}-${special.bucket}` : policy.quotaBucketBase;
}

/** A pool's identity. Provider identifiers cannot contain `:`, so a bucket never collides with a provider's own pool. */
export function poolId(provider: string, bucket: string | null): string {
  return bucket === null ? provider : `${provider}:${bucket}`;
}

/**
 * Included, enabled accounts, as the projection's bucket votes count them: a launch's pool less any
 * credential a fresh usage report says the provider disabled, which could not serve the team anyway.
 */
function usableAccounts(group: UsageProvider | undefined): UsageAccount[] {
  return group?.accounts.filter(entry => entry.selected && !entry.account.disabled && entry.status !== "credential_disabled") ?? [];
}

/** One account's standing in a bucket, from its own windows there and the account's blocks. */
function standing(entry: UsageAccount, bucket: string, provider: string): PoolAccount {
  const windows = entry.windows.filter(window => window.bucket === bucket);
  const states = windows.map(window => ({ window, state: windowState(entry, window, provider) }));
  const fact = (kind: PoolAccount["standing"]): PoolAccount => ({ credentialId: entry.account.credentialId, standing: kind, observedAt: entry.observedAt });
  // A block is an account fact, current whenever the account observation is; exhaustion is current only when read fresh.
  if (states.some(({ window, state }) => state.word === "blocked" || (state.word === "maxed" && window.status === "fresh"))) return fact("out");
  if (windows.some(window => window.status === "stale")) return fact("stale");
  if (windows.length === 0 || windows.some(window => window.status === "unknown")) return fact("unknown");
  return fact(states.every(({ state }) => state.word === "") ? "room" : "tight");
}

function verdictOf(bucket: string | null, group: UsageProvider | undefined, reading: QuotaReading, count: { room: number; judged: number }): PoolVerdict {
  const { view, current, nowMs } = reading;
  if (view === null || view.accountsStatus === "unavailable") return { kind: "unknown" };
  const usable = usableAccounts(group);
  const stale = (): PoolVerdict => {
    const times = usable.flatMap(entry => entry.observedAt === null ? [] : [entry.observedAt]);
    const observed = times.length ? Math.min(...times) : view.observedAt;
    return { kind: "stale", ageMs: observed === null ? null : Math.max(0, nowMs - observed) };
  };
  if (!current || view.accountsStatus !== "fresh") return stale();
  if (usable.length === 0) return { kind: "none" };
  if (bucket === null) {
    // An account-wide block stops an unmetered provider too; the pool reopens when its first account does.
    const reopens = usable.map(entry => entry.account.blocks.filter(block => block.scope === "").map(block => block.until));
    if (reopens.every(untils => untils.length > 0)) return { kind: "blocked", until: Math.min(...reopens.map(untils => Math.max(...untils))) };
    return { kind: "unmetered" };
  }
  const status = group?.buckets.find(candidate => candidate.name === bucket);
  switch (status?.status) {
    case "blocked": case "maxed": return { kind: status.status, until: status.resetsAt };
    case "disabled": return { kind: "none" };
    case "stale": return stale();
    case "available": break;
    default: return { kind: "unknown" };
  }
  return { kind: count.room === 0 ? "tight" : count.room * 2 < count.judged ? "thin" : "room" };
}

/**
 * Every pool the catalog's models draw on, joined with the reading: in the catalog's family order,
 * a family's base bucket, then its special buckets, then its unmetered providers. Never `room` over
 * a reading that is not fresh and current, for the pool or for any one account: such a pool is
 * `stale` with its age, or `unknown`, and such an account is left out of the judgement and its age
 * is stated once for the pool.
 */
export function quotaPools(catalog: CompiledCatalog, reading: QuotaReading): QuotaPool[] {
  const keys = new Map<string, { provider: string; family: string; bucket: string | null; rank: number }>();
  for (const model of catalog.models) {
    const bucket = modelBucket(model.provider, model.tier);
    const id = poolId(model.provider, bucket);
    if (keys.has(id)) continue;
    const policy = providerPolicy(model.provider);
    const place = bucket === null ? 2 : bucket === policy.quotaBucketBase ? 0 : 1;
    keys.set(id, { provider: model.provider, family: policy.family, bucket, rank: catalog.families.indexOf(policy.family) * 3 + place });
  }
  const ordered = [...keys].sort(([leftId, left], [rightId, right]) => left.rank - right.rank || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0));
  return ordered.map(([id, { provider, family, bucket }]) => {
    const group = reading.view?.providers.find(candidate => candidate.provider === provider);
    const usable = usableAccounts(group);
    const current = reading.current && reading.view?.accountsStatus === "fresh";
    const windows = bucket === null ? [] : usable.flatMap(entry => entry.windows.filter(window => window.bucket === bucket).map(window => {
      const state = windowState(entry, window, provider);
      return { credentialId: entry.account.credentialId, windowId: window.windowId, label: windowLabel(window, provider), state, status: window.status,
        resetsAt: window.resetsAt, durationMs: window.durationMs, forecast: paceForecast(window, state, current, reading.nowMs) };
    }));
    // A whole reading that is not current judges no account: each is history, whatever its own status says.
    const standings = bucket === null ? [] : usable.map(entry => current ? standing(entry, bucket, provider)
      : { credentialId: entry.account.credentialId, standing: entry.observedAt === null ? "unknown" as const : "stale" as const, observedAt: entry.observedAt });
    const staleTimes = standings.flatMap(account => account.standing === "stale" && account.observedAt !== null ? [account.observedAt] : []);
    const count = { room: standings.filter(account => account.standing === "room").length,
      judged: standings.filter(account => account.standing === "room" || account.standing === "tight" || account.standing === "out").length };
    return { id, provider, family, bucket, verdict: verdictOf(bucket, group, reading, count), accounts: usable.length, standings, ...count,
      staleAgeMs: staleTimes.length ? Math.max(0, reading.nowMs - Math.min(...staleTimes)) : null, windows };
  });
}

// ---------------------------------------------------------------- what each role runs

/**
 * `leads`: the lead's pool is not known to be out, so the lead serves. `falls-back`: the lead's pool
 * is blocked or maxed and the first fallback whose pool is served and not out takes over until the
 * lead's pool reopens. `no-route`: the lead's pool and every served fallback's pool are out; `until`
 * is the earliest reopening, null when any of them has no reported reset. `no-account`: no included
 * account serves the lead's provider, which the session door refuses (`account_unavailable`).
 */
export type RoleOutcome =
  | { readonly role: string; readonly kind: "leads"; readonly model: ModelChoice; readonly pool: QuotaPool | null }
  | { readonly role: string; readonly kind: "falls-back"; readonly model: ModelChoice; readonly pool: QuotaPool | null; readonly until: number | null }
  | { readonly role: string; readonly kind: "no-route"; readonly until: number | null }
  | { readonly role: string; readonly kind: "no-account"; readonly provider: string };

/** When an out pool reopens (null: no reported reset); undefined while the pool is not out. */
function reopening(pool: QuotaPool | null): number | null | undefined {
  const verdict = pool?.verdict;
  return verdict?.kind === "blocked" || verdict?.kind === "maxed" ? verdict.until : undefined;
}

/**
 * Every route's outcome from its own chain and the pools' verdicts. The chain is the route's: with
 * fallbacks off it is empty, and on a single-provider lane it stays on that provider, so the
 * Fallbacks switch alone never implies a rescue. Fallbacks no included account serves are skipped,
 * as the session door prunes them. A pool missing from `pools` is unknown, never out.
 */
export function roleOutcomes(catalog: CompiledCatalog, routes: readonly Route[], pools: readonly QuotaPool[]): RoleOutcome[] {
  const byId = new Map(pools.map(pool => [pool.id, pool]));
  const poolFor = (choice: ModelChoice) => {
    const model = catalog.model(choice.key);
    return byId.get(poolId(model.provider, modelBucket(model.provider, model.tier))) ?? null;
  };
  return routes.map((route): RoleOutcome => {
    const lead = poolFor(route.lead);
    if (lead?.verdict.kind === "none") return { role: route.role, kind: "no-account", provider: lead.provider };
    const reopens = reopening(lead);
    if (reopens === undefined) return { role: route.role, kind: "leads", model: route.lead, pool: lead };
    const chain = route.fallback.map(choice => ({ choice, pool: poolFor(choice) })).filter(entry => entry.pool?.verdict.kind !== "none");
    const rescue = chain.find(entry => reopening(entry.pool) === undefined);
    if (rescue) return { role: route.role, kind: "falls-back", model: rescue.choice, pool: rescue.pool, until: reopens };
    const untils = [reopens, ...chain.map(entry => reopening(entry.pool))];
    const known = untils.filter((until): until is number => typeof until === "number");
    return { role: route.role, kind: "no-route", until: known.length === untils.length ? Math.min(...known) : null };
  });
}
