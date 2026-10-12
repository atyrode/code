import { describe, expect, test } from "bun:test";
import { LAUNCH_OPERATION_ID, OMP_VERSION } from "@atyrode/manifold-omp";
import type { VerificationProvenance } from "../code/contract.ts";
import { operationReady } from "../code/permission-plan.ts";
import type { Selection } from "../domain/contracts.ts";
import { editedDraft } from "../code/generator/draft-store.ts";
import { autoReviewDue, draftStale, editHoldsCatalogWrite, followCatalogWrite, followInitialization, followRecord, launchStatusText, nextLaunchStep,
  type CatalogWrite, type DraftBase, type GateFacts, type LaunchFacts, type SharedBase } from "../code/generator/launch-step.ts";
import type { ProfileDraft } from "../code/generator/workbench-model.ts";
import { backgroundCheckDue, CHECKING_HOLD_MS, confirmsCharge, ownInitialization, spendsWithoutAsking, verificationState, type BackgroundFacts,
  type VerificationStatus } from "../code/generator/verification.ts";

const runtime = "c".repeat(64), catalog = "e".repeat(64);
const provenance: VerificationProvenance = { ompVersion: OMP_VERSION, inventoryArtifactSha256: runtime, catalogRevision: catalog,
  inventoryObservedAt: 1, benchmarkCompletedAt: 2, providers: ["anthropic", "openai-codex"], poolIdentityDigest: "a".repeat(64) };
const same = { providers: ["anthropic", "openai-codex"], poolIdentityDigest: "a".repeat(64) };
const present = { inventoryArtifactSha256: runtime, catalogRevision: catalog, unpublished: [] };
const moved = "f".repeat(64);

describe("whether a recorded verification still holds", () => {
  test("the present pool and the routed models OMP publishes decide, and a dropped model outranks an account change", () => {
    expect(verificationState(provenance, { ...present, pool: same }, false).status).toBe("current");
    expect(verificationState(null, { ...present, pool: same }, false).status).toBe("unverified");
    expect(verificationState(provenance, { ...present, pool: same }, true).status).toBe("verifying");
    const both = verificationState(provenance, { ...present, catalogRevision: moved, unpublished: ["openai-codex/terra"], pool: { ...same, poolIdentityDigest: "b".repeat(64) } }, false);
    expect([both.status, both.changes.unpublished, both.changes.identitiesChanged]).toEqual(["unpublished", ["openai-codex/terra"], true]);
  });

  test("an OMP update the routed models survive keeps the verification current, so the launch goes on without verifying", () => {
    // The runtime is upgraded on the destination with the same model catalog and the same accounts.
    const upgraded = verificationState(provenance, { ...present, inventoryArtifactSha256: "9".repeat(64), pool: same }, false);
    expect(upgraded).toMatchObject({ status: "current", changes: { runtimeChanged: true, catalogChanged: false, unpublished: [] } });
    expect(nextLaunchStep(facts({}, upgraded.status)).step).toBe("review");
    expect(nextLaunchStep(facts({ previewCurrent: true }, upgraded.status)).step).toBe("launch");
    // A model catalog republished under another revision that still lists every routed model.
    const republished = verificationState(provenance, { ...present, catalogRevision: moved, pool: same }, false);
    expect(republished).toMatchObject({ status: "current", changes: { runtimeChanged: false, catalogChanged: true } });
  });

  test("a moved catalog that dropped a routed model asks for a check before the launch, and the recorded one never reads as dropping any", () => {
    const dropped = verificationState(provenance, { ...present, catalogRevision: moved, unpublished: ["openai-codex/terra"], pool: same }, false);
    expect(dropped).toMatchObject({ status: "unpublished", changes: { catalogChanged: true, unpublished: ["openai-codex/terra"] } });
    expect(nextLaunchStep(facts({}, dropped.status)).step).toBe("verify");
    expect(launchStatusText(facts({}, dropped.status))).toBe("OMP no longer lists a model this profile uses; Launch checks the models again first.");
    // The revision the verification recorded publishes every model it laddered, so a list read against it claims nothing.
    expect(verificationState(provenance, { ...present, unpublished: ["openai-codex/terra"], pool: same }, false).status).toBe("current");
  });

  test("a provider added or removed, the same providers through other accounts, or no account at all is an account change", () => {
    const added = verificationState(provenance, { ...present, pool: { providers: [...same.providers, "deepseek"], poolIdentityDigest: "c".repeat(64) } }, false);
    expect([added.status, added.changes.providersAdded, added.changes.identitiesChanged]).toEqual(["accounts-changed", ["deepseek"], false]);
    const removed = verificationState(provenance, { ...present, pool: { providers: ["anthropic"], poolIdentityDigest: "c".repeat(64) } }, false);
    expect([removed.status, removed.changes.providersRemoved]).toEqual(["accounts-changed", ["openai-codex"]]);
    const reidentified = verificationState(provenance, { ...present, pool: { ...same, poolIdentityDigest: "d".repeat(64) } }, false);
    expect([reidentified.status, reidentified.changes.identitiesChanged]).toEqual(["accounts-changed", true]);
    expect(verificationState(provenance, { ...present, pool: "none" }, false).changes.providersRemoved).toEqual(["anthropic", "openai-codex"]);
  });

  test("an observation not yet answered or failed never claims a change", () => {
    expect(verificationState(provenance, { inventoryArtifactSha256: null, catalogRevision: null, unpublished: null, pool: null }, false).status).toBe("current");
    // A moved catalog whose published list is still being read claims no dropped model.
    expect(verificationState(provenance, { ...present, catalogRevision: moved, unpublished: null, pool: same }, false))
      .toMatchObject({ status: "current", changes: { catalogChanged: true, unpublished: [] } });
    expect(verificationState(provenance, { ...present, pool: null }, false).changes).toMatchObject({ providersAdded: [], providersRemoved: [], identitiesChanged: false });
  });

  test("while the destination has not answered, the launch is not ready, so a gap in the observation never opens one", () => {
    expect(operationReady(null, LAUNCH_OPERATION_ID)).toBe(false);
    expect(nextLaunchStep(facts({ launchReady: false })).reason?.code).toBe("permissions");
    expect(nextLaunchStep(facts({ queries: { setup: { error: "unreadable" } } })).reason?.code).toBe("sessions");
  });
});

/**
 * A verified, saved, launchable workbench; each test changes only what it is about. `status` is the list's standing: one that
 * passed a check unless it was never checked; `verifying` is a check of a list that cannot serve, still running.
 */
function facts(changes: Partial<LaunchFacts> = {}, status: VerificationStatus = "current", ready = true): LaunchFacts {
  const held = status === "verifying" ? "unverified" : status;
  return { configurationCurrent: true, unsaved: false, stale: false, writable: true, placeable: true, available: true, accounts: "usable", launchReady: true, previewCurrent: false,
    profile: { source: "active" }, localDraft: null, record: { active: {} }, localReview: {}, skillProblems: [],
    queries: { setup: { error: null } }, verification: { status, held, passed: held !== "unverified", mode: null, ready }, unservedLead: null, ...changes };
}
const claude = { provider: "anthropic", family: "anthropic", roles: ["reviewer"] };

describe("the next launch step with the model check", () => {
  test("a check precedes save and review whenever the list in use cannot serve a launch, and the Launch press runs it", () => {
    for (const status of ["unverified", "unpublished"] as const) {
      expect(nextLaunchStep(facts({}, status)).step).toBe("verify");
      // The bundled preview and an unsaved edit both check before anything saves.
      expect(nextLaunchStep(facts({ unsaved: true, profile: { source: "starter" }, localDraft: { source: "starter" }, record: null }, status)).step).toBe("verify");
      expect(nextLaunchStep(facts({ unsaved: true, localDraft: { source: "active" } }, status)).step).toBe("verify");
    }
    expect(launchStatusText(facts({}, "unverified"))).toBe("Launch first checks which models your accounts can use.");
    expect(nextLaunchStep(facts()).step).toBe("review");
    expect(nextLaunchStep(facts({ previewCurrent: true })).step).toBe("launch");
    expect(nextLaunchStep(facts({ unsaved: true, localDraft: { source: "active" } })).step).toBe("save");
    // A bundled preview is never saved directly, even when a check is somehow current.
    expect(nextLaunchStep(facts({ unsaved: true, profile: { source: "starter" }, localDraft: { source: "starter" } }))).toMatchObject({ step: "blocked", reason: { code: "unsaved" } });
  });

  test("a list that passed a check keeps serving while only the accounts changed, unless the door would refuse a lead", () => {
    expect(nextLaunchStep(facts({}, "accounts-changed")).step).toBe("review");
    expect(nextLaunchStep(facts({ previewCurrent: true }, "accounts-changed")).step).toBe("launch");
    expect(nextLaunchStep(facts({ unsaved: true, localDraft: { source: "active" } }, "accounts-changed")).step).toBe("save");
    // A lead the changed accounts no longer serve is refused by the session door, so the press checks first.
    expect(nextLaunchStep(facts({ unservedLead: claude }, "accounts-changed")).step).toBe("verify");
    expect(launchStatusText(facts({ unservedLead: claude }, "accounts-changed"))).toBe("Accounts changed since the models were checked; Launch checks them again first.");
    // A list that never passed one (imported) has nothing to keep serving with.
    expect(nextLaunchStep(facts({ verification: { status: "accounts-changed", held: "accounts-changed", passed: false, mode: null, ready: true } })).step).toBe("verify");
    // A check running beside it, the panel's own, holds nothing up.
    expect(nextLaunchStep(facts({ previewCurrent: true, verification: { status: "verifying", held: "accounts-changed", passed: true, mode: "background", ready: true } })).step).toBe("launch");
  });

  test("configuration and a staged catalog still come first, and the check has its own preconditions in order", () => {
    expect(nextLaunchStep(facts({ configurationCurrent: false }, "unverified")).reason?.code).toBe("configuration");
    expect(nextLaunchStep(facts({ profile: { source: "draft" }, record: { draft: {} } }, "unverified")).reason?.code).toBe("staged");
    expect(nextLaunchStep(facts({}, "verifying")).reason?.code).toBe("verifying");
    expect(nextLaunchStep(facts({ writable: false, stale: true }, "unverified")).reason?.code).toBe("read-only");
    expect(nextLaunchStep(facts({ stale: true, available: false }, "unverified")).reason?.code).toBe("conflict");
    expect(nextLaunchStep(facts({ available: false }, "unverified")).reason?.code).toBe("unavailable");
    expect(nextLaunchStep(facts({ queries: { setup: { error: "unreadable" } } }, "unverified"))).toMatchObject({ reason: { code: "verify-status", action: "refresh" } });
    expect(nextLaunchStep(facts({}, "unverified", false))).toMatchObject({ reason: { code: "verify-permissions", action: "permissions" } });
    // Launch-only preconditions never block a check: it needs no launch permission, skills or local review.
    expect(nextLaunchStep(facts({ launchReady: false, skillProblems: ["x"], localReview: null }, "unpublished")).step).toBe("verify");
    // Once current, the launch order is unchanged.
    expect(nextLaunchStep(facts({ launchReady: false })).reason?.code).toBe("permissions");
  });

  test("a staged-only workspace waits in Models even when its staged catalog seats no team", () => {
    // A text-only staged catalog forms no selection, so no profile: the record still says it is staged.
    const unseated = facts({ unsaved: true, profile: null, localDraft: null, record: { draft: {}, active: null }, localReview: null }, "unverified");
    expect(nextLaunchStep(unseated)).toMatchObject({ step: "blocked", reason: { code: "staged", action: "models" } });
    expect(launchStatusText(unseated)).toBe(nextLaunchStep(unseated).reason!.text);
    // Beside an active catalog a staged one changes nothing: the active profile verifies and launches as before.
    expect(nextLaunchStep(facts({ record: { active: {}, draft: {} } })).step).toBe("review");
  });
});

describe("a first verification that stops before it saves", () => {
  // The bundled first-use draft, frozen while the workspace had no shared choices (revision 0).
  const starter: DraftBase = { source: "starter", revision: 0, initialized: false, catalogDigest: null, draftDigest: null, baseSelection: null, metadataKey: "bundled" };
  // The record an initialization makes: choices exist, nothing chosen or staged yet.
  const initialized: SharedBase = { revision: 1, initialized: true, catalogDigest: null, draftDigest: null, selection: null, metadataKey: "bundled" };
  const step = (draft: DraftBase | null, shared: SharedBase) => nextLaunchStep(facts({ unsaved: true, profile: { source: "starter" },
    localDraft: { source: "starter" }, record: null, stale: draft !== null && draftStale(draft, shared) }, "unverified"));

  test("its own initialization offers the check again, whether it stopped before the charge or after", () => {
    // Stopped at the inventory: the stop's evidence names the initialization.
    expect(step(followInitialization(starter, 0, ownInitialization(true, null, 1)!), initialized).step).toBe("verify");
    // Cancelled at the charge: the charge was made at the initialized revision.
    expect(step(followInitialization(starter, 0, ownInitialization(true, 1, null)!), initialized).step).toBe("verify");
    // Stopped after staging: the charge's revision is the initialization, never the later staged one.
    expect(ownInitialization(true, 1, 3)).toBe(1);
  });

  test("a change by anyone else still reads as a conflict", () => {
    // Initialized by another writer: no run of this panel reported it.
    expect(step(starter, initialized)).toMatchObject({ step: "blocked", reason: { code: "conflict" } });
    // A run on a workspace that already had choices initialized nothing, whatever its evidence says.
    expect(ownInitialization(false, 4, 4)).toBeNull();
    // Another write after this run's own initialization: a catalog staged at revision 2.
    expect(step(followInitialization(starter, 0, 1), { ...initialized, revision: 2, draftDigest: "d".repeat(64) }))
      .toMatchObject({ step: "blocked", reason: { code: "conflict" } });
    // A report from another starting revision is not this draft's to follow.
    expect(followInitialization(starter, 5, 6)).toBe(starter);
  });
});

describe("a local edit of the saved team and later writes to the record", () => {
  const selection = { lane: { kind: "mixed" }, capability: 3, thinking: "high", advisor: "glance", spark: true, priority: false, prewalk: false,
    planYolo: false, fallback: true, budget: "any" } as const;
  // A dial edit made at revision 7, on the saved team and the active catalog.
  const edit: DraftBase = { source: "active", revision: 7, initialized: true, catalogDigest: "a".repeat(64), draftDigest: null, baseSelection: selection, metadataKey: null };
  const record: SharedBase = { revision: 7, initialized: true, catalogDigest: "a".repeat(64), draftDigest: null, selection, metadataKey: null };

  test("an account edit, own or anyone's, is no conflict: the draft's base moves to the new revision, so its save's CAS holds", () => {
    const accountsChanged = { ...record, revision: 8 };
    expect(draftStale(edit, accountsChanged)).toBe(false);
    expect(followRecord(edit, accountsChanged)).toEqual({ ...edit, revision: 8 });
    expect(followRecord(edit, record)).toBe(edit);
  });

  test("a foreign write of the selection or a catalog is a conflict, and the draft keeps its base", () => {
    const selected = { ...record, revision: 8, selection: { ...selection, thinking: "max" as const } };
    const staged = { ...record, revision: 8, draftDigest: "d".repeat(64) };
    for (const foreign of [selected, staged]) {
      expect(draftStale(edit, foreign)).toBe(true);
      expect(followRecord(edit, foreign)).toBe(edit);
    }
  });
});

describe("this panel's own writes of the model list in Models", () => {
  const selection = { lane: { kind: "mixed" }, capability: 3, thinking: "high", advisor: "glance", spark: true, priority: false, prewalk: false,
    planYolo: false, fallback: true, budget: "any" } as const;
  const imported = "i".repeat(64), inUse = "a".repeat(64), other = "d".repeat(64);
  // The bundled first-use preview, frozen while the workspace had no shared choices (revision 0).
  const starter: DraftBase = { source: "starter", revision: 0, initialized: false, catalogDigest: null, draftDigest: null, baseSelection: null, metadataKey: "bundled" };
  // An imported list: the import initializes the workspace (0 → 1) and stages the list (→ 2), and use staged list promotes it (→ 3).
  const initialized: SharedBase = { revision: 1, initialized: true, catalogDigest: null, draftDigest: null, selection: null, metadataKey: "bundled" };
  const staged: SharedBase = { revision: 2, initialized: true, catalogDigest: null, draftDigest: imported, selection: null, metadataKey: "bundled" };
  const promoted: SharedBase = { revision: 3, initialized: true, catalogDigest: imported, draftDigest: null, selection, metadataKey: "bundled" };
  // A draft showing a team: an edit when that team is not the one shown without it (draft-store.ts `editedDraft`), here
  // the saved team or, with none saved, the list's default `selection`.
  const edited: Selection = { ...selection, thinking: "max" };
  const showing = (draft: DraftBase, team: Selection): ProfileDraft => ({ ...draft, selection: team, document: { schemaVersion: 1, models: [] }, metadata: null });
  const holds = (draft: ProfileDraft, write: CatalogWrite) => editHoldsCatalogWrite(draft, editedDraft(draft, selection), write);

  test("a list imported on a first-use workspace replaces the untouched bundled preview, staged and then in use", () => {
    expect(followCatalogWrite(followCatalogWrite(starter, 0, initialized), 1, staged)).toBeNull();
    // An untouched preview of the staged list gives way when that list is put in use, replaced or discarded.
    const stagedPreview: DraftBase = { source: "draft", revision: 2, initialized: true, catalogDigest: null, draftDigest: imported, baseSelection: null, metadataKey: null };
    expect(followCatalogWrite(stagedPreview, 2, promoted)).toBeNull();
    expect(followCatalogWrite(stagedPreview, 2, { ...staged, revision: 3, draftDigest: other })).toBeNull();
    expect(followCatalogWrite(stagedPreview, 2, { ...staged, revision: 3, draftDigest: null })).toBeNull();
  });

  test("an import whose stage is refused after its own initialization leaves the preview on that initialization, never a conflict", () => {
    // The import initialized the absent workspace (0 → 1); its stage was then refused, so nothing is staged.
    const followed = followCatalogWrite(starter, 0, initialized);
    // The preview follows it as it follows a stopped first verification's initialization.
    expect(followed).toEqual(followInitialization(starter, 0, 1));
    const step = (draft: DraftBase) => nextLaunchStep(facts({ unsaved: true, profile: { source: "starter" }, localDraft: { source: "starter" }, record: null,
      stale: draftStale(draft, initialized) }, "unverified"));
    expect(step(followed!).step).toBe("verify");
    // Not followed, the panel's own initialization would read as a change made elsewhere.
    expect(step(starter)).toMatchObject({ step: "blocked", reason: { code: "conflict" } });
  });

  test("an unsaved edit of the team in use holds putting the staged list in use, and only that, until it is saved or discarded", () => {
    // The team was changed on the list in use at revision 7, with a list staged beside it.
    const base: DraftBase = { source: "active", revision: 7, initialized: true, catalogDigest: inUse, draftDigest: other, baseSelection: selection, metadataKey: null };
    const edit = showing(base, edited);
    expect(holds(edit, "use")).toBe(true);
    // Staging or discarding beside the list in use leaves it, so those writes go and the edit follows them.
    expect(holds(edit, "stage")).toBe(false);
    expect(holds(edit, "discard")).toBe(false);
    // Turned back to the saved team, or saved or discarded (which leave no draft), nothing holds the promotion, and an
    // untouched draft gives way to the list put in use.
    const untouched = showing(base, selection);
    expect(holds(untouched, "use")).toBe(false);
    expect(editHoldsCatalogWrite(null, false, "use")).toBe(false);
    expect(followCatalogWrite(untouched, 7, { revision: 8, initialized: true, catalogDigest: other, draftDigest: null, selection, metadataKey: null })).toBeNull();
  });

  test("an edited bundled preview holds an import, which replaces the list it was made on; an untouched one gives way", () => {
    expect(holds(showing(starter, edited), "stage")).toBe(true);
    expect(holds(showing(starter, selection), "stage")).toBe(false);
  });

  test("on a workspace with only a staged list, an edit of its preview holds using, discarding and replacing that list", () => {
    const base: DraftBase = { source: "draft", revision: 2, initialized: true, catalogDigest: null, draftDigest: imported, baseSelection: null, metadataKey: null };
    for (const write of ["use", "discard", "stage"] as const) {
      expect(holds(showing(base, edited), write)).toBe(true);
      expect(holds(showing(base, selection), write)).toBe(false);
    }
  });

  test("a list staged or discarded beside the one in use leaves an edit of it on show, at the new revision; putting another in use replaces an untouched one", () => {
    const edit: DraftBase = { source: "active", revision: 7, initialized: true, catalogDigest: inUse, draftDigest: null, baseSelection: selection, metadataKey: null };
    const beside: SharedBase = { revision: 8, initialized: true, catalogDigest: inUse, draftDigest: other, selection, metadataKey: null };
    const followed = followCatalogWrite(edit, 7, beside);
    expect(followed).toEqual({ ...edit, revision: 8, draftDigest: other });
    expect(draftStale(followed!, beside)).toBe(false);
    const discarded: SharedBase = { ...beside, revision: 9, draftDigest: null };
    expect(followCatalogWrite(followed, 8, discarded)).toEqual({ ...edit, revision: 9 });
    expect(followCatalogWrite(followed, 8, { ...beside, revision: 9, catalogDigest: other, draftDigest: null })).toBeNull();
  });

  test("a draft that no longer rested on the record when the panel wrote stays a conflict", () => {
    // Initialized elsewhere at revision 1; this panel then staged at 1 → 2.
    expect(followCatalogWrite(starter, 1, staged)).toBe(starter);
    expect(nextLaunchStep(facts({ unsaved: true, profile: { source: "starter" }, localDraft: { source: "starter" }, record: null,
      stale: draftStale(starter, staged) }, "unverified"))).toMatchObject({ step: "blocked", reason: { code: "conflict" } });
  });
});

describe("approving a check's charge", () => {
  const charge = { requests: 19 };
  const prepared = { charge, preparedAt: 10_000 };
  const at = (ms: number) => prepared.preparedAt + ms;
  test("the second click of a double-click on Launch never spends, however long the inventory took", () => {
    expect(confirmsCharge({ detail: 2, repeat: false }, charge, prepared, at(250))).toBe(false);
    expect(confirmsCharge({ detail: 2, repeat: false }, charge, prepared, at(10 * CHECKING_HOLD_MS))).toBe(false);
    expect(confirmsCharge({ detail: 3, repeat: false }, charge, prepared, at(10 * CHECKING_HOLD_MS))).toBe(false);
  });

  test("a single press approves only once the checking hold has passed, and a held key never does", () => {
    expect(confirmsCharge({ detail: 1, repeat: false }, charge, prepared, at(CHECKING_HOLD_MS - 1))).toBe(false);
    expect(confirmsCharge({ detail: 1, repeat: false }, charge, prepared, at(CHECKING_HOLD_MS))).toBe(true);
    expect(confirmsCharge({ detail: 0, repeat: false }, charge, prepared, at(CHECKING_HOLD_MS))).toBe(true);
    expect(confirmsCharge({ detail: 0, repeat: true }, charge, prepared, at(10 * CHECKING_HOLD_MS))).toBe(false);
    // Longer than the 500 ms double-click interval Windows uses by default.
    expect(CHECKING_HOLD_MS).toBeGreaterThan(500);
  });

  test("only the very charge the control showed is spent, never one of nothing", () => {
    const press = { detail: 1, repeat: false }, later = at(CHECKING_HOLD_MS);
    // A charge prepared again after the control rendered is a different charge, even with the same count.
    expect(confirmsCharge(press, { requests: 19 }, prepared, later)).toBe(false);
    expect(confirmsCharge(press, null, prepared, later)).toBe(false);
    expect(confirmsCharge(press, charge, null, later)).toBe(false);
    const nothing = { requests: 0 };
    expect(confirmsCharge(press, nothing, { charge: nothing, preparedAt: prepared.preparedAt }, later)).toBe(false);
  });
});

describe("checks the panel runs or spends on its own", () => {
  test("a charge is spent without asking only within the approval, and in the background only to renew a list that passed a check", () => {
    expect(spendsWithoutAsking("launch", false, 19, 38)).toBe(true);
    expect(spendsWithoutAsking("launch", false, 19, 39)).toBe(false);
    expect(spendsWithoutAsking("manual", false, 0, 1)).toBe(false);
    expect(spendsWithoutAsking("background", true, 19, 19)).toBe(true);
    // A first check that spends is always the person's own press, however much they approved.
    expect(spendsWithoutAsking("background", false, 19, 1)).toBe(false);
  });

  test("a background check starts only to renew a list that no longer holds, and only when it can adopt or may spend", () => {
    const due = (changes: Partial<BackgroundFacts> = {}) => backgroundCheckDue({ held: "accounts-changed", initialized: true, staged: false,
      imported: false, passed: true, adoptable: false, approvedRequests: 19, ready: true, quiet: false, ...changes });
    expect(due()).toBe(true);
    expect(due({ held: "current" })).toBe(false);
    // Never in a workspace never set up, over a staged or imported list, while not ready or after a stop.
    for (const changes of [{ initialized: false, adoptable: true }, { staged: true }, { imported: true, passed: false, adoptable: true },
      { ready: false }, { quiet: true }, { approvedRequests: null }] as const) expect(due(changes)).toBe(false);
    // A list that never passed a check is only adopted; with no approval, only a kept check makes it due.
    expect(due({ passed: false })).toBe(false);
    expect(due({ passed: false, held: "unverified", adoptable: true })).toBe(true);
    expect(due({ approvedRequests: 0 })).toBe(false);
    expect(due({ approvedRequests: 0, adoptable: true })).toBe(true);
  });
});

/** The same workbench, as the gate reads it: nothing in flight, no charge, every lead served. */
function gateFacts(changes: Partial<GateFacts> = {}, status: VerificationStatus = "current"): GateFacts {
  return { ...facts({}, status), running: false, charge: null, unservedLead: null, savedSessionId: "", planYolo: false, ...changes };
}

describe("reviewing the saved team when its inputs settle", () => {
  test("only the saved team on a list that serves a launch, with every launch precondition, reviews by itself", () => {
    expect(autoReviewDue(gateFacts(), 4, null)).toBe(true);
    expect(autoReviewDue(gateFacts({ unsaved: true, localDraft: { source: "active" } }), 4, null)).toBe(false);
    expect(autoReviewDue(gateFacts({ unsaved: true, profile: { source: "starter" }, localDraft: { source: "starter" }, record: null }), 4, null)).toBe(false);
    expect(autoReviewDue(gateFacts({ profile: { source: "draft" }, record: { draft: {} } }), 4, null)).toBe(false);
    expect(autoReviewDue(gateFacts({}, "accounts-changed"), 4, null)).toBe(true);
    expect(autoReviewDue(gateFacts({}, "unpublished"), 4, null)).toBe(false);
    expect(autoReviewDue(gateFacts({ writable: false }), 4, null)).toBe(false);
    expect(autoReviewDue(gateFacts({ launchReady: false }), 4, null)).toBe(false);
    expect(autoReviewDue(gateFacts({ previewCurrent: true }), 4, null)).toBe(false);
  });

  test("never while a step runs or a charge waits or a lead is unserved, and once per scope until an input changes", () => {
    expect(autoReviewDue(gateFacts({ running: true }), 4, null)).toBe(false);
    expect(autoReviewDue(gateFacts({ charge: { requests: 3 } }), 4, null)).toBe(false);
    expect(autoReviewDue(gateFacts({ unservedLead: { provider: "anthropic", family: "anthropic", roles: ["reviewer"] } }), 4, null)).toBe(false);
    // A refused review or launch in this scope waits for an explicit Review...
    expect(autoReviewDue(gateFacts(), 4, 4)).toBe(false);
    // ...and a changed input opens a new scope, which reviews again.
    expect(autoReviewDue(gateFacts(), 5, 4)).toBe(true);
  });
});
