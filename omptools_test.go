package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ── the tool-surface obligation ──────────────────────────────────────────────
//
// Babel's whole disclosure argument is that the model reaches evidence only
// through the broker: Code asks Babel, Babel decides, and the answer comes back
// as a host-tool result. A tool in OMP's registry that Code did not broker
// breaks that argument outright, because it moves bytes without asking.
//
// `--no-tools` is not by itself that guarantee. Measured against omp 18.0.11
// with the operator's own home visible, `--no-tools` leaves eight tools
// registered — `learn`, `manage_skill`, `tts`, and five `mcp__*` tools
// discovered from the operator's MCP configuration:
//
//	$ omp --mode rpc --no-tools --no-lsp --no-session --no-extensions \
//	      --no-rules --no-skills --no-title --auto-approve --config <empty> --cwd <tmp>
//	get_state.dumpTools -> [manage_skill learn
//	                        mcp__openaideveloperdocs_fetch_openai_doc
//	                        mcp__openaideveloperdocs_get_openapi_spec
//	                        mcp__openaideveloperdocs_list_api_endpoints
//	                        mcp__openaideveloperdocs_list_openai_docs
//	                        mcp__openaideveloperdocs_search_openai_docs tts]
//
// What empties that registry is the run's private home, because every one of
// those tools is gated on configuration OMP discovers under a home:
// `autolearn.enabled` registers `learn` and `manage_skill`, `speechgen.enabled`
// registers `tts` (see omp://tools/learn.md, omp://tools/manage-skill.md,
// omp://tools/tts.md), and MCP servers are discovered from files. Until this
// file existed, that was a claim in a comment in omprpc.go. It is now measured.
//
// The private home is not the only channel, and it is worth naming the two it
// does not cover, because neither is guarded anywhere:
//
//   - The `--config` overlay. Measured with a private home, an overlay carrying
//     `speechgen.enabled: true` registers `tts`, and one carrying
//     `autolearn.enabled: true` with a `memory.backend` registers `learn` and
//     `manage_skill`. Code writes that overlay itself from genConfigYAML, so it
//     is Code's to keep clean rather than an attacker's to set — but a routing
//     block that ever emits one of those keys re-registers the tool silently.
//     `mcpServers` in the overlay is not a discovery source; it registers
//     nothing.
//   - The working directory, which the third test below covers.
//
// The tests below assert the property rather than a tool list, because a
// harmless OMP release adds tools and an assertion that named them would fail
// on every one:
//
//   - TestOmpWorkerModeRegistersNothingCodeDidNotBroker asks the real binary,
//     through the real launch path, what it registered, and requires nothing.
//   - TestOmpToolDumpObservesDiscoveredMcpTools is the canary: it plants an MCP
//     server the launch would discover and requires the enumeration to see it,
//     so the test above cannot pass by having gone blind.
//   - TestOmpWorkerLaunchDirectoryCarriesNoDiscoverableConfig guards the one
//     discovery root a private home does not cover — the working directory.
//
// Egress, per tool that OMP can register here, determined from OMP's own docs:
//
//	mcp__*       yes, by construction. An MCP server is an arbitrary command
//	             holding the child's network; nothing routes it through Babel.
//	tts          yes when providers.tts is xai or deepinfra, which POST the
//	             (model-chosen) text to a third-party speech API; the local
//	             Kokoro backend is on-device. auto prefers local but routes an
//	             MP3 request to xAI when xAI credentials resolve.
//	learn        yes when memory.backend is hindsight, which is a remote
//	             HTTP service (hindsight.apiUrl). The local and mnemopi
//	             backends write learned.md / SQLite and do not egress.
//	manage_skill no network path found; it writes SKILL.md under the
//	             managed-skills root. Not egress, but it does write.

// ompToolDumpTimeout bounds one enumeration. A launch that has not answered
// get_state by then has not started, and reporting that is worth more than a
// hung test.
const ompToolDumpTimeout = 120 * time.Second

// ompRequireOmpEnv turns a missing `omp` from a loud skip into a failure, for a
// gate that must not pass without having measured anything.
const ompRequireOmpEnv = "CODE_TEST_REQUIRE_OMP"

// ompMcpProbeSentinel marks the argv of the test binary re-execed as the canary's
// MCP server.
const ompMcpProbeSentinel = "code-mcp-probe-server"

// ompMcpProbeToolName is the tool that server advertises. The registered name is
// derived from it, so the canary matches on the mcp__ prefix rather than on a
// composition rule OMP is free to change.
const ompMcpProbeToolName = "unbrokered_egress_canary"

// ompWorkerLaunch builds exactly what drive() launches: the run's private
// directory, the child environment ompChildEnv derives, and the argv ompArgv
// fixes. It deliberately calls the production functions rather than restating
// them — if the launch path changes where the child's home, cwd or flags come
// from, that change has to arrive here.
func ompWorkerLaunch(t *testing.T) (ompLaunch, *ompRunDir) {
	t.Helper()
	binary, err := exec.LookPath("omp")
	if err != nil {
		ompUnverified(t, "omp is not on PATH, so the tool registry under Code's "+
			"worker-mode flags was not measured: an unbrokered-egress tool could be "+
			"registered and this run would not know")
	}
	dir, err := ompNewRunDir("")
	if err != nil {
		t.Fatalf("the run directory could not be created: %v", err)
	}
	t.Cleanup(dir.remove)

	// The zero job carries no broker token, and the zero auth is unconfigured,
	// so ompChildEnv adds no broker variables. Both are what this measurement
	// wants: the environment's tool-surface properties, with no credential in it.
	return ompLaunch{
		binary: binary,
		config: dir.config,
		home:   dir.home,
		work:   dir.work,
		env:    ompChildEnv(os.Environ(), dir.home, babelJob{}, ompAuth{}),
	}, dir
}

// ompUnverified skips, but says on stderr what went unmeasured. A skip nobody
// sees is how a guard silently stops guarding; `go test` without -v swallows
// t.Log, so this does not use it.
func ompUnverified(t *testing.T, reason string) {
	t.Helper()
	if os.Getenv(ompRequireOmpEnv) != "" {
		t.Fatalf("%s=1 and %s", ompRequireOmpEnv, reason)
	}
	fmt.Fprintf(os.Stderr, "\nUNVERIFIED (%s): %s\n"+
		"Set %s=1 to make this a failure instead.\n\n", t.Name(), reason, ompRequireOmpEnv)
	t.Skip(reason)
}

// ompDumpTools asks a real OMP what its session tool registry holds, using
// OMP's own machine-readable surface: the `get_state` response carries
// `dumpTools`, one entry per registered tool (omp://rpc.md). Nothing is parsed
// out of prose, and nothing is inferred from the flags.
func ompDumpTools(t *testing.T, launch ompLaunch) []string {
	t.Helper()
	argv := ompArgv(launch)

	ctx, cancel := context.WithTimeout(context.Background(), ompToolDumpTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Args = argv
	cmd.Env = ompToolProbeEnv(launch.env)
	cmd.Dir = launch.work

	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("StdinPipe: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	stderr := &ompTail{}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		t.Fatalf("omp did not start: %v", err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Wait()
	}()

	if _, err := stdin.Write([]byte(`{"id":"dump","type":"get_state"}` + "\n")); err != nil {
		t.Fatalf("the get_state command was not accepted: %v (stderr: %s)", err, stderr)
	}

	lines := bufio.NewScanner(stdout)
	lines.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for lines.Scan() {
		var frame struct {
			Type    string `json:"type"`
			Command string `json:"command"`
			Success bool   `json:"success"`
			Error   string `json:"error"`
			Data    *struct {
				// A pointer, so "OMP stopped reporting dumpTools" is
				// distinguishable from "the registry is empty". Conflating them
				// is exactly how this guard would go quiet.
				DumpTools *[]struct {
					Name string `json:"name"`
				} `json:"dumpTools"`
			} `json:"data"`
		}
		if err := json.Unmarshal(lines.Bytes(), &frame); err != nil {
			continue // event frames this measurement does not read
		}
		if frame.Type != "response" || frame.Command != "get_state" {
			continue
		}
		if !frame.Success {
			t.Fatalf("get_state failed: %s (stderr: %s)", frame.Error, stderr)
		}
		if frame.Data == nil || frame.Data.DumpTools == nil {
			t.Fatalf("get_state carried no dumpTools, so the tool registry was not "+
				"enumerated and no property below is measured. OMP's state surface "+
				"changed; find the replacement in omp://rpc.md. (stderr: %s)", stderr)
		}
		names := make([]string, 0, len(*frame.Data.DumpTools))
		for _, tool := range *frame.Data.DumpTools {
			names = append(names, tool.Name)
		}
		return names
	}
	t.Fatalf("omp never answered get_state; the registry was not enumerated (stderr: %s)", stderr)
	return nil
}

// ompToolProbeEnv finishes the child environment for a measurement. Two
// adjustments, both about not depending on the machine running the test:
//
// Every credential-shaped variable is dropped. A real key is not needed —
// get_state makes no provider call — and a measurement that used one would be a
// measurement that behaved differently on the operator's machine.
//
// A placeholder key is then added, because OMP exits before serving RPC when no
// provider resolves at all ("No models available"), and a test that could not
// tell that apart from a clean launch would report nothing.
func ompToolProbeEnv(env []string) []string {
	const placeholder = "OPENAI_API_KEY=placeholder-not-a-credential"
	out := make([]string, 0, len(env)+1)
	seen := map[string]int{}
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if ompCredentialShaped(key) {
			continue
		}
		if at, ok := seen[key]; ok {
			out[at] = entry // last wins, as exec would resolve it
			continue
		}
		seen[key] = len(out)
		out = append(out, entry)
	}
	return append(out, placeholder)
}

// ompCredentialShaped reports whether a variable names a credential or points at
// one. authEnvKeys is the auth broker's own list: OMP refuses to start when
// OMP_AUTH_BROKER_URL is set without a token, so leaving an operator's broker
// variables half-stripped would abort the launch rather than measure it.
func ompCredentialShaped(key string) bool {
	if authEnvKeys[key] {
		return true
	}
	for _, mark := range []string{"API_KEY", "TOKEN", "SECRET", "PASSWORD", "OAUTH", "CREDENTIAL", "COOKIE"} {
		if strings.Contains(key, mark) {
			return true
		}
	}
	return false
}

// TestOmpWorkerModeRegistersNothingCodeDidNotBroker is the property, measured
// against the real binary through the real launch path.
//
// The registry has to be empty here, and empty is the honest form of the
// assertion rather than a strict one: at this point in the launch Code has sent
// no set_host_tools, so every brokered tool is still absent, and anything OMP
// registered is by definition something Code did not broker. Naming the tools
// that may not appear would instead be a bet on OMP's tool names, which change
// for harmless reasons.
//
// A new default-on OMP tool that survives --no-tools fails this test. That is
// the intended outcome: whether it can egress is a question a person has to
// answer before a supervised run inherits it.
func TestOmpWorkerModeRegistersNothingCodeDidNotBroker(t *testing.T) {
	launch, _ := ompWorkerLaunch(t)
	got := ompDumpTools(t, launch)
	if len(got) == 0 {
		return
	}
	unbrokered := make([]string, 0, len(got))
	for _, name := range got {
		if strings.HasPrefix(name, ompMcpToolPrefix) {
			unbrokered = append(unbrokered, name)
		}
	}
	if len(unbrokered) > 0 {
		t.Fatalf("MCP-discovered tools are registered in a supervised run: %v.\n"+
			"An MCP server is an arbitrary process holding the child's network, so these "+
			"move bytes without asking Babel. Find the configuration they were discovered "+
			"from (omp://mcp-config.md lists every source) and make it undiscoverable.\n"+
			"Full registry: %v", unbrokered, got)
	}
	t.Fatalf("omp registered %d tool(s) Code did not broker: %v.\n"+
		"Every tool in a supervised run is supposed to be one Babel authorized. Establish "+
		"for each of these whether it can reach the network or the filesystem outside the "+
		"run directory; if it can, the containment declaration overstates the boundary and "+
		"the tool has to be disabled rather than tolerated.", len(got), got)
}

// ompMcpToolPrefix is how OMP names a tool it discovered from an MCP server.
const ompMcpToolPrefix = "mcp__"

// TestOmpToolDumpObservesDiscoveredMcpTools is why the test above means
// anything. It plants an MCP server in the launch's own working directory and
// requires the enumeration to report it.
//
// Without this, every way the measurement could go blind — dumpTools renamed,
// get_state answering before MCP discovery completes, the probe never reaching
// a real OMP — reads as "the registry is empty", which is the answer the
// property test wants. This test fails in exactly those cases.
//
// It also records, executably, what the working directory costs: a
// project-scoped MCP config is discovered from the child's cwd, which no
// private home covers.
func TestOmpToolDumpObservesDiscoveredMcpTools(t *testing.T) {
	launch, _ := ompWorkerLaunch(t)

	self, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	config := map[string]any{
		"mcpServers": map[string]any{
			"canary": map[string]any{
				"type":    "stdio",
				"command": self,
				"args":    []string{"-test.run=^TestOmpMcpProbeServer$", "--", ompMcpProbeSentinel},
			},
		},
	}
	body, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("marshalling the canary config: %v", err)
	}
	if err := os.WriteFile(filepath.Join(launch.work, ".mcp.json"), body, 0o600); err != nil {
		t.Fatalf("planting the canary config: %v", err)
	}

	got := ompDumpTools(t, launch)
	for _, name := range got {
		if strings.HasPrefix(name, ompMcpToolPrefix) && strings.Contains(name, ompMcpProbeToolName) {
			return
		}
	}
	t.Fatalf("the canary MCP tool %q was not reported; the registry read as %v.\n"+
		"This measurement cannot see MCP-discovered tools, so "+
		"TestOmpWorkerModeRegistersNothingCodeDidNotBroker proves nothing until it can. "+
		"Either OMP's get_state.dumpTools no longer reports discovered tools, or MCP "+
		"discovery no longer reads the child's working directory, or the probe server "+
		"failed to start. Establish which before trusting the empty registry.",
		ompMcpProbeToolName, got)
}

// TestOmpWorkerLaunchDirectoryCarriesNoDiscoverableConfig guards the discovery
// root the private home does not reach.
//
// MCP discovery is scoped to the child's working directory — measured against
// omp 18.0.11, a config in the parent of the cwd or in a subdirectory of it is
// not found, and a config in the cwd itself is found from all of `.mcp.json`,
// `mcp.json`, `.omp/mcp.json`, `.omp/.mcp.json`, `.claude/mcp.json`,
// `.claude/.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
// `.gemini/settings.json`, `.codex/config.toml`, `.windsurf/mcp_config.json`
// and `opencode.json`. Replacing HOME does nothing about any of them.
//
// So the assertion is not "none of those twelve files is present" — that would
// be a list to keep current against OMP's discovery, and a source added in a
// later release would slip through it. The assertion is that the directory is
// empty. An empty directory carries no discovery source, named or not.
//
// This is the test that fails the day the corpus is bound at the child's cwd. A
// corpus is an archived repository; a repository with an `.mcp.json` in it is
// entirely ordinary. The remedy is to keep the child's cwd a directory Code
// owns and mount the corpus somewhere the child is pointed at explicitly, not
// somewhere OMP scans.
//
// The directory it checks is read out of the argv the launch path emits rather
// than out of ompRunDir, because `--cwd` is what OMP actually scans. A sandboxed
// launch that moves the cwd moves it there, and this guard follows.
func TestOmpWorkerLaunchDirectoryCarriesNoDiscoverableConfig(t *testing.T) {
	dir, err := ompNewRunDir("")
	if err != nil {
		t.Fatalf("the run directory could not be created: %v", err)
	}
	defer dir.remove()

	argv := ompArgv(ompLaunch{binary: "omp", config: dir.config, home: dir.home, work: dir.work})
	work := ""
	for i, arg := range argv {
		if arg == "--cwd" && i+1 < len(argv) {
			work = argv[i+1]
		}
	}
	if work == "" {
		t.Fatalf("the launch argv names no --cwd, so the directory OMP scans for MCP "+
			"config is not stated anywhere this guard can read: %v.\n"+
			"Point this test at whatever now determines the child's working directory.", argv)
	}

	entries, err := os.ReadDir(work)
	if os.IsNotExist(err) {
		ompUnverified(t, fmt.Sprintf("the child's working directory %q does not exist on "+
			"the host, so whether it is empty at launch was not measured. It is presumably "+
			"created inside a sandbox; point this guard at the host directory backing it, "+
			"or OMP may discover an MCP server there and egress without asking Babel", work))
	}
	if err != nil {
		t.Fatalf("reading the child's working directory: %v", err)
	}
	if len(entries) == 0 {
		return
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	t.Fatalf("the child's working directory %q is not empty at launch: %v.\n"+
		"OMP discovers MCP servers from the working directory, and a discovered MCP "+
		"server egresses without asking Babel. Whatever put these here has to be moved "+
		"out of the cwd, or every MCP config source OMP reads from a project root has to "+
		"be provably absent from it (omp://mcp-config.md enumerates them).", work, names)
}

// TestOmpMcpProbeServer doubles as the stdio MCP server the canary discovers.
// The test binary re-execs itself, which is how the driver tests already build a
// fake child; a separate binary would need a toolchain at test time.
func TestOmpMcpProbeServer(t *testing.T) {
	if !ompMcpProbeInvoked() {
		t.Skip("this test doubles as the MCP server TestOmpToolDumpObservesDiscoveredMcpTools plants")
	}
	ompMcpProbeServe()
}

func ompMcpProbeInvoked() bool {
	for i, arg := range os.Args {
		if arg == "--" {
			return i+1 < len(os.Args) && os.Args[i+1] == ompMcpProbeSentinel
		}
	}
	return false
}

// ompMcpProbeServe speaks the minimum MCP a client needs to enumerate one tool,
// and no more. It opens no socket and reads no file: what it proves is that OMP
// found the configuration naming it, which is the whole question.
func ompMcpProbeServe() {
	answer := func(id json.RawMessage, result any) {
		body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
		if err != nil {
			return
		}
		fmt.Fprintln(os.Stdout, string(body))
	}
	lines := bufio.NewScanner(os.Stdin)
	lines.Buffer(make([]byte, 0, 4<<10), 4<<20)
	for lines.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				ProtocolVersion string `json:"protocolVersion"`
			} `json:"params"`
		}
		if err := json.Unmarshal(lines.Bytes(), &request); err != nil {
			continue
		}
		switch {
		case request.Method == "initialize":
			version := request.Params.ProtocolVersion
			if version == "" {
				version = "2024-11-05"
			}
			answer(request.ID, map[string]any{
				"protocolVersion": version,
				"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
				"serverInfo":      map[string]any{"name": "canary", "version": "0.0.0"},
			})
		case request.Method == "tools/list":
			answer(request.ID, map[string]any{"tools": []any{map[string]any{
				"name": ompMcpProbeToolName,
				"description": "Test-only. Its presence in OMP's registry means a config " +
					"file naming an MCP server was discovered.",
				"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
			}}})
		case request.Method == "resources/list":
			answer(request.ID, map[string]any{"resources": []any{}})
		case request.Method == "prompts/list":
			answer(request.ID, map[string]any{"prompts": []any{}})
		case len(request.ID) > 0:
			body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID,
				"error": map[string]any{"code": -32601, "message": "not implemented"}})
			if err == nil {
				fmt.Fprintln(os.Stdout, string(body))
			}
		}
	}
	os.Exit(0)
}
