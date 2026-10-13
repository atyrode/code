import { useId, useLayoutEffect, useRef } from "react";
import type { Decision, DecisionChoice } from "./decision-model.ts";
import { PanelDialog, useDeliberate } from "./panel-layer.tsx";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";

/**
 * THE QUESTION THE PANEL WAITS ON, in a dialog over the dimmed panel (panel-layer.tsx), so it cannot be
 * missed beside the launch and covers nothing outside Code. It opens with focus on its title, never on
 * a choice, since a check's charge or a review comes back while the person may be typing elsewhere:
 * `Tab` reaches the choices, the next action first. No press answers it in the first moments after it
 * opens or its question changes, and a key answers with a choice only once that choice has held focus
 * a moment, so a key meant for something else never answers it; neither does the second click of a
 * double click or a held key. `Esc`, and a settled press that starts and ends on the dimmed panel,
 * take the way out (the last choice) at any time, since it never spends or launches. Closing gives
 * focus back to what had it before.
 */
export function DecisionDialog({ decision, onChoose }: { decision: Decision | null; onChoose: (choice: DecisionChoice, detail: number) => void }) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // The question as it stands when an event arrives.
  const current = useRef(decision);
  current.current = decision;
  // Any change of what it asks, its words or its choices, is a new question to settle on, with focus back on its title.
  const asked = decision === null ? null : JSON.stringify([decision.kind, decision.title, decision.text, decision.items, decision.choices.map(choice => choice.label)]);
  const deliberate = useDeliberate(asked);
  useLayoutEffect(() => { if (asked !== null) heading.current?.focus({ preventScroll: true }); }, [asked]);
  const wayOut = () => { const out = current.current?.choices.at(-1); if (out) onChoose(out, 0); };
  return <PanelDialog open={decision !== null} className={`${G}sheet-dialog ${G}decision`} labelledBy={`${id}-title`} describedBy={`${id}-text`}
    data={{ "data-decision": decision?.kind }} focus={() => heading.current} settled={deliberate.settled} onDismiss={wayOut}>
    {decision && <div className={`${G}decision-body`}>
      <h2 ref={heading} id={`${id}-title`} tabIndex={-1}>{decision.title}</h2>
      <div id={`${id}-text`}>
        {decision.text.map(text => <p key={text}>{text}</p>)}
        {decision.items.length > 0 && <ul className={`${G}decision-items`}>{decision.items.map(item => <li key={item}>{item}</li>)}</ul>}
      </div>
      <div className={`${G}sheet-dialog-row ${G}decision-choices`}>
        {decision.choices.map((choice, index) => <button key={choice.label} type="button" className={index === 0 && decision.choices.length > 1 ? `${G}decision-go` : `${G}go-fix`}
          data-choice={choice.does.kind === "fix" ? choice.does.action.key : choice.does.kind} {...deliberate.choice(choice.label)}
          onClick={event => { if (deliberate.press(event.detail)) onChoose(choice, event.detail); }}>{choice.label}</button>)}
      </div>
    </div>}
  </PanelDialog>;
}
