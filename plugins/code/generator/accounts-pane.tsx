import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AccountChoices } from "../../domain/contracts.ts";
import { familyWord, hueOf } from "../ui.tsx";
import type { BoardUsage } from "./board-model.ts";
import type { GateVerdict } from "./launch-step.ts";
import { servedFamilies, type UsageAccountRow } from "./usage-model.ts";
import { ageText, Cue, ProviderGrid, RefreshLine, UsageNote, useBarsFilled, useShownReading, type UsageCadence } from "./usage-pane.tsx";

/*
 * The accounts view: which families the included accounts offer, the saved pool when presets exist,
 * a switch per account over its windows, and what the launch line says now. Every switch and pool
 * word is one guarded `changeAccounts` CAS through the model; nothing is kept locally but the press
 * that waits for it.
 */

/** Generator-panel class prefix; every part hangs from the generator root (styles.css, "usage pane and accounts view"). */
const G = "plugin-atyrode_code_generator__";

/** What the launch line says now, which the view's foot repeats read-only, as a switch changes it. */
export type AccountsLaunch = { readonly label: string; readonly ready: boolean; readonly reason: string | null };

type AccountsPaneProps = {
  /** The model's usage: the reading, and the saved choices with their guarded edit. */
  usage: BoardUsage;
  /** The model's verdict on `edit-accounts`. */
  gate: GateVerdict;
  /** The catalog's families in panel order, which the offers line names. */
  families: readonly string[];
  /** The providers the session door's pool would serve (the model's `served`); null when unknown. */
  served: ReadonlySet<string> | null;
  launch: AccountsLaunch;
  cadence: UsageCadence;
  /** Opens the Code accounts panel, where accounts are signed in, presets edited and credentials managed. */
  onManage: () => void;
};
/** The readout: one line, a value and why, while something is pointed at or focused. */
type Readout = { readonly value: string; readonly text: string; readonly warn: boolean };

const ENTER = "M13.25 2.75v5.5a1 1 0 0 1-1 1H3.5M6.75 6 3.5 9.25l3.25 3.25";

export function AccountsPane({ usage, gate, families, served, launch, cadence, onManage }: AccountsPaneProps) {
  const root = useRef<HTMLDivElement>(null);
  const { state, gap } = useShownReading(usage);
  const filled = useBarsFilled(cadence.refreshing);
  const accounts = usage.accounts;
  const choices = accounts?.choices ?? null;
  const preset = choices && choices.activePreset !== null ? choices.presets.find(entry => entry.id === choices.activePreset) ?? null : null;
  // Why nothing may change now, in the gate's words when it refuses; a pool word waits on these alone.
  const locked = accounts === null ? "Account choices are not set up yet."
    : !gate.open ? gate.refusal.text
    : accounts.pending ? "Saving the last change."
    : gap ? "Reading the accounts again."
    : null;
  // Hand edits belong to the manual pool, and an inclusion is never made on an account list that is not current.
  const switchLocked = locked ?? (preset ? `Set by the ${preset.name} pool; choose manual to edit.`
    : accounts?.historical ? "The account list is not current." : null);

  // The press waiting on its CAS shows as made, until the saved choices answer it or the edit fails or is refused.
  const [request, setRequest] = useState<{ readonly key: string; readonly enabled: boolean } | null>(null);
  const requested = useRef<{ choices: AccountChoices | null; started: boolean }>({ choices: null, started: false });
  useEffect(() => {
    if (!request) return;
    if (accounts?.pending) { requested.current.started = true; return; }
    if (!requested.current.started || accounts?.failure || choices !== requested.current.choices) setRequest(null);
  });
  function flip(row: UsageAccountRow) {
    if (switchLocked !== null || row.disabled || !accounts) return;
    requested.current = { choices, started: false };
    setRequest({ key: row.key, enabled: !row.included });
    accounts.change({ kind: "set-account", reference: row.reference, enabled: !row.included });
  }
  function activate(id: string | null) {
    if (locked !== null || !accounts || choices?.activePreset === id) return;
    accounts.change({ kind: "activate-preset", id });
  }
  const groups = state.kind !== "groups" ? [] : !request ? state.groups : state.groups.map(group => ({
    ...group, accounts: group.accounts.map(row => row.key === request.key ? { ...row, included: request.enabled } : row),
  }));

  const [pointed, setPointed] = useState<Readout | null>(null);
  const [focused, setFocused] = useState<Readout | null>(null);
  const failure = accounts?.failure ?? null;
  const readout: Readout | null = failure ? { value: "", text: failure, warn: true }
    : pointed ?? focused ?? (accounts?.pending ? { value: "", text: "saving…", warn: false } : null);
  const why = (value: string, reason: string | null) => reason === null ? null : { value, text: reason, warn: true };

  // Opening the view puts focus on its first switch that can move, so ↑↓ and Space work at once.
  useLayoutEffect(() => {
    const element = root.current;
    const first = element?.querySelector<HTMLElement>('[role="switch"]:not([aria-disabled="true"])') ?? element?.querySelector<HTMLElement>('[role="switch"], [data-pool-word]');
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
    const words = [...element.querySelectorAll<HTMLElement>("[data-pool-word]")];
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && words.includes(target)) {
      words[words.indexOf(target) + (event.key === "ArrowRight" ? 1 : -1)]?.focus();
      event.preventDefault();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    // The pool is one stop of the column, at its chosen word; then every switch in order.
    const chosen = words.find(word => word.getAttribute("aria-pressed") === "true");
    const stops = [...chosen ? [chosen] : [], ...element.querySelectorAll<HTMLElement>('[role="switch"]')];
    if (stops.length === 0) return;
    const at = words.includes(target) ? 0 : stops.indexOf(target);
    const next = event.key === "Home" ? 0 : event.key === "End" ? stops.length - 1
      : at < 0 ? 0 : Math.max(0, Math.min(stops.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
    stops[next]!.focus();
    event.preventDefault();
  }

  const offered = servedFamilies(served);
  return <div ref={root} className={`${G}accounts-body`} tabIndex={-1} onKeyDown={keys} data-accounts-pane="">
    {families.length > 0 && <div className={`${G}accounts-offers`} data-accounts-offers="">
      <span className={`${G}accounts-offers-label`}>offers</span>
      {families.map(family => <span key={family} className={`${G}accounts-offer`} data-hue={hueOf(family)}
        data-state={offered === null ? "unknown" : offered.has(family) ? "on" : "off"}>{familyWord(family)}</span>)}
    </div>}
    {choices && choices.presets.length > 0 && <div className={`${G}accounts-pool`} role="group" aria-label="pool">
      <span className={`${G}accounts-pool-label`}>pool</span>
      {[{ id: null, name: "manual" }, ...choices.presets].map(entry => {
        const chosen = choices.activePreset === entry.id;
        return <button key={entry.id ?? ""} type="button" className={`${G}accounts-pool-word`} data-pool-word="" aria-pressed={chosen}
          aria-disabled={locked !== null || undefined} onClick={() => activate(entry.id)}
          onPointerEnter={() => setPointed(why(entry.name, locked))} onPointerLeave={() => setPointed(null)}
          onFocus={() => setFocused(why(entry.name, locked))} onBlur={() => setFocused(null)}>
          <span className={`${G}accounts-pool-text`} data-text={entry.name}>{entry.name}</span>
        </button>;
      })}
    </div>}
    {state.kind === "groups"
      ? <ProviderGrid groups={groups} filled={filled} identity={row => {
        const on = row.included && !row.disabled;
        const reason = row.disabled ? "Credential disabled." : switchLocked;
        return <button type="button" role="switch" className={`${G}accounts-switch`} aria-checked={on} aria-disabled={reason !== null || undefined}
          data-account-switch={row.who} onClick={() => flip(row)}
          onPointerEnter={() => setPointed(why(row.who, reason))} onPointerLeave={() => setPointed(null)}
          onFocus={() => setFocused(why(row.who, reason))} onBlur={() => setFocused(null)}>
          <span className={`${G}accounts-sw`} aria-hidden="true" />
          <span className={`${G}accounts-who`}>{row.who}</span>
          <span className={`${G}accounts-st`}>{row.disabled ? "disabled" : row.ageMs !== null ? ageText(row.ageMs) : ""}</span>
        </button>;
      }} />
      : <UsageNote state={state} />}
    <p className={`${G}accounts-readout`} data-tone={readout?.warn ? "warn" : undefined} aria-live="polite">
      {readout && <>{readout.value && <b>{readout.value}</b>}{readout.value && " "}{readout.text}</>}
    </p>
    <RefreshLine cadence={cadence}><span className={`${G}accounts-manage`}><Cue cueKey="m" word="manage" onClick={onManage} /></span></RefreshLine>
    <div className={`${G}accounts-foot`}>
      <span className={`${G}accounts-launch`} data-ready={launch.ready || undefined}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ENTER} /></svg>
        <span>{launch.label.toLowerCase()}</span>
      </span>
      {launch.reason && <span className={`${G}accounts-why`}>{launch.reason}</span>}
    </div>
  </div>;
}
