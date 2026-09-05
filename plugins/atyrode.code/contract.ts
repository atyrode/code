import { TerminalProgramSchema } from "@manifold/protocol";
import { z } from "zod";

/*
  THE VOCABULARY OF THE atyrode.code PLUGIN FAMILY, spelled once. Every id, door name, storage
  key, event kind and panel id the halves use is a constant here; a manifest is JSON and repeats
  its own id as data, and `test/contract.test.ts` pins each manifest to these constants so the
  two can never disagree. The kit inlines this module into every bundle that imports it, so the
  generator carries its own copy of the baseline's names rather than a reference to the baseline.
 */

// ---------------------------------------------------------------------------- plugin ids

/** The baseline: the launch door and the launch ledger. */
export const CODE_PLUGIN_ID = "atyrode.code";
/** The first sub-plugin: the launch panel, a view over the baseline's doors. */
export const GENERATOR_PLUGIN_ID = "atyrode.code.generator";

// ---------------------------------------------------------------------------- doors

/** LOCAL action names, as `defineServerAction` takes them; the roster prefixes the plugin id. */
export const LAUNCH_ACTION = "launch";
export const LIST_LAUNCHES_ACTION = "listLaunches";
/** FULL door names, as `host.action` and a button's `action` spell them. */
export const LAUNCH_DOOR = `${CODE_PLUGIN_ID}.${LAUNCH_ACTION}`;
export const LIST_LAUNCHES_DOOR = `${CODE_PLUGIN_ID}.${LIST_LAUNCHES_ACTION}`;

/** The one program the launch door authorizes: `argv[0]` of every launch. */
export const CODE_ARGV0 = "code";

export const LaunchInputSchema = z.strictObject({
  machineId: z.string().min(1),
  /** The terminal wire's own argv shape, so a launch is measured as the PTY will measure it. */
  argv: TerminalProgramSchema.shape.argv,
  label: z.string().min(1).max(120).optional(),
});
export type LaunchInput = z.infer<typeof LaunchInputSchema>;

/** One row of the ledger, exactly as storage holds it and `listLaunches` answers it. */
export const LaunchRecordSchema = z.strictObject({
  launchId: z.string().min(1),
  machineId: z.string().min(1),
  argv: LaunchInputSchema.shape.argv,
  label: z.string().min(1).max(120).optional(),
  recordedAt: z.number().int().nonnegative(),
  /** The principal id the dispatch carried, as `TerminalInfo.createdBy` attributes a PTY. */
  by: z.string().min(1),
});
export type LaunchRecord = z.infer<typeof LaunchRecordSchema>;

export const LaunchResultSchema = z.strictObject({
  launchId: z.string().min(1),
  argv: LaunchInputSchema.shape.argv,
  recordedAt: z.number().int().nonnegative(),
});
export type LaunchResult = z.infer<typeof LaunchResultSchema>;

export const ListLaunchesResultSchema = z.strictObject({
  /** Newest first. */
  launches: z.array(LaunchRecordSchema),
});
export type ListLaunchesResult = z.infer<typeof ListLaunchesResultSchema>;

// ---------------------------------------------------------------------------- storage

/** Every ledger row lives under this prefix; the ledger is `storage.keys(LAUNCHES_KEY_PREFIX)`. */
export const LAUNCHES_KEY_PREFIX = "launches/";
/** Rows kept; the oldest beyond this are pruned as a new one is written. */
export const LAUNCH_LEDGER_LIMIT = 50;

/** `launches/<recordedAt>-<launchId>`: the clock first, so key order is ledger order. */
export function launchKey(recordedAt: number, launchId: string): string {
  return `${LAUNCHES_KEY_PREFIX}${String(recordedAt)}-${launchId}`;
}

/** The `recordedAt` a key carries, so pruning orders by the clock and never by string luck. */
export function launchKeyRecordedAt(key: string): number {
  const stamp = key.slice(LAUNCHES_KEY_PREFIX.length, key.indexOf("-", LAUNCHES_KEY_PREFIX.length));
  return Number(stamp);
}

// ---------------------------------------------------------------------------- events

/** Emitted on the baseline's own plugin node once a launch row is written. */
export const LAUNCH_RECORDED_EVENT = "launch_recorded";

// ---------------------------------------------------------------------------- panels

/** The generator's one panel, the id its manifest declares under `contributes.panels`. */
export const LAUNCHER_PANEL = "launcher";
