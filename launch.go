package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// launchTierMain names a provider's ordinary tier: the main quota bucket,
// which only a provider-wide block (or, on Codex, the "chat" meter block)
// takes out of service.
const launchTierMain = "main"

// launchRetryKey is the account manager's retry action (#88): the remediation
// a stale-block warning names. It lives here so the warning text and the
// manager's help row cannot drift apart.
const launchRetryKey = "x"

// launchIntent is what a launch asks of the accounts beyond which ones are
// enabled: the tier each provider is being asked to serve, and the usage the
// operator last saw for each account. Either may be absent — a managed launch
// has no catalog to name a tier, and a launch may have fetched no usage — and
// absence means the main tier and no contradiction check, never a guess.
type launchIntent struct {
	tiers map[string]string         // provider id → requested tier; missing = main
	usage map[accountKey][]usageWin // per-account windows as the usage panel holds them
}

func (in launchIntent) tier(provider string) string {
	if t := in.tiers[provider]; t != "" {
		return t
	}
	return launchTierMain
}

// launchIntent derives what this selection asks of the accounts: the default
// agent's lead is the model the operator is launching, so its bucket names the
// tier for its provider, and every other provider is asked for its main tier.
// A side role on a special tier (spark on smol) has its own dial warning; it
// is not what "the requested model" means to the operator reading a launch
// line. The usage is whatever the panel holds, stale rows included — the
// report is what decides a stale row cannot contradict anything.
func (m model) launchIntent() launchIntent {
	in := launchIntent{tiers: map[string]string{}, usage: m.avail.accountUsage}
	for _, r := range m.currentRows() {
		f := strings.Fields(strings.ReplaceAll(r, "→", " "))
		i := 0
		if len(f) > 0 && f[0] == "●" {
			i = 1
		}
		if i >= len(f) || f[i] != "default" {
			continue
		}
		for _, tok := range f[i+1:] {
			if !modelRe.MatchString(tok) {
				continue
			}
			id, _, _ := strings.Cut(tok, ":")
			p := providerByPool(m.poolOfModel(id))
			if p == nil {
				break
			}
			tier := launchTierMain
			if bucket := m.facts[id].bucket; strings.HasPrefix(bucket, p.BucketBase+"-") {
				tier = strings.TrimPrefix(bucket, p.BucketBase+"-")
			}
			in.tiers[p.ID] = tier
			break
		}
		break
	}
	return in
}

// blockCoversTier reports whether a broker block of the given scope keeps an
// account off the requested tier. The scope vocabulary is omp's: "" is
// provider-wide; Anthropic scopes its scarce tiers as "tier:<name>"; Codex
// scopes its meters bare ("spark", and "chat" for everything that is not
// spark, which is to say its main tier) plus "shared" for both.
func blockCoversTier(scope, tier string) bool {
	switch scope {
	case "", "shared":
		return true
	case "chat":
		return tier == launchTierMain
	}
	return scope == tier || scope == "tier:"+tier
}

// windowCoversTier reports whether a usage window meters the requested tier:
// tier-less windows are the main quota, tiered ones name theirs.
func windowCoversTier(w usageWin, tier string) bool {
	if w.tier == "" || w.tier == "-" {
		return tier == launchTierMain
	}
	return w.tier == tier
}

// launchIdentity is one enabled account as the launch sees it: written to the
// pool (or left to omp's own enumeration when the provider is unrestricted),
// and either eligible for the requested tier or blocked until a moment.
type launchIdentity struct {
	account
	// BlockScope and BlockedUntil describe the block keeping this identity
	// off the requested tier: "" for provider-wide, else the scoped block.
	// A provider-wide block wins over a scoped one, because it says more.
	// BlockedUntil is zero when the identity is eligible.
	BlockScope   string
	BlockedUntil time.Time
	// Contradiction: fresh usage reports headroom on the requested tier while
	// the block above still stands — the broker remembering a reset the
	// provider has already granted (#86). Clearing it is the operator's call
	// (launchRetryKey), never launch's.
	Contradiction bool
}

func (id launchIdentity) eligible() bool { return id.BlockedUntil.IsZero() }

// launchProvider is one metered provider's share of the launch: the tier it
// is asked for, whether the pool file names it, and the enabled identities.
type launchProvider struct {
	Provider string
	Tier     string
	// Restricted: the operator disabled at least one snapshot account, so the
	// pool file carries this provider's key. Unrestricted providers are left
	// out of the file on purpose (a missing key is omp's "use everything").
	Restricted bool
	// AllDisabled: every snapshot account is off; the file carries an empty
	// array and the session starts with no account for this provider.
	AllDisabled bool
	Identities  []launchIdentity
}

// identityKeys is exactly what the pool file lists for the provider.
func (p launchProvider) identityKeys() []string {
	keys := make([]string, 0, len(p.Identities))
	for _, id := range p.Identities {
		keys = append(keys, id.IdentityKey)
	}
	return keys
}

// blockedUntil is the earliest moment any enabled identity becomes eligible
// for the tier again, and whether every one of them is blocked now. Only the
// all-blocked case is a launch warning: one eligible sibling is exactly the
// account omp rotates to (#91).
func (p launchProvider) blockedUntil() (time.Time, bool) {
	var earliest time.Time
	for _, id := range p.Identities {
		if id.eligible() {
			return time.Time{}, false
		}
		if earliest.IsZero() || id.BlockedUntil.Before(earliest) {
			earliest = id.BlockedUntil
		}
	}
	return earliest, len(p.Identities) > 0
}

// providerWideBlocked reports whether the all-blocked verdict rests on at
// least one provider-wide block; when it does not, only the tier is out and
// the warning must say so rather than call the provider blocked.
func (p launchProvider) providerWideBlocked() bool {
	for _, id := range p.Identities {
		if !id.eligible() && id.BlockScope == "" {
			return true
		}
	}
	return false
}

// launchReport is the launch's account verdict, in registry order: what the
// pool file will say and why each identity is or is not usable for the model
// being launched. The pool writer, the launch-time warnings and the account
// manager all read this one value, so they cannot disagree.
type launchReport struct {
	Providers []launchProvider
}

// launchAccountReport judges the enabled accounts against the launch. Only
// metered (OAuth) providers take part: api_key providers have no identity
// keys and no pool routing. Blocked accounts stay in the pool — a block can
// expire mid-session, and removing them would freeze that decision for the
// session's whole life — so the report says which are blocked instead.
func launchAccountReport(accounts map[string][]account, disabled map[accountKey]bool, intent launchIntent, now time.Time) launchReport {
	var report launchReport
	for _, p := range providerRegistry {
		if !p.Metered {
			continue
		}
		prov := launchProvider{Provider: p.ID, Tier: intent.tier(p.ID)}
		snapshot := 0
		for _, acct := range accounts[p.ID] {
			if acct.Provider != p.ID || acct.IdentityKey == "" {
				continue
			}
			snapshot++
			if selectionDisabled(disabled, acct) {
				continue
			}
			prov.Identities = append(prov.Identities, judgeIdentity(acct, prov.Tier, intent.usage[accountKey{Provider: p.ID, IdentityKey: acct.IdentityKey}], now))
		}
		if snapshot == 0 {
			// No snapshot accounts at all: a missing key is the safe,
			// unrestricted state, and there is nothing to report on.
			continue
		}
		sort.Slice(prov.Identities, func(i, j int) bool { return prov.Identities[i].IdentityKey < prov.Identities[j].IdentityKey })
		prov.Restricted = len(prov.Identities) < snapshot
		prov.AllDisabled = len(prov.Identities) == 0
		report.Providers = append(report.Providers, prov)
	}
	return report
}

// judgeIdentity finds the block keeping one account off the tier, preferring
// a provider-wide block over a scoped one and the latest expiry within a
// scope, then checks it against fresh usage. A window retained from an
// earlier fetch or never observed cannot contradict anything; only a fresh
// reading with headroom on the very tier the block names does.
func judgeIdentity(acct account, tier string, wins []usageWin, now time.Time) launchIdentity {
	id := launchIdentity{account: acct}
	for _, b := range acct.blocks {
		if !b.Until.After(now) || !blockCoversTier(b.Scope, tier) {
			continue
		}
		switch {
		case id.BlockedUntil.IsZero(),
			b.Scope == "" && id.BlockScope != "",
			(b.Scope == "") == (id.BlockScope == "") && b.Until.After(id.BlockedUntil):
			id.BlockScope, id.BlockedUntil = b.Scope, b.Until
		}
	}
	if id.eligible() {
		return id
	}
	fresh := false
	for _, w := range wins {
		if w.stale || w.missing || !windowCoversTier(w, tier) {
			continue
		}
		if w.pct >= 100 {
			return id
		}
		fresh = true
	}
	id.Contradiction = fresh
	return id
}

// pool is the document written to OMP_AUTH_BROKER_ACCOUNT_POOL_FILE. Per
// omp's contract a missing provider key is unrestricted and an empty array
// hides every OAuth credential for that provider, so a key appears only for
// a provider the operator actually restricted.
func (r launchReport) pool() map[string][]string {
	pool := make(map[string][]string, len(r.Providers))
	for _, p := range r.Providers {
		if p.Restricted {
			pool[p.Provider] = p.identityKeys()
		}
	}
	return pool
}

// tierLabel is the tier as the operator knows it: "Fable", "Spark".
func tierLabel(tier string) string {
	if tier == "" {
		return ""
	}
	return strings.ToUpper(tier[:1]) + tier[1:]
}

func launchProviderLabel(provider string) string {
	if p := providerByID(provider); p != nil {
		return p.AccountLabel
	}
	return provider
}

func launchUntil(until, now time.Time) string {
	return fmtReset(int64(until.Sub(now)/time.Second)) + " (until " + until.Local().Format("Jan 2 15:04") + ")"
}

// poolLines states the effective pool, one line per provider that has
// accounts: the exact identities the launch hands omp, each blocked one
// marked with what blocks it. The first line says what a pool is, because
// the manager's on/off toggles read too easily as picking one account.
func (r launchReport) poolLines(now time.Time) []string {
	if len(r.Providers) == 0 {
		return nil
	}
	lines := []string{"Enabled accounts form a pool omp rotates through; disabling one leaves every other enabled account in play."}
	for _, p := range r.Providers {
		line := launchProviderLabel(p.Provider) + " pool"
		if !p.Restricted {
			line += " (every account, no restriction written)"
		}
		line += ": "
		if p.AllDisabled {
			lines = append(lines, line+"none — every account is disabled")
			continue
		}
		parts := make([]string, 0, len(p.Identities))
		for _, id := range p.Identities {
			part := id.IdentityKey
			if id.Email != "" && id.Email != id.IdentityKey {
				part += " <" + id.Email + ">"
			}
			if !id.eligible() {
				scope := "blocked"
				if id.BlockScope != "" {
					scope = id.BlockScope + " blocked"
				}
				part += " [" + scope + " " + fmtReset(int64(id.BlockedUntil.Sub(now)/time.Second)) + "]"
			}
			parts = append(parts, part)
		}
		lines = append(lines, line+strings.Join(parts, ", "))
	}
	return lines
}

// warnings are the launch-time sentences the operator must read before the
// child starts: a provider with no account, a provider or a tier every
// enabled account is blocked on, and any block fresh usage contradicts. A
// tier warning names the tier and says the provider is not blocked; the
// provider-wide sentence is reserved for provider-wide blocks.
func (r launchReport) warnings(now time.Time) []string {
	var out []string
	for _, p := range r.Providers {
		label := launchProviderLabel(p.Provider)
		if p.AllDisabled {
			out = append(out, fmt.Sprintf("every %s account is disabled; this session starts with no %s account", label, label))
			continue
		}
		if until, all := p.blockedUntil(); all {
			switch {
			case p.providerWideBlocked():
				out = append(out, fmt.Sprintf("every enabled %s account (%s) is rate-limit blocked for %s",
					label, strings.Join(p.identityKeys(), ", "), launchUntil(until, now)))
			default:
				out = append(out, fmt.Sprintf("%s is rate-limit blocked on every enabled %s account (%s) for %s; %s itself is not blocked, other %s models stay available",
					tierLabel(p.Tier), label, strings.Join(p.identityKeys(), ", "), launchUntil(until, now), label, label))
			}
		}
		for _, id := range p.Identities {
			if !id.Contradiction {
				continue
			}
			what := label
			if p.Tier != launchTierMain {
				what = tierLabel(p.Tier)
			}
			out = append(out, fmt.Sprintf("%s %s: fresh usage shows %s headroom while the broker still holds a %s block until %s — stale broker state, not exhaustion; press %s (retry now) on the account in the manager to clear it",
				label, id.IdentityKey, what, blockScopeLabel(id.BlockScope), launchUntil(id.BlockedUntil, now), launchRetryKey))
		}
	}
	return out
}

func blockScopeLabel(scope string) string {
	if scope == "" {
		return "provider-wide"
	}
	return scope
}

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
// Code's sandbox is the one the engine builds in sandbox.go, and naming two
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
func runUntrustedLauncher(envName string, fallbacks []string, prompt, dir string, forwarded []string) int {
	path, err := resolveLaunchPath(envName, fallbacks)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: untrusted launcher not found:", err)
		return 1
	}
	err = runChild(path, untrustedLaunchArgv(path, forwarded, prompt), withoutAuthEnv(os.Environ()), dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: untrusted launcher:", err)
	}
	return childStatus(err)
}

func runTrusted(session *sessionHandle, envName string, fallbacks []string,
	argv func(string, []string, string) []string, prompt string,
	broker brokerConfig, selections accountSelectionState, intent launchIntent, dir string, forwarded []string) int {
	disabled := selections.CurrentDisabled()
	path, err := resolveLaunchPath(envName, fallbacks)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: trusted launcher not found:", err)
		return 1
	}
	if !broker.configured() {
		if selections.strictLaunch {
			fmt.Fprintln(os.Stderr, "code: account selection requires an available broker")
			return 1
		}
		err = runChild(path, argv(path, forwarded, prompt), withoutAuthEnv(os.Environ()), dir)
		if err != nil {
			fmt.Fprintln(os.Stderr, "code: trusted child:", err)
		}
		return childStatus(err)
	}
	accounts, err := loadAccounts(broker)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: account snapshot unavailable; refusing unrestricted launch")
		return 1
	}
	if selections.strictLaunch {
		for key := range disabled {
			if _, err := resolveAccountAPIReference(accounts, key.Provider, key.IdentityKey); err != nil {
				fmt.Fprintln(os.Stderr, "code: account selection is no longer available")
				return 1
			}
		}
	}
	now := time.Now()
	report := launchAccountReport(accounts, disabled, intent, now)
	pool := report.pool()
	accountPoolPath, cleanup, err := writeAccountPool(pool)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: account pool unavailable; refusing unrestricted launch:", err)
		return 1
	}
	defer cleanup()
	for _, line := range report.poolLines(now) {
		fmt.Fprintln(os.Stderr, "code:", line)
	}
	for _, line := range report.warnings(now) {
		fmt.Fprintln(os.Stderr, "code:", line)
	}
	// Bookkeeping never blocks a launch: the session is the product, the
	// record is not.
	_ = session.Update(func(r *sessionRecord) {
		r.Pool = pool
		r.PoolAt = time.Now().Unix()
	})
	childEnv := withAuthEnv(os.Environ(), broker, accountPoolPath)
	err = runChild(path, argv(path, forwarded, prompt), childEnv, dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "code: trusted child:", err)
	}
	return childStatus(err)
}

// launchGenerated keeps both immutable launch inputs alive only for the child.
func launchGenerated(session *sessionHandle, cfg, prompt string, flags []string, broker brokerConfig, selections accountSelectionState, intent launchIntent, dir string, forwarded []string) int {
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
	}, prompt, broker, selections, intent, dir, forwarded)
}
