import type { Readable } from "node:stream";

export const CONTROL_FRAME_BYTES = 16 * 1024;
export const ENROLLMENT_TIMEOUT_MS = 5 * 60 * 1000;
export type RefusalCode =
  | "invalid_control" | "stale_response" | "cancelled" | "disconnected" | "timeout"
  | "provider_unavailable" | "flow_unsupported" | "api_key_unsupported"
  | "prompt_unsupported" | "unsafe_auth_metadata" | "invalid_callback"
  | "credential_unsupported" | "enrollment_failed" | "upload_failed" | "service_unavailable";

export class EnrollmentRefusal extends Error {
  constructor(readonly code: RefusalCode) {
    super(code);
  }
}

export type EnrollmentEvent =
  | { type: "auth"; url: string; instructions: string; challenge?: string }
  | { type: "prompt"; promptId: string; kind: "oauth_callback"; message: string }
  | { type: "prompt_closed"; promptId: string }
  | { type: "complete"; provider: string; identity: { type: "oauth"; email?: string; accountId?: string; orgId?: string; orgName?: string } }
  | { type: "refused"; code: RefusalCode };

/** Newline-delimited UTF-8; never accumulate an unbounded line or decode partial characters. */
export class ControlFrames {
  #pending: Buffer;
  #length = 0;
  #decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(readonly receive: (frame: unknown) => void, maxBytes = CONTROL_FRAME_BYTES - 1) {
    this.#pending = Buffer.alloc(maxBytes);
  }

  push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      const count = end - offset;
      if (this.#length + count > this.#pending.length) throw new EnrollmentRefusal("invalid_control");
      this.#pending.set(chunk.subarray(offset, end), this.#length);
      this.#length += count;
      if (newline === -1) return;
      try {
        const frame: unknown = JSON.parse(this.#decoder.decode(this.#pending.subarray(0, this.#length)));
        this.receive(frame);
      } catch (error) {
        if (error instanceof EnrollmentRefusal) throw error;
        throw new EnrollmentRefusal("invalid_control");
      } finally {
        this.#pending.fill(0, 0, this.#length);
        this.#length = 0;
      }
      offset = newline + 1;
    }
  }

  clear(): void {
    this.#pending.fill(0);
    this.#length = 0;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

/** One invocation, one start, one outstanding one-use callback request. No replay queue. */
export class EnrollmentControl {
  readonly abort = new AbortController();
  readonly signal = this.abort.signal;
  readonly started = Promise.withResolvers<string>();
  #didStart = false;
  #finished = false;
  #prompt: { id: string; resolve: (value: string) => void; reject: (error: Error) => void; cleanup: () => void } | undefined;
  #promptCount = 0;
  #timer: NodeJS.Timeout;

  constructor(readonly emit: (event: EnrollmentEvent) => void, timeoutMs = ENROLLMENT_TIMEOUT_MS) {
    this.#timer = setTimeout(() => this.cancel("timeout"), timeoutMs);
    // A disconnect can precede consumption of the start promise.
    void this.started.promise.catch(() => undefined);
  }

  receive(frame: unknown): void {
    if (this.#finished || this.signal.aborted) return;
    if (!record(frame)) return this.cancel("invalid_control");
    if (frame.type === "cancel" && fields(frame, ["type"])) return this.cancel("cancelled");
    if (frame.type === "start" && fields(frame, ["type", "provider"])) {
      if (this.#didStart || typeof frame.provider !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(frame.provider)) {
        return this.cancel("invalid_control");
      }
      this.#didStart = true;
      this.started.resolve(frame.provider);
      return;
    }
    if (frame.type === "response" && fields(frame, ["type", "promptId", "value"])) {
      const prompt = this.#prompt;
      if (!prompt || frame.promptId !== prompt.id) return this.cancel("stale_response");
      if (typeof frame.value !== "string" || Buffer.byteLength(frame.value) > 8192) return this.cancel("invalid_callback");
      this.#prompt = undefined;
      prompt.cleanup();
      this.emit({ type: "prompt_closed", promptId: prompt.id });
      prompt.resolve(frame.value);
      return;
    }
    this.cancel("invalid_control");
  }

  requestCallback(signal?: AbortSignal): Promise<string> {
    this.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (this.#prompt || ++this.#promptCount > 16) throw new EnrollmentRefusal("invalid_control");
    const id = crypto.randomUUID();
    const answer = Promise.withResolvers<string>();
    const onAbort = (): void => {
      if (this.#prompt?.id !== id) return;
      this.#prompt = undefined;
      cleanup();
      this.emit({ type: "prompt_closed", promptId: id });
      answer.reject(new EnrollmentRefusal("cancelled"));
    };
    const cleanup = (): void => {
      this.signal.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", onAbort);
    };
    this.#prompt = { id, resolve: answer.resolve, reject: answer.reject, cleanup };
    this.signal.addEventListener("abort", onAbort, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    this.emit({ type: "prompt", promptId: id, kind: "oauth_callback", message: "Paste the final redirect URL, callback query, or code#state supplied by the provider. State is required." });
    return answer.promise;
  }

  cancel(code: RefusalCode): void {
    if (this.#finished || this.signal.aborted) return;
    const error = new EnrollmentRefusal(code);
    this.abort.abort(error);
    this.started.reject(error);
  }

  finish(): void {
    this.#finished = true;
    clearTimeout(this.#timer);
    if (this.#prompt) {
      const prompt = this.#prompt;
      this.#prompt = undefined;
      prompt.cleanup();
      this.emit({ type: "prompt_closed", promptId: prompt.id });
      prompt.reject(new EnrollmentRefusal("cancelled"));
    }
  }
}

export function attachControlInput(input: Readable, control: EnrollmentControl): () => void {
  const frames = new ControlFrames(frame => control.receive(frame));
  const onData = (chunk: Buffer): void => {
    try { frames.push(chunk); } catch { control.cancel("invalid_control"); }
  };
  const onEnd = (): void => { frames.clear(); control.cancel("disconnected"); };
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onEnd);
  input.on("error", onEnd);
  return () => {
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", onEnd);
    input.off("error", onEnd);
    input.pause();
    frames.clear();
  };
}
