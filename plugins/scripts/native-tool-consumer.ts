import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJobJson, ListJobRunsResultSchema } from "@manifold/protocol";
import { actionDoor as ompActionDoor } from "@atyrode/manifold-omp";
import { installBundle } from "../../../manifold/packages/plugin-kit/src/install.ts";
import { dispatch, ownerAction, roster } from "../../../manifold/packages/plugin-kit/src/hub.ts";
import type { NativeToolConsumer, NativeToolConsumerContext } from "../.integration/omp/plugins/scripts/verify-consumer-types.ts";
import { actionDoor, actionSchemas, sessionInput, type ActionInput, type ActionResult, type CodeAction } from "../code/contract.ts";

class ConsumerProofFailure extends Error {
  constructor(readonly code: string) { super(`Code native proof: ${code}`); }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new ConsumerProofFailure(`consumer-${code}`);
}

/** Runs only inside OMP's private verifier process. Code owns no runtime bootstrap. */
export async function createNativeToolConsumer(context: NativeToolConsumerContext): Promise<NativeToolConsumer> {
  const { hub, target, installed, accounts } = context;
  const family = ["atyrode.code", "atyrode.code.accounts", "atyrode.code.generator", "atyrode.code.usage"];
  for (const id of family) {
    const file = resolve(import.meta.dir, "../dist", `${id}.manifold-plugin.json`);
    const bytes = await readFile(file);
    installed.push(id);
    await installBundle({ source: file, sha256: createHash("sha256").update(bytes).digest("hex"), hub, hardened: true });
  }
  const loaded = await roster(hub);
  check(family.every(id => loaded.some(row => row.manifest.id === id && row.enabled)), "family-not-installed");
  async function call<K extends CodeAction>(name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
    const result = await dispatch(hub, hub.ownerKey, actionDoor(name), actionSchemas[name].input.parse(input));
    check(result.ok, `${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}-refused`);
    return actionSchemas[name].result.parse(result.result) as ActionResult<K>;
  }
  const workspace = { containerId: target.containerId };
  const empty = await call("readConfiguration", workspace);
  check(empty.configuration === null, "configuration-not-empty");
  let configuration = await call("initializeConfiguration", { ...workspace, expectedRevision: empty.revision });
  configuration = await call("stageCatalog", { ...workspace, expectedRevision: configuration.revision, document: {
    schemaVersion: 1, models: ([1, 2, 3] as const).map(tier => ({
      key: `proof-${tier}`, provider: "openai", id: tier === 2 ? "gpt-5" : tier === 1 ? "gpt-5-mini" : "gpt-5-pro",
      api: "openai-completions", tier, quotaBucket: null, inputCostPerMillion: 0, outputCostPerMillion: 0,
      tokensPerSecond: 30, timeToFirstTokenMs: 100, contextWindow: 200_000,
      thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], images: true,
    })),
  } });
  const catalog = await call("reviewCatalog", { ...workspace, expectedRevision: configuration.revision, source: "draft" });
  configuration = await call("promoteCatalog", { ...workspace, expectedRevision: configuration.revision,
    source: "draft", reviewDigest: catalog.reviewDigest });
  check(configuration.selection, "selection-missing");
  configuration = await call("select", { ...workspace, expectedRevision: configuration.revision,
    selection: { ...configuration.selection, capability: 2, thinking: "low", advisor: "off", spark: false,
      priority: false, prewalk: false, planYolo: false, fallback: false, budget: "free" } });
  const selected = accounts.accounts.find(account => account.reference.provider === "openai" && !account.disabled);
  check(selected, "synthetic-account-missing");
  for (const account of accounts.accounts) {
    configuration = await call("changeAccounts", { ...workspace, expectedRevision: configuration.revision,
      change: { kind: "set-account", reference: account.reference,
        enabled: account.credentialId === selected.credentialId && account.reference.scope === selected.reference.scope } });
  }
  const composed = await call("composeSession", { ...workspace, expectedRevision: configuration.revision,
    accounts, prompt: context.input.prompt });
  check(canonicalJobJson(composed.accountPool) === canonicalJobJson(context.input.accountPool), "account-choice-broadened");
  const input = sessionInput(target, composed, context.input.expectedDefaultsRevision, { skills: { mode: "disabled" } });
  const request = { ...target, expectedRevision: configuration.revision, prompt: input.prompt, skills: input.skills };
  const before = ListJobRunsResultSchema.parse(await ownerAction(hub, "engine.jobs.listRuns", {
    machineId: target.machineId, pluginId: "atyrode.omp", operationId: "atyrode.omp.session",
  }));
  const stale = await dispatch(hub, hub.ownerKey, actionDoor("runSession"), { ...request,
    expectedRevision: configuration.revision - 1, agentTools: { runId: randomUUID() } });
  check(!stale.ok && stale.denial.rule === "refused" && stale.denial.message.includes("code_stale_preferences"), "stale-composition-not-fenced");
  const unknown = await dispatch(hub, hub.ownerKey, actionDoor("runSession"), { ...request, agentTools: { runId: randomUUID() } });
  const unknownReason = unknown.ok ? "accepted" : /^code_[a-z_]{1,40}$/.test(unknown.denial.message)
    ? unknown.denial.message.replaceAll("_", "-") : unknown.denial.rule.replaceAll("_", "-");
  check(!unknown.ok && unknown.denial.rule === "refused" && unknown.denial.message.includes("code_omp_"),
    `unknown-run-${unknownReason}`);
  const after = ListJobRunsResultSchema.parse(await ownerAction(hub, "engine.jobs.listRuns", {
    machineId: target.machineId, pluginId: "atyrode.omp", operationId: "atyrode.omp.session",
  }));
  check(canonicalJobJson(before) === canonicalJobJson(after), "refusal-created-job");
  return {
    // Native authority records the leaf OMP action, not the composing Code caller.
    // The real Code read/cancel doors below require Code's retained provenance.
    input, originDoor: ompActionDoor("runSession"),
    async runSession(native) {
      // Code intentionally has no caller-supplied review digest: its public door
      // composes, reviews, re-observes and fences again under the actual caller.
      check(native.containerId === target.containerId && native.machineId === target.machineId
        && native.prompt === input.prompt && native.expectedDefaultsRevision === input.expectedDefaultsRevision
        && canonicalJobJson(native.overlay) === canonicalJobJson(input.overlay)
        && canonicalJobJson(native.accountPool) === canonicalJobJson(input.accountPool), "native-input-changed");
      return call("runSession", { ...request, ...(native.agentTools === undefined ? {} : { agentTools: native.agentTools }) });
    },
    async readSession(native) {
      check(native.containerId === target.containerId && native.machineId === target.machineId, "read-target-changed");
      return call("readSession", { ...workspace, jobId: native.jobId });
    },
    async cancelSession(native) {
      check(native.containerId === target.containerId && native.machineId === target.machineId, "cancel-target-changed");
      return call("cancelSession", { ...workspace, jobId: native.jobId });
    },
  };
}
