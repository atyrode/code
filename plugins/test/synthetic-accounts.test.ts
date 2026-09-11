import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { setTransports } from "@oh-my-pi/pi-utils/logger";
import { initialAccountChoices, projectAccounts, reduceAccountChoices, selectedAccountPool } from "../domain/accounts.ts";
import { DomainError } from "../domain/contracts.ts";
import type { PoolAuthStorage } from "../workers/gateway/storage.ts";
import { startSyntheticBrokerFixture } from "./fixtures/synthetic-broker.ts";

// Match the private gateway's logging barrier before loading SDK runtime modules.
setTransports({ file: false, console: false });
const { AuthBrokerClient } = await import("@oh-my-pi/pi-ai/auth-broker/client");
const { openPoolStorage } = await import("../workers/gateway/storage.ts");

async function eventually(check: () => boolean, signal: AbortSignal): Promise<void> {
  while (!check()) await delay(10, undefined, { signal });
}

test("synthetic broker preserves multi-account identity and a disabled concrete pool slot cannot fall back to peers", async () => {
  const fixture = await startSyntheticBrokerFixture();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
  let storage: PoolAuthStorage | undefined;
  let forbiddenRequests = 0;
  let streaming = false;
  try {
    const selected = ["anthropic-2", "openai-1", "deepseek-2"].map(label => {
      const account = fixture.accounts.find(account => account.label === label);
      if (!account) throw new Error("Synthetic selected account missing");
      return account;
    });
    const revoked = selected.find(account => account.provider === "anthropic")!;
    // Every request still reaches the real broker. Disallow refresh/usage/inference,
    // including unexpected SDK requests, without mutating the suite's global fetch.
    const brokerFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const allowed = url.origin === new URL(fixture.broker.url).origin && !url.search &&
        ((method === "GET" && ["/v1/snapshot", "/v1/snapshot/stream"].includes(url.pathname)) ||
          (method === "POST" && url.pathname === `/v1/credential/${revoked.id}/disable`));
      if (!allowed) { forbiddenRequests++; throw new Error("Unexpected synthetic broker request"); }
      const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const response = await fetch(input, { ...init, redirect: "error", signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal });
      if (url.pathname === "/v1/snapshot/stream" && response.ok) streaming = true;
      return response;
    }, { preconnect: () => { forbiddenRequests++; throw new Error("Unexpected synthetic broker preconnect"); } });
    const client = new AuthBrokerClient({ ...fixture.broker, fetchImpl: brokerFetch, maxRetries: 0 });
    const unauthorized = await brokerFetch(`${fixture.broker.url}/v1/snapshot`);
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.text()).includes('"credentials"')).toBe(false);

    const initial = await client.fetchSnapshot({ signal });
    if (initial.status !== 200) throw new Error("Synthetic snapshot unavailable");
    const rows = initial.snapshot.credentials;
    const identities = rows.map(row => ({ id: row.id, provider: row.provider, identityKey: row.identityKey, type: row.credential.type }));
    expect(Object.fromEntries(["anthropic", "openai-codex", "deepseek"].map(provider =>
      [provider, rows.filter(row => row.provider === provider).length]))).toEqual({ anthropic: 2, "openai-codex": 2, deepseek: 2 });
    expect(new Set(identities)).toEqual(new Set(fixture.accounts.map(({ label: _label, ...account }) => account)));
    // The native service's metadata seam is outside this test. Feed its documented
    // public leaves to the real Code projector, and separately prove it rejects
    // broker credentials if that seam accidentally passes full credential objects.
    const metadata = { credentials: rows.map(row => ({ id: row.id, provider: row.provider, identityKey: row.identityKey,
      credential: { type: row.credential.type, ...(row.credential.type === "oauth" && row.credential.email ? { email: row.credential.email } : {}) } })) };
    const now = Date.now();
    const observation = projectAccounts(metadata, "synthetic-broker", now, now);
    expect(observation.status).toBe("fresh");
    expect(new Set(observation.accounts.map(account => account.credentialId))).toEqual(new Set(rows.map(row => row.id)));
    for (const row of rows) {
      expect(() => projectAccounts({ credentials: [{ ...metadata.credentials.find(account => account.id === row.id)!, credential: row.credential }] }, "synthetic-broker", now, now)).toThrow(DomainError);
    }
    let choices = initialAccountChoices();
    const selectedIds = new Set(selected.map(account => account.id));
    for (const account of observation.accounts) {
      if (!selectedIds.has(account.credentialId)) choices = reduceAccountChoices(choices,
        { kind: "set-account", reference: account.reference, enabled: false });
    }
    const pool = selectedAccountPool(observation, choices);
    expect(pool).toEqual(Object.fromEntries(selected.map(account =>
      [account.provider, [{ credentialId: account.id, identityKey: account.identityKey }]])));
    storage = await openPoolStorage(fixture.broker, pool, signal, brokerFetch);
    await eventually(() => streaming, signal);
    expect(new Set(storage.remote.listAuthCredentials().map(row => row.id))).toEqual(selectedIds);
    // One OAuth slot per provider avoids usage ranking; tokens are unexpired.
    // Do not resolve API-key providers here: the SDK consults ambient env keys.
    for (const account of selected.filter(account => account.type === "oauth")) {
      const row = rows.find(row => row.id === account.id)!;
      if (row.credential.type !== "oauth") throw new Error("Synthetic OAuth account missing");
      expect((await storage.getApiKey(account.provider, "synthetic-sticky-session")) === row.credential.access).toBe(true);
    }

    expect((await client.disableCredential(revoked.id, "synthetic integration revocation", signal)).ok).toBe(true);
    const current = await client.fetchSnapshot({ signal });
    if (current.status !== 200) throw new Error("Synthetic current snapshot unavailable");
    const remainingIds = new Set(rows.filter(row => row.id !== revoked.id).map(row => row.id));
    expect(new Set(current.snapshot.credentials.map(row => row.id))).toEqual(remainingIds);
    // This same storage instance receives removal from its real broker watch;
    // all unselected Anthropic peers remain available at the broker, not the pool.
    await eventually(() => !storage!.remote.listAuthCredentials().some(row => row.id === revoked.id), signal);
    expect(new Set(storage.remote.listAuthCredentials().map(row => row.id))).toEqual(new Set(selected.filter(account => account.id !== revoked.id).map(account => account.id)));
    expect((await storage.getApiKey(revoked.provider, "synthetic-sticky-session")) === undefined).toBe(true);
    expect((await storage.getApiKey(revoked.provider, "synthetic-new-session")) === undefined).toBe(true);
  } finally {
    controller.abort();
    try { storage?.close(); }
    finally {
      try { await fixture.close(); }
      finally { expect(forbiddenRequests).toBe(0); }
    }
  }
}, 30_000);
