import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PanelReads } from "./read-clock.ts";
import { providerPolicy } from "../../domain/providers.ts";
import type { QuotaReading } from "../../domain/quota.ts";
import { accountWord, ago, Button, hueOf } from "../ui.tsx";
import { when, type BoardUsage } from "./board-model.ts";
import { usageState, type UsageAccountRow, type UsageGroup, type UsageState, type UsageWindowRow } from "./usage-model.ts";

/*
 * The usage pane: per provider, then per account, a block bar for each window with how much is used,
 * when it resets and Code's word for it, the balances, and the next refresh. The accounts view
 * (accounts-pane.tsx) draws the same grid with a switch per account.
 */

/** Generator-panel class prefix; every part hangs from the generator root (styles.css, "usage pane and accounts view"). */
const G = "plugin-atyrode_code_generator__";
const BLOCKS = 12;
/** A read answers in milliseconds; the drain and refill holds this long, so a refresh reads as one gesture. */
const REFRESH_HOLD_MS = 520;

// ---------------------------------------------------------------- the refresh cadence

/**
 * When the usage is read next, whether a read is in flight or owed and held, and the way to read it
 * now (Refresh now, `r`). One cadence serves the whole panel, so a refresh by key, by press or by the
 * clock restarts the same countdown.
 */
export type UsageCadence = { readonly nextAt: number; readonly refreshing: boolean; readonly waiting: boolean; readonly now: () => void };

/**
 * The usage's side of the panel's reads (read-clock.ts `usePanelReads`): it is read again every usage
 * freshness window, since the host's feeds read again only on events while their channel is live and
 * provider readings change without one. A read shows as refreshing for a moment however quick it is,
 * so a press always answers.
 */
export function useUsageCadence(usage: BoardUsage, reads: PanelReads): UsageCadence {
  const [holding, setHolding] = useState(false);
  const nextAt = reads.nextAt.usage;
  const first = useRef(nextAt);
  useEffect(() => {
    if (nextAt === first.current) return;
    setHolding(true);
    const timer = window.setTimeout(() => setHolding(false), REFRESH_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [nextAt]);
  const refreshing = usage.refreshing || holding;
  return useMemo(() => ({ nextAt, refreshing, waiting: reads.waiting.usage, now: reads.now }), [nextAt, refreshing, reads.waiting.usage, reads.now]);
}

// ---------------------------------------------------------------- the clock the countdowns follow

const clockListeners = new Set<() => void>();
let clockTimer: number | undefined;
// The second every follower reads, so one tick reads one time however often a snapshot is taken.
let clockNow = Date.now();
function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === undefined) {
    clockNow = Date.now();
    clockTimer = window.setInterval(() => {
      clockNow = Date.now();
      for (const notify of clockListeners) notify();
    }, 1000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size > 0) return;
    window.clearInterval(clockTimer);
    clockTimer = undefined;
  };
}
/** Text that follows the wall clock, a second at a time; its component renders again only when the text changes. */
function useClockText(text: (nowMs: number) => string): string {
  return useSyncExternalStore(subscribeClock, () => text(clockTimer === undefined ? Date.now() : clockNow));
}

/** `1h 45m`, `35m`, `3d 0h`, or `now` under half a minute. */
function countdown(ms: number): string {
  if (ms < 30_000) return "now";
  const total = Math.ceil(ms / 60_000);
  const days = Math.floor(total / 1440), hours = Math.floor((total % 1440) / 60), minutes = total % 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/** `↻ 35m` to the reset, `↻ 16:55` when a block lifts, `↻ —` when no reset is ahead. */
function Reset({ window }: { window: UsageWindowRow }) {
  const blocked = window.word === "blocked" && window.until !== null;
  const text = useClockText(nowMs => blocked ? when(window.until!, nowMs)
    : window.resetsAt !== null && window.resetsAt > nowMs ? countdown(window.resetsAt - nowMs) : "—");
  return <span className={`${G}usage-rst`}><span aria-hidden="true">↻ </span><span className="plugin-atyrode_code__sr">{blocked ? "blocked until " : "resets "}</span>{text}</span>;
}

// ---------------------------------------------------------------- shared parts of the usage pane and the accounts view

/** What a provider's accounts go by: the subscription for a family's own provider (`Codex`), the provider's label otherwise. */
function providerWord(group: Pick<UsageGroup, "provider" | "family">): string {
  const policy = providerPolicy(group.provider);
  return policy.providers[0] === group.provider ? accountWord(group.family) : policy.label;
}

/** An age as the pane says it: `12m old`, or `not current` for a reading too new to have one. */
export function ageText(ageMs: number | null): string {
  if (ageMs === null) return "age unknown";
  const age = ago(ageMs);
  return age === "now" ? "not current" : `${age} old`;
}


/**
 * The reading the panes draw. The model drops its reading whenever the saved choices change, until one is
 * made under the new ones (usage-view.tsx `useAccountUsage`); for that gap the last reading stays drawn, so a
 * switch keeps its row and its focus. Inclusion always follows the saved choices, and an account read longer
 * ago than the freshness window says its age, so a gap that lasts never passes for a present reading.
 */
export function useShownReading(usage: BoardUsage): { readonly state: UsageState; readonly gap: boolean } {
  const last = useRef<QuotaReading | null>(null);
  if (usage.view !== null) last.current = usage;
  const gap = usage.view === null && usage.accounts !== null && last.current !== null;
  const reading = gap ? last.current! : usage;
  const choices = usage.accounts?.choices ?? null;
  const state = useMemo(() => usageState({ view: reading.view, current: reading.current, nowMs: usage.nowMs }, choices),
    [reading.view, reading.current, usage.nowMs, choices]);
  return { state, gap };
}

/** Bars rise from empty once drawn, drain while a refresh reads and fill again with what it read. */
export function useBarsFilled(refreshing: boolean): boolean {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setDrawn(true)); });
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner); };
  }, []);
  return drawn && !refreshing;
}

function Bar({ percent, filled }: { percent: number | null; filled: boolean }) {
  const units = filled && percent !== null ? Math.min(100, Math.max(0, percent)) / 100 * BLOCKS : 0;
  return <span className={`${G}usage-bar`} aria-hidden="true">{Array.from({ length: BLOCKS }, (_, index) =>
    <i key={index}><b style={{ transform: `scaleX(${Math.max(0, Math.min(1, units - index))})`, transitionDelay: `${index * 22}ms` }} /></i>)}</span>;
}

function WindowLine({ window, filled }: { window: UsageWindowRow; filled: boolean }) {
  return <div className={`${G}usage-win`} data-level={window.level} data-tier={window.tier ?? undefined}>
    <span className={`${G}usage-wl`}>{window.label}{window.tier !== null && <> <span className={`${G}usage-tier`}>{window.tier}</span></>}</span>
    <Bar percent={window.percent} filled={filled} />
    <span className={`${G}usage-pct`}>{window.percent === null ? "—" : `${Math.round(window.percent)}%`}</span>
    <span className={`${G}usage-used`}>used</span>
    {/* The reset and the word share the last column and wrap there, so a wide font never cuts the word. */}
    <span className={`${G}usage-tail`}><Reset window={window} />{window.word && <span className={`${G}usage-word`}>{window.word}</span>}</span>
  </div>;
}

/** An account's readings under its identity line: its windows, its balance, and what no window says. */
function AccountReadings({ row, filled }: { row: UsageAccountRow; filled: boolean }) {
  return <>
    {/* One grid for the account's windows, so a tier's longer label moves all of its bars alike. */}
    {row.windows.length > 0 && <div className={`${G}usage-wins`}>{row.windows.map(window => <WindowLine key={window.key} window={window} filled={filled} />)}</div>}
    {/* A prepaid balance in its own currency, dollars as `$`. */}
    {row.balance && <div className={`${G}usage-bal`}><span className={`${G}usage-bl`}>balance</span><span className={`${G}usage-bv`}>
      {row.balance.currency === "USD" ? `$${row.balance.total}` : `${row.balance.total} ${row.balance.currency}`}</span></div>}
    {row.unreported && <div className={`${G}usage-note`}>no windows reported</div>}
    {row.blocks.map(block => <div key={block.scope} className={`${G}usage-note`} data-tone="warn">
      {block.scope ? `${block.scope} requests` : "all requests"} blocked <BlockLift until={block.until} />
    </div>)}
  </>;
}
function BlockLift({ until }: { until: number }) {
  const text = useClockText(nowMs => when(until, nowMs));
  return <><span aria-hidden="true">↻ </span><span className="plugin-atyrode_code__sr">until </span>{text}</>;
}

/**
 * One grid cell per account, providers in order. A provider's name heads its first account; a later
 * account repeats it only where it starts a grid row, and in one column never (`data-cont`, placed
 * from the laid-out cells, so it follows any width without a breakpoint).
 */
export function ProviderGrid({ groups, filled, identity }: {
  groups: readonly UsageGroup[]; filled: boolean; identity: (row: UsageAccountRow) => ReactNode;
}) {
  const grid = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    const place = () => {
      const cells = [...element.children] as HTMLElement[];
      if (cells.length === 0 || element.offsetParent === null) return;
      const left = cells[0]!.offsetLeft;
      const columns = new Set(cells.map(cell => cell.offsetLeft)).size;
      for (const cell of cells) {
        const name = cell.firstElementChild as HTMLElement | null;
        if (name?.dataset.cont !== undefined) name.dataset.cont = columns === 1 ? "gone" : cell.offsetLeft === left ? "lead" : "";
      }
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  });
  return <div ref={grid} className={`${G}usage-providers`}>
    {groups.flatMap(group => group.accounts.map((row, index) =>
      <div key={`${group.provider}:${row.key}`} className={`${G}usage-acct`} data-excluded={!row.included || row.disabled || undefined}
        data-hue={hueOf(group.family)} data-usage-account={row.who}>
        <div className={`${G}usage-pname`} data-cont={index > 0 ? "" : undefined}>
          {providerWord(group)}{group.history && <span className={`${G}usage-age`}>{ageText(group.history.ageMs)}</span>}
        </div>
        {identity(row)}
        <AccountReadings row={row} filled={filled} />
      </div>))}
  </div>;
}

/** The words the panes say in place of a grid. */
export function UsageNote({ state }: { state: Exclude<UsageState, { kind: "groups" }> }) {
  return <div className={`${G}usage-note`} data-tone={state.kind === "unavailable" ? "warn" : undefined} role="status">
    {state.kind === "unset" ? "no account choices yet" : state.kind === "unread" ? "not read yet" : state.kind === "unavailable" ? "accounts unavailable" : "no accounts"}
  </div>;
}

/** `next refresh 4:54 · r · now`, then any cues the view adds. */
export function RefreshLine({ cadence, children }: { cadence: UsageCadence; children?: ReactNode }) {
  const text = useClockText(nowMs => {
    if (cadence.refreshing) return "refreshing…";
    // Due while the person is in the middle of something: it reads once they are done.
    if (cadence.waiting) return "refresh waits";
    const left = Math.max(0, cadence.nextAt - nowMs);
    return `next refresh ${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")}`;
  });
  return <div className={`${G}usage-refresh`}>
    {/* As wide as its widest text, so the line's button never moves when a refresh starts or ends. */}
    <span className={`${G}usage-next`} data-sizer="next refresh 0:00">{text}</span>
    <Button aria-keyshortcuts="r" title="Read the usage now (r)" data-refresh-now="" onClick={cadence.now}>Refresh now</Button>
    {children}
  </div>;
}

// ---------------------------------------------------------------- the usage pane

/** The usage pane's body, under the shell's `usage` head: the providers' accounts, then the next refresh. */
export function UsagePane({ usage, cadence }: { usage: BoardUsage; cadence: UsageCadence }) {
  const { state } = useShownReading(usage);
  const filled = useBarsFilled(cadence.refreshing);
  return <div className={`${G}usage-body`} data-usage-pane="">
    {state.kind === "groups"
      ? <ProviderGrid groups={state.groups} filled={filled} identity={row => <span className={`${G}usage-who`}>
        <span className={`${G}usage-name`} title={row.who}>{row.who}</span>{row.ageMs !== null && <span className={`${G}usage-age`}>{ageText(row.ageMs)}</span>}
      </span>} />
      : <UsageNote state={state} />}
    <RefreshLine cadence={cadence} />
  </div>;
}
