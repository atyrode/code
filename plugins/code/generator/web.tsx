import { useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { HostServices, PanelProps } from "@manifold/plugin";
import type { MachineSummary } from "@manifold/protocol";
import { prefersReducedMotion, ScrollRegion } from "@manifold/ui";
import { GENERATOR_PLUGIN_ID, LAUNCHER_PANEL, type Target } from "../contract.ts";
import { useCodeTarget } from "../machine-web.ts";
import { AccountsView } from "../accounts-view.tsx";
import { PermissionReview } from "../permission-review.tsx";
import { familyWord, SheetFrame, since } from "../ui.tsx";
import { CatalogWorkbench } from "./catalog-editor.tsx";
import { RuntimeSettings } from "./runtime-settings.tsx";
import { OptionalSkills } from "./skills.tsx";
import { Automation } from "./automation.tsx";
import { useWorkbench } from "./workbench-model.ts";
import { StatementLine, useAnnouncer, type TeamPreview } from "./statement.tsx";
import { STATEMENT_KEY_HELP } from "./statement-keys.ts";
import { teamWords } from "./statement-model.ts";
import { SeatBoard, useBoardModel } from "./seat-board.tsx";
import { modelListFailure } from "./board-model.ts";
import { BOARD_KEY_HELP } from "./pool-head.tsx";
import { EARLIER_KEY_HELP, EarlierStatements, SESSIONS_KEY_HELP, usePinnedRecents } from "./earlier.tsx";
import { pastMoment, type StatementWords } from "./earlier-model.ts";
import { KeysDialog, type KeyGroup } from "./keys-dialog.tsx";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
type Sheet = "accounts" | "models" | "setup" | "options";
/** The sheets the footer names in its run, in order; session options follows with its summary, then the keys. */
const SHEETS: readonly Sheet[] = ["accounts", "models", "setup"];
const SHEET_TITLES: Readonly<Record<Sheet, string>> = { accounts: "Accounts", models: "Models", setup: "Setup", options: "Session options" };
/** Exclusion reasons in plain words, for the last verification's details in Setup. */
const EXCLUSION_WORDS: Readonly<Record<string, string>> = {
  superseded: "Superseded by a newer model", unstable_id: "Unstable id", not_found: "Not found through your accounts",
  client_blocked: "Blocked for this client", regression: "Worse than a cheaper tier",
};
/** Every key the main view answers, grouped by the region that answers it. */
const KEY_GROUPS: readonly KeyGroup[] = [
  { title: "statement", keys: STATEMENT_KEY_HELP },
  { title: "pools", keys: BOARD_KEY_HELP },
  { title: "sessions", keys: SESSIONS_KEY_HELP },
  { title: "recent teams", keys: EARLIER_KEY_HELP },
  { title: "panel", keys: [
    { keys: ["r"], text: "Read accounts, usage and machines again" },
    { keys: ["?"], text: "Show these keys" },
    { keys: ["Esc"], text: "Back from accounts, models, setup or session options" },
  ] },
];
const NO_WORDS: StatementWords = { lane: "", tier: "", thinking: "", advisor: "", extras: "", machine: "" };

/** The nearest scrolling ancestor: the ScrollRegion viewport, whose scroll position the main view keeps across sheets. */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

type WorkbenchProps = {
  host: HostServices; target: Target | null; machine: MachineSummary | null; machines: readonly MachineSummary[] | null; machineId: string | null;
  rosterError: string | null; available: boolean; select: (id: string) => void; refreshMachines: () => void; layer: HTMLElement | null;
};

/**
 * The main view, top to bottom: the statement (the verb, the team's words and two status lines),
 * the seat board under its quota pools, the earlier statements, and a footer with provenance and the
 * ways into Accounts, Models and Setup, which open as sheets over the main view.
 */
function Workbench({ host, target, machine, machines, machineId, rosterError, available, select, refreshMachines, layer }: WorkbenchProps) {
  const model = useWorkbench({ host, target, machine, rosterError, available });
  const { queries: { metadata, setup, skillCatalog }, record, observed, starterError, compiled, selection, profile, localDraft,
    configurationCurrent, launchReady, launchReview, busy, writable, verification, usage, exportedDraft, actions } = model;
  const { pools, outcomes } = useBoardModel(model, usage);
  const recents = usePinnedRecents(model.recentTeams);
  const { region, announce } = useAnnouncer();
  const [preview, setPreview] = useState<TeamPreview | null>(null);
  // Bumped by every panel refresh, so the earlier statements read again the machines they have read.
  const [rereads, setRereads] = useState(0);
  const [keysOpen, setKeysOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [visited, setVisited] = useState<readonly Sheet[]>([]);
  const view = useRef<HTMLDivElement>(null);
  const backButtons = useRef<Partial<Record<Sheet, HTMLButtonElement | null>>>({});
  const sheetLinks = useRef<Partial<Record<Sheet, HTMLButtonElement | null>>>({});
  const returnFocus = useRef<HTMLElement | null>(null);
  const mainScroll = useRef(0);
  const currentSheet = useRef(sheet);
  currentSheet.current = sheet;
  // The line's measured width while it is one line, the measure the footer's run (and anything else that should end with the line) keeps to.
  const [measure, setMeasure] = useState<number | null>(null);
  // The roster is polled; the statement's options are recomputed only when it really changes.
  const machinesKey = JSON.stringify(machines);
  const roster = useMemo(() => machines, [machinesKey]);
  const line = useMemo<StatementWords>(() => selection ? { ...teamWords(selection, familyWord), machine: machine?.name ?? "" } : NO_WORDS,
    [selection, machine?.name]);

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
    const closing = currentSheet.current;
    setSheet(null);
    actions.refresh();
    // A sheet opened from somewhere that has since gone returns focus to its own link in the footer.
    if (closing && !(returnFocus.current?.isConnected && returnFocus.current.offsetParent !== null)) returnFocus.current = sheetLinks.current[closing] ?? null;
  }
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
    returnFocus.current?.focus({ preventScroll: true });
  }, [sheet]);
  function finish(source: Sheet) {
    if (currentSheet.current === source) closeSheet();
    else actions.refresh();
  }
  function sheetKeys(event: KeyboardEvent<HTMLDivElement>) {
    const element = event.target as HTMLElement;
    // Native dialogs and form fields own Escape inside legacy sheet content.
    if (event.key !== "Escape" || event.defaultPrevented || element.closest("dialog") || element.matches("textarea, input, select")) return;
    event.preventDefault();
    closeSheet();
  }

  // ------------------------------------------------------------ what `r` and the footer reach (the statement's fixes open sheets directly)
  function refresh() {
    actions.refresh();
    refreshMachines();
    setRereads(count => count + 1);
  }
  // The Accounts sheet's own edits wait while a step runs or a charge waits, as the pool heads' do; read-only it says itself.
  const accountsGate = model.gate("edit-accounts");
  const accountsLocked = !accountsGate.open && (accountsGate.refusal.code === "running" || accountsGate.refusal.code === "charge") ? accountsGate.refusal.text : null;

  // ------------------------------------------------------------ session options: for one launch or resume, never saved
  const chosenSkills = model.skillChoice?.mode === "select" ? model.skillChoice.skillIds.length + model.skillChoice.setIds.length : 0;
  const optionsSummary = model.automation ? "restricted" : model.skillChoice?.mode === "disabled" ? "skills off"
    : model.skillChoice?.mode === "select" ? `${chosenSkills} ${chosenSkills === 1 ? "skill" : "skills"}` : null;
  // The options wait while a step runs or a charge waits, as the team's words do, and need what a launch needs: write access and the machine.
  const optionsGate = model.gate("edit-options");
  const optionsRefusal = !optionsGate.open ? optionsGate.refusal.text : !writable ? "Edit access needed." : !available ? "The machine is unavailable."
    : busy ? "Wait for the step in progress." : null;

  // ------------------------------------------------------------ the footer: where the facts come from, and the ways out
  const verified = verification.provenance ? `models verified ${pastMoment(verification.provenance.benchmarkCompletedAt, usage.nowMs)}` : "models unverified";
  // The read's age only while every pool's reading is current; a stale pool states its own age in its head, and the footer never contradicts it.
  const read = usage.view?.observedAt && usage.current && pools.every(pool => pool.staleAgeMs === null) ? `usage read ${since(usage.nowMs - usage.view.observedAt)}` : null;
  // A staged catalog beside the active one changes nothing until it is reviewed in Models; the verb speaks only for a staged-only workspace.
  const staged = record?.active && record.draft ? "a staged catalog waits in models" : null;
  const facts = [verified, read, staged].filter(Boolean).join(" · ");
  // The bundled list's failure is said in the status lines, with its retry and Models; the seats of a team the model holds stay, and
  // with no team to seat there is no board.
  const listFailure = modelListFailure(Boolean(metadata.error || starterError), Boolean(record?.active), model.document !== null);

  const main = <div ref={view} className={`${G}view`} data-view="main" hidden={sheet !== null}
    style={measure === null ? undefined : { "--stmt-measure": `${measure}px` } as CSSProperties}>
    <h1 className="plugin-atyrode_code__sr">Code</h1>
    <StatementLine model={model} active={sheet === null} preview={preview} setPreview={setPreview} pools={pools} machines={roster} selectMachine={select} recents={recents}
      announce={announce} onOpen={openSheet} onKeys={() => setKeysOpen(true)} onRefresh={refresh} listFailure={listFailure !== "none"} onMeasure={setMeasure} />
    {listFailure !== "instead" && <SeatBoard model={model} usage={usage} preview={preview} pools={pools} outcomes={outcomes} />}
    <EarlierStatements host={host} model={model} line={line} recents={recents} pools={pools} setPreview={setPreview} rereads={rereads} announce={announce} />
    {/* One left-aligned run on the line's measure: the facts, then the ways out, session options with its choice, the keys. */}
    <footer className={`${G}footer`}>
      <span className={`${G}footer-facts`}>{facts}</span>
      <button type="button" className={`${G}footer-link`} title="Read accounts, usage and machines again (r)" onClick={refresh}>refresh</button>
      {SHEETS.map(name => <button key={name} ref={element => { sheetLinks.current[name] = element; }} type="button" className={`${G}footer-link`}
        onClick={() => openSheet(name)}>{name}</button>)}
      <button ref={element => { sheetLinks.current.options = element; }} type="button" className={`${G}footer-link`}
        aria-label={`Session options: ${optionsSummary ?? "ordinary session, default skills"}`} title="Skills and automation for the next launch or resume only"
        onClick={() => openSheet("options")}>session options{optionsSummary && <span className={`${G}footer-summary`}> · {optionsSummary}</span>}</button>
      <button type="button" className={`${G}footer-link`} aria-haspopup="dialog" aria-expanded={keysOpen} aria-label="Keys" onClick={() => setKeysOpen(true)}>keys ?</button>
    </footer>
  </div>;

  const sheetFrame = (name: Sheet, body: ReactNode) => visited.includes(name) && <div key={name} className={`${G}sheet-host`} hidden={sheet !== name} onKeyDown={sheetKeys}>
    <SheetFrame name={SHEET_TITLES[name]} onBack={closeSheet} backRef={element => { backButtons.current[name] = element; }}>
      {/* Session options is in the main view's grammar; the other sheets keep their original layout until their own pass. */}
      <div className={name === "options" ? `${G}options` : `${G}legacy`}>{body}</div>
    </SheetFrame>
  </div>;

  return <>
    {region}
    {main}
    {layer && createPortal(<KeysDialog open={keysOpen} groups={KEY_GROUPS} onClose={() => setKeysOpen(false)} />, layer)}
    {sheetFrame("accounts", <AccountsView host={host} target={target} available={available} onDone={() => finish("accounts")} locked={accountsLocked} />)}
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
      <p className={`${G}options-lede`}>For the next launch or resume only; the workspace team stays as it is.</p>
      {optionsRefusal && <p className={`${G}options-note`} role="status">{optionsRefusal}</p>}
      <Automation choice={model.automation} reviewed={launchReview ? launchReview.native.automation : null} refusal={optionsRefusal} change={model.setAutomation} />
      <OptionalSkills catalog={skillCatalog.data} error={skillCatalog.error} choice={model.skillChoice} restricted={model.automation?.mode === "restricted"}
        reviewed={launchReview ? launchReview.native.skills : null} refusal={optionsRefusal} refresh={skillCatalog.refresh} change={model.setSkillChoice} />
    </>)}
  </>;
}

function Launcher({ host }: PanelProps) {
  const { machines, machine, machineId, target, available, error, select, refresh } = useCodeTarget(host);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  // The panel root takes focus when the panel opens (statement.tsx), so its keys work before anything is clicked.
  return <div className="plugin-atyrode_code plugin-atyrode_code_generator" tabIndex={-1}>
    <ScrollRegion className={`${G}scroll`} aria-label="Code workspace">
      {host.containerId ? <Workbench key={JSON.stringify([host.principal.id, host.containerId])} host={host} target={target} machine={machine} machines={machines}
        machineId={machineId} rosterError={error} available={available} select={select} refreshMachines={refresh} layer={layer} />
        : <div className={`${G}view`}>
          <h1 className="plugin-atyrode_code__sr">Code</h1>
          <div className={`${G}section`}><div className={`${G}empty-state`}><p>Open or create a workspace in Manifold to use Code here.</p></div></div>
        </div>}
    </ScrollRegion>
    {/* The overlay layer: the keys dialog renders here, so the scroll region neither clips nor scrolls it. */}
    <div ref={setLayer} className={`${G}layer`} />
  </div>;
}
export default { id: GENERATOR_PLUGIN_ID, panels: { [LAUNCHER_PANEL]: Launcher } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
