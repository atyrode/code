import { describe, expect, test } from "bun:test";
import { chargeDecision, differsDecision, narrowedDecision, refusalDecision, type Decision } from "../code/generator/decision-model.ts";
import type { GateRefusal } from "../code/generator/launch-step.ts";
import type { StatusFacts, Vocabulary } from "../code/generator/statement-model.ts";

const vocab: Vocabulary = { family: family => family === "openai" ? "GPT" : family === "anthropic" ? "Claude" : family, time: at => String(at) };
const charge = { requests: 19, providers: [{ provider: "openai-codex", requests: 12 }, { provider: "anthropic", requests: 7 }] };
const does = (decision: Decision) => decision.choices.map(choice => choice.does.kind);
const facts = (changes: Partial<StatusFacts> = {}): StatusFacts => ({
  verb: { label: "Launch", state: "refused", refusal: null, saves: false, checks: false, opens: null }, phase: null, mode: null, progress: null, charge: null,
  inFlight: null, busy: false, chaining: false, launching: false, machine: { name: "Laptop", online: false, revoked: false }, machineChosen: true, rosterUnread: false,
  otherMachine: { id: "studio", name: "Studio" }, message: null, outcome: null, stop: null, fix: null, laneFix: null, nobodyServes: false, listFailure: "none",
  ompMissing: false, accountsProblem: null, configurationFailed: false, ...changes,
});

describe("the question a press waits on", () => {
  test("a charge asks to approve it first and cancels as its way out; one of nothing approves nothing", () => {
    const asked = chargeDecision(charge, "launch", true, vocab);
    expect(does(asked)).toEqual(["approve", "cancel"]);
    expect(asked.items.join(" ")).toContain("19");
    expect(asked.items.join(" ")).toContain("GPT 12");
    const nothing = chargeDecision({ requests: 0, providers: [] }, "launch", true, vocab);
    expect(does(nothing)).not.toContain("approve");
    expect(does(nothing).at(-1)).toBe("cancel");
  });

  test("approving once promises later checks nothing to a sign-in that keeps no checks", () => {
    expect(chargeDecision(charge, "launch", true, vocab).text.join(" ")).toMatch(/later checks/i);
    expect(chargeDecision(charge, "launch", false, vocab).text.join(" ")).not.toMatch(/later checks/i);
  });

  test("a review that differs or a check that changed the profile launches only on its first choice; the way out never launches", () => {
    for (const asked of [differsDecision(["Claude accounts join the pool"]), narrowedDecision(["thinking high → max"])]) expect(does(asked)).toEqual(["launch", "dismiss"]);
  });

  test("a refused press offers the launch line's own fixes, then Close", () => {
    const offline: GateRefusal = { code: "unavailable", text: "The machine is unavailable; the profile is kept." };
    const asked = refusalDecision(offline, facts(), vocab);
    expect(asked.choices.map(choice => choice.does.kind === "fix" ? choice.does.action.fix : choice.does.kind))
      .toEqual([{ kind: "machine", machineId: "studio" }, "dismiss"]);
    expect(asked.text.length).toBe(1);
    // Read-only has nothing to press: it says why, and only closes.
    expect(does(refusalDecision({ code: "read-only", text: "Edit access needed." }, facts(), vocab))).toEqual(["dismiss"]);
  });
});
