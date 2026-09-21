import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { HostServices } from "@manifold/plugin";
import { formatManifoldUri, type MachineSummary, type TerminalSummary } from "@manifold/protocol";
import { OMP_PLUGIN_ID, type OmpSessionRef } from "@atyrode/manifold-omp";
import { codeOperationFailure, codeWorkflow, useCodeTerminals, useWorkflowQuery } from "../machine-web.ts";
import { runningSessionTerminals } from "../workflow.ts";

function MachineSessions({ host, machine, permitted, selected, sessionId, choose, terminals, refreshTerminals, busy }: {
  host: HostServices; machine: MachineSummary; permitted: boolean; selected: boolean; sessionId: string;
  choose: (id: string) => void; terminals: readonly TerminalSummary[] | null; refreshTerminals: () => void; busy: boolean;
}) {
  const id = useId();
  const [requested, setRequested] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  const available = permitted && machine.online && !machine.revoked;
  const scope = useRef({ mounted: true, host, available });
  scope.current.host = host; scope.current.available = available;
  useEffect(() => { scope.current.mounted = true; return () => { scope.current.mounted = false; }; }, []);
  const inventory = useWorkflowQuery(host, `fleet-sessions:${id}:${host.containerId}:${machine.id}:${available}`, requested && available,
    () => codeWorkflow(host).listSessions(machine.id));
  const state = !available ? "unavailable" : !requested ? "not-requested" : inventory.refreshing || (!inventory.data && !inventory.error) ? "pending"
    : inventory.error ? "failed" : inventory.data?.length ? "ready" : "empty";
  useEffect(() => {
    if (selected && sessionId && (state !== "ready" || !inventory.data?.some(session => session.id === sessionId))) choose("");
  }, [selected, sessionId, state, inventory.data, choose]);
  async function reopen(ref: OmpSessionRef, terminalId: string) {
    if (reopening) return;
    setReopening(true); setMessage(null);
    try {
      const current = await codeWorkflow(host).runningSession(ref);
      if (!current.some(terminal => terminal.id === terminalId)) throw new Error("The running terminal is no longer available. Refresh and deliberately choose whether to resume saved state.");
      if (!scope.current.mounted || !scope.current.available || scope.current.host.client !== host.client ||
        scope.current.host.principal.id !== host.principal.id) return;
      host.navigate(formatManifoldUri({ kind: "terminal", terminalId }));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : codeOperationFailure(reason));
    } finally { setReopening(false); refreshTerminals(); }
  }
  return <section data-fleet-machine={machine.id} data-inventory-state={state} aria-label={`Native sessions on ${machine.name}`}>
    <h3>{machine.name}{selected ? " · execution destination" : ""}</h3>
    <p>{!permitted ? "Machine roster unavailable." : machine.revoked ? "Access revoked." : !machine.online ? "Offline. The destination has not been replaced." : "Native title and header metadata only."}</p>
    <button type="button" data-action="atyrode.omp.listSessions" disabled={!available || busy || reopening || state === "pending"}
      onClick={() => { setRequested(true); inventory.refresh(); refreshTerminals(); }}>List saved sessions</button>
    {state === "pending" && <p role="status">Reading native saved-session metadata…</p>}
    {state === "failed" && <p role="status" className="plugin-atyrode_code__warning">{inventory.error}</p>}
    {state === "empty" && <p>No saved sessions reported for this machine.</p>}
    {state === "ready" && <>
      {selected ? <><label htmlFor={`${id}-session`}>Saved session</label>
        <select id={`${id}-session`} disabled={busy || reopening} value={sessionId} onChange={event => choose(event.target.value)}>
          <option value="">Choose a saved session</option>
          {inventory.data!.map(session => <option key={session.id} value={session.id}>{session.title ?? session.id}</option>)}
        </select></> : <p>Choose this machine in execution destination before selecting saved state to resume here.</p>}
      <ul>{inventory.data!.map(session => {
        const ref: OmpSessionRef = { harness: OMP_PLUGIN_ID, machineId: machine.id, sessionId: session.id };
        const matches = runningSessionTerminals(ref, terminals ?? []);
        return <li key={session.id} data-session-id={session.id} data-session-activity={matches.length ? "running" : "unknown"}>
          <strong>{session.title ?? session.id}</strong><p>Saved header directory: {session.cwd} · {new Date(session.updatedAt).toLocaleString()}</p>
          {matches.length ? matches.map(terminal => <div key={terminal.id} data-terminal-id={terminal.id}>
            <p>Running · current terminal workspace: <span data-terminal-home>{terminal.homeId}</span></p>
            <button type="button" data-action="reopen-session" disabled={busy || reopening || !available} onClick={() => void reopen(ref, terminal.id)}>Reopen existing terminal</button>
          </div>) : <p>Activity unknown. No exact running-terminal correlation is available; this does not prove the session stopped. No current workspace is known.</p>}
        </li>;
      })}</ul>
    </>}
    {message && <p role="status" className="plugin-atyrode_code__warning">{message}</p>}
  </section>;
}

export function FleetSessions({ host, machines, rosterError, machineId, sessionId, choose, busy, children }: {
  host: HostServices; machines: readonly MachineSummary[] | null; rosterError: string | null; machineId: string;
  sessionId: string; choose: (id: string) => void; busy: boolean; children: (running: boolean) => ReactNode;
}) {
  const terminals = useCodeTerminals(host);
  return <section className="plugin-atyrode_code_generator__saved-sessions" aria-label="Fleet native sessions">
    <h2 className="plugin-atyrode_code__section-label">Fleet native sessions</h2>
    <p>Read each permitted machine explicitly. This is not an archive or transcript import. Missing or incompatible sessions refuse; Code never starts a fresh replacement.</p>
    {machines === null && <p role="status">Reading permitted machines…</p>}
    {rosterError && <p role="status" className="plugin-atyrode_code__warning">{rosterError}</p>}
    {terminals.error && <p role="status" className="plugin-atyrode_code__warning">{terminals.error}</p>}
    {machineId && machines && !machines.some(machine => machine.id === machineId) &&
      <p role="status" data-fleet-machine={machineId} data-inventory-state="unavailable">The selected destination is inaccessible. Its selection is preserved; no other machine will be used.</p>}
    {machines?.map(machine => <MachineSessions key={machine.id} host={host} machine={machine} permitted={rosterError === null}
      selected={machine.id === machineId} sessionId={machine.id === machineId ? sessionId : ""} choose={choose}
      terminals={terminals.terminals} refreshTerminals={terminals.refresh} busy={busy} />)}
    {children(runningSessionTerminals({ harness: OMP_PLUGIN_ID, machineId, sessionId }, terminals.terminals ?? []).length > 0)}
  </section>;
}
