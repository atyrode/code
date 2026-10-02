import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref, type RefObject,
} from "react";
import { createPortal } from "react-dom";

/*
 * The "Ledger, alive" primitives shared by every Code panel. Classes hang from the shared
 * `.plugin-atyrode_code` root (styles.css) so the generator, accounts and usage panels speak one
 * visual language; layout that belongs to a single panel stays in that panel's stylesheet.
 */

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- platform and vocabulary

/** macOS readers expect ⌘; everyone else presses Ctrl. Evaluated lazily so tests without a DOM still import this module. */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac|iphone|ipad/i.test(data?.platform ?? navigator.platform ?? "");
}

/** The launch chord as the reader's keyboard labels it. The return glyph sits in a fixed cell because mono faces often lack it. */
export function LaunchKey() {
  return <>{isMac() ? "⌘" : "ctrl"}<span className="plugin-atyrode_code__gk">↵</span></>;
}
export function EnterKey() {
  return <span className="plugin-atyrode_code__gk">↵</span>;
}

/** Provider families have a hue; anything without one shares the neutral fallback. */
export function hueOf(family: string | null | undefined): "openai" | "anthropic" | "deepseek" | "other" {
  return family === "openai" || family === "anthropic" || family === "deepseek" ? family : "other";
}
const accountWords: Readonly<Record<string, string>> = { openai: "codex", anthropic: "claude", deepseek: "deepseek" };
const familyWords: Readonly<Record<string, string>> = { openai: "gpt", anthropic: "claude", deepseek: "deepseek" };
/** The word an account group goes by (`codex`, `claude`), which is how people name their subscriptions. */
export function accountWord(family: string | null | undefined, fallback = "other"): string {
  return family ? accountWords[family] ?? family : fallback;
}
/** The word a model family goes by in lane names (`gpt-led`, `claude-only`). */
export function familyWord(family: string): string {
  return familyWords[family] ?? family;
}

// ---------------------------------------------------------------- text and time

/** Keeps both ends of a long value readable, which is where identities and model ids differ. */
export function middle(value: string, max: number): string {
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
const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
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

// ---------------------------------------------------------------- small pieces

export function Sep() {
  return <span className="plugin-atyrode_code__sep" aria-hidden="true">·</span>;
}
/** Joins inline facts with the dim middle dot used everywhere in the ledger language. */
export function Dotted({ items }: { items: readonly ReactNode[] }) {
  const shown = items.filter(item => item !== null && item !== false && item !== undefined && item !== "");
  return <>{shown.map((item, index) => <span key={index} className="plugin-atyrode_code__dotted">{index > 0 && <Sep />}{item}</span>)}</>;
}

/** The zone label. Solid while its zone holds focus (CSS), or when a sheet names itself. */
export function ZoneChip({ children, solid = false }: { children: ReactNode; solid?: boolean }) {
  return <span className="plugin-atyrode_code__chip" data-solid={solid || undefined}>{children}</span>;
}

/** A zone's first line: chip, optional status and extras, then right-aligned key hints. */
export function ZoneHead({ chip, status, children, hints, className }: {
  chip: ReactNode; status?: ReactNode; children?: ReactNode; hints?: readonly ReactNode[]; className?: string | undefined;
}) {
  return <div className={cx("plugin-atyrode_code__zh", className)}>
    <ZoneChip>{chip}</ZoneChip>
    {status !== undefined && status !== null && <span className="plugin-atyrode_code__zh-status">{status}</span>}
    {children}
    {hints && hints.length > 0 && <span className="plugin-atyrode_code__hints"><Dotted items={hints} /></span>}
  </div>;
}

/** A clickable `key label` pair; pressed hints light their key in the accent. */
export function Hint({ k, label, pressed, onClick, readout, buttonRef }: {
  k: ReactNode; label: ReactNode; pressed?: boolean | undefined; onClick?: (() => void) | undefined; readout?: string | undefined; buttonRef?: Ref<HTMLButtonElement> | undefined;
}) {
  if (!onClick) return <span className="plugin-atyrode_code__hk"><kbd>{k}</kbd> {label}</span>;
  return <button ref={buttonRef} type="button" className="plugin-atyrode_code__hk" aria-pressed={pressed} onClick={onClick} data-readout={readout}>
    <kbd>{k}</kbd> {label}
  </button>;
}

type QuietProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "danger" | undefined; buttonRef?: Ref<HTMLButtonElement> | undefined };
/** Text action: secondary ink, accent underline on hover and focus, a 24px hit area. */
export function QuietButton({ tone, className, buttonRef, type = "button", ...rest }: QuietProps) {
  return <button ref={buttonRef} type={type} className={cx("plugin-atyrode_code__q", className)} data-tone={tone} {...rest} />;
}

type PrimaryProps = ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean | undefined; keyHint?: boolean | undefined; buttonRef?: Ref<HTMLButtonElement> | undefined };
/** The one accent button per surface. It stays focusable while busy so focus never falls to the page. */
export function PrimaryButton({ busy = false, keyHint = true, className, children, buttonRef, onClick, ...rest }: PrimaryProps) {
  return <button ref={buttonRef} type="button" className={cx("plugin-atyrode_code__primary", className)} aria-disabled={busy || undefined}
    onClick={event => { if (!busy) onClick?.(event); }} {...rest}>
    {children}{keyHint && <span className="plugin-atyrode_code__kh"><LaunchKey /></span>}
  </button>;
}

/** One line, a leading glyph and short text, then inline actions; exact technical text waits behind `details`. Never a box. */
export function Notice({ kind = "info", children, actions, details, live = true, className }: {
  kind?: "info" | "warn" | "error"; children: ReactNode; actions?: readonly ReactNode[] | undefined; details?: string | null | undefined; live?: boolean; className?: string | undefined;
}) {
  return <div className={cx("plugin-atyrode_code__note", className)} data-kind={kind} role={live ? "status" : undefined}>
    <span className="plugin-atyrode_code__note-glyph" aria-hidden="true">{kind === "error" ? "×" : kind === "warn" ? "!" : "·"}</span>
    <span className="plugin-atyrode_code__note-text">
      <span>{children}</span>
      {actions?.map((action, index) => <span key={index} className="plugin-atyrode_code__dotted"><Sep />{action}</span>)}
    </span>
    {details && <details className="plugin-atyrode_code__note-details"><summary>details</summary><pre>{details}</pre></details>}
  </div>;
}

/** `$$$··`: lit glyphs then unlit ones. The word beside it carries the meaning; colour only reinforces. */
export function GlyphMeter({ glyph, value, total = 5, kind }: { glyph: string; value: number; total?: number; kind: "cost" | "speed" }) {
  const lit = Math.max(0, Math.min(total, Math.round(value)));
  return <span className="plugin-atyrode_code__glyphs" data-kind={kind} aria-hidden="true">
    <span className="plugin-atyrode_code__lit">{glyph.repeat(lit)}</span><span className="plugin-atyrode_code__unlit">{glyph.repeat(total - lit)}</span>
  </span>;
}

/** A quota cell bar. Cells fill once when they first mount; later readings just change. */
export function CellBar({ percent, cells }: { percent: number; cells: 5 | 10 }) {
  const lit = Math.round((Math.max(0, Math.min(100, percent)) / 100) * cells);
  return <span className="plugin-atyrode_code__bar" data-cells={cells} aria-hidden="true">
    {Array.from({ length: cells }, (_, index) => <i key={index} data-on={index < lit || undefined} style={{ "--i": index } as CSSProperties} />)}
  </span>;
}

// ---------------------------------------------------------------- readout and hint bar

/**
 * The readout follows whatever control the pointer rests on, else whatever holds keyboard focus.
 * Controls opt in declaratively with `data-readout` (and `data-readout-label`, `data-readout-prose`),
 * so the same text serves hover, focus and the narrow consequence line without a second source.
 */
type ReadoutState = { active: HTMLElement | null; zone: string | null };
const ReadoutContext = createContext<ReadoutState>({ active: null, zone: null });
export const ReadoutProvider = ReadoutContext.Provider;

export function useReadoutRoot(onActive?: (element: HTMLElement | null) => void) {
  const hover = useRef<HTMLElement | null>(null);
  const focus = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<ReadoutState>({ active: null, zone: null });
  const notify = useRef(onActive);
  notify.current = onActive;
  const last = useRef<HTMLElement | null>(null);
  function publish(zone?: string | null) {
    const active = hover.current ?? focus.current;
    setState(previous => previous.active === active && (zone === undefined || previous.zone === zone) ? previous :
      { active, zone: zone === undefined ? previous.zone : zone });
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
        publish(target.closest<HTMLElement>("[data-zone]")?.dataset.zone ?? null);
      },
      onBlur(event: FocusEvent<HTMLElement>) {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        focus.current = null;
        publish(null);
      },
    },
  };
}

export type Readout = { label: string | null; text: string; prose: boolean };
function readoutOf(element: HTMLElement | null): Readout | null {
  if (!element?.isConnected || element.dataset.readout === undefined) return null;
  return { label: element.dataset.readoutLabel ?? null, text: element.dataset.readout, prose: element.dataset.readoutProse !== undefined };
}
/** The zone that holds focus, for zone-specific key hints. */
export function useReadoutZone(): string | null {
  return useContext(ReadoutContext).zone;
}
/** The active control's readout, re-read after every render because a commit rewrites the same element's text. */
export function useReadout(): Readout | null {
  const { active } = useContext(ReadoutContext);
  const [value, setValue] = useState<Readout | null>(null);
  useLayoutEffect(() => {
    const next = readoutOf(active);
    setValue(previous => previous?.label === next?.label && previous?.text === next?.text && previous?.prose === next?.prose ? previous : next);
  });
  return value;
}

/** The bottom line: zone key hints at rest, replaced by the readout of the hovered or focused control. */
export function HintBar({ hints, className }: { hints: ReactNode; className?: string }) {
  const readout = useReadout();
  return <div className={cx("plugin-atyrode_code__hintbar", className)} aria-live="polite">
    {readout ? <span className="plugin-atyrode_code__ro" data-prose={readout.prose || undefined}>
      {readout.label && <><b>{readout.label}</b> · </>}{readout.text}
    </span> : hints}
  </div>;
}

// ---------------------------------------------------------------- menus and popovers

/** The panel's overlay layer: popovers render here so the scroll region neither clips nor scrolls them. */
const LayerContext = createContext<HTMLElement | null>(null);
export const LayerProvider = LayerContext.Provider;

export type MenuHandle = {
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
      const below = rect.bottom - frame.top + 4;
      const above = rect.top - frame.top - height - 4;
      const fitsBelow = below + height <= frame.height - 8;
      const top = (placement === "above" || !fitsBelow) && above >= 8 ? above : below;
      setPosition({ left: Math.round(left), top: Math.round(Math.max(8, top)), maxHeight: Math.max(120, frame.height - 16) });
    }
    place();
    const initial = surface.current?.querySelector<HTMLElement>(role === "menu"
      ? "[role=menuitem][aria-current=true]:not(:disabled), [role=menuitem]:not(:disabled)"
      : "[data-autofocus], button:not(:disabled), input:not(:disabled), [tabindex='0']");
    initial?.focus({ preventScroll: true });
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
    <div ref={surface} className={cx("plugin-atyrode_code__pop", className)} role={role} aria-label={label} data-popover="" style={position} onKeyDown={keys}>
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
/** A menu row: accent mark for the current choice, label, then a dim key or fact on the right. */
export function MenuItem({ children, onSelect, current = false, mark, aside, tone, disabled = false, readout, keepOpen = false }: {
  children: ReactNode; onSelect: () => void; current?: boolean; mark?: ReactNode; aside?: ReactNode; tone?: "danger" | undefined;
  disabled?: boolean; readout?: string | undefined; keepOpen?: boolean;
}) {
  const menu = useContext(MenuContext);
  return <button type="button" role="menuitem" className="plugin-atyrode_code__mi" aria-current={current || undefined} data-tone={tone} disabled={disabled}
    data-readout={readout} onClick={() => { if (!keepOpen) menu?.close(true); onSelect(); }}>
    <span className="plugin-atyrode_code__mi-mark" aria-hidden="true">{mark ?? (current ? "›" : "")}</span>
    <span className="plugin-atyrode_code__mi-label">{children}</span>
    <span className="plugin-atyrode_code__mi-aside">{aside}</span>
  </button>;
}

// ---------------------------------------------------------------- sheets

/** A secondary surface that replaces the main view: `‹ code` back, the sheet's chip, its actions. */
export function SheetFrame({ name, onBack, actions, status, backRef, children, className }: {
  name: string; onBack: () => void; actions?: ReactNode; status?: ReactNode; backRef?: Ref<HTMLButtonElement> | undefined; children: ReactNode; className?: string | undefined;
}) {
  return <section className={cx("plugin-atyrode_code__sheet", className)} aria-label={name}>
    <div className="plugin-atyrode_code__sheet-head">
      <button ref={backRef} type="button" className="plugin-atyrode_code__back" onClick={onBack} aria-label="back to code">‹ code</button>
      <ZoneChip solid>{name}</ZoneChip>
      {status && <span className="plugin-atyrode_code__sheet-status">{status}</span>}
      {actions && <span className="plugin-atyrode_code__sheet-acts">{actions}</span>}
    </div>
    <div className="plugin-atyrode_code__sheet-body">{children}</div>
  </section>;
}
