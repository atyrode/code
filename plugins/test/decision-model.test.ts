import { describe, expect, test } from "bun:test";
import { answer, decisionFor, type Decision, type DecisionFacts } from "../code/generator/decision-model.ts";
import type { GateRefusal } from "../code/generator/launch-step.ts";
import { refusalView, type StatusFacts, type Vocabulary } from "../code/generator/statement-model.ts";

const vocab: Vocabulary = { family: family => family === "openai" ? "GPT" : family === "anthropic" ? "Claude" : family, time: at => String(at) };
const charge = { requests: 19, providers: [{ provider: "openai-codex", requests: 12 }, { provider: "anthropic", requests: 7 }] };
const nothing: DecisionFacts = { charge: null, mode: null, keepsChecks: true, ready: true, differs: null, narrowed: null, refused: null };
const asked = (facts: Partial<DecisionFacts>) => decisionFor({ ...nothing, ...facts }, vocab);
const does = (decision: Decision | null) => decision?.choices.map(choice => choice.does.kind) ?? [];
const status = (changes: Partial<StatusFacts> = {}): StatusFacts => ({
  verb: { label: "Launch", state: "refused", refusal: null, saves: false, checks: false, opens: null }, phase: null, mode: null, progress: null, charge: null,
  inFlight: null, busy: false, chaining: false, launching: false, machine: { name: "Laptop", online: false, revoked: false }, machineChosen: true, rosterUnread: false,
  otherMachine: { id: "studio", name: "Studio" }, message: null, outcome: null, stop: null, fix: null, laneFix: null, nobodyServes: false, listFailure: "none",
  ompMissing: false, accountsProblem: null, configurationFailed: false, ...changes,
});
const offline: GateRefusal = { code: "unavailable", text: "The machine is unavailable; the profile is kept." };

describe("which question the panel asks", () => {
  test("a charge asks only for a check the person started, never for one the panel runs on its own", () => {
    expect(asked({ charge, mode: "launch" })?.kind).toBe("charge");
    expect(asked({ charge, mode: "manual" })?.kind).toBe("charge");
    expect(asked({ charge, mode: "background" })).toBeNull();
  });

  test("a charge outranks every other question; a held review and a narrowed stop wait for a launch that can go on", () => {
    const all = { differs: ["Claude accounts join the pool"], narrowed: ["thinking high → max"], refused: refusalView(offline, status(), vocab) };
    expect(asked({ ...all, charge, mode: "launch" })?.kind).toBe("charge");
    expect(asked(all)?.kind).toBe("differs");
    expect(asked({ ...all, differs: null })?.kind).toBe("narrowed");
    expect(asked({ ...all, ready: false })?.kind).toBe("refused");
    expect(asked({ differs: ["Claude accounts join the pool"], ready: false })).toBeNull();
  });

  test("a charge offers Approve first and Cancel as its way out; one of nothing approves nothing", () => {
    expect(does(asked({ charge, mode: "launch" }))).toEqual(["approve", "cancel"]);
    expect(asked({ charge, mode: "launch" })?.items.join(" ")).toContain("GPT 12 · Claude 7");
    const empty = asked({ charge: { requests: 0, providers: [] }, mode: "launch" });
    expect(does(empty)).not.toContain("approve");
    expect(does(empty).at(-1)).toBe("cancel");
  });

  test("approving once promises later checks nothing to a sign-in that keeps no checks", () => {
    expect(asked({ charge, mode: "launch" })?.text.join(" ")).toMatch(/later checks/i);
    expect(asked({ charge, mode: "launch", keepsChecks: false })?.text.join(" ")).not.toMatch(/later checks/i);
  });

  test("a refused press offers the launch line's own fixes for its refusal, then Close", () => {
    const question = asked({ refused: refusalView(offline, status(), vocab) })!;
    expect(question.choices.map(choice => choice.does.kind === "fix" ? choice.does.action.fix : choice.does.kind))
      .toEqual([{ kind: "machine", machineId: "studio" }, "dismiss"]);
    expect(does(asked({ refused: refusalView({ code: "read-only", text: "Edit access needed." }, status(), vocab) }))).toEqual(["dismiss"]);
  });
});

describe("what answering does", () => {
  test("only Approve approves a charge; every other answer cancels the check before it acts", () => {
    const question = asked({ charge, mode: "launch" })!, empty = asked({ charge: { requests: 0, providers: [] }, mode: "launch" })!;
    expect(answer(question, question.choices[0]!)).toEqual([{ kind: "approve" }]);
    for (const decision of [question, empty]) {
      for (const choice of decision.choices.filter(choice => choice.does.kind !== "approve")) {
        const effects = answer(decision, choice);
        expect(effects[0]).toEqual({ kind: "cancel" });
        expect(effects.some(effect => effect.kind === "approve")).toBe(false);
      }
    }
  });

  test("a held review launches only on its first choice; Not now drops it so the next press reviews again", () => {
    const question = asked({ differs: ["Claude accounts join the pool"] })!;
    expect(answer(question, question.choices[0]!)).toEqual([{ kind: "launch" }]);
    expect(answer(question, question.choices.at(-1)!)).toEqual([{ kind: "drop-held" }]);
  });

  test("no question's way out launches or approves", () => {
    const questions = [asked({ charge, mode: "launch" }), asked({ differs: ["x"] }), asked({ narrowed: ["y"] }), asked({ refused: refusalView(offline, status(), vocab) })];
    for (const question of questions) {
      const effects = answer(question!, question!.choices.at(-1)!);
      expect(effects.some(effect => effect.kind === "launch" || effect.kind === "approve")).toBe(false);
    }
  });
});
