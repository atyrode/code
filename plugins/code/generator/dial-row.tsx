import { Fragment, useEffect, useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { prefersReducedMotion } from "@manifold/ui";
import { hueOf } from "../ui.tsx";
import { edgeWord, stepWord, type GeneratorRow, type RowWord, type WordTone } from "./rows-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
const EASE = "cubic-bezier(.2, .8, .2, 1)";
/** The wheel acts on a row the pointer has rested on this long, so a page scroll passing over it never turns it. */
const REST_MS = 450;
/** Wheel travel per step, in pixels (a line-mode wheel counts 40 per line). */
const WHEEL_STEP = 60;

/** The row glyphs, drawn on a 16px grid with a 1.5px stroke. */
const GLYPHS: Readonly<Record<GeneratorRow["id"], string>> = {
  lane: "M2.5 5.5h10.5M10.5 3l2.5 2.5-2.5 2.5M13.5 10.5H3M5.5 8 3 10.5 5.5 13",
  tier: "M5.25 4.25h5.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-5.5a1 1 0 0 1-1-1v-5.5a1 1 0 0 1 1-1ZM6.5 1.75v2.5M9.5 1.75v2.5M6.5 11.75v2.5M9.5 11.75v2.5M1.75 6.5h2.5M1.75 9.5h2.5M11.75 6.5h2.5M11.75 9.5h2.5",
  thinking: "M5.6 10.6A4.6 4.6 0 1 1 10.4 10.6V12H5.6ZM6.2 14.25h3.6",
  advisor: "M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5ZM10.6 5.4 9.2 9.2 5.4 10.6 6.8 6.8Z",
  spark: "M8 1.75 9.5 6.5 14.25 8 9.5 9.5 8 14.25 6.5 9.5 1.75 8 6.5 6.5Z",
  fallbacks: "M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5ZM8 5.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3.6 3.6l2.6 2.6M12.4 3.6 9.8 6.2M3.6 12.4l2.6-2.6M12.4 12.4 9.8 9.8",
  priority: "M9.25 1.75 3.75 9h4.5l-1.5 5.25L12.25 7h-4.5Z",
  prewalk: "M8 1.75v8.5M4.5 6.75 8 10.25l3.5-3.5M3 14h10",
  plans: "M5 3.25v9.5L12.5 8Z",
  budget: "M2.25 8.25 8.25 2.25h5.5v5.5l-6 6ZM10.75 4.75v.01",
  machine: "M2.75 3.25h10.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1ZM5.5 14.25h5M8 11.25v3",
};

/** A 16px line glyph in the text's colour. */
export function Glyph({ path, className, style, ...data }: { path: string; className?: string; style?: CSSProperties; [attribute: `data-${string}`]: true | undefined }) {
  return <svg className={className} style={style} {...data} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={path} />
  </svg>;
}

/** The colour a chosen word wears. */
export function toneColor(tone: WordTone): string {
  switch (tone.kind) {
    case "family": return `var(--code-${hueOf(tone.family)})`;
    case "mixed": return "var(--tui-mixed)";
    case "accent": return "var(--tui-acc)";
    case "plain": return "var(--tui-fg)";
  }
}

/** Where each word sits in the row's word box: its centre, the top of its line, and the glider's baseline under it. */
type Geo = { readonly x: number; readonly line: number; readonly y: number };
type Drag = { readonly id: number; readonly mouse: boolean; readonly x0: number; readonly y0: number; moving: boolean };

export type DialRowProps = {
  readonly row: GeneratorRow;
  /** Holds the rows' one Tab stop. */
  readonly cursor: boolean;
  /** Edits wait (a step runs or a charge waits): the row still answers, and every choice is refused with the gate's reason. */
  readonly locked: boolean;
  /** The pointer went down on the row: it takes the Tab stop. */
  readonly onCursor: () => void;
  readonly onChoose: (word: RowWord, via: "pointer" | "keyboard" | "scrub") => void;
  /** A word that cannot be chosen was pressed, scrubbed onto or stepped towards. */
  readonly onRefuse: (word: RowWord, via: "pointer" | "keyboard" | "scrub") => void;
  /** The word under the pointer, or null when the pointer leaves the row's words. */
  readonly onHover: (word: RowWord | null) => void;
  readonly onFocusChange: (focused: boolean) => void;
  /** A scrub began (the selection it started from is the pane's to remember) or ended. */
  readonly onScrub: (phase: "start" | "end") => void;
  /** ↑ or ↓ on the row. */
  readonly onMove: (delta: -1 | 1) => void;
};

/**
 * One generator row: its glyph, its label and every option word on a line, the chosen one bold in
 * its colour, with a glider under the words: a dot on the chosen word, a level fill from the line's
 * first word to it, and a detent tick under each word while the row is pointed or focused. Every
 * word keeps the room of its bold form, so choosing never moves another. A click chooses; a drag
 * scrubs, choosing at each detent it passes with the dot riding the pointer; ←/→ step over words
 * that cannot be chosen, Home/End go to the ends, Space flips a switch, and the wheel steps once the
 * row has focus or the pointer has rested on it. A word that cannot be chosen is struck through and
 * refuses with its reason. The row is a slider (a switch for on/off rows) whose words are drawn for
 * the eye; its value is its accessible text.
 */
export function DialRow({ row, cursor, locked, onCursor, onChoose, onRefuse, onHover, onFocusChange, onScrub, onMove }: DialRowProps) {
  const element = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const follow = useRef<Geo | null>(null);
  const rested = useRef(false);
  const latest = useRef(row);
  latest.current = row;
  const texts = useRef(new Map<string, string>());
  const hovered = useRef<string | null>(null);
  const selected = row.words.find(word => word.selected) ?? null;
  const at = selected ? row.words.indexOf(selected) : -1;
  const switchRow = row.kind === "switch";

  function geometry(): Geo[] {
    const words = [...box.current?.querySelectorAll<HTMLElement>(`.${G}word`) ?? []];
    return words.map(word => {
      const text = word.firstElementChild as HTMLElement;
      return { x: word.offsetLeft + word.offsetWidth / 2, line: word.offsetTop, y: word.offsetTop + text.offsetTop + text.offsetHeight + 4 };
    });
  }

  /** Places the ticks, the dot and the fill: under the chosen word, or under the pointer while a scrub follows it. */
  function layout(anchor: Geo | null) {
    const words = box.current, row = element.current;
    if (!words || !row) return;
    if (!anchor) {
      // A row whose words wrap starts each provider group on its own line (the lane's DeepSeek words).
      delete row.dataset.wrapped;
      const tops = [...words.querySelectorAll<HTMLElement>(`.${G}word`)].map(word => word.offsetTop);
      if (tops.some(top => top !== tops[0])) row.dataset.wrapped = "";
    }
    const geo = geometry();
    const ticks = words.querySelectorAll<HTMLElement>(`.${G}tick`);
    geo.forEach((point, index) => { const tick = ticks[index]; if (tick) tick.style.transform = `translate(${point.x}px, ${point.y}px)`; });
    const dot = words.querySelector<HTMLElement>(`.${G}dot`), fill = words.querySelector<HTMLElement>(`.${G}fill`);
    if (!dot || !fill) return;
    const chosen = latest.current.words.findIndex(word => word.selected);
    if (chosen < 0 || !geo[chosen]) { dot.style.opacity = "0"; fill.style.transform = "scaleX(0)"; return; }
    dot.style.opacity = "";
    const point = anchor ?? geo[chosen]!;
    dot.style.transform = `translate(${point.x}px, ${point.y}px)`;
    const start = geo.find(entry => entry.line === point.line) ?? geo[0]!;
    fill.style.transform = latest.current.kind === "level"
      ? `translate(${start.x}px, ${point.y - 1}px) scaleX(${Math.max(0, point.x - start.x)})`
      : `translate(${point.x}px, ${point.y - 1}px) scaleX(0)`;
  }

  // After every render: the glider follows the chosen word (or a scrub's pointer), and a word whose text changed rolls in.
  useLayoutEffect(() => {
    layout(drag.current?.moving ? follow.current : null);
    const still = prefersReducedMotion();
    for (const word of box.current?.querySelectorAll<HTMLElement>(`.${G}word`) ?? []) {
      const key = word.dataset.key!, text = word.firstElementChild as HTMLElement;
      const before = texts.current.get(key);
      texts.current.set(key, text.dataset.text ?? "");
      if (before !== undefined && before !== text.dataset.text && !still) {
        text.animate([{ transform: "translateY(55%)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 280, easing: EASE });
      }
    }
  });
  // A resize or a font that loads late moves the words; the glider moves with them.
  useEffect(() => {
    const words = box.current;
    if (!words) return;
    const observer = new ResizeObserver(() => { if (!drag.current?.moving) layout(null); });
    observer.observe(words);
    let live = true;
    void words.ownerDocument.fonts?.ready.then(() => { if (live) layout(null); });
    return () => { live = false; observer.disconnect(); };
  }, []);

  function shake(word: RowWord) {
    if (prefersReducedMotion()) return;
    box.current?.querySelector<HTMLElement>(`.${G}word[data-key="${CSS.escape(word.key)}"]`)
      ?.animate([{ transform: "none" }, { transform: "translateX(-2px)" }, { transform: "translateX(2px)" }, { transform: "none" }], { duration: 260 });
  }
  /** At the end of the row the dot nudges against it. */
  function bump(direction: number) {
    if (prefersReducedMotion()) return;
    box.current?.querySelector<HTMLElement>(`.${G}dot`)?.animate([{ translate: "0 0" }, { translate: `${direction * 5}px 0` }, { translate: "0 0" }],
      { duration: 240, easing: EASE, composite: "add" });
  }
  function choose(word: RowWord, via: "pointer" | "keyboard" | "scrub") {
    if (word.selected) return;
    if (!word.available || locked) { if (via !== "scrub") shake(word); onRefuse(word, via); return; }
    onChoose(word, via);
  }
  function step(forward: boolean) {
    const next = stepWord(latest.current, forward);
    if (next) { choose(next, "keyboard"); return; }
    bump(forward ? 1 : -1);
    const neighbour = latest.current.words[at + (forward ? 1 : -1)];
    if (neighbour && !neighbour.available) onRefuse(neighbour, "keyboard");
  }

  // ------------------------------------------------------------ pointer: click, scrub, hover
  function nearest(clientX: number, clientY: number): number {
    const rect = box.current!.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    let best = 0, score = Number.POSITIVE_INFINITY;
    geometry().forEach((point, index) => {
      const distance = Math.abs(point.x - x) + Math.abs(point.line + 10 - y) * 2.5;
      if (distance < score) { score = distance; best = index; }
    });
    return best;
  }
  function scrub(event: ReactPointerEvent<HTMLDivElement>, following: boolean) {
    const index = nearest(event.clientX, event.clientY);
    const word = latest.current.words[index];
    if (!word) return;
    choose(word, following ? "scrub" : "pointer");
    if (!following) return;
    const geo = geometry(), point = geo[index]!;
    const line = geo.filter(entry => entry.line === point.line);
    const x = Math.min(Math.max(event.clientX - box.current!.getBoundingClientRect().left, line[0]!.x), line.at(-1)!.x);
    follow.current = { x, line: point.line, y: point.y };
    layout(follow.current);
  }
  function endDrag() {
    if (!drag.current) return;
    drag.current = null;
    follow.current = null;
    delete element.current?.dataset.dragging;
    layout(null);
    onScrub("end");
  }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    onCursor();
    element.current?.focus({ preventScroll: true });
    const mouse = event.pointerType === "mouse";
    drag.current = { id: event.pointerId, mouse, x0: event.clientX, y0: event.clientY, moving: false };
    hovered.current = null;
    onHover(null);
    onScrub("start");
    event.currentTarget.setPointerCapture(event.pointerId);
    // A mouse chooses on press; a touch waits to tell a tap from a scroll.
    if (mouse) { event.preventDefault(); scrub(event, false); }
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const held = drag.current;
    if (held && event.pointerId === held.id) {
      const dx = event.clientX - held.x0, dy = event.clientY - held.y0;
      if (!held.moving) {
        if (Math.abs(dx) < 4 || (!held.mouse && Math.abs(dx) < Math.abs(dy))) return;
        held.moving = true;
        element.current!.dataset.dragging = "";
      }
      scrub(event, true);
      return;
    }
    if (held) return;
    const key = (event.target as HTMLElement).closest<HTMLElement>(`.${G}word`)?.dataset.key ?? null;
    if (hovered.current === key) return;
    hovered.current = key;
    onHover(latest.current.words.find(word => word.key === key) ?? null);
  }
  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const held = drag.current;
    if (!held || event.pointerId !== held.id) return;
    if (!held.moving && !held.mouse) scrub(event, false);
    endDrag();
  }

  // The wheel steps a focused row, or one the pointer has rested on; it is non-passive so the page does not scroll as well.
  const wheelTravel = useRef(0);
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    let timer = 0;
    const enter = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { rested.current = true; }, REST_MS); };
    const leave = () => { window.clearTimeout(timer); rested.current = false; wheelTravel.current = 0; };
    const wheel = (event: WheelEvent) => {
      if (!(node.ownerDocument.activeElement === node || rested.current)) return;
      event.preventDefault();
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      wheelTravel.current += event.deltaMode === 1 ? delta * 40 : delta;
      if (Math.abs(wheelTravel.current) >= WHEEL_STEP) { stepRef.current(wheelTravel.current > 0); wheelTravel.current = 0; }
    };
    node.addEventListener("pointerenter", enter);
    node.addEventListener("pointerleave", leave);
    node.addEventListener("wheel", wheel, { passive: false });
    return () => { window.clearTimeout(timer); node.removeEventListener("pointerenter", enter); node.removeEventListener("pointerleave", leave); node.removeEventListener("wheel", wheel); };
  }, []);

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case "ArrowLeft": step(false); break;
      case "ArrowRight": step(true); break;
      case "Home": case "End": {
        const edge = edgeWord(latest.current, event.key === "End");
        if (edge) choose(edge, "keyboard"); else bump(event.key === "End" ? 1 : -1);
        break;
      }
      case "ArrowUp": onMove(-1); break;
      case "ArrowDown": onMove(1); break;
      case " ": {
        if (!switchRow || event.repeat) return;
        const other = latest.current.words.find(word => !word.selected);
        if (other) choose(other, "keyboard");
        break;
      }
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  const aria = switchRow
    ? { role: "switch", "aria-checked": selected?.key === "on" }
    : { role: "slider", "aria-orientation": "horizontal" as const, "aria-valuemin": 0, "aria-valuemax": Math.max(0, row.words.length - 1),
      "aria-valuenow": Math.max(0, at), "aria-valuetext": selected?.name ?? "" };
  const other = switchRow ? row.words.find(word => !word.selected) : undefined;
  const style = { "--dc": selected ? selected.quiet ? "var(--tui-faint)" : toneColor(selected.tone) : "var(--tui-faint)" } as CSSProperties;
  return <div ref={element} className={`${G}dial`} data-row={row.id} data-kind={row.kind} {...aria} aria-label={row.label}
    aria-disabled={locked || (other !== undefined && !other.available) || undefined} tabIndex={cursor ? 0 : -1} style={style}
    onKeyDown={keys} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)}
    onPointerDown={event => { if (!(event.target as HTMLElement).closest(`.${G}words`)) onCursor(); }}
    onPointerLeave={() => { hovered.current = null; onHover(null); }}>
    <span className={`${G}dial-ptr`} aria-hidden="true">▸</span>
    <span className={`${G}dial-glyph`}><Glyph path={GLYPHS[row.id]} /></span>
    <span className={`${G}dial-label`}>{row.label}</span>
    <div ref={box} className={`${G}words`} aria-hidden="true" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
      onPointerCancel={event => { if (drag.current?.id === event.pointerId) endDrag(); }}
      onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) endDrag(); }}>
      <span className={`${G}track`}>
        {row.words.map(word => <i key={word.key} className={`${G}tick`} data-off={!word.available || undefined} />)}
        <i className={`${G}fill`} />
        <i className={`${G}dot`} />
      </span>
      {row.words.map(word => <Fragment key={word.key}>
        {word.gap && <i className={`${G}word-break`} />}
        <span className={`${G}word`} data-key={word.key} data-selected={word.selected || undefined} data-off={!word.available || undefined}
          data-gap={word.gap || undefined} style={{ "--wc": toneColor(word.tone) } as CSSProperties}>
          <span className={`${G}word-text`} data-text={word.text}>{word.online !== null && <i className={`${G}word-online`} data-online={word.online} />}{word.text}</span>
          {word.sub !== null && <span className={`${G}word-sub`}>{word.sub}</span>}
        </span>
      </Fragment>)}
    </div>
  </div>;
}
