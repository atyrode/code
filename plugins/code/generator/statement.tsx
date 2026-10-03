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
import { SettingRow } from "./settings.tsx";
import { chooseLayout, CONCLUSION_LAYOUTS, conclusionNeeds, SETTINGS_LAYOUTS, settingsNeeds, type SettingsMeasure } from "./settings-layout.ts";
import { statementKey, type StatementKeyAction } from "./statement-keys.ts";
import {
  changeSentence, commitKind, edgeOption, estimateReadouts, fixView, grounded, lastLaunchTeam, laneFix, poolCounts, projectionOf, reviewDifferences,
  reviewMatches, roleList, sameTeam, standstill, STATEMENT_WORDS, statementSlots, statusLines, stepOption, teamChange, teamEdits, teamFacts, VERB_LABELS,
  verbView, WORD_NAMES,
  type EstimateReadout, type Pointed, type Projection, type Slot, type SlotOption, type StatementContext, type StatementWord, type StatusAction, type StatusFix,
  type StatusLine, type Vocabulary,
} from "./statement-model.ts";
import type { WorkbenchModel } from "./workbench-model.ts";

/** Statement class prefix; every part hangs from the generator root (styles.css). */
const S = "plugin-atyrode_code_generator__stmt-";
const PANEL_ROOT = ".plugin-atyrode_code_generator";
const HOUR = 3_600_000;
/** Where a verification stopped, in the statement's words rather than the workflow's step names. */
const STEP_WORDS: Readonly<Record<VerificationStep, string>> = {
  observe: "reading the accounts", initialize: "setting up the workspace", inventory: "checking models", draft: "preparing the charge",
  benchmark: "measuring models", derive: "building the model list", stage: "saving the model list", review: "reviewing the model list",
  promote: "putting the model list in use", select: "saving the profile",
};
/** What the cost readout is, said once in the footer and on the readout's title. */
export const COST_NOTE = "cost is a relative list-price index; subscriptions spend quota windows, which the board shows";

/**
 * The profile the board and the status line show instead of the settings' while something is
 * pointed: a value, the fix, a recent profile or a session. `key` is stable per pointed thing and
 * distinct per profile; `label` names it for the status line when the statement did not set it.
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
  /** Choose the destination (`useCodeTarget().select`); the statement asks the machine gate first. */
  readonly selectMachine: (id: string) => void;
  /** Recent profiles in digit order, pinned for the session: index i is digit i + 1. */
  readonly recents: readonly RecentTeam[];
  readonly announce: (text: string) => void;
  readonly onOpen: (place: StatementPlace, family?: string) => void;
  /** `?`: show the keys dialog. */
  readonly onKeys: () => void;
  /** `r`: read the accounts, usage, machines and the workspace profile again. */
  readonly onRefresh: () => void;
  /** The settings' measured width while two sit per line (the measure the content below keeps to), else null. */
  readonly onMeasure?: (width: number | null) => void;
  /** The bundled model list could not be read: beside the seats already shown, or instead of any profile. The status lines say so. */
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

/** The settings' and the conclusion's layouts (indices into their lists), the settings' width in pairs, and the verb's width. */
type Layout = { readonly settings: number; readonly conclusion: number; readonly measure: number | null; readonly verb: number | null };

/**
 * The layouts the statement's own width allows (settings-layout.ts), measured from what it draws:
 * each setting's label and values as rendered, the verb's widest label in the verb's font, and the
 * estimates. Measured before paint, so the first frame is already in its layout, again once the
 * fonts have loaded or when what is drawn changes, and chosen again on every resize, keeping the
 * previous layout within the hysteresis margin. A statement with no width (the main view behind a
 * sheet) keeps its layout, so the view comes back as it left.
 */
function useStatementLayout(settings: RefObject<HTMLElement | null>, conclusion: RefObject<HTMLElement | null>, key: string): Layout {
  const [layout, setLayout] = useState<Layout>({ settings: SETTINGS_LAYOUTS.length - 1, conclusion: CONCLUSION_LAYOUTS.length - 1, measure: null, verb: null });
  const previous = useRef<{ settings: number | null; conclusion: number | null }>({ settings: null, conclusion: null });
  useLayoutEffect(() => {
    const box = settings.current, end = conclusion.current;
    const verb = end?.querySelector<HTMLElement>("[data-stmt-verb]");
    const context = box?.ownerDocument.createElement("canvas").getContext("2d");
    if (!box || !end || !verb || !context) return;
    let needs: { readonly settings: readonly number[]; readonly conclusion: readonly number[]; readonly verb: number } | null = null;
    const width = (element: Element | null) => element?.getBoundingClientRect().width ?? 0;
    const measure = () => {
      const drawn = [...box.querySelectorAll<HTMLElement>("[data-setting]")];
      const words = Object.fromEntries(drawn.map(setting => [setting.dataset.setting, {
        label: width(setting.querySelector(`.${S}label-text`)),
        values: [...setting.querySelectorAll(`.${S}value`)].map(width),
        gap: parseFloat(getComputedStyle(setting.querySelector(`.${S}values`)!).columnGap) || 0,
      }])) as SettingsMeasure;
      const font = getComputedStyle(verb), grid = getComputedStyle(box);
      context.font = `600 ${font.fontSize} ${font.fontFamily}`;
      // The filled verb's 12px padding on each side: a refused or waiting verb draws none, but keeps the width.
      const verbWidth = Math.ceil(Math.max(...VERB_LABELS.map(label => context.measureText(label).width)) + 24);
      needs = {
        // With no settings drawn (the profile is still read) only the narrowest layout is ever chosen, so nothing below keeps to a measure of nothing.
        settings: drawn.length ? settingsNeeds(words, { label: parseFloat(grid.columnGap) || 0, pair: parseFloat(grid.getPropertyValue("--stmt-pair-gap")) || 0 })
          : SETTINGS_LAYOUTS.map((_, index) => index < SETTINGS_LAYOUTS.length - 1 ? Number.POSITIVE_INFINITY : 0),
        conclusion: conclusionNeeds(verbWidth, width(end.querySelector(`.${S}estimates`)), parseFloat(getComputedStyle(end).columnGap) || 0), verb: verbWidth,
      };
    };
    const update = () => {
      const available = box.clientWidth;
      if (available === 0 || !needs) return;
      const chosen = { settings: chooseLayout(available, needs.settings, previous.current.settings), conclusion: chooseLayout(available, needs.conclusion, previous.current.conclusion) };
      previous.current = chosen;
      const next: Layout = { ...chosen, measure: SETTINGS_LAYOUTS[chosen.settings] === "pairs" ? needs.settings[0]! : null, verb: needs.verb };
      setLayout(current => current.settings === next.settings && current.conclusion === next.conclusion && current.measure === next.measure && current.verb === next.verb ? current : next);
    };
    measure();
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    let live = true;
    void box.ownerDocument.fonts?.ready.then(() => { if (live) { measure(); update(); } });
    return () => { live = false; observer.disconnect(); };
  }, [key]);
  return layout;
}

/**
 * The statement: the profile's six settings, each with every value in view, and under them its
 * conclusion, the verb with the two status lines and the cost and speed readouts. Every action goes
 * through the workbench model's gate; the statement only names the step, shows what each value
 * would do and quota's verdict on it, and writes the consequence of whatever is pointed in the
 * status lines and the readouts.
 */
export function StatementLine({ model, active, preview, setPreview, pools, machines, selectMachine, recents, announce, onOpen, onKeys, onRefresh, listFailure, onMeasure }: StatementProps) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const settingsBox = useRef<HTMLDivElement>(null);
  const conclusionBox = useRef<HTMLDivElement>(null);
  const verbButton = useRef<HTMLButtonElement>(null);
  const [pointedAt, setPointedAt] = useState<{ readonly word: StatementWord; readonly value: string } | "fix" | null>(null);
  const pointing = useRef(pointedAt);
  pointing.current = pointedAt;
  // The extras switch that holds the setting's Tab stop: the one the keyboard was last on.
  const [anchor, setAnchor] = useState(0);
  // A keyboard step moves focus with the value: once the setting shows the chosen value, it takes focus.
  const refocus = useRef<{ readonly word: StatementWord; readonly value: string } | null>(null);
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
  // The saved workspace profile, while the settings hold an unsaved edit of it: what the verb's save would change.
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
  const readouts = useMemo(() => catalog && shown ? estimateReadouts(catalog, shown, preview?.review ?? null) : null, [catalog, shown, preview?.review]);
  // What the layout is measured on: every value's words, and whether the readouts are drawn.
  const drawn = JSON.stringify([slots && STATEMENT_WORDS.map(word => slots[word].options.map(option => option.label)), readouts !== null]);
  const layout = useStatementLayout(settingsBox, conclusionBox, drawn);
  useEffect(() => onMeasure?.(layout.measure), [layout.measure]);

  const verb = verbView({
    step: model.step, verdict: model.verb, busy: model.busy, inFlight: model.inFlight, chaining: model.chaining, unsaved: model.unsaved,
    draft: model.localDraft !== null, phase: verification.phase, verification: verification.status,
    // Launch anyway is for roles whose pools are out; a lead no account serves is the door's refusal, never "anyway".
    stranded: quota?.stop?.waits.some(pool => pool.verdict.kind === "blocked" || pool.verdict.kind === "maxed") ?? false,
    grounded: quota?.grounded ?? false, placeable: model.placeable, launching,
  });

  // ------------------------------------------------------------ pointing: the status lines, the readouts and the board show what a choice would do
  const mine = (key: string | undefined) => key !== undefined && (key.startsWith("option:") || key.startsWith("fix:"));
  function clearPointed() {
    setPointedAt(null);
    if (mine(preview?.key)) setPreview(null);
  }
  /** Point at a value, or let go of `left`: only the value pointed is let go of, so a pointer resting elsewhere keeps its say. */
  function point(word: StatementWord, option: SlotOption | null, left?: SlotOption) {
    if (!option) {
      const at = pointing.current;
      if (left && (at === null || at === "fix" || at.word !== word || at.value !== left.value)) return;
      clearPointed();
      return;
    }
    setPointedAt({ word, value: option.value });
    if (option.review && option.selection) setPreview({ key: `option:${word}:${option.value}`, selection: option.selection, review: option.review });
    else if (mine(preview?.key)) setPreview(null);
  }
  function pointFix(action: Extract<StatusAction, { kind: "fix" }> | null) {
    const team = action?.fix.kind === "team" ? action.fix : null;
    setPointedAt(action?.key === "rescue" ? "fix" : null);
    if (team?.review) setPreview({ key: `fix:${action!.key}`, selection: team.selection, review: team.review, label: action!.label });
    else if (mine(preview?.key)) setPreview(null);
  }
  const pointed = useMemo<Pointed | null>(() => {
    if (pointedAt === "fix" && quota?.fix && catalog && shown) return { kind: "fix", fix: quota.fix, sentence: changeSentence(catalog, shown, quota.fix.review, familyWord) };
    if (pointedAt && pointedAt !== "fix" && slots) {
      const option = slots[pointedAt.word].options.find(candidate => candidate.value === pointedAt.value);
      if (option) return { kind: "option", word: pointedAt.word, option };
    }
    if (preview && !mine(preview.key) && catalog && shown) {
      const change = teamChange(catalog, shown, preview.review, pools, familyWord);
      return { kind: "team", label: preview.label ?? "This profile", sentence: change.sentence, quota: change.quota };
    }
    return said;
  }, [pointedAt, quota, catalog, shown, slots, preview, pools, said]);
  // The pointed profile's moves, seat by seat, which the roster does not draw: a value, the fix and a recent profile all point through the preview.
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
    announce(`The review differs: ${differs.join("; ")}. Launch to use the reviewed pool, or change a setting first.`);
  });

  // ------------------------------------------------------------ commits, all through the edit gates
  function commitTeam(next: Selection, say: string) {
    if (!selection) return;
    if (!teamGate.open) { announce(teamGate.refusal.text); return; }
    const kind = commitKind(next, selection, model.record?.selection ?? null, model.localDraft?.source ?? null);
    if (kind === "none") return;
    if (kind === "discard") model.actions.discardChanges();
    else model.actions.updateSelection(next);
    clearPointed();
    announce(say);
  }
  function commitOption(word: StatementWord, option: SlotOption, via: "pointer" | "keyboard") {
    if (word === "machine") {
      if (!machineGate.open) { announce(machineGate.refusal.text); return; }
      selectMachine(option.value);
      if (via === "keyboard") refocus.current = { word, value: option.value };
      announce(`Machine ${option.label}`);
      return;
    }
    if (!option.selection) return;
    const name = word === "extras" ? `${option.label} ${option.on ? "off" : "on"}` : `${WORD_NAMES[word]} ${option.label}`;
    const stop = option.quota?.kind === "strands" ? `; ${roleList(option.quota.stop.roles)} would have no route` : "";
    // A keyboard commit says what it did where a pointer would have read it before choosing: in the status lines, until the next input.
    if (via === "keyboard" && teamGate.open) {
      setSaid({ kind: "option", word, option });
      if (word !== "extras") refocus.current = { word, value: option.value };
    }
    commitTeam(option.selection, `${name}${option.note ? `: ${option.note}` : ""}${stop}`);
  }
  /** A value nothing can take says why, in the status lines and aloud, rather than doing nothing. */
  function refuseStep(word: StatementWord, option: SlotOption) {
    setSaid({ kind: "option", word, option });
    announce(`${WORD_NAMES[word]} ${option.label}: ${option.reason ?? option.note}`);
  }
  /** A press on a value: the current one stays, a refused one says why, any other is chosen (a switch turns). */
  function choose(word: StatementWord, option: SlotOption) {
    if (option.current) return;
    if (!option.available) { refuseStep(word, option); return; }
    commitOption(word, option, "pointer");
  }
  function stepWord(slot: Slot, forward: boolean) {
    const option = stepOption(slot, forward);
    if (option) { commitOption(slot.word, option, "keyboard"); return; }
    const next = slot.current >= 0 ? slot.options[slot.current + (forward ? 1 : -1)] : undefined;
    if (next && !next.available) refuseStep(slot.word, next);
  }
  function recall(index: number) {
    const team = recents[index];
    if (!team || !selection) return;
    if (sameTeam(team.selection, selection)) { announce(`Recent profile ${index + 1} is this profile`); return; }
    if (!teamGate.open) { announce(teamGate.refusal.text); return; }
    if (commitKind(team.selection, selection, model.record?.selection ?? null, model.localDraft?.source ?? null) === "discard") model.actions.discardChanges();
    else model.actions.recallTeam(team);
    clearPointed();
    const formed = catalog && previewSelection(catalog, team.selection);
    const strands = formed && strandsNote(catalog, formed.routes, pools, vocab);
    announce(`Recent profile ${index + 1}${strands ? ` · ${strands}` : ""}`);
  }
  function runFix(action: Extract<StatusAction, { kind: "fix" }>) {
    const fix: StatusFix = action.fix;
    switch (fix.kind) {
      case "team": commitTeam(fix.selection, action.label); return;
      case "machine":
        if (machineGate.open) { selectMachine(fix.machineId); announce(action.label); } else announce(machineGate.refusal.text);
        return;
      case "open": onOpen(fix.place, fix.family); return;
      // A re-read reads everything the statement stands on, the machine list included.
      case "refresh": onRefresh(); return;
      case "discard": model.actions.discardChanges(); return;
    }
  }
  const settingElement = (word: StatementWord) => root.current?.querySelector<HTMLElement>(`[data-setting="${word}"]`) ?? null;
  /** Move focus among the extras switches; focus points at the switch, as the pointer would. */
  function moveCursor(at: number) {
    const options = slots?.extras.options ?? [];
    const option = options[Math.max(0, Math.min(options.length - 1, at))];
    if (option) [...settingElement("extras")?.querySelectorAll<HTMLElement>("[data-value]") ?? []].find(element => element.dataset.value === option.value)?.focus();
  }

  // ------------------------------------------------------------ keys: panel-local, decided by statementKey
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = event => {
    // The keyboard's last word is said until the next input; a commit by this very key says its own.
    setSaid(null);
    refocus.current = null;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const panel = root.current?.closest<HTMLElement>(PANEL_ROOT) ?? null;
    const view = root.current?.closest<HTMLElement>("[data-view]") ?? root.current;
    const onRoot = target !== null && target === panel;
    const inView = active && target !== null && (onRoot || view?.contains(target) === true);
    const inside = target !== null && root.current?.contains(target) === true;
    const value = inside ? target.closest<HTMLElement>("[data-value]") : null;
    const named = value?.closest<HTMLElement>("[data-setting]")?.dataset.setting;
    const word = STATEMENT_WORDS.find(candidate => candidate === named) ?? null;
    const action = statementKey({
      key: event.key, mod: event.ctrlKey || event.metaKey, alt: event.altKey, repeat: event.repeat, defaultPrevented: event.defaultPrevented,
      inView, onRoot, inField: target?.matches("textarea, input, select, [contenteditable]") ?? false,
      inDialog: target?.closest("[role=dialog], dialog, [data-popover]") != null,
      word, onVerb: inside && target.closest("[data-stmt-verb]") !== null, recents: recents.length,
    });
    const at = word === "extras" && slots ? slots.extras.options.findIndex(option => option.value === value?.dataset.value) : -1;
    if (action && run(action, at)) { event.preventDefault(); event.stopPropagation(); }
  };
  function run(action: StatementKeyAction, at: number): boolean {
    switch (action.kind) {
      case "verb": press(); return true;
      case "keys": onKeys(); return true;
      case "refresh": onRefresh(); return true;
      case "recall": recall(action.index); return true;
      // A setting's Tab stop is its current value, or the extras switch the keyboard was last on.
      case "focus": (action.to === "verb" ? verbButton.current : settingElement(action.to)?.querySelector<HTMLElement>("[data-anchor]"))?.focus(); return true;
      case "escape":
        if (!pointedAt) return false;
        clearPointed();
        return true;
    }
    if (!slots) return true;
    switch (action.kind) {
      case "step": stepWord(slots[action.word], action.forward); return true;
      case "edge": {
        const option = edgeOption(slots[action.word], action.last);
        if (option) commitOption(action.word, option, "keyboard");
        return true;
      }
      case "cursor": moveCursor(at + (action.forward ? 1 : -1)); return true;
      case "cursor-edge": moveCursor(action.last ? slots.extras.options.length - 1 : 0); return true;
      case "toggle": {
        const option = slots.extras.options[at];
        if (option && !option.available) refuseStep("extras", option);
        else if (option) commitOption("extras", option, "keyboard");
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
          if (last && teamGate.open) { setSaid({ kind: "option", word: action.word, option: last }); refocus.current = { word: action.word, value: last.value }; }
          commitTeam(team, `${WORD_NAMES[action.word]} back to the last launch${last?.note ? `: ${last.note}` : ""}`);
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
    const pointer = () => { setSaid(null); refocus.current = null; };
    panel.addEventListener("keydown", listener);
    panel.addEventListener("pointerdown", pointer, true);
    // The panel root takes focus when the panel opens, so its keys work at once; never from another control.
    const active = panel.ownerDocument.activeElement;
    if (panel.hasAttribute("tabindex") && (!active || active === panel.ownerDocument.body)) panel.focus({ preventScroll: true });
    return () => { panel.removeEventListener("keydown", listener); panel.removeEventListener("pointerdown", pointer, true); };
  }, []);

  // Once a keyboard step's value shows, it takes focus from the value it left, so the next arrow steps on from it.
  useLayoutEffect(() => {
    const wanted = refocus.current;
    const setting = wanted && settingElement(wanted.word);
    const anchorValue = setting?.querySelector<HTMLElement>("[data-anchor]");
    if (!wanted || !setting || anchorValue?.dataset.value !== wanted.value) return;
    refocus.current = null;
    if (setting.contains(setting.ownerDocument.activeElement)) anchorValue.focus({ preventScroll: true });
  });

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
  // Unmeasured (nothing drawn yet), the verb is as wide as its label.
  const style = (layout.verb === null ? {} : { "--stmt-verb": `${layout.verb}px` }) as CSSProperties;
  return <section ref={root} className={`${S}statement`} data-layout={SETTINGS_LAYOUTS[layout.settings]} data-conclusion={CONCLUSION_LAYOUTS[layout.conclusion]}
    aria-labelledby={`${id}-title`} style={style}>
    <h2 id={`${id}-title`} className="plugin-atyrode_code__sr">Profile</h2>
    <div ref={settingsBox} className={`${S}settings`} role="group" aria-label="Profile settings">
      {slots ? STATEMENT_WORDS.map(word => <SettingRow key={word} slot={slots[word]} id={`${id}-${word}`} locked={word === "machine" ? !machineGate.open : !teamGate.open}
        anchor={word === "extras" ? anchor : -1} onChoose={option => choose(word, option)} onPoint={(option, left) => point(word, option, left)} onAnchor={setAnchor} />)
        : <p className={`${S}empty`}>{model.starterError ?? (reading ? "Reading the profile" : "No profile to show")}</p>}
    </div>
    {/* The conclusion: the verb, then the status lines that say why it reads as it does, then the readouts; placed by the layout. */}
    <div ref={conclusionBox} className={`${S}conclusion`}>
      <button ref={verbButton} type="button" className={`${S}verb`} data-stmt-verb="" data-state={verb.state} aria-disabled={verb.state !== "ready" || undefined}
        aria-busy={verb.state === "busy" || undefined} aria-describedby={`${statusId}-1 ${statusId}-2`}
        title={verb.refusal ? verb.refusal.text : withKey(verb.label, LAUNCH_STROKE)} onClick={press}>{verb.label}</button>
      <div className={`${S}status`} onFocus={event => { statusFocus.current = event.target; }}
        onBlur={event => { if (event.relatedTarget) statusFocus.current = null; }}>
        {lines.map((entry, index) => <StatusRow key={index} id={`${statusId}-${index + 1}`} line={entry}
          confirm={charge && <button type="button" className={`${S}confirm`} aria-label={`Confirm charge: ${charge.requests} ${charge.requests === 1 ? "request" : "requests"}`}
            aria-disabled={!verification.canConfirm || undefined}
            onClick={event => model.actions.confirmCharge({ detail: event.detail, repeat: false }, charge)}
            onKeyDown={event => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }}>Confirm charge</button>}
          onCancel={verification.cancel} onFix={runFix} onPointFix={pointFix} />)}
      </div>
      {readouts && <div className={`${S}estimates`} role="group" aria-label="Estimates">
        <Readout name="cost" readout={readouts.cost} title={`${COST_NOTE[0]!.toUpperCase()}${COST_NOTE.slice(1)}.`} />
        <Readout name="speed" readout={readouts.speed} title={readouts.speed.level === null
          ? "No lead model has a measured throughput yet; verifying models measures it." : "Relative speed from measured throughput and first-token time, weighted by role."} />
      </div>}
    </div>
  </section>;
}

/**
 * One estimate: its name, a level of five cells, the level's word, and while a profile is pointed
 * the change it would make. The pointed level is drawn over the present one (cells it adds bright,
 * cells it takes away hollow) and the word follows it; each part keeps a fixed width, so pointing
 * changes colours and words, never geometry.
 */
function Readout({ name, readout, title }: { name: string; readout: EstimateReadout; title: string }) {
  const { level, next, word } = readout;
  const delta = level !== null && next !== null ? next - level : 0;
  return <div className={`${S}estimate`} data-estimate={name} data-pointed={next !== null || undefined} data-unmeasured={level === null || undefined} title={title}>
    <span className={`${S}estimate-label`}>{name}</span>
    <span className={`${S}meter`} aria-hidden="true">{[1, 2, 3, 4, 5].map(step => {
      const on = level !== null && step <= level;
      return <i key={step} data-on={on || undefined} data-gain={(next !== null && !on && step <= next) || undefined}
        data-loss={(next !== null && on && step > next) || undefined} />;
    })}</span>
    <span className={`${S}estimate-word`}>{word}{delta !== 0 && <span className={`${S}estimate-delta`}>{delta > 0 ? `+${delta}` : `−${-delta}`}</span>}</span>
    {level !== null && <span className="plugin-atyrode_code__sr">, {next ?? level} of 5</span>}
  </div>;
}

/**
 * One status line: Confirm charge first when the line carries it (the next Tab stop after the verb,
 * never focused for the person), then the line's facts, then its fix and cancel controls. A line too
 * long for its room ellipsizes its facts, never its controls, and its title says the facts whole.
 */
function StatusRow({ id, line, confirm, onCancel, onFix, onPointFix }: {
  id: string; line: StatusLine; confirm: ReactElement | null; onCancel: () => void;
  onFix: (action: Extract<StatusAction, { kind: "fix" }>) => void; onPointFix: (action: Extract<StatusAction, { kind: "fix" }> | null) => void;
}) {
  const text = line.parts.map(entry => entry.text).join(" · ");
  return <div id={id} className={`${S}line`} title={text || undefined}>
    {line.actions.some(action => action.kind === "confirm") && confirm}
    {line.parts.length > 0 && <span className={`${S}parts`}>
      {line.parts.map((entry, index) => <span key={index} className={`${S}part`} data-tone={entry.tone}>{entry.text}</span>)}
    </span>}
    {line.actions.map(action => action.kind === "cancel"
      ? <button key="cancel" type="button" className={`${S}link`} onClick={onCancel}>cancel</button>
      : action.kind === "fix"
        ? <button key={action.key} type="button" className={`${S}fix`} onClick={() => onFix(action)}
          onPointerEnter={() => onPointFix(action)} onPointerLeave={() => onPointFix(null)}
          onFocus={() => onPointFix(action)} onBlur={() => onPointFix(null)}>{action.label}</button>
        : null)}
  </div>;
}
