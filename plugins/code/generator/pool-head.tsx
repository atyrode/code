import { Fragment, useLayoutEffect, useMemo, useRef, type CSSProperties, type FocusEvent, type KeyboardEvent, type ReactNode } from "react";
import { accountWord, ago, hueOf } from "../ui.tsx";
import { accountRows, when, type BoardAccounts, type BoardUsage, type HeadVerdict, type PoolHead as PoolHeadView, type PoolTrack } from "./board-model.ts";
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

/** A prepaid balance in its own currency, dollars as `$`. */
export function balanceText(balance: { readonly total: string; readonly currency: string }): string {
  return balance.currency === "USD" ? `$${balance.total}` : `${balance.total} ${balance.currency}`;
}

/**
 * The rows a head takes in the board's grid: its line, a row per reserved track, the note row when
 * any head has one, and the row its accounts open in, which also carries the rule under the heads.
 */
export function headRowCount(rows: { readonly tracks: number; readonly note: boolean }): number {
  return 2 + rows.tracks + (rows.note ? 1 : 0);
}

/** The verdict as the head line writes it, in parts that never break inside, and its tone. */
function verdictWords(verdict: HeadVerdict, nowMs: number): { parts: readonly string[]; tone: "neutral" | "warn" | "attention" } {
  switch (verdict.kind) {
    case "room": return { parts: [verdict.room === verdict.judged ? "room" : `${verdict.room} of ${verdict.judged} with room`], tone: "neutral" };
    case "thin": return { parts: [`${verdict.room} of ${verdict.judged} with room`], tone: "warn" };
    case "tight": return { parts: ["tight"], tone: "warn" };
    case "blocked": case "maxed":
      return { parts: verdict.until === null ? [verdict.kind, "reset unknown"] : [`${verdict.kind} until ${when(verdict.until, nowMs)}`], tone: "attention" };
    // History is read-only fact, said in neutral grey: never room, never alarm. Its age comes first, so it is never the part that wraps away.
    case "stale": return { parts: [verdict.ageMs === null ? "age unknown" : `${ago(verdict.ageMs)} old`, "availability unknown"], tone: "neutral" };
    case "none": return { parts: [verdict.signedIn ? "none included" : "no account"], tone: "attention" };
    case "unmetered": return { parts: [], tone: "neutral" };
    case "unknown": return { parts: ["availability unknown"], tone: "neutral" };
  }
}

/** Facts joined by "·", each kept whole: a line breaks only between them, so no fact is ever cut. */
export function Parts({ parts }: { parts: readonly string[] }) {
  return <>{parts.map((part, index) => <Fragment key={index}>{index > 0 && " "}
    <span className={`${G}part`}>{part}{index < parts.length - 1 && " ·"}</span>
  </Fragment>)}</>;
}

/** Every included account's reading in one window, for the track's title: the level is their mean. */
function trackTitle(track: PoolTrack): string {
  const readings = track.segments.map(segment => segment.absent ? `${segment.who} no ${track.label} reading in this pool`
    : segment.used === null ? `${segment.who} unread` : `${segment.who} ${Math.round(segment.used * 100)}%${segment.fresh ? "" : " (not current)"}`);
  const level = track.level === null ? "no present reading" : "the mean of the present readings";
  return `${track.label} level: ${level} · ${readings.join(" · ")}`;
}

type PoolHeadProps = {
  head: PoolHeadView;
  usage: BoardUsage;
  /** The gate's verdict on editing accounts: a step in flight, a waiting charge or a read-only workspace refuses. */
  accountsGate: GateVerdict;
  /**
   * In columns, the head's column and the rows every head reserves (`BoardView.headRows`): its parts
   * are then the board grid's own items, so each row is as tall as its tallest head and tracks line
   * up whatever each head says. Null in the roster, where each head is its own size.
   */
  grid: { readonly column: number; readonly rows: { readonly tracks: number; readonly note: boolean } } | null;
  /** The reading as a whole is unread or unavailable, which the board says once; the head stays quiet about it. */
  quiet: boolean;
  /** No role sits with this provider, nor would under the pointed team: tracks and verdict go grey, numbers kept. */
  idle: boolean;
  /** A collapsed column's idle seats, which sit in its note row rather than on a rung. */
  seats?: ReactNode;
  open: boolean;
  onToggle: () => void;
};

/**
 * One provider's pool: name, accounts and verdict on a line that opens the accounts in place and
 * takes a second line where one cannot hold it; a track per window with the pool's level; one note
 * for the readings too old to judge, the pressing reset and the pace forecast.
 */
export function PoolHead({ head, usage, accountsGate, grid, quiet, idle, seats, open, onToggle }: PoolHeadProps) {
  const { nowMs } = usage;
  const line = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const name = accountWord(head.family, head.pool?.provider);
  const { parts, tone } = verdictWords(head.verdict, nowMs);
  const shown = quiet && head.verdict.kind === "unknown" ? [] : parts;
  const count = head.total === 0 ? "" : head.included === head.total ? `×${head.included}` : `×${head.included} of ${head.total}`;
  // The age of readings left out comes first, so a narrow column never loses it; a forecast fill reads before the reset that ends it.
  const note = [
    head.stale && `${head.stale.count} ${head.stale.count === 1 ? "reading" : "readings"} ${ago(head.stale.ageMs)} old`,
    head.forecast && `${head.forecast.label} full ≈ ${when(head.forecast.at, nowMs)}`,
    head.reset && `${head.reset.label} resets ${when(head.reset.at, nowMs)}`,
  ].filter((part): part is string => Boolean(part));
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
  const trackRows = grid?.rows.tracks ?? (head.tracks.length || (filler ? 1 : 0));
  const noteRow = grid ? grid.rows.note : note.length > 0;
  // In columns each part names its own row; in the roster the head's own grid stacks them in order.
  const at = (row: number): CSSProperties | undefined => grid ? { gridRow: row } : undefined;
  const accounts = open && <div ref={list} id={listId} className={`${G}paccounts`} role="group" aria-label={`${name} accounts`} tabIndex={-1} onKeyDown={closeOnEscape} onFocus={remember}>
    <AccountList family={head.family} usage={usage} accountsGate={accountsGate} />
  </div>;
  return <div className={`${G}phead`} data-fam={hueOf(head.family)} data-idle={idle || undefined} data-grid={grid ? "" : undefined}
    style={grid ? { "--phead-column": grid.column } as CSSProperties : undefined}>
    <button ref={line} type="button" className={`${G}phead-line`} aria-expanded={open} aria-controls={open ? listId : undefined} style={at(1)}
      aria-label={`${name} accounts: ${head.total === 0 ? "none signed in" : `${head.included} of ${head.total} included`}${parts.length ? `, ${parts.join(", ")}` : ""}`} onClick={toggle}>
      <span className={`${G}phead-id`}><span className={`${G}phead-name`}>{name}</span>{count && <span className={`${G}phead-count`}>{count}</span>}</span>
      {shown.length > 0 && <span className={`${G}phead-verdict`} data-tone={idle ? "neutral" : tone}><Parts parts={shown} /></span>}
    </button>
    {Array.from({ length: trackRows }, (_, index) => {
      const track = head.tracks[index];
      if (!track) return <div key={index} className={`${G}ptrack`} data-text="" style={at(index + 2)}>{index === 0 ? filler : null}</div>;
      return <div key={index} className={`${G}ptrack`} title={trackTitle(track)} style={at(index + 2)}>
        <span className={`${G}ptrack-label`}>{track.label}</span>
        <span className={`${G}ptrack-bar`} aria-hidden="true">{track.segments.map((segment, cell) =>
          <i key={cell} data-level={segment.level} data-word={segment.word || undefined} data-fresh={segment.fresh || undefined} data-absent={segment.absent || undefined}
            style={{ "--used": segment.used ?? 0 } as CSSProperties}>
            <b />{segment.elapsed !== null && <s style={{ "--elapsed": segment.elapsed } as CSSProperties} />}
          </i>)}</span>
        <span className={`${G}ptrack-pct`}>
          {track.level === null ? <><span aria-hidden="true">–</span><span className="plugin-atyrode_code__sr">unknown</span></> : `${Math.round(track.level)}%`}
        </span>
      </div>;
    })}
    {noteRow && (grid
      ? <div className={`${G}phead-noterow`} style={at(trackRows + 2)}>
        {note.length > 0 && <div className={`${G}phead-note`} title={head.forecast ? `${note.join(" · ")} · the forecast projects one reading at its pace` : undefined}><Parts parts={note} /></div>}
        {seats}
      </div>
      : <div className={`${G}phead-note`} title={head.forecast ? `${note.join(" · ")} · the forecast projects one reading at its pace` : undefined}><Parts parts={note} /></div>)}
    {grid ? <div className={`${G}phead-foot`} style={at(headRowCount(grid.rows))}>{accounts}</div> : accounts}
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
    {/* The switches edit the workspace's shared pool, which every member's next launch draws on: said once, at the head of the list. */}
    <div className={`${G}ppresets`} role="group" aria-label="Workspace pool">
      <span className={`${G}ppresets-head`}>workspace pool</span>
      {choices && choices.presets.length > 0 && [{ id: null, name: "Manual" }, ...choices.presets].map(entry => {
        const current = choices.activePreset === entry.id;
        return <button key={entry.id ?? ""} type="button" className={`${G}ppreset`} data-focus-key={`preset:${entry.id ?? ""}`} aria-pressed={current} aria-disabled={!editable || undefined}
          title={editable ? undefined : why ?? undefined} onClick={() => { if (editable && !current) accounts!.change({ kind: "activate-preset", id: entry.id }); }}>{entry.name}</button>;
      })}
    </div>
    {rows.map(row => {
      const can = editable && preset === null && !accounts!.historical && !row.disabled;
      const facts = [
        row.balance ? balanceText(row.balance) : row.windows.map(window => `${window.label} ${window.percent === null ? "?" : `${Math.round(Math.min(100, window.percent))}%`}`).join(" · ") || "no readings",
        row.disabled ? "disabled" : row.stop ? `${row.stop.word} ${row.stop.until === null ? "· reset unknown" : `until ${when(row.stop.until, nowMs)}`}` : row.tight ? "tight" : null,
        row.ageMs !== null ? `${ago(row.ageMs)} old` : null,
      ].filter(Boolean).join(" · ");
      return <div key={row.key} className={`${G}paccount`} data-excluded={!row.included || undefined}>
        <button type="button" role="switch" className={`${G}paccount-switch`} data-focus-key={`account:${row.key}`} aria-checked={row.included} aria-disabled={!can || undefined}
          aria-label={`Include ${row.who} in the workspace pool`} title={can ? undefined : row.disabled ? "Credential disabled" : why ?? undefined}
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
