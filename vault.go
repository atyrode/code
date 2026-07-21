package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	anthropicProvider = "anthropic"
	openAIProvider    = "openai-codex"
)

type account struct {
	Provider    string
	IdentityKey string
	Email       string
}

type accountKey struct {
	Provider    string
	IdentityKey string
}

type brokerConfig struct {
	URL           string
	Token         string
	SnapshotCache string
}

// resolveBroker uses the inherited central broker whenever any central broker
// variable is set. The legacy manifest is consulted only as a staged fallback
// for installations which have not yet exported the central variables.
func resolveBroker(legacyRaw, legacyPath string) brokerConfig {
	broker := brokerConfig{
		URL:           os.Getenv("OMP_AUTH_BROKER_URL"),
		Token:         os.Getenv("OMP_AUTH_BROKER_TOKEN"),
		SnapshotCache: os.Getenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE"),
	}
	if broker.URL != "" || broker.Token != "" || broker.SnapshotCache != "" {
		return broker
	}
	return legacyManifestFirstBroker(legacyRaw, legacyPath)
}

// legacyManifestFirstBroker is deliberately the only remaining parser for the
// retired vault manifest. It reads only the first entry and exposes no vault UI.
func legacyManifestFirstBroker(raw, path string) brokerConfig {
	if raw == "" && path != "" {
		body, err := os.ReadFile(path)
		if err != nil {
			return brokerConfig{}
		}
		raw = string(body)
	}
	var entries []struct {
		BrokerURL     string `json:"brokerUrl"`
		TokenFile     string `json:"tokenFile"`
		SnapshotCache string `json:"snapshotCache"`
	}
	if raw == "" || json.Unmarshal([]byte(raw), &entries) != nil || len(entries) == 0 {
		return brokerConfig{}
	}
	broker := brokerConfig{URL: entries[0].BrokerURL, SnapshotCache: entries[0].SnapshotCache}
	if entries[0].TokenFile != "" {
		if token, err := os.ReadFile(entries[0].TokenFile); err == nil {
			broker.Token = strings.TrimSpace(string(token))
		}
	}
	return broker
}

func loadAccounts(broker brokerConfig) (map[string][]account, error) {
	accounts := emptyAccounts()
	if strings.TrimSpace(broker.URL) == "" || strings.TrimSpace(broker.Token) == "" {
		return accounts, errors.New("central auth broker is not configured")
	}
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(broker.URL, "/")+"/v1/snapshot", nil)
	if err != nil {
		return accounts, err
	}
	req.Header.Set("Authorization", "Bearer "+broker.Token)
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return accounts, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return accounts, fmt.Errorf("central auth broker snapshot returned %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil {
		return accounts, err
	}
	if len(body) > 1<<20 {
		return accounts, errors.New("central auth broker snapshot exceeds 1 MiB")
	}
	return parseAccountSnapshot(body)
}

func emptyAccounts() map[string][]account {
	return map[string][]account{anthropicProvider: {}, openAIProvider: {}}
}

func parseAccountSnapshot(body []byte) (map[string][]account, error) {
	var snapshot struct {
		Credentials *[]struct {
			Provider    string          `json:"provider"`
			IdentityKey string          `json:"identityKey"`
			Credential  json.RawMessage `json:"credential"`
		} `json:"credentials"`
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	if err := dec.Decode(&snapshot); err != nil {
		return nil, fmt.Errorf("invalid broker snapshot: %w", err)
	}
	if err := requireJSONEOF(dec); err != nil {
		return nil, err
	}
	if snapshot.Credentials == nil {
		return nil, errors.New("broker snapshot has no credentials array")
	}
	accounts := emptyAccounts()
	seen := make(map[accountKey]bool)
	for _, item := range *snapshot.Credentials {
		if item.Provider != anthropicProvider && item.Provider != openAIProvider {
			continue
		}
		var credential struct {
			Type  string `json:"type"`
			Email string `json:"email"`
		}
		if len(item.Credential) == 0 || bytes.Equal(item.Credential, []byte("null")) {
			return nil, fmt.Errorf("broker snapshot account %s/%s has no credential metadata", item.Provider, item.IdentityKey)
		}
		if err := json.Unmarshal(item.Credential, &credential); err != nil {
			return nil, fmt.Errorf("invalid credential metadata for %s/%s: %w", item.Provider, item.IdentityKey, err)
		}
		if credential.Type != "oauth" {
			continue
		}
		if strings.TrimSpace(item.IdentityKey) == "" {
			return nil, fmt.Errorf("broker snapshot contains %s OAuth account without identityKey", item.Provider)
		}
		key := accountKey{Provider: item.Provider, IdentityKey: item.IdentityKey}
		if seen[key] {
			return nil, fmt.Errorf("broker snapshot contains duplicate account %s/%s", item.Provider, item.IdentityKey)
		}
		seen[key] = true
		accounts[item.Provider] = append(accounts[item.Provider], account{
			Provider: item.Provider, IdentityKey: item.IdentityKey, Email: credential.Email,
		})
	}
	for _, provider := range []string{anthropicProvider, openAIProvider} {
		sort.Slice(accounts[provider], func(i, j int) bool {
			return accounts[provider][i].IdentityKey < accounts[provider][j].IdentityKey
		})
	}
	return accounts, nil
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
}

type accountSelectionFile struct {
	Active  any                          `json:"active"`
	Manual  accountSelectionFileManual   `json:"manual"`
	Presets []accountSelectionFilePreset `json:"presets"`
}

type accountSelectionFileManual struct {
	Disabled []accountStateEntry `json:"disabled"`
}

type accountSelectionFilePreset struct {
	Name     string              `json:"name"`
	Disabled []accountStateEntry `json:"disabled"`
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

func loadAccountSelectionState(path string) accountSelectionState {
	state := defaultAccountSelectionState()
	body, err := os.ReadFile(path)
	if err != nil {
		return state
	}
	var persisted accountSelectionFile
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&persisted); err != nil || requireJSONEOF(dec) != nil {
		return state
	}
	if disabled, ok := decodeAccountStateEntries(persisted.Manual.Disabled); ok {
		state.manualDisabled = disabled
	}
	for _, persistedPreset := range persisted.Presets {
		name := strings.TrimSpace(persistedPreset.Name)
		if name == "" || strings.EqualFold(name, accountSelectionManualName) || containsPresetName(state.presets, name) {
			continue
		}
		disabled, ok := decodeAccountStateEntries(persistedPreset.Disabled)
		if !ok {
			continue
		}
		state.presets = append(state.presets, accountSelectionPreset{Name: name, Disabled: disabled})
	}
	active, _ := persisted.Active.(string)
	state.Activate(active)
	return state
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
		if (entry.Provider != anthropicProvider && entry.Provider != openAIProvider) || entry.IdentityKey == "" {
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
		if (key.Provider != anthropicProvider && key.Provider != openAIProvider) || key.IdentityKey == "" {
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

func writeAccountSelectionState(path string, state accountSelectionState) error {
	if path == "" {
		return errors.New("account state path is empty")
	}
	manual, err := encodeAccountStateEntries(state.manualDisabled)
	if err != nil {
		return err
	}
	persisted := accountSelectionFile{
		Active:  accountSelectionManualName,
		Manual:  accountSelectionFileManual{Disabled: manual},
		Presets: make([]accountSelectionFilePreset, 0, len(state.presets)),
	}
	for _, preset := range state.presets {
		name := strings.TrimSpace(preset.Name)
		if name == "" || strings.EqualFold(name, accountSelectionManualName) || containsPersistedPresetName(persisted.Presets, name) {
			return fmt.Errorf("invalid or duplicate account preset name %q", preset.Name)
		}
		disabled, err := encodeAccountStateEntries(preset.Disabled)
		if err != nil {
			return fmt.Errorf("account preset %q: %w", name, err)
		}
		persisted.Presets = append(persisted.Presets, accountSelectionFilePreset{Name: name, Disabled: disabled})
	}
	if !strings.EqualFold(state.ActiveName(), accountSelectionManualName) {
		preset, ok := state.Preset(state.ActiveName())
		if !ok {
			return fmt.Errorf("unknown active account preset %q", state.ActiveName())
		}
		persisted.Active = preset.Name
	}
	body, err := json.Marshal(persisted)
	if err != nil {
		return err
	}
	body = append(body, '\n')
	return atomicPrivateWrite(path, body)
}

func containsPersistedPresetName(presets []accountSelectionFilePreset, name string) bool {
	for _, preset := range presets {
		if strings.EqualFold(preset.Name, name) {
			return true
		}
	}
	return false
}

func atomicPrivateWrite(path string, body []byte) error {
	parent := filepath.Dir(path)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(parent, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(parent, ".account-state-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(tmpPath)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(body); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	committed = true
	return nil
}

func buildAccountAllowlist(accounts map[string][]account, disabled map[accountKey]bool) map[string][]string {
	allowlist := map[string][]string{anthropicProvider: {}, openAIProvider: {}}
	for _, provider := range []string{anthropicProvider, openAIProvider} {
		for _, acct := range accounts[provider] {
			key := accountKey{Provider: provider, IdentityKey: acct.IdentityKey}
			if acct.Provider == provider && acct.IdentityKey != "" && !disabled[key] {
				allowlist[provider] = append(allowlist[provider], acct.IdentityKey)
			}
		}
		sort.Strings(allowlist[provider])
	}
	return allowlist
}

func writeAccountAllowlist(accounts map[string][]account, disabled map[accountKey]bool) (string, func(), error) {
	dir, err := os.MkdirTemp("", "code-auth-allowlist-*")
	if err != nil {
		return "", func() {}, err
	}
	var once sync.Once
	cleanup := func() { once.Do(func() { _ = os.RemoveAll(dir) }) }
	if err := os.Chmod(dir, 0o700); err != nil {
		cleanup()
		return "", cleanup, err
	}
	body, err := json.Marshal(buildAccountAllowlist(accounts, disabled))
	if err != nil {
		cleanup()
		return "", cleanup, err
	}
	body = append(body, '\n')
	path := filepath.Join(dir, "allowlist.json")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		cleanup()
		return "", cleanup, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		cleanup()
		return "", cleanup, err
	}
	return path, cleanup, nil
}

var authEnvKeys = map[string]bool{
	"OMP_AUTH_BROKER_URL":             true,
	"OMP_AUTH_BROKER_TOKEN":           true,
	"OMP_AUTH_BROKER_SNAPSHOT_CACHE":  true,
	"OMP_AUTH_ACCOUNT_ALLOWLIST_FILE": true,
}

var sandboxAuthEnvKeys = map[string]bool{
	"OMP_AUTH_BROKER_URL":             true,
	"OMP_AUTH_BROKER_TOKEN":           true,
	"OMP_AUTH_BROKER_SNAPSHOT_CACHE":  true,
	"OMP_AUTH_ACCOUNT_ALLOWLIST_FILE": true,
	"CODE_AUTH_ACCOUNT_STATE":         true,
}

func withAuthEnv(base []string, broker brokerConfig, allowlistPath string) []string {
	out := removeEnvKeys(base, authEnvKeys)
	return append(out,
		"OMP_AUTH_BROKER_URL="+broker.URL,
		"OMP_AUTH_BROKER_TOKEN="+broker.Token,
		"OMP_AUTH_BROKER_SNAPSHOT_CACHE="+broker.SnapshotCache,
		"OMP_AUTH_ACCOUNT_ALLOWLIST_FILE="+allowlistPath,
	)
}

func withoutAuthEnv(base []string) []string {
	return removeEnvKeys(base, sandboxAuthEnvKeys)
}

func removeEnvKeys(base []string, keys map[string]bool) []string {
	out := make([]string, 0, len(base))
	for _, entry := range base {
		key, _, found := strings.Cut(entry, "=")
		if found && keys[key] {
			continue
		}
		out = append(out, entry)
	}
	return out
}

// stripProfileArgs removes OMP profile options before --. Arguments following
// -- are prompt text and are preserved verbatim.
func stripProfileArgs(args []string) []string {
	clean := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			return append(clean, args[i:]...)
		}
		if arg == "--profile" {
			if i+1 < len(args) {
				i++
			}
			continue
		}
		if strings.HasPrefix(arg, "--profile=") {
			continue
		}
		clean = append(clean, arg)
	}
	return clean
}
