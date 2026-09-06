package main

// `code engine` — a contained, credentialed `omp --mode rpc`, launched under a
// profile an operator confirmed.
//
// The engine adds nothing to OMP's protocol. A client that runs `code engine`
// gets OMP's native RPC on stdin and stdout, byte for byte, and speaks it
// itself: it registers its own host tools, sends its own prompts, reads its
// own events, and decides for itself what a result is. What Code contributes
// is everything OMP cannot know about the machine it is running on and the
// operator it is running for — which profile's dials the session launches
// with, which provider credential it authenticates with, what boundary it is
// contained in, and what it used — and that contribution travels in one file
// beside the stream rather than in it: the runtime report named by
// --runtime-info, written before the first byte of the stream is forwarded
// and rewritten once the child has exited.
//
// Three other modes serve the profile the launch needs. --configure runs the
// dial UI on the operator's terminal and mints an immutable revision out of
// what they confirm (configure.go); --describe reports a saved revision's
// non-secret metadata without launching anything; --import-profiles carries
// revisions from another directory into this installation's store with their
// numbers intact (profile.go). None of them resolves a dial from the
// environment or from a flag: the configuration a run is attributed to is one
// an operator confirmed, and a mode that could compute one for itself would be
// a mode that mints configurations nobody chose.
//
// The invariants the launch holds, in the order a run meets them:
//
//   - the profile resolves or the run does not start, and nothing is written
//     to stdout before the runtime report exists, so a client that reads the
//     report first knows what it is talking to before it discloses anything;
//   - the provider credential travels in the child's environment and nowhere
//     else, is redacted from every forwarded byte, and never reaches argv,
//     a log line or the runtime report;
//   - the containment declared in the report is what the probe established
//     moments earlier and what the child was actually launched inside, and a
//     boundary that cannot be established as declared refuses the launch;
//   - closing stdin ends the run: the child's stdin is closed, OMP disposes
//     the session and exits, and a child that does not is torn down as a
//     tree, along with everything it spawned.
//
// Exit status: the child's own once it has run, 1 when the launch was refused
// before any byte reached stdout, 2 for a usage error, 3 when a killed child
// left no status at all.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"sync"
	"syscall"
	"time"
)

// engineWorkerName is how this binary identifies itself in a runtime report.
// A client records it so a run can be attributed to a build.
const engineWorkerName = "code"

// runtimeReportSchema names the runtime report's shape. A client compares it
// before reading anything else, so a field added later goes under a new
// version rather than surprising a reader of this one.
const runtimeReportSchema = "code.runtime/1"

// engineVersion reports this build. Code carries no version constant and is
// not stamped by its Nix wrapper, so the build info the toolchain embeds is
// the only honest answer: a module version for a released build, the VCS
// revision for a source build. It is never empty, because a run a client
// cannot attribute to a build is a run it cannot reason about later.
func engineVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	if v := info.Main.Version; v != "" && v != "(devel)" {
		return v
	}
	revision, dirty := "", ""
	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			revision = setting.Value
		case "vcs.modified":
			if setting.Value == "true" {
				dirty = "+dirty"
			}
		}
	}
	if revision == "" {
		return "devel"
	}
	if len(revision) > 12 {
		revision = revision[:12]
	}
	return "devel-" + revision + dirty
}

// ── argv ─────────────────────────────────────────────────────────────────────

type engineOptions struct {
	// profile is the revision to launch, describe or mint. A zero revision
	// means the latest, and the ceremony always mints the next.
	profile profileRef
	// runtimeInfo is where the launch writes its report. It is required for a
	// launch and meaningless elsewhere.
	runtimeInfo string
	// inputs are host paths the client approved for the run to read. They are
	// bound read-only inside the boundary at their own paths, never at the
	// working directory.
	inputs []string

	configure  bool
	resultFile string
	describe   bool
	importDir  string
}

const engineHelp = `code engine — a contained omp --mode rpc under a confirmed profile

  code engine --profile ID[@REV] --runtime-info PATH [--input PATH]...
  code engine --describe [--profile ID[@REV]]
  code engine --configure --result-file PATH [--profile ID]
  code engine --import-profiles DIR

  The launch:

      stdin and stdout are omp's own RPC protocol, forwarded byte for byte.
      Code speaks none of it: the client registers its tools, prompts, reads
      events and decides what a result is. What Code adds is the runtime
      report, a JSON file (schema %s) written to --runtime-info
      before the first byte of the stream is forwarded — the profile, its
      disclosure class and cost estimate, the non-secret provider metadata,
      this build, and the containment the session was launched inside — and
      rewritten after the child exits with its exit status and the resources
      it used. The report is mode 0600 and written atomically; a client reads
      it before it discloses anything, and again after the stream ends.

      The child runs with a private HOME, no built-in tools, no extensions,
      skills or rules, and — where the machine can establish it — inside a
      bubblewrap sandbox in a transient systemd scope with a CONNECT allowlist
      of exactly its provider. Closing stdin ends the run.

        --profile ID[@REV]   the saved profile to launch; a bare id launches
                             its latest revision (default %s)
        --runtime-info PATH  where the runtime report is written; the
                             directory should be private to the caller
        --input PATH         a host path the run may read, bound read-only at
                             its own path inside the boundary (repeatable)

  The other modes:

        --describe           write the runtime report's profile half — no
                             containment, no measurements — to stdout and
                             exit without launching anything
        --configure          run Code's dial UI on the terminal on stdin and
                             stdout — the operator's own — and mint a profile
                             revision out of what they confirm. Refuses
                             without a terminal; there is no fallback. Exits 0
                             after writing the reference and nonzero — which a
                             client reads as "unchanged" — after a cancelled
                             or failed one
        --result-file PATH   where --configure writes the confirmed reference,
                             as {"profile":"ID","revision":N}, mode 0600
        --import-profiles DIR
                             copy every revision under DIR — one directory
                             per profile id holding NNNNNNNN.json files, as
                             this store lays them out — into this
                             installation's store, revision numbers intact.
                             A revision already present with the same content
                             is skipped; one present with different content
                             refuses the import

      %s is not read in any mode, and no flag sets a dial.
      The dials come from the ceremony and nowhere else.

  Profiles: %s, or $XDG_STATE_HOME/code/profiles
  Dials:    $XDG_STATE_HOME/code/selection.json — the ceremony opens on it and
            writes it back, exactly as an interactive "code" does.
`

func engineHelpText() string {
	return fmt.Sprintf(engineHelp, runtimeReportSchema, defaultProfileID, codeSelectionStateEnv, profileStateEnv)
}

// runEngine is the `code engine` subcommand.
func runEngine(args []string) int {
	opts := engineOptions{profile: profileRef{ID: defaultProfileID}}
	value := func(i *int, flag string) (string, bool) {
		*i++
		if *i >= len(args) {
			fmt.Fprintf(os.Stderr, "code engine: %s needs a value\n", flag)
			return "", false
		}
		return args[*i], true
	}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--profile":
			arg, ok := value(&i, "--profile")
			if !ok {
				return 2
			}
			ref, err := parseProfileRef(arg)
			if err != nil {
				fmt.Fprintln(os.Stderr, "code engine:", err)
				return 2
			}
			opts.profile = ref
		case "--runtime-info":
			path, ok := value(&i, "--runtime-info")
			if !ok {
				return 2
			}
			opts.runtimeInfo = path
		case "--input":
			path, ok := value(&i, "--input")
			if !ok {
				return 2
			}
			opts.inputs = append(opts.inputs, path)
		case "--configure":
			opts.configure = true
		case "--result-file":
			path, ok := value(&i, "--result-file")
			if !ok {
				return 2
			}
			opts.resultFile = path
		case "--describe":
			opts.describe = true
		case "--import-profiles":
			dir, ok := value(&i, "--import-profiles")
			if !ok {
				return 2
			}
			opts.importDir = dir
		case "--set":
			// Refused, not ignored, and refused in every mode. A dial set from
			// argv mints a profile no operator confirmed, and a client records
			// that profile in a record a reviewer trusts — so the flag says
			// where the dials come from instead of quietly doing nothing.
			fmt.Fprintln(os.Stderr, "code engine: --set is refused: a dial is turned by an "+
				"operator in the configuration ceremony (`code engine --configure`) and nowhere else")
			return 2
		case "-h", "--help":
			fmt.Print(engineHelpText())
			return 0
		default:
			fmt.Fprintf(os.Stderr, "code engine: unknown flag %q\n", args[i])
			return 2
		}
	}
	modes := 0
	for _, on := range []bool{opts.configure, opts.describe, opts.importDir != ""} {
		if on {
			modes++
		}
	}
	if modes > 1 {
		fmt.Fprintln(os.Stderr, "code engine: --configure, --describe and --import-profiles are separate modes; give one")
		return 2
	}
	if opts.resultFile != "" && !opts.configure {
		fmt.Fprintln(os.Stderr, "code engine: --result-file is only answered by --configure")
		return 2
	}
	switch {
	case opts.configure:
		// The ceremony owns stdin and stdout as a terminal, so it is
		// dispatched before anything that would treat them as the stream. It
		// handles its own interruption: Bubble Tea reads the keys, and ctrl+c
		// there is a cancelled ceremony rather than a signal to translate.
		return runEngineConfigure(opts)
	case opts.describe:
		return runEngineDescribe(opts, os.Stdout)
	case opts.importDir != "":
		return runEngineImport(opts)
	}
	if opts.runtimeInfo == "" {
		fmt.Fprintln(os.Stderr, "code engine: a launch needs --runtime-info PATH, where the runtime report is written")
		return 2
	}
	inputs, err := sandboxInputPaths(opts.inputs)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code engine:", err)
		return 2
	}
	opts.inputs = inputs
	// A client cancels by closing this process's stdin and then killing the
	// tree; honouring the signals too means a run interrupted from a shell
	// tears down on the same path rather than a second one.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	launcher := newOmpLauncher(profileStoreSource{store: newProfileStore("")})
	status, err := launcher.serve(ctx, opts, os.Stdin, os.Stdout, os.Stderr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code engine:", launcher.redactor.redactString(err.Error()))
	}
	return status
}

// ── the runtime report ───────────────────────────────────────────────────────

// runtimeWorker identifies the build that wrote a report.
type runtimeWorker struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// runtimeReport is the one machine-readable thing Code adds to a launch: the
// non-secret facts about the run that OMP's stream cannot carry because OMP
// does not know them. The profile half is what --describe reports; the launch
// adds the containment before forwarding a byte and the outcome after the
// child exits.
//
// Finished is a pointer so --describe, which reports no launch, omits the key
// rather than claiming a run that never started did not finish. A report a
// client reads with finished absent or false after the engine has exited is
// a report of a run whose wrapper was killed before it could account for
// anything, and no resource figure in it may be trusted, because there is
// none.
type runtimeReport struct {
	Schema   string            `json:"schema"`
	Worker   runtimeWorker     `json:"worker"`
	Profile  profileRef        `json:"profile"`
	Privacy  profilePrivacy    `json:"privacy"`
	Cost     profileCost       `json:"cost"`
	Metadata map[string]string `json:"metadata"`

	Containment *sandboxDeclaration `json:"containment,omitempty"`
	Finished    *bool               `json:"finished,omitempty"`
	ExitCode    *int                `json:"exit_code,omitempty"`
	// Resources carries only what was measured, and ResourcesProvenance
	// names where each figure came from: cgroup memory.peak and a single
	// process's ru_maxrss are different quantities, and a reviewer holding
	// the report has to know which one it is reading.
	Resources           *runResources `json:"resources,omitempty"`
	ResourcesProvenance string        `json:"resources_provenance,omitempty"`
	// Egress is every CONNECT the sandbox's proxy was asked for, in order,
	// with the ones the allowlist refused marked as such. The declaration
	// says the run could reach exactly one endpoint; this is the only place
	// a reviewer can see what it actually tried to reach, and it is written
	// whatever the outcome, because a run that failed while reaching for
	// somewhere it was not allowed is precisely the case to see.
	Egress []sandboxConnect `json:"egress,omitempty"`
}

// runtimeReportOf renders the profile half of a report.
func runtimeReportOf(profile resolvedProfile) runtimeReport {
	return runtimeReport{
		Schema:  runtimeReportSchema,
		Worker:  runtimeWorker{Name: engineWorkerName, Version: engineVersion()},
		Profile: profile.Ref,
		Privacy: profilePrivacy{
			Disclosure:        profile.Disclosure,
			RedactionRequired: profile.Disclosure == disclosureHosted,
		},
		Cost:     profile.Cost,
		Metadata: cloneMetadata(profile.Metadata),
	}
}

// writeRuntimeReport writes the report whole or not at all: to a temporary
// file beside the target, mode 0600, synced, then renamed over it. A client
// that reads the path sees either the previous report or this one, never a
// prefix of this one, and never a mode the umask chose.
func writeRuntimeReport(path string, report runtimeReport) error {
	data, err := json.Marshal(report)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".code-runtime-*")
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
	return os.Rename(tmpPath, path)
}

// runEngineDescribe reports a saved profile the way a launch would, minus
// everything a launch establishes. It opens no terminal and launches nothing,
// so a client can ask what a reference means on a machine where it would
// never run it.
func runEngineDescribe(opts engineOptions, out io.Writer) int {
	launcher := newOmpLauncher(profileStoreSource{store: newProfileStore("")})
	profile, err := launcher.openProfile(opts.profile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code engine:", err)
		return 1
	}
	data, err := json.Marshal(runtimeReportOf(profile))
	if err != nil {
		fmt.Fprintln(os.Stderr, "code engine:", err)
		return 1
	}
	if _, err := out.Write(append(data, '\n')); err != nil {
		fmt.Fprintln(os.Stderr, "code engine:", err)
		return 1
	}
	return 0
}

// runEngineImport carries revisions from another directory into this store.
func runEngineImport(opts engineOptions) int {
	store := newProfileStore("")
	imported, err := store.importFrom(opts.importDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "code engine: importing profiles from %s: %v (%d revision(s) imported before that)\n",
			opts.importDir, err, imported)
		return 1
	}
	fmt.Fprintf(os.Stderr, "code engine: imported %d revision(s) from %s into %s\n", imported, opts.importDir, store.dir)
	return 0
}

// ── the launcher ─────────────────────────────────────────────────────────────

// errOmpProfileUnavailable marks the one refusal an operator can act on by
// name: the launch named a profile this installation cannot back.
var errOmpProfileUnavailable = errors.New("profile unavailable")

// ompLauncher runs one contained OMP session under a saved profile.
//
// The function-valued fields are seams, not configuration: they let the launch
// be exercised against a fake OMP and without an auth broker, which is the
// only way to test the boundary, the report and the shutdown without a
// provider.
type ompLauncher struct {
	profiles profileSource
	lookOmp  func() (string, error)
	environ  func() []string
	// auth resolves the run's provider credential. It is a seam because the
	// real one talks to the operator's auth broker, and a launch test must be
	// able to run without one.
	auth func() (ompAuth, error)
	// credential is what auth resolved, held between resolveCredential and the
	// launch it authorizes. A zero value means nothing was resolved, which is a
	// refusal rather than an unauthenticated run.
	credential ompAuth
	// keyless records that resolveCredential opened a local-lane profile, whose
	// endpoint takes no key. It is a separate field from credential because the
	// two absences are different: a zero credential with keyless false is a
	// launch that never authenticated and must not proceed, and one with
	// keyless true is a run that has nothing to authenticate with by design.
	keyless bool
	// redactor holds the secrets every forwarded byte is scrubbed against. It
	// exists from the moment the credential is resolved, so a diagnostic
	// written between resolution and launch is covered too.
	redactor *secretRedactor
	// profile is what openProfile resolved, held so containment() can name the
	// provider endpoint the sandbox's one egress hole points at.
	profile resolvedProfile
	// ceilings are the resource limits a contained run is held to. It is a
	// field rather than a constant so an escape scenario can pin a tiny one and
	// watch the kernel enforce it.
	ceilings sandboxCeilings
	// probe establishes the backend. It is a seam only so a test can substitute
	// a backend it built itself; every real run probes this machine.
	probe func(sandboxCeilings) *sandboxBackend
	// backend is what probe established, resolved once. containment() reads its
	// facts and serve() launches through it, so the declaration and the launch
	// cannot describe different things.
	backend     *sandboxBackend
	backendOnce sync.Once
}

func newOmpLauncher(profiles profileSource) *ompLauncher {
	return &ompLauncher{
		profiles: profiles,
		lookOmp:  func() (string, error) { return resolveLaunchPath("CODE_OMP", []string{"omp"}) },
		environ:  os.Environ,
		auth:     ompResolveAuth,
		redactor: newSecretRedactor(nil),
	}
}

// sandbox is the probed backend, established on first use.
//
// The probe is a launch: it starts the real chain with a payload that tries to
// break out and reads the scope's cgroup back. That happens once per engine
// process, at the first call — after the profile is resolved and before the
// child is started, which is exactly when the declaration has to be true.
//
// A zero-valued launcher still probes this machine. The seam defaults rather
// than being required, because a declaration is the one thing that must never
// degrade quietly through a construction path someone forgot to wire.
func (l *ompLauncher) sandbox() *sandboxBackend {
	l.backendOnce.Do(func() {
		probe := l.probe
		if probe == nil {
			probe = newSandboxBackend
		}
		ceilings := l.ceilings
		if ceilings.MemoryMaxBytes == 0 {
			ceilings = defaultSandboxCeilings()
		}
		l.backend = probe(ceilings)
	})
	return l.backend
}

// openProfile resolves and validates one profile, and keeps what it resolved
// so the containment declaration can name the endpoint this run's egress will
// allow. The validation is the report's contract restated locally: a client
// needs a positive revision, a known disclosure class and some provider
// metadata, and finding that out here beats finding it out from a report that
// cannot be read.
func (l *ompLauncher) openProfile(ref profileRef) (resolvedProfile, error) {
	if l.profiles == nil {
		return resolvedProfile{}, fmt.Errorf("%w: no profile store is wired into the launcher", errOmpProfileUnavailable)
	}
	profile, err := l.profiles.resolveProfile(ref.ID, ref.Revision)
	if err != nil {
		return resolvedProfile{}, fmt.Errorf("%w: %s: %w", errOmpProfileUnavailable, ompProfileName(ref), err)
	}
	if profile.Ref.ID == "" {
		return resolvedProfile{}, fmt.Errorf("%w: %s resolved to a profile with no id",
			errOmpProfileUnavailable, ompProfileName(ref))
	}
	if profile.Ref.Revision <= 0 {
		return resolvedProfile{}, fmt.Errorf("%w: %s resolved to revision %d, and a report needs a positive one",
			errOmpProfileUnavailable, ompProfileName(ref), profile.Ref.Revision)
	}
	switch profile.Disclosure {
	case disclosureLocal, disclosureHosted:
	default:
		return resolvedProfile{}, fmt.Errorf("%w: %s declares disclosure class %q",
			errOmpProfileUnavailable, ompProfileName(ref), profile.Disclosure)
	}
	if len(profile.Metadata) == 0 {
		return resolvedProfile{}, fmt.Errorf("%w: %s resolved no provider metadata, and a report requires it",
			errOmpProfileUnavailable, ompProfileName(ref))
	}
	l.profile = profile
	return profile, nil
}

func ompProfileName(ref profileRef) string {
	if ref.ID == "" {
		return "the current profile"
	}
	return "profile " + ref.String()
}

// resolveCredential resolves what this run will authenticate with, before
// anything is launched, and registers the secret strings it consists of with
// the redactor so they stay out of every byte the engine writes.
//
// It is separate from the launch because its answer decides whether there is
// a run at all. A launch that cannot authenticate owes the client a refusal
// naming the remedy, and owes it instead of a child — not after an OMP has
// failed a model call for a reason nobody can connect to a missing credential.
//
// A local-lane profile is the one configuration with nothing to resolve: the
// model is served on this machine over an endpoint that takes no key
// (locallane.go), so the run is keyless and the broker is not consulted at all.
// That is decided from the profile the launch named rather than from a
// fallback, and a reference that will not open leaves the credential required
// — the stricter answer, and the one whose failure openProfile then reports.
func (l *ompLauncher) resolveCredential(ref profileRef) error {
	if profile, err := l.openProfile(ref); err == nil && isLocalProfile(profile.Metadata) {
		if _, err := localTargetOf(profile.Metadata); err != nil {
			return err
		}
		l.keyless = true
		return nil
	}
	auth, err := l.auth()
	if err != nil {
		return err
	}
	if !auth.configured() {
		return errOmpNoCredential
	}
	l.credential = auth
	l.redactor = newSecretRedactor([]string{auth.broker.Token})
	return nil
}

// containment declares the sandbox this launcher provides, read off a backend
// that was probed on this machine moments ago.
//
// Nothing here is a constant. sandbox() launches the real chain with a payload
// that tries, from inside, to read and write a host path, to write the Nix
// store and to find a route off the machine, and the parent reads the transient
// scope's cgroup back to see which ceilings the kernel installed. Every boolean
// below is one of those observations. A machine where the boundary does not
// come up declares less and the client refuses the run, which is the outcome
// the declaration exists to produce — a refused run costs an operator a
// message, and an overstated one costs a reviewer their basis for trusting
// what the run produced.
//
// The escape statement names the endpoint this run's egress allows whenever a
// profile has been resolved, because "restricted to the provider" is a weaker
// thing to read in a report than the host and port a compromised session
// could still reach.
func (l *ompLauncher) containment() sandboxDeclaration {
	return l.sandbox().facts.declare(l.egressDescription())
}

// egressDescription is the run's egress plan as prose needs it, resolved
// without opening a socket: a declaration is made before anything is launched,
// and a listener that existed for a run the client then refused would be a
// boundary opened for nothing.
func (l *ompLauncher) egressDescription() sandboxEgressDescription {
	provider, policy, err := sandboxRunEgress(l.profile, l.credential.broker.URL)
	if err != nil {
		// No profile has been resolved yet, or its endpoint cannot be resolved.
		// The mechanism is still exactly what it is; only the target is
		// unknown, and serve() refuses the run rather than guessing one — so
		// the declaration names the provider if that much is known and claims
		// no route at all.
		return sandboxEgressDescription{provider: provider}
	}
	return sandboxEgressDescription{
		provider: provider,
		allowed:  policy.allowed,
		relay:    policy.brokerAddr != "",
		local:    policy.modelAddr,
	}
}

// serve is the launch: resolve the profile and the credential, build the
// boundary, start OMP inside it, write the runtime report, and then forward
// the client's stdin to the child and the child's stdout to the client until
// the child exits. It returns the process exit status and, for a refusal
// before any byte reached stdout, the reason.
func (l *ompLauncher) serve(ctx context.Context, opts engineOptions, in io.Reader, out, errw io.Writer) (int, error) {
	profile, err := l.openProfile(opts.profile)
	if err != nil {
		return 1, err
	}
	if err := l.resolveCredential(opts.profile); err != nil {
		return 1, err
	}
	if !l.credential.configured() && !l.keyless {
		// Unreachable: resolveCredential either set one or refused. Kept as a
		// check because launching unauthenticated is the one thing this
		// function must never do by accident.
		return 1, errOmpNoCredential
	}
	binary, err := l.lookOmp()
	if err != nil {
		return 1, fmt.Errorf("no omp to launch: %w", err)
	}
	dir, err := ompNewRunDir(profile.ConfigYAML)
	if err != nil {
		return 1, fmt.Errorf("the run directory could not be created: %w", err)
	}
	defer dir.remove()
	// The pool lives in the run directory rather than a temporary of its own,
	// so the run's account policy is disposed of with the run that set it.
	auth := l.credential
	auth.poolPath, err = dir.writeAccountPool(auth.pool)
	if err != nil {
		return 1, fmt.Errorf("the run's account pool could not be written: %w", err)
	}

	launch, contained, err := l.launchPlan(profile, opts.inputs, dir, binary, auth)
	if err != nil {
		return 1, err
	}
	defer contained.close()
	launch.stderr = redactingWriter{redactor: l.redactor, dst: errw}

	session, err := ompStartSession(ctx, launch)
	if err != nil {
		return 1, err
	}

	// The report goes out after the child is running inside a boundary that
	// was checked, and before a byte of its output is forwarded: the pipe
	// holds what the child has already written, so nothing is lost by
	// writing the file first, and a client that reads the report before it
	// touches the stream knows exactly what it is talking to.
	report := runtimeReportOf(profile)
	declaration := l.containment()
	report.Containment = &declaration
	finished := false
	report.Finished = &finished
	if err := writeRuntimeReport(opts.runtimeInfo, report); err != nil {
		session.stop()
		return 1, fmt.Errorf("the runtime report could not be written to %s: %w", opts.runtimeInfo, err)
	}

	// stdin is the client's to close, and closing it is how the run ends. The
	// child's stdin is closed in turn so OMP drains and exits on its own; a
	// child that has not ended its output within the grace is torn down, so
	// a client that closed stdin and waits is never waiting on a wedged tree.
	forwarded := make(chan struct{})
	go func() {
		_, _ = io.Copy(session.stdin, in)
		_ = session.stdin.Close()
		select {
		case <-forwarded:
		case <-time.After(ompExitGrace):
			_ = ompTerminateTree(session.cmd, session.pgid, false)
		}
	}()
	forwardErr := l.redactor.forward(out, session.stdout)
	close(forwarded)

	// The host captured whole-scope counters before acknowledging helper
	// shutdown; forced termination may leave only direct-child rusage.
	usage := contained.usage().fillFrom(session.stop())
	usage = usage.fillFrom(l.scratchUsage(ctx, contained, dir))
	exitCode := session.exitCode()

	finished = true
	report.ExitCode = &exitCode
	report.Resources = usage.report()
	report.ResourcesProvenance = usage.provenance()
	report.Egress = contained.egressLog()
	if err := writeRuntimeReport(opts.runtimeInfo, report); err != nil {
		fmt.Fprintln(errw, "code engine: the finished runtime report could not be written:", err)
	}
	if forwardErr != nil {
		fmt.Fprintln(errw, "code engine: forwarding omp's output:", l.redactor.redactString(forwardErr.Error()))
	}
	if ctx.Err() != nil && exitCode != 0 {
		fmt.Fprintln(errw, "code engine: the run was interrupted and the process tree torn down")
	}
	if exitCode < 0 {
		if diagnostics := session.diagnostics(); diagnostics != "" {
			fmt.Fprintln(errw, "code engine: omp ended without a status; it last said:", l.redactor.redactString(diagnostics))
		}
		return 3, nil
	}
	return exitCode, nil
}

// launchPlan builds the boundary this run goes inside, and the launch that
// describes the session from within it.
//
// A backend that established nothing returns a plain launch and a nil boundary.
// That is not a fallback dressed up as one: containment() declares every
// property false in that case, so a client refuses such a run under a strict
// default, and the only way this path executes is a client accepting the
// declaration on purpose.
func (l *ompLauncher) launchPlan(profile resolvedProfile, inputs []string, dir *ompRunDir,
	binary string, auth ompAuth,
) (ompLaunch, *sandboxRun, error) {
	inputs, err := sandboxInputPaths(inputs)
	if err != nil {
		return ompLaunch{}, nil, err
	}
	// A local-lane run's model calls go to the endpoint its profile recorded,
	// and the environment is how omp's implicit local engine is told where that
	// is (locallane.go). The inherited endpoint variables are replaced rather
	// than added to, so nothing ambient can redirect a supervised run.
	local, isLocal, err := localRunProfile(profile)
	if err != nil {
		return ompLaunch{}, nil, err
	}
	env := ompChildEnv(l.environ(), dir.home, auth)
	if isLocal {
		env = localChildEnv(env, local, local.Endpoint)
	}
	plain := ompLaunch{
		binary: binary,
		config: dir.config,
		home:   dir.home,
		work:   dir.work,
		env:    env,
	}
	if l.sandbox().facts.backend == sandboxBackendNone {
		return plain, nil, nil
	}

	// The boundary follows the profile: a CONNECT allowlist of exactly the
	// hosted provider's endpoint, or a raw relay to the local endpoint this
	// run's model is served from. An endpoint Code cannot resolve ends the run
	// here: a proxy with nothing allowed would strand the session, and one
	// with everything allowed would contradict the declaration the client is
	// about to read.
	_, policy, err := sandboxRunEgress(profile, auth.broker.URL)
	if err != nil {
		return ompLaunch{}, nil, err
	}
	egress, err := newSandboxEgress(filepath.Join(dir.root, "egress"), policy)
	if err != nil {
		return ompLaunch{}, nil, fmt.Errorf("the run's egress proxy could not be opened: %w", err)
	}

	// Inside, the credential still travels by environment and never on argv;
	// only the places it points at change, because the pool and the broker are
	// reachable at different paths in there.
	guest := auth
	guest.poolPath = sandboxPoolPath
	if policy.brokerURL != "" {
		guest.broker.URL = policy.brokerURL
	}

	contained, err := l.sandbox().contain(sandboxRequest{
		ompBinary:  binary,
		configHost: dir.config,
		poolHost:   auth.poolPath,
		caBundle:   sandboxCABundle(),
		inputs:     inputs,
		egress:     egress,
	})
	if err != nil || contained == nil {
		egress.close()
		if err == nil {
			err = errors.New("the sandbox backend declared a boundary and then produced no way to enter it")
		}
		return ompLaunch{}, nil, err
	}
	guestEnv := sandboxProxyEnv(ompChildEnv(l.environ(), sandboxHomePath, guest))
	if isLocal {
		// Inside, the endpoint is the sandbox's own loopback relay rather than
		// the host address: there is no such host in there, and the relay is
		// what carries the bytes back out to it.
		guestEnv = localChildEnv(guestEnv, local, policy.modelURL)
	}
	return ompLaunch{
		binary:  binary,
		config:  sandboxConfigPath,
		home:    sandboxHomePath,
		work:    sandboxWorkPath,
		env:     guestEnv,
		contain: contained,
	}, contained, nil
}

// scratchUsage reports what the run wrote, and where that was seen from.
//
// A contained run is measured from inside, because its scratch is a tmpfs that
// no longer exists by the time the host could look — that unobservability is
// the property the disposable claim rests on, so the guest's own measurement is
// not a convenience here, it is the only reading there is. An uncontained run
// is measured on the host, over the run directory, which is then all there is.
//
// A contained run whose helper never reported falls through to the host
// reading, which for a contained run sees the run directory the launch was
// staged from rather than the tmpfs the session wrote to. That is a different
// quantity and it says so, which is the point of carrying the source: a
// reviewer can tell a scratch measurement from a staging-directory one instead
// of reading both as "bytes written".
func (l *ompLauncher) scratchUsage(ctx context.Context, contained *sandboxRun, dir *ompRunDir) runUsage {
	if contained != nil {
		if bytes, ok := contained.bytesWritten(ctx); ok {
			return runUsage{
				bytesWritten: bytes,
				bytesSource: "the in-sandbox helper's own walk of the run's tmpfs scratch " +
					"(bytes, measured from inside just before it exited)",
			}
		}
	}
	return runUsage{
		bytesWritten: dir.bytesWritten(),
		bytesSource:  "a host walk of the run directory (bytes, file sizes summed)",
	}
}
