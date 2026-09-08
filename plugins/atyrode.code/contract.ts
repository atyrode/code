import { TerminalRuntimeSchema } from "@manifold/protocol";
import { z } from "zod";

export const CODE_PLUGIN_ID = "atyrode.code";
export const GENERATOR_PLUGIN_ID = "atyrode.code.generator";
export const USAGE_PLUGIN_ID = "atyrode.code.usage";
export const ACCOUNTS_PLUGIN_ID = "atyrode.code.accounts";
export const LAUNCHER_PANEL = "launcher";
export const PREPARE_LAUNCH_DOOR = `${CODE_PLUGIN_ID}.prepareLaunch`;
export const CODE_PREFERENCES_EVENT = "preferences_changed";
export const CODE_PREFERENCES_TOPIC = { kind: "plugin", pluginId: CODE_PLUGIN_ID } as const;
export const CodeSelectionSchema = z.strictObject({
  lane: z.string(), model: z.string(), thinking: z.string(), advisor: z.string(),
  spark: z.string(), fast: z.string(), prewalk: z.string(), planyolo: z.string(), fallback: z.string(),
});
export type CodeSelection = z.infer<typeof CodeSelectionSchema>;
export const CodeRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const PrepareLaunchInputSchema = z.strictObject({
  machineId: z.string().min(1).max(128),
  planJobId: z.string().min(1).max(128),
  expectedRevision: CodeRevisionSchema,
  prompt: z.string().max(16384),
});
export type PrepareLaunchInput = z.infer<typeof PrepareLaunchInputSchema>;
export const PrepareLaunchResultSchema = z.strictObject({ runtime: TerminalRuntimeSchema });
export type PrepareLaunchResult = z.infer<typeof PrepareLaunchResultSchema>;
