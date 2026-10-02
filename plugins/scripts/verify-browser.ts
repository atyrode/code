#!/usr/bin/env bun
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser as BrowserInstance } from "../../../manifold/scripts/cdp.ts";
import type { TestAgent, TestServer } from "../../../manifold/packages/testkit/src/index.ts";
import type * as CdpModule from "../../../manifold/scripts/cdp.ts";
import type * as GateDistModule from "../../../manifold/scripts/gate-dist.ts";
import type * as TestkitModule from "../../../manifold/packages/testkit/src/index.ts";
import type { TokenGrant } from "../../../manifold/packages/protocol/src/index.ts";
import type { ActionInput, ActionResult } from "../code/contract.ts";
import type { CatalogDocument } from "../domain/contracts.ts";
import { ModelCatalogSnapshotSchema, ResumeSessionInputSchema, type ActionInput as OmpInput, type ActionResult as OmpResult } from "@atyrode/manifold-omp";
import type { PermissionPlan } from "../code/permission-plan.ts";
import { formatManifoldUri, type MachineSummary, type TerminalSummary } from "@manifold/protocol";

const HELP = `Usage: bun plugins/scripts/verify-browser.ts [bundle-directory]
Uses four prepacked Code bundles (default: plugins/dist) and three real upstream OMP bundles
(default: plugins/.integration/omp/plugins/dist; CODE_OMP_BUNDLES_DIR may explicitly override), never Code source.
MANIFOLD_DIR selects the pinned SDK checkout; default: the sibling manifold directory.
Requires installed SDK dependencies and Chromium (MANIFOLD_CHROMIUM may select its binary).
MANIFOLD_GATE_DIST may supply an existing SDK web build; otherwise gate-dist builds a
throwaway web bundle. Missing Chromium or any failed assertion is a failure, not a skip.
Starts only a disposable loopback server and an isolated testkit machine transport/terminal
host. No native job owner, native setup, terminals, OMP processes, inference or providers are invoked.
Proves real bundled-metadata starter composition, explicit atomic policy adoption, retained
conflicted drafts, permission choices, writer/viewer authority and container-shared choices
across two destinations. Separate synthetic RPC responses exercise independent folder-only
control readiness and preview invalidation/refusal, never native execution or consent success.
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
const presetName = "Browser shared profile";
const timeout = 15_000;

// Static runtime imports cannot honor MANIFOLD_DIR: the checkout is runtime-selected.
// Type-only imports retain Code's sibling SDK convention without loading that checkout.
const { Browser } = await import(pathToFileURL(join(manifold, "scripts/cdp.ts")).href) as typeof CdpModule;
const { resolveWebDist } = await import(pathToFileURL(join(manifold, "scripts/gate-dist.ts")).href) as typeof GateDistModule;
const { callAction, createContainer, enrollMachine, mintToken, ownerAction, startAgent, startServer, waitFor } =
  await import(pathToFileURL(join(manifold, "packages/testkit/src/index.ts")).href) as typeof TestkitModule;
class ProofFailure extends Error {}

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

// DOM evaluation only locates/scrolls the control. Activation is a real CDP pointer
// gesture (not HTMLElement.click(), dispatched DOM events, or a React handler call).
async function click(browser: BrowserInstance, expression: string): Promise<void> {
  const point = await waitFor(async () => {
    const candidate = await browser.evaluate<{ x: number; y: number } | null>(`(async () => {
      const el = ${expression};
      if (!(el instanceof HTMLElement) || el.matches(':disabled')) return null;
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
      if (!(el instanceof HTMLElement) || el.matches(':disabled')) return false;
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(${candidate.x}, ${candidate.y});
      return rect.x + rect.width / 2 === ${candidate.x} && rect.y + rect.height / 2 === ${candidate.y} &&
        hit !== null && el.contains(hit);
    })()`);
    return stable ? candidate : undefined;
  }, timeout, 50);
  await browser.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1 });
  await browser.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
}
async function key(browser: BrowserInstance, name: string, code: number): Promise<void> {
  // Blink's native button activation needs Enter's character data, not only its key code.
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code,
    ...(name === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code });
}

type Target = { containerId: string; machineId: string };
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

const generator = ".plugin-atyrode_code_generator";
const generatorDestination = `${generator} .plugin-atyrode_code_generator__machine select`;
const launchControl = element(`${generator} .plugin-atyrode_code_generator__launch-bar button`);
const controls = `${generator} [aria-label="Generator controls"]`;
const profiles = `${generator} [aria-label="Generated profiles"]`;
const routes = `${profiles} .plugin-atyrode_code_generator__routes`;
const taskField = element(`${generator} textarea[placeholder="What should we tackle?"]`);
const starterSave = element(`${generator} [data-action="atyrode.code.adoptStarterProfile"]`);
const profileSave = element(`${generator} [data-action="atyrode.code.select"]`);
const starterExport = element(`${generator} textarea[data-starter-export]`);
const starterProviders = ["anthropic", "deepseek", "openai-codex"];
const profileRoles = ["default", "task", "plan", "slow", "reviewer", "security-reviewer", "scout", "sonic", "vision", "smol", "tiny", "commit"];
function dial(label: string): string {
  return `[...document.querySelectorAll('${controls} [role="radiogroup"]')].find(el => document.getElementById(el.getAttribute('aria-labelledby'))?.textContent.trim() === ${JSON.stringify(label)})`;
}
function workspaceButton(text: string): string {
  return `[...document.querySelectorAll('${generator} button')].find(el => el.getClientRects().length && el.textContent.trim() === ${JSON.stringify(text)})`;
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

async function usableStarter(browser: BrowserInstance): Promise<void> {
  await control(browser, "bundled starter can be explicitly saved without runtime setup", starterSave, false);
  for (const label of ["Provider", "Capability", "Thinking", "Advisor"]) {
    await control(browser, `${label} is editable before shared policy exists`, `${dial(label)}?.querySelector('[aria-checked="true"]')`, false);
  }
  await assertRoles(browser, false);
  await control(browser, "an unsaved starter cannot launch", launchControl, true);
}

async function assertRoles(browser: BrowserInstance, advisor: boolean): Promise<void> {
  await until(browser, "generated role roster is rendered", `${element(routes)}?.getClientRects().length > 0`);
  const rendered = await browser.evaluate<string[]>(`[...document.querySelectorAll('${routes} > div > dt')].map(el =>
    [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim())`);
  assert.deepEqual(rendered.sort(), [...profileRoles, ...(advisor ? ["advisor"] : [])].sort(),
    "The full current role contract is visible, including delegated and utility roles");
  assert.equal(await browser.evaluate(`[...document.querySelectorAll('${routes} > div > dd')].every(el =>
    el.getClientRects().length > 0 && el.querySelector('.plugin-atyrode_code_generator__model-name')?.textContent.trim() &&
    el.querySelector('.plugin-atyrode_code_generator__thinking')?.textContent.trim())`), true,
  "Every generated role exposes its model and supported effort, not an empty card");
}

type StarterDraft = Pick<ActionInput<"reviewStarterProfile">, "metadata" | "selection"> & {
  baseRevision: number;
  document: ActionResult<"reviewStarterProfile">["document"];
};
async function readStarterDraft(browser: BrowserInstance): Promise<StarterDraft> {
  await until(browser, "local starter material remains exportable", `${starterExport} instanceof HTMLTextAreaElement && !!${starterExport}.value`);
  return JSON.parse(await browser.evaluate<string>(`${starterExport}.value`)) as StarterDraft;
}

type BrowserAction = { name: string; input: Record<string, unknown> };
async function watchActions(browser: BrowserInstance, server: TestServer): Promise<{ requests: BrowserAction[]; stop: () => void }> {
  const requests: BrowserAction[] = [];
  let watching = true;
  browser.on("Network.requestWillBeSent", event => {
    if (!watching) return;
    const request = event.request as { url?: string; postData?: string } | undefined;
    const prefix = `${server.httpUrl}/api/actions/`;
    if (request?.url?.startsWith(prefix)) requests.push({
      name: decodeURIComponent(request.url.slice(prefix.length)), input: JSON.parse(request.postData ?? "{}"),
    });
  });
  await browser.send("Network.enable", {});
  return { requests, stop: () => { watching = false; } };
}

function noNativeEffects(requests: BrowserAction[]): void {
  const effects = ["atyrode.code.suggest", "atyrode.code.runSession", "atyrode.code.configureServices",
    "atyrode.omp.startInventory", "atyrode.omp.startBenchmark", "atyrode.omp.reviewSession", "atyrode.omp.prepareSession",
    "atyrode.omp.resumeSession", "atyrode.omp.prepareWorkspace", "atyrode.omp.accounts.promoteAccountRuntime",
    "atyrode.omp.gateway.configureGateway", "engine.jobs.reviewDeployment", "engine.jobs.applyDeployment", "engine.jobs.execute",
    "core.terminals.create"];
  assert.deepEqual(requests.filter(request => effects.includes(request.name)), [],
    "Starter observation, edits and saves never request classification, discovery, benchmark, consent or native execution");
}

async function starterLayoutScenario(browser: BrowserInstance): Promise<void> {
  const before = await readStarterDraft(browser);
  const prompt = await browser.evaluate<string>(`${taskField}.value`);
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  try {
    for (const width of [1280, 1024, 640, 390, 320]) {
      let viewportWidth = Math.ceil((width + 64) * 4 / 3);
      for (let correction = 0; correction < 3; correction++) {
        await browser.send("Emulation.setDeviceMetricsOverride", { width: viewportWidth, height: 900, deviceScaleFactor: 1, mobile: false });
        const actualWidth = await browser.evaluate<number>(`${element(generator)}.getBoundingClientRect().width`);
        if (Math.abs(actualWidth - width) <= 1) break;
        viewportWidth += Math.round((width - actualWidth) * 4 / 3);
      }
      await until(browser, "native embedding allocates the requested widget width", `Math.abs(${element(generator)}.getBoundingClientRect().width - ${width}) <= 2`);
      await assertRoles(browser, before.selection.advisor !== "off");
      const geometry = await browser.evaluate<{ wide: boolean; stacked: boolean; overflow: boolean; order: boolean; roleReflow: boolean }>(`(() => {
        const controls = ${element(controls)}, profiles = ${element(profiles)};
        const usage = ${element(`${generator} [aria-label="Usage overview"]`)}, task = ${taskField};
        const c = controls.getBoundingClientRect(), p = profiles.getBoundingClientRect();
        const root = ${element(generator)};
        const follows = (first, second) => !!first && !!second &&
          !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
        return { wide: p.left >= c.right - 1 && Math.abs(p.top - c.top) < 32,
          stacked: p.top >= c.bottom - 1,
          overflow: root.scrollWidth > root.clientWidth + 1,
          order: follows(controls, profiles) && follows(profiles, usage) && follows(usage, task),
          roleReflow: [...document.querySelectorAll('${routes} > div')].every(row => {
            const role = row.querySelector('dt').getBoundingClientRect(), model = row.querySelector('dd').getBoundingClientRect();
            return role.width > 0 && model.width > 0 && model.top >= role.bottom - 1;
          }) };
      })()`);
      assert.equal(geometry.overflow, false, `The ${width}px widget has no outer horizontal overflow`);
      assert.equal(geometry.order, true, "Controls and complete profiles precede account facts and the single task/review area");
      if (width >= 1024) assert.equal(geometry.wide, true, "Wide widgets align controls beside the full role roster");
      if (width === 320) {
        assert.equal(geometry.stacked, true, "Narrow widgets put profiles after the controls");
        assert.equal(geometry.roleReflow, true, "At 320px each full role label precedes its model/effort row");
      }
      assert.equal(await browser.evaluate(`${taskField}.value`), prompt, "Reflow preserves the task");
      assert.deepEqual(await readStarterDraft(browser), before, "Reflow is presentation only");
    }
    const focusTrigger = element(`${generator} button[aria-label="Focus generator"]`);
    await click(browser, focusTrigger);
    await until(browser, "focus mode removes unrelated panels from interaction", `${element(profiles)}.getClientRects().length === 0`);
    const help = element(`${controls} button[aria-label="About thinking"]`);
    await click(browser, help);
    assert.equal(await browser.evaluate(`(() => {
      const panel = document.getElementById(${help}.getAttribute('aria-controls'));
      const rect = panel.getBoundingClientRect(), root = ${element(generator)}.getBoundingClientRect();
      return rect.width > 0 && rect.left >= root.left - 1 && rect.right <= root.right + 1 &&
        rect.top >= 0 && rect.bottom <= innerHeight + 1;
    })()`), true, "Contextual help stays readable within the narrow widget and viewport");
    await key(browser, "Escape", 27);
    assert.equal(await browser.evaluate(`${help}.getAttribute('aria-expanded')`), "false");
    assert.equal(await browser.evaluate(`${element(profiles)}.getClientRects().length`), 0,
      "The first Escape dismisses inner help, not the surrounding focus mode");
    await key(browser, "Escape", 27);
    await until(browser, "Escape restores the complete workbench and initiating focus control",
      `${element(profiles)}.getClientRects().length > 0 && document.activeElement === ${focusTrigger}`);
    await click(browser, help);
    await key(browser, "Escape", 27);
    await key(browser, "Enter", 13);
    await until(browser, "keyboard activation opens focused help", `${help}.getAttribute('aria-expanded') === 'true'`);
    await key(browser, "Escape", 27);
    assert.equal(await browser.evaluate(`document.activeElement === ${help}`), true, "Keyboard help dismissal retains its initiating focus");
    const thinking = dial("Thinking");
    await click(browser, `${thinking}.querySelector('[aria-checked="true"]')`);
    await key(browser, "Home", 36);
    assert.equal(await browser.evaluate(`${thinking}.querySelector('[aria-checked="true"]').dataset.value`), "minimal");
    await key(browser, "End", 35);
    assert.equal(await browser.evaluate(`${thinking}.querySelector('[aria-checked="true"]').dataset.value`), "max");
    assert.equal(await browser.evaluate(`${thinking}.querySelectorAll('[tabindex="0"]').length`), 1,
      "Each dial remains one keyboard tab stop");
    assert.equal(await browser.evaluate(`(() => {
      const el = document.activeElement, style = getComputedStyle(el);
      return el.matches(':focus-visible') && ((style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none');
    })()`), true, "Keyboard dial changes leave a visible focus indicator");
    await click(browser, `${thinking}.querySelector('[data-value=${JSON.stringify(before.selection.thinking)}]')`);
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    assert.equal(await browser.evaluate(`[...document.querySelectorAll('${controls} button[role="radio"], ${controls} button[aria-label^="About "], ${generator} button[aria-label^="Focus "]')]
      .filter(el => !el.disabled && el.getClientRects().length).every(el => { const rect = el.getBoundingClientRect(); return rect.width >= 44 && rect.height >= 44; })`), true,
    "Visible dial, help and focus controls remain 44px touch targets");
    const touchHelpPoint = await browser.evaluate<{ x: number; y: number }>(`(() => {
      const el = ${help}; el.scrollIntoView({block:'center'}); const rect = el.getBoundingClientRect();
      return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    })()`);
    await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchHelpPoint] });
    await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until(browser, "touch opens contextual help", `${help}.getAttribute('aria-expanded') === 'true'`);
    await key(browser, "Escape", 27);
    const touchPoint = await browser.evaluate<{ x: number; y: number }>(`(() => {
      const el = ${dial("Advisor")}.querySelector('[data-value="review"]'); el.scrollIntoView({block:'center'});
      const rect = el.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
    })()`);
    await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint] });
    await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until(browser, "touch edits advisor policy", `${dial("Advisor")}.querySelector('[data-value="review"]').getAttribute('aria-checked') === 'true'`);
    await assertRoles(browser, true);
    const gestureBefore = await readStarterDraft(browser);
    await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint] });
    await browser.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchPoint.x, y: touchPoint.y + 40 }] });
    await browser.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchPoint.x + 50, y: touchPoint.y + 70 }] });
    await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.deepEqual(await readStarterDraft(browser), gestureBefore, "A vertical touch scroll cannot become a dial scrub");
    await click(browser, `${dial("Advisor")}.querySelector('[data-value=${JSON.stringify(before.selection.advisor)}]')`);
    assert.equal(await browser.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
    assert.equal(await browser.evaluate(`${element(generator)}.getAnimations({subtree:true}).filter(animation => animation.playState === 'running').length`), 0,
      "Reduced motion does not leave active workbench animations");
    assert.equal(await browser.evaluate(`${taskField}.value`), prompt);
    assert.deepEqual(await readStarterDraft(browser), before, "Focus, help and gesture round trips retain the frozen policy");
  } finally {
    await browser.send("Emulation.clearDeviceMetricsOverride", {});
    await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
}

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
      await browser.goto(`${server.httpUrl}/p/${workspace.id}`);
      await usableStarter(browser);
      const initialDraft = await readStarterDraft(browser);
      assert.equal(initialDraft.baseRevision, base.revision);
      assert.deepEqual(initialDraft.metadata, metadata, "Local routes are based on the exact real OMP metadata response");
      await click(browser, taskField);
      const prompt = `Retain ${initialized ? "initialized" : "fresh"} task through policy adoption.`;
      await browser.typeText(prompt);
      await click(browser, `${dial("Thinking")}.querySelector('[data-value="high"]')`);
      await click(browser, `${dial("Advisor")}.querySelector('[data-value="audit"]')`);
      await assertRoles(browser, true);
      const chosen = await readStarterDraft(browser);
      assert.notDeepEqual(chosen.selection, initialDraft.selection, "The first explicit save exercises a chosen nondefault selection");
      assert.equal(chosen.selection.thinking, "high");
      assert.equal(chosen.selection.advisor, "audit");
      for (const view of ["Accounts", "Models", "Setup", "Workbench"]) await click(browser, workspaceButton(view));
      assert.equal(await browser.evaluate(`${taskField}.value`), prompt, "Navigation retains a first-use task");
      assert.deepEqual(await readStarterDraft(browser), chosen, "Navigation does not regenerate or rebase starter choices");
      if (!initialized) await starterLayoutScenario(browser);
      assert.deepEqual(await readConfiguration(server, writer, target), base,
        "Mount, typing, dials, focus, help, resizing and navigation never initialize or mutate policy");
      assert.deepEqual(trace.requests.slice(start).filter(request => /^atyrode\.code\.(initializeConfiguration|stageCatalog|select|adoptStarterProfile)$/.test(request.name)), []);
      const input: ActionInput<"reviewStarterProfile"> = { ...target, expectedRevision: base.revision, metadata, selection: chosen.selection };
      const reviewed = await callAction(server, writer.token, "atyrode.code.reviewStarterProfile", input);
      assert(reviewed.ok, "The real Code owner derives and reviews policy without native runtime");
      const review = reviewed.result as ActionResult<"reviewStarterProfile">;
      assert.deepEqual(chosen.document, review.document, "The displayed/exported starter is the owner-derived catalog");
      assert.deepEqual(review.review.selection, chosen.selection, "Review preserves the exact chosen selection");
      assert.equal(review.metadataRevision, metadata.revision);
      const rendered = await browser.evaluate<{ role: string; key: string; thinking: string }[]>(`[...document.querySelectorAll('${routes} > div')].map(row => ({
        role: [...row.querySelector('dt').childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('').trim(),
        key: row.querySelector('dd > .plugin-atyrode_code_generator__model .plugin-atyrode_code_generator__model-name').textContent.trim(),
        thinking: row.querySelector('dd > .plugin-atyrode_code_generator__model .plugin-atyrode_code_generator__thinking').dataset.level,
      }))`);
      assert.deepEqual(rendered, review.review.routes.map(route => ({ role: route.role, key: route.lead.key, thinking: route.lead.thinking })),
        "The visible role models and supported effort exactly match the genuine owner's compiled selection");
      for (const model of review.document.models) {
        const source = metadata.models.find(row => row.provider === model.provider && row.id === model.id);
        assert(source, "Every generated catalog row comes from the actual pinned OMP response");
        assert(source.quotaTier === null || source.quotaTier === "chat", "Special and unknown quota tiers cannot become ordinary starter rungs");
        assert.equal(model.tokensPerSecond, null, "Bundled metadata does not invent measured speed");
        assert.equal(model.timeToFirstTokenMs, null, "Bundled metadata does not invent measured latency");
      }
      const saving = trace.requests.length;
      await click(browser, starterSave);
      await until(browser, "the explicit starter transaction completes", `${starterSave} === null && ${element(routes)}?.getClientRects().length > 0`);
      const saved = await readConfiguration(server, writer, target);
      assert.equal(saved.revision, initialized ? base.revision + 1 : 1, "Starter catalog and exact selection persist in one CAS, including revision one from absence");
      assert.equal(saved.configuration?.draft, null, "Starter adoption never leaves an intermediate staged record");
      assert.deepEqual(saved.configuration?.active, { document: review.document, digest: review.catalogDigest });
      assert.deepEqual(saved.configuration?.selection, chosen.selection);
      if (initialized) assert.deepEqual(saved.configuration?.accounts, base.configuration?.accounts, "Positive-revision adoption preserves every existing account choice");
      assert.equal(await browser.evaluate(`${taskField}.value`), prompt);
      const adoption = trace.requests.slice(saving);
      const reviews = adoption.filter(request => request.name === "atyrode.code.reviewStarterProfile");
      const effects = adoption.filter(request => request.name === "atyrode.code.adoptStarterProfile");
      assert.deepEqual(reviews.map(request => request.input), [input], "The browser requests one exact owner policy review");
      assert.deepEqual(effects.map(request => request.input), [{ ...input, reviewDigest: review.reviewDigest }],
        "The browser adopts exactly the reviewed metadata, selection, revision and digest once");
      const reviewAt = adoption.findIndex(request => request.name === "atyrode.code.reviewStarterProfile");
      const effectAt = adoption.findIndex(request => request.name === "atyrode.code.adoptStarterProfile");
      assert(adoption.slice(reviewAt + 1, effectAt).some(request => request.name === "atyrode.omp.readModelCatalog"),
        "The browser rereads the genuine OMP source after review and before the one policy effect");
      assert.deepEqual(adoption.filter(request => request.name === "atyrode.code.initializeConfiguration" || request.name === "atyrode.code.stageCatalog"), []);
      await control(browser, "saved policy is not native launch readiness", launchControl, true);
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
  await browser.goto(`${server.httpUrl}/p/${workspace.id}`);
  await usableStarter(browser);
  await click(browser, taskField);
  await browser.typeText("Keep the competing first-save task and chosen profile.");
  await click(browser, `${dial("Thinking")}.querySelector('[data-value="max"]')`);
  const frozen = await readStarterDraft(browser);
  const routeText = await browser.evaluate<string>(`${element(routes)}.textContent`);
  const competing = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { ...target, expectedRevision: 0 });
  assert(competing.ok);
  await control(browser, "a revision-zero draft cannot attach to a competing initializer", starterSave, true);
  for (const view of ["Models", "Accounts", "Workbench"]) await click(browser, workspaceButton(view));
  assert.deepEqual(await readStarterDraft(browser), frozen, "The exact document, metadata, choices and original revision remain inspectable/exportable");
  assert.equal(await browser.evaluate(`${element(routes)}.textContent`), routeText, "A conflict does not replace the displayed route document");
  assert.equal(await browser.evaluate(`${taskField}.value`), "Keep the competing first-save task and chosen profile.");
  assert.equal((await readConfiguration(server, writer, target)).revision, 1, "Navigation cannot auto-rebase or replay a rejected first adoption");
  await control(browser, "conflicted starter remains unsavable after observation recovery", starterSave, true);
}

async function sharedWorkbenchScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, viewer: TokenGrant, first: Target, second: Target): Promise<void> {
  const before = await readConfiguration(server, writer, first);
  const preset = before.configuration?.accounts.presets.find(row => row.id === before.configuration?.accounts.activePreset);
  assert(preset, "The shared UI-created account pool must be active");
  const exclusion = { kind: "credential", scope: "browser-fixture-account-scope", provider: "anthropic", credentialId: 7 };
  const excluded = await callAction(server, writer.token, "atyrode.code.changeAccounts", { containerId: first.containerId,
    expectedRevision: before.revision, change: { kind: "update-preset", preset: { ...preset, disabled: [exclusion] } } });
  assert(excluded.ok, "An explicit unobserved exclusion is saved as a choice, never as a broker credential mutation");
  const document = { schemaVersion: 1, models: [1, 2, 3, 4].map(tier => ({
    key: `browser-model-${tier}`, provider: "anthropic", id: `browser-native-${tier}`, api: "anthropic-messages", tier,
    quotaBucket: null, inputCostPerMillion: tier, outputCostPerMillion: tier * 3, tokensPerSecond: 30,
    timeToFirstTokenMs: 100, contextWindow: 200_000, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], images: true,
  })) };
  const staged = await callAction(server, writer.token, "atyrode.code.stageCatalog", { containerId: first.containerId, expectedRevision: (excluded.result as Configuration).revision, document });
  assert(staged.ok, "Writer stages a real shared catalog without native installation");
  const reviewInput = { containerId: first.containerId, expectedRevision: (staged.result as Configuration).revision, source: "draft" };
  const reviewed = await callAction(server, writer.token, "atyrode.code.reviewCatalog", reviewInput);
  assert(reviewed.ok, "Catalog policy review remains possible without execution readiness");
  const promoted = await callAction(server, writer.token, "atyrode.code.promoteCatalog", { ...reviewInput, reviewDigest: (reviewed.result as ActionResult<"reviewCatalog">).reviewDigest });
  assert(promoted.ok, "Reviewed catalog is promoted through the real container CAS");
  const initial = promoted.result as Configuration;
  const destination = await callAction(server, writer.token, "atyrode.omp.describeDestination", first);
  const refusalCode = !destination.ok && /^omp_[a-z_]+$/.test(destination.denial.message) ? destination.denial.message : "unknown";
  assert(destination.ok, `A caller with native readiness authority can inspect the OMP destination (${refusalCode})`);
  assert((destination.result as OmpResult<"describeDestination">).operations.every(operation => !operation.nativeReady), "The real fixture has no native installation");
  const deployments = await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 });
  const layout = await callAction(server, writer.token, "core.space.setLayout", { layout: {
    root: { id: "root", dir: "row", ratios: [1, 3], children: ["container", "code"], ref: null },
    container: { id: "container", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "core.shell.container-view" } },
    code: { id: "code", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "atyrode.code.generator.launcher" } },
  } });
  assert(layout.ok);
  const reads: Record<string, unknown>[] = [];
  browser.on("Network.requestWillBeSent", event => {
    const request = event.request as { url?: string; postData?: string } | undefined;
    if (request?.url?.endsWith("/api/actions/atyrode.code.readConfiguration") && request.postData) reads.push(JSON.parse(request.postData));
  });
  await browser.send("Network.enable", {});
  await browser.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await browser.goto(`${server.httpUrl}/p/${first.containerId}`);
  await selectDestination(browser, generatorDestination, first.machineId);
  const promptField = taskField;
  await control(browser, "shared active profile ready", promptField, false);
  await assertRoles(browser, false);
  assert.equal(await browser.evaluate(`${starterSave} === null`), true, "A saved active catalog wins over bundled starter metadata");
  const activeModels = await browser.evaluate<string[]>(`[...document.querySelectorAll('${routes} .plugin-atyrode_code_generator__model-name')].map(el => el.textContent.trim())`);
  assert(activeModels.every(key => document.models.some(model => model.key === key)), "Configured role output continues to use the saved catalog");
  const sessionOptions = element(`${generator} [data-session-options]`);
  const sessionOptionsSummary = `${sessionOptions}.querySelector(':scope > summary')`;
  if (await browser.evaluate(`${sessionOptions}.open`)) await click(browser, sessionOptionsSummary);
  assert.equal(await browser.evaluate(`(() => { const el = ${workspaceButton("Disable all skills")}; if (!el) return true; const rect = el.getBoundingClientRect(); return !el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })()`), true, "Collapsed skill controls are not pointer targets");
  await click(browser, sessionOptionsSummary);
  const skills = element(`${generator} [aria-label="Optional skills"]`);
  const skillCatalog = await callAction(server, writer.token, "atyrode.omp.readSkillCatalog", first);
  assert(skillCatalog.ok, "The real destination exposes its authorized empty optional catalog");
  assert.deepEqual((skillCatalog.result as OmpResult<"readSkillCatalog">).skills, [],
    "The offline fixture publishes no unreviewed skill source");
  await until(browser, "ordinary loading starts with zero optional choices", `${skills}?.dataset.mode === 'preserve'`);
  await click(browser, workspaceButton("Disable all skills"));
  await until(browser, "disable-all is a distinct launch choice", `${skills}?.dataset.mode === 'disabled'`);
  await click(browser, workspaceButton("Refresh skill catalog"));
  await click(browser, workspaceButton("Accounts"));
  await click(browser, workspaceButton("Workbench"));
  assert.equal(await browser.evaluate(`${skills}.dataset.mode`), "disabled", "Unrelated navigation and refresh preserve the ephemeral skill choice");
  await click(browser, workspaceButton("Clear optional choices"));
  assert.equal(await browser.evaluate(`${skills}.dataset.mode`), "preserve", "Clearing optional choices restores ordinary loading instead of disabling it");
  await click(browser, workspaceButton("Disable all skills"));
  const prompt = "Retain this task while choosing where OMP will execute.";
  await click(browser, promptField);
  await browser.typeText(prompt);
  await click(browser, sessionOptionsSummary);
  assert.equal(await browser.evaluate(`${sessionOptions}.open`), false);
  assert.equal(await browser.evaluate(`${skills}.dataset.mode`), "disabled", "Closing session options keeps its deliberate skill choice");
  await key(browser, "Tab", 9);
  assert.equal(await browser.evaluate(`document.activeElement?.closest('[aria-label="Optional skills"]') === null`), true,
    "Keyboard navigation skips the closed optional controls");
  const thinking = `[...document.querySelectorAll('${generator} [role="radiogroup"]')].find(el => document.getElementById(el.getAttribute('aria-labelledby'))?.textContent === 'Thinking')`;
  const thinkingHelp = element(`${generator} button[aria-label="About thinking"]`);
  const beforeHelp = await browser.evaluate(`${thinking}.querySelector('[aria-checked="true"]').dataset.value`);
  await click(browser, promptField);
  const hoverPoint = await browser.evaluate<{ x: number; y: number }>(`(() => {
    const trigger = ${thinkingHelp}; trigger.scrollIntoView({block:'center'});
    const rect = trigger.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  })()`);
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...hoverPoint });
  await until(browser, "hover opens help without moving task focus", `${thinkingHelp}.getAttribute('aria-expanded') === 'true' && document.activeElement === ${promptField}`);
  const contentPoint = await browser.evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.getElementById(${thinkingHelp}.getAttribute('aria-controls')).getBoundingClientRect();
    return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  })()`);
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...contentPoint });
  await until(browser, "pointer can enter and read help content", `${thinkingHelp}.getAttribute('aria-expanded') === 'true'`);
  await key(browser, "Escape", 27);
  assert.equal(await browser.evaluate(`${thinkingHelp}.getAttribute('aria-expanded')`), "false", "Escape dismisses hover-only help");
  assert.equal(await browser.evaluate(`document.activeElement === ${promptField}`), true, "Dismissing hover-only help does not steal task focus");
  await click(browser, thinkingHelp);
  await until(browser, "contextual thinking help opens by pointer", `${thinkingHelp}.getAttribute('aria-expanded') === 'true'`);
  await key(browser, "Escape", 27);
  assert.equal(await browser.evaluate(`${thinkingHelp}.getAttribute('aria-expanded')`), "false", "Keyboard can close contextual help");
  assert.equal(await browser.evaluate(`${thinking}.querySelector('[aria-checked="true"]').dataset.value`), beforeHelp,
    "Asking for help does not edit the profile");
  await click(browser, `${thinking}.querySelector('[aria-checked="true"]')`);
  await key(browser, "ArrowRight", 39);
  const localThinking = await browser.evaluate<string>(`${thinking}.querySelector('[aria-checked="true"]').dataset.value`);
  const capability = `[...document.querySelectorAll('${generator} [role="radiogroup"]')].find(el => document.getElementById(el.getAttribute('aria-labelledby'))?.textContent === 'Capability')`;
  await control(browser, "the fourth observed capability is available", `${capability}.querySelector('[data-value="4"]')`, false);
  await click(browser, `${capability}.querySelector('[data-value="4"]')`);
  await click(browser, element(`${generator} .plugin-atyrode_code_generator__extra-dials > summary`));
  const plans = `[...document.querySelectorAll('${generator} [role="radiogroup"]')].find(el => document.getElementById(el.getAttribute('aria-labelledby'))?.textContent === 'Plans')`;
  await click(browser, `${plans}.querySelector('[data-value="true"]')`);
  await click(browser, workspaceButton("Models"));
  await click(browser, workspaceButton("Edit or import models"));
  const catalog = `${generator} [aria-label="Model catalog"]`;
  const pricingSummary = `[...document.querySelectorAll('${catalog} summary')].find(el => el.textContent === 'Pricing')`;
  const inputPrice = element(`${catalog} .plugin-atyrode_code_generator__model-editor fieldset details input[type="number"]`);
  assert.equal(await browser.evaluate(`(() => { const el = ${inputPrice}; const rect = el.getBoundingClientRect(); return !el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)); })()`), true, "Undisclosed pricing is not a pointer target");
  await click(browser, pricingSummary);
  await click(browser, inputPrice);
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await browser.typeText("12.5");
  await click(browser, pricingSummary);
  assert.equal(await browser.evaluate(`${inputPrice}.value`), "12.5", "Closing metadata preserves the catalog edit");
  const importSummary = `[...document.querySelectorAll('${catalog} summary')].find(el => el.textContent === 'JSON import / export')`;
  await click(browser, importSummary);
  const importField = element(`${catalog} textarea:not([readonly])`);
  const importDraft = JSON.stringify({ ...document, models: document.models.map(model => ({ ...model, contextWindow: 180_000 })) });
  await click(browser, importField);
  await browser.typeText(importDraft);
  await click(browser, workspaceButton("Accounts"));
  await until(browser, "broker-less account observation settles before the editor gesture",
    `[...document.querySelectorAll('${generator} .plugin-atyrode_code__accounts .plugin-atyrode_code__account-observation, ${generator} .plugin-atyrode_code__accounts .plugin-atyrode_code__account-notice[role="status"]')].some(el => el.getClientRects().length)`);
  await control(browser, "shared saved account pool is editable", workspaceButton("Edit pool"), false);
  await click(browser, workspaceButton("Edit pool"));
  const accountDraft = element(`${generator} .plugin-atyrode_code__accounts form[aria-label="Saved account pool editor"] input[required]`);
  await control(browser, "shared account editor has opened", accountDraft, false);
  await click(browser, accountDraft);
  await key(browser, "End", 35);
  await browser.typeText(" local draft");
  const accountDraftName = `${preset.name} local draft`;
  await click(browser, workspaceButton("Models"));
  await selectDestination(browser, generatorDestination, second.machineId);
  assert.equal(await browser.evaluate(`${workspaceButton("Models")}.getAttribute('aria-current')`), "page", "Visited catalog view survives the destination switch");
  assert.equal(await browser.evaluate(`${importField}.value`), importDraft, "Unparsed JSON import stays local across machines");
  assert.equal(await browser.evaluate(`${inputPrice}.value`), "12.5", "Advanced catalog values survive navigation and destination changes");
  await until(browser, "a new destination clears ad-hoc skill choices before they can be reused", `${skills}.dataset.mode === 'preserve'`);
  assert.equal(await browser.evaluate(`${promptField}.value`), prompt, "Hidden prompt stays mounted across machines");
  assert.equal(await browser.evaluate(`${accountDraft}.value`), accountDraftName, "Visited account editor retains its unsaved preset across destinations");
  assert.equal(await browser.evaluate(`${element(`${generator} .plugin-atyrode_code__account-exclusions`)}.textContent.includes(${JSON.stringify(exclusion.scope)})`), true,
    "The account draft keeps its nonempty unobserved exclusion instead of importing another machine’s pool");
  assert.equal(await browser.evaluate(`${thinking}.querySelector('[aria-checked="true"]').dataset.value`), localThinking, "Local thinking dial survives the switch");
  assert.equal(await browser.evaluate(`${plans}.querySelector('[aria-checked="true"]').dataset.value`), "true", "planYolo remains a profile choice, not a native permission");
  await click(browser, workspaceButton("Workbench"));
  await click(browser, profileSave);
  await until(browser, "profile save completes", `${element(`${generator} .plugin-atyrode_code_generator__draft`)} === null`);
  const saved = await readConfiguration(server, viewer, second);
  assert.equal(saved.configuration?.selection?.thinking, localThinking, "Second destination saves to the shared profile");
  assert.equal(saved.configuration?.selection?.capability, 4, "The fourth capability saves unchanged from the second destination");
  assert.equal(saved.configuration?.selection?.planYolo, true);
  assert.deepEqual(saved.configuration?.accounts, initial.accounts, "Saving dials preserves shared account pools and exclusions");
  await control(browser, "unprepared second destination cannot launch", launchControl, true);
  await selectDestination(browser, generatorDestination, first.machineId);
  assert.equal(await browser.evaluate(`${promptField}.value`), prompt);
  assert.equal(await browser.evaluate(`${thinking}.querySelector('[aria-checked="true"]').dataset.value`), localThinking, "Saved choices remain identical when returning to the first destination");
  await click(browser, workspaceButton("Models"));
  assert.equal(await browser.evaluate(`${importField}.value`), importDraft);
  await click(browser, workspaceButton("Workbench"));
  assert(reads.length > 0 && reads.every(input => input.containerId === first.containerId && Object.keys(input).length === 1),
    "Ordinary browser configuration reads use only the container, never per-machine fanout or implicit legacy fallback");
  assert.equal(await browser.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await until(browser, "responsive profile remains usable", `${promptField}.getBoundingClientRect().width > 0`);
  await browser.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  const summaryPoint = await browser.evaluate<{ x: number; y: number }>(`(() => { const node = ${sessionOptionsSummary}; node.scrollIntoView({block:'center'}); const rect = node.getBoundingClientRect(); return {x:rect.x + rect.width / 2,y:rect.y + rect.height / 2}; })()`);
  await browser.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [summaryPoint] });
  await browser.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await until(browser, "touch opens the session options", `${sessionOptions}.open`);
  await click(browser, workspaceButton("Disable all skills"));
  await key(browser, "Tab", 9);
  assert.equal(await browser.evaluate(`document.activeElement?.closest('[aria-label="Optional skills"]') === ${skills} && !document.activeElement.matches(':disabled')`), true,
    "Skill controls remain keyboard reachable at a narrow viewport");
  await click(browser, workspaceButton("Clear optional choices"));
  await click(browser, promptField);
  await key(browser, "End", 35);
  assert.equal(await browser.evaluate(`document.activeElement === ${promptField}`), true, "The prompt remains pointer- and keyboard-accessible at the narrow viewport");
  assert.equal(await browser.evaluate(`${promptField}.value`), prompt, "Responsive layout keeps the same prompt");
  await browser.send("Emulation.clearDeviceMetricsOverride", {});
  await browser.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), deployments,
    "Destination selection, planYolo and shared profile edits never grant or revoke native approval");
}

async function unresolvedStagedCatalogScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant): Promise<void> {
  const workspace = await createContainer(server, "Text-only staged catalog recovery", "canvas");
  await arrangeWorkbench(server, writer);
  const target = { containerId: workspace.id };
  const metadata = await callAction(server, writer.token, "atyrode.omp.readModelCatalog", { providers: ["anthropic", "deepseek", "openai-codex"] });
  assert(metadata.ok);
  const reviewInput: ActionInput<"reviewStarterProfile"> = { ...target, expectedRevision: 0,
    metadata: ModelCatalogSnapshotSchema.parse(metadata.result),
    selection: { lane: { kind: "mixed" }, capability: 2, thinking: "medium", advisor: "off", spark: false, priority: false, prewalk: false, planYolo: false, fallback: true, budget: "any" } };
  const reviewed = await callAction(server, writer.token, "atyrode.code.reviewStarterProfile", reviewInput);
  assert(reviewed.ok, reviewed.ok ? "" : reviewed.denial.message);
  const document = (reviewed.result as { document: CatalogDocument }).document;
  const textOnly = { ...document, models: document.models.map(model => ({ ...model, images: false })) };
  const initialized = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { ...target, expectedRevision: 0 });
  assert(initialized.ok);
  const staged = await callAction(server, writer.token, "atyrode.code.stageCatalog", { ...target, expectedRevision: (initialized.result as Configuration).revision, document: textOnly });
  assert(staged.ok, staged.ok ? "" : staged.denial.message);
  await browser.goto(`${server.httpUrl}/p/${workspace.id}`);
  await control(browser, "staged text-only catalog keeps the workbench and task operable", taskField, false);
  assert.equal(await browser.evaluate("document.querySelectorAll('.plugin-atyrode_code_generator__routes > div').length"), 0, "An unresolved saved catalog is never silently replaced by bundled starter roles");
  await control(browser, "stored document has an explicit repair path", workspaceButton("Review in Models"), false);
  await click(browser, workspaceButton("Review in Models"));
  assert.deepEqual((await readConfiguration(server, writer, target)).configuration?.draft?.document, textOnly);
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
  let scope = reference.scope, status: OmpResult<"accounts">["status"] = "fresh", intercepting = true;
  const pending = new Set<Promise<void>>();
  let fixtureFailure: unknown;
  browser.on("Fetch.requestPaused", event => {
    if (!intercepting) return;
    const work = (async () => {
      const request = event.request as { url: string };
      if (new URL(request.url).pathname !== "/api/actions/atyrode.omp.accounts.accounts") {
        await browser.send("Fetch.continueRequest", { requestId: event.requestId as string });
        return;
      }
      const result: OmpResult<"accounts"> = { scope, status, observedAt: status === "unavailable" ? null : Date.now(), accounts: status === "fresh" ? [{
        reference: { ...reference, scope }, credentialId: reference.credentialId, type: "api_key", identityKey: null, email: null, disabled: false, blocks: [],
      }] : [] };
      await browser.send("Fetch.fulfillRequest", { requestId: event.requestId as string, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }],
        body: Buffer.from(JSON.stringify({ ok: true, result })).toString("base64") });
    })();
    pending.add(work);
    void work.catch(error => { fixtureFailure = error; }).finally(() => pending.delete(work));
  });
  await browser.send("Fetch.enable", { patterns: [{ urlPattern: `${server.httpUrl}/api/actions/atyrode.omp.accounts.accounts`, requestStage: "Request" }] });
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
    if (fixtureFailure) throw fixtureFailure;
  } finally {
    intercepting = false;
    await browser.send("Fetch.disable", {});
    await Promise.all([...pending]);
  }
}

/** Only transport failure/latency is injected. Every successful configuration and
 * metadata response, policy review and adoption still comes from the installed owners. */
async function starterObservationScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant): Promise<void> {
  let intercepting = true, hold = true, fail = true;
  let failed = 0;
  let action = "atyrode.omp.readModelCatalog";
  const held = new Set<() => void>();
  const pending = new Set<Promise<void>>();
  let fixtureFailure: unknown;
  const trace = await watchActions(browser, server);
  browser.on("Fetch.requestPaused", event => {
    if (!intercepting) return;
    const work = (async () => {
      const requestId = event.requestId as string;
      const request = event.request as { url: string };
      const name = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!);
      if (name !== action) { await browser.send("Fetch.continueRequest", { requestId }); return; }
      if (hold) await new Promise<void>(resolve => {
        const release = () => { held.delete(release); resolve(); };
        held.add(release);
      });
      if (fail) {
        failed++;
        await browser.send("Fetch.fulfillRequest", { requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }],
          body: Buffer.from(JSON.stringify({ ok: false, denial: { rule: "forbidden", message: "synthetic_starter_observation_failure" } })).toString("base64") });
      } else await browser.send("Fetch.continueRequest", { requestId });
    })();
    pending.add(work);
    void work.catch(error => { fixtureFailure = error; }).finally(() => pending.delete(work));
  });
  await browser.send("Fetch.enable", { patterns: ["atyrode.omp.readModelCatalog", "atyrode.code.readConfiguration"].map(name =>
    ({ urlPattern: `${server.httpUrl}/api/actions/${name}`, requestStage: "Request" })) });
  try {
    for (const observation of ["atyrode.omp.readModelCatalog", "atyrode.code.readConfiguration"]) {
      action = observation; hold = true; fail = true;
      const workspace = await createContainer(server, `Unavailable starter ${observation}`, "canvas");
      const target = { containerId: workspace.id };
      const retry = element(`${controls} button[data-action="${observation}"]`);
      await browser.goto(`${server.httpUrl}/p/${workspace.id}`);
      await waitFor(() => held.size > 0, timeout, 50);
      await control(browser, "a task is usable while its policy observation is loading", taskField, false);
      assert.equal(await browser.evaluate(`${starterSave} === null || ${starterSave}.disabled`), true,
        "Loading observations cannot authorize a save against an invented absent record");
      assert.equal(await browser.evaluate(`${element(routes)} === null`), true,
        "First-use roles are not fabricated while an authoritative prerequisite is pending");
      await click(browser, taskField);
      await browser.typeText("Retain task while authoritative observations recover.");
      hold = false;
      for (const release of [...held]) release();
      await control(browser, "a failed prerequisite offers an explicit retry", retry, false);
      assert(failed > 0);
      assert.equal(await browser.evaluate(`${starterSave} === null || ${starterSave}.disabled`), true,
        "An unavailable observation is not an empty configuration");
      assert.equal(await browser.evaluate(`${element(routes)} === null`), true);
      assert.deepEqual(await readConfiguration(server, writer, target), { configuration: null, legacyMachineId: null, revision: 0 });
      fail = false;
      await click(browser, retry);
      await usableStarter(browser);
      assert.equal(await browser.evaluate(`${taskField}.value`), "Retain task while authoritative observations recover.");
      await click(browser, `${dial("Thinking")}.querySelector('[data-value="max"]')`);
      const frozen = await readStarterDraft(browser);
      const routeText = await browser.evaluate<string>(`${element(routes)}.textContent`);
      fail = true;
      await click(browser, workspaceButton("Models"));
      await click(browser, workspaceButton("Workbench"));
      await control(browser, "later observation failure remains separately retryable", retry, false);
      assert.deepEqual(await readStarterDraft(browser), frozen, "Observation failure retains the original document, metadata and selected policy");
      assert.equal(await browser.evaluate(`${element(routes)}.textContent`), routeText, "Retained routes remain inspectable when current observations fail");
      await control(browser, "failed refresh cannot authorize a retained starter", starterSave, true);
      fail = false;
      await click(browser, retry);
      await until(browser, "real observation recovery removes its retry control", `${retry} === null`);
      assert.deepEqual(await readStarterDraft(browser), frozen, "Recovery never regenerates the local profile");
      assert.equal(await browser.evaluate(`${taskField}.value`), "Retain task while authoritative observations recover.");
      assert.equal((await readConfiguration(server, writer, target)).revision, 0, "Observation recovery never implicitly saves retained choices");
    }
    assert.deepEqual(trace.requests.filter(request => /^atyrode\.code\.(initializeConfiguration|adoptStarterProfile|stageCatalog|select)$/.test(request.name)), []);
    noNativeEffects(trace.requests);
    if (fixtureFailure) throw fixtureFailure;
  } finally {
    hold = false;
    for (const release of [...held]) release();
    await Promise.allSettled([...pending]);
    await browser.send("Fetch.disable", {});
    intercepting = false;
    trace.stop();
  }
}

/** Delay or refuse configuration transport only; successful reads still come from
 * the real server. These checks establish browser recovery, not native readiness. */
async function configurationRecoveryScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, firstUse: { containerId: string }, configured: Target): Promise<void> {
  let intercepting = true, holdConfiguration = true, failConfiguration = false;
  let failures = 0, recoveries = 0;
  const held = new Set<() => void>();
  const pending = new Set<Promise<void>>();
  let fixtureFailure: unknown;
  browser.on("Fetch.requestPaused", event => {
    if (!intercepting) return;
    const work = (async () => {
      const requestId = event.requestId as string;
      const request = event.request as { postData?: string };
      const input = JSON.parse(request.postData ?? "{}") as { containerId?: string };
      assert(input.containerId === firstUse.containerId || input.containerId === configured.containerId,
        "Configuration fault injection stays inside the two fixture workspaces");
      if (holdConfiguration) await new Promise<void>(resolve => {
        const release = () => { held.delete(release); resolve(); };
        held.add(release);
      });
      if (failConfiguration) {
        failures++;
        await browser.send("Fetch.fulfillRequest", { requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/json" }],
          body: Buffer.from(JSON.stringify({ ok: false, denial: { rule: "forbidden", message: "synthetic_configuration_read_failure" } })).toString("base64") });
      } else {
        if (input.containerId === configured.containerId) recoveries++;
        await browser.send("Fetch.continueRequest", { requestId });
      }
    })();
    pending.add(work);
    void work.catch(error => { fixtureFailure = error; }).finally(() => pending.delete(work));
  });
  await browser.send("Fetch.enable", { patterns: [{ urlPattern: `${server.httpUrl}/api/actions/atyrode.code.readConfiguration`, requestStage: "Request" }] });
  try {
    const workbenchControls = element(controls);
    const modal = "dialog.plugin-atyrode_code__permission-dialog:modal";
    for (const destinationView of ["Accounts", "Models"]) {
      holdConfiguration = true;
      await browser.goto(`${server.httpUrl}/p/${firstUse.containerId}`);
      await waitFor(() => held.size > 0, timeout, 50);
      await control(browser, "navigation remains available before configuration arrives", workspaceButton(destinationView), false);
      await click(browser, workspaceButton(destinationView));
      await until(browser, "navigation precedes the absent configuration", `${workspaceButton(destinationView)}.getAttribute('aria-current') === 'page'`);
      holdConfiguration = false;
      for (const release of [...held]) release();
      await until(browser, "absent configuration keeps local controls in the hidden workbench", `${workbenchControls} !== null && ${workbenchControls}.closest('[hidden]') !== null`);
      assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(modal)}) === null`), true,
        "A first-use review in a hidden frame must not make the visible document inert");
      await click(browser, workspaceButton("Accounts"));
      await key(browser, "Tab", 9);
      assert.equal(await browser.evaluate(`document.activeElement === ${workspaceButton("Models")}`), true,
        "Keyboard navigation still reaches the visible workbench after the absent read");
      await key(browser, "Enter", 13);
      await until(browser, "keyboard navigation still activates Models", `${workspaceButton("Models")}.getAttribute('aria-current') === 'page'`);
      await click(browser, workspaceButton("Workbench"));
      await until(browser, "first-use workbench appears without an automatic review", `${workbenchControls}?.getClientRects().length > 0 && ${element(modal)} === null`);
      await usableStarter(browser);
      await click(browser, workspaceButton("Setup"));
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
      await click(browser, workspaceButton("Models"));
      await click(browser, workspaceButton("Workbench"));
      assert.equal(await browser.evaluate(`${element(modal)} === null`), true,
        "Revisiting does not repeat an automatic first-use modal");
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
    if (fixtureFailure) throw fixtureFailure;
  } finally {
    holdConfiguration = false;
    for (const release of [...held]) release();
    await Promise.allSettled([...pending]);
    await browser.send("Fetch.disable", {});
    intercepting = false;
  }
}

async function manualCatalogScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant): Promise<void> {
  const document = { schemaVersion: 1, models: [1, 2, 3, 4].map(tier => ({
    key: `entry-model-tier-${tier}`, provider: "anthropic", id: `entry-native-tier-${tier}`, api: "anthropic-messages",
    tier, quotaBucket: null, inputCostPerMillion: tier, outputCostPerMillion: tier * 3,
    tokensPerSecond: 30, timeToFirstTokenMs: 100, contextWindow: 200_000,
    thinkingLevels: ["minimal", "low", "medium", "high"], images: true,
  })) };
  const promptField = element(`${generator} textarea[placeholder="What should we tackle?"]`);
  const importField = element(`${generator} .plugin-atyrode_code_generator__model-editor textarea:not([readonly])`);
  const exportField = element(`${generator} .plugin-atyrode_code_generator__model-editor textarea[readonly]`);
  const importSummary = `[...document.querySelectorAll('${generator} summary')].find(node => node.getClientRects().length && node.textContent === 'JSON import / export')`;
  const deployments = await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 });
  for (const competing of [false, true]) {
    const workspace = await createContainer(server, competing ? "Concurrent first catalog" : "Offline first catalog", "canvas");
    const target = { containerId: workspace.id };
    await browser.goto(`${server.httpUrl}/p/${workspace.id}`);
    await control(browser, "fresh workbench accepts a task before setup", promptField, false);
    await click(browser, promptField);
    await browser.typeText("Keep this task while I add my models.");
    await click(browser, workspaceButton("Models"));
    await click(browser, workspaceButton("Edit or import models"));
    await click(browser, importSummary);
    await click(browser, importField);
    await browser.typeText(JSON.stringify(document));
    await click(browser, workspaceButton("Import into draft"));
    assert.deepEqual(await readConfiguration(server, writer, target), { configuration: null, legacyMachineId: null, revision: 0 },
      "Typing a task and importing locally never initialize shared policy");
    if (competing) {
      const initialized = await callAction(server, writer.token, "atyrode.code.initializeConfiguration", { ...target, expectedRevision: 0 });
      assert(initialized.ok);
      await control(browser, "a competing initial save cannot rebase an absent-state draft", workspaceButton("Stage and review changes"), true);
      assert.deepEqual(JSON.parse(await browser.evaluate<string>(`${exportField}.value`)), document, "The rejected first-save draft remains exportable");
      assert.equal((await readConfiguration(server, writer, target)).revision, 1, "The stale first-save draft does not overwrite a competing initialization");
      await click(browser, workspaceButton("Workbench"));
      assert.equal(await browser.evaluate(`${promptField}.value`), "Keep this task while I add my models.");
      continue;
    }
    await click(browser, workspaceButton("Stage and review changes"));
    await control(browser, "first catalog is reviewed without native runtime setup", workspaceButton("Use this catalog"), false);
    const staged = await readConfiguration(server, writer, target);
    assert.equal(staged.revision, 2, "One explicit first save initializes once and stages once");
    assert.equal(staged.configuration?.active, null, "Review does not promote a catalog");
    assert.deepEqual(staged.configuration?.draft?.document, document);
    await click(browser, workspaceButton("Workbench"));
    assert.equal(await browser.evaluate(`${promptField}.value`), "Keep this task while I add my models.", "Staging retains the task across navigation");
    assert.deepEqual(await readConfiguration(server, writer, target), staged, "Returning to Workbench never replaces a successfully staged manual catalog");
    // Reopen against the canonical saved draft, with no earlier local starter attached.
    await browser.goto(`${server.httpUrl}/p/${workspace.id}`);
    await assertRoles(browser, false);
    assert.equal(await browser.evaluate(`${starterSave} === null`), true, "A saved staged record is not eligible for bundled adoption");
    const stagedModels = await browser.evaluate<string[]>(`[...document.querySelectorAll('${routes} .plugin-atyrode_code_generator__model-name')].map(el => el.textContent.trim())`);
    assert(stagedModels.every(key => document.models.some(model => model.key === key)), "The saved draft's own models lead its preview, not regenerated bundled choices");
    assert.deepEqual(await readConfiguration(server, writer, target), staged, "Opening an existing draft does not stage, promote or overwrite it");
    await click(browser, promptField);
    await browser.typeText("Keep this task while I add my models.");
    await click(browser, workspaceButton("Models"));
    await click(browser, element(`${generator} [aria-label="Model catalog"] [data-action="atyrode.code.reviewCatalog"]`));
    await control(browser, "saved manual changes retain their existing review path", workspaceButton("Use this catalog"), false);
    await click(browser, workspaceButton("Use this catalog"));
    await until(browser, "promoted models produce agent profiles in the ordinary workbench",
      `${element(`${generator} [aria-label="Generated profiles"] .plugin-atyrode_code_generator__routes`)}?.getClientRects().length > 0`);
    const promoted = await readConfiguration(server, writer, target);
    assert.equal(promoted.revision, 3);
    assert.deepEqual(promoted.configuration?.active?.document, document, "Promotion uses the exact reviewed catalog");
    assert.equal(await browser.evaluate(`${promptField}.value`), "Keep this task while I add my models.", "First catalog promotion preserves the task");
    await control(browser, "missing native runtime still prevents launch after local catalog authoring", launchControl, true);
  }
  assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), deployments,
    "First catalog authoring and conflicts never approve native access");
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
  let folderReady = false, intercepting = true;
  const pins = { installationRevision: "synthetic-folder-ui-only", artifactSha256: "e".repeat(64), resourceBindingDigest: "f".repeat(64) };
  const reviewDigest = "a".repeat(64);
  const requested: Record<string, unknown>[] = [], unrelatedApprovals: string[] = [];
  const pending = new Set<Promise<void>>();
  let fixtureFailure: unknown;
  browser.on("Fetch.requestPaused", event => {
    if (!intercepting) return;
    const work = (async () => {
      const requestId = event.requestId as string;
      const request = event.request as { url: string; postData?: string };
      const name = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!);
      const input = JSON.parse(request.postData ?? "{}") as Record<string, unknown>;
      let outcome: unknown;
      if (["engine.jobs.applyDeployment", "engine.jobs.execute", "atyrode.omp.gateway.configureGateway", "atyrode.omp.accounts.promoteAccountRuntime", "atyrode.code.configureServices"].includes(name)) {
        unrelatedApprovals.push(name);
        outcome = { ok: false, denial: { rule: "forbidden", message: "synthetic_ui_never_approves_native_access" } };
      } else if (name === "atyrode.omp.describeDestination") {
        assert.deepEqual(input, target);
        const result: OmpResult<"describeDestination"> = { ...target, pluginId: "atyrode.omp", state: "missing", reason: "synthetic_ui_only",
          services: [], deployment: null, operations: routes.map(route => {
            assert(packed.manifest.machine.operations[route.operation], "Synthetic scope must name a real upstream operation");
            const ready = folderReady && route === selected;
            return { operationId: route.operation, nativeReady: ready, callerRefusal: null, state: ready ? "ready" : "approval_required",
              reason: ready ? null : "native_consent_required", pins };
          }) };
        outcome = { ok: true, result };
      } else if (name === "engine.jobs.listRuns" && input.pluginId === "atyrode.omp" && routes.some(route => input.operationId === route.operation)) {
        assert.equal(input.machineId, target.machineId);
        outcome = { ok: true, result: { runs: [], nextCursor: null } };
      } else if (name === "atyrode.omp.reviewWorkspace") {
        assert.deepEqual(input, { ...target, mode: selected.mode });
        assert(folderReady);
        const result: OmpResult<"reviewWorkspace"> = { destination: target, operationId: selected.operation, pins, reviewDigest };
        outcome = { ok: true, result };
      } else if (name === "atyrode.omp.prepareWorkspace") {
        assert.deepEqual(input, { ...target, mode: selected.mode, reviewDigest }, "Preparation preserves the exact native destination, mode and review");
        requested.push(input);
        outcome = { ok: false, denial: { rule: "forbidden", message: "synthetic_folder_execution_refused" } };
      } else {
        await browser.send("Fetch.continueRequest", { requestId }); return;
      }
      await browser.send("Fetch.fulfillRequest", { requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(outcome)).toString("base64") });
    })();
    pending.add(work);
    void work.catch(error => { fixtureFailure = error; }).finally(() => pending.delete(work));
  });
  const arranged = await callAction(server, writer.token, "core.space.setLayout", { layout: {
    root: { id: "root", dir: "row", ratios: [1, 3], children: ["container", "code"], ref: null },
    container: { id: "container", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "core.shell.container-view" } },
    code: { id: "code", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "atyrode.code.generator.launcher" } },
  } });
  assert(arranged.ok);
  await browser.send("Fetch.enable", { patterns: [{ urlPattern: `${server.httpUrl}/api/actions/*`, requestStage: "Request" }] });
  try {
    await browser.goto(`${server.httpUrl}/p/${target.containerId}`);
    await selectDestination(browser, generatorDestination, target.machineId);
    await click(browser, workspaceButton("Setup"));
    await click(browser, workspaceButton("Folders"));
    const onboarding = element(`${generator} [aria-label="Code setup"]`);
    for (const route of routes) {
      selected = route; folderReady = false;
      await click(browser, workspaceButton("Setup"));
      for (const option of routes) {
        await control(browser, "unapproved folders offer only explicit scope review", workspaceButton(`Review: ${option.label}`), false);
        assert.equal(await browser.evaluate(`${element(`${generator} section[aria-label="${option.label}"] button[data-action="atyrode.omp.prepareWorkspace"]`)} === null`), true,
          "Unapproved folder scope cannot be executed");
      }
      folderReady = true;
      await click(browser, workspaceButton("Setup"));
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
    if (fixtureFailure) throw fixtureFailure;
  } finally {
    await Promise.allSettled([...pending]);
    await browser.send("Fetch.disable", {});
    intercepting = false;
  }
  assert.deepEqual(await readConfiguration(server, writer, target), saved, "Synthetic folder transitions never mutate real Code choices");
  assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), deployments,
    "Synthetic folder readiness is not native approval evidence and creates no deployments");
}

/** Synthetic OMP/terminal observations exercise browser decisions only. Native
 * preparation refuses; public terminal navigation uses synthetic correlations.
 * This cannot create credentials, approve consent or open a new terminal. */
async function syntheticPreviewScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, first: Target, second: Target): Promise<void> {
  let saved = await readConfiguration(server, writer, first);
  assert(saved.configuration?.active && saved.configuration.selection);
  const packed = JSON.parse(readFileSync(join(ompBundleDirectory, "atyrode.omp.manifold-plugin.json"), "utf8")) as {
    manifest: { machine: { operations: Record<string, unknown> } };
  };
  const operationId = "atyrode.omp.launch";
  assert(packed.manifest.machine.operations[operationId], "Synthetic review names the installed upstream launch operation");
  const pins = { installationRevision: "synthetic-ui-only", artifactSha256: "b".repeat(64), resourceBindingDigest: "c".repeat(64) };
  const reviewDigest = "d".repeat(64);
  const defaults = await callAction(server, writer.token, "atyrode.omp.readDefaults", {});
  assert(defaults.ok);
  const defaultsRevision = (defaults.result as OmpResult<"readDefaults">).revision;
  let prepareRequests = 0, holdNextPreview = false, intercepting = true;
  let reviewedInput: Record<string, unknown> | null = null;
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
  let sessionVisible = true;
  const resumedInputs: Record<string, unknown>[] = [];
  const savedSessionId = "7ab82ad4-8c9e-4166-8130-472c7cae1559";
  const fleetMachines = (await ownerAction(server, "core.machines.list", {}) as { machines: MachineSummary[] }).machines;
  const realTerminals = await ownerAction(server, "core.terminals.listAll", {});
  const terminalBase: TerminalSummary = { id: "synthetic-legacy", machineId: first.machineId, name: "Synthetic saved work",
    createdAt: 1000, status: "running", exitCode: null, homeId: first.containerId, unplaced: false };
  let fleetTerminals: TerminalSummary[] = [terminalBase, { ...terminalBase, id: "synthetic-second", machineId: second.machineId,
    session: { harness: "atyrode.omp", machineId: second.machineId, sessionId: savedSessionId } }];
  let secondInventoryFailed = false, terminalInventoryFailed = false, holdNextInventory = false;
  const inventoryHeld = { release: null as (() => void) | null };
  const navigations: string[] = [];
  browser.on("Page.navigatedWithinDocument", event => { navigations.push(event.url as string); });
  const fleetMachine = (machineId: string) => `${generator} [data-fleet-machine=\"${machineId}\"]`;
  const listMachine = (machineId: string) => element(`${fleetMachine(machineId)} [data-action=\"atyrode.omp.listSessions\"]`);
  const sessionSelect = `${fleetMachine(first.machineId)} select`;
  const held = { release: null as (() => void) | null };
  let fixtureFailure: unknown;
  const pending = new Set<Promise<void>>();
  browser.on("Fetch.requestPaused", event => {
    if (!intercepting) return;
    const work = (async () => {
      const requestId = event.requestId as string;
      const request = event.request as { url: string; postData?: string };
      const name = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1)!);
      const input = JSON.parse(request.postData ?? "{}") as Record<string, unknown>;
      let outcome: unknown;
      if (name === "core.machines.list") {
        outcome = { ok: true, result: { machines: fleetMachines } };
      } else if (name === "core.terminals.listAll") {
        outcome = terminalInventoryFailed ? { ok: false, denial: { rule: "forbidden", message: "synthetic_terminal_inventory_failed" } }
          : { ok: true, result: { terminals: fleetTerminals } };
      } else if (name === "atyrode.omp.accounts.accounts") {
        const scope = "browser-fixture-account-scope";
        const result: OmpResult<"accounts"> = { scope, status: "fresh", observedAt: Date.now(), accounts: [1, 7].map(credentialId => ({
          reference: { kind: "credential", scope, provider: "anthropic", credentialId }, credentialId,
          type: "api_key", identityKey: null, email: null, disabled: false, blocks: [],
        })) };
        outcome = { ok: true, result };
      } else if (name === "atyrode.omp.describeDestination") {
        assert.equal(input.containerId, first.containerId);
        assert(input.machineId === first.machineId || input.machineId === second.machineId);
        const ready = input.machineId === first.machineId;
        const result: OmpResult<"describeDestination"> = { containerId: first.containerId, machineId: input.machineId, pluginId: "atyrode.omp",
          state: ready ? "ready" : "missing", reason: ready ? null : "synthetic_unprepared_destination", deployment: null, services: [],
          operations: [{ operationId, pins, nativeReady: ready, callerRefusal: null, state: ready ? "ready" : "missing", reason: ready ? null : "native_resources_missing" }] };
        outcome = { ok: true, result };
      } else if (name === "atyrode.omp.readSkillCatalog") {
        outcome = { ok: true, result: input.machineId === first.machineId ? skillCatalog
          : { revision: 0, skills: [], sets: [], updatedAt: null, updatedBy: null } };
      } else if (name === "atyrode.omp.reviewSession") {
        assert.equal(input.containerId, first.containerId);
        assert.equal(input.machineId, first.machineId, "An unprepared destination cannot request a session review");
        assert.equal(input.expectedDefaultsRevision, defaultsRevision);
        reviewedInput = input;
        const choice = input.skills as OmpInput<"reviewSession">["skills"];
        if (choice?.mode === "select") {
          assert.equal(choice.expectedCatalogRevision, skillCatalog.revision);
          const ids = new Set([...choice.skillIds, ...choice.setIds.flatMap(id => skillCatalog.sets.find(set => set.id === id)!.skillIds)]);
          reviewedSkills = { mode: "selected", catalogRevision: skillCatalog.revision,
            selected: skillCatalog.skills.filter(skill => ids.has(skill.id)) };
        } else reviewedSkills = { mode: choice?.mode === "disabled" || input.automation ? "disabled" : "preserve", catalogRevision: null, selected: [] };
        if (holdNextPreview) { holdNextPreview = false; await new Promise<void>(resolve => { held.release = resolve; }); held.release = null; }
        outcome = { ok: true, result: { destination: first, operationId, pins, reviewDigest, defaultsRevision,
          effectiveOverlay: input.overlay, accountPool: input.accountPool,
          automation: input.automation ?? { mode: "ordinary" },
          skills: reviewedSkills } };
      } else if (name === "atyrode.omp.prepareSession") {
        prepareRequests++;
        const { skills: _draftSkills, ...reviewed } = reviewedInput!;
        const skills = reviewedSkills.mode === "selected" ? { mode: "select",
          expectedCatalogRevision: reviewedSkills.catalogRevision, skillIds: reviewedSkills.selected.map(skill => skill.id), setIds: [] }
          : reviewedSkills.mode === "disabled" ? { mode: "disabled" } : undefined;
        assert.deepEqual(input, { ...reviewed, ...(skills ? { skills } : {}), reviewDigest },
          "Prepare consumes native-reviewed effective selection, including canonical set expansion");
        outcome = { ok: false, denial: { rule: "forbidden", message: "omp_review_changed" } };
      } else if (name === "atyrode.omp.listSessions") {
        assert(input.machineId === first.machineId || input.machineId === second.machineId);
        if (holdNextInventory && input.machineId === first.machineId) {
          holdNextInventory = false;
          await new Promise<void>(resolve => { inventoryHeld.release = resolve; }); inventoryHeld.release = null;
        }
        outcome = input.machineId === second.machineId && secondInventoryFailed
          ? { ok: false, denial: { rule: "forbidden", message: "synthetic_inventory_failed" } }
          : { ok: true, result: sessionVisible ? [{ id: savedSessionId, title: "Synthetic saved work", cwd: "/workspace", updatedAt: 1000 }] : [] };
      } else if (name === "atyrode.omp.resumeSession") {
        resumedInputs.push(input);
        outcome = { ok: false, denial: { rule: "forbidden", message: "omp_session_unavailable" } };
      } else {
        await browser.send("Fetch.continueRequest", { requestId }); return;
      }
      await browser.send("Fetch.fulfillRequest", { requestId, responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(outcome)).toString("base64") });
    })();
    pending.add(work);
    void work.catch(error => { fixtureFailure = error; }).finally(() => pending.delete(work));
  });
  await browser.send("Fetch.enable", { patterns: [{ urlPattern: `${server.httpUrl}/api/actions/*`, requestStage: "Request" }] });
  try {
    await browser.goto(`${server.httpUrl}/p/${first.containerId}`);
    await selectDestination(browser, generatorDestination, first.machineId);
    await control(browser, "synthetic first destination review enabled", launchControl, false);
    await click(browser, launchControl);
    await until(browser, "synthetic first destination review displayed", `${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed === 'true'`);
    await click(browser, element(`${generator} [data-session-options] > summary`));
    const skillControl = (label: string) => `[...document.querySelectorAll('${generator} [aria-label="Optional skills"] label')].find(el => el.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector('input')`;
    await click(browser, skillControl("Reviewed pair"));
    await click(browser, skillControl("Alpha"));
    await click(browser, launchControl);
    await until(browser, "overlapping skill selection is native-reviewed", `${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed === 'true'`);
    assert.deepEqual(await browser.evaluate(`[...document.querySelectorAll('${generator} [aria-label="Selected optional skills"] li strong')].map(el => el.textContent)`),
      ["Alpha", "Gamma"], "A set and individual choice render one effective selection without duplicates");
    await click(browser, launchControl);
    await until(browser, "selected-skill preparation refusal is visible", `${element(`${generator} .plugin-atyrode_code_generator__feedback`)}?.dataset.failed === 'true'`);
    await click(browser, skillControl("Beta"));
    await control(browser, "declared skill conflict prevents review", launchControl, true);
    await click(browser, skillControl("Beta"));
    await control(browser, "resolving the conflict restores review", launchControl, false);
    skillCatalog.revision++;
    await click(browser, workspaceButton("Refresh skill catalog"));
    await control(browser, "stale catalog cannot silently rebase selection", launchControl, true);
    await click(browser, workspaceButton("Clear optional choices"));
    await control(browser, "cleared draft can be reviewed independently", launchControl, false);
    await click(browser, workspaceButton("Disable all skills"));
    assert.equal(await browser.evaluate(`${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed`), "false", "Changing skill mode invalidates an existing native review");
    await click(browser, launchControl);
    await until(browser, "disable-all review is displayed", `${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed === 'true'`);
    assert.deepEqual((reviewedInput as Record<string, unknown> | null)?.skills, { mode: "disabled" }, "The actual browser sends disable-all through the ordinary workflow");
    const automationControl = (label: string) => `[...document.querySelectorAll('${generator} .plugin-atyrode_code_generator__automation label')].find(el => el.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input')`;
    await click(browser, automationControl("Restricted automation"));
    await click(browser, automationControl("read"));
    await click(browser, workspaceButton("Clear optional choices"));
    assert.equal(await browser.evaluate(`${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed`), "false");
    await click(browser, launchControl);
    await until(browser, "native restricted policy is rendered", `${element(`${generator} [data-effective-automation]`)}?.dataset.effectiveAutomation === 'restricted'`);
    assert.deepEqual((reviewedInput as Record<string, unknown> | null)?.automation, { mode: "restricted", toolNames: ["read"], delegation: "disabled" });
    assert.equal((reviewedInput as Record<string, unknown> | null)?.skills, undefined, "Restricted review suppresses ambient defaults even without an explicit skill choice");
    await click(browser, launchControl);
    await until(browser, "restricted preparation refusal is visible", `${element(`${generator} .plugin-atyrode_code_generator__feedback`)}?.dataset.failed === 'true'`);
    await click(browser, automationControl("read"));
    assert.equal(await browser.evaluate(`${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed`), "false", "Tool changes consume native review");
    await click(browser, automationControl("Ordinary session"));
    const preparationsBeforeDestinationChange = prepareRequests;
    await selectDestination(browser, generatorDestination, second.machineId);
    await control(browser, "second destination cannot reuse first destination review", launchControl, true);
    assert.equal(await browser.evaluate(`${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed`), "false", "Changing destination invalidates the existing review");
    assert.equal(prepareRequests, preparationsBeforeDestinationChange, "Destination selection never prepares a launch");
    await selectDestination(browser, generatorDestination, first.machineId);
    await control(browser, "returning destination requires another review", launchControl, false);
    assert.equal(await browser.evaluate(`${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed`), "false", "Returning to a machine cannot resurrect its earlier review");
    holdNextPreview = true;
    await click(browser, launchControl);
    await waitFor(() => held.release !== null, timeout, 50);
    await selectDestination(browser, generatorDestination, second.machineId);
    await control(browser, "second destination remains fenced while a review is in flight", launchControl, true);
    await selectDestination(browser, generatorDestination, first.machineId);
    held.release!();
    await control(browser, "late first-machine review remains invalid", launchControl, false);
    assert.equal(await browser.evaluate(`${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed`), "false", "In-flight reviews are fenced across a round-trip destination change");
    holdNextPreview = true;
    await click(browser, launchControl);
    await waitFor(() => held.release !== null, timeout, 50);
    await click(browser, taskField);
    await browser.send("Input.insertText", { text: "x" });
    await key(browser, "Backspace", 8);
    held.release!();
    await control(browser, "round-trip prompt change fences late review", launchControl, false);
    assert.equal(await browser.evaluate(`${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed`), "false");
    await click(browser, launchControl);
    await until(browser, "current synthetic review displayed", `${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed === 'true'`);
    await click(browser, launchControl);
    await until(browser, "synthetic launch refusal is shown", `${element(`${generator} .plugin-atyrode_code_generator__feedback`)}?.dataset.failed === 'true'`);
    assert.equal(await browser.evaluate(`${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed`), "false", "A refused launch consumes its browser review");
    const savedSessions = element(`${generator} [data-saved-sessions]`);
    await click(browser, `${savedSessions}.querySelector(':scope > summary')`);
    await click(browser, listMachine(first.machineId));
    await until(browser, "first machine metadata settles before the next pointer target moves", `${element(`${fleetMachine(first.machineId)} [data-session-activity=\"unknown\"]`)} !== null`);
    await click(browser, listMachine(second.machineId));
    await until(browser, "both machines expose native metadata independently", `${element(`${fleetMachine(first.machineId)} [data-session-activity=\"unknown\"]`)} !== null && ${element(`${fleetMachine(second.machineId)} [data-session-activity=\"running\"]`)} !== null`);
    assert.equal(await browser.evaluate(`${element(`${fleetMachine(first.machineId)} [data-terminal-home]`)} === null`), true, "Legacy name/header similarity does not fabricate a current workspace");
    assert.equal(await browser.evaluate(`${element(`${fleetMachine(second.machineId)} [data-terminal-home]`)}.textContent`), first.containerId, "Only exact terminal correlation exposes its authoritative current home");
    await selectDestination(browser, sessionSelect, savedSessionId);
    await click(browser, workspaceButton("Resume saved state"));
    await until(browser, "saved-state refusal is visible", `${element(`${generator} .plugin-atyrode_code_generator__feedback`)}?.dataset.failed === 'true'`);
    assert.deepEqual(resumedInputs[0], { machineId: first.machineId, sessionId: savedSessionId }, "Preserve resume must not silently inject a profile");
    await click(browser, automationControl("Restricted automation"));
    await click(browser, automationControl("read"));
    await click(browser, workspaceButton("Resume with this profile"));
    await until(browser, "Plan-YOLO profile refuses before native resume",
      `${element(`${generator} .plugin-atyrode_code_generator__feedback`)}?.textContent.includes('omp_resume_plan_unsupported') === true`);
    assert.equal(resumedInputs.length, 1, "Unsupported profile policy must not be silently dropped");
    assert.deepEqual(await readConfiguration(server, writer, first), saved, "Native observations and refusals never change saved choices");
    await click(browser, workspaceButton("Workbench"));
    const extraDials = element(`${generator} .plugin-atyrode_code_generator__extra-dials`);
    if (!await browser.evaluate(`${extraDials}.open`)) await click(browser, `${extraDials}.querySelector('summary')`);
    const plans = `[...document.querySelectorAll('${generator} [role="radiogroup"]')].find(el => document.getElementById(el.getAttribute('aria-labelledby'))?.textContent === 'Plans')`;
    await click(browser, `${plans}.querySelector('[data-value="false"]')`);
    await click(browser, profileSave);
    await until(browser, "supported resume profile is saved", `${element(`${generator} .plugin-atyrode_code_generator__draft`)} === null`);
    const supported = await readConfiguration(server, writer, first);
    assert(supported.configuration);
    assert.deepEqual(supported, { ...saved, revision: saved.revision + 1, configuration: {
      ...saved.configuration, revision: saved.configuration!.revision + 1,
      updatedAt: supported.configuration.updatedAt, updatedBy: supported.configuration.updatedBy,
      selection: { ...saved.configuration!.selection, planYolo: false },
    } }, "The explicit profile save changes only its chosen policy and revision metadata");
    saved = supported;
    await selectDestination(browser, sessionSelect, savedSessionId);
    await click(browser, workspaceButton("Resume with this profile"));
    await until(browser, "explicit profile resume refusal is visible", `${element(`${generator} .plugin-atyrode_code_generator__feedback`)}?.dataset.failed === 'true'`);
    assert.equal(resumedInputs.length, 2);
    const explicit = ResumeSessionInputSchema.parse(resumedInputs[1]);
    assert.equal(explicit.machineId, first.machineId);
    assert.equal(explicit.sessionId, savedSessionId);
    assert.deepEqual(explicit.overlay, (reviewedInput as Record<string, unknown> | null)?.overlay);
    assert.deepEqual(explicit.accountPool, (reviewedInput as Record<string, unknown> | null)?.accountPool);
    assert.deepEqual(explicit.automation, { mode: "restricted", toolNames: ["read"], delegation: "disabled" });
    assert(explicit.overrides?.model && explicit.overrides.thinking && explicit.overlay?.modelRoles?.default);
    assert.equal(explicit.overrides.model, explicit.overlay.modelRoles.default);
    assert.equal(explicit.overrides.thinking, explicit.overrides.model.split(":").at(-1));
    secondInventoryFailed = true;
    await click(browser, listMachine(second.machineId));
    await until(browser, "per-machine inventory failure is not empty", `${element(fleetMachine(second.machineId))}.dataset.inventoryState === 'failed'`);
    fleetMachines.find(machine => machine.id === second.machineId)!.online = false;
    await click(browser, workspaceButton("Refresh machines"));
    await until(browser, "offline inventory remains unavailable", `${element(fleetMachine(second.machineId))}.dataset.inventoryState === 'unavailable'`);
    await selectDestination(browser, generatorDestination, second.machineId);
    assert.equal(await browser.evaluate(`${element(generatorDestination)}.value`), second.machineId, "An offline destination is preserved, not replaced");
    await control(browser, "offline saved resume is refused", workspaceButton("Resume saved state"), true);
    await selectDestination(browser, generatorDestination, first.machineId);
    holdNextInventory = true;
    await click(browser, listMachine(first.machineId));
    await waitFor(() => inventoryHeld.release !== null, timeout, 50);
    await selectDestination(browser, generatorDestination, second.machineId);
    await selectDestination(browser, generatorDestination, first.machineId);
    inventoryHeld.release!();
    await until(browser, "late inventory cannot repopulate a round-trip destination", `${element(fleetMachine(first.machineId))}.dataset.inventoryState === 'not-requested'`);
    assert.equal(await browser.evaluate(`${element(sessionSelect)} === null`), true);
    await click(browser, listMachine(first.machineId));
    await selectDestination(browser, sessionSelect, savedSessionId);
    holdNextInventory = true;
    await click(browser, workspaceButton("Resume saved state"));
    await waitFor(() => inventoryHeld.release !== null, timeout, 50);
    await selectDestination(browser, generatorDestination, second.machineId);
    await selectDestination(browser, generatorDestination, first.machineId);
    inventoryHeld.release!();
    await control(browser, "late resume preflight releases without native preparation", listMachine(first.machineId), false);
    assert.equal(resumedInputs.length, 2, "A destination round trip fences the pending resume effect");
    await click(browser, listMachine(first.machineId));
    await selectDestination(browser, sessionSelect, savedSessionId);
    terminalInventoryFailed = true;
    await click(browser, workspaceButton("Resume saved state"));
    await until(browser, "failed terminal refresh refuses resume", `${element(`${generator} .plugin-atyrode_code_generator__feedback`)}?.dataset.failed === 'true'`);
    assert.equal(resumedInputs.length, 2, "Unknown terminal inventory failure cannot authorize resume");
    terminalInventoryFailed = false;
    sessionVisible = false;
    await click(browser, listMachine(first.machineId));
    await until(browser, "removed saved session becomes empty", `${element(fleetMachine(first.machineId))}.dataset.inventoryState === 'empty'`);
    await control(browser, "disappeared saved state cannot be resumed", workspaceButton("Resume saved state"), true);
    await control(browser, "disappeared session cannot receive profile overrides", workspaceButton("Resume with this profile"), true);
    sessionVisible = true;
    await click(browser, listMachine(first.machineId));
    await selectDestination(browser, sessionSelect, savedSessionId);
    // The terminal appears after the user's selection. The fresh pre-resume read must
    // navigate to that exact public terminal without invoking OMP preparation.
    holdNextInventory = true;
    await click(browser, workspaceButton("Resume saved state"));
    await waitFor(() => inventoryHeld.release !== null, timeout, 50);
    fleetTerminals = [{ ...terminalBase, id: "synthetic-exact",
      session: { harness: "atyrode.omp", machineId: first.machineId, sessionId: savedSessionId } }];
    inventoryHeld.release!();
    const terminalRoute = `/uri/${encodeURIComponent(formatManifoldUri({ kind: "terminal", terminalId: "synthetic-exact" }))}`;
    await waitFor(() => navigations.some(url => new URL(url).pathname === terminalRoute), timeout, 50);
    assert.equal(resumedInputs.length, 2, "A newly correlated running session reopens instead of preparing a replacement");
    await until(browser, "public terminal URI resolves back to the authoritative home", `location.pathname === ${JSON.stringify(`/p/${first.containerId}`)} && ${element(fleetMachine(first.machineId))} !== null`);
    if (!await browser.evaluate(`${savedSessions}.open`)) await click(browser, `${savedSessions}.querySelector(':scope > summary')`);
    await click(browser, listMachine(first.machineId));
    const reopenButton = element(`${fleetMachine(first.machineId)} [data-action="reopen-session"]`);
    await control(browser, "exact running terminal exposes native reopen", reopenButton, false);
    const navigationCount = navigations.filter(url => new URL(url).pathname === terminalRoute).length;
    await click(browser, reopenButton);
    await waitFor(() => navigations.filter(url => new URL(url).pathname === terminalRoute).length > navigationCount, timeout, 50);
    assert.equal(resumedInputs.length, 2, "Explicit reopen never prepares a replacement");
    assert.deepEqual(await ownerAction(server, "core.terminals.listAll", {}), realTerminals, "Fleet actions never create a terminal");
    if (fixtureFailure) throw fixtureFailure;
  } finally {
    held.release?.();
    inventoryHeld.release?.();
    await Promise.allSettled([...pending]);
    await browser.send("Fetch.disable", {});
    intercepting = false;
  }
  assert.deepEqual(await readConfiguration(server, writer, first), saved, "Synthetic observations never change real saved choices");
}

async function run(): Promise<void> {
  // Fail before allocating fixture state if prerequisites are absent. Never pack as
  // fallback: the positional argument is also how CI proves an older artifact fails.
  Browser.detect();
  const expectedRevision = readFileSync(join(pluginRoot, "MANIFOLD_REV"), "utf8").trim();
  const revision = Bun.spawnSync(["git", "-C", manifold, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  assert(revision.success && revision.stdout.toString().trim() === expectedRevision, "MANIFOLD_DIR must be checked out at plugins/MANIFOLD_REV");
  const bundles = [...ompFamily.map(id => ({ id, directory: ompBundleDirectory })), ...family.map(id => ({ id, directory: bundleDirectory }))].map(({ id, directory }) => {
    const file = join(directory, `${id}.manifold-plugin.json`);
    assert(existsSync(file), `Missing prepacked bundle: ${id}`);
    return { id, file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
  });
  const directory = mkdtempSync(join(tmpdir(), "code-browser-"));
  const dataDir = join(directory, "server");
  const home = join(directory, "home");
  mkdirSync(home);
  const writerBrowser = new Browser();
  const viewerBrowser = new Browser();
  let server: TestServer | undefined;
  let agent: TestAgent | undefined;
  let secondAgent: TestAgent | undefined;
  let dist: { readonly distDir: string; readonly cleanup: () => void } | undefined;
  let phase = "fixture startup";
  let failure: unknown;
  const cleanupFailures: string[] = [];
  try {
    dist = resolveWebDist("code-browser-web-");
    server = await startServer({ dataDir, ownerKey: randomBytes(32).toString("hex"), spawnAgent: false,
      env: { MANIFOLD_BIND: "127.0.0.1", MANIFOLD_WEB_DIST: dist.distDir, MANIFOLD_PLUGIN_DEV_PATHS: "1", HOME: home } });
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
    agent = await startAgent({ serverUrl: server.url, machineToken: enrolled.machineToken, name: machineName,
      env: { HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_CONFIG_HOME: join(home, "config") } });
    assert.equal(agent.machineId, enrolled.machineId, "Fixture machine enrollment must match the live transport");
    const secondName = "Code browser second destination";
    const secondEnrolled = await enrollMachine(server, secondName);
    secondAgent = await startAgent({ serverUrl: server.url, machineToken: secondEnrolled.machineToken, name: secondName,
      env: { HOME: home, XDG_STATE_HOME: join(home, "second-state"), XDG_CONFIG_HOME: join(home, "second-config") } });
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
        const prefix = `${server!.httpUrl}/api/actions/`;
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
    await waitFor(async () => (await readConfiguration(server!, viewer, target)).configuration?.accounts.presets.some(row => row.name === presetName) === true, timeout, 50);
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
    await sharedWorkbenchScenario(writerBrowser, server, writer, viewer, target, secondTarget);

    phase = "initial capability checklist without native approval";
    const firstUse = await createContainer(server, "Code first-use permissions", "canvas");
    const arranged = await callAction(server, writer.token, "core.space.setLayout", { layout: {
      root: { id: "root", dir: "row", ratios: [1, 3], children: ["container", "code"], ref: null },
      container: { id: "container", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "core.shell.container-view" } },
      code: { id: "code", dir: null, ratios: [], children: [], ref: { kind: "panel", panelId: "atyrode.code.generator.launcher" } },
    } });
    assert(arranged.ok, "Writer can open the ordinary Code workspace surface");
    await writerBrowser.goto(`${server.httpUrl}/p/${firstUse.id}`);
    await usableStarter(writerBrowser);
    assert.equal(await writerBrowser.evaluate(`${element(permissionDialog)} === null`), true,
      "Bundled starter does not open a permission dialog");
    await click(writerBrowser, workspaceButton("Setup"));
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
    assert.equal((await readConfiguration(server, writer, { containerId: firstUse.id })).configuration, null,
      "Initial choices and closing review do not initialize or promote a profile");
    assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), permissionsBefore);
    phase = "bundled starter composition and atomic adoption";
    await starterWorkbenchScenario(writerBrowser, server, writer, target);
    phase = "starter observation failures are not absence";
    await starterObservationScenario(writerBrowser, server, writer);
    phase = "manual catalog authoring and concurrent first-save refusal";
    await manualCatalogScenario(writerBrowser, server, writer);
    phase = "deferred first-use and standalone Usage configuration recovery";
    await configurationRecoveryScenario(writerBrowser, server, writer, { containerId: firstUse.id }, target);
    phase = "unresolved staged catalogs preserve model repair and task entry";
    await unresolvedStagedCatalogScenario(writerBrowser, server, writer);
    phase = "synthetic account-scope recovery retains referenced fresh evidence";
    await syntheticScopeRecoveryScenario(writerBrowser, server, writer);
    phase = "synthetic independent folder-only UI readiness";
    await syntheticFolderReadinessScenario(writerBrowser, server, writer, target);
    phase = "synthetic preview UI invalidation boundary";
    await syntheticPreviewScenario(writerBrowser, server, writer, target, secondTarget);
    phase = "proof complete";
  } catch (error) {
    // Driver diagnostics can contain admission URLs. Report only the phase and local
    // verifier line numbers, never driver messages or captured page-console output.
    const frames = error instanceof Error ? error.stack?.match(/verify-browser\.ts:\d+:\d+/g)?.slice(0, 4).join(", ") : undefined;
    failure = error instanceof assert.AssertionError || error instanceof ProofFailure
      ? new Error(`Browser proof failed during ${phase}: ${error.message}`)
      : new Error(`Browser proof failed during ${phase}${frames ? `; local frames: ${frames}` : ""}`);
  } finally {
    const cleanup = async (name: string, action: () => unknown | Promise<unknown>) => {
      try { await action(); } catch { cleanupFailures.push(name); }
    };
    await cleanup("writer browser", () => writerBrowser.close());
    await cleanup("viewer browser", () => viewerBrowser.close());
    await cleanup("fixture machine", () => agent?.stop());
    await cleanup("second fixture machine", () => secondAgent?.stop());
    await cleanup("fixture server", () => server?.stop());
    await cleanup("fixture data", () => rmSync(directory, { recursive: true, force: true }));
    await cleanup("generated web bundle", () => dist?.cleanup());
  }
  if (cleanupFailures.length) throw new Error(`Cleanup failed: ${cleanupFailures.join(", ")}${failure ? `; proof failed during ${phase}` : ""}`);
  if (failure) throw failure;
  console.log("PASS: packed Code in two real browsers and two permitted destinations; shared choices converge with viewer authority intact. Genuine pinned OMP metadata yields editable first-use controls and the complete role roster without runtime setup; explicit nondefault adoption saves catalog and selection in one CAS and preserves initialized account choices. Conflicted local material stays exportable without revision-zero rebasing; configuration/metadata failures are not absence. Manual Models import, staging, saved-draft review and exact promotion remain available. Wide/narrow reflow, keyboard/touch, focus/Escape, reduced motion and non-focus-stealing hover help preserve drafts/tasks. Existing skills, automation, resume, native permission, folder readiness and refusal boundaries remain exercised; no provider/native-runtime/consent proof claimed.");
}

await run();
