package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	clikit "github.com/atyrode/cli-kit"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ansiRe strips SGR sequences so tests assert on visible text regardless of the
// active color profile.
var ansiRe = regexp.MustCompile("\x1b\\[[0-9;]*m")

func stripAnsi(s string) string { return ansiRe.ReplaceAllString(s, "") }

// A realistic full-name routing row: renderRoute shortens the names for display.
const sampleRow = "  default    gpt-5.6-terra:medium → gpt-5.6-luna:medium → claude-sonnet-5:medium → claude-haiku-4-5:medium"
const day int64 = 24 * 60 * 60

// labelWidth mirrors how renderRoute derives the role label (everything before
// the first model match) so tests assert against the real alignment column.
func labelWidth(row string) int {
	loc := modelRe.FindStringIndex(row)
	if loc == nil {
		return 0
	}
	return lipgloss.Width(row[:loc[0]])
}

// routeLines splits renderRoute output into physical lines, dropping the trailing
// newline the function appends.
func routeLines(out string) []string {
	return strings.Split(strings.TrimRight(out, "\n"), "\n")
}

// TestRenderRouteHangingIndent locks the bug fixed in atyrode/dotfiles#118: when a chain wraps,
// every continuation line must be indented to align under the first model (a
// hanging block), never flush-left.
func TestRenderRouteHangingIndent(t *testing.T) {
	lw := labelWidth(sampleRow)
	indent := strings.Repeat(" ", lw)
	// The sample chain is ~70 cols on one line; these widths force it to wrap.
	for _, width := range []int{40, 52, 64} {
		out := model{}.renderRoute([]string{sampleRow}, 1, availability{}, width)
		lines := routeLines(out)
		if len(lines) < 2 {
			t.Fatalf("width=%d: expected the chain to wrap onto multiple lines, got %d", width, len(lines))
		}
		for i, ln := range lines[1:] {
			// Continuation lines start with exactly the label-width of spaces,
			// then a (non-space) model — i.e. aligned under the first model.
			if !strings.HasPrefix(ln, indent) {
				t.Errorf("width=%d line %d not aligned under first model: %q", width, i+1, ln)
			}
			if lw < len(ln) && ln[lw] == ' ' {
				t.Errorf("width=%d line %d over-indented past the model column: %q", width, i+1, ln)
			}
		}
	}
}

// TestRenderRouteWidthInvariant: no rendered line exceeds the target width — the
// 2-col reserve for the trailing arrow must keep even break lines in bounds.
func TestRenderRouteWidthInvariant(t *testing.T) {
	for _, width := range []int{40, 56, 72, 100} {
		out := model{}.renderRoute([]string{sampleRow}, 1, availability{}, width)
		for i, ln := range routeLines(out) {
			if w := lipgloss.Width(ln); w > width {
				t.Errorf("width=%d: line %d overflows (%d cols): %q", width, i, w, ln)
			}
		}
	}
}

// TestRenderRouteLeadDepth: at depth 0 only the primary (first live) model shows.
func TestRenderRouteLeadDepth(t *testing.T) {
	out := model{}.renderRoute([]string{sampleRow}, 0, availability{}, 120)
	if lines := routeLines(out); len(lines) != 1 {
		t.Fatalf("lead depth should be a single line, got %d:\n%s", len(lines), out)
	}
	if !strings.Contains(out, "terra:medium") {
		t.Errorf("lead should show the primary model terra:medium: %q", out)
	}
	if strings.Contains(out, "luna:medium") {
		t.Errorf("lead depth must not show fallback models: %q", out)
	}
}

// TestRenderRoutePassThrough: a line with no models is emitted unchanged (modulo
// colourisation), not dropped.
func TestRenderRoutePassThrough(t *testing.T) {
	out := model{}.renderRoute([]string{"  advisor    (disabled)"}, 1, availability{}, 80)
	if !strings.Contains(out, "advisor") || !strings.Contains(out, "(disabled)") {
		t.Errorf("note line should pass through, got: %q", out)
	}
}

// TestParseFactsBucketColumn: the __models__ bucket column is optional — a
// catalog that declares no bucket for any model omits it entirely — so both row
// widths must parse, while anything short of the five numeric facts is dropped.
func TestParseFactsBucketColumn(t *testing.T) {
	facts := parseFacts([]string{
		"  gpt-5.6-luna 1 6 52.3 1.18 codex-main",
		"  gpt-5.6-terra 2.5 15 41 1.4",
		"  claude-mythos-5 5 25 30 2 claude-fable",
		"  truncated 1 2 3",
		"  unparseable 1 2 3 later codex-main",
	})
	if len(facts) != 3 {
		t.Fatalf("parsed %d rows, want 3: %v", len(facts), facts)
	}
	want := map[string]modelFact{
		"gpt-5.6-luna":    {1, 6, 52.3, 1.18, "codex-main", ""},
		"gpt-5.6-terra":   {2.5, 15, 41, 1.4, "", ""},
		"claude-mythos-5": {5, 25, 30, 2, "claude-fable", ""},
	}
	for id, w := range want {
		if got := facts[id]; got != w {
			t.Errorf("parseFacts[%q] = %+v, want %+v", id, got, w)
		}
	}
}

// TestBucketForPrefersCatalog: the catalog's bucket column beats the name guess.
// claude-mythos-5 sits in omp's catalog at the top rung's price and draws on the
// separate quota window the catalog names for it, but every substring arm in
// bucketOf reads it as plain claude-main — the routing preview would then strike
// models through against the wrong window.
func TestBucketForPrefersCatalog(t *testing.T) {
	m := model{facts: map[string]modelFact{
		"claude-mythos-5": {5, 25, 30, 2, "claude-fable", ""},
		"gpt-5.6-luna":    {1, 6, 52.3, 1.18, "", ""},
	}}
	if got := bucketOf("claude-mythos-5"); got != "claude-main" {
		t.Fatalf("guess baseline moved: bucketOf(claude-mythos-5) = %q", got)
	}
	if got := m.bucketFor("claude-mythos-5:high"); got != "claude-fable" {
		t.Errorf("catalog bucket ignored: bucketFor(claude-mythos-5:high) = %q", got)
	}
	// An undeclared bucket, and a model the catalog never mentions: both guess.
	if got := m.bucketFor("gpt-5.6-luna:low"); got != "codex-main" {
		t.Errorf("empty bucket must fall back to the guess, got %q", got)
	}
	// claude-fable-5 is an ordinary Anthropic model this fixture never mentions:
	// no provider entry declares a special bucket for it, so the guess must land
	// it on the provider's main window rather than invent a private one.
	if got := m.bucketFor("claude-fable-5:max"); got != "claude-main" {
		t.Errorf("unknown model must fall back to the provider's main bucket, got %q", got)
	}
	// The suggest box and the dial list ask about bare facet names, which are
	// never catalog ids. Spark is the only special tier left with a bucket of
	// its own, so it is the only bare name that resolves to one.
	if got := m.bucketFor("spark"); got != "codex-spark" {
		t.Errorf(`bucketFor("spark") = %q, want "codex-spark"`, got)
	}
}

func TestShortModel(t *testing.T) {
	cases := map[string]string{
		"gpt-5.6-terra":       "terra",
		"gpt-5.6-luna":        "luna",
		"gpt-5.6-sol":         "sol",
		"gpt-5.3-codex-spark": "spark",
		"claude-opus-5":       "opus",
		"claude-sonnet-5":     "sonnet",
		"claude-haiku-4-5":    "haiku",
		"claude-fable-5":      "fable",
		"gpt-5.4":             "gpt-5.4", // special-cased whole name
	}
	for in, want := range cases {
		if got := shortModel(in); got != want {
			t.Errorf("shortModel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLvl(t *testing.T) {
	cases := map[string]int{
		"minimal": 0, "low": 1, "medium": 2, "high": 3, "xhigh": 4, "max": 5,
		"": 5, "bogus": 5,
	}
	for in, want := range cases {
		if got := lvl(in); got != want {
			t.Errorf("lvl(%q) = %d, want %d", in, got, want)
		}
	}
}

// TestComboID pins the id format every catalog lookup goes through —
// <lane>_<mtier>_<thinking>_<sp|nosp> — and the one suppression left inside it:
// spark is a lane capability, so a lane whose pool-set excludes the spark
// provider's pool only ever had the "nosp" variant generated, whatever the dial
// says. The mtier segment is passed through verbatim, elite included, because
// visibleFacets has already narrowed the dial to the notches the lane serves;
// a fourth notch must not need a fourth code path here.
func TestComboID(t *testing.T) {
	cases := []struct {
		sel  map[string]string
		want string
	}{
		{map[string]string{"lane": "mixed", "model": "normal", "thinking": "medium", "spark": "on"}, "mixed_normal_medium_sp"},
		{map[string]string{"lane": "mixed", "model": "normal", "thinking": "medium", "spark": "off"}, "mixed_normal_medium_nosp"},
		{map[string]string{"lane": "gpt-only", "model": "fast", "thinking": "high", "spark": "on"}, "gpt-only_fast_high_sp"},
		// claude-only excludes the spark provider's pool: the dial reads on, the
		// catalog only carries the nosp id.
		{map[string]string{"lane": "claude-only", "model": "smart", "thinking": "low", "spark": "on"}, "claude-only_smart_low_nosp"},
		// elite is an ordinary ladder rung, carried like any other mtier.
		{map[string]string{"lane": "mixed", "model": "elite", "thinking": "max", "spark": "off"}, "mixed_elite_max_nosp"},
		{map[string]string{"lane": "claude-only", "model": "elite", "thinking": "xhigh", "spark": "on"}, "claude-only_elite_xhigh_nosp"},
	}
	for _, c := range cases {
		if got := comboID(c.sel); got != c.want {
			t.Errorf("comboID(%v) = %q, want %q", c.sel, got, c.want)
		}
	}
}

// TestDefaultSelValid guards the reset-to-defaults key (atyrode/dotfiles#119) against facet
// drift: every default must name a real facet and a value that facet offers,
// every facet must be seeded exactly once, and the model default is smart (atyrode/dotfiles#178).
func TestDefaultSelValid(t *testing.T) {
	facets := facetDefs(map[string]string{})
	byKey := map[string][]string{}
	for _, f := range facets {
		byKey[f.key] = f.values
	}
	def := defaultSel()
	if len(def) != len(facets) {
		t.Errorf("defaultSel has %d keys, facetDefs has %d — every facet must be seeded", len(def), len(facets))
	}
	for k, v := range def {
		values, ok := byKey[k]
		if !ok {
			t.Errorf("defaultSel key %q is not a known facet", k)
			continue
		}
		found := false
		for _, allowed := range values {
			if allowed == v {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("defaultSel[%q]=%q is not a valid value (allowed: %v)", k, v, values)
		}
	}
	if def["model"] != "smart" {
		t.Errorf(`defaultSel["model"] = %q, want "smart"`, def["model"])
	}
}

// TestEliteNotchVisibility is the direct successor to the retired main-facet
// test: the dial value whose visibility depends on the lane is no longer a facet
// of its own but the model dial's top notch. Pool ladders are variable-depth, so
// a lane whose pools all stop at tier 3 has no elite combo written for it (it
// would be byte-identical to smart) — offering the notch there would point the
// TUI at an id the catalog does not contain, which is exactly the class of bug
// the old fable/main gating existed to prevent.
func TestEliteNotchVisibility(t *testing.T) {
	m := model{facets: facetDefs(map[string]string{}), sel: defaultSel(),
		generated: map[string][]string{
			// The claude-led pool-set reaches tier 4; the pure gpt lane does not.
			"claude-only_smart_medium_nosp": nil,
			"claude-only_elite_medium_nosp": nil,
			"mixed_smart_medium_nosp":       nil,
			"mixed_elite_medium_nosp":       nil,
			"gpt-only_fast_medium_nosp":     nil,
			"gpt-only_smart_medium_nosp":    nil,
			"__models__":                    nil,
		}}
	m.applyCatalog()

	notches := func(lane string) []string {
		m.sel["lane"] = lane
		for _, f := range m.visibleFacets() {
			if f.key == "model" {
				return f.values
			}
		}
		return nil
	}
	for _, lane := range []string{"claude-only", "mixed"} {
		if got := notches(lane); !slices.Contains(got, "elite") {
			t.Errorf("lane %q serves an elite combo but the dial hides the notch: %v", lane, got)
		}
	}
	if got := notches("gpt-only"); slices.Contains(got, "elite") {
		t.Errorf("gpt-only carries no elite combo — the dial must not offer the notch: %v", got)
	}
	// The narrowing is exactly the served set in ladder order, never a padded or
	// reordered list: the dial's order is what left/right mean.
	if got := notches("gpt-only"); !reflect.DeepEqual(got, []string{"fast", "smart"}) {
		t.Errorf("gpt-only notches = %v, want the served set in ladder order [fast smart]", got)
	}
	// A lane the catalog never mentions leaves the dial whole, exactly as it
	// behaved before any catalog was applied.
	if got := notches("ds-only"); !reflect.DeepEqual(got, []string{"fast", "normal", "smart", "elite"}) {
		t.Errorf("an unknown lane must not narrow the dial: %v", got)
	}
}

// TestCatalogCapabilityGatesDials: spark must never point at a combo the catalog
// cannot serve. A models file with no tier-0 model generates zero _sp_ ids, so
// the shipped default (spark on) would open the TUI on a combo that was never
// written. The segment check must not be fooled by the "nosp" ids that spell the
// very substring it looks for. The same catalog read also collects m.mtiers —
// the per-lane served notches of the model dial — because with variable-depth
// ladders the dial's own values are catalog data, not a constant.
func TestCatalogCapabilityGatesDials(t *testing.T) {
	visible := func(m model) map[string]bool {
		out := map[string]bool{}
		for _, f := range m.visibleFacets() {
			out[f.key] = true
		}
		return out
	}

	full := model{facets: facetDefs(map[string]string{}), sel: defaultSel(),
		generated: map[string][]string{
			"mixed_smart_medium_sp":   nil,
			"mixed_smart_medium_nosp": nil,
			"mixed_elite_medium_sp":   nil,
			"mixed_elite_medium_nosp": nil,
		}}
	full.applyCatalog()
	if full.noSpark {
		t.Fatalf("a catalog serving spark disabled the dial: noSpark=%v", full.noSpark)
	}
	if full.sel["spark"] != "on" {
		t.Errorf("spark must survive a catalog that serves it, got %q", full.sel["spark"])
	}
	if got := full.mtiers["mixed"]; !reflect.DeepEqual(got, []string{"smart", "elite"}) {
		t.Errorf(`mtiers["mixed"] = %v, want the served notches in ladder order [smart elite]`, got)
	}

	bare := model{facets: facetDefs(map[string]string{}), sel: defaultSel(),
		generated: map[string][]string{
			"mixed_normal_medium_nosp": nil,
			"mixed_smart_medium_nosp":  nil,
			"gpt-only_fast_low_nosp":   nil,
			"__models__":               nil,
		}}
	bare.applyCatalog()
	if !bare.noSpark {
		t.Fatalf(`"nosp" ids read as spark capability: noSpark=%v`, bare.noSpark)
	}
	if got := bare.sel["spark"]; got != "off" {
		t.Errorf("spark stayed %q on a catalog that cannot serve it, want off", got)
	}
	if v := visible(bare); v["spark"] {
		t.Errorf("the unusable spark dial stayed on screen: %v", v)
	}
	// Collected per lane, in ladder order, and never a notch the lane has no
	// combo for: a shallower lane must not inherit a deeper one's notches.
	for lane, want := range map[string][]string{
		"mixed":    {"normal", "smart"},
		"gpt-only": {"fast"},
	} {
		if got := bare.mtiers[lane]; !reflect.DeepEqual(got, want) {
			t.Errorf("mtiers[%q] = %v, want %v", lane, got, want)
		}
	}

	// The reset key restores defaults, which assume a full catalog.
	reset, _ := bare.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'d'}})
	if got := reset.(model).sel["spark"]; got != "off" {
		t.Errorf("d reset resurrected the dead spark dial: %q", got)
	}

	// No catalog at all is the onboarding shell, not a restriction: a nil mtiers
	// map has to leave every ladder notch reachable.
	empty := model{facets: facetDefs(map[string]string{}), sel: defaultSel()}
	empty.applyCatalog()
	if empty.noSpark || empty.sel["spark"] != "on" || empty.mtiers != nil {
		t.Errorf("an unread catalog must leave every dial alone: noSpark=%v spark=%q mtiers=%v",
			empty.noSpark, empty.sel["spark"], empty.mtiers)
	}
}

// TestCycleFacetClampsModelToLaneLadder replaces the retired fable/main
// sub-setting test: the cross-dial dependency that survives the refactor is the
// model ladder's. Pool ladders are variable-depth, so turning the lead onto a
// lane whose pools stop at tier 3 leaves the dial parked on an "elite" notch that
// lane has no combo for — and Enter would then refuse to launch the very state
// the dial is displaying.
func TestCycleFacetClampsModelToLaneLadder(t *testing.T) {
	m := &model{facets: facetDefs(map[string]string{}), sel: defaultSel(),
		generated: map[string][]string{
			"claude-only_smart_medium_nosp": nil,
			"claude-only_elite_medium_nosp": nil,
			"gpt-only_fast_medium_nosp":     nil,
			"gpt-only_smart_medium_nosp":    nil,
			"__models__":                    nil,
		}}
	m.applyCatalog()
	m.sel["lane"], m.sel["model"] = "claude-only", "elite"
	m.visibleFacets() // sync the derived lead/blend halves from lane
	m.fcur = 0        // the lead row
	m.cycleFacet(-1)  // claude → gpt (lead order is catalog order)
	if m.sel["lane"] != "gpt-only" {
		t.Fatalf("cycle should have landed on gpt-only, got %q", m.sel["lane"])
	}
	if m.sel["model"] != "smart" {
		t.Errorf("model dial stayed on %q, a notch gpt-only never generated — want a snap DOWN to smart", m.sel["model"])
	}
	if _, ok := m.generated[comboID(m.sel)]; !ok {
		t.Errorf("the displayed dial state resolves to no catalog block: %s", comboID(m.sel))
	}
}

// TestCycleFacetClampsAtEndpoints: the lead dial (row 0) clamps rather than
// wraps at either end — mixed is first, the last pool's lead is last.
func TestCycleFacetClampsAtEndpoints(t *testing.T) {
	m := &model{facets: facetDefs(map[string]string{}), sel: defaultSel()}
	m.fcur = 0 // lead

	m.sel["lane"] = "mixed" // lead = mixed, the dial's first value
	m.cycleFacet(-1)
	if got := m.sel["lane"]; got != "mixed" {
		t.Fatalf("left at first option wrapped to %q", got)
	}

	m.sel["lane"] = "claude-led" // lead = claude, the dial's last value
	m.cycleFacet(1)
	if got := m.sel["lane"]; got != "claude-led" {
		t.Fatalf("right at last option wrapped to %q", got)
	}
}

// TestLaunchKeys locks the launch decision: Enter always launches the generated
// profile for the current facets — even at defaults with no prompt — while m
// requests omp-managed on the managed defaults with no generated overlay.
func TestLaunchKeys(t *testing.T) {
	rows := []string{
		"    default    gpt-5.6-sol:high → gpt-5.6-terra:medium",
		"  ● task       gpt-5.6-terra:medium",
	}
	base := model{
		sel:       defaultSel(),
		generated: map[string][]string{comboID(defaultSel()): rows},
	}

	next, _ := base.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m := next.(model)
	if m.genConfig == "" || m.launchManaged {
		t.Errorf("Enter at defaults must launch a generated profile, got genConfig=%q launchManaged=%v", m.genConfig, m.launchManaged)
	}

	next, _ = base.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'m'}})
	m = next.(model)
	if !m.launchManaged || m.genConfig != "" {
		t.Errorf("m must request the managed defaults with no overlay, got genConfig=%q launchManaged=%v", m.genConfig, m.launchManaged)
	}
}

func TestWorktreeToggleRequiresRepo(t *testing.T) {
	keys.Worktree.SetEnabled(false)
	t.Cleanup(func() { keys.Worktree.SetEnabled(true) })

	m := layoutModel()
	m, _ = press(t, m, "w")
	if m.worktreeMode {
		t.Fatal("w enabled worktree mode before the repository probe succeeded")
	}

	next, _ := m.Update(gitRepoMsg{root: "/r", ok: true})
	m = next.(model)
	m, _ = press(t, m, "w")
	if !m.worktreeMode {
		t.Fatal("w did not enable worktree mode after a repository probe")
	}
	if head := stripAnsi(m.sectionHead()); !strings.Contains(head, "worktree on") {
		t.Fatalf("enabled worktree cue missing from section head: %q", head)
	}

	linked := layoutModel()
	next, _ = linked.Update(gitRepoMsg{root: "/linked", linked: true, ok: true})
	linked = next.(model)
	if linked.gitRoot != "" {
		t.Fatalf("linked worktree enabled nested worktree launches from %q", linked.gitRoot)
	}
}

// TestEnterRefusesMissingCombo: Enter must not launch facets the catalog carries
// no block for. genConfigYAML walks a nil block and emits an overlay whose
// modelRoles map is empty, which would hand omp a session with no routing at
// all — while the preview says "no profile for this combination".
func TestEnterRefusesMissingCombo(t *testing.T) {
	m := model{sel: defaultSel(), generated: map[string][]string{}}
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	got := next.(model)
	if got.genConfig != "" || cmd != nil {
		t.Fatalf("Enter launched a combo with no generated block: genConfig=%q quit=%v",
			got.genConfig, cmd != nil)
	}
}

// TestGenConfigYAMLAgentOverrides locks the atyrode/dotfiles#173 fix: every ●-marked
// agent-backed role in the generated block is mirrored into
// task.agentModelOverrides (so spawned agents follow the generated profile),
// while unmarked roles and the advisor never are. Prompt-focused keystrokes
// never reach the launch keybinds — clikit's promptbox owns that routing and
// its tests live in cli-kit.
func TestGenConfigYAMLAgentOverrides(t *testing.T) {
	rows := []string{
		"    default    gpt-5.6-sol:high",
		"    plan       claude-fable-5:xhigh",
		"  ● designer   claude-fable-5:xhigh → claude-sonnet-5:high",
		"  ● librarian  gpt-5.6-sol:high",
		"  ● reviewer   claude-fable-5:xhigh",
		"  ● sonic      gpt-5.6-luna:minimal",
		"  ● task       gpt-5.6-terra:medium",
		"    smol       gpt-5.6-luna:low",
	}
	m := model{
		sel:       defaultSel(),
		generated: map[string][]string{comboID(defaultSel()): rows},
	}
	m.sel["advisor"] = "off"
	got := m.genConfigYAML()

	// The override block is emitted in row order with a fixed shape; assert it
	// verbatim so any drift in keys, values, or nesting fails loudly.
	want := "task:\n  agentModelOverrides:\n" +
		"    designer: anthropic/claude-fable-5:xhigh\n" +
		"    librarian: openai-codex/gpt-5.6-sol:high\n" +
		"    reviewer: anthropic/claude-fable-5:xhigh\n" +
		"    sonic: openai-codex/gpt-5.6-luna:minimal\n" +
		"    task: openai-codex/gpt-5.6-terra:medium\n" +
		"defaultThinkingLevel:"
	if !strings.Contains(got, want) {
		t.Errorf("generated config must mirror exactly the ● roles into agentModelOverrides, got:\n%s", got)
	}
	// Override entries are 4-space-indented; assert no non-agent role sneaks in.
	for _, role := range []string{"plan", "smol", "default", "advisor"} {
		if strings.Contains(got, "    "+role+": ") {
			t.Errorf("non-agent role %q must not be overridden, got:\n%s", role, got)
		}
	}
}

// TestDefaultGlyphs pins all three built-in facet glyph tables. The nerd
// literals are invisible in most editors — an edit once wiped them all to empty
// strings without anything failing, which is why each codepoint is asserted
// explicitly. The unicode and ascii fallbacks are held to the SAME key set for
// the same reason from the other direction: resolveGlyphs picks between them at
// startup, and a table missing one key renders that dial with an empty glyph
// slot, which shifts every value column on the row.
func TestDefaultGlyphs(t *testing.T) {
	want := map[string]rune{
		"runtime": 0xf108, "local": 0xf109, "lane": 0xf127, "model": 0xf085,
		"thinking": 0xf0eb, "advisor": 0xf14e,
		"spark": 0xf135, "fast": 0xf0e7,
	}
	tables := map[string]map[string]string{
		"nerd": defaultGlyphs(), "unicode": unicodeGlyphs(), "ascii": asciiGlyphs(),
	}
	for name, g := range tables {
		if len(g) != len(want) {
			t.Errorf("%s table has %d entries, want %d: %v", name, len(g), len(want), g)
		}
		for key := range want {
			if v, ok := g[key]; !ok || v == "" {
				t.Errorf("%s table has no glyph for %q (present=%v, value=%q)", name, key, ok, v)
			}
		}
		for key := range g {
			if _, ok := want[key]; !ok {
				t.Errorf("%s table defines a glyph for %q, which is not a dial", name, key)
			}
		}
	}

	g := defaultGlyphs()
	dials := append([]facet{runtimeFacet(g["runtime"], nil), localFacet(g[localFacetKey], localLane{})}, facetDefs(g)...)
	for _, f := range dials {
		// Every dial the TUI can render must find a glyph in every table.
		for name, table := range tables {
			if table[f.key] == "" {
				t.Errorf("%s table has no glyph for the %q dial", name, f.key)
			}
		}
		// Only the nerd table is a single PUA rune; the ascii tags are two cells
		// wide by design, exactly the width the glyph slot reserves.
		r := []rune(g[f.key])
		if len(r) != 1 {
			t.Errorf("nerd glyph for %q is %d runes, want exactly 1", f.key, len(r))
			continue
		}
		if r[0] != want[f.key] {
			t.Errorf("nerd glyph for %q = U+%04X, want U+%04X", f.key, r[0], want[f.key])
		}
	}
}

// TestGenLinesChildRow: the tabulated child row still renders as a child. The
// fable-as-main dial that used to own this shape is gone; the lane dial's blend
// half is the only sub-setting left, and it must keep the exact same rendering —
// the 2-space pointer slot plus an L-shaped tree connector before the glyph,
// which is what makes the parent/child link explicit, like the `tree` CLI — with
// no flavor text, because the old explainer wrapped on narrow panes and broke
// the layout.
func TestGenLinesChildRow(t *testing.T) {
	m := model{facets: facetDefs(defaultGlyphs()), sel: defaultSel()}
	m.sel["lane"] = "gpt-led" // mixed has no blend to pick
	lines, _ := m.genLines()
	var childRow string
	for _, ln := range lines {
		p := stripAnsi(ln)
		if strings.Contains(p, "blend") {
			childRow = p
		}
	}
	if childRow == "" {
		t.Fatalf("no blend row on a non-mixed lead:\n%s", stripAnsi(strings.Join(lines, "\n")))
	}
	if !strings.HasPrefix(childRow, "  └ ") {
		t.Errorf("child row must carry the └ connector, got %q", childRow)
	}
	// mixed spans every pool, so there is no blend to choose: the child row
	// disappears entirely rather than rendering a one-value dial.
	m.sel["lane"] = "mixed"
	lines, _ = m.genLines()
	for _, ln := range lines {
		if p := stripAnsi(ln); strings.Contains(p, "blend") {
			t.Errorf("mixed must render no blend child, got %q", p)
		}
	}
}

// TestAdvisorChainFlip locks the advisor's opposite-provider rule: the second
// opinion never sits on the pool that leads the work, because a same-provider
// lead and advisor reintroduce the tunnel-vision risk the advisor exists to cut.
// Only the pure lanes keep their own provider — there is no other pool in the
// lane to cross to. The fable-as-main flip this test also used to cover is gone
// with the dial: the top Anthropic rung is an ordinary ladder notch now and
// moves no lead, so the lane is the whole input.
func TestAdvisorChainFlip(t *testing.T) {
	adv := map[string][]string{
		"glance/gpt":    {"gpt-5.6-terra:low"},
		"glance/claude": {"claude-quartz-5:low"},
	}
	cases := []struct {
		lane    string
		wantCtx string
	}{
		{"mixed", "claude"},
		{"gpt-led", "claude"},
		{"claude-led", "gpt"},
		{"gpt-only", "gpt"},
		{"claude-only", "claude"},
	}
	for _, c := range cases {
		m := model{advisors: adv, sel: defaultSel()}
		m.sel["lane"] = c.lane
		got := m.advisorChain("glance")
		want := adv["glance/"+c.wantCtx]
		if len(got) == 0 || got[0] != want[0] {
			t.Errorf("lane=%s: advisor chain = %v, want %s (%v)", c.lane, got, c.wantCtx, want)
		}
	}
}

// TestApplyAdvisorCrossesProvider: the crossed chain must flow through
// applyAdvisor — the single seam feeding the preview, the cost/speed meters, and
// the launched config YAML — not just the raw table lookup. A Claude-led lane
// crosses to GPT, and the row is synthesised even when the baked block carries no
// advisor row of its own to replace.
func TestApplyAdvisorCrossesProvider(t *testing.T) {
	m := model{
		advisors: map[string][]string{
			"glance/gpt":    {"gpt-5.6-terra:low"},
			"glance/claude": {"claude-quartz-5:low"},
		},
		sel: defaultSel(),
	}
	m.sel["lane"] = "claude-led"
	rows := m.applyAdvisor([]string{"    default    claude-fable-5:high"}, "glance")
	joined := strings.Join(rows, "\n")
	if !strings.Contains(joined, "advisor    gpt-5.6-terra:low") {
		t.Errorf("a Claude-led lane must synthesise a GPT advisor row, got:\n%s", joined)
	}
}

// TestPreviewColumn locks the Routing section's shape: the title row carries
// the section-local collapse cue (p · hide), the DISPLAY cues are pinned to the
// section's LAST row — bottom chrome under the viewport, where the chains they
// toggle end, no longer top chrome — worded as show/hide toggles so it is clear
// neither changes what is launched, and no baked settings-summary line reaches
// the preview (the dials are visible on the left).
func TestPreviewColumn(t *testing.T) {
	id := comboID(defaultSel())
	m := model{
		generated: map[string][]string{id: {
			"  thinking medium · fallback on · advisor on",
			"    default    gpt-5.6-terra:medium → gpt-5.6-luna:medium",
			"  ● task       gpt-5.6-terra:medium → gpt-5.6-luna:medium",
		}},
		sel: defaultSel(),
		rdy: true,
	}
	m.vp = viewport.New(60, 6)
	m.syncPreview()
	plain := stripAnsi(m.previewColumn())
	if strings.Contains(plain, "fallback on") || strings.Contains(plain, "thinking medium ·") {
		t.Errorf("the baked settings-summary line must not reach the preview, got:\n%s", plain)
	}
	rows := strings.Split(plain, "\n")
	if !strings.Contains(rows[0], "routing") || !strings.Contains(rows[0], "p · hide") {
		t.Errorf("title row must carry the routing pill and its local collapse cue, got %q", rows[0])
	}
	if strings.Contains(rows[0], "fallback") || strings.Contains(rows[1], "fallback") {
		t.Errorf("the fallback cue must leave the top chrome, got %q / %q", rows[0], rows[1])
	}
	// Both display toggles live on that one bottom row: f for the fallback
	// chains, n for the catalog's full model ids. Each is worded for what the
	// keypress will DO, which is why both flip with the state they read.
	if tail := strings.TrimSpace(rows[len(rows)-1]); tail != "f · show fallback chains   n · full ids" {
		t.Errorf("the display cues must be pinned to the section's last row, got %q", tail)
	}
	m.depth = 1
	m.showFullIDs = true
	if plain := stripAnsi(m.previewColumn()); !strings.Contains(plain, "f · hide fallback chains") ||
		!strings.Contains(plain, "n · short ids") {
		t.Errorf("the cues must invert with the state they toggle, got:\n%s", plain)
	}
}

// ── responsive layout (atyrode/dotfiles#197) ─────────────────────────────────────────────────

// layoutModel builds a fully-populated model the way main() does — real facets,
// a generated routing block, and usage windows for both providers — so layout
// tests exercise the actual compositions rather than skeleton fixtures.
func layoutModel() model {
	glyphs := defaultGlyphs()
	id := comboID(defaultSel())
	rows := []string{
		"  thinking medium · fallback on · advisor on",
		"    default    gpt-5.6-terra:medium → gpt-5.6-luna:medium → claude-sonnet-5:medium",
		"  ● task       gpt-5.6-terra:medium → gpt-5.6-luna:medium → claude-sonnet-5:medium",
		"  ● scout      gpt-5.6-luna:low → claude-haiku-4-5:low",
		"    advisor    claude-opus-5:high",
		"    commit     gpt-5.6-luna:minimal",
	}
	return model{
		generated: map[string][]string{id: rows},
		avail: availability{
			ok:         true,
			accountsOK: true,
			bucket:     map[string]string{},
			reset:      map[string]int64{},
			accounts: map[string][]account{
				"openai-codex": {{Provider: "openai-codex", IdentityKey: "codex", Email: "codex@example.test"}},
				"anthropic":    {{Provider: "anthropic", IdentityKey: "claude", Email: "claude@example.test"}},
			},
			accountUsage: map[accountKey][]usageWin{
				{Provider: "openai-codex", IdentityKey: "codex"}: {
					{label: "5 hours", pct: 12, secs: 3 * 3600, dur: 5 * 3600, prov: "openai-codex"},
					{label: "7 days", pct: 33, secs: 6 * day, dur: 7 * day, prov: "openai-codex"},
				},
				{Provider: "anthropic", IdentityKey: "claude"}: {
					{label: "5 hours", pct: 55, secs: 2 * 3600, dur: 5 * 3600, prov: "anthropic"},
					{label: "7 days", pct: 61, secs: 5 * day, dur: 7 * day, prov: "anthropic"},
				},
			},
			accountCredits: map[accountKey]resetCredits{},
			wins: []usageWin{
				{label: "5 hours", pct: 12, secs: 3 * 3600, dur: 5 * 3600, prov: "openai-codex"},
				{label: "7 days", pct: 33, secs: 6 * day, dur: 7 * day, prov: "openai-codex"},
				{label: "5 hours", pct: 55, secs: 2 * 3600, dur: 5 * 3600, prov: "anthropic"},
				{label: "7 days", pct: 61, secs: 5 * day, dur: 7 * day, prov: "anthropic"},
			},
		},
		broker:      brokerConfig{URL: "http://broker.test", Token: "token"},
		spin:        spinner.New(),
		help:        clikit.NewHelp(),
		glyphs:      glyphs,
		facets:      facetDefs(glyphs),
		sel:         defaultSel(),
		nextRefresh: time.Now().Add(refreshEvery),
	}
}

// resize drives a live tea.WindowSizeMsg through Update and asserts the one
// hard rule of atyrode/dotfiles#197 resizing: it must never produce a command (no fetches).
func resize(t *testing.T, m model, w, h int) model {
	t.Helper()
	nm, cmd := m.Update(tea.WindowSizeMsg{Width: w, Height: h})
	if cmd != nil {
		t.Fatalf("resize to %dx%d produced a command — resizes must never trigger fetches", w, h)
	}
	return nm.(model)
}

type termSize struct{ w, h int }

// layoutSizes derives representative wide/medium/narrow/short terminal sizes
// from the model's own measured breakpoints (terminal cells, never pixels), so
// the tests keep tracking content needs if the rendered minima ever grow.
func layoutSizes(t *testing.T, m model) (wide, medium, narrow, short termSize) {
	t.Helper()
	wideW := m.genRowWidth() + routingMinW
	if m.mediumMinW()+6 >= wideW {
		t.Fatalf("fixture drift: medium width %d overlaps the wide threshold %d", m.mediumMinW()+6, wideW)
	}
	wide = termSize{wideW + 20, 40}
	medium = termSize{m.mediumMinW() + 6, 40}
	narrow = termSize{m.mediumMinW() - 10, 40}
	short = termSize{wideW + 20, 10}
	return
}

// assertLayoutInvariants checks the frame guarantees every composition must
// hold: no line wider than the terminal (it would auto-wrap), total height in
// bounds, full-width rules never broken mid-line, and the help footer pinned
// to the very last row.
func assertLayoutInvariants(t *testing.T, m model, label string) {
	t.Helper()
	view := stripAnsi(m.View())
	lines := strings.Split(view, "\n")
	if got := len(lines); got > m.h {
		t.Errorf("%s: view is %d rows for a %d-row terminal", label, got, m.h)
	}
	for i, l := range lines {
		if w := lipgloss.Width(l); w > m.w {
			t.Errorf("%s: line %d is %d cells wide (terminal %d) — would auto-wrap: %q", label, i, w, m.w, l)
		}
		if strings.HasPrefix(l, "─") { // horizontal rules span exactly the terminal
			if strings.TrimRight(l, " ") != strings.Repeat("─", m.w) {
				t.Errorf("%s: rule on line %d does not span the full width: %q", label, i, l)
			}
		}
	}
	if last := lines[len(lines)-1]; !strings.Contains(last, "move") {
		t.Errorf("%s: help footer not pinned to the last row: %q", label, last)
	}
}

// lineIndex returns the first view line containing every needle, or -1.
func lineIndex(lines []string, needles ...string) int {
	for i, l := range lines {
		ok := true
		for _, n := range needles {
			if !strings.Contains(l, n) {
				ok = false
				break
			}
		}
		if ok {
			return i
		}
	}
	return -1
}

// TestResponsiveCompositions locks the atyrode/dotfiles#197 hierarchy: wide keeps Generator and
// Routing side by side over a full-width Usage band (provider groups side by
// side); medium is generator-dominant — the list full width on top, Routing and
// Usage sharing a secondary row, Usage's provider groups stacked vertically;
// narrow and short show one usable panel at a time, Generator first, instead of
// compressing every section.
func TestResponsiveCompositions(t *testing.T) {
	m := layoutModel()
	wide, medium, narrow, short := layoutSizes(t, m)

	m = resize(t, m, wide.w, wide.h)
	if m.mode() != modeSplit {
		t.Fatalf("wide %dx%d: mode = %d, want split", wide.w, wide.h, m.mode())
	}
	lines := strings.Split(stripAnsi(m.View()), "\n")
	if lineIndex(lines, "generator", "routing") < 0 {
		t.Errorf("wide: generator and routing pills must share a row:\n%s", strings.Join(lines, "\n"))
	}
	sideBySide := false
	for _, l := range lines {
		if strings.Count(l, "% used") > 1 {
			sideBySide = true
		}
	}
	if !sideBySide {
		t.Errorf("wide: usage provider groups must sit side by side in the bottom band:\n%s", strings.Join(lines, "\n"))
	}
	assertLayoutInvariants(t, m, "wide")

	m = resize(t, m, medium.w, medium.h)
	if m.mode() != modeMedium {
		t.Fatalf("medium %dx%d: mode = %d, want medium", medium.w, medium.h, m.mode())
	}
	lines = strings.Split(stripAnsi(m.View()), "\n")
	gen := lineIndex(lines, "generator")
	sec := lineIndex(lines, "routing", "usage")
	launch := lineIndex(lines, "⏎ launch")
	if gen < 0 || sec < 0 || launch < 0 {
		t.Fatalf("medium: missing generator (%d), secondary row (%d), or launch footer (%d):\n%s", gen, sec, launch, strings.Join(lines, "\n"))
	}
	if lineIndex(lines, "generator", "routing") >= 0 {
		t.Errorf("medium: generator must own its full-width row, not share it with routing")
	}
	if !(gen < launch && launch < sec) {
		t.Errorf("medium: want generator (%d) over its launch footer (%d) over the routing+usage row (%d)", gen, launch, sec)
	}
	for i, l := range lines {
		if strings.Count(l, "% used") > 1 {
			t.Errorf("medium: usage provider groups must stack vertically, found side-by-side row %d: %q", i, l)
		}
	}
	if lineIndex(lines, "% used") < 0 {
		t.Errorf("medium: usage rows must be visible in the secondary column")
	}
	baseGenH, baseSecH := m.mediumSplit(m.contentH())
	if want := m.secondaryMinH(); baseSecH != want {
		t.Errorf("medium: secondary row height = %d, want measured minimum %d", baseSecH, want)
	}
	tall := resize(t, m, medium.w, medium.h+8)
	tallGenH, tallSecH := tall.mediumSplit(tall.contentH())
	if tallSecH != baseSecH {
		t.Errorf("tall medium: secondary row grew from %d to %d instead of staying content-sized", baseSecH, tallSecH)
	}
	if tallGenH != baseGenH+8 {
		t.Errorf("tall medium: generator grew from %d to %d, want %d", baseGenH, tallGenH, baseGenH+8)
	}
	assertLayoutInvariants(t, m, "medium")

	m = resize(t, m, narrow.w, narrow.h)
	if m.mode() != modeCollapsed {
		t.Fatalf("narrow %dx%d: mode = %d, want collapsed", narrow.w, narrow.h, m.mode())
	}
	lines = strings.Split(stripAnsi(m.View()), "\n")
	if lineIndex(lines, "generator") < 0 {
		t.Errorf("narrow: the generator must stay usable")
	}
	// The shed routing SECTION (its p · hide title chrome) must be gone; the
	// compact footer instead carries the recovery cue.
	if lineIndex(lines, "p · hide") >= 0 || lineIndex(lines, "% used") >= 0 {
		t.Errorf("narrow: secondary sections must be shed, not compressed:\n%s", strings.Join(lines, "\n"))
	}
	if lineIndex(lines, "show routing") < 0 {
		t.Errorf("narrow: the compact footer must offer the routing recovery cue:\n%s", strings.Join(lines, "\n"))
	}
	assertLayoutInvariants(t, m, "narrow")

	// ‹p› swaps to the routing panel — one full panel at a time.
	nm, _ := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("p")})
	m = nm.(model)
	lines = strings.Split(stripAnsi(m.View()), "\n")
	if lineIndex(lines, "routing", "p · hide") < 0 || lineIndex(lines, "generator") >= 0 {
		t.Errorf("narrow+p: want the routing panel full width instead of the generator:\n%s", strings.Join(lines, "\n"))
	}
	nm, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("p")})
	m = nm.(model)

	m = resize(t, m, short.w, short.h)
	if m.mode() != modeCollapsed {
		t.Fatalf("short %dx%d: mode = %d, want collapsed", short.w, short.h, m.mode())
	}
	lines = strings.Split(stripAnsi(m.View()), "\n")
	if lineIndex(lines, "generator") < 0 {
		t.Errorf("short: the generator must stay usable")
	}
	if lineIndex(lines, "% used") >= 0 {
		t.Errorf("short: the usage band must be shed to preserve generator rows")
	}
	assertLayoutInvariants(t, m, "short")
}

// TestModeThresholdEdges locks the exact measured breakpoints: one cell or row
// under a threshold flips the composition immediately on the resize itself —
// no extra keypress, tick, or second message.
func TestModeThresholdEdges(t *testing.T) {
	m := layoutModel()
	wideW := m.genRowWidth() + routingMinW

	m = resize(t, m, wideW, 40)
	if m.mode() != modeSplit {
		t.Fatalf("at the wide width threshold: mode = %d, want split", m.mode())
	}
	m = resize(t, m, wideW-1, 40)
	if m.mode() != modeMedium {
		t.Fatalf("one cell under the wide threshold: mode = %d, want medium", m.mode())
	}
	m = resize(t, m, wideW, 40)
	if m.mode() != modeSplit {
		t.Fatalf("back across the wide threshold: mode = %d, want split", m.mode())
	}

	hEdge := m.wideMinH()
	m = resize(t, m, wideW, hEdge)
	if m.mode() != modeSplit {
		t.Fatalf("at the wide height threshold %d: mode = %d, want split", hEdge, m.mode())
	}
	m = resize(t, m, wideW, hEdge-1)
	if m.mode() == modeSplit {
		t.Fatalf("one row under the wide height threshold %d must leave the split", hEdge)
	}

	mediumW := m.mediumMinW() + 6
	m = resize(t, m, mediumW, 40)
	if m.mode() != modeMedium {
		t.Fatalf("medium width %d: mode = %d, want medium", mediumW, m.mode())
	}
	mEdge := m.mediumMinH()
	m = resize(t, m, mediumW, mEdge)
	if m.mode() != modeMedium {
		t.Fatalf("at the medium height threshold %d: mode = %d, want medium", mEdge, m.mode())
	}
	m = resize(t, m, mediumW, mEdge-1)
	if m.mode() != modeCollapsed {
		t.Fatalf("one row under the medium height threshold %d: mode = %d, want collapsed", mEdge, m.mode())
	}
	m = resize(t, m, m.mediumMinW()-1, 40)
	if m.mode() != modeCollapsed {
		t.Fatalf("one cell under the medium width threshold: mode = %d, want collapsed", m.mode())
	}
}

// TestRepeatedResizeCrossingsPreserveState resizes back and forth across every
// threshold repeatedly and asserts the whole interactive state — selection,
// cursor, depth, collapse, auth, usage fetch identity — rides along untouched,
// and that the routing viewport offset always stays clamped to valid content.
func TestRepeatedResizeCrossingsPreserveState(t *testing.T) {
	m := layoutModel()
	wide, medium, narrow, short := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)

	m.fcur = 2
	m.cycleFacet(1) // thinking: medium → high (facet semantics untouched)
	m.depth = 1
	m.syncPreview()
	wantSel := map[string]string{}
	for k, v := range m.sel {
		wantSel[k] = v
	}
	wantNext := m.nextRefresh

	steps := []struct {
		termSize
		mode int
	}{
		{medium, modeMedium},
		{narrow, modeCollapsed},
		{short, modeCollapsed},
		{medium, modeMedium},
		{wide, modeSplit},
		{narrow, modeCollapsed},
		{wide, modeSplit},
	}
	for round := range 3 {
		for _, s := range steps {
			m = resize(t, m, s.w, s.h)
			label := fmt.Sprintf("round %d, %dx%d", round, s.w, s.h)
			if m.mode() != s.mode {
				t.Fatalf("%s: mode = %d, want %d immediately after the resize", label, m.mode(), s.mode)
			}
			if m.fcur != 2 || m.depth != 1 || m.collapse || m.showResult {
				t.Fatalf("%s: cursor/depth/collapse state mutated: fcur=%d depth=%d collapse=%v showResult=%v", label, m.fcur, m.depth, m.collapse, m.showResult)
			}
			if !reflect.DeepEqual(m.sel, wantSel) {
				t.Fatalf("%s: facet selection mutated: %v", label, m.sel)
			}
			if m.fetching || !m.nextRefresh.Equal(wantNext) {
				t.Fatalf("%s: usage fetch state mutated: fetching=%v nextRefresh moved=%v", label, m.fetching, !m.nextRefresh.Equal(wantNext))
			}
			if m.broker.URL != "http://broker.test" {
				t.Fatalf("%s: central broker mutated: %q", label, m.broker.URL)
			}
			maxOff := m.vp.TotalLineCount() - m.vp.Height
			if maxOff < 0 {
				maxOff = 0
			}
			if m.vp.YOffset < 0 || m.vp.YOffset > maxOff {
				t.Fatalf("%s: viewport offset %d outside [0,%d]", label, m.vp.YOffset, maxOff)
			}
			assertLayoutInvariants(t, m, label)
		}
	}
}

// TestResizeScrollClamp: a scrolled routing viewport keeps its offset across a
// width-only resize, and clamps (never dangles past the content) when a resize
// shrinks the panel; a facet change still resets to the top.
func TestResizeScrollClamp(t *testing.T) {
	m := layoutModel()
	id := comboID(defaultSel())
	rows := []string{"  thinking medium · fallback on · advisor on"}
	for i := range 40 {
		rows = append(rows, fmt.Sprintf("    role%02d     gpt-5.6-terra:medium", i))
	}
	m.generated[id] = rows
	wide, medium, narrow, _ := layoutSizes(t, m)

	m = resize(t, m, wide.w, wide.h)
	if m.vp.TotalLineCount() <= m.vp.Height {
		t.Fatalf("fixture: routing content (%d lines) must overflow the viewport (%d rows)", m.vp.TotalLineCount(), m.vp.Height)
	}
	m.vp.SetYOffset(6)

	m = resize(t, m, wide.w+8, wide.h) // width-only: offset survives
	if m.vp.YOffset != 6 {
		t.Fatalf("width-only resize moved the scroll: YOffset = %d, want 6", m.vp.YOffset)
	}

	m.vp.GotoBottom()
	m = resize(t, m, medium.w, medium.h) // shrink: offset clamps into range
	maxOff := m.vp.TotalLineCount() - m.vp.Height
	if maxOff < 0 {
		maxOff = 0
	}
	if m.vp.YOffset < 0 || m.vp.YOffset > maxOff {
		t.Fatalf("shrink left a dangling offset %d outside [0,%d]", m.vp.YOffset, maxOff)
	}
	m = resize(t, m, narrow.w, narrow.h)
	m = resize(t, m, wide.w, wide.h)

	m.vp.SetYOffset(4)
	m.cycleFacet(1) // content change: back to the top
	if m.vp.YOffset != 0 {
		t.Fatalf("facet change must reset the preview scroll, YOffset = %d", m.vp.YOffset)
	}
}

// ── trackpad / wheel coalescing ─────────────────────────────────────────────

// Both axes are inverted relative to the raw event names (operator-confirmed
// trackpad direction): WheelUp moves the selection down and WheelDown up;
// WheelLeft cycles to the next (right) option and WheelRight to the previous.
func TestWheelStepsFacets(t *testing.T) {
	m := layoutModel()
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)

	m.applyWheelStep(tea.MouseButtonWheelUp)
	if m.fcur != 1 {
		t.Fatalf("wheel UP must move selection down: fcur = %d", m.fcur)
	}
	m.applyWheelStep(tea.MouseButtonWheelDown)
	if m.fcur != 0 {
		t.Fatalf("wheel DOWN must move selection up: fcur = %d", m.fcur)
	}
	if m.sel["lane"] != "mixed" {
		t.Fatalf("fixture: lane = %q, want mixed", m.sel["lane"])
	}
	m.applyWheelStep(tea.MouseButtonWheelLeft)
	if m.sel["lane"] != "gpt-led" {
		t.Fatalf("wheel LEFT must cycle to next option: lane = %q", m.sel["lane"])
	}
	m.applyWheelStep(tea.MouseButtonWheelRight)
	if m.sel["lane"] != "mixed" {
		t.Fatalf("wheel RIGHT must cycle to previous option: lane = %q", m.sel["lane"])
	}
}

func TestWheelThroughUpdate(t *testing.T) {
	m := layoutModel()
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)

	nm, cmd := m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonWheelUp})
	m = nm.(model)
	if cmd != nil {
		t.Fatal("direct wheel input must not produce a command")
	}
	if m.fcur != 1 {
		t.Fatalf("wheel-up press must step selection down: fcur = %d", m.fcur)
	}

	sel := map[string]string{}
	for k, v := range m.sel {
		sel[k] = v
	}
	nm, cmd = m.Update(tea.MouseMsg{Action: tea.MouseActionMotion, Button: tea.MouseButtonNone})
	m = nm.(model)
	if cmd != nil || m.fcur != 1 || !reflect.DeepEqual(m.sel, sel) {
		t.Fatal("non-wheel mouse traffic must be ignored")
	}
}

func TestWheelInputFilterRequiresDeliberateBurst(t *testing.T) {
	m := layoutModel()
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)
	filter := wheelInputFilter{}
	wheel := func(b tea.MouseButton) tea.MouseMsg {
		return tea.MouseMsg{Action: tea.MouseActionPress, Button: b, X: 2, Y: topGap + 2}
	}
	admit := func(b tea.MouseButton) admittedWheelMsg {
		t.Helper()
		for i := 1; i < wheelStepEvents; i++ {
			if got := filter.Filter(m, wheel(b)); got != nil {
				t.Fatalf("event %d/%d admitted early as %T", i, wheelStepEvents, got)
			}
			if i == 2 && (b == tea.MouseButtonWheelUp || b == tea.MouseButtonWheelDown) {
				if got := filter.Filter(m, wheel(tea.MouseButtonWheelRight)); got != nil {
					t.Fatalf("orthogonal jitter reached Update as %T", got)
				}
			}
		}
		msg, ok := filter.Filter(m, wheel(b)).(admittedWheelMsg)
		if !ok {
			t.Fatalf("event %d/%d was not admitted", wheelStepEvents, wheelStepEvents)
		}
		return msg
	}

	first := admit(tea.MouseButtonWheelUp)
	nm, cmd := m.Update(first)
	m = nm.(model)
	if cmd != nil || m.fcur != 1 {
		t.Fatalf("first deliberate burst: cmd nil = %t, fcur = %d", cmd == nil, m.fcur)
	}

	reverse := admit(tea.MouseButtonWheelDown)
	nm, cmd = m.Update(reverse)
	m = nm.(model)
	if cmd != nil || m.fcur != 0 {
		t.Fatalf("reverse burst: cmd nil = %t, fcur = %d", cmd == nil, m.fcur)
	}

	// A later orthogonal gesture starts cleanly after the prior gesture gap.
	filter.last = time.Now().Add(-wheelGestureGap - time.Millisecond)
	left := admit(tea.MouseButtonWheelLeft)
	nm, _ = m.Update(left)
	m = nm.(model)
	if m.sel["lane"] != "gpt-led" {
		t.Fatalf("horizontal burst did not move lane: %q", m.sel["lane"])
	}
}

func TestFilteredWheelPreservesSelectionPersistence(t *testing.T) {
	m := layoutModel()
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)
	m.selectionState = filepath.Join(t.TempDir(), "selection.json")
	filter := wheelInputFilter{}
	left := tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonWheelLeft, X: 2, Y: topGap + 2}

	var msg tea.Msg
	for range wheelStepEvents {
		if got := filter.Filter(m, left); got != nil {
			msg = got
		}
	}
	if msg == nil {
		t.Fatal("deliberate wheel-left burst was not admitted")
	}
	nm, _ := m.Update(msg)
	m = nm.(model)
	if got := loadSelectionState(m.selectionState, m.facets)["lane"]; got != "gpt-led" {
		t.Fatalf("persisted lane after wheel-left = %q, want gpt-led", got)
	}

	filter.last = time.Now().Add(-wheelGestureGap - time.Millisecond)
	right := tea.MouseMsg{Action: tea.MouseActionPress, Button: tea.MouseButtonWheelRight, X: 2, Y: topGap + 2}
	msg = nil
	for range wheelStepEvents {
		if got := filter.Filter(m, right); got != nil {
			msg = got
		}
	}
	nm, _ = m.Update(msg)
	m = nm.(model)
	if got := loadSelectionState(m.selectionState, m.facets)["lane"]; got != "mixed" {
		t.Fatalf("persisted lane after wheel-right burst = %q, want mixed", got)
	}
}

func TestWheelInputFilterKeepsRoutingContinuous(t *testing.T) {
	m := layoutModel()
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)
	m.vp.Height = 2
	m.vp.SetContent("zero\none\ntwo\nthree")
	filter := wheelInputFilter{}
	x, y := m.w-2, topGap+2
	wheel := func(b tea.MouseButton) tea.MouseMsg {
		return tea.MouseMsg{Action: tea.MouseActionPress, Button: b, X: x, Y: y}
	}

	for want := 1; want <= 2; want++ {
		msg := filter.Filter(m, wheel(tea.MouseButtonWheelUp))
		if _, ok := msg.(tea.MouseMsg); !ok {
			t.Fatalf("routing event %d = %T, want ordinary MouseMsg", want, msg)
		}
		nm, _ := m.Update(msg)
		m = nm.(model)
		if m.vp.YOffset != want {
			t.Fatalf("routing event %d: YOffset = %d, want %d", want, m.vp.YOffset, want)
		}
	}
	if got := filter.Filter(m, wheel(tea.MouseButtonWheelUp)); got != nil {
		t.Fatalf("clamped routing event reached redraw as %T", got)
	}
	if got := filter.Filter(m, wheel(tea.MouseButtonWheelLeft)); got != nil {
		t.Fatalf("inert routing horizontal event reached redraw as %T", got)
	}
	if got := filter.Filter(m, wheel(tea.MouseButtonWheelDown)); got == nil {
		t.Fatal("routing wheel-down must remain continuous away from the clamp")
	}
}

type programResult struct {
	model tea.Model
	err   error
}

type burstKeyState struct {
	views int64
	fcur  int
}

type burstProbe struct {
	model
	views   *atomic.Int64
	keySeen chan burstKeyState
}

func (p burstProbe) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if key, ok := msg.(tea.KeyMsg); ok && key.String() == "j" {
		p.keySeen <- burstKeyState{views: p.views.Load(), fcur: p.fcur}
	}
	nm, cmd := p.model.Update(msg)
	p.model = nm.(model)
	return p, cmd
}

func (p burstProbe) View() string {
	p.views.Add(1)
	return p.model.View()
}

// TestRawMouseBurstRemainsResponsive drives the real Bubble Tea ANSI parser
// with two dense trackpad-like wheel/jitter/motion bursts separated by a
// gesture gap. Rejected sub-threshold events must never reach Update/View, and
// each deliberate burst produces only one generator step.
func TestRawMouseBurstRemainsResponsive(t *testing.T) {
	m := layoutModel()
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)
	m.broker = brokerConfig{} // keep unrelated fetch/ticks out of the program
	m.providersResolved = true
	var views atomic.Int64
	keySeen := make(chan burstKeyState, 1)
	filter := wheelInputFilter{}
	inR, inW := io.Pipe()
	p := tea.NewProgram(
		burstProbe{model: m, views: &views, keySeen: keySeen},
		tea.WithInput(inR),
		tea.WithOutput(io.Discard),
		tea.WithFilter(filter.Filter),
	)
	done := make(chan programResult, 1)
	go func() {
		final, err := p.Run()
		done <- programResult{model: final, err: err}
	}()

	started := time.Now()
	var redrawsAtKey int64
	var fcurAtKey int
	for range wheelStepEvents {
		fmt.Fprint(inW, "\x1b[<64;3;4M") // vertical wheel
		fmt.Fprint(inW, "\x1b[<67;3;4M") // horizontal axis jitter
		fmt.Fprint(inW, "\x1b[<35;4;4M") // cell motion with no button
	}
	fmt.Fprint(inW, "j")
	select {
	case state := <-keySeen:
		redrawsAtKey, fcurAtKey = state.views, state.fcur
		if redrawsAtKey > 5 {
			t.Fatalf("keyboard waited behind %d redraws; coalesced burst reached View", redrawsAtKey)
		}
	case <-time.After(time.Second):
		t.Fatal("keyboard input was starved after the first trackpad burst")
	}

	time.Sleep(wheelGestureGap + 10*time.Millisecond)
	for range wheelStepEvents {
		fmt.Fprint(inW, "\x1b[<64;3;4M") // same direction, new gesture
		fmt.Fprint(inW, "\x1b[<66;3;4M") // horizontal axis jitter
		fmt.Fprint(inW, "\x1b[<35;4;4M") // cell motion
	}
	time.Sleep(20 * time.Millisecond)
	fmt.Fprint(inW, "q")
	inW.Close()

	var result programResult
	select {
	case result = <-done:
	case <-time.After(time.Second):
		t.Fatal("Bubble Tea event loop stayed backlogged after the second burst")
	}
	if result.err != nil {
		t.Fatal(result.err)
	}
	final := result.model.(burstProbe).model
	if final.fcur <= fcurAtKey {
		t.Fatalf("second re-armed wheel burst did not advance: at key = %d, final = %d", fcurAtKey, final.fcur)
	}
	if got := views.Load(); got > 10 {
		t.Fatalf("raw bursts produced %d views, want bounded redraw count <= 10", got)
	}
	t.Logf("%d raw mouse messages + keyboard: %d views, key after %d views, %s total",
		2*wheelStepEvents*3, views.Load(), redrawsAtKey, time.Since(started))
}

// ── usage identity · collapsible sections · contextual help (atyrode/dotfiles#198) ──────────

// press drives one rune keypress through Update.
func press(t *testing.T, m model, k string) (model, tea.Cmd) {
	t.Helper()
	nm, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)})
	return nm.(model), cmd
}

// accountModel is the central broker fixture used by account and help tests.
func accountModel() model {
	return layoutModel()
}

// shortDescs returns the compact help line's action descriptions — the
// state-derived contract, independent of footer width truncation.
func shortDescs(m model) []string {
	var out []string
	for _, b := range m.contextHelp().ShortHelp() {
		out = append(out, b.Help().Desc)
	}
	return out
}

func hasDesc(descs []string, want string) bool {
	for _, d := range descs {
		if d == want {
			return true
		}
	}
	return false
}

// TestShortWin pins the tag every usage row is labelled with. The payload's own
// window id is authoritative, with the limit's tier appended when the limit is
// tier-scoped, because an id alone cannot tell a provider's main window apart
// from a carve-out of the same duration.
//
// The 30d case is the concrete regression. This operator's Codex account reports
// exactly one window, a 30d one, and the old hardcoded table of English labels
// neither recognised it nor named it: the row rendered as the raw payload string
// "30 days" and knownUsageWindow gated it out of the panel entirely. The label
// switch survives only as the fallback for payloads that carry no id at all, and
// it must never grow again.
func TestShortWin(t *testing.T) {
	cases := []struct {
		name string
		win  usageWin
		want string
	}{
		{"codex's sole 30d window", usageWin{id: "30d", label: "30 days"}, "30d"},
		{"tier-scoped spark window", usageWin{id: "5h", label: "5 hours (Spark)", tier: "spark"}, "5h spark"},
		{"untiered id", usageWin{id: "7d", label: "7 days"}, "7d"},
		{"placeholder tier is not a scope", usageWin{id: "5h", tier: "-"}, "5h"},
		// A tier this build does not model is still the window's own name: no
		// vocabulary is whitelisted here any more.
		{"undeclared tier", usageWin{id: "7d", tier: "fable"}, "7d fable"},
		// The id wins outright — a stale English label never overrides it.
		{"id beats a disagreeing label", usageWin{id: "30d", label: "7 days"}, "30d"},
		// id-less legacy payloads fall back to the label vocabulary.
		{"legacy label", usageWin{label: "Claude 5 Hour"}, "5h"},
		{"legacy spark label", usageWin{label: "Codex 5 Hour (Spark)"}, "5h spark"},
		{"unknown legacy label passes through", usageWin{label: "unrecognized upstream"}, "unrecognized upstream"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := shortWin(c.win); got != c.want {
				t.Errorf("shortWin(%+v) = %q, want %q", c.win, got, c.want)
			}
		})
	}
	// The other half of the same incident: the gate no longer whitelists
	// durations, so a payload-named window on a metered provider is drawable
	// whatever its length — and an id-less window with a label nothing
	// recognises still is not, because the panel would have nothing to call it.
	if !knownUsageWindow(usageWin{id: "30d", prov: "openai-codex"}) {
		t.Error("a payload-named 30d window on a metered provider must be renderable")
	}
	if knownUsageWindow(usageWin{label: "30 days", prov: "openai-codex"}) {
		t.Error("an id-less window whose label nothing recognises must not be drawn")
	}
	if knownUsageWindow(usageWin{id: "30d", prov: "deepseek"}) {
		t.Error("an unmetered provider has no quota window to draw")
	}
}

func TestUsageHasOneAccountManagerCue(t *testing.T) {
	m := layoutModel()
	panel := stripAnsi(m.usagePanel())
	if got := strings.Count(panel, "v accounts"); got != 1 {
		t.Errorf("account-manager cue count = %d, want 1:\n%s", got, panel)
	}
	if strings.Contains(panel, "v · accounts") {
		t.Errorf("Usage title repeats the bottom account-manager cue:\n%s", panel)
	}
}

func TestCompactDisplayIdentity(t *testing.T) {
	tests := []struct {
		name, identity, want string
	}{
		{name: "normalized email", identity: " ALEX@Example.DEV ", want: "al*"},
		{name: "short local", identity: "a@example.fr", want: "a*"},
		{name: "unicode local", identity: "λ@example.世界", want: "λ*"},
		{name: "two rune local", identity: "🙂x@example.com", want: "🙂x*"},
		{name: "opaque fallback", identity: "01234567-89ab-cdef", want: "01*"},
		{name: "missing domain suffix", identity: "a@example", want: "a@*"},
		{name: "missing local", identity: "@example.dev", want: "@e*"},
		{name: "trailing dot", identity: "a@example.", want: "a@*"},
		{name: "empty", identity: "", want: "id unavailable"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := compactDisplayIdentity(test.identity); got != test.want {
				t.Errorf("compactDisplayIdentity(%q) = %q, want %q", test.identity, got, test.want)
			}
		})
	}
}

func TestUsageProviderAccountsCompactIntoHeading(t *testing.T) {
	m := layoutModel()
	m.avail.accountsOK = true
	m.avail.accounts = map[string][]account{
		"openai-codex": {
			{Provider: "openai-codex", IdentityKey: "codex-z", Email: "z@example.test"},
			{Provider: "openai-codex", IdentityKey: "codex-a", Email: "a@example.test"},
		},
		"anthropic": {
			{Provider: "anthropic", IdentityKey: "claude", Email: "claude@example.test"},
		},
	}
	m.avail.accountUsage = map[accountKey][]usageWin{
		{Provider: "openai-codex", IdentityKey: "codex-a"}: {
			{label: "7 days", pct: 33, dur: 7 * day, prov: "openai-codex"},
		},
		{Provider: "anthropic", IdentityKey: "claude"}: {
			{label: "7 days", id: "7d", dur: 7 * day, prov: "anthropic", missing: true},
		},
	}

	panel := stripAnsi(m.usagePanel())
	if claude, codex := strings.Index(panel, "Claude"), strings.Index(panel, "Codex"); claude < 0 || codex < 0 || claude > codex {
		t.Fatalf("account groups must be Anthropic then OpenAI:\n%s", panel)
	}
	if !strings.Contains(panel, "Codex (z* + a*)") {
		t.Errorf("heading must preserve stable broker snapshot order:\n%s", panel)
	}
	if !strings.Contains(panel, "Claude (cl*)") {
		t.Errorf("single account must compact into the provider heading:\n%s", panel)
	}
	if strings.Contains(panel, "a@example.test") || strings.Count(panel, "z*") != 1 ||
		strings.Count(panel, "a*") != 1 || strings.Count(panel, "cl*") != 1 {
		t.Errorf("account identities must appear only in provider headings:\n%s", panel)
	}
	if got := strings.Count(panel, "usage unavailable"); got != 2 {
		t.Errorf("unmatched provider coverage rows = %d, want 2 without repeated identities:\n%s", got, panel)
	}
}

func TestUsageCompactIdentityCollisionsAndDuplicateAccounts(t *testing.T) {
	first := account{Provider: "openai-codex", IdentityKey: "first", Email: "alice@example.dev"}
	duplicate := account{Provider: "openai-codex", IdentityKey: "first", Email: "changed@example.dev"}
	second := account{Provider: "openai-codex", IdentityKey: "second", Email: "albert@example.dev"}
	a := availability{
		accountsOK: true,
		accounts: map[string][]account{
			"openai-codex": {first, duplicate, second},
		},
		accountUsage: map[accountKey][]usageWin{
			{Provider: first.Provider, IdentityKey: first.IdentityKey}: {
				{label: "5 hours", dur: 5 * 3600, prov: first.Provider},
			},
		},
	}
	panel := stripAnsi(identityLinesFor(a))
	if !strings.Contains(panel, "Codex (al* + al*)") {
		t.Fatalf("compact identity collisions may remain deliberately ambiguous:\n%s", panel)
	}
	if strings.Contains(panel, "ch*") || strings.Count(panel, "al*") != 2 {
		t.Errorf("duplicate stable account must collapse without repeating unavailable identities:\n%s", panel)
	}
	if !strings.Contains(panel, "usage unavailable") {
		t.Errorf("unavailable collision must retain explicit provider coverage:\n%s", panel)
	}
}

func TestUsageIdentityShortcutExpandsAndCollapsesAddresses(t *testing.T) {
	m := layoutModel()
	compact := stripAnsi(m.usagePanel())
	if !strings.Contains(compact, "Codex (co*)") || strings.Contains(compact, "codex@example.test") ||
		!strings.Contains(compact, "i full ids") {
		t.Fatalf("Usage did not default to compact identities:\n%s", compact)
	}
	next, cmd := press(t, m, "i")
	if cmd != nil {
		t.Fatal("identity shortcut unexpectedly launched a command")
	}
	full := stripAnsi(next.usagePanel())
	if !strings.Contains(full, "Codex (codex@example.test)") || !strings.Contains(full, "i short ids") {
		t.Fatalf("identity shortcut did not reveal full addresses:\n%s", full)
	}
	collapsed, cmd := press(t, next, "i")
	if cmd != nil || !strings.Contains(stripAnsi(collapsed.usagePanel()), "Codex (co*)") {
		t.Fatal("second identity shortcut did not restore compact labels")
	}
	collapsed.manager = true
	managed, cmd := press(t, collapsed, "i")
	if cmd != nil || !strings.Contains(stripAnsi(managed.usagePanel()), "Codex (codex@example.test)") {
		t.Fatal("account manager did not share the identity shortcut")
	}
}

func TestUsageHeadingStyleAndManagerIdentityBoundary(t *testing.T) {
	identities := []compactProviderIdentity{{label: "al*"}, {label: "po*"}}
	want := lipgloss.NewStyle().Foreground(lipgloss.Color("#62a7ff")).Bold(true).Render("Codex") +
		" " + stDim.Render("(al* + po*)")
	if got := providerHeading("openai-codex", identities); got != want {
		t.Errorf("provider heading style changed:\ngot  %q\nwant %q", got, want)
	}
	const full = "alexander.operator@example.dev"
	if got := managerAccountLabel(account{Email: full, IdentityKey: "opaque-key"}); got != full {
		t.Errorf("Accounts label = %q, want full email %q", got, full)
	}
}

func TestNoGlobalVaultCycle(t *testing.T) {
	m := layoutModel()
	before := m
	next, cmd := press(t, m, "a")
	if cmd != nil || next.manager || !reflect.DeepEqual(next.accountSelections, before.accountSelections) {
		t.Fatalf("global a must be inert: cmd=%v manager=%v", cmd != nil, next.manager)
	}
	view := stripAnsi(next.View())
	for _, forbidden := range []string{"switch vault", "manage vaults", "profile"} {
		if strings.Contains(strings.ToLower(view), forbidden) {
			t.Errorf("central account UI leaked %q:\n%s", forbidden, view)
		}
	}
}

// TestUsageLoadingErrorStates: loading, refreshing, and unavailable states keep
// compact provider headings and explicit broker account status visible.
func TestUsageLoadingErrorStates(t *testing.T) {
	m := layoutModel()

	loading := m
	loading.avail = availability{
		bucket:     map[string]string{},
		reset:      map[string]int64{},
		accountsOK: true,
		accounts: map[string][]account{
			"openai-codex": {
				{Provider: "openai-codex", IdentityKey: "codex", Email: "skeleton.codex@example.dev"},
				{Provider: "openai-codex", IdentityKey: "hidden", Email: "hidden@example.io"},
			},
			"anthropic": {{Provider: "anthropic", IdentityKey: "claude", Email: "skeleton.claude@example.fr"}},
		},
	}
	loading.accountSelections.manualDisabled = map[accountKey]bool{
		{Provider: "openai-codex", IdentityKey: "hidden"}: true,
	}
	loading.fetching = true
	panel := stripAnsi(loading.usagePanel())
	for _, want := range []string{"fetching usage…", "Codex (sk*)", "Claude (sk*)"} {
		if !strings.Contains(panel, want) {
			t.Errorf("loading: panel missing %q:\n%s", want, panel)
		}
	}
	if strings.Contains(panel, "usage unavailable") {
		t.Errorf("loading must not read as an error:\n%s", panel)
	}
	if strings.Contains(panel, "skeleton.codex@example.dev") || strings.Contains(panel, "skeleton.claude@example.fr") {
		t.Errorf("loading skeleton leaked full account identities:\n%s", panel)
	}
	if strings.Contains(panel, "hi*") {
		t.Errorf("loading skeleton included a disabled account:\n%s", panel)
	}

	refreshing := m
	refreshing.fetching = true
	refreshing.avail.accountsOK = true
	refreshing.avail.accounts = map[string][]account{
		"openai-codex": {{Provider: "openai-codex", IdentityKey: "codex", Email: "operator.codex@example.test"}},
		"anthropic":    {{Provider: "anthropic", IdentityKey: "claude", Email: "operator.claude@example.test"}},
	}
	panel = stripAnsi(refreshing.usagePanel())
	for _, want := range []string{"refreshing…", "Codex (op*)", "Claude (op*)", "% used"} {
		if !strings.Contains(panel, want) {
			t.Errorf("refreshing: panel missing %q:\n%s", want, panel)
		}
	}
	if strings.Contains(panel, "next refresh") {
		t.Errorf("refreshing must replace the countdown, not stack on it:\n%s", panel)
	}

	failed := m
	failed.avail = availability{bucket: map[string]string{}, reset: map[string]int64{}}
	panel = stripAnsi(failed.usagePanel())
	for _, want := range []string{"usage unavailable · press v to manage accounts", "Codex", "Claude", "account status unavailable"} {
		if !strings.Contains(panel, want) {
			t.Errorf("unavailable: panel missing %q:\n%s", want, panel)
		}
	}

	accountErr := accountModel()
	accountErr.accountErr = "state write denied"
	panel = stripAnsi(accountErr.usagePanel())
	if !strings.Contains(panel, "account update failed: state write denied") {
		t.Errorf("an account persistence failure must stay attached to the usage section:\n%s", panel)
	}
}

// TestSectionToggleCombinations walks every routing × usage visibility combo
// on a wide terminal: local hide cues live in the section titles, hidden
// sections surface their recovery cue in the compact footer instead, no
// toggle ever triggers a fetch, and every combination keeps the frame
// invariants.
func TestSectionToggleCombinations(t *testing.T) {
	m := accountModel()
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)
	availBefore := m.avail

	assertCombo := func(label string, wantRouting, wantUsage bool) {
		t.Helper()
		view := stripAnsi(m.View())
		lines := strings.Split(view, "\n")
		if got := lineIndex(lines, "p · hide") >= 0; got != wantRouting {
			t.Errorf("%s: routing chrome visible = %v, want %v:\n%s", label, got, wantRouting, view)
		}
		if got := lineIndex(lines, "s · hide") >= 0; got != wantUsage {
			t.Errorf("%s: usage chrome visible = %v, want %v:\n%s", label, got, wantUsage, view)
		}
		if got := lineIndex(lines, "% used") >= 0; got != wantUsage {
			t.Errorf("%s: usage rows visible = %v, want %v", label, got, wantUsage)
		}
		descs := shortDescs(m)
		if got := hasDesc(descs, "show routing"); got == wantRouting {
			t.Errorf("%s: compact help offers show routing = %v with routing visible = %v", label, got, wantRouting)
		}
		if got := hasDesc(descs, "show usage"); got == wantUsage {
			t.Errorf("%s: compact help offers show usage = %v with usage visible = %v", label, got, wantUsage)
		}
		if got := hasDesc(descs, "manage accounts"); got == wantUsage {
			t.Errorf("%s: compact help repeats/misses account manager (got %v) with usage visible = %v", label, got, wantUsage)
		}
		if m.fetching || !reflect.DeepEqual(m.avail, availBefore) {
			t.Errorf("%s: a display toggle mutated fetch state", label)
		}
		assertLayoutInvariants(t, m, label)
	}

	assertCombo("both visible", true, true)

	var cmd tea.Cmd
	m, cmd = press(t, m, "s")
	if cmd != nil {
		t.Fatal("hiding usage must never produce a command")
	}
	assertCombo("usage hidden", true, false)

	m, cmd = press(t, m, "p")
	if cmd != nil {
		t.Fatal("hiding routing must never produce a command")
	}
	assertCombo("both hidden", false, false)

	m, _ = press(t, m, "s")
	assertCombo("routing hidden", false, true)

	m, _ = press(t, m, "p")
	assertCombo("both restored", true, true)
}

// TestCompactHelpDerivation locks the state-derived footer rules: chrome-
// visible actions never repeat in the compact line, hidden sections add their
// recovery cue, refresh hides while a fetch is in flight or unusable, the
// launch trio surfaces only when the generator's launch footer is off screen,
// and narrow terminals advertise the dedicated full-screen Usage view.
func TestCompactHelpDerivation(t *testing.T) {
	m := accountModel()
	wide, _, narrow, _ := layoutSizes(t, m)

	m = resize(t, m, wide.w, wide.h)
	descs := shortDescs(m)
	for _, d := range []string{"move", "change", gReset + " defaults", "manage accounts", "refresh usage", "managed omp", "untrusted omp", "launch", "show routing", "show usage"} {
		got := hasDesc(descs, d)
		want := d == "move" || d == "change"
		if got != want {
			t.Errorf("wide compact help: %q shown = %v, want %v (descs %v)", d, got, want, descs)
		}
	}
	if !hasDesc(descs, "more") || !hasDesc(descs, "quit") {
		t.Errorf("full-help discovery and quit must always be offered: %v", descs)
	}

	m = resize(t, m, narrow.w, narrow.h)
	descs = shortDescs(m)
	for _, d := range []string{"show routing", "show usage", "manage accounts", "refresh usage"} {
		if !hasDesc(descs, d) {
			t.Errorf("narrow compact help missing %q: %v", d, descs)
		}
	}
	ordered := strings.Join(descs, "|")
	for _, optional := range []string{"manage accounts", "refresh usage"} {
		if strings.Index(ordered, "more") > strings.Index(ordered, optional) ||
			strings.Index(ordered, "quit") > strings.Index(ordered, optional) {
			t.Errorf("narrow compact help must prioritize more/quit before %q: %v", optional, descs)
		}
	}

	fetching := m
	fetching.fetching = true
	if hasDesc(shortDescs(fetching), "refresh usage") {
		t.Error("refresh must hide from compact help while a fetch is in flight")
	}
	noCmd := m
	noCmd.broker = brokerConfig{}
	if hasDesc(shortDescs(noCmd), "refresh usage") {
		t.Error("refresh must hide from compact help when no broker exists")
	}

	// narrow + p: routing full-screen hides the generator launch footer.
	swapped, _ := press(t, m, "p")
	descs = shortDescs(swapped)
	for _, d := range []string{gReset + " defaults", "launch", "managed omp", "untrusted omp"} {
		if !hasDesc(descs, d) {
			t.Errorf("routing-full-screen compact help missing %q: %v", d, descs)
		}
	}
	if hasDesc(descs, "show routing") {
		t.Errorf("routing is visible full-screen — no recovery cue: %v", descs)
	}

	// A terminal too narrow to ever seat usage must not advertise its restore.
	tiny := accountModel()
	tiny.hideUsage = true
	tiny = resize(t, tiny, routingMinW-3, 40)
	if hasDesc(shortDescs(tiny), "show usage") {
		t.Error("show usage must not be offered when restoring could not render it")
	}
}

// TestFullHelpComplete: ? always exposes every binding — including both
// section toggles — regardless of what the compact footer dropped, and the
// full keymap stays conflict-free (u keeps the sandbox; s is the usage key).
func TestFullHelpComplete(t *testing.T) {
	m := accountModel()
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)
	m.hideUsage = true
	m.collapse = true
	m.help.ShowAll = true
	foot := stripAnsi(m.footer())
	for _, d := range []string{"move", "change", "defaults", "primary ⇄ full chains", "refresh usage", "manage accounts", "show/hide routing", "show/hide usage", "launch", "managed omp", "untrusted omp", "quit"} {
		if !strings.Contains(foot, d) {
			t.Errorf("full help missing %q:\n%s", d, foot)
		}
	}

	seen := map[string]string{}
	for _, group := range keys.FullHelp() {
		for _, b := range group {
			for _, k := range b.Keys() {
				if prev, dup := seen[k]; dup {
					t.Errorf("key %q bound to both %q and %q", k, prev, b.Help().Desc)
				}
				seen[k] = b.Help().Desc
			}
		}
	}
	if desc, exists := seen["a"]; exists {
		t.Fatalf("global a binding survived as %q", desc)
	}
	if got := keys.Usage.Keys(); len(got) != 1 || got[0] != "s" {
		t.Errorf("usage toggle key = %v, want [s]", got)
	}
	if got := keys.Untrusted.Keys(); len(got) != 1 || got[0] != "u" {
		t.Errorf("sandbox must keep u, got %v", got)
	}
	if got := keys.Collapse.Keys(); len(got) != 1 || got[0] != "p" {
		t.Errorf("routing toggle must keep p, got %v", got)
	}
}

// TestLongAccountEmailsWidthInvariant: a long broker-reported email compacts in
// Usage instead of widening its measured column or leaking the full identity.
func TestLongAccountEmailsWidthInvariant(t *testing.T) {
	const longEmail = "alexander-maximilian-extremely-long-name@example.test"
	m := layoutModel()
	m.avail.accountsOK = true
	m.avail.accounts = map[string][]account{
		"openai-codex": {{Provider: "openai-codex", IdentityKey: "codex", Email: longEmail}},
		"anthropic":    {{Provider: "anthropic", IdentityKey: "claude", Email: "claude@example.test"}},
	}
	wideW := m.genRowWidth() + routingMinW
	sizes := []termSize{
		{wideW + 30, 40},
		{m.mediumMinW() + 2, 40},
		{m.mediumMinW() - 10, 40},
		{45, 40},
		{wideW + 30, 12},
	}
	for _, s := range sizes {
		m = resize(t, m, s.w, s.h)
		label := fmt.Sprintf("long email %dx%d", s.w, s.h)
		assertLayoutInvariants(t, m, label)
		view := stripAnsi(m.View())
		if strings.Contains(view, "% used") &&
			(!strings.Contains(view, "Codex (al*)") || strings.Contains(view, longEmail)) {
			t.Errorf("%s: visible usage must keep the identity compact:\n%s", label, view)
		}
	}
}

// TestSectionStatePreservation: routing/usage visibility survives resizes,
// central background refreshes, and PromptBox proposal round-trips; restoring
// routing recovers its prior scroll and restoring usage refetches nothing.
func TestSectionStatePreservation(t *testing.T) {
	m := accountModel()
	wide, medium, narrow, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)
	m.hideUsage = true
	m.collapse = true

	for _, s := range []termSize{medium, narrow, wide} {
		m = resize(t, m, s.w, s.h)
		if !m.hideUsage || !m.collapse {
			t.Fatalf("resize to %dx%d mutated section visibility", s.w, s.h)
		}
		assertLayoutInvariants(t, m, fmt.Sprintf("hidden sections %dx%d", s.w, s.h))
	}

	nm, _ := m.Update(usageMsg{avail: m.avail})
	m = nm.(model)
	if !m.hideUsage || !m.collapse {
		t.Fatal("a background refresh mutated section visibility")
	}

	nm, _ = m.Update(clikit.ActionsProposedMsg{})
	m = nm.(model)
	nm, _ = m.Update(clikit.ActionsRevertedMsg{})
	m = nm.(model)
	if !m.hideUsage || !m.collapse {
		t.Fatal("a PromptBox proposal round-trip mutated section visibility")
	}

	// Restoring routing recovers the prior scroll position.
	sc := layoutModel()
	id := comboID(defaultSel())
	rows := []string{"  thinking medium · fallback on · advisor on"}
	for i := range 40 {
		rows = append(rows, fmt.Sprintf("    role%02d     gpt-5.6-terra:medium", i))
	}
	sc.generated[id] = rows
	sc = resize(t, sc, wide.w, wide.h)
	sc.vp.SetYOffset(6)
	sc, _ = press(t, sc, "p")
	sc, _ = press(t, sc, "p")
	if sc.vp.YOffset != 6 {
		t.Fatalf("routing restore lost the scroll position: YOffset = %d, want 6", sc.vp.YOffset)
	}

	// Restoring usage refetches nothing: same rows, no command, no fetch.
	u := layoutModel()
	u = resize(t, u, wide.w, wide.h)
	before := stripAnsi(u.View())
	u, cmd := press(t, u, "s")
	if cmd != nil {
		t.Fatal("hiding usage must not produce a command")
	}
	u, cmd = press(t, u, "s")
	if cmd != nil || u.fetching {
		t.Fatal("restoring usage must not refetch")
	}
	if after := stripAnsi(u.View()); after != before {
		t.Fatalf("usage restore must reproduce the exact prior band:\n--- before ---\n%s\n--- after ---\n%s", before, after)
	}
}

// TestCollapseReallocation: hiding a section hands its rows to the active
// composition immediately — medium's secondary row shrinks to routing-only at
// full width and the generator absorbs the slack; wide returns the usage band
// rows to the body; a narrow terminal gains the medium secondary row once the
// usage column no longer needs seating.
func TestCollapseReallocation(t *testing.T) {
	m := layoutModel()
	wide, medium, narrow, _ := layoutSizes(t, m)

	m = resize(t, m, medium.w, medium.h+8)
	gen0, sec0 := m.mediumSplit(m.contentH())
	m, _ = press(t, m, "s")
	if m.mode() != modeMedium {
		t.Fatalf("hiding usage at medium width must stay medium, mode = %d", m.mode())
	}
	gen1, sec1 := m.mediumSplit(m.contentH())
	if sec1 >= sec0 || gen1 <= gen0 {
		t.Errorf("medium reallocation: secondary %d→%d, generator %d→%d — generator must absorb the freed rows", sec0, sec1, gen0, gen1)
	}
	if got := m.routingColW(); got != m.w {
		t.Errorf("routing must span the full secondary row when usage hides: %d, want %d", got, m.w)
	}
	assertLayoutInvariants(t, m, "medium usage hidden")
	m, _ = press(t, m, "s")
	if gen2, sec2 := m.mediumSplit(m.contentH()); gen2 != gen0 || sec2 != sec0 {
		t.Errorf("restore must return the original split: got %d/%d, want %d/%d", gen2, sec2, gen0, gen0)
	}

	w := layoutModel()
	w = resize(t, w, wide.w, wide.h)
	ch0 := w.contentH()
	w, _ = press(t, w, "s")
	if ch1 := w.contentH(); ch1 <= ch0 {
		t.Errorf("wide: hiding the usage band must return its rows to the body: %d → %d", ch0, ch1)
	}
	assertLayoutInvariants(t, w, "wide usage hidden")

	n := layoutModel()
	n = resize(t, n, narrow.w, narrow.h)
	if n.mode() != modeCollapsed {
		t.Fatalf("fixture: %dx%d must start collapsed", narrow.w, narrow.h)
	}
	n, _ = press(t, n, "s")
	if !n.showUsage || !n.usageShown() {
		t.Fatal("narrow s must open the dedicated Usage view")
	}
	lines := strings.Split(stripAnsi(n.View()), "\n")
	if lineIndex(lines, "usage", "s · hide") < 0 || lineIndex(lines, "routing", "p · hide") >= 0 {
		t.Errorf("narrow s must show Usage, not Routing:\n%s", strings.Join(lines, "\n"))
	}
	n, _ = press(t, n, "s")
	if n.showUsage || !n.hideUsage || n.usageShown() {
		t.Fatal("second narrow s must return to the generator with Usage hidden")
	}
}

// TestUsageRestoreFallsBackToFullscreen locks the state transition at the
// responsive boundary where Routing fits only while Usage is hidden. Restoring
// Usage must choose its dedicated view immediately, then return to the exact
// generator-only composition instead of leaking Routing into view.
func TestUsageRestoreFallsBackToFullscreen(t *testing.T) {
	m := layoutModel()
	m.hideUsage = true
	m.collapse = true
	m.showResult = false

	withUsage := m
	withUsage.hideUsage = false
	w := withUsage.mediumMinW() - 1
	if w < routingMinW {
		t.Fatalf("fixture: fallback width %d is below Routing minimum %d", w, routingMinW)
	}
	m = resize(t, m, w, 40)
	if m.sizeMode() != sizeMedium || m.mode() != modeCollapsed {
		t.Fatalf("fixture: hidden Usage must leave a collapsed medium layout, size/mode = %d/%d", m.sizeMode(), m.mode())
	}

	m, _ = press(t, m, "s")
	if m.hideUsage || !m.showUsage || !m.usageShown() {
		t.Fatalf("first s must open Usage full-screen immediately: hidden=%v show=%v shown=%v", m.hideUsage, m.showUsage, m.usageShown())
	}
	full := strings.Split(stripAnsi(m.View()), "\n")
	if lineIndex(full, "usage", "s · hide") < 0 ||
		lineIndex(full, "generator") >= 0 ||
		lineIndex(full, "routing", "p · hide") >= 0 {
		t.Fatalf("fallback must render only Usage:\n%s", strings.Join(full, "\n"))
	}

	m, _ = press(t, m, "s")
	if !m.hideUsage || m.showUsage || !m.collapse || m.showResult {
		t.Fatalf("second s must restore prior generator state: hidden=%v show=%v collapse=%v result=%v", m.hideUsage, m.showUsage, m.collapse, m.showResult)
	}
	restored := strings.Split(stripAnsi(m.View()), "\n")
	if lineIndex(restored, "generator") < 0 || lineIndex(restored, "routing", "p · hide") >= 0 {
		t.Fatalf("return from Usage must restore generator without Routing:\n%s", strings.Join(restored, "\n"))
	}
}

// ── bottom-pinned section chrome · secondary separator · defaults cue ────────

// TestRoutingFallbackCuePinned locks the moved fallback-display cue: it is
// Routing BOTTOM chrome — the last body row, directly above the footer rule —
// in the wide split, the medium secondary row, and the narrow routing-only
// swap, always below the routing content it toggles.
func TestRoutingFallbackCuePinned(t *testing.T) {
	m := layoutModel()
	wide, medium, narrow, _ := layoutSizes(t, m)

	check := func(label string) {
		t.Helper()
		lines := strings.Split(stripAnsi(m.View()), "\n")
		cue := lineIndex(lines, "f · show fallback chains")
		title := lineIndex(lines, "routing", "p · hide")
		route := lineIndex(lines, "scout") // an agent-backed routing role row
		if cue < 0 || title < 0 || route < 0 {
			t.Fatalf("%s: missing cue (%d), title (%d), or route content (%d):\n%s",
				label, cue, title, route, strings.Join(lines, "\n"))
		}
		if !(title < route && route < cue) {
			t.Errorf("%s: want title (%d) above routes (%d) above the cue (%d)", label, title, route, cue)
		}
		if want := m.bodyH() - 1; cue != want {
			t.Errorf("%s: cue on line %d, want pinned to the last body row %d", label, cue, want)
		}
		if next := lines[cue+1]; !strings.HasPrefix(next, "─") {
			t.Errorf("%s: the footer rule must sit directly under the pinned cue, got %q", label, next)
		}
	}

	m = resize(t, m, wide.w, wide.h)
	check("wide")
	m = resize(t, m, medium.w, medium.h)
	check("medium")
	m = resize(t, m, narrow.w, narrow.h)
	m, _ = press(t, m, "p") // narrow: swap to the routing-only panel
	check("narrow routing-only")
}

// TestUsageCtrlRowPinned locks the moved refresh/profile control row: it is
// Usage BOTTOM chrome — the panel's last row, below every provider heading and
// usage bar — in the wide band and the medium column, and the loading /
// switch-failure variants keep that ordering (the error stays attached under
// the control that caused it).
func TestUsageCtrlRowPinned(t *testing.T) {
	m := accountModel()
	wide, medium, _, _ := layoutSizes(t, m)

	assertCtrlLast := func(label, panel string) {
		t.Helper()
		lines := strings.Split(panel, "\n")
		ctrl := lineIndex(lines, "r now", "v accounts")
		if ctrl < 0 {
			t.Fatalf("%s: control row missing:\n%s", label, panel)
		}
		if ctrl != len(lines)-1 {
			t.Errorf("%s: control row on line %d of %d, want the panel's last row:\n%s", label, ctrl, len(lines)-1, panel)
		}
		for _, needle := range []string{"Codex", "Claude", "% used"} {
			if idx := lineIndex(lines, needle); idx < 0 || idx > ctrl {
				t.Errorf("%s: %q (line %d) must sit above the control row (%d)", label, needle, idx, ctrl)
			}
		}
	}

	m = resize(t, m, wide.w, wide.h)
	assertCtrlLast("wide band", stripAnsi(m.usagePanel()))
	m = resize(t, m, medium.w, medium.h)
	assertCtrlLast("medium column", stripAnsi(m.usageColumn()))

	// The full medium view keeps the ordering: control row under every bar.
	lines := strings.Split(stripAnsi(m.View()), "\n")
	ctrl := lineIndex(lines, "r now", "v accounts")
	lastUsed := -1
	for i, l := range lines {
		if strings.Contains(l, "% used") {
			lastUsed = i
		}
	}
	if ctrl < 0 || lastUsed < 0 || ctrl < lastUsed {
		t.Errorf("medium view: control row (%d) must render below the last usage bar (%d)", ctrl, lastUsed)
	}

	// Loading: the status row replaces the countdown but stays pinned last.
	loading := accountModel()
	loading.avail = availability{bucket: map[string]string{}, reset: map[string]int64{}}
	loading.fetching = true
	llines := strings.Split(stripAnsi(loading.usagePanel()), "\n")
	if status := lineIndex(llines, "fetching usage…"); status != len(llines)-1 {
		t.Errorf("loading: status row on line %d of %d, want last:\n%s", status, len(llines)-1, strings.Join(llines, "\n"))
	}

	// Account persistence failure attaches directly under the control row.
	failed := accountModel()
	failed.accountErr = "state write denied"
	flines := strings.Split(stripAnsi(failed.usagePanel()), "\n")
	errLine := lineIndex(flines, "account update failed: state write denied")
	fctrl := lineIndex(flines, "r now", "v accounts")
	if errLine != len(flines)-1 || fctrl != errLine-1 {
		t.Errorf("account failure must sit directly under the bottom control row (ctrl %d, err %d of %d):\n%s",
			fctrl, errLine, len(flines)-1, strings.Join(flines, "\n"))
	}
}

// TestMediumSecondarySeparator locks the medium secondary row's pane contract:
// Usage is always the LEFT pane and Routing the RIGHT, and a visible one-cell
// │ border column separates them on every secondary row at exactly the usage
// column's favored share. Hiding usage removes both the left pane and the
// separator.
func TestMediumSecondarySeparator(t *testing.T) {
	m := layoutModel()
	_, medium, _, _ := layoutSizes(t, m)
	m = resize(t, m, medium.w, medium.h)
	if m.mode() != modeMedium {
		t.Fatalf("fixture: %dx%d must be medium, mode = %d", medium.w, medium.h, m.mode())
	}
	lines := strings.Split(stripAnsi(m.View()), "\n")
	head := lineIndex(lines, "routing", "usage")
	if head < 0 {
		t.Fatalf("routing and usage titles must share the secondary row:\n%s", strings.Join(lines, "\n"))
	}
	row := lines[head]
	if strings.Index(row, "usage") > strings.Index(row, "routing") {
		t.Errorf("usage must be the left pane and routing the right: %q", row)
	}
	uw := m.w - m.routingColW() - secSepW
	genH, secH := m.mediumSplit(m.contentH())
	first := topGap + genH + 1 // the row right under the full-width divider
	for i := first; i < first+secH; i++ {
		// usage rows carry zero-width runes (the ↻︎ variation selector), so
		// locate the separator and measure its display column, not rune index.
		p := strings.IndexRune(lines[i], '│')
		if p < 0 {
			t.Errorf("secondary row %d: missing the │ separator: %q", i, lines[i])
			continue
		}
		if col := lipgloss.Width(lines[i][:p]); col != uw {
			t.Errorf("secondary row %d: separator at display column %d, want %d: %q", i, col, uw, lines[i])
		}
	}
	if p := strings.IndexRune(row, '│'); p < 0 {
		t.Errorf("the title row must carry the separator between the panes: %q", row)
	} else if u := strings.Index(row, "routing"); u >= 0 && u < p {
		t.Errorf("routing must sit right of the separator: %q", row)
	}

	m, _ = press(t, m, "s") // hiding usage removes the left pane AND the border
	if view := stripAnsi(m.View()); strings.ContainsRune(view, '│') {
		t.Errorf("no separator may remain once usage hides:\n%s", view)
	}
	assertLayoutInvariants(t, m, "medium separator hidden usage")
}

// TestGeneratorDefaultsCue locks the d · defaults placement: the cue lives in
// the Generator title row in every composition that shows the Generator, the
// compact help therefore drops the duplicate, the narrow routing-only swap
// (Generator hidden) restores the action to the compact line, and the full
// help always lists the binding.
func TestGeneratorDefaultsCue(t *testing.T) {
	m := accountModel()
	wide, medium, narrow, _ := layoutSizes(t, m)
	for _, tc := range []struct {
		label string
		s     termSize
	}{{"wide", wide}, {"medium", medium}, {"narrow", narrow}} {
		m = resize(t, m, tc.s.w, tc.s.h)
		lines := strings.Split(stripAnsi(m.View()), "\n")
		if lineIndex(lines, "generator", "d · defaults") < 0 {
			t.Errorf("%s: the generator title must carry the d · defaults cue:\n%s", tc.label, strings.Join(lines, "\n"))
		}
		if hasDesc(shortDescs(m), gReset+" defaults") {
			t.Errorf("%s: the compact help must not repeat defaults while the title advertises it", tc.label)
		}
	}

	m = resize(t, m, narrow.w, narrow.h)
	swapped, _ := press(t, m, "p") // routing full-screen: generator (and its title cue) hidden
	lines := strings.Split(stripAnsi(swapped.View()), "\n")
	if lineIndex(lines, "d · defaults") >= 0 {
		t.Errorf("routing-only: no generator title on screen, so no title cue:\n%s", strings.Join(lines, "\n"))
	}
	if !hasDesc(shortDescs(swapped), gReset+" defaults") {
		t.Errorf("routing-only: the compact help must recover the defaults action: %v", shortDescs(swapped))
	}

	found := false
	for _, group := range keys.FullHelp() {
		for _, b := range group {
			if len(b.Keys()) == 1 && b.Keys()[0] == "d" {
				found = true
			}
		}
	}
	if !found {
		t.Error("the full help must always list the d binding")
	}
}

// TestLaunchFooterShape locks the generator footer: cost and speed meters, a
// blank separator row, then the shortened ⏎ launch action with its managed /
// sandbox alternatives — exactly launchFooterRows rows, action pinned last.
func TestLaunchFooterShape(t *testing.T) {
	m := layoutModel()
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)
	rows := m.launchFooter()
	if len(rows) != launchFooterRows {
		t.Fatalf("launch footer is %d rows, launchFooterRows says %d", len(rows), launchFooterRows)
	}
	plain := make([]string, len(rows))
	for i, r := range rows {
		plain[i] = stripAnsi(r)
	}
	if !strings.Contains(plain[1], "cost") || !strings.Contains(plain[2], "speed") {
		t.Errorf("the meters must lead the footer: %q", plain)
	}
	if strings.TrimSpace(plain[3]) != "" {
		t.Errorf("a blank row must separate the meters from the action, got %q", plain[3])
	}
	last := plain[len(plain)-1]
	if !strings.Contains(last, "⏎ launch") || strings.Contains(last, "launch generated profile") {
		t.Errorf("the action label must be the shortened ⏎ launch, got %q", last)
	}
	if !strings.Contains(last, "m managed omp · u sandbox") {
		t.Errorf("the managed/sandbox alternatives must stay on the action row, got %q", last)
	}
}

// ── reset-credit urgency tint ────────────────────────────────────────────────

// TestCreditExpiryUrgency locks the credit-line tint boundaries: expiries are
// bucketed on the same rounded-up whole days fmtDays renders — muted red
// through creditUrgentDays, muted amber through creditSoonDays, muted green
// beyond — and the text alone stays sufficient (count, ascending days) with
// the prose dim regardless of tint.
func TestCreditExpiryUrgency(t *testing.T) {
	cases := []struct {
		secs int64
		want lipgloss.Style
		name string
	}{
		{0, stCreditUrgent, "expired"},
		{1, stCreditUrgent, "later today (1d)"},
		{creditUrgentDays * day, stCreditUrgent, "exactly 3d"},
		{creditUrgentDays*day + 1, stCreditSoon, "just past 3d (4d)"},
		{creditSoonDays * day, stCreditSoon, "exactly 10d"},
		{creditSoonDays*day + 1, stCreditSafe, "just past 10d (11d)"},
	}
	for _, c := range cases {
		if got := creditDayStyle(c.secs); got.GetForeground() != c.want.GetForeground() {
			t.Errorf("%s (%ds): tint = %v, want %v", c.name, c.secs, got.GetForeground(), c.want.GetForeground())
		}
	}
	// The three buckets are visually distinct, precomputed colors.
	if stCreditUrgent.GetForeground() == stCreditSoon.GetForeground() ||
		stCreditSoon.GetForeground() == stCreditSafe.GetForeground() {
		t.Error("urgency tints must be distinct palette entries")
	}

	// Text sufficiency: the stripped line carries count and ascending days.
	m := layoutModel()
	m.avail.accountCredits[accountKey{Provider: "openai-codex", IdentityKey: "codex"}] = resetCredits{
		avail: 2, exp: []int64{30 * day, 2 * day, 8 * day},
	}
	line := stripAnsi(m.creditLine())
	if !strings.Contains(line, "2 resets") || !strings.Contains(line, "expiring in 2d, 8d, 30d") {
		t.Errorf("credit line text must stay sufficient without color: %q", line)
	}
}

func TestUsageRowsAllocateEverySafeCellToTheBar(t *testing.T) {
	m := layoutModel()
	specs := []usageRowSpec{
		m.usageRowSpec(usageWin{label: "5 hours", pct: 37, secs: 2 * 3600, dur: 5 * 3600}, "  "),
		m.usageRowSpec(usageWin{label: "7 days", pct: 100, secs: 30 * 60, dur: 7 * day}, "  "),
	}

	natural := renderUsageRows(0, specs)
	for i, row := range natural {
		if got := strings.Count(stripAnsi(row), "█") + strings.Count(stripAnsi(row), "░"); got != usageBarNaturalW {
			t.Fatalf("natural row %d bar width = %d, want %d: %q", i, got, usageBarNaturalW, stripAnsi(row))
		}
	}

	const width = 84
	rows := renderUsageRows(width, specs)
	barWidth := usageRowsBarWidth(width, specs)
	if barWidth <= usageBarNaturalW {
		t.Fatalf("wide bar width = %d, want growth beyond %d", barWidth, usageBarNaturalW)
	}
	for i, row := range rows {
		plain := stripAnsi(row)
		if got := strings.Count(plain, "█") + strings.Count(plain, "░"); got != barWidth {
			t.Errorf("row %d rendered %d bar cells, want shared width %d: %q", i, got, barWidth, plain)
		}
		if got := strings.Index(plain, "% used"); got != strings.Index(stripAnsi(rows[0]), "% used") {
			t.Errorf("row %d percentage column = %d, want %d: %q", i, got, strings.Index(stripAnsi(rows[0]), "% used"), plain)
		}
		if got := strings.Index(plain, gReset); got != strings.Index(stripAnsi(rows[0]), gReset) {
			t.Errorf("row %d reset column = %d, want %d: %q", i, got, strings.Index(stripAnsi(rows[0]), gReset), plain)
		}
		if lipgloss.Width(row) > width {
			t.Errorf("row %d width = %d, assigned %d: %q", i, lipgloss.Width(row), width, plain)
		}
	}
	if got := lipgloss.Width(rows[1]); got != width {
		t.Errorf("widest reserved suffix consumed %d cells, want exact assigned width %d", got, width)
	}
	if plain := stripAnsi(rows[1]); !strings.Contains(plain, "100% used") ||
		!strings.Contains(plain, gReset+" "+pad(fmtReset(30*60), 4)) ||
		!strings.Contains(plain, "maxed") {
		t.Errorf("wide composition changed percentage/reset/note grammar: %q", plain)
	}
}

func TestUsageRowsReserveResetValueWidthBeforeStatus(t *testing.T) {
	m := layoutModel()
	rows := renderUsageRows(100, []usageRowSpec{
		m.usageRowSpec(usageWin{label: "7 days", pct: 89, secs: 3*day + 12*3600, dur: 7 * day}, "  "),
		m.usageRowSpec(usageWin{label: "7 days", pct: 82, secs: 2*day + 9*3600, dur: 7 * day}, "  "),
	})
	first, second := stripAnsi(rows[0]), stripAnsi(rows[1])
	if firstTight, secondTight := strings.Index(first, "tight"), strings.Index(second, "tight"); firstTight != secondTight {
		t.Errorf("status suffixes lost reset-column alignment: first=%d second=%d\n%s\n%s",
			firstTight, secondTight, first, second)
	}
}

func TestUsageProviderColumnsReceiveWidthBeforeBars(t *testing.T) {
	m := layoutModel()
	left := usageRenderGroup{
		prefix: []string{"  Claude", "  usage unavailable"},
		rows: []usageRowSpec{
			m.usageRowSpec(usageWin{label: "5 hours", pct: 20, secs: 2 * 3600, dur: 5 * 3600}, "  "),
			m.usageRowSpec(usageWin{label: "7 days", pct: 100, secs: 30 * 60, dur: 7 * day}, "  "),
		},
	}
	right := usageRenderGroup{
		prefix: []string{"  Codex"},
		rows: []usageRowSpec{
			m.usageRowSpec(usageWin{label: "5 hours", pct: 40, secs: 2 * 3600, dur: 5 * 3600}, "  "),
			m.usageRowSpec(usageWin{label: "7 days", pct: 60, secs: 5 * day, dur: 7 * day}, "  "),
		},
	}
	blocks := map[string]usageRenderGroup{"left": left, "right": right}
	order := []string{"left", "right"}

	stacked := layoutGroups(80, order, blocks, true)
	if got := lipgloss.Width(stacked); got != 80 {
		t.Fatalf("stacked groups width = %d, want the available section width 80", got)
	}
	sideBySide := layoutGroups(120, order, blocks, false)
	if got := lipgloss.Width(sideBySide); got != 120 {
		t.Fatalf("side-by-side groups width = %d, want exact panel width 120", got)
	}
	if lipgloss.Height(sideBySide) >= lipgloss.Height(stacked) {
		t.Fatalf("120 cells did not switch provider groups side by side: stacked=%d rows side=%d rows",
			lipgloss.Height(stacked), lipgloss.Height(sideBySide))
	}
	sideLines := strings.Split(stripAnsi(sideBySide), "\n")
	if len(sideLines) < 3 || !strings.Contains(sideLines[1], "usage unavailable") ||
		strings.Contains(sideLines[1], "% used") || strings.Count(sideLines[2], "% used") != 2 {
		t.Fatalf("uneven provider status rows did not align the first usage bars:\n%s", stripAnsi(sideBySide))
	}
	for name, panel := range map[string]string{"stacked": stacked, "side-by-side": sideBySide} {
		barWidth := -1
		for _, line := range strings.Split(stripAnsi(panel), "\n") {
			width := strings.Count(line, "█") + strings.Count(line, "░")
			if width == 0 {
				continue
			}
			if barWidth < 0 {
				barWidth = width
			} else if width != barWidth {
				t.Errorf("%s provider bars have divergent widths: first=%d row=%d: %q", name, barWidth, width, line)
			}
		}
		if barWidth <= usageBarNaturalW {
			t.Errorf("%s provider bars did not grow beyond %d cells: %d", name, usageBarNaturalW, barWidth)
		}
	}
}

func TestUsageLoadingAndRealRowsFillTheSameAssignedGeometry(t *testing.T) {
	loading := layoutModel()
	loading.avail = availability{bucket: map[string]string{}, reset: map[string]int64{}}
	loading.fetching = true
	loaded := layoutModel()
	loaded.avail, _ = reconcileUsage(availability{bucket: map[string]string{}, reset: map[string]int64{}}, loaded.avail)

	for _, width := range []int{80, 120} {
		loadingBody := loading.usageBodyFor(width)
		loadedBody := loaded.usageBodyFor(width)
		if got := lipgloss.Width(loadingBody); got != width {
			t.Errorf("loading body at %d cells uses %d", width, got)
		}
		if got := lipgloss.Width(loadedBody); got != width {
			t.Errorf("real body at %d cells uses %d", width, got)
		}
		for state, body := range map[string]string{"loading": loadingBody, "real": loadedBody} {
			for _, line := range strings.Split(body, "\n") {
				if lipgloss.Width(line) > width {
					t.Errorf("%s line overflows %d cells at width %d: %q", state, lipgloss.Width(line), width, stripAnsi(line))
				}
			}
		}
	}

	// A tier-scoped tag is the widest label the grammar has to hold, so it is
	// the one worth comparing the skeleton against.
	skeleton := renderUsageRows(80, []usageRowSpec{skeletonUsageRowSpec("5h spark", "  ")})[0]
	missing := renderUsageRows(80, []usageRowSpec{loaded.usageRowSpec(usageWin{
		label: "5 hours (Spark)", id: "5h", tier: "spark", missing: true,
	}, "  ")})[0]
	skeletonPlain, missingPlain := stripAnsi(skeleton), stripAnsi(missing)
	if lipgloss.Width(skeleton) != lipgloss.Width(missing) ||
		strings.Index(skeletonPlain, "% used") != strings.Index(missingPlain, "% used") ||
		strings.Index(skeletonPlain, gReset) != strings.Index(missingPlain, gReset) {
		t.Errorf("skeleton/missing geometry diverged:\nskeleton %q\nmissing  %q", skeletonPlain, missingPlain)
	}
}

func TestUsageAnimationFillScalesWithDynamicBarWidth(t *testing.T) {
	m := layoutModel()
	win := usageWin{label: "5 hours", pct: 55, secs: 2 * 3600, dur: 5 * 3600}
	const width = 90
	fullSpec := m.usageRowSpec(win, "  ")
	barWidth := usageRowsBarWidth(width, []usageRowSpec{fullSpec})
	if barWidth <= usageBarNaturalW {
		t.Fatalf("fixture bar width = %d, want dynamic growth", barWidth)
	}
	for _, step := range []int{1, barAnimSteps / 2, barAnimSteps - 1} {
		m.barAnim = step
		spec := m.usageRowSpec(win, "  ")
		row := stripAnsi(renderUsageRows(width, []usageRowSpec{spec})[0])
		wantFill := (spec.barPct*barWidth + 50) / 100
		if got := strings.Count(row, "█"); got != wantFill {
			t.Errorf("step %d fill = %d, want %d of dynamic %d-cell bar: %q", step, got, wantFill, barWidth, row)
		}
		if got := strings.Count(row, "█") + strings.Count(row, "░"); got != barWidth {
			t.Errorf("step %d bar width = %d, want stable %d", step, got, barWidth)
		}
		if lipgloss.Width(row) != width {
			t.Errorf("step %d row width = %d, want %d", step, lipgloss.Width(row), width)
		}
	}
}

// ── loading skeleton · first-load bar fill ───────────────────────────────────

// TestUsageSkeleton locks the pre-first-fetch Usage shape: provider-only
// headings, explicit checking state, generic placeholder window rows, and the
// loading status pinned to the panel's last row.
func TestUsageSkeleton(t *testing.T) {
	loading := layoutModel()
	loading.avail = availability{bucket: map[string]string{}, reset: map[string]int64{}}
	loading.fetching = true

	panel := stripAnsi(loading.usagePanel())
	lines := strings.Split(panel, "\n")
	for _, h := range []string{"Codex", "Claude"} {
		if lineIndex(lines, h) < 0 {
			t.Errorf("skeleton must keep the provider heading %q:\n%s", h, panel)
		}
	}
	if got := strings.Count(panel, "checking account…"); got != 2 {
		t.Errorf("skeleton must show one checking state per provider, got %d:\n%s", got, panel)
	}
	// The skeleton reserves exactly the windows each provider declares
	// (SkeletonWins) — two apiece — and nothing more. It used to reserve a third
	// Anthropic row for a window the provider has since retired, so the panel
	// kept promising a row that would never come.
	if got := strings.Count(panel, "··% used"); got != 4 {
		t.Errorf("want each metered provider's two declared windows (4 total), got %d:\n%s", got, panel)
	}
	if regexp.MustCompile(`\d+% used`).MatchString(panel) {
		t.Errorf("the skeleton must not fabricate numeric values:\n%s", panel)
	}
	if strings.Contains(panel, "█") {
		t.Errorf("skeleton bars must be empty:\n%s", panel)
	}
	if status := lineIndex(lines, "fetching usage…"); status != len(lines)-1 {
		t.Errorf("the loading status must stay pinned to the panel's last row (%d of %d):\n%s", status, len(lines)-1, panel)
	}
	loaded := layoutModel()
	loaded.avail, _ = reconcileUsage(availability{bucket: map[string]string{}, reset: map[string]int64{}}, loaded.avail)
	if sh, lh := lipgloss.Height(loading.usageColumn()), lipgloss.Height(loaded.usageColumn()); sh != lh {
		t.Errorf("skeleton column is %d rows, reconciled loaded column %d — the first fetch would pop the layout", sh, lh)
	}

	wide, medium, _, _ := layoutSizes(t, loading)
	loading = resize(t, loading, wide.w, wide.h)
	assertLayoutInvariants(t, loading, "skeleton wide")
	loading = resize(t, loading, medium.w, medium.h)
	assertLayoutInvariants(t, loading, "skeleton medium")

	bare := layoutModel()
	bare.broker = brokerConfig{}
	bare.avail = availability{bucket: map[string]string{}, reset: map[string]int64{}}
	if p := stripAnsi(bare.usagePanel()); strings.Contains(p, "··% used") {
		t.Errorf("runs without a broker must stay neutral, not show the skeleton:\n%s", p)
	}
}

// TestFirstLoadBarFill locks the one-time central fill: the first successful
// usageMsg starts a bounded 150–250ms tick sequence, preserves layout, and
// subsequent refreshes never re-animate.
func TestFirstLoadBarFill(t *testing.T) {
	if d := time.Duration(barAnimSteps) * barAnimInterval; d < 150*time.Millisecond || d > 250*time.Millisecond {
		t.Fatalf("first-load fill runs %v, want 150–250ms", d)
	}

	loaded := layoutModel().avail
	m := layoutModel()
	m.avail = availability{bucket: map[string]string{}, reset: map[string]int64{}}
	m.fetching = true
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)

	nm, cmd := m.Update(usageMsg{avail: loaded})
	m = nm.(model)
	if m.barAnim != 1 || cmd == nil {
		t.Fatalf("the first successful result must start the fill: step %d, cmd nil = %v", m.barAnim, cmd == nil)
	}

	win := loaded.wins[2] // anthropic 5h at 55% — a mid-scale target
	full := m
	full.barAnim = 0
	fullRow := stripAnsi(full.usageRow(win))
	if !strings.Contains(fullRow, " 55% used") {
		t.Fatalf("fixture: %q", fullRow)
	}
	fullFill := strings.Count(fullRow, "█")
	prev := -1
	for step := 1; step < barAnimSteps; step++ {
		m.barAnim = step
		row := stripAnsi(m.usageRow(win))
		if !strings.Contains(row, " 55% used") {
			t.Errorf("step %d: the percentage text must be real during the fill: %q", step, row)
		}
		if lipgloss.Width(row) != lipgloss.Width(fullRow) {
			t.Errorf("step %d: row width %d changed from %d — the fill must not reflow", step, lipgloss.Width(row), lipgloss.Width(fullRow))
		}
		fill := strings.Count(row, "█")
		if fill < prev || fill > fullFill {
			t.Errorf("step %d: fill %d must grow monotonically toward %d (prev %d)", step, fill, fullFill, prev)
		}
		prev = fill
	}

	// Drive the dedicated tick sequence to completion — bounded, no network.
	m.barAnim = 1
	steps := 0
	for m.barAnim != 0 {
		nm, cmd = m.Update(barAnimMsg{step: m.barAnim + 1})
		m = nm.(model)
		if steps++; steps > barAnimSteps {
			t.Fatal("the fill must self-terminate within barAnimSteps ticks")
		}
	}
	if cmd != nil {
		t.Error("the final frame must not arm another tick")
	}
	if row := stripAnsi(m.usageRow(win)); row != fullRow {
		t.Errorf("after completion bars must render at full value:\n got %q\nwant %q", row, fullRow)
	}

	mid := m
	mid.barAnim = barAnimSteps / 2
	assertLayoutInvariants(t, mid, "mid-fill wide")

	nm, cmd = m.Update(usageMsg{avail: loaded})
	m = nm.(model)
	if cmd != nil || m.barAnim != 0 {
		t.Error("refreshes must never re-run the fill")
	}
}

// TestRoutingWheelScroll locks the pointer-aware wheel dispatch: inside the
// visible Routing pane vertical wheel scrolls the viewport continuously —
// ungated, clamped at both ends, inverted to match the operator-confirmed
// trackpad direction, horizontal inert — in the wide right pane, medium's
// lower-right pane, and the narrow routing-only swap, while the generator
// keeps the detented wheel everywhere else and no scroll ever touches the
// facet selection.
func TestRoutingWheelScroll(t *testing.T) {
	long := layoutModel()
	id := comboID(defaultSel())
	rows := []string{"  thinking medium · fallback on · advisor on"}
	for i := range 60 {
		rows = append(rows, fmt.Sprintf("    role%02d     gpt-5.6-terra:medium", i))
	}
	long.generated[id] = rows
	wide, medium, narrow, _ := layoutSizes(t, long)

	wheel := func(m model, b tea.MouseButton, x, y int) model {
		t.Helper()
		nm, cmd := m.Update(tea.MouseMsg{Action: tea.MouseActionPress, Button: b, X: x, Y: y})
		if cmd != nil {
			t.Fatal("wheel input must never produce a command")
		}
		return nm.(model)
	}

	// Wide: the right pane scrolls continuously; the generator side steps.
	m := resize(t, long, wide.w, wide.h)
	rx, ry := m.listW()+4, topGap+4
	for i := 1; i <= 3; i++ { // consecutive events — no gate, no pause needed
		m = wheel(m, tea.MouseButtonWheelUp, rx, ry)
		if m.vp.YOffset != i {
			t.Fatalf("wide event %d: YOffset = %d, want continuous scroll to %d", i, m.vp.YOffset, i)
		}
	}
	if m.fcur != 0 {
		t.Fatalf("routing scroll must not move the generator selection, fcur = %d", m.fcur)
	}
	lane := m.sel["lane"]
	m = wheel(m, tea.MouseButtonWheelLeft, rx, ry) // horizontal over routing: inert
	if m.sel["lane"] != lane || m.vp.YOffset != 3 {
		t.Fatal("horizontal wheel over routing must be ignored entirely")
	}
	m = wheel(m, tea.MouseButtonWheelDown, rx, ry)
	if m.vp.YOffset != 2 {
		t.Fatalf("wheel down over routing must scroll back (inverted), YOffset = %d", m.vp.YOffset)
	}
	for range 10 { // clamped at the top …
		m = wheel(m, tea.MouseButtonWheelDown, rx, ry)
	}
	if m.vp.YOffset != 0 {
		t.Fatalf("scroll must clamp at the top, YOffset = %d", m.vp.YOffset)
	}
	for range 200 { // … and at the bottom.
		m = wheel(m, tea.MouseButtonWheelUp, rx, ry)
	}
	if maxOff := m.vp.TotalLineCount() - m.vp.Height; m.vp.YOffset > maxOff {
		t.Fatalf("scroll must clamp at the bottom: YOffset %d > max %d", m.vp.YOffset, maxOff)
	}
	m = wheel(m, tea.MouseButtonWheelUp, 2, topGap+2) // generator side: detented step
	if m.fcur != 1 {
		t.Fatalf("generator wheel outside routing must step the selection, fcur = %d", m.fcur)
	}

	// Medium: only the lower-right secondary pane scrolls routing; the usage
	// pane left of the separator belongs to the generator wheel.
	m = resize(t, long, medium.w, medium.h)
	genH, _ := m.mediumSplit(m.contentH())
	m = wheel(m, tea.MouseButtonWheelUp, 2, topGap+genH+2) // over the left usage pane
	if m.vp.YOffset != 0 || m.fcur != 1 {
		t.Fatalf("medium: wheel over the usage pane must step the generator, never scroll routing (YOffset %d, fcur %d)", m.vp.YOffset, m.fcur)
	}
	m = wheel(m, tea.MouseButtonWheelUp, m.w-2, topGap+genH+2) // right of the separator
	if m.vp.YOffset != 1 || m.fcur != 1 {
		t.Fatalf("medium: wheel in the lower-right pane must scroll routing only (YOffset %d, fcur %d)", m.vp.YOffset, m.fcur)
	}

	// Narrow routing-only: the whole body scrolls; facets stay untouched.
	m = resize(t, long, narrow.w, narrow.h)
	m, _ = press(t, m, "p")
	sel := fmt.Sprint(m.sel)
	m = wheel(m, tea.MouseButtonWheelUp, 3, topGap+3)
	m = wheel(m, tea.MouseButtonWheelUp, 3, topGap+3)
	if m.vp.YOffset != 2 {
		t.Fatalf("narrow routing-only: want continuous scroll, YOffset = %d", m.vp.YOffset)
	}
	if fmt.Sprint(m.sel) != sel || m.fcur != 0 {
		t.Fatal("routing-only scroll must never touch the generator state")
	}
}

// TestMediumFavoredUsageShare locks medium's secondary width allocation:
// Usage is the favored pane — it takes the larger share of the row and never
// less than its measured stacked column — while Routing is the pane that
// shrinks, floored at routingMinW, and every representative medium width
// renders without a single auto-wrapped line.
func TestMediumFavoredUsageShare(t *testing.T) {
	m := layoutModel()
	wideW := m.genRowWidth() + routingMinW
	minW := m.mediumMinW()
	for _, w := range []int{minW, minW + (wideW-minW)/2, wideW - 1} {
		m = resize(t, m, w, 40)
		if m.mode() != modeMedium {
			t.Fatalf("width %d: mode = %d, want medium", w, m.mode())
		}
		rw := m.routingColW()
		uw := m.w - rw - secSepW
		if rw < routingMinW {
			t.Errorf("width %d: routing share %d lost its useful minimum %d", w, rw, routingMinW)
		}
		if uw <= rw {
			t.Errorf("width %d: usage share %d must exceed routing's %d — usage is the favored pane", w, uw, rw)
		}
		if min := m.usageColW(); uw < min {
			t.Errorf("width %d: usage share %d clips its measured column %d", w, uw, min)
		}
		assertLayoutInvariants(t, m, fmt.Sprintf("medium favored usage width %d", w))
	}
}

// TestUsageCtrlBlankRow: exactly one blank visual row separates the provider
// content — including an extra window beyond the two a provider declares — from
// the bottom refresh/hotkey control line, in the wide band and medium's stacked
// column alike. The extra row is deliberately a tier-scoped window the registry
// does not model: the panel renders what the payload reports, so a provider
// adding a window must not change the chrome around the rows.
func TestUsageCtrlBlankRow(t *testing.T) {
	m := accountModel()
	key := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	m.avail.accountUsage[key] = append(m.avail.accountUsage[key],
		usageWin{label: "Claude 7 Day (Fable)", id: "7d", pct: 40, tier: "fable", secs: 4 * day, dur: 7 * day, prov: "anthropic"})
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)
	for _, tc := range []struct{ label, panel string }{
		{"wide band", stripAnsi(m.usagePanel())},
		{"medium column", stripAnsi(m.usageColumn())},
	} {
		lines := strings.Split(tc.panel, "\n")
		if lineIndex(lines, "7d fable") < 0 {
			t.Fatalf("%s: fixture extra-window row missing:\n%s", tc.label, tc.panel)
		}
		ctrl := lineIndex(lines, "r now")
		if ctrl < 2 {
			t.Fatalf("%s: control row missing:\n%s", tc.label, tc.panel)
		}
		if strings.TrimSpace(lines[ctrl-1]) != "" {
			t.Errorf("%s: want a blank row above the control line, got %q", tc.label, lines[ctrl-1])
		}
		if strings.TrimSpace(lines[ctrl-2]) == "" {
			t.Errorf("%s: want exactly one blank row — content directly above it, got %q", tc.label, lines[ctrl-2])
		}
	}
}

// TestReconcileUsageRetainsOmittedAccountAndPrefersFreshWindows is the
// repointed successor to the fable-window retention test. The provider-specific
// reservation it defended is gone — window vocabulary belongs to the payload now
// — but the retention contract underneath it survives at the account seam, and
// it is the seam that keeps a flaky upstream from wiping known-good data:
//
//   - an account the successful payload omits entirely keeps its last observed
//     rows, marked stale and rendered with their age, so a partial report never
//     reads as "no usage";
//   - an account that DID report keeps only what it reported. Retention is
//     all-or-nothing per account, deliberately: topping a fresh report up with
//     remembered windows is how a retired window used to survive forever.
func TestReconcileUsageRetainsOmittedAccountAndPrefersFreshWindows(t *testing.T) {
	claude := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	codex := accountKey{Provider: "openai-codex", IdentityKey: "codex"}
	accounts := map[string][]account{
		"anthropic":    {{Provider: claude.Provider, IdentityKey: claude.IdentityKey, Email: "claude@example.test"}},
		"openai-codex": {{Provider: codex.Provider, IdentityKey: codex.IdentityKey, Email: "codex@example.test"}},
	}
	observed := time.Now().Add(-90 * time.Minute).Unix()
	prev := availability{
		ok: true, accountsOK: true,
		bucket: map[string]string{}, reset: map[string]int64{},
		accounts: accounts,
		accountUsage: map[accountKey][]usageWin{
			claude: {
				{label: "5 hours", id: "5h", pct: 10, secs: 3600, dur: 5 * 3600, prov: "anthropic", observed: observed},
				{label: "7 days", id: "7d", pct: 100, secs: 9000, dur: 7 * day, prov: "anthropic", observed: observed},
			},
			codex: {
				{label: "5 hours", id: "5h", pct: 12, secs: 3600, dur: 5 * 3600, prov: "openai-codex"},
				{label: "7 days", id: "7d", pct: 33, secs: 6 * day, dur: 7 * day, prov: "openai-codex"},
			},
		},
	}
	next := availability{
		ok: true, accountsOK: true,
		bucket: map[string]string{}, reset: map[string]int64{},
		accounts: accounts,
		accountUsage: map[accountKey][]usageWin{
			// Anthropic is missing from this report; Codex reported one window.
			codex: {{label: "5 hours", id: "5h", pct: 20, secs: 3000, dur: 5 * 3600, prov: "openai-codex"}},
		},
	}
	got, stale := reconcileUsage(prev, next)
	if stale {
		t.Fatal("a successful refresh must not mark the whole panel stale")
	}

	retained := got.accountUsage[claude]
	if len(retained) != 2 {
		t.Fatalf("the omitted account's windows must be retained: %+v", retained)
	}
	for _, w := range retained {
		if !w.stale || w.missing || w.observed != observed {
			t.Errorf("retained row must carry the last observed value marked stale: %+v", w)
		}
	}
	if retained[1].pct != 100 || retained[1].secs != 9000 {
		t.Errorf("retained values were rewritten: %+v", retained[1])
	}

	fresh := got.accountUsage[codex]
	if len(fresh) != 1 || fresh[0].pct != 20 || fresh[0].stale {
		t.Errorf("a reporting account must keep exactly what it reported, got %+v", fresh)
	}

	m := layoutModel()
	row := stripAnsi(m.usageRow(retained[1]))
	if !strings.Contains(row, "7d") ||
		!strings.Contains(row, "cached ") ||
		!strings.Contains(row, " ago") {
		t.Errorf("the retained row must carry its relative cache age: %q", row)
	}
	if !strings.Contains(row, "100% used") {
		t.Errorf("the retained row must show the last observed value: %q", row)
	}
}

func TestFormatCachedAge(t *testing.T) {
	now := time.Unix(2_000_000_000, 0)
	tests := []struct {
		name     string
		observed int64
		want     string
	}{
		{name: "future clock skew", observed: now.Unix() + 30, want: "<1m ago"},
		{name: "seconds", observed: now.Unix() - 59, want: "<1m ago"},
		{name: "minutes", observed: now.Unix() - 5*60, want: "5m ago"},
		{name: "hours", observed: now.Unix() - 3*60*60, want: "3h ago"},
		{name: "days", observed: now.Unix() - 2*24*60*60, want: "2d ago"},
		{name: "weeks", observed: now.Unix() - 21*24*60*60, want: "3w ago"},
		{name: "years", observed: now.Unix() - 2*365*24*60*60, want: "2y ago"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := formatCachedAge(tt.observed, now); got != tt.want {
				t.Fatalf("formatCachedAge() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestReconcileUsageFabricatesNoWindows replaces the fable-placeholder test.
// That seam used to synthesise an "unavailable" row for one provider-specific
// window that had never been observed, so a late-arriving datum could not pop the
// panel geometry. The reservation outlived the window: after the provider retired
// it, the panel kept promising a row that would never come back. What must now be
// true is the inverse property, and it is worth a test precisely because the old
// behaviour was deliberate — reconcile passes the payload's windows through and
// invents nothing.
func TestReconcileUsageFabricatesNoWindows(t *testing.T) {
	claude := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	empty := availability{bucket: map[string]string{}, reset: map[string]int64{}}
	next := availability{
		ok: true, accountsOK: true,
		bucket: map[string]string{}, reset: map[string]int64{},
		accounts: map[string][]account{
			"anthropic": {{Provider: claude.Provider, IdentityKey: claude.IdentityKey, Email: "claude@example.test"}},
		},
		accountUsage: map[accountKey][]usageWin{
			claude: {{label: "5 hours", id: "5h", pct: 20, secs: 3000, dur: 5 * 3600, prov: "anthropic"}},
		},
		wins: []usageWin{{label: "5 hours", id: "5h", pct: 20, secs: 3000, dur: 5 * 3600, prov: "anthropic"}},
	}
	got, stale := reconcileUsage(empty, next)
	if stale {
		t.Fatal("a successful first fetch must not read stale")
	}
	if len(got.wins) != 1 || len(got.accountUsage[claude]) != 1 {
		t.Fatalf("reconcile invented a window the payload never reported: wins=%+v account=%+v",
			got.wins, got.accountUsage[claude])
	}
	for _, w := range append(append([]usageWin(nil), got.wins...), got.accountUsage[claude]...) {
		if w.missing || w.stale {
			t.Errorf("a freshly reported window must not be marked missing or stale: %+v", w)
		}
	}
	// A window appearing later is an ordinary payload change, not a slot being
	// filled: it simply shows up.
	grown := next
	grown.accountUsage = map[accountKey][]usageWin{claude: {
		{label: "5 hours", id: "5h", pct: 22, secs: 3000, dur: 5 * 3600, prov: "anthropic"},
		{label: "7 days", id: "7d", pct: 7, secs: 2 * day, dur: 7 * day, prov: "anthropic"},
	}}
	after, _ := reconcileUsage(got, grown)
	rows := after.accountUsage[claude]
	if len(rows) != 2 || rows[1].stale || rows[1].missing || rows[1].pct != 7 {
		t.Errorf("a newly reported window must pass through fresh: %+v", rows)
	}
}

// TestUsageMissingAndTightStatusColumnStaysStable: a never-observed window keeps
// the exact row grammar of a real one, so its status text lands in the same
// column as "tight" or "maxed". A placeholder that shifted the status column
// would visibly jump the whole provider group the moment real data landed.
func TestUsageMissingAndTightStatusColumnStaysStable(t *testing.T) {
	m := layoutModel()
	// The skeleton reserves exactly what each provider declares — no more
	// provider-specific window is reserved on top of that.
	skeleton := stripAnsi(m.skeletonBody(0))
	for prov, wins := range skeletonWinsByProvider {
		for _, w := range wins {
			if strings.Count(skeleton, w) < 1 {
				t.Errorf("skeleton omits %s's declared %q window:\n%s", prov, w, skeleton)
			}
		}
	}
	if got := strings.Count(skeleton, "··%"); got != 4 {
		t.Fatalf("skeleton reserves %d rows, want the 4 windows the registry declares:\n%s", got, skeleton)
	}

	missing := stripAnsi(m.usageRow(usageWin{
		label: "7 days", id: "7d", missing: true,
	}))
	tight := stripAnsi(m.usageRow(usageWin{
		label: "7 days", id: "7d", pct: 85,
		secs: 2 * day, dur: 7 * day,
	}))
	missingAt := strings.Index(missing, "unavailable")
	tightAt := strings.Index(tight, "tight")
	if missingAt < 0 || tightAt < 0 {
		t.Fatalf("status labels missing: unavailable=%q tight=%q", missing, tight)
	}
	if got, want := lipgloss.Width(missing[:missingAt]), lipgloss.Width(tight[:tightAt]); got != want {
		t.Fatalf("unavailable status column = %d, want the normal status column %d\nmissing: %s\ntight:   %s",
			got, want, missing, tight)
	}
}

// TestUsageRefreshFailureRetention: a total refresh failure after a prior
// success keeps the full previous availability on screen with a visible
// refresh-failed warning — never wiping to the unauthenticated error — and
// the next successful refresh clears the warning. Without any prior success
// a failure still reads unavailable (nothing is fabricated).
func TestUsageRefreshFailureRetention(t *testing.T) {
	m := accountModel()
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)
	m.hadUsage = true
	before := m.avail
	failed := availability{bucket: map[string]string{}, reset: map[string]int64{}}

	nm, cmd := m.Update(usageMsg{avail: failed})
	m = nm.(model)
	if cmd != nil || m.barAnim != 0 {
		t.Fatal("a failed refresh must not start the first-load fill")
	}
	if !m.avail.ok || !reflect.DeepEqual(m.avail, before) {
		t.Fatalf("a failed refresh must keep the previous availability wholesale:\n got %+v\nwant %+v", m.avail, before)
	}
	if !m.usageStale {
		t.Fatal("a failed refresh after a success must mark the panel stale")
	}
	panel := stripAnsi(m.usagePanel())
	if !strings.Contains(panel, "refresh failed · stale") {
		t.Errorf("the control row must warn about the failed refresh:\n%s", panel)
	}
	if strings.Contains(panel, "usage unavailable") {
		t.Errorf("retained data must not read as unavailable:\n%s", panel)
	}
	if lineIndex(strings.Split(panel, "\n"), "% used") < 0 {
		t.Errorf("the previous usage rows must stay on screen:\n%s", panel)
	}
	// The warning replaces the countdown's slot, so the measured medium
	// breakpoint barely moves: a flaky refresh must not collapse the layout.
	_, staleMedium, _, _ := layoutSizes(t, m)
	m = resize(t, m, staleMedium.w, staleMedium.h)
	if m.mode() != modeMedium {
		t.Fatalf("stale usage at %dx%d: mode = %d, want medium — the warning must not blow up the measured column", staleMedium.w, staleMedium.h, m.mode())
	}
	assertLayoutInvariants(t, m, "medium stale usage")

	// The next successful refresh clears the warning.
	nm, _ = m.Update(usageMsg{avail: before})
	m = nm.(model)
	if m.usageStale {
		t.Fatal("a successful refresh must clear the stale flag")
	}
	if panel := stripAnsi(m.usagePanel()); strings.Contains(panel, "refresh failed") {
		t.Errorf("the warning must clear on the next success:\n%s", panel)
	}

	// Without any prior success a failure keeps the honest unavailable state.
	fresh := accountModel()
	fresh.avail = availability{bucket: map[string]string{}, reset: map[string]int64{}}
	nm, _ = fresh.Update(usageMsg{avail: failed})
	f := nm.(model)
	if f.avail.ok || f.usageStale {
		t.Errorf("no prior success → no retention, no stale flag (ok %v, stale %v)", f.avail.ok, f.usageStale)
	}
}

// TestFooterHelpGutter: every physical help line — the compact row and every
// row of the multi-line ? full help — carries the shared gut indentation, not
// just the first one, and no footer line overflows the terminal.
func TestFooterHelpGutter(t *testing.T) {
	m := accountModel()
	wide, medium, _, _ := layoutSizes(t, m)
	for _, tc := range []struct {
		label string
		s     termSize
	}{{"wide", wide}, {"medium", medium}} {
		m = resize(t, m, tc.s.w, tc.s.h)
		m.help.ShowAll = true
		footer := stripAnsi(m.footer())
		flines := strings.Split(footer, "\n")
		rule := -1
		for i, l := range flines {
			if strings.HasPrefix(l, "─") {
				rule = i
			}
		}
		help := flines[rule+1:]
		if len(help) < 2 {
			t.Fatalf("%s: full help must span multiple physical lines, got %d:\n%s", tc.label, len(help), footer)
		}
		for i, l := range help {
			if strings.TrimSpace(l) == "" {
				continue
			}
			if !strings.HasPrefix(l, strings.Repeat(" ", gut)) {
				t.Errorf("%s: help line %d lost the %d-cell gutter: %q", tc.label, i, gut, l)
			}
		}
		for i, l := range flines {
			if w := lipgloss.Width(l); w > m.w {
				t.Errorf("%s: footer line %d is %d cells for a %d-cell terminal: %q", tc.label, i, w, m.w, l)
			}
		}
		m.help.ShowAll = false
	}
}

func TestTrustedArgvNeverForcesOrForwardsProfile(t *testing.T) {
	for name, argv := range map[string][]string{
		"managed":   managedLaunchArgv("/omp", []string{"--profile", "old", "hello", "--profile=other"}, "prompt"),
		"generated": generatedLaunchArgv("/omp", "/tmp/generated.yml", []string{"--profile=old", "hello"}, "prompt"),
	} {
		joined := strings.Join(argv, " ")
		if strings.Contains(joined, "--profile") || strings.Contains(joined, " default") {
			t.Errorf("%s argv contains a trusted profile override: %q", name, argv)
		}
	}
}

func testAccountBroker(t *testing.T, usage string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/snapshot":
			_, _ = io.WriteString(w, `{"credentials":[
				{"provider":"anthropic","identityKey":"anthropic-key","credential":{"type":"oauth","email":"claude@example.test"}},
				{"provider":"openai-codex","identityKey":"codex-key","credential":{"type":"oauth","email":"codex@example.test"}},
				{"provider":"openai-codex","identityKey":"unmatched-key","credential":{"type":"oauth","email":"unmatched@example.test"}}
			]}`)
		case "/v1/usage":
			_, _ = io.WriteString(w, usage)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestLoadAvailabilityMatchesReportMetadataToAccounts(t *testing.T) {
	server := testAccountBroker(t, `{"reports":[
		{"provider":"anthropic","metadata":{"email":"claude@example.test"},"limits":[
			{"label":"Claude 5 Hour","scope":{"tier":"-"},"amount":{"usedFraction":0.42},"window":{"resetsAt":4102444800000,"durationMs":18000000}}
		]},
		{"provider":"openai-codex","metadata":{"accountId":"codex-key"},
		 "resetCredits":{"availableCount":2,"credits":[{"expiresAt":"2099-01-01T00:00:00Z","status":"available"}]},"limits":[
			{"label":"7 days","scope":{"tier":"-"},"amount":{"usedFraction":0.31},"window":{"resetsAt":4102444800000,"durationMs":604800000}}
		]},
		{"provider":"openai-codex",
		 "resetCredits":{"availableCount":9,"credits":[{"expiresAt":"2099-02-01T00:00:00Z","status":"available"}]},"limits":[
			{"label":"unattributed aggregate","scope":{"tier":"-"},"amount":{"usedFraction":0.12},"window":{"resetsAt":4102444800000,"durationMs":3600000}}
		]}
	]}`)
	got := loadAvailability(brokerConfig{URL: server.URL, Token: "secret"})
	if !got.ok || !got.accountsOK || len(got.wins) != 3 {
		t.Fatalf("central fetch incomplete: ok=%v accountsOK=%v wins=%d", got.ok, got.accountsOK, len(got.wins))
	}
	if len(got.accountUsage[accountKey{Provider: "anthropic", IdentityKey: "anthropic-key"}]) != 1 {
		t.Errorf("email metadata did not match Anthropic snapshot identity: %+v", got.accountUsage)
	}
	if len(got.accountUsage[accountKey{Provider: "openai-codex", IdentityKey: "codex-key"}]) != 1 {
		t.Errorf("accountId metadata did not match OpenAI snapshot identity: %+v", got.accountUsage)
	}
	if _, matched := got.accountUsage[accountKey{Provider: "openai-codex", IdentityKey: "unmatched-key"}]; matched {
		t.Fatal("a report without matching metadata must remain explicitly unavailable")
	}
	credits := got.accountCredits[accountKey{Provider: "openai-codex", IdentityKey: "codex-key"}]
	if credits.avail != 2 || len(credits.exp) != 1 {
		t.Errorf("matched reset credits were not attributed: %+v", credits)
	}
	if _, matched := got.accountCredits[accountKey{Provider: "openai-codex", IdentityKey: "unmatched-key"}]; matched {
		t.Fatal("unmatched reset credits must not be attributed")
	}
}

func TestUsageCacheRetainsPerAccountRowsAcrossProcesses(t *testing.T) {
	server := testAccountBroker(t, `{"reports":[{
		"provider":"anthropic","metadata":{"email":"claude@example.test"},"limits":[
			{"label":"Claude 7 Day","scope":{"tier":"-"},"amount":{"usedFraction":0.42},"window":{"resetsAt":4102444800000,"durationMs":604800000}}
		]}]}`)
	fresh := loadAvailability(brokerConfig{URL: server.URL, Token: "secret"})
	cachePath := filepath.Join(t.TempDir(), "usage.json")
	saveUsageCache(cachePath, fresh)
	info, err := os.Stat(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("usage cache mode = %o, want 600", info.Mode().Perm())
	}

	body, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	var cached usageCacheFile
	if err := json.Unmarshal(body, &cached); err != nil {
		t.Fatal(err)
	}
	cached.Usage[0].Wins[0].Observed = time.Now().Add(-2 * time.Hour).Unix()
	body, err = json.Marshal(cached)
	if err != nil {
		t.Fatal(err)
	}
	if err := atomicPrivateWrite(cachePath, body); err != nil {
		t.Fatal(err)
	}

	loaded := loadUsageCache(cachePath)
	key := accountKey{Provider: "anthropic", IdentityKey: "anthropic-key"}
	wins := loaded.accountUsage[key]
	if len(wins) != 1 || !wins[0].stale {
		t.Fatalf("persisted per-account usage was not restored stale: %+v", wins)
	}
	if age := formatCachedAge(wins[0].observed, time.Now()); age != "2h ago" {
		t.Fatalf("persisted observation age = %q, want 2h ago", age)
	}

	withoutClaude := parseAvailability(fresh.accounts, true, []byte(`{"reports":[]}`), 0)
	merged, _ := reconcileUsage(loaded, withoutClaude)
	if retained := merged.accountUsage[key]; len(retained) != 1 || !retained[0].stale {
		t.Fatalf("fresh omission discarded persisted account usage: %+v", retained)
	}
}

func TestSelectedAvailabilityAggregatesEnabledMatchedAccounts(t *testing.T) {
	codexA := accountKey{Provider: "openai-codex", IdentityKey: "a"}
	codexB := accountKey{Provider: "openai-codex", IdentityKey: "b"}
	codexMissing := accountKey{Provider: "openai-codex", IdentityKey: "missing"}
	codexDisabled := accountKey{Provider: "openai-codex", IdentityKey: "disabled"}
	claude := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	a := availability{
		ok: true, accountsOK: true,
		bucket: map[string]string{}, reset: map[string]int64{},
		accounts: map[string][]account{
			"openai-codex": {
				{Provider: codexA.Provider, IdentityKey: codexA.IdentityKey, Email: "a@example.test"},
				{Provider: codexB.Provider, IdentityKey: codexB.IdentityKey, Email: "b@example.test"},
				{Provider: codexMissing.Provider, IdentityKey: codexMissing.IdentityKey, Email: "missing@example.test"},
				{Provider: codexDisabled.Provider, IdentityKey: codexDisabled.IdentityKey, Email: "disabled@example.test"},
			},
			"anthropic": {{Provider: claude.Provider, IdentityKey: claude.IdentityKey, Email: "claude@example.test"}},
		},
		accountUsage: map[accountKey][]usageWin{
			codexA: {
				{label: "5 hours", pct: 10, secs: 100, dur: 5 * 3600, prov: "openai-codex", observed: 300},
				{label: "7 days", pct: 20, secs: 600, dur: 7 * day, prov: "openai-codex"},
				{label: "5 hours (Spark)", pct: 90, tier: "spark", secs: 50, dur: 5 * 3600, prov: "openai-codex"},
			},
			codexB: {
				{label: "Codex 5 Hour", pct: 11, secs: 101, dur: 5 * 3600, prov: "openai-codex", stale: true, observed: 200},
				{label: "7 days", pct: 40, secs: 700, dur: 6 * day, prov: "openai-codex"},
				{label: "wrong provider", pct: 100, secs: 1, dur: 5 * 3600, prov: "anthropic"},
				{label: "unknown tier", pct: 100, tier: "other", secs: 1, dur: 5 * 3600, prov: "openai-codex"},
				{label: "mystery window", pct: 100, secs: 1, dur: 5 * 3600, prov: "openai-codex"},
			},
			codexDisabled: {{label: "5 hours", pct: 100, secs: 0, dur: 5 * 3600, prov: "openai-codex"}},
			// A tier-scoped window the registry declares no bucket for: still a
			// real reported window, so it must reach the aggregate rows.
			claude: {{label: "Claude 7 Day (Fable)", id: "7d", pct: 31, tier: "fable", secs: 2 * day, dur: 7 * day, prov: "anthropic"}},
		},
		accountCredits: map[accountKey]resetCredits{
			codexA:        {avail: 1, exp: []int64{day}},
			codexB:        {avail: 2, exp: []int64{2 * day}},
			codexDisabled: {avail: 9, exp: []int64{9 * day}},
		},
		// Flat and unattributed report rows must never cross the selection seam.
		wins: []usageWin{{label: "5 hours", pct: 99, secs: 0, dur: 5 * 3600, prov: "openai-codex"}},
	}
	got := selectedAvailability(a, map[accountKey]bool{codexDisabled: true})
	var main5 usageWin
	foundMain := false
	for _, win := range got.wins {
		if win.prov == "openai-codex" && win.tier == "" && win.dur == 5*3600 && win.label == "5h" {
			main5, foundMain = win, true
		}
		if win.label == "wrong provider" || win.label == "unknown tier" || win.label == "mystery window" || win.pct == 99 || win.pct == 100 {
			t.Errorf("excluded report contributed an aggregate row: %+v", win)
		}
	}
	if !foundMain || main5.pct != 11 || main5.secs != 101 {
		t.Fatalf("half-up aggregate = %+v, want 11%% and 101s", main5)
	}
	if !main5.stale || main5.observed != 200 {
		t.Errorf("aggregate stale/oldest observation = %+v, want stale at 200", main5)
	}
	if len(got.wins) != 5 {
		t.Errorf("provider/tier/duration groups collapsed incorrectly: %+v", got.wins)
	}
	if got.credits.avail != 3 || !reflect.DeepEqual(got.credits.exp, []int64{day, 2 * day}) {
		t.Errorf("enabled reset credits = %+v, want sum/concatenation from a+b only", got.credits)
	}

	m := layoutModel()
	m.avail = a
	m.accountSelections.manualDisabled = map[accountKey]bool{codexDisabled: true}
	panel := stripAnsi(m.usagePanel())
	for _, want := range []string{"Codex (a* + b* + mi*)", "usage unavailable", "Claude (cl*)", "11% used", "a* ·", "b* ·", "1 reset", "2 resets"} {
		if !strings.Contains(panel, want) {
			t.Errorf("selected Usage missing %q:\n%s", want, panel)
		}
	}
	if strings.Contains(panel, "di*") || strings.Contains(panel, "99% used") || strings.Contains(panel, "3 resets") {
		t.Errorf("disabled or unattributed data leaked into selected Usage:\n%s", panel)
	}

	allDisabled := map[accountKey]bool{codexA: true, codexB: true, codexMissing: true, codexDisabled: true, claude: true}
	empty := selectedAvailability(a, allDisabled)
	if len(empty.wins) != 0 || empty.credits.avail != 0 || len(empty.credits.exp) != 0 {
		t.Errorf("all-disabled selection fabricated aggregate data: %+v", empty)
	}
}

func TestSelectedAvailabilityRebuildsRoutingBuckets(t *testing.T) {
	maxed := accountKey{Provider: "openai-codex", IdentityKey: "maxed"}
	remaining := accountKey{Provider: "openai-codex", IdentityKey: "remaining"}
	claude := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	base := availability{
		ok: true,
		// These aggregate fields deliberately disagree with the enabled
		// identities. selectedAvailability must never inherit them.
		bucket: map[string]string{"codex-main": "maxed", "codex-spark": "maxed", "claude-main": "unauthed"},
		reset:  map[string]int64{"codex-main": 999, "codex-spark": 999},
		accounts: map[string][]account{
			"openai-codex": {
				{Provider: maxed.Provider, IdentityKey: maxed.IdentityKey},
				{Provider: remaining.Provider, IdentityKey: remaining.IdentityKey},
			},
			"anthropic": {{Provider: claude.Provider, IdentityKey: claude.IdentityKey}},
		},
		accountUsage: map[accountKey][]usageWin{
			maxed: {
				{label: "5 hours", pct: 100, secs: 100, dur: 5 * 3600, prov: "openai-codex"},
				{label: "5 hours (Spark)", tier: "spark", pct: 100, secs: 80, dur: 5 * 3600, prov: "openai-codex"},
			},
			remaining: {
				{label: "5 hours", pct: 20, secs: 200, dur: 5 * 3600, prov: "openai-codex"},
				{label: "5 hours (Spark)", tier: "spark", pct: 40, secs: 120, dur: 5 * 3600, prov: "openai-codex"},
			},
		},
	}

	t.Run("disabled maxed account is excluded", func(t *testing.T) {
		got := selectedAvailability(base, map[accountKey]bool{maxed: true})
		if got.bucket["codex-main"] != "ok" || got.bucket["codex-spark"] != "ok" {
			t.Fatalf("disabled maxed account struck selected routes: %+v", got.bucket)
		}
		if _, ok := got.reset["codex-main"]; ok {
			t.Fatalf("disabled reset leaked into selected availability: %+v", got.reset)
		}
	})

	t.Run("all disabled provider is unavailable", func(t *testing.T) {
		got := selectedAvailability(base, map[accountKey]bool{maxed: true, remaining: true})
		if got.bucket["codex-main"] != "unauthed" || got.bucket["codex-spark"] != "unauthed" {
			t.Fatalf("provider with no enabled identities remained available: %+v", got.bucket)
		}
		if got.bucket["claude-main"] != "ok" {
			t.Fatalf("enabled provider without a real observation must stay unknown/non-down: %+v", got.bucket)
		}
	})

	t.Run("mixed selected accounts retain capacity", func(t *testing.T) {
		got := selectedAvailability(base, nil)
		if got.bucket["codex-main"] != "ok" || got.bucket["codex-spark"] != "ok" {
			t.Fatalf("one maxed identity overrode selected aggregate capacity: %+v", got.bucket)
		}
	})

	t.Run("all selected maxed uses aggregate reset", func(t *testing.T) {
		allMaxed := base
		allMaxed.accountUsage = map[accountKey][]usageWin{
			maxed:     {{label: "5 hours", pct: 100, secs: 100, dur: 5 * 3600, prov: "openai-codex"}},
			remaining: {{label: "5 hours", pct: 100, secs: 200, dur: 5 * 3600, prov: "openai-codex"}},
		}
		got := selectedAvailability(allMaxed, nil)
		if got.bucket["codex-main"] != "maxed" || got.reset["codex-main"] != 150 {
			t.Fatalf("selected aggregate bucket/reset = %q/%d, want maxed/150", got.bucket["codex-main"], got.reset["codex-main"])
		}
	})
}

func TestRoutingAndFacetAdvisoriesUseCommittedSelection(t *testing.T) {
	m := layoutModel()
	maxed := accountKey{Provider: "openai-codex", IdentityKey: "maxed"}
	remaining := accountKey{Provider: "openai-codex", IdentityKey: "remaining"}
	claude := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	m.avail.bucket = map[string]string{"codex-main": "maxed", "codex-spark": "maxed"}
	m.avail.reset = map[string]int64{"codex-main": 999, "codex-spark": 999}
	m.avail.accounts = map[string][]account{
		"openai-codex": {
			{Provider: maxed.Provider, IdentityKey: maxed.IdentityKey, Email: "maxed@example.test"},
			{Provider: remaining.Provider, IdentityKey: remaining.IdentityKey, Email: "remaining@example.test"},
		},
		"anthropic": {{Provider: claude.Provider, IdentityKey: claude.IdentityKey, Email: "claude@example.test"}},
	}
	m.avail.accountUsage = map[accountKey][]usageWin{
		maxed: {
			{label: "5 hours", pct: 100, secs: 100, dur: 5 * 3600, prov: "openai-codex"},
			{label: "5 hours (Spark)", tier: "spark", pct: 100, secs: 100, dur: 5 * 3600, prov: "openai-codex"},
		},
		remaining: {
			{label: "5 hours", pct: 20, secs: 200, dur: 5 * 3600, prov: "openai-codex"},
			{label: "5 hours (Spark)", tier: "spark", pct: 20, secs: 200, dur: 5 * 3600, prov: "openai-codex"},
		},
		claude: {{label: "5 hours", pct: 10, secs: 300, dur: 5 * 3600, prov: "anthropic"}},
	}
	m.accountSelections.SetManualDisabled(map[accountKey]bool{maxed: true})
	m.rdy, m.depth = true, 0
	m.vp = viewport.New(120, 20)
	m.syncPreview()
	first := routeLines(stripAnsi(m.vp.View()))[0]
	if strings.Contains(first, "→") {
		t.Fatalf("disabled maxed account caused lead route fallback:\n%s", first)
	}
	lines, _ := m.genLines()
	if text := stripAnsi(strings.Join(lines, "\n")); strings.Contains(text, "no usage left") {
		t.Fatalf("disabled maxed account produced facet warning:\n%s", text)
	}

	if err := m.accountSelections.UpsertPreset("Maxed only", map[accountKey]bool{remaining: true}); err != nil {
		t.Fatal(err)
	}
	if !m.accountSelections.Activate("Maxed only") {
		t.Fatal("named preset did not activate")
	}
	if !m.selectedLaunchAvailability().down("codex-main") {
		t.Fatal("named preset change did not update launch-visible availability")
	}
	m.syncPreview()
	first = routeLines(stripAnsi(m.vp.View()))[0]
	if !strings.Contains(first, "→") {
		t.Fatalf("selected maxed account did not advance lead route:\n%s", first)
	}
	lines, _ = m.genLines()
	if text := stripAnsi(strings.Join(lines, "\n")); !strings.Contains(text, "Spark maxed") || !strings.Contains(text, "no usage left") {
		t.Fatalf("facet advisory did not follow named preset:\n%s", text)
	}

	m.manager = true
	m.managerPreset = managerPresetState{editing: true, draft: map[accountKey]bool{maxed: true}}
	if m.selectedUsageAvailability().down("codex-main") {
		t.Fatal("manager Usage draft did not preview the remaining-capacity identity")
	}
	if !m.selectedLaunchAvailability().down("codex-main") {
		t.Fatal("manager draft became launch-visible")
	}
	lines, _ = m.genLines()
	if text := stripAnsi(strings.Join(lines, "\n")); !strings.Contains(text, "Spark maxed") {
		t.Fatalf("facet advisory consumed manager draft instead of committed selection:\n%s", text)
	}
	m.manager = false
	if !m.selectedLaunchAvailability().down("codex-main") {
		t.Fatal("leaving manager committed its unsaved draft")
	}

	if err := m.accountSelections.UpsertPreset("No providers", map[accountKey]bool{
		maxed: true, remaining: true, claude: true,
	}); err != nil {
		t.Fatal(err)
	}
	if !m.accountSelections.Activate("No providers") {
		t.Fatal("all-disabled named preset did not activate")
	}
	lines, _ = m.genLines()
	text := stripAnsi(strings.Join(lines, "\n"))
	// Spark is the only special tier with a dial and a quota window of its own,
	// so it is the only dial that carries an availability advisory.
	if !strings.Contains(text, "Spark unavailable") {
		t.Fatalf("all-disabled selection missing the Spark advisory:\n%s", text)
	}
}

// TestUndeclaredTierWindowRendersWithoutMaxingTheBucket is the corruption
// parseAvailability's `if bkt == "" { continue }` exists to prevent, and the
// property that replaced the whole retired fable-window apparatus.
//
// This operator's omp still reports an Anthropic limit scoped to tier "fable" — a
// carve-out no provider entry declares any more. The window is real and the
// operator wants to see it, so it renders as its own row; but it owns no bucket,
// and folding its usedFraction into claude-main would mark Claude maxed at 100%
// and stop every route through it on the strength of a quota window this build
// does not model. Both bucket seams (the payload parse and the account-selection
// rebuild) have to apply the rule.
func TestUndeclaredTierWindowRendersWithoutMaxingTheBucket(t *testing.T) {
	key := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	accounts := map[string][]account{
		"anthropic": {{Provider: key.Provider, IdentityKey: key.IdentityKey, Email: "alex@example.test"}},
	}
	resetsAt := (time.Now().Unix() + 3*3600) * 1000
	payload := fmt.Sprintf(`{"reports":[{"provider":"anthropic","email":"alex@example.test","limits":[
		{"label":"Claude 5 Hour","scope":{"windowId":"5h"},"amount":{"usedFraction":0.1},
		 "window":{"id":"5h","resetsAt":%d,"durationMs":18000000}},
		{"label":"Claude 7 Day (Fable)","scope":{"tier":"fable","windowId":"7d"},"amount":{"usedFraction":1},
		 "window":{"id":"7d","resetsAt":%d,"durationMs":604800000}}
	]}]}`, resetsAt, resetsAt)

	a := parseAvailability(accounts, true, []byte(payload), 0)
	if !a.ok {
		t.Fatal("fixture payload did not parse")
	}
	if got := a.bucket["claude-main"]; got != "ok" {
		t.Fatalf("an undeclared tier's maxed window moved claude-main to %q, want ok", got)
	}
	if _, ok := a.reset["claude-main"]; ok {
		t.Errorf("an undeclared tier's window contributed a main-bucket reset: %+v", a.reset)
	}
	if a.down("claude-main") {
		t.Error("every route through Claude was struck by a window nothing here models")
	}

	// It is still a real window: it names itself, so it is drawable and gets a
	// row of its own, labelled by id plus its tier.
	var carve usageWin
	for _, w := range a.wins {
		if w.tier == "fable" {
			carve = w
		}
	}
	if carve.id != "7d" || carve.pct != 100 {
		t.Fatalf("the tier-scoped window was dropped or mangled: %+v", a.wins)
	}
	if !knownUsageWindow(carve) {
		t.Fatal("a payload-named window on a metered provider must be renderable")
	}
	m := layoutModel()
	if row := stripAnsi(m.usageRow(carve)); !strings.Contains(row, "7d fable") || !strings.Contains(row, "100% used") {
		t.Errorf("the carve-out must render as its own labelled row: %q", row)
	}

	// selectedAvailability rebuilds buckets from the enabled identities alone,
	// so it is a second, independent chance to make the same mistake.
	sel := selectedAvailability(a, nil)
	if sel.bucket["claude-main"] != "ok" || sel.down("claude-main") {
		t.Fatalf("the selection seam maxed claude-main from the carve-out: %+v", sel.bucket)
	}
	if got := len(sel.accountUsage[key]); got != 2 {
		t.Fatalf("selected per-account rows = %d, want both reported windows: %+v", got, sel.accountUsage[key])
	}
	// The control: a tier the registry DOES declare still constrains its own
	// bucket, so the skip is scoped to unrecognised tiers rather than to tiers.
	spark := availability{
		ok: true, accountsOK: true,
		bucket: map[string]string{}, reset: map[string]int64{},
		accounts: map[string][]account{
			"openai-codex": {{Provider: "openai-codex", IdentityKey: "codex"}},
		},
		accountUsage: map[accountKey][]usageWin{
			{Provider: "openai-codex", IdentityKey: "codex"}: {
				{label: "5 hours (Spark)", id: "5h", tier: "spark", pct: 100, secs: 60, dur: 5 * 3600, prov: "openai-codex"},
			},
		},
	}
	if got := selectedAvailability(spark, nil); !got.down("codex-spark") || got.down("codex-main") {
		t.Fatalf("a declared tier must max exactly its own bucket: %+v", got.bucket)
	}
}

func TestReconcileUsageRetainsMissingAccountWithCachedAge(t *testing.T) {
	key := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	acct := account{Provider: key.Provider, IdentityKey: key.IdentityKey, Email: "alex@example.test"}
	observed := time.Now().Add(-2 * time.Hour).Unix()
	prev := availability{
		ok: true, accountsOK: true,
		bucket: map[string]string{}, reset: map[string]int64{},
		accounts: map[string][]account{"anthropic": {acct}},
		accountUsage: map[accountKey][]usageWin{key: {
			{label: "Claude 7 Day", pct: 42, secs: 2 * day, dur: 7 * day, prov: "anthropic", observed: observed},
		}},
	}
	next := availability{
		ok: true, accountsOK: true,
		bucket: map[string]string{}, reset: map[string]int64{},
		accounts:     map[string][]account{"anthropic": {acct}},
		accountUsage: map[accountKey][]usageWin{},
	}
	got, stale := reconcileUsage(prev, next)
	if stale {
		t.Fatal("one omitted account must not mark the whole Usage fetch stale")
	}
	wins := got.accountUsage[key]
	if len(wins) != 1 || !wins[0].stale || wins[0].pct != 42 || wins[0].observed != observed {
		t.Fatalf("cached account usage = %+v", wins)
	}
	m := layoutModel()
	m.avail = got
	panel := stripAnsi(m.usagePanel())
	for _, want := range []string{"42% used", "cached 2h ago"} {
		if !strings.Contains(panel, want) {
			t.Errorf("cached Usage missing %q:\n%s", want, panel)
		}
	}
	if strings.Contains(panel, "usage unavailable") {
		t.Errorf("cached Usage also claimed the account was unavailable:\n%s", panel)
	}
}

func TestSelectedUsageUsesCommittedSelectionAndManagerDraft(t *testing.T) {
	m := layoutModel()
	codex := accountKey{Provider: "openai-codex", IdentityKey: "codex"}
	claude := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	m.accountSelections = accountSelectionState{
		active:  "Focus",
		presets: []accountSelectionPreset{{Name: "Focus", Disabled: map[accountKey]bool{codex: true}}},
	}

	generator := stripAnsi(m.usagePanel())
	if strings.Contains(generator, "Codex (co*)") || !strings.Contains(generator, "Claude (cl*)") {
		t.Fatalf("generator Usage did not use committed selection:\n%s", generator)
	}
	m.manager = true
	m.managerPreset = managerPresetState{editing: true, draft: map[accountKey]bool{claude: true}}
	manager := stripAnsi(m.usagePanel())
	if strings.Contains(manager, "Claude (cl*)") || !strings.Contains(manager, "Codex (co*)") {
		t.Fatalf("manager Usage did not preview its explicit draft:\n%s", manager)
	}
	m.manager = false
	again := stripAnsi(m.usagePanel())
	if again != generator {
		t.Fatal("manager draft became launch-visible after leaving manager")
	}
	if m.fetching {
		t.Fatal("selection-only derivation started a usage fetch")
	}
}

func TestGeneratedTrustedLaunchLifecycle(t *testing.T) {
	server := testAccountBroker(t, `{"reports":[]}`)
	broker := brokerConfig{URL: server.URL, Token: "secret", SnapshotCache: "/tmp/code-snapshot-cache"}
	for _, tc := range []struct {
		name string
		exit int
	}{{name: "success", exit: 0}, {name: "failure", exit: 23}} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			capture := filepath.Join(dir, "capture")
			accountPoolCopy := filepath.Join(dir, "account-pool-copy")
			script := filepath.Join(dir, "omp")
			body := fmt.Sprintf(`#!/bin/sh
cfg=
take_cfg=
for arg in "$@"; do
  if [ "$take_cfg" = yes ]; then cfg="$arg"; take_cfg=; fi
  if [ "$arg" = --config ]; then take_cfg=yes; fi
done
[ -f "$OMP_AUTH_BROKER_ACCOUNT_POOL_FILE" ] || exit 97
[ -f "$cfg" ] || exit 98
printf '%%s\n%%s\n%%s\n%%s\n%%s\n%%s\n' "$OMP_AUTH_BROKER_ACCOUNT_POOL_FILE" "$cfg" "$OMP_AUTH_BROKER_URL" "$OMP_AUTH_BROKER_TOKEN" "$OMP_AUTH_BROKER_SNAPSHOT_CACHE" "$*" > "$CAPTURE"
cat "$OMP_AUTH_BROKER_ACCOUNT_POOL_FILE" > "$ACCOUNT_POOL_COPY"
exit %d
`, tc.exit)
			if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CODE_OMP", script)
			t.Setenv("CAPTURE", capture)
			t.Setenv("ACCOUNT_POOL_COPY", accountPoolCopy)
			oldArgs := os.Args
			os.Args = []string{"code", "--profile", "forwarded", "--profile=also-forwarded", "hello"}
			defer func() { os.Args = oldArgs }()

			selections := defaultAccountSelectionState()
			selections.SetManualDisabled(map[accountKey]bool{
				{Provider: "openai-codex", IdentityKey: "unmatched-key"}: true,
			})
			status := launchGenerated("models: {}\n", "prompt", broker, selections, "")
			if status != tc.exit {
				t.Fatalf("exit status = %d, want %d", status, tc.exit)
			}
			raw, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
			if len(lines) != 6 {
				t.Fatalf("capture lines = %q", lines)
			}
			if _, err := os.Stat(lines[0]); !os.IsNotExist(err) {
				t.Errorf("account pool survived child exit: %q err=%v", lines[0], err)
			}
			if _, err := os.Stat(lines[1]); !os.IsNotExist(err) {
				t.Errorf("generated config survived child exit: %q err=%v", lines[1], err)
			}
			if lines[2] != broker.URL || lines[3] != broker.Token || lines[4] != broker.SnapshotCache {
				t.Errorf("trusted auth env = %q, want broker overlay", lines[2:5])
			}
			accountPoolBody, err := os.ReadFile(accountPoolCopy)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(accountPoolBody), "unmatched-key") ||
				!strings.Contains(string(accountPoolBody), "anthropic-key") ||
				!strings.Contains(string(accountPoolBody), "codex-key") {
				t.Errorf("launch account pool ignored immutable account selection: %s", accountPoolBody)
			}
			if strings.Contains(lines[5], "--profile") {
				t.Errorf("trusted argv forwarded a profile: %q", lines[5])
			}
			if !strings.Contains(lines[5], "--config") || !strings.Contains(lines[5], "hello prompt") {
				t.Errorf("generated argv lost config/forwarded/prompt args: %q", lines[5])
			}
		})
	}
}

func TestTrustedLaunchUsesActiveSelectionSnapshots(t *testing.T) {
	server := testAccountBroker(t, `{"reports":[]}`)
	broker := brokerConfig{URL: server.URL, Token: "secret"}
	dir := t.TempDir()
	script := filepath.Join(dir, "omp")
	body := `#!/bin/sh
printf '%s|%s|%s' "$OMP_AUTH_BROKER_ACCOUNT_POOL_FILE" "$OMP_AUTH_BROKER_URL" "$OMP_AUTH_BROKER_TOKEN" > "$ENV_COPY"
cat "$OMP_AUTH_BROKER_ACCOUNT_POOL_FILE" > "$ACCOUNT_POOL_COPY"
`
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_OMP", script)

	anthropic := accountKey{Provider: "anthropic", IdentityKey: "anthropic-key"}
	codex := accountKey{Provider: "openai-codex", IdentityKey: "codex-key"}
	selections := defaultAccountSelectionState()
	selections.SetManualDisabled(map[accountKey]bool{anthropic: true})
	if err := selections.UpsertPreset("Codex off", map[accountKey]bool{codex: true}); err != nil {
		t.Fatal(err)
	}

	launch := func(label string) (string, string) {
		t.Helper()
		envCopy := filepath.Join(dir, label+"-env")
		accountPoolCopy := filepath.Join(dir, label+"-account-pool")
		t.Setenv("ENV_COPY", envCopy)
		t.Setenv("ACCOUNT_POOL_COPY", accountPoolCopy)
		if status := runTrusted("CODE_OMP", nil, managedLaunchArgv, "", broker, selections, ""); status != 0 {
			t.Fatalf("%s launch status = %d", label, status)
		}
		envBody, err := os.ReadFile(envCopy)
		if err != nil {
			t.Fatal(err)
		}
		accountPoolBody, err := os.ReadFile(accountPoolCopy)
		if err != nil {
			t.Fatal(err)
		}
		return string(envBody), string(accountPoolBody)
	}

	manualEnv, manualAccountPool := launch("manual")
	const wantManual = "{\"anthropic\":[],\"openai-codex\":[\"codex-key\",\"unmatched-key\"]}\n"
	if manualAccountPool != wantManual {
		t.Fatalf("Manual account pool = %q, want %q", manualAccountPool, wantManual)
	}
	manualEnvParts := strings.Split(manualEnv, "|")
	if len(manualEnvParts) != 3 || manualEnvParts[1] != broker.URL || manualEnvParts[2] != broker.Token {
		t.Fatalf("Manual child env = %q", manualEnv)
	}
	if _, err := os.Stat(manualEnvParts[0]); !os.IsNotExist(err) {
		t.Fatalf("Manual child's captured account pool remains mutable after exit: %v", err)
	}

	if !selections.Activate("Codex off") {
		t.Fatal("named preset did not activate")
	}
	namedEnv, namedAccountPool := launch("named")
	const wantNamed = "{\"anthropic\":[\"anthropic-key\"],\"openai-codex\":[\"unmatched-key\"]}\n"
	if namedAccountPool != wantNamed {
		t.Fatalf("named account pool = %q, want %q", namedAccountPool, wantNamed)
	}
	manualAccountPoolAfter, err := os.ReadFile(filepath.Join(dir, "manual-account-pool"))
	if err != nil {
		t.Fatal(err)
	}
	manualEnvAfter, err := os.ReadFile(filepath.Join(dir, "manual-env"))
	if err != nil {
		t.Fatal(err)
	}
	if string(manualAccountPoolAfter) != wantManual || string(manualEnvAfter) != manualEnv {
		t.Fatal("preset switch mutated already-captured Manual child inputs")
	}
	namedEnvParts := strings.Split(namedEnv, "|")
	if len(namedEnvParts) != 3 || namedEnvParts[0] == manualEnvParts[0] {
		t.Fatalf("future launch did not receive a fresh immutable account pool: manual=%q named=%q", manualEnv, namedEnv)
	}
	if _, err := os.Stat(namedEnvParts[0]); !os.IsNotExist(err) {
		t.Fatalf("named child's captured account pool remains mutable after exit: %v", err)
	}
}

func TestTrustedLaunchWithoutBrokerUsesLocalOMPAuth(t *testing.T) {
	dir := t.TempDir()
	capture := filepath.Join(dir, "env")
	script := filepath.Join(dir, "omp")
	body := "#!/bin/sh\nprintf '%s|%s|%s\\n' \"${OMP_AUTH_BROKER_URL+set}\" \"${OMP_AUTH_BROKER_TOKEN+set}\" \"${OMP_AUTH_BROKER_ACCOUNT_POOL_FILE+set}\" > \"$CAPTURE\"\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_OMP", script)
	t.Setenv("CAPTURE", capture)
	t.Setenv("OMP_AUTH_BROKER_URL", "http://incomplete")
	t.Setenv("OMP_AUTH_BROKER_ACCOUNT_POOL_FILE", "/tmp/stale-pool")
	if status := runTrusted("CODE_OMP", nil, managedLaunchArgv, "", brokerConfig{}, defaultAccountSelectionState(), ""); status != 0 {
		t.Fatalf("direct trusted launch status = %d", status)
	}
	raw, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(raw)); got != "||" {
		t.Fatalf("direct child retained broker environment: %q", got)
	}
}

func TestUntrustedLaunchStripsInheritedBrokerEnvironment(t *testing.T) {
	dir := t.TempDir()
	capture := filepath.Join(dir, "env")
	script := filepath.Join(dir, "ompu")
	body := "#!/bin/sh\nprintf '%s|%s|%s|%s|%s\\n' \"${OMP_AUTH_BROKER_URL+set}\" \"${OMP_AUTH_BROKER_TOKEN+set}\" \"${OMP_AUTH_BROKER_SNAPSHOT_CACHE+set}\" \"${OMP_AUTH_BROKER_ACCOUNT_POOL_FILE+set}\" \"${CODE_AUTH_ACCOUNT_STATE+set}\" > \"$CAPTURE\"\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_OMP_UNTRUSTED", script)
	t.Setenv("CAPTURE", capture)
	t.Setenv("OMP_AUTH_BROKER_URL", "http://ambient")
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "ambient-secret")
	t.Setenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE", "/tmp/ambient")
	t.Setenv("OMP_AUTH_BROKER_ACCOUNT_POOL_FILE", "/tmp/ambient-account-pool")
	t.Setenv("CODE_AUTH_ACCOUNT_STATE", "/tmp/ambient-state")
	oldArgs := os.Args
	os.Args = []string{"code", "--profile", "ambient"}
	defer func() { os.Args = oldArgs }()
	if status := runUntrustedLauncher("CODE_OMP_UNTRUSTED", nil, "", ""); status != 0 {
		t.Fatalf("untrusted launcher status = %d", status)
	}
	raw, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(raw)); got != "||||" {
		t.Errorf("untrusted launcher inherited auth routing: %q", got)
	}
}

// threePoolModel builds a TUI model over the rendered three-pool catalog —
// the integration seam the launch overlay is generated from.
func threePoolModel(t *testing.T) model {
	t.Helper()
	c, err := catalogFrom(t, fixtureYMLDeepSeek)
	if err != nil {
		t.Fatalf("loadCatalog: %v", err)
	}
	path := filepath.Join(t.TempDir(), "generated.plain")
	if err := os.WriteFile(path, []byte(c.renderCatalog()), 0o644); err != nil {
		t.Fatal(err)
	}
	generated := loadBlocks(path)
	m := model{
		generated: generated,
		advisors:  parseAdvisors(generated["__advisors__"]),
		facts:     parseFacts(generated["__models__"]),
		facets:    facetDefs(defaultGlyphs()),
		sel:       defaultSel(),
	}
	m.applyCatalog()
	return m
}

// TestGenConfigYAMLDeepSeekLane: a ds-led selection launches deepseek-prefixed
// roles, mirrors security-reviewer into the agent overrides, and version-gates
// task.agentAdvisor on the probed omp (17.2 hard-errors on the unknown key).
func TestGenConfigYAMLDeepSeekLane(t *testing.T) {
	m := threePoolModel(t)
	m.sel["lane"] = "ds-led"
	m.sel["spark"], m.sel["fast"] = "off", "off"
	m.sel["advisor"] = "audit"

	if _, ok := m.generated[comboID(m.sel)]; !ok {
		t.Fatalf("no generated block for %s", comboID(m.sel))
	}

	m.ompMajor, m.ompMinor = 17, 3
	got := m.genConfigYAML()
	for _, want := range []string{
		"  default: deepseek/deepseek-v4-pro:medium\n",
		"    security-reviewer: ",
		"  agentAdvisor:\n    task: \"on\"\n",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("ds-led overlay lacks %q:\n%s", want, got)
		}
	}
	// Fallback and cross-pool chains must carry their own provider prefixes,
	// never a mis-prefixed openai-codex/deepseek-….
	if strings.Contains(got, "openai-codex/deepseek") || strings.Contains(got, "anthropic/deepseek") ||
		strings.Contains(got, "deepseek/gpt") || strings.Contains(got, "deepseek/claude") {
		t.Errorf("mis-prefixed model in overlay:\n%s", got)
	}
	// ds lanes have no OpenAI priority tier even with fast on.
	m.sel["lane"] = "ds-only"
	m.sel["fast"] = "on"
	if only := m.genConfigYAML(); strings.Contains(only, "tier:") {
		t.Errorf("ds-only must not emit the OpenAI priority tier:\n%s", only)
	}

	// Version gate: an unknown or 17.2 omp omits the 17.3-only key entirely.
	m.sel["lane"] = "ds-led"
	for _, v := range []struct{ major, minor int }{{0, 0}, {17, 2}} {
		m.ompMajor, m.ompMinor = v.major, v.minor
		if got := m.genConfigYAML(); strings.Contains(got, "agentAdvisor") {
			t.Errorf("agentAdvisor emitted on omp %d.%d:\n%s", v.major, v.minor, got)
		}
	}
}

// TestApplyCatalogGrowsLaneDial: the lane facet's values are the catalog's;
// a three-pool catalog grows ds-led/ds-only, an old two-pool one keeps the
// classic five, and a persisted lane the catalog lacks resets to the first.
func TestApplyCatalogGrowsLaneDial(t *testing.T) {
	m := threePoolModel(t)
	var lanes []string
	for _, f := range m.facets {
		if f.key == "lane" {
			lanes = f.values
		}
	}
	want := []string{"gpt-only", "gpt-led", "mixed", "claude-led", "claude-only", "ds-led", "ds-only"}
	if !reflect.DeepEqual(lanes, want) {
		t.Fatalf("three-pool lane dial = %v, want %v", lanes, want)
	}

	m.sel["lane"] = "ds-led"
	if id := comboID(m.sel); m.generated[id] == nil {
		t.Fatalf("ds-led selection resolves to no block: %s", id)
	}

	two := model{
		generated: map[string][]string{"gpt-only_fast_low_nosp": {"    default gpt-5.6-luna:low"}},
		facets:    facetDefs(defaultGlyphs()),
		sel:       defaultSel(),
	}
	two.sel["lane"] = "ds-led" // persisted against a richer catalog
	two.applyCatalog()
	if two.sel["lane"] != "gpt-only" {
		t.Fatalf("vanished lane must reset to the dial's first value, got %q", two.sel["lane"])
	}
}

// TestProviderAvailabilityMarksDisconnectedLanes: credentials never shrink
// the dial — every catalog lane stays listed; the connected set decides which
// are usable (pickable) and the selection moves off an unusable lane. A
// missing optional login blocks exactly its own lanes, never the blends
// between connected providers.
func TestProviderAvailabilityMarksDisconnectedLanes(t *testing.T) {
	catalog := map[string][]string{
		"gpt-only_fast_low_nosp":    {"    default gpt:low"},
		"gpt-led_fast_low_nosp":     {"    default gpt:low"},
		"mixed_fast_low_nosp":       {"    default gpt:low"},
		"claude-only_fast_low_nosp": {"    default claude:low"},
		"ds-only_fast_low_nosp":     {"    default ds:low"},
	}
	m := model{generated: catalog, facets: facetDefs(defaultGlyphs()), sel: defaultSel()}
	m.applyCatalog()
	served := m.laneValues()

	// The user's regression: O+A logged in, the catalog's optional D is not.
	// Only the ds lane goes dark; every O/A lane and blend stays usable.
	m.applyProviderAvailability(map[string]bool{"O": true, "A": true})
	if !reflect.DeepEqual(m.laneValues(), served) {
		t.Fatalf("availability trimmed the dial: %v, want %v", m.laneValues(), served)
	}
	for _, lane := range []string{"gpt-only", "gpt-led", "mixed", "claude-only"} {
		if !m.laneUsable(lane) {
			t.Fatalf("connected-provider lane %q went unusable", lane)
		}
	}
	if m.laneUsable("ds-only") {
		t.Fatal("ds-only usable without a DeepSeek credential")
	}
	if m.sel["lane"] != "mixed" || m.noProviders {
		t.Fatalf("selection = %q noProviders=%v, want mixed/false", m.sel["lane"], m.noProviders)
	}
	if note := m.disconnectedLeads([]string{"mixed", "gpt", "claude", "ds"}); note != "DeepSeek" {
		t.Fatalf("lead note = %q, want DeepSeek", note)
	}

	// The inverse setup: only DeepSeek is connected. The dial still shows
	// everything; the selection lands on the one usable lane.
	m.applyProviderAvailability(map[string]bool{"D": true})
	if !reflect.DeepEqual(m.laneValues(), served) {
		t.Fatalf("availability trimmed the dial: %v", m.laneValues())
	}
	if m.sel["lane"] != "ds-only" || m.noProviders {
		t.Fatalf("DeepSeek-only selection = %q noProviders=%v", m.sel["lane"], m.noProviders)
	}
	if m.laneUsable("mixed") || m.laneUsable("gpt-only") {
		t.Fatal("required-pool lanes usable without their credentials")
	}
	for _, f := range m.visibleFacets() {
		if f.key == "blend" {
			t.Fatalf("single served blend exposed a blend dial: %v", f.values)
		}
	}

	m.applyProviderAvailability(nil)
	if !m.noProviders || len(m.visibleFacets()) != 0 {
		t.Fatalf("accountless generator remained actionable: noProviders=%v facets=%v", m.noProviders, m.visibleFacets())
	}
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if got := next.(model); got.genConfig != "" || cmd != nil {
		t.Fatalf("accountless Enter launched: config=%q cmd=%v", got.genConfig, cmd)
	}
	if footer := strings.Join(m.launchFooter(), "\n"); !strings.Contains(footer, "m open managed OMP to log in") {
		t.Fatalf("accountless footer is not actionable: %q", footer)
	}
}

// TestAccountlessNavigationIsInert is the crash a fresh machine opens into: with
// no connected credentials the generator renders no dials, and ←/→ used to index
// the empty visible-facet slice and take the whole TUI down
// ("index out of range [-1]"). No visible facets is a legitimate state, so a
// keypress in it has to do nothing — and, just as importantly, must not leave a
// negative cursor behind for a later keypress made once credentials are back.
func TestAccountlessNavigationIsInert(t *testing.T) {
	catalog := map[string][]string{
		"mixed_smart_medium_nosp":    {"    default gpt:medium"},
		"gpt-only_smart_medium_nosp": {"    default gpt:medium"},
		"claude-only_fast_low_nosp":  {"    default claude:low"},
	}
	m := model{generated: catalog, facets: facetDefs(defaultGlyphs()), sel: defaultSel()}
	m.applyCatalog()

	m.applyProviderAvailability(nil)
	if !m.noProviders || len(m.visibleFacets()) != 0 {
		t.Fatalf("precondition: want an accountless model with no visible facets, got noProviders=%v facets=%v",
			m.noProviders, m.visibleFacets())
	}
	before := map[string]string{}
	for k, v := range m.sel {
		before[k] = v
	}

	app := tea.Model(m)
	for _, key := range []tea.KeyType{tea.KeyLeft, tea.KeyRight} {
		next, cmd := app.Update(tea.KeyMsg{Type: key})
		app = next
		if cmd != nil {
			t.Errorf("%v returned a command in a state with no dials: %v", key, cmd)
		}
	}
	turned := app.(model)
	if !reflect.DeepEqual(turned.sel, before) {
		t.Errorf("a keypress with no dials rendered changed the selection: %v, want %v", turned.sel, before)
	}
	if turned.fcur < 0 {
		t.Fatalf("cursor left negative (%d): the next keypress in any state would panic", turned.fcur)
	}

	// Credentials come back; the dials it now renders must be usable.
	turned.applyProviderAvailability(map[string]bool{"O": true, "A": true})
	if len(turned.visibleFacets()) == 0 {
		t.Fatal("precondition: connected providers should render dials again")
	}
	restored, _ := tea.Model(turned).Update(tea.KeyMsg{Type: tea.KeyRight})
	got := restored.(model)
	if got.fcur < 0 || got.fcur >= len(got.visibleFacets()) {
		t.Fatalf("cursor %d out of range for %d visible facets", got.fcur, len(got.visibleFacets()))
	}
	if !got.laneUsable(got.sel["lane"]) {
		t.Errorf("selection rests on lane %q, which the connected credentials cannot run", got.sel["lane"])
	}
}

// TestCycleFacetSkipsUnusableLeads: an unconnected provider's lead is visible
// but not a stop — cycling steps past it onto the next usable lead, and stops
// at the edge when everything beyond is unusable.
func TestCycleFacetSkipsUnusableLeads(t *testing.T) {
	catalog := map[string][]string{
		"gpt-only_fast_low_nosp":    {"    default gpt:low"},
		"gpt-led_fast_low_nosp":     {"    default gpt:low"},
		"mixed_fast_low_nosp":       {"    default gpt:low"},
		"claude-led_fast_low_nosp":  {"    default claude:low"},
		"claude-only_fast_low_nosp": {"    default claude:low"},
		"ds-led_fast_low_nosp":      {"    default ds:low"},
	}
	m := model{generated: catalog, facets: facetDefs(defaultGlyphs()), sel: defaultSel()}
	m.applyCatalog()
	m.applyProviderAvailability(map[string]bool{"O": true, "A": true})
	m.sel["lane"] = "claude-led"
	m.visibleFacets() // sync lead/blend from lane
	m.fcur = 0

	// lead order: mixed gpt claude ds — right from claude must stop at
	// claude (ds is struck), not land on a dead lane.
	m.cycleFacet(1)
	if m.sel["lane"] != "claude-led" {
		t.Fatalf("cycle onto unusable leads moved the lane: %q", m.sel["lane"])
	}
	m.cycleFacet(-1) // back toward gpt: usable, normal stop
	if m.sel["lane"] != "gpt-led" {
		t.Fatalf("cycle to a usable lead = %q, want gpt-led", m.sel["lane"])
	}
}

// TestBlendDialListsServedBlends: the blend dial exists only when the lead's
// catalog serves more than one blend, and a lead switch to a pool that never
// generated the preferred blend lands on a lane the catalog serves.
func TestBlendDialListsServedBlends(t *testing.T) {
	catalog := map[string][]string{
		"gpt-led_fast_low_nosp":  {"    default gpt:low"},
		"gpt-only_fast_low_nosp": {"    default gpt:low"},
		"mixed_fast_low_nosp":    {"    default gpt:low"},
		"ds-led_fast_low_nosp":   {"    default ds:low"},
	}
	m := model{generated: catalog, facets: facetDefs(defaultGlyphs()), sel: defaultSel()}
	m.applyCatalog()
	m.sel["lane"] = "gpt-led"
	var blends []string
	for _, f := range m.visibleFacets() {
		if f.key == "blend" {
			blends = f.values
		}
	}
	if !reflect.DeepEqual(blends, []string{"led", "only"}) {
		t.Fatalf("gpt blends = %v, want [led only]", blends)
	}
	// A lead switch from gpt-only to ds: ds has no pure lane — land on led.
	if lane := m.composeLane("ds", "only"); lane != "ds-led" {
		t.Fatalf("composeLane(ds, only) = %q, want ds-led", lane)
	}
}

// TestFilterRowsDropsDisconnectedRungs: fallback rungs on pools nobody logged
// into vanish from routing rows (never the lead), so the preview and overlay
// only name models OMP can route.
func TestFilterRowsDropsDisconnectedRungs(t *testing.T) {
	m := model{facts: map[string]modelFact{
		"gpt-5.6-terra":   {pool: "O"},
		"claude-sonnet-5": {pool: "A"},
		"deepseek-v4":     {pool: "D"},
	}}
	m.providersResolved = true
	m.connected = map[string]bool{"O": true, "A": true}
	rows := []string{"  ● task       gpt-5.6-terra:medium → claude-sonnet-5:medium → deepseek-v4:medium"}
	got := m.filterRows(rows)[0]
	if strings.Contains(got, "deepseek") {
		t.Fatalf("disconnected rung survived: %q", got)
	}
	if !strings.Contains(got, "gpt-5.6-terra:medium → claude-sonnet-5:medium") {
		t.Fatalf("connected rungs mangled: %q", got)
	}
	// Before discovery resolves, rows pass through untouched.
	m.providersResolved = false
	if got := m.filterRows(rows)[0]; !strings.Contains(got, "deepseek-v4:medium") {
		t.Fatalf("unresolved discovery must not filter: %q", got)
	}
}

func TestDirectProviderProbeUsesOMPToken(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "omp")
	body := "#!/bin/sh\n[ \"$1\" = token ] && [ \"$2\" = deepseek ]\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_OMP", script)
	msg := probeProviderAvailabilityCmd()().(providerAvailabilityMsg)
	if !reflect.DeepEqual(msg.pools, map[string]bool{"D": true}) {
		t.Fatalf("provider probe pools = %v, want D only", msg.pools)
	}
}

// TestUsageBodyDeepSeekBalanceGroup: the DeepSeek usage group renders only
// when a credential exists (an absent API key is the normal state, not "not
// authenticated"), shows the prepaid balance with no bar or reset, and
// degrades to an explicit unavailable row on a failed fetch.
func TestUsageBodyDeepSeekBalanceGroup(t *testing.T) {
	m := &model{broker: brokerConfig{URL: "http://broker"}, hadUsage: true}
	m.accountSelections = defaultAccountSelectionState()
	a := emptyAvailability()
	a.ok, a.accountsOK = true, true
	a.accounts[anthropicProvider] = []account{{Provider: anthropicProvider, IdentityKey: "k", Email: "a@x.test"}}
	a.wins = []usageWin{{label: "Claude 5 Hour", pct: 10, secs: 60, dur: 5 * 3600, prov: anthropicProvider}}
	key := accountKey{Provider: anthropicProvider, IdentityKey: "k"}
	a.accountUsage[key] = a.wins
	m.avail = a

	if body := stripAnsi(m.usageBodyFor(0)); strings.Contains(body, "DeepSeek") {
		t.Fatalf("no credential: the DeepSeek group must be hidden entirely:\n%s", body)
	}

	m.avail.deepseek = &deepseekBalance{ok: true, currency: "USD", total: "12.34"}
	body := stripAnsi(m.usageBodyFor(0))
	if !strings.Contains(body, "DeepSeek") || !strings.Contains(body, "balance  $12.34 USD · pay-as-you-go") {
		t.Fatalf("balance group missing or malformed:\n%s", body)
	}
	if strings.Contains(body, "$12.34 USD") && (strings.Contains(body, "% used") && strings.Count(body, "% used") > 1) {
		t.Fatalf("the balance row must not grow bar/reset chrome:\n%s", body)
	}

	m.avail.deepseek = &deepseekBalance{}
	if body := stripAnsi(m.usageBodyFor(0)); !strings.Contains(body, "balance unavailable") {
		t.Fatalf("failed fetch must degrade to an unavailable row:\n%s", body)
	}

	// A deepseek bucket can never gate a launch: unmetered providers own no
	// buckets, so nothing in availability can mark one down.
	if b := bucketForProviderTier(deepseekProvider, ""); b != "" {
		t.Fatalf("unmetered provider grew a quota bucket: %q", b)
	}
	sel := selectedAvailability(m.avail, nil)
	for bucket := range sel.bucket {
		if strings.HasPrefix(bucket, "deepseek") {
			t.Fatalf("selected availability seeded a deepseek bucket: %q", bucket)
		}
	}
	if sel.deepseek == nil {
		t.Fatal("selected availability dropped the deepseek balance")
	}
}

// TestDeepSeekOffPeakWindow pins the discount window edges (UTC 16:30-00:30)
// and that the cost meter actually prices D rungs down inside it.
func TestDeepSeekOffPeakWindow(t *testing.T) {
	for _, tc := range []struct {
		hhmm string
		want bool
	}{
		{"16:29", false}, {"16:30", true}, {"23:59", true},
		{"00:00", true}, {"00:29", true}, {"00:30", false}, {"12:00", false},
	} {
		ts, _ := time.Parse("15:04", tc.hhmm)
		if got := deepseekOffPeak(ts); got != tc.want {
			t.Errorf("deepseekOffPeak(%s) = %v, want %v", tc.hhmm, got, tc.want)
		}
	}

	m := threePoolModel(t)
	m.sel["lane"] = "ds-only"
	prev := offPeakNow
	defer func() { offPeakNow = prev }()
	offPeakNow = func() time.Time { return time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC) }
	peak := m.costScore()
	offPeakNow = func() time.Time { return time.Date(2026, 8, 14, 20, 0, 0, 0, time.UTC) }
	if off := m.costScore(); off > peak {
		t.Errorf("off-peak cost score %d must not exceed peak %d", off, peak)
	}
	// The discount must show up in the raw weighted index, even when logScore
	// clamps both readings into the same 1..5 bucket for a cheap pool.
	idx := func() float64 {
		var num, den float64
		m.weightedModels(m.currentRows(), func(w float64, id, lvl string) {
			c, ok := m.facts[id]
			if !ok {
				return
			}
			cost := 0.25*c.in + 0.75*c.out
			if m.poolOfModel(id) == "D" && deepseekOffPeak(offPeakNow().UTC()) {
				cost *= deepseekOffPeakMult
			}
			num += w * cost
			den += w
		})
		return num / den
	}
	offIdx := idx()
	offPeakNow = func() time.Time { return time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC) }
	peakIdx := idx()
	if offIdx >= peakIdx {
		t.Errorf("off-peak weighted cost %v must be under peak %v", offIdx, peakIdx)
	}
}

// TestDeepSeekBalanceRowNotes: the low-balance cue appears exactly under the
// suggestion floor, and the off-peak tag only inside the discount window.
func TestDeepSeekBalanceRowNotes(t *testing.T) {
	m := &model{}
	prev := offPeakNow
	defer func() { offPeakNow = prev }()

	offPeakNow = func() time.Time { return time.Date(2026, 8, 14, 12, 0, 0, 0, time.UTC) }
	row := stripAnsi(m.deepseekBalanceRow(deepseekBalance{ok: true, currency: "USD", total: "1.99"}))
	if !strings.Contains(row, "low") {
		t.Errorf("balance under the floor must carry the low cue: %q", row)
	}
	if strings.Contains(row, "off-peak") {
		t.Errorf("peak hours must not show the off-peak tag: %q", row)
	}
	row = stripAnsi(m.deepseekBalanceRow(deepseekBalance{ok: true, currency: "USD", total: "2.00"}))
	if strings.Contains(row, "low") {
		t.Errorf("balance at the floor is not low: %q", row)
	}
	offPeakNow = func() time.Time { return time.Date(2026, 8, 14, 20, 0, 0, 0, time.UTC) }
	row = stripAnsi(m.deepseekBalanceRow(deepseekBalance{ok: true, currency: "USD", total: "18.03"}))
	if !strings.Contains(row, "off-peak −50%") {
		t.Errorf("off-peak window must surface the discount: %q", row)
	}
}

// TestSegmentGaugeRendersAsMeter: the thinking and model dials draw a notched
// ▰▱ meter with the selected word beside it, never the word list; one cell per
// step, filled to the selected depth, so ←/→ reads as a slider.
func TestSegmentGaugeRendersAsMeter(t *testing.T) {
	m := model{facets: facetDefs(defaultGlyphs()), sel: defaultSel()}
	rowFor := func(key string) string {
		lines, _ := m.genLines()
		for _, ln := range lines {
			if strings.Contains(stripAnsi(ln), key) {
				return stripAnsi(ln)
			}
		}
		t.Fatalf("no %s row rendered", key)
		return ""
	}

	m.sel["thinking"] = "medium"
	think := rowFor("thinking")
	if got := strings.Count(think, "▰") + strings.Count(think, "▱"); got != 6 {
		t.Fatalf("thinking gauge must keep one cell per level, got %d: %q", got, think)
	}
	if !strings.Contains(think, " medium ") {
		t.Errorf("gauge must carry the selected word: %q", think)
	}
	for _, word := range []string{"minimal", "xhigh", "max"} {
		if strings.Contains(think, word) {
			t.Errorf("gauge must replace the word list, still shows %q: %q", word, think)
		}
	}

	m.sel["model"] = "normal"
	mdl := rowFor("model")
	if got := strings.Count(mdl, "▰") + strings.Count(mdl, "▱"); got != 4 {
		t.Fatalf("model gauge must keep one cell per option, got %d cells: %q", got, mdl)
	}
	if got := strings.Count(mdl, "▰"); got != 2 {
		t.Fatalf("model step 2/4 must light two cells, got %d lit: %q", got, mdl)
	}
	if !strings.Contains(mdl, " normal ") || strings.Contains(mdl, "smart") {
		t.Errorf("model gauge must show only the selected word: %q", mdl)
	}

	// The track length is the dial's value list, and for the model dial that
	// list is catalog data (visibleFacets narrows it to m.mtiers). A lane whose
	// pools stop at tier 3 must therefore render a THREE-cell track: a fourth
	// unreachable notch would show headroom the catalog has no combo for.
	shallow := model{facets: facetDefs(defaultGlyphs()), sel: defaultSel(),
		generated: map[string][]string{
			"mixed_fast_medium_nosp":   nil,
			"mixed_normal_medium_nosp": nil,
			"mixed_smart_medium_nosp":  nil,
			"__models__":               nil,
		}}
	shallow.applyCatalog()
	lines, _ := shallow.genLines()
	var shallowRow string
	for _, ln := range lines {
		if p := stripAnsi(ln); strings.Contains(p, "model") {
			shallowRow = p
		}
	}
	if got := strings.Count(shallowRow, "▰") + strings.Count(shallowRow, "▱"); got != 3 {
		t.Fatalf("a tier-3 lane must render a three-cell model track, got %d: %q", got, shallowRow)
	}

	// advisor's leading "off" is the zero mark: no cell of its own, empty
	// track when selected, and the levels light one cell each.
	m.sel["advisor"] = "off"
	adv := rowFor("advisor")
	if strings.Count(adv, "▱") != 3 || strings.Count(adv, "▰") != 0 {
		t.Fatalf("advisor off must render an empty three-cell track: %q", adv)
	}
	if !strings.Contains(adv, " off ") {
		t.Errorf("advisor gauge must carry the selected word: %q", adv)
	}
	m.sel["advisor"] = "review"
	adv = rowFor("advisor")
	if strings.Count(adv, "▰") != 2 || strings.Count(adv, "▱") != 1 {
		t.Fatalf("advisor review must light 2 of 3 cells: %q", adv)
	}
}

// TestLaneSplitDials: the lane facet renders as a lead row plus a blend child
// (hidden for mixed); cycling either recomposes the canonical lane, and the
// persisted state still stores only "lane".
func TestLaneSplitDials(t *testing.T) {
	m := model{facets: facetDefs(defaultGlyphs()), sel: defaultSel()}

	// mixed: a single lead row, no blend child, no lane word list.
	vf := m.visibleFacets()
	if vf[0].key != "lead" {
		t.Fatalf("first dial = %q, want lead", vf[0].key)
	}
	if vf[1].key == "blend" {
		t.Fatal("mixed must not render a blend child")
	}
	wantLeads := []string{"mixed", "gpt", "claude"}
	if !reflect.DeepEqual(vf[0].values, wantLeads) {
		t.Fatalf("lead values = %v, want %v", vf[0].values, wantLeads)
	}

	// Cycling lead off mixed lands on the -led lane and grows the blend child.
	m.cycleFacet(1) // mixed → gpt (cursor starts on the lead row)
	if m.sel["lane"] != "gpt-led" {
		t.Fatalf("lead change composed lane %q, want gpt-led", m.sel["lane"])
	}
	vf = m.visibleFacets()
	if vf[1].key != "blend" {
		t.Fatalf("non-mixed lead must render the blend child, got %q", vf[1].key)
	}

	// Cycling blend led → only composes the pure lane.
	m.fcur = 1
	m.cycleFacet(1)
	if m.sel["lane"] != "gpt-only" {
		t.Fatalf("blend change composed lane %q, want gpt-only", m.sel["lane"])
	}

	// A three-pool dial grows a ds lead; lead/blend never persist.
	for i := range m.facets {
		if m.facets[i].key == "lane" {
			m.facets[i].values = []string{"gpt-only", "gpt-led", "mixed", "claude-led", "claude-only", "ds-led", "ds-only"}
		}
	}
	vf = m.visibleFacets()
	if !reflect.DeepEqual(vf[0].values, []string{"mixed", "gpt", "claude", "ds"}) {
		t.Fatalf("three-pool lead values = %v", vf[0].values)
	}
	choices := selectionChoices(m.sel, m.facets)
	if _, ok := choices["lead"]; ok {
		t.Error("lead is a derived dial and must not persist")
	}
	if _, ok := choices["blend"]; ok {
		t.Error("blend is a derived dial and must not persist")
	}
	if choices["lane"] != "gpt-only" {
		t.Errorf("persisted lane = %q, want gpt-only", choices["lane"])
	}
}

// TestAdvisorAuditChainIsTierDerived is the repointed relief-tail test. The
// relief dial and its optional-pool tail are gone, so an audit chain no longer
// diverts anywhere: its shape is purely the advisor pool's own ladder
// (renderAdvisors: t3:high → t2:high → t1:low). That is worth pinning because
// the tail is exactly what used to hide the failure mode — a heavyweight advisor
// silently spending a pool the lane never chose.
func TestAdvisorAuditChainIsTierDerived(t *testing.T) {
	level := func(tok string) string {
		if i := strings.LastIndexByte(tok, ':'); i >= 0 {
			return tok[i+1:]
		}
		return ""
	}
	m := threePoolModel(t)

	// GPT leads mixed, so the advisor crosses to Claude — and stays there for
	// every rung of the chain.
	m.sel["lane"] = "mixed"
	audit := m.advisorChain("audit")
	if len(audit) != 3 {
		t.Fatalf("audit chain = %v, want three rungs (t3 → t2 → t1)", audit)
	}
	for _, tok := range audit {
		if !strings.HasPrefix(tok, "claude-") {
			t.Fatalf("audit chain left the advisor's own pool: %v", audit)
		}
	}
	if lvl(level(audit[0])) < lvl(level(audit[len(audit)-1])) {
		t.Fatalf("audit chain must descend in thinking level, got %v", audit)
	}
	// Lighter levels are shorter, not differently routed.
	if got := m.advisorChain("glance"); len(got) != 1 || !strings.HasPrefix(got[0], "claude-") {
		t.Fatalf("glance chain = %v, want a single claude rung", got)
	}

	// An optional-led lane crosses the other way, and audit must not tail back
	// onto the lead pool it was supposed to be independent of.
	m.sel["lane"] = "ds-led"
	dsAudit := m.advisorChain("audit")
	if len(dsAudit) != 3 {
		t.Fatalf("ds-led audit chain = %v, want three rungs", dsAudit)
	}
	for _, tok := range dsAudit {
		if strings.HasPrefix(tok, "deepseek-") {
			t.Fatalf("the advisor must not sit on the lane's own lead pool: %v", dsAudit)
		}
	}
}

// ── provider routing surface ──────────────────────────────────────────────────

func TestModelReMatchesProviderScopedIds(t *testing.T) {
	line := "  ● task  deepseek/deepseek-v4-pro:high → claude-opus-5:high"
	got := modelRe.FindAllString(line, -1)
	want := []string{"deepseek/deepseek-v4-pro:high", "claude-opus-5:high"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("modelRe matched %v, want %v", got, want)
	}
	// Prose and bucket states must never read as models.
	for _, s := range []string{"thinking high · fallback on · advisor on", "codex-spark maxed"} {
		if got := modelRe.FindAllString(s, -1); len(got) != 0 {
			t.Errorf("modelRe matched prose %q → %v", s, got)
		}
	}
}

func TestShortModelStripsProviderPath(t *testing.T) {
	if got := shortModel("local-qwen/qwen3.8-27b"); got != "qwen3.8-27b" {
		t.Errorf("shortModel(local-qwen/qwen3.8-27b) = %q, want qwen3.8-27b", got)
	}
	if got := shortModel("claude-opus-5"); got != "opus" {
		t.Errorf("shortModel baseline moved: %q", got)
	}
}

func TestPrefixedUsesCatalogPool(t *testing.T) {
	m := model{facts: map[string]modelFact{
		"v4-experimental": {pool: "D"},
		"gpt-5.6-luna":    {pool: "O"},
		"claude-opus-5":   {pool: "A"},
	}}
	for id, want := range map[string]string{
		"v4-experimental": "deepseek/v4-experimental",
		"gpt-5.6-luna":    "openai-codex/gpt-5.6-luna",
		"claude-opus-5":   "anthropic/claude-opus-5",
	} {
		if got := m.prefixed(id); got != want {
			t.Errorf("prefixed(%q) = %q, want %q", id, got, want)
		}
	}
	// A catalog without the pool column falls back to the name heuristic.
	var legacy model
	if got := legacy.prefixed("claude-opus-5"); got != "anthropic/claude-opus-5" {
		t.Errorf("legacy heuristic broken: prefixed = %q", got)
	}
}

func TestTrimLanesResetsVanishedLane(t *testing.T) {
	m := &model{
		facets: []facet{
			{key: "lane", values: []string{"gpt-only", "mixed", "ds-only", "ds-led"}},
			{key: "thinking", values: []string{"medium"}},
		},
		sel: map[string]string{"lane": "ds-only", "thinking": "medium"},
		generated: map[string][]string{
			"gpt-only_smart_medium_nosp": nil,
			"mixed_smart_medium_nosp":    nil,
		},
	}
	m.applyCatalog()
	if got := m.facets[0].values; strings.Join(got, ",") != "gpt-only,mixed" {
		t.Errorf("lane dial not trimmed to served lanes: %v", got)
	}
	if m.sel["lane"] != "gpt-only" && m.sel["lane"] != "mixed" {
		t.Errorf("selection left on vanished lane: %q", m.sel["lane"])
	}
}

// The launch path prefixes tokens that still carry their thinking level
// ("id:level"); the facts table is keyed on the bare id. This regresses the
// bug where catalog-pool ids missed the pool lookup and fell to the
// name heuristic — a wrongly-prefixed model is not a model omp knows.
func TestPrefixedLeveledTokens(t *testing.T) {
	m := model{facts: map[string]modelFact{
		"v4-experimental": {pool: "D"},
	}}
	if got := m.prefixed("v4-experimental:high"); got != "deepseek/v4-experimental:high" {
		t.Fatalf("prefixed(leveled) = %q, want deepseek/v4-experimental:high", got)
	}
}
