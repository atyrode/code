package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// TestOmpSmoke is the drift check against a real omp binary (issue #3). omp
// releases near-daily and ignores overlay keys it no longer knows, so an
// exit-code smoke test would stay green while the generated overlay quietly
// stopped applying. This one asserts what omp reads back, with the same
// generator, decoders and role tables the tool ships.
//
// Required CI runs it against the optional bundle pin; the weekly workflow
// runs it against latest upstream. Locally opt in with CODE_OMP_SMOKE=1 and
// CODE_OMP (or omp on PATH). A private home keeps operator config and accounts
// out of both runs. See README for the reusable deployed-wrapper invocation.
func TestOmpSmoke(t *testing.T) {
	if os.Getenv("CODE_OMP_SMOKE") != "1" {
		t.Skip("set CODE_OMP_SMOKE=1 to run the drift check against a real omp")
	}
	omp := newSmokeOmp(t)
	t.Logf("%s at %s", omp.version, omp.path)

	t.Run("EffectiveConfig", omp.checkEffectiveConfig)
	t.Run("ModelsSchema", omp.checkModelsSchema)
	t.Run("UsageSchema", omp.checkUsageSchema)
	t.Run("Roles", omp.checkRoles)
}

type smokeOmp struct {
	path     string
	version  string // `omp --version` verbatim, for runtime evidence
	agentDir string // PI_CODING_AGENT_DIR: where config.yml is read from
}

// newSmokeOmp resolves the binary the way Enter does and gives it a private
// home: every key omp would otherwise read the operator's state from is
// replaced (the same set a supervised engine launch replaces), and the broker
// variables are cleared so no account leaks into the run.
func newSmokeOmp(t *testing.T) *smokeOmp {
	t.Helper()
	path, err := resolveLaunchPath("CODE_OMP", []string{"omp"})
	if err != nil {
		t.Fatalf("resolving omp: %v", err)
	}
	home := t.TempDir()
	agentDir := filepath.Join(home, ".omp", "agent")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("OMP_PROFILE", "")
	t.Setenv("PI_CONFIG_DIR", filepath.Join(home, ".omp"))
	t.Setenv("PI_CODING_AGENT_DIR", agentDir)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_DATA_HOME", filepath.Join(home, ".local", "share"))
	t.Setenv("XDG_STATE_HOME", filepath.Join(home, ".local", "state"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if ompCredentialShaped(key) || strings.HasPrefix(key, "OMP_AUTH_BROKER_") {
			t.Setenv(key, "")
		}
	}

	o := &smokeOmp{path: path, agentDir: agentDir}
	out := o.run(t, "--version")
	o.version = strings.TrimSpace(string(out))
	return o
}

func (o *smokeOmp) run(t *testing.T, args ...string) []byte {
	t.Helper()
	cmd := exec.Command(o.path, args...)
	cmd.Dir = o.agentDir
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("omp %s: %v", strings.Join(args, " "), err)
	}
	return out
}

// smokeOverlay is the overlay under test: the two-pool golden catalog on the
// dials that make the generator emit every key it knows how to emit — the
// audit advisor (advisor.enabled and task.agentAdvisor), fast (tier), prewalk
// (prewalk.enabled and task.prewalk), and the agent-backed roles
// (task.agentModelOverrides) that every hosted combo carries.
func (o *smokeOmp) smokeOverlay(t *testing.T) string {
	t.Helper()
	blocks := loadBlocks(filepath.Join("testdata", "two-pool-golden.plain"))
	m := model{
		sel:       defaultSel(),
		generated: blocks,
		advisors:  parseAdvisors(blocks["__advisors__"]),
		facts:     parseFacts(blocks["__models__"]),
	}
	m.sel["advisor"] = "audit"
	m.sel["fast"] = "on"
	m.sel["prewalk"] = "on"
	if len(m.generated[comboID(m.sel)]) == 0 {
		t.Fatalf("the golden catalog has no block for %s", comboID(m.sel))
	}
	return m.genConfigYAML()
}

// checkEffectiveConfig writes the overlay where omp reads its config from and
// asks omp what it sees. Every leaf the overlay sets must be a setting omp
// still registers, and must read back with the value the overlay gave it. The
// `config` subcommand does not take --config, but an overlay is a config.yml
// by definition (omp's own help calls it "an extra config.yml-style overlay"),
// so the home's config.yml is the same schema through the same parser.
func (o *smokeOmp) checkEffectiveConfig(t *testing.T) {
	overlay := o.smokeOverlay(t)
	t.Logf("overlay under test:\n%s", overlay)
	if err := os.WriteFile(filepath.Join(o.agentDir, "config.yml"), []byte(overlay), 0o644); err != nil {
		t.Fatal(err)
	}
	var want map[string]any
	if err := yaml.Unmarshal([]byte(overlay), &want); err != nil {
		t.Fatalf("the generator emitted an overlay that is not YAML: %v", err)
	}

	var registered map[string]struct {
		Value any    `json:"value"`
		Type  string `json:"type"`
	}
	if err := json.Unmarshal(o.run(t, "config", "list", "--json"), &registered); err != nil {
		t.Fatalf("omp config list --json: %v", err)
	}
	if len(registered) == 0 {
		t.Fatal("omp config list --json registered no settings at all")
	}

	leaves := map[string]any{}
	flattenLeaves("", want, leaves)
	paths := make([]string, 0, len(leaves))
	for p := range leaves {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, path := range paths {
		// The longest registered key on the leaf's path is the setting omp
		// files it under: a scalar is its own key, a record entry (a role in
		// modelRoles, a chain in retry.fallbackChains) sits under the record.
		key, rest := path, []string(nil)
		for {
			if _, ok := registered[key]; ok {
				break
			}
			i := strings.LastIndexByte(key, '.')
			if i < 0 {
				t.Errorf("%s: the overlay sets it, and omp registers no such setting — omp ignores it silently", path)
				key = ""
				break
			}
			rest = append([]string{key[i+1:]}, rest...)
			key = key[:i]
		}
		if key == "" {
			continue
		}
		got := registered[key].Value
		for _, seg := range rest {
			rec, ok := got.(map[string]any)
			if !ok {
				got = nil
				break
			}
			got = rec[seg]
		}
		if !reflect.DeepEqual(got, leaves[path]) {
			t.Errorf("%s: overlay sets %v, omp reads back %v (under %s)", path, leaves[path], got, key)
		}
	}
}

// flattenLeaves walks a decoded YAML document to its dotted leaf paths. Lists
// are leaves: omp registers a chain as one array setting, not per element.
func flattenLeaves(prefix string, v any, out map[string]any) {
	rec, ok := v.(map[string]any)
	if !ok {
		out[prefix] = v
		return
	}
	for k, child := range rec {
		path := k
		if prefix != "" {
			path = prefix + "." + k
		}
		flattenLeaves(path, child, out)
	}
}

// checkModelsSchema runs the scaffolder's decoder over the real listing. A
// field omp renamed does not fail json.Unmarshal — it decodes to its zero
// value — so the decode is followed by the assertions the scaffolder relies
// on: a provider and id on every row, and at least one model that is priced,
// reasoning with a thinking range, and vision-capable. Placeholder API keys
// are set because omp lists only providers that hold a credential; the
// listing itself is served from the bundled catalog and makes no call.
func (o *smokeOmp) checkModelsSchema(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "omp-smoke-placeholder")
	t.Setenv("OPENAI_API_KEY", "omp-smoke-placeholder")
	raw := o.run(t, "models", "--json")
	var parsed ompModels
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("omp models --json no longer decodes with the scaffolder's struct: %v", err)
	}
	if len(parsed.Models) == 0 {
		t.Fatal("omp models --json listed no models")
	}
	var priced, thinking, vision, pooled bool
	for _, m := range parsed.Models {
		if m.Provider == "" || m.ID == "" || m.ContextWindow <= 0 {
			t.Errorf("model row without provider, id or contextWindow: %+v", m)
		}
		priced = priced || m.Cost.Input > 0
		thinking = thinking || (m.Reasoning && len(m.Thinking) > 0)
		pooled = pooled || poolOf(m.Provider) != ""
		for _, in := range m.Input {
			vision = vision || in == "image"
		}
	}
	for name, ok := range map[string]bool{"a priced model": priced, "a reasoning model with a thinking range": thinking,
		"an image-capable model": vision, "a model in a generator pool": pooled} {
		if !ok {
			t.Errorf("the listing decodes to no %s — the field the scaffolder reads has moved", name)
		}
	}
	if _, err := scaffoldModels(raw, nil); err != nil {
		t.Errorf("the scaffolder cannot build a models file from this listing: %v", err)
	}
}

// checkUsageSchema runs the usage decoders over the real payload. The home
// holds no account, so the payload is empty; what it proves is that the
// envelope still parses — the meter's parseAvailability reports ok only when
// it does, and readSpecialTiers reads the same document.
func (o *smokeOmp) checkUsageSchema(t *testing.T) {
	raw := o.run(t, "usage", "--json")
	if a := parseAvailability(nil, false, raw, 0); !a.ok {
		t.Errorf("omp usage --json no longer decodes with the usage meter's struct:\n%s", raw)
	}
	var envelope struct {
		Reports *[]json.RawMessage `json:"reports"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil || envelope.Reports == nil {
		t.Errorf("omp usage --json carries no reports array (err %v):\n%s", err, raw)
	}
}

var (
	// rolesHeading marks the role inventory in omp's bundled models.md; the
	// roles follow on the next non-empty line as backticked names.
	rolesHeading = "Supported model roles:"
	backticked   = regexp.MustCompile("`([a-z][a-z0-9-]*)`")
)

// checkRoles diffs omp's role inventory against what the generator routes. A
// role omp grows that the generator never routes stops the catalog covering it
// with no key removed or renamed — the one drift mode no assertion on our own
// keys can catch (issue #3, the vision role). Two inventories: the model roles
// omp documents in its bundled models.md, and the bundled task agents, which
// `omp agents unpack --json` lists without a TUI.
func (o *smokeOmp) checkRoles(t *testing.T) {
	routed := map[string]bool{}
	for _, r := range genRoleOrder {
		routed[r] = true
	}

	var roles []string
	lines := strings.Split(string(o.run(t, "read", "omp://models.md")), "\n")
	for i, line := range lines {
		if !strings.Contains(line, rolesHeading) {
			continue
		}
		for _, next := range lines[i+1:] {
			if strings.TrimSpace(next) == "" {
				continue
			}
			for _, m := range backticked.FindAllStringSubmatch(next, -1) {
				roles = append(roles, m[1])
			}
			break
		}
		break
	}
	if len(roles) == 0 {
		t.Fatalf("omp://models.md no longer lists roles under %q; the inventory moved and this check needs a new source", rolesHeading)
	}
	t.Logf("omp model roles: %s", strings.Join(roles, " "))
	for _, r := range roles {
		if !routed[r] {
			t.Errorf("omp has a model role %q the generator never routes", r)
		}
	}

	var unpacked struct {
		Written []string `json:"written"`
	}
	if err := json.Unmarshal(o.run(t, "agents", "unpack", "--dir", t.TempDir(), "--json"), &unpacked); err != nil {
		t.Fatalf("omp agents unpack --json: %v", err)
	}
	if len(unpacked.Written) == 0 {
		t.Fatal("omp agents unpack wrote no agents")
	}
	agents := map[string]bool{}
	for _, p := range unpacked.Written {
		name := strings.TrimSuffix(filepath.Base(p), ".md")
		agents[name] = true
		if !genAgentRoles[name] {
			t.Errorf("omp bundles a task agent %q the generator never routes into task.agentModelOverrides", name)
		}
	}
	for name := range genAgentRoles {
		if !agents[name] {
			t.Errorf("the generator routes an agent %q that %s no longer bundles (its task.agentModelOverrides entry is inert)", name, o.version)
		}
	}
}
