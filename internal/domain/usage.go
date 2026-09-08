package domain

import (
	"encoding/json"
	"strings"
	"time"
 )

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
			UsedFraction *float64 `json:"usedFraction"`
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
			FetchedAt int64 `json:"fetchedAt"`
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
	// omp always emits a reports array, even when it has no usage. A nil
	// slice means the field was absent or null, not a successful observation.
	if len(out) == 0 || json.Unmarshal(out, &doc) != nil || doc.Reports == nil {
		return a
	}
	a.ok = true
	provSeen := map[string]bool{}
	now := observedAt
	if observedAt <= 0 { return emptyAvailability() }
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
		provider := providerByID(id.Provider)
		if provider == nil { return accountKey{}, false }
		if accountID != "" {
			for _, acct := range a.accounts[provider.ID] {
				if accountID == acct.IdentityKey { return accountKey{acct.Provider, acct.IdentityKey}, true }
			}
		}
		var matched accountKey
		count := 0
		for _, acct := range a.accounts[provider.ID] {
			if email != "" && acct.Email != "" && strings.EqualFold(email, acct.Email) {
				matched = accountKey{acct.Provider, acct.IdentityKey}
				count++
			}
		}
		return matched, count == 1
	}
	// Every report's windows, kept apart per report: the bucket verdict is a
	// question about accounts (is anyone left with headroom?), not about
	// windows, so it is folded once below by bucketVerdicts rather than
	// window by window here. Reports the snapshot cannot match to an account
	// still vote — they are real credentials omp will rotate through.
	var byReport [][]usageWin
	for _, r := range doc.Reports {
		reportObserved := observedAt
		if r.FetchedAt > 0 { reportObserved = r.FetchedAt / 1000 }
		provSeen[r.Provider] = true
		reportWins := make([]usageWin, 0, len(r.Limits))
		for _, l := range r.Limits {
			missing := l.Amount.UsedFraction == nil
			pct := 0
			if !missing {
				if *l.Amount.UsedFraction < 0 || *l.Amount.UsedFraction > 100 { return emptyAvailability() }
				pct = int(*l.Amount.UsedFraction*100 + 0.5)
			}
			// scope.windowId names the window this limit is scoped to;
			// window.id repeats it for payloads that omit the scope copy.
			winID := l.Scope.WindowID
			if winID == "" {
				winID = l.Window.ID
			}
			win := usageWin{label: l.Label, id: winID, pct: pct, tier: l.Scope.Tier,
				secs: l.Window.ResetsAt/1000 - now, dur: l.Window.DurationMs / 1000,
				prov: r.Provider, observed: reportObserved, missing: missing}
			reportWins = append(reportWins, win)
			a.wins = append(a.wins, win)
			// A tier no provider entry declares owns no bucket, so its window
			// takes part in no bucket accounting at all: it renders as its own
			// row and nothing more. bucketVerdicts applies the same skip, and
			// it is load-bearing — providers keep emitting tier-scoped limits
			// for carve-outs this build does not model, and folding an
			// unrecognised tier's usedFraction into the provider's MAIN bucket
			// would mark that provider maxed — stopping every route through it
			// — on the strength of a quota window nothing here understands.
			if bkt := bucketForProviderTier(r.Provider, l.Scope.Tier); bkt != "" {
				a.bucket[bkt] = "ok"
			}
		}
		byReport = append(byReport, reportWins)
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
	for bkt, secs := range bucketVerdicts(byReport) {
		a.bucket[bkt] = "maxed"
		a.reset[bkt] = secs
	}
	// omp's capacity block, when the payload carries one, is the authority on
	// a provider's MAIN bucket: it is omp's own cross-account aggregate, and
	// remainingAccounts > 0 means somebody still has headroom. It carries no
	// tier, so the tier-scoped buckets keep the per-account verdict; and the
	// per-account verdict already asks the same question, so a payload
	// without the block (omp 18.1 emits none) reaches the same answer.
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

// bucketVerdicts folds windows, grouped by the account that reported them,
// into the buckets that are out: bucket → seconds until it is usable again.
//
// An account is exhausted for a bucket when any of its windows drawing that
// bucket is at 100% — a maxed 5h blocks the account while its 7d still has
// room. The bucket is maxed only when every account reporting a window for it
// is exhausted: a sibling with headroom is exactly the account omp rotates to,
// so striking the provider on one account's 100% claims a model will not run
// when it will. The reset is the earliest moment any exhausted account frees
// up, which is when the bucket is usable again — not the longest window in
// sight. Missing placeholders are not observations and do not vote; an
// account with no window for a bucket has no say on it either way.
func bucketVerdicts(byAccount [][]usageWin) map[string]int64 {
	free := map[string]bool{}
	reset := map[string]int64{}
	for _, wins := range byAccount {
		exhausted := map[string]bool{}
		clears := map[string]int64{} // the account's last blocking window
		voted := map[string]bool{}
		for _, w := range wins {
			if w.missing {
				continue
			}
			bkt := bucketForProviderTier(w.prov, w.tier)
			if bkt == "" {
				continue
			}
			voted[bkt] = true
			if w.pct < 100 {
				continue
			}
			if !exhausted[bkt] || w.secs > clears[bkt] {
				clears[bkt] = w.secs
			}
			exhausted[bkt] = true
		}
		for bkt := range voted {
			if !exhausted[bkt] {
				free[bkt] = true
				continue
			}
			if cur, ok := reset[bkt]; !ok || clears[bkt] < cur {
				reset[bkt] = clears[bkt]
			}
		}
	}
	for bkt := range free {
		delete(reset, bkt)
	}
	return reset
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
	// The bucket verdict is per account, never per aggregate: the panel's
	// averaged group hides which account is out, and a window shape only one
	// account has (a 30d plan beside 7d ones) would be a group of one whose
	// 100% struck the whole provider while its siblings sat idle.
	byAccount := make([][]usageWin, 0, len(selected.accountUsage))
	for _, wins := range selected.accountUsage {
		byAccount = append(byAccount, wins)
	}
	for bucket, secs := range bucketVerdicts(byAccount) {
		selected.bucket[bucket] = "maxed"
		selected.reset[bucket] = secs
	}
	return selected
}

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
