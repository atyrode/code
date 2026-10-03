import type { ThinkingLevel } from "@atyrode/manifold-omp";
import type { CompiledCatalog } from "./catalog.ts";
import { DomainError } from "./contracts.ts";
import { ROLES, type Review } from "./routing.ts";

/** A role sitting on the model that leads it, at the effort it will think there. */
export type SeatedRole = { readonly role: string; readonly thinking: ThinkingLevel; readonly agentBacked: boolean };
/** One catalog model, at its family's column and its own tier's row, with every role it leads. */
export type Seat = { readonly key: string; readonly family: string; readonly tier: number; readonly roles: readonly SeatedRole[] };
/** One provider family: `cells[i]` is its model at `SeatBoard.tiers[i]`, or null where the family has no model at that tier. */
export type SeatColumn = { readonly family: string; readonly cells: readonly (Seat | null)[] };
/** The team drawn on the catalog: provider-family columns in the host's family order, tier rows strongest first. */
export type SeatBoard = { readonly tiers: readonly number[]; readonly columns: readonly SeatColumn[] };

const roleRank = new Map<string, number>(ROLES.map((role, index) => [role, index]));

/**
 * Code's thirteen roles in routing order, then any other role by name. OMP accepts any role
 * identifier, so a role Code does not author still gets a stable place instead of an arbitrary one.
 */
export function compareRoles(left: string, right: string): number {
  const leftRank = roleRank.get(left) ?? roleRank.size, rightRank = roleRank.get(right) ?? roleRank.size;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every model of the catalog as a seat, with the roles whose lead it is. A seat is the model at its
 * declared tier: a family that borrows a rung for a missing tier still has one seat for that model,
 * and the borrowed position stays an empty cell. Seats nobody sits on are kept, so the board does
 * not change shape when a dial moves roles. Only leads are seated; fallbacks are not where a role
 * sits. A route whose lead is not in this catalog was reviewed against another one and refuses.
 */
export function seatBoard(catalog: CompiledCatalog, review: Pick<Review, "routes">): SeatBoard {
  const seated = new Map<string, SeatedRole[]>(catalog.models.map(model => [model.key, []]));
  for (const route of review.routes) {
    const roles = seated.get(route.lead.key);
    if (!roles) throw new DomainError("invalid_selection", `lead ${route.lead.key} of ${route.role} is not in the catalog`);
    roles.push({ role: route.role, thinking: route.lead.thinking, agentBacked: route.agentBacked });
  }
  for (const roles of seated.values()) roles.sort((left, right) => compareRoles(left.role, right.role));
  const tiers = [4, 3, 2, 1, 0].filter(tier => catalog.models.some(model => model.tier === tier));
  const columns = catalog.families.map(family => {
    const models = catalog.models.filter(model => catalog.family(model.key) === family);
    return {
      family,
      cells: tiers.map(tier => {
        const model = models.find(candidate => candidate.tier === tier);
        return model ? { key: model.key, family, tier, roles: seated.get(model.key)! } : null;
      }),
    };
  });
  return { tiers, columns };
}
