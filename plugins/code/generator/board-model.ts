import { ThinkingLevelSchema, type ThinkingLevel } from "@atyrode/manifold-omp";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import type { AccountChoiceChange, AccountChoices, ModelChoice } from "../../domain/contracts.ts";
import { familyPolicy } from "../../domain/providers.ts";
import { modelBucket, poolId, roleOutcomes, windowLabel, windowState, type QuotaPool, type QuotaReading, type RoleOutcome, type WindowState } from "../../domain/quota.ts";
import type { Review } from "../../domain/routing.ts";
import { seatBoard } from "../../domain/seats.ts";
import type { UsageView } from "../../domain/usage.ts";
import { routeChanges } from "./consequences.ts";
import { CAPABILITY_WORDS } from "./dial-space.ts";

/*
 * The seat board as data: provider columns headed by their quota pools, tier rows of model seats,
 * each role on the seat that leads it with what it meets there, and a pointed team's moves. Pure,
 * so both forms of the board (columns, and the roster below 560px) draw one model, and the rules
 * (freshness, fates, collapse, preview) are tested apart from the DOM. Quota comes only from
 * `quotaPools`/`roleOutcomes` and seats only from `seatBoard`; nothing here judges quota itself.
 */

const THINKING = ThinkingLevelSchema.options;
type UsageProvider = UsageView["providers"][number];
type UsageAccount = UsageProvider["accounts"][number];
type AccountReference = UsageAccount["account"]["reference"];
type Balance = NonNullable<UsageAccount["balance"]>;

/** Below this panel width the board is a model-grouped roster; from it up, provider columns by tier rows. */
export const ROSTER_BELOW_PX = 560;

/** A pointed team the board draws as moves before it is chosen; `key` names the pointed thing and is stable for one review. */
export type BoardPreview = { readonly key: string; readonly review: Review };

/**
 * What the board needs from the usage reading (the workbench model's `usage`), as the
 * `QuotaReading` every pool is judged on plus the account choices it edits.
 * `view`: `useAccountUsage(...).value`, the projection retained across polls; null before the first read.
 * `current`: true only while `view` is the present reading: not `useAccountUsage(...).cached`, not
 * historical choices, and no failed configuration or accounts read.
 * `nowMs`: the clock the board judges against, read once per minute (`ui.tsx` `useMinuteTick`) so
 * ages and elapsed ticks move without re-judging every render.
 * `accounts`: the saved inclusion and its edit, or null when the workspace has no account choices yet.
 */
export type BoardUsage = QuotaReading & { readonly accounts: BoardAccounts | null };
export type BoardAccounts = {
  /** The saved choices (`Configuration.accounts`): the active preset, its exclusions, the presets. */
  readonly choices: AccountChoices;
  /** The account inventory is history (stale, unread or failed): an include switch refuses on it. */
  readonly historical: boolean;
  /** An edit is in flight; switches wait for it. */
  readonly pending: boolean;
  /** Why the last edit failed, said once beside the accounts; null when it did not. */
  readonly failure: string | null;
  /** The model's guarded `changeAccounts` edit: the exact saved revision, never retried. */
  readonly change: (edit: AccountChoiceChange) => void;
};

// ---------------------------------------------------------------- pool heads

/**
 * A pool head's verdict. `room` when every judged account has room, `thin` when some do; `none`
 * says how many accounts are signed in but excluded or disabled (zero: no account at all).
 * A stale or unread reading is never room: it is `stale` with its age, or `unknown`.
 */
export type HeadVerdict =
  | { readonly kind: "room" | "thin"; readonly room: number; readonly judged: number }
  | { readonly kind: "tight" | "unmetered" | "unknown" }
  | { readonly kind: "blocked" | "maxed"; readonly until: number | null }
  | { readonly kind: "stale"; readonly ageMs: number | null }
  | { readonly kind: "none"; readonly signedIn: number };
/** One account's window: `used` 0..1, `elapsed` the window's elapsed share at the clock, `fresh` whether it is a present reading. */
export type TrackSegment = {
  readonly credentialId: number;
  readonly used: number | null;
  readonly level: WindowState["level"];
  readonly word: WindowState["word"];
  readonly elapsed: number | null;
  readonly fresh: boolean;
};
/** One window across a pool's accounts, and its one number: the highest present reading, null when none is present. */
export type PoolTrack = { readonly label: string; readonly segments: readonly TrackSegment[]; readonly percent: number | null };
export type PoolHead = {
  readonly family: string;
  /** The column's head pool: its provider's base bucket, else its first unmetered provider. */
  readonly pool: QuotaPool | null;
  /** Included, enabled accounts serving the pool, of every account signed in for its provider. */
  readonly included: number;
  readonly total: number;
  readonly verdict: HeadVerdict;
  readonly tracks: readonly PoolTrack[];
  /** Prepaid balances of an unmetered pool's included accounts. */
  readonly balances: readonly Balance[];
  /** An unmetered pool served by accounts that report no balance: said as such, never as zero. */
  readonly unreported: boolean;
  /** When the earliest window would be full at its pace so far; only where `paceForecast` allows one. */
  readonly forecast: number | null;
  /** The soonest reset of a present window near its limit, while the pool is not already out. */
  readonly reset: { readonly label: string; readonly at: number } | null;
  /** Readings left out of the judgement for their age, said once for the pool; never beside a `stale` verdict, which says it. */
  readonly stale: { readonly count: number; readonly ageMs: number } | null;
};

function readingCurrent(reading: QuotaReading): boolean {
  return reading.current && reading.view?.accountsStatus === "fresh";
}

function headVerdict(pool: QuotaPool | null, signedIn: number): HeadVerdict {
  const verdict = pool?.verdict ?? { kind: "unknown" as const };
  switch (verdict.kind) {
    case "room": case "thin": return { kind: verdict.kind, room: pool!.room, judged: pool!.judged };
    case "none": return { kind: "none", signedIn };
    case "tight": case "unmetered": case "unknown": return { kind: verdict.kind };
    default: return verdict;
  }
}

function tracksOf(pool: QuotaPool, current: boolean, nowMs: number): PoolTrack[] {
  // Shorter windows first (5h before 7d), so the rows read alike in every column.
  const labels = [...new Map(pool.windows.map(window => [window.label, window.durationMs ?? Number.POSITIVE_INFINITY]))]
    .sort(([, left], [, right]) => left - right).map(([label]) => label);
  return labels.map(label => {
    const segments = pool.windows.filter(window => window.label === label).map((window): TrackSegment => {
      const used = window.state.percent === null ? null : Math.min(1, window.state.percent / 100);
      const elapsed = window.resetsAt !== null && window.durationMs !== null && window.durationMs > 0 && window.resetsAt > nowMs
        ? Math.max(0, Math.min(1, 1 - (window.resetsAt - nowMs) / window.durationMs)) : null;
      return { credentialId: window.credentialId, used, level: window.state.level, word: window.state.word, elapsed, fresh: current && window.status === "fresh" };
    });
    const present = segments.flatMap(segment => segment.fresh && segment.used !== null ? [segment.used] : []);
    return { label, segments, percent: present.length ? Math.max(...present) * 100 : null };
  });
}

/** The head of one provider column, from its pools and the reading. */
export function poolHead(family: string, pools: readonly QuotaPool[], reading: QuotaReading): PoolHead {
  const pool = pools.find(candidate => candidate.family === family) ?? null;
  const group = pool ? reading.view?.providers.find(candidate => candidate.provider === pool.provider) : undefined;
  const total = group?.accounts.length ?? 0;
  const current = readingCurrent(reading);
  const verdict = headVerdict(pool, total);
  const tracks = pool ? tracksOf(pool, current, reading.nowMs) : [];
  const balances = pool?.bucket === null ? group?.accounts.filter(entry => entry.selected && !entry.account.disabled && entry.balance !== null).map(entry => entry.balance!) ?? [] : [];
  const forecasts = pool?.windows.flatMap(window => window.forecast?.kind === "full" ? [window.forecast.at] : []) ?? [];
  // The reset that matters while the pool still serves: the soonest of a present window near or at its limit.
  const open = verdict.kind === "room" || verdict.kind === "thin" || verdict.kind === "tight";
  const pressing = open && pool ? pool.windows.filter(window => current && window.status === "fresh" &&
    (window.state.word === "tight" || window.state.word === "maxed") && window.resetsAt !== null && window.resetsAt > reading.nowMs)
    .sort((left, right) => left.resetsAt! - right.resetsAt!)[0] : undefined;
  const staleCount = pool?.standings.filter(account => account.standing === "stale").length ?? 0;
  const staleAge = pool?.staleAgeMs ?? null;
  return {
    family, pool, included: pool?.accounts ?? 0, total, verdict, tracks, balances,
    unreported: pool?.bucket === null && pool.accounts > 0 && balances.length === 0 && reading.view !== null && reading.view.accountsStatus !== "unavailable",
    forecast: forecasts.length ? Math.min(...forecasts) : null,
    reset: pressing ? { label: pressing.label, at: pressing.resetsAt! } : null,
    stale: verdict.kind !== "stale" && staleAge !== null && staleCount > 0 ? { count: staleCount, ageMs: staleAge } : null,
  };
}

/** One account under its pool head: what to call it, whether the next launch may use it, and its readings. */
export type AccountRow = {
  readonly key: string;
  readonly provider: string;
  readonly who: string;
  readonly reference: AccountReference;
  readonly included: boolean;
  readonly disabled: boolean;
  readonly windows: readonly { readonly label: string; readonly percent: number | null }[];
  /** A block, or a present exhausted window: the account cannot serve until `until` (null: no reported reset). */
  readonly stop: { readonly word: "blocked" | "maxed"; readonly until: number | null } | null;
  readonly tight: boolean;
  /** How old the account's reading is when it is history; null while it is present. */
  readonly ageMs: number | null;
  readonly balance: Balance | null;
};

/** Every signed-in account of the column's providers, as the reading lists them, included or not, each window judged by `windowState`. */
export function accountRows(family: string, reading: QuotaReading): AccountRow[] {
  const current = readingCurrent(reading);
  return (reading.view?.providers ?? []).filter(group => group.family === family).flatMap(group => group.accounts.map((entry): AccountRow => {
    const history = !current || entry.freshness !== "fresh";
    const windows = entry.windows.map(window => ({ window, label: windowLabel(window, group.provider), state: windowState(entry, window, group.provider) }));
    const blocked = windows.flatMap(({ state }) => state.word === "blocked" ? [state.until!] : []);
    // An account without windows still stops on a block of every scope, as an unmetered pool does.
    if (entry.windows.length === 0) blocked.push(...entry.account.blocks.filter(block => block.scope === "").map(block => block.until));
    // A block is an account fact; exhaustion is current only when read fresh (quota.ts `standing`).
    const maxed = history ? undefined : windows.find(({ window, state }) => state.word === "maxed" && window.status === "fresh");
    return {
      key: JSON.stringify(entry.account.reference), provider: group.provider, reference: entry.account.reference,
      who: entry.account.email ?? (entry.account.type === "api_key" ? `API key ${entry.account.credentialId}` : entry.account.identityKey ?? `OAuth ${entry.account.credentialId}`),
      included: entry.selected, disabled: entry.account.disabled || entry.status === "credential_disabled",
      windows: windows.map(({ label, state }) => ({ label, percent: state.percent })),
      stop: blocked.length ? { word: "blocked", until: Math.max(...blocked) } : maxed ? { word: "maxed", until: maxed.window.resetsAt } : null,
      tight: !history && windows.some(({ state }) => state.word === "tight"),
      ageMs: history ? (entry.observedAt === null ? null : Math.max(0, reading.nowMs - entry.observedAt)) : null,
      balance: entry.balance,
    };
  }));
}

// ---------------------------------------------------------------- seats

/** What a role meets on its seat when its lead's pool cannot serve; a lead that serves has no fate. */
export type SeatFate =
  | { readonly kind: "falls-back"; readonly model: ModelChoice; readonly until: number | null }
  | { readonly kind: "no-route"; readonly until: number | null }
  | { readonly kind: "no-account"; readonly provider: string };
/** How the pointed team changes a role here: it leaves for another seat, keeps the seat at another effort, or is dropped. */
export type RoleChange = "moves" | "effort" | "removed";
export type SeatRole = { readonly role: string; readonly change: RoleChange | null };
/** Roles of one seat that think alike, fall back alike and meet the same fate: one line under the seat. */
export type SeatLine = {
  readonly thinking: ThinkingLevel;
  readonly roles: readonly SeatRole[];
  readonly fate: SeatFate | null;
  /** The fallbacks the session keeps, shown while no fate speaks for the line. */
  readonly chain: readonly ModelChoice[];
  /** Providers whose fallbacks the session door drops for want of an included account (`routeService` pruning). */
  readonly pruned: readonly string[];
};
export type BoardSeat = {
  readonly key: string;
  readonly family: string;
  readonly tier: number;
  readonly lines: readonly SeatLine[];
  /** A role here has no route or no account. */
  readonly stranded: boolean;
  /** The pool this seat draws on when it is not its column's head pool (Spark's own bucket); null otherwise. */
  readonly own: QuotaPool | null;
  /** Roles the pointed team would seat here that are not here now. */
  readonly arriving: readonly string[];
  /** One of them would have no route or no account here. */
  readonly arrivingStranded: boolean;
};
export type BoardColumn = {
  readonly family: string;
  readonly head: PoolHead;
  /** The column's seat at each of `BoardView.tiers`, null where the family has no model at that tier. */
  readonly cells: readonly (BoardSeat | null)[];
  /** Seats with roles, strongest first: the roster's rows. */
  readonly seated: readonly BoardSeat[];
  /** Seats without roles, strongest first, Spark after the fast rung: the bench line. */
  readonly bench: readonly BoardSeat[];
  /** No role sits in this column: it shows its pool head and one bench line. */
  readonly collapsed: boolean;
};
/** The pointed team in words for the roster, grouped by where roles go. */
export type BoardMove =
  | { readonly kind: "move"; readonly roles: readonly string[]; readonly from: string; readonly to: string }
  | { readonly kind: "add"; readonly roles: readonly string[]; readonly to: string }
  | { readonly kind: "remove"; readonly roles: readonly string[]; readonly from: string }
  | { readonly kind: "effort"; readonly roles: readonly string[]; readonly key: string; readonly from: ThinkingLevel; readonly to: ThinkingLevel };
/** Accounts a provider has that no catalog model draws on: said once below the board. */
export type OutsideProvider = { readonly provider: string; readonly family: string | null; readonly accounts: number; readonly balances: readonly Balance[] };
export type BoardView = {
  /** Tier rows strongest first, and each row's word (`elite` … `fast`, then the special rung). */
  readonly tiers: readonly number[];
  readonly rungs: readonly string[];
  /** The team's capability rung, for the rail to mark. */
  readonly capability: number;
  readonly columns: readonly BoardColumn[];
  /** What every head reserves in columns, so tracks align: as many track rows as the most any head has, and a note row when any has a note. */
  readonly headRows: { readonly tracks: number; readonly note: boolean };
  readonly moves: readonly BoardMove[];
  readonly outside: readonly OutsideProvider[];
  /** `unread`: no reading yet; `unavailable`: the broker reported none; capacity is unknown, not zero, in both. */
  readonly reading: "present" | "history" | "unavailable" | "unread";
};

export type BoardInput = {
  readonly catalog: CompiledCatalog;
  /** The shown team: the reviewed composition while it is current, else the local review. */
  readonly review: Review;
  readonly preview: Review | null;
  readonly pools: readonly QuotaPool[];
  readonly outcomes: readonly RoleOutcome[];
  /** The providers a launch's pool serves, when known (`accounts.ts` `servedProviders`). */
  readonly served: ReadonlySet<string> | null;
  readonly reading: QuotaReading;
};

function rungWord(tier: number, families: readonly string[]): string {
  if (tier >= 1) return CAPABILITY_WORDS[tier - 1] ?? `tier ${tier}`;
  for (const family of families) {
    const special = familyPolicy(family).special.find(entry => entry.tier === tier);
    if (special) return special.facet;
  }
  return `tier ${tier}`;
}

function fateOf(outcome: RoleOutcome | undefined): SeatFate | null {
  switch (outcome?.kind) {
    case "falls-back": return { kind: "falls-back", model: outcome.model, until: outcome.until };
    case "no-route": return { kind: "no-route", until: outcome.until };
    case "no-account": return { kind: "no-account", provider: outcome.provider };
    default: return null;
  }
}

/** Strongest first, with a special tier (Spark, tier 0) after the fast rung, where its rail row sits. */
const strongestFirst = (left: BoardSeat, right: BoardSeat) => (right.tier || 0.5) - (left.tier || 0.5);

function previewMoves(review: Review, preview: Review): BoardMove[] {
  const groups = new Map<string, BoardMove>();
  const add = (id: string, move: BoardMove, role: string) => {
    const found = groups.get(id);
    groups.set(id, found ? { ...found, roles: [...found.roles, role] } : move);
  };
  for (const change of routeChanges(review.routes, preview.routes)) {
    const { role, from, to } = change;
    if (change.kind === "added") add(`add:${to!.lead.key}`, { kind: "add", roles: [role], to: to!.lead.key }, role);
    else if (change.kind === "removed") add(`remove:${from!.lead.key}`, { kind: "remove", roles: [role], from: from!.lead.key }, role);
    else if (change.kind === "changed" && from!.lead.key !== to!.lead.key) add(`move:${from!.lead.key}:${to!.lead.key}`, { kind: "move", roles: [role], from: from!.lead.key, to: to!.lead.key }, role);
    else if (change.kind === "changed") add(`effort:${from!.lead.key}:${from!.lead.thinking}:${to!.lead.thinking}`,
      { kind: "effort", roles: [role], key: from!.lead.key, from: from!.lead.thinking, to: to!.lead.thinking }, role);
  }
  return [...groups.values()];
}

/**
 * The board for one team, its pools and a pointed team. Seats come from `seatBoard`, so every model
 * keeps its seat whether or not a role sits there; fates come from `roleOutcomes`; a fallback chain
 * is the one the session keeps, with the providers it drops for want of an account named apart.
 */
export function boardView({ catalog, review, preview, pools, outcomes, served, reading }: BoardInput): BoardView {
  const board = seatBoard(catalog, review);
  const routes = new Map(review.routes.map(route => [route.role, route]));
  const fates = new Map(outcomes.map(outcome => [outcome.role, outcome]));
  const moves = preview ? previewMoves(review, preview) : [];
  const change = new Map<string, RoleChange>();
  const arriving = new Map<string, string[]>();
  for (const move of moves) {
    for (const role of move.roles) {
      if (move.kind === "move") change.set(role, "moves");
      else if (move.kind === "remove") change.set(role, "removed");
      else if (move.kind === "effort") change.set(role, "effort");
      if (move.kind === "move" || move.kind === "add") arriving.set(move.to, [...arriving.get(move.to) ?? [], role]);
    }
  }
  // Roles that would have no route or no account: on the shown team, and on the pointed one where it lands them.
  const strandedRoles = (list: readonly RoleOutcome[]) => new Set(list.filter(outcome => outcome.kind === "no-route" || outcome.kind === "no-account").map(outcome => outcome.role));
  const strandedNow = strandedRoles(outcomes);
  const strandedThen = preview ? strandedRoles(roleOutcomes(catalog, preview.routes, pools)) : new Set<string>();
  const poolsById = new Map(pools.map(pool => [pool.id, pool]));

  const columns = board.columns.map((column): BoardColumn => {
    const head = poolHead(column.family, pools, reading);
    const cells = column.cells.map((cell): BoardSeat | null => {
      if (!cell) return null;
      const model = catalog.model(cell.key);
      const id = poolId(model.provider, modelBucket(model.provider, model.tier));
      const lines = new Map<string, { thinking: ThinkingLevel; roles: SeatRole[]; fate: SeatFate | null; chain: readonly ModelChoice[]; pruned: string[] }>();
      for (const seated of cell.roles) {
        const route = routes.get(seated.role)!;
        const fate = fateOf(fates.get(seated.role));
        const kept = served ? route.fallback.filter(choice => served.has(catalog.model(choice.key).provider)) : route.fallback;
        const pruned = served ? [...new Set(route.fallback.map(choice => catalog.model(choice.key).provider).filter(provider => !served.has(provider)))] : [];
        const chain = fate ? [] : kept;
        const key = JSON.stringify([seated.thinking, chain, pruned, fate]);
        const role: SeatRole = { role: seated.role, change: change.get(seated.role) ?? null };
        const found = lines.get(key);
        if (found) found.roles.push(role);
        else lines.set(key, { thinking: seated.thinking, roles: [role], fate, chain, pruned });
      }
      const incoming = arriving.get(cell.key) ?? [];
      return {
        key: cell.key, family: cell.family, tier: cell.tier,
        lines: [...lines.values()].sort((left, right) => THINKING.indexOf(right.thinking) - THINKING.indexOf(left.thinking)),
        stranded: cell.roles.some(seated => strandedNow.has(seated.role)),
        own: head.pool && id !== head.pool.id ? poolsById.get(id) ?? null : null,
        arriving: incoming, arrivingStranded: incoming.some(role => strandedThen.has(role)),
      };
    });
    const seats = cells.filter((cell): cell is BoardSeat => cell !== null);
    const seated = seats.filter(seat => seat.lines.length > 0).sort(strongestFirst);
    return { family: column.family, head, cells, seated, bench: seats.filter(seat => seat.lines.length === 0).sort(strongestFirst), collapsed: seated.length === 0 };
  });

  const view = reading.view;
  const outside = (view?.providers ?? []).filter(group => group.accounts.length > 0 && !catalog.families.includes(group.family ?? group.provider))
    .map(group => ({ provider: group.provider, family: group.family, accounts: group.accounts.length,
      balances: group.accounts.filter(entry => entry.selected && entry.balance !== null).map(entry => entry.balance!) }));
  return {
    tiers: board.tiers, rungs: board.tiers.map(tier => rungWord(tier, catalog.families)), capability: review.selection.capability,
    columns, moves, outside,
    headRows: {
      tracks: Math.max(0, ...columns.map(({ head }) => head.tracks.length || (head.balances.length || head.unreported ? 1 : 0))),
      note: columns.some(({ head }) => head.reset !== null || head.forecast !== null || head.stale !== null),
    },
    reading: view === null ? "unread" : view.accountsStatus === "unavailable" ? "unavailable" : readingCurrent(reading) ? "present" : "history",
  };
}
