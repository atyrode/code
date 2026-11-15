import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalJobJson, ListJobRunsResultSchema } from "@manifold/protocol";
import { actionDoor as ompActionDoor, actionSchemas as ompActionSchemas, type OmpAction,
  type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { installBundle } from "../../../manifold/packages/plugin-kit/src/install.ts";
import { dispatch, ownerAction, roster } from "../../../manifold/packages/plugin-kit/src/hub.ts";
import type { NativeToolConsumer, NativeToolConsumerContext } from "../.integration/omp/plugins/scripts/verify-consumer-types.ts";
import { actionDoor, actionSchemas, CODE_PLUGIN_ID, sessionInput, type ActionInput, type ActionResult, type CodeAction } from "../code/contract.ts";

class ConsumerProofFailure extends Error {
  constructor(readonly code: string) { super(`Code native proof: ${code}`); }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new ConsumerProofFailure(`consumer-${code}`);
}

/** Runs only inside OMP's private verifier process. Code owns no runtime bootstrap. */
export async function createNativeToolConsumer(context: NativeToolConsumerContext): Promise<NativeToolConsumer> {
  const { hub, target, installed, accounts } = context;
  const family = [CODE_PLUGIN_ID, "atyrode.code.accounts", "atyrode.code.generator", "atyrode.code.usage"];
  // The proof hardens Code's server boundary; its presentation parts retain their in-realm runner.
  for (const id of family) {
    const file = resolve(import.meta.dir, "../dist", `${id}.manifold-plugin.json`);
    const bytes = await readFile(file);
    installed.push(id);
    await installBundle({ source: file, sha256: createHash("sha256").update(bytes).digest("hex"), hub, hardened: id === CODE_PLUGIN_ID });
  }
  const loaded = await roster(hub);
  check(family.every(id => loaded.some(row => row.manifest.id === id && row.enabled)), "family-not-installed");
  async function call<K extends CodeAction>(name: K, input: ActionInput<K>): Promise<ActionResult<K>> {
    const result = await dispatch(hub, hub.ownerKey, actionDoor(name), actionSchemas[name].input.parse(input));
    check(result.ok, `${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}-refused`);
    return actionSchemas[name].result.parse(result.result) as ActionResult<K>;
  }
  async function omp<K extends OmpAction>(name: K, input: OmpInput<K>): Promise<OmpResult<K>> {
    const result = await dispatch(hub, hub.ownerKey, ompActionDoor(name), ompActionSchemas[name].input.parse(input));
    check(result.ok, `omp-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}-refused`);
    return ompActionSchemas[name].result.parse(result.result) as OmpResult<K>;
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
  const roles = ["default", "task", "plan", "slow", "vision", "smol", "memory", "widget", "tiny", "commit"];
  check(canonicalJobJson(composed.review.routes.map(route => route.role)) === canonicalJobJson(roles), "shared-route-order-changed");
  check(canonicalJobJson(Object.keys(composed.overlay.modelRoles ?? {}).sort()) === canonicalJobJson([...roles].sort()), "shared-role-keys-changed");
  check(!Object.hasOwn(composed.overlay.task ?? {}, "agentModelOverrides"), "named-agent-overrides-emitted");
  check(canonicalJobJson(composed.overlay.task) === canonicalJobJson({}), "task-defaults-not-replaced");
  check(!Object.hasOwn(composed.overlay, "memory"), "memory-execution-enabled");
  check(canonicalJobJson(composed.overlay.retry?.fallbackChains?.memory) === canonicalJobJson([]), "memory-retry-chain-inherited");
  check(canonicalJobJson(composed.overlay.modelRoles) === canonicalJobJson({
    default: "openai/gpt-5:low", task: "openai/gpt-5:low", plan: "openai/gpt-5:medium", slow: "openai/gpt-5:medium",
    vision: "openai/gpt-5:low", smol: "openai/gpt-5-mini:medium", memory: "openai/gpt-5-mini:medium", widget: "openai/gpt-5-mini:low",
    tiny: "openai/gpt-5-mini:low", commit: "openai/gpt-5-mini:low",
  }), "shared-role-effort-or-premium-boundary-changed");
  // Exercise the real OMP defaults merge without launching inference. Only the disposable proof's
  // defaults move, and restoring them supplies the revision the later native session must fence.
  const originalDefaults = await omp("readDefaults", {});
  check(originalDefaults.revision === context.input.expectedDefaultsRevision, "defaults-before-proof-changed");
  const inherited = await omp("writeDefaults", { expectedRevision: originalDefaults.revision,
    overlay: { ...originalDefaults.overlay, task: { prewalk: true, agentAdvisor: { task: "on" } },
      defaultThinkingLevel: "medium", advisor: { enabled: false } } });
  let defaultsRevision: number;
  try {
    const review = await omp("reviewSession", { ...sessionInput(target, composed, inherited.revision, { skills: { mode: "disabled" } }),
      overlay: { modelRoles: composed.overlay.modelRoles, retry: composed.overlay.retry, task: composed.overlay.task } });
    check(canonicalJobJson(review.effectiveOverlay.task) === canonicalJobJson({}), "task-preferences-inherited");
    check(review.effectiveOverlay.defaultThinkingLevel === "medium"
      && canonicalJobJson(review.effectiveOverlay.advisor) === canonicalJobJson({ enabled: false }), "unrelated-defaults-replaced");
  } finally {
    const restored = await omp("writeDefaults", { expectedRevision: inherited.revision, overlay: originalDefaults.overlay });
    check(canonicalJobJson(restored.overlay) === canonicalJobJson(originalDefaults.overlay), "defaults-not-restored");
    defaultsRevision = restored.revision;
  }
  const input = sessionInput(target, composed, defaultsRevision, { skills: { mode: "disabled" } });
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
  // An adoption of a key that posted nothing refuses by OMP's own name through Code and retires
  // the key at OMP: a later keyed create refuses by Code's own word, and neither posts anything.
  const adoption = await dispatch(hub, hub.ownerKey, actionDoor("runSession"), { ...request,
    postingKey: "code-native-unposted", adoptOnly: true });
  check(!adoption.ok && adoption.denial.rule === "refused" && adoption.denial.message === "code_omp_posting_unknown",
    "unposted-adoption-not-refused");
  const retired = await dispatch(hub, hub.ownerKey, actionDoor("runSession"), { ...request, postingKey: "code-native-unposted" });
  check(!retired.ok && retired.denial.rule === "refused" && retired.denial.message === "code_posting_retired",
    "retired-key-posted");
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
      if (native.agentTools !== undefined) return call("runSession", { ...request, agentTools: native.agentTools });
      // An ordinary session is posted under a key. After the profile moves, a retry and an
      // adoption with the posting's own stale revision still answer with that job.
      const keyed = { ...request, postingKey: "code-native-default-off" };
      const job = await call("runSession", keyed);
      configuration = await call("select", { ...workspace, expectedRevision: configuration.revision,
        selection: { ...configuration.selection!, thinking: "medium" } });
      check(configuration.revision > keyed.expectedRevision, "profile-revision-not-moved");
      check((await call("runSession", keyed)).jobId === job.jobId
        && (await call("runSession", { ...keyed, adoptOnly: true })).jobId === job.jobId, "keyed-posting-not-idempotent");
      return job;
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
