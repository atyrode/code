package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// The executable observes only public child inputs. Probes are not launches:
// they cannot create the capture marker or satisfy the session-lifetime check.
func headlessLaunchFixture(t *testing.T) string {
	t.Helper()
	isolateEngineEnv(t)
	t.Setenv("CODE_GENERATED", engineCatalogFixture(t))
	t.Setenv("CODE_USAGE_CACHE", "")
	t.Setenv("CODE_SESSION_STATE", t.TempDir())
	t.Setenv("LAUNCH_VERSION", "18.1.10")
	t.Setenv("LAUNCH_PROVIDER", "")
	t.Setenv("LAUNCH_EXIT", "0")
	capture := t.TempDir()
	t.Setenv("LAUNCH_CAPTURE", capture)
	t.Setenv("LAUNCH_RECORD", filepath.Join(sessionDir(), strconv.Itoa(os.Getpid())+".json"))
	path := filepath.Join(t.TempDir(), "omp")
	body := `#!/bin/sh
case "$1" in
  --version) printf 'omp/%s\n' "$LAUNCH_VERSION"; exit 0 ;;
  token) [ -z "$LAUNCH_PROVIDER" ] || [ "$2" = "$LAUNCH_PROVIDER" ]; exit $? ;;
esac
cat "$LAUNCH_RECORD" > "$LAUNCH_CAPTURE/session" || exit 94
pwd > "$LAUNCH_CAPTURE/cwd"
printf '%s|%s|%s|%s|%s\n' "${OMP_AUTH_BROKER_URL+set}" "${OMP_AUTH_BROKER_TOKEN+set}" "${OMP_AUTH_BROKER_SNAPSHOT_CACHE+set}" "${OMP_AUTH_BROKER_ACCOUNT_POOL_FILE+set}" "${CODE_AUTH_ACCOUNT_STATE+set}" > "$LAUNCH_CAPTURE/auth"
if [ -n "$OMP_AUTH_BROKER_ACCOUNT_POOL_FILE" ]; then
  cat "$OMP_AUTH_BROKER_ACCOUNT_POOL_FILE" > "$LAUNCH_CAPTURE/pool" || exit 96
fi
: > "$LAUNCH_CAPTURE/argv"
take_config=
for arg in "$@"; do
  if [ "$take_config" = yes ]; then
    printf '%s\n' "$arg" > "$LAUNCH_CAPTURE/config-path"
    cat "$arg" > "$LAUNCH_CAPTURE/config" || exit 95
    printf '<overlay>\n' >> "$LAUNCH_CAPTURE/argv"
    take_config=
  else
    printf '%s\n' "$arg" >> "$LAUNCH_CAPTURE/argv"
    if [ "$arg" = --config ]; then take_config=yes; fi
  fi
done
exit "$LAUNCH_EXIT"
`
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_OMP", path)
	t.Setenv("CODE_OMP_UNTRUSTED", path)
	return capture
}

func launchCapture(t *testing.T, dir, name string) string {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestHeadlessLaunchMatchesConfirmedTUI(t *testing.T) {
	for _, version := range []string{"17.2.9", "18.1.10"} {
		t.Run(version, func(t *testing.T) {
			capture := headlessLaunchFixture(t)
			t.Setenv("LAUNCH_VERSION", version)
			selection := map[string]string{"lane": "gpt-led", "thinking": "high", "advisor": "audit", "prewalk": "on", "planyolo": "on", "fallback": "off"}
			m, err := loadHeadlessModel(nil)
			if err != nil {
				t.Fatal(err)
			}
			// Turn the TUI dials directly, then confirm through its real Enter
			// transition rather than synthesizing the expected overlay in the test.
			for key, value := range selection {
				m.sel[key] = value
			}
			m.firstPrompt = "first prompt with spaces"
			confirmed, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
			forwarded := []string{"--profile", "ignored", "--profile=ignored-too", "--resume=existing", "--", "literal text"}
			if status := executeLaunch(confirmed.(model), forwarded); status != 0 {
				t.Fatalf("TUI launch status = %d", status)
			}
			wantConfig, wantArgv := launchCapture(t, capture, "config"), launchCapture(t, capture, "argv")
			if strings.Contains(wantConfig, "agentAdvisor:") != (version == "18.1.10") {
				t.Fatalf("advisor version guard for %s:\n%s", version, wantConfig)
			}
			if !strings.Contains(wantConfig, "modelFallback: false") || !strings.Contains(wantArgv, "--plan-yolo\n") {
				t.Fatalf("dials did not reach child: %s\n%s", wantConfig, wantArgv)
			}
			encoded, _ := json.Marshal(selection)
			args := []string{"--selection", string(encoded), "--prompt", m.firstPrompt, "--"}
			if status := runLaunch(append(args, forwarded...)); status != 0 {
				t.Fatalf("headless launch status = %d", status)
			}
			if got := launchCapture(t, capture, "config"); got != wantConfig {
				t.Fatalf("headless overlay differs from TUI:\n%s\nwant:\n%s", got, wantConfig)
			}
			if got := launchCapture(t, capture, "argv"); got != wantArgv || strings.Contains(got, "ignored") || !strings.HasSuffix(got, "literal text\nfirst prompt with spaces\n") {
				t.Fatalf("headless argv = %q, TUI argv = %q", got, wantArgv)
			}
			var record sessionRecord
			if err := json.Unmarshal([]byte(launchCapture(t, capture, "session")), &record); err != nil {
				t.Fatal(err)
			}
			if record.Resume != "existing" || record.Profile != comboID(m.sel) {
				t.Fatalf("child saw wrong session: %+v", record)
			}
			requireNoPath(t, os.Getenv("LAUNCH_RECORD"))
			requireNoPath(t, strings.TrimSpace(launchCapture(t, capture, "config-path")))
		})
	}
}

func TestHeadlessLaunchRejectsInvalidRequestsBeforeChild(t *testing.T) {
	cases := [][]string{
		{"--selection", `null`},
		{"--selection", `{}` + `{}`},
		{"--selection", `{"thinking":null}`},
		{"--selection", `{"thinking":"low","thinking":"high"}`},
		{"--selection", `{"thinking":"high",}`},
		{"--selection", `{"unknown":"on"}`},
		{"--selection", `{"thinking":"invalid"}`},
		{"--selection", `{"lane":"claude-only","spark":"on"}`},
		{"--selection", `{"lane":"ds-only","fast":"on"}`},
		{"--selection", `{"local":"unconfirmed"}`},
		{"--kind", "sandbox"},
		{"--kind", "managed", "--selection", `{"thinking":"high"}`},
		{"--runtime", "somewhere"},
		{"--kind", "runtime"},
		{"--kind", "runtime", "--runtime", "not-advertised"},
		{"unseparated omp argument"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			capture := headlessLaunchFixture(t)
			if status := runLaunch(args); status != 2 {
				t.Fatalf("invalid request returned %d", status)
			}
			requireNoPath(t, filepath.Join(capture, "argv"))
			requireNoPath(t, os.Getenv("LAUNCH_RECORD"))
		})
	}
}

func TestHeadlessLaunchRefusesExplicitUnavailableProvider(t *testing.T) {
	capture := headlessLaunchFixture(t)
	t.Setenv("LAUNCH_PROVIDER", "openai-codex")
	if status := runLaunch([]string{"--selection", `{"lane":"claude-only"}`}); status != 2 {
		t.Fatalf("unavailable explicit lane returned %d", status)
	}
	requireNoPath(t, filepath.Join(capture, "argv"))
	if status := runLaunch([]string{"--selection", `{"lane":"gpt-only","advisor":"off"}`}); status != 0 {
		t.Fatalf("available lane returned %d", status)
	}
}

func TestHeadlessDefaultsIgnoreSavedSelectionAndCopies(t *testing.T) {
	headlessLaunchFixture(t)
	state := filepath.Join(t.TempDir(), "selection.json")
	if err := saveSelectionState(state, map[string]string{"lane": "claude-only", "thinking": "low"}, facetDefs(nil)); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_SELECTION_STATE", state)
	m, err := loadHeadlessModel(nil)
	if err != nil {
		t.Fatal(err)
	}
	if m.sel["thinking"] != "medium" || m.sel["lane"] != "mixed" {
		t.Fatalf("headless defaults consumed saved UI choices: %v", m.sel)
	}
	before := selectionChoices(m.sel, m.facets)
	if _, err := selectHeadlessModel(m, map[string]string{"lane": "claude-only", "spark": "on"}); err == nil {
		t.Fatal("impossible selection accepted")
	}
	if !reflect.DeepEqual(selectionChoices(m.sel, m.facets), before) {
		t.Fatal("failed selection mutated caller's snapshot")
	}
}

func TestHeadlessManagedAndUntrustedNeedNoCatalogAndPropagateExit(t *testing.T) {
	for _, kind := range []string{"managed", "untrusted"} {
		t.Run(kind, func(t *testing.T) {
			capture := headlessLaunchFixture(t)
			t.Setenv("CODE_GENERATED", filepath.Join(t.TempDir(), "missing"))
			t.Setenv("LAUNCH_EXIT", "23")
			if kind == "untrusted" {
				t.Setenv("OMP_AUTH_BROKER_URL", "http://ambient")
				t.Setenv("OMP_AUTH_BROKER_TOKEN", "ambient-secret")
				t.Setenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE", "/ambient/cache")
				t.Setenv("OMP_AUTH_BROKER_ACCOUNT_POOL_FILE", "/ambient/pool")
				t.Setenv("CODE_AUTH_ACCOUNT_STATE", "/ambient/account-state")
			}
			if status := runLaunch([]string{"--kind", kind, "--prompt", "hello", "--", "--profile=ignored", "--print"}); status != 23 {
				t.Fatalf("child exit status = %d", status)
			}
			if got := launchCapture(t, capture, "argv"); got != "--print\nhello\n" {
				t.Fatalf("child argv = %q", got)
			}
			if got := launchCapture(t, capture, "auth"); got != "||||\n" {
				t.Fatalf("auth environment escaped into child: %q", got)
			}
			requireNoPath(t, os.Getenv("LAUNCH_RECORD"))
		})
	}
}

func TestHeadlessCatalogErrorsAndOnboardingSnapshot(t *testing.T) {
	headlessLaunchFixture(t)
	for _, body := range []string{"", "not a catalog\n", "gpt-only_smart_medium_nosp\n    advisor claude-test:high\n"} {
		path := filepath.Join(t.TempDir(), "bad-catalog")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("CODE_GENERATED", path)
		if _, err := loadHeadlessModel(nil); err == nil {
			t.Fatalf("accepted invalid catalog %q", body)
		}
	}
	t.Setenv("CODE_GENERATED", filepath.Join(t.TempDir(), "absent"))
	if _, err := loadHeadlessModel(nil); err == nil {
		t.Fatal("explicit missing catalog accepted")
	}
	t.Setenv("CODE_GENERATED", "")
	m, err := loadHeadlessModel(nil)
	if err != nil || len(m.generated) != 0 {
		t.Fatalf("missing default catalog should allow onboarding inspection: %v", err)
	}
}

func TestHeadlessWorktreePreservesPrefixAndCleansPristineTree(t *testing.T) {
	capture := headlessLaunchFixture(t)
	repo := initWorktreeTestRepo(t)
	t.Setenv("LAUNCH_RECORD", filepath.Join(sessionDir(), strconv.Itoa(os.Getpid())+".json"))
	subdir := filepath.Join(repo, "nested")
	if err := os.Mkdir(subdir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(subdir, "tracked"), []byte("base"), 0o600); err != nil {
		t.Fatal(err)
	}
	mustGit(t, repo, "add", ".")
	mustGit(t, repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "nested")
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(subdir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(cwd) })
	if status := runLaunch([]string{"--kind", "managed", "--worktree"}); status != 0 {
		t.Fatalf("worktree launch = %d", status)
	}
	var record sessionRecord
	if err := json.Unmarshal([]byte(launchCapture(t, capture, "session")), &record); err != nil {
		t.Fatal(err)
	}
	childDir := strings.TrimSpace(launchCapture(t, capture, "cwd"))
	if record.Worktree == "" || childDir != filepath.Join(record.Worktree, "nested") || record.Cwd != childDir || childDir == subdir {
		t.Fatalf("child did not receive isolated prefixed cwd: cwd=%q record=%+v", childDir, record)
	}
	requireNoPath(t, record.Worktree)
	requireNoPath(t, os.Getenv("LAUNCH_RECORD"))
	if got, err := os.Getwd(); err != nil || got != subdir {
		t.Fatalf("parent cwd changed: %q %v", got, err)
	}
}

func TestHeadlessRuntimeDelegatesWithoutCatalogOrAuth(t *testing.T) {
	capture := headlessLaunchFixture(t)
	t.Setenv("CODE_GENERATED", filepath.Join(t.TempDir(), "absent"))
	t.Setenv("OMP_AUTH_BROKER_URL", "http://ambient")
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "ambient-secret")
	t.Setenv("LAUNCH_EXIT", "19")
	broker := filepath.Join(t.TempDir(), "runtime-broker")
	body := `#!/bin/sh
if [ "$1" = runtime ] && [ "$2" = list ]; then
  printf '[{"schemaVersion":1,"name":"local-test","applicable":true}]\n'
  exit 0
fi
exec "$CODE_OMP_UNTRUSTED" "$@"
`
	if err := os.WriteFile(broker, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_RUNTIME_BROKER", broker)
	args := []string{"--kind", "runtime", "--runtime", "local-test", "--selection", `{"thinking":"high"}`, "--prompt", "first",
		"--", "--profile", "ignored", "--config=ignored", "--print"}
	if status := runLaunch(args); status != 19 {
		t.Fatalf("runtime child exit = %d", status)
	}
	if got := launchCapture(t, capture, "argv"); got != "runtime\nrun\nlocal-test\n--\n--thinking\nhigh\n--print\nfirst\n" {
		t.Fatalf("runtime argv = %q", got)
	}
	if got := launchCapture(t, capture, "auth"); got != "||||\n" {
		t.Fatalf("runtime inherited auth: %q", got)
	}
	var record sessionRecord
	if err := json.Unmarshal([]byte(launchCapture(t, capture, "session")), &record); err != nil {
		t.Fatal(err)
	}
	if record.Profile != "runtime:local-test" {
		t.Fatalf("runtime registered as %q", record.Profile)
	}
	requireNoPath(t, os.Getenv("LAUNCH_RECORD"))
}

func TestHeadlessLaunchAccountSelectionOverridesOnlyThisLaunch(t *testing.T) {
	for _, kind := range []string{"generated", "managed"} {
		t.Run(kind, func(t *testing.T) {
			capture := headlessLaunchFixture(t)
			accountAPITestBroker(t)
			path := os.Getenv("CODE_AUTH_ACCOUNT_STATE")
			saved := defaultAccountSelectionState()
			saved.SetManualDisabled(map[accountKey]bool{{Provider: "openai-codex", IdentityKey: "b@example.com"}: true})
			if err := writeAccountSelectionState(path, saved); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			selection := `{"schemaVersion":1,"disabled":[{"provider":"openai-codex","identityKey":"a@example.com"}]}`
			if status := runLaunch([]string{"--kind", kind, "--account-selection", selection}); status != 0 {
				t.Fatalf("selected launch failed: %d", status)
			}
			var pool map[string][]string
			if err := json.Unmarshal([]byte(launchCapture(t, capture, "pool")), &pool); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(pool["openai-codex"], []string{"b@example.com"}) {
				t.Fatalf("child saw wrong account pool: %v", pool)
			}
			after, err := os.ReadFile(path)
			if err != nil || string(before) != string(after) {
				t.Fatal("ephemeral launch changed standalone choices")
			}
			if status := runLaunch([]string{"--kind", kind}); status != 0 {
				t.Fatalf("standalone launch failed: %d", status)
			}
			if err := json.Unmarshal([]byte(launchCapture(t, capture, "pool")), &pool); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(pool["openai-codex"], []string{"a@example.com"}) {
				t.Fatalf("launch override leaked to next launch: %v", pool)
			}
		})
	}
}

func TestHeadlessLaunchAccountSelectionRefusesBroadenedPool(t *testing.T) {
	for _, selection := range []string{
		"", "null", `{}`, `{"schemaVersion":2,"disabled":[]}`,
		`{"schemaVersion":1,"disabled":null}`,
		`{"schemaVersion":1,"disabled":[]} {}`,
		`{"schemaVersion":1,"disabled":[],"disabled":[]}`,
		`{"schemaVersion":1,"disabled":[],"extra":true}`,
		`{"schemaVersion":1,"disabled":[{"provider":"openai-codex","identityKey":"a@example.com","identityKey":"b@example.com"}]}`,
		`{"schemaVersion":1,"disabled":[{"provider":"openai-codex","identityKey":"unknown"}]}`,
		`{"schemaVersion":1,"disabled":[{"provider":"openai-codex","identityKey":""}]}`,
		`{"schemaVersion":1,"disabled":[{"provider":"openai-codex","identityKey":"a@example.com"},{"provider":"openai-codex","identityKey":"a@example.com"}]}`,
	} {
		t.Run(selection, func(t *testing.T) {
			capture := headlessLaunchFixture(t)
			accountAPITestBroker(t)
			if status := runLaunch([]string{"--kind", "managed", "--account-selection", selection}); status == 0 {
				t.Fatal("unsafe account selection launched")
			}
			requireNoPath(t, filepath.Join(capture, "argv"))
			requireNoPath(t, os.Getenv("CODE_AUTH_ACCOUNT_STATE"))
		})
	}
	for _, kind := range []string{"untrusted", "runtime"} {
		t.Run(kind, func(t *testing.T) {
			capture := headlessLaunchFixture(t)
			if status := runLaunch([]string{"--kind", kind, "--account-selection", `{"schemaVersion":1,"disabled":[]}`}); status == 0 {
				t.Fatal("account selection accepted outside a trusted launch")
			}
			requireNoPath(t, filepath.Join(capture, "argv"))
		})
	}
	t.Run("brokerless", func(t *testing.T) {
		capture := headlessLaunchFixture(t)
		if status := runLaunch([]string{"--kind", "managed", "--account-selection", `{"schemaVersion":1,"disabled":[]}`}); status == 0 {
			t.Fatal("brokerless launch discarded explicit choices")
		}
		requireNoPath(t, filepath.Join(capture, "argv"))
	})
}

func TestHeadlessLaunchAccountSelectionUsesAuthoritativeSnapshot(t *testing.T) {
	capture := headlessLaunchFixture(t)
	var snapshots atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/snapshot" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if snapshots.Add(1) == 1 {
			fmt.Fprint(w, `{"credentials":[{"provider":"openai-codex","identityKey":"a@example.com","credential":{"type":"oauth","email":"a@example.com"}},{"provider":"openai-codex","identityKey":"b@example.com","credential":{"type":"oauth","email":"b@example.com"}}]}`)
		} else {
			fmt.Fprint(w, `{"credentials":[{"provider":"openai-codex","identityKey":"b@example.com","credential":{"type":"oauth","email":"b@example.com"}}]}`)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("OMP_AUTH_BROKER_URL", server.URL)
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "fixture")
	t.Setenv("CODE_AUTH_ACCOUNT_STATE", filepath.Join(t.TempDir(), "missing", "accounts.json"))
	selection := `{"schemaVersion":1,"disabled":[{"provider":"openai-codex","identityKey":"a@example.com"}]}`
	if status := runLaunch([]string{"--account-selection", selection}); status == 0 {
		t.Fatal("identity disappearing after preflight broadened launch pool")
	}
	requireNoPath(t, filepath.Join(capture, "argv"))
	requireNoPath(t, os.Getenv("CODE_AUTH_ACCOUNT_STATE"))
	if snapshots.Load() != 2 {
		t.Fatalf("expected preflight and authoritative launch snapshots, got %d", snapshots.Load())
	}
}

func TestHeadlessLaunchAccountSelectionDoesNotReadStandaloneState(t *testing.T) {
	capture := headlessLaunchFixture(t)
	accountAPITestBroker(t)
	path := os.Getenv("CODE_AUTH_ACCOUNT_STATE")
	if err := os.WriteFile(path, []byte("invalid standalone document"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, statePath := range []string{path, filepath.Join(t.TempDir(), "missing", "accounts.json"), ""} {
		t.Setenv("CODE_AUTH_ACCOUNT_STATE", statePath)
		selection := `{"schemaVersion":1,"disabled":[{"provider":"openai-codex","identityKey":"a@example.com"},{"provider":"openai-codex","identityKey":"b@example.com"}]}`
		if status := runLaunch([]string{"--kind", "managed", "--account-selection", selection}); status != 0 {
			t.Fatalf("stateless launch failed with state path %q: %d", statePath, status)
		}
		var pool map[string][]string
		if err := json.Unmarshal([]byte(launchCapture(t, capture, "pool")), &pool); err != nil {
			t.Fatal(err)
		}
		if identities, present := pool["openai-codex"]; !present || len(identities) != 0 {
			t.Fatalf("all-disabled selection broadened: %v", pool)
		}
	}
}
