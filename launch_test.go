package main

import (
	"strings"
	"testing"
	"time"
)

// The launch report is the one place that decides whether an enabled account
// can serve the model being launched. Each row is a situation the old
// provider-wide-only warning got wrong or could not express: a tier block
// warned about nothing, a tier block on an unrequested tier would have been
// noise, and a block fresh usage contradicts read as exhaustion (#86).
func TestLaunchAccountReportTierAwareness(t *testing.T) {
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	alex := accountKey{Provider: anthropicProvider, IdentityKey: "alex"}
	fable := launchIntent{tiers: map[string]string{anthropicProvider: "fable"}}
	fresh := func(pct int) []usageWin {
		return []usageWin{
			{label: "Claude 5 Hour", id: "5h", pct: 12, secs: 3600, dur: 5 * 3600, prov: anthropicProvider},
			{label: "Claude 7 Day (Fable)", id: "7d", tier: "fable", pct: pct, secs: 4 * 86400, dur: 7 * 86400, prov: anthropicProvider},
		}
	}
	cases := []struct {
		name     string
		accounts []account
		disabled map[accountKey]bool
		intent   launchIntent
		wantPool []string          // nil: provider key absent from the pool document
		blocked  map[string]string // identity → scope of the block keeping it off the tier
		contra   []string          // identities whose block fresh usage contradicts
		want     []string          // substrings every warning line must carry, in order
		never    []string          // substrings no warning may carry
	}{
		{
			name: "provider-wide block on every enabled account",
			accounts: []account{
				{Provider: anthropicProvider, IdentityKey: "alex", blocks: []accountBlock{{Scope: "", Until: now.Add(time.Hour)}}},
				{Provider: anthropicProvider, IdentityKey: "bob", blocks: []accountBlock{{Scope: "", Until: now.Add(2 * time.Hour)}}},
				{Provider: anthropicProvider, IdentityKey: "spare"},
			},
			disabled: map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "spare"}: true},
			intent:   fable,
			wantPool: []string{"alex", "bob"},
			blocked:  map[string]string{"alex": "", "bob": ""},
			// The earliest expiry is when the pool is usable again.
			want: []string{"every enabled Anthropic account (alex, bob) is rate-limit blocked for " + fmtReset(3600)},
		},
		{
			name: "tier block on the requested tier names the tier, not the provider",
			accounts: []account{
				{Provider: anthropicProvider, IdentityKey: "alex", blocks: []accountBlock{{Scope: "tier:fable", Until: now.Add(6 * time.Hour)}}},
				{Provider: anthropicProvider, IdentityKey: "spare"},
			},
			disabled: map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "spare"}: true},
			intent:   fable,
			wantPool: []string{"alex"},
			blocked:  map[string]string{"alex": "tier:fable"},
			want:     []string{"Fable is rate-limit blocked on every enabled Anthropic account (alex) for " + fmtReset(6*3600)},
			never:    []string{"Anthropic account (alex) is rate-limit blocked", "Anthropic is blocked"},
		},
		{
			name: "tier block on an unrequested tier is not a warning",
			accounts: []account{
				{Provider: anthropicProvider, IdentityKey: "alex", blocks: []accountBlock{{Scope: "tier:fable", Until: now.Add(6 * time.Hour)}}},
				{Provider: anthropicProvider, IdentityKey: "spare"},
			},
			disabled: map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "spare"}: true},
			intent:   launchIntent{},
			wantPool: []string{"alex"},
			blocked:  map[string]string{},
		},
		{
			name: "one of two enabled accounts tier-blocked: pool lists both, one marked, no warning",
			accounts: []account{
				{Provider: anthropicProvider, IdentityKey: "alex", blocks: []accountBlock{{Scope: "tier:fable", Until: now.Add(6 * time.Hour)}}},
				{Provider: anthropicProvider, IdentityKey: "bob"},
				{Provider: anthropicProvider, IdentityKey: "spare"},
			},
			disabled: map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "spare"}: true},
			intent:   fable,
			wantPool: []string{"alex", "bob"},
			blocked:  map[string]string{"alex": "tier:fable"},
		},
		{
			name: "fresh usage with headroom contradicts an unexpired tier block",
			accounts: []account{
				{Provider: anthropicProvider, IdentityKey: "alex", credentialID: "24", blocks: []accountBlock{{Scope: "tier:fable", Until: now.Add(6 * time.Hour)}}},
				{Provider: anthropicProvider, IdentityKey: "spare"},
			},
			disabled: map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "spare"}: true},
			intent:   launchIntent{tiers: fable.tiers, usage: map[accountKey][]usageWin{alex: fresh(0)}},
			wantPool: []string{"alex"},
			blocked:  map[string]string{"alex": "tier:fable"},
			contra:   []string{"alex"},
			want: []string{
				"Fable is rate-limit blocked on every enabled Anthropic account (alex) for " + fmtReset(6*3600),
				"Anthropic alex: fresh usage shows Fable headroom while the broker still holds a tier:fable block until " + fmtReset(6*3600) + " (until " + now.Add(6*time.Hour).Local().Format("Jan 2 15:04") + ") — stale broker state, not exhaustion; press x (retry now)",
			},
		},
		{
			name: "a maxed fresh window agrees with the block: no contradiction",
			accounts: []account{
				{Provider: anthropicProvider, IdentityKey: "alex", blocks: []accountBlock{{Scope: "tier:fable", Until: now.Add(6 * time.Hour)}}},
				{Provider: anthropicProvider, IdentityKey: "spare"},
			},
			disabled: map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "spare"}: true},
			intent:   launchIntent{tiers: fable.tiers, usage: map[accountKey][]usageWin{alex: fresh(100)}},
			wantPool: []string{"alex"},
			blocked:  map[string]string{"alex": "tier:fable"},
			want:     []string{"Fable is rate-limit blocked"},
			never:    []string{"stale broker state"},
		},
		{
			name: "a cached window cannot contradict a block",
			accounts: []account{
				{Provider: anthropicProvider, IdentityKey: "alex", blocks: []accountBlock{{Scope: "tier:fable", Until: now.Add(6 * time.Hour)}}},
				{Provider: anthropicProvider, IdentityKey: "spare"},
			},
			disabled: map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "spare"}: true},
			intent: launchIntent{tiers: fable.tiers, usage: map[accountKey][]usageWin{alex: {
				{label: "Claude 7 Day (Fable)", id: "7d", tier: "fable", pct: 0, prov: anthropicProvider, stale: true},
			}}},
			wantPool: []string{"alex"},
			blocked:  map[string]string{"alex": "tier:fable"},
			want:     []string{"Fable is rate-limit blocked"},
			never:    []string{"stale broker state"},
		},
		{
			name: "unrestricted provider: no key written, blocks still judged",
			accounts: []account{
				{Provider: anthropicProvider, IdentityKey: "alex", blocks: []accountBlock{{Scope: "tier:fable", Until: now.Add(6 * time.Hour)}}},
				{Provider: anthropicProvider, IdentityKey: "bob", blocks: []accountBlock{{Scope: "tier:fable", Until: now.Add(3 * time.Hour)}}},
			},
			intent:   fable,
			wantPool: nil,
			blocked:  map[string]string{"alex": "tier:fable", "bob": "tier:fable"},
			want:     []string{"Fable is rate-limit blocked on every enabled Anthropic account (alex, bob) for " + fmtReset(3*3600)},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			report := launchAccountReport(map[string][]account{anthropicProvider: tc.accounts}, tc.disabled, tc.intent, now)
			pool := report.pool()
			got, restricted := pool[anthropicProvider]
			if (tc.wantPool == nil) == restricted || (restricted && strings.Join(got, ",") != strings.Join(tc.wantPool, ",")) {
				t.Fatalf("pool[anthropic] = %#v (present %v), want %#v", got, restricted, tc.wantPool)
			}
			var prov launchProvider
			for _, p := range report.Providers {
				if p.Provider == anthropicProvider {
					prov = p
				}
			}
			for _, id := range prov.Identities {
				scope, blocked := tc.blocked[id.IdentityKey]
				if blocked != !id.eligible() || (blocked && scope != id.BlockScope) {
					t.Fatalf("%s judged scope %q eligible %v, want blocked %v scope %q", id.IdentityKey, id.BlockScope, id.eligible(), blocked, scope)
				}
				wantContra := false
				for _, c := range tc.contra {
					wantContra = wantContra || c == id.IdentityKey
				}
				if id.Contradiction != wantContra {
					t.Fatalf("%s contradiction = %v, want %v", id.IdentityKey, id.Contradiction, wantContra)
				}
			}
			warnings := report.warnings(now)
			if len(warnings) != len(tc.want) {
				t.Fatalf("warnings = %#v, want %d matching %#v", warnings, len(tc.want), tc.want)
			}
			for i, w := range tc.want {
				if !strings.Contains(warnings[i], w) {
					t.Fatalf("warning %d = %q, want it to contain %q", i, warnings[i], w)
				}
			}
			for _, w := range warnings {
				for _, n := range tc.never {
					if strings.Contains(w, n) {
						t.Fatalf("warning %q must not say %q", w, n)
					}
				}
			}
		})
	}
}

// The pool lines are the operator's view of what the file says: every
// identity, blocked ones marked with the scope that blocks them, under a
// sentence saying the enabled accounts are a pool rather than a pick.
func TestLaunchReportPoolLinesMarkBlockedIdentities(t *testing.T) {
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	accounts := map[string][]account{
		anthropicProvider: {
			{Provider: anthropicProvider, IdentityKey: "alex", Email: "alex@example.test", blocks: []accountBlock{{Scope: "tier:fable", Until: now.Add(6 * time.Hour)}}},
			{Provider: anthropicProvider, IdentityKey: "bob"},
			{Provider: anthropicProvider, IdentityKey: "spare"},
		},
		openAIProvider: {{Provider: openAIProvider, IdentityKey: "codex"}},
	}
	disabled := map[accountKey]bool{{Provider: anthropicProvider, IdentityKey: "spare"}: true}
	report := launchAccountReport(accounts, disabled, launchIntent{tiers: map[string]string{anthropicProvider: "fable"}}, now)
	lines := report.poolLines(now)
	want := []string{
		"Enabled accounts form a pool omp rotates through; disabling one leaves every other enabled account in play.",
		"Anthropic pool: alex <alex@example.test> [tier:fable blocked " + fmtReset(6*3600) + "], bob",
		"OpenAI pool (every account, no restriction written): codex",
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Fatalf("pool lines:\n%s\nwant:\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
}

// The requested tier comes from the default agent's lead in the routing rows,
// through the catalog's bucket column; a side role on a special tier does not
// change what the launch asks of the lead's provider.
func TestLaunchIntentTierFollowsDefaultLead(t *testing.T) {
	m := model{
		facts: map[string]modelFact{
			"claude-fable-1":       {bucket: "claude-fable", pool: "A"},
			"claude-opus-5":        {bucket: "claude-main", pool: "A"},
			"gpt-5.3-codex-spark":  {bucket: "codex-spark", pool: "O"},
			"gpt-5.6-terra":        {bucket: "codex-main", pool: "O"},
			"claude-haiku-4-5":     {bucket: "claude-main", pool: "A"},
			"deepseek-v3-2-reason": {bucket: "", pool: "D"},
		},
		generated: map[string][]string{
			comboID(map[string]string{"lane": "claude-only", "model": "elite", "thinking": "high", "spark": "off"}): {
				"  ● default    claude-fable-1:high → claude-opus-5:high",
				"    smol       gpt-5.3-codex-spark:low → claude-haiku-4-5:low",
			},
		},
		sel: map[string]string{"lane": "claude-only", "model": "elite", "thinking": "high", "spark": "off", "advisor": "off"},
	}
	intent := m.launchIntent()
	if intent.tier(anthropicProvider) != "fable" {
		t.Fatalf("anthropic tier = %q, want fable from the default lead's bucket", intent.tier(anthropicProvider))
	}
	if intent.tier(openAIProvider) != launchTierMain {
		t.Fatalf("openai tier = %q, want main: the smol role's spark is not the requested model", intent.tier(openAIProvider))
	}
	m.sel["model"] = "smart"
	m.generated[comboID(m.sel)] = []string{"  ● default    claude-opus-5:high → gpt-5.6-terra:high"}
	if intent := m.launchIntent(); intent.tier(anthropicProvider) != launchTierMain {
		t.Fatalf("anthropic tier = %q, want main for an ordinary lead", intent.tier(anthropicProvider))
	}
}
