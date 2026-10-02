import type { VerificationProvenance } from "../contract.ts";

/**
 * Whether the active catalog's verification still describes the world a launch would meet.
 *
 * `unverified`: no verification is recorded — no active catalog, or one authored, imported or
 * kept from before verification existed. `verifying`: a verification is in flight, including
 * while its charge awaits confirmation. `omp-changed`: OMP now serves another version's model
 * list than the one the catalog was probed against. `accounts-changed`: the saved choices now
 * select another pool — a provider added or removed, or the same providers through different
 * accounts. `current`: none of those.
 */
export type VerificationStatus = "unverified" | "verifying" | "current" | "accounts-changed" | "omp-changed";
/** The present a recorded verification is compared with. A null field has not been observed. */
export type VerificationObservation = {
  /** The OMP version whose bundled model list OMP serves now. */
  ompVersion: string | null;
  /** The pool the saved choices select now, or `"none"` when they select no account at all. */
  pool: { providers: readonly string[]; poolIdentityDigest: string } | "none" | null;
};
/** What differs from the recorded verification, for saying why it no longer holds. */
export type VerificationChanges = {
  ompVersion: { verified: string; current: string } | null;
  providersAdded: string[];
  providersRemoved: string[];
  /** The same providers are covered, by a different exact set of accounts. */
  identitiesChanged: boolean;
};
export type VerificationState = {
  status: VerificationStatus;
  changes: VerificationChanges;
  /**
   * Both facts the comparison needs have been observed. While one is missing, `current` rests on
   * the record alone: an observation that is slow or failing is not evidence that anything
   * changed, and the launch itself re-checks accounts and published models at its owner.
   */
  observed: boolean;
};

/**
 * Compares a recorded verification with the present. An OMP change outranks an account change,
 * because a different model list invalidates every provider's answers, not only one pool's.
 */
export function verificationState(provenance: VerificationProvenance | null, observation: VerificationObservation, verifying: boolean): VerificationState {
  const changes: VerificationChanges = { ompVersion: null, providersAdded: [], providersRemoved: [], identitiesChanged: false };
  const observed = observation.ompVersion !== null && observation.pool !== null;
  if (verifying) return { status: "verifying", changes, observed };
  if (provenance === null) return { status: "unverified", changes, observed };
  if (observation.ompVersion !== null && observation.ompVersion !== provenance.ompVersion)
    changes.ompVersion = { verified: provenance.ompVersion, current: observation.ompVersion };
  if (observation.pool !== null) {
    const providers = observation.pool === "none" ? [] : observation.pool.providers;
    changes.providersAdded = providers.filter(provider => !provenance.providers.includes(provider));
    changes.providersRemoved = provenance.providers.filter(provider => !providers.includes(provider));
    changes.identitiesChanged = observation.pool !== "none" && changes.providersAdded.length === 0 && changes.providersRemoved.length === 0 &&
      observation.pool.poolIdentityDigest !== provenance.poolIdentityDigest;
  }
  const accountsChanged = changes.providersAdded.length > 0 || changes.providersRemoved.length > 0 || changes.identitiesChanged;
  return { status: changes.ompVersion ? "omp-changed" : accountsChanged ? "accounts-changed" : "current", changes, observed };
}
