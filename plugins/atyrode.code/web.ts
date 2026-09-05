import { defineWebPlugin } from "@manifold/plugin-kit/web";
import { CODE_PLUGIN_ID } from "./contract.ts";

/*
  THE BASELINE, web half. It serves no panel: the launch UI is `atyrode.code.generator`, a
  view over this plugin's doors, so this worker answers `ready { panels: [] }` and is otherwise
  idle. The bundle names both halves (`entry: { server: true, web: "web.js" }`); a baseline
  surface of its own, if one is ever wanted, is a panel added here.
 */

defineWebPlugin({ id: CODE_PLUGIN_ID, panels: {} });
