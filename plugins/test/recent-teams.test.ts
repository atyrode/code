import { describe, expect, test } from "bun:test";
import type { Selection } from "../domain/contracts.ts";
import { readRecentTeams, recentTeamsKey, rememberLaunch, RECENT_TEAMS_LIMIT, type TeamStorage } from "../code/generator/recent-teams.ts";

function memory(initial: Record<string, string> = {}): TeamStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}
function team(changes: Partial<Selection> = {}): Selection {
  return { lane: { kind: "mixed" }, capability: 3, thinking: "medium", advisor: "glance", spark: true,
    priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any", ...changes };
}
const key = recentTeamsKey("principal-1", "workspace-1");

describe("recent teams in this browser", () => {
  test("newest first, one entry per team at its latest launch, whatever key order the team was written in", () => {
    const storage = memory();
    rememberLaunch(storage, key, team(), 100);
    rememberLaunch(storage, key, team({ thinking: "high" }), 200);
    const reordered = { budget: "any", fallback: true, planYolo: false, prewalk: false, priority: false, spark: true,
      advisor: "glance", thinking: "medium", capability: 3, lane: { kind: "mixed" } } as Selection;
    const teams = rememberLaunch(storage, key, reordered, 300);
    expect(teams.map(entry => [entry.selection.thinking, entry.launchedAt])).toEqual([["medium", 300], ["high", 200]]);
    expect(readRecentTeams(storage, key)).toEqual(teams);
  });

  test("capped at the limit, dropping the oldest", () => {
    const storage = memory();
    const thinking = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
    let launches = 0;
    for (const level of thinking) for (const advisor of ["off", "glance"] as const) rememberLaunch(storage, key, team({ thinking: level, advisor }), ++launches);
    const teams = readRecentTeams(storage, key);
    expect(teams).toHaveLength(RECENT_TEAMS_LIMIT);
    expect(teams[0]!.launchedAt).toBe(launches);
    expect(teams.at(-1)!.launchedAt).toBe(launches - RECENT_TEAMS_LIMIT + 1);
  });

  test("each principal and workspace keeps its own list", () => {
    const storage = memory();
    rememberLaunch(storage, key, team(), 100);
    expect(readRecentTeams(storage, recentTeamsKey("principal-2", "workspace-1"))).toEqual([]);
    expect(readRecentTeams(storage, recentTeamsKey("principal-1", "workspace-2"))).toEqual([]);
  });

  test("corrupt, foreign or unreadable storage reads as no teams, and only valid entries survive a mixed list", () => {
    for (const text of ["{not json", "42", "null", JSON.stringify({ selection: team(), launchedAt: 1 })]) {
      expect(readRecentTeams(memory({ [key]: text }), key)).toEqual([]);
    }
    const mixed = memory({ [key]: JSON.stringify([{ selection: { ...team(), capability: 9 }, launchedAt: 5 }, { selection: team(), launchedAt: -1 },
      "team", { selection: team({ thinking: "low" }), launchedAt: 4 }]) });
    expect(readRecentTeams(mixed, key).map(entry => entry.selection.thinking)).toEqual(["low"]);
    // A launch over a corrupt list replaces it instead of failing.
    const corrupt = memory({ [key]: "{not json" });
    expect(rememberLaunch(corrupt, key, team(), 7)).toHaveLength(1);
    expect(readRecentTeams(corrupt, key)).toHaveLength(1);
    const refusing: TeamStorage = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(readRecentTeams(refusing, key)).toEqual([]);
    expect(rememberLaunch(refusing, key, team(), 8).map(entry => entry.launchedAt)).toEqual([8]);
    expect(readRecentTeams(null, key)).toEqual([]);
  });
});
