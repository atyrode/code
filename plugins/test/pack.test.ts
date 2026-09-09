import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack } from "../pack.ts";

test("unchanged source preserves every installable bundle digest across private staging directories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "code-pack-test-"));
  try {
    const first = await pack(join(directory, "first"));
    const second = await pack(join(directory, "second"));
    expect(second.map(({ id, sha256 }) => ({ id, sha256 }))).toEqual(
      first.map(({ id, sha256 }) => ({ id, sha256 })),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
