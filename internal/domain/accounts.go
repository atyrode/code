package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
 )

type account struct {
	Provider     string
	IdentityKey  string
	Email        string
	credentialID string
	blocks       []accountBlock
}

// accountBlock is one broker rate-limit block. Scope "" is provider-wide;
// "chat", "spark" and "tier:*" are meter- or tier-scoped and must never be
// rendered as taking the whole provider out of service.
type accountBlock struct {
	Scope string
	Until time.Time
}

type accountKey struct {
	Provider    string
	IdentityKey string
}

func emptyAccounts() map[string][]account {
	accounts := make(map[string][]account, len(providerRegistry))
	for _, p := range providerRegistry {
		accounts[p.ID] = []account{}
	}
	return accounts
}

// snapshotBlock is one raw broker rate-limit block entry. providerKey,
// updatedAtMs and rotatesInMs are not decoded: nothing renders them, and the
// credential's own provider already identifies the row.
type snapshotBlock struct {
	BlockScope     string `json:"blockScope"`
	BlockedUntilMs int64  `json:"blockedUntilMs"`
}

// parseAccountBlocks keeps only blocks still in force at now, longest expiry
// first so the most consequential one leads every row. An expiry at or before
// now is dropped, which is what makes an unblock clear the marker on the very
// next refresh.
func parseAccountBlocks(raw []snapshotBlock, now time.Time) []accountBlock {
	blocks := make([]accountBlock, 0, len(raw))
	for _, b := range raw {
		if b.BlockedUntilMs <= 0 {
			continue
		}
		until := time.UnixMilli(b.BlockedUntilMs)
		if !until.After(now) {
			continue
		}
		blocks = append(blocks, accountBlock{Scope: b.BlockScope, Until: until})
	}
	sort.Slice(blocks, func(i, j int) bool { return blocks[i].Until.After(blocks[j].Until) })
	return blocks
}

func requireJSONEOF(dec *json.Decoder) error {
	var extra any
	if err := dec.Decode(&extra); err == io.EOF {
		return nil
	} else if err != nil {
		return fmt.Errorf("invalid trailing broker snapshot data: %w", err)
	}
	return errors.New("broker snapshot contains multiple JSON values")
}

const accountSelectionManualName = "Manual"

type accountSelectionPreset struct {
	Name     string
	Disabled map[accountKey]bool
}

type accountSelectionState struct {
	active         string
	manualDisabled map[accountKey]bool
	presets        []accountSelectionPreset
	// Supplied launch choices must be resolved exactly against the authoritative
	// broker snapshot, never recovered or pruned into a broader account pool.
	strictLaunch bool
}

type accountStateEntry struct {
	Provider    string `json:"provider"`
	IdentityKey string `json:"identityKey"`
}

func defaultAccountSelectionState() accountSelectionState {
	return accountSelectionState{
		active:         accountSelectionManualName,
		manualDisabled: make(map[accountKey]bool),
		presets:        []accountSelectionPreset{},
	}
}

func (state accountSelectionState) ActiveName() string {
	if strings.TrimSpace(state.active) == "" {
		return accountSelectionManualName
	}
	return state.active
}

func (state accountSelectionState) ManualDisabled() map[accountKey]bool {
	return copyDisabledAccounts(state.manualDisabled)
}

func (state accountSelectionState) CurrentDisabled() map[accountKey]bool {
	if strings.EqualFold(state.ActiveName(), accountSelectionManualName) {
		return state.ManualDisabled()
	}
	if preset, ok := state.Preset(state.ActiveName()); ok {
		return preset.Disabled
	}
	return state.ManualDisabled()
}

func (state accountSelectionState) Presets() []accountSelectionPreset {
	presets := make([]accountSelectionPreset, len(state.presets))
	for i, preset := range state.presets {
		presets[i] = accountSelectionPreset{Name: preset.Name, Disabled: copyDisabledAccounts(preset.Disabled)}
	}
	return presets
}

func (state accountSelectionState) Preset(name string) (accountSelectionPreset, bool) {
	name = strings.TrimSpace(name)
	for _, preset := range state.presets {
		if strings.EqualFold(preset.Name, name) {
			return accountSelectionPreset{Name: preset.Name, Disabled: copyDisabledAccounts(preset.Disabled)}, true
		}
	}
	return accountSelectionPreset{}, false
}

func (state *accountSelectionState) SetManualDisabled(disabled map[accountKey]bool) {
	state.manualDisabled = copyDisabledAccounts(disabled)
}

func (state *accountSelectionState) UpsertPreset(name string, disabled map[accountKey]bool) error {
	name = strings.TrimSpace(name)
	if name == "" || strings.EqualFold(name, accountSelectionManualName) {
		return fmt.Errorf("invalid account preset name %q", name)
	}
	for i := range state.presets {
		if strings.EqualFold(state.presets[i].Name, name) {
			state.presets[i].Disabled = copyDisabledAccounts(disabled)
			if strings.EqualFold(state.active, name) {
				state.active = state.presets[i].Name
			}
			return nil
		}
	}
	state.presets = append(state.presets, accountSelectionPreset{Name: name, Disabled: copyDisabledAccounts(disabled)})
	return nil
}

func (state *accountSelectionState) DeletePreset(name string) bool {
	name = strings.TrimSpace(name)
	for i, preset := range state.presets {
		if !strings.EqualFold(preset.Name, name) {
			continue
		}
		state.presets = append(state.presets[:i], state.presets[i+1:]...)
		if strings.EqualFold(state.active, preset.Name) {
			state.active = accountSelectionManualName
		}
		return true
	}
	return false
}

func (state *accountSelectionState) Activate(name string) bool {
	name = strings.TrimSpace(name)
	if strings.EqualFold(name, accountSelectionManualName) {
		state.active = accountSelectionManualName
		return true
	}
	for _, preset := range state.presets {
		if strings.EqualFold(preset.Name, name) {
			state.active = preset.Name
			return true
		}
	}
	state.active = accountSelectionManualName
	return false
}

func copyDisabledAccounts(disabled map[accountKey]bool) map[accountKey]bool {
	copied := make(map[accountKey]bool, len(disabled))
	for key, isDisabled := range disabled {
		if isDisabled {
			copied[key] = true
		}
	}
	return copied
}

func containsPresetName(presets []accountSelectionPreset, name string) bool {
	for _, preset := range presets {
		if strings.EqualFold(preset.Name, name) {
			return true
		}
	}
	return false
}

func decodeAccountStateEntries(entries []accountStateEntry) (map[accountKey]bool, bool) {
	if entries == nil {
		return nil, false
	}
	disabled := make(map[accountKey]bool, len(entries))
	for _, entry := range entries {
		if providerByID(entry.Provider) == nil || entry.IdentityKey == "" {
			return nil, false
		}
		key := accountKey{Provider: entry.Provider, IdentityKey: entry.IdentityKey}
		if disabled[key] {
			return nil, false
		}
		disabled[key] = true
	}
	return disabled, true
}

func encodeAccountStateEntries(disabled map[accountKey]bool) ([]accountStateEntry, error) {
	entries := make([]accountStateEntry, 0, len(disabled))
	for key, isDisabled := range disabled {
		if !isDisabled {
			continue
		}
		if providerByID(key.Provider) == nil || key.IdentityKey == "" {
			return nil, fmt.Errorf("invalid disabled account %q/%q", key.Provider, key.IdentityKey)
		}
		entries = append(entries, accountStateEntry{Provider: key.Provider, IdentityKey: key.IdentityKey})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Provider != entries[j].Provider {
			return entries[i].Provider < entries[j].Provider
		}
		return entries[i].IdentityKey < entries[j].IdentityKey
	})
	return entries, nil
}

// selectionEmail extracts the account-identifying component of an
// identityKey: "email:a@b.com|org:<uuid>" -> "a@b.com"; a bare "a@b.com"
// (Codex's shape) -> "a@b.com" unchanged; anything else -> "" (no email
// component, exact matching only).
func selectionEmail(identityKey string) string {
	if rest, ok := strings.CutPrefix(identityKey, "email:"); ok {
		email, _, _ := strings.Cut(rest, "|")
		return email
	}
	if strings.Contains(identityKey, "@") && !strings.Contains(identityKey, "|") {
		return identityKey
	}
	return ""
}

// selectionDisabled reports whether the operator has disabled this account.
// It matches the exact {provider, identityKey} entry, and — because a
// re-login can mint a new org qualifier for the same human account — also
// matches a same-provider entry whose email component is equal, case
// insensitively. The control exists to stop overspending a shared account, so
// a changed org qualifier must not silently re-enable it.
func selectionDisabled(disabled map[accountKey]bool, a account) bool {
	key := accountKey{Provider: a.Provider, IdentityKey: a.IdentityKey}
	if disabled[key] {
		return true
	}
	email := selectionEmail(a.IdentityKey)
	if email == "" {
		return false
	}
	for entryKey, isDisabled := range disabled {
		if !isDisabled || entryKey.Provider != a.Provider {
			continue
		}
		if strings.EqualFold(selectionEmail(entryKey.IdentityKey), email) {
			return true
		}
	}
	return false
}

type accountAPIReference struct {
	Provider    string `json:"provider"`
	IdentityKey string `json:"identityKey"`
}

type accountAPIRestriction struct {
	Scope string `json:"scope"`
	Until int64  `json:"until"`
}

type accountAPIAccount struct {
	accountAPIReference
	Email        string                  `json:"email,omitempty"`
	Selectable   bool                    `json:"selectable"`
	Enabled      bool                    `json:"enabled"`
	Blocked      bool                    `json:"blocked"`
	BlockedUntil int64                   `json:"blockedUntil,omitempty"`
	Restrictions []accountAPIRestriction `json:"restrictions"`
}

type accountAPIPreset struct {
	Name     string                `json:"name"`
	Disabled []accountAPIReference `json:"disabled"`
}

type accountAPIResult struct {
	SchemaVersion  int                   `json:"schemaVersion"`
	Operation      string                `json:"operation"`
	ObservedAt     int64                 `json:"observedAt"`
	ActivePreset   string                `json:"activePreset"`
	Accounts       []accountAPIAccount   `json:"accounts"`
	Presets        []accountAPIPreset    `json:"presets"`
	ManualDisabled []accountAPIReference `json:"manualDisabled"`
}

// Decode the exact public object shape without encoding/json's case folding,
// duplicate-key last-wins behavior, or null-to-zero-value coercion.
func decodeAccountObject(raw string, fields map[string]any) error {
	invalid := errors.New("invalid account selection object")
	if !utf8.ValidString(raw) {
		return invalid
	}
	dec := json.NewDecoder(strings.NewReader(raw))
	token, err := dec.Token()
	if err != nil || token != json.Delim('{') {
		return invalid
	}
	seen := make(map[string]bool, len(fields))
	for dec.More() {
		token, err := dec.Token()
		if err != nil {
			return invalid
		}
		key, ok := token.(string)
		target, known := fields[key]
		if !ok || !known || seen[key] {
			return invalid
		}
		seen[key] = true
		var value json.RawMessage
		if dec.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, target) != nil {
			return invalid
		}
	}
	if token, err := dec.Token(); err != nil || token != json.Delim('}') || requireJSONEOF(dec) != nil || len(seen) != len(fields) {
		return invalid
	}
	return nil
}

func decodeAccountReferences(raw string) (map[accountKey]bool, error) {
	var values []json.RawMessage
	if !utf8.ValidString(raw) || json.Unmarshal([]byte(raw), &values) != nil || values == nil {
		return nil, errors.New("disabled must be an array of account references")
	}
	entries := make([]accountStateEntry, 0, len(values))
	for _, value := range values {
		var entry accountStateEntry
		if decodeAccountObject(string(value), map[string]any{"provider": &entry.Provider, "identityKey": &entry.IdentityKey}) != nil ||
			strings.TrimSpace(entry.IdentityKey) == "" || strings.ContainsAny(entry.IdentityKey, "\x00\r\n") {
			return nil, errors.New("invalid disabled account reference")
		}
		entries = append(entries, entry)
	}
	disabled, ok := decodeAccountStateEntries(entries)
	if !ok {
		return nil, errors.New("invalid disabled account references")
	}
	return disabled, nil
}

func decodePortableAccountState(raw string) (accountSelectionState, error) {
	state := defaultAccountSelectionState()
	var version int
	var active string
	var manual json.RawMessage
	var presets []json.RawMessage
	err := decodeAccountObject(raw, map[string]any{
		"schemaVersion": &version, "activePreset": &active, "manualDisabled": &manual, "presets": &presets,
	})
	if err != nil || version != 1 {
		return state, errors.New("invalid portable account state")
	}
	disabled, err := decodeAccountReferences(string(manual))
	if err != nil {
		return state, err
	}
	state.SetManualDisabled(disabled)
	for _, rawPreset := range presets {
		var name string
		var refs json.RawMessage
		if decodeAccountObject(string(rawPreset), map[string]any{"name": &name, "disabled": &refs}) != nil {
			return state, errors.New("invalid account preset")
		}
		disabled, err := decodeAccountReferences(string(refs))
		name = strings.TrimSpace(name)
		if err != nil || containsPresetName(state.presets, name) || strings.ContainsAny(name, "\x00\r\n") || state.UpsertPreset(name, disabled) != nil {
			return state, errors.New("invalid account preset")
		}
	}
	if !state.Activate(active) {
		return state, errors.New("unknown active account preset")
	}
	return state, nil
}

func accountAPIReferences(disabled map[accountKey]bool) []accountAPIReference {
	entries, _ := encodeAccountStateEntries(disabled)
	refs := make([]accountAPIReference, 0, len(entries))
	for _, entry := range entries {
		refs = append(refs, accountAPIReference{entry.Provider, entry.IdentityKey})
	}
	return refs
}

func projectAccountAPI(a account, disabled map[accountKey]bool, now time.Time) accountAPIAccount {
	out := accountAPIAccount{
		accountAPIReference: accountAPIReference{a.Provider, a.IdentityKey},
		Email:               a.Email, Selectable: a.IdentityKey != "", Enabled: !selectionDisabled(disabled, a),
		Restrictions: []accountAPIRestriction{},
	}
	for _, block := range a.blocks {
		if block.Until.After(now) {
			out.Blocked = true
			out.BlockedUntil = max(out.BlockedUntil, block.Until.Unix())
			out.Restrictions = append(out.Restrictions, accountAPIRestriction{Scope: block.Scope, Until: block.Until.Unix()})
		}
	}
	return out
}

func projectAccountsAPI(operation string, state accountSelectionState, accounts map[string][]account, now time.Time) accountAPIResult {
	out := accountAPIResult{
		SchemaVersion: 1, Operation: operation, ObservedAt: now.Unix(), ActivePreset: state.ActiveName(),
		Accounts: []accountAPIAccount{}, Presets: []accountAPIPreset{}, ManualDisabled: accountAPIReferences(state.ManualDisabled()),
	}
	disabled := state.CurrentDisabled()
	for _, provider := range providerRegistry {
		for _, a := range accounts[provider.ID] {
			out.Accounts = append(out.Accounts, projectAccountAPI(a, disabled, now))
		}
	}
	for _, preset := range state.Presets() {
		out.Presets = append(out.Presets, accountAPIPreset{preset.Name, accountAPIReferences(preset.Disabled)})
	}
	return out
}

func resolveAccountAPIReference(accounts map[string][]account, provider, identity string) (account, error) {
	if provider == "" || identity == "" {
		return account{}, errors.New("--provider and --identity are required")
	}
	for _, a := range accounts[provider] {
		if a.IdentityKey == identity {
			return a, nil
		}
	}
	return account{}, errors.New("unknown account identity")
}

func accountAPIDisabled(raw string, accounts map[string][]account) (map[accountKey]bool, error) {
	disabled, err := decodeAccountReferences(raw)
	if err != nil {
		return nil, err
	}
	for key := range disabled {
		if _, err := resolveAccountAPIReference(accounts, key.Provider, key.IdentityKey); err != nil {
			return nil, err
		}
	}
	return disabled, nil
}

func setAccountAPIEnabled(state *accountSelectionState, a account, enabled bool) error {
	disabled := state.CurrentDisabled()
	key := accountKey{Provider: a.Provider, IdentityKey: a.IdentityKey}
	if enabled {
		delete(disabled, key)
		if email := selectionEmail(a.IdentityKey); email != "" {
			for k := range disabled {
				if k.Provider == a.Provider && strings.EqualFold(selectionEmail(k.IdentityKey), email) {
					delete(disabled, k)
				}
			}
		}
	} else {
		disabled[key] = true
	}
	if state.ActiveName() == accountSelectionManualName {
		state.SetManualDisabled(disabled)
		return nil
	}
	return state.UpsertPreset(state.ActiveName(), disabled)
}

type deepseekBalance struct {
	ok        bool
	currency  string
	total     string
	fetchedAt int64
	stale     bool // restored from cache or retained across a failed refresh
}
