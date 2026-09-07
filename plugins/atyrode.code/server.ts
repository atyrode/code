import { defineAction, type EmitEvent, type PluginStorage } from "@manifold/plugin";
import { z } from "zod";
import {
  CODE_ARGV0,
  LAUNCH_ACTION,
  LAUNCH_LEDGER_LIMIT,
  LAUNCH_RECORDED_EVENT,
  LAUNCHES_KEY_PREFIX,
  LIST_LAUNCHES_ACTION,
  LaunchInputSchema,
  LaunchRecordSchema,
  LaunchResultSchema,
  ListLaunchesResultSchema,
  launchKey,
  launchKeyRecordedAt,
  type LaunchInput,
  type LaunchRecord,
  type LaunchResult,
  type ListLaunchesResult,
} from "./contract.ts";

/*
  THE BASELINE, server half. Two doors over one ledger:

  - `atyrode.code.launch` is the arbitration point for a launch of `code`: it refuses any other
    program, refuses an offline machine, writes one ledger row and emits `launch_recorded`. It
    does NOT create a terminal or prove a process is running. The caller opens the terminal
    afterwards through host.client.openTerminal with its own authority and the authorized argv.
    The door carries `terminals:spawn` so a caller who could not open a terminal is refused here,
    before a row is written.
  - `atyrode.code.listLaunches` reads the authorization ledger back, newest first.
 */

const launch = defineAction({
  name: LAUNCH_ACTION,
  title: "Authorize and record a launch of code on a machine",
  caps: ["terminals:spawn"],
  input: LaunchInputSchema,
  result: LaunchResultSchema,
});

const listLaunches = defineAction({
  name: LIST_LAUNCHES_ACTION,
  title: "List the launches this plugin recorded",
  caps: [],
  input: z.strictObject({}),
  result: ListLaunchesResultSchema,
});

/**
 * The ActionCtx slice this baseline consumes. The pinned SDK exposes PluginStorage and
 * EmitEvent, but not the engine's full ActionCtx; no server-internal import is needed.
 */
export interface LaunchContext {
  readonly pluginId: string;
  readonly principal: { readonly id: string };
  readonly storage: Pick<PluginStorage, "get" | "set" | "delete" | "keys">;
  readonly emit: EmitEvent;
  readonly machines: { isOnline(machineId: string): boolean };
  now(): number;
  newId(): string;
}

/** Every ledger key the plugin holds, oldest first by the clock the key carries. */
async function ledgerKeys(storage: LaunchContext["storage"]): Promise<string[]> {
  const keys = [...(await storage.keys(LAUNCHES_KEY_PREFIX))];
  keys.sort((a, b) => launchKeyRecordedAt(a) - launchKeyRecordedAt(b) || a.localeCompare(b));
  return keys;
}

export const handlers = {
  async [LAUNCH_ACTION](
    ctx: LaunchContext,
    args: LaunchInput,
  ): Promise<LaunchResult | { refused: string }> {
    if (args.argv[0] !== CODE_ARGV0) return { refused: "only the code launcher may be launched" };
    if (!ctx.machines.isOnline(args.machineId)) {
      return { refused: `machine ${args.machineId} is offline` };
    }
    const launchId = ctx.newId();
    const recordedAt = ctx.now();
    const record: LaunchRecord = {
      launchId,
      machineId: args.machineId,
      argv: args.argv,
      ...(args.label === undefined ? {} : { label: args.label }),
      recordedAt,
      by: ctx.principal.id,
    };
    await ctx.storage.set(launchKey(recordedAt, launchId), JSON.stringify(record));
    const keys = await ledgerKeys(ctx.storage);
    for (const stale of keys.slice(0, Math.max(0, keys.length - LAUNCH_LEDGER_LIMIT))) {
      await ctx.storage.delete(stale);
    }
    ctx.emit({ kind: "plugin", pluginId: ctx.pluginId }, LAUNCH_RECORDED_EVENT, {
      launchId,
      machineId: args.machineId,
      recordedAt,
    });
    return { launchId, argv: args.argv, recordedAt };
  },

  async [LIST_LAUNCHES_ACTION](ctx: LaunchContext): Promise<ListLaunchesResult> {
    const keys = await ledgerKeys(ctx.storage);
    const launches: LaunchRecord[] = [];
    for (const key of keys.reverse()) {
      const raw = await ctx.storage.get(key);
      if (raw !== null) launches.push(LaunchRecordSchema.parse(JSON.parse(raw)));
    }
    return { launches };
  },
};

// The installer attaches the bundle's manifest to this in-realm definition.
export default {
  actions: [launch, listLaunches],
  handlers,
};
