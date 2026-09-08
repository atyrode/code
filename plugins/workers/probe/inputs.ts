import { accessSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, readdirSync } from "node:fs";
import { z } from "zod";
import { identifier } from "../../domain/contracts.ts";
import { ProbeError, ProbeIdentitiesSchema, parseBenchmarkInput, type BenchmarkInput, type ProbeIdentity } from "../../domain/probe.ts";

export const PROBE_HOME = "/home/job";
export const PROBE_AGENT = `${PROBE_HOME}/.omp/agent`;
export const PROBE_INPUT_LIMIT = 1024 * 1024;
const loopbackUrl = z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}(?:\/v1)?$/)
  .refine(value => { try { return Number(new URL(value).port) <= 65535; } catch { return false; } });
// This is a deliberately narrow, native OMP models configuration, not Code's
// catalog. No !command api keys, headers, environment references or custom code.
export const ProbeModelsConfigSchema = z.strictObject({ providers: z.record(identifier, z.strictObject({
  baseUrl: loopbackUrl, apiKey: z.string().regex(/^[A-Za-z0-9._~-]{32,4096}$/),
  transport: z.literal("pi-native"), discovery: z.strictObject({ type: z.literal("proxy") }),
})).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 16) });
export const ProbeConfigSchema = z.strictObject({
  extensions: z.array(z.never()).length(0),
  disabledProviders: z.array(identifier).max(256),
  extendedContext: z.boolean(),
});

export function readProbeInput(name: "models" | "config" | "modelIdentities" | "candidates"): unknown {
  const path = name === "models" || name === "config" ? `${PROBE_AGENT}/${name}.yml` : `/inputs/${name}`;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer | undefined;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > PROBE_INPUT_LIMIT || (stat.mode & 0o222) !== 0) throw new ProbeError("invalid_input");
    bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) throw new ProbeError("invalid_input");
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } catch { throw new ProbeError("invalid_input"); }
  finally { bytes?.fill(0); closeSync(fd); }
}
export function prepareProbeInputs(kind: "inventory" | "benchmark"): { identities: ProbeIdentity[]; benchmark?: BenchmarkInput } {
  const expected = kind === "benchmark" ? ["modelIdentities", "candidates"] : ["modelIdentities"];
  const names = readdirSync("/inputs");
  if (names.length !== expected.length || names.some(name => !expected.includes(name))) throw new ProbeError("invalid_input");
  let writable = false;
  try { accessSync("/inputs", constants.W_OK); writable = true; } catch {}
  if (writable) throw new ProbeError("invalid_input");
  const models = ProbeModelsConfigSchema.safeParse(readProbeInput("models"));
  const config = ProbeConfigSchema.safeParse(readProbeInput("config"));
  const identities = ProbeIdentitiesSchema.safeParse(readProbeInput("modelIdentities"));
  if (!models.success || !config.success || !identities.success) throw new ProbeError("invalid_input");
  const addresses = new Set<string>();
  for (const identity of identities.data) {
    const address = `${identity.provider}/${identity.id}`.toLowerCase();
    if (addresses.has(address)) throw new ProbeError("ambiguous_identity");
    if (!Object.hasOwn(models.data.providers, identity.provider) || config.data.disabledProviders.includes(identity.provider)) throw new ProbeError("invalid_input");
    addresses.add(address);
  }
  const benchmark = kind === "benchmark" ? parseBenchmarkInput(readProbeInput("candidates")) : undefined;
  for (const candidate of benchmark?.candidates ?? []) {
    if (!identities.data.some(identity => identity.provider === candidate.provider && identity.id === candidate.id && identity.api === candidate.api)) throw new ProbeError("invalid_input");
  }
  // Native Manifold owns this fresh private home. Config capabilities stay in
  // their sealed homePath mounts; the worker never copies or rewrites them.
  const agentNames = readdirSync(PROBE_AGENT);
  if (agentNames.length !== 2 || agentNames.some(name => !["models.yml", "config.yml"].includes(name))) throw new ProbeError("invalid_input");
  for (const directory of ["tmp", "work"]) {
    mkdirSync(`${PROBE_HOME}/${directory}`, { mode: 0o700, recursive: true });
  }
  return { identities: identities.data, ...(benchmark ? { benchmark } : {}) };
}

export function isolateProbeEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) if (key !== "MANIFOLD_JOB_CONTEXT_FD") delete environment[key];
  Object.assign(environment, probeChildEnvironment());
}
export function probeChildEnvironment(): Record<string, string> {
  return { HOME: PROBE_HOME, XDG_CONFIG_HOME: `${PROBE_HOME}/.config`, XDG_CACHE_HOME: `${PROBE_HOME}/.cache`,
    XDG_DATA_HOME: `${PROBE_HOME}/.local/share`, XDG_STATE_HOME: `${PROBE_HOME}/.local/state`,
    PI_CODING_AGENT_DIR: PROBE_AGENT, PI_CONFIG_DIR: ".omp", TMPDIR: `${PROBE_HOME}/tmp`,
    PATH: "/runtime/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", NO_COLOR: "1" };
}
