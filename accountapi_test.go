package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func accountAPITestRun(t *testing.T, run func([]string) int, args ...string) (int, string, string) {
	t.Helper()
	out, err := os.CreateTemp(t.TempDir(), "stdout")
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	errout, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	defer errout.Close()
	oldOut, oldErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = out, errout
	defer func() { os.Stdout, os.Stderr = oldOut, oldErr }()
	status := run(args)
	body, err := os.ReadFile(out.Name())
	if err != nil {
		t.Fatal(err)
	}
	errors, err := os.ReadFile(errout.Name())
	if err != nil {
		t.Fatal(err)
	}
	return status, string(body), string(errors)
}

func accountAPITestBroker(t *testing.T) (brokerConfig, map[string][]account, <-chan string) {
	t.Helper()
	cleared := make(chan string, 1)
	snapshot := `{"credentials":[
		{"id":"private-broker-id","provider":"openai-codex","identityKey":"a@example.com","credential":{"type":"oauth","email":"a@example.com"}},
		{"id":"private-other-id","provider":"openai-codex","identityKey":"b@example.com","credential":{"type":"oauth","email":"b@example.com"}}
	]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-broker-token" {
			t.Error("broker authorization missing")
		}
		switch {
		case r.Method == http.MethodDelete:
			cleared <- r.URL.Path
			w.WriteHeader(http.StatusNoContent)
		case r.URL.Path == "/v1/snapshot":
			fmt.Fprint(w, snapshot)
		default:
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprint(w, "private-provider-error-body")
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("OMP_AUTH_BROKER_URL", server.URL)
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "private-broker-token")
	t.Setenv("CODE_AUTH_ACCOUNT_STATE", filepath.Join(t.TempDir(), "accounts.json"))
	a, err := parseAccountSnapshot([]byte(snapshot))
	if err != nil {
		t.Fatal(err)
	}
	return brokerConfig{URL: server.URL, Token: "private-broker-token"}, a, cleared
}

func accountAPITestPool(t *testing.T, accounts map[string][]account) map[string][]string {
	t.Helper()
	state, err := readAccountAPIState(os.Getenv("CODE_AUTH_ACCOUNT_STATE"))
	if err != nil {
		t.Fatal(err)
	}
	return launchAccountReport(accounts, state.CurrentDisabled(), launchIntent{}, time.Now()).pool()
}

func TestAccountsAPISelectionsControlNextLaunch(t *testing.T) {
	_, accounts, _ := accountAPITestBroker(t)
	run := func(args ...string) {
		t.Helper()
		status, out, errout := accountAPITestRun(t, runAccountsCLI, args...)
		if status != 0 {
			t.Fatalf("accounts %v: %d %s", args, status, errout)
		}
		var doc map[string]any
		if json.Unmarshal([]byte(out), &doc) != nil {
			t.Fatalf("not JSON: %q", out)
		}
		assertAccountAPISafeJSON(t, doc)
	}
	run("set", "--provider", "openai-codex", "--identity", "a@example.com", "--enabled", "false")
	if got := accountAPITestPool(t, accounts)["openai-codex"]; !reflect.DeepEqual(got, []string{"b@example.com"}) {
		t.Fatalf("disabled account entered next launch: %v", got)
	}
	run("presets", "create", "--name", "Only A", "--disabled", `[{"provider":"openai-codex","identityKey":"b@example.com"}]`)
	if got := accountAPITestPool(t, accounts)["openai-codex"]; !reflect.DeepEqual(got, []string{"a@example.com"}) {
		t.Fatalf("preset not active: %v", got)
	}
	run("presets", "activate", "--name", "Manual")
	if got := accountAPITestPool(t, accounts)["openai-codex"]; !reflect.DeepEqual(got, []string{"b@example.com"}) {
		t.Fatalf("Manual not restored: %v", got)
	}
	run("presets", "update", "--name", "only a", "--disabled", `[{"provider":"openai-codex","identityKey":"a@example.com"},{"provider":"openai-codex","identityKey":"b@example.com"}]`)
	run("presets", "activate", "--name", "Only A")
	if got, exists := accountAPITestPool(t, accounts)["openai-codex"]; !exists || len(got) != 0 {
		t.Fatalf("empty pool broadened: %v %v", got, exists)
	}
	run("presets", "delete", "--name", "  oNlY a  ")
	if got, exists := accountAPITestPool(t, accounts)["openai-codex"]; !exists || len(got) != 0 {
		t.Fatalf("deleting active preset broadened pool: %v %v", got, exists)
	}
}

func TestAccountsAPIRefusesInvalidMutationWithoutWriting(t *testing.T) {
	accountAPITestBroker(t)
	path := os.Getenv("CODE_AUTH_ACCOUNT_STATE")
	if err := writeAccountSelectionState(path, defaultAccountSelectionState()); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	for _, args := range [][]string{
		{"set", "--provider", "openai-codex", "--identity", "unknown", "--enabled", "false"},
		{"presets", "activate", "--name", "unknown"},
		{"presets", "update", "--name", "unknown", "--disabled", "[]"},
		{"presets", "delete", "--name", "unknown"},
		{"presets", "create", "--name", "bad", "--disabled", `[{"provider":"openai-codex","identityKey":"unknown"}]`},
		{"presets", "create", "--name", "bad", "--disabled", `null`},
		{"presets", "create", "--name", "bad", "--disabled", `[{"provider":"openai-codex","identityKey":"a@example.com","apiKey":"private-key"}]`},
	} {
		status, out, _ := accountAPITestRun(t, runAccountsCLI, args...)
		if status == 0 || out != "" {
			t.Fatalf("invalid mutation succeeded: %v %q", args, out)
		}
		after, _ := os.ReadFile(path)
		if string(before) != string(after) {
			t.Fatalf("invalid mutation changed state: %v", args)
		}
	}
	for _, invalid := range []string{`not JSON`, `{"active":"unknown","manual":{"disabled":[]},"presets":[]}`, `{"active":"Manual","manual":{"disabled":null},"presets":[]}`} {
		if err := os.WriteFile(path, []byte(invalid), 0o600); err != nil {
			t.Fatal(err)
		}
		status, _, _ := accountAPITestRun(t, runAccountsCLI, "set", "--provider", "openai-codex", "--identity", "a@example.com", "--enabled", "false")
		after, _ := os.ReadFile(path)
		if status == 0 || string(after) != invalid {
			t.Fatalf("corrupt state changed: %q", after)
		}
	}
}

func TestAccountsAPIBlockClearingKeepsPrivateIDLocal(t *testing.T) {
	_, _, cleared := accountAPITestBroker(t)
	status, out, errout := accountAPITestRun(t, runAccountsCLI, "clear-blocks", "--provider", "openai-codex", "--identity", "a@example.com")
	if status != 0 {
		t.Fatalf("clear: %s", errout)
	}
	select {
	case path := <-cleared:
		if path != "/v1/credential/private-broker-id/blocks" {
			t.Fatalf("wrong broker identity: %s", path)
		}
	default:
		t.Fatal("block clearing never reached broker")
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatal(err)
	}
	assertAccountAPISafeJSON(t, doc)
	if doc["cleared"] != true {
		t.Fatalf("missing result: %s", out)
	}
}

func assertAccountAPISafeJSON(t *testing.T, value any) {
	t.Helper()
	switch v := value.(type) {
	case map[string]any:
		for key, child := range v {
			switch strings.ToLower(key) {
			case "credentialid", "apikey", "token", "credential", "credentials", "blocks", "cause":
				t.Fatalf("private field exposed: %s", key)
			}
			assertAccountAPISafeJSON(t, child)
		}
	case []any:
		for _, child := range v {
			assertAccountAPISafeJSON(t, child)
		}
	case string:
		if strings.Contains(v, "private-") {
			t.Fatalf("private value exposed: %q", v)
		}
	}
}

func TestAccountsAPIConcurrentMutationsAndTUIConflict(t *testing.T) {
	_, accounts, _ := accountAPITestBroker(t)
	path := os.Getenv("CODE_AUTH_ACCOUNT_STATE")
	m := model{accountState: path, accountSelections: defaultAccountSelectionState(), avail: availability{accounts: accounts, accountsOK: true}}
	var wg sync.WaitGroup
	errors := make(chan error, 2)
	for _, a := range accounts["openai-codex"] {
		wg.Add(1)
		go func(a account) {
			defer wg.Done()
			_, err := mutateAccountAPIState(path, accounts, func(state *accountSelectionState) error { return setAccountAPIEnabled(state, a, false) })
			errors <- err
		}(a)
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	if pool, exists := accountAPITestPool(t, accounts)["openai-codex"]; !exists || len(pool) != 0 {
		t.Fatalf("concurrent update lost: %v", pool)
	}
	before, _ := os.ReadFile(path)
	if err := m.commitAccountSelections(defaultAccountSelectionState()); err == nil {
		t.Fatal("stale TUI overwrote current selection")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("TUI conflict mutated disk")
	}
	if len(m.accountSelections.CurrentDisabled()) != 0 {
		t.Fatal("failed TUI write changed in-memory selection")
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
