import { describe, expect, test } from "bun:test";
import { panelKey, type PanelKey } from "../code/generator/panel-keys.ts";

/** A key pressed on a generator row in the shown main view at full width, with three recent profiles; each test changes only what it is about. */
function press(key: string, changes: Partial<PanelKey> = {}): PanelKey {
  return {
    key, mod: false, alt: false, repeat: false, defaultPrevented: false, inView: true, inField: false, inDialog: false, onControl: false, onRoot: false,
    view: "main", narrow: false, more: false, recents: 3, ...changes,
  };
}

describe("the panel's keys stay the panel's", () => {
  test("nothing acts behind a sheet, in a dialog or open popover, with Alt, or once a nearer control handled the key", () => {
    for (const changes of [{ inView: false }, { inDialog: true }, { alt: true }, { defaultPrevented: true }] satisfies Partial<PanelKey>[]) {
      expect(panelKey(press("a", changes))).toBeNull();
      expect(panelKey(press("Enter", changes))).toBeNull();
    }
  });

  test("letters are typing in a field, where only Mod+↵ still launches", () => {
    expect(panelKey(press("d", { inField: true }))).toBeNull();
    expect(panelKey(press("Enter", { inField: true }))).toBeNull();
    expect(panelKey(press("Enter", { inField: true, mod: true }))).toEqual({ kind: "launch" });
  });

  test("↵ launches unless a control has focus, which answers it itself; never on repeat, and only from the main view", () => {
    expect(panelKey(press("Enter"))).toEqual({ kind: "launch" });
    expect(panelKey(press("Enter", { onControl: true }))).toBeNull();
    expect(panelKey(press("Enter", { onControl: true, mod: true }))).toEqual({ kind: "launch" });
    expect(panelKey(press("Enter", { repeat: true }))).toBeNull();
    expect(panelKey(press("Enter", { view: "accounts" }))).toBeNull();
  });
});

describe("views one key away", () => {
  test("a and e open the accounts and the sessions, and the same key comes back", () => {
    expect(panelKey(press("a"))).toEqual({ kind: "view", view: "accounts" });
    expect(panelKey(press("a", { view: "accounts" }))).toEqual({ kind: "view", view: "main" });
    expect(panelKey(press("e"))).toEqual({ kind: "view", view: "sessions" });
    expect(panelKey(press("e", { view: "sessions" }))).toEqual({ kind: "view", view: "main" });
  });

  test("p and s hide routing and usage beside the generator, and open them as views of their own when narrow", () => {
    expect(panelKey(press("p"))).toEqual({ kind: "toggle", pane: "routing" });
    expect(panelKey(press("s"))).toEqual({ kind: "toggle", pane: "usage" });
    expect(panelKey(press("p", { narrow: true }))).toEqual({ kind: "view", view: "routing" });
    expect(panelKey(press("p", { narrow: true, view: "routing" }))).toEqual({ kind: "view", view: "main" });
    // Beside the accounts there is nothing to hide.
    expect(panelKey(press("s", { view: "accounts" }))).toBeNull();
  });

  test("esc closes the full key line and goes back, and at rest in the main view is left to the host", () => {
    expect(panelKey(press("Escape", { view: "usage" }))).toEqual({ kind: "back" });
    expect(panelKey(press("Escape", { more: true }))).toEqual({ kind: "back" });
    expect(panelKey(press("Escape"))).toBeNull();
  });

  test("the profile's keys act in the main view only; in the accounts m opens their management, and Esc there returns to them", () => {
    expect(panelKey(press("d"))).toEqual({ kind: "defaults" });
    expect(panelKey(press("d", { view: "sessions" }))).toBeNull();
    expect(panelKey(press("w"))).toEqual({ kind: "machine" });
    expect(panelKey(press("w", { view: "accounts" }))).toBeNull();
    expect(panelKey(press("m"))).toEqual({ kind: "sheet", sheet: "models" });
    expect(panelKey(press("m", { view: "accounts" }))).toEqual({ kind: "view", view: "manage" });
    expect(panelKey(press("Escape", { view: "manage" }))).toEqual({ kind: "view", view: "accounts" });
    expect(panelKey(press("a", { view: "manage" }))).toEqual({ kind: "view", view: "main" });
    expect(panelKey(press("d", { repeat: true }))).toBeNull();
  });

  test("digits recall a recent profile only where the sessions view lists them, and only the ones there are", () => {
    expect(panelKey(press("2", { view: "sessions" }))).toEqual({ kind: "recall", index: 1 });
    expect(panelKey(press("4", { view: "sessions" }))).toBeNull();
    expect(panelKey(press("2"))).toBeNull();
  });

  test("an arrow on arrival moves focus into the view and changes nothing", () => {
    expect(panelKey(press("ArrowRight", { onRoot: true }))).toEqual({ kind: "enter" });
  });
});
