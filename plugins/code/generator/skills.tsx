import type { ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { skillDraft, type SkillChoice } from "./skill-draft.ts";

type Catalog = OmpResult<"readSkillCatalog">;
type Entry = Catalog["skills"][number];


function Provenance({ entry }: { entry: Entry }) {
  return <details className="plugin-atyrode_code__details"><summary>Source, license and review · {entry.revision}</summary>
    <dl><dt>Native name</dt><dd>{entry.name}</dd><dt>Immutable output</dt><dd>{entry.source.jobId} / {entry.source.output}</dd>
      <dt>SHA-256</dt><dd>{entry.source.sha256}</dd><dt>License</dt><dd>{entry.license.spdx}{entry.license.url && <> · {entry.license.url}</>}</dd>
      <dt>Reviewed by</dt><dd>{entry.review.reviewedBy} · {new Date(entry.review.reviewedAt).toLocaleString()}</dd>
      <dt>Review reference</dt><dd>{entry.review.reference}</dd>
      {entry.classification && <><dt>Classification</dt><dd>{entry.classification}</dd></>}
      {!!entry.conflicts.length && <><dt>Declared conflicts</dt><dd>{entry.conflicts.join(", ")}</dd></>}
    </dl>
  </details>;
}

export function OptionalSkills({ catalog, error, choice, reviewed, restricted = false, disabled, refresh, change }: {
  catalog: Catalog | null; error: string | null; choice: SkillChoice;
  reviewed: OmpResult<"reviewSession">["skills"] | null; restricted?: boolean; disabled: boolean;
  refresh: () => void; change: (choice: SkillChoice) => void;
}) {
  const draft = skillDraft(catalog, choice);
  const selected = reviewed?.selected ?? draft.selected;
  const mode = reviewed?.mode ?? choice?.mode ?? "preserve";
  function toggle(kind: "skillIds" | "setIds", id: string) {
    if (!catalog) return;
    const current = choice?.mode === "select" ? choice : { mode: "select" as const, expectedCatalogRevision: catalog.revision, skillIds: [], setIds: [] };
    change({ ...current, [kind]: current[kind].includes(id) ? current[kind].filter(value => value !== id) : [...current[kind], id].sort() });
  }
  const stale = choice?.mode === "select" && choice.expectedCatalogRevision !== catalog?.revision;
  return <section className="plugin-atyrode_code_generator__skills" aria-label="Optional skills" data-mode={choice?.mode ?? "preserve"}>
    <h3>Optional skills</h3>
    <p>For this launch only. Available does not mean selected; selected does not mean invoked. OMP alone loads the reviewed sources.</p>
    <div className="plugin-atyrode_code__toolbar">
      <button type="button" disabled={disabled} onClick={() => change(undefined)}>Clear optional choices</button>
      <button type="button" disabled={disabled || choice?.mode === "disabled"} onClick={() => change({ mode: "disabled" })}>Disable all skills</button>
      <button type="button" disabled={disabled} onClick={refresh}>Refresh skill catalog</button>
    </div>
    <p role="status">{mode === "disabled" ? "All skill sources and skill advertisements will be disabled for this launch." : restricted ? `${selected.length} deliberately selected sealed skills. Ambient core/project/discovery loading is suppressed; skills grant no authority.` : mode !== "preserve" ? `${selected.length} optional skill${selected.length === 1 ? "" : "s"} selected. Ordinary permitted core/project loading is preserved.` : "No optional skills selected. Ordinary permitted core/project loading is preserved."}</p>
    {error && <p role="status" className="plugin-atyrode_code__warning">{error}</p>}
    {draft.problems.map(problem => <p role="status" className="plugin-atyrode_code__warning" key={problem}>{problem}</p>)}
    {choice?.mode === "select" && <p>Draft catalog revision {choice.expectedCatalogRevision} · skill IDs: {choice.skillIds.join(", ") || "none"} · set IDs: {choice.setIds.join(", ") || "none"}</p>}
    <h4>{reviewed ? "Native-reviewed selection" : "Draft selection"} · invocation unknown</h4>
    {selected.length ? <ul aria-label="Selected optional skills">{selected.map(entry => <li key={entry.id}><strong>{entry.title}</strong><p>{entry.purpose}</p><Provenance entry={entry} /></li>)}</ul> : <p>No optional entries selected.</p>}
    {catalog ? <>
      <h4>Available · catalog revision {catalog.revision}</h4>
      {!catalog.skills.length && <p>No optional skills are published for this destination.</p>}
      <fieldset disabled={disabled || stale || choice?.mode === "disabled"}>
        <legend>Deliberate sets</legend>
        {catalog.sets.length ? catalog.sets.map(set => <label key={set.id}><input type="checkbox" checked={choice?.mode === "select" && choice.setIds.includes(set.id)} onChange={() => toggle("setIds", set.id)} />{set.title}<span>{set.skillIds.map(id => catalog.skills.find(entry => entry.id === id)?.title ?? id).join(", ")}</span></label>) : <p>No sets published.</p>}
      </fieldset>
      <fieldset disabled={disabled || stale || choice?.mode === "disabled"}>
        <legend>Individual skills</legend>
        {catalog.skills.map(entry => <div key={entry.id}>
          <label><input type="checkbox" checked={choice?.mode === "select" && choice.skillIds.includes(entry.id)} onChange={() => toggle("skillIds", entry.id)} />{entry.title}<span>{selected.some(selected => selected.id === entry.id) ? "Selected" : "Available"}</span></label>
          <p>{entry.purpose}</p><Provenance entry={entry} />
        </div>)}
      </fieldset>
    </> : !error && <p role="status">Reading authorized skill metadata…</p>}
  </section>;
}
