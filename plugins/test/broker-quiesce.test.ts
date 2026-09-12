import { test } from "bun:test";
import { runIsolatedSdkScenario } from "./fixtures/isolated-sdk";

test("native broker controls drain detached usage rotations before reporting durable quiescence", async () => {
  await runIsolatedSdkScenario(new URL("./fixtures/broker-quiesce.scenario.ts", import.meta.url));
}, 30_000);
