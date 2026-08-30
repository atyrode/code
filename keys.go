package main

import "github.com/charmbracelet/bubbles/key"

// ── keybindings (drive both input handling and the bubbles/help footer) ───────
type keyMap struct {
	Move, Change, Reset, Depth, Refresh, Manager, Collapse, Usage, Launch, Managed, Untrusted, Worktree, Help, Quit key.Binding
}

// ShortHelp is a static single-line stand-in used only when measuring the
// footer height for mode selection (which would otherwise recurse through the
// state-derived compact help). The rendered compact line comes from
// contextHelp, which derives its bindings from the live model state (atyrode/dotfiles#198).
func (k keyMap) ShortHelp() []key.Binding {
	return []key.Binding{k.Move, k.Change, k.Reset, k.Help, k.Quit}
}
func (k keyMap) FullHelp() [][]key.Binding {
	return [][]key.Binding{
		{k.Move, k.Change, k.Reset},
		{k.Depth, k.Refresh, k.Manager, k.Collapse, k.Usage},
		{k.Launch, k.Managed, k.Untrusted, k.Worktree, k.Help, k.Quit},
	}
}

var keys = keyMap{
	Move:      key.NewBinding(key.WithKeys("up", "down", "j", "k"), key.WithHelp("↑↓", "move")),
	Change:    key.NewBinding(key.WithKeys("left", "right", "h", "l"), key.WithHelp("←→", "change")),
	Reset:     key.NewBinding(key.WithKeys("d"), key.WithHelp("d", gReset+" defaults")),
	Depth:     key.NewBinding(key.WithKeys("f"), key.WithHelp("f", "primary ⇄ full chains")),
	Refresh:   key.NewBinding(key.WithKeys("r"), key.WithHelp("r", "refresh usage")),
	Manager:   key.NewBinding(key.WithKeys("v"), key.WithHelp("v", "manage accounts")),
	Collapse:  key.NewBinding(key.WithKeys("p"), key.WithHelp("p", "show/hide routing")),
	Usage:     key.NewBinding(key.WithKeys("s"), key.WithHelp("s", "show/hide usage")),
	Launch:    key.NewBinding(key.WithKeys("enter"), key.WithHelp("⏎", "launch")),
	Managed:   key.NewBinding(key.WithKeys("m"), key.WithHelp("m", "managed omp")),
	Untrusted: key.NewBinding(key.WithKeys("u"), key.WithHelp("u", "untrusted omp")),
	Worktree:  key.NewBinding(key.WithKeys("w"), key.WithHelp("w", "isolated worktree")),
	Help:      key.NewBinding(key.WithKeys("?"), key.WithHelp("?", "more")),
	Quit:      key.NewBinding(key.WithKeys("q", "esc", "ctrl+c"), key.WithHelp("q", "quit")),
}

// defaultSel returns a fresh copy of the generator's default facet selection —
// used both to seed the model and to restore it via the reset key.
func defaultSel() map[string]string {
	return map[string]string{"lane": "mixed", "model": "smart", "thinking": "medium", "advisor": "glance", "spark": "on", "fable": "off", "main": "off", "fast": "off", "relief": "on"}
}
