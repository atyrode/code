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
import { catalogFromObservations, catalogFromMetadata, inventoryDraft } from "../domain/probe.ts";
import { providerPolicy } from "../domain/providers.ts";
import { defaultSelection, reviewCatalog } from "../domain/routing.ts";
import { displayAliases } from "../code/generator/aliases.ts";
import { readStoredDraft, storedDraftKey, type StoredDraft } from "../code/generator/draft-store.ts";
import { recentTeamsKey } from "../code/generator/recent-teams.ts";
import { EDIT_QUIET_MS, HOLD_RECHECK_MS, SHOWN_AGAIN_MS } from "../code/generator/auto-read.ts";
import {
  BENCHMARK_OPERATION_ID, GATEWAY_OPERATION_ID, INVENTORY_OPERATION_ID, LAUNCH_OPERATION_ID, ModelCatalogSnapshotSchema, OMP_VERSION, OmpHarnessProfileSchema,
  PREPARE_WORKSPACE_OPERATION_ID, ResumeSessionInputSchema, VALIDATE_WORKSPACE_OPERATION_ID, actionSchemas as ompActionSchemas,
  type BenchmarkReceipt, type InventoryReceipt, type ActionInput as OmpInput, type ActionResult as OmpResult,
} from "@atyrode/manifold-omp";
import { HARNESS_OPERATION_ID, type PermissionPlan } from "../code/permission-plan.ts";
import { codeAgentName, inventoryArtifact, runDials } from "../code/workflow.ts";
import { formatManifoldUri, InspectRunV2ResultSchema, ListAgentsV2ResultSchema, ListRunsV2ResultSchema, PublicJobSchema,
  type InspectRunV2Result, type ListRunsV2Result, type MachineSummary, type PublicJob, type TerminalSummary } from "@manifold/protocol";

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
Proves Code's main view, the terminal UI evolved (the generator's rows, the launch with its machine
picker, routing, usage, the accounts and sessions views, the key line and the bar's More menu), and
its Models and Setup sheets, in real Chromium identities: render-only bundled-metadata starter
composition, retained conflicted drafts, permission choices, writer/viewer authority and
container-shared choices across two destinations, and the browser-provable acceptance of the main
view and the sheets: no horizontal overflow, cut text or colliding text from 170 to 1440px in every
view and sheet, zero hover/focus layout shift, panel-local keys that never act from a sheet or an
open popover, More as a menu button by pointer and keyboard, arrival keys, the wheel only on a focused
or rested row, 44px targets on a coarse pointer, focus kept through the gate and reduced motion that
animates nothing.
Also: an unsaved edit kept across a reload, own account edits that never conflict with it while a
foreign profile write does, a save refused for a lead no account serves, a writer without a canvas
who saves but is told why launching waits, account switches saved through the real changeAccounts
CAS, the accounts' management in place, saved sessions folded per folder into a drum, the panel
reading its inputs again on its own when shown again but never while an edit is unsaved (until it
is saved or discarded), a step runs or a sheet is open, tiered usage windows that are their own
rows and judge no provider's pool, the lead row's only box, toggled by a press and Space with
focus kept on it, kept across a lead change and disabled under Mixed, with struck leads and boxes
that say why, and Models' pasted imports, discards and the exact review a staged list is used by,
through the real Code server.
Separate synthetic RPC responses exercise the verification charge and its refused spend; a verified
catalog made stale by an OMP upgrade alone; a Models verification run end to end on fictional probe
jobs that reach no provider, whose derivation, staging and promotion are the real server's; Setup's
readiness rows, folder jobs and the owner's classifier (an owner-class identity minted for it alone);
and launch/resume review invalidation and refusal. The preparation, configuration and execution they
lead to are refused, never native execution or consent success.
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
/** Moves the pointer off every control, to the top-left corner of the page. */
async function pointAway(browser: BrowserInstance): Promise<void> {
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
}
async function tap(browser: BrowserInstance, expression: string): Promise<void> {
  const point = await pointOf(browser, expression);
  await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
  await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
/** The physical key for a key name: letters and digits by their position, everything else by its own name. */
function keyCode(name: string): string {
  if (/^[a-z]$/.test(name)) return `Key${name.toUpperCase()}`;
  if (/^[0-9]$/.test(name)) return `Digit${name}`;
  return name === "?" ? "Slash" : name === " " ? "Space" : name;
}
async function key(browser: BrowserInstance, name: string, code: number, options: { modifiers?: number; autoRepeat?: boolean } = {}): Promise<void> {
  const modifiers = options.modifiers ?? 0;
  // Blink's native button activation needs Enter's character data, not only its key code.
  const text = name === "Enter" ? "\r" : name.length === 1 ? name : null;
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: keyCode(name), windowsVirtualKeyCode: code, modifiers,
    autoRepeat: options.autoRepeat ?? false, ...(text === null ? {} : { text, unmodifiedText: text }) });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: keyCode(name), windowsVirtualKeyCode: code, modifiers });
}
const CTRL = 2, SHIFT = 8;
async function wheel(browser: BrowserInstance, point: Point, deltaY: number): Promise<void> {
  await browser.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY });
}

// ---------------------------------------------------------------- the generator panel

const generator = ".plugin-atyrode_code_generator";
const G = "plugin-atyrode_code_generator__";
/** The stage and its key line: every view of the main view, hidden while a sheet is open. */
const stage = `${generator} [data-tui]`;
const generatorTitle = element(`${generator} [data-pane="generator"] .${G}title`);
const launchButton = element(`${generator} .${G}launch`);
const confirmCharge = element(`${generator} .${G}confirm`);
const readout = element(`${generator} .${G}readout`);
// The announcer is the panel's polite live region; other status roles (skills, notices) are not it.
const liveRegion = element(`${generator} div.plugin-atyrode_code__sr[role="status"][aria-live="polite"]`);
const lineText = `(${element(`${generator} .${G}launch-line`)}?.textContent ?? '')`;
/** A failure or refusal said beside the launch, in the attention colour. */
const failureLine = `!!document.querySelector(${JSON.stringify(`${generator} .${G}launch-part[data-tone="attention"]`)})`;
const cancelCharge = `[...document.querySelectorAll(${JSON.stringify(`${generator} .${G}launch-line .${G}fix`)})].find(el => el.textContent.trim() === 'Cancel')`;
const shortcuts = element(`${generator} dialog.${G}shortcuts`);
const machinePicker = element(`${generator} [data-machine-picker]`);
const machineList = element(`${generator} [role="listbox"][aria-label="machines"]`);
const visibleSheet = `[...document.querySelectorAll(${JSON.stringify(`${generator} .${G}sheet-host`)})].find(el => !el.hidden)`;
const skillsSection = element(`${generator} [aria-label="Optional skills"]`);
/** Models and Setup, each a sheet of its own over the stage (models-sheet.tsx, setup-sheet.tsx), by their selectors. */
const modelsSheet = `${generator} [data-sheet="models"]`;
const setupSheet = `${generator} [data-sheet="setup"]`;
const routeRows = `${generator} [data-pane="routing"] .${G}route`;
const starterProviders = ["anthropic", "deepseek", "openai-codex"];
const profileRoles = ["default", "task", "plan", "slow", "reviewer", "security-reviewer", "scout", "sonic", "vision", "smol", "tiny", "commit"];
/** The generator's rows, top to bottom: the dials, then fallbacks as an on/off row; the other profile switches live in the session options. */
type RowId = "lane" | "tier" | "thinking" | "advisor" | "fallbacks";
const ROWS: readonly RowId[] = ["lane", "tier", "thinking", "advisor", "fallbacks"];

function row(id: RowId): string {
  return element(`${generator} [data-row="${id}"]`);
}
/** A row's value as assistive technology reads it: the name of its checked radio. */
function rowValue(id: RowId): string {
  return `${row(id)}?.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('aria-label')`;
}
/** One option word of a row, by its stable key (a dial value, the lead row's `mixed` or a lead's family, or `on`/`off`). */
function word(id: RowId, key: string): string {
  return element(`${generator} [data-row="${id}"] .${G}word[data-key="${key}"]`);
}
function chosenKey(id: RowId): string {
  return `${row(id)}?.querySelector('.${G}word[data-selected]')?.dataset.key`;
}
/** The lead row's `only` box (#252): a checkbox after the lead words, checked while the lane keeps every role on its lead. */
const onlyBox = element(`${generator} [data-row="lane"] [data-only]`);
/** Each lead word and the `only` box by its layout box inside the row's words: what neither a lead change nor the box may move. */
const LEAD_GEOMETRY = `[...${row("lane")}.querySelectorAll('[role="radio"], [data-only]')].map(el => [el.dataset.key ?? 'only', el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight].join(','))`;
/** Every row's value, as one string: whatever a key, a press or the wheel changed shows here. */
const profileValues = `[${ROWS.map(rowValue).join(", ")}].join(' / ')`;
/** A fix beside the launch, by its stable key. */
function fix(key: string): string {
  return element(`${generator} .${G}launch-line [data-fix="${key}"]`);
}
const revertButton = element(`${generator} [data-revert]`);
/** More, the bar's one menu button, and its menu while it is open (more-menu.tsx). */
const more = element(`${generator} [data-more]`);
const menu = element(`${generator} [role="menu"]`);
/** The open menu's items, top to bottom. */
const menuItems = `[...document.querySelectorAll(${JSON.stringify(`${generator} [role="menu"] [role="menuitem"]`)})]`;
type MenuItem = "models" | "setup" | "options" | "shortcuts";
const MENU: readonly MenuItem[] = ["models", "setup", "options", "shortcuts"];
function menuItem(id: MenuItem): string {
  return element(`${generator} [role="menu"] [role="menuitem"][data-menu-item="${id}"]`);
}
/** Opens More by a real press: its menu opens with focus on its first item. */
async function openMenu(browser: BrowserInstance): Promise<void> {
  await click(browser, more);
  await until(browser, "a press on More opens its menu with focus on its first item",
    `${more}.getAttribute('aria-expanded') === 'true' && ${menu} !== null && document.activeElement === ${menuItems}[0]`);
}
/** A visible button in the generator panel, its views and its sheets, by its exact text. */
function workspaceButton(text: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(`${generator} button`)})].find(el => el.getClientRects().length && el.textContent.trim() === ${JSON.stringify(text)})`;
}
function shownView(name: string): string {
  return `${element(stage)}?.dataset.view === ${JSON.stringify(name)}`;
}
/** The launch's label (lower case, as drawn) and state. Focus stays on the launch through its states, so it is never natively disabled. */
function launchIs(label: string, state: "ready" | "busy" | "waiting" | "refused"): string {
  return `${launchButton}?.querySelector('.${G}launch-label')?.textContent === ${JSON.stringify(label)} && ${launchButton}.dataset.state === '${state}' && !${launchButton}.disabled`;
}
/** A failed model list said beside the launch with its retry and Models: `instead` of a profile (no rows), or `beside` the rows it keeps. */
function listFailure(kind: "instead" | "beside"): string {
  return `!!document.querySelector('${generator} .${G}launch-part[data-tone="warn"]') && !!${fix("list-retry")} && !!${fix("list-models")} && (${row("lane")} ${kind === "instead" ? "===" : "!=="} null)`;
}
const running = `${element(generator)}.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running').length`;
async function still(browser: BrowserInstance): Promise<void> {
  await until(browser, "every animation has finished", `${running} === 0`);
}

/** The routing beside the generator: each routed role's lead, its model alias and the thinking it runs at. */
type Routed = { role: string; alias: string; thinking: string };
async function routedRoles(browser: BrowserInstance): Promise<Routed[]> {
  return browser.evaluate<Routed[]>(`[...document.querySelectorAll(${JSON.stringify(`${routeRows}:not([data-off])`)})].map(route => {
    const value = route.querySelector('.${G}chain > .${G}tok > .${G}tok-layer:not([aria-hidden]) .${G}tok-value');
    return { role: route.dataset.role, alias: value?.querySelector('.${G}tok-alias')?.textContent ?? '',
      thinking: (value?.querySelector('.${G}tok-thinking')?.textContent ?? '').replace(/^:/, '') };
  }).sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : 0)`);
}
/** What the routing must show for a selection: every routed role on its lead's alias at the lead's thinking. */
function expectedRoutes(document: CatalogDocument, selection: Selection): Routed[] {
  const compiled = compileCatalog(document);
  const aliases = displayAliases(compiled);
  return reviewCatalog(compiled, selection, Date.now()).routes.map(route => ({
    role: route.role, alias: aliases.get(route.lead.key) ?? route.lead.key, thinking: route.lead.thinking,
  })).sort((left, right) => left.role < right.role ? -1 : left.role > right.role ? 1 : 0);
}
async function assertRoutes(browser: BrowserInstance, advisor: boolean): Promise<void> {
  await until(browser, "the routing routes the profile", `document.querySelector(${JSON.stringify(`${routeRows}:not([data-off])`)}) !== null`);
  await still(browser);
  const routed = await routedRoles(browser);
  assert.deepEqual(routed.map(entry => entry.role).sort(), [...profileRoles, ...(advisor ? ["advisor"] : [])].sort(),
    "The full current role contract is routed, including delegated and utility roles");
  assert(routed.every(entry => entry.alias && entry.thinking), "Every routed role names its model and supported effort");
}

/** Chooses a word of a row by a real press, unless it is already chosen. */
async function choose(browser: BrowserInstance, id: RowId, key: string): Promise<void> {
  if (!await browser.evaluate<boolean>(`${word(id, key)}?.dataset.selected !== undefined`)) await click(browser, word(id, key));
  await until(browser, `the ${id} row is on ${key}`, `${word(id, key)}?.dataset.selected !== undefined`);
}
/**
 * Keyboard focus on a row, by real keys only: a press on the generator's title gives the panel root
 * focus, an arrow there enters the rows at the one the keyboard was last on, and ↑/↓ walk them.
 */
async function focusRow(browser: BrowserInstance, id: RowId): Promise<void> {
  await click(browser, generatorTitle);
  await key(browser, "ArrowDown", 40);
  for (let step = 0; step < ROWS.length; step++) {
    const at = await browser.evaluate<string>(`document.activeElement?.closest('[data-row]')?.dataset.row ?? ''`);
    if (at === id) break;
    const from = ROWS.indexOf(at as RowId), to = ROWS.indexOf(id);
    await key(browser, from < to ? "ArrowDown" : "ArrowUp", from < to ? 40 : 38);
  }
  await until(browser, `keyboard focus on the ${id} row`, `!!${row(id)}?.contains(document.activeElement) && document.activeElement.matches(':focus-visible')`);
}
/** Real Tab presses until the expression holds focus; Shift+Tab when `backward`. */
async function tabTo(browser: BrowserInstance, description: string, expression: string, backward = false): Promise<void> {
  for (let step = 0; step < 80; step++) {
    if (await browser.evaluate<boolean>(`(() => { const el = ${expression}; return !!el && document.activeElement === el; })()`)) return;
    await key(browser, "Tab", 9, { modifiers: backward ? SHIFT : 0 });
  }
  throw new ProofFailure(`Keyboard focus never reached ${description}`);
}
/** Keyboard focus on the launch, reached by Tab from the panel root: the rows are one Tab stop, and the launch comes after them. */
async function focusLaunch(browser: BrowserInstance): Promise<void> {
  await click(browser, generatorTitle);
  await tabTo(browser, "the launch", launchButton);
}
async function chooseMachine(browser: BrowserInstance, machineId: string, name: string): Promise<void> {
  await until(browser, "the launch names its machine", `!!${machinePicker}?.textContent`);
  if (await browser.evaluate<boolean>(`${machinePicker}.textContent === ${JSON.stringify(name)}`)) return;
  await click(browser, machinePicker);
  await until(browser, "the machine list opens", `${machineList} !== null`);
  await click(browser, element(`${generator} [data-machine="${machineId}"]`));
  await until(browser, `the launch runs on ${name}`, `${machineList} === null && ${machinePicker}?.textContent === ${JSON.stringify(name)}`);
}

/** The sheets that open over the stage: the key the main view opens each with, More's item that does, and the sheet's title. */
type Sheet = "models" | "setup" | "options";
const SHEETS: Readonly<Record<Sheet, { key: string; code: number; item: MenuItem; title: string }>> = {
  models: { key: "m", code: 77, item: "models", title: "Models" }, setup: { key: "u", code: 85, item: "setup", title: "Setup" },
  options: { key: "o", code: 79, item: "options", title: "Session options" },
};
/** A sheet over the stage, by its title, with focus on its way back. Models and Setup are sections of their own; the session options keep the shared frame. */
function sheetOpen(title: string): string {
  return `${element(stage)}?.hidden === true && ${visibleSheet}?.querySelector('[data-sheet], .plugin-atyrode_code__sheet')?.getAttribute('aria-label') === ${JSON.stringify(title)} &&
    document.activeElement === ${visibleSheet}.querySelector('[aria-label="Back to Code"]')`;
}
/** Opens a sheet by its key from the main view, remembering what had focus so its return can be checked. */
async function openSheet(browser: BrowserInstance, sheet: Sheet): Promise<void> {
  if (!await browser.evaluate<boolean>(`!!document.activeElement?.closest('${stage}') || document.activeElement === ${element(generator)}`)) await click(browser, generatorTitle);
  await browser.evaluate(`(globalThis.__codeOpener = document.activeElement, true)`);
  await key(browser, SHEETS[sheet].key, SHEETS[sheet].code);
  await until(browser, `${sheet} opens over the stage with focus on its way back`, sheetOpen(SHEETS[sheet].title));
}
async function closeSheet(browser: BrowserInstance): Promise<void> {
  await click(browser, `${visibleSheet}?.querySelector('[aria-label="Back to Code"]')`);
  await until(browser, "the stage returns", `${element(stage)}?.hidden === false`);
}
/** Opens a sheet from More by real presses, More and then its item, remembering what had focus so its return can be checked. */
async function openFromMore(browser: BrowserInstance, sheet: Sheet): Promise<void> {
  await openMenu(browser);
  await browser.evaluate(`(globalThis.__codeOpener = ${more}, true)`);
  await click(browser, menuItem(SHEETS[sheet].item));
  await until(browser, `More's ${sheet} item opens it with focus on its way back`, sheetOpen(SHEETS[sheet].title));
}
/**
 * A sheet's one next action (sheet-frame.tsx `SheetGo`) is its label as drawn and its state: `busy` while a step runs,
 * `refused` when a press now would refuse; it is never natively disabled, so focus stays on it through its states.
 */
function goIs(sheet: string, label: string, state: "ready" | "busy" | "refused" = "ready"): string {
  const go = element(`${sheet} [data-go]`);
  return `${go}?.querySelector('.${G}go-label')?.textContent === ${JSON.stringify(label)} && !${go}.disabled &&
    (${go}.getAttribute('aria-busy') === 'true') === ${state === "busy"} && (${go}.getAttribute('aria-disabled') === 'true') === ${state !== "ready"}`;
}
/** The words beside a sheet's next action, part by part, each with its tone. */
function goParts(sheet: string): string {
  return `[...document.querySelectorAll('${sheet} .${G}go-line .${G}go-part')].map(el => [el.textContent, el.dataset.tone ?? null])`;
}
/** A fix beside a sheet's next action, by its words. */
function goFix(sheet: string, label: string): string {
  return `[...document.querySelectorAll('${sheet} .${G}go-line .${G}go-fix')].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
}
/** The fixes beside a sheet's next action, by their words. */
function goFixes(sheet: string): string {
  return `[...document.querySelectorAll('${sheet} .${G}go-line .${G}go-fix')].map(el => el.textContent.trim())`;
}
/** What a sheet's readout says, its bold value then why; and the head's state line. */
function sheetSays(sheet: string): string {
  return `(${element(`${sheet} [data-readout]`)}?.textContent ?? '')`;
}
function sheetState(sheet: string): string {
  return `(${element(`${sheet} .${G}sheet-state[role="status"]`)}?.textContent ?? '')`;
}
async function openOptions(browser: BrowserInstance): Promise<void> {
  if (!await browser.evaluate<boolean>(`!!${visibleSheet}?.contains(${skillsSection})`)) await openSheet(browser, "options");
  await until(browser, "session options open", `!!${visibleSheet}?.contains(${skillsSection})`);
}
/** Esc from the control last used in the sheet closes it, and focus goes back to what opened it. */
async function closeOptions(browser: BrowserInstance): Promise<void> {
  assert.equal(await browser.evaluate(`!!${visibleSheet}?.contains(document.activeElement)`), true, "Session options keep focus while they are open");
  await key(browser, "Escape", 27);
  await until(browser, "Esc closes session options and gives focus back to what opened them", `${element(stage)}.hidden === false && document.activeElement === globalThis.__codeOpener`);
}
/** A switch in the session options (a profile switch, a set, a skill, restricted automation or a tool), by its words. */
function optionSwitch(group: "Profile switches" | "Optional skills" | "Automation policy", label: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(`${generator} [aria-label="${group}"] [role="switch"]`)})].find(el => el.textContent.trim() === ${JSON.stringify(label)})`;
}
/** Automatic plan approval: a profile switch, saved with the workspace profile, that lives in the session options. */
const autoPlans = optionSwitch("Profile switches", "auto plans");
/** Turns a switch on or off by a real press, unless it already is. */
async function turn(browser: BrowserInstance, control: string, on: boolean): Promise<void> {
  if (await browser.evaluate<boolean>(`${control}?.getAttribute('aria-checked') !== '${on}'`)) await click(browser, control);
  await until(browser, `the switch turns ${on ? "on" : "off"}`, `${control}?.getAttribute('aria-checked') === '${on}'`);
}
/** Waits until the panel has read the record at `revision`, as Setup's profile facts state it (opening a sheet reads again). */
async function panelReads(browser: BrowserInstance, revision: number): Promise<void> {
  await openSheet(browser, "setup");
  await until(browser, `the panel reads revision ${revision}`,
    `[...document.querySelectorAll('${setupSheet} .${G}setup-facts dt')].find(el => el.textContent === 'revision')?.nextElementSibling?.textContent === '${revision}'`);
  await closeSheet(browser);
}

/**
 * The panel's own reads of what it stands on, as the SDK's feed probe counts them (polled-resource.ts `__manifoldFeeds`,
 * installed where `localStorage["manifold:debug"]` is set before the page loads): the `manual` reads of the machine
 * list and of OMP's defaults, those a caller asks for outright. The feeds' own read on a page's return counts as
 * `resume`, apart. Only the panel's reads (read-clock.ts `usePanelReads`) ask for them: its inputs' clock on its own,
 * and a pass of everything at Refresh now, `r` or a sheet's opening or closing. The machine list is the panel's own
 * feed, keyed by its viewer (machine-web.ts `useCodeMachines`); the host's views, its canvas among them, read the same
 * list through a feed of their own that the panel never asks.
 */
const ownReads = `(() => {
  const feeds = globalThis.__manifoldFeeds?.() ?? [];
  const viewer = JSON.parse(localStorage.getItem('manifold.identity') ?? 'null')?.principal?.id;
  const machines = feeds.find(feed => feed.key === 'core.machines.list|' + viewer);
  const defaults = feeds.find(feed => feed.key.startsWith('atyrode.omp.readDefaults:'));
  return [machines, defaults].map(feed => feed?.reads.manual ?? null);
})()`;
/**
 * The person looks at another tab and back: a tab opened in the panel's browser window hides the panel's page (its
 * document's visibility), and closing it shows the page again.
 */
async function lookAway(browser: BrowserInstance): Promise<void> {
  const pages = (await browser.send("Target.getTargets", {}, false)).result?.["targetInfos"] as { type: string; attached: boolean; browserContextId?: string }[] | undefined;
  const page = pages?.find(entry => entry.type === "page" && entry.attached);
  assert(page?.browserContextId, "The panel's page is its browser's attached tab");
  const opened = String((await browser.send("Target.createTarget", { url: "about:blank", browserContextId: page.browserContextId }, false)).result?.["targetId"]);
  try {
    await until(browser, "another tab hides the panel's page", "document.visibilityState === 'hidden'");
  } finally {
    await browser.send("Target.closeTarget", { targetId: opened }, false);
  }
  await until(browser, "closing that tab shows the panel's page again", "document.visibilityState === 'visible'");
}
/** Away at another tab and back once the panel's last read, at `readAt`, is old enough that showing again reads (SHOWN_AGAIN_MS). */
async function lookAwayAfter(browser: BrowserInstance, readAt: number): Promise<void> {
  await Bun.sleep(Math.max(0, readAt + SHOWN_AGAIN_MS + 1_000 - Date.now()));
  await lookAway(browser);
}
/**
 * With a read owed, waits until it would have come had nothing held it: past the quiet period after `since`, the last
 * press, and two looks of the held clock (EDIT_QUIET_MS, HOLD_RECHECK_MS). The panel has still read the machine list
 * `count` times.
 */
async function readsHeld(browser: BrowserInstance, description: string, since: number, count: number): Promise<void> {
  await Bun.sleep(Math.max(2 * HOLD_RECHECK_MS, since + EDIT_QUIET_MS + 2 * HOLD_RECHECK_MS - Date.now()));
  assert.equal((await browser.evaluate<number[]>(ownReads))[0], count, description);
}
/** The panel reads the machine list on its own up to `count` times, and no more over two looks of its clock. */
async function readsOnce(browser: BrowserInstance, description: string, count: number): Promise<void> {
  try {
    await waitFor(async () => (await browser.evaluate<number[]>(ownReads))[0]! >= count, timeout, 50);
  } catch {
    throw new ProofFailure(`Timed out: ${description} (the machine list is read ${(await browser.evaluate<number[]>(ownReads))[0]} times, not ${count})`);
  }
  await Bun.sleep(2 * HOLD_RECHECK_MS);
  const read = (await browser.evaluate<number[]>(ownReads))[0];
  assert.equal(read, count, `${description}, once (the machine list is read ${read} times)`);
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
/** Makes the page's next load act as `grant`, as a person signing in as another identity would. */
function identity(grant: TokenGrant): string {
  return `localStorage.setItem('manifold.identity', ${JSON.stringify(JSON.stringify({ token: grant.token, principal: grant.principal }))})`;
}
async function openGenerator(browser: BrowserInstance, server: TestServer, containerId: string): Promise<void> {
  await browser.goto(`${server.httpUrl}/p/${containerId}`);
  await until(browser, "the Code main view is mounted", `${element(stage)} !== null && ${launchButton} !== null`);
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
type UsageWindow = NonNullable<OmpResult<"usage">["snapshot"]>["accounts"][number]["windows"][number];
/**
 * A passive OMP usage reading of an observation's slots, no provider behind it. Each account has its shared 5-hour
 * window, fresh, and beside it the weekly limit of its own its provider meters, named by its tier (#248): Anthropic's
 * `fable`, used up, and a Codex named limit with a long name. Only the shared windows judge a provider's pool.
 */
function fixtureUsage(observation: OmpResult<"accounts">): OmpResult<"usage"> {
  const now = Date.now() - 1_000;
  const window = (windowId: string, tier: string | null, usedFraction: number, resetHours: number, durationMs: number): UsageWindow =>
    ({ windowId, tier, usedFraction, quotaStatus: usedFraction >= 1 ? "exhausted" : "ok", resetsAt: now + resetHours * 3_600_000, durationMs, observedAt: now });
  const tiered: Readonly<Record<string, UsageWindow>> = {
    anthropic: window("7d", "fable", 1, 50, 7 * 86_400_000), "openai-codex": window("7d", "base-model-inference", 0.4, 100, 7 * 86_400_000),
  };
  return { accounts: observation, refreshStatus: "succeeded", snapshot: { scope: fixtureScope, observedAt: now, accounts: observation.accounts.map(account => ({
    provider: account.reference.provider, credentialId: account.credentialId, identityKey: null, observedAt: now, status: "reported",
    windows: [window("5h", null, 0.2, 3, 5 * 3_600_000), ...tiered[account.reference.provider] ? [tiered[account.reference.provider]!] : []],
  })) } };
}
/** A synthetic OMP probe job in the public job shape the native job owner answers: settled, or still running with no result. */
function probeJob(target: Target, jobId: string, operationId: string, requester: string, state: "exited" | "started" = "exited"): PublicJob {
  return PublicJobSchema.parse({ jobId, machineId: target.machineId, operationId, pluginId: "atyrode.omp",
    installationRevision: "synthetic-ui-only", artifactSha256: "c".repeat(64), inputDigest: "e".repeat(64),
    resourceBindingDigest: "d".repeat(64), state, nextInputSeq: null,
    result: state === "started" ? null : { jobId, requestDigest: "f".repeat(64), ownerId: "synthetic-owner", ownerGeneration: 1, state: "exited", exitCode: 0, reason: null,
      startedAt: 1, finishedAt: 2, usage: null, outputs: [], limits: { timeoutMs: 600_000, memoryBytes: 1 << 30, processes: 64, outputBytes: 1 << 20 } },
    authority: { origin: { kind: "action", traceId: "synthetic-trace", door: "atyrode.omp.startInventory" }, requester, executor: null, decision: null } });
}
/**
 * The artifact an installation of the pinned OMP bundle runs from on a linux-x64 machine, as the bundle declares it: the
 * hub pins an installation to its platform's declared artifact, so this is what an inventory there runs from and what its
 * destination pins.
 */
function pinnedOmpArtifact(): string {
  const packed = JSON.parse(readFileSync(join(ompBundleDirectory, "atyrode.omp.manifold-plugin.json"), "utf8")) as {
    manifest: { machine: { artifacts: Record<string, { sha256: string }> } };
  };
  const artifact = packed.manifest.machine.artifacts["linux-x64"]?.sha256;
  assert(artifact, "The pinned OMP bundle declares a linux-x64 artifact");
  return artifact;
}

/**
 * The profile the panel holds, as it shows it: the rows' values; the model list in Models, each rung by its model's key
 * (Models opens once where it has not yet, since a visited sheet stays mounted while hidden); and the unsaved edit this
 * tab keeps for a reload (draft-store.ts), exactly the selection, base revision, catalog digests and bundled list it
 * rests on, and nothing while the rows repeat the team the list gives. Two equal readings are the same profile.
 */
type Profile = { rows: string; list: string[]; kept: string | null };
/** Each rung Models draws, `family:tier key`, in order. */
const modelList = `[...document.querySelectorAll('${modelsSheet} [data-cell][data-key]')].map(cell => cell.dataset.cell + ' ' + cell.dataset.key).sort()`;
async function readProfile(browser: BrowserInstance, draftKey: string): Promise<Profile> {
  if (!await browser.evaluate<boolean>(`${element(modelsSheet)} !== null`)) {
    await openSheet(browser, "models");
    await closeSheet(browser);
  }
  await until(browser, "the profile shows in the rows and in Models' list", `${row("lane")} !== null && ${modelList}.length > 0`);
  return browser.evaluate<Profile>(`({ rows: ${profileValues}, list: ${modelList}, kept: sessionStorage.getItem(${JSON.stringify(draftKey)}) })`);
}
/** The rungs Models draws for a list: each model on a rung (tiers 1 to 4) of its family's ladder, by its key. */
function listOf(document: { readonly models: readonly { readonly key: string; readonly provider: string; readonly tier: number }[] }): string[] {
  return document.models.filter(model => model.tier >= 1 && model.tier <= 4).map(model => `${providerPolicy(model.provider).family}:${model.tier} ${model.key}`).sort();
}
/** The unsaved edit a profile keeps, as the panel itself reads it back. */
function keptEdit(profile: Pick<Profile, "kept">): StoredDraft {
  const kept = readStoredDraft({ getItem: () => profile.kept, setItem: () => undefined, removeItem: () => undefined }, "kept");
  assert(kept, "The panel keeps the unsaved edit for a reload");
  return kept;
}
/**
 * A profile this browser launched in the workspace before, as the panel keeps it (recent-teams.ts):
 * device-local, per principal and workspace, read when the panel mounts. It gives the digits a profile
 * to recall without a launch, which the fixture refuses.
 */
async function rememberTeam(browser: BrowserInstance, principalId: string, containerId: string, selection: Selection): Promise<void> {
  await browser.evaluate(`localStorage.setItem(${JSON.stringify(recentTeamsKey(principalId, containerId))}, ${JSON.stringify(JSON.stringify([{ selection, launchedAt: Date.now() - 60_000 }]))})`);
}

async function usableStarter(browser: BrowserInstance): Promise<void> {
  await until(browser, "the bundled preview fills the generator's rows", `${JSON.stringify(ROWS)}.every(id => document.querySelector('${generator} [data-row="' + id + '"]'))`);
  // A bundled preview is saved only by the verification that replaces it; the fixture reads no accounts and has no discovery, so that is refused.
  await until(browser, "the starter's only step is a refused verification", launchIs("verify models", "refused"));
  // Before shared policy exists no row is locked. The generator's rows are the stage's; Setup's checklist rows are its own.
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('${stage} [data-row]')].filter(row => row.getAttribute('aria-disabled') === 'true').map(row => row.dataset.row)`), [],
    "Every row is editable before shared policy exists");
  assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('${stage} [data-row]')].filter(row => {
    const stops = row.querySelectorAll('[role="radio"][tabindex="0"]');
    return stops.length !== 1 || stops[0].getAttribute('aria-checked') !== 'true';
  }).map(row => row.dataset.row)`), [], "Each row is one keyboard Tab stop: its chosen value");
  // The default profile keeps the old Code advisor default (glance), so the advisor role is routed.
  await assertRoutes(browser, true);
}

// ---------------------------------------------------------------- acceptance a browser can prove

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

/** The views a key opens from the generator, and back with Esc. Routing and usage are views of their own only when narrow. */
type View = "main" | "accounts" | "sessions" | "routing" | "usage";
const VIEW_KEYS: Readonly<Record<Exclude<View, "main">, { key: string; code: number }>> = {
  accounts: { key: "a", code: 65 }, sessions: { key: "e", code: 69 }, routing: { key: "p", code: 80 }, usage: { key: "s", code: 83 },
};
/**
 * A view changed by a key keeps focus in the panel a frame later (web.tsx `keepFocus`), never on a control the view hid;
 * the next step waits for that, so what it reads as focused is what a person would have focused.
 */
const focusShown = `(() => { const active = document.activeElement; return !active?.closest('${stage}') || active.offsetParent !== null; })()`;
async function showView(browser: BrowserInstance, view: View): Promise<void> {
  let pressed = false;
  for (let step = 0; step < 2 && !await browser.evaluate<boolean>(shownView("main")) && !await browser.evaluate<boolean>(shownView(view)); step++) {
    await key(browser, "Escape", 27);
    pressed = true;
  }
  await until(browser, `Esc goes back towards ${view}, focus kept on what shows`, `(${shownView("main")} || ${shownView(view)}) && ${pressed ? focusShown : "true"}`);
  if (view === "main" || await browser.evaluate<boolean>(shownView(view))) return;
  if (!await browser.evaluate<boolean>(`!!document.activeElement?.closest('${stage}') || document.activeElement === ${element(generator)}`)) await click(browser, generatorTitle);
  await key(browser, VIEW_KEYS[view].key, VIEW_KEYS[view].code);
  await until(browser, `${view} takes the stage, focus kept on what shows`, `${shownView(view)} && ${focusShown}`);
}

/**
 * The shown view's text and controls, as painted: the stage's (`[data-tui]`) or an open sheet's. Glyphs paint inside the
 * middle of a text box: a font's ascent and descent may reach into a neighbouring line without any ink touching, so each
 * box is trimmed by a fifth top and bottom before two are compared. Text that runs past a box that clips it sideways is
 * cut, unless that box ends it in an ellipsis or a line clamp; a scroll width hidden by a clip is still overflow.
 * Screen-reader text is clipped to a pixel on purpose and is left out. A control (`controls`) narrower than 24px can no
 * longer be read or pressed.
 */
type Paint = { overflow: number; overlaps: string[]; outside: string[]; cut: string[]; small: string[]; texts: number };
function paintOf(view: string, controls: string): string {
  return `(() => {
  const root = document.querySelector('${generator}');
  const view = root.querySelector('${view}');
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
  const boxes = [], cut = [];
  const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim()) continue;
    const parent = node.parentElement;
    if (parent.closest('.plugin-atyrode_code__sr') || !parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const clip = clipOf(parent);
    const text = node.textContent.trim().slice(0, 32);
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width < 1) continue;
      for (let box = parent; box && box !== root.parentElement; box = box.parentElement) {
        const style = getComputedStyle(box);
        if (style.overflowX === 'visible') continue;
        const edge = box.getBoundingClientRect();
        const ends = style.textOverflow === 'ellipsis' || getComputedStyle(parent).textOverflow === 'ellipsis' || style.webkitLineClamp !== 'none';
        if ((rect.left < edge.left - 1 || rect.right > edge.right + 1) && !ends) {
          cut.push(JSON.stringify(text) + ' cut by ' + (box.className || box.tagName));
          break;
        }
      }
      const inset = rect.height / 5;
      const box = { left: Math.max(rect.left, clip.left), right: Math.min(rect.right, clip.right),
        top: Math.max(rect.top + inset, clip.top), bottom: Math.min(rect.bottom - inset, clip.bottom) };
      if (box.right - box.left > 1 && box.bottom - box.top > 1) boxes.push({ node, text, box });
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
  const small = [...view.querySelectorAll('${controls}')]
    .filter(el => el.checkVisibility({ visibilityProperty: true }) && el.getClientRects().length && el.getBoundingClientRect().width < 24)
    .map(el => (el.dataset.row ?? (el.getAttribute('aria-label') || el.textContent.trim()).slice(0, 32)) + ' ' + Math.round(el.getBoundingClientRect().width) + 'px');
  return { overflow: Math.max(0, viewport.scrollWidth - viewport.clientWidth, view.scrollWidth - view.clientWidth),
    overlaps: overlaps.slice(0, 6), outside: outside.slice(0, 6), cut: cut.slice(0, 6), small, texts: boxes.length };
})()`;
}
const PAINT = paintOf("[data-tui]", `button, [role="tab"], [role="switch"], [role="checkbox"], [role="listbox"]`);
/** The open sheet over the stage, and the controls it offers: every one a target, the list's cells and the left-out ids among them. */
const openSheetHost = `.${G}sheet-host:not([hidden])`;
const SHEET_CONTROLS = `button, select, input, textarea, [role="radio"], [role="gridcell"], [tabindex="0"]`;

/**
 * Every laid-out element of a view by its layout box: offsets summed up the offset parents and taken from the view's own,
 * so a transform (the ▸ pointer sliding in, the launch glyph's nudge, the glider) and a scroll are not shifts. Left out:
 * what `skip` holds for an element. In the main view that is what the readouts say, which by design changes inside their
 * fixed boxes with whatever is pointed or focused; the next-refresh line, which follows the clock and the refresh
 * cadence, never the pointer; and screen-reader text. In a sheet it is what its readout line says, and the head's state
 * line, which follows the clock ("verified 1m ago") and never the pointer.
 */
function boxesOf(view: string, skip: string): string {
  return `(() => {
  const stage = document.querySelector('${view}');
  const at = element => { let x = 0, y = 0; for (let node = element; node; node = node.offsetParent) { x += node.offsetLeft; y += node.offsetTop; } return [x, y]; };
  const [ox, oy] = at(stage);
  const boxes = new Map();
  for (const element of stage.querySelectorAll('*')) {
    if (!(element instanceof HTMLElement) || element.offsetParent === null || ${skip}) continue;
    const [x, y] = at(element);
    boxes.set(element, [x - ox, y - oy, element.offsetWidth, element.offsetHeight].join(','));
  }
  globalThis.__codeStage = stage;
  globalThis.__codeBoxes = boxes;
  return boxes.size;
})()`;
}
const BOXES = boxesOf(stage, `element.parentElement?.closest('.${G}readout, .${G}route-readout, .${G}usage-refresh, .plugin-atyrode_code__sr')`);
const SHEET_BOXES = boxesOf(`${generator} ${openSheetHost}`, `element.closest('.${G}sheet-state, .plugin-atyrode_code__sr') || element.parentElement?.closest('[data-readout]')`);
const SHIFTED = `(() => {
  const at = element => { let x = 0, y = 0; for (let node = element; node; node = node.offsetParent) { x += node.offsetLeft; y += node.offsetTop; } return [x, y]; };
  const [ox, oy] = at(globalThis.__codeStage);
  const moved = [];
  for (const [element, before] of globalThis.__codeBoxes) {
    if (!element.isConnected || element.offsetParent === null) continue;
    const [x, y] = at(element);
    const now = [x - ox, y - oy, element.offsetWidth, element.offsetHeight].join(',');
    if (now !== before) moved.push((element.className || element.tagName) + ' ' + JSON.stringify((element.textContent ?? '').trim().slice(0, 24)) + ' ' + before + ' -> ' + now);
  }
  return moved.slice(0, 6);
})()`;

/** The panel widths of the geometry sweep: 760 to 790px are the medium layout's narrowest, where the routing pane is about 250px. */
const WIDTHS = [1440, 1280, 1100, 860, 790, 780, 770, 760, 620, 560, 390, 320, 240, 170];
/**
 * Text of the routing pane whose painted part runs past the pane's sides: a role, a route's `model:thinking` token or
 * its fallback chain. A box inside the pane that clips its text (a role ending in an ellipsis) bounds what paints.
 */
const PAST_ROUTING = `(() => {
  const pane = document.querySelector('${generator} [data-pane="routing"]');
  if (!pane || !pane.checkVisibility()) return [];
  const edge = pane.getBoundingClientRect(), past = [];
  const walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!node.textContent.trim() || parent.closest('.plugin-atyrode_code__sr') || !parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    let left = -Infinity, right = Infinity;
    for (let box = parent; box && box !== pane; box = box.parentElement) {
      if (getComputedStyle(box).overflowX === 'visible') continue;
      const clip = box.getBoundingClientRect();
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      const from = Math.max(rect.left, left), to = Math.min(rect.right, right);
      if (to - from >= 1 && (from < edge.left - 1 || to > edge.right + 1)) past.push(JSON.stringify(node.textContent.trim().slice(0, 32)) + ' by ' + Math.round(Math.max(edge.left - from, to - edge.right)) + 'px');
    }
  }
  return past.slice(0, 6);
})()`;
/** Where More's open menu leaves the panel, or cuts an item's words. */
const MENU_OUTSIDE = `(() => {
  const panel = document.querySelector('${generator}').getBoundingClientRect(), box = ${menu}.getBoundingClientRect(), problems = [];
  if (box.left < panel.left - 1 || box.right > panel.right + 1 || box.top < panel.top - 1 || box.bottom > panel.bottom + 1) {
    problems.push("More's menu " + [box.left, box.right, box.top, box.bottom].map(Math.round).join(',') + ' leaves the panel ' + [panel.left, panel.right, panel.top, panel.bottom].map(Math.round).join(','));
  }
  for (const item of ${menuItems}) if (item.scrollWidth > item.clientWidth + 1) problems.push("More's " + item.dataset.menuItem + ' item is cut');
  return problems;
})()`;
/**
 * From 170 to 1440px of panel width, in every view the width offers (routing and usage are views of
 * their own when narrow): text paints, and there is no horizontal overflow, no cut text, no text
 * outside the panel, no text box intersecting another, no text past the routing pane and no control
 * too narrow to press, in each of the panel's three layouts; in the medium layout with the routing's
 * fallback chains shown too. More's menu opens inside the panel at every width. Every width and view
 * is measured before the verdict, so one run names every place that fails.
 */
async function geometryAcrossWidths(browser: BrowserInstance, label: string): Promise<void> {
  const modes = new Set<string>();
  const problems: string[] = [];
  const chains = element(`${generator} [data-chains]`);
  const measure = async (where: string, view: string) => {
    const facts = await browser.evaluate<Paint>(PAINT);
    if (facts.texts <= (view === "main" ? 20 : 3)) problems.push(`${where}: too little text paints (${facts.texts})`);
    if (facts.overflow !== 0) problems.push(`${where}: ${facts.overflow}px horizontal overflow`);
    problems.push(...facts.cut.map(entry => `${where}: ${entry}`), ...facts.outside.map(entry => `${where}: ${entry} paints outside the panel`),
      ...facts.overlaps.map(entry => `${where}: ${entry}`), ...facts.small.map(entry => `${where}: control ${entry} wide`),
      ...(await browser.evaluate<string[]>(PAST_ROUTING)).map(entry => `${where}: ${entry} past the routing pane`));
  };
  try {
    for (const width of WIDTHS) {
      await panelWidth(browser, width);
      const mode = await browser.evaluate<string>(`${element(stage)}.dataset.mode`);
      modes.add(mode);
      for (const view of ["main", "accounts", "sessions", ...(mode === "narrow" ? ["routing", "usage"] as const : [])] as const) {
        await showView(browser, view);
        await still(browser);
        const where = `${view} at ${width}px`;
        await measure(where, view);
        if (view !== "main") continue;
        if (mode === "medium") {
          if (!await browser.evaluate<boolean>(`!!document.activeElement?.closest('${stage}') || document.activeElement === ${element(generator)}`)) await click(browser, generatorTitle);
          await key(browser, "f", 70);
          await until(browser, "f shows the routing's fallback chains", `${chains}.getAttribute('aria-checked') === 'true'`);
          await still(browser);
          await measure(`${where} with the fallback chains`, view);
          await key(browser, "f", 70);
          await until(browser, "f hides the fallback chains", `${chains}.getAttribute('aria-checked') !== 'true'`);
        }
        await openMenu(browser);
        problems.push(...(await browser.evaluate<string[]>(MENU_OUTSIDE)).map(entry => `${where}: ${entry}`));
        await key(browser, "Escape", 27);
        await until(browser, "Esc closes More's menu", `${menu} === null`);
      }
      await showView(browser, "main");
    }
  } finally {
    await browser.send("Emulation.clearDeviceMetricsOverride", {});
  }
  assert.deepEqual(problems, [], `No ${label} view overflows, cuts, collides, runs past the routing pane or squeezes a control from 170 to 1440px, and More's menu stays inside the panel`);
  assert.deepEqual([...modes].sort(), ["medium", "narrow", "wide"], `The ${label} widths exercise the panel's three layouts`);
}

/** Pointing at or focusing any control of the generator, routing, usage or key line moves no layout box (the readouts' words aside). */
async function zeroShift(browser: BrowserInstance, label: string): Promise<void> {
  await showView(browser, "main");
  const targets = await browser.evaluate<number>(`(() => {
    const stage = document.querySelector('${stage}');
    globalThis.__codeTargets = [...stage.querySelectorAll('button, [role="radio"], [role="checkbox"], [role="meter"], .${G}tok')]
      .filter(el => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getClientRects().length);
    return globalThis.__codeTargets.length;
  })()`);
  assert(targets > 30, `The ${label} main view offers its pointer targets`);
  for (let index = 0; index < targets; index++) {
    const target = `globalThis.__codeTargets[${index}]`;
    if (!await browser.evaluate<boolean>(`${target}.isConnected`)) continue;
    await pointAway(browser);
    await still(browser);
    await browser.evaluate(BOXES);
    await pointOf(browser, target);
    await settle(browser);
    assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], `Pointing at ${label} target ${index} shifts no layout box`);
  }
  await pointAway(browser);
  await click(browser, generatorTitle);
  await still(browser);
  await browser.evaluate(BOXES);
  for (let step = 0; step < 60; step++) {
    await key(browser, "Tab", 9);
    await settle(browser);
    if (!await browser.evaluate<boolean>(`!!document.activeElement?.closest('${stage}')`)) break;
    assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], `Keyboard focus step ${step} in the ${label} main view shifts no layout box`);
  }
}

/** On a coarse pointer every target of the generator, the accounts and the sessions is at least 44px: a row by its height, anything else both ways. */
async function coarseTargets(browser: BrowserInstance, label: string): Promise<void> {
  for (const width of [1280, 860, 390, 240]) {
    await panelWidth(browser, width);
    for (const view of ["main", "accounts", "sessions"] as const) {
      await showView(browser, view);
      // In the main view More's menu is open, so its items are measured with every other target.
      if (view === "main") {
        await tap(browser, more);
        await until(browser, "a tap on More opens its menu", `${menu} !== null`);
      }
      // A row's words are its targets, tall like the row and as wide as their word, spaced by the row's gap.
      const small = await browser.evaluate<string[]>(`[...document.querySelectorAll(${JSON.stringify(`${stage} :is(button, [role="radio"], [role="switch"], [role="checkbox"], [role="listbox"])`)})]
        .filter(el => el.checkVisibility({ visibilityProperty: true }) && el.getClientRects().length)
        // Fractional layout may leave a 44px target a fraction of a pixel short; half a pixel is the tolerance.
        .filter(el => { const rect = el.getBoundingClientRect(); return rect.height < 43.5 || (!el.matches('[role="radio"]') && rect.width < 43.5); })
        .map(el => (el.closest('[data-row]')?.dataset.row ?? '') + (el.getAttribute('aria-label') || el.textContent.trim()).slice(0, 24) + ' ' + el.getBoundingClientRect().width.toFixed(1) + 'x' + el.getBoundingClientRect().height.toFixed(1))`);
      if (view === "main") {
        await key(browser, "Escape", 27);
        await until(browser, "Esc closes More's menu", `${menu} === null`);
      }
      assert.deepEqual(small, [], `Every target is at least 44px on a coarse pointer in the ${label} ${view} view at ${width}px${view === "main" ? ", More's open menu included" : ""}`);
    }
  }
  await showView(browser, "main");
}

// ---------------------------------------------------------------- the Models and Setup sheets: geometry, shift, touch, motion

/**
 * From 170 to 1440px of panel width the open sheet paints inside the panel (`paintOf`): no horizontal overflow, cut text,
 * text outside the panel or over other text and no control too narrow to press, in each of its three layouts
 * (`data-mode`: tiny, narrow, wide). Every width is measured before the verdict, so one run names every place that fails.
 */
async function sheetGeometry(browser: BrowserInstance, sheet: string, label: string): Promise<void> {
  const modes = new Set<string>();
  const problems: string[] = [];
  try {
    for (const width of WIDTHS) {
      await panelWidth(browser, width);
      await still(browser);
      modes.add(await browser.evaluate<string>(`${element(sheet)}.dataset.mode`));
      const facts = await browser.evaluate<Paint>(paintOf(openSheetHost, SHEET_CONTROLS));
      const where = `${label} at ${width}px`;
      if (facts.texts <= 3) problems.push(`${where}: too little text paints (${facts.texts})`);
      if (facts.overflow !== 0) problems.push(`${where}: ${facts.overflow}px horizontal overflow`);
      problems.push(...facts.cut.map(entry => `${where}: ${entry}`), ...facts.outside.map(entry => `${where}: ${entry} paints outside the panel`),
        ...facts.overlaps.map(entry => `${where}: ${entry}`), ...facts.small.map(entry => `${where}: control ${entry} wide`));
    }
  } finally {
    await browser.send("Emulation.clearDeviceMetricsOverride", {});
  }
  assert.deepEqual(problems, [], `The ${label} paints inside the panel from 170 to 1440px: no overflow, cut or colliding text and no squeezed control`);
  assert.deepEqual([...modes].sort(), ["narrow", "tiny", "wide"], `The ${label} widths exercise the sheet's three layouts`);
}

/** Everything in a sheet a pointer or the keyboard can reach: its controls, Setup's row values, and the list's providers and left-out ids, which say their readout. */
function sheetTargets(sheet: string): string {
  return `[...document.querySelectorAll('${sheet} :is(${SHEET_CONTROLS}, [data-roving], .${G}models-pw, .${G}models-xid)')]
    .filter(el => !el.closest('dialog') && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getClientRects().length)`;
}
/** Pointing at or focusing anything in the open sheet moves no layout box (`SHEET_BOXES`); only the readout line's words change. */
async function sheetZeroShift(browser: BrowserInstance, sheet: string, label: string): Promise<void> {
  const targets = await browser.evaluate<number>(`(globalThis.__codeTargets = ${sheetTargets(sheet)}).length`);
  assert(targets > 5, `The ${label} offers its pointer targets`);
  for (let index = 0; index < targets; index++) {
    const target = `globalThis.__codeTargets[${index}]`;
    if (!await browser.evaluate<boolean>(`${target}.isConnected`)) continue;
    await pointAway(browser);
    await still(browser);
    await browser.evaluate(SHEET_BOXES);
    await pointOf(browser, target);
    await settle(browser);
    assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], `Pointing at ${label} target ${index} shifts no layout box`);
  }
  // A press on the sheet's title leaves focus on the panel root behind it, from where Tab walks the sheet.
  await pointAway(browser);
  await click(browser, element(`${sheet} .${G}sheet-title`));
  await still(browser);
  await browser.evaluate(SHEET_BOXES);
  let stops = 0;
  for (let step = 0; step < 80; step++) {
    await key(browser, "Tab", 9);
    await settle(browser);
    if (!await browser.evaluate<boolean>(`!!document.activeElement?.closest('${sheet}')`)) break;
    stops++;
    assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], `Keyboard focus step ${step} in the ${label} shifts no layout box`);
  }
  assert(stops > 3, `Tab walks the ${label}`);
}

/**
 * On a coarse pointer every target of the open sheet is at least 44px, a word of a choice by its height and anything else
 * both ways, and the key line, whose keys a touch screen does not have, is gone.
 */
async function sheetCoarseTargets(browser: BrowserInstance, sheet: string, label: string): Promise<void> {
  const problems: string[] = [];
  await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    assert.equal(await browser.evaluate("matchMedia('(pointer: coarse)').matches"), true);
    for (const width of [1280, 860, 390, 240]) {
      await panelWidth(browser, width);
      await still(browser);
      // Fractional layout may leave a 44px target a fraction of a pixel short; half a pixel is the tolerance.
      problems.push(...(await browser.evaluate<string[]>(`${sheetTargets(sheet)}
        .filter(el => { const rect = el.getBoundingClientRect(); return rect.height < 43.5 || (!el.matches('[role="radio"]') && rect.width < 43.5); })
        .map(el => (el.getAttribute('aria-label') || el.textContent.trim()).slice(0, 32) + ' ' + el.getBoundingClientRect().width.toFixed(1) + 'x' + el.getBoundingClientRect().height.toFixed(1))`))
        .map(entry => `${label} at ${width}px: ${entry}`));
      if (await browser.evaluate<boolean>(`!!${element(`${sheet} .${G}sheet-keys`)}?.checkVisibility()`)) problems.push(`${label} at ${width}px: the key line shows`);
    }
  } finally {
    await browser.send("Emulation.clearDeviceMetricsOverride", {});
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
  assert.deepEqual(problems, [], `Every target of the ${label} is at least 44px on a coarse pointer, which has no key line`);
}

/** What in the open sheet would still move under reduced motion: an element, or its pseudo-element, whose transition or animation lasts. */
const SHEET_MOTION = `[...document.querySelectorAll('${generator} ${openSheetHost} *')].flatMap(el => [null, '::before', '::after'].flatMap(pseudo => {
  const style = getComputedStyle(el, pseudo);
  return [...style.transitionDuration.split(','), ...style.animationDuration.split(',')].some(value => parseFloat(value) > 0) ? [(el.getAttribute('class') ?? el.tagName) + (pseudo ?? '')] : [];
})).slice(0, 6)`;
/** Under reduced motion nothing in the open sheet animates after `what`: no running animation, and no transition or animation lasts. */
async function sheetStill(browser: BrowserInstance, what: string): Promise<void> {
  await settle(browser);
  assert.deepEqual(await browser.evaluate<string[]>(`${element(generator)}.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running')
    .map(animation => (animation.animationName ?? animation.transitionProperty ?? 'script') + ' on ' + (animation.effect?.target?.getAttribute('class') ?? ''))`), [],
    `Reduced motion: ${what} does not animate`);
  assert.deepEqual(await browser.evaluate<string[]>(SHEET_MOTION), [], `Reduced motion: after ${what} every transition and animation in the sheet lasts 0s`);
}

/**
 * The browser-provable acceptance of the main view on a bundled preview, which keeps every effect
 * local: panel-local keys, keys an open popover owns, the full key line, keyboard edits and refusals,
 * the wheel, touch and coarse targets, reduced motion, zero hover/focus shift and width geometry.
 * `recent` is the browser's one recent profile, which the digit 1 recalls from the sessions view, and
 * `draftKey` where this tab keeps an unsaved edit of the profile (`readProfile`).
 * Leaves the profile as it found it.
 */
async function acceptanceScenario(browser: BrowserInstance, label: string, recent: Selection, draftKey: string): Promise<void> {
  const before = await readProfile(browser, draftKey);
  const thinking = await browser.evaluate<string>(chosenKey("thinking")), advisor = await browser.evaluate<string>(chosenKey("advisor"));
  const quiet = await browser.evaluate<string>(`${liveRegion}.textContent`);
  const routing = element(`${generator} [data-pane="routing"]`), usage = element(`${generator} [data-pane="usage"]`);
  // The main view as it rests: the generator with routing and usage, no sheet, no shortcuts dialog and the fallback chains hidden.
  const resting = `${shownView("main")} && !${shortcuts}?.open && ${element(stage)}.hidden === false && ${routing}.hidden === false && ${usage}.hidden === false &&
    ${element(`${generator} [data-chains]`)}.getAttribute('aria-checked') !== 'true'`;

  // Keys are panel-local: the same keys pressed in another panel never reach the generator.
  await click(browser, element(".react-flow .react-flow__pane"));
  for (const [name, code] of [["?", 191], ["a", 65], ["e", 69], ["m", 77], ["w", 87], ["p", 80], ["d", 68], ["f", 70], ["ArrowDown", 40], ["Enter", 13]] as const) await key(browser, name, code);
  await Bun.sleep(300);
  assert.equal(await browser.evaluate(`${resting} && ${machineList} === null && !document.activeElement?.closest('${generator}')`), true,
    "A key pressed outside the panel changes none of its views, panes, key line, sheets or focus");
  assert.deepEqual(await readProfile(browser, draftKey), before, "Keys pressed outside the panel never edit its profile");

  // Behind a sheet the panel's keys do nothing, even with the panel root itself focused: not ↵ or Mod+↵ (the launch's
  // step, here a refusal it would say aloud), not a view, not the key line, not defaults.
  await openSheet(browser, "options");
  await click(browser, element(`${generator} .${G}options-lede`));
  assert.equal(await browser.evaluate(`document.activeElement === ${element(generator)}`), true, "A press on a sheet's text leaves focus on the panel root behind it");
  for (const [name, code, modifiers] of [["?", 191, 0], ["a", 65, 0], ["e", 69, 0], ["w", 87, 0], ["d", 68, 0], ["Enter", 13, 0], ["Enter", 13, CTRL]] as const) {
    await key(browser, name, code, { modifiers });
  }
  await Bun.sleep(300);
  assert.deepEqual(await browser.evaluate(`({ view: ${element(stage)}.dataset.view, shortcuts: !!${shortcuts}?.open, sheet: ${element(stage)}.hidden, said: ${liveRegion}.textContent })`),
    { view: "main", shortcuts: false, sheet: true, said: quiet }, "No panel key acts behind a sheet: no view, shortcuts or step, nothing said");
  await closeSheet(browser);
  assert.deepEqual(await readProfile(browser, draftKey), before, "No panel key behind a sheet edits the profile");

  // An open popover owns its keys: with the machine list open, the panel's keys leave it alone, and ↵ is the list's own choice.
  await focusRow(browser, "thinking");
  await key(browser, "w", 87);
  await until(browser, "w opens the machine list with focus in it", `${machineList} !== null && document.activeElement === ${machineList}`);
  const machine = await browser.evaluate<string>(`${machinePicker}.textContent`);
  for (const [name, code] of [["a", 65], ["e", 69], ["p", 80], ["s", 83], ["?", 191], ["m", 77], ["u", 85], ["o", 79], ["d", 68], ["f", 70], ["z", 90], ["1", 49]] as const) {
    await key(browser, name, code);
  }
  await Bun.sleep(300);
  assert.equal(await browser.evaluate(`${resting} && document.activeElement === ${machineList}`), true,
    "With the machine list open no panel key changes a view, a pane, the key line, the chains or a sheet, and the list keeps focus");
  assert.deepEqual(await readProfile(browser, draftKey), before, "With the machine list open no panel key edits the profile");
  await key(browser, "Enter", 13, { modifiers: CTRL });
  await until(browser, "↵ in the list chooses its machine and closes onto the machine's word", `${machineList} === null && document.activeElement === ${machinePicker}`);
  assert.deepEqual(await browser.evaluate(`({ machine: ${machinePicker}.textContent, said: ${liveRegion}.textContent })`), { machine, said: quiet },
    "Mod+↵ in the open list takes no launch step, and choosing the current machine changes nothing");
  await key(browser, "w", 87);
  await until(browser, "w opens the list again", `${machineList} !== null && document.activeElement === ${machineList}`);
  await key(browser, "Escape", 27);
  await until(browser, "Esc closes the list onto the machine's word", `${machineList} === null && document.activeElement === ${machinePicker}`);
  await click(browser, machinePicker);
  await until(browser, "a press opens the list", `${machineList} !== null`);
  await click(browser, element(`${generator} [data-pane="routing"] .${G}title`));
  await until(browser, "a press outside closes the list", `${machineList} === null`);

  // `?` opens the shortcuts as a modal dialog with focus in it; from there the panel's keys take no step and change no view,
  // Tab never reaches a control behind it, and Esc closes it onto the row it was opened from.
  await focusRow(browser, "thinking");
  await key(browser, "?", 191);
  await until(browser, "? opens the shortcuts with focus in them", `!!${shortcuts}?.open && ${shortcuts}.matches(':modal') && ${shortcuts}.contains(document.activeElement)`);
  for (const [name, code] of [["a", 65], ["e", 69], ["d", 68], ["1", 49]] as const) await key(browser, name, code);
  for (const modifiers of [0, 0, 0, SHIFT, SHIFT]) await key(browser, "Tab", 9, { modifiers });
  await Bun.sleep(300);
  assert.deepEqual(await browser.evaluate(`({ view: ${element(stage)}.dataset.view, open: ${shortcuts}.open,
    behind: !!document.activeElement?.closest('${generator}') && !${shortcuts}.contains(document.activeElement), said: ${liveRegion}.textContent })`),
    { view: "main", open: true, behind: false, said: quiet }, "From the shortcuts no panel key acts, and Tab reaches no control behind them");
  assert.deepEqual(await readProfile(browser, draftKey), before, "Keys pressed in the shortcuts never edit the profile");
  await key(browser, "Escape", 27);
  await until(browser, "Esc closes the shortcuts onto the row they were opened from", `!${shortcuts}.open && !!${row("thinking")}.contains(document.activeElement)`);
  // Mod+↵ in the shortcuts is their Close button's own press: it closes them and takes no launch step.
  await key(browser, "?", 191);
  await until(browser, "? opens the shortcuts again", `!!${shortcuts}?.open && ${shortcuts}.contains(document.activeElement)`);
  await key(browser, "Enter", 13, { modifiers: CTRL });
  await Bun.sleep(300);
  assert.equal(await browser.evaluate(`${liveRegion}.textContent`), quiet, "Mod+↵ in the shortcuts takes no launch step");
  if (await browser.evaluate<boolean>(`${shortcuts}.open`)) await key(browser, "Escape", 27);
  await until(browser, "the shortcuts close onto the row", `!${shortcuts}.open && !!${row("thinking")}.contains(document.activeElement)`);

  // More, the bar's one menu, is a WAI-ARIA menu button. A press opens it with focus on its first item, which names the
  // key that does the same from the main view; ↑/↓ walk its items round from end to end, Home and End reach its ends,
  // and pointing at an item focuses it. Opening the menu, walking it and pointing at it move nothing on the stage.
  await pointAway(browser);
  await still(browser);
  await browser.evaluate(BOXES);
  await openMenu(browser);
  assert.equal(await browser.evaluate(`${more}.getAttribute('aria-haspopup') === 'menu' && ${more}.getAttribute('aria-controls') === ${menu}.id &&
    ${menu}.getAttribute('aria-labelledby') === ${more}.id && ${menu}.getAttribute('role') === 'menu'`), true, "More is a menu button that controls the menu it labels");
  assert.deepEqual(await browser.evaluate(`${menuItems}.map(item => [item.dataset.menuItem, item.getAttribute('aria-keyshortcuts')])`),
    [["models", "m"], ["setup", "u"], ["options", "o"], ["shortcuts", "?"]], "More holds Models, Setup, Options and Shortcuts, each naming its key from the main view");
  assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], "Opening More shifts nothing on the stage");
  for (const [name, code, at] of [["ArrowDown", 40, 1], ["ArrowDown", 40, 2], ["ArrowDown", 40, 3], ["ArrowDown", 40, 0], ["ArrowUp", 38, 3],
    ["Home", 36, 0], ["End", 35, 3], ["ArrowUp", 38, 2]] as const) {
    await key(browser, name, code);
    await until(browser, `${name} moves to More's ${MENU[at]} item`, `document.activeElement === ${menuItem(MENU[at]!)}`);
    await settle(browser);
    assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], `Focus on More's ${MENU[at]} item shifts nothing on the stage`);
  }
  for (const id of MENU) {
    await pointOf(browser, menuItem(id));
    await until(browser, `pointing at More's ${id} item focuses it`, `document.activeElement === ${menuItem(id)}`);
    await settle(browser);
    assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], `Pointing at More's ${id} item shifts nothing on the stage`);
  }
  // An open menu owns its keys: the panel's leave it alone, and Esc closes it onto More.
  for (const [name, code] of [["a", 65], ["e", 69], ["w", 87], ["d", 68], ["f", 70], ["1", 49]] as const) await key(browser, name, code);
  await Bun.sleep(300);
  assert.equal(await browser.evaluate(`${resting} && ${machineList} === null && ${menu} !== null && ${menu}.contains(document.activeElement)`), true,
    "With More open no panel key changes a view, a pane, the key line, the chains or the machine, and the menu keeps focus");
  await key(browser, "Escape", 27);
  await until(browser, "Esc closes More's menu onto More", `${menu} === null && ${more}.getAttribute('aria-expanded') === 'false' && document.activeElement === ${more}`);
  await settle(browser);
  assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], "Closing More shifts nothing on the stage");
  assert.deepEqual(await readProfile(browser, draftKey), before, "With More open no panel key edits the profile");
  // From More the keyboard opens the menu (↵ and Space on its first item, ↓ too, ↑ on its last), ↵ or Space chooses an
  // item and an item's own key chooses it as well; what it opens gives focus back to More.
  await key(browser, "Enter", 13);
  await until(browser, "↵ on More opens its menu on its first item", `document.activeElement === ${menuItem("models")}`);
  await key(browser, "ArrowDown", 40);
  await key(browser, "Enter", 13);
  await until(browser, "↵ on More's Setup item opens Setup", sheetOpen("Setup"));
  await key(browser, "Escape", 27);
  await until(browser, "Esc closes Setup onto More", `${element(stage)}.hidden === false && document.activeElement === ${more}`);
  await key(browser, " ", 32);
  await until(browser, "Space on More opens its menu on its first item", `document.activeElement === ${menuItem("models")}`);
  await key(browser, "ArrowDown", 40);
  await key(browser, "ArrowDown", 40);
  await key(browser, " ", 32);
  await until(browser, "Space on More's Options item opens the session options", sheetOpen("Session options"));
  await key(browser, "Escape", 27);
  await until(browser, "Esc closes the session options onto More", `${element(stage)}.hidden === false && document.activeElement === ${more}`);
  await key(browser, "ArrowUp", 38);
  await until(browser, "↑ on More opens its menu on its last item", `document.activeElement === ${menuItem("shortcuts")}`);
  await key(browser, "Enter", 13);
  await until(browser, "↵ on More's Shortcuts item opens the shortcuts", `!!${shortcuts}?.open && ${shortcuts}.matches(':modal') && ${shortcuts}.contains(document.activeElement)`);
  await key(browser, "Escape", 27);
  await until(browser, "Esc closes the shortcuts onto More", `!${shortcuts}.open && document.activeElement === ${more}`);
  await key(browser, "ArrowDown", 40);
  await until(browser, "↓ on More opens its menu on its first item", `document.activeElement === ${menuItem("models")}`);
  await key(browser, "o", 79);
  await until(browser, "o in the open menu chooses the session options", sheetOpen("Session options"));
  await closeSheet(browser);
  await until(browser, "the session options close onto More", `document.activeElement === ${more}`);
  // An item names a key only where the panel's keys give it that action: from the accounts, where m manages the accounts
  // and u and o do nothing, only ? does what an item does.
  await key(browser, "a", 65);
  await until(browser, "a opens the accounts", shownView("accounts"));
  await openMenu(browser);
  assert.deepEqual(await browser.evaluate(`${menuItems}.map(item => item.getAttribute('aria-keyshortcuts'))`), [null, null, null, "?"],
    "From the accounts More names only ? as a key");
  // A press outside closes the menu.
  await click(browser, element(`${generator} [data-pane="accounts"] .${G}title`));
  await until(browser, "a press outside closes More's menu", `${menu} === null && ${more}.getAttribute('aria-expanded') === 'false'`);
  await key(browser, "Escape", 27);
  await until(browser, "Esc goes back to the generator", shownView("main"));
  assert.deepEqual(await readProfile(browser, draftKey), before, "More and what it opens change no setting");
  // More flows after the last tab, on its line: the bar is one line at 1280 and 800px and two at 320px.
  try {
    for (const [width, lines] of [[1280, 1], [800, 1], [320, 2]] as const) {
      await panelWidth(browser, width);
      assert.deepEqual(await browser.evaluate(`(() => {
        const tabs = [...document.querySelectorAll('${generator} [role="tablist"] [role="tab"]')].map(tab => tab.getBoundingClientRect());
        const last = tabs.at(-1), button = ${more}.getBoundingClientRect();
        return { lines: new Set(tabs.map(rect => Math.round(rect.top))).size, onLast: button.top >= last.top - 0.5 && button.bottom <= last.bottom + 0.5 && button.left >= last.right };
      })()`), { lines, onLast: true }, `At ${width}px More sits on the last tab's line, and the bar is ${lines} ${lines === 1 ? "line" : "lines"}`);
    }
  } finally {
    await browser.send("Emulation.clearDeviceMetricsOverride", {});
  }

  // The sessions view lists the recent profile; its digit recalls it, and choosing the settings back returns the exact profile.
  await key(browser, "e", 69);
  await until(browser, "e opens the sessions", shownView("sessions"));
  const listed = await browser.evaluate<string>(`${liveRegion}.textContent`);
  await key(browser, "1", 49);
  await until(browser, "1 recalls the recent profile and says so",
    `${chosenKey("advisor")} === ${JSON.stringify(recent.advisor)} && ${chosenKey("thinking")} === ${JSON.stringify(recent.thinking)} && ${liveRegion}.textContent !== '' && ${liveRegion}.textContent !== ${JSON.stringify(listed)}`);
  await key(browser, "Escape", 27);
  await until(browser, "Esc goes back to the generator", shownView("main"));
  await choose(browser, "advisor", advisor);
  await choose(browser, "thinking", thinking);
  assert.deepEqual(await readProfile(browser, draftKey), before, "Recalling a profile and choosing its settings back returns the exact profile");

  // Keyboard edits: → is more, Home and End reach the row's ends, ↑/↓ move between rows, and the rows are one Tab stop.
  await focusRow(browser, "thinking");
  const available = await browser.evaluate<string[]>(`[...${row("thinking")}.querySelectorAll('.${G}word:not([data-off])')].map(el => el.dataset.key)`);
  await key(browser, "Home", 36);
  await until(browser, "Home reaches the least thinking", `${chosenKey("thinking")} === ${JSON.stringify(available[0])}`);
  await key(browser, "End", 35);
  await until(browser, "End reaches the most thinking", `${chosenKey("thinking")} === ${JSON.stringify(available.at(-1))}`);
  await key(browser, "ArrowLeft", 37);
  await until(browser, "← lowers the thinking one available step", `${chosenKey("thinking")} === ${JSON.stringify(available.at(-2))}`);
  assert.equal(await browser.evaluate(`document.activeElement === ${word("thinking", available.at(-2)!)} && [...${row("thinking")}.querySelectorAll('[tabindex="0"]')].length === 1`), true,
    "Focus follows the value: the row's one Tab stop is the word it holds");
  assert.equal(await browser.evaluate(`document.activeElement.matches(':focus-visible') &&
    getComputedStyle(${row("thinking")}.querySelector('.${G}dial-ptr')).opacity === '1'`), true, "Keyboard edits keep a visible focus indicator, the row's pointer");
  // A keyboard commit names its value in the readout, where a pointer reads a word before choosing it (once the last
  // press's scrub, which the readout keeps for a moment after the pointer lets go, has given way).
  await until(browser, "a keyboard commit names its value in the readout",
    `${readout}.querySelector('b')?.textContent === ${word("thinking", available.at(-2)!)}.querySelector('.${G}word-text').textContent`);
  await key(browser, "ArrowDown", 40);
  await until(browser, "↓ moves to the next row", `!!${row("advisor")}.contains(document.activeElement)`);
  await choose(browser, "thinking", thinking);
  assert.deepEqual(await readProfile(browser, draftKey), before, "Keyboard round trips return the exact profile");

  // A step only a refused word could take does nothing and says why, in the readout and aloud.
  await focusRow(browser, "tier");
  const tier = await browser.evaluate<string>(chosenKey("tier"));
  const refusedTier = await browser.evaluate<string | null>(`(() => {
    const words = [...${row("tier")}.querySelectorAll('.${G}word')];
    const last = words.findLastIndex(el => el.dataset.off === undefined);
    return last >= 0 && last < words.length - 1 ? words[last + 1].dataset.key : null;
  })()`);
  assert(refusedTier, "The bundled starter refuses the tier above its most capable available one");
  const refusedText = await browser.evaluate<string>(`${word("tier", refusedTier)}.querySelector('.${G}word-text').textContent`);
  await key(browser, "End", 35);
  await key(browser, "ArrowRight", 39);
  await until(browser, "a refused step names the refused word and its reason in the readout",
    `${readout}.dataset.tone === 'warn' && ${readout}.querySelector('b')?.textContent === ${JSON.stringify(refusedText)} && ${readout}.textContent.length > ${refusedText.length + 3}`);
  await until(browser, "a refused step says its reason aloud",
    `${liveRegion}.textContent.startsWith(${row("tier")}.querySelector('.${G}dial-label').textContent + ' ' + ${JSON.stringify(refusedText)} + ': ') && ${liveRegion}.textContent.length > ${refusedText.length + 10}`);
  assert.notEqual(await browser.evaluate(chosenKey("tier")), refusedTier, "A refused step leaves the row where it was");
  await choose(browser, "tier", tier);
  assert.deepEqual(await readProfile(browser, draftKey), before, "A refused step and End return the exact profile");

  // The lead row (#252): mixed, then GPT, Claude and DeepSeek, then an `only` box, a Tab stop of its own, checked while
  // the lane keeps every role on its lead. A press and Space toggle the box and leave focus on it, a lead change keeps it,
  // and Mixed disables it and says why. Every step is checked against the stored lane; neither a lead change nor the box
  // moves a word of the row, and pointing at or focusing the box moves nothing on the stage.
  assert.deepEqual(await browser.evaluate(`[...${row("lane")}.querySelectorAll('[role="radio"]')].map(el => el.dataset.key)`), ["mixed", "openai", "anthropic", "deepseek"],
    "The lead row names mixed, then GPT, Claude and DeepSeek");
  const leadGeometry = await browser.evaluate<string[]>(LEAD_GEOMETRY);
  // The lane the profile stores is the unsaved edit's, as the panel keeps it in the tab (the rows hold an edit throughout).
  const keptLane = async () => keptEdit({ kept: await browser.evaluate<string | null>(`sessionStorage.getItem(${JSON.stringify(draftKey)})`) }).selection.lane;
  const leads = async (description: string, lane: Selection["lane"], focus: string | null = null) => {
    const chosen = lane.kind === "mixed" ? "mixed" : lane.family, checked = lane.kind === "provider" && lane.blend === "only";
    await until(browser, description, `${chosenKey("lane")} === ${JSON.stringify(chosen)} && ${onlyBox}.getAttribute('aria-checked') === '${checked}'${focus === null ? "" : ` && document.activeElement === ${focus}`}`);
    assert.deepEqual(await keptLane(), lane, `${description}: the stored lane`);
    assert.deepEqual(await browser.evaluate(LEAD_GEOMETRY), leadGeometry, `${description}: no word of the lead row moves`);
  };
  const gptLed = { kind: "provider", family: "openai", blend: "led" } as const, gptOnly = { ...gptLed, blend: "only" } as const;
  await choose(browser, "lane", "mixed");
  await leads("Mixed leads", { kind: "mixed" });
  const mixedWhy = await browser.evaluate<string | null>(`${onlyBox}.getAttribute('aria-description')`);
  assert(mixedWhy, "Under Mixed the only box names why it is disabled");
  assert.equal(await browser.evaluate(`${onlyBox}.getAttribute('aria-disabled') === 'true' && ${onlyBox}.dataset.off === undefined`), true,
    "Under Mixed the only box is disabled, not struck");
  await click(browser, onlyBox);
  await until(browser, "a press on the disabled box says why in the readout and aloud, with focus on the box",
    `document.activeElement === ${onlyBox} && ${readout}.dataset.tone === 'warn' && ${readout}.textContent.includes(${JSON.stringify(mixedWhy)}) &&
    ${liveRegion}.textContent === ${JSON.stringify(`lead only: ${mixedWhy}`)}`);
  await key(browser, " ", 32);
  await settle(browser);
  await leads("Neither a press nor Space on the disabled box leaves Mixed", { kind: "mixed" }, onlyBox);
  await choose(browser, "lane", "openai");
  await leads("GPT from Mixed is GPT-led", gptLed);
  assert.equal(await browser.evaluate(`${onlyBox}.getAttribute('aria-disabled')`), null, "Under GPT the only box is enabled");
  await click(browser, onlyBox);
  await leads("A press on the box checks it: GPT only, with focus kept on the box", gptOnly, onlyBox);
  await key(browser, " ", 32);
  await leads("Space unchecks it: GPT-led, with focus kept on the box", gptLed, onlyBox);
  await until(browser, "the readout says what Space did", `${readout}.querySelector('b')?.textContent === 'only'`);
  await key(browser, " ", 32);
  await leads("Space checks it again", gptOnly, onlyBox);
  // A lead change keeps the box: checked, Claude and DeepSeek are their only lanes; unchecked, GPT is GPT-led again.
  await choose(browser, "lane", "anthropic");
  await leads("Claude keeps the box: Claude only", { kind: "provider", family: "anthropic", blend: "only" });
  await choose(browser, "lane", "deepseek");
  await leads("DeepSeek keeps it: DeepSeek only", { kind: "provider", family: "deepseek", blend: "only" });
  await click(browser, onlyBox);
  await leads("Unchecked under DeepSeek: DeepSeek-led", { kind: "provider", family: "deepseek", blend: "led" }, onlyBox);
  await choose(browser, "lane", "openai");
  await leads("GPT keeps it unchecked: GPT-led", gptLed);
  // Pointing at the box, unchecked and checked, and keyboard focus on it, the Tab stop after the lead's, shift nothing.
  for (const lane of [gptLed, gptOnly]) {
    if (lane === gptOnly) {
      await click(browser, onlyBox);
      await leads("A press checks the box again", gptOnly, onlyBox);
    }
    await pointAway(browser);
    await still(browser);
    await browser.evaluate(BOXES);
    await pointOf(browser, onlyBox);
    await settle(browser);
    assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], `Pointing at the ${lane.blend === "only" ? "checked" : "unchecked"} only box shifts nothing`);
  }
  await focusRow(browser, "lane");
  await still(browser);
  await browser.evaluate(BOXES);
  await key(browser, "Tab", 9);
  await until(browser, "Tab from the lead reaches the only box", `document.activeElement === ${onlyBox} && ${onlyBox}.matches(':focus-visible')`);
  await settle(browser);
  assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], "Keyboard focus on the only box shifts nothing");
  await key(browser, "Tab", 9);
  await until(browser, "the next Tab leaves the lead row for the model row", `!!${row("tier")}.contains(document.activeElement)`);
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await still(browser);
  await click(browser, onlyBox);
  await leads("Under reduced motion a press unchecks the box", gptLed, onlyBox);
  assert.equal(await browser.evaluate(running), 0, "Reduced motion: a press on the only box does not animate");
  await browser.send("Emulation.setEmulatedMedia", { features: [] });
  const start = keptEdit(before).selection.lane;
  await choose(browser, "lane", start.kind === "mixed" ? "mixed" : start.family);
  if (start.kind === "provider" && await browser.evaluate<string | null>(`${onlyBox}.getAttribute('aria-checked')`) !== String(start.blend === "only")) await click(browser, onlyBox);
  assert.deepEqual(await readProfile(browser, draftKey), before, "The lead row's round trips return the exact profile");

  // The wheel steps a row the keyboard has focused, or one the pointer has rested on; over a row the pointer only passes, it scrolls the panel.
  await panelWidth(browser, 860, 520);
  try {
    const chosenWord = `${row("thinking")}.querySelector('.${G}word[data-selected]')`;
    await click(browser, element(`${generator} [data-pane="routing"] .${G}title`));
    await wheel(browser, await pointOf(browser, chosenWord), 100);
    await settle(browser);
    assert.equal(await browser.evaluate(chosenKey("thinking")), thinking, "A wheel over a row the pointer has only passed scrolls, never steps it");
    const rested = await pointOf(browser, chosenWord);
    await Bun.sleep(600);
    await wheel(browser, rested, 100);
    await until(browser, "the wheel steps a row the pointer has rested on", `${chosenKey("thinking")} !== ${JSON.stringify(thinking)}`);
    await choose(browser, "thinking", thinking);
    await focusRow(browser, "thinking");
    await wheel(browser, await pointOf(browser, chosenWord), -100);
    await until(browser, "the wheel steps a keyboard-focused row at once", `${chosenKey("thinking")} !== ${JSON.stringify(thinking)}`);
    await choose(browser, "thinking", thinking);
  } finally {
    await browser.send("Emulation.clearDeviceMetricsOverride", {});
  }
  assert.deepEqual(await readProfile(browser, draftKey), before, "Wheel round trips return the exact profile");

  // Coarse pointers: a tap chooses the word under it, a touch that scrolls across the rows chooses nothing, and every target is 44px.
  await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    assert.equal(await browser.evaluate("matchMedia('(pointer: coarse)').matches"), true);
    const advisor = await browser.evaluate<string>(chosenKey("advisor"));
    const other = advisor === "review" ? "glance" : "review";
    await tap(browser, word("advisor", other));
    await until(browser, "a tap chooses the word under it", `${chosenKey("advisor")} === ${JSON.stringify(other)}`);
    await tap(browser, word("advisor", advisor));
    await until(browser, "a tap chooses the advisor back", `${chosenKey("advisor")} === ${JSON.stringify(advisor)}`);
    const start = await pointOf(browser, `${row("thinking")}.querySelector('.${G}word[data-selected]')`);
    await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    await browser.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x, y: start.y + 40 }] });
    await browser.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: start.x + 50, y: start.y + 90 }] });
    await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await settle(browser);
    assert.deepEqual(await readProfile(browser, draftKey), before, "A touch scroll across the rows never edits the profile");
    await coarseTargets(browser, label);
  } finally {
    await browser.send("Emulation.clearDeviceMetricsOverride", {});
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }

  // Reduced motion: a change rolls and glides by default, and under prefers-reduced-motion nothing the panel does animates.
  const other = available.find(entry => entry !== thinking)!;
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await click(browser, word("thinking", other));
  assert((await browser.evaluate<number>(running)) > 0, "A pointer commit rolls and glides when motion is allowed");
  await choose(browser, "thinking", thinking);
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await still(browser);
  const motionless = async (what: string) => {
    await settle(browser);
    assert.equal(await browser.evaluate(running), 0, `Reduced motion: ${what} does not animate`);
  };
  await click(browser, word("thinking", other));
  await motionless("a pointer commit");
  await focusRow(browser, "thinking");
  await key(browser, "Home", 36);
  await motionless("a keyboard commit");
  await choose(browser, "thinking", thinking);
  await key(browser, "r", 82);
  await motionless("a refresh");
  await key(browser, "a", 65);
  await until(browser, "a opens the accounts", shownView("accounts"));
  await motionless("a view coming in");
  await key(browser, "Escape", 27);
  await until(browser, "Esc comes back", shownView("main"));
  await motionless("the generator coming back");
  await focusRow(browser, "thinking");
  await key(browser, "w", 87);
  await until(browser, "w opens the machine list", `${machineList} !== null`);
  await motionless("the machine list");
  await key(browser, "Escape", 27);
  await openMenu(browser);
  await motionless("More's menu");
  await key(browser, "Escape", 27);
  await until(browser, "Esc closes More's menu", `${menu} === null`);
  await click(browser, launchButton);
  await motionless("a refused launch press");
  // The sheets: coming in, a refused press of the next action (no shake) and the way back animate nothing, and nothing in them lasts.
  await openSheet(browser, "models");
  await motionless("a sheet");
  await sheetStill(browser, "Models coming in");
  await click(browser, element(`${modelsSheet} [data-go]`));
  await until(browser, "the starter's refused verify says why", `${element(`${modelsSheet} [data-readout]`)}.dataset.tone === 'warn'`);
  assert.equal(await browser.evaluate(`${element(`${modelsSheet} [data-go]`)}.dataset.shake`), undefined, "Reduced motion: a refused press does not shake");
  await sheetStill(browser, "a refused press of the next action");
  await closeSheet(browser);
  await motionless("the stage coming back from a sheet");
  await openSheet(browser, "setup");
  await sheetStill(browser, "Setup coming in");
  await closeSheet(browser);
  assert.deepEqual(await readProfile(browser, draftKey), before, "Motion checks return the exact profile");

  await zeroShift(browser, label);
  await geometryAcrossWidths(browser, label);
  await browser.send("Emulation.setEmulatedMedia", { features: [] });
  assert.deepEqual(await readProfile(browser, draftKey), before, "Hover, focus, views and resizing are presentation only");
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
      // Models shows the policy derivation of the exact real OMP metadata response; untouched, the preview keeps no edit.
      const draftKey = storedDraftKey(writer.principal.id, workspace.id);
      const starter = catalogFromMetadata(metadata, "any"), initialSelection = defaultSelection(compileCatalog(starter));
      const initialDraft = await readProfile(browser, draftKey);
      assert.deepEqual(initialDraft.list, listOf(starter), "Models shows the starter the exact real OMP metadata response derives, each rung on its model");
      assert.equal(initialDraft.kept, null, "An untouched preview keeps no edit");
      assert.deepEqual(await browser.evaluate(`[${chosenKey("thinking")}, ${chosenKey("advisor")}]`), [initialSelection.thinking, initialSelection.advisor],
        "The rows show that list's default profile");
      // The first workspace has one recent profile, which the panel reads as it mounts.
      const recent = { ...initialSelection, thinking: "high", advisor: "off" } satisfies Selection;
      if (!initialized) {
        await rememberTeam(browser, writer.principal.id, workspace.id, recent);
        await openGenerator(browser, server, workspace.id);
        await usableStarter(browser);
        assert.deepEqual(await readProfile(browser, draftKey), initialDraft, "An untouched preview is the same after a reload");
      }
      await choose(browser, "thinking", "high");
      await choose(browser, "advisor", "audit");
      await until(browser, "the commit is announced", `${liveRegion}?.textContent.includes('audit')`);
      await assertRoutes(browser, true);
      const chosen = await readProfile(browser, draftKey);
      assert.notEqual(chosen.rows, initialDraft.rows, "The first explicit choice is a nondefault selection");
      assert.deepEqual(chosen.list, initialDraft.list, "Choosing thinking and an advisor keeps the same list");
      const edit = keptEdit(chosen);
      assert.deepEqual(edit.selection, { ...initialSelection, thinking: "high", advisor: "audit" }, "The kept edit is exactly the chosen selection");
      assert.deepEqual([edit.source, edit.revision, edit.initialized], ["starter", base.revision, initialized], "The edit rests on the bundled starter at the revision the panel read");
      assert(edit.metadataKey, "A first-use edit names the bundled list it was made on");
      assert.deepEqual(JSON.parse(edit.metadataKey), metadata, "Local routes are based on the exact real OMP metadata response");
      for (const sheet of ["models", "setup", "options"] as const) {
        await openSheet(browser, sheet);
        await closeSheet(browser);
      }
      for (const view of ["accounts", "sessions"] as const) {
        await showView(browser, view);
        await showView(browser, "main");
      }
      assert.deepEqual(await readProfile(browser, draftKey), chosen, "Sheets and views do not regenerate or rebase starter choices");
      // The unsaved choices are kept in this tab: a reload brings them back on the same bundled list.
      await openGenerator(browser, server, workspace.id);
      await usableStarter(browser);
      assert.deepEqual(await readProfile(browser, draftKey), chosen, "A reload keeps the unsaved starter choices");
      if (!initialized) await acceptanceScenario(browser, "bundled starter", recent, draftKey);
      assert.deepEqual(await readConfiguration(server, writer, target), base,
        "Mount, rows, keys, wheel, touch, views, resizing and sheets never initialize or mutate policy");
      assert.deepEqual(trace.requests.slice(start).filter(request => /^atyrode\.code\.(initializeConfiguration|stageCatalog|select|adoptStarterProfile|changeAccounts)$/.test(request.name)), []);
      // The preview is render-only: the exact OMP response's policy derivation, with no save.
      const document = catalogFromMetadata(metadata, edit.selection.budget);
      assert.deepEqual(chosen.list, listOf(document), "The displayed preview is the policy derivation of the real response");
      assert.equal(await browser.evaluate(`[...document.querySelectorAll('${modelsSheet} [data-cell][data-key]')].every(cell => cell.dataset.unmeasured !== undefined)`), true,
        "Models shows the starter unmeasured");
      await still(browser);
      assert.deepEqual(await routedRoles(browser), expectedRoutes(document, edit.selection),
        "Every routed role, its model and its supported effort exactly match the policy derivation of the chosen selection");
      for (const model of document.models) {
        const source = metadata.models.find(row => row.provider === model.provider && row.id === model.id);
        assert(source, "Every previewed catalog row comes from the actual pinned OMP response");
        // Code spends no separate quota, so a model that draws one (any class but chat) is never part of the starter.
        assert(source.quotaTier === null || source.quotaTier === "chat", "A separate-quota model never enters the bundled starter");
        assert(model.tier >= 1, "Every derived starter model sits on an ordinary rung, never an off-ladder tier 0");
        assert.equal(model.tokensPerSecond, null, "Bundled metadata does not invent measured speed");
        assert.equal(model.timeToFirstTokenMs, null, "Bundled metadata does not invent measured latency");
      }
      assert.deepEqual(await readConfiguration(server, writer, target), base, "Nothing but a verification persists the preview");
      await until(browser, "saved policy is not native launch readiness", launchIs("verify models", "refused"));
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
  const draftKey = storedDraftKey(writer.principal.id, workspace.id);
  const frozen = await readProfile(browser, draftKey);
  assert.equal(keptEdit(frozen).revision, 0, "The edit rests on the absent workspace, revision 0");
  await still(browser);
  const routes = await routedRoles(browser);
  const competing = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { ...target, expectedRevision: 0 });
  assert(competing.ok);
  // A competing initializer moves the revision under the frozen preview: unlike a verification's own
  // initialization, it is a change made elsewhere, and the launch line offers theirs.
  await until(browser, "a revision-zero preview refuses to attach to a competing initializer", `${launchIs("verify models", "refused")} && !!${fix("conflict")}`);
  // Models says the same refusal as its one next action, with the same fix beside it.
  await openSheet(browser, "models");
  await until(browser, "Models refuses verifying a conflicted preview and offers theirs",
    `${goIs(modelsSheet, "verify models", "refused")} && JSON.stringify(${goParts(modelsSheet)}) === ${JSON.stringify(JSON.stringify([["The workspace profile changed elsewhere", "attention"]]))} &&
    JSON.stringify(${goFixes(modelsSheet)}) === '["use theirs"]'`);
  await closeSheet(browser);
  await showView(browser, "accounts");
  await showView(browser, "main");
  assert.deepEqual(await readProfile(browser, draftKey), frozen, "The exact list, choices, bundled list and original revision remain on show");
  await still(browser);
  assert.deepEqual(await routedRoles(browser), routes, "A conflict does not replace the shown routes");
  assert.equal((await readConfiguration(server, writer, target)).revision, 1, "Navigation cannot auto-rebase or replay a rejected first adoption");
  assert.equal(await browser.evaluate(launchIs("verify models", "refused")), true, "A conflicted preview stays unsavable after observation recovery");
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
      // An unread workspace is the launch's refusal and its retry. A failed model list holds the launch line with its own
      // retry and Models, whatever else the launch is refused for, and the refusal's fix stays beside it.
      const retry = fix(metadataFails ? "list-retry" : "configuration");
      const noRoutes = `document.querySelector(${JSON.stringify(routeRows)}) === null`;
      await openGenerator(browser, server, workspace.id);
      await waitFor(() => held.size > 0, timeout, 50);
      await until(browser, "the generator says the profile is still being read, with no rows and no model list failure",
        `${element(`${generator} [data-pane="generator"] .${G}pane-note`)} !== null && ${row("lane")} === null && ${fix("list-retry")} === null`);
      assert.equal(await browser.evaluate(`${launchButton}.dataset.state !== 'ready'`), true,
        "Loading observations cannot authorize a save against an invented absent record");
      assert.equal(await browser.evaluate(noRoutes), true, "First-use routes are not fabricated while an authoritative prerequisite is pending");
      hold = false;
      for (const release of [...held]) release();
      await control(browser, "a failed prerequisite offers an explicit retry", retry, false);
      assert(failed > 0);
      if (metadataFails) {
        await until(browser, "with no profile to form, the launch line names the failed model list instead, with its retry and Models beside the launch's own fix",
          `${listFailure("instead")} && !!document.querySelector('${generator} .${G}launch-line [data-fix]:not([data-fix^="list-"])')`);
        // The machine is chosen from the roster alone, so it stays beside the launch while no profile forms, and opens by `w` and by a press.
        await until(browser, "with no profile the launch still names its machine", `${machinePicker}?.textContent === ${JSON.stringify(machineName)} && ${machinePicker}.getClientRects().length > 0`);
        await click(browser, generatorTitle);
        await key(browser, "w", 87);
        await until(browser, "w opens the machine list with no profile", `${machineList} !== null && document.activeElement === ${machineList}`);
        await key(browser, "Escape", 27);
        await until(browser, "Esc closes it onto the machine", `${machineList} === null && document.activeElement === ${machinePicker}`);
        await click(browser, machinePicker);
        await until(browser, "a press opens the machine list with no profile", `${machineList} !== null`);
        await key(browser, "Escape", 27);
        await until(browser, "Esc closes it again", `${machineList} === null`);
        await click(browser, fix("list-models"));
        await until(browser, "the Models fix opens Models, which has no list to show", `${sheetOpen("Models")} && !!document.querySelector('${modelsSheet} .${G}models-none')`);
        await closeSheet(browser);
      }
      assert.equal(await browser.evaluate(`${launchButton}.dataset.state !== 'ready'`), true, "An unavailable observation is not an empty configuration");
      assert.equal(await browser.evaluate(noRoutes), true);
      assert.deepEqual(await readConfiguration(server, writer, target), { configuration: null, legacyMachineId: null, revision: 0 });
      fail = false;
      await click(browser, retry);
      await usableStarter(browser);
      await choose(browser, "thinking", "max");
      const draftKey = storedDraftKey(writer.principal.id, workspace.id);
      const frozen = await readProfile(browser, draftKey);
      await still(browser);
      const routes = await routedRoles(browser);
      fail = true;
      const failures = failed;
      // Opening a sheet re-reads every observation; this one now fails.
      await openSheet(browser, "models");
      await closeSheet(browser);
      await waitFor(() => failed > failures, timeout, 50);
      await control(browser, "later observation failure remains separately retryable", retry, false);
      if (metadataFails) await until(browser, "beside the retained profile, the launch line names the failed model list with its retry and Models",
        `${listFailure("beside")} && !!document.querySelector('${generator} .${G}launch-line [data-fix]:not([data-fix^="list-"])')`);
      assert.deepEqual(await readProfile(browser, draftKey), frozen, "Observation failure retains the original list, bundled list and selected policy");
      assert.equal(await browser.evaluate(chosenKey("thinking")), "max", "The retained profile stays in the rows");
      await still(browser);
      assert.deepEqual(await routedRoles(browser), routes, "Retained routes remain inspectable when current observations fail");
      assert.equal(await browser.evaluate(`${launchButton}.dataset.state !== 'ready'`), true, "A failed refresh cannot authorize a retained starter");
      fail = false;
      await click(browser, retry);
      await until(browser, "real observation recovery removes its retry control", `${retry} == null`);
      assert.deepEqual(await readProfile(browser, draftKey), frozen, "Recovery never regenerates the local profile");
      await still(browser);
      assert.deepEqual(await routedRoles(browser), routes, "Recovery shows the retained routes");
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
 * would spend is refused, so nothing is probed, verified or saved. The account switch at the end is
 * the real changeAccounts CAS against the real server.
 */
async function verificationChargeScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, destination: Target): Promise<void> {
  const workspace = await createContainer(server, "Verification charge", "canvas");
  const target: Target = { containerId: workspace.id, machineId: destination.machineId };
  const packed = JSON.parse(readFileSync(join(ompBundleDirectory, "atyrode.omp.manifold-plugin.json"), "utf8")) as {
    manifest: { machine: { operations: Record<string, unknown> } };
  };
  for (const operationId of [INVENTORY_OPERATION_ID, BENCHMARK_OPERATION_ID]) assert(packed.manifest.machine.operations[operationId], "Synthetic readiness names real upstream operations");
  // The synthetic installation the probe jobs (`probeJob`) run from: a verification stops once the destination pins another.
  const pins = { installationRevision: "synthetic-ui-only", artifactSha256: "c".repeat(64), resourceBindingDigest: "c".repeat(64) };
  const model = (id: string, input: number, levels: ("low" | "medium" | "high" | "xhigh" | "max")[]) => ({ provider: "anthropic", id, api: "anthropic-messages",
    inputCostPerMillion: input, outputCostPerMillion: input * 5, contextWindow: 200_000, maxTokens: 64_000, reasoning: true, thinkingLevels: levels, images: true, quotaTier: null });
  const inventory: InventoryReceipt = { schemaVersion: 1, kind: "inventory", ompVersion: OMP_VERSION, observedAt: Date.now() - 5_000, models: [
    model("claude-haiku-5", 1, ["low", "medium", "high"]), model("claude-sonnet-5", 3, ["low", "medium", "high", "xhigh"]),
    model("claude-opus-5", 5, ["low", "medium", "high", "xhigh", "max"]) ] };
  const charge = inventoryDraft(inventory, "any").benchmark.candidates;
  const started: Record<string, unknown>[] = [], benchmarks: Record<string, unknown>[] = [], cancels: unknown[] = [];
  let listFails = true;
  // A check held in flight, to observe the panel while a step runs.
  const heldInventory = holdable();
  let holdNextInventory = false;
  const deployments = await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 });
  const terminals = await ownerAction(server, "core.terminals.listAll", {});
  await arrangeWorkbench(server, writer);
  const fixture = await intercept(browser, server, async (name, input) => {
    switch (name) {
      case "atyrode.omp.describeDestination": {
        if (input.containerId !== target.containerId || input.machineId !== target.machineId) return undefined;
        const result: OmpResult<"describeDestination"> = { ...target, pluginId: "atyrode.omp", state: "ready", reason: null, deployment: null, services: [],
          operations: [INVENTORY_OPERATION_ID, BENCHMARK_OPERATION_ID].map(operationId => ({ operationId, pins, nativeReady: true, callerRefusal: null, state: "ready", reason: null })) };
        return { ok: true, result };
      }
      case "atyrode.omp.readModelCatalog": return listFails ? refused("synthetic_model_list_failure") : undefined;
      case "atyrode.omp.accounts.accounts": return { ok: true, result: fixtureAccounts([1]) };
      case "atyrode.omp.accounts.usage": return { ok: true, result: fixtureUsage(fixtureAccounts([1])) };
      case "atyrode.omp.startInventory": {
        assert.equal(input.containerId, target.containerId);
        assert.equal(input.machineId, target.machineId);
        assert.deepEqual(Object.keys(input.accountPool as object), ["anthropic"], "The inventory runs with the pool Code composed from the saved choices");
        started.push(input);
        if (holdNextInventory) { holdNextInventory = false; await heldInventory.wait(); }
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
    // The model list fails at first. Verify needs no list, so it stays the step; with no profile to form there are no
    // rows and no routes, and the launch line names the failure with the list's own retry and Models.
    await openGenerator(browser, server, workspace.id);
    await until(browser, "beside a ready Verify the launch line names the failed model list instead of a profile, with its retry and Models",
      `${launchIs("verify models", "ready")} && ${listFailure("instead")}`);
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(routeRows)}) === null`), true, "With no profile to form there are no routes");
    listFails = false;
    await click(browser, fix("list-retry"));
    await until(browser, "the list's retry reads it again and routes the bundled profile", `document.querySelector(${JSON.stringify(routeRows)}) !== null && !${fix("list-retry")}`);

    // On arrival the panel root has focus, so its keys work at once: an arrow gives the rows focus and changes nothing.
    await openGenerator(browser, server, workspace.id);
    await until(browser, "with discovery ready the first step is to verify", launchIs("verify models", "ready"));
    await until(browser, "on arrival the panel root has focus", `document.activeElement === ${element(generator)}`);
    const arrived = await browser.evaluate<string>(profileValues);
    await key(browser, "ArrowDown", 40);
    await until(browser, "an arrow on arrival gives the first row focus", `!!${row("lane")}.contains(document.activeElement)`);
    assert.equal(await browser.evaluate(profileValues), arrived, "An arrow on arrival changes no setting");

    // A double-click on Verify starts one verification; its second click lands on a busy launch, never on Confirm.
    const point = await pointOf(browser, launchButton);
    await press(browser, point, 1);
    await press(browser, point, 2);
    await until(browser, "the pressed launch checks the accounts' models and keeps focus while it checks",
      `${launchIs("checking…", "busy")} && document.activeElement === ${launchButton} && ${launchButton}.getAttribute('aria-busy') === 'true'`);
    await until(browser, "the charge waits on its own confirmation", `${launchIs("verify models", "waiting")} && ${confirmCharge} !== null`);
    assert.equal(started.length, 1, "A double-click on Verify starts exactly one inventory");
    assert.equal(benchmarks.length, 0, "A double-click on Verify never confirms the charge");
    assert.equal(await browser.evaluate(`document.activeElement === ${launchButton}`), true, "Confirm charge is never focused for the person; the launch keeps focus");
    assert.equal(await browser.evaluate(`${launchButton}.getAttribute('aria-disabled')`), "true", "While a charge waits the launch refuses by aria-disabled");
    assert.equal(await browser.evaluate(`${confirmCharge}.getAttribute('aria-label')`), `Confirm charge: ${charge.length} ${charge.length === 1 ? "request" : "requests"}`,
      "Confirm is bound to the exact charge shown");
    await until(browser, "the charge is announced", `${liveRegion}?.textContent.includes(${JSON.stringify(String(charge.length))})`);
    assert.equal(await browser.evaluate(`${lineText}.includes(${JSON.stringify(`Claude ${charge.length}`)})`), true, "The charge names its provider by family");

    // While the charge waits, no profile, machine or account edit may start: every row and the machine refuse with the gate's reason.
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('${stage} [data-row]')].filter(row => row.getAttribute('aria-disabled') !== 'true').map(row => row.dataset.row)`), [],
      "Every row is locked while the charge waits");
    assert.equal(await browser.evaluate(`${machinePicker}.getAttribute('aria-disabled')`), "true", "The machine is locked while the charge waits");
    const settings = await browser.evaluate<string>(profileValues), machine = await browser.evaluate<string>(`${machinePicker}.textContent`);
    await focusRow(browser, "lane");
    const announced = await browser.evaluate<string>(`${liveRegion}.textContent`);
    await key(browser, "ArrowRight", 39);
    await until(browser, "a refused edit says why", `${liveRegion}.textContent !== ${JSON.stringify(announced)} && ${liveRegion}.textContent !== ''`);
    await key(browser, "ArrowDown", 40);
    await key(browser, "End", 35);
    await key(browser, "w", 87);
    await Bun.sleep(300);
    assert.deepEqual(await browser.evaluate(`({ settings: ${profileValues}, machine: ${machinePicker}.textContent, list: ${machineList} !== null })`), { settings, machine, list: false },
      "No profile or machine edit lands while a charge waits, and the machine list does not open");
    await focusLaunch(browser);
    await key(browser, "Tab", 9);
    assert.equal(await browser.evaluate(`document.activeElement === ${confirmCharge}`), true, "Confirm charge is the next Tab stop after the launch");

    // Only a deliberate single press spends: never the second click of a multi-click, never a held key.
    await press(browser, await pointOf(browser, confirmCharge), 2);
    await key(browser, "Enter", 13, { autoRepeat: true });
    await key(browser, " ", 32, { autoRepeat: true });
    await Bun.sleep(300);
    assert.equal(benchmarks.length, 0, "Neither a second click nor key repeat confirms the charge");
    assert.equal(await browser.evaluate(`${confirmCharge} !== null`), true, "The charge still waits");
    // The press that prepared the charge initialized the first-use workspace: that is the run's own
    // effect, so a cancelled or stopped run offers Verify again, never a conflict with "theirs".
    const verifyAgain = `${launchIs("verify models", "ready")} && ${confirmCharge} === null && !${fix("conflict")}`;
    await click(browser, cancelCharge);
    await until(browser, "a cancelled first-use charge offers Verify again without a conflict", verifyAgain);
    assert.equal(benchmarks.length, 0, "Cancelling a waiting charge spends nothing");
    assert.deepEqual(cancels, [], "A charge that never spent has no native job to cancel");
    const prepared = await readConfiguration(server, writer, target);
    assert.equal(prepared.configuration?.revision, 1, "The Verify press initialized the first-use workspace exactly once");
    assert.equal(prepared.configuration?.active, null, "Preparing a charge promotes nothing");
    assert.equal(prepared.configuration?.draft, null, "Preparing a charge stages nothing");

    // The panel's keys never take the launch's step from an open popover, nor from behind a sheet with the panel root focused.
    await focusRow(browser, "lane");
    await key(browser, "w", 87);
    await until(browser, "the machine list has focus", `document.activeElement === ${machineList}`);
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await until(browser, "the list takes ↵ as its own and closes", `${machineList} === null`);
    await Bun.sleep(300);
    assert.equal(started.length, 1, "Mod+↵ in the open machine list takes no step");
    await openSheet(browser, "options");
    await click(browser, element(`${generator} .${G}options-lede`));
    assert.equal(await browser.evaluate(`document.activeElement === ${element(generator)}`), true, "A press on a sheet's text leaves focus on the panel root");
    await key(browser, "Enter", 13);
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await Bun.sleep(300);
    assert.equal(started.length, 1, "Neither ↵ nor Mod+↵ behind a sheet takes the launch's step");
    assert.equal(await browser.evaluate(`${element(stage)}.hidden`), true, "The sheet stays open");
    await closeSheet(browser);

    // From here the SDK's feed probe counts the panel's own reads (`ownReads`), checked at the end of this scenario.
    await browser.evaluate("localStorage.setItem('manifold:debug', '1')");
    // On arrival a plain ↵ at the panel root takes the launch's step through the same gate as Mod+↵: it prepares the
    // charge, and pressed again while the charge waits it never confirms it.
    await openGenerator(browser, server, workspace.id);
    const openedAt = Date.now();
    await until(browser, "the reopened panel offers Verify", verifyAgain);
    await until(browser, "on arrival the panel root has focus", `document.activeElement === ${element(generator)}`);
    await key(browser, "Enter", 13);
    await until(browser, "↵ on arrival prepares a charge", `${launchIs("verify models", "waiting")} && ${confirmCharge} !== null`);
    assert.equal(started.length, 2, "↵ on arrival takes exactly one step");
    assert.equal(await browser.evaluate(`document.activeElement === ${element(generator)}`), true, "The step leaves focus on the panel root");
    await key(browser, "Enter", 13);
    await Bun.sleep(300);
    assert.equal(benchmarks.length, 0, "↵ at the panel root never confirms a waiting charge");
    assert.equal(await browser.evaluate(`${confirmCharge} !== null`), true, "The charge still waits");
    await click(browser, cancelCharge);
    await until(browser, "the cancelled charge offers Verify again", verifyAgain);

    // Mod+↵ takes the launch's step from a row and runs from the initialized revision (a run from the
    // stale one would refuse before its inventory); holding it takes no other step; one deliberate
    // press spends the charge once.
    await focusRow(browser, "lane");
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await until(browser, "Mod+↵ prepares a charge from revision 1", `${launchIs("verify models", "waiting")} && ${confirmCharge} !== null`);
    assert.equal(started.length, 3);
    await key(browser, "Enter", 13, { modifiers: CTRL, autoRepeat: true });
    await Bun.sleep(300);
    assert.equal(started.length, 3, "A held Mod+↵ never takes another step");
    assert.equal(benchmarks.length, 0);
    await click(browser, confirmCharge);
    await waitFor(() => benchmarks.length === 1, timeout, 50);
    await until(browser, "the refused spend stops the verification and the launch offers it again without a conflict", verifyAgain);
    assert.equal(benchmarks.length, 1, "One press spends once");
    assert.equal(await browser.evaluate(failureLine), true, "The stopped verification says so beside the launch");
    assert.deepEqual(await readConfiguration(server, writer, target), prepared, "Neither the later runs nor the refused benchmark initialize, stage, promote or save anything");
    assert.deepEqual(cancels, [], "A spend refused at its start leaves no native job to cancel");

    // The accounts view: `a` gives its first switch focus, Space saves that account's inclusion through the real
    // changeAccounts CAS, and the switch keeps focus through the re-read its save causes.
    await key(browser, "a", 65);
    await until(browser, "a opens the accounts with focus on the included account's switch",
      `${shownView("accounts")} && !!document.activeElement?.matches('${generator} [data-accounts-pane] [role="switch"][data-account-switch]') && document.activeElement.getAttribute('aria-checked') === 'true'`);
    const who = await browser.evaluate<string>(`document.activeElement.dataset.accountSwitch`);
    const accountSwitch = element(`${generator} [data-account-switch="${who}"]`);
    for (const included of [false, true]) {
      const revision = (await readConfiguration(server, writer, target)).revision;
      await until(browser, "the focused switch can move", `${accountSwitch}?.getAttribute('aria-disabled') !== 'true' && document.activeElement === ${accountSwitch}`);
      await key(browser, " ", 32);
      await until(browser, "Space flips the focused switch, which keeps focus", `${accountSwitch}?.getAttribute('aria-checked') === '${included}' && document.activeElement === ${accountSwitch}`);
      await waitFor(async () => (await readConfiguration(server, writer, target)).revision === revision + 1, timeout, 50);
      await until(browser, "the switch shows the saved choice and keeps focus through the re-read",
        `${accountSwitch}?.getAttribute('aria-checked') === '${included}' && ${accountSwitch}.getAttribute('aria-disabled') !== 'true' && document.activeElement === ${accountSwitch}`);
      assert.deepEqual((await readConfiguration(server, writer, target)).configuration?.accounts.manualDisabled, included ? [] : [fixtureAccounts([1]).accounts[0]!.reference],
        "The switch saves exactly that account's inclusion");
    }
    await key(browser, "Escape", 27);
    await until(browser, "Esc closes the accounts and gives the rows focus", `${shownView("main")} && !!document.activeElement?.closest('${generator} [data-row]')`);

    // The panel reads its inputs again on its own (auto-read.ts). Away at another tab and back a while after its last read
    // (it read when it opened, above), it reads them again, once.
    const unread = await readConfiguration(server, writer, target);
    await Bun.sleep(Math.max(0, openedAt + SHOWN_AGAIN_MS + 1_000 - Date.now()));
    const counted = await browser.evaluate<(number | null)[]>(ownReads);
    assert(counted.every(count => count !== null), "The SDK's feed probe counts the panel's reads of the machine list and OMP's defaults");
    const reads = counted.map(count => count! + 1);
    await lookAway(browser);
    await until(browser, "back from another tab the panel reads the machine list and OMP's defaults again", `JSON.stringify(${ownReads}) === ${JSON.stringify(JSON.stringify(reads))}`);
    let readAt = Date.now();
    await Bun.sleep(2 * HOLD_RECHECK_MS);
    assert.deepEqual(await browser.evaluate(ownReads), reads, "Back from another tab the panel reads its inputs once");
    let machineReads = reads[0]!;
    // Away and back again a while later in the middle of an edit, a pool named in the accounts' management and not saved,
    // it reads nothing: while the name has focus, nor once focus has left it for the generator, past the quiet period.
    // The pool's own Discard ends the edit, and the read it owes comes, once.
    await key(browser, "a", 65);
    await until(browser, "a opens the accounts", shownView("accounts"));
    await click(browser, element(`${generator} [data-manage]`));
    await until(browser, "Manage accounts opens the accounts' management", shownView("manage"));
    await control(browser, "a new pool can be named", workspaceButton("Save as preset…"), false);
    await click(browser, workspaceButton("Save as preset…"));
    const poolEditor = element(`${generator} [data-pane="manage"] form[aria-label="Saved account pool editor"]`);
    const poolName = `${poolEditor}?.querySelector('input[required]')`;
    await control(browser, "the new pool's name field opens", poolName, false);
    await click(browser, poolName);
    await browser.typeText("Unsaved pool");
    const typed = Date.now();
    await lookAwayAfter(browser, readAt);
    await readsHeld(browser, "Away and back while an unsaved pool's name has focus, the panel reads nothing", typed, machineReads);
    assert.equal(await browser.evaluate(`document.activeElement === ${poolName} && ${poolName}.value === 'Unsaved pool'`), true, "The edit keeps its focus and its words");
    await click(browser, element(`${generator} [data-view-tab="main"]`));
    await until(browser, "the Generator tab shows the generator, focus off the pool's name", `${shownView("main")} && !${poolEditor}?.contains(document.activeElement)`);
    await readsHeld(browser, "With the unsaved pool kept behind the generator, past the quiet period, the panel reads nothing", Date.now(), machineReads);
    await key(browser, "a", 65);
    await until(browser, "a opens the accounts", shownView("accounts"));
    await click(browser, element(`${generator} [data-manage]`));
    await until(browser, "the management shows the unsaved pool as it was left", `${shownView("manage")} && ${poolName}?.value === 'Unsaved pool'`);
    await click(browser, `[...${poolEditor}.querySelectorAll('button')].find(el => el.textContent.trim() === 'Discard draft / revert')`);
    await until(browser, "Discard ends the unsaved pool", `${poolEditor} === null`);
    // Discard returns focus to the management's Active account pool selector, a field in use that holds the read too;
    // with focus gone from it to the generator, nothing holds the read any more.
    await click(browser, element(`${generator} [data-view-tab="main"]`));
    await until(browser, "the Generator tab shows the generator, which offers Verify", `${shownView("main")} && ${verifyAgain}`);
    await readsOnce(browser, "once the unsaved pool is discarded the panel reads its inputs again", ++machineReads);
    readAt = Date.now();
    // A sheet's opening and its closing each read everything, once. With the sheet open the panel reads nothing on its own,
    // away and back or not.
    await openMenu(browser);
    await click(browser, menuItem("setup"));
    await until(browser, "More's Setup item opens Setup", sheetOpen("Setup"));
    await readsOnce(browser, "opening a sheet reads the panel's inputs", ++machineReads);
    await lookAwayAfter(browser, Date.now());
    await readsHeld(browser, "With a sheet open the panel reads nothing on its own", Date.now(), machineReads);
    await closeSheet(browser);
    await readsOnce(browser, "closing the sheet reads the panel's inputs", ++machineReads);
    readAt = Date.now();
    // While a step runs (a verification's check, held in flight) the panel reads nothing, away and back or not; once the
    // step and the charge it prepares have ended, it reads, once.
    holdNextInventory = true;
    await click(browser, launchButton);
    await waitFor(() => heldInventory.held, timeout, 50);
    await until(browser, "the verification's check runs", launchIs("checking…", "busy"));
    await lookAwayAfter(browser, readAt);
    await readsHeld(browser, "While a step runs the panel reads nothing", Date.now(), machineReads);
    heldInventory.release();
    await until(browser, "the checked charge waits", `${launchIs("verify models", "waiting")} && ${confirmCharge} !== null`);
    await click(browser, cancelCharge);
    await until(browser, "the cancelled charge offers Verify again", verifyAgain);
    await readsOnce(browser, "once the step has ended the panel reads its inputs again", ++machineReads);
    assert.deepEqual(await readConfiguration(server, writer, target), unread, "Reading on its own, a discarded pool and a cancelled check write nothing");
    await browser.evaluate("localStorage.removeItem('manifold:debug')");
    fixture.check();
  } finally {
    heldInventory.release();
    await fixture.stop();
  }
  assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), deployments,
    "The verification charge never requests native approval");
  assert.deepEqual(await ownerAction(server, "core.terminals.listAll", {}), terminals);
}

/**
 * A verified catalog holds for the OMP it ran under. Recorded as the workflow records it — the pinned OMP's artifact and
 * the real bundled catalog's revision — on a destination whose synthetic readiness pins that artifact, the verification is
 * current and the launch is the step. The same destination upgraded alone, with the same accounts and the same Code
 * bundles, makes Verify the step again, ready to run. Nothing is probed, spent, saved or installed.
 */
async function ompUpgradeScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, destination: Target): Promise<void> {
  const workspace = await createContainer(server, "OMP upgrade", "canvas");
  const target: Target = { containerId: workspace.id, machineId: destination.machineId };
  const created = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { containerId: workspace.id, expectedRevision: 0 });
  assert(created.ok);
  const bundled = await callAction(server, writer.token, "atyrode.omp.readModelCatalog", { providers: ["anthropic"] });
  assert(bundled.ok);
  const metadata = ModelCatalogSnapshotSchema.parse(bundled.result);
  const observation = fixtureAccounts([1]), revision = (created.result as Configuration).revision;
  const probe = await callAction(server, writer.token, "atyrode.code.composeProbe", { containerId: workspace.id, expectedRevision: revision, accounts: observation });
  assert(probe.ok);
  let runtime = pinnedOmpArtifact();
  const staged = await callAction(server, writer.token, "atyrode.code.stageCatalog", { containerId: workspace.id, expectedRevision: revision,
    document: catalogFromMetadata(metadata, "any"), verification: { ompVersion: OMP_VERSION, inventoryArtifactSha256: runtime, catalogRevision: metadata.revision,
      inventoryObservedAt: Date.now() - 3_000, benchmarkCompletedAt: Date.now() - 2_000, accounts: observation,
      poolIdentityDigest: (probe.result as ActionResult<"composeProbe">).poolIdentityDigest } });
  assert(staged.ok, "A verification records the pinned OMP's artifact and the real catalog revision");
  const reviewInput = { containerId: workspace.id, expectedRevision: (staged.result as Configuration).revision, source: "draft" };
  const reviewed = await callAction(server, writer.token, "atyrode.code.reviewCatalog", reviewInput);
  assert(reviewed.ok);
  const promoted = await callAction(server, writer.token, "atyrode.code.promoteCatalog", { ...reviewInput, reviewDigest: (reviewed.result as ActionResult<"reviewCatalog">).reviewDigest });
  assert(promoted.ok);
  const saved = await readConfiguration(server, writer, target);
  await arrangeWorkbench(server, writer);
  let described = 0;
  const fixture = await intercept(browser, server, (name, input) => {
    if (name === "atyrode.omp.accounts.accounts") return { ok: true, result: fixtureAccounts([1]) };
    if (name !== "atyrode.omp.describeDestination" || input.containerId !== target.containerId || input.machineId !== target.machineId) return undefined;
    described++;
    const pins = { installationRevision: "synthetic-ui-only", artifactSha256: runtime, resourceBindingDigest: "c".repeat(64) };
    const result: OmpResult<"describeDestination"> = { ...target, pluginId: "atyrode.omp", state: "ready", reason: null, deployment: null, services: [],
      operations: [INVENTORY_OPERATION_ID, BENCHMARK_OPERATION_ID].map(operationId => ({ operationId, pins, nativeReady: true, callerRefusal: null, state: "ready", reason: null })) };
    return { ok: true, result };
  });
  try {
    await openGenerator(browser, server, workspace.id);
    await waitFor(() => described > 0, timeout, 50);
    await Bun.sleep(500);
    // Discovery is ready, so a stale verification would make Verify the step; the launch this machine has no permission for is.
    await until(browser, "on the OMP it ran under, the verification is current and the next step is the launch", launchIs("launch", "refused"));
    // OMP upgraded on the machine, and nothing else: its runtime is another artifact, whatever version it reports.
    runtime = "9".repeat(64);
    await openGenerator(browser, server, workspace.id);
    await until(browser, "an OMP upgrade alone makes Verify the step again, ready to run", launchIs("verify models", "ready"));
    assert.deepEqual(await readConfiguration(server, writer, target), saved, "Observing an upgraded OMP saves nothing");
    fixture.check();
  } finally {
    await fixture.stop();
  }
}

// ---------------------------------------------------------------- the Models sheet

/**
 * Models end to end on a first-use workspace. Synthetic OMP observations stand in for the destination, the accounts and
 * the probe jobs: discovery and benchmark are ready, a fictional Claude and Codex account are observed, each inventory
 * lists the pinned OMP's bundled Claude and Codex rows with OMP's quota class on each, and Spark in its `spark` class,
 * and each provider's benchmark job answers every candidate reachable at fictional speeds, except the Codex models the
 * plan does not serve (`unserved`), which it answers `client_blocked`. Everything Code decides is the real
 * server's: the initialization, the probe pool, the charge (`draftInventory`), the derivation, staging with the recorded
 * verification, reviews, promotions, imports and discards. No provider is reached, no native job runs and nothing is
 * approved.
 */
async function modelsSheetScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, destination: Target): Promise<void> {
  const workspace = await createContainer(server, "Models sheet", "canvas");
  const target: Target = { containerId: workspace.id, machineId: destination.machineId };
  const providers = ["anthropic", "openai-codex"];
  const bundled = async (names: readonly string[]) => {
    const outcome = await callAction(server, writer.token, "atyrode.omp.readModelCatalog", { providers: names });
    assert(outcome.ok, "The pinned OMP bundle supplies its passive model metadata");
    return ModelCatalogSnapshotSchema.parse(outcome.result);
  };
  const metadata = await bundled(providers);
  const starter = catalogFromMetadata(await bundled(starterProviders), "any");
  // Where the pinned OMP's bundle lists no Codex model in Spark's quota class (OMP 18.7.0 dropped Spark), its inventory
  // never reports one. The inventory here lists Spark anyway, as an earlier OMP's did: under the id the pinned SDK still
  // classifies `spark`, with the facts of a bundled Codex row, so the left-out list shows how that class reads.
  const bundledSpark = metadata.models.find(model => model.quotaTier === "spark");
  const codexRow = metadata.models.find(model => model.provider === "openai-codex" && model.reasoning && model.contextWindow !== null);
  assert(codexRow, "The pinned OMP bundles a Codex model that reasons");
  const spark = bundledSpark ?? { ...codexRow, id: "gpt-5.3-codex-spark", quotaTier: "spark" };
  const listed = bundledSpark ? metadata.models : [...metadata.models, spark];
  const sparkId = `${spark.provider}/${spark.id}`;
  const codex = { reference: { kind: "credential" as const, scope: fixtureScope, provider: "openai-codex", credentialId: 3 }, credentialId: 3,
    type: "api_key" as const, identityKey: null, email: null, disabled: false, blocks: [] };
  const observation = (): OmpResult<"accounts"> => {
    const claude = fixtureAccounts([1]);
    return { ...claude, accounts: [...claude.accounts, codex] };
  };
  // The synthetic installation the probe jobs (`probeJob`) run from: a verification stops once the destination pins another.
  const pins = { installationRevision: "synthetic-ui-only", artifactSha256: "c".repeat(64), resourceBindingDigest: "c".repeat(64) };
  /** Each inventory the destination answered, by its job: the bundled Claude and Codex rows and Spark, observed as the job started. */
  const inventories = new Map<string, InventoryReceipt>();
  const speed = (id: string) => [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  type Benchmark = { request: OmpInput<"startBenchmark">; startedAt: number; settled: boolean; receipt: BenchmarkReceipt | null };
  const benchmarks = new Map<string, Benchmark>();
  const started: OmpInput<"startInventory">[] = [], cancels: unknown[] = [];
  const heldInventory = holdable(), heldReview = holdable();
  let holdNextInventory = false, holdNextBenchmark = false, holdNextReview = false;
  /** The Codex ids the next benchmarks find the plan does not serve. */
  let unserved: ReadonlySet<string> = new Set();
  const reviews: ActionResult<"reviewCatalog">[] = [];
  const deployments = await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 });
  const terminals = await ownerAction(server, "core.terminals.listAll", {});
  await arrangeWorkbench(server, writer);
  const trace = await watchActions(browser, server);
  const fixture = await intercept(browser, server, async (name, input) => {
    switch (name) {
      case "atyrode.omp.describeDestination": {
        if (input.containerId !== target.containerId || input.machineId !== target.machineId) return undefined;
        const result: OmpResult<"describeDestination"> = { ...target, pluginId: "atyrode.omp", state: "ready", reason: null, deployment: null,
          services: [{ serviceId: "omp", state: "ready", reason: null }],
          operations: [INVENTORY_OPERATION_ID, BENCHMARK_OPERATION_ID].map(operationId => ({ operationId, pins, nativeReady: true, callerRefusal: null, state: "ready", reason: null })) };
        return { ok: true, result };
      }
      case "atyrode.omp.accounts.accounts": return { ok: true, result: observation() };
      case "atyrode.omp.accounts.usage": return { ok: true, result: fixtureUsage(observation()) };
      case "atyrode.omp.startInventory": {
        const request = ompActionSchemas.startInventory.input.parse(input);
        assert.deepEqual([request.containerId, request.machineId], [target.containerId, target.machineId]);
        assert.deepEqual(Object.keys(request.accountPool).sort(), providers, "The inventory runs with the pool Code composed from both observed accounts");
        started.push(request);
        const jobId = `synthetic-inventory-${started.length}`;
        inventories.set(jobId, { schemaVersion: 1, kind: "inventory", ompVersion: OMP_VERSION, observedAt: Date.now() - 1_000, models: listed });
        if (holdNextInventory) { holdNextInventory = false; await heldInventory.wait(); }
        return { ok: true, result: probeJob(target, jobId, INVENTORY_OPERATION_ID, writer.principal.id) };
      }
      case "atyrode.omp.readInventory": {
        const inventory = inventories.get(String(input.jobId));
        assert(inventory, "Only an inventory this fixture started is read");
        return { ok: true, result: { job: probeJob(target, String(input.jobId), INVENTORY_OPERATION_ID, writer.principal.id), inventory } };
      }
      case "atyrode.omp.startBenchmark": {
        const request = ompActionSchemas.startBenchmark.input.parse(input);
        const inventory = inventories.get(request.inventoryJobId);
        assert(inventory, "A benchmark follows an inventory this fixture answered");
        const charge = inventoryDraft(inventory, "any").benchmark, provider = request.candidates.candidates[0]?.provider;
        assert.deepEqual(request.candidates, { ...charge, candidates: charge.candidates.filter(candidate => candidate.provider === provider) },
          "Each benchmark spends exactly its provider's part of the charge shown");
        const jobId = `synthetic-benchmark-${benchmarks.size + 1}`;
        benchmarks.set(jobId, { request, startedAt: Date.now(), settled: !holdNextBenchmark, receipt: null });
        holdNextBenchmark = false;
        return { ok: true, result: probeJob(target, jobId, BENCHMARK_OPERATION_ID, writer.principal.id, "started") };
      }
      case "engine.jobs.status": {
        const { node } = input as { node: { jobId: string; operationId: string } };
        if (node.operationId === INVENTORY_OPERATION_ID && inventories.has(node.jobId)) return { ok: true, result: probeJob(target, node.jobId, INVENTORY_OPERATION_ID, writer.principal.id) };
        const run = benchmarks.get(node.jobId);
        assert(run && node.operationId === BENCHMARK_OPERATION_ID, "Only this fixture's probe jobs are followed");
        return { ok: true, result: probeJob(target, node.jobId, BENCHMARK_OPERATION_ID, writer.principal.id, run.settled ? "exited" : "started") };
      }
      case "atyrode.omp.readBenchmark": {
        const run = benchmarks.get(String(input.jobId));
        assert(run?.settled, "A benchmark is read once its job has settled");
        run.receipt ??= { schemaVersion: 1, kind: "benchmark", ompVersion: OMP_VERSION, inventoryObservedAt: run.request.candidates.inventoryObservedAt,
          startedAt: run.startedAt, completedAt: Date.now(), results: run.request.candidates.candidates.map(candidate => unserved.has(candidate.id)
            ? { ...candidate, status: "client_blocked" as const, tokensPerSecond: null, timeToFirstTokenMs: null }
            : { ...candidate, status: "reachable" as const, tokensPerSecond: 25 + speed(candidate.id) % 90, timeToFirstTokenMs: 400 + speed(candidate.id) % 1_400 }) };
        return { ok: true, result: { job: probeJob(target, String(input.jobId), BENCHMARK_OPERATION_ID, writer.principal.id), benchmark: run.receipt } };
      }
      case "engine.jobs.cancel": cancels.push(input); return refused("synthetic_cancel_unexpected");
      case "atyrode.code.reviewCatalog": {
        // The real server reviews; its answer is kept to check the promotion that follows names exactly that review.
        if (holdNextReview) { holdNextReview = false; await heldReview.wait(); }
        const outcome = await callAction(server, writer.token, name, input);
        if (!outcome.ok) return { ok: false, denial: outcome.denial };
        reviews.push(outcome.result as ActionResult<"reviewCatalog">);
        return { ok: true, result: outcome.result };
      }
      default: return undefined;
    }
  });
  const goButton = element(`${modelsSheet} [data-go]`);
  const readoutLine = element(`${modelsSheet} [data-readout]`);
  const phaseIs = (phase: string) => `${element(modelsSheet)}?.dataset.phase === ${JSON.stringify(phase)}`;
  const sideIs = (side: string | null) => side === null ? `${element(`${modelsSheet} [data-side]`)} === null` : `${element(`${modelsSheet} [data-side="${side}"]`)} !== null`;
  const writes = (from: number) => trace.requests.slice(from).filter(request => /^atyrode\.code\.(initializeConfiguration|stageCatalog|reviewCatalog|promoteCatalog|discardCatalog|select)$/.test(request.name));
  /** What a verification run leads to, by the derivation Code's server makes of it: the union of its providers' receipts. */
  const derivedFrom = (inventoryJobId: string) => {
    const inventory = inventories.get(inventoryJobId)!;
    const receipts = [...benchmarks.values()].filter(run => run.request.inventoryJobId === inventoryJobId && run.receipt).map(run => run.receipt!);
    const benchmark: BenchmarkReceipt = { schemaVersion: 1, kind: "benchmark", ompVersion: OMP_VERSION, inventoryObservedAt: inventory.observedAt,
      startedAt: Math.min(...receipts.map(receipt => receipt.startedAt)), completedAt: Math.max(...receipts.map(receipt => receipt.completedAt)),
      results: receipts.flatMap(receipt => receipt.results) };
    return { benchmark, ...catalogFromObservations(inventory, benchmark, { budget: "any" }) };
  };
  const dialog = element(`${modelsSheet} dialog`);
  const field = element(`${modelsSheet} dialog textarea[aria-label="model list JSON"]`);
  const stageButton = element(`${modelsSheet} dialog [data-stage]`);
  /** What the import says it does with the pasted list. */
  const importEffect = `${dialog}?.querySelector('h2 + p')?.textContent`;
  /** Pastes a list into the open import (CDP's text insertion into its focused field) and stages it by a press; using it is then `use`. */
  const stageList = async (list: CatalogDocument, use: "ready" | "refused" = "ready") => {
    await until(browser, "the import opens as a modal dialog with focus in its field", `!!${dialog}?.open && ${dialog}.matches(':modal') && document.activeElement === ${field}`);
    await browser.send("Input.insertText", { text: JSON.stringify(list) });
    await until(browser, "the pasted list can be staged", `!${stageButton}.hasAttribute('aria-disabled')`);
    await click(browser, stageButton);
    await until(browser, "the staged list waits beside the one in use", `!${dialog}.open && ${phaseIs("staged")} && ${goIs(modelsSheet, "use staged list", use)} && ${sideIs("staged changes")}`);
  };
  try {
    await openGenerator(browser, server, workspace.id);
    await chooseMachine(browser, target.machineId, machineName);
    await until(browser, "with discovery ready the first step is to verify", launchIs("verify models", "ready"));

    // More opens Models with focus on its way back. The head counts the bundled starter's models and says it is unverified;
    // the list is the starter's ladders, unmeasured, and the one next action is to verify.
    await openFromMore(browser, "models");
    await until(browser, "Models shows the starter, unverified, with verify models its one next action", `${phaseIs("unverified")} && ${goIs(modelsSheet, "verify models")} && ${sideIs(null)}`);
    assert.deepEqual(await browser.evaluate(`({ state: ${sheetState(modelsSheet)}, parts: ${goParts(modelsSheet)}, fixes: ${goFixes(modelsSheet)}, list: ${modelList} })`),
      { state: `${listOf(starter).length} models · starter · unverified`, parts: [["unverified", "warn"]], fixes: [], list: listOf(starter) },
      "The head counts the starter's models, each rung is its model and verifying is the one next action");
    assert.equal(await browser.evaluate(`[...document.querySelectorAll('${modelsSheet} [data-cell][data-key]')].every(cell => cell.dataset.unmeasured !== undefined)`), true,
      "Nothing is measured before a verification");
    // Ids, prices and speeds are never drawn in the list; pointing at a rung says its model's exact id and prices in the readout.
    const grid = element(`${modelsSheet} [role="grid"][aria-label="model list"]`);
    assert.equal(await browser.evaluate(`/\\/|\\$|tok\\/s/.test(${grid}.textContent)`), false, "The list draws aliases only: no provider ids, prices or speeds");
    assert.equal(await browser.evaluate(sheetSays(modelsSheet)), "", "The readout is empty while nothing is pointed or focused");
    const pointedModel = starter.models.find(model => model.tier === 1 && model.provider === "anthropic")!;
    await pointOf(browser, element(`${modelsSheet} [data-key="${pointedModel.key}"]`));
    await until(browser, "pointing at a rung says its model's exact id and prices in the readout",
      `${sheetSays(modelsSheet)}.includes(${JSON.stringify(` · ${pointedModel.provider}/${pointedModel.id} · `)}) && ${sheetSays(modelsSheet)}.includes(' out per M')`);
    const empty = await browser.evaluate<string | null>(`document.querySelector('${modelsSheet} [data-cell][data-empty]')?.dataset.cell ?? null`);
    assert(empty, "The starter leaves a rung of some ladder empty");
    assert.equal(await browser.evaluate(`${element(`${modelsSheet} [data-cell="${empty}"]`)}.textContent`), "—", "An empty rung is a dash");
    await pointOf(browser, element(`${modelsSheet} [data-cell="${empty}"]`));
    await until(browser, "an empty rung gives its reason when pointed at", `${readoutLine}.dataset.tone === 'warn' && / · No \\w+ \\w+ model in the list/.test(${sheetSays(modelsSheet)})`);
    await pointAway(browser);
    await until(browser, "the readout empties once nothing is pointed", `${sheetSays(modelsSheet)} === ''`);

    // The list is one Tab stop, its focused rung. Arrows walk the ladders: ↓ up a ladder, → across them in the matrix and on
    // to the next rung in the ladders; the rung with focus is the one Tab stop and says itself in the readout.
    assert.equal(await browser.evaluate(`document.querySelectorAll('${modelsSheet} [data-cell][tabindex="0"]').length`), 1, "The list is one Tab stop");
    await tabTo(browser, "the list's one Tab stop", element(`${modelsSheet} [data-cell][tabindex="0"]`));
    const grid0 = await browser.evaluate<{ mode: string; families: string[] }>(`({ mode: ${element(modelsSheet)}.dataset.mode,
      families: [...new Set([...document.querySelectorAll('${modelsSheet} [data-cell]')].map(cell => cell.dataset.family))] })`);
    const [f0, f1] = grid0.families;
    assert(f0 && f1, "The starter's list has more than one ladder");
    const wide = grid0.mode === "wide";
    for (const [name, code, cell] of [["ArrowDown", 40, `${f0}:2`], ["ArrowRight", 39, wide ? `${f1}:2` : `${f0}:3`], ["ArrowUp", 38, wide ? `${f1}:1` : `${f0}:2`],
      ["ArrowLeft", 37, `${f0}:1`], ["ArrowDown", 40, `${f0}:2`]] as const) {
      await key(browser, name, code);
      await until(browser, `${name} moves focus to rung ${cell}, the list's one Tab stop, which says itself`, `(() => {
        const focused = document.activeElement, said = ${readoutLine}.querySelector('b')?.textContent;
        if (focused?.dataset.cell !== '${cell}' || focused.tabIndex !== 0 || document.querySelectorAll('${modelsSheet} [data-cell][tabindex="0"]').length !== 1) return false;
        const alias = focused.querySelector('.${G}models-alias').textContent;
        return alias === '—' ? !!said : said === alias;
      })()`);
    }
    await key(browser, "Tab", 9, { modifiers: SHIFT });
    await until(browser, "Shift+Tab leaves the list", `!document.activeElement?.closest('[role="grid"]')`);
    await key(browser, "Tab", 9);
    await until(browser, "Tab comes back to the rung the list was left on", `document.activeElement?.dataset.cell === '${f0}:2'`);
    await sheetZeroShift(browser, modelsSheet, "Models starter");
    await sheetGeometry(browser, modelsSheet, "Models starter");

    // A double-click on verify models starts one check: its second click lands on the busy check, which draws the hold the
    // charge keeps before it can be confirmed, never on a confirm. Import and export refuse while it runs.
    holdNextInventory = true;
    const point = await pointOf(browser, goButton);
    await press(browser, point, 1);
    await press(browser, point, 2);
    await until(browser, "the press checks the accounts' models, the checking hold drawn, focus kept",
      `${phaseIs("inventory")} && ${goIs(modelsSheet, "checking models…", "busy")} && ${goButton}.dataset.hold !== undefined && document.activeElement === ${goButton}`);
    await waitFor(() => heldInventory.held, timeout, 50);
    assert.equal(started.length, 1, "A double-click on verify models starts exactly one inventory");
    assert.deepEqual(await browser.evaluate(`({ state: ${sheetState(modelsSheet)}.endsWith(' · verifying'), cues: [...document.querySelectorAll('${modelsSheet} [data-cue]')].map(cue => cue.getAttribute('aria-disabled')), fixes: ${goFixes(modelsSheet)} })`),
      { state: true, cues: ["true", "true"], fixes: ["cancel"] }, "While it checks the head says a verification runs, import and export refuse, and cancel is beside it");
    heldInventory.release();
    const firstInventory = "synthetic-inventory-1";
    const charge = inventoryDraft(inventories.get(firstInventory)!, "any");
    const requests = (provider: string) => charge.benchmark.candidates.filter(candidate => candidate.provider === provider).length;
    const count = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
    await until(browser, "after the hold the charge waits on its own confirmation", `${phaseIs("charge")} && ${goIs(modelsSheet, "confirm charge")} && ${sideIs("charge")}`);
    assert.deepEqual(await browser.evaluate(`({ parts: ${goParts(modelsSheet)}, fixes: ${goFixes(modelsSheet)},
      providers: [...document.querySelectorAll('${modelsSheet} [data-side="charge"] .${G}models-pw')].map(el => el.getAttribute('aria-label')).sort(),
      unprobed: [...document.querySelectorAll('${modelsSheet} [data-side="charge"] .${G}models-xid')].map(el => el.textContent) })`), {
      parts: [[count(charge.benchmark.candidates.length, "tiny request"), "strong"], ["nothing spent yet", null]], fixes: ["cancel"],
      providers: [`Claude: ${count(requests("anthropic"), "request")}`, `Codex: ${count(requests("openai-codex"), "request")}`],
      unprobed: charge.exclusions.map(exclusion => `${exclusion.provider}/${exclusion.id}`),
    }, "The charge says exactly what it spends per provider, that nothing is spent yet, and which models are not probed");
    await sheetGeometry(browser, modelsSheet, "Models charge");
    // Only a deliberate single press spends: never the second click of a double-click, never a held key.
    await press(browser, await pointOf(browser, goButton), 2);
    await until(browser, "a double press confirms nothing and says so", `${readoutLine}.dataset.tone === 'warn' && ${sheetSays(modelsSheet)} === 'confirm charge · A double press confirms nothing; press once.'`);
    assert.equal(await browser.evaluate(`document.activeElement === ${goButton}`), true, "The next action keeps focus");
    await key(browser, "Enter", 13, { autoRepeat: true });
    await key(browser, " ", 32, { autoRepeat: true });
    await Bun.sleep(300);
    assert.equal(benchmarks.size, 0, "Neither a second click nor a held key confirms the charge");
    assert.equal(await browser.evaluate(phaseIs("charge")), true, "The charge still waits");

    // One press spends: verifying, the requests measured per provider, the rungs of the providers still owed probing.
    holdNextBenchmark = true;
    await click(browser, goButton);
    await until(browser, "one press confirms: verifying, measuring per provider", `${phaseIs("benchmark")} && ${goIs(modelsSheet, "verifying…", "busy")} && ${sideIs("measuring")}`);
    await waitFor(() => benchmarks.size === 1, timeout, 50);
    assert.deepEqual(await browser.evaluate(`({ parts: ${goParts(modelsSheet)},
      providers: [...document.querySelectorAll('${modelsSheet} [data-side="measuring"] .${G}models-pw')].map(el => el.getAttribute('aria-label')).sort(),
      probing: [...document.querySelectorAll('${modelsSheet} [data-cell][data-key]')].filter(cell => (cell.dataset.probing !== undefined) !== ['anthropic', 'openai'].includes(cell.dataset.family)).map(cell => cell.dataset.cell) })`), {
      parts: [["measuring models", null], [`0 of ${charge.benchmark.candidates.length}`, "strong"]],
      providers: [`Claude: 0 of ${requests("anthropic")} measured`, `Codex: 0 of ${requests("openai-codex")} measured`], probing: [],
    }, "Verifying says what it has measured, and the rungs of every provider still owed are probing, no other");
    for (const run of benchmarks.values()) run.settled = true;

    // Verified: the measured list is put in use, the head says when, and beside it is what the verification left out, each with
    // its reason in a word; Spark, in OMP's spark quota class, reads retired. Back to code is the next action, and verify again is
    // beside it once the verification's own save has been read, since verifying needs a current read of the workspace.
    const settled = `${phaseIs("verified")} && ${goIs(modelsSheet, "back to code")} && ${sideIs("left out")} && JSON.stringify(${goFixes(modelsSheet)}) === '["verify again"]'`;
    await until(browser, "the measured list is put in use and verified", settled);
    const verified = derivedFrom(firstInventory);
    const afterFirst = await readConfiguration(server, writer, target);
    assert.deepEqual(afterFirst.configuration?.active?.document, verified.document, "The list in use is exactly the derivation of what was measured");
    assert.equal(afterFirst.configuration?.active?.provenance?.benchmarkCompletedAt, verified.benchmark.completedAt, "The verification records when it was measured");
    assert.equal(afterFirst.configuration?.draft, null);
    assert.deepEqual(await browser.evaluate(`({ state: ${sheetState(modelsSheet)}, fixes: ${goFixes(modelsSheet)}, list: ${modelList},
      unmeasured: [...document.querySelectorAll('${modelsSheet} [data-cell][data-unmeasured]')].length })`),
      { state: `${listOf(verified.document).length} models · verified just now`, fixes: ["verify again"], list: listOf(verified.document), unmeasured: 0 },
      "Each rung is its measured model, and the head says it was verified just now");
    const outs = await browser.evaluate<{ id: string; why: string; label: string }[]>(`[...document.querySelectorAll('${modelsSheet} [data-side="left out"] li')].map(li => ({
      id: li.querySelector('.${G}models-xid').textContent, why: li.querySelector('.${G}models-why').textContent, label: li.querySelector('.${G}models-xid').getAttribute('aria-label') }))`);
    assert.deepEqual(outs.map(entry => entry.id), verified.exclusions.map(exclusion => `${exclusion.provider}/${exclusion.id}`), "Left out are exactly the models the derivation left out");
    assert.deepEqual(outs.find(entry => entry.id === sparkId), { id: sparkId, why: "retired", label: `${sparkId}: Retired: Code no longer routes to Spark` },
      "Spark, in OMP's spark quota class, reads retired");
    assert.deepEqual(outs.filter(entry => entry.id !== sparkId && entry.why === "retired"), [], "Only Spark's class reads retired");
    await pointOf(browser, `[...document.querySelectorAll('${modelsSheet} [data-side="left out"] .${G}models-xid')].find(el => el.textContent === ${JSON.stringify(sparkId)})`);
    await until(browser, "pointing at Spark says why in the readout", `${sheetSays(modelsSheet)} === ${JSON.stringify(`${spark.id} · Retired: Code no longer routes to Spark`)}`);
    await pointAway(browser);
    await sheetZeroShift(browser, modelsSheet, "Models verified list");
    await sheetGeometry(browser, modelsSheet, "Models verified list");
    await sheetCoarseTargets(browser, modelsSheet, "Models verified list");
    // Back to code goes back to the stage, focus to More, which opened Models.
    await click(browser, goButton);
    await until(browser, "back to code returns to the stage and gives focus back to More", `${element(stage)}.hidden === false && document.activeElement === ${more}`);

    // Import, with i, stages a pasted list beside the one in use: one rung measured faster. Nothing is in use until it is used;
    // an import over it says it replaces it, in the dialog and once staged; discard drops it, and the verified list stays in use.
    await openSheet(browser, "models");
    const active = afterFirst.configuration!.active!.document;
    const faster: CatalogDocument = { ...active, models: active.models.map((model, index) => index === 0 ? { ...model, tokensPerSecond: 101 } : model) };
    let from = trace.requests.length;
    await key(browser, "i", 73);
    await until(browser, "with nothing staged, the import says it stages the list beside the one in use",
      `!!${dialog}?.open && ${importEffect} === 'Paste a Code model list, or drop its file here. It is staged beside the list in use; nothing changes until you use it.'`);
    await stageList(faster);
    const staged = await readConfiguration(server, writer, target);
    assert.deepEqual(writes(from), [{ name: "atyrode.code.stageCatalog", input: { containerId: target.containerId, expectedRevision: afterFirst.revision, document: faster } }],
      "Import stages exactly the pasted list at the revision shown, initializing nothing");
    assert.deepEqual([staged.configuration?.active, staged.configuration?.draft?.document], [afterFirst.configuration?.active, faster], "Staging puts nothing in use");
    assert.deepEqual(await browser.evaluate(`({ state: ${sheetState(modelsSheet)}, parts: ${goParts(modelsSheet)}, fixes: ${goFixes(modelsSheet)},
      changes: [...document.querySelectorAll('${modelsSheet} [data-side="staged changes"] li')].map(li => [li.querySelector('.${G}models-cf').textContent, li.querySelector('.${G}models-cv').textContent]),
      changed: [...document.querySelectorAll('${modelsSheet} [data-cell][data-changed]')].map(cell => cell.dataset.key) })`), {
      state: `${listOf(active).length} models · staged list beside it`, parts: [["1 change", "strong"], ["staged", null]], fixes: ["discard"],
      changes: [["speed", `${Math.round(active.models[0]!.tokensPerSecond!)} tok/s→101 tok/s`]], changed: [active.models[0]!.key],
    }, "The staged list says what it changes against the list in use, on its rung and beside the list");
    await sheetZeroShift(browser, modelsSheet, "Models staged list");
    await sheetGeometry(browser, modelsSheet, "Models staged list");
    const fastest: CatalogDocument = { ...faster, models: faster.models.map((model, index) => index === 0 ? { ...model, tokensPerSecond: 120 } : model) };
    from = trace.requests.length;
    await click(browser, element(`${modelsSheet} [data-cue="import"]`));
    await until(browser, "an import over the staged list says it replaces it",
      `!!${dialog}?.open && ${importEffect} === 'Paste a Code model list, or drop its file here. It replaces the staged list; the list in use changes only when you use it.'`);
    await stageList(fastest);
    await until(browser, "once staged, the readout says it replaced the list staged before",
      `${sheetSays(modelsSheet)} === 'staged · 1 change beside the list in use; it replaced the list staged before'`);
    const restaged = await readConfiguration(server, writer, target);
    assert.deepEqual(writes(from), [{ name: "atyrode.code.stageCatalog", input: { containerId: target.containerId, expectedRevision: staged.revision, document: fastest } }],
      "The import over the staged list stages exactly the pasted list at the revision shown");
    assert.deepEqual([restaged.configuration?.active, restaged.configuration?.draft?.document], [afterFirst.configuration?.active, fastest], "It replaces the staged list, and nothing is in use");
    from = trace.requests.length;
    await click(browser, goFix(modelsSheet, "discard"));
    await until(browser, "discard drops the staged list; the verified one stays in use", `${phaseIs("verified")} && ${goIs(modelsSheet, "back to code")}`);
    assert.deepEqual(writes(from), [{ name: "atyrode.code.discardCatalog", input: { containerId: target.containerId, expectedRevision: restaged.revision } }], "Discard drops the staged list at the revision shown");
    const discarded = await readConfiguration(server, writer, target);
    assert.deepEqual([discarded.configuration?.active, discarded.configuration?.draft], [afterFirst.configuration?.active, null], "Discarding leaves the list in use as it was");

    // Verify again measures the verified list afresh. Under reduced motion its check and charge animate nothing, and Esc
    // stops the run while its charge waits: the sheet stays open on the verified list and nothing is spent or cancelled.
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    // A transition already under way when motion is reduced runs out its own duration; the check starts from rest.
    await still(browser);
    try {
      await click(browser, goFix(modelsSheet, "verify again"));
      await until(browser, "verify again checks the accounts' models again", `${phaseIs("inventory")} || ${phaseIs("charge")}`);
      await sheetStill(browser, "the checking hold");
      await until(browser, "its charge waits", `${phaseIs("charge")} && ${goIs(modelsSheet, "confirm charge")}`);
      await sheetStill(browser, "the charge");
      assert.equal(started.length, 2, "Verify again runs one more inventory");
      await click(browser, element(`${modelsSheet} [data-cell][data-key]`));
      await key(browser, "Escape", 27);
      await until(browser, "Esc stops the waiting charge, and the sheet stays open on the verified list", `${phaseIs("verified")} && ${element(stage)}.hidden === true`);
      await sheetStill(browser, "a stopped run");
    } finally {
      await browser.send("Emulation.setEmulatedMedia", { features: [] });
    }
    assert.deepEqual([benchmarks.size, cancels.length], [2, 0], "A stopped charge spends nothing and has no job to cancel");
    await click(browser, goFix(modelsSheet, "verify again"));
    await until(browser, "verify again waits on its charge", `${phaseIs("charge")} && ${goIs(modelsSheet, "confirm charge")}`);
    // This time the plan serves one GPT model, the one the first verification put on GPT's first rung.
    const servedId = verified.document.models.find(model => model.provider === "openai-codex" && model.tier === 1)!.id;
    unserved = new Set(inventoryDraft(inventories.get("synthetic-inventory-3")!, "any").benchmark.candidates
      .filter(candidate => candidate.provider === "openai-codex" && candidate.id !== servedId).map(candidate => candidate.id));
    assert(unserved.size > 0, "The plan leaves some Codex model unserved");
    await click(browser, goButton);
    await until(browser, "the list is measured again and verified", settled);
    const again = derivedFrom("synthetic-inventory-3");
    const afterAgain = await readConfiguration(server, writer, target);
    assert.equal(benchmarks.size, 4, "Verify again spends one benchmark per provider");
    assert.deepEqual(afterAgain.configuration?.active?.document, again.document, "Verified again, the list in use is the new derivation");
    assert.equal(afterAgain.configuration?.active?.provenance?.benchmarkCompletedAt, again.benchmark.completedAt, "The new verification is recorded");
    assert(again.benchmark.completedAt > verified.benchmark.completedAt);

    // GPT is laddered on the one model its plan serves, short rather than refused, and says so beside its name; the models
    // the plan does not serve are left out as not served. An empty rung GPT offers names the rung it lands on; elite, which
    // GPT does not offer, says only that it has no model, as the model row refuses it.
    assert.deepEqual([again.document.models.filter(model => model.provider === "openai-codex").map(model => [model.tier, model.id]),
      compileCatalog(again.document).short], [[[1, servedId]], ["openai"]], "One GPT model answers, so the derivation ladders GPT short");
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('${modelsSheet} .${G}models-prov')].map(el => [el.textContent, el.dataset.short !== undefined])`),
      [["GPT · short", true], ["Claude", false]], "GPT's head says it is short, and Claude's, whole, does not");
    const notServed = await browser.evaluate<{ id: string; why: string; label: string }[]>(`[...document.querySelectorAll('${modelsSheet} [data-side="left out"] li')].map(li => ({
      id: li.querySelector('.${G}models-xid').textContent, why: li.querySelector('.${G}models-why').textContent, label: li.querySelector('.${G}models-xid').getAttribute('aria-label') }))
      .filter(entry => entry.why === 'not served')`);
    assert.deepEqual(notServed, [...unserved].sort().map(id => ({ id: `openai-codex/${id}`, why: "not served",
      label: `openai-codex/${id}: Not served to your accounts: their plan, their settings or this client excludes it` })),
      "Every Codex model the plan does not serve is left out as not served");
    const lands = await browser.evaluate<string>(`${element(`${modelsSheet} [data-cell="openai:1"] .${G}models-alias`)}.textContent`);
    await pointOf(browser, element(`${modelsSheet} [data-cell="openai:3"]`));
    await until(browser, "an empty rung the short family offers names the rung it lands on",
      `${sheetSays(modelsSheet)} === ${JSON.stringify(`smart GPT · No smart GPT model in the list · the model row lands on ${lands}`)}`);
    await pointOf(browser, element(`${modelsSheet} [data-cell="openai:4"]`));
    await until(browser, "elite, which the short family does not offer, lands nowhere",
      `${sheetSays(modelsSheet)} === 'elite GPT · No elite GPT model in the list'`);
    await pointAway(browser);
    await sheetGeometry(browser, modelsSheet, "Models short list");

    // An unsaved edit of the team in use holds putting a staged list in use, which would replace the list it was made on:
    // the next action says so, and what each fix does, with save and discard edit beside it; a press writes nothing. Saving
    // the edit on the list it was made on lifts the hold. The edit is one the staged list's own default team does not
    // repeat, so the reset that follows is seen.
    const slower: CatalogDocument = { ...again.document, models: again.document.models.map((model, index) => index === 1 ? { ...model, tokensPerSecond: 77 } : model) };
    const stagedDefault = defaultSelection(compileCatalog(slower));
    const draftKey = storedDraftKey(writer.principal.id, workspace.id);
    await closeSheet(browser);
    const advisor = await browser.evaluate<string>(`[...${row("advisor")}.querySelectorAll('.${G}word')].find(el => el.dataset.off === undefined && el.dataset.selected === undefined && el.dataset.key !== ${JSON.stringify(stagedDefault.advisor)}).dataset.key`);
    await choose(browser, "advisor", advisor);
    await openSheet(browser, "models");
    await click(browser, element(`${modelsSheet} [data-cue="import"]`));
    await stageList(slower, "refused");
    assert.deepEqual(await browser.evaluate(`({ parts: ${goParts(modelsSheet)}, fixes: ${goFixes(modelsSheet)} })`),
      { parts: [["unsaved profile edit", "attention"]], fixes: ["save", "discard edit"] }, "Use staged list waits on the unsaved edit, with save and discard edit beside it");
    const held = await readConfiguration(server, writer, target);
    from = trace.requests.length;
    await click(browser, goButton);
    await until(browser, "a held press says what using the staged list and each fix do", `${sheetSays(modelsSheet)} === ${JSON.stringify(
      "use staged list · Your unsaved edit is on the list in use, and using the staged list starts from its own default team. Save keeps the edit on the list in use; discard edit drops it.")}`);
    assert.deepEqual(writes(from), [], "A held press writes nothing");
    await click(browser, goFix(modelsSheet, "save"));
    await until(browser, "saved, the edit lets the staged list be used", `${goIs(modelsSheet, "use staged list")} && JSON.stringify(${goFixes(modelsSheet)}) === '["discard"]'`);
    const before = await readConfiguration(server, writer, target);
    assert.equal(before.configuration?.selection?.advisor, advisor, "The saved team is the edit");
    assert.deepEqual(writes(from), [{ name: "atyrode.code.select", input: { containerId: target.containerId, expectedRevision: held.revision, selection: before.configuration?.selection } }],
      "Save writes exactly the edit at the revision shown");

    // Use staged list reviews the staged list at the revision shown and promotes exactly that review; the list in use is then
    // the staged one with its own default team, unverified, and verifying it is the next action. While those writes are in
    // flight the main view takes no edit, so their receipt never lands on one: Esc goes back to Code, a row press there is
    // refused, and nothing is kept.
    from = trace.requests.length;
    holdNextReview = true;
    await click(browser, goButton);
    await waitFor(() => heldReview.held, timeout, 50);
    await key(browser, "Escape", 27);
    await until(browser, "Esc goes back to Code while the list is being put in use", `${element(stage)}.hidden === false`);
    const otherAdvisor = await browser.evaluate<string>(`[...${row("advisor")}.querySelectorAll('.${G}word')].find(el => el.dataset.off === undefined && el.dataset.selected === undefined).dataset.key`);
    await click(browser, word("advisor", otherAdvisor));
    await Bun.sleep(300);
    assert.deepEqual(await browser.evaluate(`[${chosenKey("advisor")}, sessionStorage.getItem(${JSON.stringify(draftKey)})]`), [advisor, null],
      "No edit lands, or is kept, while Models' writes are in flight");
    await openSheet(browser, "models");
    heldReview.release();
    await until(browser, "use staged list puts it in use with its own default team, unverified, and says so", `${phaseIs("unverified")} && ${goIs(modelsSheet, "verify models")} &&
      ${sheetState(modelsSheet)} === ${JSON.stringify(`${listOf(slower).length} models · unverified`)} &&
      ${sheetSays(modelsSheet)} === 'in use · the staged list replaced the one in use; the profile is its default team now; verify it next'`);
    const review = reviews.at(-1);
    assert(review, "The real server reviewed the staged list");
    assert.equal(review.catalogDigest, before.configuration?.draft?.digest, "The review is of exactly the staged list");
    assert.deepEqual(writes(from), [
      { name: "atyrode.code.reviewCatalog", input: { containerId: target.containerId, expectedRevision: before.revision, source: "draft" } },
      { name: "atyrode.code.promoteCatalog", input: { containerId: target.containerId, expectedRevision: before.revision, source: "draft", reviewDigest: review.reviewDigest } },
    ], "Use staged list reviews the staged list at the revision shown, then promotes exactly that review");
    const used = await readConfiguration(server, writer, target);
    assert.deepEqual([used.configuration?.active?.document, used.configuration?.active?.provenance, used.configuration?.draft], [slower, null, null],
      "The staged list is in use, unverified, and nothing is staged");
    assert.deepEqual(used.configuration?.selection, review.review.selection, "The staged list goes in use with the team its review chose, its own default");
    assert.notEqual(used.configuration?.selection?.advisor, advisor, "The saved edit does not carry over to the staged list");
    await closeSheet(browser);
    fixture.check();
  } finally {
    heldInventory.release();
    heldReview.release();
    await fixture.stop();
    trace.stop();
  }
  assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), deployments, "Models never requests native approval");
  assert.deepEqual(await ownerAction(server, "core.terminals.listAll", {}), terminals);
}
// ---------------------------------------------------------------- tiered usage windows

/**
 * Every window of the fixture's usage is a row (#248): a tiered one, a limit of its own beside the account's shared
 * windows, is labelled with its tier, in the usage and the accounts. A used-up `fable` window makes Claude neither tight
 * nor maxed, as only the shared windows judge a provider's pool, while the same window reported as shared does. Where
 * the usage grid turns to two columns no label squeezes a reset. The observation and the reading are synthetic, a Codex
 * slot beside the Claude one; nothing is saved.
 */
async function tieredUsageScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant): Promise<void> {
  const workspace = await createContainer(server, "Tiered usage windows", "canvas");
  const target = { containerId: workspace.id };
  const created = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { ...target, expectedRevision: 0 });
  assert(created.ok);
  const base = await readConfiguration(server, writer, target);
  await arrangeWorkbench(server, writer);
  const codex = { reference: { kind: "credential" as const, scope: fixtureScope, provider: "openai-codex", credentialId: 3 }, credentialId: 3,
    type: "api_key" as const, identityKey: null, email: null, disabled: false, blocks: [] };
  const observation = (): OmpResult<"accounts"> => {
    const claude = fixtureAccounts([1]);
    return { ...claude, accounts: [...claude.accounts, codex] };
  };
  // The control: reported as shared, the `fable` window's numbers judge Claude's pool, so the checks below can see a strain.
  let shared = false;
  const fixture = await intercept(browser, server, name => {
    if (name === "atyrode.omp.accounts.accounts") return { ok: true, result: observation() };
    if (name !== "atyrode.omp.accounts.usage") return undefined;
    const reading = fixtureUsage(observation());
    if (!shared) return { ok: true, result: reading };
    return { ok: true, result: { ...reading, snapshot: { ...reading.snapshot!, accounts: reading.snapshot!.accounts.map(account => ({
      ...account, windows: account.windows.map(window => window.tier === "fable" ? { ...window, tier: null } : window) })) } } };
  });
  const usagePane = `${generator} [data-pane="usage"]`, accountsPane = `${generator} [data-pane="accounts"]`;
  /** Each account's windows as drawn, by provider and account: the label, the tier it names and the window's word. */
  const windowRows = (pane: string) => `Object.fromEntries([...document.querySelectorAll('${pane} .${G}usage-acct')].map(cell => [
    cell.querySelector('.${G}usage-pname').firstChild.textContent + ' ' + cell.dataset.usageAccount,
    [...cell.querySelectorAll('.${G}usage-win')].map(row => [row.querySelector('.${G}usage-wl').textContent, row.dataset.tier ?? null, row.querySelector('.${G}usage-word')?.textContent ?? '']),
  ]))`;
  const rows = {
    "Claude API key 1": [["5h", null, ""], ["7d fable", "fable", "maxed"]],
    "Codex API key 3": [["5h", null, ""], ["7d base-model-inference", "base-model-inference", ""]],
  };
  /** What would say Claude's pool is strained: a struck lead in the routing or the profile, a refused lane, Claude called tight or maxed. */
  const strain = `({ struck: [...document.querySelectorAll('${generator} [data-down]')].map(el => el.textContent),
    refused: [...document.querySelectorAll('${generator} [data-row="lane"] .${G}word[data-off]')].map(el => el.dataset.key),
    said: /Claude (tight|maxed|has no account with room)/.test(${element(stage)}.textContent) })`;
  /** Every reset a pane draws, and those not shown whole on one line inside their column, their window's row, the pane and any box that clips them. */
  const resets = (pane: string) => `(() => {
    const shown = [...document.querySelectorAll('${pane} .${G}usage-rst')].filter(el => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && el.getClientRects().length);
    const clipped = [];
    for (const el of shown) {
      let right = Math.min(el.parentElement.getBoundingClientRect().right, el.closest('.${G}usage-win').getBoundingClientRect().right, el.closest('[data-pane]').getBoundingClientRect().right);
      for (let box = el.parentElement; box && !box.matches('[data-pane]'); box = box.parentElement) if (getComputedStyle(box).overflowX !== 'visible') right = Math.min(right, box.getBoundingClientRect().right);
      const over = el.getBoundingClientRect().right - right;
      if (over > 0.5 || el.getClientRects().length > 1) clipped.push(JSON.stringify(el.textContent) + ' runs ' + over.toFixed(1) + 'px past its column on ' + el.getClientRects().length + ' line(s)');
    }
    return { checked: shown.length, clipped };
  })()`;
  try {
    await openGenerator(browser, server, workspace.id);
    await until(browser, "the usage draws both accounts' windows", `document.querySelectorAll('${usagePane} .${G}usage-win').length === 4`);
    assert.deepEqual(await browser.evaluate(windowRows(usagePane)), rows, "Every reported window is its own row in the usage, a tiered one labelled with its tier");
    await showView(browser, "accounts");
    await until(browser, "the accounts draw both accounts' windows", `document.querySelectorAll('${accountsPane} .${G}usage-win').length === 4`);
    assert.deepEqual(await browser.evaluate(windowRows(accountsPane)), rows, "Every reported window is its own row in the accounts, a tiered one labelled with its tier");
    await showView(browser, "main");
    await assertRoutes(browser, true);
    // Wide, the routing's leads; narrow, the profile's leads beside the generator.
    try {
      for (const [width, leads] of [[1280, `[data-pane="routing"] .${G}tok-value`], [390, `.${G}profile-lead`]] as const) {
        await panelWidth(browser, width);
        await still(browser);
        assert.deepEqual(await browser.evaluate(strain), { struck: [], refused: [], said: false },
          `At ${width}px a used-up fable window strikes no lead, refuses no lane and calls Claude neither tight nor maxed`);
        shared = true;
        await key(browser, "r", 82);
        await until(browser, `at ${width}px the same window reported as shared strikes Claude's leads`, `document.querySelector('${generator} ${leads}[data-down]') !== null`);
        shared = false;
        await key(browser, "r", 82);
        await until(browser, "reported as tiered again it strikes none", `document.querySelector('${generator} [data-down]') === null`);
      }
    } finally {
      await browser.send("Emulation.clearDeviceMetricsOverride", {});
    }
    const problems: string[] = [];
    try {
      for (const width of [780, 790, 800, 810]) {
        await panelWidth(browser, width);
        for (const [view, pane] of [["main", usagePane], ["accounts", accountsPane]] as const) {
          await showView(browser, view);
          await still(browser);
          const { checked, clipped } = await browser.evaluate<{ checked: number; clipped: string[] }>(resets(pane));
          if (checked !== 4) problems.push(`${view} at ${width}px: ${checked} resets drawn, not 4`);
          problems.push(...clipped.map(entry => `${view} at ${width}px: ${entry}`));
        }
      }
    } finally {
      await browser.send("Emulation.clearDeviceMetricsOverride", {});
    }
    await showView(browser, "main");
    assert.deepEqual(problems, [], "From 780 to 810px, where the usage grid turns to two columns, every reset shows whole in the usage and the accounts");
    assert.deepEqual(await readConfiguration(server, writer, target), base, "Reading tiered windows saves nothing");
    fixture.check();
  } finally {
    await fixture.stop();
  }
}

// ---------------------------------------------------------------- the lead row's struck choices

/**
 * The lead row with Claude's one account excluded by the saved choices (#252). No Claude lane can run, so Claude's lead is
 * struck, cannot be picked and says why when pointed at, pressed and aloud. GPT-led would cross to Claude while GPT only
 * runs, so GPT stays pickable, says beforehand that it lands on GPT only and does; there the `only` box is checked and
 * struck, and pointing at it, focusing it or Space on it says why and leaves it checked. The observation and the reading
 * are synthetic, a Claude slot beside a Codex one; the exclusion is the one save, made before the panel opens, and the
 * panel saves nothing.
 */
async function leadStruckScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant): Promise<void> {
  const workspace = await createContainer(server, "Struck leads", "canvas");
  const target = { containerId: workspace.id };
  const created = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { ...target, expectedRevision: 0 });
  assert(created.ok);
  const claude = fixtureAccounts([1]);
  const excluded = await callAction(server, writer.token, "atyrode.code.changeAccounts", { ...target, expectedRevision: (created.result as Configuration).revision,
    change: { kind: "set-account", enabled: false, reference: claude.accounts[0]!.reference } });
  assert(excluded.ok, "The saved choices exclude Claude's one account");
  const base = await readConfiguration(server, writer, target);
  await arrangeWorkbench(server, writer);
  const codex = { reference: { kind: "credential" as const, scope: fixtureScope, provider: "openai-codex", credentialId: 3 }, credentialId: 3,
    type: "api_key" as const, identityKey: null, email: null, disabled: false, blocks: [] };
  const observation = (): OmpResult<"accounts"> => ({ ...claude, observedAt: Date.now() - 1_000, accounts: [...claude.accounts, codex] });
  const fixture = await intercept(browser, server, name => name === "atyrode.omp.accounts.accounts" ? { ok: true, result: observation() }
    : name === "atyrode.omp.accounts.usage" ? { ok: true, result: fixtureUsage(observation()) } : undefined);
  /** The readout warns with `why`. */
  const warns = (why: string) => `${readout}.dataset.tone === 'warn' && ${readout}.textContent.includes(${JSON.stringify(why)})`;
  try {
    await openGenerator(browser, server, workspace.id);
    const claudeLead = word("lane", "anthropic"), gptLead = word("lane", "openai");
    await until(browser, "Claude's lead is struck and names why",
      `${claudeLead}?.dataset.off !== undefined && ${claudeLead}.getAttribute('aria-disabled') === 'true' && !!${claudeLead}.getAttribute('aria-description')`);
    assert.equal(await browser.evaluate(chosenKey("lane")), "mixed", "The initialized profile leads Mixed");
    const why = await browser.evaluate<string>(`${claudeLead}.getAttribute('aria-description')`);
    await pointOf(browser, claudeLead);
    await until(browser, "pointing at the struck lead says why", `${warns(why)} && ${readout}.querySelector('b')?.textContent === 'Claude'`);
    await click(browser, claudeLead);
    await until(browser, "a press on the struck lead says why at once, in the readout and aloud",
      `${warns(why)} && ${liveRegion}.textContent === ${JSON.stringify(`lead Claude: ${why}`)}`);
    assert.equal(await browser.evaluate(chosenKey("lane")), "mixed", "A struck lead cannot be picked");
    assert.equal(await browser.evaluate(`${gptLead}.dataset.off === undefined && ${gptLead}.getAttribute('aria-label')`), "GPT only",
      "GPT, whose GPT-led lane cannot run, is pickable as GPT only");
    await pointOf(browser, gptLead);
    await until(browser, "pointing at GPT says it lands on GPT only", `${readout}.textContent.includes('cannot run, so GPT only')`);
    await click(browser, gptLead);
    await until(browser, "GPT lands on GPT only, its box checked and struck with a reason", `${chosenKey("lane")} === 'openai' && ${rowValue("lane")} === 'GPT only' &&
      ${onlyBox}.getAttribute('aria-checked') === 'true' && ${onlyBox}.getAttribute('aria-disabled') === 'true' && ${onlyBox}.dataset.off !== undefined &&
      !!${onlyBox}.getAttribute('aria-description')`);
    const boxWhy = await browser.evaluate<string>(`${onlyBox}.getAttribute('aria-description')`);
    await pointOf(browser, onlyBox);
    await until(browser, "pointing at the struck box says why", warns(boxWhy));
    await focusRow(browser, "lane");
    await key(browser, "Tab", 9);
    await until(browser, "keyboard focus on the struck box says why", `document.activeElement === ${onlyBox} && ${warns(boxWhy)}`);
    await key(browser, " ", 32);
    await until(browser, "Space on the struck box says why aloud and leaves it checked, with focus on it",
      `${liveRegion}.textContent === ${JSON.stringify(`lead only: ${boxWhy}`)} && document.activeElement === ${onlyBox} && ${onlyBox}.getAttribute('aria-checked') === 'true'`);
    assert.equal(await browser.evaluate(rowValue("lane")), "GPT only", "A refused box leaves the lane");
    assert.deepEqual(await readConfiguration(server, writer, target), base, "Struck choices, their refusals and a lead change save nothing");
    fixture.check();
  } finally {
    await fixture.stop();
  }
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
  // Recorded as the workflow records it: the artifact an installation of the pinned OMP runs an inventory from, and the
  // revision of the real bundled catalog the browser compares it with.
  const staged = await callAction(server, writer.token, "atyrode.code.stageCatalog", { containerId: first.containerId, expectedRevision: excludedRevision, document,
    verification: { ompVersion: OMP_VERSION, inventoryArtifactSha256: pinnedOmpArtifact(), catalogRevision: metadata.revision,
      inventoryObservedAt: Date.now() - 3_000, benchmarkCompletedAt: Date.now() - 2_000,
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
  assert.equal(inventoryArtifact(destination.result as OmpResult<"describeDestination">), null,
    "Uninstalled, the real destination pins no OMP runtime, so what the browser compares with the record here is the catalog revision");
  const deployments = await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 });

  // The viewer's own Code view: every write refuses on authority, and edits stay a local preview.
  await arrangeWorkbench(server, viewer);
  const viewerTrace = await watchActions(viewerBrowser, server);
  try {
    await openGenerator(viewerBrowser, server, first.containerId);
    await until(viewerBrowser, "a viewer's launch refuses on authority, in neutral words",
      `${launchButton}.dataset.state === 'refused' && !!document.querySelector('${generator} .${G}launch-part[data-tone="neutral"]')`);
    await focusRow(viewerBrowser, "thinking");
    await key(viewerBrowser, "ArrowLeft", 37);
    await key(viewerBrowser, "Enter", 13, { modifiers: CTRL });
    await click(viewerBrowser, launchButton);
    // The viewer's accounts are managed read-only: the saved pool shows and cannot be chosen or edited.
    await showView(viewerBrowser, "accounts");
    await click(viewerBrowser, element(`${generator} [data-manage]`));
    await until(viewerBrowser, "the viewer's management shows the saved pool, refused", shownView("manage"));
    await control(viewerBrowser, "a viewer's saved pool cannot be chosen", element(`${generator} [data-pane="manage"] [aria-label="Active account pool"] select`), true);
    await control(viewerBrowser, "a viewer cannot save a pool", workspaceButton("Save as preset…"), true);
    await Bun.sleep(300);
    assert.deepEqual(viewerTrace.requests.filter(request => /^atyrode\.code\.(initializeConfiguration|stageCatalog|promoteCatalog|select|changeAccounts)$/.test(request.name)), [],
      "A viewer's edits and presses never request a shared write");
  } finally { viewerTrace.stop(); }
  assert.deepEqual((await readConfiguration(server, viewer, first)).revision, initial.revision, "A viewer leaves the workspace profile as it is");

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
    await chooseMachine(browser, first.machineId, machineName);
    // The verification holds; the next step is the launch, which this machine has no permission for.
    await until(browser, "the verified profile's next step is a refused launch", launchIs("launch", "refused"));
    await assertRoutes(browser, initial.selection?.advisor !== "off");
    assert((await routedRoles(browser)).every(entry => document.models.some(model => model.key === entry.alias)),
      "Configured routes use the saved catalog, never bundled starter metadata");

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
    await showView(browser, "accounts");
    await showView(browser, "main");
    await openOptions(browser);
    assert.equal(await browser.evaluate(`${skillsSection}.dataset.mode`), "disabled", "Unrelated navigation and refresh preserve the ephemeral skill choice");
    await click(browser, workspaceButton("default skills"));
    assert.equal(await browser.evaluate(`${skillsSection}.dataset.mode`), "preserve", "Default skills restores ordinary loading instead of disabling it");
    await click(browser, workspaceButton("all skills off"));
    await closeOptions(browser);
    await until(browser, "More still says the closed options' choice", `${more}?.textContent.includes('skills off') === true`);
    await openMenu(browser);
    assert.equal(await browser.evaluate(`${menuItem("options")}.textContent.includes('skills off')`), true, "More's Options item says the closed options' choice");
    await key(browser, "Escape", 27);
    await until(browser, "Esc closes More's menu", `${menu} === null`);

    // Local edits of the saved profile: one keyboard step of thinking, the fourth tier, automatic plans.
    const savedThinking = await browser.evaluate<string>(chosenKey("thinking"));
    await focusRow(browser, "thinking");
    await key(browser, "ArrowRight", 39);
    await until(browser, "→ raises the thinking", `${chosenKey("thinking")} !== ${JSON.stringify(savedThinking)}`);
    const localThinking = await browser.evaluate<string>(chosenKey("thinking"));
    await until(browser, "the fourth observed tier is available", `${word("tier", "elite")} !== null && ${word("tier", "elite")}.dataset.off === undefined`);
    await choose(browser, "tier", "elite");
    await openOptions(browser);
    await turn(browser, autoPlans, true);
    await closeOptions(browser);
    await until(browser, "an edited verified profile saves before its review, and offers the saved one back", `${launchIs("save & review", "ready")} && !!${revertButton}`);
    // The launch says what its save changes while it is pointed: exactly the three edited settings.
    await pointOf(browser, launchButton);
    await until(browser, "the launch's readout counts the edited settings", `/^save & review · 3 changes to the profile: /.test(${readout}.textContent)`);
    assert.deepEqual(await browser.evaluate(`${readout}.textContent.split(': ').slice(1).join(': ').split(', ').map(change => change.split(' ')[0]).sort()`), ["extras", "thinking", "tier"],
      "The save changes exactly the edited settings");
    await pointAway(browser);
    const edits = await browser.evaluate<string>(profileValues);

    // The edit rests on the saved profile, not on the record's revision: the writer's own account edits (a preset made and
    // removed, which leaves the pool as it was) move the record on, and the edit stays ready to save, never a conflict.
    let revision = (await readConfiguration(server, writer, first)).revision;
    const spare = { id: "browser-spare-pool", name: "Spare pool", disabled: [] };
    for (const change of [{ kind: "create-preset", preset: spare }, { kind: "delete-preset", id: spare.id }]) {
      const changed = await callAction(server, writer.token, "atyrode.code.changeAccounts", { containerId: first.containerId, expectedRevision: revision, change });
      assert(changed.ok, "The writer edits the workspace's account presets beside the unsaved profile");
      revision = (changed.result as Configuration).revision;
    }
    await panelReads(browser, revision);
    await until(browser, "own account edits leave the edit ready to save, without a conflict",
      `${launchIs("save & review", "ready")} && !!${revertButton} && !${fix("conflict")} && ${profileValues} === ${JSON.stringify(edits)}`);

    // A lead no included account serves refuses the save, as the session door would refuse its launch. The panel reads the
    // Claude account as disabled (a GPT one stays) while the verification it stands on is not observed again: the save
    // is refused with the family named, and neither a press nor Mod+↵ writes.
    const gpt = { reference: { kind: "credential" as const, scope: fixtureScope, provider: "openai-codex", credentialId: 3 }, credentialId: 3,
      type: "api_key" as const, identityKey: null, email: null, disabled: false, blocks: [] };
    observed = { ...fixtureAccounts(), accounts: [...fixtureAccounts().accounts.map(account => account.credentialId === 1 ? { ...account, disabled: true } : account), gpt] };
    await focusLaunch(browser);
    await key(browser, "r", 82);
    await until(browser, "a lead no account serves refuses the save and names its family, with the way to its accounts",
      `${launchIs("save & review", "refused")} && ${lineText}.includes('Claude') && !!${fix("accounts")}`);
    const said = await browser.evaluate<string>(`${liveRegion}.textContent`);
    await key(browser, "Enter", 13);
    await until(browser, "the refused press says why", `${liveRegion}.textContent !== ${JSON.stringify(said)} && ${liveRegion}.textContent.endsWith(${launchButton}.title)`);
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await Bun.sleep(300);
    assert.equal((await readConfiguration(server, writer, first)).revision, revision, "A save refused for an unserved lead writes nothing");
    observed = fixtureAccounts();
    await key(browser, "r", 82);
    await until(browser, "with the Claude account back the save is ready again", `${launchIs("save & review", "ready")} && ${profileValues} === ${JSON.stringify(edits)}`);

    // Models shows the workspace's verified list rung by rung; the accounts' management keeps an unsaved draft in its view under the accounts.
    await openSheet(browser, "models");
    await until(browser, "Models shows the saved list, verified", `${element(modelsSheet)}?.dataset.phase === 'verified' && ${goIs(modelsSheet, "back to code")}`);
    assert.deepEqual(await browser.evaluate(modelList), listOf(document), "Models shows the saved verified list, each rung on its model");
    await closeSheet(browser);
    const manage = `${generator} [data-pane="manage"]`;
    await showView(browser, "accounts");
    await click(browser, element(`${generator} [data-manage]`));
    await until(browser, "Manage accounts opens the accounts' management in place", shownView("manage"));
    await until(browser, "the passive account observation settles before the editor gesture",
      `[...document.querySelectorAll('${manage} .plugin-atyrode_code__account-observation, ${manage} .plugin-atyrode_code__account-notice[role="status"]')].some(el => el.getClientRects().length)`);
    await control(browser, "shared saved account pool is editable", workspaceButton("Edit pool"), false);
    await click(browser, workspaceButton("Edit pool"));
    const accountDraft = element(`${manage} form[aria-label="Saved account pool editor"] input[required]`);
    await control(browser, "shared account editor has opened", accountDraft, false);
    await click(browser, accountDraft);
    await key(browser, "End", 35);
    await browser.typeText(" local draft");
    const accountDraftName = `${preset.name} local draft`;
    await click(browser, `[...document.querySelectorAll('${manage} .${G}head button')].find(el => el.textContent.trim() === 'Back to accounts')`);
    await until(browser, "Back to accounts goes back to the accounts", shownView("accounts"));
    await key(browser, "m", 77);
    await until(browser, "m opens the management again, with the draft as it was left", `${shownView("manage")} && ${accountDraft}?.value === ${JSON.stringify(accountDraftName)}`);
    await click(browser, element(`${manage} .${G}title`));
    await key(browser, "a", 65);
    await until(browser, "a goes from the management to the generator", shownView("main"));

    // The second destination: the account draft and the edited profile stay; the ad-hoc skill choice does not.
    await chooseMachine(browser, second.machineId, secondName);
    await openOptions(browser);
    await until(browser, "a new destination clears ad-hoc skill choices before they can be reused", `${skillsSection}.dataset.mode === 'preserve'`);
    await closeOptions(browser);
    await showView(browser, "accounts");
    await key(browser, "m", 77);
    await until(browser, "the management opens", shownView("manage"));
    assert.equal(await browser.evaluate(`${accountDraft}.value`), accountDraftName, "The visited account editor retains its unsaved preset across destinations");
    assert.equal(await browser.evaluate(`${element(`${manage} .plugin-atyrode_code__account-exclusions`)}.textContent.includes(${JSON.stringify(exclusion.scope)})`), true,
      "The account draft keeps its nonempty unobserved exclusion instead of importing another machine’s pool");
    await click(browser, element(`${manage} .${G}title`));
    await key(browser, "a", 65);
    await until(browser, "back to the generator", shownView("main"));
    assert.equal(await browser.evaluate(chosenKey("thinking")), localThinking, "The local thinking survives the switch");
    assert.equal(await browser.evaluate(chosenKey("tier")), "elite");
    assert.equal(await browser.evaluate(`${autoPlans}?.getAttribute('aria-checked')`), "true", "planYolo remains a profile choice, not a native permission");

    // Save from the second destination: the press saves, and its review stops where this machine has no permission.
    await until(browser, "the edited profile can be saved from the second destination", launchIs("save & review", "ready"));
    const unsaved = (await readConfiguration(server, viewer, second)).revision;
    await focusLaunch(browser);
    await key(browser, "Enter", 13);
    await waitFor(async () => (await readConfiguration(server, viewer, second)).revision === unsaved + 1, timeout, 50);
    await until(browser, "the saved profile's review stops at this machine's missing permission", launchIs("launch", "refused"));
    assert.equal(await browser.evaluate(`document.activeElement === ${launchButton}`), true, "The launch keeps focus from Save through its refusal");
    const saved = await readConfiguration(server, viewer, second);
    assert.equal(saved.configuration?.selection?.thinking, localThinking, "Second destination saves to the shared profile");
    assert.equal(saved.configuration?.selection?.capability, 4, "The fourth capability saves unchanged from the second destination");
    assert.equal(saved.configuration?.selection?.planYolo, true);
    assert.deepEqual(saved.configuration?.accounts, initial.accounts, "Saving the profile preserves shared account pools and exclusions");
    assert.deepEqual(saved.configuration?.active, initial.active, "Saving the profile leaves the verified catalog as it is");
    await chooseMachine(browser, first.machineId, machineName);
    assert.equal(await browser.evaluate(chosenKey("thinking")), localThinking, "Saved choices remain identical when returning to the first destination");
    assert(reads.length > 0 && reads.every(input => input.containerId === first.containerId && Object.keys(input).length === 1),
      "Ordinary browser configuration reads use only the container, never per-machine fanout or implicit legacy fallback");

    // A narrow touch screen keeps the session options and the generator reachable through the key line.
    await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    try {
      await until(browser, "the launch stays usable at a narrow viewport", `${launchButton}.getBoundingClientRect().width > 0`);
      await tap(browser, more);
      await until(browser, "a tap on More opens its menu", `${more}.getAttribute('aria-expanded') === 'true' && !!${menuItem("options")}?.getClientRects().length`);
      await tap(browser, menuItem("options"));
      await until(browser, "touch opens the session options", `!!${visibleSheet}?.contains(${skillsSection})`);
      await click(browser, workspaceButton("all skills off"));
      await key(browser, "Tab", 9);
      assert.equal(await browser.evaluate(`document.activeElement?.closest('[aria-label="Optional skills"]') === ${skillsSection} && !document.activeElement.matches(':disabled')`), true,
        "Skill controls remain keyboard reachable at a narrow viewport");
      await click(browser, workspaceButton("default skills"));
      await key(browser, "Escape", 27);
      await until(browser, "Esc closes the session options and keeps focus in the panel", `${element(stage)}.hidden === false && !!document.activeElement?.closest('${generator}')`);
      await focusRow(browser, "advisor");
      assert.equal(await browser.evaluate(chosenKey("thinking")), localThinking, "Responsive layout keeps the same profile");
    } finally {
      await browser.send("Emulation.clearDeviceMetricsOverride", {});
      await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }

    // An unsaved edit is kept across a reload. A foreign write of the profile it rests on, made while the panel was away,
    // brings it back as a conflict: the edit stays on show, nothing is rebased, and theirs is one press away.
    await focusRow(browser, "thinking");
    await key(browser, "ArrowLeft", 37);
    await until(browser, "← lowers the saved thinking", `${chosenKey("thinking")} !== ${JSON.stringify(localThinking)} && ${launchIs("save & review", "ready")}`);
    const kept = await browser.evaluate<string>(profileValues);
    await openGenerator(browser, server, first.containerId);
    await chooseMachine(browser, first.machineId, machineName);
    await until(browser, "the edited setting survives a reload, still ready to save",
      `${profileValues} === ${JSON.stringify(kept)} && ${launchIs("save & review", "ready")} && !!${revertButton}`);
    await browser.goto("about:blank");
    const current = await readConfiguration(server, writer, first);
    const ours = current.configuration!.selection!;
    const theirs = { ...ours, advisor: ours.advisor === "audit" ? "review" : "audit" } satisfies Selection;
    const foreign = await callAction(server, writer.token, "atyrode.code.select", { containerId: first.containerId, expectedRevision: current.revision, selection: theirs });
    assert(foreign.ok, "The profile is changed elsewhere while the panel is away");
    await openGenerator(browser, server, first.containerId);
    await chooseMachine(browser, first.machineId, machineName);
    await until(browser, "the kept edit comes back as a conflict with the write made meanwhile",
      `${launchButton}.dataset.state === 'refused' && !!${fix("conflict")} && ${profileValues} === ${JSON.stringify(kept)}`);
    assert.equal((await readConfiguration(server, writer, first)).revision, (foreign.result as Configuration).revision, "A kept edit in conflict writes nothing");
    await click(browser, fix("conflict"));
    await until(browser, "theirs replaces the kept edit",
      `${chosenKey("thinking")} === ${JSON.stringify(localThinking)} && ${chosenKey("advisor")} === ${JSON.stringify(theirs.advisor)} && !${revertButton} && !${fix("conflict")}`);
    const restored = await callAction(server, writer.token, "atyrode.code.select", { containerId: first.containerId, expectedRevision: (foreign.result as Configuration).revision, selection: ours });
    assert(restored.ok);
    await until(browser, "the rows follow the record back", `${chosenKey("advisor")} === ${JSON.stringify(ours.advisor)}`);
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
 * writer's authority, so the profile still saves from here, while a launch, which places a terminal
 * on the canvas, waits for one and says so. Such a writer is never told the workspace is read-only.
 */
async function canvaslessWriterScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, target: Target): Promise<void> {
  const before = await readConfiguration(server, writer, target);
  const arranged = await callAction(server, writer.token, "core.space.setLayout", { layout: {
    root: { id: "root", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "atyrode.code.generator.launcher" } },
  } });
  assert(arranged.ok);
  const trace = await watchActions(browser, server);
  const fixture = await intercept(browser, server, name => name === "atyrode.omp.accounts.accounts" ? { ok: true, result: fixtureAccounts() } : undefined);
  const readOnly = `/read-only/i.test(${element(generator)}.textContent + ${launchButton}.title)`;
  try {
    // From here the SDK's feed probe counts the panel's own reads (`ownReads`).
    await browser.evaluate("localStorage.setItem('manifold:debug', '1')");
    await openGenerator(browser, server, target.containerId);
    const openedAt = Date.now();
    assert.equal(await browser.evaluate(`${element(".react-flow")} === null`), true, "No workspace canvas is mounted beside the panel");
    await chooseMachine(browser, target.machineId, machineName);
    await until(browser, "without a canvas only the launch is refused, in neutral words that say what it needs",
      `${launchIs("launch", "refused")} && ${lineText}.includes('canvas') && !!document.querySelector('${generator} .${G}launch-part[data-tone="neutral"]')`);
    assert.equal(await browser.evaluate(readOnly), false, "A writer without a canvas is never told the workspace is read-only");
    const thinking = await browser.evaluate<string>(chosenKey("thinking"));
    await focusRow(browser, "thinking");
    await key(browser, "ArrowLeft", 37);
    await until(browser, "an edit offers Save, with no launch to chain", launchIs("save", "ready"));
    // A changed row is an unsaved edit however long it rests: with focus gone from the rows, away at another tab and back
    // past the quiet period, the panel reads nothing until the edit is saved, and then reads, once.
    await click(browser, generatorTitle);
    await until(browser, "a press on the generator's title takes focus from the rows to the panel root", `document.activeElement === ${element(generator)}`);
    const machineReads = (await browser.evaluate<(number | null)[]>(ownReads))[0];
    assert(machineReads !== null && machineReads !== undefined, "The SDK's feed probe counts the panel's reads of the machine list");
    await lookAwayAfter(browser, openedAt);
    await readsHeld(browser, "With a changed row unsaved, away and back past the quiet period, the panel reads nothing", Date.now(), machineReads);
    assert.equal(await browser.evaluate(`${launchIs("save", "ready")} && ${chosenKey("thinking")} !== ${JSON.stringify(thinking)}`), true, "The unsaved edit stays on show");
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await waitFor(async () => (await readConfiguration(server, writer, target)).revision === before.revision + 1, timeout, 50);
    await until(browser, "after the save only the launch waits for a canvas", launchIs("launch", "refused"));
    await readsOnce(browser, "once the edit is saved the panel reads its inputs again", machineReads + 1);
    await browser.evaluate("localStorage.removeItem('manifold:debug')");
    assert.notEqual((await readConfiguration(server, writer, target)).configuration?.selection?.thinking, before.configuration?.selection?.thinking, "Save wrote the edit");
    await focusRow(browser, "thinking");
    await key(browser, "ArrowRight", 39);
    await until(browser, "the edit back is another Save", `${launchIs("save", "ready")} && ${chosenKey("thinking")} === ${JSON.stringify(thinking)}`);
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await waitFor(async () => (await readConfiguration(server, writer, target)).revision === before.revision + 2, timeout, 50);
    await until(browser, "the profile is saved back", launchIs("launch", "refused"));
    assert.deepEqual((await readConfiguration(server, writer, target)).configuration?.selection, before.configuration?.selection, "Saving back restores the exact profile");
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
  /** What says a staged model list waits: More's mark and aside, its Models item's, and any other item's, read with the menu open. */
  const stagedMarks = async () => {
    await openMenu(browser);
    const says = (control: string) => `[...${control}.querySelectorAll('.${G}more-aside')].some(aside => aside.textContent === '· staged')`;
    const marks = await browser.evaluate<Record<string, boolean>>(`({
      more: ${more}.hasAttribute('data-staged'), moreSays: ${says(more)},
      models: ${menuItem("models")}.hasAttribute('data-staged'), modelsSays: ${says(menuItem("models"))},
      others: ${menuItems}.some(item => item.dataset.menuItem !== 'models' && (item.hasAttribute('data-staged') || ${says("item")})),
    })`);
    await key(browser, "Escape", 27);
    await until(browser, "Esc closes More's menu", `${menu} === null`);
    return marks;
  };
  const unmarked = { more: false, moreSays: false, models: false, modelsSays: false, others: false };
  await openGenerator(browser, server, workspace.id);
  // The launch's one place to send the person: a staged-only workspace is reviewed in Models, a press away and never refused.
  await until(browser, "a staged-only workspace's launch is its review in Models", launchIs("review in models", "ready"));
  assert.deepEqual(await stagedMarks(), unmarked, "With no active model list beside it, a staged one marks neither More nor its Models item: the launch is the way there");
  await still(browser);
  assert.notDeepEqual(await routedRoles(browser), expectedRoutes(document, defaultSelection(compileCatalog(document))),
    "An unresolved staged catalog is never silently replaced by the bundled starter's routes");
  await click(browser, launchButton);
  // Models shows the staged list with nothing in use: every model of it an addition, and use staged list its one next action.
  await until(browser, "the launch opens Models on the staged list", `${sheetOpen("Models")} && ${element(modelsSheet)}.dataset.phase === 'staged' &&
    ${goIs(modelsSheet, "use staged list")} && !!${element(`${modelsSheet} [data-side="staged changes"]`)}`);
  const added = listOf(textOnly).length;
  assert.deepEqual(await browser.evaluate(`({ state: ${sheetState(modelsSheet)}, parts: ${goParts(modelsSheet)}, fixes: ${goFixes(modelsSheet)}, list: ${modelList},
    changes: [...document.querySelectorAll('${modelsSheet} [data-side="staged changes"] .${G}models-cf')].map(el => el.textContent) })`),
    { state: `${added} models · staged, none in use`, parts: [[`${added} changes`, "strong"], ["staged", null]], fixes: ["discard"], list: listOf(textOnly),
      changes: Array.from({ length: added }, () => "added") }, "A staged list with nothing in use is all additions, used or discarded from its one next action");
  assert.deepEqual((await readConfiguration(server, writer, target)).configuration?.draft?.document, textOnly);
  await closeSheet(browser);

  // Beside an active catalog a staged one changes nothing until reviewed in Models.
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
  await openGenerator(browser, server, waiting.id);
  await until(browser, "the active catalog is routed", `document.querySelector(${JSON.stringify(routeRows)}) !== null && ${launchButton}.dataset.state !== 'busy'`);
  assert.deepEqual(await stagedMarks(), unmarked, "An active model list alone marks neither More nor its Models item");
  const second = await callAction(server, writer.token, "atyrode.code.stageCatalog", { ...waitingTarget, expectedRevision: (active.result as Configuration).revision, document: textOnly });
  assert(second.ok);
  await openGenerator(browser, server, waiting.id);
  await until(browser, "the active catalog is routed", `document.querySelector(${JSON.stringify(routeRows)}) !== null && ${launchButton}.dataset.state !== 'busy'`);
  assert.notEqual(await browser.evaluate(`${launchButton}.querySelector('.${G}launch-label').textContent`), "review in models", "Beside an active catalog the launch never sends the person to a staged one");
  await still(browser);
  assert.deepEqual(await routedRoles(browser), expectedRoutes(document, (active.result as Configuration).selection ?? selection),
    "The active catalog, not the staged one, routes the profile");
  // The staged catalog still waits where it is reviewed: More and its Models item say so, and so does the launch while it is pointed.
  await until(browser, "More says a staged catalog waits", `${more}?.hasAttribute('data-staged') === true`);
  assert.deepEqual(await stagedMarks(), { ...unmarked, more: true, moreSays: true, models: true, modelsSays: true },
    "A staged model list beside the active one marks More and its Models item, and no other item");
  await pointOf(browser, launchButton);
  await until(browser, "the pointed launch says a staged catalog waits in Models", `${readout}.hasAttribute('data-staged')`);
  await pointAway(browser);
}

/**
 * A Code model list of the person's own, pasted into Models' import on a first-use workspace (real input: the paste is
 * CDP's text insertion into the field). What is not a list is said so and cannot be staged. An edit of the bundled preview,
 * which the import would replace, holds it until the edit is discarded in the dialog. A list is staged by the one
 * explicit press, which initializes the absent workspace at the revision the panel read and stages once; nothing is
 * verified or put in use until use staged list, which reviews the staged list at its revision and promotes exactly that
 * review. A competing first save made meanwhile is never overwritten: the panel's configuration reads are held so it
 * stages against the absent workspace it last read, and the real server refuses that initialization. An import whose own
 * initialization succeeds and whose stage is then refused leaves the bundled preview on that initialization, never a
 * change made elsewhere.
 */
async function importedCatalogScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant): Promise<void> {
  const document: CatalogDocument = { schemaVersion: 1, models: ([1, 2, 3, 4] as const).map(tier => ({
    key: `entry-model-tier-${tier}`, provider: "anthropic", id: `entry-native-tier-${tier}`, api: "anthropic-messages",
    tier, quotaBucket: null, inputCostPerMillion: tier, outputCostPerMillion: tier * 3,
    tokensPerSecond: 30, timeToFirstTokenMs: 100, contextWindow: 200_000,
    thinkingLevels: ["minimal", "low", "medium", "high"], images: true,
  })) };
  const dialog = element(`${modelsSheet} dialog`);
  const field = element(`${modelsSheet} dialog textarea[aria-label="model list JSON"]`);
  const stageButton = element(`${modelsSheet} dialog [data-stage]`);
  const importSays = `${element(`${modelsSheet} .${G}models-import-error[role="status"]`)}.textContent`;
  const discardEdit = `[...document.querySelectorAll('${modelsSheet} dialog .${G}go-fix')].find(el => el.textContent.trim() === 'discard edit')`;
  const absent = { configuration: null, legacyMachineId: null, revision: 0 };
  const deployments = await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 });
  const trace = await watchActions(browser, server);
  const writes = (from: number) => trace.requests.slice(from).filter(request => /^atyrode\.code\.(initializeConfiguration|stageCatalog|reviewCatalog|promoteCatalog|discardCatalog|select)$/.test(request.name));
  const reviews: ActionResult<"reviewCatalog">[] = [];
  let holdReads = false, refuseStage = false;
  /** The revisions the panel's configuration reads are answered with, while they are watched. */
  let readsAnswered: number[] | null = null;
  const held = new Set<() => void>();
  const fixture = await intercept(browser, server, async (name, input) => {
    if (name === "atyrode.code.readConfiguration" && holdReads) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const release = () => { held.delete(release); resolve(); };
      held.add(release);
      await promise;
      return undefined;
    }
    if (name === "atyrode.code.readConfiguration" && readsAnswered) {
      const outcome = await callAction(server, writer.token, name, input);
      if (!outcome.ok) return { ok: false, denial: outcome.denial };
      readsAnswered.push((outcome.result as ActionResult<"readConfiguration">).revision);
      return { ok: true, result: outcome.result };
    }
    // A stage refused after its own initialization, as one too large for the record would be.
    if (name === "atyrode.code.stageCatalog" && refuseStage) return refused("synthetic_stage_refused");
    if (name !== "atyrode.code.reviewCatalog") return undefined;
    // The real server reviews; its answer is kept to check the promotion that follows names exactly that review.
    const outcome = await callAction(server, writer.token, name, input);
    if (!outcome.ok) return { ok: false, denial: outcome.denial };
    reviews.push(outcome.result as ActionResult<"reviewCatalog">);
    return { ok: true, result: outcome.result };
  });
  try {
    for (const mode of ["imported", "competing", "refused"] as const) {
      const workspace = await createContainer(server, mode === "competing" ? "Concurrent first list" : mode === "refused" ? "Refused first stage" : "Imported first list", "canvas");
      const target = { containerId: workspace.id };
      await openGenerator(browser, server, workspace.id);
      await usableStarter(browser);
      // The first import is made over an edit of the bundled preview, which it would replace: the dialog holds it until the
      // edit is discarded there.
      const edited = mode === "imported";
      if (edited) {
        const advisor = await browser.evaluate<string>(`[...${row("advisor")}.querySelectorAll('.${G}word')].find(el => el.dataset.off === undefined && el.dataset.selected === undefined).dataset.key`);
        await choose(browser, "advisor", advisor);
      }
      await openSheet(browser, "models");
      const from = trace.requests.length;
      await click(browser, element(`${modelsSheet} [data-cue="import"]`));
      await until(browser, "import opens from the head as a modal dialog with focus in its field", `${dialog}?.open && ${dialog}.matches(':modal') && document.activeElement === ${field}`);
      await browser.send("Input.insertText", { text: '{ "schemaVersion": 1, "models": [' });
      await until(browser, "what is not a Code model list is said so, and stage refuses", `${importSays} === 'not a Code model list' && ${stageButton}.getAttribute('aria-disabled') === 'true'`);
      await click(browser, stageButton);
      await Bun.sleep(300);
      assert.deepEqual(writes(from), [], "A list that does not parse stages nothing");
      // The refused press left focus on stage; the person goes back into the field and replaces what they pasted.
      await click(browser, field);
      await key(browser, "a", 65, { modifiers: CTRL });
      await browser.send("Input.insertText", { text: JSON.stringify(document) });
      if (edited) {
        await until(browser, "the edited preview holds the import, which says so with discard edit beside stage",
          `${importSays} === 'Your unsaved edit is on the bundled starter, and an import replaces that list. Discard edit drops the edit.' && ${stageButton}.getAttribute('aria-disabled') === 'true' && !!${discardEdit}`);
        await click(browser, stageButton);
        await Bun.sleep(300);
        assert.deepEqual(writes(from), [], "A held import stages nothing");
        await click(browser, discardEdit);
      }
      await until(browser, "a Code model list can be staged", `${importSays} === '' && !${stageButton}.hasAttribute('aria-disabled') && ${field}.value === ${JSON.stringify(JSON.stringify(document))}`);
      assert.deepEqual(await readConfiguration(server, writer, target), absent, "Pasting a list writes nothing");
      if (mode === "refused") {
        refuseStage = true;
        readsAnswered = [];
        await click(browser, stageButton);
        await until(browser, "a stage refused after the import's own initialization is said in the dialog, which stays open",
          `${dialog}.open && ${importSays} !== '' && ${importSays} !== 'not a Code model list' && ${stageButton}.getAttribute('aria-busy') === null`);
        refuseStage = false;
        assert.deepEqual(writes(from), [
          { name: "atyrode.code.initializeConfiguration", input: { ...target, expectedRevision: 0 } },
          { name: "atyrode.code.stageCatalog", input: { ...target, expectedRevision: 1, document } },
        ], "The import initializes the absent workspace once, then stages once from that initialization");
        const after = await readConfiguration(server, writer, target);
        assert.deepEqual([after.revision, after.configuration?.draft], [1, null], "The initialization stands and nothing is staged");
        // Once the panel has read its own initialization, the preview rests on it: verifying is refused for what the fixture
        // lacks, never as a change made elsewhere with theirs to use.
        await waitFor(() => readsAnswered!.includes(1), timeout, 50);
        await Bun.sleep(300);
        readsAnswered = null;
        const verifyLine = await browser.evaluate<{ refused: boolean; parts: [string, string | null][]; fixes: string[] }>(
          `({ refused: ${goIs(modelsSheet, "verify models", "refused")}, parts: ${goParts(modelsSheet)}, fixes: ${goFixes(modelsSheet)} })`);
        assert(verifyLine.refused && !verifyLine.parts.some(([text]) => text === "The workspace profile changed elsewhere") && !verifyLine.fixes.includes("use theirs"),
          `The panel's own initialization is no conflict: ${JSON.stringify(verifyLine)}`);
        await key(browser, "Escape", 27);
        await until(browser, "Esc closes the import, and the sheet stays open", `!${dialog}.open && ${element(stage)}.hidden === true`);
        await closeSheet(browser);
        continue;
      }
      if (mode === "competing") {
        holdReads = true;
        const initialized = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { ...target, expectedRevision: 0 });
        assert(initialized.ok);
        await click(browser, stageButton);
        await until(browser, "staging against the absent workspace the panel read is refused, and said in the dialog, which stays open",
          `${dialog}.open && ${importSays} !== '' && ${importSays} !== 'not a Code model list' && ${stageButton}.getAttribute('aria-busy') === null`);
        assert.deepEqual(writes(from), [{ name: "atyrode.code.initializeConfiguration", input: { ...target, expectedRevision: 0 } }],
          "The import initializes at the revision the panel read and stages nothing once that is refused");
        const after = await readConfiguration(server, writer, target);
        assert.equal(after.revision, 1, "A stale first import does not overwrite a competing initialization");
        assert.equal(after.configuration?.draft, null, "A refused import stages nothing");
        holdReads = false;
        for (const release of [...held]) release();
        await key(browser, "Escape", 27);
        await until(browser, "Esc closes the import, and the sheet stays open", `!${dialog}.open && ${element(stage)}.hidden === true`);
        await closeSheet(browser);
        continue;
      }
      await click(browser, stageButton);
      await until(browser, "the staged list waits with nothing in use, use staged list its one next action",
        `!${dialog}.open && ${element(modelsSheet)}.dataset.phase === 'staged' && ${goIs(modelsSheet, "use staged list")}`);
      const staged = await readConfiguration(server, writer, target);
      assert.deepEqual(writes(from), [
        { name: "atyrode.code.initializeConfiguration", input: { ...target, expectedRevision: 0 } },
        { name: "atyrode.code.stageCatalog", input: { ...target, expectedRevision: 1, document } },
      ], "One explicit stage initializes the absent workspace once and stages the pasted list once");
      assert.equal(staged.revision, 2);
      assert.equal(staged.configuration?.active, null, "Staging puts nothing in use");
      assert.deepEqual(staged.configuration?.draft?.document, document);
      assert.equal(staged.configuration?.draft?.provenance, null, "An imported list is not verified");
      assert.deepEqual(await browser.evaluate(modelList), listOf(document), "Models shows the staged list, each rung on its model");
      const using = trace.requests.length;
      await click(browser, element(`${modelsSheet} [data-go]`));
      await until(browser, "use staged list puts it in use, unverified, and says so",
        `${element(modelsSheet)}.dataset.phase !== 'staged' && ${sheetState(modelsSheet)} === '4 models · unverified' &&
        ${sheetSays(modelsSheet)} === 'in use · the staged list replaced the one in use; verify it next'`);
      const review = reviews.at(-1);
      assert(review, "The real server reviewed the staged list");
      assert.equal(review.catalogDigest, staged.configuration?.draft?.digest, "The review is of exactly the staged list");
      assert.deepEqual(writes(using), [
        { name: "atyrode.code.reviewCatalog", input: { ...target, expectedRevision: 2, source: "draft" } },
        { name: "atyrode.code.promoteCatalog", input: { ...target, expectedRevision: 2, source: "draft", reviewDigest: review.reviewDigest } },
      ], "Use staged list reviews the staged list at the revision shown, then promotes exactly that review");
      const promoted = await readConfiguration(server, writer, target);
      assert.equal(promoted.revision, 3);
      assert.deepEqual(promoted.configuration?.active?.document, document, "Promotion puts exactly the reviewed list in use");
      assert.equal(promoted.configuration?.active?.provenance, null, "A list put in use without a verification is unverified");
      assert.equal(promoted.configuration?.draft, null);
      await closeSheet(browser);
      await until(browser, "the list in use routes the profile in the main view",
        `[...document.querySelectorAll(${JSON.stringify(`${routeRows} .${G}tok-alias`)})].some(el => el.textContent.startsWith('entry-model-tier-'))`);
      // An imported list is unverified; verifying it needs native discovery the fixture does not have.
      await until(browser, "missing native runtime still prevents launch after importing a list", launchIs("verify models", "refused"));
    }
    fixture.check();
  } finally {
    holdReads = false;
    for (const release of [...held]) release();
    await fixture.stop();
    trace.stop();
  }
  assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), deployments,
    "Importing a first list and a refused competing import never approve native access");
}

/** Delay or refuse configuration transport only; successful reads still come from
 * the real server. These checks establish browser recovery, not native readiness. */
async function configurationRecoveryScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, firstUse: { containerId: string }, configured: Target): Promise<void> {
  // The workspace the last scenario left open still reads its own configuration; it is closed before the fixture
  // starts answering, so every read the fixture sees is one of the two workspaces this scenario opens.
  await browser.goto("about:blank");
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
    // Each sheet is reached from More before the configuration arrives, and More's menu keeps its order after it.
    for (const [sheet, next] of [["models", "setup"], ["setup", "options"]] as const) {
      holdConfiguration = true;
      await openGenerator(browser, server, firstUse.containerId);
      await waitFor(() => held.size > 0, timeout, 50);
      await control(browser, "More remains reachable before configuration arrives", more, false);
      await openMenu(browser);
      await click(browser, menuItem(SHEETS[sheet].item));
      await until(browser, `${sheet} opens over the stage`, `${element(stage)}.hidden === true && document.activeElement?.getAttribute('aria-label') === 'Back to Code'`);
      holdConfiguration = false;
      for (const release of [...held]) release();
      await until(browser, "the absent configuration fills the hidden stage", `${element(stage)}.hidden === true && ${row("thinking")} !== null`);
      assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(modal)}) === null`), true,
        "A first-use review in a hidden frame must not make the visible document inert");
      await click(browser, `${visibleSheet}.querySelector('[aria-label="Back to Code"]')`);
      await until(browser, "the sheet returns focus to More, which opened it", `${element(stage)}.hidden === false && document.activeElement === ${more}`);
      await key(browser, "ArrowDown", 40);
      await until(browser, "↓ on More opens its menu on its first item", `document.activeElement === ${menuItems}[0]`);
      for (let step = 0; step < MENU.indexOf(SHEETS[next].item); step++) await key(browser, "ArrowDown", 40);
      assert.equal(await browser.evaluate(`document.activeElement === ${menuItem(SHEETS[next].item)}`), true, "Keyboard navigation still walks More's items after the absent read");
      await key(browser, "Enter", 13);
      await until(browser, `keyboard opens ${next}`, `${element(stage)}.hidden === true && document.activeElement?.getAttribute('aria-label') === 'Back to Code'`);
      await key(browser, "Escape", 27);
      await until(browser, "Esc returns from the sheet to More", `${element(stage)}.hidden === false && document.activeElement === ${more}`);
      await usableStarter(browser);
      assert.equal(await browser.evaluate(`${element(modal)} === null`), true, "The first-use main view does not open an automatic review");
      // A review opens only from Setup's next action, the fix of the row it points at; closing it approves nothing.
      await openSheet(browser, "setup");
      await until(browser, "Setup points at its first unready row, whose fix is a review", `document.querySelectorAll('${setupSheet} [data-row][data-next]').length === 1 &&
        /^(review|enable) /.test(${element(`${setupSheet} [data-go] .${G}go-label`)}?.textContent ?? '')`);
      const fixLabel = await browser.evaluate<string>(`${element(`${setupSheet} [data-go] .${G}go-label`)}.textContent`);
      await click(browser, element(`${setupSheet} [data-go]`));
      await until(browser, "the next action opens its native review, titled for it", `${element(modal)} !== null && ${element(modal)}.getClientRects().length > 0 &&
        ${element(modal)}.querySelector('h2').textContent === ${JSON.stringify(`Review: ${fixLabel}`)}`);
      await until(browser, "review offers one selection control per capability", `${element(modal)}.querySelectorAll('[data-code-capability] input[type="checkbox"]').length === 7`);
      await key(browser, "Escape", 27);
      // Setup gives focus back to its next action in the frame after the review closes (setup-sheet.tsx `onClose`).
      await until(browser, "the review closes normally, and Escape returns focus to Setup's next action",
        `${element(modal)} === null && document.activeElement === ${element(`${setupSheet} [data-go]`)}`);
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

/**
 * Setup on the first destination of the shared workspace, its readiness synthetic: OMP is first absent there (the
 * destination refuses as OMP does where it is not installed), then answers with the connection, discovery, sessions and
 * folder operations made ready one fix at a time, and the folders' job history is empty until a check matching the
 * machine's current pins is listed. Every fix is reviewed at its native owner: the permission reviews are the real ones
 * and approve nothing, and OMP's folder job is refused. The classifier is the instance owner's: an owner-class identity is
 * minted for it alone, the machine's service runtime is reported connected, its review is the real server's and its
 * configuration is refused. Nothing changes the workspace's Code choices or native approvals.
 */
async function setupSheetScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, target: Target, second: Target): Promise<void> {
  const saved = await readConfiguration(server, writer, target);
  assert(saved.configuration?.active);
  // The bundled list's own OMP version, which the facts name; under protocol 57 it is the SDK catalog's, not OMP_VERSION.
  const catalog = await callAction(server, writer.token, "atyrode.omp.readModelCatalog", { providers: starterProviders });
  assert(catalog.ok, "The pinned OMP bundle supplies its passive model metadata");
  const bundledVersion = ModelCatalogSnapshotSchema.parse(catalog.result).ompVersion;
  const deployments = await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 });
  const packed = JSON.parse(readFileSync(join(ompBundleDirectory, "atyrode.omp.manifold-plugin.json"), "utf8")) as {
    manifest: { machine: { operations: Record<string, unknown> } };
  };
  const operations = [INVENTORY_OPERATION_ID, BENCHMARK_OPERATION_ID, LAUNCH_OPERATION_ID, HARNESS_OPERATION_ID, VALIDATE_WORKSPACE_OPERATION_ID, PREPARE_WORKSPACE_OPERATION_ID];
  for (const operationId of operations) assert(packed.manifest.machine.operations[operationId], "Synthetic readiness names real upstream operations");
  // The pins `probeJob` carries, so a listed folder job matches the machine's current operation, installation and bindings.
  const pins = { installationRevision: "synthetic-ui-only", artifactSha256: "c".repeat(64), resourceBindingDigest: "d".repeat(64) };
  const reviewDigest = "a".repeat(64);
  let ompHere = true, connected = false;
  const ready = new Set<string>();
  const folderJobs: PublicJob[] = [];
  const folderReviews: Record<string, unknown>[] = [], prepared: Record<string, unknown>[] = [], unrelated: string[] = [];
  const serviceReviews: { input: Record<string, unknown>; result: ActionResult<"reviewServices"> }[] = [], configured: Record<string, unknown>[] = [];
  let owner: TokenGrant | null = null;
  const fixture = await intercept(browser, server, async (name, input) => {
    if (["engine.jobs.applyDeployment", "engine.jobs.execute", "atyrode.omp.gateway.configureGateway", "atyrode.omp.accounts.promoteAccountRuntime"].includes(name)) {
      unrelated.push(name);
      return refused("synthetic_ui_never_approves_native_access");
    }
    switch (name) {
      case "atyrode.omp.accounts.accounts": return { ok: true, result: fixtureAccounts() };
      case "atyrode.omp.describeDestination": {
        if (input.containerId !== target.containerId || input.machineId !== target.machineId) return undefined;
        if (!ompHere) return refused("omp_operation_unavailable");
        const result: OmpResult<"describeDestination"> = { ...target, pluginId: "atyrode.omp", state: "ready", reason: null, deployment: null,
          services: [{ serviceId: "omp", state: connected ? "ready" : "missing", reason: connected ? null : "synthetic_ui_only" }],
          operations: operations.map(operationId => ({ operationId, pins, nativeReady: ready.has(operationId), callerRefusal: null,
            state: ready.has(operationId) ? "ready" : "approval_required", reason: ready.has(operationId) ? null : "native_consent_required" })) };
        return { ok: true, result };
      }
      case "engine.jobs.listRuns": {
        if (input.pluginId !== "atyrode.omp" || input.machineId !== target.machineId) return undefined;
        return { ok: true, result: { runs: folderJobs.filter(job => job.operationId === input.operationId).map(job => ({ job, occurrence: null })), nextCursor: null } };
      }
      case "atyrode.omp.reviewWorkspace": {
        folderReviews.push(input);
        const operationId = input.mode === "create" ? PREPARE_WORKSPACE_OPERATION_ID : VALIDATE_WORKSPACE_OPERATION_ID;
        assert(ready.has(operationId), "Only a folder route its permission allows is reviewed for a job");
        const result: OmpResult<"reviewWorkspace"> = { destination: target, operationId, pins, reviewDigest };
        return { ok: true, result };
      }
      case "atyrode.omp.prepareWorkspace": {
        assert.deepEqual(input, { ...target, mode: input.mode, reviewDigest }, "Preparation keeps the exact native destination, mode and review");
        prepared.push(input);
        return refused("synthetic_folder_execution_refused");
      }
      case "atyrode.code.readServiceConfiguration": {
        // The machine's service runtime is reported connected; the configuration itself is the real server's.
        assert(owner, "Only the instance owner reads the classifier's policy");
        const outcome = await callAction(server, owner.token, name, input);
        return outcome.ok ? { ok: true, result: { ...outcome.result as object, connected: true } } : { ok: false, denial: outcome.denial };
      }
      case "atyrode.code.reviewServices": {
        assert(owner, "Only the instance owner reviews the classifier's policy");
        const outcome = await callAction(server, owner.token, name, input);
        if (!outcome.ok) return { ok: false, denial: outcome.denial };
        serviceReviews.push({ input, result: outcome.result as ActionResult<"reviewServices"> });
        return { ok: true, result: outcome.result };
      }
      case "atyrode.code.configureServices": configured.push(input); return refused("synthetic_service_configuration_refused");
      default: return undefined;
    }
  });
  const go = element(`${setupSheet} [data-go]`);
  const rows = `Object.fromEntries([...document.querySelectorAll('${setupSheet} li[data-row]')].map(row => [row.dataset.row, [row.dataset.state, row.querySelector('.${G}setup-st').textContent]]))`;
  const pointed = `[...document.querySelectorAll('${setupSheet} li[data-row][data-next]')].map(row => row.dataset.row)`;
  const rowsAre = (expected: Record<string, readonly [string, string]>, next: string | null) =>
    `JSON.stringify(${rows}) === ${JSON.stringify(JSON.stringify(expected))} && JSON.stringify(${pointed}) === ${JSON.stringify(JSON.stringify(next ? [next] : []))}`;
  const folderWord = (route: "existing" | "create") => element(`${setupSheet} [role="radiogroup"][aria-label="folders"] [data-word="${route}"]`);
  const permissionDialog = "dialog.plugin-atyrode_code__permission-dialog[open]";
  const plan = `JSON.parse(${element(`${permissionDialog} [aria-label="Typed headless permission plan"] pre`)}?.textContent ?? 'null')?.result`;
  /** Back to the stage and Setup again, which reads everything once: what a person sees after a fix lands elsewhere. */
  const reread = async () => {
    await closeSheet(browser);
    await openSheet(browser, "setup");
  };
  /** The next action is a review: it opens the real native review titled for it, choosing what its row needs and requesting
   * exactly those operations; Esc closes it onto the next action, approving nothing. */
  const review = async (label: string, chosen: readonly string[], operationIds: readonly (readonly string[])[]) => {
    await until(browser, `the next action is ${label}`, goIs(setupSheet, label));
    await click(browser, go);
    await until(browser, `${label} opens its native review, modal and titled for it`,
      `!!${element(permissionDialog)}?.matches(':modal') && ${element(`${permissionDialog} h2`)}?.textContent === ${JSON.stringify(`Review: ${label}`)}`);
    await until(browser, `the review for ${label} chooses what its row needs and requests exactly its operations`,
      `JSON.stringify([...document.querySelectorAll('${permissionDialog} [data-code-capability] input:checked')].map(el => el.closest('[data-code-capability]').dataset.codeCapability).sort()) === ${JSON.stringify(JSON.stringify([...chosen].sort()))} &&
      JSON.stringify(${plan}?.steps.map(step => step.request.operationIds)) === ${JSON.stringify(JSON.stringify(operationIds))}`);
    await key(browser, "Escape", 27);
    await until(browser, "Esc closes the review and gives focus back to the next action", `${element(permissionDialog)} === null && document.activeElement === ${go}`);
  };
  try {
    await arrangeWorkbench(server, writer);
    // The destination is chosen while OMP answers there: neither the machine list nor a fresh page starts on a machine
    // that refuses OMP. OMP then goes absent under the open panel, and Setup, which reads everything as it opens, says so.
    await openGenerator(browser, server, target.containerId);
    await chooseMachine(browser, target.machineId, machineName);
    ompHere = false;

    // OMP absent here: its row says so, the rows that depend on it say they need it rather than claiming a state, and the
    // next action is the other machine, where OMP answers.
    await openFromMore(browser, "setup");
    const needsOmp = ["unknown", "needs omp"] as const;
    await until(browser, "Setup points at OMP, absent here, with the other machine as its fix",
      `${rowsAre({ machine: ["ok", "online"], omp: ["todo", `not on ${machineName}`], connection: needsOmp, discovery: needsOmp, sessions: needsOmp, folders: needsOmp }, "omp")} &&
      ${goIs(setupSheet, `use ${secondName}`)}`);
    assert.deepEqual(await browser.evaluate(`({ state: ${sheetState(setupSheet)}, parts: ${goParts(setupSheet)} })`),
      { state: `${machineName} · 1 to fix`, parts: [[`OMP isn't on ${machineName}`, "attention"]] }, "The head counts one fix, and the next action says why");
    await click(browser, go);
    await until(browser, "the fix moves Setup to the other machine", `${element(`${setupSheet} select[aria-label="machine"]`)}?.value === ${JSON.stringify(second.machineId)} &&
      ${sheetState(setupSheet)}.startsWith(${JSON.stringify(`${secondName} · `)})`);
    await selectDestination(browser, `${setupSheet} select[aria-label="machine"]`, target.machineId);
    await until(browser, "the machine row's select moves Setup back, by keyboard", `${sheetState(setupSheet)}.startsWith(${JSON.stringify(`${machineName} · `)})`);

    // OMP answers: every row has a state of its own, and the connection is the first fix due.
    ompHere = true;
    await reread();
    await until(browser, "with OMP here the connection is pointed, every row stating its own state",
      rowsAre({ machine: ["ok", "online"], omp: ["ok", "ready"], connection: ["todo", "review needed"], discovery: ["todo", "off"], sessions: ["todo", "off"], folders: ["todo", "not prepared"] }, "connection"));
    assert.deepEqual(await browser.evaluate(`({ state: ${sheetState(setupSheet)}, parts: ${goParts(setupSheet)} })`),
      { state: `${machineName} · 4 to fix`, parts: [[`on ${machineName}`, null]] });
    // The profile's facts beside the checklist: the revision read, the list in use (a way to Models), its source and the workspace.
    const facts = await browser.evaluate<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll('${setupSheet} .${G}setup-facts dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]))`);
    assert.deepEqual({ ...facts, models: facts.models?.split(" · ")[0] }, {
      revision: String(saved.revision), models: `${listOf(saved.configuration.active.document).length} in use`, source: `stored list · OMP ${bundledVersion} bundled list`, workspace: target.containerId,
    }, "The facts state the revision read, the list in use, its source and the workspace");
    // The classifier is the instance owner's: for a writer it says so, its reason in the readout.
    await tabTo(browser, "the classifier's state", element(`${setupSheet} .${G}setup-classifier .${G}setup-st[tabindex]`));
    await until(browser, "the classifier says why a writer cannot configure it", `${sheetSays(setupSheet)} === 'classifier · Only the instance owner configures the classifier.' &&
      document.activeElement.textContent === 'owner only'`);
    // The rows are one Tab stop after the machine, ↑ and ↓ walk them, and each says what it means in the readout. The stop
    // is the row the walk last left (choosing the machine above went through it), so a press on OMP's value starts the walk.
    assert.equal(await browser.evaluate(`document.querySelectorAll('${setupSheet} [data-roving][tabindex="0"]').length`), 1, "The checklist's values are one Tab stop");
    await tabTo(browser, "the checklist's Tab stop", element(`${setupSheet} [data-roving][tabindex="0"]`), true);
    await click(browser, element(`${setupSheet} li[data-row="omp"] [data-roving]`));
    // A resting pointer would keep the readout on what it points at; the walk's readouts are the keyboard's.
    await pointAway(browser);
    await until(browser, "a press on OMP's value makes it the checklist's one Tab stop", `document.activeElement.closest('li[data-row]')?.dataset.row === 'omp' &&
      document.activeElement.tabIndex === 0 && document.querySelectorAll('${setupSheet} [data-roving][tabindex="0"]').length === 1`);
    for (const [name, code, row, says] of [
      ["ArrowDown", 40, "connection", "connection · the model gateway connects OMP to your account broker; it moves no credentials and starts no request"],
      ["ArrowDown", 40, "discovery", "discovery · lets Code read the models your accounts reach and measure them; verifying models needs it"],
      ["ArrowUp", 38, "connection", null], ["ArrowUp", 38, "omp", `omp · OMP answers on ${machineName}`], ["ArrowUp", 38, "machine", null],
    ] as const) {
      await key(browser, name, code);
      await until(browser, `${name} moves to the ${row} row${says ? ", which says what it means" : ""}`, `document.activeElement.closest('li[data-row]')?.dataset.row === '${row}' &&
        ${row === "machine" ? `document.activeElement.matches('select')` : `document.activeElement.matches('[data-roving][tabindex="0"]')`}${says ? ` && ${sheetSays(setupSheet)} === ${JSON.stringify(says)}` : ""}`);
    }
    await sheetZeroShift(browser, setupSheet, "Setup checklist");
    await sheetGeometry(browser, setupSheet, "Setup checklist");
    await sheetCoarseTargets(browser, setupSheet, "Setup checklist");
    // Under reduced motion Setup coming in, a folder route chosen and its native review opening animate nothing.
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    try {
      await still(browser);
      await reread();
      await sheetStill(browser, "Setup coming in");
      await click(browser, folderWord("create"));
      await sheetStill(browser, "choosing a folder route");
      await click(browser, folderWord("existing"));
      await click(browser, go);
      await until(browser, "the native review opens", `!!${element(permissionDialog)}`);
      await sheetStill(browser, "the native review opening");
      await key(browser, "Escape", 27);
      await until(browser, "Esc closes the review", `${element(permissionDialog)} === null`);
    } finally {
      await browser.send("Emulation.setEmulatedMedia", { features: [] });
    }

    // Each fix in turn: the connection, discovery (with the benchmark it needs), sessions, then the folders by either route.
    await review("review connection", ["gateway"], [[GATEWAY_OPERATION_ID]]);
    connected = true;
    await reread();
    await until(browser, "with the connection ready discovery is pointed", `${element(`${setupSheet} li[data-row="connection"]`)}?.dataset.state === 'ok' && JSON.stringify(${pointed}) === '["discovery"]'`);
    await review("enable discovery", ["benchmark", "discovery"], [[INVENTORY_OPERATION_ID, BENCHMARK_OPERATION_ID]]);
    ready.add(INVENTORY_OPERATION_ID).add(BENCHMARK_OPERATION_ID);
    await reread();
    await until(browser, "with discovery on sessions are pointed", `JSON.stringify(${pointed}) === '["sessions"]'`);
    // Sessions need both of OMP's terminals: the reviewed session's launch, and the harness an agent run's live dials come through.
    await review("enable sessions", ["session"], [[LAUNCH_OPERATION_ID, HARNESS_OPERATION_ID]]);
    ready.add(LAUNCH_OPERATION_ID).add(HARNESS_OPERATION_ID);
    await reread();
    await until(browser, "with sessions on the folders are pointed, on the existing route", `JSON.stringify(${pointed}) === '["folders"]' && ${folderWord("existing")}?.getAttribute('aria-checked') === 'true'`);
    await review("enable folder check", ["workspace-existing"], [[VALIDATE_WORKSPACE_OPERATION_ID]]);
    await click(browser, folderWord("create"));
    await review("enable folder creation", ["workspace-create"], [[PREPARE_WORKSPACE_OPERATION_ID]]);
    // The route's words take ← and → as well, focus following the choice.
    await click(browser, folderWord("create"));
    await key(browser, "ArrowLeft", 37);
    await until(browser, "← chooses the existing route", `${folderWord("existing")}.getAttribute('aria-checked') === 'true' && document.activeElement === ${folderWord("existing")} && ${goIs(setupSheet, "enable folder check")}`);
    await key(browser, "ArrowRight", 39);
    await until(browser, "→ chooses the new route", `${folderWord("create")}.getAttribute('aria-checked') === 'true' && document.activeElement === ${folderWord("create")} && ${goIs(setupSheet, "enable folder creation")}`);

    // Both routes allowed: each runs OMP's folder job as the next action, which the fixture refuses, and the refusal is said.
    ready.add(VALIDATE_WORKSPACE_OPERATION_ID).add(PREPARE_WORKSPACE_OPERATION_ID);
    await reread();
    for (const [route, label, mode] of [["create", "create folders", "create"], ["existing", "check folders", "validate"]] as const) {
      await click(browser, folderWord(route));
      await until(browser, `the allowed route's job is the next action: ${label}`, goIs(setupSheet, label));
      const before = prepared.length;
      await click(browser, go);
      await waitFor(() => prepared.length === before + 1, timeout, 50);
      await until(browser, `the refused ${mode} job is said beside the next action`,
        `${goIs(setupSheet, label)} && JSON.stringify(${goParts(setupSheet)}) === ${JSON.stringify(JSON.stringify([["refused", "attention"], [`on ${machineName}`, null]]))}`);
    }
    assert.deepEqual(folderReviews, [{ ...target, mode: "create" }, { ...target, mode: "validate" }], "Each folder job is reviewed at OMP for its exact route");
    assert.deepEqual(prepared.map(input => input.mode), ["create", "validate"]);

    // A folder check matching the machine's current pins: every row is ready, nothing is pointed, and the next action goes back to Code.
    folderJobs.push(probeJob(target, "synthetic-folder-check", VALIDATE_WORKSPACE_OPERATION_ID, writer.principal.id));
    await reread();
    await until(browser, "with every row ready nothing is pointed and the next action is back to code",
      `${rowsAre({ machine: ["ok", "online"], omp: ["ok", "ready"], connection: ["ok", "ready"], discovery: ["ok", "on"], sessions: ["ok", "on"], folders: ["ok", "ready"] }, null)} &&
      ${goIs(setupSheet, "back to code")} && ${sheetState(setupSheet)} === ${JSON.stringify(`${machineName} · ready`)}`);
    assert.deepEqual(await browser.evaluate(goParts(setupSheet)), [[`ready on ${machineName}`, "done"]]);
    await click(browser, go);
    await until(browser, "back to code returns to the stage", `${element(stage)}.hidden === false`);

    // The classifier, as the instance owner: off, then an Ollama origin and model, reviewed at the real server, then applied,
    // which the fixture refuses. Only the applying press would configure anything.
    owner = await mintToken(server, { principal: { kind: "human", name: "Code owner", color: "#669933" }, caps: ["*"] });
    await arrangeWorkbench(server, owner);
    await browser.evaluate(identity(owner));
    try {
      await openGenerator(browser, server, target.containerId);
      await chooseMachine(browser, target.machineId, machineName);
      await openFromMore(browser, "setup");
      const suggestions = (word: "off" | "ollama") => element(`${setupSheet} [role="radiogroup"][aria-label="suggestions"] [data-word="${word}"]`);
      await until(browser, "the owner's Setup is ready, the classifier off", `${goIs(setupSheet, "back to code")} && ${suggestions("off")}?.getAttribute('aria-checked') === 'true'`);
      await click(browser, suggestions("ollama"));
      const origin = "http://127.0.0.1:11434", modelName = "qwen3:8b";
      await click(browser, element(`${setupSheet} .${G}setup-fields input[type="url"]`));
      await browser.typeText(origin);
      await click(browser, element(`${setupSheet} .${G}setup-fields input[type="text"]`));
      await browser.typeText(modelName);
      await until(browser, "a changed classifier is the next action, reviewed before anything applies",
        `${goIs(setupSheet, "review classifier")} && JSON.stringify(${goParts(setupSheet)}) === ${JSON.stringify(JSON.stringify([["classifier changed", "strong"], ["not applied", null]]))}`);
      assert.deepEqual([serviceReviews.length, configured.length], [0, 0], "Drafting a classifier reviews and configures nothing");
      await click(browser, go);
      await until(browser, "the reviewed policy is shown, and applying it is the next action", `${goIs(setupSheet, "apply classifier")} &&
        ${element(`${setupSheet} .${G}setup-policy`)}?.textContent === ${JSON.stringify(`policy: task descriptions to ${origin} · ${modelName} · OMP and its accounts unchanged`)}`);
      assert.deepEqual(serviceReviews.map(entry => entry.input), [{ ...target, expectedServiceRevision: null, classifier: { origin, model: modelName } }],
        "The real server reviews exactly the drafted classifier at the service revision read");
      assert.deepEqual(configured, [], "A review applies nothing");
      await click(browser, go);
      await waitFor(() => configured.length === 1, timeout, 50);
      assert.deepEqual(configured[0], { ...serviceReviews[0]!.input, reviewDigest: serviceReviews[0]!.result.reviewDigest }, "Applying configures exactly the reviewed policy");
      await until(browser, "the refused configuration is said beside the next action",
        `${goIs(setupSheet, "apply classifier")} && JSON.stringify(${goParts(setupSheet)}) === ${JSON.stringify(JSON.stringify([["refused", "attention"], ["policy reviewed", "strong"]]))}`);
      const services = await callAction(server, owner.token, "atyrode.code.readServiceConfiguration", target);
      assert(services.ok);
      assert.deepEqual((services.result as ActionResult<"readServiceConfiguration">).configuration, { revision: null, policies: [] }, "Nothing configured the classifier");
      await closeSheet(browser);
    } finally {
      await browser.evaluate(identity(writer));
    }
    assert.deepEqual(unrelated, [], "Setup never requests unrelated native approval or configuration");
    fixture.check();
  } finally {
    await fixture.stop();
  }
  assert.deepEqual(await readConfiguration(server, writer, target), saved, "Setup's fixes and the classifier never change the workspace's Code choices");
  assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), deployments,
    "Synthetic readiness is not native approval evidence and creates no deployments");
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
  const reviewsFor = (count: number) => async () => reviews.length >= count;
  try {
    await arrangeWorkbench(server, writer);
    // One recent profile, so a digit pressed where the panel's keys must not act would recall it.
    const savedAdvisor = saved.configuration.selection.advisor;
    await rememberTeam(browser, writer.principal.id, first.containerId, { ...saved.configuration.selection, advisor: savedAdvisor === "off" ? "glance" : "off" });
    await openGenerator(browser, server, first.containerId);
    await chooseMachine(browser, first.machineId, machineName);

    // The saved profile reviews itself once its inputs settle, so Launch is one press.
    await until(browser, "the saved profile is reviewed without a press", launchIs("launch", "ready"));
    assert.equal(reviews.length, 1, "One automatic review of the settled saved profile");
    assert.equal(reviews[0]!.skills, undefined, "An ordinary launch carries no skill choice");
    // Pointed, the launch says where the profile was reviewed and the reviewed pool by family.
    await pointOf(browser, launchButton);
    // A writer who saved automatic plans launches the reviewed session, so the readout says why it will have no live dials.
    await until(browser, "the launch's readout says where it was reviewed, its pool by family and why it has no live dials",
      `${readout}.textContent.includes(${JSON.stringify(machineName)}) && /Claude \\d+/.test(${readout}.textContent) && ${readout}.textContent.includes('no live dials: auto plans are on')`);
    await pointAway(browser);

    // Skills: a set and an individual choice review as one effective selection.
    await openOptions(browser);
    await click(browser, optionSwitch("Optional skills", "Reviewed pair"));
    await click(browser, optionSwitch("Optional skills", "Alpha"));
    await waitFor(reviewsFor(2), timeout, 50);
    await until(browser, "overlapping skill selection is native-reviewed", `${launchIs("launch", "ready")} && document.querySelectorAll('${generator} [aria-label="Selected optional skills"] li').length > 0`);
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('${generator} [aria-label="Selected optional skills"] li .${G}options-skill-title')].map(el => el.textContent)`),
      ["Alpha", "Gamma"], "A set and individual choice render one effective selection without duplicates");
    await closeOptions(browser);
    await focusLaunch(browser);
    await key(browser, "Enter", 13);
    await until(browser, "the refused preparation is said beside the launch", `${failureLine} && ${launchIs("review", "ready")}`);
    assert.equal(prepareRequests, 1);
    assert.equal(await browser.evaluate(`document.activeElement === ${launchButton}`), true, "The launch keeps focus through its press and its refusal");
    await until(browser, "the refusal is announced", `${liveRegion}.textContent !== '' && ${lineText}.includes(${liveRegion}.textContent)`);
    // Outcome and refusal lines clear on any change to the profile.
    await focusRow(browser, "thinking");
    const savedThinking = await browser.evaluate<string>(chosenKey("thinking"));
    await key(browser, "ArrowLeft", 37);
    await until(browser, "a profile change clears the refusal", `!${failureLine}`);
    await key(browser, "ArrowRight", 39);
    await until(browser, "the saved profile is back without a draft", `${chosenKey("thinking")} === ${JSON.stringify(savedThinking)} && !${revertButton}`);

    // A declared conflict, a stale catalog and a cleared choice; disable-all reviews as such.
    await openOptions(browser);
    await click(browser, optionSwitch("Optional skills", "Beta"));
    await until(browser, "a declared skill conflict refuses the step", `${launchButton}.dataset.state === 'refused' && !!${fix("skills")}`);
    await click(browser, optionSwitch("Optional skills", "Beta"));
    await until(browser, "resolving the conflict restores the step", `${launchButton}.dataset.state === 'ready'`);
    skillCatalog.revision++;
    await click(browser, workspaceButton("read skills again"));
    await until(browser, "a stale catalog cannot silently rebase the selection", `${launchButton}.dataset.state === 'refused'`);
    await click(browser, workspaceButton("default skills"));
    await until(browser, "a cleared choice can be reviewed again", `${launchButton}.dataset.state === 'ready'`);
    const beforeDisable = reviews.length;
    await click(browser, workspaceButton("all skills off"));
    await waitFor(reviewsFor(beforeDisable + 1), timeout, 50);
    await until(browser, "disable-all is reviewed", launchIs("launch", "ready"));
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
    await click(browser, launchButton);
    await until(browser, "restricted preparation refusal is visible", `${failureLine} && ${launchIs("review", "ready")}`);
    await openOptions(browser);
    const beforeTool = reviews.length;
    await turn(browser, readTool, false);
    await waitFor(reviewsFor(beforeTool + 1), timeout, 50);
    assert.deepEqual((reviews.at(-1)!.automation as { toolNames: string[] }).toolNames, [], "A tool change is reviewed again, never launched on the old review");
    await turn(browser, restricted, false);
    await closeOptions(browser);
    await until(browser, "the ordinary session is reviewed", launchIs("launch", "ready"));

    // A machine without permission refuses; returning reviews afresh, never resurrecting the old review.
    const reviewsBeforeSecond = reviews.length, preparations = prepareRequests;
    await chooseMachine(browser, second.machineId, secondName);
    await until(browser, "the second destination cannot launch", `${launchButton}.dataset.state === 'refused' && !!${fix("permissions")}`);
    await Bun.sleep(1_200);
    assert.equal(reviews.length, reviewsBeforeSecond, "Choosing an unprepared machine requests no review");
    assert.equal(prepareRequests, preparations, "Destination selection never prepares a launch");
    await chooseMachine(browser, first.machineId, machineName);
    await waitFor(reviewsFor(reviewsBeforeSecond + 1), timeout, 50);
    await until(browser, "returning reviews afresh", launchIs("launch", "ready"));

    // While a review is in flight no profile or machine edit lands, and the focused row keeps focus.
    holdNextReview = true;
    await openOptions(browser);
    await click(browser, workspaceButton("all skills off"));
    await closeOptions(browser);
    await waitFor(() => heldReview.held, timeout, 50);
    await until(browser, "the launch says the review runs", launchIs("reviewing…", "busy"));
    await focusRow(browser, "advisor");
    const settings = await browser.evaluate<string>(profileValues);
    const announced = await browser.evaluate<string>(`${liveRegion}.textContent`);
    await key(browser, "ArrowLeft", 37);
    await key(browser, "Home", 36);
    await until(browser, "the refused edits say why", `${liveRegion}.textContent !== ${JSON.stringify(announced)}`);
    await key(browser, "w", 87);
    await Bun.sleep(300);
    assert.deepEqual(await browser.evaluate(`({ settings: ${profileValues}, machine: ${machinePicker}.textContent, list: ${machineList} !== null })`),
      { settings, machine: machineName, list: false }, "No profile or machine edit lands while a review runs");
    await focusRow(browser, "advisor");
    heldReview.release();
    await until(browser, "the held review completes for the unchanged profile", launchIs("launch", "ready"));
    assert.equal(await browser.evaluate(`!!${row("advisor")}.contains(document.activeElement)`), true, "Keyboard focus stays on its row through the gate");
    await click(browser, launchButton);
    await until(browser, "launch refusal is shown and consumes its review", `${failureLine} && ${launchIs("review", "ready")}`);
    await openOptions(browser);
    await click(browser, workspaceButton("default skills"));
    await closeOptions(browser);
    // The cleared choice is reviewed on its own, so no review is still due when the steps below are counted.
    await until(browser, "the cleared choice is reviewed", launchIs("launch", "ready"));

    // The sessions view: saved sessions are read per machine; only an exact terminal correlation is a running row.
    // A Read button goes as its read starts; focus follows the read to the machine's first row verb, never out of the panel.
    await showView(browser, "sessions");
    await tabTo(browser, "the first machine's Read", element(`${generator} [data-read="${first.machineId}"]`));
    await key(browser, "Enter", 13);
    await until(browser, "the first machine's saved session is listed and its Resume takes focus",
      `${savedRow(first.machineId)} !== null && document.activeElement === ${rowVerb(first.machineId, "resume")}`);

    // One row per folder, each showing its newest session; the folder's older sessions are in that row's drum, never behind a count.
    const firstRows = `[...document.querySelectorAll('${generator} [data-kind="saved"][data-machine-id="${first.machineId}"]')]`;
    assert.deepEqual(await browser.evaluate(`${firstRows}.map(row => row.dataset.sessionId)`), [savedSessionId, otherFolder.id], "One row per folder, each showing its newest session");
    assert.equal(await browser.evaluate(`${savedRow(first.machineId)}.querySelectorAll('[role="option"]').length`), folderSessions.length, "Every session of the folder is in its row's drum");
    assert.equal(await browser.evaluate(`[...document.querySelectorAll('${generator} [data-pane="sessions"] button')].some(el => /\\b(show|more)\\b/i.test(el.textContent))`), false,
      "No count toggle hides saved sessions");
    // The machine is said once, by its group's head, with its read's age and a quiet read again.
    const firstRead = element(`${generator} [data-read-state="read"][data-machine-id="${first.machineId}"]`);
    assert.deepEqual(await browser.evaluate(`({ heads: [...document.querySelectorAll('${generator} .${G}earlier-machine')].filter(el => el.textContent === ${JSON.stringify(machineName)}).length,
      named: ${firstRead}?.closest('li')?.querySelector('.${G}earlier-machine')?.textContent, again: !!${firstRead}?.querySelector('[data-read="${first.machineId}"]') })`),
      { heads: 1, named: machineName, again: true }, "A read machine's head names it once, with its read and a way to read it again");
    const resumeName = await browser.evaluate<string>(`${rowVerb(first.machineId, "resume")}.getAttribute('aria-label')`);
    const withName = await browser.evaluate<string>(`${rowVerb(first.machineId, "resume-with-team")}.getAttribute('aria-label')`);
    assert(resumeName.includes(folderSessions[0]!.title) && withName.includes(folderSessions[0]!.title) && resumeName !== withName,
      "Each resume names its session, and the two resumes name themselves apart");

    // The drum answers ↓/↑ by turning the shown session, and ↵ opens the folder's list as a popover that owns its keys:
    // from it a digit recalls no profile and Mod+↵ takes no step.
    const folderRow = `${firstRows}[0]`;
    const drum = `${folderRow}?.querySelector('[role="listbox"]')`;
    await tabTo(browser, "the folder's session drum", drum, true);
    await key(browser, "ArrowDown", 40);
    await until(browser, "↓ shows the folder's next older session", `${folderRow}?.dataset.sessionId === ${JSON.stringify(folderSessions[1]!.id)} && document.activeElement === ${drum}`);
    await key(browser, "ArrowUp", 38);
    await until(browser, "↑ shows the newest again", `${folderRow}?.dataset.sessionId === ${JSON.stringify(savedSessionId)} && document.activeElement === ${drum}`);
    await key(browser, "Enter", 13);
    await until(browser, "↵ opens the folder's sessions as a popover", `${drum}?.dataset.open === 'true' && ${drum}.dataset.popover !== undefined`);
    const team = await browser.evaluate<string>(profileValues), steps = { prepares: prepareRequests, reviews: reviews.length };
    for (const [name, code] of [["1", 49], ["e", 69], ["a", 65]] as const) await key(browser, name, code);
    await Bun.sleep(300);
    assert.deepEqual(await browser.evaluate(`({ team: ${profileValues}, sessions: ${shownView("sessions")} })`), { team, sessions: true },
      "A digit or a view key pressed in the open session drum recalls no profile and changes no view");
    await key(browser, "Enter", 13, { modifiers: CTRL });
    await Bun.sleep(300);
    assert.deepEqual({ prepares: prepareRequests, reviews: reviews.length }, steps, "Mod+↵ in the open session drum takes no step");
    assert.equal(await browser.evaluate(profileValues), team);
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
    await key(browser, "r", 82);
    await waitFor(() => heldList.held, timeout, 50);
    assert(firstReads > readsBefore, "The refresh reads the machine again");
    await until(browser, "a machine read again keeps its rows while it reads",
      `${element(`${generator} [data-read-state="reading"][data-machine-id="${first.machineId}"]`)} !== null && ${savedRow(first.machineId)} !== null`);
    heldList.release();
    await until(browser, "the read again lands", `${firstRead} !== null && ${savedRow(first.machineId)} !== null`);
    // What a sighted person sees of a resume: the sessions view's own line, shown in a real box (never screen-reader-only
    // text), warm, saying the refusal's own words; and the rows where they were, since the line sits on the view's head.
    const saidLine = element(`${generator} [data-pane="sessions"] [data-session-said]`);
    const sessionSays = (words: string) => `(() => {
      const el = ${saidLine};
      if (!el || el.closest('.plugin-atyrode_code__sr') || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1 && el.dataset.tone === 'warn' && el.textContent !== '' && el.textContent === ${words};
    })()`;
    // The refusal a resume came to, as the workbench model said it: the words of the (hidden) launch line's failure.
    const modelSaid = `document.querySelector(${JSON.stringify(`${generator} .${G}launch-part[data-tone="attention"]`)})?.textContent`;
    const rowTops = `(() => {
      const pane = document.querySelector('${generator} [data-pane="sessions"]'), top = pane.getBoundingClientRect().top;
      return [...pane.querySelectorAll('.${G}earlier-group, .${G}earlier-rows > li')].map(el => Math.round((el.getBoundingClientRect().top - top) * 2) / 2);
    })()`;
    // A refusal's words must move no row at any width either: each width's rows are measured with the line still empty.
    const saidWidths = [1280, 620, 360, 320] as const;
    assert.equal(await browser.evaluate(`${saidLine}.textContent`), "", "The view's line is empty before its first verb");
    const emptyTops = new Map<number, number[]>();
    for (const width of saidWidths) {
      await panelWidth(browser, width);
      emptyTops.set(width, await browser.evaluate<number[]>(rowTops));
    }
    await browser.send("Emulation.clearDeviceMetricsOverride", {});
    await settle(browser);
    const tops = await browser.evaluate<number[]>(rowTops);
    const quiet = await browser.evaluate<string>(`${liveRegion}.textContent`);
    await click(browser, rowVerb(first.machineId, "resume"));
    await waitFor(() => resumedInputs.length === 1, timeout, 50);
    await until(browser, "the saved-state refusal is said aloud and on the sessions view's own line, in the model's words",
      `${sessionSays(modelSaid)} && ${liveRegion}.textContent !== ${JSON.stringify(quiet)}`);
    assert.deepEqual(await browser.evaluate<number[]>(rowTops), tops, "A resume and its refusal move no row of the sessions view");
    assert.deepEqual(resumedInputs[0], { machineId: first.machineId, sessionId: savedSessionId }, "Preserve resume must not silently inject a profile");
    await until(browser, "automatic plans refuse resuming with this profile before native resume",
      `${rowVerb(first.machineId, "resume-with-team")}?.getAttribute('aria-disabled') === 'true'`);
    await click(browser, rowVerb(first.machineId, "resume-with-team"));
    // The press already names the row, so the line says the reason alone and its start shows at every width.
    const reason = await browser.evaluate<string>(`${rowVerb(first.machineId, "resume-with-team")}.title`);
    await until(browser, "the refused row verb says why, on the view's own line and aloud",
      `${sessionSays(JSON.stringify(reason))} && ${liveRegion}.textContent === ${saidLine}.textContent`);
    assert.deepEqual(await browser.evaluate<number[]>(rowTops), tops, "A refused verb's words move no row of the sessions view");
    for (const width of saidWidths) {
      await panelWidth(browser, width);
      assert.deepEqual(await browser.evaluate(`(() => {
        const rect = ${saidLine}.getBoundingClientRect();
        return { words: ${saidLine}.textContent === ${JSON.stringify(reason)}, height: Math.round(rect.height), wide: rect.width >= 120 };
      })()`), { words: true, height: 20, wide: true }, `At ${width}px the refusal's reason starts the view's one 20px line`);
      assert.deepEqual(await browser.evaluate<number[]>(rowTops), emptyTops.get(width), `At ${width}px a refusal's words move no row of the sessions view`);
    }
    // Cut, the line is a Tab stop whose focus or tap lays its whole words over the rows, inside the panel, moving nothing.
    const wholeSaid = element(`${generator} [data-pane="sessions"] .${G}earlier-said-whole`);
    const wholeShows = `(() => {
      const el = ${wholeSaid};
      if (!el?.checkVisibility()) return false;
      const panel = document.querySelector('${generator}').getBoundingClientRect(), rect = el.getBoundingClientRect();
      return el.textContent === ${JSON.stringify(reason)} && rect.left >= panel.left - 0.5 && rect.right <= panel.right + 0.5 && rect.top >= ${saidLine}.getBoundingClientRect().bottom - 0.5;
    })()`;
    for (const width of [360, 320] as const) {
      await panelWidth(browser, width);
      assert.equal(await browser.evaluate(`${saidLine}.dataset.cut !== undefined && ${saidLine}.tabIndex === 0 && !${wholeSaid}.checkVisibility()`), true,
        `At ${width}px the cut line is a Tab stop, its whole words put away`);
    }
    await tabTo(browser, "the cut line, a Tab stop before the rows", saidLine, true);
    await until(browser, "focused, the cut line lays its whole words over the rows", wholeShows);
    assert.deepEqual(await browser.evaluate<number[]>(rowTops), emptyTops.get(320), "The whole words move no row");
    await key(browser, "Escape", 27);
    await until(browser, "Esc puts the whole words away and leaves the sessions view on show",
      `!${wholeSaid}.checkVisibility() && ${shownView("sessions")} && document.activeElement === ${saidLine}`);
    await panelWidth(browser, 360);
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    try {
      // A coarse pointer gives the verbs their 44px, so the rows the tap must not move are measured under it.
      await settle(browser);
      const coarseTops = await browser.evaluate<number[]>(rowTops);
      await tap(browser, element(`${generator} [data-pane="sessions"] .${G}title`));
      await until(browser, "a tap elsewhere leaves the line", `document.activeElement !== ${saidLine}`);
      await tap(browser, saidLine);
      await until(browser, "a tap on the cut line lays its whole words over the rows", wholeShows);
      assert.deepEqual(await browser.evaluate<number[]>(rowTops), coarseTops, "The whole words move no row under a tap");
      await tap(browser, element(`${generator} [data-pane="sessions"] .${G}title`));
      await until(browser, "a tap elsewhere puts them away", `!${wholeSaid}.checkVisibility()`);
    } finally {
      await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await browser.send("Emulation.clearDeviceMetricsOverride", {});
    }
    assert.equal(resumedInputs.length, 1, "Unsupported profile policy must not be silently dropped");
    assert.deepEqual(await readConfiguration(server, writer, first), saved, "Native observations and refusals never change saved choices");

    // Save the profile without automatic plans; the save changes only that choice.
    await showView(browser, "main");
    await openOptions(browser);
    await turn(browser, autoPlans, false);
    await closeOptions(browser);
    await until(browser, "the edit saves before its review", launchIs("save & review", "ready"));
    const beforeSave = reviews.length;
    await click(browser, launchButton);
    await waitFor(async () => (await readConfiguration(server, writer, first)).revision === saved.revision + 1, timeout, 50);
    await waitFor(reviewsFor(beforeSave + 1), timeout, 50);
    const supported = await readConfiguration(server, writer, first);
    assert(supported.configuration);
    assert.deepEqual(supported, { ...saved, revision: saved.revision + 1, configuration: {
      ...saved.configuration, revision: saved.configuration!.revision + 1,
      updatedAt: supported.configuration.updatedAt, updatedBy: supported.configuration.updatedBy,
      selection: { ...saved.configuration!.selection, planYolo: false },
    } }, "The explicit profile save changes only its chosen policy and revision metadata");
    saved = supported;
    await until(browser, "Save & review goes on to its review", launchIs("launch", "ready"));
    await openOptions(browser);
    await turn(browser, restricted, true);
    await turn(browser, readTool, true);
    await closeOptions(browser);
    await showView(browser, "sessions");
    await until(browser, "resuming with this profile is allowed", `${rowVerb(first.machineId, "resume-with-team")}?.getAttribute('aria-disabled') !== 'true'`);
    await waitFor(async () => JSON.stringify(reviews.at(-1)?.automation) === JSON.stringify({ mode: "restricted", toolNames: ["read"], delegation: "disabled" }), timeout, 50);
    await click(browser, rowVerb(first.machineId, "resume-with-team"));
    await waitFor(() => resumedInputs.length === 2, timeout, 50);
    await until(browser, "explicit profile resume refusal is said on the sessions view's own line", sessionSays(modelSaid));
    const explicit = ResumeSessionInputSchema.parse(resumedInputs[1]);
    assert.equal(explicit.machineId, first.machineId);
    assert.equal(explicit.sessionId, savedSessionId);
    assert.deepEqual(explicit.overlay, reviews.at(-1)!.overlay);
    assert.deepEqual(explicit.accountPool, reviews.at(-1)!.accountPool);
    assert.deepEqual(explicit.automation, { mode: "restricted", toolNames: ["read"], delegation: "disabled" });
    assert(explicit.overrides?.model && explicit.overrides.thinking && explicit.overlay?.modelRoles?.default);
    assert.equal(explicit.overrides.model, explicit.overlay.modelRoles.default);
    assert.equal(explicit.overrides.thinking, explicit.overrides.model.split(":").at(-1));

    // While a resume runs, the launch's machine cannot change under it.
    holdNextList = true;
    await click(browser, rowVerb(first.machineId, "resume"));
    await waitFor(() => heldList.held, timeout, 50);
    await showView(browser, "main");
    await focusRow(browser, "lane");
    await key(browser, "w", 87);
    await Bun.sleep(200);
    assert.deepEqual(await browser.evaluate(`({ machine: ${machinePicker}.textContent, list: ${machineList} !== null })`), { machine: machineName, list: false },
      "No machine edit lands while a resume runs");
    heldList.release();
    await waitFor(() => resumedInputs.length === 3, timeout, 50);
    await until(browser, "the held resume's refusal is visible", failureLine);

    // An offline machine's read is no longer offered, and an offline destination stays the launch's machine with its fix.
    await chooseMachine(browser, second.machineId, secondName);
    fleetMachines.find(machine => machine.id === second.machineId)!.online = false;
    await key(browser, "r", 82);
    await until(browser, "an offline destination is kept as the launch's machine, not replaced, with the other machine as its fix",
      `${machinePicker}.textContent === ${JSON.stringify(secondName)} && ${launchButton}.dataset.state === 'refused' && !!${fix("machine")}`);
    await showView(browser, "sessions");
    await until(browser, "an offline machine's read is no longer offered",
      `${element(`${generator} [data-read-state="offline"][data-machine-id="${second.machineId}"]`)} !== null && ${savedRow(second.machineId)} === null`);
    await showView(browser, "main");
    await click(browser, fix("machine"));
    await until(browser, "the fix moves the launch to the online machine", `${machinePicker}.textContent === ${JSON.stringify(machineName)}`);
    fleetMachines.find(machine => machine.id === second.machineId)!.online = true;
    await key(browser, "r", 82);
    await showView(browser, "sessions");

    // An unreadable terminal inventory refuses resume; so does a session its machine no longer lists.
    // Each resume re-reads the machine first, so a refusal is awaited past that read.
    const resumeRefused = async (description: string) => {
      const reads = firstReads;
      await click(browser, rowVerb(first.machineId, "resume"));
      await waitFor(() => firstReads > reads, timeout, 50);
      await until(browser, description, `${rowVerb(first.machineId, "resume")}?.getAttribute('aria-busy') !== 'true' && ${launchButton}.dataset.state !== 'busy' && ${sessionSays(`${saidLine}.textContent`)}`);
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
    await until(browser, "public terminal URI resolves back to the authoritative home", `location.pathname === ${JSON.stringify(`/p/${first.containerId}`)} && ${launchButton} !== null`);
    await showView(browser, "sessions");
    await until(browser, "the exact running terminal is offered to open", `${runningRow("synthetic-exact")}?.querySelector('[data-verb="open"]') != null`);
    const navigationCount = navigations.filter(url => new URL(url).pathname === terminalRoute).length;
    await click(browser, `${runningRow("synthetic-exact")}.querySelector('[data-verb="open"]')`);
    await waitFor(() => navigations.filter(url => new URL(url).pathname === terminalRoute).length > navigationCount, timeout, 50);
    assert.equal(resumedInputs.length, 3, "Explicit open never prepares a replacement");
    assert.deepEqual(await ownerAction(server, "core.terminals.listAll", {}), realTerminals, "Session actions never create a terminal");
    fixture.check();
  } finally {
    heldReview.release();
    heldList.release();
    offNavigations();
    await fixture.stop();
  }
  assert.deepEqual(await readConfiguration(server, writer, first), saved, "Synthetic observations never change real saved choices");
}

// ---------------------------------------------------------------- an agent launch and the Runs it starts

/**
 * A launch as an Agent Run through Manifold's real doors, then Runs this fixture cannot start, read from fixtures shaped
 * on that real Agent's and Run's own reads. A human sponsor who may delegate presses the launch once: Code registers its
 * Agent and creates a Run at the real server, whose `launchRun` this machine refuses for want of a native job owner; Code
 * cancels the Run and the launch says why. With OMP's harness not ready the same press is the reviewed session, and the
 * pointed launch says it has no live dials and why. In Sessions, synthetic Runs say their activity, their lease up to 24
 * of 24 and detached; a synthetic `controlRun` takes their dials through pending, confirmed, clamped, not served,
 * unanswered and sent again, and refused. ←→ settle before sending, ↵ and Space send at once, ↑↓ cross dials; a pointed
 * word, lease or activity says itself and moves nothing; reduced motion stills every mark; nothing overflows from 170 to
 * 1440px. No terminal opens and no provider is asked; a live Run, its renewals and its TUI remain unexercised here.
 */
async function agentLaunchScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, destination: Target): Promise<void> {
  const workspace = await createContainer(server, "Agent launch", "canvas");
  const target: Target = { containerId: workspace.id, machineId: destination.machineId };
  const sponsor = await mintToken(server, { principal: { kind: "human", name: "Code sponsor", color: "#339966" },
    caps: ["containers:read", "containers:write", "machines:read", "machines:run", "jobs:read", "services:read", "agents:delegate"] });
  // The sponsor's profile: four published anthropic models without minimal thinking, verified as the workflow records it.
  const created = await callAction(server, sponsor.token, "atyrode.code.initializeConfiguration", { containerId: workspace.id, expectedRevision: 0 });
  assert(created.ok, "A sponsor initializes its workspace's Code profile");
  const bundled = await callAction(server, sponsor.token, "atyrode.omp.readModelCatalog", { providers: starterProviders });
  assert(bundled.ok);
  const metadata = ModelCatalogSnapshotSchema.parse(bundled.result);
  const published = metadata.models.filter(model => model.provider === "anthropic").sort((left, right) => left.inputCostPerMillion - right.inputCostPerMillion).slice(0, 4);
  assert.equal(published.length, 4, "The pinned OMP publishes four anthropic models for the sponsor's tiers");
  // Short keys, as a person names their models, so the Run tokens read like the generator's own.
  const keys = ["luna", "sol", "terra", "fable"];
  const document = { schemaVersion: 1, models: published.map((model, index) => ({
    key: keys[index]!, provider: "anthropic", id: model.id, api: model.api, tier: index + 1,
    quotaBucket: null, inputCostPerMillion: index + 1, outputCostPerMillion: (index + 1) * 3, tokensPerSecond: 30,
    timeToFirstTokenMs: 100, contextWindow: 200_000, thinkingLevels: ["low", "medium", "high", "xhigh", "max"], images: true,
  })) };
  const observation = fixtureAccounts();
  const initialRevision = (created.result as Configuration).revision;
  const probe = await callAction(server, sponsor.token, "atyrode.code.composeProbe", { containerId: workspace.id, expectedRevision: initialRevision, accounts: observation });
  assert(probe.ok, "Code composes the sponsor's pool from the passive observation");
  const staged = await callAction(server, sponsor.token, "atyrode.code.stageCatalog", { containerId: workspace.id, expectedRevision: initialRevision, document,
    verification: { ompVersion: OMP_VERSION, inventoryArtifactSha256: pinnedOmpArtifact(), catalogRevision: metadata.revision,
      inventoryObservedAt: Date.now() - 3_000, benchmarkCompletedAt: Date.now() - 2_000,
      accounts: observation, poolIdentityDigest: (probe.result as ActionResult<"composeProbe">).poolIdentityDigest } });
  assert(staged.ok, "The sponsor stages a verified list");
  const reviewInput = { containerId: workspace.id, expectedRevision: (staged.result as Configuration).revision, source: "draft" };
  const reviewedList = await callAction(server, sponsor.token, "atyrode.code.reviewCatalog", reviewInput);
  assert(reviewedList.ok);
  const promoted = await callAction(server, sponsor.token, "atyrode.code.promoteCatalog", { ...reviewInput, reviewDigest: (reviewedList.result as ActionResult<"reviewCatalog">).reviewDigest });
  assert(promoted.ok, "The verified list is in use");
  const saved = promoted.result as Configuration;
  assert.equal(saved.selection?.planYolo, false, "A new profile approves no plan automatically, so an agent run can carry it");
  const compiled = compileCatalog(document as CatalogDocument);
  const aliases = displayAliases(compiled);
  const reference = (index: number) => `anthropic/${published[index]!.id}`;
  const alias = (index: number) => aliases.get(keys[index]!)!;

  const defaults = await callAction(server, sponsor.token, "atyrode.omp.readDefaults", {});
  assert(defaults.ok);
  const defaultsRevision = (defaults.result as OmpResult<"readDefaults">).revision;
  const pins = { installationRevision: "synthetic-ui-only", artifactSha256: "b".repeat(64), resourceBindingDigest: "c".repeat(64) };
  const reviewDigest = "d".repeat(64);
  const realTerminals = await ownerAction(server, "core.terminals.listAll", {});
  let harnessReady = true, prepares = 0;
  // The Runs Sessions reads once the real launch has been refused: null leaves every core.access door and the terminal inventory to the real server.
  let runs: { list: () => ListRunsV2Result; inspect: (runId: string) => InspectRunV2Result | null; terminals: TerminalSummary[] } | null = null;
  const controls: Record<string, unknown>[] = [];
  const heldControl = holdable();
  let control: (input: Record<string, unknown>) => Outcome | Promise<Outcome> = () => refused("synthetic_control_unset");
  const sessions: { id: string; title: string; cwd: string; updatedAt: number }[] = [];
  const fixture = await intercept(browser, server, async (name, input) => {
    if (runs) switch (name) {
      case "core.access.listRunsV2": return { ok: true, result: runs.list() };
      case "core.access.inspectRunV2": {
        const inspection = runs.inspect(input.runId as string);
        return inspection ? { ok: true, result: inspection } : refused("agent_run_unavailable");
      }
      case "core.terminals.listAll": return { ok: true, result: { terminals: runs.terminals } };
      case "atyrode.omp.controlRun": controls.push(input); return control(input);
    }
    switch (name) {
      case "atyrode.omp.accounts.accounts": return { ok: true, result: fixtureAccounts() };
      case "atyrode.omp.describeDestination": {
        if (input.containerId !== target.containerId || input.machineId !== target.machineId) return undefined;
        const operation = (operationId: string, ready: boolean) => ({ operationId, pins, nativeReady: ready, callerRefusal: null,
          state: ready ? "ready" as const : "approval_required" as const, reason: ready ? null : "native_consent_required" });
        const result: OmpResult<"describeDestination"> = { containerId: target.containerId, machineId: target.machineId, pluginId: "atyrode.omp", state: "ready",
          reason: null, deployment: null, services: [], operations: [operation(LAUNCH_OPERATION_ID, true), operation(HARNESS_OPERATION_ID, harnessReady)] };
        return { ok: true, result };
      }
      case "atyrode.omp.readSkillCatalog": return { ok: true, result: { revision: 0, skills: [], sets: [], updatedAt: null, updatedBy: null } };
      case "atyrode.omp.reviewSession":
        return { ok: true, result: { destination: target, operationId: LAUNCH_OPERATION_ID, pins, reviewDigest, defaultsRevision, effectiveOverlay: input.overlay,
          accountPool: input.accountPool, automation: input.automation ?? { mode: "ordinary" }, skills: { mode: "preserve", catalogRevision: null, selected: [] } } };
      case "atyrode.omp.prepareSession": prepares++; return refused("omp_review_changed");
      case "atyrode.omp.listSessions": return { ok: true, result: input.machineId === target.machineId ? sessions : [] };
      default: return undefined;
    }
  });
  const agentName = await codeAgentName(workspace.id);
  const actions = await watchActions(browser, server);
  /** The Run doors the browser called since `from`, reads left out. */
  const runDoors = (from: number) => actions.requests.slice(from).map(request => request.name)
    .filter(name => name.startsWith("core.access.") && !["core.access.listAgentsV2", "core.access.listRunsV2", "core.access.inspectRunV2"].includes(name));
  try {
    await arrangeWorkbench(server, sponsor);
    await browser.evaluate(identity(sponsor));
    await openGenerator(browser, server, workspace.id);
    await chooseMachine(browser, target.machineId, machineName);

    // One press: the real doors register Code's Agent and create its Run; this machine refuses to launch it, Code cancels it,
    // and the same press goes on to the reviewed session, which the fixture refuses at its preparation.
    await until(browser, "the sponsor's saved profile is reviewed without a press", launchIs("launch", "ready"));
    await pointOf(browser, launchButton);
    await until(browser, "pointed, the launch says its dials will be live in Sessions", `${readout}.textContent.includes('live dials in Sessions')`);
    await pointAway(browser);
    const beforeLaunch = actions.requests.length;
    await click(browser, launchButton);
    await waitFor(() => prepares === 1, timeout, 50);
    await until(browser, "the same press goes on to the reviewed session, whose refusal is said beside the launch", failureLine);
    assert.deepEqual(runDoors(beforeLaunch), ["core.access.registerAgentV2", "core.access.createRunV2", "core.access.launchRun", "core.access.finishAgentRunV2"],
      "One press registers the Agent, creates its Run, asks Manifold to launch it and cancels it once refused");
    const agentsRead = await callAction(server, sponsor.token, "core.access.listAgentsV2", {});
    assert(agentsRead.ok);
    const agents = ListAgentsV2ResultSchema.parse(agentsRead.result);
    assert.equal(agents.canRegister, true, "The sponsor may register agents");
    const agent = agents.agents.find(entry => entry.name === agentName);
    assert(agent && agent.harness === "atyrode.omp", "Code's Agent is registered under its workspace's name with OMP's harness");
    const profile = OmpHarnessProfileSchema.parse(agent.context.profile);
    assert.deepEqual([profile.tui, profile.planYolo], [true, false], "Its profile asks for OMP's TUI without automatic plans");
    const runsRead = await callAction(server, sponsor.token, "core.access.listRunsV2", { agentId: agent.agentId });
    assert(runsRead.ok);
    const realRuns = ListRunsV2ResultSchema.parse(runsRead.result);
    assert.deepEqual(realRuns.runs.map(run => [run.state, run.session]), [["cancelled", null]], "The refused Run is cancelled at the real server and never bound a session");
    const inspectRead = await callAction(server, sponsor.token, "core.access.inspectRunV2", { runId: realRuns.runs[0]!.id, limit: 1 });
    assert(inspectRead.ok);
    const realInspection = InspectRunV2ResultSchema.parse(inspectRead.result);
    await showView(browser, "sessions");
    const readsAfter = actions.requests.length;
    await key(browser, "r", 82);
    await waitFor(async () => actions.requests.slice(readsAfter).some(request => request.name === "core.access.listAgentsV2"), timeout, 50);
    await Bun.sleep(500);
    assert.equal(await browser.evaluate(`${element(`${generator} [data-run-id]`)} === null`), true, "A Run cancelled before it launched is not listed");

    // From then on this machine's launch is the reviewed session, and the pointed launch says why it has no live dials.
    await showView(browser, "main");
    await until(browser, "the launch offers its next review", `${launchIs("review", "ready")} || ${launchIs("launch", "ready")}`);
    if (await browser.evaluate<boolean>(launchIs("review", "ready"))) await click(browser, launchButton);
    await until(browser, "the launch is reviewed again", launchIs("launch", "ready"));
    await pointOf(browser, launchButton);
    await until(browser, "pointed, the launch says this machine cannot launch agent runs",
      `${readout}.textContent.includes(${JSON.stringify(`no live dials: ${machineName} cannot launch agent runs`)})`);
    await pointAway(browser);
    const beforeFallback = actions.requests.length;
    await click(browser, launchButton);
    await waitFor(() => prepares === 2, timeout, 50);
    await until(browser, "the reviewed session's refusal is said beside the launch", failureLine);
    assert.deepEqual(runDoors(beforeFallback), [], "A machine that refused a Run gets the reviewed session: no Agent or Run door is called");
    // OMP's harness not ready is said before it.
    harnessReady = false;
    await key(browser, "r", 82);
    await until(browser, "the launch offers its next review", `${launchIs("review", "ready")} || ${launchIs("launch", "ready")}`);
    if (await browser.evaluate<boolean>(launchIs("review", "ready"))) await click(browser, launchButton);
    await until(browser, "the launch is reviewed again", launchIs("launch", "ready"));
    await pointOf(browser, launchButton);
    await until(browser, "pointed, the launch says it has no live dials because the harness is not enabled",
      `${readout}.textContent.includes(${JSON.stringify(`no live dials: not enabled on ${machineName}`)})`);
    await pointAway(browser);

    // Runs this machine cannot start, shaped on the real ones: open, at 24 of 24, renewal due, detached, starting and ended.
    const now = Date.now(), MINUTE = 60_000, HOUR = 60 * MINUTE;
    const launched = runDials(realRuns.runs[0]!.model);
    const lead = reviewCatalog(compiled, saved.selection!, Date.now()).routes.find(route => route.role === "default")!.lead;
    assert.deepEqual(launched, { model: `anthropic/${compiled.model(lead.key).id}`, thinking: lead.thinking }, "The Run records the launch's main-agent model and thinking");
    type ListedRun = ListRunsV2Result["runs"][number];
    type Shape = { id: string; state: ListedRun["state"]; activity: ListedRun["activity"]; age: number; left: number; renewals: number; ended: number | null; tui: boolean; title: string; cwd: string };
    const shapes: Shape[] = [
      { id: "run-working", state: "pending_policy", activity: "working", age: 10 * MINUTE, left: 40 * MINUTE, renewals: 1, ended: null, tui: true, title: "Trace the CAS conflict", cwd: "/home/alex/code-statement/code" },
      { id: "run-blocked", state: "pending_policy", activity: "blocked", age: 4 * HOUR, left: 25 * MINUTE, renewals: 7, ended: null, tui: true, title: "Measure the seat grid", cwd: "/home/alex/manifold" },
      { id: "run-full", state: "pending_policy", activity: "done", age: 12 * HOUR, left: 35 * MINUTE, renewals: 24, ended: null, tui: true, title: "Write the operator brief", cwd: "/srv/notes" },
      { id: "run-detached", state: "expired", activity: "idle", age: 14 * HOUR, left: -25 * MINUTE, renewals: 24, ended: now - 25 * MINUTE, tui: true, title: "Sweep the flaky tests", cwd: "/home/alex/babel" },
      { id: "run-starting", state: "pending_policy", activity: "unknown", age: MINUTE / 2, left: 60 * MINUTE, renewals: 0, ended: null, tui: false, title: "", cwd: "" },
      { id: "run-ended", state: "completed", activity: "done", age: 3 * HOUR, left: -HOUR, renewals: 4, ended: now - 62 * MINUTE, tui: false, title: "Make the settings easier to understand", cwd: "/workspace/example" },
    ];
    const sessionOf = (index: number) => ({ harness: "atyrode.omp", machineId: target.machineId, sessionId: `9cb82ad4-8c9e-4166-8130-47200000000${index}` });
    const fields = (shape: Shape, index: number) => ({ id: shape.id, state: shape.state, activity: shape.activity,
      session: shape.id === "run-starting" ? null : sessionOf(index), createdAt: now - shape.age, expiresAt: now + shape.left });
    sessions.push(...shapes.flatMap((shape, index) => shape.title ? [{ id: sessionOf(index).sessionId, title: shape.title, cwd: shape.cwd, updatedAt: now - shape.age }] : []));
    runs = {
      list: () => ({ ...realRuns, observedAt: Date.now(), runs: shapes.map((shape, index): ListedRun => ({ ...realRuns.runs[0]!, ...fields(shape, index) })) }),
      inspect: runId => {
        const index = shapes.findIndex(shape => shape.id === runId);
        if (index < 0) return null;
        return { ...realInspection, run: { ...realInspection.run, ...fields(shapes[index]!, index), renewals: shapes[index]!.renewals,
          cleanup: { ...realInspection.run.cleanup, finishedAt: shapes[index]!.ended } }, terminals: [], jobs: [] };
      },
      terminals: shapes.flatMap((shape, index) => shape.tui ? [{ id: `tui-${shape.id}`, machineId: target.machineId, name: "OMP", createdAt: now - shape.age,
        status: "running" as const, exitCode: null, homeId: target.containerId, unplaced: false, session: sessionOf(index), cwd: shape.cwd }] : []),
    };
    const runRow = (id: string) => `${generator} [data-run-id="${id}"]`;
    const said = (id: string) => `(${element(`${runRow(id)} .${G}run-said`)}?.textContent ?? '')`;
    const dialWord = (id: string, field: "model" | "thinking", value: string) =>
      element(`${runRow(id)} [data-run-dial][data-row="${field === "model" ? "tier" : "thinking"}"] [role="radio"][data-value="${value}"]`);
    await showView(browser, "sessions");
    await click(browser, element(`${generator} [data-read="${target.machineId}"]`));
    // Manifold announces Run changes on its access topic; these fixtures announce nothing, so once any read already under way
    // has landed, the panel's read again reads them.
    await Bun.sleep(1_000);
    await key(browser, "r", 82);
    const listing = `({ runs: [...document.querySelectorAll('${generator} [data-run-id]')].map(el => el.dataset.runId),
      error: ${element(`${generator} [data-runs-error]`)}?.textContent ?? null })`;
    const order = { runs: ["run-starting", "run-working", "run-blocked", "run-full", "run-detached", "run-ended"], error: null };
    try {
      await waitFor(async () => JSON.stringify(await browser.evaluate(listing)) === JSON.stringify(order), timeout, 50);
    } catch {
      assert.deepEqual(await browser.evaluate(listing), order, "Every Run is listed, open ones first and newest first, the ended one last");
    }
    await until(browser, "each Run is titled from its machine's saved read", `${element(`${runRow("run-working")} .${G}run-name`)}?.textContent === 'Trace the CAS conflict'`);

    // Activity: a mark and a word each; the Sessions tab's one square says the most urgent open Run, beside its word without touching it.
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('${generator} [data-run-id]')].map(el => [el.dataset.runId, el.querySelector('.${G}run-act').textContent, el.querySelector('.${G}run-mark').dataset.a])`), [
      ["run-starting", "starting", "starting"], ["run-working", "working", "working"], ["run-blocked", "blocked", "blocked"],
      ["run-full", "done", "done"], ["run-detached", "detached", "detached"], ["run-ended", "completed", "completed"]], "Each Run says its activity, or its phase once not live");
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('${generator} [data-run-id]')].map(el => [el.dataset.runId, el.querySelector('[data-verb]')?.dataset.verb ?? null, !!el.querySelector('[data-run-dial]')])`), [
      ["run-starting", "cancel", true], ["run-working", "open", true], ["run-blocked", "open", true], ["run-full", "open", true], ["run-detached", "open", true], ["run-ended", "resume", false]],
    "One verb each: cancel before a terminal, open while its TUI runs, resume once settled; dials while open, detached included");
    const tab = element(`${generator} [data-view-tab="sessions"]`);
    assert.deepEqual(await browser.evaluate(`(() => {
      const tab = ${tab}, mark = tab?.querySelector('.${G}tab-mark'), text = document.createRange();
      text.selectNodeContents(tab.firstChild);
      const word = text.getBoundingClientRect(), box = mark.getBoundingClientRect(), bar = tab.closest('.${G}bar').getBoundingClientRect();
      return { marked: tab.dataset.marked !== undefined, a: mark.dataset.a, title: tab.title.startsWith('Sessions: a run waits for you'),
        beside: box.left >= word.right + 2 && box.top >= bar.top && box.bottom <= bar.bottom && box.width === 6 && box.height === 6 };
    })()`), { marked: true, a: "blocked", title: true, beside: true }, "The Sessions tab's square says a Run waits, beside its word and inside the bar");

    // The lease: one block per renewal, the words beside them; 24 of 24 is warm, detached is faint and its dials rest.
    assert.deepEqual(await browser.evaluate(`['run-working', 'run-blocked', 'run-full', 'run-detached'].map(id => [
      document.querySelectorAll('${generator} [data-run-id="' + id + '"] .${G}lease-bar > i[data-on]').length,
      document.querySelector('${generator} [data-run-id="' + id + '"] .${G}lease-bar').dataset.tone ?? null,
      document.querySelector('${generator} [data-run-id="' + id + '"] .${G}lease-words').textContent.replace(/\\d{1,2}:\\d{2}/, 'HH:MM').replace(/\\d+m$/, 'Nm')])`), [
      [1, null, "renews in Nm"], [7, "warn", "renewal due · expires HH:MM"], [24, "warn", "expires HH:MM"], [24, "off", "detached since HH:MM"]],
    "The lease counts renewals of 24 and says when it renews, that a renewal is due, that none is left, or since when it is detached");
    assert.equal(await browser.evaluate(`document.querySelectorAll('${runRow("run-full")} .${G}lease-bar > i').length`), 24, "The bar has one block per renewal Manifold allows");
    assert.deepEqual(await browser.evaluate(`[${element(runRow("run-detached"))}.dataset.locked !== undefined, ${said("run-detached")}.replace(/\\d{1,2}:\\d{2}/, 'HH:MM'),
      ${element(runRow("run-starting"))}.dataset.locked !== undefined, ${said("run-starting")}, ${element(`${runRow("run-ended")} .${G}run-lease`)}?.textContent.replace(/\\d+m /, 'Nm ')]`),
    [true, "dials · off since HH:MM · the TUI goes on", true, "starting · policy pending; no report yet", "1h Nm ago"],
    "A detached Run's dials rest while its TUI goes on; a starting one's wait for its first report; an ended one says when it ended");
    assert.equal(await browser.evaluate(`[...document.querySelectorAll('${generator} [data-locked]')].every(el => el.closest('[data-run-id]'))`), true,
      "Only a Run's own dials are ever locked");
    // A starting or detached Run's dials are shown off, and a press on them sends nothing: a click, ↵, or a rested ←→.
    const beforeLocked = controls.length;
    await click(browser, dialWord("run-starting", "thinking", "high"));
    await click(browser, dialWord("run-detached", "thinking", "high"));
    await key(browser, "ArrowRight", 39);
    await key(browser, "Enter", 13);
    await Bun.sleep(700);
    assert.equal(controls.length, beforeLocked, "A starting or detached Run's dials send nothing");

    // The dials: pending until the session answers, then confirmed; a clamped level; a model not served, struck from then on.
    const thinkingShown = launched.thinking ?? "medium";
    const other = ["low", "medium", "high"].find(level => level !== thinkingShown)!;
    control = async input => {
      await heldControl.wait();
      return { ok: true, result: { model: input.model ?? launched.model, thinking: input.thinking ?? thinkingShown } };
    };
    await click(browser, dialWord("run-working", "thinking", other));
    await waitFor(() => heldControl.held, timeout, 50);
    await until(browser, "the asked-for word waits with its hollow dot, and the said line says what stays meanwhile",
      `${dialWord("run-working", "thinking", other)}.dataset.pending !== undefined && ${said("run-working")} === ${JSON.stringify(`${other} · sent · ${thinkingShown} until it answers`)}`);
    assert.deepEqual(controls.at(-1), { runId: "run-working", thinking: other }, "One press sends one change to the Run");
    // Under reduced motion nothing breathes, not even a change in flight.
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    // A transition already under way when motion is reduced runs out its own duration; after it nothing moves, not even the waiting dot.
    await still(browser);
    assert.equal(await browser.evaluate(running), 0, "Reduced motion: no Run mark or waiting dot animates");
    await browser.send("Emulation.setEmulatedMedia", { features: [] });
    await settle(browser);
    assert((await browser.evaluate<number>(running)) > 0, "Otherwise a working Run's mark and a waiting dot breathe");
    // A press while that change waits is said as next and sent once the answer lands; only the latest such press goes.
    const beforeQueue = controls.length;
    await click(browser, dialWord("run-working", "thinking", "max"));
    await click(browser, dialWord("run-working", "thinking", "xhigh"));
    await until(browser, "a press while one waits is said as next", `${said("run-working")} === ${JSON.stringify(`xhigh · next · once ${other} answers`)}`);
    assert.equal(controls.length, beforeQueue, "Nothing more is sent while a change waits");
    heldControl.release();
    await waitFor(() => controls.length === beforeQueue + 1 && heldControl.held, timeout, 20);
    assert.deepEqual(controls.at(-1), { runId: "run-working", thinking: "xhigh" }, "Once the answer lands, the latest queued press is sent, and only it");
    heldControl.release();
    await until(browser, "the queued change is confirmed", `${dialWord("run-working", "thinking", "xhigh")}.getAttribute('aria-checked') === 'true' && ${said("run-working")} === 'xhigh · running now'`);
    assert.equal(controls.length, beforeQueue + 1, "The earlier queued press is never sent");
    // A Run whose dials lock while a change waits drops the change queued behind it: settled with its TUI going on, it reads
    // detached, the line no longer says next, and once the answer lands nothing more is sent.
    await click(browser, dialWord("run-full", "thinking", other));
    await waitFor(() => heldControl.held, timeout, 50);
    await click(browser, dialWord("run-full", "thinking", "xhigh"));
    await pointAway(browser);
    await until(browser, "a press behind the full Run's change is said as next", `${said("run-full")} === ${JSON.stringify(`xhigh · next · once ${other} answers`)}`);
    const beforeLock = controls.length;
    const full = shapes.findIndex(shape => shape.id === "run-full");
    shapes[full] = { ...shapes[full]!, state: "expired", left: -MINUTE, ended: now - MINUTE };
    await key(browser, "r", 82);
    await until(browser, "the full Run reads detached, its dials locked and its queued change dropped",
      `${element(runRow("run-full"))}.dataset.locked !== undefined && ${said("run-full")}.startsWith(${JSON.stringify(`${other} · sent · `)})`);
    heldControl.release();
    await until(browser, "the full Run's answer lands", `${dialWord("run-full", "thinking", other)}.dataset.pending === undefined`);
    await Bun.sleep(300);
    assert.equal(controls.length, beforeLock, "A queued change is never sent to a Run whose dials locked");
    control = input => ({ ok: true, result: { model: input.model ?? launched.model, thinking: input.thinking === "max" ? "xhigh" : input.thinking ?? other } });
    await click(browser, dialWord("run-working", "thinking", "max"));
    await until(browser, "a level the session clamps is said with the one it runs", `${said("run-working")} === 'max · running now · thinking xhigh' && ${dialWord("run-working", "thinking", "xhigh")}.getAttribute('aria-checked') === 'true'`);
    const unserved = published.findIndex((_, index) => reference(index) !== launched.model);
    control = () => refused("omp_model_unavailable");
    await click(browser, dialWord("run-working", "model", reference(unserved)));
    await until(browser, "a model the session does not serve is struck, and what stays is said",
      `${dialWord("run-working", "model", reference(unserved))}.dataset.off !== undefined && ${said("run-working")}.startsWith(${JSON.stringify(`${alias(unserved)} · not served here · `)})`);
    const sent = controls.length;
    await click(browser, dialWord("run-working", "model", reference(unserved)));
    await Bun.sleep(300);
    assert.equal(controls.length, sent, "A struck model is never sent again");

    // No answer within the door's 20 s: the word stays warm with send again, which sends the same change once more.
    const unanswered = published.findIndex((_, index) => index !== unserved && reference(index) !== launched.model);
    control = () => refused("omp_run_control_unconfirmed");
    await click(browser, dialWord("run-working", "model", reference(unanswered)));
    await until(browser, "an unanswered change is said with send again", `${dialWord("run-working", "model", reference(unanswered))}.dataset.unconfirmed !== undefined &&
      ${said("run-working")} === ${JSON.stringify(`${alias(unanswered)} · no answer in 20 ssend again`)} && !!${element(`${runRow("run-working")} .${G}run-again`)}`);
    // On a coarse pointer send again has a 44px target around it, and the said line keeps its 20px with nothing in it clipped.
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    try {
      await settle(browser);
      assert.deepEqual(await browser.evaluate(`(() => {
        const line = ${element(`${runRow("run-working")} .${G}run-said`)}, again = line.querySelector('.${G}run-again'), text = line.querySelector('.${G}run-said-text');
        const box = line.getBoundingClientRect(), inside = el => { const rect = el.getBoundingClientRect(); return rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5; };
        const target = getComputedStyle(again, '::after');
        return { coarse: matchMedia('(pointer: coarse)').matches, height: Math.round(box.height), text: inside(text), again: inside(again),
          target: Math.round(again.getBoundingClientRect().height) - parseFloat(target.top) - parseFloat(target.bottom), cut: text.scrollWidth > text.clientWidth + 1 };
      })()`), { coarse: true, height: 20, text: true, again: true, target: 44, cut: false }, "Send again's coarse target leaves the said line whole");
    } finally {
      await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
    control = input => ({ ok: true, result: { model: input.model ?? launched.model, thinking: "xhigh" } });
    await click(browser, element(`${runRow("run-working")} .${G}run-again`));
    await until(browser, "sent again, the answer confirms it", `${dialWord("run-working", "model", reference(unanswered))}.getAttribute('aria-checked') === 'true' &&
      ${said("run-working")} === ${JSON.stringify(`${alias(unanswered)} · running now`)}`);
    assert.deepEqual(controls.slice(-2), [{ runId: "run-working", model: reference(unanswered) }, { runId: "run-working", model: reference(unanswered) }], "Send again sends the same change once");

    // Keyboard: ←→ rest half a second before one change goes; ↵ and Space send at once; ↑↓ go to the next dial of any Run.
    control = input => ({ ok: true, result: { model: input.model ?? reference(unanswered), thinking: input.thinking ?? "xhigh" } });
    // A press on the word already shown sends nothing and leaves focus on it.
    const beforeShown = controls.length;
    await click(browser, dialWord("run-working", "thinking", "xhigh"));
    await until(browser, "focus rests on the working Run's shown thinking", `document.activeElement === ${dialWord("run-working", "thinking", "xhigh")}`);
    await Bun.sleep(300);
    assert.equal(controls.length, beforeShown, "A press on the word already shown sends nothing");
    const beforeKeys = controls.length;
    await key(browser, "ArrowLeft", 37);
    await key(browser, "ArrowLeft", 37);
    await key(browser, "ArrowRight", 39);
    const swept = Date.now();
    await Bun.sleep(300);
    assert.equal(controls.length, beforeKeys, "←→ send nothing while they move");
    await waitFor(() => controls.length === beforeKeys + 1, timeout, 20);
    assert(Date.now() - swept >= 400, "The change goes once the keys rest");
    assert.deepEqual(controls.at(-1), { runId: "run-working", thinking: "high" }, "A sweep sends the one word it rests on");
    await until(browser, "the swept level is confirmed", `${dialWord("run-working", "thinking", "high")}.getAttribute('aria-checked') === 'true'`);
    await key(browser, "ArrowLeft", 37);
    await key(browser, "Enter", 13);
    await waitFor(() => controls.length === beforeKeys + 2, 300, 10);
    assert.deepEqual(controls.at(-1), { runId: "run-working", thinking: "medium" }, "↵ sends the focused word at once");
    await until(browser, "the level sent by ↵ is confirmed", `${dialWord("run-working", "thinking", "medium")}.getAttribute('aria-checked') === 'true'`);
    await key(browser, "ArrowRight", 39);
    await key(browser, " ", 32);
    await waitFor(() => controls.length === beforeKeys + 3, 300, 10);
    assert.deepEqual(controls.at(-1), { runId: "run-working", thinking: "high" }, "Space sends the focused word at once");
    await Bun.sleep(700);
    assert.equal(controls.length, beforeKeys + 3, "A word sent at once is not sent again when the keys rest");
    // A press within the half second a ←→ rests cancels it: exactly one change goes, the one pressed.
    const beforeRace = controls.length;
    await key(browser, "ArrowLeft", 37);
    await click(browser, dialWord("run-working", "thinking", "low"));
    await Bun.sleep(900);
    assert.deepEqual(controls.slice(beforeRace), [{ runId: "run-working", thinking: "low" }], "A press after ←→ sends only the pressed word");
    await until(browser, "the pressed level is confirmed", `${dialWord("run-working", "thinking", "low")}.getAttribute('aria-checked') === 'true'`);
    await key(browser, "ArrowDown", 40);
    await until(browser, "↓ goes to the next Run's first dial", `!!document.activeElement?.closest('${runRow("run-blocked")} [data-run-dial][data-row="tier"]')`);
    await key(browser, "ArrowUp", 38);
    await until(browser, "↑ comes back", `!!document.activeElement?.closest('${runRow("run-working")} [data-run-dial][data-row="thinking"]')`);

    // Refused outright: the dials of a Run this caller may not turn rest, and say whose they are.
    control = () => refused("omp_run_control_forbidden");
    await click(browser, dialWord("run-blocked", "thinking", "low"));
    await until(browser, "a forbidden change locks that Run's dials and says whose they are",
      `${element(runRow("run-blocked"))}.dataset.locked !== undefined && ${said("run-blocked")} === "dials · its launcher's or sponsor's alone"`);
    const forbidden = controls.length;
    await click(browser, dialWord("run-blocked", "thinking", "high"));
    await Bun.sleep(300);
    assert.equal(controls.length, forbidden, "Locked dials send nothing");

    // Pointed, a word, the lease and the activity say themselves on the said line, and nothing moves.
    await pointOf(browser, dialWord("run-working", "model", reference(unanswered)));
    await until(browser, "a pointed model says itself", `${said("run-working")} === ${JSON.stringify(`${alias(unanswered)} · ${published[unanswered]!.id} · main agent`)}`);
    await pointOf(browser, element(`${runRow("run-working")} .${G}lease-row .${G}words`));
    await until(browser, "the pointed lease says its next renewal", `/^renewal 2 of 24 · \\d{1,2}:\\d{2} · expires \\d{1,2}:\\d{2}$/.test(${said("run-working")})`);
    await pointOf(browser, element(`${runRow("run-working")} .${G}run-toggle`));
    await until(browser, "the pointed activity says what it means", `${said("run-working")} === 'working · a turn is running'`);
    await pointAway(browser);
    const sessionsPane = `${generator} [data-pane="sessions"]`;
    const runBoxes = boxesOf(sessionsPane, `element.closest('.plugin-atyrode_code__sr') || element.parentElement?.closest('.${G}run-said')`);
    await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    try {
      const targets = await browser.evaluate<number>(`(globalThis.__codeTargets = [...document.querySelectorAll('${sessionsPane} [data-run-id] :is([role="radio"], button, .${G}run-toggle, .${G}lease-row .${G}words)')]
        .filter(el => el.getClientRects().length)).length`);
      assert(targets > 40, "The Runs offer their pointer targets");
      for (let index = 0; index < targets; index++) {
        await pointAway(browser);
        await settle(browser);
        await browser.evaluate(runBoxes);
        await pointOf(browser, `globalThis.__codeTargets[${index}]`);
        await settle(browser);
        assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], `Pointing at Run target ${index} shifts no layout box`);
      }
      await pointAway(browser);
      await tabTo(browser, "the first Run's verb", element(`${runRow("run-starting")} [data-verb]`), true);
      await browser.evaluate(runBoxes);
      let steps = 0;
      for (; steps < 40 && await browser.evaluate<boolean>(`!!document.activeElement?.closest('${sessionsPane} [data-runs]')`); steps++) {
        await key(browser, "Tab", 9);
        await settle(browser);
        assert.deepEqual(await browser.evaluate<string[]>(SHIFTED), [], `Keyboard focus step ${steps} across the Runs shifts no layout box`);
      }
      assert(steps >= 8, `Tab walks the Runs' verbs, dials and send again (${steps} steps)`);
      // The said line starts where the dials' words do, at every layout. No room is kept under the head for the view's own line
      // (it sits on the head's row; the sessions scenario fills it), so the sessions start right under the head.
      for (const width of [1280, 620, 360]) {
        await panelWidth(browser, width);
        assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('${generator} [data-run-id][data-open]')].map(run =>
          Math.round(run.querySelector('.${G}run-said').getBoundingClientRect().left - run.querySelector('[data-run-dial] .${G}words').getBoundingClientRect().left))
          .filter(gap => Math.abs(gap) > 1)`), [], `The said line lines up with the dials' words at ${width}px`);
        assert.deepEqual(await browser.evaluate(`(() => {
          const pane = document.querySelector('${sessionsPane}'), head = pane.querySelector(':scope > .${G}head').getBoundingClientRect();
          return Math.round(pane.querySelector('.${G}earlier-group').getBoundingClientRect().top - head.bottom);
        })()`), 14, `At ${width}px the sessions start 14px under the head`);
      }
      // Under reduced motion every Run mark rests, so each width and view is measured still.
      await geometryAcrossWidths(browser, "agent launch");
    } finally {
      await browser.send("Emulation.setEmulatedMedia", { features: [] });
      await browser.send("Emulation.clearDeviceMetricsOverride", {});
    }
    fixture.check();
  } finally {
    heldControl.release();
    actions.stop();
    await fixture.stop();
    await browser.evaluate(identity(writer));
  }
  const after = await callAction(server, sponsor.token, "core.access.listAgentsV2", {});
  assert(after.ok);
  const agentId = ListAgentsV2ResultSchema.parse(after.result).agents.find(entry => entry.name === agentName)?.agentId;
  const finalRuns = await callAction(server, sponsor.token, "core.access.listRunsV2", { agentId });
  assert(finalRuns.ok);
  assert.deepEqual(ListRunsV2ResultSchema.parse(finalRuns.result).runs.map(run => run.state), ["cancelled"], "Dials, reads and the reviewed launch create no Run");
  assert.deepEqual(await ownerAction(server, "core.terminals.listAll", {}), realTerminals, "Nothing in the agent launch opened a terminal");
  assert.deepEqual((await readConfiguration(server, sponsor, { containerId: workspace.id })).configuration, saved, "Launches and dials never change the saved profile");
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
    phase = "real shared drafts across destinations";
    await sharedWorkbenchScenario(writerBrowser, viewerBrowser, server, writer, viewer, target, secondTarget);
    // The viewer's part is done; one browser is enough from here on.
    await viewerBrowser.close();
    phase = "a writer without a canvas saves and is told why launching waits";
    await canvaslessWriterScenario(writerBrowser, server, writer, target);

    phase = "initial capability checklist without native approval";
    const firstUse = await createContainer(server, "Code first-use permissions", "canvas");
    await arrangeWorkbench(server, writer);
    await openGenerator(writerBrowser, server, firstUse.id);
    await usableStarter(writerBrowser);
    assert.equal(await writerBrowser.evaluate(`${element(permissionDialog)} === null`), true,
      "Bundled starter does not open a permission dialog");
    // Setup points at the first row with a fix due, and that fix is its one next action: the native review of what the row
    // needs. Its choices are requests the person may change, never grants: the existing-folder check chosen alone requests
    // exactly its operation, and nothing is approved.
    await openFromMore(writerBrowser, "setup");
    const setupNext = element(`${setupSheet} [data-go]`);
    await until(writerBrowser, "Setup's next action is a review, and none is open", `/^(review|enable) /.test(${setupNext}?.querySelector('.${G}go-label')?.textContent ?? '') && ${element(permissionDialog)} === null`);
    await click(writerBrowser, setupNext);
    await until(writerBrowser, "initial independent capability checklist", `document.querySelectorAll('${permissionDialog} [data-code-capability] input[type="checkbox"]').length === 7`);
    const requested = await writerBrowser.evaluate<string[]>(`[...document.querySelectorAll('${permissionDialog} [data-code-capability] input:checked')].map(el => el.closest('[data-code-capability]').dataset.codeCapability)`);
    assert(requested.length > 0, "Setup's review chooses what its row needs");
    for (const id of requested) await click(writerBrowser, capability(id));
    await click(writerBrowser, capability("workspace-existing"));
    await until(writerBrowser, "workspace-only request keeps its exact operation", `(() => {
      const text = ${displayedPlan}?.textContent;
      return !!text && JSON.stringify(JSON.parse(text).result.steps.map(step => step.request.operationIds)) === JSON.stringify([["atyrode.omp.validate-workspace"]]);
    })()`);
    await key(writerBrowser, "Escape", 27);
    await until(writerBrowser, "onboarding can defer permission review, and focus returns to the next action", `${element(permissionDialog)} === null && document.activeElement === ${setupNext}`);
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
    phase = "an OMP upgrade alone makes a verified catalog stale";
    await ompUpgradeScenario(writerBrowser, server, writer, target);
    phase = "Models: verify, the charge's hold and deliberate confirm, measuring, left out, staged, imported, discarded and verified again";
    await modelsSheetScenario(writerBrowser, server, writer, target);
    phase = "tiered usage windows are their own rows and judge no pool";
    await tieredUsageScenario(writerBrowser, server, writer);
    phase = "struck leads and the only box say why";
    await leadStruckScenario(writerBrowser, server, writer);
    phase = "an imported first list, a refused competing first import, a refused first stage and the exact review a staged list is used by";
    await importedCatalogScenario(writerBrowser, server, writer);
    phase = "deferred first-use and standalone Usage configuration recovery";
    await configurationRecoveryScenario(writerBrowser, server, writer, { containerId: firstUse.id }, target);
    phase = "staged catalogs keep model repair reachable";
    await stagedCatalogScenario(writerBrowser, server, writer);
    phase = "synthetic account-scope recovery retains referenced fresh evidence";
    await syntheticScopeRecoveryScenario(writerBrowser, server, writer);
    phase = "Setup: its checklist, the first unready row's fix, folders and the classifier's review";
    await setupSheetScenario(writerBrowser, server, writer, target, secondTarget);
    phase = "synthetic review, launch and resume gate";
    await syntheticPreviewScenario(writerBrowser, server, writer, target, secondTarget);
    phase = "an agent launch through the real doors, then its Runs' activity, lease and dials";
    await agentLaunchScenario(writerBrowser, server, writer, target);
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
  console.log(`PASS (${Math.round((Date.now() - started) / 1000)}s): packed Code in two real browsers and two permitted destinations; shared choices converge with viewer authority intact, and a viewer's main view and accounts refuse every write. Genuine pinned OMP metadata yields an editable render-only starter whose routing and Models list are exactly the policy derivation; a conflicted local profile stays on show without revision-zero rebasing; configuration/metadata failures are not absence, and a failed model list is named with its retry and Models whatever the launch says. The verification charge is never confirmed by a double-click, a second click, key repeat or ↵ at the panel root, waits as the next Tab stop after the launch with every row and the machine locked, and a refused spend saves nothing; an account switch saves through the real changeAccounts CAS and keeps focus. A verified catalog recorded against the pinned OMP's artifact and the real catalog revision is current, and an OMP upgrade alone, with the same accounts and Code, makes Verify the step again. The panel reads its inputs again on its own when shown again, never while an edit is unsaved (a changed row, a named pool, until saved or discarded), a step runs or a sheet is open, and once that ends. Tiered usage windows are rows of their own that leave Claude neither tight nor maxed, and no reset is clipped where the usage grid turns to two columns. The lead row's only box toggles by a press and Space with focus kept on it, survives a lead change, is disabled under Mixed and moves no word of the row; a struck lead or box says why, and a lead whose lane on the box's side cannot run lands on its other. Models, from More with focus on its way back, shows the list as ladders whose rungs say their ids and prices only in the readout, walks them as one roving Tab stop, and offers one next action that follows the step: verify, the checking hold a double-click cannot pass, a charge confirmed only by one deliberate press, measuring per provider, verified with what it left out (Spark, by OMP's spark quota class, retired), back to code and verify again, which Esc stops while its charge waits; a pasted list is refused until it is one, staged by one press (initializing an absent workspace once, never over a competing first save), discarded at its revision, or used by promoting exactly its review. Setup is one checklist whose rows say what they need, pointing at the first unready one: another machine where OMP is absent, then each native review (Esc back onto the next action, nothing approved; sessions request both OMP's launch and its harness), OMP's folder job by either route, refused, and the owner's classifier reviewed by the real server before its configuration, refused. More and its Models item mark a staged list exactly when it waits beside the active one, and a staged-only workspace's launch opens Models on it. Profile and account drafts survive destinations, sheets, the accounts' management and a reload; own account edits never conflict with an unsaved edit while a foreign profile write does; a save is refused for a lead no account serves; a writer without a canvas saves and is told why launching waits, never read-only. From 170 to 1440px no view or sheet overflows, cuts or collides text, no route runs past the routing pane and More's menu stays inside the panel; pointing and focus shift nothing in a view or a sheet; More is a menu button by pointer and keyboard; keys stay panel-local and never act from a sheet or an open machine list, More menu or session drum; arrival keys reach the rows or take the launch's step; a refused keyboard step says why; the wheel steps only focused or rested rows; coarse targets are 44px in views and sheets, which hide their key line; reduced motion animates nothing and leaves no sheet duration. Auto-review, skills, automation, refused launch, resume and session correlations (one row per folder with its drum, re-read on refresh) stay gated at their native owners, native permission and folder readiness stay review-only, and no native approval, terminal or provider request is made. A sponsor's one press registers Code's Agent and creates its Run at the real doors; the machine's refused launchRun cancels the Run and the same press goes on to the reviewed session, as every later press there does, its readout saying the machine cannot launch agent runs (or, before it, that the harness is not enabled). Fixture Runs say their activity, a lease to 24 of 24, renewal due and detached, and one square on the Sessions tab; their dials go pending, queued as next, confirmed, clamped, not served, unanswered then sent again, and forbidden, and a starting or detached Run's dials send nothing; ←→ settle before one send and a press within that settle sends only itself, ↵ and Space send at once, ↑↓ cross Runs; send again keeps the said line whole on a coarse pointer; a pointed word, lease or activity moves nothing, reduced motion stills every mark, and from 170 to 1440px nothing overflows.`);
}

await run();
