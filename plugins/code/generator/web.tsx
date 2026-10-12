import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import type { MachineSummary } from "@manifold/protocol";
import { prefersReducedMotion, ScrollRegion } from "@manifold/ui";
import { quotaPools } from "../../domain/quota.ts";
import { GENERATOR_PLUGIN_ID, LAUNCHER_PANEL, type Target } from "../contract.ts";
import { useCodeTarget, type OmpPresence } from "../machine-web.ts";
import { AccountsView } from "../accounts-view.tsx";
import { Button, familyWord, hueOf, SheetFrame } from "../ui.tsx";
import { displayAliases } from "./aliases.ts";
import { modelListFailure } from "./board-model.ts";
import { AccountsPane } from "./accounts-pane.tsx";
import { ModelsSheet } from "./models-sheet.tsx";
import { EarlierStatements, usePinnedRecents } from "./earlier.tsx";
import type { StatementWords } from "./earlier-model.ts";
import { GeneratorPane, PANEL_VOCABULARY, type GeneratorControls, type GeneratorPlace, type LaunchState } from "./generator-pane.tsx";
import { acceleratorFor, panelKey, type PanelAction, type PanelSheet, type PanelView } from "./panel-keys.ts";
import { routeLedger } from "./routing-model.ts";
import { RoutingPane } from "./routing-pane.tsx";
import { OptionalSkills } from "./skills.tsx";
import { Automation } from "./automation.tsx";
import { OptionSwitch } from "./option-switch.tsx";
import { SetupSheet } from "./setup-sheet.tsx";
import { teamWords, type SlotOption } from "./statement-model.ts";
import { UsagePane, useUsageCadence } from "./usage-pane.tsx";
import { readHeld } from "./auto-read.ts";
import { MoreMenu, type MenuCommand } from "./more-menu.tsx";
import { usePanelReads, usePanelShown } from "./read-clock.ts";
import { useWorkbench } from "./workbench-model.ts";
import { tabMark } from "./runs-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
const PANEL_ROOT = ".plugin-atyrode_code_generator";
/** The session options sheet's title; Models and Setup draw their own heads (models-sheet.tsx, setup-sheet.tsx). */
const OPTIONS_TITLE = "Session options";
const NO_WORDS: StatementWords = { lane: "", tier: "", thinking: "", advisor: "", extras: "", machine: "" };
/** Below this panel width routing and usage leave the generator's side, for under it or tabs of their own; from the second, the wider spacing. */
const NARROW_BELOW_PX = 760, WIDE_FROM_PX = 1180;
type Mode = "narrow" | "medium" | "wide";
/**
 * The layout the panel's width allows and, below 760px, the panel's size, which decides where routing and usage stand
 * (`useStacked`); `fonts` turns true once the document's fonts are ready, so what a fallback font laid out is measured again.
 */
type Panel = { readonly mode: Mode; readonly width: number; readonly height: number; readonly fonts: boolean };
/** How far the stacked arrangement may run past the panel's height before it gives way, so rounding never flips it back and forth. */
const STACKED_GRACE_PX = 4;

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
 * The layout the panel's own size allows: the panel, not the window, since Code shares the window
 * with its canvas. The width chooses the layout at once, before paint and on every resize. Below
 * 760px the width and the scroll region's height are kept too, for `useStacked`, but only once a
 * resize has settled (two frames without another, as `data-boot` lifts), so a drag decides where
 * routing stands once rather than at every pixel; wider, a resize renders nothing new. The region is
 * found by its own class, since its viewport only declares itself scrolling once mounted. The first
 * layout, every resize and every `still` change of arrangement place things without motion
 * (`data-boot`), so nothing glides into its place on arrival.
 */
function usePanel(app: RefObject<HTMLDivElement | null>): { panel: Panel; still: () => void } {
  const [panel, setPanel] = useState<Panel>({ mode: "wide", width: 0, height: 0, fonts: false });
  const motion = useRef({ booted: false, frame: 0, settled: () => {} });
  const still = useCallback(() => {
    const node = app.current, state = motion.current;
    if (!node) return;
    node.dataset.boot = "";
    // Before the fonts are ready the first layout is still settling, and lifts `data-boot` itself once they are.
    if (!state.booted) return;
    cancelAnimationFrame(state.frame);
    state.frame = requestAnimationFrame(() => { state.frame = requestAnimationFrame(() => { delete node.dataset.boot; state.settled(); }); });
  }, []);
  useLayoutEffect(() => {
    const node = app.current, region = node?.closest<HTMLElement>(`.${G}scroll`);
    if (!node) return;
    node.dataset.boot = "";
    // A new layout takes its size at once; within one, a new size waits until the resize has settled.
    const judge = (settled: boolean) => {
      const width = node.clientWidth;
      if (width === 0) return;
      const mode: Mode = width < NARROW_BELOW_PX ? "narrow" : width < WIDE_FROM_PX ? "medium" : "wide";
      const narrow = mode === "narrow";
      setPanel(previous => {
        const next = { mode, width: narrow ? width : 0, height: narrow ? region?.clientHeight ?? 0 : 0, fonts: previous.fonts };
        return previous.mode === mode && (!settled || previous.width === next.width && previous.height === next.height) ? previous : next;
      });
    };
    motion.current.settled = () => judge(true);
    judge(true);
    const observer = new ResizeObserver(() => { still(); judge(false); });
    observer.observe(node);
    if (region) observer.observe(region);
    let live = true;
    void node.ownerDocument.fonts.ready.then(() => {
      if (!live) return;
      motion.current.booted = true;
      setPanel(previous => ({ ...previous, fonts: true }));
      still();
    });
    return () => { live = false; cancelAnimationFrame(motion.current.frame); observer.disconnect(); };
  }, []);
  return { panel, still };
}

/**
 * The generator's height as both arrangements weigh it: without the grouped profile, which only the
 * tabbed one shows, and without the Show controls (`data-reveal`) that only the stacked one adds at
 * the end of its head, where they may take a line of their own.
 */
function bareHeight(generator: HTMLElement): number {
  const box = (element: Element) => element.getBoundingClientRect();
  const head = generator.querySelector(`:scope > .${G}head`), profile = generator.querySelector(`.${G}profile`);
  let height = box(generator).height;
  if (head) height -= box(head).bottom - Math.max(...[...head.children].filter(child => !child.matches("[data-reveal]")).map(child => box(child).bottom));
  if (profile) height -= box(profile).height + parseFloat(getComputedStyle(profile).marginTop);
  return height;
}

/**
 * Routing's height without its fallback chains, as laid out now: the chains (`f`) never decide where
 * routing stands, so the lines each route's chain runs past its lead are left out, whether it runs
 * beside the role or, under 300px, under it.
 */
function bareRoutingHeight(routing: HTMLElement): number {
  let height = routing.getBoundingClientRect().height;
  for (const chain of routing.querySelectorAll(`.${G}chain`)) {
    const lead = chain.firstElementChild;
    if (lead) height -= chain.getBoundingClientRect().bottom - lead.getBoundingClientRect().bottom;
  }
  return height;
}

/** What the stage's arrangement below 760px depends on besides the panel's size. */
type StageFacts = {
  /** The main view shows, so the generator can be measured: no other view, no sheet over it. */
  readonly main: boolean;
  /** The routing's rows; none while the profile is read, when there is nothing yet to weigh. */
  readonly routes: number;
  /** Routing is hidden beside or under the generator. */
  readonly hidden: boolean;
};

/**
 * Below 760px, where routing and usage stand: under the generator when the generator without its
 * grouped profile and the whole routing pane without its fallback chains fit the panel's height
 * together (its scroll region's, less the key line), otherwise as tabs of their own, as they also are
 * until there are routes to weigh. It is judged from what is rendered, and only when the panel's
 * settled size or the stage's structure changes (entering narrow, the routing's rows or the
 * generator's, routing hidden or shown, a return to the main view, the fonts becoming ready), never
 * because the readout, the launch line or the fallback chains changed: what then runs past the panel
 * scrolls, so the launch never moves under the pointer and the chains never send routing back to a
 * tab. Both arrangements weigh the same heights: the generator by `bareHeight`, and the bar and
 * routing (`bareRoutingHeight`) as the stacked arrangement last laid them out at this width with
 * these routes. Where it has not yet, the stacked arrangement is tried before paint (`probing`:
 * routing shown even if hidden, and the Routing and Usage tabs kept for focus but given no room) and
 * settles back if it does not fit; a flip to stacked is measured again as laid out. A change of
 * arrangement is `still`, as a resize is, and focus on a routing or usage control it hides or removes
 * is kept in the panel (`keep`).
 */
function useStacked(app: RefObject<HTMLDivElement | null>, panel: Panel, still: () => void, facts: StageFacts, keep: () => void): { stacked: boolean; probing: boolean } {
  const [state, setState] = useState({ stacked: false, probing: false });
  // The bar's and routing's height as the stacked arrangement laid them out, by width and routes, and whether the fonts were ready.
  // The bar can gain a line later (More's aside wrapping at a narrow width) without a new key; that only scrolls, as any later
  // overflow does, until the next resize or structural change judges again.
  const laid = useRef({ fonts: false, heights: new Map<string, number>() });
  const judged = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (panel.mode !== "narrow" || !facts.main || facts.routes === 0) { judged.current = null; return; }
    const node = app.current;
    const generator = node?.querySelector<HTMLElement>(`[data-pane="generator"]`), routing = node?.querySelector<HTMLElement>(`[data-pane="routing"]`);
    if (!node || !generator || !routing) return;
    if (laid.current.fonts !== panel.fonts) laid.current = { fonts: panel.fonts, heights: new Map() };
    const at = `${panel.width}:${facts.routes}`;
    const key = `${at}:${panel.height}:${facts.hidden}:${generator.querySelectorAll("[data-row]").length}:${panel.fonts}`;
    if (key === judged.current && !state.probing) return;
    judged.current = key;
    // A probe whose routing did not show cannot be measured; it ends rather than asks again for the same key.
    if (state.probing && routing.hidden) {
      setState({ stacked: state.stacked, probing: false });
      return;
    }
    const height = (element: Element | null) => element?.getBoundingClientRect().height ?? 0;
    if ((state.stacked || state.probing) && !routing.hidden) laid.current.heights.set(at, height(node.querySelector(`.${G}bar`)) + bareRoutingHeight(routing));
    const frame = laid.current.heights.get(at);
    if (frame === undefined) {
      still();
      setState({ stacked: state.stacked, probing: true });
      return;
    }
    const stacked = frame + bareHeight(generator) <= panel.height - height(node.querySelector(`.${G}keys`)) + (state.stacked ? STACKED_GRACE_PX : 0);
    if (stacked !== state.stacked) {
      still();
      // Focus on a routing or usage control would go with it: its pane hides when the stage turns to tabs, its tab goes when it stacks.
      if (node.ownerDocument.activeElement?.closest(`[data-pane="routing"], [data-pane="usage"], [data-view-tab="routing"], [data-view-tab="usage"]`)) keep();
      // A stacked arrangement taken from what an earlier layout measured is measured once more as it is laid out now.
      if (stacked) judged.current = null;
    }
    if (stacked !== state.stacked || state.probing) setState({ stacked, probing: false });
  });
  return state;
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
    ["p", "Routing: hide or show it beside or under the generator, or open its tab"], ["s", "Usage: hide or show it under the generator, or open its tab"],
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
  host: HostServices; target: Target | null; machine: MachineSummary | null; machines: readonly MachineSummary[] | null;
  rosterError: string | null; available: boolean; select: (id: string) => void; refreshMachines: () => void; presence: ReadonlyMap<string, OmpPresence> | null;
};

/**
 * The panel as the terminal UI had it, evolved for the web: the generator's rows with routing
 * beside them and usage under both when there is room, a key line at the foot, and the accounts and
 * the sessions one key away; under the accounts, their management (sign-in, presets, credentials).
 * Under 760px routing stands under the generator and usage under routing when the panel is tall
 * enough for the generator and the whole routing at once (`useStacked`); otherwise routing and usage
 * are tabs of their own and the profile shows grouped under the generator's rows. Models, Setup and
 * the session options open as sheets over the stage.
 */
function Workbench({ host, target, machine, machines, rosterError, available, select, refreshMachines, presence }: WorkbenchProps) {
  const model = useWorkbench({ host, target, machine, rosterError, available });
  const { queries: { metadata, skillCatalog }, record, starterError, compiled, selection,
    launchReview, busy, writable, usage, actions } = model;
  const recents = usePinnedRecents(model.recentTeams);
  const { region, announce } = useAnnouncer();
  const app = useRef<HTMLDivElement>(null);
  const generator = useRef<GeneratorControls | null>(null);
  const { panel, still } = usePanel(app);
  const { mode } = panel;
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
  const listFailure = modelListFailure(Boolean(metadata.error || starterError), record?.active ?? null, model.document !== null);
  const lane = selection?.lane;
  const accent = !lane || lane.kind === "mixed" ? "var(--tui-mixed)" : `var(--code-${hueOf(lane.family)})`;

  // ------------------------------------------------------------ views and sheets
  const arrangement = useStacked(app, panel, still, { main: view === "main" && sheet === null, routes: ledger?.length ?? 0, hidden: hidden.routing }, keepFocus);
  // Narrow, routing and usage stand under the generator (`stacked`) or are tabs of their own (`tabbed`); a probe lays them out
  // stacked before paint while the tabs keep their nodes (`probing`), so focus on one stays unless the stage really stacks.
  const probing = narrow && arrangement.probing;
  const stacked = narrow && (arrangement.stacked || probing);
  const tabbed = narrow && !arrangement.stacked;
  // Routing and usage stand with the generator: beside it, or under it.
  const withGenerator = !narrow || stacked;
  const showRouting = (view === "main" && withGenerator && (!hidden.routing || probing)) || view === "routing";
  const showUsage = (view === "main" && withGenerator && !hidden.usage) || view === "usage";
  function changeView(next: PanelView) {
    if (next !== view) setView(next);
  }
  // An arrangement that brings routing and usage back beside or under the generator closes their tabs.
  useEffect(() => { if (!tabbed && (view === "routing" || view === "usage")) setView("main"); }, [tabbed]);
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
      const frame = back?.closest<HTMLElement>(`.${G}sheet-host`);
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
  function sheetKeys(event: KeyboardEvent<HTMLDivElement>) {
    const element = event.target as HTMLElement;
    // Native dialogs and form fields own Escape; a sheet's own Escape (a run's cancel) is already handled.
    if (event.key !== "Escape" || event.defaultPrevented || element.closest("dialog") || element.matches("textarea, input, select")) return;
    event.preventDefault();
    closeSheet();
  }
  /** Where a launch-line or sheet fix sends the person: a sheet, or the accounts view. */
  function open(place: GeneratorPlace) {
    if (place === "accounts" || place === "sessions") {
      if (currentSheet.current) closeSheet();
      changeView(place);
    } else openSheet(place);
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
  // What each read is (auto-read.ts `PASS_READS`): the workbench's inputs once a minute and when the panel shows again, the usage,
  // the sessions already read and the Runs on the usage line's cadence, and all of it in one pass at a press.
  const reads = usePanelReads({
    configuration: model.queries.configuration.refresh, metadata: metadata.refresh, setup: model.queries.setup.refresh, defaults: model.queries.defaults.refresh,
    skills: skillCatalog.refresh, accounts: model.queries.accounts.refresh, machines: refreshMachines,
    usage: actions.readUsage, sessions: () => setRereads(count => count + 1), runs: model.agentRuns.refresh,
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
      // A sheet opened within the frame (Esc, then a sheet's key) owns focus and gives it back itself.
      if (!node || currentSheet.current) return;
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
        else app.current?.querySelector<HTMLElement>(`[data-pane="${view}"] :is(button, [tabindex="0"]):not([aria-disabled="true"], [data-session-said])`)?.focus();
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
      onRoot, view, tabbed, recents: recents.length,
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
    const key = acceleratorFor(view, tabbed, keys, does);
    return { "aria-keyshortcuts": key ?? undefined, title: key === null ? title : `${title} (${key === "Escape" ? "Esc" : key})` };
  };
  const runsMark = tabMark(model.agentRuns.runs?.runs ?? []);
  const tab = (to: PanelView, label: string) => {
    const selected = view === to || (to === "accounts" && view === "manage");
    const mark = to === "sessions" ? runsMark : null;
    const markWords = mark === "blocked" ? "a run waits for you" : mark === "working" ? "a run is working" : mark === "starting" ? "a run is starting" : "runs wait for you";
    const keys = keyed(mark ? `${label}: ${markWords}` : label, TAB_KEYS, action => action.kind === "back" ? to === "main" : action.kind === "view" && action.view === to);
    return <button key={to} type="button" role="tab" className={`${G}tab`} aria-selected={selected} {...keys} data-marked={mark ? "" : undefined}
      tabIndex={selected ? 0 : -1} data-view-tab={to} onClick={() => run({ kind: "view", view: to })}>{label}
      {mark && <span className={`${G}run-mark ${G}tab-mark`} data-a={mark} aria-hidden="true" />}</button>;
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
  const menuKey = (keys: readonly string[], does: (action: PanelAction) => boolean) => acceleratorFor(view, tabbed, keys, does);
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
      {tabbed && tab("routing", "Routing")}
      {tabbed && tab("usage", "Usage")}
      {tab("accounts", "Accounts")}
      {tab("sessions", "Sessions")}
    </div>
    <MoreMenu commands={commands} />
  </nav>;
  const hideButton = (pane: "routing" | "usage") => withGenerator && <Button aria-keyshortcuts={pane === "routing" ? "p" : "s"} title={`Hide ${pane} (${pane === "routing" ? "p" : "s"})`}
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
  const tui = <div ref={app} className={`${G}tui`} data-tui="" data-mode={mode} data-stacked={stacked || undefined} data-probing={probing || undefined} data-view={view}
    data-solo-generator={(view === "main" && !showRouting) || undefined}
    data-solo={view === "routing" || view === "usage" || undefined} hidden={sheet !== null} style={{ "--tui-acc": accent } as CSSProperties}>
    <h1 className="plugin-atyrode_code__sr">Code</h1>
    {bar}
    <main className={`${G}stage`}>
      <GeneratorPane model={model} pools={pools} machines={roster} presence={presence} selectMachine={select} recents={recents} connected={connected} ledger={ledger} shown={shown}
        profile={!showRouting} hidden={view !== "main"} listFailure={listFailure} announce={announce} onOpen={open}
        onRefresh={refresh} onLaunchState={setLaunch} onExtras={setExtras} controls={generator}
        reveal={withGenerator && (hidden.routing || hidden.usage) ? <>
          {hidden.routing && <Button aria-keyshortcuts="p" title="Show routing (p)" data-reveal="" onClick={() => run({ kind: "toggle", pane: "routing" })}>Show routing</Button>}
          {hidden.usage && <Button aria-keyshortcuts="s" title="Show usage (s)" data-reveal="" onClick={() => run({ kind: "toggle", pane: "usage" })}>Show usage</Button>}
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
        <EarlierStatements host={host} model={model} line={line} recents={recents} pools={pools} onRecall={index => generator.current?.recall(index)}
          rereads={rereads} announce={announce} />
      </section>
    </main>
    <footer className={`${G}keys`} aria-label="keys">
      <span className={`${G}keys-line`}>{keyLine}</span>
    </footer>
    <ShortcutsDialog dialog={shortcuts} narrow={narrow} />
  </div>;

  // A visited sheet stays mounted, so what it holds survives leaving it; each carries the lane's accent as the stage does.
  const sheetHost = (name: PanelSheet, body: ReactNode) => visited.includes(name) && <div key={name} className={`${G}sheet-host`} hidden={sheet !== name}
    onKeyDown={sheetKeys} style={{ "--tui-acc": accent } as CSSProperties}>{body}</div>;
  const backRef = (name: PanelSheet) => (element: HTMLButtonElement | null) => { backButtons.current[name] = element; };

  return <>
    {region}
    {tui}
    {sheetHost("models", <ModelsSheet host={host} model={model} machine={machine} onBack={closeSheet} backRef={backRef("models")} onPlace={open} />)}
    {sheetHost("setup", <SetupSheet host={host} model={model} target={target} machine={machine} machines={roster} rosterError={rosterError} presence={presence}
      select={select} refreshMachines={refreshMachines} onBack={closeSheet} backRef={backRef("setup")} onPlace={open} open={sheet === "setup"} />)}
    {sheetHost("options", <SheetFrame name={OPTIONS_TITLE} onBack={closeSheet} backRef={backRef("options")}><div className={`${G}options`}>
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
    </div></SheetFrame>)}
  </>;
}

function Launcher({ host }: PanelProps) {
  const { machines, machine, target, available, error, select, refresh, presence } = useCodeTarget(host);
  // The panel root takes focus when the panel opens (Workbench), so its keys work before anything is clicked.
  return <div className="plugin-atyrode_code plugin-atyrode_code_generator" tabIndex={-1}>
    <ScrollRegion className={`${G}scroll`} aria-label="Code workspace">
      {host.containerId ? <Workbench key={JSON.stringify([host.principal.id, host.containerId])} host={host} target={target} machine={machine} machines={machines}
        rosterError={error} available={available} select={select} refreshMachines={refresh} presence={presence} />
        : <div className={`${G}tui`} data-tui="">
          <h1 className="plugin-atyrode_code__sr">Code</h1>
          <p className={`${G}pane-note`}>Open or create a workspace in Manifold to use Code here.</p>
        </div>}
    </ScrollRegion>
  </div>;
}
export default { id: GENERATOR_PLUGIN_ID, panels: { [LAUNCHER_PANEL]: Launcher } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
