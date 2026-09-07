package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	clikit "github.com/atyrode/cli-kit"
)

func TestSuggestLoopbackProposalDoesNotPersistOrLaunch(t *testing.T) {
	isolateHistoryTest(t)
	selectionPath := filepath.Join(t.TempDir(), "selection.json")
	original := []byte(`{"model":"normal"}`)
	if err := os.WriteFile(selectionPath, original, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_SELECTION_STATE", selectionPath)
	marker := filepath.Join(t.TempDir(), "launched")
	launcher := filepath.Join(t.TempDir(), "omp")
	if err := os.WriteFile(launcher, []byte("#!/bin/sh\nprintf launched > '"+marker+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_OMP", launcher)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/chat" {
			t.Errorf("unexpected evaluator operation %s %s", r.Method, r.URL.Path)
		}
		var request struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
			KeepAlive int `json:"keep_alive"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		if request.KeepAlive != 0 {
			t.Error("proposal pinned the model resident")
		}
		if len(request.Messages) != 2 || !strings.Contains(request.Messages[1].Content, "critical refactor") {
			t.Error("missing task classification request")
		}
		json.NewEncoder(w).Encode(map[string]any{"message": map[string]string{"content": `{"model":"smart","thinking":"high","advisor":"audit"}`}, "done": false})
		json.NewEncoder(w).Encode(map[string]any{"done": true})
	}))
	defer server.Close()
	t.Setenv("CODE_OLLAMA_ENDPOINT", server.URL)
	m := inspectFixtureModel(t, "testdata/two-pool-golden.plain")
	before := selectionChoices(m.sel, m.facets)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second*5)
	defer cancel()
	result, err := proposeHeadlessSelection(ctx, m, "critical refactor")
	if err != nil {
		t.Fatal(err)
	}
	if result.Selection["model"] != "smart" || result.Selection["thinking"] != "high" || result.Selection["advisor"] != "audit" || result.Selection["fast"] != "off" {
		t.Fatalf("unexpected proposal: %#v", result)
	}
	applied := make(map[string]string, len(before))
	for key, value := range before {
		applied[key] = value
	}
	for _, action := range result.Actions {
		applied[action.Key] = action.Value
	}
	if !reflect.DeepEqual(applied, result.Selection) {
		t.Fatal("actions do not describe the complete proposed selection")
	}
	launched, err := selectHeadlessModel(m, result.Selection)
	if err != nil || !reflect.DeepEqual(selectionChoices(launched.sel, launched.facets), result.Selection) {
		t.Fatalf("proposal cannot roundtrip through launch: %v", err)
	}
	if !reflect.DeepEqual(before, selectionChoices(m.sel, m.facets)) {
		t.Fatal("proposal mutated caller selection")
	}
	stored, err := os.ReadFile(selectionPath)
	if err != nil || !reflect.DeepEqual(stored, original) {
		t.Fatal("proposal persisted dial state")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("proposal launched omp")
	}
}

func TestSuggestRefusesInvalidProviderProposal(t *testing.T) {
	m := inspectFixtureModel(t, "testdata/two-pool-golden.plain")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"message": map[string]string{"content": `{"model":"smart","lane":"invented-provider-only"}`}, "done": true})
	}))
	defer server.Close()
	t.Setenv("CODE_OLLAMA_ENDPOINT", server.URL)
	if _, err := proposeHeadlessSelection(context.Background(), m, "refactor"); err == nil {
		t.Fatal("silently dropped an invalid provider suggestion")
	}
	m.applyProviderAvailability(map[string]bool{"A": true})
	if _, err := applyHeadlessSuggestion(m, []clikit.Action{{Key: "lane", Value: "gpt-only"}}); err == nil {
		t.Fatal("accepted an unavailable provider suggestion")
	}
}

func TestSuggestNeverForwardsEvaluatorErrors(t *testing.T) {
	const secret = "private-evaluator-error-canary"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"error": secret, "done": true})
	}))
	defer server.Close()
	t.Setenv("CODE_OLLAMA_ENDPOINT", server.URL)
	m := inspectFixtureModel(t, "testdata/two-pool-golden.plain")
	result, err := proposeHeadlessSelection(context.Background(), m, "refactor")
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("unsafe evaluator error: %v, %#v", err, result)
	}
}

func TestSuggestRejectsNonLoopbackAndRedirects(t *testing.T) {
	for _, endpoint := range []string{"http://example.com", "http://192.168.1.2", "https://127.0.0.1", "http://user:secret@127.0.0.1", "http://127.0.0.1?token=secret"} {
		if _, err := suggestionLoopbackEndpoint(endpoint); err == nil {
			t.Fatalf("accepted non-local or credential URL %q", endpoint)
		}
	}
	reached := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	t.Setenv("CODE_OLLAMA_ENDPOINT", redirect.URL)
	m := inspectFixtureModel(t, "testdata/two-pool-golden.plain")
	if _, err := proposeHeadlessSelection(context.Background(), m, "private task"); err == nil {
		t.Fatal("redirect was accepted")
	}
	if reached {
		t.Fatal("private prompt followed redirect")
	}
}

func TestSuggestRequiresSuccessfulStreamCompletion(t *testing.T) {
	const secret = "private-evaluator-error-canary"
	const proposal = "{\"message\":{\"content\":\"{\\\"model\\\":\\\"smart\\\"}\"},\"done\":false}\n"
	for _, tc := range []struct {
		name   string
		ending string
	}{
		{"truncated after proposal", ""},
		{"upstream error after proposal", `{"error":"` + secret + `","done":true}`},
		{"malformed final frame", `{"done":`},
		{"invalid terminal message", `{"message":42,"done":true}`},
		{"oversized after proposal", strings.Repeat(" ", 64<<10) + `{"done":true}`},
		{"error after completion", "{\"done\":true}\n" + `{"error":"` + secret + `"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(proposal + tc.ending))
			}))
			defer server.Close()
			t.Setenv("CODE_OLLAMA_ENDPOINT", server.URL)
			m := inspectFixtureModel(t, "testdata/two-pool-golden.plain")
			before := selectionChoices(m.sel, m.facets)
			result, err := proposeHeadlessSelection(context.Background(), m, "refactor")
			if err == nil || strings.Contains(err.Error(), secret) {
				t.Fatalf("accepted incomplete/unsafe evaluator response: %v, %#v", err, result)
			}
			if result.Selection != nil || len(result.Actions) != 0 {
				t.Fatalf("failed evaluation returned a recommendation: %#v", result)
			}
			if !reflect.DeepEqual(before, selectionChoices(m.sel, m.facets)) {
				t.Fatal("failed evaluation changed caller selection")
			}
		})
	}
}

func TestSuggestDeepSeekOnlyRoundtripsLaunch(t *testing.T) {
	cat, err := catalogFrom(t, fixtureYMLDeepSeek)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "catalog.plain")
	if err := os.WriteFile(path, []byte(cat.renderCatalog()), 0600); err != nil {
		t.Fatal(err)
	}
	m := inspectFixtureModel(t, path)
	m.applyProviderAvailability(map[string]bool{"D": true})
	m, err = selectHeadlessModel(m, map[string]string{"lane": "ds-only", "model": "smart", "spark": "off", "fast": "off"})
	if err != nil {
		t.Fatal(err)
	}
	before := selectionChoices(m.sel, m.facets)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"message": map[string]string{"content": `{"model":"fast","thinking":"minimal","advisor":"off"}`}, "done": true})
	}))
	defer server.Close()
	t.Setenv("CODE_OLLAMA_ENDPOINT", server.URL)
	result, err := proposeHeadlessSelection(context.Background(), m, "fix a typo")
	if err != nil {
		t.Fatal(err)
	}
	if result.Selection["lane"] != "ds-only" || result.Selection["model"] != "fast" || result.Selection["fast"] != "off" {
		t.Fatalf("inapplicable priority switch escaped sizing: %#v", result)
	}
	for _, action := range result.Actions {
		before[action.Key] = action.Value
	}
	if !reflect.DeepEqual(before, result.Selection) {
		t.Fatal("actions differ from the returned selection")
	}
	launched, err := selectHeadlessModel(m, result.Selection)
	if err != nil || !reflect.DeepEqual(selectionChoices(launched.sel, launched.facets), result.Selection) {
		t.Fatalf("DeepSeek-only proposal cannot roundtrip through launch: %v", err)
	}
	if _, err := applyHeadlessSuggestion(m, []clikit.Action{{Key: "fast", Value: "on"}}); err == nil {
		t.Fatal("silently repaired an explicitly unavailable priority switch")
	}
}

func TestSuggestSizingPreservesExplicitEvaluatorSwitch(t *testing.T) {
	m := inspectFixtureModel(t, "testdata/two-pool-golden.plain")
	for _, tc := range []struct {
		model string
		fast  string
	}{
		{"fast", "off"},
		{"smart", "on"},
	} {
		proposed, err := applyHeadlessSuggestion(m, []clikit.Action{{Key: "model", Value: tc.model}, {Key: "fast", Value: tc.fast}})
		if err != nil {
			t.Fatal(err)
		}
		if proposed.sel["model"] != tc.model || proposed.sel["fast"] != tc.fast {
			t.Fatalf("derived sizing overwrote explicit proposal: %#v", proposed.sel)
		}
	}
}
