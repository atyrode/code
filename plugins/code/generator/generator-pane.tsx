import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { MachineSummary } from "@manifold/protocol";
import { prefersReducedMotion } from "@manifold/ui";
import type { Selection } from "../../domain/contracts.ts";
import type { QuotaPool } from "../../domain/quota.ts";
import { defaultSelection, type Review } from "../../domain/routing.ts";
import type { VerificationStep } from "../workflow.ts";
import { clock, familyWord, hhmm, LAUNCH_STROKE, withKey } from "../ui.tsx";
import { displayAliases } from "./aliases.ts";
import type { ListFailure } from "./board-model.ts";
import { rescue } from "./consequences.ts";
import { previewSelection } from "./dial-space.ts";
import { DialRow, Glyph, toneColor } from "./dial-row.tsx";
import { strandsNote } from "./earlier-model.ts";
import type { RecentTeam } from "./recent-teams.ts";
import { profileGroups, type LedgerRow } from "./routing-model.ts";
import { Profile, rippleTeam } from "./routing-pane.tsx";
import { generatorRows, type GeneratorRow, type RowId, type RowWord } from "./rows-model.ts";
import {
  changeSentence, commitKind, estimateReadouts, fixView, grounded, launchLine, launchReadout, laneFix, poolCounts, projectionOf, quotaParts, reviewDifferences,
  reviewMatches, sameTeam, standstill, statementSlots, teamEdits, verbView,
  type EstimateReadout, type Projection, type StatementContext, type StatusAction, type StatusFix, type StatusLine, type Vocabulary,
} from "./statement-model.ts";
import type { WorkbenchModel } from "./workbench-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
const HOUR = 3_600_000;
/** How long the readout keeps what a key or a press did before it gives way to what is pointed. */
const KEY_SAID_MS = 2600;
/** How long the readout keeps a scrub's consequence after the pointer lets go. */
const SCRUB_SAID_MS = 900;
const ENTER = "M13.25 2.75v5.5a1 1 0 0 1-1 1H3.5M6.75 6 3.5 9.25l3.25 3.25";
const CHECK = "M3 8.5 6.5 12 13 4.5";
/** Where a verification stopped, in the panel's words rather than the workflow's step names. */
const STEP_WORDS: Readonly<Record<VerificationStep, string>> = {
  observe: "reading the accounts", initialize: "setting up the workspace", inventory: "checking models", draft: "preparing the charge",
  benchmark: "measuring models", derive: "building the model list", stage: "saving the model list", review: "reviewing the model list",
  promote: "putting the model list in use", select: "saving the profile",
};
/** What the cost meter is, said in the readout while it is pointed. */
const COST_NOTE = "a relative list-price index; subscriptions spend quota windows, which usage shows";
/** The key a fix answers to as well, where one opens the same place. */
const FIX_KEYS: Readonly<Record<string, string>> = { accounts: "a", models: "m", setup: "u", options: "o", refresh: "r" };

/** How the panel names providers and times: a reopening today by its clock time, a later one with its weekday. */
export const PANEL_VOCABULARY: Vocabulary = { family: familyWord, time: at => at - Date.now() > 20 * HOUR ? clock(at) : hhmm(at) };

/** The launch as the key line and the accounts view's foot name it: its label, whether a press runs it, and why not. */
export type LaunchState = { readonly label: string; readonly ready: boolean; readonly reason: string | null };

/** Where a fix or the launch sends the person: a sheet, or the accounts view (by family). */
export type GeneratorPlace = "models" | "setup" | "options" | "accounts";
/** What the panel's keys ask of the generator. */
export type GeneratorControls = {
  /** ↵: the launch's press, with its charge and check. */
  readonly launch: () => void;
  readonly defaults: () => void;
  /** Back to the saved workspace profile, while the rows hold an edit of it. */
  readonly saved: () => void;
  /** `f` while fallbacks are off: the fallbacks row takes focus and says there are no chains. */
  readonly noChains: () => void;
  /** The row the keyboard was last on takes focus. */
  readonly focusRows: () => void;
  /** A digit in the sessions view: recall that recent profile. */
  readonly recall: (index: number) => void;
};

export type GeneratorPaneProps = {
  readonly model: WorkbenchModel;
  /** `quotaPools` over the present usage reading. */
  readonly pools: readonly QuotaPool[];
  /** The machine roster; null while it is read. */
  readonly machines: readonly MachineSummary[] | null;
  /** Choose the destination (`useCodeTarget().select`); the pane asks the machine gate first. */
  readonly selectMachine: (id: string) => void;
  /** Recent profiles in digit order, pinned for the session: index i is digit i + 1. */
  readonly recents: readonly RecentTeam[];
  /** Families with a signed-in account, included or not; null when the reading cannot say. */
  readonly connected: ReadonlySet<string> | null;
  /** The routing's rows, which the narrow profile groups. */
  readonly ledger: readonly LedgerRow[] | null;
  /** The review the routing shows: the reviewed composition while current, else the local review. */
  readonly shown: Review | null;
  /** Routing is not beside the generator, so the team shows grouped under its rows. */
  readonly profile: boolean;
  /** Another view has the stage; the pane keeps its state behind it. */
  readonly hidden: boolean;
  readonly listFailure: ListFailure;
  /** The session options' summary when they are not the ordinary ones ("2 skills", "restricted"). */
  readonly optionsSummary: string | null;
  readonly announce: (text: string) => void;
  readonly onOpen: (place: GeneratorPlace, family?: string) => void;
  /** Read accounts, usage, machines and the workspace profile again. */
  readonly onRefresh: () => void;
  /** Hears the launch's label, readiness and refusal whenever they change. */
  readonly onLaunchState: (state: LaunchState) => void;
  readonly controls: RefObject<GeneratorControls | null>;
};

/** What the readout says: a value in bold, then what it means or does, warm when it refuses or strains. */
type Said = { readonly value: string; readonly text: string; readonly warn: boolean; readonly color: string | null };
type Hovered = { readonly kind: "word"; readonly row: RowId; readonly key: string } | { readonly kind: "launch" } | { readonly kind: "meter"; readonly name: "cost" | "speed" };
type Scrub = { readonly row: RowId; readonly origin: Review | null; readonly refused: RowWord | null };

/**
 * GENERATOR: one row of plain option words per dial, extra and machine, a readout line that says
 * what is pointed, the narrow profile when routing is not beside, the cost and speed meters and the
 * launch line. Every action goes through the workbench model's gate; the pane only names the step,
 * shows what each word would do and quota's verdict on it, and says the consequence of whatever is
 * pointed, pressed or scrubbed in the readout.
 */
export function GeneratorPane(props: GeneratorPaneProps) {
  const { model, pools, machines, selectMachine, recents, connected, ledger, shown, profile, hidden, listFailure, optionsSummary, announce, onOpen, onRefresh, onLaunchState, controls } = props;
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const launchButton = useRef<HTMLButtonElement>(null);
  const [cursor, setCursor] = useState<RowId>("lane");
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const [focused, setFocused] = useState<RowId | null>(null);
  const [keySaid, setKeySaid] = useState<Said | null>(null);
  const [scrub, setScrub] = useState<Scrub | null>(null);
  const [launching, setLaunching] = useState(false);
  // A Save & launch press that stopped at its review: the review, and what it shows unlike the projection.
  const [stopped, setStopped] = useState<{ readonly review: object; readonly differs: readonly string[] } | null>(null);
  const chain = useRef<{ readonly projection: Projection; readonly review: Review } | null>(null);
  const keyTimer = useRef(0), scrubTimer = useRef(0);

  const { compiled: catalog, selection, controlsReview, served, verification } = model;
  const starter = model.profile?.metadata != null;
  // Nothing to show yet because the first reads are still out, rather than because one failed.
  const reading = !model.profile && !model.document && model.queries.configuration.error === null && model.queries.metadata.error === null;
  const teamGate = model.gate("edit-team"), machineGate = model.gate("edit-machine");
  const vocab = PANEL_VOCABULARY;
  // The saved workspace profile, while the rows hold an unsaved edit of it: what `z` returns to and the launch's save would change.
  const saved = model.localDraft?.source === "active" ? model.record?.selection ?? null : null;
  const rosterError = model.rosterError !== null;
  const context = useMemo<StatementContext | null>(() => catalog && selection && controlsReview ? {
    catalog, selection, review: controlsReview, served, starter, nowMs: Date.now(), pools, machines, rosterError, machineId: model.machineId,
  } : null, [catalog, selection, controlsReview, served, starter, pools, machines, rosterError, model.machineId]);
  const slots = useMemo(() => context && statementSlots(context, vocab), [context, vocab]);
  const aliases = useMemo(() => catalog && displayAliases(catalog), [catalog]);
  const rows = useMemo(() => slots && catalog && controlsReview && aliases
    ? generatorRows({ slots, catalog, controls: controlsReview, shown: shown ?? controlsReview, aliases, connected }) : null,
  [slots, catalog, controlsReview, shown, aliases, connected]);
  const quota = useMemo(() => {
    if (!catalog || !shown) return null;
    const stop = standstill(catalog, shown.routes, pools);
    const found = stop ? rescue(catalog, shown, pools, { served, starter, nowMs: Date.now() }) : null;
    return { stop, fix: found && fixView(found, catalog, pools, vocab), grounded: grounded(catalog, shown.routes, pools, served) };
  }, [catalog, shown, pools, served, starter, vocab]);
  const estimates = useMemo(() => catalog && shown ? estimateReadouts(catalog, shown) : null, [catalog, shown]);
  const groups = useMemo(() => profile && ledger ? profileGroups(ledger) : null, [profile, ledger]);

  const verb = verbView({
    step: model.step, verdict: model.verb, busy: model.busy, inFlight: model.inFlight, chaining: model.chaining, unsaved: model.unsaved,
    draft: model.localDraft !== null, phase: verification.phase, verification: verification.status,
    // Launch anyway is for roles whose pools are out; a lead no account serves is the door's refusal, never "anyway".
    stranded: quota?.stop?.waits.some(pool => pool.verdict.kind === "blocked" || pool.verdict.kind === "maxed") ?? false,
    grounded: quota?.grounded ?? false, placeable: model.placeable, launching,
  });

  const ready = verb.state === "ready", reason = verb.refusal?.text ?? null;
  useEffect(() => onLaunchState({ label: verb.label, ready, reason }), [verb.label, ready, reason]);

  // ------------------------------------------------------------ the launch line and what the launch says
  const machine = machines?.find(entry => entry.id === model.machineId) ?? null;
  const other = machines?.find(entry => entry.id !== model.machineId && entry.online && entry.revoked !== true) ?? null;
  const charge = verification.phase === "charge" ? verification.charge : null;
  const progress = verification.progress?.providers.reduce((sum, entry) => ({ done: sum.done + entry.done, total: sum.total + entry.total }), { done: 0, total: 0 }) ?? null;
  // A verification that stopped says so until the next one starts; the verb, Verify models again, is its retry.
  const stoppedVerifying = verification.failure && verification.phase === null ? {
    text: verification.failure.cancelled ? "Verification cancelled" : `Verification stopped while ${STEP_WORDS[verification.failure.step]}: ${verification.failure.reason}`,
    failed: !verification.failure.cancelled,
  } : null;
  const line = launchLine({
    verb, phase: verification.phase, progress, charge, inFlight: model.inFlight, busy: model.busy, chaining: model.chaining, launching,
    machine: machine && { name: machine.name, online: machine.online, revoked: machine.revoked === true }, machineChosen: model.machineId !== "",
    rosterUnread: rosterError, otherMachine: other && { id: other.id, name: other.name },
    message: model.message ?? stoppedVerifying, outcome: model.outcome, stop: quota?.stop ?? null, fix: quota?.fix ?? null,
    differs: stopped !== null && stopped.review === model.launchReview ? stopped.differs : null,
    laneFix: verb.refusal?.code === "no-account" && slots && selection ? laneFix(slots.lane, selection) : null,
    nobodyServes: served !== null && served.size === 0, listFailure,
  }, vocab);
  const reviewed = model.launchReview && catalog ? {
    machine: machine?.name ?? model.launchReview.destination.machineId,
    pool: poolCounts(catalog, model.launchReview.composition.review.routes, model.launchReview.composition.accountPool),
  } : null;
  const launchSays = launchReadout({ verb, edits: saved && selection ? teamEdits(saved, selection, familyWord) : [], reviewed, grounded: quota?.grounded ?? false,
    launchStatus: model.launchStatus }, vocab);

  // ------------------------------------------------------------ the readout: a scrub, then a key's word, then the pointer, then focus
  function say(said: Said | null) {
    window.clearTimeout(keyTimer.current);
    setKeySaid(said);
    if (said) keyTimer.current = window.setTimeout(() => setKeySaid(null), KEY_SAID_MS);
  }
  function wordSaid(row: GeneratorRow, word: RowWord): Said {
    const value = row.kind === "switch" ? `${row.label} ${word.text}` : word.text;
    const lead = word.sub !== null ? [word.sub] : [];
    if (!word.available) return { value, text: [...lead, word.reason ?? ""].filter(Boolean).join(" · "), warn: true, color: null };
    const strain = quotaParts(word.quota, vocab);
    return {
      value, text: [...lead, word.says, ...strain.map(entry => entry.text)].filter(Boolean).join(" · "),
      warn: strain.some(entry => entry.tone === "attention" || entry.tone === "warn"), color: toneColor(word.tone),
    };
  }
  const rowOf = (rowId: RowId) => rows?.find(row => row.id === rowId) ?? null;
  const chosenSaid = (row: GeneratorRow | null) => {
    const word = row?.words.find(entry => entry.selected);
    return row && word ? wordSaid(row, word) : null;
  };
  function scrubSaid(): Said | null {
    if (!scrub) return null;
    const row = rowOf(scrub.row);
    if (!row) return null;
    if (scrub.refused) return wordSaid(row, scrub.refused);
    const now = chosenSaid(row);
    if (!now || !catalog || !controlsReview || !scrub.origin || sameTeam(scrub.origin.selection, controlsReview.selection)) return now;
    const lead = row.words.find(word => word.selected)?.sub;
    return { ...now, text: [lead, changeSentence(catalog, scrub.origin, controlsReview, familyWord)].filter(Boolean).join(" · "), warn: false };
  }
  function pointedSaid(): Said | null {
    if (!hovered) return null;
    if (hovered.kind === "launch") return { value: verb.label.toLowerCase(), text: launchSays.text, warn: launchSays.warn, color: null };
    if (hovered.kind === "meter") {
      const readout = estimates?.[hovered.name];
      if (!readout) return null;
      return { value: hovered.name, text: hovered.name === "cost" ? `${readout.word} · ${COST_NOTE}`
        : readout.level === null ? "unmeasured · verifying models measures it" : `${readout.word} · from measured throughput and first-token time`, warn: false, color: null };
    }
    const row = rowOf(hovered.row), word = row?.words.find(entry => entry.key === hovered.key);
    return row && word ? wordSaid(row, word) : null;
  }
  const said = scrubSaid() ?? keySaid ?? pointedSaid() ?? (focused ? chosenSaid(rowOf(focused)) : null);

  // ------------------------------------------------------------ commits, all through the edit gates
  function refuse(text: string, value: string) {
    announce(text);
    say({ value, text, warn: true, color: null });
  }
  function commitTeam(next: Selection, say: string, value: string): boolean {
    if (!selection) return false;
    if (!teamGate.open) { refuse(teamGate.refusal.text, value); return false; }
    const kind = commitKind(next, selection, model.record?.selection ?? null, model.localDraft?.source ?? null);
    if (kind === "none") return false;
    if (kind === "discard") model.actions.discardChanges();
    else model.actions.updateSelection(next);
    announce(say);
    return true;
  }
  function choose(row: GeneratorRow, word: RowWord, via: "pointer" | "keyboard" | "scrub") {
    const value = row.kind === "switch" ? `${row.label} ${word.text}` : word.text;
    if (row.id === "machine") {
      if (!machineGate.open) { refuse(machineGate.refusal.text, value); return; }
      selectMachine(word.key);
      announce(`Machine ${word.name}`);
    } else if (!word.option?.selection || !commitTeam(word.option.selection, `${word.name}${word.says ? `: ${word.says}` : ""}`, value)) return;
    // The keyboard says what it did where a pointer read it before choosing; a scrub says its whole way from where it began.
    if (via === "keyboard") say(wordSaid(row, word));
  }
  function refuseWord(row: GeneratorRow, word: RowWord, via: "pointer" | "keyboard" | "scrub") {
    if (word.available && !word.selected) {
      // Edits wait: the gate's reason, not the word's.
      const gate = row.id === "machine" ? machineGate : teamGate;
      if (!gate.open) refuse(gate.refusal.text, row.kind === "switch" ? `${row.label} ${word.text}` : word.text);
      return;
    }
    if (via === "scrub") setScrub(current => current && { ...current, refused: word });
    else say(wordSaid(row, word));
    if (via !== "scrub") announce(`${row.label} ${word.text}: ${word.reason ?? ""}`);
  }
  function resetTo(which: "defaults" | "saved") {
    if (!catalog || !selection || !controlsReview) return;
    const target = which === "defaults" ? defaultSelection(catalog) : saved;
    if (!target) return;
    const before = controlsReview;
    if (which === "saved") {
      if (!teamGate.open) { refuse(teamGate.refusal.text, which); return; }
      model.actions.discardChanges();
      announce("Back to the saved profile");
    } else if (!sameTeam(target, selection) && !commitTeam(target, "Defaults", which)) return;
    const after = previewSelection(catalog, target);
    say({ value: which, text: after && !sameTeam(target, selection) ? changeSentence(catalog, before, after, familyWord) : "no route changes", warn: false, color: null });
  }
  function focusRow(rowId: RowId) {
    setCursor(rowId);
    root.current?.querySelector<HTMLElement>(`[data-row="${rowId}"]`)?.focus();
  }
  function recall(index: number) {
    const team = recents[index];
    if (!team || !selection) return;
    if (sameTeam(team.selection, selection)) { announce(`Recent profile ${index + 1} is this profile`); return; }
    if (!teamGate.open) { announce(teamGate.refusal.text); return; }
    if (commitKind(team.selection, selection, model.record?.selection ?? null, model.localDraft?.source ?? null) === "discard") model.actions.discardChanges();
    else model.actions.recallTeam(team);
    const formed = catalog && previewSelection(catalog, team.selection);
    const strands = formed && strandsNote(catalog, formed.routes, pools, vocab);
    announce(`Recent profile ${index + 1}${strands ? ` · ${strands}` : ""}`);
  }
  function runFix(action: Extract<StatusAction, { kind: "fix" }>) {
    const fix: StatusFix = action.fix;
    switch (fix.kind) {
      case "team": commitTeam(fix.selection, action.label, action.label); return;
      case "machine":
        if (machineGate.open) { selectMachine(fix.machineId); announce(action.label); } else refuse(machineGate.refusal.text, action.label);
        return;
      case "open": onOpen(fix.place, fix.family); return;
      // A re-read reads everything the launch stands on, the machine list included.
      case "refresh": onRefresh(); return;
      case "discard": model.actions.discardChanges(); return;
    }
  }

  // ------------------------------------------------------------ the launch: Save & launch as one gesture
  function act() {
    setStopped(null);
    if (verb.launches && shown) { chain.current = { projection: projectionOf(shown, served), review: shown }; setLaunching(true); }
    model.actions.next();
  }
  /** The press: a refused one shakes and says why; one that runs plays its charge and check, and the team lights up. */
  function fire() {
    const button = launchButton.current;
    if (verb.opens) { onOpen(verb.opens); return; }
    const still = prefersReducedMotion();
    if (verb.state !== "ready") {
      if (!still) button?.animate([{ transform: "none" }, { transform: "translateX(-2px)" }, { transform: "translateX(2px)" }, { transform: "none" }], { duration: 260 });
      say({ value: verb.label.toLowerCase(), text: launchSays.text, warn: true, color: null });
      if (verb.refusal) announce(`${verb.label}: ${verb.refusal.text}`);
      return;
    }
    if (button && !still) {
      delete button.dataset.fired;
      void button.offsetWidth;
      button.dataset.fired = "";
      window.setTimeout(() => { delete button.dataset.fired; }, 1400);
    }
    say({ value: verb.label.toLowerCase(), text: launchSays.text, warn: false, color: null });
    rippleTeam(root.current?.closest<HTMLElement>("[data-tui]") ?? null);
    act();
  }
  function pressFromKeys() {
    const button = launchButton.current;
    if (!button || prefersReducedMotion()) { fire(); return; }
    button.dataset.pressing = "";
    window.setTimeout(() => { delete button.dataset.pressing; fire(); }, 160);
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

  // What the panel's keys ask of the pane, current on every render.
  const latest = { launch: pressFromKeys, defaults: () => resetTo("defaults"), saved: () => resetTo("saved"), recall,
    focusRows: () => focusRow(cursor),
    noChains: () => {
      focusRow("fallbacks");
      say({ value: "fallbacks off", text: "no chains to show", warn: true, color: null });
      const label = root.current?.querySelector<HTMLElement>(`[data-row="fallbacks"] .${G}dial-label`);
      if (label && !prefersReducedMotion()) label.animate([{ color: "var(--tui-dim)" }, { color: "var(--tui-acc)", offset: 0.4 }, { color: "var(--tui-dim)" }], { duration: 900, iterations: 2 });
    } };
  useLayoutEffect(() => { controls.current = latest; });

  // A launch-line control that leaves once pressed (a retry that clears its failure, a rescue taken) takes focus with
  // it to the page, where the panel's keys no longer reach; focus then goes to the launch, the pane's fixed point.
  const lineFocus = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const control = lineFocus.current;
    if (!control || control.isConnected) return;
    lineFocus.current = null;
    const focusNow = control.ownerDocument.activeElement;
    if (!focusNow || focusNow === control.ownerDocument.body) launchButton.current?.focus({ preventScroll: true });
  });

  // The label column is as wide as the widest label as rendered, whatever the font.
  useLayoutEffect(() => {
    const pane = root.current;
    if (!pane) return;
    const measure = () => {
      const widest = Math.max(0, ...[...pane.querySelectorAll<HTMLElement>(`.${G}dial-label`)].map(label => label.getBoundingClientRect().width));
      const narrow = pane.closest<HTMLElement>("[data-mode]")?.dataset.mode === "narrow";
      if (widest > 0) pane.style.setProperty("--labw", `${Math.ceil(widest) + (narrow ? 10 : 18)}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    let live = true;
    void pane.ownerDocument.fonts?.ready.then(() => { if (live) measure(); });
    return () => { live = false; observer.disconnect(); };
  }, [rows !== null]);

  // ------------------------------------------------------------ announcements: the charge, outcomes and failures, once each
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
  const lineId = `${id}-line`;
  const cursorRow = rows?.some(row => row.id === cursor) ? cursor : "lane";
  const pressing = (on: boolean) => () => { if (launchButton.current) { if (on) launchButton.current.dataset.pressing = ""; else delete launchButton.current.dataset.pressing; } };
  return <section ref={root} className={`${G}pane`} data-pane="generator" aria-label="generator" hidden={hidden}>
    <header className={`${G}head`}>
      <h2 className={`${G}title`}>generator</h2>
      <button type="button" className={`${G}cue`} onClick={() => resetTo("defaults")}><span className={`${G}cue-key`}>d</span> · defaults</button>
      {saved && <button type="button" className={`${G}cue`} onClick={() => resetTo("saved")}><span className={`${G}cue-key`}>z</span> · saved</button>}
    </header>
    <div className={`${G}dials`} role="group" aria-label="profile">
      {rows ? rows.map((row, index) => <DialRow key={row.id} row={row} cursor={row.id === cursorRow} locked={row.id === "machine" ? !machineGate.open : !teamGate.open}
        onCursor={() => setCursor(row.id)} onChoose={(word, via) => choose(row, word, via)} onRefuse={(word, via) => refuseWord(row, word, via)}
        onHover={word => setHovered(current => word ? { kind: "word", row: row.id, key: word.key } : current?.kind === "word" && current.row === row.id ? null : current)}
        onFocusChange={on => { setFocused(current => on ? row.id : current === row.id ? null : current); if (on) setCursor(row.id); }}
        onScrub={phase => {
          window.clearTimeout(scrubTimer.current);
          if (phase === "start") setScrub({ row: row.id, origin: controlsReview, refused: null });
          else scrubTimer.current = window.setTimeout(() => setScrub(null), SCRUB_SAID_MS);
        }}
        onMove={delta => { const next = rows[index + delta]; if (next) focusRow(next.id); }} />)
        : <p className={`${G}pane-note`}>{model.starterError ?? (reading ? "reading the profile" : "no profile to show")}</p>}
    </div>
    <div className={`${G}readout`} data-tone={said?.warn ? "warn" : undefined} style={said?.color ? { "--rc": said.color } as CSSProperties : undefined}>
      {said && <><b>{said.value}</b>{said.text && ` · ${said.text}`}</>}
    </div>
    {groups && <Profile groups={groups} />}
    <div className={`${G}genfoot`}>
      {estimates && <>
        <Meter name="cost" glyph="$" readout={estimates.cost} onPoint={on => setHovered(on ? { kind: "meter", name: "cost" } : null)} />
        <Meter name="speed" glyph="»" readout={estimates.speed} onPoint={on => setHovered(on ? { kind: "meter", name: "speed" } : null)} />
      </>}
      <div className={`${G}launchrow`}>
        <button ref={launchButton} type="button" className={`${G}launch`} data-state={verb.state} aria-disabled={verb.state !== "ready" || undefined}
          aria-busy={verb.state === "busy" || undefined} aria-describedby={lineId} title={verb.refusal ? verb.refusal.text : withKey(verb.label, LAUNCH_STROKE)}
          onPointerDown={event => { if (event.button === 0) pressing(true)(); }} onPointerUp={pressing(false)} onPointerCancel={pressing(false)}
          onPointerEnter={() => setHovered({ kind: "launch" })} onPointerLeave={() => { pressing(false)(); setHovered(null); }} onClick={fire}>
          <Glyph className={`${G}launch-glyph`} path={ENTER} />
          <Glyph className={`${G}launch-check`} path={CHECK} />
          <span className={`${G}launch-label`}>{verb.label.toLowerCase()}</span>
          <i className={`${G}launch-charge`} aria-hidden="true" />
        </button>
        <span id={lineId} className={`${G}launch-line`} onFocus={event => { lineFocus.current = event.target; }}
          onBlur={event => { if (event.relatedTarget) lineFocus.current = null; }}>
          {line ? <LaunchLine line={line} canConfirm={verification.canConfirm} onConfirm={detail => charge && model.actions.confirmCharge({ detail, repeat: false }, charge)}
            onCancel={verification.cancel} onFix={runFix} />
            : optionsSummary && <button type="button" className={`${G}cue`} onClick={() => onOpen("options")}><span className={`${G}cue-key`}>o</span> · {optionsSummary}</button>}
        </span>
      </div>
    </div>
  </section>;
}

/**
 * One estimate: its name and five glyphs, lit to its level in the lane's accent; a speed nothing
 * measures stays unlit. Glyphs light and go out one after another, and one that lights pops once.
 */
function Meter({ name, glyph, readout, onPoint }: { name: string; glyph: string; readout: EstimateReadout; onPoint: (on: boolean) => void }) {
  const box = useRef<HTMLSpanElement>(null);
  const lit = readout.level ?? 0;
  const before = useRef(lit);
  const previous = before.current;
  useLayoutEffect(() => {
    const was = before.current;
    before.current = lit;
    if (lit <= was || prefersReducedMotion()) return;
    [...box.current?.children ?? []].forEach((cell, index) => {
      if (index >= was && index < lit) cell.animate([{ transform: "none" }, { transform: "translateY(-2px) scale(1.3)" }, { transform: "none" }], { duration: 320, delay: (index - was) * 50, easing: "cubic-bezier(.2, .8, .2, 1)" });
    });
  }, [lit]);
  return <div className={`${G}meter`} role="meter" aria-label={name} aria-valuemin={0} aria-valuemax={5} aria-valuenow={lit} aria-valuetext={readout.word}
    data-unmeasured={readout.level === null || undefined} onPointerEnter={() => onPoint(true)} onPointerLeave={() => onPoint(false)}>
    <span className={`${G}meter-label`}>{name}</span>
    <span ref={box} className={`${G}glyphs`} aria-hidden="true">{[0, 1, 2, 3, 4].map(index => <i key={index} data-lit={index < lit || undefined}
      style={{ transitionDelay: `${Math.max(0, lit >= previous ? (index - previous) * 50 : (previous - 1 - index) * 50)}ms` }}>{glyph}</i>)}</span>
  </div>;
}

/**
 * The line beside the launch: Confirm charge first when it carries it (the next Tab stop after the
 * launch), then its facts, which give way to an ellipsis, then its fixes and cancel as cues; a fix
 * that opens a place answers to that place's key too.
 */
function LaunchLine({ line, canConfirm, onConfirm, onCancel, onFix }: {
  line: StatusLine; canConfirm: boolean; onConfirm: (detail: number) => void; onCancel: () => void; onFix: (action: Extract<StatusAction, { kind: "fix" }>) => void;
}) {
  const text = line.parts.map(entry => entry.text).join(" · ");
  const confirm = line.actions.find(action => action.kind === "confirm");
  return <>
    {confirm && <button type="button" className={`${G}confirm`} aria-label={`Confirm charge: ${confirm.requests} ${confirm.requests === 1 ? "request" : "requests"}`}
      aria-disabled={!canConfirm || undefined} onClick={event => onConfirm(event.detail)}
      onKeyDown={event => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }}>confirm charge</button>}
    {line.parts.length > 0 && <span className={`${G}launch-facts`} title={text}>
      {line.parts.map((entry, index) => <span key={index} className={`${G}launch-part`} data-tone={entry.tone}>{entry.text}</span>)}
    </span>}
    {line.actions.map(action => {
      if (action.kind === "cancel") return <button key="cancel" type="button" className={`${G}cue`} onClick={onCancel}>cancel</button>;
      if (action.kind !== "fix") return null;
      const key = action.fix.kind === "open" ? FIX_KEYS[action.fix.place] : action.fix.kind === "refresh" ? FIX_KEYS.refresh : undefined;
      return <button key={action.key} type="button" className={`${G}cue`} data-fix={action.key} onClick={() => onFix(action)}>
        {key && <><span className={`${G}cue-key`}>{key}</span> · </>}{action.label}
      </button>;
    })}
  </>;
}
