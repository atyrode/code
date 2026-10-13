import { createContext, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

/*
 * THE PANEL'S LAYER: where everything a Code panel shows over itself stands (the questions a press
 * waits on, Shortcuts, Models' import, the native permission reviews and the tutorial), always inside
 * that panel and never over the rest of Manifold. Each mounts in the panel's root, outside its scroll
 * region, dims the panel under it and keeps to the part of the panel the window shows. While one
 * asks, the panel's content is inert, so neither a pointer, a key nor an assistive tool reaches it,
 * while the rest of Manifold stays as it was. A panel that shows a layer provides its root
 * (`PanelLayer`); a layer outside one renders nothing.
 */

/** Root class prefix: the layer's parts hang from the shared `.plugin-atyrode_code` root (styles.css). */
const C = "plugin-atyrode_code__";

/**
 * How long a press is ignored once a question opens or changes: one that lands this soon was aimed at
 * what stood there before, as a click on Launch the moment its review or check comes back.
 */
export const DECISION_SETTLE_MS = 400;
/**
 * How long a choice must have held focus before `↵` or `Space` answers with it: `Tab` then `↵` in one
 * burst, as typing meant for somewhere else lands, is never an answer. It holds keys only, so an
 * assistive tool's activation, which sends no key, is never refused.
 */
export const DECISION_FOCUS_MS = 300;

/** The panel the layer stands in, and the accent its cards carry; null until the panel has mounted. */
export const PanelLayer = createContext<{ readonly panel: HTMLElement; readonly accent: string } | null>(null);

/** A rectangle in the panel's own coordinates. */
export type Box = { readonly top: number; readonly left: number; readonly width: number; readonly height: number };
/** What the window measures, in the panel's own coordinates: a panel on a canvas may be moved or scaled. */
export function inPanel(panel: HTMLElement, rect: { readonly top: number; readonly left: number; readonly right: number; readonly bottom: number }): Box {
  const room = panel.getBoundingClientRect();
  const x = panel.offsetWidth > 0 ? room.width / panel.offsetWidth : 1, y = panel.offsetHeight > 0 ? room.height / panel.offsetHeight : 1;
  return { top: (rect.top - room.top) / y, left: (rect.left - room.left) / x, width: (rect.right - rect.left) / x, height: (rect.bottom - rect.top) / y };
}
/** The part of the panel the window shows, in the panel's own coordinates. */
export function visibleBox(panel: HTMLElement): Box {
  const view = panel.ownerDocument.defaultView;
  const window = inPanel(panel, { top: 0, left: 0, right: view?.innerWidth ?? 0, bottom: view?.innerHeight ?? 0 });
  const top = Math.max(0, window.top), left = Math.max(0, window.left);
  const bottom = Math.min(panel.offsetHeight, window.top + window.height), right = Math.min(panel.offsetWidth, window.left + window.width);
  return { top, left, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
const sameBox = (a: Box | null, b: Box | null) => a === b || (a !== null && b !== null && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

/** The part of the panel the window shows while `active`, followed through resizes and scrolls at most once a frame. */
export function useVisibleBox(panel: HTMLElement | null, active: boolean): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    if (!panel || !active) return;
    const document = panel.ownerDocument, view = document.defaultView;
    let frame = 0;
    const measure = () => { const next = visibleBox(panel); setBox(previous => sameBox(previous, next) ? previous : next); };
    const follow = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    measure();
    const sizes = new ResizeObserver(follow);
    sizes.observe(panel);
    view?.addEventListener("resize", follow);
    document.addEventListener("scroll", follow, true);
    return () => {
      cancelAnimationFrame(frame);
      sizes.disconnect();
      view?.removeEventListener("resize", follow);
      document.removeEventListener("scroll", follow, true);
    };
  }, [panel, active]);
  return box;
}

/** How many holds each panel and each element it makes inert are under, so one released never frees another's. */
const panelHolds = new WeakMap<HTMLElement, number>(), elementHolds = new WeakMap<HTMLElement, number>();
/**
 * Holds the panel's content inert until the returned release (safe to call more than once): every
 * element of it but the layers (`data-layer`), the live region (`data-live`), which goes on speaking,
 * and what `keep` names, which stays usable with everything inside it. Each sibling along the way from
 * a kept element up to the panel's root is held, so nothing else in the panel answers a pointer, a key
 * or an assistive tool. It holds what is there when it is taken: an element mounted later beside a kept
 * path is not held, so a holder whose kept parts change takes its hold again.
 */
export function holdPanel(panel: HTMLElement, keep: readonly HTMLElement[] = []): () => void {
  const path = new Set<Element>();
  for (const element of keep) for (let node: Element | null = element; node && node !== panel; node = node.parentElement) path.add(node);
  const held: HTMLElement[] = [];
  const visit = (parent: Element) => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement) || child.matches("[data-layer], [data-live]") || keep.includes(child)) continue;
      if (path.has(child)) { visit(child); continue; }
      const count = elementHolds.get(child) ?? 0;
      elementHolds.set(child, count + 1);
      if (count === 0) child.inert = true;
      held.push(child);
    }
  };
  visit(panel);
  panelHolds.set(panel, (panelHolds.get(panel) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    panelHolds.set(panel, Math.max(0, (panelHolds.get(panel) ?? 1) - 1));
    for (const element of held) {
      const count = Math.max(0, (elementHolds.get(element) ?? 1) - 1);
      elementHolds.set(element, count);
      if (count === 0) element.inert = false;
    }
  };
}
/** Whether a layer holds the panel now: its keys then answer nothing, whatever has focus. */
export function panelHeld(panel: HTMLElement): boolean {
  return (panelHolds.get(panel) ?? 0) > 0;
}

/** What each open layer gives focus back to once it goes. */
const focusBehindLayer = new WeakMap<Element, Element | null>();
/** Where focus goes back once the layer holding `element` has gone, or `element` itself when it is in none. */
export function focusBehind(element: Element): Element | null {
  const layer = element.closest("[data-layer]");
  return layer && focusBehindLayer.has(layer) ? focusBehindLayer.get(layer)! : element;
}
/**
 * Gives focus back once a layer has gone: where it was before the layer took it, unless something else
 * took it since (a sheet a fix opened) or that place is gone or hidden, when the panel's root takes it.
 */
export function giveFocusBack(panel: HTMLElement, layer: Element | null, before: Element | null) {
  const document = panel.ownerDocument, active = document.activeElement;
  if (active && active !== document.body && active !== panel && !layer?.contains(active)) return;
  const back = before instanceof HTMLElement && before.isConnected && before.closest("[inert]") === null
    && (before === panel || before.getClientRects().length > 0) ? before : panel;
  back.focus({ preventScroll: true });
}

/**
 * Presses a card that asks counts as answers: none in its first moments after it opens or what it asks
 * changes (`asked`), never a multi-click's second, and a key only on a choice that has held focus a
 * moment and never as a held key's repeat.
 */
export function useDeliberate(asked: string | null) {
  const openedAt = useRef(0);
  const focusedAt = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    if (asked === null) return;
    openedAt.current = performance.now();
    focusedAt.current.clear();
  }, [asked]);
  const settled = () => performance.now() - openedAt.current >= DECISION_SETTLE_MS;
  return {
    settled,
    /** A pointer or assistive press of a choice: once settled, never a multi-click's second. */
    press: (detail: number) => detail <= 1 && settled(),
    /** What a choice named `name` needs: when it took focus, and its keys held to the focus rule. */
    choice: (name: string) => ({
      onFocus: () => { focusedAt.current.set(name, performance.now()); },
      onBlur: () => { focusedAt.current.delete(name); },
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const at = focusedAt.current.get(name);
        if (event.repeat || at === undefined || performance.now() - at < DECISION_FOCUS_MS) event.preventDefault();
      },
    }),
  };
}

const FOCUSABLE = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";
/** `Tab` and `Shift+Tab` go round the card's own controls, so focus never falls into the panel under it. */
export function keepTab(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Tab") return;
  const card = event.currentTarget;
  const all = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => element.getClientRects().length > 0);
  const first = all[0], last = all.at(-1), active = card.ownerDocument.activeElement;
  if (!first || !last) { event.preventDefault(); return; }
  if (event.shiftKey ? active === first || !all.includes(active as HTMLElement) : active === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

/**
 * A DIALOG INSIDE THE PANEL: the panel dims under it and is inert while it is open, and the dialog
 * stands centred in the part of the panel the window shows. It opens with focus on `focus` (the
 * dialog itself when not given); `Tab` goes round its own controls; `Esc` takes the way out, as does
 * a settled press that starts and ends on the dimmed panel where `scrimDismisses`. Closing gives focus
 * back to what had it, as a modal dialog does. Nothing outside the panel is covered or held.
 */
export function PanelDialog({ open, className, labelledBy, describedBy, data, busy, focus, settled, scrimDismisses = true, onDismiss, children }: {
  readonly open: boolean;
  readonly className: string;
  readonly labelledBy: string;
  readonly describedBy?: string;
  /** The `data-` attributes the dialog carries, which name what it is. */
  readonly data?: Readonly<Record<`data-${string}`, string | undefined>>;
  /** Whether what it shows is being read or applied. */
  readonly busy?: boolean;
  /** What takes focus as it opens. */
  readonly focus?: (dialog: HTMLDialogElement) => HTMLElement | null;
  /** Whether a press on the dimmed panel now is past the dialog's first moments; always, when not given. */
  readonly settled?: () => boolean;
  /** Whether a press on the dimmed panel takes the way out; a dialog holding work (an import, a review) keeps it instead. */
  readonly scrimDismisses?: boolean;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}) {
  const layer = useContext(PanelLayer);
  const panel = layer?.panel ?? null;
  const shown = open && panel !== null;
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pressed = useRef(false);
  const box = useVisibleBox(panel, shown);
  const first = useRef(focus);
  first.current = focus;
  useLayoutEffect(() => {
    const node = dialog.current, around = root.current;
    if (!shown || !panel || !node || !around) return;
    const before = panel.ownerDocument.activeElement;
    focusBehindLayer.set(around, before);
    const release = holdPanel(panel);
    (first.current?.(node) ?? node).focus({ preventScroll: true });
    return () => { release(); giveFocusBack(panel, around, before); };
  }, [shown, panel]);
  if (!shown || !layer) return null;
  return createPortal(<div ref={root} className={`${C}layer`} data-layer="" data-holds="" style={{ "--tui-acc": layer.accent } as CSSProperties}>
    <div className={`${C}scrim`} aria-hidden="true" onMouseDown={event => event.preventDefault()}
      onPointerDown={event => { pressed.current = event.target === event.currentTarget; }}
      onClick={event => {
        const began = pressed.current;
        pressed.current = false;
        if (!scrimDismisses || !began || event.target !== event.currentTarget || event.detail > 1 || !(settled?.() ?? true)) return;
        onDismiss();
      }} />
    <div className={`${C}layer-room`} style={box ?? undefined}>
      <dialog ref={dialog} open tabIndex={-1} className={className} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-busy={busy || undefined} {...data}
        onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat) onDismiss();
            return;
          }
          keepTab(event);
        }}>{children}</dialog>
    </div>
  </div>, layer.panel);
}
