#!/usr/bin/env bun
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { PackResult } from "../../manifold/packages/plugin-kit/src/pack.ts";
import { MachineHalfSchema } from "../../manifold/packages/protocol/src/jobs.ts";
import { buildWorkerArtifacts, type WorkerArtifacts, type WorkerTarget } from "./workers/build.ts";

const pluginRoot = import.meta.dir;
const kitPack = resolve(pluginRoot, "../../manifold/packages/plugin-kit/src/pack.ts");
const PackResultSchema: z.ZodType<PackResult> = z.strictObject({
  file: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive(),
});
// This is also the explicit installation order: parent, native accounts, gateway, then UI parts.
const familyIds = ["atyrode.code", "atyrode.code.accounts", "atyrode.code.gateway", "atyrode.code.generator", "atyrode.code.usage"];

function includeSource(path: string): boolean {
  const name = basename(path);
  return !name.startsWith(".") && !["node_modules", "dist", "staging"].includes(name);
}

async function manifests(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!includeSource(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await manifests(path));
    else if (entry.isFile() && entry.name === "manifest.json") files.push(path);
  }
  return files.sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0));
}

async function bindWorkerArtifacts(directory: string, expectedId: string, target: WorkerTarget): Promise<WorkerArtifacts> {
  const file = join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  if (manifest.id !== expectedId || !manifest.machine) throw new Error(`${expectedId} native machine contract is missing`);
  const built = await buildWorkerArtifacts(directory, target);
  manifest.machine.artifacts = built.artifacts;
  manifest.machine.tools = built.tools;
  const machine = MachineHalfSchema.parse(manifest.machine);
  const usedTools = new Set<string>();
  for (const [id, operation] of Object.entries(machine.operations)) {
    for (const required of built.requiredRuntimeTools) {
      if (!operation.runtimeTools.includes(required)) throw new Error(`${id} must declare the reviewed native '${required}' resource dependency`);
    }
    if ((target === "gateway" || id === "atyrode.code.accounts.broker") && !operation.runtimeTools.includes("pi-natives")) throw new Error(`${id} must declare the pinned SDK native addon`);
    for (const alias of operation.runtimeTools) usedTools.add(alias);
  }
  for (const alias of Object.keys(built.tools)) {
    if (!usedTools.has(alias)) throw new Error(`${expectedId} has an unused managed tool: ${alias}`);
  }
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return built;
}

/** Private same-depth staging preserves the sibling native SDK paths. Only generated
 * artifact declarations change; source manifests remain authoritative for operations,
 * service policy and resource requirements. No install, network worker or Go rebuild.
 */
export async function pack(outputDirectory?: string): Promise<readonly (PackResult & { readonly id: string })[]> {
  const stage = await mkdtemp(join(dirname(pluginRoot), ".code-native-pack-"));
  try {
    for (const entry of await readdir(pluginRoot)) {
      if (includeSource(entry)) await cp(join(pluginRoot, entry), join(stage, entry), { recursive: true, filter: includeSource });
    }
    await symlink(join(pluginRoot, "node_modules"), join(stage, "node_modules"), "dir");
    const rootDirectory = join(stage, "atyrode.code");
    const built = await bindWorkerArtifacts(rootDirectory, "atyrode.code", "root");
    await bindWorkerArtifacts(join(rootDirectory, "accounts"), "atyrode.code.accounts", "accounts");
    await bindWorkerArtifacts(join(rootDirectory, "gateway"), "atyrode.code.gateway", "gateway");
    const family = await manifests(rootDirectory);
    const byId = new Map<string, string>();
    for (const file of family) {
      const { id } = JSON.parse(await readFile(file, "utf8"));
      if (!familyIds.includes(id) || byId.has(id)) throw new Error(`Unexpected or duplicate Code family manifest: ${relative(stage, file)}`);
      byId.set(id, file);
    }
    if (familyIds.some(id => !byId.has(id))) throw new Error("The five Code family manifests must be packed together");
    // Keep previous output intact until every parent-before-part bundle has passed kit
    // schema, artifact hash/member checks and the aggregate 16 MiB JSON bound.
    const output = outputDirectory === undefined ? join(stage, "dist") : resolve(outputDirectory);
    await mkdir(output, { recursive: true });
    const sums: string[] = [];
    const bundles: (PackResult & { readonly id: string })[] = [];
    for (const id of familyIds) {
      const file = byId.get(id)!;
      const filename = `${id}.manifold-plugin.json`;
      // Bun's readable source paths follow cwd. A private compiler keeps the staging
      // directory's random name out of bundle bytes and promoted product revisions.
      const compiler = Bun.spawn([process.execPath, kitPack, dirname(file), "--out", join(output, filename)], {
        cwd: stage, stdout: "pipe", stderr: "pipe",
      });
      const [exit, report, diagnostic] = await Promise.all([
        compiler.exited, new Response(compiler.stdout).text(), new Response(compiler.stderr).text(),
      ]);
      if (exit !== 0) throw new Error(`Packing ${id} failed: ${diagnostic.trim()}`);
      const result = PackResultSchema.parse(JSON.parse(report));
      sums.push(`${result.sha256}  ${filename}`);
      bundles.push({ id, ...result });
    }
    const checksums = `${sums.join("\n")}\n`;
    await writeFile(join(output, "SHA256SUMS"), checksums);
    // A report, not a fake local installation: native admission checks the externally
    // reviewed system closure and its promoted digest on the selected machine.
    await writeFile(join(output, "native-requirements.json"), `${JSON.stringify({ requiredRuntimeTools: built.requiredRuntimeTools, system: built.systemRequirements }, null, 2)}\n`);
    const dist = outputDirectory === undefined ? join(pluginRoot, "dist") : output;
    if (outputDirectory === undefined) {
      await rm(dist, { recursive: true, force: true });
      await rename(output, dist);
      process.stdout.write(checksums);
    }
    return bundles.map(bundle => ({ ...bundle, file: join(dist, basename(bundle.file)) }));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (process.argv.length !== 2) throw new Error("Usage: bun plugins/pack.ts");
  await pack();
}
