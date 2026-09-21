import type { ActionInput as OmpInput, ActionResult as OmpResult } from "@atyrode/manifold-omp";

type Catalog = OmpResult<"readSkillCatalog">;
export type SkillChoice = OmpInput<"reviewSession">["skills"];
type Entry = Catalog["skills"][number];

/** Presentation only. OMP reauthorizes the catalog, source jobs and exact selection at review and launch. */
export function skillDraft(catalog: Catalog | null, choice: SkillChoice) {
  const selected: Entry[] = [];
  const problems: string[] = [];
  if (choice?.mode !== "select") return { selected, problems };
  if (!catalog) return { selected, problems: ["The selected skill catalog is unavailable. Refresh it or clear the optional choices."] };
  if (catalog.revision !== choice.expectedCatalogRevision) problems.push(`Skill catalog changed from revision ${choice.expectedCatalogRevision} to ${catalog.revision}. Clear and select again to review the current sources.`);
  const ids = new Set(choice.skillIds);
  for (const id of choice.setIds) {
    const set = catalog.sets.find(entry => entry.id === id);
    if (!set) problems.push(`Selected set ${id} is missing.`);
    else for (const skillId of set.skillIds) ids.add(skillId);
  }
  for (const id of [...ids].sort()) {
    const entry = catalog.skills.find(entry => entry.id === id);
    if (entry) selected.push(entry);
    else problems.push(`Selected skill ${id} is missing.`);
  }
  if (selected.length > 15) problems.push("A session can select at most 15 optional skills, including set members.");
  for (let index = 0; index < selected.length; index++) {
    const entry = selected[index]!;
    for (let otherIndex = index + 1; otherIndex < selected.length; otherIndex++) {
      const other = selected[otherIndex]!;
      if (entry.name === other.name) problems.push(`${entry.title} and ${other.title} share the native name ${entry.name}. Choose only one.`);
      else if (entry.conflicts.includes(other.id) || other.conflicts.includes(entry.id)) problems.push(`${entry.title} conflicts with ${other.title}. Choose only one.`);
    }
  }
  return { selected, problems };
}
