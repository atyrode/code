package main

import (
	"regexp"

	clikit "github.com/atyrode/cli-kit"
	"github.com/charmbracelet/lipgloss"
)

// ── palette ──────────────────────────────────────────────────────────────────
// The palette, glyphs, and styles now live in the shared cli-kit; these are
// ergonomic local aliases so the rest of the file reads unchanged. cli-kit is
// the single source both `code` and `atyrode` build on.
const (
	cAcc   = clikit.CAcc
	cBord  = clikit.CBord
	cHead  = clikit.CHead
	cSelBg = clikit.CSelBg
	cGreen = clikit.CGreen
)

const (
	gWarn  = clikit.GWarn
	gReset = clikit.GReset
)

var (
	meterRamp = clikit.MeterRamp

	stDim    = clikit.StDim
	stHead   = clikit.StHead
	stWarn   = clikit.StWarn
	stBrk    = clikit.StBrk
	stStruck = clikit.StStruck

	// stKey renders an inline key cue (r, a, s, p) — visually secondary but
	// readable against the background, per the section-chrome convention.
	stKey  = lipgloss.NewStyle().Foreground(lipgloss.Color(cHead))
	stWtOn = lipgloss.NewStyle().Foreground(lipgloss.Color(cGreen))

	// Title-local hotkey cues (d · defaults, p · hide, s · hide) are quieter
	// than the footer help: terminals have no portable alpha, so these are
	// dedicated pre-blended tokens — CHead/CDim mixed ~40% toward the app's
	// dark backdrop — applied to the whole cue, key included. Pre-blending is
	// used instead of ANSI faint because faint's dimming factor varies wildly
	// across terminals (and would double-dim already-muted text). Footer
	// recovery cues keep the brighter help styles for readability.
	stCueKey = lipgloss.NewStyle().Foreground(lipgloss.Color("#646b76")) // CHead → backdrop
	stCue    = lipgloss.NewStyle().Foreground(lipgloss.Color("#4f5768")) // CDim → backdrop

	// layout + meter primitives now live in cli-kit
	padLeft    = clikit.PadLeft
	pad        = clikit.Pad
	windowList = clikit.WindowList

	// Provider-qualified ids: bare catalog ids today (gpt-…, claude-…) plus
	// slash-scoped ones (local-qwen/qwen3.8-27b). The level
	// suffix with its colon is what keeps prose out; the word boundary keeps
	// "maxed" from reading as a model.
	modelRe = regexp.MustCompile(`([a-z][a-z0-9._/-]*):(minimal|low|medium|high|xhigh|max)\b`)
)
