import { test } from "bun:test";
import { runIsolatedSdkScenario } from "./fixtures/isolated-sdk";

test("broker shutdown drains automatic and HTTP credential rotations with an open snapshot stream", async () => {
  await runIsolatedSdkScenario(new URL("./fixtures/broker-shutdown.scenario.ts", import.meta.url));
}, 30_000);
