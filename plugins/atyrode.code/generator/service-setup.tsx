import { useEffect, useRef, useState } from "react";
import type { HostServices } from "@manifold/plugin";
import { apiKeyProviders, GATEWAY_PLUGIN_ID, type ActionInput, type ActionResult, type Target } from "../contract.ts";
import { callCodeAction, codeOperationFailure, useCodeQuery } from "../machine-web.ts";

type Reviewed = { input: ActionInput<"reviewServices">; result: ActionResult<"reviewServices"> };
export function ServiceSetup({ host, target, onConfigured }: { host: HostServices; target: Target | null; onConfigured: () => void }) {
  const native = useCodeQuery(host, "readServiceConfiguration", target);
  const [source, setSource] = useState("");
  const [apiKeys, setApiKeys] = useState<ActionInput<"reviewServices">["apiKeys"]>([]);
  const [classifier, setClassifier] = useState(false);
  const [classifierOrigin, setClassifierOrigin] = useState("");
  const [classifierModel, setClassifierModel] = useState("");
  const [review, setReview] = useState<Reviewed | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [baseRevision, setBaseRevision] = useState<string | null | undefined>(undefined);
  const initialized = useRef(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!native.data || initialized.current) return;
    initialized.current = true;
    setBaseRevision(native.data.configuration.revision);
    const broker = native.data.configuration.policies.find(policy => policy.serviceId === "broker");
    setSource(broker?.origin && broker.credential ? JSON.stringify([broker.credential.ref, broker.origin]) : "");
    const mappings: ActionInput<"reviewServices">["apiKeys"] = [];
    for (const provider of apiKeyProviders) {
      const operation = broker?.operations[`enroll-key-${provider}`];
      if (!operation || !("body" in operation)) continue;
      const key = operation.body.find(field => JSON.stringify(field.path) === '["credential","key"]');
      if (key && "credentialRef" in key.value) mappings.push({ provider, credentialRef: key.value.credentialRef });
    }
    setApiKeys(mappings);
    setClassifier(false); setClassifierOrigin(""); setClassifierModel("");
    const suggestion = native.data.configuration.policies.find(policy => policy.serviceId === "suggest");
    const operation = suggestion?.operations.classify;
    const model = operation && "body" in operation ? operation.body.find(field => JSON.stringify(field.path) === '["model"]') : null;
    if (suggestion?.origin && model && "literal" in model.value && typeof model.value.literal === "string") {
      setClassifier(true); setClassifierOrigin(suggestion.origin); setClassifierModel(model.value.literal);
    }
  }, [native.data]);
  const sources = native.data?.credentialReferences.flatMap(reference => reference.origins.map(origin => ({
    key: JSON.stringify([reference.ref, origin]), credentialRef: reference.ref, origin, available: reference.available,
  }))) ?? [];
  const broker = sources.find(candidate => candidate.key === source);
  const keySources = native.data?.credentialReferences.filter(reference => reference.available && broker && reference.origins.includes(broker.origin)) ?? [];
  const keySourcesAvailable = apiKeys.every(mapping => keySources.some(reference => reference.ref === mapping.credentialRef));
  const editable = target !== null && host.authoring !== null;
  const stale = baseRevision !== undefined && native.data !== null && baseRevision !== native.data.configuration.revision;
  const current = review !== null && native.data !== null && target !== null &&
    review.input.containerId === target.containerId && review.input.machineId === target.machineId &&
    review.result.expectedServiceRevision === native.data.configuration.revision;
  const hasBroker = native.data?.configuration.policies.some(policy => policy.serviceId === "broker") ?? false;
  const hasRuntime = native.data?.configuration.policies.some(policy => policy.serviceId === "omp") ?? false;
  const gatewayReady = native.data?.runtimeCandidates.some(candidate => candidate.runtime.pluginId === GATEWAY_PLUGIN_ID && candidate.ready) ?? false;
  async function perform(work: () => Promise<void>) {
    if (pending.current || !editable) return;
    pending.current = true; setBusy(true); setStatus(null);
    try { await work(); }
    catch (reason) { if (mounted.current) setStatus(codeOperationFailure(reason)); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); native.refresh(); } }
  }
  function invalidate() { setReview(null); setStatus(null); }
  return <section className="plugin-atyrode_code_generator__service-setup" aria-label="Connect account service">
    {native.error && <p role="status" className="plugin-atyrode_code__warning">{native.error}</p>}
    {!native.data && !native.error && <p role="status">Reading machine setup…</p>}
    {native.data && !review && <>
      {stale && <p role="status" className="plugin-atyrode_code__warning">Machine setup changed. Your draft cannot replace it. <button type="button" disabled={busy} onClick={() => { initialized.current = false; invalidate(); native.refresh(); }}>Discard draft and read current setup</button></p>}
      {hasBroker && !gatewayReady && <div className="plugin-atyrode_code__notice">
        <p>The account service is connected. Next, approve Code Gateway in Manifold’s native setup.</p>
        <button type="button" className="plugin-atyrode_code__primary-action" onClick={() => host.navigate(`manifold://plugin/${GATEWAY_PLUGIN_ID}`)}>Open gateway setup</button>
        <button type="button" onClick={native.refresh}>check again</button>
      </div>}
      <p>{hasBroker ? gatewayReady ? "Review the gateway connection to finish runtime setup." : "Your account-service choices are kept below." : "Choose this machine’s account service. Credentials stay with its native owner."}</p>
      <fieldset disabled={!editable || busy}>
        <legend>account service</legend>
        <label>source<select value={source} onChange={event => { invalidate(); setSource(event.target.value); }}>
          <option value="">Choose an available source</option>
          {source && !broker && <option value={source} disabled>Previously selected source unavailable</option>}
          {sources.map(candidate => <option key={candidate.key} value={candidate.key} disabled={!candidate.available}>{candidate.credentialRef} · {candidate.origin}{candidate.available ? "" : " (unavailable)"}</option>)}
        </select></label>
        {sources.length === 0 && <p role="status">This machine has no credential source yet. Its owner must declare one in Manifold before continuing.</p>}
        <details className="plugin-atyrode_code__details"><summary>Optional connections{classifier || apiKeys.length ? " · configured" : ""}</summary>
          <label className="plugin-atyrode_code_generator__check"><input type="checkbox" checked={classifier} onChange={event => { invalidate(); setClassifier(event.target.checked); }} /> prompt-to-profile with Ollama</label>
          {classifier && <div className="plugin-atyrode_code_generator__fields">
            <label>Ollama origin<input type="url" value={classifierOrigin} placeholder="http://127.0.0.1:11434" maxLength={4096} onChange={event => { invalidate(); setClassifierOrigin(event.target.value); }} /></label>
            <label>model<input value={classifierModel} maxLength={256} onChange={event => { invalidate(); setClassifierModel(event.target.value); }} /></label>
          </div>}
          <details><summary>API-key enrollment sources{apiKeys.length ? ` · ${apiKeys.length}` : ""}</summary>
            <p>These references let Accounts enroll an API key through the broker. No key is pasted into Code.</p>
            {!broker && <p>Choose an account service first.</p>}
            <div className="plugin-atyrode_code_generator__fields">{apiKeyProviders.map(provider => {
              const selected = apiKeys.find(mapping => mapping.provider === provider)?.credentialRef ?? "";
              return <label key={provider}>{provider}<select value={selected} onChange={event => {
                invalidate(); const credentialRef = event.target.value;
                setApiKeys(previous => [...previous.filter(mapping => mapping.provider !== provider), ...(credentialRef ? [{ provider, credentialRef }] : [])]);
              }}>
                <option value="">not connected</option>
                {selected && !keySources.some(reference => reference.ref === selected) && <option value={selected} disabled>{selected} (unavailable)</option>}
                {keySources.map(reference => <option key={reference.ref} value={reference.ref}>{reference.ref}</option>)}
              </select></label>;
            })}</div>
            {!keySourcesAvailable && <p role="status">Remove or replace the unavailable key-source mapping before continuing.</p>}
          </details>
        </details>
        <button type="button" className="plugin-atyrode_code__primary-action" disabled={stale || baseRevision === undefined || !broker?.available || !keySourcesAvailable || (classifier && (!classifierOrigin || !classifierModel))} onClick={() => {
          if (!target || baseRevision === undefined || stale || !broker?.available || !keySourcesAvailable) return;
          const input: ActionInput<"reviewServices"> = { ...target, expectedServiceRevision: baseRevision,
            broker: { origin: broker.origin, credentialRef: broker.credentialRef }, apiKeys,
            classifier: classifier ? { origin: classifierOrigin, model: classifierModel } : null };
          void perform(async () => { const result = await callCodeAction(host, "reviewServices", input); if (mounted.current) setReview({ input, result }); });
        }}>{busy ? "Reviewing…" : "Review connection"}</button>
      </fieldset>
    </>}
    {review && <div className="plugin-atyrode_code_generator__connection-review">
      <h3>Confirm connection</h3>
      <dl className="plugin-atyrode_code_generator__setup-facts"><dt>account service</dt><dd>{review.input.broker.origin}</dd><dt>source</dt><dd>{review.input.broker.credentialRef}</dd><dt>runtime</dt><dd>{review.result.gateway.status === "ready" ? "Code Gateway" : "not connected yet"}</dd></dl>
      {review.result.gateway.status === "omitted" && <p className="plugin-atyrode_code__warning">{hasRuntime ? "This change removes the current OMP connection. " : ""}After connecting the account service, approve Code Gateway in native setup, then return to connect the runtime.</p>}
      {!current && <p role="status">Machine setup changed. Review the current connection again.</p>}
      <details className="plugin-atyrode_code__details"><summary>Exact service policies</summary><pre>{JSON.stringify(review.result.policies, null, 2)}</pre></details>
      <div className="plugin-atyrode_code__toolbar"><button type="button" className="plugin-atyrode_code__primary-action" disabled={!editable || busy || !current} onClick={() => {
        if (!current) return;
        void perform(async () => {
          await callCodeAction(host, "configureServices", { ...review.input, reviewDigest: review.result.reviewDigest });
          if (mounted.current) { initialized.current = false; setReview(null); onConfigured(); setStatus(review.result.gateway.status === "ready" ? "Runtime connection saved." : "Account service connected. Continue with gateway setup."); }
        });
      }}>{busy ? "Connecting…" : "Connect"}</button><button type="button" disabled={busy} onClick={() => setReview(null)}>back</button></div>
    </div>}
    {status && <p role="status">{status}</p>}
  </section>;
}
