import { describe, expect, test } from "bun:test";
import { ServiceInputSchema, type ServiceOperationPolicy, type ServicePolicy, type ServiceProxyOperationPolicy } from "@manifold/protocol";
import { buildCodeServices, buildSharedBrokerPolicy, type CodeServicesInput } from "../atyrode.code/service-policies.ts";
import { BROKER_OPERATION_ID, BROKER_SERVICE_ID } from "../atyrode.code/auth-contract.ts";
import { ACCOUNTS_PLUGIN_ID } from "../atyrode.code/contract.ts";

function configuration(): CodeServicesInput & { gateway: NonNullable<CodeServicesInput["gateway"]> } {
  return { classifier: { origin: "http://127.0.0.1:11434", model: "qwen3:8b" },
    gateway: { pluginId: "atyrode.code.gateway", operationId: "atyrode.code.gateway.serve", installationRevision: "install-7",
      artifactSha256: "a".repeat(64), resourceBindingDigest: "b".repeat(64), input: { accountPool: { input: "accountPool" } } } };
}
function service(id: string): ServicePolicy {
  if (id === BROKER_SERVICE_ID) return buildSharedBrokerPolicy({ scope: "instance", pluginId: ACCOUNTS_PLUGIN_ID,
    operationId: BROKER_OPERATION_ID, installationRevision: "broker-install-1",
    artifactSha256: "c".repeat(64), resourceBindingDigest: "d".repeat(64), input: {} });
  const value = buildCodeServices(configuration()).find(policy => policy.serviceId === id);
  if (!value) throw new Error(`Missing service ${id}`);
  return value;
}
function direct(policy: ServicePolicy, id: string): ServiceOperationPolicy {
  const operation = policy.operations[id];
  if (!operation || "kind" in operation) throw new Error(`Not a projected operation: ${id}`);
  return operation;
}
function proxy(policy: ServicePolicy, id: string): ServiceProxyOperationPolicy {
  const operation = policy.operations[id];
  if (!operation || !("kind" in operation)) throw new Error(`Not a proxy: ${id}`);
  return operation;
}
function projection(operation: ServiceOperationPolicy): string[] {
  if (operation.response.kind !== "projected-json") throw new Error("Full disclosure on a direct operation");
  return operation.response.fields.map(path => path.join("."));
}

describe("Code native service authority", () => {
  test("direct reads and controls never inherit gateway credential disclosure", () => {
    const broker = service(BROKER_SERVICE_ID);
    const readable = Object.entries(broker.operations).filter(([, operation]) => !("kind" in operation) && operation.readable).map(([id]) => id);
    const invocable = Object.entries(broker.operations).filter(([, operation]) => !("kind" in operation) && operation.invocable).map(([id]) => id);
    expect(readable.sort()).toEqual(["metadata", "usage"]);
    expect(invocable.sort()).toEqual(["clear-blocks", "disable"]);
    const metadata = direct(broker, "metadata");
    expect([metadata.method, metadata.path]).toEqual(["GET", "/v1/snapshot"]);
    // A parent credential/object projection would disclose tokens even without
    // a leaf named access/refresh/key; the allowed paths must be scalar leaves.
    expect(projection(metadata).filter(path => path.includes(".credential"))).toEqual([
      "credentials.*.credential.type", "credentials.*.credential.email",
    ]);
    expect(projection(metadata)).toContain("credentials.*.blocks.*.blockedUntilMs");
    expect(metadata.requestHeaders?.["omp-auth-broker-capabilities"]).toBe("codex-meter-block-scopes");
    const usage = direct(broker, "usage");
    expect([usage.method, usage.path]).toEqual(["GET", "/v1/usage"]);
    expect(projection(usage).filter(path => path.includes(".metadata"))).toEqual([
      "reports.*.metadata.accountId", "reports.*.metadata.email", "reports.*.metadata.orgId",
    ]);
    // Meter verdicts are public quota facts; the enclosing limit (including
    // provider notes or other payloads) must not become readable.
    expect(projection(usage).filter(path => path.startsWith("reports.*.limits"))).toEqual([
      "reports.*.limits.*.id", "reports.*.limits.*.status",
      "reports.*.limits.*.scope.provider", "reports.*.limits.*.scope.accountId",
      "reports.*.limits.*.scope.orgId", "reports.*.limits.*.scope.tier", "reports.*.limits.*.scope.windowId",
      "reports.*.limits.*.window.id", "reports.*.limits.*.window.resetsAt", "reports.*.limits.*.window.durationMs",
      "reports.*.limits.*.amount.unit", "reports.*.limits.*.amount.usedFraction",
      "reports.*.limits.*.amount.remainingFraction", "reports.*.limits.*.amount.used", "reports.*.limits.*.amount.limit",
    ]);
    expect(projection(usage).some(path => /(^|\.)(raw|notes|credential|error)(\.|$)/.test(path))).toBe(false);
    expect(projection(direct(broker, "clear-blocks"))).toEqual(["ok"]);
    expect(projection(direct(broker, "disable"))).toEqual(["ok"]);
  });

  test("gateway exposes only pinned SDK stream-path broker routes with bounded parameters", () => {
    const broker = service(BROKER_SERVICE_ID);
    const routes = Object.entries(broker.operations).filter(([, operation]) => "kind" in operation)
      .map(([id, operation]) => `${id} ${operation.method} ${operation.path}`).sort();
    expect(routes).toEqual([
      "gateway-block POST /v1/credential/{credentialId}/block",
      "gateway-clear-blocks DELETE /v1/credential/{credentialId}/blocks",
      "gateway-disable POST /v1/credential/{credentialId}/disable",
      "gateway-refresh POST /v1/credential/{credentialId}/refresh",
      "gateway-snapshot GET /v1/snapshot",
      "gateway-snapshot-stream GET /v1/snapshot/stream",
      "gateway-usage GET /v1/usage",
      "gateway-usage-observed POST /v1/usage/observed",
      "gateway-usage-stale POST /v1/usage/stale",
    ]);
    const snapshot = proxy(broker, "gateway-snapshot");
    expect(snapshot.query?.wait).toEqual({ type: "number", required: false, min: 0, max: 30_000, integer: true });
    expect(snapshot.requestHeaders?.["if-none-match"]).toEqual({ kind: "forward", required: false, maxBytes: 32 });
    expect(snapshot.response.headers).toContain("etag");
    for (const id of ["gateway-snapshot", "gateway-snapshot-stream"]) {
      expect(proxy(broker, id).requestHeaders?.["omp-auth-broker-capabilities"])
        .toEqual({ kind: "literal", value: "codex-meter-block-scopes" });
    }
    for (const id of ["gateway-block", "gateway-clear-blocks", "gateway-disable", "gateway-refresh"]) {
      expect(proxy(broker, id).pathParameters?.credentialId).toEqual({ format: "positive-integer", maxBytes: 16 });
    }
  });

  test("classifier fixes model and nonstreaming Ollama envelope rather than accepting transport controls", () => {
    const classify = direct(service("suggest"), "classify");
    expect([classify.method, classify.path]).toEqual(["POST", "/api/chat"]);
    expect(Object.keys(classify.input).sort()).toEqual(["prompt", "system"]);
    expect(classify.input.prompt).toEqual({ type: "string", required: true, maxBytes: 8192 });
    expect(classify.body).toContainEqual({ path: ["model"], value: { literal: "qwen3:8b" } });
    expect(classify.body).toContainEqual({ path: ["stream"], value: { literal: false } });
    expect(classify.body).toContainEqual({ path: ["messages", 1, "content"], value: { input: "prompt" } });
    expect(projection(classify).sort()).toEqual(["done", "message.content", "message.role", "model"]);
    expect(buildCodeServices({ ...configuration(), classifier: null }).some(policy => policy.serviceId === "suggest")).toBe(false);
    const omp = service("omp");
    expect([proxy(omp, "models").method, proxy(omp, "models").path]).toEqual(["GET", "/v1/models"]);
    expect([proxy(omp, "stream").method, proxy(omp, "stream").path]).toEqual(["POST", "/v1/pi/stream"]);
  });

  test("native configuration boundary refuses unsafe origins, secret values and unbounded input", () => {
    const config = configuration();
    expect(() => buildCodeServices({ ...config, classifier: { ...config.classifier!, origin: "https://user:secret@classifier.example" } })).toThrow();
    expect(() => buildCodeServices({ ...config, classifier: { ...config.classifier!, origin: "http://classifier.example" } })).toThrow();
    expect(() => buildCodeServices({ ...config, classifier: { ...config.classifier!, model: "m".repeat(513) } })).toThrow();
    expect(() => buildCodeServices({ ...config, gateway: { ...config.gateway, artifactSha256: "un-pinned" } })).toThrow();
    expect(() => buildCodeServices({ ...config, gateway: { ...config.gateway,
      input: { accountPool: { literal: "界".repeat(65_537) } } } })).toThrow();
    // The native scalar wire also refuses aggregate UTF-8 overflow before any
    // operation-specific prompt bound or upstream request can be evaluated.
    expect(ServiceInputSchema.safeParse({ system: "Size the task", prompt: "界".repeat(22_000) }).success).toBe(false);
  });
});
