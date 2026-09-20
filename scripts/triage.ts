#!/usr/bin/env bun
// Tracker metadata is evidence for dispatch, never implementation authority.
import { readFileSync } from "node:fs";

interface Comment {
  body: string;
  user: { login: string } | null;
}
interface Issue {
  number: number;
  title: string;
  body: string | null;
  created_at: string;
  labels: { name: string }[];
  pull_request?: unknown;
  comments: number;
}
interface Pull {
  number: number;
  title: string;
  body: string | null;
  draft: boolean;
}
interface Label {
  name: string;
  color: string;
  description: string | null;
}
interface Snapshot {
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  comments: Record<string, Comment[]>;
}

const args = process.argv.slice(2);
if (args.length !== 1 || !["--report", "--next"].includes(args[0]!)) {
  console.error("usage: bun scripts/triage.ts --report|--next");
  process.exit(2);
}

async function pages<T>(path: string): Promise<T[]> {
  const child = Bun.spawn(["gh", "api", "--paginate", "--slurp", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0)
    throw new Error(`GitHub read failed (${status}): ${error.trim()}`);
  return (JSON.parse(text) as T[][]).flat();
}

async function snapshot(): Promise<Snapshot> {
  const base = "repos/atyrode/code";
  const [items, pulls, labels] = await Promise.all([
    pages<Issue>(`${base}/issues?state=open&per_page=100`),
    pages<Pull>(`${base}/pulls?state=open&per_page=100`),
    pages<Label>(`${base}/labels?per_page=100`),
  ]);
  const issues = items.filter((issue) => !issue.pull_request);
  const comments: Record<string, Comment[]> = {};
  for (const issue of issues) {
    comments[issue.number] = issue.comments
      ? await pages<Comment>(
          `${base}/issues/${issue.number}/comments?per_page=100`,
        )
      : [];
  }
  return { issues, pulls, labels, comments };
}

const data = await snapshot();
const inventory = JSON.parse(
  readFileSync(new URL("../.github/labels.json", import.meta.url), "utf8"),
) as Label[];
const states = ["needs-triage", "agent-ready", "needs-operator", "blocked"];
const violations: string[] = [];
const labelDrift: string[] = [];
const counts = Object.fromEntries(states.map((state) => [state, 0]));
const ready: Issue[] = [];
const reference =
  /(?:^|[^\w/])(?:[\w.-]+\/[\w.-]+)?#\d+\b|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+\b/;

for (const wanted of inventory) {
  const actual = data.labels.find((label) => label.name === wanted.name);
  if (!actual) {
    violations.push(`labels: ${wanted.name} is missing`);
  } else if (
    actual.color.toLowerCase() !== wanted.color.toLowerCase() ||
    actual.description !== wanted.description
  ) {
    labelDrift.push(`labels: ${wanted.name} differs from .github/labels.json`);
  }
}
for (const issue of data.issues) {
  const names = issue.labels.map((label) => label.name);
  const state = states.filter((name) => names.includes(name));
  const priorities = names.filter((name) => /^p[0-3]$/.test(name));
  const comments = data.comments[issue.number] ?? [];
  const fail = (message: string) =>
    violations.push(`#${issue.number}: ${message}`);
  for (const name of state) counts[name]!++;
  if (!names.includes("tracking") && state.length !== 1)
    fail("requires exactly one state");
  if (priorities.length > 1) fail("has multiple priorities");
  if (names.includes("blocked") && !reference.test(issue.body ?? ""))
    fail("blocked without a linked issue/PR in its body");
  if (
    names.includes("needs-operator") &&
    ![issue.body ?? "", ...comments.map((comment) => comment.body)].some(
      (text) => {
        const block = text.match(
          /^## Decision\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m,
        )?.[1];
        return (
          block &&
          ["Question:", "Options:", "Recommended:", "Unblocks:"].every(
            (field) => block.includes(field),
          )
        );
      },
    )
  )
    fail("operator hold needs a complete Decision block");
  if (!names.includes("agent-ready")) continue;
  if (priorities.length !== 1) fail("ready work requires one priority");
  if (
    !names.some((name) => ["documentation", "process"].includes(name)) &&
    !names.some((name) =>
      inventory.some(
        (label) => label.name.startsWith("area:") && label.name === name,
      ),
    )
  )
    fail("ready work requires an area");
  const claims = new Set<string>();
  for (const comment of comments) {
    const author = comment.user?.login;
    if (/^Claim:/m.test(comment.body)) claims.add(author ?? "unknown claimant");
    if (author && /^Release:/m.test(comment.body)) claims.delete(author);
  }
  const mentioned = new RegExp(
    `(?:^|[^\\w/])#${issue.number}\\b|https://github\\.com/atyrode/code/issues/${issue.number}\\b|atyrode/code#${issue.number}\\b`,
  );
  if (
    !claims.size &&
    !data.pulls.some((pull) => mentioned.test(pull.body ?? ""))
  )
    ready.push(issue);
}

console.log(
  `Open issues: ${data.issues.length}; open PRs: ${data.pulls.length}`,
);
console.log(
  Object.entries(counts)
    .map(([name, count]) => `${name}: ${count}`)
    .join("; "),
);
for (const violation of violations) console.log(`FAIL ${violation}`);
for (const drift of labelDrift) console.log(`LABEL ${drift}`);
if (args[0] === "--next") {
  const pending = data.pulls.filter((pull) => !pull.draft);
  if (pending.length)
    console.log(
      `Reconcile non-draft PRs before dispatch: ${pending.map((pull) => `#${pull.number}`).join(", ")}`,
    );
  else if (violations.length)
    console.log("Repair policy violations before dispatch.");
  else {
    const priority = (issue: Issue) =>
      issue.labels.find((label) => /^p[0-3]$/.test(label.name))!.name;
    ready.sort(
      (a, b) =>
        priority(a).localeCompare(priority(b)) ||
        a.created_at.localeCompare(b.created_at) ||
        a.number - b.number,
    );
    for (const issue of ready)
      console.log(`${priority(issue)} #${issue.number} ${issue.title}`);
    if (!ready.length)
      console.log(
        "No unclaimed ready issues. Inspect holds, claims and operational follow-through.",
      );
  }
  if (pending.length) process.exitCode = 1;
}
if (violations.length || (args[0] === "--report" && labelDrift.length))
  process.exitCode = 1;
