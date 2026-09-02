package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"time"
)

func forwardArgv(path string, forwarded []string, prompt string) []string {
	out := append([]string{path}, stripProfileArgs(forwarded)...)
	if prompt != "" {
		out = append(out, prompt)
	}
	return out
}

func managedLaunchArgv(path string, forwarded []string, prompt string) []string {
	return forwardArgv(path, forwarded, prompt)
}

// untrustedLaunchArgv is the `u` key's launcher command line. It is the
// operator's own untrusted-session binary (ompu), not a containment mechanism:
// Code's sandbox is the one worker mode builds in sandbox.go, and naming two
// unrelated things "sandbox" is how the containment declaration came to say
// something Code did not do.
func untrustedLaunchArgv(path string, forwarded []string, prompt string) []string {
	return forwardArgv(path, forwarded, prompt)
}

// generatedLaunchArgv puts the generated overlay first, then the dials' own omp
// flags, then whatever the operator forwarded — so a forwarded flag still has
// the last word over a dial, the same precedence the overlay already gives
// --config.
func generatedLaunchArgv(path, cfgPath string, flags, forwarded []string, prompt string) []string {
	args := append([]string{"--config", cfgPath}, flags...)
	args = append(args, stripProfileArgs(forwarded)...)
	out := append([]string{path}, args...)
	if prompt != "" {
		out = append(out, prompt)
	}
	return out
}

func resolveLaunchPath(envName string, fallbacks []string) (string, error) {
	if configured := os.Getenv(envName); configured != "" {
		return exec.LookPath(configured)
	}
	var err error
	for _, fallback := range fallbacks {
		var path string
		if path, err = exec.LookPath(fallback); err == nil {
			return path, nil
		}
	}
	if err == nil {
		err = errors.New("no launcher configured")
	}
	return "", err
}

func runChild(path string, argv, env []string, dir string) error {
	cmd := exec.Command(path, argv[1:]...)
	cmd.Args = argv
	cmd.Env = env
	if dir != "" {
		cmd.Dir = dir
		cmd.Env = append(env, "PWD="+dir)
	}
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func childStatus(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() >= 0 {
		return exitErr.ExitCode()
	}
	return 1
}

// runUntrustedLauncher execs the launcher the operator designated for untrusted
// sessions, with the auth environment stripped. It contains nothing itself —
// whatever ompu is, is the operator's business — which is exactly why it is no
// longer called runSandbox.
func runUntrustedLauncher(envName string, fallbacks []string, prompt, dir string) int {
	path, err := resolveLaunchPath(envName, fallbacks)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: untrusted launcher not found:", err)
		return 1
	}
	err = runChild(path, untrustedLaunchArgv(path, os.Args[1:], prompt), withoutAuthEnv(os.Environ()), dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: untrusted launcher:", err)
	}
	return childStatus(err)
}

func runTrusted(session *sessionHandle, envName string, fallbacks []string,
	argv func(string, []string, string) []string, prompt string,
	broker brokerConfig, selections accountSelectionState, dir string) int {
	disabled := selections.CurrentDisabled()
	path, err := resolveLaunchPath(envName, fallbacks)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: trusted launcher not found:", err)
		return 1
	}
	if !broker.configured() {
		err = runChild(path, argv(path, os.Args[1:], prompt), withoutAuthEnv(os.Environ()), dir)
		if err != nil {
			fmt.Fprintln(os.Stderr, "code: trusted child:", err)
		}
		return childStatus(err)
	}
	accounts, err := loadAccounts(broker)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: account snapshot unavailable; refusing unrestricted launch:", err)
		return 1
	}
	now := time.Now()
	accountPoolPath, pool, warnings, cleanup, err := writeAccountPool(accounts, disabled, now)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: account pool unavailable; refusing unrestricted launch:", err)
		return 1
	}
	defer cleanup()
	for _, w := range warnings {
		switch w.Reason {
		case poolAllDisabled:
			fmt.Fprintf(os.Stderr, "code: every %s account is disabled; this session starts with no %s account\n", w.Provider, w.Provider)
		case poolAllBlocked:
			fmt.Fprintf(os.Stderr, "code: all enabled %s accounts are rate-limit blocked for %s\n", w.Provider, fmtReset(int64(w.Until.Sub(now)/time.Second)))
		}
	}
	// Bookkeeping never blocks a launch: the session is the product, the
	// record is not.
	_ = session.Update(func(r *sessionRecord) {
		r.Pool = pool
		r.PoolAt = time.Now().Unix()
	})
	childEnv := withAuthEnv(os.Environ(), broker, accountPoolPath)
	err = runChild(path, argv(path, os.Args[1:], prompt), childEnv, dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: trusted child:", err)
	}
	return childStatus(err)
}

// launchGenerated keeps both immutable launch inputs alive only for the child.
func launchGenerated(session *sessionHandle, cfg, prompt string, flags []string, broker brokerConfig, selections accountSelectionState, dir string) int {
	tmp, err := os.CreateTemp("", "code-gen-*.yml")
	if err != nil {
		fmt.Fprintln(os.Stderr, "code:", err)
		return 1
	}
	cfgPath := tmp.Name()
	defer os.Remove(cfgPath)
	if _, err = tmp.WriteString(cfg); err == nil {
		err = tmp.Close()
	} else {
		_ = tmp.Close()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: generated config:", err)
		return 1
	}
	return runTrusted(session, "CODE_OMP", []string{"omp"}, func(path string, forwarded []string, prompt string) []string {
		return generatedLaunchArgv(path, cfgPath, flags, forwarded, prompt)
	}, prompt, broker, selections, dir)
}
