import { describe, expect, test } from "bun:test";
import type { AccountReference, AccountsObservation } from "@atyrode/manifold-omp";
import { accountSelectionDisabled, checkedAccountsObservation, disabledAccountReferences, initialAccountChoices,
  reduceAccountChoices, selectedAccountPool } from "../domain/accounts.ts";
import { DomainError } from "../domain/contracts.ts";

const scope = "machine-a/broker-grant-1";
const alice: AccountReference = { kind: "identity", scope, provider: "anthropic", identityKey: "email:Alice@example.test|org:old" };
const slot: AccountReference = { kind: "credential", scope, provider: "openai", credentialId: 2 };
const snapshot: AccountsObservation = {
  scope, observedAt: 100, status: "fresh", accounts: [
    { reference: alice, credentialId: 1, identityKey: alice.identityKey, type: "oauth", email: "Alice@example.test", disabled: false, blocks: [] },
    { reference: slot, credentialId: 2, identityKey: null, type: "api_key", email: null, disabled: false, blocks: [] },
    { reference: { ...slot, credentialId: 3 }, credentialId: 3, identityKey: null, type: "api_key", email: null, disabled: false, blocks: [] },
    { reference: { kind: "identity", scope, provider: "openai-codex", identityKey: "Alice@example.test" },
      credentialId: 4, identityKey: "Alice@example.test", type: "oauth", email: null, disabled: false, blocks: [] },
  ],
};

function expectCode(run: () => unknown, code: DomainError["code"]): void {
  try {
    run();
    throw new Error("Expected domain refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe("Code account selection over explicit OMP observations", () => {
  test("freezes distinct API-key slots and actual provider identities", () => {
    let choices = reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference: slot, enabled: false });
    expect(selectedAccountPool(snapshot, choices)).toEqual({
      anthropic: [{ scope, credentialId: 1, identityKey: alice.identityKey }],
      openai: [{ scope, credentialId: 3, identityKey: null }],
      "openai-codex": [{ scope, credentialId: 4, identityKey: "Alice@example.test" }],
    });
    choices = reduceAccountChoices(choices, { kind: "set-account", reference: slot, enabled: true });
    expect(selectedAccountPool(snapshot, choices).openai).toEqual([
      { scope, credentialId: 2, identityKey: null }, { scope, credentialId: 3, identityKey: null },
    ]);
  });

  test("refuses stale references rather than broadening across identities, slots, providers or scopes", () => {
    for (const reference of [
      { ...alice, identityKey: "missing@example.test" },
      { ...alice, scope: "other-machine/broker-grant-1" },
      { ...alice, provider: "openai-codex" },
      { ...slot, credentialId: 99 },
      { ...slot, credentialId: 1, provider: "anthropic" },
    ] satisfies AccountReference[]) {
      const choices = reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference, enabled: false });
      expectCode(() => selectedAccountPool(snapshot, choices), "account_unavailable");
    }
  });

  test("re-login email protection remains provider- and service-scoped without weakening exact launch refusal", () => {
    const observation = structuredClone(snapshot);
    const identityKey = "email:alice@EXAMPLE.test|org:new";
    observation.accounts[0]!.identityKey = identityKey;
    observation.accounts[0]!.reference = { ...alice, identityKey };
    const choices = reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference: alice, enabled: false });
    const disabled = disabledAccountReferences(choices);
    expect(accountSelectionDisabled(observation.accounts[0]!, disabled)).toBe(true);
    expect(accountSelectionDisabled(observation.accounts[3]!, disabled)).toBe(false);
    const elsewhere = { ...observation.accounts[0]!, reference: { ...observation.accounts[0]!.reference, scope: "other-scope" } };
    expect(accountSelectionDisabled(elsewhere, disabled)).toBe(false);
    expectCode(() => selectedAccountPool(observation, choices), "account_unavailable");
    const enabled = reduceAccountChoices(choices, { kind: "set-account", reference: observation.accounts[0]!.reference, enabled: true });
    expect(selectedAccountPool(observation, enabled).anthropic).toEqual([{ scope, credentialId: 1, identityKey }]);
  });

  test("uses preset IDs, rejects case-folded name conflicts and preserves selection on active deletion", () => {
    const initial = initialAccountChoices();
    const manual = reduceAccountChoices(initial, { kind: "set-account", reference: slot, enabled: false });
    const named = reduceAccountChoices(manual, { kind: "create-preset", preset: { id: "preset-1", name: "Manual", disabled: [alice] } });
    expectCode(() => reduceAccountChoices(named, { kind: "create-preset", preset: { id: "preset-2", name: " manual ", disabled: [] } }), "preset_exists");
    expectCode(() => reduceAccountChoices(named, { kind: "activate-preset", id: "Manual" }), "preset_missing");
    const active = reduceAccountChoices(named, { kind: "activate-preset", id: "preset-1" });
    const renamed = reduceAccountChoices(active, { kind: "update-preset", preset: { id: "preset-1", name: "Focus", disabled: [alice] } });
    expect(renamed.activePreset).toBe("preset-1");
    const deleted = reduceAccountChoices(renamed, { kind: "delete-preset", id: "preset-1" });
    expect(deleted.activePreset).toBeNull();
    expect(selectedAccountPool(snapshot, deleted)).toEqual(selectedAccountPool(snapshot, renamed));
    expect(initial.manualDisabled).toEqual([]);
    expect(manual.presets).toEqual([]);
    expect(named.presets[0]!.name).toBe("Manual");
    deleted.manualDisabled[0]!.scope = "mutated";
    expect(renamed.presets[0]!.disabled[0]!.scope).toBe(scope);
    expectCode(() => reduceAccountChoices(named, { kind: "update-preset", preset: { id: "absent", name: "Other", disabled: [] } }), "preset_missing");
  });

  test("edits the active preset without overwriting saved manual choices", () => {
    const manual = reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference: slot, enabled: false });
    const created = reduceAccountChoices(manual, { kind: "create-preset", preset: { id: "p", name: "Work", disabled: [] } });
    const active = reduceAccountChoices(created, { kind: "activate-preset", id: "p" });
    const edited = reduceAccountChoices(active, { kind: "set-account", reference: alice, enabled: false });
    expect(disabledAccountReferences(edited)).toEqual([alice]);
    expect(disabledAccountReferences(reduceAccountChoices(edited, { kind: "activate-preset", id: null }))).toEqual([slot]);
    expect(disabledAccountReferences(active)).toEqual([]);
  });

  test("rejects duplicate credentials and identities, inconsistent references and credential-bearing observations", () => {
    const oauth = snapshot.accounts[0]!, key = snapshot.accounts[1]!;
    const invalid = [
      [oauth, oauth], [oauth, { ...oauth, credentialId: 8 }],
      [{ ...oauth, identityKey: null }], [{ ...key, identityKey: "invented-api-identity" }],
      [{ ...key, reference: { ...slot, credentialId: 9 } }],
      [{ ...oauth, reference: { ...alice, scope: "elsewhere" } }],
      [{ ...key, key: "secret" }], [{ ...oauth, accessToken: "secret" }],
      [{ ...oauth, disabled: "false" }],
      [{ ...oauth, blocks: [{ scope: "chat", until: 101 }, { scope: "chat", until: 102 }] }],
    ];
    for (const accounts of invalid) expectCode(() => checkedAccountsObservation({ ...snapshot, accounts } as AccountsObservation), "invalid_accounts");
  });

  test("retains unknown providers explicitly but never selects unavailable or stale observations", () => {
    const observation: AccountsObservation = { ...snapshot, accounts: [{
      reference: { kind: "credential", scope, provider: "new-provider", credentialId: 10 },
      credentialId: 10, identityKey: null, type: "api_key", email: null, disabled: false,
      blocks: [{ scope: "tier:future", until: 101 }],
    }] };
    expect(selectedAccountPool(observation, initialAccountChoices())["new-provider"]).toEqual([{ scope, credentialId: 10, identityKey: null }]);
    expectCode(() => selectedAccountPool({ scope, status: "unavailable", observedAt: null, accounts: [] }, initialAccountChoices()), "account_unavailable");
    expectCode(() => selectedAccountPool({ ...snapshot, status: "stale" }, initialAccountChoices()), "account_unavailable");
    expectCode(() => selectedAccountPool({ ...snapshot, observedAt: null }, initialAccountChoices()), "invalid_accounts");
  });
});
