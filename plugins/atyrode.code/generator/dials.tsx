import { useId, useRef, useState } from "react";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import { SelectionSchema, ThinkingLevelSchema, type Lane, type Selection } from "../../domain/contracts.ts";
import { familyPolicy } from "../../domain/providers.ts";
import { reviewCatalog, type Review } from "../../domain/routing.ts";

const icons = {
  lane: "M4 6h3c5 0 5 12 10 12h3m-4-4 4 4-4 4M4 18h3c2 0 3-2 4-4m3-4c1-2 2-4 4-4h2m-4-4 4 4-4 4",
  model: "M5 7h14v12H5zM9 3v4m6-4v4M2 11h3m14 0h3M9 11h6m-6 4h6",
  thinking: "M8 17h8m-8 3h8M8 14c-5-5-2-11 4-11s9 6 4 11l-1 3H9z",
  advisor: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm4 5-2 6-6 2 2-6z",
  priority: "m13 2-8 12h6l-1 8 9-13h-7z",
  spark: "m9 15-3-3c2-6 7-9 14-9 0 7-3 12-9 14Zm-3-3-3 1 1-5 6-1m1 10-1 4 5-1 1-6M4 17l-2 5 5-2M14 8h.01",
  prewalk: "M4 5h5l2 3h9v12H4zM8 13h8m-3-3 3 3-3 3",
  planYolo: "M7 3h10v18H7zM10 8h4m-4 4h4m-4 4h4",
  fallback: "M7 6H3v4m0-4 5 5a7 7 0 1 1-1 7",
} as const;

export function DialIcon({ kind }: { kind: keyof typeof icons }) {
  return <svg className="plugin-atyrode_code_generator__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[kind]} /></svg>;
}

type Option = { value: string; label: string; title?: string };
function Dial({ label, icon, value, options, disabled, change }: {
  label: string; icon: keyof typeof icons; value: string; options: readonly Option[]; disabled: boolean; change: (value: string) => void;
}) {
  const id = useId();
  const dragging = useRef(false);
  return <div className="plugin-atyrode_code_generator__dial">
    <span id={id} className="plugin-atyrode_code_generator__dial-label"><DialIcon kind={icon} />{label}</span>
    <div className="plugin-atyrode_code_generator__dial-options" role="radiogroup" aria-labelledby={id}
      onPointerDown={event => { dragging.current = event.button === 0 && !disabled; }} onPointerUp={() => { dragging.current = false; }} onPointerLeave={() => { dragging.current = false; }}>
      {options.map((option, index) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} disabled={disabled}
        tabIndex={value === option.value ? 0 : -1} data-choice={index} title={option.title} onClick={() => { if (value !== option.value) change(option.value); }}
        onPointerEnter={event => { if (dragging.current && event.buttons === 1 && value !== option.value) change(option.value); }}
        onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
          change(options[next]!.value);
          event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`button[data-choice="${next}"]`)?.focus();
        }}>{option.label}</button>)}
    </div>
  </div>;
}

function laneLabel(lane: Lane): string {
  if (lane.kind === "mixed") return "mixed";
  const label = lane.family === "openai" ? "gpt" : lane.family === "anthropic" ? "claude" : familyPolicy(lane.family)?.label.toLowerCase() ?? lane.family;
  return `${label}-${lane.blend}`;
}
const levels = { 1: "fast", 2: "normal", 3: "smart", 4: "max" } as const;
const toggles = [{ value: "true", label: "on" }, { value: "false", label: "off" }] as const;

export function Dials({ selection, review, catalog, disabled, update }: {
  selection: Selection; review: Review; catalog: CompiledCatalog; disabled: boolean; update: (selection: Selection) => void;
}) {
  const lanes = review.available.lanes;
  function changeLane(value: string) {
    const lane = lanes.find(candidate => JSON.stringify(candidate) === value);
    if (!lane) return;
    const available = reviewCatalog(catalog, { ...selection, lane, capability: 1, spark: false, priority: false }, Date.now()).available;
    update({ ...selection, lane, capability: available.capabilities.includes(selection.capability) ? selection.capability : available.capabilities.at(-1)!,
      spark: selection.spark && available.spark, priority: selection.priority && available.priority });
  }
  return <div className="plugin-atyrode_code_generator__dials">
    <Dial label="lane" icon="lane" value={JSON.stringify(selection.lane)} options={lanes.map(lane => ({ value: JSON.stringify(lane), label: laneLabel(lane) }))} disabled={disabled} change={changeLane} />
    <Dial label="model" icon="model" value={String(selection.capability)} options={review.available.capabilities.map(value => ({ value: String(value), label: levels[value] }))} disabled={disabled} change={value => update({ ...selection, capability: SelectionSchema.shape.capability.parse(Number(value)) })} />
    <Dial label="thinking" icon="thinking" value={selection.thinking} options={ThinkingLevelSchema.options.map(value => ({ value, label: value }))} disabled={disabled} change={value => update({ ...selection, thinking: ThinkingLevelSchema.parse(value) })} />
    <Dial label="advisors" icon="advisor" value={selection.advisor} options={SelectionSchema.shape.advisor.options.map(value => ({ value, label: value }))} disabled={disabled} change={value => update({ ...selection, advisor: SelectionSchema.shape.advisor.parse(value) })} />
    {review.available.priority && <Dial label="fast" icon="priority" value={String(selection.priority)} options={toggles} disabled={disabled} change={value => update({ ...selection, priority: value === "true" })} />}
    {review.available.spark && <Dial label="spark" icon="spark" value={String(selection.spark)} options={toggles} disabled={disabled} change={value => update({ ...selection, spark: value === "true" })} />}
    <details className="plugin-atyrode_code_generator__extra-dials"><summary>more dials{selection.prewalk || selection.planYolo ? " · enabled" : ""}</summary>
      <Dial label="prewalk" icon="prewalk" value={String(selection.prewalk)} options={toggles} disabled={disabled} change={value => update({ ...selection, prewalk: value === "true" })} />
      <Dial label="plans" icon="planYolo" value={String(selection.planYolo)} options={[{ value: "false", label: "ask" }, { value: "true", label: "auto-approve", title: "Automatically approve plans in the launched session" }]} disabled={disabled} change={value => update({ ...selection, planYolo: value === "true" })} />
      <Dial label="fallback" icon="fallback" value={String(selection.fallback)} options={toggles} disabled={disabled} change={value => update({ ...selection, fallback: value === "true" })} />
    </details>
  </div>;
}

export function Estimates({ value }: { value: Review["estimates"] }) {
  return <dl className="plugin-atyrode_code_generator__estimates">{(["cost", "speed"] as const).map(label => {
    const score = value[label === "cost" ? "costScore" : "speedScore"];
    return <div key={label}><dt>{label}</dt><dd role="img" aria-label={`Estimated relative ${label}: ${score} out of 5`} title={`Estimated relative ${label}; not a live quota or performance guarantee`}>
      {Array.from({ length: 5 }, (_, index) => <span key={index} aria-hidden="true" data-filled={index < score}>{label === "cost" ? "$" : "»"}</span>)}
    </dd></div>;
  })}</dl>;
}

export function Routing({ value, catalog }: { value: Review; catalog: CompiledCatalog }) {
  const [fallbacks, setFallbacks] = useState(false);
  function choice(key: string, thinking: string) {
    const model = catalog.model(key);
    const family = catalog.family(key);
    return <span className="plugin-atyrode_code_generator__model" data-family={family} title={`${model.provider}/${model.id} · ${thinking}`}>
      <span>{model.key.length <= model.id.length ? model.key : model.id}</span><span className="plugin-atyrode_code_generator__thinking">:{thinking}</span>
    </span>;
  }
  return <section className="plugin-atyrode_code_generator__routing" aria-label="Routing preview">
    <header className="plugin-atyrode_code__section-heading"><h2 className="plugin-atyrode_code__section-label">routing</h2></header>
    <dl className="plugin-atyrode_code_generator__routes">{value.routes.map(route => <div key={route.role}>
      <dt><span className="plugin-atyrode_code_generator__agent-marker" title={route.agentBacked ? "Agent role" : undefined} aria-hidden="true">{route.agentBacked ? "●" : ""}</span>{route.role}</dt>
      <dd>{choice(route.lead.key, route.lead.thinking)}{fallbacks && route.fallback.map((fallback, index) => <span key={`${fallback.key}:${index}`} className="plugin-atyrode_code_generator__fallback"><span aria-hidden="true">↳ </span>{choice(fallback.key, fallback.thinking)}</span>)}</dd>
    </div>)}</dl>
    <button type="button" className="plugin-atyrode_code_generator__fallback-toggle" aria-pressed={fallbacks} onClick={() => setFallbacks(!fallbacks)}>{fallbacks ? "hide fallback chains" : "show fallback chains"}</button>
  </section>;
}
