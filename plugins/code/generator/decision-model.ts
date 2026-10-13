import { orderedFamilies, providerPolicy } from "../../domain/providers.ts";
import type { GateRefusal } from "./launch-step.ts";
import { refusalView, type StatusAction, type StatusFacts, type Vocabulary } from "./statement-model.ts";
import type { VerificationMode } from "./verification.ts";

/*
 * WHAT A PRESS WAITS ON THE PERSON FOR, as one question: a model check's charge to approve, a
 * reviewed session that differs from what the panel showed, a check that changed the profile, or a
 * refused Launch and its fixes. Pure, so which choices each question offers, which comes first and
 * which is the way out are tested apart from the dialog that asks it (decision-dialog.tsx). Only a
 * press the person made asks: a check the panel runs on its own never does.
 */

/** What a choice does: approve or cancel the waiting charge, take the launch's own press, leave the question, or run a fix. */
export type DecisionDo =
  | { readonly kind: "approve" }
  | { readonly kind: "cancel" }
  | { readonly kind: "launch" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "fix"; readonly action: Extract<StatusAction, { kind: "fix" }> };
export type DecisionChoice = { readonly label: string; readonly does: DecisionDo };
export type Decision = {
  readonly kind: "charge" | "differs" | "narrowed" | "refused";
  readonly title: string;
  /** What is asked and why, a plain sentence each. */
  readonly text: readonly string[];
  /** What the question is about, one fact per line: what a charge spends, each setting that moves. */
  readonly items: readonly string[];
  /** The choices in reading order. The first is the next action; the last is the way out, which Esc and the backdrop take, and which never spends or launches. */
  readonly choices: readonly DecisionChoice[];
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * A model check's charge, waiting on the person: what it spends in all and per provider family (in
 * the panel's family order: GPT, Claude, DeepSeek), why a launch needs it, and whether approving it
 * once lets later checks run without asking (only for a person who keeps checks). A charge of nothing
 * asks nothing: it says so, offers the accounts, and its way out cancels the check. Every choice but
 * Approve cancels the check before it acts.
 */
export function chargeDecision(charge: { readonly requests: number; readonly providers: readonly { readonly provider: string; readonly requests: number }[] },
  mode: Exclude<VerificationMode, "background">, keepsChecks: boolean, vocab: Vocabulary): Decision {
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
export function differsDecision(differs: readonly string[]): Decision {
  return { kind: "differs", title: "What will run differs", text: ["The session Code is about to start is not quite what the panel shows."], items: differs,
    choices: [{ label: "Launch it", does: { kind: "launch" } }, { label: "Not now", does: { kind: "dismiss" } }] };
}

/** A Launch press whose model check narrowed the profile to what answered: the settings it moved, and both ways on. */
export function narrowedDecision(settings: readonly string[]): Decision {
  return { kind: "narrowed", title: "The model check changed your profile", text: ["Some models didn't answer, so the check changed these settings."], items: settings,
    choices: [{ label: "Launch", does: { kind: "launch" } }, { label: "Not now", does: { kind: "dismiss" } }] };
}

/** A refused Launch press: what stops it, why, the fixes the launch line offers for it, and Close. */
export function refusalDecision(refusal: GateRefusal, facts: StatusFacts, vocab: Vocabulary): Decision {
  const view = refusalView(refusal, facts, vocab);
  return { kind: "refused", title: view.title, text: view.why ? [view.why] : [], items: [],
    choices: [...view.fixes.map(action => ({ label: action.label, does: { kind: "fix", action } }) as const), { label: "Close", does: { kind: "dismiss" } }] };
}
