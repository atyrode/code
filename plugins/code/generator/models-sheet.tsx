import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref } from "react";
import type { HostServices } from "@manifold/plugin";
import type { MachineSummary } from "@manifold/protocol";
import { prefersReducedMotion } from "@manifold/ui";
import { compileCatalog } from "../../domain/catalog.ts";
import { CatalogDocumentSchema, type CatalogDocument } from "../../domain/contracts.ts";
import type { Exclusion } from "../../domain/probe.ts";
import { orderedFamilies, providerPolicy } from "../../domain/providers.ts";
import type { Configuration } from "../contract.ts";
import { canWriteCodeWorkspace, codeOperationFailure, codeWorkflow } from "../machine-web.ts";
import { accountWord, familyWord, hueOf, since, useMinuteTick } from "../ui.tsx";
import { WorkflowError, type CodeCall } from "../workflow.ts";
import { editHoldsCatalogWrite, type CatalogWrite, type GateRefusal } from "./launch-step.ts";
import { Blocks, pressesGo, SheetCue, SheetGo, SheetHead, SheetKeys, SheetReadout, sheetKeyFree, useReadout, useSheetMode,
  type GoAction, type GoFix, type GoHandle, type GoPress, type GoTone, type Said } from "./sheet-frame.tsx";
import { contextWords, exclusionWords, listChanges, modelRows, modelsPhase, money, saveFailure, speedLevel, thinkingRange, TIERS,
  type ListChange, type ModelRow, type SavePress } from "./sheets-model.ts";
import { sameTeam } from "./statement-model.ts";
import { CHECKING_HOLD_MS } from "./verification.ts";
import type { WorkbenchModel } from "./workbench-model.ts";

/*
 * Models: the list as the generator uses it, one ladder per provider (fast, normal, smart, elite),
 * each rung's model in its provider's hue with its measured speed as five blocks; beside it what the
 * step is about (the charge while verifying, a staged list's changes, what verification left out);
 * and one next action where the launch sits. The verification is the workbench's own
 * (model-verification.ts), so its gate, hold and charge rules hold here as in the launch line;
 * staging, promotion and discarding are exact, revision-checked writes.
 */

/** Generator-panel class prefix; styles.css, "the Models and Setup sheets". */
const G = "plugin-atyrode_code_generator__";
/** How long a fired action shows its check before the sheet goes elsewhere. */
const FIRED_LEAVE_MS = 400;

export type ModelsSheetProps = {
  host: HostServices;
  model: WorkbenchModel;
  machine: MachineSummary | null;
  onBack: () => void;
  backRef: Ref<HTMLButtonElement>;
  /** Where a fix sends the person: Setup, or the accounts view. */
  onPlace: (place: "setup" | "accounts") => void;
};
type Primary = GoAction & { readonly said: Said; readonly press: GoPress };
type Part = readonly [string, GoTone | null];

const hue = (family: string) => `var(--code-${hueOf(family)})`;
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A pasted or dropped list, if it is a Code model list that compiles; null otherwise. */
function parseList(text: string): CatalogDocument | null {
  try {
    const document = CatalogDocumentSchema.parse(JSON.parse(text));
    if (document.models.length === 0) return null;
    compileCatalog(document);
    return document;
  } catch { return null; }
}

export function ModelsSheet({ host, model, machine, onBack, backRef, onPlace }: ModelsSheetProps) {
  const root = useRef<HTMLElement>(null);
  const go = useRef<GoHandle>(null);
  const mode = useSheetMode(root);
  useMinuteTick();
  const { record, verification } = model;
  const active = record?.active ?? null, draft = record?.draft ?? null;
  const where = machine?.name ?? "this machine";

  // ------------------------------------------------------------ the lists: in use, and staged beside it
  // In use: the active list, else the bundled starter the generator previews. A staged list with nothing in use is all additions.
  const inUseDocument = active?.document ?? (draft ? null : model.document);
  const inUse = useMemo(() => inUseDocument ? modelRows(inUseDocument) : [], [inUseDocument]);
  const staged = useMemo(() => draft ? modelRows(draft.document) : null, [draft]);
  const changes = useMemo(() => staged ? listChanges(inUse, staged) : [], [inUse, staged]);
  const verifyGate = model.gate("verify");
  const phase = modelsPhase({ run: verification.phase, step: verification.progress?.step ?? null, staged: draft !== null,
    status: verification.status, verifyRefusal: verifyGate.open ? null : verifyGate.refusal.code });
  const running = verification.phase !== null;
  const shownDocument = phase === "staged" ? draft!.document : inUseDocument;
  const shown = phase === "staged" ? staged! : inUse;
  const compiled = useMemo(() => {
    if (!shownDocument) return null;
    try { return compileCatalog(shownDocument); } catch { return null; }
  }, [shownDocument]);
  const families = useMemo(() => orderedFamilies(shown.map(row => row.family)), [shown]);
  const at = (family: string, tier: number) => shown.find(row => row.family === family && row.tier === tier) ?? null;
  const progress = verification.progress?.providers ?? [];
  const owed = new Set(phase === "benchmark" ? progress.filter(entry => entry.done < entry.total).map(entry => entry.provider) : []);
  const changed = (row: ModelRow): ListChange[] => phase === "staged" ? changes.filter(change => change.row.key === row.key) : [];

  // ------------------------------------------------------------ the sheet's own writes: exact, revision-checked, one at a time
  const [working, setWorking] = useState<CatalogWrite | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const latestHost = useRef(host);
  latestHost.current = host;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const edits = model.gate("edit-team");
  const writeRefusal = !model.writable ? "Edit access needed." : !model.configurationCurrent ? "The workspace profile needs a fresh read."
    : running ? "A verification is running." : working ? "Wait for the change in progress." : !edits.open ? edits.refusal.text : null;
  // An unsaved edit made on the list a write would replace holds that write until it is saved or discarded (launch-step.ts
  // `editHoldsCatalogWrite`), saying what the write does to that list and what each fix does with the edit. A list put in
  // use starts from its own default team (state.ts `catalogReview`), so a saved edit stays with the list in use. Only an
  // edit of the team in use saves, through the workbench's own save gate.
  const savable = model.gate("save").open;
  const madeOn = model.localDraft?.source === "active" ? "the list in use" : model.localDraft?.source === "draft" ? "the staged list" : "the bundled starter";
  const editHold = (kind: CatalogWrite): string | null => {
    if (!editHoldsCatalogWrite(model.localDraft, model.edited, kind)) return null;
    const effect = kind === "use" ? `using ${model.localDraft?.source === "draft" ? "it" : "the staged list"} starts from its own default team`
      : kind === "discard" ? "discarding drops that list" : "an import replaces that list";
    return `Your unsaved edit is on ${madeOn}, and ${effect}. ${savable ? "Save keeps the edit on the list in use; discard edit drops it." : "Discard edit drops the edit."}`;
  };
  // A save pressed here is said here, its own failure only (sheets-model.ts `saveFailure`).
  const [savePress, setSavePress] = useState<SavePress | null>(null);
  const failedSave = saveFailure(savePress, model.localDraft, model.message);
  const editFixes: readonly GoFix[] = [
    ...savable ? [{ label: "save", run: () => { setSavePress({ draft: model.localDraft, before: model.message }); void model.actions.save(); } }] : [],
    { label: "discard edit", run: () => model.actions.discardChanges() }];
  /**
   * Runs one press's writes against the workspace this sheet was opened on, from the revision it was read at; anything that
   * moves it stops them. The main view follows each receipt as this panel's own change from the revision that write was made
   * at (workbench-model.ts `catalogWritten`), an import's initialization included when its stage is then refused.
   */
  async function write(kind: CatalogWrite, work: (code: CodeCall, wrote: (from: number, written: Configuration) => void) => Promise<Said>,
    failed: (text: string) => void) {
    if (pending.current) return;
    const started = host;
    const valid = () => mounted.current && latestHost.current.client === started.client && latestHost.current.principal.id === started.principal.id &&
      latestHost.current.containerId === started.containerId && canWriteCodeWorkspace(latestHost.current);
    const wrote = (from: number, written: Configuration) => { if (valid()) model.actions.catalogWritten(from, written); };
    pending.current = true; setWorking(kind); setFailure(null); model.actions.writingCatalog(true);
    try {
      const said = await work(codeWorkflow(host, valid).code, wrote);
      if (valid()) readout.say(said);
    } catch (reason) {
      if (valid()) failed(codeOperationFailure(reason));
    } finally {
      pending.current = false;
      model.actions.writingCatalog(false);
      if (mounted.current) { setWorking(null); model.actions.refresh(); }
    }
  }
  function useStaged() {
    if (!record || !draft) return;
    const { containerId, revision } = record, digest = draft.digest, verified = draft.provenance !== null, saved = record.selection;
    void write("use", async (code, wrote) => {
      const review = await code("reviewCatalog", { containerId, expectedRevision: revision, source: "draft" });
      if (review.catalogDigest !== digest) throw new WorkflowError("code_preview_changed");
      const promoted = await code("promoteCatalog", { containerId, expectedRevision: revision, source: "draft", reviewDigest: review.reviewDigest });
      wrote(revision, promoted);
      // The staged list goes in use with its own default team; a saved team it does not repeat is said to be gone.
      const reset = saved !== null && promoted.selection !== null && !sameTeam(promoted.selection, saved);
      return { value: "in use", text: ["the staged list replaced the one in use", ...reset ? ["the profile is its default team now"] : [], ...verified ? [] : ["verify it next"]].join("; ") };
    }, setFailure);
  }
  function discard() {
    if (!record || !draft || writeRefusal || editHold("discard")) return;
    const { containerId, revision } = record;
    void write("discard", async (code, wrote) => {
      const discarded = await code("discardCatalog", { containerId, expectedRevision: revision });
      wrote(revision, discarded);
      return { value: "discarded", text: "the list in use is unchanged" };
    }, setFailure);
  }

  // ------------------------------------------------------------ import and export: two quiet actions in the head
  const dialog = useRef<HTMLDialogElement>(null);
  const [paste, setPaste] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const imported = useMemo(() => paste.trim() ? parseList(paste) : null, [paste]);
  const importRefusal = writeRefusal;
  // Import opens over an edit it would replace; the dialog says so and offers to discard the edit.
  const stageHold = writeRefusal ? null : editHold("stage");
  // An import over a staged list replaces it, a verified one with its verification.
  const importEffect = !draft ? "It is staged beside the list in use; nothing changes until you use it."
    : `It replaces the ${draft.provenance ? "verified " : ""}staged list; ${active ? "the list in use changes only when you use it." : "nothing is in use until you use it."}`;
  const exportRefusal = running ? "A verification is running." : !(active?.document ?? inUseDocument) ? "There is no list to export." : null;
  function openImport() {
    setPaste(""); setImportError(null);
    dialog.current?.showModal();
  }
  function stageImport() {
    const document = imported;
    if (!document) return;
    const refusal = writeRefusal ?? stageHold;
    if (refusal) { setImportError(refusal); return; }
    const base = record, containerId = host.containerId!, absentAt = model.observed?.revision ?? 0;
    const replacing = base?.draft ?? null;
    const added = listChanges(inUse, modelRows(document)).length;
    void write("stage", async (code, wrote) => {
      // A workspace without Code choices gets them first, at the revision it was read at; nothing is verified. The main view
      // follows that initialization at once, so a stage refused after it never reads as a change made elsewhere.
      const initialized = base ?? await code("initializeConfiguration", { containerId, expectedRevision: absentAt });
      if (!base) wrote(absentAt, initialized);
      const staged = await code("stageCatalog", { containerId, expectedRevision: initialized.revision, document });
      wrote(initialized.revision, staged);
      dialog.current?.close();
      const beside = `${count(added, "change")} beside the list in use`;
      return { value: "staged", text: replacing ? `${beside}; it replaced the ${replacing.provenance ? "verified " : ""}list staged before` : beside };
    }, setImportError);
  }
  async function exportList() {
    const document = active?.document ?? inUseDocument;
    if (!document) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(document, null, 2));
      readout.say({ value: "exported", text: "the list in use is on the clipboard" });
    } catch {
      readout.say({ value: "export", text: "the clipboard refused; nothing was copied", warn: true });
    }
  }

  // ------------------------------------------------------------ the one next action
  // The checking hold a verification keeps before its charge can be confirmed, drawn from the Verify press.
  const [hold, setHold] = useState(false);
  const wasPhase = useRef(phase);
  useEffect(() => {
    const was = wasPhase.current;
    wasPhase.current = phase;
    if (phase !== "inventory" || was === "inventory") return;
    setHold(true);
    const timer = window.setTimeout(() => setHold(false), CHECKING_HOLD_MS);
    return () => { window.clearTimeout(timer); setHold(false); };
  }, [phase]);
  const leave = (to: () => void) => { window.setTimeout(to, prefersReducedMotion() ? 0 : FIRED_LEAVE_MS); };
  const cancel: GoFix = { label: "cancel", run: () => verification.cancel() };
  const refused: readonly Part[] = failure ? [["not changed", "attention"]] : [];
  const charged = verification.charge?.requests ?? 0;
  const measured = progress.reduce((sum, entry) => sum + entry.done, 0), measuring = progress.reduce((sum, entry) => sum + entry.total, 0) || charged;
  const busy = (): string => "A verification is running; cancel stops it.";
  function verifyRefused(refusal: GateRefusal): Primary {
    const setup: GoFix = { label: "open setup", run: () => onPlace("setup") };
    const accounts: GoFix = { label: "show accounts", run: () => onPlace("accounts") };
    const retry: GoFix = { label: "retry", run: () => model.actions.refresh() };
    const code = refusal.code;
    const [text, fixes]: [string, GoFix[]] = model.ompMissing && (code === "verify-status" || code === "verify-permissions") ? [`OMP isn't on ${where}`, [setup]]
      : code === "read-only" ? ["Read-only workspace", []]
      : code === "unavailable" ? [!machine ? "No machine chosen" : machine.online ? `${machine.name} is unavailable` : `${machine.name} is offline`, [setup]]
      : code === "accounts" ? ["Accounts unreadable", [accounts]]
      : code === "no-accounts" ? ["No account is included", [accounts]]
      : code === "verify-status" ? [`Verification readiness unknown on ${where}`, [retry]]
      : code === "configuration" ? ["The workspace profile needs a fresh read", [retry]]
      : code === "conflict" ? ["The workspace profile changed elsewhere", [{ label: "use theirs", run: () => model.actions.discardChanges() }]]
      : [refusal.text.replace(/\.$/, ""), []];
    return { label: "verify models", disabled: true, parts: [[text, "attention"]], fixes,
      said: { value: "verify models", text: refusal.text, warn: true }, press: () => refusal.text };
  }
  function primary(): Primary {
    switch (phase) {
      case "inventory": return { label: "checking models…", busy: true, parts: [[`on ${where}`, null]], fixes: [cancel],
        said: { value: "checking models", text: "OMP reads the models your accounts reach; nothing is spent" }, press: busy };
      case "charge": {
        const charge = verification.charge;
        return { label: "confirm charge", disabled: !verification.canConfirm, parts: [[count(charged, "tiny request"), "strong"], ["nothing spent yet", null]], fixes: [cancel],
          said: { value: "confirm charge", text: `${count(charged, "request")}, one per model your accounts offer; measures speed, then puts the list in use` },
          press: detail => {
            const gate = model.gate("confirm");
            if (!charge || !gate.open) return gate.open ? "Nothing to confirm yet." : gate.refusal.text;
            // Only a deliberate single press spends (verification.ts `confirmsCharge`): never the second click of a double click.
            if (detail > 1) return "A double press confirms nothing; press once.";
            model.actions.confirmCharge({ detail, repeat: false }, charge);
            return null;
          } };
      }
      case "benchmark": return { label: "verifying…", busy: true, parts: [["measuring models", null], [`${measured} of ${measuring}`, "strong"]], fixes: [cancel],
        said: { value: "verifying", text: "cancel stops the probe; what it measured so far stays in OMP's history" }, press: busy };
      case "finishing": return { label: "verifying…", busy: true, parts: [["putting the model list in use", null]], fixes: [],
        said: { value: "verifying", text: "saving the verified list and the profile" }, press: () => "The verified list is being saved." };
      case "staged": {
        // An unsaved edit made on the list this replaces holds it, with what lifts the hold beside it.
        const held = writeRefusal ? null : editHold("use");
        if (held) return { label: "use staged list", disabled: true, parts: [[failedSave ? "not saved" : "unsaved profile edit", "attention"]], fixes: editFixes,
          said: { value: "use staged list", text: failedSave ?? held, warn: true }, press: () => held };
        return { label: "use staged list", busy: working !== null, disabled: writeRefusal !== null,
          parts: [...refused, [count(changes.length, "change"), "strong"], ["staged", null]], fixes: writeRefusal ? [] : [{ label: "discard", run: discard }],
          said: failure ? { value: "use staged list", text: failure, warn: true } : writeRefusal ? { value: "use staged list", text: writeRefusal, warn: true }
            : { value: "use staged list", text: draft?.provenance ? "replaces the list in use with this verified one" : "replaces the list in use; it needs verifying after" },
          press: () => { if (writeRefusal) return writeRefusal; useStaged(); return null; } };
      }
      case "verified":
        // The head already says when the list was verified; beside the action, only its alternative: verifying again, through
        // the same gate as a first verification, whose charge still waits on its own confirmation.
        return { label: "back to code", parts: refused, fixes: verifyGate.open ? [{ label: "verify again", run: () => model.actions.verify() }] : [],
          said: failure ? { value: "back to code", text: failure, warn: true } : { value: "back to code", text: "the generator routes on this list" },
          press: () => { leave(onBack); return null; } };
      case "refused": return { label: "enable in setup", parts: [["Discovery is not enabled", "attention"], ["verifying needs it", null]], fixes: [],
        said: { value: "enable in setup", text: `Setup turns on model discovery for ${where}` }, press: () => { leave(() => onPlace("setup")); return null; } };
      case "unverified": {
        if (!verifyGate.open) return verifyRefused(verifyGate.refusal);
        const stopped = verification.failure;
        const note: readonly Part[] = stopped ? [[stopped.cancelled ? "verification cancelled" : "verification stopped", stopped.cancelled ? null : "attention"]] : [];
        const tail: Part = verification.status === "accounts-changed" ? ["accounts changed", "warn"] : verification.status === "omp-changed" ? ["OMP changed", "warn"] : ["unverified", "warn"];
        return { label: "verify models", parts: [...note, ...refused, tail], fixes: [],
          said: stopped && !stopped.cancelled ? { value: "verify models", text: stopped.reason, warn: true }
            : { value: "verify models", text: "finds the models your accounts reach and measures them; nothing is spent before you confirm" },
          press: () => { model.actions.verify(); return null; } };
      }
    }
  }
  const next = primary();

  // ------------------------------------------------------------ beside the list: what the step is about
  // The charge per provider, in the list's family order (GPT, Claude, DeepSeek), as its columns are.
  const perProvider = (verification.charge?.providers ?? []).map(({ provider, requests }) => {
    const answered = progress.find(entry => entry.provider === provider);
    return { provider, family: providerPolicy(provider).family, total: requests, done: phase === "charge" ? 0 : answered?.done ?? 0 };
  });
  const familyOrder = orderedFamilies(perProvider.map(entry => entry.family));
  const chargeRows = [...perProvider].sort((left, right) => familyOrder.indexOf(left.family) - familyOrder.indexOf(right.family));
  const notProbed: readonly Exclusion[] = verification.charge?.exclusions ?? [];
  const outs: readonly Exclusion[] = phase === "charge" || phase === "benchmark" || phase === "finishing" ? notProbed
    : phase === "verified" ? verification.exclusions ?? [] : [];
  const side = phase === "charge" ? "charge" : phase === "benchmark" || phase === "finishing" ? "measuring"
    : phase === "staged" ? "staged changes" : phase === "verified" && outs.length > 0 ? "left out" : null;

  // ------------------------------------------------------------ the readout: what each pointed or focused thing says
  function describe(id: string): Said | null {
    if (id === "go") return next.said;
    const [kind, ...rest] = id.split(":");
    if (kind === "cell") {
      const [family, tierText] = rest as [string, string];
      const tier = Number(tierText), row = at(family, tier), tierWord = TIERS[tier - 1]!;
      if (!row) {
        let lands: string | null = null;
        try { lands = compiled ? compiled.model(compiled.rung(family, tier)).key : null; } catch { lands = null; }
        const alias = lands ? shown.find(candidate => candidate.key === lands)?.alias ?? null : null;
        return { value: `${tierWord} ${familyWord(family)}`, text: `No ${tierWord} ${familyWord(family)} model in the list${alias ? ` · the model row lands on ${alias}` : ""}`, warn: true };
      }
      const rowChanges = changed(row);
      if (rowChanges.length) return { value: row.alias, color: "var(--tui-acc)",
        text: `${rowChanges.map(change => `${change.field} ${change.from ?? "—"} → ${change.to ?? "—"}`).join(" · ")} · staged` };
      const speed = row.tps === null ? owed.has(row.provider) ? "measuring…" : "unmeasured · verifying measures it"
        : `${Math.round(row.tps)} tok/s${row.ttft === null ? "" : ` · first token ${(row.ttft / 1000).toFixed(1)} s`}`;
      return { value: row.alias, color: hue(row.family),
        text: `${row.provider}/${row.id} · ${speed} · ${money(row.pin)} in, ${money(row.pout)} out per M · ${contextWords(row.ctx)} · ${thinkingRange(row.levels)}` };
    }
    if (kind === "out") {
      const exclusion = outs.find(entry => `${entry.provider}/${entry.id}` === rest.join(":"));
      return exclusion ? { value: exclusion.id, text: exclusionWords(exclusion)[1], color: "var(--tui-mid)" } : null;
    }
    if (kind === "provider") {
      const entry = chargeRows.find(candidate => candidate.provider === rest[0]);
      if (!entry) return null;
      const family = hueOf(entry.family);
      return { value: accountWord(entry.family), color: `var(--code-${family})`, text: phase === "charge"
        ? `${count(entry.total, "tiny request")}, one per model these accounts offer` : `${entry.done} of ${entry.total} measured` };
    }
    return null;
  }
  const readout = useReadout(describe);

  // ------------------------------------------------------------ cells lit as they change: a list put in use, a verification finished
  const signature = useMemo(() => JSON.stringify(shown.map(row => [row.family, row.tier, row.key, row.tps === null])), [shown]);
  const previous = useRef<{ signature: string; rows: readonly ModelRow[] } | null>(null);
  const [lit, setLit] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const before = previous.current;
    previous.current = { signature, rows: shown };
    if (!before || before.signature === signature) return;
    const key = (row: ModelRow) => `${row.key}:${row.tps === null}`;
    const was = new Map(before.rows.map(row => [`${row.family}:${row.tier}`, key(row)]));
    setLit(new Set(shown.filter(row => was.get(`${row.family}:${row.tier}`) !== key(row)).map(row => `${row.family}:${row.tier}`)));
    const timer = window.setTimeout(() => setLit(new Set()), 1_200);
    return () => window.clearTimeout(timer);
  }, [signature]);

  // ------------------------------------------------------------ keys: arrows over the list, ⏎ the action, esc cancels a run, i and x
  const [cursor, setCursor] = useState<string | null>(null);
  const cells = families.flatMap(family => [1, 2, 3, 4].map(tier => `${family}:${tier}`));
  const focusAt = cursor !== null && cells.includes(cursor) ? cursor : cells[0] ?? null;
  function move(from: HTMLElement, dx: number, dy: number) {
    let f = families.indexOf(from.dataset.family!), t = Number(from.dataset.tier);
    if (mode === "wide") { f += dx; t += dy; }
    else {
      // A ladder after another: past a ladder's last rung is the next ladder's first.
      t += dy + dx;
      if (t < 1 && f > 0) { f -= 1; t = 4; } else if (t > 4 && f < families.length - 1) { f += 1; t = 1; }
    }
    f = Math.max(0, Math.min(families.length - 1, f));
    t = Math.max(1, Math.min(4, t));
    const id = `${families[f]}:${t}`;
    setCursor(id);
    root.current?.querySelector<HTMLElement>(`[data-cell="${id}"]`)?.focus();
  }
  function keys(event: KeyboardEvent<HTMLElement>) {
    if (!sheetKeyFree(event)) return;
    const target = event.target as HTMLElement;
    if (event.key.startsWith("Arrow")) {
      const cell = target.closest<HTMLElement>("[data-cell]");
      if (!cell) return;
      event.preventDefault();
      move(cell, event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0, event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0);
      return;
    }
    if (pressesGo(event)) { event.preventDefault(); go.current?.press(); return; }
    // Esc stops a run that can still be stopped; otherwise it goes back to Code (web.tsx).
    if (event.key === "Escape" && running && phase !== "finishing") { event.preventDefault(); verification.cancel(); return; }
    if (event.key === "i") { event.preventDefault(); if (importRefusal) readout.say({ value: "import", text: importRefusal, warn: true }); else openImport(); return; }
    if (event.key === "x") { event.preventDefault(); if (exportRefusal) readout.say({ value: "export", text: exportRefusal, warn: true }); else void exportList(); }
  }

  // ------------------------------------------------------------ the sheet
  const verifiedAt = verification.provenance?.benchmarkCompletedAt ?? null;
  const [tail, tone]: Part = running ? ["verifying", null] : phase === "staged" ? [active ? "staged list beside it" : "staged, none in use", "warn"]
    : verification.status === "current" && verifiedAt !== null ? [`verified ${since(Date.now() - verifiedAt)}`, null]
    : verification.status === "accounts-changed" ? ["accounts changed since verified", "warn"]
    : verification.status === "omp-changed" ? ["OMP changed since verified", "warn"]
    : !active ? ["starter · unverified", "warn"] : ["unverified", "warn"];
  function cell(family: string, tier: number) {
    const row = at(family, tier), id = `${family}:${tier}`, tierWord = TIERS[tier - 1]!;
    const bound = readout.bind(`cell:${id}`);
    const common = { "data-cell": id, "data-family": family, "data-tier": tier, role: "gridcell", tabIndex: id === focusAt ? 0 : -1,
      style: { "--h": hue(family) } as CSSProperties, ...bound, onFocus: () => { setCursor(id); bound.onFocus(); } };
    if (!row) return <span key={id} className={`${G}models-cell`} data-empty="" aria-label={`${familyWord(family)} ${tierWord}: none`} {...common}>
      <span className={`${G}models-alias`}>—</span>
    </span>;
    const level = speedLevel(row.tps);
    return <span key={id} className={`${G}models-cell`} data-key={row.key} data-unmeasured={level === 0 || undefined} data-probing={owed.has(row.provider) || undefined}
      data-changed={changed(row).length > 0 || undefined} data-lit={lit.has(id) || undefined}
      aria-label={`${row.alias}, ${tierWord} ${familyWord(family)}, ${level ? `speed ${level} of 5` : "unmeasured"}`} {...common}>
      <span className={`${G}models-alias`}>{row.alias}</span>
      <span className={`${G}models-speed`} aria-hidden="true">{[0, 1, 2, 3, 4].map(index =>
        <i key={index} data-on={index < level || undefined} style={{ "--d": `${index * 40}ms` } as CSSProperties} />)}</span>
    </span>;
  }
  const list = families.length === 0 ? <p className={`${G}models-none`}>no model list</p>
    : mode === "wide" ? <div className={`${G}models-matrix`} role="grid" aria-label="model list" style={{ "--cols": families.length } as CSSProperties}>
      <div className={`${G}models-mrow`} data-top="" role="row">
        <span className={`${G}models-tier`} role="columnheader" />
        {families.map(family => <span key={family} className={`${G}models-prov`} role="columnheader" style={{ "--h": hue(family) } as CSSProperties}>{familyWord(family)}</span>)}
      </div>
      {TIERS.map((word, index) => <div key={word} className={`${G}models-mrow`} role="row">
        <span className={`${G}models-tier`} role="rowheader">{word}</span>
        {families.map(family => cell(family, index + 1))}
      </div>)}
    </div>
    : <div className={`${G}models-ladders`} role="grid" aria-label="model list">
      {families.map(family => <div key={family} className={`${G}models-ladder`} role="rowgroup">
        <div className={`${G}models-prov`} style={{ "--h": hue(family) } as CSSProperties}>{familyWord(family)}</div>
        {TIERS.map((word, index) => <div key={word} className={`${G}models-rung`} role="row">
          <span className={`${G}models-tier`} role="rowheader">{word}</span>
          {cell(family, index + 1)}
        </div>)}
      </div>)}
    </div>;
  const outList = (exclusions: readonly Exclusion[]) => <ul className={`${G}models-out`}>
    {exclusions.map(exclusion => {
      const [short, full] = exclusionWords(exclusion);
      const id = `${exclusion.provider}/${exclusion.id}`;
      return <li key={id}>
        <span className={`${G}models-xid`} tabIndex={0} aria-label={`${id}: ${full}`} {...readout.bind(`out:${id}`)}>{id}</span>
        <span className={`${G}models-why`}>{short}</span>
      </li>;
    })}
  </ul>;
  return <section ref={root} className={`${G}sheet`} data-sheet="models" data-phase={phase} data-mode={mode} data-solo={side === null || undefined}
    aria-label="Models" onKeyDown={keys}>
    <SheetHead title="models" onBack={onBack} backRef={backRef}
      state={<><b>{count(inUse.length || shown.length, "model")}</b> · <span data-tone={tone ?? undefined}>{tail}</span></>}
      acts={<>
        <SheetCue cue="import" keyName="i" label="import" refusal={importRefusal} onPress={openImport} readout={readout} />
        <SheetCue cue="export" keyName="x" label="export" refusal={exportRefusal} onPress={() => void exportList()} readout={readout} />
      </>} />
    <main className={`${G}sheet-stage`}>
      <section className={`${G}sheet-pane`} aria-label="model list">
        {list}
        <SheetReadout said={readout.said} />
        <SheetGo action={next} hold={hold} onPress={next.press} readout={readout} handle={go} />
      </section>
      {side && <section className={`${G}sheet-pane`} data-side={side} aria-label={side}>
        <h3 className={`${G}sheet-pane-title`}>{side}</h3>
        {(side === "charge" || side === "measuring") && <>
          <ul className={`${G}models-charge`}>{chargeRows.map(entry => <li key={entry.provider} style={{ "--h": hue(entry.family) } as CSSProperties}>
            <span className={`${G}models-pw`} tabIndex={0} {...readout.bind(`provider:${entry.provider}`)}
              aria-label={`${accountWord(entry.family)}: ${phase === "charge" ? count(entry.total, "request") : `${entry.done} of ${entry.total} measured`}`}>{accountWord(entry.family)}</span>
            <Blocks total={entry.total} done={entry.done} />
            <span className={`${G}models-n`}>{phase === "charge" ? entry.total : `${entry.done}/${entry.total}`}</span>
          </li>)}</ul>
          {notProbed.length > 0 && <><h4 className={`${G}sheet-sub`}>not probed</h4>{outList(notProbed)}</>}
        </>}
        {side === "staged changes" && <ul className={`${G}models-changes`}>{changes.map(change => <li key={`${change.row.key}:${change.field}`} style={{ "--h": hue(change.row.family) } as CSSProperties}>
          <span className={`${G}models-ca`}>{change.row.alias}</span>
          <span className={`${G}models-cf`}>{change.field}</span>
          <span className={`${G}models-cv`}>
            {change.from !== null && <span className={`${G}models-was`}>{change.from}</span>}
            {change.from !== null && change.to !== null && <span className={`${G}models-arrow`} aria-label="becomes">→</span>}
            {change.to !== null && <span className={`${G}models-now`}>{change.to}</span>}
          </span>
        </li>)}</ul>}
        {side === "left out" && outList(outs)}
      </section>}
    </main>
    <SheetKeys keys={[["↑↓←→", "move"], ["⏎", next.label.replace("…", "")], ["i", "import"], ["esc", running && phase !== "finishing" ? "cancel" : "code"]]} />
    <dialog ref={dialog} className={`${G}sheet-dialog`} aria-labelledby={`${G}import-title`} onClose={() => setPaste("")}>
      <h2 id={`${G}import-title`}>import a model list</h2>
      <p>Paste a Code model list, or drop its file here. {importEffect}</p>
      <textarea aria-label="model list JSON" spellCheck={false} value={paste} placeholder={'{ "schemaVersion": 1, "models": [ … ] }'}
        onChange={event => { setPaste(event.target.value); setImportError(null); }}
        onDragOver={event => event.preventDefault()}
        onDrop={event => {
          event.preventDefault();
          const file = event.dataTransfer.files[0];
          if (file) void file.text().then(text => { setPaste(text); setImportError(null); });
        }} />
      <p className={`${G}models-import-error`} role="status">{importError ?? (paste.trim() && !imported ? "not a Code model list" : stageHold ?? "")}</p>
      <div className={`${G}sheet-dialog-row`}>
        <button type="button" className={`${G}go`} data-stage="" aria-disabled={!imported || working !== null || stageHold !== null || undefined} aria-busy={working === "stage" || undefined}
          onClick={() => { if (imported && working === null) stageImport(); }}>
          <span className={`${G}go-label`}>stage</span>
        </button>
        {stageHold && <button type="button" className={`${G}go-fix`} onClick={() => { setImportError(null); model.actions.discardChanges(); }}>discard edit</button>}
        <button type="button" className={`${G}go-fix`} onClick={() => dialog.current?.close()}>cancel</button>
      </div>
    </dialog>
  </section>;
}
