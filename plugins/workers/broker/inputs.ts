import { accessSync, constants, closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";

const INPUT_LIMIT = 128 * 1024;
const unavailable = (): Error => new Error("broker_unavailable");

/** Match the native sealed-input boundary used by the gateway worker. */
export function readServiceBearer(): string {
  const names = readdirSync("/inputs");
  if (names.length !== 1 || names[0] !== "serviceBearer") throw unavailable();
  let writable = false;
  try { accessSync("/inputs", constants.W_OK); writable = true; } catch {}
  if (writable) throw unavailable();

  const fd = openSync("/inputs/serviceBearer", "r");
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
    const value: unknown = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{32,4096}$/.test(value)) throw unavailable();
    return value;
  } finally { bytes?.fill(0); closeSync(fd); }
}

/** Import upstream with no ambient credentials, broker, profile, dotenv or debug configuration. */
export function isolateEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    if (!["PATH", "LANG", "LC_ALL", "TZ", "MANIFOLD_JOB_CONTEXT_FD"].includes(key)) delete environment[key];
  }
  environment.HOME = "/inputs";
}
