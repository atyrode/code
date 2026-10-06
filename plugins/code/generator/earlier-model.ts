import type { MachineSummary, TerminalSummary } from "@manifold/protocol";
import type { OmpSessionSummary } from "@atyrode/manifold-omp";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import type { Route, Selection } from "../../domain/contracts.ts";
import { providerPolicy } from "../../domain/providers.ts";
import { roleOutcomes, type QuotaPool } from "../../domain/quota.ts";
import type { Review } from "../../domain/routing.ts";
import { previewSelection } from "./dial-space.ts";
import type { GateVerdict } from "./launch-step.ts";
import { RECENT_TEAMS_LIMIT, type RecentTeam } from "./recent-teams.ts";
import { extrasOn, sameTeam, teamWords, type StatementWord, type TeamWord, type TeamWords, type Vocabulary } from "./statement-model.ts";

/*
 * Earlier statements as data: the profiles and sessions under the settings, each said in the
 * settings' own words (statement-model.ts `teamWords`) and only where it differs from them. Pure,
 * so the rendering, the digit order and the row verdicts are tested without a panel.
 */

// ---------------------------------------------------------------- the statement's words

/** The statement's settings in words, the machine's name included: what every row is compared with. */
export type StatementWords = Readonly<Record<StatementWord, string>>;

const TEAM_WORDS: readonly TeamWord[] = ["lane", "tier", "thinking", "advisor", "extras"];

/** A setting's value with the word that names it (`high thinking`, `advisor off`), for a row that stands without the settings beside it. */
export function phrase(word: TeamWord, text: string): string {
  return word === "thinking" ? `${text} thinking` : word === "advisor" ? `advisor ${text}` : text;
}

/** A whole profile in one phrase, for a control's name: `GPT only, elite, x-high thinking, advisor off, no extras`. */
export function teamSentence(words: TeamWords): string {
  return TEAM_WORDS.map(word => phrase(word, words[word])).join(", ");
}

// ---------------------------------------------------------------- differences

export type Difference = { word: TeamWord; text: string };
/** The settings a row is compared with: their words, and the profile behind them once there is one. */
export type LineTeam = { words: TeamWords; selection: Selection | null };

/**
 * The words of `team` that differ from the statement's, in reading order; empty when the row is the
 * shown profile, which it then reads as "this profile". Identity is decided on the selections,
 * because words can coincide for different profiles. Extras are written as the change from the
 * statement's: the switches the profile adds by name, the ones it drops as "no fallbacks", and "no
 * extras" for none at all.
 */
export function differences(team: Selection, line: LineTeam, familyWord: (family: string) => string): Difference[] {
  if (line.selection && sameTeam(team, line.selection)) return [];
  const words = teamWords(team, familyWord);
  const changed: Difference[] = TEAM_WORDS.filter(word => word !== "extras" && words[word] !== line.words[word])
    .map(word => ({ word, text: words[word] }));
  const on = extrasOn(team);
  if (!line.selection) {
    if (words.extras !== line.words.extras) changed.push({ word: "extras", text: words.extras });
    return changed;
  }
  const lineOn = extrasOn(line.selection);
  const added = on.filter(extra => !lineOn.includes(extra)), dropped = lineOn.filter(extra => !on.includes(extra));
  if (added.length || dropped.length) {
    changed.push({ word: "extras", text: on.length === 0 ? "no extras" : [...added, ...dropped.map(extra => `no ${extra}`)].join(", ") });
  }
  return changed;
}

// ---------------------------------------------------------------- what a team would strand

/**
 * What a team would strand on the present pools, in a row's words: roles with no route grouped by
 * when their own routes return, the soonest first, each group with its own time ("3 no route until
 * 13:00 · 9 until 16:30"), then roles that no included account serves ("2 no GPT account"), in the
 * family words of the status lines.
 * Null when every role has a route; a fallback that takes over strands nothing.
 */
export function strandsNote(catalog: CompiledCatalog, routes: readonly Route[], pools: readonly QuotaPool[], vocab: Vocabulary): string | null {
  const waits = new Map<number | null, number>();
  const unserved = new Map<string, number>();
  for (const outcome of roleOutcomes(catalog, routes, pools)) {
    if (outcome.kind === "no-route") waits.set(outcome.until, (waits.get(outcome.until) ?? 0) + 1);
    if (outcome.kind === "no-account") {
      const family = providerPolicy(outcome.provider).family;
      unserved.set(family, (unserved.get(family) ?? 0) + 1);
    }
  }
  // A reopening nobody reported comes last: it may be the latest of all.
  const groups = [...waits].sort(([left], [right]) => (left ?? Number.POSITIVE_INFINITY) - (right ?? Number.POSITIVE_INFINITY));
  const parts = [
    ...groups.map(([until, count], index) => `${count}${index === 0 ? " no route" : ""} ${until === null ? "with no reset known" : `until ${vocab.time(until)}`}`),
    ...[...unserved].map(([family, count]) => `${count} no ${vocab.family(family)} account`),
  ];
  return parts.length ? parts.join(" · ") : null;
}

// ---------------------------------------------------------------- a recent team on today's catalog

/** The selection fields each word of a team sets. */
const WORD_FIELDS: Readonly<Record<TeamWord, readonly (keyof Selection)[]>> = {
  lane: ["lane"], tier: ["capability"], thinking: ["thinking"], advisor: ["advisor"],
  extras: ["spark", "priority", "prewalk", "planYolo", "fallback", "budget"],
};

/** A recent team as the line's catalog forms it: its review, or the word the catalog has no route for and why, said in the row's words. */
export type RecentForm = { readonly kind: "formed"; readonly review: Review } | { readonly kind: "refused"; readonly word: TeamWord; readonly reason: string };

/**
 * Whether the catalog forms a recent team exactly, as a recall requires (a team narrowed to fit is
 * not the team that was launched), and when it does not, which word is to blame: the first whose
 * value alone, set on the line's team, the catalog cannot form. A team refused only as a whole
 * blames its first word that differs from the line.
 */
export function formRecent(catalog: CompiledCatalog, line: Selection, team: Selection, familyWord: (family: string) => string, nowMs: number): RecentForm {
  const review = previewSelection(catalog, team, nowMs);
  if (review) return { kind: "formed", review };
  const words = teamWords(team, familyWord), lineWords = teamWords(line, familyWord);
  const alone = (word: TeamWord) => ({ ...line, ...Object.fromEntries(WORD_FIELDS[word].map(field => [field, team[field]])) }) as Selection;
  const word = TEAM_WORDS.find(candidate => !sameTeam(alone(candidate), line) && previewSelection(catalog, alone(candidate), nowMs) === null)
    ?? TEAM_WORDS.find(candidate => words[candidate] !== lineWords[candidate]) ?? "lane";
  const lead = team.lane.kind === "mixed" ? "openai" : team.lane.family;
  return { kind: "refused", word, reason: word === "tier" ? `No ${words.tier} ${familyWord(lead)} model here` : `${phrase(word, words[word])} has no route here` };
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
/**
 * A machine's explicit saved-session read. A read keeps its answer and when it came (`at`); asked
 * again, it keeps showing that answer, marked `again`, until the new one lands.
 */
export type SessionRead =
  | { state: "reading" }
  | { state: "read"; sessions: readonly OmpSessionSummary[]; at: number; again: boolean }
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

/** What a row shows beside its folder, which already says where: its title, else the start of its session id. */
export function sessionTitle(row: SessionRow): string {
  return row.title || `session ${row.sessionId.slice(0, 8)}`;
}

/** One folder's saved sessions on one machine, newest first: a single row whose drum holds the older ones. */
export type SavedFolder = { readonly key: string; readonly machineId: string; readonly folder: string | null; readonly sessions: readonly SessionRow[] };

/**
 * Saved sessions as one row per folder and machine, the folders in the order of their newest
 * session, so a machine with hundreds of transcripts stays one row per place it worked in and no
 * session is hidden behind a count. Sessions without a folder share one row per machine.
 */
export function savedFolders(saved: readonly SessionRow[]): SavedFolder[] {
  const folders = new Map<string, SessionRow[]>();
  for (const row of [...saved].sort((left, right) => right.at - left.at)) {
    const key = JSON.stringify([row.machineId, row.folder]);
    folders.set(key, [...folders.get(key) ?? [], row]);
  }
  return [...folders].map(([key, sessions]) => ({ key, machineId: sessions[0]!.machineId, folder: sessions[0]!.folder, sessions }));
}

/**
 * The group's one note: counts, "profile not recorded" once (today no session records the profile it
 * ran with), and, where saved sessions are listed in a read-only workspace, that only Open works.
 * `running` is null while the terminal inventory is unread or failed: running is then unknown, never none.
 */
export function sessionsNote(running: number | null, saved: number, readOnly: boolean): string {
  return [running === null ? "running unknown" : running ? `${running} running` : "none running", saved ? `${saved} saved` : null,
    (running ?? 0) + saved ? "profile not recorded" : null, readOnly && saved ? "read-only: Open only" : null].filter(part => part !== null).join(" · ");
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
 * Read control; reading ones, a first read or one asked again, say so; read ones say when, with
 * how many sessions they reported; failed ones say why; offline ones are named once. Revoked
 * machines offer nothing. Nothing at all while the roster cannot be read.
 */
export function machineReads(machines: readonly MachineSummary[] | null, rosterError: string | null, reads: ReadonlyMap<string, SessionRead>) {
  const permitted = rosterError === null ? machines ?? [] : [];
  const live = permitted.filter(machine => machine.online && !machine.revoked);
  return {
    unread: live.filter(machine => !reads.has(machine.id)),
    reading: live.filter(machine => { const read = reads.get(machine.id); return read?.state === "reading" || (read?.state === "read" && read.again); }),
    read: live.flatMap(machine => { const read = reads.get(machine.id); return read?.state === "read" && !read.again ? [{ machine, at: read.at, sessions: read.sessions.length }] : []; }),
    failed: live.flatMap(machine => { const read = reads.get(machine.id); return read?.state === "failed" ? [{ machine, error: read.error }] : []; }),
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

// ---------------------------------------------------------------- what the view's last verb came to

/** A line of the sessions view's own: what its last verb came to, warm when it failed or was refused. */
export type SessionSaid = { readonly text: string; readonly failed: boolean };
/**
 * The view's last verb: a refusal or failure it said itself, or a resume the workbench model
 * carries out, whose words are the model's message once that resume has set one. `before` is the
 * message standing when the resume was pressed, so an older message is never taken for its answer.
 */
export type SessionPress = { readonly kind: "said"; readonly said: SessionSaid } | { readonly kind: "resume"; readonly before: SessionSaid | null };

/** What the sessions view says of its last verb: nothing while a resume runs or before it answers. */
export function sessionSaid(press: SessionPress | null, message: SessionSaid | null, resuming: boolean): SessionSaid | null {
  if (press === null) return null;
  if (press.kind === "said") return press.said;
  return resuming || message === press.before ? null : message;
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
 * Where the shown profile comes from, when no recent profile says it already ("this profile"): the
 * workspace profile, with when and by whom the workspace record last changed. Every write to the
 * record (an account switched, a catalog staged) stamps that time and name, so they are the
 * record's, never a claim about who saved the profile. Null when a recent profile matches the shown
 * one, when the shown profile is not the saved one, or when there is none. `names` maps principal ids to the names
 * the panel can see; the viewer is "you", anyone else unseen is "another member".
 */
export function teamProvenance(line: Selection | null, recents: readonly RecentTeam[], saved: SavedTeam | null,
  viewer: string, names: ReadonlyMap<string, string>, now: number): string | null {
  if (!line || !saved?.selection || !sameTeam(line, saved.selection)) return null;
  if (recents.some(team => sameTeam(team.selection, line))) return null;
  const by = saved.updatedBy === viewer ? "you" : names.get(saved.updatedBy) ?? "another member";
  return `Workspace profile · last change to the workspace ${pastMoment(saved.updatedAt, now)} by ${by}`;
}
