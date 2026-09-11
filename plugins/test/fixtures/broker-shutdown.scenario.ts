import { join } from "node:path";
import type { AuthBrokerServerHandle } from "@oh-my-pi/pi-ai/auth-broker/server";
import { runSdkScenario, type SdkScenarioContext } from "./isolated-sdk";

await runSdkScenario(async (ctx: SdkScenarioContext) => {
  // SDK evaluation must follow the harness's network and private-state isolation.
  const { AuthStorage } = await import("@oh-my-pi/pi-ai/auth-storage");
  const { startAuthBroker } = await import("@oh-my-pi/pi-ai/auth-broker/server");
  const { registerOAuthProvider, unregisterOAuthProvider } = await import("@oh-my-pi/pi-ai/registry/oauth/index");

  for (const mode of ["automatic", "http"] as const) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const provider = `synthetic-shutdown-${mode}`;
    const bearer = "SYNTHETIC-SHUTDOWN-BEARER";
    const rotatedRefresh = "SYNTHETIC-SHUTDOWN-ROTATED-REFRESH";
    const rotatedAccess = "SYNTHETIC-SHUTDOWN-ROTATED-ACCESS";
    let refreshStarted = false;
    let released = false;
    let providerAborted = false;
    let refreshCalls = 0;
    registerOAuthProvider({
      id: provider,
      name: "Synthetic shutdown regression",
      async login() { throw new Error("synthetic-login-forbidden"); },
      async refreshToken(credential, signal) {
        refreshStarted = true;
        refreshCalls++;
        entered.resolve();
        await release.promise;
        providerAborted ||= signal?.aborted === true;
        return {
          ...credential,
          refresh: rotatedRefresh,
          access: rotatedAccess,
          expires: Date.now() + 3_600_000,
        };
      },
    });

    const database = join(ctx.root, `${mode}.db`);
    const storage = await AuthStorage.create(database);
    let storageOpen = true;
    let broker: AuthBrokerServerHandle | undefined;
    let request: Promise<void> | undefined;
    const streamAbort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      storage.upsertCredential(provider, {
        type: "oauth",
        email: "shutdown@accounts.invalid",
        refresh: "SYNTHETIC-SHUTDOWN-ORIGINAL-REFRESH",
        access: "SYNTHETIC-SHUTDOWN-ORIGINAL-ACCESS",
        expires: mode === "automatic" ? Date.now() - 1_000 : Date.now() + 3_600_000,
      });
      const entry = storage.listStoredCredentials().find(row => row.provider === provider);
      ctx.check(entry !== undefined, "shutdown-credential-missing");
      broker = startAuthBroker({
        storage,
        bind: "127.0.0.1:0",
        bearerTokens: [bearer],
        disableRefresher: mode === "http",
        refreshIntervalMs: 10,
      });
      const fetch = ctx.fetchTo(broker.url);
      const headers = { authorization: `Bearer ${bearer}` };
      const stream = await fetch(`${broker.url}/v1/snapshot/stream`, { headers, signal: streamAbort.signal });
      ctx.check(stream.status === 200 && stream.body !== null, "shutdown-stream-open-failed");
      reader = stream.body.getReader();
      const initial = await reader.read();
      ctx.check(!initial.done, "shutdown-stream-ended-before-close");

      if (mode === "http") {
        // Observe the real HTTP handler. Forced transport closure may reject this
        // request, but must not detach its credential mutation from broker.close().
        request = fetch(`${broker.url}/v1/credential/${entry.id}/refresh`, { method: "POST", headers })
          .then(async response => { await response.body?.cancel(); }, () => {});
      }
      await entered.promise;
      let firstClosed = false;
      let secondClosed = false;
      const firstClose = broker.close().then(() => { firstClosed = true; });
      const secondClose = broker.close().then(() => { secondClosed = true; });
      // Give an incorrectly immediate close and several sweep intervals time to
      // settle while the provider response remains deliberately unavailable.
      await Bun.sleep(50);
      ctx.check(!firstClosed && !secondClosed, "shutdown-returned-before-refresh");
      release.resolve();
      released = true;
      // The SSE connection is intentionally still open on the client: shutdown
      // must terminate it rather than waiting indefinitely for client cleanup.
      await Promise.all([firstClose, secondClose]);
      ctx.check(!providerAborted, "shutdown-aborted-provider-refresh");
      ctx.check(refreshCalls === 1, "shutdown-started-extra-refresh");
      storage.close();
      storageOpen = false;

      const reopened = await AuthStorage.create(database);
      try {
        await reopened.reload();
        const persisted = reopened.listStoredCredentials().find(row => row.provider === provider)?.credential;
        ctx.check(persisted?.type === "oauth" && persisted.refresh === rotatedRefresh
          && persisted.access === rotatedAccess, "shutdown-rotation-not-persisted");
      } finally {
        reopened.close();
      }
      await broker.close();
    } finally {
      // On the unfixed SDK, join its real single-flight before releasing the
      // provider so failure cleanup does not race storage closure as well.
      const drain = refreshStarted && !released && storageOpen
        ? storage.refreshCredentialById(storage.listStoredCredentials().find(row => row.provider === provider)!.id)
        : undefined;
      release.resolve();
      await drain?.catch(() => {});
      streamAbort.abort();
      await reader?.cancel().catch(() => {});
      await broker?.close();
      await request;
      if (storageOpen) storage.close();
      unregisterOAuthProvider(provider);
    }
  }
});
