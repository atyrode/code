import { expect, test } from "bun:test";
import { ProbeConfigSchema, ProbeModelsConfigSchema, isolateProbeEnvironment } from "./inputs.ts";

const provider = { baseUrl: "http://127.0.0.1:42123", apiKey: "scoped-native-service-bearer-00000001", transport: "pi-native", discovery: { type: "proxy" } };
test("native target config rejects execution and external credential endpoints", () => {
  for (const change of [
    { baseUrl: "https://api.example.test" }, { baseUrl: "http://localhost:42123" }, { baseUrl: "http://127.0.0.1:65536" },
    { apiKey: "!cat /host/secret" }, { apiKey: "ENV_KEY" }, { headers: { authorization: "secret" } },
    { transport: "openai-responses" }, { discovery: { type: "ollama" } }, { models: [{ id: "arbitrary" }] },
  ]) {
    expect(ProbeModelsConfigSchema.safeParse({ providers: { anthropic: { ...provider, ...change } } }).success).toBe(false);
  }
  expect(ProbeModelsConfigSchema.safeParse({ providers: { anthropic: provider } }).success).toBe(true);
});
test("source settings cannot load extensions, broker credentials or retry/fallback policy", () => {
  const config = { extensions: [], disabledProviders: ["ollama", "lm-studio", "llama.cpp"], extendedContext: false };
  for (const change of [{ extensions: ["/host/plugin.ts"] }, { auth: { broker: { url: "http://127.0.0.1:42123" } } }, { retry: { modelFallback: true } }, { cwd: "/host" }]) {
    expect(ProbeConfigSchema.safeParse({ ...config, ...change }).success).toBe(false);
  }
  expect(ProbeConfigSchema.safeParse(config).success).toBe(true);
});
test("ambient authority is removed rather than forwarded to OMP", () => {
  const environment = { HOME: "/host", PATH: "/host/bin", MANIFOLD_JOB_CONTEXT_FD: "9", OPENAI_API_KEY: "host-secret", OMP_AUTH_BROKER_TOKEN: "broker-secret", BUN_OPTIONS: "--preload /host/evil.ts", NODE_OPTIONS: "--require /host/evil.cjs", HTTPS_PROXY: "http://external", PI_REQ_DEBUG: "1" };
  isolateProbeEnvironment(environment);
  expect(JSON.stringify(environment)).not.toContain("host-secret");
  expect(JSON.stringify(environment)).not.toContain("broker-secret");
  expect(JSON.stringify(environment)).not.toContain("/host");
  expect(Object.hasOwn(environment, "BUN_OPTIONS")).toBe(false);
  expect(Object.hasOwn(environment, "NODE_OPTIONS")).toBe(false);
  expect(Object.hasOwn(environment, "HTTPS_PROXY")).toBe(false);
  expect(Object.hasOwn(environment, "PI_REQ_DEBUG")).toBe(false);
});
