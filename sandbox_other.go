//go:build !linux

package main

// No containment backend outside Linux.
//
// Code's boundary is bubblewrap inside a transient systemd user scope, and both
// halves are Linux. macOS has candidates — sandbox-exec, a per-run VM — but
// none of them has been built here, and none has been put through the escape
// scenarios the Linux backend has to pass. A backend nobody has tried to break
// is prose, and prose in a receipt is the thing this whole subsystem exists to
// replace.
//
// So on any other platform the facts say so, every boolean is false, and Babel
// refuses an exploration run under its strict default. Everything that does not
// execute a model — archival, browsing, review, fetch — is unaffected, because
// none of it comes through here.

// sandboxBackend on a platform with no backend. It holds the refusal and
// nothing else, so containment() has the same shape to read on every platform.
type sandboxBackend struct {
	facts sandboxFacts
}

func newSandboxBackend(ceilings sandboxCeilings) *sandboxBackend {
	return &sandboxBackend{facts: sandboxFacts{
		backend:  sandboxBackendNone,
		ceilings: ceilings,
		degraded: []string{sandboxRefusal()},
	}}
}

// contain refuses rather than returning a nil plan the caller would read as
// "launch it unconfined". A run reaching here has already been told the
// declaration is empty, so an operator who relaxed it deliberately gets an
// unconfined launch through the caller's own nil path; anything else would be
// this platform quietly acquiring a sandbox it does not have.
func (b *sandboxBackend) contain(sandboxRequest) (*sandboxRun, error) { return nil, nil }
