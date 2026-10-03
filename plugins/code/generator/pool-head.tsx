import { useLayoutEffect, useMemo, useRef, type CSSProperties, type FocusEvent, type KeyboardEvent } from "react";
import { accountWord, ago, clock, hhmm, hueOf } from "../ui.tsx";
import { accountRows, type BoardAccounts, type BoardUsage, type HeadVerdict, type PoolHead as PoolHeadView } from "./board-model.ts";
import type { KeyHelp } from "./keys-dialog.tsx";
import type { GateVerdict } from "./launch-step.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
/** The keys the panel's keys dialog lists for the pool heads and their accounts. */
export const BOARD_KEY_HELP: readonly KeyHelp[] = [
  { keys: ["↵"], text: "Open or close a pool's accounts" },
  { keys: ["Space"], text: "Include or exclude the focused account" },
  { keys: ["Esc"], text: "Close the accounts" },
];

/** A reset or reopening as the board says it: a clock time today, with the weekday once it is a day away. */
export function when(at: number, nowMs: number): string {
  return at - nowMs > 20 * 3_600_000 ? clock(at) : hhmm(at);
}
/** A prepaid balance in its own currency, dollars as `$`. */
export function balanceText(balance: { readonly total: string; readonly currency: string }): string {
  return balance.currency === "USD" ? `$${balance.total}` : `${balance.total} ${balance.currency}`;
}

/** The verdict as the head line writes it, and its tone. */
function verdictWords(verdict: HeadVerdict, nowMs: number): { text: string; tone: "neutral" | "warn" | "attention" } {
  switch (verdict.kind) {
    case "room": return { text: verdict.room === verdict.judged ? "room" : `${verdict.room} of ${verdict.judged} with room`, tone: "neutral" };
    case "thin": return { text: `${verdict.room} of ${verdict.judged} with room`, tone: "warn" };
    case "tight": return { text: "tight", tone: "warn" };
    case "blocked": case "maxed":
      return { text: `${verdict.kind} ${verdict.until === null ? "· reset unknown" : `until ${when(verdict.until, nowMs)}`}`, tone: "attention" };
    // History is read-only fact, said in neutral grey: never room, never alarm.
    case "stale": return { text: `${verdict.ageMs === null ? "age unknown" : `${ago(verdict.ageMs)} old`} · availability unknown`, tone: "neutral" };
    case "none": return { text: verdict.signedIn ? "none included" : "no account", tone: "attention" };
    case "unmetered": return { text: "", tone: "neutral" };
    case "unknown": return { text: "availability unknown", tone: "neutral" };
  }
}

type PoolHeadProps = {
  head: PoolHeadView;
  usage: BoardUsage;
  /** The gate's verdict on editing accounts: a step in flight, a waiting charge or a read-only workspace refuses. */
  accountsGate: GateVerdict;
  /** What every head in the columns reserves, so tracks line up (`BoardView.headRows`); null in the roster, where each head is its own size. */
  rows: { readonly tracks: number; readonly note: boolean } | null;
  /** The reading as a whole is unread or unavailable, which the board says once; the head stays quiet about it. */
  quiet: boolean;
  open: boolean;
  onToggle: () => void;
  style?: CSSProperties | undefined;
};

/**
 * One provider's pool: name, accounts and verdict on one line that opens the accounts in place;
 * a track per window with one number; one note line for the pressing reset, the pace forecast and
 * readings too old to judge. In columns every head reserves the same rows, so they align whatever each one says.
 */
export function PoolHead({ head, usage, accountsGate, rows, quiet, open, onToggle, style }: PoolHeadProps) {
  const { nowMs } = usage;
  const line = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const name = accountWord(head.family, head.pool?.provider);
  const { text, tone } = verdictWords(head.verdict, nowMs);
  const shown = quiet && head.verdict.kind === "unknown" ? "" : text;
  const count = head.total === 0 ? "" : head.included === head.total ? `×${head.included}` : `×${head.included} of ${head.total}`;
  const note = [
    head.reset && `${head.reset.label} resets ${when(head.reset.at, nowMs)}`,
    head.forecast !== null && `full ≈ ${hhmm(head.forecast)} at this pace`,
    head.stale && `${head.stale.count} ${head.stale.count === 1 ? "reading" : "readings"} ${ago(head.stale.ageMs)} old`,
  ].filter(Boolean).join(" · ");
  const listId = `${G}paccounts-${head.family}`;
  // Focus follows a press that opens the accounts, never a re-render that finds them open: the first switch, else the first control.
  useLayoutEffect(() => {
    if (!open || !opened.current) return;
    opened.current = false;
    (list.current?.querySelector<HTMLElement>("[role=switch]") ?? list.current?.querySelector<HTMLElement>("button") ?? list.current)?.focus();
  }, [open]);
  // An include switch or preset the keyboard was on, by its stable key. An edit re-reads the accounts,
  // and while the reading is out the list is redrawn without its rows; focus then waits on the list
  // and returns to the same control once it is back, instead of falling out of the panel.
  const kept = useRef<{ element: HTMLElement; key: string } | null>(null);
  useLayoutEffect(() => {
    const box = list.current, was = kept.current;
    if (!box || !was || was.element.isConnected) return;
    const active = box.ownerDocument.activeElement;
    if (active !== box && active !== box.ownerDocument.body) { kept.current = null; return; }
    const again = box.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(was.key)}"]`);
    (again ?? box).focus({ preventScroll: true });
  });
  function remember(event: FocusEvent<HTMLDivElement>) {
    const key = event.target === event.currentTarget ? undefined : (event.target as HTMLElement).dataset.focusKey;
    if (key !== undefined) kept.current = { element: event.target as HTMLElement, key };
  }
  function toggle() {
    opened.current = !open;
    onToggle();
  }
  function closeOnEscape(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onToggle();
    line.current?.focus();
  }
  // A pool without windows says its balance, or that none is reported, on the first track row.
  const filler = head.balances.length ? head.balances.map(balanceText).join(" · ") : head.unreported ? "no quota reported" : null;
  const trackRows = rows?.tracks ?? (head.tracks.length || (filler ? 1 : 0));
  const noteRow = rows ? rows.note : note !== "";
  const template = [...Array.from({ length: trackRows }, () => "16px"), ...noteRow ? ["auto"] : []].join(" ");
  return <div className={`${G}phead`} data-fam={hueOf(head.family)} style={{ ...style, "--phead-rows": template } as CSSProperties}>
    <button ref={line} type="button" className={`${G}phead-line`} aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-label={`${name} accounts: ${head.total === 0 ? "none signed in" : `${head.included} of ${head.total} included`}${text ? `, ${text}` : ""}`} onClick={toggle}>
      <span className={`${G}phead-name`}>{name}</span>
      {count && <span className={`${G}phead-count`}>{count}</span>}
      <span className={`${G}phead-verdict`} data-tone={tone} title={shown || undefined}>{shown}</span>
    </button>
    {Array.from({ length: trackRows }, (_, index) => {
      const track = head.tracks[index];
      if (!track) return <div key={index} className={`${G}ptrack`} data-text="">{index === 0 ? filler : null}</div>;
      return <div key={index} className={`${G}ptrack`}>
        <span className={`${G}ptrack-label`}>{track.label}</span>
        <span className={`${G}ptrack-bar`} aria-hidden="true">{track.segments.map(segment =>
          <i key={segment.credentialId} data-level={segment.level} data-word={segment.word || undefined} data-fresh={segment.fresh || undefined}
            style={{ "--used": segment.used ?? 0 } as CSSProperties}>
            <b />{segment.elapsed !== null && <s style={{ "--elapsed": segment.elapsed } as CSSProperties} />}
          </i>)}</span>
        <span className={`${G}ptrack-pct`} title={track.percent === null ? "No present reading" : "The highest present reading among included accounts"}>
          {track.percent === null ? <><span aria-hidden="true">–</span><span className="plugin-atyrode_code__sr">unknown</span></> : `${Math.round(track.percent)}%`}
        </span>
      </div>;
    })}
    {noteRow && <div className={`${G}phead-note`} title={head.forecast !== null ? `${note} (a projection from one reading)` : note || undefined}>{note}</div>}
    {open && <div ref={list} id={listId} className={`${G}paccounts`} role="group" aria-label={`${name} accounts`} tabIndex={-1} onKeyDown={closeOnEscape} onFocus={remember}>
      <AccountList family={head.family} usage={usage} accountsGate={accountsGate} />
    </div>}
  </div>;
}

function AccountList({ family, usage, accountsGate }: { family: string; usage: BoardUsage; accountsGate: GateVerdict }) {
  const rows = useMemo(() => accountRows(family, usage), [family, usage.view, usage.current, usage.nowMs]);
  const accounts: BoardAccounts | null = usage.accounts;
  const { nowMs } = usage;
  // Without a reading there are no rows to list, which says nothing about who is signed in.
  if (!rows.length) return <p className={`${G}paccount-empty`}>{usage.view === null ? "Accounts not read yet." : `No ${accountWord(family)} account is signed in.`}</p>;
  const choices = accounts?.choices ?? null;
  const preset = choices && choices.activePreset !== null ? choices.presets.find(entry => entry.id === choices.activePreset) ?? null : null;
  const editable = accounts !== null && accountsGate.open && !accounts.pending;
  // Hand edits belong to the Manual pool, as the accounts view makes them; a preset changes only by choosing another.
  const why = accounts === null ? "Account choices are not set up yet"
    : !accountsGate.open ? accountsGate.refusal.text
    : accounts.pending ? "Saving the last change"
    : preset ? `Set by the ${preset.name} preset` : accounts.historical ? "The account list is not current" : null;
  return <>
    {choices && choices.presets.length > 0 && <div className={`${G}ppresets`} role="group" aria-label="Account pool">
      {[{ id: null, name: "Manual" }, ...choices.presets].map(entry => {
        const current = choices.activePreset === entry.id;
        return <button key={entry.id ?? ""} type="button" className={`${G}ppreset`} data-focus-key={`preset:${entry.id ?? ""}`} aria-pressed={current} aria-disabled={!editable || undefined}
          title={editable ? undefined : why ?? undefined} onClick={() => { if (editable && !current) accounts!.change({ kind: "activate-preset", id: entry.id }); }}>{entry.name}</button>;
      })}
    </div>}
    {rows.map(row => {
      const can = editable && preset === null && !accounts!.historical && !row.disabled;
      const facts = [
        row.balance ? balanceText(row.balance) : row.windows.map(window => `${window.label} ${window.percent === null ? "?" : `${Math.round(Math.min(100, window.percent))}%`}`).join(" · ") || "no readings",
        row.disabled ? "disabled" : row.stop ? `${row.stop.word} ${row.stop.until === null ? "· reset unknown" : `until ${when(row.stop.until, nowMs)}`}` : row.tight ? "tight" : null,
        row.ageMs !== null ? `${ago(row.ageMs)} old` : null,
      ].filter(Boolean).join(" · ");
      return <div key={row.key} className={`${G}paccount`} data-excluded={!row.included || undefined}>
        <button type="button" role="switch" className={`${G}paccount-switch`} data-focus-key={`account:${row.key}`} aria-checked={row.included} aria-disabled={!can || undefined}
          aria-label={`Include ${row.who} in the next launch`} title={can ? undefined : row.disabled ? "Credential disabled" : why ?? undefined}
          onClick={() => { if (can) accounts!.change({ kind: "set-account", reference: row.reference, enabled: !row.included }); }}>
          <i aria-hidden="true" />{row.included ? "in" : "out"}
        </button>
        <span className={`${G}paccount-who`} title={row.who}>{row.who}</span>
        <span className={`${G}paccount-facts`} data-stop={row.stop ? "" : undefined}>{facts}</span>
      </div>;
    })}
    {accounts?.failure && <p className={`${G}paccount-failure`} role="status">{accounts.failure}</p>}
  </>;
}
