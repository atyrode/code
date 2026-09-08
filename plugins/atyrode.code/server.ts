import { defineAction } from "@manifold/plugin";
import {
  CODE_ARGV0, PrepareLaunchInputSchema, PrepareLaunchResultSchema,
  type PrepareLaunchInput, type PrepareLaunchResult,
} from "./contract.ts";
import {
  machineActions, machineHandlers, readCodePreferences,
  readCodeSnapshot, type CodeContext,
} from "./machine-server.ts";

const prepareLaunch = defineAction({
  name: "prepareLaunch", title: "Prepare a reviewed Code launch", caps: ["terminals:spawn"], trace: "opaque",
  input: PrepareLaunchInputSchema, result: PrepareLaunchResultSchema,
});

export const handlers = {
  ...machineHandlers,
  async prepareLaunch(ctx: CodeContext, args: PrepareLaunchInput): Promise<PrepareLaunchResult | { refused: string }> {
    try {
      const inspection = (await readCodeSnapshot(ctx, args.machineId, "inspect", args.inspectionJobId)).value;
      if (!inspection.launch_modes.some((mode) => mode.mode === args.kind && mode.available))
        return { refused: "code_launch_mode_unavailable" };
      if (Object.keys(args.selection).length !== Object.keys(inspection.selection).length ||
        Object.entries(args.selection).some(([key, value]) => inspection.selection[key] !== value))
        return { refused: "code_preview_changed" };
      if (args.kind === "generated" && inspection.catalog.state !== "ready")
        return { refused: "code_catalog_missing" };
      if (args.kind === "runtime" && (!args.runtime || !inspection.runtime_targets.some((target) => target.name === args.runtime)))
        return { refused: "code_launch_mode_unavailable" };
      if (args.kind !== "runtime" && args.runtime !== undefined) return { refused: "code_invalid_request" };

      const argv = [CODE_ARGV0, "launch", `--kind=${args.kind}`];
      if (args.kind === "generated") argv.push(`--selection=${JSON.stringify(args.selection)}`);
      if (args.kind === "runtime") {
        argv.push(`--runtime=${args.runtime}`);
        if (args.selection.thinking !== undefined) argv.push(`--selection=${JSON.stringify({ thinking: args.selection.thinking })}`);
      }
      if (args.accounts.source === "plugin") {
        if (args.kind !== "generated" && args.kind !== "managed") return { refused: "code_invalid_request" };
        const preferences = await readCodePreferences(ctx, args.machineId);
        if (preferences.record === null) return { refused: "code_preferences_missing" };
        if (args.accounts.revision !== preferences.record.revision || inspection.baseRevision !== args.accounts.revision)
          return { refused: "code_stale_preferences" };
        const state = preferences.record.state;
        const disabled = state.activePreset === "Manual" ? state.manualDisabled : state.presets.find((preset) => preset.name === state.activePreset)?.disabled;
        if (disabled === undefined) return { refused: "code_invalid_request" };
        argv.push(`--account-selection=${JSON.stringify({ schemaVersion: 1, disabled })}`);
      } else if (inspection.baseRevision !== null) return { refused: "code_preview_changed" };
      if (args.worktree) argv.push("--worktree");
      if (args.prompt !== "") argv.push(`--prompt=${args.prompt}`);
      const result = PrepareLaunchResultSchema.safeParse({ program: { argv } });
      return result.success ? result.data : { refused: "code_input_too_large" };
    } catch {
      return { refused: "code_observation_unavailable" };
    }
  },
};

export default {
  actions: [prepareLaunch, ...machineActions],
  handlers,
};
