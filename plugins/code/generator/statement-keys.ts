import type { KeyHelp } from "./keys-dialog.tsx";
import { STATEMENT_WORDS, type StatementWord } from "./statement-model.ts";

/*
 * The panel's keys as decisions over plain facts, so the rules read and test apart from the DOM.
 * The statement's own keys, the digits that recall the earlier statements' recent teams, and `r`,
 * which reads the accounts and usage again. They are panel-local: the listener sits on the panel
 * root, so a key pressed in another plugin never reaches them, and a key they consume is not left
 * to another plugin's global binding. Inside the panel they belong to the main view alone: a sheet,
 * a dialog, a popover or the panel's layer owns its own keys, and none of these reach the hidden verb.
 */

export type StatementKey = {
  readonly key: string;
  /** Ctrl or Cmd: the platform's `Mod`. */
  readonly mod: boolean;
  readonly alt: boolean;
  readonly repeat: boolean;
  /** Something nearer the target already handled the key. */
  readonly defaultPrevented: boolean;
  /** The target is in the main view while it shows, or is the panel root while it shows; false behind a sheet. */
  readonly inView: boolean;
  /** The target is the panel root itself, which has focus when the panel opens. */
  readonly onRoot: boolean;
  /** The target edits text, where bare keys are typing. */
  readonly inField: boolean;
  /** The target is inside a dialog or popover, which owns its keys. */
  readonly inDialog: boolean;
  /** The word the target is, if it is one. */
  readonly word: StatementWord | null;
  /** The target is the verb. */
  readonly onVerb: boolean;
  /** The word whose drum is open, if one is. */
  readonly open: StatementWord | null;
  /** How many recent teams the digits can recall. */
  readonly recents: number;
};

export type StatementKeyAction =
  | { readonly kind: "verb" }
  | { readonly kind: "keys" }
  | { readonly kind: "refresh" }
  | { readonly kind: "recall"; readonly index: number }
  | { readonly kind: "focus"; readonly to: StatementWord | "verb" }
  | { readonly kind: "step"; readonly word: StatementWord; readonly more: boolean }
  | { readonly kind: "edge"; readonly word: StatementWord; readonly top: boolean }
  | { readonly kind: "cursor"; readonly more: boolean }
  | { readonly kind: "toggle" }
  | { readonly kind: "open"; readonly word: StatementWord }
  | { readonly kind: "close"; readonly word: StatementWord }
  | { readonly kind: "reset"; readonly word: StatementWord }
  | { readonly kind: "escape" };

/**
 * What a key press means, or null when the panel leaves it alone. Nothing acts outside the shown
 * main view, inside a dialog or popover, or once a control nearer the target has handled the key:
 * not Mod+↵, not a digit. Within the view Mod+↵ takes the verb's step, typing included, but never
 * on key repeat, so holding it cannot take one step after another. `?`, `r` and the digits act
 * outside text. On arrival, with the panel root focused, an arrow moves focus to the lane without
 * changing it, and a plain ↵ takes the verb's step as Mod+↵ does. ←/→ walk the verb and the words in
 * reading order; on a word ↑/↓ change its value (up is more), Home/End jump to the ends, Enter or
 * Space open and close its drum, Backspace returns it to the last launch, and Esc closes the drum
 * without undoing anything. On the extras word ↑/↓ move through the switches of its open list and
 * Space turns the one under the cursor.
 */
export function statementKey(press: StatementKey): StatementKeyAction | null {
  if (!press.inView || press.defaultPrevented || press.inDialog || press.alt) return null;
  if (press.key === "Enter" && (press.mod || press.onRoot)) return press.repeat ? null : { kind: "verb" };
  if (press.mod) return null;
  if (press.key === "Escape") return press.open ? { kind: "close", word: press.open } : { kind: "escape" };
  if (press.inField) return null;
  if (press.key === "?") return press.repeat ? null : { kind: "keys" };
  if (press.key === "r") return press.repeat ? null : { kind: "refresh" };
  if (/^[1-9]$/.test(press.key)) {
    const index = Number(press.key) - 1;
    return index < press.recents && !press.repeat ? { kind: "recall", index } : null;
  }
  const arrow = press.key === "ArrowLeft" || press.key === "ArrowRight" || press.key === "ArrowUp" || press.key === "ArrowDown";
  if (press.onRoot) return arrow ? { kind: "focus", to: "lane" } : null;
  const order: readonly (StatementWord | "verb")[] = ["verb", ...STATEMENT_WORDS];
  if ((press.key === "ArrowLeft" || press.key === "ArrowRight") && (press.onVerb || press.word)) {
    const at = order.indexOf(press.onVerb ? "verb" : press.word!);
    const to = order[at + (press.key === "ArrowLeft" ? -1 : 1)];
    return to ? { kind: "focus", to } : null;
  }
  const word = press.word;
  if (!word) return null;
  const open = press.open === word;
  const up = press.key === "ArrowUp";
  if (word === "extras") {
    if (up || press.key === "ArrowDown") return open ? { kind: "cursor", more: up } : { kind: "open", word };
    if (press.key === " ") return press.repeat ? null : open ? { kind: "toggle" } : { kind: "open", word };
  } else {
    if (up || press.key === "ArrowDown") return { kind: "step", word, more: up };
    if (press.key === "Home" || press.key === "End") return { kind: "edge", word, top: press.key === "Home" };
    if (press.key === " " && !press.repeat) return open ? { kind: "close", word } : { kind: "open", word };
  }
  if (press.key === "Enter" && !press.repeat) return open ? { kind: "close", word } : { kind: "open", word };
  if (press.key === "Backspace" && !press.repeat) return { kind: "reset", word };
  return null;
}

/** The statement's keys as the dialog lists them, in its words; `Mod+↵` is drawn as this keyboard labels it. */
export const STATEMENT_KEY_HELP: readonly KeyHelp[] = [
  { keys: ["←", "→"], text: "Move between the verb and the words" },
  { keys: ["↑", "↓"], text: "Change the word; up is more" },
  { keys: ["Home", "End"], text: "The word's most or least" },
  { keys: ["↵", "Space"], text: "Open or close the word's options" },
  { keys: ["Space"], text: "In extras: turn the switch under the cursor" },
  { keys: ["Esc"], text: "Close the options; nothing is undone" },
  { keys: ["⌫"], text: "Return the word to the last launch" },
  { keys: ["Mod+↵"], text: "Take the verb's step" },
  { keys: ["↵"], text: "On arrival, before a word has focus: take the verb's step" },
];
