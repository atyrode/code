import { describe, expect, test } from "bun:test";
import type { CatalogDocument } from "../domain/contracts.ts";
import { exclusionWords, listChanges, modelRows, modelsPhase, nextSetupRow, saveFailure, setupRows, speedLevel, type SetupFacts } from "../code/generator/sheets-model.ts";
import { followRecord } from "../code/generator/launch-step.ts";
import type { ProfileDraft } from "../code/generator/workbench-model.ts";

const document: CatalogDocument = { schemaVersion: 1, models: ([1, 2, 3] as const).map(tier => ({
  key: `model-${tier}`, provider: "anthropic", id: `native-model${tier}`, api: "anthropic-messages", tier,
  quotaBucket: null, inputCostPerMillion: tier, outputCostPerMillion: tier * 3, tokensPerSecond: 30 * tier, timeToFirstTokenMs: 900,
  contextWindow: 200_000, thinkingLevels: ["low", "medium", "high"], images: true,
})) };

describe("the Models sheet", () => {
  test("a staged list says what it changes against the list in use: a field, a model added, a model dropped", () => {
    const active = modelRows(document);
    expect(listChanges(active, active)).toEqual([]);
    const faster = structuredClone(document);
    faster.models[0]!.tokensPerSecond = 101;
    faster.models.splice(2, 1, { ...faster.models[2]!, key: "model-new", id: "native-new" });
    const changes = listChanges(active, modelRows(faster)).map(({ row, field, from, to }) => [row.key, field, from, to]);
    expect(changes).toEqual([
      ["model-1", "speed", "30 tok/s", "101 tok/s"],
      ["model-new", "added", null, "native-new"],
      ["model-3", "dropped", "native-model3", null],
    ]);
  });

  test("Spark's retired rung takes no place on a ladder, and speed reads as five blocks, none when unmeasured", () => {
    const spark = { ...document, models: [...document.models, { ...document.models[0]!, key: "spark", id: "spark", tier: 0 as const }] };
    expect(modelRows(spark).map(row => row.key)).toEqual(["model-1", "model-2", "model-3"]);
    expect([null, 29, 30, 45, 60, 90].map(speedLevel)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("a model left out for OMP's Spark quota class reads retired, by that class and never by its id; another class of its own reads own quota", () => {
    const left = (quotaTier: string, id: string) => exclusionWords({ provider: "openai-codex", id, reason: "separate_quota", quotaTier });
    expect(left("spark", "gpt-5.3-codex-spark")).toEqual(["retired", "Retired: Code no longer routes to Spark"]);
    // The class decides, not the id: a spark-named id in another class is its own quota, and Spark's class under any id is retired.
    expect(left("future-resource", "gpt-5.3-codex-spark")[0]).toBe("own quota");
    expect(left("spark", "codex-mini-next")[0]).toBe("retired");
    expect(exclusionWords({ provider: "anthropic", id: "claude-opus-4", reason: "superseded" })[0]).toBe("superseded");
  });

  test("the next action follows the step: a run first, then a staged list, then the verification and its refusal", () => {
    const at = (changes: Partial<Parameters<typeof modelsPhase>[0]>) =>
      modelsPhase({ run: null, step: null, staged: false, status: "unverified", verifyRefusal: null, ...changes });
    expect(at({ run: "charge", staged: true })).toBe("charge");
    expect(at({ run: "benchmark", step: "benchmark" })).toBe("benchmark");
    expect(at({ run: "benchmark", step: "promote" })).toBe("finishing");
    // A staged list is put in use without discovery, so a refused verification does not hide it.
    expect(at({ staged: true, verifyRefusal: "verify-permissions" })).toBe("staged");
    expect(at({ status: "current" })).toBe("verified");
    expect(at({ verifyRefusal: "verify-permissions" })).toBe("refused");
    expect(at({ status: "accounts-changed", verifyRefusal: "accounts" })).toBe("unverified");
  });

  const selection = { lane: { kind: "mixed" }, capability: 3, thinking: "high", advisor: "glance", spark: false, priority: false, prewalk: false,
    planYolo: false, fallback: true, budget: "any" } as const;
  // An edit of the saved team at revision 7, with a list staged beside the one in use: what holds "use staged list".
  const edit: ProfileDraft = { source: "active", document, selection: { ...selection, advisor: "audit" }, revision: 7, initialized: true,
    baseSelection: selection, catalogDigest: "a".repeat(64), draftDigest: "d".repeat(64), metadata: null, metadataKey: null };
  // A recalled team that could not be formed left a failed message, and the edit stayed.
  const recall = { text: "That profile cannot be formed from the current models; nothing changed.", failed: true };
  const stale = { text: "The workspace profile changed. Read it again before saving your edit.", failed: true };

  test("the held action says only its own save's failure: never a message that stood before it, nor one left once the edit changed", () => {
    expect(saveFailure(null, edit, recall)).toBeNull();
    const press = { draft: edit, before: recall };
    // The save has not answered, or its gate refused it and it set nothing: the older message is not its answer.
    expect(saveFailure(press, edit, null)).toBeNull();
    expect(saveFailure(press, edit, recall)).toBeNull();
    expect(saveFailure(press, edit, stale)).toBe(stale.text);
    // Once the edit changes, or is discarded, its earlier save's failure is no longer said.
    expect(saveFailure(press, { ...edit, selection: { ...selection, advisor: "off" } }, stale)).toBeNull();
    expect(saveFailure(press, null, stale)).toBeNull();
  });

  test("a save refused as stale is still said once the same team is followed to a new revision", () => {
    // Another tab changed the account choices (revision 8) while the save of revision 7 was in flight. The read that
    // brings revision 8 moves the edit's base forward (launch-step.ts `followRecord`): a new draft holding the same team.
    const followed = followRecord(edit, { revision: 8, initialized: true, catalogDigest: edit.catalogDigest, draftDigest: edit.draftDigest,
      selection: edit.baseSelection, metadataKey: null });
    expect(followed).not.toBe(edit);
    expect(followed.revision).toBe(8);
    // The save's refusal arrives after that read, and the held action says it.
    expect(saveFailure({ draft: edit, before: null }, followed, stale)).toBe(stale.text);
  });
});

describe("the Setup sheet", () => {
  const ready: SetupFacts = { machine: { name: "Studio", online: true }, rosterError: false, omp: "ok", destinationError: false,
    connection: true, discovery: true, sessions: true, folders: "ready", folderMode: "existing" };

  test("rows that depend on OMP say so rather than claiming a state, and OMP is the fix pointed at", () => {
    const rows = setupRows({ ...ready, omp: "absent", connection: false, discovery: false });
    expect(rows.omp).toEqual({ state: "todo", word: "not on Studio" });
    for (const id of ["connection", "discovery", "sessions", "folders"] as const) expect(rows[id]).toEqual({ state: "unknown", word: "needs omp" });
    expect(nextSetupRow(rows)).toBe("omp");
  });

  test("an offline machine is the fix, everything after it unreachable", () => {
    const rows = setupRows({ ...ready, machine: { name: "Laptop", online: false } });
    expect(rows.machine).toEqual({ state: "todo", word: "offline" });
    expect(rows.omp.word).toBe("unreachable");
    expect(nextSetupRow(rows)).toBe("machine");
  });

  test("the first unready row is the next fix, a running folder job is no fix, and a ready machine has none", () => {
    expect(nextSetupRow(setupRows({ ...ready, discovery: false, folders: "todo" }))).toBe("discovery");
    expect(setupRows({ ...ready, folders: "busy", folderMode: "create" }).folders).toEqual({ state: "busy", word: "creating…" });
    // Folder history not read yet is not claimed as unprepared.
    expect(setupRows({ ...ready, folders: null }).folders.state).toBe("unknown");
    expect(nextSetupRow(setupRows(ready))).toBeNull();
  });
});
