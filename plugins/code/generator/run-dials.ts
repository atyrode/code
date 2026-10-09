import { z } from "zod";
import { ThinkingSelectorSchema } from "@atyrode/manifold-omp";
import { CODE_PLUGIN_ID } from "../contract.ts";
import type { Dials } from "../workflow.ts";

/*
 * A running Run's two live dials, model and thinking, as this browser has turned them. Each press is
 * one `controlRun`, which answers with the session's dials, refuses, or is not answered within its
 * 20 s. The model shown is the Run's live `Run.model`, which OMP's harness moves with its session
 * whatever turned it, a dial, the operator in the TUI or another tab (atyrode/manifold#1078). The
 * answer this browser kept bridges a confirmed dial until the next read; after it, the answer stays
 * only while it names the model the Run reports, as the one word on its thinking, since `Run.model`
 * carries none once the harness reports. One change is in flight per Run at a time; a press while one
 * waits is queued, the latest replacing any earlier one, and sent once the answer lands.
 */

export type DialField = "model" | "thinking";
/** A change asked of a Run: a `provider/id` model, or a thinking level. */
export type DialChange = { readonly field: DialField; readonly value: string };
/** What the Run's last press came to, which its said line words. */
export type DialOutcome =
  | { readonly kind: "confirmed"; readonly change: DialChange; readonly clamped: string | null }
  | { readonly kind: "unserved"; readonly change: DialChange }
  | { readonly kind: "lacks"; readonly change: DialChange }
  | { readonly kind: "forbidden" }
  | { readonly kind: "gone" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly words: string };
export type RunDialState = {
  /** The session's dials as this browser last heard them from `controlRun`; null before any answer. */
  readonly reply: Dials | null;
  /** The change sent and not yet answered. */
  readonly pending: DialChange | null;
  /** The latest change pressed while another waited, sent once that one is answered. */
  readonly queued: DialChange | null;
  /** The change whose answer did not come within the door's 20 s: it may still apply, and can be sent again. */
  readonly unconfirmed: DialChange | null;
  /** Models the session said it does not serve, struck from then on. */
  readonly unserved: readonly string[];
  readonly outcome: DialOutcome | null;
  /** The door refuses this caller's dials outright (`omp_run_control_forbidden`), so every press is refused here. */
  readonly forbidden: boolean;
};
export const NO_DIALS: RunDialState = { reply: null, pending: null, queued: null, unconfirmed: null, unserved: [], outcome: null, forbidden: false };

/** The dials a Run shows: the answer this browser kept, else the Run's live model, whose thinking only the launch's record names. */
export function shownDials(state: RunDialState, live: Dials): Dials {
  return state.reply ?? live;
}

/**
 * A read of the Run judges the answer kept before it, and the live `Run.model` wins: an answer for
 * another model is stale (the TUI, another tab or a later change moved the session), so it is
 * dropped with the confirmation it said. One for the model the Run reports stays. A Run that
 * reports no model contradicts nothing.
 */
export function readDials(state: RunDialState, live: Dials): RunDialState {
  if (state.reply === null || live.model === null || state.reply.model === live.model) return state;
  return { ...state, reply: null, outcome: state.outcome?.kind === "confirmed" ? null : state.outcome };
}

/**
 * A press on a dial word: whether it is sent, and the state it leaves. The word already shown is
 * no change unless its last sending went unanswered; a model the session refused before, or a
 * thinking level the shown model lacks (`lacks`), is refused here, as is any press while the door
 * refuses this caller. A press while another change waits is queued, replacing an earlier queued one.
 */
export function pressDial(state: RunDialState, change: DialChange, shown: Dials, lacks: (level: string) => boolean): { readonly state: RunDialState; readonly send: boolean } {
  if (state.forbidden) return { state: { ...state, outcome: { kind: "forbidden" } }, send: false };
  if (change.field === "model" && state.unserved.includes(change.value)) return { state: { ...state, outcome: { kind: "unserved", change } }, send: false };
  if (change.field === "thinking" && lacks(change.value)) return { state: { ...state, outcome: { kind: "lacks", change } }, send: false };
  if (state.pending) {
    const same = state.pending.field === change.field && state.pending.value === change.value;
    return { state: { ...state, queued: same ? null : change, outcome: null }, send: false };
  }
  const again = state.unconfirmed?.field === change.field && state.unconfirmed.value === change.value;
  if (!again && shown[change.field] === change.value) return { state: { ...state, queued: null }, send: false };
  return { state: { ...state, pending: change, queued: null, unconfirmed: null, outcome: null }, send: true };
}

/**
 * The session's answer to the change in flight. A thinking level the session applied other than the
 * one asked for, or that a model change moved, is clamped: the model's own levels decided it.
 */
export function answerDial(state: RunDialState, change: DialChange, dials: Dials, before: Dials): RunDialState {
  const asked = change.field === "thinking" ? change.value : before.thinking;
  const clamped = dials.thinking !== null && dials.thinking !== asked ? dials.thinking : null;
  return { ...state, reply: dials, pending: null, unconfirmed: null, outcome: { kind: "confirmed", change, clamped } };
}

/** The door's refusal of the change in flight, by its token. A refusal that ends the dials drops the queued change too. */
export function refuseDial(state: RunDialState, change: DialChange, token: string | null, words: string): RunDialState {
  const settled = { ...state, pending: null };
  switch (token) {
    case "omp_model_unavailable":
      return { ...settled, unserved: [...new Set([...state.unserved, change.value])], outcome: { kind: "unserved", change } };
    case "omp_run_control_unconfirmed": return { ...settled, unconfirmed: change, outcome: null };
    case "omp_run_control_forbidden": return { ...settled, queued: null, forbidden: true, outcome: { kind: "forbidden" } };
    case "omp_session_unavailable": return { ...settled, queued: null, outcome: { kind: "gone" } };
    case "omp_run_control_unsupported": return { ...settled, queued: null, outcome: { kind: "unsupported" } };
    default: return { ...settled, outcome: { kind: "failed", words } };
  }
}

/** A confirmation's words give way after a moment; a refusal stays until the next press. */
export function settleDial(state: RunDialState): RunDialState {
  return state.outcome?.kind === "confirmed" ? { ...state, outcome: null } : state;
}

// ---------------------------------------------------------------- the answers this browser heard, kept per workspace

/** As many Runs' answers as a browser keeps: more than run at once. */
const KEPT_ANSWERS = 32;
const KeptAnswersSchema = z.array(z.tuple([z.string().min(1).max(128),
  z.strictObject({ model: z.string().max(240).nullable(), thinking: ThinkingSelectorSchema.nullable() })])).max(KEPT_ANSWERS);
export type AnswerStorage = Pick<Storage, "getItem" | "setItem">;

export function keptAnswersKey(principalId: string, containerId: string): string {
  return `${CODE_PLUGIN_ID}.run-dials:${JSON.stringify([principalId, containerId])}`;
}
/** The answers kept for a workspace, newest last; unreadable or malformed storage reads as none. */
export function readKeptAnswers(storage: AnswerStorage | null, key: string): ReadonlyMap<string, Dials> {
  let text: string | null = null;
  try { text = storage?.getItem(key) ?? null; } catch { return new Map(); }
  if (!text) return new Map();
  try {
    const parsed = KeptAnswersSchema.safeParse(JSON.parse(text));
    return parsed.success ? new Map(parsed.data) : new Map();
  } catch { return new Map(); }
}
/** Keep a Run's latest answer, dropping the oldest beyond the limit; a refused write keeps this page's answers only. */
export function keepAnswer(storage: AnswerStorage | null, key: string, runId: string, dials: Dials): void {
  const kept = [...readKeptAnswers(storage, key)].filter(([id]) => id !== runId);
  try { storage?.setItem(key, JSON.stringify([...kept, [runId, dials]].slice(-KEPT_ANSWERS))); } catch { /* A full or refused store keeps this page's answers only. */ }
}
/** Forget a Run's kept answer a read contradicted, unless another tab has since kept one for `live`, the model the Run reports. */
export function forgetAnswer(storage: AnswerStorage | null, key: string, runId: string, live: string): void {
  const kept = readKeptAnswers(storage, key);
  if (!kept.has(runId) || kept.get(runId)!.model === live) return;
  try { storage?.setItem(key, JSON.stringify([...kept].filter(([id]) => id !== runId))); } catch { /* A refused store forgets on this page only. */ }
}
