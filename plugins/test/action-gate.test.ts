import { describe, expect, test } from "bun:test";
import { actionGate, resumeTeam, type GateFacts, type GateVerdict, type WorkbenchIntent } from "../code/generator/launch-step.ts";
import type { Configuration } from "../code/contract.ts";
import type { VerificationStatus } from "../code/generator/verification.ts";

/** A verified, saved, launchable workbench with a saved session chosen and nothing in flight; each test changes only what it is about. */
function facts(changes: Partial<GateFacts> = {}, status: VerificationStatus = "current"): GateFacts {
  return { configurationCurrent: true, unsaved: false, stale: false, writable: true, placeable: true, available: true, accounts: "usable", launchReady: true, previewCurrent: false,
    profile: { source: "active" }, localDraft: null, record: { active: {} }, localReview: {}, skillProblems: [],
    queries: { setup: { error: null } }, verification: { status, ready: true },
    running: false, charge: null, unservedLead: null, savedSessionId: "session-1", planYolo: false, ...changes };
}
const every: readonly WorkbenchIntent[] = ["verify", "confirm", "save", "review", "launch", "resume", "resume-with-team", "open",
  "edit-team", "edit-options", "edit-machine", "edit-accounts"];
const claude = { provider: "anthropic", family: "anthropic", roles: ["reviewer", "security-reviewer"] };
const code = (verdict: GateVerdict) => verdict.open ? "open" : verdict.refusal.code;

describe("one gate for every action", () => {
  test("nothing starts and nothing it depends on changes while a step runs", () => {
    for (const intent of every) expect(code(actionGate(facts({ running: true, previewCurrent: true }), intent))).toBe("running");
  });

  test("while a charge waits only its Confirm proceeds; edits of the team, session options, machine and accounts wait with it", () => {
    const waiting = facts({ charge: { requests: 19 } }, "unverified");
    for (const intent of every) expect(code(actionGate(waiting, intent))).toBe(intent === "confirm" ? "open" : "charge");
    expect(code(actionGate(facts({ charge: { requests: 0 } }, "unverified"), "confirm"))).toBe("no-charge");
    expect(code(actionGate(facts({}, "unverified"), "confirm"))).toBe("not-next");
  });

  test("save, review and launch refuse a lead no included account serves, naming it, so a team the door refuses is never saved on the way", () => {
    expect(actionGate(facts({ unservedLead: claude }), "review")).toEqual({ open: false, refusal: expect.objectContaining({ code: "no-account", gap: claude }) });
    expect(code(actionGate(facts({ unservedLead: claude, previewCurrent: true }), "launch"))).toBe("no-account");
    expect(code(actionGate(facts({ unservedLead: claude, unsaved: true, localDraft: { source: "active" } }), "save"))).toBe("no-account");
    expect(code(actionGate(facts({ unservedLead: claude }), "resume-with-team"))).toBe("no-account");
    // Resuming saved state keeps the session's own models, so the team's lead is not its concern.
    expect(code(actionGate(facts({ unservedLead: claude }), "resume"))).toBe("open");
  });

  test("a chain asking again before its next step is stopped by a premise that changed while it ran", () => {
    // Launch is the step only while the review is current; a changed input revokes it, and the gate says so.
    expect(code(actionGate(facts({ previewCurrent: true }), "launch"))).toBe("open");
    expect(actionGate(facts({ previewCurrent: false }), "launch")).toEqual({ open: false, refusal: { code: "not-next", text: "Review before opening a terminal." } });
    expect(code(actionGate(facts({ previewCurrent: true, writable: false }), "launch"))).toBe("read-only");
    expect(code(actionGate(facts({ previewCurrent: true, available: false }), "launch"))).toBe("unavailable");
    // After a save, the review proceeds only for the saved team.
    expect(code(actionGate(facts(), "review"))).toBe("open");
    expect(code(actionGate(facts({ unsaved: true, localDraft: { source: "active" } }), "review"))).toBe("not-next");
  });

  test("verify is judged by its own preconditions, save by the save's", () => {
    expect(code(actionGate(facts({}, "accounts-changed"), "verify"))).toBe("open");
    expect(code(actionGate(facts(), "verify"))).toBe("verified");
    expect(code(actionGate(facts({ writable: false }, "unverified"), "verify"))).toBe("read-only");
    expect(code(actionGate(facts({ configurationCurrent: false }, "unverified"), "verify"))).toBe("configuration");
    expect(code(actionGate(facts({ unsaved: true, localDraft: { source: "active" } }), "save"))).toBe("open");
    // The bundled preview is saved only by the verification that replaces it, and nothing saves unverified.
    expect(code(actionGate(facts({ unsaved: true, profile: { source: "starter" }, localDraft: { source: "starter" } }), "save"))).toBe("unsaved");
    expect(code(actionGate(facts({ unsaved: true, localDraft: { source: "active" } }, "omp-changed"), "save"))).toBe("not-next");
    expect(code(actionGate(facts({ unsaved: true, localDraft: { source: "active" }, writable: false }), "save"))).toBe("read-only");
  });

  test("resuming needs write access, the machine and a chosen session; with the team, the team a launch would compose", () => {
    expect(code(actionGate(facts(), "resume"))).toBe("open");
    expect(code(actionGate(facts({ writable: false }), "resume"))).toBe("read-only");
    expect(code(actionGate(facts({ available: false }), "resume"))).toBe("unavailable");
    expect(code(actionGate(facts({ savedSessionId: "" }), "resume"))).toBe("no-session");
    expect(code(actionGate(facts({ skillProblems: ["missing"] }), "resume"))).toBe("skills");
    expect(code(actionGate(facts(), "resume-with-team"))).toBe("open");
    expect(code(actionGate(facts({ unsaved: true, localDraft: { source: "active" } }), "resume-with-team"))).toBe("unsaved");
    expect(code(actionGate(facts({}, "unverified"), "resume-with-team"))).toBe("not-next");
    expect(code(actionGate(facts({ localReview: null }), "resume-with-team"))).toBe("models");
    expect(code(actionGate(facts({ planYolo: true }), "resume-with-team"))).toBe("plans");
  });

  test("a plain resume needs no Code configuration; only a resume with the team sends the saved profile", () => {
    const target = { containerId: "workspace-1", machineId: "studio" };
    // A workspace whose Code choices were never initialized has no record, and still reopens a saved session as it was.
    expect(code(actionGate(facts({ configurationCurrent: false, record: null, profile: null }), "resume"))).toBe("open");
    expect(resumeTeam(false, target, null)).toEqual({});
    expect(resumeTeam(true, target, null)).toBeNull();
    expect(resumeTeam(true, target, { revision: 7 } as Configuration)).toEqual({ profile: { target, expectedRevision: 7 } });
  });

  test("edits: the team and machine move in a read-only workspace as a local preview; accounts need write access", () => {
    const readOnly = facts({ writable: false });
    expect(code(actionGate(readOnly, "edit-team"))).toBe("open");
    expect(code(actionGate(readOnly, "edit-machine"))).toBe("open");
    expect(code(actionGate(readOnly, "open"))).toBe("open");
    expect(code(actionGate(readOnly, "edit-accounts"))).toBe("read-only");
  });

  test("with no canvas beside the panel, writes stay open and only what places a terminal refuses, for that reason", () => {
    const panelAlone = (changes: Partial<GateFacts> = {}, status: VerificationStatus = "current") => facts({ placeable: false, ...changes }, status);
    expect(code(actionGate(panelAlone({}, "unverified"), "verify"))).toBe("open");
    expect(code(actionGate(panelAlone({ unsaved: true, localDraft: { source: "active" } }), "save"))).toBe("open");
    expect(code(actionGate(panelAlone(), "edit-accounts"))).toBe("open");
    for (const intent of ["review", "resume", "resume-with-team"] as const) expect(code(actionGate(panelAlone(), intent))).toBe("placement");
    expect(code(actionGate(panelAlone({ previewCurrent: true }), "launch"))).toBe("placement");
    // A writer without a canvas is never told the workspace is read-only.
    for (const intent of every) expect(code(actionGate(panelAlone(), intent))).not.toBe("read-only");
  });

  test("verify is refused up front when the pool it would compose cannot be read or holds no account", () => {
    expect(code(actionGate(facts({ accounts: "unreadable" }, "unverified"), "verify"))).toBe("accounts");
    expect(code(actionGate(facts({ accounts: "none" }, "accounts-changed"), "verify"))).toBe("no-accounts");
  });
});
