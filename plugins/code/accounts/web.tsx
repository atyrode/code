import { useId, useMemo, useState, type ComponentType } from "react";
import type { PanelProps } from "@manifold/plugin";
import { ScrollRegion } from "@manifold/ui";
import { ACCOUNTS_PLUGIN_ID } from "../contract.ts";
import { useCodeTarget } from "../machine-web.ts";
import { AccountsView } from "../accounts-view.tsx";
import { PanelLayer } from "../panel-layer.tsx";

function AccountsPanel({ host }: PanelProps) {
  const id = useId();
  const { machines, machine, machineId, target, available, error, select, refresh } = useCodeTarget(host);
  // The panel's root, which its layer (a native review) stands in, inside the panel and over nothing else, once mounted.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const layer = useMemo(() => root ? { panel: root, accent: "var(--code-accent)" } : null, [root]);
  return <div ref={setRoot} className="plugin-atyrode_code plugin-atyrode_code_accounts-root">
    <PanelLayer.Provider value={layer}>
      <ScrollRegion className="plugin-atyrode_code_accounts" aria-label="Code accounts">
        <div className="plugin-atyrode_code_accounts__body">
          <div className="plugin-atyrode_code_accounts__target">
            <label htmlFor={`${id}-machine`}>execution destination · choices are shared</label>
            <select id={`${id}-machine`} value={machineId ?? ""} onChange={event => { if (event.target.value) select(event.target.value); }} aria-describedby={`${id}-machine-status`}>
              <option value="" disabled>Choose machine</option>
              {machineId !== null && !machine && <option value={machineId}>{machineId} · unavailable</option>}
              {machines?.map(entry => <option key={entry.id} value={entry.id}>{entry.name}{entry.revoked === true ? " · revoked" : entry.online ? "" : " · offline"}</option>)}
            </select>
            <button type="button" onClick={refresh}>refresh machines</button>
          </div>
          <p id={`${id}-machine-status`} role="status" className="plugin-atyrode_code__muted">{error ?? (machines === null ? "Reading execution destinations…" : !host.containerId ? "Open a workspace to save shared account choices." : machineId === null ? "No execution destination selected. Shared account choices remain available." : !machine ? "Selected destination is no longer visible; it has not been replaced. Shared choices remain available." : machine.revoked === true ? "Selected destination is revoked. Shared choices remain available." : !machine.online ? "Selected destination is offline. Shared choices remain available." : null)}</p>
          <AccountsView host={host} target={target} available={available} />
        </div>
      </ScrollRegion>
    </PanelLayer.Provider>
  </div>;
}

export default { id: ACCOUNTS_PLUGIN_ID, panels: { accounts: AccountsPanel } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
