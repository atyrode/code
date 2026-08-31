package main

// The configuration ceremony, driven headlessly. The dial UI is a Bubble Tea
// model, so the operator's keystrokes are messages: a test can turn a dial,
// confirm, or walk away exactly as a human does, and then assert what the
// ceremony committed. What a test cannot do is own a terminal — so the tty gate
// is asserted from the other side, by reaching this mode without one.

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/bubbles/key"
	tea "github.com/charmbracelet/bubbletea"
)

// keepKeybindings restores the bindings the ceremony mutates. newInteractiveApp
// disables the launch keys and relabels Enter for a configure run, and the
// keymap is package state, so a test that builds one would otherwise leave the
// footer of every later test saying "confirm".
func keepKeybindings(t *testing.T) {
	t.Helper()
	saved := map[*key.Binding]key.Binding{
		&keys.Launch:    keys.Launch,
		&keys.Managed:   keys.Managed,
		&keys.Untrusted: keys.Untrusted,
		&keys.Worktree:  keys.Worktree,
	}
	t.Cleanup(func() {
		for binding, original := range saved {
			*binding = original
		}
	})
}

// ceremonyModel builds the ceremony's UI the way `code babel --configure` does,
// against an isolated store, catalog and state root.
func ceremonyModel(t *testing.T) model {
	t.Helper()
	keepKeybindings(t)
	app := newInteractiveApp(interactiveConfigure)
	m, ok := app.(model)
	if !ok {
		t.Fatalf("the ceremony mounted %T, not the dial UI", app)
	}
	return m
}

// confirm presses Enter, which is the operator's confirmation.
func confirm(t *testing.T, m model) model {
	t.Helper()
	next, _ := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	return next.(model)
}

// turnDial moves the cursor onto one dial and cycles it, which is what an
// operator's ↑↓←→ do. Cycling clamps at the endpoints, so it tries the other
// direction rather than reporting a dial that was already at its limit as
// unmovable.
func turnDial(t *testing.T, m model, dial string) model {
	t.Helper()
	found := false
	for i, f := range m.facets {
		if f.key == dial {
			m.fcur, found = i, true
			break
		}
	}
	if !found {
		t.Fatalf("no dial named %q to turn", dial)
	}
	before := m.sel[dial]
	m.cycleFacet(1)
	if m.sel[dial] == before {
		m.cycleFacet(-1)
	}
	if m.sel[dial] == before {
		t.Fatalf("dial %q would not move off %q", dial, before)
	}
	return m
}

// TestBabelConfigureCeremonyMintsWhatTheOperatorConfirmed is the ceremony end to
// end, minus the terminal: the operator turns a dial, confirms, and Babel gets a
// reference to a revision that carries exactly what was on screen.
func TestBabelConfigureCeremonyMintsWhatTheOperatorConfirmed(t *testing.T) {
	store := isolateBabelEnv(t)
	t.Setenv("CODE_GENERATED", babelCatalogFixture(t))
	result := filepath.Join(t.TempDir(), "result.json")

	m := ceremonyModel(t)
	if m.configureConfirmed() {
		t.Fatal("the ceremony opened already confirmed; nothing had been chosen yet")
	}
	// Turn a dial the way an operator does, then confirm.
	m = turnDial(t, m, "thinking")
	turned := m.sel["thinking"]

	final := confirm(t, m)
	if !final.configureConfirmed() {
		t.Fatal("Enter did not confirm the configuration")
	}
	if status := babelCommitConfiguration(final, babelOptions{
		profileID: defaultBabelProfileID, resultFile: result,
	}); status != 0 {
		t.Fatalf("committing a confirmed ceremony exited %d, want 0", status)
	}

	// Babel's half: the file it reads, and the reference it stores.
	answer, err := os.ReadFile(result)
	if err != nil {
		t.Fatalf("reading the reference the ceremony wrote: %v", err)
	}
	var reference babelConfigureResult
	if err := json.Unmarshal(answer, &reference); err != nil {
		t.Fatalf("the reference does not decode: %v (%s)", err, answer)
	}
	if reference.Profile != defaultBabelProfileID || reference.Revision < 1 {
		t.Errorf("reference = %+v, want profile %q at a positive revision",
			reference, defaultBabelProfileID)
	}
	info, err := os.Stat(result)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("the reference file is mode %04o, want 0600", perm)
	}

	// Code's half: the revision resolves, and it holds the dials that were
	// confirmed rather than the ones the process started with.
	saved, err := newProfileStore(store).load(reference.Profile, reference.Revision)
	if err != nil {
		t.Fatalf("the reference does not resolve in the store: %v", err)
	}
	if saved.Selection["thinking"] != turned {
		t.Errorf("saved thinking = %q, want the confirmed %q", saved.Selection["thinking"], turned)
	}
	if saved.Metadata["thinking"] != turned {
		t.Errorf("recorded metadata reports thinking %q, want %q", saved.Metadata["thinking"], turned)
	}
	if names := secretShapedMetadata(saved.Metadata); len(names) > 0 {
		t.Errorf("the minted profile declares credential-shaped keys %v", names)
	}

	// And the protocol mode Babel's conformance suite grades now has something
	// to report: the same reference, unchanged.
	reported, err := babelStoredProfile(reference.Profile)
	if err != nil {
		t.Fatalf("configure mode cannot report the profile the ceremony minted: %v", err)
	}
	if reported.ref() != (babelProfileRef{ID: reference.Profile, Revision: reference.Revision}) {
		t.Errorf("configure mode reports %+v, want the minted %+v", reported.ref(), reference)
	}
}

// TestBabelConfigureCeremonyCancelledChangesNothing is the outcome that has to
// be cheap. An operator who opens the ceremony to look at the dials and leaves
// must not change what Babel is holding, so no revision is minted and no
// reference file exists for Babel to read — which is how it reports the
// configuration unchanged.
func TestBabelConfigureCeremonyCancelledChangesNothing(t *testing.T) {
	store := isolateBabelEnv(t)
	t.Setenv("CODE_GENERATED", babelCatalogFixture(t))
	result := filepath.Join(t.TempDir(), "result.json")

	m := ceremonyModel(t)
	m = turnDial(t, m, "thinking") // look around, change your mind
	if m.configureConfirmed() {
		t.Fatal("turning a dial confirmed the configuration on its own")
	}
	if status := babelCommitConfiguration(m, babelOptions{
		profileID: defaultBabelProfileID, resultFile: result,
	}); status == 0 {
		t.Error("an unconfirmed ceremony exited 0, which Babel reads as a new configuration")
	}
	if _, err := os.Stat(result); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("an unconfirmed ceremony wrote a reference file: %v", err)
	}
	if latest, err := newProfileStore(store).latestRevision(defaultBabelProfileID); err != nil || latest != 0 {
		t.Errorf("latest revision = %d (%v), want none: nothing was confirmed", latest, err)
	}
}

// TestBabelConfigureCeremonyLaunchesNothing keeps the ceremony from ending in a
// session. The dial UI's other exits start omp — the managed defaults, the
// untrusted launcher, an isolated worktree — and none of them produces a profile
// Code could describe, so during a ceremony they are inert rather than quietly
// starting something Babel is holding the operator's terminal open for.
func TestBabelConfigureCeremonyLaunchesNothing(t *testing.T) {
	isolateBabelEnv(t)
	t.Setenv("CODE_GENERATED", babelCatalogFixture(t))

	// The label Enter carries outside a ceremony, so the relabel below is
	// measured against something rather than asserted in a vacuum.
	if desc := keys.Launch.Help().Desc; desc != "launch" {
		t.Fatalf("Enter is advertised as %q before any ceremony, want launch", desc)
	}

	m := ceremonyModel(t)
	next, _ := m.Update(gitRepoMsg{root: t.TempDir(), ok: true})
	m = next.(model)

	for _, k := range []string{"m", "u", "w"} {
		after, _ := press(t, m, k)
		if after.launchManaged || after.launchUntrusted || after.launchRuntime != "" {
			t.Errorf("%q started a session during a ceremony: managed=%v untrusted=%v runtime=%q",
				k, after.launchManaged, after.launchUntrusted, after.launchRuntime)
		}
		if after.worktreeMode {
			t.Errorf("%q armed an isolated worktree during a ceremony, which launches nothing", k)
		}
		if after.configureConfirmed() {
			t.Errorf("%q confirmed a configuration; only Enter does that", k)
		}
	}
	if keys.Managed.Enabled() || keys.Untrusted.Enabled() || keys.Worktree.Enabled() {
		t.Error("the launch keys are still advertised in the footer of a ceremony")
	}
	if desc := keys.Launch.Help().Desc; desc != "confirm" {
		t.Errorf("Enter is advertised as %q, want confirm: it launches nothing here", desc)
	}
	// And Enter still does the one thing that ends a ceremony.
	if !confirm(t, m).configureConfirmed() {
		t.Error("Enter did not confirm the configuration")
	}
}

// TestBabelConfigureCeremonyIgnoresTheSelectionEnvironment is decision 1's rule
// on this side of the boundary: CODE_SELECTION_STATE does not choose what the
// operator is asked to confirm. Anything in the process tree can set it, so a
// ceremony that honoured it could show — and mint — a dial position nobody in
// the room chose. The default location, which is where an interactive `code`
// writes, is what the ceremony opens on instead.
func TestBabelConfigureCeremonyIgnoresTheSelectionEnvironment(t *testing.T) {
	isolateBabelEnv(t)
	t.Setenv("CODE_GENERATED", babelCatalogFixture(t))

	// The operator's own dials, where `code` leaves them.
	writeSelectionFixture(t, defaultSelectionStatePath(),
		`{"lane":"claude-led","model":"fast","thinking":"low","advisor":"off"}`)
	// And a relocation pointing somewhere else entirely.
	planted := filepath.Join(t.TempDir(), "planted.json")
	writeSelectionFixture(t, planted,
		`{"lane":"gpt-led","model":"smart","thinking":"xhigh","advisor":"audit"}`)
	t.Setenv(codeSelectionStateEnv, planted)

	m := ceremonyModel(t)
	if m.sel["lane"] == "gpt-led" || m.sel["thinking"] == "xhigh" {
		t.Fatalf("the ceremony opened on the relocated selection: %v", m.sel)
	}
	if m.sel["lane"] != "claude-led" || m.sel["thinking"] != "low" {
		t.Errorf("the ceremony opened on %v, want the operator's own dials at the default location",
			m.sel)
	}
	if m.selectionState != defaultSelectionStatePath() || m.selectionHandoff != "" {
		t.Errorf("the ceremony writes dials to %q (handoff %q), want the default location only",
			m.selectionState, m.selectionHandoff)
	}

	// The relocation is untouched: a ceremony neither reads nor writes it.
	relocated, err := os.ReadFile(planted)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(relocated), `"gpt-led"`) {
		t.Errorf("the ceremony rewrote the relocated selection: %s", relocated)
	}

	// Non-vacuity: with the default location gone the ceremony opens on Code's
	// defaults, so the read above was doing the work.
	if err := os.Remove(defaultSelectionStatePath()); err != nil {
		t.Fatal(err)
	}
	bare := ceremonyModel(t)
	if defaults := defaultSel(); bare.sel["lane"] != defaults["lane"] {
		t.Errorf("without the default location the ceremony opened on lane %q, want the default %q",
			bare.sel["lane"], defaults["lane"])
	}
}

// TestBabelConfigureRefusesWithoutATerminal reaches this mode the way an
// unattended caller would: `go test` runs with pipes, not a tty, which is
// exactly the shape Babel hands a worker in every other mode. The refusal is the
// point — there is no fallback left that could mint a profile without a human —
// and it must come before anything is written.
func TestBabelConfigureRefusesWithoutATerminal(t *testing.T) {
	store := isolateBabelEnv(t)
	result := filepath.Join(t.TempDir(), "result.json")

	if err := requireOperatorTerminal(); !errors.Is(err, errNoOperatorTerminal) {
		t.Skipf("this test process has a terminal on stdin and stdout (%v), so it cannot "+
			"exercise the refusal", err)
	}
	if status := runBabelConfigure(babelOptions{
		profileID: defaultBabelProfileID, configure: true, resultFile: result,
	}); status == 0 {
		t.Error("the ceremony exited 0 with no terminal to confirm anything on")
	}
	if _, err := os.Stat(result); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a refused ceremony wrote a reference file: %v", err)
	}
	if latest, err := newProfileStore(store).latestRevision(defaultBabelProfileID); err != nil || latest != 0 {
		t.Errorf("latest revision = %d (%v), want none: a refused ceremony mints nothing",
			latest, err)
	}

	t.Run("and it needs somewhere to answer", func(t *testing.T) {
		if status := runBabelConfigure(babelOptions{
			profileID: defaultBabelProfileID, configure: true,
		}); status == 0 {
			t.Error("the ceremony exited 0 with no --result-file to answer through")
		}
	})
}

// TestBabelConfigureResultFileTightensPermissions covers the file Babel creates
// for this process to answer through. Babel makes it 0600 in a private
// directory; a worker that widened it — by writing through a mode the umask
// relaxed, or by leaving a mode someone else set — would be the one weakening
// that, so the mode is asserted against a deliberately open starting point.
func TestBabelConfigureResultFileTightensPermissions(t *testing.T) {
	result := filepath.Join(t.TempDir(), "result.json")
	if err := os.WriteFile(result, []byte("stale"), 0o666); err != nil {
		t.Fatal(err)
	}
	ref := babelProfileRef{ID: "code", Revision: 7}
	if err := writeBabelConfigureResult(result, ref); err != nil {
		t.Fatalf("writeBabelConfigureResult: %v", err)
	}
	info, err := os.Stat(result)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("result file mode = %04o, want 0600", perm)
	}
	answer, err := os.ReadFile(result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(answer), "stale") {
		t.Errorf("the previous contents survived the write: %s", answer)
	}
	var decoded map[string]any
	if err := json.Unmarshal(answer, &decoded); err != nil {
		t.Fatalf("the answer does not decode: %v (%s)", err, answer)
	}
	// Babel reads exactly these two keys, under exactly these names.
	if decoded["profile"] != "code" || decoded["revision"] != float64(7) {
		t.Errorf("answer = %v, want the reference under profile/revision", decoded)
	}
	if len(decoded) != 2 {
		t.Errorf("the answer carries %d keys (%v); the reference is the whole answer", len(decoded), decoded)
	}
}
