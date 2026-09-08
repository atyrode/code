package domain

import (
	"testing"
	"reflect"
)

func TestAccountSelectionStateDefaultManualAndDefensiveCopies(t *testing.T) {
	state := defaultAccountSelectionState()
	if state.ActiveName() != accountSelectionManualName || len(state.CurrentDisabled()) != 0 || len(state.Presets()) != 0 {
		t.Fatalf("default state = active %q, disabled %#v, presets %#v", state.ActiveName(), state.CurrentDisabled(), state.Presets())
	}

	manual := map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "manual"}: true}
	state.SetManualDisabled(manual)
	manual[accountKey{Provider: openAIProvider, IdentityKey: "mutated-input"}] = true
	gotManual := state.ManualDisabled()
	gotManual[accountKey{Provider: openAIProvider, IdentityKey: "mutated-output"}] = true
	if !reflect.DeepEqual(state.CurrentDisabled(), map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "manual"}: true}) {
		t.Fatalf("manual selection was not defensively copied: %#v", state.CurrentDisabled())
	}

	presetDisabled := map[accountKey]bool{{Provider: openAIProvider, IdentityKey: "preset"}: true}
	if err := state.UpsertPreset("  Focus  ", presetDisabled); err != nil {
		t.Fatal(err)
	}
	presetDisabled[accountKey{Provider: anthropicProvider, IdentityKey: "mutated-input"}] = true
	if !state.Activate("focus") || state.ActiveName() != "Focus" {
		t.Fatalf("case-insensitive activation did not canonicalize name: %q", state.ActiveName())
	}
	gotPreset, ok := state.Preset(" FOCUS ")
	if !ok {
		t.Fatal("preset lookup failed")
	}
	gotPreset.Disabled[accountKey{Provider: anthropicProvider, IdentityKey: "mutated-output"}] = true
	presets := state.Presets()
	presets[0].Name = "mutated"
	presets[0].Disabled[accountKey{Provider: anthropicProvider, IdentityKey: "mutated-slice"}] = true
	if !reflect.DeepEqual(state.CurrentDisabled(), map[accountKey]bool{{Provider: openAIProvider, IdentityKey: "preset"}: true}) {
		t.Fatalf("named selection was not defensively copied: %#v", state.CurrentDisabled())
	}
	if err := state.UpsertPreset("FOCUS", map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "updated"}: true}); err != nil {
		t.Fatal(err)
	}
	if len(state.Presets()) != 1 || state.ActiveName() != "Focus" {
		t.Fatalf("case-insensitive update created or renamed preset: %#v / %q", state.Presets(), state.ActiveName())
	}
	if !state.DeletePreset("fOcUs") || state.ActiveName() != accountSelectionManualName || len(state.Presets()) != 0 {
		t.Fatalf("deleting active preset did not fall back to Manual: %#v / %q", state.Presets(), state.ActiveName())
	}
}

func TestAccountSelectionStateRejectsInvalidPresetNames(t *testing.T) {
	state := defaultAccountSelectionState()
	for _, name := range []string{"", "   ", "manual", " MANUAL "} {
		if err := state.UpsertPreset(name, nil); err == nil {
			t.Fatalf("accepted reserved or empty preset name %q", name)
		}
	}
	if state.Activate("missing") || state.ActiveName() != accountSelectionManualName {
		t.Fatalf("unknown activation did not fall back to Manual: %q", state.ActiveName())
	}
}

func TestSelectionDisabledMatchesReLoginOrgChange(t *testing.T) {
	disabled := map[accountKey]bool{
		{Provider: anthropicProvider, IdentityKey: "email:a@b|org:1"}: true,
		{Provider: openAIProvider, IdentityKey: "codex@example.com"}:  true,
	}
	cases := []struct {
		name string
		a    account
		want bool
	}{
		{"exact match", account{Provider: anthropicProvider, IdentityKey: "email:a@b|org:1"}, true},
		{"re-login org change, same email", account{Provider: anthropicProvider, IdentityKey: "email:a@b|org:2"}, true},
		{"case-insensitive email", account{Provider: anthropicProvider, IdentityKey: "email:A@B|org:2"}, true},
		{"different email", account{Provider: anthropicProvider, IdentityKey: "email:c@d|org:1"}, false},
		{"different provider, same email", account{Provider: openAIProvider, IdentityKey: "email:a@b|org:9"}, false},
		{"bare-email codex key matches itself", account{Provider: openAIProvider, IdentityKey: "codex@example.com"}, true},
		{"bare-email codex key, different address", account{Provider: openAIProvider, IdentityKey: "other@example.com"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := selectionDisabled(disabled, tc.a); got != tc.want {
				t.Fatalf("selectionDisabled(%+v) = %v, want %v", tc.a, got, tc.want)
			}
		})
	}
}

func TestAccountsAPIEnableClearsReloginIdentityMatch(t *testing.T) {
	state := defaultAccountSelectionState()
	state.SetManualDisabled(map[accountKey]bool{{Provider: "openai-codex", IdentityKey: "email:a@example.com|org:old"}: true})
	a := account{Provider: "openai-codex", IdentityKey: "email:A@example.com|org:new"}
	if err := setAccountAPIEnabled(&state, a, true); err != nil {
		t.Fatal(err)
	}
	if selectionDisabled(state.CurrentDisabled(), a) {
		t.Fatal("re-login identity still disabled after explicit enable")
	}
}
