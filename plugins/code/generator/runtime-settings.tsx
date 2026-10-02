import { useEffect, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { OMP_PLUGIN_ID, INVENTORY_OPERATION_ID, LAUNCH_OPERATION_ID, PREPARE_WORKSPACE_OPERATION_ID, VALIDATE_WORKSPACE_OPERATION_ID } from "@atyrode/manifold-omp";
import type { ActionInput, ActionResult, Target } from "../contract.ts";
import { callCodeAction, codeWorkflow, canWriteCodeWorkspace, codeOperationFailure, useCodeQuery, useOmpQuery, useOmpRuns } from "../machine-web.ts";
import { operationReady } from "../permission-plan.ts";
import { PermissionReview } from "../permission-review.tsx";

const runningStates = new Set(["queued", "admitted", "start-committed", "started"]);
const requiredOperations = [INVENTORY_OPERATION_ID, LAUNCH_OPERATION_ID] as const;
const workspaceRoutes = [
  { mode: "create", operation: PREPARE_WORKSPACE_OPERATION_ID, label: "Create new folders", description: "Create new workspace and session folders. Existing folders are never overwritten." },
  { mode: "existing", operation: VALIDATE_WORKSPACE_OPERATION_ID, label: "Check existing folders", description: "Check your existing workspace and session folders without changing their contents." },
] as const;
function SetupError({ label, detail }: { label: string; detail: string }) {
  return <div>
    <p role="status" className="plugin-atyrode_code__warning">{label}</p>
    <details className="plugin-atyrode_code__details"><summary>Error details</summary><pre>{detail}</pre></details>
  </div>;
}

export function RuntimeSettings({ host, target, available, onDone }: {
  host: HostServices; target: Target | null; available: boolean; onDone: () => void;
}) {
  const machineId = target?.machineId ?? "";
  const setup = useOmpQuery(host, "describeDestination", target);
  const creationHistory = useOmpRuns(host, target, PREPARE_WORKSPACE_OPERATION_ID);
  const validationHistory = useOmpRuns(host, target, VALIDATE_WORKSPACE_OPERATION_ID);
  const [section, setSection] = useState<"overview" | "machine" | "folders">("overview");
  const [serviceReview, setServiceReview] = useState<{ input: ActionInput<"reviewServices">; result: ActionResult<"reviewServices">; generation: number } | null>(null);
  const [classifierMode, setClassifierMode] = useState<"keep" | "set" | "remove">("keep");
  const [classifierOrigin, setClassifierOrigin] = useState("");
  const [classifierModel, setClassifierModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const scope = JSON.stringify([host.principal.id, host.containerId, target?.containerId, machineId]);
  const destination = useRef({ scope, client: host.client, authoring: host.authoring, generation: 0 });
  if (destination.current.scope !== scope || destination.current.client !== host.client || destination.current.authoring !== host.authoring)
    destination.current = { scope, client: host.client, authoring: host.authoring, generation: destination.current.generation + 1 };
  const generation = destination.current.generation;
  function destinationCurrent() { return mounted.current && generation === destination.current.generation; }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { pending.current = false; setBusy(false); setMessage(null); setServiceReview(null); }, [scope, host.client, host.authoring]);
  const writable = canWriteCodeWorkspace(host);
  const serviceConfiguration = useCodeQuery(host, "readServiceConfiguration", writable && host.client.selfCaps().includes("*") ? target : null);
  const modelConnection = setup.data?.services.find(service => service.serviceId === "omp" && service.state === "ready");
  const serviceReviewCurrent = serviceReview !== null && serviceReview.generation === generation && serviceReview.input.machineId === machineId &&
    serviceConfiguration.data?.configuration.revision === serviceReview.input.expectedServiceRevision;
  const workspaceReady = workspaceRoutes.some(route => operationReady(setup.data, route.operation));
  const installed = workspaceReady && requiredOperations.every(operation => operationReady(setup.data, operation));
  const matchingJobs = workspaceRoutes.flatMap(route => {
    const history = route.mode === "create" ? creationHistory : validationHistory;
    const operationId = route.operation;
    const pins = setup.data?.operations.find(operation => operation.operationId === operationId)?.pins;
    return history.runs?.flatMap(run => run.job && pins &&
      run.job.machineId === machineId && run.job.operationId === operationId && run.job.installationRevision === pins.installationRevision &&
      run.job.artifactSha256 === pins.artifactSha256 && run.job.resourceBindingDigest === pins.resourceBindingDigest ? [run.job] : []) ?? [];
  });
  const prepared = matchingJobs.some(job => job.state === "exited" && job.result?.exitCode === 0);
  const preparing = matchingJobs.find(job => runningStates.has(job.state));
  function refresh() { setup.refresh(); serviceConfiguration.refresh(); creationHistory.refresh(); validationHistory.refresh(); }
  async function perform(work: () => Promise<void>) {
    if (pending.current || !writable) return;
    pending.current = true; setBusy(true); setMessage(null);
    try { await work(); }
    catch (reason) { if (destinationCurrent()) setMessage(codeOperationFailure(reason)); }
    finally { if (destinationCurrent()) { pending.current = false; setBusy(false); refresh(); } }
  }
  const historyKnown = creationHistory.runs !== null && validationHistory.runs !== null && !creationHistory.error && !validationHistory.error;
  return <section className="plugin-atyrode_code_generator__runtime-settings" aria-label="Code setup">
    <header className="plugin-atyrode_code__section-heading"><h2 className="plugin-atyrode_code__section-label">setup</h2>
      <button type="button" disabled={busy} onClick={onDone}>Back to workbench</button>
    </header>
    <nav className="plugin-atyrode_code__toolbar" aria-label="Runtime management">
      <button type="button" aria-pressed={section === "overview"} disabled={busy} onClick={() => setSection("overview")}>Status</button>
      <button type="button" aria-pressed={section === "machine"} disabled={busy} onClick={() => setSection("machine")}>Machine</button>
      <button type="button" aria-pressed={section === "folders"} disabled={busy} onClick={() => setSection("folders")}>Folders</button>
    </nav>
    {!writable && <p role="status">Read-only workspace. Ask its owner to make runtime changes.</p>}
    {!target ? <p role="status">Choose a destination machine to manage its runtime.</p> : !available && <p role="status">Machine unavailable. Reconnect it to continue.</p>}
    {setup.error && <SetupError label="Runtime status unavailable. Refresh or review the connection." detail={setup.error} />}
    <ul className="plugin-atyrode_code_generator__requirements" aria-label="Runtime status">
      <li data-ready={!!modelConnection}><span>Connection</span><span>{modelConnection ? "ready" : setup.data ? "review needed" : "not confirmed"}</span></li>
      <li data-ready={installed}><span>Runtime</span><span>{installed ? "ready" : setup.data ? "review needed" : "not confirmed"}</span></li>
      <li data-ready={prepared}><span>Folders</span><span>{preparing ? "checking" : prepared ? "ready" : historyKnown && setup.data ? "not prepared" : "not confirmed"}</span></li>
    </ul>
    {section === "overview" && <div className="plugin-atyrode_code__toolbar">
      {!target || !available || setup.error ? <button type="button" onClick={refresh}>Refresh status</button> :
        !modelConnection ? <PermissionReview host={host} target={target} intent="gateway" label="Review connection" onReady={refresh} /> :
        !installed ? <PermissionReview host={host} target={target} intent="setup" label="Review runtime capabilities" onReady={refresh} /> :
        !prepared ? <button type="button" onClick={() => setSection("folders")}>Manage folders</button> :
        <button type="button" onClick={onDone}>Return to workbench</button>}
    </div>}
    {section === "machine" && <>
      <ul className="plugin-atyrode_code_generator__requirements" aria-label="Machine capabilities">
        <li data-ready={workspaceReady}><span>Use workspace and session folders</span><span>{workspaceReady ? "ready" : setup.data ? "review needed" : "not confirmed"}</span></li>
        {requiredOperations.map(operation => <li key={operation} data-ready={operationReady(setup.data, operation)}><span>{operation === INVENTORY_OPERATION_ID ? "Discover available models" : "Open OMP sessions"}</span><span>{operationReady(setup.data, operation) ? "ready" : setup.data ? "review needed" : "not confirmed"}</span></li>)}
      </ul>
      <div className="plugin-atyrode_code__toolbar">
        <PermissionReview host={host} target={target} intent="gateway" label="Review connection" onReady={refresh} />
        <PermissionReview host={host} target={target} intent="setup" label="Choose capabilities to review" onReady={refresh} />
      </div>
      <details className="plugin-atyrode_code__details">
        <summary>Connection and permission help</summary>
        <p>Account sign-in and machine setup are separate. The model gateway connects OMP to your instance’s account broker; this does not move credentials or start a model request. Its native owner reviews gateway rights and configuration independently of Code’s classifier.</p>
        <p>Choose either new folders or an existing-folder check; you do not need both. Capabilities can be reviewed independently. Closing a review does not revoke approved access. Paid benchmarks and account changes are separate choices.</p>
      </details>
      <details className="plugin-atyrode_code__details"><summary>External suggestion classifier{serviceReview ? serviceReviewCurrent ? " · review ready" : " · review outdated" : " · optional"}</summary>
          {serviceConfiguration.error && <SetupError label="Classifier configuration unavailable. Refresh or ask the instance owner." detail={serviceConfiguration.error} />}
          {serviceReview && !serviceReviewCurrent && <p role="status" className="plugin-atyrode_code__warning">Classifier configuration changed. Review again before applying.</p>}
          <p>Configuring this classifier allows Code to send task descriptions to it. OMP, its account broker and model gateway are unchanged.</p>
          <div className="plugin-atyrode_code_generator__fields">
            <label>Suggestions<select value={classifierMode} disabled={busy} onChange={event => { setClassifierMode(event.target.value as typeof classifierMode); setServiceReview(null); }}>
              <option value="keep">Keep current configuration</option><option value="set">Configure a classifier</option><option value="remove">Disable suggestions</option>
            </select></label>
            {classifierMode === "set" && <>
              <label>Ollama origin<input type="url" value={classifierOrigin} placeholder="http://127.0.0.1:11434" disabled={busy} onChange={event => { setClassifierOrigin(event.target.value); setServiceReview(null); }} /></label>
              <label>Classifier model<input value={classifierModel} placeholder="Model name" disabled={busy} onChange={event => { setClassifierModel(event.target.value); setServiceReview(null); }} /></label>
            </>}
          </div>
          {!serviceReview && <button type="button" className="plugin-atyrode_code__primary-action" data-action="atyrode.code.reviewServices" disabled={busy || !writable || !available || !serviceConfiguration.data?.connected || classifierMode === "keep" || (classifierMode === "set" && (!classifierOrigin.trim() || !classifierModel.trim()))} onClick={() => {
            if (target && serviceConfiguration.data && classifierMode !== "keep") void perform(async () => {
              const input: ActionInput<"reviewServices"> = { ...target, expectedServiceRevision: serviceConfiguration.data!.configuration.revision,
                classifier: classifierMode === "remove" ? null : { origin: classifierOrigin.trim(), model: classifierModel.trim() } };
              const result = await callCodeAction(host, "reviewServices", input);
              if (destinationCurrent()) setServiceReview({ input, result, generation });
            });
          }}>{busy ? "Reviewing…" : "Review classifier policy"}</button>}
          {serviceReview && <>
            <p>Only Code’s external suggestion classifier changes. Other machine services and your OMP runtime stay unchanged.</p>
            {!serviceReviewCurrent && <p role="status">Native configuration changed. Review the current classifier policy again.</p>}
            <details className="plugin-atyrode_code__details"><summary>Exact classifier policy</summary><pre>{JSON.stringify(serviceReview.result.policies.filter(policy => policy.serviceId === "suggest"), null, 2)}</pre></details>
            <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" data-action="atyrode.code.configureServices" disabled={busy || !writable || !available || !serviceReviewCurrent} onClick={() => void perform(async () => {
              await callCodeAction(host, "configureServices", { ...serviceReview.input, reviewDigest: serviceReview.result.reviewDigest });
              if (destinationCurrent()) setServiceReview(null);
            })}>{busy ? "Configuring…" : "Use classifier policy"}</button><button type="button" disabled={busy} onClick={() => setServiceReview(null)}>back</button></div>
          </>}
      </details>
    </>}
    {section === "folders" && <>
      {matchingJobs.length > 0 && !preparing && !prepared && <p role="status" className="plugin-atyrode_code__warning">Folder check failed. Review the native result before retrying.</p>}
      {workspaceRoutes.map(route => {
        const routeReady = operationReady(setup.data, route.operation);
        const history = route.mode === "create" ? creationHistory : validationHistory;
        return <section key={route.mode} aria-label={route.label}>
          <div className="plugin-atyrode_code__toolbar">
            {!routeReady ? <PermissionReview host={host} target={target} intent={route.mode === "create" ? "workspace-create" : "workspace-existing"} label={`Review: ${route.label}`} onReady={refresh} /> :
              <button type="button" className="plugin-atyrode_code__primary-action" data-action="atyrode.omp.prepareWorkspace" disabled={busy || !writable || !available || !target || history.runs === null || history.error !== null || !!preparing} onClick={() => { if (target) void perform(async () => { await codeWorkflow(host).prepareWorkspace(target, route.mode); }); }}>{route.label}</button>}
          </div>
          {history.error && <SetupError label={`${route.label}: history unavailable. Refresh before retrying.`} detail={history.error} />}
          <details className="plugin-atyrode_code__details"><summary>{route.mode === "create" ? "New folder scope" : "Existing folder scope"}</summary><p>{route.description}</p></details>
        </section>;
      })}
      <button type="button" onClick={() => host.navigate(`manifold://plugin/${OMP_PLUGIN_ID}`)}>Open native job history</button>
    </>}
    <details className="plugin-atyrode_code__details">
      <summary>Runtime status and diagnostics</summary>
      <p>OMP owns native resource revisions and execution authority. Code does not store runtime pins after preparation. Folder readiness comes from successful native jobs matching the current machine, operation, installation, artifact and resource bindings. Readiness is not a model-provider availability check.</p>
      <button type="button" disabled={busy} onClick={refresh}>Refresh status</button>
      <details className="plugin-atyrode_code__details"><summary>Current native destination</summary><pre>{JSON.stringify(setup.data, null, 2)}</pre></details>
      <details className="plugin-atyrode_code__details"><summary>Matching native folder jobs</summary><pre>{JSON.stringify(matchingJobs, null, 2)}</pre></details>
    </details>
    {message && <SetupError label="Setup action refused. Review the details before retrying." detail={message} />}
  </section>;
}
