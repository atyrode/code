import { orderedFamilies, providerPolicy } from "../../domain/providers.ts";
import type { RefusalView, StatusAction, Vocabulary } from "./statement-model.ts";
import type { VerificationMode } from "./verification.ts";

/*
 * WHAT THE PANEL WAITS ON THE PERSON FOR, as one question: a model check's charge to approve, a
 * reviewed session that differs from what the panel showed, a check that changed the profile, a
 * refused Launch and its fixes, or, on a person's first open, whether to take the tutorial. Pure, so
 * which question is asked, which choices it offers, which is the way out and what answering does are
 * tested apart from the dialog that asks it (decision-dialog.tsx). Only a press the person made asks
 * about a check: a check the panel runs on its own never does.
 */

/** What a choice does: approve or cancel the waiting charge, take the launch's own press, start the tutorial, leave the question, or run a fix. */
export type DecisionDo =
  | { readonly kind: "approve" }
  | { readonly kind: "cancel" }
  | { readonly kind: "launch" }
  | { readonly kind: "tour" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "fix"; readonly action: Extract<StatusAction, { kind: "fix" }> };
export type DecisionChoice = { readonly label: string; readonly does: DecisionDo };
export type Decision = {
  readonly kind: "charge" | "differs" | "narrowed" | "refused" | "tutorial";
  readonly title: string;
  /** What is asked and why, a plain sentence each. */
  readonly text: readonly string[];
  /** What the question is about, one fact per line: what a charge spends, each setting that moves. */
  readonly items: readonly string[];
  /** The choices in reading order. The first is the next action; the last is the way out, which Esc and the backdrop take, and which never spends or launches. */
  readonly choices: readonly DecisionChoice[];
};
/** The questions a press waits on, which `decisionFor` asks and `answer` answers; the tutorial's offer is the workbench's own. */
export type PressDecision = Decision & { readonly kind: Exclude<Decision["kind"], "tutorial"> };
/** A check's charge as it waits: the requests in all and per provider. */
export type ChargeFacts = { readonly requests: number; readonly providers: readonly { readonly provider: string; readonly requests: number }[] };

/** What the panel weighs to ask a question (generator-pane.tsx). */
export type DecisionFacts = {
  /** The charge of the check in flight while it waits, and who started that check. */
  readonly charge: ChargeFacts | null;
  readonly mode: VerificationMode | null;
  /** The person keeps checks and their approval (`readChecks().keeps`). */
  readonly keepsChecks: boolean;
  /** A press may launch now (the verb is ready): a held review and a narrowed stop are asked only then. */
  readonly ready: boolean;
  /** What a held review shows unlike what the panel showed, while it stands. */
  readonly differs: readonly string[] | null;
  /** The settings a check moved before a Launch press went on, while that stop stands. */
  readonly narrowed: readonly string[] | null;
  /** A refused Launch press, as the launch line says its refusal, while that refusal stands unchanged. */
  readonly refused: RefusalView | null;
};

/**
 * The one question the panel asks now, in precedence: a check's charge (from the launch, Models or a
 * struck lane, never from a check the panel runs on its own), a review that differs, a check that
 * changed the profile, then a refused press; null when nothing waits on the person.
 */
export function decisionFor(facts: DecisionFacts, vocab: Vocabulary): PressDecision | null {
  if (facts.charge && facts.mode !== null && facts.mode !== "background") return chargeDecision(facts.charge, facts.mode, facts.keepsChecks, vocab);
  if (facts.differs && facts.ready) return differsDecision(facts.differs);
  if (facts.narrowed && facts.ready) return narrowedDecision(facts.narrowed);
  if (facts.refused) return refusedDecision(facts.refused);
  return null;
}

/** What answering does, in order: approve the charge, cancel the check, drop the held review, end the question, the launch's press, a fix. */
export type DecisionEffect =
  | { readonly kind: "approve" }
  | { readonly kind: "cancel" }
  | { readonly kind: "drop-held" }
  | { readonly kind: "end" }
  | { readonly kind: "launch" }
  | { readonly kind: "fix"; readonly action: Extract<StatusAction, { kind: "fix" }> };
/**
 * What answering `decision` with `choice` does. Only Approve approves a charge; every other answer to
 * a charge cancels the check first, so nothing is spent, then runs its fix. A held review goes on
 * only with the launch's press, and Not now drops it, so the next press reviews again. A narrowed
 * stop and a refused press end their question, then run what was chosen.
 */
export function answer(decision: PressDecision, choice: DecisionChoice): DecisionEffect[] {
  const does = choice.does;
  const then: DecisionEffect[] = does.kind === "launch" ? [{ kind: "launch" }] : does.kind === "fix" ? [{ kind: "fix", action: does.action }] : [];
  switch (decision.kind) {
    case "charge": return does.kind === "approve" ? [{ kind: "approve" }] : [{ kind: "cancel" }, ...then];
    case "differs": return does.kind === "dismiss" ? [{ kind: "drop-held" }] : then;
    case "narrowed": case "refused": return [{ kind: "end" }, ...then];
  }
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * A model check's charge, waiting on the person: what it spends in all and per provider family (in
 * the panel's family order: GPT, Claude, DeepSeek), why a launch needs it, and whether approving it
 * once lets later checks run without asking (only for a person who keeps checks). A charge of nothing
 * asks nothing: it says so, offers the accounts, and its way out cancels the check.
 */
function chargeDecision(charge: ChargeFacts, mode: Exclude<VerificationMode, "background">, keepsChecks: boolean, vocab: Vocabulary): PressDecision {
  if (charge.requests === 0) {
    return { kind: "charge", title: "Nothing to check", text: ["None of the models your included accounts offer can be checked."], items: [],
      choices: [{ label: "Show accounts", does: { kind: "fix", action: { kind: "fix", key: "accounts", label: "Show accounts", fix: { kind: "open", place: "accounts" } } } },
        { label: "Close", does: { kind: "cancel" } }] };
  }
  const spent = new Map<string, number>();
  for (const entry of charge.providers) {
    const family = providerPolicy(entry.provider).family;
    if (entry.requests > 0) spent.set(family, (spent.get(family) ?? 0) + entry.requests);
  }
  const spend = orderedFamilies(spent.keys()).map(family => `${vocab.family(family)} ${spent.get(family)}`).join(" · ");
  return {
    kind: "charge",
    title: mode === "launch" ? "Check your models first" : "Check your models",
    text: [
      `${mode === "launch" ? "Launch needs to know" : "Code finds out"} which models your accounts can use${mode === "launch" ? ", so Code sends" : " by sending"} each one a tiny request.`,
      ...keepsChecks ? ["You approve this once. Later checks run on their own."] : [],
    ],
    items: [`${plural(charge.requests, "tiny request")}${spend ? `: ${spend}` : ""}`],
    choices: [{ label: mode === "launch" ? "Approve and launch" : "Approve", does: { kind: "approve" } }, { label: "Cancel", does: { kind: "cancel" } }],
  };
}

/** A Launch press whose session review differs from what the panel showed: what differs, and both ways on. */
function differsDecision(differs: readonly string[]): PressDecision {
  return { kind: "differs", title: "What will run differs", text: ["The session Code is about to start is not quite what the panel shows."], items: differs,
    choices: [{ label: "Launch it", does: { kind: "launch" } }, { label: "Not now", does: { kind: "dismiss" } }] };
}

/** A Launch press whose model check narrowed the profile to what answered: the settings it moved, and both ways on. */
function narrowedDecision(settings: readonly string[]): PressDecision {
  return { kind: "narrowed", title: "The model check changed your profile", text: ["Some models didn't answer, so the check changed these settings."], items: settings,
    choices: [{ label: "Launch", does: { kind: "launch" } }, { label: "Not now", does: { kind: "dismiss" } }] };
}

/** A refused Launch press: what stops it, why, the fixes the launch line offers for that refusal, and Close. */
function refusedDecision(view: RefusalView): PressDecision {
  return { kind: "refused", title: view.title, text: view.why ? [view.why] : [], items: [],
    choices: [...view.fixes.map(action => ({ label: action.label, does: { kind: "fix", action } }) as const), { label: "Close", does: { kind: "dismiss" } }] };
}

/** A person's first open: what Code is, and whether to take the short tutorial now. Skip is the way out; More replays it. */
export function tutorialOffer(): Decision {
  return { kind: "tutorial", title: "Welcome to Code", text: ["Code starts OMP coding sessions with the models you choose. A short tour shows where everything is."],
    items: [], choices: [{ label: "Take the tour", does: { kind: "tour" } }, { label: "Skip", does: { kind: "dismiss" } }] };
}
