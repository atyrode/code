import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function runIsolatedSdkScenario(source: URL): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "code-sdk-scenario-"));
  let exited = false;
  let spawned = false;
  let result: "pass" | "fail" | undefined;
  let failure = "scenario-failed";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await chmod(root, 0o700);
    await Promise.all(["home", "cwd", "tmp", "config", "data", "state", "cache", "runtime", "agent"]
      .map(name => mkdir(join(root, name), { mode: 0o700 })));
    const child = spawn(process.execPath, ["--no-env-file", "--no-install", fileURLToPath(source)], {
      cwd: join(root, "cwd"),
      env: {
        HOME: join(root, "home"), USERPROFILE: join(root, "home"), PWD: join(root, "cwd"),
        TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
        XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
        XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
        XDG_RUNTIME_DIR: join(root, "runtime"), PI_CODING_AGENT_DIR: join(root, "agent"),
        CODE_SDK_SCENARIO_ROOT: root, NODE_ENV: "test", LANG: "C", TZ: "UTC", TERM: "dumb",
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    spawned = true;
    const closed = new Promise<number | null>(resolve => {
      child.once("error", () => { result = "fail"; failure = "child-startup-failed"; });
      child.once("close", code => { exited = true; resolve(code); });
    });
    child.on("message", value => {
      if (result !== undefined || !value || typeof value !== "object" || !("ok" in value)) {
        result = "fail";
        failure = "invalid-scenario-result";
      } else if (value.ok === true) {
        result = "pass";
      } else {
        result = "fail";
        if ("code" in value && typeof value.code === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(value.code)) failure = value.code;
      }
    });
    const deadline = Promise.withResolvers<undefined>();
    timer = setTimeout(() => {
      result = "fail";
      failure = "scenario-timed-out";
      child.kill("SIGKILL");
      timer = setTimeout(() => deadline.resolve(undefined), 5_000);
    }, 20_000);
    const code = await Promise.race([closed, deadline.promise]);
    if (!exited) throw new Error("Isolated SDK scenario: termination unobserved; private state retained");
    if (code !== 0 || result !== "pass") throw new Error(`Isolated SDK scenario: ${failure}`);
  } finally {
    if (timer) clearTimeout(timer);
    // Do not remove a live child's backing store if termination could not be observed.
    if (!spawned || exited) await rm(root, { recursive: true, force: true });
  }
}

export interface SdkScenarioContext {
  root: string;
  check(condition: unknown, code: string): asserts condition;
  fetchTo(origin: string): typeof fetch;
}

class ScenarioFailure extends Error {
  constructor(readonly code: string) { super("Synthetic SDK assertion failed"); }
}

export async function runSdkScenario(run: (context: SdkScenarioContext) => Promise<void>): Promise<never> {
  process.umask(0o077);
  let outbound = 0;
  const originalFetch = globalThis.fetch;
  const blocked = (): never => { outbound++; throw new ScenarioFailure("unexpected-network-request"); };
  let outcome: { ok: boolean; code?: string };
  try {
    const root = process.env.CODE_SDK_SCENARIO_ROOT;
    if (!root || process.cwd() !== join(root, "cwd") || process.env.HOME !== join(root, "home")
      || process.env.PI_CODING_AGENT_DIR !== join(root, "agent") || !process.send) throw new ScenarioFailure("missing-child-isolation");
    Object.defineProperty(globalThis, "fetch", {
      value: Object.assign(blocked, { preconnect: blocked }), configurable: false, writable: false,
    });
    const { setTransports } = await import("@oh-my-pi/pi-utils/logger");
    setTransports({ console: false, file: false });
    const context: SdkScenarioContext = {
      root,
      check(condition, code): asserts condition {
        if (!condition) throw new ScenarioFailure(/^[a-z][a-z0-9-]{0,79}$/.test(code) ? code : "scenario-assertion");
      },
      fetchTo(origin) {
        const allowed = new URL(origin);
        if (allowed.protocol !== "http:" || allowed.hostname !== "127.0.0.1" || !allowed.port
          || allowed.origin !== origin) throw new ScenarioFailure("invalid-fixture-origin");
        return Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.origin !== origin) return blocked();
          return originalFetch(input, { ...init, redirect: "error" });
        }, { preconnect: blocked });
      },
    };
    await run(context);
    context.check(outbound === 0, "unexpected-network-request");
    outcome = { ok: true };
  } catch (error) {
    outcome = { ok: false, code: error instanceof ScenarioFailure ? error.code : "scenario-runtime-error" };
  }
  if (!process.send || !process.connected) process.exit(1);
  const delivered = await new Promise<boolean>(resolve => {
    try { process.send?.(outcome, error => resolve(!error)); }
    catch { resolve(false); }
  });
  if (process.connected) process.disconnect?.();
  process.exit(outcome.ok && delivered ? 0 : 1);
}
