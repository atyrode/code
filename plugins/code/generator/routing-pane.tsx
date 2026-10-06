import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { prefersReducedMotion } from "@manifold/ui";
import { hueOf } from "../ui.tsx";
import type { LedgerRow, ProfileGroup, RouteToken } from "./routing-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
const EASE = "cubic-bezier(.2, .8, .2, 1)";

/** A pointed routing value, and why quota leaves it out when it does. */
type Pointed = { readonly value: RouteToken; readonly reason: string | null };

const hue = (family: string): CSSProperties => ({ "--h": `var(--code-${hueOf(family)})` } as CSSProperties);
/** What a token's drawing depends on: a change of any of these rolls it. */
const signature = (value: RouteToken | null, reason: string | null) => value ? `${value.alias}:${value.thinking}:${value.family}:${reason !== null}` : "off";

function Value({ value, reason }: { value: RouteToken | null; reason: string | null }) {
  if (!value) return <span className={`${G}tok-value`} data-off="">off</span>;
  return <span className={`${G}tok-value`} data-down={reason !== null || undefined} style={hue(value.family)}>
    <span className={`${G}tok-alias`}>{value.alias}</span><span className={`${G}tok-thinking`}>:{value.thinking}</span>
  </span>;
}

/**
 * A routing value that rolls like an odometer when it changes: the old one leaves upward while the
 * new one rises into its place, starting in the old one's colour and settling into its own. Under
 * reduced motion it is simply replaced. `onChanged` hears a roll, so the row can flash.
 */
function Token({ value, reason, delay, onPoint, onChanged }: {
  value: RouteToken | null; reason: string | null; delay: number; onPoint: (token: Pointed | null) => void; onChanged?: () => void;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const [layers, setLayers] = useState(() => [{ id: 0, value, reason, leaving: false }]);
  const shown = layers.at(-1)!;
  if (signature(shown.value, shown.reason) !== signature(value, reason)) {
    // Derived during render, React's documented pattern for state that follows a prop; the effect below animates and prunes.
    const still = prefersReducedMotion();
    setLayers([...still ? [] : layers.map(layer => ({ ...layer, leaving: true })), { id: shown.id + 1, value, reason, leaving: false }]);
  }
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || layers.length < 2) return;
    const [entering, ...leaving] = [...node.children].reverse() as HTMLElement[];
    const from = leaving[0] ? getComputedStyle(leaving[0]).color : null;
    const to = entering ? getComputedStyle(entering).color : null;
    for (const old of leaving) {
      old.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(-100%)", opacity: 0 }], { duration: 220, delay, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" });
    }
    entering?.animate([{ transform: "translateY(100%)", opacity: 0, color: from ?? to ?? "inherit", easing: EASE }, { transform: "none", opacity: 1, color: from ?? to ?? "inherit", offset: 0.45 },
      { transform: "none", opacity: 1, color: to ?? "inherit" }], { duration: 560, delay: delay + 60, fill: "backwards" })
      .finished.then(() => setLayers(current => current.filter(layer => !layer.leaving)), () => undefined);
    onChanged?.();
  }, [layers.length > 1 ? layers.at(-1)!.id : -1]);
  return <span ref={box} className={`${G}tok`} onPointerEnter={() => onPoint(value ? { value, reason } : null)}>
    {layers.map(layer => <span key={layer.id} className={`${G}tok-layer`} aria-hidden={layer.leaving || undefined}>
      <Value value={layer.value} reason={layer.reason} />
    </span>)}
  </span>;
}

/** A row lights in turn: a bar beside its mark fades, and its role name passes through the accent. */
function flash(row: HTMLElement | null, delay: number) {
  if (!row || prefersReducedMotion()) return;
  row.querySelector(`.${G}route-mark`)?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 760, delay, easing: EASE, pseudoElement: "::before" });
  const role = row.querySelector<HTMLElement>(`.${G}route-role`);
  const accent = getComputedStyle(row).getPropertyValue("--tui-acc").trim();
  role?.animate([{ color: accent }, { color: accent, offset: 0.2 }, { color: getComputedStyle(role).color }], { duration: 760, delay, easing: EASE, fill: "backwards" });
}

/** The team "goes": every routing row and every profile role lights in turn, top to bottom. */
export function rippleTeam(scope: HTMLElement | null) {
  if (!scope || prefersReducedMotion()) return;
  [...scope.querySelectorAll<HTMLElement>(`.${G}route:not([data-off])`)].forEach((row, index) => { if (row.offsetParent) flash(row, 60 + index * 34); });
  const accent = getComputedStyle(scope).getPropertyValue("--tui-acc").trim();
  [...scope.querySelectorAll<HTMLElement>(`.${G}profile-role`)].forEach((role, index) => {
    if (role.offsetParent) role.animate([{ color: accent }, { color: getComputedStyle(role).color }], { duration: 700, delay: 60 + index * 30, easing: EASE, fill: "backwards" });
  });
}

function RouteRow({ row, index, chains, onPoint }: { row: LedgerRow; index: number; chains: boolean; onPoint: (token: Pointed | null) => void }) {
  const element = useRef<HTMLLIElement>(null);
  const delay = index * 18;
  const fallback = chains && !row.off ? row.fallback : [];
  return <li ref={element} className={`${G}route`} data-role={row.role} data-off={row.off || undefined}>
    <span className={`${G}route-mark`}>{row.agentBacked ? "●" : ""}{row.agentBacked && <span className="plugin-atyrode_code__sr">, agent</span>}</span>
    <span className={`${G}route-role`}>{row.role}</span>
    <span className={`${G}chain`}>
      <Token value={row.lead} reason={row.down} delay={delay} onPoint={onPoint} onChanged={() => flash(element.current, delay)} />
      {fallback.map((choice, step) => <span key={step} className={`${G}chain-step`} style={{ "--step-delay": `${index * 16 + step * 60}ms` } as CSSProperties}>
        <span className={`${G}chain-arrow`} aria-hidden="true">→</span>
        <Token value={choice} reason={null} delay={index * 18 + step * 40} onPoint={onPoint} />
      </span>)}
    </span>
  </li>;
}

export type RoutingPaneProps = {
  readonly ledger: readonly LedgerRow[] | null;
  /** The fallback chains show; only while the profile's fallbacks are on. */
  readonly chains: boolean;
  /** The profile's fallbacks are on, so there are chains to show. */
  readonly fallbacks: boolean;
  readonly onChains: () => void;
  /** The head's cue: `p · hide` beside the generator, `esc · back` as a view of its own. */
  readonly cue: ReactNode;
  readonly hidden: boolean;
};

/**
 * ROUTING: every role on one line, `model:thinking` in its provider's hue, ● for the roles an
 * agent backs, the advisor's line held while it is off. A change rolls each value that moves and
 * flashes its row, top to bottom; a lead quota leaves out is struck and says why under the pointer;
 * `f` shows the fallback chains behind each lead while fallbacks are on.
 */
export function RoutingPane({ ledger, chains, fallbacks, onChains, cue, hidden }: RoutingPaneProps) {
  const [pointed, setPointed] = useState<Pointed | null>(null);
  return <section className={`${G}pane`} data-pane="routing" aria-label="routing" hidden={hidden} tabIndex={-1}>
    <header className={`${G}head`}><h2 className={`${G}title`}>routing</h2>{cue}</header>
    {ledger ? <ol className={`${G}routes`} onPointerLeave={() => setPointed(null)}>
      {ledger.map((row, index) => <RouteRow key={row.role} row={row} index={index} chains={chains && fallbacks} onPoint={setPointed} />)}
    </ol> : <p className={`${G}pane-note`}>no routes yet</p>}
    <div className={`${G}routefoot`}>
      <div className={`${G}route-readout`} data-tone={pointed?.reason ? "warn" : undefined} aria-live="off"
        style={pointed ? { "--rc": `var(--code-${hueOf(pointed.value.family)})` } as CSSProperties : undefined}>
        {pointed && <><b>{pointed.value.alias}:{pointed.value.thinking}</b> · {pointed.reason ?? `${pointed.value.id} · ${pointed.value.effort}`}</>}
      </div>
      <button type="button" className={`${G}chains`} data-off={!fallbacks || undefined} aria-pressed={chains && fallbacks} onClick={onChains}>
        <span className={`${G}cue-key`}>f</span> · {fallbacks ? `${chains ? "hide" : "show"} fallback chains` : "fallbacks off"}
      </button>
    </div>
  </section>;
}

/**
 * The narrow profile, under the generator's rows whenever routing is not beside them: the team
 * grouped by what it runs, each group's `model:thinking` then its roles, ● for the agent-backed. When
 * a change moves a role between groups it glides from where it was to where it lands.
 */
export function Profile({ groups }: { groups: readonly ProfileGroup[] }) {
  const box = useRef<HTMLDivElement>(null);
  const places = useRef(new Map<string, { left: number; top: number }>());
  const known = useRef<ReadonlySet<string>>(new Set());
  const key = groups.map(group => `${group.key}=${group.roles.map(role => role.role).join(",")}`).join(";");
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const origin = node.getBoundingClientRect();
    const before = places.current;
    const after = new Map<string, { left: number; top: number }>();
    const still = prefersReducedMotion() || node.offsetParent === null;
    for (const role of node.querySelectorAll<HTMLElement>(`.${G}profile-role`)) {
      const rect = role.getBoundingClientRect();
      const place = { left: rect.left - origin.left, top: rect.top - origin.top };
      after.set(role.dataset.role!, place);
      const was = before.get(role.dataset.role!);
      if (!still && was && (was.left !== place.left || was.top !== place.top)) {
        role.animate([{ transform: `translate(${was.left - place.left}px, ${was.top - place.top}px)` }, { transform: "none" }], { duration: 340, easing: EASE });
      }
    }
    // A group that was not there before slides in beside the roles that glide to it.
    const leads = [...node.querySelectorAll<HTMLElement>(`.${G}profile-lead`)];
    if (!still && known.current.size) {
      for (const lead of leads) if (!known.current.has(lead.dataset.group!)) lead.animate([{ opacity: 0, transform: "translateX(-6px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: EASE });
    }
    known.current = new Set(leads.map(lead => lead.dataset.group!));
    places.current = after;
  }, [key]);
  return <div ref={box} className={`${G}profile`} aria-label="team">
    {groups.map(group => <Fragment key={group.key}>
      <span className={`${G}profile-lead`} data-down={group.down || undefined} data-group={group.key} style={hue(group.lead.family)}>
        <span className={`${G}tok-alias`}>{group.lead.alias}</span><span className={`${G}tok-thinking`}>:{group.lead.thinking}</span>
      </span>
      <span className={`${G}profile-roles`}>
        {group.roles.map(role => <span key={role.role} className={`${G}profile-role`} data-role={role.role}>
          {role.agentBacked && <span className={`${G}profile-mark`} aria-label="agent">●</span>}{role.role === "security-reviewer" ? "security" : role.role}
        </span>)}
      </span>
    </Fragment>)}
  </div>;
}
