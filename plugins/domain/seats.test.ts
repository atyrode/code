import { describe, expect, test } from "bun:test";
import { compileCatalog } from "./catalog.ts";
import type { CatalogDocument, CatalogModel, Selection } from "./contracts.ts";
import { reviewCatalog } from "./routing.ts";
import { seatBoard, type Seat, type SeatBoard } from "./seats.ts";

function model(key: string, provider: string, tier: CatalogModel["tier"], changes: Partial<CatalogModel> = {}): CatalogModel {
  return {
    key, provider, tier, id: `native-${key}`, api: "test-api", quotaBucket: null,
    inputCostPerMillion: 4, outputCostPerMillion: 12, tokensPerSecond: 30, timeToFirstTokenMs: 100,
    contextWindow: 200_000, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], images: true,
    ...changes,
  };
}

/** Deliberately not in family order: the board must not follow document order. */
function document(): CatalogDocument {
  return { schemaVersion: 1, models: [
    model("d2", "deepseek", 2, { images: false }),
    model("a1", "anthropic", 1), model("a2", "anthropic", 2), model("a3", "anthropic", 3), model("a4", "anthropic", 4),
    model("o1", "openai", 1), model("o2", "openai-codex", 2), model("o3", "openai", 3),
    model("spark", "openai-codex", 0, { images: false }),
  ] };
}

function selection(changes: Partial<Selection> = {}): Selection {
  return {
    lane: { kind: "mixed" }, capability: 2, thinking: "medium", advisor: "off", spark: false,
    priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any", ...changes,
  };
}

function seat(board: SeatBoard, key: string): Seat {
  const found = board.columns.flatMap(column => column.cells).find(cell => cell?.key === key);
  if (!found) throw new Error(`No seat for ${key}`);
  return found;
}

const daytime = Date.UTC(2026, 0, 1, 12);

describe("the seat board", () => {
  test("columns follow the host family order and rows run strongest first over the tiers that exist", () => {
    const catalog = compileCatalog(document());
    const board = seatBoard(catalog, reviewCatalog(catalog, selection(), daytime));
    expect(board.columns.map(column => column.family)).toEqual(["openai", "anthropic", "deepseek"]);
    expect(board.tiers).toEqual([4, 3, 2, 1, 0]);
    const keys = (family: string) => board.columns.find(column => column.family === family)!.cells.map(cell => cell?.key ?? null);
    expect(keys("openai")).toEqual([null, "o3", "o2", "o1", "spark"]);
    expect(keys("anthropic")).toEqual(["a4", "a3", "a2", "a1", null]);
    // DeepSeek borrows d2 for its missing rungs; the model still has exactly one seat, at its own tier.
    expect(keys("deepseek")).toEqual([null, null, "d2", null, null]);

    const withoutSpecials = document();
    withoutSpecials.models = withoutSpecials.models.filter(value => value.tier !== 0 && value.tier !== 4);
    const narrow = compileCatalog(withoutSpecials);
    expect(seatBoard(narrow, reviewCatalog(narrow, selection(), daytime)).tiers).toEqual([3, 2, 1]);
  });

  test("each role sits once, on its lead, with its effort and agent backing, in Code's role order", () => {
    const catalog = compileCatalog(document());
    const review = reviewCatalog(catalog, selection(), daytime);
    const board = seatBoard(catalog, review);
    const everyone = board.columns.flatMap(column => column.cells).flatMap(cell => cell?.roles.map(role => role.role) ?? []);
    expect([...everyone].sort()).toEqual(review.routes.map(route => route.role).sort());
    for (const route of review.routes) {
      expect(seat(board, route.lead.key).roles).toContainEqual({ role: route.role, thinking: route.lead.thinking, agentBacked: route.agentBacked });
    }
    // Mixed at Normal: the work stays on GPT's rung 2; planning and reviews go one rung up on Claude, one effort up.
    expect(seat(board, "o2").roles.map(role => role.role)).toEqual(["default", "task", "scout", "sonic", "vision", "smol"]);
    expect(seat(board, "a3").roles).toEqual([
      { role: "plan", thinking: "high", agentBacked: false }, { role: "slow", thinking: "high", agentBacked: false },
      { role: "reviewer", thinking: "high", agentBacked: true }, { role: "security-reviewer", thinking: "high", agentBacked: true },
    ]);
    // Seats nobody sits on stay on the board, empty.
    expect(seat(board, "a4").roles).toEqual([]);
    expect(seat(board, "d2").roles).toEqual([]);
  });

  test("roles Code does not author sit after the thirteen, by name, wherever they appear in the review", () => {
    const catalog = compileCatalog(document());
    const review = reviewCatalog(catalog, selection(), daytime);
    const custom = [
      { role: "release-notes", agentBacked: true, lead: { key: "o1", thinking: "low" as const }, fallback: [] },
      { role: "memory", agentBacked: false, lead: { key: "o1", thinking: "minimal" as const }, fallback: [] },
    ];
    const board = seatBoard(catalog, { routes: [...custom, ...review.routes] });
    expect(seat(board, "o1").roles.map(role => role.role)).toEqual(["tiny", "commit", "memory", "release-notes"]);
    expect(seat(board, "o1").roles.at(-1)).toEqual({ role: "release-notes", thinking: "low", agentBacked: true });
  });

  test("a review made against another catalog refuses instead of dropping the role", () => {
    const catalog = compileCatalog(document());
    const review = reviewCatalog(catalog, selection(), daytime);
    const routes = [...review.routes, { role: "memory", agentBacked: false, lead: { key: "gone", thinking: "low" as const }, fallback: [] }];
    expect(() => seatBoard(catalog, { routes })).toThrow("code_invalid_selection");
  });
});
