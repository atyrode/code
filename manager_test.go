package main

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	clikit "github.com/atyrode/cli-kit"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

func managerTestModel(t *testing.T) model {
	t.Helper()
	m := layoutModel()
	m.w, m.h = 100, 32
	m.rdy = true
	m.manager = true
	m.broker = brokerConfig{
		URL: "http://127.0.0.1:43117", Token: "manager-token",
		SnapshotCache: filepath.Join(t.TempDir(), "snapshot.json"),
	}
	m.accountState = filepath.Join(t.TempDir(), "account-state.json")
	m.accountSelections = defaultAccountSelectionState()
	m.avail = availability{
		ok: true, accountsOK: true,
		bucket: map[string]string{}, reset: map[string]int64{},
		accounts: map[string][]account{
			"anthropic": {
				{Provider: "anthropic", IdentityKey: "anthropic-a", Email: "a.claude@example.test"},
				{Provider: "anthropic", IdentityKey: "anthropic-b", Email: "b.claude@example.test"},
				{Provider: "anthropic", IdentityKey: "anthropic-c"},
			},
			"openai-codex": {
				{Provider: "openai-codex", IdentityKey: "codex-a", Email: "a.codex@example.test"},
				{Provider: "openai-codex", IdentityKey: "codex-b", Email: "b.codex@example.test"},
			},
		},
		accountUsage: map[accountKey][]usageWin{
			{Provider: "anthropic", IdentityKey: "anthropic-a"}: {
				{label: "Claude 5 Hour", pct: 37, secs: 2 * 60 * 60, dur: 5 * 60 * 60, prov: "anthropic"},
				{label: "Claude 7 Day", pct: 85, secs: day, dur: 7 * day, prov: "anthropic"},
			},
			{Provider: "openai-codex", IdentityKey: "codex-a"}: {
				{label: "Codex 5 Hour", pct: 100, secs: 30 * 60, dur: 5 * 60 * 60, prov: "openai-codex"},
				{label: "Codex 7 Day", tier: "spark", pct: 0, secs: 7 * day, dur: 7 * day, prov: "openai-codex"},
			},
		},
	}
	return m
}

func managerKey(k string) tea.KeyMsg {
	switch k {
	case "up":
		return tea.KeyMsg{Type: tea.KeyUp}
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}
	case "ctrl+c":
		return tea.KeyMsg{Type: tea.KeyCtrlC}
	case "esc":
		return tea.KeyMsg{Type: tea.KeyEsc}
	case "left":
		return tea.KeyMsg{Type: tea.KeyLeft}
	case "right":
		return tea.KeyMsg{Type: tea.KeyRight}
	case "backspace":
		return tea.KeyMsg{Type: tea.KeyBackspace}
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	case "space":
		return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(" ")}
	default:
		return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)}
	}
}

func managerUpdate(t *testing.T, m model, key string) (model, tea.Cmd) {
	t.Helper()
	next, cmd := m.updateManager(managerKey(key))
	return next.(model), cmd
}

func assertManagerAccountSpacing(t *testing.T, lines []managerLine) {
	t.Helper()
	if len(lines) == 0 {
		return
	}
	if lines[0].spacer || lines[len(lines)-1].spacer {
		t.Fatalf("manager window has an orphaned edge spacer: %#v", lines)
	}
	headers := make([]int, 0, len(lines))
	for i, line := range lines {
		if line.spacer {
			if line.text != "" || (i > 0 && lines[i-1].spacer) {
				t.Fatalf("manager has a styled or stacked spacer at row %d: %#v", i, lines)
			}
		}
		if line.groupHeader {
			headers = append(headers, i)
		}
	}
	for i := 1; i < len(headers); i++ {
		previous, current := lines[headers[i-1]], lines[headers[i]]
		spacers := 0
		for _, line := range lines[headers[i-1]+1 : headers[i]] {
			if line.spacer {
				spacers++
			}
		}
		want := 0
		if previous.provider == current.provider {
			want = 1
		}
		if spacers != want {
			t.Fatalf("account headers at rows %d and %d have %d breathing rows, want %d: %#v",
				headers[i-1], headers[i], spacers, want, lines)
		}
	}
}

func TestManagerFlattensFiveStableAccountsByProvider(t *testing.T) {
	m := managerTestModel(t)
	got := m.managerAccounts()
	want := []string{"anthropic-a", "anthropic-b", "anthropic-c", "codex-a", "codex-b"}
	if len(got) != len(want) {
		t.Fatalf("managerAccounts count = %d, want %d", len(got), len(want))
	}
	for i, identity := range want {
		if got[i].IdentityKey != identity {
			t.Fatalf("managerAccounts[%d] = %q, want %q", i, got[i].IdentityKey, identity)
		}
	}

	plain := stripAnsi(m.managerView())
	anthropic := strings.Index(plain, "Anthropic")
	openAI := strings.Index(plain, "OpenAI")
	if anthropic < 0 || openAI <= anthropic {
		t.Fatalf("provider groups are missing or out of order:\n%s", plain)
	}
	if strings.Count(plain, "▸") != 1 {
		t.Fatalf("only an account row may be highlighted:\n%s", plain)
	}
}

func TestManagerCursorClampsAndCrossesProviderGroups(t *testing.T) {
	m := managerTestModel(t)
	for range 4 {
		m, _ = managerUpdate(t, m, "down")
	}
	if m.mgrCursor != 4 {
		t.Fatalf("cursor did not cross into OpenAI group: %d", m.mgrCursor)
	}
	m, _ = managerUpdate(t, m, "down")
	if m.mgrCursor != 4 {
		t.Fatalf("cursor did not clamp at end: %d", m.mgrCursor)
	}
	for range 8 {
		m, _ = managerUpdate(t, m, "up")
	}
	if m.mgrCursor != 0 {
		t.Fatalf("cursor did not clamp at start: %d", m.mgrCursor)
	}
	m.mgrCursor = 99
	m.clampManagerCursor()
	if m.mgrCursor != 4 {
		t.Fatalf("oversized cursor clamped to %d, want 4", m.mgrCursor)
	}
}

func TestManagerManualSpaceTogglesOnlyHighlightedAccountAndPersists(t *testing.T) {
	m := managerTestModel(t)
	m.mgrCursor = 3
	m, _ = managerUpdate(t, m, "space")
	key := accountKey{Provider: "openai-codex", IdentityKey: "codex-a"}
	disabled := m.accountSelections.ManualDisabled()
	if !disabled[key] || len(disabled) != 1 {
		t.Fatalf("space changed the wrong account set: %#v", disabled)
	}
	persisted := loadAccountSelectionState(m.accountState)
	if !reflect.DeepEqual(persisted.ManualDisabled(), disabled) ||
		persisted.ActiveName() != accountSelectionManualName {
		t.Fatalf("persisted state = %#v/%q, memory = %#v", persisted.ManualDisabled(), persisted.ActiveName(), disabled)
	}
	m, _ = managerUpdate(t, m, "space")
	if disabled = m.accountSelections.ManualDisabled(); disabled[key] || len(disabled) != 0 {
		t.Fatalf("second space did not re-enable only highlighted account: %#v", disabled)
	}
}

func TestManagerManualToggleWriteFailureRollsBackMemory(t *testing.T) {
	m := managerTestModel(t)
	first := accountKey{Provider: "anthropic", IdentityKey: "anthropic-a"}
	m.accountSelections.SetManualDisabled(map[accountKey]bool{first: true})
	before := m.accountSelections.ManualDisabled()
	m.accountState = t.TempDir() // replacing a directory atomically must fail
	m.mgrCursor = 1
	m, _ = managerUpdate(t, m, "space")
	if got := m.accountSelections.ManualDisabled(); !reflect.DeepEqual(got, before) {
		t.Fatalf("failed write was not rolled back: got %#v want %#v", got, before)
	}
	if m.accountErr == "" {
		t.Fatal("failed write did not surface an account error")
	}
}

func TestManagerAllowsAllAccountsOff(t *testing.T) {
	m := managerTestModel(t)
	for i := range m.managerAccounts() {
		m.mgrCursor = i
		m, _ = managerUpdate(t, m, "space")
	}
	if disabled := m.accountSelections.ManualDisabled(); len(disabled) != 5 {
		t.Fatalf("all-off state contains %d accounts, want 5", len(disabled))
	}
	plain := stripAnsi(m.managerView())
	if strings.Count(plain, "off") < 5 {
		t.Fatalf("all-off state is not rendered explicitly:\n%s", plain)
	}
}

func TestManagerRefreshIsCentralAndCloseKeysWork(t *testing.T) {
	m := managerTestModel(t)
	m, cmd := managerUpdate(t, m, "r")
	if cmd == nil || !m.fetching {
		t.Fatal("r did not start the one central snapshot refresh")
	}
	for _, key := range []string{"v", "esc"} {
		candidate := managerTestModel(t)
		closed, _ := managerUpdate(t, candidate, key)
		if closed.manager {
			t.Fatalf("%s did not close manager", key)
		}
	}
}

func TestManagerProviderLettersAreInert(t *testing.T) {
	for _, key := range []string{"c", "o"} {
		m := managerTestModel(t)
		beforeSelections := cloneAccountSelectionState(m.accountSelections)
		next, cmd := managerUpdate(t, m, key)
		if cmd != nil || next.fetching != m.fetching || next.manager != m.manager ||
			next.mgrCursor != m.mgrCursor || next.accountErr != m.accountErr ||
			!reflect.DeepEqual(next.accountSelections, beforeSelections) {
			t.Fatalf("%q changed manager state: cmd=%v fetching=%v manager=%v cursor=%d err=%q selections=%#v",
				key, cmd != nil, next.fetching, next.manager, next.mgrCursor,
				next.accountErr, next.accountSelections)
		}
	}
	controls := stripAnsi(managerTestModel(t).managerControls(120))
	for _, shortcut := range []string{"c ·", "o ·"} {
		if strings.Contains(controls, shortcut) {
			t.Fatalf("manager footer retained provider shortcut %q: %s", shortcut, controls)
		}
	}
}

func TestManagerRendersGroupedFullUsageAndReadableStates(t *testing.T) {
	m := managerTestModel(t)
	m.w, m.h = 120, 40
	m.avail.accounts["openai-codex"][1].Email = "b.codex.with-a-much-longer-identity@example.test"
	disabledKey := accountKey{Provider: "anthropic", IdentityKey: "anthropic-b"}
	m.accountSelections.SetManualDisabled(map[accountKey]bool{disabledKey: true})

	view := m.managerView()
	plain := stripAnsi(view)
	for _, want := range []string{
		"a.claude@example.test", "b.claude@example.test", "anthropic-c",
		"a.codex@example.test", "b.codex.with-a-much-longer-identity@example.test",
		"usage unavailable", "enabled", "off",
	} {
		if !strings.Contains(plain, want) {
			t.Errorf("loaded manager missing %q:\n%s", want, plain)
		}
	}

	rows := m.managerLines(m.w - gut)
	headerCount := 0
	for _, row := range rows {
		if !row.groupHeader {
			continue
		}
		headerCount++
		header := stripAnsi(row.text)
		if strings.Contains(header, "%") || strings.Contains(header, " used") ||
			strings.ContainsAny(header, "█░") {
			t.Errorf("account header retained inline usage: %q", header)
		}
	}
	if headerCount != 5 {
		t.Fatalf("rendered %d account headers, want all five:\n%s", headerCount, plain)
	}
	assertManagerAccountSpacing(t, rows)

	barCases := []struct {
		pct     int
		pctText string
		reset   int64
		note    string
	}{
		{pct: 37, pctText: " 37% used", reset: 2 * 60 * 60},
		{pct: 85, pctText: " 85% used", reset: day, note: "tight"},
		{pct: 100, pctText: "100% used", reset: 30 * 60, note: "maxed"},
		{pct: 0, pctText: "  0% used", reset: 7 * day, note: "idle"},
	}
	for _, tc := range barCases {
		var usageLine string
		for _, line := range strings.Split(plain, "\n") {
			if strings.Contains(line, tc.pctText) {
				usageLine = line
				break
			}
		}
		if usageLine == "" {
			t.Errorf("full usage row for %q is missing:\n%s", tc.pctText, plain)
			continue
		}
		barWidth := strings.Count(usageLine, "█") + strings.Count(usageLine, "░")
		if barWidth <= usageBarNaturalW {
			t.Errorf("%q row bar width = %d, want growth beyond the natural %d cells: %q",
				tc.pctText, barWidth, usageBarNaturalW, usageLine)
		}
		expectedReset := gReset + " " + pad(fmtReset(tc.reset), 4)
		if !strings.Contains(usageLine, expectedReset) {
			t.Errorf("%q row lost reset %q: %q", tc.pctText, expectedReset, usageLine)
		}
		if tc.note != "" && !strings.Contains(usageLine, tc.note) {
			t.Errorf("%q row lost note %q: %q", tc.pctText, tc.note, usageLine)
		}
	}
	for _, providerWording := range []string{"Claude 5 Hour", "Claude 7 Day", "Codex 5 Hour", "Codex 7 Day"} {
		if strings.Contains(plain, providerWording) {
			t.Errorf("manager retained provider-specific window %q instead of Usage compaction:\n%s", providerWording, plain)
		}
	}

	for i, row := range rows {
		if !row.groupHeader || !strings.Contains(stripAnsi(row.text), "b.claude@example.test") {
			continue
		}
		if i+1 >= len(rows) || !strings.HasPrefix(stripAnsi(rows[i+1].text), "      usage unavailable") {
			t.Fatalf("disabled account lacks a clearly indented unavailable child: %#v", rows[i:])
		}
	}
	if !strings.Contains(view, stHead.Render("enabled")) ||
		!strings.Contains(view, stDim.Render("off")) ||
		!strings.Contains(view, stStruck.Render("b.claude@example.test")) {
		t.Errorf("enabled/off header styles do not preserve readable disabled hierarchy")
	}
	if controls := m.managerControls(m.w - gut); !strings.Contains(controls, stHead.Render("toggle account")) {
		t.Errorf("manager footer descriptions did not use readable theme text: %q", stripAnsi(controls))
	}

	m.avail.accountsStale = true
	key := accountKey{Provider: "anthropic", IdentityKey: "anthropic-a"}
	wins := m.avail.accountUsage[key]
	wins[0].stale = true
	m.avail.accountUsage[key] = wins
	cached := stripAnsi(m.managerView())
	if !strings.Contains(cached, "cached") || !strings.ContainsAny(cached, "█░") {
		t.Fatalf("cached usage lost its note or bar:\n%s", cached)
	}

	m.avail.accountsOK = false
	unavailable := 0
	for _, row := range m.managerLines(m.w - gut) {
		if strings.Contains(stripAnsi(row.text), "account status unavailable") {
			unavailable++
		}
	}
	if unavailable != 2 {
		t.Fatalf("account groups expose %d unavailable providers, want 2", unavailable)
	}

	m.avail.accountsOK = true
	m.avail.accounts = map[string][]account{}
	m.mgrCursor = 42
	m.clampManagerCursor()
	if m.mgrCursor != 0 {
		t.Fatalf("empty manager cursor = %d, want 0", m.mgrCursor)
	}
	empty := 0
	for _, row := range m.managerLines(m.w - gut) {
		if strings.Contains(stripAnsi(row.text), "not authenticated") {
			empty++
		}
	}
	if empty != 2 {
		t.Fatalf("account groups expose %d unauthenticated providers, want 2", empty)
	}
}

func managerTestBorderTop(width int, color string) string {
	box := lipgloss.NewStyle().
		BorderStyle(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color(color)).
		Padding(0, 1).
		Width(max(0, width-managerProviderBoxBorderWidth)).
		Render("x")
	return strings.Split(box, "\n")[0]
}

func TestManagerProviderBoxesTrackFocusColorAndKeepOneGap(t *testing.T) {
	m := managerTestModel(t)
	const width = 98
	rows := m.managerLines(width)
	ranges := managerProviderRanges(rows)
	if len(ranges) != 2 {
		t.Fatalf("manager grouped %d provider ranges, want 2: %#v", len(ranges), ranges)
	}
	firstBoxHeight := ranges[0].end - ranges[0].start + 2
	secondTop := firstBoxHeight + 1

	assertBorders := func(focusedProvider string, firstColor, secondColor string) string {
		t.Helper()
		boxes := managerProviderBoxes(width, rows, focusedProvider)
		lines := strings.Split(boxes, "\n")
		if got, want := lipgloss.Height(boxes), managerProviderBoxesHeight(rows); got != want {
			t.Fatalf("provider composition height = %d, want measured %d", got, want)
		}
		if lines[firstBoxHeight] != "" {
			t.Fatalf("provider boxes have %q between them, want exactly one blank row", stripAnsi(lines[firstBoxHeight]))
		}
		if lines[0] != managerTestBorderTop(width, firstColor) {
			t.Fatalf("Anthropic top border has the wrong focus color: %q", lines[0])
		}
		if lines[secondTop] != managerTestBorderTop(width, secondColor) {
			t.Fatalf("OpenAI top border has the wrong focus color: %q", lines[secondTop])
		}
		return boxes
	}

	assertBorders("anthropic", managerProviderColor("anthropic"), cBord)
	m.mgrCursor = 3
	rows = m.managerLines(width)
	boxes := assertBorders("openai-codex", cBord, managerProviderColor("openai-codex"))
	if !strings.Contains(stripAnsi(boxes), "▸  ") && !strings.Contains(stripAnsi(boxes), "▸ ") {
		t.Fatalf("focus movement lost the selected OpenAI account:\n%s", stripAnsi(boxes))
	}

	disabled := accountKey{Provider: "openai-codex", IdentityKey: "codex-a"}
	m.accountSelections.SetManualDisabled(map[accountKey]bool{disabled: true})
	rows = m.managerLines(width)
	boxes = assertBorders("openai-codex", cBord, managerProviderColor("openai-codex"))
	if !strings.Contains(stripAnsi(boxes), "off") {
		t.Fatalf("disabled selected account lost its focused provider box:\n%s", stripAnsi(boxes))
	}
}

func TestManagerProviderBoxesStayStableWhenProvidersAreEmpty(t *testing.T) {
	m := managerTestModel(t)
	m.avail.accounts = map[string][]account{}
	m.mgrCursor = 12
	m.clampManagerCursor()
	const width = 56
	rows := m.managerLines(width)
	boxes := managerProviderBoxes(width, rows, m.managerFocusedProvider())
	ranges := managerProviderRanges(rows)
	if m.managerFocusedProvider() != "" || len(ranges) != 2 {
		t.Fatalf("empty providers claimed focus or disappeared: focus=%q ranges=%#v",
			m.managerFocusedProvider(), ranges)
	}
	lines := strings.Split(boxes, "\n")
	secondTop := ranges[0].end - ranges[0].start + 3
	for _, top := range []int{0, secondTop} {
		if lines[top] != managerTestBorderTop(width, cBord) {
			t.Fatalf("empty provider top border %d is not subdued: %q", top, lines[top])
		}
	}
	plain := stripAnsi(boxes)
	for _, want := range []string{"Anthropic", "OpenAI", "not authenticated"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("empty provider boxes lost %q:\n%s", want, plain)
		}
	}

	unavailable := managerTestModel(t)
	unavailable.avail.accountsOK = false
	rows = unavailable.managerLines(width)
	boxes = managerProviderBoxes(width, rows, unavailable.managerFocusedProvider())
	ranges = managerProviderRanges(rows)
	lines = strings.Split(boxes, "\n")
	secondTop = ranges[0].end - ranges[0].start + 3
	if unavailable.managerFocusedProvider() != "" ||
		lines[0] != managerTestBorderTop(width, cBord) ||
		lines[secondTop] != managerTestBorderTop(width, cBord) ||
		!strings.Contains(stripAnsi(boxes), "account status unavailable") {
		t.Fatalf("unavailable providers claimed focus or lost stable boxes:\n%s", stripAnsi(boxes))
	}
}

func TestManagerProviderBoxesContainChildrenAtResponsiveWidths(t *testing.T) {
	for _, terminalWidth := range []int{100, 58, 36} {
		m := managerTestModel(t)
		m.w = terminalWidth
		width := terminalWidth - gut
		rows := m.managerLines(width)
		boxes := managerProviderBoxes(width, rows, m.managerFocusedProvider())
		if got, want := lipgloss.Height(boxes), managerProviderBoxesHeight(rows); got != want {
			t.Errorf("width %d provider box height = %d, want %d", terminalWidth, got, want)
		}
		for _, line := range strings.Split(boxes, "\n") {
			if got := lipgloss.Width(line); got > width {
				t.Errorf("width %d provider line is %d cells: %q", terminalWidth, got, stripAnsi(line))
			}
			plain := strings.TrimRight(stripAnsi(line), " ")
			if strings.ContainsAny(plain, "█░") &&
				(!strings.HasPrefix(plain, "│") || !strings.HasSuffix(plain, "│")) {
				t.Errorf("width %d child bar escaped its provider border: %q", terminalWidth, plain)
			}
		}
		title := stripAnsi(m.managerTitle(width))
		if strings.Contains(title, "\n") || !strings.Contains(title, "preset") {
			t.Errorf("width %d wrapped or discarded the normal selector: %q", terminalWidth, title)
		}
		if !strings.Contains(strings.Split(title, "\n")[0], "accounts") {
			t.Errorf("width %d clipped the accounts pill before provider content: %q", terminalWidth, title)
		}
	}
}

func TestWindowedManagerProviderBoxKeepsWholeFocusedFrame(t *testing.T) {
	m := managerTestModel(t)
	m.mgrCursor = 4
	const width = 56
	const height = 6
	rows := windowManagerLines(m.managerLines(width), m.mgrCursor, height)
	box := managerProviderBoxes(width, rows, m.managerFocusedProvider())
	plain := stripAnsi(box)
	lines := strings.Split(plain, "\n")
	if lipgloss.Height(box) > height {
		t.Fatalf("windowed provider box height = %d, available %d:\n%s", lipgloss.Height(box), height, plain)
	}
	if !strings.HasPrefix(lines[0], "╭") || !strings.HasSuffix(strings.TrimRight(lines[len(lines)-1], " "), "╯") {
		t.Fatalf("windowed provider box orphaned a border fragment:\n%s", plain)
	}
	for _, want := range []string{"OpenAI", "b.codex", "usage unavailable"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("windowed focused provider lost %q:\n%s", want, plain)
		}
	}
	if strings.Contains(plain, "Anthropic") {
		t.Fatalf("windowed focused box spent space on the unselected provider:\n%s", plain)
	}
}

func TestManagerSelectorCyclesManualAndNamedPresetsInInsertionOrder(t *testing.T) {
	m := managerTestModel(t)
	first := map[accountKey]bool{{Provider: "anthropic", IdentityKey: "anthropic-a"}: true}
	second := map[accountKey]bool{{Provider: "openai-codex", IdentityKey: "codex-b"}: true}
	if err := m.accountSelections.UpsertPreset("Work", first); err != nil {
		t.Fatal(err)
	}
	if err := m.accountSelections.UpsertPreset("Travel", second); err != nil {
		t.Fatal(err)
	}

	if selector := stripAnsi(m.managerPresetSelector(120)); !strings.Contains(selector, "preset  ‹ Manual ›") {
		t.Fatalf("manual selector is not explicit: %q", selector)
	}
	for _, step := range []struct {
		key, want string
	}{
		{"right", "Work"},
		{"right", "Travel"},
		{"right", accountSelectionManualName},
		{"left", "Travel"},
	} {
		var cmd tea.Cmd
		m, cmd = managerUpdate(t, m, step.key)
		if cmd != nil || m.accountSelections.ActiveName() != step.want {
			t.Fatalf("%s selected %q with cmd=%v, want %q", step.key, m.accountSelections.ActiveName(), cmd != nil, step.want)
		}
		if got := loadAccountSelectionState(m.accountState).ActiveName(); got != step.want {
			t.Fatalf("%s persisted active %q, want %q", step.key, got, step.want)
		}
	}
}

func TestManagerNarrowRowsKeepUsagePrioritiesAndSelection(t *testing.T) {
	base := managerTestModel(t)
	base.avail.accounts["openai-codex"][1].Email = "b.codex.with-an-extremely-long-identity-that-must-be-clipped@example.test"
	base.accountSelections.SetManualDisabled(map[accountKey]bool{
		{Provider: "openai-codex", IdentityKey: "codex-b"}: true,
	})
	for _, size := range []struct{ width, height int }{{100, 32}, {58, 18}, {36, 14}} {
		m := base
		m.w, m.h = size.width, size.height
		m.mgrCursor = 4
		view := m.managerView()
		plain := stripAnsi(view)
		if height := lipgloss.Height(view); height > size.height {
			t.Errorf("%dx%d view height = %d", size.width, size.height, height)
		}
		for _, line := range strings.Split(view, "\n") {
			if width := lipgloss.Width(line); width > size.width {
				t.Errorf("%dx%d line width = %d: %q", size.width, size.height, width, stripAnsi(line))
			}
		}
		if !strings.Contains(plain, "▸ ") || !strings.Contains(plain, "b.cod") || !strings.Contains(plain, "off") {
			t.Errorf("%dx%d window lost the highlighted disabled final account:\n%s", size.width, size.height, plain)
		}
		if !strings.Contains(plain, "usage unavailable") {
			t.Errorf("%dx%d window lost the selected account's unavailable child:\n%s", size.width, size.height, plain)
		}

		rows := m.managerLines(size.width - gut)
		assertManagerAccountSpacing(t, windowManagerLines(rows, m.mgrCursor, 6))
		innerWidth := managerProviderContentWidth(size.width - gut)
		var priorityRow string
		for _, row := range rows {
			if width := lipgloss.Width(row.text); width > innerWidth {
				t.Errorf("%dx%d manager row width = %d, inner box width %d: %q",
					size.width, size.height, width, innerWidth, stripAnsi(row.text))
			}
			line := stripAnsi(row.text)
			if row.groupHeader && strings.Contains(line, "%") {
				t.Errorf("%dx%d account header retained inline percentage: %q", size.width, size.height, line)
			}
			if strings.Contains(line, " 37%") {
				priorityRow = line
			}
		}
		if priorityRow == "" ||
			!strings.Contains(priorityRow, "5h") ||
			!strings.Contains(priorityRow, " 37%") ||
			!strings.Contains(priorityRow, gReset) {
			t.Errorf("%dx%d narrow usage row lost label, percentage, or reset: %q", size.width, size.height, priorityRow)
		}
	}
}

func TestWindowManagerLinesKeepsSelectedAccountGroupsIntelligible(t *testing.T) {
	m := managerTestModel(t)
	lines := m.managerLines(100 - gut)
	const windowHeight = 6
	for _, cursor := range []int{0, 1, 3, 4} {
		window := windowManagerLines(lines, cursor, windowHeight)
		assertManagerAccountSpacing(t, window)
		seenGroups := map[int]bool{}
		selectedSeen := false
		selectedGroup := -1
		for _, row := range window {
			if row.groupHeader {
				seenGroups[row.group] = true
			}
			if row.group >= 0 && !row.groupHeader && !seenGroups[row.group] {
				t.Errorf("cursor %d window starts with orphaned usage group %d: %#v", cursor, row.group, window)
			}
			if row.selectable == cursor {
				selectedSeen = true
				selectedGroup = row.group
			}
		}
		if !selectedSeen {
			t.Errorf("cursor %d window lost selected account header: %#v", cursor, window)
			continue
		}
		wantChildren := 0
		gotChildren := 0
		for _, row := range lines {
			if row.group == selectedGroup && !row.groupHeader {
				wantChildren++
			}
		}
		for _, row := range window {
			if row.group == selectedGroup && !row.groupHeader {
				gotChildren++
			}
		}
		if wantChildren+1 <= windowHeight-3 && gotChildren != wantChildren {
			t.Errorf("cursor %d window shows %d/%d selected usage children: %#v", cursor, gotChildren, wantChildren, window)
		}
	}
}

func TestManagerNewIdentityDefaultsEnabled(t *testing.T) {
	m := managerTestModel(t)
	newAccount := account{Provider: "openai-codex", IdentityKey: "codex-new", Email: "new@example.test"}
	m.avail.accounts["openai-codex"] = append(m.avail.accounts["openai-codex"], newAccount)
	if m.accountSelections.CurrentDisabled()[accountKey{Provider: newAccount.Provider, IdentityKey: newAccount.IdentityKey}] {
		t.Fatal("new broker identity did not default enabled")
	}
	if plain := stripAnsi(m.managerView()); !strings.Contains(plain, "new@example.test") || !strings.Contains(plain, "enabled") {
		t.Fatalf("new enabled identity is not rendered:\n%s", plain)
	}
}

func TestManagerNamedPresetIsReadOnlyUntilExplicitEditAndSave(t *testing.T) {
	m := managerTestModel(t)
	key := accountKey{Provider: "anthropic", IdentityKey: "anthropic-a"}
	if err := m.accountSelections.UpsertPreset("Work", nil); err != nil {
		t.Fatal(err)
	}
	m.accountSelections.Activate("Work")
	if err := writeAccountSelectionState(m.accountState, m.accountSelections); err != nil {
		t.Fatal(err)
	}

	m, _ = managerUpdate(t, m, "space")
	if m.accountErr != "press e to edit" {
		t.Fatalf("read-only Space guidance = %q", m.accountErr)
	}
	if m.accountSelections.CurrentDisabled()[key] {
		t.Fatal("read-only Space mutated the named preset")
	}
	if got := loadAccountSelectionState(m.accountState).CurrentDisabled(); got[key] {
		t.Fatal("read-only Space persisted a mutation")
	}

	m, _ = managerUpdate(t, m, "e")
	if !m.managerPreset.editing {
		t.Fatal("e did not enter named-preset edit mode")
	}
	m, _ = managerUpdate(t, m, "space")
	if m.accountSelections.CurrentDisabled()[key] {
		t.Fatal("draft toggle changed the active persisted selection before save")
	}
	if !m.managerDisplayedDisabled()[key] {
		t.Fatal("draft toggle is not the effective displayed selection")
	}
	if plain := stripAnsi(m.managerView()); !strings.Contains(plain, "editing draft") ||
		!strings.Contains(plain, "a.claude@example.test") ||
		!strings.Contains(plain, "off") {
		t.Fatalf("edit render does not expose draft state:\n%s", plain)
	}
	if got := loadAccountSelectionState(m.accountState).CurrentDisabled(); got[key] {
		t.Fatal("draft toggle reached persistence before save")
	}

	m, _ = managerUpdate(t, m, "s")
	if m.managerPreset.editing || !m.accountSelections.CurrentDisabled()[key] {
		t.Fatalf("save did not commit and leave edit mode: editing=%v disabled=%#v",
			m.managerPreset.editing, m.accountSelections.CurrentDisabled())
	}
	persisted := loadAccountSelectionState(m.accountState)
	if persisted.ActiveName() != "Work" || !persisted.CurrentDisabled()[key] {
		t.Fatalf("saved preset was not persisted atomically: %q %#v", persisted.ActiveName(), persisted.CurrentDisabled())
	}
}

func TestManagerNamedPresetEscapeCancelsDraftWithoutPersistence(t *testing.T) {
	m := managerTestModel(t)
	key := accountKey{Provider: "anthropic", IdentityKey: "anthropic-a"}
	if err := m.accountSelections.UpsertPreset("Work", nil); err != nil {
		t.Fatal(err)
	}
	m.accountSelections.Activate("Work")
	if err := writeAccountSelectionState(m.accountState, m.accountSelections); err != nil {
		t.Fatal(err)
	}

	m, _ = managerUpdate(t, m, "e")
	m, _ = managerUpdate(t, m, "space")
	m, _ = managerUpdate(t, m, "esc")
	if m.managerPreset.editing || m.accountSelections.CurrentDisabled()[key] {
		t.Fatalf("Esc retained or committed draft: editing=%v disabled=%#v",
			m.managerPreset.editing, m.accountSelections.CurrentDisabled())
	}
	if got := loadAccountSelectionState(m.accountState); got.CurrentDisabled()[key] {
		t.Fatal("Esc cancellation changed persistence")
	}
	if !m.manager {
		t.Fatal("Esc from edit mode leaked through and closed the manager")
	}
}

func TestManagerNamedPresetSaveFailureKeepsDraftAndRollsBackActiveState(t *testing.T) {
	m := managerTestModel(t)
	key := accountKey{Provider: "anthropic", IdentityKey: "anthropic-a"}
	if err := m.accountSelections.UpsertPreset("Work", nil); err != nil {
		t.Fatal(err)
	}
	m.accountSelections.Activate("Work")
	m.accountState = t.TempDir()

	m, _ = managerUpdate(t, m, "e")
	m, _ = managerUpdate(t, m, "space")
	m, _ = managerUpdate(t, m, "s")
	if !m.managerPreset.editing || !m.managerPreset.draft[key] {
		t.Fatal("failed save discarded the retryable in-memory draft")
	}
	if m.accountSelections.CurrentDisabled()[key] {
		t.Fatal("failed save mutated the active selection")
	}
	if m.accountErr == "" {
		t.Fatal("failed named-preset save did not surface an error")
	}
}

func TestManagerInlineNamingSupportsUnicodeBackspaceAndSaveActivate(t *testing.T) {
	m := managerTestModel(t)
	key := accountKey{Provider: "openai-codex", IdentityKey: "codex-a"}
	m.accountSelections.SetManualDisabled(map[accountKey]bool{key: true})
	m, _ = managerUpdate(t, m, "n")
	if !m.managerPreset.naming {
		t.Fatal("n did not open inline naming")
	}
	if prompt := stripAnsi(m.managerPresetSelector(120)); !strings.Contains(prompt, "new preset") ||
		!strings.Contains(prompt, "type a name") {
		t.Fatalf("inline empty-name prompt is not discoverable: %q", prompt)
	}
	m, _ = managerUpdate(t, m, "Café🚀")
	m, _ = managerUpdate(t, m, "backspace")
	m, _ = managerUpdate(t, m, "space")
	m, _ = managerUpdate(t, m, "隊")
	if prompt := stripAnsi(m.managerPresetSelector(120)); !strings.Contains(prompt, "Café 隊") ||
		strings.Contains(prompt, "🚀") {
		t.Fatalf("Unicode/backspace input rendered incorrectly: %q", prompt)
	}
	m, _ = managerUpdate(t, m, "enter")
	if m.managerPreset.naming || m.accountSelections.ActiveName() != "Café 隊" {
		t.Fatalf("name save did not activate preset: naming=%v active=%q",
			m.managerPreset.naming, m.accountSelections.ActiveName())
	}
	preset, ok := m.accountSelections.Preset("Café 隊")
	if !ok || !reflect.DeepEqual(preset.Disabled, map[accountKey]bool{key: true}) {
		t.Fatalf("new preset did not snapshot displayed selection: %#v %v", preset, ok)
	}
	persisted := loadAccountSelectionState(m.accountState)
	if persisted.ActiveName() != "Café 隊" || !persisted.CurrentDisabled()[key] {
		t.Fatalf("new preset was not saved and activated: %q %#v", persisted.ActiveName(), persisted.CurrentDisabled())
	}
}

func TestManagerInlineNamingRejectsReservedDuplicateAndEmptyNames(t *testing.T) {
	for _, tc := range []struct {
		name     string
		existing bool
	}{
		{name: ""},
		{name: "  Manual  "},
		{name: "work", existing: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := managerTestModel(t)
			if tc.existing {
				if err := m.accountSelections.UpsertPreset("Work", nil); err != nil {
					t.Fatal(err)
				}
			}
			before := m.accountSelections.Presets()
			m, _ = managerUpdate(t, m, "n")
			if tc.name != "" {
				m, _ = managerUpdate(t, m, tc.name)
			}
			m, _ = managerUpdate(t, m, "enter")
			if !m.managerPreset.naming || m.accountErr == "" {
				t.Fatalf("invalid name %q closed prompt or lacked error", tc.name)
			}
			if !reflect.DeepEqual(m.accountSelections.Presets(), before) ||
				m.accountSelections.ActiveName() != accountSelectionManualName {
				t.Fatalf("invalid name %q mutated state", tc.name)
			}
		})
	}
}

func TestManagerInlineNamingPersistenceFailureRollsBackAndCanCancel(t *testing.T) {
	m := managerTestModel(t)
	m.accountState = t.TempDir()
	m, _ = managerUpdate(t, m, "n")
	m, _ = managerUpdate(t, m, "Offline")
	m, _ = managerUpdate(t, m, "enter")
	if !m.managerPreset.naming || m.accountErr == "" {
		t.Fatal("failed new-preset write did not keep prompt and surface error")
	}
	if _, ok := m.accountSelections.Preset("Offline"); ok ||
		m.accountSelections.ActiveName() != accountSelectionManualName {
		t.Fatal("failed new-preset write mutated live state")
	}
	m, _ = managerUpdate(t, m, "esc")
	if m.managerPreset.naming || !m.manager || m.accountErr != "" {
		t.Fatalf("Esc did not cleanly cancel failed naming: naming=%v manager=%v err=%q",
			m.managerPreset.naming, m.manager, m.accountErr)
	}
}

func TestManagerDeleteCopiesVisibleSelectionToManualWithoutJump(t *testing.T) {
	m := managerTestModel(t)
	oldManual := accountKey{Provider: "anthropic", IdentityKey: "anthropic-a"}
	visible := accountKey{Provider: "openai-codex", IdentityKey: "codex-b"}
	m.accountSelections.SetManualDisabled(map[accountKey]bool{oldManual: true})
	if err := m.accountSelections.UpsertPreset("Travel", map[accountKey]bool{visible: true}); err != nil {
		t.Fatal(err)
	}
	m.accountSelections.Activate("Travel")
	before := stripAnsi(m.managerView())
	m, _ = managerUpdate(t, m, "d")
	if m.managerPreset.deleting != "Travel" {
		t.Fatalf("d did not enter named confirmation: %#v", m.managerPreset)
	}
	if m.accountSelections.ActiveName() != "Travel" {
		t.Fatalf("d changed active preset before confirmation: %q", m.accountSelections.ActiveName())
	}
	if _, ok := m.accountSelections.Preset("Travel"); !ok {
		t.Fatal("d deleted named preset before confirmation")
	}
	prompt := stripAnsi(m.managerPresetSelector(120))
	for _, want := range []string{"delete preset", "Travel", "are you sure?"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("delete confirmation prompt missing %q: %q", want, prompt)
		}
	}
	m, _ = managerUpdate(t, m, "y")

	if m.accountSelections.ActiveName() != accountSelectionManualName {
		t.Fatalf("delete activated %q, want Manual", m.accountSelections.ActiveName())
	}
	if _, ok := m.accountSelections.Preset("Travel"); ok {
		t.Fatal("delete retained named preset")
	}
	if got := m.accountSelections.ManualDisabled(); !reflect.DeepEqual(got, map[accountKey]bool{visible: true}) {
		t.Fatalf("delete copied %#v to Manual, want visible selection", got)
	}
	after := stripAnsi(m.managerView())
	for _, identity := range []string{"a.claude@example.test", "b.codex@example.test"} {
		beforeLine, afterLine := "", ""
		for _, line := range strings.Split(before, "\n") {
			if strings.Contains(line, identity) {
				beforeLine = line
			}
		}
		for _, line := range strings.Split(after, "\n") {
			if strings.Contains(line, identity) {
				afterLine = line
			}
		}
		if strings.Contains(beforeLine, "off") != strings.Contains(afterLine, "off") {
			t.Fatalf("visible selection jumped for %s:\nbefore %q\nafter  %q", identity, beforeLine, afterLine)
		}
	}
	persisted := loadAccountSelectionState(m.accountState)
	if persisted.ActiveName() != accountSelectionManualName ||
		!reflect.DeepEqual(persisted.ManualDisabled(), map[accountKey]bool{visible: true}) {
		t.Fatalf("delete semantics were not persisted: %q %#v", persisted.ActiveName(), persisted.ManualDisabled())
	}
}

func TestManagerDeleteAndCycleFailuresRollBackState(t *testing.T) {
	for _, action := range []string{"delete", "cycle"} {
		t.Run(action, func(t *testing.T) {
			m := managerTestModel(t)
			key := accountKey{Provider: "openai-codex", IdentityKey: "codex-b"}
			m.accountSelections.SetManualDisabled(map[accountKey]bool{
				{Provider: "anthropic", IdentityKey: "anthropic-a"}: true,
			})
			if err := m.accountSelections.UpsertPreset("Work", map[accountKey]bool{key: true}); err != nil {
				t.Fatal(err)
			}
			if action == "delete" {
				m.accountSelections.Activate("Work")
			}
			beforeActive := m.accountSelections.ActiveName()
			beforeManual := m.accountSelections.ManualDisabled()
			beforePresets := m.accountSelections.Presets()
			m.accountState = t.TempDir()
			if action == "delete" {
				m, _ = managerUpdate(t, m, "d")
				if m.managerPreset.deleting != "Work" || m.accountErr != "" {
					t.Fatalf("d did not enter a clean confirmation before failed delete: %#v err=%q",
						m.managerPreset, m.accountErr)
				}
				m, _ = managerUpdate(t, m, "y")
			} else {
				m, _ = managerUpdate(t, m, "right")
			}
			if m.accountErr == "" ||
				m.accountSelections.ActiveName() != beforeActive ||
				!reflect.DeepEqual(m.accountSelections.ManualDisabled(), beforeManual) ||
				!reflect.DeepEqual(m.accountSelections.Presets(), beforePresets) {
				t.Fatalf("%s failure did not roll back: active=%q manual=%#v presets=%#v err=%q",
					action, m.accountSelections.ActiveName(), m.accountSelections.ManualDisabled(),
					m.accountSelections.Presets(), m.accountErr)
			}
			if action == "delete" && m.managerPreset.deleting != "Work" {
				t.Fatalf("failed delete did not retain confirmation for retry: %#v", m.managerPreset)
			}
		})
	}

	m := managerTestModel(t)
	before := cloneAccountSelectionState(m.accountSelections)
	m, _ = managerUpdate(t, m, "d")
	if m.accountErr != "Manual cannot be deleted" ||
		!reflect.DeepEqual(m.accountSelections.ManualDisabled(), before.ManualDisabled()) {
		t.Fatalf("Manual delete was not rejected safely: err=%q", m.accountErr)
	}
}

func TestManagerDeleteConfirmationCancelsWithoutPersistence(t *testing.T) {
	m := managerTestModel(t)
	if err := m.accountSelections.UpsertPreset("Work", nil); err != nil {
		t.Fatal(err)
	}
	m.accountSelections.Activate("Work")
	if err := writeAccountSelectionState(m.accountState, m.accountSelections); err != nil {
		t.Fatal(err)
	}
	if err := m.deleteActiveManagerPreset(); err == nil ||
		!strings.Contains(err.Error(), "confirmation required") {
		t.Fatalf("delete helper bypassed explicit confirmation: %v", err)
	}
	if _, ok := m.accountSelections.Preset("Work"); !ok {
		t.Fatal("unconfirmed direct delete removed the named preset")
	}

	m.w, m.h = 120, 24
	m.showUsage = true
	if before := m.managerView(); !managerRenderedBlock(before, m.usagePanelFor(m.w)) ||
		strings.Contains(stripAnsi(before), "Anthropic") {
		t.Fatalf("delete-modal fixture is not in alternate Usage mode:\n%s", stripAnsi(before))
	}

	var cmd tea.Cmd
	m, cmd = managerUpdate(t, m, "d")
	if cmd != nil || m.managerPreset.deleting != "Work" || m.accountErr != "" {
		t.Fatalf("d did not enter confirmation without side effects: cmd=%v state=%#v err=%q",
			cmd != nil, m.managerPreset, m.accountErr)
	}
	confirmation := stripAnsi(m.managerView())
	for _, want := range []string{"accounts", "delete preset", "Work", "are you sure?"} {
		if !strings.Contains(confirmation, want) {
			t.Fatalf("alternate Usage did not yield to named delete prompt %q:\n%s", want, confirmation)
		}
	}
	if managerRenderedBlock(m.managerView(), m.usagePanelFor(m.w)) {
		t.Fatalf("delete confirmation mixed alternate Usage into its modal body:\n%s", confirmation)
	}
	if persisted := loadAccountSelectionState(m.accountState); persisted.ActiveName() != "Work" {
		t.Fatalf("d persisted before confirmation: active=%q", persisted.ActiveName())
	} else if _, ok := persisted.Preset("Work"); !ok {
		t.Fatal("d removed the persisted preset before confirmation")
	}
	controls := stripAnsi(m.managerControls(120))
	for _, want := range []string{"confirm delete", "cancel"} {
		if !strings.Contains(controls, want) {
			t.Fatalf("delete controls missing %q: %s", want, controls)
		}
	}
	for _, forbidden := range []string{"refresh", "close", "new preset", "edit preset", "usage"} {
		if strings.Contains(controls, forbidden) {
			t.Fatalf("delete controls leaked %q: %s", forbidden, controls)
		}
	}

	m, _ = managerUpdate(t, m, "esc")
	if m.managerPreset.deleting != "" || m.accountErr != "" ||
		m.accountSelections.ActiveName() != "Work" {
		t.Fatalf("Esc did not cancel confirmation cleanly: state=%#v active=%q err=%q",
			m.managerPreset, m.accountSelections.ActiveName(), m.accountErr)
	}
	if _, ok := m.accountSelections.Preset("Work"); !ok {
		t.Fatal("Esc cancellation deleted the named preset")
	}
	if !m.showUsage || !managerRenderedBlock(m.managerView(), m.usagePanelFor(m.w)) {
		t.Fatalf("Esc did not restore preserved alternate Usage state:\n%s", stripAnsi(m.managerView()))
	}
}

func TestManagerDeleteConfirmationBlocksKeysAndRetriesPersistence(t *testing.T) {
	m := managerTestModel(t)
	if err := m.accountSelections.UpsertPreset("Work", nil); err != nil {
		t.Fatal(err)
	}
	m.accountSelections.Activate("Work")
	m, _ = managerUpdate(t, m, "d")
	cursor := m.mgrCursor
	hideUsage, showUsage := m.hideUsage, m.showUsage
	for _, key := range []string{
		"r", "v", "left", "right", "up", "down", "space",
		"e", "n", "d", "s", "enter", "ctrl+c", "Y", "x",
	} {
		var cmd tea.Cmd
		m, cmd = managerUpdate(t, m, key)
		_, exists := m.accountSelections.Preset("Work")
		if cmd != nil || m.fetching || !m.manager || m.mgrCursor != cursor ||
			m.hideUsage != hideUsage || m.showUsage != showUsage ||
			m.managerPreset.deleting != "Work" ||
			m.accountSelections.ActiveName() != "Work" || !exists {
			t.Fatalf("delete confirmation leaked %q: cmd=%v fetching=%v manager=%v cursor=%d hidden=%v alternate=%v state=%#v active=%q preset=%v",
				key, cmd != nil, m.fetching, m.manager, m.mgrCursor, m.hideUsage,
				m.showUsage, m.managerPreset, m.accountSelections.ActiveName(), exists)
		}
	}

	m.accountState = t.TempDir()
	m, _ = managerUpdate(t, m, "y")
	if m.managerPreset.deleting != "Work" || m.accountErr == "" ||
		m.accountSelections.ActiveName() != "Work" {
		t.Fatalf("failed y did not retain retryable confirmation: state=%#v active=%q err=%q",
			m.managerPreset, m.accountSelections.ActiveName(), m.accountErr)
	}
	if _, ok := m.accountSelections.Preset("Work"); !ok {
		t.Fatal("failed y mutated the live preset")
	}
	cancelled, _ := managerUpdate(t, m, "esc")
	if cancelled.managerPreset.deleting != "" || cancelled.accountErr != "" ||
		cancelled.accountSelections.ActiveName() != "Work" {
		t.Fatalf("Esc could not cancel after failed persistence: state=%#v active=%q err=%q",
			cancelled.managerPreset, cancelled.accountSelections.ActiveName(), cancelled.accountErr)
	}
	if _, ok := cancelled.accountSelections.Preset("Work"); !ok {
		t.Fatal("Esc after failed persistence deleted the named preset")
	}
	failure := m.accountErr
	m, cmd := managerUpdate(t, m, "r")
	if cmd != nil || m.fetching || m.managerPreset.deleting != "Work" || m.accountErr != failure {
		t.Fatalf("failed confirmation leaked r or cleared its error: cmd=%v fetching=%v state=%#v err=%q",
			cmd != nil, m.fetching, m.managerPreset, m.accountErr)
	}

	m.accountState = filepath.Join(t.TempDir(), "account-state.json")
	m, _ = managerUpdate(t, m, "y")
	if m.managerPreset.deleting != "" || m.accountErr != "" ||
		m.accountSelections.ActiveName() != accountSelectionManualName {
		t.Fatalf("retry did not complete delete: state=%#v active=%q err=%q",
			m.managerPreset, m.accountSelections.ActiveName(), m.accountErr)
	}
	if _, ok := m.accountSelections.Preset("Work"); ok {
		t.Fatal("successful retry retained named preset")
	}
}

func TestManagerNamingAndEditingBlockGlobalManagerActions(t *testing.T) {
	m := managerTestModel(t)
	m, _ = managerUpdate(t, m, "n")
	cursor := m.mgrCursor
	for _, key := range []string{"r", "v", "left", "right", "up", "down"} {
		var cmd tea.Cmd
		m, cmd = managerUpdate(t, m, key)
		if cmd != nil || m.fetching || !m.manager || m.mgrCursor != cursor {
			t.Fatalf("naming leaked %q: cmd=%v fetching=%v manager=%v cursor=%d",
				key, cmd != nil, m.fetching, m.manager, m.mgrCursor)
		}
	}
	m, _ = managerUpdate(t, m, "esc")
	if err := m.accountSelections.UpsertPreset("Work", nil); err != nil {
		t.Fatal(err)
	}
	m.accountSelections.Activate("Work")
	m, _ = managerUpdate(t, m, "e")
	for _, key := range []string{"r", "v", "n", "d", "left", "right"} {
		var cmd tea.Cmd
		m, cmd = managerUpdate(t, m, key)
		if cmd != nil || m.fetching || !m.manager ||
			m.accountSelections.ActiveName() != "Work" || m.mgrCursor != cursor {
			t.Fatalf("editing leaked %q: cmd=%v fetching=%v manager=%v active=%q cursor=%d",
				key, cmd != nil, m.fetching, m.manager,
				m.accountSelections.ActiveName(), m.mgrCursor)
		}
	}
	m, _ = managerUpdate(t, m, "down")
	if m.mgrCursor != cursor+1 {
		t.Fatalf("editing blocked account navigation: cursor=%d", m.mgrCursor)
	}
	m, _ = managerUpdate(t, m, "up")
}

func TestManagerPresetControlsAreStateSpecificAndResponsive(t *testing.T) {
	m := managerTestModel(t)
	wideManual := stripAnsi(m.managerControls(120))
	for _, want := range []string{"preset", "toggle account", "new preset", "show usage"} {
		if !strings.Contains(wideManual, want) {
			t.Fatalf("Manual controls missing %q: %s", want, wideManual)
		}
	}
	if err := m.accountSelections.UpsertPreset("Work", nil); err != nil {
		t.Fatal(err)
	}
	m.accountSelections.Activate("Work")
	wideNamed := stripAnsi(m.managerControls(120))
	for _, want := range []string{"edit preset", "new preset", "delete preset"} {
		if !strings.Contains(wideNamed, want) {
			t.Fatalf("named controls missing %q: %s", want, wideNamed)
		}
	}
	m.managerPreset = managerPresetState{deleting: "Work"}
	for _, width := range []int{24, 120} {
		deleteControls := m.managerControls(width)
		plain := stripAnsi(deleteControls)
		for _, want := range []string{"delete", "cancel"} {
			if !strings.Contains(plain, want) {
				t.Fatalf("width %d delete controls missing %q: %s", width, want, plain)
			}
		}
		for _, forbidden := range []string{"refresh", "close", "preset", "move", "usage"} {
			if strings.Contains(plain, forbidden) {
				t.Fatalf("width %d delete controls leaked %q: %s", width, forbidden, plain)
			}
		}
		for _, line := range strings.Split(deleteControls, "\n") {
			if got := lipgloss.Width(line); got > width {
				t.Fatalf("width %d delete control line is %d cells: %q",
					width, got, stripAnsi(line))
			}
		}
	}
	m.managerPreset = managerPresetState{}
	m.beginManagerPresetEdit()
	editControls := stripAnsi(m.managerControls(120))
	for _, want := range []string{"move", "change draft", "save preset", "cancel"} {
		if !strings.Contains(editControls, want) {
			t.Fatalf("edit controls missing %q: %s", want, editControls)
		}
	}
	for _, forbidden := range []string{"refresh", "close", "new preset", "delete", "show usage", "hide usage"} {
		if strings.Contains(editControls, forbidden) {
			t.Fatalf("edit controls leaked %q: %s", forbidden, editControls)
		}
	}
	m.managerPreset = managerPresetState{naming: true}
	nameControls := stripAnsi(m.managerControls(120))
	if !strings.Contains(nameControls, "save preset") || !strings.Contains(nameControls, "cancel") {
		t.Fatalf("naming controls are incomplete: %s", nameControls)
	}

	for _, width := range []int{24, 36, 47} {
		m.managerPreset = managerPresetState{}
		controls := m.managerControls(width)
		plain := stripAnsi(controls)
		for _, want := range []string{"preset", "edit", "new", "delete"} {
			if !strings.Contains(plain, want) {
				t.Errorf("width %d controls missing compact %q: %s", width, want, plain)
			}
		}
		for _, line := range strings.Split(controls, "\n") {
			if got := lipgloss.Width(line); got > width {
				t.Errorf("width %d control line is %d cells: %q", width, got, stripAnsi(line))
			}
		}
	}
}

func TestManagerTitleCoLocatesEveryPresetStateAndRemovesSubtitle(t *testing.T) {
	m := managerTestModel(t)
	assertTitle := func(w int, wants ...string) string {
		t.Helper()
		title := stripAnsi(m.managerTitle(w))
		lines := strings.Split(title, "\n")
		if !strings.Contains(lines[0], "accounts  ") {
			t.Fatalf("width %d title did not keep the selector beside the accounts pill: %q", w, title)
		}
		for _, want := range wants {
			if !strings.Contains(title, want) {
				t.Fatalf("width %d title missing %q: %q", w, want, title)
			}
		}
		if strings.Contains(title, "central broker account access") {
			t.Fatalf("width %d title retained the obsolete subtitle: %q", w, title)
		}
		for _, line := range lines {
			if got := lipgloss.Width(line); got > w {
				t.Fatalf("width %d title line is %d cells: %q", w, got, line)
			}
		}
		return title
	}

	manual := assertTitle(98, "preset  ‹ Manual ›", "editable")
	if strings.Contains(manual, "\n") {
		t.Fatalf("Manual selector wrapped out of the title row: %q", manual)
	}
	if err := m.accountSelections.UpsertPreset("Work", nil); err != nil {
		t.Fatal(err)
	}
	m.accountSelections.Activate("Work")
	named := assertTitle(98, "preset  ‹ Work ›", "read-only")
	if strings.Contains(named, "\n") {
		t.Fatalf("named selector wrapped out of the title row: %q", named)
	}
	m.managerPreset = managerPresetState{naming: true}
	naming := assertTitle(98, "new preset", "type a name")
	if strings.Contains(naming, "\n") {
		t.Fatalf("naming selector wrapped out of the title row: %q", naming)
	}
	m.managerPreset = managerPresetState{deleting: "Work"}
	deleting := assertTitle(98, "delete preset", "Work", "are you sure?")
	lines := strings.Split(deleting, "\n")
	if len(lines) != 2 {
		t.Fatalf("delete confirmation occupies %d title rows, want 2: %q", len(lines), deleting)
	}
	selectorColumn := strings.Index(lines[0], "delete preset")
	if selectorColumn < 0 || strings.Index(lines[1], "are you sure?") != selectorColumn {
		t.Fatalf("delete question is not aligned under its selector: %q", deleting)
	}

	view := stripAnsi(m.managerView())
	if strings.Contains(view, "central broker account access") {
		t.Fatalf("manager retained obsolete subtitle:\n%s", view)
	}
	if title, anthropic := strings.Index(view, "accounts"), strings.Index(view, "Anthropic"); title < 0 || anthropic <= title {
		t.Fatalf("compact title is not above provider boxes:\n%s", view)
	}
}

func TestManagerUsageChildrenRemainExactUsageRows(t *testing.T) {
	m := managerTestModel(t)
	width := 120 - gut
	rows := m.managerLines(width)
	key := accountKey{Provider: "anthropic", IdentityKey: "anthropic-a"}
	wins := m.avail.accountUsage[key]
	header := -1
	for i, row := range rows {
		if row.groupHeader && strings.Contains(stripAnsi(row.text), "a.claude@example.test") {
			header = i
			break
		}
	}
	if header < 0 {
		t.Fatal("account header missing")
	}
	specs := make([]usageRowSpec, 0, len(wins))
	for _, win := range wins {
		specs = append(specs, m.usageRowSpec(win, "      "))
	}
	innerWidth := managerProviderContentWidth(width)
	want := renderUsageRows(innerWidth, specs)
	for i := range want {
		if got := rows[header+1+i].text; got != want[i] {
			t.Fatalf("usage child %d changed the canonical width-aware row:\ngot  %q\nwant %q", i, got, want[i])
		}
		if got := lipgloss.Width(rows[header+1+i].text); got > innerWidth {
			t.Fatalf("usage child %d width = %d, manager box inner width %d", i, got, innerWidth)
		}
	}
}

func TestManagerUsageBarsGrowAndShrinkWithinChildWidth(t *testing.T) {
	m := managerTestModel(t)
	key := accountKey{Provider: "anthropic", IdentityKey: "anthropic-a"}
	m.avail.accountUsage[accountKey{Provider: "openai-codex", IdentityKey: "codex-b"}] = []usageWin{
		{label: "Codex 7 Day", pct: 8, secs: 6 * day, dur: 7 * day, prov: "openai-codex"},
	}

	assertGroup := func(width int) ([]managerLine, int) {
		t.Helper()
		rows := m.managerLines(width)
		header := -1
		for i, row := range rows {
			if row.groupHeader && strings.Contains(stripAnsi(row.text), "a.claude@example.test") {
				header = i
				break
			}
		}
		if header < 0 {
			t.Fatalf("account header missing at width %d", width)
		}
		innerWidth := managerProviderContentWidth(width)
		for _, row := range rows {
			if got := lipgloss.Width(row.text); got > innerWidth {
				t.Errorf("manager row width = %d, assigned inner width %d: %q", got, innerWidth, stripAnsi(row.text))
			}
		}
		return rows, header
	}

	wideRows, wideHeader := assertGroup(118)
	wideBar := -1
	for i := range m.avail.accountUsage[key] {
		line := stripAnsi(wideRows[wideHeader+1+i].text)
		barWidth := strings.Count(line, "█") + strings.Count(line, "░")
		if wideBar < 0 {
			wideBar = barWidth
		} else if barWidth != wideBar {
			t.Errorf("manager account percentage/reset columns lost alignment: bar widths %d and %d", wideBar, barWidth)
		}
	}
	for _, row := range wideRows {
		line := stripAnsi(row.text)
		if !strings.Contains(line, "% used") {
			continue
		}
		barWidth := strings.Count(line, "█") + strings.Count(line, "░")
		if barWidth != wideBar {
			t.Errorf("manager accounts use different bar widths: first=%d row=%d: %q", wideBar, barWidth, line)
		}
	}
	if wideBar <= usageBarNaturalW {
		t.Fatalf("118-cell manager child bar = %d, want growth beyond %d", wideBar, usageBarNaturalW)
	}
	if got, want := lipgloss.Width(wideRows[wideHeader+2].text),
		managerProviderContentWidth(118); got != want {
		t.Errorf("widest manager child consumed %d cells, want all %d inner cells", got, want)
	}

	narrowRows, narrowHeader := assertGroup(45)
	for i := range m.avail.accountUsage[key] {
		line := stripAnsi(narrowRows[narrowHeader+1+i].text)
		if !strings.Contains(line, "% used") || !strings.Contains(line, gReset) {
			t.Errorf("narrow manager child lost reserved percentage/reset text: %q", line)
		}
	}
	narrowLine := stripAnsi(narrowRows[narrowHeader+1].text)
	narrowBar := strings.Count(narrowLine, "█") + strings.Count(narrowLine, "░")
	if narrowBar >= usageBarNaturalW {
		t.Errorf("45-cell manager child bar = %d, want it to yield space below natural width %d", narrowBar, usageBarNaturalW)
	}
}

func TestManagerShowsResetCreditsUnderOwningAccount(t *testing.T) {
	m := managerTestModel(t)
	owner := accountKey{Provider: "openai-codex", IdentityKey: "codex-a"}
	m.avail.accountCredits = map[accountKey]resetCredits{
		owner: {avail: 2, exp: []int64{day, 3 * day}},
	}
	rows := m.managerLines(118)
	ownerHeader, nextHeader, credit := -1, len(rows), -1
	for i, row := range rows {
		text := stripAnsi(row.text)
		if row.groupHeader && strings.Contains(text, "a.codex@example.test") {
			ownerHeader = i
		} else if ownerHeader >= 0 && row.groupHeader {
			nextHeader = i
			break
		} else if ownerHeader >= 0 && strings.Contains(text, "2 resets") {
			credit = i
		}
	}
	if ownerHeader < 0 || credit <= ownerHeader || credit >= nextHeader {
		t.Fatalf("reset credits are not under their owning account: owner=%d credit=%d next=%d\n%s",
			ownerHeader, credit, nextHeader, stripAnsi(m.managerAccountBody(118, rows)))
	}
	if text := stripAnsi(rows[credit].text); !strings.Contains(text, "expiring in 1d, 3d") {
		t.Errorf("per-account reset line lost expiries: %q", text)
	}
}

func managerRenderedBlock(view, block string) bool {
	viewLines := strings.Split(view, "\n")
	blockLines := strings.Split(block, "\n")
	for start := 0; start+len(blockLines) <= len(viewLines); start++ {
		matches := true
		for i := range blockLines {
			if strings.TrimRight(viewLines[start+i], " ") != strings.TrimRight(blockLines[i], " ") {
				matches = false
				break
			}
		}
		if matches {
			return true
		}
	}
	return false
}

func managerRuleIndexes(view string, width int) []int {
	rule := strings.Repeat("─", width)
	var indexes []int
	for i, line := range strings.Split(stripAnsi(view), "\n") {
		if strings.TrimRight(line, " ") == rule {
			indexes = append(indexes, i)
		}
	}
	return indexes
}

func managerExactInlineHeight(m model) int {
	width := max(0, m.w-gut)
	accounts := m.managerAccountBody(width, m.managerLines(width))
	usage := m.usagePanelFor(m.w)
	controls := padLeft(m.managerControlsFor(width, "hide usage"), gut)
	footer := clikit.SeparatedSections(m.w, usage, controls)
	return lipgloss.Height(strings.Repeat("\n", topGap)+accounts) +
		lipgloss.Height(footer)
}

func TestManagerUsageInlineRequiresExactMeasuredFit(t *testing.T) {
	m := managerTestModel(t)
	m.w = 120
	m.hideUsage = false
	m.showUsage = false
	exact := managerExactInlineHeight(m)
	rows := m.managerLines(m.w - gut)
	assertManagerAccountSpacing(t, rows)
	unspacedRows := make([]managerLine, 0, len(rows))
	for _, row := range rows {
		if !row.spacer {
			unspacedRows = append(unspacedRows, row)
		}
	}
	unspacedAccounts := m.managerAccountBody(m.w-gut, unspacedRows)
	usage := m.usagePanelFor(m.w)
	controls := padLeft(m.managerControlsFor(m.w-gut, "hide usage"), gut)
	footer := clikit.SeparatedSections(m.w, usage, controls)
	unspacedExact := lipgloss.Height(strings.Repeat("\n", topGap)+unspacedAccounts) +
		lipgloss.Height(footer)
	if got, want := exact-unspacedExact, len(m.managerAccounts())-len(managerProviders); got != want {
		t.Fatalf("exact-fit geometry counted %d inter-account breathing rows, want %d", got, want)
	}

	m.h = exact
	if !m.managerUsageFitsInline() {
		t.Fatalf("canonical Usage did not fit at its exact measured height %d", exact)
	}
	exactView := m.managerView()
	panel := m.usagePanelFor(m.w)
	if !managerRenderedBlock(exactView, panel) {
		t.Fatalf("exact-fit manager did not embed the canonical Usage section:\n%s", stripAnsi(exactView))
	}
	exactLines := strings.Split(stripAnsi(exactView), "\n")
	if accounts, usage := lineIndex(exactLines, "OpenAI"),
		lineIndex(exactLines, "usage", "s · hide"); accounts < 0 || usage < 0 || usage <= accounts {
		t.Fatalf("exact-fit Usage is not below both provider boxes:\n%s", stripAnsi(exactView))
	}
	rules := managerRuleIndexes(exactView, m.w)
	usageLine := lineIndex(exactLines, "usage", "s · hide")
	if len(rules) != 2 {
		t.Fatalf("exact-fit pinned footer has %d full-width delimiters, want 2:\n%s",
			len(rules), stripAnsi(exactView))
	}
	if rules[0]+1 != usageLine || rules[1] != usageLine+lipgloss.Height(panel) {
		t.Fatalf("Usage is not framed as the pinned footer's first section: rules=%v usage=%d panelHeight=%d\n%s",
			rules, usageLine, lipgloss.Height(panel), stripAnsi(exactView))
	}
	if len(exactLines) != m.h || !strings.Contains(exactLines[len(exactLines)-1], "close") {
		t.Fatalf("exact-fit controls are not pinned to terminal bottom: rows=%d height=%d last=%q",
			len(exactLines), m.h, exactLines[len(exactLines)-1])
	}

	m.h = exact - 1
	if m.managerUsageFitsInline() {
		t.Fatalf("Usage still reported inline fit with one row missing: exact=%d", exact)
	}
	shortView := m.managerView()
	if lineIndex(strings.Split(stripAnsi(shortView), "\n"), "usage", "s · hide") >= 0 {
		t.Fatalf("one-row-short manager embedded a clipped duplicate Usage section:\n%s", stripAnsi(shortView))
	}
	if !strings.Contains(stripAnsi(shortView), "Anthropic") {
		t.Fatalf("one-row-short manager stopped prioritizing provider boxes:\n%s", stripAnsi(shortView))
	}
	shortLines := strings.Split(stripAnsi(shortView), "\n")
	if rules := managerRuleIndexes(shortView, m.w); len(rules) != 1 {
		t.Fatalf("one-row-short Accounts footer has %d delimiters, want controls only:\n%s",
			len(rules), stripAnsi(shortView))
	}
	if len(shortLines) != m.h || !strings.Contains(shortLines[len(shortLines)-1], "close") {
		t.Fatalf("one-row-short controls are not pinned to terminal bottom: rows=%d height=%d last=%q",
			len(shortLines), m.h, shortLines[len(shortLines)-1])
	}
}

func TestManagerUsageToggleSharesVisibilityAndNeverFetches(t *testing.T) {
	m := managerTestModel(t)
	m.w = 120
	m.h = managerExactInlineHeight(m)
	m.hideUsage = true
	m.showUsage = false
	hidden := m.managerView()
	hiddenLines := strings.Split(stripAnsi(hidden), "\n")
	if managerRenderedBlock(hidden, m.usagePanelFor(m.w)) {
		t.Fatalf("hidden manager rendered canonical Usage:\n%s", stripAnsi(hidden))
	}
	if rules := managerRuleIndexes(hidden, m.w); len(rules) != 1 {
		t.Fatalf("hidden manager has %d delimiters, want controls only:\n%s",
			len(rules), stripAnsi(hidden))
	}
	if len(hiddenLines) != m.h || !strings.Contains(hiddenLines[len(hiddenLines)-1], "close") {
		t.Fatalf("hidden controls are not pinned to terminal bottom: rows=%d height=%d last=%q",
			len(hiddenLines), m.h, hiddenLines[len(hiddenLines)-1])
	}

	var cmd tea.Cmd
	m, cmd = managerUpdate(t, m, "s")
	if cmd != nil || m.fetching || m.hideUsage || m.showUsage || !m.managerUsageFitsInline() {
		t.Fatalf("hidden tall s did not show locally without fetching: cmd=%v fetching=%v hidden=%v alternate=%v fits=%v",
			cmd != nil, m.fetching, m.hideUsage, m.showUsage, m.managerUsageFitsInline())
	}
	m, cmd = managerUpdate(t, m, "s")
	if cmd != nil || m.fetching || !m.hideUsage || m.showUsage {
		t.Fatalf("visible inline s did not hide locally: cmd=%v fetching=%v hidden=%v alternate=%v",
			cmd != nil, m.fetching, m.hideUsage, m.showUsage)
	}

	m.h--
	m, cmd = managerUpdate(t, m, "s")
	if cmd != nil || m.fetching || m.hideUsage || !m.showUsage {
		t.Fatalf("hidden short s did not open alternate locally: cmd=%v fetching=%v hidden=%v alternate=%v",
			cmd != nil, m.fetching, m.hideUsage, m.showUsage)
	}
	alternate := m.managerView()
	if strings.Contains(stripAnsi(alternate), "Anthropic") {
		t.Fatalf("alternate Usage view retained account-manager content:\n%s", stripAnsi(alternate))
	}
	if !managerRenderedBlock(alternate, m.usagePanelFor(m.w)) {
		t.Fatalf("alternate did not reuse the exact canonical Usage section:\n%s", stripAnsi(alternate))
	}
	alternateLines := strings.Split(stripAnsi(alternate), "\n")
	if rules := managerRuleIndexes(alternate, m.w); len(rules) != 1 {
		t.Fatalf("alternate Usage has %d delimiters, want controls only without duplicated framing:\n%s",
			len(rules), stripAnsi(alternate))
	}
	if len(alternateLines) != m.h || !strings.Contains(alternateLines[len(alternateLines)-1], "close") {
		t.Fatalf("alternate controls are not pinned to terminal bottom: rows=%d height=%d last=%q",
			len(alternateLines), m.h, alternateLines[len(alternateLines)-1])
	}
	m, cmd = managerUpdate(t, m, "s")
	if cmd != nil || m.fetching || !m.hideUsage || m.showUsage {
		t.Fatalf("alternate s did not hide Usage and return accounts: cmd=%v fetching=%v hidden=%v alternate=%v",
			cmd != nil, m.fetching, m.hideUsage, m.showUsage)
	}

	m.hideUsage = false
	m.showUsage = false
	m, cmd = managerUpdate(t, m, "s")
	if cmd != nil || m.fetching || m.hideUsage || !m.showUsage {
		t.Fatalf("non-fitting logical Usage did not open alternate: cmd=%v fetching=%v hidden=%v alternate=%v",
			cmd != nil, m.fetching, m.hideUsage, m.showUsage)
	}
}

func TestManagerEntryExitPreservesSharedUsageFields(t *testing.T) {
	for _, state := range []struct {
		name                 string
		hideUsage, showUsage bool
	}{
		{name: "hidden", hideUsage: true},
		{name: "alternate", showUsage: true},
		{name: "logical-inline"},
	} {
		t.Run(state.name, func(t *testing.T) {
			m := managerTestModel(t)
			m.manager = false
			m.hideUsage, m.showUsage = state.hideUsage, state.showUsage
			next, cmd := m.Update(managerKey("v"))
			entered := next.(model)
			if cmd != nil || !entered.manager ||
				entered.hideUsage != state.hideUsage || entered.showUsage != state.showUsage {
				t.Fatalf("entry changed visibility: cmd=%v manager=%v hidden=%v alternate=%v",
					cmd != nil, entered.manager, entered.hideUsage, entered.showUsage)
			}
			next, cmd = entered.Update(managerKey("v"))
			exited := next.(model)
			if cmd != nil || exited.manager ||
				exited.hideUsage != state.hideUsage || exited.showUsage != state.showUsage {
				t.Fatalf("exit changed visibility: cmd=%v manager=%v hidden=%v alternate=%v",
					cmd != nil, exited.manager, exited.hideUsage, exited.showUsage)
			}
		})
	}
}

func TestManagerUsageResizeTransitionsRemainResponsive(t *testing.T) {
	m := managerTestModel(t)
	m.w = 120
	exact := managerExactInlineHeight(m)
	m.h = exact - 1
	m.hideUsage = false
	m.showUsage = true

	short := m.managerView()
	if strings.Contains(stripAnsi(short), "Anthropic") ||
		lineIndex(strings.Split(stripAnsi(short), "\n"), "usage", "s · hide") < 0 {
		t.Fatalf("short alternate composition is wrong:\n%s", stripAnsi(short))
	}
	if rules := managerRuleIndexes(short, m.w); len(rules) != 1 {
		t.Fatalf("short alternate has %d delimiters, want controls-only framing:\n%s",
			len(rules), stripAnsi(short))
	}

	next, _ := m.Update(tea.WindowSizeMsg{Width: m.w, Height: exact})
	m = next.(model)
	tall := m.managerView()
	if m.hideUsage || !m.showUsage || !m.managerUsageFitsInline() ||
		!strings.Contains(stripAnsi(tall), "Anthropic") ||
		lineIndex(strings.Split(stripAnsi(tall), "\n"), "usage", "s · hide") < 0 {
		t.Fatalf("growing alternate did not place Usage inline without mutating state: hidden=%v alternate=%v fits=%v\n%s",
			m.hideUsage, m.showUsage, m.managerUsageFitsInline(), stripAnsi(tall))
	}
	if rules := managerRuleIndexes(tall, m.w); len(rules) != 2 {
		t.Fatalf("growing into inline mode did not transfer Usage into the two-divider footer: rules=%v\n%s",
			rules, stripAnsi(tall))
	}
	if !managerRenderedBlock(tall, m.usagePanelFor(m.w)) {
		t.Fatalf("growing into inline mode changed canonical Usage:\n%s", stripAnsi(tall))
	}

	next, _ = m.Update(tea.WindowSizeMsg{Width: m.w, Height: exact - 1})
	m = next.(model)
	again := m.managerView()
	if m.hideUsage || !m.showUsage || m.managerUsageFitsInline() ||
		strings.Contains(stripAnsi(again), "Anthropic") {
		t.Fatalf("shrinking did not restore alternate without mutating state: hidden=%v alternate=%v fits=%v\n%s",
			m.hideUsage, m.showUsage, m.managerUsageFitsInline(), stripAnsi(again))
	}
	if rules := managerRuleIndexes(again, m.w); len(rules) != 1 {
		t.Fatalf("shrinking back to alternate did not transfer Usage out of the footer: rules=%v\n%s",
			rules, stripAnsi(again))
	}
	if !managerRenderedBlock(again, m.usagePanelFor(m.w)) {
		t.Fatalf("shrinking back to alternate changed canonical Usage:\n%s", stripAnsi(again))
	}

	m.showUsage = false
	accounts := m.managerView()
	if !strings.Contains(stripAnsi(accounts), "Anthropic") ||
		lineIndex(strings.Split(stripAnsi(accounts), "\n"), "usage", "s · hide") >= 0 {
		t.Fatalf("logical non-fitting Usage displaced primary accounts before s:\n%s", stripAnsi(accounts))
	}
	next, _ = m.Update(tea.WindowSizeMsg{Width: m.w, Height: exact})
	m = next.(model)
	if !strings.Contains(stripAnsi(m.managerView()), "Anthropic") ||
		lineIndex(strings.Split(stripAnsi(m.managerView()), "\n"), "usage", "s · hide") < 0 {
		t.Fatalf("logical Usage did not return inline when resize made room:\n%s", stripAnsi(m.managerView()))
	}
}

func TestManagerAlternateUsageStaysWithinTerminalBounds(t *testing.T) {
	for _, size := range []struct{ width, height int }{
		{120, 24},
		{58, 18},
		{36, 14},
		{24, 8},
	} {
		m := managerTestModel(t)
		m.w, m.h = size.width, size.height
		m.hideUsage = false
		m.showUsage = true
		if m.managerUsageFitsInline() {
			t.Fatalf("fixture %dx%d unexpectedly seats the full inline manager", size.width, size.height)
		}
		view := m.managerView()
		if got := lipgloss.Height(view); got > size.height {
			t.Errorf("%dx%d alternate height = %d", size.width, size.height, got)
		}
		for _, line := range strings.Split(view, "\n") {
			if got := lipgloss.Width(line); got > size.width {
				t.Errorf("%dx%d alternate line width = %d: %q", size.width, size.height, got, stripAnsi(line))
			}
		}
		if lineIndex(strings.Split(stripAnsi(view), "\n"), "usage", "s · hide") < 0 {
			t.Errorf("%dx%d alternate lost canonical Usage title:\n%s", size.width, size.height, stripAnsi(view))
		}
		if strings.Contains(stripAnsi(view), "Anthropic") {
			t.Errorf("%dx%d alternate mixed account content into canonical Usage:\n%s",
				size.width, size.height, stripAnsi(view))
		}
	}
}

func TestManagerUsageControlsFollowContextWithoutPresetSaveCollision(t *testing.T) {
	m := managerTestModel(t)
	m.w = 120
	exact := managerExactInlineHeight(m)
	for _, state := range []struct {
		name                 string
		height               int
		hideUsage, showUsage bool
		want                 string
	}{
		{name: "hidden-fit", height: exact, hideUsage: true, want: "show usage"},
		{name: "inline", height: exact, want: "hide usage"},
		{name: "logical-short", height: exact - 1, want: "show usage"},
		{name: "alternate", height: exact - 1, showUsage: true, want: "hide usage"},
	} {
		t.Run(state.name, func(t *testing.T) {
			candidate := m
			candidate.h = state.height
			candidate.hideUsage, candidate.showUsage = state.hideUsage, state.showUsage
			controls := stripAnsi(candidate.managerControls(candidate.w - gut))
			if !strings.Contains(controls, state.want) {
				t.Fatalf("controls missing s %s: %s", state.want, controls)
			}
		})
	}

	if err := m.accountSelections.UpsertPreset("Work", nil); err != nil {
		t.Fatal(err)
	}
	m.accountSelections.Activate("Work")
	m.beginManagerPresetEdit()
	edit := stripAnsi(m.managerControls(m.w - gut))
	if !strings.Contains(edit, "save preset") ||
		strings.Contains(edit, "show usage") || strings.Contains(edit, "hide usage") {
		t.Fatalf("preset-edit s precedence is ambiguous: %s", edit)
	}
	m.managerPreset = managerPresetState{naming: true}
	naming := stripAnsi(m.managerControls(m.w - gut))
	if strings.Contains(naming, "show usage") || strings.Contains(naming, "hide usage") {
		t.Fatalf("naming modal leaked Usage controls: %s", naming)
	}
}
