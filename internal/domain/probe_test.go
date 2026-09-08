package domain

import "testing"

func TestRunBenchClassifiesOutcomes(t *testing.T) {
	var raw []byte
	stub := func(row string) {
		raw = []byte(`{"models":[` + row + `]}`)
	}

	// Reachable: verbatim claude-haiku-4-5 stats from a live probe. speed must
	// read generationTps (62.0), NOT tokensPerSecond (5.1) — the latter folds
	// the startup wait into the same figure, and effTPS already composes ttft
	// with the streaming rate itself, so trusting it would charge for
	// time-to-first-token twice and rank a fast model as the slowest in the
	// catalog.
	stub(`{"model":"anthropic/claude-haiku-4-5","results":[{"ok":true}],"stats":{"ttftMs":{"mean":716.7357240000001,"min":716.7,"p50":716.7,"p95":716.7,"max":716.7},"tokensPerSecond":{"mean":5.120137111537292},"generationTps":{"mean":62.02189357337661}}}`)
	facts, err := parseBenchFacts(raw)
	if err != nil {
		t.Fatalf("reachable: runBench: %v", err)
	}
	if f := facts["claude-haiku-4-5"]; !f.reachable || f.notFound || f.blocked || f.speed != 62.0 || f.ttft != 0.72 {
		t.Errorf("clean row should be reachable with generationTps/ttft, got %+v", f)
	}

	// Not found: the provider disowns the model — a settled negative that may
	// drop it silently.
	stub(`{"model":"anthropic/claude-ghost-9","results":[{"ok":false,"error":"404 {\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"model: claude-ghost-9\"}}"}],"stats":null}`)
	facts, err = parseBenchFacts(raw)
	if err != nil {
		t.Fatalf("notFound: runBench: %v", err)
	}
	if f := facts["claude-ghost-9"]; !f.notFound || f.reachable || f.blocked {
		t.Errorf("a 404 row should be notFound, got %+v", f)
	}

	// Blocked: claude-fable-5-1 is listed AND entitled on this account, and
	// still uncallable because omp advertises Claude Code 2.1.246 while
	// Anthropic wants 2.1.251 for it. Definitive like a 404, but fixable by the
	// operator, so it drops with a warning instead of poisoning the run.
	stub(`{"model":"anthropic/claude-fable-5-1","results":[{"ok":false,"error":"400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Claude Code 2.1.246 does not support this model; version 2.1.251 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.\",\"details\":{\"error_code\":\"claude_code_version_too_old\"}}}"}],"stats":null}`)
	facts, err = parseBenchFacts(raw)
	if err != nil {
		t.Fatalf("blocked: runBench: %v", err)
	}
	if f := facts["claude-fable-5-1"]; !f.blocked || f.reachable || f.notFound {
		t.Errorf("a client-version gate should be blocked, got %+v", f)
	}

	// Unresolved: a refusal, an exhausted quota or an incomplete row says
	// nothing either way about entitlement, so it is none of the three settled
	// outcomes. The usage-limit row is verbatim from a live run against an
	// exhausted Codex account, and "legacy average only" is the omp 17 shape —
	// pinned as unresolved so a silent schema regression can never again read as
	// a clean probe.
	for _, tc := range []struct{ name, row string }{
		{"refusal", `{"model":"anthropic/x","results":[{"ok":false,"error":"Refusal (cyber): This request triggered restrictions"}],"stats":null}`},
		{"usage limit", `{"model":"openai-codex/x","results":[{"ok":false,"error":"Codex error event: The usage limit has been reached (code=usage_limit_reached)"}],"stats":null}`},
		{"failed run", `{"model":"anthropic/x","results":[{"ok":true},{"ok":false,"error":"stream closed"}],"stats":{"ttftMs":{"mean":1000},"generationTps":{"mean":40}}}`},
		{"no results", `{"model":"anthropic/x","results":[],"stats":{"ttftMs":{"mean":1000},"generationTps":{"mean":40}}}`},
		{"null stats", `{"model":"anthropic/x","results":[{"ok":true}],"stats":null}`},
		{"legacy average only", `{"model":"anthropic/x","results":[{"ok":true}],"failures":0,"average":{"ttftMs":1404.2,"tokensPerSecond":48.94}}`},
	} {
		stub(tc.row)
		facts, err := parseBenchFacts(raw)
		if err != nil {
			t.Fatalf("%s: runBench: %v", tc.name, err)
		}
		if f := facts["x"]; f.reachable || f.notFound || f.blocked {
			t.Errorf("%s: must be unresolved, got %+v", tc.name, f)
		}
	}
}
