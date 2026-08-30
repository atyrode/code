package main

import (
	"os"
	"testing"
)

// TestMain lets this test binary stand in for the two programs the sandbox
// tests need it to be.
//
// The containment backend bind-mounts Code's executable into the sandbox and
// re-enters it as `__sandbox`, because the two jobs that have to happen in
// there — forwarding loopback to the host's egress sockets, and probing the
// boundary from the inside — need a program that is already trusted and already
// present. Under `go test` that executable is this test binary, so without the
// first dispatch the probe would re-run the whole suite inside the sandbox and
// read its output as a report.
//
// The other two are stand-in OMPs. A contained session has no shell, so a fake
// OMP has to be a real executable rather than a script, and the only real
// executable a test can put inside the boundary is this one. Both are selected
// by environment rather than by argument, because the driver owns OMP's command
// line on purpose and a test that could inject an argument into it would be
// exercising a command line production never builds.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == sandboxHelperCommand {
		os.Exit(runSandboxHelper(os.Args[2:]))
	}
	if os.Getenv(sandboxFakeOmpEnv) != "" {
		os.Exit(runSandboxFakeOmp())
	}
	if scenario := os.Getenv(ompFakeScenarioEnv); scenario != "" {
		ompFakeMain(append([]string{scenario, os.Getenv(ompFakeRecordEnv)}, os.Args...))
		os.Exit(0)
	}
	os.Exit(m.Run())
}
