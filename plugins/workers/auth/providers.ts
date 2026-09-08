import { authProviders } from "@oh-my-pi/pi-catalog/compat/auth";
import type { CompiledAuthProvider, CompiledDeviceCodeLogin, CompiledOAuthCodeLogin } from "@oh-my-pi/pi-catalog/compat/types";
import { EnrollmentRefusal } from "./control.ts";

export type SupportedFlow = CompiledOAuthCodeLogin | CompiledDeviceCodeLogin | { kind: "codex-device" };

/** One capability filter over pinned SDK policy, shared by picker and private worker. */
export function enrollmentFlow(policy: CompiledAuthProvider | undefined): SupportedFlow {
  if (!policy?.login) throw new EnrollmentRefusal("provider_unavailable");
  if (policy.result === "api-key" || policy.login.kind === "api-key") throw new EnrollmentRefusal("api_key_unsupported");
  const flow = policy.login;
  if (flow.kind === "custom") {
    // Reviewed fresh grant hook; the worker bounds its non-cooperative continuations.
    if (flow.hook === "openai-codex-device") return { kind: "codex-device" };
    throw new EnrollmentRefusal("flow_unsupported");
  }
  if (flow.afterExchange && !["anthropic-identity", "openai-codex-profile"].includes(flow.afterExchange)) throw new EnrollmentRefusal("flow_unsupported");
  if (flow.kind === "oauth-code" && (flow.callback.nativeScheme || flow.state === "none" || flow.pasteKey)) throw new EnrollmentRefusal("flow_unsupported");
  if (flow.kind === "device-code" && flow.headersHook) throw new EnrollmentRefusal("flow_unsupported");
  return flow;
}

/** Catalog support only: native setup and admission determine machine availability. */
export function enrollmentProviders() {
  return authProviders().flatMap(policy => {
    if (policy.available === false || policy.showInLoginList === false) return [];
    try {
      const flow = enrollmentFlow(policy);
      return [{ id: policy.id, name: policy.name, credentialProvider: policy.storeAs ?? policy.id,
        callback: flow.kind === "oauth-code" }];
    } catch { return []; }
  });
}
