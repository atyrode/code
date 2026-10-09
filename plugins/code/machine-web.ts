import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { FALLBACK_POLL_MS, MACHINES_RESOURCE, usePolledResource } from "@manifold/plugin/hooks";
import { hasCap, ListJobRunsResultSchema, PublicJobSchema, type MachineSummary, type TerminalSummary } from "@manifold/protocol";
import { actionDoor, CODE_JOB_TOPIC, CODE_PLUGIN_ID,
  type ActionInput, type ActionResult, type CodeAction, type Target } from "./contract.ts";
import { actionDoor as ompDoor, type OmpAction, type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { createCodeWorkflowClient, failureWords, refusalToken, WorkflowError, type CodeRuns } from "./workflow.ts";
import { initialDestination, ompPresence, type OmpPresence } from "./destination.ts";

const CODE_PREFERENCES_TOPIC = { kind: "plugin", pluginId: CODE_PLUGIN_ID } as const;
/**
 * Write access is the caller's native caps alone: Manifold admits Code's mutating actions, which
 * declare `containers:write`, on that cap at the container, whatever view is mounted. A mounted
 * view adds no authority; its authoring door (`host.authoring`) only places terminals.
 */
export function canWriteCodeWorkspace(host: HostServices): boolean {
  return hasCap(host.client.selfCaps(), "containers:write");
}
/** A failure in the panel's words (workflow.ts `failureWords`); one that no workflow raised says only that the action could not be completed. */
export function codeOperationFailure(reason: unknown): string {
  return reason instanceof WorkflowError ? failureWords(reason.message) : "The Code action could not be completed.";
}
export function codeWorkflow(host: HostServices, current?: () => boolean) {
  return createCodeWorkflowClient(async (door, input) => {
    if (current && !current()) throw new WorkflowError("code_destination_changed");
    if (door === "core.machines.list") return { machines: await host.client.machines() };
    if (door === "core.terminals.listAll") return { terminals: await host.client.allTerminals() };
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

/** Use the public inventory and its host lifecycle; correlation never grants authority. */
export function useCodeTerminals(host: HostServices) {
  const feed = usePolledResource<{ terminals: readonly TerminalSummary[]; error: string | null } | null>(async () => {
    try { return { terminals: await host.client.allTerminals(), error: null }; }
    catch { return { terminals: [], error: "Public terminal inventory could not be read. Session activity is unknown." }; }
  }, FALLBACK_POLL_MS, {
    key: `${CODE_PLUGIN_ID}.terminals:${host.containerId}`, restartKey: host.principal.id,
    initial: null, topics: host.topics.terminals, events: host.client,
  });
  return { terminals: feed.value?.terminals ?? null, error: feed.value?.error ?? null, refresh: feed.refresh };
}

function useOmpPresence(host: HostServices, machines: readonly MachineSummary[] | null): ReadonlyMap<string, OmpPresence> | null {
  const online = (machines ?? []).filter(machine => machine.online && machine.revoked !== true).map(machine => machine.id).sort();
  const containerId = host.containerId;
  const key = JSON.stringify([containerId, online]);
  const { value } = usePolledResource<{ key: string; presence: [string, OmpPresence][] } | null>(async () => {
    if (containerId === null || machines === null) return null;
    const workflow = codeWorkflow(host);
    const presence = await Promise.all(online.map(async (machineId): Promise<[string, OmpPresence]> => {
      try { await workflow.omp("describeDestination", { containerId, machineId }); return [machineId, "ok"]; }
      catch (failure) { return [machineId, ompPresence(failure)]; }
    }));
    return { key, presence };
  }, FALLBACK_POLL_MS, { key: `omp-presence:${key}`, restartKey: host.principal.id, initial: null, enabled: containerId !== null && machines !== null });
  // A read for another set of machines says nothing about these; one equal to the last keeps its identity, so what reads it is not recomputed.
  const answer = value?.key === key ? JSON.stringify(value.presence) : null;
  return useMemo(() => answer === null ? null : new Map(JSON.parse(answer) as [string, OmpPresence][]), [answer]);
}

export type { OmpPresence } from "./destination.ts";

/** Destinations are a browser-local choice, never inferred from saved workspace data. */
export function useCodeTarget(host: HostServices) {
  const { machines, error, refresh } = useCodeMachines(host);
  const presence = useOmpPresence(host, machines);
  const scope = JSON.stringify([host.principal.id, host.containerId]);
  const storageKey = `${CODE_PLUGIN_ID}.destination:${scope}`;
  const [choice, setChoice] = useState<{ scope: string; machineId: string | null } | null>(null);
  const machineId = choice?.scope === scope ? choice.machineId : null;
  useEffect(() => {
    if (choice?.scope === scope || machines === null || host.containerId === null) return;
    let saved: string | null = null;
    try { saved = sessionStorage.getItem(storageKey); } catch { /* Browser storage is optional. */ }
    // Every online machine must have answered (`ok`, `absent` or `unknown`) before a default is judged.
    const online = machines.filter(machine => machine.online && machine.revoked !== true);
    if (online.length && (presence === null || online.some(machine => !presence.has(machine.id)))) return;
    const initial = initialDestination(machines, presence ?? new Map(), saved);
    if (initial) setChoice({ scope, machineId: initial });
  }, [choice, scope, storageKey, machines, presence, host.containerId]);
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
    machines, machine, machineId, target, error, refresh, select, presence,
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
/** Manifold announces every Agent and Run change on its access plugin's topic, with no payload. */
const ACCESS_TOPIC = { kind: "plugin", pluginId: "core.access" } as const;
/**
 * Code's Agent Runs in this workspace (workflow.ts `readRuns`), read again on every Agent or Run
 * change and terminal change, and polled besides. A read that fails keeps the last one on show
 * beside its error, so a Run's dials never vanish under a passing failure; their doors decide.
 */
export function useCodeAgentRuns(host: HostServices) {
  const feed = usePolledResource<{ runs: CodeRuns | null; error: string | null } | null>(async () => {
    try { return { runs: await codeWorkflow(host).readRuns(host.containerId!), error: null }; }
    catch (reason) { return { runs: null, error: codeOperationFailure(reason) }; }
  }, FALLBACK_POLL_MS, {
    key: `${CODE_PLUGIN_ID}.agent-runs:${host.containerId}`, restartKey: host.principal.id, initial: null,
    enabled: host.containerId !== null, topics: [ACCESS_TOPIC, ...host.topics.terminals], events: host.client,
  });
  // The last good read is kept only for the workspace and principal it was read for.
  const feedKey = `${host.containerId}\n${host.principal.id}`;
  const last = useRef<{ key: string; runs: CodeRuns } | null>(null);
  if (feed.value?.runs) last.current = { key: feedKey, runs: feed.value.runs };
  return { runs: feed.value?.runs ?? (last.current?.key === feedKey ? last.current.runs : null), error: feed.value?.error ?? null, refresh: feed.refresh };
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
 * change independently of Manifold events. Code configuration commits also fan out
 * on the declared plugin topic so peer workspaces refresh without waiting to poll. */
export function useWorkflowQuery<T>(host: HostServices, key: string, enabled: boolean, observe: () => Promise<T>, intervalMs = FALLBACK_POLL_MS) {
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => { setRefreshing(false); }, [key, host.principal.id]);
  const feed = usePolledResource<{ data: T | null; error: string | null; code: string | null } | null>(async () => {
    if (!enabled) return null;
    try { return { data: await observe(), error: null, code: null }; }
    catch (reason) { return { data: null, error: codeOperationFailure(reason), code: reason instanceof WorkflowError ? refusalToken(reason.message) : null }; }
  }, intervalMs, {
    key, restartKey: host.principal.id,
    initial: null, enabled,
    onSuccess: () => setRefreshing(false),
    onError: () => setRefreshing(false),
    topics: [CODE_PREFERENCES_TOPIC], events: host.client,
  });
  const refresh = useCallback(() => {
    if (!enabled) return;
    setRefreshing(true);
    feed.refresh();
  }, [enabled, feed.refresh]);
  return { data: feed.value?.data ?? null, error: feed.value?.error ?? null, code: feed.value?.code ?? null, refreshing, refresh };
}
