import { accessSync, constants, closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";

const INPUT_LIMIT = 128 * 1024;
const unavailable = (): Error => new Error("broker_unavailable");

export interface BrokerClientAccess { bind: string; bearerSha256: string }
export interface BrokerInputs { serviceBearer: string; clientAccess: BrokerClientAccess | undefined }

export function parseClientAccess(value: unknown): BrokerClientAccess | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const fields = Object.keys(value);
  if (fields.length === 0) return undefined;
  if (fields.length !== 2) throw unavailable();
  const access = value as Record<string, unknown>;
  if (typeof access.bind !== "string" || typeof access.bearerSha256 !== "string"
    || access.bearerSha256.length !== 64 || !/^[0-9a-f]{64}$/.test(access.bearerSha256)) throw unavailable();
  const match = /^127\.0\.0\.1:([1-9][0-9]{3,4})$/.exec(access.bind);
  const port = match ? Number(match[1]) : 0;
  if (port < 1024 || port > 65535 || access.bind !== `127.0.0.1:${port}`) throw unavailable();
  return { bind: access.bind, bearerSha256: access.bearerSha256 };
}

function readSealedJSON(path: string): unknown {
  const fd = openSync(path, "r");
  let bytes: Buffer | undefined;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > INPUT_LIMIT) throw unavailable();
    bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) throw unavailable();
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally { bytes?.fill(0); closeSync(fd); }
}

/** Match the native sealed-input boundary used by the gateway worker. */
export function readBrokerInputs(): BrokerInputs {
  const names = readdirSync("/inputs");
  if (names.length !== 2
    || names.some(name => name !== "serviceBearer" && name !== "clientAccess")) throw unavailable();
  let writable = false;
  try { accessSync("/inputs", constants.W_OK); writable = true; } catch {}
  if (writable) throw unavailable();
  const serviceBearer = readSealedJSON("/inputs/serviceBearer");
  if (typeof serviceBearer !== "string" || serviceBearer.trim() !== serviceBearer
    || !/^[A-Za-z0-9._~-]{32,4096}$/.test(serviceBearer)) throw unavailable();
  // Native inputFiles.input writes the required string as-is, not JSON-encoded again.
  const clientAccess = parseClientAccess(readSealedJSON("/inputs/clientAccess"));
  return { serviceBearer, clientAccess };
}

/** Import upstream with no ambient credentials, broker, profile, dotenv or debug configuration. */
export function isolateEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    if (!["PATH", "LANG", "LC_ALL", "TZ", "MANIFOLD_JOB_CONTEXT_FD"].includes(key)) delete environment[key];
  }
  environment.HOME = "/inputs";
}
