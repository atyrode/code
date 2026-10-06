/*
 * An account switch in the accounts view, as rules: when it can act, what a press does, and how
 * long a press stands. A switch that takes a press makes its edit or refuses it with a reason; it
 * is never open to the eye while a press on it would be dropped.
 */

/** A press waiting on its edit, and the read after it. */
export const SAVING = "Saving the last change.";
/** An inclusion is never made on an account list that is not current. */
export const NOT_CURRENT = "The account list is not current.";
export const CREDENTIAL_DISABLED = "Credential disabled.";

/**
 * A press, from the moment it is made until the saved choices answer it. The switch shows it as
 * made and stays locked all that time, through the guarded edit and through the read after it, so
 * a second press never meets choices the panel has not read yet: its edit would carry a revision
 * the first one has already moved past.
 */
export type SwitchPress = {
  /** The pressed account's row. */
  readonly key: string;
  /** What the press asked for: included or not. */
  readonly enabled: boolean;
  /** The saved choices' revision the edit was made at. */
  readonly revision: number;
  /** The edit has been in flight. */
  readonly started: boolean;
};

/** Where the edit stands now: in flight or not, why it failed or was refused, and the revision of the saved choices read. */
export type SwitchSaving = { readonly pending: boolean; readonly failure: string | null; readonly revision: number | null };

/** The press as its edit moves on; null once it is answered: the edit never started, failed or was refused, or a newer read of the saved choices came. */
export function settlePress(press: SwitchPress | null, saving: SwitchSaving): SwitchPress | null {
  if (press === null) return null;
  if (saving.pending) return press.started ? press : { ...press, started: true };
  if (!press.started || saving.failure !== null) return null;
  return saving.revision === null || saving.revision > press.revision ? null : press;
}

/** What locks every switch, strongest first. */
export type SwitchLockFacts = {
  /** Why the model can make no account edit now, in its words; null when it can. */
  readonly refusal: string | null;
  /** An edit is in flight, or a press waits for the read after it. */
  readonly saving: boolean;
  /** The pool the saved choices follow; hand edits belong to the manual pool. */
  readonly preset: string | null;
  /** The account list is history: stale, unread or failed. */
  readonly historical: boolean;
};

/** Why the switches cannot act now, or null when they can. */
export function switchLock(facts: SwitchLockFacts): string | null {
  if (facts.refusal !== null) return facts.refusal;
  if (facts.saving) return SAVING;
  if (facts.preset !== null) return `Set by the ${facts.preset} pool; choose the manual pool under Manage accounts to edit.`;
  return facts.historical ? NOT_CURRENT : null;
}

/** What a press on a switch does: its edit, or a refusal with the reason to show and announce. */
export type PressOutcome = { readonly kind: "change"; readonly enabled: boolean } | { readonly kind: "refuse"; readonly reason: string };

export function pressSwitch(row: { readonly included: boolean; readonly disabled: boolean }, lock: string | null): PressOutcome {
  if (row.disabled) return { kind: "refuse", reason: CREDENTIAL_DISABLED };
  if (lock !== null) return { kind: "refuse", reason: lock };
  return { kind: "change", enabled: !row.included };
}
