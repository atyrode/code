import { useCallback, useEffect, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { FALLBACK_POLL_MS, MACHINES_RESOURCE, usePolledResource } from "@manifold/plugin/hooks";
import { hasCap, ListJobRunsResultSchema, PublicJobSchema, type MachineSummary } from "@manifold/protocol";
import { actionDoor, CODE_JOB_TOPIC, CODE_PLUGIN_ID,
  type ActionInput, type ActionResult, type CodeAction, type Target } from "./contract.ts";
import { actionDoor as ompDoor, type OmpAction, type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { createCodeWorkflowClient, WorkflowError } from "./workflow.ts";

const messages: Readonly<Record<string, string>> = {
  code_stale_preferences: "Shared choices changed. Read the current revision before committing your edit.",
  code_composition_changed: "The saved profile, account pool or OMP defaults changed. Review the session again before launching.",
  code_configuration_missing: "Initialize Code for this container first.",
  code_catalog_missing: "Stage, review and promote a catalog first.",
  code_account_unavailable: "The selected accounts are unavailable or no longer resolve exactly. Review the account choices.",
  code_scope_refused: "Your current authority does not cover this container.",
  code_service_configuration_changed: "Native service configuration changed. Read and review its current revision again.",
  code_service_owner_required: "Native service setup requires the root owner's current machine configuration authority.",
  code_invalid_service_result: "The native service returned an invalid or undisclosed result.",
};
/** An authoring handle exposes operations; the native cap set grants write access. */
export function canWriteCodeWorkspace(host: HostServices): boolean {
  return host.authoring !== null && hasCap(host.client.selfCaps(), "containers:write");
}
export function codeOperationFailure(reason: unknown): string {
  return reason instanceof WorkflowError ? messages[reason.message] ?? reason.message : "The Code action could not be completed.";
}
export function codeWorkflow(host: HostServices) {
  return createCodeWorkflowClient(async (door, input) => {
    const outcome = await host.client.action(door, input);
    if (!outcome.ok) throw new WorkflowError(`${door}: ${outcome.denial.message}. No approval or readiness is assumed.`);
    return outcome.result;
  });
}
export async function callCodeAction<K extends CodeAction>(host: HostServices, name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
  return codeWorkflow(host).code(name, input);
}
export async function callOmpAction<K extends OmpAction>(host: HostServices, name: K, input: OmpInput<K>): Promise<OmpResult<K>> {
  return codeWorkflow(host).omp(name, input);
}
export function useCodeMachines(host: HostServices) {
  const [error, setError] = useState<string | null>(null);
  const { value: machines, refresh } = usePolledResource<readonly MachineSummary[] | null>(
    () => host.client.machines(), FALLBACK_POLL_MS, {
      key: MACHINES_RESOURCE, restartKey: host.principal.id, initial: null,
      topics: host.topics.machines, events: host.client,
      onError: () => setError("The permitted machine list could not be read."),
      onSuccess: () => setError(null),
    });
  return { machines, error, refresh };
}

/** Destinations are a browser-local choice, never inferred from saved workspace data. */
export function useCodeTarget(host: HostServices) {
  const { machines, error, refresh } = useCodeMachines(host);
  const scope = JSON.stringify([host.principal.id, host.containerId]);
  const storageKey = `${CODE_PLUGIN_ID}.destination:${scope}`;
  const [choice, setChoice] = useState<{ scope: string; machineId: string | null } | null>(null);
  const machineId = choice?.scope === scope ? choice.machineId : null;
  useEffect(() => {
    if (choice?.scope === scope || machines === null || host.containerId === null) return;
    let saved: string | null = null;
    try { saved = sessionStorage.getItem(storageKey); } catch { /* Browser storage is optional. */ }
    const initial = saved || machines.find(machine => machine.online && machine.revoked !== true)?.id || machines[0]?.id;
    if (initial) setChoice({ scope, machineId: initial });
  }, [choice, scope, storageKey, machines, host.containerId]);
  function select(value: string | null) {
    setChoice({ scope, machineId: value });
    try {
      if (value) sessionStorage.setItem(storageKey, value);
      else sessionStorage.removeItem(storageKey);
    } catch { /* Keep the in-memory destination when storage is unavailable. */ }
  }
  const machine = machines?.find(candidate => candidate.id === machineId) ?? null;
  const target: Target | null = host.containerId && machineId ? { containerId: host.containerId, machineId } : null;
  return {
    machines, machine, machineId, target, error, refresh, select,
    available: error === null && machine !== null && machine.online && machine.revoked !== true,
  };
}

/** Job progress is a projection of native lifecycle, not a second Code job registry. */
export function useOmpJob(host: HostServices, node: { kind: "job"; machineId: string; operationId: string; jobId: string } | null) {
  const feed = usePolledResource<{
    job: ReturnType<typeof PublicJobSchema.parse> | null;
    error: string | null;
  } | null>(async () => {
    if (node === null) return null;
    try {
      return { job: await codeWorkflow(host).readJob(node), error: null };
    } catch (reason) {
      return { job: null, error: `${codeOperationFailure(reason)} The job has not been restarted.` };
    }
  }, FALLBACK_POLL_MS, {
    key: `${CODE_PLUGIN_ID}.job:${JSON.stringify(node)}`, restartKey: host.principal.id,
    initial: null, enabled: node !== null, topics: [CODE_JOB_TOPIC, ...host.topics.machines], events: host.client,
  });
  return { job: feed.value?.job ?? null, error: feed.value?.error ?? null, refresh: feed.refresh };
}

/** Native history is explicitly filtered to the actual OMP job owner. */
export function useOmpRuns(host: HostServices, target: Target | null, operationId: string) {
  const feed = usePolledResource<{
    runs: ReturnType<typeof ListJobRunsResultSchema.parse>["runs"];
    error: string | null;
  } | null>(async () => {
    if (!target) return null;
    try {
      const value = await codeWorkflow(host).listRuns(target, operationId);
      return { runs: value.runs, error: null };
    } catch (reason) {
      return { runs: [], error: `${codeOperationFailure(reason)} No work has been restarted.` };
    }
  }, FALLBACK_POLL_MS, {
    key: `${CODE_PLUGIN_ID}.runs:${target?.machineId ?? ""}:${operationId}`, restartKey: host.principal.id,
    initial: null, enabled: target !== null, topics: [CODE_JOB_TOPIC, ...host.topics.machines], events: host.client,
  });
  return { runs: feed.value?.runs ?? null, error: feed.value?.error ?? null, refresh: feed.refresh };
}
export const ACCOUNT_REFRESH_MS = 1_000;
export type CodeQuery = "readConfiguration" | "readServiceConfiguration";
export function useCodeQuery<K extends CodeQuery>(host: HostServices, name: K, input: ActionInput<K> | null, intervalMs = FALLBACK_POLL_MS) {
  return useWorkflowQuery(host, `${actionDoor(name)}:${JSON.stringify(input)}`, input !== null,
    () => callCodeAction(host, name, input!), intervalMs);
}
export function useOmpQuery<K extends OmpAction>(host: HostServices, name: K, input: OmpInput<K> | null, intervalMs = FALLBACK_POLL_MS) {
  return useWorkflowQuery(host, `${ompDoor(name)}:${JSON.stringify(input)}`, input !== null,
    () => callOmpAction(host, name, input!), intervalMs);
}
/** Poll even with a live event channel: native broker/provider observations can
 * change independently of Manifold events. Keys isolate target-bound observations. */
export function useWorkflowQuery<T>(host: HostServices, key: string, enabled: boolean, observe: () => Promise<T>, intervalMs = FALLBACK_POLL_MS) {
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => { setRefreshing(false); }, [key, host.principal.id]);
  const feed = usePolledResource<{ data: T | null; error: string | null } | null>(async () => {
    if (!enabled) return null;
    try { return { data: await observe(), error: null }; }
    catch (reason) { return { data: null, error: codeOperationFailure(reason) }; }
  }, intervalMs, {
    key, restartKey: host.principal.id,
    initial: null, enabled,
    onSuccess: () => setRefreshing(false),
    onError: () => setRefreshing(false),
    topics: [], events: host.client,
  });
  const refresh = useCallback(() => {
    if (!enabled) return;
    setRefreshing(true);
    feed.refresh();
  }, [enabled, feed.refresh]);
  return { data: feed.value?.data ?? null, error: feed.value?.error ?? null, refreshing, refresh };
}
