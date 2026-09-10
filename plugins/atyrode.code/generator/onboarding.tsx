import { useEffect, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { CODE_PLUGIN_ID, GATEWAY_OPERATION_ID, GATEWAY_PLUGIN_ID, type ActionInput, type ActionResult, type Target } from "../contract.ts";
import { callCodeAction, codeOperationFailure, useCodeQuery, useCodeRuns } from "../machine-web.ts";
import { codeOperationReady } from "../operation-readiness.ts";
import { CatalogWorkbench } from "./catalog-editor.tsx";
import { OmpSignIn } from "../omp-sign-in.tsx";

const steps = ["Accounts", "Workspace", "Permissions", "Resources", "Folders", "Models"] as const;
const titles = ["Connect your accounts", "Set up this workspace", "Prepare this machine", "Review runtime resources", "Choose your workspace folders", "Choose your models"] as const;
const runningStates = new Set(["queued", "admitted", "start-committed", "started"]);
const requiredOperations = ["catalog-inventory", "launch"] as const;
const workspaceRoutes = [
  { mode: "create", operation: "prepare-workspace", label: "Create new folders", description: "Create new workspace and session folders. Existing folders are never overwritten." },
  { mode: "existing", operation: "validate-workspace", label: "Check existing folders", description: "Check your existing workspace and session folders without changing their contents." },
] as const;
export function Onboarding({ host, target, available, settings = false, onDone }: {
  host: HostServices; target: Target; available: boolean; settings?: boolean; onDone: () => void;
}) {
  const configuration = useCodeQuery(host, "readConfiguration", target);
  const setup = useCodeQuery(host, "readSetup", target);
  const creationHistory = useCodeRuns(host, target, "prepare-workspace");
  const validationHistory = useCodeRuns(host, target, "validate-workspace");
  const record = configuration.data?.configuration ?? null;
  const [review, setReview] = useState<(ActionResult<"reviewResources"> & { revision: number }) | null>(null);
  const [serviceReview, setServiceReview] = useState<{ input: ActionInput<"reviewServices">; result: ActionResult<"reviewServices"> } | null>(null);
  const [classifierMode, setClassifierMode] = useState<"keep" | "set" | "remove">("keep");
  const [classifierOrigin, setClassifierOrigin] = useState("");
  const [classifierModel, setClassifierModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [accountsContinued, setAccountsContinued] = useState(settings);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const writable = host.authoring !== null;
  const serviceConfiguration = useCodeQuery(host, "readServiceConfiguration", record && writable ? target : null);
  const gateway = serviceConfiguration.data?.runtimeCandidates.find(candidate =>
    candidate.runtime.pluginId === GATEWAY_PLUGIN_ID && candidate.runtime.operationId === GATEWAY_OPERATION_ID);
  const modelConnection = setup.data?.services.find(service => service.serviceId === "omp" &&
    ["models", "stream"].every(id => service.operations.some(operation => operation.operationId === id && operation.ready)));
  const reviewedGateway = serviceReview?.result.policies.find(policy => policy.serviceId === "omp")?.runtime;
  const serviceReviewCurrent = serviceReview !== null && serviceConfiguration.data?.configuration.revision === serviceReview.input.expectedServiceRevision &&
    gateway?.ready === true && reviewedGateway?.installationRevision === gateway.runtime.installationRevision &&
    reviewedGateway?.artifactSha256 === gateway.runtime.artifactSha256 && reviewedGateway?.resourceBindingDigest === gateway.runtime.resourceBindingDigest;
  const execution = setup.data?.execution;
  const installation = execution?.installation;
  const workspaceReady = workspaceRoutes.some(route => codeOperationReady(execution, target.machineId, route.operation));
  const installed = workspaceReady &&
    requiredOperations.every(operation => codeOperationReady(execution, target.machineId, operation));
  const currentPins = record?.resources?.execution;
  const resourcesCurrent = installed && record?.resources?.productSha256 === setup.data?.productSha256 && currentPins && installation && currentPins.installationRevision === installation.revision && currentPins.artifactSha256 === installation.artifactSha256 &&
    workspaceRoutes.some(route => codeOperationReady(execution, target.machineId, route.operation) &&
      currentPins.operations[`${CODE_PLUGIN_ID}.${route.operation}`] === execution?.operations?.[`${CODE_PLUGIN_ID}.${route.operation}`]?.resourceBindingDigest) &&
    requiredOperations.every(operation => currentPins.operations[`${CODE_PLUGIN_ID}.${operation}`] === execution?.operations?.[`${CODE_PLUGIN_ID}.${operation}`]?.resourceBindingDigest) &&
    ["broker", "omp", ...(setup.data?.services.some(service => service.serviceId === "suggest") || record?.resources?.services.suggest ? ["suggest"] : [])].every(id => {
      const saved = record?.resources?.services[id];
      return saved && setup.data?.services.some(service => service.serviceId === saved.serviceId && service.revision === saved.revision && service.policySha256 === saved.policySha256);
    });
  const matchingJobs = workspaceRoutes.flatMap(route => {
    const history = route.mode === "create" ? creationHistory : validationHistory;
    const operationId = `${CODE_PLUGIN_ID}.${route.operation}`;
    const operation = execution?.operations?.[operationId];
    return history.runs?.flatMap(run => run.job && installation && operation &&
      run.job.operationId === operationId && run.job.installationRevision === installation.revision && run.job.artifactSha256 === installation.artifactSha256 &&
      run.job.resourceBindingDigest === operation.resourceBindingDigest ? [run.job] : []) ?? [];
  });
  const prepared = matchingJobs.some(job => job.state === "exited" && job.result?.exitCode === 0);
  const preparing = matchingJobs.find(job => runningStates.has(job.state));
  const nextStep = !accountsContinued && !record ? 0 : !record ? 1 : !installed ? 2 : !resourcesCurrent ? 3 : !prepared ? 4 : 5;
  const step = selectedStep ?? (settings ? nextStep === 2 ? 2 : 3 : nextStep);
  const reviewCurrent = review !== null && record?.revision === review.revision;
  function refresh() { configuration.refresh(); setup.refresh(); serviceConfiguration.refresh(); creationHistory.refresh(); validationHistory.refresh(); }
  async function perform(work: () => Promise<void>) {
    if (pending.current || !writable) return;
    pending.current = true; setBusy(true); setMessage(null);
    try { await work(); }
    catch (reason) { if (mounted.current) setMessage(codeOperationFailure(reason)); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); refresh(); } }
  }
  if (!configuration.data) return <p role="status">{configuration.error ?? "Reading workspace setup…"}</p>;
  return <section className="plugin-atyrode_code_generator__onboarding" aria-label={settings ? "Code setup" : "First-use setup"}>
    <header className="plugin-atyrode_code__section-heading"><h2 className="plugin-atyrode_code__section-label">{settings ? "setup" : "welcome to code"}</h2>
      {settings && <button type="button" disabled={busy} onClick={onDone}>Back to profile</button>}
    </header>
    {settings ? <nav className="plugin-atyrode_code__toolbar" aria-label="Runtime setup">{[2, 3, 4].map(index => <button key={index} type="button" aria-pressed={step === index} disabled={busy} onClick={() => { setSelectedStep(index); setMessage(null); }}>{steps[index]}</button>)}</nav> :
      <ol className="plugin-atyrode_code_generator__steps" aria-label="Setup progress">{steps.map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined} data-complete={index < nextStep}>
        <button type="button" disabled={busy || index > nextStep || (index === 1 && record !== null)} onClick={() => { setSelectedStep(index); setMessage(null); }}><span aria-hidden="true">{index + 1}</span><span>{label}</span></button>
      </li>)}</ol>}
    <div className="plugin-atyrode_code_generator__setup-step">
      {step !== 0 && <h3>{titles[step]}</h3>}
      {step !== 0 && !writable && <p role="status">This workspace is read-only. Its owner can complete runtime setup; account discovery remains available.</p>}
      {step !== 0 && !available && <p role="status">The selected workspace machine is unavailable. Restore its native connection to prepare or run Code. Instance account sign-in is independent.</p>}
      {step !== 0 && configuration.error && <p role="status">{configuration.error}</p>}
      {step !== 0 && setup.error && <p role="status">{setup.error}</p>}
      {(!settings || step === 0) && <div hidden={step !== 0}><OmpSignIn host={host} active={step === 0} onContinue={() => { setAccountsContinued(true); setSelectedStep(null); refresh(); }} /></div>}
      {step === 1 && <>
        <p>Save this workspace’s profile, model catalog and account choices. Completed setup is remembered here.</p>
        <button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !configuration.data || record !== null} onClick={() => { if (configuration.data && !record) void perform(async () => { await callCodeAction(host, "initializeConfiguration", { ...target, expectedRevision: configuration.data!.revision }); if (mounted.current) setSelectedStep(null); }); }}>{busy ? "Creating…" : "Create workspace profile"}</button>
      </>}
      {step === 2 && <>
        {(!modelConnection || settings) && <details className="plugin-atyrode_code__details" open={!modelConnection}>
          <summary>Model connection{modelConnection ? " · configured" : ""}</summary>
          <p>Connect this machine’s reviewed runtime to your shared accounts. Configuring it does not start a provider request or change the account broker.</p>
          {serviceConfiguration.error && <p role="status">{serviceConfiguration.error}</p>}
          {settings && <div className="plugin-atyrode_code_generator__fields">
            <label>Suggestions<select value={classifierMode} disabled={busy} onChange={event => { setClassifierMode(event.target.value as typeof classifierMode); setServiceReview(null); }}>
              <option value="keep">Keep current configuration</option><option value="set">Configure a classifier</option><option value="remove">Disable suggestions</option>
            </select></label>
            {classifierMode === "set" && <>
              <label>Ollama origin<input type="url" value={classifierOrigin} placeholder="http://127.0.0.1:11434" disabled={busy} onChange={event => { setClassifierOrigin(event.target.value); setServiceReview(null); }} /></label>
              <label>Classifier model<input value={classifierModel} placeholder="Model name" disabled={busy} onChange={event => { setClassifierModel(event.target.value); setServiceReview(null); }} /></label>
            </>}
          </div>}
          {!serviceReview && (gateway?.ready ? <button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !available || !serviceConfiguration.data?.connected || (classifierMode === "set" && (!classifierOrigin.trim() || !classifierModel.trim()))} onClick={() => {
            if (serviceConfiguration.data) void perform(async () => {
              const input: ActionInput<"reviewServices"> = { ...target, expectedServiceRevision: serviceConfiguration.data!.configuration.revision,
                ...(classifierMode === "keep" ? {} : { classifier: classifierMode === "remove" ? null : { origin: classifierOrigin.trim(), model: classifierModel.trim() } }) };
              const result = await callCodeAction(host, "reviewServices", input);
              if (mounted.current) setServiceReview({ input, result });
            });
          }}>{busy ? "Reviewing…" : "Review model connection"}</button> : <button type="button" className="plugin-atyrode_code__primary-action" onClick={() => host.navigate(`manifold://plugin/${serviceConfiguration.data ? GATEWAY_PLUGIN_ID : CODE_PLUGIN_ID}`)}>{serviceConfiguration.data ? "Review gateway runtime" : "Open native setup"}</button>)}
          {serviceReview && <>
            <p>The gateway’s exact runtime is pinned. Other machine services and your shared account broker are kept unchanged.</p>
            {!serviceReviewCurrent && <p role="status">Native setup changed. Review the current connection again.</p>}
            <details className="plugin-atyrode_code__details"><summary>Exact connection policies</summary><pre>{JSON.stringify(serviceReview.result.policies.filter(policy => policy.serviceId === "omp" || policy.serviceId === "suggest"), null, 2)}</pre></details>
            <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !available || !serviceReviewCurrent} onClick={() => void perform(async () => {
              await callCodeAction(host, "configureServices", { ...serviceReview.input, reviewDigest: serviceReview.result.reviewDigest });
              if (mounted.current) { setServiceReview(null); setSelectedStep(null); }
            })}>{busy ? "Configuring…" : "Use this connection"}</button><button type="button" disabled={busy} onClick={() => setServiceReview(null)}>back</button></div>
          </>}
        </details>}
          <p>Approve folder creation or an existing-folder check, plus model discovery and launch. Paid benchmarks and account changes have separate permissions.</p>
          <ul className="plugin-atyrode_code_generator__requirements">
            <li data-ready={workspaceReady}><span>workspace folders</span><span>{workspaceReady ? "ready" : "native setup needed"}</span></li>
            {requiredOperations.map(operation => <li key={operation} data-ready={codeOperationReady(execution, target.machineId, operation)}><span>{operation === "catalog-inventory" ? "model discovery" : "terminal launch"}</span><span>{codeOperationReady(execution, target.machineId, operation) ? "ready" : "native setup needed"}</span></li>)}
          </ul>
          <button type="button" className="plugin-atyrode_code__primary-action" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>Review Code permissions</button>
        <button type="button" disabled={busy} onClick={() => { setSelectedStep(null); refresh(); }}>check again</button>
      </>}
      {step === 3 && <>
        <p>Use this machine’s approved runtime with the shared instance account broker. Reviewing does not install anything or grant additional access.</p>
        {!review && <button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !record || !available} onClick={() => { if (record) void perform(async () => { const result = await callCodeAction(host, "reviewResources", { ...target, expectedRevision: record.revision }); if (mounted.current) setReview({ ...result, revision: record.revision }); }); }}>{busy ? "Reviewing…" : "Review resources"}</button>}
        {review && <>
          <dl className="plugin-atyrode_code_generator__setup-facts"><dt>runtime</dt><dd>{review.resources.execution ? "pinned native installation" : "not installed"}</dd><dt>connections</dt><dd>{Object.keys(review.resources.services).join(", ") || "none"}</dd></dl>
          {!reviewCurrent && <p role="status">Shared choices changed. Review the current resources again.</p>}
          <details className="plugin-atyrode_code__details"><summary>Exact resources and revisions</summary><pre>{JSON.stringify(review.resources, null, 2)}</pre></details>
          <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !reviewCurrent} onClick={() => void perform(async () => { await callCodeAction(host, "promoteResources", { ...target, expectedRevision: review.revision, reviewDigest: review.reviewDigest }); if (mounted.current) { setReview(null); setSelectedStep(null); if (settings) onDone(); } })}>Use these resources</button><button type="button" disabled={busy} onClick={() => setReview(null)}>back</button></div>
        </>}
      </>}
      {step === 4 && <>
        <p>{prepared ? "Workspace ready. Setup is saved for this runtime." : "Create new workspace folders or check folders you already use."}</p>
        {preparing && <p role="status">Checking workspace…</p>}
        {matchingJobs.length > 0 && !preparing && !prepared && <p role="status" className="plugin-atyrode_code__warning">The workspace check did not finish successfully. Review its result before trying again.</p>}
        {!prepared && workspaceRoutes.map(route => {
          const operationId = `${CODE_PLUGIN_ID}.${route.operation}`;
          const routeReady = codeOperationReady(execution, target.machineId, route.operation) &&
            currentPins?.operations[operationId] === execution?.operations?.[operationId]?.resourceBindingDigest;
          const history = route.mode === "create" ? creationHistory : validationHistory;
          return <div key={route.mode}>
            <p>{route.description}</p>
            {!routeReady && <p role="status">This option needs permission. Review access below, or use the other option if it matches your folders.</p>}
            {history.error && <p role="status">{history.error}</p>}
            <button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !available || !resourcesCurrent || !routeReady || history.runs === null || history.error !== null || !!preparing} onClick={() => { if (record) void perform(async () => { await callCodeAction(host, "prepareWorkspace", { ...target, expectedRevision: record.revision, mode: route.mode }); if (mounted.current) setSelectedStep(null); }); }}>{route.label}</button>
          </div>;
        })}
        <button type="button" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>Permissions and history</button>
      </>}
      {step === 5 && <CatalogWorkbench host={host} target={target} available={available} onDone={() => { refresh(); onDone(); }} />}
    </div>
    {!settings && selectedStep !== null && selectedStep > 0 && selectedStep < nextStep && <button type="button" onClick={() => setSelectedStep(null)}>Continue setup</button>}
    {message && <p role="status" className="plugin-atyrode_code__warning">{message}</p>}
  </section>;
}
