import { useLayoutEffect, useRef, type FocusEvent } from "react";
import { prefersReducedMotion } from "@manifold/ui";
import { hueOf } from "../ui.tsx";
import { WORD_NAMES, type LaneMark, type Slot, type SlotOption } from "./statement-model.ts";

/** Statement class prefix; every part hangs from the generator root (styles.css). */
const S = "plugin-atyrode_code_generator__stmt-";

export type SettingProps = {
  readonly slot: Slot;
  /** Unique within the panel; the label's id derives from it. */
  readonly id: string;
  /** Edits wait: a step runs or a charge waits. Every value leaves the Tab order but stays reachable by arrows. */
  readonly locked: boolean;
  /** Extras only: the switch that holds the setting's Tab stop, the one the keyboard was last on. */
  readonly anchor: number;
  /** A press on a value: choose it, or turn the switch. */
  readonly onChoose: (option: SlotOption) => void;
  /** Point at a value (or let go of `left`, the one pointed), by the pointer or by keyboard focus. */
  readonly onPoint: (option: SlotOption | null, left?: SlotOption) => void;
  /** Extras only: keyboard focus arrived on this switch, which now holds the Tab stop. */
  readonly onAnchor: (index: number) => void;
};

function Mark({ mark }: { mark: LaneMark | null }) {
  if (!mark) return null;
  if (mark.kind === "mixed") return <span className={`${S}lane-mark`} aria-hidden="true">
    <span className="plugin-atyrode_code__mark" data-fam="openai" /><span className="plugin-atyrode_code__mark" data-fam="anthropic" />
  </span>;
  return <span className={`${S}lane-mark`} aria-hidden="true">
    <span className="plugin-atyrode_code__mark" data-fam={hueOf(mark.family)} />
    {mark.cross && <span className={`plugin-atyrode_code__mark ${S}cross`} data-fam={hueOf(mark.cross)} />}
  </span>;
}

/**
 * A value's name for assistive technology: its words, why it cannot be chosen (or, for the chosen machine, why it cannot
 * be reached), what choosing it causes, and the last launch's mark.
 */
function valueName(option: SlotOption): string {
  return [
    option.label,
    ...!option.available ? [`unavailable: ${option.reason ?? option.note}`] : option.reason ? [option.reason] : [],
    ...option.redline ? [option.redline.reason === "tight" ? "a pool without room" : "a role would lose its route"] : [],
    ...option.last ? ["last launch"] : [],
  ].join(", ");
}

/**
 * One setting: a quiet label, then every value as a word on one baseline, low to high from left to
 * right. The current value is bright and heavier with the accent pointer before it; every value
 * keeps room for its heavier form, so choosing one never moves another. Extras are independent
 * switches, each an 8px square filled when on, and the machine lists every machine with a 6px
 * dot filled while it is online. A value that cannot be chosen is dimmed with its reason in its
 * name and title; one whose choice would leave a role without a route, or lead on a strained pool,
 * carries the hatched redline. Pointing or keyboard focus says what a value would do through
 * `onPoint`; a press chooses through `onChoose`. The setting is a radio group (extras a group of
 * switches) with one Tab stop: the current value, or the switch the keyboard was last on.
 */
export function SettingRow({ slot, id, locked, anchor, onChoose, onPoint, onAnchor }: SettingProps) {
  const values = useRef<HTMLSpanElement>(null);
  const shown = useRef<string | null>(null);
  const { word, options, current } = slot;
  const extras = word === "extras";
  const now = current >= 0 ? options[current]!.value : null;
  // The pointer slides from the value it left to the one chosen; under reduced motion it simply moves.
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = now;
    const box = values.current;
    if (!box || before === null || now === null || before === now || prefersReducedMotion()) return;
    const pointer = (value: string) => [...box.querySelectorAll<HTMLElement>("[data-value]")].find(element => element.dataset.value === value)
      ?.querySelector<HTMLElement>(`.${S}pointer`);
    const from = pointer(before)?.getBoundingClientRect(), to = pointer(now);
    const at = to?.getBoundingClientRect();
    if (!from || !to || !at) return;
    to.animate([{ transform: `translate(${from.left - at.left}px, ${from.top - at.top}px)` }, { transform: "none" }],
      { duration: 160, easing: "cubic-bezier(.23, 1, .32, 1)" });
  }, [now]);
  const holder = extras ? anchor : current;
  const focused = (option: SlotOption, index: number) => (event: FocusEvent<HTMLElement>) => {
    if (extras) onAnchor(index);
    // Keyboard focus points like the pointer does; the current value says nothing new, and a click's focus is the click's.
    if (event.currentTarget.matches(":focus-visible") && (extras || !option.current)) onPoint(option);
  };
  return <div className={`${S}setting`} role={extras ? "group" : "radiogroup"} aria-labelledby={`${id}-label`} aria-disabled={locked || undefined}
    data-setting={word} data-edited={slot.edited || undefined}>
    <span className={`${S}label`}><span id={`${id}-label`} className={`${S}label-text`}>{WORD_NAMES[word].toLowerCase()}</span></span>
    <span ref={values} className={`${S}values`}>
      {options.map((option, index) => <span key={option.value} role={extras ? "switch" : "radio"} aria-checked={extras ? option.on : option.current}
        aria-disabled={!option.available || locked || undefined} aria-label={valueName(option)} title={option.reason ?? undefined}
        tabIndex={!locked && index === holder ? 0 : -1} className={`${S}value`} data-value={option.value} data-anchor={index === holder || undefined}
        data-current={option.current || undefined} data-on={(extras && option.on) || undefined} data-off={!option.available || undefined}
        data-online={option.online === null ? undefined : String(option.online)}
        onClick={() => onChoose(option)} onPointerEnter={() => onPoint(option)} onPointerLeave={() => onPoint(null, option)}
        onFocus={focused(option, index)} onBlur={() => onPoint(null, option)}>
        <i className={`${S}pointer`} aria-hidden="true" />
        {extras && <i className={`${S}switch`} aria-hidden="true" />}
        {option.online !== null && <i className={`${S}dot`} aria-hidden="true" />}
        <Mark mark={option.mark} />
        <span className={`${S}word`} data-text={option.label}>{option.label}</span>
        {option.redline && <i className={`${S}redline`} data-reason={option.redline.reason === "tight" ? "tight" : "stop"} aria-hidden="true" />}
      </span>)}
    </span>
  </div>;
}
