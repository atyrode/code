import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ThinkingLevelSchema } from "@atyrode/manifold-omp";
import { prefersReducedMotion } from "@manifold/ui";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import { DomainError } from "../../domain/contracts.ts";
import { providerPolicy } from "../../domain/providers.ts";
import { quotaPools, roleOutcomes, type QuotaPool, type RoleOutcome } from "../../domain/quota.ts";
import type { Review } from "../../domain/routing.ts";
import { accountWord, ago, familyWord, hueOf } from "../ui.tsx";
import { displayAliases } from "./aliases.ts";
import { boardView, effortWord, ROSTER_BELOW_PX, when, type BoardColumn, type BoardPreview, type BoardSeat, type BoardUsage, type SeatLine } from "./board-model.ts";
import { balanceText, headRowCount, Parts, PoolHead } from "./pool-head.tsx";
import type { WorkbenchModel } from "./workbench-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
const THINKING = ThinkingLevelSchema.options;

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

/**
 * Whether the board is the roster: the panel's content box (`.plugin-atyrode_code` less its padding)
 * is narrower than `ROSTER_BELOW_PX`. Measured before paint and on every resize, so the first frame
 * is already in its form and the statement, measuring the same box, changes form with the board.
 * `remeasure` subscribes again when it changes, for a ref that mounts after its component.
 */
export function useRosterForm(from: RefObject<HTMLElement | null>, remeasure?: unknown): boolean {
  const [roster, setRoster] = useState(false);
  useLayoutEffect(() => {
    const panel = from.current?.closest<HTMLElement>(".plugin-atyrode_code") ?? from.current?.parentElement;
    if (!panel) return;
    const judge = (width: number) => { if (width > 0) setRoster(width < ROSTER_BELOW_PX); };
    const style = getComputedStyle(panel);
    judge(panel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const observer = new ResizeObserver(entries => { for (const entry of entries) judge(entry.contentRect.width); });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [remeasure]);
  return roster;
}

/**
 * A keyboard commit draws no flight, so the roles it moved keep a brief afterglow on their new
 * seats; a commit by pointer, and any commit under reduced motion, leave none. The last input
 * decides which it was, read on the document because the key that commits lands on the statement.
 */
function useAfterglow(root: RefObject<HTMLElement | null>, review: Review | null, mounted: boolean) {
  const keyboard = useRef(false);
  const leads = useRef<ReadonlyMap<string, string> | null>(null);
  useEffect(() => {
    const document = root.current?.ownerDocument;
    if (!document) return;
    const key = () => { keyboard.current = true; };
    const point = () => { keyboard.current = false; };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", point, true);
    return () => { document.removeEventListener("keydown", key, true); document.removeEventListener("pointerdown", point, true); };
  }, [mounted]);
  useLayoutEffect(() => {
    const now = new Map(review?.routes.map(route => [route.role, route.lead.key]) ?? []);
    const before = leads.current;
    leads.current = now;
    const box = root.current;
    if (!before || !box || !keyboard.current || prefersReducedMotion()) return;
    for (const [role, key] of now) {
      if (before.get(role) === key) continue;
      for (const element of box.querySelectorAll<HTMLElement>(`[data-role="${CSS.escape(role)}"]`)) {
        element.animate([{ backgroundColor: "var(--code-afterglow)", color: "var(--code-text-bright)" }, { backgroundColor: "transparent" }],
          { duration: 900, easing: "cubic-bezier(.23, 1, .32, 1)" });
      }
    }
  }, [review]);
}

type SeatBoardProps = {
  model: Pick<WorkbenchModel, "compiled" | "review" | "served" | "gate">;
  usage: BoardUsage;
  /** The pointed team (a ghost, a drum option, the fix line, a recent team), drawn as moves without being chosen. */
  preview: BoardPreview | null;
  pools: readonly QuotaPool[];
  outcomes: readonly RoleOutcome[];
};

/**
 * The seat board: provider columns headed by their quota pools, tier rows of model seats, each role
 * on the seat that leads it. From 560px of panel width up, columns by tier rows; below, a roster
 * grouped by provider, whose pointed team the status line says as moves (`movesText`). Both draw one `boardView`.
 */
export function SeatBoard({ model, usage, preview, pools, outcomes }: SeatBoardProps) {
  const { compiled, review, served } = model;
  const root = useRef<HTMLElement>(null);
  const [open, setOpen] = useState<string | null>(null);
  const aliases = useMemo(() => compiled ? displayAliases(compiled) : new Map<string, string>(), [compiled]);
  const board = useMemo(() => {
    if (!compiled || !review) return null;
    // A team reviewed against another catalog has no seats here (`seatBoard` refuses it); the gate refuses it on its own.
    try { return boardView({ catalog: compiled, review, preview: preview?.review ?? null, pools, outcomes, served, reading: usage }); }
    catch (error) { if (error instanceof DomainError) return null; throw error; }
  }, [compiled, review, preview?.key, pools, outcomes, served, usage.view, usage.current, usage.nowMs]);
  const shown = compiled !== null && board !== null;
  // The board is not mounted while the team is read, so its form is measured again once it is.
  const form = useRosterForm(root, shown) ? "roster" : "grid";
  useAfterglow(root, shown ? review : null, shown);
  if (!compiled || !board) return null;
  const accountsGate = model.gate("edit-accounts");
  const quiet = board.reading === "unread" || board.reading === "unavailable";
  const notice = board.reading === "unread" ? "accounts not read yet · capacity unknown, not zero"
    : board.reading === "unavailable" ? "accounts unavailable · capacity unknown, not zero" : null;
  const draw = { compiled, aliases, nowMs: usage.nowMs, rungs: board.rungs, tiers: board.tiers };
  const headOf = (column: BoardColumn, grid: { column: number; rows: typeof board.headRows } | null) => <PoolHead head={column.head} usage={usage}
    accountsGate={accountsGate} grid={grid} quiet={quiet} idle={column.idle} open={open === column.family}
    seats={grid && column.collapsed ? <Bench seats={column.bench} draw={draw} /> : undefined}
    onToggle={() => setOpen(previous => previous === column.family ? null : column.family)} />;
  // The heads take the first rows, as many as the most any head reserves; the tier rows follow.
  const first = headRowCount(board.headRows) + 1;
  // A provider that serves nothing takes only the width its head needs; the seated ones share the rest, capped from 1100px.
  const template = (seated: string) => `max-content ${board.columns.map(column => column.collapsed ? "max-content" : seated).join(" ")}`;
  return <section ref={root} className={`${G}section ${G}board`} data-form={form} aria-labelledby={`${G}board-title`}>
    <h2 id={`${G}board-title`} className="plugin-atyrode_code__sr">Seats</h2>
    {notice && <p className={`${G}board-line`} title={notice}>{notice}</p>}
    {form === "grid" ? <div className={`${G}board-grid`}
      style={{ "--board-template": template("minmax(0, 1fr)"), "--board-template-wide": template("minmax(0, 18rem)") } as CSSProperties}>
      {board.rungs.map((rung, index) => <div key={rung} className={`${G}rung`} data-current={board.tiers[index] === board.capability || undefined}
        aria-hidden="true" style={{ gridRow: first + index }}>{rung}</div>)}
      {board.columns.map((column, index) => <Fragment key={column.family}>
        {headOf(column, { column: index + 2, rows: board.headRows })}
        {column.collapsed ? <Arrivals column={column} draw={draw} style={{ gridRow: `${first} / span ${board.tiers.length}`, gridColumn: index + 2 }} />
          : column.cells.map((seat, row) => {
            const style = { gridRow: first + row, gridColumn: index + 2 };
            if (seat) return <Seat key={seat.key} seat={seat} draw={draw} style={style} />;
            // A capability rung this provider has no model for says so; a special rung (Spark) belongs to its own provider only.
            const tier = board.tiers[row]!;
            return tier >= 1 ? <div key={`empty:${tier}`} className={`${G}seat-empty`} style={style}>no {board.rungs[row]} {familyWord(column.family)} model</div> : null;
          })}
      </Fragment>)}
    </div> : <div className={`${G}roster`}>
      {board.columns.map(column => <div key={column.family} className={`${G}roster-block`} data-fam={hueOf(column.family)}>
        {headOf(column, null)}
        {column.seated.map(seat => {
          const alias = aliases.get(seat.key) ?? seat.key, rung = draw.rungs[draw.tiers.indexOf(seat.tier)];
          const note = ownNote(seat, draw.nowMs);
          return <div key={seat.key} className={`${G}roster-row`} role="group" aria-label={seatName(seat, draw)} data-stranded={seat.stranded || undefined}>
            <span className={`${G}roster-model`} aria-hidden="true">
              <span className={`${G}seat-alias`} title={compiled.model(seat.key).id}>{alias}</span>
              {/* Spark's seat is its own rung's name: said once. */}
              {rung !== alias && <span className={`${G}roster-rung`}>{rung}</span>}
            </span>
            {note && <span className={`${G}seat-note`}><Parts parts={note} /></span>}
            <Lines seat={seat} draw={draw} />
          </div>;
        })}
        {column.bench.length > 0 && <Bench seats={column.bench} draw={draw} />}
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

/**
 * The state of the pool a seat draws on when it meters apart from its column's head (Spark's own
 * quota), idle or not, so it never appears under a pointer. Its level is the mean of its present
 * readings, as a head's is; an unread or unreported reading is unknown, never blamed on the provider.
 */
function ownNote(seat: BoardSeat, nowMs: number): readonly string[] | null {
  const own = seat.own;
  if (!own) return null;
  const { verdict } = own;
  if (verdict.kind === "blocked" || verdict.kind === "maxed") return ["own quota", verdict.until === null ? verdict.kind : `${verdict.kind} until ${when(verdict.until, nowMs)}`];
  if (verdict.kind === "stale") return ["own quota", verdict.ageMs === null ? "age unknown" : `${ago(verdict.ageMs)} old`];
  if (verdict.kind === "tight" || verdict.kind === "unknown") return ["own quota", verdict.kind];
  if (verdict.kind === "none") return ["own quota", "no account"];
  const present = own.windows.flatMap(window => window.status === "fresh" && window.state.percent !== null ? [Math.min(100, window.state.percent)] : []);
  return ["own quota", present.length ? `${Math.round(present.reduce((sum, used) => sum + used, 0) / present.length)}%` : "unknown"];
}

/** A seat in its column: the model in its provider's hue, the arrivals slot, its pool's own state when it meters apart, its role lines. */
function Seat({ seat, draw, style }: { seat: BoardSeat; draw: Draw; style: CSSProperties }) {
  const note = ownNote(seat, draw.nowMs);
  return <div className={`${G}seat`} data-fam={hueOf(seat.family)} data-idle={seat.lines.length ? undefined : ""} data-stranded={seat.stranded || undefined}
    data-arrive={seat.arriving.length ? seat.arrivingStranded ? "stop" : "go" : undefined} role="group" aria-label={seatName(seat, draw)} style={style}>
    <div className={`${G}seat-head`}>
      <span className={`${G}seat-alias`} aria-hidden="true" title={draw.compiled.model(seat.key).id}>{draw.aliases.get(seat.key) ?? seat.key}</span>
      {/* Reserved geometry: one line whether a pointed team brings roles here or not. */}
      <span className={`${G}seat-arrive`}>{seat.arriving.length ? `+ ${seat.arriving.join(", ")}` : ""}</span>
    </div>
    {note && <div className={`${G}seat-note`}><Parts parts={note} /></div>}
    {seat.lines.length > 0 && <Lines seat={seat} draw={draw} />}
  </div>;
}

/**
 * Where a pointed team would seat roles in a column that has none: each arriving seat with its
 * roles, at the top of the column's empty body. Size-contained, so it fills the space the other
 * columns' seats already make and pointing never moves anything.
 */
function Arrivals({ column, draw, style }: { column: BoardColumn; draw: Draw; style: CSSProperties }) {
  const arriving = column.bench.filter(seat => seat.arriving.length > 0);
  if (!arriving.length) return null;
  return <div className={`${G}board-arrivals`} style={style} aria-hidden="true">{arriving.map(seat =>
    <p key={seat.key} className={`${G}board-arrival`} data-fam={hueOf(seat.family)} data-arrive={seat.arrivingStranded ? "stop" : "go"}>
      <span className={`${G}seat-alias`}>{draw.aliases.get(seat.key) ?? seat.key}</span> + {seat.arriving.join(", ")}
    </p>)}</div>;
}

/** Pips | content: fates and chains sit in the roles' column, so they align with the roles they describe. */
function Lines({ seat, draw }: { seat: BoardSeat; draw: Draw }) {
  return <div className={`${G}seat-lines`}>{seat.lines.map((line, index) => <Fragment key={index}>
    <span className={`${G}pips`} aria-hidden="true">{THINKING.map((level, step) =>
      <i key={level} data-on={step <= THINKING.indexOf(line.thinking) || undefined} />)}</span>
    <ul className={`${G}roles`} data-level={line.thinking} data-stranded={line.fate?.kind === "no-route" || line.fate?.kind === "no-account" || undefined}
      aria-label={`${effortWord(line.thinking)} thinking`}>
      {line.roles.map(({ role, change }) => <li key={role} data-role={role} data-main={role === "default" || undefined} data-change={change ?? undefined}>{role}</li>)}
    </ul>
    <LineFate line={line} draw={draw} />
  </Fragment>)}</div>;
}

function LineFate({ line, draw }: { line: SeatLine; draw: Draw }) {
  const alias = (key: string) => <span className={`${G}chain-alias`} data-fam={hueOf(draw.compiled.family(key))}>{draw.aliases.get(key) ?? key}</span>;
  const { fate } = line;
  if (fate?.kind === "falls-back") {
    return <span className={`${G}fate`} data-kind={fate.kind} title="Its lead's pool is out: the first fallback takes over unless its pool is out too">
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

/** Seats nobody sits on, as one idle line. A seat a pointed team would fill takes its hue (attention when the roles would be stranded there). */
function Bench({ seats, draw }: { seats: readonly BoardSeat[]; draw: Draw }) {
  return <div className={`${G}bench`}>
    <span className={`${G}bench-label`} aria-hidden="true">idle</span>
    <ul aria-label="idle seats">{seats.map(seat => <li key={seat.key} className={`${G}bench-seat`} data-fam={hueOf(seat.family)}
      data-arrive={seat.arriving.length ? seat.arrivingStranded ? "stop" : "go" : undefined} title={draw.compiled.model(seat.key).id}
      aria-label={seat.arriving.length ? `${draw.aliases.get(seat.key) ?? seat.key}, ${seat.arriving.join(", ")} would move here` : undefined}>
      {draw.aliases.get(seat.key) ?? seat.key}</li>)}</ul>
  </div>;
}
