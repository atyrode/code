import { describe, expect, test } from "bun:test";
import type { AccountReference, AccountsObservation } from "@atyrode/manifold-omp";
import { accountSelectionDisabled, checkedAccountsObservation, disabledAccountReferences, initialAccountChoices,
  reduceAccountChoices, selectedAccountPool, servedProviders } from "../domain/accounts.ts";
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

  test("rebinds every saved exclusion atomically while preserving each effective account pool", () => {
    const choices = {
      activePreset: "focus", manualDisabled: [slot],
      presets: [{ id: "focus", name: "Focus", disabled: [alice] }, { id: "other", name: "Other", disabled: [slot, alice] }],
    };
    const current = { ...snapshot, scope: "omp-owned-broker",
      accounts: snapshot.accounts.map(account => ({ ...account, reference: { ...account.reference, scope: "omp-owned-broker" } })) };
    const rebound = reduceAccountChoices(choices, { kind: "rebind-scope", previous: snapshot, current });
    for (const activePreset of [null, "focus", "other"]) {
      const before = selectedAccountPool(snapshot, { ...choices, activePreset });
      const expected = Object.fromEntries(Object.entries(before).map(([provider, accounts]) =>
        [provider, accounts.map(account => ({ ...account, scope: current.scope }))]));
      expect(selectedAccountPool(current, { ...rebound, activePreset })).toEqual(expected);
      expectCode(() => selectedAccountPool(snapshot, { ...rebound, activePreset }), "account_unavailable");
    }
    expect(rebound.activePreset).toBe("focus");
  });

  test("scope rebind refuses changed identity, credential population or unavailable evidence without losing exclusions", () => {
    const choices = { activePreset: null, manualDisabled: [slot],
      presets: [{ id: "focus", name: "Focus", disabled: [alice] }] };
    const current = { ...snapshot, scope: "omp-owned-broker",
      accounts: snapshot.accounts.map(account => ({ ...account, reference: { ...account.reference, scope: "omp-owned-broker" } })) };
    const relogged = structuredClone(current);
    relogged.accounts[0]!.identityKey = "email:Alice@example.test|org:new";
    relogged.accounts[0]!.reference = { ...alice, scope: current.scope, identityKey: relogged.accounts[0]!.identityKey };
    for (const changed of [
      relogged,
      { ...current, accounts: current.accounts.slice(0, -1) },
      { ...current, status: "stale" as const },
    ]) {
      expectCode(() => reduceAccountChoices(choices, { kind: "rebind-scope", previous: snapshot, current: changed }), "account_unavailable");
      expect(selectedAccountPool(snapshot, choices).openai).toEqual([{ scope, credentialId: 3, identityKey: null }]);
    }
    const missing = { ...choices, presets: [{ id: "focus", name: "Focus", disabled: [{ ...alice, identityKey: "missing" }] }] };
    expectCode(() => reduceAccountChoices(missing, { kind: "rebind-scope", previous: snapshot, current }), "account_unavailable");
    expect(selectedAccountPool(snapshot, missing).openai).toEqual([{ scope, credentialId: 3, identityKey: null }]);
  });

  test("keeps same-email organizations independent when excluding and enabling concrete identities", () => {
    const sibling: AccountReference = { ...alice, identityKey: "email:Alice@example.test|org:other" };
    const observation: AccountsObservation = { ...snapshot, accounts: [...snapshot.accounts, {
      ...snapshot.accounts[0]!, reference: sibling, credentialId: 5, identityKey: sibling.identityKey,
    }] };
    const excludedAlice = reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference: alice, enabled: false });
    expect(accountSelectionDisabled(observation.accounts[4]!, disabledAccountReferences(excludedAlice))).toBe(false);
    expect(selectedAccountPool(observation, excludedAlice).anthropic).toEqual([{ scope, credentialId: 5, identityKey: sibling.identityKey }]);
    const excludedBoth = reduceAccountChoices(excludedAlice, { kind: "set-account", reference: sibling, enabled: false });
    const enabledAlice = reduceAccountChoices(excludedBoth, { kind: "set-account", reference: alice, enabled: true });
    expect(disabledAccountReferences(enabledAlice)).toEqual([sibling]);
    expect(selectedAccountPool(observation, enabledAlice).anthropic).toEqual([{ scope, credentialId: 1, identityKey: alice.identityKey }]);
  });

  test("cannot clear a missing organization's exclusion by enabling a same-email replacement", () => {
    const observation = structuredClone(snapshot);
    const identityKey = "email:Alice@example.test|org:new";
    observation.accounts[0]!.identityKey = identityKey;
    observation.accounts[0]!.reference = { ...alice, identityKey };
    const excluded = reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference: alice, enabled: false });
    const enabled = reduceAccountChoices(excluded, { kind: "set-account", reference: observation.accounts[0]!.reference, enabled: true });
    expect(disabledAccountReferences(enabled)).toEqual([alice]);
    expectCode(() => selectedAccountPool(observation, enabled), "account_unavailable");
  });

  test("omits excluded or disabled providers without broadening the remaining concrete pool", () => {
    const choices = reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference: alice, enabled: false });
    const observation = { ...snapshot, accounts: snapshot.accounts.map(account =>
      account.reference.provider === "openai" ? { ...account, disabled: true } : account) };
    expect(selectedAccountPool(observation, choices)).toEqual({
      "openai-codex": [{ scope, credentialId: 4, identityKey: "Alice@example.test" }],
    });
    expect(disabledAccountReferences(choices)).toEqual([alice]);
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

describe("the providers a launch's pool would serve", () => {
  test("exactly the session door's pool: excluded and disabled credentials serve nothing, per provider not per family", () => {
    const without = (reference: AccountReference) => reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference, enabled: false });
    expect([...servedProviders(snapshot, initialAccountChoices())!].sort()).toEqual(["anthropic", "openai", "openai-codex"]);
    expect([...servedProviders(snapshot, without(alice))!].sort()).toEqual(["openai", "openai-codex"]);
    // Both API-key slots must go before the openai provider stops serving; its codex sibling is another provider.
    const disabled = { ...snapshot, accounts: snapshot.accounts.map(account => account.reference.provider === "openai" ? { ...account, disabled: true } : account) };
    expect([...servedProviders(disabled, initialAccountChoices())!].sort()).toEqual(["anthropic", "openai-codex"]);
  });

  test("a fresh observation with nothing included serves nothing; a pool the door would refuse outright is unknown", () => {
    expect(servedProviders({ ...snapshot, accounts: [] }, initialAccountChoices())).toEqual(new Set());
    expect(servedProviders({ ...snapshot, status: "stale" }, initialAccountChoices())).toBeNull();
    const gone: AccountReference = { kind: "identity", scope, provider: "anthropic", identityKey: "email:gone@example.test" };
    expect(servedProviders(snapshot, reduceAccountChoices(initialAccountChoices(), { kind: "set-account", reference: gone, enabled: false }))).toBeNull();
  });
});
