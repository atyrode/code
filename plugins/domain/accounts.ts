import { z } from "zod";
import {
  AccountChoiceChangeSchema, AccountChoicesSchema, AccountsObservationSchema,
  DomainError, epochMilliseconds, identifier, RuntimeAccountPoolSchema,
  type AccountChoiceChange, type AccountChoices, type AccountRecord,
  type AccountReference, type AccountsObservation, type RuntimeAccountPool,
} from "./contracts.ts";

const nonblank = z.string().min(1).max(1024).refine(value => value.trim().length > 0);
const slot = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** Only native, secret-free broker metadata may cross this seam. */
export const ProjectedBrokerSnapshotSchema = z.strictObject({
  credentials: z.array(z.strictObject({
    id: slot,
    provider: identifier,
    identityKey: nonblank.nullable(),
    credential: z.strictObject({
      type: z.enum(["oauth", "api_key"]),
      email: z.string().max(512).nullable().optional(),
    }),
    disabled: z.boolean().optional(),
    blocks: z.array(z.strictObject({
      blockScope: z.string().max(128),
      blockedUntilMs: epochMilliseconds,
    })).max(64).optional(),
  })).max(1024),
});
export type ProjectedBrokerSnapshot = z.infer<typeof ProjectedBrokerSnapshotSchema>;

function referenceKey(reference: AccountReference): string {
  return JSON.stringify([reference.scope, reference.provider, reference.kind,
    reference.kind === "identity" ? reference.identityKey : reference.credentialId]);
}

function email(identity: string): string | null {
  const value = identity.startsWith("email:") ? identity.slice(6).split("|")[0]! : identity;
  return value.includes("@") && !value.includes("|") ? value.toLowerCase() : null;
}

function sameDisabledIdentity(left: AccountReference, right: AccountReference): boolean {
  if (left.scope !== right.scope || left.provider !== right.provider || left.kind !== right.kind) return false;
  if (referenceKey(left) === referenceKey(right)) return true;
  if (left.kind !== "identity" || right.kind !== "identity") return false;
  const leftEmail = email(left.identityKey);
  return leftEmail !== null && leftEmail === email(right.identityKey);
}

function uniqueReferences(references: AccountReference[]): void {
  const seen = new Set<string>();
  for (const reference of references) {
    const key = referenceKey(reference);
    if (seen.has(key) || !reference.scope.trim() ||
      (reference.kind === "identity" && !reference.identityKey.trim())) throw new DomainError("invalid_choices");
    seen.add(key);
  }
}

function parseChoices(raw: AccountChoices): AccountChoices {
  const parsed = AccountChoicesSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError("invalid_choices");
  const choices = parsed.data;
  uniqueReferences(choices.manualDisabled);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const preset of choices.presets) {
    if (ids.has(preset.id) || names.has(preset.name.toLowerCase())) throw new DomainError("invalid_choices");
    ids.add(preset.id);
    names.add(preset.name.toLowerCase());
    uniqueReferences(preset.disabled);
  }
  if (choices.activePreset !== null && !ids.has(choices.activePreset)) throw new DomainError("preset_missing");
  return choices;
}

function currentDisabled(choices: AccountChoices): AccountReference[] {
  return choices.activePreset === null ? choices.manualDisabled :
    choices.presets.find(preset => preset.id === choices.activePreset)!.disabled;
}

export function initialAccountChoices(): AccountChoices {
  return { activePreset: null, manualDisabled: [], presets: [] };
}

/** Pure edit: no persistence, revision arbitration, or observation is implied. */
export function reduceAccountChoices(state: AccountChoices, change: AccountChoiceChange): AccountChoices {
  const choices = parseChoices(state);
  const parsed = AccountChoiceChangeSchema.safeParse(change);
  if (!parsed.success) throw new DomainError("invalid_choices");
  const edit = parsed.data;
  switch (edit.kind) {
    case "set-account": {
      const disabled = currentDisabled(choices);
      const next = edit.enabled ? disabled.filter(reference => !sameDisabledIdentity(reference, edit.reference)) :
        disabled.some(reference => referenceKey(reference) === referenceKey(edit.reference)) ? disabled : [...disabled, edit.reference];
      if (choices.activePreset === null) choices.manualDisabled = next;
      else choices.presets.find(preset => preset.id === choices.activePreset)!.disabled = next;
      break;
    }
    case "create-preset":
    case "update-preset": {
      const index = choices.presets.findIndex(preset => preset.id === edit.preset.id);
      if (edit.kind === "create-preset" && index !== -1) throw new DomainError("preset_exists");
      if (edit.kind === "update-preset" && index === -1) throw new DomainError("preset_missing");
      if (choices.presets.some(preset => preset.id !== edit.preset.id &&
        preset.name.toLowerCase() === edit.preset.name.toLowerCase())) throw new DomainError("preset_exists");
      uniqueReferences(edit.preset.disabled);
      if (index === -1) choices.presets.push(edit.preset);
      else choices.presets[index] = edit.preset;
      break;
    }
    case "activate-preset":
      if (edit.id !== null && !choices.presets.some(preset => preset.id === edit.id)) throw new DomainError("preset_missing");
      choices.activePreset = edit.id;
      break;
    case "delete-preset": {
      const index = choices.presets.findIndex(preset => preset.id === edit.id);
      if (index === -1) throw new DomainError("preset_missing");
      // Keep the current selection when deleting its name; never silently enable accounts.
      if (choices.activePreset === edit.id) {
        choices.manualDisabled = choices.presets[index]!.disabled;
        choices.activePreset = null;
      }
      choices.presets.splice(index, 1);
      break;
    }
  }
  return parseChoices(choices);
}

/** The caller owns freshness policy and must not pass an expired read as a fresh observation. */
export function projectAccounts(
  rawProjectedBrokerSnapshot: unknown, scope: string, observedAtMs: number | null, nowMs: number,
): AccountsObservation {
  if (!nonblank.safeParse(scope).success || !epochMilliseconds.safeParse(nowMs).success ||
    (observedAtMs !== null && (!epochMilliseconds.safeParse(observedAtMs).success || observedAtMs > nowMs))) {
    throw new DomainError("invalid_accounts");
  }
  if (rawProjectedBrokerSnapshot === null) return { scope, observedAt: null, status: "unavailable", accounts: [] };
  const parsed = ProjectedBrokerSnapshotSchema.safeParse(rawProjectedBrokerSnapshot);
  if (!parsed.success) throw new DomainError("invalid_accounts");
  const ids = new Set<number>();
  const identities = new Set<string>();
  const accounts: AccountRecord[] = [];
  for (const row of parsed.data.credentials) {
    const type = row.credential.type;
    if (ids.has(row.id) || (type === "oauth" ? row.identityKey === null : row.identityKey !== null)) {
      throw new DomainError("invalid_accounts");
    }
    ids.add(row.id);
    const reference: AccountReference = type === "oauth" ?
      { kind: "identity", scope, provider: row.provider, identityKey: row.identityKey! } :
      { kind: "credential", scope, provider: row.provider, credentialId: row.id };
    const key = referenceKey(reference);
    if (identities.has(key)) throw new DomainError("invalid_accounts");
    identities.add(key);
    const blockScopes = new Set<string>();
    const blocks: AccountRecord["blocks"] = [];
    for (const block of row.blocks ?? []) {
      if (blockScopes.has(block.blockScope)) throw new DomainError("invalid_accounts");
      blockScopes.add(block.blockScope);
      if (block.blockedUntilMs > nowMs) blocks.push({ scope: block.blockScope, until: block.blockedUntilMs });
    }
    blocks.sort((left, right) => right.until - left.until);
    accounts.push({ reference, credentialId: row.id, type, identityKey: row.identityKey,
      email: row.credential.email ?? null, disabled: row.disabled ?? false, blocks });
  }
  return { scope, observedAt: observedAtMs, status: observedAtMs === null ? "stale" : "fresh", accounts };
}

/** Validate stored observations too: public schemas alone cannot express cross-record identity invariants. */
export function checkedAccountsObservation(raw: AccountsObservation): AccountsObservation {
  const parsed = AccountsObservationSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError("invalid_accounts");
  const observation = parsed.data;
  if ((observation.status === "fresh" && observation.observedAt === null) ||
    (observation.status === "unavailable" && (observation.accounts.length !== 0 || observation.observedAt !== null))) {
    throw new DomainError("invalid_accounts");
  }
  const projected = projectAccounts({ credentials: observation.accounts.map(account => ({
    id: account.credentialId, provider: account.reference.provider, identityKey: account.identityKey,
    credential: { type: account.type, email: account.email }, disabled: account.disabled,
    blocks: account.blocks.map(block => ({ blockScope: block.scope, blockedUntilMs: block.until })),
  })) }, observation.scope, observation.observedAt, observation.observedAt ?? 0);
  for (let index = 0; index < observation.accounts.length; index++) {
    if (referenceKey(observation.accounts[index]!.reference) !== referenceKey(projected.accounts[index]!.reference)) {
      throw new DomainError("invalid_accounts");
    }
  }
  return observation;
}

/** Validated, detached active references, for one pass across an account observation. */
export function disabledAccountReferences(choices: AccountChoices): AccountReference[] {
  return currentDisabled(parseChoices(choices));
}

/** Includes re-login protection for display; launch additionally requires exact reference resolution. */
export function accountSelectionDisabled(account: AccountRecord, disabled: readonly AccountReference[]): boolean {
  return disabled.some(reference => sameDisabledIdentity(reference, account.reference));
}

export function selectedAccountPool(observation: AccountsObservation, choices: AccountChoices): RuntimeAccountPool {
  const accounts = checkedAccountsObservation(observation);
  const disabled = currentDisabled(parseChoices(choices));
  if (accounts.status !== "fresh") throw new DomainError("account_unavailable");
  const references = new Set(accounts.accounts.map(account => referenceKey(account.reference)));
  // A stale disabled reference is not pruned: doing so would silently widen the launch pool.
  for (const reference of disabled) {
    if (reference.scope !== accounts.scope || !references.has(referenceKey(reference))) throw new DomainError("account_unavailable");
  }
  const pool: RuntimeAccountPool = Object.create(null);
  for (const account of accounts.accounts) {
    const provider = account.reference.provider;
    pool[provider] ??= [];
    if (account.disabled || disabled.some(reference => sameDisabledIdentity(reference, account.reference))) continue;
    pool[provider]!.push({ credentialId: account.credentialId, identityKey: account.identityKey });
  }
  const parsed = RuntimeAccountPoolSchema.safeParse(pool);
  if (!parsed.success) throw new DomainError("invalid_accounts");
  return parsed.data;
}
