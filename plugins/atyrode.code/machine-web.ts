import { useEffect, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { FALLBACK_POLL_MS, MACHINES_RESOURCE, usePolledResource } from "@manifold/plugin/hooks";
import { ListJobRunsResultSchema, PublicJobSchema, type MachineSummary } from "@manifold/protocol";
import { actionSchemas, CODE_JOB_TOPIC, CODE_PLUGIN_ID,
  type ActionInput, type ActionResult, type CodeAction, type Target } from "./contract.ts";

const messages: Readonly<Record<string, string>> = {
  code_stale_preferences: "Shared choices changed. Read the current revision before committing your edit.",
  code_preview_changed: "The catalog, accounts or native resources changed. Review again before launching.",
  code_resources_changed: "Promoted native resources changed. Review and promote their exact revisions again.",
  code_resources_incomplete: "The selected machine does not have the required native resources and consent.",
  code_configuration_missing: "Initialize Code for this container and machine first.",
  code_catalog_missing: "Stage, review and promote a catalog first.",
  code_account_unavailable: "The selected accounts are unavailable or no longer resolve exactly. Review the account choices.",
  code_scope_refused: "Your current authority does not cover this container.",
  code_result_unavailable: "This native result is incomplete, no longer retained, or not readable with your current authority.",
  code_service_configuration_changed: "Native service configuration changed. Read and review its current revision again.",
  code_service_owner_required: "Native service setup requires the root owner's current machine configuration authority.",
  code_credential_reference_unavailable: "The selected native credential reference is unavailable for that exact origin.",
  code_api_key_enrollment_unavailable: "Configure a native credential reference and admit this provider's enrollment operation first.",
  code_invalid_service_result: "The native service returned an invalid or undisclosed result.",
};
class CodeActionError extends Error {}
export function codeOperationFailure(reason: unknown): string {
  return reason instanceof CodeActionError ? reason.message : "The Code action could not be completed.";
}
export async function callCodeAction<K extends CodeAction>(host: HostServices, name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
  const parsed = actionSchemas[name].input.safeParse(input);
  if (!parsed.success) throw new CodeActionError("The action input does not match the typed Code contract.");
  const outcome = await host.client.action(`${CODE_PLUGIN_ID}.${name}`, parsed.data);
  if (!outcome.ok) throw new CodeActionError(messages[outcome.denial.message] ??
    "This action is unavailable under the current native authority or resource configuration.");
  const result = actionSchemas[name].result.safeParse(outcome.result);
  if (!result.success) throw new CodeActionError("The Code action returned an invalid result.");
  return result.data as ActionResult<K>;
}
export function useCodeMachines(host: HostServices) {
  const [error, setError] = useState<string | null>(null);
  const { value: machines, refresh } = usePolledResource<readonly MachineSummary[] | null>(
    () => host.client.machines(), FALLBACK_POLL_MS, {
      key: MACHINES_RESOURCE, restartKey: host.principal.id, initial: null,
      topics: host.topics.machines, events: host.client,
      onError: () => setError("The permitted machine list could not be read."),
    });
  useEffect(() => { setError(null); }, [machines]);
  return { machines, error, refresh };
}

/** Resume the latest configured machine once; never replace a disconnected selection during an edit. */
export function useCodeTarget(host: HostServices) {
  const { machines, error, refresh } = useCodeMachines(host);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const selectedOnce = useRef(false);
  useEffect(() => {
    if (selectedOnce.current || machines === null || host.containerId === null) return;
    let cancelled = false;
    const containerId = host.containerId;
    void Promise.allSettled(machines.map(async machine => ({
      machine, record: (await callCodeAction(host, "readConfiguration", { containerId, machineId: machine.id })).configuration,
    }))).then(rows => {
      if (cancelled || selectedOnce.current) return;
      let initial: MachineSummary | undefined;
      let latest = -1;
      for (const row of rows) if (row.status === "fulfilled" && row.value.record && row.value.record.updatedAt > latest) {
        initial = row.value.machine; latest = row.value.record.updatedAt;
      }
      initial ??= machines.find(machine => machine.online && machine.revoked !== true);
      if (initial) { selectedOnce.current = true; setMachineId(initial.id); }
      setLookupError(!initial && rows.some(row => row.status === "rejected") ? "The saved machine choice could not be read. Choose a machine to continue." : null);
    });
    return () => { cancelled = true; };
  }, [machines, host.client, host.containerId, host.principal.id]);
  function select(value: string | null) { selectedOnce.current = true; setLookupError(null); setMachineId(value); }
  const machine = machines?.find(candidate => candidate.id === machineId) ?? null;
  const target: Target | null = host.containerId && machineId ? { containerId: host.containerId, machineId } : null;
  return {
    machines, machine, machineId, target, error: error ?? lookupError, refresh, select,
    available: error === null && machine !== null && machine.online && machine.revoked !== true,
  };
}

/** Job progress is a projection of native lifecycle, not a second Code job registry. */
export function useCodeJob(host: HostServices, node: { kind: "job"; machineId: string; operationId: string; jobId: string } | null) {
  const feed = usePolledResource<{
    job: ReturnType<typeof PublicJobSchema.parse> | null;
    error: string | null;
  } | null>(async () => {
    if (node === null) return null;
    try {
      const result = await host.client.action("engine.jobs.status", { node });
      if (!result.ok) return { job: null, error: "Job status is unavailable. Open native history for details." };
      return { job: PublicJobSchema.parse(result.result), error: null };
    } catch {
      return { job: null, error: "Job status could not be read. The job has not been restarted." };
    }
  }, FALLBACK_POLL_MS, {
    key: `${CODE_PLUGIN_ID}.job:${JSON.stringify(node)}`, restartKey: host.principal.id,
    initial: null, enabled: node !== null, topics: [CODE_JOB_TOPIC, ...host.topics.machines], events: host.client,
  });
  return { job: feed.value?.job ?? null, error: feed.value?.error ?? null, refresh: feed.refresh };
}

/** Setup reads retained native receipts so reloading never repeats workspace creation. */
export function useCodeRuns(host: HostServices, target: Target, operation: string) {
  const operationId = `${CODE_PLUGIN_ID}.${operation}`;
  const feed = usePolledResource<{
    runs: ReturnType<typeof ListJobRunsResultSchema.parse>["runs"];
    error: string | null;
  } | null>(async () => {
    try {
      const result = await host.client.action("engine.jobs.listRuns", { machineId: target.machineId, pluginId: CODE_PLUGIN_ID, operationId, limit: 100 });
      if (!result.ok) throw new Error("History unavailable");
      const value = ListJobRunsResultSchema.parse(result.result);
      if (value.runs.some(run => {
        const identity = run.job ?? run.occurrence;
        return identity && (identity.machineId !== target.machineId || identity.pluginId !== CODE_PLUGIN_ID || identity.operationId !== operationId);
      })) throw new Error("Unexpected history scope");
      return { runs: value.runs, error: null };
    } catch {
      return { runs: [], error: "Preparation history could not be read. No work has been restarted." };
    }
  }, FALLBACK_POLL_MS, {
    key: `${CODE_PLUGIN_ID}.runs:${target.machineId}:${operationId}`, restartKey: host.principal.id,
    initial: null, topics: [CODE_JOB_TOPIC, ...host.topics.machines], events: host.client,
  });
  return { runs: feed.value?.runs ?? null, error: feed.value?.error ?? null, refresh: feed.refresh };
}
export type CodeQuery = "readConfiguration" | "readSetup" | "readServiceConfiguration" | "accounts" | "usage" | "inventory" | "benchmark";
/** Native shared feeds invalidate observations; polling never starts work or changes state. */
export function useCodeQuery<K extends CodeQuery>(host: HostServices, name: K, input: ActionInput<K> | null) {
  const feed = usePolledResource<{ data: ActionResult<K> | null; error: string | null } | null>(async () => {
    if (input === null) return null;
    try { return { data: await callCodeAction(host, name, input), error: null }; }
    catch (reason) { return { data: null, error: codeOperationFailure(reason) }; }
  }, FALLBACK_POLL_MS, {
    key: `${CODE_PLUGIN_ID}.${name}:${JSON.stringify(input)}`, restartKey: host.principal.id,
    initial: null, enabled: input !== null,
    topics: input === null ? [] : [{ kind: "container", containerId: input.containerId }, CODE_JOB_TOPIC, ...host.topics.machines], events: host.client,
  });
  return { data: feed.value?.data ?? null, error: feed.value?.error ?? null, refresh: feed.refresh };
}
