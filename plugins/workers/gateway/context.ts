import { fstatSync } from "node:fs";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { unavailable } from "./inputs.ts";

const FRAME_LIMIT = 128 * 1024;

/** Only the native-owned Unix socket can authorize readiness and own lifetime. */
export class GatewayContext {
  readonly controller = new AbortController();
  readonly ready = Promise.withResolvers<void>();
  #buffer = Buffer.alloc(0);
  #received = false;
  #announced = false;
  #closed = false;
  constructor(readonly socket: Duplex) {
    void this.ready.promise.catch(() => undefined);
    socket.on("data", this.#data);
    socket.on("end", this.#disconnect);
    socket.on("close", this.#disconnect);
    socket.on("error", this.#disconnect);
  }
  static open(rawFd: string | undefined): GatewayContext {
    if (!rawFd || !/^[0-9]{1,9}$/.test(rawFd)) throw unavailable();
    const fd = Number(rawFd);
    if (fd < 3 || !fstatSync(fd).isSocket()) throw unavailable();
    return new GatewayContext(new Socket({ fd, readable: true, writable: true }));
  }
  readonly #disconnect = (): void => this.close();
  readonly #data = (chunk: Buffer): void => {
    try {
      if (this.#received || this.#buffer.length + chunk.length > FRAME_LIMIT) throw unavailable();
      const previous = this.#buffer;
      this.#buffer = Buffer.concat([previous, chunk]);
      previous.fill(0);
      const newline = this.#buffer.indexOf(10);
      if (newline < 0) return;
      if (newline !== this.#buffer.length - 1) throw unavailable();
      const value = JSON.parse(this.#buffer.subarray(0, newline).toString("utf8"));
      if (!value || value.type !== "context" || Object.keys(value).some(key => !["type", "locations"].includes(key)) ||
        !Array.isArray(value.locations) || value.locations.length > 1024 || !value.locations.every((location: unknown) => {
          if (!location || typeof location !== "object" || Array.isArray(location)) return false;
          const row = location as Record<string, unknown>;
          return Object.keys(row).every(key => ["locationId", "guestPath", "access"].includes(key)) &&
            typeof row.locationId === "string" && typeof row.guestPath === "string" && typeof row.access === "string";
        })) throw unavailable();
      this.#buffer.fill(0);
      this.#buffer = Buffer.alloc(0);
      this.#received = true;
      this.ready.resolve();
    } catch { this.close(); }
  };
  async announce(port: number): Promise<void> {
    await this.ready.promise;
    this.controller.signal.throwIfAborted();
    if (this.#announced || !Number.isInteger(port) || port < 1 || port > 65535) throw unavailable();
    this.#announced = true;
    await new Promise<void>((resolve, reject) => {
      this.socket.write(JSON.stringify({ type: "service_ready", port }) + "\n", error => error ? reject(unavailable()) : resolve());
    });
    this.controller.signal.throwIfAborted();
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.controller.abort(unavailable());
    this.ready.reject(unavailable());
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    this.socket.destroy();
  }
}
