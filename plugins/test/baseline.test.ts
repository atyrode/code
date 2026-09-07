import { describe, expect, test } from "bun:test";
import type { EmitEvent } from "@manifold/plugin";
import {
  CODE_PLUGIN_ID,
  LAUNCH_ACTION,
  LAUNCH_LEDGER_LIMIT,
  LAUNCH_RECORDED_EVENT,
  launchKey,
} from "../atyrode.code/contract.ts";
import plugin, { type LaunchContext } from "../atyrode.code/server.ts";

const { handlers } = plugin;

interface Fake {
  readonly ctx: LaunchContext;
  readonly store: Map<string, string>;
  readonly emits: Parameters<EmitEvent>[];
  tick(ms: number): void;
}

function fake(online: readonly string[], startAt = 1_000): Fake {
  const store = new Map<string, string>();
  const emits: Parameters<EmitEvent>[] = [];
  let now = startAt;
  let ids = 0;
  const ctx: LaunchContext = {
    pluginId: CODE_PLUGIN_ID,
    principal: { id: "p1" },
    now: () => now,
    newId: () => {
      ids += 1;
      return `id-${String(ids)}`;
    },
    storage: {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => {
        store.set(key, value);
      },
      delete: async (key) => {
        store.delete(key);
      },
      keys: async (prefix) =>
        [...store.keys()].filter((key) => prefix === undefined || key.startsWith(prefix)).sort(),
    },
    emit: (ref, kind, payload) => {
      emits.push([ref, kind, payload]);
    },
    machines: { isOnline: (id) => online.includes(id) },
  };
  return {
    ctx,
    store,
    emits,
    tick: (ms) => {
      now += ms;
    },
  };
}

describe("atyrode.code.launch", () => {
  test("refuses other programs before consulting machine availability", async () => {
    const { ctx, emits } = fake(["m1"]);
    ctx.machines.isOnline = () => {
      throw new Error("a refused program must not consult machine availability");
    };
    await expect(handlers.launch(ctx, { machineId: "m1", argv: ["bash", "-l"] })).resolves.toMatchObject({
      refused: expect.any(String),
    });
    await expect(handlers.listLaunches(ctx)).resolves.toEqual({ launches: [] });
    expect(emits).toEqual([]);
  });

  test("refuses offline machines without recording or emitting an authorization", async () => {
    const { ctx, emits } = fake(["m1"]);
    await expect(handlers.launch(ctx, { machineId: "m2", argv: ["code"] })).resolves.toMatchObject({
      refused: expect.any(String),
    });
    await expect(handlers.listLaunches(ctx)).resolves.toEqual({ launches: [] });
    expect(emits).toEqual([]);
  });

  test("exposes the caller's authorization in the ledger and announces it", async () => {
    const { ctx, emits } = fake(["m1"], 1_700_000_000_000);
    const result = await handlers.launch(ctx, {
      machineId: "m1",
      argv: ["code"],
      label: "code (interactive)",
    });
    expect(result).toEqual({ launchId: "id-1", argv: ["code"], recordedAt: 1_700_000_000_000 });
    await expect(handlers.listLaunches(ctx)).resolves.toEqual({
      launches: [{
        launchId: "id-1",
        machineId: "m1",
        argv: ["code"],
        label: "code (interactive)",
        recordedAt: 1_700_000_000_000,
        by: "p1",
      }],
    });
    expect(emits).toEqual([
      [
        { kind: "plugin", pluginId: CODE_PLUGIN_ID },
        LAUNCH_RECORDED_EVENT,
        { launchId: "id-1", machineId: "m1", recordedAt: 1_700_000_000_000 },
      ],
    ]);
  });

  test("the published input contract rejects an empty command", () => {
    const launch = plugin.actions.find((action) => action.name === LAUNCH_ACTION);
    expect(launch?.input.safeParse({ machineId: "m1", argv: [] }).success).toBe(false);
  });
});

describe("the authorization ledger", () => {
  test("keeps the newest fifty by timestamp across a decimal boundary", async () => {
    // Lexicographic ordering would put 1000 before 999 and prune the newest authorization.
    const { ctx, store, tick } = fake(["m1"], 950);
    for (let i = 0; i < LAUNCH_LEDGER_LIMIT + 1; i += 1) {
      await handlers.launch(ctx, { machineId: "m1", argv: ["code"] });
      tick(1);
    }
    expect(store.size).toBe(LAUNCH_LEDGER_LIMIT);
    expect(store.has(launchKey(950, "id-1"))).toBe(false);
    const { launches } = await handlers.listLaunches(ctx);
    expect(launches.map((launch) => launch.launchId)).toEqual(
      Array.from({ length: LAUNCH_LEDGER_LIMIT }, (_, index) =>
        `id-${String(LAUNCH_LEDGER_LIMIT + 1 - index)}`),
    );
  });

  test("lists nothing before the first authorization", async () => {
    const { ctx } = fake([]);
    await expect(handlers.listLaunches(ctx)).resolves.toEqual({ launches: [] });
  });
});
