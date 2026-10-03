import { Fragment, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ThinkingLevelSchema } from "@atyrode/manifold-omp";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import { DomainError } from "../../domain/contracts.ts";
import { providerPolicy } from "../../domain/providers.ts";
import { quotaPools, roleOutcomes, type QuotaPool, type RoleOutcome } from "../../domain/quota.ts";
import { accountWord, ago, hueOf } from "../ui.tsx";
import { displayAliases } from "./dials.tsx";
import { boardView, ROSTER_BELOW_PX, type BoardMove, type BoardPreview, type BoardSeat, type BoardUsage, type BoardView, type SeatLine } from "./board-model.ts";
import { balanceText, PoolHead, when } from "./pool-head.tsx";
import type { WorkbenchModel } from "./workbench-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (board.css). */
const G = "plugin-atyrode_code_generator__";
const THINKING = ThinkingLevelSchema.options;
const EFFORT_WORDS: Readonly<Record<string, string>> = { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "x-high", max: "max" };

/** The pools of the shown catalog and what every role of the shown team runs: one quota truth for the board and the statement. */
export type BoardModel = { readonly pools: readonly QuotaPool[]; readonly outcomes: readonly RoleOutcome[] };

/**
 * Pools from the usage reading and each role's outcome on the shown team (the reviewed composition
 * while it is current, else the local review), recomputed only when the catalog, the team or the
 * reading changes. Pass the same `usage` to `SeatBoard`.
 */
export function useBoardModel(model: Pick<WorkbenchModel, "compiled" | "review">, usage: BoardUsage): BoardModel {
  const { compiled, review } = model;
  const { view, current, nowMs } = usage;
  const pools = useMemo(() => compiled ? quotaPools(compiled, { view, current, nowMs }) : [], [compiled, view, current, nowMs]);
  const outcomes = useMemo(() => compiled && review ? roleOutcomes(compiled, review.routes, pools) : [], [compiled, review, pools]);
  return useMemo(() => ({ pools, outcomes }), [pools, outcomes]);
}

type SeatBoardProps = {
  model: Pick<WorkbenchModel, "compiled" | "review" | "served" | "gate">;
  usage: BoardUsage;
  /** The pointed team (a ghost, a drum option, the fix line), drawn as moves without being chosen. */
  preview: BoardPreview | null;
  pools: readonly QuotaPool[];
  outcomes: readonly RoleOutcome[];
};

/**
 * The seat board: provider columns headed by their quota pools, tier rows of model seats, each role
 * on the seat that leads it. From 560px of panel width up, columns by tier rows; below, a roster
 * grouped by provider that says a pointed team as before → after. Both draw one `boardView`.
 */
export function SeatBoard({ model, usage, preview, pools, outcomes }: SeatBoardProps) {
  const { compiled, review, served } = model;
  const root = useRef<HTMLElement>(null);
  const [form, setForm] = useState<"grid" | "roster">("grid");
  const [open, setOpen] = useState<string | null>(null);
  // The form follows the panel's width, measured before paint so the first frame is already the right one.
  useLayoutEffect(() => {
    const panel = root.current?.closest<HTMLElement>(".plugin-atyrode_code") ?? root.current?.parentElement;
    if (!panel) return;
    const judge = (width: number) => { if (width > 0) setForm(width < ROSTER_BELOW_PX ? "roster" : "grid"); };
    const style = getComputedStyle(panel);
    judge(panel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const observer = new ResizeObserver(entries => { for (const entry of entries) judge(entry.contentRect.width); });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const aliases = useMemo(() => compiled ? displayAliases(compiled) : new Map<string, string>(), [compiled]);
  const board = useMemo(() => {
    if (!compiled || !review) return null;
    // A team reviewed against another catalog has no seats here (`seatBoard` refuses it); the gate refuses it on its own.
    try { return boardView({ catalog: compiled, review, preview: preview?.review ?? null, pools, outcomes, served, reading: usage }); }
    catch (error) { if (error instanceof DomainError) return null; throw error; }
  }, [compiled, review, preview?.key, pools, outcomes, served, usage.view, usage.current, usage.nowMs]);
  if (!compiled || !board) return null;
  const accountsGate = model.gate("edit-accounts");
  const quiet = board.reading === "unread" || board.reading === "unavailable";
  const notice = board.reading === "unread" ? "accounts not read yet · capacity unknown, not zero"
    : board.reading === "unavailable" ? "accounts unavailable · capacity unknown, not zero" : null;
  const moves = form === "roster" ? movesText(board.moves, aliases) : "";
  const headOf = (column: BoardView["columns"][number], style?: CSSProperties) => <PoolHead head={column.head} usage={usage} accountsGate={accountsGate}
    rows={form === "grid" ? board.headRows : null} quiet={quiet} open={open === column.family} style={style}
    onToggle={() => setOpen(previous => previous === column.family ? null : column.family)} />;
  const draw = { compiled, aliases, nowMs: usage.nowMs, rungs: board.rungs, tiers: board.tiers };
  return <section ref={root} className={`${G}board`} data-form={form} aria-labelledby={`${G}board-title`}>
    <h2 id={`${G}board-title`} className="plugin-atyrode_code__sr">Seats</h2>
    {/* The roster reserves its preview line, so pointing at a team never moves the rows; columns need one only for a notice. */}
    {(form === "roster" || notice) && <p className={`${G}board-line`} title={moves || notice || undefined}>{moves || notice}</p>}
    {form === "grid" ? <div className={`${G}board-grid`} style={{ "--board-columns": board.columns.length } as CSSProperties}>
      {board.rungs.map((rung, index) => <div key={rung} className={`${G}rung`} data-current={board.tiers[index] === board.capability || undefined}
        aria-hidden="true" style={{ gridRow: index + 2 }}>{rung}</div>)}
      {board.columns.map((column, index) => <Fragment key={column.family}>
        {headOf(column, { gridRow: 1, gridColumn: index + 2 })}
        {column.collapsed ? <Bench seats={column.bench} label="idle" draw={draw} style={{ gridRow: `2 / span ${board.tiers.length}`, gridColumn: index + 2 }} />
          : column.cells.map((seat, row) => seat && <Seat key={seat.key} seat={seat} draw={draw} style={{ gridRow: row + 2, gridColumn: index + 2 }} />)}
      </Fragment>)}
    </div> : <div className={`${G}roster`}>
      {board.columns.map(column => <div key={column.family} className={`${G}roster-block`} data-fam={hueOf(column.family)}>
        {headOf(column)}
        {column.seated.map(seat => {
          const alias = aliases.get(seat.key) ?? seat.key, rung = draw.rungs[draw.tiers.indexOf(seat.tier)];
          return <div key={seat.key} className={`${G}roster-row`} role="group" aria-label={seatName(seat, draw)} data-stranded={seat.stranded || undefined}>
            <span className={`${G}roster-model`} aria-hidden="true">
              <span className={`${G}seat-alias`} title={compiled.model(seat.key).id}>{alias}</span>
              {/* Spark's seat is its own rung's name: said once. */}
              {rung !== alias && <span className={`${G}roster-rung`}>{rung}</span>}
            </span>
            <Lines seat={seat} draw={draw} />
          </div>;
        })}
        {column.bench.length > 0 && <Bench seats={column.bench} label={column.collapsed ? "idle" : "bench"} draw={draw} />}
      </div>)}
    </div>}
    {board.outside.length > 0 && <p className={`${G}board-outside`}>{board.outside.map(entry =>
      `${accountWord(entry.family ?? entry.provider)}${entry.balances.length ? ` ${entry.balances.map(balanceText).join(" · ")}` : ""}`).join(" · ")} · not in this catalog</p>}
  </section>;
}

type Draw = { compiled: CompiledCatalog; aliases: ReadonlyMap<string, string>; nowMs: number; rungs: readonly string[]; tiers: readonly number[] };

function seatName(seat: BoardSeat, draw: Draw): string {
  return `${draw.aliases.get(seat.key) ?? seat.key}, ${draw.rungs[draw.tiers.indexOf(seat.tier)]}${seat.lines.length ? "" : ", idle"}`;
}

/** A seat in its column: the model in its provider's hue, its pool's own state when it meters apart, the arrivals slot, its role lines. */
function Seat({ seat, draw, style }: { seat: BoardSeat; draw: Draw; style: CSSProperties }) {
  // An idle seat's own pool is said only when a pointed team would seat roles on it.
  const own = seat.lines.length || seat.arriving.length ? seat.own : null;
  const present = own?.windows.flatMap(window => window.status === "fresh" && window.state.percent !== null ? [window.state.percent] : []) ?? [];
  const ownNote = !own ? null : own.verdict.kind === "blocked" || own.verdict.kind === "maxed"
    ? `own quota · ${own.verdict.kind}${own.verdict.until === null ? "" : ` until ${when(own.verdict.until, draw.nowMs)}`}`
    : own.verdict.kind === "stale" ? `own quota · ${own.verdict.ageMs === null ? "age unknown" : `${ago(own.verdict.ageMs)} old`}`
    : own.verdict.kind === "tight" ? "own quota · tight" : own.verdict.kind === "none" ? "own quota · no account"
    : present.length ? `own quota · ${Math.round(Math.max(...present))}%` : "own quota · not reported";
  return <div className={`${G}seat`} data-fam={hueOf(seat.family)} data-idle={seat.lines.length ? undefined : ""} data-stranded={seat.stranded || undefined}
    data-arrive={seat.arriving.length ? seat.arrivingStranded ? "stop" : "go" : undefined} role="group" aria-label={seatName(seat, draw)} style={style}>
    <div className={`${G}seat-head`}>
      <span className={`${G}seat-alias`} aria-hidden="true" title={draw.compiled.model(seat.key).id}>{draw.aliases.get(seat.key) ?? seat.key}</span>
      {ownNote && <span className={`${G}seat-note`}>{ownNote}</span>}
      {/* Reserved geometry: one line whether a pointed team brings roles here or not. */}
      <span className={`${G}seat-arrive`}>{seat.arriving.length ? `+ ${seat.arriving.join(" ")}` : ""}</span>
    </div>
    {seat.lines.length > 0 && <Lines seat={seat} draw={draw} />}
  </div>;
}

/** Pips | content: fates and chains sit in the roles' column, so they align with the roles they describe. */
function Lines({ seat, draw }: { seat: BoardSeat; draw: Draw }) {
  return <div className={`${G}seat-lines`}>{seat.lines.map((line, index) => <Fragment key={index}>
    <span className={`${G}pips`} aria-hidden="true">{THINKING.map((level, step) =>
      <i key={level} data-on={step <= THINKING.indexOf(line.thinking) || undefined} />)}</span>
    <ul className={`${G}roles`} data-level={line.thinking} data-stranded={line.fate?.kind === "no-route" || line.fate?.kind === "no-account" || undefined}
      aria-label={`${EFFORT_WORDS[line.thinking] ?? line.thinking} thinking`}>
      {line.roles.map(({ role, change }) => <li key={role} data-main={role === "default" || undefined} data-change={change ?? undefined}>{role}</li>)}
    </ul>
    <LineFate line={line} draw={draw} />
  </Fragment>)}</div>;
}

function LineFate({ line, draw }: { line: SeatLine; draw: Draw }) {
  const alias = (key: string) => <span className={`${G}chain-alias`} data-fam={hueOf(draw.compiled.family(key))}>{draw.aliases.get(key) ?? key}</span>;
  const { fate } = line;
  if (fate?.kind === "falls-back") {
    return <span className={`${G}fate`} data-kind={fate.kind} title="Its lead's pool is out: the first fallback with room takes over until it reopens">
      → {alias(fate.model.key)} {fate.until === null ? "· reset unknown" : `until ${when(fate.until, draw.nowMs)}`}</span>;
  }
  if (fate?.kind === "no-route") {
    return <span className={`${G}fate`} data-kind={fate.kind} title="Its lead's pool and every fallback's are out">
      no route {fate.until === null ? "· reset unknown" : `until ${when(fate.until, draw.nowMs)}`}</span>;
  }
  if (fate?.kind === "no-account") {
    const word = accountWord(providerPolicy(fate.provider).family, fate.provider);
    return <span className={`${G}fate`} data-kind={fate.kind} title={`No included ${word} account serves its lead; the session refuses it`}>no {word} account</span>;
  }
  if (!line.chain.length && !line.pruned.length) return null;
  const dropped = line.pruned.map(provider => accountWord(providerPolicy(provider).family, provider));
  const kept = line.chain.map(choice => draw.aliases.get(choice.key) ?? choice.key);
  // The whole chain, for a column too narrow to show it.
  const title = [kept.length ? `then ${kept.join(" › ")}` : "", dropped.length ? `no included ${dropped.join(" or ")} account: the session drops those fallbacks` : ""].filter(Boolean).join(" · ");
  return <span className={`${G}chain`} title={title}>
    {line.chain.length > 0 && <>then {line.chain.map((choice, index) => <Fragment key={choice.key}>{index > 0 && " › "}{alias(choice.key)}</Fragment>)}</>}
    {dropped.length > 0 && <>{line.chain.length ? " · " : ""}{dropped.join(", ")} dropped</>}
  </span>;
}

/** Seats nobody sits on, as one line: a provider with no seated role is its pool head and this line. Arrivals mark by colour only, so it never rewraps. */
function Bench({ seats, label, draw, style }: { seats: readonly BoardSeat[]; label: string; draw: Draw; style?: CSSProperties }) {
  return <div className={`${G}bench`} style={style}>
    <span className={`${G}bench-label`} aria-hidden="true">{label}</span>
    <ul aria-label={`${label} seats`}>{seats.map(seat => <li key={seat.key} className={`${G}bench-seat`} data-fam={hueOf(seat.family)}
      data-arrive={seat.arriving.length ? seat.arrivingStranded ? "stop" : "go" : undefined} title={draw.compiled.model(seat.key).id}
      aria-label={seat.arriving.length ? `${draw.aliases.get(seat.key) ?? seat.key}, ${seat.arriving.join(", ")} would move here` : undefined}>
      {draw.aliases.get(seat.key) ?? seat.key}</li>)}</ul>
  </div>;
}

/** The pointed team as the roster says it: `default, task sol → astra · plan high → x-high`. */
function movesText(moves: readonly BoardMove[], aliases: ReadonlyMap<string, string>): string {
  const name = (key: string) => aliases.get(key) ?? key;
  return moves.map(move => {
    const roles = move.roles.join(", ");
    switch (move.kind) {
      case "move": return `${roles} ${name(move.from)} → ${name(move.to)}`;
      case "add": return `${roles} → ${name(move.to)}`;
      case "remove": return `${roles} ${name(move.from)} → off`;
      case "effort": return `${roles} ${EFFORT_WORDS[move.from] ?? move.from} → ${EFFORT_WORDS[move.to] ?? move.to}`;
    }
  }).join(" · ");
}
