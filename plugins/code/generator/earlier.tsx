import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent, type ReactNode, type SetStateAction } from "react";
import type { HostServices } from "@manifold/plugin";
import { ATTENDANCE_RESOURCE, FALLBACK_POLL_MS, usePolledResource } from "@manifold/plugin/hooks";
import { formatManifoldUri, type Attendance } from "@manifold/protocol";
import { OMP_PLUGIN_ID } from "@atyrode/manifold-omp";
import type { Lane } from "../../domain/contracts.ts";
import type { QuotaPool } from "../../domain/quota.ts";
import { codeOperationFailure, codeWorkflow, useCodeMachines, useCodeTerminals, useWorkflowQuery } from "../machine-web.ts";
import { WorkflowError } from "../workflow.ts";
import { accountWord, familyWord, hueOf, since, useMinuteTick } from "../ui.tsx";
import type { KeyHelp } from "./keys-dialog.tsx";
import { when } from "./board-model.ts";
import type { RecentTeam } from "./recent-teams.ts";
import type { TeamPreview } from "./statement.tsx";
import type { WorkbenchActions, WorkbenchModel } from "./workbench-model.ts";
import {
  differences, formRecent, machineReads, machineState, phrase, pinRecents, rowVerdict, savedFolders, sessionName, sessionRows, sessionsNote,
  strandsNote, teamProvenance, teamSentence, type RecentForm, type RowIntent, type RowVerdict, type SavedFolder, type SessionRead, type SessionRow, type StatementWords,
} from "./earlier-model.ts";
import { sameTeam, teamWords, type Vocabulary } from "./statement-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
/** The keys the panel's keys dialog lists for the recent teams; the digits are decided with the statement's keys (statement-keys.ts). */
export const EARLIER_KEY_HELP: readonly KeyHelp[] = [{ keys: ["1–9"], text: "Recall the recent team with that number" }];
/** The keys a folder's saved sessions answer on their drum (`SessionDrum`). */
export const SESSIONS_KEY_HELP: readonly KeyHelp[] = [
  { keys: ["↑", "↓"], text: "On a folder's session: the newer or the older one" },
  { keys: ["↵", "Space"], text: "Open or close the folder's sessions" },
  { keys: ["Esc"], text: "Close them; the shown session stays" },
];

/**
 * The part of the workbench the earlier statements read and act through; a `WorkbenchModel`
 * satisfies it. A row's Resume asks `gate` with its own session, so its refusal shows before it is pressed.
 */
export type EarlierModel = Pick<WorkbenchModel, "compiled" | "profile" | "selection" | "record" | "localDraft" | "machineId" | "savedSessionId" | "setSavedSessionId" | "inFlight" | "gate"> & {
  actions: Pick<WorkbenchActions, "resume" | "recallTeam" | "discardChanges">;
};
export type EarlierProps = {
  host: HostServices;
  model: EarlierModel;
  /** The statement's current words, which every row is compared with. */
  line: StatementWords;
  /** The recent teams in digit order (`usePinnedRecents`), shared with the statement's digit keys. */
  recents: readonly RecentTeam[];
  /** `quotaPools` over the present usage reading, which a recent team's fate is judged on. */
  pools: readonly QuotaPool[];
  /** The panel's pointed team: a recent row under the pointer or focus previews here, as `team:<digit>`, and clears only its own. */
  setPreview: Dispatch<SetStateAction<TeamPreview | null>>;
  /** Bumped by the panel's refresh, which reads every machine already read again. */
  rereads: number;
  /** The panel's one polite live region. */
  announce: (text: string) => void;
};

/**
 * The browser's recent teams, pinned to their digits for the panel's life (earlier-model.ts
 * `pinRecents`). Call it once per panel and hand the list to both the statement and the earlier
 * statements, so a digit means the same team in both.
 */
export function usePinnedRecents(teams: readonly RecentTeam[]): readonly RecentTeam[] {
  const [pinned, setPinned] = useState(() => ({ source: teams, list: pinRecents([], teams) }));
  if (pinned.source === teams) return pinned.list;
  // Derived during render, React's documented pattern for state that follows a prop.
  const next = { source: teams, list: pinRecents(pinned.list, teams) };
  setPinned(next);
  return next.list;
}

/**
 * One permitted machine's saved sessions, read once asked and kept current by the shared feed
 * while it stays mounted. `attempt` names the request, so asking again is a fresh read.
 */
function MachineRead({ host, machineId, attempt, report }: {
  host: HostServices; machineId: string; attempt: number; report: (machineId: string, read: SessionRead) => void;
}) {
  const query = useWorkflowQuery(host, `earlier-sessions:${host.containerId}:${machineId}:${attempt}`, true, () => codeWorkflow(host).listSessions(machineId));
  useEffect(() => {
    report(machineId, query.data ? { state: "read", sessions: query.data, at: Date.now(), again: false } : query.error ? { state: "failed", error: query.error } : { state: "reading" });
  }, [machineId, query.data, query.error, report]);
  return null;
}

function LaneMark({ lane }: { lane: Lane }) {
  const families = lane.kind === "mixed" ? ["openai", "anthropic"] : [lane.family];
  return <span className={`${G}earlier-marks`} aria-hidden="true">
    {families.map(family => <span key={family} className="plugin-atyrode_code__mark" data-fam={hueOf(family)} />)}
  </span>;
}

/**
 * A row's verb, named with its object. Always focusable: a refused one is `aria-disabled`, carries
 * its reason as its description and tooltip, and says it in the live region when pressed.
 * `onPoint` hears the pointer and focus arrive and leave, for a row that previews what it would do.
 */
function Verb({ className, name, subject, verdict, busy = false, onPress, onPoint, announce, children, ...data }: {
  className: string; name: string; subject?: string; verdict: RowVerdict; busy?: boolean; onPress: () => void; onPoint?: (via: "pointer" | "focus", on: boolean) => void;
  announce: (text: string) => void; children: ReactNode; [attribute: `data-${string}`]: string | number | true | undefined;
}) {
  const reason = useId();
  return <>
    <button type="button" className={className} aria-label={name} aria-disabled={verdict.open ? undefined : "true"} aria-busy={busy || undefined}
      aria-describedby={verdict.open ? undefined : reason} title={verdict.open ? undefined : verdict.reason} {...data}
      onPointerEnter={onPoint && (() => onPoint("pointer", true))} onPointerLeave={onPoint && (() => onPoint("pointer", false))}
      onFocus={onPoint && (() => onPoint("focus", true))} onBlur={onPoint && (() => onPoint("focus", false))}
      onClick={() => { if (verdict.open) onPress(); else announce(`${subject ?? name} · ${verdict.reason}`); }}>{children}</button>
    {!verdict.open && <span id={reason} hidden>{verdict.reason}</span>}
  </>;
}

/**
 * A folder's sessions as the statement's drum: the shown session is the value; ↑/↓ turn it (up is
 * newer), Home/End go to the newest and the oldest, Enter or Space open the whole list below it and
 * choose the one under the cursor, Esc closes, a click opens it or chooses. The older sessions live
 * here, never behind a count. While open it owns its keys (`data-popover`), so the panel's keys
 * leave them alone.
 */
function SessionDrum({ id, folder, index, now, onChoose }: { id: string; folder: SavedFolder; index: number; now: number; onChoose: (index: number) => void }) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(index);
  const box = useRef<HTMLSpanElement>(null);
  const { sessions } = folder;
  const name = sessionName(sessions[index]!);
  useEffect(() => {
    if (!open) return;
    const document = box.current?.ownerDocument;
    const close = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document?.addEventListener("pointerdown", close, true);
    return () => document?.removeEventListener("pointerdown", close, true);
  }, [open]);
  useLayoutEffect(() => {
    if (open) box.current?.querySelector<HTMLElement>(`#${CSS.escape(`${id}-${cursor}`)}`)?.scrollIntoView({ block: "nearest" });
  }, [open, cursor]);
  function turn(to: number) {
    const next = Math.max(0, Math.min(sessions.length - 1, to));
    if (open) setCursor(next);
    else if (next !== index) onChoose(next);
  }
  function keys(event: KeyboardEvent<HTMLSpanElement>) {
    const at = open ? cursor : index;
    switch (event.key) {
      case "ArrowUp": turn(at - 1); break;
      case "ArrowDown": turn(at + 1); break;
      case "Home": turn(0); break;
      case "End": turn(sessions.length - 1); break;
      case "Enter": case " ":
        if (event.repeat) break;
        if (open) { onChoose(cursor); setOpen(false); } else { setCursor(index); setOpen(true); }
        break;
      case "Escape": if (!open) return; setOpen(false); break;
      default: return;
    }
    event.preventDefault();
  }
  return <span ref={box} className={`${G}earlier-drum-word`} role="listbox" tabIndex={0} aria-label={`Saved sessions in ${folder.folder ?? "no folder"}`}
    aria-activedescendant={`${id}-${open ? cursor : index}`} data-open={open || undefined} data-popover={open ? "" : undefined}
    onKeyDown={keys} onBlur={() => setOpen(false)}>
    <span className={`${G}earlier-name`} title={name} aria-hidden="true" onClick={() => { setCursor(index); setOpen(!open); }}>{name}</span>
    <span className={`${G}earlier-drum`}>{sessions.map((row, position) => <span key={row.sessionId} id={`${id}-${position}`} role="option"
      className={`${G}earlier-option`} aria-selected={position === index} data-current={position === index || undefined} data-cursor={(open && position === cursor) || undefined}
      onClick={event => { event.stopPropagation(); onChoose(position); setOpen(false); }}>
      <span className={`${G}earlier-option-name`}>{sessionName(row)}</span>
      <span className={`${G}earlier-age`}>{since(now - row.at)}</span>
    </span>)}</span>
  </span>;
}

/**
 * EARLIER STATEMENTS: the sessions running or saved on the permitted machines, and the teams this
 * browser launched, each said only where it differs from the line. Every verb asks the workbench's
 * one gate (launch-step.ts `actionGate`) through the model, before it starts and again between its
 * steps; a refused one does nothing and says why.
 */
export function EarlierStatements({ host, model, line, recents, pools, setPreview, rereads, announce }: EarlierProps) {
  const id = useId();
  useMinuteTick();
  const now = Date.now();
  const { machines, error: rosterError } = useCodeMachines(host);
  const terminals = useCodeTerminals(host);
  // Saved sessions are read only on request, one machine at a time (today's explicit-read contract).
  const [attempts, setAttempts] = useState<ReadonlyMap<string, number>>(new Map());
  const [reads, setReads] = useState<ReadonlyMap<string, SessionRead>>(new Map());
  // The session each folder shows, by folder key; a folder shows its newest until another is chosen.
  const [chosen, setChosen] = useState<ReadonlyMap<string, string>>(new Map());
  const [active, setActive] = useState<string | null>(null);
  const [pending, setPending] = useState<{ sessionId: string; withTeam: boolean } | null>(null);
  const latest = useRef(model);
  latest.current = model;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // One row verb at a time, decided before any render: a double press must not start a second resume whose end would clear the first one's session.
  const acting = useRef(false);

  // A read asked again keeps its last answer on show until the new one lands.
  const report = useCallback((machineId: string, read: SessionRead) => setReads(previous => {
    const was = previous.get(machineId);
    return new Map(previous).set(machineId, read.state === "reading" && was?.state === "read" ? { ...was, again: true } : read);
  }), []);
  const readers = (machines ?? []).filter(machine => attempts.has(machine.id) && rosterError === null && machine.online && !machine.revoked);
  // A read stands only while its machine is permitted and online; an offline machine's last answer is not offered.
  const standing = new Map([...reads].filter(([machineId]) => readers.some(machine => machine.id === machineId)));
  const reading = machineReads(machines, rosterError, standing);
  const rows = sessionRows(terminals.terminals ?? [], standing, OMP_PLUGIN_ID);
  const folders = savedFolders(rows.saved);
  const resumeGate = model.gate("resume");
  const readOnly = !resumeGate.open && resumeGate.refusal.code === "read-only";

  const viewer = host.principal.id;
  const { value: attendance } = usePolledResource<readonly Attendance[]>(() => host.client.attendanceByContainer(), FALLBACK_POLL_MS, {
    key: ATTENDANCE_RESOURCE, initial: [], enabled: model.record !== null && model.record.updatedBy !== viewer,
    topics: host.topics.attendance, events: host.client,
  });
  const names = useMemo(() => new Map(attendance.flatMap(room => room.principals.map(principal => [principal.id, principal.name] as const))), [attendance]);
  const provenance = teamProvenance(model.selection, recents, model.record, viewer, names, now);

  function verdict(intent: RowIntent, row: SessionRow): RowVerdict {
    return rowVerdict(intent, intent === "open" ? model.gate(intent) : model.gate(intent, row.sessionId),
      machineState(row.machineId, machines, rosterError), row.machineId, model.machineId);
  }
  // A Read button goes once its read starts, so the read takes focus to the sessions and, when the
  // machine answers, on to its first row's verb (or Read again); never out of the panel with the button.
  const sessions = useRef<HTMLElement>(null);
  const awaited = useRef<string | null>(null);
  function read(machineId: string, follow: boolean) {
    setAttempts(previous => new Map(previous).set(machineId, (previous.get(machineId) ?? 0) + 1));
    setReads(previous => {
      const was = previous.get(machineId);
      return new Map(previous).set(machineId, was?.state === "read" ? { ...was, again: true } : { state: "reading" });
    });
    terminals.refresh();
    if (!follow) return;
    awaited.current = machineId;
    sessions.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    const machineId = awaited.current, group = sessions.current;
    const answer = machineId === null ? undefined : reads.get(machineId);
    if (machineId === null || !group || answer?.state === "reading" || (answer?.state === "read" && answer.again)) return;
    awaited.current = null;
    if (group.ownerDocument.activeElement !== group) return;
    const at = CSS.escape(machineId);
    group.querySelector<HTMLElement>(`[data-machine-id="${at}"] [data-verb], [data-read="${at}"]`)?.focus({ preventScroll: true });
  }, [reads]);
  // The panel's refresh reads every machine already read again, where it stands, without moving focus.
  const refreshed = useRef(rereads);
  useEffect(() => {
    if (refreshed.current === rereads) return;
    refreshed.current = rereads;
    for (const machine of readers) read(machine.id, false);
  }, [rereads]);

  function settle() {
    acting.current = false;
    if (mounted.current) setActive(null);
  }
  async function open(row: SessionRow) {
    if (acting.current) return;
    acting.current = true;
    const terminalId = row.terminalId!;
    setActive(`open:${terminalId}`);
    try {
      const running = await codeWorkflow(host).runningSession({ harness: OMP_PLUGIN_ID, machineId: row.machineId, sessionId: row.sessionId });
      if (!running.some(terminal => terminal.id === terminalId)) throw new WorkflowError("That terminal is no longer running. Nothing was opened.");
      // Asked again on the latest facts: a step that started while looking stops here.
      const again = rowVerdict("open", latest.current.gate("open"), machineState(row.machineId, machines, rosterError), row.machineId, latest.current.machineId);
      if (!again.open) throw new WorkflowError(`Nothing was opened: ${again.reason}`);
      if (mounted.current) host.navigate(formatManifoldUri({ kind: "terminal", terminalId }));
    } catch (reason) {
      announce(codeOperationFailure(reason));
    } finally {
      settle();
      terminals.refresh();
    }
  }
  async function finishResume(withTeam: boolean) {
    try { await latest.current.actions.resume(withTeam); }
    finally {
      // Whatever came of it, no session stays chosen behind the rows: the next Resume names its own.
      latest.current.setSavedSessionId("");
      settle();
    }
  }
  function resume(row: SessionRow, withTeam: boolean) {
    if (acting.current) return;
    acting.current = true;
    setActive(`resume:${row.sessionId}`);
    // The model resumes the session it has chosen; choosing is a render away, so the resume waits for it (below).
    if (model.savedSessionId === row.sessionId) void finishResume(withTeam);
    else { model.setSavedSessionId(row.sessionId); setPending({ sessionId: row.sessionId, withTeam }); }
  }
  useEffect(() => {
    if (!pending) return;
    setPending(null);
    // The choice landed, unless the destination changed under it and cleared it.
    if (model.savedSessionId !== pending.sessionId) { settle(); announce("The line's machine changed. Nothing was resumed."); return; }
    const again = model.gate(pending.withTeam ? "resume-with-team" : "resume");
    if (!again.open) { model.setSavedSessionId(""); settle(); announce(`Nothing was resumed: ${again.refusal.text}`); return; }
    void finishResume(pending.withTeam);
  }, [pending, model.savedSessionId]);

  // ------------------------------------------------------------ recent teams on today's catalog and pools
  const vocab = useMemo<Vocabulary>(() => ({ family: familyWord, account: accountWord, time: at => when(at, Date.now()) }), []);
  const { compiled, selection, profile } = model;
  const forms = useMemo(() => recents.map((team): RecentForm | null => {
    if (!compiled || !selection) return null;
    // A bundled starter derives another catalog for another budget, which the board cannot draw: such a team is recalled as it is, unpreviewed.
    if (profile?.metadata && team.selection.budget !== profile.selection.budget) return null;
    return formRecent(compiled, selection, team.selection, familyWord, Date.now());
  }), [recents, compiled, selection, profile]);
  const fates = useMemo(() => forms.map(form => form?.kind === "formed" && compiled ? strandsNote(compiled, form.review.routes, pools, vocab) : null),
    [forms, compiled, pools, vocab]);
  // The row under the pointer, else the one with focus, shows what recalling it would do in the status line and on the board.
  const [pointed, setPointed] = useState<{ pointer: number | null; focus: number | null }>({ pointer: null, focus: null });
  const shownIndex = pointed.pointer ?? pointed.focus;
  useEffect(() => {
    const team = shownIndex === null ? undefined : recents[shownIndex];
    const form = shownIndex === null ? null : forms[shownIndex];
    const here = team && selection ? sameTeam(team.selection, selection) : false;
    if (team && form?.kind === "formed" && !here) {
      setPreview({ key: `team:${shownIndex! + 1}`, selection: team.selection, review: form.review, label: `Team ${shownIndex! + 1}` });
    } else setPreview(previous => previous?.key.startsWith("team:") ? null : previous);
  }, [shownIndex, recents, forms, selection]);
  useEffect(() => () => setPreview(previous => previous?.key.startsWith("team:") ? null : previous), []);
  function point(index: number, via: "pointer" | "focus", on: boolean) {
    setPointed(previous => ({ ...previous, [via]: on ? index : previous[via] === index ? null : previous[via] }));
  }

  function recall(team: RecentTeam, index: number) {
    // Back to the saved team is a discard, not a local edit that happens to match it.
    if (model.localDraft && model.record?.selection && sameTeam(team.selection, model.record.selection)) model.actions.discardChanges();
    else model.actions.recallTeam(team);
    const fate = fates[index];
    announce(`Recalled team ${index + 1}${fate ? ` · ${fate}` : ""}.`);
  }

  /** A running session, or a folder's shown session with the folder's others in its drum (`place`: the folder and its position in the list). */
  function sessionRow(row: SessionRow, place: { readonly folder: SavedFolder; readonly index: number } | null) {
    const name = sessionName(row);
    const busy = active === (row.kind === "running" ? `open:${row.terminalId}` : `resume:${row.sessionId}`);
    const group = place?.folder ?? null;
    const position = group ? group.sessions.indexOf(row) : -1;
    const where = group ? group.folder : row.folder;
    return <li key={group?.key ?? row.terminalId ?? `${row.machineId}:${row.sessionId}`} className={`${G}earlier-session`} data-kind={row.kind}
      data-session-id={row.sessionId} data-machine-id={row.machineId} data-terminal-id={row.terminalId ?? undefined}
      data-folder-sessions={group && group.sessions.length > 1 ? group.sessions.length : undefined}>
      <span className={`${G}earlier-verbs`}>
        <span className={`${G}earlier-dot`} data-running={row.kind === "running" || undefined} aria-hidden="true" />
        {row.kind === "running"
          ? <Verb className={`${G}earlier-verb`} name={`Open ${name}`} verdict={verdict("open", row)} busy={busy} data-verb="open"
            onPress={() => void open(row)} announce={announce}>{busy ? "Opening…" : "Open"}</Verb>
          : <Verb className={`${G}earlier-verb`} name={`Resume ${name} as saved`} verdict={verdict("resume", row)} busy={busy} data-verb="resume"
            onPress={() => resume(row, false)} announce={announce}>{busy && model.inFlight === "resume" ? "Resuming…" : "Resume as saved"}</Verb>}
      </span>
      <span className={`${G}earlier-head-line`}>
        {place && group && group.sessions.length > 1
          ? <SessionDrum id={`${id}-folder-${place.index}`} folder={group} index={position} now={now}
            onChoose={index => setChosen(previous => new Map(previous).set(group.key, group.sessions[index]!.sessionId))} />
          : <span className={`${G}earlier-name`} data-path={row.title ? undefined : ""} title={name}>{name}</span>}
        {row.kind === "saved" && <Verb className={`${G}earlier-with`} name={`Resume ${name} with the current team`} verdict={verdict("resume-with-team", row)}
          data-verb="resume-with-team" onPress={() => resume(row, true)} announce={announce}>Resume with current team</Verb>}
      </span>
      <span className={`${G}earlier-where`}>
        <span className={`${G}earlier-machine`}>{machineState(row.machineId, machines, rosterError).name ?? "Unknown machine"}</span>
        {/* The folder is the row's place; said here once its title names the session. */}
        {where && row.title && <><span className={`${G}earlier-sep`} aria-hidden="true">·</span>
          <span className={`${G}earlier-folder`} title={where}>{where.split("/").filter(Boolean).at(-1) ?? where}</span></>}
        <span className={`${G}earlier-sep`} aria-hidden="true">·</span>
        <span title={`${row.kind === "running" ? "Started" : "Saved"} ${new Date(row.at).toLocaleString()}`}>{since(now - row.at)}</span>
        {group && group.sessions.length > 1 && <><span className={`${G}earlier-sep`} aria-hidden="true">·</span>
          <span>{position + 1} of {group.sessions.length} here</span></>}
      </span>
    </li>;
  }
  function folderRow(folder: SavedFolder, index: number) {
    const shown = folder.sessions.find(row => row.sessionId === chosen.get(folder.key)) ?? folder.sessions[0]!;
    return sessionRow(shown, { folder, index });
  }

  const recallGate = model.gate("edit-team");
  function recentRow(team: RecentTeam, index: number) {
    const digit = index + 1;
    const changed = differences(team.selection, { words: line, selection: model.selection }, familyWord);
    const here = changed.length === 0;
    const form = forms[index] ?? null;
    const refused = form?.kind === "refused" ? form : null;
    const fate = fates[index] ?? null;
    const allowed: RowVerdict = here ? { open: false, reason: "Already on the line." } : refused ? { open: false, reason: `${refused.reason}; nothing to recall.` }
      : recallGate.open ? recallGate : { open: false, reason: recallGate.refusal.text };
    return <li key={digit}>
      <Verb className={`${G}earlier-team`} name={`Recall team ${digit}: ${teamSentence(teamWords(team.selection, familyWord))}${fate ? `; ${fate}` : ""}`}
        subject={`Recall team ${digit}`} verdict={allowed} data-digit={digit} data-here={here || undefined} data-refused={refused ? "" : undefined}
        onPoint={(via, on) => point(index, via, on)} onPress={() => recall(team, index)} announce={announce}>
        <span className={`${G}earlier-digit`} aria-hidden="true">{digit}</span>
        <span className={`${G}earlier-words`}>
          {here ? <span className={`${G}earlier-word`} data-same="">this team</span> : changed.map((difference, position) => <Fragment key={difference.word}>
            {position > 0 && <span className={`${G}earlier-sep`} aria-hidden="true">·</span>}
            <span className={`${G}earlier-word`} data-off={refused?.word === difference.word || undefined} title={refused?.word === difference.word ? refused.reason : undefined}>
              {difference.word === "lane" && <LaneMark lane={team.selection.lane} />}{phrase(difference.word, difference.text)}</span>
          </Fragment>)}
          {fate && !here && <><span className={`${G}earlier-sep`} aria-hidden="true">·</span><span className={`${G}earlier-fate`}>{fate}</span></>}
          <span className={`${G}earlier-sep`} aria-hidden="true">·</span>
          <span className={`${G}earlier-age`}>{since(now - team.launchedAt)}</span>
        </span>
      </Verb>
    </li>;
  }

  return <section className={`${G}section ${G}earlier`} aria-label="Earlier statements">
    {readers.map(machine => <MachineRead key={machine.id} host={host} machineId={machine.id} attempt={attempts.get(machine.id)!} report={report} />)}
    <section ref={sessions} className={`${G}earlier-group`} aria-labelledby={`${id}-sessions`} tabIndex={-1}>
      <div className={`${G}earlier-head`}>
        <h2 id={`${id}-sessions`} className={`${G}earlier-title`}>sessions</h2>
        <span className={`${G}earlier-meta`}>{sessionsNote(terminals.terminals === null || terminals.error !== null ? null : rows.running.length, rows.saved.length, readOnly)}</span>
        {rosterError !== null ? <span className={`${G}earlier-meta`}>{rosterError}</span> : <>
          {reading.unread.map(machine => <button key={machine.id} type="button" className={`${G}earlier-link`} data-read={machine.id}
            aria-label={`Read saved sessions on ${machine.name}`} onClick={() => read(machine.id, true)}>Read {machine.name}</button>)}
          {reading.reading.map(machine => <span key={machine.id} className={`${G}earlier-meta`} data-read-state="reading" data-machine-id={machine.id}>reading {machine.name}…</span>)}
          {reading.read.map(({ machine, at, sessions: count }) => <span key={machine.id} className={`${G}earlier-meta`} data-read-state={count ? "read" : "empty"} data-machine-id={machine.id}>
            {count ? machine.name : `nothing saved on ${machine.name}`} · read {since(now - at)} ·{" "}
            <button type="button" className={`${G}earlier-link`} data-read={machine.id} aria-label={`Read saved sessions on ${machine.name} again`}
              onClick={() => read(machine.id, true)}>read again</button>
          </span>)}
          {reading.offline.map(machine => <span key={machine.id} className={`${G}earlier-meta`} data-read-state="offline" data-machine-id={machine.id}>{machine.name} offline</span>)}
        </>}
      </div>
      {terminals.error && <p className={`${G}earlier-note`}>{terminals.error}</p>}
      {reading.failed.map(({ machine, error }) => <p key={machine.id} className={`${G}earlier-note`} data-read-state="failed" data-machine-id={machine.id}>
        Couldn't read {machine.name}: {error}{" "}
        <button type="button" className={`${G}earlier-link`} data-read={machine.id} aria-label={`Read saved sessions on ${machine.name} again`}
          onClick={() => read(machine.id, true)}>read again</button>
      </p>)}
      {rows.running.length + folders.length > 0 && <ul className={`${G}earlier-rows`}>
        {rows.running.map(row => sessionRow(row, null))}
        {folders.map(folderRow)}
      </ul>}
    </section>
    <section className={`${G}earlier-group`} aria-labelledby={`${id}-recent`}>
      <div className={`${G}earlier-head`}>
        <h2 id={`${id}-recent`} className={`${G}earlier-title`}>recent teams</h2>
        <span className={`${G}earlier-meta`}>this device{recents.length ? ` · 1–${recents.length} recall` : ""}</span>
      </div>
      {recents.length === 0 && <p className={`${G}earlier-empty`}>Nothing launched from this browser yet; each team you launch is kept here, recalled by its digit.</p>}
      {provenance && <p className={`${G}earlier-note`}>{provenance}</p>}
      {recents.length > 0 && <ol className={`${G}earlier-rows`}>{recents.map(recentRow)}</ol>}
    </section>
  </section>;
}
