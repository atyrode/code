package main

import (
	"encoding/json"
	"strings"
	"time"
)

// These types deliberately do not include catalog paths/argv, session metadata,
// broker credentials, error bodies, or internal blocks. Never marshal a raw
// child document: every public byte must originate in one of these fields.
type inspectResult struct {
	SchemaVersion int `json:"schema_version"`
	ObservedAt time.Time `json:"observed_at"`
	Observation string `json:"observation"`
	Catalog catalogState `json:"catalog"`
	Selection map[string]string `json:"selection"`
	Facets []facet `json:"facets"`
	Routing []route `json:"routing"`
	Estimates *estimates `json:"estimates" nullable:"true"`
	Providers []inspectProvider `json:"providers"`
	LaunchModes []launchMode `json:"launch_modes"`
	RuntimeTargets []runtimeTarget `json:"runtime_targets"`
}

type catalogState struct {
	State string `json:"state"`
}

type facet struct {
	Key string `json:"key"`
	Values []string `json:"values"`
}

type route struct {
	Role string `json:"role"`
	Primary string `json:"primary"`
	Fallbacks []string `json:"fallbacks"`
	AgentOverride bool `json:"agent_override"`
}

type estimates struct {
	Cost int `json:"cost"`
	Speed int `json:"speed"`
	ScaleMin int `json:"scale_min"`
	ScaleMax int `json:"scale_max"`
}

type inspectProvider struct {
	ID string `json:"id"`
	CredentialState string `json:"credential_state"`
}

type launchMode struct {
	Mode string `json:"mode"`
	Available bool `json:"available"`
}

type runtimeTarget struct {
	Name string `json:"name"`
	Label string `json:"label"`
	Phase string `json:"phase"`
	Model string `json:"model"`
	ContextWindow int `json:"context_window"`
	Provisioned bool `json:"provisioned"`
	Running bool `json:"running"`
	Healthy bool `json:"healthy"`
	DiskBytes int64 `json:"disk_bytes"`
	EstimatedDiskBytes int64 `json:"estimated_disk_bytes"`
}

type accountReference struct {
	Provider string `json:"provider"`
	IdentityKey string `json:"identityKey"`
}

type restriction struct {
	Scope string `json:"scope"`
	Until int64 `json:"until"`
}

type accountRow struct {
	Provider string `json:"provider"`
	IdentityKey string `json:"identityKey"`
	Email string `json:"email,omitempty"`
	Selectable bool `json:"selectable"`
	Enabled bool `json:"enabled"`
	Blocked bool `json:"blocked"`
	BlockedUntil int64 `json:"blockedUntil,omitempty"`
	Restrictions []restriction `json:"restrictions"`
}

type preset struct {
	Name string `json:"name"`
	Disabled []accountReference `json:"disabled"`
}

type accountsResult struct {
	SchemaVersion int `json:"schemaVersion"`
	Operation string `json:"operation"`
	ObservedAt int64 `json:"observedAt"`
	ActivePreset string `json:"activePreset"`
	Accounts []accountRow `json:"accounts"`
	Presets []preset `json:"presets"`
	ManualDisabled []accountReference `json:"manualDisabled"`
}

type clearBlocksResult struct {
	SchemaVersion int `json:"schemaVersion"`
	Operation string `json:"operation"`
	Account accountReference `json:"account"`
	Cleared bool `json:"cleared"`
}

type usageWindow struct {
	WindowID string `json:"windowId"`
	Label string `json:"label"`
	Tier string `json:"tier,omitempty"`
	UsedPercent int `json:"usedPercent"`
	ResetsAt int64 `json:"resetsAt"`
	DurationSeconds int64 `json:"durationSeconds"`
	ObservedAt int64 `json:"observedAt"`
	Status string `json:"status"`
}

type usageCredits struct {
	Available int `json:"available"`
	ExpiresAt []int64 `json:"expiresAt"`
}

type usageAccount struct {
	Provider string `json:"provider"`
	IdentityKey string `json:"identityKey"`
	Email string `json:"email,omitempty"`
	Selectable bool `json:"selectable"`
	Enabled bool `json:"enabled"`
	Blocked bool `json:"blocked"`
	BlockedUntil int64 `json:"blockedUntil,omitempty"`
	Restrictions []restriction `json:"restrictions"`
	Status string `json:"status"`
	SnapshotStatus string `json:"snapshotStatus"`
	FaultAt int64 `json:"faultAt,omitempty"`
	Windows []usageWindow `json:"windows"`
	ResetCredits *usageCredits `json:"resetCredits,omitempty"`
}

type usageBucket struct {
	Name string `json:"name"`
	Status string `json:"status"`
	ResetsAt int64 `json:"resetsAt,omitempty"`
}

type usageProvider struct {
	Provider string `json:"provider"`
	Status string `json:"status"`
	Buckets []usageBucket `json:"buckets"`
	Accounts []usageAccount `json:"accounts"`
}

type usageBalance struct {
	Provider string `json:"provider"`
	Status string `json:"status"`
	Currency string `json:"currency,omitempty"`
	TotalBalance string `json:"totalBalance,omitempty"`
	ObservedAt int64 `json:"observedAt,omitempty"`
}

type usageResult struct {
	SchemaVersion int `json:"schemaVersion"`
	RequestedAt int64 `json:"requestedAt"`
	ObservedAt int64 `json:"observedAt"`
	Status string `json:"status"`
	UsageRefresh string `json:"usageRefresh"`
	AccountRefresh string `json:"accountRefresh"`
	ActivePreset string `json:"activePreset"`
	Providers []usageProvider `json:"providers"`
	Balances []usageBalance `json:"balances"`
}

type suggestAction struct {
	Key string `json:"key"`
	Value string `json:"value"`
}

type suggestResult struct {
	SchemaVersion int `json:"schema_version"`
	ObservedAt time.Time `json:"observed_at"`
	Observation string `json:"observation"`
	Evaluator string `json:"evaluator"`
	Actions []suggestAction `json:"actions"`
	Selection map[string]string `json:"selection"`
}

func projectResult(operation string, data []byte, baseRevision *int64) ([]byte, error) {
	if baseRevision != nil && (*baseRevision < 0 || *baseRevision > 9007199254740991) {
		return nil, errInvalid
	}
	if len(data) > maxOutput {
		return nil, errInvalid
	}
	var result any
	switch operation {
	case "inspect":
		var p inspectResult
		if decodeDocument(data, &p, false) != nil || p.SchemaVersion != 1 || p.Observation != "one_shot" {
			return nil, errInvalid
		}
		if p.Catalog.State != "ready" && p.Catalog.State != "missing" {
			return nil, errInvalid
		}
		for _, provider := range p.Providers {
			switch provider.CredentialState {
			case "unknown", "available", "unavailable":
			default:
				return nil, errInvalid
			}
		}
		for _, mode := range p.LaunchModes {
			switch mode.Mode {
			case "generated", "managed", "untrusted", "runtime":
			default:
				return nil, errInvalid
			}
		}
		result = struct {
			inspectResult
			BaseRevision *int64 `json:"baseRevision"`
		}{p, baseRevision}
	case "usage":
		var p usageResult
		if decodeDocument(data, &p, false) != nil || p.SchemaVersion != 1 {
			return nil, errInvalid
		}
		switch p.Status {
		case "fresh", "partial", "stale", "failed":
		default:
			return nil, errInvalid
		}
		if (p.UsageRefresh != "succeeded" && p.UsageRefresh != "failed") || (p.AccountRefresh != "succeeded" && p.AccountRefresh != "failed") {
			return nil, errInvalid
		}
		result = struct {
			usageResult
			BaseRevision *int64 `json:"baseRevision"`
		}{p, baseRevision}
	case "accounts-list", "account-import", "account-set", "preset-create", "preset-update", "preset-activate", "preset-delete":
		var p accountsResult
		expected := strings.TrimPrefix(operation, "account-")
		if operation == "accounts-list" || operation == "account-import" {
			expected = "list"
		} else if strings.HasPrefix(operation, "preset-") {
			expected = "presets " + strings.TrimPrefix(operation, "preset-")
		}
		if decodeDocument(data, &p, false) != nil || p.SchemaVersion != 1 || p.Operation != expected {
			return nil, errInvalid
		}
		if operation == "accounts-list" {
			result = struct {
				accountsResult
				BaseRevision *int64 `json:"baseRevision"`
			}{p, baseRevision}
		} else {
			if baseRevision == nil {
				return nil, errInvalid
			}
			result = struct {
				accountsResult
				BaseRevision int64 `json:"baseRevision"`
			}{p, *baseRevision}
		}
	case "account-clear-blocks":
		var p clearBlocksResult
		if decodeDocument(data, &p, false) != nil || p.SchemaVersion != 1 || p.Operation != "clear-blocks" || !p.Cleared {
			return nil, errInvalid
		}
		result = p
	case "suggest":
		var p suggestResult
		if decodeDocument(data, &p, false) != nil || p.SchemaVersion != 1 || p.Observation != "one_shot" {
			return nil, errInvalid
		}
		seen := make(map[string]bool, len(p.Actions))
		for _, action := range p.Actions {
			selected, exists := p.Selection[action.Key]
			if action.Key == "" || seen[action.Key] || !exists || selected != action.Value {
				return nil, errInvalid
			}
			seen[action.Key] = true
		}
		result = struct {
			suggestResult
			BaseRevision *int64 `json:"baseRevision"`
		}{p, baseRevision}
	default:
		return nil, errInvalid
	}
	encoded, err := json.Marshal(result)
	if err != nil || len(encoded)+1 > maxOutput {
		return nil, errInvalid
	}
	return encoded, nil
}
