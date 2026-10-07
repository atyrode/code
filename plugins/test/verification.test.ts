import { describe, expect, test } from "bun:test";
import { LAUNCH_OPERATION_ID, OMP_VERSION } from "@atyrode/manifold-omp";
import type { VerificationProvenance } from "../code/contract.ts";
import { operationReady } from "../code/permission-plan.ts";
import { autoReviewDue, draftStale, followInitialization, followRecord, launchStatusText, nextLaunchStep, type DraftBase, type GateFacts, type LaunchFacts, type SharedBase } from "../code/generator/launch-step.ts";
import { CHECKING_HOLD_MS, confirmsCharge, ownInitialization, verificationState, type VerificationStatus } from "../code/generator/verification.ts";

const runtime = "c".repeat(64), catalog = "e".repeat(64);
const provenance: VerificationProvenance = { ompVersion: OMP_VERSION, inventoryArtifactSha256: runtime, catalogRevision: catalog,
  inventoryObservedAt: 1, benchmarkCompletedAt: 2, providers: ["anthropic", "openai-codex"], poolIdentityDigest: "a".repeat(64) };
const same = { providers: ["anthropic", "openai-codex"], poolIdentityDigest: "a".repeat(64) };
const present = { inventoryArtifactSha256: runtime, catalogRevision: catalog };

describe("whether a recorded verification still holds", () => {
  test("the present OMP runtime, model catalog and pool decide, and an OMP change outranks an account change", () => {
    expect(verificationState(provenance, { ...present, pool: same }, false)).toMatchObject({ status: "current", observed: true });
    expect(verificationState(null, { ...present, pool: same }, false).status).toBe("unverified");
    expect(verificationState(provenance, { ...present, pool: same }, true).status).toBe("verifying");
    const upgraded = verificationState(provenance, { ...present, inventoryArtifactSha256: "9".repeat(64), pool: { ...same, poolIdentityDigest: "b".repeat(64) } }, false);
    expect([upgraded.status, upgraded.changes.runtimeChanged, upgraded.changes.identitiesChanged]).toEqual(["omp-changed", true, true]);
  });

  test("an OMP-only upgrade with the same accounts makes the verification stale, and Verify is the next step", () => {
    // The runtime is upgraded on the destination; Code is the same build, so its compiled OMP version has not moved.
    const upgraded = verificationState(provenance, { ...present, inventoryArtifactSha256: "9".repeat(64), pool: same }, false);
    expect(upgraded).toMatchObject({ status: "omp-changed", observed: true, changes: { runtimeChanged: true, catalogChanged: false, identitiesChanged: false } });
    expect(nextLaunchStep(facts({}, upgraded.status)).step).toBe("verify");
    expect(launchStatusText(facts({}, upgraded.status))).toBe("OMP changed since models were verified. Verify again.");
  });

  test("a new model catalog revision makes the verification stale, whatever version OMP reports", () => {
    const republished = verificationState(provenance, { ...present, catalogRevision: "f".repeat(64), pool: same }, false);
    expect(republished).toMatchObject({ status: "omp-changed", changes: { runtimeChanged: false, catalogChanged: true } });
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

  test("an observation not yet answered or failed never claims a change, and says the comparison is incomplete", () => {
    expect(verificationState(provenance, { inventoryArtifactSha256: null, catalogRevision: null, pool: null }, false)).toMatchObject({ status: "current", observed: false });
    expect(verificationState(provenance, { ...present, catalogRevision: null, pool: same }, false)).toMatchObject({ status: "current", observed: false });
    expect(verificationState(provenance, { ...present, inventoryArtifactSha256: "9".repeat(64), pool: null }, false)).toMatchObject({ status: "omp-changed", observed: false });
  });

  test("while the destination has not answered, the launch is not ready, so a gap in the observation never opens one", () => {
    expect(operationReady(null, LAUNCH_OPERATION_ID)).toBe(false);
    expect(nextLaunchStep(facts({ launchReady: false })).reason?.code).toBe("permissions");
    expect(nextLaunchStep(facts({ queries: { setup: { error: "unreadable" } } })).reason?.code).toBe("sessions");
  });
});

/** A verified, saved, launchable workbench; each test changes only what it is about. */
function facts(changes: Partial<LaunchFacts> = {}, status: VerificationStatus = "current", ready = true): LaunchFacts {
  return { configurationCurrent: true, unsaved: false, stale: false, writable: true, placeable: true, available: true, accounts: "usable", launchReady: true, previewCurrent: false,
    profile: { source: "active" }, localDraft: null, record: { active: {} }, localReview: {}, skillProblems: [],
    queries: { setup: { error: null } }, verification: { status, ready }, ...changes };
}

describe("the next launch step with verification", () => {
  test("verify precedes save and review whenever the verification is not current", () => {
    for (const status of ["unverified", "accounts-changed", "omp-changed"] as const) {
      expect(nextLaunchStep(facts({}, status)).step).toBe("verify");
      // The bundled preview and an unsaved edit both verify before anything saves.
      expect(nextLaunchStep(facts({ unsaved: true, profile: { source: "starter" }, localDraft: { source: "starter" }, record: null }, status)).step).toBe("verify");
      expect(nextLaunchStep(facts({ unsaved: true, localDraft: { source: "active" } }, status)).step).toBe("verify");
    }
    expect(nextLaunchStep(facts()).step).toBe("review");
    expect(nextLaunchStep(facts({ previewCurrent: true })).step).toBe("launch");
    expect(nextLaunchStep(facts({ unsaved: true, localDraft: { source: "active" } })).step).toBe("save");
    // A bundled preview is never saved directly, even when a verification is somehow current.
    expect(nextLaunchStep(facts({ unsaved: true, profile: { source: "starter" }, localDraft: { source: "starter" } }))).toMatchObject({ step: "blocked", reason: { code: "unsaved" } });
  });

  test("configuration and a staged catalog still come first, and verification has its own preconditions in order", () => {
    expect(nextLaunchStep(facts({ configurationCurrent: false }, "unverified")).reason?.code).toBe("configuration");
    expect(nextLaunchStep(facts({ profile: { source: "draft" }, record: { draft: {} } }, "unverified")).reason?.code).toBe("staged");
    expect(nextLaunchStep(facts({}, "verifying")).reason?.code).toBe("verifying");
    expect(nextLaunchStep(facts({ writable: false, stale: true }, "unverified")).reason?.code).toBe("read-only");
    expect(nextLaunchStep(facts({ stale: true, available: false }, "unverified")).reason?.code).toBe("conflict");
    expect(nextLaunchStep(facts({ available: false }, "unverified")).reason?.code).toBe("unavailable");
    expect(nextLaunchStep(facts({ queries: { setup: { error: "unreadable" } } }, "unverified"))).toMatchObject({ reason: { code: "verify-status", action: "refresh" } });
    expect(nextLaunchStep(facts({}, "unverified", false))).toMatchObject({ reason: { code: "verify-permissions", action: "permissions" } });
    // Launch-only preconditions never block a verification: it needs no launch permission, skills or local review.
    expect(nextLaunchStep(facts({ launchReady: false, skillProblems: ["x"], localReview: null }, "omp-changed")).step).toBe("verify");
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

  test("its own initialization offers Verify models again, whether it stopped before the charge or after", () => {
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

describe("confirming the verification charge", () => {
  const charge = { requests: 19 };
  const prepared = { charge, preparedAt: 10_000 };
  const at = (ms: number) => prepared.preparedAt + ms;
  test("the second click of a double-click on Verify never spends, however long the inventory took", () => {
    expect(confirmsCharge({ detail: 2, repeat: false }, charge, prepared, at(250))).toBe(false);
    expect(confirmsCharge({ detail: 2, repeat: false }, charge, prepared, at(10 * CHECKING_HOLD_MS))).toBe(false);
    expect(confirmsCharge({ detail: 3, repeat: false }, charge, prepared, at(10 * CHECKING_HOLD_MS))).toBe(false);
  });

  test("a single press confirms only once the checking hold has passed, and a held key never does", () => {
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

/** The same workbench, as the gate reads it: nothing in flight, no charge, every lead served. */
function gateFacts(changes: Partial<GateFacts> = {}, status: VerificationStatus = "current"): GateFacts {
  return { ...facts({}, status), running: false, charge: null, unservedLead: null, savedSessionId: "", planYolo: false, ...changes };
}

describe("reviewing the saved team when its inputs settle", () => {
  test("only the saved, verified team with every launch precondition reviews by itself", () => {
    expect(autoReviewDue(gateFacts(), 4, null)).toBe(true);
    expect(autoReviewDue(gateFacts({ unsaved: true, localDraft: { source: "active" } }), 4, null)).toBe(false);
    expect(autoReviewDue(gateFacts({ unsaved: true, profile: { source: "starter" }, localDraft: { source: "starter" }, record: null }), 4, null)).toBe(false);
    expect(autoReviewDue(gateFacts({ profile: { source: "draft" }, record: { draft: {} } }), 4, null)).toBe(false);
    expect(autoReviewDue(gateFacts({}, "accounts-changed"), 4, null)).toBe(false);
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
