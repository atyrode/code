import type { Selection } from "../../domain/contracts.ts";
import type { ServiceGap } from "../../domain/routing.ts";
import type { Configuration, Target } from "../contract.ts";
import type { VerificationStatus } from "./verification.ts";

/** Where the profile the controls show comes from: the bundled render-only preview, the shared
 * active catalog, or the shared staged one. */
export type ProfileSource = "starter" | "active" | "draft";
/** What a frozen local draft was made from: the shared record's revision, whether choices existed, its catalogs and selection. */
export type DraftBase = {
  source: ProfileSource;
  revision: number;
  initialized: boolean;
  catalogDigest: string | null;
  draftDigest: string | null;
  baseSelection: Selection | null;
  /** The bundled model list a first-use draft was derived from. */
  metadataKey: string | null;
};
/** The shared record now: the observed revision and whether choices exist, and the record's catalogs and selection. */
export type SharedBase = {
  revision: number;
  initialized: boolean;
  catalogDigest: string | null;
  draftDigest: string | null;
  selection: Selection | null;
  /** The bundled model list OMP serves now, null while it is not observed. */
  metadataKey: string | null;
};
/**
 * A draft no longer rests on the shared record: the record's selection, catalogs or initialization
 * moved under it, or a first-use draft's bundled list did. A newer revision alone is not a conflict:
 * an account edit, this panel's own or anyone's, writes the record without touching what the draft
 * was made from (`followRecord`).
 */
export function draftStale(draft: DraftBase, shared: SharedBase): boolean {
  return draft.initialized !== shared.initialized ||
    draft.catalogDigest !== shared.catalogDigest || draft.draftDigest !== shared.draftDigest ||
    JSON.stringify(draft.baseSelection) !== JSON.stringify(shared.selection) ||
    (draft.source === "starter" && shared.metadataKey !== null && draft.metadataKey !== shared.metadataKey);
}
/**
 * A draft that still rests on the record moves its base to a newer revision, so a save's exact CAS
 * names the revision it was judged against; a stale draft keeps its base and stays a conflict.
 */
export function followRecord<T extends DraftBase>(draft: T, shared: SharedBase): T {
  return shared.revision > draft.revision && !draftStale(draft, shared) ? { ...draft, revision: shared.revision } : draft;
}
/**
 * A first verification initializes an absent workspace (`from` → `to`) before anything else. When it
 * then stops, the first-use draft follows that exact CAS, as a save's own revision never revokes its
 * acknowledgement. Only a draft of the absent record at `from` follows; a write by anyone else still
 * leaves it stale.
 */
export function followInitialization<T extends DraftBase>(draft: T | null, from: number, to: number): T | null {
  return draft && !draft.initialized && draft.revision === from ? { ...draft, revision: to, initialized: true } : draft;
}
/**
 * A list this panel wrote in Models (staged, put in use or discarded, from revision `from`) is the
 * person's own change, never one made elsewhere. A draft that rested on the record at `from` follows
 * the write while the list it was made on is untouched, as when a list is staged or discarded beside
 * the one in use. Once that list is replaced, the draft gives way (null) and the profile is read from
 * the record: the bundled preview of a workspace without a list gives way to the list staged there,
 * and an edit of the list in use to the list put in use after it. A draft that no longer rested on the
 * record at `from` keeps its base and stays a conflict.
 */
export function followCatalogWrite<T extends DraftBase>(draft: T | null, from: number, written: SharedBase): T | null {
  if (!draft || draft.revision !== from) return draft;
  const replaced = written.catalogDigest !== draft.catalogDigest || (draft.source !== "active" && written.draftDigest !== draft.draftDigest);
  return replaced ? null : { ...draft, revision: written.revision, initialized: written.initialized, draftDigest: written.draftDigest };
}
/** The facts `nextLaunchStep` reads. A `WorkbenchModel` satisfies it. */
export type LaunchFacts = {
  configurationCurrent: boolean;
  unsaved: boolean;
  stale: boolean;
  /** The caller's native caps hold `containers:write`, which is all a shared write is admitted on. */
  writable: boolean;
  /** A container view is mounted beside the panel, whose authoring door is the only way to place a terminal. */
  placeable: boolean;
  available: boolean;
  /**
   * The account observation as a verification would compose its pool: `usable` (or still being read
   * for the first time), `unreadable` (the read failed, is not fresh, or the saved choices no longer
   * resolve), or `none` (a fresh observation with nothing included).
   */
  accounts: "usable" | "unreadable" | "none";
  launchReady: boolean;
  previewCurrent: boolean;
  profile: { source: ProfileSource } | null;
  localDraft: { source: ProfileSource } | null;
  /** The shared record: only whether it holds an active and a staged catalog is read. */
  record: { active?: unknown; draft?: unknown } | null;
  localReview: object | null;
  skillProblems: readonly string[];
  queries: { setup: { error: string | null } };
  /** `ready`: discovery and benchmark are ready on the destination. */
  verification: { status: VerificationStatus; ready: boolean };
};
export type LaunchBlockerCode =
  | "configuration" | "staged" | "verifying" | "verify-status" | "verify-permissions" | "unsaved" | "read-only" | "placement" | "conflict"
  | "accounts" | "no-accounts" | "models" | "unavailable" | "sessions" | "permissions" | "skills";
/** What fixes a blocker: re-observe, open Models, discard the local draft, review native permissions, or open launch options. */
export type LaunchBlockerAction = "refresh" | "models" | "discard" | "permissions" | "options";
export type LaunchBlocker = { code: LaunchBlockerCode; text: string; action?: LaunchBlockerAction };
export type LaunchStep =
  | { step: "verify" | "save" | "review" | "launch"; reason: null }
  | { step: "blocked"; reason: LaunchBlocker };

/** Each blocker in the main view's words: the profile, the model list, the machine; never Code's internal nouns. */
const blockerText: Readonly<Record<LaunchBlockerCode, string>> = {
  configuration: "The workspace profile needs a fresh read.",
  staged: "A staged model list waits in Models.",
  verifying: "Verifying models with your accounts…",
  "verify-status": "Verification readiness is unknown on this machine.",
  "verify-permissions": "Discovery is not enabled on this machine.",
  unsaved: "Save the profile first.",
  "read-only": "Edit access needed.",
  placement: "Open Code beside the workspace canvas to launch or resume.",
  conflict: "The workspace profile changed elsewhere.",
  accounts: "Accounts are not readable.",
  "no-accounts": "No account is included.",
  models: "Review your models.",
  unavailable: "The machine is unavailable; the profile is kept.",
  sessions: "Sessions are unavailable on this machine.",
  permissions: "Sessions are not enabled on this machine.",
  skills: "Skill choices need attention.",
};
const blockerAction: Readonly<Partial<Record<LaunchBlockerCode, LaunchBlockerAction>>> = {
  configuration: "refresh", staged: "models", "verify-status": "refresh", "verify-permissions": "permissions", conflict: "discard",
  accounts: "refresh", models: "models", sessions: "permissions", permissions: "permissions", skills: "options",
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
/** What a verification needs to run, whatever the recorded one's status: the first unmet
 * precondition, or null. A verification writes shared policy and spends through the destination
 * and the saved account pool, so it needs what a write, a probe and that pool need — not a
 * mounted canvas, launch permission, skills or a local model review. A pool that cannot be read
 * or holds no account is refused here rather than by the run it would stop. */
function verifyPreconditions(facts: LaunchFacts): LaunchBlockerCode | null {
  if (!facts.writable) return "read-only";
  if (facts.stale) return "conflict";
  if (!facts.available) return "unavailable";
  if (facts.accounts === "unreadable") return "accounts";
  if (facts.accounts === "none") return "no-accounts";
  if (facts.queries.setup.error) return "verify-status";
  if (!facts.verification.ready) return "verify-permissions";
  return null;
}
/** Verification as the next step: null once it is current, else `verify` when it may run or what blocks it. */
function verifyGate(facts: LaunchFacts): LaunchBlockerCode | "verify" | null {
  if (facts.verification.status === "current") return null;
  if (facts.verification.status === "verifying") return "verifying";
  return verifyPreconditions(facts) ?? "verify";
}
/** Launch preconditions once the verification is current: the first unmet one, or null when review/launch may proceed. */
function launchGate(facts: LaunchFacts): LaunchBlockerCode | null {
  if (facts.unsaved || !facts.record?.active) return "unsaved";
  if (!facts.writable) return "read-only";
  if (!facts.placeable) return "placement";
  if (!facts.available) return "unavailable";
  if (facts.queries.setup.error) return "sessions";
  if (!facts.launchReady) return "permissions";
  if (!facts.localReview) return "models";
  if (facts.skillProblems.length) return "skills";
  return null;
}
/** Save preconditions after a current configuration and verification, in the Save control's order;
 * null when saving may proceed. Only a local edit of the saved team offers Save: a staged model list
 * is promoted in Models, and the bundled preview is saved only by the verification that replaces it.
 * A save needs write access, never a mounted canvas. */
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
 * → unsaved team (or no saved active catalog) → read-only → no canvas to place a terminal →
 * runtime unavailable → sessions unavailable → launch permission not ready → no local model
 * review → skill problems → `launch` when the review is current, else `review`.
 *
 * Verification precedes saving and reviewing: whatever team is shown, its first save and every
 * launch need a catalog verified against the present accounts and OMP. While it is not current
 * the step is `verify`, or the first failing verification precondition in its order (verifying →
 * read-only → conflict → runtime unavailable → accounts unreadable or none included →
 * destination status unavailable → discovery/benchmark permission). Below that the precedence is
 * unchanged.
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
  // Judged on the record, not the shown profile: a staged catalog that seats no team forms no profile, and still waits in Models.
  if (facts.record?.draft && !facts.record.active) return blocked("staged");
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
  if (facts.record?.draft && !facts.record.active) return blockerText.staged;
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
 * team (dials, defaults, a recalled team, discarding), the session options, the destination
 * machine, or the account pool.
 */
export type WorkbenchIntent = "verify" | "confirm" | "save" | "review" | "launch" | "resume" | "resume-with-team" | "open"
  | "edit-team" | "edit-options" | "edit-machine" | "edit-accounts";
export type GateRefusalCode = LaunchBlockerCode | "running" | "charge" | "no-charge" | "no-account" | "no-session" | "plans" | "not-next";
export type GateRefusal = { code: GateRefusalCode; text: string; action?: LaunchBlockerAction; gap?: ServiceGap };
export type GateVerdict = { open: true } | { open: false; refusal: GateRefusal };

const OPEN: GateVerdict = { open: true };
const refusalText: Readonly<Record<Exclude<GateRefusalCode, LaunchBlockerCode | "not-next">, string>> = {
  running: "Wait for the step in progress.",
  charge: "Confirm or cancel the verification charge first.",
  "no-charge": "Nothing to verify through these accounts.",
  "no-account": "No included account serves a provider this profile leads on.",
  "no-session": "Choose a saved session to resume.",
  plans: "Resuming with the current profile cannot approve plans automatically.",
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
 * edits of the team, session options, machine or accounts wait too, so a step never completes on a
 * premise changed under it. Confirm needs a charge of at least one request. The verb's steps follow
 * `nextLaunchStep`, except that a verification is judged by its own preconditions and a save by
 * `saveGate`. A verification that is current may still be renewed on purpose — what OMP or the
 * accounts can reach changes in ways no observation proves — and its charge still waits on its own
 * Confirm. Save, review and launch also refuse a lead no included account serves, as the session
 * door does, so a team the door refuses is never saved on the way to a launch it cannot reach.
 * Resuming needs write access, a canvas to place the terminal, the machine and a chosen session;
 * with the team, the team must be what a launch would compose. Opening a running terminal and
 * editing the team, options or machine need nothing more; editing accounts needs write access.
 */
export function actionGate(facts: GateFacts, intent: WorkbenchIntent): GateVerdict {
  if (facts.running) return refuse("running");
  if (intent === "confirm") {
    if (!facts.charge) return { open: false, refusal: { code: "not-next", text: "No verification charge is waiting." } };
    return facts.charge.requests > 0 ? OPEN : refuse("no-charge");
  }
  if (facts.charge) return refuse("charge");
  switch (intent) {
    case "edit-team": case "edit-options": case "edit-machine": case "open": return OPEN;
    case "edit-accounts": return facts.writable ? OPEN : stopped("read-only");
    case "verify": {
      if (!facts.configurationCurrent) return stopped("configuration");
      if (facts.verification.status === "verifying") return stopped("verifying");
      const blocker = verifyPreconditions(facts);
      return blocker === null ? OPEN : stopped(blocker);
    }
    case "save": {
      if (!facts.configurationCurrent) return stopped("configuration");
      if (facts.verification.status !== "current") return closed(nextLaunchStep(facts), facts);
      const save = saveGate(facts);
      if (save !== null) return stopped(save);
      return facts.unservedLead ? refuse("no-account", facts.unservedLead) : OPEN;
    }
    case "review": case "launch": {
      const step = nextLaunchStep(facts);
      if (step.step !== intent) return closed(step, facts);
      return facts.unservedLead ? refuse("no-account", facts.unservedLead) : OPEN;
    }
    case "resume": case "resume-with-team": {
      if (!facts.writable) return stopped("read-only");
      if (!facts.placeable) return stopped("placement");
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

/**
 * The saved team a resume sends with the session, if any. A plain resume sends none and needs no
 * Code configuration, so a workspace whose Code choices were never initialized still reopens a
 * saved session as it was; a resume with the team sends the saved profile at its revision. Null
 * when a resume with the team has no saved profile to send, which the gate refuses before this.
 */
export function resumeTeam(withTeam: boolean, target: Target, record: Configuration | null): { readonly profile?: { readonly target: Target; readonly expectedRevision: number } } | null {
  if (!withTeam) return {};
  return record ? { profile: { target, expectedRevision: record.revision } } : null;
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
