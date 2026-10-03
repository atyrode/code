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
  unavailable: "Runtime unavailable · profile and task are retained.",
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
function blocked(code: LaunchBlockerCode): LaunchStep {
  const action = blockerAction[code];
  return { step: "blocked", reason: action ? { code, text: blockerText[code], action } : { code, text: blockerText[code] } };
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
 * For every model the hook produces, `review`/`launch` are returned exactly when the
 * Review/Launch control is enabled apart from `busy` (`canReview`): a staged preview is always
 * unsaved, and a sessions error leaves launch permission unobserved. The unsaved branch folds in
 * the Save control: `save` when it would be enabled (`canSave`), otherwise the first failing Save
 * precondition (read-only → conflict → models), whose reason replaces the generic sentence.
 *
 * `reason` is non-null exactly when `step` is `blocked`. `busy` is deliberately not a step:
 * callers disable the control while busy and label the step in flight themselves.
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

/** How long a saved team's inputs must hold still before Code reviews its launch on its own. */
export const AUTO_REVIEW_SETTLE_MS = 800;
/** What the caller knows beyond the facts: something in flight, a routed family with no included account, and review scopes. */
export type AutoReviewContext = {
  busy: boolean;
  uncovered: boolean;
  /** The current review scope (`WorkbenchModel.reviewScope`). */
  scope: number;
  /** The scope of the last review or launch attempt, explicit or automatic; null before any. */
  attempted: number | null;
};

/**
 * Whether Code should review the launch now, without a press: only where the primary would offer
 * `review`, which needs the saved, verified team and every launch precondition, so an unsaved edit,
 * a starter or a staged catalog never reviews by itself. Never while anything is in flight or a
 * routed family has no included account, and once per review scope: a refused review or launch
 * waits for an explicit Review or a changed input, as a refused launch must.
 */
export function autoReviewDue(facts: LaunchFacts, context: AutoReviewContext): boolean {
  return !context.busy && !context.uncovered && context.scope !== context.attempted && nextLaunchStep(facts).step === "review";
}
