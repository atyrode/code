import { test } from "bun:test";
import { runIsolatedSdkScenario } from "./fixtures/isolated-sdk.ts";

test("late broker mutation replies cannot restore removed rows or replace canonical credentials", async () => {
  await runIsolatedSdkScenario(new URL("./fixtures/broker-mutation-ordering.scenario.ts", import.meta.url));
}, 30_000);
