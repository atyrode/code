import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore, REMOTE_REFRESH_SENTINEL, type OAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { parseCallbackInput } from "@oh-my-pi/pi-ai/oauth/callback-server";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import type { CompiledAuthProvider, CompiledDeviceCodeLogin, CompiledOAuthCodeLogin } from "@oh-my-pi/pi-catalog/compat/types";
import { setTransports } from "@oh-my-pi/pi-utils/logger";
import { EnrollmentControl, EnrollmentRefusal, type EnrollmentEvent } from "./control.ts";

// Public SDK logger is lazy. Disable both transports before invoking any flow;
// provider progress/errors are deliberately not diagnostic output for this worker.
setTransports({ file: false, console: false });

export type EnrollmentUpload = (input: Record<string, string | number | boolean>, signal: AbortSignal) => Promise<unknown>;
type SupportedFlow = CompiledOAuthCodeLogin | CompiledDeviceCodeLogin | { kind: "codex-device" };

/** Capability filtering over the SDK policy, not a second provider registry. */
export function enrollmentFlow(policy: CompiledAuthProvider | undefined): SupportedFlow {
  if (!policy?.login) throw new EnrollmentRefusal("provider_unavailable");
  if (policy.result === "api-key" || policy.login.kind === "api-key") throw new EnrollmentRefusal("api_key_unsupported");
  const flow = policy.login;
  if (flow.kind === "custom") {
    // This reviewed SDK hook creates a new grant, but ignores ctrl.fetch and only
    // checks abort between polls. The private worker exits on cancellation; it
    // never awaits late completion or uploads after the abort gate.
    if (flow.hook === "openai-codex-device") return { kind: "codex-device" };
    throw new EnrollmentRefusal("flow_unsupported");
  }
  // Other hooks can read/write host caches, acquire browser cookies, prompt for
  // secrets, or provision API keys. Admit only the reviewed token identity hooks.
  if (flow.afterExchange && !["anthropic-identity", "openai-codex-profile"].includes(flow.afterExchange)) {
    throw new EnrollmentRefusal("flow_unsupported");
  }
  if (flow.kind === "oauth-code" && (flow.callback.nativeScheme || flow.state === "none" || flow.pasteKey)) {
    throw new EnrollmentRefusal("flow_unsupported");
  }
  if (flow.kind === "device-code" && flow.headersHook) throw new EnrollmentRefusal("flow_unsupported");
  return flow;
}

/** Project static instructions or an explicitly bounded device challenge, never arbitrary SDK prose. */
export function authEvent(info: { url: string; instructions?: string }, flow: SupportedFlow): EnrollmentEvent {
  let url: URL;
  try { url = new URL(info.url); } catch { throw new EnrollmentRefusal("unsafe_auth_metadata"); }
  if (Buffer.byteLength(info.url) > 8192 || url.protocol !== "https:" || url.username || url.password || url.hash ||
    /[\u0000-\u0020\u007f]/.test(info.url)) throw new EnrollmentRefusal("unsafe_auth_metadata");
  if (flow.kind === "oauth-code") {
    const allowed = new Set(["client_id", "response_type", "redirect_uri", "scope", "code_challenge", "code_challenge_method", "state", ...Object.keys(flow.authorizeParams)]);
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || /access.token|refresh.token|client.secret|authorization|api.key|password/i.test(key)) throw new EnrollmentRefusal("unsafe_auth_metadata");
    }
    if (!url.searchParams.get("state")) throw new EnrollmentRefusal("flow_unsupported");
    return { type: "auth", url: info.url, instructions: "Complete authorization in the provider's browser page. If the callback cannot reach this machine, provide the callback including state through the private response prompt." };
  }
  for (const key of url.searchParams.keys()) {
    if (!["user_code", "code", "otc"].includes(key) || !/^[A-Za-z0-9-]{1,32}$/.test(url.searchParams.get(key) ?? "")) {
      throw new EnrollmentRefusal("unsafe_auth_metadata");
    }
  }
  const template = flow.kind === "codex-device" ? "Enter code: {user_code}" : flow.instructions;
  const marker = "{user_code}";
  const index = template.indexOf(marker);
  const instructions = info.instructions ?? "";
  if (index < 0 || template.indexOf(marker, index + marker.length) !== -1 || instructions.length > 2048) {
    throw new EnrollmentRefusal("unsafe_auth_metadata");
  }
  const prefix = template.slice(0, index);
  const suffix = template.slice(index + marker.length);
  if (!instructions.startsWith(prefix) || !instructions.endsWith(suffix)) throw new EnrollmentRefusal("unsafe_auth_metadata");
  const challenge = instructions.slice(prefix.length, instructions.length - suffix.length);
  if (!/^[A-Z0-9-]{4,32}$/.test(challenge)) throw new EnrollmentRefusal("unsafe_auth_metadata");
  return { type: "auth", url: info.url, challenge, instructions: "Open the provider page and enter this one-time device challenge." };
}

const optionalStrings = ["enterpriseUrl", "projectId", "email", "accountId", "apiEndpoint", "orgId", "orgName"] as const;
const knownCredentialFields: Record<string, true> = {
  type: true, access: true, refresh: true, expires: true, authorizedAt: true,
  enterpriseUrl: true, projectId: true, email: true, accountId: true,
  apiEndpoint: true, orgId: true, orgName: true,
};

/** Explicit scalar payload; never serializes unknown provider credential extensions. */
export function uploadFields(provider: string, credential: OAuthCredential): Record<string, string | number | boolean> {
  if (typeof credential.access !== "string" || !credential.access || Buffer.byteLength(credential.access) > 24576 ||
    typeof credential.refresh !== "string" || credential.refresh === REMOTE_REFRESH_SENTINEL || Buffer.byteLength(credential.refresh) > 24576 ||
    !Number.isFinite(credential.expires) || !Number.isFinite(credential.authorizedAt)) {
    throw new EnrollmentRefusal("credential_unsupported");
  }
  if (Object.keys(credential).some(key => !Object.hasOwn(knownCredentialFields, key))) throw new EnrollmentRefusal("credential_unsupported");
  const fields: Record<string, string | number | boolean> = {
    provider, access: credential.access, refresh: credential.refresh, expires: credential.expires, authorizedAt: credential.authorizedAt!,
  };
  for (const key of optionalStrings) {
    const value = credential[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || Buffer.byteLength(value) > 2048) throw new EnrollmentRefusal("credential_unsupported");
    fields[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(fields)) > 60 * 1024) throw new EnrollmentRefusal("credential_unsupported");
  return fields;
}

function safeIdentity(credential: OAuthCredential): Extract<EnrollmentEvent, { type: "complete" }>["identity"] {
  const identity: Extract<EnrollmentEvent, { type: "complete" }>["identity"] = { type: "oauth" };
  for (const key of ["email", "accountId", "orgId", "orgName"] as const) {
    const value = credential[key];
    if (typeof value !== "string" || !value || value.length > 512 || /[\u0000-\u001f\u007f]|Bearer\s|eyJ[A-Za-z0-9_-]+\./i.test(value)) continue;
    if (value.includes(credential.access) || (credential.refresh && value.includes(credential.refresh))) continue;
    identity[key] = value;
  }
  return identity;
}

async function untilAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  const stopped = Promise.withResolvers<never>();
  const onAbort = (): void => stopped.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try { return await Promise.race([pending, stopped.promise]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export async function enroll(control: EnrollmentControl, upload: EnrollmentUpload, fetchImpl?: FetchImpl): Promise<void> {
  let storage: AuthStorage | undefined;
  let store: SqliteAuthCredentialStore | undefined;
  let database: Database | undefined;
  let fields: Record<string, string | number | boolean> | undefined;
  try {
    const provider = await untilAbort(control.started.promise, control.signal);
    control.signal.throwIfAborted();
    const entry = getOAuthProviders().find(item => item.id === provider && item.available);
    if (!entry) throw new EnrollmentRefusal("provider_unavailable");
    const flow = enrollmentFlow(authPolicyFor(provider));
    // A constructor-supplied, private in-memory DB cannot open/import source auth.
    // Never call AuthStorage.create(), SqliteAuthCredentialStore.open(), reload
    // from a remote store, getApiKey(), or a broker snapshot in this process.
    database = new Database(":memory:");
    database.exec("PRAGMA temp_store = MEMORY; PRAGMA secure_delete = ON;");
    store = new SqliteAuthCredentialStore(database);
    storage = new AuthStorage(store);
    const identity = await untilAbort(storage.login(provider, {
      signal: control.signal,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      onAuth(info) { control.signal.throwIfAborted(); control.emit(authEvent(info, flow)); },
      onProgress() { /* Raw progress can contain token endpoint diagnostics. */ },
      onPrompt() { throw new EnrollmentRefusal("prompt_unsupported"); },
      async onManualCodeInput(signal) {
        const value = await control.requestCallback(signal);
        const parsed = parseCallbackInput(value);
        if (!parsed.code || !parsed.state || parsed.code.includes("#")) throw new EnrollmentRefusal("invalid_callback");
        // Pass the original supported form, not a reconstructed URL or substituted
        // state. The upstream flow compares against its private generated state.
        return value;
      },
    }), control.signal);
    control.signal.throwIfAborted();
    if (identity?.type !== "oauth") throw new EnrollmentRefusal("api_key_unsupported");
    const rows = store.listAuthCredentials();
    const row = rows[0];
    const storedProvider = entry.storeCredentialsAs ?? provider;
    if (rows.length !== 1 || !row || row.provider !== storedProvider || row.credential.type !== "oauth") {
      throw new EnrollmentRefusal("credential_unsupported");
    }
    fields = uploadFields(storedProvider, row.credential);
    control.signal.throwIfAborted();
    const result = await untilAbort(upload(fields, control.signal), control.signal);
    control.signal.throwIfAborted();
    // Exact safe projection of CredentialUploadResponse; no generation exists on
    // this upstream response. Never emit returned rows (which include peers).
    if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).some(key => key !== "entries")) throw new EnrollmentRefusal("upload_failed");
    const entries: unknown = Reflect.get(result, "entries");
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 1024 || !entries.every(value =>
      value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => ["id", "provider", "identityKey"].includes(key)) &&
      Number.isSafeInteger(value.id) && value.id > 0 && value.provider === storedProvider &&
      (value.identityKey === null || (typeof value.identityKey === "string" && value.identityKey.length <= 2048)))) {
      throw new EnrollmentRefusal("upload_failed");
    }
    control.emit({ type: "complete", provider: storedProvider, identity: safeIdentity(row.credential) });
  } catch (error) {
    const reason: unknown = control.signal.aborted ? control.signal.reason : error;
    control.emit({ type: "refused", code: reason instanceof EnrollmentRefusal ? reason.code : "enrollment_failed" });
  } finally {
    // Strings in JS cannot be reliably zeroized; drop references and terminate the
    // invocation process. The DB never had a filesystem backing or shared cache.
    if (fields) for (const key of Object.keys(fields)) delete fields[key];
    control.finish();
    if (storage) storage.close();
    else if (store) store.close();
    else database?.close();
  }
}
