import { createHash } from "node:crypto";
import type { GuestCtx } from "@manifold/plugin-kit/server";
import { canonicalJobJson, JobDescriptionSchema, PublicJobSchema, type PublicJob } from "@manifold/protocol";
import { CODE_PLUGIN_ID } from "./contract.ts";

export type CodeContext = Pick<GuestCtx, "jobs" | "services" | "host" | "newId" | "now" | "storage" | "auth" | "outsideScope" | "emit">;
export class CodeRefusal extends Error {
  constructor(readonly code: string) { super(`code_${code}`); }
}
export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJobJson(value)).digest("hex");
}
export async function currentResources(ctx: CodeContext, machineId: string, pluginId = CODE_PLUGIN_ID) {
  const description = JobDescriptionSchema.parse(await ctx.jobs.describe({ machineId, pluginId }));
  const installation = description.installation;
  if (description.machineId !== machineId || description.pluginId !== pluginId || !description.connected ||
    installation === null || !installation.enabled || installation.purgeRequested) throw new CodeRefusal("resources_incomplete");
  return { description, installation };
}
export async function currentOperation(ctx: CodeContext, machineId: string, operationId: string) {
  const current = await currentResources(ctx, machineId);
  const operation = current.description.operations?.[operationId];
  if (!operation?.ready) throw new CodeRefusal("resources_incomplete");
  return { installationRevision: current.installation.revision, artifactSha256: current.installation.artifactSha256,
    resourceBindingDigest: operation.resourceBindingDigest };
}
export async function requireCurrentJob(ctx: CodeContext, job: PublicJob) {
  const pins = await currentOperation(ctx, job.machineId, job.operationId);
  if (job.installationRevision !== pins.installationRevision || job.artifactSha256 !== pins.artifactSha256 ||
    job.resourceBindingDigest !== pins.resourceBindingDigest) throw new CodeRefusal("resources_changed");
  return pins;
}
export function requireJobInput(job: PublicJob, input: Record<string, string | number | boolean>): void {
  if (job.inputDigest !== digestOf(input)) throw new CodeRefusal("preview_changed");
}
/** Only the native retained output grants disclose a machine observation, never a preference read. */
export async function readJobResult(ctx: CodeContext, machineId: string, operation: string, jobId: string, door: string) {
  const operationId = `${CODE_PLUGIN_ID}.${operation}`;
  const job = PublicJobSchema.parse(await ctx.jobs.status({ kind: "job", machineId, operationId, jobId }));
  if (job.machineId !== machineId || job.pluginId !== CODE_PLUGIN_ID || job.operationId !== operationId || job.jobId !== jobId ||
    job.state !== "exited" || job.result?.exitCode !== 0 || job.authority.origin.kind !== "action" ||
    job.authority.origin.door !== `${CODE_PLUGIN_ID}.${door}`) throw new CodeRefusal("result_unavailable");
  const output = job.result.outputs.find(item => item.name === "stdout");
  if (!output || output.bytes < 1 || output.bytes > 1 << 20) throw new CodeRefusal("result_unavailable");
  const bytes = Buffer.alloc(output.bytes);
  let offset = 0;
  while (offset < bytes.length) {
    const maxBytes = Math.min(65536, bytes.length - offset);
    const chunk = await ctx.jobs.output({ node: { kind: "output", machineId, operationId, jobId, outputId: output.outputId }, offset, maxBytes });
    const data = Buffer.from(chunk.data, "base64");
    if (chunk.jobId !== jobId || chunk.outputId !== output.outputId || chunk.seq !== offset || data.length < 1 ||
      data.length > maxBytes || data.toString("base64") !== chunk.data || chunk.eof !== (offset + data.length === bytes.length)) throw new CodeRefusal("result_unavailable");
    data.copy(bytes, offset); offset += data.length;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== output.sha256) throw new CodeRefusal("result_unavailable");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new CodeRefusal("result_unavailable"); }
  await requireCurrentJob(ctx, job);
  return { job, value };
}
