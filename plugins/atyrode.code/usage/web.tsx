import { useId, type ComponentType } from "react";
import type { PanelProps } from "@manifold/plugin";
import { ScrollRegion } from "@manifold/ui";
import { CODE_PLUGIN_ID, USAGE_PLUGIN_ID } from "../contract.ts";
import { useCodeTarget } from "../machine-web.ts";
import { UsageOverview } from "../usage-view.tsx";

function UsagePanel({ host }: PanelProps) {
  const id = useId();
  const { machines, machine, machineId, target, available, error, select, refresh } = useCodeTarget(host);
  const machineStatus = error ?? (machines === null ? "Reading machines…" : !host.containerId ? "Mount a workspace to read usage." : machineId === null ? "No eligible machine selected." : !machine ? "Selected machine unavailable." : machine.revoked === true ? "Selected machine revoked · observations are historical." : !available ? "Selected machine offline · observations are historical." : null);
  return <ScrollRegion className="plugin-atyrode_code plugin-atyrode_code_usage" aria-label="Code usage">
    <div className="plugin-atyrode_code_usage__body">
      <div className="plugin-atyrode_code_usage__target">
        <label htmlFor={`${id}-machine`}>machine</label>
        <select id={`${id}-machine`} value={machineId ?? ""} onChange={event => { if (event.target.value) select(event.target.value); }} aria-describedby={machineStatus ? `${id}-machine-status` : undefined}>
          <option value="" disabled>Choose a machine</option>
          {machineId !== null && !machine && <option value={machineId}>Selected machine unavailable ({machineId})</option>}
          {machines?.map(entry => <option key={entry.id} value={entry.id}>{entry.name}{entry.revoked === true ? " · revoked" : entry.online ? "" : " · offline"}</option>)}
        </select>
        <button type="button" onClick={refresh} title="Refresh machine availability">Refresh machines</button>
      </div>
      {machineStatus && <p id={`${id}-machine-status`} role="status" className="plugin-atyrode_code__warning">{machineStatus}</p>}
      <UsageOverview key={JSON.stringify([host.principal.id, target?.containerId, target?.machineId])} host={host} target={target} />
      <footer className="plugin-atyrode_code_usage__footer"><button type="button" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>Native setup &amp; jobs</button></footer>
    </div>
  </ScrollRegion>;
}

export default { id: USAGE_PLUGIN_ID, panels: { usage: UsagePanel } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
