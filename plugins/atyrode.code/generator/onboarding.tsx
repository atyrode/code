import { useEffect, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { CODE_PLUGIN_ID, type ActionResult, type Target } from "../contract.ts";
import { callCodeAction, codeOperationFailure, useCodeQuery, useCodeRuns } from "../machine-web.ts";
import { CatalogWorkbench } from "./catalog-editor.tsx";
import { ServiceSetup } from "./service-setup.tsx";

const steps = ["workspace", "connection", "permissions", "resources", "prepare", "models"] as const;
const titles = ["Set up Code here", "Connect your accounts", "Approve this machine", "Review runtime resources", "Choose your workspace", "Choose your models"] as const;
const runningStates = new Set(["queued", "admitted", "start-committed", "started"]);
export function Onboarding({ host, target, available, settings = false, onDone }: {
  host: HostServices; target: Target; available: boolean; settings?: boolean; onDone: () => void;
}) {
  const configuration = useCodeQuery(host, "readConfiguration", target);
  const setup = useCodeQuery(host, "readSetup", target);
  const history = useCodeRuns(host, target, "prepare-workspace");
  const record = configuration.data?.configuration ?? null;
  const [review, setReview] = useState<(ActionResult<"reviewResources"> & { revision: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [existingWorkspace, setExistingWorkspace] = useState(false);
  const [selectedStep, setSelectedStep] = useState<number | null>(settings ? 3 : null);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const writable = host.authoring !== null;
  const execution = setup.data?.execution;
  const installation = execution?.installation;
  const connections = setup.data?.services.some(service => service.serviceId === "broker") && setup.data.services.some(service => service.serviceId === "omp");
  const requiredOperations = ["prepare-workspace", "catalog-inventory", "launch"];
  const installed = installation?.enabled && !installation.purgeRequested && requiredOperations.every(operation => execution?.operations?.[`${CODE_PLUGIN_ID}.${operation}`]?.ready);
  const currentPins = record?.resources?.execution;
  const resourcesCurrent = record?.resources?.productSha256 === setup.data?.productSha256 && currentPins && installation && currentPins.installationRevision === installation.revision && currentPins.artifactSha256 === installation.artifactSha256 &&
    requiredOperations.every(operation => currentPins.operations[`${CODE_PLUGIN_ID}.${operation}`] === execution?.operations?.[`${CODE_PLUGIN_ID}.${operation}`]?.resourceBindingDigest) &&
    ["broker", "omp"].every(id => {
      const saved = record?.resources?.services[id];
      return saved && setup.data?.services.some(service => service.serviceId === id && service.revision === saved.revision && service.policySha256 === saved.policySha256);
    });
  const matchingJobs = history.runs?.flatMap(run => run.job && installation && run.job.installationRevision === installation.revision && run.job.artifactSha256 === installation.artifactSha256 &&
    run.job.resourceBindingDigest === execution?.operations?.[`${CODE_PLUGIN_ID}.prepare-workspace`]?.resourceBindingDigest ? [run.job] : []) ?? [];
  const prepared = matchingJobs.some(job => job.state === "exited" && job.result?.exitCode === 0);
  const preparing = matchingJobs.find(job => runningStates.has(job.state));
  const latestPreparation = matchingJobs[0];
  const nextStep = !record ? 0 : !connections ? 1 : !installed ? 2 : !resourcesCurrent ? 3 : !prepared && !existingWorkspace ? 4 : 5;
  const step = Math.min(selectedStep ?? nextStep, record ? 5 : 0);
  const reviewCurrent = review !== null && record?.revision === review.revision;
  function refresh() { configuration.refresh(); setup.refresh(); history.refresh(); }
  async function perform(work: () => Promise<void>) {
    if (pending.current || !writable) return;
    pending.current = true; setBusy(true); setMessage(null);
    try { await work(); }
    catch (reason) { if (mounted.current) setMessage(codeOperationFailure(reason)); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); refresh(); } }
  }
  return <section className="plugin-atyrode_code_generator__onboarding" aria-label={settings ? "Code setup" : "First-use setup"}>
    <header className="plugin-atyrode_code__section-heading"><h2 className="plugin-atyrode_code__section-label">{settings ? "setup" : "welcome to code"}</h2>
      {settings && <button type="button" onClick={onDone}>back to code</button>}
    </header>
    <ol className="plugin-atyrode_code_generator__steps" aria-label="Setup progress">{steps.map((label, index) => <li key={label} aria-current={step === index ? "step" : undefined} data-complete={index < nextStep}>
      <button type="button" disabled={busy || index > nextStep} onClick={() => { setSelectedStep(index); setMessage(null); }}>{index + 1}<span>{label}</span></button>
    </li>)}</ol>
    <div className="plugin-atyrode_code_generator__setup-step">
      <h3>{titles[step]}</h3>
      {!writable && <p role="status">This workspace is read-only. Its owner can complete setup.</p>}
      {configuration.error && <p role="status">{configuration.error}</p>}
      {setup.error && <p role="status">{setup.error}</p>}
      {step === 0 && <>
        <p>Code remembers this workspace’s catalog, account choices and dials. This setup runs once; ordinary launches return straight to your profile.</p>
        <button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !configuration.data} onClick={() => { if (configuration.data) void perform(async () => { await callCodeAction(host, "initializeConfiguration", { ...target, expectedRevision: configuration.data!.revision }); if (mounted.current) setSelectedStep(null); }); }}>{busy ? "Creating…" : "Get started"}</button>
      </>}
      {step === 1 && <ServiceSetup host={host} target={target} onConfigured={() => { setSelectedStep(null); refresh(); }} />}
      {step === 2 && <>
        <p>Approve Code’s runtime, workspace locations and launch permissions in Manifold. Paid benchmarks and account changes remain separate permissions.</p>
        <ul className="plugin-atyrode_code_generator__requirements">{requiredOperations.map(operation => <li key={operation} data-ready={execution?.operations?.[`${CODE_PLUGIN_ID}.${operation}`]?.ready === true}><span>{operation === "prepare-workspace" ? "workspace preparation" : operation === "catalog-inventory" ? "model discovery" : "terminal launch"}</span><span>{execution?.operations?.[`${CODE_PLUGIN_ID}.${operation}`]?.ready ? "ready" : "approval needed"}</span></li>)}</ul>
        <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>Open native setup</button><button type="button" onClick={() => { setSelectedStep(null); refresh(); }}>check again</button></div>
      </>}
      {step === 3 && <>
        <p>Use this machine’s approved runtime and account connections. Reviewing does not install anything or grant additional access.</p>
        {!review && <button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !record || !available} onClick={() => { if (record) void perform(async () => { const result = await callCodeAction(host, "reviewResources", { ...target, expectedRevision: record.revision }); if (mounted.current) setReview({ ...result, revision: record.revision }); }); }}>{busy ? "Reviewing…" : "Review resources"}</button>}
        {review && <>
          <dl className="plugin-atyrode_code_generator__setup-facts"><dt>runtime</dt><dd>{review.resources.execution ? "pinned native installation" : "not installed"}</dd><dt>connections</dt><dd>{Object.keys(review.resources.services).join(", ") || "none"}</dd></dl>
          {!reviewCurrent && <p role="status">Shared choices changed. Review the current resources again.</p>}
          <details className="plugin-atyrode_code__details"><summary>Exact resources and revisions</summary><pre>{JSON.stringify(review.resources, null, 2)}</pre></details>
          <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !reviewCurrent} onClick={() => void perform(async () => { await callCodeAction(host, "promoteResources", { ...target, expectedRevision: review.revision, reviewDigest: review.reviewDigest }); if (mounted.current) { setReview(null); setSelectedStep(null); if (settings) onDone(); } })}>Use these resources</button><button type="button" disabled={busy} onClick={() => setReview(null)}>back</button></div>
        </>}
      </>}
      {step === 4 && <>
        <p>New here? Create the workspace and session folders declared in native setup, and check the pinned OMP executable. Existing folders are never replaced.</p>
        {history.error && <p role="status">{history.error}</p>}
        {preparing && <p role="status">Preparing workspace · {preparing.state}</p>}
        {latestPreparation && !preparing && !prepared && <p role="status" className="plugin-atyrode_code__warning">The last preparation did not complete successfully. Inspect its native result before trying again.</p>}
        <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || !available || !resourcesCurrent || history.runs === null || history.error !== null || !!preparing} onClick={() => { if (record) void perform(async () => { await callCodeAction(host, "prepareWorkspace", { ...target, expectedRevision: record.revision }); if (mounted.current) setSelectedStep(null); }); }}>{busy || preparing ? "Preparing…" : "Create new workspace"}</button>
          <button type="button" disabled={busy || !!preparing} onClick={() => { setExistingWorkspace(true); setSelectedStep(null); }}>Use the existing bound workspace</button></div>
        <button type="button" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>preparation history</button>
      </>}
      {step === 5 && <CatalogWorkbench host={host} target={target} available={available} onDone={() => { refresh(); onDone(); }} />}
    </div>
    {selectedStep !== null && selectedStep < nextStep && <button type="button" onClick={() => setSelectedStep(null)}>continue setup</button>}
    {message && <p role="status" className="plugin-atyrode_code__warning">{message}</p>}
  </section>;
}
