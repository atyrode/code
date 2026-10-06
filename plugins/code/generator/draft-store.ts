import { z } from "zod";
import type { ModelCatalogSnapshot } from "@atyrode/manifold-omp";
import { SelectionSchema } from "../../domain/contracts.ts";
import { catalogFromMetadata } from "../../domain/probe.ts";
import { CODE_PLUGIN_ID, digest, revision, type Configuration } from "../contract.ts";
import type { ProfileDraft } from "./workbench-model.ts";

/*
 * The main view's unsaved team, kept per principal and workspace in this tab's session storage so
 * that a reload does not lose it. Like the recent teams it is device-local and grants nothing. It
 * keeps what the draft was made from, never the document itself: that is the record's catalog or
 * the bundled model list, named by its digest. A kept draft comes back only onto that same
 * document; the usual rules (launch-step.ts `draftStale`, `followRecord`) then decide whether it
 * still rests on the record or is a conflict.
 */

const StoredDraftSchema = z.strictObject({
  source: z.enum(["starter", "active", "draft"]),
  selection: SelectionSchema,
  revision,
  initialized: z.boolean(),
  catalogDigest: digest.nullable(),
  draftDigest: digest.nullable(),
  baseSelection: SelectionSchema.nullable(),
  metadataKey: z.string().nullable(),
});
export type StoredDraft = z.infer<typeof StoredDraftSchema>;
/** The part of `Storage` the kept draft uses; `sessionStorage` in the panel. */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function storedDraftKey(principalId: string, containerId: string): string {
  return `${CODE_PLUGIN_ID}.draft:${JSON.stringify([principalId, containerId])}`;
}

/** This tab's session storage, or null where it is absent or refused (private modes and sandboxed frames throw on access). */
export function browserDraftStorage(): DraftStorage | null {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

/** The kept draft. Unreadable storage, text that is not JSON and a malformed draft read as absent. */
export function readStoredDraft(storage: DraftStorage | null, key: string): StoredDraft | null {
  let text: string | null = null;
  try { text = storage?.getItem(key) ?? null; } catch { return null; }
  if (!text) return null;
  let stored: unknown;
  try { stored = JSON.parse(text); } catch { return null; }
  const parsed = StoredDraftSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** Keep a draft, or forget the kept one with null. */
export function storeDraft(storage: DraftStorage | null, key: string, draft: ProfileDraft | null): void {
  try {
    if (draft === null) { storage?.removeItem(key); return; }
    const kept: StoredDraft = { source: draft.source, selection: draft.selection, revision: draft.revision, initialized: draft.initialized,
      catalogDigest: draft.catalogDigest, draftDigest: draft.draftDigest, baseSelection: draft.baseSelection, metadataKey: draft.metadataKey };
    storage?.setItem(key, JSON.stringify(kept));
  } catch { /* A full or refused store keeps the draft in this page only. */ }
}

/**
 * A kept draft rebuilt on the document it was made on: the record's active or staged catalog with
 * the same digest, or, for a first-use draft, the same bundled model list derived for its budget.
 * Null when that document is gone, since a draft cannot be shown without it.
 */
export function restoreDraft(kept: StoredDraft, record: Configuration | null, metadata: ModelCatalogSnapshot | null, metadataKey: string | null): ProfileDraft | null {
  if (kept.source === "starter") {
    if (metadata === null || metadataKey === null || metadataKey !== kept.metadataKey) return null;
    try { return { ...kept, document: catalogFromMetadata(metadata, kept.selection.budget), metadata }; } catch { return null; }
  }
  const catalog = kept.source === "active" ? record?.active : record?.draft;
  const madeOn = kept.source === "active" ? kept.catalogDigest : kept.draftDigest;
  if (!catalog || catalog.digest !== madeOn) return null;
  return { ...kept, document: catalog.document, metadata: null };
}
