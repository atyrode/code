#!/usr/bin/env bun
import { devLoop } from "../../manifold/packages/plugin-kit/src/dev.ts";
import { exitWith, parseHubFlags, resolveOwnerKey } from "../../manifold/packages/plugin-kit/src/install.ts";
import { pack } from "./pack.ts";

try {
  const flags = parseHubFlags(process.argv.slice(2), false);
  if (flags.positionals.length) throw new Error("Usage: bun run dev -- --hub <url> --deliver <target>");
  if (flags.hardened) throw new Error("Code uses the reviewed in-realm React renderer, not PanelProgram isolation.");
  const ownerKey = await resolveOwnerKey(flags.ownerKeyFile, flags.deliver);
  await devLoop({
    root: import.meta.dir,
    hub: { url: flags.hub, ownerKey },
    ...(flags.deliver === undefined ? {} : { deliver: flags.deliver }),
    build: pack,
  });
} catch (error) {
  exitWith("code dev", error);
}
