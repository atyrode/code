import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CREDENTIAL_DISABLED, pressSwitch, SAVING, settlePress, switchLock, type SwitchPress, type SwitchSaving } from "./account-switch.ts";
import type { BoardUsage } from "./board-model.ts";
import type { UsageAccountRow } from "./usage-model.ts";
import { ageText, ProviderGrid, RefreshLine, UsageNote, useBarsFilled, useShownReading, type UsageCadence } from "./usage-pane.tsx";

/*
 * The accounts view: a switch per account over its windows and resets, nothing more. Every switch is
 * one guarded `changeAccounts` CAS through the model; nothing is kept locally but the press that
 * waits for it. A press makes its edit or is refused with its reason (account-switch.ts). The saved pools (presets), sign-in and credentials are managed under the accounts
 * (the shell's Manage accounts, `m`).
 */

/** Generator-panel class prefix; every part hangs from the generator root (styles.css, "usage pane and accounts view"). */
const G = "plugin-atyrode_code_generator__";

type AccountsPaneProps = {
  /** The model's usage: the reading, and the saved choices with their guarded edit. */
  usage: BoardUsage;
  cadence: UsageCadence;
  /** `m`: opens the accounts' management, where pools are chosen, accounts signed in and credentials managed. */
  onManage: () => void;
};
/** The readout: one line, a value and why, while something is pointed at or focused. */
type Readout = { readonly value: string; readonly text: string; readonly warn: boolean };

export function AccountsPane({ usage, cadence, onManage }: AccountsPaneProps) {
  const root = useRef<HTMLDivElement>(null);
  const { state } = useShownReading(usage);
  const filled = useBarsFilled(cadence.refreshing);
  const accounts = usage.accounts;
  const choices = accounts?.choices ?? null;
  const preset = choices && choices.activePreset !== null ? choices.presets.find(entry => entry.id === choices.activePreset) ?? null : null;

  // The press waiting on its edit shows as made, and locks every switch, until the saved choices answer it (account-switch.ts).
  const [press, setPress] = useState<SwitchPress | null>(null);
  const saving: SwitchSaving = { pending: accounts?.pending ?? false, failure: accounts?.failure ?? null, revision: accounts?.revision ?? null };
  const settled = settlePress(press, saving);
  useEffect(() => { if (settled !== press) setPress(settled); });
  const switchLocked = accounts === null ? "Account choices are not set up yet."
    : switchLock({ refusal: accounts.refusal, saving: accounts.pending || settled !== null, preset: preset?.name ?? null, historical: accounts.historical });

  const groups = state.kind !== "groups" ? [] : !settled ? state.groups : state.groups.map(group => ({
    ...group, accounts: group.accounts.map(row => row.key === settled.key ? { ...row, included: settled.enabled } : row),
  }));
  const rows = new Map(groups.flatMap(group => group.accounts.map(row => [row.key, row] as const)));
  const reasonOf = (row: UsageAccountRow) => row.disabled ? CREDENTIAL_DISABLED : switchLocked;

  // The readout follows the switch pointed at or focused, live; a refused press says its reason there until focus moves on.
  const [pointed, setPointed] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  function flip(row: UsageAccountRow) {
    const outcome = pressSwitch(row, switchLocked);
    if (outcome.kind === "refuse" || !accounts || accounts.revision === null) { setRefused(row.key); return; }
    setRefused(null);
    setPress({ key: row.key, enabled: outcome.enabled, revision: accounts.revision, started: false });
    accounts.change({ kind: "set-account", reference: row.reference, enabled: outcome.enabled });
  }
  const hint = (key: string | null, always: boolean): Readout | null => {
    const row = key === null ? undefined : rows.get(key);
    const reason = row ? reasonOf(row) : null;
    // While a press is saved, the switches' shared lock is said once, quietly, unless a press just met it.
    return row && reason !== null && (always || reason !== SAVING) ? { value: row.who, text: reason, warn: true } : null;
  };
  const failure = accounts?.failure ?? null;
  const readout: Readout | null = failure ? { value: "", text: failure, warn: true }
    : hint(refused, true) ?? hint(pointed, false) ?? hint(focused, false)
    ?? (accounts?.pending || settled !== null ? { value: "", text: "saving…", warn: false } : null);

  // Opening the view puts focus on its first switch that can move, so ↑↓ and Space work at once.
  useLayoutEffect(() => {
    const element = root.current;
    const first = element?.querySelector<HTMLElement>('[role="switch"]:not([aria-disabled="true"])') ?? element?.querySelector<HTMLElement>('[role="switch"]');
    (first ?? element)?.focus({ preventScroll: true });
  }, []);

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const element = root.current!;
    const target = event.target as HTMLElement;
    if (event.key === "m") {
      event.preventDefault();
      onManage();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const stops = [...element.querySelectorAll<HTMLElement>('[role="switch"]')];
    if (stops.length === 0) return;
    const at = stops.indexOf(target);
    const next = event.key === "Home" ? 0 : event.key === "End" ? stops.length - 1
      : at < 0 ? 0 : Math.max(0, Math.min(stops.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
    stops[next]!.focus();
    event.preventDefault();
  }

  return <div ref={root} className={`${G}accounts-body`} tabIndex={-1} onKeyDown={keys} data-accounts-pane="">
    {state.kind === "groups"
      ? <ProviderGrid groups={groups} filled={filled} identity={row => {
        const on = row.included && !row.disabled;
        return <button type="button" role="switch" className={`${G}accounts-switch`} aria-checked={on} aria-disabled={reasonOf(row) !== null || undefined}
          data-account-switch={row.who} onClick={() => flip(row)}
          onPointerEnter={() => setPointed(row.key)} onPointerLeave={() => setPointed(null)}
          onFocus={() => { setFocused(row.key); setRefused(null); }} onBlur={() => { setFocused(null); setRefused(null); }}>
          <span className={`${G}accounts-sw`} aria-hidden="true" />
          <span className={`${G}accounts-who`} title={row.who}>{row.who}</span>
          <span className={`${G}accounts-st`}>{row.disabled ? "disabled" : row.ageMs !== null ? ageText(row.ageMs) : ""}</span>
        </button>;
      }} />
      : <UsageNote state={state} />}
    <p className={`${G}accounts-readout`} data-tone={readout?.warn ? "warn" : undefined} aria-live="polite">
      {readout && <>{readout.value && <b>{readout.value}</b>}{readout.value && " "}{readout.text}</>}
    </p>
    <RefreshLine cadence={cadence} />
  </div>;
}
