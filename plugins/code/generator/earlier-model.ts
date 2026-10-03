import type { MachineSummary, TerminalSummary } from "@manifold/protocol";
import type { OmpSessionSummary } from "@atyrode/manifold-omp";
import type { Selection } from "../../domain/contracts.ts";
import type { GateVerdict } from "./launch-step.ts";
import { RECENT_TEAMS_LIMIT, type RecentTeam } from "./recent-teams.ts";
import { extrasOn, sameTeam, teamWords, type StatementWord, type TeamWord, type TeamWords } from "./statement-model.ts";

/*
 * Earlier statements as data: the teams and sessions under the line, each said in the line's own
 * words (statement-model.ts `teamWords`) and only where it differs from the line. Pure, so the
 * rendering, the digit order and the row verdicts are tested without a panel.
 */

// ---------------------------------------------------------------- the line's words

/** The line's words, the machine's name included: what every row is compared with. */
export type StatementWords = Readonly<Record<StatementWord, string>>;

const TEAM_WORDS: readonly TeamWord[] = ["lane", "tier", "thinking", "advisor", "extras"];

/** A word with the connector the line prints beside it (`high thinking`, `advisor off`), for a row that stands without the line. */
export function phrase(word: TeamWord, text: string): string {
  return word === "thinking" ? `${text} thinking` : word === "advisor" ? `advisor ${text}` : text;
}

/** A whole team in one phrase, for a control's name: `GPT only, elite, x-high thinking, advisor off, no extras`. */
export function teamSentence(words: TeamWords): string {
  return TEAM_WORDS.map(word => phrase(word, words[word])).join(", ");
}

// ---------------------------------------------------------------- differences

export type Difference = { word: TeamWord; text: string };
/** The line a row is compared with: the words it shows, and the team behind them once there is one. */
export type LineTeam = { words: TeamWords; selection: Selection | null };

/**
 * The words of `team` that differ from the line, in the line's order; empty when the row is the
 * line's team, which it then reads as "this team". Identity is decided on the selections, because
 * words can coincide for different teams ("2 extras" and "2 extras"); for the same reason a team
 * with two or more extras names them instead of counting them.
 */
export function differences(team: Selection, line: LineTeam, familyWord: (family: string) => string): Difference[] {
  if (line.selection && sameTeam(team, line.selection)) return [];
  const words = teamWords(team, familyWord);
  const changed: Difference[] = TEAM_WORDS.filter(word => word !== "extras" && words[word] !== line.words[word])
    .map(word => ({ word, text: words[word] }));
  const on = extrasOn(team);
  const extrasDiffer = line.selection ? on.join() !== extrasOn(line.selection).join() : words.extras !== line.words.extras;
  if (extrasDiffer) changed.push({ word: "extras", text: on.length >= 2 ? on.join(" + ") : words.extras });
  return changed;
}

// ---------------------------------------------------------------- digits

/**
 * The recent teams in digit order (index i is digit i + 1), pinned for the panel's life: a team
 * keeps its digit when it is launched again, a new team takes the next free digit, and only when
 * all nine are taken does it take the digit of a pinned team the browser's list has since dropped,
 * the longest-ago launched first. So a digit, once read, never comes to mean another team that is
 * still listed.
 */
export function pinRecents(pinned: readonly RecentTeam[], latest: readonly RecentTeam[]): RecentTeam[] {
  const listed = (entry: RecentTeam) => latest.find(team => sameTeam(team.selection, entry.selection));
  const next = pinned.map(entry => listed(entry) ?? entry);
  for (const team of latest) {
    if (next.some(entry => sameTeam(entry.selection, team.selection))) continue;
    if (next.length < RECENT_TEAMS_LIMIT) { next.push(team); continue; }
    let slot = -1;
    next.forEach((entry, index) => {
      if (!listed(entry) && (slot < 0 || entry.launchedAt < next[slot]!.launchedAt)) slot = index;
    });
    if (slot < 0) break;
    next[slot] = team;
  }
  return next;
}

// ---------------------------------------------------------------- sessions

/** One OMP session under the line: a running terminal, or a saved transcript a machine read reported. */
export type SessionRow = {
  kind: "running" | "saved";
  sessionId: string;
  machineId: string;
  /** The running terminal to open; null for a saved session. */
  terminalId: string | null;
  /** The transcript's title, when a read of its machine reported one. */
  title: string | null;
  folder: string | null;
  /** When the terminal started, or when the saved transcript last changed. */
  at: number;
};
/** A machine's explicit saved-session read. */
export type SessionRead =
  | { state: "reading" }
  | { state: "read"; sessions: readonly OmpSessionSummary[] }
  | { state: "failed"; error: string };

/**
 * Running sessions (terminals that carry an OMP session ref on their own machine) newest first,
 * then the saved sessions the read machines reported that no running terminal holds, newest first.
 * A running session's title comes only from its machine's read: a terminal's own name is the
 * terminal's, not the transcript's.
 */
export function sessionRows(terminals: readonly TerminalSummary[], reads: ReadonlyMap<string, SessionRead>, harness: string): { running: SessionRow[]; saved: SessionRow[] } {
  const listed = (machineId: string) => { const read = reads.get(machineId); return read?.state === "read" ? read.sessions : []; };
  const running = terminals.filter(terminal => terminal.status === "running" && terminal.session?.harness === harness &&
    terminal.session.machineId === terminal.machineId).map(terminal => {
    const sessionId = terminal.session!.sessionId;
    const saved = listed(terminal.machineId).find(session => session.id === sessionId);
    return { kind: "running" as const, sessionId, machineId: terminal.machineId, terminalId: terminal.id,
      title: saved?.title ?? null, folder: terminal.cwd ?? saved?.cwd ?? null, at: terminal.createdAt };
  }).sort((left, right) => right.at - left.at);
  const held = new Set(running.map(row => `${row.machineId}\n${row.sessionId}`));
  const saved = [...reads.keys()].flatMap(machineId => listed(machineId)
    .filter(session => !held.has(`${machineId}\n${session.id}`))
    .map(session => ({ kind: "saved" as const, sessionId: session.id, machineId, terminalId: null,
      title: session.title, folder: session.cwd, at: session.updatedAt })))
    .sort((left, right) => right.at - left.at);
  return { running, saved };
}

/** What a row is called: its title, else its folder, else the start of its session id. */
export function sessionName(row: SessionRow): string {
  return row.title || row.folder || `session ${row.sessionId.slice(0, 8)}`;
}

/**
 * The group's one note: counts, "team not recorded" once (today no session records the team it
 * ran with), and, where saved sessions are listed in a read-only workspace, that only Open works.
 */
export function sessionsNote(running: number, saved: number, readOnly: boolean): string {
  return [running ? `${running} running` : "none running", saved ? `${saved} saved` : null, running + saved ? "team not recorded" : null,
    readOnly && saved ? "read-only: Open only" : null].filter(part => part !== null).join(" · ");
}

export type MachineState =
  | { state: "online" | "offline" | "revoked"; name: string }
  | { state: "unknown" | "roster" | "pending"; name: string | null };

/** A machine as the roster reports it: `roster` when the roster could not be read, `pending` before its first answer. */
export function machineState(machineId: string, machines: readonly MachineSummary[] | null, rosterError: string | null): MachineState {
  const machine = machines?.find(candidate => candidate.id === machineId);
  if (rosterError !== null) return { state: "roster", name: machine?.name ?? null };
  if (machines === null) return { state: "pending", name: null };
  if (!machine) return { state: "unknown", name: null };
  return { state: machine.revoked ? "revoked" : machine.online ? "online" : "offline", name: machine.name };
}

/**
 * Where an explicit read stands for each permitted machine: online ones not yet read offer a
 * Read control, reading and failed ones say so, offline ones are named once. Revoked machines
 * offer nothing. Nothing at all while the roster cannot be read.
 */
export function machineReads(machines: readonly MachineSummary[] | null, rosterError: string | null, reads: ReadonlyMap<string, SessionRead>) {
  const permitted = rosterError === null ? machines ?? [] : [];
  const live = permitted.filter(machine => machine.online && !machine.revoked);
  return {
    unread: live.filter(machine => !reads.has(machine.id)),
    reading: live.filter(machine => reads.get(machine.id)?.state === "reading"),
    failed: live.flatMap(machine => { const read = reads.get(machine.id); return read?.state === "failed" ? [{ machine, error: read.error }] : []; }),
    empty: live.filter(machine => { const read = reads.get(machine.id); return read?.state === "read" && read.sessions.length === 0; }),
    offline: permitted.filter(machine => !machine.online && !machine.revoked),
  };
}

// ---------------------------------------------------------------- row verdicts

export type RowIntent = "open" | "resume" | "resume-with-team";
export type RowVerdict = { open: true } | { open: false; reason: string };

/**
 * Whether a row's verb may start, from the one gate's verdict on the same intent and the row's
 * machine. The gate is asked first where it speaks for every row (a step in flight, a waiting
 * charge, a read-only workspace); then the row's machine, which only the row knows; then the rest
 * of the gate. Resuming runs on the line's machine, so a saved session elsewhere waits for that
 * machine to be chosen on the line. The gate's "choose a saved session" never applies: the row is
 * the choice.
 */
export function rowVerdict(intent: RowIntent, gate: GateVerdict, machine: MachineState, rowMachineId: string, destinationId: string): RowVerdict {
  const refusal = gate.open ? null : gate.refusal;
  if (refusal && (refusal.code === "running" || refusal.code === "charge" || (intent !== "open" && refusal.code === "read-only")))
    return { open: false, reason: refusal.text };
  const name = machine.name ?? "Its machine";
  switch (machine.state) {
    case "roster": return { open: false, reason: "The machine list could not be read." };
    case "pending": return { open: false, reason: "Reading the machine list…" };
    case "unknown": return { open: false, reason: "Its machine is not in your machine list." };
    case "revoked": return { open: false, reason: `${name}'s access is revoked.` };
    case "offline": return { open: false, reason: `${name} is offline.` };
    case "online": break;
  }
  if (intent !== "open" && rowMachineId !== destinationId) return { open: false, reason: `On ${name} · choose it on the line to resume here.` };
  if (refusal && refusal.code !== "no-session") return { open: false, reason: refusal.text };
  return { open: true };
}

// ---------------------------------------------------------------- provenance

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 86_400_000;

/** A past moment as a clock reads it: `14:02` today, `Wed 14:02` this week, `12 Sep` before, with the year when it differs. */
export function pastMoment(at: number, now: number): string {
  const date = new Date(at), today = new Date(now);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === today.toDateString()) return time;
  if (now - at < 6 * DAY_MS && at < now) return `${WEEKDAYS[date.getDay()]} ${time}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${date.getFullYear() === today.getFullYear() ? "" : ` ${date.getFullYear()}`}`;
}

/** The shared record's provenance fields the fallback reads (contract.ts `Configuration`). */
export type SavedTeam = { selection: Selection | null; updatedBy: string; updatedAt: number };

/**
 * Where the line's team comes from, when no recent team says it already ("this team"): the
 * workspace team, with when and by whom it was saved. Null when a recent team matches the line,
 * when the line is not the saved team, or when there is none. `names` maps principal ids to the
 * names the panel can see; the viewer is "you", anyone else unseen is "another member".
 */
export function teamProvenance(line: Selection | null, recents: readonly RecentTeam[], saved: SavedTeam | null,
  viewer: string, names: ReadonlyMap<string, string>, now: number): string | null {
  if (!line || !saved?.selection || !sameTeam(line, saved.selection)) return null;
  if (recents.some(team => sameTeam(team.selection, line))) return null;
  const by = saved.updatedBy === viewer ? "you" : names.get(saved.updatedBy) ?? "another member";
  return `Workspace team · saved ${pastMoment(saved.updatedAt, now)} by ${by}`;
}
