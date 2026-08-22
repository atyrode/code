package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLoadAccountsValidatesFiltersAndSortsCentralSnapshot(t *testing.T) {
	const snapshot = `{"credentials":[
		{"provider":"openai-codex","identityKey":"z-codex","credential":{"type":"oauth","email":"z@example.com","accessToken":"redacted"}},
		{"provider":"anthropic","identityKey":"c-claude","credential":{"type":"oauth","email":"c@example.com"}},
		{"provider":"other","identityKey":"ignored","credential":{"type":"oauth","email":"ignored@example.com"}},
		{"provider":"anthropic","identityKey":"api-key","credential":{"type":"api_key"}},
		{"provider":"anthropic","identityKey":"a-claude","credential":{"type":"oauth","email":"a@example.com"}},
		{"provider":"openai-codex","identityKey":"a-codex","credential":{"type":"oauth","email":"oa@example.com"}},
		{"provider":"anthropic","identityKey":"b-claude","credential":{"type":"oauth","email":"b@example.com"}}
	]}`
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		if r.URL.Path != "/v1/snapshot" {
			t.Fatalf("snapshot path = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(snapshot))
	}))
	defer server.Close()

	got, err := loadAccounts(brokerConfig{URL: server.URL, Token: "central-secret"})
	if err != nil {
		t.Fatal(err)
	}
	if authorization != "Bearer central-secret" {
		t.Fatalf("authorization = %q", authorization)
	}
	if len(got) != len(providerRegistry) || len(got[anthropicProvider]) != 3 || len(got[openAIProvider]) != 2 || len(got[deepseekProvider]) != 0 {
		t.Fatalf("account groups = %#v", got)
	}
	if keys := accountKeys(got[anthropicProvider]); !reflect.DeepEqual(keys, []string{"a-claude", "b-claude", "c-claude"}) {
		t.Fatalf("anthropic sort = %#v", keys)
	}
	if keys := accountKeys(got[openAIProvider]); !reflect.DeepEqual(keys, []string{"a-codex", "z-codex"}) {
		t.Fatalf("OpenAI sort = %#v", keys)
	}
}

func TestLoadAccountsRejectsMalformedRelevantIdentities(t *testing.T) {
	for name, snapshot := range map[string]string{
		"missing key":      `{"credentials":[{"provider":"anthropic","credential":{"type":"oauth","email":"x"}}]}`,
		"duplicate":        `{"credentials":[{"provider":"anthropic","identityKey":"x","credential":{"type":"oauth"}},{"provider":"anthropic","identityKey":"x","credential":{"type":"oauth"}}]}`,
		"missing metadata": `{"credentials":[{"provider":"openai-codex","identityKey":"x","credential":null}]}`,
		"trailing JSON":    `{"credentials":[]} {}`,
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(snapshot)) }))
			defer server.Close()
			if _, err := loadAccounts(brokerConfig{URL: server.URL, Token: "token"}); err == nil {
				t.Fatal("malformed snapshot accepted")
			}
		})
	}
}

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

func TestAccountSelectionUnknownAccountsDefaultEnabledAndProviderKeysAreIsolated(t *testing.T) {
	state := defaultAccountSelectionState()
	state.SetManualDisabled(map[accountKey]bool{
		{Provider: anthropicProvider, IdentityKey: "shared"}:            true,
		{Provider: anthropicProvider, IdentityKey: "no-longer-present"}: true,
	})
	accounts := map[string][]account{
		anthropicProvider: {{Provider: anthropicProvider, IdentityKey: "shared"}, {Provider: anthropicProvider, IdentityKey: "new"}},
		openAIProvider:    {{Provider: openAIProvider, IdentityKey: "shared"}},
	}
	got := buildAccountPool(accounts, state.CurrentDisabled())
	if !reflect.DeepEqual(got[anthropicProvider], []string{"new"}) {
		t.Fatalf("anthropic account pool = %#v", got[anthropicProvider])
	}
	if !reflect.DeepEqual(got[openAIProvider], []string{"shared"}) {
		t.Fatalf("same identityKey in another provider must remain enabled: %#v", got[openAIProvider])
	}
}

func TestBuildAccountPoolAllOffKeepsExactProviderArrays(t *testing.T) {
	accounts := map[string][]account{
		anthropicProvider: {{Provider: anthropicProvider, IdentityKey: "a"}},
		openAIProvider:    {{Provider: openAIProvider, IdentityKey: "o"}},
	}
	disabled := map[accountKey]bool{
		{Provider: anthropicProvider, IdentityKey: "a"}: true,
		{Provider: openAIProvider, IdentityKey: "o"}:    true,
	}
	got := buildAccountPool(accounts, disabled)
	if len(got) != 2 || got[anthropicProvider] == nil || got[openAIProvider] == nil || len(got[anthropicProvider]) != 0 || len(got[openAIProvider]) != 0 {
		t.Fatalf("all-off account pool must contain two empty arrays: %#v", got)
	}
}

func TestLoadAccountSelectionStateNormalizesPresetsAndUnknownActive(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	body := `{"active":"missing","manual":{"disabled":[{"provider":"anthropic","identityKey":"manual"}]},"presets":[` +
		`{"name":"  First  ","disabled":[{"provider":"openai-codex","identityKey":"one"}]},` +
		`{"name":"first","disabled":[{"provider":"anthropic","identityKey":"duplicate"}]},` +
		`{"name":"Manual","disabled":[]},` +
		`{"name":"Broken","disabled":[{"provider":"other","identityKey":"bad"}]},` +
		`{"name":"Second","disabled":[]}]}` + "\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	state := loadAccountSelectionState(path)
	if state.ActiveName() != accountSelectionManualName {
		t.Fatalf("unknown active selection = %q", state.ActiveName())
	}
	if !reflect.DeepEqual(state.ManualDisabled(), map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "manual"}: true}) {
		t.Fatalf("manual disabled = %#v", state.ManualDisabled())
	}
	presets := state.Presets()
	if len(presets) != 2 || presets[0].Name != "First" || presets[1].Name != "Second" {
		t.Fatalf("normalized presets = %#v", presets)
	}
}

func TestLoadAccountSelectionStateActiveNamedAndMalformedDefault(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	valid := `{"active":"night","manual":{"disabled":[]},"presets":[{"name":"Night","disabled":[{"provider":"anthropic","identityKey":"n"}]}]}`
	if err := os.WriteFile(path, []byte(valid), 0o600); err != nil {
		t.Fatal(err)
	}
	state := loadAccountSelectionState(path)
	if state.ActiveName() != "Night" || !reflect.DeepEqual(state.CurrentDisabled(), map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "n"}: true}) {
		t.Fatalf("active named state = %q / %#v", state.ActiveName(), state.CurrentDisabled())
	}
	malformedActive := `{"active":42,"manual":{"disabled":[]},"presets":[{"name":"Kept","disabled":[]}]}`
	if err := os.WriteFile(path, []byte(malformedActive), 0o600); err != nil {
		t.Fatal(err)
	}
	state = loadAccountSelectionState(path)
	if state.ActiveName() != accountSelectionManualName || len(state.Presets()) != 1 || state.Presets()[0].Name != "Kept" {
		t.Fatalf("malformed active discarded valid presets: %q / %#v", state.ActiveName(), state.Presets())
	}
	if err := os.WriteFile(path, []byte(`{"active":`), 0o600); err != nil {
		t.Fatal(err)
	}
	state = loadAccountSelectionState(path)
	if state.ActiveName() != accountSelectionManualName || len(state.ManualDisabled()) != 0 || len(state.Presets()) != 0 {
		t.Fatalf("malformed state did not default safely: %#v", state)
	}
}

func TestWriteAccountSelectionStateAtomicPrivateAndDeterministic(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "account-state")
	path := filepath.Join(parent, "state.json")
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	state := defaultAccountSelectionState()
	state.SetManualDisabled(map[accountKey]bool{
		{Provider: openAIProvider, IdentityKey: "z"}:           true,
		{Provider: anthropicProvider, IdentityKey: "b"}:        true,
		{Provider: anthropicProvider, IdentityKey: "a"}:        true,
		{Provider: openAIProvider, IdentityKey: "false-entry"}: false,
	})
	if err := state.UpsertPreset("Work", map[accountKey]bool{{Provider: openAIProvider, IdentityKey: "x"}: true}); err != nil {
		t.Fatal(err)
	}
	if err := state.UpsertPreset("Quiet", map[accountKey]bool{}); err != nil {
		t.Fatal(err)
	}
	if !state.Activate("work") {
		t.Fatal("could not activate preset")
	}
	if err := writeAccountSelectionState(path, state); err != nil {
		t.Fatal(err)
	}
	parentInfo, err := os.Stat(parent)
	if err != nil {
		t.Fatal(err)
	}
	fileInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if parentInfo.Mode().Perm() != 0o700 || fileInfo.Mode().Perm() != 0o600 {
		t.Fatalf("permissions parent=%#o file=%#o", parentInfo.Mode().Perm(), fileInfo.Mode().Perm())
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"active":"Work","manual":{"disabled":[{"provider":"anthropic","identityKey":"a"},{"provider":"anthropic","identityKey":"b"},{"provider":"openai-codex","identityKey":"z"}]},"presets":[{"name":"Work","disabled":[{"provider":"openai-codex","identityKey":"x"}]},{"name":"Quiet","disabled":[]}]}` + "\n"
	if string(body) != want {
		t.Fatalf("state JSON = %q, want %q", body, want)
	}
	loaded := loadAccountSelectionState(path)
	if loaded.ActiveName() != "Work" || !reflect.DeepEqual(loaded.CurrentDisabled(), state.CurrentDisabled()) {
		t.Fatalf("atomic replacement did not round trip: %q / %#v", loaded.ActiveName(), loaded.CurrentDisabled())
	}
	matches, err := filepath.Glob(filepath.Join(parent, ".account-state-*"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("atomic temporary files remain: %#v (%v)", matches, err)
	}
}

func TestWriteAccountSelectionStateRejectsDuplicateNamesAndCleansFailedTemporaryFile(t *testing.T) {
	parent := t.TempDir()
	state := defaultAccountSelectionState()
	state.presets = []accountSelectionPreset{{Name: "One"}, {Name: " one "}}
	if err := writeAccountSelectionState(filepath.Join(parent, "state"), state); err == nil {
		t.Fatal("case-insensitive duplicate preset names were accepted")
	}

	state = defaultAccountSelectionState()
	target := filepath.Join(parent, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeAccountSelectionState(target, state); err == nil {
		t.Fatal("atomic replacement over directory unexpectedly succeeded")
	}
	matches, err := filepath.Glob(filepath.Join(parent, ".account-state-*"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("failed write left temporary files: %#v (%v)", matches, err)
	}
}

func TestWriteAccountPoolContentsPermissionsAndIdempotentCleanup(t *testing.T) {
	accounts := map[string][]account{
		anthropicProvider: {{Provider: anthropicProvider, IdentityKey: "b"}, {Provider: anthropicProvider, IdentityKey: "a"}},
		openAIProvider:    {},
	}
	path, cleanup, err := writeAccountPool(accounts, map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "b"}: true})
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("account pool mode = %#o", info.Mode().Perm())
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string][]string
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string][]string{anthropicProvider: {"a"}, openAIProvider: {}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("account pool = %#v, want %#v", got, want)
	}
	parent := filepath.Dir(path)
	cleanup()
	cleanup()
	if _, err := os.Stat(parent); !os.IsNotExist(err) {
		t.Fatalf("account pool parent remains after cleanup: %v", err)
	}
}

func TestAuthEnvironmentReplacementAndSandboxRemoval(t *testing.T) {
	base := []string{
		"HOME=/home/test",
		"OMP_AUTH_BROKER_URL=stale-url",
		"OMP_AUTH_BROKER_TOKEN=stale-token",
		"OMP_AUTH_BROKER_SNAPSHOT_CACHE=stale-cache",
		"OMP_AUTH_BROKER_ACCOUNT_POOL_FILE=stale-pool",
		"CODE_AUTH_ACCOUNT_STATE=/state",
	}
	got := withAuthEnv(base, brokerConfig{URL: "central-url", Token: "central-token", SnapshotCache: "central-cache"}, "/new-pool")
	assertSingleEnv(t, got, "OMP_AUTH_BROKER_URL", "central-url")
	assertSingleEnv(t, got, "OMP_AUTH_BROKER_TOKEN", "central-token")
	assertSingleEnv(t, got, "OMP_AUTH_BROKER_SNAPSHOT_CACHE", "central-cache")
	assertSingleEnv(t, got, "OMP_AUTH_BROKER_ACCOUNT_POOL_FILE", "/new-pool")
	if !containsEnv(got, "CODE_AUTH_ACCOUNT_STATE", "/state") {
		t.Fatal("trusted auth overlay must preserve account manager state path")
	}
	stripped := withoutAuthEnv(got)
	for _, key := range []string{"OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN", "OMP_AUTH_BROKER_SNAPSHOT_CACHE", "OMP_AUTH_BROKER_ACCOUNT_POOL_FILE", "CODE_AUTH_ACCOUNT_STATE"} {
		if hasEnvKey(stripped, key) {
			t.Fatalf("sandbox env retained %s: %#v", key, stripped)
		}
	}
	if !containsEnv(stripped, "HOME", "/home/test") {
		t.Fatal("sandbox stripping removed unrelated env")
	}
}

func TestStripProfileArgs(t *testing.T) {
	got := stripProfileArgs([]string{"--config", "x", "--profile", "work", "--profile=other", "--resume", "--", "--profile", "prompt"})
	want := []string{"--config", "x", "--resume", "--", "--profile", "prompt"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("stripped argv = %#v, want %#v", got, want)
	}
}

func TestResolveBrokerPrefersCentralEnvironmentAndFallsBackToFirstLegacyEntry(t *testing.T) {
	dir := t.TempDir()
	firstToken := filepath.Join(dir, "first-token")
	secondToken := filepath.Join(dir, "second-token")
	if err := os.WriteFile(firstToken, []byte("first-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secondToken, []byte("second-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := `[{"brokerUrl":"first-url","tokenFile":` + strconvQuote(firstToken) + `,"snapshotCache":"first-cache"},{"brokerUrl":"second-url","tokenFile":` + strconvQuote(secondToken) + `}]`
	t.Setenv("OMP_AUTH_BROKER_URL", "")
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "")
	t.Setenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE", "")
	if got := resolveBroker(manifest, ""); got != (brokerConfig{URL: "first-url", Token: "first-secret", SnapshotCache: "first-cache"}) {
		t.Fatalf("legacy fallback = %#v", got)
	}
	manifestPath := filepath.Join(dir, "manifest.json")
	if err := os.WriteFile(manifestPath, []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := resolveBroker("", manifestPath); got.URL != "first-url" || got.Token != "first-secret" {
		t.Fatalf("legacy file fallback = %#v", got)
	}
	t.Setenv("OMP_AUTH_BROKER_URL", "central-url")
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "central-secret")
	t.Setenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE", "central-cache")
	if got := resolveBroker(`not JSON`, filepath.Join(dir, "missing")); got != (brokerConfig{URL: "central-url", Token: "central-secret", SnapshotCache: "central-cache"}) {
		t.Fatalf("central environment must bypass legacy data: %#v", got)
	}
}

func accountKeys(accounts []account) []string {
	keys := make([]string, len(accounts))
	for i := range accounts {
		keys[i] = accounts[i].IdentityKey
	}
	return keys
}

func assertSingleEnv(t *testing.T, env []string, key, value string) {
	t.Helper()
	count := 0
	for _, entry := range env {
		if strings.HasPrefix(entry, key+"=") {
			count++
			if entry != key+"="+value {
				t.Fatalf("%s entry = %q", key, entry)
			}
		}
	}
	if count != 1 {
		t.Fatalf("%s count = %d in %#v", key, count, env)
	}
}

func containsEnv(env []string, key, value string) bool {
	for _, entry := range env {
		if entry == key+"="+value {
			return true
		}
	}
	return false
}

func hasEnvKey(env []string, key string) bool {
	for _, entry := range env {
		if strings.HasPrefix(entry, key+"=") {
			return true
		}
	}
	return false
}

func strconvQuote(value string) string {
	body, _ := json.Marshal(value)
	return string(body)
}

// TestFetchDeepSeekBalance covers the upstream balance contract: numeric
// fields as JSON strings, USD preferred over other currencies, and the
// documented degrade paths (is_available=false, HTTP failure).
func TestFetchDeepSeekBalance(t *testing.T) {
	var authorization string
	payload := `{"is_available":true,"balance_infos":[
		{"currency":"CNY","total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"},
		{"currency":"USD","total_balance":"12.34","granted_balance":"0.00","topped_up_balance":"12.34"}
	]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(payload))
	}))
	defer server.Close()
	saved := deepseekBalanceURL
	deepseekBalanceURL = server.URL
	defer func() { deepseekBalanceURL = saved }()

	got, err := fetchDeepSeekBalance("sk-test")
	if err != nil {
		t.Fatal(err)
	}
	if authorization != "Bearer sk-test" {
		t.Fatalf("authorization = %q", authorization)
	}
	if !got.ok || got.currency != "USD" || got.total != "12.34" {
		t.Fatalf("balance = %+v, want the USD entry", got)
	}

	payload = `{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"7.5"}]}`
	if got, err = fetchDeepSeekBalance("sk-test"); err != nil || !got.ok || got.currency != "CNY" || got.total != "7.5" {
		t.Fatalf("no-USD fallback = %+v (err %v), want the first entry", got, err)
	}

	payload = `{"is_available":false,"balance_infos":[]}`
	if got, err = fetchDeepSeekBalance("sk-test"); err != nil || got.ok {
		t.Fatalf("unavailable account must degrade without error, got %+v (err %v)", got, err)
	}

	server.Close()
	if _, err := fetchDeepSeekBalance("sk-test"); err == nil {
		t.Fatal("transport failure must surface as an error")
	}
}

// TestFetchDeepSeekBalanceHTTPError: a non-200 answer is an error, not a
// zero balance.
func TestFetchDeepSeekBalanceHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	saved := deepseekBalanceURL
	deepseekBalanceURL = server.URL
	defer func() { deepseekBalanceURL = saved }()
	if _, err := fetchDeepSeekBalance("sk-test"); err == nil {
		t.Fatal("HTTP 500 must surface as an error")
	}
}

// TestDeepSeekKeyStaysInMemory is the security boundary of the balance
// feature: the api_key parsed from the broker snapshot must exist only on the
// in-memory account struct and never reach any serialized artifact — neither
// the usage cache (which marshals the accounts map) nor the account state.
func TestDeepSeekKeyStaysInMemory(t *testing.T) {
	snapshot := []byte(`{"credentials":[
		{"id":7,"provider":"deepseek","identityKey":null,"credential":{"type":"api_key","key":"sk-secret-x"}},
		{"provider":"anthropic","identityKey":"a-claude","credential":{"type":"oauth","email":"a@example.com"}}
	]}`)
	accounts, err := parseAccountSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	ds := accounts[deepseekProvider]
	if len(ds) != 1 || ds[0].apiKey != "sk-secret-x" || ds[0].credentialID != "7" {
		t.Fatalf("deepseek account = %+v, want in-memory key and credential id", ds)
	}
	if got := deepseekAPIKey(accounts); got != "sk-secret-x" {
		t.Fatalf("deepseekAPIKey = %q", got)
	}

	// The usage cache serializes the accounts map wholesale: the unexported
	// key field must not survive the round trip.
	body, err := json.Marshal(usageCacheFile{SavedAt: 1, Accounts: accounts})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "sk-") {
		t.Fatalf("api key leaked into the usage cache payload: %s", body)
	}

	// The forwarded account pool is OAuth-only; deepseek must not appear.
	pool := buildAccountPool(accounts, nil)
	if _, ok := pool[deepseekProvider]; ok {
		t.Fatalf("account pool grew an api_key provider: %#v", pool)
	}

	// Account state persists only {provider, identityKey} pairs of known
	// providers; a deepseek OAuth-style entry would be inventable only by
	// hand and must round-trip (registry filter, not the old two-literal
	// allow-list).
	statePath := filepath.Join(t.TempDir(), "state.json")
	state := defaultAccountSelectionState()
	state.SetManualDisabled(map[accountKey]bool{{Provider: deepseekProvider, IdentityKey: "k"}: true})
	if err := writeAccountSelectionState(statePath, state); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "sk-") {
		t.Fatalf("api key leaked into account state: %s", raw)
	}
	loaded := loadAccountSelectionState(statePath)
	if !loaded.CurrentDisabled()[accountKey{Provider: deepseekProvider, IdentityKey: "k"}] {
		t.Fatalf("registry-known provider entry did not round-trip: %#v", loaded.CurrentDisabled())
	}
}
