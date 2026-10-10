import { z } from "zod";
import { ThinkingSelectorSchema } from "@atyrode/manifold-omp";
import { CODE_PLUGIN_ID } from "../contract.ts";
import type { Dials } from "../workflow.ts";

/*
 * A running Run's two live dials, model and thinking, as this browser has turned them. Each press is
 * one `controlRun`, which answers with the session's dials, refuses, or is not answered within its
 * 20 s. The model shown is the Run's live `Run.model`, which OMP's harness moves with its session
 * whatever turned it, a dial, the operator in the TUI or another tab (atyrode/manifold#1078), as
 * `provider` and `id` alone. The answer this browser kept is the one word on the thinking. It bridges
 * a confirmed dial until a read names its model, since a read served before the session reports the
 * change can land after its answer, and so can the report of an earlier answer (`readDials`). One
 * change is in flight per Run at a time; a press while one waits is queued, the latest replacing any
 * earlier one, and sent once the answer lands.
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
  /** The session's dials as this browser last heard them from `controlRun`; null before any answer, or once a read contradicted it. */
  readonly reply: Dials | null;
  /**
   * The models a read may still name before it shows the kept answer's, oldest first, are the Run's model in the read in
   * hand when the answer landed or, while an earlier answer still bridged, that answer's bridge and its own model, whose
   * report may land first. A read naming the answer's model empties them.
   */
  readonly priors: readonly string[];
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
export const NO_DIALS: RunDialState = { reply: null, priors: [], pending: null, queued: null, unconfirmed: null, unserved: [], outcome: null, forbidden: false };

/** The dials a Run shows: the answer this browser kept, else the Run's live model, whose thinking only the launch's record names. */
export function shownDials(state: RunDialState, live: Dials): Dials {
  return state.reply ?? live;
}

/**
 * A read of the Run judges what this browser heard before it, and the live `Run.model` wins. A read
 * naming the model of a change left unanswered shows that it applied. One naming the kept answer's
 * model ends its bridge. One naming a model of its bridge (`priors`) may have been served before the
 * session reported the change, so it contradicts nothing, and the models before that one are past.
 * Neither does one naming the model of the change in flight, whose report can land before its
 * answer. Any other model was switched elsewhere (the TUI, another tab): the answer is stale and
 * dropped with the confirmation it said. A Run that reports no model contradicts nothing.
 */
export function readDials(state: RunDialState, live: Dials): RunDialState {
  const model = live.model;
  if (model === null) return state;
  const read = state.unconfirmed?.field === "model" && state.unconfirmed.value === model ? { ...state, unconfirmed: null } : state;
  if (read.reply === null) return read;
  if (read.reply.model === model) return read.priors.length === 0 ? read : { ...read, priors: [] };
  const at = read.priors.indexOf(model);
  if (at >= 0) return at === 0 ? read : { ...read, priors: read.priors.slice(at) };
  if (read.pending?.field === "model" && read.pending.value === model) return read;
  return { ...read, reply: null, priors: [], outcome: read.outcome?.kind === "confirmed" ? null : read.outcome };
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
 * A bridge holds at most this many models: its first, which every read names while the session
 * serves models its harness never confirms (OpenRouter's), and the latest.
 */
const PRIORS = 8;
/**
 * The session's answer to the change in flight, landing while the read in hand names `read` as the
 * Run's model. The reads still to come may name that model, unless it is already the answer's. While
 * an earlier answer still bridges, though, the read in hand may predate that answer's report, so they
 * may name any model of its bridge or that answer's own model instead (`priors`). That holds even when
 * the read in hand names the model this answer returns to, a model of that bridge; only one naming a
 * model the bridge never held shows this answer's report already landed. A thinking level the
 * session applied other than the one asked for, or that a model change moved, is clamped: the
 * model's own levels decided it.
 */
export function answerDial(state: RunDialState, change: DialChange, dials: Dials, before: Dials, read: string | null): RunDialState {
  const asked = change.field === "thinking" ? change.value : before.thinking;
  const clamped = dials.thinking !== null && dials.thinking !== asked ? dials.thinking : null;
  const reported = read !== null && read === dials.model && !state.priors.includes(read);
  // An answer's model is never in its own bridge, so the bridge it extends holds no model twice.
  const bridged = reported ? [] : state.reply !== null && state.priors.length > 0 ? [...state.priors, state.reply.model] : [read];
  const priors = bridged.filter((model): model is string => model !== null && model !== dials.model);
  return { ...state, reply: dials, priors: priors.length > PRIORS ? [priors[0]!, ...priors.slice(1 - PRIORS)] : priors, pending: null, unconfirmed: null,
    outcome: { kind: "confirmed", change, clamped } };
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
const KeptAnswersSchema = z.array(z.tuple([z.string().min(1).max(128), z.strictObject({ model: z.string().max(240).nullable(),
  thinking: ThinkingSelectorSchema.nullable(), priors: z.array(z.string().min(1).max(240)).max(PRIORS).optional() })])).max(KEPT_ANSWERS);
export type AnswerStorage = Pick<Storage, "getItem" | "setItem">;
/** This browser keeps a Run's answer as the session's dials and, while it has one, its bridge (`RunDialState`). */
export type KeptAnswer = { readonly reply: Dials; readonly priors: readonly string[] };

export function keptAnswersKey(principalId: string, containerId: string): string {
  return `${CODE_PLUGIN_ID}.run-dials:${JSON.stringify([principalId, containerId])}`;
}
/** The answers kept for a workspace, newest last; unreadable or malformed storage reads as none. */
export function readKeptAnswers(storage: AnswerStorage | null, key: string): ReadonlyMap<string, KeptAnswer> {
  let text: string | null = null;
  try { text = storage?.getItem(key) ?? null; } catch { return new Map(); }
  if (!text) return new Map();
  try {
    const parsed = KeptAnswersSchema.safeParse(JSON.parse(text));
    return parsed.success ? new Map<string, KeptAnswer>(parsed.data.map(([runId, { priors, ...reply }]) => [runId, { reply, priors: priors ?? [] }])) : new Map();
  } catch { return new Map(); }
}
/** An answer without a bridge is kept as its dials alone, as answers were before they bridged. */
function writeKept(storage: AnswerStorage | null, key: string, answers: readonly (readonly [string, KeptAnswer])[]): void {
  try { storage?.setItem(key, JSON.stringify(answers.slice(-KEPT_ANSWERS).map(([runId, { reply, priors }]) => [runId, priors.length ? { ...reply, priors } : reply]))); }
  catch { /* A full or refused store keeps this page's answers only. */ }
}
/** Keep a Run's latest answer, dropping the oldest beyond the limit; a refused write keeps this page's answers only. */
export function keepAnswer(storage: AnswerStorage | null, key: string, runId: string, answer: KeptAnswer): void {
  writeKept(storage, key, [...[...readKeptAnswers(storage, key)].filter(([id]) => id !== runId), [runId, answer]]);
}
/**
 * A read judges a Run's kept answer as it judges the page's (`readDials`), so a reload or another tab
 * agrees: a contradicted answer is forgotten, and one whose model the read names no longer bridges.
 * Returns the kept answer for the model the Run reports, which another tab may have kept after this
 * page's own was contradicted; null when none is.
 */
export function judgeKept(storage: AnswerStorage | null, key: string, runId: string, live: Dials): Dials | null {
  const kept = readKeptAnswers(storage, key), answer = kept.get(runId);
  if (!answer) return null;
  const { reply, priors } = readDials({ ...NO_DIALS, ...answer }, live);
  if (reply !== answer.reply || priors !== answer.priors)
    writeKept(storage, key, [...kept].flatMap(([id, entry]) => id !== runId ? [[id, entry] as const] : reply ? [[id, { reply, priors }] as const] : []));
  return live.model !== null && reply?.model === live.model ? reply : null;
}
/**
 * A read judges a Run's dials on this page and its kept answer alike. When it leaves the page without
 * an answer, the page shows the one kept for the model the read names, which another tab may have
 * kept since.
 */
export function judgeRead(storage: AnswerStorage | null, key: string, runId: string, state: RunDialState, live: Dials): RunDialState {
  const next = readDials(state, live);
  if (next === state) return state;
  const kept = judgeKept(storage, key, runId, live);
  return next.reply === null && kept ? { ...next, reply: kept } : next;
}
