import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref, type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { keyCapLabel } from "@manifold/plugin/hooks";
import { ControlIcon, type ControlKind } from "@manifold/ui";

/*
 * The primitives shared by every Code panel, in Manifold's own vocabulary: the Plugin Manager's
 * pills, switches, chips, section bands and buttons, the host's KeyCap, Spinner and icons.
 * Classes hang from the shared `.plugin-atyrode_code` root (styles.css); layout that belongs to a
 * single panel stays in that panel's stylesheet.
 */

function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- vocabulary

/** A control's tooltip naming its key as this keyboard labels it: `Defaults (D)`, `Verify models (Ctrl ↵)`. */
export function withKey(label: string, stroke: string): string {
  return `${label} (${keyCapLabel(stroke)})`;
}
export const LAUNCH_STROKE = "Mod+↵";

/** Provider families have a mark colour; anything without one shares the neutral fallback. */
export function hueOf(family: string | null | undefined): "openai" | "anthropic" | "deepseek" | "other" {
  return family === "openai" || family === "anthropic" || family === "deepseek" ? family : "other";
}
const accountWords: Readonly<Record<string, string>> = { openai: "Codex", anthropic: "Claude", deepseek: "DeepSeek" };
const familyWords: Readonly<Record<string, string>> = { openai: "GPT", anthropic: "Claude", deepseek: "DeepSeek" };
/** Sentence-cases a vocabulary word (`claude` → `Claude`); identifiers keep their own case. */
export function capitalized(word: string): string {
  return word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word;
}
/** The name an account group goes by (`Codex`, `Claude`), which is how people name their subscriptions. */
export function accountWord(family: string | null | undefined, fallback = "Other"): string {
  return family ? accountWords[family] ?? capitalized(family) : fallback;
}
/** The name a model family goes by in lane names (`GPT-led`, `Claude only`). */
export function familyWord(family: string): string {
  return familyWords[family] ?? capitalized(family);
}

// ---------------------------------------------------------------- text and time

/** Keeps both ends of a long value readable, which is where identities and model ids differ. */
function middle(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 1) return "…";
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - (keep - head))}`;
}
/** Model ids shorten the provider segment first, so the part that names the model stays whole. */
export function middleId(value: string, max: number): string {
  if (value.length <= max) return value;
  const slash = value.indexOf("/");
  const tail = value.slice(slash);
  const room = max - tail.length - 1;
  if (slash > 0 && room >= 3) return `${value.slice(0, room)}…${tail}`;
  // Too narrow for any provider: the model part alone still names the route.
  return slash > 0 ? middle(value.slice(slash + 1), max) : middle(value, max);
}
const MINUTE = 60_000;
export function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
/** How long ago, as a phrase: `2d ago`, or `just now`. */
export function since(ms: number): string {
  const age = ago(ms);
  return age === "now" ? "just now" : `${age} ago`;
}
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function hhmm(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
/** Absolute local time with the weekday, for resets that may be days away. */
export function clock(timestamp: number): string {
  return `${weekdays[new Date(timestamp).getDay()]} ${hhmm(timestamp)}`;
}

/** Re-renders on each wall-clock minute so countdowns tick without animating or polling anything. */
export function useMinuteTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      setTick(value => value + 1);
      interval = window.setInterval(() => setTick(value => value + 1), MINUTE);
    }, MINUTE - (Date.now() % MINUTE) + 50);
    return () => { window.clearTimeout(timeout); window.clearInterval(interval); };
  }, []);
  return tick;
}

// ---------------------------------------------------------------- buttons and checkboxes

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ControlKind | undefined; buttonRef?: Ref<HTMLButtonElement> | undefined };
/** The secondary button: borderless, a word and optionally a host control icon before it; only hover gives it a ground. */
export function Button({ icon, className, buttonRef, type = "button", children, ...rest }: ButtonProps) {
  return <button ref={buttonRef} type={type} className={cx("plugin-atyrode_code__button", className)} {...rest}>
    {icon && <ControlIcon kind={icon} size={13} />}{children}
  </button>;
}

type CheckProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & {
  checked: boolean; onChange: (checked: boolean) => void; buttonRef?: Ref<HTMLButtonElement> | undefined;
};
/**
 * A square checkbox with its label: `aria-checked` IS the state. A refused one keeps its mark at
 * reduced opacity and stays hoverable (`aria-disabled`), so its reason can be read.
 */
export function Check({ checked, onChange, className, buttonRef, onClick, children, ...rest }: CheckProps) {
  return <button ref={buttonRef} type="button" role="checkbox" aria-checked={checked} className={cx("plugin-atyrode_code__check", className)}
    onClick={event => { onClick?.(event); if (!event.defaultPrevented && rest["aria-disabled"] !== true && !rest.disabled) onChange(!checked); }} {...rest}>
    <span className="plugin-atyrode_code__check-box" aria-hidden="true">{checked && <ControlIcon kind="confirm" size={10} />}</span>
    {children}
  </button>;
}

// ---------------------------------------------------------------- section bands and notices

/** A section's heading row (Generator, Routing, Usage): uppercase label, a count, then the section's actions. */
export function SectionBand({ id, title, count, actions }: { id?: string | undefined; title: string; count?: ReactNode; actions?: ReactNode }) {
  return <div className="plugin-atyrode_code__band">
    <h2 className="plugin-atyrode_code__band-title" id={id}>{title}{count !== undefined && count !== null && <span className="plugin-atyrode_code__band-count">{count}</span>}</h2>
    {actions && <div className="plugin-atyrode_code__band-actions">{actions}</div>}
  </div>;
}

/** An inline notice: a tone accent on the card ground, short text, secondary-button actions; exact technical text waits behind Details. */
export function Notice({ kind = "info", children, actions, details, live = true, className }: {
  kind?: "info" | "warn" | "error"; children: ReactNode; actions?: ReactNode; details?: string | null | undefined; live?: boolean; className?: string | undefined;
}) {
  return <div className={cx("plugin-atyrode_code__note", className)} data-kind={kind} role={live ? "status" : undefined}>
    <p className="plugin-atyrode_code__note-text">{children}</p>
    {actions && <div className="plugin-atyrode_code__note-actions">{actions}</div>}
    {details && <Details label="Details">{details}</Details>}
  </div>;
}
/** Technical text behind a disclosure, never in the main flow. */
function Details({ label, children }: { label: string; children: string }) {
  return <details className="plugin-atyrode_code__disclosure">
    <summary><ControlIcon kind="collapsed" size={12} />{label}</summary>
    <pre>{children}</pre>
  </details>;
}

// ---------------------------------------------------------------- menus and popovers

/** The panel's overlay layer: popovers render here so the scroll region neither clips nor scrolls them. */
const LayerContext = createContext<HTMLElement | null>(null);
export const LayerProvider = LayerContext.Provider;

type MenuHandle = {
  open: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
  toggle: () => void;
  /** Closes; `restore` returns focus to the anchor (Esc, a chosen item) rather than leaving it where a click put it. */
  close: (restore?: boolean) => void;
};
export function useMenu(onChange?: (open: boolean) => void): MenuHandle {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  // The latest open state and listener, so toggles from stale closures still flip the real state and report once.
  const latest = useRef({ open: false, onChange });
  latest.current.onChange = onChange;
  const set = useCallback((next: boolean) => {
    if (latest.current.open === next) return;
    latest.current.open = next;
    setOpen(next);
    latest.current.onChange?.(next);
  }, []);
  const close = useCallback((restore = true) => {
    set(false);
    if (restore) anchor.current?.focus({ preventScroll: true });
  }, [set]);
  const toggle = useCallback(() => set(!latest.current.open), [set]);
  return { open, anchor, toggle, close };
}

/** `role="menu"`: arrow keys move, Esc and Tab close. `role="dialog"`: a small form that stays open while scrolling. */
export function Menu({ menu, label, role = "menu", placement = "below", align = "start", className, children }: {
  menu: MenuHandle; label: string; role?: "menu" | "dialog"; placement?: "below" | "above"; align?: "start" | "end"; className?: string | undefined; children: ReactNode;
}) {
  const layer = useContext(LayerContext);
  const surface = useRef<HTMLDivElement>(null);
  // Placed in a layout effect before paint; never hidden meanwhile, because hidden elements cannot take initial focus.
  const [position, setPosition] = useState<CSSProperties>({ left: 0, top: 0 });
  const { open, anchor, close } = menu;
  useLayoutEffect(() => {
    if (!open || !layer) return;
    function place() {
      const pop = surface.current, trigger = anchor.current;
      if (!pop || !trigger || !layer) return;
      const frame = layer.getBoundingClientRect(), rect = trigger.getBoundingClientRect();
      const width = pop.offsetWidth, height = pop.offsetHeight;
      let left = align === "end" ? rect.right - frame.left - width : rect.left - frame.left;
      if (left + width > frame.width - 8) left = rect.right - frame.left - width;
      left = Math.max(8, left);
      const below = rect.bottom - frame.top + 6;
      const above = rect.top - frame.top - height - 6;
      const fitsBelow = below + height <= frame.height - 8;
      const top = (placement === "above" || !fitsBelow) && above >= 8 ? above : below;
      setPosition({ left: Math.round(left), top: Math.round(Math.max(8, top)), maxHeight: Math.max(120, frame.height - 16) });
    }
    place();
    const initial = surface.current?.querySelector<HTMLElement>(role === "menu"
      ? "[role=menuitem][aria-current=true]:not(:disabled), [role=menuitem]:not(:disabled)"
      : "[data-autofocus], button:not(:disabled), input:not(:disabled), [tabindex='0']");
    (initial ?? surface.current)?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    observer.observe(layer);
    if (surface.current) observer.observe(surface.current);
    return () => observer.disconnect();
  }, [open, layer, placement, align, role, anchor]);
  useEffect(() => {
    if (!open || !layer) return;
    const document = layer.ownerDocument;
    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (surface.current?.contains(target) || anchor.current?.contains(target)) return;
      close(false);
    }
    // Menus belong to the place they were opened from; scrolling away dismisses them. Dialogs hold drafts and stay.
    function scrolled(event: Event) {
      if (role === "menu" && !surface.current?.contains(event.target as Node)) close(false);
    }
    document.addEventListener("pointerdown", outside, true);
    layer.parentElement?.addEventListener("scroll", scrolled, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      layer.parentElement?.removeEventListener("scroll", scrolled, true);
    };
  }, [open, layer, role, close, anchor]);
  if (!open || !layer) return null;
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (role !== "menu") return;
    if (event.key === "Tab") { close(true); return; }
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)")];
    const index = items.indexOf(event.target as HTMLElement);
    const next = event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1) : event.key === "ArrowUp" ? Math.max(0, index - 1)
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -2;
    if (next === -2) return;
    event.preventDefault();
    items[next]?.focus();
  }
  return createPortal(<div ref={surface} className={cx("plugin-atyrode_code__pop", className)} role={role} aria-label={label} data-popover="" tabIndex={-1} style={position} onKeyDown={keys}>
    {children}
  </div>, layer);
}

// ---------------------------------------------------------------- sheets

/** A secondary surface that replaces the main view: a Back button to Code, the sheet's title, its actions. */
export function SheetFrame({ name, onBack, actions, status, backRef, children, className }: {
  name: string; onBack: () => void; actions?: ReactNode; status?: ReactNode; backRef?: Ref<HTMLButtonElement> | undefined; children: ReactNode; className?: string | undefined;
}) {
  return <section className={cx("plugin-atyrode_code__sheet", className)} aria-label={name}>
    <div className="plugin-atyrode_code__sheet-head">
      <button ref={backRef} type="button" className="plugin-atyrode_code__button plugin-atyrode_code__back" onClick={onBack} aria-label="Back to Code" title="Back to Code (Esc)">
        <ControlIcon kind="collapsed" size={14} />Code
      </button>
      <h2 className="plugin-atyrode_code__sheet-title">{name}</h2>
      {status && <span className="plugin-atyrode_code__sheet-status">{status}</span>}
      {actions && <span className="plugin-atyrode_code__sheet-acts">{actions}</span>}
    </div>
    <div className="plugin-atyrode_code__sheet-body">{children}</div>
  </section>;
}
