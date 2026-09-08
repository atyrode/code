package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestUsageAPIValidEmptyReports(t *testing.T) {
	for _, payload := range []string{`{"reports":[]}`, `{"reports":[],"futureField":{"value":true}}`} {
		t.Run(payload, func(t *testing.T) {
			server := testAccountBroker(t, payload)
			t.Setenv("OMP_AUTH_BROKER_URL", server.URL)
			t.Setenv("OMP_AUTH_BROKER_TOKEN", "secret")
			t.Setenv("CODE_AUTH_ACCOUNT_STATE", "")
			t.Setenv("CODE_USAGE_CACHE", filepath.Join(t.TempDir(), "usage.json"))
			a := loadAvailability(brokerConfig{URL: server.URL, Token: "secret"})
			if !a.ok {
				t.Fatal("valid empty reports rejected by shared usage parser")
			}
			status, stdout, stderr := accountAPITestRun(t, runUsageCLI)
			var out usageAPIResult
			if err := json.Unmarshal([]byte(stdout), &out); err != nil {
				t.Fatal(err)
			}
			if status != 0 || out.Status != "fresh" || out.UsageRefresh != "succeeded" || out.ObservedAt == 0 {
				t.Fatalf("empty reports not observed: status=%d stderr=%s result=%+v", status, stderr, out)
			}
		})
	}
}

func TestUsageAPIInvalidDocumentDoesNotObserveFreshness(t *testing.T) {
	for _, payload := range []string{
		`null`, `{}`, `{"unrelated":true}`, `[]`,
		`{"reports":null}`, `{"reports":{}}`, `{"reports":[1]}`,
	} {
		t.Run(payload, func(t *testing.T) {
			server := testAccountBroker(t, payload)
			t.Setenv("OMP_AUTH_BROKER_URL", server.URL)
			t.Setenv("OMP_AUTH_BROKER_TOKEN", "secret")
			t.Setenv("CODE_AUTH_ACCOUNT_STATE", "")
			cachePath := filepath.Join(t.TempDir(), "usage.json")
			t.Setenv("CODE_USAGE_CACHE", cachePath)
			fresh := loadAvailability(brokerConfig{URL: server.URL, Token: "secret"})
			if fresh.ok || !fresh.accountsOK {
				t.Fatalf("invalid usage accepted or valid snapshot lost: %+v", fresh)
			}
			status, stdout, stderr := accountAPITestRun(t, runUsageCLI)
			var out usageAPIResult
			if err := json.Unmarshal([]byte(stdout), &out); err != nil {
				t.Fatal(err)
			}
			if status == 0 || stderr == "" || out.Status != "failed" || out.UsageRefresh != "failed" || out.ObservedAt != 0 {
				t.Fatalf("invalid usage invented freshness: status=%d result=%+v", status, out)
			}
			for _, provider := range out.Providers {
				for _, bucket := range provider.Buckets {
					if bucket.Status != "unknown" {
						t.Fatalf("invalid usage invented bucket health: %+v", bucket)
					}
				}
			}

			observed := time.Now().Unix() - 600
			key := accountKey{Provider: "openai-codex", IdentityKey: "codex-key"}
			cached := emptyAvailability()
			cached.ok, cached.accountsOK, cached.accounts = true, true, fresh.accounts
			cached.accountUsage[key] = []usageWin{{id: "30d", prov: key.Provider, pct: 100, secs: 900, observed: observed}}
			saveUsageCache(cachePath, cached)
			before, err := os.ReadFile(cachePath)
			if err != nil {
				t.Fatal(err)
			}
			status, stdout, stderr = accountAPITestRun(t, runUsageCLI)
			if err := json.Unmarshal([]byte(stdout), &out); err != nil {
				t.Fatal(err)
			}
			if status != 0 || out.Status != "stale" || out.UsageRefresh != "failed" || out.ObservedAt != observed {
				t.Fatalf("invalid usage replaced cached observation: status=%d stderr=%s result=%+v", status, stderr, out)
			}
			found := false
			for _, provider := range out.Providers {
				for _, acct := range provider.Accounts {
					if acct.Provider == key.Provider && acct.IdentityKey == key.IdentityKey {
						found = true
						if len(acct.Windows) != 1 || acct.Windows[0].Status != "stale" || acct.Windows[0].ObservedAt != observed || acct.Windows[0].UsedPercent != 100 {
							t.Fatalf("invalid usage erased cached window: %+v", acct)
						}
					}
				}
			}
			if !found {
				t.Fatal("cached account disappeared")
			}
			after, err := os.ReadFile(cachePath)
			if err != nil {
				t.Fatal(err)
			}
			if string(before) != string(after) {
				t.Fatal("invalid usage rewrote cache")
			}
		})
	}
}

func TestUsageAPIRetainsStaleWindowsWithoutFalseObservation(t *testing.T) {
	_, accounts, _ := accountAPITestBroker(t)
	now := time.Unix(2000000000, 0)
	key := accountKey{Provider: "openai-codex", IdentityKey: "a@example.com"}
	cache := emptyAvailability()
	cache.ok, cache.accountsOK, cache.accountsStale = true, true, true
	cache.accounts = accounts
	cache.accountUsage[key] = []usageWin{{id: "30d", label: "Monthly", prov: key.Provider, tier: "spark", pct: 42, secs: 3600, dur: 2592000, observed: now.Unix() - 600, stale: true}}
	cache.deepseek = &deepseekBalance{ok: true, currency: "USD", total: "12.50", fetchedAt: now.Unix() - 500, stale: true}
	ageUsageAPICache(&cache, 20)
	merged, stale := reconcileUsage(cache, emptyAvailability())
	out := projectUsageAPI(merged, false, false, stale, defaultAccountSelectionState(), now.Add(-20*time.Second), now)
	if out.Status != "stale" || out.UsageRefresh != "failed" || out.AccountRefresh != "failed" || out.ObservedAt != now.Unix()-600 {
		t.Fatalf("cache disguised as fresh: %+v", out)
	}
	var row usageAPIAccount
	for _, p := range out.Providers {
		for _, a := range p.Accounts {
			if a.IdentityKey == key.IdentityKey {
				row = a
			}
		}
	}
	if row.SnapshotStatus != "stale" || len(row.Windows) != 1 {
		t.Fatalf("lost cached account: %+v", row)
	}
	w := row.Windows[0]
	if w.Status != "stale" || w.ObservedAt != now.Unix()-600 || w.ResetsAt != now.Unix()+3580 || w.Tier != "spark" {
		t.Fatalf("cache observation/reset changed: %+v", w)
	}
	if len(out.Balances) != 1 || out.Balances[0].Status != "stale" || out.Balances[0].ObservedAt != now.Unix()-500 {
		t.Fatalf("balance not stale: %+v", out.Balances)
	}
}

func TestUsageAPIPartialOmissionAndFaultProjection(t *testing.T) {
	_, accounts, _ := accountAPITestBroker(t)
	now := time.Now()
	key := accountKey{Provider: "openai-codex", IdentityKey: "a@example.com"}
	prev := emptyAvailability()
	prev.ok, prev.accountsOK, prev.accounts = true, true, accounts
	prev.accountUsage[key] = []usageWin{{id: "30d", prov: key.Provider, pct: 25, secs: 100, observed: now.Unix() - 300, stale: true}}
	next := emptyAvailability()
	next.ok, next.accountsOK, next.accounts = true, true, accounts
	next.faults[key] = credFault{cause: "private-provider-error-body apiKey=private-key", at: now.UnixMilli()}
	merged, stale := reconcileUsage(prev, next)
	out := projectUsageAPI(merged, true, true, stale, defaultAccountSelectionState(), now, now)
	if out.Status != "partial" || out.UsageRefresh != "succeeded" {
		t.Fatalf("omission not partial: %+v", out)
	}
	found := false
	for _, p := range out.Providers {
		for _, a := range p.Accounts {
			if a.IdentityKey == key.IdentityKey {
				found = true
				if a.Status != "credential_disabled" || a.FaultAt != now.Unix() || a.Windows[0].Status != "stale" {
					t.Fatalf("fault/omission lost: %+v", a)
				}
			}
		}
	}
	if !found {
		t.Fatal("faulted account missing")
	}
	body, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	var doc any
	if err := json.Unmarshal(body, &doc); err != nil {
		t.Fatal(err)
	}
	assertAccountAPISafeJSON(t, doc)
}

func TestUsageAPIOneShotCacheFallbackAndTotalFailure(t *testing.T) {
	_, accounts, _ := accountAPITestBroker(t)
	cachePath := filepath.Join(t.TempDir(), "usage.json")
	t.Setenv("CODE_USAGE_CACHE", cachePath)
	now := time.Now().Unix()
	key := accountKey{Provider: "openai-codex", IdentityKey: "a@example.com"}
	a := emptyAvailability()
	a.ok, a.accountsOK, a.accounts = true, true, accounts
	a.accountUsage[key] = []usageWin{{id: "30d", prov: key.Provider, pct: 22, secs: 900, observed: now - 200}}
	saveUsageCache(cachePath, a)
	before, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	status, stdout, stderr := accountAPITestRun(t, runUsageCLI)
	if status != 0 {
		t.Fatalf("usage failed: %s", stderr)
	}
	var out usageAPIResult
	if err := json.Unmarshal([]byte(stdout), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "stale" || out.UsageRefresh != "failed" || out.AccountRefresh != "succeeded" || out.ObservedAt != now-200 {
		t.Fatalf("wrong one-shot fallback: %+v", out)
	}
	after, _ := os.ReadFile(cachePath)
	if string(before) != string(after) {
		t.Fatal("failed refresh rewrote cache observation")
	}
	if err := os.Remove(cachePath); err != nil {
		t.Fatal(err)
	}
	status, stdout, stderr = accountAPITestRun(t, runUsageCLI)
	if status == 0 || stderr == "" {
		t.Fatal("total usage failure did not signal an error")
	}
	if err := json.Unmarshal([]byte(stdout), &out); err != nil {
		t.Fatal(err)
	}
	if out.Status != "failed" || out.ObservedAt != 0 {
		t.Fatalf("missing usage invented freshness: %+v", out)
	}
}

func TestUsageAPICacheRoundTripPreservesOmittedWindowDeadline(t *testing.T) {
	_, accounts, _ := accountAPITestBroker(t)
	now := time.Now()
	key := accountKey{Provider: "openai-codex", IdentityKey: "a@example.com"}
	a := emptyAvailability()
	a.ok, a.accountsOK, a.accounts = true, true, accounts
	a.accountUsage[key] = []usageWin{{id: "30d", prov: key.Provider, pct: 80, secs: 900, observed: now.Unix() - 600, stale: true}}
	path := filepath.Join(t.TempDir(), "cache.json")
	saveUsageAPICache(path, a, now)
	beforeLoad := time.Now().Unix()
	restored := loadUsageCache(path)
	afterLoad := time.Now().Unix()
	rows := restored.accountUsage[key]
	if len(rows) != 1 {
		t.Fatalf("omitted window lost: %+v", rows)
	}
	deadline := now.Unix() + 900
	if rows[0].secs < deadline-afterLoad || rows[0].secs > deadline-beforeLoad || rows[0].observed != now.Unix()-600 || !rows[0].stale {
		t.Fatalf("cached omission moved deadline or observation: %+v deadline=%d", rows[0], deadline)
	}
}

func TestUsageAPIPortableChoicesControlAccountsWithoutPersistence(t *testing.T) {
	server := testAccountBroker(t, `{"reports":[]}`)
	t.Setenv("OMP_AUTH_BROKER_URL", server.URL)
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "fixture")
	path := filepath.Join(t.TempDir(), "accounts.json")
	cache := filepath.Join(t.TempDir(), "usage.json")
	t.Setenv("CODE_USAGE_CACHE", cache)
	const original = "invalid standalone settings"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	state := `{"schemaVersion":1,"activePreset":"Focus","manualDisabled":[],"presets":[{"name":"Focus","disabled":[{"provider":"openai-codex","identityKey":"codex-key"}]}]}`
	for _, statePath := range []string{path, filepath.Join(t.TempDir(), "missing", "state"), ""} {
		t.Setenv("CODE_AUTH_ACCOUNT_STATE", statePath)
		status, body, errout := accountAPITestRun(t, runUsageCLI, "--state", state)
		var result usageAPIResult
		if status != 0 || json.Unmarshal([]byte(body), &result) != nil {
			t.Fatalf("portable usage failed: %s", errout)
		}
		enabled := map[string]bool{}
		for _, provider := range result.Providers {
			for _, row := range provider.Accounts {
				enabled[row.IdentityKey] = row.Enabled
			}
		}
		disabled, found := enabled["codex-key"]
		if result.ActivePreset != "Focus" || !found || disabled || !enabled["unmatched-key"] {
			t.Fatalf("usage ignored portable account choices: %s", body)
		}
		requireNoPath(t, cache)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != original {
		t.Fatal("portable usage overwrote standalone settings")
	}
	for _, malformed := range []string{"null", portableAccountTestState + "{}", `{"schemaVersion":1}`} {
		status, body, _ := accountAPITestRun(t, runUsageCLI, "--state", malformed)
		if status == 0 || body != "" {
			t.Fatal("malformed portable usage choices returned an observation")
		}
	}
}

func TestUsageAPIPortableBrokerFailureNeverBorrowsStandaloneCache(t *testing.T) {
	_, accounts, _ := accountAPITestBroker(t)
	server := testAccountBroker(t, `{"reports":[]}`)
	server.Close()
	t.Setenv("OMP_AUTH_BROKER_URL", server.URL)
	cachePath := filepath.Join(t.TempDir(), "usage.json")
	t.Setenv("CODE_USAGE_CACHE", cachePath)
	now := time.Now().Unix()
	cached := emptyAvailability()
	cached.ok, cached.accountsOK, cached.accounts = true, true, accounts
	cached.accountUsage[accountKey{Provider: "openai-codex", IdentityKey: "a@example.com"}] = []usageWin{{id: "30d", prov: "openai-codex", pct: 22, secs: 900, observed: now - 200}}
	cached.deepseek = &deepseekBalance{ok: true, currency: "USD", total: "12.50", fetchedAt: now - 200}
	saveUsageCache(cachePath, cached)
	before, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	status, body, errout := accountAPITestRun(t, runUsageCLI)
	var standalone usageAPIResult
	if status != 0 || json.Unmarshal([]byte(body), &standalone) != nil || standalone.Status != "stale" || standalone.ObservedAt != now-200 {
		t.Fatalf("standalone cache recovery changed: %s %s", body, errout)
	}
	status, body, _ = accountAPITestRun(t, runUsageCLI, "--state", portableAccountTestState)
	var portable usageAPIResult
	if status == 0 || json.Unmarshal([]byte(body), &portable) != nil || portable.Status != "failed" || portable.ObservedAt != 0 {
		t.Fatalf("portable failure published cached observation: %s", body)
	}
	if len(portable.Balances) != 0 {
		t.Fatalf("standalone balance escaped into portable observation: %s", body)
	}
	for _, provider := range portable.Providers {
		if len(provider.Accounts) != 0 {
			t.Fatalf("standalone identities/windows escaped into portable observation: %s", body)
		}
	}
	after, err := os.ReadFile(cachePath)
	if err != nil || string(after) != string(before) {
		t.Fatal("portable failure changed standalone usage cache")
	}
}
