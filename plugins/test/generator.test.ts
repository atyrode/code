import { describe, expect, test } from "bun:test";
import { HostCallError } from "@manifold/plugin-kit";
import type { GuestHost, OpenTerminalOptions } from "@manifold/plugin-kit/web";
import {
  UiNodeSchema,
  type ActionOutcome,
  type MachineSummary,
  type TerminalInfo,
  type UiNode,
} from "@manifold/protocol";
import { LAUNCH_DOOR, LIST_LAUNCHES_DOOR, type LaunchRecord } from "../atyrode.code/contract.ts";
import { launcher, relativeTime, type LauncherState } from "../atyrode.code/generator/web.ts";

/**
 * THE LAUNCHER PANEL as a program: init, view, update against a fake GuestHost. Every tree
 * `view` produces is parsed against the protocol's own `UiNodeSchema`, because a tree outside
 * the vocabulary is a fault the engine paints as an empty panel.
 */

const principal = { id: "p1", kind: "human", name: "Ada", color: "#e03131" } as const;

const dev01: MachineSummary = { id: "m1", name: "dev-01", online: true };
const laptop: MachineSummary = { id: "m2", name: "laptop", online: false };
const cutOff: MachineSummary = { id: "m3", name: "old-box", online: true, revoked: true };

const NOW = 1_700_000_000_000;

function record(overrides: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    launchId: "L1",
    machineId: "m1",
    argv: ["code"],
    label: "code (interactive)",
    recordedAt: NOW - 90_000,
    by: "p1",
    ...overrides,
  };
}

interface FakeHost {
  readonly host: GuestHost;
  readonly actions: { name: string; args: unknown }[];
  readonly terminals: OpenTerminalOptions[];
}

function fakeHost(options: {
  machines?: readonly MachineSummary[];
  launches?: readonly LaunchRecord[];
  launch?: ActionOutcome;
  list?: ActionOutcome;
  openTerminal?: (request: OpenTerminalOptions) => Promise<TerminalInfo>;
}): FakeHost {
  const actions: { name: string; args: unknown }[] = [];
  const terminals: OpenTerminalOptions[] = [];
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} is not part of this test`);
  };
  const host: GuestHost = {
    principal,
    caps: ["terminals:spawn"],
    containerId: "c1",
    action: async (name, args) => {
      actions.push({ name, args });
      if (name === LAUNCH_DOOR) {
        return (
          options.launch ?? {
            ok: true,
            result: { launchId: "L-new", argv: ["code"], recordedAt: NOW },
          }
        );
      }
      if (name === LIST_LAUNCHES_DOOR) {
        return options.list ?? { ok: true, result: { launches: options.launches ?? [] } };
      }
      throw new Error(`unexpected door ${name}`);
    },
    machines: async () => options.machines ?? [dev01],
    openTerminal: async (request) => {
      terminals.push(request);
      if (options.openTerminal !== undefined) return options.openTerminal(request);
      return {
        id: "t1",
        containerId: "c1",
        name: null,
        machineId: request.machineId ?? "",
        status: "running",
        exitCode: null,
        cols: request.cols,
        rows: request.rows,
        controllerId: null,
        createdBy: principal.id,
      };
    },
    place: unused("place"),
    selfCaps: unused("selfCaps"),
    resolve: unused("resolve"),
    navigate: unused("navigate"),
    sendTerminalInput: unused("sendTerminalInput"),
    terminalsByContainer: unused("terminalsByContainer"),
  };
  return { host, actions, terminals };
}

/** The tree, parsed against the vocabulary, flattened for assertions. */
function nodes(state: LauncherState): UiNode[] {
  const tree = UiNodeSchema.parse(launcher.view(state));
  const out: UiNode[] = [];
  const walk = (node: UiNode): void => {
    out.push(node);
    if (node.type === "box") node.children.forEach(walk);
  };
  walk(tree);
  return out;
}

function only<T extends UiNode["type"]>(state: LauncherState, type: T): Extract<UiNode, { type: T }> {
  const found = nodes(state).filter((node): node is Extract<UiNode, { type: T }> => node.type === type);
  const [first] = found;
  if (first === undefined || found.length !== 1) {
    throw new Error(`expected one ${type}, found ${String(found.length)}`);
  }
  return first;
}

describe("init and view", () => {
  test("asks for the machines, picks the first launchable one, reads the ledger", async () => {
    const fake = fakeHost({ machines: [laptop, cutOff, dev01], launches: [record()] });
    const state = await launcher.init(fake.host);
    expect(state.machineId).toBe("m1");
    expect(state.launches).toEqual([record()]);
    expect(fake.actions).toEqual([{ name: LIST_LAUNCHES_DOOR, args: {} }]);

    const select = only(state, "select");
    expect(select.value).toBe("m1");
    expect(select.options).toEqual([{ value: "m1", label: "dev-01" }]);
    const button = only(state, "button");
    expect(button).toMatchObject({ event: "launch", action: LAUNCH_DOOR, disabled: false });
    const list = only({ ...state, now: NOW }, "list");
    expect(list.items).toEqual([
      { key: "L1", primary: "code (interactive)", secondary: "dev-01 · 1 min ago" },
    ]);
  });

  test("with no launchable machine the button is disabled and the picker is an empty state", async () => {
    const state = await launcher.init(fakeHost({ machines: [laptop, cutOff] }).host);
    expect(state.machineId).toBeNull();
    expect(nodes(state).some((n) => n.type === "select")).toBe(false);
    expect(only(state, "button").disabled).toBe(true);
    const empties = nodes(state).filter((n) => n.type === "empty").map((n) => n.text);
    expect(empties).toEqual(["No enrolled machine is online.", "No launch recorded yet."]);
  });

  test("before the first machines answer the picker is a spinner", () => {
    const state: LauncherState = {
      now: NOW,
      machines: null,
      machineId: null,
      launches: [],
      ledgerDenial: null,
      status: null,
    };
    expect(only(state, "spinner")).toEqual({ type: "spinner", label: "Asking the hub for machines" });
  });

  test("a refused ledger read is shown in place of the list, and a row falls back to its argv", async () => {
    const denied = await launcher.init(
      fakeHost({ list: { ok: false, denial: { rule: "forbidden", message: "not yours" } } }).host,
    );
    expect(denied.ledgerDenial).toBe("not yours");
    expect(nodes(denied).some((n) => n.type === "list")).toBe(false);
    expect(nodes(denied).filter((n) => n.type === "text").map((n) => n.text)).toEqual(["not yours"]);

    const unlabeled = await launcher.init(
      fakeHost({ launches: [record({ label: undefined, argv: ["code", "--help"], machineId: "m9" })] })
        .host,
    );
    expect(only({ ...unlabeled, now: NOW }, "list").items[0]).toMatchObject({
      primary: "code --help",
      secondary: "m9 · 1 min ago",
    });
  });
});

describe("update: launch", () => {
  test("dispatches the door, then opens a tile running exactly the argv the door echoed", async () => {
    const fake = fakeHost({
      launches: [record()],
      launch: { ok: true, result: { launchId: "L-new", argv: ["code"], recordedAt: NOW } },
    });
    const before = await launcher.init(fake.host);
    fake.actions.length = 0;
    const after = await launcher.update(before, { event: "launch" }, fake.host);

    expect(fake.actions).toEqual([
      {
        name: LAUNCH_DOOR,
        args: { machineId: "m1", argv: ["code"], label: "code (interactive)" },
      },
      { name: LIST_LAUNCHES_DOOR, args: {} },
    ]);
    expect(fake.terminals).toEqual([
      {
        elementId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        cols: 120,
        rows: 40,
        machineId: "m1",
        placement: "tile",
        program: { argv: ["code"] },
      },
    ]);
    expect(after.status).toEqual({
      text: "code is running in terminal t1 on dev-01.",
      tone: "success",
    });
    expect(only(after, "text")).toMatchObject({ tone: "success" });
  });

  test("a refusal at the door is shown as danger and no terminal is opened", async () => {
    const fake = fakeHost({
      launch: { ok: false, denial: { rule: "refused", message: "machine m1 is offline" } },
    });
    const before = await launcher.init(fake.host);
    const after = await launcher.update(before, { event: "launch" }, fake.host);
    expect(fake.terminals).toEqual([]);
    expect(after.status).toEqual({ text: "machine m1 is offline", tone: "danger" });
    expect(only(after, "text")).toEqual({
      type: "text",
      text: "machine m1 is offline",
      tone: "danger",
      wrap: true,
    });
  });

  test("a host refusal of the terminal is shown with the host's own sentence, and the ledger is re-read", async () => {
    const fake = fakeHost({
      openTerminal: async () => {
        throw new HostCallError("openTerminal", "no composition view is mounted in this container");
      },
    });
    const before = await launcher.init(fake.host);
    const after = await launcher.update(before, { event: "launch" }, fake.host);
    expect(after.status).toEqual({
      text: "Launch L-new was recorded, but no terminal was opened: no composition view is mounted in this container",
      tone: "danger",
    });
    expect(fake.actions.map((a) => a.name)).toEqual([
      LIST_LAUNCHES_DOOR,
      LAUNCH_DOOR,
      LIST_LAUNCHES_DOOR,
    ]);
  });

  test("with no machine picked nothing is dispatched", async () => {
    const fake = fakeHost({ machines: [laptop] });
    const before = await launcher.init(fake.host);
    fake.actions.length = 0;
    const after = await launcher.update(before, { event: "launch" }, fake.host);
    expect(fake.actions).toEqual([]);
    expect(after.status).toEqual({ text: "Pick an online machine first.", tone: "danger" });
  });
});

describe("update: machine and tick", () => {
  test("the pick is kept across a poll while it is online, and moved when it goes away", async () => {
    const two: MachineSummary = { id: "m2", name: "laptop", online: true };
    const fake = fakeHost({ machines: [dev01, two] });
    const initial = await launcher.init(fake.host);
    const picked = await launcher.update(initial, { event: "machine", payload: "m2" }, fake.host);
    expect(picked.machineId).toBe("m2");

    const stillUp = await launcher.update(picked, { event: "tick" }, fake.host);
    expect(stillUp.machineId).toBe("m2");

    const gone = fakeHost({ machines: [dev01, laptop] });
    const moved = await launcher.update(stillUp, { event: "tick" }, gone.host);
    expect(moved.machineId).toBe("m1");
    expect(moved.machines).toEqual([dev01, laptop]);
  });
});

describe("relativeTime", () => {
  test("rolls over at each unit boundary", () => {
    expect(relativeTime(59_999)).toBe("just now");
    expect(relativeTime(60_000)).toBe("1 min ago");
    expect(relativeTime(59 * 60_000 + 59_999)).toBe("59 min ago");
    expect(relativeTime(60 * 60_000)).toBe("1 h ago");
    expect(relativeTime(24 * 3_600_000 - 1)).toBe("23 h ago");
    expect(relativeTime(24 * 3_600_000)).toBe("1 d ago");
  });
});
