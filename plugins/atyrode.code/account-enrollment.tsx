import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { HostServices } from "@manifold/plugin";
import { FALLBACK_POLL_MS, usePolledResource } from "@manifold/plugin/hooks";
import { PublicJobSchema } from "@manifold/protocol";
import { CODE_JOB_TOPIC, CODE_PLUGIN_ID } from "./contract.ts";
import {
  EnrollmentControlResultSchema, EnrollmentObservationSchema, EnrollmentRespondSchema, EnrollmentStartSchema,
  type EnrollmentObservation, type EnrollmentState,
} from "./auth-contract.ts";

const failures: Readonly<Record<string, string>> = {
  code_auth_provenance: "This job is not the governed enrollment for the selected machine and provider. Controls were refused.",
  code_auth_history_incomplete: "Native enrollment history is incomplete or gapped. No callback or completion can be trusted. Cancel this job and explicitly begin again.",
  code_auth_history_invalid: "Native enrollment output did not match the safe worker protocol. No callback or completion can be trusted.",
  code_auth_stale_response: "This callback request is no longer current. The response was not sent. Read the current enrollment before responding.",
  code_auth_input_conflict: "Another native input was accepted first. This response was not replayed. Read the current request before responding.",
  code_auth_input_refused: "Native stdin refused the response. It was not retried; read the current enrollment before taking another action.",
  code_auth_input_unconfirmed: "The native owner has not confirmed the next input sequence. Refresh the job after reconnecting; no callback was sent or replayed.",
  code_auth_observation_changed: "The native enrollment changed during observation. Waiting for a current reading; stale controls are disabled.",
  code_auth_resources_changed: "Native enrollment resources changed. Review Code’s machine setup before starting or controlling this enrollment.",
  code_auth_completion_unconfirmed: "The worker reported completion but native execution did not confirm success. Do not assume enrollment succeeded.",
  code_auth_start_uncertain_cancel_unconfirmed: "Enrollment start was not confirmed and native cancellation was unavailable. Recover the job from native history and check its lifetime.",
  code_auth_invalid_callback: "The callback exceeds the private control-frame limit. Submit only the provider’s supported final callback form.",
};
class EnrollmentError extends Error {}
async function action(host: HostServices, name: string, args: unknown): Promise<unknown> {
  const outcome = await host.client.action(`${CODE_PLUGIN_ID}.${name}`, args);
  if (!outcome.ok) throw new EnrollmentError(failures[outcome.denial.message] ?? "Enrollment is unavailable under current authority, operation consent or native resources.");
  if (outcome.result && typeof outcome.result === "object" && "refused" in outcome.result) {
    const code = String(outcome.result.refused);
    throw new EnrollmentError(failures[code] ?? "The governed enrollment request was refused. Check native setup and read the current job before continuing.");
  }
  return outcome.result;
}
function safeFailure(reason: unknown): string {
  return reason instanceof EnrollmentError ? reason.message : "The enrollment request or observation was unavailable. No automatic retry or enrollment was started.";
}

function CallbackForm({ host, enrollment, disabled, refresh, report }: {
  host: HostServices; enrollment: EnrollmentState; disabled: boolean; refresh: () => void; report: (message: string) => void;
}) {
  const id = useId();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const prompt = enrollment.prompt;
  if (!prompt) return null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || disabled || sent || !prompt) return;
    const form = event.currentTarget;
    const value = new FormData(form).get("callback");
    // The callback exists only in the submitted native input, never Code storage,
    // a feed key, a query string, a React state value, or a persistent action trace.
    form.reset();
    pending.current = true; setBusy(true);
    try {
      const args = EnrollmentRespondSchema.parse({ machineId: enrollment.job.machineId, jobId: enrollment.job.jobId,
        provider: enrollment.provider, promptId: prompt.promptId, nextInputSeq: enrollment.job.nextInputSeq, value });
      const result = EnrollmentControlResultSchema.parse(await action(host, "respondEnrollment", args));
      if (result.jobId !== enrollment.job.jobId) throw new Error("Mismatched enrollment");
      setSent(true);
      report("Callback sent. Waiting for the provider to finish…");
    } catch (reason) { report(safeFailure(reason)); }
    finally { pending.current = false; setBusy(false); refresh(); }
  }
  return <form onSubmit={submit} autoComplete="off" className="plugin-atyrode_code__enrollment-step">
    <label htmlFor={id}>Paste the provider’s final callback</label>
    <p>{prompt.message}</p>
    <p className="plugin-atyrode_code__muted">Use the final redirect URL, callback query, or code#state. Not a bare code or API key.</p>
    <input id={id} name="callback" type="password" autoComplete="off" spellCheck={false} maxLength={8192} required disabled={disabled || busy || sent} />
    <button type="submit" className="plugin-atyrode_code__primary-action" disabled={disabled || busy || sent}>{sent ? "Waiting for provider…" : busy ? "Sending…" : "Continue"}</button>
  </form>;
}

type AccountEnrollmentProps = { host: HostServices; machineId: string | null; available: boolean; onDone?: () => void };
export function AccountEnrollment(props: AccountEnrollmentProps) {
  return <ScopedEnrollment key={JSON.stringify([props.host.principal.id, props.host.containerId, props.machineId])} {...props} />;
}

function ScopedEnrollment({ host, machineId, available, onDone }: AccountEnrollmentProps) {
  const id = useId();
  const [provider, setProvider] = useState("");
  const [selection, setSelection] = useState<{ jobId: string; provider: string } | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const feed = usePolledResource<{ data: EnrollmentObservation | null; error: string | null } | null>(
    async () => {
      try {
        const data = EnrollmentObservationSchema.parse(await action(host, "observeEnrollment", { machineId, ...(selection ? { jobId: selection.jobId } : {}), ...(cursor ? { cursor } : {}) }));
        if (selection && (data.enrollment?.job.jobId !== selection.jobId || data.enrollment.provider !== selection.provider || data.enrollment.job.machineId !== machineId)) throw new Error("Mismatched enrollment");
        return { data, error: null };
      } catch (reason) { return { data: null, error: safeFailure(reason) }; }
    }, FALLBACK_POLL_MS, {
      key: `${CODE_PLUGIN_ID}.enrollment:${JSON.stringify([machineId, selection?.jobId, cursor])}`, restartKey: host.principal.id,
      initial: null, enabled: machineId !== null, topics: [CODE_JOB_TOPIC, ...host.topics.machines], events: host.client,
    },
  );
  const data = feed.value?.data ?? null;
  const enrollment = data?.enrollment ?? null;
  const selectedActive = enrollment && ["queued", "admitted", "start-committed", "started"].includes(enrollment.job.state);
  const canStart = available && data?.availability === "available" && data.pins !== null && data.providers.some(entry => entry.id === provider) && !busy && selection === null;
  const complete = enrollment?.state === "complete" && enrollment.complete !== null;
  const showCallback = enrollment?.state === "challenge" && enrollment.prompt !== null && (!enrollment.auth || authorized);
  async function start() {
    if (!canStart || pending.current || !machineId || !data?.pins) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      const job = PublicJobSchema.parse(await action(host, "startEnrollment", EnrollmentStartSchema.parse({ machineId, provider, ...data.pins })));
      if (job.machineId !== machineId) throw new Error("Mismatched enrollment");
      if (mounted.current) {
        setSelection({ jobId: job.jobId, provider }); setCursor(undefined); setAuthorized(false);
        setMessage("Sign-in started. Waiting for the provider…");
      }
    } catch (reason) { if (mounted.current) setMessage(safeFailure(reason)); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); feed.refresh(); } }
  }
  async function cancel() {
    if (!selection || !machineId || !available || pending.current || (enrollment !== null && !selectedActive)) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      const result = EnrollmentControlResultSchema.parse(await action(host, "cancelEnrollment", { machineId, ...selection }));
      if (result.jobId !== selection.jobId) throw new Error("Mismatched enrollment");
      if (mounted.current) setMessage("Cancellation requested. Waiting for the native job to stop…");
    } catch (reason) { if (mounted.current) setMessage(safeFailure(reason)); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); feed.refresh(); } }
  }
  return <section className="plugin-atyrode_code plugin-atyrode_code__enrollment" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Provider sign-in</h3>
    <ol className="plugin-atyrode_code__enrollment-progress" aria-label="Sign-in progress">
      <li aria-current={selection === null ? "step" : undefined}>1 · provider</li>
      <li aria-current={selection !== null && !complete ? "step" : undefined}>2 · authorize</li>
      <li aria-current={complete ? "step" : undefined}>3 · finish</li>
    </ol>
    {(machineId === null || feed.value?.error || data === null || !available || data.availability === "unavailable") && <p role="status">{machineId === null ? "Choose a machine to sign in." : feed.value?.error ?? (data === null ? "Reading native sign-in setup…" : "Sign-in unavailable. Check machine setup and consent.")}</p>}
    {selection === null && <div className="plugin-atyrode_code__enrollment-step">
      <label htmlFor={`${id}-provider`}>Provider</label>
      <select id={`${id}-provider`} value={provider} disabled={busy} onChange={event => setProvider(event.target.value)}>
        <option value="">Choose provider</option>
        {data?.providers.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
      <p className="plugin-atyrode_code__muted">Begin a new grant on this machine. Existing logins are not imported.</p>
      <button type="button" className="plugin-atyrode_code__primary-action" disabled={!canStart} onClick={() => void start()}>{busy ? "Starting…" : "Begin sign-in"}</button>
    </div>}
    {message && <p role="status">{message}</p>}
    {selection && !enrollment && <p role="status">Reading the selected sign-in. Completion is not confirmed.</p>}
    {enrollment && <div className="plugin-atyrode_code__enrollment-step" aria-live="polite">
      <p><strong>{enrollment.provider}</strong> · {complete ? "signed in" : enrollment.state === "refused" || !selectedActive ? `not completed · ${enrollment.job.state}` : !available ? "machine unavailable" : "authorization in progress"}</p>
      {enrollment.state === "pending" && <p>{selectedActive ? "Waiting for the provider’s next step. Keep this panel open or recover this sign-in later." : "The native job has stopped without confirmed enrollment."}</p>}
      {enrollment.state === "challenge" && enrollment.auth && !showCallback && <>
        <p>{enrollment.auth.instructions}</p>
        {enrollment.auth.challenge && <p>Device code <code className="plugin-atyrode_code__enrollment-challenge">{enrollment.auth.challenge}</code></p>}
        {available && data?.availability === "available" ? <a className="plugin-atyrode_code__primary-action" href={enrollment.auth.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open provider authorization</a> : <p role="status">Authorization controls are unavailable until the machine and native setup are current.</p>}
        {enrollment.prompt ? <button type="button" disabled={busy || !available || data?.availability !== "available"} onClick={() => setAuthorized(true)}>I have the callback · continue</button> : <p className="plugin-atyrode_code__muted">Authorize in the provider page; this panel will update when native completion is confirmed.</p>}
      </>}
      {showCallback && <>
        {enrollment.job.nextInputSeq === null && <p role="status">Waiting for the native input sequence. Callback submission is disabled.</p>}
        <CallbackForm key={`${enrollment.job.jobId}:${enrollment.prompt?.promptId}:${enrollment.job.nextInputSeq}`} host={host} enrollment={enrollment} disabled={busy || !available || data?.availability !== "available" || enrollment.job.nextInputSeq === null} refresh={feed.refresh} report={setMessage} />
        {enrollment.auth && <button type="button" onClick={() => setAuthorized(false)}>back to provider instructions</button>}
      </>}
      {complete && enrollment.complete && <>
        <p>Signed in to {enrollment.complete.provider}{enrollment.complete.identity.email ? ` · ${enrollment.complete.identity.email}` : ""}. Native execution confirmed success.</p>
        <button type="button" className="plugin-atyrode_code__primary-action" onClick={() => { if (onDone) onDone(); else { setSelection(null); setAuthorized(false); setMessage("Sign-in complete. Account choices can now be reviewed."); feed.refresh(); } }}>Finish</button>
      </>}
      {enrollment.refusal && <p role="alert">Sign-in did not complete: <code>{enrollment.refusal}</code>. {selectedActive ? "Cancel this job before starting another sign-in." : "You can explicitly start a new sign-in."}</p>}
      {!selectedActive && !complete && <button type="button" disabled={busy} onClick={() => { setSelection(null); setAuthorized(false); setMessage(null); feed.refresh(); }}>Choose provider again</button>}
    </div>}
    <div className="plugin-atyrode_code__account-toolbar">
      {selection && !complete && <button type="button" disabled={busy || !available || (enrollment !== null && !selectedActive)} onClick={() => void cancel()}>Cancel sign-in</button>}
      <button type="button" disabled={!machineId} onClick={feed.refresh}>refresh</button>
    </div>
    <details className="plugin-atyrode_code__account-details">
      <summary>recover sign-in / native details</summary>
      <label htmlFor={`${id}-job`}>Visible sign-ins</label>
      <select id={`${id}-job`} value={selection?.jobId ?? ""} disabled={busy} onChange={event => {
        const run = data?.runs.find(run => run.jobId === event.target.value);
        setSelection(run ? { jobId: run.jobId, provider: run.provider } : null); setAuthorized(false); setMessage(null);
      }}>
        <option value="">No sign-in selected</option>
        {selection && !data?.runs.some(run => run.jobId === selection.jobId) && <option value={selection.jobId}>{selection.provider} · {selection.jobId} · visibility unconfirmed</option>}
        {data?.runs.map(run => <option key={run.jobId} value={run.jobId}>{run.provider} · {run.state} · {run.jobId}</option>)}
      </select>
      <div className="plugin-atyrode_code__account-toolbar">
        {cursor && <button type="button" onClick={() => setCursor(undefined)}>newest jobs</button>}
        {data?.nextCursor && <button type="button" onClick={() => setCursor(data.nextCursor ?? undefined)}>older jobs</button>}
      </div>
      {enrollment && <p>Job <code>{enrollment.job.jobId}</code> · {enrollment.job.state}{enrollment.prompt ? ` · request ${enrollment.prompt.promptId}` : ""}</p>}
      <p>Callbacks are submitted once to native stdin. Native history and current input sequence govern each response; a worker message alone is not successful completion.</p>
      <button type="button" onClick={() => host.navigate(`manifold://plugin/${CODE_PLUGIN_ID}`)}>native setup / consent</button>
    </details>
  </section>;
}
