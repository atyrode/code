import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import { prefersReducedMotion } from "@manifold/ui";
import { Glyph } from "./dial-row.tsx";
import { CHECKING_HOLD_MS } from "./verification.ts";

/*
 * What the Models and Setup sheets share, in the main view's language: a head like a pane head (back
 * to Code, the sheet's title and state, its quiet actions), one readout line for exact values and
 * reasons, one next action where the launch sits with its line beside it, square marks, block bars,
 * radio words and the key line. Styles: styles.css, "the Models and Setup sheets".
 */

/** Generator-panel class prefix; every part hangs from the generator root. */
const G = "plugin-atyrode_code_generator__";
const BACK = "M10 3.5 5.5 8l4.5 4.5";
const ENTER = "M13.25 2.75v5.5a1 1 0 0 1-1 1H3.5M6.75 6 3.5 9.25l3.25 3.25";
const CHECK = "M3 8.5 6.5 12 13 4.5";
/** How long a pointed key message stays in the readout. */
const SAID_MS = 2_600;
/** How long the fired mark (the check, the charge bar fading) shows after a press. */
const FIRED_MS = 1_200;

// ---------------------------------------------------------------- the sheet's own width

/** `tiny` under 300px, `narrow` under 760px, else `wide`: the sheet's width, not the window's. */
export type SheetMode = "tiny" | "narrow" | "wide";
/**
 * The layout the sheet's own width allows, judged before paint and whenever that width changes. A
 * change of width places things without motion (`data-boot`); a change of height (a pane growing)
 * moves nothing, so a hold or a press in progress keeps its animation.
 */
export function useSheetMode(sheet: RefObject<HTMLElement | null>): SheetMode {
  const [mode, setMode] = useState<SheetMode>("wide");
  useLayoutEffect(() => {
    const node = sheet.current;
    if (!node) return;
    let width = -1, frame = 0;
    const settle = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { delete node.dataset.boot; }); }); };
    const judge = () => {
      const next = node.clientWidth;
      // A hidden sheet has no width; it is judged again when it shows.
      if (next === width || next === 0) return;
      width = next;
      node.dataset.boot = "";
      setMode(next < 300 ? "tiny" : next < 760 ? "narrow" : "wide");
      settle();
    };
    judge();
    const observer = new ResizeObserver(judge);
    observer.observe(node);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);
  return mode;
}

// ---------------------------------------------------------------- the readout

/** What the readout says: an exact value in bold (in `color`), then why. */
export type Said = { readonly value: string; readonly text?: string; readonly warn?: boolean; readonly color?: string };
/** Hover and focus handlers that make an element say its readout while pointed or focused. */
export type ReadoutBind = (id: string) => {
  onPointerEnter: () => void; onPointerLeave: () => void; onFocus: () => void; onBlur: () => void;
};
export type Readout = { readonly said: Said | null; readonly bind: ReadoutBind; readonly say: (said: Said | null) => void };
/**
 * The one line exact values and reasons appear in: what a key or press just did (for a moment),
 * else what is pointed, else what has focus. `describe` names what each pointed or focused element
 * says now, so a value that changes while pointed is said as it is.
 */
export function useReadout(describe: (id: string) => Said | null): Readout {
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [said, setSaid] = useState<Said | null>(null);
  useEffect(() => {
    if (!said) return;
    const timer = window.setTimeout(() => setSaid(null), SAID_MS);
    return () => window.clearTimeout(timer);
  }, [said]);
  const bind: ReadoutBind = id => ({
    onPointerEnter: () => setHover(id), onPointerLeave: () => setHover(current => current === id ? null : current),
    onFocus: () => setFocus(id), onBlur: () => setFocus(current => current === id ? null : current),
  });
  return { said: said ?? (hover === null ? null : describe(hover)) ?? (focus === null ? null : describe(focus)), bind, say: setSaid };
}
/** Two lines tall at rest (three when narrow), whatever it says, so nothing below it moves. */
export function SheetReadout({ said }: { said: Said | null }) {
  return <div className={`${G}sheet-readout`} data-readout="" aria-live="polite" data-tone={said?.warn ? "warn" : undefined}
    style={said?.color ? { "--rc": said.color } as CSSProperties : undefined}>
    {said && <><b>{said.value}</b>{said.text && ` · ${said.text}`}</>}
  </div>;
}

// ---------------------------------------------------------------- the head

export function SheetHead({ title, state, acts, onBack, backRef }: {
  title: string; state: ReactNode; acts?: ReactNode; onBack: () => void; backRef: Ref<HTMLButtonElement>;
}) {
  return <header className={`${G}sheet-head`}>
    <button ref={backRef} type="button" className={`${G}sheet-back`} aria-label="Back to Code" title="Back to Code (Esc)" aria-keyshortcuts="Escape" onClick={onBack}>
      <Glyph path={BACK} /><span>code</span>
    </button>
    <h2 className={`${G}sheet-title`}>{title}</h2>
    <span className={`${G}sheet-state`} role="status">{state}</span>
    {acts && <span className={`${G}sheet-acts`}>{acts}</span>}
  </header>;
}
/** A quiet action in the head, its key beside its word; refused, it says why in the readout rather than going away. */
export function SheetCue({ cue, keyName, label, refusal, onPress, readout }: {
  cue: string; keyName: string; label: string; refusal: string | null; onPress: () => void; readout: Readout;
}) {
  return <button type="button" className={`${G}sheet-cue`} data-cue={cue} aria-keyshortcuts={keyName} aria-disabled={refusal !== null || undefined}
    title={`${label} (${keyName})`} onClick={() => { if (refusal) readout.say({ value: label, text: refusal, warn: true }); else onPress(); }}>
    <span className={`${G}sheet-cue-key`} aria-hidden="true">{keyName}</span>{label}
  </button>;
}

// ---------------------------------------------------------------- the one next action

export type GoTone = "warn" | "attention" | "done" | "strong";
export type GoFix = { readonly label: string; readonly run: () => void };
/** The next action: its label, whether a step runs (`busy`) or it cannot be pressed now, and the line beside it. */
export type GoAction = {
  readonly label: string;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly parts: readonly (readonly [text: string, tone: GoTone | null])[];
  readonly fixes: readonly GoFix[];
};
/** A press of the next action: `detail` is the pointer's click count, 0 from the keyboard. Answers why it refused, or null when it went. */
export type GoPress = (detail: number) => string | null;
export type GoHandle = { press: () => void };

/**
 * The one next action, where the launch sits, and its line beside it. It reads as the launch does:
 * the accent, the enter mark, pressed while held, a check and a fading charge bar once fired, a
 * shake and the reason in the readout when refused. `hold` draws the checking hold a verification
 * keeps before its charge can be confirmed. A held key never repeats a press.
 */
export function SheetGo({ action, hold, onPress, readout, handle }: {
  action: GoAction; hold: boolean; onPress: GoPress; readout: Readout; handle?: Ref<GoHandle>;
}) {
  const lineId = useId();
  const [pressing, setPressing] = useState(false);
  const [fired, setFired] = useState(0);
  const [shake, setShake] = useState(0);
  useEffect(() => {
    if (!fired) return;
    const timer = window.setTimeout(() => setFired(0), FIRED_MS);
    return () => window.clearTimeout(timer);
  }, [fired]);
  // The press may name the next step at once (verify models → checking models…); a step after that one does not
  // inherit the press's check, so a charge that arrives quickly never reads as already confirmed.
  const stepsSincePress = useRef(0);
  useEffect(() => {
    if (!fired) return;
    stepsSincePress.current += 1;
    if (stepsSincePress.current > 1) setFired(0);
  }, [action.label]);
  const off = action.busy === true || action.disabled === true;
  function press(detail: number) {
    const refusal = onPress(detail);
    const still = prefersReducedMotion();
    if (refusal !== null) {
      if (!still) setShake(previous => previous === 1 ? 2 : 1);
      readout.say({ value: action.label.replace("…", ""), text: refusal, warn: true });
      return;
    }
    if (still) return;
    stepsSincePress.current = 0;
    setFired(previous => previous + 1);
  }
  const latest = useRef(press);
  latest.current = press;
  useImperativeHandle(handle, () => ({ press: () => latest.current(0) }), []);
  return <div className={`${G}sheet-foot`}>
    <button type="button" className={`${G}go`} data-go="" aria-describedby={lineId} aria-disabled={off || undefined} aria-busy={action.busy || undefined}
      data-pressing={pressing || undefined} data-fired={fired > 0 || undefined} data-hold={hold || undefined} data-shake={shake || undefined}
      style={{ "--hold": `${CHECKING_HOLD_MS}ms` } as CSSProperties} {...readout.bind("go")}
      onPointerDown={event => { if (event.button === 0 && !off) setPressing(true); }}
      onPointerUp={() => setPressing(false)} onPointerLeave={() => setPressing(false)} onPointerCancel={() => setPressing(false)}
      onKeyDown={event => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }}
      onClick={event => press(event.detail)}>
      <span className={`${G}go-mark`}><Glyph className={`${G}go-arrow`} path={ENTER} /><Glyph className={`${G}go-ok`} path={CHECK} /></span>
      <span className={`${G}go-label`}>{action.label}</span>
      <i className={`${G}go-charge`} aria-hidden="true" />
    </button>
    <span className={`${G}go-line`} id={lineId}>
      {action.parts.length > 0 && <span className={`${G}go-parts`}>{action.parts.map(([text, tone]) =>
        <span key={text} className={`${G}go-part`} data-tone={tone ?? undefined}>{text}</span>)}</span>}
      {action.fixes.map(fix => <button key={fix.label} type="button" className={`${G}go-fix`} onClick={fix.run}>{fix.label}</button>)}
    </span>
  </div>;
}
/** Whether a key press starts a sheet's next action: `⏎` anywhere but a control or a field that takes it itself. */
export function pressesGo(event: KeyboardEvent<HTMLElement>): boolean {
  const target = event.target as HTMLElement;
  return event.key === "Enter" && !event.repeat && !target.closest("button, a, input, select, textarea, dialog");
}
/** Whether a sheet's own keys may answer this press: none with a modifier, in a field or in a dialog. */
export function sheetKeyFree(event: KeyboardEvent<HTMLElement>): boolean {
  const target = event.target as HTMLElement;
  return !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey &&
    !target.matches("input, textarea, select, [contenteditable]") && !target.closest("dialog");
}

// ---------------------------------------------------------------- marks, blocks, words and keys

/** An 8px square, filled when on: a row's state, a scope's line. */
export function Mark({ on }: { on: boolean }) {
  return <span className={`${G}sheet-mark`} data-on={on || undefined} aria-hidden="true" />;
}
/** One block per request, filled as it is answered. */
export function Blocks({ total, done }: { total: number; done: number }) {
  return <span className={`${G}sheet-blocks`} aria-hidden="true">
    {Array.from({ length: total }, (_, index) => <i key={index}><b data-on={index < done || undefined} /></i>)}
  </span>;
}
/**
 * A choice of a few words, as the generator's rows choose: one Tab stop on the chosen word, `←` `→`
 * between them, the chosen one in the accent. Each word reserves its bold width, so choosing moves
 * nothing.
 */
export function Words<T extends string>({ name, options, value, onPick, refusal, readout, describeAs }: {
  name: string; options: readonly (readonly [T, string])[]; value: T; onPick: (value: T) => void;
  refusal: string | null; readout: Readout; describeAs: string;
}) {
  const group = useRef<HTMLSpanElement>(null);
  function pick(next: T, focus: boolean) {
    if (refusal) { readout.say({ value: name, text: refusal, warn: true }); return; }
    onPick(next);
    if (focus) requestAnimationFrame(() => group.current?.querySelector<HTMLElement>(`[data-word="${next}"]`)?.focus());
  }
  return <span ref={group} className={`${G}sheet-words`} role="radiogroup" aria-label={name} {...readout.bind(describeAs)}>
    {options.map(([option, label]) => <button key={option} type="button" role="radio" className={`${G}sheet-word`} data-word={option} data-text={label}
      aria-checked={option === value} aria-disabled={refusal !== null || undefined} tabIndex={option === value ? 0 : -1}
      onClick={() => pick(option, false)}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        const at = options.findIndex(([candidate]) => candidate === value) + (event.key === "ArrowRight" ? 1 : -1);
        pick(options[Math.max(0, Math.min(options.length - 1, at))]![0], true);
      }}>{label}</button>)}
  </span>;
}
/** The sheet's key line: what its keys do. A coarse pointer has no keys, so it has no key line. */
export function SheetKeys({ keys }: { keys: readonly (readonly [key: string, does: string])[] }) {
  return <footer className={`${G}sheet-keys`} aria-label="keys">
    {keys.map(([key, does], index) => <span key={key} className={`${G}sheet-keys-item`}>
      {index > 0 && <span className={`${G}keys-sep`} aria-hidden="true">•</span>}
      <span className={`${G}keys-word`}><span className={`${G}keys-key`}>{key}</span>{does}</span>
    </span>)}
  </footer>;
}
