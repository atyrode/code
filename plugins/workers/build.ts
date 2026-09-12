import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { BunPlugin } from "bun";
import { MachineArtifactSchema, type MachineArtifact, type MachineHalf } from "../../../manifold/packages/protocol/src/jobs.ts";
import runtime from "../runtime-artifacts.json";

const root = resolve(import.meta.dir, "..");
const platforms = ["linux-x64", "linux-arm64"] as const;
const entrypoints = {
  root: {
    inventory: "probe/inventory.ts",
    benchmark: "probe/benchmark.ts",
  },
  accounts: {
    broker: "broker/entry.ts",
  },
  gateway: {
    gateway: "gateway/entry.ts",
  },
} as const;
export type WorkerTarget = keyof typeof entrypoints;
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const maxEmbeddedBytes = 16 * 1024 * 1024;
const loaderSha256 = "6d46cb5c28e1ed40ae94c6019c90399b9b326f4d2b5bf944a802542147356bf8";

/** Deliberately replaces only the pinned SDK's host/cache-searching loader, not its API.
 * The owner mounts the verified native artifact at this fixed private path. No package
 * resolution, CPU probing, extraction, cache fallback, source checkout or host PATH.
 */
const pinnedLoader = `
let bindings;
export function loadNative() {
  if (bindings) return bindings;
  const module = { exports: {} };
  process.dlopen(module, "/runtime/bin/pi-natives");
  const install = module.exports.__ompInstallTokioRuntime;
  if (typeof install === "function") install();
  bindings = module.exports;
  return bindings;
}
`;

export interface WorkerArtifacts {
  /** Assign these two fields to the selected installation's staged machine half. */
  artifacts: MachineHalf["artifacts"];
  tools: NonNullable<MachineHalf["tools"]>;
  /** bundleFile members are written immediately inside outputDirectory. */
  bundleFiles: string[];
  embeddedBase64Bytes: number;
  /** External owner-provisioned native resource, intentionally not a managed artifact. */
  requiredRuntimeTools: readonly ["system"];
  systemRequirements: typeof runtime.requiredRuntimeTools.system;
}

async function packageRoot(name: string): Promise<string> {
  let directory = dirname(await realpath(Bun.resolveSync(name, root)));
  for (;;) {
    const file = Bun.file(join(directory, "package.json"));
    if (await file.exists()) {
      const manifest = await file.json();
      if (manifest.name === name) {
        if (manifest.version !== runtime.sdkVersion) throw new Error(`Pinned dependency mismatch: ${name}`);
        return directory;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Pinned package missing: ${name}`);
    directory = parent;
  }
}

/** Deterministic ustar: regular members only, fixed mode/uid/gid/mtime, no PAX,
 * host tar/gzip invocation, unbounded directory walks, links or extra files. */
function archive(files: ReadonlyMap<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name.length > 100 || name.split("/").some(part => part === ".." || part === ".")) throw new Error("Invalid archive member");
    const header = Buffer.alloc(512);
    header.write(name);
    const octal = (value: number, offset: number, length: number): void => {
      const text = value.toString(8).padStart(length - 1, "0");
      if (text.length >= length) throw new Error("Archive field overflow");
      header.write(`${text}\0`, offset, length, "ascii");
    };
    octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
    octal(bytes.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header[156] = 48;
    header.write("ustar\0", 257, "ascii"); header.write("00", 263, "ascii");
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/** Collect license/notice text from packages actually read by the bundler. */
async function notices(importedFiles: Set<string>): Promise<Buffer> {
  const visited = new Set<string>();
  const packages = new Map<string, string>();
  for (const imported of [...importedFiles].sort()) {
    let directory = dirname(imported);
    while (!visited.has(directory)) {
      visited.add(directory);
      const file = Bun.file(join(directory, "package.json"));
      if (await file.exists()) {
        const manifest = await file.json();
        if (typeof manifest.name === "string") packages.set(`${manifest.name}@${manifest.version ?? "workspace"}`, directory);
        break;
      }
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  const sections: string[] = [];
  for (const [name, directory] of [...packages].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice|third-party-notices)(?:[.-].*)?$/i.test(entry.name))
      .map(entry => entry.name).sort();
    for (const filename of entries) sections.push(`${name} / ${filename}\n${await readFile(join(directory, filename), "utf8")}`);
    if (entries.length === 0 && directory.includes("node_modules")) throw new Error(`Bundled dependency has no packaged license: ${name}`);
  }
  return Buffer.from(sections.join("\n\n------------------------------------------------------------\n\n") + "\n");
}

/** Build one installation's workers, embedding only bounded JS/notices. Large native binaries
 * stay exact, hash-pinned published resources. No runtime package installation.
 * Requires the frozen dependency install and pinned sibling Manifold checkout.
 * The packer enforces the final 16 MiB JSON budget after server/web bundling too.
 */
export async function buildWorkerArtifacts(outputDirectory: string, target: WorkerTarget): Promise<WorkerArtifacts> {
  if (Bun.version !== runtime.bunVersion) throw new Error(`Worker packaging requires pinned Bun ${runtime.bunVersion}; received ${Bun.version}`);
  await Promise.all(["@oh-my-pi/pi-ai", "@oh-my-pi/pi-catalog", "@oh-my-pi/pi-utils"].map(packageRoot));
  const nativePackage = await packageRoot("@oh-my-pi/pi-natives");
  const nativeLoader = await realpath(join(nativePackage, "native/loader-state.js"));
  if (hash(await readFile(nativeLoader)) !== loaderSha256) throw new Error("Unreviewed native SDK loader bytes");
  const out = resolve(outputDirectory);
  await mkdir(out, { recursive: true });
  const stage = await mkdtemp(join(out, ".worker-build-"));
  const artifacts: WorkerArtifacts["artifacts"] = {};
  const tools: WorkerArtifacts["tools"] = {};
  for (const [alias, layouts] of Object.entries(runtime.tools)) {
    if (target === "gateway" && alias === "omp") continue;
    if (target === "root" && alias === "pi-natives") continue;
    tools[alias] = {};
    for (const platform of platforms) tools[alias]![platform] = MachineArtifactSchema.parse(layouts[platform]);
  }
  const bundleFiles: string[] = [];
  let embeddedBase64Bytes = 0;
  try {
    for (const [name, source] of Object.entries(entrypoints[target])) {
      const importedFiles = new Set<string>();
      let usesNative = false;
      const plugin: BunPlugin = {
        name: "code-pinned-native-worker",
        setup(build) {
          build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
            const path = await realpath(args.path);
            importedFiles.add(path);
            if (path !== nativeLoader) return undefined;
            usesNative = true;
            return { contents: pinnedLoader, loader: "js" };
          });
        },
      };
      const result = await Bun.build({
        entrypoints: [join(import.meta.dir, source)], outdir: stage, naming: `${name}.js`,
        target: "bun", format: "esm", splitting: false, minify: true,
        sourcemap: "none", packages: "bundle", plugins: [plugin],
        tsconfig: join(root, "tsconfig.json"),
      });
      if (!result.success) throw new AggregateError(result.logs, `Worker bundling failed: ${name}`);
      if (result.outputs.length !== 1) throw new Error(`Undeclared worker bundle outputs: ${name}`);
      const javascript = Buffer.from(await result.outputs[0]!.arrayBuffer());
      const imports = new Bun.Transpiler({ loader: "js" }).scanImports(javascript);
      for (const item of imports) {
        if (item.path === "bun" || item.path.startsWith("bun:") || item.path.startsWith("node:") || builtinModules.includes(item.path)) continue;
        throw new Error(`Unbundled worker import: ${name}: ${item.path}`);
      }
      if (usesNative && target === "root") throw new Error(`Worker unexpectedly needs native addon: ${name}`);
      const licenses = await notices(importedFiles);
      let bytes: Buffer;
      let declaration: MachineArtifact;
      if (name === "inventory" || name === "benchmark") {
        // License comments cannot terminate early on third-party text.
        bytes = Buffer.concat([javascript, Buffer.from(`\n/*\n${licenses.toString("utf8").replaceAll("*/", "* /")}\n*/\n`)]);
        const filename = `code-${name}.js`;
        declaration = { bundleFile: filename, sha256: hash(bytes), format: "raw", entry: [filename], entrySha256: hash(bytes), maxBytes: bytes.length, maxExpandedBytes: bytes.length, maxMembers: 1 };
      } else {
        const members = new Map([[`${name}.js`, javascript], ["licenses/THIRD-PARTY-NOTICES.txt", licenses]]);
        bytes = archive(members);
        declaration = {
          bundleFile: `code-${name}.tar.gz`, sha256: hash(bytes), format: "tar.gz", entry: [`${name}.js`], entrySha256: hash(javascript),
          maxBytes: bytes.length, maxExpandedBytes: 2048 + Math.ceil(javascript.length / 512) * 512 + Math.ceil(licenses.length / 512) * 512, maxMembers: members.size,
          files: { [`${name}-notices`]: { entry: ["licenses", "THIRD-PARTY-NOTICES.txt"], sha256: hash(licenses), relativeTarget: [`${name}-licenses`, "THIRD-PARTY-NOTICES.txt"] } },
        };
      }
      declaration = MachineArtifactSchema.parse(declaration);
      embeddedBase64Bytes += 4 * Math.ceil(bytes.length / 3);
      if (embeddedBase64Bytes > maxEmbeddedBytes) throw new Error(`Bundled worker members require ${embeddedBase64Bytes} base64 bytes; native plugin aggregate limit is ${maxEmbeddedBytes}. Publish these exact worker archives before distribution; no worker release URL is assumed.`);
      await writeFile(join(out, declaration.bundleFile!), bytes);
      bundleFiles.push(declaration.bundleFile!);
      const layouts = Object.fromEntries(platforms.map(platform => [platform, declaration]));
      if (name === "inventory" || name === "broker" || name === "gateway") Object.assign(artifacts, layouts);
      else tools[name] = layouts;
    }
    if (Object.keys(tools).length > 8) throw new Error("Too many native tool maps");
    for (const filename of bundleFiles) if (!(await stat(join(out, filename))).isFile()) throw new Error("Worker artifact is not a regular file");
    return { artifacts, tools, bundleFiles, embeddedBase64Bytes, requiredRuntimeTools: ["system"], systemRequirements: runtime.requiredRuntimeTools.system };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const target = process.argv[2];
  const output = process.argv[3];
  if ((target !== "root" && target !== "accounts" && target !== "gateway") || !output || process.argv.length !== 4) throw new Error("Usage: bun plugins/workers/build.ts <root|accounts|gateway> <output-directory>");
  const result = await buildWorkerArtifacts(output, target);
  await writeFile(join(resolve(output), "worker-artifacts.json"), `${JSON.stringify(result, null, 2)}\n`);
}
