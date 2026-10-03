import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { HostServices } from "@manifold/plugin";
import { ATTENDANCE_RESOURCE, FALLBACK_POLL_MS, usePolledResource } from "@manifold/plugin/hooks";
import { formatManifoldUri, type Attendance } from "@manifold/protocol";
import { OMP_PLUGIN_ID } from "@atyrode/manifold-omp";
import type { Lane } from "../../domain/contracts.ts";
import { codeOperationFailure, codeWorkflow, useCodeMachines, useCodeTerminals, useWorkflowQuery } from "../machine-web.ts";
import { WorkflowError } from "../workflow.ts";
import { ago, familyWord, hueOf, useMinuteTick } from "../ui.tsx";
import type { GateVerdict, WorkbenchIntent } from "./launch-step.ts";
import type { RecentTeam } from "./recent-teams.ts";
import type { WorkbenchActions, WorkbenchModel } from "./workbench-model.ts";
import {
  differences, machineReads, machineState, phrase, pinRecents, rowVerdict, sessionName, sessionRows, sessionsNote,
  teamProvenance, teamSentence, type RowIntent, type RowVerdict, type SessionRead, type SessionRow, type StatementWords,
} from "./earlier-model.ts";
import { sameTeam, teamWords } from "./statement-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (earlier.css). */
const G = "plugin-atyrode_code_generator__";
/** Saved sessions shown before "Show all": the newest, so a machine with hundreds of transcripts stays one glance. */
const SAVED_SHOWN = 5;

/**
 * The part of the workbench the earlier statements read and act through; a `WorkbenchModel`
 * satisfies it. `gate` may take the session a resume would name: the one gate cannot judge a row's
 * Resume without it, because it refuses an unchosen session before its later checks. A gate that
 * ignores the argument still guards every press, it just says those later refusals only when pressed.
 */
export type EarlierModel = Pick<WorkbenchModel, "selection" | "record" | "localDraft" | "machineId" | "savedSessionId" | "setSavedSessionId" | "inFlight"> & {
  gate: (intent: WorkbenchIntent, sessionId?: string) => GateVerdict;
  actions: Pick<WorkbenchActions, "resume" | "recallTeam" | "discardChanges">;
};
export type EarlierProps = {
  host: HostServices;
  model: EarlierModel;
  /** The statement's current words, which every row is compared with. */
  line: StatementWords;
  /** The recent teams in digit order (`usePinnedRecents`), shared with the statement's digit keys. */
  recents: readonly RecentTeam[];
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
    report(machineId, query.data ? { state: "read", sessions: query.data } : query.error ? { state: "failed", error: query.error } : { state: "reading" });
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
 */
function Verb({ className, name, subject, verdict, busy = false, onPress, announce, children, ...data }: {
  className: string; name: string; subject?: string; verdict: RowVerdict; busy?: boolean; onPress: () => void;
  announce: (text: string) => void; children: ReactNode; [attribute: `data-${string}`]: string | number | true | undefined;
}) {
  const reason = useId();
  return <>
    <button type="button" className={className} aria-label={name} aria-disabled={verdict.open ? undefined : "true"} aria-busy={busy || undefined}
      aria-describedby={verdict.open ? undefined : reason} title={verdict.open ? undefined : verdict.reason} {...data}
      onClick={() => { if (verdict.open) onPress(); else announce(`${subject ?? name} · ${verdict.reason}`); }}>{children}</button>
    {!verdict.open && <span id={reason} hidden>{verdict.reason}</span>}
  </>;
}

/** `2d ago`, or `just now`. */
function since(ms: number): string {
  const age = ago(ms);
  return age === "now" ? "just now" : `${age} ago`;
}

/**
 * EARLIER STATEMENTS: the sessions running or saved on the permitted machines, and the teams this
 * browser launched, each said only where it differs from the line. Every verb asks the workbench's
 * one gate (launch-step.ts `actionGate`) through the model, before it starts and again between its
 * steps; a refused one does nothing and says why.
 */
export function EarlierStatements({ host, model, line, recents, announce }: EarlierProps) {
  const id = useId();
  useMinuteTick();
  const now = Date.now();
  const { machines, error: rosterError } = useCodeMachines(host);
  const terminals = useCodeTerminals(host);
  // Saved sessions are read only on request, one machine at a time (today's explicit-read contract).
  const [attempts, setAttempts] = useState<ReadonlyMap<string, number>>(new Map());
  const [reads, setReads] = useState<ReadonlyMap<string, SessionRead>>(new Map());
  const [showAll, setShowAll] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [pending, setPending] = useState<{ sessionId: string; withTeam: boolean } | null>(null);
  const latest = useRef(model);
  latest.current = model;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // One row verb at a time, decided before any render: a double press must not start a second resume whose end would clear the first one's session.
  const acting = useRef(false);

  const report = useCallback((machineId: string, read: SessionRead) =>
    setReads(previous => new Map(previous).set(machineId, read)), []);
  const readers = (machines ?? []).filter(machine => attempts.has(machine.id) && rosterError === null && machine.online && !machine.revoked);
  // A read stands only while its machine is permitted and online; an offline machine's last answer is not offered.
  const standing = new Map([...reads].filter(([machineId]) => readers.some(machine => machine.id === machineId)));
  const reading = machineReads(machines, rosterError, standing);
  const rows = sessionRows(terminals.terminals ?? [], standing, OMP_PLUGIN_ID);
  const saved = showAll ? rows.saved : rows.saved.slice(0, SAVED_SHOWN);
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
  function read(machineId: string) {
    setAttempts(previous => new Map(previous).set(machineId, (previous.get(machineId) ?? 0) + 1));
    setReads(previous => new Map(previous).set(machineId, { state: "reading" }));
    terminals.refresh();
  }

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

  function recall(team: RecentTeam, digit: number) {
    // Back to the saved team is a discard, not a local edit that happens to match it.
    if (model.localDraft && model.record?.selection && sameTeam(team.selection, model.record.selection)) model.actions.discardChanges();
    else model.actions.recallTeam(team);
    announce(`Recalled team ${digit}.`);
  }

  function sessionRow(row: SessionRow) {
    const name = sessionName(row);
    const busy = active === (row.kind === "running" ? `open:${row.terminalId}` : `resume:${row.sessionId}`);
    return <li key={row.terminalId ?? `${row.machineId}:${row.sessionId}`} className={`${G}earlier-session`} data-kind={row.kind}
      data-session-id={row.sessionId} data-machine-id={row.machineId} data-terminal-id={row.terminalId ?? undefined}>
      <span className={`${G}earlier-verbs`}>
        <span className={`${G}earlier-dot`} data-running={row.kind === "running" || undefined} aria-hidden="true" />
        {row.kind === "running"
          ? <Verb className={`${G}earlier-verb`} name={`Open ${name}`} verdict={verdict("open", row)} busy={busy} data-verb="open"
            onPress={() => void open(row)} announce={announce}>{busy ? "Opening…" : "Open"}</Verb>
          : <Verb className={`${G}earlier-verb`} name={`Resume ${name}`} verdict={verdict("resume", row)} busy={busy} data-verb="resume"
            onPress={() => resume(row, false)} announce={announce}>{busy && model.inFlight === "resume" ? "Resuming…" : "Resume"}</Verb>}
      </span>
      <span className={`${G}earlier-head-line`}>
        <span className={`${G}earlier-name`} data-path={row.title ? undefined : ""} title={name}>{name}</span>
        {row.kind === "saved" && <Verb className={`${G}earlier-with`} name={`Resume with this team: ${name}`} verdict={verdict("resume-with-team", row)}
          data-verb="resume-with-team" onPress={() => resume(row, true)} announce={announce}>Resume with this team</Verb>}
      </span>
      <span className={`${G}earlier-where`}>
        <span className={`${G}earlier-machine`}>{machineState(row.machineId, machines, rosterError).name ?? "Unknown machine"}</span>
        <span className={`${G}earlier-sep`} aria-hidden="true">·</span>
        <span title={`${row.kind === "running" ? "Started" : "Saved"} ${new Date(row.at).toLocaleString()}`}>{since(now - row.at)}</span>
      </span>
    </li>;
  }

  const recallGate = model.gate("edit-team");
  function recentRow(team: RecentTeam, index: number) {
    const digit = index + 1;
    const changed = differences(team.selection, { words: line, selection: model.selection }, familyWord);
    const here = changed.length === 0;
    const allowed: RowVerdict = here ? { open: false, reason: "Already on the line." } : recallGate.open ? recallGate : { open: false, reason: recallGate.refusal.text };
    return <li key={digit}>
      <Verb className={`${G}earlier-team`} name={`Recall team ${digit}: ${teamSentence(teamWords(team.selection, familyWord))}`} subject={`Recall team ${digit}`}
        verdict={allowed} data-digit={digit} data-here={here || undefined} onPress={() => recall(team, digit)} announce={announce}>
        <span className={`${G}earlier-digit`} aria-hidden="true">{digit}</span>
        <span className={`${G}earlier-words`}>
          {here ? <span className={`${G}earlier-word`} data-same="">this team</span> : changed.map((difference, position) => <Fragment key={difference.word}>
            {position > 0 && <span className={`${G}earlier-sep`} aria-hidden="true">·</span>}
            <span className={`${G}earlier-word`}>{difference.word === "lane" && <LaneMark lane={team.selection.lane} />}{phrase(difference.word, difference.text)}</span>
          </Fragment>)}
          <span className={`${G}earlier-sep`} aria-hidden="true">·</span>
          <span className={`${G}earlier-age`}>{since(now - team.launchedAt)}</span>
        </span>
      </Verb>
    </li>;
  }

  return <section className={`${G}section ${G}earlier`} aria-label="Earlier statements">
    {readers.map(machine => <MachineRead key={machine.id} host={host} machineId={machine.id} attempt={attempts.get(machine.id)!} report={report} />)}
    <section className={`${G}earlier-group`} aria-labelledby={`${id}-sessions`}>
      <div className={`${G}earlier-head`}>
        <h2 id={`${id}-sessions`} className={`${G}earlier-title`}>Sessions</h2>
        <span className={`${G}earlier-meta`}>{sessionsNote(rows.running.length, rows.saved.length, readOnly)}</span>
        {rosterError !== null ? <span className={`${G}earlier-meta`}>{rosterError}</span> : <>
          {reading.unread.map(machine => <button key={machine.id} type="button" className={`${G}earlier-link`} data-read={machine.id}
            aria-label={`Read saved sessions on ${machine.name}`} onClick={() => read(machine.id)}>Read {machine.name}</button>)}
          {reading.reading.map(machine => <span key={machine.id} className={`${G}earlier-meta`} data-read-state="reading" data-machine-id={machine.id}>reading {machine.name}…</span>)}
          {reading.empty.map(machine => <span key={machine.id} className={`${G}earlier-meta`} data-read-state="empty" data-machine-id={machine.id}>nothing saved on {machine.name}</span>)}
          {reading.offline.map(machine => <span key={machine.id} className={`${G}earlier-meta`} data-read-state="offline" data-machine-id={machine.id}>{machine.name} offline</span>)}
        </>}
      </div>
      {terminals.error && <p className={`${G}earlier-note`}>{terminals.error}</p>}
      {reading.failed.map(({ machine, error }) => <p key={machine.id} className={`${G}earlier-note`} data-read-state="failed" data-machine-id={machine.id}>
        Couldn't read {machine.name}: {error}{" "}
        <button type="button" className={`${G}earlier-link`} data-read={machine.id} aria-label={`Read saved sessions on ${machine.name} again`}
          onClick={() => read(machine.id)}>Read again</button>
      </p>)}
      {rows.running.length + saved.length > 0 && <ul className={`${G}earlier-rows`}>
        {rows.running.map(sessionRow)}
        {saved.map(sessionRow)}
      </ul>}
      {rows.saved.length > SAVED_SHOWN && <button type="button" className={`${G}earlier-link ${G}earlier-more`} aria-expanded={showAll}
        onClick={() => setShowAll(value => !value)}>{showAll ? `Show the newest ${SAVED_SHOWN} saved` : `Show all ${rows.saved.length} saved`}</button>}
    </section>
    <section className={`${G}earlier-group`} aria-labelledby={`${id}-recent`}>
      <div className={`${G}earlier-head`}>
        <h2 id={`${id}-recent`} className={`${G}earlier-title`}>Recent teams</h2>
        <span className={`${G}earlier-meta`}>this device{recents.length ? ` · 1–${recents.length} recall` : ""}</span>
      </div>
      {recents.length === 0 && <p className={`${G}earlier-empty`}>Teams you launch here appear here</p>}
      {provenance && <p className={`${G}earlier-note`}>{provenance}</p>}
      {recents.length > 0 && <ol className={`${G}earlier-rows`}>{recents.map(recentRow)}</ol>}
    </section>
  </section>;
}
