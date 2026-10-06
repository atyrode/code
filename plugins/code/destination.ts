import type { MachineSummary } from "@manifold/protocol";
import { refusalToken, WorkflowError } from "./workflow.ts";

/*
 * Where a session can run, decided apart from React (machine-web.ts reads it on every poll): whether
 * OMP answers on a machine, and the destination a browser starts on.
 */

/**
 * Whether OMP answers on a machine: `ok` when its destination is described, `absent` when the machine
 * refuses OMP's actions outright (OMP is not installed there), `unknown` when the read failed
 * otherwise or has not answered yet. Judged for every online machine, so a destination is never
 * chosen, by default or by hand, where nothing could run.
 */
export type OmpPresence = "ok" | "absent" | "unknown";
export function ompPresence(failure: unknown): OmpPresence {
  return failure instanceof WorkflowError && refusalToken(failure.message) === "omp_operation_unavailable" ? "absent" : "unknown";
}

/**
 * The destination a browser starts on: the saved one where OMP answers, else the first online machine
 * where it does. With none where it does, the saved one or the first online stays chosen, so the
 * launch line can say why nothing runs there; nothing is chosen before every online machine has answered.
 */
export function initialDestination(machines: readonly MachineSummary[], presence: ReadonlyMap<string, OmpPresence>, saved: string | null): string | null {
  const online = machines.filter(machine => machine.online && machine.revoked !== true);
  const ok = (id: string | null) => id !== null && presence.get(id) === "ok";
  if (ok(saved)) return saved;
  const first = online.find(machine => ok(machine.id));
  if (first) return first.id;
  return saved || online[0]?.id || machines[0]?.id || null;
}

