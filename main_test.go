package main

import (
	"encoding/json"
	"fmt"
	clikit "github.com/atyrode/cli-kit"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"
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
		out := renderRoute([]string{sampleRow}, 1, availability{}, width)
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
		out := renderRoute([]string{sampleRow}, 1, availability{}, width)
		for i, ln := range routeLines(out) {
			if w := lipgloss.Width(ln); w > width {
				t.Errorf("width=%d: line %d overflows (%d cols): %q", width, i, w, ln)
			}
		}
	}
}

// TestRenderRouteLeadDepth: at depth 0 only the primary (first live) model shows.
func TestRenderRouteLeadDepth(t *testing.T) {
	out := renderRoute([]string{sampleRow}, 0, availability{}, 120)
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
	out := renderRoute([]string{"  advisor    (disabled)"}, 1, availability{}, 80)
	if !strings.Contains(out, "advisor") || !strings.Contains(out, "(disabled)") {
		t.Errorf("note line should pass through, got: %q", out)
	}
}

func TestShortModel(t *testing.T) {
	cases := map[string]string{
		"gpt-5.6-terra":       "terra",
		"gpt-5.6-luna":        "luna",
		"gpt-5.6-sol":         "sol",
		"gpt-5.3-codex-spark": "spark",
		"claude-opus-4-8":     "opus",
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

// TestComboID covers the lane-driven suppression: gpt-only forces fable off,
// claude-only forces spark off, regardless of the toggles — plus the fable-main
// segment: famain only when fable is on too, and lane suppression wins over both.
func TestComboID(t *testing.T) {
	cases := []struct {
		sel  map[string]string
		want string
	}{
		{map[string]string{"lane": "mixed", "model": "normal", "thinking": "medium", "spark": "on", "fable": "off"}, "mixed_normal_medium_sp_nofa"},
		{map[string]string{"lane": "mixed", "model": "normal", "thinking": "medium", "spark": "off", "fable": "on"}, "mixed_normal_medium_nosp_fa"},
		{map[string]string{"lane": "gpt-only", "model": "fast", "thinking": "high", "spark": "on", "fable": "on"}, "gpt-only_fast_high_sp_nofa"},
		{map[string]string{"lane": "claude-only", "model": "smart", "thinking": "low", "spark": "on", "fable": "on"}, "claude-only_smart_low_nosp_fa"},
		{map[string]string{"lane": "mixed", "model": "smart", "thinking": "high", "spark": "off", "fable": "on", "main": "on"}, "mixed_smart_high_nosp_famain"},
		{map[string]string{"lane": "mixed", "model": "smart", "thinking": "high", "spark": "off", "fable": "off", "main": "on"}, "mixed_smart_high_nosp_nofa"},
		{map[string]string{"lane": "gpt-only", "model": "smart", "thinking": "high", "spark": "on", "fable": "on", "main": "on"}, "gpt-only_smart_high_sp_nofa"},
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

// TestMainFacetVisibility locks the sub-setting behavior: the main (fable-as-main)
// dial only exists while fable is on and the lane can host Fable at all.
func TestMainFacetVisibility(t *testing.T) {
	has := func(sel map[string]string) bool {
		m := model{facets: facetDefs(map[string]string{}), sel: sel}
		for _, f := range m.visibleFacets() {
			if f.key == "main" {
				return true
			}
		}
		return false
	}
	if !has(map[string]string{"lane": "mixed", "fable": "on"}) {
		t.Errorf("main must be visible when fable is on")
	}
	if has(map[string]string{"lane": "mixed", "fable": "off"}) {
		t.Errorf("main must be hidden while fable is off")
	}
	if has(map[string]string{"lane": "gpt-only", "fable": "on"}) {
		t.Errorf("main must be hidden on a gpt-only lane")
	}
}

// TestCycleFacetClearsMain: manually toggling fable off must clear fable-as-main
// too, so a later fable re-enable never silently resurrects the escalation.
func TestCycleFacetClearsMain(t *testing.T) {
	m := &model{facets: facetDefs(map[string]string{}), sel: defaultSel()}
	m.sel["fable"] = "on"
	m.sel["main"] = "on"
	for i, f := range m.visibleFacets() {
		if f.key == "fable" {
			m.fcur = i
		}
	}
	m.cycleFacet(1) // fable on → off
	if m.sel["fable"] != "off" {
		t.Fatalf("cycle should have turned fable off, got %q", m.sel["fable"])
	}
	if m.sel["main"] != "off" {
		t.Errorf("main must clear when fable is manually turned off, got %q", m.sel["main"])
	}
}

func TestCycleFacetClampsAtEndpoints(t *testing.T) {
	m := &model{facets: facetDefs(map[string]string{}), sel: defaultSel()}
	m.fcur = 0 // lane

	m.sel["lane"] = m.facets[0].values[0]
	m.cycleFacet(-1)
	if got := m.sel["lane"]; got != m.facets[0].values[0] {
		t.Fatalf("left at first option wrapped to %q", got)
	}

	last := m.facets[0].values[len(m.facets[0].values)-1]
	m.sel["lane"] = last
	m.cycleFacet(1)
	if got := m.sel["lane"]; got != last {
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

// TestDefaultGlyphs pins the built-in facet glyphs to their Nerd Font (FA PUA)
// codepoints. The literals are invisible in most editors — an edit once wiped
// them all to empty strings without anything failing; this locks each value.
func TestDefaultGlyphs(t *testing.T) {
	want := map[string]rune{
		"lane": 0xf127, "model": 0xf085, "thinking": 0xf0eb, "advisor": 0xf14e,
		"spark": 0xf135, "fable": 0xf02d, "main": 0xf140, "fast": 0xf0e7,
	}
	g := defaultGlyphs()
	if len(g) != len(want) {
		t.Errorf("defaultGlyphs has %d entries, want %d", len(g), len(want))
	}
	for _, f := range facetDefs(g) {
		r := []rune(g[f.key])
		if len(r) != 1 {
			t.Errorf("glyph for %q is %d runes, want exactly 1", f.key, len(r))
			continue
		}
		if r[0] != want[f.key] {
			t.Errorf("glyph for %q = U+%04X, want U+%04X", f.key, r[0], want[f.key])
		}
	}
}

// TestGenLinesMainRow: the fable-as-main dial renders as fable's tabulated child
// labelled "default" (self-explanatory next to the preview), with no flavor text
// — the old explainer wrapped on narrow panes and broke the layout.
func TestGenLinesMainRow(t *testing.T) {
	m := model{facets: facetDefs(defaultGlyphs()), sel: defaultSel()}
	m.sel["fable"] = "on"
	m.sel["main"] = "on"
	lines, _ := m.genLines()
	var mainRow string
	for _, ln := range lines {
		p := stripAnsi(ln)
		if strings.Contains(p, "default") {
			mainRow = p
		}
		if strings.Contains(p, "Fable leads") {
			t.Errorf("main row must carry no flavor text, got %q", p)
		}
	}
	if mainRow == "" {
		t.Fatalf("no row labelled 'default' while fable+main are on:\n%s", stripAnsi(strings.Join(lines, "\n")))
	}
	// tabulated child: unfocused prefix is the 2-space pointer slot + an
	// L-shaped tree connector before the glyph — the connector makes the
	// parent/child link to fable explicit, like the `tree` CLI.
	if !strings.HasPrefix(mainRow, "  └ ") {
		t.Errorf("main row must carry the └ child connector, got %q", mainRow)
	}
}

// TestAdvisorChainFlip locks the advisor's opposite-provider rule: the second
// opinion tracks whoever actually leads. Lane-led flips were already in place;
// fable-as-main (fable on + default on) puts Claude Fable in the default seat,
// so mixed/gpt-led lanes must flip the advisor to GPT too — same-provider lead
// and advisor would reintroduce the tunnel-vision risk the advisor exists to
// cut. Pure lanes keep their own provider; fable alone (main off) doesn't flip.
func TestAdvisorChainFlip(t *testing.T) {
	adv := map[string][]string{
		"glance/gpt":    {"gpt-5.6-terra:low"},
		"glance/claude": {"claude-quartz-5:low"},
	}
	cases := []struct {
		lane, fable, main string
		wantCtx           string
	}{
		{"mixed", "off", "off", "claude"},
		{"gpt-led", "off", "off", "claude"},
		{"claude-led", "off", "off", "gpt"},
		{"gpt-only", "off", "off", "gpt"},
		{"claude-only", "off", "off", "claude"},
		// fable on but not leading: no flip.
		{"mixed", "on", "off", "claude"},
		// fable-as-main: Claude leads, advisor flips to GPT.
		{"mixed", "on", "on", "gpt"},
		{"gpt-led", "on", "on", "gpt"},
		{"claude-led", "on", "on", "gpt"},
		// pure Claude pool: pure-lane rule wins, no GPT in the pool.
		{"claude-only", "on", "on", "claude"},
	}
	for _, c := range cases {
		m := model{advisors: adv, sel: defaultSel()}
		m.sel["lane"], m.sel["fable"], m.sel["main"] = c.lane, c.fable, c.main
		got := m.advisorChain("glance")
		want := adv["glance/"+c.wantCtx]
		if len(got) == 0 || got[0] != want[0] {
			t.Errorf("lane=%s fable=%s main=%s: advisor chain = %v, want %s (%v)",
				c.lane, c.fable, c.main, got, c.wantCtx, want)
		}
	}
}

// TestApplyAdvisorFableMain: the flipped chain must flow through applyAdvisor —
// the single seam feeding the preview, the cost/speed meters, and the launched
// config YAML — not just the raw table lookup.
func TestApplyAdvisorFableMain(t *testing.T) {
	m := model{
		advisors: map[string][]string{
			"glance/gpt":    {"gpt-5.6-terra:low"},
			"glance/claude": {"claude-quartz-5:low"},
		},
		sel: defaultSel(),
	}
	m.sel["fable"], m.sel["main"] = "on", "on" // mixed lane (default)
	rows := m.applyAdvisor([]string{"    default    claude-fable-5:high"}, "glance")
	joined := strings.Join(rows, "\n")
	if !strings.Contains(joined, "advisor    gpt-5.6-terra:low") {
		t.Errorf("fable-as-main must synthesise a GPT advisor row, got:\n%s", joined)
	}
}

// TestPreviewColumn locks the Routing section's shape: the title row carries
// the section-local collapse cue (p · hide), the fallback-display cue is
// pinned to the section's LAST row — bottom chrome under the viewport, no
// longer top chrome — worded as a show/hide DISPLAY toggle, and no baked
// settings-summary line reaches the preview (the dials are visible on the
// left).
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
	if tail := strings.TrimSpace(rows[len(rows)-1]); tail != "f · show fallback chains" {
		t.Errorf("the fallback cue must be pinned to the section's last row, got %q", tail)
	}
	m.depth = 1
	if plain := stripAnsi(m.previewColumn()); !strings.Contains(plain, "f · hide fallback chains") {
		t.Errorf("full-chain depth must flip the cue to hide, got:\n%s", plain)
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
		"    advisor    claude-opus-4-5:high",
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
	if m.sel["lane"] != "claude-led" {
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
	if m.sel["lane"] != "claude-led" {
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
	if got := loadSelectionState(m.selectionState, m.facets)["lane"]; got != "claude-led" {
		t.Fatalf("persisted lane after wheel-left = %q, want claude-led", got)
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

func TestShortWinProviderLabels(t *testing.T) {
	tests := map[string]string{
		"5 hours":               "5h",
		"Claude 5 Hour":         "5h",
		"Codex 5 Hour":          "5h",
		"OpenAI 5 Hour":         "5h",
		"7 days":                "7d",
		"Claude 7 Day":          "7d",
		"Codex 7 Day":           "7d",
		"OpenAI 7 Day":          "7d",
		"5 hours (Spark)":       "5h spark",
		"Codex 5 Hour (Spark)":  "5h spark",
		"OpenAI 5 Hour (Spark)": "5h spark",
		"7 days (Spark)":        "7d spark",
		"Codex 7 Day (Spark)":   "7d spark",
		"OpenAI 7 Day (Spark)":  "7d spark",
		"Claude 7 Day (Fable)":  "7d fable",
		"unrecognized upstream": "unrecognized upstream",
	}
	for label, want := range tests {
		if got := shortWin(label); got != want {
			t.Errorf("shortWin(%q) = %q, want %q", label, got, want)
		}
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
			{label: "Claude 7 Day (Fable)", tier: "fable", dur: 7 * day, prov: "anthropic", missing: true},
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
	for _, d := range []string{"move", "change", gReset + " defaults", "manage accounts", "refresh usage", "managed omp", "sandbox", "launch", "show routing", "show usage"} {
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
	for _, d := range []string{gReset + " defaults", "launch", "managed omp", "sandbox"} {
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
	for _, d := range []string{"move", "change", "defaults", "primary ⇄ full chains", "refresh usage", "manage accounts", "show/hide routing", "show/hide usage", "launch", "managed omp", "sandbox", "quit"} {
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
		route := lineIndex(lines, "scout") // a routing role row — generator has none
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

	skeleton := renderUsageRows(80, []usageRowSpec{skeletonUsageRowSpec("7d fable", "  ")})[0]
	missing := renderUsageRows(80, []usageRowSpec{loaded.usageRowSpec(usageWin{
		label: "Claude 7 Day (Fable)", tier: "fable", missing: true,
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
	if got := strings.Count(panel, "··% used"); got != 5 {
		t.Errorf("want Codex's two rows plus Claude's three including Fable (5 total), got %d:\n%s", got, panel)
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
// content — including a present fable window — from the bottom refresh/hotkey
// control line, in the wide band and medium's stacked column alike.
func TestUsageCtrlBlankRow(t *testing.T) {
	m := accountModel()
	key := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	m.avail.accountUsage[key] = append(m.avail.accountUsage[key],
		usageWin{label: "Claude 7 Day (Fable)", pct: 40, tier: "fable", secs: 4 * day, dur: 7 * day, prov: "anthropic"})
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)
	for _, tc := range []struct{ label, panel string }{
		{"wide band", stripAnsi(m.usagePanel())},
		{"medium column", stripAnsi(m.usageColumn())},
	} {
		lines := strings.Split(tc.panel, "\n")
		if lineIndex(lines, "7d fable") < 0 {
			t.Fatalf("%s: fixture fable row missing:\n%s", tc.label, tc.panel)
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

// TestReconcileUsageFableRetention: a successful refresh that omits the
// Anthropic fable window keeps the previously observed window — marked stale,
// with its bucket/reset state carried so down-routing never flips to ok on
// missing evidence — while every freshly fetched window wins as usual.
func TestReconcileUsageFableRetention(t *testing.T) {
	prev := availability{
		ok:     true,
		bucket: map[string]string{"claude-fable": "maxed", "claude-main": "ok"},
		reset:  map[string]int64{"claude-fable": 9000},
		wins: []usageWin{
			{label: "Claude 5 Hour", pct: 10, secs: 3600, dur: 5 * 3600, prov: "anthropic"},
			{label: "Claude 7 Day (Fable)", pct: 100, tier: "fable", secs: 9000, dur: 7 * day, prov: "anthropic", observed: 1_752_665_040},
		},
	}
	next := availability{
		ok:     true,
		bucket: map[string]string{"claude-fable": "ok", "claude-main": "ok"},
		reset:  map[string]int64{},
		wins: []usageWin{
			{label: "Claude 5 Hour", pct: 20, secs: 3000, dur: 5 * 3600, prov: "anthropic"},
		},
	}
	got, stale := reconcileUsage(prev, next)
	if stale {
		t.Fatal("a successful refresh must not mark the whole panel stale")
	}
	fable := usageWin{}
	found := false
	for _, w := range got.wins {
		if w.tier == "fable" {
			fable, found = w, true
		}
	}
	if !found {
		t.Fatalf("the omitted fable window must be retained: %+v", got.wins)
	}
	if !fable.stale || fable.missing || fable.pct != 100 || fable.secs != 9000 {
		t.Errorf("retained fable row must carry the last observed value marked stale: %+v", fable)
	}
	if got.bucket["claude-fable"] != "maxed" || got.reset["claude-fable"] != 9000 {
		t.Errorf("bucket/reset must stay conservative, got %q/%d", got.bucket["claude-fable"], got.reset["claude-fable"])
	}
	if !got.down("claude-fable") {
		t.Error("down-routing must not flip a maxed fable to ok on missing evidence")
	}
	for _, w := range got.wins {
		if w.tier == "" && w.pct != 20 {
			t.Errorf("freshly fetched windows must win: %+v", w)
		}
	}
	m := layoutModel()
	row := stripAnsi(m.usageRow(fable))
	if !strings.Contains(row, "7d fable") ||
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

// TestReconcileUsageFablePlaceholder: with no fable window ever observed a
// successful anthropic payload gains a deterministic unavailable placeholder
// (no fabricated numbers, real row geometry), a payload with no anthropic
// windows at all gains nothing, and a payload carrying the fable window
// passes through untouched.
func TestReconcileUsageFablePlaceholder(t *testing.T) {
	empty := availability{bucket: map[string]string{}, reset: map[string]int64{}}
	next := availability{
		ok:     true,
		bucket: map[string]string{"claude-fable": "ok"},
		reset:  map[string]int64{},
		wins: []usageWin{
			{label: "Claude 5 Hour", pct: 20, secs: 3000, dur: 5 * 3600, prov: "anthropic"},
		},
	}
	got, stale := reconcileUsage(empty, next)
	if stale {
		t.Fatal("a successful first fetch must not read stale")
	}
	fable := usageWin{}
	found := false
	for _, w := range got.wins {
		if w.tier == "fable" {
			fable, found = w, true
		}
	}
	if !found {
		t.Fatalf("a missing fable window with no prior value must gain a placeholder: %+v", got.wins)
	}
	if !fable.missing || fable.stale || fable.pct != 0 {
		t.Errorf("the placeholder must be marked missing and carry no value: %+v", fable)
	}
	m := layoutModel()
	row := stripAnsi(m.usageRow(fable))
	if !strings.Contains(row, "7d fable") || !strings.Contains(row, "··%") || !strings.Contains(row, "unavailable") {
		t.Errorf("placeholder row must read as a deterministic unavailable stand-in: %q", row)
	}
	if regexp.MustCompile(`\d+% used`).MatchString(row) || strings.Contains(row, "█") {
		t.Errorf("the placeholder must not fabricate values: %q", row)
	}

	// Geometry: swapping the placeholder for a later real value never pops
	// the stacked column's row count.
	mp := layoutModel()
	mp.avail = got
	real := got
	real.wins = append([]usageWin(nil), got.wins...)
	for i := range real.wins {
		if real.wins[i].missing {
			real.wins[i] = usageWin{label: "Claude 7 Day (Fable)", pct: 40, tier: "fable", secs: 4 * day, dur: 7 * day, prov: "anthropic"}
		}
	}
	mr := layoutModel()
	mr.avail = real
	if hp, hr := lipgloss.Height(mp.usageColumn()), lipgloss.Height(mr.usageColumn()); hp != hr {
		t.Errorf("placeholder column is %d rows, real column %d — the datum appearing would pop the layout", hp, hr)
	}

	// No anthropic report at all: nothing to place a row under.
	gptOnly := availability{ok: true, bucket: map[string]string{}, reset: map[string]int64{},
		wins: []usageWin{{label: "5 hours", pct: 5, secs: 3600, dur: 5 * 3600, prov: "openai-codex"}}}
	if got, _ := reconcileUsage(empty, gptOnly); len(got.wins) != 1 {
		t.Errorf("no anthropic windows → no fable placeholder: %+v", got.wins)
	}

	// A payload carrying the fable window passes through untouched.
	withFable := availability{ok: true, bucket: map[string]string{}, reset: map[string]int64{},
		wins: []usageWin{
			{label: "Claude 5 Hour", pct: 20, secs: 3000, dur: 5 * 3600, prov: "anthropic"},
			{label: "Claude 7 Day (Fable)", pct: 7, tier: "fable", secs: 2 * day, dur: 7 * day, prov: "anthropic"},
		}}
	got2, _ := reconcileUsage(got, withFable)
	if len(got2.wins) != 2 || got2.wins[1].stale || got2.wins[1].missing || got2.wins[1].pct != 7 {
		t.Errorf("a present fable window must pass through fresh: %+v", got2.wins)
	}
}

func TestFableSkeletonAndUnavailableStatusStayStable(t *testing.T) {
	m := layoutModel()
	skeleton := stripAnsi(m.skeletonBody(0))
	if strings.Count(skeleton, "7d fable") != 1 {
		t.Fatalf("the pre-fetch skeleton must always reserve one Fable row:\n%s", skeleton)
	}

	missing := stripAnsi(m.usageRow(usageWin{
		label: "Claude 7 Day (Fable)", tier: "fable", missing: true,
	}))
	tight := stripAnsi(m.usageRow(usageWin{
		label: "Claude 7 Day (Fable)", tier: "fable", pct: 85,
		secs: 2 * day, dur: 7 * day,
	}))
	missingAt := strings.Index(missing, "unavailable")
	tightAt := strings.Index(tight, "tight")
	if missingAt < 0 || tightAt < 0 {
		t.Fatalf("status labels missing: unavailable=%q tight=%q", missing, tight)
	}
	if got, want := lipgloss.Width(missing[:missingAt]), lipgloss.Width(tight[:tightAt]); got != want {
		t.Fatalf("Fable unavailable status column = %d, want the normal status column %d\nmissing: %s\ntight:   %s",
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
			claude:        {{label: "Claude 7 Day (Fable)", pct: 31, tier: "fable", secs: 2 * day, dur: 7 * day, prov: "anthropic"}},
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
		if got.bucket["claude-main"] != "ok" || got.bucket["claude-fable"] != "ok" {
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
	m.sel["fable"] = "on"
	lines, _ = m.genLines()
	text := stripAnsi(strings.Join(lines, "\n"))
	for _, want := range []string{"Spark unavailable", "Fable unavailable"} {
		if !strings.Contains(text, want) {
			t.Fatalf("all-disabled selection missing %q advisory:\n%s", want, text)
		}
	}
}

func TestReconcileUsageRetainsFablePerAccountIdentity(t *testing.T) {
	key := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	prevFable := usageWin{label: "Claude 7 Day (Fable)", pct: 72, tier: "fable", secs: 3 * day, dur: 7 * day, prov: "anthropic", observed: 123}
	prev := availability{
		ok: true, bucket: map[string]string{}, reset: map[string]int64{},
		wins: []usageWin{{label: "Claude 5 Hour", pct: 10, secs: 1, dur: 5 * 3600, prov: "anthropic"}, prevFable},
		accountUsage: map[accountKey][]usageWin{key: {
			{label: "Claude 5 Hour", pct: 10, secs: 1, dur: 5 * 3600, prov: "anthropic"},
			prevFable,
		}},
	}
	next := availability{
		ok: true, bucket: map[string]string{}, reset: map[string]int64{},
		wins: []usageWin{{label: "Claude 5 Hour", pct: 20, secs: 2, dur: 5 * 3600, prov: "anthropic"}},
		accountUsage: map[accountKey][]usageWin{key: {
			{label: "Claude 5 Hour", pct: 20, secs: 2, dur: 5 * 3600, prov: "anthropic"},
		}},
	}
	got, _ := reconcileUsage(prev, next)
	accountWins := got.accountUsage[key]
	if len(accountWins) != 2 || !accountWins[1].stale || accountWins[1].missing ||
		accountWins[1].pct != 72 || accountWins[1].observed != 123 {
		t.Fatalf("per-account Fable retention = %+v", accountWins)
	}

	freshNext := availability{
		ok: true, bucket: map[string]string{}, reset: map[string]int64{},
		wins: []usageWin{{label: "Claude 5 Hour", pct: 20, secs: 2, dur: 5 * 3600, prov: "anthropic"}},
		accountUsage: map[accountKey][]usageWin{key: {
			{label: "Claude 5 Hour", pct: 20, secs: 2, dur: 5 * 3600, prov: "anthropic"},
		}},
	}
	first, _ := reconcileUsage(availability{bucket: map[string]string{}, reset: map[string]int64{}}, freshNext)
	firstWins := first.accountUsage[key]
	if len(firstWins) != 2 || !firstWins[1].missing {
		t.Fatalf("first missing per-account Fable must be explicit, got %+v", firstWins)
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
			allowlistCopy := filepath.Join(dir, "allowlist-copy")
			script := filepath.Join(dir, "omp")
			body := fmt.Sprintf(`#!/bin/sh
cfg=
take_cfg=
for arg in "$@"; do
  if [ "$take_cfg" = yes ]; then cfg="$arg"; take_cfg=; fi
  if [ "$arg" = --config ]; then take_cfg=yes; fi
done
[ -f "$OMP_AUTH_ACCOUNT_ALLOWLIST_FILE" ] || exit 97
[ -f "$cfg" ] || exit 98
printf '%%s\n%%s\n%%s\n%%s\n%%s\n%%s\n' "$OMP_AUTH_ACCOUNT_ALLOWLIST_FILE" "$cfg" "$OMP_AUTH_BROKER_URL" "$OMP_AUTH_BROKER_TOKEN" "$OMP_AUTH_BROKER_SNAPSHOT_CACHE" "$*" > "$CAPTURE"
cat "$OMP_AUTH_ACCOUNT_ALLOWLIST_FILE" > "$ALLOWLIST_COPY"
exit %d
`, tc.exit)
			if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CODE_OMP", script)
			t.Setenv("CAPTURE", capture)
			t.Setenv("ALLOWLIST_COPY", allowlistCopy)
			oldArgs := os.Args
			os.Args = []string{"code", "--profile", "forwarded", "--profile=also-forwarded", "hello"}
			defer func() { os.Args = oldArgs }()

			selections := defaultAccountSelectionState()
			selections.SetManualDisabled(map[accountKey]bool{
				{Provider: "openai-codex", IdentityKey: "unmatched-key"}: true,
			})
			status := launchGenerated("models: {}\n", "prompt", broker, selections)
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
				t.Errorf("allowlist survived child exit: %q err=%v", lines[0], err)
			}
			if _, err := os.Stat(lines[1]); !os.IsNotExist(err) {
				t.Errorf("generated config survived child exit: %q err=%v", lines[1], err)
			}
			if lines[2] != broker.URL || lines[3] != broker.Token || lines[4] != broker.SnapshotCache {
				t.Errorf("trusted auth env = %q, want broker overlay", lines[2:5])
			}
			allowlistBody, err := os.ReadFile(allowlistCopy)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(allowlistBody), "unmatched-key") ||
				!strings.Contains(string(allowlistBody), "anthropic-key") ||
				!strings.Contains(string(allowlistBody), "codex-key") {
				t.Errorf("launch allowlist ignored immutable account selection: %s", allowlistBody)
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
printf '%s|%s|%s' "$OMP_AUTH_ACCOUNT_ALLOWLIST_FILE" "$OMP_AUTH_BROKER_URL" "$OMP_AUTH_BROKER_TOKEN" > "$ENV_COPY"
cat "$OMP_AUTH_ACCOUNT_ALLOWLIST_FILE" > "$ALLOWLIST_COPY"
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
		allowlistCopy := filepath.Join(dir, label+"-allowlist")
		t.Setenv("ENV_COPY", envCopy)
		t.Setenv("ALLOWLIST_COPY", allowlistCopy)
		if status := runTrusted("CODE_OMP", nil, managedLaunchArgv, "", broker, selections); status != 0 {
			t.Fatalf("%s launch status = %d", label, status)
		}
		envBody, err := os.ReadFile(envCopy)
		if err != nil {
			t.Fatal(err)
		}
		allowlistBody, err := os.ReadFile(allowlistCopy)
		if err != nil {
			t.Fatal(err)
		}
		return string(envBody), string(allowlistBody)
	}

	manualEnv, manualAllowlist := launch("manual")
	const wantManual = "{\"anthropic\":[],\"openai-codex\":[\"codex-key\",\"unmatched-key\"]}\n"
	if manualAllowlist != wantManual {
		t.Fatalf("Manual allowlist = %q, want %q", manualAllowlist, wantManual)
	}
	manualEnvParts := strings.Split(manualEnv, "|")
	if len(manualEnvParts) != 3 || manualEnvParts[1] != broker.URL || manualEnvParts[2] != broker.Token {
		t.Fatalf("Manual child env = %q", manualEnv)
	}
	if _, err := os.Stat(manualEnvParts[0]); !os.IsNotExist(err) {
		t.Fatalf("Manual child's captured allowlist remains mutable after exit: %v", err)
	}

	if !selections.Activate("Codex off") {
		t.Fatal("named preset did not activate")
	}
	namedEnv, namedAllowlist := launch("named")
	const wantNamed = "{\"anthropic\":[\"anthropic-key\"],\"openai-codex\":[\"unmatched-key\"]}\n"
	if namedAllowlist != wantNamed {
		t.Fatalf("named allowlist = %q, want %q", namedAllowlist, wantNamed)
	}
	manualAllowlistAfter, err := os.ReadFile(filepath.Join(dir, "manual-allowlist"))
	if err != nil {
		t.Fatal(err)
	}
	manualEnvAfter, err := os.ReadFile(filepath.Join(dir, "manual-env"))
	if err != nil {
		t.Fatal(err)
	}
	if string(manualAllowlistAfter) != wantManual || string(manualEnvAfter) != manualEnv {
		t.Fatal("preset switch mutated already-captured Manual child inputs")
	}
	namedEnvParts := strings.Split(namedEnv, "|")
	if len(namedEnvParts) != 3 || namedEnvParts[0] == manualEnvParts[0] {
		t.Fatalf("future launch did not receive a fresh immutable allowlist: manual=%q named=%q", manualEnv, namedEnv)
	}
	if _, err := os.Stat(namedEnvParts[0]); !os.IsNotExist(err) {
		t.Fatalf("named child's captured allowlist remains mutable after exit: %v", err)
	}
}

func TestTrustedLaunchAbortsWithoutSnapshot(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "started")
	script := filepath.Join(dir, "omp")
	if err := os.WriteFile(script, []byte("#!/bin/sh\n: > \"$MARKER\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_OMP", script)
	t.Setenv("MARKER", marker)
	if status := runTrusted("CODE_OMP", nil, managedLaunchArgv, "", brokerConfig{}, defaultAccountSelectionState()); status == 0 {
		t.Fatal("trusted launch without a snapshot unexpectedly succeeded")
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("trusted child started without a snapshot: %v", err)
	}
}

func TestSandboxLaunchStripsInheritedBrokerEnvironment(t *testing.T) {
	dir := t.TempDir()
	capture := filepath.Join(dir, "env")
	script := filepath.Join(dir, "ompu")
	body := "#!/bin/sh\nprintf '%s|%s|%s|%s|%s\\n' \"${OMP_AUTH_BROKER_URL+set}\" \"${OMP_AUTH_BROKER_TOKEN+set}\" \"${OMP_AUTH_BROKER_SNAPSHOT_CACHE+set}\" \"${OMP_AUTH_ACCOUNT_ALLOWLIST_FILE+set}\" \"${CODE_AUTH_ACCOUNT_STATE+set}\" > \"$CAPTURE\"\n"
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODE_OMP_UNTRUSTED", script)
	t.Setenv("CAPTURE", capture)
	t.Setenv("OMP_AUTH_BROKER_URL", "http://ambient")
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "ambient-secret")
	t.Setenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE", "/tmp/ambient")
	t.Setenv("OMP_AUTH_ACCOUNT_ALLOWLIST_FILE", "/tmp/ambient-allowlist")
	t.Setenv("CODE_AUTH_ACCOUNT_STATE", "/tmp/ambient-state")
	oldArgs := os.Args
	os.Args = []string{"code", "--profile", "ambient"}
	defer func() { os.Args = oldArgs }()
	if status := runSandbox("CODE_OMP_UNTRUSTED", nil, ""); status != 0 {
		t.Fatalf("sandbox status = %d", status)
	}
	raw, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(raw)); got != "||||" {
		t.Errorf("sandbox inherited auth routing: %q", got)
	}
}
