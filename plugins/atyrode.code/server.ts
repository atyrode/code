import { defineAction } from "@manifold/plugin";
import { CODE_PLUGIN_ID, PrepareLaunchInputSchema, PrepareLaunchResultSchema, type PrepareLaunchInput, type PrepareLaunchResult } from "./contract.ts";
import {
  catalogPayload, machineActions, machineHandlers, matchesCatalog, readCodeConfiguration,
  readCodeSnapshot, requireConfigurationResources, requireCurrentJob, requirePayload, type CodeContext,
} from "./machine-server.ts";

const prepareLaunch = defineAction({
  name: "prepareLaunch", title: "Prepare a reviewed native Code runtime", caps: ["terminals:spawn"], trace: "opaque",
  input: PrepareLaunchInputSchema, result: PrepareLaunchResultSchema,
});
export const handlers = {
  ...machineHandlers,
  async prepareLaunch(ctx: CodeContext, args: PrepareLaunchInput): Promise<PrepareLaunchResult | { refused: string }> {
    try {
      const configuration = await readCodeConfiguration(ctx, args.machineId);
      const record = configuration.record;
      if (record === null) return { refused: "code_configuration_missing" };
      if (record.revision !== args.expectedRevision) return { refused: "code_stale_preferences" };
      const plan = await readCodeSnapshot(ctx, args.machineId, "analysis-plan", args.planJobId);
      if (!matchesCatalog(record, plan.value)) return { refused: "code_stale_preferences" };
      requirePayload(plan.job, catalogPayload(record));
      if (!plan.value.ready || plan.value.refusals.length !== 0) return { refused: "code_resources_incomplete" };
      await requireCurrentJob(ctx, plan.job);
      const pins = await requireConfigurationResources(ctx, record, `${CODE_PLUGIN_ID}.launch`);
      // Re-read after asynchronous authority/resource checks; terminal admission independently
      // verifies the pinned native installation and resources at the actual start boundary.
      const current = await readCodeConfiguration(ctx, args.machineId);
      if (current.raw !== configuration.raw) return { refused: "code_stale_preferences" };
      const input = { configYaml: plan.value.configYaml, accountPool: JSON.stringify(plan.value.accountPool),
        flags: JSON.stringify(plan.value.flags), prompt: args.prompt };
      if (Buffer.byteLength(JSON.stringify(input)) > 64 << 10) return { refused: "code_input_too_large" };
      const result = PrepareLaunchResultSchema.safeParse({ runtime: {
        pluginId: CODE_PLUGIN_ID, operationId: `${CODE_PLUGIN_ID}.launch`, ...pins,
        input,
      } });
      return result.success ? result.data : { refused: "code_input_too_large" };
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "";
      return { refused: message.startsWith("code_") ? message : "code_observation_unavailable" };
    }
  },
};
export default { actions: [prepareLaunch, ...machineActions], handlers };
