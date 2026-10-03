import { describe, expect, test } from "bun:test";
import { failureWords } from "../code/workflow.ts";

/** A door refused through the real host, as the browser's dispatch reports it (machine-web.ts `codeWorkflow`). */
const refused = (door: string, denial: string) => `${door}: ${denial}. No approval or readiness is assumed.`;

describe("a failure is said in words, never as a refusal token", () => {
  test("a refusal reported under its door reads exactly as the bare token does", () => {
    expect(failureWords(refused("atyrode.code.composeProbe", "code_account_unavailable"))).toBe(failureWords("code_account_unavailable"));
    expect(failureWords(refused("atyrode.omp.resumeSession", "omp_session_unavailable"))).toBe(failureWords("omp_session_unavailable"));
  });

  test("an unknown token, with or without its door, or with a detail after it, never shows the token or the door", () => {
    for (const message of [refused("atyrode.code.select", "code_something_new"), refused("atyrode.omp.startInventory", "omp_something_new: the probe quota"),
      "code_something_new", "code_verification_changed; job job-1 was not cancelled: timeout"]) {
      expect(failureWords(message)).not.toMatch(/\b(?:code|omp)_[a-z_]+|atyrode\./);
    }
    // A detail written for a person stays: a job left running is a fact to keep.
    expect(failureWords("code_verification_changed; job job-1 was not cancelled: timeout")).toMatch(/job job-1 was not cancelled/i);
  });

  test("a sentence the panel wrote itself is kept as it is", () => {
    expect(failureWords("Nothing was opened: the destination changed.")).toBe("Nothing was opened: the destination changed.");
  });
});
