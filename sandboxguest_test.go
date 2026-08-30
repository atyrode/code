package main

// The stand-in OMP the sandbox tests drive.
//
// A contained session has no shell and no libc outside the Nix store, so a fake
// OMP cannot be a shell script the way the driver tests' one is: it has to be a
// real executable that already exists inside the boundary. This test binary is
// that executable, and TestMain routes it here when the environment says so.
//
// It lives in a portable file even though only Linux has a backend, because
// TestMain is one per package and the dispatch it performs has to compile
// everywhere.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// sandboxFakeOmpEnv makes this test binary answer as OMP. It is an environment
// switch rather than an argv one because the driver builds OMP's command line
// itself, deliberately, and a test that could inject an argument into it would
// be testing a command line production never uses.
const sandboxFakeOmpEnv = "CODE_SANDBOX_FAKE_OMP"

// sandboxFakeLoadEnv asks the stand-in OMP to consume a measurable amount of
// each thing the ceilings bound: mebibytes of resident anonymous memory, the
// same number of mebibytes written to the run's scratch tmpfs, and a fixed
// stretch of CPU. It exists so a test can drive two contained runs that differ
// only in how much they used and check that the reported figures differ the
// same way — which is the only way to tell a measurement from a constant.
const sandboxFakeLoadEnv = "CODE_SANDBOX_FAKE_LOAD"

// sandboxGuestBurn is how long the loaded guest spins. It has to be long
// enough to dominate the CPU a bare contained launch spends starting bwrap and
// this binary, which is a few hundred milliseconds.
const sandboxGuestBurn = 1500 * time.Millisecond

// sandboxGuestSink is where the burn loop's result goes, so the compiler cannot
// delete the work the test is measuring.
var sandboxGuestSink uint64

// sandboxApplyGuestLoad consumes what sandboxFakeLoadEnv asks for, from inside
// the sandbox, and reports the bytes it left on the scratch tmpfs.
//
// The memory is touched a page at a time rather than merely allocated: a cgroup
// charges resident pages, so an untouched mapping would move no counter and the
// test would be measuring nothing. It is kept alive across the CPU burn for the
// same reason — memory.peak is a high-water mark, and a block the collector
// freed before the parent read the file was never at the mark.
func sandboxApplyGuestLoad() {
	mib, err := strconv.Atoi(os.Getenv(sandboxFakeLoadEnv))
	if err != nil || mib <= 0 {
		return
	}
	block := make([]byte, int64(mib)<<20)
	for i := 0; i < len(block); i += 4096 {
		block[i] = byte(i)
	}
	_ = os.WriteFile(filepath.Join(sandboxWorkPath, "payload"), block, 0o600)

	sink := sandboxGuestSink
	deadline := time.Now().Add(sandboxGuestBurn)
	for time.Now().Before(deadline) {
		for range 1 << 16 {
			sink = sink*6364136223846793005 + 1442695040888963407
		}
	}
	sandboxGuestSink = sink
	runtime.KeepAlive(block)
}

// sandboxGuestView is what the fake OMP reports about the world it woke up in.
// It travels back as the session's assistant text, which is the only channel
// out of a sandbox whose filesystem is destroyed at teardown.
type sandboxGuestView struct {
	Cwd            string   `json:"cwd"`
	Home           string   `json:"home"`
	Proxy          string   `json:"proxy"`
	BrokerURL      string   `json:"broker_url"`
	PoolPath       string   `json:"pool_path"`
	PoolReadable   bool     `json:"pool_readable"`
	ConfigReadable bool     `json:"config_readable"`
	Routes         int      `json:"routes"`
	BrokerStatus   string   `json:"broker_status"`
	RefusedStatus  string   `json:"refused_status"`
	Root           []string `json:"root"`
	Argv           []string `json:"argv"`
	TokenOnArgv    bool     `json:"token_on_argv"`
}

// runSandboxFakeOmp speaks just enough of OMP's RPC protocol to be driven to a
// terminal event, and spends its one assistant message describing the sandbox
// it is running in.
func runSandboxFakeOmp() int {
	emit := func(line string) {
		fmt.Fprintln(os.Stdout, line)
	}
	emit(`{"type":"ready","protocolVersion":1}`)
	lines := bufio.NewScanner(os.Stdin)
	lines.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for lines.Scan() {
		var command struct {
			ID   string `json:"id"`
			Type string `json:"type"`
		}
		if json.Unmarshal(lines.Bytes(), &command) != nil {
			continue
		}
		switch command.Type {
		case ompCommandSetHostTools:
			emit(`{"id":"` + command.ID + `","type":"response","command":"set_host_tools",` +
				`"success":true,"data":{"toolNames":[]}}`)
		case ompCommandPrompt:
			emit(`{"id":"` + command.ID + `","type":"response","command":"prompt",` +
				`"success":true,"data":{"agentInvoked":true}}`)
			emit(`{"type":"agent_start"}`)
			emit(`{"type":"turn_start"}`)
			// Before the view is reported, because the parent reads the
			// cgroup while this process is still inside it.
			sandboxApplyGuestLoad()
			view, err := json.Marshal(sandboxObserveGuest())
			if err != nil {
				view = []byte(`{}`)
			}
			delta, err := json.Marshal(string(view))
			if err != nil {
				delta = []byte(`"{}"`)
			}
			emit(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":` +
				string(delta) + `},"message":{"role":"assistant","content":[]}}`)
			// One recorded candidate, so the run has the durable output the
			// driver requires and does not spend a follow-up turn asking for
			// one. The statement is about the boundary because that is the
			// only thing this stand-in knows anything about.
			emit(`{"type":"host_tool_call","id":"host_1","toolCallId":"toolu_1",` +
				`"toolName":"babel_record_hypothesis","arguments":{` +
				`"statement":"the session woke up inside the boundary Code declared",` +
				`"novelty":0.5,"priority":0.5}}`)
		case ompFrameHostToolResult:
			emit(`{"type":"turn_end"}`)
			emit(`{"type":"agent_end","messages":[],"isTerminal":true}`)
			return 0
		}
	}
	return 0
}

func sandboxObserveGuest() sandboxGuestView {
	cwd, _ := os.Getwd()
	view := sandboxGuestView{
		Cwd:       cwd,
		Home:      os.Getenv("HOME"),
		Proxy:     os.Getenv("PI_PROXY"),
		BrokerURL: os.Getenv("OMP_AUTH_BROKER_URL"),
		PoolPath:  os.Getenv("OMP_AUTH_BROKER_ACCOUNT_POOL_FILE"),
		Routes:    sandboxRouteCount(),
		Root:      sandboxRootEntries(),
		Argv:      os.Args,
	}
	if _, err := os.ReadFile(view.PoolPath); err == nil {
		view.PoolReadable = true
	}
	if _, err := os.ReadFile(sandboxConfigPath); err == nil {
		view.ConfigReadable = true
	}
	for _, arg := range os.Args {
		if strings.Contains(arg, testProviderToken) {
			view.TokenOnArgv = true
		}
	}
	// The auth broker, reached over the relay socket: this is the request a
	// real session makes before it can call a model at all.
	if view.BrokerURL != "" {
		client := &http.Client{Timeout: 10 * time.Second}
		if response, err := client.Get(view.BrokerURL); err == nil {
			view.BrokerStatus = response.Status
			response.Body.Close()
		} else {
			view.BrokerStatus = "error: " + err.Error()
		}
	}
	// And a CONNECT the allowlist does not cover, through PI_PROXY, so the test
	// can see that the proxy the session is pointed at is the real one.
	if view.Proxy != "" {
		status, err := sandboxScenarioConnect(view.Proxy, "example.invalid:443")
		if err != nil {
			status = "error: " + err.Error()
		}
		view.RefusedStatus = status
	}
	return view
}
