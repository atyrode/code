import { describe, expect, test } from "bun:test";
import { ServiceInputSchema, type ServiceOperationPolicy } from "@manifold/protocol";
import { buildCodeServices } from "../atyrode.code/service-policies.ts";

const classifier = { origin: "http://127.0.0.1:11434", model: "qwen3:8b" };

describe("Code external classifier authority", () => {
  test("classifier fixes model and nonstreaming envelope instead of accepting caller transport controls", () => {
    const policy = buildCodeServices({ classifier })[0]!;
    const classify = policy.operations.classify as ServiceOperationPolicy;
    expect([classify.method, classify.path]).toEqual(["POST", "/api/chat"]);
    expect(Object.keys(classify.input).sort()).toEqual(["prompt", "system"]);
    expect(classify.input.prompt).toEqual({ type: "string", required: true, maxBytes: 8192 });
    expect(classify.body).toContainEqual({ path: ["model"], value: { literal: "qwen3:8b" } });
    expect(classify.body).toContainEqual({ path: ["stream"], value: { literal: false } });
    expect(classify.body).toContainEqual({ path: ["messages", 1, "content"], value: { input: "prompt" } });
    if (classify.response.kind !== "projected-json") throw new Error("Classifier response must remain projected");
    expect(classify.response.fields.map(path => path.join(".")).sort()).toEqual(["done", "message.content", "message.role", "model"]);
    expect(policy.runtime).toBeUndefined();
    expect(buildCodeServices({ classifier: null })).toEqual([]);
  });

  test("native classifier boundary refuses credential-bearing origins, insecure remote HTTP and unbounded input", () => {
    expect(() => buildCodeServices({ classifier: { ...classifier, origin: "https://user:secret@classifier.example" } })).toThrow();
    expect(() => buildCodeServices({ classifier: { ...classifier, origin: "http://classifier.example" } })).toThrow();
    expect(() => buildCodeServices({ classifier: { ...classifier, model: "m".repeat(513) } })).toThrow();
    expect(ServiceInputSchema.safeParse({ system: "Size the task", prompt: "界".repeat(22_000) }).success).toBe(false);
  });
});
