import { useCallback, useEffect, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { FALLBACK_POLL_MS, MACHINES_RESOURCE, usePolledResource } from "@manifold/plugin/hooks";
import { hasCap, ListJobRunsResultSchema, PublicJobSchema, type MachineSummary } from "@manifold/protocol";
import { actionDoor, actionSchemas, CODE_JOB_TOPIC, CODE_PLUGIN_ID,
  type ActionInput, type ActionResult, type CodeAction, type Target } from "./contract.ts";

const messages: Readonly<Record<string, string>> = {
  code_stale_preferences: "Shared choices changed. Read the current revision before committing your edit.",
  code_preview_changed: "The catalog, accounts or native resources changed. Review again before launching.",
  code_resources_changed: "Promoted native resources changed. Review and promote their exact revisions again.",
  code_resources_incomplete: "The selected machine does not have the required native resources and consent.",
  code_native_consent_required: "Native permissions for the account broker and OMP sign-in are not approved. Review OMP setup before continuing.",
  code_configuration_missing: "Initialize Code for this container first.",
  code_catalog_missing: "Stage, review and promote a catalog first.",
  code_account_unavailable: "The selected accounts are unavailable or no longer resolve exactly. Review the account choices.",
  code_scope_refused: "Your current authority does not cover this container.",
  code_result_unavailable: "This native result is incomplete, no longer retained, or not readable with your current authority.",
  code_service_configuration_changed: "Native service configuration changed. Read and review its current revision again.",
  code_broker_revision_changed: "The instance broker configuration changed. Refresh and review its current revision again.",
  code_broker_unavailable: "The instance account broker is unavailable. Ask the instance owner to review its native placement and runtime.",
  code_account_owner_unavailable: "The declared account owner is unavailable. No other machine will be used.",
  code_account_admin_required: "Account administration requires native permission. Ask the instance owner to grant access.",
  code_service_owner_required: "Native service setup requires the root owner's current machine configuration authority.",
  code_invalid_service_result: "The native service returned an invalid or undisclosed result.",
};
/** An authoring handle exposes operations; the native cap set grants write access. */
export function canWriteCodeWorkspace(host: HostServices): boolean {
  return host.authoring !== null && hasCap(host.client.selfCaps(), "containers:write");
}
class CodeActionError extends Error {}
export function codeOperationFailure(reason: unknown): string {
  return reason instanceof CodeActionError ? reason.message : "The Code action could not be completed.";
}
export async function callCodeAction<K extends CodeAction>(host: HostServices, name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
  const parsed = actionSchemas[name].input.safeParse(input);
  if (!parsed.success) throw new CodeActionError("The action input does not match the typed Code contract.");
  const outcome = await host.client.action(actionDoor(name), parsed.data);
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
export function useCodeRuns(host: HostServices, target: Target | null, operation: string) {
  const operationId = `${CODE_PLUGIN_ID}.${operation}`;
  const feed = usePolledResource<{
    runs: ReturnType<typeof ListJobRunsResultSchema.parse>["runs"];
    error: string | null;
  } | null>(async () => {
    if (!target) return null;
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
      return { runs: [], error: "Workspace check history could not be read. No work has been restarted." };
    }
  }, FALLBACK_POLL_MS, {
    key: `${CODE_PLUGIN_ID}.runs:${target?.machineId ?? ""}:${operationId}`, restartKey: host.principal.id,
    initial: null, enabled: target !== null, topics: [CODE_JOB_TOPIC, ...host.topics.machines], events: host.client,
  });
  return { runs: feed.value?.runs ?? null, error: feed.value?.error ?? null, refresh: feed.refresh };
}
export const ACCOUNT_REFRESH_MS = 1_000;
export type CodeQuery = "readConfiguration" | "readSetup" | "readServiceConfiguration" | "readAccountSetup" | "accounts" | "usage" | "inventory" | "benchmark";
/** Native shared feeds invalidate state; externally changing broker observations keep their polling cadence. */
export function useCodeQuery<K extends CodeQuery>(host: HostServices, name: K, input: ActionInput<K> | null, intervalMs = FALLBACK_POLL_MS) {
  const key = `${actionDoor(name)}:${JSON.stringify(input)}`;
  const enabled = input !== null;
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => { setRefreshing(false); }, [key, host.principal.id]);
  const feed = usePolledResource<{ data: ActionResult<K> | null; error: string | null } | null>(async () => {
    if (input === null) return null;
    try { return { data: await callCodeAction(host, name, input), error: null }; }
    catch (reason) { return { data: null, error: codeOperationFailure(reason) }; }
  }, intervalMs, {
    key, restartKey: host.principal.id,
    initial: null, enabled,
    onSuccess: () => setRefreshing(false),
    onError: () => setRefreshing(false),
    // Broker accounts and provider quotas change outside Manifold's event plane.
    // A live native subscription would suppress their timer without replacing it.
    topics: input === null || name === "accounts" || name === "readAccountSetup" || name === "usage" ? [] :
      [...("containerId" in input ? [{ kind: "container" as const, containerId: input.containerId }] : []), CODE_JOB_TOPIC, ...host.topics.machines], events: host.client,
  });
  const refresh = useCallback(() => {
    if (!enabled) return;
    setRefreshing(true);
    feed.refresh();
  }, [enabled, feed.refresh]);
  return { data: feed.value?.data ?? null, error: feed.value?.error ?? null, refreshing, refresh };
}
