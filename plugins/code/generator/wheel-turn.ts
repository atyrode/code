import { useEffect, useRef, type RefObject } from "react";
import { panelWheel, wheelScrolled, wheelTravel, WHEEL_STILL } from "./panel-input.ts";

/** The generator panel's root: wheel rest is judged across all of it, not only the region that turns. */
const PANEL_ROOT = ".plugin-atyrode_code_generator";

/** Which elements the wheel may turn: `controls` when the keyboard focused them, `open` (a drum or menu showing its options) at once. */
export type WheelTargets = { readonly controls: string; readonly open?: string | undefined };

/**
 * Turns controls with the wheel under the panel-wide rule (panel-input.ts `panelWheel`). Every wheel
 * and scroll event in the panel root feeds one rest tracker, so a gesture that began over the
 * masthead, routing or usage and drifts onto a control keeps scrolling, even at a scroll boundary
 * where no scroll event fires. Pointer movement in the root times how long the pointer has rested
 * on the control under it; a scroll resets that, since the control under a still pointer changed.
 * Only an element matching `targets` inside `region` turns, and `turn` receives it with the step.
 * The listener is native and non-passive because React's wheel handler is passive and could not
 * keep a turn from also scrolling the page.
 */
export function useWheelTurn(region: RefObject<HTMLElement | null>, targets: WheelTargets, disabled: boolean,
  turn: (control: HTMLElement, step: 1 | -1) => void): void {
  const latest = useRef({ disabled, turn });
  latest.current = { disabled, turn };
  const { controls, open } = targets;
  useEffect(() => {
    const scope = region.current;
    if (!scope) return;
    const root = scope.closest<HTMLElement>(PANEL_ROOT) ?? scope;
    let rest = WHEEL_STILL;
    let resting: { control: Element | null; since: number } = { control: null, since: Number.POSITIVE_INFINITY };
    const target = (node: EventTarget | null) => node instanceof Element ? node.closest<HTMLElement>(open ? `${open}, ${controls}` : controls) : null;
    const scrolled = () => {
      rest = wheelScrolled(rest, performance.now());
      resting = { control: null, since: Number.POSITIVE_INFINITY };
    };
    const moved = (event: PointerEvent) => {
      const control = target(event.target);
      if (control !== resting.control) resting = { control, since: performance.now() };
    };
    const wheel = (event: WheelEvent) => {
      const now = performance.now();
      const control = target(event.target);
      const inside = control !== null && scope.contains(control) && !latest.current.disabled;
      const active = control?.ownerDocument.activeElement ?? null;
      const result = panelWheel(rest, {
        open: inside && open !== undefined && control.matches(open),
        keyboardFocused: inside && active !== null && control.contains(active) && active.matches(":focus-visible"),
        restedMs: control !== null && control === resting.control ? now - resting.since : 0,
        zoom: event.ctrlKey || event.metaKey, travel: wheelTravel(event, root.clientHeight), nowMs: now,
      });
      rest = result.rest;
      if (!result.take || !control) return;
      event.preventDefault();
      if (result.step !== 0) latest.current.turn(control, result.step);
    };
    root.addEventListener("scroll", scrolled, { capture: true, passive: true });
    root.addEventListener("pointermove", moved, { passive: true });
    root.addEventListener("wheel", wheel, { passive: false });
    return () => {
      root.removeEventListener("scroll", scrolled, { capture: true });
      root.removeEventListener("pointermove", moved);
      root.removeEventListener("wheel", wheel);
    };
  }, [region, controls, open]);
}
