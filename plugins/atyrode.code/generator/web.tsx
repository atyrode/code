import { useEffect, useId, useRef, useState, type ComponentType, type FormEvent } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import { FALLBACK_POLL_MS, MACHINES_RESOURCE, usePolledResource } from "@manifold/plugin/hooks";
import type { MachineSummary, ManifoldRef } from "@manifold/protocol";
import { Cluster, ControlIcon, ScrollRegion, Stack, Switcher } from "@manifold/ui";
import {
  CODE_ARGV0,
  CODE_PLUGIN_ID,
  GENERATOR_PLUGIN_ID,
  LAUNCH_DOOR,
  LAUNCHER_PANEL,
  LIST_LAUNCHES_DOOR,
  LaunchResultSchema,
  ListLaunchesResultSchema,
  type LaunchInput,
  type LaunchRecord,
} from "../contract.ts";
import { selectedMachine } from "./model.ts";

const LEDGER_TOPICS: readonly ManifoldRef[] = [{ kind: "plugin", pluginId: CODE_PLUGIN_ID }];
const LAUNCH_LABEL = "code (interactive)";
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

type LaunchStatus = { kind: "pending" | "denied" | "opened"; text: string } | null;
type Ledger = { launches: readonly LaunchRecord[]; error: string | null } | null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mountRefusal(host: HostServices): string | null {
  if (host.containerId === null) return "Open a container in the workspace, then launch code here.";
  if (host.authoring === null) return "Mount an editable container view in the workspace before opening a terminal tile.";
  return null;
}

async function readLedger(host: HostServices): Promise<Ledger> {
  try {
    const outcome = await host.client.action(LIST_LAUNCHES_DOOR, {});
    if (!outcome.ok) return { launches: [], error: outcome.denial.message };
    return { launches: ListLaunchesResultSchema.parse(outcome.result).launches, error: null };
  } catch (error) {
    return { launches: [], error: errorText(error) };
  }
}

function Launcher({ host }: PanelProps) {
  const id = useId();
  const [selection, setSelection] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [status, setStatus] = useState<LaunchStatus>(null);
  const [machineError, setMachineError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const { value: machines, refresh: refreshMachines } = usePolledResource<readonly MachineSummary[] | null>(
    () => host.client.machines(),
    FALLBACK_POLL_MS,
    {
      key: MACHINES_RESOURCE,
      initial: null,
      topics: host.topics.machines,
      events: host.client,
      onError: (error) => setMachineError(errorText(error)),
    },
  );
  useEffect(() => { setMachineError(null); }, [machines]);
  const { value: ledger, refresh: refreshLedger } = usePolledResource<Ledger>(
    () => readLedger(host),
    FALLBACK_POLL_MS,
    {
      key: `${CODE_PLUGIN_ID}.launches`,
      restartKey: host.principal.id,
      initial: null,
      topics: LEDGER_TOPICS,
      events: host.client,
    },
  );

  const online = machines?.filter((machine) => machine.online && machine.revoked !== true) ?? [];
  const machine = selectedMachine(machines, selection);
  const unavailableSelection = selection !== null && machine === null;
  const selectedName = machines?.find((entry) => entry.id === selection)?.name ?? selection;
  const noMount = mountRefusal(host);
  const busy = status?.kind === "pending";
  const latest = useRef({ host, machines });
  latest.current = { host, machines };

  async function launch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const refusal = mountRefusal(host);
    if (refusal !== null || machine === null || machineError !== null) {
      setStatus({ kind: "denied", text: refusal ?? machineError ?? "Choose an online, non-revoked machine before launching." });
      return;
    }
    pending.current = true;
    setStatus({ kind: "pending", text: `Requesting authorization on ${machine.name}…` });
    const containerId = host.containerId;
    const machineId = machine.id;
    let authorization: string | null = null;
    try {
      const request: LaunchInput = { machineId, argv: [CODE_ARGV0], label: LAUNCH_LABEL };
      const outcome = await host.client.action(LAUNCH_DOOR, request);
      if (!outcome.ok) {
        if (mounted.current) setStatus({ kind: "denied", text: outcome.denial.message });
        return;
      }
      const result = LaunchResultSchema.parse(outcome.result);
      authorization = result.launchId;
      if (!mounted.current) return;
      const current = latest.current;
      if (current.host.client !== host.client || current.host.containerId !== containerId || mountRefusal(current.host) !== null) {
        throw new Error("The mounted container changed. Return to the intended container and launch again.");
      }
      if (selectedMachine(current.machines, machineId) === null) {
        throw new Error("The selected machine is no longer online or has been revoked. Choose an available machine and try again.");
      }
      setStatus({ kind: "pending", text: `Authorized. Opening a terminal tile on ${machine.name}…` });
      const terminal = await current.host.client.openTerminal({
        elementId: crypto.randomUUID(),
        cols: 120,
        rows: 40,
        machineId,
        placement: "tile",
        program: { argv: result.argv },
        ...(cwd.length === 0 ? {} : { cwd }),
      });
      if (!mounted.current) return;
      setStatus(terminal.status === "running"
        ? { kind: "opened", text: `Terminal ${terminal.name ?? terminal.id} opened on ${machine.name}. Continue selection there; this confirms the terminal opened, not that a coding session is ready.` }
        : { kind: "denied", text: `Authorization ${authorization} was recorded, but terminal ${terminal.name ?? terminal.id} is ${terminal.status}. Inspect the terminal output before retrying.` });
    } catch (error) {
      if (mounted.current) setStatus({
        kind: "denied",
        text: authorization === null
          ? `Launch failed: ${errorText(error)}`
          : `Authorization ${authorization} was recorded, but opening a terminal was not confirmed: ${errorText(error)}`,
      });
    } finally {
      pending.current = false;
      if (mounted.current) {
        refreshLedger();
        refreshMachines();
      }
    }
  }

  function refresh() {
    setMachineError(null);
    refreshMachines();
    refreshLedger();
  }

  return (
    <ScrollRegion className="plugin-atyrode_code_generator" aria-label="Code launcher">
      <Stack className="plugin-atyrode_code_generator__body" gap="1.25rem">
        <header>
          <Cluster justify="space-between" gap="0.5rem">
            <h2>code</h2>
            <span className="plugin-atyrode_code_generator__badge">Interactive launch</span>
          </Cluster>
          <p className="plugin-atyrode_code_generator__muted">Choose where to work. Open code alongside this panel.</p>
        </header>
        <form onSubmit={launch} aria-busy={busy}>
          <Stack gap="1rem">
            <Switcher threshold="36rem" gap="1rem">
              <Stack gap="0.4rem">
                <label htmlFor={`${id}-machine`}>Machine</label>
                <select id={`${id}-machine`} value={machine?.id ?? selection ?? ""} disabled={busy || machines === null}
                  aria-describedby={`${id}-machines-help`} aria-invalid={unavailableSelection}
                  onChange={(event) => { setSelection(event.target.value || null); setStatus(null); }}>
                  {machine === null && <option value={selection ?? ""} disabled>{unavailableSelection ? `${selectedName} (unavailable)` : "Choose an online machine"}</option>}
                  {online.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select>
                <p id={`${id}-machines-help`} className="plugin-atyrode_code_generator__muted" aria-live="polite">
                  {machineError !== null ? `Machine list unavailable: ${machineError}` : machines === null ? "Loading machines…" : unavailableSelection
                    ? "Your selected machine disappeared, went offline, or was revoked. Choose another machine; launches are never redirected automatically."
                    : online.length === 0 ? "No online, non-revoked machine is available. Connect an enrolled machine, then refresh."
                    : `${online.length} online. Code must be installed on the selected machine.`}
                </p>
              </Stack>
              <Stack gap="0.4rem">
                <label htmlFor={`${id}-cwd`}>Working directory <span className="plugin-atyrode_code_generator__muted">(optional)</span></label>
                <input id={`${id}-cwd`} value={cwd} disabled={busy} placeholder="Machine default" autoComplete="off" spellCheck={false}
                  aria-describedby={`${id}-cwd-help`} onChange={(event) => setCwd(event.target.value)} />
                <p id={`${id}-cwd-help`} className="plugin-atyrode_code_generator__muted">A path on that machine, not this browser. Leave empty for the machine default.</p>
              </Stack>
            </Switcher>
            <div className="plugin-atyrode_code_generator__note">
              <p>Provider, account, model, and agent selection still happen in the interactive terminal. This panel authorizes and opens <code>code</code>; it does not expose remote configuration or usage data.</p>
            </div>
            <Cluster gap="0.75rem">
              <button type="submit" className="plugin-atyrode_code_generator__launch" data-action={LAUNCH_DOOR}
                disabled={busy || machine === null || noMount !== null || machineError !== null} aria-describedby={`${id}-destination`}>
                <ControlIcon kind="add" />{busy ? "Opening code…" : "Open code in a tile"}
              </button>
              <button type="button" className="plugin-atyrode_code_generator__refresh" onClick={refresh} disabled={busy}>Refresh</button>
            </Cluster>
            <p id={`${id}-destination`} className="plugin-atyrode_code_generator__muted" aria-live="polite">
              {noMount ?? `Destination: current container ${host.containerId}. This launch panel stays open.`}
            </p>
            <div role="status" aria-live="polite" aria-atomic="true" className="plugin-atyrode_code_generator__status" data-state={status?.kind ?? "idle"}>
              {status?.text}
            </div>
          </Stack>
        </form>
        <section aria-labelledby={`${id}-ledger`} className="plugin-atyrode_code_generator__ledger">
          <Stack gap="0.75rem">
            <h3 id={`${id}-ledger`}>Recent authorizations</h3>
            <p className="plugin-atyrode_code_generator__muted">Recorded by the launch door. These are not running sessions: terminal creation may be refused or the program may have exited.</p>
            {ledger === null ? <p role="status">Loading authorizations…</p> : ledger.error !== null
              ? <p role="status" className="plugin-atyrode_code_generator__error">Authorization history unavailable: {ledger.error}</p>
              : ledger.launches.length === 0 ? <p className="plugin-atyrode_code_generator__muted">No authorizations recorded yet.</p>
              : <ol className="plugin-atyrode_code_generator__records">
                {ledger.launches.map((record) => (
                  <li key={record.launchId}>
                    <Cluster justify="space-between" gap="0.35rem">
                      <strong>{record.label ?? record.argv.join(" ")}</strong>
                      <time dateTime={new Date(record.recordedAt).toISOString()}>{dateFormat.format(record.recordedAt)}</time>
                    </Cluster>
                    <p>{machines?.find((entry) => entry.id === record.machineId)?.name ?? record.machineId}</p>
                    <p className="plugin-atyrode_code_generator__muted">Authorization <code>{record.launchId}</code> · by {record.by}</p>
                  </li>
                ))}
              </ol>}
          </Stack>
        </section>
      </Stack>
    </ScrollRegion>
  );
}

// WebPluginDef's registration shape; the public SDK does not export that host-owned type.
export default {
  id: GENERATOR_PLUGIN_ID,
  panels: { [LAUNCHER_PANEL]: Launcher },
} satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
