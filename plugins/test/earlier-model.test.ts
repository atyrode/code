import { describe, expect, test } from "bun:test";
import type { MachineSummary, TerminalSummary } from "@manifold/protocol";
import type { Selection } from "../domain/contracts.ts";
import {
  differences, machineReads, machineState, pastMoment, pinRecents, rowVerdict, sessionName, sessionRows, sessionsNote,
  teamProvenance, type SessionRead,
} from "../code/generator/earlier-model.ts";
import { sameTeam, teamWords } from "../code/generator/statement-model.ts";
import type { GateVerdict } from "../code/generator/launch-step.ts";
import type { RecentTeam } from "../code/generator/recent-teams.ts";

const words: Readonly<Record<string, string>> = { openai: "GPT", anthropic: "Claude" };
const familyWord = (family: string) => words[family] ?? family;
/** The operator's last launched team: GPT-led, smart, high, advisor off, no extras. */
function team(changes: Partial<Selection> = {}): Selection {
  return { lane: { kind: "provider", family: "openai", blend: "led" }, capability: 3, thinking: "high", advisor: "off", spark: false,
    priority: false, prewalk: false, planYolo: false, fallback: false, budget: "any", ...changes };
}
const lineOf = (selection: Selection) => ({ words: teamWords(selection, familyWord), selection });
const launched = (selection: Selection, launchedAt: number): RecentTeam => ({ selection, launchedAt });

describe("earlier statements print only what differs from the line", () => {
  test("a team equal to the line, in any key order, reads as this team", () => {
    const reordered = { budget: "any", fallback: false, planYolo: false, prewalk: false, priority: false, spark: false,
      advisor: "off", thinking: "high", capability: 3, lane: { blend: "led", family: "openai", kind: "provider" } } as Selection;
    expect(sameTeam(reordered, team())).toBe(true);
    expect(differences(reordered, lineOf(team()), familyWord)).toEqual([]);
  });

  test("only the differing words, in the line's order and words", () => {
    const other = team({ lane: { kind: "provider", family: "openai", blend: "only" }, capability: 4, thinking: "xhigh" });
    expect(differences(other, lineOf(team()), familyWord)).toEqual([
      { word: "lane", text: "GPT only" }, { word: "tier", text: "elite" }, { word: "thinking", text: "x-high" },
    ]);
    expect(differences(team({ advisor: "review", lane: { kind: "mixed" } }), lineOf(team()), familyWord))
      .toEqual([{ word: "lane", text: "Mixed" }, { word: "advisor", text: "review" }]);
  });

  test("extras that differ are named, even where the line's count would read the same", () => {
    const line = lineOf(team({ spark: true, fallback: true }));
    expect(line.words.extras).toBe("2 extras");
    expect(differences(team({ priority: true, prewalk: true }), line, familyWord)).toEqual([{ word: "extras", text: "priority + prewalk" }]);
    expect(differences(team(), line, familyWord)).toEqual([{ word: "extras", text: "no extras" }]);
    expect(differences(team({ budget: "free" }), lineOf(team()), familyWord)).toEqual([{ word: "extras", text: "free only" }]);
  });

  test("before the line has a team, rows compare with its words alone", () => {
    expect(differences(team(), { words: teamWords(team(), familyWord), selection: null }, familyWord)).toEqual([]);
    expect(differences(team({ thinking: "low" }), { words: teamWords(team(), familyWord), selection: null }, familyWord))
      .toEqual([{ word: "thinking", text: "low" }]);
  });
});

describe("recent teams keep their digits for the session", () => {
  const a = launched(team({ thinking: "low" }), 100), b = launched(team({ thinking: "medium" }), 200), c = launched(team({ thinking: "max" }), 300);

  test("the first list is numbered newest first", () => {
    expect(pinRecents([], [c, b, a]).map(entry => entry.selection.thinking)).toEqual(["max", "medium", "low"]);
  });

  test("launching a listed team again keeps every digit and refreshes its time", () => {
    const pinned = pinRecents([], [c, b, a]);
    const relaunched = launched(team({ thinking: "low" }), 400);
    const next = pinRecents(pinned, [relaunched, c, b]);
    expect(next.map(entry => entry.selection.thinking)).toEqual(["max", "medium", "low"]);
    expect(next[2]!.launchedAt).toBe(400);
  });

  test("a new team takes the next free digit and moves no other", () => {
    const pinned = pinRecents([], [c, b, a]);
    const fresh = launched(team({ advisor: "audit" }), 500);
    expect(pinRecents(pinned, [fresh, c, b, a]).map(entry => entry.selection.advisor === "audit" ? "new" : entry.selection.thinking))
      .toEqual(["max", "medium", "low", "new"]);
  });

  test("with every digit taken, a new team takes the digit of the longest-ago team the browser dropped, never a listed one", () => {
    const levels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
    const nine = [...levels.map((thinking, index) => launched(team({ thinking }), 10 + index)),
      ...(["glance", "review", "audit"] as const).map((advisor, index) => launched(team({ advisor }), 20 + index))].reverse();
    const pinned = pinRecents([], nine);
    expect(pinned).toHaveLength(9);
    const fresh = launched(team({ spark: true }), 99);
    // The browser's list drops its oldest (thinking minimal, launched at 10) to admit the new team.
    const latest = [fresh, ...nine.slice(0, 8)];
    const next = pinRecents(pinned, latest);
    const slot = pinned.findIndex(entry => entry.selection.thinking === "minimal" && entry.selection.advisor === "off");
    expect(next[slot]).toEqual(fresh);
    next.forEach((entry, index) => { if (index !== slot) expect(entry).toEqual(pinned[index]!); });
    expect(pinRecents(next, latest)).toEqual(next);
  });

  test("a team the browser dropped keeps its digit while there is room", () => {
    const pinned = pinRecents([], [c, b, a]);
    expect(pinRecents(pinned, [c, b]).map(entry => entry.selection.thinking)).toEqual(["max", "medium", "low"]);
  });
});

describe("sessions are grouped running then saved", () => {
  const studio = "studio", build = "build";
  const ref = (machineId: string, sessionId: string) => ({ harness: "atyrode.omp", machineId, sessionId });
  function terminal(id: string, machineId: string, changes: Partial<TerminalSummary> = {}): TerminalSummary {
    return { id, machineId, session: ref(machineId, `s-${id}`), name: "omp", createdAt: 0, status: "running", exitCode: null,
      cwd: `/work/${id}`, homeId: `home-${id}`, unplaced: false, ...changes };
  }
  const read = (...sessions: { id: string; title: string | null; updatedAt: number }[]): SessionRead =>
    ({ state: "read", sessions: sessions.map(session => ({ ...session, cwd: `/saved/${session.id}` })) });

  test("running rows are terminals carrying an OMP session on their own machine, newest first", () => {
    const rows = sessionRows([
      terminal("old", studio, { createdAt: 1 }), terminal("new", build, { createdAt: 5 }),
      terminal("exited", studio, { status: "exited" }), terminal("shell", studio, { session: undefined }),
      terminal("other", studio, { session: { harness: "someone.else", machineId: studio, sessionId: "x" } }),
      terminal("moved", studio, { session: ref(build, "s-moved") }),
    ], new Map(), "atyrode.omp");
    expect(rows.running.map(row => row.terminalId)).toEqual(["new", "old"]);
    expect(rows.saved).toEqual([]);
  });

  test("a read machine's saved sessions follow, without those already running, which take their title from the read", () => {
    const reads = new Map<string, SessionRead>([
      [studio, read({ id: "s-live", title: "Make the settings easier", updatedAt: 9 }, { id: "a", title: "Review keyboard", updatedAt: 3 })],
      [build, read({ id: "b", title: null, updatedAt: 7 })],
      ["reading", { state: "reading" }],
    ]);
    const rows = sessionRows([terminal("live", studio, { createdAt: 2 })], reads, "atyrode.omp");
    expect(rows.running.map(row => [row.sessionId, row.title])).toEqual([["s-live", "Make the settings easier"]]);
    expect(rows.saved.map(row => [row.machineId, row.sessionId])).toEqual([[build, "b"], [studio, "a"]]);
    // Without a title a row is called by its folder; a terminal's own name is never taken for the transcript's.
    expect(sessionName(rows.saved[0]!)).toBe("/saved/b");
    expect(sessionName(sessionRows([terminal("unread", studio)], new Map(), "atyrode.omp").running[0]!)).toBe("/work/unread");
  });

  test("the group says its counts and that no team was recorded, once; read-only says Open only where Resume would show", () => {
    expect(sessionsNote(3, 2, false)).toBe("3 running · 2 saved · team not recorded");
    expect(sessionsNote(0, 0, false)).toBe("none running");
    expect(sessionsNote(1, 2, true)).toBe("1 running · 2 saved · team not recorded · read-only: Open only");
    expect(sessionsNote(3, 0, true)).toBe("3 running · team not recorded");
  });

  test("Read is offered once per online permitted machine not yet read; offline ones are named, revoked ones are not", () => {
    const machines: MachineSummary[] = [
      { id: studio, name: "Studio", online: true }, { id: build, name: "Build box", online: true },
      { id: "laptop", name: "Travel laptop", online: false }, { id: "gone", name: "Old box", online: false, revoked: true },
    ];
    const reads = new Map<string, SessionRead>([[build, { state: "failed", error: "refused" }]]);
    const result = machineReads(machines, null, reads);
    expect(result.unread.map(machine => machine.name)).toEqual(["Studio"]);
    expect(result.failed.map(entry => [entry.machine.name, entry.error])).toEqual([["Build box", "refused"]]);
    expect(result.offline.map(machine => machine.name)).toEqual(["Travel laptop"]);
    expect(machineReads(machines, "The permitted machine list could not be read.", new Map()).unread).toEqual([]);
  });
});

describe("row verbs answer to the one gate", () => {
  const OPEN: GateVerdict = { open: true };
  const refused = (code: Extract<GateVerdict, { open: false }>["refusal"]["code"], text: string): GateVerdict => ({ open: false, refusal: { code, text } });
  const machines: MachineSummary[] = [{ id: "studio", name: "Studio", online: true }, { id: "laptop", name: "Travel laptop", online: false }];
  const at = (machineId: string) => machineState(machineId, machines, null);

  test("a step in flight or a waiting charge refuses every row first, even on an offline machine", () => {
    expect(rowVerdict("open", refused("running", "Wait for the step in progress."), at("laptop"), "laptop", "studio"))
      .toEqual({ open: false, reason: "Wait for the step in progress." });
    expect(rowVerdict("resume", refused("charge", "Confirm or cancel the verification charge first."), at("studio"), "studio", "studio").open).toBe(false);
  });

  test("a read-only workspace refuses Resume, never Open", () => {
    expect(rowVerdict("resume", refused("read-only", "Edit access needed."), at("laptop"), "laptop", "studio"))
      .toEqual({ open: false, reason: "Edit access needed." });
    expect(rowVerdict("open", OPEN, at("studio"), "studio", "studio")).toEqual({ open: true });
  });

  test("the row's machine must be online, and in the roster", () => {
    expect(rowVerdict("open", OPEN, at("laptop"), "laptop", "studio")).toEqual({ open: false, reason: "Travel laptop is offline." });
    expect(rowVerdict("open", OPEN, at("unknown"), "unknown", "studio").open).toBe(false);
    expect(rowVerdict("open", OPEN, machineState("studio", machines, "The permitted machine list could not be read."), "studio", "studio"))
      .toEqual({ open: false, reason: "The machine list could not be read." });
    // Before the roster's first answer nothing has failed yet.
    expect(rowVerdict("open", OPEN, machineState("studio", null, null), "studio", "studio")).toEqual({ open: false, reason: "Reading the machine list…" });
  });

  test("Resume runs on the line's machine; a session elsewhere says where to choose", () => {
    const elsewhere = machineState("build", [...machines, { id: "build", name: "Build box", online: true }], null);
    expect(rowVerdict("resume-with-team", OPEN, elsewhere, "build", "studio"))
      .toEqual({ open: false, reason: "On Build box · choose it on the line to resume here." });
    expect(rowVerdict("open", OPEN, elsewhere, "build", "studio")).toEqual({ open: true });
  });

  test("the row is the session choice; any other gate refusal stands", () => {
    expect(rowVerdict("resume", refused("no-session", "Choose a saved session to resume."), at("studio"), "studio", "studio")).toEqual({ open: true });
    expect(rowVerdict("resume-with-team", refused("plans", "Resuming with this team cannot approve plans automatically."), at("studio"), "studio", "studio"))
      .toEqual({ open: false, reason: "Resuming with this team cannot approve plans automatically." });
  });
});

describe("the line's provenance when no recent team says it", () => {
  const now = new Date(2026, 9, 3, 18, 30).getTime();
  const savedAt = new Date(2026, 9, 3, 14, 2).getTime();
  const record = { selection: team(), updatedBy: "ana-id", updatedAt: savedAt };

  test("the saved workspace team names when and by whom", () => {
    expect(teamProvenance(team(), [], record, "me", new Map([["ana-id", "ana"]]), now)).toBe("Workspace team · saved 14:02 by ana");
    expect(teamProvenance(team(), [], { ...record, updatedBy: "me" }, "me", new Map(), now)).toBe("Workspace team · saved 14:02 by you");
    expect(teamProvenance(team(), [], record, "me", new Map(), now)).toBe("Workspace team · saved 14:02 by another member");
  });

  test("said nowhere when a recent team already reads as this team, or when the line is not the saved team", () => {
    expect(teamProvenance(team(), [launched(team(), 5)], record, "me", new Map(), now)).toBeNull();
    expect(teamProvenance(team({ thinking: "low" }), [], record, "me", new Map(), now)).toBeNull();
    expect(teamProvenance(team(), [], { ...record, selection: null }, "me", new Map(), now)).toBeNull();
  });

  test("a past moment reads as a clock: today, this week, then a date", () => {
    expect(pastMoment(savedAt, now)).toBe("14:02");
    expect(pastMoment(new Date(2026, 9, 1, 9, 5).getTime(), now)).toBe("Thu 09:05");
    expect(pastMoment(new Date(2026, 8, 12, 9, 5).getTime(), now)).toBe("12 Sep");
    expect(pastMoment(new Date(2025, 11, 30, 9, 5).getTime(), now)).toBe("30 Dec 2025");
  });
});
