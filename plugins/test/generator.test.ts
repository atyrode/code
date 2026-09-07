import { describe, expect, test } from "bun:test";
import type { MachineSummary } from "@manifold/protocol";
import { selectedMachine } from "../atyrode.code/generator/model.ts";

const workstation: MachineSummary = { id: "m1", name: "Workstation", online: true };
const laptop: MachineSummary = { id: "m2", name: "Laptop", online: true };

describe("launch machine selection", () => {
  test("only offers online, non-revoked machines before an explicit selection", () => {
    expect(selectedMachine(null, null)).toBeNull();
    expect(selectedMachine([
      { ...laptop, online: false },
      { ...workstation, revoked: true },
    ], null)).toBeNull();
    expect(selectedMachine([
      { ...laptop, revoked: true },
      workstation,
    ], null)?.id).toBe(workstation.id);
  });

  test("preserves an explicit choice across reordered machine updates", () => {
    expect(selectedMachine([laptop, workstation], workstation.id)?.id).toBe(workstation.id);
    expect(selectedMachine([workstation, laptop], workstation.id)?.id).toBe(workstation.id);
  });

  test("never redirects an unavailable explicit choice to another online machine", () => {
    expect(selectedMachine([laptop], workstation.id)).toBeNull();
    expect(selectedMachine([laptop, { ...workstation, online: false }], workstation.id)).toBeNull();
    expect(selectedMachine([laptop, { ...workstation, revoked: true }], workstation.id)).toBeNull();
    expect(selectedMachine([laptop, workstation], workstation.id)?.id).toBe(workstation.id);
  });
});
