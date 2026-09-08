package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"io"
	"strings"
	"testing"
)

func TestRejectsAmbiguousOrInjectedPayloads(t *testing.T) {
	cases := []struct { operation, payload string }{
		{"inspect", `{`},
		{"inspect", `{}` + `{}`},
		{"inspect", `{} trailing`},
		{"inspect", `null`},
		{"inspect", `[]`},
		{"inspect", `{"selection":null}`},
		{"inspect", `{"selection":{"lane":null}}`},
		{"inspect", `{"selection":{"lane":"a","lane":"b"}}`},
		{"inspect", `{"Selection":{}}`},
		{"inspect", `{"selection":{},"selection":{}}`},
		{"inspect", `{"executable":"/bin/sh"}`},
		{"inspect", `{"env":{"CODE_OMP":"/tmp/tool"}}`},
		{"usage", `{"argv":["accounts","login"]}`},
		{"accounts-list", `{"cwd":"/tmp"}`},
		{"account-set", `{"provider":"p","identity":"i"}`},
		{"account-set", `{"provider":"p","identity":"i","enabled":null}`},
		{"account-set", `{"provider":"p","identity":"i","enabled":"false"}`},
		{"preset-create", `{"name":"n","disabled":[{"provider":"p","identityKey":"i","apiKey":"secret"}]}`},
		{"preset-create", `{"name":"n","disabled":null}`},
		{"suggest", `{"prompt":" "}`},
		{"suggest", `{"prompt":"\u0000"}`},
		{"/bin/sh", `{}`},
		{"accounts-login", `{}`},
	}
	for _, tc := range cases {
		t.Run(tc.operation+"/"+tc.payload, func(t *testing.T) {
			if args, err := operationArgs(tc.operation, tc.payload); err == nil || args != nil {
				t.Fatalf("unsafe request accepted: %v", args)
			}
		})
	}
}

func TestPayloadByteLimit(t *testing.T) {
	// Leading JSON whitespace counts toward the same byte limit as values.
	atLimit := strings.Repeat(" ", maxInput-2)+`{}`
	if _, err := operationArgs("inspect", atLimit); err != nil {
		t.Fatal("exactly bounded JSON rejected")
	}
	if args, err := operationArgs("inspect", " "+atLimit); err == nil || args != nil {
		t.Fatal("oversized input accepted")
	}
}

func TestFlagLikeDataRemainsOneValue(t *testing.T) {
	const hostile = "--help --provider=other; $(touch /tmp/not-executed)\n"
	payload, err := json.Marshal(map[string]any{"provider":"p", "identity":hostile, "enabled":false})
	if err != nil { t.Fatal(err) }
	args, err := operationArgs("account-set", string(payload))
	if err != nil { t.Fatal(err) }
	// Parse as Code does: a value containing flags must not become another flag.
	var identity, provider, enabled string
	fs := flag.NewFlagSet("accounts", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&identity, "identity", "", "")
	fs.StringVar(&provider, "provider", "", "")
	fs.StringVar(&enabled, "enabled", "", "")
	if err := fs.Parse(args[2:]); err != nil { t.Fatal(err) }
	if identity != hostile || provider != "p" || enabled != "false" || fs.NArg() != 0 {
		t.Fatalf("caller data escaped its value: %q %q %q", identity, provider, enabled)
	}
}

func TestOutputLimitAppliesToCopyAndCannotRecover(t *testing.T) {
	var output boundedOutput
	if _, err := io.Copy(&output, io.LimitReader(strings.NewReader(strings.Repeat("x", maxOutput+1)), maxOutput+1)); err == nil {
		t.Fatal("oversized child stream accepted")
	}
	if output.buffer.Len() > maxOutput { t.Fatal("retained unbounded output") }
	if _, err := output.Write([]byte("{}")); err == nil { t.Fatal("overflow recovered into success") }
	var exact boundedOutput
	if n, err := io.Copy(&exact, strings.NewReader(strings.Repeat("x", maxOutput))); err != nil || n != maxOutput {
		t.Fatalf("exact output limit rejected: %d %v", n, err)
	}
}

const inspectFixture = `{"schema_version":1,"observed_at":"2026-09-08T10:00:00Z","observation":"one_shot","catalog":{"state":"missing","path":"PRIVATE","models_path":"PRIVATE","init_argv":["PRIVATE"]},"selection":{},"facets":[],"routing":[],"estimates":null,"providers":[{"id":"p","credential_state":"unknown","apiKey":"PRIVATE"}],"launch_modes":[],"runtime_targets":[],"sessions":[{"cwd":"PRIVATE"}],"saved_sessions":[{"path":"PRIVATE"}],"worktrees":[{"path":"PRIVATE"}],"session_registry":"PRIVATE","error":"PRIVATE","Schema_Version":99}`

const usageFixture = `{"schemaVersion":1,"requestedAt":200,"observedAt":100,"status":"stale","usageRefresh":"failed","accountRefresh":"failed","activePreset":"Manual","providers":[{"provider":"p","status":"stale","buckets":[{"name":"pool","status":"unknown"}],"accounts":[{"provider":"p","identityKey":"public-key","email":"public@example.com","selectable":true,"enabled":false,"blocked":true,"blockedUntil":300,"restrictions":[{"scope":"usage","until":300,"reason":"PRIVATE"}],"status":"selection_disabled","snapshotStatus":"stale","faultAt":90,"windows":[{"windowId":"day","label":"Daily","usedPercent":20,"resetsAt":400,"durationSeconds":86400,"observedAt":100,"status":"stale","raw":"PRIVATE"}],"credentialID":"PRIVATE","apiKey":"PRIVATE","blocks":[{"token":"PRIVATE"}],"error":"PRIVATE"}]}],"balances":[{"provider":"p","status":"stale","currency":"USD","totalBalance":"3.25","observedAt":100}],"token":"PRIVATE"}`

func TestProjectsPrivateFieldsWithoutChangingFreshness(t *testing.T) {
	for operation, fixture := range map[string]string{"inspect":inspectFixture, "usage":usageFixture} {
		t.Run(operation, func(t *testing.T) {
			result, err := projectResult(operation, []byte(fixture))
			if err != nil { t.Fatal(err) }
			if bytes.Contains(result, []byte("PRIVATE")) { t.Fatalf("private data escaped: %s", result) }
			if operation == "usage" {
				var p usageResult
				if err := json.Unmarshal(result, &p); err != nil { t.Fatal(err) }
				a := p.Providers[0].Accounts[0]
				if p.Status != "stale" || p.ObservedAt != 100 || p.RequestedAt != 200 || p.UsageRefresh != "failed" || p.AccountRefresh != "failed" || a.SnapshotStatus != "stale" || a.Windows[0].ObservedAt != 100 || a.Windows[0].Status != "stale" {
					t.Fatalf("freshness rewritten: %s", result)
				}
				if a.IdentityKey != "public-key" || a.Email != "public@example.com" || a.Enabled || !a.Blocked || a.BlockedUntil != 300 || a.Restrictions[0].Until != 300 {
					t.Fatalf("public account controls lost: %s", result)
				}
			}
		})
	}
}

func TestInvalidChildDocumentNeverReturnsPartialResult(t *testing.T) {
	cases := []string{
		inspectFixture[:len(inspectFixture)-1],
		inspectFixture+`{}`,
		inspectFixture+`garbage`,
		strings.Replace(inspectFixture, `"schema_version":1`, `"schema_version":2`, 1),
		strings.Replace(inspectFixture, `"schema_version":1`, `"schema_version":1,"schema_version":1`, 1),
		strings.Replace(inspectFixture, `"observation":"one_shot",`, ``, 1),
		strings.Replace(inspectFixture, `"facets":[]`, `"facets":null`, 1),
		strings.Replace(inspectFixture, `"estimates":null`, `"estimates":{"cost":1}`, 1),
		strings.Replace(inspectFixture, `"observed_at":"2026-09-08T10:00:00Z"`, `"observed_at":"not a timestamp"`, 1),
		strings.Replace(inspectFixture, `"runtime_targets":[]`, `"runtime_targets":[{"name":"r"}]`, 1),
		strings.Replace(inspectFixture, `"estimates":null`, `"estimates":{"cost":9223372036854775808,"speed":1,"scale_min":1,"scale_max":5}`, 1),
		strings.Repeat(" ", maxOutput)+inspectFixture,
	}
	for index, input := range cases {
		if result, err := projectResult("inspect", []byte(input)); err == nil || result != nil {
			t.Fatalf("invalid document %d returned public output: %s", index, result)
		}
	}
}

func TestUnselectableAccountAndFalseFlagsRemainObservable(t *testing.T) {
	input := `{"schemaVersion":1,"operation":"list","observedAt":100,"activePreset":"Manual","accounts":[{"provider":"p","identityKey":"","selectable":false,"enabled":false,"blocked":false,"restrictions":[],"apiKey":"PRIVATE"}],"presets":[],"manualDisabled":[]}`
	result, err := projectResult("accounts-list", []byte(input))
	if err != nil { t.Fatal(err) }
	if bytes.Contains(result, []byte("PRIVATE")) || !bytes.Contains(result, []byte(`"identityKey":""`)) || !bytes.Contains(result, []byte(`"enabled":false`)) {
		t.Fatalf("unselectable account misrepresented: %s", result)
	}
	missing := strings.Replace(input, `"enabled":false,`, ``, 1)
	if result, err := projectResult("accounts-list", []byte(missing)); err == nil || result != nil { t.Fatal("missing enabled treated as disabled") }
	if result, err := projectResult("preset-delete", []byte(input)); err == nil || result != nil { t.Fatal("wrong operation accepted") }
}

func TestSuggestionActionsMustMatchSelection(t *testing.T) {
	input := `{"schema_version":1,"observed_at":"2026-09-08T10:00:00Z","observation":"one_shot","evaluator":"local-model","actions":[{"key":"lane","value":"fast","raw":"PRIVATE"}],"selection":{"lane":"fast"},"prompt":"PRIVATE","output":"PRIVATE"}`
	result, err := projectResult("suggest", []byte(input))
	if err != nil { t.Fatal(err) }
	if bytes.Contains(result, []byte("PRIVATE")) { t.Fatalf("private evaluator material escaped: %s", result) }
	for _, broken := range []string{
		strings.Replace(input, `"selection":{"lane":"fast"}`, `"selection":{"lane":"slow"}`, 1),
		strings.Replace(input, `"actions":[`, `"actions":[{"key":"lane","value":"fast"},`, 1),
	} {
		if result, err := projectResult("suggest", []byte(broken)); err == nil || result != nil { t.Fatal("inconsistent suggestion accepted") }
	}
}
