#!/usr/bin/env bun
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Preparation owns exact source/dependency checkout. The upstream launcher owns
// credential isolation, delegated cgroups, private hub/native owner and cleanup.
// Never copy its bootstrap here or fall back to another installed OMP runtime.
try {
  if (process.argv.length !== 2) throw new Error("unexpected-arguments");
  const plugins = resolve(import.meta.dir, "..");
  const manifest = JSON.parse(await readFile(join(plugins, "package.json"), "utf8")) as { dependencies?: Record<string, unknown> };
  const dependency = manifest.dependencies?.["@atyrode/manifold-omp"];
  const revision = typeof dependency === "string" ? /^github:atyrode\/manifold-omp#([a-f0-9]{40})$/.exec(dependency)?.[1] : undefined;
  if (!revision) throw new Error("unpinned-omp");
  const source = await realpath(join(plugins, ".integration/omp"));
  if (source !== await realpath(join(plugins, ".integration", revision, "omp"))) throw new Error("unprepared-omp");
  process.env.OMP_VERIFY_CONSUMER_MODULE = resolve(import.meta.dir, "native-tool-consumer.ts");
  // The exact prepared Git source selects the launcher at runtime. Import it in
  // this process so its existing isolation/cleanup owns every child directly.
  await import(pathToFileURL(join(source, "plugins/scripts/verify.ts")).href);
  if (process.exitCode) throw new Error("composed-native-proof-failed");
  console.log(JSON.stringify({ ok: true, family: "atyrode.code", verification: "code-omp-native-model-tools" }));
} catch {
  // Raw failures may include filesystem or native-owner details. Only fixed
  // verifier receipts are public; the upstream launcher reports its safe phase.
  console.log(JSON.stringify({ ok: false, code: "code-native-proof-failed" }));
  process.exitCode = 1;
}
