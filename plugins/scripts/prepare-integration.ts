#!/usr/bin/env bun
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

const pluginRoot = resolve(import.meta.dir, "..");
const repository = "https://github.com/atyrode/manifold-omp.git";
const packageJSON = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8")) as { dependencies?: Record<string, unknown> };
const dependency = packageJSON.dependencies?.["@atyrode/manifold-omp"];
if (typeof dependency !== "string") throw new Error("Code verification requires its explicit OMP client dependency");
const match = /^github:atyrode\/manifold-omp#([a-f0-9]{40})$/.exec(dependency);
if (!match) throw new Error("Code's OMP client must pin one published Git commit");
const revision = match[1]!;
const manifoldRevision = (await readFile(join(pluginRoot, "MANIFOLD_REV"), "utf8")).trim();
const manifold = await realpath(resolve(pluginRoot, "../../manifold"));
const root = join(pluginRoot, ".integration");
const snapshot = join(root, revision);
const source = join(snapshot, "omp");

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const [status, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (status !== 0) throw new Error(`OMP integration preparation failed: ${command[0]} ${command[1]}`);
  return output.trim();
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

if (await run(["git", "rev-parse", "HEAD"], manifold) !== manifoldRevision) throw new Error("Code's SDK checkout does not match MANIFOLD_REV");
await mkdir(snapshot, { recursive: true });
if (!await exists(source)) {
  await run(["git", "init", "--quiet", source], snapshot);
  await run(["git", "fetch", "--quiet", "--depth=1", repository, revision], source);
  await run(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], source);
}
if (await run(["git", "rev-parse", "HEAD"], source) !== revision) throw new Error("OMP's prepared source does not match the client pin");
await run(["git", "diff", "--quiet", "HEAD", "--"], source);
if ((await readFile(join(source, "plugins/MANIFOLD_REV"), "utf8")).trim() !== manifoldRevision) throw new Error("Code and its OMP dependency must verify against the same native SDK");
const sdkLink = join(snapshot, "manifold");
if (await exists(sdkLink)) {
  if (await realpath(sdkLink) !== manifold) throw new Error("The prepared OMP SDK link belongs to another checkout");
} else await symlink(manifold, sdkLink, "dir");
const upstream = join(source, "plugins");
await run([process.execPath, "install", "--frozen-lockfile"], upstream);
await run([process.execPath, "--no-env-file", "run", "deps:prepare"], upstream);
await run([process.execPath, "--no-env-file", "run", "pack"], upstream);

// The pointer is ours; neither an unrelated directory nor an external symlink is
// replaced. Consumers only see a snapshot after the upstream packer has succeeded.
const current = join(root, "omp");
if (await exists(current)) {
  if (!(await lstat(current)).isSymbolicLink() || !/^[a-f0-9]{40}\/omp$/.test(await readlink(current))) throw new Error("The OMP fixture pointer is not owned by this preparation command");
}
const pending = join(root, `.omp-${crypto.randomUUID()}`);
try {
  await symlink(`${revision}/omp`, pending, "dir");
  await rename(pending, current);
} finally {
  await rm(pending, { force: true });
}
console.log(`Prepared real OMP bundles from ${revision}; no daemon, credentials or native service configuration installed.`);
