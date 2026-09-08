import { ProbeError, parseBenchmarkObservation, parseInventoryObservation, parseOmpVersion, probeAddress, type BenchmarkInput, type BenchmarkReceipt, type InventoryReceipt, type ProbeIdentity } from "../../domain/probe.ts";
import { PROBE_HOME, probeChildEnvironment } from "./inputs.ts";

export const PROBE_OUTPUT_LIMIT = 4 * 1024 * 1024;
const fixedBenchmarkArgs = ["--json", "--runs", "1", "--max-tokens", "4", "--profile", "chat", "--prompt", "Reply with the single word: ok"];
// Private implementation, never an argv/cwd/env API or caller-selected command.
async function capture(kind: "version" | "inventory" | "benchmark", signal: AbortSignal, input?: BenchmarkInput): Promise<string> {
  if (signal.aborted) throw new ProbeError("cancelled");
  const args = kind === "version" ? ["--version"] : kind === "inventory" ? ["models", "--json", "--no-extensions"] :
    ["bench", ...input!.candidates.map(probeAddress), ...fixedBenchmarkArgs];
  const child = Bun.spawn(["/runtime/bin/omp", ...args], {
    cwd: `${PROBE_HOME}/work`, env: probeChildEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true,
  });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let overflow = false;
  const stop = (): void => {
    // Known child-created session, not a caller-selected process. Kill descendants
    // that still own the private stdout pipe, as well as the CLI itself.
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  const reader = child.stdout.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > PROBE_OUTPUT_LIMIT - bytes) { overflow = true; stop(); break; }
      chunks.push(chunk.value); bytes += chunk.value.byteLength;
    }
    const exit = await child.exited;
    if (signal.aborted) throw new ProbeError("cancelled");
    if (overflow) throw new ProbeError("output_limit");
    // Bench exits 1 for reported failed candidates; its strict report remains
    // useful. Signals, unknown exits, and non-benchmark failures are not receipts.
    if (exit !== 0 && !(kind === "benchmark" && exit === 1)) throw new ProbeError("target_failed");
    const buffer = Buffer.concat(chunks, bytes);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    finally { buffer.fill(0); }
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await child.exited;
    for (const chunk of chunks) chunk.fill(0);
  }
}
function json(raw: string): unknown {
  try { return JSON.parse(raw); } catch { throw new ProbeError("invalid_observation"); }
}
export async function inventoryTarget(identities: ProbeIdentity[], signal: AbortSignal): Promise<InventoryReceipt> {
  const version = parseOmpVersion(await capture("version", signal));
  const raw = await capture("inventory", signal);
  return parseInventoryObservation(json(raw), identities, Date.now(), version);
}
export async function benchmarkTarget(input: BenchmarkInput, signal: AbortSignal): Promise<BenchmarkReceipt> {
  parseOmpVersion(await capture("version", signal));
  const startedAt = Date.now();
  const raw = await capture("benchmark", signal, input);
  return parseBenchmarkObservation(json(raw), input, startedAt, Date.now());
}
