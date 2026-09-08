import { AuthBrokerClient, type AuthBrokerClientOptions, type FetchSnapshotOptions, type FetchSnapshotResult } from "@oh-my-pi/pi-ai/auth-broker/client";
import { RemoteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-broker/remote-store";
import type { SnapshotStreamEvent } from "@oh-my-pi/pi-ai/auth-broker/types";
import { AuthStorage, type AuthCredentialSnapshotEntry } from "@oh-my-pi/pi-ai/auth-storage";
import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { type AccountPool, unavailable } from "./inputs.ts";

/** SDK pools intentionally leave missing providers and API keys unrestricted.
 * Code's identity pool is deny-by-default, so enforce it at every SDK ingress.
 * In 18.1.14 API keys have null identityKey and cannot be explicitly selected;
 * never turn that unrepresentable case into permission for a whole provider. */
export class PoolBrokerClient extends AuthBrokerClient {
  readonly #pool: AccountPool;
  readonly rejectedRefreshIds = new Set<number>();
  constructor(options: AuthBrokerClientOptions, pool: AccountPool) {
    super(options);
    this.#pool = new Map([...pool].map(([provider, ids]) => [provider, new Set(ids)]));
  }
  admits(entry: AuthCredentialSnapshotEntry): boolean {
    return entry.identityKey !== null && this.#pool.get(entry.provider)?.has(entry.identityKey) === true;
  }
  override async fetchSnapshot(options: FetchSnapshotOptions = {}): Promise<FetchSnapshotResult> {
    const result = await super.fetchSnapshot(options);
    if (result.status === 304) return result;
    for (const entry of result.snapshot.credentials) if (this.admits(entry)) this.rejectedRefreshIds.delete(entry.id);
    return { ...result, snapshot: { ...result.snapshot, credentials: result.snapshot.credentials.filter(entry => this.admits(entry)) } };
  }
  override async *openSnapshotStream(options: { signal?: AbortSignal } = {}): AsyncGenerator<SnapshotStreamEvent> {
    for await (const event of super.openSnapshotStream(options)) {
      if (event.kind === "snapshot") {
        for (const entry of event.credentials) if (this.admits(entry)) this.rejectedRefreshIds.delete(entry.id);
        yield { ...event, credentials: event.credentials.filter(entry => this.admits(entry)) };
      }
      else if (event.kind === "entry" && !this.admits(event.entry)) {
        yield { kind: "removed", id: event.entry.id, generation: event.generation, serverNowMs: event.serverNowMs, refresher: event.refresher };
      } else {
        if (event.kind === "entry") this.rejectedRefreshIds.delete(event.entry.id);
        yield event;
      }
    }
  }
  override async refreshCredential(id: number, signal?: AbortSignal) {
    const result = await super.refreshCredential(id, signal);
    if (!this.admits(result.entry) || result.entry.id !== id) {
      this.rejectedRefreshIds.add(id);
      throw unavailable();
    }
    return result;
  }
}

class PoolRemoteStore extends RemoteAuthCredentialStore {
  override listAuthCredentials(provider?: string) {
    const rejected = (this.client as PoolBrokerClient).rejectedRefreshIds;
    return super.listAuthCredentials(provider).filter(entry => !rejected.has(entry.id));
  }
}

/** Reloading the in-memory SDK view at request entry admits newly-enabled rows
 * and observes removals. SDK selection also rechecks rows after awaits, retains
 * its own sticky routing/blocks, and performs broker-owned refresh as normal. */
export class PoolAuthStorage extends AuthStorage {
  constructor(readonly remote: RemoteAuthCredentialStore, readonly pool: AccountPool, readonly signal: AbortSignal) {
    super(remote, { sourceLabel: "native account pool", configValueResolver: async () => undefined });
  }
  override async getApiKey(...args: Parameters<AuthStorage["getApiKey"]>): Promise<string | undefined> {
    this.signal.throwIfAborted();
    if (!this.pool.get(args[0])?.size) return undefined;
    await this.reload();
    if (this.remote.listAuthCredentials(args[0]).length === 0) return undefined;
    const key = await super.getApiKey(...args);
    this.signal.throwIfAborted();
    return key;
  }
}

export function poolModels(pool: AccountPool): Map<string, Model<Api>> {
  const models = new Map<string, Model<Api>>();
  for (const provider of getBundledProviders()) {
    if (!pool.get(provider)?.size) continue;
    for (const model of getBundledModels(provider)) models.set(`${model.provider}/${model.id}`, model);
  }
  return models;
}

export async function openPoolStorage(broker: { url: string; token: string }, pool: AccountPool, signal: AbortSignal, fetchImpl: typeof fetch = fetch) {
  const scopedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    signal.throwIfAborted();
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return fetchImpl(input, { ...init, redirect: "error", signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal });
  }, { preconnect: fetchImpl.preconnect });
  const client = new PoolBrokerClient({ ...broker, fetchImpl: scopedFetch }, pool);
  const initial = await client.fetchSnapshot({ signal });
  if (initial.status !== 200) throw unavailable();
  signal.throwIfAborted();
  const remote = new PoolRemoteStore({ client, initialSnapshot: initial.snapshot, accountPool: pool });
  const storage = new PoolAuthStorage(remote, pool, signal);
  try { await storage.reload(); signal.throwIfAborted(); return storage; }
  catch { storage.close(); throw unavailable(); }
}
