import { useState } from "react";
import type { ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { OptionSwitch } from "./option-switch.tsx";
import { skillDraft, type SkillChoice } from "./skill-draft.ts";

const G = "plugin-atyrode_code_generator__";
type Catalog = OmpResult<"readSkillCatalog">;
type Entry = Catalog["skills"][number];

/** A skill's source, license and review, opened in place under it by its own word. */
function Source({ entry, open, toggle }: { entry: Entry; open: boolean; toggle: () => void }) {
  return <>
    <button type="button" className={`${G}options-link`} aria-expanded={open} onClick={toggle}>source · {entry.revision}</button>
    {open && <dl className={`${G}options-facts`} aria-label={`${entry.title}: source, license and review`}>
      <dt>native name</dt><dd>{entry.name}</dd>
      <dt>immutable output</dt><dd>{entry.source.jobId} / {entry.source.output}</dd>
      <dt>SHA-256</dt><dd>{entry.source.sha256}</dd>
      <dt>license</dt><dd>{entry.license.spdx}{entry.license.url && <> · {entry.license.url}</>}</dd>
      <dt>reviewed by</dt><dd>{entry.review.reviewedBy} · {new Date(entry.review.reviewedAt).toLocaleString()}</dd>
      <dt>review reference</dt><dd>{entry.review.reference}</dd>
      {entry.classification && <><dt>classification</dt><dd>{entry.classification}</dd></>}
      {!!entry.conflicts.length && <><dt>declared conflicts</dt><dd>{entry.conflicts.join(", ")}</dd></>}
    </dl>}
  </>;
}

/**
 * Optional skills for the next launch, in the session options sheet: two pressed words choose the
 * default loading or none at all, and every published set and skill is a switch that chooses it
 * deliberately. Availability selects or invokes nothing; OMP alone loads a reviewed source, and a
 * skill grants no authority.
 */
export function OptionalSkills({ catalog, error, choice, reviewed, restricted = false, refusal, refresh, change }: {
  catalog: Catalog | null; error: string | null; choice: SkillChoice;
  reviewed: OmpResult<"reviewSession">["skills"] | null; restricted?: boolean;
  /** Why the controls are refused now; null when they act. */
  refusal: string | null; refresh: () => void; change: (choice: SkillChoice) => void;
}) {
  const [sources, setSources] = useState<ReadonlySet<string>>(new Set());
  const draft = skillDraft(catalog, choice);
  const selected = reviewed?.selected ?? draft.selected;
  const mode = reviewed?.mode ?? choice?.mode ?? "preserve";
  function toggle(kind: "skillIds" | "setIds", id: string) {
    if (!catalog) return;
    const current = choice?.mode === "select" ? choice : { mode: "select" as const, expectedCatalogRevision: catalog.revision, skillIds: [], setIds: [] };
    change({ ...current, [kind]: current[kind].includes(id) ? current[kind].filter(value => value !== id) : [...current[kind], id].sort() });
  }
  function source(entry: Entry) {
    return <Source entry={entry} open={sources.has(entry.id)} toggle={() => setSources(previous => {
      const next = new Set(previous);
      if (!next.delete(entry.id)) next.add(entry.id);
      return next;
    })} />;
  }
  const stale = choice?.mode === "select" && choice.expectedCatalogRevision !== catalog?.revision;
  // A deliberate choice waits on the controls, on a catalog it was made against, and on skills not being off altogether.
  const choosing = refusal ?? (stale ? "The skill catalog changed; go back to default skills and choose again." : choice?.mode === "disabled" ? "All skills are off." : null);
  return <section className={`${G}options-group`} aria-label="Optional skills" data-mode={choice?.mode ?? "preserve"}>
    <h3 className={`${G}options-head`}>skills</h3>
    <div className={`${G}options-choices`} role="group" aria-label="Skill loading">
      <button type="button" className={`${G}options-choice`} aria-pressed={choice === undefined} aria-disabled={refusal !== null || undefined} title={refusal ?? undefined}
        onClick={() => { if (refusal === null && choice !== undefined) change(undefined); }}>default skills</button>
      <button type="button" className={`${G}options-choice`} aria-pressed={choice?.mode === "disabled"} aria-disabled={refusal !== null || undefined} title={refusal ?? undefined}
        onClick={() => { if (refusal === null && choice?.mode !== "disabled") change({ mode: "disabled" }); }}>all skills off</button>
      <button type="button" className={`${G}options-link`} aria-disabled={refusal !== null || undefined} title={refusal ?? undefined}
        onClick={() => { if (refusal === null) refresh(); }}>read skills again</button>
    </div>
    <p className={`${G}options-note`} role="status">{mode === "disabled" ? "Every skill source and skill advertisement is off for this launch."
      : restricted ? `${selected.length} deliberately selected sealed skill${selected.length === 1 ? "" : "s"}; ambient core, project and discovery loading is suppressed. Skills grant no authority.`
      : mode !== "preserve" ? `${selected.length} optional skill${selected.length === 1 ? "" : "s"} chosen; ordinary permitted core and project loading stays.`
      : "No optional skills chosen; ordinary permitted core and project loading stays."}</p>
    <p className={`${G}options-note`} data-tone="meta">Availability selects or invokes nothing. OMP alone loads a reviewed source, and a skill grants no authority.</p>
    {error && <p className={`${G}options-note`} role="status" data-tone="warn">{error}</p>}
    {draft.problems.map(problem => <p key={problem} className={`${G}options-note`} role="status" data-tone="warn">{problem}</p>)}
    {choice?.mode === "select" && <p className={`${G}options-note`} data-tone="meta">catalog revision {choice.expectedCatalogRevision} · skill ids {choice.skillIds.join(", ") || "none"} · set ids {choice.setIds.join(", ") || "none"}</p>}
    {!!selected.length && <>
      <h4 className={`${G}options-subhead`}>{reviewed ? "reviewed" : "chosen"} · invocation unknown</h4>
      <ul className={`${G}options-skills`} aria-label="Selected optional skills">{selected.map(entry => <li key={entry.id}>
        <span className={`${G}options-skill-title`}>{entry.title}</span>
        <p className={`${G}options-note`}>{entry.purpose}</p>
        {source(entry)}
      </li>)}</ul>
    </>}
    {catalog ? <>
      {!catalog.skills.length && <p className={`${G}options-note`}>No optional skills are published for this destination.</p>}
      {!!(catalog.sets.length || catalog.skills.length) && <>
        <h4 className={`${G}options-subhead`}>deliberate sets</h4>
        {catalog.sets.length ? <ul className={`${G}options-skills`} aria-label="Deliberate sets">{catalog.sets.map(set => <li key={set.id}>
          <OptionSwitch on={choice?.mode === "select" && choice.setIds.includes(set.id)} refusal={choosing} onChange={() => toggle("setIds", set.id)}>{set.title}</OptionSwitch>
          <p className={`${G}options-note`}>{set.skillIds.map(id => catalog.skills.find(entry => entry.id === id)?.title ?? id).join(", ")}</p>
        </li>)}</ul> : <p className={`${G}options-note`}>No sets published.</p>}
        <h4 className={`${G}options-subhead`}>individual skills</h4>
        <ul className={`${G}options-skills`} aria-label="Individual skills">{catalog.skills.map(entry => <li key={entry.id}>
          <OptionSwitch on={choice?.mode === "select" && choice.skillIds.includes(entry.id)} refusal={choosing} onChange={() => toggle("skillIds", entry.id)}>{entry.title}</OptionSwitch>
          <p className={`${G}options-note`}>{entry.purpose}</p>
          {source(entry)}
        </li>)}</ul>
      </>}
    </> : !error && <p className={`${G}options-note`} role="status">Reading authorized skill metadata…</p>}
  </section>;
}
