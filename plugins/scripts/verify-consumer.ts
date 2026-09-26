import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const sdk = await realpath(resolve(repository, "../manifold"));
const root = await mkdtemp(join(tmpdir(), "manifold-code-consumer-"));

async function run(args: string[], cwd: string): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Code consumer ${args[0]} exited ${code}`);
}

try {
  await run(["pm", "pack", "--destination", root], repository);
  const archives = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("Code consumer package archive is ambiguous");
  await writeFile(join(root, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: { "@atyrode/manifold-code": `file:${join(root, archives[0]!)}` },
  }));
  // The consumer supplies its own Manifold SDK; Code and OMP must come only from the package.
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: { paths: { "@manifold/*": [join(sdk, "packages/*/src/index.ts")] } },
  }));
  await writeFile(join(root, "consumer.ts"), `
import { actionSchemas } from "@atyrode/manifold-code";
const ordinary = {
  containerId: "consumer-container", machineId: "consumer-machine",
  expectedRevision: 1, prompt: "Use the explicitly authorized Run",
};
const selected = actionSchemas.runSession.input.parse({ ...ordinary, agentTools: { runId: "consumer-run" } });
if (selected.agentTools?.runId !== "consumer-run") throw new Error("public selector lost");
if (actionSchemas.runSession.input.parse(ordinary).agentTools !== undefined)
  throw new Error("public default acquired tools");
if (actionSchemas.runSession.input.safeParse({
  ...ordinary, agentTools: { runId: "consumer-run", tools: ["ungranted"] },
}).success) throw new Error("public selector accepted self-grants");
console.log("PASS: isolated packed Code consumer selects only the existing Run and preserves default-off");
`);
  await run(["install", "--ignore-scripts", "--no-progress"], root);
  await run(["--no-env-file", "--no-install", "consumer.ts"], root);
} finally {
  await rm(root, { recursive: true, force: true });
}
