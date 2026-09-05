import { HostCallError, ui } from "@manifold/plugin-kit";
import { definePanel, defineWebPlugin, type GuestHost } from "@manifold/plugin-kit/web";
import type { MachineSummary, UiNode, UiTone } from "@manifold/protocol";
import {
  CODE_ARGV0,
  GENERATOR_PLUGIN_ID,
  LAUNCH_DOOR,
  LAUNCHER_PANEL,
  LIST_LAUNCHES_DOOR,
  LaunchResultSchema,
  ListLaunchesResultSchema,
  type LaunchInput,
  type LaunchRecord,
} from "../contract.ts";

/*
  THE GENERATOR, web half: one panel, `launcher`, the interim launch UI (transition record
  "Topology and first plugin"). It is a view over the baseline's doors and nothing more:

  - `init` asks the host for the machines and the baseline for the ledger;
  - `view` is a machine picker, one button, a status line and the recent launches;
  - `update` on `launch` dispatches `atyrode.code.launch` through the host — the baseline
    arbitrates and records — then opens a terminal tile on that machine running exactly the
    argv the door echoed back, with the VIEWER's authority (`host.openTerminal` is the same
    `core.terminals.open` a first-party panel reaches). A host refusal — no mounted
    composition view in this container, no `terminals:spawn` here — is shown as text, never
    swallowed, and the ledger row the door wrote stays: the ledger records authorizations.
  - `subscribe` re-polls the machines every ten seconds; the ledger is re-read after the
    viewer's own launch and at mount (no event subscription reaches a worker tonight).

  No dials: the TUI's dials run in the tile, because `argv` is `["code"]` and the interactive
  program is the whole selection surface until `code launch --selection` exists (#96).
 */

/** What every launch from this panel runs. */
const LAUNCH_ARGV: LaunchInput["argv"] = [CODE_ARGV0];
const LAUNCH_LABEL = "code (interactive)";
const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 40;
const MACHINES_POLL_MS = 10_000;

interface Status {
  readonly text: string;
  readonly tone: Extract<UiTone, "danger" | "success">;
}

export interface LauncherState {
  /** The clock at the last fold, so `view` is a pure projection and relative times are data. */
  readonly now: number;
  /** null until the host answered the first `machines()`. */
  readonly machines: readonly MachineSummary[] | null;
  readonly machineId: string | null;
  readonly launches: readonly LaunchRecord[];
  /** The list door's refusal, when the ledger could not be read; shown in place of the list. */
  readonly ledgerDenial: string | null;
  readonly status: Status | null;
}

/** A machine the launch door would accept: live, and not withdrawn from the fleet. */
function onlineMachines(machines: readonly MachineSummary[] | null): readonly MachineSummary[] {
  return machines === null ? [] : machines.filter((m) => m.online && m.revoked !== true);
}

/** Keeps the viewer's pick while it is online; otherwise the first online machine, or none. */
function chooseMachine(
  current: string | null,
  machines: readonly MachineSummary[] | null,
): string | null {
  const online = onlineMachines(machines);
  if (current !== null && online.some((m) => m.id === current)) return current;
  return online[0]?.id ?? null;
}

export function relativeTime(sinceMs: number): string {
  if (sinceMs < 60_000) return "just now";
  const minutes = Math.floor(sinceMs / 60_000);
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  return `${String(Math.floor(hours / 24))} d ago`;
}

/** The ledger as the baseline answers it, or the door's refusal. */
async function readLedger(
  host: GuestHost,
): Promise<Pick<LauncherState, "launches" | "ledgerDenial">> {
  const outcome = await host.action(LIST_LAUNCHES_DOOR, {});
  if (!outcome.ok) return { launches: [], ledgerDenial: outcome.denial.message };
  return {
    launches: ListLaunchesResultSchema.parse(outcome.result).launches,
    ledgerDenial: null,
  };
}

/** The host's own sentence for a refused call, without the kit's `method:` prefix. */
function refusalText(error: unknown): string {
  if (error instanceof HostCallError) return error.detail;
  return error instanceof Error ? error.message : String(error);
}

export const launcher = definePanel<LauncherState>({
  init: async (host) => {
    const machines = await host.machines();
    return {
      now: Date.now(),
      machines,
      machineId: chooseMachine(null, machines),
      ...(await readLedger(host)),
      status: null,
    };
  },

  view: (state): UiNode => {
    const online = onlineMachines(state.machines);
    return ui.box({ direction: "column", gap: 2 }, [
      ui.heading("code", 2),
      state.machines === null
        ? ui.spinner("Asking the hub for machines")
        : online.length === 0
          ? ui.empty("No enrolled machine is online.")
          : ui.select(
              "machine",
              state.machineId,
              online.map((m) => ({ value: m.id, label: m.name })),
              { label: "Machine" },
            ),
      ui.button("Open code here", "launch", {
        tone: "accent",
        action: LAUNCH_DOOR,
        disabled: state.machineId === null,
      }),
      ...(state.status === null
        ? []
        : [ui.text(state.status.text, { tone: state.status.tone, wrap: true })]),
      ui.divider(),
      ui.heading("Recent launches", 3),
      state.ledgerDenial !== null
        ? ui.text(state.ledgerDenial, { tone: "danger", wrap: true })
        : state.launches.length === 0
          ? ui.empty("No launch recorded yet.")
          : ui.list(
              state.launches.map((launch) => ({
                key: launch.launchId,
                primary: launch.label ?? launch.argv.join(" "),
                secondary: `${state.machines?.find((m) => m.id === launch.machineId)?.name ?? launch.machineId} · ${relativeTime(state.now - launch.recordedAt)}`,
              })),
            ),
    ]);
  },

  update: async (state, event, host) => {
    switch (event.event) {
      case "machine":
        return { ...state, machineId: String(event.payload) };
      case "tick": {
        const machines = await host.machines();
        return {
          ...state,
          now: Date.now(),
          machines,
          machineId: chooseMachine(state.machineId, machines),
        };
      }
      case "launch": {
        if (state.machineId === null) {
          return { ...state, status: { text: "Pick an online machine first.", tone: "danger" } };
        }
        const machineId = state.machineId;
        const request: LaunchInput = { machineId, argv: LAUNCH_ARGV, label: LAUNCH_LABEL };
        const outcome = await host.action(LAUNCH_DOOR, request);
        let status: Status;
        if (!outcome.ok) {
          status = { text: outcome.denial.message, tone: "danger" };
        } else {
          const { launchId, argv } = LaunchResultSchema.parse(outcome.result);
          try {
            const terminal = await host.openTerminal({
              elementId: crypto.randomUUID(),
              cols: TERMINAL_COLS,
              rows: TERMINAL_ROWS,
              machineId,
              placement: "tile",
              program: { argv },
            });
            status = {
              text: `code is running in terminal ${terminal.name ?? terminal.id} on ${state.machines?.find((m) => m.id === machineId)?.name ?? machineId}.`,
              tone: "success",
            };
          } catch (error) {
            status = {
              text: `Launch ${launchId} was recorded, but no terminal was opened: ${refusalText(error)}`,
              tone: "danger",
            };
          }
        }
        return { ...state, now: Date.now(), ...(await readLedger(host)), status };
      }
      default:
        return state;
    }
  },

  subscribe: (_host, emit) => {
    const timer = setInterval(() => emit({ event: "tick" }), MACHINES_POLL_MS);
    return () => clearInterval(timer);
  },
});

defineWebPlugin({ id: GENERATOR_PLUGIN_ID, panels: { [LAUNCHER_PANEL]: launcher } });
