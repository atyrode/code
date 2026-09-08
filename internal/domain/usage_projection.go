package domain

import (
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
