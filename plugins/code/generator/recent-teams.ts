import { z } from "zod";
import { epochMilliseconds } from "@atyrode/manifold-omp";
import { SelectionSchema, type Selection } from "../../domain/contracts.ts";
import { CODE_PLUGIN_ID } from "../contract.ts";

/*
 * The teams this browser launched, per principal and workspace. Device-local by design: Code keeps
 * one workspace record and no launch log, so nothing here is shared, synced or authoritative. It
 * only lets the panel offer what was just run; a launch still saves and reviews as always.
 */

/** As many as the digits 1 to 9 can recall. */
export const RECENT_TEAMS_LIMIT = 9;
const RecentTeamSchema = z.strictObject({ selection: SelectionSchema, launchedAt: epochMilliseconds });
export type RecentTeam = z.infer<typeof RecentTeamSchema>;
/** The part of `Storage` the list uses; `localStorage` in the panel. */
export type TeamStorage = Pick<Storage, "getItem" | "setItem">;

export function recentTeamsKey(principalId: string, containerId: string): string {
  return `${CODE_PLUGIN_ID}.recent-teams:${JSON.stringify([principalId, containerId])}`;
}

/** The browser's local storage, or null where it is absent or refused (private modes and sandboxed frames throw on access). */
export function browserTeamStorage(): TeamStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** Newest first, one entry per team (its latest launch), at most the limit. Parsed selections serialize in schema order, so equal teams compare equal. */
function normalized(entries: readonly RecentTeam[]): RecentTeam[] {
  const seen = new Set<string>();
  const teams: RecentTeam[] = [];
  for (const entry of [...entries].sort((left, right) => right.launchedAt - left.launchedAt)) {
    const team = JSON.stringify(entry.selection);
    if (seen.has(team)) continue;
    seen.add(team);
    teams.push(entry);
    if (teams.length === RECENT_TEAMS_LIMIT) break;
  }
  return teams;
}

/**
 * The stored list. Unreadable storage, text that is not JSON or not a list, and entries that are
 * not a valid team read as absent, rather than failing the panel or reviving a malformed team.
 */
export function readRecentTeams(storage: TeamStorage | null, key: string): RecentTeam[] {
  let text: string | null = null;
  try { text = storage?.getItem(key) ?? null; } catch { return []; }
  if (!text) return [];
  let stored: unknown;
  try { stored = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(stored)) return [];
  return normalized(stored.flatMap(entry => {
    const parsed = RecentTeamSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  }));
}

/** Record a launched team and return the list as it now stands, even when storage refuses the write. */
export function rememberLaunch(storage: TeamStorage | null, key: string, selection: Selection, launchedAt: number): RecentTeam[] {
  const team = RecentTeamSchema.parse({ selection, launchedAt });
  const teams = normalized([team, ...readRecentTeams(storage, key)]);
  try { storage?.setItem(key, JSON.stringify(teams)); } catch { /* A full or refused store keeps this session's list only. */ }
  return teams;
}
