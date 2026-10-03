import { describe, expect, test } from "bun:test";
import type { AccountsObservation, PermittedUsageSnapshot } from "@atyrode/manifold-omp";
import { initialAccountChoices } from "../domain/accounts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import type { CatalogModel, Selection } from "../domain/contracts.ts";
import { quotaPools, type QuotaPool } from "../domain/quota.ts";
import { reviewCatalog, type Review } from "../domain/routing.ts";
import { projectUsage } from "../domain/usage.ts";
import { optionConsequence, rescue } from "../code/generator/consequences.ts";
import type { GateRefusal, LaunchStep } from "../code/generator/launch-step.ts";
import {
  causalRedline, commitKind, fixView, grounded, lastLaunchTeam, projectionOf, reviewMatches, statementSlots, statusLines, stepOption, verbView,
  type Slot, type SlotOption, type StatementContext, type StatusFacts, type StatusLine, type VerbFacts, type Vocabulary,
} from "../code/generator/statement-model.ts";

const scope = "machine/broker-scope";
const now = Date.UTC(2026, 9, 3, 12);
const HOUR = 3_600_000;

function model(key: string, provider: string, tier: CatalogModel["tier"]): CatalogModel {
  return {
    key, provider, tier, id: `native-${key}`, api: "test-api", quotaBucket: null, inputCostPerMillion: 4, outputCostPerMillion: 12,
    tokensPerSecond: 30, timeToFirstTokenMs: 100, contextWindow: 200_000, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], images: true,
  };
}
const catalog = compileCatalog({ schemaVersion: 1, models: [
  model("o1", "openai-codex", 1), model("o2", "openai-codex", 2), model("o3", "openai-codex", 3),
  model("a1", "anthropic", 1), model("a2", "anthropic", 2), model("a3", "anthropic", 3),
] });
const gptOnly: Selection["lane"] = { kind: "provider", family: "openai", blend: "only" };
const gptLed: Selection["lane"] = { kind: "provider", family: "openai", blend: "led" };
const claudeOnly: Selection["lane"] = { kind: "provider", family: "anthropic", blend: "only" };
const team = (changes: Partial<Selection> = {}): Selection => ({
  lane: gptOnly, capability: 2, thinking: "medium", advisor: "off", spark: false, priority: false, prewalk: false, planYolo: false, fallback: false, budget: "any", ...changes,
});
const review = (changes: Partial<Selection> = {}): Review => reviewCatalog(catalog, team(changes), now);

/** Pools from a real projection: one Codex and one Claude subscription; Claude blocked or Codex busy when asked; current unless `stale`. */
function pools(options: { claudeBlockedUntil?: number; codexUsed?: number; stale?: boolean } = {}): QuotaPool[] {
  const people = [["openai-codex", 1, "codex@example.test"], ["anthropic", 2, "claude@example.test"]] as const;
  const observation: AccountsObservation = { scope, observedAt: now, status: "fresh", accounts: people.map(([provider, credentialId, identityKey]) => ({
    reference: { kind: "identity" as const, scope, provider, identityKey }, credentialId, identityKey, type: "oauth" as const, email: identityKey, disabled: false,
    blocks: provider === "anthropic" && options.claudeBlockedUntil !== undefined ? [{ scope: "", until: options.claudeBlockedUntil }] : [],
  })) };
  const reports: PermittedUsageSnapshot["accounts"] = people.map(([provider, credentialId, identityKey]) => ({
    provider, credentialId, identityKey, observedAt: now, status: "reported" as const,
    windows: [{ windowId: "5h", tier: null, usedFraction: provider === "openai-codex" ? options.codexUsed ?? 0.1 : 0.1, quotaStatus: null,
      resetsAt: now + HOUR, durationMs: 5 * HOUR, observedAt: now }],
  }));
  const view = projectUsage({ scope, observedAt: now, accounts: reports }, observation, initialAccountChoices(), now, { maxAgeMs: 300_000, refreshStatus: "succeeded" });
  return quotaPools(catalog, { view, current: !options.stale, nowMs: now });
}
const known = { served: null, starter: false, nowMs: now } as const;
const vocab: Vocabulary = {
  family: family => ({ openai: "GPT", anthropic: "Claude" })[family] ?? family,
  time: at => `T+${Math.round((at - now) / HOUR)}h`,
};
function context(selection: Selection, pool: readonly QuotaPool[], lastLaunch: Selection | null = null): StatementContext {
  return { ...known, catalog, selection, review: reviewCatalog(catalog, selection, now), pools: pool, lastLaunch, saved: null, machines: [], rosterError: false, machineId: "studio" };
}
/** A drum option as the line shows it; each test sets only what it is about. */
function slotOption(changes: Partial<SlotOption>): SlotOption {
  return { value: "", label: "", mark: null, current: false, on: false, available: true, reason: null, selection: null, review: null,
    moves: [], redline: null, last: false, note: "", quota: null, ...changes };
}

describe("the redline marks only the option that causes the strain", () => {
  const claudeBlocked = pools({ claudeBlockedUntil: now + 2 * HOUR });

  test("an option that leaves a role with no route that has one now carries it", () => {
    const fromGptOnly = review();
    const led = optionConsequence(catalog, fromGptOnly, "lane", "gpt-led", { ...known, pools: claudeBlocked });
    expect(led?.redline).not.toBeNull();
    expect(causalRedline(catalog, fromGptOnly, led, claudeBlocked)).toMatchObject({ reason: "blocked", roles: ["reviewer", "security-reviewer"] });
  });

  test("an option that keeps roles on a pool the team already waits on carries none, though it leads there", () => {
    const stranded = review({ lane: gptLed });
    const thinking = optionConsequence(catalog, stranded, "thinking", "high", { ...known, pools: claudeBlocked });
    expect(thinking?.redline?.reason).toBe("blocked");
    expect(causalRedline(catalog, stranded, thinking, claudeBlocked)).toBeNull();
  });

  test("a tight pool marks only the option that newly leads on it", () => {
    const codexTight = pools({ codexUsed: 0.85 });
    const fromClaude = review({ lane: claudeOnly });
    expect(causalRedline(catalog, fromClaude, optionConsequence(catalog, fromClaude, "lane", "gpt-only", { ...known, pools: codexTight }), codexTight))
      .toMatchObject({ reason: "tight" });
    const onCodex = review();
    expect(causalRedline(catalog, onCodex, optionConsequence(catalog, onCodex, "thinking", "high", { ...known, pools: codexTight }), codexTight)).toBeNull();
  });

  test("the drum never marks the value on the line, and marks the causal lane among the lanes", () => {
    const slots = statementSlots(context(team(), claudeBlocked), vocab);
    const lane = slots.lane.options;
    expect(lane.find(option => option.current)?.redline).toBeNull();
    expect(lane.find(option => option.value === "gpt-led")?.redline).not.toBeNull();
    expect(slots.thinking.options.every(option => option.redline === null)).toBe(true);
  });
});

describe("the words' drums, steps and the last launch", () => {
  test("up is more: the strongest tier and thinking sit at the top, and a step up passes over a tier the catalog lacks", () => {
    const slots = statementSlots(context(team({ capability: 2, thinking: "medium" }), pools()), vocab);
    expect(slots.tier.options.map(option => [option.value, option.available])).toEqual([["elite", false], ["smart", true], ["normal", true], ["fast", true]]);
    expect(stepOption(statementSlots(context(team({ capability: 3 }), pools()), vocab).tier, true)).toBeNull();
    expect(stepOption(slots.tier, true)?.value).toBe("smart");
    expect(stepOption(slots.thinking, false)?.value).toBe("low");
  });

  test("a step passes over options that cannot be chosen and stops at the end of the drum", () => {
    const option = (value: string, available: boolean, current = false) => slotOption({ value, label: value, available, current });
    const slot: Slot = { word: "tier", current: 2, label: "normal", changed: false, edited: false, options: [option("elite", true), option("smart", false), option("normal", true, true)] };
    expect(stepOption(slot, true)?.value).toBe("elite");
    expect(stepOption({ ...slot, current: 0, options: [option("elite", true, true), option("smart", false)] }, false)).toBeNull();
  });

  test("the last launch's value is tagged, and Backspace returns exactly that word", () => {
    const current = team({ thinking: "medium", capability: 3 });
    const last = team({ thinking: "high", capability: 3 });
    const shown = context(current, pools(), last);
    const slots = statementSlots(shown, vocab);
    expect(slots.thinking.changed).toBe(true);
    expect(slots.thinking.options.find(option => option.last)?.value).toBe("high");
    expect(slots.tier.changed).toBe(false);
    expect(lastLaunchTeam("thinking", slots.thinking, shown)).toEqual({ ...current, thinking: "high" });
    expect(lastLaunchTeam("tier", slots.tier, shown)).toBeNull();
  });

  test("Backspace on extras turns every switch back as the last launch had it, and only those", () => {
    const current = team({ fallback: true, prewalk: true });
    const last = team({ spark: false, fallback: false, prewalk: true, priority: true });
    const shown = context(current, pools(), last);
    expect(lastLaunchTeam("extras", statementSlots(shown, vocab).extras, shown)).toEqual({ ...current, fallback: false, priority: true });
  });
});

describe("where a commit lands", () => {
  test("back on the saved team, an edit of the active profile is discarded rather than kept as an identical draft", () => {
    const saved = team();
    expect(commitKind(saved, team({ thinking: "high" }), saved, "active")).toBe("discard");
    expect(commitKind(team({ thinking: "low" }), team({ thinking: "high" }), saved, "active")).toBe("update");
    // A starter's draft is not the saved team's edit, so it is never dropped this way.
    expect(commitKind(saved, team({ thinking: "high" }), saved, "starter")).toBe("update");
    expect(commitKind(team(), team(), saved, "active")).toBe("none");
  });
});

describe("the verb names the model's step", () => {
  const open = { open: true } as const;
  const facts = (step: LaunchStep["step"], changes: Partial<VerbFacts> = {}): VerbFacts => ({
    step: step === "blocked" ? { step, reason: { code: "read-only", text: "Edit access needed." } } : { step, reason: null },
    verdict: open, busy: false, inFlight: null, chaining: false, unsaved: false, draft: false, phase: null, verification: "current",
    stranded: false, grounded: true, placeable: true, launching: false, ...changes,
  });

  test("an edited team saves first, and continues to the launch only when the readings are present", () => {
    expect(verbView(facts("save", { unsaved: true, draft: true }))).toMatchObject({ label: "Save & launch", state: "ready", saves: true, launches: true });
    expect(verbView(facts("save", { unsaved: true, draft: true, grounded: false }))).toMatchObject({ label: "Save & review", saves: true, launches: false });
  });

  test("a team with a role that has no route launches anyway; the gate, not quota, decides whether it may", () => {
    expect(verbView(facts("launch", { stranded: true }))).toMatchObject({ label: "Launch anyway", state: "ready" });
    const refusal: GateRefusal = { code: "no-account", text: "No included account serves a provider this team leads on." };
    expect(verbView(facts("review", { verdict: { open: false, refusal } }))).toMatchObject({ label: "Review", state: "refused", refusal });
  });

  test("Launch anyway is never the label of a save the door refuses for its lead", () => {
    const refusal: GateRefusal = { code: "no-account", text: "No included account serves a provider this team leads on." };
    const refused = verbView(facts("save", { unsaved: true, draft: true, stranded: true, verdict: { open: false, refusal } }));
    expect(refused).toMatchObject({ state: "refused", refusal });
    expect(refused.label).not.toBe("Launch anyway");
  });

  test("with no canvas to place a terminal, an edited team only saves; a staged model list is opened, not refused", () => {
    expect(verbView(facts("save", { unsaved: true, draft: true, placeable: false }))).toMatchObject({ label: "Save", state: "ready", saves: true, launches: false });
    const staged = { step: "blocked", reason: { code: "staged", text: "A staged model list waits in Models." } } as const;
    expect(verbView(facts("blocked", { step: staged, verdict: { open: false, refusal: staged.reason } }))).toMatchObject({ state: "ready", opens: "models" });
  });

  test("while a charge waits the verb waits too, and while a step runs it names the step", () => {
    expect(verbView(facts("verify", { phase: "charge" }))).toMatchObject({ label: "Verify models", state: "waiting" });
    expect(verbView(facts("launch", { busy: true, inFlight: "launch" }))).toMatchObject({ label: "Launching…", state: "busy" });
    expect(verbView(facts("save", { chaining: true }))).toMatchObject({ label: "Reviewing…", state: "busy" });
  });
});

describe("Save & launch stops at a review that differs from the projection", () => {
  const shown = review({ lane: gptLed });
  const pool = { "openai-codex": [{}], anthropic: [{}] };

  test("it goes on only for the same leads through the same providers' accounts", () => {
    const projected = projectionOf(shown, new Set(["openai-codex", "anthropic"]));
    expect(reviewMatches(projected, { review: shown, accountPool: pool })).toBe(true);
    expect(reviewMatches(projected, { review: review({ lane: gptOnly }), accountPool: pool })).toBe(false);
    expect(reviewMatches(projected, { review: shown, accountPool: { "openai-codex": [{}], anthropic: [] } })).toBe(false);
    expect(reviewMatches(projectionOf(shown, null), { review: shown, accountPool: pool })).toBe(false);
  });

  test("a projection rests on present readings only when every lead's pool is judged fresh and the pool is known", () => {
    expect(grounded(catalog, shown.routes, pools(), new Set(["openai-codex", "anthropic"]))).toBe(true);
    expect(grounded(catalog, shown.routes, pools({ stale: true }), new Set(["openai-codex", "anthropic"]))).toBe(false);
    expect(grounded(catalog, shown.routes, pools(), null)).toBe(false);
  });
});

describe("the fix for roles with no route", () => {
  test("GPT-led with Claude blocked and no fallbacks: GPT only gives all 12 a route", () => {
    const claudeBlocked = pools({ claudeBlockedUntil: now + 2 * HOUR });
    const stranded = review({ lane: gptLed });
    const fix = fixView(rescue(catalog, stranded, claudeBlocked, known)!, catalog, claudeBlocked, vocab);
    expect(fix).toMatchObject({ label: "GPT only", result: `gives all ${stranded.routes.length} a route` });
    expect(fix?.selection.lane).toEqual(gptOnly);
  });

  test("a fix onto a pool whose reading is not current says its availability is unknown", () => {
    const claudeBlocked = pools({ claudeBlockedUntil: now + 2 * HOUR });
    // Codex read long ago: the fix still routes every role there, but no one measured its room.
    const codexStale = claudeBlocked.map(pool => pool.provider === "openai-codex" ? { ...pool, verdict: { kind: "stale" as const, ageMs: HOUR } } : pool);
    const fix = fixView(rescue(catalog, review({ lane: gptLed }), codexStale, known)!, catalog, codexStale, vocab);
    expect(fix?.result).toMatch(/· availability unknown$/);
  });
});

describe("the status lines, in precedence", () => {
  const charge = { requests: 19, providers: [{ provider: "openai-codex", requests: 12 }, { provider: "anthropic", requests: 7 }] };
  const ready = verbView({ step: { step: "launch", reason: null }, verdict: { open: true }, busy: false, inFlight: null, chaining: false, unsaved: false,
    draft: false, phase: null, verification: "current", stranded: false, grounded: true, placeable: true, launching: false });
  const facts = (changes: Partial<StatusFacts> = {}): StatusFacts => ({
    verb: ready, phase: null, progress: null, charge: null, inFlight: null, busy: false, chaining: false, launching: false,
    machine: { name: "Studio", online: true, revoked: false }, machineChosen: true, rosterUnread: false, otherMachine: null, message: null, outcome: null,
    launchStatus: "Ready to open a terminal.", stop: null, fix: null, team: { counts: [{ family: "openai", count: 12 }], fallsBack: [], tight: [], unread: false },
    edits: [], reviewed: null, differs: null, laneFix: null, nobodyServes: false, listFailure: "none", pointed: null, moves: null, ...changes,
  });
  const actions = (line: { actions: readonly { kind: string }[] }) => line.actions.map(action => action.kind);

  test("a waiting charge is never written over, and offers Confirm only for a charge of at least one request", () => {
    const pointed = { kind: "team", label: "Recent team 2", sentence: "Raises plan", quota: null } as const;
    const [first, second] = statusLines(facts({ phase: "charge", charge, pointed, outcome: { kind: "launched", machine: "Studio" } }), vocab);
    expect(first.parts.map(part => part.text).join(" ")).toContain("19");
    expect(second.actions).toContainEqual({ kind: "confirm", requests: 19 });
    expect(actions(statusLines(facts({ phase: "charge", charge: { requests: 0, providers: [] } }), vocab)[1])).toEqual(["cancel"]);
  });

  test("a refusal outranks the outcome of the last step, and read-only is said in neutral grey", () => {
    const refused = { ...ready, state: "refused" as const, refusal: { code: "read-only" as const, text: "Edit access needed." } };
    const [first] = statusLines(facts({ verb: refused, outcome: { kind: "launched", machine: "Studio" } }), vocab);
    expect(first.parts).toEqual([{ text: "Read-only workspace", tone: "neutral" }]);
  });

  test("a machine list that cannot be read is said as such, never as a machine being offline, and offers no other machine", () => {
    const unavailable = { ...ready, state: "refused" as const, refusal: { code: "unavailable" as const, text: "" } };
    const lines = statusLines(facts({ verb: unavailable, rosterUnread: true, otherMachine: { id: "build", name: "Build box" } }), vocab);
    expect(lines[0].parts[0]!.text).not.toMatch(/offline/);
    expect(lines[1].actions.map(action => action.kind === "fix" ? action.fix.kind : action.kind)).toEqual(["refresh"]);
    // Online by the list's own word, yet unavailable: never "offline".
    expect(statusLines(facts({ verb: unavailable }), vocab)[0].parts[0]!.text).not.toMatch(/offline/);
  });

  test("roles waiting on two pools name both, each with its own reopening, never one pool with the other's time", () => {
    const claude = pools({ claudeBlockedUntil: now + 4 * HOUR }).find(pool => pool.provider === "anthropic")!;
    const codex = { ...pools().find(pool => pool.provider === "openai-codex")!, verdict: { kind: "maxed" as const, until: now + HOUR } };
    const lines = statusLines(facts({ stop: { roles: ["reviewer", "default"], waits: [claude, codex] } }), vocab);
    expect(lines[0].parts[0]).toEqual({ text: "Claude blocked until T+4h · GPT maxed until T+1h", tone: "attention" });
  });

  test("an offline destination offers another machine; an unserved lead offers the nearest served lane and its accounts", () => {
    const unavailable = { ...ready, state: "refused" as const, refusal: { code: "unavailable" as const, text: "Runtime unavailable." } };
    const offline = statusLines(facts({ verb: unavailable, machine: { name: "Laptop", online: false, revoked: false }, otherMachine: { id: "studio", name: "Studio" } }), vocab);
    expect(offline[1].actions).toEqual([{ kind: "fix", key: "machine", label: "use Studio", fix: { kind: "machine", machineId: "studio" } }]);
    const unserved = { ...ready, state: "refused" as const, refusal: { code: "no-account" as const, text: "", gap: { provider: "anthropic", family: "anthropic", roles: ["reviewer"] } } };
    const lane = slotOption({ label: "GPT only", selection: team(), review: review() });
    const fixes = statusLines(facts({ verb: unserved, laneFix: lane }), vocab)[1].actions;
    expect(fixes.map(action => action.kind === "fix" ? action.fix.kind : action.kind)).toEqual(["team", "open"]);
  });

  test("roles with no route say so with the fix that routes them, which commits through a team fix", () => {
    const stop = { roles: ["reviewer", "security-reviewer"], waits: [] };
    const fix = { label: "GPT only", result: "keeps all 12 on Codex", selection: team(), review: review() };
    const [first, second] = statusLines(facts({ stop, fix }), vocab);
    expect(first.parts.some(part => part.tone === "attention")).toBe(true);
    expect(second.actions).toEqual([{ kind: "fix", key: "rescue", label: "GPT only keeps all 12 on Codex", fix: { kind: "team", selection: fix.selection, review: fix.review } }]);
    expect(statusLines(facts({ stop }), vocab)[1].actions).toEqual([]);
  });

  test("a press that saves while roles have no route says what it changes, and revert stays beside the rescue", () => {
    const saving = verbView({ step: { step: "save", reason: null }, verdict: { open: true }, busy: false, inFlight: null, chaining: false, unsaved: true,
      draft: true, phase: null, verification: "current", stranded: true, grounded: true, placeable: true, launching: false });
    const stop = { roles: ["advisor"], waits: [] };
    const fix = { label: "GPT only", result: "puts advisor on GPT", selection: team(), review: review() };
    const edits = [{ word: "thinking" as const, from: "medium", to: "high" }];
    const [first, second] = statusLines(facts({ verb: saving, stop, fix, edits }), vocab);
    expect(first.parts.some(part => part.text.includes("medium → high"))).toBe(true);
    expect(second.actions.map(action => action.kind === "fix" ? action.key : action.kind)).toEqual(["rescue", "revert"]);
    // With no move that routes every role, revert is still a press away.
    expect(statusLines(facts({ verb: saving, stop, edits }), vocab)[1].actions.map(action => action.kind === "fix" ? action.key : action.kind)).toEqual(["revert"]);
  });

  test("a pointed option writes its consequence over the lines; a step in flight is not written over", () => {
    const option = slotOption({ value: "high", label: "high", note: "Raises default" });
    expect(statusLines(facts({ pointed: { kind: "option", word: "thinking", option } }), vocab)[0].parts[0]).toEqual({ text: "Thinking high", tone: "strong" });
    expect(statusLines(facts({ busy: true, inFlight: "launch", pointed: { kind: "option", word: "thinking", option } }), vocab)[0].parts)
      .toEqual([{ text: "Opening a terminal on Studio", tone: "busy" }]);
  });

  test("a failed model list is stated with its fixes whatever the verb says, and the verb's own fix stays a press away", () => {
    const keys = (line: StatusLine) => line.actions.map(action => action.kind === "fix" ? action.key : action.kind);
    const listFixes = ["list-retry", "list-models"];
    // A refused verb with no team to seat: the refusal and its fix, and the list failure with its fixes.
    const unreadable = { ...ready, state: "refused" as const, refusal: { code: "accounts" as const, text: "" } };
    const [refusal, failure] = statusLines(facts({ verb: unreadable, listFailure: "instead" }), vocab);
    expect(refusal.parts[0]!.tone).toBe("attention");
    expect(keys(refusal)).toEqual(["refresh"]);
    expect(failure.parts[0]!.tone).toBe("warn");
    expect(keys(failure)).toEqual(listFixes);
    // A team beside the failure with roles that have no route: the rescue moves up beside its stop.
    const fix = { label: "GPT only", result: "keeps all 12 on Codex", selection: team(), review: review() };
    const [stop, beside] = statusLines(facts({ stop: { roles: ["reviewer"], waits: [] }, fix, listFailure: "beside" }), vocab);
    expect(keys(stop)).toEqual(["rescue"]);
    expect(keys(beside)).toEqual(listFixes);
    // Beside the verification still to do, as at rest.
    const verify = verbView({ step: { step: "verify", reason: null }, verdict: { open: true }, busy: false, inFlight: null, chaining: false, unsaved: false,
      draft: false, phase: null, verification: "unverified", stranded: false, grounded: true, placeable: true, launching: false });
    expect(keys(statusLines(facts({ verb: verify, listFailure: "beside" }), vocab)[1])).toEqual(listFixes);
    expect(keys(statusLines(facts({ listFailure: "beside" }), vocab)[1])).toEqual(listFixes);
  });
});
