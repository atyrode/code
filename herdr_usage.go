package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	herdrUsageDefaultInterval = 300 * time.Second
	herdrUsageTTLMillis       = 720000
	herdrUsageMaxRows         = 24
)

const herdrUsageHelp = `usage: code herdr-usage [--once] [--interval <seconds>]

Publish auth-broker usage bars to every active herdr session.

  --once                publish one cycle and exit
  --interval <seconds>  seconds between cycles (default 300, with ±10% jitter)
`

var herdrUsageProviderOrder = [...]string{"openai-codex", "anthropic"}

var herdrUsageWindowOrder = [...]string{"5h", "7d", "5h fa", "7d fa", "5h sp", "7d sp"}

type herdrUsageSpan struct {
	Text  string `json:"text"`
	Color string `json:"color,omitempty"`
	Bold  bool   `json:"bold,omitempty"`
	Dim   bool   `json:"dim,omitempty"`
}

type herdrUsageBar struct {
	Fraction    float64          `json:"fraction"`
	Title       string           `json:"title"`
	TitleSpans  []herdrUsageSpan `json:"title_spans"`
	TitleColor  string           `json:"title_color"`
	Label       string           `json:"label"`
	LabelSpans  []herdrUsageSpan `json:"label_spans,omitempty"`
	MatchValues []string         `json:"match_values,omitempty"`
	Fill        string           `json:"fill"`
	Empty       string           `json:"empty"`
}

type herdrUsageRow struct {
	Bar   *herdrUsageBar `json:"bar,omitempty"`
	Spans *[]any         `json:"spans,omitempty"`
}

type herdrUsageCredential struct {
	Provider    string `json:"provider"`
	IdentityKey string `json:"identityKey"`
	Credential  struct {
		Email string `json:"email"`
	} `json:"credential"`
}

type herdrUsageLimit struct {
	ID    string `json:"id"`
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
		ResetsAt   *int64 `json:"resetsAt"`
		DurationMs int64  `json:"durationMs"`
	} `json:"window"`
}

type herdrUsageWindow struct {
	Fraction   float64
	ResetsAt   *int64
	DurationMs int64
	Countdown  string
}

type herdrUsageAccount struct {
	Provider    string
	IdentityKey string
	Email       string
	VaultLabel  string
	Name        string
	BrokerURLs  []string
	Windows     map[string]herdrUsageWindow
}

type herdrUsageCycleResult struct {
	Rows      int
	Attempts  int
	Successes int
}

func (r herdrUsageCycleResult) allPublishesFailed() bool {
	return r.Rows > 0 && r.Attempts > 0 && r.Successes == 0
}

func defaultHerdrSessionsDir() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		if home, err := os.UserHomeDir(); err == nil {
			base = filepath.Join(home, ".config")
		}
	}
	return filepath.Join(base, "herdr", "sessions")
}

func parseHerdrUsageInterval(raw string) (time.Duration, error) {
	seconds, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds <= 0 {
		return 0, fmt.Errorf("interval must be a positive number of seconds")
	}
	interval := time.Duration(seconds * float64(time.Second))
	if interval <= 0 {
		return 0, fmt.Errorf("interval must be a positive number of seconds")
	}
	return interval, nil
}

func jitterHerdrUsageInterval(interval time.Duration) time.Duration {
	return time.Duration(float64(interval) * (0.9 + rand.Float64()*0.2))
}

func runHerdrUsage(args []string) int {
	once := false
	interval := herdrUsageDefaultInterval
	for i := 0; i < len(args); i++ {
		switch {
		case args[i] == "--once":
			once = true
		case args[i] == "--interval":
			i++
			if i >= len(args) {
				fmt.Fprintln(os.Stderr, "code herdr-usage: --interval needs seconds")
				return 2
			}
			var err error
			interval, err = parseHerdrUsageInterval(args[i])
			if err != nil {
				fmt.Fprintf(os.Stderr, "code herdr-usage: --interval: %v\n", err)
				return 2
			}
		case strings.HasPrefix(args[i], "--interval="):
			var err error
			interval, err = parseHerdrUsageInterval(strings.TrimPrefix(args[i], "--interval="))
			if err != nil {
				fmt.Fprintf(os.Stderr, "code herdr-usage: --interval: %v\n", err)
				return 2
			}
		case args[i] == "-h" || args[i] == "--help":
			fmt.Print(herdrUsageHelp)
			return 0
		default:
			fmt.Fprintf(os.Stderr, "code herdr-usage: unknown flag %q\n%s", args[i], herdrUsageHelp)
			return 2
		}
	}

	sessionsDir := defaultHerdrSessionsDir()
	if override := os.Getenv("HERDR_SESSIONS_DIR"); override != "" {
		sessionsDir = override
	}
	for {
		result := runHerdrUsageCycle(time.Now(), sessionsDir, os.Stderr)
		if result.allPublishesFailed() {
			return 1
		}
		if once {
			return 0
		}
		time.Sleep(jitterHerdrUsageInterval(interval))
	}
}

func runHerdrUsageCycle(now time.Time, sessionsDir string, stderr io.Writer) herdrUsageCycleResult {
	vaults, _ := resolveVaults(os.Getenv("CODE_AUTH_VAULTS"), os.Getenv("CODE_AUTH_VAULTS_FILE"))
	_, disabled := loadVaultState(vaults, os.Getenv("CODE_AUTH_STATE"))
	rows := collectHerdrUsageRows(vaults, disabled, now, stderr)
	result := herdrUsageCycleResult{Rows: len(rows)}
	if len(rows) == 0 {
		return result
	}

	sockets, err := filepath.Glob(filepath.Join(sessionsDir, "*", "herdr.sock"))
	if err != nil {
		fmt.Fprintf(stderr, "code herdr-usage: discover sessions: %v\n", err)
		return result
	}
	// The default session's socket lives beside the sessions directory
	// (~/.config/herdr/herdr.sock), not inside it.
	rootSocket := filepath.Join(filepath.Dir(sessionsDir), "herdr.sock")
	if info, err := os.Stat(rootSocket); err == nil && info.Mode()&os.ModeSocket != 0 {
		sockets = append(sockets, rootSocket)
	}
	params := struct {
		SectionID string          `json:"section_id"`
		Source    string          `json:"source"`
		Seq       int64           `json:"seq"`
		TTLMillis int             `json:"ttl_ms"`
		Rows      []herdrUsageRow `json:"rows"`
	}{
		SectionID: "usage",
		Source:    "atyrode:usage",
		Seq:       now.UnixMilli(),
		TTLMillis: herdrUsageTTLMillis,
		Rows:      rows,
	}
	for _, socketPath := range sockets {
		result.Attempts++
		if err := herdrRequest(socketPath, "sidebar.report_section", params); err != nil {
			fmt.Fprintf(stderr, "code herdr-usage: publish %s: %v\n", socketPath, err)
			continue
		}
		result.Successes++
	}
	return result
}

func collectHerdrUsageRows(vaults []vault, disabled map[string]bool, now time.Time, stderr io.Writer) []herdrUsageRow {
	accounts := map[string][]*herdrUsageAccount{
		"anthropic":    {},
		"openai-codex": {},
	}
	byIdentity := map[string]*herdrUsageAccount{}
	maxCountdownWidth := 0

	for _, v := range vaults {
		if disabled[v.ID] || v.BrokerURL == "" || v.TokenFile == "" {
			continue
		}
		snapshotBody, snapshotErr := fetchVaultEndpoint(v, "/v1/snapshot")
		usageBody, usageErr := fetchVaultEndpoint(v, "/v1/usage")
		if snapshotErr != nil {
			fmt.Fprintf(stderr, "code herdr-usage: vault %s snapshot: %v\n", v.ID, snapshotErr)
		}
		if usageErr != nil {
			fmt.Fprintf(stderr, "code herdr-usage: vault %s usage: %v\n", v.ID, usageErr)
		}
		if snapshotErr != nil {
			continue
		}

		var snapshot struct {
			Credentials []herdrUsageCredential `json:"credentials"`
		}
		if err := json.Unmarshal(snapshotBody, &snapshot); err != nil {
			fmt.Fprintf(stderr, "code herdr-usage: vault %s snapshot: %v\n", v.ID, err)
			continue
		}
		reports := map[string][]herdrUsageLimit{}
		if usageErr == nil {
			var usage struct {
				Reports []struct {
					Provider string            `json:"provider"`
					Limits   []herdrUsageLimit `json:"limits"`
				} `json:"reports"`
			}
			if err := json.Unmarshal(usageBody, &usage); err != nil {
				fmt.Fprintf(stderr, "code herdr-usage: vault %s usage: %v\n", v.ID, err)
			} else {
				for _, report := range usage.Reports {
					reports[report.Provider] = append(reports[report.Provider], report.Limits...)
				}
			}
		}

		for _, credential := range snapshot.Credentials {
			if credential.Provider != "anthropic" && credential.Provider != "openai-codex" {
				continue
			}
			key := credential.Provider + "\x00" + credential.IdentityKey
			account := byIdentity[key]
			if account == nil {
				account = &herdrUsageAccount{
					Provider:    credential.Provider,
					IdentityKey: credential.IdentityKey,
					Email:       credential.Credential.Email,
					VaultLabel:  v.Label,
					BrokerURLs:  nil,
					Windows:     map[string]herdrUsageWindow{},
				}
				byIdentity[key] = account
				accounts[credential.Provider] = append(accounts[credential.Provider], account)
			} else if account.Email == "" && credential.Credential.Email != "" {
				account.Email = credential.Credential.Email
			}
			if !slices.Contains(account.BrokerURLs, v.BrokerURL) {
				account.BrokerURLs = append(account.BrokerURLs, v.BrokerURL)
			}
			for _, limit := range reports[credential.Provider] {
				token, ok := herdrUsageWindowToken(limit)
				if !ok || limit.Amount.UsedFraction == nil {
					continue
				}
				if _, exists := account.Windows[token]; exists {
					continue
				}
				window := herdrUsageWindow{
					Fraction:   *limit.Amount.UsedFraction,
					ResetsAt:   limit.Window.ResetsAt,
					DurationMs: limit.Window.DurationMs,
				}
				if window.ResetsAt != nil {
					window.Countdown = herdrUsageCountdown(*window.ResetsAt, now)
					maxCountdownWidth = max(maxCountdownWidth, len(window.Countdown))
				}
				account.Windows[token] = window
			}
		}
	}

	// Collision tags are scoped per provider: the operator's visual contract
	// is two letters + `*` with provider color carrying the Claude/Codex
	// distinction, so the same person's accounts may share a tag across
	// providers while same-provider neighbors widen to three letters.
	for _, provider := range herdrUsageProviderOrder {
		namePrefixes := map[string]int{}
		for _, account := range accounts[provider] {
			namePrefixes[firstRunes(herdrUsageNameSource(account), 2)]++
		}
		for _, account := range accounts[provider] {
			source := herdrUsageNameSource(account)
			if namePrefixes[firstRunes(source, 2)] > 1 {
				account.Name = firstRunes(source, 3)
			} else {
				account.Name = firstRunes(source, 2) + "*"
			}
		}
	}

	rows := make([]herdrUsageRow, 0)
	for _, provider := range herdrUsageProviderOrder {
		for _, account := range accounts[provider] {
			group := herdrUsageAccountRows(account, maxCountdownWidth, now)
			if len(group) == 0 {
				continue
			}
			if len(rows) > 0 {
				empty := []any{}
				rows = append(rows, herdrUsageRow{Spans: &empty})
			}
			rows = append(rows, group...)
		}
	}
	if len(rows) > herdrUsageMaxRows {
		fmt.Fprintf(stderr, "code herdr-usage: usage rows truncated from %d to %d\n", len(rows), herdrUsageMaxRows)
		rows = rows[:herdrUsageMaxRows]
	}
	return rows
}

func herdrUsageNameSource(account *herdrUsageAccount) string {
	if email := strings.TrimSpace(account.Email); email != "" {
		local, _, _ := strings.Cut(email, "@")
		if local = strings.ToLower(strings.TrimSpace(local)); local != "" {
			return local
		}
	}
	return strings.ToLower(strings.TrimSpace(account.VaultLabel))
}

func firstRunes(value string, count int) string {
	if utf8.RuneCountInString(value) <= count {
		return value
	}
	runes := []rune(value)
	return string(runes[:count])
}

func herdrUsageWindowToken(limit herdrUsageLimit) (string, bool) {
	kindText := strings.ToLower(limit.Scope.Tier + " " + limit.Label)
	kind := "core"
	if strings.Contains(kindText, "fable") {
		kind = "fable"
	} else if strings.Contains(kindText, "spark") {
		kind = "spark"
	}

	bucket := ""
	for _, marker := range []string{limit.Window.ID, limit.Scope.WindowID, limit.ID} {
		if bucket = herdrUsageBucketMarker(marker); bucket != "" {
			break
		}
	}
	if bucket == "" {
		switch limit.Window.DurationMs {
		case 18000000:
			bucket = "5h"
		case 604800000:
			bucket = "7d"
		}
	}
	if bucket == "" {
		bucket = herdrUsageBucketMarker(limit.Label)
	}
	if bucket == "" {
		return "", false
	}

	switch kind {
	case "fable":
		return bucket + " fa", true
	case "spark":
		return bucket + " sp", true
	default:
		return bucket, true
	}
}

func herdrUsageBucketMarker(value string) string {
	value = strings.ToLower(value)
	if strings.Contains(value, "5h") || strings.Contains(value, "5 hour") || strings.Contains(value, "5-hour") {
		return "5h"
	}
	if strings.Contains(value, "7d") || strings.Contains(value, "7 day") || strings.Contains(value, "7-day") {
		return "7d"
	}
	return ""
}

func herdrUsageAccountRows(account *herdrUsageAccount, maxCountdownWidth int, now time.Time) []herdrUsageRow {
	rows := make([]herdrUsageRow, 0, len(account.Windows))
	for _, token := range herdrUsageWindowOrder {
		window, ok := account.Windows[token]
		if !ok {
			continue
		}
		fraction := window.Fraction
		if fraction < 0 {
			fraction = 0
		} else if fraction > 1 {
			fraction = 1
		}
		pct := int(math.Floor(fraction*100 + 0.5))
		var label string
		labelSpans := []herdrUsageSpan{{Text: fmt.Sprintf("%3d%%", pct), Color: "subtext0"}}
		switch {
		case window.ResetsAt != nil:
			label = fmt.Sprintf("%3d%% \u21bb %*s", pct, maxCountdownWidth, window.Countdown)
			resetText := fmt.Sprintf(" \u21bb %*s", maxCountdownWidth, window.Countdown)
			labelSpans = append(labelSpans, herdrUsageResetSpan(resetText, window, now))
		case maxCountdownWidth > 0:
			// " \u21bb " occupies three terminal cells: the reset-bearing and
			// absent-reset labels therefore have identical display widths.
			label = fmt.Sprintf("%3d%%%s", pct, strings.Repeat(" ", 3+maxCountdownWidth))
			labelSpans[0].Text = label
		default:
			label = fmt.Sprintf("%3d%%", pct)
			labelSpans[0].Text = label
		}
		color := "#ff9f52"
		if account.Provider == "openai-codex" {
			color = "#62a7ff"
		}
		accountTitle := account.Name + " "
		rows = append(rows, herdrUsageRow{Bar: &herdrUsageBar{
			Fraction: fraction,
			Title:    accountTitle + token,
			TitleSpans: []herdrUsageSpan{
				{Text: accountTitle, Color: color, Dim: true},
				{Text: token, Color: color},
			},
			TitleColor:  color,
			Label:       label,
			LabelSpans:  labelSpans,
			MatchValues: account.BrokerURLs,
			Fill:        herdrUsageFill(pct),
			Empty:       "#78829b",
		}})
	}
	return rows
}

func herdrUsageResetSpan(text string, window herdrUsageWindow, now time.Time) herdrUsageSpan {
	span := herdrUsageSpan{Text: text, Color: "#78829b", Dim: true}
	if window.DurationMs <= 0 || window.ResetsAt == nil {
		return span
	}
	remaining := *window.ResetsAt - now.UnixMilli()
	if remaining*10 < window.DurationMs {
		span.Color = "#c8d0dc"
		span.Bold = true
		span.Dim = false
	} else if remaining*4 < window.DurationMs {
		span.Color = "#c8d0dc"
		span.Dim = false
	}
	return span
}

func herdrUsageCountdown(resetsAtMillis int64, now time.Time) string {
	remaining := resetsAtMillis - now.UnixMilli()
	if remaining < 0 {
		remaining = 0
	}
	totalMinutes := remaining / int64(time.Minute/time.Millisecond)
	if totalMinutes < 60 {
		return fmt.Sprintf("%dm", totalMinutes)
	}
	if totalMinutes < 24*60 {
		return fmt.Sprintf("%dh%dm", totalMinutes/60, totalMinutes%60)
	}
	return fmt.Sprintf("%dd%dh", totalMinutes/(24*60), (totalMinutes/60)%24)
}

func herdrUsageFill(pct int) string {
	r, g := 0, 0
	if pct <= 50 {
		r, g = 90+3*pct, 200
	} else {
		r, g = 235, 200-3*(pct-50)
	}
	if r > 235 {
		r = 235
	}
	if g < 60 {
		g = 60
	}
	return fmt.Sprintf("#%02x%02x46", r, g)
}
