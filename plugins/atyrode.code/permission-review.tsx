import { useEffect, useId, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { JobDeploymentApplyArgsSchema, JobDeploymentListArgsSchema, JobDeploymentListResultSchema,
  JobDeploymentReadArgsSchema, JobDeploymentRequestSchema, JobDeploymentReviewSchema, JobDeploymentSchema,
  canonicalJobJson, type JobDeployment, type JobDeploymentReview } from "@manifold/protocol";
import type { z } from "zod";
import type { ActionInput, ActionResult, PermissionFeatureId, Target } from "./contract.ts";
import { observePermissionPlan } from "./contract.ts";
import { ACCOUNT_REFRESH_MS, callCodeAction, canWriteCodeWorkspace, codeOperationFailure } from "./machine-web.ts";

const nativeActions = {
  reviewDeployment: { input: JobDeploymentRequestSchema, result: JobDeploymentReviewSchema },
  applyDeployment: { input: JobDeploymentApplyArgsSchema, result: JobDeploymentSchema },
  readDeployment: { input: JobDeploymentReadArgsSchema, result: JobDeploymentSchema },
  listDeployments: { input: JobDeploymentListArgsSchema, result: JobDeploymentListResultSchema },
} as const;
class NativeReviewError extends Error {}
async function nativeAction<K extends keyof typeof nativeActions>(host: HostServices, action: K,
  input: z.infer<(typeof nativeActions)[K]["input"]>): Promise<z.infer<(typeof nativeActions)[K]["result"]>> {
  const outcome = await host.client.action(`engine.jobs.${action}`, nativeActions[action].input.parse(input));
  if (!outcome.ok) throw new NativeReviewError(`Native ${action} refused: ${outcome.denial.message}. No approval or readiness is assumed.`);
  const result = nativeActions[action].result.safeParse(outcome.result);
  if (!result.success) throw new NativeReviewError(`Native ${action} returned an unsupported result. Update the published native API before continuing.`);
  return result.data as z.infer<(typeof nativeActions)[K]["result"]>;
}

type Plan = ActionResult<"readPermissionPlan">;

type ConfigurationReview =
  | { kind: "initialize"; input: ActionInput<"initializeConfiguration">; legacy: ActionResult<"readConfiguration">["configuration"] }
  | { kind: "account-runtime"; input: ActionInput<"reviewAccountRuntime">; result: ActionResult<"reviewAccountRuntime"> }
  | { kind: "connection"; input: ActionInput<"reviewServices">; result: ActionResult<"reviewServices"> }
  | { kind: "resources"; input: ActionInput<"reviewResources">; result: ActionResult<"reviewResources"> };
type Flow = {
  plan: Plan; index: number; phase: "review" | "progress" | "configuration" | "checking" | "ready";
  review: JobDeploymentReview | null; deployment: JobDeployment | null;
  configuration: ConfigurationReview | null; receipts: JobDeployment[];
};
type PermissionReviewProps = {
  host: HostServices; target?: Target | null; intent: PermissionFeatureId | "setup";
  label: string; onReady?: () => void; initiallyOpen?: boolean;
};

/** This component keeps only choices, exact reviews and native receipts. Closing
 * it never cancels native approval, revokes consent or discards the feature draft. */
export function PermissionReview({ initiallyOpen = false, ...props }: PermissionReviewProps) {
  const [open, setOpen] = useState(initiallyOpen);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) trigger.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);
  const scope = JSON.stringify([props.host.principal.id, props.host.containerId, props.target?.machineId ?? null]);
  const previousScope = useRef(scope);
  useEffect(() => {
    if (previousScope.current !== scope) { previousScope.current = scope; setOpen(false); }
  }, [scope]);
  return <>
    <button ref={trigger} type="button" disabled={!props.host.containerId} onClick={() => setOpen(true)}>{props.label}</button>
    {open && props.host.containerId && <PermissionDialog key={scope} {...props} containerId={props.host.containerId}
      onClose={() => setOpen(false)} />}
  </>;
}

function PermissionDialog({ host, target, intent, onReady, onClose, containerId }: PermissionReviewProps & { containerId: string; onClose: () => void }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [choices, setChoices] = useState<PermissionFeatureId[] | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planKey, setPlanKey] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const active = useRef(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const currentHost = useRef(host);
  currentHost.current = host;
  const authority = useRef({ client: host.client, authoring: host.authoring });
  useEffect(() => {
    if (authority.current.client === host.client && authority.current.authoring === host.authoring) return;
    authority.current = { client: host.client, authoring: host.authoring };
    generation.current += 1;
    pending.current = false;
    setBusy(false); setFlow(null); setRequestId(crypto.randomUUID());
    setMessage("Workspace authority changed. Review the current scope again; stored native approval was not cancelled.");
  }, [host.client, host.authoring]);
  const input: ActionInput<"readPermissionPlan"> = { containerId, machineId: target?.machineId ?? null, intent, choices, requestId };
  const inputKey = JSON.stringify(input);
  const latestInput = useRef(inputKey);
  latestInput.current = inputKey;
  const writable = canWriteCodeWorkspace(host);
  useEffect(() => {
    active.current = true;
    dialog.current?.showModal();
    return () => { active.current = false; generation.current += 1; dialog.current?.close(); };
  }, []);
  useEffect(() => { if (flow) heading.current?.focus({ preventScroll: true }); }, [flow?.phase, flow?.index]);
  useEffect(() => {
    let cancelled = false;
    setPlanKey(null);
    void observePermissionPlan((name, args) => callCodeAction(host, name, args), JSON.parse(inputKey) as ActionInput<"readPermissionPlan">).then(value => {
      if (!cancelled) {
        // Freeze the displayed suggestions as draft choices. Later readiness
        // changes cannot silently alter the request the user is reviewing.
        if (choices === null) setChoices(value.features.filter(feature => feature.selected).map(feature => feature.id));
        else { setPlan(value); setPlanKey(inputKey); }
      }
    }).catch(reason => { if (!cancelled) setMessage(codeOperationFailure(reason)); });
    return () => { cancelled = true; };
  }, [host.client, host.principal.id, inputKey]);

  async function perform(work: (valid: () => boolean) => Promise<void>) {
    if (pending.current || !active.current) return;
    const issued = ++generation.current;
    const valid = () => active.current && issued === generation.current && latestInput.current === inputKey &&
      currentHost.current.client === host.client && currentHost.current.principal.id === host.principal.id &&
      currentHost.current.authoring === host.authoring && currentHost.current.containerId === containerId;
    pending.current = true; setBusy(true); setMessage(null);
    try { await work(valid); }
    catch (reason) { if (valid()) setMessage(reason instanceof NativeReviewError ? reason.message : codeOperationFailure(reason)); }
    finally { if (issued === generation.current) pending.current = false; if (valid()) setBusy(false); }
  }
  async function requireCurrent(scope: Plan, valid: () => boolean) {
    const latest = await observePermissionPlan((name, args) => callCodeAction(host, name, args), input);
    if (!valid()) return null;
    setPlan(latest);
    if (latest.blockers.length > 0) throw new NativeReviewError(latest.blockers.join(" "));
    if (latest.scopeDigest !== scope.scopeDigest) throw new NativeReviewError("The destination or requested scope changed. Review the current choices again; any stored native approval remains visible in native progress.");
    return latest;
  }
  function restart() { setFlow(null); setMessage(null); setRequestId(crypto.randomUUID()); }
  function changeChoice(feature: PermissionFeatureId, selected: boolean) {
    const previous = choices ?? plan?.features.filter(row => row.selected).map(row => row.id) ?? [];
    setChoices(selected ? [...previous.filter(id => id !== feature), feature] : previous.filter(id => id !== feature));
    setMessage(null);
  }
  async function nextGroup(state: Flow, valid: () => boolean, continueToFeature = false): Promise<void> {
    const latest = await requireCurrent(state.plan, valid);
    if (!latest) return;
    state = { ...state, plan: latest };
    const step = latest.steps[state.index];
    if (!step) {
      // Re-read every native receipt; a completed earlier step is not a grant
      // cache, and installation acceptance is not owner acknowledgement.
      for (const receipt of state.receipts) {
        const current = await nativeAction(host, "readDeployment", { deploymentId: receipt.deploymentId });
        if (!valid()) return;
        if (current.targets.some(target => target.state !== "ready")) throw new NativeReviewError("A reviewed native destination is no longer ready. Reconsider its current review before continuing.");
      }
      for (const step of latest.steps) {
        if (step.nativeReady !== true) throw new NativeReviewError("Native readiness changed. Review the current destination before continuing.");
        if (step.configuration === "account-runtime") {
          const setup = await callCodeAction(host, "readAccountSetup", {});
          if (!valid()) return;
          if (!setup.nativeReady || !setup.canSignIn || setup.canUpdateRuntime || setup.state !== "ready" || setup.owner?.machineId !== step.request.targets[0]?.machineId)
            throw new NativeReviewError(setup.callerRefusal ?? setup.reason ?? "The shared account runtime is not ready.");
        } else if (!step.configurationCurrent) throw new NativeReviewError("Code configuration changed. Re-review its resources or model connection before continuing.");
      }
      setFlow({ ...state, phase: "ready", review: null, deployment: null, configuration: null });
      if (continueToFeature && valid()) { onReady?.(); onClose(); }
      return;
    }
    if (step.nativeReady) {
      if (step.configurationCurrent) await finishGroup(state, valid);
      else await reviewConfiguration(state, valid);
      return;
    }
    const history = await nativeAction(host, "listDeployments", { pluginId: step.request.pluginId, limit: 100 });
    if (!valid()) return;
    const retained = history.deployments.find(deployment => !deployment.cancelled &&
      JSON.stringify(deployment.review.request.targets) === JSON.stringify(step.request.targets) &&
      [...deployment.review.request.operationIds].sort().join("\n") === [...step.request.operationIds].sort().join("\n") &&
      deployment.targets.every(target => ["pending", "installing", "ready"].includes(target.state)));
    if (retained) {
      const next = { ...state, phase: "progress" as const, deployment: retained, review: retained.review, configuration: null };
      setFlow(next);
      if (retained.targets.every(target => target.state === "ready")) await reviewConfiguration(next, valid);
      return;
    }
    const review = await nativeAction(host, "reviewDeployment", step.request);
    if (canonicalJobJson(review.request) !== canonicalJobJson(step.request))
      throw new NativeReviewError("Native review returned a different request scope. Nothing was approved; review the current destination again.");
    if (valid()) setFlow({ ...state, phase: "review", review, deployment: null, configuration: null });
  }
  async function finishGroup(state: Flow, valid: () => boolean) {
    if (!valid()) return;
    await nextGroup({ ...state, index: state.index + 1, receipts: state.deployment ? [...state.receipts, state.deployment] : state.receipts,
      review: null, deployment: null, configuration: null }, valid);
  }
  async function reviewConfiguration(state: Flow, valid: () => boolean): Promise<void> {
    const latest = await requireCurrent(state.plan, valid);
    if (!latest) return;
    state = { ...state, plan: latest };
    const step = latest.steps[state.index]!;
    if (step.nativeReady && step.configurationCurrent) { await finishGroup(state, valid); return; }
    if (step.configuration === "account-runtime") {
      const setup = await callCodeAction(host, "readAccountSetup", {});
      if (!valid()) return;
      if (setup.owner?.machineId !== step.request.targets[0]?.machineId) throw new NativeReviewError("The shared account owner changed. No other destination was used; review again.");
      if (setup.callerRefusal) throw new NativeReviewError(setup.callerRefusal);
      if (setup.nativeReady && setup.canSignIn && setup.state === "ready" && !setup.canUpdateRuntime) { await finishGroup(state, valid); return; }
      const reviewInput = { expectedBrokerRevision: setup.revision };
      const result = await callCodeAction(host, "reviewAccountRuntime", reviewInput);
      if (!valid()) return;
      if (result.current) {
        setMessage(setup.reason ?? "The reviewed shared broker is starting. Waiting for genuine account runtime readiness.");
        setFlow({ ...state, phase: "checking", configuration: null });
      } else setFlow({ ...state, phase: "configuration", configuration: { kind: "account-runtime", input: reviewInput, result } });
      return;
    }
    if (!target) throw new NativeReviewError("Select a workspace machine before configuring this capability.");
    if (step.configuration === "connection") {
      const current = await callCodeAction(host, "readServiceConfiguration", target);
      if (!valid()) return;
      const reviewInput = { ...target, expectedServiceRevision: current.configuration.revision };
      const result = await callCodeAction(host, "reviewServices", reviewInput);
      if (!valid()) return;
      if (!result.current) { setFlow({ ...state, phase: "configuration", configuration: { kind: "connection", input: reviewInput, result } }); return; }
      const observed = await requireCurrent(state.plan, valid);
      if (!observed) return;
      if (!observed.steps[state.index]?.configurationCurrent) {
        setMessage("The reviewed model connection is not ready. Waiting for native service readiness; no policy is reapplied.");
        setFlow({ ...state, phase: "checking", configuration: null }); return;
      }
      await finishGroup(state, valid); return;
    }
    const current = await callCodeAction(host, "readConfiguration", { containerId, legacyMachineId: target.machineId });
    if (!valid()) return;
    if (!current.configuration || current.legacyMachineId !== null) {
      setFlow({ ...state, phase: "configuration", configuration: { kind: "initialize", input: {
        containerId, expectedRevision: current.revision, ...(current.legacyMachineId ? { legacyMachineId: current.legacyMachineId } : {}),
      }, legacy: current.configuration } });
      return;
    }
    const reviewInput = { ...target, expectedRevision: current.revision };
    // Explicitly re-read setup after native acknowledgement, then review Code's
    // pinned configuration through its normal public CAS-backed API.
    const setup = await callCodeAction(host, "readSetup", target);
    if (!valid()) return;
    if (!setup.connected || !setup.execution?.installation?.ready) throw new NativeReviewError("Native runtime readiness changed. Refresh its current review before promoting Code resources.");
    const result = await callCodeAction(host, "reviewResources", reviewInput);
    if (!valid()) return;
    if (result.current) await finishGroup(state, valid);
    else setFlow({ ...state, phase: "configuration", configuration: { kind: "resources", input: reviewInput, result } });
  }
  async function approveNative() {
    if (!flow?.review || !flow.review.approvable || !writable) return;
    const state = flow;
    await perform(async valid => {
      if (!await requireCurrent(state.plan, valid)) return;
      const deployment = await nativeAction(host, "applyDeployment", { request: state.review!.request, reviewDigest: state.review!.reviewDigest });
      if (!valid()) return;
      const next = { ...state, phase: "progress" as const, deployment };
      setFlow(next);
      if (deployment.targets.every(target => target.state === "ready")) await reviewConfiguration(next, valid);
    });
  }
  async function applyConfiguration() {
    if (!flow?.configuration || !writable) return;
    const state = flow;
    const reviewed = state.configuration!;
    await perform(async valid => {
      if (!await requireCurrent(state.plan, valid)) return;
      // All mutations retain their original native/product revision and digest
      // checks. A changed UI selection is never a write or an approval.
      if (reviewed.kind === "initialize") await callCodeAction(host, "initializeConfiguration", reviewed.input);
      else if (reviewed.kind === "account-runtime") await callCodeAction(host, "promoteAccountRuntime", { ...reviewed.input, containerId, reviewDigest: reviewed.result.reviewDigest });
      else if (reviewed.kind === "connection") await callCodeAction(host, "configureServices", { ...reviewed.input, reviewDigest: reviewed.result.reviewDigest });
      else await callCodeAction(host, "promoteResources", { ...reviewed.input, reviewDigest: reviewed.result.reviewDigest });
      if (valid()) await reviewConfiguration({ ...state, configuration: null }, valid);
    });
  }
  useEffect(() => {
    if (!flow || !["progress", "checking"].includes(flow.phase) ||
      flow.deployment?.targets.some(target => !["pending", "installing", "ready"].includes(target.state)) || message && flow.phase === "progress") return;
    const timer = setTimeout(() => void perform(async valid => {
      if (!await requireCurrent(flow.plan, valid)) return;
      if (!flow.deployment) { await reviewConfiguration(flow, valid); return; }
      const deployment = await nativeAction(host, "readDeployment", { deploymentId: flow.deployment.deploymentId });
      if (!valid()) return;
      const next = { ...flow, deployment };
      setFlow(next);
      if (deployment.targets.every(target => target.state === "ready")) await reviewConfiguration(next, valid);
    }), ACCOUNT_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [flow, message, inputKey]);

  const shownPlan = flow?.plan ?? plan;
  const step = flow && flow.plan.steps[flow.index];
  const configuration = flow?.configuration;
  return <dialog ref={dialog} className="plugin-atyrode_code plugin-atyrode_code__permission-dialog" aria-labelledby={`${id}-title`} aria-busy={busy}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="plugin-atyrode_code__section-heading"><h2 ref={heading} tabIndex={-1} id={`${id}-title`}>Review Code capabilities</h2><button type="button" onClick={onClose} aria-label="Close permission review">Close</button></header>
    <p>Choices are requests, not grants. Native rights review and Code configuration promotion are separate approvals. Not now and closing this dialog never revoke existing access.</p>
    {!shownPlan && <p role="status">{message ?? "Reading the headless permission plan…"}</p>}
    {shownPlan?.ownerApprovalRequired && <p role="status" className="plugin-atyrode_code__notice">The native instance owner must approve these exact requests. Your current identity cannot approve installations or impersonate the owner. Share the typed requests below with the owner, then refresh here.</p>}
    {!flow && plan && <>
      <fieldset disabled={busy}><legend>Choose independently what to review</legend><div className="plugin-atyrode_code__permission-choices">
        {plan.features.map(feature => <section key={feature.id} data-code-capability={feature.id} className="plugin-atyrode_code__permission-choice">
          <label><input type="checkbox" checked={choices?.includes(feature.id) ?? feature.selected} onChange={event => changeChoice(feature.id, event.target.checked)} />{feature.title}</label>
          <p>{feature.effect}</p><p className="plugin-atyrode_code__muted">Not now: {feature.deferredEffect}</p>
          <p>Destination: {feature.destination?.label ?? "not available"}{feature.destination && ` · ${feature.destination.machineId}`}</p>
          {feature.prerequisites.length > 0 && <p className="plugin-atyrode_code__muted">Prerequisites (already prepared access is kept): {feature.prerequisites.map(id => plan.features.find(row => row.id === id)?.title).join(", ")}. Unselected prerequisites are not approved by this request.</p>}
          <button type="button" aria-pressed={!(choices?.includes(feature.id) ?? feature.selected)} onClick={() => changeChoice(feature.id, false)}>Not now</button>
        </section>)}
      </div></fieldset>
      {plan.blockers.map(reason => <p key={reason} role="status">{reason}</p>)}
      <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || planKey !== inputKey || plan.steps.length === 0 || plan.blockers.length > 0} onClick={() => void perform(valid => nextGroup({ plan, index: 0, phase: "review", review: null, deployment: null, configuration: null, receipts: [] }, valid))}>Review selected requests</button><button type="button" onClick={onClose}>Not now — keep existing access</button></div>
    </>}
    {step && <p>Request {flow!.index + 1} of {flow!.plan.steps.length} · {step.featureIds.map(id => flow!.plan.features.find(feature => feature.id === id)?.title).join(" + ")}</p>}
    {flow?.phase === "review" && flow.review && <section aria-label="Exact native rights review">
      <h3>Native rights approval</h3><p>Review the actual native scope, including shared resources and every requested capability. Existing approvals are identified; this flow never submits a revocation. Replacing software or resource bindings can require renewed review of other operations.</p>
      <p>Declaration SHA-256: <code>{flow.review.declarationSha256}</code></p>
      <details className="plugin-atyrode_code__details"><summary>Exact native declaration</summary><pre>{JSON.stringify(flow.review.machine, null, 2)}</pre></details>
      {flow.review.targets.map(target => <section key={target.machineId}>
        <h4>{target.machineName} · {target.machineId}</h4><p>{target.connected ? "online" : "offline"} · {target.platform ?? "unsupported or unknown platform"}</p>
        <p>Artifact: <code>{target.artifactSha256 ?? "unavailable"}</code></p>
        {target.reason && <p role="status">{target.reason}</p>}
        <ul>{target.consents.map(consent => <li key={`${consent.node}/${consent.cap}`}><code>{consent.cap}</code> · <code>{consent.node}</code> · {consent.approved ? "already approved" : "requires approval"}</li>)}</ul>
        <details className="plugin-atyrode_code__details"><summary>Exact artifact, resources and binding revisions</summary><pre>{JSON.stringify(target, null, 2)}</pre></details>
      </section>)}
      {!flow.review.approvable && <p role="status">This declaration or destination is not approvable. Resolve the native reason and review again; no fallback destination or permission is substituted.</p>}
      <button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable || shownPlan?.ownerApprovalRequired || !flow.review.approvable} onClick={() => void approveNative()}>Approve exact native scope</button>
      <details className="plugin-atyrode_code__details"><summary>Published native apply request</summary><pre>{JSON.stringify({ request: flow.review.request, reviewDigest: flow.review.reviewDigest }, null, 2)}</pre></details>
    </section>}
    {flow?.deployment && <section aria-label="Native deployment progress"><h3>Native progress</h3><p>Approval is stored by Manifold. Ready requires acknowledgement from the actual native owner, not a successful submit.</p>
      <ul>{flow.deployment.targets.map(target => <li key={target.machineId}>{target.machineId} · {target.state}{target.reason && ` · ${target.reason}`}{!target.connected && " · offline"}</li>)}</ul>
    </section>}
    {configuration && <section aria-label="Code configuration review"><h3>{configuration.kind === "initialize" ? configuration.legacy ? "Adopt the selected legacy workspace" : "Create the workspace profile" : "Separate Code configuration promotion"}</h3>
      <p>{configuration.kind === "initialize" ? configuration.legacy ? "Adopt these exact legacy choices for the whole container. Only the explicitly selected machine’s record is used; its original remains read-only recovery data. This does not grant native access." : "Save this workspace’s profile. This does not grant native access or change a catalog." : configuration.kind === "account-runtime" ? "Use this exact shared account runtime policy on its declared owner. This affects the instance; credential custody and existing client access remain unchanged." : configuration.kind === "connection" ? "Connect this machine to the reviewed gateway. Other service policies and the broker stay unchanged." : "Use the current native resource revisions for this execution destination. Your catalog, account choices, drafts and other destinations’ pins are not replaced."}</p>
      <details open className="plugin-atyrode_code__details"><summary>Exact configuration and revision</summary><pre>{JSON.stringify(configuration, null, 2)}</pre></details>
      <button type="button" className="plugin-atyrode_code__primary-action" disabled={busy || !writable} onClick={() => void applyConfiguration()}>{configuration.kind === "initialize" ? configuration.legacy ? "Adopt reviewed workspace choices" : "Create workspace profile" : "Apply reviewed Code configuration"}</button>
    </section>}
    {flow?.phase === "ready" && <section aria-label="Capability readiness"><h3>Reviewed capabilities are ready</h3><p>The native destinations acknowledged readiness and Code’s configuration was re-read. Continue with your existing draft; discovery, folder preparation, paid benchmarks and session launch remain separate actions.</p>
      <button type="button" className="plugin-atyrode_code__primary-action" disabled={busy} onClick={() => void perform(valid => nextGroup(flow, valid, true))}>Continue to feature</button>
    </section>}
    {shownPlan && (flow || planKey === inputKey) && <details className="plugin-atyrode_code__details" aria-label="Typed headless permission plan"><summary>Typed headless permission plan</summary><pre>{JSON.stringify({ door: "atyrode.code.readPermissionPlan", input, result: shownPlan }, null, 2)}</pre></details>}
    {!flow && plan && planKey !== inputKey && <p role="status">Updating the exact request for your choices…</p>}
    {flow && <button type="button" disabled={busy} onClick={restart}>Reconsider choices / review current scope</button>}
    {message && <p role="status" className="plugin-atyrode_code__warning">{message}</p>}
    {busy && <p role="status">Reading or applying the exact reviewed request…</p>}
  </dialog>;
}
