import { describe, expect, test } from "bun:test";
import type { VerificationProvenance } from "../code/contract.ts";
import { nextLaunchStep, type LaunchFacts } from "../code/generator/launch-step.ts";
import { verificationState, type VerificationStatus } from "../code/generator/verification.ts";

const provenance: VerificationProvenance = { ompVersion: "18.1.14", inventoryObservedAt: 1, benchmarkCompletedAt: 2,
  providers: ["anthropic", "openai-codex"], poolIdentityDigest: "a".repeat(64) };
const same = { providers: ["anthropic", "openai-codex"], poolIdentityDigest: "a".repeat(64) };

describe("whether a recorded verification still holds", () => {
  test("the present OMP version and pool decide, and an OMP change outranks an account change", () => {
    expect(verificationState(provenance, { ompVersion: "18.1.14", pool: same }, false)).toMatchObject({ status: "current", observed: true });
    expect(verificationState(null, { ompVersion: "18.1.14", pool: same }, false).status).toBe("unverified");
    expect(verificationState(provenance, { ompVersion: "18.1.14", pool: same }, true).status).toBe("verifying");
    const upgraded = verificationState(provenance, { ompVersion: "18.4.4", pool: { ...same, poolIdentityDigest: "b".repeat(64) } }, false);
    expect(upgraded.status).toBe("omp-changed");
    expect(upgraded.changes.ompVersion).toEqual({ verified: "18.1.14", current: "18.4.4" });
  });

  test("a provider added or removed, the same providers through other accounts, or no account at all is an account change", () => {
    const added = verificationState(provenance, { ompVersion: "18.1.14", pool: { providers: [...same.providers, "deepseek"], poolIdentityDigest: "c".repeat(64) } }, false);
    expect([added.status, added.changes.providersAdded, added.changes.identitiesChanged]).toEqual(["accounts-changed", ["deepseek"], false]);
    const removed = verificationState(provenance, { ompVersion: "18.1.14", pool: { providers: ["anthropic"], poolIdentityDigest: "c".repeat(64) } }, false);
    expect([removed.status, removed.changes.providersRemoved]).toEqual(["accounts-changed", ["openai-codex"]]);
    const reidentified = verificationState(provenance, { ompVersion: "18.1.14", pool: { ...same, poolIdentityDigest: "d".repeat(64) } }, false);
    expect([reidentified.status, reidentified.changes.identitiesChanged]).toEqual(["accounts-changed", true]);
    expect(verificationState(provenance, { ompVersion: "18.1.14", pool: "none" }, false).changes.providersRemoved).toEqual(["anthropic", "openai-codex"]);
  });

  test("a missing observation never claims a change, and says the comparison is incomplete", () => {
    expect(verificationState(provenance, { ompVersion: null, pool: null }, false)).toMatchObject({ status: "current", observed: false });
    expect(verificationState(provenance, { ompVersion: "18.4.4", pool: null }, false)).toMatchObject({ status: "omp-changed", observed: false });
  });
});

/** A verified, saved, launchable workbench; each test changes only what it is about. */
function facts(changes: Partial<LaunchFacts> = {}, status: VerificationStatus = "current", ready = true): LaunchFacts {
  return { configurationCurrent: true, unsaved: false, stale: false, writable: true, available: true, launchReady: true, previewCurrent: false,
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
    expect(nextLaunchStep(facts({ profile: { source: "draft" } }, "unverified")).reason?.code).toBe("staged");
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
});
