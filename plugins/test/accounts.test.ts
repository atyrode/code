import { describe, expect, test } from "bun:test";
import { accountSelectionDisabled, disabledAccountReferences, initialAccountChoices,
  projectAccounts, reduceAccountChoices, selectedAccountPool } from "../domain/accounts.ts";
import { DomainError, type AccountReference } from "../domain/contracts.ts";

const scope = "machine-a/broker-grant-1";
const alice: AccountReference = { kind: "identity", scope, provider: "anthropic", identityKey: "email:Alice@example.test|org:old" };
const slot: AccountReference = { kind: "credential", scope, provider: "openai", credentialId: 2 };
const snapshot = {
  credentials: [
    { id: 1, provider: "anthropic", identityKey: alice.identityKey, credential: { type: "oauth", email: "Alice@example.test" } },
    { id: 2, provider: "openai", identityKey: null, credential: { type: "api_key" } },
    { id: 3, provider: "openai", identityKey: null, credential: { type: "api_key" } },
    { id: 4, provider: "openai-codex", identityKey: "Alice@example.test", credential: { type: "oauth" } },
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

describe("native account selection", () => {
  test("freezes distinct API-key slots and actual provider identities", () => {
    const observation = projectAccounts(snapshot, scope, 100, 100);
    let choices = reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference: slot, enabled: false });
    expect(selectedAccountPool(observation, choices)).toEqual({
      anthropic: [{ credentialId: 1, identityKey: alice.identityKey }],
      openai: [{ credentialId: 3, identityKey: null }],
      "openai-codex": [{ credentialId: 4, identityKey: "Alice@example.test" }],
    });
    choices = reduceAccountChoices(choices, { kind: "set-account", reference: slot, enabled: true });
    expect(selectedAccountPool(observation, choices).openai).toEqual([
      { credentialId: 2, identityKey: null }, { credentialId: 3, identityKey: null },
    ]);
  });

  test("refuses stale references rather than broadening across identities, slots, providers or scopes", () => {
    const observation = projectAccounts(snapshot, scope, 100, 100);
    for (const reference of [
      { ...alice, identityKey: "missing@example.test" },
      { ...alice, scope: "other-machine/broker-grant-1" },
      { ...alice, provider: "openai-codex" },
      { ...slot, credentialId: 99 },
      { ...slot, credentialId: 1, provider: "anthropic" },
    ] satisfies AccountReference[]) {
      const choices = reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference, enabled: false });
      expectCode(() => selectedAccountPool(observation, choices), "account_unavailable");
    }
  });

  test("re-login email protection remains provider- and service-scoped without weakening exact launch refusal", () => {
    const changed = structuredClone(snapshot);
    changed.credentials[0]!.identityKey = "email:alice@EXAMPLE.test|org:new";
    const observation = projectAccounts(changed, scope, 100, 100);
    const choices = reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference: alice, enabled: false });
    const disabled = disabledAccountReferences(choices);
    expect(accountSelectionDisabled(observation.accounts[0]!, disabled)).toBe(true);
    expect(accountSelectionDisabled(observation.accounts[3]!, disabled)).toBe(false);
    const elsewhere = projectAccounts(changed, "other-scope", 100, 100);
    expect(accountSelectionDisabled(elsewhere.accounts[0]!, disabled)).toBe(false);
    expectCode(() => selectedAccountPool(observation, choices), "account_unavailable");
    const enabled = reduceAccountChoices(choices, { kind: "set-account", reference: observation.accounts[0]!.reference, enabled: true });
    expect(selectedAccountPool(observation, enabled).anthropic).toEqual([
      { credentialId: 1, identityKey: "email:alice@EXAMPLE.test|org:new" },
    ]);
  });

  test("uses native preset IDs, rejects case-folded name conflicts and preserves selection on active deletion", () => {
    const initial = initialAccountChoices();
    const manual = reduceAccountChoices(initial, { kind: "set-account", reference: slot, enabled: false });
    const named = reduceAccountChoices(manual, { kind: "create-preset", preset: { id: "preset-1", name: "Manual", disabled: [alice] } });
    expectCode(() => reduceAccountChoices(named, { kind: "create-preset", preset: { id: "preset-2", name: " manual ", disabled: [] } }), "preset_exists");
    expectCode(() => reduceAccountChoices(named, { kind: "activate-preset", id: "Manual" }), "preset_missing");
    const active = reduceAccountChoices(named, { kind: "activate-preset", id: "preset-1" });
    const renamed = reduceAccountChoices(active, { kind: "update-preset", preset: { id: "preset-1", name: "Focus", disabled: [alice] } });
    expect(renamed.activePreset).toBe("preset-1");
    const observation = projectAccounts(snapshot, scope, 100, 100);
    const deleted = reduceAccountChoices(renamed, { kind: "delete-preset", id: "preset-1" });
    expect(deleted.activePreset).toBeNull();
    expect(selectedAccountPool(observation, deleted)).toEqual(selectedAccountPool(observation, renamed));
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

  test("rejects duplicate credentials and identities, malformed records and credential secrets", () => {
    for (const credentials of [
      [snapshot.credentials[0], snapshot.credentials[0]],
      [snapshot.credentials[0], { ...snapshot.credentials[0], id: 8 }],
      [{ ...snapshot.credentials[0], identityKey: null }],
      [{ ...snapshot.credentials[1], identityKey: "invented-api-identity" }],
      [{ ...snapshot.credentials[1], credential: { type: "api_key", key: "secret" } }],
      [{ ...snapshot.credentials[0], credential: { type: "oauth", accessToken: "secret" } }],
      [{ ...snapshot.credentials[0], disabled: "false" }],
    ]) expectCode(() => projectAccounts({ credentials }, scope, 100, 100), "invalid_accounts");
  });

  test("retains unknown providers explicitly, expires only elapsed blocks, and refuses unavailable observations", () => {
    const observation = projectAccounts({ credentials: [{
      id: 10, provider: "new-provider", identityKey: null, credential: { type: "api_key" },
      blocks: [{ blockScope: "", blockedUntilMs: 100 }, { blockScope: "tier:future", blockedUntilMs: 101 }],
    }] }, scope, 100, 100);
    expect(observation.accounts[0]!.blocks).toEqual([{ scope: "tier:future", until: 101 }]);
    expect(selectedAccountPool(observation, initialAccountChoices())["new-provider"]).toEqual([{ credentialId: 10, identityKey: null }]);
    expectCode(() => selectedAccountPool(projectAccounts(null, scope, null, 100), initialAccountChoices()), "account_unavailable");
    expectCode(() => selectedAccountPool(projectAccounts(snapshot, scope, null, 100), initialAccountChoices()), "account_unavailable");
    expectCode(() => projectAccounts(snapshot, scope, 101, 100), "invalid_accounts");
  });
});
