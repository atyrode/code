import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type RefObject } from "react";
import type { MachineSummary } from "@manifold/protocol";
import type { Selection } from "../../domain/contracts.ts";
import type { QuotaPool } from "../../domain/quota.ts";
import type { Review } from "../../domain/routing.ts";
import type { VerificationStep } from "../workflow.ts";
import { clock, familyWord, hhmm, LAUNCH_STROKE, withKey } from "../ui.tsx";
import { movesText, type ListFailure } from "./board-model.ts";
import { rescue } from "./consequences.ts";
import { previewSelection } from "./dial-space.ts";
import { strandsNote } from "./earlier-model.ts";
import type { RecentTeam } from "./recent-teams.ts";
import { useRosterForm } from "./seat-board.tsx";
import { StatementSlot, type SlotMotion } from "./slot.tsx";
import { statementKey, type StatementKeyAction } from "./statement-keys.ts";
import { chooseForm, drumShift, FORM_CHOICES, FORM_ROWS, ghostedWords, measureForm, VERB_INLINE, type FormMeasure, type SlotText, type TextMeasure } from "./statement-layout.ts";
import {
  changeSentence, commitKind, CONNECTORS, edgeOption, EXTRAS_LABELS, fixView, grounded, lastLaunchTeam, laneFix, poolCounts, projectionOf, reviewDifferences,
  reviewMatches, roleList, sameTeam, standstill, STATEMENT_WORDS, statementSlots, statusLines, stepOption, teamChange, teamEdits, teamFacts, VERB_LABELS,
  verbView, WORD_NAMES,
  type Pointed, type Projection, type Slot, type SlotOption, type StatementContext, type StatementWord, type StatusAction, type StatusFix, type StatusLine, type Vocabulary,
} from "./statement-model.ts";
import { useWheelTurn } from "./wheel-turn.ts";
import type { WorkbenchModel } from "./workbench-model.ts";

/** Statement class prefix; every part hangs from the generator root (styles.css). */
const S = "plugin-atyrode_code_generator__stmt-";
const PANEL_ROOT = ".plugin-atyrode_code_generator";
const HOUR = 3_600_000;
/** Where a verification stopped, in the line's words rather than the workflow's step names. */
const STEP_WORDS: Readonly<Record<VerificationStep, string>> = {
  observe: "reading the accounts", initialize: "setting up the workspace", inventory: "checking models", draft: "preparing the charge",
  benchmark: "measuring models", derive: "building the model list", stage: "saving the model list", review: "reviewing the model list",
  promote: "putting the model list in use", select: "saving the team",
};

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
  /** The main view shows: no sheet covers it. Its keys act only then. */
  readonly active: boolean;
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
  /** The line's measured width while it is one line (the measure the content below keeps to), else null. */
  readonly onMeasure?: (width: number | null) => void;
  /** The bundled model list could not be read: beside the seats already on the line, or instead of any team. The status lines say so. */
  readonly listFailure: ListFailure;
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
 * keeping the previous form within the hysteresis margin. A field with no width is hidden (the main
 * view behind a sheet) and keeps its form, so the view comes back in the form it left in.
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
      if (element.clientWidth === 0) return;
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
export function StatementLine({ model, active, preview, setPreview, pools, machines, selectMachine, recents, announce, onOpen, onKeys, onRefresh, listFailure, onMeasure }: StatementProps) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const verbButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<StatementWord | null>(null);
  const [cursor, setCursor] = useState(0);
  const [pointedAt, setPointedAt] = useState<{ readonly word: StatementWord; readonly value: string } | "fix" | null>(null);
  const [motion, setMotion] = useState<{ readonly word: StatementWord; readonly motion: SlotMotion } | null>(null);
  const [launching, setLaunching] = useState(false);
  // A Save & launch press that stopped at its review: the review, and what it shows unlike the projection.
  const [stopped, setStopped] = useState<{ readonly review: object; readonly differs: readonly string[] } | null>(null);
  // The keyboard's last commit or refused step, said in the status lines until the next input (pointing says its own).
  const [said, setSaid] = useState<Pointed | null>(null);
  const chain = useRef<{ readonly projection: Projection; readonly review: Review } | null>(null);
  const roster = useRosterForm(root);

  const { compiled: catalog, selection, controlsReview, served, verification } = model;
  const starter = model.profile?.metadata != null;
  const lastLaunch = model.recentTeams[0]?.selection ?? null;
  const shown = model.review ?? controlsReview;
  // Nothing to show yet because the first reads are still out, rather than because one failed.
  const reading = !model.profile && !model.document && model.queries.configuration.error === null && model.queries.metadata.error === null;
  const teamGate = model.gate("edit-team"), machineGate = model.gate("edit-machine");
  const vocab = useMemo<Vocabulary>(() => ({ family: familyWord, time: at => at - Date.now() > 20 * HOUR ? clock(at) : hhmm(at) }), []);
  // The saved workspace team, while the line holds an unsaved edit of it: what the verb's save would change.
  const saved = model.localDraft?.source === "active" ? model.record?.selection ?? null : null;
  const rosterError = model.rosterError !== null;
  const context = useMemo<StatementContext | null>(() => catalog && selection && controlsReview ? {
    catalog, selection, review: controlsReview, served, starter, nowMs: Date.now(), pools, lastLaunch, saved, machines, rosterError, machineId: model.machineId,
  } : null, [catalog, selection, controlsReview, served, starter, pools, lastLaunch, saved, machines, rosterError, model.machineId]);
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
      labels: word === "extras" ? EXTRAS_LABELS : slots[word].options.map(option => option.label),
    });
    return { lane: text("lane"), tier: text("tier"), thinking: text("thinking"), advisor: text("advisor"), extras: text("extras"), machine: text("machine") };
  }, [slots]);
  const layout = useStatementLayout(field, texts);
  const measured = layout.measure && FORM_CHOICES[layout.choice]!.form === "line" ? layout.measure.need : null;
  useEffect(() => onMeasure?.(measured), [measured]);

  const verb = verbView({
    step: model.step, verdict: model.verb, busy: model.busy, inFlight: model.inFlight, chaining: model.chaining, unsaved: model.unsaved,
    draft: model.localDraft !== null, phase: verification.phase, verification: verification.status,
    // Launch anyway is for roles whose pools are out; a lead no account serves is the door's refusal, never "anyway".
    stranded: quota?.stop?.waits.some(pool => pool.verdict.kind === "blocked" || pool.verdict.kind === "maxed") ?? false,
    grounded: quota?.grounded ?? false, placeable: model.placeable, launching,
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
    return said;
  }, [pointedAt, quota, catalog, shown, slots, preview, pools, said]);
  // The pointed team's moves, seat by seat, which the roster does not draw: an option, the fix and a recent team all point through the preview.
  const moves = roster && catalog && shown && preview ? movesText(catalog, shown, preview.review) || null : null;

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
    text: verification.failure.cancelled ? "Verification cancelled" : `Verification stopped while ${STEP_WORDS[verification.failure.step]}: ${verification.failure.reason}`,
    failed: !verification.failure.cancelled,
  } : null;
  const lines = statusLines({
    verb, phase: verification.phase, progress, charge, inFlight: model.inFlight, busy: model.busy, chaining: model.chaining, launching,
    machine: machine && { name: machine.name, online: machine.online, revoked: machine.revoked === true }, machineChosen: model.machineId !== "",
    rosterUnread: rosterError, otherMachine: other && { id: other.id, name: other.name },
    message: model.message ?? stoppedVerifying, outcome: model.outcome, launchStatus: model.launchStatus, stop: quota?.stop ?? null, fix: quota?.fix ?? null,
    team: quota?.team ?? { counts: [], fallsBack: [], tight: [], unread: false }, edits: saved && selection ? teamEdits(saved, selection, familyWord) : [],
    reviewed, differs: stopped !== null && stopped.review === model.launchReview ? stopped.differs : null,
    laneFix: verb.refusal?.code === "no-account" && slots && selection ? laneFix(slots.lane, selection) : null,
    nobodyServes: served !== null && served.size === 0, listFailure, pointed, moves,
  }, vocab);

  // ------------------------------------------------------------ the verb, and Save & launch as one gesture
  function press() {
    if (verb.opens) { onOpen(verb.opens); return; }
    if (verb.state !== "ready") {
      if (verb.refusal) announce(`${verb.label}: ${verb.refusal.text}`);
      return;
    }
    setStopped(null);
    if (verb.launches && shown) { chain.current = { projection: projectionOf(shown, served), review: shown }; setLaunching(true); }
    model.actions.next();
  }
  // A Save & launch press goes on from its review to the launch only when the review shows what was
  // projected; `next` asks the gate again before launching. A chain that ends anywhere else stops,
  // and a review that differs is said as what differs, for the person to choose.
  useLayoutEffect(() => {
    const projected = chain.current;
    if (!projected || model.busy || model.chaining) return;
    chain.current = null;
    setLaunching(false);
    const review = model.launchReview;
    if (model.step.step !== "launch" || !review || !catalog) return;
    if (reviewMatches(projected.projection, review.composition)) { model.actions.next(); return; }
    const differs = reviewDifferences(catalog, projected.review, projected.projection.providers, review.composition, vocab);
    setStopped({ review, differs });
    announce(`The review differs: ${differs.join("; ")}. Launch to use the reviewed pool, or change a word first.`);
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
    const name = word === "extras" ? `${option.label} ${option.on ? "off" : "on"}` : `${WORD_NAMES[word]} ${option.label}`;
    const stop = option.quota?.kind === "strands" ? `; ${roleList(option.quota.stop.roles)} would have no route` : "";
    // A keyboard commit says what it did where a pointer would have read it before choosing: in the status lines, until the next input.
    if (via === "keyboard" && teamGate.open) setSaid({ kind: "option", word, option });
    commitTeam(option.selection, word, via, from, `${name}${option.note ? `: ${option.note}` : ""}${stop}`);
  }
  /** A keyboard step that nothing can take says why, in the status lines and aloud, rather than doing nothing. */
  function refuseStep(word: StatementWord, option: SlotOption) {
    setSaid({ kind: "option", word, option });
    announce(`${WORD_NAMES[word]} ${option.label}: ${option.reason ?? option.note}`);
  }
  function stepWord(slot: Slot, more: boolean, via: "pointer" | "keyboard") {
    const option = stepOption(slot, more);
    if (option) { commitOption(slot.word, option, via, more ? -1 : 1); return; }
    const next = slot.current >= 0 ? slot.options[slot.current + (more ? -1 : 1)] : undefined;
    if (via === "keyboard" && next && !next.available) refuseStep(slot.word, next);
  }
  function recall(index: number) {
    const team = recents[index];
    if (!team || !selection) return;
    if (sameTeam(team.selection, selection)) { announce(`Recent team ${index + 1} is this team`); return; }
    if (!teamGate.open) { announce(teamGate.refusal.text); return; }
    if (commitKind(team.selection, selection, model.record?.selection ?? null, model.localDraft?.source ?? null) === "discard") model.actions.discardChanges();
    else model.actions.recallTeam(team);
    clearPointed();
    const formed = catalog && previewSelection(catalog, team.selection);
    const strands = formed && strandsNote(catalog, formed.routes, pools, vocab);
    announce(`Recent team ${index + 1}${strands ? ` · ${strands}` : ""}`);
  }
  function runFix(action: Extract<StatusAction, { kind: "fix" }>) {
    const fix: StatusFix = action.fix;
    switch (fix.kind) {
      case "team": commitTeam(fix.selection, null, "pointer", 1, action.label); return;
      case "machine":
        if (machineGate.open) { selectMachine(fix.machineId); announce(action.label); } else announce(machineGate.refusal.text);
        return;
      case "open": onOpen(fix.place, fix.family); return;
      // A re-read reads everything the line stands on, the machine list included.
      case "refresh": onRefresh(); return;
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
    // The keyboard's last word is said until the next input; a commit by this very key says its own.
    setSaid(null);
    const target = event.target instanceof HTMLElement ? event.target : null;
    const panel = root.current?.closest<HTMLElement>(PANEL_ROOT) ?? null;
    const view = root.current?.closest<HTMLElement>("[data-view]") ?? root.current;
    const onRoot = target !== null && target === panel;
    const inView = active && target !== null && (onRoot || view?.contains(target) === true);
    const inside = target !== null && root.current?.contains(target) === true;
    const named = inside ? target.closest<HTMLElement>("[data-stmt-word]")?.dataset.stmtWord : undefined;
    const word = STATEMENT_WORDS.find(candidate => candidate === named) ?? null;
    const action = statementKey({
      key: event.key, mod: event.ctrlKey || event.metaKey, alt: event.altKey, repeat: event.repeat, defaultPrevented: event.defaultPrevented,
      inView, onRoot, inField: target?.matches("textarea, input, select, [contenteditable]") ?? false, inDialog: target?.closest("[role=dialog], dialog") != null,
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
        const slot = slots[action.word];
        const team = lastLaunchTeam(action.word, slot, context);
        const last = action.word === "extras" ? undefined : slot.options.find(option => option.last);
        if (team) {
          if (last && teamGate.open) setSaid({ kind: "option", word: action.word, option: last });
          commitTeam(team, action.word, "keyboard", 1, `${WORD_NAMES[action.word]} back to the last launch${last?.note ? `: ${last.note}` : ""}`);
        } else if (slot.changed) {
          // The last launch's value is refused now: say why rather than doing nothing.
          if (last && !last.available) refuseStep(action.word, last);
          else announce(`${WORD_NAMES[action.word]}: the last launch's switches cannot all be set now`);
        }
        return true;
      }
    }
  }
  useEffect(() => {
    const scope = root.current;
    const panel = scope?.closest<HTMLElement>(PANEL_ROOT) ?? scope;
    if (!panel) return;
    const listener = (event: KeyboardEvent) => keys.current(event);
    const pointer = () => setSaid(null);
    panel.addEventListener("keydown", listener);
    panel.addEventListener("pointerdown", pointer, true);
    // The panel root takes focus when the panel opens, so its keys work at once; never from another control.
    const active = panel.ownerDocument.activeElement;
    if (panel.hasAttribute("tabindex") && (!active || active === panel.ownerDocument.body)) panel.focus({ preventScroll: true });
    return () => { panel.removeEventListener("keydown", listener); panel.removeEventListener("pointerdown", pointer, true); };
  }, []);

  // A status control that leaves the lines once pressed (a retry that clears its failure, a rescue taken) takes focus with
  // it to the page, where the panel's keys no longer reach; focus then goes to the verb, the statement's fixed point.
  const statusFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const control = statusFocus.current;
    if (!control || control.isConnected) return;
    statusFocus.current = null;
    const active = control.ownerDocument.activeElement;
    if (!active || active === control.ownerDocument.body) verbButton.current?.focus({ preventScroll: true });
  });

  // The wheel turns a word only on its open drum, or under keyboard focus after the pointer rests (wheel-turn.ts); never the
  // machine, whose turn would move the launch's destination under a scroll.
  useWheelTurn(field, { controls: "[data-stmt-word]:not([data-stmt-word=machine])", open: "[data-stmt-word][data-open]:not([data-stmt-word=machine])" },
    !teamGate.open, (control, step) => {
      const word = STATEMENT_WORDS.find(candidate => candidate === control.dataset.stmtWord);
      if (!word || word === "machine" || !slots) return;
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
    // The options' words stay on the word's edge while they fit beside it: their notes give way first, and only words
    // that cannot fit slide the drum left, as far as they need and never over the verb.
    const natural = drum.getBoundingClientRect();
    // Each option's words end where its note starts; the drum's 16px right padding follows the widest.
    const words = 16 + Math.max(0, ...[...drum.querySelectorAll<HTMLElement>(`.${S}note`)].map(note => note.getBoundingClientRect().left - natural.left));
    const shift = Math.round(drumShift({ left: natural.left, right: natural.left + words }, { left, right }));
    drum.style.setProperty("--stmt-drum-max", `${Math.max(words, right - natural.left - shift)}px`);
    drum.style.setProperty("--stmt-shift", `${shift}px`);
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
  // A verification that stopped is a refusal like any other, so it is said as the status line says it.
  const seen = useRef({ outcome: model.outcome, message: model.message, charge, failure: verification.failure });
  useEffect(() => {
    const last = seen.current;
    if (model.outcome && model.outcome !== last.outcome) announce(`${model.outcome.kind === "launched" ? "Launched" : "Resumed"} on ${model.outcome.machine}`);
    else if (model.message?.failed && model.message !== last.message) announce(model.message.text);
    else if (stoppedVerifying && verification.failure !== last.failure) announce(stoppedVerifying.text);
    if (charge && charge !== last.charge) {
      announce(charge.requests > 0 ? `Verifying spends ${charge.requests} tiny requests. Confirm charge is the next control.` : "Nothing to verify through these accounts.");
    }
    seen.current = { outcome: model.outcome, message: model.message, charge, failure: verification.failure };
  }, [model.outcome, model.message, charge, verification.failure]);

  // ------------------------------------------------------------ render
  const statusId = `${id}-status`;
  const verbCell = <div className={`${S}verb-cell`}>
    <button ref={verbButton} type="button" className={`${S}verb`} data-stmt-verb="" data-state={verb.state} aria-disabled={verb.state !== "ready" || undefined}
      aria-busy={verb.state === "busy" || undefined} aria-describedby={`${statusId}-1 ${statusId}-2`}
      title={verb.refusal ? verb.refusal.text : withKey(verb.label, LAUNCH_STROKE)} onClick={press}>{verb.label}</button>
  </div>;
  const rows = FORM_ROWS[choice.form];
  const ghosted = ghostedWords(choice.form);
  // Each column is a connector track and a value track (the slot's own two); one word per row takes the whole width.
  const columns = layout.measure?.columns ?? [];
  const template = choice.form === "list" ? "minmax(0, 1fr)" : columns.map(column => `${column.connector + column.value}px`).join(" ");
  // Unmeasured (no team to show yet), the verb is as wide as its label.
  const style = (layout.measure ? { "--stmt-verb": `${layout.measure.verb}px` } : {}) as CSSProperties;
  return <section ref={root} className={`${S}statement`} data-form={choice.form} data-size={choice.size} data-open={open || undefined}
    data-ready={layout.measure !== null || slots === null || undefined} aria-labelledby={`${id}-title`} style={style}>
    <h2 id={`${id}-title`} className="plugin-atyrode_code__sr">Team</h2>
    {!inline && <div className={`${S}verb-row`}>{verbCell}</div>}
    <div ref={field} className={`${S}field`} role="group" aria-label="The team; change any word in place"
      onBlur={event => { if (open && !(event.relatedTarget instanceof Node && slotElement(open)?.contains(event.relatedTarget))) setOpen(null); }}>
      {slots ? rows.map((row, index) => <div key={index} className={`${S}row`} data-ghosts={(index === 0 && ghosted.length > 0) || undefined}
        style={{ gridTemplateColumns: `${inline ? "var(--stmt-verb) " : ""}${template}` }}>
        {inline && (index === 0 ? verbCell : <span aria-hidden="true" />)}
        {row.map((word, column) => <StatementSlot key={word} slot={slots[word]} id={`${id}-${word}`} ghosted={ghosted.includes(word)} listed={choice.form === "list"}
          connector={columns[choice.form === "list" ? 0 : column]?.connector ?? null}
          open={open === word} locked={word === "machine" ? !machineGate.open : !teamGate.open} cursor={cursor}
          motion={motion?.word === word ? motion.motion : null} onToggleOpen={() => toggleOpen(word)}
          onCommit={(option, via, from) => { commitOption(word, option, via, from); if (word !== "extras") setOpen(null); }}
          onPoint={option => point(word, option)} />)}
      </div>) : <div className={`${S}row`} data-empty="" style={{ gridTemplateColumns: inline ? "max-content minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
        {inline && verbCell}<span className={`${S}empty`}>{model.starterError ?? (reading ? "Reading the team" : "No team to show")}</span>
      </div>}
    </div>
    <div className={`${S}status`} onFocus={event => { statusFocus.current = event.target; }}
      onBlur={event => { if (event.relatedTarget) statusFocus.current = null; }}>
      {lines.map((entry, index) => <StatusRow key={index} id={`${statusId}-${index + 1}`} line={entry}
        confirm={charge && <button type="button" className={`${S}confirm`} aria-label={`Confirm charge: ${charge.requests} ${charge.requests === 1 ? "request" : "requests"}`}
          aria-disabled={!verification.canConfirm || undefined}
          onClick={event => model.actions.confirmCharge({ detail: event.detail, repeat: false }, charge)}
          onKeyDown={event => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }}>Confirm charge</button>}
        onCancel={verification.cancel} onFix={runFix} onPointFix={pointFix} />)}
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
