import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type RefObject } from "react";
import type { MachineSummary } from "@manifold/protocol";
import type { Selection } from "../../domain/contracts.ts";
import type { QuotaPool } from "../../domain/quota.ts";
import type { Review } from "../../domain/routing.ts";
import { accountWord, clock, familyWord, hhmm, LAUNCH_STROKE, withKey } from "../ui.tsx";
import { rescue } from "./consequences.ts";
import type { RecentTeam } from "./recent-teams.ts";
import { StatementSlot, type SlotMotion } from "./slot.tsx";
import { statementKey, type StatementKeyAction } from "./statement-keys.ts";
import { chooseForm, drumShift, FORM_CHOICES, FORM_ROWS, ghostedWords, measureForm, VERB_INLINE, type FormMeasure, type SlotText, type TextMeasure } from "./statement-layout.ts";
import {
  changeSentence, commitKind, CONNECTORS, edgeOption, fixView, grounded, lastLaunchTeam, laneFix, poolCounts, projectionOf, reviewMatches,
  roleList, sameTeam, standstill, STATEMENT_WORDS, statementSlots, statusLines, stepOption, teamChange, teamFacts, VERB_LABELS, verbView, WORD_NAMES,
  type Pointed, type Projection, type Slot, type SlotOption, type StatementContext, type StatementWord, type StatusAction, type StatusFix, type StatusLine, type Vocabulary,
} from "./statement-model.ts";
import { useWheelTurn } from "./wheel-turn.ts";
import type { WorkbenchModel } from "./workbench-model.ts";

/** Statement class prefix; every part hangs from the generator root (styles.css). */
const S = "plugin-atyrode_code_generator__stmt-";
const PANEL_ROOT = ".plugin-atyrode_code_generator";
const HOUR = 3_600_000;

/**
 * The team the board and the status line show instead of the line's while something is pointed:
 * a word's option, the fix, a recent team or a session. `key` is stable per pointed thing and
 * distinct per team; `label` names it for the status line when the line did not set it.
 */
export type TeamPreview = { readonly key: string; readonly selection: Selection; readonly review: Review; readonly label?: string };
/** Where a status fix sends the person: a sheet or popover the panel owns, an accounts list by family. */
export type StatementPlace = "models" | "setup" | "options" | "accounts";

export type StatementProps = {
  readonly model: WorkbenchModel;
  readonly preview: TeamPreview | null;
  readonly setPreview: (preview: TeamPreview | null) => void;
  /** `quotaPools` over the present usage reading. */
  readonly pools: readonly QuotaPool[];
  /** The machine roster; null while it is read. */
  readonly machines: readonly MachineSummary[] | null;
  /** Choose the destination (`useCodeTarget().select`); the line asks the machine gate first. */
  readonly selectMachine: (id: string) => void;
  /** Recent teams in digit order, pinned for the session: index i is digit i + 1. */
  readonly recents: readonly RecentTeam[];
  readonly announce: (text: string) => void;
  readonly onOpen: (place: StatementPlace, family?: string) => void;
  /** `?`: show the keys dialog. */
  readonly onKeys: () => void;
  /** `r`: read the accounts, usage, machines and the workspace team again. */
  readonly onRefresh: () => void;
  /** A quiet control beside the status lines (the session options). */
  readonly aside?: ReactNode;
};

/** One polite live region, mounted empty; an identical message is announced again because its node is replaced. */
export function useAnnouncer(): { region: ReactElement; announce: (text: string) => void } {
  const [message, setMessage] = useState({ text: "", serial: 0 });
  const announce = useCallback((text: string) => setMessage(previous => ({ text, serial: previous.serial + 1 })), []);
  const region = <div className="plugin-atyrode_code__sr" role="status" aria-live="polite" aria-atomic="true">
    <span key={message.serial}>{message.text}</span>
  </div>;
  return { region, announce };
}

type Layout = { readonly choice: number; readonly measure: FormMeasure | null };

/**
 * The width form the field's own width allows (statement-layout.ts `chooseForm`), measured in the
 * field's font before paint, so the first frame is already in its form; again on every resize,
 * keeping the previous form within the hysteresis margin.
 */
function useStatementLayout(field: RefObject<HTMLElement | null>, texts: Readonly<Record<StatementWord, SlotText>> | null): Layout {
  const [layout, setLayout] = useState<Layout>({ choice: 0, measure: null });
  const previous = useRef<number | null>(null);
  const key = JSON.stringify(texts);
  useLayoutEffect(() => {
    const element = field.current;
    const context = element?.ownerDocument.createElement("canvas").getContext("2d");
    if (!element || !context || !texts) return;
    const family = getComputedStyle(element).fontFamily;
    const measure: TextMeasure = (text, size, weight) => {
      context.font = `${weight} ${size}px ${family}`;
      return context.measureText(text).width;
    };
    const measures = FORM_CHOICES.map(choice => measureForm(choice, texts, VERB_LABELS, measure));
    const update = () => {
      const choice = chooseForm(element.clientWidth, measures.map(entry => entry.need), previous.current);
      previous.current = choice;
      setLayout(current => current.choice === choice && current.measure === measures[choice] ? current : { choice, measure: measures[choice]! });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [key]);
  return layout;
}

/**
 * The statement line: the verb, the six words of the team, and two status lines. Every action goes
 * through the workbench model's gate; the line only names the step, shows what each option would do
 * and quota's verdict on it, and writes the consequence of whatever is pointed in the status lines.
 */
export function StatementLine({ model, preview, setPreview, pools, machines, selectMachine, recents, announce, onOpen, onKeys, onRefresh, aside }: StatementProps) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const verbButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<StatementWord | null>(null);
  const [cursor, setCursor] = useState(0);
  const [pointedAt, setPointedAt] = useState<{ readonly word: StatementWord; readonly value: string } | "fix" | null>(null);
  const [motion, setMotion] = useState<{ readonly word: StatementWord; readonly motion: SlotMotion } | null>(null);
  const [launching, setLaunching] = useState(false);
  const [stopped, setStopped] = useState<object | null>(null);
  const chain = useRef<Projection | null>(null);

  const { compiled: catalog, selection, controlsReview, served, verification } = model;
  const starter = model.profile?.metadata != null;
  const lastLaunch = model.recentTeams[0]?.selection ?? null;
  const shown = model.review ?? controlsReview;
  // Nothing to show yet because the first reads are still out, rather than because one failed.
  const reading = !model.profile && !model.document && model.queries.configuration.error === null && model.queries.metadata.error === null;
  const teamGate = model.gate("edit-team"), machineGate = model.gate("edit-machine");
  const vocab = useMemo<Vocabulary>(() => ({ family: familyWord, account: accountWord, time: at => at - Date.now() > 20 * HOUR ? clock(at) : hhmm(at) }), []);
  const context = useMemo<StatementContext | null>(() => catalog && selection && controlsReview ? {
    catalog, selection, review: controlsReview, served, starter, nowMs: Date.now(), pools, lastLaunch, machines, machineId: model.machineId,
  } : null, [catalog, selection, controlsReview, served, starter, pools, lastLaunch, machines, model.machineId]);
  const slots = useMemo(() => context && statementSlots(context, vocab), [context, vocab]);
  const quota = useMemo(() => {
    if (!catalog || !shown) return null;
    const stop = standstill(catalog, shown.routes, pools);
    const found = stop ? rescue(catalog, shown, pools, { served, starter, nowMs: Date.now() }) : null;
    return { stop, fix: found && fixView(found, catalog, pools, vocab), team: teamFacts(catalog, shown.routes, pools), grounded: grounded(catalog, shown.routes, pools, served) };
  }, [catalog, shown, pools, served, starter, vocab]);
  const texts = useMemo(() => {
    if (!slots) return null;
    const text = (word: StatementWord): SlotText => ({
      connector: CONNECTORS[word] ?? null, marked: word === "lane",
      labels: word === "extras" ? ["no extras", "6 extras", ...slots.extras.options.map(option => option.label)] : slots[word].options.map(option => option.label),
    });
    return { lane: text("lane"), tier: text("tier"), thinking: text("thinking"), advisor: text("advisor"), extras: text("extras"), machine: text("machine") };
  }, [slots]);
  const layout = useStatementLayout(field, texts);

  const verb = verbView({
    step: model.step, verdict: model.verb, busy: model.busy, inFlight: model.inFlight, chaining: model.chaining, unsaved: model.unsaved,
    draft: model.localDraft !== null, phase: verification.phase, verification: verification.status, stranded: quota?.stop != null,
    grounded: quota?.grounded ?? false, launching,
  });

  // ------------------------------------------------------------ pointing: the status lines and the board show what a choice would do
  const mine = (key: string | undefined) => key !== undefined && (key.startsWith("option:") || key.startsWith("fix:"));
  function point(word: StatementWord, option: SlotOption | null) {
    setPointedAt(option ? { word, value: option.value } : null);
    if (option?.review && option.selection) setPreview({ key: `option:${word}:${option.value}`, selection: option.selection, review: option.review });
    else if (mine(preview?.key)) setPreview(null);
  }
  function pointFix(action: Extract<StatusAction, { kind: "fix" }> | null) {
    const team = action?.fix.kind === "team" ? action.fix : null;
    setPointedAt(action?.key === "rescue" ? "fix" : null);
    if (team?.review) setPreview({ key: `fix:${action!.key}`, selection: team.selection, review: team.review, label: action!.label });
    else if (mine(preview?.key)) setPreview(null);
  }
  function clearPointed() {
    setPointedAt(null);
    if (mine(preview?.key)) setPreview(null);
  }
  const pointed = useMemo<Pointed | null>(() => {
    if (pointedAt === "fix" && quota?.fix && catalog && shown) return { kind: "fix", fix: quota.fix, sentence: changeSentence(catalog, shown, quota.fix.review, familyWord) };
    if (pointedAt && pointedAt !== "fix" && slots) {
      const option = slots[pointedAt.word].options.find(candidate => candidate.value === pointedAt.value);
      if (option) return { kind: "option", word: pointedAt.word, option };
    }
    if (preview && !mine(preview.key) && catalog && shown) {
      const change = teamChange(catalog, shown, preview.review, pools, familyWord);
      return { kind: "team", label: preview.label ?? "This team", sentence: change.sentence, quota: change.quota };
    }
    return null;
  }, [pointedAt, quota, catalog, shown, slots, preview, pools]);

  // ------------------------------------------------------------ the status lines
  const machine = machines?.find(entry => entry.id === model.machineId) ?? null;
  const other = machines?.find(entry => entry.id !== model.machineId && entry.online && entry.revoked !== true) ?? null;
  const charge = verification.phase === "charge" ? verification.charge : null;
  const progress = verification.progress?.providers.reduce((sum, entry) => ({ done: sum.done + entry.done, total: sum.total + entry.total }), { done: 0, total: 0 }) ?? null;
  const reviewed = model.launchReview && catalog ? {
    machine: machine?.name ?? model.launchReview.destination.machineId,
    pool: poolCounts(catalog, model.launchReview.composition.review.routes, model.launchReview.composition.accountPool),
  } : null;
  // A verification that stopped says so until the next one starts; the verb, Verify models again, is its retry.
  const stoppedVerifying = verification.failure && verification.phase === null ? {
    text: verification.failure.cancelled ? "Verification cancelled" : `Verification stopped at ${verification.failure.step}: ${verification.failure.reason}`,
    failed: !verification.failure.cancelled,
  } : null;
  const lines = statusLines({
    verb, phase: verification.phase, progress, charge, inFlight: model.inFlight, busy: model.busy, chaining: model.chaining, launching,
    machine: machine && { name: machine.name, online: machine.online, revoked: machine.revoked === true }, otherMachine: other && { id: other.id, name: other.name },
    message: model.message ?? stoppedVerifying, outcome: model.outcome, launchStatus: model.launchStatus, stop: quota?.stop ?? null, fix: quota?.fix ?? null,
    team: quota?.team ?? { counts: [], fallsBack: null, tight: [], unread: false }, reviewed, differs: stopped !== null && stopped === model.launchReview,
    laneFix: verb.refusal?.code === "no-account" && slots && selection ? laneFix(slots.lane, selection) : null,
    nobodyServes: served !== null && served.size === 0, pointed,
  }, vocab);

  // ------------------------------------------------------------ the verb, and Save & launch as one gesture
  function press() {
    if (verb.state !== "ready") {
      if (verb.refusal) announce(`${verb.label}: ${verb.refusal.text}`);
      return;
    }
    setStopped(null);
    if (verb.launches && shown) { chain.current = projectionOf(shown, served); setLaunching(true); }
    model.actions.next();
  }
  // A Save & launch press goes on from its review to the launch only when the review shows what was
  // projected; `next` asks the gate again before launching. A chain that ends anywhere else stops.
  useLayoutEffect(() => {
    const projected = chain.current;
    if (!projected || model.busy || model.chaining) return;
    chain.current = null;
    setLaunching(false);
    const review = model.launchReview;
    if (model.step.step !== "launch" || !review) return;
    if (reviewMatches(projected, review.composition)) { model.actions.next(); return; }
    setStopped(review);
    announce("Stopped: the review differs from what was shown");
  });

  // ------------------------------------------------------------ commits, all through the edit gates
  function commitTeam(next: Selection, word: StatementWord | null, via: "pointer" | "keyboard", from: -1 | 1, say: string) {
    if (!selection) return;
    if (!teamGate.open) { announce(teamGate.refusal.text); return; }
    const kind = commitKind(next, selection, model.record?.selection ?? null, model.localDraft?.source ?? null);
    if (kind === "none") return;
    if (kind === "discard") model.actions.discardChanges();
    else model.actions.updateSelection(next);
    if (word) setMotion(current => ({ word, motion: { kind: via === "pointer" ? "roll" : "blink", from, serial: (current?.motion.serial ?? 0) + 1 } }));
    clearPointed();
    announce(say);
  }
  function commitOption(word: StatementWord, option: SlotOption, via: "pointer" | "keyboard", from: -1 | 1) {
    if (word === "machine") {
      if (!machineGate.open) { announce(machineGate.refusal.text); return; }
      selectMachine(option.value);
      setMotion(current => ({ word, motion: { kind: via === "pointer" ? "roll" : "blink", from, serial: (current?.motion.serial ?? 0) + 1 } }));
      announce(`on ${option.label}`);
      return;
    }
    if (!option.selection) return;
    const stop = option.quota?.kind === "strands" ? `; ${roleList(option.quota.stop.roles)} would have no route` : "";
    commitTeam(option.selection, word, via, from, `${word === "extras" ? `${option.label} ${option.on ? "off" : "on"}` : `${WORD_NAMES[word]} ${option.label}`}${stop}`);
  }
  function stepWord(slot: Slot, more: boolean, via: "pointer" | "keyboard") {
    const option = stepOption(slot, more);
    if (option) commitOption(slot.word, option, via, more ? -1 : 1);
  }
  function recall(index: number) {
    const team = recents[index];
    if (!team || !selection) return;
    if (sameTeam(team.selection, selection)) { announce(`Recent team ${index + 1} is this team`); return; }
    if (!teamGate.open) { announce(teamGate.refusal.text); return; }
    if (commitKind(team.selection, selection, model.record?.selection ?? null, model.localDraft?.source ?? null) === "discard") model.actions.discardChanges();
    else model.actions.recallTeam(team);
    clearPointed();
    announce(`Recent team ${index + 1}`);
  }
  function runFix(action: Extract<StatusAction, { kind: "fix" }>) {
    const fix: StatusFix = action.fix;
    switch (fix.kind) {
      case "team": commitTeam(fix.selection, null, "pointer", 1, action.label); return;
      case "machine":
        if (machineGate.open) { selectMachine(fix.machineId); announce(action.label); } else announce(machineGate.refusal.text);
        return;
      case "open": onOpen(fix.place, fix.family); return;
      case "refresh": model.actions.refresh(); return;
      case "discard": model.actions.discardChanges(); return;
    }
  }
  const slotElement = (word: StatementWord) => root.current?.querySelector<HTMLElement>(`[data-stmt-word="${word}"]`) ?? null;
  function toggleOpen(word: StatementWord) {
    const gate = word === "machine" ? machineGate : teamGate;
    if (open === word) { setOpen(null); return; }
    if (!gate.open) { announce(gate.refusal.text); return; }
    setCursor(0);
    setOpen(word);
  }

  // ------------------------------------------------------------ keys: panel-local, decided by statementKey
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = event => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const inside = target !== null && root.current?.contains(target) === true;
    const named = inside ? target.closest<HTMLElement>("[data-stmt-word]")?.dataset.stmtWord : undefined;
    const word = STATEMENT_WORDS.find(candidate => candidate === named) ?? null;
    const action = statementKey({
      key: event.key, mod: event.ctrlKey || event.metaKey, alt: event.altKey, repeat: event.repeat, defaultPrevented: event.defaultPrevented,
      inField: target?.matches("textarea, input, select, [contenteditable]") ?? false, inDialog: target?.closest("[role=dialog], [data-popover]") != null,
      word, onVerb: inside && target.closest("[data-stmt-verb]") !== null, open, recents: recents.length,
    });
    if (action && run(action)) { event.preventDefault(); event.stopPropagation(); }
  };
  function run(action: StatementKeyAction): boolean {
    switch (action.kind) {
      case "verb": press(); return true;
      case "keys": onKeys(); return true;
      case "refresh": onRefresh(); return true;
      case "recall": recall(action.index); return true;
      case "focus": (action.to === "verb" ? verbButton.current : slotElement(action.to))?.focus(); return true;
      case "open": toggleOpen(action.word); return true;
      case "close": setOpen(null); slotElement(action.word)?.focus(); return true;
      case "escape":
        if (!pointedAt) return false;
        clearPointed();
        return true;
    }
    if (!slots) return true;
    switch (action.kind) {
      case "step": stepWord(slots[action.word], action.more, "keyboard"); return true;
      case "edge": {
        const option = edgeOption(slots[action.word], action.top);
        if (option) commitOption(action.word, option, "keyboard", action.top ? -1 : 1);
        return true;
      }
      case "cursor": setCursor(current => Math.max(0, Math.min(slots.extras.options.length - 1, current + (action.more ? -1 : 1)))); return true;
      case "toggle": {
        const option = slots.extras.options[cursor];
        if (option?.available) commitOption("extras", option, "keyboard", 1);
        return true;
      }
      case "reset": {
        if (!context) return true;
        if (action.word === "machine") { announce("The last launch's machine is not recorded"); return true; }
        if (!lastLaunch) { announce("Nothing has been launched from this browser yet"); return true; }
        const team = lastLaunchTeam(action.word, slots[action.word], context);
        if (team) commitTeam(team, action.word, "keyboard", 1, `${WORD_NAMES[action.word]} back to the last launch`);
        return true;
      }
    }
  }
  useEffect(() => {
    const scope = root.current;
    const panel = scope?.closest<HTMLElement>(PANEL_ROOT) ?? scope;
    if (!panel) return;
    const listener = (event: KeyboardEvent) => keys.current(event);
    panel.addEventListener("keydown", listener);
    // The panel root takes focus when the panel opens, so its keys work at once; never from another control.
    const active = panel.ownerDocument.activeElement;
    if (panel.hasAttribute("tabindex") && (!active || active === panel.ownerDocument.body)) panel.focus({ preventScroll: true });
    return () => panel.removeEventListener("keydown", listener);
  }, []);

  // The wheel turns a word only on its open drum, or under keyboard focus after the pointer rests (wheel-turn.ts).
  useWheelTurn(field, { controls: "[data-stmt-word]", open: "[data-stmt-word][data-open]" }, !teamGate.open, (control, step) => {
    const word = STATEMENT_WORDS.find(candidate => candidate === control.dataset.stmtWord);
    if (!word || !slots) return;
    if (word === "extras") setCursor(current => Math.max(0, Math.min(slots.extras.options.length - 1, current - step)));
    else stepWord(slots[word], step > 0, "keyboard");
  });

  // ------------------------------------------------------------ the open drum: below the line, inside the panel, never over the verb
  const choice = FORM_CHOICES[layout.choice]!;
  const inline = VERB_INLINE[choice.form];
  useLayoutEffect(() => {
    const drum = open ? slotElement(open)?.querySelector<HTMLElement>(`.${S}drum`) : null;
    const box = root.current;
    if (!drum || !box) return;
    const style = getComputedStyle(box);
    const frame = box.getBoundingClientRect();
    const left = inline && verbButton.current ? verbButton.current.getBoundingClientRect().right + 8 : frame.left + parseFloat(style.paddingLeft);
    const right = frame.right - parseFloat(style.paddingRight);
    drum.style.setProperty("--stmt-shift", "0px");
    drum.style.setProperty("--stmt-drum-max", `${Math.max(0, right - left)}px`);
    drum.style.setProperty("--stmt-shift", `${Math.round(drumShift(drum.getBoundingClientRect(), { left, right }))}px`);
  }, [open, layout, slots]);
  // An open drum takes the next press: inside, it chooses; anywhere else in the panel it only closes.
  useEffect(() => {
    const panel = root.current?.closest<HTMLElement>(PANEL_ROOT) ?? root.current;
    if (!open || !panel) return;
    const swallow = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); };
    const down = (event: PointerEvent) => {
      if (event.target instanceof Node && slotElement(open)?.contains(event.target)) return;
      panel.addEventListener("click", swallow, { capture: true, once: true });
      // A press that never becomes a click (a drag, a scroll) must not swallow a later one.
      window.setTimeout(() => panel.removeEventListener("click", swallow, { capture: true }), 600);
      setOpen(null);
    };
    panel.addEventListener("pointerdown", down, true);
    return () => panel.removeEventListener("pointerdown", down, true);
  }, [open]);

  // ------------------------------------------------------------ announcements: the charge, outcomes and failures, once each
  const seen = useRef({ outcome: model.outcome, message: model.message, charge });
  useEffect(() => {
    const last = seen.current;
    if (model.outcome && model.outcome !== last.outcome) announce(`${model.outcome.kind === "launched" ? "Launched" : "Resumed"} on ${model.outcome.machine}`);
    else if (model.message?.failed && model.message !== last.message) announce(model.message.text);
    if (charge && charge !== last.charge) {
      announce(charge.requests > 0 ? `Verifying spends ${charge.requests} tiny requests. Confirm charge is the next control.` : "Nothing to verify through these accounts.");
    }
    seen.current = { outcome: model.outcome, message: model.message, charge };
  }, [model.outcome, model.message, charge]);

  // ------------------------------------------------------------ render
  const statusId = `${id}-status`;
  const verbCell = <div className={`${S}verb-cell`}>
    <button ref={verbButton} type="button" className={`${S}verb`} data-stmt-verb="" data-state={verb.state} aria-disabled={verb.state !== "ready" || undefined}
      aria-busy={verb.state === "busy" || undefined} aria-describedby={`${statusId}-1 ${statusId}-2`}
      title={verb.refusal ? verb.refusal.text : withKey(verb.label, LAUNCH_STROKE)} onClick={press}>{verb.label}</button>
  </div>;
  const rows = FORM_ROWS[choice.form];
  const ghosted = ghostedWords(choice.form);
  const columns = choice.form === "list" ? "minmax(0, 1fr)" : layout.measure?.columns.map(width => `${width}px`).join(" ") ?? "";
  // Unmeasured (no team to show yet), the verb is as wide as its label.
  const style = (layout.measure ? { "--stmt-verb": `${layout.measure.verb}px` } : {}) as CSSProperties;
  return <section ref={root} className={`${S}statement`} data-form={choice.form} data-size={choice.size} data-open={open || undefined}
    data-ready={layout.measure !== null || slots === null || undefined} aria-labelledby={`${id}-title`} style={style}>
    <h2 id={`${id}-title`} className="plugin-atyrode_code__sr">Team</h2>
    {!inline && <div className={`${S}verb-row`}>{verbCell}</div>}
    <div ref={field} className={`${S}field`} role="group" aria-label="The team; change any word in place"
      onBlur={event => { if (open && !(event.relatedTarget instanceof Node && slotElement(open)?.contains(event.relatedTarget))) setOpen(null); }}>
      {slots ? rows.map((row, index) => <div key={index} className={`${S}row`} data-ghosts={(index === 0 && ghosted.length > 0) || undefined}
        style={{ gridTemplateColumns: `${inline ? "var(--stmt-verb) " : ""}${columns}` }}>
        {inline && (index === 0 ? verbCell : <span aria-hidden="true" />)}
        {row.map(word => <StatementSlot key={word} slot={slots[word]} id={`${id}-${word}`} ghosted={ghosted.includes(word)} listed={choice.form === "list"}
          open={open === word} locked={word === "machine" ? !machineGate.open : !teamGate.open} cursor={cursor}
          motion={motion?.word === word ? motion.motion : null} onToggleOpen={() => toggleOpen(word)}
          onCommit={(option, via, from) => { commitOption(word, option, via, from); if (word !== "extras") setOpen(null); }}
          onPoint={option => point(word, option)} />)}
      </div>) : <div className={`${S}row`} style={{ gridTemplateColumns: inline ? "max-content minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
        {inline && verbCell}<span className={`${S}empty`}>{model.starterError ?? (reading ? "Reading the team" : "No team to show")}</span>
      </div>}
    </div>
    <div className={`${S}status`}>
      {lines.map((entry, index) => <StatusRow key={index} id={`${statusId}-${index + 1}`} line={entry}
        confirm={charge && <button type="button" className={`${S}confirm`} aria-label={`Confirm charge: ${charge.requests} ${charge.requests === 1 ? "request" : "requests"}`}
          aria-disabled={!verification.canConfirm || undefined}
          onClick={event => model.actions.confirmCharge({ detail: event.detail, repeat: false }, charge)}
          onKeyDown={event => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }}>Confirm charge</button>}
        onCancel={verification.cancel} onFix={runFix} onPointFix={pointFix} />)}
      {aside && <div className={`${S}aside`}>{aside}</div>}
    </div>
  </section>;
}

/**
 * One status line: Confirm charge first when the line carries it (the next Tab stop after the verb,
 * never focused for the person), then the line's facts, then its fix and cancel controls.
 */
function StatusRow({ id, line, confirm, onCancel, onFix, onPointFix }: {
  id: string; line: StatusLine; confirm: ReactElement | null; onCancel: () => void;
  onFix: (action: Extract<StatusAction, { kind: "fix" }>) => void; onPointFix: (action: Extract<StatusAction, { kind: "fix" }> | null) => void;
}) {
  const text = line.parts.map(entry => entry.text).join(" · ");
  return <div id={id} className={`${S}line`} title={text || undefined}>
    {line.actions.some(action => action.kind === "confirm") && confirm}
    {line.parts.map((entry, index) => <span key={index} className={`${S}part`} data-tone={entry.tone}>{entry.text}</span>)}
    {line.actions.map(action => action.kind === "cancel"
      ? <button key="cancel" type="button" className={`${S}link`} onClick={onCancel}>cancel</button>
      : action.kind === "fix"
        ? <button key={action.key} type="button" className={`${S}fix`} onClick={() => onFix(action)}
          onPointerEnter={() => onPointFix(action)} onPointerLeave={() => onPointFix(null)}
          onFocus={() => onPointFix(action)} onBlur={() => onPointFix(null)}>{action.label}</button>
        : null)}
  </div>;
}
