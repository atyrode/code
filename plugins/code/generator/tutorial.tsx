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
 * means the tutorial is offered again next time, so nothing waits on it.
 */
export function useTutorialSeen(host: HostServices): { readonly seen: boolean | null; readonly see: () => void } {
  const [seen, setSeen] = useState<boolean | null>(null);
  const keeps = useRef(false);
  const local = `atyrode.code.tutorial:${host.principal.id}`;
  useEffect(() => {
    let live = true;
    setSeen(null);
    codeWorkflow(host).readTutorial().then(record => {
      if (!live) return;
      keeps.current = record.keeps;
      setSeen(record.keeps ? record.seenAt !== null : browserSeen(local));
    }, () => { /* Unread: not offered, as above. */ });
    return () => { live = false; };
  }, [host.principal.id]);
  function see() {
    setSeen(true);
    if (!keeps.current) { rememberInBrowser(local); return; }
    codeWorkflow(host).seeTutorial().catch(() => { /* Offered again next time, as above. */ });
  }
  return { seen, see };
}
function browserSeen(key: string): boolean {
  try { return globalThis.localStorage?.getItem(key) !== null; } catch { return false; }
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
type Layout = { readonly shown: readonly boolean[]; readonly card: Box | null; readonly ring: Box | null };

/**
 * One step of the tutorial: a thin ring in the accent around the real control and a card beside it,
 * under it where there is room in the panel, else over it, both laid over the panel without moving
 * anything in it. The card says what the control is, where the walk stands ("3 of 10"), and offers
 * Next (Done at the last), Back and Skip; `→` and `←` step too, and `Esc` skips. Each step takes
 * focus on Next once, so the walk reads out and `↵` goes on, and scrolls its control into view.
 * A step whose control is not shown now (another view or a sheet has the panel) hides the card and
 * the ring until it is. Placed in the panel's own coordinates, so a panel inside a transformed
 * canvas places it as well as one that is not.
 */
export function TutorialCard({ panel, step, accent, onNext, onBack, onEnd }: {
  panel: HTMLElement; step: number; accent: string; onNext: () => void; onBack: () => void; onEnd: () => void;
}) {
  const id = useId();
  const card = useRef<HTMLElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const [layout, setLayout] = useState<Layout>({ shown: [], card: null, ring: null });
  const current = TUTORIAL_STEPS[step]!;

  function measure() {
    const shown = tutorialShown(panel), target = tutorialTarget(panel, current);
    let placed: Layout = { shown, card: null, ring: null };
    if (target) {
      const room = panel.getBoundingClientRect(), at = target.getBoundingClientRect();
      // What of the panel the window shows: a panel taller than the window keeps the card where it can be seen.
      const bottom = Math.min(room.height, innerHeight - room.top);
      const width = Math.max(0, Math.min(CARD_MAX_PX, room.width - 2 * EDGE_PX));
      const height = card.current?.offsetHeight ?? 0;
      const top = at.top - room.top, under = at.bottom - room.top + GAP_PX, over = top - GAP_PX - height;
      const cardTop = under + height <= bottom - EDGE_PX ? under : over >= EDGE_PX ? over : Math.max(EDGE_PX, bottom - EDGE_PX - height);
      const left = Math.min(Math.max(at.left - room.left, EDGE_PX), room.width - EDGE_PX - width);
      const ringLeft = Math.max(1, at.left - room.left - RING_PX), ringTop = Math.max(1, top - RING_PX);
      placed = { shown, card: { top: cardTop, left, width, height },
        ring: { top: ringTop, left: ringLeft, width: Math.min(room.width - 1, at.right - room.left + RING_PX) - ringLeft,
          height: Math.min(room.height - 1, at.bottom - room.top + RING_PX) - ringTop } };
    }
    setLayout(previous => JSON.stringify(previous) === JSON.stringify(placed) ? previous : placed);
  }
  // Every render may have moved the control (a read landing, a pane growing); the card follows it before paint.
  useLayoutEffect(measure);
  const latest = useRef(measure);
  latest.current = measure;
  useEffect(() => {
    const view = panel.ownerDocument.defaultView, follow = () => latest.current();
    const observer = new ResizeObserver(follow);
    observer.observe(panel);
    panel.addEventListener("scroll", follow, true);
    view?.addEventListener("resize", follow);
    return () => { observer.disconnect(); panel.removeEventListener("scroll", follow, true); view?.removeEventListener("resize", follow); };
  }, [panel]);
  // A step brings its control into view and takes focus on Next once its card shows, once per step: a card hidden while
  // another view has the panel and shown again takes nothing from what the person is doing.
  const showing = layout.card !== null;
  const focused = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!showing || focused.current === step) return;
    focused.current = step;
    tutorialTarget(panel, current)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    next.current?.focus({ preventScroll: true });
  }, [step, showing]);

  const place = tutorialPlace(layout.shown, step);
  const last = nextTutorialStep(layout.shown, step) === null, first = previousTutorialStep(layout.shown, step) === null;
  function keys(event: KeyboardEvent<HTMLElement>) {
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
    <section ref={card} className={`${G}tutorial`} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`}
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
