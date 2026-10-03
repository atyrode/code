import type { CompiledCatalog } from "../../domain/catalog.ts";
import type { ModelChoice, Route, Selection } from "../../domain/contracts.ts";
import { modelBucket, poolId, type QuotaPool } from "../../domain/quota.ts";
import type { Review } from "../../domain/routing.ts";
import { chooseOption, MAIN_DIALS, MORE_DIALS, SPECS, type DialId } from "./dial-space.ts";

/*
 * What a dial option would do to the team before it is chosen: which roles move, and whether the
 * pools it would lead on are out, tight or unserved. And the inverse: the smallest dial move that
 * puts one role on one model. Both walk the dials exactly as the controls commit them, so no role is
 * ever pinned by itself; Code's selection has no per-role override.
 */

export type RouteChange = { role: string; kind: "added" | "removed" | "changed" | "fallback"; from: Route | undefined; to: Route | undefined };
/** What would differ between two reviews, role by role, in display order. */
export function routeChanges(before: readonly Route[], after: readonly Route[]): RouteChange[] {
  const previous = new Map(before.map(route => [route.role, route]));
  const next = new Map(after.map(route => [route.role, route]));
  const roles = [...before.map(route => route.role), ...after.filter(route => !previous.has(route.role)).map(route => route.role)];
  const changes: RouteChange[] = [];
  for (const role of roles) {
    const from = previous.get(role), to = next.get(role);
    const kind = !from ? "added" : !to ? "removed"
      : from.lead.key !== to.lead.key || from.lead.thinking !== to.lead.thinking ? "changed"
      : JSON.stringify(from.fallback) !== JSON.stringify(to.fallback) ? "fallback" : null;
    if (kind) changes.push({ role, kind, from, to });
  }
  return changes;
}

/** A role whose lead model or effort would change; a role the option adds moves from nothing, one it drops to nothing. */
export type RoleMove = { readonly role: string; readonly from: ModelChoice | null; readonly to: ModelChoice | null };

/** Why choosing an option is drawn with a redline: worst first, a lead nobody's account serves. */
export type RedlineReason = "no-account" | "blocked" | "maxed" | "tight";
export type Redline = { readonly reason: RedlineReason; readonly pool: QuotaPool; readonly until: number | null; readonly roles: readonly string[] };
const SEVERITY: Readonly<Record<RedlineReason, number>> = { "no-account": 4, blocked: 3, maxed: 2, tight: 1 };

/**
 * The worst pool these routes would lead on, with the roles leading there: an unserved one, then
 * blocked, maxed, tight; the first such pool in pool order on a tie. Fallbacks are not counted, as a
 * fallback spends only when its lead cannot. Null when no lead's pool is any of those; a stale or
 * unknown reading never draws a redline, because it says nothing current about the pool.
 */
export function redline(catalog: CompiledCatalog, routes: readonly Route[], pools: readonly QuotaPool[]): Redline | null {
  const leading = new Map<string, string[]>();
  for (const route of routes) {
    const model = catalog.model(route.lead.key);
    const id = poolId(model.provider, modelBucket(model.provider, model.tier));
    leading.set(id, [...leading.get(id) ?? [], route.role]);
  }
  let worst: Redline | null = null;
  for (const pool of pools) {
    const roles = leading.get(pool.id);
    const { verdict } = pool;
    const reason = verdict.kind === "none" ? "no-account" : verdict.kind === "blocked" || verdict.kind === "maxed" || verdict.kind === "tight" ? verdict.kind : null;
    if (!roles || reason === null || (worst && SEVERITY[reason] <= SEVERITY[worst.reason])) continue;
    worst = { reason, pool, until: verdict.kind === "blocked" || verdict.kind === "maxed" ? verdict.until : null, roles };
  }
  return worst;
}

/** `served`: the providers a launch's pool would serve, when known (accounts.ts `servedProviders`). */
export type OptionContext = { readonly served: ReadonlySet<string> | null; readonly starter: boolean; readonly nowMs: number };
export type OptionConsequence = { readonly review: Review; readonly moves: readonly RoleMove[]; readonly redline: Redline | null };

/**
 * For the current review and one option of any dial: the roles that would move and the redline the
 * option would carry. Null when the dial refuses the option (its refusal is the dial's to say) or
 * cannot preview it, as with a bundled starter's budget.
 */
export function optionConsequence(catalog: CompiledCatalog, current: Review, dial: DialId, word: string,
  context: OptionContext & { readonly pools: readonly QuotaPool[] }): OptionConsequence | null {
  const { review } = chooseOption(catalog, current.selection, current, dial, word, context);
  if (!review) return null;
  const moves = routeChanges(current.routes, review.routes).filter(change => change.kind !== "fallback")
    .map(change => ({ role: change.role, from: change.from?.lead ?? null, to: change.to?.lead ?? null }));
  return { review, moves, redline: redline(catalog, review.routes, context.pools) };
}

export type DialMove = { readonly dial: DialId; readonly word: string };
/** A way to seat the role: the dial moves in order, what they produce, and how many other roles change model on the way. */
export type Seating = { readonly moves: readonly DialMove[]; readonly selection: Selection; readonly review: Review; readonly othersMoved: number };
/** Two dial moves: one is the common answer, two covers a lane plus a rung, and the space stays a few hundred reviews. */
export const SEATING_DEPTH = 2;
/** A ceiling on reviews per search, so a larger catalog degrades to "not found" rather than a stall. */
const SEATING_BUDGET = 4096;
const DIALS: readonly DialId[] = [...MAIN_DIALS, ...MORE_DIALS];

/**
 * The smallest dial move that seats `role` on the model `key`: the fewest moves first (breadth
 * first, up to `depth`), then the fewest other roles changing model, then the nearest cost, then
 * dial order. Each move is an option the dial would offer from where the previous one left off, so
 * a lane the reading says nobody can serve is never part of an answer. Zero moves when the role
 * already sits there; null when no reachable selection seats it.
 */
export function seatRole(catalog: CompiledCatalog, current: Review, role: string, key: string, context: OptionContext, depth = SEATING_DEPTH): Seating | null {
  const seats = (review: Review) => review.routes.some(route => route.role === role && route.lead.key === key);
  if (seats(current)) return { moves: [], selection: current.selection, review: current, othersMoved: 0 };
  const leads = new Map(current.routes.map(route => [route.role, route.lead.key]));
  const seen = new Set([JSON.stringify(current.selection)]);
  let frontier: { moves: DialMove[]; review: Review }[] = [{ moves: [], review: current }];
  let budget = SEATING_BUDGET;
  for (let level = 1; level <= depth && frontier.length && budget > 0; level++) {
    let best: (Seating & { distance: number }) | null = null;
    const next: typeof frontier = [];
    search: for (const node of frontier) {
      for (const dial of DIALS) {
        if (node.moves.some(move => move.dial === dial)) continue;
        const spec = SPECS[dial];
        const now = spec.get(node.review.selection);
        for (const word of spec.words(node.review).flat()) {
          if (word === now) continue;
          if (--budget < 0) break search;
          const { review } = chooseOption(catalog, node.review.selection, node.review, dial, word, context);
          if (!review) continue;
          const id = JSON.stringify(review.selection);
          if (seen.has(id)) continue;
          seen.add(id);
          const moves = [...node.moves, { dial, word }];
          next.push({ moves, review });
          if (!seats(review)) continue;
          const othersMoved = review.routes.filter(route => route.role !== role && leads.get(route.role) !== route.lead.key).length;
          const distance = Math.abs(review.estimates.costScore - current.estimates.costScore);
          if (!best || othersMoved < best.othersMoved || (othersMoved === best.othersMoved && distance < best.distance)) {
            best = { moves, selection: review.selection, review, othersMoved, distance };
          }
        }
      }
    }
    if (best) return { moves: best.moves, selection: best.selection, review: best.review, othersMoved: best.othersMoved };
    frontier = next;
  }
  return null;
}
