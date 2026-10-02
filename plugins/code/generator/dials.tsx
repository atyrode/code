import { Fragment, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ThinkingLevelSchema } from "@atyrode/manifold-omp";
import { prefersReducedMotion } from "@manifold/ui";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import type { Lane, Selection } from "../../domain/contracts.ts";
import type { Review } from "../../domain/routing.ts";
import { accountWord, cx, familyWord, GlyphMeter, Hint, hueOf, middleId, Notice, useReadout, ZoneHead } from "../ui.tsx";
import { previewSelection } from "./workbench-model.ts";

/** Generator-panel class prefix; every part hangs from the generator root (styles.css). */
const G = "plugin-atyrode_code_generator__";
const THINKING = ThinkingLevelSchema.options;
type Thinking = (typeof THINKING)[number];
type Route = Review["routes"][number];
export type Estimates = Review["estimates"];

// ---------------------------------------------------------------- model aliases

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

// ---------------------------------------------------------------- route changes and consequences

export type RouteChange = { role: string; kind: "added" | "removed" | "changed" | "fallback"; from: Route | undefined; to: Route | undefined };
/** What would differ between two reviews, role by role, in display order. */
export function routeChanges(before: readonly Route[], after: readonly Route[]): RouteChange[] {
  const previous = new Map(before.map(route => [route.role, route]));
  const next = new Map(after.map(route => [route.role, route]));
  const roles = [...before.map(route => route.role), ...after.filter(route => !previous.has(route.role)).map(route => route.role)];
  const changes: RouteChange[] = [];
  for (const role of roles) {
    const from = previous.get(role), to = next.get(role);
    const kind = !from ? "added" : !to ? "removed"
      : from.lead.key !== to.lead.key || from.lead.thinking !== to.lead.thinking ? "changed"
      : JSON.stringify(from.fallback) !== JSON.stringify(to.fallback) ? "fallback" : null;
    if (kind) changes.push({ role, kind, from, to });
  }
  return changes;
}

/** One line of consequence: which roles rise, fall or move provider, and how the estimates shift. */
function consequence(catalog: CompiledCatalog, before: Review, after: Review, max: number): string {
  const list = (roles: readonly string[]) => roles.length > max ? `${roles.length} roles` : roles.join(" ");
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
  if (max < 4 && moved.size) parts.push(`moves ${[...moved].map(([family, roles]) => `${roles.length} to ${familyWord(family)}`).join(", ")}`);
  else for (const [family, roles] of moved) parts.push(`moves ${list(roles)} to ${familyWord(family)}`);
  if (added.length) parts.push(`adds ${list(added)}`);
  if (removed.length) parts.push(`drops ${list(removed)}`);
  if (fallbacks.length && !parts.length) parts.push(after.selection.fallback ? `adds fallback chains to ${fallbacks.length} roles` : `drops fallback chains from ${fallbacks.length} roles`);
  const cost = after.estimates.costScore - before.estimates.costScore;
  const speed = after.estimates.speedScore - before.estimates.speedScore;
  if (cost) parts.push(`cost ${cost > 0 ? "+" : "−"}${Math.abs(cost)}`);
  if (speed) parts.push(`speed ${speed > 0 ? "+" : "−"}${Math.abs(speed)}`);
  return parts.length ? parts.join(" · ") : "no route changes";
}

// ---------------------------------------------------------------- dial definitions

export type DialId = "lane" | "model" | "thinking" | "advisor" | "budget" | "priority" | "spark" | "prewalk" | "plans" | "fallbacks";
export const MAIN_DIALS: readonly DialId[] = ["lane", "model", "thinking", "advisor"];
export const MORE_DIALS: readonly DialId[] = ["budget", "priority", "spark", "prewalk", "plans", "fallbacks"];
const CAPABILITY_WORDS = ["fast", "normal", "smart", "elite"] as const;
const COST_WORDS = ["lowest", "lower", "moderate", "higher", "highest"];
const SPEED_WORDS = ["slowest", "slower", "balanced", "faster", "fastest"];

const laneWord = (lane: Lane) => lane.kind === "mixed" ? "mixed" : `${familyWord(lane.family)}-${lane.blend}`;
/** A spectrum: the two providers `mixed` blends on either side of it, then every other provider. */
function laneGroups(lanes: readonly Lane[]): Lane[][] {
  const find = (family: string, blend: "only" | "led") => lanes.find(lane => lane.kind === "provider" && lane.family === family && lane.blend === blend);
  const mixed = lanes.find(lane => lane.kind === "mixed");
  const spectrum = mixed ? [find("openai", "only"), find("openai", "led"), mixed, find("anthropic", "led"), find("anthropic", "only")].filter((lane): lane is Lane => lane !== undefined) : [];
  const used = new Set(spectrum);
  const groups = spectrum.length ? [spectrum] : [];
  for (const family of new Set(lanes.flatMap(lane => lane.kind === "provider" ? [lane.family] : []))) {
    const group = [find(family, "led"), find(family, "only")].filter((lane): lane is Lane => lane !== undefined && !used.has(lane));
    if (group.length) groups.push(group);
  }
  return groups;
}
function laneDescription(lane: Lane | undefined): string {
  if (!lane || lane.kind === "mixed") return "gpt leads the work; claude plans and reviews; each backs up the other";
  if (lane.blend === "only") return `every role stays on ${familyWord(lane.family)}; vision may borrow another provider`;
  return `${familyWord(lane.family)} leads; ${lane.family === "openai" ? "claude" : "gpt"} reviews independently and backs it up`;
}
const DESCRIPTIONS: Readonly<Partial<Record<DialId, Readonly<Record<string, string>>>>> = {
  model: { fast: "the smallest capable model on each ladder", normal: "everyday models; planning and review one notch up", smart: "stronger models; planning and review one notch up", elite: "the strongest model each provider offers" },
  thinking: { minimal: "least reasoning effort across roles", low: "light reasoning; planning and review get one step more", medium: "balanced effort; reviews get more, utility roles less", high: "more effort for hard work; utility roles stay light", xhigh: "extra-high effort where the model supports it", max: "maximum effort, capped by each model" },
  advisor: { off: "no advisor model in the session", glance: "a light advisor for a second perspective", review: "a stronger advisor with a lighter fallback", audit: "a deep advisor that also advises delegated tasks" },
  budget: { any: "admit every model in the catalog", free: "admit only models that cost nothing; refuse rather than pay" },
  priority: { off: "standard provider service tiers", on: "openai priority tier; costs more, latency not guaranteed" },
  spark: { off: "small utility work stays on the regular ladder", on: "tiny and commit run on spark; sonic too at fast" },
  prewalk: { off: "no automatic repository prewalk", on: "omp walks the repository first, for the session and delegated tasks" },
  plans: { ask: "plans wait for your approval in the session", auto: "plans are approved automatically; launch still needs review" },
  fallbacks: { off: "retries stay on the selected models", on: "ordered fallback chains take over when a lead model cannot serve" },
};

/** A lane change keeps what the new lane can serve and steps the rest down, as choosing it by hand would. */
function withLane(catalog: CompiledCatalog, selection: Selection, lane: Lane): Selection {
  const probe = previewSelection(catalog, { ...selection, lane, capability: 1, spark: false, priority: false, budget: "any" });
  if (!probe) return { ...selection, lane };
  const { capabilities, spark, priority, budgets } = probe.available;
  return {
    ...selection, lane,
    capability: capabilities.includes(selection.capability) ? selection.capability : capabilities.at(-1)!,
    spark: selection.spark && spark, priority: selection.priority && priority,
    budget: budgets.includes(selection.budget) ? selection.budget : "any",
  };
}

type Spec = { label: string; words: (review: Review) => string[][]; get: (selection: Selection) => string; set: (catalog: CompiledCatalog, selection: Selection, word: string, review: Review) => Selection | null };
const binary = (label: string, key: "priority" | "spark" | "prewalk" | "fallback"): Spec => ({
  label, words: () => [["off", "on"]], get: selection => selection[key] ? "on" : "off", set: (_, selection, word) => ({ ...selection, [key]: word === "on" }),
});
const SPECS: Readonly<Record<DialId, Spec>> = {
  lane: {
    label: "lane", words: review => laneGroups(review.available.lanes).map(group => group.map(laneWord)), get: selection => laneWord(selection.lane),
    set: (catalog, selection, word, review) => { const lane = review.available.lanes.find(candidate => laneWord(candidate) === word); return lane ? withLane(catalog, selection, lane) : null; },
  },
  model: {
    label: "model", words: () => [[...CAPABILITY_WORDS]], get: selection => CAPABILITY_WORDS[selection.capability - 1]!,
    set: (_, selection, word) => { const index = CAPABILITY_WORDS.indexOf(word as typeof CAPABILITY_WORDS[number]); return index < 0 ? null : { ...selection, capability: (index + 1) as Selection["capability"] }; },
  },
  thinking: { label: "thinking", words: () => [[...THINKING]], get: selection => selection.thinking, set: (_, selection, word) => THINKING.includes(word as Thinking) ? { ...selection, thinking: word as Thinking } : null },
  advisor: {
    label: "advisor", words: () => [["off", "glance", "review", "audit"]], get: selection => selection.advisor,
    set: (_, selection, word) => word === "off" || word === "glance" || word === "review" || word === "audit" ? { ...selection, advisor: word } : null,
  },
  budget: { label: "budget", words: () => [["any", "free"]], get: selection => selection.budget, set: (_, selection, word) => word === "any" || word === "free" ? { ...selection, budget: word } : null },
  priority: binary("priority", "priority"),
  spark: binary("spark", "spark"),
  prewalk: binary("prewalk", "prewalk"),
  plans: { label: "plans", words: () => [["ask", "auto"]], get: selection => selection.planYolo ? "auto" : "ask", set: (_, selection, word) => ({ ...selection, planYolo: word === "auto" }) },
  fallbacks: binary("fallbacks", "fallback"),
};

export type OptionState = {
  word: string;
  ok: boolean;
  /** Why the option cannot be chosen; null when it can. */
  reason: string | null;
  selection: Selection | null;
  /** The review choosing it would produce, for map mode; null when unavailable or not previewable. */
  review: Review | null;
  /** `raises plan slow · cost +1`: the readout text map mode publishes for this option. */
  consequence: string;
};
export type DialState = { id: DialId; label: string; groups: string[][]; words: string[]; current: string; description: (word: string) => string; options: ReadonlyMap<string, OptionState> };
export type DialModel = { base: Review; dials: ReadonlyMap<DialId, DialState> };

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
      const groups = spec.words(base);
      const words = groups.flat();
      const current = spec.get(selection);
      const options = new Map<string, OptionState>();
      for (const word of words) {
        if (word === current) { options.set(word, { word, ok: true, reason: null, selection, review: null, consequence: "" }); continue; }
        let candidate = spec.set(catalog, selection, word, base);
        let review = candidate && previewSelection(catalog, candidate, now);
        // A free budget a new lane cannot serve steps back to any, rather than refusing the lane.
        if (!review && candidate && id === "lane" && candidate.budget === "free") {
          candidate = { ...candidate, budget: "any" };
          review = previewSelection(catalog, candidate, now);
        }
        let reason: string | null = null;
        if (id === "budget" && word === "free" && starter) reason = base.available.budgets.includes("free") ? null : "no free route in the catalog";
        else if (!review) {
          const lead = selection.lane.kind === "mixed" ? "openai" : selection.lane.family;
          reason = id === "model" ? `no ${word} ${familyWord(lead)} model in the catalog`
            : id === "spark" || id === "priority" ? `${id} needs a gpt lane`
            : id === "budget" ? "no free route in the catalog" : "not in the catalog";
        } else if (id === "lane" && families) {
          const missing = missingFamily(catalog, review, families);
          if (missing) reason = `needs a ${accountWord(missing)} account`;
        }
        const previewable = review && !(id === "budget" && starter);
        options.set(word, {
          word, ok: reason === null && candidate !== null, reason, selection: candidate, review: reason === null && previewable ? review : null,
          consequence: reason === null && previewable ? consequence(catalog, base, review!, 8) : "",
        });
      }
      const lanes = base.available.lanes;
      dials.set(id, {
        id, label: spec.label, groups, words, current, options,
        description: word => id === "lane" ? laneDescription(lanes.find(lane => laneWord(lane) === word)) : DESCRIPTIONS[id]?.[word] ?? "",
      });
    }
    return { base, dials };
  }, [catalog, selection, base, families, starter]);
}

/** The readout an option publishes: its description when chosen, its refusal when unavailable, else its consequence. */
function optionReadout(dial: DialState, word: string): { text: string; prose: boolean } {
  const state = dial.options.get(word);
  if (word === dial.current || !state) return { text: dial.description(word), prose: true };
  if (!state.ok) return { text: state.reason ?? "unavailable", prose: false };
  return state.review ? { text: state.consequence, prose: false } : { text: dial.description(word), prose: true };
}

/**
 * The first family this review would route to (lead or fallback) with no included account, mirroring
 * the session door, which refuses a composition whose any routed provider lacks pool accounts.
 */
export function missingFamily(catalog: CompiledCatalog, review: Review, families: ReadonlySet<string>): string | undefined {
  return [...new Set(review.routes.flatMap(route => [route.lead, ...route.fallback]).map(choice => catalog.family(choice.key)))].find(family => !families.has(family));
}

export function moreSummary(selection: Selection): string {
  const parts = [selection.budget === "free" ? "free only" : null, selection.priority ? "priority" : null, selection.spark ? "spark" : null,
    selection.prewalk ? "prewalk" : null, selection.planYolo ? "auto plans" : null, selection.fallback ? "fallbacks" : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : "all off";
}

// ---------------------------------------------------------------- generator zone

export type MapTarget = { dial: DialId; word: string };

function DialRow({ dial, tabbable, disabled, open, onCommit, onRowKey, onExpand, scrub }: {
  dial: DialState; tabbable: boolean; disabled: boolean; open: boolean;
  onCommit: (dial: DialId, word: string, focus: "opt" | "val" | null) => void; onRowKey: (event: KeyboardEvent<HTMLElement>, dial: DialId) => void;
  onExpand: (dial: DialId) => void; scrub: ScrubHandlers;
}) {
  const labelId = `${G}label-${dial.id}`;
  const index = dial.words.indexOf(dial.current);
  const tabWord = index >= 0 ? dial.current : dial.words.find(word => dial.options.get(word)?.ok);
  const cycle = (direction: 1 | -1) => {
    let at = Math.max(0, index);
    for (let step = 0; step < dial.words.length; step++) {
      at = (at + direction + dial.words.length) % dial.words.length;
      const word = dial.words[at]!;
      if (dial.options.get(word)?.ok) { onCommit(dial.id, word, "val"); return; }
    }
  };
  const current = optionReadout(dial, dial.current);
  return <div className={`${G}dial`} data-row={dial.id} data-open={open || undefined}>
    <span className={`${G}caret`} aria-hidden="true">▸</span>
    <span className={`${G}label`} id={labelId}>{dial.label}</span>
    <div className={`${G}cyc`}>
      <button type="button" className={`${G}step`} tabIndex={-1} aria-label={`previous ${dial.label}`} aria-disabled={disabled || undefined} onClick={() => { if (!disabled) cycle(-1); }}>‹</button>
      <button type="button" className={`${G}val`} tabIndex={tabbable ? 0 : -1} aria-expanded={open} aria-describedby={labelId} data-dial={dial.id} data-word={dial.current}
        data-readout-label={`${dial.label} ${dial.current}`} data-readout={current.text} data-readout-prose={current.prose ? "" : undefined}
        onClick={() => onExpand(dial.id)} onKeyDown={event => onRowKey(event, dial.id)}>{dial.current}</button>
      <button type="button" className={`${G}step`} tabIndex={-1} aria-label={`next ${dial.label}`} aria-disabled={disabled || undefined} onClick={() => { if (!disabled) cycle(1); }}>›</button>
      <span className={`${G}pos`} aria-hidden="true">{index + 1}/{dial.words.length}</span>
    </div>
    <div className={`${G}opts`} role="radiogroup" aria-labelledby={labelId} aria-disabled={disabled || undefined} data-dial-group={dial.id}
      onKeyDown={event => onRowKey(event, dial.id)} onPointerDown={event => scrub.down(event, dial)} onPointerMove={event => scrub.move(event, dial)}
      onPointerUp={scrub.up} onPointerCancel={scrub.up}>
      {dial.groups.map((group, groupIndex) => <span key={groupIndex} className={`${G}grp`}>{group.map(word => {
        const state = dial.options.get(word)!;
        const selected = word === dial.current;
        const readout = optionReadout(dial, word);
        return <button key={word} type="button" role="radio" className={`${G}opt`} aria-checked={selected} aria-disabled={!state.ok || undefined}
          data-na={!state.ok || undefined} tabIndex={tabbable && word === tabWord ? 0 : -1} data-dial={dial.id} data-word={word}
          data-readout-label={`${dial.label} ${word}`} data-readout={readout.text} data-readout-prose={readout.prose ? "" : undefined}
          title={state.ok ? undefined : state.reason ?? undefined}
          onClick={() => { if (!scrub.moved() && state.ok && !selected && !disabled) onCommit(dial.id, word, "opt"); }}>{word}</button>;
      })}</span>)}
    </div>
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
 * Pointer gestures on a row's words. Horizontal drag scrubs to the word under the pointer. With a
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

export function GeneratorZone({ model, selection, disabled, onChange, estimates, previewEstimates, measured, meta, onDefaults, moreOpen, setMoreOpen, notice }: {
  model: DialModel; selection: Selection; disabled: boolean; onChange: (selection: Selection) => void;
  estimates: Estimates; previewEstimates: Estimates | null; measured: boolean; meta: ReactNode; onDefaults: () => void;
  moreOpen: boolean; setMoreOpen: (open: boolean) => void; notice?: ReactNode;
}) {
  const [rowTab, setRowTab] = useState<DialId | "more">("lane");
  const [expanded, setExpanded] = useState<DialId | null>(null);
  const zone = useRef<HTMLElement>(null);
  const pendingFocus = useRef<{ dial: DialId; target: "opt" | "val" } | null>(null);
  const order: (DialId | "more")[] = [...MAIN_DIALS, "more", ...(moreOpen ? MORE_DIALS : [])];
  function commit(dial: DialId, word: string, focus: "opt" | "val" | null) {
    const state = model.dials.get(dial)?.options.get(word);
    if (disabled || !state?.ok || !state.selection) return;
    setRowTab(dial);
    if (focus) pendingFocus.current = { dial, target: focus };
    onChange(state.selection);
  }
  const scrub = useScrub(disabled, (dial, word) => commit(dial, word, "opt"));
  // After a commit the chosen word is a different element; move focus there so arrows keep working.
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target || !zone.current) return;
    pendingFocus.current = null;
    const row = zone.current.querySelector(`[data-row="${target.dial}"]`);
    const element = target.target === "val" ? row?.querySelector<HTMLElement>(`.${G}val`) : row?.querySelector<HTMLElement>("[role=radio][aria-checked=true]");
    if (element && element.offsetParent !== null) element.focus({ preventScroll: true });
  });
  function focusRow(row: DialId | "more") {
    setRowTab(row);
    const element = zone.current?.querySelector(`[data-row="${row}"]`);
    const target = row === "more" ? element?.querySelector<HTMLElement>(`.${G}morebtn`)
      : [...element?.querySelectorAll<HTMLElement>(`.${G}val, [role=radio][aria-checked=true]`) ?? []].find(candidate => candidate.offsetParent !== null)
        ?? element?.querySelector<HTMLElement>("[role=radio]:not([data-na])");
    target?.focus();
  }
  function rowKey(event: KeyboardEvent<HTMLElement>, row: DialId | "more") {
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
    const onValue = element.classList.contains(`${G}val`);
    const from = onValue ? dial.current : element.dataset.word ?? dial.current;
    const available = dial.words.filter(word => dial.options.get(word)?.ok);
    let target: string | undefined;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const step = key === "ArrowLeft" ? -1 : 1;
      for (let at = dial.words.indexOf(from) + step; at >= 0 && at < dial.words.length; at += step) {
        if (dial.options.get(dial.words[at]!)?.ok) { target = dial.words[at]; break; }
      }
    } else if (key === "Home") target = available[0];
    else if (key === "End") target = available.at(-1);
    else if ((key === " " || key === "Enter") && !onValue) target = element.dataset.word;
    else return;
    event.preventDefault();
    if (target && target !== dial.current) commit(row, target, onValue ? "val" : "opt");
  }
  const meters = <Meters estimates={estimates} preview={previewEstimates} measured={measured} />;
  return <section ref={zone} className={`${G}zone ${G}gen`} data-zone="generator" aria-label="generator"
    onFocus={event => { const row = (event.target as HTMLElement).closest<HTMLElement>("[data-row]")?.dataset.row; if (row && row !== rowTab) setRowTab(row as DialId | "more"); }}>
    <ZoneHead chip="generator" hints={[<Hint key="d" k="d" label="defaults" onClick={onDefaults} readout="restore the default profile" />]}>
      <span className={`${G}meta ${G}meta-gen`}>{meta}</span>
    </ZoneHead>
    {notice}
    <div className={`${G}dials`}>
      {MAIN_DIALS.map(id => <DialRow key={id} dial={model.dials.get(id)!} tabbable={rowTab === id} disabled={disabled} open={expanded === id}
        onCommit={commit} onRowKey={rowKey} onExpand={dial => setExpanded(previous => previous === dial ? null : dial)} scrub={scrub} />)}
      <div className={`${G}fold`} data-open={moreOpen || undefined}>
        <div className={`${G}dial ${G}morerow`} data-row="more">
          <span className={`${G}caret`} aria-hidden="true">▸</span>
          <button type="button" className={`${G}morebtn`} aria-expanded={moreOpen} tabIndex={rowTab === "more" ? 0 : -1}
            data-readout-label="more" data-readout={`budget, priority, spark, prewalk, plans and fallbacks · now ${moreSummary(selection)}`}
            onClick={() => setMoreOpen(!moreOpen)} onKeyDown={event => rowKey(event, "more")}>more <span className={`${G}chev`} aria-hidden="true">›</span></button>
          <span className={`${G}summary`}>{moreSummary(selection)}</span>
        </div>
        <div className={`${G}fold-body`} inert={!moreOpen}>
          <div className={`${G}fold-in`}>
            {MORE_DIALS.map(id => <DialRow key={id} dial={model.dials.get(id)!} tabbable={rowTab === id} disabled={disabled} open={expanded === id}
              onCommit={commit} onRowKey={rowKey} onExpand={dial => setExpanded(previous => previous === dial ? null : dial)} scrub={scrub} />)}
          </div>
        </div>
      </div>
    </div>
    {meters}
    <ZoneReadout fallback={rowTab === "more" ? null : optionReadout(model.dials.get(rowTab)!, model.dials.get(rowTab)!.current)}
      label={rowTab === "more" ? null : `${model.dials.get(rowTab)!.label} ${model.dials.get(rowTab)!.current}`} />
  </section>;
}

/**
 * Below 720px there is no hint bar, so the generator keeps one line of its own for the readout. It is
 * always rendered at a fixed height, so hovering or focusing a word never moves anything; at rest it
 * describes the focused row's current choice.
 */
function ZoneReadout({ fallback, label }: { fallback: { text: string; prose: boolean } | null; label: string | null }) {
  const readout = useReadout();
  const shown = readout ?? (fallback && { label, text: fallback.text, prose: fallback.prose });
  return <div className={`${G}zone-readout`} aria-hidden="true" data-prose={shown?.prose || undefined}>
    {shown && <>{shown.label && <b>{shown.label}</b>}{shown.label && " · "}{shown.text}</>}
  </div>;
}

function Meters({ estimates, preview, measured }: { estimates: Estimates; preview: Estimates | null; measured: boolean }) {
  const cost = estimates.costScore, speed = estimates.speedScore;
  const costPreview = preview && preview.costScore !== cost ? ` → ${COST_WORDS[preview.costScore - 1]}` : "";
  const speedPreview = measured && preview && preview.speedScore !== speed ? ` → ${SPEED_WORDS[preview.speedScore - 1]}` : "";
  return <div className={`${G}meters`}>
    <div className={`${G}meter`} data-readout="Relative cost of this profile from catalog prices, weighted by role. Not live spend." data-readout-prose="">
      <span className={`${G}label`}>cost</span><GlyphMeter glyph="$" value={cost} kind="cost" />
      <span className={`${G}word`}>{COST_WORDS[cost - 1]}<span className={`${G}pvw`}>{costPreview}</span></span>
      <span className="plugin-atyrode_code__sr">cost {cost} of 5</span>
    </div>
    <div className={`${G}meter`} data-readout={measured ? "Relative speed from measured throughput and first-token time, weighted by role." : "Speed is unmeasured: no catalog model in this profile has a measured throughput yet. Benchmark in models."} data-readout-prose="">
      <span className={`${G}label`}>speed</span>{measured ? <GlyphMeter glyph="»" value={speed} kind="speed" /> : <span className={`${G}unmeasured`} aria-hidden="true">—</span>}
      <span className={`${G}word`}>{measured ? SPEED_WORDS[speed - 1] : "unmeasured"}<span className={`${G}pvw`}>{speedPreview}</span></span>
      <span className="plugin-atyrode_code__sr">{measured ? `speed ${speed} of 5` : "speed unmeasured"}</span>
    </div>
  </div>;
}

/** Ghost rows while the profile is read or cannot be shown. Bars, not shimmer: nothing pretends to be loading faster. */
export function GeneratorPlaceholder({ status, meta, notice }: { status: ReactNode; meta?: ReactNode; notice?: ReactNode }) {
  const widths: Record<string, number> = { lane: 52, model: 24, thinking: 34, advisor: 24 };
  return <section className={`${G}zone ${G}gen`} data-zone="generator" aria-label="generator" aria-busy={status ? true : undefined}>
    <ZoneHead chip="generator" status={status}>{meta && <span className={`${G}meta ${G}meta-gen`}>{meta}</span>}</ZoneHead>
    {notice}
    <div className={`${G}dials`} aria-hidden="true">
      {MAIN_DIALS.map(id => <div key={id} className={`${G}dial ${G}ph-row`}><span className={`${G}caret`} /><span className={`${G}label`}>{id}</span>
        <span><span className={`${G}ph`} style={{ width: `min(${widths[id]}ch, 100%)` }} /></span></div>)}
      <div className={`${G}dial ${G}ph-row`}><span className={`${G}caret`} /><span className={`${G}label`}>more ›</span><span><span className={`${G}ph`} style={{ width: "16ch" }} /></span></div>
    </div>
    <div className={`${G}meters`} aria-hidden="true">
      <div className={`${G}meter`}><span className={`${G}label`}>cost</span><span className={`${G}ph`} style={{ width: "5ch" }} /></div>
      <div className={`${G}meter`}><span className={`${G}label`}>speed</span><span className={`${G}ph`} style={{ width: "5ch" }} /></div>
    </div>
  </section>;
}

// ---------------------------------------------------------------- routing ledger

export type LedgerView = { fallbacks: boolean; ids: boolean; pinned: ReadonlySet<string>; all: boolean };
const PLACEHOLDER_ROLES = ["default", "task", "plan", "slow", "reviewer", "security-reviewer", "scout", "sonic", "advisor", "vision", "smol", "tiny", "commit"];

/** The row an absent advisor would occupy, so turning it on visibly adds a line instead of shifting every row. */
function ledgerRoles(routes: readonly Route[]): string[] {
  const roles = routes.map(route => route.role);
  if (!roles.includes("advisor")) roles.splice(roles.includes("sonic") ? roles.indexOf("sonic") + 1 : roles.length, 0, "advisor");
  return roles;
}

export function Ledger({ review, catalog, aliases, preview, view, onPin, onShowAll }: {
  review: Review; catalog: CompiledCatalog; aliases: ReadonlyMap<string, string>; preview: Review | null; view: LedgerView;
  onPin: (role: string) => void; onShowAll: () => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const previous = useRef<Review["routes"] | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [room, setRoom] = useState(40);
  const [recent, setRecent] = useState<ReadonlySet<string>>(new Set());
  const routes = useMemo(() => new Map(review.routes.map(route => [route.role, route])), [review]);
  const roles = useMemo(() => ledgerRoles(review.routes), [review]);
  const previewed = useMemo(() => {
    if (!preview) return new Map<string, Route | null>();
    return new Map(routeChanges(review.routes, preview.routes).filter(change => change.kind !== "fallback").map(change => [change.role, change.to ?? null]));
  }, [review, preview]);
  // Afterglow: a route a dial just changed flashes once, then fades. Pure presentation over the diff.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = review.routes;
    if (!before) return;
    const changed = routeChanges(before, review.routes).filter(change => change.kind !== "fallback" || view.fallbacks).map(change => change.role);
    if (!changed.length) return;
    const reduced = prefersReducedMotion();
    for (const role of changed) {
      const row = rows.current.get(role);
      if (!row) continue;
      if (reduced) row.animate([{ boxShadow: "inset 0 -1px 0 #aa96e1" }, { boxShadow: "inset 0 -1px 0 #aa96e1" }], { duration: 1500 });
      else {
        row.animate([{ backgroundColor: "rgb(170 150 225 / 18%)" }, { backgroundColor: "rgb(170 150 225 / 0%)" }], { duration: 600, easing: "cubic-bezier(.2, 0, 0, 1)" });
        for (const cell of row.querySelectorAll(`.${G}alias, .${G}eff`)) cell.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "cubic-bezier(.2, 0, 0, 1)" });
      }
    }
    setRecent(new Set(changed));
    const timer = window.setTimeout(() => setRecent(new Set()), 1500);
    return () => window.clearTimeout(timer);
  }, [review]);
  // Full ids are middle-truncated to the detail column, which only the rendered width knows.
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    const probe = element.ownerDocument.createElement("span");
    probe.className = `${G}probe`;
    probe.textContent = "0".repeat(20);
    element.appendChild(probe);
    const ch = probe.getBoundingClientRect().width / 20 || 7.2;
    probe.remove();
    const measure = () => {
      const aux = element.querySelector<HTMLElement>(`.${G}aux`);
      if (aux) setRoom(Math.max(0, Math.floor((aux.clientWidth - 8) / ch)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const aliasWidth = Math.max(5, ...review.routes.map(route => (aliases.get(route.lead.key) ?? route.lead.key).length)) + 2;
  const tabRole = tab && roles.includes(tab) ? tab : roles[0];
  const hiddenChanged = roles.slice(5).filter(role => recent.has(role)).length;
  const choiceText = (key: string, thinking: string) => `${aliases.get(key) ?? key} ${thinking}`;
  function keys(event: KeyboardEvent<HTMLOListElement>) {
    const element = event.target as HTMLElement;
    const role = element.dataset.role;
    if (!role) return;
    const visible = [...list.current?.querySelectorAll<HTMLElement>("[data-role]") ?? []].filter(row => row.offsetParent !== null);
    const index = visible.indexOf(element);
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1 : null;
    if (next !== null) {
      event.preventDefault();
      const target = visible[Math.max(0, Math.min(visible.length - 1, next))];
      if (target) { setTab(target.dataset.role!); target.focus(); }
      return;
    }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPin(role); }
  }
  return <>
    <ol ref={list} className={`${G}ledger`} aria-label="roles and models" data-fallbacks={view.fallbacks || undefined} data-ids={view.ids || undefined}
      data-previewing={previewed.size > 0 || undefined} data-all={view.all || undefined} style={{ "--alias-w": `${aliasWidth}ch` } as CSSProperties} onKeyDown={keys}>
      {roles.map(role => {
        const route = routes.get(role);
        const pv = previewed.get(role);
        const common = {
          ref: (element: HTMLLIElement | null) => { if (element) rows.current.set(role, element); else rows.current.delete(role); },
          "data-role": role, tabIndex: role === tabRole ? 0 : -1, "data-pinned": view.pinned.has(role) || undefined, "data-pv": pv !== undefined || undefined,
          onClick: () => { setTab(role); onPin(role); },
        };
        const pvText = pv === undefined ? null : pv === null ? <>→ off</> : <>→ <span className={`${G}a`} data-fam={hueOf(catalog.family(pv.lead.key))}>{aliases.get(pv.lead.key) ?? pv.lead.key}</span> <span data-lvl={pv.lead.thinking}>{pv.lead.thinking}</span></>;
        if (!route) {
          return <li key={role} className={`${G}lrow`} data-off="" {...common} data-readout-label={role} data-readout={pv ? `off · this choice adds it as ${choiceText(pv.lead.key, pv.lead.thinking)}` : "off · turn advisor on to add it"}>
            <span className={`${G}mk`} /><span className={`${G}role`}>{role}</span><span className={`${G}alias`}>off</span><span className={`${G}eff`} />
            <span className={`${G}aux`}><span className={`${G}pv`}>{pvText}</span></span>
          </li>;
        }
        const model = catalog.model(route.lead.key);
        const id = `${model.provider}/${model.id}`;
        const chain = route.fallback.map(choice => choiceText(choice.key, choice.thinking)).join(" → ");
        return <li key={role} className={`${G}lrow`} {...common}
          data-readout-label={role} data-readout={`${choiceText(route.lead.key, route.lead.thinking)} · ${id}${chain ? ` · then ${chain}` : ""}`}>
          <span className={`${G}mk`} aria-hidden="true">{route.agentBacked ? "•" : ""}</span>
          <span className={`${G}role`}>{role}{route.agentBacked && <span className="plugin-atyrode_code__sr">, agent</span>}</span>
          <span className={`${G}alias`} data-fam={hueOf(catalog.family(route.lead.key))}>{aliases.get(route.lead.key) ?? route.lead.key}</span>
          <span className={`${G}eff`} data-lvl={route.lead.thinking}>{route.lead.thinking}</span>
          <span className={`${G}aux`}><span className={`${G}pv`}>{pvText}</span><span className={`${G}detail`} title={id}>{room > 4 ? middleId(id, room) : ""}</span></span>
          <span className={`${G}fb`} aria-label="fallbacks">{route.fallback.length ? route.fallback.map((choice, index) => <Fragment key={index}>
            {/* The space between steps sits outside them, so a long chain wraps between steps, never inside one. */}
            {index > 0 && " "}<span className={`${G}st`}><span className={`${G}arr`}>→</span> <span className={`${G}a`} data-fam={hueOf(catalog.family(choice.key))}>{aliases.get(choice.key) ?? choice.key}</span> <span data-lvl={choice.thinking}>{choice.thinking}</span></span>
          </Fragment>) : <span className={`${G}none`}>{review.selection.fallback ? "no fallback" : "fallbacks off"}</span>}</span>
        </li>;
      })}
    </ol>
    {!view.all && roles.length > 5 && <button type="button" className={cx("plugin-atyrode_code__q", `${G}moreroles`)} onClick={onShowAll}>
      +{roles.length - 5} more{hiddenChanged > 0 && <> <span className="plugin-atyrode_code__sep">·</span> <span className={`${G}chg`}>{hiddenChanged} changed</span></>}
    </button>}
  </>;
}

/** The routing zone: its chip line and the ledger, or ghost rows while nothing can be routed. */
export function RoutingZone({ review, catalog, aliases, preview, view, onToggle, onPin, onShowAll, status }: {
  review: Review | null; catalog: CompiledCatalog | null; aliases: ReadonlyMap<string, string>; preview: Review | null; view: LedgerView;
  onToggle: (toggle: "fallbacks" | "ids") => void; onPin: (role: string) => void; onShowAll: () => void; status?: ReactNode;
}) {
  if (!review || !catalog) {
    return <section className={`${G}zone ${G}route`} data-zone="routing" aria-label="routing">
      <ZoneHead chip="routing" status={status} />
      {status === undefined && <Notice kind="info">no complete profile for these choices · review in models</Notice>}
      {/* The roster's role names are stable product vocabulary, so the ghost ledger names its rows while routes are unknown. */}
      <ol className={`${G}ledger`} aria-hidden="true">{PLACEHOLDER_ROLES.map(role => <li key={role} className={`${G}lrow`} data-off="">
        <span className={`${G}mk`} /><span className={`${G}role`}>{role}</span>
        <span><span className={`${G}ph`} style={{ width: "5ch" }} /></span><span><span className={`${G}ph`} style={{ width: "6ch" }} /></span><span />
      </li>)}</ol>
    </section>;
  }
  return <section className={`${G}zone ${G}route`} data-zone="routing" aria-label="routing">
    <ZoneHead chip="routing" hints={[
      <span key="n">{review.routes.length} roles</span>,
      <Hint key="f" k="f" label="fallbacks" pressed={view.fallbacks} onClick={() => onToggle("fallbacks")} readout="show each role's ordered fallback chain" />,
      <Hint key="i" k="i" label="ids" pressed={view.ids} onClick={() => onToggle("ids")} readout="show full provider model ids" />,
    ]} />
    <Ledger review={review} catalog={catalog} aliases={aliases} preview={preview} view={view} onPin={onPin} onShowAll={onShowAll} />
  </section>;
}

/** A self-contained ledger for surfaces that review a catalog outside the main view (models). */
export function Routing({ value, catalog }: { value: Review; catalog: CompiledCatalog }) {
  const aliases = useMemo(() => displayAliases(catalog), [catalog]);
  const [view, setView] = useState<LedgerView>({ fallbacks: false, ids: false, pinned: new Set(), all: true });
  return <div className={`${G}routing`} data-zone="routing">
    <ZoneHead chip="routing" hints={[
      <span key="n">{value.routes.length} roles</span>,
      <Hint key="f" k="f" label="fallbacks" pressed={view.fallbacks} onClick={() => setView({ ...view, fallbacks: !view.fallbacks })} />,
      <Hint key="i" k="i" label="ids" pressed={view.ids} onClick={() => setView({ ...view, ids: !view.ids })} />,
    ]} />
    <Ledger review={value} catalog={catalog} aliases={aliases} preview={null} view={view}
      onPin={role => { const pinned = new Set(view.pinned); if (!pinned.delete(role)) pinned.add(role); setView({ ...view, pinned }); }} onShowAll={() => {}} />
    <p className={`${G}routing-note`}>{value.routes.some(route => route.fallback.length) ? "fallbacks are tried in order; thinking adapts to each model" : value.selection.fallback ? "no alternate models in these fallback chains" : "fallbacks off; retries stay on the lead model"}</p>
  </div>;
}
