import { describe, expect, test } from "bun:test";
import type { MachineSummary } from "@manifold/protocol";
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
  causalRedline, commitKind, estimateReadouts, fixView, grounded, launchLine, launchReadout, machineSlot, movesText, projectionOf, reviewMatches, statementSlots, verbView,
  type SlotOption, type StatementContext, type StatusFacts, type StatusLine, type VerbFacts, type Vocabulary,
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
const known = { served: null, nowMs: now } as const;
const vocab: Vocabulary = {
  family: family => ({ openai: "GPT", anthropic: "Claude" })[family] ?? family,
  time: at => `T+${Math.round((at - now) / HOUR)}h`,
};
function context(selection: Selection, pool: readonly QuotaPool[]): StatementContext {
  return { ...known, catalog, selection, review: reviewCatalog(catalog, selection, now), pools: pool, machines: [], rosterError: false, machineId: "studio", omp: null };
}
/** A value as the settings show it; each test sets only what it is about. */
function slotOption(changes: Partial<SlotOption>): SlotOption {
  return { value: "", label: "", mark: null, current: false, on: false, online: null, available: true, reason: null, selection: null, review: null,
    redline: null, note: "", meaning: "", quota: null, ...changes };
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

  test("the settings never mark the current value, and mark the causal lane among the lanes", () => {
    const slots = statementSlots(context(team(), claudeBlocked), vocab);
    const lane = slots.lane.options;
    expect(lane.find(option => option.current)?.redline).toBeNull();
    expect(lane.find(option => option.value === "gpt-led")?.redline).not.toBeNull();
    expect(slots.thinking.options.every(option => option.redline === null)).toBe(true);
  });
});

describe("the settings' values", () => {
  test("values run low to high from left to right, with a tier the catalog lacks refused in place", () => {
    const slots = statementSlots(context(team({ capability: 2, thinking: "medium" }), pools()), vocab);
    expect(slots.tier.options.map(option => [option.value, option.available])).toEqual([["fast", true], ["normal", true], ["smart", true], ["elite", false]]);
    expect(slots.thinking.options.map(option => option.value)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(slots.lane.options.map(option => option.value)).toEqual(["gpt-only", "gpt-led", "mixed", "claude-led", "claude-only"]);
  });

  test("an extra says what its present position means and what turning it would do, never the same sentence twice", () => {
    const fallbacks = statementSlots(context(team({ fallback: true }), pools()), vocab).extras.options.find(option => option.value === "fallbacks")!;
    expect(fallbacks.on).toBe(true);
    expect(fallbacks.meaning).toMatch(/falls back/);
    expect(fallbacks.note).toMatch(/waits/);
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

describe("the cost and speed readouts", () => {
  test("speed is unmeasured, never the index's middle level, while a lead model has no measured throughput", () => {
    const unmeasured = compileCatalog({ schemaVersion: 1,
      models: catalog.models.map(entry => ({ ...entry, thinkingLevels: [...entry.thinkingLevels], tokensPerSecond: null, timeToFirstTokenMs: null })) });
    const shown = reviewCatalog(unmeasured, team(), now);
    expect(shown.estimates.speedScore).toBe(3);
    expect(estimateReadouts(unmeasured, shown).speed).toEqual({ level: null, word: "unmeasured" });
    expect(estimateReadouts(catalog, review()).speed.level).not.toBeNull();
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

  test("what the review shows unlike the projection is said role by role, grouped where roles go alike", () => {
    expect(movesText(catalog, review(), shown)).toBe("reviewer, security-reviewer o3 → a3");
    expect(movesText(catalog, review(), review({ thinking: "high" }))).toContain("high → x-high");
    expect(movesText(catalog, shown, shown)).toBe("");
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

describe("the launch line, in precedence", () => {
  const charge = { requests: 19, providers: [{ provider: "openai-codex", requests: 12 }, { provider: "anthropic", requests: 7 }] };
  const ready = verbView({ step: { step: "launch", reason: null }, verdict: { open: true }, busy: false, inFlight: null, chaining: false, unsaved: false,
    draft: false, phase: null, verification: "current", stranded: false, grounded: true, placeable: true, launching: false });
  const facts = (changes: Partial<StatusFacts> = {}): StatusFacts => ({
    verb: ready, phase: null, progress: null, charge: null, inFlight: null, busy: false, chaining: false, launching: false,
    machine: { name: "Studio", online: true, revoked: false }, machineChosen: true, rosterUnread: false, otherMachine: null, message: null, outcome: null,
    stop: null, fix: null, differs: null, laneFix: null, nobodyServes: false, listFailure: "none", ompMissing: false, accountsProblem: null,
    configurationFailed: false, ...changes,
  });
  const said = (changes: Partial<StatusFacts> = {}): StatusLine => launchLine(facts(changes), vocab)!;
  const fixes = (line: StatusLine) => line.actions.map(action => action.kind === "fix" ? action.fix.kind : action.kind);
  const keys = (line: StatusLine) => line.actions.map(action => action.kind === "fix" ? action.key : action.kind);

  test("at rest it says nothing: the label, the routing and the usage say the rest", () => {
    expect(launchLine(facts(), vocab)).toBeNull();
    const verify = verbView({ step: { step: "verify", reason: null }, verdict: { open: true }, busy: false, inFlight: null, chaining: false, unsaved: false,
      draft: false, phase: null, verification: "unverified", stranded: false, grounded: true, placeable: true, launching: false });
    expect(launchLine(facts({ verb: verify }), vocab)).toBeNull();
  });

  test("a waiting charge outranks the last outcome, and offers Confirm only for a charge of at least one request", () => {
    const line = said({ phase: "charge", charge, outcome: { kind: "launched", machine: "Studio", dials: "run" } });
    expect(line.parts.map(part => part.text).join(" ")).toContain("19");
    expect(line.actions).toContainEqual({ kind: "confirm", requests: 19 });
    expect(fixes(said({ phase: "charge", charge: { requests: 0, providers: [] } }))).toEqual(["cancel"]);
  });

  test("a refusal outranks the outcome of the last step, and read-only is said in neutral grey", () => {
    const refused = { ...ready, state: "refused" as const, refusal: { code: "read-only" as const, text: "Edit access needed." } };
    expect(said({ verb: refused, outcome: { kind: "launched", machine: "Studio", dials: "run" } }).parts[0]).toEqual({ text: "Read-only workspace", tone: "neutral" });
  });

  test("an agent launch offers its dials in Sessions; one without says why, and where Setup can enable them, offers it", () => {
    const run = said({ outcome: { kind: "launched", machine: "Studio", dials: "run" } });
    expect(run.parts).toEqual([{ text: "Launched on Studio", tone: "done" }]);
    expect(run.actions).toEqual([{ kind: "fix", key: "dials", label: "dials", fix: { kind: "open", place: "sessions" } }]);
    const plans = said({ outcome: { kind: "launched", machine: "Studio", dials: "plans" } });
    expect(plans.parts.map(part => part.text)).toEqual(["Launched on Studio", "no live dials: auto plans are on"]);
    expect(plans.actions).toEqual([]);
    const harness = said({ outcome: { kind: "launched", machine: "Studio", dials: "harness" } });
    expect(harness.parts.map(part => part.text)).toEqual(["Launched on Studio", "no live dials: not enabled on Studio"]);
    expect(harness.actions).toEqual([{ kind: "fix", key: "dials-setup", label: "Enable in Setup", fix: { kind: "open", place: "setup" } }]);
  });

  test("a machine list that cannot be read is said as such, never as a machine being offline, and offers no other machine", () => {
    const unavailable = { ...ready, state: "refused" as const, refusal: { code: "unavailable" as const, text: "" } };
    const unread = said({ verb: unavailable, rosterUnread: true, otherMachine: { id: "build", name: "Build box" } });
    expect(unread.parts[0]!.text).not.toMatch(/offline/);
    expect(fixes(unread)).toEqual(["refresh"]);
    // Online by the list's own word, yet unavailable: never "offline".
    expect(said({ verb: unavailable }).parts[0]!.text).not.toMatch(/offline/);
  });

  test("roles waiting on two pools name both, each with its own reopening, never one pool with the other's time", () => {
    const claude = pools({ claudeBlockedUntil: now + 4 * HOUR }).find(pool => pool.provider === "anthropic")!;
    const codex = { ...pools().find(pool => pool.provider === "openai-codex")!, verdict: { kind: "maxed" as const, until: now + HOUR } };
    expect(said({ stop: { roles: ["reviewer", "default"], waits: [claude, codex] } }).parts[0]).toEqual({ text: "Claude blocked until T+4h · GPT maxed until T+1h", tone: "attention" });
  });

  test("an offline destination offers another machine; an unserved lead offers the nearest served lane and its accounts", () => {
    const unavailable = { ...ready, state: "refused" as const, refusal: { code: "unavailable" as const, text: "Runtime unavailable." } };
    const offline = said({ verb: unavailable, machine: { name: "Laptop", online: false, revoked: false }, otherMachine: { id: "studio", name: "Studio" } });
    expect(offline.actions).toEqual([{ kind: "fix", key: "machine", label: "Use Studio", fix: { kind: "machine", machineId: "studio" } }]);
    const unserved = { ...ready, state: "refused" as const, refusal: { code: "no-account" as const, text: "", gap: { provider: "anthropic", family: "anthropic", roles: ["reviewer"] } } };
    const lane = slotOption({ label: "GPT only", selection: team(), review: review() });
    expect(fixes(said({ verb: unserved, laneFix: lane }))).toEqual(["team", "open"]);
  });

  test("roles with no route say so with the fix that routes them, which commits through a team fix", () => {
    const stop = { roles: ["reviewer", "security-reviewer"], waits: [] };
    const fix = { label: "GPT only", result: "keeps all 12 on Codex", selection: team(), review: review() };
    const line = said({ stop, fix });
    expect(line.parts.some(part => part.tone === "attention")).toBe(true);
    expect(line.actions).toEqual([{ kind: "fix", key: "rescue", label: "GPT only keeps all 12 on Codex", fix: { kind: "team", selection: fix.selection, review: fix.review } }]);
    expect(said({ stop }).actions).toEqual([]);
  });

  test("a machine without OMP is said as such, with a machine where OMP answers; readiness unknown is kept for reads that failed", () => {
    const status = { ...ready, state: "refused" as const, refusal: { code: "verify-status" as const, text: "" } };
    const missing = said({ verb: status, ompMissing: true, machine: { name: "Code isolated destination", online: true, revoked: false }, otherMachine: { id: "dev-01", name: "dev-01" } });
    expect(missing.parts[0]!.text).toBe("OMP isn't on Code isolated destination");
    expect(missing.actions).toEqual([{ kind: "fix", key: "machine", label: "Use dev-01", fix: { kind: "machine", machineId: "dev-01" } }]);
    expect(said({ verb: status }).parts[0]!.text).toMatch(/^Verification readiness unknown on Studio/);
    const sessions = { ...ready, state: "refused" as const, refusal: { code: "sessions" as const, text: "" } };
    expect(said({ verb: sessions, ompMissing: true }).parts[0]!.text).toBe("OMP isn't on Studio");
  });

  test("the machine is chosen from the roster alone, so a profile that cannot be formed still has somewhere to run", () => {
    const machines = [{ id: "studio", name: "Studio", online: true }, { id: "laptop", name: "Laptop", online: false }] as unknown as MachineSummary[];
    // No catalog, selection or review: a first use whose bundled model list failed.
    const slot = machineSlot({ machines, rosterError: false, machineId: "studio", omp: new Map([["studio", "ok"]]) });
    expect(slot.options.map(option => [option.value, option.current, option.available, option.reason])).toEqual([
      ["studio", true, true, null], ["laptop", false, false, "offline"]]);
  });

  test("unusable accounts are said as what failed: the read, its age, or saved choices that no longer match; a failed profile read is the profile's", () => {
    const accounts = { ...ready, state: "refused" as const, refusal: { code: "accounts" as const, text: "" } };
    expect(said({ verb: accounts, accountsProblem: { kind: "failed", text: "OMP refused the step." } }).parts[0]!.text).toBe("Accounts unreadable: OMP refused the step");
    expect(said({ verb: accounts, accountsProblem: { kind: "stale" } }).parts[0]!.text).toBe("Account list not current");
    const choices = said({ verb: accounts, accountsProblem: { kind: "choices" } });
    expect(choices.parts[0]!.text).toBe("Saved account choices no longer match your accounts");
    expect(fixes(choices)).toEqual(["open"]);
    const profile = { ...ready, state: "refused" as const, refusal: { code: "configuration" as const, text: "" } };
    expect(said({ verb: profile, configurationFailed: true }).parts[0]!.text).toBe("Workspace profile unreadable");
  });

  test("a step in flight is said whatever else holds", () => {
    const refused = { ...ready, state: "refused" as const, refusal: { code: "read-only" as const, text: "Edit access needed." } };
    expect(said({ busy: true, inFlight: "launch", verb: refused }).parts).toEqual([{ text: "Opening a terminal on Studio", tone: "busy" }]);
  });

  test("a failed model list is stated with its fixes whatever the verb says, and the verb's own fix stays a press away", () => {
    const listFixes = ["list-retry", "list-models"];
    // A refused verb with no profile to form: the refusal and its fix, then the list failure with its fixes.
    const unreadable = { ...ready, state: "refused" as const, refusal: { code: "accounts" as const, text: "" } };
    const refused = said({ verb: unreadable, listFailure: "instead" });
    expect(refused.parts[0]!.tone).toBe("attention");
    expect(refused.parts.at(-1)!.tone).toBe("warn");
    expect(keys(refused)).toEqual(["accounts-read", ...listFixes]);
    // Routes beside the failure with roles that have no route: the rescue stays beside its stop.
    const fix = { label: "GPT only", result: "keeps all 12 on Codex", selection: team(), review: review() };
    expect(keys(said({ stop: { roles: ["reviewer"], waits: [] }, fix, listFailure: "beside" }))).toEqual(["rescue", ...listFixes]);
    // At rest the failure is the whole line.
    expect(keys(said({ listFailure: "beside" }))).toEqual(listFixes);
  });
});

describe("what the launch says while it is pointed", () => {
  const verb = (changes: Partial<VerbFacts> = {}) => verbView({ step: { step: "save", reason: null }, verdict: { open: true }, busy: false, inFlight: null, chaining: false,
    unsaved: true, draft: true, phase: null, verification: "current", stranded: false, grounded: true, placeable: true, launching: false, ...changes });

  test("a press that saves says what it changes on the workspace profile; a refused one says only its reason", () => {
    const edits = [{ word: "thinking" as const, from: "medium", to: "high" }];
    expect(launchReadout({ verb: verb(), edits, reviewed: null, dials: null, grounded: true, launchStatus: "Ready." }, vocab))
      .toEqual({ text: "1 change to the profile: thinking medium → high", warn: false });
    const refusal: GateRefusal = { code: "read-only", text: "Edit access needed." };
    expect(launchReadout({ verb: verb({ verdict: { open: false, refusal } }), edits, reviewed: null, dials: null, grounded: true, launchStatus: "Ready." }, vocab))
      .toEqual({ text: "Edit access needed.", warn: true });
  });

  test("a reviewed launch names the pool it reviewed; an unreviewed one on readings not current says the review shows it", () => {
    const launch = verbView({ step: { step: "launch", reason: null }, verdict: { open: true }, busy: false, inFlight: null, chaining: false, unsaved: false,
      draft: false, phase: null, verification: "current", stranded: false, grounded: true, placeable: true, launching: false });
    expect(launchReadout({ verb: launch, edits: [], reviewed: { machine: "Studio", pool: [{ family: "openai", count: 2 }] }, dials: null, grounded: true, launchStatus: "Ready." }, vocab).text)
      .toBe("reviewed on Studio: GPT 2");
    // Pointed, the launch says whether it runs with live dials, or why not.
    expect(launchReadout({ verb: launch, edits: [], reviewed: { machine: "Studio", pool: [] }, dials: "run", grounded: true, launchStatus: "Ready." }, vocab).text)
      .toBe("reviewed on Studio · live dials in Sessions");
    expect(launchReadout({ verb: launch, edits: [], reviewed: { machine: "Studio", pool: [] }, dials: "options", grounded: true, launchStatus: "Ready." }, vocab).text)
      .toBe("reviewed on Studio · no live dials: session options are set");
    const review = verbView({ step: { step: "review", reason: null }, verdict: { open: true }, busy: false, inFlight: null, chaining: false, unsaved: false,
      draft: false, phase: null, verification: "current", stranded: false, grounded: false, placeable: true, launching: false });
    expect(launchReadout({ verb: review, edits: [], reviewed: null, dials: null, grounded: false, launchStatus: "Ready." }, vocab).text).toBe("the review shows the pool before anything runs");
  });
});
