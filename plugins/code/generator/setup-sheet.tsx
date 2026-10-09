import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import type { HostServices } from "@manifold/plugin";
import type { MachineSummary, ServicePolicy } from "@manifold/protocol";
import { BENCHMARK_OPERATION_ID, INVENTORY_OPERATION_ID, LAUNCH_OPERATION_ID, PREPARE_WORKSPACE_OPERATION_ID, VALIDATE_WORKSPACE_OPERATION_ID } from "@atyrode/manifold-omp";
import type { ActionInput, ActionResult, PermissionFeatureId, Target } from "../contract.ts";
import type { OmpPresence } from "../destination.ts";
import { canWriteCodeWorkspace, codeOperationFailure, codeWorkflow, useCodeQuery, useOmpRuns } from "../machine-web.ts";
import { HARNESS_OPERATION_ID, operationReady } from "../permission-plan.ts";
import { PermissionDialog } from "../permission-review.tsx";
import { since, useMinuteTick } from "../ui.tsx";
import { Glyph } from "./dial-row.tsx";
import { Mark, pressesGo, SheetGo, SheetHead, SheetKeys, SheetReadout, sheetKeyFree, useReadout, useSheetMode, Words,
  type GoAction, type GoHandle, type GoPress, type GoTone, type Said } from "./sheet-frame.tsx";
import { modelRows, nextSetupRow, SETUP_ROWS, setupRows, type FolderMode, type SetupFacts, type SetupRowId } from "./sheets-model.ts";
import type { WorkbenchModel } from "./workbench-model.ts";

/*
 * Setup: what the chosen machine needs before Code can verify and launch there, as rows like the
 * generator's (a square mark, a label, the value), the first one with a fix due pointed, its fix the
 * one next action. Every fix is reviewed by its native owner (the permission review, OMP's folder
 * jobs, the classifier's reviewed policy); Code changes nothing itself. Beside the rows, the
 * profile's facts and the optional classifier.
 */

/** Generator-panel class prefix; styles.css, "the Models and Setup sheets". */
const G = "plugin-atyrode_code_generator__";
const CHEVRON = "M4.5 6.5 8 10l3.5-3.5";
const RUNNING = new Set(["queued", "admitted", "start-committed", "started"]);
const FOLDER_ROUTES: Readonly<Record<FolderMode, string>> = { existing: VALIDATE_WORKSPACE_OPERATION_ID, create: PREPARE_WORKSPACE_OPERATION_ID };
/** What each row means, as the readout says it while the row is pointed or focused. */
const ABOUT: Readonly<Record<Exclude<SetupRowId, "machine" | "omp" | "folders">, string>> = {
  connection: "the model gateway connects OMP to your account broker; it moves no credentials and starts no request",
  discovery: "lets Code read the models your accounts reach and measure them; verifying models needs it",
  sessions: "lets Code open OMP sessions here",
};
const FOLDERS: Readonly<Record<FolderMode, string>> = {
  existing: "checks your workspace and session folders without changing them",
  create: "creates the workspace and session folders; existing ones are never overwritten",
};

export type SetupSheetProps = {
  host: HostServices;
  model: WorkbenchModel;
  target: Target | null;
  machine: MachineSummary | null;
  machines: readonly MachineSummary[] | null;
  rosterError: string | null;
  presence: ReadonlyMap<string, OmpPresence> | null;
  select: (machineId: string) => void;
  refreshMachines: () => void;
  onBack: () => void;
  backRef: Ref<HTMLButtonElement>;
  /** Where a profile fact leads: Models. */
  onPlace: (place: "models") => void;
  /** Setup is the open sheet; it stays mounted, hidden, once visited. */
  open: boolean;
};
type Primary = GoAction & { readonly said: Said; readonly press: GoPress };
type Classifier = { readonly mode: "off" | "ollama"; readonly origin: string; readonly model: string };
type ServiceReview = { input: ActionInput<"reviewServices">; result: ActionResult<"reviewServices">; scope: string };

/** The classifier in use: Code's `suggest` policy, its origin and the model it names; null when none is configured. */
function appliedClassifier(policies: readonly ServicePolicy[]): { origin: string; model: string } | null {
  const policy = policies.find(candidate => candidate.serviceId === "suggest");
  if (!policy) return null;
  const classify = policy.operations.classify;
  const field = classify && "body" in classify ? classify.body.find(entry => entry.path.length === 1 && entry.path[0] === "model") : undefined;
  return { origin: policy.origin ?? "", model: field && "literal" in field.value && typeof field.value.literal === "string" ? field.value.literal : "" };
}

export function SetupSheet({ host, model, target, machine, machines, rosterError, presence, select, refreshMachines, onBack, backRef, onPlace, open }: SetupSheetProps) {
  const root = useRef<HTMLElement>(null);
  const go = useRef<GoHandle>(null);
  const machineSelect = useRef<HTMLSelectElement>(null);
  const mode = useSheetMode(root);
  useMinuteTick();
  const setup = model.queries.setup;
  const machineId = target?.machineId ?? "";
  const where = machine?.name ?? "this machine";
  const writable = canWriteCodeWorkspace(host);
  // Only the instance owner reads and configures the classifier's native policy.
  const owner = writable && host.client.selfCaps().includes("*");
  const creation = useOmpRuns(host, target, PREPARE_WORKSPACE_OPERATION_ID);
  const validation = useOmpRuns(host, target, VALIDATE_WORKSPACE_OPERATION_ID);
  const services = useCodeQuery(host, "readServiceConfiguration", owner ? target : null);
  const [folderMode, setFolderMode] = useState<FolderMode>("existing");
  const [review, setReview] = useState<{ intent: PermissionFeatureId; label: string } | null>(null);
  const [working, setWorking] = useState<"folders" | "classifier" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [draft, setDraft] = useState<Classifier | null>(null);
  const [serviceReview, setServiceReview] = useState<ServiceReview | null>(null);
  const scope = JSON.stringify([host.principal.id, host.containerId, machineId]);
  const generation = useRef({ scope, count: 0 });
  if (generation.current.scope !== scope) generation.current = { scope, count: generation.current.count + 1 };
  const pending = useRef(false);
  const mounted = useRef(false);
  const latestHost = useRef(host);
  latestHost.current = host;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Opening a sheet reads everything once (read-clock.ts), but the panel's pass reads only the panel's own inputs: the
  // folder jobs and the classifier's policy are Setup's, so it reads them as it opens, or a job finished since shows late.
  useEffect(() => {
    if (!open) return;
    creation.refresh(); validation.refresh(); services.refresh();
  }, [open]);
  // Another machine, another set of fixes: what was reviewed or drafted for the last one does not carry over.
  useEffect(() => { setReview(null); setFailure(null); setDraft(null); setServiceReview(null); }, [scope]);

  // ------------------------------------------------------------ what the machine has
  const matching = (["create", "existing"] as const).flatMap(route => {
    const history = route === "create" ? creation : validation, operationId = FOLDER_ROUTES[route];
    const pins = setup.data?.operations.find(operation => operation.operationId === operationId)?.pins;
    // Folders are ready only by a job matching this machine's current operation, installation, artifact and bindings.
    return history.runs?.flatMap(run => run.job && pins && run.job.machineId === machineId && run.job.operationId === operationId &&
      run.job.installationRevision === pins.installationRevision && run.job.artifactSha256 === pins.artifactSha256 &&
      run.job.resourceBindingDigest === pins.resourceBindingDigest ? [run.job] : []) ?? [];
  });
  const prepared = matching.some(job => job.state === "exited" && job.result?.exitCode === 0);
  const preparing = matching.some(job => RUNNING.has(job.state));
  const historyKnown = creation.runs !== null && validation.runs !== null && creation.error === null && validation.error === null;
  const ompAbsent = setup.code === "omp_operation_unavailable";
  const facts: SetupFacts = {
    machine: machine && { name: machine.name, online: machine.online && machine.revoked !== true },
    rosterError: rosterError !== null,
    omp: ompAbsent ? "absent" : setup.data ? "ok" : machine ? presence?.get(machine.id) ?? null : null,
    destinationError: setup.error !== null && !ompAbsent,
    connection: setup.data?.services.some(service => service.serviceId === "omp" && service.state === "ready") === true,
    discovery: operationReady(setup.data, INVENTORY_OPERATION_ID) && operationReady(setup.data, BENCHMARK_OPERATION_ID),
    sessions: operationReady(setup.data, LAUNCH_OPERATION_ID) && operationReady(setup.data, HARNESS_OPERATION_ID),
    folders: prepared ? "ready" : preparing || working === "folders" ? "busy" : historyKnown && setup.data ? "todo" : null,
    folderMode,
  };
  const rows = setupRows(facts);
  const busy = working !== null || facts.folders === "busy";
  const nextRow = busy ? null : nextSetupRow(rows);
  const todo = SETUP_ROWS.filter(id => rows[id].state === "todo").length;
  const otherReady = machines?.find(candidate => candidate.id !== machineId && candidate.online && candidate.revoked !== true && presence?.get(candidate.id) === "ok") ?? null;

  // ------------------------------------------------------------ the classifier: off, or an Ollama origin and model, reviewed then applied
  const applied = services.data ? appliedClassifier(services.data.configuration.policies) : null;
  const classifier: Classifier = draft ?? { mode: applied ? "ollama" : "off", origin: applied?.origin ?? "", model: applied?.model ?? "" };
  const change = classifier.mode === "ollama"
    ? classifier.origin.trim() && classifier.model.trim() && !(applied && applied.origin === classifier.origin.trim() && applied.model === classifier.model.trim()) ? "on" : null
    : applied ? "off" : null;
  const reviewCurrent = serviceReview !== null && serviceReview.scope === scope && services.data?.configuration.revision === serviceReview.input.expectedServiceRevision;
  const classifierRefusal = !owner ? "Only the instance owner configures the classifier." : services.error ? services.error
    : !services.data?.connected ? `The service runtime on ${where} is not connected.` : null;
  function draftClassifier(next: Classifier) {
    setDraft(next);
    setServiceReview(null);
  }

  // ------------------------------------------------------------ fixes: reviewed at their native owners, one at a time
  function refresh() {
    setup.refresh(); creation.refresh(); validation.refresh(); services.refresh();
    refreshMachines(); model.actions.refresh();
  }
  async function perform(kind: "folders" | "classifier", work: (workflow: ReturnType<typeof codeWorkflow>) => Promise<Said | null>) {
    if (pending.current) return;
    const issued = generation.current.count, started = host;
    const valid = () => mounted.current && generation.current.count === issued && latestHost.current.client === started.client &&
      latestHost.current.principal.id === started.principal.id && canWriteCodeWorkspace(latestHost.current);
    pending.current = true; setWorking(kind); setFailure(null);
    try {
      const said = await work(codeWorkflow(host, valid));
      if (valid() && said) readout.say(said);
    } catch (reason) {
      if (valid()) setFailure(codeOperationFailure(reason));
    } finally {
      pending.current = false;
      if (mounted.current) { setWorking(null); refresh(); }
    }
  }
  function runFolders() {
    if (!target) return;
    const at = target, route = folderMode;
    void perform("folders", async workflow => {
      await workflow.prepareWorkspace(at, route);
      return { value: route === "create" ? "creating folders" : "checking folders", text: `OMP runs the job on ${where}; its result is kept in OMP's history` };
    });
  }
  function reviewClassifier() {
    if (!target || !services.data || !change) return;
    const input: ActionInput<"reviewServices"> = { ...target, expectedServiceRevision: services.data.configuration.revision,
      classifier: change === "off" ? null : { origin: classifier.origin.trim(), model: classifier.model.trim() } };
    const reviewed = scope;
    void perform("classifier", async workflow => {
      const result = await workflow.code("reviewServices", input);
      setServiceReview({ input, result, scope: reviewed });
      return null;
    });
  }
  function applyClassifier() {
    if (!serviceReview) return;
    const { input, result } = serviceReview;
    void perform("classifier", async workflow => {
      await workflow.code("configureServices", { ...input, reviewDigest: result.reviewDigest });
      setServiceReview(null); setDraft(null);
      return input.classifier ? { value: "classifier on", text: `${input.classifier.model} at ${input.classifier.origin}` } : { value: "suggestions off", text: "nothing is sent" };
    });
  }

  // ------------------------------------------------------------ the one next action: the pointed row's fix
  const refused: readonly (readonly [string, GoTone | null])[] = failure ? [["refused", "attention"]] : [];
  const readOnly = !writable;
  function reviewing(intent: PermissionFeatureId, label: string, aside: string): Primary {
    if (readOnly) return { label, disabled: true, parts: [["Read-only workspace", "attention"]], fixes: [],
      said: { value: label, text: "edit access is needed to review changes on the machine", warn: true }, press: () => "Edit access needed." };
    return { label, parts: [...refused, [aside, null]], fixes: [],
      said: failure ? { value: label, text: failure, warn: true } : { value: label, text: `OMP shows exactly what it allows on ${where}; Code changes nothing itself` },
      press: () => { setReview({ intent, label }); return null; } };
  }
  function primary(): Primary {
    if (busy) return { label: working === "classifier" ? "reviewing…" : folderMode === "create" ? "creating folders…" : "checking folders…", busy: true,
      parts: [[`on ${where}`, null]], fixes: [], said: { value: "working", text: working === "classifier" ? "the machine's owner reviews the exact policy" : `OMP runs the job on ${where}; its result is kept in OMP's history` },
      press: () => "Wait for the job to finish." };
    switch (nextRow) {
      case "machine": {
        if (rosterError !== null && !machine) return { label: "check again", parts: [["Machine list unreadable", "attention"]], fixes: [],
          said: { value: "check again", text: rosterError, warn: true }, press: () => { refreshMachines(); return null; } };
        const said: Said = otherReady ? { value: `use ${otherReady.name}`, text: `${otherReady.name} is online and OMP answers there` }
          : { value: "machine", text: "no other machine is online with OMP" };
        return { label: otherReady ? `use ${otherReady.name}` : "choose a machine", parts: [[machine ? `${machine.name} is offline` : "No machine chosen", "attention"]], fixes: [], said,
          press: () => { if (otherReady) select(otherReady.id); else machineSelect.current?.focus(); return null; } };
      }
      case "omp": {
        if (ompAbsent && otherReady) return { label: `use ${otherReady.name}`, parts: [[`OMP isn't on ${where}`, "attention"]], fixes: [],
          said: { value: `use ${otherReady.name}`, text: `OMP answers on ${otherReady.name}; Code runs nothing on ${where} without it` }, press: () => { select(otherReady.id); return null; } };
        return { label: "check again", parts: [[ompAbsent ? `OMP isn't on ${where}` : "OMP is not answering", "attention"]], fixes: [],
          said: ompAbsent ? { value: "check again", text: `install OMP on ${where}, then check again` } : { value: "check again", text: setup.error ?? `OMP has not answered on ${where}`, warn: true },
          press: () => { refresh(); return null; } };
      }
      case "connection": return reviewing("gateway", "review connection", `on ${where}`);
      case "discovery": return reviewing("benchmark", "enable discovery", "verifying needs it");
      case "sessions": return reviewing("session", "enable sessions", "launching needs it");
      case "folders": {
        // A route its permission does not allow yet is reviewed first; an allowed one runs as a native job.
        if (!operationReady(setup.data, FOLDER_ROUTES[folderMode])) return reviewing(folderMode === "create" ? "workspace-create" : "workspace-existing",
          folderMode === "create" ? "enable folder creation" : "enable folder check", `on ${where}`);
        const label = folderMode === "create" ? "create folders" : "check folders";
        if (readOnly) return { label, disabled: true, parts: [["Read-only workspace", "attention"]], fixes: [], said: { value: label, text: "edit access is needed to prepare folders", warn: true }, press: () => "Edit access needed." };
        const lastFailed = matching.length > 0;
        return { label, parts: [...refused, [lastFailed ? "the last folder job did not succeed" : `on ${where}`, lastFailed ? "attention" : null]], fixes: [],
          said: failure ? { value: label, text: failure, warn: true } : { value: label, text: FOLDERS[folderMode] }, press: () => { runFolders(); return null; } };
      }
      case null: break;
    }
    if (change && classifierRefusal === null) {
      if (!reviewCurrent) return { label: "review classifier", parts: [...refused, [change === "off" ? "suggestions off" : "classifier changed", "strong"], ["not applied", null]], fixes: [],
        said: failure ? { value: "review classifier", text: failure, warn: true } : { value: "review classifier", text: "the machine's owner sees the exact policy before anything changes" },
        press: () => { reviewClassifier(); return null; } };
      return { label: "apply classifier", parts: [...refused, ["policy reviewed", "strong"]], fixes: [{ label: "back", run: () => setServiceReview(null) }],
        said: { value: "apply classifier", text: change === "off" ? "Code stops sending task descriptions" : `Code sends task descriptions to ${classifier.origin.trim()}` },
        press: () => { applyClassifier(); return null; } };
    }
    return { label: "back to code", parts: [[`ready on ${where}`, "done"]], fixes: [], said: { value: "back to code", text: `verify and launch on ${where}` },
      press: () => { onBack(); return null; } };
  }
  const next = primary();

  // ------------------------------------------------------------ the readout
  function describe(id: string): Said | null {
    if (id === "go") return next.said;
    if (id === "suggestions") return classifierRefusal ? { value: "classifier", text: classifierRefusal } : { value: "suggestions",
      text: classifier.mode === "off" ? "Code sends nothing to a classifier" : "Code sends task descriptions to the Ollama classifier you name, for profile suggestions" };
    if (!id.startsWith("row:")) return null;
    const row = id.slice(4) as SetupRowId, state = rows[row];
    if (row === "machine") return machine ? { value: machine.name, text: machine.revoked ? "access revoked" : machine.online ? "online" : "offline" }
      : { value: "machine", text: rosterError ?? "no machine chosen", warn: rosterError !== null };
    if (row === "omp") return { value: "omp", text: state.state === "ok" ? `OMP answers on ${where}` : ompAbsent ? `OMP isn't installed on ${where}`
      : state.state === "unknown" ? facts.machine?.online ? `waiting for OMP to answer on ${where}` : "the machine is unreachable" : setup.error ?? `OMP is not answering on ${where}`, warn: state.state === "todo" };
    if (state.state === "unknown") return { value: row, text: facts.machine?.online ? `known once OMP is on ${where}` : "the machine is unreachable" };
    if (row === "folders") return { value: "folders", text: matching.length > 0 && !prepared && !preparing ? `${FOLDERS[folderMode]} · the last folder job did not succeed; OMP's history has its result` : FOLDERS[folderMode] };
    return { value: row, text: ABOUT[row] };
  }
  const readout = useReadout(describe);

  // ------------------------------------------------------------ keys: ↑↓ over the rows, ←→ the folder route, ⏎ the action
  const [cursor, setCursor] = useState<SetupRowId>("omp");
  function stop(id: SetupRowId): HTMLElement | null {
    return root.current?.querySelector<HTMLElement>(`[data-row="${id}"] select, [data-row="${id}"] [data-roving]`) ?? null;
  }
  function move(by: number) {
    const active = root.current?.ownerDocument.activeElement ?? null;
    const at = SETUP_ROWS.findIndex(id => root.current?.querySelector(`[data-row="${id}"]`)?.contains(active) === true);
    const id = SETUP_ROWS[Math.max(0, Math.min(SETUP_ROWS.length - 1, at < 0 ? 0 : at + by))]!;
    setCursor(id);
    stop(id)?.focus();
  }
  function keys(event: KeyboardEvent<HTMLElement>) {
    if (!sheetKeyFree(event)) return;
    const target = event.target as HTMLElement;
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && target.closest(`.${G}setup-checks`)) {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && target.closest('[data-row="folders"]') && !target.matches('[role="radio"]')) {
      event.preventDefault();
      if (!busy) setFolderMode(event.key === "ArrowRight" ? "create" : "existing");
      return;
    }
    if (pressesGo(event)) { event.preventDefault(); go.current?.press(); }
  }

  // ------------------------------------------------------------ the profile's facts
  const record = model.record, active = record?.active ?? null;
  const inUse = useMemo(() => active ? modelRows(active.document).length : 0, [active]);
  const verifiedAt = model.verification.status === "current" ? model.verification.provenance?.benchmarkCompletedAt ?? null : null;
  const leftOut = model.verification.exclusions;
  const ompVersion = model.queries.metadata.data?.ompVersion ?? null;

  return <section ref={root} className={`${G}sheet`} data-sheet="setup" data-mode={mode} aria-label="Setup" onKeyDown={keys}>
    <SheetHead title="setup" onBack={onBack} backRef={backRef}
      state={<><b>{machine?.name ?? "no machine"}</b> · <span data-tone={todo > 0 && !busy ? "warn" : undefined}>{busy ? "working" : todo > 0 ? `${todo} to fix` : "ready"}</span></>} />
    <main className={`${G}sheet-stage`}>
      <section className={`${G}sheet-pane`} aria-label="readiness">
        <ul className={`${G}setup-checks`} aria-label="what this machine needs">
          {SETUP_ROWS.map(id => {
            const row = rows[id];
            return <li key={id} className={`${G}setup-check`} data-row={id} data-state={row.state} data-next={id === nextRow || undefined}>
              <span className={`${G}setup-ptr`} aria-hidden="true">▸</span>
              <Mark on={row.state === "ok" || row.state === "busy"} />
              <span className={`${G}setup-lab`}>{id}</span>
              {id === "machine"
                ? <span className={`${G}setup-val`}>
                  <span className={`${G}setup-machine`}>
                    <select ref={machineSelect} aria-label="machine" value={machineId} disabled={busy} onChange={event => { if (event.target.value) select(event.target.value); }} {...readout.bind("row:machine")}>
                      {!machine && <option value="">none chosen</option>}
                      {(machines ?? []).map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.online && candidate.revoked !== true ? "" : " · offline"}</option>)}
                    </select>
                    <Glyph className={`${G}setup-chevron`} path={CHEVRON} />
                  </span>
                  <span className={`${G}setup-st`} data-tone={row.state}>{row.word}</span>
                </span>
                : <span className={`${G}setup-val`} data-roving="" tabIndex={id === cursor ? 0 : -1} aria-label={`${id}: ${row.word}`}
                  {...readout.bind(`row:${id}`)} onFocus={() => { setCursor(id); readout.bind(`row:${id}`).onFocus(); }}>
                  {id === "folders" && row.state !== "unknown" && <Words name="folders" options={[["existing", "existing"], ["create", "new"]]} value={folderMode}
                    onPick={route => { setFolderMode(route); readout.say({ value: route === "create" ? "new folders" : "existing folders", text: FOLDERS[route] }); }}
                    refusal={busy ? "Wait for the job to finish." : null} readout={readout} describeAs="row:folders" />}
                  <span className={`${G}setup-st`} data-tone={row.state}>{row.word}</span>
                </span>}
            </li>;
          })}
        </ul>
        <SheetReadout said={readout.said} />
        <SheetGo action={next} hold={false} onPress={next.press} readout={readout} handle={go} />
      </section>
      <section className={`${G}sheet-pane`} data-side="profile" aria-label="profile">
        <h3 className={`${G}sheet-pane-title`}>profile</h3>
        <dl className={`${G}setup-facts`}>
          <dt>revision</dt>
          <dd>{record?.revision ?? model.observed?.revision ?? "not read"}{!model.configurationCurrent && <span className={`${G}setup-q`}> · last known</span>}</dd>
          <dt>models</dt>
          <dd><button type="button" className={`${G}setup-link`} data-place="models" onClick={() => onPlace("models")}>{active ? `${inUse} in use` : "none in use"}</button>
            {active && <span className={`${G}setup-q`}> · {verifiedAt !== null ? `verified ${since(Date.now() - verifiedAt)}` : "unverified"}</span>}</dd>
          {leftOut && <><dt>left out</dt><dd><button type="button" className={`${G}setup-link`} data-place="models" onClick={() => onPlace("models")}>{leftOut.length}</button></dd></>}
          <dt>source</dt>
          <dd>{active ? "stored list" : record?.draft ? "staged list" : "bundled starter"}{ompVersion && <span className={`${G}setup-q`}> · OMP {ompVersion} bundled list</span>}</dd>
          <dt>workspace</dt>
          <dd>{host.containerId}</dd>
        </dl>
        <h3 className={`${G}sheet-sub`}>classifier</h3>
        <div className={`${G}setup-classifier`}>
          <div className={`${G}setup-cl-row`}>
            <span className={`${G}setup-lab`}>suggestions</span>
            {classifierRefusal && !services.data
              ? <span className={`${G}setup-st`} data-tone="unknown" tabIndex={0} {...readout.bind("suggestions")}>{owner ? "unreadable" : "owner only"}</span>
              : <Words name="suggestions" options={[["off", "off"], ["ollama", "ollama"]]} value={classifier.mode} onPick={next => draftClassifier({ ...classifier, mode: next })}
                refusal={working ? "Wait for the change in progress." : classifierRefusal} readout={readout} describeAs="suggestions" />}
          </div>
          {classifier.mode === "ollama" && services.data && <div className={`${G}setup-fields`}>
            <label className={`${G}sheet-field`}>origin
              <input type="url" value={classifier.origin} placeholder="http://127.0.0.1:11434" spellCheck={false} disabled={working !== null}
                onChange={event => draftClassifier({ ...classifier, origin: event.target.value })} />
            </label>
            <label className={`${G}sheet-field`}>model
              <input type="text" value={classifier.model} placeholder="model name" spellCheck={false} disabled={working !== null}
                onChange={event => draftClassifier({ ...classifier, model: event.target.value })} />
            </label>
          </div>}
          {reviewCurrent && serviceReview && <p className={`${G}setup-policy`}>{serviceReview.input.classifier
            ? <>policy: task descriptions to <b>{serviceReview.input.classifier.origin}</b> · <b>{serviceReview.input.classifier.model}</b> · OMP and its accounts unchanged</>
            : <>policy: <b>no classifier</b> · Code sends nothing</>}</p>}
          {applied && !change && <p className={`${G}setup-policy`}>on · <b>{applied.model}</b> at <b>{applied.origin}</b></p>}
        </div>
      </section>
    </main>
    <SheetKeys keys={[["↑↓", "move"], ["←→", "choose"], ["⏎", next.label.replace("…", "")], ["esc", "code"]]} />
    {review && target && host.containerId && <PermissionDialog key={scope} host={host} target={target} intent={review.intent} label={review.label}
      containerId={host.containerId} onReady={refresh}
      onClose={() => { setReview(null); requestAnimationFrame(() => root.current?.querySelector<HTMLElement>("[data-go]")?.focus({ preventScroll: true })); }} />}
  </section>;
}
