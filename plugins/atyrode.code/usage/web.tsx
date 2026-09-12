import { type ComponentType } from "react";
import type { PanelProps } from "@manifold/plugin";
import { ScrollRegion } from "@manifold/ui";
import { CODE_PLUGIN_ID, USAGE_PLUGIN_ID } from "../contract.ts";
import { UsageOverview } from "../usage-view.tsx";

function UsagePanel({ host }: PanelProps) {
  return <ScrollRegion className="plugin-atyrode_code plugin-atyrode_code_usage" aria-label="Code usage">
    <div className="plugin-atyrode_code_usage__body">
      <p className="plugin-atyrode_code__muted">Usage follows this workspace’s shared account pool, independently of its execution destination.</p>
      <UsageOverview host={host} />
      <footer className="plugin-atyrode_code_usage__footer"><button type="button" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>Native setup &amp; jobs</button></footer>
    </div>
  </ScrollRegion>;
}

export default { id: USAGE_PLUGIN_ID, panels: { usage: UsagePanel } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
