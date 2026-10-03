import type { ServiceGap } from "../../domain/routing.ts";
import type { VerificationStatus } from "./verification.ts";

/** Where the profile the controls show comes from: the bundled render-only preview, the shared
 * active catalog, or the shared staged one. */
export type ProfileSource = "starter" | "active" | "draft";
/** The facts `nextLaunchStep` reads. A `WorkbenchModel` satisfies it. */
export type LaunchFacts = {
  configurationCurrent: boolean;
  unsaved: boolean;
  stale: boolean;
  writable: boolean;
  available: boolean;
  launchReady: boolean;
  previewCurrent: boolean;
  profile: { source: ProfileSource } | null;
  localDraft: { source: ProfileSource } | null;
  record: { active?: unknown } | null;
  localReview: object | null;
  skillProblems: readonly string[];
  queries: { setup: { error: string | null } };
  /** `ready`: discovery and benchmark are ready on the destination. */
  verification: { status: VerificationStatus; ready: boolean };
};
export type LaunchBlockerCode =
  | "configuration" | "staged" | "verifying" | "verify-status" | "verify-permissions" | "unsaved" | "read-only" | "conflict"
  | "models" | "unavailable" | "sessions" | "permissions" | "skills";
/** What fixes a blocker: re-observe, open Models, discard the local draft, review native permissions, or open launch options. */
export type LaunchBlockerAction = "refresh" | "models" | "discard" | "permissions" | "options";
export type LaunchBlocker = { code: LaunchBlockerCode; text: string; action?: LaunchBlockerAction };
export type LaunchStep =
  | { step: "verify" | "save" | "review" | "launch"; reason: null }
  | { step: "blocked"; reason: LaunchBlocker };

const blockerText: Readonly<Record<LaunchBlockerCode, string>> = {
  configuration: "Shared choices need a fresh observation.",
  staged: "Review and promote the staged catalog first.",
  verifying: "Verifying models with your accounts…",
  "verify-status": "Verification readiness unavailable on this machine.",
  "verify-permissions": "Review discovery and benchmark permissions to verify models.",
  unsaved: "Save this profile before launch review.",
  "read-only": "Edit access needed.",
  conflict: "Shared profile changed.",
  models: "Review your models.",
  unavailable: "Runtime unavailable · the team is kept.",
  sessions: "Sessions unavailable on this machine.",
  permissions: "Review native session permissions when you're ready to run.",
  skills: "Skill choices need attention.",
};
const blockerAction: Readonly<Partial<Record<LaunchBlockerCode, LaunchBlockerAction>>> = {
  configuration: "refresh", staged: "models", "verify-status": "refresh", "verify-permissions": "permissions", conflict: "discard",
  models: "models", sessions: "permissions", permissions: "permissions", skills: "options",
};
/** Why the `verify` step is next, as the status sentence says it. */
const verifyText: Readonly<Record<Exclude<VerificationStatus, "current" | "verifying">, string>> = {
  unverified: "Verify models with your accounts before saving or launching.",
  "accounts-changed": "Accounts changed since models were verified. Verify again.",
  "omp-changed": "OMP changed since models were verified. Verify again.",
};
function blockerReason(code: LaunchBlockerCode): LaunchBlocker {
  const action = blockerAction[code];
  return action ? { code, text: blockerText[code], action } : { code, text: blockerText[code] };
}
function blocked(code: LaunchBlockerCode): LaunchStep {
  return { step: "blocked", reason: blockerReason(code) };
}
/** Verification preconditions while the verification is not current; `verify` when it may run.
 * A verification writes shared policy and spends through the destination, so it needs what a
 * write and a probe need — not launch permission, skills or a local model review. */
function verifyGate(facts: LaunchFacts): LaunchBlockerCode | "verify" | null {
  if (facts.verification.status === "current") return null;
  if (facts.verification.status === "verifying") return "verifying";
  if (!facts.writable) return "read-only";
  if (facts.stale) return "conflict";
  if (!facts.available) return "unavailable";
  if (facts.queries.setup.error) return "verify-status";
  if (!facts.verification.ready) return "verify-permissions";
  return "verify";
}
/** Launch preconditions once the verification is current: the first unmet one, or null when review/launch may proceed. */
function launchGate(facts: LaunchFacts): LaunchBlockerCode | null {
  if (facts.unsaved || !facts.record?.active) return "unsaved";
  if (!facts.writable) return "read-only";
  if (!facts.available) return "unavailable";
  if (facts.queries.setup.error) return "sessions";
  if (!facts.launchReady) return "permissions";
  if (!facts.localReview) return "models";
  if (facts.skillProblems.length) return "skills";
  return null;
}
/** Save profile preconditions after a current configuration and verification, in the Save
 * control's order; null when saving may proceed. Only a local edit of the active profile offers
 * Save: a staged-catalog preview is promoted in Models, and the bundled preview is saved only by
 * the verification that replaces it. */
export function saveGate(facts: LaunchFacts): LaunchBlockerCode | null {
  if (!facts.localDraft || facts.localDraft.source !== "active") return "unsaved";
  if (!facts.writable) return "read-only";
  if (facts.stale) return "conflict";
  if (!facts.localReview) return "models";
  return null;
}

/**
 * The next step the primary launch control should take, and why it cannot when blocked.
 *
 * Precedence: configuration not current → staged catalog previewed → verification not current
 * → unsaved profile (or no saved active catalog) → read-only → runtime unavailable → sessions
 * unavailable → launch permission not ready → no local model review → skill problems → `launch`
 * when the review is current, else `review`.
 *
 * Verification precedes saving and reviewing: whatever profile is shown, its first save and
 * every launch need a catalog verified against the present accounts and OMP. While it is not
 * current the step is `verify`, or the first failing verification precondition in its order
 * (verifying → read-only → conflict → runtime unavailable → destination status unavailable →
 * discovery/benchmark permission). Below that the precedence is unchanged.
 *
 * The unsaved branch folds in the Save control: `save` when a save of the local edit may proceed
 * (`saveGate`), otherwise the first failing Save precondition (read-only → conflict → models),
 * whose reason replaces the generic sentence. A staged preview is always unsaved, and a sessions
 * error leaves launch permission unobserved.
 *
 * `reason` is non-null exactly when `step` is `blocked`. What is in flight, a waiting charge and an
 * unserved lead are not steps: `actionGate` adds them when it judges whether the step may start.
 */
export function nextLaunchStep(facts: LaunchFacts): LaunchStep {
  if (!facts.configurationCurrent) return blocked("configuration");
  if (facts.profile?.source === "draft") return blocked("staged");
  const verify = verifyGate(facts);
  if (verify === "verify") return { step: "verify", reason: null };
  if (verify !== null) return blocked(verify);
  const gate = launchGate(facts);
  if (gate === null) return { step: facts.previewCurrent ? "launch" : "review", reason: null };
  if (gate !== "unsaved") return blocked(gate);
  const save = saveGate(facts);
  return save === null ? { step: "save", reason: null } : blocked(save);
}

/** The launch status sentence, in `nextLaunchStep`'s precedence without the Save fold. */
export function launchStatusText(facts: LaunchFacts): string {
  if (!facts.configurationCurrent) return blockerText.configuration;
  if (facts.profile?.source === "draft") return blockerText.staged;
  const verify = verifyGate(facts), status = facts.verification.status;
  if (verify === "verify" && status !== "current" && status !== "verifying") return verifyText[status];
  if (verify !== null && verify !== "verify") return blockerText[verify];
  const gate = launchGate(facts);
  return gate ? blockerText[gate] : facts.previewCurrent ? "Ready to open a terminal." : "Review before opening a terminal.";
}

/** What the gate reads beyond the launch facts. */
export type GateFacts = LaunchFacts & {
  /** A step is in flight: a save, review, launch or resume, a chain between its steps, or a verification checking or spending. */
  running: boolean;
  /** The charge a prepared verification shows and waits on, until it is confirmed or cancelled. */
  charge: { readonly requests: number } | null;
  /** A lead no included account serves, when the pool is known (routing.ts `routeService`): the session door refuses it. */
  unservedLead: ServiceGap | null;
  /** The saved session chosen to resume; empty when none is. */
  savedSessionId: string;
  /** The saved team approves plans automatically, which resuming with the team refuses (`omp_resume_plan_unsupported`). */
  planYolo: boolean;
};
/**
 * Every way to start a step, or to change what a step depends on. The verb's steps; resuming a
 * saved session as it was or with the team; opening a running session's terminal; and edits of the
 * team (dials, defaults, a recalled team, discarding), the destination machine, or the account pool.
 */
export type WorkbenchIntent = "verify" | "confirm" | "save" | "review" | "launch" | "resume" | "resume-with-team" | "open"
  | "edit-team" | "edit-machine" | "edit-accounts";
export type GateRefusalCode = LaunchBlockerCode | "running" | "charge" | "no-charge" | "no-account" | "no-session" | "plans" | "verified" | "not-next";
export type GateRefusal = { code: GateRefusalCode; text: string; action?: LaunchBlockerAction; gap?: ServiceGap };
export type GateVerdict = { open: true } | { open: false; refusal: GateRefusal };

const OPEN: GateVerdict = { open: true };
const refusalText: Readonly<Record<Exclude<GateRefusalCode, LaunchBlockerCode | "not-next">, string>> = {
  running: "Wait for the step in progress.",
  charge: "Confirm or cancel the verification charge first.",
  "no-charge": "Nothing to verify through these accounts.",
  "no-account": "No included account serves a provider this team leads on.",
  "no-session": "Choose a saved session to resume.",
  plans: "Resuming with this team cannot approve plans automatically.",
  verified: "Models are verified with the present accounts and OMP.",
};
function refuse(code: Exclude<GateRefusalCode, LaunchBlockerCode | "not-next">, gap?: ServiceGap): GateVerdict {
  return { open: false, refusal: gap ? { code, text: refusalText[code], gap } : { code, text: refusalText[code] } };
}
/** A blocked step's own reason; a step that is next but not this one, said in the status sentence's words. */
function closed(step: LaunchStep, facts: LaunchFacts): GateVerdict {
  return { open: false, refusal: step.step === "blocked" ? step.reason : { code: "not-next", text: launchStatusText(facts) } };
}
function stopped(code: LaunchBlockerCode): GateVerdict {
  return { open: false, refusal: blockerReason(code) };
}

/**
 * THE GATE: whether one action may start now. Every path that starts a step or edits what a step
 * depends on asks it, and a chain asks again before each of its steps with its own step set aside
 * (`running: false`), so a premise that changed mid-flight stops the chain with the refusal.
 *
 * Nothing starts while a step runs, and nothing but its Confirm while a verification charge waits;
 * edits of the team, machine or accounts wait too, so a step never completes on a premise changed
 * under it. Confirm needs a charge of at least one request. The verb's steps follow
 * `nextLaunchStep`, except that a verification is judged by its own preconditions and a save by
 * `saveGate`; review and launch also refuse a lead no included account serves, as the session door
 * does. Resuming needs write access, the machine and a chosen session; with the team, the team must
 * be what a launch would compose. Opening a running terminal and editing the team or machine need
 * nothing more; editing accounts needs write access.
 */
export function actionGate(facts: GateFacts, intent: WorkbenchIntent): GateVerdict {
  if (facts.running) return refuse("running");
  if (intent === "confirm") {
    if (!facts.charge) return { open: false, refusal: { code: "not-next", text: "No verification charge is waiting." } };
    return facts.charge.requests > 0 ? OPEN : refuse("no-charge");
  }
  if (facts.charge) return refuse("charge");
  switch (intent) {
    case "edit-team": case "edit-machine": case "open": return OPEN;
    case "edit-accounts": return facts.writable ? OPEN : stopped("read-only");
    case "verify": {
      if (!facts.configurationCurrent) return stopped("configuration");
      const verify = verifyGate(facts);
      return verify === "verify" ? OPEN : verify === null ? refuse("verified") : stopped(verify);
    }
    case "save": {
      if (!facts.configurationCurrent) return stopped("configuration");
      if (facts.verification.status !== "current") return closed(nextLaunchStep(facts), facts);
      const save = saveGate(facts);
      return save === null ? OPEN : stopped(save);
    }
    case "review": case "launch": {
      const step = nextLaunchStep(facts);
      if (step.step !== intent) return closed(step, facts);
      return facts.unservedLead ? refuse("no-account", facts.unservedLead) : OPEN;
    }
    case "resume": case "resume-with-team": {
      if (!facts.writable) return stopped("read-only");
      if (!facts.available) return stopped("unavailable");
      if (!facts.savedSessionId) return refuse("no-session");
      if (facts.skillProblems.length) return stopped("skills");
      if (intent === "resume") return OPEN;
      if (!facts.configurationCurrent) return stopped("configuration");
      if (facts.verification.status !== "current") return closed(nextLaunchStep(facts), facts);
      if (facts.unsaved || !facts.record?.active) return stopped("unsaved");
      if (!facts.localReview) return stopped("models");
      if (facts.unservedLead) return refuse("no-account", facts.unservedLead);
      return facts.planYolo ? refuse("plans") : OPEN;
    }
  }
}

/** How long a saved team's inputs must hold still before Code reviews its launch on its own. */
export const AUTO_REVIEW_SETTLE_MS = 800;

/**
 * Whether Code should review the launch now, without a press: only where the gate would let the
 * verb review, which needs the saved, verified team and every launch precondition, so an unsaved
 * edit, a starter or a staged catalog never reviews by itself, and nothing does while a step runs
 * or a lead is unserved. Once per review scope (`scope`, against the scope of the last review
 * attempt): a refused review or launch waits for an explicit Review or a changed input.
 */
export function autoReviewDue(facts: GateFacts, scope: number, attempted: number | null): boolean {
  return scope !== attempted && actionGate(facts, "review").open;
}
