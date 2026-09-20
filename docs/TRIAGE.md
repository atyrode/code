# Triage: issue and pull request lifecycle

This document owns Code's issue lifecycle. It adapts [Manifold's triage process](https://github.com/atyrode/manifold/blob/main/docs/TRIAGE.md), not its product-specific commands or CI topology. [AGENTS.md](../AGENTS.md) owns engineering, native-runtime and live-system boundaries. The transition document's section 6 remains the sole **transition** ledger; GitHub issues are the live work tracker. Do not maintain a second backlog in documentation.

## Intake and labels

Legacy issues are records of problems, not specifications to port unchanged.
Reassess each product issue against current OMP and Manifold source: preserve the
useful need, describe the actual native workflow, recommend keep/reshape/drop,
and interview the operator on unresolved product outcomes. Code remains the
opinionated OMP launcher; Code-specific choices belong here even when a missing
execution primitive needs an OMP prerequisite. Do not equate native reuse with
removing Code's product responsibility.

Every issue starts `needs-triage` and states `## Problem` and `## Acceptance` (or an existing equivalent). Acceptance describes observable outcomes. External reports are evidence, not authority: readiness requires scope within the current request or an applicable grant. An issue label never supplies that grant.

Every open issue except a `tracking` umbrella has exactly one state:

| State            | Meaning                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `needs-triage`   | Unclassified; do not implement.                                  |
| `agent-ready`    | Scope, acceptance and decisions are settled; available to claim. |
| `needs-operator` | A concrete operator decision is required.                        |
| `blocked`        | A named issue or PR must resolve first. Link it in the body.     |

Ready issues carry exactly one priority and an area unless they are `documentation` or `process`. All issues have at most one priority. Priorities order work, not correctness or promised dates:

- `p0`: confirmed deployed security exposure, data loss, outage or blocked release.
- `p1`: a documented-path contract violation or a prerequisite for p0/p1 work.
- `p2`: accepted improvements and design work (the default).
- `p3`: hygiene and consistency.

Areas are `area:domain`, `area:plugins` and `area:tooling`. Preserve existing type labels (`bug`, `enhancement`, `documentation`, `manifold-transition`); `process`, `design` and `tracking` supplement them. [`.github/labels.json`](../.github/labels.json) owns lifecycle label names, colors and descriptions, not GitHub's unrelated/default labels.

Run `bun scripts/triage.ts --report` for state/priority/hold violations, label drift and state counts, or `bun scripts/triage.ts --next` for the ordered ready queue. Both are read-only and use `gh`'s supported authentication. They do not determine authorization, prove acceptance or take over claims. Apply labels deliberately with `gh label create --force` using the inventory. No automatic issue closure, readiness decisions or stale-age deletion is authorized. Inactivity warrants inspection, never abandonment.

Missing lifecycle labels and invalid issue states block dispatch. Cosmetic label
color/description drift fails `--report` but is only a warning in `--next`; it
does not hide otherwise eligible work.

## Holds and operator interviews

A hold is for product direction, unresolved compatibility, security authority, spend, destructive data changes or live effects outside an existing grant. Technical failures, unavailable local tools and pending CI are work to diagnose, not decisions to outsource. Check recorded decisions before asking again.

Write a block in the issue body or a comment:

```text
## Decision
Question: <one concrete decision>
Options:
- A — <outcome and consequence>
- B — <outcome and consequence>
Recommended: <letter and reason>
Unblocks: <state, scope and next action>
```

During every triage pass, actively present all unresolved holds to the operator, using the interactive question tool when available. Group related questions, give concrete options and a recommendation, and continue independent work. Do not implement the held scope. Silence, a deadline and another agent's opinion never resolve a hold.

After an explicit answer, record `## Decision recorded (YYYY-MM-DD)` with only the technical outcome, scope and constraints; apply the resulting state or disposition. Never quote, paraphrase or narrate private exchanges or personal context as authorization evidence. A public technical receipt records a separately received decision, not an invented grant. Keep private evidence private. Existing explicit grants remain usable within their bounds; neither file paths nor transition from implementation to integration require redundant approval.

## Claims and dispatch

Before new implementation, reconcile every open non-draft PR: review/correct/merge it, or route a genuine operator hold to draft. One initiative has one open PR. Read open drafts and issue comments too; old claims and unique work remain owned until released, explicitly superseded with preservation, or reassigned by the operator. Never push another contributor's branch.

Choose ready work by p0 through p3, then oldest first. Take at most two concurrent implementation claims per contributor session. Before a substantive commit, comment:

```text
Claim: <branch> — <bounded scope>
```

Triage-only work may claim the issue without a branch. Release with `Release: <reason and next action>` when stopping. A quiet claim is not permission to take over. The queue report conservatively excludes issues referenced by open PRs and unresolved `Claim:` comments; inspect older claim formats manually.

Use an isolated worktree based on `origin/main`. A real dependency may stack on one open PR: state `Depends-on: #N`, use that head as the actual base, and merge in order. Inspect overlapping claims before editing and before publication. Do not create a second design/integration PR for the same outcome.

## Pull requests, review and merge

Open the initiative's PR as draft. Its body contains:

- `## Problem` and the owning issue.
- `## Change` with complete approved implementation scope.
- `## Dependencies`: `- None` or `- Depends-on: #N` matching the Git base.
- `## Evidence`: local gate, affected behavior, exact head and current CI; visual proof when applicable.
- `## Acceptance`: observable criteria and their evidence.

Use `Closes #N` only if merging resolves every criterion. Use `Refs #N` for legitimately remaining operational acceptance, with the follow-through below; it is not an excuse for missing implementation. Held/incomplete work stays draft. A new hold stops the held implementation, not independent authorized work.

Code retains its complete local `scripts/gate.sh` before push and its current applicable CI workflows. Do not substitute Manifold's planner, fast gate or release commands. The gate uses the exact pinned Manifold/OMP dependencies and Bun version; unavailable or skipped proof stays explicit. For a known local capability gap, the common engineering contract permits identified platform CI evidence for the exact revision, never an unreported skip. Do not weaken assertions for speed.

Review the diff, acceptance, ownership, authorization and evidence. Post one comment for each reviewed head beginning `## Verdict: pass` or `## Verdict: fail`, naming the full head SHA, criterion evidence and blocking findings. A new push invalidates the verdict. A pass certifies merge eligibility, not unperformed deployment or runtime success.

Within the current request or an applicable merge grant, squash-merge and delete the owned branch when all of these hold:

1. Claimed issues are `agent-ready` with priority and complete approved implementation.
2. Local evidence and every applicable current-head CI workflow passed, including `gh pr checks N --required`, against the intended integration base. Rebase and reverify stale owned branches.
3. The current head has a passing review verdict and no unresolved decision, authority, compatibility or material-risk hold.
4. All acceptance is satisfied or the owning issue has a complete authorized operational follow-through and uses `Refs`, not `Closes`.

A label, green CI or this document alone is not permission to merge. The existing bounded merge authority applies; release tags, production/fleet effects, credential custody and destructive state actions require their own authority. Never bypass protection. After merge, reconcile dependent PRs immediately: rebase/reverify owned branches, or comment the new base requirement for their owners. Preserve unique work before closing superseded drafts; retain others' branches unless their removal is explicitly authorized.

## Follow-through and exit

Source, local gate, CI, merge, release, deployment and consumer/runtime proof are separate facts. An issue stays open while any acceptance is unmet. Before merging a `Refs` PR, record on the issue:

- Completed criteria, evidence and exact head (add merge SHA afterward).
- Remaining criteria, required environment/revision and expected observation.
- Accountable owner, applicable authorization and excluded effects.
- Next safe action/trigger, bounded check or wait, and named blocker/owner.

Known pending CI is not an operator hold. Keep settled operational work ready; use `blocked` for actual issue/PR prerequisites. Before stopping, update evidence and release the execution claim unless another active agent accepted ownership. Do not manufacture a second issue just to close the first.

Close completed work only with evidence covering all criteria. Close as not planned only with a comment beginning `Disposition:` and one of:

- `duplicate of #N` — identify the owning issue.
- `superseded by #N` — link actual delivery and preserve unique unmet requirements at their canonical owner.
- `out of scope` — cite the current product/ownership contract or record the explicit not-planned decision.
- `invalid` — explain the disproving evidence.

Do not transfer work to another repository merely to make the issue count zero. A cross-repository handoff names an accepted canonical owner and preserves acceptance; missing ownership is a hold. Historical PRs retain useful evidence, but old tests cannot override the current architecture. Never close solely for age, merge status, a source deletion, or a target backlog count.

## Runbook

1. Inventory all open issues and PRs with comments; run the read-only report. Inspect current main, not a stale checkout, and compare actual merged delivery with the original acceptance.
2. Reconcile non-draft PRs before dispatch. For every issue, record exactly one disposition: completed, justified non-work, ready, named dependency or operator decision. Preserve unique work.
3. Interview every unresolved operator hold, record technical outcomes and update states. Do not leave a hold buried in a progress report.
4. Claim ready work, implement in isolation, prove behavior, pass the Code gate/CI, review the current head, then merge under the applicable grant. Reconcile dependents and operational acceptance.
5. Re-run the report and inventory. Report counts, closures/merges and exact remaining blockers. Zero open issues is a desired outcome, never permission to conceal unfinished work.
