import type { AccountChoiceChange, AccountChoices } from "../../domain/contracts.ts";
import type { QuotaReading } from "../../domain/quota.ts";

/*
 * What the panes share of the usage reading: the reading every pool is judged on with the account
 * choices it edits, how a moment ahead is said, and where a failed model list shows.
 */

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/**
 * A moment ahead as the panel says it: the clock time when it falls today, the weekday from
 * tomorrow, as a reset past midnight is not today's, and the date from six days on,
 * where a weekday would read as this one.
 */
export function when(at: number, nowMs: number): string {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === new Date(nowMs).toDateString()) return time;
  return at - nowMs < 6 * DAY_MS ? `${WEEKDAYS[date.getDay()]} ${time}` : `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${time}`;
}

/** A failed bundled model list: not at all, `beside` the routes the generator still shows, or `instead` of any profile. */
export type ListFailure = "none" | "beside" | "instead";
/**
 * Where a failed read of the bundled model list, or of the starter derived from it, shows. It
 * matters only while no catalog is stored, since a stored one never reads the list. The generator
 * keeps whatever profile the model already holds (a frozen starter, a local draft, a staged
 * catalog), with the failure said `beside` it; only with no profile does the failure take its place.
 */
export function modelListFailure(failed: boolean, stored: boolean, team: boolean): ListFailure {
  if (!failed || stored) return "none";
  return team ? "beside" : "instead";
}

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
