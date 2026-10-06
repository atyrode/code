/*
 * The panel's keys as decisions over plain facts, so the rules read and test apart from the DOM.
 * They are panel-local: the listener sits on the panel root, so a key pressed in another plugin
 * never reaches them, and a key they consume is not left to another plugin's global binding. Inside
 * the panel they belong to the shown view alone: a sheet, a dialog or an open popover owns its own
 * keys, and a control nearer the target that handled a key (a row's arrows, a switch's Space) has
 * the last word. A generator row's own keys (←→, ↑↓, Home, End, Space) are the row's (dial-row.tsx).
 */

/** What the stage shows: the generator with routing and usage, a pane alone (narrow), the accounts, their management (`manage`, under the accounts) or the sessions. */
export type PanelView = "main" | "routing" | "usage" | "accounts" | "manage" | "sessions";
/** The sheets that open over the stage. */
export type PanelSheet = "models" | "setup" | "options";

export type PanelKey = {
  readonly key: string;
  /** Ctrl or Cmd: the platform's `Mod`. */
  readonly mod: boolean;
  readonly alt: boolean;
  readonly repeat: boolean;
  /** Something nearer the target already handled the key. */
  readonly defaultPrevented: boolean;
  /** The target is in the shown stage or key line, or is the panel root; false behind a sheet. */
  readonly inView: boolean;
  /** The target edits text, where bare keys are typing. */
  readonly inField: boolean;
  /** The target is inside a dialog or an open popover, which owns its keys. */
  readonly inDialog: boolean;
  /** The target answers ↵ itself: a button, a link, a cue. */
  readonly onControl: boolean;
  /** Nothing in the stage has focus: the panel root, which has focus when the panel opens. */
  readonly onRoot: boolean;
  readonly view: PanelView;
  /** The panel is too narrow for routing and usage beside the generator; they open as views of their own. */
  readonly narrow: boolean;
  /** How many recent profiles the digits can recall, in the sessions view. */
  readonly recents: number;
};

export type PanelAction =
  | { readonly kind: "launch" }
  | { readonly kind: "defaults" }
  | { readonly kind: "saved" }
  | { readonly kind: "chains" }
  /** Hide or show a pane beside the generator. */
  | { readonly kind: "toggle"; readonly pane: "routing" | "usage" }
  /** Show a view; `main` goes back. */
  | { readonly kind: "view"; readonly view: PanelView }
  | { readonly kind: "back" }
  | { readonly kind: "refresh" }
  /** Show the keyboard shortcuts. */
  | { readonly kind: "shortcuts" }
  | { readonly kind: "sheet"; readonly sheet: PanelSheet }
  | { readonly kind: "recall"; readonly index: number }
  /** Open the machine picker beside the launch. */
  | { readonly kind: "machine" }
  /** An arrow on arrival: focus moves into the view without changing anything. */
  | { readonly kind: "enter" };

const SHEET_KEYS: Readonly<Record<string, PanelSheet>> = { u: "setup", o: "options" };

/**
 * What a key press means, or null when the panel leaves it alone. Mod+↵ takes the launch's step in
 * the main view; a plain ↵ does too unless a control has focus, which answers it itself. Neither
 * acts on key repeat, so holding them cannot take one step after another. Letters act outside text:
 * `a` and `e` open the accounts and the sessions or come back; `p` and `s` hide routing and usage
 * beside the generator, or open them as views when narrow; `d`, `z`, `f` and `w` (the machine) act
 * in the main view; `m`, `u` and `o` open Models, Setup and the session options from the main view,
 * and `m` the accounts' management from the accounts; `r` reads again and `?` shows every key.
 * Digits recall a recent profile where the sessions view lists them. Esc goes back: from the
 * accounts' management to the accounts, from anything else to the main view; at rest in the main
 * view it is left alone. Every one of these is also a control on the panel; keys only speed them up.
 */
export function panelKey(press: PanelKey): PanelAction | null {
  if (!press.inView || press.defaultPrevented || press.inDialog || press.alt) return null;
  const main = press.view === "main";
  if (press.key === "Enter") {
    if (press.repeat || !main) return null;
    return press.mod || (!press.onControl && !press.inField) ? { kind: "launch" } : null;
  }
  if (press.mod || press.inField) return null;
  if (press.key === "Escape") return press.view === "manage" ? { kind: "view", view: "accounts" } : !main ? { kind: "back" } : null;
  if (press.onRoot && press.key.startsWith("Arrow")) return { kind: "enter" };
  if (press.repeat) return null;
  switch (press.key) {
    case "a": return { kind: "view", view: press.view === "accounts" || press.view === "manage" ? "main" : "accounts" };
    case "e": return { kind: "view", view: press.view === "sessions" ? "main" : "sessions" };
    case "p": return press.narrow ? { kind: "view", view: press.view === "routing" ? "main" : "routing" } : main ? { kind: "toggle", pane: "routing" } : null;
    case "s": return press.narrow ? { kind: "view", view: press.view === "usage" ? "main" : "usage" } : main ? { kind: "toggle", pane: "usage" } : null;
    case "d": return main ? { kind: "defaults" } : null;
    case "z": return main ? { kind: "saved" } : null;
    case "f": return main || press.view === "routing" ? { kind: "chains" } : null;
    case "w": return main ? { kind: "machine" } : null;
    case "m": return main ? { kind: "sheet", sheet: "models" } : press.view === "accounts" ? { kind: "view", view: "manage" } : null;
    case "r": return { kind: "refresh" };
    case "?": return { kind: "shortcuts" };
  }
  const sheet = SHEET_KEYS[press.key];
  if (sheet) return main ? { kind: "sheet", sheet } : null;
  if (/^[1-9]$/.test(press.key) && press.view === "sessions") {
    const index = Number(press.key) - 1;
    return index < press.recents ? { kind: "recall", index } : null;
  }
  return null;
}
