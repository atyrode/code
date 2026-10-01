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
const identityFields = [
  { field: "key", label: "Catalog key · routing label" },
  { field: "provider", label: "Provider identifier" },
  { field: "id", label: "Provider model ID" },
  { field: "api", label: "API family" },
] as const;
const numericGroups = [
  { label: "Pricing", fields: ["inputCostPerMillion", "outputCostPerMillion"], quota: false },
  { label: "Performance", fields: ["tokensPerSecond", "timeToFirstTokenMs"], quota: false },
  { label: "Limits and quota", fields: ["contextWindow"], quota: true },
] as const;
const numericLabels = { inputCostPerMillion: "Input / million tokens", outputCostPerMillion: "Output / million tokens", tokensPerSecond: "Tokens / second", timeToFirstTokenMs: "First token (ms)", contextWindow: "Context tokens" };
function ModelEditor({ model, index, disabled, update, remove }: {
  model: CatalogModel; index: number; disabled: boolean; update: (model: CatalogModel) => void; remove: () => void;
}) {
  return <fieldset disabled={disabled}><legend>Model {index + 1} · {model.key || "new model"}</legend>
    <Stack gap="0.65rem">
      <Cluster className="plugin-atyrode_code_generator__fields" gap="0.65rem">
        {identityFields.map(({ field, label }) => <label key={field}>{label}
          <input value={model[field]} maxLength={field === "id" ? 512 : 128} onChange={(event) => update({ ...model, [field]: event.target.value })} />
        </label>)}
      </Cluster>
      <Cluster className="plugin-atyrode_code_generator__fields" gap="0.65rem">
        <label>Capability tier<select value={model.tier} onChange={(event) => update({ ...model, tier: CatalogModelSchema.shape.tier.parse(Number(event.target.value)) })}>
          {[0, 1, 2, 3, 4].map((tier) => <option key={tier} value={tier}>{tier}</option>)}
        </select></label>
        <label>Images<select value={String(model.images)} onChange={(event) => update({ ...model, images: event.target.value === "true" })}><option value="false">Not supported</option><option value="true">Supported</option></select></label>
      </Cluster>
      {numericGroups.map((group) => <details className="plugin-atyrode_code__details" key={group.label}>
        <summary>{group.label}</summary>
        <Cluster className="plugin-atyrode_code_generator__fields" gap="0.65rem">
          {group.fields.map((field) => <label key={field}>{numericLabels[field]}
            <input type="number" min={field === "contextWindow" ? 1 : 0} step={field === "contextWindow" ? 1 : "any"} value={Number.isNaN(model[field]) ? "" : model[field] ?? ""}
              onChange={(event) => update({ ...model, [field]: event.target.value === "" ? (field === "inputCostPerMillion" || field === "outputCostPerMillion" ? Number.NaN : null) : event.target.valueAsNumber })} />
          </label>)}
          {group.quota && <label>Quota bucket (blank = none)<input value={model.quotaBucket ?? ""} maxLength={128} onChange={(event) => update({ ...model, quotaBucket: event.target.value || null })} /></label>}
        </Cluster>
      </details>)}
      <details className="plugin-atyrode_code__details"><summary>Thinking levels</summary>
        <fieldset><legend>Supported thinking levels</legend><Cluster gap="0.75rem">{ThinkingLevelSchema.options.map((level) => <label className="plugin-atyrode_code_generator__check" key={level}>
          <input type="checkbox" checked={model.thinkingLevels.includes(level)} onChange={(event) => update({ ...model, thinkingLevels: event.target.checked ? ThinkingLevelSchema.options.filter((option) => option === level || model.thinkingLevels.includes(option)) : model.thinkingLevels.filter((option) => option !== level) })} />{level}
        </label>)}</Cluster></fieldset>
      </details>
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
  // Derive under the budget this workspace has already selected: a free selection wants a free
  // ladder, and asking the operator the same question twice invites the two answers to differ.
  const budget = record?.selection?.budget ?? "any";
  const inventory = useWorkflowQuery(host, `inventory:${JSON.stringify([target, inventoryId, budget])}`,
    !!target && !!inventoryId && inventoryJob.job?.state === "exited" && inventoryJob.job.result?.exitCode === 0,
    () => codeWorkflow(host).readInventory({ ...target!, jobId: inventoryId! }, budget));
  const benchmark = useWorkflowQuery(host, `benchmark:${JSON.stringify([target, inventoryId, benchmarkId, budget])}`,
    !!target && !!inventoryId && !!benchmarkId && benchmarkJob.job?.state === "exited" && benchmarkJob.job.result?.exitCode === 0,
    () => codeWorkflow(host).readBenchmark({ ...target!, inventoryJobId: inventoryId!, jobId: benchmarkId! }, budget));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ summary: string; details: string } | null>(null);
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
  const catalogStatus = configuration.error ? "Catalog unavailable. Retry loading your workspace."
    : !record ? configuration.data ? "Initialize this workspace in Setup before changing models." : "Loading your catalog…"
    : !writable ? "Models are read-only. Ask a workspace editor to change the catalog."
    : !target ? "Choose a destination for discovery, or edit or import a catalog."
    : !available ? "Model discovery is unavailable. Edit or import a catalog instead."
    : setup.error ? "Discovery readiness is unavailable. Retry or edit or import a catalog."
    : !inventoryReady ? "Discovery needs setup. Review discovery permissions, or edit or import a catalog."
    : null;
  function refresh() { configuration.refresh(); setup.refresh(); inventoryJob.refresh(); benchmarkJob.refresh(); inventory.refresh(); benchmark.refresh(); }
  async function perform(work: () => Promise<void>) {
    if (pending.current || !writable) return;
    pending.current = true; setBusy(true); setMessage(null);
    try { await work(); }
    catch (reason) {
      if (mounted.current) {
        const failure = codeOperationFailure(reason);
        setMessage({
          summary: reason instanceof Error && failure === reason.message ? "Catalog action failed. Open error details before retrying." : failure,
          details: reason instanceof Error ? reason.message : failure,
        });
      }
    }
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
    <header className="plugin-atyrode_code__section-heading"><h2 className="plugin-atyrode_code__section-label">Models</h2><span className="plugin-atyrode_code__muted">{record?.active ? record.active.document.models.length + " models" : "choose your models"}</span><button type="button" disabled={busy} onClick={onDone}>back</button></header>
    {!review && !editor && <div className="plugin-atyrode_code__toolbar">
      <button type="button" className={!record?.active && available && inventoryReady ? "plugin-atyrode_code__primary-action" : undefined} data-action="atyrode.omp.startInventory" disabled={!writable || busy || !available || !inventoryReady || inventoryRunning} onClick={() => { if (record && target) void perform(async () => { const job = await codeWorkflow(host).startInventory(target, record.revision); if (mounted.current) setInventoryId(job.jobId); }); }}>{inventoryRunning ? "Discovering models…" : record?.active ? "Refresh model inventory" : "Discover models"}</button>
      <button type="button" className={!available || !inventoryReady ? "plugin-atyrode_code__primary-action" : undefined} disabled={!writable || busy} onClick={() => edit(record?.draft?.document ?? record?.active?.document ?? { schemaVersion: 1, models: [] })}>Edit or import models</button>
      {record?.draft && <button type="button" data-action="atyrode.code.reviewCatalog" disabled={!writable || busy} onClick={() => void perform(() => reviewStaged(record))}>Review saved changes</button>}
    </div>}
    {!review && !editor && <p className="plugin-atyrode_code__muted">Discovery reads account inventory without running a benchmark.</p>}
    {catalogStatus && <div className="plugin-atyrode_code__notice">
      <p role="status">{catalogStatus}</p>
      {(configuration.error || setup.error) && <button type="button" disabled={busy} onClick={refresh}>Retry status</button>}
    </div>}
    {(configuration.error || setup.error) && <details className="plugin-atyrode_code__details"><summary>Catalog error details</summary>
      {configuration.error && <><p>Catalog configuration</p><pre>{configuration.error}</pre></>}
      {setup.error && <><p>Discovery readiness</p><pre>{setup.error}</pre></>}
    </details>}
    {inventoryId && <div className="plugin-atyrode_code_generator__job-progress" role="status">
      {inventoryJob.error ? "Discovery status unavailable. Open job history or retry." : inventory.error ? "Discovered models could not be read. Open error details or retry." : inventory.data ? inventory.data.draft.document.models.length + " models discovered" : inventoryJob.job?.state === "exited" ? inventoryJob.job.result?.exitCode === 0 ? "Reading catalog…" : "Discovery failed. Open job history for details." : inventoryJob.job && ["refused", "cancelled", "interrupted"].includes(inventoryJob.job.state) ? "Discovery " + inventoryJob.job.state : "Reading models from the configured runtime…"}
      {(inventoryJob.error || inventory.error) && <>
        <button type="button" disabled={busy} onClick={refresh}>Retry discovery status</button>
        <details className="plugin-atyrode_code__details"><summary>Discovery error details</summary>
          {inventoryJob.error && <pre>{inventoryJob.error}</pre>}
          {inventory.error && <pre>{inventory.error}</pre>}
        </details>
      </>}
      {inventory.data && !editor && !review && <button type="button" className="plugin-atyrode_code__primary-action" data-action="atyrode.code.stageCatalog" disabled={!writable || busy} onClick={() => { if (record && inventory.data) void perform(() => stage(inventory.data!.draft.document, record.revision)); }}>Stage and review models</button>}
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
        <button type="button" disabled={busy || !jsonImport.trim()} onClick={() => { try { const document = CatalogDocumentSchema.parse(JSON.parse(jsonImport)); setEditor({ ...editor, document }); setModelIndex(0); setJsonImport(""); setMessage(null); } catch (reason) { setMessage({ summary: "Import rejected. Provide a valid Code catalog document.", details: reason instanceof Error ? reason.message : String(reason) }); } }}>Import into draft</button>
      </details>
      {parsed && !parsed.success && <>
        <p role="alert">Catalog fields need attention before review. See validation details.</p>
        <details className="plugin-atyrode_code__details"><summary>Validation details</summary><pre>{JSON.stringify(parsed.error.issues, null, 2)}</pre></details>
      </>}
      {stale && <p role="alert">The shared catalog changed. Your draft is kept, but cannot overwrite it. Export the draft before discarding.</p>}
      <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" data-action="atyrode.code.stageCatalog" disabled={!writable || busy || stale || !parsed?.success} onClick={() => { if (parsed?.success) void perform(() => stage(parsed.data, editor.revision)); }}>Stage and review changes</button><button type="button" disabled={busy} onClick={() => setEditor(null)}>discard</button></div>
    </div>}
    {review && compiledReview && <section className="plugin-atyrode_code_generator__catalog-review" aria-label="Catalog review">
      <p>{compiledReview.models.length} models · {compiledReview.families.join(" + ")}</p>
      <Routing value={review.review} catalog={compiledReview} />
      {!currentReview && <p role="status">The shared setup changed. Review the current catalog again before using it.</p>}
      <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" data-action="atyrode.code.promoteCatalog" disabled={!writable || busy || !currentReview} onClick={() => void perform(async () => { await callCodeAction(host, "promoteCatalog", { containerId: host.containerId!, expectedRevision: review.revision, source: review.source, reviewDigest: review.reviewDigest }); if (mounted.current) onDone(); })}>Use this catalog</button><button type="button" disabled={busy} onClick={() => { if (reviewDocument) edit(reviewDocument); }}>edit models</button><button type="button" disabled={busy} onClick={() => setReview(null)}>back</button></div>
      <details className="plugin-atyrode_code__details"><summary>Exact review</summary><pre>{JSON.stringify({ revision: review.revision, digest: review.reviewDigest, catalogDigest: review.catalogDigest }, null, 2)}</pre></details>
    </section>}
    <details className="plugin-atyrode_code__details"><summary>Discovery setup and permissions</summary>
      <PermissionReview host={host} target={target} intent="discovery" label="Review discovery permissions" onReady={refresh} />
    </details>
    {benchmarkId && <div className="plugin-atyrode_code_generator__job-progress" role="status">
      {benchmarkJob.error ? "Benchmark status unavailable. Open job history or retry." : benchmark.error ? "Measurements could not be read. Open error details or retry." : benchmark.data ? "Measurements ready. Open Measure model performance to review them." : benchmarkJob.job ? "Benchmark " + benchmarkJob.job.state + (benchmarkJob.job.result?.exitCode !== undefined && benchmarkJob.job.result.exitCode !== 0 ? " · unsuccessful" : "") : "Reading benchmark status…"}
      {(benchmarkJob.error || benchmark.error) && <>
        <button type="button" disabled={busy} onClick={refresh}>Retry benchmark status</button>
        <details className="plugin-atyrode_code__details"><summary>Benchmark error details</summary>
          {benchmarkJob.error && <pre>{benchmarkJob.error}</pre>}
          {benchmark.error && <pre>{benchmark.error}</pre>}
        </details>
      </>}
      <button type="button" onClick={() => host.navigate("manifold://plugin/" + OMP_PLUGIN_ID)}>job history</button>
    </div>}
    <details className="plugin-atyrode_code__details"><summary>Measure model performance</summary>
      <p>Benchmark requests contact the selected providers and may incur charges. Measurements are reviewed before they replace a catalog.</p>
      <button type="button" data-action="atyrode.omp.startBenchmark" disabled={!writable || busy || !available || !benchmarkReady || !inventory.data || !inventoryId || benchmarkRunning} onClick={() => { if (record && target && inventoryId) void perform(async () => { const job = await codeWorkflow(host).startBenchmark(target, inventoryId, budget); if (mounted.current) setBenchmarkId(job.jobId); }); }}>{benchmarkRunning ? "Measuring…" : "Run benchmark"}</button>
      {!inventory.data && <p>Discover models first.</p>}
      {!benchmarkReady && <p>Benchmark permission is not ready. Review its exact scope before running paid requests.</p>}
      <PermissionReview host={host} target={target} intent="benchmark" label="Review benchmark permissions" onReady={refresh} />
      {benchmark.data && <button type="button" data-action="atyrode.code.stageCatalog" disabled={!writable || busy || editor !== null} onClick={() => { if (record && target && inventoryId && benchmarkId) void perform(async () => { const staged = await codeWorkflow(host).stageBenchmark({ ...target, inventoryJobId: inventoryId, jobId: benchmarkId }, record.revision, budget); await reviewStaged(staged); }); }}>Stage and review measurements</button>}
    </details>
    <details className="plugin-atyrode_code__details"><summary>Recover a previous catalog job</summary>
      <label>inventory job<input value={historyInventory} maxLength={128} onChange={event => setHistoryInventory(event.target.value)} /></label>
      <label>benchmark job (optional)<input value={historyBenchmark} maxLength={128} onChange={event => setHistoryBenchmark(event.target.value)} /></label>
      <button type="button" disabled={!target || !historyInventory.trim() || busy} onClick={() => { if (target) { setInventoryId(historyInventory.trim()); setBenchmarkId(historyBenchmark.trim() || null); } }}>Read retained results</button>
      <button type="button" onClick={() => host.navigate("manifold://plugin/" + OMP_PLUGIN_ID)}>open native history</button>
    </details>
    {message && <div className="plugin-atyrode_code__warning">
      <p role="status">{message.summary}</p>
      <details className="plugin-atyrode_code__details"><summary>Action error details</summary><pre>{message.details}</pre></details>
    </div>}
  </section>;
}
