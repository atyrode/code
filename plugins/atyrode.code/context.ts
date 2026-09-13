import { createHash } from "node:crypto";
import type { GuestCtx } from "@manifold/plugin-kit/server";
import { canonicalJobJson } from "@manifold/protocol";

export type CodeContext = Pick<GuestCtx, "services" | "now" | "storage" | "auth" | "outsideScope" | "emit">;
export class CodeRefusal extends Error {
  constructor(readonly code: string) { super(`code_${code}`); }
}
export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJobJson(value)).digest("hex");
}
