import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { HostServices } from "@manifold/plugin";
import { prefersReducedMotion } from "@manifold/ui";
import { codeWorkflow } from "../machine-web.ts";
import { giveFocusBack, holdPanel, inPanel, keepTab, PanelLayer, useDeliberate, useVisibleBox, visibleBox, type Box } from "../panel-layer.tsx";
import { nextTutorialStep, previousTutorialStep, TUTORIAL_STEPS, TUTORIAL_WELCOME, tutorialPlace, type TutorialStep } from "./tutorial-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
/** The opening's margin around what it lights; the card's widest, and its distance from the opening and from the panel's edges. */
const OPENING_PX = 6, CARD_MAX_PX = 320, GAP_PX = 12, EDGE_PX = 8;
/**
 * How long what a step lights waits before it may be tried: longer than the opening's 340 ms glide (styles.css, `tour-scrim`
 * and `tour-ring`) and as long as the usual double-click interval, motion or not. And how long the dim takes to go once the
 * tour ends.
 */
const SETTLE_MS = 500, LEAVE_MS = 220;

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

const laidOut = (element: Element) => element.getClientRects().length > 0;
/** What a step lights in the panel now: the first of its targets the panel shows, with every shown element of it, and which of them it is. */
export type TutorialLit = { readonly parts: readonly HTMLElement[]; readonly target: number; readonly tryable: boolean };
export function tutorialLit(panel: HTMLElement, step: TutorialStep): TutorialLit | null {
  for (const [index, target] of step.targets.entries()) {
    const [lead, ...rest] = target.parts;
    const first = lead ? [...panel.querySelectorAll<HTMLElement>(lead)].filter(laidOut) : [];
    if (first.length === 0) continue;
    return { parts: [...first, ...rest.flatMap(selector => [...panel.querySelectorAll<HTMLElement>(selector)].filter(laidOut))], target: index, tryable: target.tryable === true };
  }
  return null;
}
/** Which steps the panel shows a control for now. */
export function tutorialShown(panel: HTMLElement): boolean[] {
  return TUTORIAL_STEPS.map(step => tutorialLit(panel, step) !== null);
}

/** Where the tour stands: its welcome, a walk about to begin on the generator, or the walk. */
export type TourPhase = "welcome" | "starting" | "walk";
type Card = { readonly top: number; readonly left: number };
/** The walk's step as measured: the opening (none while its control is not shown), the card's place, and what is lit. */
type Placed = { readonly hole: Box | null; readonly card: Card; readonly lit: string };

/** The card's width in a panel that shows `view`: its widest, else the panel's width less its edges. */
const cardWidth = (view: Box) => Math.max(0, Math.min(CARD_MAX_PX, view.width - 2 * EDGE_PX));
/**
 * Where a card `height` tall stands: beside its opening, under it where the panel shows room, else over
 * it, else beside it, else at the foot of what the panel shows, over the opening; in the middle of what
 * the panel shows when there is no opening; always inside.
 */
function placeCard(hole: Box | null, view: Box, height: number): Card {
  const width = cardWidth(view);
  const highest = view.top + EDGE_PX, lowest = view.top + view.height - EDGE_PX;
  const leftmost = view.left + EDGE_PX, rightmost = view.left + view.width - EDGE_PX;
  const across = (left: number) => Math.min(Math.max(left, leftmost), rightmost - width);
  const down = (top: number) => Math.min(Math.max(top, highest), Math.max(highest, lowest - height));
  if (!hole) return { top: down(view.top + (view.height - height) / 2), left: across(view.left + (view.width - width) / 2) };
  const under = hole.top + hole.height + GAP_PX, over = hole.top - GAP_PX - height;
  if (under + height <= lowest) return { top: under, left: across(hole.left) };
  if (over >= highest) return { top: over, left: across(hole.left) };
  const right = hole.left + hole.width + GAP_PX, left = hole.left - GAP_PX - width;
  if (right + width <= rightmost) return { top: down(hole.top), left: right };
  if (left >= leftmost) return { top: down(hole.top), left };
  return { top: down(lowest - height), left: across(hole.left) };
}
/** The dim with its opening cut out, the panel's whole box around it; an opening that has not opened is a point. */
function dimmed(hole: Box | null, point: { readonly x: number; readonly y: number }): string {
  const { top, left, width, height } = hole ?? { top: point.y, left: point.x, width: 0, height: 0 };
  const right = left + width, bottom = top + height;
  return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left}px ${top}px, ${left}px ${bottom}px, ${right}px ${bottom}px, ${right}px ${top}px, ${left}px ${top}px)`;
}
/**
 * Brings what a step lights into view together, by the nearest scrolling box between it and the
 * panel's root, the least distance that shows all of it (its top, when it is taller than the box);
 * nothing else scrolls.
 */
function revealIn(panel: HTMLElement, parts: readonly HTMLElement[]) {
  for (let node = parts[0]?.parentElement ?? null; node && node !== panel; node = node.parentElement) {
    if (!/(auto|scroll)/.test(getComputedStyle(node).overflowY) || node.scrollHeight <= node.clientHeight) continue;
    const box = node.getBoundingClientRect(), rects = parts.map(part => part.getBoundingClientRect());
    const top = Math.min(...rects.map(rect => rect.top)), bottom = Math.max(...rects.map(rect => rect.bottom));
    if (top < box.top) node.scrollTop -= box.top - top;
    else if (bottom > box.bottom) node.scrollTop += Math.min(bottom - box.bottom, top - box.top);
    return;
  }
}

/**
 * THE TOUR, inside the panel and over nothing else (panel-layer.tsx). Its welcome is a card over the
 * dimmed panel, which is inert until it is answered: Take the tour, or Skip, which `Esc` and a settled
 * press on the dim take too, giving focus back where it was. The walk then opens the dim, growing from
 * where the welcome stood to the first step's control, and each step glides the opening to its control
 * with a card beside it, under it where the panel shows room, else over it, else beside it, all of it
 * kept to the part of the panel the window shows; a step whose control is not shown keeps its card in
 * the middle with the dim closed. The panel stays inert during the walk but for what a step offers to
 * try (a word, a tab or a Show control to open), and only once the opening has landed on it, so no
 * key, press or assistive tool reaches anything else: nothing launches, spends or saves meanwhile.
 * The card says what the control is and how far the walk has come, and offers Next (Done at the
 * last), Back and Skip; `→` and `←` step too, `Esc` ends it, a held key steps once, and `Tab` goes
 * round the card. Each step's card is a card of its own, so moving to it moves focus to its Next and
 * it is read out, with its progress, and its control is scrolled into view; focus the walk's hold
 * leaves nowhere goes back to Next. Once the tour ends the dim goes in a moment. Reduced motion places
 * everything at once.
 */
export function TutorialLayer({ phase, step, shown, onTake, onSkip, onNext, onBack, onEnd }: {
  readonly phase: TourPhase | null; readonly step: number; readonly shown: readonly boolean[];
  readonly onTake: () => void; readonly onSkip: () => void; readonly onNext: () => void; readonly onBack: () => void; readonly onEnd: () => void;
}) {
  const id = useId();
  const layer = useContext(PanelLayer);
  const panel = layer?.panel ?? null;
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  // A press that began on the dim rather than on the card.
  const pressedScrim = useRef(false);
  const reduced = prefersReducedMotion();
  const current = phase === "walk" ? TUTORIAL_STEPS[step] ?? null : null;

  // Once the tour ends, its dim goes in a moment while the panel is already the person's again.
  const [leaving, setLeaving] = useState(false);
  const was = useRef<TourPhase | null>(null);
  const before = useRef<Element | null>(null);
  useLayoutEffect(() => {
    const previous = was.current;
    was.current = phase;
    // A welcome skipped gives focus back to what had it; the walk's own end puts it on More (web.tsx).
    if (previous === "welcome" && phase === null && panel) giveFocusBack(panel, root.current, before.current);
    if (phase !== null || previous === null || reduced) { setLeaving(false); return; }
    setLeaving(true);
    const timer = window.setTimeout(() => setLeaving(false), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  // The welcome and the walk's start hold the whole panel, after noting what had focus, which a skipped welcome gives it back to.
  const holding = phase === "welcome" || phase === "starting";
  useLayoutEffect(() => {
    if (!holding || !panel) return;
    before.current = panel.ownerDocument.activeElement;
    return holdPanel(panel);
  }, [holding, panel]);
  // The welcome opens with focus on its title, never on a choice, so a key meant for something else never answers it.
  const welcoming = phase === "welcome";
  useLayoutEffect(() => { if (welcoming) title.current?.focus({ preventScroll: true }); }, [welcoming]);
  const deliberate = useDeliberate(welcoming ? "welcome" : null);

  // What the panel shows, measured as it opens rather than a frame later, so the dim's closed opening starts in its middle.
  const followed = useVisibleBox(panel, phase !== null || leaving);
  const view = followed ?? (panel && (phase !== null || leaving) ? visibleBox(panel) : null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  // The elements the step lights now, which the walk's hold keeps usable when they may be tried.
  const litParts = useRef<readonly HTMLElement[]>([]);
  // Each step's control is brought into view once, as the step begins, before it is measured: by the panel's own scrolling
  // only, never its root nor anything of Manifold's around it, which the layer stands still in.
  const scrolled = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!panel || !current) { scrolled.current = null; return; }
    if (scrolled.current === step) return;
    const parts = tutorialLit(panel, current)?.parts ?? [];
    if (parts.length === 0) return;
    scrolled.current = step;
    revealIn(panel, parts);
  });
  function measure() {
    let found: Placed | null = null;
    if (panel && current) {
      const room = visibleBox(panel), lit = tutorialLit(panel, current);
      let hole: Box | null = null;
      if (lit) {
        const rects = lit.parts.map(part => inPanel(panel, part.getBoundingClientRect()));
        // The opening: what the step lights and a margin round it, kept to what the panel shows; none when nothing of it shows.
        const top = Math.max(room.top + 1, Math.min(...rects.map(rect => rect.top)) - OPENING_PX);
        const left = Math.max(room.left + 1, Math.min(...rects.map(rect => rect.left)) - OPENING_PX);
        const bottom = Math.min(room.top + room.height - 1, Math.max(...rects.map(rect => rect.top + rect.height)) + OPENING_PX);
        const right = Math.min(room.left + room.width - 1, Math.max(...rects.map(rect => rect.left + rect.width)) + OPENING_PX);
        if (bottom > top && right > left) hole = { top, left, width: right - left, height: bottom - top };
      }
      litParts.current = hole && lit ? lit.parts : [];
      found = { hole, card: placeCard(hole, room, card.current?.offsetHeight ?? 0), lit: hole && lit ? `${lit.target}:${lit.tryable}` : "" };
    }
    setPlaced(previous => JSON.stringify(previous) === JSON.stringify(found) ? previous : found);
  }
  // Every render may have moved the control (a read landing, a pane growing); the opening and the card follow it before paint.
  useLayoutEffect(measure);
  const latest = useRef(measure);
  latest.current = measure;
  // Between renders they follow what moves on its own: a resize of the panel, the stage or the control, a scroll, a view or
  // pane shown or hidden, and the end of any motion under way in the panel (a pane sliding in moves its control without
  // resizing or changing anything an observer sees); at most once a frame.
  const walking = current !== null;
  useEffect(() => {
    if (!panel || !walking) return;
    const window = panel.ownerDocument.defaultView;
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
    const stage = panel.querySelector("[data-tui]");
    if (stage) sizes.observe(stage);
    for (const part of current ? tutorialLit(panel, current)?.parts ?? [] : []) sizes.observe(part);
    changes.observe(panel, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
    panel.addEventListener("scroll", follow, true);
    window?.addEventListener("resize", follow);
    follow();
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      sizes.disconnect(); changes.disconnect();
      panel.removeEventListener("scroll", follow, true);
      window?.removeEventListener("resize", follow);
    };
  }, [panel, step, walking]);

  // The opening opens once, growing from the middle of what the panel shows, where the welcome stood, to the first control
  // the walk lights, and then glides from control to control: the closed opening is styled first, so it is seen to open
  // rather than appear.
  const [open, setOpen] = useState(false);
  const lit = placed?.hole != null;
  useLayoutEffect(() => {
    if (!lit) { setOpen(false); return; }
    if (open) return;
    // Styling the whole panel now gives the closed opening and its rule a style to glide from.
    void panel?.offsetWidth;
    setOpen(true);
  }, [lit, open]);
  const hole = placed?.hole && (open || reduced) ? placed.hole : null;
  const point = view ? { x: view.left + view.width / 2, y: view.top + view.height / 2 } : { x: 0, y: 0 };

  // What a step lights waits a moment before it may be tried, so a press or a double click's second aimed at what stood there
  // before (Next, Back, the card the press brought) never reaches it, with motion or without.
  const [landing, setLanding] = useState(false);
  useLayoutEffect(() => {
    if (!walking) { setLanding(false); return; }
    setLanding(true);
    const timer = window.setTimeout(() => setLanding(false), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [walking, step, placed?.lit]);
  const tryable = placed?.lit.endsWith(":true") === true && !landing;
  // Whether focus is the walk's: in the panel or its layer, or fallen to the page from there because what had it went away
  // (removed or made inert), rather than taken elsewhere in Manifold by the person.
  const focusOurs = useRef(false);
  useEffect(() => {
    if (!panel || !walking) return;
    const document = panel.ownerDocument;
    const into = (event: FocusEvent) => { focusOurs.current = event.target instanceof Node && panel.contains(event.target); };
    const away = (event: FocusEvent) => {
      const left = event.target;
      if (event.relatedTarget !== null || !(left instanceof HTMLElement) || !panel.contains(left)) return;
      // A press elsewhere leaves what had focus in place; what went away (a tried Show control) or turned inert does not.
      queueMicrotask(() => { if (left.isConnected && left.closest("[inert]") === null) focusOurs.current = false; });
    };
    focusOurs.current = panel.contains(document.activeElement);
    document.addEventListener("focusin", into, true);
    document.addEventListener("focusout", away, true);
    return () => { document.removeEventListener("focusin", into, true); document.removeEventListener("focusout", away, true); };
  }, [panel, walking]);
  // The walk holds the panel but what may be tried now. Focus the hold leaves on something it made inert, or that fell to the
  // page from the panel because what was tried went away (a Show control, once its pane shows), goes to Next, so the walk's
  // keys go on; focus the person took elsewhere in Manifold stays there.
  useLayoutEffect(() => {
    if (!walking || !panel) return;
    const document = panel.ownerDocument, focused = document.activeElement;
    const release = holdPanel(panel, tryable ? litParts.current : []);
    const stranded = ((!focused || focused === document.body) && focusOurs.current)
      || (focused !== null && focused !== panel && panel.contains(focused) && !focused.closest("[data-layer]") && focused.closest("[inert]") !== null);
    if (stranded) next.current?.focus({ preventScroll: true });
    return release;
  }, [walking, panel, step, placed?.lit, tryable]);

  // A step takes focus on its Next once its card is placed, once per step: what is read out is the card it moved to.
  const focused = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!current) { focused.current = null; return; }
    if (!placed || focused.current === step) return;
    focused.current = step;
    next.current?.focus({ preventScroll: true });
    // A card taller than a short panel scrolls within itself: its choices are brought into its view with the focus.
    const box = card.current;
    if (box && box.scrollHeight > box.clientHeight) box.scrollTop = box.scrollHeight;
  });

  if (!panel || !layer || (phase === null && !leaving)) return null;
  const place = current ? tutorialPlace(shown, step) : null;
  const last = nextTutorialStep(shown, step) === null, first = previousTutorialStep(shown, step) === null;
  const width = view ? cardWidth(view) : CARD_MAX_PX;
  const tallest = view ? Math.max(0, view.height - 2 * EDGE_PX) : undefined;
  function walkKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Tab") { keepTab(event); return; }
    if (event.repeat) { if (event.key !== "Escape") event.preventDefault(); return; }
    if (event.key === "Escape") onEnd();
    else if (event.key === "ArrowRight") onNext();
    else if (event.key === "ArrowLeft" && !first) onBack();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }
  function welcomeKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Tab") { keepTab(event); return; }
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) onSkip();
  }
  // A press counts once: never a double click's second, which would land on whatever the first one brought.
  const once = (does: () => void) => (event: { readonly detail: number }) => { if (event.detail <= 1) does(); };
  return createPortal(<div ref={root} className={`${G}tour`} data-layer="" data-holds={holding || undefined} data-tour={phase ?? undefined}
    data-leaving={phase === null || undefined} style={{ "--tui-acc": layer.accent } as CSSProperties}>
    <div className={`${G}tour-scrim`} aria-hidden="true" style={{ clipPath: dimmed(hole, point) }} onMouseDown={event => event.preventDefault()}
      onPointerDown={event => { pressedScrim.current = event.target === event.currentTarget; }}
      onClick={event => {
        const began = pressedScrim.current;
        pressedScrim.current = false;
        // Only the welcome takes its way out from the dim, as a question does; the walk's dim holds every press.
        if (phase === "welcome" && began && event.target === event.currentTarget && event.detail <= 1 && deliberate.settled()) onSkip();
      }} />
    {current && placed?.hole && <div className={`${G}tour-ring`} aria-hidden="true" data-look={!tryable || undefined}
      onMouseDown={event => event.preventDefault()}
      style={hole ? { top: hole.top, left: hole.left, width: hole.width, height: hole.height } : { top: point.y, left: point.x, width: 0, height: 0, opacity: 0 }} />}
    {welcoming && <div className={`${G}tour-room`} style={view ?? undefined}>
      <section className={`${G}tour-card ${G}tour-welcome`} role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`}
        data-tutorial="welcome" onKeyDown={welcomeKeys}>
        <h2 ref={title} id={`${id}-title`} tabIndex={-1}>{TUTORIAL_WELCOME.title}</h2>
        <p id={`${id}-text`}>{TUTORIAL_WELCOME.text}</p>
        <div className={`${G}tour-choices`}>
          <button type="button" className={`${G}decision-go`} data-tutorial-choice="take" {...deliberate.choice("take")}
            onClick={event => { if (deliberate.press(event.detail)) onTake(); }}>{TUTORIAL_WELCOME.take}</button>
          <button type="button" className={`${G}go-fix ${G}tour-skip`} data-tutorial-choice="skip" {...deliberate.choice("skip")}
            onClick={event => { if (deliberate.press(event.detail)) onSkip(); }}>{TUTORIAL_WELCOME.skip}</button>
        </div>
      </section>
    </div>}
    {current && <section key={step} ref={card} className={`${G}tour-card`} role="dialog" aria-labelledby={`${id}-title`}
      aria-describedby={place ? `${id}-progress ${id}-text` : `${id}-text`} data-tutorial={current.id} data-placed={placed ? "" : undefined} onKeyDown={walkKeys}
      style={placed ? { top: placed.card.top, left: placed.card.left, width, maxHeight: tallest } : { width, maxHeight: tallest }}>
      <div className={`${G}tour-head`}>
        <h2 id={`${id}-title`}>{current.title}</h2>
        {place && <span id={`${id}-progress`} className={`${G}tour-progress`} role="img" aria-label={`Step ${place.position} of ${place.count}`}>
          {Array.from({ length: place.count }, (_, index) => <i key={index} data-on={index < place.position || undefined} />)}
        </span>}
      </div>
      <p id={`${id}-text`}>{current.text}</p>
      <div className={`${G}tour-choices`}>
        <button ref={next} type="button" className={`${G}decision-go`} data-tutorial-choice="next" onClick={once(onNext)}>{last ? "Done" : "Next"}</button>
        {!first && <button type="button" className={`${G}go-fix`} data-tutorial-choice="back" onClick={once(onBack)}>Back</button>}
        {!last && <button type="button" className={`${G}go-fix ${G}tour-skip`} data-tutorial-choice="skip" onClick={once(onEnd)}>Skip</button>}
      </div>
    </section>}
  </div>, panel);
}
