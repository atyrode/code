import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AuthBrokerServerHandle } from "@oh-my-pi/pi-ai/auth-broker/server";
import { runSdkScenario, type SdkScenarioContext } from "./isolated-sdk";

await runSdkScenario(async (ctx: SdkScenarioContext) => {
  // Static SDK imports would precede the child's private-state and network barrier.
  const { AuthStorage } = await import("@oh-my-pi/pi-ai/auth-storage");
  const { startAuthBroker } = await import("@oh-my-pi/pi-ai/auth-broker/server");
  const { registerOAuthProvider, unregisterOAuthProvider } = await import("@oh-my-pi/pi-ai/registry/oauth/index");
  const nativeBearer = "synthetic-native-control-bearer-private-only";
  const peerBearer = "synthetic-other-plaintext-bearer-no-control";
  const oldBearer = "synthetic-old-client-bearer-no-control";
  const oldHash = createHash("sha256").update(oldBearer).digest("hex");

  for (const outcome of ["persist", "fail"] as const) {
    const provider = `synthetic-quiesce-${outcome}`;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let refreshAborted = false;
    let usageTimedOut = false;
    let refreshCalls = 0;
    registerOAuthProvider({
      id: provider,
      name: "Synthetic detached rotation",
      async login() { throw new Error("synthetic-login-forbidden"); },
      async refreshToken(credential, signal) {
        refreshCalls++;
        entered.resolve();
        await release.promise;
        refreshAborted ||= signal?.aborted === true;
        if (outcome === "fail") throw new Error("synthetic-provider-refresh-failure");
        return { ...credential, access: "synthetic-rotated-access", refresh: "synthetic-rotated-refresh", expires: Date.now() + 3_600_000 };
      },
    });
    const database = join(ctx.root, `quiesce-${outcome}.db`);
    const storage = await AuthStorage.create(database, {
      usageRequestTimeoutMs: 20,
      usageProviderResolver: id => id === provider ? {
        id,
        async fetchUsage(params) {
          // This real usage path has stopped awaiting the credential refresh.
          usageTimedOut = params.signal?.aborted === true;
          return null;
        },
      } : undefined,
    });
    let broker: AuthBrokerServerHandle | undefined;
    let usage: Promise<void> | undefined;
    let controlDrain: Promise<{ status: number; body: unknown }> | undefined;
    let handleDrain: Promise<boolean> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const streamAbort = new AbortController();
    try {
      storage.upsertCredential(provider, {
        type: "oauth", email: "quiesce@accounts.invalid", expires: Date.now() - 1_000,
        access: "synthetic-original-access", refresh: "synthetic-original-refresh",
      });
      const initial = storage.listStoredCredentials().find(row => row.provider === provider);
      ctx.check(initial, "quiesce-credential-missing");
      if (outcome === "persist") {
        for (const invalid of [null, "", oldBearer, oldHash]) {
          let accepted: AuthBrokerServerHandle | undefined;
          let rejected = false;
          try {
            accepted = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [nativeBearer],
              bearerTokenHashes: [oldHash], controlBearerToken: invalid as string, disableRefresher: true });
          } catch { rejected = true; }
          finally { await accepted?.close(); }
          ctx.check(rejected, "quiesce-invalid-control-bearer-admitted");
        }
      }
      broker = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [nativeBearer, peerBearer],
        bearerTokenHashes: [oldHash], controlBearerToken: nativeBearer, disableRefresher: true });
      const origin = broker.url;
      const fetch = ctx.fetchTo(origin);
      const nativeHeaders = { authorization: `Bearer ${nativeBearer}` };
      const control = async (path: "state" | "quiesce", token?: string) => {
        const response = await fetch(`${origin}/v1/control/${path}`, {
          method: path === "state" ? "GET" : "POST",
          headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        });
        return { status: response.status, body: await response.json() as unknown };
      };
      const controlState = async (): Promise<string> => {
        const result = await control("state", nativeBearer);
        ctx.check(result.status === 200 && result.body !== null && typeof result.body === "object"
          && "state" in result.body && typeof result.body.state === "string", "quiesce-control-state-unavailable");
        return result.body.state;
      };
      for (const token of [undefined, oldBearer, peerBearer, oldHash]) {
        for (const route of ["state", "quiesce"] as const) {
          ctx.check((await control(route, token)).status === 401, "quiesce-nonnative-control-authorized");
        }
      }
      ctx.check(await controlState() === "active", "quiesce-unauthorized-control-changed-state");
      const stream = await fetch(`${origin}/v1/snapshot/stream`, { headers: nativeHeaders, signal: streamAbort.signal });
      ctx.check(stream.status === 200 && stream.body, "quiesce-stream-unavailable");
      reader = stream.body.getReader();
      ctx.check(!(await reader.read()).done, "quiesce-stream-missing-initial-frame");

      usage = fetch(`${origin}/v1/usage`, { headers: nativeHeaders }).then(async response => {
        ctx.check(response.status === 200, "quiesce-usage-request-failed");
        await response.body?.cancel();
      });
      await entered.promise;
      await usage;
      ctx.check(usageTimedOut, "quiesce-usage-did-not-detach-refresh");
      let controlSettled = false;
      controlDrain = control("quiesce", nativeBearer).then(result => { controlSettled = true; return result; });
      let state = await controlState();
      const deadline = Date.now() + 3_000;
      while (state === "active" && Date.now() < deadline) {
        await Bun.sleep(5);
        state = await controlState();
      }
      ctx.check(state === "draining", "quiesce-detached-refresh-not-held");
      let handleSettled = false;
      handleDrain = broker.quiesce().then(() => { handleSettled = true; return true; }, () => { handleSettled = true; return false; });
      const refused = await fetch(`${origin}/v1/credential`, {
        method: "POST", headers: { authorization: `Bearer ${oldBearer}` }, body: "{}",
      });
      ctx.check(refused.status === 503, "quiesce-admitted-new-mutation");
      await refused.body?.cancel();
      ctx.check(!controlSettled && !handleSettled, "quiesce-returned-before-detached-rotation");
      ctx.check((await reader.read()).done, "quiesce-retained-snapshot-stream");
      release.resolve();
      const result = await controlDrain;
      const handleSucceeded = await handleDrain;
      ctx.check(!refreshAborted && refreshCalls === 1, "quiesce-interrupted-or-restarted-rotation");
      if (outcome === "persist") {
        ctx.check(result.status === 200 && handleSucceeded && await controlState() === "drained", "quiesce-success-not-drained");
        const reopened = await AuthStorage.create(database);
        try {
          await reopened.reload();
          const persisted = reopened.listStoredCredentials().find(row => row.id === initial.id)?.credential;
          ctx.check(persisted?.type === "oauth" && persisted.refresh === "synthetic-rotated-refresh"
            && persisted.access === "synthetic-rotated-access", "quiesce-reported-drained-before-persistence");
        } finally { reopened.close(); }
        ctx.check((await control("quiesce", nativeBearer)).status === 200, "quiesce-repeat-did-not-retain-control");
      } else {
        ctx.check(result.status === 503 && !handleSucceeded && await controlState() === "draining", "quiesce-failure-claimed-drained");
        ctx.check((await control("quiesce", nativeBearer)).status === 503, "quiesce-failure-not-sticky");
      }
      ctx.check((await control("state", oldBearer)).status === 401, "quiesce-drained-control-leaked-to-old-client");
    } finally {
      release.resolve();
      streamAbort.abort();
      await reader?.cancel().catch(() => {});
      await usage?.catch(() => {});
      await controlDrain?.catch(() => {});
      await handleDrain;
      await broker?.close().catch(() => {});
      await storage.drainRefreshes().catch(() => {});
      storage.close();
      unregisterOAuthProvider(provider);
    }
  }
});
