package domain

import (
	"testing"
	"time"
	"fmt"
 "slices"
	"reflect"
)

const day int64 = 24*60*60

func TestSelectedAvailabilityAggregatesEnabledMatchedAccounts(t *testing.T) {
	codexA := accountKey{Provider: "openai-codex", IdentityKey: "a"}
	codexB := accountKey{Provider: "openai-codex", IdentityKey: "b"}
	codexMissing := accountKey{Provider: "openai-codex", IdentityKey: "missing"}
	codexDisabled := accountKey{Provider: "openai-codex", IdentityKey: "disabled"}
	claude := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	a := availability{
		ok: true, accountsOK: true,
		bucket: map[string]string{}, reset: map[string]int64{},
		accounts: map[string][]account{
			"openai-codex": {
				{Provider: codexA.Provider, IdentityKey: codexA.IdentityKey, Email: "a@example.test"},
				{Provider: codexB.Provider, IdentityKey: codexB.IdentityKey, Email: "b@example.test"},
				{Provider: codexMissing.Provider, IdentityKey: codexMissing.IdentityKey, Email: "missing@example.test"},
				{Provider: codexDisabled.Provider, IdentityKey: codexDisabled.IdentityKey, Email: "disabled@example.test"},
			},
			"anthropic": {{Provider: claude.Provider, IdentityKey: claude.IdentityKey, Email: "claude@example.test"}},
		},
		accountUsage: map[accountKey][]usageWin{
			codexA: {
				{label: "5 hours", pct: 10, secs: 100, dur: 5 * 3600, prov: "openai-codex", observed: 300},
				{label: "7 days", pct: 20, secs: 600, dur: 7 * day, prov: "openai-codex"},
				{label: "5 hours (Spark)", pct: 90, tier: "spark", secs: 50, dur: 5 * 3600, prov: "openai-codex"},
			},
			codexB: {
				{label: "Codex 5 Hour", pct: 11, secs: 101, dur: 5 * 3600, prov: "openai-codex", stale: true, observed: 200},
				{label: "7 days", pct: 40, secs: 700, dur: 6 * day, prov: "openai-codex"},
				{label: "wrong provider", pct: 100, secs: 1, dur: 5 * 3600, prov: "anthropic"},
				{label: "unknown tier", pct: 100, tier: "other", secs: 1, dur: 5 * 3600, prov: "openai-codex"},
				{label: "mystery window", pct: 100, secs: 1, dur: 5 * 3600, prov: "openai-codex"},
			},
			codexDisabled: {{label: "5 hours", pct: 100, secs: 0, dur: 5 * 3600, prov: "openai-codex"}},
			// A tier-scoped window the registry declares no bucket for: still a
			// real reported window, so it must reach the aggregate rows.
			claude: {{label: "Claude 7 Day (Fable)", id: "7d", pct: 31, tier: "fable", secs: 2 * day, dur: 7 * day, prov: "anthropic"}},
		},
		accountCredits: map[accountKey]resetCredits{
			codexA:        {avail: 1, exp: []int64{day}},
			codexB:        {avail: 2, exp: []int64{2 * day}},
			codexDisabled: {avail: 9, exp: []int64{9 * day}},
		},
		// Flat and unattributed report rows must never cross the selection seam.
		wins: []usageWin{{label: "5 hours", pct: 99, secs: 0, dur: 5 * 3600, prov: "openai-codex"}},
	}
	got := selectedAvailability(a, map[accountKey]bool{codexDisabled: true})
	var main5 usageWin
	foundMain := false
	for _, win := range got.wins {
		if win.prov == "openai-codex" && win.tier == "" && win.dur == 5*3600 && win.label == "5h" {
			main5, foundMain = win, true
		}
		if win.label == "wrong provider" || win.label == "unknown tier" || win.label == "mystery window" || win.pct == 99 || win.pct == 100 {
			t.Errorf("excluded report contributed an aggregate row: %+v", win)
		}
	}
	if !foundMain || main5.pct != 11 || main5.secs != 101 {
		t.Fatalf("half-up aggregate = %+v, want 11%% and 101s", main5)
	}
	if !main5.stale || main5.observed != 200 {
		t.Errorf("aggregate stale/oldest observation = %+v, want stale at 200", main5)
	}
	if len(got.wins) != 5 {
		t.Errorf("provider/tier/duration groups collapsed incorrectly: %+v", got.wins)
	}
	if got.credits.avail != 3 || !reflect.DeepEqual(got.credits.exp, []int64{day, 2 * day}) {
		t.Errorf("enabled reset credits = %+v, want sum/concatenation from a+b only", got.credits)
	}

	allDisabled := map[accountKey]bool{codexA: true, codexB: true, codexMissing: true, codexDisabled: true, claude: true}
	empty := selectedAvailability(a, allDisabled)
	if len(empty.wins) != 0 || empty.credits.avail != 0 || len(empty.credits.exp) != 0 {
		t.Errorf("all-disabled selection fabricated aggregate data: %+v", empty)
	}
}

func TestSelectedAvailabilityRebuildsRoutingBuckets(t *testing.T) {
	maxed := accountKey{Provider: "openai-codex", IdentityKey: "maxed"}
	remaining := accountKey{Provider: "openai-codex", IdentityKey: "remaining"}
	claude := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	base := availability{
		ok: true,
		// These aggregate fields deliberately disagree with the enabled
		// identities. selectedAvailability must never inherit them.
		bucket: map[string]string{"codex-main": "maxed", "codex-spark": "maxed", "claude-main": "unauthed"},
		reset:  map[string]int64{"codex-main": 999, "codex-spark": 999},
		accounts: map[string][]account{
			"openai-codex": {
				{Provider: maxed.Provider, IdentityKey: maxed.IdentityKey},
				{Provider: remaining.Provider, IdentityKey: remaining.IdentityKey},
			},
			"anthropic": {{Provider: claude.Provider, IdentityKey: claude.IdentityKey}},
		},
		accountUsage: map[accountKey][]usageWin{
			maxed: {
				{label: "5 hours", pct: 100, secs: 100, dur: 5 * 3600, prov: "openai-codex"},
				{label: "5 hours (Spark)", tier: "spark", pct: 100, secs: 80, dur: 5 * 3600, prov: "openai-codex"},
			},
			remaining: {
				{label: "5 hours", pct: 20, secs: 200, dur: 5 * 3600, prov: "openai-codex"},
				{label: "5 hours (Spark)", tier: "spark", pct: 40, secs: 120, dur: 5 * 3600, prov: "openai-codex"},
			},
		},
	}

	t.Run("disabled maxed account is excluded", func(t *testing.T) {
		got := selectedAvailability(base, map[accountKey]bool{maxed: true})
		if got.bucket["codex-main"] != "ok" || got.bucket["codex-spark"] != "ok" {
			t.Fatalf("disabled maxed account struck selected routes: %+v", got.bucket)
		}
		if _, ok := got.reset["codex-main"]; ok {
			t.Fatalf("disabled reset leaked into selected availability: %+v", got.reset)
		}
	})

	t.Run("all disabled provider is unavailable", func(t *testing.T) {
		got := selectedAvailability(base, map[accountKey]bool{maxed: true, remaining: true})
		if got.bucket["codex-main"] != "unauthed" || got.bucket["codex-spark"] != "unauthed" {
			t.Fatalf("provider with no enabled identities remained available: %+v", got.bucket)
		}
		if got.bucket["claude-main"] != "ok" {
			t.Fatalf("enabled provider without a real observation must stay unknown/non-down: %+v", got.bucket)
		}
	})

	t.Run("mixed selected accounts retain capacity", func(t *testing.T) {
		got := selectedAvailability(base, nil)
		if got.bucket["codex-main"] != "ok" || got.bucket["codex-spark"] != "ok" {
			t.Fatalf("one maxed identity overrode selected aggregate capacity: %+v", got.bucket)
		}
	})

	// The verdict is per account, not per aggregate. Above, both accounts
	// share a window shape, so the averaged group happened to land under
	// 100% either way. This is the live payload that did not: a 30d plan
	// beside 7d ones is a group of one, and its 100% struck every OpenAI
	// route while the 7d account sat at 15%.
	t.Run("an exhausted account with a window shape of its own is not the provider", func(t *testing.T) {
		shapes := base
		shapes.accountUsage = map[accountKey][]usageWin{
			maxed:     {{label: "30 days", id: "30d", pct: 100, secs: 300 * 3600, dur: 30 * day, prov: "openai-codex"}},
			remaining: {{label: "7 days", id: "7d", pct: 15, secs: 140 * 3600, dur: 7 * day, prov: "openai-codex"}},
		}
		got := selectedAvailability(shapes, nil)
		if got.bucket["codex-main"] != "ok" {
			t.Fatalf("a sibling with headroom is exactly the account omp rotates to; got %+v", got.bucket)
		}
		if _, ok := got.reset["codex-main"]; ok {
			t.Fatalf("a usable bucket carries no reset: %+v", got.reset)
		}
	})

	t.Run("one account is blocked by any of its maxed windows", func(t *testing.T) {
		one := base
		one.accountUsage = map[accountKey][]usageWin{
			maxed: {
				{label: "5 hours", id: "5h", pct: 100, secs: 100, dur: 5 * 3600, prov: "openai-codex"},
				{label: "7 days", id: "7d", pct: 10, secs: 600, dur: 7 * day, prov: "openai-codex"},
			},
		}
		got := selectedAvailability(one, map[accountKey]bool{remaining: true})
		if got.bucket["codex-main"] != "maxed" || got.reset["codex-main"] != 100 {
			t.Fatalf("a maxed 5h blocks the account whatever its 7d says; got %q/%d", got.bucket["codex-main"], got.reset["codex-main"])
		}
	})

	t.Run("all selected maxed frees with the first account", func(t *testing.T) {
		allMaxed := base
		allMaxed.accountUsage = map[accountKey][]usageWin{
			maxed:     {{label: "5 hours", pct: 100, secs: 100, dur: 5 * 3600, prov: "openai-codex"}},
			remaining: {{label: "5 hours", pct: 100, secs: 200, dur: 5 * 3600, prov: "openai-codex"}},
		}
		got := selectedAvailability(allMaxed, nil)
		if got.bucket["codex-main"] != "maxed" || got.reset["codex-main"] != 100 {
			t.Fatalf("selected bucket/reset = %q/%d, want maxed/100 - the route is usable once the first account frees", got.bucket["codex-main"], got.reset["codex-main"])
		}
	})
}

func TestSelectedAvailabilityHonoursReLoginOrgChange(t *testing.T) {
	reLogged := account{Provider: "anthropic", IdentityKey: "email:shared@example.test|org:new"}
	a := availability{
		ok: true, accountsOK: true,
		bucket: map[string]string{}, reset: map[string]int64{},
		accounts:       map[string][]account{"anthropic": {reLogged}},
		accountUsage:   map[accountKey][]usageWin{},
		accountCredits: map[accountKey]resetCredits{},
	}
	staleDisabled := map[accountKey]bool{
		{Provider: "anthropic", IdentityKey: "email:shared@example.test|org:old"}: true,
	}
	got := selectedAvailability(a, staleDisabled)
	if len(got.accounts["anthropic"]) != 0 {
		t.Fatalf("re-logged-in account returned to the usage seam despite being disabled: %#v", got.accounts)
	}

}

func TestParseAvailabilityVerdictIsPerAccount(t *testing.T) {
	accounts := map[string][]account{
		"openai-codex": {
			{Provider: "openai-codex", IdentityKey: "plus", Email: "plus@example.test"},
			{Provider: "openai-codex", IdentityKey: "pro", Email: "pro@example.test"},
		},
	}
	in := func(h int64) int64 { return (time.Now().Unix() + h*3600) * 1000 }
	payload := fmt.Sprintf(`{"reports":[
		{"provider":"openai-codex","email":"plus@example.test","limits":[
			{"label":"30 days","scope":{"windowId":"30d"},"amount":{"usedFraction":1},
			 "window":{"id":"30d","resetsAt":%d,"durationMs":2592000000}}]},
		{"provider":"openai-codex","email":"pro@example.test","limits":[
			{"label":"7 days","scope":{"windowId":"7d"},"amount":{"usedFraction":0.15},
			 "window":{"id":"7d","resetsAt":%d,"durationMs":604800000}},
			{"label":"7 days (gpt-reserve)","scope":{"tier":"base-model-inference","windowId":"7d"},"amount":{"usedFraction":0},
			 "window":{"id":"7d","resetsAt":%d,"durationMs":604800000}}]}
	]}`, in(373), in(140), in(167))
	a := parseAvailability(accounts, true, []byte(payload), time.Now().Unix())
	if !a.ok {
		t.Fatal("fixture payload did not parse")
	}
	if a.down("codex-main") {
		t.Fatalf("one account's exhausted 30d struck the provider while its sibling had headroom: %+v", a.bucket)
	}
	if _, ok := a.reset["codex-main"]; ok {
		t.Errorf("a usable bucket carries no reset: %+v", a.reset)
	}
	// Disable the account with headroom and the verdict flips: now nobody is
	// left, and the reset is the exhausted account's own.
	sel := selectedAvailability(a, map[accountKey]bool{{Provider: "openai-codex", IdentityKey: "pro"}: true})
	if !sel.down("codex-main") || sel.reset["codex-main"] < 372*3600 {
		t.Fatalf("with the only free account disabled the bucket must be maxed until the 30d resets: %q/%d", sel.bucket["codex-main"], sel.reset["codex-main"])
	}
}

func TestUndeclaredTierWindowOwnsNoBucket(t *testing.T) {
	key := accountKey{Provider: "anthropic", IdentityKey: "claude"}
	accounts := map[string][]account{
		"anthropic": {{Provider: key.Provider, IdentityKey: key.IdentityKey, Email: "alex@example.test"}},
	}
	resetsAt := (time.Now().Unix() + 3*3600) * 1000
	payload := fmt.Sprintf(`{"reports":[{"provider":"anthropic","email":"alex@example.test","limits":[
		{"label":"Claude 5 Hour","scope":{"windowId":"5h"},"amount":{"usedFraction":0.1},
		 "window":{"id":"5h","resetsAt":%d,"durationMs":18000000}},
		{"label":"Claude 7 Day (Fable)","scope":{"tier":"fable","windowId":"7d"},"amount":{"usedFraction":1},
		 "window":{"id":"7d","resetsAt":%d,"durationMs":604800000}}
	]}]}`, resetsAt, resetsAt)

	a := parseAvailability(accounts, true, []byte(payload), time.Now().Unix())
	if !a.ok {
		t.Fatal("fixture payload did not parse")
	}
	if got := a.bucket["claude-main"]; got != "ok" {
		t.Fatalf("an undeclared tier's maxed window moved claude-main to %q, want ok", got)
	}
	if _, ok := a.reset["claude-main"]; ok {
		t.Errorf("an undeclared tier's window contributed a main-bucket reset: %+v", a.reset)
	}
	if a.down("claude-main") {
		t.Error("every route through Claude was struck by a window nothing here models")
	}

	// It is still a real window: it names itself, so the payload gate passes it
	// and the direct renderer labels it by id plus tier.
	var carve usageWin
	for _, w := range a.wins {
		if w.tier == "fable" {
			carve = w
		}
	}
	if carve.id != "7d" || carve.pct != 100 {
		t.Fatalf("the tier-scoped window was dropped or mangled: %+v", a.wins)
	}
	if !knownUsageWindow(carve) {
		t.Fatal("a payload-named window on a metered provider must be renderable")
	}

	// selectedAvailability rebuilds buckets from the enabled identities alone,
	// so it is a second, independent chance to make the same mistake.
	sel := selectedAvailability(a, nil)
	if sel.bucket["claude-main"] != "ok" || sel.down("claude-main") {
		t.Fatalf("the selection seam maxed claude-main from the carve-out: %+v", sel.bucket)
	}
	if got := len(sel.accountUsage[key]); got != 2 {
		t.Fatalf("selected per-account rows = %d, want both reported windows: %+v", got, sel.accountUsage[key])
	}
	// The control: a tier the registry DOES declare still constrains its own
	// bucket, so the skip is scoped to unrecognised tiers rather than to tiers.
	spark := availability{
		ok: true, accountsOK: true,
		bucket: map[string]string{}, reset: map[string]int64{},
		accounts: map[string][]account{
			"openai-codex": {{Provider: "openai-codex", IdentityKey: "codex"}},
		},
		accountUsage: map[accountKey][]usageWin{
			{Provider: "openai-codex", IdentityKey: "codex"}: {
				{label: "5 hours (Spark)", id: "5h", tier: "spark", pct: 100, secs: 60, dur: 5 * 3600, prov: "openai-codex"},
			},
		},
	}
	if got := selectedAvailability(spark, nil); !got.down("codex-spark") || got.down("codex-main") {
		t.Fatalf("a declared tier must max exactly its own bucket: %+v", got.bucket)
	}
}

func TestDeepSeekOffPeakWindow(t *testing.T) {
	dsPool := poolOf(deepseekProvider)
	for _, tc := range []struct {
		hhmm string
		want bool
	}{
		{"16:29", false}, {"16:30", true}, {"23:59", true},
		{"00:00", true}, {"00:29", true}, {"00:30", false}, {"12:00", false},
	} {
		ts, _ := time.Parse("15:04", tc.hhmm)
		mult := poolOffPeak(dsPool, ts)
		if got := mult < 1; got != tc.want {
			t.Errorf("poolOffPeak(%s, %s) = %v, want discounted=%v", dsPool, tc.hhmm, mult, tc.want)
		}
		if other := poolOffPeak(poolOf(anthropicProvider), ts); other != 1 {
			t.Errorf("a pool with no declared window was discounted at %s: %v", tc.hhmm, other)
		}
	}


}

func TestLaneOrderForPoolsPoolCounts(t *testing.T) {
	if got := laneOrderForPools(nil); got != nil {
		t.Errorf("no pools = %v, want nil", got)
	}
	if got, want := laneOrderForPools([]string{"A"}), []string{"claude-only", "claude-led"}; !slices.Equal(got, want) {
		t.Errorf("one pool = %v, want %v — nothing to blend with", got, want)
	}
	if got := laneOrderForPools([]string{"A", "O"}); len(got) != 5 || got[2] != "mixed" {
		t.Errorf("two pools = %v, want the classic five with mixed in the middle", got)
	}
	if got := laneOrderForPools([]string{"A", "O", "D"}); len(got) != 7 {
		t.Errorf("three pools = %v, want the five plus the optional pool's pair", got)
	}
}
