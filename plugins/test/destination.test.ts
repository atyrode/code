import { describe, expect, test } from "bun:test";
import type { MachineSummary } from "@manifold/protocol";
import { initialDestination, ompPresence, type OmpPresence } from "../code/destination.ts";
import { WorkflowError } from "../code/workflow.ts";

const machine = (id: string, online = true): MachineSummary => ({ id, name: id, online } as MachineSummary);
const roster = [machine("isolated"), machine("dev-01"), machine("dev-hub", false)];
const presence = (entries: Record<string, OmpPresence>) => new Map(Object.entries(entries));

describe("the destination a browser starts on", () => {
  test("never a machine without OMP: the saved one only where OMP answers, else the first online one where it does", () => {
    expect(initialDestination(roster, presence({ isolated: "absent", "dev-01": "ok" }), "isolated")).toBe("dev-01");
    expect(initialDestination(roster, presence({ isolated: "absent", "dev-01": "ok" }), null)).toBe("dev-01");
    expect(initialDestination(roster, presence({ isolated: "ok", "dev-01": "ok" }), "dev-01")).toBe("dev-01");
  });

  test("with OMP answering nowhere, the saved or first online machine stays chosen so the launch line can say why", () => {
    expect(initialDestination(roster, presence({ isolated: "absent", "dev-01": "unknown" }), "dev-01")).toBe("dev-01");
    expect(initialDestination(roster, presence({ isolated: "absent", "dev-01": "absent" }), null)).toBe("isolated");
  });

  test("only OMP's refusal to operate there means absent; any other failure is unknown", () => {
    expect(ompPresence(new WorkflowError("atyrode.omp.describeDestination: omp_operation_unavailable. No approval or readiness is assumed."))).toBe("absent");
    expect(ompPresence(new WorkflowError("atyrode.omp.describeDestination: timed out"))).toBe("unknown");
    expect(ompPresence(new Error("network"))).toBe("unknown");
  });
});
