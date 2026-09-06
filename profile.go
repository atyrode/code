package main

// Profile persistence for the engine boundary.
//
// A client that launches `code engine` records a profile reference — an id
// and a revision — and nothing else about how Code routes work. For that
// reference to be worth recording, Code has to be able to hand back the same
// resolved dials months later when a reviewer asks what produced a result.
// Code otherwise persists only the live facet selection (selection_state.go),
// which is deliberately mutable and unversioned: it is the dial position, not
// a record.
//
// So a profile revision is written once and never rewritten. Each revision is
// its own file, created with O_EXCL through a hard link, so "immutable" is a
// filesystem property rather than a promise this code makes about itself. A
// save whose content matches the current revision returns that revision
// unchanged: re-running configure with the same dials must not inflate the
// history a client is holding references into.
//
// Nothing secret is stored. The provider credential lives in the central
// broker and the vault (vault.go) and is never part of a profile, and a save
// that offers credential-shaped metadata is refused rather than filtered —
// a reviewer reading the metadata off a runtime report must be able to trust
// that no key in it could ever have held one.

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

// profileStateEnv overrides where profiles live, mirroring how every other
// piece of Code state can be relocated (CODE_SESSION_STATE, CODE_WORKTREE_STATE).
// Unlike CODE_SELECTION_STATE an empty value is not an opt-out: a client cannot
// record a reference to a profile that was never written, so the ceremony has
// to produce a durable one.
const profileStateEnv = "CODE_PROFILE_STATE"

// defaultProfileID is the profile the ceremony writes when no --profile is
// given. One stable id per installation is what makes the revision counter
// meaningful: successive dial changes accumulate as revisions of the same
// profile rather than scattering into unrelated ids.
const defaultProfileID = "code"

func defaultProfileDir() string {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "state")
	}
	return filepath.Join(base, "code", "profiles")
}

func profileDir() string {
	if v := os.Getenv(profileStateEnv); v != "" {
		return v
	}
	return defaultProfileDir()
}

// profileRef identifies one saved profile revision. A client persists this
// reference and the non-secret metadata beside it, never the provider
// configuration behind it.
type profileRef struct {
	ID       string `json:"id"`
	Revision int    `json:"revision"`
}

// parseProfileRef reads ID or ID@REVISION as a flag spells it. A bare id asks
// for the latest revision, which is what revision 0 means to the store.
func parseProfileRef(arg string) (profileRef, error) {
	id, revision, pinned := strings.Cut(arg, "@")
	ref := profileRef{ID: id}
	if err := validProfileID(id); err != nil {
		return profileRef{}, err
	}
	if !pinned {
		return ref, nil
	}
	n, err := strconv.Atoi(revision)
	if err != nil || n < 1 {
		return profileRef{}, fmt.Errorf("profile %q: revision %q is not a positive integer", id, revision)
	}
	ref.Revision = n
	return ref, nil
}

// String renders the reference the way a flag and a diagnostic spell it.
func (r profileRef) String() string {
	if r.Revision <= 0 {
		return r.ID
	}
	return r.ID + "@" + strconv.Itoa(r.Revision)
}

// Disclosure classes. A hosted profile sends material to a provider API off
// this machine; a local one keeps it here. The class is a property of the
// profile, fixed when it is minted, so a client learns it before it discloses
// anything.
const (
	disclosureLocal  = "local"
	disclosureHosted = "hosted"
)

// profilePrivacy is the profile's disclosure class and whether material must
// be redacted before it reaches the model. Redaction is required exactly when
// the profile is hosted: a local profile discloses nothing off the machine, so
// requiring redaction of it would be ceremony.
type profilePrivacy struct {
	Disclosure        string `json:"disclosure"`
	RedactionRequired bool   `json:"redaction_required"`
}

// profileCost is the profile's own non-secret cost estimate, never a
// measurement. A client records it to support cost guards.
type profileCost struct {
	Currency     string  `json:"currency"`
	InputPer1K   float64 `json:"input_per_1k"`
	OutputPer1K  float64 `json:"output_per_1k"`
	EstimatedRun float64 `json:"estimated_run"`
}

// codeProfile is one saved revision: the dials Code resolved, plus the
// non-secret facts a client records beside its reference. Selection is the
// facet map the TUI and the generator both speak, so a revision can be
// replayed through the same code path that produced it.
type codeProfile struct {
	ID                string            `json:"id"`
	Revision          int               `json:"revision"`
	Selection         map[string]string `json:"selection"`
	ComboID           string            `json:"combo_id"`
	Disclosure        string            `json:"disclosure"`
	RedactionRequired bool              `json:"redaction_required"`
	Cost              profileCost       `json:"cost"`
	Metadata          map[string]string `json:"metadata"`
	Saved             int64             `json:"saved"`
}

// ref is the reference a client persists for this revision.
func (p codeProfile) ref() profileRef {
	return profileRef{ID: p.ID, Revision: p.Revision}
}

// privacy is the disclosure the profile declares. A profile that never resolved
// a runtime reads as hosted: material leaving for a provider API is the
// default, and rounding an unknown down to "local" would understate it.
func (p codeProfile) privacy() profilePrivacy {
	disclosure := p.Disclosure
	if disclosure != disclosureLocal {
		disclosure = disclosureHosted
	}
	return profilePrivacy{Disclosure: disclosure, RedactionRequired: p.RedactionRequired}
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
		Cost              profileCost       `json:"cost"`
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

// secretKeyMarkers are the substrings that make a metadata key credential
// shaped. Code has no such predicate of its own — vault.go keeps credentials
// out of artifacts by never putting them in a serializable field (account.apiKey
// is unexported for exactly that reason) — so this list is the one a reviewer
// can read a runtime report against. Substrings rather than exact names: the
// rule must not be defeated by naming a key "openai_api_key_value".
var secretKeyMarkers = []string{
	"api_key", "apikey", "authorization", "bearer", "credential",
	"passwd", "password", "private_key", "secret", "token",
}

// secretShapedMetadata names every credential-shaped key in metadata, sorted so
// the diagnostic is stable and lists the whole problem at once.
func secretShapedMetadata(metadata map[string]string) []string {
	var names []string
	for name := range metadata {
		lower := strings.ToLower(name)
		for _, marker := range secretKeyMarkers {
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
// there, and releases it, so two `code engine` processes saving at once are
// serialized by the kernel rather than by their own good timing.
type profileStore struct{ dir string }

func newProfileStore(dir string) *profileStore {
	if dir == "" {
		dir = profileDir()
	}
	return &profileStore{dir: dir}
}

// validProfileID rejects ids that are not safe as a single path element. The id
// comes from a flag, so an id of "../../etc" must not be able to steer a write
// out of the store.
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

// load reads one revision. Revision 0 means the latest, which is what a launch
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
	return decodeProfileRevision(data, id, revision)
}

// decodeProfileRevision reads one revision file and checks it against its own
// name. A file whose contents disagree with where it sits is corrupt rather
// than old: the reference a client holds would then point at something else.
func decodeProfileRevision(data []byte, id string, revision int) (codeProfile, error) {
	var p codeProfile
	if err := json.Unmarshal(data, &p); err != nil {
		return codeProfile{}, fmt.Errorf("profile %s@%d: %w", id, revision, err)
	}
	if p.ID != id || p.Revision != revision {
		return codeProfile{}, fmt.Errorf("profile %s@%d claims to be %s@%d", id, revision, p.ID, p.Revision)
	}
	return p, nil
}

// save records p as a new revision, or returns the current revision unchanged
// when its content is identical. Revision and Saved on the argument are ignored:
// the store owns them, because a caller that could choose a revision number
// could overwrite a reference a client already recorded.
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
	if err := s.writeRevision(p, nil); err != nil {
		return codeProfile{}, err
	}
	return p, nil
}

// writeRevision commits one revision. The record is written to a temporary file
// and hard-linked into place, so the revision either appears whole or not at
// all, and linking (rather than renaming) fails loudly instead of overwriting a
// revision that somehow already exists.
//
// data, when given, is written verbatim instead of a fresh encoding of p. An
// import copies the bytes it was handed rather than re-encoding them, so a
// revision that crosses stores keeps the digest a reviewer computed over it.
func (s *profileStore) writeRevision(p codeProfile, data []byte) error {
	dir := filepath.Join(s.dir, p.ID)
	if data == nil {
		encoded, err := json.Marshal(p)
		if err != nil {
			return err
		}
		data = append(encoded, '\n')
	}
	tmp, err := os.CreateTemp(dir, ".code-profile-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
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

// importFrom copies every revision found under dir — laid out as this store
// lays its own out, one directory per id holding NNNNNNNN.json files — into
// this store, and reports how many were written.
//
// It exists for one reason: a client that recorded references into a profile
// directory at some earlier path has to be able to carry that history to the
// store `code engine` reads, with every revision number intact, because the
// references it holds are those numbers. So this is a copy rather than a
// re-save: the bytes land verbatim, a revision already present with the same
// content is skipped, and a revision already present with different content
// is refused outright, since silently keeping either copy would let two
// stores disagree about what a reference means. Nothing here knows any
// particular old path; the operator names the directory.
func (s *profileStore) importFrom(dir string) (int, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0, err
	}
	imported := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		id := entry.Name()
		if err := validProfileID(id); err != nil {
			return imported, fmt.Errorf("%s: %w", filepath.Join(dir, id), err)
		}
		n, err := s.importProfile(filepath.Join(dir, id), id)
		imported += n
		if err != nil {
			return imported, err
		}
	}
	return imported, nil
}

func (s *profileStore) importProfile(from, id string) (int, error) {
	entries, err := os.ReadDir(from)
	if err != nil {
		return 0, err
	}
	lock, err := s.lock(id)
	if err != nil {
		return 0, err
	}
	defer unlockProfile(lock)

	imported := 0
	for _, entry := range entries {
		revision, ok := parseRevisionFile(entry.Name())
		if !ok || entry.IsDir() {
			continue
		}
		source := filepath.Join(from, entry.Name())
		data, err := os.ReadFile(source)
		if err != nil {
			return imported, err
		}
		p, err := decodeProfileRevision(data, id, revision)
		if err != nil {
			return imported, fmt.Errorf("%s: %w", source, err)
		}
		if names := secretShapedMetadata(p.Metadata); len(names) > 0 {
			return imported, fmt.Errorf("%s: %w: metadata key(s) %s", source, errProfileSecretDeclared, strings.Join(names, ", "))
		}
		existing, err := os.ReadFile(filepath.Join(s.dir, id, revisionFile(revision)))
		switch {
		case err == nil:
			current, err := decodeProfileRevision(existing, id, revision)
			if err != nil {
				return imported, err
			}
			if string(current.identity()) == string(p.identity()) {
				continue
			}
			return imported, fmt.Errorf("profile %s@%d already exists in %s with different content; "+
				"a reference to it would mean two different configurations, so nothing was imported for it",
				id, revision, s.dir)
		case os.IsNotExist(err):
		default:
			return imported, err
		}
		if err := s.writeRevision(p, data); err != nil {
			return imported, err
		}
		imported++
	}
	return imported, nil
}

// digest renders an identity for diagnostics. It is short because it identifies
// a revision in a log line, not a cryptographic commitment.
func (p codeProfile) digest() string { return hex.EncodeToString(p.identity())[:12] }

// ── describing the dials as a profile ────────────────────────────────────────

// engineCatalogModel builds the dial model from Code's own state — the catalog
// and the runtime targets — with none of the TUI's transient fields, and with
// no dial position of its own. A stored profile is replayed against it, so a
// profile is rendered months later by the same construction that produced it.
//
// The selection it starts with is Code's compiled default, and it is there only
// so applyCatalog has a map to clamp: the one caller replaces it wholesale with
// the selection the stored profile carries. Reading the persisted position here
// — let alone CODE_SELECTION_STATE — would mean a dial nobody confirmed could
// decide what a launch runs. A dial this process may act on comes from a
// profile an operator minted, and there is no other source.
//
// providersResolved stays false: credential discovery is a live probe the TUI
// runs against OMP, and an engine launch must not silently move a dial because
// a credential happened to be missing at that instant. The catalog's own
// clamping still applies.
func engineCatalogModel() model {
	glyphs := resolveGlyphs()
	catalogPath := os.Getenv("CODE_GENERATED")
	if catalogPath == "" {
		catalogPath = defaultCatalogPath()
	}
	generated := loadBlocks(catalogPath)
	runtimeTargets := loadRuntimeTargets()
	facets := facetDefs(glyphs)
	if len(runtimeTargets) > 0 {
		facets = append([]facet{runtimeFacet(glyphs["runtime"], runtimeTargets)}, facets...)
	}
	m := model{
		generated:      generated,
		advisors:       parseAdvisors(generated["__advisors__"]),
		facts:          parseFacts(generated["__models__"]),
		glyphs:         glyphs,
		runtimeTargets: runtimeTargets,
		facets:         facets,
		sel:            defaultSel(),
	}
	m.applyCatalog()
	return m
}

// describeDials turns a resolved selection into the profile a client records.
// Everything here is non-secret by construction: the provider credential lives
// in the central broker and the vault and is never part of a selection.
//
// The local lane is described elsewhere (locallane.go) because it shares none
// of this: it resolves no catalog rows, so there is no lead model to find and
// no per-model price to weight, and the fields it does record — the endpoint,
// the engine — mean nothing to a hosted profile.
func describeDials(m model, id string) codeProfile {
	if chosen, on := m.selectedLocalModel(); on {
		return describeLocalDials(m, id, chosen)
	}
	rows := m.currentRows()
	metadata := map[string]string{
		"lane":     m.sel["lane"],
		"tier":     m.sel["model"],
		"thinking": m.sel["thinking"],
		"advisor":  m.sel["advisor"],
		"combo":    comboID(m.sel),
	}
	disclosure := disclosureHosted
	if target, ok := m.selectedRuntime(); ok {
		// A delegated local runtime keeps material on this machine, which is a
		// different disclosure class than a provider API.
		disclosure = disclosureLocal
		metadata["runtime"] = target.Name
		metadata["provider"] = target.Name
		metadata["model"] = target.Name
	}
	if lead := leadModel(m, rows); lead != "" {
		metadata["model"] = lead
		if pool := m.poolOfModel(lead); pool != "" {
			if provider := providerByPool(pool); provider != nil {
				metadata["provider"] = provider.ID
			}
		}
	}
	if metadata["provider"] == "" {
		// An empty catalog resolves dials but no chain, so there is no provider
		// to name. Saying so is honest; guessing one would not be.
		metadata["provider"] = "unresolved"
	}
	if metadata["model"] == "" {
		metadata["model"] = "unresolved"
	}
	return codeProfile{
		ID:         id,
		Selection:  m.sel,
		ComboID:    comboID(m.sel),
		Disclosure: disclosure,
		// Material that leaves this machine for a provider API has to be
		// redacted before it goes; material a local runtime handles does not.
		RedactionRequired: disclosure == disclosureHosted,
		Cost:              dialCost(m, rows),
		Metadata:          metadata,
	}
}

// leadModel names the model the default agent role runs, which is the one a
// runtime report means by "the model this profile uses".
func leadModel(m model, rows []string) string {
	lead := ""
	m.weightedModels(rows, func(_ float64, id, _ string) {
		if lead == "" {
			lead = id
		}
	})
	for _, row := range rows {
		fields := strings.Fields(strings.ReplaceAll(row, "→", " "))
		if len(fields) > 0 && fields[0] == "●" {
			fields = fields[1:]
		}
		if len(fields) == 0 || fields[0] != "default" {
			continue
		}
		for _, token := range fields[1:] {
			if modelRe.MatchString(token) {
				id, _, _ := strings.Cut(token, ":")
				return id
			}
		}
	}
	return lead
}

// dialCost is the profile's own cost estimate, not a measurement: the
// catalog's per-model prices ($/1M tokens) weighted by the token volume each
// role drives, which is the same basis the cost meter reads. EstimatedRun stays
// zero because a run's size is a property of the job, which a profile cannot
// know — and a client treats the estimate as the profile's claim, so inventing
// one would be a claim Code has no basis for.
func dialCost(m model, rows []string) profileCost {
	var inNum, outNum, den float64
	m.weightedModels(rows, func(weight float64, id, level string) {
		fact, ok := m.facts[id]
		if !ok {
			return
		}
		mult, ok := thinkMult[level]
		if !ok {
			mult = 1
		}
		inNum += weight * fact.in * mult
		outNum += weight * fact.out * mult
		den += weight
	})
	cost := profileCost{Currency: "USD"}
	if den == 0 {
		return cost
	}
	// The catalog prices per million tokens; the wire is per thousand.
	cost.InputPer1K = inNum / den / 1000
	cost.OutputPer1K = outNum / den / 1000
	return cost
}

// profileOverlay renders the omp config overlay a saved profile launches with —
// the same document the TUI's Enter key hands to omp, rebuilt from the stored
// selection rather than from whatever the dials happen to read now. The engine
// launch needs this and must not reconstruct it: the overlay is the profile,
// and two renderings of it would drift.
//
// A catalog that no longer generates the profile's combination is an error rather
// than an empty overlay. genConfigYAML would happily walk a missing block and
// emit a modelRoles map with no routing at all, handing omp a session that
// silently runs on its own defaults — the same trap update.go guards Enter
// against.
//
// A local profile is rendered from what it recorded rather than from the
// catalog, because the catalog never generated it: the endpoint's model, the
// engine it speaks and the thinking level are the whole configuration, and
// they are in the profile (locallane.go). Reading the environment for them
// instead would let a variable decide what a minted profile runs.
//
// The omp version is unknown here (nothing probes it in a launch), so the
// omp ≥ 17.3 advisor key is omitted. That is the safe direction by design: an
// older omp hard-errors on the unknown key, and a newer one simply does not get
// the audit-tier agent advisor.
func profileOverlay(p codeProfile) (string, error) {
	if isLocalProfile(p.Metadata) {
		target, err := localTargetOf(p.Metadata)
		if err != nil {
			return "", fmt.Errorf("profile %s@%d: %w", p.ID, p.Revision, err)
		}
		return target.overlayYAML(), nil
	}
	if len(p.Selection) == 0 {
		return "", fmt.Errorf("profile %s@%d saved no selection to render", p.ID, p.Revision)
	}
	m := engineCatalogModel()
	m.sel = make(map[string]string, len(p.Selection))
	for key, value := range p.Selection {
		m.sel[key] = value
	}
	combo := comboID(m.sel)
	if _, ok := m.generated[combo]; !ok {
		return "", fmt.Errorf("profile %s@%d selects combination %s, which this catalog does not generate",
			p.ID, p.Revision, combo)
	}
	return m.genConfigYAML(), nil
}

// ── the resolved profile a launch runs ──────────────────────────────────────

// resolvedProfile is one saved Code profile, opened for a launch. Everything
// in it is non-secret by contract: the provider credential reaches OMP through
// the auth broker, never through here.
type resolvedProfile struct {
	// Ref is the reference actually resolved, with the revision filled in.
	Ref profileRef
	// Disclosure is disclosureLocal or disclosureHosted.
	Disclosure string
	// Cost is the profile's own estimate, never a measurement.
	Cost profileCost
	// Metadata is the provider/model/thinking triple a client records, plus
	// whatever else the store considers non-secret.
	Metadata map[string]string
	// ConfigYAML is the OMP configuration overlay this profile launches with,
	// as genConfigYAML renders it.
	ConfigYAML string
}

// profileSource is the narrow view of the profile store a launch depends on.
// It is deliberately one method: the launch needs a resolved profile and
// nothing else about how profiles are stored, named, versioned or written, so
// the store can change shape without the launcher noticing.
type profileSource interface {
	// resolveProfile opens one saved profile. A revision of 0 asks for the
	// current one. A profile that does not exist must fail rather than be
	// invented: a client records what this returns.
	resolveProfile(id string, revision int) (resolvedProfile, error)
}

// profileStoreSource adapts the store to profileSource. The reference,
// disclosure, cost and metadata come from the profile's own rendering rather
// than being re-derived here, so there is one place that decides what a saved
// profile reports to a client.
type profileStoreSource struct{ store *profileStore }

func (s profileStoreSource) resolveProfile(id string, revision int) (resolvedProfile, error) {
	profile, err := s.store.load(id, revision)
	if err != nil {
		return resolvedProfile{}, err
	}
	overlay, err := profileOverlay(profile)
	if err != nil {
		return resolvedProfile{}, err
	}
	privacy := profile.privacy()
	return resolvedProfile{
		Ref:        profile.ref(),
		Disclosure: privacy.Disclosure,
		Cost:       profile.Cost,
		Metadata:   cloneMetadata(profile.Metadata),
		ConfigYAML: overlay,
	}, nil
}

func cloneMetadata(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
