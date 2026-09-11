import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RemoteAuthCredentialStore as RemoteStore } from "@oh-my-pi/pi-ai/auth-broker/remote-store";
import type { AuthBrokerServerHandle } from "@oh-my-pi/pi-ai/auth-broker/server";
import type { SnapshotStreamEvent } from "@oh-my-pi/pi-ai/auth-broker/types";
import type { SdkScenarioContext } from "./isolated-sdk.ts";
import { runSdkScenario } from "./isolated-sdk.ts";

await runSdkScenario(async (ctx: SdkScenarioContext) => {
  // SDK loading must follow the child's environment, logging, and fetch isolation.
  const { AuthStorage } = await import("@oh-my-pi/pi-ai/auth-storage");
  const { startAuthBroker } = await import("@oh-my-pi/pi-ai/auth-broker/server");
  const { AuthBrokerClient } = await import("@oh-my-pi/pi-ai/auth-broker/client");
  const { RemoteAuthCredentialStore } = await import("@oh-my-pi/pi-ai/auth-broker/remote-store");
  const dbPath = join(ctx.root, "restart.db");
  const selected = "synthetic-restart-selected";
  const removed = "synthetic-restart-removed";
  const marker = "synthetic-restart-marker";
  const token = "synthetic-restart-broker-bearer";
  const expires = Date.now() + 3_600_000;
  const credential = (access: string) => ({
    type: "oauth" as const, access, refresh: "synthetic-unused-refresh", expires,
    email: "restart@accounts.invalid",
  });
  const controller = new AbortController();
  let storage = await AuthStorage.create(dbPath);
  let broker: AuthBrokerServerHandle | undefined;
  let remote: RemoteStore | undefined;
  let streamController: TransformStreamDefaultController<Uint8Array> | undefined;
  let activeStreamSignal: AbortSignal | undefined;
  let streamConnections = 0;
  let directSnapshots = 0;
  let fullSnapshots = 0;
  const eventually = async (condition: () => boolean, code: string) => {
    const deadline = Date.now() + 5_000;
    while (!condition() && Date.now() < deadline) await delay(10);
    ctx.check(condition(), code);
  };
  const accessIs = (provider: string, access: string) => {
    const rows = remote?.listAuthCredentials(provider) ?? [];
    return rows.length === 1 && rows[0].credential.type === "oauth" && rows[0].credential.access === access;
  };
  try {
    // Generation advances belong to this AuthStorage, not to the persistent DB.
    for (let i = 0; i < 12; i++) storage.upsertCredential(selected, credential(`synthetic-before-${i}`));
    storage.upsertCredential(removed, credential("synthetic-removed"));
    storage.upsertCredential(marker, credential("synthetic-marker-before"));
    broker = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [token], disableRefresher: true });
    const port = broker.port;
    const origin = broker.url;
    const fixtureFetch = ctx.fetchTo(origin);
    const fetchImpl: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      ctx.check(method === "GET" && !url.search && ["/v1/snapshot", "/v1/snapshot/stream"].includes(url.pathname), "unexpected-broker-route");
      if (url.pathname === "/v1/snapshot") directSnapshots++;
      const requestedSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const signal = requestedSignal ? AbortSignal.any([controller.signal, requestedSignal]) : controller.signal;
      const response = await fixtureFetch(input, { ...init, signal });
      if (url.pathname !== "/v1/snapshot/stream" || !response.ok) return response;
      ctx.check(response.body, "missing-stream-body");
      streamConnections++;
      activeStreamSignal = signal;
      // Forward the real broker response unchanged. After reconnect, this seam
      // also replays stale wire frames through the real SSE parser and store.
      const replayable = new TransformStream<Uint8Array, Uint8Array>({
        start(value) { streamController = value; },
        transform(chunk, value) { value.enqueue(chunk); },
      });
      return new Response(response.body.pipeThrough(replayable), { status: response.status, headers: response.headers });
    }, { preconnect: () => { ctx.check(false, "unexpected-preconnect"); } });
    const client = new AuthBrokerClient({ url: origin, token, fetchImpl, maxRetries: 0 });
    const initial = await client.fetchSnapshot({ signal: controller.signal });
    ctx.check(initial.status === 200, "missing-initial-snapshot");
    const oldGeneration = initial.generation;
    const removedEntry = initial.snapshot.credentials.find(row => row.provider === removed);
    ctx.check(removedEntry, "missing-initial-removal-target");
    remote = new RemoteAuthCredentialStore({
      client, initialSnapshot: initial.snapshot, backgroundIdleMs: 60_000,
      onSnapshot: () => { fullSnapshots++; },
    });
    await eventually(() => fullSnapshots === 1 && accessIs(selected, "synthetic-before-11"), "initial-stream-not-consumed");
    ctx.check(accessIs(removed, "synthetic-removed"), "initial-credential-missing");

    await broker.close();
    broker = undefined;
    storage.close();
    storage = await AuthStorage.create(dbPath);
    await storage.reload();
    storage.upsertCredential(selected, credential("synthetic-after-restart"));
    await storage.remove(removed);
    ctx.check(storage.getGeneration() < oldGeneration, "restart-generation-not-lower");
    broker = startAuthBroker({ storage, bind: `127.0.0.1:${port}`, bearerTokens: [token], disableRefresher: true });
    ctx.check(broker.url === origin, "restart-origin-changed");

    // No direct refresh or consumer reconstruction: only automatic SSE reconnect.
    await eventually(() => accessIs(selected, "synthetic-after-restart") && remote!.listAuthCredentials(removed).length === 0,
      "reconnect-retained-obsolete-credentials");
    ctx.check(streamConnections >= 2 && fullSnapshots >= 2, "reconnect-snapshot-not-consumed");
    ctx.check(remote.snapshot.generation < oldGeneration, "consumer-generation-not-reset");
    ctx.check(directSnapshots === 1, "reconnect-used-direct-resnapshot");
    const restartedSnapshot = remote.snapshot;

    storage.upsertCredential(selected, credential("synthetic-after-stream-update"));
    await eventually(() => accessIs(selected, "synthetic-after-stream-update"), "post-restart-entry-not-consumed");
    ctx.check(remote.snapshot.generation > restartedSnapshot.generation, "post-restart-generation-not-advanced");
    const selectedEntry = remote.snapshot.credentials.find(row => row.provider === selected);
    ctx.check(selectedEntry && streamController, "missing-replay-target");
    const replay = (event: SnapshotStreamEvent) => {
      streamController!.enqueue(new TextEncoder().encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`));
    };
    const stale = { generation: restartedSnapshot.generation, serverNowMs: restartedSnapshot.serverNowMs, refresher: restartedSnapshot.refresher };
    replay({ kind: "snapshot", ...restartedSnapshot });
    replay({ kind: "entry", ...stale, entry: removedEntry });
    replay({ kind: "removed", ...stale, id: selectedEntry.id });
    // This real broker event is queued after the replayed bytes. Seeing it is a
    // processing barrier, rather than assuming a sleep allowed stale frames in.
    storage.upsertCredential(marker, credential("synthetic-marker-after"));
    await eventually(() => accessIs(marker, "synthetic-marker-after"), "stream-replay-barrier-not-consumed");
    ctx.check(accessIs(selected, "synthetic-after-stream-update"), "stale-event-regressed-selected-credential");
    ctx.check(remote.listAuthCredentials(removed).length === 0, "stale-event-restored-removed-credential");
    ctx.check(directSnapshots === 1, "stream-used-direct-resnapshot");
    remote.close();
    ctx.check(activeStreamSignal?.aborted, "remote-close-did-not-abort-stream");
  } finally {
    remote?.close();
    controller.abort();
    await broker?.close();
    storage.close();
  }
});
