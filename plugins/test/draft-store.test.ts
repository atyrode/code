import { describe, expect, test } from "bun:test";
import type { ModelCatalogSnapshot } from "@atyrode/manifold-omp";
import type { Configuration } from "../code/contract.ts";
import { readStoredDraft, restoreDraft, storeDraft, storedDraftKey, type DraftStorage } from "../code/generator/draft-store.ts";
import { draftStale, followRecord, type SharedBase } from "../code/generator/launch-step.ts";
import type { ProfileDraft } from "../code/generator/workbench-model.ts";
import { initialAccountChoices } from "../domain/accounts.ts";
import type { CatalogDocument, Selection } from "../domain/contracts.ts";
import { catalogFromMetadata } from "../domain/probe.ts";

function memory(): DraftStorage {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}
const document: CatalogDocument = { schemaVersion: 1, models: ([1, 2, 3] as const).map(tier => ({
  key: `model-${tier}`, provider: "anthropic", id: `native-model${tier}`, api: "anthropic-messages", tier,
  quotaBucket: null, inputCostPerMillion: tier, outputCostPerMillion: tier * 3, tokensPerSecond: 30, timeToFirstTokenMs: 100,
  contextWindow: 200_000, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], images: true,
})) };
const saved: Selection = { lane: { kind: "provider", family: "anthropic", blend: "only" }, capability: 2, thinking: "medium", advisor: "glance",
  spark: false, priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any" };
const catalogDigest = "a".repeat(64);
/** The workspace record at revision 7: the active catalog and the saved team. */
function record(changes: Partial<Configuration> = {}): Configuration {
  return { containerId: "workspace-1", schemaVersion: 4, revision: 7, accounts: initialAccountChoices(), draft: null,
    active: { document, digest: catalogDigest, provenance: null }, selection: saved, updatedBy: "writer", updatedAt: 1, ...changes };
}
/** The record as the workbench judges a draft against it. */
function shared(value: Configuration, metadataKey: string | null = null): SharedBase {
  return { revision: value.revision, initialized: true, catalogDigest: value.active?.digest ?? null, draftDigest: value.draft?.digest ?? null,
    selection: value.selection, metadataKey };
}
/** An edit of the saved team made at revision 7: thinking turned up. */
const edit: ProfileDraft = { source: "active", document, selection: { ...saved, thinking: "max" }, revision: 7, initialized: true,
  baseSelection: saved, catalogDigest, draftDigest: null, metadata: null, metadataKey: null };
const key = storedDraftKey("principal-1", "workspace-1");
function reloaded(draft: ProfileDraft) {
  const storage = memory();
  storeDraft(storage, key, draft);
  return readStoredDraft(storage, key)!;
}
/** OMP's bundled list for the same models: what a first-use draft is derived from. */
const bundled: ModelCatalogSnapshot = { schemaVersion: 1, source: "bundled", ompVersion: "18.1.14", revision: "b".repeat(64),
  models: document.models.map(model => ({ provider: model.provider, id: model.id, api: model.api, quotaTier: null,
    inputCostPerMillion: model.inputCostPerMillion, outputCostPerMillion: model.outputCostPerMillion, contextWindow: model.contextWindow,
    maxTokens: 64000, reasoning: true, thinkingLevels: model.thinkingLevels, images: model.images })) };
const bundledKey = JSON.stringify(bundled);
const starter: ProfileDraft = { source: "starter", document: catalogFromMetadata(bundled, "any"), selection: { ...saved, advisor: "off" }, revision: 0,
  initialized: false, baseSelection: null, catalogDigest: null, draftDigest: null, metadata: bundled, metadataKey: bundledKey };

describe("an unsaved draft after a reload", () => {
  test("it comes back onto the document it was made on, and an account write meanwhile moves its base forward", () => {
    const accountsChanged = record({ revision: 8 });
    const restored = restoreDraft(reloaded(edit), accountsChanged, null, null)!;
    expect(restored).toEqual(edit);
    expect(draftStale(restored, shared(accountsChanged))).toBe(false);
    expect(followRecord(restored, shared(accountsChanged)).revision).toBe(8);
    // A first-use draft comes back on the same bundled list, derived for its own budget.
    expect(restoreDraft(reloaded(starter), null, bundled, bundledKey)).toEqual(starter);
  });

  test("it is dropped when the document it was made on is gone: another catalog, none, or another bundled list", () => {
    const kept = reloaded(edit);
    expect(restoreDraft(kept, record({ revision: 8, active: { document, digest: "c".repeat(64), provenance: null } }), null, null)).toBeNull();
    expect(restoreDraft(kept, record({ revision: 8, active: null }), null, null)).toBeNull();
    const republished = { ...bundled, ompVersion: "18.4.4" };
    expect(restoreDraft(reloaded(starter), null, republished, JSON.stringify(republished))).toBeNull();
  });

  test("a foreign write of the team while the tab was away is a conflict once restored, and the draft keeps its base", () => {
    const selected = record({ revision: 8, selection: { ...saved, capability: 3 } });
    const restored = restoreDraft(reloaded(edit), selected, null, null)!;
    expect(restored.selection).toEqual(edit.selection);
    expect(draftStale(restored, shared(selected))).toBe(true);
    expect(followRecord(restored, shared(selected))).toBe(restored);
  });
});
