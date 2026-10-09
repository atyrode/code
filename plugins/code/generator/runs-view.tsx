import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { HostServices } from "@manifold/plugin";
import type { ThinkingSelector } from "@atyrode/manifold-omp";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import { codeOperationFailure, codeWorkflow } from "../machine-web.ts";
import { hhmm, hueOf } from "../ui.tsx";
import { AGENT_RENEWALS, refusalToken, runDials, WorkflowError, type CodeRun } from "../workflow.ts";
import { Glyph, GLYPHS } from "./dial-row.tsx";
import { answerDial, forgetAnswer, keepAnswer, keptAnswersKey, NO_DIALS, pressDial, readDials, readKeptAnswers, refuseDial, settleDial, shownDials,
  type AnswerStorage, type DialChange, type DialField, type RunDialState } from "./run-dials.ts";
import { activityWord, leaseOf, leaseWords, modelLevels, modelName, modelWords, runOpen, runPhase, runSaid, runVerb, THINKING_LEVELS,
  type DialWord, type RunPointed } from "./runs-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
/** ←/→ rest on a word this long before it is sent, so a sweep of the keys sends one change. */
const SETTLE_MS = 500;
/** How long a confirmation keeps the said line before it gives way. */
const SAID_MS = 2600;
/** The lease's glyph: a clock face whose hand has turned, on the rows' 16px grid. */
const LEASE = "M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5ZM8 4.5V8l2.5 1.5";
const VOCAB = { time: hhmm };

function browserStorage(): AnswerStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** A panel's live dials: each Run's state, the press that sends one change, and the drop of a change queued as the Run's dials lock. */
export type RunDialsHandle = {
  readonly stateOf: (runId: string) => RunDialState;
  /** `levelsOf` names a model's thinking levels, so a queued level is judged against the model shown when it is sent. */
  readonly press: (entry: CodeRun, change: DialChange, levelsOf: (model: string | null) => readonly string[] | null) => Promise<void>;
  readonly unqueue: (runId: string) => void;
};
/**
 * Every Run's dials as this browser turns them (`runs`: the Runs as last read): one `controlRun` per press, its answer kept per
 * workspace until a read of the Run's live model contradicts it.
 */
export function useRunDials(host: HostServices, runs: readonly CodeRun[]): RunDialsHandle {
  const key = keptAnswersKey(host.principal.id, host.containerId!);
  const [states, setStates] = useState<ReadonlyMap<string, RunDialState>>(() =>
    new Map([...readKeptAnswers(browserStorage(), key)].map(([runId, dials]) => [runId, { ...NO_DIALS, reply: dials }])));
  const latest = useRef(states);
  const read = useRef(runs);
  read.current = runs;
  const timers = useRef(new Map<string, number>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; for (const timer of timers.current.values()) window.clearTimeout(timer); };
  }, []);
  const stateOf = (runId: string) => latest.current.get(runId) ?? NO_DIALS;
  function write(runId: string, next: RunDialState) {
    latest.current = new Map(latest.current).set(runId, next);
    if (mounted.current) setStates(latest.current);
  }
  // Each new read judges the answers kept before it (`readDials`): one for another model than the Run reports is dropped, here
  // and from storage. A remount or a failed read keeps the read in hand, which may predate an answer whose report is on its way.
  const judged = useRef(runs);
  useLayoutEffect(() => {
    if (judged.current === runs) return;
    judged.current = runs;
    for (const entry of runs) {
      const runId = entry.run.id, live = runDials(entry.run.model), state = stateOf(runId), next = readDials(state, live);
      if (next === state) continue;
      forgetAnswer(browserStorage(), key, runId, live.model!);
      write(runId, next);
    }
  }, [runs]);
  async function press(entry: CodeRun, change: DialChange, levelsOf: (model: string | null) => readonly string[] | null): Promise<void> {
    // Only a live Run's dials turn: a starting one has no session to answer yet, and a detached or settled one has no Run input left.
    if (runPhase(entry) !== "live") return;
    const runId = entry.run.id, before = shownDials(stateOf(runId), runDials(entry.run.model));
    const levels = levelsOf(before.model);
    const { state, send } = pressDial(stateOf(runId), change, before, level => levels !== null && !levels.includes(level));
    write(runId, state);
    if (!send) return;
    try {
      const dials = await codeWorkflow(host).controlRun(runId, change.field === "model" ? { model: change.value } : { thinking: change.value as ThinkingSelector });
      keepAnswer(browserStorage(), key, runId, dials);
      write(runId, answerDial(stateOf(runId), change, dials, before));
      window.clearTimeout(timers.current.get(runId));
      timers.current.set(runId, window.setTimeout(() => write(runId, settleDial(stateOf(runId))), SAID_MS));
    } catch (reason) {
      write(runId, refuseDial(stateOf(runId), change, reason instanceof WorkflowError ? refusalToken(reason.message) : null, codeOperationFailure(reason)));
    }
    // The latest press made while this one waited goes now, on the dials the answer left, to the Run as last read: one no
    // longer live (or no longer listed) sends nothing.
    const queued = stateOf(runId).queued;
    if (!queued) return;
    write(runId, { ...stateOf(runId), queued: null });
    const current = read.current.find(candidate => candidate.run.id === runId);
    if (current) await press(current, queued, levelsOf);
  }
  function unqueue(runId: string) {
    if (stateOf(runId).queued) write(runId, { ...stateOf(runId), queued: null });
  }
  return { stateOf: (runId: string) => states.get(runId) ?? NO_DIALS, press, unqueue };
}

/** Where a dial's glider goes: under its target word, the fill from the first word of that word's family. */
function placeGlider(box: HTMLElement) {
  const words = [...box.querySelectorAll<HTMLElement>(`.${G}word`)];
  const dot = box.querySelector<HTMLElement>(`.${G}dot`), fill = box.querySelector<HTMLElement>(`.${G}fill`);
  if (!dot || !fill) return;
  const at = words.find(word => word.dataset.pending !== undefined || word.dataset.unconfirmed !== undefined) ?? words.find(word => word.dataset.selected !== undefined);
  if (!at) { dot.style.opacity = "0"; fill.style.opacity = "0"; return; }
  const point = (word: HTMLElement) => {
    const text = word.firstElementChild as HTMLElement;
    return { x: word.offsetLeft + word.offsetWidth / 2, line: word.offsetTop, y: word.offsetTop + text.offsetTop + text.offsetHeight + 4 };
  };
  const target = point(at);
  const index = words.indexOf(at);
  const startWord = words.slice(0, index + 1).reverse().find(word => word.dataset.familyStart !== undefined) ?? words[0]!;
  const start = point(startWord);
  dot.style.opacity = "";
  dot.toggleAttribute("data-pending", at.dataset.pending !== undefined);
  dot.toggleAttribute("data-unconfirmed", at.dataset.unconfirmed !== undefined);
  dot.style.transform = `translate(${target.x}px, ${target.y}px)`;
  const reach = start.line === target.line ? Math.max(0, target.x - start.x) : 0;
  // The glider wears the target word's hue, as a generator row's wears its chosen word's.
  const hue = at.style.getPropertyValue("--wc");
  if (hue) box.style.setProperty("--dc", hue); else box.style.removeProperty("--dc");
  fill.style.opacity = reach > 0 ? "" : "0";
  fill.style.transform = `translate(${start.x}px, ${target.y - 1}px) scaleX(${reach})`;
}

type RunDialProps = {
  readonly runId: string; readonly field: DialField; readonly label: string; readonly glyph: string;
  readonly words: readonly (DialWord & { readonly off: boolean })[]; readonly shown: string | null; readonly state: RunDialState; readonly locked: boolean;
  /** A press, ↵ or Space: sent at once. */
  readonly onSend: (value: string) => void;
  /** ←/→ resting on a word: sent once the keys rest (the Run's one settle timer). */
  readonly onArm: (value: string) => void;
  readonly onPoint: (pointed: RunPointed | null) => void; readonly onMove: (from: HTMLElement, delta: -1 | 1) => void;
};
/**
 * One live dial of a Run, in the generator's row grammar: glyph, label and every option word, the
 * shown one bold in its colour, the asked-for one paler with a hollow dot until the session answers.
 * A click or ↵/Space sends at once; ←/→ move between the words that can be chosen and send the one
 * they rest on half a second after they stop; ↑/↓ go to the next dial of any Run.
 */
function RunDial({ runId, field, label, glyph, words, shown, state, locked, onSend, onArm, onPoint, onMove }: RunDialProps) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (box.current) placeGlider(box.current); });
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver(() => placeGlider(node));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const target = state.pending?.field === field ? state.pending.value : state.unconfirmed?.field === field ? state.unconfirmed.value : null;
  const flash = state.outcome?.kind === "confirmed" && state.outcome.change.field === field ? state.outcome.change.value : null;
  const stop = target ?? shown ?? words[0]?.value;
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const word = (event.target as HTMLElement).closest<HTMLElement>(`.${G}word`);
    if (!word) return;
    const usable = [...box.current!.querySelectorAll<HTMLElement>(`.${G}word:not([data-off])`)];
    let next: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowLeft": case "ArrowRight": {
        const at = usable.indexOf(word);
        next = usable[Math.max(0, Math.min(usable.length - 1, (at < 0 ? 0 : at) + (event.key === "ArrowRight" ? 1 : -1)))];
        break;
      }
      case "Home": next = usable[0]; break;
      case "End": next = usable.at(-1); break;
      case "Enter": case " ":
        if (!event.repeat) onSend(word.dataset.value!);
        break;
      case "ArrowUp": case "ArrowDown": onMove(box.current!, event.key === "ArrowDown" ? 1 : -1); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!next) return;
    for (const candidate of box.current!.querySelectorAll<HTMLElement>(`.${G}word`)) candidate.tabIndex = candidate === next ? 0 : -1;
    next.focus({ preventScroll: true });
    onPoint({ kind: "word", field, value: next.dataset.value! });
    onArm(next.dataset.value!);
  }
  return <div className={`${G}dial`} data-row={field === "model" ? "tier" : "thinking"} data-run-dial={runId} data-locked={locked || undefined}
    role="radiogroup" aria-label={label} onKeyDown={keys}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onPoint(null); }}>
    <span className={`${G}dial-ptr`} aria-hidden="true">▸</span>
    <span className={`${G}dial-glyph`}><Glyph path={glyph} /></span>
    <span className={`${G}dial-label`}>{label}</span>
    <div ref={box} className={`${G}words`} onPointerLeave={() => onPoint(null)}>
      <span className={`${G}track`} aria-hidden="true"><i className={`${G}fill`} /><i className={`${G}dot`} /></span>
      {words.map((word, index) => {
        const checked = word.value === shown && target === null;
        return <span key={word.value} className={`${G}word`} role="radio" aria-checked={checked} aria-disabled={word.off || locked || undefined}
          tabIndex={word.value === stop ? 0 : -1} data-value={word.value} data-selected={checked || undefined} data-off={word.off || undefined}
          data-pending={state.pending?.field === field && state.pending.value === word.value || undefined}
          data-unconfirmed={state.unconfirmed?.field === field && state.unconfirmed.value === word.value || undefined}
          data-confirmed={flash === word.value || undefined} data-family-start={(word.familyStart && index > 0) || undefined}
          style={word.family ? { "--wc": `var(--code-${hueOf(word.family)})` } as CSSProperties : undefined}
          onPointerEnter={() => onPoint({ kind: "word", field, value: word.value })} onClick={() => onSend(word.value)}>
          <span className={`${G}word-text`} data-text={word.text}>{word.text}</span>
        </span>;
      })}
    </div>
  </div>;
}

export type RunsBlockProps = {
  readonly runs: readonly CodeRun[];
  readonly dials: RunDialsHandle;
  readonly catalog: CompiledCatalog | null;
  readonly aliases: ReadonlyMap<string, string> | null;
  /** A Run's title and folder, from its machine's saved-session read and its terminal. */
  readonly place: (entry: CodeRun) => { readonly title: string | null; readonly folder: string | null };
  /** The Run's one verb as a control (earlier.tsx's `Verb`), which asks the gate itself. */
  readonly verb: (entry: CodeRun, verb: "open" | "cancel" | "resume", name: string) => ReactNode;
  readonly now: number;
};
/**
 * SESSIONS' RUNNING GROUP: one machine's Code Runs, each a line (activity mark and word, title,
 * folder, its live `model:thinking`, its one verb) and, while open, its two live dials, its lease as
 * 24 blocks and one said line of fixed height, so a reply or a pointed word moves nothing.
 */
export function RunsBlock({ runs, dials, catalog, aliases, place, verb, now }: RunsBlockProps) {
  const block = useRef<HTMLDivElement>(null);
  // The label column is as wide as the widest dial label or activity word as rendered, as the generator measures its own.
  useLayoutEffect(() => {
    const node = block.current;
    if (!node) return;
    const measure = () => {
      const widest = Math.max(0, ...[...node.querySelectorAll<HTMLElement>(`.${G}dial-label, .${G}run-act`)].map(label => label.getBoundingClientRect().width));
      const narrow = node.closest<HTMLElement>("[data-mode]")?.dataset.mode === "narrow";
      if (widest > 0) node.style.setProperty("--labw", `${Math.ceil(widest) + (narrow ? 10 : 18)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [runs.length]);
  function move(from: HTMLElement, delta: -1 | 1) {
    const rows = [...block.current?.closest(`[data-pane="sessions"]`)?.querySelectorAll<HTMLElement>(`[data-run-dial] .${G}words`) ?? []];
    const next = rows[rows.indexOf(from) + delta];
    next?.querySelector<HTMLElement>(`.${G}word[tabindex="0"]`)?.focus({ preventScroll: true });
  }
  const words = catalog && aliases ? modelWords(catalog, aliases) : [];
  return <div ref={block} className={`${G}runs`} data-place="sessions" role="group" aria-label="running">
    {runs.map(entry => <RunItem key={entry.run.id} entry={entry} state={dials.stateOf(entry.run.id)} models={words} catalog={catalog} aliases={aliases}
      place={place(entry)} now={now} verb={verb} onMove={move} onSend={change => void dials.press(entry, change, model => modelLevels(model, catalog))}
      onLock={() => dials.unqueue(entry.run.id)} />)}
  </div>;
}

function RunItem({ entry, state, models, catalog, aliases, place, now, verb, onMove, onSend, onLock }: {
  entry: CodeRun; state: RunDialState; models: readonly DialWord[]; catalog: CompiledCatalog | null; aliases: ReadonlyMap<string, string> | null;
  place: { title: string | null; folder: string | null }; now: number; verb: RunsBlockProps["verb"];
  onMove: (from: HTMLElement, delta: -1 | 1) => void; onSend: (change: DialChange) => void; onLock: () => void;
}) {
  const [pointed, setPointed] = useState<RunPointed | null>(null);
  const phase = runPhase(entry), open = runOpen(phase), act = activityWord(entry), oneVerb = runVerb(entry);
  const shown = shownDials(state, runDials(entry.run.model));
  const name = (reference: string | null) => modelName(reference, catalog, aliases);
  const levels = modelLevels(shown.model, catalog);
  const lock = phase !== "live" || state.forbidden;
  const said = runSaid(entry, state, pointed, now, { vocab: VOCAB, name, levels });
  const lease = leaseOf(entry), words = leaseWords(entry, now, VOCAB);
  const token = name(shown.model);
  const title = place.title ?? "new session";
  // One settle timer per Run: ←/→ arm it, and any explicit press, a send again or the dials locking cancels it, so a later
  // choice is never overtaken by an earlier resting one. Locking also drops a change queued behind the one in flight.
  const settle = useRef(0);
  useEffect(() => () => window.clearTimeout(settle.current), []);
  useEffect(() => {
    if (!lock) return;
    window.clearTimeout(settle.current);
    onLock();
  }, [lock]);
  const sendNow = (change: DialChange) => { window.clearTimeout(settle.current); onSend(change); };
  const send = (field: DialField) => (value: string) => sendNow({ field, value });
  const arm = (field: DialField) => (value: string) => {
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => onSend({ field, value }), SETTLE_MS);
  };
  const point = (next: RunPointed | null) => setPointed(next);
  return <div className={`${G}run`} data-a={act} data-run-id={entry.run.id} data-open={open || undefined} data-locked={(open && lock) || undefined}>
    <div className={`${G}run-line`}>
      <span className={`${G}run-toggle`} onPointerEnter={() => point({ kind: "activity" })} onPointerLeave={() => point(null)}>
        <span className={`${G}run-mark`} data-a={act} aria-hidden="true" />
        <span className={`${G}run-act`}>{act}</span>
      </span>
      <span className={`${G}run-what`}>
        <span className={`${G}run-name`} data-untitled={place.title === null || undefined} title={title}>{title}</span>
        {place.folder && <span className={`${G}run-folder`} title={place.folder}>{place.folder.replace(/^\/home\/[^/]+(?=\/|$)/, "~")}</span>}
        <span className={`${G}run-tok`} data-quiet={!open || undefined} style={token.family ? { "--h": `var(--code-${hueOf(token.family)})` } as CSSProperties : undefined}>
          <span className={`${G}tok-alias`}>{token.text}</span><span className={`${G}tok-thinking`}>:{shown.thinking ?? "?"}</span>
        </span>
        {!open && words.text && <span className={`${G}run-lease`} data-tone={words.tone ?? undefined}>{words.text}</span>}
        {oneVerb && verb(entry, oneVerb, title)}
      </span>
    </div>
    {open && <div className={`${G}run-dials`} role="group" aria-label={`dials of ${title}`}>
      <RunDial runId={entry.run.id} field="model" label="model" glyph={GLYPHS.tier} shown={shown.model} state={state} locked={lock}
        words={models.map(word => ({ ...word, off: state.unserved.includes(word.value) }))} onSend={send("model")} onArm={arm("model")} onPoint={point} onMove={onMove} />
      <RunDial runId={entry.run.id} field="thinking" label="thinking" glyph={GLYPHS.thinking} shown={shown.thinking} state={state} locked={lock}
        words={THINKING_LEVELS.map((level, index) => ({ value: level, text: level, family: null, familyStart: index === 0, off: levels !== null && !levels.includes(level) }))}
        onSend={send("thinking")} onArm={arm("thinking")} onPoint={point} onMove={onMove} />
      <div className={`${G}dial ${G}lease-row`} data-row="lease">
        <span className={`${G}dial-ptr`} aria-hidden="true" />
        <span className={`${G}dial-glyph`}><Glyph path={LEASE} /></span>
        <span className={`${G}dial-label`}>lease</span>
        <div className={`${G}words`} onPointerEnter={() => point({ kind: "lease" })} onPointerLeave={() => point(null)}>
          <span className={`${G}lease-bar`} data-tone={words.tone ?? undefined} role="img"
            aria-label={lease.renewals === null ? "renewals unread" : `${lease.renewals} of ${AGENT_RENEWALS} renewals`}>
            {Array.from({ length: AGENT_RENEWALS }, (_, index) => <i key={index} data-on={lease.renewals !== null && index < lease.renewals || undefined} />)}
          </span>
          <span className={`${G}lease-words`} data-tone={words.tone ?? undefined}>{words.text}</span>
        </div>
      </div>
    </div>}
    {open && <div className={`${G}run-said`} data-said={entry.run.id} data-tone={said?.warn ? "warn" : undefined} title={said?.title ?? undefined} aria-live="polite"
      style={said?.family ? { "--rc": `var(--code-${hueOf(said.family)})` } as CSSProperties : undefined}>
      {said && <span className={`${G}run-said-text`}><b>{said.value}</b>{said.text && ` · ${said.text}`}</span>}
      {said?.again && state.unconfirmed && <button type="button" className={`${G}run-again`} onClick={() => sendNow(state.unconfirmed!)}>send again</button>}
    </div>}
  </div>;
}
