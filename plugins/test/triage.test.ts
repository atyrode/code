import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory: string;
const script = new URL("../../scripts/triage.ts", import.meta.url).pathname;
const labels = await Bun.file(
  new URL("../../.github/labels.json", import.meta.url),
).json();

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "code-triage-test-"));
  const gh = join(directory, "gh");
  await Bun.write(
    gh,
    `#!${process.execPath}\nconst data = JSON.parse(process.env.TRIAGE_FIXTURE);\nconst path = process.argv.at(-1);\nconst comment = path.match(/issues\\/(\\d+)\\/comments/);\nconst result = comment ? data.comments[comment[1]] ?? [] : path.includes('/labels?') ? data.labels : path.includes('/pulls?') ? data.pulls : data.issues;\nconsole.log(JSON.stringify([result]));\n`,
  );
  await chmod(gh, 0o700);
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

interface IssueFixture {
  number: number;
  title: string;
  body: string;
  created_at: string;
  labels: { name: string }[];
  comments: number;
}
const issue = (number: number, names: string[], body = ""): IssueFixture => ({
  number,
  title: `Work ${number}`,
  body,
  created_at: "2026-01-01T00:00:00Z",
  labels: names.map((name) => ({ name })),
  comments: 1,
});
async function run(
  issues: IssueFixture[],
  options: {
    comments?: Record<string, { body: string; user: { login: string } }[]>;
    pulls?: { number: number; body: string; draft: boolean }[];
  } = {},
) {
  const child = Bun.spawn([process.execPath, script, "--next"], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      TRIAGE_FIXTURE: JSON.stringify({
        issues,
        labels,
        comments: options.comments ?? {},
        pulls: options.pulls ?? [],
      }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(error).toBe("");
  return { output, status };
}

test("dispatch refuses invalid readiness and incomplete operator decisions", async () => {
  const result = await run([
    issue(1, ["agent-ready", "p1", "p2"]),
    issue(2, ["needs-operator"], "## Decision\nQuestion: What now?"),
    issue(3, ["blocked"], "Wait for something"),
  ]);
  expect(result.status).toBe(1);
  expect(result.output).toContain("#1: ready work requires one priority");
  expect(result.output).toContain("#1: ready work requires an area");
  expect(result.output).toContain(
    "#2: operator hold needs a complete Decision block",
  );
  expect(result.output).toContain("#3: blocked without a linked issue/PR");
  expect(result.output).toContain("Repair policy violations before dispatch.");
});

test("another claimant's release cannot reopen owned work", async () => {
  const ready = issue(1, ["agent-ready", "p2", "process"]);
  const comments = [
    { body: "Claim: docs/one — scoped work", user: { login: "first" } },
    { body: "Release: other work", user: { login: "second" } },
  ];
  const held = await run([ready], { comments: { 1: comments } });
  expect(held.status).toBe(0);
  expect(held.output).not.toContain("p2 #1 Work 1");
  comments.push({
    body: "Release: ready for another contributor",
    user: { login: "first" },
  });
  const released = await run([ready], { comments: { 1: comments } });
  expect(released.output).toContain("p2 #1 Work 1");
});

test("dispatch drains ready PRs and respects draft claims without foreign issue collisions", async () => {
  const issues = [
    issue(1, ["agent-ready", "p2", "process"]),
    issue(2, ["agent-ready", "p1", "process"]),
  ];
  const pending = await run(issues, {
    pulls: [{ number: 30, body: "Refs #1", draft: false }],
  });
  expect(pending.status).toBe(1);
  expect(pending.output).toContain(
    "Reconcile non-draft PRs before dispatch: #30",
  );
  const draft = await run(issues, {
    pulls: [{ number: 30, body: "Refs #1; refs atyrode/babel#2", draft: true }],
  });
  expect(draft.status).toBe(0);
  expect(draft.output).not.toContain("p2 #1 Work 1");
  expect(draft.output).toContain("p1 #2 Work 2");
});

test("complete holds and named dependencies stay out of the priority ordered ready queue", async () => {
  const result = await run([
    issue(1, ["agent-ready", "p3", "area:domain"]),
    issue(
      2,
      ["needs-operator"],
      "## Decision\nQuestion: Retain?\nOptions:\n- A — Yes\n- B — No\nRecommended: A\nUnblocks: ready work\n\n## Context\nOther details",
    ),
    issue(
      3,
      ["blocked"],
      "Depends on https://github.com/atyrode/manifold-omp/issues/1",
    ),
    issue(4, ["agent-ready", "p1", "documentation"]),
  ]);
  expect(result.status).toBe(0);
  expect(result.output).not.toContain("FAIL");
  expect(result.output.indexOf("p1 #4 Work 4")).toBeLessThan(
    result.output.indexOf("p3 #1 Work 1"),
  );
});
