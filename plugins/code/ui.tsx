import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref, type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { keyCapLabel } from "@manifold/plugin/hooks";
import { ControlIcon, KeyCap, Spinner, type ControlKind } from "@manifold/ui";

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
export function countdown(ms: number): string {
  if (ms < 30_000) return "now";
  const total = Math.ceil(ms / MINUTE);
  const days = Math.floor(total / 1440), hours = Math.floor((total % 1440) / 60), minutes = total % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
export function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
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

// ---------------------------------------------------------------- status, buttons, checkboxes

type Tone = "warn" | "attention" | "ok" | "on" | "muted";
/**
 * One status fact as a dot and coloured text, never a box: `● Unverified` in warn, `Read-only` in
 * muted text. Adjacent facts are divided by a thin rule (CSS), so a status line reads as one sentence.
 */
export function State({ tone = "muted", title, children }: { tone?: Tone | undefined; title?: string | undefined; children: ReactNode }) {
  return <span className="plugin-atyrode_code__state" data-tone={tone} title={title}>
    {tone !== "muted" && <span className="plugin-atyrode_code__dot" aria-hidden="true" />}{children}
  </span>;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ControlKind | undefined; buttonRef?: Ref<HTMLButtonElement> | undefined };
/** The secondary button: borderless, a word and optionally a host control icon before it; only hover gives it a ground. */
export function Button({ icon, className, buttonRef, type = "button", children, ...rest }: ButtonProps) {
  return <button ref={buttonRef} type={type} className={cx("plugin-atyrode_code__button", className)} {...rest}>
    {icon && <ControlIcon kind={icon} size={13} />}{children}
  </button>;
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { icon: ControlKind; label: string; buttonRef?: Ref<HTMLButtonElement> | undefined };
/** One host control icon on a borderless 24px button, named for assistive technology. */
export function IconButton({ icon, label, className, buttonRef, type = "button", title, ...rest }: IconButtonProps) {
  return <button ref={buttonRef} type={type} className={cx("plugin-atyrode_code__button plugin-atyrode_code__icon-button", className)} aria-label={label} title={title ?? label} {...rest}>
    <ControlIcon kind={icon} size={14} />
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

type PrimaryProps = ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean | undefined; keyHint?: boolean | undefined; buttonRef?: Ref<HTMLButtonElement> | undefined };
/**
 * The one accent button per surface, naming the next step. Busy shows the host Spinner with the
 * step in flight and stays focusable (`aria-disabled`) so focus never falls to the page.
 */
export function PrimaryButton({ busy = false, keyHint = true, className, children, buttonRef, onClick, title, ...rest }: PrimaryProps) {
  return <button ref={buttonRef} type="button" className={cx("plugin-atyrode_code__primary", className)} aria-disabled={busy || undefined} aria-busy={busy || undefined}
    title={title ?? (keyHint && typeof children === "string" ? withKey(children, LAUNCH_STROKE) : undefined)}
    onClick={event => { if (!busy) onClick?.(event); }} {...rest}>
    {busy && typeof children === "string" ? <Spinner label={children} /> : children}
    {keyHint && !busy && <KeyCap label={keyCapLabel(LAUNCH_STROKE)} />}
  </button>;
}

// ---------------------------------------------------------------- section bands, notices, meters

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
export function Details({ label, children }: { label: string; children: string }) {
  return <details className="plugin-atyrode_code__disclosure">
    <summary><ControlIcon kind="collapsed" size={12} />{label}</summary>
    <pre>{children}</pre>
  </details>;
}

/** A five-step estimate as segments; `preview` marks what a hovered choice would add or drop. */
export function SegmentMeter({ value, preview = null, total = 5, warnAtTop = false }: { value: number; preview?: number | null; total?: number; warnAtTop?: boolean }) {
  const lit = Math.max(0, Math.min(total, Math.round(value)));
  const next = preview === null ? lit : Math.max(0, Math.min(total, Math.round(preview)));
  return <span className="plugin-atyrode_code__segments" data-top={warnAtTop && (preview === null ? lit : next) === total || undefined} aria-hidden="true">
    {Array.from({ length: total }, (_, index) => <i key={index} data-on={index < lit || undefined}
      data-pv={index >= lit && index < next ? "add" : index < lit && index >= next ? "drop" : undefined} />)}
  </span>;
}

/** A quota reading as one continuous bar. Neutral below 80%; warn from 80%, attention from 95%. */
export function UsageBar({ percent, level }: { percent: number; level: "ok" | "warn" | "error" | "unknown" }) {
  const width = Math.max(0, Math.min(100, percent));
  return <span className="plugin-atyrode_code__ubar" data-level={level} aria-hidden="true">
    <span style={{ inlineSize: `${width}%` } as CSSProperties} />
  </span>;
}

// ---------------------------------------------------------------- readout

/**
 * The readout follows whatever control the pointer rests on, else whatever holds keyboard focus.
 * Controls opt in declaratively with `data-readout` (and `data-readout-label`), so the same text
 * serves hover and focus without a second source.
 */
type ReadoutState = { active: HTMLElement | null };
const ReadoutContext = createContext<ReadoutState>({ active: null });
export const ReadoutProvider = ReadoutContext.Provider;

export function useReadoutRoot(onActive?: (element: HTMLElement | null) => void) {
  const hover = useRef<HTMLElement | null>(null);
  const focus = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<ReadoutState>({ active: null });
  const notify = useRef(onActive);
  notify.current = onActive;
  const last = useRef<HTMLElement | null>(null);
  function publish() {
    const active = hover.current ?? focus.current;
    setState(previous => previous.active === active ? previous : { active });
    if (last.current !== active) { last.current = active; notify.current?.(active); }
  }
  return {
    state,
    rootProps: {
      onMouseOver(event: MouseEvent<HTMLElement>) {
        const element = (event.target as Element).closest<HTMLElement>("[data-readout]");
        if (element === hover.current) return;
        hover.current = element && event.currentTarget.contains(element) ? element : null;
        publish();
      },
      onMouseLeave() { hover.current = null; publish(); },
      onFocus(event: FocusEvent<HTMLElement>) {
        const target = event.target as HTMLElement;
        const element = target.closest<HTMLElement>("[data-readout]");
        // Only keyboard focus drives the readout; a click already shows it through hover.
        focus.current = element && target.matches(":focus-visible") ? element : null;
        publish();
      },
      onBlur(event: FocusEvent<HTMLElement>) {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        focus.current = null;
        publish();
      },
    },
  };
}

export type Readout = { label: string | null; text: string };
function readoutOf(element: HTMLElement | null): Readout | null {
  if (!element?.isConnected || element.dataset.readout === undefined) return null;
  return { label: element.dataset.readoutLabel ?? null, text: element.dataset.readout };
}
/** The active control's readout, re-read after every render because a commit rewrites the same element's text. */
function useReadout(): Readout | null {
  const { active } = useContext(ReadoutContext);
  const [value, setValue] = useState<Readout | null>(null);
  useLayoutEffect(() => {
    const next = readoutOf(active);
    setValue(previous => previous?.label === next?.label && previous?.text === next?.text ? previous : next);
  });
  return value;
}

/** The stable help line: the hovered or focused control's explanation, else `fallback`. Its box never changes size. */
export function ReadoutLine({ fallback, className }: { fallback: Readout | null; className?: string | undefined }) {
  const readout = useReadout();
  const shown = readout ?? fallback;
  return <p className={cx("plugin-atyrode_code__readout", className)} aria-live="polite">
    {shown && <>{shown.label && <strong>{shown.label}</strong>}{shown.text}</>}
  </p>;
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

const MenuContext = createContext<{ close: (restore?: boolean) => void } | null>(null);

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
  return createPortal(<MenuContext.Provider value={{ close }}>
    <div ref={surface} className={cx("plugin-atyrode_code__pop", className)} role={role} aria-label={label} data-popover="" tabIndex={-1} style={position} onKeyDown={keys}>
      {children}
    </div>
  </MenuContext.Provider>, layer);
}

export function MenuHeader({ children }: { children: ReactNode }) {
  return <div className="plugin-atyrode_code__mh">{children}</div>;
}
export function MenuRule() {
  return <hr className="plugin-atyrode_code__mrule" />;
}
/** A menu row: a check for the current choice, the label, then a quiet fact or key on the right. */
export function MenuItem({ children, onSelect, current = false, aside, tone, disabled = false, keepOpen = false }: {
  children: ReactNode; onSelect: () => void; current?: boolean; aside?: ReactNode; tone?: "danger" | undefined;
  disabled?: boolean; keepOpen?: boolean;
}) {
  const menu = useContext(MenuContext);
  return <button type="button" role="menuitem" className="plugin-atyrode_code__mi" aria-current={current || undefined} data-tone={tone} disabled={disabled}
    onClick={() => { if (!keepOpen) menu?.close(true); onSelect(); }}>
    <span className="plugin-atyrode_code__mi-mark" aria-hidden="true">{current && <ControlIcon kind="confirm" size={14} />}</span>
    <span className="plugin-atyrode_code__mi-label">{children}</span>
    {aside !== undefined && <span className="plugin-atyrode_code__mi-aside">{aside}</span>}
  </button>;
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
