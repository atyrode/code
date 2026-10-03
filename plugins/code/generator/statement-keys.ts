import type { KeyHelp } from "./keys-dialog.tsx";
import { STATEMENT_WORDS, type StatementWord } from "./statement-model.ts";

/*
 * The panel's keys as decisions over plain facts, so the rules read and test apart from the DOM.
 * The statement's own keys, the digits that recall the earlier statements' recent profiles, and
 * `r`, which reads the accounts and usage again. They are panel-local: the listener sits on the
 * panel root, so a key pressed in another plugin never reaches them, and a key they consume is not
 * left to another plugin's global binding. Inside the panel they belong to the main view alone: a
 * sheet, a dialog, a popover or the panel's layer owns its own keys, and none of these reach the
 * hidden verb.
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
  /** The setting the target is a value of, if it is one. */
  readonly word: StatementWord | null;
  /** The target is the verb. */
  readonly onVerb: boolean;
  /** How many recent profiles the digits can recall. */
  readonly recents: number;
};

export type StatementKeyAction =
  | { readonly kind: "verb" }
  | { readonly kind: "keys" }
  | { readonly kind: "refresh" }
  | { readonly kind: "recall"; readonly index: number }
  | { readonly kind: "focus"; readonly to: StatementWord | "verb" }
  | { readonly kind: "step"; readonly word: StatementWord; readonly forward: boolean }
  | { readonly kind: "edge"; readonly word: StatementWord; readonly last: boolean }
  | { readonly kind: "cursor"; readonly forward: boolean }
  | { readonly kind: "cursor-edge"; readonly last: boolean }
  | { readonly kind: "toggle" }
  | { readonly kind: "reset"; readonly word: StatementWord }
  | { readonly kind: "escape" };

/** The order ↑ and ↓ walk: the settings in reading order, then the verb that concludes them. */
const ORDER: readonly (StatementWord | "verb")[] = [...STATEMENT_WORDS, "verb"];

/**
 * What a key press means, or null when the panel leaves it alone. Nothing acts outside the shown
 * main view, inside a dialog or popover, or once a control nearer the target has handled the key:
 * not Mod+↵, not a digit. Within the view Mod+↵ takes the verb's step, typing included, but never
 * on key repeat, so holding it cannot take one step after another. `?`, `r` and the digits act
 * outside text. On arrival, with the panel root focused, an arrow moves focus to the lane without
 * changing it, and a plain ↵ takes the verb's step as Mod+↵ does. ↑/↓ move between the settings in
 * reading order and on to the verb, whatever the layout. On a setting ←/→ change its value one step
 * (values run low to high, left to right), Home/End go to its ends and Backspace returns it to the
 * last launch. On extras ←/→ and Home/End move between the switches instead, and Space or ↵ turns
 * the one with focus. Esc lets go of what is pointed without undoing anything.
 */
export function statementKey(press: StatementKey): StatementKeyAction | null {
  if (!press.inView || press.defaultPrevented || press.inDialog || press.alt) return null;
  if (press.key === "Enter" && (press.mod || press.onRoot)) return press.repeat ? null : { kind: "verb" };
  if (press.mod) return null;
  if (press.key === "Escape") return { kind: "escape" };
  if (press.inField) return null;
  if (press.key === "?") return press.repeat ? null : { kind: "keys" };
  if (press.key === "r") return press.repeat ? null : { kind: "refresh" };
  if (/^[1-9]$/.test(press.key)) {
    const index = Number(press.key) - 1;
    return index < press.recents && !press.repeat ? { kind: "recall", index } : null;
  }
  const horizontal = press.key === "ArrowLeft" || press.key === "ArrowRight";
  const vertical = press.key === "ArrowUp" || press.key === "ArrowDown";
  if (press.onRoot) return horizontal || vertical ? { kind: "focus", to: "lane" } : null;
  if (vertical && (press.onVerb || press.word)) {
    const at = ORDER.indexOf(press.onVerb ? "verb" : press.word!);
    const to = ORDER[at + (press.key === "ArrowUp" ? -1 : 1)];
    return to ? { kind: "focus", to } : null;
  }
  const word = press.word;
  if (!word) return null;
  const forward = press.key === "ArrowRight";
  const edge = press.key === "Home" || press.key === "End";
  if (word === "extras") {
    if (horizontal) return { kind: "cursor", forward };
    if (edge) return { kind: "cursor-edge", last: press.key === "End" };
    if (press.key === " " || press.key === "Enter") return press.repeat ? null : { kind: "toggle" };
  } else {
    if (horizontal) return { kind: "step", word, forward };
    if (edge) return { kind: "edge", word, last: press.key === "End" };
  }
  if (press.key === "Backspace" && !press.repeat) return { kind: "reset", word };
  return null;
}

/** The statement's keys as the dialog lists them, in its words; `Mod+↵` is drawn as this keyboard labels it. */
export const STATEMENT_KEY_HELP: readonly KeyHelp[] = [
  { keys: ["↑", "↓"], text: "Move between the settings and the verb" },
  { keys: ["←", "→"], text: "Change the setting one step; right is higher" },
  { keys: ["Home", "End"], text: "The setting's lowest or highest" },
  { keys: ["Space"], text: "In extras: turn the focused switch on or off" },
  { keys: ["⌫"], text: "Return the setting to the last launch" },
  { keys: ["Esc"], text: "Let go of what is pointed; nothing is undone" },
  { keys: ["Mod+↵"], text: "Take the verb's step" },
  { keys: ["↵"], text: "On arrival, before a setting has focus: take the verb's step" },
];
