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
			if args, _, err := operationArgs(tc.operation, tc.payload); err == nil || args != nil {
				t.Fatalf("unsafe request accepted: %v", args)
			}
		})
	}
}

func TestPayloadByteLimit(t *testing.T) {
	// Leading JSON whitespace counts toward the same byte limit as values.
	atLimit := strings.Repeat(" ", maxInput-2)+`{}`
	if _, _, err := operationArgs("inspect", atLimit); err != nil {
		t.Fatal("exactly bounded JSON rejected")
	}
	if args, _, err := operationArgs("inspect", " "+atLimit); err == nil || args != nil {
		t.Fatal("oversized input accepted")
	}
}

func TestFlagLikeDataRemainsOneValue(t *testing.T) {
	const hostile = "--help --provider=other; $(touch /tmp/not-executed)\n"
	payload, err := json.Marshal(map[string]any{"provider":"p", "identity":hostile, "enabled":false, "state":json.RawMessage(workerAccountState), "baseRevision":0})
	if err != nil { t.Fatal(err) }
	args, _, err := operationArgs("account-set", string(payload))
	if err != nil { t.Fatal(err) }
	// Parse as Code does: a value containing flags must not become another flag.
	var identity, provider, enabled string
	fs := flag.NewFlagSet("accounts", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.StringVar(&identity, "identity", "", "")
	fs.StringVar(&provider, "provider", "", "")
	fs.StringVar(&enabled, "enabled", "", "")
	fs.String("state", "", "")
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
			result, err := projectResult(operation, []byte(fixture), nil)
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
		if result, err := projectResult("inspect", []byte(input), nil); err == nil || result != nil {
			t.Fatalf("invalid document %d returned public output: %s", index, result)
		}
	}
}

func TestUnselectableAccountAndFalseFlagsRemainObservable(t *testing.T) {
	input := `{"schemaVersion":1,"operation":"list","observedAt":100,"activePreset":"Manual","accounts":[{"provider":"p","identityKey":"","selectable":false,"enabled":false,"blocked":false,"restrictions":[],"apiKey":"PRIVATE"}],"presets":[],"manualDisabled":[]}`
	result, err := projectResult("accounts-list", []byte(input), nil)
	if err != nil { t.Fatal(err) }
	if bytes.Contains(result, []byte("PRIVATE")) || !bytes.Contains(result, []byte(`"identityKey":""`)) || !bytes.Contains(result, []byte(`"enabled":false`)) {
		t.Fatalf("unselectable account misrepresented: %s", result)
	}
	missing := strings.Replace(input, `"enabled":false,`, ``, 1)
	if result, err := projectResult("accounts-list", []byte(missing), nil); err == nil || result != nil { t.Fatal("missing enabled treated as disabled") }
	if result, err := projectResult("preset-delete", []byte(input), nil); err == nil || result != nil { t.Fatal("wrong operation accepted") }
}

func TestSuggestionActionsMustMatchSelection(t *testing.T) {
	input := `{"schema_version":1,"observed_at":"2026-09-08T10:00:00Z","observation":"one_shot","evaluator":"local-model","actions":[{"key":"lane","value":"fast","raw":"PRIVATE"}],"selection":{"lane":"fast"},"prompt":"PRIVATE","output":"PRIVATE"}`
	result, err := projectResult("suggest", []byte(input), nil)
	if err != nil { t.Fatal(err) }
	if bytes.Contains(result, []byte("PRIVATE")) { t.Fatalf("private evaluator material escaped: %s", result) }
	for _, broken := range []string{
		strings.Replace(input, `"selection":{"lane":"fast"}`, `"selection":{"lane":"slow"}`, 1),
		strings.Replace(input, `"actions":[`, `"actions":[{"key":"lane","value":"fast"},`, 1),
	} {
		if result, err := projectResult("suggest", []byte(broken), nil); err == nil || result != nil { t.Fatal("inconsistent suggestion accepted") }
	}
}

const workerAccountState = `{"schemaVersion":1,"activePreset":"Manual","manualDisabled":[],"presets":[]}`

func TestChoiceMutationsRequirePortableStateAndSafeRevision(t *testing.T) {
	for operation, fields := range map[string]string{
		"account-set": `"provider":"openai-codex","identity":"a@example.com","enabled":false`,
		"preset-create": `"name":"A","disabled":[]`,
		"preset-update": `"name":"A","disabled":[]`,
		"preset-activate": `"name":"A"`,
		"preset-delete": `"name":"A"`,
	} {
		t.Run(operation, func(t *testing.T) {
			for _, suffix := range []string{
				``,
				`,"baseRevision":0`,
				`,"state":`+workerAccountState,
				`,"state":null,"baseRevision":0`,
				`,"state":`+workerAccountState+`,"baseRevision":null`,
				`,"state":`+workerAccountState+`,"baseRevision":-1`,
				`,"state":`+workerAccountState+`,"baseRevision":0.5`,
				`,"state":`+workerAccountState+`,"baseRevision":9007199254740992`,
				`,"state":`+workerAccountState+`,"baseRevision":0,"baseRevision":1`,
				`,"state":`+strings.Replace(workerAccountState, `"schemaVersion":1`, `"schemaVersion":2`, 1)+`,"baseRevision":0`,
				`,"state":`+strings.Replace(workerAccountState, `"manualDisabled":[]`, `"manualDisabled":null`, 1)+`,"baseRevision":0`,
				`,"state":`+strings.Replace(workerAccountState, `"presets":[]`, `"presets":[{"name":"A","disabled":[],"name":"B"}]`, 1)+`,"baseRevision":0`,
				`,"state":`+strings.Replace(workerAccountState, `"manualDisabled":[]`, `"manualDisabled":[{"provider":"p","identityKey":"i","credential":"private"}]`, 1)+`,"baseRevision":0`,
			} {
				if args, revision, err := operationArgs(operation, "{"+fields+suffix+"}"); err == nil || args != nil || revision != nil {
					t.Fatalf("invalid proposal accepted: %s", suffix)
				}
			}
			for _, revision := range []string{"0", "9007199254740991"} {
				payload := "{"+fields+`,"state":`+workerAccountState+`,"baseRevision":`+revision+"}"
				if _, _, err := operationArgs(operation, payload); err != nil {
					t.Fatalf("valid revision boundary rejected: %s", revision)
				}
			}
		})
	}
	for _, payload := range []string{`{}`, `{"state":`+workerAccountState+`}`} {
		if _, revision, err := operationArgs("accounts-list", payload); err != nil || revision != nil {
			t.Fatal("account reads unexpectedly require a revision")
		}
	}
	if _, _, err := operationArgs("account-clear-blocks", `{"provider":"openai-codex","identity":"a@example.com"}`); err != nil {
		t.Fatal("governed broker effect unexpectedly requires portable state")
	}
	if args, _, err := operationArgs("account-clear-blocks", `{"provider":"openai-codex","identity":"a@example.com","state":`+workerAccountState+`}`); err == nil || args != nil {
		t.Fatal("broker effect accepted portable choices")
	}
}

func TestChoiceProposalBindsVerifiedPublicResultToCallerRevision(t *testing.T) {
	const result = `{"schemaVersion":1,"operation":"set","observedAt":100,"activePreset":"Manual","accounts":[{"provider":"openai-codex","identityKey":"a@example.com","selectable":true,"enabled":false,"blocked":false,"restrictions":[],"credential":"PRIVATE"}],"presets":[],"manualDisabled":[{"provider":"openai-codex","identityKey":"a@example.com"}],"baseRevision":900}`
	payload := `{"provider":"openai-codex","identity":"a@example.com","enabled":false,"state":`+workerAccountState+`,"baseRevision":7}`
	_, revision, err := operationArgs("account-set", payload)
	if err != nil {
		t.Fatal(err)
	}
	projected, err := projectResult("account-set", []byte(result), revision)
	if err != nil {
		t.Fatal(err)
	}
	var proposal struct {
		BaseRevision int64 `json:"baseRevision"`
		Accounts []accountRow `json:"accounts"`
		ManualDisabled []accountReference `json:"manualDisabled"`
	}
	if err := json.Unmarshal(projected, &proposal); err != nil {
		t.Fatal(err)
	}
	if proposal.BaseRevision != 7 || len(proposal.Accounts) != 1 || proposal.Accounts[0].Enabled || len(proposal.ManualDisabled) != 1 || proposal.ManualDisabled[0].IdentityKey != "a@example.com" || bytes.Contains(projected, []byte("PRIVATE")) {
		t.Fatalf("proposal lost its verified choices or revision binding: %s", projected)
	}
	for _, invalid := range []string{result+"{}", strings.Replace(result, `"operation":"set"`, `"operation":"list"`, 1), strings.Replace(result, `"enabled":false,`, "", 1)} {
		if projected, err := projectResult("account-set", []byte(invalid), revision); err == nil || projected != nil {
			t.Fatal("revision marker made invalid child output publishable")
		}
	}
	if projected, err := projectResult("account-set", []byte(result), nil); err == nil || projected != nil {
		t.Fatal("unbound mutation result became publishable")
	}
}

func TestReadObservationsCarryNullableCallerRevision(t *testing.T) {
	fixtures := map[string]string{
		"inspect": inspectFixture,
		"usage": usageFixture,
		"accounts-list": `{"schemaVersion":1,"operation":"list","observedAt":100,"activePreset":"Manual","accounts":[],"presets":[],"manualDisabled":[]}`,
		"suggest": `{"schema_version":1,"observed_at":"2026-09-08T10:00:00Z","observation":"one_shot","evaluator":"local-model","actions":[{"key":"model","value":"smart"}],"selection":{"model":"smart"}}`,
	}
	for operation, fixture := range fixtures {
		t.Run(operation, func(t *testing.T) {
			fields := `"state":`+workerAccountState
			if operation == "suggest" {
				fields += `,"prompt":"refactor"`
			}
			for _, marker := range []string{"", "null", "0", "9007199254740991"} {
				payload := "{"+fields
				if marker != "" {
					payload += `,"baseRevision":`+marker
				}
				payload += "}"
				_, revision, err := operationArgs(operation, payload)
				if err != nil {
					t.Fatalf("valid observation rejected: %s", payload)
				}
				// The child cannot relabel an observation as another shared revision.
				spoofed := fixture[:len(fixture)-1]+`,"baseRevision":100}`
				result, err := projectResult(operation, []byte(spoofed), revision)
				if err != nil {
					t.Fatal(err)
				}
				var public map[string]json.RawMessage
				if err := json.Unmarshal(result, &public); err != nil {
					t.Fatal(err)
				}
				want := marker
				if want == "" {
					want = "null"
				}
				if string(public["baseRevision"]) != want || bytes.Contains(result, []byte("PRIVATE")) {
					t.Fatalf("observation revision/privacy mismatch: %s", result)
				}
			}
			for _, marker := range []string{"-1", "9007199254740992", "1.5", `"1"`, "true"} {
				if args, revision, err := operationArgs(operation, "{"+fields+`,"baseRevision":`+marker+"}"); err == nil || args != nil || revision != nil {
					t.Fatalf("invalid read revision accepted: %s", marker)
				}
			}
			if result, err := projectResult(operation, []byte(fixture+"{}"), nil); err == nil || result != nil {
				t.Fatal("nullable revision made malformed child observation publishable")
			}
		})
	}
}

func TestAccountImportRequiresClosedSafeRevisionPayload(t *testing.T) {
	for _, payload := range []string{
		`{}`, `null`, `{"baseRevision":null}`, `{"baseRevision":-1}`,
		`{"baseRevision":9007199254740992}`, `{"baseRevision":0.5}`,
		`{"baseRevision":"1"}`, `{"baseRevision":true}`,
		`{"baseRevision":1,"baseRevision":2}`, `{"BaseRevision":1}`,
		`{"baseRevision":1} {}`, `{"baseRevision":1} trailing`,
		`{"baseRevision":1,"state":`+workerAccountState+`}`,
		`{"baseRevision":1,"argv":["accounts","set"]}`,
	} {
		if args, revision, err := operationArgs("account-import", payload); err == nil || args != nil || revision != nil {
			t.Fatalf("invalid import authority accepted: %s", payload)
		}
	}
	for _, marker := range []string{"0", "9007199254740991"} {
		args, revision, err := operationArgs("account-import", `{"baseRevision":`+marker+`}`)
		if err != nil || revision == nil {
			t.Fatalf("safe import revision rejected: %s", marker)
		}
		if len(args) != 2 || args[0] != "accounts" || args[1] != "list" {
			t.Fatalf("import escaped read-only machine operation: %v", args)
		}
	}
}

func TestAccountImportProjectsMachineChoicesWithCallerRevision(t *testing.T) {
	const machine = `{"schemaVersion":1,"operation":"list","observedAt":100,"activePreset":"Work","accounts":[{"provider":"openai-codex","identityKey":"a@example.com","selectable":true,"enabled":false,"blocked":false,"restrictions":[],"credential":"PRIVATE"}],"presets":[{"name":"Work","disabled":[{"provider":"openai-codex","identityKey":"a@example.com"}]}],"manualDisabled":[],"baseRevision":999}`
	_, revision, err := operationArgs("account-import", `{"baseRevision":7}`)
	if err != nil {
		t.Fatal(err)
	}
	result, err := projectResult("account-import", []byte(machine), revision)
	if err != nil {
		t.Fatal(err)
	}
	var imported struct {
		accountsResult
		BaseRevision int64 `json:"baseRevision"`
	}
	if err := json.Unmarshal(result, &imported); err != nil {
		t.Fatal(err)
	}
	if imported.BaseRevision != 7 || imported.ActivePreset != "Work" || len(imported.Presets) != 1 || imported.Presets[0].Disabled[0].IdentityKey != "a@example.com" || imported.Accounts[0].Enabled || bytes.Contains(result, []byte("PRIVATE")) {
		t.Fatalf("import lost verified machine choices or revision binding: %s", result)
	}
	for _, invalid := range []string{
		machine+"{}",
		strings.Replace(machine, `"operation":"list"`, `"operation":"set"`, 1),
		strings.Replace(machine, `"enabled":false,`, "", 1),
	} {
		if result, err := projectResult("account-import", []byte(invalid), revision); err == nil || result != nil {
			t.Fatal("invalid machine choices became an import proposal")
		}
	}
	if result, err := projectResult("account-import", []byte(machine), nil); err == nil || result != nil {
		t.Fatal("unbound machine import became publishable")
	}
}
