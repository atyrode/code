package main

// The configuration ceremony — `code engine --configure --result-file PATH`.
//
// A client that supervises `code engine` needs a profile to launch under, and
// the one thing it must not be able to do is choose that profile for itself:
// a configuration resolved from an argument, an environment variable or Code's
// compiled defaults would be attributed, in the client's records, to an
// operator who never saw it. So the dials are turned by a human, in Code's own
// interactive UI, on a terminal the client hands over for exactly that purpose.
//
// This mode is therefore not the engine at all. There is no OMP, no stream:
// stdin and stdout are the operator's terminal, Bubble Tea owns them, and the
// one machine-readable byte this mode produces is the reference written to
// --result-file. The client reads it back, stores it, and treats any nonzero
// exit — a cancelled ceremony included — as "configuration unchanged".
//
// The mode refuses without a terminal rather than falling back to anything. A
// fallback is what the ceremony exists to remove, so an unattended invocation
// never silently produces a profile.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/mattn/go-isatty"
)

// configureResult is the whole answer this mode gives a client: which profile
// the operator confirmed, and at which revision. Nothing about the dials
// themselves travels through the file — the client resolves the reference
// through --describe or a launch when it needs the configuration behind it,
// which is what keeps one copy of that answer rather than two that can
// disagree.
type configureResult struct {
	Profile  string `json:"profile"`
	Revision int    `json:"revision"`
}

// errNoOperatorTerminal reports that this mode was reached without a human at
// the other end.
var errNoOperatorTerminal = errors.New(
	"--configure needs the operator's terminal on stdin and stdout: the dials are turned by hand, " +
		"and there is no fallback that could mint a profile without them")

// runEngineConfigure is the ceremony: hand the operator Code's dial UI, and
// mint a profile revision out of what they confirm.
//
// Exit status is the whole protocol on this side. 0 means the reference in
// --result-file is the operator's answer; 2 means the invocation itself was
// wrong (no terminal, no result file); 1 means there is no new configuration —
// the ceremony was cancelled, or minting it failed. A client reads every
// nonzero status as "unchanged", so a cancelled ceremony is a normal outcome
// rather than a failure to explain.
func runEngineConfigure(opts engineOptions) int {
	if opts.resultFile == "" {
		fmt.Fprintln(os.Stderr, "code engine: --configure needs --result-file PATH to answer through")
		return 2
	}
	if err := requireOperatorTerminal(); err != nil {
		fmt.Fprintln(os.Stderr, "code engine:", err)
		return 2
	}
	final, err := runInteractive(newInteractiveApp(interactiveConfigure))
	if err != nil {
		fmt.Fprintln(os.Stderr, "code engine: configure:", err)
		return 1
	}
	return commitConfiguration(final, opts)
}

// commitConfiguration turns the ceremony's end state into the client's answer.
// It is separate from the run above it because it is the part with a rule: what
// the operator left behind decides whether a revision is minted and whether the
// reference file is written at all, and that decision has to be readable — and
// testable — without a terminal to drive.
func commitConfiguration(final model, opts engineOptions) int {
	if !final.configureConfirmed() {
		// Leaving is a decision, and it is the one that has to be cheap: an
		// operator who opens the ceremony to look at the dials must be able to
		// walk away without changing what the client is holding. Nothing is
		// minted and nothing is written, so the client reads its own file as
		// absent and reports the configuration unchanged.
		fmt.Fprintln(os.Stderr, "code engine: nothing was confirmed; the configuration is unchanged")
		return 1
	}
	profile, err := mintProfile(final, opts.profile.ID)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code engine: recording the configuration:", err)
		return 1
	}
	// The revision is committed before the reference is handed over, so the
	// client never records a reference that does not resolve. The other order
	// would trade that for the harmless case this one leaves behind: a
	// revision in Code's own append-only history that nothing points at.
	if err := writeConfigureResult(opts.resultFile, profile.ref()); err != nil {
		fmt.Fprintln(os.Stderr, "code engine: answering through", opts.resultFile+":", err)
		return 1
	}
	fmt.Fprintf(os.Stderr, "code engine: configured profile %s@%d (%s)\n",
		profile.ID, profile.Revision, profile.digest())
	return 0
}

// requireOperatorTerminal reports whether a human can actually be asked. Both
// descriptors are checked: Bubble Tea reads keys from stdin and paints to
// stdout, so a ceremony missing either one cannot be answered — and a pipe on
// stdout in particular is how this mode would be reached by something intending
// to parse it, which it must not encourage by half working.
func requireOperatorTerminal() error {
	if !isatty.IsTerminal(os.Stdin.Fd()) || !isatty.IsTerminal(os.Stdout.Fd()) {
		return errNoOperatorTerminal
	}
	return nil
}

// configureConfirmed reports whether the operator ended the ceremony with a
// configuration rather than by leaving.
//
// It reads the same fields a launch reads, because the confirming keypress is
// the same one: Enter on a generated combination leaves the rendered overlay
// behind, Enter on a delegated local runtime names that target, and Enter on the
// local model dial names the model (locallane.go). The launch keys that produce
// none of those are inert during a ceremony (update.go), so there is no fourth
// state where something was chosen but nothing can be described.
//
// Enter itself is inert where a launch would be: a combination the catalog does
// not generate, and a machine where no provider credential was discovered. Both
// end the ceremony unchanged rather than minting a profile nothing could run,
// which is the same judgement the launch path makes about the same dials.
func (m model) configureConfirmed() bool {
	return m.genConfig != "" || m.launchRuntime != "" || m.localConfirmed != ""
}

// mintProfile records the dials the operator confirmed as a profile revision.
// The selection is described and stored exactly as it stands in the model that
// was on screen — no repair, no clamping, no defaulting — because what the
// operator confirmed and what the client records must be the same thing. The
// UI has already clamped every dial to what the catalog serves as it was
// turned.
//
// An unchanged confirmation returns the current revision rather than a new one
// (profileStore.save), so opening the ceremony to check the dials and confirming
// them again does not inflate the history a client holds references into.
//
// A local profile is checked against its endpoint before it is written, and the
// check is a refusal rather than a warning. Nothing else in this ceremony can
// tell an operator that the daemon they dialled has gone away, and the
// alternative is a reference a client stores, resolves, launches, and fails —
// with a record that can only report that the run did not work. The endpoint
// answered when the dial was built moments ago, so a refusal here is rare and
// specific: the daemon stopped, or it no longer serves that model.
func mintProfile(m model, id string) (codeProfile, error) {
	profile := describeDials(m, id)
	if isLocalProfile(profile.Metadata) {
		target, err := localTargetOf(profile.Metadata)
		if err != nil {
			return codeProfile{}, err
		}
		if err := confirmLocalEndpoint(target); err != nil {
			return codeProfile{}, err
		}
	}
	return newProfileStore("").save(profile)
}

// writeConfigureResult hands the client the reference. The file is truncated
// and written whole in one call — the client reads it once, after this process
// exits, so there is no partial-read window to protect against — and the mode
// is set explicitly rather than left to the umask: the reference names an
// operator's configuration, and a client keeps such a file private, so Code
// widening it would be the one weakening the arrangement.
func writeConfigureResult(path string, ref profileRef) error {
	encoded, err := json.Marshal(configureResult{Profile: ref.ID, Revision: ref.Revision})
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	// fchmod, not a path chmod: the descriptor is already open, so the mode
	// lands on the file this process wrote rather than on whatever the path
	// names by then.
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(append(encoded, '\n')); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
