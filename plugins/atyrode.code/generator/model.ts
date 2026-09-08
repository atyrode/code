import type { MachineSummary } from "@manifold/protocol";

/** Never silently redirect an explicit choice to a different machine. */
export function selectedMachine(
  machines: readonly MachineSummary[] | null,
  selectedId: string | null,
): MachineSummary | null {
  return machines?.find(
    (machine) =>
      machine.online && machine.revoked !== true &&
      (selectedId === null || machine.id === selectedId),
  ) ?? null;
}
