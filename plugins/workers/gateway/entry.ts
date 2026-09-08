import { Console } from "node:console";
import { writeSync } from "node:fs";
import { GatewayContext } from "./context.ts";
import { isolateEnvironment, parseInputs, readSealedJSON, requirePrivateInputRoot } from "./inputs.ts";
import type { PoolGateway } from "./runtime.ts";

// Entrypoint imports above contain no SDK. Install output/error containment
// before loading provider/native modules or touching the three sealed inputs.
isolateEnvironment(process.env);
const silentWrite = (...args: unknown[]): boolean => {
  const callback = args.at(-1);
  if (typeof callback === "function") queueMicrotask(() => callback());
  return true;
};
process.stdout.write = silentWrite;
process.stderr.write = silentWrite;
// Bun's built-in console need not route through process.stdout.write.
globalThis.console = new Console({ stdout: process.stdout, stderr: process.stderr });
let context: GatewayContext | undefined;
let service: PoolGateway | undefined;
let failed = false;
const stop = (): void => { context?.close(); };
const fatal = (): never => {
  stop();
  void service?.close();
  writeSync(2, "gateway_unavailable\n");
  process.exit(1);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
try {
  context = GatewayContext.open(process.env.MANIFOLD_JOB_CONTEXT_FD);
  await context.ready.promise;
  requirePrivateInputRoot();
  const logger = await import("@oh-my-pi/pi-utils/logger");
  logger.setTransports({ file: false, console: false });
  const inputs = parseInputs(readSealedJSON("/inputs/broker"), readSealedJSON("/inputs/accountPool"), readSealedJSON("/inputs/serviceBearer"));
  const { startPoolGateway } = await import("./runtime.ts");
  service = await startPoolGateway(inputs, context.controller.signal);
  await context.announce(service.port);
  if (!context.controller.signal.aborted) await new Promise<void>(resolve => context!.controller.signal.addEventListener("abort", () => resolve(), { once: true }));
} catch {
  failed = true;
  writeSync(2, "gateway_unavailable\n");
} finally {
  context?.close();
  await service?.close();
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
}
// Native Manifold also kills the complete service process tree. No SDK sleep,
// provider request or rejected cleanup continuation may keep this instance alive.
process.exit(failed ? 1 : 0);
