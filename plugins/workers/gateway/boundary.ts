import { timingSafeEqual } from "node:crypto";
import { parseRequest } from "@oh-my-pi/pi-ai/providers/pi-native-server";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { unavailable } from "./inputs.ts";

const FRAME_LIMIT = 16 * 1024 * 1024;
const encoder = new TextEncoder();
export function safeFailure(status: number): Response {
  return Response.json({ error: { type: "gateway_unavailable", message: "gateway_unavailable" } }, { status, headers: { "Cache-Control": "no-store" } });
}

/** The SDK has no server error-projection hook. This service-local pi-native
 * boundary forwards only to its fixed SDK listener, never a caller-chosen URL.
 * Successful canonical events are unchanged; failed messages cannot expose SDK
 * exception bodies, bearer-bearing request diagnostics or partial error text. */
export function safeNativeStream(body: ReadableStream<Uint8Array>, model: Model<Api>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  const failure = { type: "error", reason: "error", error: {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error", errorMessage: "gateway_unavailable", timestamp: 0,
  } };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        if (end > FRAME_LIMIT) throw unavailable();
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (!frame.startsWith("data: ")) throw unavailable();
        const data = frame.slice(6);
        if (data === "[DONE]") { controller.enqueue(encoder.encode("data: [DONE]\n\n")); continue; }
        const event = JSON.parse(data);
        if (!event || typeof event !== "object" || typeof event.type !== "string") throw unavailable();
        if (event.type === "error" || event.message?.stopReason === "error" || event.message?.stopReason === "aborted" || event.partial?.stopReason === "error" || event.partial?.stopReason === "aborted") {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(failure)}\n\ndata: [DONE]\n\n`));
          controller.terminate();
          return;
        }
        controller.enqueue(encoder.encode(frame + "\n\n"));
      }
      if (Buffer.byteLength(buffered) > FRAME_LIMIT) throw unavailable();
    },
    flush() { if (decoder.decode() || buffered.length) throw unavailable(); },
  }));
}

export interface PrivateBoundary { port: number; close(): void }
export function startPrivateBoundary(target: { url: string; bearer: string }, bearer: string, models: ReadonlyMap<string, Model<Api>>, signal: AbortSignal): PrivateBoundary {
  const expected = Buffer.from(`Bearer ${bearer}`);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 255, maxRequestBodySize: FRAME_LIMIT,
    error() { return safeFailure(503); },
    async fetch(request) {
      try {
        signal.throwIfAborted();
        const supplied = Buffer.from(request.headers.get("authorization") ?? "");
        const authorized = supplied.length === expected.length && timingSafeEqual(supplied, expected);
        supplied.fill(0);
        if (!authorized) return safeFailure(401);
        const url = new URL(request.url);
        if (url.search || url.hash) return safeFailure(404);
        const listing = request.method === "GET" && url.pathname === "/v1/models";
        if (!listing && !(request.method === "POST" && url.pathname === "/v1/pi/stream")) return safeFailure(404);
        const payload = listing ? undefined : await request.arrayBuffer();
        let model: Model<Api> | undefined;
        if (payload) {
          const parsed = parseRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)));
          model = models.get(parsed.modelId);
          if (!model) return safeFailure(404);
        }
        const requestSignal = AbortSignal.any([signal, request.signal]);
        const headers = new Headers(request.headers);
        headers.delete("host");
        headers.delete("content-length");
        // This capability protects only the fixed SDK listener. It is never a
        // provider credential and never returned to the native service caller.
        headers.set("authorization", `Bearer ${target.bearer}`);
        const response = await fetch(target.url + url.pathname, { method: request.method, headers, ...(payload ? { body: payload } : {}), redirect: "error", signal: requestSignal });
        if (!response.ok) { await response.body?.cancel(); return safeFailure(response.status); }
        if (response.headers.get("content-type")?.startsWith("text/event-stream")) {
          if (!response.body || !model) { await response.body?.cancel(); return safeFailure(503); }
          return new Response(safeNativeStream(response.body, model), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
        }
        const value = await response.json();
        if (!listing && (!value?.message || ["error", "aborted"].includes(value.message.stopReason))) return safeFailure(503);
        return Response.json(value, { headers: { "Cache-Control": "no-store" } });
      } catch { return safeFailure(503); }
    },
  });
  return { port: server.port!, close() { server.stop(true); expected.fill(0); } };
}
