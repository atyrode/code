import { Console } from "node:console";
import { writeSync } from "node:fs";
import { openWorkerContext, type WorkerContext } from "@manifold/sdk/worker";
import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { AuthBrokerServerHandle } from "@oh-my-pi/pi-ai/auth-broker/server";
import { isolateEnvironment, readBrokerInputs } from "./inputs.ts";

// No upstream runtime imports before the gateway's output/error containment.
isolateEnvironment(process.env);
const silentWrite = (...args: unknown[]): boolean => {
  const callback = args.at(-1);
  if (typeof callback === "function") queueMicrotask(() => callback());
  return true;
};
process.stdout.write = silentWrite;
process.stderr.write = silentWrite;
globalThis.console = Object.assign(new Console({ stdout: process.stdout, stderr: process.stderr }), { write: () => 0 });
let context: WorkerContext | undefined;
let storage: AuthStorage | undefined;
let broker: AuthBrokerServerHandle | undefined;
let failed = false;
const shutdown = new AbortController();
const stop = (): void => { shutdown.abort(); };
const fail = (): void => {
  if (!failed) writeSync(2, "broker_unavailable\n");
  failed = true;
};
const fatal = (): void => { fail(); stop(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
try {
  context = openWorkerContext();
  await context.ready;
  context.signal.addEventListener("abort", stop, { once: true });
  if (context.signal.aborted) stop();
  shutdown.signal.throwIfAborted();
  const { serviceBearer, clientAccess } = readBrokerInputs();
  // pi-utils eagerly loads home/config/agent/project .env files. Bootstrap in
  // the sealed input root, never in the persistent OMP store or a host project.
  process.chdir("/inputs");
  const logger = await import("@oh-my-pi/pi-utils/logger");
  logger.setTransports({ file: false, console: false });
  const { AuthStorage } = await import("@oh-my-pi/pi-ai/auth-storage");
  const { startAuthBroker } = await import("@oh-my-pi/pi-ai/auth-broker/server");
  const { getAgentDbPath, setAgentDir } = await import("@oh-my-pi/pi-utils/dirs");
  shutdown.signal.throwIfAborted();
  // The owner's ordinary OMP terminal uses this same default-profile mapping.
  // setAgentDir rebuilds the SDK resolver without reloading dotenv or discovery.
  process.env.HOME = "/home/job";
  process.env.PI_CONFIG_DIR = "omp";
  setAgentDir("/home/job/omp/agent");
  storage = await AuthStorage.create(getAgentDbPath());
  shutdown.signal.throwIfAborted();
  await storage.reload();
  shutdown.signal.throwIfAborted();
  // OMP owns endpoints, cross-process SQLite polling and background refresh.
  broker = startAuthBroker({
    storage,
    bind: clientAccess?.bind ?? "127.0.0.1:0",
    bearerTokens: [serviceBearer],
    ...(clientAccess ? { bearerTokenHashes: [clientAccess.bearerSha256] } : {}),
    controlBearerToken: serviceBearer,
  });
  await context.announceServiceReady(broker.port);
  if (!shutdown.signal.aborted) await new Promise<void>(resolve => shutdown.signal.addEventListener("abort", () => resolve(), { once: true }));
} catch {
  if (!shutdown.signal.aborted) fail();
} finally {
  try { await broker?.close(); } catch { fail(); }
  try { await storage?.drainRefreshes(); } catch { fail(); }
  try { storage?.close(); } catch { fail(); }
  context?.signal.removeEventListener("abort", stop);
  // Closing the native context can immediately terminate the job cgroup.
  // It must be the last lifecycle action, after every owned refresh and write.
  context?.close();
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
}
// Only terminate after the broker has drained its admitted mutations.
process.exit(failed ? 1 : 0);
