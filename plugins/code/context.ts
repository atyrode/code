import { createHash } from "node:crypto";
import type { GuestCtx } from "@manifold/plugin-kit/server";
import { canonicalJobJson } from "@manifold/protocol";

export type CodeContext = Pick<GuestCtx, "services" | "now" | "storage" | "auth" | "outsideScope" | "emit" | "actions">;
/** `detail` names what a refusal is about when its code alone cannot, as `RefusalSchema` allows. */
export class CodeRefusal extends Error {
  constructor(readonly code: string, readonly detail?: string) { super(detail === undefined ? `code_${code}` : `code_${code}: ${detail}`); }
}
export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJobJson(value)).digest("hex");
}
