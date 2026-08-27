package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
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

func sandboxLaunchArgv(path string, forwarded []string, prompt string) []string {
	return forwardArgv(path, forwarded, prompt)
}

func generatedLaunchArgv(path, cfgPath string, forwarded []string, prompt string) []string {
	args := append([]string{"--config", cfgPath}, stripProfileArgs(forwarded)...)
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

func runSandbox(envName string, fallbacks []string, prompt, dir string) int {
	path, err := resolveLaunchPath(envName, fallbacks)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: sandbox not found:", err)
		return 1
	}
	err = runChild(path, sandboxLaunchArgv(path, os.Args[1:], prompt), withoutAuthEnv(os.Environ()), dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: sandbox:", err)
	}
	return childStatus(err)
}

func runTrusted(envName string, fallbacks []string,
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
	accountPoolPath, cleanup, err := writeAccountPool(accounts, disabled)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: account pool unavailable; refusing unrestricted launch:", err)
		return 1
	}
	defer cleanup()
	childEnv := withAuthEnv(os.Environ(), broker, accountPoolPath)
	err = runChild(path, argv(path, os.Args[1:], prompt), childEnv, dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: trusted child:", err)
	}
	return childStatus(err)
}

// launchGenerated keeps both immutable launch inputs alive only for the child.
func launchGenerated(cfg, prompt string, broker brokerConfig, selections accountSelectionState, dir string) int {
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
	return runTrusted("CODE_OMP", []string{"omp"}, func(path string, forwarded []string, prompt string) []string {
		return generatedLaunchArgv(path, cfgPath, forwarded, prompt)
	}, prompt, broker, selections, dir)
}
