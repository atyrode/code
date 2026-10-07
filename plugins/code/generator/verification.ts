import type { VerificationProvenance } from "../contract.ts";

/**
 * Whether the active catalog's verification still describes the world a launch would meet.
 *
 * `unverified`: no verification is recorded — no active catalog, or one authored, imported or
 * kept from before verification recorded the OMP it ran against. `verifying`: a verification is
 * in flight, including while its charge awaits confirmation. `omp-changed`: the destination's OMP
 * now runs from another artifact than the one the catalog's inventory ran from, or OMP bundles
 * another model catalog than it did then — an upgrade of the runtime, its SDK or its model list,
 * whatever version it reports. `accounts-changed`: the saved choices now select another pool — a
 * provider added or removed, or the same providers through different accounts. `current`: none
 * of those.
 */
export type VerificationStatus = "unverified" | "verifying" | "current" | "accounts-changed" | "omp-changed";
/** The present a recorded verification is compared with. A null field has not been observed. */
export type VerificationObservation = {
  /** The artifact the destination's OMP inventory operation is installed from (workflow.ts `inventoryArtifact`). */
  inventoryArtifactSha256: string | null;
  /** The revision of the model catalog OMP bundles (`readModelCatalog`). */
  catalogRevision: string | null;
  /** The pool the saved choices select now, or `"none"` when they select no account at all. */
  pool: { providers: readonly string[]; poolIdentityDigest: string } | "none" | null;
};
/** What differs from the recorded verification, for saying why it no longer holds. */
export type VerificationChanges = {
  /** The destination's OMP runs from another artifact than the inventory did. */
  runtimeChanged: boolean;
  /** OMP bundles another model catalog than it did when the inventory ran. */
  catalogChanged: boolean;
  providersAdded: string[];
  providersRemoved: string[];
  /** The same providers are covered, by a different exact set of accounts. */
  identitiesChanged: boolean;
};
export type VerificationState = {
  status: VerificationStatus;
  changes: VerificationChanges;
  /**
   * Every fact the comparison needs has been observed. While one is missing — not yet answered,
   * or failed — `current` rests on the record alone: an observation that is slow or failing is
   * not evidence that anything changed, its failure is named where that read's failures are, and
   * the launch itself re-checks accounts and published models at its owner.
   */
  observed: boolean;
};

/**
 * Compares a recorded verification with the present. An OMP change outranks an account change,
 * because a different model list invalidates every provider's answers, not only one pool's.
 */
export function verificationState(provenance: VerificationProvenance | null, observation: VerificationObservation, verifying: boolean): VerificationState {
  const changes: VerificationChanges = { runtimeChanged: false, catalogChanged: false, providersAdded: [], providersRemoved: [], identitiesChanged: false };
  const observed = observation.inventoryArtifactSha256 !== null && observation.catalogRevision !== null && observation.pool !== null;
  if (verifying) return { status: "verifying", changes, observed };
  if (provenance === null) return { status: "unverified", changes, observed };
  changes.runtimeChanged = observation.inventoryArtifactSha256 !== null && observation.inventoryArtifactSha256 !== provenance.inventoryArtifactSha256;
  changes.catalogChanged = observation.catalogRevision !== null && observation.catalogRevision !== provenance.catalogRevision;
  if (observation.pool !== null) {
    const providers = observation.pool === "none" ? [] : observation.pool.providers;
    changes.providersAdded = providers.filter(provider => !provenance.providers.includes(provider));
    changes.providersRemoved = provenance.providers.filter(provider => !providers.includes(provider));
    changes.identitiesChanged = observation.pool !== "none" && changes.providersAdded.length === 0 && changes.providersRemoved.length === 0 &&
      observation.pool.poolIdentityDigest !== provenance.poolIdentityDigest;
  }
  const accountsChanged = changes.providersAdded.length > 0 || changes.providersRemoved.length > 0 || changes.identitiesChanged;
  return { status: changes.runtimeChanged || changes.catalogChanged ? "omp-changed" : accountsChanged ? "accounts-changed" : "current", changes, observed };
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
