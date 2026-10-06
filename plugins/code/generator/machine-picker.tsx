import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { SlotOption } from "./statement-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";

/** What the panel's `w` asks of the picker: open its list with focus in it. */
export type MachinePickerHandle = { readonly open: () => void };

export type MachinePickerProps = {
  /** The machine slot's values (statement-model.ts `machineSlot`): every machine on the roster, the destination first when the roster does not list it. */
  readonly options: readonly SlotOption[];
  /** Why the destination cannot change now (the `edit-machine` gate's refusal); null when it can. */
  readonly locked: string | null;
  readonly onChoose: (option: SlotOption) => void;
  /** A machine that cannot be chosen (offline, access revoked) was chosen. */
  readonly onRefuse: (option: SlotOption) => void;
  /** The picker was asked to open while the destination cannot change. */
  readonly onLocked: () => void;
  /** The machine under the pointer or the list's cursor, for the readout; null when none is. */
  readonly onPoint: (option: SlotOption | null) => void;
  readonly handle: RefObject<MachinePickerHandle | null>;
};

/**
 * Where the launch runs: `on studio` after the launch's label, the machine's name a word that opens
 * a short list of the roster above the launch line, each machine with its neutral online dot. Click,
 * or ↑↓ and ↵, chooses; Esc, Tab or a press outside closes, and focus returns to the word. While the
 * list is open it owns its keys (`data-popover`), so the panel's keys leave them alone. A machine
 * that cannot be chosen is struck through and refuses with its reason; while the destination cannot
 * change at all, the word itself refuses with the gate's.
 */
export function MachinePicker({ options, locked, onChoose, onRefuse, onLocked, onPoint, handle }: MachinePickerProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = options.find(option => option.current) ?? null;

  function show() {
    if (locked !== null) { onLocked(); return; }
    setCursor(Math.max(0, current ? options.indexOf(current) : 0));
    setOpen(true);
  }
  function close(refocus: boolean) {
    setOpen(false);
    onPoint(null);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  }
  function pick(option: SlotOption) {
    if (!option.available) { onRefuse(option); return; }
    close(true);
    if (!option.current) onChoose(option);
  }
  useLayoutEffect(() => {
    handle.current = { open: () => { trigger.current?.focus({ preventScroll: true }); show(); } };
  });
  useLayoutEffect(() => { if (open) list.current?.focus({ preventScroll: true }); }, [open]);
  useEffect(() => {
    if (!open) return;
    const document = box.current?.ownerDocument;
    const outside = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) close(false); };
    document?.addEventListener("pointerdown", outside, true);
    return () => document?.removeEventListener("pointerdown", outside, true);
  }, [open]);

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    const move = (to: number) => {
      const next = Math.max(0, Math.min(options.length - 1, to));
      setCursor(next);
      onPoint(options[next] ?? null);
    };
    switch (event.key) {
      case "ArrowUp": move(cursor - 1); break;
      case "ArrowDown": move(cursor + 1); break;
      case "Home": move(0); break;
      case "End": move(options.length - 1); break;
      case "Enter": case " ": if (!event.repeat && options[cursor]) pick(options[cursor]!); break;
      case "Escape": close(true); break;
      case "Tab": close(false); return;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  return <span ref={box} className={`${G}machine`} data-popover={open ? "" : undefined}>
    <span className={`${G}machine-on`} aria-hidden="true">on</span>
    <button ref={trigger} type="button" className={`${G}machine-word`} aria-haspopup="listbox" aria-expanded={open}
      aria-label={`Machine: ${current?.label ?? "none"}`} aria-disabled={locked !== null || undefined} data-machine-picker=""
      title={current?.label}
      onClick={() => { if (open) close(true); else show(); }} onPointerEnter={() => onPoint(current)} onPointerLeave={() => { if (!open) onPoint(null); }}>
      {current?.online != null && <i className={`${G}machine-dot`} data-online={current.online} aria-hidden="true" />}
      <span className={`${G}machine-name`}>{current?.label ?? "no machine"}</span>
    </button>
    {open && <div ref={list} role="listbox" tabIndex={-1} aria-label="machines" aria-activedescendant={`${id}-${cursor}`} className={`${G}machine-list`}
      onKeyDown={keys} onBlur={event => { if (!box.current?.contains(event.relatedTarget as Node | null)) close(false); }}>
      {options.map((option, index) => <div key={option.value} id={`${id}-${index}`} role="option" aria-selected={option.current}
        aria-disabled={!option.available || undefined} className={`${G}machine-option`} data-cursor={index === cursor || undefined}
        data-off={!option.available || undefined} data-machine={option.value}
        onPointerEnter={() => { setCursor(index); onPoint(option); }} onClick={() => pick(option)}>
        <i className={`${G}machine-dot`} data-online={option.online ?? undefined} aria-hidden="true" />
        <span className={`${G}machine-name`}>{option.label}</span>
      </div>)}
    </div>}
  </span>;
}
