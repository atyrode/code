import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { HostServices } from "@manifold/plugin";
import { codeWorkflow } from "../machine-web.ts";
import { nextTutorialStep, previousTutorialStep, TUTORIAL_STEPS, tutorialPlace, type TutorialStep } from "./tutorial-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
/** The card's room: its widest, its distance from what it points at and from the panel's edges, and the ring's margin around the control. */
const CARD_MAX_PX = 320, GAP_PX = 10, EDGE_PX = 8, RING_PX = 4;

/**
 * Whether the person has seen the tutorial: their own record, read once, else, for a sign-in that
 * keeps none (tutorial.ts), this browser's; null until read, and while it cannot be read, when the
 * tutorial is not offered. `see` records it, at once on screen; a record that fails to write only
 * means the tutorial is offered again next time, so nothing waits on it. Seen before the record is
 * read (a walk replayed from More and ended at once), it is written once the read says where.
 */
export function useTutorialSeen(host: HostServices): { readonly seen: boolean | null; readonly see: () => void } {
  const [seen, setSeen] = useState<boolean | null>(null);
  const keeps = useRef<boolean | null>(null);
  const early = useRef(false);
  const local = `atyrode.code.tutorial:${host.principal.id}`;
  function write(kept: boolean) {
    if (!kept) { rememberInBrowser(local); return; }
    codeWorkflow(host).seeTutorial().catch(() => { /* Offered again next time, as above. */ });
  }
  useEffect(() => {
    let live = true;
    setSeen(null);
    keeps.current = null;
    early.current = false;
    codeWorkflow(host).readTutorial().then(record => {
      if (!live) return;
      keeps.current = record.keeps;
      if (early.current) { write(record.keeps); setSeen(true); return; }
      setSeen(record.keeps ? record.seenAt !== null : browserSeen(local));
    }, () => { /* Unread: not offered, as above. */ });
    return () => { live = false; };
  }, [host.principal.id]);
  function see() {
    setSeen(true);
    if (keeps.current === null) early.current = true;
    else write(keeps.current);
  }
  return { seen, see };
}
/** A browser that cannot keep anything has not seen it; one that throws on access neither. */
function browserSeen(key: string): boolean {
  try {
    const store = globalThis.localStorage;
    return store ? store.getItem(key) !== null : false;
  } catch { return false; }
}
function rememberInBrowser(key: string) {
  try { globalThis.localStorage?.setItem(key, String(Date.now())); } catch { /* A browser that keeps nothing offers it again. */ }
}

/** The control a step points at in the panel: the first of its targets that is shown, or null. */
export function tutorialTarget(panel: HTMLElement, step: TutorialStep): HTMLElement | null {
  for (const selector of step.targets) {
    const found = panel.querySelector<HTMLElement>(selector);
    if (found && found.getClientRects().length > 0) return found;
  }
  return null;
}
/** Which steps the panel shows a control for now. */
export function tutorialShown(panel: HTMLElement): boolean[] {
  return TUTORIAL_STEPS.map(step => tutorialTarget(panel, step) !== null);
}

type Box = { readonly top: number; readonly left: number; readonly width: number; readonly height: number };
type Layout = { readonly card: Box | null; readonly ring: Box | null };
const HIDDEN: Layout = { card: null, ring: null };

/**
 * One step of the tutorial: a thin ring in the accent around the real control and a card beside it,
 * under it where the panel shows room, else over it, both laid over the panel without moving anything
 * in it and both kept to the part of the panel the window shows. The card says what the control is,
 * where the walk stands among the steps it keeps to (`shown`, "3 of 10"), and offers Next (Done at
 * the last), Back and Skip; `→` and `←` step too, and `Esc` skips; a held key steps once. Each step's
 * card is a card of its own, so moving to it moves focus to its Next and it is read out, and its
 * control is scrolled into view. A step whose control is not shown now (another view or a sheet has
 * the panel), and any step while a popover of the panel is open (More's menu, the machine list), hides
 * the card and the ring until that changes. Placed in the panel's own coordinates, so a panel in a
 * translated canvas places it as well as one that is not.
 */
export function TutorialCard({ panel, step, shown, accent, onNext, onBack, onEnd }: {
  panel: HTMLElement; step: number; shown: readonly boolean[]; accent: string; onNext: () => void; onBack: () => void; onEnd: () => void;
}) {
  const id = useId();
  const card = useRef<HTMLElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const [layout, setLayout] = useState<Layout>(HIDDEN);
  const current = TUTORIAL_STEPS[step]!;

  function measure() {
    const target = tutorialTarget(panel, current);
    let placed = HIDDEN;
    if (target && !panel.querySelector("[data-popover]")) {
      const room = panel.getBoundingClientRect(), at = target.getBoundingClientRect();
      // The part of the panel the window shows, in the panel's coordinates.
      const view = { top: Math.max(0, -room.top), bottom: Math.min(room.height, innerHeight - room.top) };
      const width = Math.max(0, Math.min(CARD_MAX_PX, room.width - 2 * EDGE_PX));
      const height = card.current?.offsetHeight ?? 0;
      const top = at.top - room.top, bottom = at.bottom - room.top;
      const under = bottom + GAP_PX, over = top - GAP_PX - height;
      const highest = view.top + EDGE_PX, lowest = Math.max(highest, view.bottom - EDGE_PX - height);
      const cardTop = Math.min(Math.max(under + height <= view.bottom - EDGE_PX ? under : over >= highest ? over : lowest, highest), lowest);
      const left = Math.min(Math.max(at.left - room.left, EDGE_PX), room.width - EDGE_PX - width);
      // The ring around the control, within what the panel shows of it; none when nothing of it shows.
      const ringTop = Math.max(view.top + 1, top - RING_PX), ringBottom = Math.min(view.bottom - 1, bottom + RING_PX);
      const ringLeft = Math.max(1, at.left - room.left - RING_PX), ringRight = Math.min(room.width - 1, at.right - room.left + RING_PX);
      placed = { card: { top: cardTop, left, width, height },
        ring: ringBottom > ringTop && ringRight > ringLeft ? { top: ringTop, left: ringLeft, width: ringRight - ringLeft, height: ringBottom - ringTop } : null };
    }
    setLayout(previous => JSON.stringify(previous) === JSON.stringify(placed) ? previous : placed);
  }
  // Every render may have moved the control (a read landing, a pane growing); the card follows it before paint.
  useLayoutEffect(measure);
  const latest = useRef(measure);
  latest.current = measure;
  // Between renders it follows what moves on its own: a resize of the panel, the stage or the control, a scroll, a popover
  // opening or closing, a view or pane shown or hidden, and the end of any motion under way in the panel (a pane sliding in
  // moves its control without resizing or changing anything an observer sees); at most once a frame.
  useEffect(() => {
    const view = panel.ownerDocument.defaultView;
    const watched = new WeakSet<Animation>();
    let frame = 0, live = true;
    const follow = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        latest.current();
        for (const motion of panel.getAnimations({ subtree: true })) {
          if (watched.has(motion)) continue;
          watched.add(motion);
          motion.finished.then(() => { if (live) follow(); }, () => {});
        }
      });
    };
    const sizes = new ResizeObserver(follow), changes = new MutationObserver(follow);
    sizes.observe(panel);
    const stage = panel.querySelector("[data-tui]"), target = tutorialTarget(panel, current);
    if (stage) sizes.observe(stage);
    if (target) sizes.observe(target);
    changes.observe(panel, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-popover", "hidden"] });
    panel.addEventListener("scroll", follow, true);
    view?.addEventListener("resize", follow);
    follow();
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      sizes.disconnect(); changes.disconnect();
      panel.removeEventListener("scroll", follow, true);
      view?.removeEventListener("resize", follow);
    };
  }, [panel, step]);
  // A step brings its control into view and takes focus on Next once its card shows, once per step: a card hidden while
  // another view has the panel and shown again takes nothing from what the person is doing.
  const showing = layout.card !== null;
  const focused = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!showing || focused.current === step) return;
    focused.current = step;
    tutorialTarget(panel, current)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    measure();
    next.current?.focus({ preventScroll: true });
    // A card taller than a short panel scrolls within itself: its choices are brought into its view with the focus.
    const box = card.current;
    if (box && box.scrollHeight > box.clientHeight) box.scrollTop = box.scrollHeight;
  }, [step, showing]);

  const place = tutorialPlace(shown, step);
  const last = nextTutorialStep(shown, step) === null, first = previousTutorialStep(shown, step) === null;
  function keys(event: KeyboardEvent<HTMLElement>) {
    if (event.repeat && event.key !== "Escape") { event.preventDefault(); return; }
    if (event.key === "Escape") onEnd();
    else if (event.key === "ArrowRight") onNext();
    else if (event.key === "ArrowLeft" && !first) onBack();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }
  const box = (value: Box | null): CSSProperties => value ? { top: value.top, left: value.left, width: value.width } : {};
  return createPortal(<>
    {layout.ring && <div className={`${G}tutorial-ring`} aria-hidden="true"
      style={{ ...box(layout.ring), height: layout.ring.height, "--tui-acc": accent } as CSSProperties} />}
    <section key={step} ref={card} className={`${G}tutorial`} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`}
      data-tutorial={current.id} data-placed={showing || undefined} style={{ ...box(layout.card), "--tui-acc": accent } as CSSProperties} onKeyDown={keys}>
      <div className={`${G}tutorial-head`}>
        <h2 id={`${id}-title`}>{current.title}</h2>
        {place && <span className={`${G}tutorial-count`}>{place.position} of {place.count}</span>}
      </div>
      <p id={`${id}-text`}>{current.text}</p>
      <div className={`${G}tutorial-choices`}>
        <button ref={next} type="button" className={`${G}decision-go`} data-tutorial-choice="next" onClick={onNext}>{last ? "Done" : "Next"}</button>
        {!first && <button type="button" className={`${G}go-fix`} data-tutorial-choice="back" onClick={onBack}>Back</button>}
        {!last && <button type="button" className={`${G}go-fix ${G}tutorial-skip`} data-tutorial-choice="skip" onClick={onEnd}>Skip</button>}
      </div>
    </section>
  </>, panel);
}
