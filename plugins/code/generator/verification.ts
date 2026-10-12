import type { VerificationProvenance } from "../contract.ts";

/**
 * Whether the active catalog's verification still describes the world a launch would meet.
 *
 * `unverified`: no verification is recorded — no active catalog, or one authored, imported or
 * kept from before verification recorded the OMP it ran against. `verifying`: a verification is
 * in flight, including while its charge awaits confirmation. `unpublished`: OMP's model catalog
 * moved and no longer publishes a model the profile routes to, which the session door refuses
 * (`code_model_unpublished`). `accounts-changed`: the saved choices now select another pool — a
 * provider added or removed, or the same providers through different accounts. `current`: none
 * of those.
 *
 * An OMP update alone leaves a verification current, noted in `changes`: the destination's
 * inventory installed from another artifact, or another catalog revision that still publishes
 * every routed model. Neither shows that the models these accounts reached have moved, and an
 * update would otherwise ask every workspace to spend a verification before its next launch. The
 * session door still re-checks every routed model at launch, and Verify renews a current
 * verification on purpose.
 */
export type VerificationStatus = "unverified" | "verifying" | "current" | "accounts-changed" | "unpublished";
/** The present a recorded verification is compared with. A null field has not been observed. */
export type VerificationObservation = {
  /** The artifact the destination's OMP inventory operation is installed from (workflow.ts `inventoryArtifact`). */
  inventoryArtifactSha256: string | null;
  /** The revision of the model catalog OMP bundles (`readModelCatalog`). */
  catalogRevision: string | null;
  /**
   * The routed models OMP's catalog no longer publishes (domain/routing.ts `unpublishedModels`),
   * read only once the catalog has moved: the revision the verification recorded publishes every
   * model it laddered.
   */
  unpublished: readonly string[] | null;
  /** The pool the saved choices select now, or `"none"` when they select no account at all. */
  pool: { providers: readonly string[]; poolIdentityDigest: string } | "none" | null;
};
/** What differs from the recorded verification: why it no longer holds, or the OMP update it outlived. */
export type VerificationChanges = {
  /** The destination's OMP runs from another artifact than the inventory did. */
  runtimeChanged: boolean;
  /** OMP bundles another model catalog than it did when the inventory ran. */
  catalogChanged: boolean;
  /** The routed models, as `provider/id`, that the moved catalog no longer publishes. */
  unpublished: string[];
  providersAdded: string[];
  providersRemoved: string[];
  /** The same providers are covered, by a different exact set of accounts. */
  identitiesChanged: boolean;
};
export type VerificationState = { status: VerificationStatus; changes: VerificationChanges };

/**
 * Compares a recorded verification with the present. A routed model OMP dropped outranks an account
 * change, because the launch fails on it whichever accounts serve it. A fact not yet observed, or
 * whose read failed, claims no change, since a slow or failing read is not evidence that anything
 * moved. The destination's and the bundled list's failures are named where those reads' failures
 * are; the read of what a moved catalog publishes names none and fails open to the session door,
 * which re-checks accounts and every routed model at launch.
 */
export function verificationState(provenance: VerificationProvenance | null, observation: VerificationObservation, verifying: boolean): VerificationState {
  const changes: VerificationChanges = { runtimeChanged: false, catalogChanged: false, unpublished: [], providersAdded: [], providersRemoved: [], identitiesChanged: false };
  if (verifying) return { status: "verifying", changes };
  if (provenance === null) return { status: "unverified", changes };
  changes.runtimeChanged = observation.inventoryArtifactSha256 !== null && observation.inventoryArtifactSha256 !== provenance.inventoryArtifactSha256;
  changes.catalogChanged = observation.catalogRevision !== null && observation.catalogRevision !== provenance.catalogRevision;
  if (changes.catalogChanged) changes.unpublished = [...(observation.unpublished ?? [])];
  if (observation.pool !== null) {
    const providers = observation.pool === "none" ? [] : observation.pool.providers;
    changes.providersAdded = providers.filter(provider => !provenance.providers.includes(provider));
    changes.providersRemoved = provenance.providers.filter(provider => !providers.includes(provider));
    changes.identitiesChanged = observation.pool !== "none" && changes.providersAdded.length === 0 && changes.providersRemoved.length === 0 &&
      observation.pool.poolIdentityDigest !== provenance.poolIdentityDigest;
  }
  const accountsChanged = changes.providersAdded.length > 0 || changes.providersRemoved.length > 0 || changes.identitiesChanged;
  return { status: changes.unpublished.length > 0 ? "unpublished" : accountsChanged ? "accounts-changed" : "current", changes };
}

/**
 * The revision a stopped or cancelled verification's own initialization made, or null when it made
 * none. Only a run that found the workspace without shared choices (`absent`) initializes, and first.
 * Once its charge is answered that revision is the charge's (`charged`); before, it is the stop's
 * evidence, since nothing else had been written yet. After the charge the evidence may name a later
 * staged revision, which is never the initialization.
 */
export function ownInitialization(absent: boolean, charged: number | null, evidence: number | null): number | null {
  return absent ? charged ?? evidence : null;
}

/**
 * The least time the Verify press stays "Checking models…" before its charge can be confirmed.
 * Longer than the usual double-click interval (500 ms by default on Windows, shorter elsewhere), so
 * the second click of a double-click on Verify lands on a busy control rather than on Confirm.
 */
export const CHECKING_HOLD_MS = 700;
/** How a Confirm was activated: `detail` is the pointer's click count, 0 from the keyboard; `repeat` is a held key. */
export type ConfirmActivation = { readonly detail: number; readonly repeat: boolean };
/** A charge as the verification holds it, waiting: what it charges, and when the Verify press that prepared it came. */
export type PreparedCharge = { readonly charge: { readonly requests: number }; readonly preparedAt: number };

/**
 * Whether this activation may spend the prepared charge. Only the very charge the control showed
 * (`shown`, the object it rendered), and only if it charges at least one request: a charge that was
 * replaced, or one of nothing, is never confirmed. Only a deliberate single press counts: never the
 * second click of a multi-click, never key repeat, and never before the checking hold has passed
 * since the Verify press that prepared the charge.
 */
export function confirmsCharge(activation: ConfirmActivation, shown: object | null, prepared: PreparedCharge | null, nowMs: number): boolean {
  return prepared !== null && shown === prepared.charge && prepared.charge.requests > 0 &&
    activation.detail <= 1 && !activation.repeat && nowMs - prepared.preparedAt >= CHECKING_HOLD_MS;
}
