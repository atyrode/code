import { useEffect, useRef, type RefObject } from "react";
import { panelWheel, wheelScrolled, wheelTravel, WHEEL_STILL } from "./panel-input.ts";

/** The generator panel's root: wheel rest is judged across all of it, not only the region that turns. */
const PANEL_ROOT = ".plugin-atyrode_code_generator";

/**
 * Turns focused controls with the wheel under the panel-wide rest rule (panel-input.ts
 * `panelWheel`). Every wheel and scroll event in the panel root feeds one rest tracker, so a
 * gesture that began over the masthead, routing or usage and drifts onto a focused control keeps
 * scrolling, even at a scroll boundary where no scroll event fires. Only a control matching
 * `selector` inside `region` turns, and `turn` receives it with the step. The listener is native and
 * non-passive because React's wheel handler is passive and could not keep a turn from also
 * scrolling the page.
 */
export function useWheelTurn(region: RefObject<HTMLElement | null>, selector: string, disabled: boolean,
  turn: (control: HTMLElement, step: 1 | -1) => void): void {
  const latest = useRef({ disabled, turn });
  latest.current = { disabled, turn };
  useEffect(() => {
    const scope = region.current;
    if (!scope) return;
    const root = scope.closest<HTMLElement>(PANEL_ROOT) ?? scope;
    let rest = WHEEL_STILL;
    const scrolled = () => { rest = wheelScrolled(rest, performance.now()); };
    const wheel = (event: WheelEvent) => {
      const control = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
      const focusedControl = control !== null && scope.contains(control) && !latest.current.disabled && control.contains(control.ownerDocument.activeElement);
      const result = panelWheel(rest, { focusedControl, zoom: event.ctrlKey || event.metaKey, travel: wheelTravel(event, root.clientHeight), nowMs: performance.now() });
      rest = result.rest;
      if (!result.take || !control) return;
      event.preventDefault();
      if (result.step !== 0) latest.current.turn(control, result.step);
    };
    root.addEventListener("scroll", scrolled, { capture: true, passive: true });
    root.addEventListener("wheel", wheel, { passive: false });
    return () => { root.removeEventListener("scroll", scrolled, { capture: true }); root.removeEventListener("wheel", wheel); };
  }, [region, selector]);
}
