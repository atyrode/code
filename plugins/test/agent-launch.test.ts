import { describe, expect, test } from "bun:test";
import { actionDoor, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { formatManifoldUri, type TerminalSummary } from "@manifold/protocol";
import type { ActionResult } from "../code/contract.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { compileOmpOverlay, defaultSelection, reviewCatalog } from "../domain/routing.ts";
import { agentLaunchBlocker, AGENT_RUN_WINDOW_MS, codeAgentName, createCodeWorkflowClient, failureWords, runDials, runsRefused, sponsorRefused, WorkflowError,
  type CodeRun, type Dials, type SessionReview } from "../code/workflow.ts";
import { answerDial, judgeKept, keepAnswer, keptAnswersKey, NO_DIALS, pressDial, readDials, readKeptAnswers, refuseDial, settleDial, shownDials,
  type AnswerStorage } from "../code/generator/run-dials.ts";
import { detachedAt, leaseOf, leaseWords, runPhase, runSaid, runVerb, span, tabMark } from "../code/generator/runs-model.ts";

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
const session = (id: string) => ({ harness: "atyrode.omp", sessionId: id, machineId: target.machineId });
/** A Run as `listRunsV2` lists it: open, created an hour before `now` and expiring an hour after, unless `overrides` say otherwise. */
function listedRun(id: string, now: number, overrides: Record<string, unknown>) {
  return { id, principalId: "agent-principal", agentId: "agent-1", session: null, activity: "idle", name: "Code", state: "pending_policy", purpose: "Code",
    createdAt: now - HOUR, expiresAt: now + HOUR, parentRunId: null, actionCount: 0, refusalCount: 0, scope, ...overrides };
}
type ListedRun = { readonly id: string; readonly principalId: string; readonly agentId: string; readonly session: unknown; readonly activity: string;
  readonly name: string; readonly state: string; readonly purpose: string; readonly createdAt: number; readonly expiresAt: number };
/** `inspectRunV2`'s answer for a listed Run: settled at `finishedAt` (null while open), naming the running terminals it opened. */
function inspectionOf(run: ListedRun, finishedAt: number | null, terminalIds: readonly string[]) {
  return { availability: "available", observedAt: run.createdAt, run: { id: run.id, principalId: run.principalId, agentId: run.agentId, session: run.session,
    activity: run.activity, name: run.name, state: run.state, rootRunId: run.id, parentRunId: null, sponsorPrincipalId: "writer", authorizationPath: "principal",
    purpose: run.purpose, target: containerUri, reach: "subtree", caps: ["containers:read"], createdAt: run.createdAt, expiresAt: run.expiresAt, renewals: 2,
    depth: 0, maxDepth: 0, maxDescendants: 0, policyRevision: "e".repeat(64), acknowledgedPolicyRevision: null, policyAcknowledgedAt: null,
    cleanup: { ownerPrincipalId: "writer", revokedCredentials: 1, revokedGrants: 0, finishedAt, status: finishedAt === null ? "pending" : "finished" }, scope },
    lineage: [], lineageComplete: true, credentials: [], connections: [], traces: [], nextBeforeTraceId: null, requestedTrace: "not_requested",
    history: "retained_only", jobs: [], nativeTruncated: false, terminals: terminalIds.map(terminalId => ({ terminalId, machineId: target.machineId,
      containerId: target.containerId, createdAt: run.createdAt, state: "running", exitCode: null, traceId: null, retention: "retained" })) };
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
    // A TUI that would write a session other than the one the Run is bound to is cancelled too.
    const other = agentFixture();
    other.answers["core.access.launchRun"] = () => launchedOf({ input: { sessionId: "8ab82ad4-8c9e-4166-8130-472c7cae1559", tui: true } });
    await expect(other.workflow.launchAgent(other.review)).rejects.toThrow("code_run_changed");
    expect(other.doors().at(-1)).toBe("core.access.finishAgentRunV2");
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
    const detachedSession = "8ab82ad4-8c9e-4166-8130-472c7cae1559";
    f.answers["core.access.listAgentsV2"] = () => ({ agents: [agentOf(base), agentOf("Code someone-else", { agentId: "agent-2" })], truncated: false, canRegister: true });
    f.answers["core.access.listRunsV2"] = input => {
      expect(input).toEqual({ agentId: "agent-1" });
      return { observedAt: now, truncated: false, runs: [
        listedRun("live", now, { session: session(sessionId), createdAt: now - 10 * 60_000 }),
        listedRun("detached", now, { session: session(detachedSession), state: "expired", createdAt: now - 20 * HOUR }),
        listedRun("expired-gone", now, { session: session("9ab82ad4-8c9e-4166-8130-472c7cae1559"), state: "expired", createdAt: now - 3 * HOUR, expiresAt: now - 2 * HOUR }),
        listedRun("never-launched", now, { state: "cancelled", createdAt: now - 2 * HOUR }),
        listedRun("old", now, { session: session(sessionId), state: "completed", createdAt: now - 30 * HOUR }),
        ...[1, 2, 3].map(index => listedRun(`ended-${index}`, now, { session: session(sessionId), state: "completed", createdAt: now - index * HOUR - 1 })),
      ] };
    };
    const running: TerminalSummary = { id: "tui", machineId: target.machineId, name: "OMP", createdAt: now - 20 * HOUR, status: "running", exitCode: null,
      homeId: target.containerId, unplaced: false, session: session(detachedSession) };
    // The expired Run's session was resumed without a Run after it ended: that terminal is not the Run's TUI, so the Run is not detached.
    const resumed: TerminalSummary = { ...running, id: "resumed", createdAt: now - 10 * 60_000, session: session("9ab82ad4-8c9e-4166-8130-472c7cae1559") };
    // A completed Run keeps its future expiresAt; a resume of its session before then is still not its TUI.
    const resumedCompleted: TerminalSummary = { ...running, id: "resumed-completed", createdAt: now - 5 * 60_000, session: session(sessionId) };
    f.answers["core.terminals.listAll"] = () => ({ terminals: [running, resumed, resumedCompleted] });
    f.answers["core.access.inspectRunV2"] = input => f.deny("core.access.inspectRunV2", `inspection of ${String(input.runId)} unavailable`);
    const read = await f.workflow.readRuns(target.containerId);
    expect(read.canSponsor).toBe(true);
    expect(read.runs.map(run => run.run.id)).toEqual(["live", "detached", "ended-1", "ended-2", "expired-gone"]);
    expect(read.runs.find(run => run.run.id === "detached")!.terminal?.id).toBe("tui");
    expect(read.runs.find(run => run.run.id === "expired-gone")!.terminal).toBeNull();
    expect(read.runs.find(run => run.run.id === "ended-1")!.terminal).toBeNull();
    expect(read.runs.every(run => run.inspection === null)).toBe(true);
  });

  test("a revoked Run whose inspection names its running TUI is detached and listed with the open Runs, whatever its age", async () => {
    const f = agentFixture();
    const base = await codeAgentName(target.containerId), now = Date.now();
    const revokedSession = "8ab82ad4-8c9e-4166-8130-472c7cae1559", resumedSession = "9ab82ad4-8c9e-4166-8130-472c7cae1559";
    const runs = [
      listedRun("live", now, { session: session(sessionId), createdAt: now - 10 * 60_000 }),
      // Revoked in Agents more than a day ago while its TUI ran on: only its inspection says that terminal is its own.
      listedRun("revoked", now, { session: session(revokedSession), state: "revoked", createdAt: now - 30 * HOUR }),
      // Completed, then resumed without a Run: its inspection names no running terminal, so it stays an ended Run.
      listedRun("completed-resumed", now, { session: session(resumedSession), state: "completed", createdAt: now - 2 * HOUR }),
      listedRun("ended", now, { session: session("aab82ad4-8c9e-4166-8130-472c7cae1559"), state: "completed", createdAt: now - HOUR }),
      // Ended without a running terminal of their session: only the newest three of the last day are read, never a fourth or an older one.
      ...[3, 4, 5].map((hours, index) => listedRun(`ended-${index + 2}`, now, { session: session(`${"bcd"[index]}ab82ad4-8c9e-4166-8130-472c7cae1559`), state: "completed",
        createdAt: now - hours * HOUR })),
      listedRun("old", now, { session: session("fab82ad4-8c9e-4166-8130-472c7cae1559"), state: "completed", createdAt: now - 30 * HOUR }),
    ];
    f.answers["core.access.listAgentsV2"] = () => ({ agents: [agentOf(base)], truncated: false, canRegister: true });
    f.answers["core.access.listRunsV2"] = () => ({ observedAt: now, truncated: false, runs });
    const terminal = (id: string, of: string, createdAt: number): TerminalSummary => ({ id, machineId: target.machineId, name: "OMP", createdAt, status: "running",
      exitCode: null, homeId: target.containerId, unplaced: false, session: session(of) });
    f.answers["core.terminals.listAll"] = () => ({ terminals: [terminal("tui-revoked", revokedSession, now - 29 * HOUR), terminal("resumed", resumedSession, now - 10 * 60_000),
      terminal("tui-live", sessionId, now - 9 * 60_000)] });
    const finishedAt = now - 20 * 60_000;
    f.answers["core.access.inspectRunV2"] = input => {
      const run = runs.find(candidate => candidate.id === input.runId)!;
      return inspectionOf(run, run.state === "revoked" ? finishedAt : null, run.id === "revoked" ? ["tui-revoked"] : run.id === "live" ? ["tui-live"] : []);
    };
    const read = await f.workflow.readRuns(target.containerId);
    expect(read.runs.map(entry => entry.run.id)).toEqual(["live", "revoked", "ended", "completed-resumed", "ended-2"]);
    const revoked = read.runs.find(entry => entry.run.id === "revoked")!;
    expect([revoked.terminal?.id, runPhase(revoked), detachedAt(revoked)]).toEqual(["tui-revoked", "detached", finishedAt]);
    const resumed = read.runs.find(entry => entry.run.id === "completed-resumed")!;
    expect([resumed.terminal, runPhase(resumed)]).toEqual([null, "completed"]);
    expect(f.calls.filter(call => call.door === "core.access.inspectRunV2").map(call => call.input.runId).sort())
      .toEqual(["completed-resumed", "ended", "ended-2", "ended-3", "live", "revoked"]);
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
    expect(answerDial(latest.state, sent.state.pending!, { model: "anthropic/claude-opus-5", thinking: "medium" }, launched, launched.model).queued)
      .toEqual({ field: "thinking", value: "low" });
    expect(refuseDial(latest.state, sent.state.pending!, "omp_run_control_forbidden", "").queued).toBeNull();
  });

  test("an answer confirms the session's dials, and a thinking level the model moved is said as clamped", () => {
    const change = { field: "model" as const, value: "anthropic/claude-haiku-5" };
    const pending = pressDial(NO_DIALS, change, launched, none).state;
    const confirmed = answerDial(pending, change, { model: change.value, thinking: "medium" }, launched, launched.model);
    expect(confirmed.reply).toEqual({ model: change.value, thinking: "medium" });
    expect(confirmed.outcome).toEqual({ kind: "confirmed", change, clamped: null });
    expect(answerDial(pending, change, { model: change.value, thinking: "low" }, launched, launched.model).outcome).toEqual({ kind: "confirmed", change, clamped: "low" });
    const thinking = { field: "thinking" as const, value: "max" };
    expect(answerDial(pressDial(NO_DIALS, thinking, launched, none).state, thinking, { model: launched.model, thinking: "xhigh" }, launched, launched.model).outcome)
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

  test("the answers kept per workspace come back after a reload, newest last and at most 32; malformed or refused storage keeps none and throws nothing", () => {
    const stored = new Map<string, string>();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
    const key = keptAnswersKey("writer", target.containerId);
    const changed = { reply: { model: "anthropic/claude-opus-5", thinking: "high" as const }, priors: [launched.model!] };
    for (let index = 0; index < 34; index++) keepAnswer(storage, key, `run-${index}`, { reply: launched, priors: [] });
    // Kept again, a Run's answer is its newest, never a second entry.
    keepAnswer(storage, key, "run-2", changed);
    const kept = readKeptAnswers(storage, key);
    expect([kept.size, [...kept.keys()][0], [...kept.keys()].at(-1), kept.get("run-2")]).toEqual([32, "run-3", "run-2", changed]);
    expect(readKeptAnswers(storage, keptAnswersKey("writer", "another-workspace")).size).toBe(0);
    // An answer kept before answers bridged reads as one that no longer does, and one that no longer does is kept the same way,
    // so a page of either age reads the other's.
    stored.set(key, JSON.stringify([["run-1", launched]]));
    expect(readKeptAnswers(storage, key).get("run-1")).toEqual({ reply: launched, priors: [] });
    keepAnswer(storage, key, "run-2", { reply: launched, priors: [] });
    expect(JSON.parse(stored.get(key)!)).toEqual([["run-1", launched], ["run-2", launched]]);
    for (const text of ["{", JSON.stringify([["run-1", { model: 1, thinking: null }]])]) {
      stored.set(key, text);
      expect(readKeptAnswers(storage, key).size).toBe(0);
    }
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } };
    expect(readKeptAnswers(refusing, key).size).toBe(0);
    expect(() => keepAnswer(refusing, key, "run-1", { reply: launched, priors: [] })).not.toThrow();
    expect(readKeptAnswers(null, key).size).toBe(0);
  });

  // OMP's harness reports the model its session serves as `provider` and `id` alone; Code records the launch as `id:thinking`.
  const sonnet = runDials({ provider: "anthropic", model: "claude-sonnet-5" }), opus = runDials({ provider: "anthropic", model: "claude-opus-5" });
  const haiku = runDials({ provider: "anthropic", model: "claude-haiku-5" });

  test("a model switched in the TUI shows once read: the live Run.model wins over the answer kept for another model, and one for the reported model keeps its thinking", () => {
    expect(runDials({ provider: "anthropic", model: "claude-sonnet-5:medium" })).toEqual(launched);
    expect(opus).toEqual({ model: "anthropic/claude-opus-5", thinking: null });
    const thinking = { field: "thinking" as const, value: "high" };
    const confirmed = answerDial(pressDial(NO_DIALS, thinking, launched, none).state, thinking, { model: launched.model, thinking: "high" }, launched, sonnet.model);
    // The answer is the one word on the thinking: a read of its own model keeps it.
    expect(readDials(confirmed, sonnet)).toEqual({ ...confirmed, priors: [] });
    expect(shownDials(confirmed, sonnet)).toEqual({ model: launched.model, thinking: "high" });
    // Read after the operator switched in the TUI: the answer and its confirmation go, the reported model shows and its thinking is unknown.
    const read = readDials(confirmed, opus);
    expect([read.reply, read.priors, read.outcome, shownDials(read, opus)]).toEqual([null, [], null, opus]);
    // A refusal still said stays, and a Run that reports no model contradicts nothing.
    const unserved = refuseDial(confirmed, { field: "model", value: "anthropic/claude-fable-5" }, "omp_model_unavailable", "");
    expect(readDials(unserved, opus).outcome).toEqual(unserved.outcome);
    expect(readDials(confirmed, runDials(undefined))).toBe(confirmed);
  });

  test("a read served before the session reported a change does not contradict its answer; one naming the answer's model ends the bridge", () => {
    const change = { field: "model" as const, value: opus.model! };
    // The answer lands while the read in hand names sonnet, the model the Run reported before the press.
    const answered = answerDial(pressDial(NO_DIALS, change, launched, none).state, change, { model: opus.model, thinking: "high" }, launched, sonnet.model);
    // A read served before the report and landing after the answer still names sonnet: model, thinking and confirmation stay.
    expect(readDials(answered, sonnet)).toBe(answered);
    expect([shownDials(answered, sonnet), answered.outcome?.kind]).toEqual([{ model: opus.model, thinking: "high" }, "confirmed"]);
    // Any other model is a switch made elsewhere, bridge or not.
    expect(readDials(answered, haiku).reply).toBeNull();
    // A read naming opus ends the bridge, and from then on sonnet is a switch back in the TUI.
    const reported = readDials(answered, opus);
    expect([reported.reply, reported.priors, reported.outcome]).toEqual([answered.reply, [], answered.outcome]);
    expect(readDials(reported, sonnet).reply).toBeNull();
    // An answer landing once the read in hand already names its model has no bridge.
    expect(answerDial(pressDial(NO_DIALS, change, launched, none).state, change, { model: opus.model, thinking: "high" }, launched, opus.model).priors).toEqual([]);
    // A model the Run's harness never confirms (OpenRouter's) leaves every read naming sonnet, and the answer stays.
    const live = { field: "model" as const, value: "openrouter/qwen/qwen3-coder" };
    const unconfirmable = answerDial(pressDial(NO_DIALS, live, launched, none).state, live, { model: live.value, thinking: null }, launched, sonnet.model);
    expect(readDials(readDials(unconfirmable, sonnet), sonnet)).toBe(unconfirmable);
  });

  test("a change queued behind an answer still bridging keeps both models in its bridge, in the order the session reports them", () => {
    const toOpus = { field: "model" as const, value: opus.model! }, toHaiku = { field: "model" as const, value: haiku.model! };
    const first = answerDial(pressDial(NO_DIALS, toOpus, launched, none).state, toOpus, { model: opus.model, thinking: "high" }, launched, sonnet.model);
    // The queued change goes the moment opus answers, and its own answer lands before any read shows opus.
    const second = answerDial(pressDial(first, toHaiku, first.reply!, none).state, toHaiku, { model: haiku.model, thinking: "high" }, first.reply!, sonnet.model);
    expect(second.priors).toEqual([sonnet.model!, opus.model!]);
    // Reads served before haiku's report name sonnet, then opus: each keeps haiku, and once opus is read, sonnet is past.
    expect(readDials(second, sonnet)).toBe(second);
    const opusRead = readDials(second, opus);
    expect([opusRead.reply, opusRead.priors]).toEqual([second.reply, [opus.model!]]);
    expect(readDials(opusRead, sonnet).reply).toBeNull();
    expect(readDials(opusRead, haiku).priors).toEqual([]);
    // The bridge keeps its first model, which every read names while the session serves unconfirmed models, and the latest.
    const models = Array.from({ length: 10 }, (_, index) => `openrouter/vendor/model-${index}`);
    const swept = models.reduce((state, value) => {
      const sweep = { field: "model" as const, value };
      return answerDial(pressDial(state, sweep, shownDials(state, sonnet), none).state, sweep, { model: value, thinking: null }, shownDials(state, sonnet), sonnet.model);
    }, NO_DIALS);
    expect(swept.priors).toEqual([sonnet.model!, ...models.slice(2, 9)]);
    expect(readDials(swept, sonnet)).toBe(swept);
  });

  test("a read naming the model of the change in flight leaves the answer kept before it; a read of another model drops it", () => {
    const toOpus = { field: "model" as const, value: opus.model! }, toHaiku = { field: "model" as const, value: haiku.model! };
    const kept = readDials(answerDial(pressDial(NO_DIALS, toOpus, launched, none).state, toOpus, { model: opus.model, thinking: "high" }, launched, sonnet.model), opus);
    const inFlight = pressDial(kept, toHaiku, kept.reply!, none).state;
    // Haiku's report can land before its answer: the dials still show opus until haiku answers.
    expect(readDials(inFlight, haiku)).toBe(inFlight);
    expect(shownDials(inFlight, haiku)).toEqual(kept.reply!);
    expect(readDials(inFlight, sonnet).reply).toBeNull();
  });

  test("a read naming the model of a change left unanswered shows that it applied; a thinking level cannot be read", () => {
    const change = { field: "model" as const, value: opus.model! }, level = { field: "thinking" as const, value: "high" };
    const unconfirmed = refuseDial({ ...NO_DIALS, pending: change }, change, "omp_run_control_unconfirmed", "");
    expect(readDials(unconfirmed, sonnet)).toBe(unconfirmed);
    expect(readDials(unconfirmed, opus)).toEqual({ ...unconfirmed, unconfirmed: null });
    const unread = refuseDial({ ...NO_DIALS, pending: level }, level, "omp_run_control_unconfirmed", "");
    expect(readDials(unread, opus)).toBe(unread);
  });

  test("a read judges the kept answers as it judges the page's, so a reload or another tab agrees; a store that refuses writes throws nothing", () => {
    const stored = new Map<string, string>();
    const storage: AnswerStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value); } };
    const key = keptAnswersKey("writer", target.containerId), opusHigh = { model: opus.model, thinking: "high" as const };
    keepAnswer(storage, key, "stale", { reply: opusHigh, priors: [] });
    keepAnswer(storage, key, "bridging", { reply: opusHigh, priors: [sonnet.model!] });
    keepAnswer(storage, key, "agrees", { reply: launched, priors: [] });
    // A reload restores each answer with its bridge. The first read names sonnet for each: the stale answer is forgotten, the
    // bridging one stays, since that read may predate the report of its change.
    expect(readKeptAnswers(storage, key).get("bridging")).toEqual({ reply: opusHigh, priors: [sonnet.model!] });
    expect([judgeKept(storage, key, "stale", sonnet), judgeKept(storage, key, "bridging", sonnet)]).toEqual([null, null]);
    expect([...readKeptAnswers(storage, key).keys()]).toEqual(["bridging", "agrees"]);
    // A read naming the bridging answer's model ends its bridge in storage too.
    expect(judgeKept(storage, key, "bridging", opus)).toEqual(opusHigh);
    expect(readKeptAnswers(storage, key).get("bridging")).toEqual({ reply: opusHigh, priors: [] });
    // The answer kept for the model a read names is returned, for a page whose own answer that read dropped to show.
    expect(judgeKept(storage, key, "agrees", sonnet)).toEqual(launched);
    // A store that reads but refuses writes forgets nothing and throws nothing; one that refuses reads holds nothing to judge.
    const before = stored.get(key);
    const full: AnswerStorage = { getItem: name => stored.get(name) ?? null, setItem: () => { throw new Error("full"); } };
    expect(judgeKept(full, key, "agrees", haiku)).toBeNull();
    expect(stored.get(key)).toBe(before);
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } };
    expect(judgeKept(refusing, key, "agrees", haiku)).toBeNull();
  });
});

describe("a Run's lease and words", () => {
  const vocab = { time: (at: number) => `t${Math.round(at / 60_000)}` };
  const now = 1000 * HOUR;
  const entry = (run: Partial<CodeRun["run"]>, renewals: number | null, terminal: TerminalSummary | null = null): CodeRun => ({
    run: { id: "run", principalId: "p", agentId: "a", session: { harness: "atyrode.omp", sessionId, machineId: "m" }, activity: "working", name: "Code",
      state: "pending_policy", purpose: "Code", createdAt: now - HOUR, expiresAt: now + 40 * 60_000, parentRunId: null, actionCount: 0, refusalCount: 0, scope: [], ...run },
    leaseMs: HOUR, terminal, inspection: renewals === null ? null : { renewals, finishedAt: now - 3 * 60_000, exitCode: 1, terminalIds: ["tui"] } });
  test("a settled Run whose own TUI still runs is detached since it settled; one cancelled before any terminal offers no resume", () => {
    const tui: TerminalSummary = { id: "tui", machineId: "m", name: "OMP", createdAt: 1, status: "running", exitCode: null, homeId: "w", unplaced: false };
    const revoked = entry({ state: "revoked", expiresAt: now + HOUR }, 3, tui);
    expect(runPhase(revoked)).toBe("detached");
    expect(leaseWords(revoked, now, vocab).text).toBe(`detached since ${vocab.time(now - 3 * 60_000)}`);
    const cancelled = { ...entry({ state: "cancelled" }, 0), inspection: { renewals: 0, finishedAt: now, exitCode: null, terminalIds: [] } };
    expect(runVerb(cancelled)).toBeNull();
    expect(runVerb(entry({ state: "cancelled" }, 0))).toBe("resume");
  });
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
    const confirmed = answerDial(pending, pending.pending, { model: "anthropic/claude-opus-5", thinking: "medium" }, { model: "anthropic/claude-terra-5", thinking: "medium" },
      "anthropic/claude-terra-5");
    expect(runSaid(run, confirmed, pointed, now, context)).toMatchObject({ value: "opus", text: "running now" });
    expect(runSaid(run, unserved, pointed, now, context)).toMatchObject({ text: "not served here · terra stays" });
  });
});
