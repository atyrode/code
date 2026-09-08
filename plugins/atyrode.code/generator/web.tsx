import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import { Cluster, ScrollRegion, Stack, Switcher } from "@manifold/ui";
import { CODE_PLUGIN_ID, GENERATOR_PLUGIN_ID, LAUNCHER_PANEL, type CodeSelection } from "../contract.ts";
import { type CodeInspection, type CodeRunInput } from "../machine-contract.ts";
import {
  codeOperationFailure, prepareCodeLaunch, runCodeOperation, useCodeMachines, useCodeOperation,
  useCodeConfiguration, useCodeSetup, initializeCodeConfiguration, stageCodeConfiguration,
  promoteCodeConfiguration, selectCodeConfiguration,
} from "../machine-web.ts";

function Routing({ value }: { value: CodeInspection }) {
  return <section aria-label="Reviewed routing">
    <p>Observed {new Date(value.observedAt * 1000).toLocaleString()} · configuration revision {value.baseRevision} · catalog <code>{value.catalogRevision}</code></p>
    <p>{value.ready ? "Ready at observation" : "Not ready for launch"}. Live availability can change.</p>
    {value.refusals.length > 0 && <ul aria-label="Domain refusals">{value.refusals.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
    <ul>{value.routing.map((route) => <li key={route.role}><strong>{route.role}</strong>: {route.lead}{route.fallback.length > 0 ? ` → ${route.fallback.join(" → ")}` : ""}{route.agentBacked ? " (agent-backed)" : ""}</li>)}</ul>
    <p>Relative cost {value.estimates.costScore}, speed {value.estimates.speedScore}, on the {value.estimates.scaleMin}–{value.estimates.scaleMax} scale. Not billing or performance guarantees.</p>
  </section>;
}
function MachineGenerator({ host, machineId, available }: { host: HostServices; machineId: string | null; available: boolean }) {
  const id = useId();
  const configuration = useCodeConfiguration(host, machineId);
  const setup = useCodeSetup(host, machineId);
  const inspection = useCodeOperation(host, machineId, "inspect");
  const review = useCodeOperation(host, machineId, "catalog-review");
  const generation = useCodeOperation(host, machineId, "catalog-generate");
  const plan = useCodeOperation(host, machineId, "analysis-plan");
  const suggestion = useCodeOperation(host, machineId, "suggest");
  const auth = useCodeOperation(host, machineId, "auth-status");
  const [editor, setEditor] = useState<{ modelsYaml: string; revision: number } | null>(null);
  const [dials, setDials] = useState<{ selection: CodeSelection; revision: number } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [suggestionPrompt, setSuggestionPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const record = configuration.data?.configuration ?? null;
  const feeds = [inspection, review, generation, plan, suggestion, auth];
  const current = useRef({ host, available });
  current.current = { host, available };
  const inspected = inspection.observation?.snapshot ?? null;
  const reviewed = review.observation?.snapshot ?? null;
  const planned = plan.observation?.snapshot ?? null;
  const generated = generation.observation?.snapshot ?? null;
  const suggested = suggestion.observation?.snapshot ?? null;
  const selection = dials?.selection ?? record?.selection ?? null;
  const dialsStale = dials !== null && dials.revision !== record?.revision;
  const editorStale = editor !== null && editor.revision !== record?.revision;
  const previewCurrent = record !== null && inspected !== null && inspection.observation?.state === "ready" && inspected.value.baseRevision === record.revision && inspected.value.catalogRevision === record.active?.catalogRevision && JSON.stringify(inspected.value.selection) === JSON.stringify(selection);
  const reviewCurrent = record !== null && reviewed !== null && review.observation?.state === "ready" && reviewed.value.baseRevision === record.revision && reviewed.value.catalogRevision === record.draft?.catalogRevision;
  const planCurrent = record !== null && planned !== null && plan.observation?.state === "ready" && planned.value.baseRevision === record.revision && planned.value.catalogRevision === record.active?.catalogRevision && JSON.stringify(planned.value.selection) === JSON.stringify(selection);
  const missingMount = host.containerId === null || host.authoring === null;
  function ready(operation: string) {
    return available && setup.data?.connected === true && setup.data.installation?.ready === true && setup.data.operations?.[`${CODE_PLUGIN_ID}.${operation}`]?.ready === true;
  }
  async function perform(work: () => Promise<unknown>, success: string) {
    if (pending.current || machineId === null || !available) return;
    pending.current = true; setBusy(true); setStatus(null);
    try { await work(); if (mounted.current) setStatus(success); }
    catch (reason) { if (mounted.current) setStatus(codeOperationFailure(reason)); }
    finally {
      pending.current = false;
      if (mounted.current) { setBusy(false); configuration.refresh(); setup.refresh(); for (const feed of feeds) feed.refresh(); }
    }
  }
  function request(request: CodeRunInput) {
    void perform(() => runCodeOperation(host, request.machineId, request.operation, request.input), "Job requested. Admission is not completion; read its governed result below.");
  }
  async function launch() {
    if (!record || !planned || !planCurrent || missingMount || !machineId) return;
    const destination = host.containerId;
    await perform(async () => {
      const prepared = await prepareCodeLaunch(host, { machineId, planJobId: planned.job.jobId, expectedRevision: record.revision, prompt });
      if (!mounted.current || current.current.host.client !== host.client || current.current.host.containerId !== destination || !current.current.available || current.current.host.authoring === null) throw new Error("Destination changed");
      const terminal = await host.client.openTerminal({ elementId: crypto.randomUUID(), machineId, cols: 120, rows: 40, placement: "tile", runtime: prepared.runtime, ...(cwd === "" ? {} : { cwd }) });
      if (terminal.status !== "running") throw new Error("Terminal did not start");
    }, "Native terminal opened. Its process output, not terminal creation, establishes OMP readiness.");
  }
  return <Stack gap="1rem">
    <section className="plugin-atyrode_code_generator__note" aria-labelledby={`${id}-setup`}>
      <h3 id={`${id}-setup`}>Native setup and consent</h3>
      {setup.error && <p role="status">{setup.error}</p>}
      {setup.data ? <>
        <p>{setup.data.connected ? "Owner connected" : "Owner disconnected"} · installation {setup.data.installation?.revision ?? "not installed"} · {setup.data.installation?.ready ? "installation ready" : "installation unavailable"}</p>
        <ul>{Object.entries(setup.data.operations ?? {}).map(([operation, state]) => <li key={operation}><code>{operation}</code>: {state.ready ? "resources ready" : state.reason ?? "unavailable"}</li>)}</ul>
        <details><summary>Current native consent records</summary>{setup.data.consents.length === 0 ? <p>No consent records reported.</p> : <ul>{setup.data.consents.map((consent, index) => <li key={index}>{consent.node} · {consent.cap} · {consent.enabled ? "enabled" : "disabled"} · revision {consent.revision}</li>)}</ul>}</details>
      </> : <p>Select a machine to read installation, operation resources and consent. Resource readiness alone does not authorize execution.</p>}
      <button type="button" disabled={busy || !ready("auth-status")} onClick={() => { if (machineId) request({ machineId, operation: "auth-status", input: {} }); }}>Check authentication service</button>
      {auth.observation?.snapshot && <p>Authentication service: {auth.observation.snapshot.value.ok ? "responded healthy" : "not healthy"}. This is not a provider login confirmation.</p>}
    </section>
    <section aria-labelledby={`${id}-configuration`}>
      <h3 id={`${id}-configuration`}>Shared native configuration</h3>
      {configuration.error && <p role="status">{configuration.error}</p>}
      {record ? <p>Revision {record.revision} · updated by {record.updatedBy} · preset {record.state.activePreset}. All participants share these choices and the promoted catalog.</p> : <>
        <p>{configuration.data?.status === "transition_required" ? "Existing native account choices need an explicit format transition. All presets, exclusions and source authority will be preserved in the same native record." : "Initialize an empty Manual account selection before staging your first catalog. No machine configuration files are read."}</p>
        {configuration.data?.previousChoices && <details><summary>Existing choices to preserve</summary><pre>{JSON.stringify(configuration.data.previousChoices, null, 2)}</pre></details>}
        <button type="button" disabled={busy || !available || !configuration.data} onClick={() => { if (machineId && configuration.data) void perform(() => initializeCodeConfiguration(host, { machineId, expectedRevision: configuration.data!.revision }), "Native configuration initialized without discarding existing choices."); }}>{configuration.data?.status === "transition_required" ? "Preserve and transition native choices" : "Initialize native choices"}</button>
      </>}
      <button type="button" disabled={!machineId} onClick={() => { configuration.refresh(); setup.refresh(); for (const feed of feeds) feed.refresh(); }}>Read shared state</button>
    </section>
    <section aria-labelledby={`${id}-catalog`}>
      <Stack gap="0.65rem">
        <h3 id={`${id}-catalog`}>Catalog source and explicit promotion</h3>
        <p>Models YAML is the catalog source. Generation probes providers and may incur cost. Neither generation nor review promotes a catalog. Editing stays local until explicitly staged.</p>
        <Cluster gap="0.5rem">
          <button type="button" disabled={busy || !record || !ready("catalog-generate") || generation.observation?.state === "pending"} onClick={() => { if (machineId) request({ machineId, operation: "catalog-generate", input: {} }); }}>Generate candidate (provider requests / possible cost)</button>
          <button type="button" disabled={busy || !record} onClick={() => { if (record) setEditor({ modelsYaml: record.draft?.modelsYaml ?? record.active?.modelsYaml ?? "", revision: record.revision }); }}>Edit catalog candidate</button>
          <button type="button" disabled={busy || !record || !generated || generation.observation?.state !== "ready"} onClick={() => { if (machineId && record && generated) void perform(() => stageCodeConfiguration(host, { machineId, expectedRevision: record.revision, source: { kind: "generation", jobId: generated.job.jobId } }), "Generated source staged. Review it before promoting."); }}>Stage verified generation</button>
        </Cluster>
        {generated && <details><summary>Generated source · {generated.job.jobId}</summary><pre>{generated.value.modelsYaml}</pre></details>}
        {editor && <>
          <label htmlFor={`${id}-yaml`}>Candidate models YAML</label>
          <textarea id={`${id}-yaml`} rows={14} maxLength={100000} spellCheck={false} value={editor.modelsYaml} disabled={busy} onChange={(event) => setEditor({ ...editor, modelsYaml: event.target.value })} />
          {editorStale && <p role="alert">Shared configuration changed. Copy your edits if needed, then reopen the current source; this stale edit cannot overwrite it.</p>}
          <Cluster gap="0.5rem"><button type="button" disabled={busy || editorStale || !editor.modelsYaml.trim()} onClick={() => { if (machineId) void perform(async () => { await stageCodeConfiguration(host, { machineId, expectedRevision: editor.revision, source: { kind: "edit", modelsYaml: editor.modelsYaml } }); if (mounted.current) setEditor(null); }, "Source staged. Request review explicitly."); }}>Stage this exact source</button><button type="button" disabled={busy} onClick={() => setEditor(null)}>Discard local edit</button></Cluster>
        </>}
        {record?.draft && <details><summary>Staged catalog {record.draft.catalogRevision}</summary><pre>{record.draft.modelsYaml}</pre></details>}
        <button type="button" disabled={busy || !record?.draft || !ready("catalog-review") || review.observation?.state === "pending"} onClick={() => { if (machineId && record) request({ machineId, operation: "catalog-review", input: { expectedRevision: record.revision } }); }}>Review staged catalog</button>
        {reviewed && <><p>{reviewCurrent ? "Current candidate review" : "Historical review — cannot promote"}</p><Routing value={reviewed.value} /><details><summary>Candidate full selection</summary><pre>{JSON.stringify(reviewed.value.selection, null, 2)}</pre></details></>}
        <button type="button" disabled={busy || !reviewCurrent} onClick={() => { if (machineId && record && reviewed) void perform(() => promoteCodeConfiguration(host, { machineId, expectedRevision: record.revision, reviewJobId: reviewed.job.jobId }), "Reviewed catalog and its exact selection promoted. Inspect before planning a launch."); }}>Promote exact reviewed catalog and selection</button>
        {reviewCurrent && !reviewed?.value.ready && <p>This valid catalog can be promoted while services are unavailable; launch still refuses until real resources and accounts are ready.</p>}
      </Stack>
    </section>
    {record?.active && <section aria-labelledby={`${id}-dials`}>
      <Stack gap="0.65rem">
        <h3 id={`${id}-dials`}>Active catalog and Code dials</h3>
        <details><summary>Promoted source {record.active.catalogRevision}</summary><pre>{record.active.modelsYaml}</pre></details>
        {selection && <fieldset disabled={busy}><legend>Shared selection draft</legend><Switcher threshold="30rem" gap="0.75rem">{Object.entries(selection).map(([key, value]) => {
          const values = inspected?.value.facets.find((facet) => facet.key === key)?.values ?? reviewed?.value.facets.find((facet) => facet.key === key)?.values ?? [value];
          return <Stack gap="0.35rem" key={key}><label htmlFor={`${id}-dial-${key}`}>{key}</label><select id={`${id}-dial-${key}`} value={value} onChange={(event) => setDials({ selection: { ...selection, [key]: event.target.value }, revision: dials?.revision ?? record.revision })}>{!values.includes(value) && <option value={value}>{value}</option>}{values.map((option) => <option key={option} value={option}>{option}</option>)}</select></Stack>;
        })}</Switcher></fieldset>}
        {dialsStale && <p role="alert">Shared configuration changed. Discard the stale dial draft before editing current choices.</p>}
        <Cluster gap="0.5rem"><button type="button" disabled={busy || !dials || dialsStale} onClick={() => { if (machineId && dials) void perform(async () => { await selectCodeConfiguration(host, { machineId, expectedRevision: dials.revision, selection: dials.selection }); if (mounted.current) setDials(null); }, "Shared dials committed. Inspect this revision before planning."); }}>Commit shared dials</button><button type="button" disabled={busy || !dials} onClick={() => setDials(null)}>Discard dial draft</button></Cluster>
        <button type="button" disabled={busy || !!dials || !ready("inspect") || inspection.observation?.state === "pending"} onClick={() => { if (machineId) request({ machineId, operation: "inspect", input: { expectedRevision: record.revision } }); }}>Inspect committed choices</button>
        {inspected && <><p>{previewCurrent ? "Current inspection" : "Historical or different inspection"}</p><Routing value={inspected.value} /></>}
        <button type="button" disabled={busy || !previewCurrent || !inspected?.value.ready || !ready("analysis-plan") || plan.observation?.state === "pending"} onClick={() => { if (machineId && inspected) request({ machineId, operation: "analysis-plan", input: { expectedRevision: record.revision, inspectionJobId: inspected.job.jobId } }); }}>Prepare analysis plan from inspection</button>
        {planned && <p>{planCurrent ? "Current verified plan" : "Historical plan — request a fresh inspection and plan"} · job <code>{planned.job.jobId}</code></p>}
        <label htmlFor={`${id}-cwd`}>Working directory (optional, native terminal authority applies)</label><input id={`${id}-cwd`} value={cwd} maxLength={4096} onChange={(event) => setCwd(event.target.value)} />
        <label htmlFor={`${id}-prompt`}>First prompt (optional)</label><textarea id={`${id}-prompt`} value={prompt} maxLength={16384} rows={3} onChange={(event) => setPrompt(event.target.value)} />
        <button type="button" disabled={busy || !planCurrent || !planned?.value.ready || !ready("launch") || missingMount} onClick={() => { void launch(); }}>Open reviewed native OMP terminal</button>
        <p>{missingMount ? "Open an editable container view for terminal placement." : `Destination: current container ${host.containerId}.`}</p>
        <label htmlFor={`${id}-suggestion`}>Describe work for the evaluator</label><textarea id={`${id}-suggestion`} value={suggestionPrompt} rows={3} maxLength={16384} onChange={(event) => setSuggestionPrompt(event.target.value)} />
        <button type="button" disabled={busy || !ready("suggest") || !suggestionPrompt.trim() || suggestion.observation?.state === "pending"} onClick={() => { if (machineId) request({ machineId, operation: "suggest", input: { expectedRevision: record.revision, prompt: suggestionPrompt } }); }}>Request suggestion</button>
        {suggested && <><p>Evaluator {suggested.value.evaluator} · job {suggested.job.jobId}</p><ul>{suggested.value.actions.map((action) => <li key={action.key}>{action.key}: {action.value}</li>)}</ul><button type="button" disabled={busy || suggestion.observation?.state !== "ready" || suggested.value.baseRevision !== record.revision || suggested.value.catalogRevision !== record.active.catalogRevision} onClick={() => setDials({ selection: suggested.value.selection, revision: record.revision })}>Use suggestion as uncommitted dial draft</button></>}
      </Stack>
    </section>}
    <div role="status" aria-live="polite" aria-atomic="true" className="plugin-atyrode_code_generator__status">
      {busy && <p>Submitting an explicit request…</p>}{status && <p>{status}</p>}
      {feeds.map((feed, index) => <p key={index}>{["Inspection", "Catalog review", "Generation", "Analysis plan", "Suggestion", "Authentication service"][index]}: {feed.error ?? feed.observation?.state ?? "reading"}{feed.observation?.failure ? ` · ${feed.observation.failure}` : ""}{feed.observation?.latest ? ` · job ${feed.observation.latest.jobId}` : ""}</p>)}
    </div>
  </Stack>;
}

function Launcher({ host }: PanelProps) {
  const id = useId();
  const [selection, setSelection] = useState<string | null>(null);
  const { machines, error, refresh } = useCodeMachines(host);
  const machine = machines?.find((entry) => entry.id === selection);
  const available = error === null && machine !== undefined && machine.online && machine.revoked !== true;
  return <ScrollRegion className="plugin-atyrode_code_generator" aria-label="Code launcher">
    <Stack className="plugin-atyrode_code_generator__body" gap="1.25rem">
      <header><h2>Code</h2><p>Initialize, review and promote shared routing here; Manifold opens and owns the terminal.</p></header>
      <Stack gap="0.4rem">
        <label htmlFor={`${id}-machine`}>Machine</label>
        <select id={`${id}-machine`} value={selection ?? ""} onChange={(event) => setSelection(event.target.value || null)}>
          <option value="">Choose a machine</option>
          {selection !== null && machine === undefined && <option value={selection}>Selected machine unavailable ({selection})</option>}
          {machines?.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.id}{entry.revoked === true ? " (revoked)" : entry.online ? " (online)" : " (offline)"}</option>)}
        </select>
        <p role="status" className="plugin-atyrode_code_generator__muted">{error !== null ? "Machine list unavailable." : machines === null ? "Reading machines…" : selection === null ? "No machine is selected. Opening this panel does not execute anything." : !available ? "The selected machine is offline, revoked or unavailable. It will not be replaced by another machine with the same name." : "Immutable machine ID retained. Availability does not imply consent or backend readiness."}</p>
        <button type="button" onClick={refresh}>Read machine availability</button>
      </Stack>
      <MachineGenerator key={`${host.principal.id}:${selection ?? "none"}`} host={host} machineId={selection} available={available} />
      <aside className="plugin-atyrode_code_generator__note">
        <p>Missing artifacts, consent or backend bindings? Manage those in native Plugins. Complete job history and operation status live there. Usage and Accounts are independent Code panels.</p>
        <button type="button" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>Open Code in Plugins</button>
      </aside>
    </Stack>
  </ScrollRegion>;
}

export default { id: GENERATOR_PLUGIN_ID, panels: { [LAUNCHER_PANEL]: Launcher } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
