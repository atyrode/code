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
	"time"
)

const day = int64(86400)

func TestParseVaults(t *testing.T) {
	got := parseVaults(`[
		{"id":"primary","label":"primary","profile":"default","claude":"Operator","codex":"Operator","brokerUrl":"u1","tokenFile":"t1","snapshotCache":"c1"},
		{"id":"secondary","profile":"secondary","claude":"Collaborator"},
		{"id":"../bad","label":"bad"},
		{"id":"primary","label":"duplicate"}
	]`)
	want := []vault{
		{ID: "primary", Label: "primary", Profile: "default", Claude: "Operator", Codex: "Operator", BrokerURL: "u1", TokenFile: "t1", SnapshotCache: "c1"},
		{ID: "secondary", Label: "secondary", Profile: "secondary", Claude: "Collaborator", Codex: "secondary"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("vaults = %#v, want %#v", got, want)
	}
}

func TestParseVaultsEmptyFallback(t *testing.T) {
	got := parseVaults("")
	if len(got) != 1 || got[0].ID != "default" || got[0].Profile != "default" {
		t.Fatalf("empty manifest must degrade to a single default vault, got %#v", got)
	}
}

func TestLoadVaultsFromMachineLocalFile(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	path := filepath.Join(configHome, "code", "auth-vaults.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`[
		{"id":"local","profile":"local-profile","claude":"Owner A","codex":"Owner B"}
	]`), 0o600); err != nil {
		t.Fatal(err)
	}
	got := loadVaults("", "")
	if len(got) != 1 || got[0].ID != "local" || got[0].Profile != "local-profile" {
		t.Fatalf("XDG-local vault manifest was not loaded: %#v", got)
	}

	override := loadVaults(`[{"id":"override","profile":"one-shot"}]`, path)
	if len(override) != 1 || override[0].ID != "override" {
		t.Fatalf("explicit JSON must override the local file: %#v", override)
	}
}

func TestResolveVaultsRetainsOnlyWritableManifestPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vaults.json")
	_, gotPath := resolveVaults("", path)
	if gotPath != path {
		t.Fatalf("resolved manifest path = %q, want %q", gotPath, path)
	}
	_, gotPath = resolveVaults(`[{"id":"raw"}]`, path)
	if gotPath != "" {
		t.Fatalf("raw JSON override must disable editing, path=%q", gotPath)
	}
	_, gotPath = resolveVaults("", "vaults-in-repository.json")
	if gotPath != "" {
		t.Fatalf("repository-relative manifest must disable editing, path=%q", gotPath)
	}
}

func TestNewVaultSlugCollisionAndLocalPaths(t *testing.T) {
	state, cache := t.TempDir(), t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	t.Setenv("XDG_CACHE_HOME", cache)
	existing := []vault{{
		ID: "team-vault", Profile: "team-vault", BrokerURL: "http://127.0.0.1:43123",
	}}
	got, err := newVault("  Team Vault!  ", existing)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "team-vault-2" || got.Profile != "team-vault-2" || got.Label != "Team Vault!" {
		t.Fatalf("collision-safe identity = %+v", got)
	}
	if !strings.HasPrefix(got.BrokerURL, "http://127.0.0.1:") || got.BrokerURL == existing[0].BrokerURL {
		t.Fatalf("broker URL is not unique loopback: %q", got.BrokerURL)
	}
	if got.TokenFile != filepath.Join(state, "code", "auth-vaults", got.ID, "broker.token") {
		t.Fatalf("token path = %q", got.TokenFile)
	}
	if got.SnapshotCache != filepath.Join(cache, "code", "auth-vaults", got.ID, "snapshot.json") {
		t.Fatalf("snapshot path = %q", got.SnapshotCache)
	}
}

func TestWriteVaultManifestAtomicPrivateAndPreservesEntries(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "private")
	path := filepath.Join(parent, "vaults.json")
	first := vault{
		ID: "primary", Label: "Primary", Profile: "default", Claude: "configured owner",
		Codex: "configured owner", BrokerURL: "http://127.0.0.1:43123",
		TokenFile: "/state/primary/token", SnapshotCache: "/cache/primary/snapshot.json",
	}
	second := vault{
		ID: "secondary", Label: "Secondary", Profile: "secondary",
		BrokerURL: "http://127.0.0.1:43124", TokenFile: "/state/secondary/token",
		SnapshotCache: "/cache/secondary/snapshot.json",
	}
	if err := writeVaultManifest(path, []vault{first, second}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("manifest mode = %o, want 600", info.Mode().Perm())
	}
	parentInfo, err := os.Stat(parent)
	if err != nil {
		t.Fatal(err)
	}
	if parentInfo.Mode().Perm() != 0o700 {
		t.Fatalf("manifest parent mode = %o, want 700", parentInfo.Mode().Perm())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip []vault
	if err := json.Unmarshal(data, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(roundTrip, []vault{first, second}) {
		t.Fatalf("manifest round trip changed entries: %#v", roundTrip)
	}
}

func TestLoadVaultAccountsReadsOnlyRedactedIdentityMetadata(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("vault-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Method != http.MethodGet || r.URL.Path != "/v1/snapshot" {
			t.Fatalf("identity discovery request = %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer vault-secret" {
			t.Fatal("identity discovery omitted the vault bearer token")
		}
		_, _ = w.Write([]byte(`{"credentials":[
			{"provider":"anthropic","identityKey":"email:collaborator@example.test","credential":{"email":"collaborator@example.test","access":"must-not-decode","refresh":"must-not-decode"}},
			{"provider":"openai-codex","identityKey":"email:operator@example.test","credential":{"email":"operator@example.test","access":"must-not-decode"}},
			{"provider":"cerebras","identityKey":"key:ignored","credential":{}}
		]}`))
	}))
	defer server.Close()

	accounts, err := loadVaultAccounts(vault{BrokerURL: server.URL, TokenFile: tokenPath})
	if err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("snapshot requests = %d, want 1", requests)
	}
	if got := accounts["anthropic"]; len(got) != 1 || got[0].Email != "collaborator@example.test" {
		t.Fatalf("Claude identity = %#v", got)
	}
	if got := accounts["openai-codex"]; len(got) != 1 || got[0].IdentityKey != "email:operator@example.test" {
		t.Fatalf("Codex identity = %#v", got)
	}
	if _, ok := accounts["cerebras"]; ok {
		t.Fatal("unmanaged provider leaked into vault identity display")
	}
	if got, err := os.ReadFile(tokenPath); err != nil || string(got) != "vault-secret\n" {
		t.Fatal("identity discovery mutated the token file")
	}
}

func TestLoadAvailabilityUsesReadOnlyBrokerUsage(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("vault-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var methods []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method+" "+r.URL.Path)
		switch r.URL.Path {
		case "/v1/snapshot":
			_, _ = w.Write([]byte(`{"credentials":[
				{"provider":"anthropic","identityKey":"email:collaborator@example.test","credential":{"email":"collaborator@example.test"}}
			]}`))
		case "/v1/usage":
			_, _ = w.Write([]byte(`{"reports":[
				{"provider":"anthropic","limits":[
					{"label":"Claude 5 Hour","scope":{"tier":"-"},"amount":{"usedFraction":0.42},"window":{"resetsAt":4102444800000,"durationMs":18000000}}
				]}
			]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	v := vault{BrokerURL: server.URL, TokenFile: tokenPath}
	got := loadAvailability("/definitely/not/a/command usage --json", v)
	if !got.ok || !got.accountsOK {
		t.Fatalf("broker availability was not loaded: %+v", got)
	}
	if len(got.wins) != 1 || got.wins[0].pct != 42 || got.wins[0].prov != "anthropic" {
		t.Fatalf("broker usage = %+v", got.wins)
	}
	wantMethods := []string{"GET /v1/snapshot", "GET /v1/usage"}
	if !reflect.DeepEqual(methods, wantMethods) {
		t.Fatalf("broker discovery requests = %v, want read-only %v", methods, wantMethods)
	}
}

func TestLoadAvailabilitySupplementsMissingFableFromVaultProfile(t *testing.T) {
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token")
	argsPath := filepath.Join(dir, "args")
	envPath := filepath.Join(dir, "env")
	if err := os.WriteFile(tokenPath, []byte("vault-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "usage")
	body := "#!/bin/sh\n" +
		"printf '%s\\n' \"$@\" > \"$ARGS_PATH\"\n" +
		"printf '%s|%s|%s\\n' \"${OMP_AUTH_BROKER_URL+set}\" \"${OMP_AUTH_BROKER_TOKEN+set}\" \"${OMP_AUTH_BROKER_SNAPSHOT_CACHE+set}\" > \"$ENV_PATH\"\n" +
		"printf '%s\\n' '{\"reports\":[{\"provider\":\"anthropic\",\"limits\":[{\"id\":\"anthropic:5h\",\"label\":\"Claude 5 Hour\",\"scope\":{\"provider\":\"anthropic\",\"windowId\":\"5h\",\"shared\":true},\"amount\":{\"usedFraction\":0.12},\"window\":{\"resetsAt\":4102444800000,\"durationMs\":18000000}},{\"id\":\"anthropic:7d:fable\",\"label\":\"Claude 7 Day (Fable)\",\"scope\":{\"provider\":\"anthropic\",\"windowId\":\"7d\",\"tier\":\"fable\"},\"amount\":{\"usedFraction\":0.27},\"window\":{\"resetsAt\":4102444800000,\"durationMs\":604800000}}]}]}'\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ARGS_PATH", argsPath)
	t.Setenv("ENV_PATH", envPath)
	t.Setenv("OMP_AUTH_BROKER_URL", "http://ambient.invalid")
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "ambient-secret")
	t.Setenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE", "/ambient/cache")

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/snapshot":
			_, _ = w.Write([]byte(`{"credentials":[]}`))
		case "/v1/usage":
			_, _ = w.Write([]byte(`{"reports":[
				{"provider":"openai-codex","limits":[
					{"id":"openai-codex:primary","label":"7 days","scope":{"tier":"-"},"amount":{"usedFraction":0.31},"window":{"resetsAt":4102444800000,"durationMs":604800000}}
				]},
				{"provider":"anthropic","limits":[
					{"id":"anthropic:5h","label":"Claude 5 Hour","scope":{"tier":"-"},"amount":{"usedFraction":0.42},"window":{"resetsAt":4102444800000,"durationMs":18000000}}
				]}
			]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	v := vault{ID: "mine", Profile: "mine", BrokerURL: server.URL, TokenFile: tokenPath}
	got := loadAvailability(script+" --profile default usage --json", v)
	var codex, fable *usageWin
	for i := range got.wins {
		switch {
		case got.wins[i].prov == "openai-codex":
			codex = &got.wins[i]
		case got.wins[i].tier == "fable":
			fable = &got.wins[i]
		}
	}
	if codex == nil || codex.pct != 31 {
		t.Fatalf("broker Codex usage was not preserved: %+v", got.wins)
	}
	if fable == nil || fable.pct != 27 || got.bucket["claude-fable"] != "ok" {
		t.Fatalf("profile-local Fable usage was not supplemented: wins=%+v buckets=%+v", got.wins, got.bucket)
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if want := "--profile\nmine\nusage\n--json\n--provider\nanthropic\n"; string(args) != want {
		t.Fatalf("Fable supplement argv = %q, want %q", args, want)
	}
	env, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(env) != "||\n" {
		t.Fatalf("Fable supplement inherited broker routing: %q", env)
	}
}

func TestLoadVaultStateMigratesPlainFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state")
	if err := os.WriteFile(p, []byte("secondary\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	vaults := []vault{{ID: "primary"}, {ID: "secondary"}, {ID: "tertiary"}}
	sel, dis := loadVaultState(vaults, p)
	if sel != "secondary" {
		t.Fatalf("plain selected-id file must migrate to selected=secondary, got %q", sel)
	}
	if len(dis) != 0 {
		t.Fatalf("migration must leave no disabled vaults, got %#v", dis)
	}
}

func TestLoadVaultStateJSON(t *testing.T) {
	vaults := []vault{{ID: "primary"}, {ID: "secondary"}, {ID: "tertiary"}}
	p := filepath.Join(t.TempDir(), "state")

	// The first entry can never be disabled; unknown ids are dropped.
	if err := os.WriteFile(p, []byte(`{"selected":"tertiary","disabled":["secondary","primary","ghost"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	sel, dis := loadVaultState(vaults, p)
	if sel != "tertiary" {
		t.Fatalf("selected = %q, want tertiary", sel)
	}
	if !dis["secondary"] || dis["primary"] || dis["ghost"] {
		t.Fatalf("disabled must keep secondary, strip primary, drop ghost, got %#v", dis)
	}

	// A selection that is itself disabled collapses onto the fallback vault.
	if err := os.WriteFile(p, []byte(`{"selected":"secondary","disabled":["secondary"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	sel, _ = loadVaultState(vaults, p)
	if sel != "primary" {
		t.Fatalf("a disabled selection must fall back to the first vault, got %q", sel)
	}
}

func TestVaultStatePersistRoundTrip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "nested", "state")
	if err := writeVaultState(p, "tertiary", map[string]bool{"secondary": true}); err != nil {
		t.Fatal(err)
	}
	vaults := []vault{{ID: "primary"}, {ID: "secondary"}, {ID: "tertiary"}}
	sel, dis := loadVaultState(vaults, p)
	if sel != "tertiary" || !dis["secondary"] {
		t.Fatalf("round trip lost state: selected=%q disabled=%#v", sel, dis)
	}
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("state mode = %o, want 600", info.Mode().Perm())
	}
}

func TestCycleVaultSkipsDisabled(t *testing.T) {
	m := model{
		vaults:   []vault{{ID: "primary"}, {ID: "secondary"}, {ID: "tertiary"}},
		disabled: map[string]bool{"secondary": true},
		avail:    availability{bucket: map[string]string{}, reset: map[string]int64{}},
	}
	changed, err := m.cycleVault()
	if err != nil || !changed {
		t.Fatalf("cycle from the fallback must advance: changed=%v err=%v", changed, err)
	}
	if got := m.activeVault().ID; got != "tertiary" {
		t.Fatalf("cycle skipped the disabled secondary but landed on %q, want tertiary", got)
	}
	changed, _ = m.cycleVault()
	if !changed || m.activeVault().ID != "primary" {
		t.Fatalf("cycle from tertiary must wrap past disabled secondary to primary, got %q", m.activeVault().ID)
	}
}

func TestSelectVaultRestoresIndependentUsageCache(t *testing.T) {
	deadline := time.Now().Add(2 * time.Minute)
	cached := availability{
		ok:         true,
		accountsOK: true,
		bucket:     map[string]string{"claude-main": "ok"},
		reset:      map[string]int64{"claude-main": 120},
		wins:       []usageWin{{label: "Claude 5 Hour", pct: 37}},
	}
	m := model{
		vaults:          []vault{{ID: "primary"}, {ID: "secondary"}},
		selected:        "primary",
		vaultUsage:      map[string]availability{"secondary": cached},
		vaultUsageNext:  map[string]time.Time{"secondary": deadline},
		vaultUsageStale: map[string]bool{"secondary": true},
		vaultFetching:   map[string]bool{"secondary": true},
	}

	if !m.selectVault(1) {
		t.Fatal("selectVault must move to secondary")
	}
	if !reflect.DeepEqual(m.avail, cached) {
		t.Fatalf("cached Usage was not restored: got %+v want %+v", m.avail, cached)
	}
	if m.nextRefresh != deadline || !m.usageStale || !m.fetching || !m.hadUsage {
		t.Fatalf("per-vault cache metadata was not restored: deadline=%v stale=%v fetching=%v had=%v",
			m.nextRefresh, m.usageStale, m.fetching, m.hadUsage)
	}
}

func TestCycleVaultSingleEnabledIsNoop(t *testing.T) {
	m := model{
		vaults:   []vault{{ID: "primary"}, {ID: "secondary"}},
		disabled: map[string]bool{"secondary": true},
		avail:    availability{bucket: map[string]string{}, reset: map[string]int64{}},
	}
	changed, err := m.cycleVault()
	if err != nil || changed {
		t.Fatalf("with only the fallback enabled, cycle must be a no-op: changed=%v err=%v", changed, err)
	}
	if m.activeVault().ID != "primary" {
		t.Fatalf("active vault moved off the fallback: %q", m.activeVault().ID)
	}
}

func TestFallbackProtection(t *testing.T) {
	m := model{
		vaults:   []vault{{ID: "primary"}, {ID: "secondary"}},
		disabled: map[string]bool{},
		avail:    availability{bucket: map[string]string{}, reset: map[string]int64{}},
	}
	if changed, err := m.toggleVault(0); changed || err != nil {
		t.Fatalf("toggling the fallback vault must be a no-op: changed=%v err=%v", changed, err)
	}
	if m.disabled["primary"] || !m.isEnabled(0) {
		t.Fatal("the fallback vault must never become disabled")
	}

	// Disabling the active vault falls the selection back to the fallback.
	m.selected = "secondary"
	changed, err := m.toggleVault(1)
	if err != nil {
		t.Fatal(err)
	}
	if !m.disabled["secondary"] {
		t.Fatal("secondary must be disabled after toggle")
	}
	if !changed || m.activeVault().ID != "primary" {
		t.Fatalf("disabling the active vault must fall back to primary (changed=%v active=%q)", changed, m.activeVault().ID)
	}
	if m.enabledCount() != 1 {
		t.Fatalf("at least one vault must stay enabled, enabledCount=%d", m.enabledCount())
	}
}

func TestBrokerEnv(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("s3cr3t\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	v := vault{BrokerURL: "http://127.0.0.1:9", TokenFile: tokenPath, SnapshotCache: "/cache/secondary"}
	env, err := brokerEnv(v)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"OMP_AUTH_BROKER_URL=http://127.0.0.1:9",
		"OMP_AUTH_BROKER_SNAPSHOT_CACHE=/cache/secondary",
		"OMP_AUTH_BROKER_TOKEN=s3cr3t",
	}
	if !reflect.DeepEqual(env, want) {
		t.Fatalf("broker env = %#v, want %#v", env, want)
	}
}

func TestBrokerEnvTokenFailure(t *testing.T) {
	v := vault{BrokerURL: "u", TokenFile: filepath.Join(t.TempDir(), "missing")}
	if _, err := brokerEnv(v); err == nil {
		t.Fatal("a missing token file must be a hard error")
	}
	// The failure must surface as an unavailable usage result, never a launch.
	if got := loadAvailability("true usage --json", v); got.ok {
		t.Fatal("a token failure must yield unavailable usage")
	}
}

func TestLoadAvailabilityStandaloneForcesDefaultProfile(t *testing.T) {
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args")
	script := filepath.Join(dir, "usage")
	body := "#!/bin/sh\n" +
		"printf '%s\\n' \"$@\" > \"$ARGS_PATH\"\n" +
		"printf '%s\\n' '{\"reports\":[]}'\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ARGS_PATH", argsPath)

	got := loadAvailability(script+" --profile secondary usage --json", vault{ID: "standalone"})
	if !got.ok {
		t.Fatal("standalone usage response was not accepted")
	}
	args, err := os.ReadFile(argsPath)
	if err != nil {
		t.Fatal(err)
	}
	if want := "--profile\ndefault\nusage\n--json\n"; string(args) != want {
		t.Fatalf("standalone usage must force the shared default profile: args = %q, want %q", args, want)
	}
}

func TestTrustedLaunchForcesDefaultProfile(t *testing.T) {
	// Both trusted launch paths force --profile default and strip any forwarded
	// profile, regardless of the selected vault's own profile.
	forwarded := []string{"--config", "/tmp/x.yml", "--profile", "secondary", "--resume"}
	managed := managedLaunchArgv("/bin/omp", forwarded, "hello")
	wantManaged := []string{"/bin/omp", "--profile", "default", "--config", "/tmp/x.yml", "--resume", "hello"}
	if !reflect.DeepEqual(managed, wantManaged) {
		t.Fatalf("managed launch argv = %#v, want %#v", managed, wantManaged)
	}

	gen := generatedLaunchArgv("/bin/omp", "/tmp/gen.yml", []string{"--profile", "secondary", "--resume"}, "")
	wantGen := []string{"/bin/omp", "--profile", "default", "--config", "/tmp/gen.yml", "--resume"}
	if !reflect.DeepEqual(gen, wantGen) {
		t.Fatalf("generated launch argv = %#v, want %#v", gen, wantGen)
	}
}

func TestSandboxLaunchStripsProfile(t *testing.T) {
	got := sandboxLaunchArgv("/bin/ompu", []string{"--profile", "secondary", "--resume"}, "")
	want := []string{"/bin/ompu", "--resume"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sandbox launch argv = %#v, want %#v (profile must be stripped, none forced)", got, want)
	}
}

func TestLoginArgv(t *testing.T) {
	if got := loginArgv("tertiary", "anthropic"); !reflect.DeepEqual(got, []string{"--profile", "tertiary", "auth-broker", "login", "anthropic"}) {
		t.Fatalf("anthropic login argv = %#v", got)
	}
	if got := loginArgv("secondary", "openai-codex"); !reflect.DeepEqual(got, []string{"--profile", "secondary", "auth-broker", "login", "openai-codex"}) {
		t.Fatalf("openai-codex login argv = %#v", got)
	}
}

func TestWithBrokerEnvOverridesAmbient(t *testing.T) {
	base := []string{"PATH=/bin", "OMP_AUTH_BROKER_TOKEN=stale", "HOME=/root"}
	add := []string{"OMP_AUTH_BROKER_TOKEN=fresh", "OMP_AUTH_BROKER_URL=u"}
	got := withBrokerEnv(base, add)
	want := []string{"PATH=/bin", "HOME=/root", "OMP_AUTH_BROKER_TOKEN=fresh", "OMP_AUTH_BROKER_URL=u"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("withBrokerEnv = %#v, want %#v", got, want)
	}
}

func TestWithOMPProfileOverridesForwardedProfile(t *testing.T) {
	tests := []struct {
		name    string
		profile string
		args    []string
		want    []string
	}{
		{
			name:    "no override",
			profile: "default",
			args:    []string{"--config", "/tmp/generated.yml", "--resume"},
			want:    []string{"--profile", "default", "--config", "/tmp/generated.yml", "--resume"},
		},
		{
			name:    "separate override",
			profile: "default",
			args:    []string{"--config", "/tmp/generated.yml", "--profile", "secondary", "--resume"},
			want:    []string{"--profile", "default", "--config", "/tmp/generated.yml", "--resume"},
		},
		{
			name:    "equals override",
			profile: "default",
			args:    []string{"--profile=secondary", "--resume"},
			want:    []string{"--profile", "default", "--resume"},
		},
		{
			name:    "message after terminator",
			profile: "default",
			args:    []string{"--resume", "--", "--profile", "literal message"},
			want:    []string{"--profile", "default", "--resume", "--", "--profile", "literal message"},
		},
		{
			name:    "sandbox strips override",
			profile: "",
			args:    []string{"--profile", "secondary", "--resume"},
			want:    []string{"--resume"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := withOMPProfile(tt.profile, tt.args...)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("args = %#v, want %#v", got, tt.want)
			}
		})
	}
}

// TestUsagePanelNamesActiveVaultAndBrokerAccounts locks the identity boundary:
// the title names the custom vault, provider headings stay provider-only, and
// account identity never comes from configured login-owner labels.
func TestUsagePanelNamesActiveVaultAndBrokerAccounts(t *testing.T) {
	m := model{
		vaults: []vault{
			{ID: "primary", Label: "primary", Profile: "default", Claude: "Operator", Codex: "Operator"},
			{ID: "secondary", Label: "secondary", Profile: "secondary", Claude: "Collaborator", Codex: "Operator"},
		},
		selected: "secondary",
		avail:    availability{bucket: map[string]string{}, reset: map[string]int64{}},
	}
	panel := stripAnsi(m.usagePanel())
	for _, text := range []string{"usage", "secondary", "Codex", "Claude", "account status unavailable", "a switch vault"} {
		if !strings.Contains(panel, text) {
			t.Fatalf("usage panel missing %q: %q", text, panel)
		}
	}
	for _, configuredOwner := range []string{"Collaborator", "Operator", "Claude (", "Codex ("} {
		if strings.Contains(panel, configuredOwner) {
			t.Fatalf("usage panel leaked configured owner %q: %q", configuredOwner, panel)
		}
	}
}

func TestCreditLine(t *testing.T) {
	tests := []struct {
		name    string
		credits resetCredits
		want    string
	}{
		{"absent", resetCredits{}, ""},
		{"count only", resetCredits{avail: 2}, "2 resets"},
		{"singular", resetCredits{avail: 1, exp: []int64{3 * day}}, "1 reset · expiring in 3d"},
		{"sorted ascending", resetCredits{avail: 3, exp: []int64{28 * day, 11 * day, 16 * day}}, "3 resets · expiring in 11d, 16d, 28d"},
		{"capped at three soonest", resetCredits{avail: 5, exp: []int64{40 * day, 2 * day, 30 * day, 9 * day, 20 * day}}, "5 resets · expiring in 2d, 9d, 20d"},
		{"rounds up to whole days", resetCredits{avail: 3, exp: []int64{1, day, day + 1}}, "3 resets · expiring in 1d, 1d, 2d"},
		{"expired reads zero", resetCredits{avail: 0, exp: []int64{-5}}, "0 resets · expiring in 0d"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := model{avail: availability{credits: tt.credits}}
			got := m.creditLine()
			if tt.want == "" {
				if got != "" {
					t.Fatalf("creditLine() = %q, want empty", got)
				}
				return
			}
			if !strings.Contains(got, tt.want) {
				t.Fatalf("creditLine() = %q, want it to contain %q", got, tt.want)
			}
		})
	}
}

func TestUsagePanelShowsOpenAIResetCredits(t *testing.T) {
	m := model{
		vaults: []vault{{ID: "primary", Label: "primary", Profile: "default", Claude: "Operator", Codex: "Operator"}},
		avail: availability{
			ok:      true,
			bucket:  map[string]string{},
			reset:   map[string]int64{},
			wins:    []usageWin{{label: "7 days", pct: 33, secs: 6 * day, dur: 7 * day, prov: "openai-codex"}},
			credits: resetCredits{avail: 3, exp: []int64{28 * day, 11 * day, 16 * day}},
		},
	}
	panel := m.usagePanel()
	if !strings.Contains(panel, "3 resets · expiring in 11d, 16d, 28d") {
		t.Fatalf("usage panel missing reset credits: %q", panel)
	}
}

func TestUsagePanelWithoutResetCredits(t *testing.T) {
	m := model{
		vaults: []vault{{ID: "primary", Label: "primary", Profile: "default", Claude: "Operator", Codex: "Operator"}},
		avail: availability{
			ok:     true,
			bucket: map[string]string{},
			reset:  map[string]int64{},
			wins:   []usageWin{{label: "7 days", pct: 33, secs: 6 * day, dur: 7 * day, prov: "openai-codex"}},
		},
	}
	if panel := m.usagePanel(); strings.Contains(panel, "expiring") || strings.Contains(panel, "resets") {
		t.Fatalf("usage panel unexpectedly mentions reset credits: %q", panel)
	}
}
