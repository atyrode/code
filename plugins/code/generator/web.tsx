import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import { keyCapLabel } from "@manifold/plugin/hooks";
import type { MachineSummary } from "@manifold/protocol";
import { ControlIcon, ItemIcon, KeyCap, prefersReducedMotion, ScrollRegion, Spinner } from "@manifold/ui";
import { PROMPT_MAX_BYTES } from "@atyrode/manifold-omp";
import { defaultSelection } from "../../domain/routing.ts";
import { providerPolicy } from "../../domain/providers.ts";
import { GENERATOR_PLUGIN_ID, LAUNCHER_PANEL, type Target } from "../contract.ts";
import { useCodeTarget } from "../machine-web.ts";
import { AccountsView } from "../accounts-view.tsx";
import { UsageZone } from "../usage-view.tsx";
import { PermissionReview } from "../permission-review.tsx";
import {
  accountWord, Button, Details, hueOf, IconButton, LAUNCH_STROKE, LayerProvider, Menu, MenuHeader, MenuItem, MenuRule, Notice, PrimaryButton, State,
  ReadoutProvider, SheetFrame, useMenu, useReadoutRoot, withKey,
} from "../ui.tsx";
import { CatalogWorkbench } from "./catalog-editor.tsx";
import { RuntimeSettings } from "./runtime-settings.tsx";
import { OptionalSkills } from "./skills.tsx";
import { Automation } from "./automation.tsx";
import { FleetSessions } from "./fleet.tsx";
import { displayAliases, GeneratorPlaceholder, GeneratorZone, RoutingZone, useDialModel, type LedgerView, type MapTarget } from "./dials.tsx";
import { missingFamily, type DialId } from "./dial-space.ts";
import { useWorkbench } from "./workbench-model.ts";
import { nextLaunchStep, type LaunchBlocker } from "./launch-step.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
type Sheet = "accounts" | "models" | "setup" | "sessions";
const SHEETS: readonly Sheet[] = ["accounts", "models", "setup", "sessions"];
const SHEET_TITLES: Readonly<Record<Sheet, string>> = { accounts: "Accounts", models: "Models", setup: "Setup", sessions: "Sessions" };
type Action = "save" | "review" | "launch" | "resume";
/** Why the primary cannot act, in a few words, with the one action that fixes it when there is one. */
type Blocked = { text: string; action?: { label: string; run: () => void } };
/** Exclusion reasons in plain words, for the verification details. */
const EXCLUSION_WORDS: Readonly<Record<string, string>> = {
  superseded: "Superseded by a newer model", unstable_id: "Unstable id", not_found: "Not found through your accounts",
  client_blocked: "Blocked for this client", regression: "Worse than a cheaper tier",
};
/** The keyboard-shortcuts popover: every panel key, grouped, each drawn with the host keycap. */
const SHORTCUTS: readonly (readonly [string, readonly (readonly [readonly string[], string])[]])[] = [
  ["Dials", [[["↑", "↓"], "Move between dials"], [["←", "→"], "Change the value"], [["Home", "End"], "First or last value"], [[keyCapLabel("d")], "Restore defaults"]]],
  ["Task", [[["/"], "Write the task"], [[keyCapLabel(LAUNCH_STROKE)], "Take the next step"], [["Esc"], "Leave the task"]]],
  ["Panels", [[["?"], "Keyboard shortcuts"], [[keyCapLabel("f")], "Show fallback chains"], [[keyCapLabel("i")], "Show model IDs"], [[keyCapLabel("r")], "Refresh usage"],
    [["↑", "↓"], "Move through roles and accounts"], [["↵"], "Pin a role"], [["Space"], "Include or exclude an account"], [["Esc"], "Back from a sheet"]]],
];

/** The nearest scrolling ancestor: the ScrollRegion viewport, whose scroll position the main view keeps across sheets. */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/** A provider's mark and name with a count (`● Codex 3`), as charge and review summaries list them. */
function ProviderCount({ family, name, count }: { family: string; name: string; count: ReactNode }) {
  return <span className={`${G}provider-count`}><span className="plugin-atyrode_code__mark" data-fam={hueOf(family)} aria-hidden="true" />{name} {count}</span>;
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
  const [ledger, setLedger] = useState<LedgerView>({ fallbacks: false, ids: false, pinned: new Set() });
  const [families, setFamilies] = useState<ReadonlySet<string> | null>(null);
  const [stripDetails, setStripDetails] = useState(false);
  const [pendingReview, setPendingReview] = useState(false);
  const [inFlight, setInFlight] = useState<Action | null>(null);
  const [outcome, setOutcome] = useState<{ kind: "Launched" | "Resumed"; machine: string } | null>(null);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const lastAction = useRef<{ action: Action; machine: string } | null>(null);
  const view = useRef<HTMLDivElement>(null);
  const task = useRef<HTMLTextAreaElement>(null);
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
  // `Save & review` is one gesture: the review follows once the saved revision is observed, never before.
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
    if (last.action === "launch" || last.action === "resume") setOutcome({ kind: last.action === "launch" ? "Launched" : "Resumed", machine: last.machine });
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
  // The task grows with its text from one line to six, then scrolls.
  useLayoutEffect(() => {
    const element = task.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight) || 17;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight + border, 6 * line + padding + border)}px`;
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
    view.current?.querySelector<HTMLElement>(`[data-zone="generator"] [role=radio][tabindex="0"]`)?.focus();
  }
  /** The shortcuts live in the More menu; their popover hangs from the same ⋯ button and returns focus there. */
  function openKeys() {
    keysMenu.anchor.current = moreMenu.anchor.current;
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
      case "configuration": return { text: "Profile not current", action: { label: "Retry", run: actions.refresh } };
      case "staged": return { text: "Staged catalog", action: { label: "Review in Models", run: () => openSheet("models") } };
      case "unsaved": return { text: "No active catalog", action: { label: "Models", run: () => openSheet("models") } };
      case "read-only": return { text: "Read-only workspace" };
      case "conflict": return { text: "Profile changed elsewhere", action: { label: "Use current", run: actions.discardChanges } };
      case "models": return { text: "Choices need a model review", action: { label: "Models", run: () => openSheet("models") } };
      case "verifying": return { text: "Verifying models" };
      case "verify-status": return { text: "Verification readiness unknown", action: { label: "Retry", run: actions.refresh } };
      case "verify-permissions": return { text: "Discovery not enabled", action: { label: "Enable", run: () => openSheet("setup") } };
      case "sessions": return { text: "Sessions unavailable here", action: { label: "Setup", run: () => openSheet("setup") } };
      case "permissions": return { text: "Sessions not enabled", action: { label: "Enable", run: () => openSheet("setup") } };
      case "skills": return { text: "Skill choices need attention", action: { label: "Options", run: optionsMenu.toggle } };
      case "unavailable":
        if (rosterError) return { text: "Machines unavailable", action: { label: "Retry", run: refreshMachines } };
        if (!machineId) return { text: "No machine chosen", action: { label: "Choose", run: machineMenu.toggle } };
        if (!machine) return { text: "Machine unavailable", action: { label: "Choose", run: machineMenu.toggle } };
        if (machine.revoked) return { text: `${machine.name} revoked`, ...otherMachine ? { action: { label: `Use ${otherMachine.name}`, run: () => select(otherMachine.id) } } : {} };
        return { text: `${machine.name} offline`, ...otherMachine ? { action: { label: `Use ${otherMachine.name}`, run: () => select(otherMachine.id) } } : {} };
    }
  }
  // While the first observation is pending there is nothing to retry yet; say what is happening instead.
  const blocked: Blocked | null = step.step === "blocked" ? (loading ? { text: "Reading the profile" } : blocker(step.reason))
    : uncovered ? { text: `No ${accountWord(uncovered)} account included`, action: { label: "Accounts", run: () => openSheet("accounts") } } : null;
  const verifyRunning = verification.phase === "inventory" || verification.phase === "benchmark";
  const nextLabel = verifyRunning ? (verification.phase === "inventory" ? "Checking models…" : "Verifying…")
    : busy && inFlight ? { save: "Saving…", review: "Reviewing…", launch: "Launching…", resume: "Resuming…" }[inFlight]
    : busy ? "Working…" : pendingReview ? "Reviewing…"
    : step.step === "verify" ? (verification.canConfirm ? "Confirm" : "Verify models")
    : step.step === "save" ? "Save & review" : step.step === "launch" ? "Launch" : step.step === "review" ? "Review"
    : verification.status !== "current" ? "Verify models" : model.previewCurrent ? "Launch" : unsaved && localDraft ? "Save & review" : "Review";
  const nextTitle = blocked ? blocked.text
    : step.step === "verify" ? (verification.canConfirm ? "Spend the tiny requests shown, then save the verified models and this profile"
      : "Check which models your accounts can reach; nothing is spent until you confirm the charge")
    : step.step === "launch" ? `Open a terminal on ${machineName ?? "the machine"} with this reviewed profile`
    : step.step === "save" ? "Save the profile, then check accounts, models and machine"
    : "Check accounts, models and machine before anything runs";
  const optionsSummary = automation ? "Restricted" : skillChoice?.mode === "disabled" ? "Skills off"
    : skillChoice?.mode === "select" ? `${skillChoice.skillIds.length + skillChoice.setIds.length} skills` : null;

  // ------------------------------------------------------------ masthead status: verification, write access, then where the profile stands
  const save = canSave && <Button disabled={busy} onClick={() => void run("save", actions.saveProfile)}>Save</Button>;
  const staged = <><State tone="warn" title="A staged catalog waits for review">Staged catalog</State><Button onClick={() => openSheet("models")}>Review in Models</Button></>;
  function statusLine(): ReactNode {
    if (loading) return null;
    if (configuration.error && !profile) return <><State tone="attention">Profile unavailable</State><Button onClick={configuration.refresh}>Retry</Button></>;
    if (stale) return <><State tone="attention">Changed elsewhere</State>
      <Button onClick={() => void keepCopy()}>{copied === "copied" ? "Copied" : "Keep a copy"}</Button><Button onClick={actions.discardChanges}>Use current</Button></>;
    if (configuration.error) return <><State tone="warn">Not current</State><Button onClick={configuration.refresh}>Retry</Button></>;
    const verified = verification.status === "current" && !verifyRunning;
    const progress = busy && inFlight === "save" ? <State>Saving…</State>
      : !verified && (verification.status === "verifying" || verifyRunning) ? <State tone="on">Verifying…</State>
      : !verified ? <><State tone="warn" title="These models are not verified against your current accounts and OMP">
        {verification.status === "accounts-changed" ? "Accounts changed" : verification.status === "omp-changed" ? "OMP updated" : "Unverified"}</State>
        {verification.canPrepare && step.step !== "verify" && <Button onClick={() => void verification.prepare()}>Verify</Button>}</> : null;
    const access = !writable && <State title="Your role can explore these choices but not save them">Read-only</State>;
    const standing = !writable && localDraft ? <State title="Shown here only; nothing is saved">Local preview</State>
      : profile?.source === "starter" ? <><State>Starter</State>{save}</>
      : profile?.source === "draft" ? staged
      : localDraft ? <><State tone="warn">Unsaved</State>{save}<Button disabled={busy} onClick={actions.discardChanges}>Revert</Button></>
      : record?.draft ? staged
      : verified && writable ? <State>Saved</State> : null;
    return <>{progress}{access}{standing}</>;
  }

  // ------------------------------------------------------------ sections
  const notices = [
    (metadata.error || starterError) && !record?.active && <Notice key="metadata" kind="error" details={metadata.error ?? starterError}
      actions={<><Button onClick={metadata.refresh}>Retry</Button><Button onClick={() => openSheet("models")}>Models</Button></>}>The model list is unavailable.</Notice>,
    configuration.error && profile && <Notice key="configuration" kind="warn" details={configuration.error}
      actions={<Button onClick={configuration.refresh}>Retry</Button>}>Shared choices are not current; showing the last read.</Notice>,
    compiled && selection && !localReview && <Notice key="review" kind="warn" actions={<Button onClick={() => openSheet("models")}>Models</Button>}>These choices need a model review.</Notice>,
  ].filter(Boolean);
  const generator = loading ? <GeneratorPlaceholder loading />
    : configuration.error && !profile ? <GeneratorPlaceholder loading={false} notice={<Notice kind="error" details={configuration.error}
      actions={<Button onClick={configuration.refresh}>Retry</Button>}>The profile is unavailable.</Notice>} />
    : !compiled || !selection || !dialModel || !controlsReview ? <GeneratorPlaceholder loading={false} notice={notices.length ? notices
      : <div className={`${G}empty-state`}><p>These choices do not form a profile yet.</p><Button onClick={() => openSheet("models")}>Open Models</Button></div>} />
    : <GeneratorZone model={dialModel} disabled={busy} onChange={updateSelection} estimates={controlsReview.estimates}
      previewEstimates={previewReview?.estimates ?? null} measured={controlsReview.routes.every(route => compiled.model(route.lead.key).tokensPerSecond !== null)}
      onDefaults={restoreDefaults} moreOpen={moreOpen} setMoreOpen={setMoreOpen} notice={notices.length ? <div className={`${G}notices`}>{notices}</div> : null} />;

  const verificationLine = verifyRunning ? <div className={`${G}status-line`} role="status">
    <Spinner label={verification.phase === "inventory" ? "Checking models…" : "Verifying…"} />
    {(verification.progress?.providers ?? []).map(entry => <ProviderCount key={entry.provider} family={providerPolicy(entry.provider).family}
      name={accountWord(providerPolicy(entry.provider).family, entry.provider)} count={`${entry.done}/${entry.total}`} />)}
    <Button onClick={verification.cancel}>Cancel</Button>
  </div> : verification.status === "current" && verification.exclusions ? <>
    <div className={`${G}status-line`} role="status">
      <State tone="ok">Verified</State>
      <span>{compiled?.models.length ?? 0} models, {verification.exclusions.length} excluded</span>
      {verification.exclusions.length > 0 && <Button aria-expanded={verifyDetails} onClick={() => setVerifyDetails(!verifyDetails)}>{verifyDetails ? "Hide details" : "Details"}</Button>}
    </div>
    {verifyDetails && <ul className={`${G}exclusions`}>{verification.exclusions.map(exclusion => <li key={`${exclusion.provider}/${exclusion.id}`}>
      <code>{exclusion.provider}/{exclusion.id}</code><span>{EXCLUSION_WORDS[exclusion.reason]}</span></li>)}</ul>}
  </> : undefined;

  // Providers in the family order the rest of the panel uses (Codex, Claude, DeepSeek, then others).
  const familyRank = (provider: string) => (["openai", "anthropic", "deepseek"].indexOf(providerPolicy(provider).family) + 1) || 99;
  const pool = launchReview ? Object.entries(launchReview.composition.accountPool).sort(([left], [right]) => familyRank(left) - familyRank(right)) : [];
  const poolCounts = new Map<string, { family: string; count: number }>();
  for (const [provider, accounts] of pool) {
    const family = providerPolicy(provider).family;
    const word = accountWord(family, provider);
    poolCounts.set(word, { family, count: (poolCounts.get(word)?.count ?? 0) + accounts.length });
  }
  const destinationName = machines === null ? "Machines" : machine?.name ?? (machineId ? "Unavailable" : "Choose machine");
  const destinationState = machines === null ? "checking" : machine?.revoked ? "access revoked" : available ? "online" : "unavailable";

  // ------------------------------------------------------------ render
  const main = <div ref={view} className={`${G}view`} data-view="main" hidden={sheet !== null} onKeyDown={shortcuts}>
    <header className={`${G}masthead`}>
      <h1 className={`${G}title`}>Code</h1>
      <div className={`${G}status`} role="status">{statusLine()}</div>
      <div className={`${G}masthead-actions`}>
        <button ref={machineMenu.anchor} type="button" className={`plugin-atyrode_code__button ${G}destination`} aria-haspopup="menu" aria-expanded={machineMenu.open}
          aria-label={`Run on ${destinationName}, ${destinationState}`} title={rosterError ?? (machineId && machines && !machine ? "The selected machine is not in your machine list; nothing else will be used" : `Sessions launch on ${destinationName}`)}
          onClick={machineMenu.toggle}>
          <ItemIcon kind="machine" size={14} />
          <span className={`${G}destination-name`}>{destinationName}</span>
          <span className="plugin-atyrode_code__dot" data-state={machines === null ? "warn" : available ? "ok" : "off"} aria-hidden="true" />
          <ControlIcon kind="disclosed" size={14} />
        </button>
        <Menu menu={machineMenu} label="Run on" align="end">
          <MenuHeader>Run on</MenuHeader>
          {machines === null && !rosterError && <MenuItem disabled onSelect={() => {}}>Reading machines…</MenuItem>}
          {machines?.map(entry => <MenuItem key={entry.id} current={entry.id === machineId} onSelect={() => select(entry.id)}
            aside={<><span className="plugin-atyrode_code__dot" data-state={entry.revoked ? "off" : entry.online ? "ok" : "off"} aria-hidden="true" />{entry.revoked ? "Revoked" : entry.online ? "Online" : "Offline"}</>}>{entry.name}</MenuItem>)}
          {machineId && machines && !machine && <MenuItem current disabled onSelect={() => {}} aside="Unavailable">Selected machine</MenuItem>}
          {rosterError && <MenuHeader>{rosterError}</MenuHeader>}
          <MenuRule />
          <MenuItem onSelect={refreshMachines}>Refresh machines</MenuItem>
          <MenuItem onSelect={() => openSheet("setup")}>Setup…</MenuItem>
        </Menu>
        <IconButton icon="more" label="More" buttonRef={moreMenu.anchor} aria-haspopup="menu" aria-expanded={moreMenu.open} onClick={moreMenu.toggle} />
        <Menu menu={moreMenu} label="More" align="end">
          {SHEETS.map(name => <MenuItem key={name} onSelect={() => openSheet(name)}>{SHEET_TITLES[name]}</MenuItem>)}
          <MenuRule />
          <MenuItem disabled={!compiled || busy} aside={<KeyCap label={keyCapLabel("d")} />} onSelect={restoreDefaults}>Restore defaults</MenuItem>
          <MenuItem aside={<KeyCap label="?" />} onSelect={openKeys}>Keyboard shortcuts</MenuItem>
        </Menu>
      </div>
    </header>
    <div className={`${G}split`}>
      {generator}
      <RoutingZone review={review} catalog={compiled} aliases={aliases} preview={previewReview} view={ledger} onToggle={toggleLedger} onPin={pin}
        empty={loading ? "loading" : configuration.error && !profile ? "failed" : "incomplete"}
        line={verificationLine} />
    </div>
    <UsageZone host={host} className={`${G}section ${G}usage`} onAccounts={() => openSheet("accounts")} onObservation={setAccountObservation} onFamilies={setFamilies} refresher={usageRefresh} />
    <div className={`${G}dock`} data-zone="composer">
      {verification.phase === "charge" && verification.charge && <Notice className={`${G}dock-note`} actions={<>
        <Button data-action="atyrode.code.verifyModels" onClick={() => void verification.confirm()}>Confirm</Button>
        <Button onClick={verification.cancel}>Cancel</Button>
      </>}>
        <span className={`${G}facts`}><strong>Verify models</strong>{verification.charge.providers.map(entry => <ProviderCount key={entry.provider}
          family={providerPolicy(entry.provider).family} name={accountWord(providerPolicy(entry.provider).family, entry.provider)} count={entry.requests} />)}
          <span>{verification.charge.requests} tiny {verification.charge.requests === 1 ? "request" : "requests"} through your accounts</span></span>
      </Notice>}
      {verification.failure && !verifyRunning && verification.phase !== "charge" && <Notice kind={verification.failure.cancelled ? "info" : "error"} className={`${G}dock-note`}
        details={verification.failure.evidence ? JSON.stringify(verification.failure.evidence, null, 2) : null}
        actions={verification.canPrepare ? <Button onClick={() => void verification.prepare()}>Retry</Button> : undefined}>
        {verification.failure.cancelled ? "Verification cancelled." : `Verification stopped at ${verification.failure.step}: ${verification.failure.reason}`}
      </Notice>}
      {launchReview && <Notice className={`${G}dock-note`} actions={<>
        <Button aria-expanded={stripDetails} onClick={() => setStripDetails(!stripDetails)}>{stripDetails ? "Hide details" : "Details"}</Button>
        {/* Re-setting the task is the workbench's own revocation: it drops the reviewed launch and nothing else. */}
        <Button onClick={() => { setStripDetails(false); setPrompt(prompt); task.current?.focus(); }}>Cancel</Button>
      </>}>
        <span className={`${G}facts`}><State tone="ok">Ready</State>{[...poolCounts].map(([word, { family, count }]) => <ProviderCount key={word} family={family} name={word} count={count} />)}
          <span>on {machineName ?? launchReview.destination.machineId}</span></span>
      </Notice>}
      {launchReview && stripDetails && <div className={`${G}review-details`}>
        <ul className={`${G}pool`}>{pool.flatMap(([provider, accounts]) => accounts.map(account => <li key={`${provider}:${account.credentialId}`}>
          <ProviderCount family={providerPolicy(provider).family} name={accountWord(providerPolicy(provider).family, provider)} count="" />
          <span className={`${G}pool-identity`}>{account.identityKey ?? `Slot ${account.credentialId}`}</span>
          <code>{account.scope}</code>
        </li>))}</ul>
        <Details label="Review JSON">{JSON.stringify({ composition: launchReview.composition, native: launchReview.native }, null, 2)}</Details>
      </div>}
      {outcome && !launchReview && <Notice className={`${G}dock-note`} actions={<Button onClick={() => openSheet("sessions")}>Sessions</Button>}>
        {outcome.kind} in a terminal on {outcome.machine}.
      </Notice>}
      {message?.failed && <Notice kind="error" className={`${G}dock-note`}>{message.text}</Notice>}
      <div className={`${G}composer`}>
        {/* Characters, because a textarea counts characters: the door's rule is bytes and
            refuses a multibyte prompt over it by name. */}
        <textarea ref={task} className={`${G}task`} rows={1} placeholder="Describe the task…" aria-label="Task" title={withKey("Task", "/")} spellCheck={false} maxLength={PROMPT_MAX_BYTES}
          value={prompt} onChange={event => { setOutcome(null); setPrompt(event.target.value); }} />
        <IconButton icon="settings" label="Launch options" buttonRef={optionsMenu.anchor} aria-haspopup="dialog" aria-expanded={optionsMenu.open} onClick={optionsMenu.toggle}
          title={`Launch options for this session only: ${optionsSummary ?? "ordinary session, default skills"}`} />
        <PrimaryButton className={`${G}primary`} disabled={blocked !== null && !busy && !verifyRunning} busy={busy || pendingReview || verifyRunning} onClick={primary}
          data-action={step.step === "launch" ? "atyrode.omp.prepareSession" : step.step === "save" ? "atyrode.code.select" : "atyrode.omp.reviewSession"}
          title={withKey(nextTitle, LAUNCH_STROKE)}>{nextLabel}</PrimaryButton>
      </div>
      {(blocked || optionsSummary || canSuggest) && <div className={`${G}composer-status`}>
        {blocked && <span className={`${G}reason`}>{blocked.text}{blocked.action && <Button onClick={blocked.action.run}>{blocked.action.label}</Button>}</span>}
        {optionsSummary && <span className={`${G}options-summary`}>Options: {optionsSummary}</span>}
        {canSuggest && <Button buttonRef={suggestMenu.anchor} aria-haspopup="dialog" aria-expanded={suggestMenu.open} onClick={suggestMenu.toggle}
          title="Ask the configured classifier for a profile that fits this task">Suggest</Button>}
      </div>}
    </div>
    <Menu menu={optionsMenu} role="dialog" label="Launch options" placement="above" align="end" className={`${G}options-pop`}>
      <div className={`${G}pop-body ${G}legacy-pop`}>
        <p className={`${G}prose`}>For this launch only. The profile and its defaults stay as they are.</p>
        <Automation choice={automation} reviewed={launchReview ? launchReview.native.automation : null} disabled={busy || !writable || !available} change={setAutomation} />
        {automation && <p className="plugin-atyrode_code__warning">Restricted OMP tools; not an OS or network sandbox.</p>}
        <OptionalSkills catalog={skillCatalog.data} error={skillCatalog.error} choice={skillChoice} restricted={automation?.mode === "restricted"}
          reviewed={launchReview ? launchReview.native.skills : null} disabled={busy || !writable || !available} refresh={skillCatalog.refresh} change={setSkillChoice} />
      </div>
    </Menu>
    {canSuggest && <Menu menu={suggestMenu} role="dialog" label="Suggest a profile" placement="above" align="end" className={`${G}suggest-pop`}>
      <div className={`${G}pop-body`}>
        <p className={`${G}prose`}>Sends this task to the configured classifier. Nothing is saved; inspect the proposed changes first.</p>
        <div className={`${G}pop-actions`}>
          <PrimaryButton keyHint={false} data-autofocus="" data-action="atyrode.code.suggest" disabled={!canRequestSuggestion && !busy} busy={busy} onClick={() => void actions.suggest()}>{busy ? "Working…" : "Suggest"}</PrimaryButton>
        </div>
        {suggestionPromptTooLong && <Notice kind="warn">The classifier accepts up to 16,384 characters; the task is kept whole.</Notice>}
        {suggestion && <>
          <Notice>{suggestion.changed.length ? `Suggests changing ${suggestion.changed.join(", ")}.` : "Your profile already fits."}</Notice>
          {suggestion.changed.length > 0 && <dl className={`${G}suggested`}>{suggestion.changed.map(key => <div key={key}><dt>{key}</dt>
            <dd>{typeof suggestion.selection[key] === "object" ? JSON.stringify(suggestion.selection[key]) : String(suggestion.selection[key])}</dd></div>)}</dl>}
          <div className={`${G}pop-actions`}><Button disabled={busy || !canApplySuggestion} onClick={() => { actions.applySuggestion(); suggestMenu.close(true); }}>Try this profile</Button></div>
          {unsaved && <Notice kind="warn">Save or revert local changes before trying a suggestion.</Notice>}
          {suggestionStale && <Notice kind="warn">The profile or classifier changed; ask again.</Notice>}
        </>}
      </div>
    </Menu>}
    <Menu menu={keysMenu} role="dialog" label="Keyboard shortcuts" align="end" className={`${G}keys-pop`}>
      <div className={`${G}keys`}>
        {SHORTCUTS.map(([group, rows]) => <section key={group} className={`${G}keys-group`} aria-label={group}>
          <h3 className={`${G}keys-title`}>{group}</h3>
          <dl>{rows.map(([keys, label], index) => <div key={index} className={`${G}keys-row`}>
            <dt>{keys.map(key => <KeyCap key={key} label={key} />)}</dt><dd>{label}</dd>
          </div>)}</dl>
        </section>)}
      </div>
    </Menu>
  </div>;

  const sheetFrame = (name: Sheet, body: ReactNode, actionsNode?: ReactNode) => visited.includes(name) && <div key={name} className={`${G}sheet-host`} hidden={sheet !== name} onKeyDown={sheetKeys}>
    <SheetFrame name={SHEET_TITLES[name]} onBack={closeSheet} backRef={element => { backButtons.current[name] = element; }} actions={actionsNode}>
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
  // Map mode is pure presentation: hovering or keyboard-focusing a generator option previews its routes.
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
              <header className={`${G}masthead`}><h1 className={`${G}title`}>Code</h1></header>
              <div className={`${G}section`}><div className={`${G}empty-state`}><p>Open or create a workspace in Manifold to use Code here.</p></div></div>
            </div>}
        </ScrollRegion>
        <div ref={setLayer} className={`${G}layer`} />
      </LayerProvider>
    </ReadoutProvider>
  </div>;
}
export default { id: GENERATOR_PLUGIN_ID, panels: { [LAUNCHER_PANEL]: Launcher } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
