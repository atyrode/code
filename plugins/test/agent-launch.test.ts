import { describe, expect, test } from "bun:test";
import { actionDoor, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { formatManifoldUri, type TerminalSummary } from "@manifold/protocol";
import type { ActionResult } from "../code/contract.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { compileOmpOverlay, defaultSelection, reviewCatalog } from "../domain/routing.ts";
import { agentLaunchBlocker, AGENT_RUN_WINDOW_MS, codeAgentName, createCodeWorkflowClient, failureWords, runsRefused, sponsorRefused, WorkflowError,
  type CodeRun, type Dials, type SessionReview } from "../code/workflow.ts";
import { answerDial, NO_DIALS, pressDial, refuseDial, settleDial } from "../code/generator/run-dials.ts";
import { leaseOf, leaseWords, runPhase, runSaid, runVerb, span, tabMark } from "../code/generator/runs-model.ts";

const target = { containerId: "workspace", machineId: "destination" };
const containerUri = formatManifoldUri({ kind: "container", containerId: target.containerId });
const scope = [{ target: containerUri, reach: "subtree", caps: ["containers:read"] }];
const HOUR = 3_600_000;
const sessionId = "7ab82ad4-8c9e-4166-8130-472c7cae1559";

function composition(): ActionResult<"composeSession"> {
  const catalog = compileCatalog({ schemaVersion: 1, models: ([1, 2, 3] as const).map(tier => ({
    key: `model-${tier}`, provider: "anthropic", id: `model-${tier}`, api: "anthropic-messages", tier,
    quotaBucket: null, inputCostPerMillion: tier, outputCostPerMillion: tier * 3,
    tokensPerSecond: 30, timeToFirstTokenMs: 100, contextWindow: 200_000, thinkingLevels: ["medium"], images: true,
  })) });
  const selection = defaultSelection(catalog);
  const review = reviewCatalog(catalog, selection, 1000);
  return { revision: 1, review, accountPool: { anthropic: [{ scope: "shared-instance", credentialId: 7, identityKey: "identity" }] },
    overlay: compileOmpOverlay(catalog, selection, review.routes), prompt: "", planYolo: false, compositionDigest: "a".repeat(64) };
}
function reviewOf(value: ActionResult<"composeSession">, native: Partial<SessionReview["native"]> = {}): SessionReview {
  return { destination: { ...target }, composition: value, native: { destination: target, operationId: "atyrode.omp.launch", reviewDigest: "b".repeat(64),
    pins: { installationRevision: "native", artifactSha256: "c".repeat(64), resourceBindingDigest: "d".repeat(64) }, defaultsRevision: 3,
    effectiveOverlay: value.overlay, accountPool: value.accountPool, automation: { mode: "ordinary" },
    skills: { mode: "preserve", catalogRevision: null, selected: [] }, ...native } };
}
function agentOf(name: string, overrides: Record<string, unknown> = {}) {
  return { agentId: "agent-1", principalId: "agent-principal", sponsorPrincipalId: "writer", name, purpose: "Code", harness: "atyrode.omp",
    grant: { scope, maxRunLifetimeMs: HOUR, delegation: { maxDepth: 0, maxDescendants: 0 }, expiresAt: Date.now() + 14 * HOUR },
    context: { profile: {} }, state: "idle", activeRuns: 0, createdAt: 1, updatedAt: 1, ...overrides };
}
function runOf(id: string, overrides: Record<string, unknown> = {}) {
  return { id, agentId: "agent-1", session: null, activity: "unknown", principal: { id: "agent-principal", kind: "agent", name: "Code", color: "#123456" },
    rootRunId: id, parentRunId: null, authorizedByPrincipalId: "writer", authorizationPath: "principal",
    authorizationCredential: { tokenId: null, grantId: null, caps: [], containerScope: null }, purpose: "Code", target: containerUri, reach: "subtree",
    caps: ["containers:read"], createdAt: 1000, expiresAt: 1000 + HOUR, renewals: 0, maxDepth: 0, maxDescendants: 0, depth: 0,
    cleanupOwnerPrincipalId: "writer", state: "pending_policy", policyRevision: "e".repeat(64), cleanup: { revokedCredentials: 0, revokedGrants: 0 }, scope, ...overrides };
}
function launchedOf(runtime: Record<string, unknown> = {}) {
  const session = { harness: "atyrode.omp", sessionId, machineId: target.machineId };
  return { runtime: { machineId: target.machineId, pluginId: "atyrode.omp", operationId: "atyrode.omp.harness", installationRevision: "native",
    artifactSha256: "c".repeat(64), input: { sessionId, tui: true }, resourceBindingDigest: "d".repeat(64), launchBinding: "binding-1", session, ...runtime },
    destination: { machineId: target.machineId }, session, reviewDigest: "f".repeat(64) };
}

/**
 * The agent doors over a scripted Manifold: what each door was asked, and what it answers. A door
 * answers its `answers` entry (a value, or a thrown refusal as the browser's dispatch reports it).
 */
function agentFixture() {
  const value = composition();
  const calls: { door: string; input: Record<string, unknown> }[] = [];
  const answers: Record<string, (input: Record<string, unknown>) => unknown> = {};
  const deny = (door: string, message: string) => { throw new WorkflowError(`${door}: ${message}. No approval or readiness is assumed.`); };
  const defaults: OmpResult<"readDefaults"> = { revision: 3, overlay: {}, updatedAt: null, updatedBy: null };
  const workflow = createCodeWorkflowClient(async (door, raw) => {
    const input = (raw ?? {}) as Record<string, unknown>;
    calls.push({ door, input });
    if (door === actionDoor("accounts")) return { scope: "shared-instance", observedAt: 1000, status: "fresh", accounts: [] };
    if (door === actionDoor("readDefaults")) return defaults;
    if (door === "atyrode.code.composeSession") return value;
    const answer = answers[door];
    if (!answer) throw new Error(`Unexpected door: ${door}`);
    return answer(input);
  });
  answers["core.access.registerAgentV2"] = input => ({ agent: agentOf(input.name as string, { context: input.context, grant: input.grant }),
    credential: { token: "ONE-TIME-RUNNER-TOKEN", expiresAt: Date.now() + HOUR }, created: true });
  answers["core.access.createRunV2"] = () => ({ run: runOf("run-1") });
  answers["core.access.launchRun"] = () => launchedOf();
  answers["core.access.finishAgentRunV2"] = input => ({ run: runOf(input.runId as string, { state: "cancelled" }), finishedRuns: 1, revokedCredentials: 1, revokedGrants: 0 });
  const doors = () => calls.map(call => call.door).filter(door => door.startsWith("core."));
  return { workflow, value, calls, answers, deny, doors, review: reviewOf(value) };
}

describe("the agent door sequence", () => {
  test("a first launch registers Code's Agent with the TUI profile, creates a Run narrowed to its container and launches it, keeping no runner credential", async () => {
    const f = agentFixture();
    const launched = await f.workflow.launchAgent(f.review);
    expect(f.doors()).toEqual(["core.access.registerAgentV2", "core.access.createRunV2", "core.access.launchRun"]);
    const register = f.calls.find(call => call.door === "core.access.registerAgentV2")!.input;
    expect(register.name).toBe(await codeAgentName(target.containerId));
    expect(register.harness).toBe("atyrode.omp");
    expect(register.context).toEqual({ profile: { accountPool: f.value.accountPool, overlay: f.value.overlay, planYolo: false, tui: true } });
    const grant = register.grant as { scope: unknown; maxRunLifetimeMs: number; delegation: unknown; expiresAt: number };
    expect(grant.scope).toEqual(scope);
    expect([grant.maxRunLifetimeMs, grant.delegation]).toEqual([HOUR, { maxDepth: 0, maxDescendants: 0 }]);
    // A Run created now can live its whole attributed window, 13 leases, inside the grant.
    expect(AGENT_RUN_WINDOW_MS).toBe(13 * HOUR);
    expect(grant.expiresAt - Date.now()).toBeGreaterThanOrEqual(AGENT_RUN_WINDOW_MS);
    const default_ = f.value.overlay.modelRoles!.default!;
    expect(f.calls.find(call => call.door === "core.access.createRunV2")!.input).toEqual({ agentId: "agent-1", target, reach: "subtree", lifetimeMs: HOUR, scope,
      model: { provider: default_.slice(0, default_.indexOf("/")), model: default_.slice(default_.indexOf("/") + 1) } });
    expect(f.calls.find(call => call.door === "core.access.launchRun")!.input).toEqual({ runId: "run-1", target });
    expect(launched.launched.runtime.operationId).toBe("atyrode.omp.harness");
    expect(JSON.stringify(launched)).not.toContain("ONE-TIME-RUNNER-TOKEN");
  });

  test("Code's Agent is updated only when its profile or its grant moved, and only in what moved", async () => {
    const f = agentFixture();
    const profile = { accountPool: f.value.accountPool, overlay: f.value.overlay, planYolo: false, tui: true };
    const known = (context: unknown, expiresAt: number) => () => ({ agent: agentOf("Code", { context, grant: { scope, maxRunLifetimeMs: HOUR,
      delegation: { maxDepth: 0, maxDescendants: 0 }, expiresAt } }), created: false });
    const updates: Record<string, unknown>[] = [];
    f.answers["core.access.updateAgentV2"] = input => { updates.push(input); return { agent: agentOf("Code"), canManage: true }; };
    f.answers["core.access.registerAgentV2"] = known({ profile }, Date.now() + 14 * HOUR);
    await f.workflow.launchAgent(f.review);
    expect(updates).toEqual([]);
    f.answers["core.access.registerAgentV2"] = known({ profile: { ...profile, planYolo: true } }, Date.now() + 14 * HOUR);
    await f.workflow.launchAgent(f.review);
    expect(Object.keys(updates.at(-1)!).sort()).toEqual(["agentId", "context"]);
    // A grant that would end inside a new Run's window is renewed, the profile left alone.
    f.answers["core.access.registerAgentV2"] = known({ profile }, Date.now() + 2 * HOUR);
    await f.workflow.launchAgent(f.review);
    expect(Object.keys(updates.at(-1)!).sort()).toEqual(["agentId", "grant"]);
  });

  test("a retired Agent passes its name to the next generation; a disabled one is refused before any Run", async () => {
    const f = agentFixture();
    const base = await codeAgentName(target.containerId);
    f.answers["core.access.registerAgentV2"] = input => input.name === base
      ? { agent: agentOf(base, { state: "retired" }), created: false }
      : { agent: agentOf(input.name as string, { context: input.context, grant: input.grant }), created: true };
    await f.workflow.launchAgent(f.review);
    expect(f.calls.filter(call => call.door === "core.access.registerAgentV2").map(call => call.input.name)).toEqual([base, `${base} 2`]);
    const g = agentFixture();
    g.answers["core.access.registerAgentV2"] = () => ({ agent: agentOf(base, { state: "disabled" }), created: false });
    await expect(g.workflow.launchAgent(g.review)).rejects.toThrow("code_agent_disabled");
    expect(g.doors()).toEqual(["core.access.registerAgentV2"]);
  });

  test("a Run Manifold refuses to launch, or launches as anything but OMP's TUI harness, is cancelled before the refusal is said", async () => {
    const f = agentFixture();
    f.answers["core.access.launchRun"] = () => f.deny("core.access.launchRun", "run_launch_protocol_unsupported");
    const refused = await f.workflow.launchAgent(f.review).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(WorkflowError);
    expect(failureWords((refused as Error).message)).toBe("That machine cannot launch an agent run: its native job owner is missing or predates agent runs.");
    expect(f.calls.at(-1)).toEqual({ door: "core.access.finishAgentRunV2", input: { runId: "run-1", outcome: "cancelled" } });
    for (const runtime of [{ operationId: "atyrode.omp.launch" }, { input: { sessionId, tui: false } }, { machineId: "elsewhere" }]) {
      const g = agentFixture();
      g.answers["core.access.launchRun"] = () => launchedOf(runtime);
      await expect(g.workflow.launchAgent(g.review)).rejects.toThrow();
      expect(g.doors().at(-1)).toBe("core.access.finishAgentRunV2");
    }
    // A cancellation that fails is named beside what stopped the launch.
    const h = agentFixture();
    h.answers["core.access.launchRun"] = () => h.deny("core.access.launchRun", "run_launch_owner_unavailable");
    h.answers["core.access.finishAgentRunV2"] = () => h.deny("core.access.finishAgentRunV2", "agent_unavailable");
    await expect(h.workflow.launchAgent(h.review)).rejects.toThrow(/could not be cancelled .*ends with its lease/);
  });

  test("automatic plans, session options, a missing harness or a caller who cannot sponsor keep the launch a reviewed session", async () => {
    const f = agentFixture();
    expect(agentLaunchBlocker(f.review, true, false, true)).toBeNull();
    expect(agentLaunchBlocker(reviewOf({ ...f.value, planYolo: true }), true, false, true)).toBe("plans");
    expect(agentLaunchBlocker(reviewOf(f.value, { skills: { mode: "disabled", catalogRevision: null, selected: [] } }), true, false, true)).toBe("options");
    expect(agentLaunchBlocker(reviewOf(f.value, { automation: { mode: "restricted", toolNames: [], delegation: "disabled" } }), true, false, true)).toBe("options");
    expect(agentLaunchBlocker(f.review, false, false, true)).toBe("harness");
    expect(agentLaunchBlocker(f.review, true, true, true)).toBe("machine");
    expect(agentLaunchBlocker(f.review, true, false, false)).toBe("sponsor");
    expect(agentLaunchBlocker(f.review, true, false, null)).toBe("agents");
    // The workflow refuses such a launch itself, before any door.
    await expect(f.workflow.launchAgent(reviewOf(f.value, { skills: { mode: "disabled", catalogRevision: null, selected: [] } }))).rejects.toThrow("code_agent_options_unsupported");
    expect(f.doors()).toEqual([]);
    // Only a sponsorship refusal before any Run exists may turn a launch into the reviewed session.
    const denied = (door: string, message: string) => new WorkflowError(`${door}: ${message}. No approval or readiness is assumed.`);
    expect(sponsorRefused(denied("core.access.registerAgentV2", "sponsor_authority_unavailable"))).toBe(true);
    expect(sponsorRefused(denied("core.access.createRunV2", "agent_registration_requires_human"))).toBe(true);
    expect(sponsorRefused(denied("core.access.launchRun", "sponsor_authority_unavailable"))).toBe(false);
    expect(sponsorRefused(denied("core.access.registerAgentV2", "agent_disabled"))).toBe(false);
    // A machine that cannot carry agent runs refuses at launchRun only, after the Run exists; its launches are then the reviewed session.
    expect(runsRefused(denied("core.access.launchRun", "run_launch_protocol_unsupported"))).toBe(true);
    expect(runsRefused(denied("core.access.launchRun", "omp_harness_runtime_unsupported"))).toBe(true);
    expect(runsRefused(denied("core.access.launchRun", "run_launch_owner_unavailable"))).toBe(false);
    expect(runsRefused(denied("core.access.createRunV2", "run_launch_protocol_unsupported"))).toBe(false);
    expect(runsRefused(new WorkflowError("A failure that names no door."))).toBe(false);
  });

  test("the runs read lists open, detached and recently ended Runs of this workspace's Code Agents only", async () => {
    const f = agentFixture();
    const base = await codeAgentName(target.containerId), now = Date.now();
    const session = (id: string) => ({ harness: "atyrode.omp", sessionId: id, machineId: target.machineId });
    const entry = (id: string, overrides: Record<string, unknown>) => ({ id, principalId: "agent-principal", agentId: "agent-1", session: null, activity: "idle",
      name: "Code", state: "pending_policy", purpose: "Code", createdAt: now - HOUR, expiresAt: now + HOUR, parentRunId: null, actionCount: 0, refusalCount: 0, scope, ...overrides });
    const detachedSession = "8ab82ad4-8c9e-4166-8130-472c7cae1559";
    f.answers["core.access.listAgentsV2"] = () => ({ agents: [agentOf(base), agentOf("Code someone-else", { agentId: "agent-2" })], truncated: false, canRegister: true });
    f.answers["core.access.listRunsV2"] = input => {
      expect(input).toEqual({ agentId: "agent-1" });
      return { observedAt: now, truncated: false, runs: [
        entry("live", { session: session(sessionId), createdAt: now - 10 * 60_000 }),
        entry("detached", { session: session(detachedSession), state: "expired", createdAt: now - 20 * HOUR }),
        entry("expired-gone", { session: session("9ab82ad4-8c9e-4166-8130-472c7cae1559"), state: "expired", createdAt: now - 3 * HOUR, expiresAt: now - 2 * HOUR }),
        entry("never-launched", { state: "cancelled", createdAt: now - 2 * HOUR }),
        entry("old", { session: session(sessionId), state: "completed", createdAt: now - 30 * HOUR }),
        ...[1, 2, 3].map(index => entry(`ended-${index}`, { session: session(sessionId), state: "completed", createdAt: now - index * HOUR - 1 })),
      ] };
    };
    const running: TerminalSummary = { id: "tui", machineId: target.machineId, name: "OMP", createdAt: now - 20 * HOUR, status: "running", exitCode: null,
      homeId: target.containerId, unplaced: false, session: session(detachedSession) };
    // The expired Run's session was resumed without a Run after it ended: that terminal is not the Run's TUI, so the Run is not detached.
    const resumed: TerminalSummary = { ...running, id: "resumed", createdAt: now - 10 * 60_000, session: session("9ab82ad4-8c9e-4166-8130-472c7cae1559") };
    f.answers["core.terminals.listAll"] = () => ({ terminals: [running, resumed] });
    f.answers["core.access.inspectRunV2"] = input => f.deny("core.access.inspectRunV2", `inspection of ${String(input.runId)} unavailable`);
    const read = await f.workflow.readRuns(target.containerId);
    expect(read.canSponsor).toBe(true);
    expect(read.runs.map(run => run.run.id)).toEqual(["live", "detached", "ended-1", "ended-2", "expired-gone"]);
    expect(read.runs.find(run => run.run.id === "detached")!.terminal?.id).toBe("tui");
    expect(read.runs.find(run => run.run.id === "expired-gone")!.terminal).toBeNull();
    expect(read.runs.every(run => run.inspection === null)).toBe(true);
  });
});

describe("a Run's dials", () => {
  const launched: Dials = { model: "anthropic/claude-sonnet-5", thinking: "medium" };
  const none = () => false;
  test("a press sends one change and waits; the same word sends nothing, and a press while one waits is queued, the latest replacing the earlier", () => {
    const sent = pressDial(NO_DIALS, { field: "model", value: "anthropic/claude-opus-5" }, launched, none);
    expect(sent.send).toBe(true);
    expect(sent.state.pending).toEqual({ field: "model", value: "anthropic/claude-opus-5" });
    expect(pressDial(NO_DIALS, { field: "thinking", value: "medium" }, launched, none).send).toBe(false);
    const queued = pressDial(sent.state, { field: "thinking", value: "high" }, launched, none);
    expect([queued.send, queued.state.queued]).toEqual([false, { field: "thinking", value: "high" }]);
    const latest = pressDial(queued.state, { field: "thinking", value: "low" }, launched, none);
    expect(latest.state.queued).toEqual({ field: "thinking", value: "low" });
    expect(pressDial(latest.state, sent.state.pending!, launched, none).state.queued).toBeNull();
    // An answer keeps the queued change for the hook to send; a refusal that ends the dials drops it.
    expect(answerDial(latest.state, sent.state.pending!, { model: "anthropic/claude-opus-5", thinking: "medium" }, launched).queued).toEqual({ field: "thinking", value: "low" });
    expect(refuseDial(latest.state, sent.state.pending!, "omp_run_control_forbidden", "").queued).toBeNull();
  });

  test("an answer confirms the session's dials, and a thinking level the model moved is said as clamped", () => {
    const change = { field: "model" as const, value: "anthropic/claude-haiku-5" };
    const pending = pressDial(NO_DIALS, change, launched, none).state;
    const confirmed = answerDial(pending, change, { model: change.value, thinking: "medium" }, launched);
    expect(confirmed.reply).toEqual({ model: change.value, thinking: "medium" });
    expect(confirmed.outcome).toEqual({ kind: "confirmed", change, clamped: null });
    expect(answerDial(pending, change, { model: change.value, thinking: "low" }, launched).outcome).toEqual({ kind: "confirmed", change, clamped: "low" });
    const thinking = { field: "thinking" as const, value: "max" };
    expect(answerDial(pressDial(NO_DIALS, thinking, launched, none).state, thinking, { model: launched.model, thinking: "xhigh" }, launched).outcome)
      .toEqual({ kind: "confirmed", change: thinking, clamped: "xhigh" });
    expect(settleDial(confirmed).outcome).toBeNull();
  });

  test("a model the session does not serve is struck and refused from then on; a level the model lacks is refused before sending", () => {
    const change = { field: "model" as const, value: "anthropic/claude-fable-5" };
    const refused = refuseDial(pressDial(NO_DIALS, change, launched, none).state, change, "omp_model_unavailable", "");
    expect([refused.pending, refused.unserved, refused.outcome?.kind]).toEqual([null, [change.value], "unserved"]);
    expect(pressDial(refused, change, launched, none).send).toBe(false);
    const lacks = pressDial(NO_DIALS, { field: "thinking", value: "max" }, launched, level => level === "max");
    expect([lacks.send, lacks.state.outcome?.kind]).toEqual([false, "lacks"]);
    expect(settleDial(refused).outcome?.kind).toBe("unserved");
  });

  test("an unanswered change can be sent again, even to the word already shown; a forbidden caller is refused every press", () => {
    const change = { field: "thinking" as const, value: "medium" };
    const pending = { ...NO_DIALS, pending: change };
    const unconfirmed = refuseDial(pending, change, "omp_run_control_unconfirmed", "");
    expect([unconfirmed.unconfirmed, unconfirmed.pending]).toEqual([change, null]);
    expect(pressDial(unconfirmed, change, launched, none).send).toBe(true);
    const forbidden = refuseDial(pending, change, "omp_run_control_forbidden", "");
    expect(forbidden.forbidden).toBe(true);
    expect(pressDial(forbidden, { field: "thinking", value: "high" }, launched, none).send).toBe(false);
    expect(refuseDial(pending, change, "omp_session_unavailable", "").outcome).toEqual({ kind: "gone" });
  });
});

describe("a Run's lease and words", () => {
  const vocab = { time: (at: number) => `t${Math.round(at / 60_000)}` };
  const now = 1000 * HOUR;
  const entry = (run: Partial<CodeRun["run"]>, renewals: number | null, terminal: TerminalSummary | null = null): CodeRun => ({
    run: { id: "run", principalId: "p", agentId: "a", session: { harness: "atyrode.omp", sessionId, machineId: "m" }, activity: "working", name: "Code",
      state: "pending_policy", purpose: "Code", createdAt: now - HOUR, expiresAt: now + 40 * 60_000, parentRunId: null, actionCount: 0, refusalCount: 0, scope: [], ...run },
    leaseMs: HOUR, terminal, inspection: renewals === null ? null : { renewals, finishedAt: now - 3 * 60_000, exitCode: 1 } });
  test("the next renewal is due half a lease before expiry, and each renewal left moves the end half a lease on", () => {
    const lease = leaseOf(entry({}, 2));
    expect(lease.next).toBe(now + 10 * 60_000);
    expect(lease.until).toBe(now + 40 * 60_000 + 22 * (HOUR / 2));
    expect(leaseWords(entry({}, 2), now, vocab)).toEqual({ text: "renews in 10m", tone: null });
    expect(leaseWords(entry({}, 2), now + 11 * 60_000, vocab).tone).toBe("warn");
  });
  test("the 24th renewal is the last: the lease then only expires, warmly, and an unread one says no renewal", () => {
    expect(leaseOf(entry({}, 24))).toMatchObject({ next: null, until: now + 40 * 60_000 });
    expect(leaseWords(entry({}, 24), now, vocab)).toEqual({ text: `expires ${vocab.time(now + 40 * 60_000)}`, tone: "warn" });
    expect(leaseOf(entry({}, null))).toMatchObject({ renewals: null, next: null, until: null });
  });
  test("an expired Run whose TUI still runs is detached, not ended; one whose terminal is gone is settled and resumable", () => {
    const tui: TerminalSummary = { id: "tui", machineId: "m", name: "OMP", createdAt: 1, status: "running", exitCode: null, homeId: "w", unplaced: false };
    const detached = entry({ state: "expired", expiresAt: now - HOUR }, 3, tui);
    expect([runPhase(detached), runVerb(detached)]).toEqual(["detached", "open"]);
    expect(leaseWords(detached, now, vocab)).toEqual({ text: `detached since ${vocab.time(now - HOUR)}`, tone: "off" });
    const ended = entry({ state: "expired", expiresAt: now - HOUR }, 3);
    expect([runPhase(ended), runVerb(ended)]).toEqual(["expired", "resume"]);
    expect(runPhase(entry({ activity: "unknown" }, 0))).toBe("starting");
    expect(runVerb(entry({ activity: "unknown" }, 0))).toBe("cancel");
    expect(leaseWords(entry({ state: "failed" }, 4), now, vocab).text).toBe(`${vocab.time(now - 3 * 60_000)} · exit 1`);
    expect(span(65 * 60_000)).toBe("1h 5m");
  });
  test("the Sessions tab's square says the most urgent open Run: blocked, then working, then starting", () => {
    expect(tabMark([entry({ activity: "done" }, 0), entry({ activity: "blocked" }, 0), entry({ activity: "working" }, 0)])).toBe("blocked");
    expect(tabMark([entry({ activity: "idle" }, 0), entry({ activity: "unknown" }, 0)])).toBe("starting");
    expect(tabMark([entry({ state: "completed" }, 0)])).toBeNull();
  });
  test("the said line says a change in flight, an unanswered one with send again, and a refusal with what stays", () => {
    const name = (reference: string | null) => ({ text: reference?.split("-").at(-2) ?? "unknown", family: "anthropic" });
    const run = entry({ model: { provider: "anthropic", model: "claude-terra-5:medium" } }, 0);
    const context = { vocab, name, levels: null };
    const pending = { ...NO_DIALS, pending: { field: "model" as const, value: "anthropic/claude-opus-5" } };
    expect(runSaid(run, pending, null, now, context)).toMatchObject({ value: "opus", text: "sent · terra until it answers", warn: false });
    // A press while that one waits is said as next, the pointer on it included, rather than lost.
    const queued = { ...pending, queued: { field: "thinking" as const, value: "high" } };
    expect(runSaid(run, queued, null, now, context)).toMatchObject({ value: "high", text: "next · once opus answers", warn: false });
    expect(runSaid(run, queued, { kind: "word", field: "thinking", value: "high" }, now, context)).toMatchObject({ text: "next · once opus answers" });
    const unconfirmed = refuseDial(pending, pending.pending, "omp_run_control_unconfirmed", "");
    expect(runSaid(run, unconfirmed, null, now, context)).toMatchObject({ value: "opus", text: "no answer in 20 s", warn: true, again: true });
    const unserved = refuseDial(pending, pending.pending, "omp_model_unavailable", "");
    expect(runSaid(run, unserved, null, now, context)).toMatchObject({ text: "not served here · terra stays", warn: true });
    expect(runSaid(entry({ state: "expired" }, 24, null), NO_DIALS, null, now, context)).toBeNull();
    // A click leaves the pointer on the word it sent: what the press came to is said, not the word's own readout.
    const pointed = { kind: "word" as const, field: "model" as const, value: "anthropic/claude-opus-5" };
    const confirmed = answerDial(pending, pending.pending, { model: "anthropic/claude-opus-5", thinking: "medium" }, { model: "anthropic/claude-terra-5", thinking: "medium" });
    expect(runSaid(run, confirmed, pointed, now, context)).toMatchObject({ value: "opus", text: "running now" });
    expect(runSaid(run, unserved, pointed, now, context)).toMatchObject({ text: "not served here · terra stays" });
  });
});
