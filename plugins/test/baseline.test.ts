import { describe, expect, test } from "bun:test";
import { attachServerGuest, type GuestCtx, type GuestEmit } from "@manifold/plugin-kit/server";
import type { IsolateChildFrame, IsolateDispatchCtx, IsolateHostFrame } from "@manifold/protocol";
import {
  CODE_PLUGIN_ID,
  LAUNCH_ACTION,
  LAUNCH_DOOR,
  LAUNCH_LEDGER_LIMIT,
  LAUNCH_RECORDED_EVENT,
  LIST_LAUNCHES_DOOR,
  LaunchRecordSchema,
  launchKey,
} from "../atyrode.code/contract.ts";
import { handlers, plugin } from "../atyrode.code/server.ts";

/**
 * THE BASELINE'S DOORS against a fake ctx: what `launch` refuses, what it writes and emits
 * when it does not, how the ledger is bounded and read back. The last block drives the whole
 * definition through the kit's own transport, which is what the supervisor does at load and
 * at every dispatch.
 */

const principal = { id: "p1", kind: "human", name: "Ada", color: "#e03131" } as const;

interface Fake {
  readonly ctx: GuestCtx;
  readonly store: Map<string, string>;
  readonly emits: Parameters<GuestEmit>[];
  tick(ms: number): void;
}

function fake(online: readonly string[], startAt = 1_000): Fake {
  const store = new Map<string, string>();
  const emits: Parameters<GuestEmit>[] = [];
  let now = startAt;
  let ids = 0;
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} is not part of this test`);
  };
  const ctx: GuestCtx = {
    pluginId: CODE_PLUGIN_ID,
    principal,
    auth: {
      principal,
      caps: ["terminals:spawn"],
      containerScope: null,
      isRoot: false,
      allows: async () => true,
    },
    containerScope: null,
    outsideScope: async () => null,
    now: () => now,
    newId: async () => {
      ids += 1;
      return `id-${String(ids)}`;
    },
    storage: {
      pluginId: CODE_PLUGIN_ID,
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
    machines: { isOnline: async (id) => online.includes(id) },
    placement: { place: unused("placement.place") },
    host: { roster: unused("host.roster"), enabled: async () => true },
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
  test("refuses any program but code, before asking the host anything", async () => {
    const { ctx, store, emits } = fake(["m1"]);
    await expect(handlers.launch(ctx, { machineId: "m1", argv: ["bash", "-l"] })).resolves.toEqual({
      refused: "only the code launcher may be launched",
    });
    expect(store.size).toBe(0);
    expect(emits).toEqual([]);
  });

  test("refuses an offline machine by id", async () => {
    const { ctx, store } = fake(["m1"]);
    await expect(handlers.launch(ctx, { machineId: "m2", argv: ["code"] })).resolves.toEqual({
      refused: "machine m2 is offline",
    });
    expect(store.size).toBe(0);
  });

  test("records one row under the clock-first key, attributed to the caller, and emits", async () => {
    const { ctx, store, emits } = fake(["m1"], 1_700_000_000_000);
    const result = await handlers.launch(ctx, {
      machineId: "m1",
      argv: ["code"],
      label: "code (interactive)",
    });
    expect(result).toEqual({ launchId: "id-1", argv: ["code"], recordedAt: 1_700_000_000_000 });
    const key = launchKey(1_700_000_000_000, "id-1");
    expect([...store.keys()]).toEqual([key]);
    expect(LaunchRecordSchema.parse(JSON.parse(store.get(key) ?? ""))).toEqual({
      launchId: "id-1",
      machineId: "m1",
      argv: ["code"],
      label: "code (interactive)",
      recordedAt: 1_700_000_000_000,
      by: "p1",
    });
    expect(emits).toEqual([
      [
        { kind: "plugin", pluginId: CODE_PLUGIN_ID },
        LAUNCH_RECORDED_EVENT,
        { launchId: "id-1", machineId: "m1", recordedAt: 1_700_000_000_000 },
      ],
    ]);
  });

  test("a row without a label stores no label key", async () => {
    const { ctx, store } = fake(["m1"]);
    await handlers.launch(ctx, { machineId: "m1", argv: ["code", "--help"] });
    const [row] = [...store.values()];
    expect(JSON.parse(row ?? "")).not.toHaveProperty("label");
  });
});

describe("the ledger", () => {
  test("keeps the newest fifty by the clock, not by key string order", async () => {
    // Starting at 950 and ticking by one crosses 999 -> 1000: as strings, "1000-…" sorts BEFORE
    // "999-…", so a prune ordering by string luck would delete the wrong row.
    const { ctx, store, tick } = fake(["m1"], 950);
    for (let i = 0; i < LAUNCH_LEDGER_LIMIT + 1; i += 1) {
      await handlers.launch(ctx, { machineId: "m1", argv: ["code"] });
      tick(1);
    }
    expect(store.size).toBe(LAUNCH_LEDGER_LIMIT);
    expect(store.has(launchKey(950, "id-1"))).toBe(false);
    expect(store.has(launchKey(951, "id-2"))).toBe(true);
    const { launches } = await handlers.listLaunches(ctx);
    expect(launches.map((l) => l.launchId)[0]).toBe(`id-${String(LAUNCH_LEDGER_LIMIT + 1)}`);
    expect(launches.map((l) => l.launchId).at(-1)).toBe("id-2");
    expect(launches.map((l) => l.recordedAt)).toEqual(
      [...launches].map((l) => l.recordedAt).sort((a, b) => b - a),
    );
  });

  test("lists nothing when nothing was recorded", async () => {
    const { ctx } = fake([]);
    await expect(handlers.listLaunches(ctx)).resolves.toEqual({ launches: [] });
  });
});

// ---------------------------------------------------------------------------- the transport

interface FakeHost {
  send(frame: IsolateHostFrame): void;
  next(): Promise<IsolateChildFrame>;
}

function host(): FakeHost {
  const queue: IsolateChildFrame[] = [];
  const waiting: ((frame: IsolateChildFrame) => void)[] = [];
  let listener: (frame: unknown) => void = () => {};
  attachServerGuest(plugin, {
    send: (frame) => {
      const waiter = waiting.shift();
      if (waiter === undefined) queue.push(frame);
      else waiter(frame);
    },
    onMessage: (next) => {
      listener = next;
    },
    exit: () => {},
    warn: () => {},
  });
  return {
    send: (frame) => listener(frame),
    next: () => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      const { promise, resolve } = Promise.withResolvers<IsolateChildFrame>();
      waiting.push(resolve);
      return promise;
    },
  };
}

/** Answers the child's next `call` with `result`, returning the call it answered. */
async function serve(
  fake: FakeHost,
  result: unknown,
): Promise<Extract<IsolateChildFrame, { t: "call" }>> {
  const frame = await fake.next();
  if (frame.t !== "call") throw new Error(`expected a call, got ${frame.t}`);
  fake.send({ t: "reply", id: frame.id, ok: true, result });
  return frame;
}

async function loaded(fake: FakeHost): Promise<Extract<IsolateChildFrame, { t: "loaded" }>> {
  fake.send({ t: "load", pluginId: CODE_PLUGIN_ID, manifest: plugin.manifest, dir: "/nowhere" });
  const frame = await fake.next();
  if (frame.t !== "loaded") throw new Error(`expected loaded, got ${frame.t}`);
  return frame;
}

const dispatchCtx: IsolateDispatchCtx = {
  principal,
  caps: ["terminals:spawn"],
  isRoot: false,
  containerScope: null,
  now: 1_000,
};

describe("through the kit's transport", () => {
  test("load publishes both doors with their caps and JSON Schemas", async () => {
    const frame = await loaded(host());
    expect(frame.actions.map((a) => [a.name, a.caps])).toEqual([
      [LAUNCH_DOOR, ["terminals:spawn"]],
      [LIST_LAUNCHES_DOOR, []],
    ]);
    const [launch] = frame.actions;
    expect(launch?.input).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["machineId", "argv"]),
    });
    expect(launch?.result).toMatchObject({ type: "object" });
    expect(frame.hooks).toEqual({ onEnable: false, onDisable: false, onAssemblyChanged: false });
  });

  test("an empty argv is graded invalid_args in the child, before any call", async () => {
    const fake = host();
    await loaded(fake);
    fake.send({
      t: "dispatch",
      id: "r1",
      action: LAUNCH_ACTION,
      args: { machineId: "m1", argv: [] },
      ctx: dispatchCtx,
    });
    expect(await fake.next()).toMatchObject({
      t: "dispatched",
      id: "r1",
      outcome: { ok: false, rule: "invalid_args" },
    });
  });

  test("a launch rides the boundary as calls and comes back with its emission", async () => {
    const fake = host();
    await loaded(fake);
    fake.send({
      t: "dispatch",
      id: "r2",
      action: LAUNCH_ACTION,
      args: { machineId: "m1", argv: ["code"] },
      ctx: dispatchCtx,
    });
    expect(await serve(fake, true)).toMatchObject({ method: "machines.isOnline", args: ["m1"] });
    expect(await serve(fake, "uuid-1")).toMatchObject({ method: "newId" });
    const key = launchKey(1_000, "uuid-1");
    expect(await serve(fake, undefined)).toMatchObject({
      method: "storage.set",
      args: [key, expect.stringContaining('"launchId":"uuid-1"')],
    });
    expect(await serve(fake, [key])).toMatchObject({ method: "storage.keys", args: ["launches/"] });
    expect(await fake.next()).toEqual({
      t: "dispatched",
      id: "r2",
      outcome: {
        ok: true,
        result: { launchId: "uuid-1", argv: ["code"], recordedAt: 1_000 },
        emits: [
          {
            ref: { kind: "plugin", pluginId: CODE_PLUGIN_ID },
            kind: LAUNCH_RECORDED_EVENT,
            payload: { launchId: "uuid-1", machineId: "m1", recordedAt: 1_000 },
          },
        ],
      },
    });
  });
});
