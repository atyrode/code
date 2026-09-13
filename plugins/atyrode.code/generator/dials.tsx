import { useId, useRef, useState } from "react";
import type { CompiledCatalog } from "../../domain/catalog.ts";
import { SelectionSchema, type Lane, type Selection } from "../../domain/contracts.ts";
import { ThinkingLevelSchema } from "@atyrode/manifold-omp";
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

type Option = { value: string; label: string; description: string; family?: string };
function Dial({ label, icon, value, options, disabled, change }: {
  label: string; icon: keyof typeof icons; value: string; options: readonly Option[]; disabled: boolean; change: (value: string) => void;
}) {
  const id = useId();
  const dragging = useRef<{ pointerId: number; value: string; startX: number; startY: number; intent: "pending" | "horizontal" | "vertical" } | null>(null);
  const selected = options.find(option => option.value === value);
  function choose(button: HTMLButtonElement | null) {
    const next = button?.dataset.value;
    if (!button || button.disabled || next === undefined) return;
    button.focus({ preventScroll: true });
    if (next !== (dragging.current?.value ?? value)) {
      if (dragging.current) dragging.current.value = next;
      change(next);
    }
  }
  return <div className="plugin-atyrode_code_generator__dial">
    <span id={id} className="plugin-atyrode_code_generator__dial-label"><DialIcon kind={icon} />{label}</span>
    <div className="plugin-atyrode_code_generator__dial-control">
      <div className="plugin-atyrode_code_generator__dial-options" role="radiogroup" aria-labelledby={id} aria-describedby={`${id}-detail`}
        onPointerDown={event => {
          if (event.button !== 0 || !event.isPrimary || disabled) return;
          const button = (event.target as Element).closest<HTMLButtonElement>("button[data-value]");
          if (!button || !event.currentTarget.contains(button)) return;
          dragging.current = { pointerId: event.pointerId, value, startX: event.clientX, startY: event.clientY, intent: event.pointerType === "touch" ? "pending" : "horizontal" };
          event.currentTarget.setPointerCapture(event.pointerId);
          if (event.pointerType !== "touch") choose(button);
        }}
        onPointerMove={event => {
          const gesture = dragging.current;
          if (gesture?.pointerId !== event.pointerId || disabled || gesture.intent === "vertical") return;
          if (gesture.intent === "pending") {
            const horizontal = Math.abs(event.clientX - gesture.startX);
            const vertical = Math.abs(event.clientY - gesture.startY);
            if (Math.max(horizontal, vertical) < 8) return;
            gesture.intent = horizontal > vertical ? "horizontal" : "vertical";
            if (gesture.intent === "vertical") return;
          }
          const button = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLButtonElement>("button[data-value]") ?? null;
          if (button && event.currentTarget.contains(button)) choose(button);
        }}
        onPointerUp={event => {
          if (dragging.current?.pointerId === event.pointerId && dragging.current.intent !== "vertical" && !disabled) {
            const button = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLButtonElement>("button[data-value]") ?? null;
            if (button && event.currentTarget.contains(button)) choose(button);
          }
          dragging.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { dragging.current = null; }} onLostPointerCapture={() => { dragging.current = null; }}>
        {options.map((option, index) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} aria-describedby={`${id}-detail`} disabled={disabled}
          tabIndex={value === option.value ? 0 : -1} data-choice={index} data-value={option.value} data-family={option.family} title={option.description}
          onClick={event => { if (event.detail === 0 && value !== option.value) change(option.value); }}
          onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
            change(options[next]!.value);
            event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`button[data-choice="${next}"]`)?.focus();
          }}>{option.label}</button>)}
      </div>
      <p id={`${id}-detail`} className="plugin-atyrode_code_generator__dial-detail">{selected?.description}</p>
    </div>
  </div>;
}

function laneOption(lane: Lane): Option {
  const value = JSON.stringify(lane);
  if (lane.kind === "mixed") return { value, label: "Mixed", description: "OpenAI leads execution; Anthropic handles planning and deeper review." };
  const label = familyPolicy(lane.family)?.label ?? lane.family;
  return { value, family: lane.family, label: `${label} ${lane.blend}`,
    description: lane.blend === "only" ? `Keep routing within ${label}; vision may use another provider if needed.` : `${label} leads, with another provider for independent reviews and fallback options.` };
}
const levels = { 1: "Fast", 2: "Balanced", 3: "Capable", 4: "Maximum" } as const;
const capabilityDetails = {
  1: "Lighter models for quick, contained work. Planning and review can use a higher tier.",
  2: "A balanced model tier for everyday implementation and problem solving.",
  3: "More capable lead models for larger changes and harder reasoning.",
  4: "The highest available model tier; utility roles remain right-sized.",
} as const;
const thinkingOptions = [
  { value: "minimal", label: "Minimal", description: "Request the least thinking available across roles." },
  { value: "low", label: "Light", description: "Keep reasoning light; planning and review get extra room." },
  { value: "medium", label: "Balanced", description: "Balance reasoning effort, with more for reviews and less for utility roles." },
  { value: "high", label: "Deep", description: "Give difficult work more reasoning effort; utility roles stay lighter." },
  { value: "xhigh", label: "Deeper", description: "Request extra-high reasoning where supported by the routed model." },
  { value: "max", label: "Maximum", description: "Request maximum thinking across roles, capped by each model's support." },
] as const;
const advisorOptions = [
  { value: "off", label: "Off", description: "No advisor model is added to the session." },
  { value: "glance", label: "Glance", description: "Add a lightweight advisor for a second perspective." },
  { value: "review", label: "Review", description: "Use a stronger advisor with a lighter fallback when fallbacks are enabled." },
  { value: "audit", label: "Audit", description: "Use a deeper advisor and enable advice for delegated tasks." },
] as const;

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
    <Dial label="Provider" icon="lane" value={JSON.stringify(selection.lane)} options={lanes.map(laneOption)} disabled={disabled} change={changeLane} />
    <Dial label="Capability" icon="model" value={String(selection.capability)} options={review.available.capabilities.map(value => ({ value: String(value), label: levels[value], description: capabilityDetails[value] }))} disabled={disabled} change={value => update({ ...selection, capability: SelectionSchema.shape.capability.parse(Number(value)) })} />
    <Dial label="Thinking" icon="thinking" value={selection.thinking} options={thinkingOptions} disabled={disabled} change={value => update({ ...selection, thinking: ThinkingLevelSchema.parse(value) })} />
    <Dial label="Advisor" icon="advisor" value={selection.advisor} options={advisorOptions} disabled={disabled} change={value => update({ ...selection, advisor: SelectionSchema.shape.advisor.parse(value) })} />
    {review.available.priority && <Dial label="Priority" icon="priority" value={String(selection.priority)} options={[
      { value: "false", label: "Standard", description: "Use standard provider service tiers." },
      { value: "true", label: "Priority", description: "Request OpenAI's priority service tier. Higher cost; not a latency guarantee." },
    ]} disabled={disabled} change={value => update({ ...selection, priority: value === "true" })} />}
    {review.available.spark && <Dial label="Spark" icon="spark" value={String(selection.spark)} options={[
      { value: "false", label: "Off", description: "Use the regular model ladder for small utility work." },
      { value: "true", label: "On", description: "Route tiny and commit work to Spark; also Sonic at the Fast capability tier." },
    ]} disabled={disabled} change={value => update({ ...selection, spark: value === "true" })} />}
    <details className="plugin-atyrode_code_generator__extra-dials"><summary>Session behavior <span>{[selection.prewalk ? "prewalk on" : null, selection.planYolo ? "auto-approve plans" : null, selection.fallback ? "fallbacks on" : "fallbacks off"].filter(Boolean).join(" · ")}</span></summary>
      <Dial label="Prewalk" icon="prewalk" value={String(selection.prewalk)} options={[
        { value: "false", label: "Off", description: "Leave automatic repository prewalk disabled." },
        { value: "true", label: "On", description: "Enable OMP's repository prewalk for the session and delegated tasks." },
      ]} disabled={disabled} change={value => update({ ...selection, prewalk: value === "true" })} />
      <Dial label="Plans" icon="planYolo" value={String(selection.planYolo)} options={[
        { value: "false", label: "Ask first", description: "Keep explicit plan approval in the launched session." },
        { value: "true", label: "Auto-approve", description: "Automatically approve plans in the launched session. Launch itself still requires review." },
      ]} disabled={disabled} change={value => update({ ...selection, planYolo: value === "true" })} />
      <Dial label="Fallbacks" icon="fallback" value={String(selection.fallback)} options={[
        { value: "false", label: "Off", description: "Keep retries on the selected models, without switching to fallback models." },
        { value: "true", label: "On", description: "Allow the ordered fallback chains shown in routing when a lead model cannot serve the request." },
      ]} disabled={disabled} change={value => update({ ...selection, fallback: value === "true" })} />
    </details>
  </div>;
}

export function Estimates({ value }: { value: Review["estimates"] }) {
  return <div className="plugin-atyrode_code_generator__estimate-panel">
    <dl className="plugin-atyrode_code_generator__estimates">{(["cost", "speed"] as const).map(label => {
      const score = value[label === "cost" ? "costScore" : "speedScore"];
      const description = (label === "cost" ? ["Lowest", "Lower", "Moderate", "Higher", "Highest"] : ["Most deliberate", "Deliberate", "Balanced", "Faster", "Fastest"])[score - 1];
      return <div key={label} data-estimate={label}><dt>Relative {label}</dt><dd>
        <span className="plugin-atyrode_code_generator__estimate-value" key={score}>{description} <small>{score}/5</small></span>
        <span className="plugin-atyrode_code_generator__estimate-meter" aria-hidden="true">{[1, 2, 3, 4, 5].map(step => <span key={step} data-filled={step <= score} />)}</span>
      </dd></div>;
    })}</dl>
    <p>Catalog-based estimates, not live spend or measured performance. Speed may use a default when catalog data is missing.</p>
  </div>;
}

export function Routing({ value, catalog, local = false }: { value: Review; catalog: CompiledCatalog; local?: boolean }) {
  const id = useId();
  const [fallbacks, setFallbacks] = useState(false);
  const [fullIds, setFullIds] = useState(false);
  const fallbackCount = value.routes.reduce((count, route) => count + route.fallback.length, 0);
  function choice(key: string, thinking: string) {
    const model = catalog.model(key);
    const family = catalog.family(key);
    return <span key={`${key}:${thinking}`} className="plugin-atyrode_code_generator__model" data-family={family}>
      <span className="plugin-atyrode_code_generator__model-name">{model.key}</span>
      <span className="plugin-atyrode_code_generator__model-meta"><span className="plugin-atyrode_code_generator__provider">{familyPolicy(family)?.label ?? model.provider}</span><span className="plugin-atyrode_code_generator__thinking" data-level={thinking}>{thinking} thinking</span></span>
      {fullIds && <code className="plugin-atyrode_code_generator__model-id">{model.provider}/{model.id}</code>}
    </span>;
  }
  return <section className="plugin-atyrode_code_generator__routing" aria-label="Routing preview">
    <header className="plugin-atyrode_code__section-heading"><h2 className="plugin-atyrode_code__section-label">Routing</h2><span className="plugin-atyrode_code_generator__route-status" data-local={local} role="status">{local ? "Local preview" : "Profile preview"} · {value.routes.length} roles</span></header>
    <div className="plugin-atyrode_code_generator__routing-tools">
      <p>Lead models <span className="plugin-atyrode_code_generator__agent-legend"><span aria-hidden="true">●</span> delegated agent</span></p>
      <div className="plugin-atyrode_code__toolbar">
        <button type="button" aria-pressed={fullIds} aria-controls={`${id}-routes`} onClick={() => setFullIds(!fullIds)}>Full model IDs</button>
        {fallbackCount > 0 && <button type="button" aria-expanded={fallbacks} aria-controls={`${id}-routes`} onClick={() => setFallbacks(!fallbacks)}>{fallbacks ? "Hide" : "Show"} fallbacks <span className="plugin-atyrode_code_generator__count">{fallbackCount}</span></button>}
      </div>
    </div>
    <dl id={`${id}-routes`} className="plugin-atyrode_code_generator__routes">{value.routes.map(route => <div key={route.role}>
      <dt><span className="plugin-atyrode_code_generator__agent-marker" aria-hidden="true">{route.agentBacked ? "●" : ""}</span>{route.role}{route.agentBacked && <span className="plugin-atyrode_code_generator__sr-only">, delegated agent</span>}</dt>
      <dd>{choice(route.lead.key, route.lead.thinking)}{fallbacks && route.fallback.length > 0 && <ol className="plugin-atyrode_code_generator__fallbacks" aria-label={`${route.role} fallbacks in order`}>{route.fallback.map((fallback, index) => <li key={`${fallback.key}:${index}`} className="plugin-atyrode_code_generator__fallback"><span className="plugin-atyrode_code_generator__fallback-order" aria-hidden="true">{index + 1}</span>{choice(fallback.key, fallback.thinking)}</li>)}</ol>}</dd>
    </div>)}</dl>
    <p className="plugin-atyrode_code_generator__routing-note">{fallbackCount > 0 ? "Fallbacks are tried in order. Thinking is adjusted to each model's supported levels." : value.selection.fallback ? "No alternate models in this profile's fallback chains." : "Model fallback is off. Retries stay on the selected model."}</p>
  </section>;
}
