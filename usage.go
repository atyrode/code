package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/charmbracelet/lipgloss"
)

// ── usage + availability ─────────────────────────────────────────────────────
type usageWin struct {
	label string
	// id is the short window id straight from the payload — scope.windowId,
	// falling back to window.id. It is the authoritative name for the window:
	// omp adds and retires windows (Codex went from a 5h/7d pair to a single
	// 30d) and the panel has to follow the payload rather than a table of
	// English labels compiled into this binary. Empty only for payloads that
	// carry no window id at all, where shortWin falls back to the label
	// vocabulary.
	id       string
	pct      int
	tier     string
	secs     int64 // seconds until reset (relative)
	dur      int64 // window length in seconds
	prov     string
	stale    bool  // retained from the last successful fetch after a refresh omitted this window
	missing  bool  // never observed: rendered as a deterministic placeholder row
	observed int64 // Unix timestamp of the last real value; retained across cache fallback
}

// resetCredits tracks OpenAI reset credits: how many are currently available
// and the seconds until each available credit expires (relative, unsorted).
type resetCredits struct {
	avail int
	exp   []int64
}

// credFault is omp's own verdict on a credential it has taken out of service:
// the cause string it recorded and when. We never derive this — the broker owns
// the refresh, so it is the only thing that knows an OAuth grant expired. Before
// omp reported it, the panel could only notice that a report was *absent* and
// call the whole provider "unauthed", which is the same word for "you never
// logged in" and "your refresh token died last month".
type credFault struct {
	cause string
	at    int64 // ms; 0 when the payload omits it
}

// short is the cause reduced to one operator-facing phrase. omp's cause is a
// full error chain with key=value diagnostics and a stack trace — right for a
// log, useless in a dial row. When the body carries the provider's own error
// code, the head of the chain plus that code says everything the row needs:
// what failed, and the exact string to search for. Otherwise the first clause,
// minus the url=/status= noise.
func (f credFault) short() string {
	line := f.cause
	if i := strings.IndexAny(line, "\r\n"); i >= 0 {
		line = line[:i]
	}
	if i := strings.Index(line, ";"); i >= 0 {
		line = line[:i]
	}
	var kept []string
	for _, w := range strings.Fields(line) {
		if !strings.Contains(w, "=") {
			kept = append(kept, w)
		}
	}
	line = strings.Join(kept, " ")
	if code := jsonErrorCode(f.cause); code != "" {
		if i := strings.Index(line, ":"); i >= 0 {
			line = line[:i]
		}
		return line + " (" + code + ")"
	}
	return line
}

// jsonErrorCode pulls a provider's own machine-readable code out of an embedded
// JSON error body ("invalid_grant"), which is the part worth surfacing verbatim:
// it is what the operator will search for and what tells them whether a re-login
// fixes it.
func jsonErrorCode(cause string) string {
	i := strings.Index(cause, `"error":`)
	if i < 0 {
		return ""
	}
	rest := cause[i+len(`"error":`):]
	j := strings.Index(rest, `"`)
	if j < 0 {
		return ""
	}
	rest = rest[j+1:]
	k := strings.Index(rest, `"`)
	if k < 0 {
		return ""
	}
	return rest[:k]
}

type availability struct {
	bucket           map[string]string // bucket -> "ok" | "maxed" | "unauthed"
	reset            map[string]int64
	wins             []usageWin
	credits          resetCredits
	accountCredits   map[accountKey]resetCredits
	ok               bool
	accounts         map[string][]account
	accountUsage     map[accountKey][]usageWin
	accountsOK       bool
	selectionApplied bool
	accountsStale    bool
	// faults are the credentials omp has disabled and why (disabledCredentials
	// in the payload); silent are accounts omp knows about that reported no
	// usage at all (accountsWithoutUsage). Both replace guessing from absence.
	faults map[accountKey]credFault
	silent map[accountKey]bool
	// deepseek is the DeepSeek prepaid balance: nil when the snapshot carries
	// no DeepSeek credential (the group is hidden entirely — an absent API key
	// is the normal state, unlike a metered subscription).
	deepseek *deepseekBalance
}

func fetchBrokerUsage(broker brokerConfig) ([]byte, error) {
	if broker.URL == "" || broker.Token == "" {
		return nil, errors.New("central auth broker is not configured")
	}
	req, err := http.NewRequest(http.MethodGet, strings.TrimRight(broker.URL, "/")+"/v1/usage", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+broker.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil, fmt.Errorf("usage endpoint returned %s", resp.Status)
	}
	return io.ReadAll(resp.Body)
}

type usageCacheWin struct {
	Label    string `json:"label"`
	ID       string `json:"windowId,omitempty"`
	Pct      int    `json:"pct"`
	Tier     string `json:"tier,omitempty"`
	ResetsAt int64  `json:"resetsAt"`
	Dur      int64  `json:"dur"`
	Provider string `json:"provider"`
	Observed int64  `json:"observed"`
}

type usageCacheAccount struct {
	Provider    string          `json:"provider"`
	IdentityKey string          `json:"identityKey"`
	Wins        []usageCacheWin `json:"wins"`
}

type usageCacheFile struct {
	SavedAt  int64                `json:"savedAt"`
	Accounts map[string][]account `json:"accounts"`
	Deepseek *usageCacheBalance   `json:"deepseekBalance,omitempty"`
	Usage    []usageCacheAccount  `json:"usage"`
}

// usageCacheBalance caches the DeepSeek balance VALUE only — never the key.
type usageCacheBalance struct {
	Currency  string `json:"currency"`
	Total     string `json:"totalBalance"`
	FetchedAt int64  `json:"fetchedAt"`
}

func emptyAvailability() availability {
	return availability{
		bucket: map[string]string{}, reset: map[string]int64{},
		accounts: map[string][]account{}, accountUsage: map[accountKey][]usageWin{},
		accountCredits: map[accountKey]resetCredits{},
		faults:         map[accountKey]credFault{}, silent: map[accountKey]bool{},
	}
}

// parseAvailability associates broker usage with stable identities from the
// same snapshot. observedAt is the cache observation time; reset countdowns
// remain relative to now because the broker payload stores absolute deadlines.
func parseAvailability(accounts map[string][]account, accountsOK bool, out []byte, observedAt int64) availability {
	a := emptyAvailability()
	a.accounts, a.accountsOK = accounts, accountsOK
	type limit struct {
		Label string `json:"label"`
		Scope struct {
			Tier     string `json:"tier"`
			WindowID string `json:"windowId"`
		} `json:"scope"`
		Amount struct {
			UsedFraction float64 `json:"usedFraction"`
		} `json:"amount"`
		Window struct {
			ID         string `json:"id"`
			ResetsAt   int64  `json:"resetsAt"`
			DurationMs int64  `json:"durationMs"`
		} `json:"window"`
	}
	// identity is the shape every account-scoped block in the payload shares:
	// reports, disabledCredentials and accountsWithoutUsage all name an account
	// the same way, so they all match against a.accounts the same way.
	type identity struct {
		Provider  string `json:"provider"`
		Email     string `json:"email"`
		AccountID string `json:"accountId"`
		Metadata  struct {
			Email     string `json:"email"`
			AccountID string `json:"accountId"`
		} `json:"metadata"`
	}
	var doc struct {
		Reports []struct {
			identity
			Limits       []limit `json:"limits"`
			ResetCredits struct {
				AvailableCount int `json:"availableCount"`
				Credits        []struct {
					ExpiresAt string `json:"expiresAt"`
					Status    string `json:"status"`
				} `json:"credits"`
			} `json:"resetCredits"`
		} `json:"reports"`
		// omp 18 reports account health directly: which credentials it has
		// taken out of service and why, and which configured accounts produced
		// no usage report at all. Both were previously guessed from silence.
		DisabledCredentials []struct {
			identity
			Cause        string `json:"cause"`
			DisabledAtMs int64  `json:"disabledAtMs"`
		} `json:"disabledCredentials"`
		AccountsWithoutUsage []identity `json:"accountsWithoutUsage"`
		// capacity is omp's own cross-account aggregate per provider and window:
		// remainingAccounts is the share of that provider's accounts still with
		// headroom. It carries no tier dimension, so it speaks for the provider's
		// main bucket only — the tier-scoped buckets stay folded per report.
		Capacity map[string][]struct {
			Window            string  `json:"window"`
			Accounts          float64 `json:"accounts"`
			RemainingAccounts float64 `json:"remainingAccounts"`
		} `json:"capacity"`
	}
	if len(out) == 0 || json.Unmarshal(out, &doc) != nil {
		return a
	}
	a.ok = true
	provSeen := map[string]bool{}
	now := time.Now().Unix()
	if observedAt <= 0 {
		observedAt = now
	}
	// match resolves a payload identity to one of the accounts the snapshot
	// carries: email first, then the account id against the identity key. Every
	// account-scoped block in the payload names an account the same way, so they
	// all agree on what "the same account" is.
	match := func(id identity) (accountKey, bool) {
		email, accountID := id.Metadata.Email, id.Metadata.AccountID
		if email == "" {
			email = id.Email
		}
		if accountID == "" {
			accountID = id.AccountID
		}
		for _, acct := range a.accounts[id.Provider] {
			if (email != "" && acct.Email != "" && strings.EqualFold(email, acct.Email)) ||
				(accountID != "" && accountID == acct.IdentityKey) {
				return accountKey{Provider: acct.Provider, IdentityKey: acct.IdentityKey}, true
			}
		}
		return accountKey{}, false
	}
	for _, r := range doc.Reports {
		provSeen[r.Provider] = true
		reportWins := make([]usageWin, 0, len(r.Limits))
		for _, l := range r.Limits {
			pct := int(l.Amount.UsedFraction*100 + 0.5)
			// scope.windowId names the window this limit is scoped to;
			// window.id repeats it for payloads that omit the scope copy.
			winID := l.Scope.WindowID
			if winID == "" {
				winID = l.Window.ID
			}
			win := usageWin{label: l.Label, id: winID, pct: pct, tier: l.Scope.Tier,
				secs: l.Window.ResetsAt/1000 - now, dur: l.Window.DurationMs / 1000,
				prov: r.Provider, observed: observedAt}
			reportWins = append(reportWins, win)
			a.wins = append(a.wins, win)
			bkt := bucketForProviderTier(r.Provider, l.Scope.Tier)
			if bkt == "" {
				// A tier no provider entry declares owns no bucket, so this
				// window takes part in no bucket accounting at all: it renders
				// as its own row and nothing more. The skip is load-bearing —
				// providers keep emitting tier-scoped limits for carve-outs
				// this build does not model, and folding an unrecognised
				// tier's usedFraction into the provider's MAIN bucket would
				// mark that provider maxed — stopping every route through it —
				// on the strength of a quota window nothing here understands.
				continue
			}
			if pct >= 100 {
				a.bucket[bkt] = "maxed"
				a.reset[bkt] = l.Window.ResetsAt/1000 - now
			} else if a.bucket[bkt] != "maxed" {
				a.bucket[bkt] = "ok"
			}
		}
		matchedKey, matched := match(r.identity)
		if matched {
			a.accountUsage[matchedKey] = append(a.accountUsage[matchedKey], reportWins...)
		}
		if r.Provider == openAIProvider {
			credits := resetCredits{avail: r.ResetCredits.AvailableCount}
			for _, c := range r.ResetCredits.Credits {
				if c.Status != "available" {
					continue
				}
				if t, err := time.Parse(time.RFC3339, c.ExpiresAt); err == nil {
					credits.exp = append(credits.exp, t.Unix()-now)
				}
			}
			a.credits.avail += credits.avail
			a.credits.exp = append(a.credits.exp, credits.exp...)
			if matched {
				attributed := a.accountCredits[matchedKey]
				attributed.avail += credits.avail
				attributed.exp = append(attributed.exp, credits.exp...)
				a.accountCredits[matchedKey] = attributed
			}
		}
	}
	for _, d := range doc.DisabledCredentials {
		if key, ok := match(d.identity); ok {
			a.faults[key] = credFault{cause: d.Cause, at: d.DisabledAtMs}
		}
	}
	for _, s := range doc.AccountsWithoutUsage {
		if key, ok := match(s); ok {
			a.silent[key] = true
		}
	}
	// omp's capacity block is the authority on whether a provider's MAIN bucket
	// has run out, because it is aggregated across that provider's accounts:
	// remainingAccounts > 0 means somebody still has headroom. Folding per
	// report cannot see that — one account at 100% used to mark the bucket
	// maxed and strike every route through the provider while a sibling account
	// sat idle. capacity carries no tier, so the tier-scoped buckets keep their
	// per-report verdict; this speaks only for the main one.
	for prov, windows := range doc.Capacity {
		p := providerByID(prov)
		if p == nil || !p.Metered || len(windows) == 0 {
			continue
		}
		exhausted := false
		for _, w := range windows {
			if w.Accounts > 0 && w.RemainingAccounts <= 0 {
				exhausted = true
			}
		}
		main := p.mainBucket()
		if exhausted {
			a.bucket[main] = "maxed"
		} else if a.bucket[main] == "maxed" {
			a.bucket[main] = "ok"
			delete(a.reset, main)
		}
	}
	// The remaining absence rule: a metered provider omp reported nothing for is
	// unauthed. That is still an inference, but it is now the *only* one left —
	// a credential omp disabled carries its own cause in a.faults, and an
	// account that simply reported nothing is in a.silent, so the panel no
	// longer has to spell both as "unauthed" and hope.
	for _, prov := range providerRegistry {
		if !prov.Metered {
			continue
		}
		for _, b := range prov.buckets() {
			if !provSeen[prov.ID] {
				a.bucket[b] = "unauthed"
			} else if _, ok := a.bucket[b]; !ok {
				a.bucket[b] = "ok"
			}
		}
	}
	return a
}

// loadAvailability reads one central snapshot and one aggregate usage report,
// plus — when the snapshot carries a DeepSeek api_key — the upstream prepaid
// balance, fetched concurrently so neither request delays the other.
func loadAvailability(broker brokerConfig) availability {
	accounts, err := loadAccounts(broker)
	accountsOK := err == nil
	if !accountsOK {
		accounts = map[string][]account{}
	}
	var ds *deepseekBalance
	var wg sync.WaitGroup
	if key := deepseekAPIKey(accounts); key != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			bal, err := fetchDeepSeekBalance(key)
			if err != nil {
				// Degrade to an explicit "unavailable" row; other providers
				// are unaffected.
				bal = deepseekBalance{fetchedAt: time.Now().Unix()}
			}
			ds = &bal
		}()
	}
	out, err := fetchBrokerUsage(broker)
	if err != nil {
		out = nil
	}
	wg.Wait()
	a := parseAvailability(accounts, accountsOK, out, 0)
	a.deepseek = ds
	return a
}

func loadUsageCache(path string) availability {
	a := emptyAvailability()
	if path == "" {
		return a
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return a
	}
	var cached usageCacheFile
	if json.Unmarshal(body, &cached) != nil || cached.SavedAt <= 0 || len(cached.Usage) == 0 {
		return a
	}
	a.accounts, a.accountsOK, a.ok = cached.Accounts, true, true
	provSeen := map[string]bool{}
	for _, entry := range cached.Usage {
		key := accountKey{Provider: entry.Provider, IdentityKey: entry.IdentityKey}
		for _, cachedWin := range entry.Wins {
			win := usageWin{
				label: cachedWin.Label, id: cachedWin.ID, pct: cachedWin.Pct, tier: cachedWin.Tier,
				secs: cachedWin.ResetsAt - time.Now().Unix(), dur: cachedWin.Dur, prov: cachedWin.Provider,
				observed: cachedWin.Observed, stale: true,
			}
			a.accountUsage[key] = append(a.accountUsage[key], win)
			a.wins = append(a.wins, win)
			provSeen[win.prov] = true
			bucket := bucketForProviderTier(win.prov, win.tier)
			if bucket == "" {
				continue
			}
			if win.pct >= 100 {
				a.bucket[bucket], a.reset[bucket] = "maxed", win.secs
			} else if a.bucket[bucket] != "maxed" {
				a.bucket[bucket] = "ok"
			}
		}
	}
	if cached.Deepseek != nil {
		a.deepseek = &deepseekBalance{
			ok: true, currency: cached.Deepseek.Currency, total: cached.Deepseek.Total,
			fetchedAt: cached.Deepseek.FetchedAt, stale: true,
		}
	}
	for _, prov := range providerRegistry {
		if !prov.Metered {
			continue
		}
		for _, bucket := range prov.buckets() {
			if !provSeen[prov.ID] {
				a.bucket[bucket] = "unauthed"
			} else if _, ok := a.bucket[bucket]; !ok {
				a.bucket[bucket] = "ok"
			}
		}
	}
	return a
}

func saveUsageCache(path string, a availability) {
	if path == "" || !a.ok {
		return
	}
	now := time.Now().Unix()
	cached := usageCacheFile{SavedAt: now, Accounts: a.accounts}
	if a.deepseek != nil && a.deepseek.ok {
		cached.Deepseek = &usageCacheBalance{
			Currency: a.deepseek.currency, Total: a.deepseek.total, FetchedAt: a.deepseek.fetchedAt,
		}
	}
	for key, wins := range a.accountUsage {
		entry := usageCacheAccount{Provider: key.Provider, IdentityKey: key.IdentityKey}
		for _, win := range wins {
			if win.missing {
				continue
			}
			observed := win.observed
			if observed <= 0 {
				observed = now
			}
			entry.Wins = append(entry.Wins, usageCacheWin{
				Label: win.label, ID: win.id, Pct: win.pct, Tier: win.tier,
				ResetsAt: observed + win.secs, Dur: win.dur,
				Provider: win.prov, Observed: observed,
			})
		}
		if len(entry.Wins) > 0 {
			cached.Usage = append(cached.Usage, entry)
		}
	}
	if len(cached.Usage) == 0 {
		return
	}
	sort.Slice(cached.Usage, func(i, j int) bool {
		if cached.Usage[i].Provider != cached.Usage[j].Provider {
			return cached.Usage[i].Provider < cached.Usage[j].Provider
		}
		return cached.Usage[i].IdentityKey < cached.Usage[j].IdentityKey
	})
	body, err := json.Marshal(cached)
	if err != nil {
		return
	}
	body = append(body, '\n')
	_ = atomicPrivateWrite(path, body)
}

// bucketForProviderTier maps a usage report's (provider, tier) scope onto the
// quota bucket it constrains: the provider's main window, or a special tier's
// dedicated window. Unmetered and unknown providers own no buckets.
func bucketForProviderTier(prov, tier string) string {
	p := providerByID(prov)
	if p == nil || !p.Metered {
		return ""
	}
	if tier == "" || tier == "-" {
		return p.mainBucket()
	}
	for _, s := range p.Special {
		if s.Bucket == tier {
			return p.BucketBase + "-" + s.Bucket
		}
	}
	return ""
}

func (a availability) down(bucket string) bool {
	return a.bucket[bucket] == "maxed" || a.bucket[bucket] == "unauthed"
}

// reconcileUsage folds a freshly fetched availability over the one currently
// shown, so a flaky upstream never wipes known-good data. It returns the
// availability to display plus whether the whole panel is stale:
//
//   - a total fetch failure after any prior success keeps the previous
//     availability wholesale and reports it stale — the control row shows a
//     refresh-failed warning instead of dropping to the unauthenticated error;
//   - a successful payload that omits an account's usage retains that
//     account's last observed rows, visibly marked stale with their age.
//
// Nothing else is retained, and nothing at all is fabricated. The panel shows
// exactly the windows the payload reports: it never invents a row that is
// missing, and never suppresses one it does not recognise. This seam used to
// carry a provider-specific reservation — one quota window was flaky enough
// that its row was retained across omissions, and synthesised as an
// "unavailable" placeholder when it had never been seen, so a late-appearing
// datum could not pop the panel geometry. That reservation outlived the window
// itself: after the provider retired the window, the panel kept promising a
// row that would never come back. Window vocabulary belongs to the payload,
// which is what makes a provider adding or retiring a window a non-event here.
func reconcileUsage(prev, next availability) (availability, bool) {
	if !next.ok {
		if prev.ok {
			return prev, true
		}
		return next, false
	}
	if !next.accountsOK && prev.accountsOK {
		// Identities are borrowed from the last good snapshot, so the account
		// health keyed to them has to come along: parseAvailability could match
		// no fault without an account list, and dropping them would quietly
		// re-hide a disabled credential the moment identity lookup flaked.
		next.accounts, next.accountsOK, next.accountsStale = prev.accounts, true, true
		if len(next.faults) == 0 {
			next.faults = prev.faults
		}
		if len(next.silent) == 0 {
			next.silent = prev.silent
		}
	}
	next.accountUsage = reconcileAccountUsage(prev.accountUsage, next.accountUsage, next.accounts)
	if next.deepseek != nil && !next.deepseek.ok && prev.deepseek != nil && prev.deepseek.ok {
		// A failed balance refresh keeps the last known value, visibly stale —
		// same retention contract as the metered windows.
		retained := *prev.deepseek
		retained.stale = true
		next.deepseek = &retained
	}
	return next, false
}

func reconcileAccountUsage(prev, next map[accountKey][]usageWin, accounts map[string][]account) map[accountKey][]usageWin {
	if next == nil {
		next = map[accountKey][]usageWin{}
	}
	active := map[accountKey]bool{}
	for _, providerAccounts := range accounts {
		for _, acct := range providerAccounts {
			active[accountKey{Provider: acct.Provider, IdentityKey: acct.IdentityKey}] = true
		}
	}
	if len(active) == 0 {
		for key := range next {
			active[key] = true
		}
	}
	for key := range active {
		wins := next[key]
		hasFresh := false
		for _, w := range wins {
			if !w.missing {
				hasFresh = true
				break
			}
		}
		if hasFresh {
			continue
		}
		retained := make([]usageWin, 0, len(prev[key]))
		for _, w := range prev[key] {
			if w.missing {
				continue
			}
			w.stale = true
			retained = append(retained, w)
		}
		if len(retained) > 0 {
			next[key] = retained
		}
	}
	return next
}

type usageGroupKey struct {
	prov  string
	tier  string
	dur   int64
	label string
}

type usageGroup struct {
	win      usageWin
	count    int64
	pctSum   int64
	secsSum  int64
	observed int64
}

// knownUsageWindow gates which reported windows the panel is willing to draw.
// The old rule was a duration whitelist — 5h or 7d, optionally suffixed by a
// declared special tier — so it silently dropped every window it had not been
// taught: Codex now reports a single 30d window, and that row disappeared from
// the panel entirely instead of being rendered and gated on its real usage.
//
// The rule is payload-driven instead: a window is renderable when this build
// knows the metered provider that owns the quota (an unmetered or unregistered
// provider has no window to draw) and the window names itself — its own id, or,
// for id-less payloads, a label the fallback vocabulary recognises. Whether the
// window's tier maps onto a live bucket is a separate, catalog-level question
// the panel asks later (see model.liveUsageWindow); this gate is payload-level
// and deliberately has no catalog in reach.
func knownUsageWindow(w usageWin) bool {
	p := providerByID(w.prov)
	if p == nil || !p.Metered {
		return false
	}
	if w.id != "" {
		return true
	}
	_, ok := shortWinLabel(w.label)
	return ok
}

// selectedAvailability derives account-sensitive usage and routing availability
// solely from enabled broker identities. Unmatched reports never enter this seam.
func selectedAvailability(a availability, disabled map[accountKey]bool) availability {
	selected := a
	selected.selectionApplied = true
	selected.accounts = map[string][]account{}
	selected.accountUsage = map[accountKey][]usageWin{}
	selected.accountCredits = map[accountKey]resetCredits{}
	selected.bucket = map[string]string{}
	selected.reset = map[string]int64{}
	selected.wins = nil
	selected.credits = resetCredits{}

	enabledProviders := map[string]bool{}
	groups := map[usageGroupKey]*usageGroup{}
	missing := map[usageGroupKey]usageWin{}
	var groupOrder []usageGroupKey
	for prov, accounts := range a.accounts {
		for _, acct := range accounts {
			key := accountKey{Provider: acct.Provider, IdentityKey: acct.IdentityKey}
			if selectionDisabled(disabled, acct) {
				continue
			}
			selected.accounts[prov] = append(selected.accounts[prov], acct)
			enabledProviders[acct.Provider] = true
			wins := a.accountUsage[key]
			if credits, ok := a.accountCredits[key]; ok {
				selected.accountCredits[key] = credits
				selected.credits.avail += credits.avail
				selected.credits.exp = append(selected.credits.exp, credits.exp...)
			}
			for _, win := range wins {
				if win.prov != acct.Provider || !knownUsageWindow(win) {
					continue
				}
				selected.accountUsage[key] = append(selected.accountUsage[key], win)
				groupKey := usageGroupKey{prov: win.prov, tier: win.tier, dur: win.dur, label: shortWin(win)}
				if win.missing {
					if _, ok := missing[groupKey]; !ok {
						placeholder := win
						placeholder.label = groupKey.label
						missing[groupKey] = placeholder
						groupOrder = append(groupOrder, groupKey)
					}
					continue
				}
				group := groups[groupKey]
				if group == nil {
					aggregate := win
					aggregate.label = groupKey.label
					group = &usageGroup{win: aggregate}
					groups[groupKey] = group
					groupOrder = append(groupOrder, groupKey)
				}
				pct, secs := int64(win.pct), win.secs
				if pct < 0 {
					pct = 0
				}
				if secs < 0 {
					secs = 0
				}
				group.count++
				group.pctSum += pct
				group.secsSum += secs
				group.win.stale = group.win.stale || win.stale
				if win.observed > 0 && (group.observed == 0 || win.observed < group.observed) {
					group.observed = win.observed
				}
			}
		}
	}
	seen := map[usageGroupKey]bool{}
	for _, key := range groupOrder {
		if seen[key] {
			continue
		}
		seen[key] = true
		if group := groups[key]; group != nil {
			group.win.pct = int((group.pctSum + group.count/2) / group.count)
			group.win.secs = (group.secsSum + group.count/2) / group.count
			group.win.observed = group.observed
			selected.wins = append(selected.wins, group.win)
		} else {
			selected.wins = append(selected.wins, missing[key])
		}
	}
	for _, prov := range providerRegistry {
		if !prov.Metered {
			continue
		}
		for _, bucket := range prov.buckets() {
			if enabledProviders[prov.ID] {
				selected.bucket[bucket] = "ok"
			} else {
				selected.bucket[bucket] = "unauthed"
			}
		}
	}
	for _, win := range selected.wins {
		bucket := bucketForProviderTier(win.prov, win.tier)
		if bucket == "" || win.missing || win.pct < 100 {
			continue
		}
		selected.bucket[bucket] = "maxed"
		// Multiple quota windows can constrain one route. The route becomes
		// usable only after the last maxed aggregate resets, so retain the
		// longest selected reset rather than whichever account/map came last.
		if win.secs > selected.reset[bucket] {
			selected.reset[bucket] = win.secs
		}
	}
	return selected
}

const usageBarNaturalW = 10

func barStr(p, width int) string {
	if width < 0 {
		width = 0
	}
	var r, g float64
	if p <= 50 {
		r, g = 90+float64(p)*3, 200
	} else {
		r, g = 235, 200-float64(p-50)*3
	}
	if r > 235 {
		r = 235
	}
	if g < 60 {
		g = 60
	}
	fill := (p*width + 50) / 100
	if fill > width {
		fill = width
	}
	if fill < 0 {
		fill = 0
	}
	filled := lipgloss.NewStyle().Foreground(lipgloss.Color(fmt.Sprintf("#%02x%02x46", clampByte(r), clampByte(g)))).Render(strings.Repeat("█", fill))
	return filled + stDim.Render(strings.Repeat("░", width-fill))
}

func fmtReset(s int64) string {
	if s < 0 {
		s = 0
	}
	switch {
	case s >= 86400:
		return fmt.Sprintf("%dd%dh", s/86400, (s%86400)/3600)
	case s >= 3600:
		return fmt.Sprintf("%dh%dm", s/3600, (s%3600)/60)
	}
	return fmt.Sprintf("%dm", s/60)
}

// shortWin is a window's display tag. The payload's own window id is
// authoritative — "5h", "7d", "30d" — with the limit's tier appended when the
// window is tier-scoped ("5h spark"), because an id alone cannot tell a
// provider's main window apart from a tier carve-out of the same duration.
//
// The label switch in shortWinLabel is ONLY a fallback for payloads that carry
// no window id at all, and it must never grow: a hardcoded table of English
// labels is exactly how Codex's single "30 days" window came to render as the
// raw payload string and be gated out as unknown.
func shortWin(w usageWin) string {
	if w.id != "" {
		if w.tier != "" && w.tier != "-" {
			return w.id + " " + w.tier
		}
		return w.id
	}
	tag, _ := shortWinLabel(w.label)
	return tag
}

// shortWinLabel resolves the legacy English window labels, reporting whether
// the label was one this build recognises. Windows that carry an id never
// reach it.
func shortWinLabel(l string) (string, bool) {
	switch l {
	case "5 hours", "Claude 5 Hour", "Codex 5 Hour", "OpenAI 5 Hour":
		return "5h", true
	case "7 days", "Claude 7 Day", "Codex 7 Day", "OpenAI 7 Day":
		return "7d", true
	case "5 hours (Spark)", "Codex 5 Hour (Spark)", "OpenAI 5 Hour (Spark)":
		return "5h spark", true
	case "7 days (Spark)", "Codex 7 Day (Spark)", "OpenAI 7 Day (Spark)":
		return "7d spark", true
	}
	return l, false
}

// usageCtrlLine is the Usage chrome's bottom action row: central refresh state,
// account-manager access, and any account persistence error.
func (m *model) usageCtrlLine() string {
	var parts []string
	if m.broker.URL != "" {
		switch {
		case !m.avail.ok && (m.fetching || m.nextRefresh.IsZero()):
			parts = append(parts, stDim.Render(m.spin.View()+" fetching usage…"))
		case m.fetching:
			parts = append(parts, stWarn.Render(gReset+" refreshing…"))
		case m.usageStale:
			// A failed refresh kept the previous data on screen: the warning
			// takes the countdown's slot (same row, similar width) so the
			// measured panel geometry — and with it the medium/collapsed
			// breakpoint — barely moves on a flaky refresh.
			parts = append(parts, stWarn.Render("refresh failed · stale")+
				stDim.Render(" · ")+stKey.Render("r")+stDim.Render(" retry"))
		default:
			rem := time.Until(m.nextRefresh)
			if rem < 0 {
				rem = 0
			}
			s := int(rem.Seconds())
			parts = append(parts,
				stDim.Render(fmt.Sprintf("next refresh %d:%02d · ", s/60, s%60))+
					stKey.Render("r")+stDim.Render(" now"))
		}
	}
	identityAction := "full ids"
	if m.fullUsageIDs {
		identityAction = "short ids"
	}
	parts = append(parts, stKey.Render("i")+stDim.Render(" "+identityAction))
	parts = append(parts, stKey.Render("v")+stDim.Render(" accounts"))
	if len(parts) == 0 {
		return ""
	}
	line := "  " + strings.Join(parts, stDim.Render("  ·  "))
	if m.accountErr != "" {
		line += "\n" + stBrk.Render("  account update failed: "+m.accountErr)
	}
	return line
}

// compactDisplayIdentity produces a deliberately lossy display label. Email
// matching continues to use the untouched broker identity; this helper is only
// for the compact Usage heading.
func compactDisplayIdentity(identity string) string {
	normalized := strings.ToLower(strings.TrimSpace(identity))
	at := strings.IndexByte(normalized, '@')
	if at > 0 && at == strings.LastIndexByte(normalized, '@') {
		local, domain := normalized[:at], normalized[at+1:]
		dot := strings.LastIndexByte(domain, '.')
		valid := dot > 0 && dot < len(domain)-1 &&
			!strings.HasPrefix(local, ".") && !strings.HasSuffix(local, ".") &&
			!strings.Contains(local, "..") && !strings.Contains(domain, "..") &&
			strings.IndexFunc(normalized, func(r rune) bool {
				return unicode.IsSpace(r) || unicode.IsControl(r)
			}) < 0
		if valid {
			localRunes := []rune(local)
			if len(localRunes) > 2 {
				localRunes = localRunes[:2]
			}
			return string(localRunes) + "*"
		}
	}
	if normalized == "" {
		return "id unavailable"
	}
	runes := []rune(normalized)
	if len(runes) > 2 {
		runes = runes[:2]
	}
	return string(runes) + "*"
}

func usageDisplayIdentity(identity string, full bool) string {
	if full {
		if identity = strings.TrimSpace(identity); identity != "" {
			return identity
		}
		return "id unavailable"
	}
	return compactDisplayIdentity(identity)
}

type compactProviderIdentity struct {
	label     string
	reporting bool
	// fault is omp's own reason this credential is out of service, shortened for
	// a row. Empty is not the same as healthy: an account can report nothing
	// without having been disabled, which is what silent covers.
	fault  string
	silent bool
	// blocks are pre-rendered broker rate-limit labels ("blocked 2d12h",
	// "chat blocked 6d2h"), scope-aware so a meter- or tier-scoped block never
	// reads as taking the whole provider out of service.
	blocks []string
}

// providerIdentities preserves broker snapshot order and collapses repeated
// copies of the same stable account. Compact ambiguity is intentional; pressing
// i reveals full addresses when disambiguation matters.
func providerIdentities(a availability, prov string, full bool) []compactProviderIdentity {
	accounts := a.accounts[prov]
	identities := make([]compactProviderIdentity, 0, len(accounts))
	seenAccounts := map[string]bool{}
	for _, acct := range accounts {
		stableID := acct.IdentityKey
		if stableID == "" {
			stableID = acct.Email
		}
		if stableID != "" {
			stableID = acct.Provider + "\x00" + stableID
			if seenAccounts[stableID] {
				continue
			}
			seenAccounts[stableID] = true
		}

		identity := acct.Email
		if identity == "" {
			identity = acct.IdentityKey
		}
		label := usageDisplayIdentity(identity, full)

		reporting := false
		for _, win := range a.accountUsage[accountKey{Provider: acct.Provider, IdentityKey: acct.IdentityKey}] {
			if !win.missing {
				reporting = true
				break
			}
		}
		key := accountKey{Provider: acct.Provider, IdentityKey: acct.IdentityKey}
		entry := compactProviderIdentity{label: label, reporting: reporting, silent: a.silent[key]}
		if f, ok := a.faults[key]; ok {
			entry.fault = f.short()
		}
		entry.blocks = acct.blockLabels(timeNow())
		identities = append(identities, entry)
	}
	return identities
}

// providerHeading keeps the provider's established color and puts compact,
// enabled snapshot identities in a dim parenthetical suffix.
func providerHeading(prov string, identities []compactProviderIdentity) string {
	col, name := "#8a93a6", prov
	if p := providerByID(prov); p != nil {
		col, name = p.Color, p.Label
	}
	heading := lipgloss.NewStyle().Foreground(lipgloss.Color(col)).Bold(true).Render(name)
	if len(identities) == 0 {
		return heading
	}
	labels := make([]string, 0, len(identities))
	for _, identity := range identities {
		labels = append(labels, identity.label)
	}
	return heading + " " + stDim.Render("("+strings.Join(labels, " + ")+")")
}

// providerIdentityBlockFor keeps missing usage explicit without spending a
// separate row on accounts already represented by aggregate usage bars.
func providerIdentityBlockFor(a availability, prov string, checking, full bool) []string {
	identities := providerIdentities(a, prov, full)
	if checking && len(identities) == 0 {
		identities = []compactProviderIdentity{{label: "checking account…"}}
	}
	rows := []string{padLeft(providerHeading(prov, identities), gut)}
	if checking {
		return rows
	}
	if !a.accountsOK {
		return append(rows, stWarn.Render("  account status unavailable"))
	}
	if len(identities) == 0 {
		if a.selectionApplied {
			return append(rows, stDim.Render("  no enabled accounts"))
		}
		return append(rows, stBrk.Render("  not authenticated"))
	}
	// A credential omp disabled gets its own row naming omp's cause: it is
	// actionable ("re-login"), where "usage unavailable" is not. The remaining
	// non-reporting accounts collapse into the old aggregate line, because
	// silence with no cause behind it is all we can honestly say about them.
	unavailable := 0
	for _, identity := range identities {
		switch {
		case identity.fault != "":
			rows = append(rows, stBrk.Render("  "+identity.label+": ")+
				stWarn.Render(identity.fault)+stDim.Render(" · disabled by omp"))
		case !identity.reporting:
			unavailable++
		}
		if len(identity.blocks) > 0 {
			rows = append(rows, stBrk.Render("  "+identity.label+": ")+stWarn.Render(strings.Join(identity.blocks, ", ")))
		}
	}
	if unavailable > 0 {
		status := "  usage unavailable"
		if len(identities) > 1 {
			noun := "account"
			if unavailable > 1 {
				noun = "accounts"
			}
			status += fmt.Sprintf(" for %d %s", unavailable, noun)
		}
		rows = append(rows, stWarn.Render(status))
	}
	if a.accountsStale {
		rows = append(rows, stWarn.Render("  identity cached"))
	}
	return rows
}

func providerIdentityBlock(a availability, prov string, checking bool) []string {
	return providerIdentityBlockFor(a, prov, checking, false)
}

// identityLines keeps provider and broker-reported account state visible even
// when no usage rows exist.
func identityLinesFor(a availability) string {
	var lines []string
	for i, prov := range meteredProviderIDs() {
		if i > 0 {
			lines = append(lines, "")
		}
		lines = append(lines, providerIdentityBlock(a, prov, false)...)
	}
	return strings.Join(lines, "\n")
}

func (m *model) selectedLaunchAvailability() availability {
	return selectedAvailability(m.avail, m.accountSelections.CurrentDisabled())
}

func (m *model) selectedUsageAvailability() availability {
	disabled := m.accountSelections.CurrentDisabled()
	if m.manager {
		disabled = m.managerDisplayedDisabled()
	}
	return m.withLiveWindows(selectedAvailability(m.avail, disabled))
}

// liveUsageWindow reports whether a tier-scoped quota window still has anything
// in this catalog drawing from it. A tier-scoped window is a provider's
// dedicated lead bucket, and it is only worth a row while some model actually
// spends it: a provider that retires one keeps reporting it — empty, "ok",
// forever — and a permanently-0% row is noise no operator can act on. Tier-less
// windows are the account's ordinary quota and always render.
//
// Registry- and catalog-driven, never a name list: the tier must resolve to a
// bucket some provider declares (see specialFacet) and some catalog model must
// draw from that bucket. Either half missing means nothing routes there. A
// catalog-less run (onboarding, a broken CODE_GENERATED) knows neither, so it
// keeps every window rather than emptying the panel.
func (m *model) liveUsageWindow(w usageWin) bool {
	if w.tier == "" || w.tier == "-" || len(m.facts) == 0 {
		return true
	}
	bucket := bucketForProviderTier(w.prov, w.tier)
	if bucket == "" {
		return false
	}
	for _, f := range m.facts {
		if f.bucket == bucket {
			return true
		}
	}
	return false
}

// withLiveWindows is the panel's copy of a selection with retired tier-scoped
// windows dropped. Only the panel filters: routing reads buckets to strike
// rungs, and a bucket no model declares strikes nothing, so the launch seam is
// unaffected either way and this stays a display rule.
func (m *model) withLiveWindows(a availability) availability {
	out := a
	out.wins = nil
	for _, win := range a.wins {
		if m.liveUsageWindow(win) {
			out.wins = append(out.wins, win)
		}
	}
	out.accountUsage = make(map[accountKey][]usageWin, len(a.accountUsage))
	for key, wins := range a.accountUsage {
		var kept []usageWin
		for _, win := range wins {
			if m.liveUsageWindow(win) {
				kept = append(kept, win)
			}
		}
		out.accountUsage[key] = kept
	}
	return out
}

func (m *model) identityLines() string {
	return identityLinesFor(m.selectedUsageAvailability())
}

// usagePanel is the composition-agnostic Usage band sized for the current
// terminal width — the wide layout's full-width footer form.
func (m *model) usagePanel() string { return m.usagePanelFor(m.w) }

// usagePanelFor renders central account usage with local visibility and account
// manager cues. There is no selectable vault or profile identity.
func (m *model) usagePanelFor(w int) string {
	return m.usagePanelLayout(w, false)
}

func (m *model) usagePanelStackedFor(w int) string {
	return m.usagePanelLayout(w, true)
}

func (m *model) usagePanelLayout(w int, stacked bool) string {
	title := m.pill("usage")
	title += "  " + stCueKey.Render("s") + stCue.Render(" · hide")
	innerWidth := max(0, w-gut)
	out := padLeft(title, gut) + "\n" +
		"\n" + m.usageBodyLayout(innerWidth, stacked)
	if ctrl := m.usageCtrlLine(); ctrl != "" && !m.manager {
		out += "\n\n" + ctrl // blank row: air between provider content and the control row
	}
	return out
}

// usageRenderGroup keeps provider chrome and usage rows separate until layout
// has assigned the provider its real display width. That is the composition seam
// which lets both stacked and side-by-side layouts grow bars without changing
// headings, notes, or the canonical row grammar.
type usageRenderGroup struct {
	prefix []string
	rows   []usageRowSpec
	suffix []string
}

func (g usageRenderGroup) linesWithUsageLayout(barWidth, noteWidth, prefixHeight int) []string {
	lines := make([]string, 0, max(len(g.prefix), prefixHeight)+len(g.rows)+len(g.suffix))
	lines = append(lines, g.prefix...)
	for len(lines) < prefixHeight {
		lines = append(lines, "")
	}
	for _, row := range g.rows {
		lines = append(lines, row.render(barWidth, noteWidth))
	}
	lines = append(lines, g.suffix...)
	return lines
}

func usageRenderWidth(lines []string) int {
	width := 0
	for _, line := range lines {
		if lineWidth := lipgloss.Width(line); lineWidth > width {
			width = lineWidth
		}
	}
	return width
}

// usageBodyFor renders the provider/account content between the pinned title
// and the bottom control row: the identity-headed usage groups, or the
// loading/unavailable identity block.
func (m *model) usageBodyFor(w int) string {
	return m.usageBodyLayout(w, false)
}

func (m *model) usageBodyLayout(w int, stacked bool) string {
	a := m.selectedUsageAvailability()
	if !a.ok {
		if m.usageLoading() {
			return m.skeletonBodyLayout(w, stacked)
		}
		out := identityLinesFor(a)
		if m.broker.URL != "" && !m.fetching && !m.nextRefresh.IsZero() {
			out += "\n" + stWarn.Render("  usage unavailable · press v to manage accounts")
		}
		return out
	}
	if len(a.wins) == 0 {
		return identityLinesFor(a) + "\n" +
			stWarn.Render("  no enabled provider usage · press v to manage accounts")
	}
	wins := append([]usageWin(nil), a.wins...)
	provOrder := func(p string) int {
		for i := range providerRegistry {
			if providerRegistry[i].ID == p {
				return i
			}
		}
		return len(providerRegistry)
	}
	tierOrder := func(t string) int {
		if t == "" || t == "-" {
			return 0
		}
		return 1
	}
	sort.SliceStable(wins, func(i, j int) bool {
		if o := provOrder(wins[i].prov) - provOrder(wins[j].prov); o != 0 {
			return o < 0
		}
		if o := tierOrder(wins[i].tier) - tierOrder(wins[j].tier); o != 0 {
			return o < 0
		}
		return wins[i].dur < wins[j].dur
	})
	blocks := map[string]usageRenderGroup{}
	var order []string
	for _, prov := range meteredProviderIDs() {
		if len(a.accounts[prov]) > 0 {
			order = append(order, prov)
			blocks[prov] = usageRenderGroup{prefix: providerIdentityBlockFor(a, prov, false, m.fullUsageIDs)}
		}
	}
	for _, win := range wins {
		block, ok := blocks[win.prov]
		if !ok {
			order = append(order, win.prov)
			block.prefix = providerIdentityBlockFor(a, win.prov, false, m.fullUsageIDs)
		}
		block.rows = append(block.rows, m.usageRowSpec(win, "  "))
		blocks[win.prov] = block
	}
	if block, ok := blocks[openAIProvider]; ok {
		for _, acct := range a.accounts[openAIProvider] {
			key := accountKey{Provider: acct.Provider, IdentityKey: acct.IdentityKey}
			identity := usageDisplayIdentity(managerAccountLabel(acct), m.fullUsageIDs)
			if cl := creditLineForAccount(identity, a.accountCredits[key]); cl != "" {
				block.suffix = append(block.suffix, cl)
			}
		}
		blocks[openAIProvider] = block
	}
	if a.deepseek != nil {
		order = append(order, deepseekProvider)
		blocks[deepseekProvider] = usageRenderGroup{
			prefix: []string{padLeft(providerHeading(deepseekProvider, nil), gut)},
			suffix: []string{m.deepseekBalanceRow(*a.deepseek)},
		}
	}
	return layoutGroups(w, order, blocks, stacked)
}

// usageColFloorW is the minimum natural width of one provider column: a single
// canonical usage row carrying the widest window tag the registry declares.
// Measuring against a content-independent floor is what keeps the side-by-side
// decision from flipping between the pre-fetch skeleton and the first real
// payload. The tag is read from the declared skeleton windows instead of being
// written here as a literal, because window vocabulary belongs to the provider:
// this line used to hard-code the tag of a quota window that has since been
// retired, so the floor was reserving cells for a row that can never appear.
func usageColFloorW() int {
	widest := ""
	for _, wins := range skeletonWinsByProvider {
		for _, label := range wins {
			if lipgloss.Width(label) > lipgloss.Width(widest) {
				widest = label
			}
		}
	}
	return lipgloss.Width(skeletonRow(widest)) + 2
}

// layoutGroups assigns provider columns before rendering any usage row.
// Side-by-side groups share the whole panel width; stacked groups each receive
// the whole section width. A zero width is the non-recursive measurement path
// and therefore retains natural ten-cell bars.
func layoutGroups(w int, order []string, blocks map[string]usageRenderGroup, stacked bool) string {
	allRows := make([]usageRowSpec, 0)
	for _, prov := range order {
		allRows = append(allRows, blocks[prov].rows...)
	}
	naturalBarWidth, noteWidth := usageRowsLayout(0, allRows)
	naturalColW := usageColFloorW()
	for _, prov := range order {
		blockW := usageRenderWidth(blocks[prov].linesWithUsageLayout(naturalBarWidth, noteWidth, 0)) + 2
		if blockW > naturalColW {
			naturalColW = blockW
		}
	}
	sideBySide := !stacked && w > 0 && len(order) > 1 && w >= naturalColW*len(order)
	layoutWidth := w
	if sideBySide {
		for i := range order {
			colW := w*(i+1)/len(order) - w*i/len(order)
			if i == 0 || colW < layoutWidth {
				layoutWidth = colW
			}
		}
	}
	barWidth, noteWidth := usageRowsLayout(layoutWidth, allRows)
	if sideBySide {
		prefixHeight := 0
		for _, prov := range order {
			if len(blocks[prov].prefix) > prefixHeight {
				prefixHeight = len(blocks[prov].prefix)
			}
		}
		cols := make([]string, 0, len(order))
		for i, prov := range order {
			colW := w*(i+1)/len(order) - w*i/len(order)
			content := strings.Join(blocks[prov].linesWithUsageLayout(barWidth, noteWidth, prefixHeight), "\n")
			cols = append(cols, lipgloss.NewStyle().Width(colW).Render(content))
		}
		return lipgloss.JoinHorizontal(lipgloss.Top, cols...)
	}
	var lines []string
	for i, prov := range order {
		if i > 0 {
			lines = append(lines, "")
		}
		lines = append(lines, blocks[prov].linesWithUsageLayout(barWidth, noteWidth, 0)...)
	}
	return strings.Join(lines, "\n")
}

// usageLoading reports the initial central fetch window where the layout-stable
// skeleton replaces the not-yet-known account and usage rows.
func (m *model) usageLoading() bool {
	return m.broker.URL != "" && !m.avail.ok && (m.fetching || m.nextRefresh.IsZero())
}

// skeletonWinsByProvider mirrors each provider's declared usage shape, so the
// pre-fetch skeleton reserves about the rows the first real payload will fill.
// It is a layout hint only: the rendered panel follows the payload, so a
// provider reporting a different set of windows than it declares just changes
// shape once, on the first successful fetch.
var skeletonWinsByProvider = func() map[string][]string {
	wins := map[string][]string{}
	for _, p := range providerRegistry {
		if p.Metered {
			wins[p.ID] = p.SkeletonWins
		}
	}
	return wins
}()

// usageRowSpec is the unrendered canonical Usage-row grammar. Every caller
// supplies its indentation and group width, while this one seam reserves the
// label, percentage, reset, and actual note before assigning all safe cells to
// the bar.
type usageRowSpec struct {
	indent      string
	label       string
	barPct      int
	percentage  string
	reset       string
	note        string
	reserveNote string
}

func usageRowsNoteWidth(rows []usageRowSpec) int {
	width := 0
	for _, row := range rows {
		for _, note := range []string{row.note, row.reserveNote} {
			if noteWidth := lipgloss.Width(note); noteWidth > width {
				width = noteWidth
			}
		}
	}
	return width
}

const usageResetValueWidth = 6

func paddedUsageReset(reset string) string {
	width := lipgloss.Width(gReset) + 1 + usageResetValueWidth
	return reset + strings.Repeat(" ", max(0, width-lipgloss.Width(reset)))
}

func (r usageRowSpec) render(barWidth, noteWidth int) string {
	note := ""
	if r.note != "" {
		note = "  " + r.note + strings.Repeat(" ", max(0, noteWidth-lipgloss.Width(r.note)))
	} else if noteWidth > 0 {
		note = strings.Repeat(" ", 2+noteWidth)
	}
	return fmt.Sprintf("%s%-9s %s %s used  %s%s",
		r.indent, r.label, barStr(r.barPct, barWidth), r.percentage, paddedUsageReset(r.reset), note)
}

func (r usageRowSpec) reservedWidth(noteWidth int) int {
	return lipgloss.Width(r.render(0, noteWidth))
}

func usageRowsLayout(width int, rows []usageRowSpec) (barWidth, noteWidth int) {
	noteWidth = usageRowsNoteWidth(rows)
	if width == 0 {
		return usageBarNaturalW, noteWidth
	}
	reserved := 0
	for _, row := range rows {
		if rowW := row.reservedWidth(noteWidth); rowW > reserved {
			reserved = rowW
		}
	}
	return max(0, width-reserved), noteWidth
}

func usageRowsBarWidth(width int, rows []usageRowSpec) int {
	barWidth, _ := usageRowsLayout(width, rows)
	return barWidth
}

func renderUsageRows(width int, rows []usageRowSpec) []string {
	barWidth, noteWidth := usageRowsLayout(width, rows)
	rendered := make([]string, len(rows))
	for i, row := range rows {
		rendered[i] = row.render(barWidth, noteWidth)
	}
	return rendered
}

func skeletonUsageRowSpec(label, indent string) usageRowSpec {
	return usageRowSpec{
		indent: indent, label: label,
		percentage:  stDim.Render(" ··%"),
		reset:       stDim.Render(gReset + " ····"),
		reserveNote: "unavailable",
	}
}

// skeletonRow is the natural-width placeholder row used by measurement and
// focused tests. Real layout goes through renderUsageRows with its group width.
func skeletonRow(label string) string {
	return renderUsageRows(0, []usageRowSpec{skeletonUsageRowSpec(label, "  ")})[0]
}

// skeletonBody is the pre-first-fetch Usage content: provider headings,
// explicit checking state, and generic placeholder window rows, laid out by
// the same group logic as real data so the first result lands predictably.
func (m *model) skeletonBody(w int) string {
	return m.skeletonBodyLayout(w, false)
}

func (m *model) skeletonBodyLayout(w int, stacked bool) string {
	a := m.selectedUsageAvailability()
	order := meteredProviderIDs()
	blocks := map[string]usageRenderGroup{}
	for _, prov := range order {
		block := usageRenderGroup{prefix: providerIdentityBlockFor(a, prov, true, m.fullUsageIDs)}
		for _, label := range skeletonWinsByProvider[prov] {
			block.rows = append(block.rows, skeletonUsageRowSpec(label, "  "))
		}
		blocks[prov] = block
	}
	return layoutGroups(w, order, blocks, stacked)
}

// usageColumn is the medium layout's left-hand Usage section: the panel with
// provider groups forced into a vertical stack — the column is deliberately
// too narrow for side-by-side groups. The panel carries its own title chrome.
func (m model) usageColumn() string {
	return m.usagePanelStackedFor(0)
}

// usageColW is the medium usage column's measured width: the widest rendered
// line of the stacked panel (title, controls, bars, notes) — measured, not guessed.
func (m model) usageColW() int {
	return lipgloss.Width(m.usageColumn())
}

// secondaryMinH is the medium secondary row's minimum height: routing's pinned
// chrome plus a few useful route rows, or the full stacked usage column when
// that is taller — medium only engages when neither column needs clipping.
func (m model) secondaryMinH() int {
	h := prevChromeRows + minRouteRows
	if m.hideUsage {
		return h
	}
	if u := lipgloss.Height(m.usageColumn()); u > h {
		h = u
	}
	return h
}

func formatCachedAge(observed int64, now time.Time) string {
	seconds := now.Unix() - observed
	if seconds < 0 {
		seconds = 0
	}
	switch {
	case seconds < 60:
		return "<1m ago"
	case seconds < 60*60:
		return fmt.Sprintf("%dm ago", seconds/60)
	case seconds < 24*60*60:
		return fmt.Sprintf("%dh ago", seconds/(60*60))
	case seconds < 7*24*60*60:
		return fmt.Sprintf("%dd ago", seconds/(24*60*60))
	case seconds < 365*24*60*60:
		return fmt.Sprintf("%dw ago", seconds/(7*24*60*60))
	default:
		return fmt.Sprintf("%dy ago", seconds/(365*24*60*60))
	}
}

// deepseekBalanceRow renders the DeepSeek group's single body row: the prepaid
// balance — no bar, no window, no reset countdown, because none exist. A
// balance under the suggestion floor carries an explicit "low" cue (the same
// threshold that stops proposals from spending the pool), and the off-peak
// discount window is surfaced while it is live.
func (m *model) deepseekBalanceRow(b deepseekBalance) string {
	if !b.ok {
		return "  " + stWarn.Render("balance unavailable")
	}
	row := "  balance  " + stHead.Render("$"+b.total+" "+b.currency) + stDim.Render(" · pay-as-you-go")
	if v, err := strconv.ParseFloat(b.total, 64); err == nil && v < deepseekLowBalanceUSD {
		row += "  " + stWarn.Render("low")
	}
	if mult := poolOffPeak(poolOf(deepseekProvider), offPeakNow().UTC()); mult < 1 {
		pct := strconv.Itoa(int((1-mult)*100 + 0.5))
		row += "  " + stDim.Render("off-peak −"+pct+"%")
	}
	if b.stale {
		cached := "cached"
		if b.fetchedAt > 0 {
			cached += " " + formatCachedAge(b.fetchedAt, time.Now())
		}
		row += "  " + stWarn.Render(cached)
	}
	return row
}
func (m *model) usageRowSpec(w usageWin, indent string) usageRowSpec {
	if w.missing {
		// Never-observed windows keep the exact row grammar with dotted values;
		// only the status text differs from the loading skeleton.
		row := skeletonUsageRowSpec(shortWin(w), indent)
		row.note = stDim.Render("unavailable")
		return row
	}
	note := ""
	if w.pct >= 80 {
		note = stWarn.Render("tight")
	}
	if w.pct >= 100 {
		note = stBrk.Render("maxed")
	}
	if w.tier == "spark" && w.pct == 0 {
		note = lipgloss.NewStyle().Foreground(lipgloss.Color(cGreen)).Render("idle")
	}
	if w.stale {
		// Retained after a refresh omitted this window; show its age explicitly.
		cached := "cached"
		if w.observed > 0 {
			cached += " " + formatCachedAge(w.observed, time.Now())
		}
		if note != "" {
			note += "  "
		}
		note += stWarn.Render(cached)
	}
	resetText := gReset + " " + pad(fmtReset(w.secs), 4)
	reset := stDim.Render(resetText)
	if w.dur > 0 && w.secs*10 < w.dur {
		reset = lipgloss.NewStyle().Foreground(lipgloss.Color("#c8d0dc")).Bold(true).Render(resetText)
	} else if w.dur > 0 && w.secs*4 < w.dur {
		reset = lipgloss.NewStyle().Foreground(lipgloss.Color("#c8d0dc")).Render(resetText)
	}
	// During the one-time first-load fill only the bar is scaled toward its
	// target; the label, percentage, reset, and note are real from frame one.
	barPct := w.pct
	if m.barAnim > 0 {
		barPct = barPct * m.barAnim / barAnimSteps
	}
	return usageRowSpec{
		indent: indent, label: shortWin(w), barPct: barPct,
		percentage: fmt.Sprintf("%3d%%", w.pct), reset: reset, note: note,
	}
}

// usageRow is the natural-width measurement/test path. Composed panels and
// manager account groups render the same spec through renderUsageRows using
// their actual assigned width.
func (m *model) usageRow(w usageWin) string {
	return renderUsageRows(0, []usageRowSpec{m.usageRowSpec(w, "  ")})[0]
}

// Reset-credit expiry urgency tints: each individual expiry (`3d`, `12d`, …)
// in the credit line is colored on a muted red→amber→green ramp so soon
// expiries read as warnings and distant ones as headroom, while the icon,
// count, and connecting prose stay dim. The palette is precomputed and
// deliberately desaturated (no per-frame color math, no saturated alarm
// colors inside a dim summary row); the day text itself stays sufficient
// without color. Thresholds are whole days remaining, exactly as fmtDays
// rounds them (up, so later-today = 1): ≤ creditUrgentDays is muted red,
// ≤ creditSoonDays muted amber, anything later muted green.
const (
	creditUrgentDays = 3  // expiring within three days — spend it or lose it
	creditSoonDays   = 10 // within ten days — plan around it
)

var (
	stCreditUrgent = lipgloss.NewStyle().Foreground(lipgloss.Color("#b0716f")) // muted red
	stCreditSoon   = lipgloss.NewStyle().Foreground(lipgloss.Color("#b39c6b")) // muted amber
	stCreditSafe   = lipgloss.NewStyle().Foreground(lipgloss.Color("#85a883")) // muted green
)

// creditDayStyle picks the urgency tint for a credit expiring in s seconds,
// bucketing on the same rounded-up whole days fmtDays renders — the color and
// the text can never disagree about which side of a threshold an expiry is on.
func creditDayStyle(s int64) lipgloss.Style {
	d := int64(0)
	if s > 0 {
		d = (s + 86399) / 86400
	}
	switch {
	case d <= creditUrgentDays:
		return stCreditUrgent
	case d <= creditSoonDays:
		return stCreditSoon
	default:
		return stCreditSafe
	}
}

// creditSummary renders the OpenAI reset-credit summary: the available count
// and the days remaining until the three soonest credit expirations, ascending.
// Callers own indentation and any account identity prefix.
func creditSummary(c resetCredits) string {
	if c.avail == 0 && len(c.exp) == 0 {
		return ""
	}
	exp := append([]int64(nil), c.exp...)
	sort.Slice(exp, func(i, j int) bool { return exp[i] < exp[j] })
	if len(exp) > 3 {
		exp = exp[:3]
	}
	noun := "resets"
	if c.avail == 1 {
		noun = "reset"
	}
	line := stDim.Render(gReset + " " + fmt.Sprintf("%d %s", c.avail, noun))
	if len(exp) > 0 {
		days := make([]string, len(exp))
		for i, s := range exp {
			days[i] = creditDayStyle(s).Render(fmtDays(s))
		}
		line += stDim.Render(" · expiring in ") + strings.Join(days, stDim.Render(", "))
	}
	return line
}

func creditLineFor(c resetCredits) string {
	if summary := creditSummary(c); summary != "" {
		return "  " + summary
	}
	return ""
}

func creditLineForAccount(identity string, c resetCredits) string {
	if summary := creditSummary(c); summary != "" {
		return "  " + stDim.Render(identity+" · ") + summary
	}
	return ""
}

func (m *model) creditLine() string {
	return creditLineFor(m.selectedUsageAvailability().credits)
}

// fmtDays renders a relative duration as whole days remaining, rounding up so
// a credit expiring later today still reads 1d.
func fmtDays(s int64) string {
	if s <= 0 {
		return "0d"
	}
	return fmt.Sprintf("%dd", (s+86399)/86400)
}

// syncPreview re-renders the routing content and jumps back to the top — for
// content changes (facet cycling, depth, reset), where the old scroll offset
// points at rows that no longer exist.
