import { describe, expect, test } from "bun:test";
import { PluginManifestSchema } from "@manifold/protocol";
import {
  CODE_PLUGIN_ID,
  GENERATOR_PLUGIN_ID,
  LAUNCH_RECORDED_EVENT,
  LAUNCHER_PANEL,
} from "../atyrode.code/contract.ts";
import codeManifest from "../atyrode.code/manifest.json";
import generatorManifest from "../atyrode.code/generator/manifest.json";

/**
 * A manifest is JSON and cannot import `contract.ts`, so the ids it repeats are pinned here:
 * the halves spell every id from the contract, and a manifest that drifted would publish a
 * plugin whose own code names something else.
 */

describe("the manifests spell the contract", () => {
  test("the baseline: its id, the event it originates, no panel of its own", () => {
    const manifest = PluginManifestSchema.parse(codeManifest);
    expect(manifest.id).toBe(CODE_PLUGIN_ID);
    expect(manifest.contributes.events.map((e) => e.id)).toEqual([LAUNCH_RECORDED_EVENT]);
    expect(manifest.contributes.panels).toEqual([]);
    expect(manifest.entry).toEqual({ server: true, web: "web.js" });
  });

  test("the generator: its id, its one panel, and the required edge to the baseline", () => {
    const manifest = PluginManifestSchema.parse(generatorManifest);
    expect(manifest.id).toBe(GENERATOR_PLUGIN_ID);
    expect(manifest.contributes.panels.map((p) => p.id)).toEqual([LAUNCHER_PANEL]);
    expect(manifest.dependencies?.[CODE_PLUGIN_ID]?.type).toBe("required");
    expect(manifest.entry).toEqual({ web: "web.js" });
    expect(manifest.capabilities).toEqual([]);
  });
});
