package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// managerModel is a three-vault model with representative loaded, unavailable,
// and never-fetched states.
func managerModel() model {
	m := layoutModel()
	m.vaults = []vault{
		{ID: "primary", Label: "primary", Profile: "default", Claude: "Operator", Codex: "Operator"},
		{ID: "secondary", Label: "secondary", Profile: "secondary", Claude: "Collaborator", Codex: "Operator"},
		{ID: "tertiary", Label: "tertiary", Profile: "tertiary", Claude: "Reviewer", Codex: "Operator"},
	}
	m.selected = "primary"
	m.disabled = map[string]bool{}
	m.vaultUsage = map[string]availability{
		"primary": {
			ok: true, bucket: map[string]string{}, reset: map[string]int64{},
			accountsOK: true, accounts: map[string][]vaultAccount{
				"anthropic":    {{Provider: "anthropic", Email: "operator.claude@example.test"}},
				"openai-codex": {{Provider: "openai-codex", Email: "operator.codex@example.test"}},
			},
			wins: []usageWin{{prov: "openai-codex", pct: 12}, {prov: "anthropic", pct: 55}},
		},
		"secondary": {
			ok: false, bucket: map[string]string{}, reset: map[string]int64{},
			accountsOK: true, accounts: map[string][]vaultAccount{},
		},
	}
	m.vaultUsageNext = map[string]time.Time{
		"primary":   time.Now().Add(refreshEvery),
		"secondary": time.Now().Add(refreshEvery),
	}
	m.vaultUsageStale = map[string]bool{}
	m.vaultFetching = map[string]bool{"tertiary": true}
	m.manager = true
	return m
}

func keyFor(k string) tea.KeyMsg {
	switch k {
	case "up":
		return tea.KeyMsg{Type: tea.KeyUp}
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		return tea.KeyMsg{Type: tea.KeyEsc}
	case "space":
		return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(" ")}
	default:
		return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
	}
}

func sendKey(t *testing.T, m model, k string) (model, tea.Cmd) {
	t.Helper()
	nm, cmd := m.Update(keyFor(k))
	return nm.(model), cmd
}

func editableManagerModel(t *testing.T) model {
	t.Helper()
	m := managerModel()
	root := t.TempDir()
	m.vaultManifest = filepath.Join(root, "config", "vaults.json")
	m.vaultState = filepath.Join(root, "state", "selection.json")
	t.Setenv("XDG_STATE_HOME", filepath.Join(root, "xdg-state"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(root, "xdg-cache"))
	for i := range m.vaults {
		m.vaults[i].BrokerURL = fmt.Sprintf("http://127.0.0.1:%d", 43000+i)
		m.vaults[i].TokenFile = filepath.Join(root, "tokens", m.vaults[i].ID)
		m.vaults[i].SnapshotCache = filepath.Join(root, "cache", m.vaults[i].ID)
	}
	return m
}

func TestManagerOpenAndClose(t *testing.T) {
	m := multiProfileModel()
	wide, _, _, _ := layoutSizes(t, m)
	m = resize(t, m, wide.w, wide.h)

	opened, cmd := sendKey(t, m, "v")
	if !opened.manager {
		t.Fatal("v must open the manager")
	}
	if cmd != nil {
		t.Fatal("opening the manager must reuse the startup cache without refreshing")
	}
	if opened.mgrCursor != opened.activeIndex() {
		t.Fatalf("manager must open on the active vault, cursor=%d active=%d", opened.mgrCursor, opened.activeIndex())
	}
	if closed, _ := sendKey(t, opened, "esc"); closed.manager {
		t.Fatal("esc must close the manager")
	}
	if closed, _ := sendKey(t, opened, "v"); closed.manager {
		t.Fatal("v must toggle the manager closed")
	}
}

func TestManagerCursorNavigation(t *testing.T) {
	m := managerModel()
	m.mgrCursor = 0
	m, _ = sendKey(t, m, "down")
	m, _ = sendKey(t, m, "down")
	if m.mgrCursor != 2 {
		t.Fatalf("down must advance the cursor, got %d", m.mgrCursor)
	}
	m, _ = sendKey(t, m, "down")
	if m.mgrCursor != 2 {
		t.Fatalf("down must clamp at the last vault, got %d", m.mgrCursor)
	}
	m, _ = sendKey(t, m, "up")
	if m.mgrCursor != 1 {
		t.Fatalf("up must retreat the cursor, got %d", m.mgrCursor)
	}
	for range 5 {
		m, _ = sendKey(t, m, "up")
	}
	if m.mgrCursor != 0 {
		t.Fatalf("up must clamp at the first vault, got %d", m.mgrCursor)
	}
}

func TestManagerHighlightScopesUsageAndSharesVisibility(t *testing.T) {
	m := managerModel()
	m.hideUsage = false
	if panel := stripAnsi(m.managerUsagePanel()); !strings.Contains(panel, "usage") || !strings.Contains(panel, "primary") ||
		!strings.Contains(panel, "operator.codex@example.test") {
		t.Fatalf("initial manager Usage is not scoped to highlighted primary:\n%s", panel)
	}
	m, _ = sendKey(t, m, "down")
	if m.selected != "primary" {
		t.Fatalf("arrow navigation must not select the highlighted vault, selected=%q", m.selected)
	}
	if panel := stripAnsi(m.managerUsagePanel()); !strings.Contains(panel, "usage") || !strings.Contains(panel, "secondary") ||
		strings.Contains(panel, "operator.codex@example.test") {
		t.Fatalf("arrow navigation did not retarget detailed Usage:\n%s", panel)
	}
	m, _ = sendKey(t, m, "s")
	if !m.hideUsage {
		t.Fatal("manager s must hide the shared Usage state")
	}
	m, _ = sendKey(t, m, "s")
	if m.hideUsage {
		t.Fatal("manager s must restore the shared Usage state")
	}
}

func TestManagerActivateSelectsCursoredVault(t *testing.T) {
	m := managerModel()
	m.mgrCursor = 1 // secondary
	m, cmd := sendKey(t, m, "enter")
	if m.selected != "secondary" {
		t.Fatalf("enter must activate the cursored vault, selected=%q", m.selected)
	}
	if cmd != nil {
		t.Fatal("activating a cached vault must not refetch its usage")
	}
	if got := m.avail.accountsOK; !got {
		t.Fatal("activating a cached vault must restore its detailed Usage immediately")
	}
}
func TestManagerActivateEnablesDisabledVault(t *testing.T) {
	m := managerModel()
	m.disabled = map[string]bool{"tertiary": true}
	m.mgrCursor = 2 // tertiary (disabled)
	m, _ = sendKey(t, m, "enter")
	if m.disabled["tertiary"] {
		t.Fatal("activating a disabled vault must enable it")
	}
	if m.selected != "tertiary" {
		t.Fatalf("enter must select tertiary, selected=%q", m.selected)
	}
}

func TestManagerSpaceTogglesEnabledAndProtectsFallback(t *testing.T) {
	m := managerModel()
	m.mgrCursor = 1 // secondary
	m, _ = sendKey(t, m, "space")
	if !m.disabled["secondary"] {
		t.Fatal("space must disable an enabled vault")
	}
	m, _ = sendKey(t, m, "space")
	if m.disabled["secondary"] {
		t.Fatal("space must re-enable a disabled vault")
	}

	m.mgrCursor = 0 // protected fallback
	m, _ = sendKey(t, m, "space")
	if m.disabled["primary"] || !m.isEnabled(0) {
		t.Fatal("the fallback vault must never be disabled from the manager")
	}
}

func TestManagerRefreshAllRefetches(t *testing.T) {
	m := managerModel()
	m, cmd := sendKey(t, m, "r")
	if cmd == nil {
		t.Fatal("r must refresh every vault")
	}
	if !m.fetching {
		t.Fatal("r must mark the active fetch in flight")
	}
	for _, v := range m.vaults {
		if !m.vaultFetching[v.ID] {
			t.Errorf("r did not mark %q usage fetch in flight", v.ID)
		}
	}
}

func TestManagerLoginKeysReturnCommands(t *testing.T) {
	m := managerModel()
	m.mgrCursor = 1
	if _, cmd := sendKey(t, m, "c"); cmd == nil {
		t.Fatal("c must launch the Anthropic login handoff")
	}
	if _, cmd := sendKey(t, m, "o"); cmd == nil {
		t.Fatal("o must launch the openai-codex login handoff")
	}
}

func TestManagerDoesNotQueueLoginHandoffs(t *testing.T) {
	m := managerModel()
	m.mgrCursor = 1
	m, first := sendKey(t, m, "c")
	if first == nil || !m.loginRunning {
		t.Fatal("the first login must start and mark the handoff active")
	}
	m, second := sendKey(t, m, "o")
	if second != nil {
		t.Fatal("a second login key must be ignored while a handoff is active")
	}

	nm, _ := m.Update(loginDoneMsg{vault: "secondary", err: errLoginCancelled})
	m = nm.(model)
	if m.loginRunning {
		t.Fatal("login completion must release the handoff guard")
	}
	if m.vaultErr != "" {
		t.Fatalf("cancellation must not render as a failure: %q", m.vaultErr)
	}

	m.loginRunning = true
	nm, _ = m.Update(loginDoneMsg{vault: "secondary", err: errors.New("provider failed")})
	m = nm.(model)
	if m.vaultErr != "login failed: provider failed" {
		t.Fatalf("real login error was not preserved: %q", m.vaultErr)
	}
}

func TestLoginProcessSuppressesReadlineCancellation(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestLoginProcessHelper$")
	cmd.Env = append(os.Environ(), "CODE_LOGIN_HELPER=cancel")
	p := &loginProcess{cmd: cmd}
	p.SetStdin(strings.NewReader(""))
	p.SetStdout(io.Discard)
	var visible bytes.Buffer
	p.SetStderr(&visible)

	if err := p.Run(); !errors.Is(err, errLoginCancelled) {
		t.Fatalf("cancel error = %v, want errLoginCancelled", err)
	}
	if visible.Len() != 0 {
		t.Fatalf("readline cancellation leaked to terminal: %q", visible.String())
	}
}

func TestLoginProcessPreservesRealDiagnostics(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestLoginProcessHelper$")
	cmd.Env = append(os.Environ(), "CODE_LOGIN_HELPER=error")
	p := &loginProcess{cmd: cmd}
	p.SetStdin(strings.NewReader(""))
	p.SetStdout(io.Discard)
	var visible bytes.Buffer
	p.SetStderr(&visible)

	err := p.Run()
	if err == nil || errors.Is(err, errLoginCancelled) {
		t.Fatalf("real process error was misclassified: %v", err)
	}
	if visible.String() != "provider login failed\n" {
		t.Fatalf("real diagnostic = %q", visible.String())
	}
}

func TestLoginProcessHelper(t *testing.T) {
	switch os.Getenv("CODE_LOGIN_HELPER") {
	case "cancel":
		_, _ = os.Stderr.WriteString("error: readline was closed\n code: \"ERR_USE_AFTER_CLOSE\"\n")
		os.Exit(1)
	case "error":
		_, _ = os.Stderr.WriteString("provider login failed\n")
		os.Exit(1)
	}
}

func TestManagerStaleUsageScopedByVault(t *testing.T) {
	m := managerModel()
	m.selected = "primary"
	m.avail = availability{bucket: map[string]string{}, reset: map[string]int64{}}
	m.hadUsage = false

	ok := availability{ok: true, bucket: map[string]string{}, reset: map[string]int64{}, wins: []usageWin{{prov: "anthropic", pct: 70}}}

	// A reply for a non-active vault is stored under that vault and never
	// touches the detailed panel or produces a command.
	nm, cmd := m.Update(usageMsg{vault: "secondary", avail: ok})
	m = nm.(model)
	if cmd != nil {
		t.Fatal("a non-active vault reply must not drive the detailed panel's fill")
	}
	if m.avail.ok {
		t.Fatal("a non-active vault reply must not populate the detailed panel")
	}
	if !m.vaultUsage["secondary"].ok {
		t.Fatal("a reply must be stored under its own vault for the manager")
	}

	// A reply for the active vault does update the detailed panel.
	nm, _ = m.Update(usageMsg{vault: "primary", avail: ok})
	m = nm.(model)
	if !m.avail.ok {
		t.Fatal("the active vault's reply must populate the detailed panel")
	}
}

func TestManagerRetainsCachedFablePerVault(t *testing.T) {
	m := managerModel()
	m.selected = "primary"
	first := availability{
		ok: true, bucket: map[string]string{"claude-fable": "ok"}, reset: map[string]int64{},
		wins: []usageWin{
			{label: "Claude 5 Hour", prov: "anthropic", pct: 20},
			{label: "Claude 7 Day (Fable)", prov: "anthropic", tier: "fable", pct: 45, observed: 1_752_665_040},
		},
	}
	nm, _ := m.Update(usageMsg{vault: "secondary", avail: first})
	m = nm.(model)
	second := availability{
		ok: true, bucket: map[string]string{"claude-fable": "ok"}, reset: map[string]int64{},
		wins: []usageWin{{label: "Claude 5 Hour", prov: "anthropic", pct: 30}},
	}
	nm, _ = m.Update(usageMsg{vault: "secondary", avail: second})
	m = nm.(model)

	found := false
	for _, w := range m.vaultUsage["secondary"].wins {
		if w.tier == "fable" {
			found = true
			if !w.stale || w.pct != 45 || w.observed != 1_752_665_040 {
				t.Fatalf("per-vault Fable cache was not retained: %+v", w)
			}
		}
	}
	if !found {
		t.Fatal("per-vault Fable cache disappeared after an omitted refresh")
	}
}

func TestManagerProviderAccountsAndOrdering(t *testing.T) {
	m := managerModel()
	m.vaults[0].Claude = "owner-claude-label"
	m.vaults[0].Codex = "owner-codex-a + owner-codex-b"
	m.vaultUsage["primary"] = availability{
		ok: true, accountsOK: true,
		bucket: map[string]string{}, reset: map[string]int64{},
		accounts: map[string][]vaultAccount{
			"openai-codex": {
				{Provider: "openai-codex", IdentityKey: "opaque-z", Email: "z@example.test"},
				{Provider: "openai-codex", IdentityKey: "opaque-a", Email: "a@example.test"},
			},
			"anthropic": {
				{Provider: "anthropic", IdentityKey: "opaque-claude", Email: "claude@example.test"},
			},
		},
		wins: []usageWin{{prov: "openai-codex", pct: 12}, {prov: "anthropic", pct: 55}},
	}

	panel := stripAnsi(m.managerUsagePanel())
	codex := strings.Index(panel, "Codex")
	a := strings.Index(panel, "a@example.test")
	z := strings.Index(panel, "z@example.test")
	codexUsage := strings.Index(panel, "12% used")
	claude := strings.Index(panel, "Claude")
	claudeEmail := strings.Index(panel, "claude@example.test")
	claudeUsage := strings.Index(panel, "55% used")
	if !(codex >= 0 && codex < a && a < z && z < codexUsage &&
		codexUsage < claude && claude < claudeEmail && claudeEmail < claudeUsage) {
		t.Fatalf("manager detail must reuse full Usage with Codex first and sorted accounts:\n%s", panel)
	}
	for _, forbidden := range []string{"owner-claude-label", "owner-codex-a + owner-codex-b", "opaque-z", "opaque-a", "opaque-claude"} {
		if strings.Contains(panel, forbidden) {
			t.Errorf("manager rendered configured or opaque identity %q:\n%s", forbidden, panel)
		}
	}
	if row := stripAnsi(m.managerRow(0, 200)); strings.Contains(row, "% used") ||
		strings.Contains(row, "@example.test") || strings.Contains(row, "Codex") || strings.Contains(row, "Claude") {
		t.Fatalf("vault row duplicated provider/account/usage detail: %q", row)
	}
	// Rendering sorts a copied email list and must not mutate the snapshot.
	if got := m.vaultUsage["primary"].accounts["openai-codex"][0].Email; got != "z@example.test" {
		t.Errorf("rendering mutated account snapshot order: first email = %q", got)
	}

	m.mgrCursor = 1
	if panel := stripAnsi(m.managerUsagePanel()); strings.Count(panel, "not authenticated") != 2 {
		t.Errorf("zero-account providers must remain explicit:\n%s", panel)
	}
	m.mgrCursor = 2
	if panel := stripAnsi(m.managerUsagePanel()); strings.Count(panel, "checking account…") != 2 {
		t.Errorf("an in-flight unloaded vault must remain explicit:\n%s", panel)
	}
}

func TestManagerRenderingWithinBounds(t *testing.T) {
	base := managerModel()
	// A fourth, disabled vault so one row exercises every state at once.
	base.vaults = append(base.vaults, vault{ID: "guest", Label: "guest", Profile: "guest", Claude: "Guest", Codex: "Operator"})
	base.disabled = map[string]bool{"guest": true}
	wideW := base.genRowWidth() + routingMinW
	for _, s := range []termSize{{wideW + 20, 40}, {72, 30}, {50, 20}} {
		m := resize(t, base, s.w, s.h)
		view := m.View()
		for _, line := range strings.Split(view, "\n") {
			if w := lipgloss.Width(line); w > s.w {
				t.Errorf("width %d: manager line overflows (%d): %q", s.w, w, stripAnsi(line))
			}
		}
		plain := stripAnsi(view)
		for _, want := range []string{
			"vaults", "primary", "secondary", "tertiary", "usage",
		} {
			if !strings.Contains(plain, want) {
				t.Errorf("width %d: manager view missing %q:\n%s", s.w, want, plain)
			}
		}

		if s.h >= 30 && (!strings.Contains(plain, "guest") || !strings.Contains(plain, "disabled")) {
			t.Errorf("width %d: manager view must show the disabled vault when height seats it:\n%s", s.w, plain)
		}
		// The highlighted vault's full Usage footer owns provider identity and
		// aggregate usage; list rows never duplicate it.
		if s.w >= 100 &&
			(!strings.Contains(plain, "operator.claude@example.test") ||
				!strings.Contains(plain, "55% used") ||
				!strings.Contains(plain, "operator.codex@example.test") ||
				!strings.Contains(plain, "12% used")) {
			t.Errorf("width %d: manager did not render provider accounts and usage:\n%s", s.w, plain)
		}
		// A control cue row is always present.
		if !strings.Contains(plain, "v") {
			t.Errorf("width %d: manager missing control cues:\n%s", s.w, plain)
		}
	}
}

func TestManagerSectionsAndFooterShareVisualContract(t *testing.T) {
	m := resize(t, managerModel(), 100, 40)
	lines := strings.Split(stripAnsi(m.View()), "\n")
	rule := strings.Repeat("─", m.w)
	usage := lineIndex(lines, "usage", "primary")
	controls := lineIndex(lines, "↑↓", "move")
	if usage <= 0 || lines[usage-1] != rule {
		t.Fatalf("visible Usage must have a full-width top boundary:\n%s", strings.Join(lines, "\n"))
	}
	if controls <= 0 || lines[controls-1] != rule {
		t.Fatalf("manager controls must have a full-width top boundary:\n%s", strings.Join(lines, "\n"))
	}
	if got := strings.Count(strings.Join(lines, "\n"), rule); got != 2 {
		t.Fatalf("visible Usage + controls must render exactly two boundaries, got %d", got)
	}

	styledCue := m.help.Styles.ShortKey.Inline(true).Render("↑↓") + " " +
		m.help.Styles.ShortDesc.Inline(true).Render("move")
	if !strings.Contains(m.managerControls(100), styledCue) {
		t.Fatal("manager controls do not use the shared Help key/description styles")
	}

	m.hideUsage = true
	hidden := strings.Split(stripAnsi(m.View()), "\n")
	if lineIndex(hidden, "usage", "primary") >= 0 {
		t.Fatalf("hidden Usage remained visible:\n%s", strings.Join(hidden, "\n"))
	}
	hiddenControls := lineIndex(hidden, "↑↓", "move")
	if hiddenControls <= 0 || hidden[hiddenControls-1] != rule {
		t.Fatalf("hidden Usage left controls without their boundary:\n%s", strings.Join(hidden, "\n"))
	}
	if got := strings.Count(strings.Join(hidden, "\n"), rule); got != 1 {
		t.Fatalf("hidden Usage must remove its boundary, got %d total boundaries", got)
	}
	if controls := stripAnsi(m.managerControls(20)); !strings.Contains(controls, "show usage") {
		t.Fatalf("compact manager controls lost dynamic Usage state: %q", controls)
	}
}
func TestManagerCreatePromptCommitAndExistingEntryInvariant(t *testing.T) {
	m := editableManagerModel(t)
	before := append([]vault(nil), m.vaults...)
	credential := filepath.Join(t.TempDir(), "auth.db")
	if err := os.WriteFile(credential, []byte("credential sentinel"), 0o600); err != nil {
		t.Fatal(err)
	}

	m, _ = sendKey(t, m, "n")
	if m.managerInput != "create" || !strings.Contains(stripAnsi(m.managerView()), "New vault name:") {
		t.Fatalf("n must open an explicit create prompt:\n%s", stripAnsi(m.managerView()))
	}
	m, _ = sendKey(t, m, "Team")
	m, _ = sendKey(t, m, "space")
	m, _ = sendKey(t, m, "Vault")
	m, _ = sendKey(t, m, "enter")
	if m.managerInput != "" || len(m.vaults) != len(before)+1 {
		t.Fatalf("create did not commit: mode=%q vaults=%#v", m.managerInput, m.vaults)
	}
	if !reflect.DeepEqual(m.vaults[:len(before)], before) {
		t.Fatalf("create changed an existing entry:\nbefore=%#v\nafter=%#v", before, m.vaults[:len(before)])
	}
	created := m.vaults[len(before)]
	if created.ID != "team-vault" || created.Profile != "team-vault" || created.Label != "Team Vault" {
		t.Fatalf("created vault identity = %+v", created)
	}
	if data, err := os.ReadFile(credential); err != nil || string(data) != "credential sentinel" {
		t.Fatalf("create touched credential sentinel: data=%q err=%v", data, err)
	}
}

func TestManagerRenameChangesOnlyLabel(t *testing.T) {
	m := editableManagerModel(t)
	m.mgrCursor = 1
	before := m.vaults[1]
	selected, disabled := m.selected, map[string]bool{"tertiary": true}
	m.disabled = disabled
	m, _ = sendKey(t, m, "e")
	if m.managerInput != "rename" || m.managerText != before.Label ||
		!strings.Contains(stripAnsi(m.managerView()), "Rename vault:") {
		t.Fatalf("e must open a prefilled rename prompt: mode=%q text=%q", m.managerInput, m.managerText)
	}
	for range len([]rune(before.Label)) {
		m, _ = sendKey(t, m, "backspace")
	}
	m, _ = sendKey(t, m, "Display")
	m, _ = sendKey(t, m, "space")
	m, _ = sendKey(t, m, "Only")
	m, _ = sendKey(t, m, "enter")
	after := m.vaults[1]
	want := before
	want.Label = "Display Only"
	if !reflect.DeepEqual(after, want) {
		t.Fatalf("rename changed immutable fields:\nwant=%+v\ngot=%+v", want, after)
	}
	if m.selected != selected || !reflect.DeepEqual(m.disabled, disabled) {
		t.Fatalf("rename changed selection state: selected=%q disabled=%v", m.selected, m.disabled)
	}
}

func TestManagerEditCancelAndRawJSONDisabled(t *testing.T) {
	m := editableManagerModel(t)
	m, _ = sendKey(t, m, "n")
	m, _ = sendKey(t, m, "discard me")
	m, _ = sendKey(t, m, "esc")
	if m.managerInput != "" || len(m.vaults) != 3 {
		t.Fatalf("Esc must cancel edit without changing vaults: mode=%q count=%d", m.managerInput, len(m.vaults))
	}

	m.vaultManifest = ""
	m, _ = sendKey(t, m, "n")
	if m.managerInput != "" || !strings.Contains(m.vaultErr, "editing is disabled") ||
		!strings.Contains(m.vaultErr, "CODE_AUTH_VAULTS") {
		t.Fatalf("raw JSON editing error is unclear: %q", m.vaultErr)
	}
}

func TestManagerControlsWrapLabelsWhenNarrow(t *testing.T) {
	m := managerModel()
	wide := m.managerControls(200)
	if !strings.Contains(stripAnsi(wide), "select") ||
		!strings.Contains(stripAnsi(wide), "login Claude in profile default") {
		t.Fatalf("wide controls must name only the provider and immutable profile: %q", stripAnsi(wide))
	}
	for _, forbidden := range []string{"Operator", "Collaborator", "Reviewer"} {
		if strings.Contains(stripAnsi(wide), forbidden) {
			t.Fatalf("login cue leaked configured owner alias %q: %q", forbidden, stripAnsi(wide))
		}
	}
	narrow := m.managerControls(20)
	plain := stripAnsi(narrow)
	for _, label := range []string{"move", "select", "enable", "new", "rename", "refresh", "close", "Claude login", "Codex login"} {
		if !strings.Contains(plain, label) {
			t.Fatalf("narrow controls dropped %q: %q", label, plain)
		}
	}
	for _, line := range strings.Split(narrow, "\n") {
		if lipgloss.Width(line) > 20 {
			t.Fatalf("narrow control line must fit the width, got %d: %q", lipgloss.Width(line), stripAnsi(line))
		}
	}
}
