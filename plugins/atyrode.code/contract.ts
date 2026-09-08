import { TerminalProgramSchema } from "@manifold/protocol";
import { z } from "zod";

export const CODE_PLUGIN_ID = "atyrode.code";
export const GENERATOR_PLUGIN_ID = "atyrode.code.generator";
export const USAGE_PLUGIN_ID = "atyrode.code.usage";
export const ACCOUNTS_PLUGIN_ID = "atyrode.code.accounts";
export const CODE_ARGV0 = "code";
export const LAUNCHER_PANEL = "launcher";
export const PREPARE_LAUNCH_DOOR = `${CODE_PLUGIN_ID}.prepareLaunch`;
export const CODE_PREFERENCES_EVENT = "preferences_changed";
export const CODE_PREFERENCES_TOPIC = { kind: "plugin", pluginId: CODE_PLUGIN_ID } as const;
export const CodeSelectionSchema = z.record(z.string(), z.string());

/** Terminal creation, placement, lifecycle and history belong to Manifold, not a Code ledger. */
export const PrepareLaunchInputSchema = z.strictObject({
  machineId: z.string().min(1).max(128),
  inspectionJobId: z.string().min(1).max(128),
  kind: z.enum(["generated", "managed", "untrusted", "runtime"]),
  selection: CodeSelectionSchema,
  runtime: z.string().min(1).max(128).optional(),
  worktree: z.boolean(),
  prompt: z.string().max(16384),
  accounts: z.discriminatedUnion("source", [
    z.strictObject({ source: z.literal("machine") }),
    z.strictObject({
      source: z.literal("plugin"),
      revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      baselineJobId: z.string().min(1).max(128),
    }),
  ]),
});
export type PrepareLaunchInput = z.infer<typeof PrepareLaunchInputSchema>;
export const PrepareLaunchResultSchema = z.strictObject({ program: TerminalProgramSchema });
export type PrepareLaunchResult = z.infer<typeof PrepareLaunchResultSchema>;
