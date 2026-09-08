package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

const refreshCatalogFixture = `# The operator owns this catalog.
refreshed: '2000-01-01'
probed: true
custom_root: {owner: local, flags: [one, two]}
models:
  alpha:
    id: fixture-alpha
    pool: O
    tier: 4
    bucket: custom-quota
    image: false
    cost_in: 1 # retain price note
    cost_out: 2
    context: 100
    thinking: low→high
    speed: 10
    ttft: 9
    role: curated alpha # retain role note
    extension: {enabled: true, tags: [private, curated]}
  beta:
    id: fixture-beta
    pool: A
    tier: 1
    bucket: custom-anthropic
    cost_in: 3
    cost_out: 4
    context: 200
    thinking: low→high
    speed: 20
    role: curated beta
`

const refreshMetadataFixture = `{"models":[
 {"provider":"openai-codex","id":"fixture-alpha","contextWindow":1000,"reasoning":true,"thinking":["low","medium","high","max"],"cost":{"input":5,"output":6}},
 {"provider":"anthropic","id":"fixture-beta","contextWindow":2000,"reasoning":true,"thinking":["low","medium","high"],"cost":{"input":7,"output":8}},
 {"provider":"anthropic","id":"not-curated","contextWindow":9000,"thinking":["high"],"cost":{"input":10,"output":20}}
]}`

func refreshBenchFixture() map[string]any {
	rows := make([]any, 0, 2)
	for _, selector := range []string{"openai-codex/fixture-alpha", "anthropic/fixture-beta"} {
		rows = append(rows, map[string]any{
			"selector": selector, "model": selector,
			"results": []any{
				map[string]any{"ok": true, "challenge": "chat", "generationTps": 40.0, "tokensPerSecond": 10.0, "ttftMs": 1250.0},
				map[string]any{"ok": true, "challenge": "chat", "generationTps": 60.0, "tokensPerSecond": 20.0, "ttftMs": 1750.0},
			},
			"stats": map[string]any{
				"generationTps":   map[string]any{"mean": 50.0},
				"tokensPerSecond": map[string]any{"mean": 15.0},
				"ttftMs":          map[string]any{"mean": 1500.0},
			},
			"byChallenge": map[string]any{},
		})
	}
	return map[string]any{"profile": "chat", "runs": 2, "maxTokens": 256, "failures": 0, "models": rows}
}

func refreshJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// The executable seam exercises real process collection without credentials or
// an OMP installation. Only shell builtins are used, so PATH can remain empty.
func refreshFixture(t *testing.T, catalog, metadata, bench string, benchExit int, beforeModels string) (path, calls string) {
	t.Helper()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path, calls = filepath.Join(dir, "models.yml"), filepath.Join(dir, "calls")
	if err := os.WriteFile(path, []byte(catalog), 0o640); err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "configured-omp")
	script := "#!" + sh + "\n" + `printf '%s\n' "$1" >> "$REFRESH_TEST_CALLS"
case "$1" in
models)
  ` + beforeModels + `
  printf '%s\n' ` + shellSingleQuote(metadata) + `
  ;;
bench)
  shift
  profile='' prompt=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --profile) profile="$2"; shift 2 ;;
      --prompt) prompt="$2"; shift 2 ;;
      --runs|--max-tokens) shift 2 ;;
      --json|openai-codex/fixture-alpha|anthropic/fixture-beta) shift ;;
      *) exit 91 ;;
    esac
  done
  [ "$profile" = chat ] && [ -n "$prompt" ] || exit 92
  printf '%s\n' ` + shellSingleQuote(bench) + `
  exit ` + fmt.Sprint(benchExit) + `
  ;;
*) exit 93 ;;
esac
`
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_OMP", binary)
	t.Setenv("REFRESH_TEST_CALLS", calls)
	t.Setenv("REFRESH_TEST_CATALOG", path)
	t.Setenv("PATH", t.TempDir())
	return path, calls
}

func refreshRead(t *testing.T, path string) (string, map[string]catModel, string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Refreshed string              `yaml:"refreshed"`
		Models    map[string]catModel `yaml:"models"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Refreshed, doc.Models, string(raw)
}

func refreshRequireCalls(t *testing.T, path, want string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) && want == "" {
		return
	}
	if err != nil || string(raw) != want {
		t.Fatalf("provider calls = %q (%v), want %q", raw, err, want)
	}
}

func TestGenerateRefreshCompletePreservesCuration(t *testing.T) {
	path, calls := refreshFixture(t, refreshCatalogFixture, refreshMetadataFixture, refreshJSON(t, refreshBenchFixture()), 0, "")
	before := time.Now().UTC().Format("2006-01-02")
	if status := runGenerateRefresh([]string{"--models-file", path}); status != 0 {
		t.Fatalf("refresh exit = %d", status)
	}
	date, models, raw := refreshRead(t, path)
	if date != before && date != time.Now().UTC().Format("2006-01-02") {
		t.Errorf("full refresh date = %q", date)
	}
	if models["alpha"].CostIn != 5 || models["alpha"].CostOut != 6 || models["alpha"].Context != 1000 || models["alpha"].Thinking != "low,medium,high,max" {
		t.Errorf("metadata, including sparse thinking, = %+v", models["alpha"])
	}
	if models["beta"].Thinking != "low→high" || models["beta"].CostIn != 7 || models["beta"].Context != 2000 {
		t.Errorf("second provider metadata = %+v", models["beta"])
	}
	for key, model := range models {
		if model.Speed != 50 || model.TTFT != 1.5 {
			t.Errorf("%s measurements = speed %g, ttft %g; want streaming rate 50 and 1.5s", key, model.Speed, model.TTFT)
		}
	}
	// Compare every non-factual value, not just a sample of known curated keys.
	curated := func(body string) map[string]any {
		var doc map[string]any
		if err := yaml.Unmarshal([]byte(body), &doc); err != nil {
			t.Fatal(err)
		}
		delete(doc, "refreshed")
		for _, row := range doc["models"].(map[string]any) {
			model := row.(map[string]any)
			for _, field := range []string{"cost_in", "cost_out", "context", "thinking", "speed", "ttft"} {
				delete(model, field)
			}
		}
		return doc
	}
	if !reflect.DeepEqual(curated(raw), curated(refreshCatalogFixture)) {
		t.Errorf("refresh changed membership or curated/custom fields:\n%s", raw)
	}
	for _, comment := range []string{"# The operator owns this catalog.", "# retain price note", "# retain role note"} {
		if !strings.Contains(raw, comment) {
			t.Errorf("refresh lost comment %q", comment)
		}
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("catalog permissions were not preserved: %v, %v", info, err)
	}
	refreshRequireCalls(t, calls, "models\nbench\n")
}

func TestGenerateRefreshMetadataOnlyDoesNotAttestMeasurements(t *testing.T) {
	path, calls := refreshFixture(t, refreshCatalogFixture, refreshMetadataFixture, "", 99, "")
	if status := runGenerateRefresh([]string{"--models-file", path, "--skip-bench"}); status != 0 {
		t.Fatalf("metadata-only exit = %d", status)
	}
	date, models, _ := refreshRead(t, path)
	if date != "2000-01-01" || models["alpha"].Speed != 10 || models["alpha"].TTFT != 9 || models["beta"].TTFT != 0 || models["alpha"].Context != 1000 {
		t.Fatalf("metadata-only changed freshness/measurements or lost metadata: %s %+v", date, models)
	}
	refreshRequireCalls(t, calls, "models\n")
}

func TestGenerateRefreshPartialMetadataKeepsUnavailableFacts(t *testing.T) {
	metadata := `{"models":[{"provider":"openai-codex","id":"fixture-alpha","contextWindow":null,"thinking":["future-level"],"cost":{"input":0,"output":7}}]}`
	path, _ := refreshFixture(t, refreshCatalogFixture, metadata, refreshJSON(t, refreshBenchFixture()), 0, "")
	if status := runGenerateRefresh([]string{"--models-file", path}); status != 1 {
		t.Fatalf("partial metadata exit = %d", status)
	}
	date, models, _ := refreshRead(t, path)
	a, b := models["alpha"], models["beta"]
	if date != "2000-01-01" || a.CostIn != 1 || a.CostOut != 7 || a.Context != 100 || a.Thinking != "low→high" || b.Context != 200 || a.Speed != 50 || b.Speed != 50 {
		t.Fatalf("partial metadata overwrote unavailable facts or discarded valid neighbors: %s %+v", date, models)
	}
}

func TestGenerateRefreshResellerPricesCompleteMetadata(t *testing.T) {
	metadata := strings.Replace(refreshMetadataFixture, `"input":5,"output":6`, `"input":0,"output":0`, 1)
	metadata = strings.Replace(metadata, `{"provider":"anthropic","id":"not-curated"`, `{"provider":"reseller","id":"vendor/fixture-alpha"`, 1)
	path, _ := refreshFixture(t, refreshCatalogFixture, metadata, refreshJSON(t, refreshBenchFixture()), 0, "")
	if status := runGenerateRefresh([]string{"--models-file", path}); status != 0 {
		t.Fatalf("reseller refresh exit = %d", status)
	}
	date, models, _ := refreshRead(t, path)
	if date == "2000-01-01" || models["alpha"].CostIn != 10 || models["alpha"].CostOut != 20 {
		t.Fatalf("reseller facts did not complete refresh: %s %+v", date, models["alpha"])
	}
}

func TestGenerateRefreshIncompleteBenchKeepsValidNeighbors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
		exit   int
		wantA  [2]float64
		wantB  [2]float64
	}{
		{"failed run with successful stats", func(b map[string]any) {
			b["models"].([]any)[0].(map[string]any)["results"].([]any)[1].(map[string]any)["ok"] = false
		}, 1, [2]float64{10, 9}, [2]float64{50, 1.5}},
		{"missing row", func(b map[string]any) { b["models"] = b["models"].([]any)[:1] }, 0, [2]float64{50, 1.5}, [2]float64{20, 0}},
		{"short run list", func(b map[string]any) {
			row := b["models"].([]any)[0].(map[string]any)
			row["results"] = row["results"].([]any)[:1]
		}, 0, [2]float64{10, 9}, [2]float64{50, 1.5}},
		{"invalid per-run speed behind valid mean", func(b map[string]any) {
			b["models"].([]any)[0].(map[string]any)["results"].([]any)[0].(map[string]any)["generationTps"] = 0
		}, 0, [2]float64{10, 1.5}, [2]float64{50, 1.5}},
		{"missing ttft aggregate", func(b map[string]any) {
			delete(b["models"].([]any)[0].(map[string]any)["stats"].(map[string]any), "ttftMs")
		}, 0, [2]float64{50, 9}, [2]float64{50, 1.5}},
		{"nonzero process with complete rows", func(map[string]any) {}, 1, [2]float64{50, 1.5}, [2]float64{50, 1.5}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bench := refreshBenchFixture()
			tc.mutate(bench)
			path, _ := refreshFixture(t, refreshCatalogFixture, refreshMetadataFixture, refreshJSON(t, bench), tc.exit, "")
			if status := runGenerateRefresh([]string{"--models-file", path}); status != 1 {
				t.Fatalf("incomplete benchmark exit = %d", status)
			}
			date, models, _ := refreshRead(t, path)
			if date != "2000-01-01" || models["alpha"].Context != 1000 {
				t.Fatalf("partial benchmark changed freshness or discarded metadata: %s %+v", date, models)
			}
			for key, want := range map[string][2]float64{"alpha": tc.wantA, "beta": tc.wantB} {
				got := models[key]
				if got.Speed != want[0] || got.TTFT != want[1] {
					t.Errorf("%s measurements = %g/%g, want %g/%g", key, got.Speed, got.TTFT, want[0], want[1])
				}
			}
		})
	}
}

func TestGenerateRefreshSavedBench(t *testing.T) {
	for _, profile := range []string{"chat", "mix"} {
		t.Run(profile, func(t *testing.T) {
			bench := refreshBenchFixture()
			bench["profile"] = profile
			path, calls := refreshFixture(t, strings.Replace(refreshCatalogFixture, "refreshed: '2000-01-01'\n", "", 1), refreshMetadataFixture, "", 99, "")
			saved := filepath.Join(t.TempDir(), "bench.json")
			if err := os.WriteFile(saved, []byte(refreshJSON(t, bench)), 0o600); err != nil {
				t.Fatal(err)
			}
			status := runGenerateRefresh([]string{"--models-file", path, "--bench-json", saved, "--runs", "3"})
			date, models, _ := refreshRead(t, path)
			if profile == "chat" {
				if status != 0 || date == "" || models["beta"].TTFT != 1.5 {
					t.Fatalf("complete saved report did not attest facts: exit %d, date %q, %+v", status, date, models)
				}
			} else if status != 1 || date != "" || models["alpha"].Speed != 10 || models["alpha"].Context != 1000 {
				t.Fatalf("wrong workload certified measurements or discarded metadata: exit %d, date %q, %+v", status, date, models)
			}
			refreshRequireCalls(t, calls, "models\n")
		})
	}
}

func TestGenerateRefreshRejectsInvalidInputBeforeProviderCalls(t *testing.T) {
	for _, tc := range []struct {
		name    string
		catalog string
		args    []string
	}{
		{"duplicate key", strings.Replace(refreshCatalogFixture, "    pool: O", "    pool: O\n    pool: A", 1), nil},
		{"unknown pool", strings.Replace(refreshCatalogFixture, "    pool: O", "    pool: unknown", 1), nil},
		{"nonmapping row", "models:\n  alpha: []\n", nil},
		{"multiple documents", refreshCatalogFixture + "---\nmodels: {}\n", nil},
		{"conflicting sources", refreshCatalogFixture, []string{"--skip-bench", "--bench-json", "absent.json"}},
		{"invalid run count", refreshCatalogFixture, []string{"--runs", "0"}},
		{"invalid token count", refreshCatalogFixture, []string{"--max-tokens", "-1"}},
		{"unexpected positional argument", refreshCatalogFixture, []string{"extra"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path, calls := refreshFixture(t, tc.catalog, refreshMetadataFixture, "", 99, "")
			if status := runGenerateRefresh(append([]string{"--models-file", path}, tc.args...)); status != 2 {
				t.Fatalf("invalid input exit = %d", status)
			}
			raw, err := os.ReadFile(path)
			if err != nil || string(raw) != tc.catalog {
				t.Fatalf("invalid input changed: %q (%v)", raw, err)
			}
			refreshRequireCalls(t, calls, "")
		})
	}
}

func TestGenerateRefreshInvalidMetadataDoesNotRewrite(t *testing.T) {
	for _, metadata := range []string{`{"models":{}}`, `{"models":[{"provider":"anthropic","id":"same"},{"provider":"anthropic","id":"same"}]}`, `{truncated`} {
		t.Run(metadata, func(t *testing.T) {
			path, calls := refreshFixture(t, refreshCatalogFixture, metadata, "", 99, "")
			if status := runGenerateRefresh([]string{"--models-file", path}); status != 1 {
				t.Fatalf("invalid metadata exit = %d", status)
			}
			raw, err := os.ReadFile(path)
			if err != nil || string(raw) != refreshCatalogFixture {
				t.Fatalf("invalid metadata rewrote catalog: %q (%v)", raw, err)
			}
			refreshRequireCalls(t, calls, "models\n")
		})
	}
}

func TestGenerateRefreshRefusesConcurrentCatalogEdit(t *testing.T) {
	const edit = "# concurrent operator edit\n"
	path, _ := refreshFixture(t, refreshCatalogFixture, refreshMetadataFixture, refreshJSON(t, refreshBenchFixture()), 0,
		"printf '%s' "+shellSingleQuote(edit)+" >> \"$REFRESH_TEST_CATALOG\"")
	if status := runGenerateRefresh([]string{"--models-file", path}); status != 1 {
		t.Fatalf("concurrent modification exit = %d", status)
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != refreshCatalogFixture+edit {
		t.Fatalf("refresh overwrote a concurrent edit: %q (%v)", raw, err)
	}
}

func TestGenerateRefreshMalformedBenchStillSavesMetadata(t *testing.T) {
	path, _ := refreshFixture(t, refreshCatalogFixture, refreshMetadataFixture, `{truncated`, 1, "")
	if status := runGenerateRefresh([]string{"--models-file", path}); status != 1 {
		t.Fatalf("malformed benchmark exit = %d", status)
	}
	date, models, _ := refreshRead(t, path)
	if date != "2000-01-01" || models["alpha"].Context != 1000 || models["alpha"].Speed != 10 || models["alpha"].TTFT != 9 {
		t.Fatalf("malformed benchmark changed cached measurements or lost metadata: %s %+v", date, models)
	}
}

func TestGenerateRefreshDoesNotReplaceManagedSymlink(t *testing.T) {
	path, calls := refreshFixture(t, refreshCatalogFixture, refreshMetadataFixture, "", 99, "")
	link := path + ".link"
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if status := runGenerateRefresh([]string{"--models-file", link}); status != 2 {
		t.Fatalf("symlink refresh exit = %d", status)
	}
	target, err := os.Readlink(link)
	if err != nil || target != path {
		t.Fatalf("managed link was replaced: %q (%v)", target, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != refreshCatalogFixture {
		t.Fatalf("managed target changed: %q (%v)", raw, err)
	}
	refreshRequireCalls(t, calls, "")
}
