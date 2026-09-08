package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
)

// Public projections are deliberately separate from broker and persistence types.
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

func accountAPIError(message string) int {
	fmt.Fprintln(os.Stderr, "code: "+message)
	return 1
}

func writeAccountAPIJSON(value any) int {
	if json.NewEncoder(os.Stdout).Encode(value) != nil {
		return accountAPIError("cannot write JSON result")
	}
	return 0
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

// This decoder does not inherit the TUI loader's recovery-to-Manual behavior:
// an invalid selection must never turn into a broader launch pool on write.
func readAccountAPIState(path string) (accountSelectionState, error) {
	state := defaultAccountSelectionState()
	body, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if _, statErr := os.Lstat(path); errors.Is(statErr, os.ErrNotExist) {
			return state, nil
		}
	}
	if err != nil {
		return state, errors.New("account state is missing or unreadable")
	}
	var doc accountSelectionFile
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if dec.Decode(&doc) != nil || requireJSONEOF(dec) != nil || doc.Presets == nil {
		return state, errors.New("account state is invalid")
	}
	disabled, ok := decodeAccountStateEntries(doc.Manual.Disabled)
	if !ok {
		return state, errors.New("account state is invalid")
	}
	state.SetManualDisabled(disabled)
	for _, preset := range doc.Presets {
		name := strings.TrimSpace(preset.Name)
		disabled, ok := decodeAccountStateEntries(preset.Disabled)
		if !ok || containsPresetName(state.presets, name) || state.UpsertPreset(name, disabled) != nil {
			return defaultAccountSelectionState(), errors.New("account state is invalid")
		}
	}
	active, ok := doc.Active.(string)
	if !ok || !state.Activate(active) {
		return defaultAccountSelectionState(), errors.New("account state is invalid")
	}
	return state, nil
}

func accountAPIStatePath(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", errors.New("CODE_AUTH_ACCOUNT_STATE is required")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved, nil
	}
	if _, statErr := os.Lstat(path); errors.Is(statErr, os.ErrNotExist) {
		return path, nil
	}
	return "", errors.New("account state is unreadable")
}

// Lock a stable sidecar, not the state inode replaced by atomicPrivateWrite.
// Never remove the sidecar: waiters must all keep locking the same inode.
func lockAccountAPIState(path string) (*os.File, error) {
	resolved, err := accountAPIStatePath(path)
	if err != nil {
		return nil, err
	}
	if os.MkdirAll(filepath.Dir(resolved), 0o700) != nil {
		return nil, errors.New("cannot lock account state")
	}
	f, err := os.OpenFile(resolved+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, errors.New("cannot lock account state")
	}
	if err = f.Chmod(0o600); err == nil {
		err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX)
	}
	if err != nil {
		f.Close()
		return nil, errors.New("cannot lock account state")
	}
	return f, nil
}

func mutateAccountAPIState(path string, accounts map[string][]account, change func(*accountSelectionState) error) (accountSelectionState, error) {
	path, err := accountAPIStatePath(path)
	if err != nil {
		return accountSelectionState{}, err
	}
	lock, err := lockAccountAPIState(path)
	if err != nil {
		return accountSelectionState{}, err
	}
	defer unlockProfile(lock)
	state, err := readAccountAPIState(path)
	if err != nil {
		return state, err
	}
	if err := change(&state); err != nil {
		return state, err
	}
	state = pruneAccountSelectionState(state, availability{accounts: accounts, accountsOK: true})
	if writeAccountSelectionState(path, state) != nil {
		return state, errors.New("cannot persist account state")
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

func runAccountsCLI(args []string) int {
	if len(args) == 0 {
		args = []string{"list"}
	}
	op := args[0]
	args = args[1:]
	if op == "presets" {
		if len(args) == 0 {
			return accountAPIError("accounts presets requires list, create, update, activate, or delete")
		}
		op += " " + args[0]
		args = args[1:]
	}
	fs := flag.NewFlagSet("accounts", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var provider, identity, enabled, name, disabledJSON string
	var portableJSON string
	if op != "login" && op != "clear-blocks" {
		fs.StringVar(&portableJSON, "state", "", "portable account choices JSON")
	}
	switch op {
	case "list", "presets list":
	case "set":
		fs.StringVar(&enabled, "enabled", "", "true or false")
		fallthrough
	case "clear-blocks":
		fs.StringVar(&identity, "identity", "", "public account identity key")
		fallthrough
	case "login":
		fs.StringVar(&provider, "provider", "", "provider id")
	case "presets create", "presets update":
		fs.StringVar(&disabledJSON, "disabled", "", "JSON array of disabled account references")
		fallthrough
	case "presets activate", "presets delete":
		fs.StringVar(&name, "name", "", "preset name")
	default:
		return accountAPIError("unknown accounts operation")
	}
	if fs.Parse(args) != nil || fs.NArg() != 0 {
		return accountAPIError("invalid accounts flags")
	}
	portable := false
	fs.Visit(func(f *flag.Flag) {
		if f.Name == "state" {
			portable = true
		}
	})
	state := defaultAccountSelectionState()
	if portable {
		var err error
		state, err = decodePortableAccountState(portableJSON)
		if err != nil {
			return accountAPIError(err.Error())
		}
	}
	if op == "login" {
		p := providerByID(provider)
		if p == nil || !p.OAuth {
			return accountAPIError("--provider must name an OAuth provider")
		}
		path, err := resolveLaunchPath("CODE_OMP", []string{"omp"})
		if err != nil {
			return accountAPIError("cannot resolve OAuth login executable")
		}
		argv := authLoginArgv(path, provider, os.Getenv("CODE_AUTH_LOGIN_VIA"))
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() > 0 {
				return exit.ExitCode()
			}
			return accountAPIError("OAuth login failed")
		}
		return 0
	}
	if op == "set" && enabled != "true" && enabled != "false" {
		return accountAPIError("--enabled must be true or false")
	}
	name = strings.TrimSpace(name)
	if strings.HasPrefix(op, "presets ") && op != "presets list" && name == "" {
		return accountAPIError("--name is required")
	}
	broker := resolveBroker(os.Getenv("CODE_AUTH_VAULTS"), os.Getenv("CODE_AUTH_VAULTS_FILE"))
	accounts, err := loadAccounts(broker)
	if err != nil {
		return accountAPIError("account snapshot unavailable")
	}
	if op == "clear-blocks" {
		a, err := resolveAccountAPIReference(accounts, provider, identity)
		if err != nil {
			return accountAPIError(err.Error())
		}
		if a.credentialID == "" {
			return accountAPIError("account cannot clear blocks")
		}
		if clearCredentialBlocks(broker, a.credentialID) != nil {
			return accountAPIError("account block clearing failed")
		}
		return writeAccountAPIJSON(struct {
			SchemaVersion int                 `json:"schemaVersion"`
			Operation     string              `json:"operation"`
			Account       accountAPIReference `json:"account"`
			Cleared       bool                `json:"cleared"`
		}{1, op, accountAPIReference{provider, identity}, true})
	}
	if op == "list" || op == "presets list" {
		if !portable {
			if path := os.Getenv("CODE_AUTH_ACCOUNT_STATE"); path != "" {
				state, err = readAccountAPIState(path)
			}
		} else {
			state = pruneAccountSelectionState(state, availability{accounts: accounts, accountsOK: true})
		}
	} else {
		change := func(state *accountSelectionState) error {
			switch op {
			case "set":
				a, err := resolveAccountAPIReference(accounts, provider, identity)
				if err != nil {
					return err
				}
				return setAccountAPIEnabled(state, a, enabled == "true")
			case "presets activate":
				if !state.Activate(name) {
					return errors.New("unknown account preset")
				}
			case "presets delete":
				if _, exists := state.Preset(name); !exists {
					return errors.New("unknown account preset")
				}
				if strings.EqualFold(state.ActiveName(), name) {
					state.SetManualDisabled(state.CurrentDisabled())
				}
				state.DeletePreset(name)
			case "presets create", "presets update":
				_, exists := state.Preset(name)
				if op == "presets create" && exists {
					return errors.New("account preset already exists")
				}
				if op == "presets update" && !exists {
					return errors.New("unknown account preset")
				}
				disabled, err := accountAPIDisabled(disabledJSON, accounts)
				if err != nil {
					return err
				}
				if state.UpsertPreset(name, disabled) != nil {
					return errors.New("invalid account preset name")
				}
				if op == "presets create" {
					state.Activate(name)
				}
			}
			return nil
		}
		if portable {
			err = change(&state)
			if err == nil {
				state = pruneAccountSelectionState(state, availability{accounts: accounts, accountsOK: true})
			}
		} else {
			state, err = mutateAccountAPIState(os.Getenv("CODE_AUTH_ACCOUNT_STATE"), accounts, change)
		}
	}
	if err != nil {
		return accountAPIError(err.Error())
	}
	return writeAccountAPIJSON(projectAccountsAPI(op, state, accounts, time.Now()))
}
