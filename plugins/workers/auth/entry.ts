import { readFileSync, writeSync } from "node:fs";
import { attachControlInput, CONTROL_FRAME_BYTES, EnrollmentControl, type EnrollmentEvent } from "./control.ts";
import { openWorkerContext, type WorkerContext } from "@manifold/sdk/worker";

// Private machine artifact only. No argv options, terminal UI, login database path,
// broker URL/token, environment credential importer, or operator CLI fallback.
const emit = (event: EnrollmentEvent): void => {
  const bytes = Buffer.from(JSON.stringify(event) + "\n");
  if (bytes.length > CONTROL_FRAME_BYTES) throw new Error("output_limit");
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(1, bytes, offset, bytes.length - offset);
};
let terminalEvent = false;
let completed = false;
const control = new EnrollmentControl(event => {
  if (event.type === "complete" || event.type === "refused") terminalEvent = true;
  if (event.type === "complete") completed = true;
  emit(event);
}, undefined, (() => {
  try {
    const provider = readFileSync("/inputs/provider", "utf8");
    if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(provider)) throw new Error("invalid_control");
    return provider;
  } catch {
    emit({ type: "refused", code: "invalid_control" });
    process.exit(1);
  }
})());
let context: WorkerContext | undefined;
const detach = attachControlInput(process.stdin, control);
const terminate = (): void => control.cancel("cancelled");
const disconnected = (): void => control.cancel("disconnected");
process.on("SIGTERM", terminate);
process.on("SIGINT", terminate);
// Never let a raw SDK exception/rejection become Bun's stderr stack output.
const fatal = (): never => {
  try {
    control.cancel("enrollment_failed");
    if (!terminalEvent) emit({ type: "refused", code: "enrollment_failed" });
  } finally { process.exit(1); }
};
process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);

try {
  delete process.env.PI_DEBUG_STARTUP;
  delete process.env.PI_TIMING;
  context = openWorkerContext({ signal: control.signal });
  context.signal.addEventListener("abort", disconnected, { once: true });
  if (context.signal.aborted) disconnected();
  await context.ready;
  // Static imports cannot work here: install fatal-error containment and disable
  // the SDK's lazy log transports before loading its native/provider graph.
  const logger = await import("@oh-my-pi/pi-utils/logger");
  logger.setTransports({ file: false, console: false });
  const { enroll } = await import("./enrollment.ts");
  await enroll(control, (input, signal) => {
    signal.throwIfAborted();
    return context!.callService({ serviceId: "broker", operationId: "enroll-oauth", input });
  });
} catch {
  if (!terminalEvent) emit({ type: "refused", code: "service_unavailable" });
} finally {
  detach();
  control.finish();
  context?.signal.removeEventListener("abort", disconnected);
  context?.close();
  process.off("SIGTERM", terminate);
  process.off("SIGINT", terminate);
}
// Hard boundary for non-cooperative SDK device sleeps/fetches and any late login
// continuation. The native job owner additionally kills the complete cgroup.
process.exit(completed ? 0 : 1);
