import type { CatalogDocument } from "../../domain/contracts.ts";
import { compileCatalog } from "../../domain/catalog.ts";
import type { Exclusion } from "../../domain/probe.ts";
import { providerPolicy } from "../../domain/providers.ts";
import type { OmpPresence } from "../destination.ts";
import type { VerificationStep } from "../workflow.ts";
import { displayAliases } from "./aliases.ts";
import { CAPABILITY_WORDS } from "./dial-space.ts";
import type { GateRefusalCode } from "./launch-step.ts";
import type { VerificationPhase } from "./model-verification.ts";
import type { VerificationStatus } from "./verification.ts";
import type { ProfileDraft, WorkbenchMessage } from "./workbench-model.ts";

/*
 * The Models and Setup sheets as rules, apart from React: the model list as the ladders the
 * generator lands on, what a staged list changes, the step a sheet is at, and what a machine still
 * needs before Code can verify and launch there.
 */

// ---------------------------------------------------------------- Models: the list as ladders

/** The rungs a ladder has, low to high: the words the generator's model row uses. */
export const TIERS = CAPABILITY_WORDS;
/** One model as the list shows it: a rung of its family's ladder, with what the readout says of it. */
export type ModelRow = {
  readonly key: string; readonly alias: string; readonly provider: string; readonly family: string; readonly id: string; readonly tier: number;
  readonly tps: number | null; readonly ttft: number | null; readonly pin: number; readonly pout: number; readonly ctx: number | null;
  readonly levels: readonly string[];
};

/**
 * The models a list places on a rung (tiers 1 to 4), each under its short alias. Tier 0 was Spark's
 * own rung, which is retired, so a model still listed there takes no rung. A list that does not
 * compile still shows, under its keys.
 */
export function modelRows(document: CatalogDocument): ModelRow[] {
  let aliases: ReadonlyMap<string, string> = new Map();
  try { aliases = displayAliases(compileCatalog(document)); } catch { /* A list that does not compile keeps its keys. */ }
  return document.models.filter(model => model.tier >= 1 && model.tier <= 4).map(model => ({
    key: model.key, alias: aliases.get(model.key) ?? model.key, provider: model.provider, family: providerPolicy(model.provider).family,
    id: model.id, tier: model.tier, tps: model.tokensPerSecond, ttft: model.timeToFirstTokenMs, pin: model.inputCostPerMillion,
    pout: model.outputCostPerMillion, ctx: model.contextWindow, levels: model.thinkingLevels,
  }));
}

/** Measured speed as one to five blocks; 0 is unmeasured. */
export function speedLevel(tps: number | null): number {
  return tps === null ? 0 : tps < 30 ? 1 : tps < 45 ? 2 : tps < 60 ? 3 : tps < 90 ? 4 : 5;
}
/** A price per million tokens, as short as it stays exact to the cent (`$0.075`, `$0.4`, `$15`). */
export function money(value: number): string {
  return `$${value < 1 ? value.toFixed(value < 0.1 ? 3 : 2).replace(/0+$/, "").replace(/\.$/, "") : value}`;
}
export function contextWords(tokens: number | null): string {
  return tokens === null ? "context unknown" : tokens >= 1_000_000 ? `${tokens / 1_000_000}M context` : `${Math.round(tokens / 1000)}k context`;
}
export function thinkingRange(levels: readonly string[]): string {
  return levels.length > 1 ? `${levels[0]}–${levels.at(-1)}` : levels[0] ?? "";
}

/** One thing a staged list changes against the list in use: a field of a model, or a model added or dropped. */
export type ListChange = { readonly row: ModelRow; readonly field: string; readonly from: string | null; readonly to: string | null };
const FIELDS: readonly (readonly [keyof ModelRow, string, (value: never) => string])[] = [
  ["tps", "speed", (value: number | null) => value === null ? "unmeasured" : `${Math.round(value)} tok/s`],
  ["ttft", "first token", (value: number | null) => value === null ? "unmeasured" : `${(value / 1000).toFixed(1)} s`],
  ["pin", "input", (value: number) => `${money(value)} / M`],
  ["pout", "output", (value: number) => `${money(value)} / M`],
  ["ctx", "context", contextWords],
  ["id", "model id", String],
  ["tier", "tier", (value: number) => TIERS[value - 1] ?? String(value)],
  ["levels", "thinking", thinkingRange],
];
/** What a staged list changes against the one in use, per model and field, then the models it drops. */
export function listChanges(active: readonly ModelRow[], staged: readonly ModelRow[]): ListChange[] {
  const changes: ListChange[] = [];
  const before = new Map(active.map(row => [row.key, row]));
  for (const row of staged) {
    const was = before.get(row.key);
    if (!was) { changes.push({ row, field: "added", from: null, to: row.id }); continue; }
    for (const [field, label, format] of FIELDS) {
      if (JSON.stringify(was[field]) === JSON.stringify(row[field])) continue;
      changes.push({ row, field: label, from: (format as (value: unknown) => string)(was[field]), to: (format as (value: unknown) => string)(row[field]) });
    }
  }
  for (const row of active) if (!staged.some(candidate => candidate.key === row.key)) changes.push({ row, field: "dropped", from: row.id, to: null });
  return changes;
}

/** Why a verification left a model out, in a word and in full. */
const EXCLUSION_WORDS: Readonly<Record<Exclusion["reason"], readonly [string, string]>> = {
  superseded: ["superseded", "Superseded by a newer model"],
  unstable_id: ["unstable id", "A rolling alias, preview or experiment, which Code never probes"],
  not_found: ["not reachable", "Not found through your accounts"],
  client_blocked: ["blocked here", "Blocked for this client"],
  regression: ["worse than cheaper", "Worse than a cheaper tier"],
  separate_quota: ["own quota", "Draws a quota of its own, which Code does not spend"],
};
/**
 * The words a left-out model reads with. Spark is known by OMP's quota class for it (`spark`), which
 * the exclusion carries, never by its id: Code retired Spark's rung, so it reads as retired. Any
 * other class of its own reads as its own quota.
 */
export function exclusionWords(exclusion: Exclusion): readonly [string, string] {
  return exclusion.reason === "separate_quota" && exclusion.quotaTier === "spark"
    ? ["retired", "Retired: Code no longer routes to Spark"] : EXCLUSION_WORDS[exclusion.reason];
}

/**
 * The step the Models sheet is at, which decides its one next action. A run in flight comes first
 * (`finishing` once its measurements are in), then a staged list waiting beside the one in use, a
 * list verified with the present accounts and OMP, and otherwise a list to verify: `refused` when
 * verifying needs discovery the machine has not enabled.
 */
export type ModelsPhase = "inventory" | "charge" | "benchmark" | "finishing" | "staged" | "verified" | "refused" | "unverified";
export function modelsPhase(facts: {
  readonly run: VerificationPhase | null; readonly step: VerificationStep | null; readonly staged: boolean;
  readonly status: VerificationStatus; readonly verifyRefusal: GateRefusalCode | null;
}): ModelsPhase {
  if (facts.run === "benchmark") return facts.step === null || facts.step === "benchmark" ? "benchmark" : "finishing";
  if (facts.run) return facts.run;
  if (facts.staged) return "staged";
  if (facts.status === "current") return "verified";
  return facts.verifyRefusal === "verify-permissions" ? "refused" : "unverified";
}

/**
 * A save pressed beside Models' held action: the edit it saved and the workbench message standing
 * when it was pressed. Only that save's own failure is said there. A message that already stood,
 * such as a recalled team that could not be formed, is not its answer, and neither is one left once
 * the edit has changed.
 */
export type SavePress = { readonly draft: ProfileDraft | null; readonly before: WorkbenchMessage | null };
export function saveFailure(press: SavePress | null, draft: ProfileDraft | null, message: WorkbenchMessage | null): string | null {
  return press !== null && press.draft === draft && message !== press.before && message?.failed ? message.text : null;
}

// ---------------------------------------------------------------- Setup: what the machine needs

export const SETUP_ROWS = ["machine", "omp", "connection", "discovery", "sessions", "folders"] as const;
export type SetupRowId = (typeof SETUP_ROWS)[number];
/** A row's state: `ok`, `todo` (a fix is due), `unknown` (it depends on something above that is missing), `busy` (a job runs). */
export type SetupRowState = { readonly state: "ok" | "todo" | "unknown" | "busy"; readonly word: string };
export type FolderMode = "existing" | "create";
export type SetupFacts = {
  /** The chosen machine; null when none is chosen or it left the roster. */
  readonly machine: { readonly name: string; readonly online: boolean } | null;
  readonly rosterError: boolean;
  /** Whether OMP answers there; null until every online machine has answered. */
  readonly omp: OmpPresence | null;
  /** Its destination could not be read for another reason than OMP's absence. */
  readonly destinationError: boolean;
  readonly connection: boolean;
  /** Discovery and benchmark are both ready: verifying needs the two. */
  readonly discovery: boolean;
  readonly sessions: boolean;
  /** Folders prepared by a job matching this machine's current pins; null while their history is unread. */
  readonly folders: "ready" | "todo" | "busy" | null;
  readonly folderMode: FolderMode;
};
/**
 * Each row's state on the chosen machine. A row that depends on something missing says so (`needs
 * omp`, `unreachable`) rather than claiming a state of its own.
 */
export function setupRows(facts: SetupFacts): Readonly<Record<SetupRowId, SetupRowState>> {
  const { machine } = facts;
  const machineRow: SetupRowState = facts.rosterError && !machine ? { state: "todo", word: "unreadable" }
    : !machine ? { state: "todo", word: "none chosen" } : machine.online ? { state: "ok", word: "online" } : { state: "todo", word: "offline" };
  const reachable = machine?.online === true;
  const omp: SetupRowState = !reachable ? { state: "unknown", word: "unreachable" }
    : facts.omp === "absent" ? { state: "todo", word: `not on ${machine.name}` }
    : facts.omp === "ok" && !facts.destinationError ? { state: "ok", word: "ready" }
    : facts.omp === null ? { state: "unknown", word: "checking" } : { state: "todo", word: "not answering" };
  const below = (own: () => SetupRowState): SetupRowState => !reachable ? { state: "unknown", word: "unreachable" }
    : omp.state !== "ok" ? { state: "unknown", word: "needs omp" } : own();
  return {
    machine: machineRow, omp,
    connection: below(() => facts.connection ? { state: "ok", word: "ready" } : { state: "todo", word: "review needed" }),
    discovery: below(() => facts.discovery ? { state: "ok", word: "on" } : { state: "todo", word: "off" }),
    sessions: below(() => facts.sessions ? { state: "ok", word: "on" } : { state: "todo", word: "off" }),
    folders: below(() => facts.folders === "ready" ? { state: "ok", word: "ready" }
      : facts.folders === "busy" ? { state: "busy", word: facts.folderMode === "create" ? "creating…" : "checking…" }
      : facts.folders === null ? { state: "unknown", word: "not read" } : { state: "todo", word: "not prepared" }),
  };
}
/** The first row with a fix due: the one the sheet points at, whose fix is its next action. */
export function nextSetupRow(rows: Readonly<Record<SetupRowId, SetupRowState>>): SetupRowId | null {
  return SETUP_ROWS.find(id => rows[id].state === "todo") ?? null;
}
