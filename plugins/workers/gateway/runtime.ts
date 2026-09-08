import { randomBytes } from "node:crypto";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway/server";
import type { AuthGatewayServerHandle } from "@oh-my-pi/pi-ai/auth-gateway/types";
import { startPrivateBoundary, type PrivateBoundary } from "./boundary.ts";
import { type GatewayInputs, unavailable } from "./inputs.ts";
import { openPoolStorage, poolModels, type PoolAuthStorage } from "./storage.ts";

export interface PoolGateway { port: number; close(): Promise<void> }
export async function startPoolGateway(inputs: GatewayInputs, ownerSignal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<PoolGateway> {
  const controller = new AbortController();
  const signal = AbortSignal.any([ownerSignal, controller.signal]);
  let storage: PoolAuthStorage | undefined;
  let sdk: AuthGatewayServerHandle | undefined;
  let boundary: PrivateBoundary | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", onAbort);
    // Abort first, including SDK fire-and-forget block/usage/refresh calls. The
    // remote store's final observed-usage flush must not outlive native ownership.
    controller.abort(unavailable());
    boundary?.close();
    storage?.close();
    await sdk?.close();
  };
  const onAbort = (): void => { void close(); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    storage = await openPoolStorage(inputs.broker, inputs.accountPool, signal, fetchImpl);
    signal.throwIfAborted();
    const models = poolModels(inputs.accountPool);
    // The SDK exposes diagnostic routes without a hook to disable them. Its
    // unannounced listener uses a separate private capability so possession of
    // the native service bearer cannot bypass the safe application boundary.
    const internalBearer = randomBytes(32).toString("base64url");
    sdk = startAuthGateway({ bind: "127.0.0.1:0", bearerTokens: [internalBearer], storage,
      resolveModel: id => models.get(id), listModels: () => models.values(),
    });
    boundary = startPrivateBoundary({ url: sdk.url, bearer: internalBearer }, inputs.serviceBearer, models, signal);
    signal.throwIfAborted();
    return { port: boundary.port, close };
  } catch {
    // An abort can close while the startup await settles. Close any resource
    // that was assigned after that first close as well; never restart it.
    await close();
    boundary?.close();
    storage?.close();
    await sdk?.close();
    throw unavailable();
  }
}
