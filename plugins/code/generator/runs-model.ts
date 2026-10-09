import { ThinkingLevelSchema } from "@atyrode/manifold-omp";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import { providerPolicy } from "../../domain/providers.ts";
import { AGENT_RENEWALS, OPEN_RUN_STATES, runDials, type CodeRun, type Dials } from "../workflow.ts";
import { shownDials, type DialOutcome, type RunDialState } from "./run-dials.ts";

/*
 * A Code Run as the Sessions view says it: its phase and activity word, its lease as a bar of
 * Manifold's 24 renewals, its one verb, its dials' words, and the one said line under it. Pure, so
 * the words and the lease arithmetic read and test apart from the DOM.
 */

/**
 * What a Run is now. `starting`: not settled and nothing reported yet (a TUI Run stays
 * `pending_policy` for life, so only its first report says it started). `live`: reporting. `detached`:
 * settled (its lease ran out, or it was revoked or cancelled) while its own TUI goes on, unattributed.
 * The rest are settled with their TUI gone, `expired` being a lease that ran out.
 */
export type RunPhase = "starting" | "live" | "detached" | "completed" | "failed" | "cancelled" | "expired" | "revoked";
export function runPhase(entry: Pick<CodeRun, "run" | "terminal">): RunPhase {
  const { state, activity } = entry.run;
  if (OPEN_RUN_STATES[state] === true) return activity === "unknown" ? "starting" : "live";
  if (entry.terminal) return "detached";
  if (state === "expired" || state === "completed" || state === "cancelled" || state === "revoked") return state;
  return "failed";
}
/** When a detached Run stopped being attributed: its expiry, or when a revocation or cancellation settled it. */
export function detachedAt(entry: Pick<CodeRun, "run" | "inspection">): number {
  return entry.run.state === "expired" ? entry.run.expiresAt : entry.inspection?.finishedAt ?? entry.run.expiresAt;
}
/** Whether its dials, lease and said line show: an open Run's, a detached one's included. */
export function runOpen(phase: RunPhase): boolean {
  return phase === "starting" || phase === "live" || phase === "detached";
}
/** The word beside the Run's mark: its activity while live, else its phase. */
export type ActivityWord = "working" | "blocked" | "done" | "idle" | RunPhase;
export function activityWord(entry: Pick<CodeRun, "run" | "terminal">): ActivityWord {
  const phase = runPhase(entry);
  const activity = entry.run.activity;
  return phase === "live" && activity !== "unknown" ? activity : phase;
}
/** What each activity word means, in a sentence a 360px panel holds on one line. */
export function activitySaid(word: ActivityWord, renewals: number | null): string {
  switch (word) {
    case "working": return "a turn is running";
    case "blocked": return "a dialog waits in its TUI";
    case "idle": return "waiting for a first message";
    case "done": return "turn ended; waiting for you";
    case "starting": return "policy pending; no report yet";
    case "live": return "running";
    case "detached": return renewals !== null && renewals >= AGENT_RENEWALS ? "renewals ran out; the TUI goes on" : "the run ended; the TUI goes on";
    case "completed": return "the TUI exited; session saved";
    case "failed": return "the TUI exited with an error";
    case "cancelled": return "cancelled from Code or Agents";
    case "expired": return "its lease ran out; the TUI has exited";
    case "revoked": return "revoked in Agents";
  }
}
/** The Run's one verb: open its terminal, cancel one that never opened, or resume a settled one's saved session (none for a Run cancelled before any terminal opened). */
export function runVerb(entry: Pick<CodeRun, "run" | "terminal" | "inspection">): "open" | "cancel" | "resume" | null {
  const phase = runPhase(entry);
  if (phase === "starting") return entry.terminal ? "open" : "cancel";
  if (phase === "live" || phase === "detached") return "open";
  return entry.run.session && !(phase === "cancelled" && entry.inspection?.terminalIds.length === 0) ? "resume" : null;
}

// ---------------------------------------------------------------- the lease

/**
 * A Run's lease as OMP's harness keeps it: renewed at half of each lease for the same length, so
 * each renewal moves the expiry half a lease on, and the 24th is the last Manifold allows. `next`
 * is when the next renewal is due (null once none is left or the renewals are unread), and `until`
 * the latest it can stay attributed if every renewal comes on time.
 */
export type Lease = { readonly renewals: number | null; readonly expiresAt: number; readonly next: number | null; readonly until: number | null };
export function leaseOf(entry: Pick<CodeRun, "run" | "leaseMs" | "inspection">): Lease {
  const half = entry.leaseMs / 2, renewals = entry.inspection?.renewals ?? null, expiresAt = entry.run.expiresAt;
  const left = renewals === null ? null : Math.max(0, AGENT_RENEWALS - renewals);
  return { renewals, expiresAt, next: left ? expiresAt - half : null, until: left === null ? null : expiresAt + left * half };
}
/** A span of time as the lease says it: `under a minute`, `18m`, `1h 5m`. */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
export type RunVocabulary = { readonly time: (at: number) => string };
/** The bar's tone: warm once no renewal is left or one is overdue, faint once detached. */
export type LeaseTone = "warn" | "off" | null;
/**
 * The lease's words beside its bar, or on the Run's line once settled: when it renews, when it
 * expires once no renewal is left or one is overdue, since when it is detached; how long ago a Run
 * completed, or when and with what exit one failed.
 */
export function leaseWords(entry: CodeRun, now: number, vocab: RunVocabulary): { readonly text: string; readonly tone: LeaseTone } {
  const phase = runPhase(entry), lease = leaseOf(entry), finished = entry.inspection?.finishedAt ?? null;
  switch (phase) {
    case "starting": return { text: "", tone: null };
    case "detached": return { text: `detached since ${vocab.time(detachedAt(entry))}`, tone: "off" };
    case "failed": {
      const exit = entry.inspection?.exitCode;
      return { text: [finished === null ? null : vocab.time(finished), exit === null || exit === undefined ? null : `exit ${exit}`].filter(Boolean).join(" · "), tone: null };
    }
    case "completed": case "cancelled": case "expired": case "revoked":
      return { text: finished === null ? "" : `${span(now - finished)} ago`, tone: null };
    case "live": break;
  }
  if (lease.renewals === null) return { text: `expires ${vocab.time(lease.expiresAt)}`, tone: null };
  if (lease.next === null) return { text: `expires ${vocab.time(lease.expiresAt)}`, tone: "warn" };
  if (lease.next <= now) return { text: `renewal due · expires ${vocab.time(lease.expiresAt)}`, tone: "warn" };
  return { text: `renews in ${span(lease.next - now)}`, tone: null };
}

// ---------------------------------------------------------------- the dials' words

/** A word of a Run's dial: the value it sends, what it reads, and its provider's family for its hue. */
export type DialWord = { readonly value: string; readonly text: string; readonly family: string | null; readonly familyStart: boolean };
/**
 * The model dial's words: every ladder of the profile's model list, one family after another in the
 * catalog's order, each rung once, by its display alias. The session serves at most these; one it
 * does not is struck once it says so.
 */
export function modelWords(catalog: CompiledCatalog, aliases: ReadonlyMap<string, string>): DialWord[] {
  return catalog.families.flatMap(family => {
    const keys = [...new Set(Array.from({ length: catalog.top(family) }, (_, index) => catalog.rung(family, index + 1)))];
    return keys.map((key, index) => {
      const model = catalog.model(key);
      return { value: `${model.provider}/${model.id}`, text: aliases.get(key) ?? model.id, family, familyStart: index === 0 };
    });
  });
}
export const THINKING_LEVELS: readonly string[] = ThinkingLevelSchema.options;
/** A model reference as a Run token's alias and family: the catalog's alias, else the id after its provider. */
export function modelName(reference: string | null, catalog: CompiledCatalog | null, aliases: ReadonlyMap<string, string> | null): { readonly text: string; readonly family: string | null } {
  if (reference === null) return { text: "model unknown", family: null };
  const slash = reference.indexOf("/"), provider = reference.slice(0, slash);
  const model = catalog?.models.find(entry => `${entry.provider}/${entry.id}` === reference);
  return { text: (model && aliases?.get(model.key)) ?? reference.slice(slash + 1), family: slash > 0 ? providerPolicy(provider).family : null };
}
/** The thinking levels the shown model has, from the profile's model list; null when the list does not hold it. */
export function modelLevels(reference: string | null, catalog: CompiledCatalog | null): readonly string[] | null {
  return catalog?.models.find(entry => `${entry.provider}/${entry.id}` === reference)?.thinkingLevels ?? null;
}

// ---------------------------------------------------------------- the said line

/** One line under an open Run: a value in bold and what it means, warm when it refuses; `again` offers to send again. */
export type RunSaid = { readonly value: string; readonly text: string; readonly warn: boolean; readonly family: string | null; readonly again: boolean; readonly title: string | null };
/** What the pointer rests on in a Run: a dial's word, its lease, or its activity. */
export type RunPointed = { readonly kind: "word"; readonly field: "model" | "thinking"; readonly value: string } | { readonly kind: "lease" } | { readonly kind: "activity" };
const said = (value: string, text: string, extra: Partial<RunSaid> = {}): RunSaid =>
  ({ value, text, warn: false, family: null, again: false, title: null, ...extra });

/** Why a Run's dials cannot turn now, or null when they can. */
export function dialsLock(entry: CodeRun, state: RunDialState, vocab: RunVocabulary): RunSaid | null {
  const phase = runPhase(entry);
  if (state.forbidden) return said("dials", "its launcher's or sponsor's alone", { warn: true });
  if (phase === "starting") return said("dials", "once the session starts");
  if (phase === "detached") return said("dials", `off since ${vocab.time(detachedAt(entry))} · the TUI goes on`);
  if (phase !== "live") return said("dials", "the run is over");
  return null;
}
function outcomeSaid(outcome: DialOutcome, shown: Dials, name: (reference: string | null) => { text: string; family: string | null }): RunSaid {
  const valueOf = (change: { field: string; value: string }) => change.field === "model" ? name(change.value) : { text: change.value, family: null };
  switch (outcome.kind) {
    case "confirmed": {
      const value = valueOf(outcome.change);
      return said(value.text, outcome.clamped ? `running now · thinking ${outcome.clamped}` : "running now", { family: value.family });
    }
    case "unserved": {
      const value = valueOf(outcome.change);
      return said(value.text, `not served here · ${name(shown.model).text} stays`, { warn: true, family: value.family });
    }
    case "lacks": return said(outcome.change.value, `${name(shown.model).text} has none`, { warn: true });
    case "forbidden": return said("dials", "its launcher's or sponsor's alone", { warn: true });
    case "gone": return said("dials", "no running session answers", { warn: true });
    case "unsupported": return said("dials", "this run has none", { warn: true });
    case "failed": return said("dials", outcome.words, { warn: true });
  }
}
/**
 * The said line of an open Run, in precedence: what the pointer rests on (a word other than the one
 * last pressed: what choosing it sends, or why it cannot; the lease; the activity), a change waiting
 * for its answer, one that went unanswered with its send again, what the last press came to, then
 * the Run's own state where it has something to say. Null leaves the line empty, keeping its room.
 * A click leaves the pointer on the word it pressed, so that word says what the press came to.
 */
export function runSaid(entry: CodeRun, state: RunDialState, pointed: RunPointed | null, now: number, context: {
  readonly vocab: RunVocabulary; readonly name: (reference: string | null) => { text: string; family: string | null }; readonly levels: readonly string[] | null;
}): RunSaid | null {
  const { vocab, name, levels } = context;
  const shown = shownDials(state, runDials(entry.run.model));
  const pressed = state.queued?.value ?? state.pending?.value ?? state.unconfirmed?.value ?? (state.outcome && "change" in state.outcome ? state.outcome.change.value : null);
  const pointer = pointed?.kind === "word" && pointed.value === pressed ? null : pointed;
  const phase = runPhase(entry), lock = dialsLock(entry, state, vocab);
  if (pointer?.kind === "word") {
    if (lock) return lock;
    if (pointer.field === "model") {
      const model = name(pointer.value);
      if (state.unserved.includes(pointer.value)) return said(model.text, "not served here", { warn: true, family: model.family });
      return said(model.text, `${pointer.value.slice(pointer.value.indexOf("/") + 1)} · main agent`, { family: model.family });
    }
    if (levels && !levels.includes(pointer.value)) return said(pointer.value, `${name(shown.model).text} has none`, { warn: true });
    return said(pointer.value, "thinking · main agent");
  }
  if (pointer?.kind === "lease") return leaseSaid(entry, now, vocab);
  if (pointer?.kind === "activity") {
    const word = activityWord(entry);
    return said(word, activitySaid(word, entry.inspection?.renewals ?? null));
  }
  if (state.pending && state.queued) {
    const value = state.queued.field === "model" ? name(state.queued.value) : { text: state.queued.value, family: null };
    const waiting = state.pending.field === "model" ? name(state.pending.value).text : state.pending.value;
    return said(value.text, `next · once ${waiting} answers`, { family: value.family });
  }
  if (state.pending) {
    const value = state.pending.field === "model" ? name(state.pending.value) : { text: state.pending.value, family: null };
    const current = state.pending.field === "model" ? name(shown.model).text : shown.thinking ?? "unknown";
    return said(value.text, `sent · ${current} until it answers`, { family: value.family });
  }
  if (state.unconfirmed) {
    const value = state.unconfirmed.field === "model" ? name(state.unconfirmed.value).text : state.unconfirmed.value;
    return said(value, "no answer in 20 s", { warn: true, again: true, title: "No answer within 20 s: the change may still apply." });
  }
  if (state.outcome) return outcomeSaid(state.outcome, shown, name);
  if (phase === "starting") return said("starting", activitySaid("starting", null));
  if (lock && (state.forbidden || phase === "detached")) return lock;
  return null;
}
/** The lease said in full while it is pointed: the renewal due and when, or why there is none. */
export function leaseSaid(entry: CodeRun, now: number, vocab: RunVocabulary): RunSaid {
  const lease = leaseOf(entry), phase = runPhase(entry);
  if (phase === "detached") return said("detached", `since ${vocab.time(detachedAt(entry))} · the TUI goes on`);
  if (phase === "starting") return said("lease", "from its first report");
  if (lease.renewals === null) return said("lease", `expires ${vocab.time(lease.expiresAt)} · renewals unread`);
  if (lease.next === null) return said("no renewals left", `detached after ${vocab.time(lease.expiresAt)}`, { warn: true });
  if (lease.next <= now) return said(`renewal ${lease.renewals + 1} of ${AGENT_RENEWALS}`, `due since ${vocab.time(lease.next)} · expires ${vocab.time(lease.expiresAt)}`, { warn: true });
  return said(`renewal ${lease.renewals + 1} of ${AGENT_RENEWALS}`, `${vocab.time(lease.next)} · expires ${vocab.time(lease.expiresAt)}`);
}

/**
 * The Sessions tab's one square for the Runs that run, never a count: blocked before working before
 * starting, else the quiet square of Runs that wait for their person; null with none open.
 */
export function tabMark(runs: readonly CodeRun[]): "blocked" | "working" | "starting" | "done" | null {
  const open = runs.filter(entry => { const phase = runPhase(entry); return phase === "live" || phase === "starting"; });
  if (open.length === 0) return null;
  if (open.some(entry => runPhase(entry) === "live" && entry.run.activity === "blocked")) return "blocked";
  if (open.some(entry => runPhase(entry) === "live" && entry.run.activity === "working")) return "working";
  return open.some(entry => runPhase(entry) === "starting") ? "starting" : "done";
}
