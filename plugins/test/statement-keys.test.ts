import { describe, expect, test } from "bun:test";
import { statementKey, type StatementKey } from "../code/generator/statement-keys.ts";

/** A key pressed on a thinking value in the shown main view, with three recent profiles; each test changes only what it is about. */
function press(key: string, changes: Partial<StatementKey> = {}): StatementKey {
  return { key, mod: false, alt: false, repeat: false, defaultPrevented: false, inView: true, onRoot: false, inField: false, inDialog: false,
    word: "thinking", onVerb: false, recents: 3, ...changes };
}

describe("where the panel's keys act", () => {
  test("nothing acts behind a sheet, inside a dialog or popover, or once another control handled the key: not Mod+↵, not a digit", () => {
    for (const changes of [{ inView: false }, { inDialog: true }, { defaultPrevented: true }] as const) {
      expect(statementKey(press("Enter", { mod: true, ...changes }))).toBeNull();
      expect(statementKey(press("1", { word: null, ...changes }))).toBeNull();
      expect(statementKey(press("ArrowRight", changes))).toBeNull();
    }
    // The panel root focused while a sheet covers the main view is not the view either.
    expect(statementKey(press("Enter", { onRoot: true, inView: false, word: null }))).toBeNull();
  });

  test("a key held with Alt is left alone", () => {
    expect(statementKey(press("ArrowRight", { alt: true }))).toBeNull();
    expect(statementKey(press("Enter", { mod: true, alt: true }))).toBeNull();
  });
});

describe("the verb, the keys dialog and recent profiles", () => {
  test("Mod+↵ takes the verb's step from anywhere in the main view, typing included, but never on key repeat", () => {
    expect(statementKey(press("Enter", { mod: true }))).toEqual({ kind: "verb" });
    expect(statementKey(press("Enter", { mod: true, inField: true, word: null }))).toEqual({ kind: "verb" });
    expect(statementKey(press("Enter", { mod: true, repeat: true }))).toBeNull();
  });

  test("digits recall only the profiles there are; digits, ? and r never act while typing", () => {
    expect(statementKey(press("3", { word: null }))).toEqual({ kind: "recall", index: 2 });
    expect(statementKey(press("4", { word: null }))).toBeNull();
    expect(statementKey(press("1", { inField: true }))).toBeNull();
    expect(statementKey(press("?", { word: null }))).toEqual({ kind: "keys" });
    expect(statementKey(press("r", { word: null }))).toEqual({ kind: "refresh" });
    expect(statementKey(press("r", { inField: true }))).toBeNull();
    expect(statementKey(press("r", { repeat: true }))).toBeNull();
  });
});

describe("on arrival, with the panel root focused", () => {
  const root = (key: string, changes: Partial<StatementKey> = {}) => press(key, { onRoot: true, word: null, ...changes });

  test("every arrow moves focus to the lane and changes nothing", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) expect(statementKey(root(key))).toEqual({ kind: "focus", to: "lane" });
    expect(statementKey(root("Home"))).toBeNull();
    expect(statementKey(root("Backspace"))).toBeNull();
  });

  test("a plain ↵ takes the verb's step as Mod+↵ does, once per press; elsewhere a plain ↵ never does", () => {
    expect(statementKey(root("Enter"))).toEqual({ kind: "verb" });
    expect(statementKey(root("Enter", { repeat: true }))).toBeNull();
    expect(statementKey(press("Enter", { word: null }))).toBeNull();
    expect(statementKey(press("Enter"))).toBeNull();
  });
});

describe("moving between settings and changing them", () => {
  test("↑/↓ walk the settings in reading order on to the verb, and stop at the ends", () => {
    expect(statementKey(press("ArrowDown"))).toEqual({ kind: "focus", to: "advisor" });
    expect(statementKey(press("ArrowUp", { word: "tier" }))).toEqual({ kind: "focus", to: "lane" });
    expect(statementKey(press("ArrowDown", { word: "machine" }))).toEqual({ kind: "focus", to: "verb" });
    expect(statementKey(press("ArrowUp", { word: null, onVerb: true }))).toEqual({ kind: "focus", to: "machine" });
    expect(statementKey(press("ArrowUp", { word: "lane" }))).toBeNull();
    expect(statementKey(press("ArrowDown", { word: null, onVerb: true }))).toBeNull();
    expect(statementKey(press("ArrowRight", { word: null, onVerb: true }))).toBeNull();
  });

  test("→ is one step higher and ← one step lower, key repeat included; Home and End reach the ends", () => {
    expect(statementKey(press("ArrowRight"))).toEqual({ kind: "step", word: "thinking", forward: true });
    expect(statementKey(press("ArrowLeft", { repeat: true }))).toEqual({ kind: "step", word: "thinking", forward: false });
    expect(statementKey(press("Home", { word: "machine" }))).toEqual({ kind: "edge", word: "machine", last: false });
    expect(statementKey(press("End"))).toEqual({ kind: "edge", word: "thinking", last: true });
  });

  test("Backspace returns a setting to the last launch, once per press; Esc lets go and never undoes", () => {
    expect(statementKey(press("Backspace"))).toEqual({ kind: "reset", word: "thinking" });
    expect(statementKey(press("Backspace", { repeat: true }))).toBeNull();
    expect(statementKey(press("Escape"))).toEqual({ kind: "escape" });
    expect(statementKey(press(" "))).toBeNull();
  });

  test("on extras ←/→ and Home/End move between the switches, and Space or ↵ turns the one with focus, never on key repeat", () => {
    const extras = (key: string, changes: Partial<StatementKey> = {}) => press(key, { word: "extras", ...changes });
    expect(statementKey(extras("ArrowRight"))).toEqual({ kind: "cursor", forward: true });
    expect(statementKey(extras("End"))).toEqual({ kind: "cursor-edge", last: true });
    expect(statementKey(extras(" "))).toEqual({ kind: "toggle" });
    expect(statementKey(extras("Enter"))).toEqual({ kind: "toggle" });
    expect(statementKey(extras(" ", { repeat: true }))).toBeNull();
    expect(statementKey(extras("ArrowDown"))).toEqual({ kind: "focus", to: "machine" });
  });
});
