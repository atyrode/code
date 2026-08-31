//go:build linux

package main

// The Linux containment backend: bubblewrap inside a transient systemd user
// scope.
//
// The two halves do different jobs and neither substitutes for the other.
// bubblewrap builds the boundary — unprivileged user, mount, PID, IPC, UTS,
// cgroup and network namespaces over a tmpfs root — which is what makes the run
// isolated, networkless and disposable. The scope is a cgroup systemd owns,
// which is the only way an unprivileged process on this machine can install a
// memory, CPU or task ceiling that the kernel actually enforces. bwrap alone is
// three of the four properties; the scope alone is one of them.
//
// Nothing here trusts either tool's exit status for a claim. Before a run is
// declared contained, the backend launches the whole chain with a probe payload
// that tries, from inside, to read and write a host path, to write every path
// the mount plan bound read-only, and to find a route off the machine — and the
// parent reads the scope's own cgroup files back to see that the ceilings it
// asked for are the ones the kernel installed. A property that survives that is
// declared; a property that does not is declared false, and Babel refuses the
// run.

import (
	"bufio"
	"bytes"
	"debug/elf"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// sandboxProbeTimeout bounds the probe. A backend that cannot report in this
// long is not one a run should wait on, and the fallback — declaring less — is
// always available.
const sandboxProbeTimeout = 30 * time.Second

// sandboxBackend is the probed backend. It is built once per worker process,
// because probing is a launch and a run has no reason to do it twice, and the
// facts it holds are what containment() declares.
type sandboxBackend struct {
	helper   string
	bwrap    string
	systemd  string
	scopeEnv []string
	ceilings sandboxCeilings
	facts    sandboxFacts
}

// newSandboxBackend probes this machine and reports what it can actually
// contain a run in.
//
// The order is deliberate: the full backend is tried first, and each fallback
// is taken only after the stronger one demonstrably failed, with the reason
// recorded so the declaration can say why a boolean is false.
func newSandboxBackend(ceilings sandboxCeilings) *sandboxBackend {
	b := &sandboxBackend{ceilings: ceilings, facts: sandboxFacts{backend: sandboxBackendNone, ceilings: ceilings}}

	helper, err := os.Executable()
	if err != nil {
		b.facts.degraded = []string{"Code cannot locate its own binary (" + err.Error() +
			"), and the sandbox needs it inside to forward egress"}
		return b
	}
	b.helper = helper

	bwrap, err := sandboxLookTool("bwrap")
	if err != nil {
		b.facts.degraded = []string{"bubblewrap is not installed (" + err.Error() +
			"), so no namespace boundary can be built at all"}
		return b
	}
	b.bwrap = bwrap

	var degraded []string
	if systemd, env, err := sandboxScopeTool(); err != nil {
		degraded = append(degraded, "no transient systemd scope is available ("+err.Error()+
			"), so no resource ceiling could be installed")
	} else {
		b.systemd, b.scopeEnv = systemd, env
	}

	// The scoped backend first. A probe that comes back with the boundary
	// intact and the ceilings installed is the only thing that earns the full
	// declaration.
	if b.systemd != "" {
		report, ceilingsOK, err := b.probe(true)
		switch {
		case err != nil:
			degraded = append(degraded, "the scoped backend would not start ("+err.Error()+")")
		case !ceilingsOK:
			degraded = append(degraded, "the transient scope started but its cgroup did not carry the "+
				"ceilings that were requested, so none is claimed")
		default:
			b.facts = sandboxFacts{
				backend:             sandboxBackendFull,
				filesystemIsolation: report.isolated(),
				networkDefaultDeny:  report.networkDenied(),
				resourceCeilings:    true,
				disposable:          report.isolated(),
				ceilings:            ceilings,
			}
			b.facts.degraded = sandboxDedupe(append(b.facts.degraded, sandboxProbeGaps(report)...))
			if b.facts.contained() {
				return b
			}
			degraded = append(degraded, "the scoped backend started but did not isolate: "+
				strings.Join(sandboxProbeGaps(report), "; "))
		}
	}

	// bubblewrap alone. Three of the four properties are still real, and saying
	// so beats claiming a ceiling that was never installed — Babel refuses this
	// declaration under the strict default, which is the correct outcome, and
	// an operator who relaxes a run deliberately still gets the boundary.
	report, _, err := b.probe(false)
	if err != nil {
		degraded = append(degraded, "bubblewrap would not start either ("+err.Error()+")")
		b.facts = sandboxFacts{backend: sandboxBackendNone, ceilings: ceilings, degraded: sandboxDedupe(degraded)}
		return b
	}
	b.systemd, b.scopeEnv = "", nil
	b.facts = sandboxFacts{
		backend:             sandboxBackendBwrap,
		filesystemIsolation: report.isolated(),
		networkDefaultDeny:  report.networkDenied(),
		resourceCeilings:    false,
		disposable:          report.isolated(),
		ceilings:            ceilings,
		degraded:            sandboxDedupe(append(degraded, sandboxProbeGaps(report)...)),
	}
	if !b.facts.contained() {
		b.facts.backend = sandboxBackendNone
	}
	return b
}

// sandboxDedupe keeps a degraded list readable. The scoped attempt and the
// bubblewrap-only fallback observe the same machine, so a real gap is seen
// twice and a reviewer should be told it once.
func sandboxDedupe(reasons []string) []string {
	seen := make(map[string]bool, len(reasons))
	out := reasons[:0]
	for _, reason := range reasons {
		if seen[reason] {
			continue
		}
		seen[reason] = true
		out = append(out, reason)
	}
	return out
}

// sandboxProbeGaps names, in an operator's words, each thing the probe saw that
// the declaration would otherwise have claimed.
func sandboxProbeGaps(report sandboxProbeReport) []string {
	var gaps []string
	if report.OutsideReadable {
		gaps = append(gaps, "a host path outside the grant was readable from inside the sandbox")
	}
	if report.OutsideWritable {
		gaps = append(gaps, "a host path outside the grant was writable from inside the sandbox")
	}
	if report.ReadOnlyWritable {
		gaps = append(gaps, "a path the mount plan bound read-only was writable from inside the sandbox, "+
			"so a run could rewrite the binaries the next one executes")
	}
	if !report.ScratchWritable {
		gaps = append(gaps, "the sandbox's own scratch directory was not writable, so a run could not proceed")
	}
	if report.Routes != 0 {
		gaps = append(gaps, "the sandbox's network namespace still carried "+strconv.Itoa(report.Routes)+
			" route(s) off the machine")
	}
	if !report.Loopback {
		gaps = append(gaps, "the sandbox has no usable loopback, so the egress forwarder cannot listen")
	}
	return gaps
}

// ── locating the tools ───────────────────────────────────────────────────────

// sandboxLookTool finds one of the backend's binaries.
//
// PATH first, then the two places a Nix-provisioned machine keeps them. The
// fallback exists because Babel spawns this worker with a curated environment
// carrying only HOME, PATH, TMPDIR and LANG, and that PATH is whatever Babel
// itself inherited — which on a machine where these tools live in a user
// profile may well not include them. Nothing is claimed on the strength of a
// path being found: the probe still has to run.
func sandboxLookTool(name string) (string, error) {
	if path, err := exec.LookPath(name); err == nil {
		return path, nil
	}
	candidates := []string{
		filepath.Join(os.Getenv("HOME"), ".nix-profile", "bin", name),
		filepath.Join("/run/current-system/sw/bin", name),
		filepath.Join("/usr/bin", name),
		filepath.Join("/bin", name),
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%s is not on PATH and is not in any well-known location", name)
}

// sandboxScopeTool locates systemd-run and the session bus it needs.
//
// The bus address is derived rather than required, for the same reason: Babel
// strips XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS from the worker's
// environment, so insisting on them would refuse a ceiling this machine can
// perfectly well install. The derivation is the documented one — the user
// manager's runtime directory is /run/user/$UID and its bus socket is `bus`
// inside it — and it is checked by stat and then proven by actually creating a
// scope in the probe. A guess that is wrong degrades the declaration; it cannot
// inflate it.
func sandboxScopeTool() (string, []string, error) {
	path, err := sandboxLookTool("systemd-run")
	if err != nil {
		return "", nil, err
	}
	runtimeDir := os.Getenv("XDG_RUNTIME_DIR")
	if runtimeDir == "" {
		uid := os.Getuid()
		runtimeDir = "/run/user/" + strconv.Itoa(uid)
		if current, err := user.Current(); err == nil && current.Uid != "" {
			runtimeDir = "/run/user/" + current.Uid
		}
	}
	bus := os.Getenv("DBUS_SESSION_BUS_ADDRESS")
	if bus == "" {
		socket := filepath.Join(runtimeDir, "bus")
		info, err := os.Stat(socket)
		if err != nil {
			return "", nil, fmt.Errorf("the user session bus is not at %s, so systemd-run --user has "+
				"nothing to talk to", socket)
		}
		if info.Mode()&os.ModeSocket == 0 {
			return "", nil, fmt.Errorf("%s is not a socket", socket)
		}
		bus = "unix:path=" + socket
	}
	return path, []string{
		"XDG_RUNTIME_DIR=" + runtimeDir,
		"DBUS_SESSION_BUS_ADDRESS=" + bus,
	}, nil
}

// ── what the guest has to have in order to execute anything ──────────────────

// The mount plan's read-only binds are derived from the programs the run has to
// execute, not from an assumption about how this host was built. That
// distinction is the difference between a backend that works and one that does
// not: naming a path unconditionally makes bubblewrap refuse to start on every
// machine that does not have it, which degrades the declaration to no boundary
// at all and makes Babel refuse the run — for a reason that reads as a missing
// directory rather than as the portability gap it is.
//
// The derivation resolves each executable to its real path and then reads what
// that file itself says it needs: a script's shebang line names its interpreter
// by absolute path, and an ELF object's program headers name its dynamic loader
// while its dynamic section names the libraries it links. That closure is
// walked to fixpoint. What it can miss is named at sandboxRuntimePaths.

// sandboxStore is the Nix store. It is a bulk root here rather than a
// requirement, and it is bound only when something the run executes actually
// resolves into it.
//
// Nothing narrower is sound for it. A store path's runtime references are
// absolute store paths embedded in file contents — a wrapper script's exec
// target, a NODE_PATH, a DT_RUNPATH — so the closure of one store path is
// Nix's own computation over those references and not something to re-derive
// from ELF headers. Binding the store whole is what the operator's machine has
// always done and it discloses nothing: the store is read-only, hash-addressed
// and holds no operator data. On a machine where nothing resolves into it, it
// is not named at all.
const sandboxStore = "/nix/store"

// sandboxLibraryDirs are the host directories a resolved shared object may be
// bound from whole. They are the dynamic loader's own territory — the
// multiarch and biarch library roots — and a bind of one exposes system
// libraries and nothing else.
//
// The list is an allowlist rather than a denylist because the failure modes are
// not symmetric. An unknown directory that is refused costs a per-file bind,
// which still works; an unknown directory that is allowed could be a directory
// holding the operator's data, and a boundary with a hole in it is worse than a
// backend that will not come up.
var sandboxLibraryDirs = []string{
	"/lib", "/lib32", "/lib64", "/libx32",
	"/usr/lib", "/usr/lib32", "/usr/lib64", "/usr/libx32",
	"/usr/local/lib", "/usr/local/lib64",
}

// sandboxClosureBudget bounds the walk. A dependency graph this deep is a
// machine doing something the derivation was not written for, and stopping is
// the safe end: an unresolved dependency degrades the declaration through a
// probe that fails to start, which is loud, while an unbounded walk of a
// symlink cycle is not.
const sandboxClosureBudget = 512

// sandboxRuntimePaths derives the read-only host paths the sandbox needs in
// order to execute the programs a run is built from.
//
// named are executables the guest reaches at their own host path, because
// something inside — an argv, a wrapper's exec target — names that path.
// relocated are executables the guest layout binds elsewhere, Code's own
// helper being the only one: its host path is not required, only whatever it
// needs at runtime.
//
// What this can miss, stated plainly, because a derivation that is trusted
// without its limits is worse than one that is not trusted at all:
//
//   - Anything opened by name at runtime rather than linked. dlopen targets,
//     NSS and PAM modules, a Python or Node module tree, a locale archive, a
//     data file next to a binary: none of them is in any header. A shared
//     object's own directory is bound whole, which covers the siblings, the
//     versioned symlinks and the glibc-hwcaps subdirectories beside it; a
//     program's own package directory is not something this can find.
//   - Libraries reachable only through /etc/ld.so.cache. The search
//     directories the loader would use are read from /etc/ld.so.conf and its
//     includes, which is the same list the cache indexes, so a library placed
//     in a directory that is in the cache and in no config file is not found.
//   - A shebang whose interpreter is resolved through PATH. `env` is followed,
//     because that is the common form and the host's PATH is the guest's; any
//     other PATH-relative interpreter is not.
//   - Store-like bulk roots other than Nix's. Guix's /gnu/store and a Spack or
//     conda prefix are structurally the same problem and are not special-cased,
//     so a dependency in one is bound file by file and may lose a dlopen
//     sibling.
//
// Every one of those misses has the same consequence and it is the safe one:
// the probe cannot execute its payload, the backend degrades with the reason
// bubblewrap or the loader gave, and Babel refuses the run. None of them can
// widen the boundary.
func sandboxRuntimePaths(named, relocated []string) []string {
	closure := &sandboxRuntimeClosure{
		seen:   make(map[string]bool),
		bound:  make(map[string]bool),
		budget: sandboxClosureBudget,
	}
	for _, path := range named {
		closure.executable(path)
	}
	for _, path := range relocated {
		closure.dependenciesOf(path)
	}
	return closure.paths
}

// sandboxRuntimeClosure is one derivation in progress.
type sandboxRuntimeClosure struct {
	// seen is every file whose dependencies have been read, which is what
	// makes a diamond in the graph — and a symlink cycle — terminate.
	seen map[string]bool
	// bound and paths are the answer: the set for lookups, the slice for the
	// order the plan is built in.
	bound map[string]bool
	paths []string
	// search is the loader's search path, resolved once. It is a host-wide
	// fact rather than a per-object one, and reading a handful of config
	// files for every needed library would be the same answer many times.
	search []string
	budget int
}

// executable takes an executable the guest reaches at its own host path.
//
// Both the name and the file it resolves to are bound. The guest looks up the
// path the launch handed it, so that string has to resolve inside; a Nix
// profile entry is a symlink chain into the store, and the store path at the
// end of it is what the loader, the wrapper's own exec target and /proc/self/exe
// all refer to afterwards.
func (c *sandboxRuntimeClosure) executable(path string) {
	real, ok := sandboxRealFile(path)
	if !ok {
		return
	}
	c.add(path, false)
	c.add(real, false)
	c.dependencies(real)
}

// dependenciesOf takes an executable the guest layout binds somewhere else. Its
// own path is deliberately not bound: the guest reaches it at the layout's path
// and binding the host one would widen the plan by a whole bulk root for a file
// that is already inside.
func (c *sandboxRuntimeClosure) dependenciesOf(path string) {
	if real, ok := sandboxRealFile(path); ok {
		c.dependencies(real)
	}
}

// dependencies reads one file's own account of what it needs to run.
func (c *sandboxRuntimeClosure) dependencies(path string) {
	if c.seen[path] || c.budget <= 0 {
		return
	}
	c.seen[path] = true
	c.budget--

	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()
	// Enough for a shebang line and far more than enough for an ELF magic
	// number. A short file reads short, which is not an error here.
	head := make([]byte, 256)
	read, _ := file.ReadAt(head, 0)
	head = head[:read]
	switch {
	case bytes.HasPrefix(head, []byte("#!")):
		c.shebang(head)
	case bytes.HasPrefix(head, []byte("\x7fELF")):
		c.linked(file, path)
	}
}

// shebang follows a script's interpreter. On the operator's machine this is the
// line that makes the Nix store a requirement rather than a guess: `omp` is a
// bash script whose first line is an absolute store path.
func (c *sandboxRuntimeClosure) shebang(head []byte) {
	line, _, _ := bytes.Cut(head, []byte("\n"))
	fields := strings.Fields(strings.TrimPrefix(string(line), "#!"))
	if len(fields) == 0 {
		return
	}
	c.executable(fields[0])
	if filepath.Base(fields[0]) != "env" {
		return
	}
	// `env` resolves its program through PATH, so the shebang does not name
	// it. Resolving it here against the host's PATH is a guess about the
	// guest, and it is the right one: the guest's PATH is the launch's own.
	for _, arg := range fields[1:] {
		if strings.HasPrefix(arg, "-") || strings.Contains(arg, "=") {
			continue
		}
		if resolved, err := exec.LookPath(arg); err == nil {
			c.executable(resolved)
		}
		return
	}
}

// linked reads an ELF object's dynamic loader and the libraries it links.
func (c *sandboxRuntimeClosure) linked(file *os.File, path string) {
	image, err := elf.NewFile(file)
	if err != nil {
		return
	}
	// The program interpreter is the one dependency an ELF names by absolute
	// path, and it is the one whose absence bubblewrap reports as a bare ENOENT
	// from exec.
	for _, prog := range image.Progs {
		if prog.Type != elf.PT_INTERP || prog.Filesz == 0 || prog.Filesz > 4096 {
			continue
		}
		body := make([]byte, prog.Filesz)
		if _, err := file.ReadAt(body, int64(prog.Off)); err != nil {
			continue
		}
		c.library(string(bytes.TrimRight(body, "\x00")))
	}

	needed, _ := image.DynString(elf.DT_NEEDED)
	if len(needed) == 0 {
		return
	}
	// An object that lives in a bulk root resolves its libraries inside that
	// root, and the root is bound whole, so there is nothing left to derive for
	// it and the host's search directories are not consulted on its behalf.
	// That is not a shortcut: a needed name a store object's own run path does
	// not carry is either satisfied by an object the loader has already loaded
	// — glibc names the dynamic loader itself that way — or is a broken
	// package, and resolving it against /usr/lib would bind a directory full of
	// libraries the object can never load and then walk their dependencies too.
	search := c.loaderDirs()
	if sandboxBulkRootOf(path) != "" {
		search = nil
	}
	own := sandboxRunPath(image, filepath.Dir(path))
	for _, soname := range needed {
		c.library(sandboxFindLibrary(soname, own, search, image.Class, image.Machine))
	}
}

// library takes one resolved shared object or dynamic loader.
func (c *sandboxRuntimeClosure) library(path string) {
	real, ok := sandboxRealFile(path)
	if !ok {
		return
	}
	// The name the object was found under has to resolve inside as well as the
	// file behind it: an ELF asks its kernel for /lib64/ld-linux-x86-64.so.2,
	// and on a merged-/usr distribution that path is a symlink whose target is
	// somewhere else entirely.
	c.add(path, true)
	c.add(real, true)
	c.dependencies(real)
}

// add records the narrowest bind that makes one resolved path reachable, and
// keeps the set free of paths an entry already covers.
func (c *sandboxRuntimeClosure) add(path string, library bool) {
	bind := sandboxBindFor(path, library)
	if bind == "" || c.bound[bind] {
		return
	}
	for existing := range c.bound {
		if sandboxCovers(existing, bind) {
			return
		}
	}
	// A new entry that covers earlier ones replaces them, so the plan carries
	// each directory once rather than a directory and three files inside it.
	kept := c.paths[:0]
	for _, existing := range c.paths {
		if sandboxCovers(bind, existing) {
			delete(c.bound, existing)
			continue
		}
		kept = append(kept, existing)
	}
	c.paths = append(kept, bind)
	c.bound[bind] = true
}

// loaderDirs is where the dynamic loader looks for a needed library that the
// object naming it gave no run path for: the directories /etc/ld.so.conf and
// its includes list, then glibc's built-in defaults.
//
// /etc/ld.so.cache is deliberately not read. It is an index over these same
// directories, so parsing its binary format would buy nothing but a second
// implementation of it; a library reachable only through the cache is named in
// sandboxRuntimePaths as a miss rather than guessed at.
func (c *sandboxRuntimeClosure) loaderDirs() []string {
	if c.search == nil {
		c.search = append(sandboxLoaderConfigDirs("/etc/ld.so.conf", 0),
			"/lib64", "/usr/lib64", "/lib", "/usr/lib")
	}
	return c.search
}

// sandboxLoaderConfigDirs reads the loader's configured search directories.
// The format is one directory per line, with comments, `include` globs and
// `hwcap` ordering hints — the last of which is not a directory at all.
func sandboxLoaderConfigDirs(path string, depth int) []string {
	if depth > 4 {
		return nil
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var dirs []string
	for _, line := range strings.Split(string(body), "\n") {
		if comment := strings.IndexByte(line, '#'); comment >= 0 {
			line = line[:comment]
		}
		line = strings.TrimSpace(line)
		switch {
		case line == "" || strings.HasPrefix(line, "hwcap "):
		case strings.HasPrefix(line, "include "):
			matches, _ := filepath.Glob(strings.TrimSpace(strings.TrimPrefix(line, "include ")))
			for _, match := range matches {
				dirs = append(dirs, sandboxLoaderConfigDirs(match, depth+1)...)
			}
		case filepath.IsAbs(line):
			dirs = append(dirs, filepath.Clean(line))
		}
	}
	return dirs
}

// sandboxRunPath is the object's own library search path: DT_RUNPATH, or
// DT_RPATH where there is no DT_RUNPATH, which is the order the loader uses.
//
// $ORIGIN is expanded because it is the whole point of a run path on a
// relocatable installation. An entry still carrying a token afterwards —
// $LIB, $PLATFORM — is dropped rather than guessed at: a wrong directory here
// would silently resolve a library to the wrong file.
func sandboxRunPath(image *elf.File, origin string) []string {
	entries, _ := image.DynString(elf.DT_RUNPATH)
	if len(entries) == 0 {
		entries, _ = image.DynString(elf.DT_RPATH)
	}
	var dirs []string
	for _, entry := range entries {
		for _, dir := range strings.Split(entry, ":") {
			dir = strings.ReplaceAll(dir, "${ORIGIN}", origin)
			dir = strings.ReplaceAll(dir, "$ORIGIN", origin)
			if dir == "" || strings.Contains(dir, "$") || !filepath.IsAbs(dir) {
				continue
			}
			dirs = append(dirs, filepath.Clean(dir))
		}
	}
	return dirs
}

// sandboxFindLibrary resolves one DT_NEEDED entry to a file, in the loader's
// own order: the object's run path first, then the configured directories. An
// entry it cannot resolve returns the empty string, which binds nothing.
//
// A candidate of the wrong architecture is skipped, which is not a refinement
// but the loader's own behaviour: a multiarch host lists its 32-bit
// directories in the same config file as its 64-bit ones, ld.so opens each
// candidate and rejects the ones whose ELF class or machine does not match, and
// a derivation that stopped at the first name match would bind a whole
// directory of libraries that could never be loaded — and, worse, would then
// walk that library's own dependencies and bind their directories too.
func sandboxFindLibrary(soname string, own, search []string, class elf.Class, machine elf.Machine) string {
	if strings.Contains(soname, "/") {
		// A needed entry with a slash is a path rather than a name, and the
		// loader treats it as one. A relative one is relative to a working
		// directory this cannot know.
		if filepath.IsAbs(soname) {
			return soname
		}
		return ""
	}
	for _, dirs := range [][]string{own, search} {
		for _, dir := range dirs {
			candidate := filepath.Join(dir, soname)
			if sandboxIsFile(candidate) && sandboxSameArch(candidate, class, machine) {
				return candidate
			}
		}
	}
	return ""
}

// sandboxSameArch reports whether a candidate library is one the object that
// needs it could actually load.
func sandboxSameArch(path string, class elf.Class, machine elf.Machine) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	image, err := elf.NewFile(file)
	if err != nil {
		return false
	}
	return image.Class == class && image.Machine == machine
}

// sandboxBindFor is the whole narrowness decision, in one place.
func sandboxBindFor(path string, library bool) string {
	switch {
	case path == "" || !filepath.IsAbs(path):
		return ""
	case path == sandboxRoot || strings.HasPrefix(path, sandboxRoot+"/"):
		// The guest layout owns this prefix and a host path here would collide
		// with it. Nothing is bound, the probe then fails to execute, and the
		// backend says so — which is the right outcome for a machine that keeps
		// its binaries where the sandbox keeps its own.
		return ""
	case sandboxBulkRootOf(path) != "":
		return sandboxBulkRootOf(path)
	case !library:
		// An executable is one file and the guest needs exactly that file.
		return path
	}
	// A shared object's siblings are part of it in practice: gconv modules,
	// versioned symlinks, glibc-hwcaps variants, an NSS module the object
	// opens by name. None of them is in any header and the directory is the
	// smallest unit that holds them all — but only where that directory is the
	// loader's own territory rather than somewhere a program was unpacked.
	if dir := filepath.Dir(path); sandboxIsLibraryDir(dir) {
		return dir
	}
	return path
}

// sandboxIsLibraryDir reports whether a directory may be bound whole.
func sandboxIsLibraryDir(dir string) bool {
	for _, prefix := range sandboxLibraryDirs {
		if dir == prefix || strings.HasPrefix(dir, prefix+"/") {
			return true
		}
	}
	return false
}

// sandboxBulkRootOf names the bulk root a path lives in, or the empty string.
// The Nix store is the only one Code knows how to recognise; the same shape
// elsewhere — Guix's /gnu/store, a conda or Spack prefix — is bound file by
// file instead, which works and may lose a dlopen sibling.
func sandboxBulkRootOf(path string) string {
	if strings.HasPrefix(path, sandboxStore+"/") {
		return sandboxStore
	}
	return ""
}

// sandboxCovers reports whether binding outer already makes inner reachable.
func sandboxCovers(outer, inner string) bool {
	return outer == inner || strings.HasPrefix(inner, strings.TrimSuffix(outer, "/")+"/")
}

// sandboxRealFile resolves a path to the regular file behind it, or reports
// that there is none. A path that does not exist is never a bind: that is the
// single rule this whole section exists to enforce, because bubblewrap refuses
// to start when a bind source is missing and the cost of one missing optional
// path is the entire boundary.
func sandboxRealFile(path string) (string, bool) {
	if path == "" || !filepath.IsAbs(path) {
		return "", false
	}
	real, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil || !sandboxIsFile(real) {
		return "", false
	}
	return real, true
}

func sandboxIsFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// ── the mount plan ───────────────────────────────────────────────────────────

// sandboxMounts is the guest filesystem, as bwrap arguments are built from it.
// Only three kinds exist, which is the point: read-only host paths, sized
// tmpfs, and the egress sockets. Nothing a run writes can land on a host
// filesystem because no writable host path is ever in this structure.
type sandboxMounts struct {
	// same binds a host path read-only at the identical path inside, which is
	// what the derived runtime paths, the CA bundle and the grant's corpus
	// need: a program resolves the absolute path it was launched from, and a
	// corpus path a finding cites must mean the same thing on both sides.
	same []string
	// at binds a host path read-only somewhere else inside, in insertion order.
	at []sandboxBind
	// scratch is a sized tmpfs, writable, gone with the mount namespace.
	scratch []string
}

type sandboxBind struct{ host, guest string }

// bindSame adds a read-only bind of a host path at the same path inside, if
// there is something there to bind.
//
// The existence check is the load-bearing line in this file. bubblewrap refuses
// to start when a bind source is missing, and it refuses for the whole plan: on
// a machine without one optional path — a Nix store, a CA bundle, a library
// directory another distribution keeps elsewhere — an unconditional bind takes
// the entire boundary down with it, the declaration degrades to no containment
// at all, and Babel refuses every run with a reason that names a directory
// rather than the portability gap it actually is. So a path that is not there
// is not a bind.
func (m *sandboxMounts) bindSame(host string) {
	if host == "" || !sandboxExists(host) {
		return
	}
	for _, existing := range m.same {
		if existing == host {
			return
		}
	}
	m.same = append(m.same, host)
}

// bindAt adds a read-only bind of a host path somewhere else inside. These are
// the guest layout's own binds — the helper, the config, the account pool, the
// egress sockets — and a missing one is a broken launch rather than an absent
// option, so contain reports it by name instead of dropping it silently.
func (m *sandboxMounts) bindAt(host, guest string) {
	if host == "" || guest == "" {
		return
	}
	m.at = append(m.at, sandboxBind{host: host, guest: guest})
}

// missing names the first guest-layout bind whose host path is not there.
func (m sandboxMounts) missing() string {
	for _, bind := range m.at {
		if !sandboxExists(bind.host) {
			return bind.host
		}
	}
	return ""
}

// readOnly is every path the guest sees read-only, in guest terms. The probe
// tries to write each one, which is how the read-only half of the filesystem
// claim is established on the plan this machine actually composed rather than
// on a path some other machine would have had.
func (m sandboxMounts) readOnly() []string {
	paths := make([]string, 0, len(m.same)+len(m.at))
	paths = append(paths, m.same...)
	for _, bind := range m.at {
		paths = append(paths, bind.guest)
	}
	return paths
}

func sandboxExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// args renders the mount plan. Order is load-bearing: bwrap applies operations
// in sequence, so the root tmpfs comes first, the writable tmpfs next, and the
// read-only binds last so that a bind under a tmpfs lands on the tmpfs rather
// than under it.
func (m sandboxMounts) args(ceilings sandboxCeilings) []string {
	// The root tmpfs holds nothing but mount points, so it is tiny on purpose:
	// a run that writes into a directory nobody mounted anything on hits a wall
	// immediately rather than filling RAM.
	args := []string{
		"--size", strconv.FormatInt(sandboxRootTmpfsBytes, 10), "--tmpfs", "/",
		"--proc", "/proc",
		"--dev", "/dev",
	}
	for _, dir := range append([]string{"/tmp"}, m.scratch...) {
		args = append(args, "--size", strconv.FormatInt(ceilings.DiskMaxBytes, 10), "--tmpfs", dir)
	}
	for _, host := range m.same {
		args = append(args, "--ro-bind", host, host)
	}
	for _, bind := range m.at {
		args = append(args, "--ro-bind", bind.host, bind.guest)
	}
	return args
}

// sandboxRootTmpfsBytes sizes the root tmpfs. It carries mount points and
// nothing else, so eight mebibytes is generous.
const sandboxRootTmpfsBytes = 8 << 20

// ── building a run ───────────────────────────────────────────────────────────

// contain resolves one launch into the command prefix that puts it inside the
// boundary. A backend that established no boundary returns nil, and the caller
// launches OMP directly — which Babel only ever allows for a run the operator
// explicitly relaxed, because the declaration says exactly that.
func (b *sandboxBackend) contain(request sandboxRequest) (*sandboxRun, error) {
	if b.facts.backend == sandboxBackendNone {
		return nil, nil
	}
	mounts := sandboxMounts{scratch: []string{sandboxRoot}}
	// What the run has to be able to execute, derived from the programs
	// themselves: the OMP binary at the path its own argv names, and whatever
	// it and Code's helper link or interpret. On the operator's machine that
	// resolves into the Nix store and the store is bound; on a machine that
	// has no store it resolves to that machine's own loader and libraries, and
	// the store is never named.
	for _, path := range sandboxRuntimePaths([]string{request.ompBinary}, []string{b.helper}) {
		mounts.bindSame(path)
	}
	mounts.bindSame(request.caBundle)
	for _, path := range request.corpus {
		mounts.bindSame(path)
	}
	mounts.bindAt(b.helper, sandboxHelperPath)
	mounts.bindAt(request.configHost, sandboxConfigPath)
	mounts.bindAt(request.poolHost, sandboxPoolPath)
	mounts.bindAt(request.egress.proxySocket(), sandboxProxySock)
	if socket := request.egress.brokerSocket(); socket != "" {
		mounts.bindAt(socket, sandboxBrokerSock)
	}
	if socket := request.egress.modelSocket(); socket != "" {
		mounts.bindAt(socket, sandboxModelSock)
	}
	// The guest layout's own binds are not optional, so an absent one is
	// reported here rather than left to bubblewrap: a launch that lost the
	// session's config or the egress socket it was going to authenticate
	// through must fail with the path it could not find.
	if absent := mounts.missing(); absent != "" {
		return nil, fmt.Errorf("the sandbox needs %s inside and there is nothing at that path on the host",
			absent)
	}

	spec := sandboxSpec{
		ProxyPort:   sandboxProxyPort,
		ProxySocket: sandboxProxySock,
		Scratch:     []string{sandboxHomePath, sandboxWorkPath},
	}
	if request.egress.brokerSocket() != "" {
		spec.BrokerPort = sandboxBrokerPort
		spec.BrokerSocket = sandboxBrokerSock
	}
	if request.egress.modelSocket() != "" {
		spec.ModelPort = sandboxModelPort
		spec.ModelSocket = sandboxModelSock
	}
	encoded, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}

	reportR, reportW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	run := &sandboxRun{
		egress:  request.egress,
		spec:    spec,
		reportR: reportR,
		reportW: reportW,
		env: append([]string{sandboxSpecEnv + "=" + string(encoded)},
			b.scopeEnv...),
		prefix: b.enter(mounts, sandboxWorkPath,
			sandboxHelperPath, sandboxHelperCommand, sandboxHelperEgress, "--"),
	}
	if b.systemd != "" {
		run.verify = b.verifyCeilings
	}
	return run, nil
}

// enter builds the command that puts guest inside the boundary: the transient
// scope, then bwrap with the mount plan, then the guest itself.
//
// cwd is the working directory the guest starts in. It is a parameter rather
// than a constant because the escape scenarios have to be able to point it
// somewhere else to show that where it points matters: OMP registers MCP
// servers — which reach the network without passing Babel's broker — from a
// config file at the root of its working directory, so a run whose cwd was the
// corpus would let archived material register unbrokered egress. Every
// production launch passes sandboxWorkPath, a tmpfs the sandbox creates empty.
func (b *sandboxBackend) enter(mounts sandboxMounts, cwd string, guest ...string) []string {
	var argv []string
	if b.systemd != "" {
		argv = append(argv, b.systemd, "--user", "--scope", "--quiet", "--collect",
			"-p", "MemoryMax="+strconv.FormatInt(b.ceilings.MemoryMaxBytes, 10),
			// A memory ceiling a run can page around is not a ceiling.
			"-p", "MemorySwapMax=0",
			"-p", "CPUQuota="+strconv.Itoa(b.ceilings.CPUQuotaPercent)+"%",
			"-p", "TasksMax="+strconv.Itoa(b.ceilings.TasksMax),
			"--")
	}
	argv = append(argv, b.bwrap,
		// Every namespace at once. --unshare-net is the one the network
		// declaration rests on: the sandbox gets a fresh network namespace
		// whose only interface is its own loopback.
		"--unshare-all",
		// The whole tree dies with bwrap, and bwrap dies with Code. Combined
		// with the PID namespace this is what makes a cancellation reap
		// everything rather than orphan a subagent.
		"--die-with-parent",
		// A session of its own, so nothing inside can push characters back
		// onto a terminal Code might be attached to.
		"--new-session",
	)
	argv = append(argv, mounts.args(b.ceilings)...)
	argv = append(argv,
		"--dir", sandboxHomePath,
		"--dir", sandboxWorkPath,
		"--chdir", cwd,
		// The scope needs these to reach the user manager; the guest must not
		// see a runtime directory that does not exist inside.
		"--unsetenv", "XDG_RUNTIME_DIR",
		"--unsetenv", "DBUS_SESSION_BUS_ADDRESS",
		"--")
	return append(argv, guest...)
}

// ── verifying the ceilings ───────────────────────────────────────────────────

// verifyCeilings reads the scope's cgroup back and reports whether the kernel
// installed what systemd was asked for, together with the directory it read.
//
// It reads the live cgroup of the process that was started rather than
// computing a unit path, because the slice layout is a systemd implementation
// detail and /proc/PID/cgroup is the process's own answer. The poll exists
// because a scope is registered over D-Bus a moment after the process starts,
// so the first read can legitimately land before the move.
//
// The directory is returned rather than kept here because a backend outlives a
// run and a scope does not: the same cgroup that proved the ceiling is where
// this run's usage is read from, and the next run's scope is a different one.
func (b *sandboxBackend) verifyCeilings(pid int) (string, error) {
	deadline := time.Now().Add(5 * time.Second)
	var last error
	for {
		path, err := sandboxCgroupOf(pid)
		if err == nil && strings.HasSuffix(path, ".scope") {
			dir := "/sys/fs/cgroup" + path
			if err := b.checkCgroup(dir); err == nil {
				return dir, nil
			} else {
				last = err
			}
		} else if err != nil {
			last = err
		} else {
			last = fmt.Errorf("the process is in cgroup %q, which is not a transient scope", path)
		}
		if time.Now().After(deadline) {
			if last == nil {
				last = errors.New("the scope's cgroup never appeared")
			}
			return "", last
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func sandboxCgroupOf(pid int) (string, error) {
	body, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cgroup")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(strings.TrimSpace(string(body)), "\n") {
		// cgroup v2 writes exactly one line, "0::<path>".
		if strings.HasPrefix(line, "0::") {
			return strings.TrimPrefix(line, "0::"), nil
		}
	}
	return "", errors.New("the process has no cgroup v2 membership, so no unified ceiling can be enforced")
}

// checkCgroup compares the three ceilings against the files the kernel exposes.
// Each one is read rather than assumed, because systemd accepts a property it
// cannot install and reports success.
func (b *sandboxBackend) checkCgroup(dir string) error {
	memory, err := sandboxCgroupInt(dir, "memory.max")
	if err != nil {
		return err
	}
	if memory != b.ceilings.MemoryMaxBytes {
		return fmt.Errorf("memory.max is %d, not the %d that was requested", memory, b.ceilings.MemoryMaxBytes)
	}
	tasks, err := sandboxCgroupInt(dir, "pids.max")
	if err != nil {
		return err
	}
	if tasks != int64(b.ceilings.TasksMax) {
		return fmt.Errorf("pids.max is %d, not the %d that was requested", tasks, b.ceilings.TasksMax)
	}
	quota, err := os.ReadFile(filepath.Join(dir, "cpu.max"))
	if err != nil {
		return fmt.Errorf("cpu.max is not readable, so no CPU ceiling is installed: %w", err)
	}
	fields := strings.Fields(string(quota))
	if len(fields) != 2 || fields[0] == "max" {
		return fmt.Errorf("cpu.max is %q, which is not a quota", strings.TrimSpace(string(quota)))
	}
	allowed, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil {
		return err
	}
	period, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil {
		return err
	}
	if want := period * int64(b.ceilings.CPUQuotaPercent) / 100; allowed != want {
		return fmt.Errorf("cpu.max allows %d per %d, not the %d%% that was requested",
			allowed, period, b.ceilings.CPUQuotaPercent)
	}
	return nil
}

func sandboxCgroupInt(dir, name string) (int64, error) {
	body, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		return 0, fmt.Errorf("%s is not readable, so no ceiling of that kind is installed: %w", name, err)
	}
	text := strings.TrimSpace(string(body))
	if text == "max" {
		return 0, fmt.Errorf("%s is unlimited", name)
	}
	return strconv.ParseInt(text, 10, 64)
}

// ── the probe ────────────────────────────────────────────────────────────────

// probe launches the real backend with a payload that tries to break out, and
// reports what it saw. It is the only thing containment() believes.
//
// The payload writes its report and then blocks on stdin. That handshake is
// what makes the ceiling check deterministic: the parent reads the report,
// knows the process is alive, reads the scope's cgroup, and only then lets the
// payload exit. Polling a process that may already have finished would make the
// strongest claim in the declaration depend on a race.
func (b *sandboxBackend) probe(withScope bool) (sandboxProbeReport, bool, error) {
	root, err := os.MkdirTemp("", "code-sandbox-probe-*")
	if err != nil {
		return sandboxProbeReport{}, false, err
	}
	defer os.RemoveAll(root)
	outside := filepath.Join(root, "host-state")
	if err := os.WriteFile(outside, []byte("host state the sandbox must not reach\n"), 0o600); err != nil {
		return sandboxProbeReport{}, false, err
	}

	// The probe payload is Code's own binary, bound at the guest layout's path,
	// so what it needs is whatever that binary links — nothing at all where it
	// is statically linked, this machine's loader and libc where it is not, and
	// the Nix store where it came from one.
	mounts := sandboxMounts{scratch: []string{sandboxRoot}}
	for _, path := range sandboxRuntimePaths(nil, []string{b.helper}) {
		mounts.bindSame(path)
	}
	mounts.bindAt(b.helper, sandboxHelperPath)

	spec := sandboxSpec{Outside: outside, Scratch: []string{sandboxWorkPath},
		ReadOnly: mounts.readOnly()}
	encoded, err := json.Marshal(spec)
	if err != nil {
		return sandboxProbeReport{}, false, err
	}

	systemd := b.systemd
	if !withScope {
		systemd = ""
	}
	probe := &sandboxBackend{helper: b.helper, bwrap: b.bwrap, systemd: systemd,
		scopeEnv: b.scopeEnv, ceilings: b.ceilings}
	// The probe enters through the same door as a run and carries a different
	// payload: the same namespaces, the same mounts, the same scope, and no
	// egress at all, because a probe has nothing to say to a provider.
	argv := probe.enter(mounts, sandboxWorkPath,
		sandboxHelperPath, sandboxHelperCommand, sandboxHelperProbe)

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Args = argv
	cmd.Env = append([]string{
		"PATH=" + os.Getenv("PATH"),
		sandboxSpecEnv + "=" + string(encoded),
	}, probe.scopeEnv...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return sandboxProbeReport{}, false, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return sandboxProbeReport{}, false, err
	}
	var diagnostics bytes.Buffer
	cmd.Stderr = &diagnostics
	if err := cmd.Start(); err != nil {
		return sandboxProbeReport{}, false, err
	}
	// Whatever happens below, nothing the probe started outlives this function.
	defer func() {
		_ = stdin.Close()
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	}()

	type answer struct {
		report sandboxProbeReport
		err    error
	}
	answers := make(chan answer, 1)
	go func() {
		line, err := bufio.NewReader(stdout).ReadBytes('\n')
		if err != nil && len(line) == 0 {
			answers <- answer{err: err}
			return
		}
		var report sandboxProbeReport
		if err := json.Unmarshal(bytes.TrimSpace(line), &report); err != nil {
			answers <- answer{err: err}
			return
		}
		answers <- answer{report: report}
	}()

	var got answer
	select {
	case got = <-answers:
	case <-time.After(sandboxProbeTimeout):
		return sandboxProbeReport{}, false, errors.New("the sandbox probe did not report in time")
	}
	if got.err != nil {
		detail := strings.TrimSpace(diagnostics.String())
		if detail == "" {
			detail = got.err.Error()
		}
		return sandboxProbeReport{}, false, errors.New(detail)
	}

	// The payload is blocked on stdin now, so the scope is certainly still
	// alive and its cgroup is certainly still there. That is the whole point of
	// the handshake: the ceiling check reads a running process rather than
	// racing one that has already reported and gone.
	ceilingsOK := false
	if withScope && b.systemd != "" {
		if _, err := b.verifyCeilings(cmd.Process.Pid); err == nil {
			ceilingsOK = true
		}
	}
	// Release it; the deferred kill is the backstop, not the plan.
	_, _ = stdin.Write([]byte("\n"))
	return got.report, ceilingsOK, nil
}
