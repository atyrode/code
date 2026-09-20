import { z } from "zod";
import { ServicePolicySchema, type ServiceOperationPolicy, type ServicePolicy } from "@manifold/protocol";
import { ClassifierSchema } from "./contract.ts";

export interface CodeServicesInput {
  classifier: z.infer<typeof ClassifierSchema> | null;
}
const inputSchema = z.strictObject({ classifier: ClassifierSchema.nullable() });
const stringInput = (maxBytes: number): ServiceOperationPolicy["input"][string] =>
  ({ type: "string", required: true, maxBytes });

/** Code owns only the external suggestion classifier; OMP owns its native services. */
export function buildCodeServices(input: CodeServicesInput): ServicePolicy[] {
  const { classifier } = inputSchema.parse(input);
  if (!classifier) return [];
  // buildSuggestionRequest truncates task text to 600 code points before encoding.
  // These UTF-8 bounds include the fixed instructions and JSON escaping.
  const classify: ServiceOperationPolicy = {
    method: "POST", path: "/api/chat", input: { system: stringInput(2048), prompt: stringInput(8192) }, query: {},
    body: [{ path: ["model"], value: { literal: classifier.model } },
      { path: ["stream"], value: { literal: false } },
      { path: ["messages", 0, "role"], value: { literal: "system" } },
      { path: ["messages", 0, "content"], value: { input: "system" } },
      { path: ["messages", 1, "role"], value: { literal: "user" } },
      { path: ["messages", 1, "content"], value: { input: "prompt" } }],
    invocable: true, timeoutMs: 300_000, maxRequestBytes: 32 * 1024,
    maxResponseBytes: 96 * 1024, maxResultBytes: 96 * 1024,
    response: { kind: "projected-json", fields: [["message", "role"], ["message", "content"], ["done"], ["model"]], maxArrayItems: 1024 },
  };
  return [ServicePolicySchema.parse({ serviceId: "suggest", revision: "1", origin: classifier.origin,
    allowLoopbackHttp: true, maxConcurrent: 4, operations: { classify } })];
}
