import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SyntheticBrokerAccount {
  id: number;
  provider: "anthropic" | "openai-codex" | "deepseek";
  identityKey: string | null;
  type: "oauth" | "api_key";
  label: string;
}

interface Ready {
  url: string;
  accounts: readonly SyntheticBrokerAccount[];
}

const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function parseReady(value: Record<string, unknown>): Ready | undefined {
  if (typeof value.url !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9]\d*$/.test(value.url)) return;
  if (!Array.isArray(value.accounts) || value.accounts.length !== 6) return;
  const accounts: SyntheticBrokerAccount[] = [];
  const ids = new Set<number>();
  const identities = new Set<string>();
  const labels = new Set<string>();
  for (const entry of value.accounts) {
    if (!entry || typeof entry !== "object") return;
    const { id, provider, identityKey, type, label } = entry;
    if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id) || typeof label !== "string" || labels.has(label)) return;
    if (provider === "anthropic" || provider === "openai-codex") {
      const pattern = provider === "anthropic" ? /^anthropic-[1-2]$/ : /^openai-[1-2]$/;
      if (!pattern.test(label) || type !== "oauth" || typeof identityKey !== "string" || !identityKey.includes(`${label}@accounts.invalid`)) return;
      if (identities.has(identityKey)) return;
      identities.add(identityKey);
    } else if (provider !== "deepseek" || !/^deepseek-[1-2]$/.test(label) || type !== "api_key" || identityKey !== null) return;
    ids.add(id);
    labels.add(label);
    accounts.push({ id, provider, identityKey, type, label });
  }
  return { url: value.url, accounts };
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<{ value: T } | undefined> {
  const timeout = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => timeout.resolve(undefined), milliseconds);
  try {
    return await Promise.race([
      promise.then(value => ({ value })),
      timeout.promise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Real upstream broker, with fake credentials confined to a disposable Bun child. */
export async function startSyntheticBrokerFixture(): Promise<{
  broker: { url: string; token: string };
  accounts: readonly SyntheticBrokerAccount[];
  close(): Promise<void>;
}> {
  if (typeof Bun === "undefined") throw new Error("Synthetic broker fixture requires Bun");
  const token = `synthetic-broker-${randomBytes(32).toString("hex")}`;
  let root: string;
  try {
    root = await mkdtemp(join(tmpdir(), "code-synthetic-broker-"));
  } catch {
    throw new Error("Synthetic broker fixture could not create private state");
  }
  let child: ChildProcess;
  try {
    await chmod(root, 0o700);
    const names = ["home", "cwd", "tmp", "config", "data", "state", "cache", "runtime", "agent"] as const;
    await Promise.all(names.map(name => mkdir(join(root, name), { mode: 0o700 })));
    // No inherited credentials, discovery paths, proxies, preload flags or SDK settings.
    child = spawn(process.execPath, ["--no-env-file", "--no-install", fileURLToPath(new URL("./synthetic-broker-child.ts", import.meta.url))], {
      cwd: join(root, "cwd"),
      env: {
        HOME: join(root, "home"), USERPROFILE: join(root, "home"), PWD: join(root, "cwd"),
        TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
        XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
        XDG_RUNTIME_DIR: join(root, "runtime"), PI_CODING_AGENT_DIR: join(root, "agent"),
        NODE_ENV: "test", LANG: "C", TZ: "UTC", TERM: "dumb",
        CODE_SYNTHETIC_BROKER_ROOT: root, CODE_SYNTHETIC_BROKER_TOKEN: token,
      },
      // SDK errors and console output must never escape. Only typed IPC is accepted.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  } catch {
    try { await rm(root, { recursive: true, force: true }); }
    catch { throw new Error("Synthetic broker fixture startup and private-state cleanup failed"); }
    throw new Error("Synthetic broker fixture could not spawn its isolated child");
  }

  const failures = new Set<string>();
  let acknowledgedClose = false;
  let exited = false;
  const { promise: ready, resolve: settleReady } = Promise.withResolvers<Ready | undefined>();
  const { promise: closed, resolve: settleClosed } = Promise.withResolvers<number | null>();
  child.once("close", code => {
    exited = true;
    settleReady(undefined);
    settleClosed(code);
  });
  const fail = (message: string) => {
    failures.add(message);
    settleReady(undefined);
  };
  child.on("error", () => fail("Synthetic broker fixture child process failed"));
  child.on("message", message => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      fail("Synthetic broker fixture received invalid child metadata");
      return;
    }
    const data = message as Record<string, unknown>;
    if (data.kind === "ready") {
      const parsed = parseReady(data);
      if (parsed) settleReady(parsed);
      else fail("Synthetic broker fixture received invalid account metadata");
    } else if (data.kind === "closed" && data.ok === true) {
      acknowledgedClose = true;
    } else if (data.kind === "failure") {
      fail(data.code === "outbound-traffic"
        ? "Synthetic broker fixture blocked attempted outbound provider traffic"
        : data.code === "cleanup"
          ? "Synthetic broker fixture child cleanup failed"
          : "Synthetic broker fixture child startup or runtime failed");
    } else {
      fail("Synthetic broker fixture child did not confirm clean shutdown");
    }
  });

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    if (!exited && child.connected) {
      try { child.send({ kind: "close" }, error => { if (error) fail("Synthetic broker fixture shutdown IPC failed"); }); }
      catch { fail("Synthetic broker fixture shutdown IPC failed"); }
    }
    let result = await within(closed, SHUTDOWN_TIMEOUT_MS);
    if (!result) {
      fail("Synthetic broker fixture child required forced shutdown");
      try { child.kill("SIGTERM"); } catch { /* Still attempt SIGKILL and observe exit. */ }
      result = await within(closed, 2_000);
      if (!result) {
        try { child.kill("SIGKILL"); } catch { /* Exit observation below remains authoritative. */ }
        result = await within(closed, 2_000);
      }
    }
    if (!result) throw new Error("Synthetic broker fixture child did not exit; private state retained");
    if (result.value !== 0 || !acknowledgedClose) fail("Synthetic broker fixture child exited without clean shutdown");
    try { await rm(root, { recursive: true, force: true }); }
    catch { throw new Error("Synthetic broker fixture private-state cleanup failed"); }
    if (failures.size > 0) throw new Error([...failures].join("; "));
  })();

  const started = await within(ready, STARTUP_TIMEOUT_MS);
  if (!started?.value || failures.size > 0 || exited) {
    fail(started ? "Synthetic broker fixture failed before readiness" : "Synthetic broker fixture readiness timed out");
    await close();
    throw new Error("Synthetic broker fixture failed before readiness");
  }
  return { broker: { url: started.value.url, token }, accounts: started.value.accounts, close };
}
