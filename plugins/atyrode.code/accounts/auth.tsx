import { useId, useRef, useState, type FormEvent } from "react";
import type { HostServices } from "@manifold/plugin";
import { FALLBACK_POLL_MS, usePolledResource } from "@manifold/plugin/hooks";
import { PublicJobSchema } from "@manifold/protocol";
import { Cluster, Stack } from "@manifold/ui";
import { CODE_PLUGIN_ID } from "../contract.ts";
import { CODE_JOB_TOPIC } from "../machine-contract.ts";
import {
  EnrollmentControlResultSchema, EnrollmentObservationSchema, EnrollmentRespondSchema, EnrollmentStartSchema,
  type EnrollmentObservation, type EnrollmentState,
} from "../auth-contract.ts";

const failures: Readonly<Record<string, string>> = {
  code_auth_provenance: "This job is not the governed enrollment for the selected machine and provider. Controls were refused.",
  code_auth_history_incomplete: "Native enrollment history is incomplete or gapped. No callback or completion can be trusted. Cancel this job and explicitly begin again.",
  code_auth_history_invalid: "Native enrollment output did not match the safe worker protocol. No callback or completion can be trusted.",
  code_auth_stale_response: "This callback request is no longer current. The response was not sent. Read the current enrollment before responding.",
  code_auth_input_conflict: "Another native input was accepted first. This response was not replayed. Read the current request before responding.",
  code_auth_input_refused: "Native stdin refused the response. It was not retried; read the current enrollment before taking another action.",
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
  const prompt = enrollment.prompt;
  if (!prompt) return null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || disabled || !prompt) return;
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
      report("Response accepted by native stdin; provider completion is not yet confirmed.");
    } catch (reason) { report(safeFailure(reason)); }
    finally { pending.current = false; setBusy(false); refresh(); }
  }
  return <form onSubmit={submit} autoComplete="off">
    <Stack gap="0.5rem">
      <label htmlFor={id}>Provider callback for this request</label>
      <p>{prompt.message}</p>
      <p className="plugin-atyrode_code_accounts__muted">Request <code>{prompt.promptId}</code> · job <code>{enrollment.job.jobId}</code>. Paste the exact final redirect URL, callback query, or code#state. Bare codes and API keys are unsupported.</p>
      <input id={id} name="callback" type="password" autoComplete="off" spellCheck={false} maxLength={8192} required disabled={disabled || busy} />
      <button type="submit" disabled={disabled || busy}>{busy ? "Sending once…" : "Submit this callback once"}</button>
    </Stack>
  </form>;
}

export function AccountEnrollment({ host, machineId, available }: { host: HostServices; machineId: string | null; available: boolean }) {
  const id = useId();
  const [provider, setProvider] = useState("");
  const [selection, setSelection] = useState<{ jobId: string; provider: string } | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
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
  const canStart = available && data?.pins !== null && data?.pins !== undefined && data.providers.some(entry => entry.id === provider) && !busy && !selectedActive;
  async function start() {
    if (!canStart || pending.current || !machineId || !data?.pins) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      const job = PublicJobSchema.parse(await action(host, "startEnrollment", EnrollmentStartSchema.parse({ machineId, provider, ...data.pins })));
      if (job.machineId !== machineId) throw new Error("Mismatched enrollment");
      setSelection({ jobId: job.jobId, provider }); setCursor(undefined);
      setMessage("Fresh enrollment explicitly started. Waiting for the private worker’s safe challenge.");
    } catch (reason) { setMessage(safeFailure(reason)); }
    finally { pending.current = false; setBusy(false); feed.refresh(); }
  }
  async function cancel() {
    if (!selection || !machineId || pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    try {
      const result = EnrollmentControlResultSchema.parse(await action(host, "cancelEnrollment", { machineId, ...selection }));
      if (result.jobId !== selection.jobId) throw new Error("Mismatched enrollment");
      setMessage("Native cancellation requested. Waiting for the native job’s terminal state; acceptance is not proof that execution has stopped.");
    } catch (reason) { setMessage(safeFailure(reason)); }
    finally { pending.current = false; setBusy(false); feed.refresh(); }
  }
  return <Stack gap="0.75rem" className="plugin-atyrode_code_accounts__card">
    <h3>Fresh OAuth enrollment</h3>
    <p>Begin a new provider grant through a reviewed SDK flow on this accounts machine. No existing login files, terminal sessions, or credentials are imported.</p>
    <p role="status">{machineId === null ? "Unavailable: choose an accounts machine." : feed.value?.error ?? (data === null ? "Pending: reading native enrollment setup and visible jobs…" : data.availability === "unavailable" || !available ? "Unavailable: native resources or machine availability are incomplete. Review Code in native Plugins." : "Catalog-supported flows are listed below. Native admission still requires current authority and explicit operation consent.")}</p>
    <label htmlFor={`${id}-provider`}>Provider flow</label>
    <select id={`${id}-provider`} value={provider} disabled={busy} onChange={event => setProvider(event.target.value)}>
      <option value="">Choose a supported provider flow</option>
      {data?.providers.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · {entry.callback ? "authorization callback" : "device challenge"}</option>)}
    </select>
    <button type="button" disabled={!canStart} onClick={() => void start()}>Begin fresh OAuth enrollment</button>
    <label htmlFor={`${id}-job`}>Recover a visible native enrollment</label>
    <select id={`${id}-job`} value={selection?.jobId ?? ""} disabled={busy} onChange={event => {
      const run = data?.runs.find(run => run.jobId === event.target.value);
      setSelection(run ? { jobId: run.jobId, provider: run.provider } : null); setMessage(null);
    }}>
      <option value="">No enrollment selected</option>
      {selection && !data?.runs.some(run => run.jobId === selection.jobId) && <option value={selection.jobId}>{selection.provider} · {selection.jobId} (selected; visibility must be rechecked)</option>}
      {data?.runs.map(run => <option key={run.jobId} value={run.jobId}>{run.provider} · {run.state} · {run.jobId}</option>)}
    </select>
    <Cluster gap="0.5rem">
      <button type="button" disabled={!machineId} onClick={feed.refresh}>Read current enrollment</button>
      {cursor && <button type="button" onClick={() => setCursor(undefined)}>Newest native jobs</button>}
      {data?.nextCursor && <button type="button" onClick={() => setCursor(data.nextCursor ?? undefined)}>Older native jobs</button>}
      {selection && <button type="button" disabled={busy || !available || (enrollment !== null && !selectedActive)} onClick={() => void cancel()}>Cancel selected native enrollment</button>}
    </Cluster>
    {message && <p role="status">{message}</p>}
    {enrollment && <Stack gap="0.5rem" className="plugin-atyrode_code_accounts__enrollment" aria-live="polite">
      <p><strong>{enrollment.state === "pending" ? "Pending" : enrollment.state === "challenge" ? "Provider challenge" : enrollment.state === "complete" ? "Complete" : "Refused"}</strong> · <code>{enrollment.provider}</code> · native state {enrollment.job.state}</p>
      {enrollment.state === "pending" && <p>Waiting for a complete safe worker frame or verified native completion. No callback is currently available.</p>}
      {enrollment.auth && <>
        <p>{enrollment.auth.instructions}</p>
        {enrollment.auth.challenge && <p>One-time device challenge: <code className="plugin-atyrode_code_accounts__challenge">{enrollment.auth.challenge}</code></p>}
        <a className="plugin-atyrode_code_accounts__authorization" href={enrollment.auth.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open provider authorization page</a>
      </>}
      {enrollment.prompt && <CallbackForm key={`${enrollment.job.jobId}:${enrollment.prompt.promptId}:${enrollment.job.nextInputSeq}`} host={host} enrollment={enrollment} disabled={busy || !available} refresh={feed.refresh} report={setMessage} />}
      {enrollment.complete && <p>Fresh OAuth credential enrolled for <code>{enrollment.complete.provider}</code>{enrollment.complete.identity.email ? ` · ${enrollment.complete.identity.email}` : ""}. Native execution exited successfully. Explicitly read accounts to review the resulting public identities and choices.</p>}
      {enrollment.refusal && <p>Enrollment refused: <code>{enrollment.refusal}</code>. No successful enrollment is being claimed. Cancel an active job before explicitly starting another flow.</p>}
    </Stack>}
  </Stack>;
}
