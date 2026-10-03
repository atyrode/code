import { useId, useLayoutEffect, useRef } from "react";
import { keyCapLabel } from "@manifold/plugin/hooks";
import { KeyCap } from "@manifold/ui";

/** Keys-dialog class prefix; every part hangs from the generator root (styles.css). */
const K = "plugin-atyrode_code_generator__keys-dialog";

export type KeyHelp = { readonly keys: readonly string[]; readonly text: string };
/** One region's keys: the statement's, the board's, the earlier statements'. */
export type KeyGroup = { readonly title: string; readonly keys: readonly KeyHelp[] };

/**
 * The panel's keys, as a dialog that takes focus when it opens and gives it back when it closes.
 * Esc or `?` closes it, and the statement ignores keys pressed inside it, so nothing behind it acts.
 * Tab cycles through its own controls, so the keyboard never walks out of it into nothing; focus
 * leaving it otherwise, as a press elsewhere does, closes it and leaves focus where it went.
 */
export function KeysDialog({ open, groups, onClose }: { open: boolean; groups: readonly KeyGroup[]; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const title = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const element = dialog.current;
    origin.current = element?.ownerDocument.activeElement instanceof HTMLElement ? element.ownerDocument.activeElement : null;
    element?.focus({ preventScroll: true });
    return () => {
      const back = origin.current;
      if (back?.isConnected) back.focus({ preventScroll: true });
    };
  }, [open]);
  if (!open) return null;
  return <div ref={dialog} className={K} role="dialog" aria-labelledby={title} tabIndex={-1}
    onKeyDown={event => {
      if (event.key === "Tab") {
        event.preventDefault();
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button, [href], [tabindex='0']")];
        const at = controls.indexOf(event.target as HTMLElement);
        const next = at === -1 ? (event.shiftKey ? controls.length - 1 : 0) : (at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        controls[next]?.focus();
        return;
      }
      if (event.key !== "Escape" && event.key !== "?") return;
      event.preventDefault();
      onClose();
    }}
    onBlur={event => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      // Focus went somewhere on purpose: closing must not pull it back.
      origin.current = null;
      onClose();
    }}>
    <div className={`${K}-head`}>
      <h2 id={title} className={`${K}-title`}>Keys</h2>
      <button type="button" className={`${K}-close`} aria-label="Close keys" onClick={onClose}><KeyCap label="Esc" /></button>
    </div>
    {groups.map(group => <section key={group.title} className={`${K}-group`} aria-label={group.title}>
      <h3 className={`${K}-group-title`}>{group.title}</h3>
      <dl>{group.keys.map(entry => <div key={entry.text} className={`${K}-row`}>
        <dt>{entry.keys.map(key => <KeyCap key={key} label={keyCapLabel(key)} />)}</dt><dd>{entry.text}</dd>
      </div>)}</dl>
    </section>)}
  </div>;
}
