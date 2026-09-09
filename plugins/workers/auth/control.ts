import type { Readable } from "node:stream";
import { attachWorkerInput } from "@manifold/sdk/worker";

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
  | { type: "started"; provider: string }
  | { type: "auth"; url: string; instructions: string; challenge?: string }
  | { type: "prompt"; promptId: string; kind: "oauth_callback"; message: string }
  | { type: "prompt_closed"; promptId: string }
  | { type: "complete"; provider: string; identity: { type: "oauth"; email?: string; accountId?: string; orgId?: string; orgName?: string } }
  | { type: "refused"; code: RefusalCode };

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

  constructor(readonly emit: (event: EnrollmentEvent) => void, timeoutMs = ENROLLMENT_TIMEOUT_MS, readonly sealedProvider?: string) {
    this.#timer = setTimeout(() => this.cancel("timeout"), timeoutMs);
    // A disconnect can precede consumption of the start promise.
    void this.started.promise.catch(() => undefined);
  }

  receive(frame: unknown): void {
    if (this.#finished || this.signal.aborted) return;
    if (!record(frame)) return this.cancel("invalid_control");
    if (frame.type === "cancel" && fields(frame, ["type"])) return this.cancel("cancelled");
    if (frame.type === "start" && fields(frame, ["type", "provider"])) {
      if (this.#didStart || typeof frame.provider !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(frame.provider) ||
        (this.sealedProvider !== undefined && frame.provider !== this.sealedProvider)) {
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
  return attachWorkerInput({
    input,
    signal: control.signal,
    maxFrameBytes: CONTROL_FRAME_BYTES,
    parse: value => value,
    receive: frame => control.receive(frame),
    onClose: error => control.cancel(
      error.code === "worker_input_closed" || error.code === "worker_disconnected" ? "disconnected"
        : error.code === "worker_cancelled" ? "cancelled" : "invalid_control",
    ),
  });
}
