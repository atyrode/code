import { useId, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import type { Decision, DecisionChoice } from "./decision-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
/**
 * How long a pointer press is ignored once the dialog opens: one that lands this soon was aimed at
 * what stood there before, as a click on Launch the moment its review or check comes back.
 */
export const DECISION_SETTLE_MS = 400;

/**
 * THE QUESTION A PRESS WAITS ON, in a modal dialog over the whole page, so it cannot be missed
 * beside the launch. It opens with focus on its title, never on a choice: a check's charge or a
 * review comes back while the person may be typing elsewhere, and no key meant for something else
 * may answer it. Tab reaches the choices, the next action first. Esc and a press on the backdrop take
 * the way out (the last choice), which never spends or launches; so does a close the browser forces.
 * The second click of a double click, a held key and a pointer press in the first moments after it
 * opens answer nothing. Closing gives focus back to what had it before, as a modal dialog does.
 */
export function DecisionDialog({ decision, onChoose }: { decision: Decision | null; onChoose: (choice: DecisionChoice, detail: number) => void }) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const openedAt = useRef(0);
  // Closes the dialog makes itself, because the question was answered or went: each fires a close event later, which is not a
  // way out the browser forced.
  const closes = useRef(0);
  // The question as it stands when an event arrives.
  const current = useRef(decision);
  current.current = decision;
  const asked = decision === null ? null : JSON.stringify([decision.kind, decision.title]);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (asked === null) {
      if (node.open) { closes.current += 1; node.close(); }
      return;
    }
    if (!node.open) node.showModal();
    // A new question, in a dialog just opened or one that stayed open, settles and takes focus again.
    openedAt.current = performance.now();
    heading.current?.focus({ preventScroll: true });
  }, [asked]);
  useLayoutEffect(() => () => { if (dialog.current?.open) { closes.current += 1; dialog.current.close(); } }, []);

  const wayOut = () => current.current?.choices.at(-1) ?? null;
  /** A pointer press (`detail` ≥ 1) counts only as a single click after the dialog has settled; the keyboard's (0) always does. */
  function choose(choice: DecisionChoice | null, detail: number) {
    if (!choice || detail > 1 || (detail === 1 && performance.now() - openedAt.current < DECISION_SETTLE_MS)) return;
    onChoose(choice, detail);
  }
  const held = (event: KeyboardEvent<HTMLButtonElement>) => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); };
  return <dialog ref={dialog} className={`${G}sheet-dialog ${G}decision`} aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`}
    data-decision={decision?.kind}
    onCancel={event => { event.preventDefault(); choose(wayOut(), 0); }}
    onClose={() => { if (closes.current > 0) closes.current -= 1; else choose(wayOut(), 0); }}
    onClick={event => { if (event.target === event.currentTarget) choose(wayOut(), event.detail); }}>
    {decision && <div className={`${G}decision-body`}>
      <h2 ref={heading} id={`${id}-title`} tabIndex={-1}>{decision.title}</h2>
      <div id={`${id}-text`}>
        {decision.text.map(text => <p key={text}>{text}</p>)}
        {decision.items.length > 0 && <ul className={`${G}decision-items`}>{decision.items.map(item => <li key={item}>{item}</li>)}</ul>}
      </div>
      <div className={`${G}sheet-dialog-row ${G}decision-choices`}>
        {decision.choices.map((choice, index) => <button key={choice.label} type="button" className={index === 0 && decision.choices.length > 1 ? `${G}decision-go` : `${G}go-fix`}
          data-choice={choice.does.kind === "fix" ? choice.does.action.key : choice.does.kind} onKeyDown={held} onClick={event => choose(choice, event.detail)}>{choice.label}</button>)}
      </div>
    </div>}
  </dialog>;
}
