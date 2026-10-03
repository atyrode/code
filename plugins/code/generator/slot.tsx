import { useLayoutEffect, useRef, type ReactNode } from "react";
import { prefersReducedMotion } from "@manifold/ui";
import { hueOf } from "../ui.tsx";
import { CONNECTORS, WORD_NAMES, type LaneMark, type Slot, type SlotOption } from "./statement-model.ts";

/** Statement class prefix; every part hangs from the generator root (statement.css). */
const S = "plugin-atyrode_code_generator__stmt-";

/** A commit's motion: a pointer commit rolls the word in from the side it came from, a keyboard commit blinks it. */
export type SlotMotion = { readonly kind: "roll" | "blink"; readonly from: -1 | 1; readonly serial: number };

export type SlotProps = {
  readonly slot: Slot;
  /** Unique within the panel; option ids derive from it. */
  readonly id: string;
  /** ±1 ghosts at rest: the first row's lane, tier and thinking. */
  readonly ghosted: boolean;
  /** One word per row: the tick track always shows. */
  readonly listed: boolean;
  readonly open: boolean;
  /** Edits wait: a step runs or a charge waits. The word keeps focus by arrows but leaves the Tab order. */
  readonly locked: boolean;
  /** Extras only: the switch the keyboard is on in the open list. */
  readonly cursor: number;
  readonly motion: SlotMotion | null;
  readonly onToggleOpen: () => void;
  readonly onCommit: (option: SlotOption, via: "pointer" | "keyboard", from: -1 | 1) => void;
  readonly onPoint: (option: SlotOption | null) => void;
};

function optionId(id: string, index: number): string {
  return `${id}-option-${index}`;
}

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

/** The 6px hatched redline beside an option whose choice is the cause of a role losing its route or of leading on a strained pool. */
function RedlineGlyph({ option }: { option: SlotOption }) {
  if (!option.redline) return null;
  const tight = option.redline.reason === "tight";
  return <>
    <span className={`${S}redline`} data-reason={tight ? "tight" : "stop"} aria-hidden="true" />
    <span className="plugin-atyrode_code__sr">, {tight ? "a pool without room" : "a role would lose its route"}</span>
  </>;
}

/**
 * One word of the statement: a listbox whose value is the word on the line. At rest the first
 * row shows its ±1 neighbours as ghosts, one type step smaller; pointing at a word shows no more
 * than those, and the full drum opens only on a click, a tap, Enter or Space, below the line. The
 * options are always in the document, hidden while closed, so the listbox reads the same open or
 * shut and the drum opening moves nothing.
 */
export function StatementSlot({ slot, id, ghosted, listed, open, locked, cursor, motion, onToggleOpen, onCommit, onPoint }: SlotProps) {
  const value = useRef<HTMLSpanElement>(null);
  const { word, options, current } = slot;
  const extras = word === "extras";
  const connector = CONNECTORS[word];
  useLayoutEffect(() => {
    const element = value.current;
    if (!motion || !element || prefersReducedMotion()) return;
    const frames = motion.kind === "roll"
      ? [{ transform: `translateY(${motion.from * 40}%)`, opacity: 0.35 }, { transform: "none", opacity: 1 }]
      : [{ backgroundColor: "var(--code-selected)" }, { backgroundColor: "transparent" }];
    element.animate(frames, { duration: 150, easing: "cubic-bezier(.23, 1, .32, 1)" });
  }, [motion?.serial]);
  const up = current > 0 ? options[current - 1] : undefined;
  const down = current >= 0 ? options[current + 1] : undefined;
  const ghost = (option: SlotOption | undefined, at: "up" | "down"): ReactNode => option && <span className={`${S}ghost`} data-at={at}
    data-off={!option.available || undefined} title={option.reason ?? undefined} aria-hidden="true"
    onPointerEnter={() => onPoint(option)} onPointerLeave={() => onPoint(null)}
    onClick={event => { event.stopPropagation(); if (option.available && !locked) onCommit(option, "pointer", at === "up" ? -1 : 1); }}>
    <Mark mark={option.mark} /><span className={`${S}text`}>{option.label}</span><RedlineGlyph option={option} />
    {option.last && <span className={`${S}last`}>last</span>}
  </span>;
  const active = extras ? (open && cursor >= 0 ? optionId(id, cursor) : undefined) : current >= 0 ? optionId(id, current) : undefined;
  const now = current >= 0 ? options[current] : undefined;
  return <div className={`${S}slot`} role="listbox" tabIndex={locked ? -1 : 0} aria-label={WORD_NAMES[word]} aria-disabled={locked || undefined}
    aria-multiselectable={extras || undefined} aria-activedescendant={active}
    data-stmt-word={word} data-open={open || undefined} data-ghosted={ghosted || undefined} data-listed={listed || undefined}
    data-changed={slot.changed || undefined}>
    {connector && <span className={`${S}connector`} aria-hidden="true">{connector}</span>}
    {/* The value, its ghosts and its drum share one box after the connector, so ghosts and options line up with the value. */}
    <span className={`${S}stack`}>
      <span ref={value} className={`${S}value`} aria-hidden="true" title={slot.label} onClick={() => { if (!locked || open) onToggleOpen(); }}>
        {now && <Mark mark={now.mark} />}<span className={`${S}text`}>{slot.label}</span>
      </span>
      {ghosted && !locked && <>{ghost(up, "up")}{ghost(down, "down")}</>}
      <span className={`${S}drum`} onPointerLeave={() => onPoint(null)}>
        {options.map((option, index) => {
          const selected = extras ? option.on : option.current;
          return <span key={option.value} id={optionId(id, index)} role="option" className={`${S}option`} aria-selected={selected}
            aria-disabled={!option.available || undefined} title={option.reason ?? undefined}
            data-current={option.current || undefined} data-cursor={(extras && index === cursor) || undefined}
            onPointerEnter={() => onPoint(option)}
            onClick={event => {
              event.stopPropagation();
              if (!open || locked || !option.available || option.current) return;
              onCommit(option, "pointer", index < current ? -1 : 1);
            }}>
            {extras ? <span className={`${S}box`} data-on={option.on || undefined} aria-hidden="true" /> : <Mark mark={option.mark} />}
            <span className={`${S}text`}>{option.label}</span><RedlineGlyph option={option} />
            {option.last && !option.current && <span className={`${S}last`}>{extras ? `last ${option.on ? "off" : "on"}` : "last"}</span>}
            <span className={`${S}note`}>{option.current ? "now" : option.note}</span>
          </span>;
        })}
      </span>
    </span>
    {!extras && <span className={`${S}ticks`} aria-hidden="true">{options.map((option, index) => <i key={option.value} data-on={index === current || undefined} />)}</span>}
  </div>;
}
