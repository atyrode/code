import { describe, expect, test } from "bun:test";
import { statementKey, type StatementKey } from "../code/generator/statement-keys.ts";

/** A key pressed on the thinking word in the shown main view, with nothing open and three recent teams; each test changes only what it is about. */
function press(key: string, changes: Partial<StatementKey> = {}): StatementKey {
  return { key, mod: false, alt: false, repeat: false, defaultPrevented: false, inView: true, onRoot: false, inField: false, inDialog: false,
    word: "thinking", onVerb: false, open: null, recents: 3, ...changes };
}

describe("where the panel's keys act", () => {
  test("nothing acts behind a sheet, inside a dialog or popover, or once another control handled the key: not Mod+↵, not a digit", () => {
    for (const changes of [{ inView: false }, { inDialog: true }, { defaultPrevented: true }] as const) {
      expect(statementKey(press("Enter", { mod: true, ...changes }))).toBeNull();
      expect(statementKey(press("1", { word: null, ...changes }))).toBeNull();
      expect(statementKey(press("ArrowUp", changes))).toBeNull();
    }
    // The panel root focused while a sheet covers the main view is not the view either.
    expect(statementKey(press("Enter", { onRoot: true, inView: false, word: null }))).toBeNull();
  });

  test("a key held with Alt is left alone", () => {
    expect(statementKey(press("ArrowUp", { alt: true }))).toBeNull();
    expect(statementKey(press("Enter", { mod: true, alt: true }))).toBeNull();
  });
});

describe("the verb, the keys dialog and recent teams", () => {
  test("Mod+↵ takes the verb's step from anywhere in the main view, typing included, but never on key repeat", () => {
    expect(statementKey(press("Enter", { mod: true }))).toEqual({ kind: "verb" });
    expect(statementKey(press("Enter", { mod: true, inField: true, word: null }))).toEqual({ kind: "verb" });
    expect(statementKey(press("Enter", { mod: true, repeat: true }))).toBeNull();
  });

  test("digits recall only the teams there are; digits, ? and r never act while typing", () => {
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
    expect(statementKey(press("Enter"))).toEqual({ kind: "open", word: "thinking" });
  });
});

describe("moving between words and changing them", () => {
  test("←/→ walk the verb and the words in reading order and stop at the ends", () => {
    expect(statementKey(press("ArrowRight", { word: null, onVerb: true }))).toEqual({ kind: "focus", to: "lane" });
    expect(statementKey(press("ArrowLeft", { word: "lane" }))).toEqual({ kind: "focus", to: "verb" });
    expect(statementKey(press("ArrowRight", { word: "machine" }))).toBeNull();
    expect(statementKey(press("ArrowLeft", { word: null, onVerb: true }))).toBeNull();
  });

  test("↑ is more and ↓ less on a word, open or not; Home and End reach its ends", () => {
    expect(statementKey(press("ArrowUp"))).toEqual({ kind: "step", word: "thinking", more: true });
    expect(statementKey(press("ArrowDown", { open: "thinking" }))).toEqual({ kind: "step", word: "thinking", more: false });
    expect(statementKey(press("End"))).toEqual({ kind: "edge", word: "thinking", top: false });
  });

  test("Enter and Space open and close a word's drum; Esc closes it and never undoes; Backspace returns it to the last launch", () => {
    expect(statementKey(press("Enter"))).toEqual({ kind: "open", word: "thinking" });
    expect(statementKey(press(" ", { open: "thinking" }))).toEqual({ kind: "close", word: "thinking" });
    expect(statementKey(press("Escape", { open: "thinking" }))).toEqual({ kind: "close", word: "thinking" });
    expect(statementKey(press("Escape"))).toEqual({ kind: "escape" });
    expect(statementKey(press("Backspace"))).toEqual({ kind: "reset", word: "thinking" });
    expect(statementKey(press("Backspace", { repeat: true }))).toBeNull();
  });

  test("on extras the arrows open the list and then move through it, and Space turns the switch under the cursor", () => {
    expect(statementKey(press("ArrowDown", { word: "extras" }))).toEqual({ kind: "open", word: "extras" });
    expect(statementKey(press("ArrowDown", { word: "extras", open: "extras" }))).toEqual({ kind: "cursor", more: false });
    expect(statementKey(press(" ", { word: "extras", open: "extras" }))).toEqual({ kind: "toggle" });
    expect(statementKey(press("Enter", { word: "extras", open: "extras" }))).toEqual({ kind: "close", word: "extras" });
  });
});
