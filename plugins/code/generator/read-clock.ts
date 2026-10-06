import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { tickClock, type ReadClock } from "./auto-read.ts";

/*
 * The panel's own re-reads in React: whether the panel shows, and a clock that reads on its own by
 * the rules in auto-read.ts.
 */

/**
 * Whether the panel shows: its page is not hidden and the element is on screen. The host can move
 * a panel off screen or hide its tile without hiding the page, so both are watched.
 */
export function usePanelShown(element: RefObject<HTMLElement | null>): boolean {
  const [pageShown, setPageShown] = useState(() => typeof document === "undefined" || !document.hidden);
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const node = element.current;
    const page = node?.ownerDocument ?? document;
    const visibility = () => setPageShown(!page.hidden);
    page.addEventListener("visibilitychange", visibility);
    const observer = node && typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(entries => { const last = entries.at(-1); if (last) setOnScreen(last.isIntersecting); })
      : null;
    if (node) observer?.observe(node);
    return () => { page.removeEventListener("visibilitychange", visibility); observer?.disconnect(); };
  }, []);
  return pageShown && onScreen;
}

/** A clock's next read, whether one is owed and held, and the way to read now. */
export type ReadCadence = { readonly nextAt: number; readonly waiting: boolean; readonly now: () => void };

/**
 * Reads every `periodMs` while the panel shows, and once when it shows again unless `readOnShow` is
 * false, never while `held()` says the person is in the middle of something: such a read waits and
 * happens once the hold lifts (auto-read.ts `tickClock`). `held` is asked at the moment a read comes
 * due, so it may read the latest render's facts and the DOM. `now` reads at once, held or not, as a
 * person's own press does.
 */
export function useReadClock(periodMs: number, read: () => void, visible: boolean, held: () => boolean, readOnShow = true): ReadCadence {
  const [clock, setClock] = useState<ReadClock>(() => ({ at: Date.now(), owed: false }));
  const [wake, setWake] = useState(0);
  const latest = useRef({ read, held });
  latest.current = { read, held };
  const wasVisible = useRef(visible);
  useEffect(() => {
    const shown = readOnShow && visible && !wasVisible.current;
    wasVisible.current = visible;
    const nowMs = Date.now();
    const step = tickClock(clock, { nowMs, periodMs, visible, shown, held: latest.current.held() });
    if (step.read) latest.current.read();
    if (step.clock.at !== clock.at || step.clock.owed !== clock.owed) setClock(step.clock);
    if (step.wakeAt === null) return;
    const timer = window.setTimeout(() => setWake(count => count + 1), Math.max(0, step.wakeAt - nowMs));
    return () => window.clearTimeout(timer);
  }, [clock, visible, wake, periodMs, readOnShow]);
  const now = useCallback(() => {
    setClock({ at: Date.now(), owed: false });
    latest.current.read();
  }, []);
  return { nextAt: clock.at + periodMs, waiting: clock.owed && visible, now };
}
