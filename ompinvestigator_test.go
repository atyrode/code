package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

// testBrokerToken is the run-scoped credential these tests plant in every job.
// It is long and non-dictionary so a substring search over an argv, an
// environment or a payload cannot match it by coincidence.
const testBrokerToken = "BROKERTOKEN4f19c8d3a72b6e05f8341ca9"

// testProviderToken is the provider credential these tests resolve. It is
// distinct from testBrokerToken because the two are protected by different
// mechanisms and a test that confused them would prove neither.
const testProviderToken = "PROVIDERTOKEN0b7d41e5c93a2f68d150ba7c"

// testAuth is a resolved credential with no broker behind it: the driver only
// ever hands these values to the child, so a test needs the values and not a
// service.
func testAuth() ompAuth {
	return ompAuth{
		broker: brokerConfig{
			URL:           "http://127.0.0.1:1/auth",
			Token:         testProviderToken,
			SnapshotCache: "/nonexistent/snapshot-cache",
		},
		pool: map[string][]string{anthropicProvider: {"enabled-identity"}},
	}
}

// ── fixtures ─────────────────────────────────────────────────────────────────

// fakeProfiles is a profileSource with no store behind it: the investigator
// depends on the interface, so a test never needs the real one.
type fakeProfiles struct {
	profile resolvedProfile
	err     error
	askedID string
	askedAt int
}

func (f *fakeProfiles) resolveProfile(id string, revision int) (resolvedProfile, error) {
	f.askedID, f.askedAt = id, revision
	return f.profile, f.err
}

func testProfile() resolvedProfile {
	return resolvedProfile{
		Ref:        babelProfileRef{ID: "mixed-led", Revision: 4},
		Disclosure: babelDisclosureHosted,
		Cost:       babelCost{Currency: "USD", InputPer1K: 0.003, OutputPer1K: 0.015, EstimatedRun: 0.42},
		Metadata:   map[string]string{"provider": "anthropic", "model": "claude-opus-5", "thinking": "high"},
		ConfigYAML: "modelRoles:\n  default: anthropic/claude-opus-5\n",
	}
}

// testPublishedTools is the capability-to-tool mapping a current Babel puts in
// the grant, restricted to the capabilities the job grants. It mirrors Babel's
// omission rules exactly, because a test job that published more generously
// than Babel does would exercise a shape production never sees: a capability
// Babel brokers nothing for gets no key at all, and a grant where nothing is
// served gets no mapping at all rather than an empty object.
func testPublishedTools(capabilities ...string) map[string][]string {
	var tools map[string][]string
	for _, capability := range capabilities {
		if capability != babelCapabilityCorpusSearch {
			// corpus-search is the only facility Babel brokers today.
			continue
		}
		if tools == nil {
			tools = map[string][]string{}
		}
		tools[capability] = []string{"search"}
	}
	return tools
}

func testJob(directive string, capabilities ...string) babelJob {
	job := babelJob{
		Type:     babelMessageJob,
		Protocol: babelProtocolName,
		JobID:    "job-1",
		RunID:    "run-1",
		Profile:  babelProfileRef{ID: "mixed-led", Revision: 4},
		Recipes:  []babelRecipeRef{{ID: "outcome-integrity", Version: 1}},
		Grant: babelGrant{
			Capabilities: capabilities,
			Disclosure:   babelDisclosureLocal,
			Tools:        testPublishedTools(capabilities...),
		},
		Sources: []babelSource{{Kind: "session", Selector: "omp/synthetic-session"}},
		Broker:  &babelBroker{Endpoint: "http://127.0.0.1:1/evidence", Token: testBrokerToken},
	}
	if directive != "" {
		job.Params = map[string]string{babelParamConformance: directive}
	}
	return job
}

// testLegacyJob is the same job as it arrives from a Babel predating the
// published mapping: the grant carries no tools field at all. It is the only
// input that reaches Code's fallback, so every test of that path builds its job
// here rather than by mutating one.
func testLegacyJob(directive string, capabilities ...string) babelJob {
	job := testJob(directive, capabilities...)
	job.Grant.Tools = nil
	return job
}

// recorder collects everything the protocol layer would have written, so a test
// can assert on the stream the investigator produced rather than on its
// internals.
type recorder struct {
	stages   []string
	messages []string
	asks     []babelToolRequest
	decide   func(babelToolRequest) babelDecision
}

func (r *recorder) emit(stage, message string, _ float64) {
	r.stages = append(r.stages, stage)
	r.messages = append(r.messages, message)
}

func (r *recorder) request(capability, tool, reason string, arguments json.RawMessage) babelDecision {
	ask := babelToolRequest{
		Capability: capability,
		Tool:       tool,
		Reason:     reason,
		Arguments:  arguments,
		RequestID:  "req-" + string(rune('0'+len(r.asks))),
	}
	r.asks = append(r.asks, ask)
	if r.decide != nil {
		return r.decide(ask)
	}
	return babelDecision{Type: babelMessageToolDecision, RequestID: ask.RequestID, Decision: babelDecisionAllow}
}

func newTestInvestigator(t *testing.T) (*ompInvestigator, *fakeProfiles) {
	t.Helper()
	profiles := &fakeProfiles{profile: testProfile()}
	inv := newOmpInvestigator(profiles)
	inv.pace = time.Millisecond
	inv.slowBudget = 50 * time.Millisecond
	inv.lookOmp = func() (string, error) { return "", errors.New("no omp in this test") }
	inv.auth = func() (ompAuth, error) { return testAuth(), nil }
	// The driver tests are about the driver. They run a fake OMP that is a
	// shell script in a temporary directory — nothing a real boundary would
	// have any way to reach — so they take the launch path Code takes when no
	// backend came up. The boundary itself is exercised by the escape scenarios
	// in sandbox_linux_test.go, against the real thing, which is where a
	// containment claim has to be tested.
	inv.probe = noSandboxBackend
	// Every driver test goes through the credential gate the protocol layer
	// puts in front of a real run, so none of them can pass on a path
	// production does not take.
	if _, err := inv.resolveCredential(); err != nil {
		t.Fatalf("resolving the test credential: %v", err)
	}
	return inv, profiles
}

// noSandboxBackend is a backend that established nothing, which is exactly what
// Code declares on a machine where the boundary will not come up.
func noSandboxBackend(ceilings sandboxCeilings) *sandboxBackend {
	return &sandboxBackend{facts: sandboxFacts{
		backend:  sandboxBackendNone,
		ceilings: ceilings,
		degraded: []string{"this test replaced the backend, so nothing was contained"},
	}}
}

// ── containment ──────────────────────────────────────────────────────────────

// TestOmpContainmentDeclaresOnlyWhatTheBackendEstablished checks the direction
// that matters: a backend that established nothing must produce a declaration
// that claims nothing, and must still say what is therefore unprotected.
//
// The other direction — a backend that did come up, declaring four true
// properties — is not assertable from a stub, because the whole point is that
// the booleans come from a probe rather than from a value a test can hand in.
// It is asserted in sandbox_linux_test.go against the real backend, beside the
// scenarios that try to break each property.
func TestOmpContainmentDeclaresOnlyWhatTheBackendEstablished(t *testing.T) {
	inv := &ompInvestigator{probe: noSandboxBackend}
	got := inv.containment()
	if got.Backend == "" {
		t.Error("containment names no backend, and an unnamed mechanism cannot be assessed")
	}
	if got.FilesystemIsolation || got.NetworkDefaultDeny || got.ResourceCeilings || got.Disposable {
		t.Errorf("containment claims isolation the backend never established: %+v", got)
	}
	if got.Escape == "" {
		t.Fatal("containment declares no escape assumption, which the contract forbids")
	}
	// The escape text is the whole value of an all-false declaration: it has to
	// say what is not contained, and why Code could not contain it.
	for _, want := range []string{"no sandbox", "uid", "filesystem", "network", "replaced the backend"} {
		if !strings.Contains(got.Escape, want) {
			t.Errorf("escape statement never mentions %q: %s", want, got.Escape)
		}
	}
}

// TestOmpContainmentNamesTheEndpointItsEgressAllows is the other half of the
// declaration: whichever backend came up, the escape statement has to name the
// one target the boundary opens, because "restricted to the provider" is not
// something a reviewer can act on and a host and port is.
func TestOmpContainmentNamesTheEndpointItsEgressAllows(t *testing.T) {
	inv := &ompInvestigator{probe: noSandboxBackend}
	inv.profile = resolvedProfile{Metadata: map[string]string{"provider": anthropicProvider}}
	got := inv.egressDescription()
	if got.provider != anthropicProvider {
		t.Errorf("provider = %q, want %q", got.provider, anthropicProvider)
	}
	if len(got.allowed) == 0 || !strings.HasSuffix(got.allowed[0], ":443") {
		t.Fatalf("the egress description allows %v; a contained run reaches its provider on 443", got.allowed)
	}

	// A profile whose provider Code cannot place must not produce an allowlist
	// at all. An invented one would be a hole the declaration then describes.
	inv.profile = resolvedProfile{Metadata: map[string]string{"provider": "a-runtime-nobody-registered"}}
	if unknown := inv.egressDescription(); len(unknown.allowed) != 0 {
		t.Errorf("an unplaceable provider produced an allowlist: %v", unknown.allowed)
	}
}

// ── resolve ──────────────────────────────────────────────────────────────────

func TestOmpResolveIsResolveOrFail(t *testing.T) {
	for _, tc := range []struct {
		name    string
		profile resolvedProfile
		err     error
		wantErr bool
	}{
		{name: "resolved", profile: testProfile()},
		{name: "store failed", err: errors.New("no such profile"), wantErr: true},
		{
			name: "no revision",
			profile: resolvedProfile{
				Ref: babelProfileRef{ID: "mixed-led"}, Disclosure: babelDisclosureLocal,
				Metadata: map[string]string{"model": "x"},
			},
			wantErr: true,
		},
		{
			name: "unknown disclosure",
			profile: resolvedProfile{
				Ref: babelProfileRef{ID: "mixed-led", Revision: 1}, Disclosure: "private",
				Metadata: map[string]string{"model": "x"},
			},
			wantErr: true,
		},
		{
			name: "no metadata",
			profile: resolvedProfile{
				Ref: babelProfileRef{ID: "mixed-led", Revision: 1}, Disclosure: babelDisclosureLocal,
			},
			wantErr: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inv := newOmpInvestigator(&fakeProfiles{profile: tc.profile, err: tc.err})
			got, err := inv.resolve(context.Background(), babelProfileRef{ID: "mixed-led", Revision: 4})
			if tc.wantErr {
				if err == nil {
					t.Fatalf("resolve succeeded with %+v; want a failure", got)
				}
				if !errors.Is(err, errOmpProfileUnavailable) {
					t.Errorf("error = %v; want it to wrap errOmpProfileUnavailable so Babel gets a code", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolve: %v", err)
			}
			if got.Profile != tc.profile.Ref {
				t.Errorf("profile = %+v; want the reference actually resolved %+v", got.Profile, tc.profile.Ref)
			}
			if got.Privacy.Disclosure != babelDisclosureHosted || !got.Privacy.RedactionRequired {
				t.Errorf("privacy = %+v; a hosted profile requires redaction", got.Privacy)
			}
			if got.Cost != tc.profile.Cost {
				t.Errorf("cost = %+v; want %+v", got.Cost, tc.profile.Cost)
			}
			if got.Metadata["model"] != "claude-opus-5" {
				t.Errorf("metadata = %v; want the resolved provider metadata", got.Metadata)
			}
			if got.Containment != nil {
				t.Error("resolve attached containment; that belongs to the protocol layer in worker mode")
			}
		})
	}
}

func TestOmpResolveWithoutAStoreFails(t *testing.T) {
	inv := &ompInvestigator{}
	if _, err := inv.resolve(context.Background(), babelProfileRef{ID: "x", Revision: 1}); !errors.Is(err, errOmpProfileUnavailable) {
		t.Fatalf("error = %v; want errOmpProfileUnavailable", err)
	}
}

func TestOmpSyntheticConfigurationEchoesOnlyForConformance(t *testing.T) {
	// The protocol layer discovers the exception through a method set, so the
	// method has to exist under exactly this shape or the exception is silently
	// never offered and the suite's synthetic profile fails to resolve.
	var resolver interface {
		syntheticConfiguration(job babelJob) babelConfiguration
	} = (*ompInvestigator)(nil)

	job := testJob(babelConformanceWellBehaved, babelCapabilityCorpusSearch)
	job.Profile = babelProfileRef{ID: "synthetic-profile", Revision: 1}
	got := resolver.syntheticConfiguration(job)
	if got.Profile != job.Profile {
		t.Errorf("profile = %+v; the suite's synthetic reference must be echoed", got.Profile)
	}
	if len(got.Metadata) == 0 {
		t.Fatal("synthetic configuration carries no metadata; a receipt requires some")
	}
	if got.Metadata["provider"] != "none" {
		t.Errorf("metadata names provider %q; nothing was resolved, so naming one would be a claim",
			got.Metadata["provider"])
	}
}

// ── capability mapping ───────────────────────────────────────────────────────

func TestOmpToolsForResolvesBothNamesOutOfTheGrant(t *testing.T) {
	for _, tc := range []struct {
		name  string
		grant babelGrant
		// wantHost is the tools registered with OMP, by the name the model
		// calls. wantBabel is the name each one puts on the wire, in the same
		// order, which is the assertion that matters: it is the string Babel's
		// authorizer compares, and getting it wrong produced a whole
		// exploration with zero retrievals.
		wantHost  []string
		wantBabel []string
		// wantUnreachable is the granted capabilities that resolved to no tool
		// and so were never offered to the model.
		wantUnreachable []string
	}{
		{
			name:      "the published name is what goes on the wire",
			grant:     babelGrant{Capabilities: []string{babelCapabilityCorpusSearch}, Tools: map[string][]string{babelCapabilityCorpusSearch: {"search"}}},
			wantHost:  []string{"babel_corpus_search"},
			wantBabel: []string{"search"},
		},
		{
			name: "a granted capability the mapping names nothing for is not offered",
			grant: babelGrant{
				Capabilities: []string{babelCapabilityCorpusSearch, babelCapabilityRepoRead},
				Tools:        map[string][]string{babelCapabilityCorpusSearch: {"search"}},
			},
			wantHost:        []string{"babel_corpus_search"},
			wantBabel:       []string{"search"},
			wantUnreachable: []string{babelCapabilityRepoRead},
		},
		{
			name: "an empty array says the same as a missing key",
			grant: babelGrant{
				Capabilities: []string{babelCapabilityCorpusSearch},
				Tools:        map[string][]string{babelCapabilityCorpusSearch: {}},
			},
			wantHost:        []string{},
			wantBabel:       []string{},
			wantUnreachable: []string{babelCapabilityCorpusSearch},
		},
		{
			name: "a name Code implements is picked out of several published",
			grant: babelGrant{
				Capabilities: []string{babelCapabilityCorpusSearch},
				Tools:        map[string][]string{babelCapabilityCorpusSearch: {"semantic", "search", "neighbourhood"}},
			},
			wantHost:  []string{"babel_corpus_search"},
			wantBabel: []string{"search"},
		},
		{
			name: "published names Code implements none of leave the capability unreachable",
			grant: babelGrant{
				Capabilities: []string{babelCapabilityCorpusSearch},
				Tools:        map[string][]string{babelCapabilityCorpusSearch: {"semantic"}},
			},
			wantHost:        []string{},
			wantBabel:       []string{},
			wantUnreachable: []string{babelCapabilityCorpusSearch},
		},
		{
			name:      "no mapping at all falls back to the operation Code implements",
			grant:     babelGrant{Capabilities: []string{babelCapabilityCorpusSearch, babelCapabilityRepoRead}},
			wantHost:  []string{"babel_corpus_search"},
			wantBabel: []string{"search"},
			// repo-read has no operation name in either direction, so even the
			// fallback has nothing to fall back to.
			wantUnreachable: []string{babelCapabilityRepoRead},
		},
		{
			name:      "an ungranted capability is not a tool however it is published",
			grant:     babelGrant{Capabilities: nil, Tools: map[string][]string{babelCapabilityCorpusSearch: {"search"}}},
			wantHost:  []string{},
			wantBabel: []string{},
		},
		{
			name:      "a capability Code has never heard of grants nothing",
			grant:     babelGrant{Capabilities: []string{"corpus-write"}, Tools: map[string][]string{"corpus-write": {"write"}}},
			wantHost:  []string{},
			wantBabel: []string{},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tools, bindings := ompToolsFor(tc.grant)
			host := make([]string, 0, len(tools))
			babel := make([]string, 0, len(tools))
			for _, tool := range tools {
				host = append(host, tool.name)
				babel = append(babel, tool.babelTool)
			}
			if !reflect.DeepEqual(host, tc.wantHost) {
				t.Errorf("host tools = %v; want %v", host, tc.wantHost)
			}
			if !reflect.DeepEqual(babel, tc.wantBabel) {
				t.Errorf("wire names = %v; want %v", babel, tc.wantBabel)
			}

			unreachable := []string(nil)
			for _, binding := range bindings {
				if binding.BabelTool == "" {
					unreachable = append(unreachable, binding.Capability)
				}
				if binding.Note == "" && binding.BabelTool == "" {
					t.Errorf("%s resolved to no tool and gave no reason", binding.Capability)
				}
			}
			if !reflect.DeepEqual(unreachable, tc.wantUnreachable) {
				t.Errorf("unreachable = %v; want %v", unreachable, tc.wantUnreachable)
			}
			// A grant is a ceiling, not a requirement, so one unreachable
			// capability among several is a binding rather than a shortfall. A
			// run left with no route at all is the failure that started this,
			// and it is the one that has to become a gap.
			gap := ompNoRouteGap(tools, bindings)
			if wantGap := len(bindings) > 0 && len(tools) == 0; (gap != "") != wantGap {
				t.Errorf("gap = %q; want a gap only for a run left with no route at all (%v)", gap, wantGap)
			}
		})
	}
}

// TestOmpToolBindingsSayWhereTheWireNameCameFrom is the operator-facing half of
// the contract: whichever path a run took, the payload has to say which one, or
// a receipt cannot distinguish a name Babel published from one Code chose.
func TestOmpToolBindingsSayWhereTheWireNameCameFrom(t *testing.T) {
	_, published := ompToolsFor(babelGrant{
		Capabilities: []string{babelCapabilityCorpusSearch},
		Tools:        map[string][]string{babelCapabilityCorpusSearch: {"search"}},
	})
	if len(published) != 1 || published[0].Source != ompToolNamePublished {
		t.Fatalf("bindings = %+v; want one sourced %q", published, ompToolNamePublished)
	}
	if published[0].BabelTool != "search" || published[0].HostTool != "babel_corpus_search" {
		t.Errorf("binding = %+v; want the two names kept apart", published[0])
	}
	if summary := ompBindingSummary(published[0]); !strings.Contains(summary, "search") ||
		!strings.Contains(summary, ompToolNamePublished) {
		t.Errorf("progress line %q names neither the wire name nor its source", summary)
	}

	_, fallback := ompToolsFor(babelGrant{Capabilities: []string{babelCapabilityCorpusSearch}})
	if len(fallback) != 1 || fallback[0].Source != ompToolNameUnpublished {
		t.Fatalf("bindings = %+v; want one sourced %q", fallback, ompToolNameUnpublished)
	}
	if fallback[0].BabelTool != "search" {
		t.Errorf("fallback wire name = %q; want the operation Code implements", fallback[0].BabelTool)
	}
	if summary := ompBindingSummary(fallback[0]); !strings.Contains(summary, ompToolNameUnpublished) {
		t.Errorf("progress line %q does not mark the run as having fallen back", summary)
	}
}

// TestOmpEvidenceToolsNameNothingTheyCannotDescribe holds the one invariant that
// keeps the fallback honest. Code's babelTools is allowed to exist only for a
// facility Code can hand a model an argument schema for; a name with no schema
// behind it would be a guess wearing the mechanism's clothes.
func TestOmpEvidenceToolsNameNothingTheyCannotDescribe(t *testing.T) {
	for _, tool := range ompEvidenceTools {
		if len(tool.babelTools) == 0 {
			continue
		}
		if tool.parameters == "" {
			t.Errorf("%s names Babel operations %v with no argument schema to describe them",
				tool.capability, tool.babelTools)
		}
		for _, name := range tool.babelTools {
			if name == tool.name {
				t.Errorf("%s uses one string for both namespaces (%q), which is the defect this split closed",
					tool.capability, name)
			}
		}
	}
}

func TestOmpHostToolParametersAreValidSchemas(t *testing.T) {
	for _, tool := range ompEvidenceTools {
		var schema map[string]any
		if err := json.Unmarshal([]byte(tool.parameters), &schema); err != nil {
			t.Errorf("%s: parameters are not valid JSON: %v", tool.name, err)
			continue
		}
		if schema["type"] != "object" {
			t.Errorf("%s: parameter schema is not an object schema", tool.name)
		}
	}
}

// ── the recording tools ──────────────────────────────────────────────────────

// TestOmpRecordSchemasDemandBabelsMinima checks the one thing the schema is for.
// A weak model asked in prose to emit structure sometimes emits prose, so the
// argument document is where §4.3's minima get enforced before a token is spent:
// a claim must carry evidence, and it must answer the counter-evidence question
// rather than skip it. A required list that lost minItems, or a counter_evidence
// that stopped being required, would leave a schema the provider satisfies and
// Babel refuses.
func TestOmpRecordSchemasDemandBabelsMinima(t *testing.T) {
	for _, wire := range ompRecordWires(testJob("")) {
		var schema struct {
			Type       string                     `json:"type"`
			Properties map[string]json.RawMessage `json:"properties"`
			Required   []string                   `json:"required"`
			Additional *bool                      `json:"additionalProperties"`
		}
		if err := json.Unmarshal(wire.Parameters, &schema); err != nil {
			t.Fatalf("%s: parameters are not valid JSON: %v", wire.Name, err)
		}
		if schema.Type != "object" {
			t.Errorf("%s: parameter schema is not an object schema", wire.Name)
		}
		if schema.Additional == nil || *schema.Additional {
			t.Errorf("%s: additionalProperties is not false, so a misspelled field passes silently",
				wire.Name)
		}
		if wire.LoadMode != "essential" {
			t.Errorf("%s: loadMode %q hides the run's only output behind a discovery step",
				wire.Name, wire.LoadMode)
		}
		for _, want := range schema.Required {
			if _, declared := schema.Properties[want]; !declared {
				t.Errorf("%s: %q is required and not declared", wire.Name, want)
			}
		}
		if wire.Name != ompRecordObservationTool {
			continue
		}
		for _, want := range []string{"hypothesis", "claim", "confidence", "impact",
			"evidence", "counter_evidence"} {
			if !slices.Contains(schema.Required, want) {
				t.Errorf("%s: %q is not required, so Babel's minimum is not enforced here",
					wire.Name, want)
			}
		}
		var evidence struct {
			MinItems int `json:"minItems"`
		}
		if err := json.Unmarshal(schema.Properties["evidence"], &evidence); err != nil {
			t.Fatalf("%s: the evidence schema does not decode: %v", wire.Name, err)
		}
		if evidence.MinItems != 1 {
			t.Errorf("%s: evidence minItems = %d; §4.3 refuses a claim with no locator",
				wire.Name, evidence.MinItems)
		}
	}
}

// TestOmpObservationSchemaOffersOnlyTheRunsRecipes covers the field that has to
// be built per run. Babel matches recipe provenance against the stage's own
// assets and refuses the claim on a miss, so the model is offered exactly those
// ids — and is not asked at all when there is only one, because a field with a
// single legal value is a field a weak model can only get wrong.
func TestOmpObservationSchemaOffersOnlyTheRunsRecipes(t *testing.T) {
	// Both variants have to be valid JSON, because a schema OMP cannot read is
	// a session whose tool registration fails and therefore a run with no way
	// to record anything. The multi-recipe branch splices a field in, which is
	// exactly where a stray comma would live.
	decode := func(t *testing.T, schema string) []string {
		t.Helper()
		var parsed struct {
			Properties map[string]json.RawMessage `json:"properties"`
			Required   []string                   `json:"required"`
		}
		if err := json.Unmarshal([]byte(schema), &parsed); err != nil {
			t.Fatalf("the schema is not valid JSON: %v\n%s", err, schema)
		}
		for _, want := range parsed.Required {
			if _, declared := parsed.Properties[want]; !declared {
				t.Errorf("%q is required and not declared:\n%s", want, schema)
			}
		}
		return parsed.Required
	}

	one := ompObservationSchema([]babelRecipeRef{{ID: "outcome-integrity", Version: 1}})
	required := decode(t, one)
	if slices.Contains(required, "recipe") || strings.Contains(one, `"recipe"`) {
		t.Errorf("a single-recipe run still asks the model to name one:\n%s", one)
	}
	t.Logf("single-recipe run: %d required fields %v", len(required), required)

	two := ompObservationSchema([]babelRecipeRef{
		{ID: "outcome-integrity", Version: 1},
		{ID: "handoff-loss", Version: 3},
	})
	required = decode(t, two)
	if !slices.Contains(required, "recipe") {
		t.Errorf("a multi-recipe run does not require the model to attribute a claim: %v", required)
	}
	for _, want := range []string{`"outcome-integrity"`, `"handoff-loss"`} {
		if !strings.Contains(two, want) {
			t.Errorf("a multi-recipe run's schema does not offer %s:\n%s", want, two)
		}
	}
	// The version is never in the schema: Babel matches id and version
	// together, and the version is a fact about the job rather than the claim.
	if strings.Contains(two, `"version"`) {
		t.Errorf("the schema asks the model for a recipe version:\n%s", two)
	}
	t.Logf("multi-recipe run: %d required fields %v", len(required), required)
}

// TestOmpLedgerBindsCitationsToServedBytes is the provenance rule at unit scale.
// A handle resolves to the locator Babel served, byte for byte, and a handle
// this run never issued resolves to nothing at all.
func TestOmpLedgerBindsCitationsToServedBytes(t *testing.T) {
	var served babelServed
	if err := json.Unmarshal([]byte(testServedPayload), &served); err != nil {
		t.Fatalf("the test payload does not decode: %v", err)
	}
	var ledger ompLedger
	announced := ledger.enroll(served.hits())
	if !strings.Contains(announced, "e1") {
		t.Errorf("the model was never told the handle it has to cite: %q", announced)
	}

	citations, err := ledger.cite("evidence", []ompCitedHit{{Hit: "e1", Note: "what it shows"}})
	if err != nil {
		t.Fatalf("citing a served handle: %v", err)
	}
	if want := served.hits()[0].Locator; citations[0].Locator != want {
		t.Errorf("locator = %+v; want the served hit's own, %+v", citations[0].Locator, want)
	}

	if _, err := ledger.cite("evidence", []ompCitedHit{{Hit: "e7"}}); !errors.Is(err, errOmpUncitedEvidence) {
		t.Errorf("citing an unserved handle gave %v; want errOmpUncitedEvidence", err)
	}
	// A citation is all-or-nothing. Keeping the good half would record a claim
	// resting on less than the model said it rested on, which is the same lie
	// told more quietly.
	both := []ompCitedHit{{Hit: "e1", Note: "real"}, {Hit: "e7", Note: "invented"}}
	if got, err := ledger.cite("evidence", both); err == nil {
		t.Errorf("a part-fabricated citation was accepted as %+v", got)
	}
}

// TestOmpLedgerRefusesAClaimThatSkipsTheCounterEvidenceQuestion holds §4.3's
// distinction that a plain slice would erase: an absent counter_evidence is an
// unanswered question and an empty one is an answer. Without this, every claim
// in every run would silently declare that nothing weighs against it.
func TestOmpLedgerRefusesAClaimThatSkipsTheCounterEvidenceQuestion(t *testing.T) {
	var served babelServed
	if err := json.Unmarshal([]byte(testServedPayload), &served); err != nil {
		t.Fatalf("the test payload does not decode: %v", err)
	}
	recipes := []babelRecipeRef{{ID: "outcome-integrity", Version: 1}}
	novelty, priority := 0.5, 0.5

	newLedger := func(t *testing.T) *ompLedger {
		t.Helper()
		ledger := &ompLedger{}
		ledger.enroll(served.hits())
		if _, err := ledger.recordHypothesis(ompHypothesisArgs{
			Statement: "a candidate", Novelty: &novelty, Priority: &priority,
		}); err != nil {
			t.Fatalf("recording the candidate: %v", err)
		}
		return ledger
	}
	base := func() ompObservationArgs {
		return ompObservationArgs{
			Hypothesis: "c1",
			Claim:      "a claim",
			Confidence: "moderate",
			Impact:     "low",
			Evidence:   []ompCitedHit{{Hit: "e1", Note: "what it shows"}},
		}
	}

	skipped := newLedger(t)
	if _, _, err := skipped.recordObservation(base(), recipes); err == nil {
		t.Error("a claim that never answered the counter-evidence question was recorded")
	}

	answered := newLedger(t)
	args := base()
	args.CounterEvidence = &[]ompCitedHit{}
	if _, _, err := answered.recordObservation(args, recipes); err != nil {
		t.Fatalf("an explicit empty answer was refused: %v", err)
	}
	claim := answered.candidates[0].Observations[0].Claim
	if !claim.CounterEvidenceAbsent || len(claim.CounterEvidence) != 0 {
		t.Errorf("claim = %+v; exactly one of the two fields may be set", claim)
	}

	// A missing sorting signal is refused for the same reason: zero is a legal
	// judgement and an absent field is not one.
	if _, err := (&ompLedger{}).recordHypothesis(ompHypothesisArgs{
		Statement: "a candidate", Priority: &priority,
	}); err == nil {
		t.Error("a candidate with no novelty was recorded, so it sorts at zero by default")
	}
}

// TestOmpResolveRecipeNeverInventsProvenance covers the three inputs. Babel
// refuses a claim whose recipe it did not select, so a run with none can carry
// no observation at all — and that is reported rather than papered over with an
// empty reference.
func TestOmpResolveRecipeNeverInventsProvenance(t *testing.T) {
	one := []babelRecipeRef{{ID: "outcome-integrity", Version: 1}}
	if got, err := ompResolveRecipe(one, ""); err != nil || got != one[0] {
		t.Errorf("resolve(one, \"\") = %+v, %v; want the only recipe filled in", got, err)
	}
	two := append(one, babelRecipeRef{ID: "handoff-loss", Version: 3})
	if got, err := ompResolveRecipe(two, "handoff-loss"); err != nil || got != two[1] {
		t.Errorf("resolve(two, named) = %+v, %v; want the named recipe with its own version", got, err)
	}
	if _, err := ompResolveRecipe(two, ""); err == nil {
		t.Error("a claim naming no recipe on a multi-recipe run was given one Code chose")
	}
	if _, err := ompResolveRecipe(two, "invented"); err == nil {
		t.Error("a claim naming a recipe this run never selected was accepted")
	}
	if _, err := ompResolveRecipe(nil, ""); err == nil {
		t.Error("a run with no recipe produced provenance anyway")
	}
}

// ── the child's environment ──────────────────────────────────────────────────

func TestOmpChildEnvReplacesTheHomeAndDropsSecretBearingEntries(t *testing.T) {
	job := testJob("", babelCapabilityCorpusSearch)
	base := []string{
		"PATH=/usr/bin",
		"HOME=/home/operator",
		"XDG_CONFIG_HOME=/home/operator/.config",
		"OMP_PROFILE=work",
		"AMBIENT=" + testBrokerToken,
		"PI_PACKAGE_DIR=/nix/store/omp",
	}
	got := ompChildEnv(base, "/tmp/run/home", job, testAuth())

	index := map[string]string{}
	for _, entry := range got {
		key, value, _ := strings.Cut(entry, "=")
		index[key] = value
	}
	if index["HOME"] != "/tmp/run/home" {
		t.Errorf("HOME = %q; want the run's private home", index["HOME"])
	}
	if index["XDG_CONFIG_HOME"] != "/tmp/run/home/.config" {
		t.Errorf("XDG_CONFIG_HOME = %q; the operator's configuration must not be discoverable", index["XDG_CONFIG_HOME"])
	}
	if _, present := index["OMP_PROFILE"]; present {
		t.Error("OMP_PROFILE survived; an ambient profile would reintroduce the operator's configuration")
	}
	if _, present := index["AMBIENT"]; present {
		t.Error("an environment entry carrying the broker token reached the child")
	}
	if index["PI_PACKAGE_DIR"] != "/nix/store/omp" {
		t.Error("PI_PACKAGE_DIR was dropped; the child needs it to find its own package")
	}
	for _, entry := range got {
		if strings.Contains(entry, testBrokerToken) {
			t.Fatalf("the broker token is in the child environment: %s", entry)
		}
	}
}

// TestOmpChildEnvReplacesAmbientAuthWithTheRunsOwnCredential is the hazard a
// hand-run `code babel` in an operator's shell creates: the shell exports a
// broker and an account-pool file, and a supervised run that inherited them
// would authenticate under a pool this run's account policy never approved.
func TestOmpChildEnvReplacesAmbientAuthWithTheRunsOwnCredential(t *testing.T) {
	auth := testAuth()
	auth.poolPath = "/tmp/run/account-pool.json"
	base := []string{
		"PATH=/usr/bin",
		"OMP_AUTH_BROKER_URL=http://ambient.invalid/auth",
		"OMP_AUTH_BROKER_TOKEN=ambient-token",
		"OMP_AUTH_BROKER_SNAPSHOT_CACHE=/ambient/cache",
		"OMP_AUTH_BROKER_ACCOUNT_POOL_FILE=/ambient/account-pool.json",
	}
	got := ompChildEnv(base, "/tmp/run/home", testJob("", babelCapabilityCorpusSearch), auth)

	for _, key := range []string{
		"OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN",
		"OMP_AUTH_BROKER_SNAPSHOT_CACHE", "OMP_AUTH_BROKER_ACCOUNT_POOL_FILE",
	} {
		var seen []string
		for _, entry := range got {
			if name, value, _ := strings.Cut(entry, "="); name == key {
				seen = append(seen, value)
			}
		}
		if len(seen) != 1 {
			t.Fatalf("%s appears %d times in the child environment: %v", key, len(seen), seen)
		}
		if strings.Contains(seen[0], "ambient") {
			t.Errorf("%s = %q; the inherited value survived into a supervised run", key, seen[0])
		}
	}
	index := map[string]string{}
	for _, entry := range got {
		key, value, _ := strings.Cut(entry, "=")
		index[key] = value
	}
	if index["OMP_AUTH_BROKER_TOKEN"] != testProviderToken {
		t.Errorf("OMP_AUTH_BROKER_TOKEN = %q; the run's own credential must be the one the child gets", index["OMP_AUTH_BROKER_TOKEN"])
	}
	if index["OMP_AUTH_BROKER_ACCOUNT_POOL_FILE"] != auth.poolPath {
		t.Errorf("OMP_AUTH_BROKER_ACCOUNT_POOL_FILE = %q, want the run's own pool %q",
			index["OMP_AUTH_BROKER_ACCOUNT_POOL_FILE"], auth.poolPath)
	}
}

// TestOmpChildEnvWithoutACredentialAddsNoBrokerVariables keeps the failure
// honest: empty broker variables read to OMP as a configured broker, which
// turns "no credential" into an authentication error nobody can trace back.
func TestOmpChildEnvWithoutACredentialAddsNoBrokerVariables(t *testing.T) {
	got := ompChildEnv([]string{"PATH=/usr/bin"}, "/tmp/run/home", testJob("", babelCapabilityCorpusSearch), ompAuth{})
	for _, entry := range got {
		if strings.HasPrefix(entry, "OMP_AUTH_BROKER_") {
			t.Errorf("an unauthenticated child was given %s", entry)
		}
	}
}

// ── Babel's evidence API ─────────────────────────────────────────────────────

func TestFetchBrokeredEvidenceCarriesTheTokenInAHeaderOnly(t *testing.T) {
	var gotAuth, gotBody string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(r.Body)
		gotBody = buf.String()
		_, _ = w.Write([]byte("three matching excerpts"))
	}))
	defer server.Close()

	got, err := fetchBrokeredEvidence(context.Background(),
		babelBroker{Endpoint: server.URL, Token: testBrokerToken},
		ompEvidenceRequest{RunID: "run-1", Capability: babelCapabilityCorpusSearch, Tool: "search"})
	if err != nil {
		t.Fatalf("fetchBrokeredEvidence: %v", err)
	}
	if got != "three matching excerpts" {
		t.Errorf("evidence = %q", got)
	}
	if gotAuth != "Bearer "+testBrokerToken {
		t.Errorf("Authorization = %q; the run-scoped credential belongs in the header", gotAuth)
	}
	if strings.Contains(gotBody, testBrokerToken) {
		t.Error("the request body repeats the credential")
	}
}

func TestFetchBrokeredEvidenceReportsStatusWithoutTheBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		// A broker that echoed the header would leak it through the error path
		// if the body were reported. It must not be.
		_, _ = w.Write([]byte("denied for " + r.Header.Get("Authorization")))
	}))
	defer server.Close()

	_, err := fetchBrokeredEvidence(context.Background(),
		babelBroker{Endpoint: server.URL, Token: testBrokerToken}, ompEvidenceRequest{})
	if err == nil {
		t.Fatal("a 403 answer produced no error")
	}
	if strings.Contains(err.Error(), testBrokerToken) {
		t.Fatalf("the broker's body reached the error text: %v", err)
	}
	if !strings.Contains(err.Error(), "403") {
		t.Errorf("error = %v; want the status named", err)
	}
}

// ── the conformance directives ───────────────────────────────────────────────

func TestOmpConformanceDirectivesReachEachState(t *testing.T) {
	for _, tc := range []struct {
		name        string
		directive   string
		decide      func(babelToolRequest) babelDecision
		wantErr     bool
		wantStatus  string
		wantAsks    int
		wantAskedOn string
		// wantTool is the tool name the request must carry. Babel's suite grades
		// this now, and the whole reason the last mismatch survived a 14/14 run
		// is that nothing here looked at it.
		wantTool    string
		wantPayload string
	}{
		{
			name: "well behaved", directive: babelConformanceWellBehaved,
			wantStatus: babelStatusOK,
		},
		{
			name: "unrecognized directive is well behaved", directive: "invented-by-a-newer-suite",
			wantStatus: babelStatusOK,
		},
		{
			name: "request tool allowed", directive: babelConformanceRequestTool,
			wantAsks: 1, wantAskedOn: babelCapabilityCorpusSearch, wantTool: "search",
			wantStatus: babelStatusOK, wantPayload: babelDecisionAllow,
		},
		{
			name: "request tool denied", directive: babelConformanceRequestTool,
			decide: func(babelToolRequest) babelDecision {
				return babelDecision{Decision: babelDecisionDeny, Code: "policy", Reason: "policy denies this"}
			},
			wantAsks: 1, wantAskedOn: babelCapabilityCorpusSearch, wantTool: "search",
			wantStatus: babelStatusPartial, wantPayload: babelDecisionDeny,
		},
		{
			name: "request ungranted", directive: babelConformanceRequestUngranted,
			decide: func(babelToolRequest) babelDecision {
				return babelDecision{Decision: babelDecisionDeny, Code: "not-granted"}
			},
			wantAsks: 1, wantAskedOn: babelCapabilitySandboxExec, wantTool: ompOutOfGrantProbeTool,
			wantStatus: babelStatusPartial, wantPayload: babelDecisionDeny,
		},
		{
			name: "error only", directive: babelConformanceErrorOnly,
			wantErr: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inv, profiles := newTestInvestigator(t)
			rec := &recorder{decide: tc.decide}
			// The conformance grant covers corpus search and repository reads
			// and deliberately not sandbox execution.
			job := testJob(tc.directive, babelCapabilityCorpusSearch, babelCapabilityRepoRead)
			// The allowed path is serviced against the job's broker, which the
			// suite points at a closed port. That must not stop the run.
			served := 0
			inv.evidence = func(context.Context, babelBroker, ompEvidenceRequest) (string, error) {
				served++
				return "one matching excerpt", nil
			}

			result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
			if profiles.askedID != "" {
				t.Error("a conformance run resolved a profile; the suite names one no store holds")
			}
			if tc.wantErr {
				if err == nil {
					t.Fatalf("directive %s produced a result instead of an error: %+v", tc.directive, result)
				}
				if result.Status != "" || result.Payload != nil {
					t.Errorf("a result accompanied the error: %+v", result)
				}
				if len(rec.stages) == 0 {
					t.Error("the failing run emitted no progress at all")
				}
				return
			}
			if err != nil {
				t.Fatalf("investigate: %v", err)
			}
			if len(rec.stages) == 0 {
				t.Error("no progress event was emitted; Babel keeps its interface responsive from these")
			}
			if result.Status != tc.wantStatus {
				t.Errorf("status = %q; want %q", result.Status, tc.wantStatus)
			}
			// The literal rather than the constant: a test that compares the
			// emitted schema against the same constant the emitter used agrees
			// with itself whatever either of them says.
			if result.Schema != "babel.analysis-result/1" {
				t.Errorf("schema = %q; Babel refuses a result declaring any other value", result.Schema)
			}
			if len(rec.asks) != tc.wantAsks {
				t.Fatalf("made %d tool requests, want %d: %+v", len(rec.asks), tc.wantAsks, rec.asks)
			}
			if tc.wantAsks == 1 {
				if rec.asks[0].Capability != tc.wantAskedOn {
					t.Errorf("asked for %q; want %q", rec.asks[0].Capability, tc.wantAskedOn)
				}
				if rec.asks[0].Tool != tc.wantTool {
					t.Errorf("asked with tool %q; want %q", rec.asks[0].Tool, tc.wantTool)
				}
				if rec.asks[0].Reason == "" {
					t.Error("the tool request carried no reason for Babel's authorizer")
				}
			}
			if tc.wantPayload != "" && !strings.Contains(string(result.Payload), tc.wantPayload) {
				t.Errorf("payload does not report the decision received (%s): %s", tc.wantPayload, result.Payload)
			}
			if strings.Contains(string(result.Payload), testBrokerToken) {
				t.Fatal("the run-scoped broker credential is in the result payload")
			}
			for _, message := range rec.messages {
				if strings.Contains(message, testBrokerToken) {
					t.Fatal("the run-scoped broker credential is in a progress message")
				}
			}
		})
	}
}

func TestOmpConformanceSlowKeepsWorkingUntilCancelled(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	ctx, cancel := context.WithCancel(context.Background())
	rec := &recorder{}
	emitted := 0
	emit := func(stage, message string, fraction float64) {
		rec.emit(stage, message, fraction)
		// Cancel as soon as the run is demonstrably working, which is what
		// Babel's cancellation obligation does.
		emitted++
		if emitted == 1 {
			cancel()
		}
	}

	started := time.Now()
	_, err := inv.investigate(ctx, testJob(babelConformanceSlow, babelCapabilityCorpusSearch), emit, rec.request)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v; want context.Canceled", err)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Errorf("the slow run took %s to notice cancellation", elapsed)
	}
	if len(rec.stages) == 0 {
		t.Error("the slow run emitted no progress before being cancelled")
	}
}

func TestOmpConformanceSlowEndsOnItsOwnBudget(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	rec := &recorder{}
	// The budget is what a run nobody cancels ends on, rather than hanging
	// until Babel's idle timeout fires.
	inv.slowBudget = 5 * time.Millisecond
	result, err := inv.conformSlow(context.Background(), rec.emit, ompFindingsOf(testJob("", "")))
	if err != nil {
		t.Fatalf("conformSlow: %v", err)
	}
	if result.Status != babelStatusPartial {
		t.Errorf("status = %q; a run that gave up on its own schedule stopped short", result.Status)
	}
}

// TestOmpConformanceEchoJobReportsTheJobItDecoded grades the omp path's answer
// to the echo-job directive the way Babel does: against the job that was sent,
// entry by entry, including the empty final segment an unarchived source must
// render.
//
// The material carries a nonce because without one this assertion is satisfied
// by a worker that prints a constant, which is the exact reading the obligation
// exists to rule out. So the answer is also checked against what that worker
// would have said.
func TestOmpConformanceEchoJobReportsTheJobItDecoded(t *testing.T) {
	inv, profiles := newTestInvestigator(t)
	rec := &recorder{}
	job := testJob(babelConformanceEchoJob, babelCapabilityCorpusSearch)
	job.Recipes = []babelRecipeRef{
		{ID: "outcome-integrity", Version: 1},
		{ID: "evidence-" + babelTestNonce, Version: 7},
	}
	job.Sources = []babelSource{{
		Kind:     "session",
		Selector: "omp/synthetic-" + babelTestNonce,
		Digest:   "sha256:" + strings.Repeat("0", 64),
		Snapshot: "snapshot-" + babelTestNonce,
	}, {
		Kind:     "repository",
		Selector: "synthetic/repository-" + babelTestNonce,
		Digest:   "sha256:" + strings.Repeat("1", 64),
	}}

	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	if profiles.askedID != "" {
		t.Error("a conformance run resolved a profile; the suite names one no store holds")
	}
	if result.Status != babelStatusOK {
		t.Errorf("status = %q; the run answered what it was asked and cut nothing short", result.Status)
	}
	if len(rec.asks) != 0 {
		t.Errorf("the directive made %d tool requests and needs none: %+v", len(rec.asks), rec.asks)
	}

	var answered struct {
		Job *babelJobEcho `json:"job"`
	}
	if err := json.Unmarshal(result.Payload, &answered); err != nil {
		t.Fatalf("the result payload is not a JSON object: %v", err)
	}
	if answered.Job == nil {
		t.Fatalf(`the result payload carries no "job" object: %s`, result.Payload)
	}
	if want := babelEchoJobAnswer(); !reflect.DeepEqual(*answered.Job, want) {
		t.Errorf("the worker reports %+v, the job carried %+v", *answered.Job, want)
	}
	if stale := babelStaleEchoAnswer(); reflect.DeepEqual(*answered.Job, stale) {
		t.Errorf("the worker reports the published conformance job rather than the one that "+
			"arrived: %+v", *answered.Job)
	}

	// The payload's own recipe and source summary is not the echo and must not
	// be mistaken for it: it renders a source as "kind:selector", which drops
	// two of the four parts Babel compares.
	var summary ompFindings
	if err := json.Unmarshal(result.Payload, &summary); err != nil {
		t.Fatalf("the result payload is not findings: %v", err)
	}
	if len(summary.Sources) != len(answered.Job.Sources) {
		t.Errorf("the payload summarises %d sources and echoes %d; both come from the same "+
			"decoded job", len(summary.Sources), len(answered.Job.Sources))
	}
}

// TestOmpConformanceEchoEvidenceReportsTheHitsItDecoded grades the reading of a
// served payload the same way echo-job grades the reading of a job, and for the
// same reason: nothing else in a run makes it observable. An allowed decision
// looks identical in a receipt whether the worker handed its hits to the model
// or dropped them on the floor, which is how a build that dropped every one of
// them passed a full conformance suite.
//
// The answer is built from the decision that arrived, so the values here are
// arbitrary on purpose — Babel's suite plants a per-run nonce in exactly these
// fields, and a worker answering from anything it held would answer with the
// wrong ones.
func TestOmpConformanceEchoEvidenceReportsTheHitsItDecoded(t *testing.T) {
	const payload = `{"schema":"babel.corpus-search/1","query":"probe","limit":10,` +
		`"hits":[{"harness":"omp","source_id":"session-` + babelTestNonce + `","index":42,` +
		`"excerpt":"the archive says ` + babelTestNonce + `","truncated":false,` +
		`"locator":{"path":"sessions/omp/` + babelTestNonce + `.jsonl","line":12,` +
		`"byte_offset":3456,"digest":"` + testServedDigest + `"}},` +
		`{"harness":"claude","source_id":"session-two","index":7,"excerpt":"second","truncated":true,` +
		`"locator":{"path":"sessions/claude/two.jsonl","line":1,"byte_offset":0,` +
		`"digest":"` + testServedDigest + `"}}]}`

	inv, profiles := newTestInvestigator(t)
	rec := &recorder{decide: func(ask babelToolRequest) babelDecision {
		return babelDecision{
			Type: babelMessageToolDecision, RequestID: ask.RequestID,
			Decision: babelDecisionAllow, Results: json.RawMessage(payload),
		}
	}}

	result, err := inv.investigate(context.Background(),
		testJob(babelConformanceEchoEvidence, babelCapabilityCorpusSearch), rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	if profiles.askedID != "" {
		t.Error("a conformance run resolved a profile; the suite names one no store holds")
	}
	// One ordinary request, by the name the grant published: the directive
	// grades what became of the decision, not a request shape of its own.
	if len(rec.asks) != 1 || rec.asks[0].Capability != babelCapabilityCorpusSearch ||
		rec.asks[0].Tool != "search" {
		t.Fatalf("requests = %+v; want one corpus-search request by the published name", rec.asks)
	}

	var answered struct {
		Served *babelServedEcho `json:"served_evidence"`
	}
	if err := json.Unmarshal(result.Payload, &answered); err != nil {
		t.Fatalf("the result payload is not a JSON object: %v", err)
	}
	if answered.Served == nil {
		t.Fatalf(`the result payload carries no "served_evidence" object: %s`, result.Payload)
	}
	want := []string{
		"omp|session-" + babelTestNonce + "|42|sessions/omp/" + babelTestNonce + ".jsonl|12|3456|" +
			testServedDigest + "|the archive says " + babelTestNonce,
		"claude|session-two|7|sessions/claude/two.jsonl|1|0|" + testServedDigest + "|second",
	}
	if !reflect.DeepEqual(answered.Served.Hits, want) {
		t.Errorf("the worker reports %q, Babel served %q", answered.Served.Hits, want)
	}

	// The request log is a different key and a different thing, and the echo
	// must not have displaced it.
	var findings ompFindings
	if err := json.Unmarshal(result.Payload, &findings); err != nil {
		t.Fatalf("the result payload is not findings: %v", err)
	}
	if len(findings.Evidence) != 1 || findings.Evidence[0].Hits == nil ||
		*findings.Evidence[0].Hits != 2 {
		t.Errorf("evidence log = %+v; the request log records two served hits", findings.Evidence)
	}
}

// TestOmpConformanceEchoEvidenceAnswersEmptyWhenNothingWasServed keeps the
// directive's own two failures apart. A missing key says the worker never
// implemented the directive; an empty array says it implemented it and the
// decision carried nothing. Babel grades those as different defects — one is
// Code's and one is Babel's — so answering the second with silence would
// misattribute it.
func TestOmpConformanceEchoEvidenceAnswersEmptyWhenNothingWasServed(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	rec := &recorder{}
	inv.evidence = func(context.Context, babelBroker, ompEvidenceRequest) (string, error) {
		return "", errors.New("no broker is listening")
	}

	result, err := inv.investigate(context.Background(),
		testJob(babelConformanceEchoEvidence, babelCapabilityCorpusSearch), rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	var answered struct {
		Served *babelServedEcho `json:"served_evidence"`
	}
	if err := json.Unmarshal(result.Payload, &answered); err != nil {
		t.Fatalf("the result payload is not a JSON object: %v", err)
	}
	if answered.Served == nil {
		t.Fatalf(`a decision that served nothing produced no "served_evidence" key: %s`, result.Payload)
	}
	if len(answered.Served.Hits) != 0 {
		t.Errorf("hits = %q; nothing was served", answered.Served.Hits)
	}
	if !strings.Contains(string(result.Payload), `"hits":[]`) {
		t.Errorf("the empty answer is a null rather than an empty array: %s", result.Payload)
	}
}

// TestOmpConformanceEchoTokenDisclosesTheTokenOnPurpose defends the property
// that makes Babel's redaction obligation gradeable at all. The directive asks
// this worker to leak the run's broker credential; if the worker quietly
// behaved instead, Babel's search for that token in the receipt could not fail
// and would pass without testing anything. So the assertion here is the inverse
// of the one every other directive gets above: the token must be present, in
// both of the two places a real leak reaches.
func TestOmpConformanceEchoTokenDisclosesTheTokenOnPurpose(t *testing.T) {
	inv, profiles := newTestInvestigator(t)
	rec := &recorder{}
	job := testJob(babelConformanceEchoToken, babelCapabilityCorpusSearch)

	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	if profiles.askedID != "" {
		t.Error("a conformance run resolved a profile; the suite names one no store holds")
	}
	if result.Status != babelStatusOK {
		t.Errorf("status = %q; the run did what it was asked and cut nothing short", result.Status)
	}
	if !strings.Contains(string(result.Payload), testBrokerToken) {
		t.Errorf("the result payload does not carry the token verbatim, so a redaction "+
			"downstream would have nothing to find: %s", result.Payload)
	}
	disclosed := false
	for _, message := range rec.messages {
		if strings.Contains(message, testBrokerToken) {
			disclosed = true
		}
	}
	if !disclosed {
		t.Errorf("no progress message carried the token; the directive requires at least one: %v", rec.messages)
	}
	if len(rec.asks) != 0 {
		t.Errorf("the directive made %d tool requests and needs none: %+v", len(rec.asks), rec.asks)
	}
}

// ── the real run, against a fake OMP ─────────────────────────────────────────

func TestOmpDriveRegistersOnlyTheGrantedToolsAndReportsAResult(t *testing.T) {
	inv, profiles := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "plain")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{}

	job := testJob("", babelCapabilityRepoRead, babelCapabilityCorpusSearch)
	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	if profiles.askedID != "mixed-led" || profiles.askedAt != 4 {
		t.Errorf("resolved %q@%d; want the job's profile", profiles.askedID, profiles.askedAt)
	}
	// The fake finished cleanly and recorded nothing, which is now partial
	// rather than ok: prose is not an outcome. The scenario that records is
	// TestOmpDriveRecordsWhatTheModelStructures.
	if result.Status != babelStatusPartial {
		t.Errorf("status = %q; a run that recorded no candidate has produced nothing durable",
			result.Status)
	}
	if !strings.Contains(string(result.Payload), "the corpus supports the finding") {
		t.Errorf("payload carries no analysis: %s", result.Payload)
	}
	// This test's backend contains nothing, so the uncontained tier is what is
	// being exercised: there is no cgroup, and the honest sources are the
	// child's rusage and a host walk of the run directory. Both are real
	// readings, so both are reported — and the report has to say which they
	// were, because the same two fields carry the scope's whole-tree figures
	// on a machine that has one.
	resources := result.Resources
	if resources == nil || resources.CPUSeconds == nil || *resources.CPUSeconds <= 0 {
		t.Errorf("resources = %+v; the child's rusage was available and should be reported", resources)
	}
	if resources != nil && resources.SandboxBytesWritten == nil {
		t.Error("no sandbox_bytes_written; the run directory is on the host and can always be walked")
	}
	if inv.containment().ResourceCeilings {
		t.Error("a backend that installed no ceiling declared one")
	}
	provenance := strings.Join(rec.messages, "\n")
	if !strings.Contains(provenance, "rusage") || !strings.Contains(provenance, "run directory") {
		t.Errorf("the run never said where its figures came from: %s", provenance)
	}
	if strings.Contains(provenance, "cgroup") {
		t.Errorf("a tier with no cgroup reported a cgroup figure: %s", provenance)
	}
	if len(rec.stages) == 0 {
		t.Error("the run emitted no progress")
	}

	// repo-read is granted and Babel publishes nothing for it, so no host tool
	// is offered for it: showing the model a route certain to be refused wastes
	// a turn and puts a denial in the receipt that means nothing. The two
	// recording tools are always there, because they depend on no grant.
	registered := ompFakeToolNames(t, record)
	want := []string{"babel_corpus_search", ompRecordHypothesisTool, ompRecordObservationTool}
	if !reflect.DeepEqual(registered, want) {
		t.Fatalf("registered %v; want the tools a published name backs plus the recording tools %v",
			registered, want)
	}

	// The payload still has to account for repo-read, or a reviewer cannot tell
	// a capability that was granted and unroutable from one never granted.
	var findings ompFindings
	if err := json.Unmarshal(result.Payload, &findings); err != nil {
		t.Fatalf("payload does not decode: %v", err)
	}
	byCapability := map[string]ompToolBinding{}
	for _, binding := range findings.Tools {
		byCapability[binding.Capability] = binding
	}
	if got := byCapability[babelCapabilityCorpusSearch]; got.BabelTool != "search" ||
		got.Source != ompToolNamePublished {
		t.Errorf("corpus-search binding = %+v; want the published name on the wire", got)
	}
	if got := byCapability[babelCapabilityRepoRead]; got.BabelTool != "" || got.Note == "" {
		t.Errorf("repo-read binding = %+v; want no wire name and a reason", got)
	}
}

// TestOmpProductionResultDeclaresTheSchemaBabelAccepts is the check the two
// divergent schema constants got past. Babel's explore package compares the
// stored record's schema against "babel.analysis-result/1" and rejects the
// result on anything else, so a production investigator naming a format of its
// own produces runs that are all discarded after the work is done — while a
// conformance stub declaring the right one passes the suite and hides it.
//
// The value is read out of the marshalled result rather than off a constant,
// because these bytes are the real wire value: the protocol layer's emitResult
// fills Schema in only when the investigator left it empty and then writes this
// struct through writeLine unchanged, so the schema field here is the field
// Babel parses. Comparing against babelResultSchema instead would restate the
// emitter rather than check it.
//
// The job carries no conformance directive, so this reaches drive — the real
// production path — and the fake omp is the narrowest seam that gets there
// without a provider credential or a network.
func TestOmpProductionResultDeclaresTheSchemaBabelAccepts(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, _ := ompFakeBinary(t, "plain")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{}

	job := testJob("", babelCapabilityCorpusSearch)
	if job.conformanceRequested() {
		t.Fatal("the job took the conformance path, so this test never reached the production investigator")
	}
	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	line, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshalling the result the protocol layer writes: %v", err)
	}
	var onTheWire struct {
		Schema  string          `json:"schema"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(line, &onTheWire); err != nil {
		t.Fatalf("decoding the emitted result: %v", err)
	}
	if onTheWire.Schema != "babel.analysis-result/1" {
		t.Fatalf("the production investigator emitted schema %q; Babel accepts only "+
			"babel.analysis-result/1 and discards the run on anything else", onTheWire.Schema)
	}
	if len(onTheWire.Payload) == 0 {
		t.Error("the result carried no payload, so the declared schema describes nothing")
	}
}

// TestOmpDriveOffersNoEvidenceRouteForAnEmptyGrant checks the direction that
// still matters after the recording tools became unconditional: a grant with no
// capabilities must produce no evidence route, so the model is never shown a
// call it would only be refused on.
//
// It cannot check that nothing at all is registered any more, and should not.
// The recording tools depend on no grant, and a run that could not record
// anything would be the failure this whole output path exists to prevent — a
// grantless run can still record a speculative candidate, which §4.2 keeps.
func TestOmpDriveOffersNoEvidenceRouteForAnEmptyGrant(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "plain")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{}

	if _, err := inv.investigate(context.Background(), testJob(""), rec.emit, rec.request); err != nil {
		t.Fatalf("investigate: %v", err)
	}
	registered := ompFakeToolNames(t, record)
	want := []string{ompRecordHypothesisTool, ompRecordObservationTool}
	if !reflect.DeepEqual(registered, want) {
		t.Fatalf("registered %v; a grant with no capabilities justifies no evidence route, so want "+
			"only the recording tools %v", registered, want)
	}
}

func TestOmpDriveServesAllowedEvidenceThroughTheBroker(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "hosttool")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }

	var gotEvidence ompEvidenceRequest
	var gotBroker babelBroker
	inv.evidence = func(_ context.Context, broker babelBroker, request ompEvidenceRequest) (string, error) {
		gotBroker, gotEvidence = broker, request
		return "excerpt: the archive agrees", nil
	}
	rec := &recorder{}

	job := testJob("", babelCapabilityCorpusSearch)
	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	if len(rec.asks) != 1 {
		t.Fatalf("made %d tool requests, want 1: %+v", len(rec.asks), rec.asks)
	}
	// This is the assertion the last incident turned on. The model called the
	// host tool babel_corpus_search; what reaches Babel's authorizer must be the
	// name Babel published, because Babel denies every other name and the run
	// that emitted the host tool name got three refusals and produced nothing.
	ask := rec.asks[0]
	if ask.Capability != babelCapabilityCorpusSearch || ask.Tool != "search" {
		t.Errorf("request = %+v; want capability %q and Babel's published tool %q",
			ask, babelCapabilityCorpusSearch, "search")
	}
	if !strings.Contains(string(ask.Arguments), "outcome integrity") {
		t.Errorf("the model's arguments did not reach Babel's authorizer: %s", ask.Arguments)
	}
	if gotBroker.Token != testBrokerToken || gotEvidence.Capability != babelCapabilityCorpusSearch ||
		gotEvidence.Tool != "search" {
		t.Errorf("broker call = %+v %+v; the broker must be asked by the published name too",
			gotBroker, gotEvidence)
	}

	answer := ompFakeHostToolResult(t, record)
	if answer.IsError {
		t.Fatalf("an allowed request was answered as a tool error: %+v", answer)
	}
	if len(answer.Result.Content) == 0 || answer.Result.Content[0].Text != "excerpt: the archive agrees" {
		t.Errorf("the evidence did not reach the model: %+v", answer.Result)
	}
	// This scenario records nothing, so the run is partial for that and nothing
	// else. What this test is about is that the evidence path left no gap of
	// its own.
	if gaps := evidenceGaps(t, result); len(gaps) != 0 {
		t.Errorf("gaps = %v; nothing was refused", gaps)
	}
	if !strings.Contains(string(result.Payload), babelDecisionAllow) {
		t.Errorf("payload does not report the decision received: %s", result.Payload)
	}
	if result.Resources == nil || result.Resources.ToolCalls != 1 {
		t.Errorf("resources = %+v; one brokered tool call was made", result.Resources)
	}
}

// testServedDigest is a plausible record digest: the locator carries a bare
// 64-character lowercase hex sha256, and a test that rendered a short one would
// pass while a rendering that truncated the real thing also passed.
const testServedDigest = "9f2c1a4b6d8e0f13579bdf02468ace13579bdf02468ace13579bdf02468ace13"

// testServedPayload is one served hit as Babel writes it, including fields this
// build of Code does not model — "kind", "role", "corpus_version", "cluster".
// They are here because the payload reaches the model unchanged and that is
// what makes an unknown field non-fatal in this direction: it survives rather
// than being dropped by a re-encode.
const testServedPayload = `{"schema":"babel.corpus-search/1","query":"outcome integrity",` +
	`"limit":10,"corpus_version":9,"hits":[{"harness":"codex","source_id":"019a-c7f2",` +
	`"index":87,"kind":"tool-observation","role":"assistant","tool":"bash","outcome":"fail",` +
	`"cluster":"c-1","excerpt":"the retry loop was removed and the suite passed",` +
	`"truncated":true,"locator":{"path":"sessions/codex/019a-c7f2.jsonl","line":412,` +
	`"byte_offset":91233,"digest":"` + testServedDigest + `"}}]}`

// TestOmpDriveGivesTheModelTheEvidenceBabelServed is the assertion this whole
// path exists for, and it is made on the frame OMP received rather than on
// anything Code kept. A run that recorded "allow, served" while handing the
// model a sentence with no corpus in it is exactly what shipped before, and it
// would satisfy every internal assertion available.
func TestOmpDriveGivesTheModelTheEvidenceBabelServed(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "hosttool")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	inv.evidence = func(context.Context, babelBroker, ompEvidenceRequest) (string, error) {
		t.Error("the broker was called for evidence the decision had already served")
		return "", nil
	}
	rec := &recorder{decide: func(ask babelToolRequest) babelDecision {
		return babelDecision{
			Type: babelMessageToolDecision, RequestID: ask.RequestID,
			Decision: babelDecisionAllow, Reason: "served 1 hit from the corpus index",
			Results: json.RawMessage(testServedPayload),
		}
	}}

	result, err := inv.investigate(context.Background(),
		testJob("", babelCapabilityCorpusSearch), rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}

	answer := ompFakeHostToolResult(t, record)
	if answer.IsError {
		t.Fatalf("served evidence reached the model as a tool error: %+v", answer)
	}
	text := answer.Result.Content[0].Text
	// The excerpt, because without it the model has nothing to observe, and
	// every part of the locator, because a citation missing one of them cannot
	// be reopened: the path and line find the record and the digest proves the
	// record found is the record served.
	for _, want := range []string{
		"the retry loop was removed and the suite passed",
		"sessions/codex/019a-c7f2.jsonl", "412", "91233", testServedDigest,
		"codex", "019a-c7f2", "87",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the model was never shown %q:\n%s", want, text)
		}
	}
	// Fields this build does not model reached the model anyway, which is the
	// point of forwarding Babel's bytes instead of re-encoding Code's struct.
	for _, want := range []string{"corpus_version", "cluster", "tool-observation"} {
		if !strings.Contains(text, want) {
			t.Errorf("a field Code does not model was dropped on the way to the model: %q\n%s", want, text)
		}
	}
	if !strings.Contains(text, "truncated") {
		t.Errorf("the model was not told the excerpt was a cut clip:\n%s", text)
	}

	var findings ompFindings
	if err := json.Unmarshal(result.Payload, &findings); err != nil {
		t.Fatalf("payload does not decode: %v", err)
	}
	if len(findings.Evidence) != 1 {
		t.Fatalf("evidence log = %+v; want one entry", findings.Evidence)
	}
	entry := findings.Evidence[0]
	if !entry.Served || entry.Hits == nil || *entry.Hits != 1 {
		t.Errorf("evidence entry = %+v; the receipt must record one served hit", entry)
	}
	// The receipt keeps the count and the locators; the excerpt is the wire's
	// business and must not have followed the count into a durable record.
	if strings.Contains(string(result.Payload), "the retry loop was removed") {
		t.Errorf("an excerpt reached the terminal result payload: %s", result.Payload)
	}
	if gaps := evidenceGaps(t, result); len(gaps) != 0 {
		t.Errorf("gaps = %v; nothing was refused or missing", gaps)
	}
}

// TestOmpDriveTellsAnUnservedDecisionApartFromAnEmptyMatch holds the two
// allowed outcomes apart in the one place it matters: the text the model reads.
// "Babel served nothing" and "the corpus matched nothing" support opposite
// findings — the second licenses writing that the archive is silent on a
// question, and the first licenses nothing at all — so a build that renders
// them alike invites a confident negative claim about a corpus nobody searched.
func TestOmpDriveTellsAnUnservedDecisionApartFromAnEmptyMatch(t *testing.T) {
	const emptyPayload = `{"schema":"babel.corpus-search/1","query":"outcome integrity",` +
		`"limit":10,"hits":[]}`

	texts := map[string]string{}
	for _, tc := range []struct {
		name    string
		results json.RawMessage
		// wantError marks the outcome the model must read as a failed call:
		// an absence of evidence, never an answer.
		wantError bool
		wantHits  bool
		wantGap   bool
		wantText  []string
		denyText  []string
	}{
		{
			name: "no payload", results: nil, wantError: true, wantHits: false, wantGap: true,
			wantText: []string{"served no evidence", "not an empty result", "state the gap"},
			denyText: []string{"matched nothing"},
		},
		{
			name: "empty match", results: json.RawMessage(emptyPayload),
			wantError: false, wantHits: true, wantGap: false,
			wantText: []string{"matched nothing", "an answer", `"hits": []`},
			denyText: []string{"served no evidence"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inv, _ := newTestInvestigator(t)
			fake, record := ompFakeBinary(t, "hosttool")
			inv.lookOmp = func() (string, error) { return fake, nil }
			inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
			inv.evidence = func(context.Context, babelBroker, ompEvidenceRequest) (string, error) {
				t.Error("a run with no broker still reached for one")
				return "", nil
			}
			rec := &recorder{decide: func(ask babelToolRequest) babelDecision {
				return babelDecision{
					Type: babelMessageToolDecision, RequestID: ask.RequestID,
					Decision: babelDecisionAllow, Results: tc.results,
				}
			}}

			// No broker, so the decision's payload is the only route either
			// case has. A job that named one would send the no-payload case
			// down the fallback and grade a different question.
			job := testJob("", babelCapabilityCorpusSearch)
			job.Broker = nil
			result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
			if err != nil {
				t.Fatalf("investigate: %v", err)
			}

			answer := ompFakeHostToolResult(t, record)
			if answer.IsError != tc.wantError {
				t.Errorf("tool error = %v, want %v: %+v", answer.IsError, tc.wantError, answer.Result)
			}
			text := answer.Result.Content[0].Text
			texts[tc.name] = text
			for _, want := range tc.wantText {
				if !strings.Contains(text, want) {
					t.Errorf("the model was never told %q:\n%s", want, text)
				}
			}
			for _, unwanted := range tc.denyText {
				if strings.Contains(text, unwanted) {
					t.Errorf("the model was told %q, which is the other outcome:\n%s", unwanted, text)
				}
			}

			var findings ompFindings
			if err := json.Unmarshal(result.Payload, &findings); err != nil {
				t.Fatalf("payload does not decode: %v", err)
			}
			if len(findings.Evidence) != 1 {
				t.Fatalf("evidence log = %+v; want one entry", findings.Evidence)
			}
			// The receipt keeps the same distinction structurally: no hit
			// count at all against a count of zero.
			switch entry := findings.Evidence[0]; {
			case tc.wantHits && (entry.Hits == nil || *entry.Hits != 0):
				t.Errorf("evidence entry = %+v; a search that matched nothing records zero hits", entry)
			case !tc.wantHits && entry.Hits != nil:
				t.Errorf("evidence entry = %+v; a decision that served nothing has no hit count", entry)
			}
			gaps := evidenceGaps(t, result)
			if gapped := len(gaps) > 0; gapped != tc.wantGap {
				t.Errorf("gaps = %v, want an evidence gap: %v", gaps, tc.wantGap)
			}
		})
	}

	if texts["no payload"] == texts["empty match"] {
		t.Errorf("both outcomes read identically to the model:\n%s", texts["no payload"])
	}
}

// TestOmpDrivePassesAPayloadItCannotReadStraightThrough is the protocol's
// unknown-shape rule applied to the payload as a whole. A newer Babel that
// restructures its results is not a broken Babel, and the bytes it took the
// disclosure risk of sending are still evidence: Code says it could not read
// them and shows them anyway, rather than deciding on the model's behalf that
// there was nothing there.
func TestOmpDrivePassesAPayloadItCannotReadStraightThrough(t *testing.T) {
	const foreign = `{"schema":"babel.corpus-search/2","clusters":[{"theme":"retry loops",` +
		`"members":[{"where":"sessions/codex/019a.jsonl:412","says":"the suite passed"}]}]}`

	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "hosttool")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{decide: func(ask babelToolRequest) babelDecision {
		return babelDecision{
			Type: babelMessageToolDecision, RequestID: ask.RequestID,
			Decision: babelDecisionAllow, Results: json.RawMessage(foreign),
		}
	}}

	job := testJob("", babelCapabilityCorpusSearch)
	job.Broker = nil
	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("an unreadable payload ended the run: %v", err)
	}

	answer := ompFakeHostToolResult(t, record)
	if answer.IsError {
		t.Errorf("a payload Code could not read was withheld from the model as an error: %+v", answer.Result)
	}
	text := answer.Result.Content[0].Text
	for _, want := range []string{"does not recognize", "retry loops", "sessions/codex/019a.jsonl:412",
		"the suite passed"} {
		if !strings.Contains(text, want) {
			t.Errorf("the model was never shown %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, "matched nothing") {
		t.Errorf("a shape Code could not read was reported as an empty corpus:\n%s", text)
	}

	var findings ompFindings
	if err := json.Unmarshal(result.Payload, &findings); err != nil {
		t.Fatalf("payload does not decode: %v", err)
	}
	if len(findings.Evidence) != 1 || findings.Evidence[0].Hits != nil {
		t.Errorf("evidence log = %+v; an unread payload yields no hit count", findings.Evidence)
	}
}

// TestOmpDriveFallsBackAudiblyWhenBabelPublishesNoToolNames is the absent-mapping
// decision, asserted on the request Code emits rather than on the constant it
// holds.
//
// The choice is a fallback rather than a refusal, and the reason is that
// refusing would recreate the failure from the other side: a Babel predating
// the mapping would get a run that requests nothing at all, which is the same
// zero-evidence receipt the guessed name produced. What makes the fallback
// acceptable is that it cannot be silent — the payload's binding and a progress
// message both say the name was Code's, so an operator reading either can tell
// this run apart from one that obeyed a published mapping.
func TestOmpDriveFallsBackAudiblyWhenBabelPublishesNoToolNames(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "hosttool")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	inv.evidence = func(context.Context, babelBroker, ompEvidenceRequest) (string, error) {
		return "excerpt: the archive agrees", nil
	}
	rec := &recorder{}

	job := testLegacyJob("", babelCapabilityCorpusSearch)
	if job.Grant.publishesTools() {
		t.Fatal("the legacy job published a mapping, so this test never reached the fallback")
	}
	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	if len(rec.asks) != 1 {
		t.Fatalf("made %d tool requests, want 1: %+v", len(rec.asks), rec.asks)
	}
	if got := rec.asks[0].Tool; got != "search" {
		t.Errorf("request tool = %q; want the operation Code implements, %q", got, "search")
	}
	if registered := ompFakeToolNames(t, record); !slices.Contains(registered, "babel_corpus_search") {
		t.Errorf("registered %v; the host tool name is Code's either way", registered)
	}

	var findings ompFindings
	if err := json.Unmarshal(result.Payload, &findings); err != nil {
		t.Fatalf("payload does not decode: %v", err)
	}
	if len(findings.Tools) != 1 || findings.Tools[0].Source != ompToolNameUnpublished {
		t.Fatalf("payload bindings = %+v; a receipt must show the fallback was taken", findings.Tools)
	}
	if len(findings.Evidence) != 1 || findings.Evidence[0].Tool != "search" {
		t.Errorf("evidence log = %+v; want the name that actually went on the wire", findings.Evidence)
	}
	if !slices.ContainsFunc(rec.messages, func(m string) bool {
		return strings.Contains(m, ompToolNameUnpublished)
	}) {
		t.Errorf("no progress message said the tool name was unpublished: %v", rec.messages)
	}
}

// TestOmpDriveAsksForNothingWhenTheMappingNamesNoTool is the other half of the
// absent-mapping decision. A grant that carries a mapping and names nothing for
// a capability is Babel stating that nothing serves it, which is an answer
// rather than a silence — so there is no fallback, no host tool, and no request.
func TestOmpDriveAsksForNothingWhenTheMappingNamesNoTool(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "hosttool")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	inv.evidence = func(context.Context, babelBroker, ompEvidenceRequest) (string, error) {
		t.Error("evidence was fetched for a capability Babel publishes no tool for")
		return "", nil
	}
	rec := &recorder{}

	job := testJob("", babelCapabilityCorpusSearch)
	job.Grant.Tools = map[string][]string{babelCapabilityCorpusSearch: {}}
	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	if len(rec.asks) != 0 {
		t.Errorf("made %d tool requests; Babel named no tool to request: %+v", len(rec.asks), rec.asks)
	}
	if registered := ompFakeToolNames(t, record); slices.Contains(registered, "babel_corpus_search") {
		t.Fatalf("registered %v; a capability with no published tool was still shown to the model",
			registered)
	}
	// The run had one capability granted and no route to it, which is exactly
	// the shape that used to report success while producing nothing.
	if result.Status != babelStatusPartial {
		t.Errorf("status = %q; a run with no evidence route stopped short", result.Status)
	}
	var findings ompFindings
	if err := json.Unmarshal(result.Payload, &findings); err != nil {
		t.Fatalf("payload does not decode: %v", err)
	}
	if len(findings.Gaps) == 0 {
		t.Error("the payload records no gap for a run that could reach no evidence at all")
	}
	if len(findings.Tools) != 1 || findings.Tools[0].BabelTool != "" ||
		findings.Tools[0].Source != ompToolNamePublished {
		t.Errorf("bindings = %+v; want the capability recorded as published-but-unserved", findings.Tools)
	}
}

func TestOmpDriveContinuesToAResultAfterADenial(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "hosttool")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	inv.evidence = func(context.Context, babelBroker, ompEvidenceRequest) (string, error) {
		t.Error("a denied request was serviced against the broker anyway")
		return "", nil
	}
	rec := &recorder{decide: func(babelToolRequest) babelDecision {
		return babelDecision{Decision: babelDecisionDeny, Code: "policy", Reason: "the corpus is out of scope"}
	}}

	job := testJob("", babelCapabilityCorpusSearch)
	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("a denial ended the run: %v", err)
	}

	answer := ompFakeHostToolResult(t, record)
	if !answer.IsError {
		t.Fatal("the refusal was not surfaced as a tool error, so the model could not adapt to it")
	}
	text := answer.Result.Content[0].Text
	for _, want := range []string{"refused", "policy", "out of scope", "without it"} {
		if !strings.Contains(text, want) {
			t.Errorf("the refusal text never mentions %q: %s", want, text)
		}
	}
	if result.Status != babelStatusPartial {
		t.Errorf("status = %q; a refused piece of evidence leaves the run short of its scope", result.Status)
	}
	if !strings.Contains(string(result.Payload), babelDecisionDeny) {
		t.Errorf("payload does not report the denial: %s", result.Payload)
	}
	if !strings.Contains(string(result.Payload), "refused") {
		t.Errorf("payload records no gap for the refused evidence: %s", result.Payload)
	}
}

func TestOmpDriveRefusesAnUnregisteredToolWithoutSpendingADecision(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "unregistered")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{}

	job := testJob("", babelCapabilityCorpusSearch)
	if _, err := inv.investigate(context.Background(), job, rec.emit, rec.request); err != nil {
		t.Fatalf("investigate: %v", err)
	}
	if len(rec.asks) != 0 {
		t.Errorf("a tool nobody registered was still put to Babel: %+v", rec.asks)
	}
	answer := ompFakeHostToolResult(t, record)
	if !answer.IsError {
		t.Fatal("an unregistered tool call was answered as a success")
	}
}

// ── what the run records ─────────────────────────────────────────────────────

// evidenceGaps is the run's gaps other than the one every recordless run now
// carries. The evidence-path tests above are about evidence, and a fake that
// records nothing always leaves ompNoRecordsGap — asserting on the raw list
// would silently turn each of them into a test of the recording contract as
// well, and they would then fail for a reason they say nothing about.
func evidenceGaps(t *testing.T, result babelResult) []string {
	t.Helper()
	var findings ompFindings
	if err := json.Unmarshal(result.Payload, &findings); err != nil {
		t.Fatalf("payload does not decode: %v", err)
	}
	kept := make([]string, 0, len(findings.Gaps))
	for _, gap := range findings.Gaps {
		if gap != ompNoRecordsGap && gap != ompForgedCitationGap {
			kept = append(kept, gap)
		}
	}
	return kept
}

// serveOneHit is a decision that allows the request and carries one hit, which
// is what Code needs before any citation can exist: a handle is issued per
// served hit, so a run that was served nothing can record no claim at all.
func serveOneHit(babelToolRequest) babelDecision {
	return babelDecision{
		Type:     babelMessageToolDecision,
		Decision: babelDecisionAllow,
		Results:  json.RawMessage(testServedPayload),
	}
}

// TestOmpDriveRecordsWhatTheModelStructures is the acceptance case: a model that
// searches, records a candidate and develops it with a cited claim must produce
// the candidates array Babel turns into durable records, with a locator that
// came out of the payload Babel served rather than out of the model.
//
// It asserts the locator field by field against the served hit rather than
// against a constant, because the whole mechanism is that those bytes are copied
// and not retyped — a test comparing both sides to the same literal would pass
// for a build that let the model supply them.
func TestOmpDriveRecordsWhatTheModelStructures(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, _ := ompFakeBinary(t, "record")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{decide: serveOneHit}

	job := testJob("", babelCapabilityCorpusSearch)
	result, err := inv.investigate(context.Background(), job, rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	var findings ompFindings
	if err := json.Unmarshal(result.Payload, &findings); err != nil {
		t.Fatalf("payload does not decode: %v", err)
	}
	if len(findings.Candidates) != 1 {
		t.Fatalf("candidates = %+v; want the one the model recorded", findings.Candidates)
	}
	candidate := findings.Candidates[0]
	if candidate.Ref != "c1" {
		t.Errorf("candidate ref = %q; Code assigns refs, so the first is c1", candidate.Ref)
	}
	if candidate.Hypothesis.Statement == "" || candidate.Hypothesis.Novelty != 0.7 ||
		candidate.Hypothesis.Priority != 0.6 {
		t.Errorf("hypothesis = %+v; want the model's wording and both sorting signals",
			candidate.Hypothesis)
	}
	if len(candidate.Observations) != 1 {
		t.Fatalf("observations = %+v; want the one cited claim", candidate.Observations)
	}
	observation := candidate.Observations[0]
	if observation.Ref != "o1" {
		t.Errorf("observation ref = %q; want o1", observation.Ref)
	}
	// §5.1 provenance Babel matches on id and version together. The run
	// selected one recipe, so Code fills both in and the model was never asked.
	if observation.Recipe != job.Recipes[0] {
		t.Errorf("recipe = %+v; want the one this run selected, %+v", observation.Recipe, job.Recipes[0])
	}
	claim := observation.Claim
	if claim.Confidence != "moderate" || claim.Impact != "high" ||
		claim.TemporalStatus != "still-applicable" {
		t.Errorf("gradings = %+v; want the ones the model gave", claim)
	}
	if len(claim.Evidence) != 1 {
		t.Fatalf("evidence = %+v; §4.3 refuses a claim with none", claim.Evidence)
	}
	// The model cited "e1" and never saw a locator field. Everything below came
	// out of Babel's payload.
	var served babelServed
	if err := json.Unmarshal([]byte(testServedPayload), &served); err != nil {
		t.Fatalf("the test payload does not decode: %v", err)
	}
	want := served.hits()[0].Locator
	if got := claim.Evidence[0].Locator; got != want {
		t.Errorf("locator = %+v; want the served hit's own, %+v", got, want)
	}
	if claim.Evidence[0].Note == "" {
		t.Error("the citation carries no note, so nothing says what the bytes show")
	}
	// §4.3 wants counter-evidence or an explicit absence, and exactly one of
	// the two set. The model sent an empty array; Code derived the absence.
	if len(claim.CounterEvidence) != 0 || !claim.CounterEvidenceAbsent {
		t.Errorf("counter-evidence = %+v absent = %v; want the absence stated exactly once",
			claim.CounterEvidence, claim.CounterEvidenceAbsent)
	}
	if len(findings.Records) != 2 ||
		findings.Records[0].Ref != "c1" || findings.Records[1].Ref != "o1" ||
		findings.Records[0].Refusal != "" || findings.Records[1].Refusal != "" {
		t.Errorf("records = %+v; want both attempts logged as accepted", findings.Records)
	}
	if findings.NudgedForRecords {
		t.Error("a run that recorded on its own was still asked again")
	}
	if result.Status != babelStatusOK {
		t.Errorf("status = %q gaps = %v; this run recorded a cited claim and lost nothing",
			result.Status, findings.Gaps)
	}

	// The structured half of the payload, as Babel receives it. Printed rather
	// than only asserted because the shape is the deliverable and a reviewer
	// reading a failure needs to see it, not reconstruct it from field checks.
	structured, err := json.MarshalIndent(struct {
		Candidates []babelCandidate `json:"candidates"`
	}{findings.Candidates}, "", "  ")
	if err != nil {
		t.Fatalf("re-marshalling the candidates: %v", err)
	}
	t.Logf("candidates as Babel receives them:\n%s", structured)
}

// TestOmpDriveRefusesACitationItNeverServed is the provenance boundary. A model
// that cites a handle this run never issued has made a claim no reviewer can
// reopen, and Babel would keep it: its own validation checks a locator's shape,
// never that the digest belongs to anything it served. So Code refuses it here,
// and the receipt says so — a silent drop would leave the model believing the
// claim was kept and leave the operator unable to tell it from a claim never
// made.
//
// The candidate recorded before the bad citation stays. That is deliberate: one
// fabricated citation is a reason to distrust that claim, not to discard work
// that was properly cited.
func TestOmpDriveRefusesACitationItNeverServed(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "forged")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{decide: serveOneHit}

	result, err := inv.investigate(context.Background(),
		testJob("", babelCapabilityCorpusSearch), rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	var findings ompFindings
	if err := json.Unmarshal(result.Payload, &findings); err != nil {
		t.Fatalf("payload does not decode: %v", err)
	}
	if len(findings.Candidates) != 1 {
		t.Fatalf("candidates = %+v; the properly recorded candidate must survive", findings.Candidates)
	}
	if obs := findings.Candidates[0].Observations; len(obs) != 0 {
		t.Fatalf("observations = %+v; a claim citing evidence this run never served must not be kept", obs)
	}
	var refusal string
	for _, entry := range findings.Records {
		if entry.Refusal != "" {
			refusal = entry.Refusal
		}
	}
	if !strings.Contains(refusal, `"e9"`) || !strings.Contains(refusal, "not a handle this run served") {
		t.Errorf("refusal = %q; the receipt must name the handle that was cited and why it failed",
			refusal)
	}
	if !slices.Contains(findings.Gaps, ompForgedCitationGap) {
		t.Errorf("gaps = %v; a fabricated citation is a fact about the run, not just a log line",
			findings.Gaps)
	}
	if result.Status != babelStatusPartial {
		t.Errorf("status = %q; a run that fabricated a citation did not finish clean", result.Status)
	}
	// The model has to be told, in terms it can act on, or it cannot repair the
	// call — and the alternative to repairing it is inventing another citation.
	answers := ompFakeHostToolResults(t, record)
	var rejected bool
	for _, answer := range answers {
		if answer.IsError && len(answer.Result.Content) > 0 &&
			strings.Contains(answer.Result.Content[0].Text, "This record was not kept") &&
			strings.Contains(answer.Result.Content[0].Text, "e1") {
			rejected = true
		}
	}
	if !rejected {
		t.Errorf("the model was never told the citation failed or which handles exist: %+v", answers)
	}
}

// TestOmpDriveReportsAProseOnlyRunAsPartial is the failure this whole change is
// about, held as a test. The run that motivated it read the corpus eleven times,
// reasoned for five turns, returned an essay, recorded nothing, and reported
// status ok with every count at zero. It must now report partial, say why, and
// show in the receipt that it asked once more.
func TestOmpDriveReportsAProseOnlyRunAsPartial(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "plain")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{}

	result, err := inv.investigate(context.Background(),
		testJob("", babelCapabilityCorpusSearch), rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	var findings ompFindings
	if err := json.Unmarshal(result.Payload, &findings); err != nil {
		t.Fatalf("payload does not decode: %v", err)
	}
	if len(findings.Candidates) != 0 {
		t.Fatalf("candidates = %+v; this scenario records nothing", findings.Candidates)
	}
	if findings.Analysis == "" {
		t.Error("the narrative was dropped; it is still the model's own account of the run")
	}
	if !slices.Contains(findings.Gaps, ompNoRecordsGap) {
		t.Errorf("gaps = %v; a run with no records must say so", findings.Gaps)
	}
	if result.Status != babelStatusOK && result.Status != babelStatusPartial {
		t.Fatalf("status = %q is not a status this worker emits", result.Status)
	}
	if result.Status != babelStatusPartial {
		t.Errorf("status = %q; prose is not an outcome", result.Status)
	}
	if !findings.NudgedForRecords {
		t.Error("the run never asked for records, so the follow-up mechanism did not fire")
	}
	// Exactly one follow-up. A model that answers a nudge with more prose must
	// end the run rather than start a loop the operator pays for.
	prompts := 0
	for _, frame := range ompFakeFrames(t, record) {
		var probe struct{ Type string }
		_ = json.Unmarshal(frame, &probe)
		if probe.Type == ompCommandPrompt {
			prompts++
		}
	}
	if prompts != 2 {
		t.Errorf("sent %d prompts; want the brief and exactly one follow-up", prompts)
	}
}

// TestOmpDriveRecordsAfterTheFollowUp is the other half: the follow-up is only
// worth a turn if a model that ignored the contract can still satisfy it. This
// scenario answers the brief with prose and the nudge with records.
func TestOmpDriveRecordsAfterTheFollowUp(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, _ := ompFakeBinary(t, "nudged")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{decide: serveOneHit}

	result, err := inv.investigate(context.Background(),
		testJob("", babelCapabilityCorpusSearch), rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	var findings ompFindings
	if err := json.Unmarshal(result.Payload, &findings); err != nil {
		t.Fatalf("payload does not decode: %v", err)
	}
	if len(findings.Candidates) != 1 || len(findings.Candidates[0].Observations) != 1 {
		t.Fatalf("candidates = %+v; the follow-up turn recorded a candidate and a claim",
			findings.Candidates)
	}
	if !findings.NudgedForRecords {
		t.Error("the payload does not show the run needed asking, which costs the operator a turn")
	}
	if result.Status != babelStatusOK {
		t.Errorf("status = %q gaps = %v; the run ended with a cited claim and no loss",
			result.Status, findings.Gaps)
	}
}

func TestOmpDriveKeepsTheBrokerTokenOutOfTheChildsArgvAndEnvironment(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "plain")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string {
		return []string{
			"PATH=" + os.Getenv("PATH"),
			"HOME=/home/operator",
			"AMBIENT_TOKEN=" + testBrokerToken,
		}
	}
	rec := &recorder{}

	job := testJob("", babelCapabilityCorpusSearch)
	if _, err := inv.investigate(context.Background(), job, rec.emit, rec.request); err != nil {
		t.Fatalf("investigate: %v", err)
	}
	got := ompFakeRead(t, record)

	for _, arg := range got.Argv {
		if strings.Contains(arg, testBrokerToken) {
			t.Fatalf("the broker token is in the child's argv: %s", arg)
		}
	}
	for _, entry := range got.Env {
		if strings.Contains(entry, testBrokerToken) {
			t.Fatalf("the broker token is in the child's environment: %s", entry)
		}
	}
	argv := strings.Join(got.Argv, " ")
	for _, want := range []string{"--mode rpc", "--no-tools", "--auto-approve", "--config"} {
		if !strings.Contains(argv, want) {
			t.Errorf("argv is missing %q: %s", want, argv)
		}
	}
	home := ""
	for _, entry := range got.Env {
		if key, value, _ := strings.Cut(entry, "="); key == "HOME" {
			home = value
		}
	}
	if home == "/home/operator" || !strings.Contains(home, "code-babel-run-") {
		t.Errorf("HOME = %q; the child must run in the run's private home", home)
	}
}

// TestOmpDriveGivesTheChildAUsableProviderCredential is the property the whole
// path exists for: an OMP started under Babel has to be able to authenticate.
// It asserts against the environment the child actually received — recorded by
// the child itself — rather than against what the driver believes it built,
// because a credential the driver assembled and did not pass would satisfy the
// second and fail the run.
func TestOmpDriveGivesTheChildAUsableProviderCredential(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "plain")
	inv.lookOmp = func() (string, error) { return fake, nil }
	// Nothing ambient: the credential in the child's environment can only have
	// come from the run's own resolution.
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{}

	if _, err := inv.investigate(context.Background(), testJob("", babelCapabilityCorpusSearch), rec.emit, rec.request); err != nil {
		t.Fatalf("investigate: %v", err)
	}
	got := ompFakeRead(t, record)
	index := map[string]string{}
	for _, entry := range got.Env {
		key, value, _ := strings.Cut(entry, "=")
		index[key] = value
	}
	want := testAuth()
	if index["OMP_AUTH_BROKER_URL"] != want.broker.URL {
		t.Errorf("the child's OMP_AUTH_BROKER_URL = %q, want %q", index["OMP_AUTH_BROKER_URL"], want.broker.URL)
	}
	if index["OMP_AUTH_BROKER_TOKEN"] != want.broker.Token {
		t.Error("the child received no usable provider credential, so no real exploration could authenticate")
	}
	if index["OMP_AUTH_BROKER_SNAPSHOT_CACHE"] != want.broker.SnapshotCache {
		t.Errorf("the child's snapshot cache = %q, want %q",
			index["OMP_AUTH_BROKER_SNAPSHOT_CACHE"], want.broker.SnapshotCache)
	}
	// The pool is a file the child must be able to open, so the child reading
	// it is the assertion; a path alone would prove only that a string was set.
	if got.Pool == "" {
		t.Fatal("the child could not read the run's account pool")
	}
	var pool map[string][]string
	if err := json.Unmarshal([]byte(got.Pool), &pool); err != nil {
		t.Fatalf("the account pool the child read does not parse: %v", err)
	}
	if !reflect.DeepEqual(pool[anthropicProvider], want.pool[anthropicProvider]) {
		t.Errorf("the child's account pool = %v, want %v", pool, want.pool)
	}
	if index["OMP_AUTH_BROKER_ACCOUNT_POOL_FILE"] == "" {
		t.Fatal("no account pool file was named")
	}
	// The pool carries the run's account policy, so it is disposed of with the
	// run rather than left in a temporary directory nobody owns.
	if _, err := os.Stat(index["OMP_AUTH_BROKER_ACCOUNT_POOL_FILE"]); !os.IsNotExist(err) {
		t.Errorf("the account pool outlived the run at %q (stat error %v)",
			index["OMP_AUTH_BROKER_ACCOUNT_POOL_FILE"], err)
	}
}

// TestOmpDriveKeepsTheProviderCredentialOutOfTheArgvAndTheStream holds the
// credential to the confinement the broker token already has: argv is a process
// listing, and everything the investigator emits becomes an event Babel records
// durably.
func TestOmpDriveKeepsTheProviderCredentialOutOfTheArgvAndTheStream(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	fake, record := ompFakeBinary(t, "plain")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{}

	result, err := inv.investigate(context.Background(), testJob("", babelCapabilityCorpusSearch), rec.emit, rec.request)
	if err != nil {
		t.Fatalf("investigate: %v", err)
	}
	for _, arg := range ompFakeRead(t, record).Argv {
		if strings.Contains(arg, testProviderToken) {
			t.Fatalf("the provider credential is in the child's argv: %s", arg)
		}
	}
	for _, message := range append(append([]string{}, rec.messages...), rec.stages...) {
		if strings.Contains(message, testProviderToken) {
			t.Fatalf("the provider credential reached the progress stream: %s", message)
		}
	}
	if strings.Contains(string(result.Payload), testProviderToken) {
		t.Fatal("the provider credential reached the result payload")
	}
}

// TestOmpDriveHonoursADisabledAccount runs the resolution the operator's
// machine runs — broker snapshot, selection file, pool — and checks the account
// they disabled is absent from what the child is routed through. A worker that
// ignored the selection would put a supervised run on an account taken out of
// service, which is the one thing the pool file exists to prevent.
func TestOmpDriveHonoursADisabledAccount(t *testing.T) {
	const snapshot = `{"credentials":[
		{"provider":"anthropic","identityKey":"kept","credential":{"type":"oauth","email":"kept@example.com"}},
		{"provider":"anthropic","identityKey":"retired","credential":{"type":"oauth","email":"retired@example.com"}}
	]}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(snapshot))
	}))
	defer server.Close()

	state := filepath.Join(t.TempDir(), "accounts.json")
	selections := defaultAccountSelectionState()
	selections.SetManualDisabled(map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "retired"}: true})
	if err := writeAccountSelectionState(state, selections); err != nil {
		t.Fatalf("writing the account selection: %v", err)
	}
	t.Setenv("OMP_AUTH_BROKER_URL", server.URL)
	t.Setenv("OMP_AUTH_BROKER_TOKEN", testProviderToken)
	t.Setenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE", "")
	t.Setenv("CODE_AUTH_ACCOUNT_STATE", state)

	inv, _ := newTestInvestigator(t)
	inv.auth = ompResolveAuth
	if _, err := inv.resolveCredential(); err != nil {
		t.Fatalf("resolveCredential: %v", err)
	}
	fake, record := ompFakeBinary(t, "plain")
	inv.lookOmp = func() (string, error) { return fake, nil }
	inv.environ = func() []string { return []string{"PATH=" + os.Getenv("PATH")} }
	rec := &recorder{}

	if _, err := inv.investigate(context.Background(), testJob("", babelCapabilityCorpusSearch), rec.emit, rec.request); err != nil {
		t.Fatalf("investigate: %v", err)
	}
	var pool map[string][]string
	if err := json.Unmarshal([]byte(ompFakeRead(t, record).Pool), &pool); err != nil {
		t.Fatalf("the account pool the child read does not parse: %v", err)
	}
	if !reflect.DeepEqual(pool[anthropicProvider], []string{"kept"}) {
		t.Errorf("the run's anthropic pool = %v, want only the account the operator left enabled", pool[anthropicProvider])
	}
}

// TestOmpResolveAuthWithNoBrokerNamesTheRemedy is the honest failure. A worker
// that launched anyway would produce an authentication error from inside OMP,
// attributed to the analysis, in a receipt with no way back to the cause.
func TestOmpResolveAuthWithNoBrokerNamesTheRemedy(t *testing.T) {
	t.Setenv("OMP_AUTH_BROKER_URL", "")
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "")
	t.Setenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE", "")
	t.Setenv("CODE_AUTH_VAULTS", "")
	t.Setenv("CODE_AUTH_VAULTS_FILE", "")
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	_, err := ompResolveAuth()
	if !errors.Is(err, errOmpNoCredential) {
		t.Fatalf("error = %v; want errOmpNoCredential", err)
	}
	for _, remedy := range []string{"OMP_AUTH_BROKER_TOKEN", ompVaultManifestName, "CODE_AUTH_VAULTS_FILE"} {
		if !strings.Contains(err.Error(), remedy) {
			t.Errorf("the failure does not name %q, so an operator cannot act on it: %v", remedy, err)
		}
	}
}

// TestOmpResolveAuthReadsCodesOwnVaultManifest is why the failure above is not
// the only outcome under Babel. Babel's curated environment exports no broker
// variables by design, but it does hand the worker the operator's real HOME,
// and the manifest and the token file it names live there.
func TestOmpResolveAuthReadsCodesOwnVaultManifest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"credentials":[]}`))
	}))
	defer server.Close()

	home := t.TempDir()
	tokenFile := filepath.Join(home, "token")
	if err := os.WriteFile(tokenFile, []byte(testProviderToken+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(home, ".config", "code")
	if err := os.MkdirAll(config, 0o700); err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal([]map[string]string{{"brokerUrl": server.URL, "tokenFile": tokenFile}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(config, ompVaultManifestName), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	// Exactly what Babel spawns a worker with: a real HOME and nothing else.
	t.Setenv("OMP_AUTH_BROKER_URL", "")
	t.Setenv("OMP_AUTH_BROKER_TOKEN", "")
	t.Setenv("OMP_AUTH_BROKER_SNAPSHOT_CACHE", "")
	t.Setenv("CODE_AUTH_VAULTS", "")
	t.Setenv("CODE_AUTH_VAULTS_FILE", "")
	t.Setenv("CODE_AUTH_ACCOUNT_STATE", "")
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", home)

	auth, err := ompResolveAuth()
	if err != nil {
		t.Fatalf("ompResolveAuth: %v", err)
	}
	if auth.broker.Token != testProviderToken {
		t.Error("the credential Code stores under the operator's HOME did not resolve")
	}
}

// TestOmpDriveWithoutACredentialRefusesToLaunch pins the order: no credential
// means no child, not a child that fails later for a reason the receipt cannot
// explain.
func TestOmpDriveWithoutACredentialRefusesToLaunch(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	inv.credential = ompAuth{}
	fake, record := ompFakeBinary(t, "plain")
	inv.lookOmp = func() (string, error) { return fake, nil }
	rec := &recorder{}

	_, err := inv.investigate(context.Background(), testJob("", babelCapabilityCorpusSearch), rec.emit, rec.request)
	if !errors.Is(err, errOmpNoCredential) {
		t.Fatalf("error = %v; want errOmpNoCredential", err)
	}
	if _, statErr := os.Stat(record); statErr == nil {
		t.Error("omp was launched with nothing to authenticate with")
	}
}

// TestOmpResolveCredentialRefusesAnUnconfiguredBroker keeps the seam total: a
// resolver that answers with an empty broker and no error must not be read as
// a credential.
func TestOmpResolveCredentialRefusesAnUnconfiguredBroker(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	inv.auth = func() (ompAuth, error) { return ompAuth{broker: brokerConfig{URL: "http://broker.invalid"}}, nil }
	if _, err := inv.resolveCredential(); !errors.Is(err, errOmpNoCredential) {
		t.Fatalf("error = %v; want errOmpNoCredential", err)
	}
}

// TestOmpResolveCredentialReportsTheSecretsToScrub is the contract the protocol
// layer relies on: it cannot scrub what it is not told about, and OMP's own
// diagnostics are forwarded into the run's failure record.
func TestOmpResolveCredentialReportsTheSecretsToScrub(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	secrets, err := inv.resolveCredential()
	if err != nil {
		t.Fatalf("resolveCredential: %v", err)
	}
	found := false
	for _, secret := range secrets {
		if secret == testProviderToken {
			found = true
		}
	}
	if !found {
		t.Errorf("the provider credential was not reported for scrubbing: %v", secrets)
	}
}

func TestOmpDriveWithoutAnOmpFails(t *testing.T) {
	inv, _ := newTestInvestigator(t)
	rec := &recorder{}
	_, err := inv.investigate(context.Background(), testJob("", babelCapabilityCorpusSearch), rec.emit, rec.request)
	if err == nil {
		t.Fatal("a run with no omp to drive reported success")
	}
}

// ── the fake OMP ─────────────────────────────────────────────────────────────
//
// The driver needs a counterpart that speaks OMP's RPC frames, calls a host
// tool, and can be left running so a cancellation has a tree to kill. Nothing
// about that needs a provider, so the fake is this test binary re-executed
// through a one-line shell wrapper: a real process, with a real argv, a real
// environment and real children, which is what the argv, environment and
// process-tree assertions above are actually about.

// ompFakeArgv is the sentinel the wrapper plants. It is an argument rather than
// an environment variable because the driver owns the child's environment and a
// test hook has no business in it.
const ompFakeArgv = "--omp-fake"

type ompFakeRecord struct {
	Argv    []string          `json:"argv"`
	Env     []string          `json:"env"`
	Frames  []json.RawMessage `json:"frames"`
	Sleeper int               `json:"sleeper"`
	// Pool is the account-pool document as the child managed to read it. The
	// driver deletes the run directory when the run ends, so a test that only
	// looked at the path afterwards could not tell a readable pool from a name.
	Pool string `json:"pool"`
}

// ompFakeBinary writes a wrapper that re-executes this test binary as the fake
// OMP, and returns the wrapper's path plus the file it records to.
func ompFakeBinary(t *testing.T, scenario string) (binary, record string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	dir := t.TempDir()
	record = filepath.Join(dir, "record.json")
	binary = filepath.Join(dir, "fake-omp")
	script := "#!/bin/sh\nexec " + shellSingleQuote(self) +
		" -test.run='^TestOmpFakeHelper$' -- " + ompFakeArgv + " " + scenario + " " +
		shellSingleQuote(record) + " \"$0\" \"$@\"\n"
	if err := os.WriteFile(binary, []byte(script), 0o700); err != nil {
		t.Fatalf("writing the fake omp: %v", err)
	}
	return binary, record
}

// ompFakeStaticBinary is ompFakeBinary for a run that will happen inside the
// sandbox.
//
// The wrapper form above cannot be used there and should not be: it is a
// `#!/bin/sh` script, and a contained run has no /bin/sh and no libc outside the
// Nix store, so the sandbox refuses to start it — correctly. This form is a copy
// of the test binary, which is statically linked and is the one executable the
// backend already binds inside, and the scenario travels in the environment
// because the driver owns OMP's command line.
const (
	ompFakeScenarioEnv = "CODE_OMP_FAKE_SCENARIO"
	ompFakeRecordEnv   = "CODE_OMP_FAKE_RECORD"
)

func ompFakeStaticBinary(t *testing.T, scenario string) (binary, record string) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	body, err := os.ReadFile(self)
	if err != nil {
		t.Fatalf("reading this test binary: %v", err)
	}
	dir := t.TempDir()
	record = filepath.Join(dir, "record.json")
	binary = filepath.Join(dir, "fake-omp")
	if err := os.WriteFile(binary, body, 0o700); err != nil {
		t.Fatalf("writing the fake omp: %v", err)
	}
	t.Setenv(ompFakeScenarioEnv, scenario)
	t.Setenv(ompFakeRecordEnv, record)
	return binary, record
}

func shellSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func ompFakeRead(t *testing.T, record string) ompFakeRecord {
	t.Helper()
	data, err := os.ReadFile(record)
	if err != nil {
		t.Fatalf("the fake omp recorded nothing: %v", err)
	}
	var got ompFakeRecord
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("the fake omp's record does not parse: %v", err)
	}
	return got
}

func ompFakeFrames(t *testing.T, record string) []json.RawMessage {
	t.Helper()
	return ompFakeRead(t, record).Frames
}

func ompFakeToolNames(t *testing.T, record string) []string {
	t.Helper()
	for _, frame := range ompFakeFrames(t, record) {
		var command ompSetHostToolsCommand
		if err := json.Unmarshal(frame, &command); err != nil || command.Type != ompCommandSetHostTools {
			continue
		}
		names := make([]string, 0, len(command.Tools))
		for _, tool := range command.Tools {
			names = append(names, tool.Name)
		}
		return names
	}
	t.Fatal("the fake omp never received set_host_tools")
	return nil
}

func ompFakeHostToolResult(t *testing.T, record string) ompHostToolResult {
	t.Helper()
	for _, frame := range ompFakeFrames(t, record) {
		var answer ompHostToolResult
		if err := json.Unmarshal(frame, &answer); err != nil || answer.Type != ompFrameHostToolResult {
			continue
		}
		if len(answer.Result.Content) == 0 {
			t.Fatalf("the host tool result carried no content: %s", frame)
		}
		return answer
	}
	t.Fatal("the fake omp never received a host tool result")
	return ompHostToolResult{}
}

// ompFakeHostToolResults is every host tool answer the fake received, for the
// scenarios that make more than one call and care about a later one.
func ompFakeHostToolResults(t *testing.T, record string) []ompHostToolResult {
	t.Helper()
	var answers []ompHostToolResult
	for _, frame := range ompFakeFrames(t, record) {
		var answer ompHostToolResult
		if err := json.Unmarshal(frame, &answer); err != nil || answer.Type != ompFrameHostToolResult {
			continue
		}
		answers = append(answers, answer)
	}
	if len(answers) == 0 {
		t.Fatal("the fake omp never received a host tool result")
	}
	return answers
}

// TestOmpFakeHelper is not an assertion. It is the entry point the wrapper
// re-executes, and it exits before the testing package writes anything, because
// its stdout is the driver's RPC stream.
func TestOmpFakeHelper(t *testing.T) {
	args := ompFakeArgs()
	if args == nil {
		t.Skip("this test is the fake omp the driver tests spawn")
	}
	ompFakeMain(args)
}

func ompFakeArgs() []string {
	for i, arg := range os.Args {
		if arg == ompFakeArgv && i+2 < len(os.Args) {
			return os.Args[i+1:]
		}
	}
	return nil
}

func ompFakeMain(args []string) {
	scenario, record := args[0], args[1]
	state := ompFakeRecord{Argv: args[2:], Env: os.Environ()}
	if pool, err := os.ReadFile(os.Getenv("OMP_AUTH_BROKER_ACCOUNT_POOL_FILE")); err == nil {
		state.Pool = string(pool)
	}
	save := func() {
		body, err := json.Marshal(state)
		if err == nil {
			_ = os.WriteFile(record, body, 0o600)
		}
	}
	save()

	if scenario == "sleeper" {
		state.Sleeper = os.Getpid()
		save()
		time.Sleep(10 * time.Minute)
		os.Exit(0)
	}

	if scenario == "credleak" {
		// The child prints the provider credential exactly where a real OMP
		// prints an authentication failure, and dies without a ready frame so
		// the driver folds that stderr tail into the run's error. From here
		// only the worker's own scrubbing keeps it off the wire.
		_, _ = os.Stderr.WriteString("omp: authentication rejected for " +
			os.Getenv("OMP_AUTH_BROKER_TOKEN") + "\n")
		os.Exit(1)
	}

	emit := func(frame string) {
		_, _ = os.Stdout.WriteString(frame + "\n")
	}
	emit(`{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576}`)

	lines := bufio.NewScanner(os.Stdin)
	lines.Buffer(make([]byte, 0, 64<<10), ompFrameBytes)
	prompts, answered := 0, 0
	for lines.Scan() {
		line := bytes.TrimSpace(lines.Bytes())
		if len(line) == 0 {
			continue
		}
		state.Frames = append(state.Frames, json.RawMessage(append([]byte(nil), line...)))
		save()

		var command struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		_ = json.Unmarshal(line, &command)
		switch command.Type {
		case ompCommandSetHostTools:
			emit(`{"id":"` + command.ID + `","type":"response","command":"set_host_tools",` +
				`"success":true,"data":{"toolNames":[]}}`)
		case ompCommandPrompt:
			emit(`{"id":"` + command.ID + `","type":"response","command":"prompt",` +
				`"success":true,"data":{"agentInvoked":true}}`)
			prompts++
			ompFakePlay(scenario, prompts, record, &state, save, emit)
		case ompFrameHostToolResult:
			answered++
			ompFakeAdvance(scenario, answered, emit)
		}
	}
	os.Exit(0)
}

// The tool calls the scenarios make. They are constants because two scenarios
// share the first two and differ only in the third, which is the whole point of
// the forged-citation scenario: it is a run that behaved until the moment it
// cited something.
const (
	ompFakeSearchCall = `{"type":"host_tool_call","id":"host_1","toolCallId":"toolu_1",` +
		`"toolName":"babel_corpus_search","arguments":{"query":"outcome integrity","limit":3}}`

	// ompFakeHypothesisCall is a well-formed candidate: the three fields Babel
	// refuses a record without, and nothing invented.
	ompFakeHypothesisCall = `{"type":"host_tool_call","id":"host_2","toolCallId":"toolu_2",` +
		`"toolName":"babel_record_hypothesis","arguments":{` +
		`"statement":"handoffs between agents drop a constraint that was stated once",` +
		`"origin_cues":["a constraint restated three turns after the handoff"],` +
		`"labels":["coordination"],"novelty":0.7,"priority":0.6,` +
		`"notes":"seen in one session so far; worth a second pass"}}`

	// ompFakeObservationCall cites the handle Code issued for the hit the search
	// returned, which is the only citation the driver accepts.
	ompFakeObservationCall = `{"type":"host_tool_call","id":"host_3","toolCallId":"toolu_3",` +
		`"toolName":"babel_record_observation","arguments":{` +
		`"hypothesis":"c1","claim":"the reviewer restated the constraint the handoff had omitted",` +
		`"category":"coordination","confidence":"moderate","impact":"high",` +
		`"temporal_status":"still-applicable",` +
		`"evidence":[{"hit":"e1","note":"the constraint appears only after the handoff"}],` +
		`"counter_evidence":[]}}`

	// ompFakeForgedCitationCall cites a handle this run never issued. It is the
	// one thing a model can do here that no repair turn can fix after the fact:
	// a locator nobody can reopen reads exactly like provenance.
	ompFakeForgedCitationCall = `{"type":"host_tool_call","id":"host_3","toolCallId":"toolu_3",` +
		`"toolName":"babel_record_observation","arguments":{` +
		`"hypothesis":"c1","claim":"the same constraint is dropped in nine other sessions",` +
		`"confidence":"high","impact":"high",` +
		`"evidence":[{"hit":"e9","note":"nine sessions show the same drop"}],` +
		`"counter_evidence":[]}}`
)

// ompFakePlay is the scenario: what the fake does once it has been prompted.
//
// prompt is which prompt this is. A run that recorded nothing gets exactly one
// follow-up from the driver, and a real model does not answer that by repeating
// its whole tool sequence — so only "nudged" does anything on the second prompt,
// and every other scenario answers with prose again, which is what a run that
// ignores the follow-up looks like.
func ompFakePlay(scenario string, prompt int, record string, state *ompFakeRecord, save func(), emit func(string)) {
	emit(`{"type":"agent_start"}`)
	emit(`{"type":"turn_start"}`)
	if prompt > 1 {
		if scenario == "nudged" {
			emit(ompFakeSearchCall)
			return
		}
		ompFakeFinish(emit)
		return
	}
	switch scenario {
	case "hosttool", "record", "forged":
		emit(ompFakeSearchCall)
	case "unregistered":
		emit(`{"type":"host_tool_call","id":"host_1","toolCallId":"toolu_1",` +
			`"toolName":"bash","arguments":{"command":"whoami"}}`)
	case "hang":
		// A grandchild in the same process group, so a cancellation that only
		// signals the direct child leaves something measurable behind.
		self, err := os.Executable()
		if err == nil {
			child := exec.Command(self, "-test.run=^TestOmpFakeHelper$", "--",
				ompFakeArgv, "sleeper", record+".sleeper")
			if child.Start() == nil {
				state.Sleeper = child.Process.Pid
				save()
			}
		}
	default:
		ompFakeFinish(emit)
	}
}

// ompFakeAdvance is what the fake does once the host has answered a tool call.
//
// answered counts those answers, so a scenario is a sequence rather than a
// single call. That sequencing is not decoration: a citation can only name a
// handle a search already produced, so the recording path is unreachable except
// from a run that searched first, which is exactly the ordering a real run has.
func ompFakeAdvance(scenario string, answered int, emit func(string)) {
	switch scenario {
	case "record", "nudged":
		switch answered {
		case 1:
			emit(ompFakeHypothesisCall)
			return
		case 2:
			emit(ompFakeObservationCall)
			return
		}
	case "forged":
		switch answered {
		case 1:
			emit(ompFakeHypothesisCall)
			return
		case 2:
			emit(ompFakeForgedCitationCall)
			return
		}
	}
	ompFakeFinish(emit)
}

func ompFakeFinish(emit func(string)) {
	emit(`{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"ignore me"},` +
		`"message":{"role":"assistant","content":[]}}`)
	emit(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta",` +
		`"delta":"the corpus supports the finding"},"message":{"role":"assistant","content":[]}}`)
	emit(`{"type":"turn_end"}`)
	emit(`{"type":"agent_end","messages":[],"isTerminal":true}`)
}
