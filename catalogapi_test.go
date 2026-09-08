package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func inspectFixtureModel(t *testing.T, path string) model {
	t.Helper()
	generated := loadBlocks(path)
	if len(generated) == 0 {
		t.Fatal("empty test catalog")
	}
	m := model{generated: generated, advisors: parseAdvisors(generated["__advisors__"]),
		facts: parseFacts(generated["__models__"]), facets: facetDefs(nil), sel: defaultSel()}
	m.applyCatalog()
	return m
}

func TestInspectGoldenRoutesMatchLaunch(t *testing.T) {
	m := inspectFixtureModel(t, "testdata/two-pool-golden.plain")
	var err error
	m, err = selectHeadlessModel(m, map[string]string{"lane": "mixed", "model": "smart", "thinking": "medium", "spark": "on", "advisor": "review"})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := projectInspect(m, time.Unix(123, 0))
	var overlay struct {
		Roles map[string]string `yaml:"modelRoles"`
		Retry struct {
			Chains map[string][]string `yaml:"fallbackChains"`
		} `yaml:"retry"`
		Task struct {
			Overrides map[string]string `yaml:"agentModelOverrides"`
		} `yaml:"task"`
	}
	if err := yaml.Unmarshal([]byte(m.genConfigYAML()), &overlay); err != nil {
		t.Fatal(err)
	}
	roles := map[string]string{}
	chains := map[string][]string{}
	overrides := map[string]string{}
	for _, route := range snapshot.Routing {
		roles[route.Role] = route.Primary
		if len(route.Fallbacks) > 0 {
			chains[route.Role] = route.Fallbacks
		}
		if route.AgentOverride {
			overrides[route.Role] = route.Primary
		}
	}
	if !reflect.DeepEqual(roles, overlay.Roles) || !reflect.DeepEqual(chains, overlay.Retry.Chains) || !reflect.DeepEqual(overrides, overlay.Task.Overrides) {
		t.Fatalf("inspection differs from effective launch routing: %#v", snapshot.Routing)
	}
	if len(roles) != 14 || roles["default"] != "openai-codex/gpt-5.6-sol:medium" || roles["security-reviewer"] != "anthropic/claude-fable-5:high" {
		t.Fatalf("golden selection lost full qualified routing: %#v", roles)
	}
	if snapshot.Estimates == nil || snapshot.Estimates.Cost < 1 || snapshot.Estimates.Cost > 5 || snapshot.Estimates.Speed < 1 || snapshot.Estimates.Speed > 5 {
		t.Fatalf("invalid estimates: %#v", snapshot.Estimates)
	}
	m, err = selectHeadlessModel(m, map[string]string{"fallback": "off", "advisor": "off"})
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range projectInspect(m, time.Now()).Routing {
		if route.Role == "advisor" || len(route.Fallbacks) != 0 {
			t.Fatalf("disabled routes exposed: %#v", route)
		}
	}
}

func TestInspectCatalogCapabilitiesAndExplicitRefusal(t *testing.T) {
	m := inspectFixtureModel(t, "testdata/two-pool-golden.plain")
	for _, selection := range []map[string]string{
		{"lane": "invented"}, {"model": "invented"}, {"unknown": "on"},
		{"lane": "gpt-only", "model": "elite"}, {"lane": "claude-only", "spark": "on"},
	} {
		if _, err := selectHeadlessModel(m, selection); err == nil {
			t.Fatalf("accepted impossible selection: %v", selection)
		}
	}
	cat, err := catalogFrom(t, fixtureYMLDeepSeek)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "catalog.plain")
	if err := os.WriteFile(path, []byte(cat.renderCatalog()), 0600); err != nil {
		t.Fatal(err)
	}
	three := inspectFixtureModel(t, path)
	three, err = selectHeadlessModel(three, map[string]string{"lane": "ds-only", "spark": "off", "model": "smart"})
	if err != nil {
		t.Fatal(err)
	}
	snapshot := projectInspect(three, time.Now())
	for _, f := range snapshot.Facets {
		if f.Key == "model" && strings.Contains(strings.Join(f.Values, ","), "elite") {
			t.Fatal("invented a fourth rung")
		}
		if f.Key == "spark" && strings.Contains(strings.Join(f.Values, ","), "on") {
			t.Fatal("invented a spark capability")
		}
	}
	found := false
	for _, p := range snapshot.Providers {
		if p.ID == "deepseek" {
			found = true
		}
	}
	if !found {
		t.Fatal("optional catalog provider omitted")
	}
	m.applyProviderAvailability(map[string]bool{"A": true})
	if _, err := selectHeadlessModel(m, map[string]string{"lane": "gpt-only"}); err == nil {
		t.Fatal("accepted unconnected provider")
	}
}

func TestInspectDefaultSelectionRoundTripsToLaunch(t *testing.T) {
	for _, provider := range []string{"", openAIProvider, anthropicProvider, deepseekProvider} {
		t.Run("provider="+provider, func(t *testing.T) {
			headlessLaunchFixture(t)
			t.Setenv("LAUNCH_PROVIDER", provider)
			m, err := loadHeadlessModel(nil)
			if err != nil {
				t.Fatal(err)
			}
			for _, args := range [][]string{nil, {"--selection", "{}"}} {
				status, body, stderr := accountAPITestRun(t, runInspect, args...)
				if status != 0 {
					t.Fatalf("inspect returned %d: %s", status, stderr)
				}
				var snapshot inspectSnapshot
				if err := json.Unmarshal([]byte(body), &snapshot); err != nil {
					t.Fatal(err)
				}
				selected, err := selectHeadlessModel(m, snapshot.Selection)
				if err != nil {
					t.Fatalf("inspect selection cannot launch: %v: %v", snapshot.Selection, err)
				}
				if !reflect.DeepEqual(snapshot.Selection, selectionChoices(selected.sel, selected.facets)) {
					t.Fatalf("inspect did not emit a full selection: %v", snapshot.Selection)
				}
				if !reflect.DeepEqual(snapshot.Routing, inspectRouting(selected)) {
					t.Fatalf("round-tripped selection changed routing: %#v", snapshot.Routing)
				}
				for _, facet := range snapshot.Facets {
					found := false
					for _, value := range facet.Values {
						if value == snapshot.Selection[facet.Key] {
							found = true
							break
						}
					}
					if !found {
						t.Fatalf("selected %s=%q is not advertised in %v", facet.Key, snapshot.Selection[facet.Key], facet.Values)
					}
				}
			}
		})
	}
}

func TestInspectCatalogWithoutProviders(t *testing.T) {
	headlessLaunchFixture(t)
	t.Setenv("LAUNCH_PROVIDER", "none")
	broker := filepath.Join(t.TempDir(), "runtime-broker")
	body := `#!/bin/sh
if [ "$1" = runtime ] && [ "$2" = list ]; then
  printf '[{"schemaVersion":1,"name":"local-test","applicable":true}]\n'
  exit 0
fi
exit 1
`
	if err := os.WriteFile(broker, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_RUNTIME_BROKER", broker)
	for _, args := range [][]string{nil, {"--selection", "{}"}} {
		status, body, stderr := accountAPITestRun(t, runInspect, args...)
		if status != 0 {
			t.Fatalf("inspect returned %d: %s", status, stderr)
		}
		var snapshot inspectSnapshot
		if err := json.Unmarshal([]byte(body), &snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.Catalog.State != "ready" || snapshot.Catalog.Path != os.Getenv("CODE_GENERATED") {
			t.Fatalf("lost the installed catalog: %#v", snapshot.Catalog)
		}
		if len(snapshot.Selection) != 0 || len(snapshot.Routing) != 0 || snapshot.Estimates != nil {
			t.Fatalf("fabricated runnable hosted selection: %#v", snapshot)
		}
		wantFacets := []inspectFacet{{Key: "runtime", Values: []string{"local-test"}}}
		if !reflect.DeepEqual(snapshot.Facets, wantFacets) {
			t.Fatalf("advertised unusable hosted choices: %#v", snapshot.Facets)
		}
		providers := map[string]string{}
		for _, provider := range snapshot.Providers {
			providers[provider.ID] = provider.CredentialState
		}
		wantProviders := map[string]string{
			openAIProvider: "unavailable", anthropicProvider: "unavailable", deepseekProvider: "unavailable",
		}
		if !reflect.DeepEqual(providers, wantProviders) {
			t.Fatalf("lost provider availability facts: %v", providers)
		}
		modes := map[string]bool{}
		for _, mode := range snapshot.LaunchModes {
			modes[mode.Mode] = mode.Available
		}
		if modes["generated"] || !modes["managed"] || !modes["untrusted"] || !modes["runtime"] {
			t.Fatalf("provider credentials changed independent launch modes: %v", modes)
		}
	}
	for _, selection := range []string{`{"lane":"gpt-only"}`, `{"model":"invented"}`} {
		status, body, stderr := accountAPITestRun(t, runInspect, "--selection", selection)
		if status != 2 || body != "" {
			t.Fatalf("explicit unavailable selection %s returned %d, %q: %s", selection, status, body, stderr)
		}
	}
}

func TestInspectManagedOnlyInstallation(t *testing.T) {
	isolateEngineEnv(t)
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "omp-managed"), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	t.Setenv("CODE_OMP", "")
	t.Setenv("CODE_OMP_UNTRUSTED", "")
	t.Setenv("CODE_GENERATED", "")
	t.Setenv("CODE_SESSION_STATE", sessionDisabled)
	status, body, stderr := accountAPITestRun(t, runInspect)
	if status != 0 {
		t.Fatalf("inspect returned %d: %s", status, stderr)
	}
	var snapshot inspectSnapshot
	if err := json.Unmarshal([]byte(body), &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.Catalog.State != "missing" || len(snapshot.Selection) != 0 || len(snapshot.Routing) != 0 {
		t.Fatalf("managed-only onboarding fabricated hosted selection: %#v", snapshot)
	}
	modes := map[string]bool{}
	for _, mode := range snapshot.LaunchModes {
		modes[mode.Mode] = mode.Available
	}
	if !modes["managed"] || modes["generated"] || modes["untrusted"] || modes["runtime"] {
		t.Fatalf("wrong managed-only launch capabilities: %v", modes)
	}
	if status, _, stderr := accountAPITestRun(t, runLaunch, "--kind", "managed"); status != 0 {
		t.Fatalf("advertised managed launch returned %d: %s", status, stderr)
	}
}

func TestInspectMissingCatalogIsOnboardingNotRouting(t *testing.T) {
	m := model{facets: facetDefs(nil), sel: defaultSel()}
	snapshot := projectInspect(m, time.Unix(123, 0))
	if snapshot.Catalog.State != "missing" || len(snapshot.Facets) != 0 || len(snapshot.Routing) != 0 || len(snapshot.Selection) != 0 || snapshot.Estimates != nil {
		t.Fatalf("fabricated first-run catalog: %#v", snapshot)
	}
	if snapshot.Catalog.ModelsPath != defaultModelsPath() || snapshot.Catalog.GeneratePath != defaultCatalogPath() {
		t.Fatal("onboarding paths differ from generate CLI")
	}
}

func TestInspectRegistryProjectionOmitsPoolsAndConversation(t *testing.T) {
	isolateHistoryTest(t)
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	const secret = "private-pool-and-conversation-canary"
	root := defaultSessionRoot()
	path := writeSavedSession(t, root, "inspect-session", cwd, "Safe title", time.Now())
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"type":"message","content":"` + secret + `"}` + "\n"); err != nil {
		t.Fatal(err)
	}
	f.Close()
	handle, err := openSession(sessionDir(), sessionRecord{PID: os.Getpid(), Profile: "generated", Cwd: cwd, Resume: "inspect-session", Started: time.Now().Unix(), Pool: map[string][]string{"provider": {secret}}})
	if err != nil {
		t.Fatal(err)
	}
	defer handle.Close()
	snapshot := projectInspect(model{}, time.Now())
	observeInspectSessions(&snapshot)
	if len(snapshot.Sessions) != 1 || snapshot.Sessions[0].Liveness != "lock_held" {
		t.Fatalf("held session not observed: %#v", snapshot.Sessions)
	}
	if len(snapshot.SavedSessions) != 1 || snapshot.SavedSessions[0].ID != "inspect-session" || snapshot.SavedSessions[0].Title != "Safe title" {
		t.Fatalf("lost saved metadata: %#v", snapshot.SavedSessions)
	}
	encoded, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), secret) || strings.Contains(string(encoded), `"pool"`) || strings.Contains(string(encoded), `"content"`) {
		t.Fatalf("private data in public projection: %s", encoded)
	}
	handle.Close()
	snapshot = projectInspect(model{}, time.Now())
	observeInspectSessions(&snapshot)
	if len(snapshot.Sessions) != 0 || len(snapshot.SavedSessions) != 1 || snapshot.SavedSessions[0].LivePID != 0 {
		t.Fatal("saved history incorrectly depends on live publisher/session")
	}
}

func TestInspectPortableChoicesDetermineAvailableProviders(t *testing.T) {
	headlessLaunchFixture(t)
	t.Setenv("CODE_GENERATED", "testdata/two-pool-golden.plain")
	server := testAccountBroker(t, `{"reports":[]}`)
	t.Setenv("OMP_AUTH_BROKER_URL", server.URL)
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "fixture")
	path := filepath.Join(t.TempDir(), "accounts.json")
	t.Setenv("CODE_AUTH_ACCOUNT_STATE", path)
	const original = "invalid standalone settings"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	state := `{"schemaVersion":1,"activePreset":"Manual","manualDisabled":[{"provider":"openai-codex","identityKey":"codex-key"},{"provider":"openai-codex","identityKey":"unmatched-key"}],"presets":[]}`
	status, body, errout := accountAPITestRun(t, runInspect, "--state", state)
	var result inspectSnapshot
	if status != 0 || json.Unmarshal([]byte(body), &result) != nil {
		t.Fatalf("portable inspect failed: %s", errout)
	}
	providers := map[string]string{}
	for _, provider := range result.Providers {
		providers[provider.ID] = provider.CredentialState
	}
	if providers["openai-codex"] != "unavailable" || providers["anthropic"] != "available" {
		t.Fatalf("preview ignored selected account pool: %v", providers)
	}
	status, body, _ = accountAPITestRun(t, runInspect, "--state", state, "--selection", `{"lane":"gpt-only"}`)
	if status == 0 || body != "" {
		t.Fatal("explicit disabled provider produced a launch preview")
	}
	status, body, errout = accountAPITestRun(t, runInspect, "--state", portableAccountTestState, "--selection", `{"lane":"gpt-only"}`)
	if status != 0 {
		t.Fatalf("enabled portable provider remained unavailable: %s", errout)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != original {
		t.Fatal("portable inspection changed standalone settings")
	}
	requireNoPath(t, path+".lock")
}

func TestPortableObservationsRefuseBrokerlessLocalCredentials(t *testing.T) {
	capture := headlessLaunchFixture(t)
	t.Setenv("CODE_AUTH_ACCOUNT_STATE", filepath.Join(t.TempDir(), "missing", "accounts.json"))
	status, body, errout := accountAPITestRun(t, runInspect)
	var standalone inspectSnapshot
	if status != 0 || json.Unmarshal([]byte(body), &standalone) != nil {
		t.Fatalf("standalone credential fallback failed: %s", errout)
	}
	available := false
	for _, provider := range standalone.Providers {
		if provider.ID == "openai-codex" && provider.CredentialState == "available" {
			available = true
		}
	}
	if !available {
		t.Fatal("fixture did not expose standalone local credentials")
	}
	state := `{"schemaVersion":1,"activePreset":"Manual","manualDisabled":[{"provider":"openai-codex","identityKey":"a@example.com"}],"presets":[]}`
	for _, command := range []struct {
		run  func([]string) int
		args []string
	}{
		{runInspect, []string{"--state", state}},
		{runSuggest, []string{"--state", state, "--prompt", "critical refactor"}},
	} {
		status, body, _ := accountAPITestRun(t, command.run, command.args...)
		if status == 0 || body != "" {
			t.Fatalf("portable observation borrowed local credential authority: %s", body)
		}
	}
	requireNoPath(t, filepath.Join(capture, "argv"))
	requireNoPath(t, os.Getenv("CODE_AUTH_ACCOUNT_STATE"))
}
