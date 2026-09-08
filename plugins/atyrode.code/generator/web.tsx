import { useEffect, useId, useRef, useState, type ComponentType, type FormEvent } from "react";
import type { HostServices, PanelProps } from "@manifold/plugin";
import type { PublicJob } from "@manifold/protocol";
import { Cluster, ControlIcon, ScrollRegion, Stack, Switcher } from "@manifold/ui";
import {
  CODE_ARGV0, CODE_PLUGIN_ID, GENERATOR_PLUGIN_ID, LAUNCHER_PANEL, type PrepareLaunchInput,
} from "../contract.ts";
import {
  codeOperationFailure, prepareCodeLaunch, runCodeOperation, useCodeMachines, useCodeOperation,
} from "../machine-web.ts";

type Status = { kind: "pending" | "denied" | "opened"; text: string } | null;

function MachineGenerator({ host, machineId, available }: { host: HostServices; machineId: string | null; available: boolean }) {
  const id = useId();
  const [inspectionJob, setInspectionJob] = useState<PublicJob | null>(null);
  const [suggestionJob, setSuggestionJob] = useState<PublicJob | null>(null);
  const inspectionFeed = useCodeOperation(host, machineId, "inspect", inspectionJob?.jobId);
  const accountFeed = useCodeOperation(host, machineId, "accounts-list");
  const suggestionFeed = useCodeOperation(host, machineId, "suggest", suggestionJob?.jobId);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [kind, setKind] = useState<PrepareLaunchInput["kind"]>("generated");
  const [accountSource, setAccountSource] = useState<"plugin" | "machine">("plugin");
  const [runtime, setRuntime] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [suggestionPrompt, setSuggestionPrompt] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [requesting, setRequesting] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = useRef({ host, available });
  current.current = { host, available };
  const observation = inspectionFeed.observation;
  const inspection = inspectionFeed.error === null ? observation?.snapshot ?? null : null;
  const accounts = accountFeed.error === null ? accountFeed.observation?.snapshot ?? null : null;
  const suggestion = suggestionFeed.error === null ? suggestionFeed.observation?.snapshot ?? null : null;
  const selection = draft ?? inspection?.value.selection ?? {};
  const effectiveSource = kind === "untrusted" || kind === "runtime" ? "machine" : accountSource;
  const revision = effectiveSource === "machine" ? null : accounts?.value.preferenceRevision ?? 0;
  const previewMatches = inspection !== null && observation?.state === "ready" &&
    inspection.value.baseRevision === revision &&
    Object.keys(selection).length === Object.keys(inspection.value.selection).length &&
    Object.entries(selection).every(([key, value]) => inspection.value.selection[key] === value);
  const missingAccounts = effectiveSource === "plugin" && (accounts === null || accountFeed.observation?.state !== "ready");
  const missingMount = host.containerId === null || host.authoring === null;
  const busy = requesting || status?.kind === "pending" || observation?.state === "pending";
  const modeAvailable = inspection?.value.launch_modes.some((mode) => mode.mode === kind && mode.available) ?? false;

  async function request(operation: "inspect" | "suggest" | "accounts-list") {
    if (machineId === null || !available || pending.current) return;
    pending.current = true;
    setRequesting(true);
    setStatus(null);
    try {
      const job = operation === "accounts-list"
        ? await runCodeOperation(host, machineId, operation, {})
        : operation === "inspect"
          ? await runCodeOperation(host, machineId, operation, { selection, accountSource: effectiveSource })
          : await runCodeOperation(host, machineId, operation, { selection, accountSource: effectiveSource, prompt: suggestionPrompt });
      if (mounted.current) {
        if (operation === "inspect") setInspectionJob(job);
        if (operation === "suggest") setSuggestionJob(job);
      }
    } catch (reason) {
      if (mounted.current) setStatus({ kind: "denied", text: codeOperationFailure(reason) });
    } finally {
      pending.current = false;
      if (mounted.current) { setRequesting(false); inspectionFeed.refresh(); accountFeed.refresh(); suggestionFeed.refresh(); }
    }
  }

  async function launch(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (pending.current || machineId === null || !available || missingMount) return;
    const recovery = event === undefined;
    if (!recovery && (!previewMatches || !modeAvailable || missingAccounts || inspection === null)) return;
    pending.current = true;
    setStatus({ kind: "pending", text: recovery ? "Opening Code CLI recovery…" : "Checking the reviewed Code choices…" });
    const containerId = host.containerId;
    try {
      const prepared = recovery ? { program: { argv: [CODE_ARGV0] as [string] } } : await prepareCodeLaunch(host, {
        machineId, inspectionJobId: inspection!.job.jobId, kind, selection,
        ...(kind === "runtime" ? { runtime } : {}), worktree, prompt,
        accounts: effectiveSource === "plugin"
          ? { source: "plugin", revision: accounts!.value.preferenceRevision, baselineJobId: accounts!.job.jobId }
          : { source: "machine" },
      });
      if (!mounted.current) return;
      const latest = current.current;
      if (!latest.available || latest.host.client !== host.client || latest.host.containerId !== containerId || latest.host.authoring === null) {
        setStatus({ kind: "denied", text: "The selected machine or mounted container changed. Review the destination again." });
        return;
      }
      const terminal = await latest.host.client.openTerminal({
        elementId: crypto.randomUUID(), machineId, cols: 120, rows: 40, placement: "tile",
        program: prepared.program, ...(cwd === "" ? {} : { cwd }),
      });
      if (mounted.current) setStatus(terminal.status === "running"
        ? { kind: "opened", text: `Terminal ${terminal.name ?? terminal.id} opened. Inspect its output for Code or omp readiness.` }
        : { kind: "denied", text: `Terminal ${terminal.name ?? terminal.id} is ${terminal.status}. Inspect it before retrying.` });
    } catch (reason) {
      if (mounted.current) setStatus({ kind: "denied", text: codeOperationFailure(reason) });
    } finally {
      pending.current = false;
    }
  }

  return <Stack gap="1rem">
    <Cluster gap="0.5rem">
      <button type="button" disabled={!available || busy} onClick={() => { void request("inspect"); }}>Preview these choices</button>
      <button type="button" disabled={machineId === null} onClick={() => { inspectionFeed.refresh(); accountFeed.refresh(); suggestionFeed.refresh(); }}>Read shared observations</button>
    </Cluster>
    <p className="plugin-atyrode_code_generator__muted">A preview runs Code on the selected machine. Reading observations never starts a job. Manifold owns execution, consent and retained history.</p>
    {inspectionFeed.error !== null && <p role="status">The inspection is unavailable under the current authority.</p>}
    {observation?.state === "pending" && <p role="status">Inspection is pending; no new preview is confirmed.</p>}
    {observation?.state === "failed" && <p role="status">The requested inspection failed. Any retained preview is historical.</p>}
    {observation?.state === "unavailable" && <p role="status">The inspection result could not be read or verified.</p>}
    {inspection === null ? <p>Request a preview to read the real catalog, facets and launch capabilities.</p> : <>
      <section className="plugin-atyrode_code_generator__note" aria-label="Inspection provenance">
        <p>{previewMatches ? "Reviewed preview" : "Historical or different preview — request these choices before launching"}</p>
        <p>Observed {inspection.value.observed_at} · job <code>{inspection.job.jobId}</code></p>
        <p>Catalog: {inspection.value.catalog.state}. Account source: {inspection.value.baseRevision === null ? "existing CLI settings" : `Manifold revision ${inspection.value.baseRevision}`}.</p>
      </section>
      {inspection.value.catalog.state === "missing" && <section aria-labelledby={`${id}-onboarding`}>
        <h3 id={`${id}-onboarding`}>First-run review</h3>
        <p>No runnable catalog was found. Review the reported provider availability and native Code operation bindings. Catalog generation remains available through the headless <code>code generate init</code> and <code>code generate</code> commands; this inspection has not written machine configuration.</p>
        <ul>{inspection.value.providers.map((provider) => <li key={provider.id}>{provider.id}: {provider.credential_state}</li>)}</ul>
      </section>}
      <fieldset disabled={busy} className="plugin-atyrode_code_generator__facets">
        <legend>Code dials</legend>
        <Switcher threshold="30rem" gap="0.75rem">
          {inspection.value.facets.map((facet) => <Stack key={facet.key} gap="0.35rem">
            <label htmlFor={`${id}-facet-${facet.key}`}>{facet.key}</label>
            <select id={`${id}-facet-${facet.key}`} value={selection[facet.key] ?? ""} onChange={(event) => setDraft({ ...selection, [facet.key]: event.target.value })}>
              {facet.values.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </Stack>)}
        </Switcher>
      </fieldset>
      <section aria-labelledby={`${id}-routing`}>
        <Stack gap="0.6rem">
          <h3 id={`${id}-routing`}>Routing preview</h3>
          {!previewMatches && <p>The routing below belongs to the retained preview, not the current draft.</p>}
          {inspection.value.routing.length === 0 ? <p>No generated routing reported.</p> : <ul>{inspection.value.routing.map((route) => <li key={route.role}>
            <strong>{route.role}</strong>: {route.primary}{route.fallbacks.length > 0 ? ` → ${route.fallbacks.join(" → ")}` : ""}{route.agent_override ? " (agent override)" : ""}
          </li>)}</ul>}
          {inspection.value.estimates !== null && <p>Relative estimate: cost {inspection.value.estimates.cost}, speed {inspection.value.estimates.speed} on the catalog’s {inspection.value.estimates.scale_min}–{inspection.value.estimates.scale_max} scale. These are not live billing or performance guarantees.</p>}
        </Stack>
      </section>
    </>}
    <form onSubmit={(event) => { void launch(event); }} aria-busy={busy}>
      <Stack gap="0.9rem">
        <Switcher threshold="32rem" gap="1rem">
          <Stack gap="0.35rem">
            <label htmlFor={`${id}-kind`}>Launch kind</label>
            <select id={`${id}-kind`} value={kind} disabled={busy} onChange={(event) => setKind(event.target.value as PrepareLaunchInput["kind"])}>
              <option value="generated">Generated routing</option><option value="managed">Managed omp settings</option>
              <option value="untrusted">Untrusted omp</option><option value="runtime">Delegated runtime</option>
            </select>
            {inspection !== null && !modeAvailable && <p>This mode was not advertised as available.</p>}
          </Stack>
          <Stack gap="0.35rem">
            <label htmlFor={`${id}-account-source`}>Account choices</label>
            <select id={`${id}-account-source`} value={effectiveSource} disabled={busy || kind === "untrusted" || kind === "runtime"} onChange={(event) => setAccountSource(event.target.value as "plugin" | "machine")}>
              <option value="plugin">Shared Manifold choices</option><option value="machine">Existing CLI settings</option>
            </select>
            <p className="plugin-atyrode_code_generator__muted">Shared choices are passed to this launch only. Existing CLI settings use the machine’s normal Code configuration. Neither option rewrites it.</p>
            {effectiveSource === "plugin" && <>
              <p>{accounts === null ? "Read accounts before launching with shared choices." : `Preset ${accounts.value.activePreset} · revision ${accounts.value.preferenceRevision}`}</p>
              <button type="button" disabled={!available || busy} onClick={() => { void request("accounts-list"); }}>Refresh account choices</button>
            </>}
          </Stack>
        </Switcher>
        {kind === "runtime" && <Stack gap="0.35rem">
          <label htmlFor={`${id}-runtime`}>Advertised runtime</label>
          <select id={`${id}-runtime`} value={runtime} disabled={busy} onChange={(event) => setRuntime(event.target.value)}>
            <option value="">Choose a runtime</option>
            {inspection?.value.runtime_targets.map((target) => <option key={target.name} value={target.name}>{target.label || target.name} · {target.phase}</option>)}
          </select>
          <p className="plugin-atyrode_code_generator__muted">Only the thinking dial is passed to a delegated runtime. Managed and untrusted launches do not take generated facets.</p>
        </Stack>}
        <label htmlFor={`${id}-cwd`}>Working directory on the machine (optional)</label>
        <input id={`${id}-cwd`} value={cwd} disabled={busy} maxLength={4096} placeholder="Machine default" autoComplete="off" spellCheck={false} onChange={(event) => setCwd(event.target.value)} />
        <label htmlFor={`${id}-prompt`}>First prompt (optional)</label>
        <textarea id={`${id}-prompt`} value={prompt} disabled={busy} maxLength={4000} rows={3} onChange={(event) => setPrompt(event.target.value)} />
        <label className="plugin-atyrode_code_generator__checkbox"><input type="checkbox" checked={worktree} disabled={busy} onChange={(event) => setWorktree(event.target.checked)} />Launch in a Code operator worktree</label>
        <Cluster gap="0.75rem">
          <button type="submit" className="plugin-atyrode_code_generator__launch" disabled={!available || busy || missingMount || !previewMatches || !modeAvailable || missingAccounts || (kind === "runtime" && runtime === "")}><ControlIcon kind="add" />Launch reviewed choices</button>
          <button type="button" disabled={!available || busy || missingMount} onClick={() => { void launch(); }}>Open Code CLI recovery</button>
        </Cluster>
        <p className="plugin-atyrode_code_generator__muted">{missingMount ? "Open an editable container view before opening a terminal tile." : `Destination: current container ${host.containerId}. The Code panel stays open.`}</p>
      </Stack>
    </form>
    <section aria-labelledby={`${id}-suggestion`}>
      <Stack gap="0.65rem">
        <h3 id={`${id}-suggestion`}>Suggest a configuration</h3>
        <label htmlFor={`${id}-suggestion-prompt`}>Describe the work for the machine-local evaluator</label>
        <textarea id={`${id}-suggestion-prompt`} value={suggestionPrompt} maxLength={16384} rows={3} onChange={(event) => setSuggestionPrompt(event.target.value)} />
        <button type="button" disabled={!available || busy || suggestionPrompt.trim() === "" || suggestionFeed.observation?.state === "pending"} onClick={() => { void request("suggest"); }}>Request suggestion</button>
        {suggestionFeed.observation?.state === "pending" && <p role="status">Suggestion is pending.</p>}
        {(suggestionFeed.error !== null || suggestionFeed.observation?.state === "failed" || suggestionFeed.observation?.state === "unavailable") && <p role="status">No verified current suggestion is available. Check the native operation status and local evaluator setup.</p>}
        {suggestion !== null && <>
          <p>Evaluator: {suggestion.value.evaluator} · observed {suggestion.value.observed_at} · job <code>{suggestion.job.jobId}</code></p>
          <ul>{suggestion.value.actions.map((action) => <li key={action.key}>{action.key}: {action.value}</li>)}</ul>
          <button type="button" disabled={busy || suggestionFeed.observation?.state !== "ready" || suggestion.value.baseRevision !== revision} onClick={() => setDraft(suggestion.value.selection)}>Use suggestion as a draft</button>
          <p className="plugin-atyrode_code_generator__muted">Applying a suggestion only changes this draft. Request a matching routing preview and review it before launching.</p>
        </>}
      </Stack>
    </section>
    <div role="status" aria-live="polite" aria-atomic="true" className="plugin-atyrode_code_generator__status" data-state={status?.kind ?? "idle"}>{status?.text}</div>
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
      <header><h2>Code</h2><p>Review real routing and account choices here; Manifold opens and owns the terminal.</p></header>
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
        <p>Missing artifacts, consent or backend bindings? Manage those in native Plugins. Complete job history, automatic schedules and operation status live there, not in a separate Code registry. Usage and Accounts are independent Code panels.</p>
        <button type="button" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>Open Code in Plugins</button>
      </aside>
    </Stack>
  </ScrollRegion>;
}

export default { id: GENERATOR_PLUGIN_ID, panels: { [LAUNCHER_PANEL]: Launcher } } satisfies { id: string; panels: Record<string, ComponentType<PanelProps>> };
