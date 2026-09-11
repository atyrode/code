import { test } from "bun:test";
import { runIsolatedSdkScenario } from "./fixtures/isolated-sdk.ts";

test("a live broker client accepts reset generations on reconnect without accepting later stale events", async () => {
  await runIsolatedSdkScenario(new URL("./fixtures/broker-restart.scenario.ts", import.meta.url));
}, 30_000);
