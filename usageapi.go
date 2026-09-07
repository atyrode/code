package main

import (
	"os"
	"sort"
	"time"
)

type usageAPIWindow struct {
	WindowID        string `json:"windowId"`
	Label           string `json:"label"`
	Tier            string `json:"tier,omitempty"`
	UsedPercent     int    `json:"usedPercent"`
	ResetsAt        int64  `json:"resetsAt"`
	DurationSeconds int64  `json:"durationSeconds"`
	ObservedAt      int64  `json:"observedAt"`
	Status          string `json:"status"`
}

type usageAPICredits struct {
	Available int     `json:"available"`
	ExpiresAt []int64 `json:"expiresAt"`
}

type usageAPIAccount struct {
	accountAPIAccount
	Status         string           `json:"status"`
	SnapshotStatus string           `json:"snapshotStatus"`
	FaultAt        int64            `json:"faultAt,omitempty"`
	Windows        []usageAPIWindow `json:"windows"`
	ResetCredits   *usageAPICredits `json:"resetCredits,omitempty"`
}

type usageAPIBucket struct {
	Name     string `json:"name"`
	Status   string `json:"status"`
	ResetsAt int64  `json:"resetsAt,omitempty"`
}

type usageAPIProvider struct {
	Provider string            `json:"provider"`
	Status   string            `json:"status"`
	Buckets  []usageAPIBucket  `json:"buckets"`
	Accounts []usageAPIAccount `json:"accounts"`
}

type usageAPIBalance struct {
	Provider     string `json:"provider"`
	Status       string `json:"status"`
	Currency     string `json:"currency,omitempty"`
	TotalBalance string `json:"totalBalance,omitempty"`
	ObservedAt   int64  `json:"observedAt,omitempty"`
}

type usageAPIResult struct {
	SchemaVersion  int                `json:"schemaVersion"`
	RequestedAt    int64              `json:"requestedAt"`
	ObservedAt     int64              `json:"observedAt"`
	Status         string             `json:"status"`
	UsageRefresh   string             `json:"usageRefresh"`
	AccountRefresh string             `json:"accountRefresh"`
	ActivePreset   string             `json:"activePreset"`
	Providers      []usageAPIProvider `json:"providers"`
	Balances       []usageAPIBalance  `json:"balances"`
}

// Cache rows carry relative reset countdowns computed at load time. Age those
// countdowns across the network request, without advancing their observation
// timestamps. Neither cache fallback nor failed refresh is a new observation.
func ageUsageAPICache(a *availability, seconds int64) {
	for key, wins := range a.accountUsage {
		for i := range wins {
			wins[i].secs -= seconds
		}
		a.accountUsage[key] = wins
	}
	for i := range a.wins {
		a.wins[i].secs -= seconds
	}
	for key, reset := range a.reset {
		a.reset[key] = reset - seconds
	}
}

func projectUsageAPI(a availability, usageOK, accountsOK, wholeStale bool, state accountSelectionState, requestedAt, now time.Time) usageAPIResult {
	out := usageAPIResult{
		SchemaVersion: 1, RequestedAt: requestedAt.Unix(), Status: "fresh",
		UsageRefresh: "succeeded", AccountRefresh: "succeeded", ActivePreset: state.ActiveName(),
		Providers: []usageAPIProvider{}, Balances: []usageAPIBalance{},
	}
	if !usageOK {
		out.UsageRefresh = "failed"
	}
	if !accountsOK {
		out.AccountRefresh = "failed"
	}
	if usageOK {
		out.ObservedAt = now.Unix()
	} else if wholeStale {
		out.Status = "stale"
	} else {
		out.Status = "failed"
	}
	if usageOK && (!accountsOK || a.accountsStale) {
		out.Status = "partial"
	}
	disabled := state.CurrentDisabled()
	// Keep all accounts visible, including disabled ones; routing buckets are
	// calculated only from the selected launch pool, as in the existing TUI.
	selected := selectedAvailability(a, disabled)
	for _, provider := range providerRegistry {
		p := usageAPIProvider{Provider: provider.ID, Status: "fresh", Buckets: []usageAPIBucket{}, Accounts: []usageAPIAccount{}}
		if wholeStale || a.accountsStale {
			p.Status = "stale"
		} else if !accountsOK || !usageOK {
			p.Status = "failed"
		} else if len(a.accounts[provider.ID]) == 0 {
			p.Status = "no_accounts"
		}
		for _, bucket := range provider.buckets() {
			status := selected.bucket[bucket]
			if !a.ok {
				status = "unknown"
			}
			if status == "" {
				status = "unknown"
			}
			b := usageAPIBucket{Name: bucket, Status: status}
			if seconds, ok := selected.reset[bucket]; ok {
				b.ResetsAt = now.Unix() + seconds
			}
			p.Buckets = append(p.Buckets, b)
		}
		for _, acct := range a.accounts[provider.ID] {
			key := accountKey{Provider: acct.Provider, IdentityKey: acct.IdentityKey}
			row := usageAPIAccount{
				accountAPIAccount: projectAccountAPI(acct, disabled, now),
				Status:            "unknown", SnapshotStatus: "fresh", Windows: []usageAPIWindow{},
			}
			if wholeStale || a.accountsStale {
				row.SnapshotStatus = "stale"
			}
			for _, win := range a.accountUsage[key] {
				status := "fresh"
				if win.stale || wholeStale {
					status = "stale"
				}
				if win.missing {
					status = "missing"
				}
				w := usageAPIWindow{
					WindowID: win.id, Label: win.label, Tier: win.tier, UsedPercent: win.pct,
					ResetsAt: now.Unix() + win.secs, DurationSeconds: win.dur, ObservedAt: win.observed, Status: status,
				}
				if win.missing {
					w.ResetsAt, w.ObservedAt = 0, 0
				}
				row.Windows = append(row.Windows, w)
				if !usageOK {
					out.ObservedAt = max(out.ObservedAt, win.observed)
				}
				if status == "stale" && out.Status == "fresh" {
					out.Status = "partial"
				}
				if status == "stale" && p.Status == "fresh" {
					p.Status = "partial"
				}
			}
			if len(row.Windows) > 0 {
				row.Status = "reported"
			}
			if a.silent[key] {
				row.Status = "no_usage"
			}
			if row.Blocked {
				row.Status = "blocked"
			}
			if fault, ok := a.faults[key]; ok {
				// A cause is an arbitrary broker error chain, potentially including
				// credentials or provider response bodies. Expose only the verdict.
				row.Status, row.FaultAt = "credential_disabled", fault.at/1000
			}
			if !row.Enabled {
				row.Status = "selection_disabled"
			}
			if credits, ok := a.accountCredits[key]; ok && usageOK && !wholeStale {
				c := &usageAPICredits{Available: credits.avail, ExpiresAt: make([]int64, 0, len(credits.exp))}
				for _, seconds := range credits.exp {
					c.ExpiresAt = append(c.ExpiresAt, now.Unix()+seconds)
				}
				sort.Slice(c.ExpiresAt, func(i, j int) bool { return c.ExpiresAt[i] < c.ExpiresAt[j] })
				row.ResetCredits = c
			}
			p.Accounts = append(p.Accounts, row)
		}
		out.Providers = append(out.Providers, p)
	}
	if b := a.deepseek; b != nil {
		balance := usageAPIBalance{Provider: "deepseek", Status: "failed"}
		if b.ok {
			balance.Status, balance.Currency, balance.TotalBalance, balance.ObservedAt = "fresh", b.currency, b.total, b.fetchedAt
			if b.stale || wholeStale {
				balance.Status = "stale"
			}
		}
		if balance.Status != "fresh" && out.Status == "fresh" {
			out.Status = "partial"
		}
		out.Balances = append(out.Balances, balance)
	}
	return out
}

// saveUsageCache's input countdown is relative to each row's observation,
// while a restored countdown is relative to now. Translate only the copy
// being persisted so omissions survive another one-shot invocation unchanged.
func saveUsageAPICache(path string, a availability, now time.Time) {
	if path == "" {
		return
	}
	cache := a
	cache.accountUsage = make(map[accountKey][]usageWin, len(a.accountUsage))
	for key, wins := range a.accountUsage {
		rows := append([]usageWin(nil), wins...)
		for i := range rows {
			if rows[i].observed > 0 {
				rows[i].secs += now.Unix() - rows[i].observed
			}
		}
		cache.accountUsage[key] = rows
	}
	saveUsageCache(path, cache)
}

func runUsageCLI(args []string) int {
	if len(args) > 0 {
		return accountAPIError("usage takes no arguments; output is one JSON snapshot")
	}
	state := defaultAccountSelectionState()
	if path := os.Getenv("CODE_AUTH_ACCOUNT_STATE"); path != "" {
		var err error
		state, err = readAccountAPIState(path)
		if err != nil {
			return accountAPIError(err.Error())
		}
	}
	requestedAt := time.Now()
	cache := loadUsageCache(os.Getenv("CODE_USAGE_CACHE"))
	cache.accountsStale = cache.accountsOK
	loadedAt := time.Now()
	broker := resolveBroker(os.Getenv("CODE_AUTH_VAULTS"), os.Getenv("CODE_AUTH_VAULTS_FILE"))
	fresh := loadAvailability(broker)
	now := time.Now()
	ageUsageAPICache(&cache, now.Unix()-loadedAt.Unix())
	merged, stale := reconcileUsage(cache, fresh)
	if fresh.ok && fresh.accountsOK {
		saveUsageAPICache(os.Getenv("CODE_USAGE_CACHE"), merged, now)
	}
	result := projectUsageAPI(merged, fresh.ok, fresh.accountsOK, stale, state, requestedAt, now)
	if status := writeAccountAPIJSON(result); status != 0 {
		return status
	}
	if result.Status == "failed" {
		return accountAPIError("usage snapshot unavailable")
	}
	return 0
}
