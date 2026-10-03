import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { ThinkingLevelSchema } from "@atyrode/manifold-omp";
import { ControlIcon, prefersReducedMotion, Spinner } from "@manifold/ui";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import type { Lane, Selection } from "../../domain/contracts.ts";
import type { Review } from "../../domain/routing.ts";
import { accountWord, Button, capitalized, Check, familyWord, hueOf, middleId, ReadoutLine, SectionBand, SegmentMeter, withKey, type Readout } from "../ui.tsx";
import { routeChanges } from "./consequences.ts";
import { chooseOption, laneWord, MAIN_DIALS, MORE_DIALS, SPECS, type DialId, type MoreDial, type OptionRefusal } from "./dial-space.ts";
import { turnWheel, wheelTravel, wheelTurnsDial, WHEEL_AT_REST } from "./panel-input.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
const THINKING = ThinkingLevelSchema.options;
type Route = Review["routes"][number];
type Estimates = Review["estimates"];

// ---------------------------------------------------------------- model aliases and words

/**
 * Short display names. A curated catalog names its models deliberately (`sol`, `opus`), so those
 * keys are kept. A derived key is `provider.id`; its last meaningful id segment is the name people
 * use (`gpt-5.6-sol` → `sol`, `claude-haiku-4-5` → `haiku`). A collision falls back to the full id,
 * because two rows wearing one name would misreport the route.
 */
export function displayAliases(catalog: CompiledCatalog): ReadonlyMap<string, string> {
  const qualifier = /^(?:\d[\w.]*|v\d[\w.]*|latest|preview|exp|experimental|beta|alpha)$/i;
  const short = new Map<string, string>();
  for (const model of catalog.models) {
    if (!model.key.startsWith(`${model.provider}.`)) { short.set(model.key, model.key); continue; }
    const word = model.id.split(/[-_/:]/).filter(segment => segment && !qualifier.test(segment)).at(-1);
    short.set(model.key, (word ?? model.id).toLowerCase());
  }
  const uses = new Map<string, number>();
  for (const alias of short.values()) uses.set(alias, (uses.get(alias) ?? 0) + 1);
  return new Map([...short].map(([key, alias]) => [key, uses.get(alias)! > 1 ? catalog.model(key).id : alias]));
}

const EFFORT_WORDS: Readonly<Record<string, string>> = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "X-high", max: "Max" };
/** A thinking level as the dials and the routing table both name it. */
function effortWord(level: string): string {
  return EFFORT_WORDS[level] ?? capitalized(level);
}

/** One sentence of consequence: which roles rise, fall or move provider, and how the estimates shift. */
function consequence(catalog: CompiledCatalog, before: Review, after: Review, max: number): string {
  const list = (roles: readonly string[]) => roles.length > max ? `${roles.length} roles` : roles.join(", ");
  const raised: string[] = [], lowered: string[] = [], added: string[] = [], removed: string[] = [], fallbacks: string[] = [];
  const moved = new Map<string, string[]>();
  for (const change of routeChanges(before.routes, after.routes)) {
    if (change.kind === "added") added.push(change.role);
    else if (change.kind === "removed") removed.push(change.role);
    else if (change.kind === "fallback") fallbacks.push(change.role);
    else {
      const from = change.from!.lead, to = change.to!.lead;
      const fromFamily = catalog.family(from.key), toFamily = catalog.family(to.key);
      if (fromFamily !== toFamily) moved.set(toFamily, [...moved.get(toFamily) ?? [], change.role]);
      else {
        const tier = catalog.model(to.key).tier - catalog.model(from.key).tier;
        const effort = THINKING.indexOf(to.thinking) - THINKING.indexOf(from.thinking);
        ((Math.sign(tier) || Math.sign(effort)) > 0 ? raised : lowered).push(change.role);
      }
    }
  }
  const parts: string[] = [];
  if (raised.length) parts.push(`raises ${list(raised)}`);
  if (lowered.length) parts.push(`lowers ${list(lowered)}`);
  for (const [family, roles] of moved) parts.push(`moves ${list(roles)} to ${familyWord(family)}`);
  if (added.length) parts.push(`adds ${list(added)}`);
  if (removed.length) parts.push(`drops ${list(removed)}`);
  if (fallbacks.length && !parts.length) parts.push(after.selection.fallback ? `adds fallback chains to ${fallbacks.length} roles` : `drops fallback chains from ${fallbacks.length} roles`);
  const cost = after.estimates.costScore - before.estimates.costScore;
  const speed = after.estimates.speedScore - before.estimates.speedScore;
  if (cost) parts.push(`cost ${cost > 0 ? "+" : "−"}${Math.abs(cost)}`);
  if (speed) parts.push(`speed ${speed > 0 ? "+" : "−"}${Math.abs(speed)}`);
  return capitalized(parts.length ? parts.join("; ") : "no route changes");
}

// ---------------------------------------------------------------- dial words

const COST_WORDS = ["Lowest", "Lower", "Moderate", "Higher", "Highest"];
const SPEED_WORDS = ["Slowest", "Slower", "Balanced", "Faster", "Fastest"];

const laneLabel = (lane: Lane) => lane.kind === "mixed" ? "Mixed" : lane.blend === "led" ? `${familyWord(lane.family)}-led` : `${familyWord(lane.family)} only`;
function laneDescription(lane: Lane | undefined): string {
  if (!lane || lane.kind === "mixed") return "GPT leads the work; Claude plans and reviews; each backs up the other";
  if (lane.blend === "only") return `Every role stays on ${familyWord(lane.family)}; vision may borrow another provider`;
  return `${familyWord(lane.family)} leads; ${lane.family === "openai" ? "Claude" : "GPT"} reviews independently and backs it up`;
}
const DESCRIPTIONS: Readonly<Partial<Record<DialId, Readonly<Record<string, string>>>>> = {
  model: { fast: "The smallest capable model on each ladder", normal: "Everyday models; planning and review one notch up", smart: "Stronger models; planning and review one notch up", elite: "The strongest model each provider offers" },
  thinking: { minimal: "Least reasoning effort across roles", low: "Light reasoning; planning and review get one step more", medium: "Balanced effort; reviews get more, utility roles less", high: "More effort for hard work; utility roles stay light", xhigh: "Extra-high effort where the model supports it", max: "Maximum effort, capped by each model" },
  advisor: { off: "No advisor model in the session", glance: "A light advisor for a second perspective", review: "A stronger advisor with a lighter fallback", audit: "A deep advisor that also advises delegated tasks" },
  budget: { any: "Every model in the catalog is admitted", free: "Admit only models that cost nothing; refuse rather than pay" },
  priority: { off: "Standard provider service tiers", on: "OpenAI priority tier; costs more, latency not guaranteed" },
  spark: { off: "Small utility work stays on the regular ladder", on: "Tiny and commit run on Spark; Sonic too at Fast" },
  prewalk: { off: "No automatic repository prewalk", on: "OMP walks the repository first, for the session and delegated tasks" },
  plans: { ask: "Plans wait for your approval in the session", auto: "Plans are approved automatically; launch still needs review" },
  fallbacks: { off: "Retries stay on the selected models", on: "Ordered fallback chains take over when a lead model cannot serve" },
};
/** The More options, as switches: the word that means on, the word that means off, and the switch's name. */
const SWITCHES: Readonly<Record<MoreDial, { label: string; short: string; on: string; off: string }>> = {
  budget: { label: "Free models only", short: "Free only", on: "free", off: "any" },
  priority: { label: "Priority tier", short: "Priority", on: "on", off: "off" },
  spark: { label: "Spark for small work", short: "Spark", on: "on", off: "off" },
  prewalk: { label: "Prewalk the repository", short: "Prewalk", on: "on", off: "off" },
  plans: { label: "Approve plans automatically", short: "Auto plans", on: "auto", off: "ask" },
  fallbacks: { label: "Fallback chains", short: "Fallbacks", on: "on", off: "off" },
};
type OptionState = {
  word: string;
  ok: boolean;
  /** Why the option cannot be chosen; null when it can. */
  reason: string | null;
  selection: Selection | null;
  /** The review choosing it would produce, for map mode; null when unavailable or not previewable. */
  review: Review | null;
  /** `Raises plan, slow; cost +1`: the readout text map mode publishes for this option. */
  consequence: string;
};
type DialState = {
  id: DialId; label: string; words: string[]; current: string;
  /** The word as a person reads it (`GPT-led`, `X-high`); the word itself stays the stable key. */
  wordLabel: (word: string) => string;
  /** The provider family a lane option leads with, worn as a 6px square; null for every other option and for Mixed. */
  markOf: (word: string) => string | null;
  description: (word: string) => string; options: ReadonlyMap<string, OptionState>;
};
type DialModel = { base: Review; dials: ReadonlyMap<DialId, DialState> };

/**
 * Every option's would-be review, computed once per selection: availability, map-mode previews
 * and consequence text all read it. Pure domain computation; nothing here has an effect.
 *
 * `families` holds the families with at least one included account when that is known, so a lane
 * that would route to a family nobody can serve says so instead of failing at review. `starter`
 * suppresses budget previews, because a starter catalog is re-derived for a new budget and the
 * current catalog cannot say what that derivation would route.
 */
export function useDialModel(catalog: CompiledCatalog | null, selection: Selection | null, base: Review | null, families: ReadonlySet<string> | null, starter: boolean): DialModel | null {
  return useMemo(() => {
    if (!catalog || !selection || !base) return null;
    const now = Date.now();
    const dials = new Map<DialId, DialState>();
    for (const id of [...MAIN_DIALS, ...MORE_DIALS]) {
      const spec = SPECS[id];
      const words = spec.words(base).flat();
      const current = spec.get(selection);
      const options = new Map<string, OptionState>();
      for (const word of words) {
        if (word === current) { options.set(word, { word, ok: true, reason: null, selection, review: null, consequence: "" }); continue; }
        const choice = chooseOption(catalog, selection, base, id, word, { families, starter, nowMs: now });
        const reason = choice.refusal && refusalText(id, word, selection, choice.refusal);
        options.set(word, {
          word, ok: reason === null && choice.selection !== null, reason, selection: choice.selection, review: choice.review,
          consequence: choice.review ? consequence(catalog, base, choice.review, 8) : "",
        });
      }
      const lanes = base.available.lanes;
      const laneOf = (word: string) => lanes.find(lane => laneWord(lane) === word);
      dials.set(id, {
        id, label: spec.label, words, current, options,
        wordLabel: word => id === "lane" ? (laneOf(word) ? laneLabel(laneOf(word)!) : word) : id === "thinking" ? effortWord(word) : capitalized(word),
        markOf: word => { const lane = id === "lane" ? laneOf(word) : undefined; return lane?.kind === "provider" ? lane.family : null; },
        description: word => id === "lane" ? laneDescription(laneOf(word)) : DESCRIPTIONS[id]?.[word] ?? "",
      });
    }
    return { base, dials };
  }, [catalog, selection, base, families, starter]);
}

/** A refused option's reason, in the words its dial uses. */
function refusalText(id: DialId, word: string, selection: Selection, refusal: OptionRefusal): string {
  if (refusal.kind === "account") return `Needs a ${accountWord(refusal.family)} account`;
  const lead = selection.lane.kind === "mixed" ? "openai" : selection.lane.family;
  return id === "model" ? `No ${word} ${familyWord(lead)} model in the catalog`
    : id === "spark" || id === "priority" ? `${SPECS[id].label} needs a GPT lane`
    : id === "budget" ? "No free route in the catalog" : "Not in the catalog";
}

/** The readout an option publishes: its description when chosen, its refusal when unavailable, else its consequence. */
function optionReadout(dial: DialState, word: string): Readout {
  const state = dial.options.get(word);
  const label = `${dial.label}: ${dial.wordLabel(word)}`;
  if (word === dial.current || !state) return { label, text: dial.description(word) };
  if (!state.ok) return { label, text: state.reason ?? "Unavailable" };
  return { label, text: state.review ? state.consequence : dial.description(word) };
}

// ---------------------------------------------------------------- generator section

export type MapTarget = { dial: DialId; word: string };
type RowId = DialId | "more";

function DialRow({ dial, disabled, onCommit, onRowKey, scrub }: {
  dial: DialState; disabled: boolean;
  onCommit: (dial: DialId, word: string, focus: boolean) => void; onRowKey: (event: KeyboardEvent<HTMLElement>, dial: RowId) => void; scrub: ScrubHandlers;
}) {
  const labelId = `${G}label-${dial.id}`;
  const tabWord = dial.words.includes(dial.current) ? dial.current : dial.words.find(word => dial.options.get(word)?.ok);
  return <div className={`${G}dial`} data-row={dial.id}>
    <span className={`${G}dial-label`} id={labelId}>{dial.label}</span>
    <div className={`${G}options`} role="radiogroup" aria-labelledby={labelId} aria-disabled={disabled || undefined} data-dial-group={dial.id}
      onKeyDown={event => onRowKey(event, dial.id)} onPointerDown={event => scrub.down(event, dial)} onPointerMove={event => scrub.move(event, dial)}
      onPointerUp={scrub.up} onPointerCancel={scrub.up}>
      {dial.words.map(word => {
        const state = dial.options.get(word)!;
        const selected = word === dial.current;
        const readout = optionReadout(dial, word);
        const label = dial.wordLabel(word);
        const mark = dial.markOf(word);
        return <button key={word} type="button" role="radio" className={`${G}option`} aria-checked={selected} aria-disabled={!state.ok || undefined}
          tabIndex={word === tabWord ? 0 : -1} data-dial={dial.id} data-word={word} data-label={label}
          data-readout-label={readout.label ?? undefined} data-readout={readout.text}
          onClick={() => { if (!scrub.moved() && state.ok && !selected && !disabled) onCommit(dial.id, word, true); }}>
          {mark && <span className="plugin-atyrode_code__mark" data-fam={hueOf(mark)} aria-hidden="true" />}
          <span className={`${G}option-label`} data-label={label}>{label}</span>
        </button>;
      })}
    </div>
  </div>;
}

function CheckRow({ dial, disabled, onCommit, onRowKey }: {
  dial: DialState & { id: MoreDial }; disabled: boolean;
  onCommit: (dial: DialId, word: string, focus: boolean) => void; onRowKey: (event: KeyboardEvent<HTMLElement>, dial: RowId) => void;
}) {
  const spec = SWITCHES[dial.id];
  const checked = dial.current === spec.on;
  const target = checked ? spec.off : spec.on;
  const state = dial.options.get(target);
  const refused = !state?.ok;
  const readout = optionReadout(dial, target);
  return <div className={`${G}check-row`} data-row={dial.id}>
    <Check checked={checked} aria-disabled={refused || disabled || undefined}
      data-dial={dial.id} data-word={target} data-readout-label={`${spec.label}: turn ${checked ? "off" : "on"}`} data-readout={readout.text}
      onChange={() => onCommit(dial.id, target, false)} onKeyDown={event => onRowKey(event, dial.id)}>
      <span className={`${G}check-label`}>{spec.label}</span>
      {refused && !checked && <span className={`${G}check-reason`}>{state?.reason ?? "Unavailable"}</span>}
    </Check>
  </div>;
}

type ScrubHandlers = {
  down: (event: PointerEvent<HTMLElement>, dial: DialState) => void;
  move: (event: PointerEvent<HTMLElement>, dial: DialState) => void;
  up: (event: PointerEvent<HTMLElement>) => void;
  /** True while the gesture that ends in this click has scrubbed, so the click must not commit again. */
  moved: () => boolean;
};
/**
 * Pointer gestures on a row's pills. Horizontal drag scrubs to the pill under the pointer. With a
 * mouse or pen, a mostly vertical drag turns the row like a knob: up steps to the next option, down
 * to the previous, one step per 14px. Touch keeps vertical swipes for scrolling the panel.
 */
function useScrub(disabled: boolean, commit: (dial: DialId, word: string) => void): ScrubHandlers {
  const gesture = useRef<{ id: number; x: number; y: number; touch: boolean; intent: "pending" | "horizontal" | "vertical"; steps: number; moved: boolean } | null>(null);
  return {
    down(event) {
      if (disabled || event.button !== 0 || !event.isPrimary || !(event.target as Element).closest("[data-word]")) return;
      gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType === "touch", intent: "pending", steps: 0, moved: false };
    },
    move(event, dial) {
      const current = gesture.current;
      if (!current || current.id !== event.pointerId) return;
      const dx = Math.abs(event.clientX - current.x), dy = Math.abs(event.clientY - current.y);
      const group = event.currentTarget;
      if (current.intent === "pending") {
        const threshold = current.touch ? 8 : 6;
        if (Math.max(dx, dy) < threshold) return;
        if (dx >= dy) current.intent = "horizontal";
        else if (current.touch) { gesture.current = null; return; }
        else { current.intent = "vertical"; group.dataset.knob = ""; }
        group.setPointerCapture(event.pointerId);
      }
      if (current.intent === "vertical") {
        const target = Math.trunc((current.y - event.clientY) / 14);
        const available = dial.words.filter(word => dial.options.get(word)?.ok);
        const from = available.indexOf(dial.current);
        const next = available[Math.max(0, Math.min(available.length - 1, from + target - current.steps))];
        current.steps = target;
        if (!next || next === dial.current) return;
        current.moved = true;
        commit(dial.id, next);
        return;
      }
      const under = group.ownerDocument.elementFromPoint(event.clientX, current.y)?.closest<HTMLElement>(`[data-dial-group="${dial.id}"] [data-word]`);
      const word = under?.dataset.word;
      if (!word || word === dial.current || !dial.options.get(word)?.ok) return;
      current.moved = true;
      commit(dial.id, word);
    },
    up(event) {
      delete event.currentTarget.dataset.knob;
      window.setTimeout(() => { gesture.current = null; }, 0);
    },
    moved: () => gesture.current?.moved === true,
  };
}

/**
 * The wheel turns a dial only while focus is inside that dial and the panel is at rest
 * (panel-input.ts), so scrolling past the dials never edits the team. The listener is native
 * because React's wheel handler is passive and could not keep a turn from also scrolling the page.
 */
function useWheelTurn(zone: RefObject<HTMLElement | null>, disabled: boolean, turn: (dial: DialId, step: 1 | -1) => void) {
  const latest = useRef({ disabled, turn });
  latest.current = { disabled, turn };
  useEffect(() => {
    const element = zone.current;
    if (!element) return;
    const root = element.closest(".plugin-atyrode_code_generator") ?? element;
    let scrolledAt = Number.NEGATIVE_INFINITY, passedAt = Number.NEGATIVE_INFINITY, gathered = WHEEL_AT_REST;
    const scrolled = () => { scrolledAt = performance.now(); };
    const wheel = (event: WheelEvent) => {
      const now = performance.now();
      const group = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-dial-group]") : null;
      const focused = group !== null && group.contains(group.ownerDocument.activeElement);
      if (!group || latest.current.disabled ||
        !wheelTurnsDial({ focused, zoom: event.ctrlKey || event.metaKey, sinceScrollMs: now - scrolledAt, sincePassedMs: now - passedAt })) {
        passedAt = now;
        gathered = WHEEL_AT_REST;
        return;
      }
      event.preventDefault();
      const result = turnWheel(gathered, wheelTravel(event, element.clientHeight), now);
      gathered = result.turn;
      // The group's attribute is written from its dial's id; an unknown value finds no dial and turns nothing.
      if (result.step !== 0) latest.current.turn(group.dataset.dialGroup as DialId, result.step);
    };
    root.addEventListener("scroll", scrolled, { capture: true, passive: true });
    element.addEventListener("wheel", wheel, { passive: false });
    return () => { root.removeEventListener("scroll", scrolled, { capture: true }); element.removeEventListener("wheel", wheel); };
  }, [zone]);
}

/** The nearest option that can be chosen from `from`, one step toward the end (`1`) or the start (`-1`). */
function nextOption(dial: DialState, from: string, step: 1 | -1): string | undefined {
  for (let at = dial.words.indexOf(from) + step; at >= 0 && at < dial.words.length; at += step) {
    if (dial.options.get(dial.words[at]!)?.ok) return dial.words[at];
  }
  return undefined;
}

export function GeneratorZone({ model, disabled, onChange, estimates, previewEstimates, measured, onDefaults, moreOpen, setMoreOpen, notice }: {
  model: DialModel; disabled: boolean; onChange: (selection: Selection) => void;
  estimates: Estimates; previewEstimates: Estimates | null; measured: boolean; onDefaults: () => void;
  moreOpen: boolean; setMoreOpen: (open: boolean) => void; notice?: ReactNode;
}) {
  const [focusedRow, setFocusedRow] = useState<DialId>("lane");
  const zone = useRef<HTMLElement>(null);
  const pendingFocus = useRef<DialId | null>(null);
  const order: RowId[] = [...MAIN_DIALS, "more", ...(moreOpen ? MORE_DIALS : [])];
  function commit(dial: DialId, word: string, focus: boolean) {
    const state = model.dials.get(dial)?.options.get(word);
    if (disabled || !state?.ok || !state.selection) return;
    if (focus) pendingFocus.current = dial;
    onChange(state.selection);
  }
  const scrub = useScrub(disabled, (dial, word) => commit(dial, word, true));
  useWheelTurn(zone, disabled, (id, step) => {
    const dial = model.dials.get(id);
    const target = dial && nextOption(dial, dial.current, step);
    if (target) commit(id, target, true);
  });
  // After a commit the chosen pill is a different element; move focus there so arrows keep working.
  useLayoutEffect(() => {
    const dial = pendingFocus.current;
    if (!dial || !zone.current) return;
    pendingFocus.current = null;
    const element = zone.current.querySelector<HTMLElement>(`[data-row="${dial}"] [role=radio][aria-checked=true]`);
    if (element && element.offsetParent !== null && zone.current.contains(element.ownerDocument.activeElement)) element.focus({ preventScroll: true });
  });
  function focusRow(row: RowId) {
    const element = zone.current?.querySelector(`[data-row="${row}"]`);
    const target = row === "more" ? element?.querySelector<HTMLElement>(`.${G}more-toggle`)
      : element?.querySelector<HTMLElement>("[role=checkbox], [role=radio][tabindex='0']");
    target?.focus();
  }
  function rowKey(event: KeyboardEvent<HTMLElement>, row: RowId) {
    const key = event.key;
    if (key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
      const next = order[order.indexOf(row) + (key === "ArrowUp" ? -1 : 1)];
      if (next) focusRow(next);
      return;
    }
    if (row === "more") return;
    const dial = model.dials.get(row)!;
    const element = event.target as HTMLElement;
    if (element.getAttribute("role") === "checkbox") {
      const spec = SWITCHES[row as MoreDial];
      const target = key === "ArrowLeft" || key === "Home" ? spec.off : key === "ArrowRight" || key === "End" ? spec.on : null;
      if (target === null) return;
      event.preventDefault();
      if (target !== dial.current) commit(row, target, false);
      return;
    }
    const from = element.dataset.word ?? dial.current;
    const available = dial.words.filter(word => dial.options.get(word)?.ok);
    let target: string | undefined;
    if (key === "ArrowLeft" || key === "ArrowRight") target = nextOption(dial, from, key === "ArrowLeft" ? -1 : 1);
    else if (key === "Home") target = available[0];
    else if (key === "End") target = available.at(-1);
    else if (key === " " || key === "Enter") target = element.dataset.word;
    else return;
    event.preventDefault();
    if (target && target !== dial.current) commit(row, target, true);
  }
  const resting = model.dials.get(focusedRow)!;
  const summary = MORE_DIALS.filter(id => model.dials.get(id)!.current === SWITCHES[id].on).map(id => SWITCHES[id].short).join(", ") || "All off";
  return <section ref={zone} className={`${G}section ${G}generator`} data-zone="generator" aria-labelledby={`${G}generator-title`}
    onFocus={event => { const row = (event.target as HTMLElement).closest<HTMLElement>("[data-row]")?.dataset.row; if (row && row !== "more" && row !== focusedRow) setFocusedRow(row as DialId); }}>
    <SectionBand id={`${G}generator-title`} title="Generator" actions={<Button disabled={disabled} title={withKey("Restore the default profile", "d")} onClick={onDefaults}>Defaults</Button>} />
    {notice}
    <div className={`${G}dials`}>
      {MAIN_DIALS.map(id => <DialRow key={id} dial={model.dials.get(id)!} disabled={disabled} onCommit={commit} onRowKey={rowKey} scrub={scrub} />)}
      <div className={`${G}more`} data-row="more" data-open={moreOpen || undefined}>
        <button type="button" className={`${G}more-toggle`} aria-expanded={moreOpen} aria-controls={`${G}more-body`}
          onClick={() => setMoreOpen(!moreOpen)} onKeyDown={event => rowKey(event, "more")}>
          <ControlIcon kind={moreOpen ? "disclosed" : "collapsed"} size={14} />
          <span className={`${G}more-label`}>More options</span>
          <span className={`${G}more-summary`}>{summary}</span>
        </button>
        <div className={`${G}more-body`} id={`${G}more-body`} inert={!moreOpen}>
          <div className={`${G}more-inner`}>
            {MORE_DIALS.map(id => <CheckRow key={id} dial={model.dials.get(id)! as DialState & { id: MoreDial }} disabled={disabled} onCommit={commit} onRowKey={rowKey} />)}
          </div>
        </div>
      </div>
    </div>
    <EstimateStrip estimates={estimates} preview={previewEstimates} measured={measured} />
    <ReadoutLine className={`${G}readout`} fallback={{ label: `${resting.label}: ${resting.wordLabel(resting.current)}`, text: resting.description(resting.current) }} />
  </section>;
}

function EstimateStrip({ estimates, preview, measured }: { estimates: Estimates; preview: Estimates | null; measured: boolean }) {
  const cost = estimates.costScore, speed = estimates.speedScore;
  const costNext = preview && preview.costScore !== cost ? preview.costScore : null;
  const speedNext = measured && preview && preview.speedScore !== speed ? preview.speedScore : null;
  return <div className={`${G}estimates`}>
    <div className={`${G}estimate`} data-readout-label="Cost" data-readout="Relative cost of this profile from catalog prices, weighted by role; not live spend">
      <span className={`${G}estimate-label`}>Cost</span>
      <SegmentMeter value={cost} preview={costNext} warnAtTop />
      <span className={`${G}estimate-word`} data-preview={costNext !== null || undefined}>{COST_WORDS[(costNext ?? cost) - 1]}</span>
      <span className="plugin-atyrode_code__sr">, {cost} of 5</span>
    </div>
    <div className={`${G}estimate`} data-readout-label="Speed" data-readout={measured ? "Relative speed from measured throughput and first-token time, weighted by role"
      : "No model in this profile has a measured throughput yet; benchmark in Models"}>
      <span className={`${G}estimate-label`}>Speed</span>
      <SegmentMeter value={measured ? speed : 0} preview={speedNext} />
      <span className={`${G}estimate-word`} data-preview={speedNext !== null || undefined} data-muted={!measured || undefined}>{measured ? SPEED_WORDS[(speedNext ?? speed) - 1] : "Unmeasured"}</span>
      <span className="plugin-atyrode_code__sr">{measured ? `, ${speed} of 5` : ""}</span>
    </div>
  </div>;
}

/** The generator while the profile is read, or when it cannot be shown: the host spinner, or the notices that explain why. */
export function GeneratorPlaceholder({ loading, notice }: { loading: boolean; notice?: ReactNode }) {
  return <section className={`${G}section ${G}generator`} data-zone="generator" aria-labelledby={`${G}generator-title`} aria-busy={loading || undefined}>
    <SectionBand id={`${G}generator-title`} title="Generator" />
    {loading ? <Spinner label="Reading the profile…" /> : notice}
  </section>;
}

// ---------------------------------------------------------------- routing table

export type LedgerView = { fallbacks: boolean; ids: boolean; pinned: ReadonlySet<string> };

/** The row an absent advisor would occupy, so turning it on visibly adds a line instead of shifting every row. */
function ledgerRoles(routes: readonly Route[]): string[] {
  const roles = routes.map(route => route.role);
  if (!roles.includes("advisor")) roles.splice(roles.includes("sonic") ? roles.indexOf("sonic") + 1 : roles.length, 0, "advisor");
  return roles;
}

/**
 * Every role on one 24px line: role, model, effort. Exact ids and fallback chains are extra lines
 * the reader asks for (IDs, Fallbacks, or pinning a row); a hovered dial option swaps a row's model
 * and effort in place, so the table never moves under the pointer.
 */
function Ledger({ review, catalog, aliases, preview, view, onPin }: {
  review: Review; catalog: CompiledCatalog; aliases: ReadonlyMap<string, string>; preview: Review | null; view: LedgerView;
  onPin: (role: string) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const previous = useRef<Review["routes"] | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [rooms, setRooms] = useState<ReadonlyMap<string, number>>(new Map());
  const [recent, setRecent] = useState<ReadonlySet<string>>(new Set());
  const routes = useMemo(() => new Map(review.routes.map(route => [route.role, route])), [review]);
  const roles = useMemo(() => ledgerRoles(review.routes), [review]);
  const previewed = useMemo(() => {
    if (!preview) return new Map<string, Route | null>();
    return new Map(routeChanges(review.routes, preview.routes).filter(change => change.kind !== "fallback").map(change => [change.role, change.to ?? null]));
  }, [review, preview]);
  // Afterglow: a route a dial just changed glows once, then fades. Pure presentation over the diff.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = review.routes;
    if (!before) return;
    const changed = routeChanges(before, review.routes).filter(change => change.kind !== "fallback" || view.fallbacks).map(change => change.role);
    if (!changed.length) return;
    // Reduced motion gets the same glow as a still mark that simply ends (`data-changed`), never a fade.
    if (!prefersReducedMotion()) for (const role of changed) {
      rows.current.get(role)?.animate([{ backgroundColor: "rgb(76 110 245 / 22%)" }, { backgroundColor: "rgb(76 110 245 / 0%)" }], { duration: 600, easing: "ease" });
    }
    setRecent(new Set(changed));
    const timer = window.setTimeout(() => setRecent(new Set()), 1500);
    return () => window.clearTimeout(timer);
  }, [review]);
  // Exact ids are middle-truncated to their line, which only the rendered width knows.
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const probe = element.ownerDocument.createElement("span");
    probe.className = `${G}model-id ${G}probe`;
    probe.textContent = "0".repeat(20);
    element.appendChild(probe);
    const ch = probe.getBoundingClientRect().width / 20 || 6;
    probe.remove();
    const measure = () => {
      const next = new Map<string, number>();
      for (const slot of element.querySelectorAll<HTMLElement>("[data-id-slot]")) next.set(slot.dataset.idSlot!, Math.max(0, Math.floor((slot.clientWidth - 2) / ch)));
      setRooms(current => current.size === next.size && [...next].every(([role, room]) => current.get(role) === room) ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [review]);
  const tabRole = tab && roles.includes(tab) ? tab : roles[0];
  const alias = (key: string) => aliases.get(key) ?? key;
  function keys(event: KeyboardEvent<HTMLOListElement>) {
    const element = event.target as HTMLElement;
    const role = element.dataset.role;
    if (!role) return;
    const all = [...list.current?.querySelectorAll<HTMLElement>("[data-role]") ?? []];
    const index = all.indexOf(element);
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? all.length - 1 : null;
    if (next !== null) {
      event.preventDefault();
      const target = all[Math.max(0, Math.min(all.length - 1, next))];
      if (target) { setTab(target.dataset.role!); target.focus(); }
      return;
    }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPin(role); }
  }
  return <ol ref={list} className={`${G}ledger`} aria-label="Roles and models" onKeyDown={keys}
    data-fallbacks={view.fallbacks || undefined} data-ids={view.ids || undefined} data-previewing={previewed.size > 0 || undefined}>
    {roles.map(role => {
      const route = routes.get(role);
      const pv = previewed.get(role);
      const lead = pv === undefined ? route?.lead : pv?.lead;
      const model = route ? catalog.model(route.lead.key) : null;
      const id = model ? `${model.provider}/${model.id}` : null;
      return <li key={role} ref={element => { if (element) rows.current.set(role, element); else rows.current.delete(role); }}
        className={`${G}lrow`} data-role={role} tabIndex={role === tabRole ? 0 : -1} data-off={!route || undefined} data-pinned={view.pinned.has(role) || undefined}
        data-pv={pv !== undefined || undefined} data-changed={recent.has(role) || undefined} onClick={() => { setTab(role); onPin(role); }}>
        <span className={`${G}role`} title={role}>
          <span className={`${G}role-name`}>{role}</span>
          {route?.agentBacked && <span className={`${G}agent`} title="Runs as a delegated agent">agent</span>}
        </span>
        <span className={`${G}model`}>
          {lead && <span className="plugin-atyrode_code__mark" data-fam={hueOf(catalog.family(lead.key))} aria-hidden="true" />}
          <span className={`${G}alias`} data-model={lead?.key ?? ""} title={lead ? alias(lead.key) : undefined}>{lead ? alias(lead.key) : "Off"}</span>
        </span>
        <span className={`${G}effort`} data-thinking={lead?.thinking}>{lead ? effortWord(lead.thinking) : ""}</span>
        {id && <span className={`${G}model-id`} data-id-slot={role} title={id}>{middleId(id, rooms.get(role) ?? 0)}</span>}
        {route && <span className={`${G}fallback`}>{route.fallback.length ? <>then {route.fallback.map((choice, index) => <Fragment key={index}>
          {index > 0 && " → "}<span className={`${G}fallback-step`}>{alias(choice.key)} {effortWord(choice.thinking).toLowerCase()}</span>
        </Fragment>)}</> : review.selection.fallback ? "No fallback for this role" : "Fallbacks off"}</span>}
      </li>;
    })}
  </ol>;
}

/** The routing section: its band with the Fallbacks and IDs checkboxes, a status line, and the table. */
export function RoutingZone({ review, catalog, aliases, preview, view, onToggle, onPin, empty, line }: {
  review: Review | null; catalog: CompiledCatalog | null; aliases: ReadonlyMap<string, string>; preview: Review | null; view: LedgerView;
  onToggle: (toggle: "fallbacks" | "ids") => void; onPin: (role: string) => void;
  /** Why there is no table: still reading, or the generator already explains a failure, or the choices route nothing. */
  empty: "loading" | "failed" | "incomplete";
  /** A status line under the band (model verification progress or result). */
  line?: ReactNode;
}) {
  const ready = review && catalog;
  return <section className={`${G}section ${G}routing`} data-zone="routing" aria-labelledby={`${G}routing-title`}>
    <SectionBand id={`${G}routing-title`} title="Routing" count={ready ? `${review.routes.length} roles` : undefined} actions={ready && <>
      <Check checked={view.fallbacks} title={withKey("Show each role's ordered fallback chain", "f")} onChange={() => onToggle("fallbacks")}>Fallbacks</Check>
      <Check checked={view.ids} title={withKey("Show exact provider model ids", "i")} onChange={() => onToggle("ids")}>IDs</Check>
    </>} />
    {line}
    {ready ? <Ledger review={review} catalog={catalog} aliases={aliases} preview={preview} view={view} onPin={onPin} />
      : empty === "loading" ? <p className={`${G}empty`}>Routes appear once the profile is read.</p>
      : empty === "incomplete" ? <p className={`${G}empty`}>No complete profile for these choices; review them in Models.</p> : null}
  </section>;
}

/** A self-contained routing table for surfaces that review a catalog outside the main view (Models). */
export function Routing({ value, catalog }: { value: Review; catalog: CompiledCatalog }) {
  const aliases = useMemo(() => displayAliases(catalog), [catalog]);
  const [view, setView] = useState<LedgerView>({ fallbacks: false, ids: false, pinned: new Set() });
  return <div className={`${G}routing-review`} data-zone="routing">
    <SectionBand title="Routing" count={`${value.routes.length} roles`} actions={<>
      <Check checked={view.fallbacks} onChange={fallbacks => setView({ ...view, fallbacks })}>Fallbacks</Check>
      <Check checked={view.ids} onChange={ids => setView({ ...view, ids })}>IDs</Check>
    </>} />
    <Ledger review={value} catalog={catalog} aliases={aliases} preview={null} view={view}
      onPin={role => { const pinned = new Set(view.pinned); if (!pinned.delete(role)) pinned.add(role); setView({ ...view, pinned }); }} />
    <p className={`${G}empty`}>{value.routes.some(route => route.fallback.length) ? "Fallbacks are tried in order; thinking adapts to each model." : value.selection.fallback ? "No alternate models in these fallback chains." : "Fallbacks off; retries stay on the lead model."}</p>
  </div>;
}
