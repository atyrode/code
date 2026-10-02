import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import type { MachineSummary } from "@manifold/protocol";
import { prefersReducedMotion, ScrollRegion } from "@manifold/ui";
import { PROMPT_MAX_BYTES } from "@atyrode/manifold-omp";
import { defaultSelection } from "../../domain/routing.ts";
import { providerPolicy } from "../../domain/providers.ts";
import { GENERATOR_PLUGIN_ID, LAUNCHER_PANEL, type Target } from "../contract.ts";
import { useCodeTarget } from "../machine-web.ts";
import { AccountsView } from "../accounts-view.tsx";
import { UsageZone } from "../usage-view.tsx";
import { PermissionReview } from "../permission-review.tsx";
import {
  accountWord, cx, Dotted, EnterKey, Hint, HintBar, hueOf, LaunchKey, LayerProvider, Menu, MenuHeader, MenuItem, MenuRule, Notice, PrimaryButton, QuietButton,
  ReadoutProvider, Sep, SheetFrame, useMenu, useReadoutRoot, useReadoutZone, ZoneHead,
} from "../ui.tsx";
import { CatalogWorkbench } from "./catalog-editor.tsx";
import { RuntimeSettings } from "./runtime-settings.tsx";
import { OptionalSkills } from "./skills.tsx";
import { Automation } from "./automation.tsx";
import { FleetSessions } from "./fleet.tsx";
import { displayAliases, GeneratorPlaceholder, GeneratorZone, missingFamily, RoutingZone, useDialModel, type DialId, type LedgerView, type MapTarget } from "./dials.tsx";
import { useWorkbench } from "./workbench-model.ts";
import { nextLaunchStep, type LaunchBlocker } from "./launch-step.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
type Sheet = "accounts" | "models" | "setup" | "sessions";
const SHEETS: readonly Sheet[] = ["accounts", "models", "setup", "sessions"];
type Action = "save" | "review" | "launch" | "resume";
/** Why the primary cannot act, in a few words, with the one action that fixes it when there is one. */
type Blocked = { text: string; action?: { label: string; run: () => void } };
/** Exclusion reasons in plain words, for the verification details. */
const EXCLUSION_WORDS: Readonly<Record<string, string>> = {
  superseded: "superseded by a newer model", unstable_id: "unstable id", not_found: "not found through your accounts",
  client_blocked: "blocked for this client", regression: "worse than a cheaper tier",
};

/** The nearest scrolling ancestor: the ScrollRegion viewport, whose scroll position the main view keeps across sheets. */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

type WorkbenchProps = {
  host: HostServices; target: Target | null; machine: MachineSummary | null; machines: readonly MachineSummary[] | null; machineId: string | null;
  rosterError: string | null; available: boolean; select: (id: string) => void; refreshMachines: () => void; mapTarget: MapTarget | null;
};

function Workbench({ host, target, machine, machines, machineId, rosterError, available, select, refreshMachines, mapTarget }: WorkbenchProps) {
  const model = useWorkbench({ host, target, machine, rosterError, available });
  const {
    queries: { configuration, metadata, setup, skillCatalog }, observed, record, document, starterError, compiled, selection, profile, localDraft,
    review, localReview, controlsReview, launchReview, configurationCurrent, stale, writable, launchReady, busy, message, exportedDraft,
    canSave, canResume, canResumeWithProfile, canSuggest, canRequestSuggestion, canApplySuggestion, suggestionPromptTooLong, suggestionStale,
    prompt, setPrompt, skillChoice, setSkillChoice, automation, setAutomation, savedSessionId, setSavedSessionId, setAccountObservation,
    suggestion, unsaved, actions, verification,
  } = model;
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [verifyDetails, setVerifyDetails] = useState(false);
  const [visited, setVisited] = useState<readonly Sheet[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [ledger, setLedger] = useState<LedgerView>({ fallbacks: false, ids: false, pinned: new Set(), all: false });
  const [families, setFamilies] = useState<ReadonlySet<string> | null>(null);
  const [stripDetails, setStripDetails] = useState(false);
  const [pendingReview, setPendingReview] = useState(false);
  const [inFlight, setInFlight] = useState<Action | null>(null);
  const [outcome, setOutcome] = useState<{ kind: "launched" | "resumed"; machine: string } | null>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const lastAction = useRef<{ action: Action; machine: string } | null>(null);
  const view = useRef<HTMLDivElement>(null);
  const task = useRef<HTMLTextAreaElement>(null);
  const keysHint = useRef<HTMLButtonElement>(null);
  const backButtons = useRef<Partial<Record<Sheet, HTMLButtonElement | null>>>({});
  const returnFocus = useRef<HTMLElement | null>(null);
  const mainScroll = useRef(0);
  const currentSheet = useRef(sheet);
  currentSheet.current = sheet;
  const usageRefresh = useRef<(() => void) | null>(null);
  const machineMenu = useMenu();
  const moreMenu = useMenu();
  const optionsMenu = useMenu();
  const keysMenu = useMenu();
  const suggestMenu = useMenu(open => { if (open) actions.openSuggestion(); else actions.closeSuggestion(); });

  const aliases = useMemo(() => compiled ? displayAliases(compiled) : new Map<string, string>(), [compiled]);
  const dialModel = useDialModel(compiled, selection, controlsReview, families, profile?.metadata != null);
  const mapOption = mapTarget ? dialModel?.dials.get(mapTarget.dial)?.options.get(mapTarget.word) : undefined;
  const previewReview = mapOption?.ok && mapOption.review ? mapOption.review : null;
  const step = nextLaunchStep(model);
  // A fresh reading that shows no included account for a routed family would only fail at the session door; say so first.
  const uncovered = (step.step === "review" || step.step === "launch") && families && compiled && review ? missingFamily(compiled, review, families) : undefined;
  const loading = !profile && !document && !configuration.error && !starterError && !metadata.error;
  const machineName = machine?.name ?? null;

  // ------------------------------------------------------------ actions
  async function run(action: Action, work: () => Promise<void>) {
    lastAction.current = { action, machine: machineName ?? "the selected machine" };
    setInFlight(action); setOutcome(null);
    try { await work(); } finally { setInFlight(null); }
  }
  function primary() {
    if (busy || blocked !== null) return;
    // Verification spends only on an explicit confirm of the charge it showed; the first press only prepares it.
    if (step.step === "verify") { if (verification.canConfirm) void verification.confirm(); else if (verification.canPrepare) void verification.prepare(); }
    else if (step.step === "save") { setPendingReview(true); void run("save", actions.saveProfile); }
    else if (step.step === "review") void run("review", actions.review);
    else void run("launch", actions.launch);
  }
  // `save & review` is one gesture: the review follows once the saved revision is observed, never before.
  const stepCode = step.step === "blocked" ? step.reason.code : step.step;
  useEffect(() => {
    if (!pendingReview || busy) return;
    if (message?.failed || stepCode === "save") { setPendingReview(false); return; }
    if (stepCode === "configuration") return;
    setPendingReview(false);
    if (stepCode === "review" && !uncovered) void run("review", actions.review);
  }, [pendingReview, busy, stepCode, message?.failed, uncovered]);
  useEffect(() => {
    const last = lastAction.current;
    if (!message || message.failed || !last) return;
    if (last.action === "launch" || last.action === "resume") setOutcome({ kind: last.action === "launch" ? "launched" : "resumed", machine: last.machine });
  }, [message]);
  function updateSelection(next: Parameters<typeof actions.updateSelection>[0]) {
    setOutcome(null);
    actions.updateSelection(next);
  }
  function restoreDefaults() {
    if (!compiled || busy) return;
    try { updateSelection(defaultSelection(compiled)); } catch { /* A catalog without a complete default keeps the current choices. */ }
  }
  function toggleLedger(toggle: "fallbacks" | "ids") {
    setLedger(previous => ({ ...previous, [toggle]: !previous[toggle] }));
  }
  function pin(role: string) {
    setLedger(previous => {
      const pinned = new Set(previous.pinned);
      if (!pinned.delete(role)) pinned.add(role);
      return { ...previous, pinned };
    });
  }
  async function keepCopy() {
    try { await navigator.clipboard.writeText(exportedDraft); setCopied("copied"); }
    catch { setCopied("failed"); openSheet("setup"); }
  }

  // ------------------------------------------------------------ sheets
  function openSheet(next: Sheet) {
    if (!currentSheet.current) {
      returnFocus.current = view.current?.ownerDocument.activeElement as HTMLElement | null;
      mainScroll.current = scrollParent(view.current)?.scrollTop ?? 0;
    }
    setSheet(next);
    setVisited(previous => previous.includes(next) ? previous : [...previous, next]);
    actions.refresh();
  }
  function closeSheet() {
    setSheet(null);
    actions.refresh();
  }
  // The task grows with its text from one line to eight, then scrolls.
  useLayoutEffect(() => {
    const element = task.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 8 * 20 + 8)}px`;
  }, [prompt]);
  const sheetChanged = useRef(sheet);
  useLayoutEffect(() => {
    if (sheetChanged.current === sheet) return;
    sheetChanged.current = sheet;
    const scroller = scrollParent(view.current);
    if (sheet) {
      if (scroller) scroller.scrollTop = 0;
      const back = backButtons.current[sheet];
      back?.focus({ preventScroll: true });
      const frame = back?.closest<HTMLElement>(".plugin-atyrode_code__sheet");
      if (frame && !prefersReducedMotion()) frame.animate([{ transform: "translateX(24px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 160, easing: "cubic-bezier(.2, 0, 0, 1)" });
      return;
    }
    if (scroller) scroller.scrollTop = mainScroll.current;
    const origin = returnFocus.current;
    (origin?.isConnected && origin.offsetParent !== null ? origin : moreMenu.anchor.current)?.focus({ preventScroll: true });
  }, [sheet]);
  function finish(source: Sheet) {
    if (currentSheet.current === source) closeSheet();
    else actions.refresh();
  }

  // ------------------------------------------------------------ keyboard
  function focusGenerator() {
    view.current?.querySelector<HTMLElement>(`[data-zone="generator"] [tabindex="0"]`)?.focus();
  }
  function openKeys() {
    const hint = keysHint.current;
    keysMenu.anchor.current = hint && hint.offsetParent !== null ? hint : moreMenu.anchor.current;
    keysMenu.toggle();
  }
  function shortcuts(event: KeyboardEvent<HTMLDivElement>) {
    const element = event.target as HTMLElement;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); primary(); return; }
    if (event.defaultPrevented || element.closest("[data-popover]")) return;
    if (event.key === "Escape") {
      if (element === task.current) { event.preventDefault(); task.current.blur(); focusGenerator(); }
      else if (ledger.pinned.size) setLedger(previous => ({ ...previous, pinned: new Set() }));
      return;
    }
    if (element.matches("textarea, input, select, [contenteditable]") || event.ctrlKey || event.metaKey || event.altKey) return;
    const handled: Record<string, () => void> = {
      "/": () => task.current?.focus(),
      d: restoreDefaults,
      f: () => { if (review) toggleLedger("fallbacks"); },
      i: () => { if (review) toggleLedger("ids"); },
      r: () => usageRefresh.current?.(),
      "?": openKeys,
    };
    const handler = handled[event.key];
    if (handler) { event.preventDefault(); handler(); }
  }
  function sheetKeys(event: KeyboardEvent<HTMLDivElement>) {
    const element = event.target as HTMLElement;
    // Native dialogs and form fields own Escape inside legacy sheet content.
    if (event.key !== "Escape" || event.defaultPrevented || element.closest("dialog, [data-popover]") || element.matches("textarea, input, select")) return;
    event.preventDefault();
    closeSheet();
  }

  // ------------------------------------------------------------ the composer's next step
  const otherMachine = machines?.find(candidate => candidate.id !== machineId && candidate.online && candidate.revoked !== true);
  function blocker(reason: LaunchBlocker): Blocked {
    switch (reason.code) {
      case "configuration": return { text: "profile not current", action: { label: "retry", run: actions.refresh } };
      case "staged": return { text: "staged catalog", action: { label: "review in models", run: () => openSheet("models") } };
      case "unsaved": return { text: "no active catalog", action: { label: "models", run: () => openSheet("models") } };
      case "read-only": return { text: "read-only workspace" };
      case "conflict": return { text: "profile changed elsewhere", action: { label: "use current", run: actions.discardChanges } };
      case "models": return { text: "choices need a model review", action: { label: "models", run: () => openSheet("models") } };
      case "verifying": return { text: "verifying models" };
      case "verify-status": return { text: "verification readiness unknown", action: { label: "retry", run: actions.refresh } };
      case "verify-permissions": return { text: "discovery not enabled", action: { label: "enable", run: () => openSheet("setup") } };
      case "sessions": return { text: "sessions unavailable here", action: { label: "setup", run: () => openSheet("setup") } };
      case "permissions": return { text: "sessions not enabled", action: { label: "enable", run: () => openSheet("setup") } };
      case "skills": return { text: "skill choices need attention", action: { label: "options", run: optionsMenu.toggle } };
      case "unavailable":
        if (rosterError) return { text: "machines unavailable", action: { label: "retry", run: refreshMachines } };
        if (!machineId) return { text: "no machine chosen", action: { label: "choose", run: machineMenu.toggle } };
        if (!machine) return { text: "machine unavailable", action: { label: "choose", run: machineMenu.toggle } };
        if (machine.revoked) return { text: `${machine.name} revoked`, ...otherMachine ? { action: { label: `use ${otherMachine.name}`, run: () => select(otherMachine.id) } } : {} };
        return { text: `${machine.name} offline`, ...otherMachine ? { action: { label: `use ${otherMachine.name}`, run: () => select(otherMachine.id) } } : {} };
    }
  }
  // While the first observation is pending there is nothing to retry yet; say what is happening instead.
  const blocked: Blocked | null = step.step === "blocked" ? (loading ? { text: "reading profile" } : blocker(step.reason))
    : uncovered ? { text: `no ${accountWord(uncovered)} account included`, action: { label: "accounts", run: () => openSheet("accounts") } } : null;
  const verifyRunning = verification.phase === "inventory" || verification.phase === "benchmark";
  const nextLabel = verifyRunning ? (verification.phase === "inventory" ? "checking models…" : "verifying…")
    : busy && inFlight ? { save: "saving…", review: "reviewing…", launch: "launching…", resume: "resuming…" }[inFlight]
    : busy ? "working…" : pendingReview ? "reviewing…"
    : step.step === "verify" ? (verification.canConfirm ? "confirm" : "verify models")
    : step.step === "save" ? "save & review" : step.step === "launch" ? "launch" : step.step === "review" ? "review"
    : verification.status !== "current" ? "verify models" : model.previewCurrent ? "launch" : unsaved && localDraft ? "save & review" : "review";
  const nextReadout = blocked ? `${blocked.text}${blocked.action ? ` · ${blocked.action.label}` : ""}`
    : step.step === "verify" ? (verification.canConfirm ? "spends the tiny requests shown above, then saves the verified models and this profile"
      : "checks which models your accounts can reach; nothing is spent until you confirm the charge")
    : step.step === "launch" ? `opens a terminal on ${machineName ?? "the machine"} with this reviewed profile`
    : step.step === "save" ? "saves the profile, then checks accounts, models and machine"
    : "checks accounts, models and machine before anything runs";
  const optionsSummary = automation ? "restricted" : skillChoice?.mode === "disabled" ? "skills off"
    : skillChoice?.mode === "select" ? `${skillChoice.skillIds.length + skillChoice.setIds.length} skills` : null;

  // ------------------------------------------------------------ header meta
  function metaLine(): ReactNode {
    if (loading) return null;
    if (configuration.error && !profile) return <><span className={`${G}err`}>×</span><span className={`${G}strong`}>profile unavailable</span><Sep /><QuietButton onClick={configuration.refresh}>retry</QuietButton></>;
    if (stale) return <><span className={`${G}warn`}>!</span><span className={`${G}strong`}>profile changed elsewhere</span>
      <span className={`${G}ma`}><Sep /><QuietButton onClick={() => void keepCopy()}>{copied === "copied" ? "copied" : "keep a copy"}</QuietButton><Sep /><QuietButton onClick={actions.discardChanges}>use current</QuietButton></span></>;
    if (configuration.error) return <><span className={`${G}warn`}>!</span><span className={`${G}strong`}>profile not current</span><Sep /><QuietButton onClick={configuration.refresh}>retry</QuietButton></>;
    if (busy && inFlight === "save") return <span className={`${G}strong`}>saving…</span>;
    if (verification.status === "verifying" || verifyRunning) return <span className={`${G}strong`}>verifying…</span>;
    if (verification.status !== "current") {
      const word = verification.status === "accounts-changed" ? "accounts changed" : verification.status === "omp-changed" ? "omp updated" : "unverified";
      return <><span className={`${G}strong`}>{word}</span>{verification.canPrepare && <span className={`${G}ma`}><Sep /><QuietButton onClick={() => void verification.prepare()}>verify</QuietButton></span>}
        {!writable && <><Sep /><span>read-only</span></>}</>;
    }
    if (!writable) return <><span className={`${G}strong`}>read-only</span>
      {localDraft ? <><Sep /><span>local preview</span></> : (profile?.source === "draft" || record?.draft) && <><Sep /><span>staged catalog</span>
        <span className={`${G}ma`}><Sep /><QuietButton onClick={() => openSheet("models")}>review in models</QuietButton></span></>}</>;
    if (profile?.source === "starter") return <><span className={`${G}strong`}>starter</span>{canSave && <><Sep /><QuietButton disabled={busy} onClick={() => void run("save", actions.saveProfile)}>save</QuietButton></>}</>;
    if (profile?.source === "draft") return <><span className={`${G}strong`}>staged catalog</span><span className={`${G}ma`}><Sep /><QuietButton onClick={() => openSheet("models")}>review in models</QuietButton></span></>;
    if (localDraft) return <><span className={`${G}strong`}>unsaved</span>{canSave && <><Sep /><QuietButton disabled={busy} onClick={() => void run("save", actions.saveProfile)}>save</QuietButton></>}<Sep /><QuietButton disabled={busy} onClick={actions.discardChanges}>revert</QuietButton></>;
    if (record?.draft) return <><span>saved</span><Sep /><span className={`${G}strong`}>staged catalog</span><span className={`${G}ma`}><Sep /><QuietButton onClick={() => openSheet("models")}>review in models</QuietButton></span></>;
    return <span>saved</span>;
  }
  const meta = metaLine();
  const longMeta = stale || profile?.source === "draft" || !!record?.draft;

  // ------------------------------------------------------------ zones
  const generatorNotices = <>
    {(metadata.error || starterError) && !record?.active && <Notice kind="error" details={metadata.error ?? starterError}
      actions={[<QuietButton key="r" onClick={metadata.refresh}>retry</QuietButton>, <QuietButton key="m" onClick={() => openSheet("models")}>models</QuietButton>]}>model list unavailable</Notice>}
    {configuration.error && profile && <Notice kind="warn" details={configuration.error}
      actions={[<QuietButton key="r" onClick={configuration.refresh}>retry</QuietButton>]}>shared choices not current · showing the last read</Notice>}
    {compiled && selection && !localReview && <Notice kind="warn" actions={[<QuietButton key="m" onClick={() => openSheet("models")}>models</QuietButton>]}>these choices need a model review</Notice>}
  </>;
  const generator = loading ? <GeneratorPlaceholder status="reading…" />
    : configuration.error && !profile ? <GeneratorPlaceholder status={null} meta={meta} notice={<Notice kind="error" details={configuration.error}
      actions={[<QuietButton key="r" onClick={configuration.refresh}>retry</QuietButton>]}>profile unavailable</Notice>} />
    : !compiled || !selection || !dialModel || !controlsReview ? <GeneratorPlaceholder status={null} meta={meta} notice={generatorNotices} />
    : <GeneratorZone model={dialModel} selection={selection} disabled={busy} onChange={updateSelection} estimates={controlsReview.estimates}
      previewEstimates={previewReview?.estimates ?? null} measured={controlsReview.routes.every(route => compiled.model(route.lead.key).tokensPerSecond !== null)}
      meta={meta} onDefaults={restoreDefaults} moreOpen={moreOpen} setMoreOpen={setMoreOpen} notice={generatorNotices} />;

  const zone = useReadoutZone();
  const next = nextLabel.replace("…", "");
  const keysButton = <Hint key="?" k="?" label="keys" onClick={openKeys} buttonRef={keysHint} />;
  const hintSets: Record<string, ReactNode[]> = {
    routing: [<Hint key="m" k="↑↓" label="move" />, <Hint key="p" k={<EnterKey />} label="pin" />, <Hint key="f" k="f" label="fallbacks" />, <Hint key="i" k="i" label="ids" />, <Hint key="t" k="/" label="task" />, keysButton],
    usage: [<Hint key="m" k="↑↓" label="move" />, <Hint key="s" k="space" label="include" />, <Hint key="a" k={<EnterKey />} label="accounts" />, <Hint key="r" k="r" label="refresh" />, <Hint key="t" k="/" label="task" />, keysButton],
    composer: [<Hint key="l" k={<LaunchKey />} label={next} />, <Hint key="e" k="esc" label="leave" />, <Hint key="o" k="tab" label="options" />],
    generator: [<Hint key="m" k="↑↓" label="move" />, <Hint key="c" k="←→" label="change" />, <Hint key="d" k="d" label="defaults" />, <Hint key="t" k="/" label="task" />, <Hint key="l" k={<LaunchKey />} label={next} />, keysButton],
  };

  // Providers in the family order the rest of the panel uses (codex, claude, deepseek, then others).
  const familyRank = (provider: string) => (["openai", "anthropic", "deepseek"].indexOf(providerPolicy(provider).family) + 1) || 99;
  const pool = launchReview ? Object.entries(launchReview.composition.accountPool).sort(([left], [right]) => familyRank(left) - familyRank(right)) : [];
  const poolCounts = new Map<string, { family: string; count: number }>();
  for (const [provider, accounts] of pool) {
    const family = providerPolicy(provider).family;
    const word = accountWord(family, provider);
    poolCounts.set(word, { family, count: (poolCounts.get(word)?.count ?? 0) + accounts.length });
  }

  // ------------------------------------------------------------ render
  const main = <div ref={view} className={`${G}view`} data-view="main" hidden={sheet !== null} onKeyDown={shortcuts}>
    <header className={`${G}head`}>
      <span className={`${G}wordmark`} aria-label="code">code<span className={`${G}us`} aria-hidden="true">_</span></span>
      <span className={`${G}meta ${G}meta-head`} role="status">{meta}</span>
      <span className={`${G}grow`} />
      <button ref={machineMenu.anchor} type="button" className={`${G}machine`} aria-haspopup="menu" aria-expanded={machineMenu.open} onClick={machineMenu.toggle}
        data-readout-label={machine?.name ?? "machine"} data-readout={rosterError ? rosterError : !machineId ? "choose where sessions launch"
          : !machine ? "the selected machine is not in your machine list; nothing else will be used" : `${machine.revoked ? "access revoked" : machine.online ? "online" : "offline"} · sessions launch here`}>
        <span className={`${G}machine-name`}>{machines === null ? "machines" : machine?.name ?? (machineId ? "unavailable" : "choose machine")}</span>
        <span className={`${G}dot`} data-state={machines === null ? "busy" : available ? "on" : "off"} aria-hidden="true">{available || machines === null ? "●" : "○"}</span>
        <span className={`${G}tri`} aria-hidden="true">▾</span>
        <span className="plugin-atyrode_code__sr">{machines === null ? "checking" : available ? "online" : "unavailable"}</span>
      </button>
      <Menu menu={machineMenu} label="machine" align="end">
        <MenuHeader>run on</MenuHeader>
        {machines === null && !rosterError && <MenuItem disabled onSelect={() => {}}>reading machines…</MenuItem>}
        {machines?.map(entry => <MenuItem key={entry.id} current={entry.id === machineId} onSelect={() => select(entry.id)}
          aside={entry.revoked ? "revoked" : entry.online ? <><span className={`${G}ok`}>●</span> online</> : "○ offline"}>{entry.name}</MenuItem>)}
        {machineId && machines && !machine && <MenuItem current disabled onSelect={() => {}} aside="unavailable">selected machine</MenuItem>}
        {rosterError && <MenuHeader>{rosterError}</MenuHeader>}
        <MenuRule />
        <MenuItem onSelect={refreshMachines}>refresh machines</MenuItem>
        <MenuItem onSelect={() => openSheet("setup")}>setup…</MenuItem>
      </Menu>
      <button ref={moreMenu.anchor} type="button" className={`${G}iconbtn`} aria-haspopup="menu" aria-expanded={moreMenu.open} aria-label="more" onClick={moreMenu.toggle}>⋯</button>
      <Menu menu={moreMenu} label="more" align="end">
        {SHEETS.map(name => <MenuItem key={name} onSelect={() => openSheet(name)}>{name}</MenuItem>)}
        <MenuRule />
        <MenuItem disabled={!compiled || busy} aside="d" onSelect={restoreDefaults}>restore defaults</MenuItem>
        <MenuItem aside="?" onSelect={() => { keysMenu.anchor.current = moreMenu.anchor.current; keysMenu.toggle(); }}>keys</MenuItem>
      </Menu>
    </header>
    <div className={cx(`${G}split`, longMeta && `${G}long-meta`)}>
      {generator}
      <div className={`${G}vrule`} aria-hidden="true" />
      <RoutingZone review={review} catalog={compiled} aliases={aliases} preview={previewReview} view={ledger} onToggle={toggleLedger} onPin={pin}
        onShowAll={() => setLedger(previous => ({ ...previous, all: true }))} status={loading ? "reading…" : review ? undefined : configuration.error && !profile ? null : undefined}
        line={verification.phase === "benchmark" || verification.phase === "inventory" ? <div className={`${G}vline`} role="status">
          <span className={`${G}vt`}>{verification.phase === "inventory" ? "checking models…" : "verifying…"}</span>
          {(verification.progress?.providers ?? []).map(entry => <span key={entry.provider} className={`${G}prog`} data-fam={hueOf(providerPolicy(entry.provider).family)}>
            <Sep /><span className={`${G}pn`}>{accountWord(providerPolicy(entry.provider).family, entry.provider)}</span> {entry.done}/{entry.total}</span>)}
          <Sep /><QuietButton onClick={verification.cancel}>cancel</QuietButton>
        </div> : verification.status === "current" && verification.exclusions ? <>
          <div className={`${G}vline`} role="status">
            <span className={`${G}vt`}>verified</span><Sep /><span>{compiled?.models.length ?? 0} models</span><Sep /><span>{verification.exclusions.length} excluded</span>
            {verification.exclusions.length > 0 && <><Sep /><QuietButton aria-expanded={verifyDetails} onClick={() => setVerifyDetails(!verifyDetails)}>{verifyDetails ? "hide details" : "details"}</QuietButton></>}
          </div>
          {verifyDetails && <div className={`${G}vdetails`}>{verification.exclusions.map(exclusion => <div key={`${exclusion.provider}/${exclusion.id}`} className={`${G}vx`}>
            <span className={`${G}vid`}>{exclusion.provider}/{exclusion.id}</span><span className={`${G}vwhy`}>{EXCLUSION_WORDS[exclusion.reason]}</span></div>)}</div>}
        </> : undefined} />
    </div>
    <UsageZone host={host} className={`${G}zone ${G}usage`} onAccounts={() => openSheet("accounts")} onObservation={setAccountObservation} onFamilies={setFamilies} refresher={usageRefresh} />
    <div className={`${G}dock`} data-zone="composer">
      {verification.phase === "charge" && verification.charge && <div className={`${G}strip`} role="status">
        <span className={`${G}facts`}><span className={`${G}ready`}>verify</span>{verification.charge.providers.map(entry => <span key={entry.provider} data-fam={hueOf(providerPolicy(entry.provider).family)}>
          <Sep /> <span className={`${G}pn`}>{accountWord(providerPolicy(entry.provider).family, entry.provider)}</span> {entry.requests}</span>)}
          <span><Sep /> {verification.charge.requests} tiny {verification.charge.requests === 1 ? "request" : "requests"} through your accounts</span></span>
        <span className={`${G}strip-acts`}>
          <QuietButton data-action="atyrode.code.verifyModels" onClick={() => void verification.confirm()}>confirm</QuietButton>
          <QuietButton onClick={verification.cancel}>cancel</QuietButton>
        </span>
      </div>}
      {verification.failure && !verifyRunning && verification.phase !== "charge" && <Notice kind={verification.failure.cancelled ? "info" : "error"} className={`${G}dock-note`}
        details={verification.failure.evidence ? JSON.stringify(verification.failure.evidence, null, 2) : null}
        actions={verification.canPrepare ? [<QuietButton key="r" onClick={() => void verification.prepare()}>retry</QuietButton>] : undefined}>
        {verification.failure.cancelled ? "verification cancelled" : `verification stopped at ${verification.failure.step} · ${verification.failure.reason}`}
      </Notice>}
      {launchReview && <>
        <div className={`${G}strip`} role="status">
          <span className={`${G}facts`}><span className={`${G}ready`}>ready</span>{[...poolCounts].map(([word, { family, count }]) => <span key={word}><Sep /> <span className={`${G}pn`} data-fam={hueOf(family)}>{word}</span> {count}</span>)}</span>
          <span className={`${G}where`}><Sep /> on {machineName ?? launchReview.destination.machineId}</span>
          <span className={`${G}strip-acts`}>
            <QuietButton aria-expanded={stripDetails} onClick={() => setStripDetails(!stripDetails)}>{stripDetails ? "hide details" : "details"}</QuietButton>
            {/* Re-setting the task is the workbench's own revocation: it drops the reviewed launch and nothing else. */}
            <QuietButton onClick={() => { setStripDetails(false); setPrompt(prompt); task.current?.focus(); }}>cancel</QuietButton>
          </span>
        </div>
        {stripDetails && <div className={`${G}strip-details`}>
          {pool.flatMap(([provider, accounts]) => accounts.map(account => <div key={`${provider}:${account.credentialId}`} className={`${G}pool-line`} data-fam={hueOf(providerPolicy(provider).family)}>
            <span className={`${G}pn`}>{accountWord(providerPolicy(provider).family, provider)}</span>
            <span>{account.identityKey ?? `slot ${account.credentialId}`}</span>
            <span className={`${G}w`}>{account.scope}</span>
          </div>))}
          <details className={`${G}raw`}><summary>review</summary><pre>{JSON.stringify({ composition: launchReview.composition, native: launchReview.native }, null, 2)}</pre></details>
        </div>}
      </>}
      {outcome && !launchReview && <div className={`${G}launched`} role="status">
        <span className={`${G}facts`}><Dotted items={[`${outcome.kind} in a terminal on ${outcome.machine}`, <QuietButton key="s" onClick={() => openSheet("sessions")}>sessions</QuietButton>]} /></span>
      </div>}
      {message?.failed && <Notice kind="error" className={`${G}dock-note`}>{message.text}</Notice>}
      <div className={`${G}composer`}>
        <span className={`${G}prompt`} aria-hidden="true">›</span>
        {/* Characters, because a textarea counts characters: the door's rule is bytes and
            refuses a multibyte prompt over it by name. */}
        <textarea ref={task} className={`${G}task`} rows={1} placeholder="describe the task" aria-label="task" spellCheck={false} maxLength={PROMPT_MAX_BYTES}
          value={prompt} onChange={event => { setOutcome(null); setPrompt(event.target.value); }} />
        <div className={`${G}acts`}>
          {blocked && <span className={`${G}reason`}>{blocked.text}{blocked.action && <><Sep /><QuietButton onClick={blocked.action.run}>{blocked.action.label}</QuietButton></>}</span>}
          <QuietButton buttonRef={optionsMenu.anchor} aria-haspopup="dialog" aria-expanded={optionsMenu.open} onClick={optionsMenu.toggle}
            data-readout-label="options" data-readout={`for this launch only · ${optionsSummary ?? "ordinary session, default skills"}`}>
            options{optionsSummary && <span className={`${G}opt-sum`}> · {optionsSummary}</span>}
          </QuietButton>
          {canSuggest && <QuietButton buttonRef={suggestMenu.anchor} aria-haspopup="dialog" aria-expanded={suggestMenu.open} onClick={suggestMenu.toggle}
            data-readout-label="suggest" data-readout="ask the configured classifier for a profile that fits this task">suggest</QuietButton>}
          <PrimaryButton className={`${G}primary`} disabled={blocked !== null && !busy && !verifyRunning} busy={busy || pendingReview || verifyRunning} onClick={primary}
            data-action={step.step === "launch" ? "atyrode.omp.prepareSession" : step.step === "save" ? "atyrode.code.select" : "atyrode.omp.reviewSession"}
            data-readout={nextReadout} data-readout-prose="">{nextLabel}</PrimaryButton>
        </div>
      </div>
      <HintBar className={`${G}hintbar`} hints={<Dotted items={hintSets[zone ?? "generator"] ?? hintSets.generator!} />} />
    </div>
    <Menu menu={optionsMenu} role="dialog" label="launch options" placement="above" align="end" className={`${G}options-pop`}>
      <div className={`${G}legacy ${G}pop-body`}>
        <p className={`${G}prose`}>For this launch only. The profile and its defaults stay as they are.</p>
        <Automation choice={automation} reviewed={launchReview ? launchReview.native.automation : null} disabled={busy || !writable || !available} change={setAutomation} />
        {automation && <p className="plugin-atyrode_code__warning">Restricted OMP tools; not an OS or network sandbox.</p>}
        <OptionalSkills catalog={skillCatalog.data} error={skillCatalog.error} choice={skillChoice} restricted={automation?.mode === "restricted"}
          reviewed={launchReview ? launchReview.native.skills : null} disabled={busy || !writable || !available} refresh={skillCatalog.refresh} change={setSkillChoice} />
      </div>
    </Menu>
    {canSuggest && <Menu menu={suggestMenu} role="dialog" label="suggest a profile" placement="above" align="end" className={`${G}suggest-pop`}>
      <div className={`${G}pop-body`}>
        <p className={`${G}prose`}>Sends this task to the configured classifier. Nothing is saved; inspect the proposed changes first.</p>
        <div className={`${G}pop-acts`}>
          <PrimaryButton keyHint={false} data-autofocus="" data-action="atyrode.code.suggest" disabled={!canRequestSuggestion && !busy} busy={busy} onClick={() => void actions.suggest()}>{busy ? "working…" : "suggest"}</PrimaryButton>
        </div>
        {suggestionPromptTooLong && <Notice kind="warn">the classifier accepts up to 16,384 characters; the task is kept whole</Notice>}
        {suggestion && <>
          <Notice>{suggestion.changed.length ? `suggests ${suggestion.changed.join(", ")}` : "your profile already fits"}</Notice>
          {suggestion.changed.length > 0 && <dl className={`${G}suggested`}>{suggestion.changed.map(key => <div key={key}><dt>{key}</dt>
            <dd>{typeof suggestion.selection[key] === "object" ? JSON.stringify(suggestion.selection[key]) : String(suggestion.selection[key])}</dd></div>)}</dl>}
          <div className={`${G}pop-acts`}><QuietButton disabled={busy || !canApplySuggestion} onClick={() => { actions.applySuggestion(); suggestMenu.close(true); }}>try this profile</QuietButton></div>
          {unsaved && <Notice kind="warn">save or revert local changes before trying a suggestion</Notice>}
          {suggestionStale && <Notice kind="warn">the profile or classifier changed · ask again</Notice>}
        </>}
      </div>
    </Menu>}
    <Menu menu={keysMenu} role="dialog" label="keys" placement="above" align="start" className={`${G}keys-pop`}>
      <div className={`${G}keys`}>
        {([
          ["generator", [["↑↓", "move"], ["←→", "change"], ["home end", "ends"], ["d", "defaults"]]],
          ["routing", [["↑↓", "move"], [<EnterKey key="e" />, "pin"], ["f", "fallbacks"], ["i", "ids"]]],
          ["usage", [["↑↓", "move"], ["space", "include"], [<EnterKey key="e" />, "accounts"], ["r", "refresh"]]],
          ["anywhere", [["tab", "zone"], ["/", "task"], [<LaunchKey key="l" />, "next step"], ["esc", "back"]]],
        ] as [string, [ReactNode, string][]][]).map(([zoneName, keys]) => <div key={zoneName} className={`${G}keys-row`}>
          <span className={`${G}kz`}>{zoneName}</span>{keys.map(([key, label], index) => <span key={index}><kbd>{key}</kbd> {label}</span>)}
        </div>)}
      </div>
    </Menu>
  </div>;

  const sheetFrame = (name: Sheet, body: ReactNode, actionsNode?: ReactNode) => visited.includes(name) && <div key={name} className={`${G}sheet-host`} hidden={sheet !== name} onKeyDown={sheetKeys}>
    <SheetFrame name={name} onBack={closeSheet} backRef={element => { backButtons.current[name] = element; }} actions={actionsNode}>
      <div className={`${G}legacy`}>{body}</div>
    </SheetFrame>
  </div>;

  return <>
    {main}
    {sheetFrame("accounts", <AccountsView host={host} target={target} available={available} onDone={() => finish("accounts")} />)}
    {sheetFrame("models", <CatalogWorkbench host={host} target={target} available={available} onDone={() => finish("models")} />)}
    {sheetFrame("setup", <>
      <RuntimeSettings host={host} target={target} available={available} onDone={() => finish("setup")} />
      {record?.active && !launchReady && <div className={`${G}next-action`}>
        <PermissionReview host={host} target={target} intent="session" label={setup.error ? "Check connection" : "Enable sessions"} onReady={actions.refresh} />
      </div>}
      {record?.active && setup.error && <details className="plugin-atyrode_code__details"><summary>Connection details</summary><pre>{setup.error}</pre></details>}
      {profile && <details className="plugin-atyrode_code__details" open={copied === "failed" || undefined}><summary>Profile &amp; source details</summary>
        <dl className={`${G}setup-facts`}>
          <dt>Shared revision</dt><dd>{record?.revision ?? observed?.revision ?? "not observed"}{!configurationCurrent && " · last known, not current"}</dd>
          <dt>Displayed catalog</dt><dd>{profile.document.models.length} models · {profile.source === "starter" ? "local bundled starter" : profile.source === "draft" ? "staged preview" : "stored policy"}</dd>
          <dt>Saved historical provenance</dt><dd>Unrecorded · current metadata does not authenticate how a stored catalog was made</dd>
          <dt>Current bundled source</dt><dd>{metadata.data ? `OMP ${metadata.data.ompVersion} · ${metadata.data.revision}` : "Not currently observed"}</dd>
          <dt>Workspace</dt><dd>{host.containerId}</dd>
          <dt>Destination</dt><dd>{machine?.name ?? "None"} · {machineId || "not selected"} · {available ? "connected" : "unavailable"}</dd>
        </dl>
        {exportedDraft && <>
          <p>Local profile, not persisted. Task text is independent and excluded from this export. {localDraft?.metadata ? `Bundled OMP ${localDraft.metadata.ompVersion} · metadata revision ${localDraft.metadata.revision}. Performance is unmeasured; availability and accounts require their own observations.` : "This draft retains the exact stored catalog it was based on."}</p>
          <textarea data-profile-export readOnly rows={6} value={exportedDraft} aria-label="copy local profile" />
        </>}
      </details>}
    </>)}
    {sheetFrame("sessions", <FleetSessions key={model.destinationGeneration} host={host} machines={machines} rosterError={rosterError} machineId={model.machineId}
      sessionId={savedSessionId} choose={setSavedSessionId} busy={busy}>
      {running => <div className={`${G}resume`}>
        <p>Resume on {machine?.name ?? (machineId || "no selected destination")} in this workspace.</p>
        <details className="plugin-atyrode_code__details"><summary>How resuming works</summary>
          <p>Saved state preserves its model and thinking. This profile replaces them with the saved Code choices and exact account pool. Neither action restores historical tool or skill restrictions: current session options apply, with ordinary automation and ambient skills when omitted.</p>
          <p>Native permission is still required. Code refreshes inventory and reopens a known running terminal instead of starting a replacement. Workspace: {host.containerId}.</p>
        </details>
        <div className="plugin-atyrode_code__toolbar">
          <button type="button" data-action="atyrode.omp.resumeSession" disabled={busy || !canResume || running} onClick={() => void run("resume", () => actions.resume(false))}>Resume saved state</button>
          <button type="button" data-action="atyrode.omp.resumeSession" disabled={busy || !canResumeWithProfile || running} onClick={() => void run("resume", () => actions.resume(true))}>Resume with this profile</button>
        </div>
      </div>}
    </FleetSessions>)}
  </>;
}

function Launcher({ host }: PanelProps) {
  const { machines, machine, machineId, target, available, error, select, refresh } = useCodeTarget(host);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [mapTarget, setMapTarget] = useState<MapTarget | null>(null);
  // Map mode is pure presentation: hovering or keyboard-focusing a generator word previews its routes.
  const readout = useReadoutRoot(element => {
    const dial = element?.dataset.dial, word = element?.dataset.word;
    setMapTarget(dial && word && element.closest("[data-zone='generator']") ? { dial: dial as DialId, word } : null);
  });
  return <div className="plugin-atyrode_code plugin-atyrode_code_generator" {...readout.rootProps}>
    <ReadoutProvider value={readout.state}>
      <LayerProvider value={layer}>
        <ScrollRegion className={`${G}scroll`} aria-label="Code workspace">
          {host.containerId ? <Workbench key={JSON.stringify([host.principal.id, host.containerId])} host={host} target={target} machine={machine} machines={machines}
            machineId={machineId} rosterError={error} available={available} select={select} refreshMachines={refresh} mapTarget={mapTarget} />
            : <div className={`${G}view`}>
              <header className={`${G}head`}><span className={`${G}wordmark`} aria-label="code">code<span className={`${G}us`} aria-hidden="true">_</span></span></header>
              <div className={`${G}zone`}><ZoneHead chip="workspace" /><Notice>open or create a workspace in Manifold to use code here</Notice></div>
            </div>}
        </ScrollRegion>
        <div ref={setLayer} className={`${G}layer`} />
      </LayerProvider>
    </ReadoutProvider>
  </div>;
}
export default { id: GENERATOR_PLUGIN_ID, panels: { [LAUNCHER_PANEL]: Launcher } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
