import { expect, test } from "bun:test";
import { parseClientAccess } from "../workers/broker/inputs.ts";
import { runIsolatedSdkScenario } from "./fixtures/isolated-sdk";

const bearerSha256 = "abcdef0123456789".repeat(4);

test("client access accepts only complete verifier configuration at an exact unprivileged loopback bind", () => {
  expect(parseClientAccess({})).toBeUndefined();
  for (const port of [1024, 65535]) {
    const bind = `127.0.0.1:${port}`;
    expect(parseClientAccess({ bind, bearerSha256 })?.bind).toBe(bind);
  }
  for (const bind of [
    "0.0.0.0:46171", "localhost:46171", "127.1:46171", "[::1]:46171", "http://127.0.0.1:46171",
    "127.0.0.1:0", "127.0.0.1:1023", "127.0.0.1:65536", "127.0.0.1:046171", "127.0.0.1:46171\n",
  ]) {
    expect(() => parseClientAccess({ bind, bearerSha256 })).toThrow();
  }
  for (const value of [
    undefined, null, "", "{}", [], { bind: "127.0.0.1:46171" },
    { bind: "127.0.0.1:46171", bearerSha256, bearer: "synthetic-plaintext-must-not-enter-inputs" },
    { bind: "127.0.0.1:46171", bearerSha256: "" },
    { bind: "127.0.0.1:46171", bearerSha256: bearerSha256.toUpperCase() },
    { bind: "127.0.0.1:46171", bearerSha256: `${bearerSha256}\n` },
  ]) {
    expect(() => parseClientAccess(value)).toThrow();
  }
});

test("real broker preserves native and old-client authorization while refusing invalid verifiers and occupied fixed ports", async () => {
  await runIsolatedSdkScenario(new URL("./fixtures/broker-ingress.scenario.ts", import.meta.url));
}, 30_000);
