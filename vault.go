package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// account is one broker credential's identity. apiKey is deliberately
// unexported: it exists only in memory for direct balance fetches (DeepSeek)
// and must never reach any serialized artifact — usage cache, account state,
// or the forwarded account pool. blocks is unexported for the same reason:
// the usage cache marshals account values, and a cached block would still
// read as current after a restart — only the live snapshot may report one.
type account struct {
	Provider     string
	IdentityKey  string
	Email        string
	apiKey       string
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

// timeNow is the injectable clock parseAccountSnapshot uses to drop expired
// blocks at parse time.
var timeNow = time.Now

// providerBlock returns the provider-wide block expiry, zero when none.
func (a account) providerBlock() time.Time {
	var latest time.Time
	for _, b := range a.blocks {
		if b.Scope == "" && b.Until.After(latest) {
			latest = b.Until
		}
	}
	return latest
}

// blockLabels renders one short label per block, longest expiry first (the
// order parseAccountBlocks establishes): "blocked 2d12h", "chat blocked 6d2h".
func (a account) blockLabels(now time.Time) []string {
	labels := make([]string, 0, len(a.blocks))
	for _, b := range a.blocks {
		dur := fmtReset(int64(b.Until.Sub(now) / time.Second))
		if b.Scope == "" {
			labels = append(labels, "blocked "+dur)
		} else {
			labels = append(labels, b.Scope+" blocked "+dur)
		}
	}
	return labels
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

func (b brokerConfig) configured() bool {
	return strings.TrimSpace(b.URL) != "" && strings.TrimSpace(b.Token) != ""
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
	req.Header.Set("OMP-Auth-Broker-Capabilities", "codex-meter-block-scopes")
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

func parseAccountSnapshot(body []byte) (map[string][]account, error) {
	var snapshot struct {
		Credentials *[]struct {
			ID          json.RawMessage `json:"id"`
			Provider    string          `json:"provider"`
			IdentityKey string          `json:"identityKey"`
			Credential  json.RawMessage `json:"credential"`
			Blocks      []snapshotBlock `json:"blocks"`
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
	now := timeNow()
	for _, item := range *snapshot.Credentials {
		p := providerByID(item.Provider)
		if p == nil {
			continue
		}
		var credential struct {
			Type  string `json:"type"`
			Email string `json:"email"`
			Key   string `json:"key"`
		}
		if len(item.Credential) == 0 || bytes.Equal(item.Credential, []byte("null")) {
			return nil, fmt.Errorf("broker snapshot account %s/%s has no credential metadata", p.ID, item.IdentityKey)
		}
		if err := json.Unmarshal(item.Credential, &credential); err != nil {
			return nil, fmt.Errorf("invalid credential metadata for %s/%s: %w", p.ID, item.IdentityKey, err)
		}
		switch credential.Type {
		case "oauth":
		case "api_key":
			// API-key credentials have no broker identity (identityKey is
			// null) and no account-pool routing. For unmetered providers
			// (DeepSeek) they are display-only rows whose key is retained in
			// memory for direct balance fetches; for metered providers they
			// are skipped exactly as before — OAuth is the only usable shape.
			if !p.Metered {
				accounts[p.ID] = append(accounts[p.ID], account{
					Provider: p.ID, IdentityKey: item.IdentityKey,
					apiKey: credential.Key, credentialID: strings.Trim(strings.TrimSpace(string(item.ID)), `"`),
				})
			}
			continue
		default:
			continue
		}
		if strings.TrimSpace(item.IdentityKey) == "" {
			return nil, fmt.Errorf("broker snapshot contains %s OAuth account without identityKey", p.ID)
		}
		key := accountKey{Provider: p.ID, IdentityKey: item.IdentityKey}
		if seen[key] {
			return nil, fmt.Errorf("broker snapshot contains duplicate account %s/%s", p.ID, item.IdentityKey)
		}
		seen[key] = true
		accounts[p.ID] = append(accounts[p.ID], account{
			Provider: p.ID, IdentityKey: item.IdentityKey, Email: credential.Email,
			credentialID: strings.Trim(strings.TrimSpace(string(item.ID)), `"`),
			blocks:       parseAccountBlocks(item.Blocks, now),
		})
	}
	for _, p := range providerRegistry {
		provider := p.ID
		sort.Slice(accounts[provider], func(i, j int) bool {
			return accounts[provider][i].IdentityKey < accounts[provider][j].IdentityKey
		})
	}
	return accounts, nil
}

// clearCredentialBlocks removes the broker's remembered backoff for one
// credential. It is deliberately an explicit operator action: launch must not
// erase coordination shared by other OMP sessions. A real upstream 429 will
// recreate the block on the next request.
func clearCredentialBlocks(broker brokerConfig, credentialID string) error {
	if !broker.configured() {
		return errors.New("central auth broker is not configured")
	}
	credentialID = strings.TrimSpace(credentialID)
	if credentialID == "" {
		return errors.New("credential has no broker id")
	}
	endpoint := strings.TrimRight(broker.URL, "/") + "/v1/credential/" +
		url.PathEscape(credentialID) + "/blocks"
	req, err := http.NewRequest(http.MethodDelete, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+broker.Token)
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("central auth broker block retry returned %s", resp.Status)
	}
	return nil
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

// pruneSelection drops disabled-selection entries with no matching snapshot
// account, for providers the snapshot actually described. A provider absent
// from the snapshot, or with zero accounts, is left untouched — a broker
// outage or partial snapshot must never be read as "this account is gone".
// An entry kept alive only through selectionDisabled's email-component match
// (a post-re-login identityKey change) is not stale and is kept.
func pruneSelection(disabled map[accountKey]bool, accounts map[string][]account) (map[accountKey]bool, int) {
	pruned := make(map[accountKey]bool, len(disabled))
	dropped := 0
	for key, isDisabled := range disabled {
		if !isDisabled {
			continue
		}
		snapshotAccounts, described := accounts[key.Provider]
		if !described || len(snapshotAccounts) == 0 {
			pruned[key] = true
			continue
		}
		stale := true
		for _, acct := range snapshotAccounts {
			if acct.IdentityKey == key.IdentityKey ||
				(selectionEmail(key.IdentityKey) != "" && strings.EqualFold(selectionEmail(acct.IdentityKey), selectionEmail(key.IdentityKey))) {
				stale = false
				break
			}
		}
		if stale {
			dropped++
			continue
		}
		pruned[key] = true
	}
	return pruned, dropped
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

// poolWarningReason names the launch-time account situation a poolWarning
// reports.
type poolWarningReason int

const (
	// poolAllDisabled: the operator disabled every snapshot account of this
	// provider; the pool genuinely carries an empty array.
	poolAllDisabled poolWarningReason = iota
	// poolAllBlocked: every account left enabled for this provider currently
	// carries a provider-wide rate-limit block.
	poolAllBlocked
)

// poolWarning is a provider whose launch-time account situation the operator
// must be told about before the child starts.
type poolWarning struct {
	Provider string
	Reason   poolWarningReason
	Until    time.Time // set only for poolAllBlocked
}

// buildAccountPool seeds the account-pool file omp routes OAuth identities
// through. Only metered (OAuth) providers belong: api_key providers have no
// identity keys and no pool routing.
//
// Per omp's contract a missing provider key is unrestricted and an empty
// array hides every OAuth credential for that provider, so a provider is
// included only when the operator has actually disabled at least one of its
// snapshot accounts — never as a side effect of failed enumeration. Blocked
// accounts stay in the pool: a block can expire mid-session, and removing
// them would freeze that decision for the session's whole life.
func buildAccountPool(accounts map[string][]account, disabled map[accountKey]bool, now time.Time) (map[string][]string, []poolWarning) {
	pool := make(map[string][]string, len(providerRegistry))
	var warnings []poolWarning
	for _, p := range providerRegistry {
		if !p.Metered {
			continue
		}
		provider := p.ID
		var snapshotAccounts, enabled []account
		for _, acct := range accounts[provider] {
			if acct.Provider != provider || acct.IdentityKey == "" {
				continue
			}
			snapshotAccounts = append(snapshotAccounts, acct)
			if !selectionDisabled(disabled, acct) {
				enabled = append(enabled, acct)
			}
		}
		if len(snapshotAccounts) == 0 || len(enabled) == len(snapshotAccounts) {
			// Nothing to restrict, or the provider has no snapshot accounts
			// at all — a missing key is the safe, unrestricted state.
			continue
		}
		keys := make([]string, 0, len(enabled))
		for _, acct := range enabled {
			keys = append(keys, acct.IdentityKey)
		}
		sort.Strings(keys)
		pool[provider] = keys
		if len(enabled) == 0 {
			warnings = append(warnings, poolWarning{Provider: provider, Reason: poolAllDisabled})
			continue
		}
		var blockedUntil time.Time
		allBlocked := true
		for _, acct := range enabled {
			until := acct.providerBlock()
			if until.IsZero() || !until.After(now) {
				allBlocked = false
				break
			}
			if blockedUntil.IsZero() || until.Before(blockedUntil) {
				blockedUntil = until
			}
		}
		if allBlocked {
			warnings = append(warnings, poolWarning{Provider: provider, Reason: poolAllBlocked, Until: blockedUntil})
		}
	}
	sort.Slice(warnings, func(i, j int) bool { return warnings[i].Provider < warnings[j].Provider })
	return pool, warnings
}

func writeAccountPool(accounts map[string][]account, disabled map[accountKey]bool, now time.Time) (string, map[string][]string, []poolWarning, func(), error) {
	dir, err := os.MkdirTemp("", fmt.Sprintf("code-auth-account-pool-%d-*", os.Getpid()))
	if err != nil {
		return "", nil, nil, func() {}, err
	}
	var once sync.Once
	cleanup := func() { once.Do(func() { _ = os.RemoveAll(dir) }) }
	if err := os.Chmod(dir, 0o700); err != nil {
		cleanup()
		return "", nil, nil, cleanup, err
	}
	pool, warnings := buildAccountPool(accounts, disabled, now)
	body, err := json.Marshal(pool)
	if err != nil {
		cleanup()
		return "", nil, nil, cleanup, err
	}
	body = append(body, '\n')
	path := filepath.Join(dir, "account-pool.json")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		cleanup()
		return "", nil, nil, cleanup, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		cleanup()
		return "", nil, nil, cleanup, err
	}
	return path, pool, warnings, cleanup, nil
}

// accountPoolDirPattern matches the pid-tagged temp directories
// writeAccountPool creates, capturing the owning pid.
var accountPoolDirPattern = regexp.MustCompile(`^code-auth-account-pool-(\d+)-`)

// poolSweepGrace bounds how long a leaked pool directory survives before
// sweepAccountPools removes it. It covers launches that record no session
// (CODE_SESSION_STATE=off) and the gap between MkdirTemp and openSession.
const poolSweepGrace = time.Hour

// sweepAccountPools removes leaked code-auth-account-pool-* directories: ones
// whose owning pid holds no live session record and whose mtime is older than
// poolSweepGrace. It returns the number removed and never returns an error —
// a stat or removal failure just leaves that entry for the next sweep.
func sweepAccountPools(root string, live map[int]bool, now time.Time) int {
	entries, err := os.ReadDir(root)
	if err != nil {
		return 0
	}
	removed := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		m := accountPoolDirPattern.FindStringSubmatch(entry.Name())
		if m == nil {
			continue
		}
		pid, err := strconv.Atoi(m[1])
		if err != nil || live[pid] {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if sysStat, ok := info.Sys().(*syscall.Stat_t); ok && sysStat.Uid != uint32(os.Getuid()) {
			continue
		}
		if now.Sub(info.ModTime()) < poolSweepGrace {
			continue
		}
		if err := os.RemoveAll(filepath.Join(root, entry.Name())); err == nil {
			removed++
		}
	}
	return removed
}

var authEnvKeys = map[string]bool{
	"OMP_AUTH_BROKER_URL":               true,
	"OMP_AUTH_BROKER_TOKEN":             true,
	"OMP_AUTH_BROKER_SNAPSHOT_CACHE":    true,
	"OMP_AUTH_BROKER_ACCOUNT_POOL_FILE": true,
}

var sandboxAuthEnvKeys = map[string]bool{
	"OMP_AUTH_BROKER_URL":               true,
	"OMP_AUTH_BROKER_TOKEN":             true,
	"OMP_AUTH_BROKER_SNAPSHOT_CACHE":    true,
	"OMP_AUTH_BROKER_ACCOUNT_POOL_FILE": true,
	"CODE_AUTH_ACCOUNT_STATE":           true,
}

func withAuthEnv(base []string, broker brokerConfig, accountPoolPath string) []string {
	out := removeEnvKeys(base, authEnvKeys)
	return append(out,
		"OMP_AUTH_BROKER_URL="+broker.URL,
		"OMP_AUTH_BROKER_TOKEN="+broker.Token,
		"OMP_AUTH_BROKER_SNAPSHOT_CACHE="+broker.SnapshotCache,
		"OMP_AUTH_BROKER_ACCOUNT_POOL_FILE="+accountPoolPath,
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

// ── DeepSeek balance ──────────────────────────────────────────────────────────
// DeepSeek publishes no rate-limit windows (prepaid pay-as-you-go), so omp's
// usage report never carries it. The upstream balance endpoint is the only
// quota-like surface; it is queried directly with the api_key retained from
// the broker snapshot — the key lives in memory only and is never serialized.

// deepseekBalanceURL is a package var so tests can point it at an httptest
// server.
var deepseekBalanceURL = "https://api.deepseek.com/user/balance"

// deepseekBalance is the rendered state of the DeepSeek prepaid balance.
// A nil *deepseekBalance means "no DeepSeek credential" (group hidden);
// ok=false means the credential exists but the balance is unavailable.
type deepseekBalance struct {
	ok        bool
	currency  string
	total     string
	fetchedAt int64
	stale     bool // restored from cache or retained across a failed refresh
}

// fetchDeepSeekBalance queries the upstream balance endpoint with the
// account's API key. Numeric fields arrive as JSON strings per the DeepSeek
// docs; json.Number tolerates bare numbers too. The USD entry wins when
// present, else the first one; an empty list or is_available=false degrades
// to the unavailable state without error.
func fetchDeepSeekBalance(key string) (deepseekBalance, error) {
	req, err := http.NewRequest(http.MethodGet, deepseekBalanceURL, nil)
	if err != nil {
		return deepseekBalance{}, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return deepseekBalance{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, resp.Body)
		return deepseekBalance{}, fmt.Errorf("balance endpoint returned %s", resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return deepseekBalance{}, err
	}
	var doc struct {
		IsAvailable  bool `json:"is_available"`
		BalanceInfos []struct {
			Currency     string      `json:"currency"`
			TotalBalance json.Number `json:"total_balance"`
		} `json:"balance_infos"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return deepseekBalance{}, fmt.Errorf("invalid balance payload: %w", err)
	}
	now := time.Now().Unix()
	if !doc.IsAvailable || len(doc.BalanceInfos) == 0 {
		return deepseekBalance{fetchedAt: now}, nil
	}
	pick := doc.BalanceInfos[0]
	for _, info := range doc.BalanceInfos {
		if strings.EqualFold(info.Currency, "USD") {
			pick = info
			break
		}
	}
	return deepseekBalance{
		ok: true, currency: strings.ToUpper(pick.Currency),
		total: pick.TotalBalance.String(), fetchedAt: now,
	}, nil
}

// deepseekAPIKey finds the in-memory DeepSeek api_key in a parsed snapshot;
// "" when no such credential exists.
func deepseekAPIKey(accounts map[string][]account) string {
	for _, acct := range accounts[deepseekProvider] {
		if acct.apiKey != "" {
			return acct.apiKey
		}
	}
	return ""
}
