import { z } from "zod";
import { ServicePolicySchema, ServiceRuntimeSchema, type ServiceOperationPolicy, type ServicePolicy,
  type ServiceProxyOperationPolicy, type ServiceRuntime } from "@manifold/protocol";
import { ApiKeySourcesSchema } from "./contract.ts";

export interface CodeServicesInput {
  broker: { origin: string; credentialRef: string };
  classifier: { origin: string; model: string } | null;
  gateway?: ServiceRuntime | null;
  apiKeys?: { provider: string; credentialRef: string }[];
}

const inputSchema = z.strictObject({
  broker: z.strictObject({ origin: z.string(), credentialRef: z.string() }),
  classifier: z.strictObject({ origin: z.string(), model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/:-]{0,511}$/) }).nullable(),
  gateway: ServiceRuntimeSchema.nullish(),
  apiKeys: ApiKeySourcesSchema.default([]),
});
const capabilities = { "omp-auth-broker-capabilities": "codex-meter-block-scopes" };
const stringInput = (maxBytes: number, required = true): ServiceOperationPolicy["input"][string] =>
  ({ type: "string", required, maxBytes });
const numberInput = (): ServiceOperationPolicy["input"][string] =>
  ({ type: "number", required: true, min: -Number.MAX_VALUE, max: Number.MAX_VALUE, integer: false });
function projected(method: ServiceOperationPolicy["method"], path: string, fields: string[][]): ServiceOperationPolicy {
  return { method, path, input: {}, query: {}, body: [], timeoutMs: 60_000,
    maxRequestBytes: 65_536, maxResponseBytes: 4 * 1024 * 1024, maxResultBytes: 96 * 1024,
    response: { kind: "projected-json", fields, maxArrayItems: 1024 } };
}
function proxy(method: ServiceProxyOperationPolicy["method"], path: string,
  request: ServiceProxyOperationPolicy["request"] = { kind: "none" }): ServiceProxyOperationPolicy {
  return { kind: "http-proxy", method, path, request,
    response: { kind: "stream", disclosure: "full", contentTypes: ["application/json"], headers: [] },
    timeoutMs: 60_000, maxRequestBytes: 65_536, maxResponseBytes: 4 * 1024 * 1024 };
}
function credentialProxy(method: ServiceProxyOperationPolicy["method"], suffix: string,
  request: ServiceProxyOperationPolicy["request"] = { kind: "none" }): ServiceProxyOperationPolicy {
  return { ...proxy(method, `/v1/credential/{credentialId}/${suffix}`, request),
    pathParameters: { credentialId: { format: "positive-integer", maxBytes: 16 } } };
}

/** Installer data only. Native schemas reject origins, credentials and mappings that
 * cannot be represented by the owner's service policy; there is no local policy store. */
export function buildCodeServices(input: CodeServicesInput): ServicePolicy[] {
  const configuration = inputSchema.parse(input);
  const metadata = projected("GET", "/v1/snapshot", [
    ["credentials", "*", "id"], ["credentials", "*", "provider"], ["credentials", "*", "identityKey"],
    ["credentials", "*", "credential", "type"], ["credentials", "*", "credential", "email"],
    ["credentials", "*", "blocks", "*", "blockScope"], ["credentials", "*", "blocks", "*", "blockedUntilMs"],
  ]);
  metadata.readable = true;
  metadata.requestHeaders = capabilities;
  // 18.1.14 /v1/usage has generatedAt and reports, not snapshot credentials or
  // health tombstones. Preserve identity/quota leaves consumed by normalizeBrokerUsage.
  const usage = projected("GET", "/v1/usage", [
    ["generatedAt"], ["reports", "*", "provider"], ["reports", "*", "fetchedAt"],
    ...["accountId", "email", "orgId"].map(key => ["reports", "*", "metadata", key]),
    ["reports", "*", "limits", "*", "id"],
    ...["provider", "accountId", "orgId", "tier", "windowId"].map(key => ["reports", "*", "limits", "*", "scope", key]),
    ...["id", "resetsAt", "durationMs"].map(key => ["reports", "*", "limits", "*", "window", key]),
    ...["unit", "usedFraction", "remainingFraction", "used", "limit"].map(key => ["reports", "*", "limits", "*", "amount", key]),
    ["reports", "*", "resetCredits", "availableCount"],
    ["reports", "*", "resetCredits", "credits", "*", "expiresAt"],
    ["reports", "*", "resetCredits", "credits", "*", "status"],
  ]);
  usage.readable = true;
  usage.timeoutMs = 300_000;
  const clearBlocks = projected("DELETE", "/v1/credential/{credentialId}/blocks", [["ok"]]);
  clearBlocks.input = { credentialId: stringInput(16) };
  clearBlocks.invocable = true;
  const disable = projected("POST", "/v1/credential/{credentialId}/disable", [["ok"]]);
  disable.input = { credentialId: stringInput(16) };
  disable.body = [{ path: ["cause"], value: { literal: "disabled by user" } }];
  disable.invocable = true;

  // Only the OAuth worker can bind this operation. Scalar mappings cannot upload
  // arbitrary credential extensions or turn this into the gateway's raw write path.
  const enroll = projected("POST", "/v1/credential", [
    ["entries", "*", "id"], ["entries", "*", "provider"], ["entries", "*", "identityKey"],
  ]);
  enroll.input = { provider: stringInput(128), access: stringInput(24_576), refresh: stringInput(24_576),
    expires: numberInput(), authorizedAt: numberInput() };
  enroll.body = [{ path: ["provider"], value: { input: "provider" } },
    { path: ["credential", "type"], value: { literal: "oauth" } },
    ...["access", "refresh", "expires", "authorizedAt"].map(key => ({ path: ["credential", key], value: { input: key } })),
  ];
  for (const key of ["enterpriseUrl", "projectId", "email", "accountId", "apiEndpoint", "orgId", "orgName"]) {
    enroll.input[key] = stringInput(2048, false);
    enroll.body.push({ path: ["credential", key], value: { input: key } });
  }
  const apiKeyOperations: Record<string, ServiceOperationPolicy> = Object.create(null);
  for (const source of configuration.apiKeys) {
    const operation = projected("POST", "/v1/credential", [
      ["entries", "*", "id"], ["entries", "*", "provider"], ["entries", "*", "identityKey"],
    ]);
    operation.body = [{ path: ["provider"], value: { literal: source.provider } },
      { path: ["credential", "type"], value: { literal: "api_key" } },
      { path: ["credential", "key"], value: { credentialRef: source.credentialRef } }];
    operation.invocable = true;
    apiKeyOperations[`enroll-key-${source.provider}`] = operation;
  }

  // These full-disclosure operations are deliberately distinct from direct reads
  // and mutations. Only the gateway's service binding admits their operation IDs.
  const snapshot = proxy("GET", "/v1/snapshot");
  snapshot.query = { wait: { type: "number", required: false, min: 0, max: 30_000, integer: true } };
  snapshot.requestHeaders = { "omp-auth-broker-capabilities": { kind: "literal", value: capabilities["omp-auth-broker-capabilities"] },
    "if-none-match": { kind: "forward", required: false, maxBytes: 32 } };
  snapshot.response.headers = ["etag"];
  const snapshotStream = proxy("GET", "/v1/snapshot/stream");
  snapshotStream.requestHeaders = { "omp-auth-broker-capabilities": { kind: "literal", value: capabilities["omp-auth-broker-capabilities"] } };
  snapshotStream.response.contentTypes = ["text/event-stream"];
  snapshotStream.timeoutMs = 300_000;
  snapshotStream.maxResponseBytes = 256 * 1024 * 1024;
  const gatewayUsage = proxy("GET", "/v1/usage");
  gatewayUsage.timeoutMs = 300_000;
  const json = { kind: "json", disclosure: "full" } as const;
  const broker = ServicePolicySchema.parse({ serviceId: "broker", revision: "1", origin: configuration.broker.origin,
    allowLoopbackHttp: true, credential: { ref: configuration.broker.credentialRef, header: "Authorization", prefix: "Bearer " },
    maxConcurrent: 16, operations: { metadata, usage, "clear-blocks": clearBlocks, disable, "enroll-oauth": enroll, ...apiKeyOperations,
      "gateway-snapshot": snapshot, "gateway-snapshot-stream": snapshotStream, "gateway-usage": gatewayUsage,
      "gateway-refresh": credentialProxy("POST", "refresh"), "gateway-disable": credentialProxy("POST", "disable", json),
      "gateway-block": credentialProxy("POST", "block", json), "gateway-clear-blocks": credentialProxy("DELETE", "blocks"),
      "gateway-usage-stale": proxy("POST", "/v1/usage/stale"), "gateway-usage-observed": proxy("POST", "/v1/usage/observed", json),
    } });
  const policies = [broker];
  if (configuration.classifier) {
    const classify = projected("POST", "/api/chat", [["message", "role"], ["message", "content"], ["done"], ["model"]]);
    // buildSuggestionRequest truncates task text to 600 code points, then JSON
    // encodes it. These UTF-8 bounds include its fixed instructions and escaping.
    classify.input = { system: stringInput(2048), prompt: stringInput(8192) };
    classify.body = [{ path: ["model"], value: { literal: configuration.classifier.model } },
      { path: ["stream"], value: { literal: false } },
      { path: ["messages", 0, "role"], value: { literal: "system" } },
      { path: ["messages", 0, "content"], value: { input: "system" } },
      { path: ["messages", 1, "role"], value: { literal: "user" } },
      { path: ["messages", 1, "content"], value: { input: "prompt" } }];
    classify.invocable = true;
    classify.timeoutMs = 300_000;
    classify.maxRequestBytes = 32 * 1024;
    classify.maxResponseBytes = 96 * 1024;
    policies.push(ServicePolicySchema.parse({ serviceId: "suggest", revision: "1", origin: configuration.classifier.origin,
      allowLoopbackHttp: true, maxConcurrent: 4, operations: { classify } }));
  }
  if (!configuration.gateway) return policies;
  const models = proxy("GET", "/v1/models");
  const stream = proxy("POST", "/v1/pi/stream", json);
  stream.response.contentTypes = ["application/json", "text/event-stream"];
  stream.timeoutMs = 300_000;
  stream.maxRequestBytes = 16 * 1024 * 1024;
  stream.maxResponseBytes = 256 * 1024 * 1024;
  policies.push(ServicePolicySchema.parse({ serviceId: "omp", revision: "1", runtime: configuration.gateway,
    maxConcurrent: 16, operations: { models, stream } }));
  return policies;
}
