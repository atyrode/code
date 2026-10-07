import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import type { MachineSummary } from "@manifold/protocol";
import { prefersReducedMotion, ScrollRegion } from "@manifold/ui";
import { quotaPools } from "../../domain/quota.ts";
import { GENERATOR_PLUGIN_ID, LAUNCHER_PANEL, type Target } from "../contract.ts";
import { useCodeTarget, type OmpPresence } from "../machine-web.ts";
import { AccountsView } from "../accounts-view.tsx";
import { PermissionReview } from "../permission-review.tsx";
import { Button, familyWord, hueOf, SheetFrame } from "../ui.tsx";
import { displayAliases } from "./aliases.ts";
import { modelListFailure } from "./board-model.ts";
import { AccountsPane } from "./accounts-pane.tsx";
import { CatalogWorkbench } from "./catalog-editor.tsx";
import { EarlierStatements, usePinnedRecents } from "./earlier.tsx";
import type { StatementWords } from "./earlier-model.ts";
import { GeneratorPane, PANEL_VOCABULARY, type GeneratorControls, type GeneratorPlace, type LaunchState } from "./generator-pane.tsx";
import { acceleratorFor, panelKey, type PanelAction, type PanelSheet, type PanelView } from "./panel-keys.ts";
import { routeLedger } from "./routing-model.ts";
import { RoutingPane } from "./routing-pane.tsx";
import { RuntimeSettings } from "./runtime-settings.tsx";
import { OptionalSkills } from "./skills.tsx";
import { Automation } from "./automation.tsx";
import { OptionSwitch } from "./option-switch.tsx";
import { teamWords, type SlotOption } from "./statement-model.ts";
import { UsagePane, useUsageCadence } from "./usage-pane.tsx";
import { readHeld } from "./auto-read.ts";
import { MoreMenu, type MenuCommand } from "./more-menu.tsx";
import { usePanelReads, usePanelShown } from "./read-clock.ts";
import { useWorkbench } from "./workbench-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
const PANEL_ROOT = ".plugin-atyrode_code_generator";
const SHEET_TITLES: Readonly<Record<PanelSheet, string>> = { models: "Models", setup: "Setup", options: "Session options" };
/** Exclusion reasons in plain words, for the last verification's details in Setup. */
const EXCLUSION_WORDS: Readonly<Record<string, string>> = {
  superseded: "Superseded by a newer model", unstable_id: "Unstable id", not_found: "Not found through your accounts",
  client_blocked: "Blocked for this client", regression: "Worse than a cheaper tier", separate_quota: "Draws a quota of its own, which Code does not spend",
};
const NO_WORDS: StatementWords = { lane: "", tier: "", thinking: "", advisor: "", extras: "", machine: "" };
/** Below this panel width the generator stands alone, routing and usage a key away; from the second, the wide proportions. */
const NARROW_BELOW_PX = 760, WIDE_FROM_PX = 1180;
type Mode = "narrow" | "medium" | "wide";

/** One polite live region, mounted empty; an identical message is announced again because its node is replaced. */
function useAnnouncer(): { region: ReactElement; announce: (text: string) => void } {
  const [message, setMessage] = useState({ text: "", serial: 0 });
  const announce = useCallback((text: string) => setMessage(previous => ({ text, serial: previous.serial + 1 })), []);
  const region = <div className="plugin-atyrode_code__sr" role="status" aria-live="polite" aria-atomic="true">
    <span key={message.serial}>{message.text}</span>
  </div>;
  return { region, announce };
}

/** The nearest scrolling ancestor: the ScrollRegion viewport, whose scroll position the stage keeps across sheets. */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/**
 * The layout the panel's own width allows, judged before paint and on every resize: the panel, not
 * the window, since Code shares the window with its canvas. The first layout and every resize place
 * things without motion (`data-boot`), so nothing glides into its place on arrival.
 */
function useMode(app: RefObject<HTMLDivElement | null>): Mode {
  const [mode, setMode] = useState<Mode>("wide");
  useLayoutEffect(() => {
    const node = app.current;
    if (!node) return;
    node.dataset.boot = "";
    let booted = false, frame = 0;
    const judge = () => {
      const width = node.clientWidth;
      if (width > 0) setMode(width < NARROW_BELOW_PX ? "narrow" : width < WIDE_FROM_PX ? "medium" : "wide");
    };
    judge();
    const settle = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { delete node.dataset.boot; }); }); };
    const observer = new ResizeObserver(() => {
      if (booted) node.dataset.boot = "";
      judge();
      if (booted) settle();
    });
    observer.observe(node);
    let live = true;
    void node.ownerDocument.fonts.ready.then(() => { if (!live) return; booted = true; settle(); });
    return () => { live = false; cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);
  return mode;
}

/** The keys that can open a view tab: Esc goes back to the generator, or from Manage accounts to the accounts. */
const TAB_KEYS = ["Escape", "a", "e", "p", "s"] as const;

/** Every key the panel answers, grouped by the view it acts in (panel-keys.ts); the key line names only the most used. */
const SHORTCUTS: readonly { readonly title: string; readonly keys: readonly (readonly [key: string, does: string])[] }[] = [
  { title: "Generator", keys: [["↑ ↓", "Move between the rows"], ["← →", "Change the row's value"], ["Home End", "The row's first or last value"],
    ["Space", "Turn fallbacks on or off"], ["⏎", "The launch: verify, save, review or launch"], ["Mod ⏎", "The launch, from anywhere in the view"],
    ["d", "Defaults"], ["z", "Back to the saved profile"], ["f", "Show or hide the fallback chains, here or in Routing"], ["w", "Choose the machine"],
    ["m", "Models"], ["u", "Setup"], ["o", "Session options"]] },
  { title: "Views", keys: [["a", "Accounts, or back to the generator"], ["e", "Sessions, or back to the generator"],
    ["p", "Routing: hide or show it beside the generator, or open it when narrow"], ["s", "Usage: hide or show it beside the generator, or open it when narrow"],
    ["Esc", "Back to the generator; from Manage accounts, back to the accounts"]] },
  { title: "Accounts", keys: [["↑ ↓", "Move between the accounts"], ["Space", "Include or exclude the account"], ["m", "Manage accounts: pools, sign-in, credentials"]] },
  { title: "Sessions", keys: [["1–9", "Recall the recent profile with that number"]] },
  { title: "Anywhere", keys: [["r", "Refresh now: read everything again at once, as the panel also does on its own"], ["?", "These shortcuts"]] },
];

/** The keyboard shortcuts, in a native modal dialog: Esc or its Close button closes it, and it owns its keys while open. */
function ShortcutsDialog({ dialog, narrow }: { dialog: RefObject<HTMLDialogElement | null>; narrow: boolean }) {
  return <dialog ref={dialog} className={`${G}shortcuts`} aria-labelledby="code-shortcuts-title" data-narrow={narrow || undefined}
    onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className={`${G}shortcuts-head`}>
      <h2 id="code-shortcuts-title" className={`${G}title`}>Keyboard shortcuts</h2>
      <Button autoFocus onClick={() => dialog.current?.close()}>Close</Button>
    </div>
    {SHORTCUTS.map(group => <section key={group.title} className={`${G}shortcuts-group`} aria-label={group.title}>
      <h3 className={`${G}shortcuts-title`}>{group.title}</h3>
      <dl className={`${G}shortcuts-list`}>{group.keys.map(([key, does]) => <Fragment key={key + does}><dt><kbd>{key}</kbd></dt><dd>{does}</dd></Fragment>)}</dl>
    </section>)}
  </dialog>;
}

type WorkbenchProps = {
  host: HostServices; target: Target | null; machine: MachineSummary | null; machines: readonly MachineSummary[] | null; machineId: string | null;
  rosterError: string | null; available: boolean; select: (id: string) => void; refreshMachines: () => void; presence: ReadonlyMap<string, OmpPresence> | null;
};

/**
 * The panel as the terminal UI had it, evolved for the web: the generator's rows with routing
 * beside them and usage under both when there is room, a key line at the foot, and the accounts and
 * the sessions one key away; under the accounts, their management (sign-in, presets, credentials).
 * Under 760px the generator stands alone, the team grouped under its rows, routing and usage each a
 * key away. Models, Setup and the session options open as sheets over the stage.
 */
function Workbench({ host, target, machine, machines, machineId, rosterError, available, select, refreshMachines, presence }: WorkbenchProps) {
  const model = useWorkbench({ host, target, machine, rosterError, available });
  const { queries: { metadata, setup, skillCatalog }, record, observed, starterError, compiled, selection, profile, localDraft,
    configurationCurrent, launchReady, launchReview, busy, writable, verification, usage, exportedDraft, actions } = model;
  const recents = usePinnedRecents(model.recentTeams);
  const { region, announce } = useAnnouncer();
  const app = useRef<HTMLDivElement>(null);
  const generator = useRef<GeneratorControls | null>(null);
  const mode = useMode(app);
  const narrow = mode === "narrow";
  const [view, setView] = useState<PanelView>("main");
  const viewRef = useRef(view);
  viewRef.current = view;
  const [hidden, setHidden] = useState({ routing: false, usage: false });
  const [chains, setChains] = useState(false);
  const shortcuts = useRef<HTMLDialogElement>(null);
  // The launch as the generator names it, for the key line and the accounts view's foot.
  const [launch, setLaunch] = useState<LaunchState>({ label: "", ready: false, reason: null });
  // The profile switches the generator keeps outside its rows, which the session options sheet draws.
  const [extras, setExtras] = useState<readonly SlotOption[]>([]);
  // Bumped by every read of the usage, by the clock or by a press, so the sessions view reads again the machines it has read.
  const [rereads, setRereads] = useState(0);
  // The accounts' management stays mounted once opened, so a preset draft survives a look back at the accounts.
  const [managed, setManaged] = useState(false);
  // Whether that management holds a saved pool draft, as it says itself: asked when a read comes due.
  const presetDraft = useRef(false);
  const [sheet, setSheet] = useState<PanelSheet | null>(null);
  const [visited, setVisited] = useState<readonly PanelSheet[]>([]);
  const backButtons = useRef<Partial<Record<PanelSheet, HTMLButtonElement | null>>>({});
  const returnFocus = useRef<HTMLElement | null>(null);
  const stageScroll = useRef(0);
  const currentSheet = useRef(sheet);
  currentSheet.current = sheet;
  // The roster is polled; what reads it is recomputed only when it really changes.
  const machinesKey = JSON.stringify(machines);
  const roster = useMemo(() => machines, [machinesKey]);
  const line = useMemo<StatementWords>(() => selection ? { ...teamWords(selection, familyWord), machine: machine?.name ?? "" } : NO_WORDS,
    [selection, machine?.name]);

  // ------------------------------------------------------------ one quota truth and one routing for every pane
  const pools = useMemo(() => compiled ? quotaPools(compiled, { view: usage.view, current: usage.current, nowMs: usage.nowMs }) : [],
    [compiled, usage.view, usage.current, usage.nowMs]);
  const shown = model.review ?? model.controlsReview;
  const aliases = useMemo(() => compiled && displayAliases(compiled), [compiled]);
  const ledger = useMemo(() => compiled && shown && aliases ? routeLedger(compiled, shown, aliases, pools, PANEL_VOCABULARY) : null,
    [compiled, shown, aliases, pools]);
  // A lane is hidden only while its family has no signed-in account at all; with none signed in anywhere, every lane shows.
  const connected = useMemo(() => {
    const view = usage.view;
    if (!view || view.accountsStatus === "unavailable") return null;
    const families = view.providers.flatMap(group => group.accounts.length && group.family ? [group.family] : []);
    return families.length ? new Set(families) : null;
  }, [usage.view]);
  const fallbacks = selection?.fallback ?? false;
  // The bundled list's failure is said in the launch line, with its retry and Models, whatever else it says.
  const listFailure = modelListFailure(Boolean(metadata.error || starterError), Boolean(record?.active), model.document !== null);
  const lane = selection?.lane;
  const accent = !lane || lane.kind === "mixed" ? "var(--tui-mixed)" : `var(--code-${hueOf(lane.family)})`;

  // ------------------------------------------------------------ views and sheets
  const showRouting = (view === "main" && !narrow && !hidden.routing) || view === "routing";
  const showUsage = (view === "main" && !narrow && !hidden.usage) || view === "usage";
  function changeView(next: PanelView) {
    if (next !== view) setView(next);
  }
  // A width that brings routing and usage back beside the generator closes them as views of their own.
  useEffect(() => { if (!narrow && (view === "routing" || view === "usage")) setView("main"); }, [narrow]);
  // A pane that comes into view slides in; one that leaves simply goes.
  const shownPanes = useRef<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    const node = app.current;
    if (!node) return;
    const panes = [...node.querySelectorAll<HTMLElement>("[data-pane]")].filter(pane => !pane.hidden);
    const now = new Set(panes.map(pane => pane.dataset.pane!));
    if (shownPanes.current.size && node.dataset.boot === undefined && !prefersReducedMotion()) {
      for (const pane of panes) if (!shownPanes.current.has(pane.dataset.pane!)) {
        pane.animate([{ opacity: 0, transform: "translateX(10px)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: "cubic-bezier(.2, .8, .2, 1)" });
      }
    }
    shownPanes.current = now;
  });

  function openSheet(next: PanelSheet) {
    if (!currentSheet.current) {
      returnFocus.current = app.current?.ownerDocument.activeElement as HTMLElement | null;
      stageScroll.current = scrollParent(app.current)?.scrollTop ?? 0;
    }
    setSheet(next);
    setVisited(previous => previous.includes(next) ? previous : [...previous, next]);
    refresh();
  }
  function closeSheet() {
    setSheet(null);
    refresh();
  }
  const sheetChanged = useRef(sheet);
  useLayoutEffect(() => {
    const closed = sheetChanged.current;
    if (closed === sheet) return;
    sheetChanged.current = sheet;
    const scroller = scrollParent(app.current);
    if (sheet) {
      if (scroller) scroller.scrollTop = 0;
      const back = backButtons.current[sheet];
      back?.focus({ preventScroll: true });
      const frame = back?.closest<HTMLElement>(".plugin-atyrode_code__sheet");
      if (frame && !prefersReducedMotion()) frame.animate([{ transform: "translateX(24px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 160, easing: "cubic-bezier(.2, 0, 0, 1)" });
      return;
    }
    if (scroller) scroller.scrollTop = stageScroll.current;
    // Focus returns to what opened the sheet (a key line word, a launch-line fix), judged now that the stage shows
    // again; one that has since gone gives way to the generator's rows.
    const opener = returnFocus.current;
    if (opener?.isConnected && opener.offsetParent !== null) opener.focus({ preventScroll: true });
    else generator.current?.focusRows();
  }, [sheet]);
  function finish(source: PanelSheet) {
    if (currentSheet.current === source) closeSheet();
    else refresh();
  }
  function sheetKeys(event: KeyboardEvent<HTMLDivElement>) {
    const element = event.target as HTMLElement;
    // Native dialogs and form fields own Escape inside legacy sheet content.
    if (event.key !== "Escape" || event.defaultPrevented || element.closest("dialog") || element.matches("textarea, input, select")) return;
    event.preventDefault();
    closeSheet();
  }
  /** Where a launch-line fix sends the person: a sheet, or the accounts view. */
  function open(place: GeneratorPlace) {
    if (place === "accounts") changeView("accounts");
    else openSheet(place);
  }

  // ------------------------------------------------------------ reading again: on its own (auto-read.ts), and Refresh now (`r`)
  /** Everything the panel stands on, read again in one pass, both clocks restarted: Refresh now, `r`, and a sheet's open or close. */
  function refresh() {
    reads.now();
  }
  const teamGate = model.gate("edit-team");
  const visible = usePanelShown(app);
  // When the person last pressed a key or the pointer in the panel: a read on its own waits a few seconds after.
  const inputAt = useRef(0);
  /**
   * Whether the person is in the middle of something a read on its own must not interrupt: a step
   * that runs or a charge that waits, a sheet, the shortcuts or a popup (the More menu, the machine
   * list) open, a row being scrubbed, a text field in use, an account change saving, a profile edit or
   * a saved pool draft left unsaved, or a press a moment ago. Asked when a read comes due, so it reads
   * the latest render and the DOM.
   */
  const held = () => {
    const node = app.current, focused = node?.ownerDocument.activeElement ?? null;
    return readHeld({
      step: !teamGate.open,
      open: sheet !== null || shortcuts.current?.open === true || node?.querySelector("[data-popover]") != null,
      editing: node?.querySelector("[data-dragging]") != null || usage.accounts?.pending === true
        || (focused !== null && node?.contains(focused) === true && focused.matches("textarea, input, select, [contenteditable]")),
      unsaved: model.edited || presetDraft.current,
      inputAt: inputAt.current,
    }, Date.now());
  };
  // What each read is (auto-read.ts `PASS_READS`): the workbench's inputs once a minute and when the panel shows again, the usage
  // and the sessions already read on the usage line's cadence, and all of it in one pass at a press.
  const reads = usePanelReads({
    configuration: model.queries.configuration.refresh, metadata: metadata.refresh, setup: setup.refresh, defaults: model.queries.defaults.refresh,
    skills: skillCatalog.refresh, accounts: model.queries.accounts.refresh, machines: refreshMachines,
    usage: actions.readUsage, sessions: () => setRereads(count => count + 1),
  }, visible, held);
  const cadence = useUsageCadence(usage, reads);
  // The accounts' own edits wait while a step runs or a charge waits, as the switches do; read-only, the view says itself.
  const accountsGate = model.gate("edit-accounts");
  const accountsLocked = !accountsGate.open && (accountsGate.refusal.code === "running" || accountsGate.refusal.code === "charge") ? accountsGate.refusal.text : null;

  // ------------------------------------------------------------ session options: for one launch or resume, never saved
  const chosenSkills = model.skillChoice?.mode === "select" ? model.skillChoice.skillIds.length + model.skillChoice.setIds.length : 0;
  const staged = model.record?.active != null && model.record.draft != null;
  const optionsSummary = model.automation ? "restricted" : model.skillChoice?.mode === "disabled" ? "skills off"
    : model.skillChoice?.mode === "select" ? `${chosenSkills} ${chosenSkills === 1 ? "skill" : "skills"}` : null;
  // The options wait while a step runs or a charge waits, as the profile's rows do, and need what a launch needs: write access and the machine.
  const optionsGate = model.gate("edit-options");
  const optionsRefusal = !optionsGate.open ? optionsGate.refusal.text : !writable ? "Edit access needed." : !available ? "The machine is unavailable."
    : busy ? "Wait for the step in progress." : null;

  // ------------------------------------------------------------ keys: panel-local, decided by panelKey
  /**
   * A key or a key-line word that changes what shows keeps focus in the panel: a view that took no
   * focus of its own on arrival (the accounts view focuses its first switch) is focused itself, and
   * the main view hands focus to the row the keyboard was last on. Focus left on a hidden control
   * would drop to the page, where the panel's keys no longer reach.
   */
  function keepFocus() {
    requestAnimationFrame(() => {
      const node = app.current, shown = viewRef.current;
      if (!node) return;
      const active = node.ownerDocument.activeElement;
      const pane = node.querySelector<HTMLElement>(`[data-pane="${shown === "main" ? "generator" : shown}"]`);
      if (active && pane?.contains(active) && (active as HTMLElement).offsetParent !== null) return;
      if (shown === "main") generator.current?.focusRows();
      else pane?.focus({ preventScroll: true });
    });
  }
  function run(action: PanelAction): boolean {
    if (action.kind === "view" || action.kind === "back" || action.kind === "toggle") keepFocus();
    switch (action.kind) {
      case "launch": generator.current?.launch(); return true;
      case "defaults": generator.current?.defaults(); return true;
      case "saved": generator.current?.saved(); return true;
      case "chains":
        if (fallbacks) setChains(shown => !shown);
        else if (view === "main") generator.current?.noChains();
        return true;
      case "toggle": setHidden(previous => ({ ...previous, [action.pane]: !previous[action.pane] })); return true;
      case "view":
        if (action.view === "manage") setManaged(true);
        changeView(action.view);
        return true;
      case "back": changeView("main"); return true;
      case "refresh": cadence.now(); return true;
      case "machine": generator.current?.machines(); return true;
      case "shortcuts": shortcuts.current?.showModal(); return true;
      case "sheet": openSheet(action.sheet); return true;
      case "recall": generator.current?.recall(action.index); return true;
      case "enter":
        if (view === "main") generator.current?.focusRows();
        else app.current?.querySelector<HTMLElement>(`[data-pane="${view}"] :is(button, [tabindex="0"]):not([aria-disabled="true"])`)?.focus();
        return true;
    }
  }
  const keys = useRef<(event: globalThis.KeyboardEvent) => void>(() => {});
  keys.current = event => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const panel = app.current?.closest<HTMLElement>(PANEL_ROOT) ?? null;
    const onRoot = target !== null && target === panel;
    const action = panelKey({
      key: event.key, mod: event.ctrlKey || event.metaKey, alt: event.altKey, repeat: event.repeat, defaultPrevented: event.defaultPrevented,
      inView: sheet === null && target !== null && (onRoot || app.current?.contains(target) === true),
      inField: target?.matches("textarea, input, select, [contenteditable]") ?? false,
      inDialog: target?.closest("[role=dialog], dialog, [data-popover]") != null,
      onControl: target?.closest("button, a, [role=listbox], [role=option]") != null,
      onRoot, view, narrow, recents: recents.length,
    });
    if (action && run(action)) { event.preventDefault(); event.stopPropagation(); }
  };
  useEffect(() => {
    const panel = app.current?.closest<HTMLElement>(PANEL_ROOT);
    if (!panel) return;
    const listener = (event: globalThis.KeyboardEvent) => keys.current(event);
    const input = () => { inputAt.current = Date.now(); };
    panel.addEventListener("keydown", listener);
    panel.addEventListener("keydown", input, true);
    panel.addEventListener("pointerdown", input, true);
    // The panel root takes focus when the panel opens, so its keys work at once; never from another control.
    const focused = panel.ownerDocument.activeElement;
    if (!focused || focused === panel.ownerDocument.body) panel.focus({ preventScroll: true });
    return () => {
      panel.removeEventListener("keydown", listener);
      panel.removeEventListener("keydown", input, true);
      panel.removeEventListener("pointerdown", input, true);
    };
  }, []);

  // ------------------------------------------------------------ the bar, the pane heads and the key line: every action a control, keys its accelerators
  // A control names its key only where the panel's key rules give that key its action in the shown view (panel-keys.ts).
  const keyed = (title: string, keys: readonly string[], does: (action: PanelAction) => boolean) => {
    const key = acceleratorFor(view, narrow, keys, does);
    return { "aria-keyshortcuts": key ?? undefined, title: key === null ? title : `${title} (${key === "Escape" ? "Esc" : key})` };
  };
  const tab = (to: PanelView, label: string) => {
    const selected = view === to || (to === "accounts" && view === "manage");
    return <button key={to} type="button" role="tab" className={`${G}tab`} aria-selected={selected}
      {...keyed(label, TAB_KEYS, action => action.kind === "back" ? to === "main" : action.kind === "view" && action.view === to)}
      tabIndex={selected ? 0 : -1} data-view-tab={to} onClick={() => run({ kind: "view", view: to })}>{label}</button>;
  };
  /** The tabs answer ←/→ among themselves, as a tab list does. */
  function tabKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    const at = tabs.indexOf(event.target as HTMLButtonElement);
    tabs[(at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]?.focus();
    event.preventDefault();
    event.stopPropagation();
  }
  const menuKey = (keys: readonly string[], does: (action: PanelAction) => boolean) => acceleratorFor(view, narrow, keys, does);
  const isSheet = (sheet: PanelSheet) => (action: PanelAction) => action.kind === "sheet" && action.sheet === sheet;
  // A staged model list beside the active one changes nothing until it is reviewed in Models; More and its Models item say it waits there.
  const commands: readonly MenuCommand[] = [
    { id: "models", label: "Models", aside: staged ? "staged" : null, staged, accelerator: menuKey(["m"], isSheet("models")),
      title: staged ? "Models: a staged model list waits for review" : "Models", onSelect: () => run({ kind: "sheet", sheet: "models" }) },
    { id: "setup", label: "Setup", aside: null, accelerator: menuKey(["u"], isSheet("setup")), title: "Setup", onSelect: () => run({ kind: "sheet", sheet: "setup" }) },
    { id: "options", label: "Options", aside: optionsSummary, accelerator: menuKey(["o"], isSheet("options")), title: "Session options",
      onSelect: () => run({ kind: "sheet", sheet: "options" }) },
    { id: "shortcuts", label: "Shortcuts", aside: null, accelerator: menuKey(["?"], action => action.kind === "shortcuts"), title: "Keyboard shortcuts", dialog: true,
      onSelect: () => run({ kind: "shortcuts" }) },
  ];
  const bar = <nav className={`${G}bar`} aria-label="Code">
    <div className={`${G}tabs`} role="tablist" aria-label="views" onKeyDown={tabKeys}>
      {tab("main", "Generator")}
      {narrow && tab("routing", "Routing")}
      {narrow && tab("usage", "Usage")}
      {tab("accounts", "Accounts")}
      {tab("sessions", "Sessions")}
    </div>
    <MoreMenu commands={commands} />
  </nav>;
  const hideButton = (pane: "routing" | "usage") => !narrow && <Button aria-keyshortcuts={pane === "routing" ? "p" : "s"} title={`Hide ${pane} (${pane === "routing" ? "p" : "s"})`}
    onClick={() => run({ kind: "toggle", pane })}>Hide</Button>;
  // The short key line: the keys the shown view answers most, every other one under Shortcuts. Hidden for a coarse pointer, which has no keys.
  const viewKeys: readonly (readonly [string, string])[] = view === "main"
    ? [["↑↓", "move"], ["←→", "change"], ["⏎", launch.label.toLowerCase() || "launch"], ["a", "accounts"], ["e", "sessions"]]
    : view === "accounts" ? [["↑↓", "move"], ["space", "include"], ["m", "manage"], ["esc", "generator"]]
    : view === "manage" ? [["esc", "accounts"]]
    : view === "sessions" && recents.length > 0 ? [["↑↓", "move"], [`1–${Math.min(9, recents.length)}`, "recall"], ["esc", "generator"]]
    : [["esc", "generator"]];
  const keyLine = [...viewKeys, ["?", "shortcuts"] as const]
    .map(([key, word], index) => <Fragment key={key}>
      {index > 0 && <span className={`${G}keys-sep`} aria-hidden="true">•</span>}
      <span className={`${G}keys-word`}><span className={`${G}keys-key`}>{key}</span>{word}</span>
    </Fragment>);

  // ------------------------------------------------------------ the stage
  const tui = <div ref={app} className={`${G}tui`} data-tui="" data-mode={mode} data-view={view} data-solo-generator={(view === "main" && !showRouting) || undefined}
    data-solo={view === "routing" || view === "usage" || undefined} hidden={sheet !== null} style={{ "--tui-acc": accent } as CSSProperties}>
    <h1 className="plugin-atyrode_code__sr">Code</h1>
    {bar}
    <main className={`${G}stage`}>
      <GeneratorPane model={model} pools={pools} machines={roster} presence={presence} selectMachine={select} recents={recents} connected={connected} ledger={ledger} shown={shown}
        profile={!showRouting} hidden={view !== "main"} listFailure={listFailure} announce={announce} onOpen={open}
        onRefresh={refresh} onLaunchState={setLaunch} onExtras={setExtras} controls={generator}
        reveal={!narrow && (hidden.routing || hidden.usage) ? <>
          {hidden.routing && <Button aria-keyshortcuts="p" title="Show routing (p)" onClick={() => run({ kind: "toggle", pane: "routing" })}>Show routing</Button>}
          {hidden.usage && <Button aria-keyshortcuts="s" title="Show usage (s)" onClick={() => run({ kind: "toggle", pane: "usage" })}>Show usage</Button>}
        </> : null} />
      <RoutingPane ledger={ledger} chains={chains} fallbacks={fallbacks} onChains={() => run({ kind: "chains" })} hide={hideButton("routing")} hidden={!showRouting} />
      <section className={`${G}pane`} data-pane="usage" aria-label="usage" hidden={!showUsage} tabIndex={-1}>
        <header className={`${G}head`}>
          <h2 className={`${G}title`}>usage</h2>
          {hideButton("usage")}
        </header>
        <UsagePane usage={usage} cadence={cadence} />
      </section>
      <section className={`${G}pane`} data-pane="accounts" aria-label="accounts" hidden={view !== "accounts"} tabIndex={-1}>
        <header className={`${G}head`}>
          <h2 className={`${G}title`}>accounts</h2>
          <Button aria-keyshortcuts="m" title="Pools, sign-in and credentials (m)" data-manage="" onClick={() => run({ kind: "view", view: "manage" })}>Manage accounts</Button>
        </header>
        {/* Mounted only while it shows: opening puts focus on its first switch that can move. */}
        {view === "accounts" && <AccountsPane usage={usage} cadence={cadence} onManage={() => run({ kind: "view", view: "manage" })} />}
      </section>
      <section className={`${G}pane`} data-pane="manage" aria-label="manage accounts" hidden={view !== "manage"} tabIndex={-1}>
        <header className={`${G}head`}>
          <h2 className={`${G}title`}>manage accounts</h2>
          <Button aria-keyshortcuts="Escape" title="Back to the accounts (Esc)" onClick={() => run({ kind: "view", view: "accounts" })}>Back to accounts</Button>
        </header>
        {managed && <div className={`${G}legacy`}><AccountsView host={host} target={target} available={available} locked={accountsLocked}
          onDraft={drafting => { presetDraft.current = drafting; }} /></div>}
      </section>
      <section className={`${G}pane`} data-pane="sessions" aria-label="sessions" hidden={view !== "sessions"} tabIndex={-1}>
        <header className={`${G}head`}><h2 className={`${G}title`}>sessions</h2></header>
        <div className={`${G}earlier`}>
          <EarlierStatements host={host} model={model} line={line} recents={recents} pools={pools} onRecall={index => generator.current?.recall(index)}
            rereads={rereads} announce={announce} />
        </div>
      </section>
    </main>
    <footer className={`${G}keys`} aria-label="keys">
      <span className={`${G}keys-line`}>{keyLine}</span>
    </footer>
    <ShortcutsDialog dialog={shortcuts} narrow={narrow} />
  </div>;

  const sheetFrame = (name: PanelSheet, body: ReactNode) => visited.includes(name) && <div key={name} className={`${G}sheet-host`} hidden={sheet !== name} onKeyDown={sheetKeys}>
    <SheetFrame name={SHEET_TITLES[name]} onBack={closeSheet} backRef={element => { backButtons.current[name] = element; }}>
      {/* Session options is in the panel's grammar; Models and Setup keep their original layout until their own pass. */}
      <div className={name === "options" ? `${G}options` : `${G}legacy`}>{body}</div>
    </SheetFrame>
  </div>;

  return <>
    {region}
    {tui}
    {sheetFrame("models", <CatalogWorkbench host={host} target={target} available={available} onDone={() => finish("models")} />)}
    {sheetFrame("setup", <>
      <RuntimeSettings host={host} target={target} available={available} onDone={() => finish("setup")} />
      {record?.active && !launchReady && <div className={`${G}next-action`}>
        <PermissionReview host={host} target={target} intent="session" label={setup.error ? "Check connection" : "Enable sessions"} onReady={actions.refresh} />
      </div>}
      {record?.active && setup.error && <details className="plugin-atyrode_code__details"><summary>Connection details</summary><pre>{setup.error}</pre></details>}
      {profile && <details className="plugin-atyrode_code__details"><summary>Profile &amp; source details</summary>
        <dl className={`${G}setup-facts`}>
          <dt>Shared revision</dt><dd>{record?.revision ?? observed?.revision ?? "not observed"}{!configurationCurrent && " · last known, not current"}</dd>
          <dt>Displayed catalog</dt><dd>{profile.document.models.length} models · {profile.source === "starter" ? "local bundled starter" : profile.source === "draft" ? "staged preview" : "stored policy"}</dd>
          <dt>Saved historical provenance</dt><dd>Unrecorded · current metadata does not authenticate how a stored catalog was made</dd>
          <dt>Current bundled source</dt><dd>{metadata.data ? `OMP ${metadata.data.ompVersion} · ${metadata.data.revision}` : "Not currently observed"}</dd>
          <dt>Workspace</dt><dd>{host.containerId}</dd>
          <dt>Destination</dt><dd>{machine?.name ?? "None"} · {machineId || "not selected"} · {available ? "connected" : "unavailable"}</dd>
          {verification.exclusions && <><dt>Last verification</dt><dd>{compiled?.models.length ?? 0} models, {verification.exclusions.length} excluded</dd></>}
        </dl>
        {verification.exclusions && verification.exclusions.length > 0 && <ul className={`${G}exclusions`}>{verification.exclusions.map(exclusion =>
          <li key={`${exclusion.provider}/${exclusion.id}`}><code>{exclusion.provider}/{exclusion.id}</code><span>{EXCLUSION_WORDS[exclusion.reason]}</span></li>)}</ul>}
        {exportedDraft && <>
          <p>Local profile, not persisted. {localDraft?.metadata ? `Bundled OMP ${localDraft.metadata.ompVersion} · metadata revision ${localDraft.metadata.revision}. Performance is unmeasured; availability and accounts require their own observations.` : "This draft retains the exact stored catalog it was based on."}</p>
          <textarea data-profile-export readOnly rows={6} value={exportedDraft} aria-label="copy local profile" />
        </>}
      </details>}
    </>)}
    {sheetFrame("options", <>
      {extras.length > 0 && <section className={`${G}options-group`} aria-label="Profile switches">
        <h3 className={`${G}options-head`}>profile</h3>
        <p className={`${G}options-note`}>Saved with the workspace profile, like the generator's rows.</p>
        <ul className={`${G}options-switches`}>{extras.map(extra => <li key={extra.value}>
          <OptionSwitch on={extra.on} refusal={!extra.available ? extra.reason ?? extra.note : teamGate.open ? null : teamGate.refusal.text}
            label={`${extra.label}: ${extra.meaning}`} onChange={() => generator.current?.extra(extra.value)}>{extra.label}</OptionSwitch>
        </li>)}</ul>
      </section>}
      <p className={`${G}options-lede`}>The rest is for the next launch or resume only; the workspace profile stays as it is.</p>
      {optionsRefusal && <p className={`${G}options-note`} role="status">{optionsRefusal}</p>}
      <Automation choice={model.automation} reviewed={launchReview ? launchReview.native.automation : null} refusal={optionsRefusal} change={model.setAutomation} />
      <OptionalSkills catalog={skillCatalog.data} error={skillCatalog.error} choice={model.skillChoice} restricted={model.automation?.mode === "restricted"}
        reviewed={launchReview ? launchReview.native.skills : null} refusal={optionsRefusal} refresh={skillCatalog.refresh} change={model.setSkillChoice} />
    </>)}
  </>;
}

function Launcher({ host }: PanelProps) {
  const { machines, machine, machineId, target, available, error, select, refresh, presence } = useCodeTarget(host);
  // The panel root takes focus when the panel opens (Workbench), so its keys work before anything is clicked.
  return <div className="plugin-atyrode_code plugin-atyrode_code_generator" tabIndex={-1}>
    <ScrollRegion className={`${G}scroll`} aria-label="Code workspace">
      {host.containerId ? <Workbench key={JSON.stringify([host.principal.id, host.containerId])} host={host} target={target} machine={machine} machines={machines}
        machineId={machineId} rosterError={error} available={available} select={select} refreshMachines={refresh} presence={presence} />
        : <div className={`${G}tui`} data-tui="">
          <h1 className="plugin-atyrode_code__sr">Code</h1>
          <p className={`${G}pane-note`}>Open or create a workspace in Manifold to use Code here.</p>
        </div>}
    </ScrollRegion>
  </div>;
}
export default { id: GENERATOR_PLUGIN_ID, panels: { [LAUNCHER_PANEL]: Launcher } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
