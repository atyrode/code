import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";

const SDK_VERSION = "18.1.14";
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 9; // Native artifact primary entry plus at most eight companions.

/** Build-time helper, never shipped as an operator-visible executable.
 * Call after `bun install --frozen-lockfile --ignore-scripts` with Bun >=1.3.14.
 * It does not install packages, fetch credentials, run providers, or use host OMP.
 */
export async function buildAuthWorker(outputDirectory: string): Promise<void> {
  const version = Bun.version.split(".").map(Number);
  if ((version[0] ?? 0) < 1 || (version[0] === 1 && ((version[1] ?? 0) < 3 || (version[1] === 3 && (version[2] ?? 0) < 14)))) {
    throw new Error("Auth worker requires Bun >=1.3.14");
  }
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("Auth worker artifacts require a Linux x64/arm64 build host");
  const root = resolve(import.meta.dir, "../..");
  const resolvePackage = async (name: string): Promise<string> => {
    const entry = Bun.resolveSync(name, root);
    let directory = dirname(entry);
    for (let depth = 0; depth < 5; depth++) {
      const path = join(directory, "package.json");
      if (await Bun.file(path).exists()) {
        const manifest: unknown = await Bun.file(path).json();
        if (manifest && typeof manifest === "object" && Reflect.get(manifest, "name") === name) {
          if (Reflect.get(manifest, "version") !== SDK_VERSION) throw new Error(`Pinned dependency mismatch: ${name}`);
          return directory;
        }
      }
      directory = dirname(directory);
    }
    throw new Error(`Pinned dependency package missing: ${name}`);
  };
  await Promise.all(["@oh-my-pi/pi-ai", "@oh-my-pi/pi-catalog", "@oh-my-pi/pi-utils"].map(resolvePackage));
  const nativePackage = await resolvePackage("@oh-my-pi/pi-natives");
  const tag = `linux-${process.arch}`;
  const leaf = await resolvePackage(`@oh-my-pi/pi-natives-${tag}`);
  const addonName = process.arch === "x64" ? `pi_natives.${tag}-baseline.node` : `pi_natives.${tag}.node`;
  const addon = join(leaf, addonName);
  if (!(await stat(addon)).isFile()) throw new Error("Pinned native addon missing");

  const out = resolve(outputDirectory);
  await mkdir(out, { recursive: true });
  // Only a helper-created staging directory is ever recursively removed.
  const stage = await mkdtemp(join(out, ".auth-build-"));
  try {
    const nativeImports = new Set<string>();
    const nativePlugin: BunPlugin = {
      name: "auth-worker-native-assets",
      setup(build) {
        build.onResolve({ filter: /^@oh-my-pi\/pi-natives(?:\/[^/]+)?$/ }, args => {
          const subpath = args.path.slice("@oh-my-pi/pi-natives".length).replace(/^\//, "") || "index";
          if (!["index", "clipboard", "desktop", "vcs"].includes(subpath)) throw new Error("Unreviewed native SDK entrypoint");
          nativeImports.add(subpath);
          return { path: `./native/${subpath}.js`, external: true };
        });
      },
    };
    const result = await Bun.build({
      entrypoints: [join(import.meta.dir, "entry.ts")], outdir: stage,
      naming: "auth-worker.js", target: "bun", format: "esm", splitting: false,
      minify: true, sourcemap: "none", packages: "bundle", plugins: [nativePlugin],
    });
    if (!result.success) throw new AggregateError(result.logs, "Auth worker bundling failed");
    for (const subpath of nativeImports) {
      const nativeResult = await Bun.build({
        entrypoints: [join(nativePackage, "native", `${subpath}.js`)],
        outdir: join(stage, "native"), naming: `${subpath}.js`, target: "bun", format: "esm",
        splitting: false, minify: true, sourcemap: "none", packages: "bundle",
      });
      if (!nativeResult.success) throw new AggregateError(nativeResult.logs, "Native loader bundling failed");
    }
    await mkdir(join(stage, "native"), { recursive: true });
    await copyFile(addon, join(stage, "native", addonName));
    await copyFile(join(leaf, "LICENSE"), join(stage, "LICENSE"));
    await copyFile(join(leaf, "THIRD-PARTY-NOTICES.txt"), join(stage, "THIRD-PARTY-NOTICES.txt"));
    const files: { path: string; bytes: number; sha256: string }[] = [];
    let expandedBytes = 0;
    for (const relative of await readdir(stage, { recursive: true })) {
      const path = join(stage, relative);
      const metadata = await stat(path);
      if (!metadata.isFile()) continue;
      expandedBytes += metadata.size;
      if (expandedBytes > MAX_EXPANDED_BYTES || files.length >= MAX_FILES) throw new Error("Auth worker artifact exceeds native resource limits");
      const digest = createHash("sha256");
      for await (const chunk of Bun.file(path).stream()) digest.update(chunk);
      files.push({ path: relative, bytes: metadata.size, sha256: digest.digest("hex") });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    // One declared archive, one JS entry, bounded hash-pinned companion files.
    // No unbound npm imports or host native-addon dependencies are shipped.
    const archivePath = join(out, `auth-worker-${tag}.tar.gz`);
    const tar = Bun.spawn(["tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf", archivePath, "-C", stage, ...files.map(file => file.path)], { stdout: "ignore", stderr: "ignore" });
    if (await tar.exited !== 0) throw new Error("Auth worker archive creation failed");
    const archive = Bun.file(archivePath);
    if (archive.size > MAX_ARCHIVE_BYTES) throw new Error("Auth worker archive exceeds native archive limit");
    const archiveDigest = createHash("sha256");
    for await (const chunk of archive.stream()) archiveDigest.update(chunk);
    await Bun.write(join(out, `auth-worker-${tag}.artifact.json`), JSON.stringify({
      sdkVersion: SDK_VERSION, platform: "linux", arch: process.arch, runtime: { name: "bun", minimumVersion: "1.3.14" },
      entry: "auth-worker.js", files, expandedBytes,
      archive: { file: `auth-worker-${tag}.tar.gz`, bytes: archive.size, sha256: archiveDigest.digest("hex") },
      // Inline PluginBundle has a 16MiB aggregate base64/JSON limit; reserve 1MiB
      // for manifests and Code's other payloads. Otherwise declare hash-pinned HTTPS.
      inlinePluginBundleCandidate: Math.ceil(archive.size / 3) * 4 <= 15 * 1024 * 1024,
    }, null, 2) + "\n");
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const output = process.argv[2];
  if (!output || process.argv.length !== 3) throw new Error("Build helper requires one output directory");
  await buildAuthWorker(output);
}
