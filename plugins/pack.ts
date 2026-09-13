#!/usr/bin/env bun
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compilePlugin, type PackResult } from "../../manifold/packages/plugin-kit/src/pack.ts";
import { PluginManifestSchema } from "@manifold/protocol";

const pluginRoot = import.meta.dir;
const family = [
  ["atyrode.code", "atyrode.code"],
  ["atyrode.code.accounts", "atyrode.code/accounts"],
  ["atyrode.code.generator", "atyrode.code/generator"],
  ["atyrode.code.usage", "atyrode.code/usage"],
] as const;

/** Code only compiles its policy and presentation. Runtime artifacts and their
 * provenance, native requirements and publication belong to the OMP dependency. */
export async function pack(outputDirectory?: string): Promise<readonly (PackResult & { readonly id: string })[]> {
  const compiled = [];
  for (const [id, source] of family) {
    const directory = join(pluginRoot, source);
    const manifest = PluginManifestSchema.parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
    if (manifest.id !== id || manifest.machine) throw new Error(`Unexpected Code policy/presentation manifest: ${source}`);
    compiled.push({ id, ...await compilePlugin(directory) });
  }
  const output = outputDirectory === undefined ? join(pluginRoot, "dist") : resolve(outputDirectory);
  // Compile the entire family before replacing Code's own generated directory.
  // An explicitly supplied output directory is not ours to recursively remove.
  if (outputDirectory === undefined) await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const bundles: (PackResult & { readonly id: string })[] = [];
  const sums: string[] = [];
  for (const { id, bytes, sha256 } of compiled) {
    const filename = `${id}.manifold-plugin.json`;
    const file = join(output, filename);
    await writeFile(file, bytes);
    bundles.push({ id, file, bytes: bytes.byteLength, sha256 });
    sums.push(`${sha256}  ${filename}`);
  }
  const checksums = `${sums.join("\n")}\n`;
  await writeFile(join(output, "SHA256SUMS"), checksums);
  if (outputDirectory === undefined) process.stdout.write(checksums);
  return bundles;
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error("Usage: bun plugins/pack.ts");
  await pack();
}
