import { useId, type ComponentType } from "react";
import type { PanelProps } from "@manifold/plugin";
import { ScrollRegion } from "@manifold/ui";
import { ACCOUNTS_PLUGIN_ID } from "../contract.ts";
import { useCodeTarget } from "../machine-web.ts";
import { AccountsView } from "../accounts-view.tsx";

function AccountsPanel({ host }: PanelProps) {
  const id = useId();
  const { machines, machine, machineId, target, available, error, select, refresh } = useCodeTarget(host);
  return <ScrollRegion className="plugin-atyrode_code plugin-atyrode_code_accounts" aria-label="Code accounts">
    <div className="plugin-atyrode_code_accounts__body">
      <div className="plugin-atyrode_code_accounts__target">
        <label htmlFor={`${id}-machine`}>workspace machine · project choices only</label>
        <select id={`${id}-machine`} value={machineId ?? ""} onChange={event => { if (event.target.value) select(event.target.value); }} aria-describedby={`${id}-machine-status`}>
          <option value="" disabled>Choose machine</option>
          {machineId !== null && !machine && <option value={machineId}>{machineId} · unavailable</option>}
          {machines?.map(entry => <option key={entry.id} value={entry.id}>{entry.name}{entry.revoked === true ? " · revoked" : entry.online ? "" : " · offline"}</option>)}
        </select>
        <button type="button" onClick={refresh}>refresh machines</button>
      </div>
      <p id={`${id}-machine-status`} role="status" className="plugin-atyrode_code__muted">{error ?? (machines === null ? "Reading workspace machines…" : machineId === null ? "No workspace machine selected. Instance accounts are shown below." : !machine ? "Selected workspace machine is no longer visible; it has not been replaced." : machine.revoked === true ? "Selected workspace machine is revoked; project choices unavailable." : !machine.online ? "Selected workspace machine is offline; project choices unavailable." : !host.containerId ? "Mount an editable workspace to save project account choices or open OMP." : null)}</p>
      <AccountsView host={host} target={target} available={available} />
    </div>
  </ScrollRegion>;
}

export default { id: ACCOUNTS_PLUGIN_ID, panels: { accounts: AccountsPanel } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
