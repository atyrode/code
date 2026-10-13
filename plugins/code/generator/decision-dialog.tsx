import { useId, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import type { Decision, DecisionChoice } from "./decision-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
/**
 * How long a press is ignored once a question opens or changes: one that lands this soon was aimed at
 * what stood there before, as a click on Launch the moment its review or check comes back.
 */
export const DECISION_SETTLE_MS = 400;
/**
 * How long a choice must have held focus before a key answers with it: Tab then Enter in one burst,
 * as typing meant for somewhere else lands, is never an answer.
 */
export const DECISION_FOCUS_MS = 300;

/**
 * THE QUESTION THE PANEL WAITS ON, in a modal dialog over the whole page, so it cannot be missed
 * beside the launch. It opens with focus on its title, never on a choice, since a check's charge or a
 * review comes back while the person may be typing elsewhere: `Tab` reaches the choices, the next
 * action first. No press answers it in the first moments after it opens or its question changes, and
 * a key answers with a choice only once that choice has held focus a moment, so a key meant for
 * something else never answers it; neither does the second click of a double click or a held key.
 * `Esc`, a press that starts and ends on the backdrop, and a close the browser forces take the way out
 * (the last choice) at any time, since it never spends or launches. Closing gives focus back to what
 * had it before, as a modal dialog does.
 */
export function DecisionDialog({ decision, onChoose }: { decision: Decision | null; onChoose: (choice: DecisionChoice, detail: number) => void }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const openedAt = useRef(0);
  // When each choice took focus, by label; a choice without focus has none.
  const focusedAt = useRef(new Map<string, number>());
  // A press that began on the backdrop rather than in the box or on its edge.
  const pressedOutside = useRef(false);
  // Closes the dialog makes itself, because the question was answered or went: each fires a close event later, which is not a
  // way out the browser forced.
  const closes = useRef(0);
  // The question as it stands when an event arrives.
  const current = useRef(decision);
  current.current = decision;
  // Any change of what it asks, its words or its choices, is a new question to settle on.
  const asked = decision === null ? null : JSON.stringify([decision.kind, decision.title, decision.text, decision.items, decision.choices.map(choice => choice.label)]);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (asked === null) {
      if (node.open) { closes.current += 1; node.close(); }
      return;
    }
    if (!node.open) node.showModal();
    openedAt.current = performance.now();
    focusedAt.current.clear();
    heading.current?.focus({ preventScroll: true });
  }, [asked]);
  useLayoutEffect(() => () => { if (dialog.current?.open) { closes.current += 1; dialog.current.close(); } }, []);

  const wayOut = () => { const out = current.current?.choices.at(-1); if (out) onChoose(out, 0); };
  /**
   * A press of a choice: a pointer's (`detail` 1) once the question has settled, a key's (`detail` 0)
   * once the question has settled and the choice has held focus, never a multi-click's second.
   */
  function choose(choice: DecisionChoice, detail: number) {
    const now = performance.now();
    if (detail > 1 || now - openedAt.current < DECISION_SETTLE_MS) return;
    if (detail === 0 && now - (focusedAt.current.get(choice.label) ?? now) < DECISION_FOCUS_MS) return;
    onChoose(choice, detail);
  }
  const outside = (event: MouseEvent<HTMLDialogElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.target === event.currentTarget &&
      (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
  };
  const held = (event: KeyboardEvent<HTMLButtonElement>) => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); };
  return <dialog ref={dialog} className={`${G}sheet-dialog ${G}decision`} aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`}
    data-decision={decision?.kind}
    onCancel={event => { event.preventDefault(); wayOut(); }}
    onClose={() => { if (closes.current > 0) closes.current -= 1; else wayOut(); }}
    onPointerDown={event => { pressedOutside.current = outside(event); }}
    onClick={event => {
      if (!pressedOutside.current || !outside(event) || event.detail > 1 || performance.now() - openedAt.current < DECISION_SETTLE_MS) return;
      pressedOutside.current = false;
      wayOut();
    }}>
    {decision && <div className={`${G}decision-body`}>
      <h2 ref={heading} id={`${id}-title`} tabIndex={-1}>{decision.title}</h2>
      <div id={`${id}-text`}>
        {decision.text.map(text => <p key={text}>{text}</p>)}
        {decision.items.length > 0 && <ul className={`${G}decision-items`}>{decision.items.map(item => <li key={item}>{item}</li>)}</ul>}
      </div>
      <div className={`${G}sheet-dialog-row ${G}decision-choices`}>
        {decision.choices.map((choice, index) => <button key={choice.label} type="button" className={index === 0 && decision.choices.length > 1 ? `${G}decision-go` : `${G}go-fix`}
          data-choice={choice.does.kind === "fix" ? choice.does.action.key : choice.does.kind} onKeyDown={held}
          onFocus={() => focusedAt.current.set(choice.label, performance.now())} onBlur={() => focusedAt.current.delete(choice.label)}
          onClick={event => choose(choice, event.detail)}>{choice.label}</button>)}
      </div>
    </div>}
  </dialog>;
}
