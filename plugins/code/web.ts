import { CODE_PLUGIN_ID } from "./contract.ts";

// The baseline owns doors and storage; its generator part owns the visible launch panel.
// The pinned SDK does not export WebPluginDef, so this idle registration uses its data shape.
export default { id: CODE_PLUGIN_ID, panels: {} };
