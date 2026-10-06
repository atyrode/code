import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css, "the bar"). */
const G = "plugin-atyrode_code_generator__";

/** One command in the More menu. */
export type MenuCommand = {
  /** Its stable name, `data-menu-item`. */
  readonly id: string;
  readonly label: string;
  /** What it says beside its label ("staged", "2 skills"); the More button says it too, so it stays in view. */
  readonly aside: string | null;
  /** The panel key that does the same in the shown view; null where none does. */
  readonly accelerator: string | null;
  readonly title: string;
  /** It opens a dialog, not a sheet. */
  readonly dialog?: boolean;
  /** A staged model list waits behind it. */
  readonly staged?: boolean;
  readonly onSelect: () => void;
};

/**
 * The bar's one menu: a button, More, that opens a short menu of the panel's sheets and the
 * shortcuts, the WAI-ARIA menu button. A press, ↓, ↵ or Space opens it on its first item, ↑ on its
 * last; ↑↓, Home and End move, ↵ or Space chooses, and an item's own key chooses it too. Esc closes
 * it and returns focus to More; Tab, a press outside or focus leaving closes it. While it is open
 * it owns its keys (`data-popover`), so the panel's keys leave them alone. Choosing returns focus to
 * More before the command runs, so a sheet or dialog it opens gives focus back there. Every item's
 * aside is said on More as well, so what the menu holds stays in view while it is closed.
 */
export function MoreMenu({ commands }: { readonly commands: readonly MenuCommand[] }) {
  const id = useId();
  const [open, setOpen] = useState<"first" | "last" | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = () => [...menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []];
  const asides = commands.flatMap(command => command.aside === null ? [] : [command.aside]);
  const staged = commands.some(command => command.staged);

  function close(refocus: boolean) {
    setOpen(null);
    if (refocus) button.current?.focus({ preventScroll: true });
  }
  function choose(command: MenuCommand) {
    close(true);
    command.onSelect();
  }
  useLayoutEffect(() => {
    if (!open) return;
    const all = items();
    (open === "first" ? all[0] : all.at(-1))?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const document = box.current?.ownerDocument;
    const outside = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) close(false); };
    document?.addEventListener("pointerdown", outside, true);
    return () => document?.removeEventListener("pointerdown", outside, true);
  }, [open]);

  function buttonKeys(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    setOpen(event.key === "ArrowDown" ? "first" : "last");
    event.preventDefault();
    event.stopPropagation();
  }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    const all = items();
    const at = all.indexOf(event.target as HTMLButtonElement);
    const focus = (index: number) => all[(index + all.length) % all.length]?.focus({ preventScroll: true });
    const accelerated = commands.find(command => command.accelerator !== null && command.accelerator === event.key);
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case "ArrowDown": focus(at + 1); break;
      case "ArrowUp": focus(at - 1); break;
      case "Home": focus(0); break;
      case "End": focus(all.length - 1); break;
      case "Escape": close(true); break;
      case "Tab": close(false); return;
      default:
        if (!accelerated || event.repeat) return;
        choose(accelerated);
    }
    event.preventDefault();
    event.stopPropagation();
  }

  return <span ref={box} className={`${G}more`} data-popover={open ? "" : undefined}>
    <button ref={button} id={`${id}-button`} type="button" className={`plugin-atyrode_code__button ${G}more-button`} aria-haspopup="menu"
      aria-expanded={open !== null} aria-controls={open ? `${id}-menu` : undefined} data-more="" data-staged={staged || undefined}
      onClick={() => { if (open) close(true); else setOpen("first"); }} onKeyDown={buttonKeys}>
      More
      {asides.map(aside => <span key={aside} className={`${G}more-aside`}>· {aside}</span>)}
      <svg className={`${G}more-chevron`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4.5 6.25 8 9.75l3.5-3.5" />
      </svg>
    </button>
    {open && <div ref={menu} id={`${id}-menu`} role="menu" aria-labelledby={`${id}-button`} className={`${G}menu`} data-more-menu=""
      onKeyDown={menuKeys} onBlur={event => { if (!box.current?.contains(event.relatedTarget as Node | null)) close(false); }}>
      {commands.map(command => <button key={command.id} type="button" role="menuitem" tabIndex={-1} className={`${G}menu-item`} data-menu-item={command.id}
        data-staged={command.staged || undefined} aria-keyshortcuts={command.accelerator ?? undefined} aria-haspopup={command.dialog ? "dialog" : undefined}
        title={command.title} onClick={() => choose(command)}
        onPointerMove={event => { if (event.currentTarget.ownerDocument.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true }); }}>
        <span className={`${G}menu-label`}>{command.label}{command.aside !== null && <span className={`${G}more-aside`}>· {command.aside}</span>}</span>
        {command.accelerator !== null && <kbd className={`${G}menu-key`} aria-hidden="true">{command.accelerator}</kbd>}
      </button>)}
    </div>}
  </span>;
}
