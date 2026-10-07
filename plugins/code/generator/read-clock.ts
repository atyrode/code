import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { nextReads, readAll, runReads, tickReads, type Observation, type PanelClocks, type ReadKind } from "./auto-read.ts";

/*
 * The panel's own re-reads in React: whether the panel shows, and one coordinator that reads on its
 * own by the rules in auto-read.ts.
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

/** Each clock's next read, whether one is owed and held, and the way to read everything now. */
export type PanelReads = {
  readonly nextAt: Readonly<Record<ReadKind, number>>;
  readonly waiting: Readonly<Record<ReadKind, boolean>>;
  readonly now: () => void;
};

/**
 * Both of the panel's clocks, looked at together (auto-read.ts `tickReads`), so reads that come due
 * at once share one pass and each observation is read once in it. Never while `held()` says the
 * person is in the middle of something: such a read waits and happens once the hold lifts. `held` is
 * asked at the moment a read comes due, so it may read the latest render's facts and the DOM. `now`
 * reads everything at once, held or not, as a person's own press does, and restarts both clocks.
 */
export function usePanelReads(readers: Readonly<Record<Observation, () => void>>, visible: boolean, held: () => boolean): PanelReads {
  const [clocks, setClocks] = useState<PanelClocks>(() => readAll(Date.now()).clocks);
  const [wake, setWake] = useState(0);
  const latest = useRef({ readers, held });
  latest.current = { readers, held };
  const wasVisible = useRef(visible);
  useEffect(() => {
    const shown = visible && !wasVisible.current;
    wasVisible.current = visible;
    const nowMs = Date.now();
    const step = tickReads(clocks, { nowMs, visible, shown, held: latest.current.held() });
    runReads(step.reads, latest.current.readers);
    if (step.clocks !== clocks) setClocks(step.clocks);
    if (step.wakeAt === null) return;
    const timer = window.setTimeout(() => setWake(count => count + 1), Math.max(0, step.wakeAt - nowMs));
    return () => window.clearTimeout(timer);
  }, [clocks, visible, wake]);
  const now = useCallback(() => {
    const pass = readAll(Date.now());
    setClocks(pass.clocks);
    runReads(pass.reads, latest.current.readers);
  }, []);
  return useMemo(() => ({ nextAt: nextReads(clocks), waiting: { inputs: clocks.inputs.owed && visible, usage: clocks.usage.owed && visible }, now }),
    [clocks, visible, now]);
}
