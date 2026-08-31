package main

// The configuration ceremony — `code babel --configure --result-file PATH`.
//
// Babel's `analysis profile configure` used to ask this process to work the
// dials out for itself: an argument here, an environment variable there, Code's
// compiled defaults if neither said anything. Every one of those paths could
// mint a profile that a receipt then attributes to an operator who never saw it
// (atyrode/babel#86). The dials are now turned by a human, in Code's own
// interactive UI, on a terminal Babel hands over for exactly that purpose.
//
// So this mode is not part of the analysis-worker protocol at all. There is no
// hello, no accept, no stream: stdin and stdout are the operator's terminal,
// Bubble Tea owns them, and the one machine-readable byte this mode produces is
// the reference written to --result-file. Babel reads it back, stores it the way
// it always did, and treats any nonzero exit — a cancelled ceremony included —
// as "configuration unchanged".
//
// The mode refuses without a terminal rather than falling back to anything. A
// fallback is what the ceremony exists to remove, and Babel refuses on its side
// too, so the two refusals mean an unattended `analysis profile configure` never
// silently produces a profile.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/mattn/go-isatty"
)

// babelConfigureResult is the whole answer this mode gives Babel: which profile
// the operator confirmed, and at which revision. Nothing about the dials
// themselves travels through the file — Babel resolves the reference through
// worker mode when it needs the configuration behind it, which is what keeps one
// copy of that answer rather than two that can disagree.
type babelConfigureResult struct {
	Profile  string `json:"profile"`
	Revision int    `json:"revision"`
}

// errNoOperatorTerminal reports that this mode was reached without a human at
// the other end.
var errNoOperatorTerminal = errors.New(
	"--configure needs the operator's terminal on stdin and stdout: the dials are turned by hand, " +
		"and there is no fallback that could mint a profile without them")

// runBabelConfigure is the ceremony: hand the operator Code's dial UI, and mint
// a profile revision out of what they confirm.
//
// Exit status is the whole protocol on this side. 0 means the reference in
// --result-file is the operator's answer; 2 means the invocation itself was
// wrong (no terminal, no result file); 1 means there is no new configuration —
// the ceremony was cancelled, or minting it failed. Babel reads every nonzero
// status as "unchanged" and says so, so a cancelled ceremony is a normal outcome
// rather than a failure to explain.
func runBabelConfigure(opts babelOptions) int {
	if opts.resultFile == "" {
		fmt.Fprintln(os.Stderr, "code babel: --configure needs --result-file PATH to answer through")
		return 2
	}
	if err := requireOperatorTerminal(); err != nil {
		fmt.Fprintln(os.Stderr, "code babel:", err)
		return 2
	}
	final, err := runInteractive(newInteractiveApp(interactiveConfigure))
	if err != nil {
		fmt.Fprintln(os.Stderr, "code babel: configure:", err)
		return 1
	}
	return babelCommitConfiguration(final, opts)
}

// babelCommitConfiguration turns the ceremony's end state into Babel's answer.
// It is separate from the run above it because it is the part with a rule: what
// the operator left behind decides whether a revision is minted and whether the
// reference file is written at all, and that decision has to be readable — and
// testable — without a terminal to drive.
func babelCommitConfiguration(final model, opts babelOptions) int {
	if !final.configureConfirmed() {
		// Leaving is a decision, and it is the one that has to be cheap: an
		// operator who opens the ceremony to look at the dials must be able to
		// walk away without changing what Babel is holding. Nothing is minted
		// and nothing is written, so Babel reads its own file as absent and
		// reports the configuration unchanged.
		fmt.Fprintln(os.Stderr, "code babel: nothing was confirmed; the configuration is unchanged")
		return 1
	}
	profile, err := babelMintProfile(final, opts.profileID)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code babel: recording the configuration:", err)
		return 1
	}
	// The revision is committed before the reference is handed over, so Babel
	// never records a reference that does not resolve. The other order would
	// trade that for the harmless case this one leaves behind: a revision in
	// Code's own append-only history that nothing points at.
	if err := writeBabelConfigureResult(opts.resultFile, profile.ref()); err != nil {
		fmt.Fprintln(os.Stderr, "code babel: answering through", opts.resultFile+":", err)
		return 1
	}
	fmt.Fprintf(os.Stderr, "code babel: configured profile %s@%d (%s)\n",
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
// behind, and Enter on a delegated local runtime names that target. The launch
// keys that produce neither are inert during a ceremony (update.go), so there is
// no third state where something was chosen but nothing can be described.
//
// Enter itself is inert where a launch would be: a combination the catalog does
// not generate, and a machine where no provider credential was discovered. Both
// end the ceremony unchanged rather than minting a profile nothing could run,
// which is the same judgement the launch path makes about the same dials.
func (m model) configureConfirmed() bool {
	return m.genConfig != "" || m.launchRuntime != ""
}

// babelMintProfile records the dials the operator confirmed as a profile
// revision. The selection is described and stored exactly as it stands in the
// model that was on screen — no repair, no clamping, no defaulting — because
// what the operator confirmed and what Babel records must be the same thing. The
// UI has already clamped every dial to what the catalog serves as it was turned.
//
// An unchanged confirmation returns the current revision rather than a new one
// (profileStore.save), so opening the ceremony to check the dials and confirming
// them again does not inflate the history Babel holds references into.
func babelMintProfile(m model, id string) (codeProfile, error) {
	return newProfileStore("").save(babelDescribeDials(m, id))
}

// writeBabelConfigureResult hands Babel the reference. The file is truncated and
// written whole in one call — Babel reads it once, after this process exits, so
// there is no partial-read window to protect against — and the mode is set
// explicitly rather than left to the umask: the reference names an operator's
// configuration, and Babel already keeps the file 0600 in a private directory,
// so a worker widening it would be the one weakening the arrangement.
func writeBabelConfigureResult(path string, ref babelProfileRef) error {
	encoded, err := json.Marshal(babelConfigureResult{Profile: ref.ID, Revision: ref.Revision})
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
