import { fstatSync } from "node:fs";
import { Socket } from "node:net";
import { ControlFrames, EnrollmentControl, EnrollmentRefusal } from "./control.ts";

const SERVICE_FRAME_BYTES = 128 * 1024;

/** This private child client names one declared operation; native owner owns all policy and credentials. */
export class EnrollmentService {
  readonly #socket: Socket;
  readonly #ready = Promise.withResolvers<void>();
  readonly #frames: ControlFrames;
  #contextReceived = false;
  #used = false;
  #closed = false;
  #pending: { id: string; resolve: (result: unknown) => void; reject: (error: Error) => void } | undefined;
  readonly #onAbort: () => void;

  constructor(fd: number, readonly control: EnrollmentControl) {
    if (!Number.isSafeInteger(fd) || fd < 3 || !fstatSync(fd).isSocket()) throw new EnrollmentRefusal("service_unavailable");
    this.#socket = new Socket({ fd, readable: true, writable: true });
    this.#onAbort = () => this.close();
    void this.#ready.promise.catch(() => undefined);
    this.#frames = new ControlFrames(frame => {
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new EnrollmentRefusal("service_unavailable");
      if (!this.#contextReceived) {
        const context = frame as Record<string, unknown>;
        if (context.type !== "context" || Object.keys(context).some(key => key !== "type" && key !== "locations") ||
          !Array.isArray(context.locations) || context.locations.length > 1024 || !context.locations.every(location =>
            location && typeof location === "object" && !Array.isArray(location) &&
            Object.keys(location).every(key => ["locationId", "guestPath", "access"].includes(key)) &&
            typeof location.locationId === "string" && typeof location.guestPath === "string" && typeof location.access === "string")) {
          throw new EnrollmentRefusal("service_unavailable");
        }
        this.#contextReceived = true;
        this.#ready.resolve();
        return;
      }
      const reply = frame as Record<string, unknown>;
      const pending = this.#pending;
      if (!pending || reply.type !== "service_result" || reply.requestId !== pending.id ||
        (reply.ok !== true && reply.ok !== false) ||
        Object.keys(reply).some(key => !["type", "requestId", "ok", reply.ok ? "result" : "refusal"].includes(key))) {
        throw new EnrollmentRefusal("service_unavailable");
      }
      this.#pending = undefined;
      if (reply.ok === true && Object.hasOwn(reply, "result")) pending.resolve(reply.result);
      else pending.reject(new EnrollmentRefusal("upload_failed"));
    }, SERVICE_FRAME_BYTES - 1);
    this.#socket.on("data", (chunk: Buffer) => {
      try { this.#frames.push(chunk); }
      catch { this.control.cancel("service_unavailable"); }
    });
    this.#socket.on("error", () => this.control.cancel("service_unavailable"));
    this.#socket.on("close", () => { if (!this.#closed) this.control.cancel("disconnected"); });
    this.#socket.on("end", () => { if (!this.#closed) this.control.cancel("disconnected"); });
    control.signal.addEventListener("abort", this.#onAbort, { once: true });
    if (control.signal.aborted) this.close();
  }

  async upload(input: Record<string, string | number | boolean>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (this.#used || this.#closed) throw new EnrollmentRefusal("service_unavailable");
    this.#used = true;
    await this.#ready.promise;
    signal.throwIfAborted();
    const requestId = crypto.randomUUID();
    const frame = Buffer.from(JSON.stringify({ type: "service", requestId, serviceId: "broker", operationId: "enroll-oauth", input }) + "\n");
    if (frame.length > SERVICE_FRAME_BYTES) { frame.fill(0); throw new EnrollmentRefusal("credential_unsupported"); }
    const reply = Promise.withResolvers<unknown>();
    this.#pending = { id: requestId, resolve: reply.resolve, reject: reply.reject };
    // The buffer stays private until consumed by the Unix stream; zero it only
    // when Node has completed the write, never while a partial write is queued.
    this.#socket.write(frame, error => {
      frame.fill(0);
      if (error) this.control.cancel("service_unavailable");
    });
    return reply.promise;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.control.signal.removeEventListener("abort", this.#onAbort);
    this.#ready.reject(new EnrollmentRefusal("service_unavailable"));
    this.#pending?.reject(new EnrollmentRefusal("upload_failed"));
    this.#pending = undefined;
    this.#frames.clear();
    this.#socket.destroy();
  }
}
