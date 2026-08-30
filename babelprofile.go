package main

// Profile persistence for the Babel boundary.
//
// Babel records a profile reference — an id and a revision — and nothing else
// about how Code routes work (babelwire.go). For that reference to be worth
// recording, Code has to be able to hand back the same resolved dials months
// later when a reviewer asks what produced a finding. Code otherwise persists
// only the live facet selection (selection_state.go), which is deliberately
// mutable and unversioned: it is the dial position, not a record.
//
// So a profile revision is written once and never rewritten. Each revision is
// its own file, created with O_EXCL through a hard link, so "immutable" is a
// filesystem property rather than a promise this code makes about itself. A
// save whose content matches the current revision returns that revision
// unchanged: re-running configure with the same dials must not inflate the
// history Babel is holding references into.
//
// Nothing secret is stored. The provider credential lives in the central
// broker and the vault (vault.go) and is never part of a profile, and a save
// that offers credential-shaped metadata is refused rather than filtered —
// Babel refuses such a key outright, so quietly dropping it here would hide a
// misunderstanding from whoever has to fix it.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// babelProfileStateEnv overrides where profiles live, mirroring how every other
// piece of Code state can be relocated (CODE_SESSION_STATE, CODE_WORKTREE_STATE).
// Unlike CODE_SELECTION_STATE an empty value is not an opt-out: Babel cannot
// record a reference to a profile that was never written, so configure mode has
// to produce a durable one.
const babelProfileStateEnv = "CODE_BABEL_PROFILE_STATE"

// defaultBabelProfileID is the profile configure mode writes when no --profile
// is given. One stable id per installation is what makes the revision counter
// meaningful: successive dial changes accumulate as revisions of the same
// profile rather than scattering into unrelated ids.
const defaultBabelProfileID = "code"

func defaultBabelProfileDir() string {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "state")
	}
	return filepath.Join(base, "code", "babel", "profiles")
}

func babelProfileDir() string {
	if v := os.Getenv(babelProfileStateEnv); v != "" {
		return v
	}
	return defaultBabelProfileDir()
}

// codeProfile is one saved revision: the dials Code resolved, plus the
// non-secret facts Babel records beside its reference. Selection is the facet
// map the TUI and the generator both speak, so a revision can be replayed
// through the same code path that produced it.
type codeProfile struct {
	ID                string            `json:"id"`
	Revision          int               `json:"revision"`
	Selection         map[string]string `json:"selection"`
	ComboID           string            `json:"combo_id"`
	Disclosure        string            `json:"disclosure"`
	RedactionRequired bool              `json:"redaction_required"`
	Cost              babelCost         `json:"cost"`
	Metadata          map[string]string `json:"metadata"`
	Saved             int64             `json:"saved"`
}

// ref is the reference Babel persists for this revision.
func (p codeProfile) ref() babelProfileRef {
	return babelProfileRef{ID: p.ID, Revision: p.Revision}
}

// privacy is the disclosure the profile declares. A profile that never resolved
// a runtime reads as hosted: material leaving for a provider API is the
// default, and rounding an unknown down to "local" would understate it.
func (p codeProfile) privacy() babelPrivacy {
	disclosure := p.Disclosure
	if disclosure != babelDisclosureLocal {
		disclosure = babelDisclosureHosted
	}
	return babelPrivacy{Disclosure: disclosure, RedactionRequired: p.RedactionRequired}
}

// configuration renders the profile as the event Babel records. Capabilities
// are the run's, not the profile's, so they are the caller's to supply.
func (p codeProfile) configuration(capabilities []string) babelConfiguration {
	metadata := make(map[string]string, len(p.Metadata))
	for k, v := range p.Metadata {
		metadata[k] = v
	}
	if capabilities == nil {
		capabilities = []string{}
	}
	return babelConfiguration{
		Type:         babelMessageConfiguration,
		Profile:      p.ref(),
		Privacy:      p.privacy(),
		Cost:         p.Cost,
		Capabilities: capabilities,
		Metadata:     metadata,
	}
}

// identity is the content a revision is defined by: everything except the
// revision number and the timestamp, which are bookkeeping rather than
// configuration. Two saves with equal identity are the same profile revision,
// so re-running configure without touching a dial is a no-op.
func (p codeProfile) identity() []byte {
	// json.Marshal sorts map keys, so this encoding is canonical for equal
	// content regardless of how the maps were built.
	canonical := struct {
		ID                string            `json:"id"`
		Selection         map[string]string `json:"selection"`
		ComboID           string            `json:"combo_id"`
		Disclosure        string            `json:"disclosure"`
		RedactionRequired bool              `json:"redaction_required"`
		Cost              babelCost         `json:"cost"`
		Metadata          map[string]string `json:"metadata"`
	}{p.ID, p.Selection, p.ComboID, p.Disclosure, p.RedactionRequired, p.Cost, p.Metadata}
	data, err := json.Marshal(canonical)
	if err != nil {
		// Every field is a string, bool, float64 or map of strings; a marshal
		// failure here would mean the struct above changed shape, and a digest
		// that silently collides would defeat the immutability rule.
		panic("code: profile identity is not encodable: " + err.Error())
	}
	sum := sha256.Sum256(data)
	return sum[:]
}

// babelSecretKeyMarkers are the substrings that make a metadata key credential
// shaped. Code has no such predicate of its own — vault.go keeps credentials
// out of artifacts by never putting them in a serializable field (account.apiKey
// is unexported for exactly that reason) — so this list mirrors the one Babel
// refuses on. Substrings rather than exact names: the rule must not be defeated
// by naming a key "openai_api_key_value".
var babelSecretKeyMarkers = []string{
	"api_key", "apikey", "authorization", "bearer", "credential",
	"passwd", "password", "private_key", "secret", "token",
}

// secretShapedMetadata names every credential-shaped key in metadata, sorted so
// the diagnostic is stable and lists the whole problem at once.
func secretShapedMetadata(metadata map[string]string) []string {
	var names []string
	for name := range metadata {
		lower := strings.ToLower(name)
		for _, marker := range babelSecretKeyMarkers {
			if strings.Contains(lower, marker) {
				names = append(names, name)
				break
			}
		}
	}
	sort.Strings(names)
	return names
}

// errProfileSecretDeclared reports metadata that declares a credential. It is a
// distinct error because it is a programming mistake in Code, not a filesystem
// or configuration problem an operator can retry past.
var errProfileSecretDeclared = errors.New("profile metadata declares a credential")

// profileStore is the on-disk profile history rooted at one directory. It holds
// no state beyond that path: every operation takes the lock, reads what is
// there, and releases it, so two `code babel` processes saving at once are
// serialized by the kernel rather than by their own good timing.
type profileStore struct{ dir string }

func newProfileStore(dir string) *profileStore {
	if dir == "" {
		dir = babelProfileDir()
	}
	return &profileStore{dir: dir}
}

// validProfileID rejects ids that are not safe as a single path element. The id
// comes from a flag and from Babel's job, so an id of "../../etc" must not be
// able to steer a write out of the store.
func validProfileID(id string) error {
	if id == "" {
		return errors.New("profile id is empty")
	}
	if len(id) > 128 {
		return fmt.Errorf("profile id is too long (%d bytes)", len(id))
	}
	if id != filepath.Base(id) || id == "." || id == ".." || strings.ContainsAny(id, `/\`) {
		return fmt.Errorf("profile id %q is not a single path element", id)
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.':
		default:
			return fmt.Errorf("profile id %q contains %q", id, r)
		}
	}
	return nil
}

// revisionFile names one revision. Zero padding keeps the directory listing in
// numeric order, which makes the history readable without a tool.
func revisionFile(revision int) string { return fmt.Sprintf("%08d.json", revision) }

func parseRevisionFile(name string) (int, bool) {
	base, ok := strings.CutSuffix(name, ".json")
	if !ok {
		return 0, false
	}
	revision, err := strconv.Atoi(base)
	if err != nil || revision < 1 {
		return 0, false
	}
	return revision, true
}

// lock takes the store's exclusive lock for one profile id. Concurrent saves
// must not interleave into a corrupt history or land on the same revision
// number, and the flock is what guarantees it: the kernel releases it however
// the holder dies, so a crashed save cannot wedge the store. This is the same
// liveness primitive the session registry relies on (session.go).
func (s *profileStore) lock(id string) (*os.File, error) {
	dir := filepath.Join(s.dir, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// unlockProfile releases a lock taken by profileStore.lock. Unlocking before
// closing is redundant — the kernel drops the flock with the descriptor — but it
// keeps the release visible at the call site rather than implied by a Close.
func unlockProfile(f *os.File) {
	syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	f.Close()
}

// latestRevision reports the highest revision written for id, or 0 when the
// profile has no history yet. The caller holds the lock.
func (s *profileStore) latestRevision(id string) (int, error) {
	entries, err := os.ReadDir(filepath.Join(s.dir, id))
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	latest := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if revision, ok := parseRevisionFile(e.Name()); ok && revision > latest {
			latest = revision
		}
	}
	return latest, nil
}

// load reads one revision. Revision 0 means the latest, which is what a job
// naming a profile without pinning a revision asks for.
func (s *profileStore) load(id string, revision int) (codeProfile, error) {
	if err := validProfileID(id); err != nil {
		return codeProfile{}, err
	}
	if revision < 0 {
		return codeProfile{}, fmt.Errorf("profile %s: revision %d is negative", id, revision)
	}
	if revision == 0 {
		latest, err := s.latestRevision(id)
		if err != nil {
			return codeProfile{}, err
		}
		if latest == 0 {
			return codeProfile{}, fmt.Errorf("profile %s has no saved revision", id)
		}
		revision = latest
	}
	data, err := os.ReadFile(filepath.Join(s.dir, id, revisionFile(revision)))
	if err != nil {
		return codeProfile{}, err
	}
	var p codeProfile
	if err := json.Unmarshal(data, &p); err != nil {
		return codeProfile{}, fmt.Errorf("profile %s@%d: %w", id, revision, err)
	}
	// A file whose contents disagree with its own name is corrupt rather than
	// old: the reference Babel holds would then point at something else.
	if p.ID != id || p.Revision != revision {
		return codeProfile{}, fmt.Errorf("profile %s@%d claims to be %s@%d", id, revision, p.ID, p.Revision)
	}
	return p, nil
}

// save records p as a new revision, or returns the current revision unchanged
// when its content is identical. Revision and Saved on the argument are ignored:
// the store owns them, because a caller that could choose a revision number
// could overwrite a reference Babel already recorded.
func (s *profileStore) save(p codeProfile) (codeProfile, error) {
	if err := validProfileID(p.ID); err != nil {
		return codeProfile{}, err
	}
	if names := secretShapedMetadata(p.Metadata); len(names) > 0 {
		return codeProfile{}, fmt.Errorf("%w: metadata key(s) %s", errProfileSecretDeclared, strings.Join(names, ", "))
	}
	lock, err := s.lock(p.ID)
	if err != nil {
		return codeProfile{}, err
	}
	defer unlockProfile(lock)

	latest, err := s.latestRevision(p.ID)
	if err != nil {
		return codeProfile{}, err
	}
	if latest > 0 {
		current, err := s.load(p.ID, latest)
		if err != nil {
			return codeProfile{}, err
		}
		candidate := p
		candidate.Revision, candidate.Saved = current.Revision, current.Saved
		if string(candidate.identity()) == string(current.identity()) {
			return current, nil
		}
	}
	p.Revision = latest + 1
	p.Saved = time.Now().Unix()
	if err := s.writeRevision(p); err != nil {
		return codeProfile{}, err
	}
	return p, nil
}

// writeRevision commits one revision. The record is written to a temporary file
// and hard-linked into place, so the revision either appears whole or not at
// all, and linking (rather than renaming) fails loudly instead of overwriting a
// revision that somehow already exists.
func (s *profileStore) writeRevision(p codeProfile) error {
	dir := filepath.Join(s.dir, p.ID)
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".code-babel-profile-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Link(tmpPath, filepath.Join(dir, revisionFile(p.Revision))); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	if err := d.Sync(); err != nil && !errors.Is(err, os.ErrInvalid) {
		return err
	}
	return nil
}

// digest renders an identity for diagnostics. It is short because it identifies
// a revision in a log line, not a cryptographic commitment.
func (p codeProfile) digest() string { return hex.EncodeToString(p.identity())[:12] }
