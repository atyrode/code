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
		Disclosure:        babelDisclosureHosted,
		RedactionRequired: true,
		Cost:              babelCost{Currency: "USD", InputPer1K: 0.003, OutputPer1K: 0.015},
		Metadata:          map[string]string{"provider": "anthropic", "model": "sonnet", "thinking": "medium"},
	}
}

// TestProfileStoreRevisionIdentity is the store's central rule: a revision is
// what its content says it is. Re-saving identical content must not inflate the
// history Babel holds references into, changed content must produce a new
// revision, and a revision already handed to Babel must never change underneath
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
		t.Errorf("identical content bumped the revision to %d; a reference Babel holds would be stale for no reason", again.Revision)
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

	// The reference Babel recorded for revision 1 still resolves to what it
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

	// A cost change alone is a content change: Babel records the estimate.
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

// TestProfileStoreRefusesCredentialMetadata checks the boundary Babel enforces
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
// of the store. The id arrives from a flag and from Babel's job, so it is
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
	t.Setenv(babelProfileStateEnv, "")
	if got, want := babelProfileDir(), filepath.Join(state, "code", "babel", "profiles"); got != want {
		t.Errorf("babelProfileDir() = %q, want %q", got, want)
	}
	override := filepath.Join(t.TempDir(), "elsewhere")
	t.Setenv(babelProfileStateEnv, override)
	if got := babelProfileDir(); got != override {
		t.Errorf("babelProfileDir() = %q, want the override %q", got, override)
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
// reference Babel holds points at something else, which is corruption rather
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
