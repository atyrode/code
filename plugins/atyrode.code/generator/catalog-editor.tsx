import { useEffect, useMemo, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { Cluster, Stack } from "@manifold/ui";
import { CatalogDocumentSchema, CatalogModelSchema, type CatalogDocument, type CatalogModel } from "../../domain/contracts.ts";
import { OMP_PLUGIN_ID, INVENTORY_OPERATION_ID, BENCHMARK_OPERATION_ID, ThinkingLevelSchema } from "@atyrode/manifold-omp";
import { compileCatalog } from "../../domain/catalog.ts";
import type { CatalogReview, Configuration, Target } from "../contract.ts";
import { callCodeAction, codeWorkflow, canWriteCodeWorkspace, codeOperationFailure, useOmpJob, useCodeQuery, useOmpQuery, useWorkflowQuery } from "../machine-web.ts";
import { Routing } from "./dials.tsx";
import { PermissionReview } from "../permission-review.tsx";
import { operationReady } from "../permission-plan.ts";

type Editor = { document: CatalogDocument; revision: number; activeDigest: string | null; draftDigest: string | null };
const numericFields = ["inputCostPerMillion", "outputCostPerMillion", "tokensPerSecond", "timeToFirstTokenMs", "contextWindow"] as const;
const numericLabels = { inputCostPerMillion: "Input / million tokens", outputCostPerMillion: "Output / million tokens", tokensPerSecond: "Tokens / second", timeToFirstTokenMs: "First token (ms)", contextWindow: "Context tokens" };
function ModelEditor({ model, index, disabled, update, remove }: {
  model: CatalogModel; index: number; disabled: boolean; update: (model: CatalogModel) => void; remove: () => void;
}) {
  return <fieldset disabled={disabled}><legend>Model {index + 1} · {model.key || "new model"}</legend>
    <Stack gap="0.65rem">
      <Cluster className="plugin-atyrode_code_generator__fields" gap="0.65rem">
        {(["key", "provider", "id", "api"] as const).map((field) => <label key={field}>{field}
          <input value={model[field]} maxLength={field === "id" ? 512 : 128} onChange={(event) => update({ ...model, [field]: event.target.value })} />
        </label>)}
      </Cluster>
      <Cluster className="plugin-atyrode_code_generator__fields" gap="0.65rem">
        <label>Tier<select value={model.tier} onChange={(event) => update({ ...model, tier: CatalogModelSchema.shape.tier.parse(Number(event.target.value)) })}>
          {[0, 1, 2, 3, 4].map((tier) => <option key={tier} value={tier}>{tier}</option>)}
        </select></label>
        <label>Quota bucket (blank = none)<input value={model.quotaBucket ?? ""} maxLength={128} onChange={(event) => update({ ...model, quotaBucket: event.target.value || null })} /></label>
        <label>Images<select value={String(model.images)} onChange={(event) => update({ ...model, images: event.target.value === "true" })}><option value="false">Not supported</option><option value="true">Supported</option></select></label>
      </Cluster>
      <Cluster className="plugin-atyrode_code_generator__fields" gap="0.65rem">{numericFields.map((field) => <label key={field}>{numericLabels[field]}
        <input type="number" min={field === "contextWindow" ? 1 : 0} step={field === "contextWindow" ? 1 : "any"} value={Number.isNaN(model[field]) ? "" : model[field] ?? ""}
          onChange={(event) => update({ ...model, [field]: event.target.value === "" ? (field === "inputCostPerMillion" || field === "outputCostPerMillion" ? Number.NaN : null) : event.target.valueAsNumber })} />
      </label>)}</Cluster>
      <fieldset><legend>Supported thinking levels</legend><Cluster gap="0.75rem">{ThinkingLevelSchema.options.map((level) => <label className="plugin-atyrode_code_generator__check" key={level}>
        <input type="checkbox" checked={model.thinkingLevels.includes(level)} onChange={(event) => update({ ...model, thinkingLevels: event.target.checked ? ThinkingLevelSchema.options.filter((option) => option === level || model.thinkingLevels.includes(option)) : model.thinkingLevels.filter((option) => option !== level) })} />{level}
      </label>)}</Cluster></fieldset>
      <button type="button" onClick={remove}>Remove model {index + 1}</button>
    </Stack>
  </fieldset>;
}


export function CatalogWorkbench({ host, target, available, onDone }: { host: HostServices; target: Target | null; available: boolean; onDone: () => void }) {
  const machineId = target?.machineId ?? "";
  const configuration = useCodeQuery(host, "readConfiguration", { containerId: host.containerId! });
  const setup = useOmpQuery(host, "describeDestination", target);
  const record = configuration.data?.configuration ?? null;
  const [editor, setEditor] = useState<Editor | null>(null);
  const [modelIndex, setModelIndex] = useState(0);
  const [jsonImport, setJsonImport] = useState("");
  const [review, setReview] = useState<CatalogReview | null>(null);
  const [reviewDocument, setReviewDocument] = useState<CatalogDocument | null>(null);
  const [runs, setRuns] = useState<Record<string, { inventoryId: string | null; benchmarkId: string | null }>>({});
  const inventoryId = runs[machineId]?.inventoryId ?? null;
  const benchmarkId = runs[machineId]?.benchmarkId ?? null;
  function setInventoryId(jobId: string | null) { setRuns(previous => ({ ...previous, [machineId]: { inventoryId: jobId, benchmarkId: null } })); }
  function setBenchmarkId(jobId: string | null) { setRuns(previous => ({ ...previous, [machineId]: { inventoryId: previous[machineId]?.inventoryId ?? null, benchmarkId: jobId } })); }
  const [historyInventory, setHistoryInventory] = useState("");
  const [historyBenchmark, setHistoryBenchmark] = useState("");
  const inventoryJob = useOmpJob(host, target && inventoryId ? { kind: "job", machineId, operationId: INVENTORY_OPERATION_ID, jobId: inventoryId } : null);
  const benchmarkJob = useOmpJob(host, target && benchmarkId ? { kind: "job", machineId, operationId: BENCHMARK_OPERATION_ID, jobId: benchmarkId } : null);
  const inventory = useWorkflowQuery(host, `inventory:${JSON.stringify([target, inventoryId])}`,
    !!target && !!inventoryId && inventoryJob.job?.state === "exited" && inventoryJob.job.result?.exitCode === 0,
    () => codeWorkflow(host).readInventory({ ...target!, jobId: inventoryId! }));
  const benchmark = useWorkflowQuery(host, `benchmark:${JSON.stringify([target, inventoryId, benchmarkId])}`,
    !!target && !!inventoryId && !!benchmarkId && benchmarkJob.job?.state === "exited" && benchmarkJob.job.result?.exitCode === 0,
    () => codeWorkflow(host).readBenchmark({ ...target!, inventoryJobId: inventoryId!, jobId: benchmarkId! }));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!record) return;
    // Unrelated shared choices advance CAS without changing the catalog draft.
    // Rebase only when both source catalogs are unchanged.
    setEditor(previous => previous && previous.revision !== record.revision &&
      previous.activeDigest === (record.active?.digest ?? null) && previous.draftDigest === (record.draft?.digest ?? null)
      ? { ...previous, revision: record.revision } : previous);
  }, [record]);
  const writable = canWriteCodeWorkspace(host) && record !== null;
  const stale = editor !== null && editor.revision !== record?.revision;
  const parsed = editor ? CatalogDocumentSchema.safeParse(editor.document) : null;
  const currentReview = record && review && review.revision === record.revision && record[review.source]?.digest === review.catalogDigest;
  const compiledReview = useMemo(() => reviewDocument ? compileCatalog(reviewDocument) : null, [reviewDocument]);
  const inventoryReady = operationReady(setup.data, INVENTORY_OPERATION_ID);
  const benchmarkReady = operationReady(setup.data, BENCHMARK_OPERATION_ID);
  const inventoryRunning = inventoryId !== null && (!inventoryJob.job || ["queued", "admitted", "start-committed", "started"].includes(inventoryJob.job.state));
  const benchmarkRunning = benchmarkId !== null && (!benchmarkJob.job || ["queued", "admitted", "start-committed", "started"].includes(benchmarkJob.job.state));
  function refresh() { configuration.refresh(); setup.refresh(); inventoryJob.refresh(); benchmarkJob.refresh(); inventory.refresh(); benchmark.refresh(); }
  async function perform(work: () => Promise<void>) {
    if (pending.current || !writable) return;
    pending.current = true; setBusy(true); setMessage(null);
    try { await work(); }
    catch (reason) { if (mounted.current) setMessage(codeOperationFailure(reason)); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); refresh(); } }
  }
  function edit(document: CatalogDocument) { if (record) { setEditor({ document: structuredClone(document), revision: record.revision,
    activeDigest: record.active?.digest ?? null, draftDigest: record.draft?.digest ?? null }); setModelIndex(0); setReview(null); } }
  async function reviewStaged(staged: Configuration, source: "draft" | "active" = "draft") {
    if (!mounted.current) return;
    const result = await callCodeAction(host, "reviewCatalog", { containerId: host.containerId!, expectedRevision: staged.revision, source });
    if (mounted.current) { setReview(result); setReviewDocument(staged[source]!.document); }
  }
  async function stage(document: CatalogDocument, expectedRevision: number) {
    const staged = await callCodeAction(host, "stageCatalog", { containerId: host.containerId!, expectedRevision, document });
    if (mounted.current) setEditor(null);
    await reviewStaged(staged);
  }
  const model = editor?.document.models[modelIndex];
  return <section className="plugin-atyrode_code_generator__catalog" aria-label="Model catalog">
    <header className="plugin-atyrode_code__section-heading"><h2 className="plugin-atyrode_code__section-label">catalog</h2><span className="plugin-atyrode_code__muted">{record?.active ? record.active.document.models.length + " models" : "choose your models"}</span><button type="button" disabled={busy} onClick={onDone}>back</button></header>
    {configuration.error && <p role="status">{configuration.error}</p>}
    {setup.error && <p role="status" className="plugin-atyrode_code__warning">{setup.error}</p>}
    {!writable && <p role="status" className="plugin-atyrode_code__notice">Catalog changes require an initialized workspace and edit access.</p>}
    {!inventoryReady && <div className="plugin-atyrode_code__notice"><p role="status">Model discovery needs native runtime readiness. You can still edit or import a catalog; opening review keeps your draft.</p></div>}
    <PermissionReview host={host} target={target} intent="discovery" label="Review discovery permissions" onReady={refresh} />
    {!record?.active && !inventoryId && !editor && !review && <p>Discover the models available to your accounts. This reads the model inventory; it does not run a benchmark.</p>}
    {!review && !editor && <div className="plugin-atyrode_code__toolbar">
      <button type="button" className={!record?.active ? "plugin-atyrode_code__primary-action" : undefined} disabled={!writable || busy || !available || !inventoryReady || inventoryRunning} onClick={() => { if (record && target) void perform(async () => { const job = await codeWorkflow(host).startInventory(target, record.revision); if (mounted.current) setInventoryId(job.jobId); }); }}>{inventoryRunning ? "Discovering models…" : record?.active ? "Refresh model inventory" : "Discover models"}</button>
      <button type="button" disabled={!writable || busy} onClick={() => edit(record?.draft?.document ?? record?.active?.document ?? { schemaVersion: 1, models: [] })}>Edit or import models</button>
      {record?.draft && <button type="button" disabled={!writable || busy} onClick={() => void perform(() => reviewStaged(record))}>review saved changes</button>}
    </div>}
    {inventoryId && <div className="plugin-atyrode_code_generator__job-progress" role="status">
      {inventoryJob.error ?? (inventory.data ? inventory.data.draft.document.models.length + " models discovered" : inventoryJob.job?.state === "exited" ? inventoryJob.job.result?.exitCode === 0 ? "Reading catalog…" : "Discovery failed. Open job history for details." : inventoryJob.job && ["refused", "cancelled", "interrupted"].includes(inventoryJob.job.state) ? "Discovery " + inventoryJob.job.state : "Reading models from the configured runtime…")}
      {inventory.error && <p>{inventory.error}</p>}
      {inventory.data && !editor && !review && <button type="button" className="plugin-atyrode_code__primary-action" disabled={!writable || busy} onClick={() => { if (record && inventory.data) void perform(() => stage(inventory.data!.draft.document, record.revision)); }}>Review these models</button>}
      <button type="button" onClick={() => host.navigate("manifold://plugin/" + OMP_PLUGIN_ID)}>job history</button>
    </div>}
    {editor && <div className="plugin-atyrode_code_generator__model-editor">
      <div className="plugin-atyrode_code__toolbar"><label>model <select value={modelIndex} disabled={busy || editor.document.models.length === 0} onChange={event => setModelIndex(Number(event.target.value))}>{editor.document.models.map((row, index) => <option key={index} value={index}>{row.key || "new model"}</option>)}</select></label>
        <button type="button" disabled={busy || editor.document.models.length >= 1024} onClick={() => { setModelIndex(editor.document.models.length); setEditor({ ...editor, document: { ...editor.document, models: [...editor.document.models, { key: "", provider: "", id: "", api: "", tier: 1, quotaBucket: null, inputCostPerMillion: 0, outputCostPerMillion: 0, tokensPerSecond: null, timeToFirstTokenMs: null, contextWindow: null, thinkingLevels: ["medium"], images: false }] } }); }}>+ model</button>
      </div>
      {model && <ModelEditor model={model} index={modelIndex} disabled={busy} update={value => setEditor({ ...editor, document: { ...editor.document, models: editor.document.models.map((row, index) => index === modelIndex ? value : row) } })} remove={() => { setEditor({ ...editor, document: { ...editor.document, models: editor.document.models.filter((_, index) => index !== modelIndex) } }); setModelIndex(Math.max(0, modelIndex - 1)); }} />}
      <details className="plugin-atyrode_code__details"><summary>JSON import / export</summary>
        <label>current catalog<textarea readOnly rows={6} value={JSON.stringify(editor.document, null, 2)} /></label>
        <label>import catalog<textarea rows={5} value={jsonImport} maxLength={1000000} onChange={event => setJsonImport(event.target.value)} /></label>
        <button type="button" disabled={busy || !jsonImport.trim()} onClick={() => { try { const document = CatalogDocumentSchema.parse(JSON.parse(jsonImport)); setEditor({ ...editor, document }); setModelIndex(0); setJsonImport(""); setMessage(null); } catch { setMessage("Import rejected: provide a valid Code catalog document."); } }}>Import into draft</button>
      </details>
      {parsed && !parsed.success && <p role="alert">Check the model fields: {parsed.error.issues[0]?.message}</p>}
      {stale && <p role="alert">The shared catalog changed. Your draft is kept, but cannot overwrite it. Export the draft before discarding.</p>}
      <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || stale || !parsed?.success} onClick={() => { if (parsed?.success) void perform(() => stage(parsed.data, editor.revision)); }}>Review changes</button><button type="button" disabled={busy} onClick={() => setEditor(null)}>discard</button></div>
    </div>}
    {review && compiledReview && <section className="plugin-atyrode_code_generator__catalog-review" aria-label="Catalog review">
      <p>{compiledReview.models.length} models · {compiledReview.families.join(" + ")}</p>
      <Routing value={review.review} catalog={compiledReview} />
      {!currentReview && <p role="status">The shared setup changed. Review the current catalog again before using it.</p>}
      <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !currentReview} onClick={() => void perform(async () => { await callCodeAction(host, "promoteCatalog", { containerId: host.containerId!, expectedRevision: review.revision, source: review.source, reviewDigest: review.reviewDigest }); if (mounted.current) onDone(); })}>Use this catalog</button><button type="button" disabled={busy} onClick={() => { if (reviewDocument) edit(reviewDocument); }}>edit models</button><button type="button" disabled={busy} onClick={() => setReview(null)}>back</button></div>
      <details className="plugin-atyrode_code__details"><summary>Exact review</summary><pre>{JSON.stringify({ revision: review.revision, digest: review.reviewDigest, catalogDigest: review.catalogDigest }, null, 2)}</pre></details>
    </section>}
    <details className="plugin-atyrode_code__details"><summary>Measure model performance</summary>
      <p>Benchmark requests contact the selected providers and may incur charges. Measurements are reviewed before they replace a catalog.</p>
      <button type="button" disabled={!writable || busy || !available || !benchmarkReady || !inventory.data || !inventoryId || benchmarkRunning} onClick={() => { if (record && target && inventoryId) void perform(async () => { const job = await codeWorkflow(host).startBenchmark(target, inventoryId); if (mounted.current) setBenchmarkId(job.jobId); }); }}>{benchmarkRunning ? "Measuring…" : "Run benchmark"}</button>
      {!inventory.data && <p>Discover models first.</p>}
      {!benchmarkReady && <p>Benchmark permission is not ready. Review its exact scope before running paid requests.</p>}
      <PermissionReview host={host} target={target} intent="benchmark" label="Review benchmark permissions" onReady={refresh} />
      {benchmarkJob.error && <p role="status">{benchmarkJob.error}</p>}
      {benchmarkId && benchmarkJob.job && <p role="status">Benchmark {benchmarkJob.job.state}{benchmarkJob.job.result?.exitCode !== undefined && benchmarkJob.job.result.exitCode !== 0 ? " · unsuccessful" : ""}</p>}
      {benchmark.error && <p role="status">{benchmark.error}</p>}
      {benchmark.data && <button type="button" disabled={!writable || busy || editor !== null} onClick={() => { if (record && target && inventoryId && benchmarkId) void perform(async () => { const staged = await codeWorkflow(host).stageBenchmark({ ...target, inventoryJobId: inventoryId, jobId: benchmarkId }, record.revision); await reviewStaged(staged); }); }}>Review measured catalog</button>}
    </details>
    <details className="plugin-atyrode_code__details"><summary>Recover a previous catalog job</summary>
      <label>inventory job<input value={historyInventory} maxLength={128} onChange={event => setHistoryInventory(event.target.value)} /></label>
      <label>benchmark job (optional)<input value={historyBenchmark} maxLength={128} onChange={event => setHistoryBenchmark(event.target.value)} /></label>
      <button type="button" disabled={!target || !historyInventory.trim() || busy} onClick={() => { if (target) { setInventoryId(historyInventory.trim()); setBenchmarkId(historyBenchmark.trim() || null); } }}>Read retained results</button>
      <button type="button" onClick={() => host.navigate("manifold://plugin/" + OMP_PLUGIN_ID)}>open native history</button>
    </details>
    {message && <p role="status" className="plugin-atyrode_code__warning">{message}</p>}
  </section>;
}
