package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// sampleProfile is a valid profile with no secret-shaped metadata, used as the
// baseline the revision tests mutate.
func sampleProfile(id string) codeProfile {
	return codeProfile{
		ID:                id,
		Selection:         map[string]string{"lane": "mixed", "model": "smart", "thinking": "medium"},
		ComboID:           "mixed_smart_medium_nosp",
		Disclosure:        disclosureHosted,
		RedactionRequired: true,
		Cost:              profileCost{Currency: "USD", InputPer1K: 0.003, OutputPer1K: 0.015},
		Metadata:          map[string]string{"provider": "anthropic", "model": "sonnet", "thinking": "medium"},
	}
}

// TestProfileStoreRevisionIdentity is the store's central rule: a revision is
// what its content says it is. Re-saving identical content must not inflate the
// history a client holds references into, changed content must produce a new
// revision, and a revision already handed to a client must never change underneath
// it.
func TestProfileStoreRevisionIdentity(t *testing.T) {
	store := newProfileStore(t.TempDir())

	first, err := store.save(sampleProfile("code"))
	if err != nil {
		t.Fatalf("first save: %v", err)
	}
	if first.Revision != 1 {
		t.Fatalf("first revision = %d, want 1", first.Revision)
	}

	// Byte-identical content, built independently so map iteration order cannot
	// be what makes the comparison succeed.
	again, err := store.save(sampleProfile("code"))
	if err != nil {
		t.Fatalf("identical save: %v", err)
	}
	if again.Revision != 1 {
		t.Errorf("identical content bumped the revision to %d; a reference a client holds would be stale for no reason", again.Revision)
	}
	if again.Saved != first.Saved {
		t.Errorf("identical save rewrote the timestamp (%d → %d), so the revision was not reused", first.Saved, again.Saved)
	}

	changed := sampleProfile("code")
	changed.Selection["thinking"] = "high"
	changed.Metadata["thinking"] = "high"
	third, err := store.save(changed)
	if err != nil {
		t.Fatalf("changed save: %v", err)
	}
	if third.Revision != 2 {
		t.Fatalf("changed content produced revision %d, want 2", third.Revision)
	}

	// The reference a client recorded for revision 1 still resolves to what it
	// resolved to before revision 2 existed.
	old, err := store.load("code", 1)
	if err != nil {
		t.Fatalf("load revision 1: %v", err)
	}
	if old.Metadata["thinking"] != "medium" {
		t.Errorf("revision 1 now reports thinking=%q; a written revision is immutable", old.Metadata["thinking"])
	}
	latest, err := store.load("code", 0)
	if err != nil {
		t.Fatalf("load latest: %v", err)
	}
	if latest.Revision != 2 {
		t.Errorf("latest revision = %d, want 2", latest.Revision)
	}

	// A cost change alone is a content change: a client records the estimate.
	cheaper := sampleProfile("code")
	cheaper.Selection["thinking"] = "high"
	cheaper.Metadata["thinking"] = "high"
	cheaper.Cost.InputPer1K = 0.001
	fourth, err := store.save(cheaper)
	if err != nil {
		t.Fatalf("cost-only save: %v", err)
	}
	if fourth.Revision != 3 {
		t.Errorf("a cost change produced revision %d, want 3", fourth.Revision)
	}
}

// TestProfileStoreRefusesCredentialMetadata checks the boundary a client relies on
// from its side: a credential must never cross it, so a key that could hold one
// is refused rather than filtered.
func TestProfileStoreRefusesCredentialMetadata(t *testing.T) {
	refused := []string{
		"api_key", "API_KEY", "openai_api_key_value", "apikey", "authorization",
		"bearer", "credential_id", "passwd", "password", "private_key",
		"client_secret", "broker_token",
	}
	for _, key := range refused {
		t.Run("refused/"+key, func(t *testing.T) {
			store := newProfileStore(t.TempDir())
			profile := sampleProfile("code")
			profile.Metadata[key] = "hunter2"
			_, err := store.save(profile)
			if !errors.Is(err, errProfileSecretDeclared) {
				t.Fatalf("save with metadata key %q: err = %v, want errProfileSecretDeclared", key, err)
			}
			if !strings.Contains(err.Error(), key) {
				t.Errorf("the refusal %q does not name %q, so nobody can fix it", err, key)
			}
		})
	}
	for _, key := range []string{"provider", "model", "thinking", "lane", "combo", "advisor", "runtime", "tier"} {
		t.Run("allowed/"+key, func(t *testing.T) {
			store := newProfileStore(t.TempDir())
			profile := sampleProfile("code")
			profile.Metadata[key] = "value"
			if _, err := store.save(profile); err != nil {
				t.Fatalf("save with metadata key %q: %v", key, err)
			}
		})
	}
}

// TestProfileStoreConcurrentSaves proves the lock does its job: concurrent
// saves of distinct content must produce distinct consecutive revisions, each a
// whole readable record, rather than interleaving into a corrupt file or landing
// twice on the same revision number.
func TestProfileStoreConcurrentSaves(t *testing.T) {
	dir := t.TempDir()
	const writers = 8

	var wg sync.WaitGroup
	revisions := make([]int, writers)
	errs := make([]error, writers)
	start := make(chan struct{})
	for i := range writers {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			profile := sampleProfile("code")
			profile.Metadata["combo"] = strings.Repeat("x", n+1)
			<-start
			saved, err := newProfileStore(dir).save(profile)
			revisions[n], errs[n] = saved.Revision, err
		}(i)
	}
	close(start)
	wg.Wait()

	seen := map[int]bool{}
	for i, err := range errs {
		if err != nil {
			t.Fatalf("writer %d: %v", i, err)
		}
		if seen[revisions[i]] {
			t.Fatalf("revision %d was handed out twice", revisions[i])
		}
		seen[revisions[i]] = true
	}
	store := newProfileStore(dir)
	for revision := 1; revision <= writers; revision++ {
		if !seen[revision] {
			t.Errorf("revision %d was never allocated; the history has a hole", revision)
		}
		profile, err := store.load("code", revision)
		if err != nil {
			t.Fatalf("load revision %d: %v", revision, err)
		}
		if profile.Revision != revision || profile.ID != "code" {
			t.Errorf("revision %d reads back as %s@%d", revision, profile.ID, profile.Revision)
		}
	}
	latest, err := store.latestRevision("code")
	if err != nil {
		t.Fatal(err)
	}
	if latest != writers {
		t.Errorf("latest revision = %d, want %d", latest, writers)
	}
}

// TestProfileStoreRejectsUnsafeID keeps a profile id from steering a write out
// of the store. The id arrives from a flag, so it is
// untrusted input that becomes a path element.
func TestProfileStoreRejectsUnsafeID(t *testing.T) {
	for _, id := range []string{"", ".", "..", "../escape", "a/b", `a\b`, "with space", "emoji✨", strings.Repeat("x", 129)} {
		store := newProfileStore(t.TempDir())
		profile := sampleProfile(id)
		if _, err := store.save(profile); err == nil {
			t.Errorf("save accepted profile id %q", id)
		}
		if _, err := store.load(id, 1); err == nil {
			t.Errorf("load accepted profile id %q", id)
		}
	}
	for _, id := range []string{"code", "code-2", "code_alt", "v1.2"} {
		store := newProfileStore(t.TempDir())
		if _, err := store.save(sampleProfile(id)); err != nil {
			t.Errorf("save rejected profile id %q: %v", id, err)
		}
	}
}

// TestProfileStoreLocation pins the state location and its permissions to
// Code's existing convention: mutable state Code owns lives under
// $XDG_STATE_HOME/code, and an override names the directory outright.
func TestProfileStoreLocation(t *testing.T) {
	state := t.TempDir()
	t.Setenv("XDG_STATE_HOME", state)
	t.Setenv(profileStateEnv, "")
	if got, want := profileDir(), filepath.Join(state, "code", "profiles"); got != want {
		t.Errorf("profileDir() = %q, want %q", got, want)
	}
	override := filepath.Join(t.TempDir(), "elsewhere")
	t.Setenv(profileStateEnv, override)
	if got := profileDir(); got != override {
		t.Errorf("profileDir() = %q, want the override %q", got, override)
	}

	if _, err := newProfileStore("").save(sampleProfile("code")); err != nil {
		t.Fatalf("save into the override: %v", err)
	}
	info, err := os.Stat(filepath.Join(override, "code", revisionFile(1)))
	if err != nil {
		t.Fatalf("revision file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("revision file mode = %o, want 600", perm)
	}
	dir, err := os.Stat(filepath.Join(override, "code"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := dir.Mode().Perm(); perm != 0o700 {
		t.Errorf("profile directory mode = %o, want 700", perm)
	}
}

// TestProfileStoreDetectsMislabelledRevision covers the read side of
// immutability: a record whose contents disagree with its own filename means the
// reference a client holds points at something else, which is corruption rather
// than an old format.
func TestProfileStoreDetectsMislabelledRevision(t *testing.T) {
	dir := t.TempDir()
	store := newProfileStore(dir)
	if _, err := store.save(sampleProfile("code")); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "code", revisionFile(1))
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	tampered := strings.Replace(string(data), `"revision":1`, `"revision":7`, 1)
	if tampered == string(data) {
		t.Fatal("the revision field was not where this test expects it")
	}
	if err := os.WriteFile(path, []byte(tampered), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.load("code", 1); err == nil {
		t.Error("load accepted a record that claims a different revision than its filename")
	}
}

// TestProfileStoreImportCarriesRevisionsVerbatim is the migration path: a
// directory laid out like a store is copied in with every revision number
// intact, a revision already present with the same content is left alone, and
// one present with different content refuses the import rather than letting
// two stores disagree about what a reference means.
func TestProfileStoreImportCarriesRevisionsVerbatim(t *testing.T) {
	source := newProfileStore(t.TempDir())
	first, err := source.save(sampleProfile("code"))
	if err != nil {
		t.Fatal(err)
	}
	changed := sampleProfile("code")
	changed.Selection["thinking"] = "high"
	second, err := source.save(changed)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 || second.Revision != 2 {
		t.Fatalf("the source holds revisions %d and %d, want 1 and 2", first.Revision, second.Revision)
	}
	original, err := os.ReadFile(filepath.Join(source.dir, "code", revisionFile(2)))
	if err != nil {
		t.Fatal(err)
	}

	target := newProfileStore(t.TempDir())
	imported, err := target.importFrom(source.dir)
	if err != nil {
		t.Fatalf("importFrom: %v", err)
	}
	if imported != 2 {
		t.Errorf("imported %d revision(s), want 2", imported)
	}
	copied, err := os.ReadFile(filepath.Join(target.dir, "code", revisionFile(2)))
	if err != nil {
		t.Fatal(err)
	}
	if string(copied) != string(original) {
		t.Errorf("revision 2 was re-encoded rather than copied:\n%s\n---\n%s", copied, original)
	}
	if info, err := os.Stat(filepath.Join(target.dir, "code", revisionFile(2))); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("imported revision mode = %v (%v), want 0600", info, err)
	}
	if got, err := target.load("code", 1); err != nil || got.identity() == nil || string(got.identity()) != string(first.identity()) {
		t.Errorf("revision 1 does not resolve to what the source held: %v", err)
	}

	// A second import of the same directory changes nothing.
	if again, err := target.importFrom(source.dir); err != nil || again != 0 {
		t.Errorf("re-importing identical revisions imported %d, %v; want 0, nil", again, err)
	}

	// A revision that exists with different content is refused by name, and
	// nothing else from that profile is written past it.
	conflict := newProfileStore(t.TempDir())
	other := sampleProfile("code")
	other.Metadata["model"] = "opus"
	if _, err := conflict.save(other); err != nil {
		t.Fatal(err)
	}
	if _, err := conflict.importFrom(source.dir); err == nil || !strings.Contains(err.Error(), "code@1") {
		t.Errorf("a conflicting revision was imported or refused without naming it: %v", err)
	}
	if latest, _ := conflict.latestRevision("code"); latest != 1 {
		t.Errorf("the conflicting import wrote past the refusal: latest revision %d", latest)
	}

	// An id that is not a safe path element refuses the whole directory.
	bad := t.TempDir()
	if err := os.MkdirAll(filepath.Join(bad, "with space"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := newProfileStore(t.TempDir()).importFrom(bad); err == nil {
		t.Error("an unsafe profile id was imported")
	}
}

// ── describing the dials ─────────────────────────────────────────────────────

// TestProfileOverlay is what makes a saved reference worth recording: the
// profile has to render the same omp overlay months later that the dials
// rendered when it was saved, and a catalog that can no longer serve it has to
// say so instead of handing omp a session with no routing.
func TestProfileOverlay(t *testing.T) {
	isolateEngineEnv(t)
	t.Setenv("CODE_GENERATED", engineCatalogFixture(t))

	m := turnedDials(t, map[string]string{"lane": "ds-led", "thinking": "high", "advisor": "audit"})
	saved, err := mintProfile(m, "code")
	if err != nil {
		t.Fatalf("minting the confirmed dials: %v", err)
	}
	if saved.Metadata["provider"] != "deepseek" {
		t.Errorf("metadata provider = %q, want the lane's leading provider", saved.Metadata["provider"])
	}

	overlay, err := profileOverlay(saved)
	if err != nil {
		t.Fatalf("profileOverlay: %v", err)
	}
	if overlay != m.genConfigYAML() {
		t.Errorf("the replayed overlay differs from the one the dials rendered:\n%s\n---\n%s",
			overlay, m.genConfigYAML())
	}
	for _, want := range []string{"modelRoles:\n", "  default: deepseek/", "defaultThinkingLevel: high\n"} {
		if !strings.Contains(overlay, want) {
			t.Errorf("overlay lacks %q:\n%s", want, overlay)
		}
	}
	// Replaying an explicitly confirmed audit profile keeps task advising,
	// just like the same dials at an interactive launch.
	if !strings.Contains(overlay, "  agentAdvisor:\n    task: \"on\"\n") {
		t.Errorf("audit profile lost its task advisor:\n%s", overlay)
	}
	checkNativeAgentRouting(t, overlay)

	t.Run("a combination the catalog no longer generates", func(t *testing.T) {
		stale := saved
		stale.Selection = map[string]string{
			"lane": "ds-led", "model": "smart", "thinking": "telepathic",
			"spark": "off", "advisor": "off",
		}
		if _, err := profileOverlay(stale); err == nil {
			t.Error("profileOverlay rendered an overlay for a combination the catalog does not carry")
		}
	})

	t.Run("a profile with no selection", func(t *testing.T) {
		if _, err := profileOverlay(codeProfile{ID: "code", Revision: 1}); err == nil {
			t.Error("profileOverlay rendered an overlay from nothing")
		}
	})
}

// TestEngineTakesNoDialsFromTheEnvironment is the deletion, asserted. The
// launch-side dial model used to seed itself from the persisted selection,
// which made CODE_SELECTION_STATE — a variable any process in the tree can set
// — a channel into what a run launches. Nothing reads it now: the only dials
// this process may act on are the ones a stored profile carries.
func TestEngineTakesNoDialsFromTheEnvironment(t *testing.T) {
	isolateEngineEnv(t)
	t.Setenv("CODE_GENERATED", engineCatalogFixture(t))

	planted := `{"lane":"claude-led","model":"fast","thinking":"low","advisor":"off"}`
	writeSelectionFixture(t, defaultSelectionStatePath(), planted)
	override := filepath.Join(t.TempDir(), "selection.json")
	writeSelectionFixture(t, override, planted)
	t.Setenv(codeSelectionStateEnv, override)

	m := engineCatalogModel()
	defaults := defaultSel()
	for _, key := range []string{"lane", "model", "thinking", "advisor"} {
		if m.sel[key] != defaults[key] {
			t.Errorf("dial %s = %q, want the compiled default %q: a planted selection reached "+
				"the engine's dial model", key, m.sel[key], defaults[key])
		}
	}
	if !strings.Contains(planted, `"lane":"claude-led"`) || defaults["lane"] == "claude-led" {
		t.Fatal("the planted selection matches the defaults, so this test could not fail")
	}

	stored := mintedProfile(t, "code", map[string]string{"lane": "ds-led", "thinking": "high"})
	overlay, err := profileOverlay(stored)
	if err != nil {
		t.Fatalf("profileOverlay: %v", err)
	}
	if !strings.Contains(overlay, "defaultThinkingLevel: high\n") {
		t.Errorf("the replayed overlay lost the profile's own dials:\n%s", overlay)
	}
}

// TestDescribeDialsAsConfirmed pins what a minted profile records: the dials
// as they stand in the model that was on screen, and the provider and
// combination they resolve to. A report that said anything else would
// describe a run that never happened.
func TestDescribeDialsAsConfirmed(t *testing.T) {
	isolateEngineEnv(t)
	t.Setenv("CODE_GENERATED", engineCatalogFixture(t))

	m := turnedDials(t, map[string]string{"lane": "claude-led", "model": "fast", "thinking": "low"})
	profile := describeDials(m, "code")
	for _, key := range []string{"lane", "thinking"} {
		if profile.Metadata[key] != m.sel[key] {
			t.Errorf("metadata reports %s = %q, want the confirmed %q",
				key, profile.Metadata[key], m.sel[key])
		}
	}
	if got := profile.Metadata["provider"]; got == "openai-codex" || got == "unresolved" {
		t.Errorf("metadata provider = %q, want the Anthropic-led lane's provider", got)
	}
	if got := profile.Metadata["combo"]; !strings.HasPrefix(got, "claude-led_fast_low_") {
		t.Errorf("metadata combo = %q, want the cheapest Anthropic-led combo", got)
	}
	if profile.ComboID != comboID(m.sel) {
		t.Errorf("combo id = %q, want the confirmed selection's own %q",
			profile.ComboID, comboID(m.sel))
	}
	if names := secretShapedMetadata(profile.Metadata); len(names) > 0 {
		t.Errorf("described dials declare credential-shaped keys %v", names)
	}

	// With no catalog at all the dials still describe something honest: a
	// provider and model that say they are unresolved rather than a guess.
	isolateEngineEnv(t)
	bare := describeDials(turnedDials(t, nil), "code")
	if bare.Metadata["provider"] == "" || bare.Metadata["model"] == "" {
		t.Errorf("metadata leaves provider or model unnamed: %v", bare.Metadata)
	}
}
