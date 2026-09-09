import { Console } from "node:console";
import { writeSync } from "node:fs";
import { openWorkerContext, type WorkerContext } from "@manifold/sdk/worker";
import { BenchmarkReceiptSchema, InventoryReceiptSchema, ProbeError, ProbeFailureReceiptSchema } from "../../domain/probe.ts";
import { isolateProbeEnvironment, prepareProbeInputs } from "./inputs.ts";
import { benchmarkTarget, inventoryTarget, PROBE_OUTPUT_LIMIT } from "./runtime.ts";

/** Called only by the two separate manifest-fixed entrypoint modules. */
export async function runProbe(kind: "inventory" | "benchmark"): Promise<never> {
  isolateProbeEnvironment(process.env);
  const silentWrite = (...args: unknown[]): boolean => {
    const callback = args.at(-1);
    if (typeof callback === "function") queueMicrotask(() => callback());
    return true;
  };
  process.stdout.write = silentWrite;
  process.stderr.write = silentWrite;
  globalThis.console = Object.assign(new Console({ stdout: process.stdout, stderr: process.stderr }), { write: () => 0 });
  let context: WorkerContext | undefined;
  let emitted = false;
  let success = false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new ProbeError("timeout")), 10 * 60 * 1000);
  const cancel = (): void => controller.abort(new ProbeError("cancelled"));
  const emit = (value: unknown): void => {
    if (emitted) return;
    const parsed = InventoryReceiptSchema.or(BenchmarkReceiptSchema).or(ProbeFailureReceiptSchema).safeParse(value);
    if (!parsed.success) throw new ProbeError("invalid_observation");
    const bytes = Buffer.from(`${JSON.stringify(parsed.data)}\n`);
    if (bytes.length > PROBE_OUTPUT_LIMIT) throw new ProbeError("output_limit");
    emitted = true;
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(1, bytes, offset, bytes.length - offset);
  };
  const fatal = (): never => {
    controller.abort(new ProbeError("target_failed"));
    try { emit({ schemaVersion: 1, kind: "refused", code: "target_failed" }); } catch {}
    context?.close();
    process.exit(1);
  };
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  try {
    context = openWorkerContext({ signal: controller.signal });
    await context.ready;
    if (context.signal.aborted) throw new ProbeError("cancelled");
    const input = prepareProbeInputs(kind);
    const result = kind === "inventory" ? await inventoryTarget(input.identities, context.signal) : await benchmarkTarget(input.benchmark!, context.signal);
    if (context.signal.aborted) throw new ProbeError("cancelled");
    emit(result);
    success = true;
  } catch (error) {
    const code = controller.signal.reason instanceof ProbeError ? controller.signal.reason.code :
      context?.signal.aborted ? "cancelled" : error instanceof ProbeError ? error.code : "target_failed";
    emit({ schemaVersion: 1, kind: "refused", code });
  } finally {
    clearTimeout(timeout);
    context?.close();
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  }
  process.exit(success ? 0 : 1);
}
