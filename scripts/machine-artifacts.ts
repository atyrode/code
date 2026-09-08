#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { packPlugin } from "../../manifold/packages/plugin-kit/src/pack.ts";
import { MachineHalfSchema } from "../../manifold/packages/protocol/src/jobs.ts";
import type { MachineArtifact } from "../../manifold/packages/protocol/src/jobs.ts";

const pluginRoot = resolve(import.meta.dir, "../plugins");
const artifactMapSchema = MachineHalfSchema.shape.artifacts;
const targets = [
  { platform: "linux-x64", arch: "amd64", machine: 62 },
  { platform: "linux-arm64", arch: "arm64", machine: 183 },
] as const;
const compressedLimit = 32 * 1024 * 1024;
const expandedLimit = 64 * 1024 * 1024;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function releaseBase(repo: string, tag: string): string {
  requireValue(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo), "Expected owner/repo");
  requireValue(/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(tag), "Expected an immutable version tag, not latest or a branch");
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`;
}

function octal(bytes: Buffer): number {
  const text = bytes.toString("ascii").replace(/\0.*$/, "").trim();
  requireValue(/^[0-7]+$/.test(text), "Invalid tar numeric field");
  const value = Number.parseInt(text, 8);
  requireValue(Number.isSafeInteger(value), "Oversized tar numeric field");
  return value;
}

// The release archive contains exactly one regular entry. Read it in memory: never extract
// archive-selected paths, follow links, or accept PAX/GNU path/size overrides.
function workerEntry(tar: Buffer, machine: number): Buffer {
  requireValue(tar.length >= 1536 && tar.length % 512 === 0, "Truncated worker tar");
  const header = tar.subarray(0, 512);
  const name = Buffer.alloc(100);
  name.write("code-machine");
  requireValue(header.subarray(0, 100).equals(name), "Expected exact code-machine entry");
  requireValue(header.subarray(345, 500).every((byte) => byte === 0), "Unexpected tar path prefix");
  requireValue(header[156] === 0 || header[156] === 48, "Worker must be a regular file");
  requireValue(header.subarray(157, 257).every((byte) => byte === 0), "Tar links are forbidden");
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
  requireValue(checksum === octal(header.subarray(148, 156)), "Invalid tar header checksum");
  requireValue((octal(header.subarray(100, 108)) & 0o111) !== 0, "Worker entry is not executable");
  const size = octal(header.subarray(124, 136));
  const end = 512 + size;
  const next = 512 + Math.ceil(size / 512) * 512;
  requireValue(size >= 64 && next + 1024 <= tar.length, "Truncated worker entry");
  requireValue(tar.subarray(end).every((byte) => byte === 0), "Extra members or invalid tar termination");
  const entry = tar.subarray(512, end);
  requireValue(entry.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && entry[4] === 2 && entry[5] === 1 && entry[6] === 1, "Worker must be a 64-bit little-endian ELF executable");
  requireValue(entry.readUInt16LE(16) === 2 && entry.readUInt16LE(18) === machine, "Worker ELF architecture/type mismatch");
  const offset = Number(entry.readBigUInt64LE(32));
  const stride = entry.readUInt16LE(54);
  const count = entry.readUInt16LE(56);
  requireValue(Number.isSafeInteger(offset) && offset >= 64 && stride >= 56 && count > 0 && offset + stride * count <= entry.length, "Invalid ELF program headers");
  for (let i = 0; i < count; i++) {
    const kind = entry.readUInt32LE(offset + i * stride);
    requireValue(kind !== 2 && kind !== 3, "Worker must be static (no dynamic segment or interpreter)");
  }
  return entry;
}

async function archiveRecords(archiveDir: string) {
  const checksums = (await readFile(join(archiveDir, "checksums.txt"), "utf8")).split(/\r?\n/);
  const records: Record<string, Omit<MachineArtifact, "url">> = {};
  for (const target of targets) {
    const filename = `code-machine-linux-${target.arch}.tar.gz`;
    const path = join(archiveDir, filename);
    const stat = await lstat(path);
    requireValue(stat.isFile() && stat.size > 0 && stat.size <= compressedLimit, `${filename}: missing, nonregular or oversized archive`);
    const archive = await readFile(path);
    requireValue(archive.length === stat.size, `${filename}: archive changed while reading`);
    const digest = createHash("sha256").update(archive).digest("hex");
    const pins = checksums.filter((line) => line.endsWith(`  ${filename}`) || line.endsWith(` *${filename}`));
    requireValue(pins.length === 1 && (pins[0] === `${digest}  ${filename}` || pins[0] === `${digest} *${filename}`), `${filename}: missing or mismatched release checksum`);
    const tar = gunzipSync(archive, { maxOutputLength: expandedLimit });
    const entry = workerEntry(tar, target.machine);
    records[target.platform] = {
      sha256: digest,
      format: "tar.gz",
      entry: ["code-machine"],
      entrySha256: createHash("sha256").update(entry).digest("hex"),
      // Exact observed bounds: a larger replacement must be reviewed and re-pinned.
      maxBytes: archive.length,
      maxExpandedBytes: tar.length,
      maxMembers: 1,
    };
  }
  return records;
}

async function suppliedArtifacts(file: string) {
  const records = artifactMapSchema.parse(JSON.parse(await readFile(file, "utf8")));
  if (Object.keys(records).length === 0) return records; // Explicitly unavailable.
  requireValue(Object.keys(records).length === targets.length && targets.every(({ platform }) => records[platform]), "Expected both Linux worker artifacts, or an empty unavailable map");
  const actual = await archiveRecords(dirname(file));
  // Validation alone cannot establish byte provenance. Keep archives/checksums beside the map
  // and re-derive every byte-dependent field before staging. HTTPS URLs are schema-validated,
  // not fetched: disposable proof may serve these same pinned bytes from local HTTPS.
  for (const { platform } of targets) {
    requireValue(isDeepStrictEqual(
      { ...records[platform], url: undefined },
      { ...actual[platform], url: undefined },
    ), `${platform}: artifact metadata does not match archive bytes`);
  }
  return records;
}

function includeSource(path: string): boolean {
  const name = basename(path);
  return !name.startsWith(".") && !["node_modules", "dist", "staging"].includes(name);
}

async function manifests(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const path = join(directory, entry.name);
    if (!includeSource(path)) continue;
    if (entry.isDirectory()) found.push(...await manifests(path));
    else if (entry.isFile() && entry.name === "manifest.json") found.push(path);
  }
  return found.sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0));
}

async function pack() {
  const mapFile = process.env.CODE_MACHINE_ARTIFACTS;
  // A supplied but empty environment value is an error, not the no-artifacts path.
  const artifacts = mapFile === undefined ? undefined : await suppliedArtifacts(resolve(mapFile));
  let stage: string | undefined;
  try {
    let source = pluginRoot;
    if (artifacts !== undefined) {
      // Same depth as plugins/ preserves its tsconfig's sibling SDK paths. mkdtemp is private.
      stage = await mkdtemp(join(dirname(pluginRoot), ".code-machine-pack-"));
      for (const entry of await readdir(pluginRoot)) {
        if (includeSource(entry)) await cp(join(pluginRoot, entry), join(stage, entry), { recursive: true, filter: includeSource });
      }
      await symlink(join(pluginRoot, "node_modules"), join(stage, "node_modules"), "dir");
      const rootManifest = join(stage, "atyrode.code/manifest.json");
      const manifest = JSON.parse(await readFile(rootManifest, "utf8"));
      requireValue(manifest.id === "atyrode.code" && manifest.machine, "Root plugin must declare its governed machine contract");
      manifest.machine.artifacts = artifacts;
      await writeFile(rootManifest, `${JSON.stringify(manifest, null, 2)}\n`);
      source = stage;
    }
    const family = await manifests(join(source, "atyrode.code"));
    requireValue(family.length > 0, "No Code plugin manifests found");
    const dist = join(pluginRoot, "dist");
    await rm(dist, { recursive: true, force: true });
    await mkdir(dist);
    const sums: string[] = [];
    const ids = new Set<string>();
    for (const file of family) {
      const { id } = JSON.parse(await readFile(file, "utf8"));
      requireValue(typeof id === "string" && /^atyrode\.code(?:\.[a-z0-9][a-z0-9_-]*)*$/.test(id) && !ids.has(id), `Invalid or duplicate Code plugin id: ${relative(source, file)}`);
      ids.add(id);
      const filename = `${id}.manifold-plugin.json`;
      const result = await packPlugin(dirname(file), join(dist, filename));
      sums.push(`${result.sha256}  ${filename}`);
    }
    const checksums = `${sums.join("\n")}\n`;
    await writeFile(join(dist, "SHA256SUMS"), checksums);
    process.stdout.write(checksums);
  } finally {
    if (stage !== undefined) await rm(stage, { recursive: true, force: true });
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "generate" && args.length === 4) {
  const [directory, repo, tag, output] = args as [string, string, string, string];
  requireValue(dirname(resolve(output)) === resolve(directory), "Write the artifact map beside its archives and checksums.txt");
  const base = releaseBase(repo, tag);
  const actual = await archiveRecords(resolve(directory));
  const records = artifactMapSchema.parse(Object.fromEntries(targets.map(({ platform, arch }) => [
    platform,
    { url: `${base}/code-machine-linux-${arch}.tar.gz`, ...actual[platform] },
  ])));
  await writeFile(output, `${JSON.stringify(records, null, 2)}\n`, { flag: "wx" });
} else if (command === "pack" && args.length === 0) {
  await pack();
} else {
  throw new Error("Usage: bun scripts/machine-artifacts.ts generate <archive-dir> <owner/repo> <v-tag> <map.json> | pack");
}
