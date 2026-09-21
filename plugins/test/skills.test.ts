import { expect, test } from "bun:test";
import type { ActionResult as OmpResult } from "@atyrode/manifold-omp";
import { skillDraft } from "../code/generator/skill-draft.ts";

type Catalog = OmpResult<"readSkillCatalog">;
function entry(id: string, conflicts: string[] = []): Catalog["skills"][number] {
  return { id, name: id, title: id, purpose: `Review ${id}`, revision: "source-v1",
    source: { jobId: `job-${id}`, output: "skill", sha256: "a".repeat(64) },
    license: { spdx: "MIT" }, review: { reviewedBy: "owner", reviewedAt: 1_000, reference: "review-1" }, conflicts };
}
const catalog: Catalog = { revision: 7, skills: [entry("alpha"), entry("beta", ["alpha"]), entry("gamma")],
  sets: [{ id: "base", title: "Base", skillIds: ["gamma", "alpha"] }], updatedAt: 1_000, updatedBy: "owner" };

test("overlapping individual and set choices form one deterministic selection and retain declared conflict refusals", () => {
  const selection = { mode: "select" as const, expectedCatalogRevision: 7, skillIds: ["alpha"], setIds: ["base"] };
  const draft = skillDraft(catalog, selection);
  expect(draft.selected.map(entry => entry.id)).toEqual(["alpha", "gamma"]);
  expect(draft.problems).toEqual([]);
  expect(skillDraft(catalog, { ...selection, skillIds: ["beta"] }).problems).toHaveLength(1);
  const duplicateName = { ...catalog, skills: [entry("alpha"), { ...entry("gamma"), name: "alpha" }] };
  expect(skillDraft(duplicateName, selection).problems).toHaveLength(1);
});

test("catalog replacement or disappearance cannot silently rebase optional choices", () => {
  const choice = { mode: "select" as const, expectedCatalogRevision: 7, skillIds: ["alpha"], setIds: ["base"] };
  expect(skillDraft({ ...catalog, revision: 8 }, choice).problems).toHaveLength(1);
  expect(skillDraft({ ...catalog, skills: [], sets: [] }, choice).problems).toHaveLength(2);
  expect(skillDraft(null, choice).problems).toHaveLength(1);
  expect(skillDraft(null, undefined)).toEqual({ selected: [], problems: [] });
  expect(skillDraft(null, { mode: "disabled" })).toEqual({ selected: [], problems: [] });
});

test("set expansion respects the fifteen optional-input boundary without double-counting direct members", () => {
  const skills = Array.from({ length: 16 }, (_, index) => entry(`skill-${index}`));
  const choice = { mode: "select" as const, expectedCatalogRevision: 7, skillIds: [skills[0]!.id], setIds: ["all"] };
  const within = { ...catalog, skills, sets: [{ id: "all", title: "All", skillIds: skills.slice(0, 15).map(entry => entry.id) }] };
  expect(skillDraft(within, choice).problems).toEqual([]);
  expect(skillDraft({ ...within, sets: [{ id: "all", title: "All", skillIds: skills.map(entry => entry.id) }] }, choice).problems).toHaveLength(1);
});
