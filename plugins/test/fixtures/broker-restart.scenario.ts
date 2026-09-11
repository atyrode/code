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
    const first = rows[0];
    return rows.length === 1 && first?.credential.type === "oauth" && first.credential.access === access;
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

  // Keep the real SDK stream parser, but park a decoded first frame in an
  // abort-ignoring iterator to model a completion already in application code.
  const raceAbort = new AbortController();
  const firstFrameReady = Promise.withResolvers<void>();
  const releaseFirstFrame = Promise.withResolvers<void>();
  const firstFrameProcessed = Promise.withResolvers<void>();
  const releaseReplacement = Promise.withResolvers<void>();
  const releaseOldRemainder = Promise.withResolvers<void>();
  let raceStreamCount = 0;
  let firstStreamSignal: AbortSignal | undefined;
  let replacementApplied = false;
  class DelayedStreamClient extends AuthBrokerClient {
    override async *openSnapshotStream(opts: { signal?: AbortSignal } = {}): AsyncGenerator<SnapshotStreamEvent> {
      const firstStream = ++raceStreamCount === 1;
      if (firstStream) firstStreamSignal = opts.signal;
      const signal = firstStream ? raceAbort.signal : AbortSignal.any([raceAbort.signal, opts.signal!]);
      let firstFrame = true;
      for await (const event of super.openSnapshotStream({ signal })) {
        if (firstFrame) {
          firstFrame = false;
          if (firstStream) {
            firstFrameReady.resolve();
            await releaseFirstFrame.promise;
            try { yield event; }
            finally { firstFrameProcessed.resolve(); }
            // Do not let queued current frames hide a stale first-frame publish.
            await releaseOldRemainder.promise;
            continue;
          }
          await releaseReplacement.promise;
        }
        yield event;
      }
    }
  }
  const within = async <T>(promise: Promise<T>, code: string): Promise<T> => {
    const timeout = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      try { ctx.check(false, code); }
      catch (error) { timeout.reject(error); }
    }, 3_000);
    try { return await Promise.race([promise, timeout.promise]); }
    finally { clearTimeout(timer); }
  };
  storage = await AuthStorage.create(join(ctx.root, "authority.db"));
  broker = undefined;
  remote = undefined;
  try {
    storage.upsertCredential(selected, credential("synthetic-authority-before"));
    storage.upsertCredential(removed, credential("synthetic-authority-removed"));
    broker = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [token], disableRefresher: true });
    const fixtureFetch = ctx.fetchTo(broker.url);
    const fetchImpl: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      ctx.check((init?.method ?? "GET") === "GET"
        && ["/v1/snapshot", "/v1/snapshot/stream"].includes(url.pathname), "unexpected-authority-route");
      return fixtureFetch(input, init);
    }, { preconnect: () => { ctx.check(false, "unexpected-authority-preconnect"); } });
    const client = new DelayedStreamClient({ url: broker.url, token, fetchImpl, maxRetries: 0 });
    const initial = await client.fetchSnapshot({ signal: raceAbort.signal });
    ctx.check(initial.status === 200, "missing-authority-initial-snapshot");
    remote = new RemoteAuthCredentialStore({
      client, initialSnapshot: initial.snapshot, backgroundIdleMs: 60_000,
      onSnapshot: () => { if (raceStreamCount >= 2) replacementApplied = true; },
    });
    await within(firstFrameReady.promise, "first-frame-not-parked");
    storage.upsertCredential(selected, credential("synthetic-authority-current"));
    await storage.remove(removed);
    await within(remote.refreshSnapshot(), "direct-refresh-waited-for-obsolete-stream");
    ctx.check(accessIs(selected, "synthetic-authority-current")
      && remote.listAuthCredentials(removed).length === 0, "direct-refresh-not-published");
    ctx.check(firstStreamSignal?.aborted, "direct-refresh-did-not-retire-stream");
    const authoritativeGeneration = remote.snapshot.generation;
    releaseFirstFrame.resolve();
    await within(firstFrameProcessed.promise, "obsolete-frame-not-processed");
    ctx.check(accessIs(selected, "synthetic-authority-current")
      && remote.listAuthCredentials(removed).length === 0, "obsolete-first-frame-restored-credentials");
    ctx.check(remote.snapshot.generation === authoritativeGeneration, "obsolete-first-frame-reset-generation");
    releaseReplacement.resolve();
    await eventually(() => replacementApplied, "replacement-stream-not-published");
    ctx.check(accessIs(selected, "synthetic-authority-current")
      && remote.listAuthCredentials(removed).length === 0, "replacement-stream-regressed-credentials");
  } finally {
    remote?.close();
    raceAbort.abort();
    releaseFirstFrame.resolve();
    releaseReplacement.resolve();
    releaseOldRemainder.resolve();
    await broker?.close();
    storage.close();
  }
});
