import { describe, expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { setTransports } from "@oh-my-pi/pi-utils/logger";
import type { SnapshotEntry, SnapshotResponse, SnapshotStreamEvent } from "@oh-my-pi/pi-ai/auth-broker/types";
import { isolateEnvironment, parseInputs } from "./inputs.ts";

// Runtime imports must follow the same logging barrier as the private worker.
setTransports({ file: false, console: false });
const { openPoolStorage, poolModels, PoolBrokerClient } = await import("./storage.ts");
const { safeNativeStream } = await import("./boundary.ts");
const { startPoolGateway } = await import("./runtime.ts");
const { resolveCredentialIdentityKey } = await import("@oh-my-pi/pi-ai/auth/sqlite-credential-store");
const broker = { url: "http://127.0.0.1:12345", token: "fixture-native-capability-not-a-source-token" };
const serviceBearer = "fixture-native-service-bearer-private-only";

function credential(id: number, identityKey: string | null, provider = "anthropic"): SnapshotEntry {
  return { id, provider, identityKey, rotatesInMs: null, credential: {
    type: "oauth", access: `fixture-access-${id}`, refresh: "__remote__", expires: Date.now() + 3600_000,
    accountId: `fixture-account-${id}`, email: `fixture-${id}@example.invalid`,
  } };
}
class FixtureBroker {
  snapshot: SnapshotResponse;
  stream?: ReadableStreamDefaultController<Uint8Array>;
  readonly listening = Promise.withResolvers<void>();
  readonly disconnected = Promise.withResolvers<void>();
  refreshEntry?: SnapshotEntry;
  readonly encoder = new TextEncoder();
  constructor(entries: SnapshotEntry[]) {
    this.snapshot = { generation: 1, generatedAt: Date.now(), serverNowMs: Date.now(), credentials: entries,
      refresher: { enabled: false, intervalMs: 60000, skewMs: 60000, nextSweepInMs: 60000 } };
  }
  readonly fetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(broker.url);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${broker.token}`);
    if (url.pathname === "/v1/snapshot/stream") {
      return new Response(new ReadableStream<Uint8Array>({ start: controller => {
        this.stream = controller;
        this.send({ ...this.snapshot, kind: "snapshot" });
        init?.signal?.addEventListener("abort", () => { try { controller.close(); } catch {} this.disconnected.resolve(); }, { once: true });
        this.listening.resolve();
      } }), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.pathname === "/v1/snapshot") return Response.json(this.snapshot, { headers: { ETag: `"${this.snapshot.generation}"` } });
    if (url.pathname === "/v1/usage") return Response.json({ generatedAt: Date.now(), reports: [] });
    if (url.pathname.endsWith("/refresh")) {
      const entry = this.refreshEntry!;
      this.snapshot = { ...this.snapshot, generation: this.snapshot.generation + 1,
        credentials: this.snapshot.credentials.map(current => current.id === entry.id ? entry : current) };
      if (this.stream) this.send({ kind: "entry", entry, generation: this.snapshot.generation,
        serverNowMs: Date.now(), refresher: this.snapshot.refresher });
      const { rotatesInMs: _, ...wireEntry } = entry;
      return Response.json({ entry: wireEntry });
    }
    throw new Error("unplanned fixture operation");
  }, { preconnect: fetch.preconnect });
  send(event: SnapshotStreamEvent): void { this.stream!.enqueue(this.encoder.encode(`event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)); }
  remove(id: number): void {
    this.snapshot = { ...this.snapshot, generation: this.snapshot.generation + 1, credentials: this.snapshot.credentials.filter(entry => entry.id !== id) };
    this.send({ kind: "removed", id, generation: this.snapshot.generation, serverNowMs: Date.now(), refresher: this.snapshot.refresher });
  }
}

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await setImmediate(); }
  throw new Error("fixture transition not observed");
}

describe("native account-pool gateway", () => {
  test("selected concrete identity excludes other slots, empty providers and unselected API keys", async () => {
    const apiKey: SnapshotEntry = { id: 5, provider: "anthropic", identityKey: null, rotatesInMs: null, credential: { type: "api_key", key: "fixture-key-never-admitted" } };
    expect(resolveCredentialIdentityKey("anthropic", apiKey.credential)).toBeNull();
    const fixture = new FixtureBroker([credential(1, "chosen"), credential(2, "other"), credential(3, "chosen", "openai-codex"), credential(4, "chosen", "github-copilot"), apiKey, credential(6, "chosen")]);
    const inputs = parseInputs(broker, { anthropic: [{ credentialId: 1, identityKey: "chosen" }], "openai-codex": [] }, serviceBearer);
    const controller = new AbortController();
    const storage = await openPoolStorage(broker, inputs.accountPool, controller.signal, fixture.fetch);
    try {
      expect(storage.remote.listAuthCredentials().map(entry => entry.id)).toEqual([1]);
      expect(await storage.getApiKey("openai-codex")).toBeUndefined();
      expect(await storage.getApiKey("github-copilot")).toBeUndefined();
      const models = poolModels(inputs.accountPool);
      expect(models.get("anthropic/claude-sonnet-4-5")).toMatchObject({ provider: "anthropic", id: "claude-sonnet-4-5", api: "anthropic-messages" });
      expect([...models.values()].every(model => model.provider === "anthropic")).toBe(true);
      expect(models.has("claude-sonnet-4-5")).toBe(false);
    } finally { controller.abort(); storage.close(); }
  });

  test("real SDK selects an authorized API-key slot and never falls back to its unselected peers", async () => {
    const selected: SnapshotEntry = { id: 7, provider: "openai", identityKey: null, rotatesInMs: null, credential: { type: "api_key", key: "fixture-selected-api-key" } };
    const peer: SnapshotEntry = { ...selected, id: 8, credential: { type: "api_key", key: "fixture-unselected-api-key" } };
    const fixture = new FixtureBroker([selected, peer, { ...peer, id: 9, provider: "anthropic" }]);
    const inputs = parseInputs(broker, { openai: [{ credentialId: 7, identityKey: null }] }, serviceBearer);
    const controller = new AbortController();
    const storage = await openPoolStorage(broker, inputs.accountPool, controller.signal, fixture.fetch);
    try {
      await fixture.listening.promise;
      expect(await storage.getApiKey("openai", "api-key-session")).toBe("fixture-selected-api-key");
      expect(await storage.getApiKey("anthropic")).toBeUndefined();
      // Rotating bytes in the same authorized slot is allowed without widening it.
      fixture.send({ kind: "entry", entry: { ...selected, credential: { type: "api_key", key: "fixture-rotated-api-key" } }, generation: 2, serverNowMs: Date.now(), refresher: fixture.snapshot.refresher });
      await eventually(() => storage.remote.listAuthCredentials("openai").some(entry => entry.credential.type === "api_key" && entry.credential.key === "fixture-rotated-api-key"));
      expect(await storage.getApiKey("openai", "api-key-session")).toBe("fixture-rotated-api-key");
      // Null does not admit an OAuth identity newly assigned to the same row.
      fixture.send({ kind: "entry", entry: credential(7, "new-identity", "openai"), generation: 3, serverNowMs: Date.now(), refresher: fixture.snapshot.refresher });
      await eventually(() => storage.remote.listAuthCredentials("openai").length === 0);
      expect(await storage.getApiKey("openai", "api-key-session")).toBeUndefined();
    } finally { controller.abort(); storage.close(); }
  });

  test("snapshot changes and caller mutations cannot expand frozen concrete slots", async () => {
    const fixture = new FixtureBroker([credential(1, "chosen"), credential(2, "chosen")]);
    const pool = { anthropic: [{ credentialId: 1, identityKey: "chosen" }] };
    const client = new PoolBrokerClient({ ...broker, fetchImpl: fixture.fetch }, pool);
    pool.anthropic[0]!.credentialId = 2;
    const first = await client.fetchSnapshot();
    if (first.status !== 200) throw new Error("Missing snapshot");
    expect(first.snapshot.credentials.map(entry => entry.id)).toEqual([1]);
    fixture.snapshot = { ...fixture.snapshot, generation: 2, credentials: [credential(1, "changed"), credential(2, "chosen")] };
    const changed = await client.fetchSnapshot();
    if (changed.status !== 200) throw new Error("Missing snapshot");
    expect(changed.snapshot.credentials).toEqual([]);
  });

  test("refresh cannot act on an unselected slot or substitute another selected slot", async () => {
    const fixture = new FixtureBroker([credential(1, "chosen"), credential(2, "other")]);
    const inputs = parseInputs(broker, { anthropic: [{ credentialId: 1, identityKey: "chosen" }, { credentialId: 2, identityKey: "other" }] }, serviceBearer);
    const controller = new AbortController();
    const storage = await openPoolStorage(broker, inputs.accountPool, controller.signal, fixture.fetch);
    try {
      await fixture.listening.promise;
      await expect(storage.remote.markCredentialSuspect(3)).rejects.toThrow("gateway_unavailable");
      storage.pinSessionOAuthAccount("anthropic", "refresh-mismatch-session", 1);
      expect(await storage.getApiKey("anthropic", "refresh-mismatch-session")).toBe("fixture-access-1");
      fixture.refreshEntry = credential(2, "other");
      await expect(storage.remote.markCredentialSuspect(1)).rejects.toThrow("gateway_unavailable");
      expect(storage.remote.listAuthCredentials().map(entry => entry.id)).toEqual([1, 2]);
      expect(await storage.getApiKey("anthropic", "refresh-mismatch-session")).toBe("fixture-access-1");
    } finally { controller.abort(); storage.close(); }
  });

  test("real SDK storage observes live disable and cannot reuse the selected bearer", async () => {
    const fixture = new FixtureBroker([credential(1, "chosen"), credential(2, "other")]);
    const controller = new AbortController();
    const inputs = parseInputs(broker, { anthropic: [{ credentialId: 1, identityKey: "chosen" }] }, serviceBearer);
    const storage = await openPoolStorage(broker, inputs.accountPool, controller.signal, fixture.fetch);
    try {
      await fixture.listening.promise;
      expect(await storage.getApiKey("anthropic", "fixture-session")).toBe("fixture-access-1");
      fixture.remove(1);
      await eventually(() => storage.remote.listAuthCredentials().length === 0);
      expect(await storage.getApiKey("anthropic", "fixture-session")).toBeUndefined();
    } finally { controller.abort(); storage.close(); }
    await fixture.disconnected.promise;
  });

  test("refresh uses the SDK broker hook and refuses an identity change", async () => {
    const entry = credential(1, "chosen");
    const fixture = new FixtureBroker([entry]);
    const controller = new AbortController();
    const inputs = parseInputs(broker, { anthropic: [{ credentialId: 1, identityKey: "chosen" }] }, serviceBearer);
    const storage = await openPoolStorage(broker, inputs.accountPool, controller.signal, fixture.fetch);
    try {
      await fixture.listening.promise;
      fixture.refreshEntry = { ...entry, credential: { ...entry.credential, type: "oauth", access: "fixture-rotated-access", refresh: "__remote__", expires: Date.now() + 3600_000 } };
      await storage.remote.markCredentialSuspect(1);
      await eventually(() => storage.remote.listAuthCredentials("anthropic").some(current =>
        current.credential.type === "oauth" && current.credential.access === "fixture-rotated-access"));
      expect(await storage.getApiKey("anthropic")).toBe("fixture-rotated-access");
      fixture.refreshEntry = credential(1, "unlisted");
      await expect(storage.remote.markCredentialSuspect(1)).rejects.toThrow("gateway_unavailable");
      expect(await storage.getApiKey("anthropic")).toBeUndefined();
    } finally { controller.abort(); storage.close(); }
  });

  test("an accepted SSE identity change removes the selected account", async () => {
    const fixture = new FixtureBroker([credential(1, "chosen")]);
    const inputs = parseInputs(broker, { anthropic: [{ credentialId: 1, identityKey: "chosen" }] }, serviceBearer);
    const controller = new AbortController();
    const storage = await openPoolStorage(broker, inputs.accountPool, controller.signal, fixture.fetch);
    try {
      await fixture.listening.promise;
      expect(await storage.getApiKey("anthropic", "identity-session")).toBe("fixture-access-1");
      fixture.send({ kind: "entry", entry: credential(1, "unlisted"), generation: 2, serverNowMs: Date.now(), refresher: fixture.snapshot.refresher });
      await eventually(() => storage.remote.snapshot.generation === 2);
      expect(await storage.getApiKey("anthropic", "identity-session")).toBeUndefined();
    } finally { controller.abort(); storage.close(); }
  });

  test("rejected stale stream frames cannot restore removed accounts or hide the current selection", async () => {
    const marker: SnapshotEntry = { id: 9, provider: "openai", identityKey: null, rotatesInMs: null,
      credential: { type: "api_key", key: "fixture-stream-marker-before" } };
    const fixture = new FixtureBroker([credential(1, "removed"), marker]);
    const obsolete = fixture.snapshot;
    const inputs = parseInputs(broker, {
      anthropic: [{ credentialId: 1, identityKey: "removed" }, { credentialId: 2, identityKey: "current" }],
      openai: [{ credentialId: 9, identityKey: null }],
    }, serviceBearer);
    const controller = new AbortController();
    const storage = await openPoolStorage(broker, inputs.accountPool, controller.signal, fixture.fetch);
    try {
      await fixture.listening.promise;
      expect(await storage.getApiKey("anthropic", "stale-stream-session")).toBe("fixture-access-1");
      fixture.snapshot = { ...fixture.snapshot, generation: 2, credentials: [...fixture.snapshot.credentials, credential(2, "current")] };
      fixture.send({ kind: "entry", entry: credential(2, "current"), generation: 2,
        serverNowMs: Date.now(), refresher: fixture.snapshot.refresher });
      fixture.remove(1);
      await eventually(() => storage.remote.snapshot.generation === 3);
      expect(await storage.getApiKey("anthropic", "stale-stream-session")).toBe("fixture-access-2");
      const revocation = storage.remote.revocation;

      fixture.send({ kind: "entry", entry: credential(1, "removed"), generation: 1,
        serverNowMs: Date.now(), refresher: obsolete.refresher });
      fixture.send({ kind: "removed", id: 2, generation: 1,
        serverNowMs: Date.now(), refresher: obsolete.refresher });
      fixture.send({ kind: "entry", entry: credential(2, "unlisted"), generation: 1,
        serverNowMs: Date.now(), refresher: obsolete.refresher });
      fixture.send({ ...obsolete, kind: "snapshot" });
      // FIFO delivery of an accepted, unrelated slot is the processing barrier:
      // it must not repair the current account that the obsolete frames omit.
      fixture.send({ kind: "entry", entry: { ...marker, credential: { type: "api_key", key: "fixture-stream-marker-after" } },
        generation: 4, serverNowMs: Date.now(), refresher: fixture.snapshot.refresher });
      await eventually(() => storage.remote.snapshot.generation === 4);
      expect(await storage.getApiKey("anthropic", "stale-stream-session")).toBe("fixture-access-2");
      expect(storage.remote.listAuthCredentials("anthropic").map(entry => entry.id)).toEqual([2]);
      expect(await storage.getApiKey("openai")).toBe("fixture-stream-marker-after");
      expect(storage.remote.revocation).toBe(revocation);
    } finally { controller.abort(); storage.close(); }
  });

  test("sealed endpoint validation rejects authority tricks and strips ambient credentials before SDK loading", () => {
    for (const url of ["https://127.0.0.1:12345", "http://localhost:12345", "http://127.1:12345", "http://127.0.0.1:12345/v1", "http://127.0.0.1:12345?token=secret", "http://127.0.0.1:65536"]) {
      expect(() => parseInputs({ ...broker, url }, {}, serviceBearer)).toThrow();
    }
    expect(() => parseInputs(broker, { anthropic: [{ credentialId: 1, identityKey: "chosen" }, { credentialId: 1, identityKey: "chosen" }] }, serviceBearer)).toThrow();
    expect(() => parseInputs(broker, { anthropic: [{ credentialId: 0, identityKey: null }] }, serviceBearer)).toThrow();
    expect(() => parseInputs(broker, { anthropic: ["chosen"] }, serviceBearer)).toThrow();
    const environment: NodeJS.ProcessEnv = { PATH: "/bin", MANIFOLD_JOB_CONTEXT_FD: "3", ANTHROPIC_API_KEY: "private", HOME: "/source", HTTP_PROXY: "secret", PI_DEBUG_STARTUP: "1" };
    isolateEnvironment(environment);
    expect(environment).toEqual({ PATH: "/bin", MANIFOLD_JOB_CONTEXT_FD: "3", HOME: "/inputs" });
  });

  test("SSE failure projection discards raw SDK diagnostics across chunk boundaries", async () => {
    const model = [...poolModels(parseInputs(broker, { anthropic: [{ credentialId: 1, identityKey: "chosen" }] }, serviceBearer).accountPool).values()][0]!;
    const raw = `data: ${JSON.stringify({ type: "error", reason: "error", error: { errorMessage: "fixture-source-token", content: [{ type: "text", text: "fixture-credential-body" }] } })}\n\n`;
    const bytes = new TextEncoder().encode(raw);
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice(0, 17)); controller.enqueue(bytes.slice(17)); controller.close(); } });
    const projected = await new Response(safeNativeStream(source, model)).text();
    expect(projected).not.toContain("fixture-source-token");
    expect(projected).not.toContain("fixture-credential-body");
    const event = JSON.parse(projected.split("\n")[0]!.slice(6));
    expect(event.error).toMatchObject({ provider: model.provider, model: model.id, api: model.api, stopReason: "error", content: [] });
  });

  test("worker startup refusal contains stdout and raw exception output", async () => {
    const child = Bun.spawn([process.execPath, new URL("./entry.ts", import.meta.url).pathname], {
      env: { MANIFOLD_JOB_CONTEXT_FD: "invalid-fixture-source-token", ANTHROPIC_API_KEY: "fixture-provider-token" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("gateway_unavailable\n");
  });

  test("owner abort cancels startup broker requests without creating a listener", async () => {
    const entered = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const controller = new AbortController();
    const blockedFetch: typeof fetch = Object.assign((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      entered.resolve();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => { stopped.resolve(); reject(new Error("fixture-private-broker-error")); }, { once: true });
      });
    }, { preconnect: fetch.preconnect });
    const opening = startPoolGateway(parseInputs(broker, { anthropic: [{ credentialId: 1, identityKey: "chosen" }] }, serviceBearer), controller.signal, blockedFetch);
    await entered.promise;
    controller.abort();
    await stopped.promise;
    await expect(opening).rejects.toThrow("gateway_unavailable");
  });

  test("real SDK gateway publishes only authenticated native models and closes its broker watch", async () => {
    const fixture = new FixtureBroker([]);
    const controller = new AbortController();
    const gateway = await startPoolGateway(parseInputs(broker, { anthropic: [{ credentialId: 1, identityKey: "chosen" }] }, serviceBearer), controller.signal, fixture.fetch);
    const url = `http://127.0.0.1:${gateway.port}`;
    try {
      expect((await fetch(url + "/v1/models")).status).toBe(401);
      const headers = { Authorization: `Bearer ${serviceBearer}`, "x-omp-install-id": "00000000-0000-4000-8000-000000000001" };
      expect((await fetch(url + "/v1/credentials/check", { headers })).status).toBe(404);
      const listed = await (await fetch(url + "/v1/models", { headers })).json();
      expect(listed.data.every((model: { owned_by: string }) => model.owned_by === "anthropic")).toBe(true);
      const response = await fetch(url + "/v1/pi/stream", { method: "POST", headers, body: JSON.stringify({ modelId: listed.data[0].id, context: { messages: [] } }) });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("No credential available");
    } finally { controller.abort(); await gateway.close(); }
    await fixture.disconnected.promise;
    await expect(fetch(url + "/v1/models")).rejects.toThrow();
  });
});
