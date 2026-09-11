import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthBrokerServerHandle } from "@oh-my-pi/pi-ai/auth-broker/server";
import type { RemoteAuthCredentialStore as RemoteStore } from "@oh-my-pi/pi-ai/auth-broker/remote-store";
import type { SnapshotResponse } from "@oh-my-pi/pi-ai/auth-broker/types";
import { runSdkScenario, type SdkScenarioContext } from "./isolated-sdk.ts";

await runSdkScenario(async (ctx: SdkScenarioContext) => {
  // Load the actual SDK only after private environment and network isolation.
  const { AuthStorage } = await import("@oh-my-pi/pi-ai/auth-storage");
  const { AuthBrokerClient } = await import("@oh-my-pi/pi-ai/auth-broker/client");
  const { RemoteAuthCredentialStore } = await import("@oh-my-pi/pi-ai/auth-broker/remote-store");
  const { startAuthBroker } = await import("@oh-my-pi/pi-ai/auth-broker/server");
  const { registerOAuthProvider, unregisterOAuthProvider } = await import("@oh-my-pi/pi-ai/registry/oauth/index");
  const provider = "synthetic-mutation-ordering";
  const bearer = "SYNTHETIC-MUTATION-BEARER";
  const credential = (access: string) => ({
    type: "oauth" as const, email: "ordering@accounts.invalid",
    access, refresh: "SYNTHETIC-MUTATION-REFRESH", expires: Date.now() + 3_600_000,
  });
  registerOAuthProvider({
    id: provider,
    name: "Synthetic mutation ordering",
    async login() { throw new Error("synthetic-login-forbidden"); },
    async refreshToken(current) { return { ...current, access: "synthetic-old-refresh-reply", expires: Date.now() + 3_600_000 }; },
  });
  const eventually = async (condition: () => boolean, code: string) => {
    const deadline = Date.now() + 3_000;
    while (!condition() && Date.now() < deadline) await delay(5);
    ctx.check(condition(), code);
  };

  try {
    for (const operation of ["refresh", "suspect", "upload", "replace", "delete-one", "delete-provider"] as const) {
      for (const later of ["removed", "replacement"] as const) {
        const replyReady = Promise.withResolvers<void>();
        const releaseReply = Promise.withResolvers<void>();
        let armed = false;
        const park = async <T>(response: T): Promise<T> => {
          if (armed) {
            armed = false;
            replyReady.resolve();
            await releaseReply.promise;
          }
          return response;
        };
        class DelayedReplyClient extends AuthBrokerClient {
          override async refreshCredential(...args: Parameters<typeof AuthBrokerClient.prototype.refreshCredential>) {
            return park(await super.refreshCredential(...args));
          }
          override async uploadCredential(...args: Parameters<typeof AuthBrokerClient.prototype.uploadCredential>) {
            return park(await super.uploadCredential(...args));
          }
          override async disableCredential(...args: Parameters<typeof AuthBrokerClient.prototype.disableCredential>) {
            const response = await super.disableCredential(...args);
            return operation.startsWith("delete") ? park(response) : response;
          }
        }
        const storage = await AuthStorage.create(join(ctx.root, `${operation}-${later}.db`));
        let broker: AuthBrokerServerHandle | undefined;
        let remote: RemoteStore | undefined;
        let pending: Promise<unknown> | undefined;
        let notified: SnapshotResponse | undefined;
        try {
          storage.upsertCredential(provider, credential("synthetic-initial"));
          broker = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [bearer], disableRefresher: true });
          const fixtureFetch = ctx.fetchTo(broker.url);
          const fetchImpl: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            const method = init?.method ?? "GET";
            ctx.check((method === "GET" && ["/v1/snapshot", "/v1/snapshot/stream"].includes(url.pathname))
              || (method === "POST" && /^\/v1\/credential(?:\/\d+\/(?:refresh|disable))?$/.test(url.pathname)),
            "unexpected-mutation-route");
            return fixtureFetch(input, init);
          }, { preconnect: () => { ctx.check(false, "unexpected-mutation-preconnect"); } });
          const client = new DelayedReplyClient({ url: broker.url, token: bearer, fetchImpl, maxRetries: 0 });
          const initial = await client.fetchSnapshot();
          ctx.check(initial.status === 200, "missing-mutation-snapshot");
          const row = initial.snapshot.credentials.find(entry => entry.provider === provider);
          ctx.check(row?.credential.type === "oauth", "missing-mutation-row");
          remote = new RemoteAuthCredentialStore({
            client, initialSnapshot: initial.snapshot, backgroundIdleMs: 60_000,
            onSnapshot(snapshot) { notified = snapshot; },
          });
          ctx.check(notified === undefined, "constructor-called-snapshot-hook");
          await eventually(() => notified !== undefined, "initial-stream-not-accepted");
          armed = true;
          const mutation = operation === "refresh"
            ? remote.refreshOAuthCredential(provider, row.id, credential("synthetic-initial"))
            : operation === "suspect" ? remote.markCredentialSuspect(row.id)
            : operation === "upload" ? remote.upsertAuthCredentialRemote(provider, credential("synthetic-old-upload-reply"))
            : operation === "replace" ? remote.replaceAuthCredentialsRemote(provider, [credential("synthetic-old-upload-reply")])
            : operation === "delete-one" ? remote.deleteAuthCredentialRemote(row.id, "synthetic-disable")
            : remote.deleteAuthCredentialsRemote(provider, "synthetic-disable");
          // Capture errors immediately so intentional rejection cannot be unhandled.
          const outcome = mutation.then(value => ({ ok: true as const, value }), () => ({ ok: false as const }));
          pending = outcome;
          await replyReady.promise;
          if (later === "removed") await storage.remove(provider);
          else storage.upsertCredential(provider, credential("synthetic-canonical-replacement"));
          await remote.refreshSnapshot();
          const canonical = remote.listAuthCredentials(provider);
          ctx.check(later === "removed" ? canonical.length === 0
            : canonical.length === 1 && canonical[0]?.credential.type === "oauth"
              && canonical[0].credential.access === "synthetic-canonical-replacement", "canonical-mutation-state-not-published");
          releaseReply.resolve();
          const result = await outcome;
          const rows = remote.listAuthCredentials(provider);
          ctx.check(later === "removed" ? rows.length === 0
            : rows.length === 1 && rows[0]?.credential.type === "oauth"
              && rows[0].credential.access === "synthetic-canonical-replacement", "late-reply-overwrote-canonical-state");
          if (operation === "refresh" || operation === "suspect") {
            if (later === "removed") ctx.check(!result.ok, "removed-refresh-returned-stale-success");
            else {
              ctx.check(result.ok, "canonical-refresh-rejected");
              if (operation === "refresh") ctx.check(result.value && typeof result.value === "object"
                && "access" in result.value && result.value.access === "synthetic-canonical-replacement", "refresh-returned-stale-reply");
            }
          } else {
            ctx.check(result.ok, "broker-mutation-rejected");
            if (operation === "upload" || operation === "replace") {
              ctx.check(Array.isArray(result.value), "mutation-did-not-return-rows");
              ctx.check(later === "removed" ? result.value.length === 0
                : result.value.length === 1 && result.value[0]?.credential.access === "synthetic-canonical-replacement",
              "upload-returned-stale-reply");
            }
          }
          if (operation === "refresh" && later === "replacement") {
            remote.updateAuthCredential(row.id, credential("synthetic-stale-auth-storage-writeback"));
            const current = remote.listAuthCredentials(provider)[0]?.credential;
            ctx.check(current?.type === "oauth" && current.access === "synthetic-canonical-replacement",
              "refresh-writeback-overwrote-canonical-state");
          }
          // Observe actual stream deltas, not another direct refresh. Callback
          // consumers must receive exactly the canonical public snapshot as well.
          await eventually(() => notified === remote!.snapshot, "canonical-hook-not-published");
          storage.upsertCredential(provider, credential("synthetic-stream-replacement"));
          await eventually(() => {
            const current = remote!.listAuthCredentials(provider)[0]?.credential;
            return current?.type === "oauth" && current.access === "synthetic-stream-replacement";
          }, "entry-delta-not-published");
          ctx.check(notified === remote.snapshot, "entry-delta-missing-canonical-hook");
          await storage.remove(provider);
          await eventually(() => remote!.listAuthCredentials(provider).length === 0, "removal-delta-not-published");
          ctx.check(notified === remote.snapshot && notified.credentials.length === 0, "removal-delta-missing-canonical-hook");
        } finally {
          releaseReply.resolve();
          await pending;
          remote?.close();
          await broker?.close();
          storage.close();
        }
      }
    }
  } finally {
    unregisterOAuthProvider(provider);
  }
});
