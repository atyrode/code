import type { ReactNode } from "react";

/**
 * A session option that is on or off, in the pool heads' grammar: an 8px square, filled when on,
 * before its words. A refused one stays focusable (`aria-disabled`) and says why in its title.
 */
export function OptionSwitch({ on, refusal, label, onChange, children }: {
  on: boolean; refusal: string | null; label?: string; onChange: (on: boolean) => void; children: ReactNode;
}) {
  return <button type="button" role="switch" className="plugin-atyrode_code_generator__option-switch" aria-checked={on} aria-disabled={refusal !== null || undefined}
    aria-label={label} title={refusal ?? undefined} onClick={() => { if (refusal === null) onChange(!on); }}>
    <i aria-hidden="true" />{children}
  </button>;
}
