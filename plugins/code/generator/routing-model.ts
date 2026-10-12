import { ThinkingLevelSchema } from "@atyrode/manifold-omp";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import type { CatalogModel, ModelChoice } from "../../domain/contracts.ts";
import { orderedFamilies } from "../../domain/providers.ts";
import { roleOutcomes, type QuotaPool } from "../../domain/quota.ts";
import type { Review } from "../../domain/routing.ts";
import { outWord, poolOf, thinkingWord, type Vocabulary } from "./statement-model.ts";

/*
 * The routing as data: every role on one line with its lead as `alias:thinking` in its provider's
 * hue, the fallback chain behind it, and whether quota leaves the lead out; and the same profile
 * grouped by what it runs, wherever routing is not shown with the generator. Routes come only from
 * the review and quota only from `quotaPools`/`roleOutcomes`; nothing here judges either.
 */

/** One model choice as the routing writes it. `signature` changes exactly when the token reads or colours differently. */
export type RouteToken = {
  readonly key: string;
  readonly alias: string;
  readonly thinking: string;
  readonly family: string;
  /** The exact model, `provider/id`, for the readout. */
  readonly id: string;
  /** The thinking level as the readout writes it (`x-high`). */
  readonly effort: string;
  /** The model's catalog tier, 4 elite down to 1 fast, which orders the grouped profile. */
  readonly tier: CatalogModel["tier"];
};
export type LedgerRow = {
  readonly role: string;
  readonly agentBacked: boolean;
  /** The advisor's row while the advisor is off, kept so turning it on adds a value rather than a line. */
  readonly off: boolean;
  readonly lead: RouteToken | null;
  /** Why the lead cannot serve now ("Claude blocked until 16:55 · falls back to sol:high"); null while it can. */
  readonly down: string | null;
  readonly fallback: readonly RouteToken[];
};

function token(catalog: CompiledCatalog, aliases: ReadonlyMap<string, string>, choice: ModelChoice): RouteToken {
  const model = catalog.model(choice.key);
  return {
    key: choice.key, alias: aliases.get(choice.key) ?? choice.key, thinking: choice.thinking, family: catalog.family(choice.key),
    id: `${model.provider}/${model.id}`, effort: thinkingWord(choice.thinking), tier: model.tier,
  };
}

/**
 * Every role of the review in its order, with the advisor's row held after sonic while it is off.
 * A lead is struck while its pool is blocked, maxed or served by no included account, as the
 * terminal did; that changes neither availability nor the gate, which reads its own facts.
 */
export function routeLedger(catalog: CompiledCatalog, review: Review, aliases: ReadonlyMap<string, string>, pools: readonly QuotaPool[], vocab: Vocabulary): LedgerRow[] {
  const outcomes = new Map(roleOutcomes(catalog, review.routes, pools).map(outcome => [outcome.role, outcome]));
  const rows = review.routes.map((route): LedgerRow => {
    const pool = poolOf(catalog, route.lead, pools);
    const out = pool && (pool.verdict.kind === "none" || pool.verdict.kind === "blocked" || pool.verdict.kind === "maxed") ? outWord(pool, vocab) : null;
    const outcome = outcomes.get(route.role);
    const fate = outcome?.kind === "falls-back" ? `falls back to ${token(catalog, aliases, outcome.model).alias}:${outcome.model.thinking}`
      : outcome?.kind === "no-route" ? "no route" : null;
    return {
      role: route.role, agentBacked: route.agentBacked, off: false, lead: token(catalog, aliases, route.lead),
      down: out && (fate ? `${out} · ${fate}` : out), fallback: route.fallback.map(choice => token(catalog, aliases, choice)),
    };
  });
  if (!rows.some(row => row.role === "advisor")) {
    const sonic = rows.findIndex(row => row.role === "sonic");
    rows.splice(sonic >= 0 ? sonic + 1 : rows.length, 0, { role: "advisor", agentBacked: false, off: true, lead: null, down: null, fallback: [] });
  }
  return rows;
}

/** One group of the grouped profile: a lead and thinking, and the roles that run it in routing order. */
export type ProfileGroup = { readonly key: string; readonly lead: RouteToken; readonly down: boolean; readonly roles: readonly { readonly role: string; readonly agentBacked: boolean }[] };

/**
 * The profile grouped by what it runs (`model:thinking`), read by provider and then by level: the
 * default role's provider first and the others in the panel's provider order, then within a provider
 * the stronger tier first, then the higher thinking, then the alias, so equal groups always stand
 * in one order whatever the locale. Roles keep their routing order inside a group; an off advisor
 * runs nothing.
 */
export function profileGroups(ledger: readonly LedgerRow[]): ProfileGroup[] {
  const groups = new Map<string, { key: string; lead: RouteToken; down: boolean; roles: { role: string; agentBacked: boolean }[] }>();
  for (const row of ledger) {
    if (!row.lead) continue;
    const key = `${row.lead.key}:${row.lead.thinking}`;
    const group = groups.get(key) ?? groups.set(key, { key, lead: row.lead, down: row.down !== null, roles: [] }).get(key)!;
    group.roles.push({ role: row.role, agentBacked: row.agentBacked });
  }
  const first = ledger.find(row => row.role === "default")?.lead?.family;
  const families = orderedFamilies([...groups.values()].map(group => group.lead.family));
  const rank = first === undefined ? families : [first, ...families.filter(family => family !== first)];
  const scale: readonly string[] = ThinkingLevelSchema.options;
  return [...groups.values()].sort((a, b) => rank.indexOf(a.lead.family) - rank.indexOf(b.lead.family) || b.lead.tier - a.lead.tier
    || scale.indexOf(b.lead.thinking) - scale.indexOf(a.lead.thinking) || (a.lead.alias < b.lead.alias ? -1 : a.lead.alias > b.lead.alias ? 1 : 0));
}
