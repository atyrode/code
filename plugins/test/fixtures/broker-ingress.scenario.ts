import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AuthBrokerServerHandle } from "@oh-my-pi/pi-ai/auth-broker/server";
import { parseClientAccess } from "../../workers/broker/inputs.ts";
import { runSdkScenario, type SdkScenarioContext } from "./isolated-sdk";

await runSdkScenario(async (ctx: SdkScenarioContext) => {
  // Static SDK imports would run before the harness's private-state and network barrier.
  const { AuthStorage } = await import("@oh-my-pi/pi-ai/auth-storage");
  const { startAuthBroker } = await import("@oh-my-pi/pi-ai/auth-broker/server");
  const { AuthBrokerClient } = await import("@oh-my-pi/pi-ai/auth-broker/client");
  const { registerOAuthProvider, unregisterOAuthProvider } = await import("@oh-my-pi/pi-ai/registry/oauth/index");
  const nativeBearer = "synthetic-native-ingress-service-bearer";
  const externalBearer = "synthetic-old-client-bearer-0c33ff9c182cd13a5eed70";
  const bearerSha256 = createHash("sha256").update(externalBearer).digest("hex");
  const provider = "synthetic-ingress-provider";
  let rotations = 0;
  registerOAuthProvider({
    id: provider,
    name: "Synthetic ingress regression",
    async login() { throw new Error("synthetic-login-forbidden"); },
    async refreshToken(credential) {
      rotations++;
      return { ...credential, access: "synthetic-unexpected-rotation", expires: Date.now() + 3_600_000 };
    },
  });
  const storage = await AuthStorage.create(join(ctx.root, "ingress.db"));
  let broker: AuthBrokerServerHandle | undefined;
  try {
    storage.upsertCredential(provider, {
      type: "oauth", email: "ingress@accounts.invalid", expires: Date.now() - 1_000,
      access: "synthetic-original-access", refresh: "synthetic-original-refresh",
    });
    const stored = storage.listStoredCredentials().find(row => row.provider === provider);
    ctx.check(stored, "ingress-credential-missing");
    const expectDenied = async (origin: string, authorization?: string, path = "/v1/snapshot", method = "GET") => {
      const response = await ctx.fetchTo(origin)(`${origin}${path}`, {
        method, headers: authorization === undefined ? {} : { authorization },
      });
      ctx.check(response.status === 401, "ingress-unauthorized-request-admitted");
      await response.body?.cancel();
    };

    // The required "{}" clientAccess input selects native-only ephemeral binding.
    const ordinaryAccess = parseClientAccess(JSON.parse("{}"));
    broker = startAuthBroker({ storage, bind: ordinaryAccess?.bind ?? "127.0.0.1:0", bearerTokens: [nativeBearer], disableRefresher: true });
    const origin = broker.url;
    const clientAccess = parseClientAccess({ bind: `127.0.0.1:${broker.port}`, bearerSha256 });
    ctx.check(clientAccess, "ingress-fixed-configuration-missing");
    const nativeClient = new AuthBrokerClient({ url: origin, token: nativeBearer, fetchImpl: ctx.fetchTo(origin), maxRetries: 0 });
    ctx.check((await nativeClient.fetchSnapshot()).status === 200, "ingress-native-only-auth-failed");
    await expectDenied(origin);
    await expectDenied(origin, `Bearer ${externalBearer}`);

    // An occupied reviewed endpoint must fail synchronously, without a fallback
    // listener or a background rotation by a broker that never acquired custody.
    let contender: AuthBrokerServerHandle | undefined;
    let occupiedRejected = false;
    try {
      contender = startAuthBroker({ storage, bind: clientAccess.bind, bearerTokens: [nativeBearer], bearerTokenHashes: [bearerSha256] });
    } catch { occupiedRejected = true; }
    finally { await contender?.close(); }
    ctx.check(occupiedRejected, "ingress-occupied-port-did-not-refuse");
    await Bun.sleep(50);
    ctx.check(rotations === 0, "ingress-failed-bind-started-rotation");
    ctx.check((await nativeClient.healthz()).ok, "ingress-occupied-owner-disrupted");
    await broker.close();
    broker = undefined;

    // The old client's URL and plaintext Authorization header do not change;
    // only its SHA-256 verifier is installed in the new canonical broker.
    broker = startAuthBroker({ storage, bind: clientAccess.bind, bearerTokens: [nativeBearer],
      bearerTokenHashes: [clientAccess.bearerSha256], disableRefresher: true });
    ctx.check(broker.url === origin, "ingress-fixed-endpoint-changed");
    const oldClient = new AuthBrokerClient({ url: origin, token: externalBearer, fetchImpl: ctx.fetchTo(origin), maxRetries: 0 });
    for (const client of [nativeClient, oldClient]) {
      const snapshot = await client.fetchSnapshot();
      ctx.check(snapshot.status === 200, "ingress-authorized-snapshot-failed");
      const row = snapshot.snapshot.credentials.find(entry => entry.id === stored.id);
      ctx.check(row?.provider === provider && row.credential.type === "oauth"
        && row.credential.access === "synthetic-original-access", "ingress-credential-identity-or-access-changed");
      const abort = new AbortController();
      const stream = client.openSnapshotStream({ signal: abort.signal });
      try {
        const frame = await stream.next();
        ctx.check(!frame.done && frame.value.kind === "snapshot"
          && frame.value.credentials.some(entry => entry.id === stored.id), "ingress-authorized-stream-failed");
      } finally {
        abort.abort();
        await stream.return(undefined);
      }
    }
    for (const authorization of [undefined, `Bearer ${externalBearer}wrong`, `Bearer ${bearerSha256}`, `Basic ${externalBearer}`]) {
      await expectDenied(origin, authorization);
    }
    await expectDenied(origin, "Bearer wrong-external-bearer", "/v1/snapshot/stream");
    await expectDenied(origin, "Bearer wrong-external-bearer", "/v1/credential", "POST");
    await oldClient.uploadCredential("synthetic-ingress-upload", { type: "api_key", key: "synthetic-uploaded-api-key" });
    const mutated = await nativeClient.fetchSnapshot();
    ctx.check(mutated.status === 200 && mutated.snapshot.credentials.some(row => row.provider === "synthetic-ingress-upload"),
      "ingress-external-mutation-not-visible-natively");
    await broker.close();
    broker = undefined;

    // Hash-only callers must not inherit the legacy empty-token auth bypass.
    broker = startAuthBroker({ storage, bind: clientAccess.bind, bearerTokens: [],
      bearerTokenHashes: ["0".repeat(64), bearerSha256], disableRefresher: true });
    await expectDenied(origin);
    await expectDenied(origin, `Bearer ${nativeBearer}`);
    ctx.check((await oldClient.fetchSnapshot()).status === 200, "ingress-hash-only-auth-failed");
    await broker.close();
    broker = undefined;

    // Runtime validation, not just TypeScript, rejects the entire malformed
    // option before opening a listener. In particular [] never disables auth.
    for (const invalid of [null, "", bearerSha256, [], [""], [null], new Array(1), [bearerSha256, ""],
      ["g".repeat(64)], [bearerSha256.slice(1)], [bearerSha256.toUpperCase()], [`${bearerSha256}\n`]]) {
      let rejected = false;
      let invalidBroker: AuthBrokerServerHandle | undefined;
      try {
        invalidBroker = startAuthBroker({ storage, bind: clientAccess.bind, bearerTokens: [],
          bearerTokenHashes: invalid as readonly string[], disableRefresher: true });
      } catch { rejected = true; }
      finally { await invalidBroker?.close(); }
      ctx.check(rejected, "ingress-invalid-hash-option-admitted");
    }
  } finally {
    await broker?.close();
    storage.close();
    unregisterOAuthProvider(provider);
  }
});
