import { join } from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { AuthBrokerServerHandle } from "@oh-my-pi/pi-ai/auth-broker/server";
import type { SyntheticBrokerAccount } from "./synthetic-broker.ts";

// Only built-ins and erased types may precede isolation and network containment.
process.umask(0o077);
const root = process.env.CODE_SYNTHETIC_BROKER_ROOT;
const bearer = process.env.CODE_SYNTHETIC_BROKER_TOKEN;
delete process.env.CODE_SYNTHETIC_BROKER_TOKEN;

let storage: AuthStorage | undefined;
let broker: AuthBrokerServerHandle | undefined;
let failed = false;
let stopping: Promise<void> | undefined;
let boot: Promise<void>;

function send(message: object): Promise<boolean> {
  if (!process.connected || !process.send) return Promise.resolve(false);
  const { promise, resolve } = Promise.withResolvers<boolean>();
  try { process.send(message, error => resolve(!error)); }
  catch { resolve(false); }
  return promise;
}

function fail(code: "startup" | "runtime" | "outbound-traffic" | "cleanup"): void {
  failed = true;
  void send({ kind: "failure", code });
}

function shutdown(): Promise<void> {
  return stopping ??= (async () => {
    // A close received during SDK import must also close resources created later.
    await boot.catch(() => {});
    try { await broker?.close(); } catch { fail("cleanup"); }
    try { storage?.close(); } catch { fail("cleanup"); }
    const sent = await send({ kind: "closed", ok: !failed });
    if (process.connected) process.disconnect?.();
    process.exit(!failed && sent ? 0 : 1);
  })();
}

function blockOutbound(): never {
  fail("outbound-traffic");
  queueMicrotask(() => { void shutdown(); });
  // Never embed a URL, headers, tokens, or the upstream exception in diagnostics.
  throw new Error("Synthetic broker fixture forbids outbound traffic");
}

const blockedFetch = Object.assign(blockOutbound, { preconnect: blockOutbound });
// Guard the SDK's global fetch before importing its runtime modules.
Object.defineProperty(globalThis, "fetch", { value: blockedFetch, configurable: false, writable: false });

process.on("message", message => {
  if (message && typeof message === "object" && "kind" in message && message.kind === "close") {
    void shutdown();
  } else {
    fail("runtime");
    void shutdown();
  }
});
process.once("disconnect", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
process.on("uncaughtException", () => { fail("runtime"); void shutdown(); });
process.on("unhandledRejection", () => { fail("runtime"); void shutdown(); });

boot = (async () => {
  if (!root || !bearer || !/^synthetic-broker-[a-f0-9]{64}$/.test(bearer) || !process.send
    || process.cwd() !== join(root, "cwd") || process.env.HOME !== join(root, "home")
    || process.env.PI_CODING_AGENT_DIR !== join(root, "agent")) {
    throw new Error("Synthetic broker fixture isolation prerequisites missing");
  }

  // The logger is lazy; disable its transports before importing any SDK consumer.
  // HOME/cwd/XDG were isolated by exec, so even eager SDK dotenv reads stay private.
  const { setTransports } = await import("@oh-my-pi/pi-utils/logger");
  setTransports({ console: false, file: false });
  const { AuthStorage } = await import("@oh-my-pi/pi-ai/auth-storage");
  const { startAuthBroker } = await import("@oh-my-pi/pi-ai/auth-broker/server");
  storage = await AuthStorage.create(join(root, "state", "synthetic-auth.db"));

  const accounts: SyntheticBrokerAccount[] = [];
  const expires = Date.now() + 365 * 24 * 60 * 60 * 1_000;
  for (const provider of ["anthropic", "openai-codex"] as const) {
    const prefix = provider === "anthropic" ? "anthropic" : "openai";
    for (let index = 1; index <= 2; index++) {
      const label = `${prefix}-${index}`;
      const email = `${label}@accounts.invalid`;
      const entries = storage.upsertCredential(provider, {
        type: "oauth", email, expires,
        access: `SYNTHETIC-NOT-A-REAL-ACCESS-TOKEN-${label}`,
        refresh: `SYNTHETIC-NOT-A-REAL-REFRESH-TOKEN-${label}`,
        accountId: `synthetic-account-${label}`,
        orgId: `synthetic-org-${label}`,
      });
      const entry = entries.find(candidate => candidate.credential.type === "oauth" && candidate.credential.email === email);
      if (!entry || !entry.identityKey) throw new Error("Synthetic identity was not persisted");
      accounts.push({ id: entry.id, provider, identityKey: entry.identityKey, type: "oauth", label });
    }
  }
  for (let index = 1; index <= 2; index++) {
    const label = `deepseek-${index}`;
    const entries = storage.upsertCredential("deepseek", {
      type: "api_key", key: `SYNTHETIC-NOT-A-REAL-API-KEY-${label}`,
    });
    const entry = entries.find(candidate => candidate.credential.type === "api_key"
      && candidate.credential.key === `SYNTHETIC-NOT-A-REAL-API-KEY-${label}`);
    if (!entry || entry.identityKey !== null) throw new Error("Synthetic API key was not persisted");
    accounts.push({ id: entry.id, provider: "deepseek", identityKey: null, type: "api_key", label });
  }
  if (storage.exportSnapshot().credentials.length !== 6 || failed) throw new Error("Synthetic fixture seed failed");

  broker = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: [bearer], disableRefresher: true });
  if (!await send({ kind: "ready", url: broker.url, accounts })) throw new Error("Synthetic fixture parent unavailable");
})().catch(() => {
  fail("startup");
  void shutdown();
});
