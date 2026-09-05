import {
  defineServerAction,
  defineServerPlugin,
  type GuestCtx,
  type GuestStorage,
  type ServerPluginDef,
} from "@manifold/plugin-kit/server";
import { PluginManifestSchema } from "@manifold/protocol";
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
import manifestJson from "./manifest.json";

/*
  THE BASELINE, server half. Two doors over one ledger:

  - `atyrode.code.launch` is the arbitration point for a launch of `code`: it refuses any other
    program, refuses an offline machine, writes one ledger row and emits `launch_recorded`. It
    does NOT birth the terminal — stage 1 serves no terminal verb to a server half — so the
    caller (tonight, the generator's panel) opens the PTY afterwards with its own authority and
    the argv this door echoed back. The door carries `terminals:spawn` so a caller who could not
    open a terminal is refused here, before a row is written.
  - `atyrode.code.listLaunches` reads the ledger back, newest first.

  Both are async end to end: every storage verb and every question to the host crosses the
  process boundary as a `call` frame.
 */

const launch = defineServerAction({
  name: LAUNCH_ACTION,
  title: "Authorize and record a launch of code on a machine",
  caps: ["terminals:spawn"],
  input: LaunchInputSchema,
  result: LaunchResultSchema,
});

const listLaunches = defineServerAction({
  name: LIST_LAUNCHES_ACTION,
  title: "List the launches this plugin recorded",
  caps: [],
  input: z.strictObject({}),
  result: ListLaunchesResultSchema,
});

/** Every ledger key the plugin holds, oldest first by the clock the key carries. */
async function ledgerKeys(storage: GuestStorage): Promise<string[]> {
  const keys = [...(await storage.keys(LAUNCHES_KEY_PREFIX))];
  keys.sort((a, b) => launchKeyRecordedAt(a) - launchKeyRecordedAt(b) || a.localeCompare(b));
  return keys;
}

export const handlers = {
  async [LAUNCH_ACTION](
    ctx: GuestCtx,
    args: LaunchInput,
  ): Promise<LaunchResult | { refused: string }> {
    if (args.argv[0] !== CODE_ARGV0) return { refused: "only the code launcher may be launched" };
    if (!(await ctx.machines.isOnline(args.machineId))) {
      return { refused: `machine ${args.machineId} is offline` };
    }
    const launchId = await ctx.newId();
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

  async [LIST_LAUNCHES_ACTION](ctx: GuestCtx): Promise<ListLaunchesResult> {
    const keys = await ledgerKeys(ctx.storage);
    const launches: LaunchRecord[] = [];
    for (const key of keys.reverse()) {
      const raw = await ctx.storage.get(key);
      if (raw !== null) launches.push(LaunchRecordSchema.parse(JSON.parse(raw)));
    }
    return { launches };
  },
};

/** The whole definition, exported so a test can drive it through the kit's own transport. */
export const plugin: ServerPluginDef = {
  manifest: PluginManifestSchema.parse(manifestJson),
  actions: [launch, listLaunches],
  handlers,
};

defineServerPlugin(plugin);
