#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser as BrowserInstance } from "../../../manifold/scripts/cdp.ts";
import type { TestAgent, TestServer } from "../../../manifold/packages/testkit/src/index.ts";
import type * as CdpModule from "../../../manifold/scripts/cdp.ts";
import type * as GateDistModule from "../../../manifold/scripts/gate-dist.ts";
import type * as TestkitModule from "../../../manifold/packages/testkit/src/index.ts";
import type { TokenGrant } from "../../../manifold/packages/protocol/src/index.ts";
import type { ActionResult, Target } from "../code/contract.ts";
import type { CatalogDocument, Selection } from "../domain/contracts.ts";
import { compileCatalog } from "../domain/catalog.ts";
import { catalogFromMetadata, inventoryDraft } from "../domain/probe.ts";
import { reviewCatalog } from "../domain/routing.ts";
import { displayAliases } from "../code/generator/aliases.ts";
import { recentTeamsKey } from "../code/generator/recent-teams.ts";
import { teamWords } from "../code/generator/statement-model.ts";
import {
  BENCHMARK_OPERATION_ID, INVENTORY_OPERATION_ID, LAUNCH_OPERATION_ID, ModelCatalogSnapshotSchema, OMP_VERSION, ResumeSessionInputSchema,
  actionSchemas as ompActionSchemas, type InventoryReceipt, type ModelCatalogSnapshot, type ActionInput as OmpInput, type ActionResult as OmpResult,
} from "@atyrode/manifold-omp";
import type { PermissionPlan } from "../code/permission-plan.ts";
import { formatManifoldUri, PublicJobSchema, type MachineSummary, type PublicJob, type TerminalSummary } from "@manifold/protocol";

const HELP = `Usage: bun plugins/scripts/verify-browser.ts [bundle-directory]
Uses four prepacked Code bundles (default: plugins/dist) and three real upstream OMP bundles
(default: plugins/.integration/omp/plugins/dist; CODE_OMP_BUNDLES_DIR may explicitly override), never Code source.
MANIFOLD_DIR selects the pinned SDK checkout; default: the sibling manifold directory.
Requires installed SDK dependencies, setsid and Chromium (MANIFOLD_CHROMIUM may select its binary).
MANIFOLD_GATE_DIST may supply an existing SDK web build; otherwise gate-dist builds a
throwaway web bundle. Missing Chromium or any failed assertion is a failure, not a skip.
Starts only a disposable loopback server and an isolated testkit machine transport/terminal
host. No native job owner, native setup, terminals, OMP processes, inference or providers are invoked.
Every Chromium runs supervised in its own process group: success, failure, SIGINT/SIGTERM/SIGHUP
and the death of this process all end the whole browser and remove its profile.
Proves Code's main view (statement line, seat board, earlier statements, footer and sheets) in real
Chromium identities: render-only bundled-metadata starter composition, retained conflicted drafts,
permission choices, writer/viewer authority and container-shared choices across two destinations,
and the browser-provable acceptance of the main view: no horizontal overflow and no intersecting
text from 170 to 1440px, zero hover/focus layout shift, panel-local keys that never act from a
sheet, dialog or popover, arrival keys, the wheel rules, focus kept through the gate and reduced
motion. Also: an unsaved edit kept across a reload, own account edits that never conflict with it
while a foreign team write does, a save refused for a lead no account serves, a writer without a
canvas who saves but is told why launching waits, and saved sessions folded per folder into a
drum. Separate synthetic RPC responses exercise the verification charge, folder-only readiness,
and launch/resume review invalidation and refusal; the spend, preparation and execution they lead
to are refused, never native execution or consent success.
This is UI/authority proof, NOT provider or native execution/readiness proof.`;
if (process.argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}
if (process.argv.length > 3 || process.argv[2]?.startsWith("-")) throw new Error(HELP);

const pluginRoot = resolve(import.meta.dir, "..");
const manifold = resolve(process.env.MANIFOLD_DIR ?? join(pluginRoot, "../../manifold"));
const bundleDirectory = resolve(process.argv[2] ?? join(pluginRoot, "dist"));
const ompBundleDirectory = resolve(process.env.CODE_OMP_BUNDLES_DIR ?? join(pluginRoot, ".integration/omp/plugins/dist"));
const ompFamily = ["atyrode.omp", "atyrode.omp.accounts", "atyrode.omp.gateway"];
const family = ["atyrode.code", "atyrode.code.accounts", "atyrode.code.generator", "atyrode.code.usage"];
const panel = ".plugin-atyrode_code_accounts";
const accounts = `${panel} .plugin-atyrode_code__accounts`;
const profile = `${accounts} [aria-label="Active account pool"] select`;
const machineName = "Code browser fixture";
const secondName = "Code browser second destination";
const presetName = "Browser shared profile";
const timeout = 15_000;

// Static runtime imports cannot honor MANIFOLD_DIR: the checkout is runtime-selected.
// Type-only imports retain Code's sibling SDK convention without loading that checkout.
const { Browser } = await import(pathToFileURL(join(manifold, "scripts/cdp.ts")).href) as typeof CdpModule;
const { resolveWebDist } = await import(pathToFileURL(join(manifold, "scripts/gate-dist.ts")).href) as typeof GateDistModule;
const { callAction, createContainer, enrollMachine, mintToken, ownerAction, startAgent, startServer, waitFor } =
  await import(pathToFileURL(join(manifold, "packages/testkit/src/index.ts")).href) as typeof TestkitModule;
class ProofFailure extends Error {}

// ---------------------------------------------------------------- no browser outlives the run

/**
 * The SDK driver spawns Chromium as an ordinary child (cdp.ts `launch`) and ends it only from
 * `close`. A verifier that is interrupted, killed or crashes before `close` leaves the whole
 * browser tree running under the init process with its profile in /tmp. Every Chromium here
 * therefore starts through this supervisor, which the driver runs through its documented binary
 * choice (MANIFOLD_CHROMIUM). The supervisor first leaves the verifier's process group, so a
 * signal to that whole group cannot end it before it ends the browser. It runs Chromium as the
 * leader of a process group of its own and records that group and its profile. When the driver
 * closes it, when the verifier stops on a signal, when the verifier is gone or when Chromium
 * exits, it kills the whole browser group and removes the profile.
 */
function superviseChromium(directory: string, binary: string, setsid: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const record = join(directory, "browsers");
  const script = join(directory, "chromium");
  writeFileSync(script, `#!/bin/sh
if [ "\${CODE_VERIFY_SUPERVISOR:-}" != "$$" ]; then
  CODE_VERIFY_SUPERVISOR=$$
  export CODE_VERIFY_SUPERVISOR
  exec ${quote(setsid)} "$0" "$@"
fi
parent=$PPID
profile=
for argument in "$@"; do
  case $argument in --user-data-dir=*) profile=\${argument#--user-data-dir=} ;; esac
done
${quote(setsid)} ${quote(binary)} "$@" &
browser=$!
printf '%s %s\\n' "$browser" "$profile" >> ${quote(record)}
( while kill -0 "$parent" 2>/dev/null; do sleep 1; done; kill -s TERM $$ ) &
watcher=$!
status=0
finish() {
  trap '' HUP INT TERM
  kill -s KILL -- "-$browser" 2>/dev/null
  kill "$watcher" 2>/dev/null
  wait "$browser" 2>/dev/null
  [ -z "$profile" ] || rm -rf -- "$profile"
  exit "$status"
}
trap finish HUP INT TERM
wait "$browser"
status=$?
finish
`);
  chmodSync(script, 0o700);
  return script;
}
type SupervisedBrowser = { group: number; profile: string };
function supervisedBrowsers(record: string): SupervisedBrowser[] {
  if (!existsSync(record)) return [];
  return readFileSync(record, "utf8").split("\n").filter(Boolean).map(line => {
    const space = line.indexOf(" ");
    return { group: Number(line.slice(0, space)), profile: line.slice(space + 1) };
  });
}
function groupAlive(group: number): boolean {
  try { process.kill(-group, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
/** Kills every recorded browser group, removes its profile, and names whatever is still left. */
async function endBrowsers(record: string): Promise<string[]> {
  const left: string[] = [];
  const browsers = supervisedBrowsers(record);
  for (const { group } of browsers) {
    try { process.kill(-group, "SIGKILL"); } catch { /* The supervisor already ended it. */ }
  }
  for (const { group, profile } of browsers) {
    const deadline = Date.now() + 5_000;
    while (groupAlive(group) && Date.now() < deadline) await Bun.sleep(50);
    if (groupAlive(group)) left.push(`Chromium process group ${group}`);
    if (profile) {
      rmSync(profile, { recursive: true, force: true });
      if (existsSync(profile)) left.push(`Chromium profile ${profile}`);
    }
  }
  // A process that left its group would escape the group kill: find it by its profile and end it too.
  if (existsSync("/proc")) {
    const profiles = browsers.map(browser => browser.profile).filter(Boolean);
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      let command = "";
      try { command = readFileSync(`/proc/${entry}/cmdline`, "utf8"); } catch { continue; }
      if (!profiles.some(profile => command.includes(profile))) continue;
      try { process.kill(Number(entry), "SIGKILL"); } catch { continue; }
      left.push(`stray Chromium process ${entry}`);
    }
  }
  return left;
}

// ---------------------------------------------------------------- DOM access and real input

function element(selector: string): string {
  return `document.querySelector(${JSON.stringify(selector)})`;
}
function button(text: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(`${accounts} button`)})].find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
}
async function until(browser: BrowserInstance, description: string, expression: string): Promise<void> {
  try {
    await waitFor(() => browser.evaluate<boolean>(expression), timeout, 50);
  } catch {
    throw new ProofFailure(`Timed out: ${description}`);
  }
}
async function control(browser: BrowserInstance, description: string, expression: string, disabled: boolean): Promise<void> {
  await until(browser, description, `(() => {
    const el = ${expression};
    if (!(el instanceof HTMLElement) || el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && el.matches(':disabled') === ${disabled};
  })()`);
}
async function settle(browser: BrowserInstance): Promise<void> {
  await browser.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
}

type Point = { x: number; y: number };
// DOM evaluation only locates/scrolls the control. Activation is a real CDP pointer
// gesture (not HTMLElement.click(), dispatched DOM events, or a React handler call).
async function pointOf(browser: BrowserInstance, expression: string): Promise<Point> {
  return waitFor(async () => {
    const candidate = await browser.evaluate<Point | null>(`(async () => {
      const el = ${expression};
      if (!(el instanceof Element) || el.matches(':disabled')) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const frame = Promise.withResolvers();
      requestAnimationFrame(frame.resolve);
      await frame.promise;
      if (!el.isConnected || el.matches(':disabled')) return null;
      const rect = el.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return rect.width > 0 && rect.height > 0 && hit && el.contains(hit) ? { x, y } : null;
    })()`);
    if (!candidate) return undefined;
    await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...candidate });
    const stable = await browser.evaluate<boolean>(`(async () => {
      const frame = Promise.withResolvers();
      requestAnimationFrame(frame.resolve);
      await frame.promise;
      const el = ${expression};
      if (!(el instanceof Element) || el.matches(':disabled')) return false;
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(${candidate.x}, ${candidate.y});
      return rect.x + rect.width / 2 === ${candidate.x} && rect.y + rect.height / 2 === ${candidate.y} &&
        hit !== null && el.contains(hit);
    })()`);
    return stable ? candidate : undefined;
  }, timeout, 50);
}
async function press(browser: BrowserInstance, point: Point, clickCount = 1): Promise<void> {
  await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount });
  await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount });
}
async function click(browser: BrowserInstance, expression: string): Promise<void> {
  await press(browser, await pointOf(browser, expression));
}
const KEY_CODES: Readonly<Record<string, string>> = { "?": "Slash", " ": "Space", "1": "Digit1", r: "KeyR" };
async function key(browser: BrowserInstance, name: string, code: number, options: { modifiers?: number; autoRepeat?: boolean } = {}): Promise<void> {
  const modifiers = options.modifiers ?? 0;
  // Blink's native button activation needs Enter's character data, not only its key code.
  const text = name === "Enter" ? "\r" : name.length === 1 ? name : null;
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: KEY_CODES[name] ?? name, windowsVirtualKeyCode: code, modifiers,
    autoRepeat: options.autoRepeat ?? false, ...(text === null ? {} : { text, unmodifiedText: text }) });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: KEY_CODES[name] ?? name, windowsVirtualKeyCode: code, modifiers });
}
const CTRL = 2, SHIFT = 8;
async function wheel(browser: BrowserInstance, point: Point, deltaY: number): Promise<void> {
  await browser.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY });
}

// ---------------------------------------------------------------- the generator panel

const generator = ".plugin-atyrode_code_generator";
const G = "plugin-atyrode_code_generator__";
const mainView = `${generator} [data-view="main"]`;
const verb = element(`${generator} [data-stmt-verb]`);
const confirmCharge = element(`${generator} .${G}stmt-confirm`);
// The announcer is the panel's polite live region; other status roles (skills, notices) are not it.
const liveRegion = element(`${generator} div.plugin-atyrode_code__sr[role="status"][aria-live="polite"]`);
const statusText = `[...document.querySelectorAll(${JSON.stringify(`${generator} .${G}stmt-line`)})].map(line => line.textContent).join(' | ')`;
const visibleSheet = `[...document.querySelectorAll(${JSON.stringify(`${generator} .${G}sheet-host`)})].find(el => !el.hidden)`;
// Session options is a sheet like Accounts, Models and Setup, opened from its link in the footer's run.
const sessionOptions = footerLink("session options");
const skillsSection = element(`${generator} [aria-label="Optional skills"]`);
const keysDialog = element(`${generator} .${G}keys-dialog`);
const profileExport = element(`${generator} textarea[data-profile-export]`);
const board = element(`${generator} .${G}board`);
const starterProviders = ["anthropic", "deepseek", "openai-codex"];
const profileRoles = ["default", "task", "plan", "slow", "reviewer", "security-reviewer", "scout", "sonic", "vision", "smol", "tiny", "commit"];
type Word = "lane" | "tier" | "thinking" | "advisor" | "extras" | "machine";
const WORDS: readonly Word[] = ["lane", "tier", "thinking", "advisor", "extras", "machine"];
const READING_ORDER: readonly (Word | "verb")[] = ["verb", ...WORDS];

function slot(word: Word): string {
  return element(`${generator} [data-stmt-word="${word}"]`);
}
function wordValue(word: Word): string {
  return `${slot(word)}?.querySelector('.${G}stmt-value')?.textContent.trim()`;
}
/** The six words on the line, as one string: whatever a key or a press changed shows here. */
const lineWords = `[${WORDS.map(word => wordValue(word)).join(", ")}].join(' / ')`;
function option(word: Word, label: string): string {
  return `[...(${slot(word)}?.querySelectorAll('[role="option"]') ?? [])].find(el => el.querySelector('.${G}stmt-text')?.textContent.trim() === ${JSON.stringify(label)})`;
}
function statusFix(label: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(`${generator} .${G}stmt-fix`)})].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
}
/** The second status line names a failed model list, with what that means here, and offers the list's own retry and Models. */
function listFailureSaid(meaning: "no team can be formed without it" | "the seats are the team on the line"): string {
  return `!!document.querySelectorAll(${JSON.stringify(`${generator} .${G}stmt-line`)})[1]?.textContent.startsWith(${JSON.stringify(`Model list unavailable · ${meaning}`)}) && !!${statusFix("retry")} && !!${statusFix("Models")}`;
}
function footerLink(name: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(`${generator} .${G}footer-link`)})].find(el => el.textContent.trim().startsWith(${JSON.stringify(name)}))`;
}
/** A visible button in the generator panel, its sheets and its layer, by its exact text. */
function workspaceButton(text: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(`${generator} button`)})].find(el => el.getClientRects().length && el.textContent.trim() === ${JSON.stringify(text)})`;
}
function verbIs(label: string, state: "ready" | "busy" | "waiting" | "refused"): string {
  // Focus stays on the verb through state changes, so it is never natively disabled (spec §3).
  return `(${verb})?.textContent === ${JSON.stringify(label)} && ${verb}.dataset.state === '${state}' && !${verb}.disabled`;
}

/** The roles on the seat board: each role's seat (its model alias and id) and the thinking it runs at. */
type Seated = { role: string; alias: string; model: string; thinking: string };
async function seatedRoles(browser: BrowserInstance): Promise<Seated[]> {
  return browser.evaluate<Seated[]>(`[...document.querySelectorAll(${JSON.stringify(`${generator} .${G}board [role="group"]`)})].flatMap(seat => {
    const alias = seat.querySelector('.${G}seat-alias');
    if (!alias) return [];
    return [...seat.querySelectorAll('ul.${G}roles')].flatMap(list => [...list.querySelectorAll('li')].map(item => ({
      role: item.textContent.trim(), alias: alias.textContent.trim(), model: alias.title, thinking: list.dataset.level,
    })));
  }).sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : 0)`);
}
/** What the board must show for a selection: every routed role on its lead's seat at the lead's thinking. */
function expectedSeats(document: CatalogDocument, selection: Selection): Seated[] {
  const compiled = compileCatalog(document);
  const aliases = displayAliases(compiled);
  return reviewCatalog(compiled, selection, Date.now()).routes.map(route => ({
    role: route.role, alias: aliases.get(route.lead.key) ?? route.lead.key, model: compiled.model(route.lead.key).id, thinking: route.lead.thinking,
  })).sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : 0);
}
async function assertRoles(browser: BrowserInstance, advisor: boolean): Promise<void> {
  await until(browser, "the seat board seats the team", `${board}?.querySelector('ul.${G}roles li') != null`);
  const seated = await seatedRoles(browser);
  assert.deepEqual(seated.map(entry => entry.role).sort(), [...profileRoles, ...(advisor ? ["advisor"] : [])].sort(),
    "The full current role contract is seated, including delegated and utility roles");
  assert(seated.every(entry => entry.alias && entry.model && entry.thinking), "Every seated role names its model and supported effort");
}

/** Opens a word's drum and picks the option with this label; extras stay open for more switches. */
async function choose(browser: BrowserInstance, word: Word, label: string): Promise<void> {
  // Pressing the option already on the line does nothing and leaves the drum open, so a word already there is only closed.
  if (word !== "extras" && await browser.evaluate<boolean>(`${wordValue(word)} === ${JSON.stringify(label)}`)) {
    if (await browser.evaluate<boolean>(`${slot(word)}?.dataset.open === 'true'`)) {
      await click(browser, `${slot(word)}?.querySelector('.${G}stmt-value')`);
      await until(browser, `the ${word} drum closes`, `${slot(word)}?.dataset.open !== 'true'`);
    }
    return;
  }
  if (!await browser.evaluate<boolean>(`${slot(word)}?.dataset.open === 'true'`)) await click(browser, `${slot(word)}?.querySelector('.${G}stmt-value')`);
  await until(browser, `the ${word} drum opens`, `${slot(word)}?.dataset.open === 'true'`);
  await click(browser, option(word, label));
}
async function chooseMachine(browser: BrowserInstance, name: string): Promise<void> {
  await until(browser, "the line names a machine", `!!${wordValue("machine")}`);
  await choose(browser, "machine", name);
  await until(browser, `the line is on ${name}`, `${wordValue("machine")} === ${JSON.stringify(name)} && ${slot("machine")}?.dataset.open !== 'true'`);
}
/** Real Tab presses until the expression holds focus; Shift+Tab when `backward`. */
async function tabTo(browser: BrowserInstance, description: string, expression: string, backward = false): Promise<void> {
  for (let step = 0; step < 80; step++) {
    if (await browser.evaluate<boolean>(`(() => { const el = ${expression}; return !!el && document.activeElement === el; })()`)) return;
    await key(browser, "Tab", 9, { modifiers: backward ? SHIFT : 0 });
  }
  throw new ProofFailure(`Keyboard focus never reached ${description}`);
}
/**
 * Keyboard focus on a word or the verb, by real keys only: a press on the earlier statements'
 * heading sets the sequential focus point below the statement, Shift+Tab walks back to its first
 * stop there, and ←/→ walk the statement in reading order (locked words leave the Tab order).
 */
async function focusStatement(browser: BrowserInstance, target: Word | "verb"): Promise<void> {
  await click(browser, element(`${generator} .${G}earlier-title`));
  await tabTo(browser, "the statement", `(() => { const el = document.activeElement; return el?.matches('${generator} [data-stmt-verb], ${generator} [data-stmt-word]') ? el : null; })()`, true);
  for (let step = 0; step < READING_ORDER.length; step++) {
    const at = await browser.evaluate<string>(`document.activeElement?.dataset.stmtWord ?? (document.activeElement?.matches('[data-stmt-verb]') ? 'verb' : '')`);
    const from = READING_ORDER.indexOf(at as Word | "verb"), to = READING_ORDER.indexOf(target);
    if (from === to) break;
    await key(browser, from < to ? "ArrowRight" : "ArrowLeft", from < to ? 39 : 37);
  }
  await until(browser, `keyboard focus on ${target}`, `document.activeElement === ${target === "verb" ? verb : slot(target)} && document.activeElement.matches(':focus-visible')`);
}

/** The footer's ways out of the main view, by the link's own (lowercase) words. */
type SheetLink = "accounts" | "models" | "setup" | "session options";
async function openSheet(browser: BrowserInstance, name: SheetLink): Promise<void> {
  await click(browser, footerLink(name));
  await until(browser, `${name} opens over the main view`, `${element(mainView)}?.hidden === true && !!${visibleSheet}?.querySelector('[aria-label="Back to Code"]')`);
}
async function closeSheet(browser: BrowserInstance): Promise<void> {
  await click(browser, `${visibleSheet}?.querySelector('[aria-label="Back to Code"]')`);
  await until(browser, "the main view returns", `${element(mainView)}?.hidden === false`);
}
async function openOptions(browser: BrowserInstance): Promise<void> {
  if (!await browser.evaluate<boolean>(`!!${visibleSheet}?.contains(${skillsSection})`)) await openSheet(browser, "session options");
  await until(browser, "session options open", `!!${visibleSheet}?.contains(${skillsSection})`);
}
/** Esc from the control last used in the sheet closes it, and focus goes back to the link that opened it. */
async function closeOptions(browser: BrowserInstance): Promise<void> {
  assert.equal(await browser.evaluate(`!!${visibleSheet}?.contains(document.activeElement)`), true, "Session options keep focus while they are open");
  await key(browser, "Escape", 27);
  await until(browser, "Esc closes session options and gives focus back to their link", `${element(mainView)}?.hidden === false && document.activeElement === ${sessionOptions}`);
}
/** A session option's switch (a set, a skill, restricted automation or a tool), by its words. */
function optionSwitch(group: "Optional skills" | "Automation policy", label: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(`${generator} [aria-label="${group}"] [role="switch"]`)})].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
}
/** Turns a switch on or off by a real press, unless it already is. */
async function turn(browser: BrowserInstance, control: string, on: boolean): Promise<void> {
  if (await browser.evaluate<boolean>(`${control}?.getAttribute('aria-checked') !== '${on}'`)) await click(browser, control);
  await until(browser, `the switch turns ${on ? "on" : "off"}`, `${control}?.getAttribute('aria-checked') === '${on}'`);
}
/** Waits until the panel has read the record at `revision`, as Setup's profile details state it (opening a sheet reads again). */
async function panelReads(browser: BrowserInstance, revision: number): Promise<void> {
  await openSheet(browser, "setup");
  await until(browser, `the panel reads revision ${revision}`,
    `[...document.querySelectorAll('${generator} .${G}setup-facts dt')].find(el => el.textContent === 'Shared revision')?.nextElementSibling?.textContent === '${revision}'`);
  await closeSheet(browser);
}

type Configuration = NonNullable<ActionResult<"readConfiguration">["configuration"]>;
type ConfigurationRead = ActionResult<"readConfiguration">;
async function readConfiguration(server: TestServer, grant: TokenGrant, workspace: { containerId: string }): Promise<ConfigurationRead> {
  const outcome = await callAction(server, grant.token, "atyrode.code.readConfiguration", { containerId: workspace.containerId });
  assert(outcome.ok, "Code configuration must be readable with this identity");
  const result = outcome.result as ConfigurationRead;
  assert(result && Number.isSafeInteger(result.revision), "Code must return a configuration revision");
  assert(result.configuration === null || (result.configuration && Number.isSafeInteger(result.configuration.revision)), "Code must return an absent or versioned configuration");
  return result;
}

async function openWorkspace(
  browser: BrowserInstance,
  server: TestServer,
  grant: TokenGrant,
  containerId: string,
  afterLaunch?: () => Promise<void>,
): Promise<void> {
  await browser.launch({ incognito: true });
  await afterLaunch?.();
  await browser.goto(server.httpUrl);
  await until(browser, "fixture web document", "document.readyState === 'complete'");
  // A native minted identity in the normal storage shape, not an owner browser or a
  // replaced client. Chromium's off-the-record context keeps the token off disk.
  await browser.evaluate(`localStorage.setItem('manifold.identity', ${JSON.stringify(JSON.stringify({ token: grant.token, principal: grant.principal }))})`);
  // Both unscoped identities may arrange their PERSONAL space. Keep the real canvas
  // beside Code: its renderer publishes the authoring handle that exposed #154.
  const layout = {
    root: { id: "root", dir: "row", ratios: [1, 2, 3], children: ["sidebar", "container", "accounts"], ref: null },
    sidebar: { id: "sidebar", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "core.shell.sidebar" } },
    container: { id: "container", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "core.shell.container-view" } },
    accounts: { id: "accounts", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "atyrode.code.accounts.accounts" } },
  };
  const arranged = await callAction(server, grant.token, "core.space.setLayout", { layout });
  assert(arranged.ok, "Both unscoped identities must be able to set their own personal layout");
  await browser.goto(`${server.httpUrl}/p/${containerId}`);
  await until(browser, "ordinary canvas mounted alongside Code accounts", `document.querySelector('.react-flow') !== null && ${element(panel)} !== null`);
  await until(browser, "permitted online workspace machine selected", `(() => {
    const select = ${element(`${panel} .plugin-atyrode_code_accounts__target select`)};
    return select instanceof HTMLSelectElement && select.value !== '';
  })()`);
}

async function arrangeWorkbench(server: TestServer, grant: TokenGrant): Promise<void> {
  // The native canvas supplies the authoring handle; a standalone policy panel
  // is legitimately read-only even when its local controls can be explored.
  const arranged = await callAction(server, grant.token, "core.space.setLayout", { layout: {
    root: { id: "root", dir: "row", ratios: [1, 3], children: ["canvas", "workbench"], ref: null },
    canvas: { id: "canvas", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "core.shell.container-view" } },
    workbench: { id: "workbench", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "atyrode.code.generator.launcher" } },
  } });
  assert(arranged.ok);
}
async function openGenerator(browser: BrowserInstance, server: TestServer, containerId: string): Promise<void> {
  await browser.goto(`${server.httpUrl}/p/${containerId}`);
  await until(browser, "the Code main view is mounted", `${element(mainView)} !== null && ${verb} !== null`);
}
async function selectDestination(browser: BrowserInstance, selector: string, machineId: string): Promise<void> {
  await until(browser, "permitted destination is listed", `[...(${element(selector)}?.options ?? [])].some(option => option.value === ${JSON.stringify(machineId)})`);
  const index = await browser.evaluate<number>(`[...${element(selector)}.options].filter(option => !option.disabled).findIndex(option => option.value === ${JSON.stringify(machineId)})`);
  assert(index >= 0, "Requested destination must be permitted");
  await click(browser, element(selector));
  await key(browser, "Home", 36);
  for (let offset = 0; offset < index; offset++) await key(browser, "ArrowDown", 40);
  await key(browser, "Enter", 13);
  await until(browser, "destination choice applied", `${element(selector)}.value === ${JSON.stringify(machineId)}`);
}

// ---------------------------------------------------------------- observation and synthetic owners

type BrowserAction = { name: string; input: Record<string, unknown> };
async function watchActions(browser: BrowserInstance, server: TestServer): Promise<{ requests: BrowserAction[]; stop: () => void }> {
  const requests: BrowserAction[] = [];
  const prefix = `${server.httpUrl}/api/actions/`;
  const stop = browser.on("Network.requestWillBeSent", event => {
    const request = event.request as { url?: string; postData?: string } | undefined;
    if (request?.url?.startsWith(prefix)) requests.push({
      name: decodeURIComponent(request.url.slice(prefix.length)), input: JSON.parse(request.postData ?? "{}"),
    });
  });
  await browser.send("Network.enable", {});
  return { requests, stop };
}

function noNativeEffects(requests: BrowserAction[]): void {
  const effects = ["atyrode.code.suggest", "atyrode.code.runSession", "atyrode.code.configureServices",
    "atyrode.omp.startInventory", "atyrode.omp.startBenchmark", "atyrode.omp.reviewSession", "atyrode.omp.prepareSession",
    "atyrode.omp.resumeSession", "atyrode.omp.prepareWorkspace", "atyrode.omp.accounts.promoteAccountRuntime",
    "atyrode.omp.gateway.configureGateway", "engine.jobs.reviewDeployment", "engine.jobs.applyDeployment", "engine.jobs.execute",
    "core.terminals.create"];
  assert.deepEqual(requests.filter(request => effects.includes(request.name)), [],
    "Starter observation, edits and navigation never request classification, discovery, benchmark, consent or native execution");
}

type Outcome = { ok: true; result: unknown } | { ok: false; denial: { rule: string; message: string } };
type Answer = (name: string, input: Record<string, unknown>) => Outcome | undefined | Promise<Outcome | undefined>;
function refused(message: string): Outcome {
  return { ok: false, denial: { rule: "forbidden", message } };
}
/**
 * Answers this browser's action requests through `answer`; `undefined` lets the real server answer.
 * A fixture that throws refuses the request, so the page never hangs on it, and the first failure
 * is raised by `check`. `stop` releases nothing it does not own: release held requests first.
 */
async function intercept(browser: BrowserInstance, server: TestServer, answer: Answer): Promise<{ check: () => void; stop: () => Promise<void> }> {
  const pending = new Set<Promise<void>>();
  let failure: unknown;
  let active = true;
  const off = browser.on("Fetch.requestPaused", event => {
    if (!active) return;
    const work = (async () => {
      const requestId = event.requestId as string;
      const request = event.request as { url: string; postData?: string };
      const name = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!);
      let outcome: Outcome | undefined;
      try { outcome = await answer(name, JSON.parse(request.postData ?? "{}") as Record<string, unknown>); }
      catch (error) { failure ??= error; outcome = refused("synthetic_fixture_failure"); }
      if (outcome === undefined) await browser.send("Fetch.continueRequest", { requestId });
      else await browser.send("Fetch.fulfillRequest", { requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(outcome)).toString("base64") });
    })();
    pending.add(work);
    void work.catch(error => { failure ??= error; }).finally(() => pending.delete(work));
  });
  await browser.send("Fetch.enable", { patterns: [{ urlPattern: `${server.httpUrl}/api/actions/*`, requestStage: "Request" }] });
  return {
    check: () => { if (failure) throw failure; },
    stop: async () => {
      active = false;
      off();
      await Promise.allSettled([...pending]);
      await browser.send("Fetch.disable", {});
    },
  };
}
/** A request the fixture holds until released, to observe the panel while a step is in flight. */
function holdable() {
  let release: (() => void) | null = null;
  return {
    get held() { return release !== null; },
    wait: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      release = () => { release = null; resolve(); };
      return promise;
    },
    release: () => release?.(),
  };
}

/** A passive OMP account observation naming fictional anthropic slots; no credential or broker exists behind it. */
const fixtureScope = "browser-fixture-account-scope";
function fixtureAccounts(credentials: readonly number[] = [1, 7]): OmpResult<"accounts"> {
  return { scope: fixtureScope, status: "fresh", observedAt: Date.now() - 1_000, accounts: credentials.map(credentialId => ({
    reference: { kind: "credential", scope: fixtureScope, provider: "anthropic", credentialId }, credentialId,
    type: "api_key", identityKey: null, email: null, disabled: false, blocks: [],
  })) };
}
/** A passive OMP usage reading of the fixture's slots: a fresh 5-hour window for each, no provider behind it. */
function fixtureUsage(credentials: readonly number[]): OmpResult<"usage"> {
  const now = Date.now() - 1_000;
  return { accounts: fixtureAccounts(credentials), refreshStatus: "succeeded", snapshot: { scope: fixtureScope, observedAt: now, accounts: credentials.map(credentialId => ({
    provider: "anthropic", credentialId, identityKey: null, observedAt: now, status: "reported",
    windows: [{ windowId: "5h", tier: null, usedFraction: 0.2, quotaStatus: "ok", resetsAt: now + 3 * 3_600_000, durationMs: 5 * 3_600_000, observedAt: now }],
  })) } };
}
/** A settled synthetic OMP probe job, in the public job shape the native job owner answers. */
function probeJob(target: Target, jobId: string, operationId: string, requester: string): PublicJob {
  return PublicJobSchema.parse({ jobId, machineId: target.machineId, operationId, pluginId: "atyrode.omp",
    installationRevision: "synthetic-ui-only", artifactSha256: "c".repeat(64), inputDigest: "e".repeat(64),
    resourceBindingDigest: "d".repeat(64), state: "exited", nextInputSeq: null,
    result: { jobId, requestDigest: "f".repeat(64), ownerId: "synthetic-owner", ownerGeneration: 1, state: "exited", exitCode: 0, reason: null,
      startedAt: 1, finishedAt: 2, usage: null, outputs: [], limits: { timeoutMs: 600_000, memoryBytes: 1 << 30, processes: 64, outputBytes: 1 << 20 } },
    authority: { origin: { kind: "action", traceId: "synthetic-trace", door: "atyrode.omp.startInventory" }, requester, executor: null, decision: null } });
}

/** What the workbench exports for its render-only bundled preview. */
type StarterDraft = { baseRevision: number; metadata: ModelCatalogSnapshot; selection: Selection; document: CatalogDocument };
async function readStarterDraft(browser: BrowserInstance): Promise<StarterDraft> {
  // The export lives in Setup → Profile & source details; a visited sheet stays mounted while hidden.
  if (!await browser.evaluate<boolean>(`${profileExport} instanceof HTMLTextAreaElement`)) {
    await openSheet(browser, "setup");
    await closeSheet(browser);
  }
  await until(browser, "local starter material remains exportable", `${profileExport} instanceof HTMLTextAreaElement && !!${profileExport}.value`);
  return JSON.parse(await browser.evaluate<string>(`${profileExport}.value`)) as StarterDraft;
}
/**
 * A team this browser launched in the workspace before, as the panel keeps it (recent-teams.ts):
 * device-local, per principal and workspace, read when the panel mounts. It gives the digits a team
 * to recall without a launch, which the fixture refuses.
 */
async function rememberTeam(browser: BrowserInstance, principalId: string, containerId: string, selection: Selection): Promise<void> {
  await browser.evaluate(`localStorage.setItem(${JSON.stringify(recentTeamsKey(principalId, containerId))}, ${JSON.stringify(JSON.stringify([{ selection, launchedAt: Date.now() - 60_000 }]))})`);
}

async function usableStarter(browser: BrowserInstance): Promise<void> {
  await until(browser, "the bundled preview is on the line", `['lane','tier','thinking','advisor','extras','machine'].every(word =>
    document.querySelector('${generator} [data-stmt-word="' + word + '"]'))`);
  // A bundled preview is saved only by the verification that replaces it; the fixture reads no accounts and has no discovery, so that is refused.
  await until(browser, "the starter's only step is a refused verification", verbIs("Verify models", "refused"));
  for (const word of ["lane", "tier", "thinking", "advisor", "extras", "machine"] as const) {
    assert.equal(await browser.evaluate(`${slot(word)}.tabIndex === 0 && !${slot(word)}.hasAttribute('aria-disabled')`), true,
      `The ${word} word is editable before shared policy exists`);
  }
  // The default profile keeps the old Code advisor default (glance), so the advisor role is routed.
  await assertRoles(browser, true);
}

// ---------------------------------------------------------------- acceptance a browser can prove (spec §2, §3, §7, §8, §10)

/** Sizes the generator panel itself to `width` by resizing the viewport around the fixed layout. */
async function panelWidth(browser: BrowserInstance, width: number, height = 900): Promise<void> {
  let viewport = Math.round((width + 4) * 4 / 3);
  let previous: { viewport: number; actual: number } | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    await browser.send("Emulation.setDeviceMetricsOverride", { width: viewport, height, deviceScaleFactor: 1, mobile: false });
    await settle(browser);
    const actual = await browser.evaluate<number>(`${element(generator)}.getBoundingClientRect().width`);
    if (Math.abs(actual - width) <= 1) {
      await settle(browser);
      return;
    }
    const slope: number = previous && previous.viewport !== viewport ? (actual - previous.actual) / (viewport - previous.viewport) : 0.75;
    previous = { viewport, actual };
    viewport = Math.max(80, Math.round(viewport + (width - actual) / (slope > 0.1 ? slope : 0.75)));
  }
  throw new ProofFailure(`The generator panel could not be sized to ${width}px`);
}
// Glyphs paint inside the middle of a text box: a font's ascent and descent may reach into a
// neighbouring line without any ink touching, so each box is trimmed by a fifth top and bottom.
const PAINT = `(() => {
  const root = document.querySelector('${generator}');
  const view = root.querySelector('[data-view="main"]');
  const viewport = root.querySelector('.scroll-region__viewport');
  const bounds = root.getBoundingClientRect();
  const clips = new Map();
  const clipOf = element => {
    if (clips.has(element)) return clips.get(element);
    const parent = element.parentElement && element !== root ? clipOf(element.parentElement) : { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    const style = getComputedStyle(element);
    let clip = parent;
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
      const rect = element.getBoundingClientRect();
      clip = { left: Math.max(parent.left, rect.left), top: Math.max(parent.top, rect.top), right: Math.min(parent.right, rect.right), bottom: Math.min(parent.bottom, rect.bottom) };
    }
    clips.set(element, clip);
    return clip;
  };
  const boxes = [];
  const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const parent = node.parentElement;
    if (!parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const clip = clipOf(parent);
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      const inset = rect.height / 5;
      const box = { left: Math.max(rect.left, clip.left), right: Math.min(rect.right, clip.right),
        top: Math.max(rect.top + inset, clip.top), bottom: Math.min(rect.bottom - inset, clip.bottom) };
      if (box.right - box.left > 1 && box.bottom - box.top > 1) boxes.push({ node, text: node.textContent.trim().slice(0, 32), box });
    }
  }
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.node === b.node) continue;
    const across = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
    const down = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
    if (across > 1 && down > 1) overlaps.push(JSON.stringify(a.text) + ' over ' + JSON.stringify(b.text));
  }
  const outside = boxes.filter(entry => entry.box.left < bounds.left - 1 || entry.box.right > bounds.right + 1).map(entry => entry.text);
  return { overflow: Math.max(0, viewport.scrollWidth - viewport.clientWidth, view.scrollWidth - view.clientWidth),
    overlaps: overlaps.slice(0, 6), outside: outside.slice(0, 6), texts: boxes.length };
})()`;
/**
 * Every rendered box in the main view, relative to the view itself so that scrolling it is not a
 * shift. Left out: boxes that paint nothing (unrendered, or screen-reader text), and the status
 * lines' own text, which a pointed option rewrites by design inside its fixed lines.
 */
const BOXES = `(() => {
  const view = document.querySelector('${mainView}');
  const origin = view.getBoundingClientRect();
  const boxes = new Map();
  for (const element of view.querySelectorAll('*')) {
    if (element.parentElement?.closest('.${G}stmt-line') || element.closest('.plugin-atyrode_code__sr')) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    boxes.set(element, [rect.x - origin.x, rect.y - origin.y, rect.width, rect.height].map(value => Math.round(value * 2) / 2).join(','));
  }
  globalThis.__codeView = view;
  globalThis.__codeBoxes = boxes;
  return boxes.size;
})()`;
const SHIFTED = `(() => {
  const origin = globalThis.__codeView.getBoundingClientRect();
  const moved = [];
  for (const [element, before] of globalThis.__codeBoxes) {
    if (!element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    const now = [rect.x - origin.x, rect.y - origin.y, rect.width, rect.height].map(value => Math.round(value * 2) / 2).join(',');
    if (now !== before) moved.push((element.className || element.tagName) + ' ' + JSON.stringify((element.textContent ?? '').trim().slice(0, 24)) + ' ' + before + ' -> ' + now);
  }
  return moved.slice(0, 6);
})()`;

/**
 * No horizontal overflow and no text box intersecting another from 170 to 1440px of panel width,
 * in every width form of the statement and both forms of the board (spec §8, §10).
 */
async function geometryAcrossWidths(browser: BrowserInstance, label: string): Promise<void> {
  const forms = new Set<string>();
  try {
    for (const width of [1440, 1280, 1100, 860, 620, 560, 390, 320, 240, 170]) {
      await panelWidth(browser, width);
      await until(browser, `the ${width}px statement has measured its form`, `${element(`${generator} .${G}stmt-statement`)}?.dataset.ready === 'true'`);
      const facts = await browser.evaluate<{ overflow: number; overlaps: string[]; outside: string[]; texts: number }>(PAINT);
      assert(facts.texts > 20, `The ${label} main view paints its text at ${width}px`);
      assert.equal(facts.overflow, 0, `The ${label} main view has no horizontal overflow at ${width}px`);
      assert.deepEqual(facts.outside, [], `No ${label} text paints outside the ${width}px panel`);
      assert.deepEqual(facts.overlaps, [], `No ${label} text box intersects another at ${width}px`);
      forms.add(await browser.evaluate<string>(`${element(`${generator} .${G}stmt-statement`)}.dataset.form + '/' + (${board}?.dataset.form ?? 'none')`));
    }
  } finally {
    await browser.send("Emulation.clearDeviceMetricsOverride", {});
  }
  assert(forms.size >= 3, `The ${label} widths exercise several statement and board forms (${[...forms].join(", ")})`);
}

/** Pointing at or focusing any control in the main view moves no box but the status lines' own text (spec §8, §10). */
async function zeroShift(browser: BrowserInstance, label: string): Promise<void> {
  const targets = await browser.evaluate<number>(`(() => {
    const view = document.querySelector('${mainView}');
    globalThis.__codeTargets = [...view.querySelectorAll('button, [data-stmt-word] .${G}stmt-value, .${G}stmt-ghost')]
      .filter(el => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getClientRects().length);
    return globalThis.__codeTargets.length;
  })()`);
  assert(targets > 10, `The ${label} main view offers its pointer targets`);
  for (let index = 0; index < targets; index++) {
    const target = `globalThis.__codeTargets[${index}]`;
    if (!await browser.evaluate<boolean>(`${target}.isConnected`)) continue;
    await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
    await settle(browser);
    await browser.evaluate(BOXES);
    await pointOf(browser, target);
    await settle(browser);
    assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], `Pointing at ${label} target ${index} shifts no layout box`);
  }
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
  await focusStatement(browser, "verb");
  await settle(browser);
  await browser.evaluate(BOXES);
  for (let step = 0; step < 40; step++) {
    await key(browser, "Tab", 9);
    await settle(browser);
    if (!await browser.evaluate<boolean>(`!!document.activeElement?.closest('${mainView}')`)) break;
    assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], `Keyboard focus step ${step} in the ${label} main view shifts no layout box`);
  }
}

/**
 * The browser-provable acceptance of the main view on a bundled preview, which keeps every effect
 * local: panel-local keys, the keys dialog, keyboard edits, wheel rules, touch, reduced motion,
 * zero hover/focus shift and width geometry. `recent` is the browser's one recent team, which the
 * digit 1 recalls. Leaves the team as it found it.
 */
async function acceptanceScenario(browser: BrowserInstance, label: string, recent: Selection): Promise<void> {
  const before = await readStarterDraft(browser);
  const thinking = await browser.evaluate<string>(wordValue("thinking"));
  const quiet = await browser.evaluate<string>(`${liveRegion}.textContent`);

  // Keys are panel-local: the same keys pressed in another panel never reach the statement.
  await click(browser, element(".react-flow .react-flow__pane"));
  for (const [name, code] of [["?", 191], ["1", 49], ["ArrowUp", 38], ["r", 82]] as const) await key(browser, name, code);
  assert.equal(await browser.evaluate(`${keysDialog} === null`), true, "A key pressed outside the panel never opens its keys");
  assert.deepEqual(await readStarterDraft(browser), before, "Keys pressed outside the panel never edit its team");

  // Behind a sheet the panel's keys do nothing, even with the panel root itself focused: not ↵ or Mod+↵ (the verb's
  // step, here a refusal it would say aloud), not a digit, not ?.
  await openSheet(browser, "session options");
  await click(browser, element(`${generator} .${G}options-lede`));
  assert.equal(await browser.evaluate(`document.activeElement === ${element(generator)}`), true, "A press on a sheet's text leaves focus on the panel root behind it");
  for (const [name, code, modifiers] of [["1", 49, 0], ["?", 191, 0], ["Enter", 13, 0], ["Enter", 13, CTRL]] as const) await key(browser, name, code, { modifiers });
  await Bun.sleep(300);
  assert.deepEqual(await browser.evaluate(`({ keys: ${keysDialog} !== null, sheet: ${element(mainView)}.hidden, said: ${liveRegion}.textContent })`),
    { keys: false, sheet: true, said: quiet }, "No panel key acts behind a sheet: no keys dialog, no step, nothing said");
  await closeSheet(browser);
  assert.deepEqual(await readStarterDraft(browser), before, "No panel key behind a sheet recalls or edits the team");

  await focusStatement(browser, "thinking");
  await key(browser, "?", 191);
  await until(browser, "? opens the keys dialog in the panel's layer and gives it focus", `document.activeElement === ${element(`${generator} .${G}layer .${G}keys-dialog`)}`);
  assert.deepEqual(await browser.evaluate(`[...${keysDialog}.querySelectorAll('section')].map(group => group.getAttribute('aria-label'))`),
    ["statement", "pools", "sessions", "recent teams", "panel"], "The keys dialog lists the keys of every region that answers them");
  // With the dialog itself focused (its close button would take ↵ as a press), the panel's keys do nothing either.
  for (const [name, code, modifiers] of [["1", 49, 0], ["Enter", 13, CTRL]] as const) await key(browser, name, code, { modifiers });
  await Bun.sleep(300);
  assert.deepEqual(await browser.evaluate(`({ focused: document.activeElement === ${keysDialog}, said: ${liveRegion}.textContent })`),
    { focused: true, said: quiet }, "A digit or Mod+↵ in the keys dialog neither recalls a team nor takes a step");
  for (const modifiers of [0, 0, 0, SHIFT, SHIFT]) await key(browser, "Tab", 9, { modifiers });
  assert.equal(await browser.evaluate(`!!document.activeElement?.closest('.${G}keys-dialog')`), true, "Tab and Shift+Tab stay inside the open keys dialog");
  await key(browser, "Escape", 27);
  await until(browser, "Esc closes the keys and returns focus to the word", `${keysDialog} === null && document.activeElement === ${slot("thinking")}`);
  assert.deepEqual(await readStarterDraft(browser), before, "Keys pressed in the keys dialog never edit the team");

  // In the main view the digit recalls the recent team; choosing the word back returns the exact team.
  await key(browser, "1", 49);
  await until(browser, "1 recalls the recent team and says so", `${wordValue("advisor")} === ${JSON.stringify(recent.advisor)} && ${liveRegion}.textContent.startsWith('Recent team 1')`);
  await choose(browser, "advisor", before.selection.advisor);
  await until(browser, "the advisor is back", `${wordValue("advisor")} === ${JSON.stringify(before.selection.advisor)} && ${slot("advisor")}.dataset.open !== 'true'`);
  assert.deepEqual(await readStarterDraft(browser), before, "Recalling a team and choosing its word back returns the exact team");
  await focusStatement(browser, "thinking");

  // Keyboard edits: ↑ is more, Home and End reach the drum's ends, each word is one tab stop.
  const available = await browser.evaluate<string[]>(`[...${slot("thinking")}.querySelectorAll('[role="option"]:not([aria-disabled])')].map(el => el.querySelector('.${G}stmt-text').textContent.trim())`);
  await key(browser, "Home", 36);
  await until(browser, "Home reaches the most thinking", `${wordValue("thinking")} === ${JSON.stringify(available[0])}`);
  await key(browser, "End", 35);
  await until(browser, "End reaches the least thinking", `${wordValue("thinking")} === ${JSON.stringify(available.at(-1))}`);
  await key(browser, "ArrowUp", 38);
  await until(browser, "↑ raises the thinking one available step", `${wordValue("thinking")} === ${JSON.stringify(available.at(-2))}`);
  assert.equal(await browser.evaluate(`${slot("thinking")}.querySelectorAll('[tabindex]').length`), 0, "Each word is one keyboard tab stop; its options are not");
  assert.equal(await browser.evaluate(`(() => {
    const el = document.activeElement, style = getComputedStyle(el);
    return el.matches(':focus-visible') && ((style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none');
  })()`), true, "Keyboard edits keep a visible focus indicator");
  // A keyboard commit says what it did in the first status line, where a pointer reads it before choosing.
  const firstLine = element(`${generator} .${G}stmt-line`);
  assert.equal(await browser.evaluate(`${firstLine}.querySelector('[data-tone="strong"]')?.textContent`), `Thinking ${available.at(-2)}`,
    "A keyboard commit names itself in the first status line");
  await choose(browser, "thinking", thinking);
  await until(browser, "the thinking word is back", `${wordValue("thinking")} === ${JSON.stringify(thinking)} && ${slot("thinking")}.dataset.open !== 'true'`);
  assert.deepEqual(await readStarterDraft(browser), before, "Keyboard round trips return the exact team");

  // A step only a refused option could take does nothing and says why, in the first status line and aloud, until the next key.
  await focusStatement(browser, "tier");
  const tier = await browser.evaluate<string>(wordValue("tier"));
  const refusedTier = await browser.evaluate<string | null>(`(() => {
    const options = [...${slot("tier")}.querySelectorAll('[role="option"]')];
    const top = options.findIndex(el => !el.hasAttribute('aria-disabled'));
    return top > 0 ? options[top - 1].querySelector('.${G}stmt-text').textContent.trim() : null;
  })()`);
  assert(refusedTier, "The bundled starter refuses the tier above its most capable available one");
  await key(browser, "Home", 36);
  await key(browser, "ArrowUp", 38);
  await until(browser, "a refused step names the refused option and its reason in the first status line",
    `${firstLine}.querySelector('[data-tone="strong"]')?.textContent === ${JSON.stringify(`Tier ${refusedTier}`)} && !!${firstLine}.querySelector('[data-tone="attention"]')?.textContent`);
  const reason = await browser.evaluate<string>(`${firstLine}.querySelector('[data-tone="attention"]').textContent`);
  await until(browser, "a refused step says its reason aloud", `${liveRegion}.textContent === ${JSON.stringify(`Tier ${refusedTier}: ${reason}`)}`);
  assert.notEqual(await browser.evaluate(wordValue("tier")), refusedTier, "A refused step leaves the word where it was");
  await key(browser, "Escape", 27);
  await until(browser, "the next key clears what the refused step said", `!${firstLine}.textContent.includes(${JSON.stringify(`Tier ${refusedTier}`)})`);
  if (await browser.evaluate<string>(wordValue("tier")) !== tier) await choose(browser, "tier", tier);
  await until(browser, "the tier is back", `${wordValue("tier")} === ${JSON.stringify(tier)} && ${slot("tier")}.dataset.open !== 'true'`);
  assert.deepEqual(await readStarterDraft(browser), before, "A refused step and Home return the exact team");

  // The wheel turns a word only on its open drum, or under keyboard focus after the pointer rests;
  // never after a click focused it, and never while the panel scrolls (spec §2).
  await panelWidth(browser, 860, 520);
  try {
    const restingWheel = async (target: string, deltaY: number) => {
      const point = await pointOf(browser, target);
      await Bun.sleep(450);
      await wheel(browser, point, deltaY);
      await settle(browser);
    };
    // Focus must come from the click itself: a word the keyboard focused keeps its keyboard focus through a later click.
    await click(browser, element(`${generator} .${G}earlier-title`));
    await click(browser, `${slot("thinking")}.querySelector('.${G}stmt-connector')`);
    assert.deepEqual(await browser.evaluate(`({ focused: document.activeElement === ${slot("thinking")}, visible: document.activeElement.matches(':focus-visible'), open: ${slot("thinking")}.dataset.open === 'true', active: document.activeElement.getAttribute('aria-label') ?? document.activeElement.tagName })`),
      { focused: true, visible: false, open: false, active: "Thinking" }, "A click on the word's connector gives it pointer focus without opening it");
    await restingWheel(`${slot("thinking")}.querySelector('.${G}stmt-value')`, -100);
    assert.equal(await browser.evaluate(wordValue("thinking")), thinking, "The wheel over a word focused by a click scrolls, never turns it");
    // A key pressed after the click does not make the click's focus a keyboard focus.
    await key(browser, "Escape", 27);
    await restingWheel(`${slot("thinking")}.querySelector('.${G}stmt-value')`, -100);
    assert.equal(await browser.evaluate(wordValue("thinking")), thinking, "Click, Esc, then the wheel still never turns the word");
    await focusStatement(browser, "thinking");
    await restingWheel(`${slot("thinking")}.querySelector('.${G}stmt-value')`, -100);
    await until(browser, "the wheel turns a keyboard-focused word after the pointer rests", `${wordValue("thinking")} !== ${JSON.stringify(thinking)}`);
    const turned = await browser.evaluate<string>(wordValue("thinking"));
    await Bun.sleep(350);
    const scrolling = await pointOf(browser, element(`${generator} .${G}earlier-title`));
    await wheel(browser, scrolling, 120);
    const word = await browser.evaluate<Point>(`(() => { const rect = ${slot("thinking")}.querySelector('.${G}stmt-value').getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`);
    if (word.y > 0) {
      await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...word });
      await wheel(browser, word, -100);
      await settle(browser);
      assert.equal(await browser.evaluate(wordValue("thinking")), turned, "A wheel that arrives while the panel scrolls never turns a word");
    }
    await click(browser, `${slot("thinking")}.querySelector('.${G}stmt-value')`);
    await until(browser, "the drum opens", `${slot("thinking")}.dataset.open === 'true'`);
    await Bun.sleep(350);
    const drum = await pointOf(browser, `${slot("thinking")}.querySelector('[role="option"][aria-selected="true"]')`);
    await Bun.sleep(350);
    await wheel(browser, drum, 100);
    await until(browser, "the wheel turns an open drum at once", `${wordValue("thinking")} !== ${JSON.stringify(turned)}`);
    await key(browser, "Escape", 27);
    await choose(browser, "thinking", thinking);
    await until(browser, "the wheel round trip restores the thinking", `${wordValue("thinking")} === ${JSON.stringify(thinking)} && ${slot("thinking")}.dataset.open !== 'true'`);
  } finally {
    await browser.send("Emulation.clearDeviceMetricsOverride", {});
  }
  assert.deepEqual(await readStarterDraft(browser), before, "Wheel round trips return the exact team");

  // Coarse pointers: drum options are at least 44px tall, and a touch scroll never edits the team.
  await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    assert.equal(await browser.evaluate("matchMedia('(pointer: coarse)').matches"), true);
    const tap = await pointOf(browser, `${slot("advisor")}.querySelector('.${G}stmt-value')`);
    await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tap] });
    await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until(browser, "a tap opens the advisor drum", `${slot("advisor")}.dataset.open === 'true'`);
    assert.equal(await browser.evaluate(`[...${slot("advisor")}.querySelectorAll('[role="option"]')].every(el => el.getBoundingClientRect().height >= 44)`), true,
      "Drum options are at least 44px tall on a coarse pointer");
    await key(browser, "Escape", 27);
    await until(browser, "Esc closes the drum", `${slot("advisor")}.dataset.open !== 'true'`);
    const start = await pointOf(browser, `${slot("lane")}.querySelector('.${G}stmt-value')`);
    await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    await browser.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x, y: start.y + 40 }] });
    await browser.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x + 50, y: start.y + 90 }] });
    await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settle(browser);
    if (await browser.evaluate<boolean>(`${slot("lane")}.dataset.open === 'true'`)) await key(browser, "Escape", 27);
    assert.deepEqual(await readStarterDraft(browser), before, "A touch scroll across the statement never edits the team");
    // Every width form keeps 44px touch targets: the words, the verb and the footer's links, session options among them.
    for (const width of [1280, 860, 390, 240]) {
      await panelWidth(browser, width);
      const small = await browser.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${mainView} :is([data-stmt-word], [data-stmt-verb], .${G}footer-link)`)})]
        .filter(el => { const rect = el.getBoundingClientRect(); return rect.height < 44 || (!el.matches('[data-stmt-word]') && rect.width < 44); })
        .map(el => (el.dataset.stmtWord ?? el.textContent.trim()) + ' ' + Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height))`);
      assert.deepEqual(small, [], `Touch targets are at least 44px in the ${await browser.evaluate<string>(`${element(`${generator} .${G}stmt-statement`)}.dataset.form`)} form at ${width}px`);
    }
  } finally {
    await browser.send("Emulation.clearDeviceMetricsOverride", {});
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }

  // Reduced motion: a commit animates by default and not at all under prefers-reduced-motion (spec §7, §10).
  const running = `${element(generator)}.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length`;
  const ghostUp = `${slot("thinking")}.querySelector('.${G}stmt-ghost[data-at="up"]:not([data-off])')`;
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await click(browser, ghostUp);
  assert((await browser.evaluate<number>(running)) > 0, "A pointer commit rolls the word when motion is allowed");
  await choose(browser, "thinking", thinking);
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await until(browser, "the earlier motion has finished", `${running} === 0 && ${slot("thinking")}.dataset.open !== 'true'`);
  await click(browser, ghostUp);
  assert.equal(await browser.evaluate(running), 0, "Reduced motion: a pointer commit does not animate");
  await focusStatement(browser, "thinking");
  await key(browser, "ArrowDown", 40);
  assert.equal(await browser.evaluate(running), 0, "Reduced motion: a keyboard commit does not animate");
  await until(browser, "the thinking returns", `${wordValue("thinking")} === ${JSON.stringify(thinking)}`);
  await openSheet(browser, "models");
  assert.equal(await browser.evaluate(running), 0, "Reduced motion: a sheet does not slide in");
  await closeSheet(browser);
  assert.deepEqual(await readStarterDraft(browser), before, "Motion checks return the exact team");

  await zeroShift(browser, label);
  await geometryAcrossWidths(browser, label);
  assert.deepEqual(await readStarterDraft(browser), before, "Hover, focus and resizing are presentation only");
}

// ---------------------------------------------------------------- the bundled starter

async function starterWorkbenchScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, destination: Target): Promise<void> {
  const catalogRead = await callAction(server, writer.token, "atyrode.omp.readModelCatalog", { providers: starterProviders });
  assert(catalogRead.ok, "The pinned OMP bundle supplies passive authoritative metadata without account setup");
  const metadata = ModelCatalogSnapshotSchema.parse(catalogRead.result);
  assert.equal(metadata.source, "bundled");
  assert.deepEqual([...new Set(metadata.models.map(model => model.provider))].sort(), [...starterProviders].sort(),
    "The starter uses exact sanctioned providers, never an OpenAI alias for Codex");
  const deployments = await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 });
  const terminals = await ownerAction(server, "core.terminals.listAll", {});
  await arrangeWorkbench(server, writer);
  const trace = await watchActions(browser, server);
  try {
    for (const initialized of [false, true]) {
      const workspace = await createContainer(server, initialized ? "Initialized empty starter" : "Bundled first profile", "canvas");
      const target = { containerId: workspace.id };
      if (initialized) {
        const created = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { ...target, expectedRevision: 0 });
        assert(created.ok);
        const excluded = await callAction(server, writer.token, "atyrode.code.changeAccounts", { ...target,
          expectedRevision: (created.result as Configuration).revision,
          change: { kind: "set-account", enabled: false, reference: {
            kind: "credential", scope: "starter-preserved-scope", provider: "anthropic", credentialId: 17,
          } } });
        assert(excluded.ok, "Initialized-empty starter has an existing exact exclusion policy to preserve");
      }
      const base = await readConfiguration(server, writer, target);
      if (!initialized) assert.deepEqual(base, { configuration: null, legacyMachineId: null, revision: 0 });
      const start = trace.requests.length;
      await openGenerator(browser, server, workspace.id);
      await usableStarter(browser);
      assert.equal(await browser.evaluate(`${liveRegion}?.textContent`), "", "The live region is mounted empty");
      const initialDraft = await readStarterDraft(browser);
      assert.equal(initialDraft.baseRevision, base.revision);
      assert.deepEqual(initialDraft.metadata, metadata, "Local routes are based on the exact real OMP metadata response");
      // The first workspace has one recent team, which the panel reads as it mounts.
      const recent = { ...initialDraft.selection, thinking: "high", advisor: "off" } satisfies Selection;
      if (!initialized) {
        await rememberTeam(browser, writer.principal.id, workspace.id, recent);
        await openGenerator(browser, server, workspace.id);
        await usableStarter(browser);
        assert.deepEqual(await readStarterDraft(browser), initialDraft, "An untouched preview is the same after a reload");
      }
      await choose(browser, "thinking", "high");
      await until(browser, "a pointer commit puts high thinking on the line", `${wordValue("thinking")} === 'high'`);
      await choose(browser, "advisor", "audit");
      await until(browser, "a pointer commit puts the audit advisor on the line", `${wordValue("advisor")} === 'audit'`);
      await until(browser, "the commit is announced", `${liveRegion}?.textContent.includes('audit')`);
      await assertRoles(browser, true);
      const chosen = await readStarterDraft(browser);
      assert.notDeepEqual(chosen.selection, initialDraft.selection, "The first explicit choice is a nondefault selection");
      assert.equal(chosen.selection.thinking, "high");
      assert.equal(chosen.selection.advisor, "audit");
      for (const view of ["accounts", "models", "setup"] as const) {
        await openSheet(browser, view);
        await closeSheet(browser);
      }
      assert.deepEqual(await readStarterDraft(browser), chosen, "Sheets do not regenerate or rebase starter choices");
      // The unsaved choices are kept in this tab: a reload brings them back on the same bundled list.
      await openGenerator(browser, server, workspace.id);
      await usableStarter(browser);
      assert.deepEqual(await readStarterDraft(browser), chosen, "A reload keeps the unsaved starter choices");
      if (!initialized) await acceptanceScenario(browser, "bundled starter", recent);
      assert.deepEqual(await readConfiguration(server, writer, target), base,
        "Mount, words, keys, wheel, touch, resizing and sheets never initialize or mutate policy");
      assert.deepEqual(trace.requests.slice(start).filter(request => /^atyrode\.code\.(initializeConfiguration|stageCatalog|select|adoptStarterProfile|changeAccounts)$/.test(request.name)), []);
      // The preview is render-only: the exact OMP response's policy derivation, with no save.
      const document = catalogFromMetadata(metadata, chosen.selection.budget);
      assert.deepEqual(chosen.document, document, "The displayed/exported preview is the policy derivation of the real response");
      assert.deepEqual(await seatedRoles(browser), expectedSeats(document, chosen.selection),
        "Every seated role, its model and its supported effort exactly match the policy derivation of the chosen selection");
      for (const model of document.models) {
        const source = metadata.models.find(row => row.provider === model.provider && row.id === model.id);
        assert(source, "Every previewed catalog row comes from the actual pinned OMP response");
        assert(source.quotaTier === null || source.quotaTier === "chat" || (source.quotaTier === "spark" && model.tier === 0),
          "Special and unknown quota tiers cannot become ordinary preview rungs; Spark is only the off-ladder tier 0");
        assert.equal(model.tokensPerSecond, null, "Bundled metadata does not invent measured speed");
        assert.equal(model.timeToFirstTokenMs, null, "Bundled metadata does not invent measured latency");
      }
      assert.deepEqual(await readConfiguration(server, writer, target), base, "Nothing but a verification persists the preview");
      await until(browser, "saved policy is not native launch readiness", verbIs("Verify models", "refused"));
      const native = await callAction(server, writer.token, "atyrode.omp.describeDestination", { ...target, machineId: destination.machineId });
      assert(native.ok);
      assert((native.result as OmpResult<"describeDestination">).operations.every(operation => !operation.nativeReady));
    }
    await starterConflictScenario(browser, server, writer);
    assert(trace.requests.some(request => request.name === "atyrode.omp.readModelCatalog"), "The browser itself consumes the real public bundled source");
    for (const request of trace.requests.filter(request => request.name === "atyrode.omp.readModelCatalog")) {
      assert.deepEqual(request.input, { providers: starterProviders }, "Every starter source read uses the identical exact provider filter");
    }
    noNativeEffects(trace.requests);
  } finally { trace.stop(); }
  assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), deployments);
  assert.deepEqual(await ownerAction(server, "core.terminals.listAll", {}), terminals,
    "Starter editing, saving and conflict recovery create neither native approvals nor terminals");
}

async function starterConflictScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant): Promise<void> {
  const workspace = await createContainer(server, "Frozen revision-zero starter", "canvas");
  const target = { containerId: workspace.id };
  await openGenerator(browser, server, workspace.id);
  await usableStarter(browser);
  await choose(browser, "thinking", "max");
  await until(browser, "max thinking is on the line", `${wordValue("thinking")} === 'max'`);
  const frozen = await readStarterDraft(browser);
  const boardText = await browser.evaluate<string>(`${board}.textContent`);
  const competing = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { ...target, expectedRevision: 0 });
  assert(competing.ok);
  // A competing initializer moves the revision under the frozen preview: unlike a verification's own
  // initialization, it is a change made elsewhere, and the line says so and offers theirs.
  await until(browser, "a revision-zero preview refuses to attach to a competing initializer",
    `${verbIs("Verify models", "refused")} && !!${statusFix("use theirs")} && (${statusText}).includes('changed elsewhere')`);
  for (const view of ["models", "accounts"] as const) {
    await openSheet(browser, view);
    await closeSheet(browser);
  }
  assert.deepEqual(await readStarterDraft(browser), frozen, "The exact document, metadata, choices and original revision remain inspectable/exportable");
  assert.equal(await browser.evaluate(`${board}.textContent`), boardText, "A conflict does not replace the displayed seats");
  assert.equal((await readConfiguration(server, writer, target)).revision, 1, "Navigation cannot auto-rebase or replay a rejected first adoption");
  assert.equal(await browser.evaluate(verbIs("Verify models", "refused")), true, "A conflicted preview stays unsavable after observation recovery");
}

/** Only transport failure/latency is injected. Every successful configuration and
 * metadata response, policy review and adoption still comes from the installed owners. */
async function starterObservationScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant): Promise<void> {
  let hold = true, fail = true, failed = 0;
  let action = "atyrode.omp.readModelCatalog";
  const held = new Set<() => void>();
  const trace = await watchActions(browser, server);
  const fixture = await intercept(browser, server, async name => {
    if (name !== action) return undefined;
    if (hold) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const release = () => { held.delete(release); resolve(); };
      held.add(release);
      await promise;
    }
    if (!fail) return undefined;
    failed++;
    return refused("synthetic_starter_observation_failure");
  });
  try {
    for (const observation of ["atyrode.omp.readModelCatalog", "atyrode.code.readConfiguration"]) {
      action = observation; hold = true; fail = true;
      const workspace = await createContainer(server, `Unavailable starter ${observation}`, "canvas");
      const target = { containerId: workspace.id };
      const metadataFails = observation === "atyrode.omp.readModelCatalog";
      // An unread workspace is the verb's refusal and its retry. A failed model list holds the second line with its own
      // retry and Models, whatever else the verb is refused for, and the refusal's fix moves up beside its words.
      const retry = statusFix("retry");
      await openGenerator(browser, server, workspace.id);
      await waitFor(() => held.size > 0, timeout, 50);
      await until(browser, "the line says the team is still being read", `${element(`${generator} .${G}stmt-empty`)}?.textContent === 'Reading the team'`);
      assert.equal(await browser.evaluate(`${verb}.dataset.state !== 'ready'`), true,
        "Loading observations cannot authorize a save against an invented absent record");
      assert.equal(await browser.evaluate(`${board} === null`), true, "First-use seats are not fabricated while an authoritative prerequisite is pending");
      hold = false;
      for (const release of [...held]) release();
      await control(browser, "a failed prerequisite offers an explicit retry", retry, false);
      assert(failed > 0);
      if (metadataFails) {
        await until(browser, "with no team to seat, the second line names the failed model list as the reason, with its retry and Models",
          `${listFailureSaid("no team can be formed without it")} && !!${statusFix("refresh")}`);
        await click(browser, statusFix("Models"));
        await until(browser, "the Models fix opens Models", `${element(mainView)}.hidden === true && !!${visibleSheet}?.querySelector('[aria-label="Model catalog"]')`);
        await closeSheet(browser);
      }
      assert.equal(await browser.evaluate(`${verb}.dataset.state !== 'ready'`), true, "An unavailable observation is not an empty configuration");
      assert.equal(await browser.evaluate(`${board} === null`), true);
      assert.deepEqual(await readConfiguration(server, writer, target), { configuration: null, legacyMachineId: null, revision: 0 });
      fail = false;
      await click(browser, retry);
      await usableStarter(browser);
      await choose(browser, "thinking", "max");
      await until(browser, "max thinking is on the line", `${wordValue("thinking")} === 'max'`);
      const frozen = await readStarterDraft(browser);
      const seats = await seatedRoles(browser);
      fail = true;
      const failures = failed;
      // Opening a sheet re-reads every observation; this one now fails.
      await openSheet(browser, "models");
      await closeSheet(browser);
      await waitFor(() => failed > failures, timeout, 50);
      await control(browser, "later observation failure remains separately retryable", retry, false);
      if (metadataFails) await until(browser, "beside the retained team, the second line names the failed model list with its retry and Models",
        `${listFailureSaid("the seats are the team on the line")} && !!${statusFix("refresh")}`);
      assert.deepEqual(await readStarterDraft(browser), frozen, "Observation failure retains the original document, metadata and selected policy");
      assert.equal(await browser.evaluate(wordValue("thinking")), "max", "The retained team stays on the line");
      assert.deepEqual(await seatedRoles(browser), seats, "Retained seats remain inspectable when current observations fail");
      assert.equal(await browser.evaluate(`${verb}.dataset.state !== 'ready'`), true, "A failed refresh cannot authorize a retained starter");
      fail = false;
      await click(browser, retry);
      await until(browser, "real observation recovery removes its retry control", `${retry} == null`);
      assert.deepEqual(await readStarterDraft(browser), frozen, "Recovery never regenerates the local profile");
      assert.deepEqual(await seatedRoles(browser), seats, "Recovery shows the retained seats");
      assert.equal((await readConfiguration(server, writer, target)).revision, 0, "Observation recovery never implicitly saves retained choices");
    }
    assert.deepEqual(trace.requests.filter(request => /^atyrode\.code\.(initializeConfiguration|adoptStarterProfile|stageCatalog|select)$/.test(request.name)), []);
    noNativeEffects(trace.requests);
    fixture.check();
  } finally {
    hold = false;
    for (const release of [...held]) release();
    await fixture.stop();
    trace.stop();
  }
}

// ---------------------------------------------------------------- the verification charge

/**
 * Synthetic OMP observations reach the verification charge: the destination reports discovery and
 * benchmark ready, a fictional account is observed and the inventory job has settled. Code's own
 * initialization, probe composition and inventory draft are the real server's. The benchmark that
 * would spend is refused, so nothing is probed, verified or saved.
 */
async function verificationChargeScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, destination: Target): Promise<void> {
  const workspace = await createContainer(server, "Verification charge", "canvas");
  const target: Target = { containerId: workspace.id, machineId: destination.machineId };
  const packed = JSON.parse(readFileSync(join(ompBundleDirectory, "atyrode.omp.manifold-plugin.json"), "utf8")) as {
    manifest: { machine: { operations: Record<string, unknown> } };
  };
  for (const operationId of [INVENTORY_OPERATION_ID, BENCHMARK_OPERATION_ID]) assert(packed.manifest.machine.operations[operationId], "Synthetic readiness names real upstream operations");
  const pins = { installationRevision: "synthetic-ui-only", artifactSha256: "b".repeat(64), resourceBindingDigest: "c".repeat(64) };
  const row = (id: string, input: number, levels: ("low" | "medium" | "high" | "xhigh" | "max")[]) => ({ provider: "anthropic", id, api: "anthropic-messages",
    inputCostPerMillion: input, outputCostPerMillion: input * 5, contextWindow: 200_000, maxTokens: 64_000, reasoning: true, thinkingLevels: levels, images: true });
  const inventory: InventoryReceipt = { schemaVersion: 1, kind: "inventory", ompVersion: OMP_VERSION, observedAt: Date.now() - 5_000, models: [
    row("claude-haiku-5", 1, ["low", "medium", "high"]), row("claude-sonnet-5", 3, ["low", "medium", "high", "xhigh"]),
    row("claude-opus-5", 5, ["low", "medium", "high", "xhigh", "max"]) ] };
  const charge = inventoryDraft(inventory, "any").benchmark.candidates;
  const started: Record<string, unknown>[] = [], benchmarks: Record<string, unknown>[] = [], cancels: unknown[] = [];
  let listFails = true;
  const deployments = await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 });
  const terminals = await ownerAction(server, "core.terminals.listAll", {});
  await arrangeWorkbench(server, writer);
  const fixture = await intercept(browser, server, (name, input) => {
    switch (name) {
      case "atyrode.omp.describeDestination": {
        if (input.containerId !== target.containerId || input.machineId !== target.machineId) return undefined;
        const result: OmpResult<"describeDestination"> = { ...target, pluginId: "atyrode.omp", state: "ready", reason: null, deployment: null, services: [],
          operations: [INVENTORY_OPERATION_ID, BENCHMARK_OPERATION_ID].map(operationId => ({ operationId, pins, nativeReady: true, callerRefusal: null, state: "ready", reason: null })) };
        return { ok: true, result };
      }
      case "atyrode.omp.readModelCatalog": return listFails ? refused("synthetic_model_list_failure") : undefined;
      case "atyrode.omp.accounts.accounts": return { ok: true, result: fixtureAccounts([1]) };
      case "atyrode.omp.accounts.usage": return { ok: true, result: fixtureUsage([1]) };
      case "atyrode.omp.startInventory": {
        assert.equal(input.containerId, target.containerId);
        assert.equal(input.machineId, target.machineId);
        assert.deepEqual(Object.keys(input.accountPool as object), ["anthropic"], "The inventory runs with the pool Code composed from the saved choices");
        started.push(input);
        return { ok: true, result: probeJob(target, `synthetic-inventory-${started.length}`, INVENTORY_OPERATION_ID, writer.principal.id) };
      }
      case "engine.jobs.status": {
        const { node } = input as { node: { jobId: string; operationId: string } };
        assert.equal(node.operationId, INVENTORY_OPERATION_ID, "Only the synthetic inventory is ever followed");
        return { ok: true, result: probeJob(target, node.jobId, INVENTORY_OPERATION_ID, writer.principal.id) };
      }
      case "atyrode.omp.readInventory": return { ok: true, result: { job: probeJob(target, String(input.jobId), INVENTORY_OPERATION_ID, writer.principal.id), inventory } };
      case "atyrode.omp.startBenchmark": {
        const request = ompActionSchemas.startBenchmark.input.parse(input);
        assert.deepEqual(request.candidates.candidates, charge, "A confirmation spends exactly the charge it showed");
        benchmarks.push(input);
        return refused("synthetic_benchmark_refused");
      }
      case "engine.jobs.cancel": cancels.push(input); return refused("synthetic_cancel_unexpected");
      default: return undefined;
    }
  });
  try {
    // The model list fails at first. Verify needs no list, so it stays the step; with no team to seat there is no board,
    // and the second status line names the failure with the list's own retry and Models.
    await openGenerator(browser, server, workspace.id);
    await until(browser, "beside a ready Verify the second line names the failed model list with its retry and Models",
      `${verbIs("Verify models", "ready")} && ${listFailureSaid("no team can be formed without it")}`);
    assert.equal(await browser.evaluate(`${board} === null`), true, "With no team to seat there is no board");
    listFails = false;
    await click(browser, statusFix("retry"));
    await until(browser, "the list's retry reads it again and seats the bundled team", `${board} !== null && !${statusFix("retry")}`);
    // One provider word per glance: the team's counts name each family as the lane does, never an account or provider id.
    assert.match(await browser.evaluate<string>(`document.querySelectorAll('${generator} .${G}stmt-line')[1].textContent`),
      /^\d+ on (GPT|Claude|DeepSeek)( · \d+ on (GPT|Claude|DeepSeek))*$/, "The team's counts use family words");

    // On arrival the panel root has focus, so its keys work at once: an arrow gives the lane focus and changes nothing.
    await openGenerator(browser, server, workspace.id);
    await until(browser, "with discovery ready the first step is to verify", verbIs("Verify models", "ready"));
    await until(browser, "on arrival the panel root has focus", `document.activeElement === ${element(generator)}`);
    const arrived = await browser.evaluate<string>(lineWords);
    await key(browser, "ArrowDown", 40);
    await until(browser, "an arrow on arrival gives the lane focus", `document.activeElement === ${slot("lane")}`);
    assert.equal(await browser.evaluate(lineWords), arrived, "An arrow on arrival changes no word");

    // A double-click on Verify starts one verification; its second click lands on a busy verb, never on Confirm.
    const point = await pointOf(browser, verb);
    await press(browser, point, 1);
    await press(browser, point, 2);
    await until(browser, "the verb checks the accounts' models", verbIs("Checking…", "busy"));
    assert.equal(await browser.evaluate(`document.activeElement === ${verb} && ${verb}.getAttribute('aria-busy') === 'true'`), true,
      "The pressed verb keeps focus while it checks");
    await until(browser, "the charge waits on its own confirmation", `${verbIs("Verify models", "waiting")} && ${confirmCharge} !== null`);
    assert.equal(started.length, 1, "A double-click on Verify starts exactly one inventory");
    assert.equal(benchmarks.length, 0, "A double-click on Verify never confirms the charge");
    assert.equal(await browser.evaluate(`document.activeElement === ${verb}`), true, "Confirm charge is never focused for the person; the verb keeps focus");
    assert.equal(await browser.evaluate(`${verb}.getAttribute('aria-disabled')`), "true", "While a charge waits the verb refuses by aria-disabled");
    assert.equal(await browser.evaluate(`${confirmCharge}.getAttribute('aria-label')`), `Confirm charge: ${charge.length} ${charge.length === 1 ? "request" : "requests"}`,
      "Confirm is bound to the exact charge shown");
    assert(await browser.evaluate<number>(`${confirmCharge}.getBoundingClientRect().height`) >= 28, "Confirm charge is at least 28px tall");
    await until(browser, "the charge is announced", `${liveRegion}?.textContent.includes(${JSON.stringify(String(charge.length))})`);
    assert.equal(await browser.evaluate(`(${statusText}).includes(${JSON.stringify(`Claude ${charge.length}`)})`), true, "The charge names its provider by family");

    // While the charge waits, no team, machine or account edit may start: the words leave the Tab order.
    for (const word of ["lane", "tier", "thinking", "advisor", "extras", "machine"] as const) {
      assert.equal(await browser.evaluate(`${slot(word)}.getAttribute('aria-disabled') === 'true' && ${slot(word)}.tabIndex === -1`), true,
        `The ${word} word is locked while the charge waits`);
    }
    const team = await browser.evaluate<string>(`[${["lane", "tier", "thinking", "advisor", "extras", "machine"].map(word => wordValue(word as Word)).join(", ")}].join(' ')`);
    await key(browser, "ArrowRight", 39);
    await until(browser, "→ walks from the verb to the first word", `document.activeElement === ${slot("lane")}`);
    const announced = await browser.evaluate<string>(`${liveRegion}.textContent`);
    await key(browser, "ArrowUp", 38);
    await key(browser, "ArrowLeft", 37);
    await until(browser, "focus returns to the verb", `document.activeElement === ${verb}`);
    for (let step = 0; step < 6; step++) await key(browser, "ArrowRight", 39);
    await key(browser, "ArrowDown", 40);
    await until(browser, "a refused edit says why", `${liveRegion}.textContent !== ${JSON.stringify(announced)} && ${liveRegion}.textContent !== ''`);
    assert.equal(await browser.evaluate(`[${["lane", "tier", "thinking", "advisor", "extras", "machine"].map(word => wordValue(word as Word)).join(", ")}].join(' ')`), team,
      "No team or machine edit lands while a charge waits");
    await focusStatement(browser, "verb");
    await key(browser, "Tab", 9);
    assert.equal(await browser.evaluate(`document.activeElement === ${confirmCharge}`), true, "Confirm charge is the next Tab stop after the verb");

    // Only a deliberate single press spends: never the second click of a multi-click, never a held key.
    await press(browser, await pointOf(browser, confirmCharge), 2);
    await key(browser, "Enter", 13, { autoRepeat: true });
    await key(browser, " ", 32, { autoRepeat: true });
    await Bun.sleep(300);
    assert.equal(benchmarks.length, 0, "Neither a second click nor key repeat confirms the charge");
    assert.equal(await browser.evaluate(`${confirmCharge} !== null`), true, "The charge still waits");
    const cancel = `[...document.querySelectorAll('${generator} .${G}stmt-link')].find(el => el.textContent.trim() === 'cancel')`;
    // The press that prepared the charge initialized the first-use workspace: that is the run's own
    // effect, so a cancelled or stopped run offers Verify again, never a conflict with "theirs".
    const verifyAgain = `${verbIs("Verify models", "ready")} && ${confirmCharge} === null && !${statusFix("use theirs")}`;
    await click(browser, cancel);
    await until(browser, "a cancelled first-use charge offers Verify again without a conflict", verifyAgain);
    assert.equal(benchmarks.length, 0, "Cancelling a waiting charge spends nothing");
    assert.deepEqual(cancels, [], "A charge that never spent has no native job to cancel");
    const prepared = await readConfiguration(server, writer, target);
    assert.equal(prepared.configuration?.revision, 1, "The Verify press initialized the first-use workspace exactly once");
    assert.equal(prepared.configuration?.active, null, "Preparing a charge promotes nothing");
    assert.equal(prepared.configuration?.draft, null, "Preparing a charge stages nothing");

    // The panel's keys never act from the keys dialog, nor from behind a sheet with the panel root focused: not Mod+↵, not ↵.
    await focusStatement(browser, "lane");
    await key(browser, "?", 191);
    await until(browser, "the keys dialog has focus", `document.activeElement === ${keysDialog}`);
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await Bun.sleep(300);
    assert.equal(started.length, 1, "Mod+↵ in the keys dialog takes no step");
    await key(browser, "Escape", 27);
    await until(browser, "Esc closes the keys", `${keysDialog} === null`);
    await openSheet(browser, "session options");
    await click(browser, element(`${generator} .${G}options-lede`));
    assert.equal(await browser.evaluate(`document.activeElement === ${element(generator)}`), true, "A press on a sheet's text leaves focus on the panel root");
    await key(browser, "Enter", 13);
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await Bun.sleep(300);
    assert.equal(started.length, 1, "Neither ↵ nor Mod+↵ behind a sheet takes the verb's step");
    assert.equal(await browser.evaluate(`${element(mainView)}.hidden`), true, "The sheet stays open");
    await closeSheet(browser);

    // On arrival a plain ↵ at the panel root takes the verb's step through the same gate as Mod+↵: it prepares the
    // charge, and pressed again while the charge waits it never confirms it.
    await openGenerator(browser, server, workspace.id);
    await until(browser, "the reopened panel offers Verify", verifyAgain);
    await until(browser, "on arrival the panel root has focus", `document.activeElement === ${element(generator)}`);
    await key(browser, "Enter", 13);
    await until(browser, "↵ on arrival prepares a charge", `${verbIs("Verify models", "waiting")} && ${confirmCharge} !== null`);
    assert.equal(started.length, 2, "↵ on arrival takes exactly one step");
    assert.equal(await browser.evaluate(`document.activeElement === ${element(generator)}`), true, "The step leaves focus on the panel root");
    await key(browser, "Enter", 13);
    await Bun.sleep(300);
    assert.equal(benchmarks.length, 0, "↵ at the panel root never confirms a waiting charge");
    assert.equal(await browser.evaluate(`${confirmCharge} !== null`), true, "The charge still waits");
    await click(browser, cancel);
    await until(browser, "the cancelled charge offers Verify again", verifyAgain);

    // Mod+↵ takes the verb's step from a word and runs from the initialized revision (a run from the
    // stale one would refuse before its inventory); holding it takes no other step; one deliberate
    // press spends the charge once.
    await focusStatement(browser, "lane");
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await until(browser, "Mod+↵ prepares a charge from revision 1", `${verbIs("Verify models", "waiting")} && ${confirmCharge} !== null`);
    assert.equal(started.length, 3);
    await key(browser, "Enter", 13, { modifiers: CTRL, autoRepeat: true });
    await Bun.sleep(300);
    assert.equal(started.length, 3, "A held Mod+↵ never takes another step");
    assert.equal(benchmarks.length, 0);
    await click(browser, confirmCharge);
    await waitFor(() => benchmarks.length === 1, timeout, 50);
    await until(browser, "the refused spend stops the verification and the verb offers it again without a conflict", verifyAgain);
    assert.equal(benchmarks.length, 1, "One press spends once");
    assert(await browser.evaluate<boolean>(`[...document.querySelectorAll('${generator} .${G}stmt-part[data-tone="attention"]')].length > 0`),
      "The stopped verification says so on the line");
    assert.deepEqual(await readConfiguration(server, writer, target), prepared, "Neither the later runs nor the refused benchmark initialize, stage, promote or save anything");
    assert.deepEqual(cancels, [], "A spend refused at its start leaves no native job to cancel");

    // An include switch in a pool's accounts saves the choice, and keeps keyboard focus through the re-read it causes.
    const head = `[...document.querySelectorAll(${JSON.stringify(`${generator} .${G}phead-line`)})].find(el => el.getAttribute('aria-label').startsWith('Claude accounts'))`;
    const accountSwitch = element(`${generator} .${G}paccounts [role="switch"]`);
    await focusStatement(browser, "machine");
    await tabTo(browser, "the Claude pool head", head);
    await key(browser, "Enter", 13);
    await until(browser, "opening a pool's accounts gives its switch focus", `document.activeElement === ${accountSwitch} && ${accountSwitch}.getAttribute('aria-checked') === 'true'`);
    const switchName = await browser.evaluate<string>(`${accountSwitch}.getAttribute('aria-label')`);
    for (const included of [false, true]) {
      const revision = (await readConfiguration(server, writer, target)).revision;
      await key(browser, " ", 32);
      await waitFor(async () => (await readConfiguration(server, writer, target)).revision === revision + 1, timeout, 50);
      await until(browser, "the switch shows the saved choice and keeps focus through the re-read",
        `${accountSwitch}?.getAttribute('aria-checked') === '${included}' && document.activeElement === ${accountSwitch} && ${accountSwitch}.getAttribute('aria-label') === ${JSON.stringify(switchName)}`);
      assert.deepEqual((await readConfiguration(server, writer, target)).configuration?.accounts.manualDisabled, included ? [] : [fixtureAccounts([1]).accounts[0]!.reference],
        "The switch saves exactly that account's inclusion");
    }
    await key(browser, "Escape", 27);
    await until(browser, "Esc closes the accounts and returns focus to the pool head", `${element(`${generator} .${G}paccounts`)} === null && document.activeElement === ${head}`);
    fixture.check();
  } finally {
    await fixture.stop();
  }
  assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), deployments,
    "The verification charge never requests native approval");
  assert.deepEqual(await ownerAction(server, "core.terminals.listAll", {}), terminals);
}

// ---------------------------------------------------------------- shared drafts across destinations

/**
 * The container's catalog is staged with a recorded verification: caller-supplied provenance the
 * Code server checks against the saved choices and the passive account observation given with it.
 * It proves no probe; it lets Save, review and launch paths be reached. The browser then sees the
 * same fictional observation, and nothing else synthetic.
 */
async function sharedWorkbenchScenario(browser: BrowserInstance, viewerBrowser: BrowserInstance, server: TestServer, writer: TokenGrant, viewer: TokenGrant,
  first: Target, second: Target): Promise<void> {
  const before = await readConfiguration(server, writer, first);
  const preset = before.configuration?.accounts.presets.find(row => row.id === before.configuration?.accounts.activePreset);
  assert(preset, "The shared UI-created account pool must be active");
  const exclusion = { kind: "credential", scope: fixtureScope, provider: "anthropic", credentialId: 7 };
  const excluded = await callAction(server, writer.token, "atyrode.code.changeAccounts", { containerId: first.containerId,
    expectedRevision: before.revision, change: { kind: "update-preset", preset: { ...preset, disabled: [exclusion] } } });
  assert(excluded.ok, "An explicit unobserved exclusion is saved as a choice, never as a broker credential mutation");
  const bundled = await callAction(server, writer.token, "atyrode.omp.readModelCatalog", { providers: starterProviders });
  assert(bundled.ok);
  const metadata = ModelCatalogSnapshotSchema.parse(bundled.result);
  // A launch refuses a routed model OMP does not publish, so the four curated tiers are published anthropic models.
  const published = metadata.models.filter(model => model.provider === "anthropic").sort((left, right) => left.inputCostPerMillion - right.inputCostPerMillion).slice(0, 4);
  assert.equal(published.length, 4, "The pinned OMP publishes four anthropic models for the fixture's tiers");
  const document = { schemaVersion: 1, models: published.map((model, index) => ({
    key: `browser-model-${index + 1}`, provider: "anthropic", id: model.id, api: model.api, tier: index + 1,
    quotaBucket: null, inputCostPerMillion: index + 1, outputCostPerMillion: (index + 1) * 3, tokensPerSecond: 30,
    timeToFirstTokenMs: 100, contextWindow: 200_000, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], images: true,
  })) };
  const observation = fixtureAccounts();
  const excludedRevision = (excluded.result as Configuration).revision;
  const probe = await callAction(server, writer.token, "atyrode.code.composeProbe", { containerId: first.containerId, expectedRevision: excludedRevision, accounts: observation });
  assert(probe.ok, "Code composes the saved pool from the passive observation");
  const staged = await callAction(server, writer.token, "atyrode.code.stageCatalog", { containerId: first.containerId, expectedRevision: excludedRevision, document,
    verification: { ompVersion: metadata.ompVersion, inventoryObservedAt: Date.now() - 3_000, benchmarkCompletedAt: Date.now() - 2_000,
      accounts: observation, poolIdentityDigest: (probe.result as ActionResult<"composeProbe">).poolIdentityDigest } });
  assert(staged.ok, "Writer stages a real shared catalog with its recorded verification, without native installation");
  const reviewInput = { containerId: first.containerId, expectedRevision: (staged.result as Configuration).revision, source: "draft" };
  const reviewed = await callAction(server, writer.token, "atyrode.code.reviewCatalog", reviewInput);
  assert(reviewed.ok, "Catalog policy review remains possible without execution readiness");
  const promoted = await callAction(server, writer.token, "atyrode.code.promoteCatalog", { ...reviewInput, reviewDigest: (reviewed.result as ActionResult<"reviewCatalog">).reviewDigest });
  assert(promoted.ok, "Reviewed catalog is promoted through the real container CAS");
  const initial = promoted.result as Configuration;
  assert(initial.active?.provenance, "The promoted catalog carries its recorded verification");
  const destination = await callAction(server, writer.token, "atyrode.omp.describeDestination", first);
  const refusalCode = !destination.ok && /^omp_[a-z_]+$/.test(destination.denial.message) ? destination.denial.message : "unknown";
  assert(destination.ok, `A caller with native readiness authority can inspect the OMP destination (${refusalCode})`);
  assert((destination.result as OmpResult<"describeDestination">).operations.every(operation => !operation.nativeReady), "The real fixture has no native installation");
  const deployments = await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 });

  // The viewer's own Code view: every write refuses on authority, and edits stay a local preview.
  await arrangeWorkbench(server, viewer);
  const viewerTrace = await watchActions(viewerBrowser, server);
  try {
    await openGenerator(viewerBrowser, server, first.containerId);
    await until(viewerBrowser, "a viewer's verb refuses on authority, in neutral words",
      `${verb}.dataset.state === 'refused' && !!document.querySelector('${generator} .${G}stmt-part[data-tone="neutral"]')`);
    await focusStatement(viewerBrowser, "thinking");
    await key(viewerBrowser, "ArrowDown", 40);
    await key(viewerBrowser, "Enter", 13, { modifiers: CTRL });
    await click(viewerBrowser, verb);
    await Bun.sleep(300);
    assert.deepEqual(viewerTrace.requests.filter(request => /^atyrode\.code\.(initializeConfiguration|stageCatalog|promoteCatalog|select|changeAccounts)$/.test(request.name)), [],
      "A viewer's edits and presses never request a shared write");
  } finally { viewerTrace.stop(); }
  assert.deepEqual((await readConfiguration(server, viewer, first)).revision, initial.revision, "A viewer leaves the workspace team as it is");

  await arrangeWorkbench(server, writer);
  const reads: Record<string, unknown>[] = [];
  const offReads = browser.on("Network.requestWillBeSent", event => {
    const request = event.request as { url?: string; postData?: string } | undefined;
    if (request?.url?.endsWith("/api/actions/atyrode.code.readConfiguration") && request.postData) reads.push(JSON.parse(request.postData));
  });
  await browser.send("Network.enable", {});
  // The passive account observation the browser sees; one check below reads a Claude account as disabled.
  let observed = fixtureAccounts();
  const fixture = await intercept(browser, server, name => name === "atyrode.omp.accounts.accounts" ? { ok: true, result: observed } : undefined);
  try {
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await openGenerator(browser, server, first.containerId);
    await chooseMachine(browser, machineName);
    // The verification holds; the next step is the launch, which this machine has no permission for.
    await until(browser, "the verified team's next step is a refused launch", verbIs("Launch", "refused"));
    await assertRoles(browser, initial.selection?.advisor !== "off");
    assert((await seatedRoles(browser)).every(entry => document.models.some(model => model.key === entry.alias)),
      "Configured seats use the saved catalog, never bundled starter metadata");

    // Session options: one launch's skill choices, kept across sheets and refreshes, never saved.
    assert.equal(await browser.evaluate(`${workspaceButton("all skills off")} === undefined`), true, "Closed session options leave no skill control to point at");
    const skillCatalog = await callAction(server, writer.token, "atyrode.omp.readSkillCatalog", first);
    assert(skillCatalog.ok, "The real destination exposes its authorized empty optional catalog");
    assert.deepEqual((skillCatalog.result as OmpResult<"readSkillCatalog">).skills, [], "The offline fixture publishes no unreviewed skill source");
    await openOptions(browser);
    await until(browser, "ordinary loading starts with zero optional choices", `${skillsSection}?.dataset.mode === 'preserve'`);
    await click(browser, workspaceButton("all skills off"));
    await until(browser, "disable-all is a distinct launch choice", `${skillsSection}?.dataset.mode === 'disabled'`);
    await click(browser, workspaceButton("read skills again"));
    await closeOptions(browser);
    await openSheet(browser, "accounts");
    await closeSheet(browser);
    await openOptions(browser);
    assert.equal(await browser.evaluate(`${skillsSection}.dataset.mode`), "disabled", "Unrelated navigation and refresh preserve the ephemeral skill choice");
    await click(browser, workspaceButton("default skills"));
    assert.equal(await browser.evaluate(`${skillsSection}.dataset.mode`), "preserve", "Default skills restores ordinary loading instead of disabling it");
    await click(browser, workspaceButton("all skills off"));
    await closeOptions(browser);
    assert.equal(await browser.evaluate(`${sessionOptions}.getAttribute('aria-label').includes('skills off')`), true, "The closed session options still say their choice");

    // Local edits of the saved team: one keyboard step of thinking, the fourth tier, automatic plans.
    const savedThinking = await browser.evaluate<string>(wordValue("thinking"));
    await focusStatement(browser, "thinking");
    await key(browser, "ArrowUp", 38);
    await until(browser, "↑ raises the thinking", `${wordValue("thinking")} !== ${JSON.stringify(savedThinking)}`);
    const localThinking = await browser.evaluate<string>(wordValue("thinking"));
    await until(browser, "the fourth observed tier is available", `${option("tier", "elite")} !== undefined && !${option("tier", "elite")}.hasAttribute('aria-disabled')`);
    await choose(browser, "tier", "elite");
    await until(browser, "the fourth tier is on the line", `${wordValue("tier")} === 'elite'`);
    await choose(browser, "extras", "auto plans");
    await until(browser, "automatic plans are switched on", `${option("extras", "auto plans")}.getAttribute('aria-selected') === 'true'`);
    await key(browser, "Escape", 27);
    await until(browser, "Esc closes the extras without undoing them", `${slot("extras")}.dataset.open !== 'true' && ${option("extras", "auto plans")}.getAttribute('aria-selected') === 'true'`);
    await until(browser, "an edited verified team saves before its review", `${verbIs("Save & review", "ready")} && !!${statusFix("revert")}`);
    assert.equal(await browser.evaluate(wordValue("extras")), teamWords({ ...initial.selection!, planYolo: true }, family => family).extras,
      "The extras word names the switches that are on");
    assert.deepEqual(await browser.evaluate(`${JSON.stringify(WORDS)}.filter(word => document.querySelector('${generator} [data-stmt-word="' + word + '"]').dataset.edited === 'true')`),
      ["tier", "thinking", "extras"], "Exactly the edited words carry the edited mark");
    const edits = await browser.evaluate<string>(lineWords);

    // The edit rests on the saved team, not on the record's revision: the writer's own account edits (a preset made and
    // removed, which leaves the pool as it was) move the record on, and the edit stays ready to save, never a conflict.
    let revision = (await readConfiguration(server, writer, first)).revision;
    const spare = { id: "browser-spare-pool", name: "Spare pool", disabled: [] };
    for (const change of [{ kind: "create-preset", preset: spare }, { kind: "delete-preset", id: spare.id }]) {
      const changed = await callAction(server, writer.token, "atyrode.code.changeAccounts", { containerId: first.containerId, expectedRevision: revision, change });
      assert(changed.ok, "The writer edits the workspace's account presets beside the unsaved team");
      revision = (changed.result as Configuration).revision;
    }
    await panelReads(browser, revision);
    await until(browser, "own account edits leave the word edit ready to save, without a conflict",
      `${verbIs("Save & review", "ready")} && !!${statusFix("revert")} && !${statusFix("use theirs")} && ${lineWords} === ${JSON.stringify(edits)}`);

    // A lead no included account serves refuses the save, as the session door would refuse its launch. The panel reads the
    // Claude account as disabled (a GPT one stays) while the verification it stands on is not observed again: the save
    // is refused with the family named, and neither a press nor Mod+↵ writes.
    const gpt = { reference: { kind: "credential" as const, scope: fixtureScope, provider: "openai-codex", credentialId: 3 }, credentialId: 3,
      type: "api_key" as const, identityKey: null, email: null, disabled: false, blocks: [] };
    observed = { ...fixtureAccounts(), accounts: [...fixtureAccounts().accounts.map(account => account.credentialId === 1 ? { ...account, disabled: true } : account), gpt] };
    await focusStatement(browser, "verb");
    await key(browser, "r", 82);
    await until(browser, "a lead no account serves refuses the save and names its family",
      `${verbIs("Save & review", "refused")} && (${statusText}).includes('No Claude account included') && !!${statusFix("show Claude accounts")}`);
    await key(browser, "Enter", 13);
    await until(browser, "the refused press says why", `${liveRegion}.textContent.startsWith('Save & review: ')`);
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await Bun.sleep(300);
    assert.equal((await readConfiguration(server, writer, first)).revision, revision, "A save refused for an unserved lead writes nothing");
    observed = fixtureAccounts();
    await key(browser, "r", 82);
    await until(browser, "with the Claude account back the save is ready again", `${verbIs("Save & review", "ready")} && ${lineWords} === ${JSON.stringify(edits)}`);

    // Unsaved catalog and account drafts in their sheets.
    await openSheet(browser, "models");
    await click(browser, workspaceButton("Edit or import models"));
    const catalog = `${generator} [aria-label="Model catalog"]`;
    const pricingSummary = `[...document.querySelectorAll('${catalog} summary')].find(el => el.textContent === 'Pricing')`;
    const inputPrice = element(`${catalog} .plugin-atyrode_code_generator__model-editor fieldset details input[type="number"]`);
    assert.equal(await browser.evaluate(`(() => { const el = ${inputPrice}; const rect = el.getBoundingClientRect(); return !el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })()`), true, "Undisclosed pricing is not a pointer target");
    await click(browser, pricingSummary);
    await click(browser, inputPrice);
    await key(browser, "a", 65, { modifiers: CTRL });
    await browser.typeText("12.5");
    await click(browser, pricingSummary);
    assert.equal(await browser.evaluate(`${inputPrice}.value`), "12.5", "Closing metadata preserves the catalog edit");
    const importSummary = `[...document.querySelectorAll('${catalog} summary')].find(el => el.textContent === 'JSON import / export')`;
    await click(browser, importSummary);
    const importField = element(`${catalog} textarea:not([readonly])`);
    const importDraft = JSON.stringify({ ...document, models: document.models.map(model => ({ ...model, contextWindow: 180_000 })) });
    await click(browser, importField);
    await browser.typeText(importDraft);
    await closeSheet(browser);
    await openSheet(browser, "accounts");
    await until(browser, "the passive account observation settles before the editor gesture",
      `[...document.querySelectorAll('${generator} .plugin-atyrode_code__accounts .plugin-atyrode_code__account-observation, ${generator} .plugin-atyrode_code__accounts .plugin-atyrode_code__account-notice[role="status"]')].some(el => el.getClientRects().length)`);
    await control(browser, "shared saved account pool is editable", workspaceButton("Edit pool"), false);
    await click(browser, workspaceButton("Edit pool"));
    const accountDraft = element(`${generator} .plugin-atyrode_code__accounts form[aria-label="Saved account pool editor"] input[required]`);
    await control(browser, "shared account editor has opened", accountDraft, false);
    await click(browser, accountDraft);
    await key(browser, "End", 35);
    await browser.typeText(" local draft");
    const accountDraftName = `${preset.name} local draft`;
    await closeSheet(browser);

    // The second destination: the drafts and the edited team stay; the ad-hoc skill choice does not.
    await chooseMachine(browser, secondName);
    await openSheet(browser, "models");
    assert.equal(await browser.evaluate(`${importField}.value`), importDraft, "Unparsed JSON import stays local across machines");
    assert.equal(await browser.evaluate(`${inputPrice}.value`), "12.5", "Advanced catalog values survive navigation and destination changes");
    await closeSheet(browser);
    await openOptions(browser);
    await until(browser, "a new destination clears ad-hoc skill choices before they can be reused", `${skillsSection}.dataset.mode === 'preserve'`);
    await closeOptions(browser);
    await openSheet(browser, "accounts");
    assert.equal(await browser.evaluate(`${accountDraft}.value`), accountDraftName, "Visited account editor retains its unsaved preset across destinations");
    assert.equal(await browser.evaluate(`${element(`${generator} .plugin-atyrode_code__account-exclusions`)}.textContent.includes(${JSON.stringify(exclusion.scope)})`), true,
      "The account draft keeps its nonempty unobserved exclusion instead of importing another machine’s pool");
    await closeSheet(browser);
    assert.equal(await browser.evaluate(wordValue("thinking")), localThinking, "The local thinking survives the switch");
    assert.equal(await browser.evaluate(wordValue("tier")), "elite");
    assert.equal(await browser.evaluate(`${option("extras", "auto plans")}.getAttribute('aria-selected')`), "true", "planYolo remains a profile choice, not a native permission");

    // Save from the second destination: the press saves, and its review stops where this machine has no permission.
    await until(browser, "the edited team can be saved from the second destination", verbIs("Save & review", "ready"));
    const unsaved = (await readConfiguration(server, viewer, second)).revision;
    await focusStatement(browser, "verb");
    await key(browser, "Enter", 13);
    await waitFor(async () => (await readConfiguration(server, viewer, second)).revision === unsaved + 1, timeout, 50);
    await until(browser, "the saved team's review stops at this machine's missing permission", verbIs("Launch", "refused"));
    assert.equal(await browser.evaluate(`document.activeElement === ${verb}`), true, "The verb keeps focus from Save through its refusal");
    const saved = await readConfiguration(server, viewer, second);
    assert.equal(saved.configuration?.selection?.thinking, localThinking === "x-high" ? "xhigh" : localThinking, "Second destination saves to the shared profile");
    assert.equal(saved.configuration?.selection?.capability, 4, "The fourth capability saves unchanged from the second destination");
    assert.equal(saved.configuration?.selection?.planYolo, true);
    assert.deepEqual(saved.configuration?.accounts, initial.accounts, "Saving the team preserves shared account pools and exclusions");
    assert.deepEqual(saved.configuration?.active, initial.active, "Saving the team leaves the verified catalog as it is");
    await chooseMachine(browser, machineName);
    assert.equal(await browser.evaluate(wordValue("thinking")), localThinking, "Saved choices remain identical when returning to the first destination");
    await openSheet(browser, "models");
    assert.equal(await browser.evaluate(`${importField}.value`), importDraft);
    await closeSheet(browser);
    assert(reads.length > 0 && reads.every(input => input.containerId === first.containerId && Object.keys(input).length === 1),
      "Ordinary browser configuration reads use only the container, never per-machine fanout or implicit legacy fallback");

    // A narrow touch screen keeps session options and the line reachable.
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    try {
      await until(browser, "the line stays usable at a narrow viewport", `${verb}.getBoundingClientRect().width > 0`);
      const tap = await pointOf(browser, sessionOptions);
      await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tap] });
      await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await until(browser, "touch opens the session options", `!!${visibleSheet}?.contains(${skillsSection})`);
      await click(browser, workspaceButton("all skills off"));
      await key(browser, "Tab", 9);
      assert.equal(await browser.evaluate(`document.activeElement?.closest('[aria-label="Optional skills"]') === ${skillsSection} && !document.activeElement.matches(':disabled')`), true,
        "Skill controls remain keyboard reachable at a narrow viewport");
      await click(browser, workspaceButton("default skills"));
      await closeOptions(browser);
      await focusStatement(browser, "machine");
      assert.equal(await browser.evaluate(wordValue("thinking")), localThinking, "Responsive layout keeps the same team");
    } finally {
      await browser.send("Emulation.clearDeviceMetricsOverride", {});
      await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }

    // An unsaved edit is kept across a reload. A foreign write of the team it rests on, made while the panel was away,
    // brings it back as a conflict: the edit stays on show, nothing is rebased, and theirs is one press away.
    await focusStatement(browser, "thinking");
    await key(browser, "ArrowDown", 40);
    await until(browser, "↓ lowers the saved thinking", `${wordValue("thinking")} !== ${JSON.stringify(localThinking)} && ${verbIs("Save & review", "ready")}`);
    const kept = await browser.evaluate<string>(lineWords);
    await openGenerator(browser, server, first.containerId);
    await chooseMachine(browser, machineName);
    await until(browser, "the edited word survives a reload, still ready to save",
      `${lineWords} === ${JSON.stringify(kept)} && ${verbIs("Save & review", "ready")} && !!${statusFix("revert")} && ${slot("thinking")}.dataset.edited === 'true'`);
    await browser.goto("about:blank");
    const current = await readConfiguration(server, writer, first);
    const ours = current.configuration!.selection!;
    const theirs = { ...ours, advisor: ours.advisor === "audit" ? "review" : "audit" } satisfies Selection;
    const foreign = await callAction(server, writer.token, "atyrode.code.select", { containerId: first.containerId, expectedRevision: current.revision, selection: theirs });
    assert(foreign.ok, "The team is changed elsewhere while the panel is away");
    await openGenerator(browser, server, first.containerId);
    await chooseMachine(browser, machineName);
    await until(browser, "the kept edit comes back as a conflict with the write made meanwhile",
      `${verb}.dataset.state === 'refused' && !!${statusFix("use theirs")} && (${statusText}).includes('changed elsewhere') && ${lineWords} === ${JSON.stringify(kept)}`);
    assert.equal((await readConfiguration(server, writer, first)).revision, (foreign.result as Configuration).revision, "A kept edit in conflict writes nothing");
    await click(browser, statusFix("use theirs"));
    await until(browser, "theirs replaces the kept edit",
      `${wordValue("thinking")} === ${JSON.stringify(localThinking)} && ${wordValue("advisor")} === ${JSON.stringify(theirs.advisor)} && !${statusFix("revert")} && !${statusFix("use theirs")}`);
    const restored = await callAction(server, writer.token, "atyrode.code.select", { containerId: first.containerId, expectedRevision: (foreign.result as Configuration).revision, selection: ours });
    assert(restored.ok);
    await until(browser, "the line follows the record back", `${wordValue("advisor")} === ${JSON.stringify(ours.advisor)}`);
    fixture.check();
  } finally {
    offReads();
    await fixture.stop();
  }
  assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), deployments,
    "Destination selection, planYolo and shared profile edits never grant or revoke native approval");
}

/**
 * A writer whose Code panel has no workspace canvas beside it: container writes need only the
 * writer's authority, so the team still saves from here, while a launch, which places a terminal on
 * the canvas, waits for one and says so. Such a writer is never told the workspace is read-only.
 */
async function canvaslessWriterScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, target: Target): Promise<void> {
  const before = await readConfiguration(server, writer, target);
  const arranged = await callAction(server, writer.token, "core.space.setLayout", { layout: {
    root: { id: "root", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "atyrode.code.generator.launcher" } },
  } });
  assert(arranged.ok);
  const trace = await watchActions(browser, server);
  const fixture = await intercept(browser, server, name => name === "atyrode.omp.accounts.accounts" ? { ok: true, result: fixtureAccounts() } : undefined);
  const readOnly = `/read-only/i.test(${element(generator)}.textContent)`;
  try {
    await openGenerator(browser, server, target.containerId);
    assert.equal(await browser.evaluate(`${element(".react-flow")} === null`), true, "No workspace canvas is mounted beside the panel");
    await chooseMachine(browser, machineName);
    await until(browser, "without a canvas only the launch is refused, in neutral words that say what it needs",
      `${verbIs("Launch", "refused")} && (${statusText}).includes('Open Code beside the workspace canvas to launch') && !!document.querySelector('${generator} .${G}stmt-part[data-tone="neutral"]')`);
    assert.equal(await browser.evaluate(readOnly), false, "A writer without a canvas is never told the workspace is read-only");
    const thinking = await browser.evaluate<string>(wordValue("thinking"));
    await focusStatement(browser, "thinking");
    await key(browser, "ArrowDown", 40);
    await until(browser, "an edit offers Save, with no launch to chain", verbIs("Save", "ready"));
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await waitFor(async () => (await readConfiguration(server, writer, target)).revision === before.revision + 1, timeout, 50);
    await until(browser, "after the save only the launch waits for a canvas", verbIs("Launch", "refused"));
    assert.notEqual((await readConfiguration(server, writer, target)).configuration?.selection?.thinking, before.configuration?.selection?.thinking, "Save wrote the edit");
    await key(browser, "ArrowUp", 38);
    await until(browser, "the edit back is another Save", `${verbIs("Save", "ready")} && ${wordValue("thinking")} === ${JSON.stringify(thinking)}`);
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await waitFor(async () => (await readConfiguration(server, writer, target)).revision === before.revision + 2, timeout, 50);
    await until(browser, "the team is saved back", verbIs("Launch", "refused"));
    assert.deepEqual((await readConfiguration(server, writer, target)).configuration?.selection, before.configuration?.selection, "Saving back restores the exact team");
    assert.equal(await browser.evaluate(readOnly), false, "Nothing a canvas-less writer did is called read-only");
    assert.deepEqual(trace.requests.filter(request => /^(atyrode\.omp\.(reviewSession|prepareSession|resumeSession)|core\.terminals\.create)$/.test(request.name)), [],
      "Without a canvas nothing is reviewed for launch, prepared or placed");
    fixture.check();
  } finally {
    await fixture.stop();
    trace.stop();
  }
}

// ---------------------------------------------------------------- staged catalogs, manual catalogs, recovery

async function stagedCatalogScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant): Promise<void> {
  const workspace = await createContainer(server, "Text-only staged catalog recovery", "canvas");
  await arrangeWorkbench(server, writer);
  const target = { containerId: workspace.id };
  const metadata = await callAction(server, writer.token, "atyrode.omp.readModelCatalog", { providers: starterProviders });
  assert(metadata.ok);
  const selection: Selection = { lane: { kind: "mixed" }, capability: 2, thinking: "medium", advisor: "off", spark: false, priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any" };
  const document = catalogFromMetadata(ModelCatalogSnapshotSchema.parse(metadata.result), selection.budget);
  const textOnly = { ...document, models: document.models.map(model => ({ ...model, images: false })) };
  const initialized = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { ...target, expectedRevision: 0 });
  assert(initialized.ok);
  const staged = await callAction(server, writer.token, "atyrode.code.stageCatalog", { ...target, expectedRevision: (initialized.result as Configuration).revision, document: textOnly });
  assert(staged.ok, staged.ok ? "" : staged.denial.message);
  await openGenerator(browser, server, workspace.id);
  // The verb's one place to send the person: a staged-only workspace is reviewed in Models, a press away and never refused.
  await until(browser, "a staged-only workspace's verb is its review in Models", verbIs("Review in Models", "ready"));
  const metadataKeys = new Set(document.models.map(model => model.key));
  assert((await seatedRoles(browser)).every(entry => !metadataKeys.has(entry.alias)), "An unresolved saved catalog is never silently replaced by bundled starter seats");
  await click(browser, verb);
  await until(browser, "the verb opens Models", `${element(mainView)}.hidden === true && !!${visibleSheet}?.querySelector('[aria-label="Model catalog"]')`);
  assert.deepEqual((await readConfiguration(server, writer, target)).configuration?.draft?.document, textOnly);
  await closeSheet(browser);

  // Beside an active catalog a staged one changes nothing until reviewed; the footer says it waits.
  const waiting = await createContainer(server, "Staged beside active", "canvas");
  const waitingTarget = { containerId: waiting.id };
  const created = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { ...waitingTarget, expectedRevision: 0 });
  assert(created.ok);
  const first = await callAction(server, writer.token, "atyrode.code.stageCatalog", { ...waitingTarget, expectedRevision: (created.result as Configuration).revision, document });
  assert(first.ok);
  const firstReview = await callAction(server, writer.token, "atyrode.code.reviewCatalog", { ...waitingTarget, expectedRevision: (first.result as Configuration).revision, source: "draft" });
  assert(firstReview.ok);
  const active = await callAction(server, writer.token, "atyrode.code.promoteCatalog", { ...waitingTarget, expectedRevision: (first.result as Configuration).revision, source: "draft",
    reviewDigest: (firstReview.result as ActionResult<"reviewCatalog">).reviewDigest });
  assert(active.ok);
  const second = await callAction(server, writer.token, "atyrode.code.stageCatalog", { ...waitingTarget, expectedRevision: (active.result as Configuration).revision, document: textOnly });
  assert(second.ok);
  await openGenerator(browser, server, waiting.id);
  await until(browser, "the footer says a staged catalog waits", `${element(`${generator} .${G}footer-facts`)}?.textContent.includes('staged catalog waits in models')`);
  assert.equal(await browser.evaluate(`${verb}.textContent !== 'Review in Models'`), true, "Beside an active catalog the verb never sends the person to a staged one");
  assert.deepEqual(await seatedRoles(browser), expectedSeats(document, (active.result as Configuration).selection ?? selection),
    "The active catalog, not the staged one, seats the team");
}

async function manualCatalogScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant): Promise<void> {
  const document = { schemaVersion: 1, models: [1, 2, 3, 4].map(tier => ({
    key: `entry-model-tier-${tier}`, provider: "anthropic", id: `entry-native-tier-${tier}`, api: "anthropic-messages",
    tier, quotaBucket: null, inputCostPerMillion: tier, outputCostPerMillion: tier * 3,
    tokensPerSecond: 30, timeToFirstTokenMs: 100, contextWindow: 200_000,
    thinkingLevels: ["minimal", "low", "medium", "high"], images: true,
  })) };
  const importField = element(`${generator} .plugin-atyrode_code_generator__model-editor textarea:not([readonly])`);
  const exportField = element(`${generator} .plugin-atyrode_code_generator__model-editor textarea[readonly]`);
  const importSummary = `[...document.querySelectorAll('${generator} summary')].find(node => node.getClientRects().length && node.textContent === 'JSON import / export')`;
  const deployments = await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 });
  for (const competing of [false, true]) {
    const workspace = await createContainer(server, competing ? "Concurrent first catalog" : "Offline first catalog", "canvas");
    const target = { containerId: workspace.id };
    await openGenerator(browser, server, workspace.id);
    await usableStarter(browser);
    await openSheet(browser, "models");
    await click(browser, workspaceButton("Edit or import models"));
    await click(browser, importSummary);
    await click(browser, importField);
    await browser.typeText(JSON.stringify(document));
    await click(browser, workspaceButton("Import into draft"));
    assert.deepEqual(await readConfiguration(server, writer, target), { configuration: null, legacyMachineId: null, revision: 0 },
      "Importing locally never initializes shared policy");
    if (competing) {
      const initialized = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { ...target, expectedRevision: 0 });
      assert(initialized.ok);
      await control(browser, "a competing initial save cannot rebase an absent-state draft", workspaceButton("Stage and review changes"), true);
      assert.deepEqual(JSON.parse(await browser.evaluate<string>(`${exportField}.value`)), document, "The rejected first-save draft remains exportable");
      assert.equal((await readConfiguration(server, writer, target)).revision, 1, "The stale first-save draft does not overwrite a competing initialization");
      await closeSheet(browser);
      continue;
    }
    await click(browser, workspaceButton("Stage and review changes"));
    await control(browser, "first catalog is reviewed without native runtime setup", workspaceButton("Use this catalog"), false);
    const staged = await readConfiguration(server, writer, target);
    assert.equal(staged.revision, 2, "One explicit first save initializes once and stages once");
    assert.equal(staged.configuration?.active, null, "Review does not promote a catalog");
    assert.deepEqual(staged.configuration?.draft?.document, document);
    await closeSheet(browser);
    assert.deepEqual(await readConfiguration(server, writer, target), staged, "Returning to the main view never replaces a successfully staged manual catalog");
    // Reopen against the canonical saved draft, with no earlier local starter attached.
    await openGenerator(browser, server, workspace.id);
    // No selection is saved yet, so the preview uses the default profile, whose glance advisor is routed.
    await assertRoles(browser, true);
    assert((await seatedRoles(browser)).every(entry => document.models.some(model => model.key === entry.alias)),
      "The saved draft's own models seat its preview, not regenerated bundled choices");
    await until(browser, "a staged catalog's verb is its review in Models", verbIs("Review in Models", "ready"));
    assert.deepEqual(await readConfiguration(server, writer, target), staged, "Opening an existing draft does not stage, promote or overwrite it");
    await focusStatement(browser, "verb");
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await until(browser, "Mod+↵ takes the verb's step: it opens Models", `${element(mainView)}.hidden === true`);
    await click(browser, element(`${generator} [aria-label="Model catalog"] [data-action="atyrode.code.reviewCatalog"]`));
    await control(browser, "saved manual changes retain their existing review path", workspaceButton("Use this catalog"), false);
    await click(browser, workspaceButton("Use this catalog"));
    await waitFor(async () => (await readConfiguration(server, writer, target)).revision === 3, timeout, 50);
    const promoted = await readConfiguration(server, writer, target);
    assert.deepEqual(promoted.configuration?.active?.document, document, "Promotion uses the exact reviewed catalog");
    await until(browser, "using the catalog returns to the main view", `${element(mainView)}.hidden === false`);
    await until(browser, "promoted models seat the team in the main view",
      `[...document.querySelectorAll('${generator} .${G}seat-alias')].some(el => el.textContent.trim() === 'entry-model-tier-1' || el.textContent.trim().startsWith('entry-model-tier-'))`);
    // An authored catalog is unverified; verifying it needs native discovery the fixture does not have.
    await until(browser, "missing native runtime still prevents launch after local catalog authoring", verbIs("Verify models", "refused"));
  }
  assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), deployments,
    "First catalog authoring and conflicts never approve native access");
}

/** Delay or refuse configuration transport only; successful reads still come from
 * the real server. These checks establish browser recovery, not native readiness. */
async function configurationRecoveryScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, firstUse: { containerId: string }, configured: Target): Promise<void> {
  let holdConfiguration = true, failConfiguration = false;
  let failures = 0, recoveries = 0;
  const held = new Set<() => void>();
  const fixture = await intercept(browser, server, async (name, input) => {
    if (name !== "atyrode.code.readConfiguration") return undefined;
    assert(input.containerId === firstUse.containerId || input.containerId === configured.containerId,
      "Configuration fault injection stays inside the two fixture workspaces");
    if (holdConfiguration) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const release = () => { held.delete(release); resolve(); };
      held.add(release);
      await promise;
    }
    if (failConfiguration) {
      failures++;
      return refused("synthetic_configuration_read_failure");
    }
    if (input.containerId === configured.containerId) recoveries++;
    return undefined;
  });
  try {
    const modal = "dialog.plugin-atyrode_code__permission-dialog:modal";
    for (const destinationView of ["accounts", "models"] as const) {
      holdConfiguration = true;
      await openGenerator(browser, server, firstUse.containerId);
      await waitFor(() => held.size > 0, timeout, 50);
      await control(browser, "the sheets remain reachable before configuration arrives", footerLink(destinationView), false);
      await openSheet(browser, destinationView);
      holdConfiguration = false;
      for (const release of [...held]) release();
      await until(browser, "the absent configuration fills the hidden main view", `${element(mainView)}.hidden === true && ${slot("thinking")} !== null`);
      assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(modal)}) === null`), true,
        "A first-use review in a hidden frame must not make the visible document inert");
      await click(browser, `${visibleSheet}.querySelector('[aria-label="Back to Code"]')`);
      await until(browser, "the sheet returns focus to the link that opened it", `${element(mainView)}.hidden === false && document.activeElement === ${footerLink(destinationView)}`);
      await key(browser, "Tab", 9);
      const next = destinationView === "accounts" ? "models" : "setup";
      assert.equal(await browser.evaluate(`document.activeElement === ${footerLink(next)}`), true, "Keyboard navigation still walks the footer after the absent read");
      await key(browser, "Enter", 13);
      await until(browser, `keyboard opens ${next}`, `${element(mainView)}.hidden === true && document.activeElement?.getAttribute('aria-label') === 'Back to Code'`);
      await key(browser, "Escape", 27);
      await until(browser, "Esc returns from the sheet to its link", `${element(mainView)}.hidden === false && document.activeElement === ${footerLink(next)}`);
      await usableStarter(browser);
      assert.equal(await browser.evaluate(`${element(modal)} === null`), true, "The first-use main view does not open an automatic review");
      await openSheet(browser, "setup");
      await click(browser, workspaceButton("Machine"));
      await click(browser, workspaceButton("Choose capabilities to review"));
      await until(browser, "explicit capability review opens from its trigger", `${element(modal)} !== null && ${element(modal)}.getClientRects().length > 0`);
      await until(browser, "review offers one selection control per capability", `${element(modal)}.querySelectorAll('input[type="checkbox"]').length > 0`);
      assert.equal(await browser.evaluate(`${element(modal)}.querySelectorAll('input[type="checkbox"]:checked').length`), 0,
        "Opening capability review does not pre-accept native permissions");
      await key(browser, "Escape", 27);
      await until(browser, "explicit first-use review closes normally", `${element(modal)} === null`);
      assert.equal(await browser.evaluate(`document.activeElement === ${workspaceButton("Choose capabilities to review")}`), true,
        "Escape returns focus to the visible permission trigger");
      await closeSheet(browser);
      await openSheet(browser, "models");
      await closeSheet(browser);
      assert.equal(await browser.evaluate(`${element(modal)} === null`), true, "Revisiting does not repeat an automatic first-use modal");
    }
    assert.equal((await readConfiguration(server, writer, firstUse)).configuration, null,
      "Navigation and deferred dialogs never initialize the workspace");

    const arranged = await callAction(server, writer.token, "core.space.setLayout", { layout: {
      root: { id: "root", dir: "row", ratios: [1, 3], children: ["container", "usage"], ref: null },
      container: { id: "container", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "core.shell.container-view" } },
      usage: { id: "usage", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "atyrode.code.usage.usage" } },
    } });
    assert(arranged.ok);
    failConfiguration = true;
    await browser.goto(`${server.httpUrl}/p/${configured.containerId}`);
    const usage = ".plugin-atyrode_code_usage .plugin-atyrode_code__usage";
    const retry = element(`${usage} button[data-action="atyrode.omp.accounts.usage"]`);
    await control(browser, "standalone Usage can retry before any successful configuration", retry, false);
    assert(failures > 0, "The retry control follows an injected configuration failure");
    assert.equal(await browser.evaluate(`${element(`${usage} [data-account-pool]`)} === null`), true);
    failConfiguration = false;
    await click(browser, retry);
    await until(browser, "retry recovers the real saved account pool", `${element(`${usage} [data-account-pool="saved"]`)} !== null`);
    assert(recoveries > 0, "The retry reissues the configuration request to the real server");
    fixture.check();
  } finally {
    holdConfiguration = false;
    for (const release of [...held]) release();
    await fixture.stop();
  }
}

/** Fictional passive account metadata exercises recovery UI only. Native
 * authority, credentials, quota and provider success remain unconfigured. */
async function syntheticScopeRecoveryScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant): Promise<void> {
  const workspace = await createContainer(server, "Synthetic account scope recovery", "canvas");
  const target = { containerId: workspace.id };
  const reference = { kind: "credential" as const, scope: "synthetic-scope-a", provider: "anthropic", credentialId: 7 };
  const initialized = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { ...target, expectedRevision: 0 });
  assert(initialized.ok);
  const manual = await callAction(server, writer.token, "atyrode.code.changeAccounts", { ...target,
    expectedRevision: (initialized.result as Configuration).revision, change: { kind: "set-account", reference, enabled: false } });
  assert(manual.ok);
  const preset = await callAction(server, writer.token, "atyrode.code.changeAccounts", { ...target,
    expectedRevision: (manual.result as Configuration).revision,
    change: { kind: "create-preset", preset: { id: "synthetic-inactive", name: "Manual", disabled: [reference] } } });
  assert(preset.ok);
  const base = await readConfiguration(server, writer, target);
  const arranged = await callAction(server, writer.token, "core.space.setLayout", { layout: {
    root: { id: "root", dir: "row", ratios: [1, 3], children: ["canvas", "accounts"], ref: null },
    canvas: { id: "canvas", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "core.shell.container-view" } },
    accounts: { id: "accounts", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "atyrode.code.accounts.accounts" } },
  } });
  assert(arranged.ok);
  let scope = reference.scope, status: OmpResult<"accounts">["status"] = "fresh";
  const fixture = await intercept(browser, server, name => {
    if (name !== "atyrode.omp.accounts.accounts") return undefined;
    const result: OmpResult<"accounts"> = { scope, status, observedAt: status === "unavailable" ? null : Date.now(), accounts: status === "fresh" ? [{
      reference: { ...reference, scope }, credentialId: reference.credentialId, type: "api_key", identityKey: null, email: null, disabled: false, blocks: [],
    }] : [] };
    return { ok: true, result };
  });
  const recover = button("Recover all exclusions to this scope");
  try {
    await browser.goto(`${server.httpUrl}/p/${workspace.id}`);
    await until(browser, "exact excluded fixture slot is initially observed",
      `${element(`${accounts} .plugin-atyrode_code__account-row[data-included="false"]`)} !== null`);
    await click(browser, element(`${accounts} .plugin-atyrode_code__account-diagnostics > summary`));
    status = "unavailable";
    await click(browser, element(`${accounts} button[data-action="atyrode.omp.accounts.accounts"]`));
    await until(browser, "unavailable account observation pauses native and inclusion changes",
      `${element(`${accounts} .plugin-atyrode_code__account-observation`)}?.textContent.includes('Current availability unknown') === true`);
    scope = "synthetic-scope-b"; status = "fresh";
    await click(browser, element(`${accounts} button[data-action="atyrode.omp.accounts.accounts"]`));
    await until(browser, "first ownership-scope change exposes explicit recovery", `${recover} instanceof HTMLButtonElement`);
    await click(browser, `${recover}.parentElement.querySelector(':scope > summary')`);
    await control(browser, "fresh source evidence survives an unavailable intermediate observation", recover, false);
    scope = "synthetic-scope-c";
    await click(browser, element(`${accounts} button[data-action="atyrode.omp.accounts.accounts"]`));
    await until(browser, "later scope replaces the current observation, not the referenced recovery source",
      `${recover}.parentElement.textContent.includes('synthetic-scope-c') && ${recover}.parentElement.textContent.includes('synthetic-scope-a')`);
    await control(browser, "inactive and manual exclusions retain their original source proof", recover, false);
    await click(browser, recover);
    await waitFor(async () => (await readConfiguration(server, writer, target)).revision === base.revision + 1, timeout, 50);
    const saved = await readConfiguration(server, writer, target);
    assert.deepEqual(saved.configuration?.accounts.manualDisabled, [{ ...reference, scope }]);
    assert.deepEqual(saved.configuration?.accounts.presets[0]?.disabled, [{ ...reference, scope }]);
    assert.equal(saved.configuration?.accounts.activePreset, null, "A saved preset literally named Manual never changes manual mode");
    fixture.check();
  } finally {
    await fixture.stop();
  }
}

/** Synthetic OMP observations exercise folder controls only. The real upstream
 * owners are installed; no native consent or execution success is simulated. */
async function syntheticFolderReadinessScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, target: Target): Promise<void> {
  const saved = await readConfiguration(server, writer, target);
  assert(saved.configuration?.active);
  const deployments = await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 });
  const packed = JSON.parse(readFileSync(join(ompBundleDirectory, "atyrode.omp.manifold-plugin.json"), "utf8")) as {
    manifest: { machine: { operations: Record<string, unknown> } };
  };
  const routes = [
    { mode: "validate", operation: "atyrode.omp.validate-workspace", label: "Check existing folders" },
    { mode: "create", operation: "atyrode.omp.prepare-workspace", label: "Create new folders" },
  ] as const;
  let selected: typeof routes[number] = routes[0];
  let folderReady = false;
  const pins = { installationRevision: "synthetic-folder-ui-only", artifactSha256: "e".repeat(64), resourceBindingDigest: "f".repeat(64) };
  const reviewDigest = "a".repeat(64);
  const requested: Record<string, unknown>[] = [], unrelatedApprovals: string[] = [];
  const fixture = await intercept(browser, server, (name, input) => {
    if (["engine.jobs.applyDeployment", "engine.jobs.execute", "atyrode.omp.gateway.configureGateway", "atyrode.omp.accounts.promoteAccountRuntime", "atyrode.code.configureServices"].includes(name)) {
      unrelatedApprovals.push(name);
      return refused("synthetic_ui_never_approves_native_access");
    }
    if (name === "atyrode.omp.describeDestination") {
      if (input.containerId !== target.containerId || input.machineId !== target.machineId) return undefined;
      const result: OmpResult<"describeDestination"> = { ...target, pluginId: "atyrode.omp", state: "missing", reason: "synthetic_ui_only",
        services: [], deployment: null, operations: routes.map(route => {
          assert(packed.manifest.machine.operations[route.operation], "Synthetic scope must name a real upstream operation");
          const ready = folderReady && route === selected;
          return { operationId: route.operation, nativeReady: ready, callerRefusal: null, state: ready ? "ready" : "approval_required",
            reason: ready ? null : "native_consent_required", pins };
        }) };
      return { ok: true, result };
    }
    if (name === "engine.jobs.listRuns" && input.pluginId === "atyrode.omp" && routes.some(route => input.operationId === route.operation)) {
      assert.equal(input.machineId, target.machineId);
      return { ok: true, result: { runs: [], nextCursor: null } };
    }
    if (name === "atyrode.omp.reviewWorkspace") {
      assert.deepEqual(input, { ...target, mode: selected.mode });
      assert(folderReady);
      const result: OmpResult<"reviewWorkspace"> = { destination: target, operationId: selected.operation, pins, reviewDigest };
      return { ok: true, result };
    }
    if (name === "atyrode.omp.prepareWorkspace") {
      assert.deepEqual(input, { ...target, mode: selected.mode, reviewDigest }, "Preparation preserves the exact native destination, mode and review");
      requested.push(input);
      return refused("synthetic_folder_execution_refused");
    }
    return undefined;
  });
  try {
    await arrangeWorkbench(server, writer);
    await openGenerator(browser, server, target.containerId);
    await chooseMachine(browser, machineName);
    await openSheet(browser, "setup");
    await click(browser, workspaceButton("Folders"));
    const onboarding = element(`${generator} [aria-label="Code setup"]`);
    // Setup re-reads the destination through its own Refresh status, inside the runtime diagnostics.
    const diagnostics = `[...document.querySelectorAll(${JSON.stringify(`${generator} [aria-label="Code setup"] details`)})].find(el => el.querySelector(':scope > summary')?.textContent === 'Runtime status and diagnostics')`;
    await click(browser, `${diagnostics}.querySelector(':scope > summary')`);
    for (const route of routes) {
      selected = route; folderReady = false;
      await click(browser, workspaceButton("Refresh status"));
      for (const option of routes) {
        await control(browser, "unapproved folders offer only explicit scope review", workspaceButton(`Review: ${option.label}`), false);
        assert.equal(await browser.evaluate(`${element(`${generator} section[aria-label="${option.label}"] button[data-action="atyrode.omp.prepareWorkspace"]`)} === null`), true,
          "Unapproved folder scope cannot be executed");
      }
      folderReady = true;
      await click(browser, workspaceButton("Refresh status"));
      await control(browser, "selected folder action resumes without discovery or session readiness", workspaceButton(route.label), false);
      const unselected = routes.find(option => option !== route)!;
      await control(browser, "unselected folder scope still requires its own review", workspaceButton(`Review: ${unselected.label}`), false);
      assert.equal(await browser.evaluate(`${element(`${generator} section[aria-label="${unselected.label}"] button[data-action="atyrode.omp.prepareWorkspace"]`)} === null`), true);
      await click(browser, workspaceButton(route.label));
      await waitFor(() => requested.length === routes.indexOf(route) + 1, timeout, 50);
      await until(browser, "synthetic folder execution refusal is visible", `!!${onboarding}?.querySelector('.plugin-atyrode_code__warning')?.textContent`);
      await control(browser, "refused folder request can be reconsidered", workspaceButton(route.label), false);
    }
    assert.deepEqual(requested.map(input => input.mode), ["validate", "create"]);
    assert.deepEqual(unrelatedApprovals, [], "Folder preparation never requests unrelated native approval or configuration");
    await closeSheet(browser);
    fixture.check();
  } finally {
    await fixture.stop();
  }
  assert.deepEqual(await readConfiguration(server, writer, target), saved, "Synthetic folder transitions never mutate real Code choices");
  assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), deployments,
    "Synthetic folder readiness is not native approval evidence and creates no deployments");
}

// ---------------------------------------------------------------- review, launch and resume

/** Synthetic OMP/terminal observations exercise browser decisions only. Native
 * preparation refuses; public terminal navigation uses synthetic correlations.
 * This cannot create credentials, approve consent or open a new terminal. */
async function syntheticPreviewScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, first: Target, second: Target): Promise<void> {
  let saved = await readConfiguration(server, writer, first);
  assert(saved.configuration?.active?.provenance && saved.configuration.selection);
  assert.equal(saved.configuration.selection.planYolo, true, "The shared scenario saved automatic plans");
  const packed = JSON.parse(readFileSync(join(ompBundleDirectory, "atyrode.omp.manifold-plugin.json"), "utf8")) as {
    manifest: { machine: { operations: Record<string, unknown> } };
  };
  assert(packed.manifest.machine.operations[LAUNCH_OPERATION_ID], "Synthetic review names the installed upstream launch operation");
  const pins = { installationRevision: "synthetic-ui-only", artifactSha256: "b".repeat(64), resourceBindingDigest: "c".repeat(64) };
  const reviewDigest = "d".repeat(64);
  const defaults = await callAction(server, writer.token, "atyrode.omp.readDefaults", {});
  assert(defaults.ok);
  const defaultsRevision = (defaults.result as OmpResult<"readDefaults">).revision;
  const reviews: Record<string, unknown>[] = [];
  let prepareRequests = 0;
  let reviewedSkills: OmpResult<"reviewSession">["skills"] = { mode: "preserve", catalogRevision: null, selected: [] };
  const skillEntry = (id: string, title: string, conflicts: string[] = []): OmpResult<"readSkillCatalog">["skills"][number] => ({
    id, name: id, title, purpose: `Synthetic ${title} instructions`, revision: "source-v1",
    source: { jobId: `synthetic-${id}`, output: "skill", sha256: "a".repeat(64) },
    license: { spdx: "MIT" }, review: { reviewedBy: "synthetic-owner", reviewedAt: 1000, reference: "synthetic-review" }, conflicts,
  });
  const skillCatalog: OmpResult<"readSkillCatalog"> = { revision: 7,
    skills: [skillEntry("alpha", "Alpha"), skillEntry("beta", "Beta", ["alpha"]), skillEntry("gamma", "Gamma")],
    sets: [{ id: "pair", title: "Reviewed pair", skillIds: ["alpha", "gamma"] }],
    updatedAt: 1000, updatedBy: "synthetic-owner" };
  let sessionVisible = true, secondReadFails = false, terminalInventoryFailed = false, firstReads = 0;
  const resumedInputs: Record<string, unknown>[] = [];
  const savedSessionId = "7ab82ad4-8c9e-4166-8130-472c7cae1559";
  // The first machine keeps twelve sessions in one folder, the newest of them the one resumed below, and one in another
  // folder: one row per folder, with the folder's older sessions in its row's drum.
  const listedAt = Date.now();
  const folderSessions = [{ id: savedSessionId, title: "Synthetic saved work", cwd: "/workspace", updatedAt: listedAt - 60_000 },
    ...Array.from({ length: 11 }, (_, index) => ({ id: `7ab82ad4-8c9e-4166-8130-4720000000${index + 10}`, title: `Earlier work ${index + 1}`,
      cwd: "/workspace", updatedAt: listedAt - (index + 2) * 3_600_000 }))];
  const otherFolder = { id: "7ab82ad4-8c9e-4166-8130-472000000099", title: "Other folder work", cwd: "/workspace/other", updatedAt: listedAt - 30 * 3_600_000 };
  const fleetMachines = (await ownerAction(server, "core.machines.list", {}) as { machines: MachineSummary[] }).machines;
  const realTerminals = await ownerAction(server, "core.terminals.listAll", {});
  const terminalBase: TerminalSummary = { id: "synthetic-legacy", machineId: first.machineId, name: "Synthetic saved work",
    createdAt: 1000, status: "running", exitCode: null, homeId: first.containerId, unplaced: false };
  let fleetTerminals: TerminalSummary[] = [terminalBase, { ...terminalBase, id: "synthetic-second", machineId: second.machineId,
    session: { harness: "atyrode.omp", machineId: second.machineId, sessionId: savedSessionId } }];
  const navigations: string[] = [];
  const offNavigations = browser.on("Page.navigatedWithinDocument", event => { navigations.push(event.url as string); });
  const heldReview = holdable(), heldList = holdable();
  let holdNextReview = false, holdNextList = false;
  const fixture = await intercept(browser, server, async (name, input) => {
    switch (name) {
      case "core.machines.list": return { ok: true, result: { machines: fleetMachines } };
      case "core.terminals.listAll": return terminalInventoryFailed ? refused("synthetic_terminal_inventory_failed") : { ok: true, result: { terminals: fleetTerminals } };
      case "atyrode.omp.accounts.accounts": return { ok: true, result: fixtureAccounts() };
      case "atyrode.omp.describeDestination": {
        assert.equal(input.containerId, first.containerId);
        assert(input.machineId === first.machineId || input.machineId === second.machineId);
        const ready = input.machineId === first.machineId;
        const result: OmpResult<"describeDestination"> = { containerId: first.containerId, machineId: input.machineId as string, pluginId: "atyrode.omp",
          state: ready ? "ready" : "missing", reason: ready ? null : "synthetic_unprepared_destination", deployment: null, services: [],
          operations: [{ operationId: LAUNCH_OPERATION_ID, pins, nativeReady: ready, callerRefusal: null, state: ready ? "ready" : "missing", reason: ready ? null : "native_resources_missing" }] };
        return { ok: true, result };
      }
      case "atyrode.omp.readSkillCatalog":
        return { ok: true, result: input.machineId === first.machineId ? structuredClone(skillCatalog) : { revision: 0, skills: [], sets: [], updatedAt: null, updatedBy: null } };
      case "atyrode.omp.reviewSession": {
        assert.equal(input.containerId, first.containerId);
        assert.equal(input.machineId, first.machineId, "An unprepared destination never requests a session review");
        assert.equal(input.expectedDefaultsRevision, defaultsRevision);
        reviews.push(input);
        const choice = input.skills as OmpInput<"reviewSession">["skills"];
        if (choice?.mode === "select") {
          assert.equal(choice.expectedCatalogRevision, skillCatalog.revision);
          const ids = new Set([...choice.skillIds, ...choice.setIds.flatMap(id => skillCatalog.sets.find(set => set.id === id)!.skillIds)]);
          reviewedSkills = { mode: "selected", catalogRevision: skillCatalog.revision, selected: skillCatalog.skills.filter(skill => ids.has(skill.id)) };
        } else reviewedSkills = { mode: choice?.mode === "disabled" || input.automation ? "disabled" : "preserve", catalogRevision: null, selected: [] };
        if (holdNextReview) { holdNextReview = false; await heldReview.wait(); }
        return { ok: true, result: { destination: first, operationId: LAUNCH_OPERATION_ID, pins, reviewDigest, defaultsRevision,
          effectiveOverlay: input.overlay, accountPool: input.accountPool, automation: input.automation ?? { mode: "ordinary" }, skills: reviewedSkills } };
      }
      case "atyrode.omp.prepareSession": {
        prepareRequests++;
        const { skills: _draftSkills, ...reviewed } = reviews.at(-1)!;
        const skills = reviewedSkills.mode === "selected" ? { mode: "select",
          expectedCatalogRevision: reviewedSkills.catalogRevision, skillIds: reviewedSkills.selected.map(skill => skill.id), setIds: [] }
          : reviewedSkills.mode === "disabled" ? { mode: "disabled" } : undefined;
        assert.deepEqual(input, { ...reviewed, ...(skills ? { skills } : {}), reviewDigest },
          "Prepare consumes native-reviewed effective selection, including canonical set expansion");
        return refused("omp_review_changed");
      }
      case "atyrode.omp.listSessions": {
        assert(input.machineId === first.machineId || input.machineId === second.machineId);
        if (input.machineId === first.machineId) firstReads++;
        if (holdNextList && input.machineId === first.machineId) { holdNextList = false; await heldList.wait(); }
        if (input.machineId === second.machineId && secondReadFails) return refused("synthetic_inventory_failed");
        if (!sessionVisible) return { ok: true, result: [] };
        return { ok: true, result: input.machineId === first.machineId ? [...folderSessions, otherFolder] : [folderSessions[0]] };
      }
      case "atyrode.omp.resumeSession":
        resumedInputs.push(input);
        return refused("omp_session_unavailable");
      default: return undefined;
    }
  });
  const savedRow = (machineId: string) => element(`${generator} [data-kind="saved"][data-session-id="${savedSessionId}"][data-machine-id="${machineId}"]`);
  const rowVerb = (machineId: string, verbName: string) => `${savedRow(machineId)}?.querySelector('[data-verb="${verbName}"]')`;
  const runningRow = (terminalId: string) => element(`${generator} [data-kind="running"][data-terminal-id="${terminalId}"]`);
  const failureLine = `!!document.querySelector('${generator} .${G}stmt-line .${G}stmt-part[data-tone="attention"]')`;
  const reviewsFor = (count: number) => async () => reviews.length >= count;
  try {
    await arrangeWorkbench(server, writer);
    // One recent team, so a digit pressed where the panel's keys must not act would recall it.
    const savedAdvisor = saved.configuration.selection.advisor;
    await rememberTeam(browser, writer.principal.id, first.containerId, { ...saved.configuration.selection, advisor: savedAdvisor === "off" ? "glance" : "off" });
    await openGenerator(browser, server, first.containerId);
    await chooseMachine(browser, machineName);

    // The saved team reviews itself once its inputs settle, so Launch is one press (spec §3).
    await until(browser, "the saved team is reviewed without a press", verbIs("Launch", "ready"));
    assert.equal(reviews.length, 1, "One automatic review of the settled saved team");
    assert.equal(reviews[0]!.skills, undefined, "An ordinary launch carries no skill choice");
    assert(await browser.evaluate<boolean>(`(${statusText}).includes(${JSON.stringify(machineName)})`), "The line says where the team was reviewed");
    assert.match(await browser.evaluate<string>(`${element(`${generator} .${G}stmt-line`)}.textContent`), /^\d+ on Claude$/, "The team's count names its family");

    // Skills: a set and an individual choice review as one effective selection.
    await openOptions(browser);
    await click(browser, optionSwitch("Optional skills", "Reviewed pair"));
    await click(browser, optionSwitch("Optional skills", "Alpha"));
    await waitFor(reviewsFor(2), timeout, 50);
    await until(browser, "overlapping skill selection is native-reviewed", `${verbIs("Launch", "ready")} && document.querySelectorAll('${generator} [aria-label="Selected optional skills"] li').length > 0`);
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('${generator} [aria-label="Selected optional skills"] li .${G}options-skill-title')].map(el => el.textContent)`),
      ["Alpha", "Gamma"], "A set and individual choice render one effective selection without duplicates");
    await closeOptions(browser);
    await focusStatement(browser, "verb");
    await key(browser, "Enter", 13);
    await until(browser, "the refused preparation is said on the line", `${failureLine} && ${verbIs("Review", "ready")}`);
    assert.equal(prepareRequests, 1);
    assert.equal(await browser.evaluate(`document.activeElement === ${verb}`), true, "The verb keeps focus through Launch and its refusal");
    await until(browser, "the refusal is announced", `${liveRegion}.textContent !== '' && (${statusText}).includes(${liveRegion}.textContent)`);
    // Outcome and refusal lines clear on any change to the team.
    await key(browser, "ArrowRight", 39);
    await key(browser, "ArrowRight", 39);
    await key(browser, "ArrowRight", 39);
    await until(browser, "focus on the thinking word", `document.activeElement === ${slot("thinking")}`);
    const savedThinking = await browser.evaluate<string>(wordValue("thinking"));
    await key(browser, "ArrowDown", 40);
    await until(browser, "a team change clears the refusal", `!${failureLine}`);
    await key(browser, "ArrowUp", 38);
    await until(browser, "the saved team is back without a draft", `${wordValue("thinking")} === ${JSON.stringify(savedThinking)} && !${statusFix("revert")}`);

    // A declared conflict, a stale catalog and a cleared choice; disable-all reviews as such.
    await openOptions(browser);
    await click(browser, optionSwitch("Optional skills", "Beta"));
    await until(browser, "a declared skill conflict refuses the step", `${verb}.dataset.state === 'refused' && !!${statusFix("open options")}`);
    await click(browser, optionSwitch("Optional skills", "Beta"));
    await until(browser, "resolving the conflict restores the step", `${verb}.dataset.state === 'ready'`);
    skillCatalog.revision++;
    await click(browser, workspaceButton("read skills again"));
    await until(browser, "a stale catalog cannot silently rebase the selection", `${verb}.dataset.state === 'refused'`);
    await click(browser, workspaceButton("default skills"));
    await until(browser, "a cleared choice can be reviewed again", `${verb}.dataset.state === 'ready'`);
    const beforeDisable = reviews.length;
    await click(browser, workspaceButton("all skills off"));
    await waitFor(reviewsFor(beforeDisable + 1), timeout, 50);
    await until(browser, "disable-all is reviewed", verbIs("Launch", "ready"));
    assert.deepEqual(reviews.at(-1)!.skills, { mode: "disabled" }, "The actual browser sends disable-all through the ordinary workflow");

    // Restricted automation reviews as such and suppresses ambient skills; any tool change needs a new review.
    const restricted = optionSwitch("Automation policy", "restricted automation"), readTool = optionSwitch("Automation policy", "read");
    await turn(browser, restricted, true);
    await turn(browser, readTool, true);
    const beforeRestricted = reviews.length;
    await click(browser, workspaceButton("default skills"));
    await waitFor(async () => reviews.length > beforeRestricted && JSON.stringify(reviews.at(-1)!.automation) === JSON.stringify({ mode: "restricted", toolNames: ["read"], delegation: "disabled" }), timeout, 50);
    await until(browser, "native restricted policy is rendered", `${element(`${generator} [data-effective-automation]`)}?.dataset.effectiveAutomation === 'restricted'`);
    assert.equal(reviews.at(-1)!.skills, undefined, "Restricted review suppresses ambient defaults even without an explicit skill choice");
    await closeOptions(browser);
    await click(browser, verb);
    await until(browser, "restricted preparation refusal is visible", `${failureLine} && ${verbIs("Review", "ready")}`);
    await openOptions(browser);
    const beforeTool = reviews.length;
    await turn(browser, readTool, false);
    await waitFor(reviewsFor(beforeTool + 1), timeout, 50);
    assert.deepEqual((reviews.at(-1)!.automation as { toolNames: string[] }).toolNames, [], "A tool change is reviewed again, never launched on the old review");
    await turn(browser, restricted, false);
    await closeOptions(browser);
    await until(browser, "the ordinary session is reviewed", verbIs("Launch", "ready"));

    // A machine without permission refuses; returning reviews afresh, never resurrecting the old review.
    const reviewsBeforeSecond = reviews.length, preparations = prepareRequests;
    await chooseMachine(browser, secondName);
    await until(browser, "the second destination cannot launch", `${verb}.dataset.state === 'refused' && !!${statusFix("enable in Setup")}`);
    await Bun.sleep(1_200);
    assert.equal(reviews.length, reviewsBeforeSecond, "Choosing an unprepared machine requests no review");
    assert.equal(prepareRequests, preparations, "Destination selection never prepares a launch");
    await chooseMachine(browser, machineName);
    await waitFor(reviewsFor(reviewsBeforeSecond + 1), timeout, 50);
    await until(browser, "returning reviews afresh", verbIs("Launch", "ready"));

    // While a review is in flight no team or machine edit lands, and the focused word keeps focus.
    holdNextReview = true;
    await openOptions(browser);
    await click(browser, workspaceButton("all skills off"));
    await closeOptions(browser);
    await waitFor(() => heldReview.held, timeout, 50);
    await until(browser, "the verb says the review runs", verbIs("Reviewing…", "busy"));
    await focusStatement(browser, "machine");
    const advisor = await browser.evaluate<string>(wordValue("advisor"));
    const announced = await browser.evaluate<string>(`${liveRegion}.textContent`);
    await key(browser, "ArrowDown", 40);
    await key(browser, "ArrowLeft", 37);
    await key(browser, "ArrowLeft", 37);
    await key(browser, "ArrowUp", 38);
    await until(browser, "the refused edits say why", `${liveRegion}.textContent !== ${JSON.stringify(announced)}`);
    assert.equal(await browser.evaluate(wordValue("machine")), machineName, "No machine edit lands while a review runs");
    assert.equal(await browser.evaluate(wordValue("advisor")), advisor, "No team edit lands while a review runs");
    heldReview.release();
    await until(browser, "the held review completes for the unchanged line", verbIs("Launch", "ready"));
    assert.equal(await browser.evaluate(`document.activeElement === ${slot("advisor")}`), true, "Keyboard focus stays on its word through the gate");
    await click(browser, verb);
    await until(browser, "launch refusal is shown and consumes its review", `${failureLine} && ${verbIs("Review", "ready")}`);
    await openOptions(browser);
    await click(browser, workspaceButton("default skills"));
    await closeOptions(browser);
    // The cleared choice is reviewed on its own, so no review is still due when the steps below are counted.
    await until(browser, "the cleared choice is reviewed", verbIs("Launch", "ready"));

    // Earlier statements: saved sessions are read per machine; only an exact terminal correlation is a running row.
    // A Read button goes as its read starts; focus follows the read to the machine's first row verb, never out of the panel.
    await focusStatement(browser, "machine");
    await tabTo(browser, "the first machine's Read", element(`${generator} [data-read="${first.machineId}"]`));
    await key(browser, "Enter", 13);
    await until(browser, "the first machine's saved session is listed and its Resume takes focus",
      `${savedRow(first.machineId)} !== null && document.activeElement === ${rowVerb(first.machineId, "resume")}`);

    // One row per folder, each showing its newest session; the folder's older sessions are in that row's drum, never behind a count.
    const firstRows = `[...document.querySelectorAll('${generator} [data-kind="saved"][data-machine-id="${first.machineId}"]')]`;
    assert.deepEqual(await browser.evaluate(`${firstRows}.map(row => row.dataset.sessionId)`), [savedSessionId, otherFolder.id], "One row per folder, each showing its newest session");
    assert.equal(await browser.evaluate(`${savedRow(first.machineId)}.querySelectorAll('[role="option"]').length`), folderSessions.length, "Every session of the folder is in its row's drum");
    assert.equal(await browser.evaluate(`[...document.querySelectorAll('${generator} [aria-label="Earlier statements"] button')].some(el => /\\b(show|more)\\b/i.test(el.textContent))`), false,
      "No count toggle hides saved sessions");
    // The machine is said once, by its group's head, with its read's age and a quiet read again.
    const firstRead = element(`${generator} [data-read-state="read"][data-machine-id="${first.machineId}"]`);
    assert.deepEqual(await browser.evaluate(`({ heads: [...document.querySelectorAll('${generator} .${G}earlier-machine')].filter(el => el.textContent === ${JSON.stringify(machineName)}).length,
      named: ${firstRead}?.closest('li')?.querySelector('.${G}earlier-machine')?.textContent, age: / read \\S/.test(${firstRead}?.textContent ?? ''),
      again: ${firstRead}?.querySelector('[data-read="${first.machineId}"]')?.textContent })`),
      { heads: 1, named: machineName, age: true, again: "read again" }, "A read machine's head names it once, with its read's age and read again");
    assert.match(await browser.evaluate<string>(`${rowVerb(first.machineId, "resume")}.getAttribute('aria-label')`), /^Resume .+ as saved$/, "Resume names its session and that it resumes as saved");
    assert.match(await browser.evaluate<string>(`${rowVerb(first.machineId, "resume-with-team")}.getAttribute('aria-label')`), /^Resume .+ with the current team$/,
      "The other resume names its session and the current team");

    // The drum answers the statement's keys: ↓/↑ turn the shown session and ↵ opens the folder's list, which then owns its keys:
    // from it a digit recalls no team and Mod+↵ takes no step.
    const folderRow = `${firstRows}[0]`;
    const drum = `${folderRow}?.querySelector('[role="listbox"]')`;
    await tabTo(browser, "the folder's session drum", drum, true);
    await key(browser, "ArrowDown", 40);
    await until(browser, "↓ shows the folder's next older session", `${folderRow}?.dataset.sessionId === ${JSON.stringify(folderSessions[1]!.id)} && document.activeElement === ${drum}`);
    await key(browser, "ArrowUp", 38);
    await until(browser, "↑ shows the newest again", `${folderRow}?.dataset.sessionId === ${JSON.stringify(savedSessionId)} && document.activeElement === ${drum}`);
    await key(browser, "Enter", 13);
    await until(browser, "↵ opens the folder's sessions as a popover", `${drum}?.dataset.open === 'true' && ${drum}.dataset.popover !== undefined`);
    const team = await browser.evaluate<string>(lineWords), steps = { prepares: prepareRequests, reviews: reviews.length };
    await key(browser, "1", 49);
    await Bun.sleep(300);
    assert.equal(await browser.evaluate(lineWords), team, "A digit pressed in the open session drum recalls no team");
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await Bun.sleep(300);
    assert.deepEqual({ prepares: prepareRequests, reviews: reviews.length }, steps, "Mod+↵ in the open session drum takes no step");
    assert.equal(await browser.evaluate(lineWords), team);
    if (await browser.evaluate<boolean>(`${drum}?.dataset.open === 'true'`)) await key(browser, "Escape", 27);
    await until(browser, "the drum closes on the newest session", `${drum}?.dataset.open !== 'true' && ${folderRow}?.dataset.sessionId === ${JSON.stringify(savedSessionId)}`);

    // A per-machine read failure is said and offers Read again, never shown as an empty machine.
    secondReadFails = true;
    await click(browser, element(`${generator} [data-read="${second.machineId}"]`));
    await until(browser, "the second machine's read failure is said, not shown as empty",
      `${element(`${generator} [data-read-state="failed"][data-machine-id="${second.machineId}"]`)} !== null && ${element(`${generator} [data-read-state="empty"][data-machine-id="${second.machineId}"]`)} === null`);
    secondReadFails = false;
    await click(browser, element(`${generator} [data-read-state="failed"][data-machine-id="${second.machineId}"] [data-read]`));
    await until(browser, "reading again recovers", `${element(`${generator} [data-read-state="read"][data-machine-id="${second.machineId}"]`)} !== null && ${element(`${generator} [data-read-state="failed"][data-machine-id="${second.machineId}"]`)} === null`);
    await until(browser, "the exact correlated terminal is a running row", `${runningRow("synthetic-second")} !== null`);
    assert.equal(await browser.evaluate(`${runningRow("synthetic-legacy")} === null`), true, "Legacy name/header similarity does not fabricate a running session");
    assert.equal(await browser.evaluate(`${savedRow(second.machineId)} === null`), true, "A running session is not also offered as saved");

    // The panel's refresh reads every machine already read again; a machine read again keeps its rows on show meanwhile.
    const readsBefore = firstReads;
    holdNextList = true;
    await focusStatement(browser, "machine");
    await key(browser, "r", 82);
    await waitFor(() => heldList.held, timeout, 50);
    assert(firstReads > readsBefore, "The refresh reads the machine again");
    await until(browser, "a machine read again keeps its rows while it reads",
      `${element(`${generator} [data-read-state="reading"][data-machine-id="${first.machineId}"]`)} !== null && ${savedRow(first.machineId)} !== null`);
    heldList.release();
    await until(browser, "the read again lands", `${firstRead} !== null && ${savedRow(first.machineId)} !== null`);
    await click(browser, rowVerb(first.machineId, "resume"));
    await waitFor(() => resumedInputs.length === 1, timeout, 50);
    await until(browser, "saved-state refusal is visible", failureLine);
    assert.deepEqual(resumedInputs[0], { machineId: first.machineId, sessionId: savedSessionId }, "Preserve resume must not silently inject a profile");
    await until(browser, "automatic plans refuse resuming with this team before native resume",
      `${rowVerb(first.machineId, "resume-with-team")}?.getAttribute('aria-disabled') === 'true'`);
    await click(browser, rowVerb(first.machineId, "resume-with-team"));
    await until(browser, "the refused row verb says what and why", `${liveRegion}.textContent.startsWith(${rowVerb(first.machineId, "resume-with-team")}.getAttribute('aria-label') + ' · ')`);
    assert.equal(resumedInputs.length, 1, "Unsupported profile policy must not be silently dropped");
    assert.deepEqual(await readConfiguration(server, writer, first), saved, "Native observations and refusals never change saved choices");

    // Save the team without automatic plans; the save changes only that choice.
    await choose(browser, "extras", "auto plans");
    await until(browser, "automatic plans are off", `${option("extras", "auto plans")}.getAttribute('aria-selected') === 'false'`);
    await key(browser, "Escape", 27);
    await until(browser, "the edit saves before its review", verbIs("Save & review", "ready"));
    const beforeSave = reviews.length;
    await click(browser, verb);
    await waitFor(async () => (await readConfiguration(server, writer, first)).revision === saved.revision + 1, timeout, 50);
    await waitFor(reviewsFor(beforeSave + 1), timeout, 50);
    const supported = await readConfiguration(server, writer, first);
    assert(supported.configuration);
    assert.deepEqual(supported, { ...saved, revision: saved.revision + 1, configuration: {
      ...saved.configuration, revision: saved.configuration!.revision + 1,
      updatedAt: supported.configuration.updatedAt, updatedBy: supported.configuration.updatedBy,
      selection: { ...saved.configuration!.selection, planYolo: false },
    } }, "The explicit team save changes only its chosen policy and revision metadata");
    saved = supported;
    await until(browser, "Save & review goes on to its review", verbIs("Launch", "ready"));
    await openOptions(browser);
    await turn(browser, restricted, true);
    await turn(browser, readTool, true);
    await closeOptions(browser);
    await until(browser, "resuming with this team is allowed", `${rowVerb(first.machineId, "resume-with-team")}?.getAttribute('aria-disabled') !== 'true'`);
    await waitFor(async () => JSON.stringify(reviews.at(-1)?.automation) === JSON.stringify({ mode: "restricted", toolNames: ["read"], delegation: "disabled" }), timeout, 50);
    await click(browser, rowVerb(first.machineId, "resume-with-team"));
    await waitFor(() => resumedInputs.length === 2, timeout, 50);
    await until(browser, "explicit team resume refusal is visible", failureLine);
    const explicit = ResumeSessionInputSchema.parse(resumedInputs[1]);
    assert.equal(explicit.machineId, first.machineId);
    assert.equal(explicit.sessionId, savedSessionId);
    assert.deepEqual(explicit.overlay, reviews.at(-1)!.overlay);
    assert.deepEqual(explicit.accountPool, reviews.at(-1)!.accountPool);
    assert.deepEqual(explicit.automation, { mode: "restricted", toolNames: ["read"], delegation: "disabled" });
    assert(explicit.overrides?.model && explicit.overrides.thinking && explicit.overlay?.modelRoles?.default);
    assert.equal(explicit.overrides.model, explicit.overlay.modelRoles.default);
    assert.equal(explicit.overrides.thinking, explicit.overrides.model.split(":").at(-1));

    // While a resume runs, the line's machine cannot change under it.
    holdNextList = true;
    await click(browser, rowVerb(first.machineId, "resume"));
    await waitFor(() => heldList.held, timeout, 50);
    await focusStatement(browser, "machine");
    await key(browser, "ArrowDown", 40);
    await Bun.sleep(200);
    assert.equal(await browser.evaluate(wordValue("machine")), machineName, "No machine edit lands while a resume runs");
    heldList.release();
    await waitFor(() => resumedInputs.length === 3, timeout, 50);
    await until(browser, "the held resume's refusal is visible", failureLine);

    // An offline machine's read is no longer offered, and an offline destination stays on the line with its fix.
    await chooseMachine(browser, secondName);
    fleetMachines.find(machine => machine.id === second.machineId)!.online = false;
    await click(browser, footerLink("refresh"));
    await until(browser, "an offline machine's read is no longer offered",
      `${element(`${generator} [data-read-state="offline"][data-machine-id="${second.machineId}"]`)} !== null && ${savedRow(second.machineId)} === null`);
    await until(browser, "an offline destination is preserved on the line, not replaced",
      `${wordValue("machine")} === ${JSON.stringify(secondName)} && ${verb}.dataset.state === 'refused' && !!${statusFix(`use ${machineName}`)}`);
    await click(browser, statusFix(`use ${machineName}`));
    await until(browser, "the fix moves the line to the online machine", `${wordValue("machine")} === ${JSON.stringify(machineName)}`);
    fleetMachines.find(machine => machine.id === second.machineId)!.online = true;
    await click(browser, footerLink("refresh"));

    // An unreadable terminal inventory refuses resume; so does a session its machine no longer lists.
    // Each resume re-reads the machine first, so a refusal is awaited past that read.
    const resumeRefused = async (description: string) => {
      const reads = firstReads;
      await click(browser, rowVerb(first.machineId, "resume"));
      await waitFor(() => firstReads > reads, timeout, 50);
      await until(browser, description, `${rowVerb(first.machineId, "resume")}?.getAttribute('aria-busy') !== 'true' && ${verb}.dataset.state !== 'busy' && ${failureLine}`);
    };
    terminalInventoryFailed = true;
    await until(browser, "the resume row is offered", `${rowVerb(first.machineId, "resume")}?.getAttribute('aria-disabled') !== 'true'`);
    await resumeRefused("failed terminal refresh refuses resume");
    assert.equal(resumedInputs.length, 3, "Unknown terminal inventory failure cannot authorize resume");
    terminalInventoryFailed = false;
    sessionVisible = false;
    await resumeRefused("a vanished saved session refuses its resume");
    assert.equal(resumedInputs.length, 3, "A session its machine no longer lists cannot be resumed");
    sessionVisible = true;

    // The terminal appears after the press: the fresh pre-resume read navigates to that exact
    // public terminal without invoking OMP preparation.
    holdNextList = true;
    await click(browser, rowVerb(first.machineId, "resume"));
    await waitFor(() => heldList.held, timeout, 50);
    fleetTerminals = [{ ...terminalBase, id: "synthetic-exact", session: { harness: "atyrode.omp", machineId: first.machineId, sessionId: savedSessionId } }];
    heldList.release();
    const terminalRoute = `/uri/${encodeURIComponent(formatManifoldUri({ kind: "terminal", terminalId: "synthetic-exact" }))}`;
    await waitFor(() => navigations.some(url => new URL(url).pathname === terminalRoute), timeout, 50);
    assert.equal(resumedInputs.length, 3, "A newly correlated running session reopens instead of preparing a replacement");
    await until(browser, "public terminal URI resolves back to the authoritative home", `location.pathname === ${JSON.stringify(`/p/${first.containerId}`)} && ${verb} !== null`);
    await until(browser, "the exact running terminal is offered to open", `${runningRow("synthetic-exact")}?.querySelector('[data-verb="open"]') != null`);
    const navigationCount = navigations.filter(url => new URL(url).pathname === terminalRoute).length;
    await click(browser, `${runningRow("synthetic-exact")}.querySelector('[data-verb="open"]')`);
    await waitFor(() => navigations.filter(url => new URL(url).pathname === terminalRoute).length > navigationCount, timeout, 50);
    assert.equal(resumedInputs.length, 3, "Explicit open never prepares a replacement");
    assert.deepEqual(await ownerAction(server, "core.terminals.listAll", {}), realTerminals, "Earlier-statement actions never create a terminal");
    fixture.check();
  } finally {
    heldReview.release();
    heldList.release();
    offNavigations();
    await fixture.stop();
  }
  assert.deepEqual(await readConfiguration(server, writer, first), saved, "Synthetic observations never change real saved choices");
}

// ---------------------------------------------------------------- the run

const resources: {
  directory?: string; record?: string; browsers: BrowserInstance[]; server?: TestServer; agents: TestAgent[];
  dist?: { readonly distDir: string; readonly cleanup: () => void };
} = { browsers: [], agents: [] };
let stopping: Promise<string[]> | null = null;
/** Ends everything this run started, once: browsers (by their supervised groups too), machines, server and files. */
function stopEverything(): Promise<string[]> {
  return stopping ??= (async () => {
    const failures: string[] = [];
    const attempt = async (name: string, action: () => unknown | Promise<unknown>) => {
      try { await action(); } catch { failures.push(name); }
    };
    for (const [index, browser] of resources.browsers.entries()) await attempt(`browser ${index + 1}`, () => browser.close());
    if (resources.record) failures.push(...await endBrowsers(resources.record));
    for (const [index, agent] of resources.agents.entries()) await attempt(`fixture machine ${index + 1}`, () => agent.stop());
    await attempt("fixture server", () => resources.server?.stop());
    await attempt("fixture data", () => resources.directory && rmSync(resources.directory, { recursive: true, force: true }));
    await attempt("generated web bundle", () => resources.dist?.cleanup());
    return failures;
  })();
}
for (const [signal, number] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]] as const) {
  process.on(signal, () => {
    console.error(`Browser proof interrupted by ${signal}; ending its browsers, machines and server.`);
    // A teardown that hangs must not keep the process; the supervisors still end the browsers.
    setTimeout(() => process.exit(128 + number), 30_000).unref();
    void stopEverything().then(failures => {
      if (failures.length) console.error(`Cleanup failed: ${failures.join(", ")}`);
      process.exit(128 + number);
    });
  });
}

async function run(): Promise<void> {
  // Fail before allocating fixture state if prerequisites are absent. Never pack as
  // fallback: the positional argument is also how CI proves an older artifact fails.
  const chromium = Browser.detect();
  const setsid = Bun.which("setsid");
  assert(setsid, "setsid is required to run each browser in its own process group");
  const expectedRevision = readFileSync(join(pluginRoot, "MANIFOLD_REV"), "utf8").trim();
  const revision = Bun.spawnSync(["git", "-C", manifold, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  assert(revision.success && revision.stdout.toString().trim() === expectedRevision, "MANIFOLD_DIR must be checked out at plugins/MANIFOLD_REV");
  const bundles = [...ompFamily.map(id => ({ id, directory: ompBundleDirectory })), ...family.map(id => ({ id, directory: bundleDirectory }))].map(({ id, directory }) => {
    const file = join(directory, `${id}.manifold-plugin.json`);
    assert(existsSync(file), `Missing prepacked bundle: ${id}`);
    return { id, file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
  });
  const directory = mkdtempSync(join(tmpdir(), "code-browser-"));
  resources.directory = directory;
  resources.record = join(directory, "browsers");
  process.env.MANIFOLD_CHROMIUM = superviseChromium(directory, chromium, setsid);
  const dataDir = join(directory, "server");
  const home = join(directory, "home");
  mkdirSync(home);
  const writerBrowser = new Browser();
  const viewerBrowser = new Browser();
  resources.browsers.push(writerBrowser, viewerBrowser);
  let phase = "fixture startup";
  let failure: unknown;
  const started = Date.now();
  try {
    resources.dist = resolveWebDist("code-browser-web-");
    const server = await startServer({ dataDir, ownerKey: randomBytes(32).toString("hex"), spawnAgent: false,
      env: { MANIFOLD_BIND: "127.0.0.1", MANIFOLD_WEB_DIST: resources.dist.distDir, MANIFOLD_PLUGIN_DEV_PATHS: "1", HOME: home } });
    resources.server = server;
    assert(["localhost", "127.0.0.1"].includes(new URL(server.httpUrl).hostname), "Fixture must stay on loopback");
    for (const bundle of bundles) {
      phase = `installing ${bundle.id}`;
      try {
        const installed = await callAction(server, server.ownerKey, "engine.plugins.install", { source: bundle.file, sha256: bundle.sha256, hardened: ompFamily.includes(bundle.id) });
        if (!installed.ok) throw new Error(`Native bundle install refused (${installed.denial.rule}): ${installed.denial.message}`);
      } catch (reason) {
        // Installation precedes identity minting. Redact the fixture owner and
        // URLs, and keep this diagnostic separate from browser admission errors.
        const detail = reason instanceof Error ? `${reason.name}: ${reason.message}` : "Unknown installation failure";
        throw new ProofFailure(detail.replaceAll(server.ownerKey, "[redacted-owner]").replace(/https?:\/\/\S+/gi, "[redacted-url]"));
      }
    }
    phase = "isolated fixture machine";
    const enrolled = await enrollMachine(server, machineName);
    // testkit owns/reaps transport and terminal host. No native job-owner config is
    // provided, no native installation is made, and no terminal is opened.
    const agent = await startAgent({ serverUrl: server.url, machineToken: enrolled.machineToken, name: machineName,
      env: { HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_CONFIG_HOME: join(home, "config") } });
    resources.agents.push(agent);
    assert.equal(agent.machineId, enrolled.machineId, "Fixture machine enrollment must match the live transport");
    const secondEnrolled = await enrollMachine(server, secondName);
    const secondAgent = await startAgent({ serverUrl: server.url, machineToken: secondEnrolled.machineToken, name: secondName,
      env: { HOME: home, XDG_STATE_HOME: join(home, "second-state"), XDG_CONFIG_HOME: join(home, "second-config") } });
    resources.agents.push(secondAgent);
    assert.equal(secondAgent.machineId, secondEnrolled.machineId);
    const container = await createContainer(server, "Code browser regression", "canvas");
    const target = { containerId: container.id, machineId: agent.machineId };
    const secondTarget = { containerId: container.id, machineId: secondAgent.machineId };
    const writer = await mintToken(server, { principal: { kind: "human", name: "Code writer", color: "#336699" },
      caps: ["containers:read", "containers:write", "machines:read", "machines:run", "jobs:read", "services:read"] });
    const viewer = await mintToken(server, { principal: { kind: "human", name: "Code viewer", color: "#996633" },
      caps: ["containers:read", "machines:read", "machines:run", "jobs:read", "services:read"] });
    assert.notEqual(writer.principal.id, viewer.principal.id, "Writer and viewer must be different native identities");
    phase = "opening two independent workspaces";
    const viewerActions: string[] = [];
    const watchViewerActions = async () => {
      viewerBrowser.on("Network.requestWillBeSent", event => {
        const request = event.request as { url?: string } | undefined;
        const prefix = `${server.httpUrl}/api/actions/`;
        if (request?.url?.startsWith(prefix)) viewerActions.push(decodeURIComponent(request.url.slice(prefix.length)));
      });
      await viewerBrowser.send("Network.enable", {});
    };
    const opened = await Promise.allSettled([
      openWorkspace(writerBrowser, server, writer, container.id),
      openWorkspace(viewerBrowser, server, viewer, container.id, watchViewerActions),
    ]);
    for (const result of opened) if (result.status === "rejected") throw result.reason;
    const accountDestination = `${panel} .plugin-atyrode_code_accounts__target select`;
    await selectDestination(writerBrowser, accountDestination, target.machineId);
    await selectDestination(viewerBrowser, accountDestination, target.machineId);
    await waitFor(() => viewerActions.includes("atyrode.omp.accounts.accounts"), timeout, 50);
    assert(!viewerActions.includes("atyrode.omp.accounts.readAccountSetup"),
      "A read-only account view must not request owner-only account setup");
    const documentMarker = randomBytes(16).toString("hex");
    await viewerBrowser.evaluate(`globalThis.__codeBrowserDocument = ${JSON.stringify(documentMarker)}`);

    phase = "viewer authority boundary";
    const empty = await readConfiguration(server, viewer, target);
    assert.equal(empty.configuration, null, "Initialization must start from shared absent configuration");
    const denied = await callAction(server, viewer.token, "atyrode.code.initializeConfiguration", { containerId: target.containerId, expectedRevision: empty.revision });
    assert(!denied.ok, "Direct viewer initializeConfiguration must not succeed");
    assert.equal(denied.denial.rule, "forbidden", "A valid viewer mutation must fail on authority, not invalid input or readiness");
    assert.equal((await readConfiguration(server, viewer, target)).revision, empty.revision, "Denied initialization must not change shared state");
    await control(writerBrowser, "writer Initialize choices enabled", button("Initialize choices"), false);
    await control(viewerBrowser, "viewer Initialize choices disabled despite real authoring handle", button("Initialize choices"), true);

    phase = "writer UI initialization and viewer convergence";
    const configurationCommitAt = Date.now();
    await click(writerBrowser, button("Initialize choices"));
    await control(writerBrowser, "writer initialized profile enabled", element(profile), false);
    await control(viewerBrowser, "viewer receives initialized read-only profile without reload", element(profile), true);
    assert(Date.now() - configurationCommitAt < 1_500,
      "A shared Code configuration event must converge before the fallback polling cadence");
    await until(viewerBrowser, "viewer leaves uninitialized state", `${button("Initialize choices")} === undefined`);
    const initialized = await readConfiguration(server, viewer, target);
    assert.equal(initialized.revision, empty.revision + 1, "Exactly one initialization must be committed");
    assert.equal(initialized.configuration?.updatedBy, writer.principal.id, "Real UI initialization must belong to writer, not owner");
    assert.equal(await viewerBrowser.evaluate("globalThis.__codeBrowserDocument"), documentMarker, "Viewer initialization convergence must not reload the document");

    // Saving an empty-exclusion preset is a shared choice, not provider discovery:
    // the real AccountsView permits it without a fresh account observation.
    phase = "provider-free writer preset and viewer convergence";
    await control(writerBrowser, "writer save-as enabled", button("Save as preset…"), false);
    await control(viewerBrowser, "viewer save-as disabled", button("Save as preset…"), true);
    await click(writerBrowser, button("Save as preset…"));
    const nameField = element(`${accounts} form[aria-label="Saved account pool editor"] input[required]`);
    await control(writerBrowser, "profile name field ready", nameField, false);
    await click(writerBrowser, nameField);
    await writerBrowser.typeText(presetName);
    phase = "account draft survives destination changes";
    await selectDestination(writerBrowser, accountDestination, secondTarget.machineId);
    assert.equal(await writerBrowser.evaluate(`${nameField}.value`), presetName, "Changing destinations must retain the unsaved preset name");
    assert.equal((await readConfiguration(server, writer, secondTarget)).revision, initialized.revision, "A destination choice must not mutate or fork shared configuration");
    await selectDestination(writerBrowser, accountDestination, target.machineId);
    assert.equal(await writerBrowser.evaluate(`${nameField}.value`), presetName, "Returning to the first destination must retain its shared draft");

    phase = "contextual choices preserve a live account draft";
    const permissionsBefore = await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 });
    await click(writerBrowser, element(`${accounts} .plugin-atyrode_code__account-diagnostics > summary`));
    const reviewTrigger = button("Review account capabilities");
    await control(writerBrowser, "contextual account review available while editing", reviewTrigger, false);
    await click(writerBrowser, reviewTrigger);
    const permissionDialog = "dialog.plugin-atyrode_code__permission-dialog[open]";
    const capability = (id: string) => element(`${permissionDialog} [data-code-capability="${id}"] input[type="checkbox"]`);
    const displayedPlan = element(`${permissionDialog} [aria-label="Typed headless permission plan"] pre`);
    await control(writerBrowser, "account capability choice", capability("accounts"), false);
    await until(writerBrowser, "context selects account capability", `${capability("accounts")}.checked === true`);
    await click(writerBrowser, capability("accounts"));
    await click(writerBrowser, capability("discovery"));
    await click(writerBrowser, capability("benchmark"));
    await until(writerBrowser, "typed grouped native review scope", `(() => {
      const text = ${displayedPlan}?.textContent;
      if (!text) return false;
      const plan = JSON.parse(text).result;
      return plan.steps.length === 1 && plan.steps[0].request.operationIds.length === 2;
    })()`);
    const grouped = await writerBrowser.evaluate<PermissionPlan>(`JSON.parse(${displayedPlan}.textContent).result`);
    assert.equal(grouped.ownerApprovalRequired, true, "Writer must see actual native owner authority requirement");
    assert.deepEqual(grouped.steps.map(step => ({ pluginId: step.request.pluginId, targets: step.request.targets, operations: step.request.operationIds })), [{
      pluginId: "atyrode.omp", targets: [{ machineId: target.machineId }],
      operations: ["atyrode.omp.inventory", "atyrode.omp.benchmark"],
    }], "Independent choices must not implicitly approve account or gateway operations");
    await click(writerBrowser, capability("benchmark"));
    await until(writerBrowser, "declining only removes the new benchmark request", `(() => {
      const text = ${displayedPlan}?.textContent;
      return !!text && JSON.stringify(JSON.parse(text).result.steps[0]?.request.operationIds) === JSON.stringify(["atyrode.omp.inventory"]);
    })()`);
    await until(writerBrowser, "native authority requirement is visible", `(() => {
      const notice = ${element(`${permissionDialog} .plugin-atyrode_code__notice[role="status"]`)};
      return !!notice && notice.getClientRects().length > 0;
    })()`);
    const currentPlan = await writerBrowser.evaluate<PermissionPlan>(`JSON.parse(${displayedPlan}.textContent).result`);
    const nativeRefusal = await callAction(server, writer.token, "engine.jobs.reviewDeployment", currentPlan.steps[0]!.request);
    assert(!nativeRefusal.ok, "An ordinary workspace writer cannot bypass the native owner review boundary");
    assert.equal(nativeRefusal.denial.rule, "forbidden", "A valid native request is denied on authority, not malformed input");
    assert.equal(await writerBrowser.evaluate(`document.querySelector('${permissionDialog} [aria-label="Capability readiness"]') === null`), true,
      "A root-only native denial must never become cosmetic permission success");
    assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), permissionsBefore,
      "Choices, decline and refused review must not create or revoke native approval");
    await key(writerBrowser, "Escape", 27);
    await until(writerBrowser, "contextual review closes without navigation", `${element(permissionDialog)} === null`);
    assert.equal(await writerBrowser.evaluate(`${nameField}.value`), presetName, "Permission review must retain the unsaved account name");
    assert.equal(await writerBrowser.evaluate(`document.activeElement === ${reviewTrigger}`), true, "Escape restores focus to the feature trigger");
    assert.equal((await readConfiguration(server, viewer, target)).revision, initialized.revision, "Permission drafts must not write Code configuration");
    await click(writerBrowser, reviewTrigger);
    await control(writerBrowser, "declined benchmark remains directly reviewable", capability("benchmark"), false);
    await click(writerBrowser, capability("benchmark"));
    await until(writerBrowser, "reconsidered capability is selected", `${capability("benchmark")}.checked === true`);
    await key(writerBrowser, "Escape", 27);
    await until(writerBrowser, "second contextual review closes", `${element(permissionDialog)} === null`);
    phase = "saving the preserved account draft";
    await control(writerBrowser, "writer Save preset enabled", button("Save preset"), false);
    await click(writerBrowser, button("Save preset"));
    await waitFor(async () => (await readConfiguration(server, viewer, target)).configuration?.accounts.presets.some(row => row.name === presetName) === true, timeout, 50);
    const saved = await readConfiguration(server, viewer, target);
    assert.equal(saved.revision, initialized.revision + 1, "Exactly one preset creation must be committed");
    assert.equal(saved.configuration?.updatedBy, writer.principal.id);
    const preset = saved.configuration?.accounts.presets.find(row => row.name === presetName);
    assert(preset, "The UI-created profile must be readable as shared configuration");
    const hasPreset = `(() => { const select = ${element(profile)}; return select instanceof HTMLSelectElement && [...select.options].some(option => option.value === ${JSON.stringify(preset.id)} && option.label.includes(${JSON.stringify(presetName)})); })()`;
    await until(writerBrowser, "writer can identify the saved pool", hasPreset);
    await until(viewerBrowser, "viewer receives the same saved pool without refresh", hasPreset);

    // Native select input through the keyboard, rather than setting DOM values.
    await control(writerBrowser, "writer profile selection enabled", element(profile), false);
    await click(writerBrowser, element(profile));
    await key(writerBrowser, "End", 35);
    await key(writerBrowser, "Enter", 13);
    await until(viewerBrowser, "viewer receives active profile", `(() => { const select = ${element(profile)}; return select instanceof HTMLSelectElement && select.value === ${JSON.stringify(preset.id)} && select.disabled; })()`);
    const activated = await readConfiguration(server, viewer, target);
    assert.equal(activated.configuration?.accounts.activePreset, preset.id);
    assert.equal(activated.revision, saved.revision + 1, "Exactly one profile activation must be committed");
    assert.equal(activated.configuration?.updatedBy, writer.principal.id);
    await control(viewerBrowser, "viewer remains unable to edit shared profiles", button("Save as preset…"), true);
    assert.equal(await viewerBrowser.evaluate("globalThis.__codeBrowserDocument"), documentMarker, "Viewer preset convergence must not reload the document");
    await selectDestination(writerBrowser, accountDestination, secondTarget.machineId);
    assert.equal(await writerBrowser.evaluate(`${element(profile)}.value`), preset.id, "Both destinations show the same saved active pool");
    assert.deepEqual((await readConfiguration(server, writer, secondTarget)).configuration?.accounts, activated.configuration?.accounts);
    phase = "real shared workbench drafts across destinations";
    await sharedWorkbenchScenario(writerBrowser, viewerBrowser, server, writer, viewer, target, secondTarget);
    phase = "a writer without a canvas saves and is told why launching waits";
    await canvaslessWriterScenario(writerBrowser, server, writer, target);

    phase = "initial capability checklist without native approval";
    const firstUse = await createContainer(server, "Code first-use permissions", "canvas");
    await arrangeWorkbench(server, writer);
    await openGenerator(writerBrowser, server, firstUse.id);
    await usableStarter(writerBrowser);
    assert.equal(await writerBrowser.evaluate(`${element(permissionDialog)} === null`), true,
      "Bundled starter does not open a permission dialog");
    // Enabling discovery is an explicit review in Setup; the first-use line's own fix is to read the accounts again.
    await openSheet(writerBrowser, "setup");
    await click(writerBrowser, workspaceButton("Machine"));
    const firstUseReview = workspaceButton("Choose capabilities to review");
    await until(writerBrowser, "first-use review remains an explicit choice", `${firstUseReview}?.getClientRects().length > 0 && ${element(permissionDialog)} === null`);
    await click(writerBrowser, firstUseReview);
    await until(writerBrowser, "initial independent capability checklist", `document.querySelectorAll('${permissionDialog} [data-code-capability] input[type="checkbox"]').length === 7`);
    assert.equal(await writerBrowser.evaluate(`document.querySelectorAll('${permissionDialog} input[type="checkbox"]:checked').length`), 0,
      "Initial setup must not pre-accept permissions");
    await click(writerBrowser, capability("workspace-existing"));
    await until(writerBrowser, "workspace-only request keeps its exact operation", `(() => {
      const text = ${displayedPlan}?.textContent;
      return !!text && JSON.stringify(JSON.parse(text).result.steps[0]?.request.operationIds) === JSON.stringify(["atyrode.omp.validate-workspace"]);
    })()`);
    await key(writerBrowser, "Escape", 27);
    await until(writerBrowser, "onboarding can defer permission review", `${element(permissionDialog)} === null`);
    await closeSheet(writerBrowser);
    assert.equal((await readConfiguration(server, writer, { containerId: firstUse.id })).configuration, null,
      "Initial choices and closing review do not initialize or promote a profile");
    assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), permissionsBefore);
    phase = "bundled starter composition and the main view's acceptance";
    await starterWorkbenchScenario(writerBrowser, server, writer, target);
    phase = "starter observation failures are not absence";
    await starterObservationScenario(writerBrowser, server, writer);
    phase = "verification charge gate";
    await verificationChargeScenario(writerBrowser, server, writer, target);
    phase = "manual catalog authoring and concurrent first-save refusal";
    await manualCatalogScenario(writerBrowser, server, writer);
    phase = "deferred first-use and standalone Usage configuration recovery";
    await configurationRecoveryScenario(writerBrowser, server, writer, { containerId: firstUse.id }, target);
    phase = "staged catalogs keep model repair reachable";
    await stagedCatalogScenario(writerBrowser, server, writer);
    phase = "synthetic account-scope recovery retains referenced fresh evidence";
    await syntheticScopeRecoveryScenario(writerBrowser, server, writer);
    phase = "synthetic independent folder-only UI readiness";
    await syntheticFolderReadinessScenario(writerBrowser, server, writer, target);
    phase = "synthetic review, launch and resume gate";
    await syntheticPreviewScenario(writerBrowser, server, writer, target, secondTarget);
    phase = "proof complete";
  } catch (error) {
    // Driver diagnostics can contain admission URLs. Report only the phase and local
    // verifier line numbers, never driver messages or captured page-console output.
    const frames = error instanceof Error ? error.stack?.match(/verify-browser\.ts:\d+:\d+/g)?.slice(0, 4).join(", ") : undefined;
    failure = error instanceof assert.AssertionError || error instanceof ProofFailure
      ? new Error(`Browser proof failed during ${phase}: ${error.message}${frames ? ` (${frames})` : ""}`)
      : new Error(`Browser proof failed during ${phase}${frames ? `; local frames: ${frames}` : ""}`);
  }
  const cleanupFailures = await stopEverything();
  if (cleanupFailures.length) throw new Error(`Cleanup failed: ${cleanupFailures.join(", ")}${failure ? `; proof failed during ${phase}` : ""}`);
  if (failure) throw failure;
  console.log(`PASS (${Math.round((Date.now() - started) / 1000)}s): packed Code in two real browsers and two permitted destinations; shared choices converge with viewer authority intact, and a viewer's main view refuses every write. Genuine pinned OMP metadata yields an editable render-only starter whose seat board is exactly the policy derivation; conflicted local material stays exportable without revision-zero rebasing; configuration/metadata failures are not absence, and a failed model list is named with its retry and Models whatever the verb says. The verification charge is never confirmed by a double-click, a second click, key repeat or ↵ at the panel root, waits as the next Tab stop with every edit locked, and a refused spend saves nothing. Manual Models import, staging and exact promotion remain reachable, and a staged-only workspace's verb opens Models. Team, catalog and account drafts survive destinations, sheets and a reload; own account edits never conflict with an unsaved edit while a foreign team write does; a save is refused for a lead no account serves; a writer without a canvas saves and is told why launching waits, never read-only. From 170 to 1440px nothing overflows or overlaps; pointing and focus shift nothing; keys stay panel-local and never act from a sheet, dialog or popover; arrival keys reach the lane or take the verb's step; a refused keyboard step says why; the wheel turns only open drums or keyboard-focused words at rest; reduced motion animates nothing. Auto-review, skills, automation, refused launch, resume and earlier-statement correlations (one row per folder with its drum, re-read on refresh) stay gated at their native owners, native permission and folder readiness stay review-only, and no native approval, terminal or provider request is made.`);
}

await run();
