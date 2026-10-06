import { Fragment, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { prefersReducedMotion } from "@manifold/ui";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import type { Review } from "../../domain/routing.ts";
import { capitalized, Check, hueOf, middleId, SectionBand } from "../ui.tsx";
import { displayAliases } from "./aliases.ts";
import { routeChanges } from "./consequences.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
type Route = Review["routes"][number];
type TableView = { fallbacks: boolean; ids: boolean; pinned: ReadonlySet<string> };

const EFFORT_WORDS: Readonly<Record<string, string>> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "X-high", max: "Max" };

/** The row an absent advisor would occupy, so turning it on visibly adds a line instead of shifting every row. */
function tableRoles(routes: readonly Route[]): string[] {
  const roles = routes.map(route => route.role);
  if (!roles.includes("advisor")) roles.splice(roles.includes("sonic") ? roles.indexOf("sonic") + 1 : roles.length, 0, "advisor");
  return roles;
}

/**
 * Every role on one 24px line: role, model, effort. Exact ids and fallback chains are extra lines
 * the reader asks for (IDs, Fallbacks, or pinning a row), so the table never moves under the pointer.
 */
function Table({ review, catalog, aliases, view, onPin }: {
  review: Review; catalog: CompiledCatalog; aliases: ReadonlyMap<string, string>; view: TableView; onPin: (role: string) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const previous = useRef<Review["routes"] | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [rooms, setRooms] = useState<ReadonlyMap<string, number>>(new Map());
  const [recent, setRecent] = useState<ReadonlySet<string>>(new Set());
  const routes = useMemo(() => new Map(review.routes.map(route => [route.role, route])), [review]);
  const roles = useMemo(() => tableRoles(review.routes), [review]);
  // Afterglow: a route an edit just changed glows once, then fades. Pure presentation over the diff.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = review.routes;
    if (!before) return;
    const changed = routeChanges(before, review.routes).filter(change => change.kind !== "fallback" || view.fallbacks).map(change => change.role);
    if (!changed.length) return;
    // Reduced motion gets the same glow as a still mark that simply ends (`data-changed`), never a fade.
    if (!prefersReducedMotion()) for (const role of changed) {
      rows.current.get(role)?.animate([{ backgroundColor: "rgb(76 110 245 / 22%)" }, { backgroundColor: "rgb(76 110 245 / 0%)" }], { duration: 600, easing: "ease" });
    }
    setRecent(new Set(changed));
    const timer = window.setTimeout(() => setRecent(new Set()), 1500);
    return () => window.clearTimeout(timer);
  }, [review]);
  // Exact ids are middle-truncated to their line, which only the rendered width knows.
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const probe = element.ownerDocument.createElement("span");
    probe.className = `${G}model-id ${G}probe`;
    probe.textContent = "0".repeat(20);
    element.appendChild(probe);
    const ch = probe.getBoundingClientRect().width / 20 || 6;
    probe.remove();
    const measure = () => {
      const next = new Map<string, number>();
      for (const slot of element.querySelectorAll<HTMLElement>("[data-id-slot]")) next.set(slot.dataset.idSlot!, Math.max(0, Math.floor((slot.clientWidth - 2) / ch)));
      setRooms(current => current.size === next.size && [...next].every(([role, room]) => current.get(role) === room) ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [review]);
  const tabRole = tab && roles.includes(tab) ? tab : roles[0];
  const alias = (key: string) => aliases.get(key) ?? key;
  const effort = (level: string) => EFFORT_WORDS[level] ?? capitalized(level);
  function keys(event: KeyboardEvent<HTMLOListElement>) {
    const element = event.target as HTMLElement;
    const role = element.dataset.role;
    if (!role) return;
    const all = [...list.current?.querySelectorAll<HTMLElement>("[data-role]") ?? []];
    const index = all.indexOf(element);
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : null;
    if (next !== null) {
      event.preventDefault();
      const target = all[Math.max(0, Math.min(all.length - 1, next))];
      if (target) { setTab(target.dataset.role!); target.focus(); }
      return;
    }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPin(role); }
  }
  return <ol ref={list} className={`${G}ledger`} aria-label="Roles and models" onKeyDown={keys}
    data-fallbacks={view.fallbacks || undefined} data-ids={view.ids || undefined}>
    {roles.map(role => {
      const route = routes.get(role);
      const lead = route?.lead;
      const model = route ? catalog.model(route.lead.key) : null;
      const id = model ? `${model.provider}/${model.id}` : null;
      return <li key={role} ref={element => { if (element) rows.current.set(role, element); else rows.current.delete(role); }}
        className={`${G}lrow`} data-role={role} tabIndex={role === tabRole ? 0 : -1} data-off={!route || undefined} data-pinned={view.pinned.has(role) || undefined}
        data-changed={recent.has(role) || undefined} onClick={() => { setTab(role); onPin(role); }}>
        <span className={`${G}role`} title={role}>
          <span className={`${G}role-name`}>{role}</span>
          {route?.agentBacked && <span className={`${G}agent`} title="Runs as a delegated agent">agent</span>}
        </span>
        <span className={`${G}model`}>
          {lead && <span className="plugin-atyrode_code__mark" data-fam={hueOf(catalog.family(lead.key))} aria-hidden="true" />}
          <span className={`${G}alias`} data-model={lead?.key ?? ""} title={lead ? alias(lead.key) : undefined}>{lead ? alias(lead.key) : "Off"}</span>
        </span>
        <span className={`${G}effort`} data-thinking={lead?.thinking}>{lead ? effort(lead.thinking) : ""}</span>
        {id && <span className={`${G}model-id`} data-id-slot={role} title={id}>{middleId(id, rooms.get(role) ?? 0)}</span>}
        {route && <span className={`${G}fallback`}>{route.fallback.length ? <>then {route.fallback.map((choice, index) => <Fragment key={index}>
          {index > 0 && " → "}<span className={`${G}fallback-step`}>{alias(choice.key)} {effort(choice.thinking).toLowerCase()}</span>
        </Fragment>)}</> : review.selection.fallback ? "No fallback for this role" : "Fallbacks off"}</span>}
      </li>;
    })}
  </ol>;
}

/** A self-contained routing table for surfaces that review a catalog outside the main view (Models). */
export function Routing({ value, catalog }: { value: Review; catalog: CompiledCatalog }) {
  const aliases = useMemo(() => displayAliases(catalog), [catalog]);
  const [view, setView] = useState<TableView>({ fallbacks: false, ids: false, pinned: new Set() });
  return <div className={`${G}routing-review`} data-zone="routing">
    <SectionBand title="Routing" count={`${value.routes.length} roles`} actions={<>
      <Check checked={view.fallbacks} onChange={fallbacks => setView({ ...view, fallbacks })}>Fallbacks</Check>
      <Check checked={view.ids} onChange={ids => setView({ ...view, ids })}>IDs</Check>
    </>} />
    <Table review={value} catalog={catalog} aliases={aliases} view={view}
      onPin={role => { const pinned = new Set(view.pinned); if (!pinned.delete(role)) pinned.add(role); setView({ ...view, pinned }); }} />
    <p className={`${G}empty`}>{value.routes.some(route => route.fallback.length) ? "Fallbacks are tried in order; thinking adapts to each model." : value.selection.fallback ? "No alternate models in these fallback chains." : "Fallbacks off; retries stay on the lead model."}</p>
  </div>;
}
