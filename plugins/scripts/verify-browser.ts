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
import type { ActionResult } from "../atyrode.code/contract.ts";
import type { ActionResult as OmpResult } from "@atyrode/manifold-omp";
import type { PermissionPlan } from "../atyrode.code/permission-plan.ts";

const HELP = `Usage: bun plugins/scripts/verify-browser.ts [bundle-directory]
Uses four prepacked Code bundles (default: plugins/dist) and three real upstream OMP bundles
(default: plugins/.integration/omp/plugins/dist; CODE_OMP_BUNDLES_DIR may explicitly override), never Code source.
MANIFOLD_DIR selects the pinned SDK checkout; default: the sibling manifold directory.
Requires installed SDK dependencies and Chromium (MANIFOLD_CHROMIUM may select its binary).
MANIFOLD_GATE_DIST may supply an existing SDK web build; otherwise gate-dist builds a
throwaway web bundle. Missing Chromium or any failed assertion is a failure, not a skip.
Starts only a disposable loopback server and an isolated testkit machine transport/terminal
host. No native job owner, native setup, terminals, OMP, inference or providers are invoked.
Proves real independent permission choices, refusal without owner authority, container-shared
choices and drafts across two destinations, deferred first-use dialogs and configuration-error
recovery. Separate synthetic RPC responses exercise independent folder-only control readiness
and preview invalidation/refusal; their readiness is not native execution or consent evidence.
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
  const point = await browser.evaluate<{ x: number; y: number }>(`(async () => {
    const el = ${expression};
    if (!(el instanceof HTMLElement) || el.matches(':disabled')) throw new Error('Control unavailable');
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const frame = Promise.withResolvers();
    requestAnimationFrame(frame.resolve);
    await frame.promise;
    const rect = el.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (rect.width <= 0 || rect.height <= 0 || !hit || !el.contains(hit)) throw new Error('Control occluded');
    return { x, y };
  })()`);
  await browser.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
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

async function openWorkspace(browser: BrowserInstance, server: TestServer, grant: TokenGrant, containerId: string): Promise<void> {
  await browser.launch({ incognito: true });
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

const generator = ".plugin-atyrode_code_generator";
const generatorDestination = `${generator} .plugin-atyrode_code_generator__machine select`;
const launchControl = element(`${generator} .plugin-atyrode_code_generator__launch-bar button`);
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
  const promptField = element(`${generator} .plugin-atyrode_code_generator__launch textarea`);
  await control(browser, "shared active profile ready", promptField, false);
  const prompt = "Retain this task while choosing where OMP will execute.";
  await click(browser, promptField);
  await browser.typeText(prompt);
  const thinking = `[...document.querySelectorAll('${generator} [role="radiogroup"]')].find(el => document.getElementById(el.getAttribute('aria-labelledby'))?.textContent === 'Thinking')`;
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
  const accountDraft = element(`${generator} .plugin-atyrode_code__accounts form[aria-label="Profile editor"] input[required]`);
  await control(browser, "shared account editor has opened", accountDraft, false);
  await click(browser, accountDraft);
  await key(browser, "End", 35);
  await browser.typeText(" local draft");
  const accountDraftName = `${preset.name} local draft`;
  await click(browser, workspaceButton("Models"));
  await selectDestination(browser, generatorDestination, second.machineId);
  assert.equal(await browser.evaluate(`${workspaceButton("Models")}.getAttribute('aria-current')`), "page", "Visited catalog view survives the destination switch");
  assert.equal(await browser.evaluate(`${importField}.value`), importDraft, "Unparsed JSON import stays local across machines");
  assert.equal(await browser.evaluate(`${promptField}.value`), prompt, "Hidden prompt stays mounted across machines");
  assert.equal(await browser.evaluate(`${accountDraft}.value`), accountDraftName, "Visited account editor retains its unsaved preset across destinations");
  assert.equal(await browser.evaluate(`${element(`${generator} .plugin-atyrode_code__account-exclusions`)}.textContent.includes(${JSON.stringify(exclusion.scope)})`), true,
    "The account draft keeps its nonempty unobserved exclusion instead of importing another machine’s pool");
  assert.equal(await browser.evaluate(`${thinking}.querySelector('[aria-checked="true"]').dataset.value`), localThinking, "Local thinking dial survives the switch");
  assert.equal(await browser.evaluate(`${plans}.querySelector('[aria-checked="true"]').dataset.value`), "true", "planYolo remains a profile choice, not a native permission");
  await click(browser, workspaceButton("Profile"));
  await click(browser, workspaceButton("Save profile"));
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
  await click(browser, workspaceButton("Profile"));
  assert(reads.length > 0 && reads.every(input => input.containerId === first.containerId && Object.keys(input).length === 1),
    "Ordinary browser configuration reads use only the container, never per-machine fanout or implicit legacy fallback");
  assert.equal(await browser.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches"), true);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await until(browser, "responsive profile remains usable", `${promptField}.getBoundingClientRect().width > 0`);
  await click(browser, promptField);
  await key(browser, "End", 35);
  assert.equal(await browser.evaluate(`document.activeElement === ${promptField}`), true, "The prompt remains pointer- and keyboard-accessible at the narrow viewport");
  assert.equal(await browser.evaluate(`${promptField}.value`), prompt, "Responsive layout keeps the same prompt");
  await browser.send("Emulation.clearDeviceMetricsOverride", {});
  assert.deepEqual(await ownerAction(server, "engine.jobs.listDeployments", { pluginId: "atyrode.omp", limit: 100 }), deployments,
    "Destination selection, planYolo and shared profile edits never grant or revoke native approval");
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
    const onboarding = element(`${generator} [aria-label="First-use setup"]`);
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
      await until(browser, "absent configuration mounts the hidden first-use editor", `${onboarding}?.closest('[hidden]') !== null && ${onboarding} !== null`);
      assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(modal)}) === null`), true,
        "A first-use review in a hidden frame must not make the visible document inert");
      await click(browser, workspaceButton("Accounts"));
      await key(browser, "Tab", 9);
      assert.equal(await browser.evaluate(`document.activeElement === ${workspaceButton("Models")}`), true,
        "Keyboard navigation still reaches the visible workbench after the absent read");
      await key(browser, "Enter", 13);
      await until(browser, "keyboard navigation still activates Models", `${workspaceButton("Models")}.getAttribute('aria-current') === 'page'`);
      await click(browser, workspaceButton("Profile"));
      await until(browser, "first-use review opens only after Profile is visible", `${element(modal)} !== null && ${element(modal)}.getClientRects().length > 0`);
      await key(browser, "Escape", 27);
      await until(browser, "deferred first-use review closes normally", `${element(modal)} === null`);
      assert.equal(await browser.evaluate(`document.activeElement === ${workspaceButton("Choose or reconsider capabilities")}`), true,
        "Escape returns focus to the visible permission trigger");
      await click(browser, workspaceButton("Models"));
      await click(browser, workspaceButton("Profile"));
      assert.equal(await browser.evaluate(`${element(modal)} === null`), true,
        "Revisiting does not repeat an already dismissed first-use modal");
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
    const retry = `[...document.querySelectorAll('${usage} button')].find(el => el.textContent.trim() === 'Retry usage')`;
    await control(browser, "standalone Usage can retry before any successful configuration", retry, false);
    assert(failures > 0, "The retry control follows an injected configuration failure");
    assert.equal(await browser.evaluate(`${element(`${usage} [title="Saved account pool"]`)} === null`), true);
    failConfiguration = false;
    await click(browser, retry);
    await until(browser, "retry recovers the real saved account pool", `${element(`${usage} [title="Saved account pool"]`)} !== null`);
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
      for (const option of routes) await control(browser, "unapproved folder options remain disabled", workspaceButton(option.label), true);
      folderReady = true;
      await click(browser, workspaceButton("Setup"));
      await control(browser, "selected folder action resumes without discovery or session readiness", workspaceButton(route.label), false);
      await control(browser, "unselected folder action still requires its own permission", workspaceButton(routes.find(option => option !== route)!.label), true);
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

/** Synthetic OMP review responses exercise browser invalidation only. Code's real
 * policy composes synthetic account facts; OMP preparation always refuses.
 * This cannot create credentials, approve consent or open a terminal. */
async function syntheticPreviewScenario(browser: BrowserInstance, server: TestServer, writer: TokenGrant, first: Target, second: Target): Promise<void> {
  const saved = await readConfiguration(server, writer, first);
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
  let previewRequests = 0, prepareRequests = 0, holdNextPreview = false, intercepting = true;
  let reviewedInput: Record<string, unknown> | null = null;
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
      if (name === "atyrode.omp.accounts.accounts") {
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
      } else if (name === "atyrode.omp.reviewSession") {
        previewRequests++;
        assert.equal(input.containerId, first.containerId);
        assert.equal(input.machineId, first.machineId, "An unprepared destination cannot request a session review");
        assert.equal(input.expectedDefaultsRevision, defaultsRevision);
        reviewedInput = input;
        if (holdNextPreview) { holdNextPreview = false; await new Promise<void>(resolve => { held.release = resolve; }); held.release = null; }
        outcome = { ok: true, result: { destination: first, operationId, pins, reviewDigest, defaultsRevision,
          effectiveOverlay: input.overlay, accountPool: input.accountPool } };
      } else if (name === "atyrode.omp.prepareSession") {
        prepareRequests++;
        assert.deepEqual(input, { ...reviewedInput, reviewDigest }, "Prepare preserves the exact native target/defaults/overlay/prompt/account pool and review");
        outcome = { ok: false, denial: { rule: "forbidden", message: "omp_review_changed" } };
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
    await selectDestination(browser, generatorDestination, second.machineId);
    await control(browser, "second destination cannot reuse first destination review", launchControl, true);
    assert.equal(await browser.evaluate(`${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed`), "false", "Changing destination invalidates the existing review");
    assert.equal(prepareRequests, 0, "Destination selection never prepares a launch");
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
    await click(browser, launchControl);
    await until(browser, "current synthetic review displayed", `${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed === 'true'`);
    await click(browser, launchControl);
    await until(browser, "synthetic launch refusal is shown", `${element(`${generator} .plugin-atyrode_code_generator__feedback`)}?.dataset.failed === 'true'`);
    assert.equal(await browser.evaluate(`${element(`${generator} .plugin-atyrode_code_generator__launch`)}.dataset.reviewed`), "false", "A refused launch consumes its browser review");
    assert.equal(previewRequests, 3);
    assert.equal(prepareRequests, 1);
    if (fixtureFailure) throw fixtureFailure;
  } finally {
    held.release?.();
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
      await ownerAction(server, "engine.plugins.install", { source: bundle.file, sha256: bundle.sha256, hardened: ompFamily.includes(bundle.id) });
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
    const opened = await Promise.allSettled([openWorkspace(writerBrowser, server, writer, container.id), openWorkspace(viewerBrowser, server, viewer, container.id)]);
    for (const result of opened) if (result.status === "rejected") throw result.reason;
    const accountDestination = `${panel} .plugin-atyrode_code_accounts__target select`;
    await selectDestination(writerBrowser, accountDestination, target.machineId);
    await selectDestination(viewerBrowser, accountDestination, target.machineId);
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
    await click(writerBrowser, button("Initialize choices"));
    await control(writerBrowser, "writer initialized profile enabled", element(profile), false);
    await control(viewerBrowser, "viewer receives initialized read-only profile without reload", element(profile), true);
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
    const nameField = element(`${accounts} form[aria-label="Profile editor"] input[required]`);
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
    const hasPreset = `(() => { const select = ${element(profile)}; return select instanceof HTMLSelectElement && [...select.options].some(option => option.text === ${JSON.stringify(presetName)}); })()`;
    await until(writerBrowser, "writer saved profile visible", hasPreset);
    await until(viewerBrowser, "viewer receives saved profile without refresh", hasPreset);
    const saved = await readConfiguration(server, viewer, target);
    assert.equal(saved.revision, initialized.revision + 1, "Exactly one preset creation must be committed");
    assert.equal(saved.configuration?.updatedBy, writer.principal.id);
    const preset = saved.configuration?.accounts.presets.find(row => row.name === presetName);
    assert(preset, "The UI-created profile must be readable as shared configuration");

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
    phase = "deferred first-use and standalone Usage configuration recovery";
    await configurationRecoveryScenario(writerBrowser, server, writer, { containerId: firstUse.id }, target);
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
  console.log("PASS: packed Code in two real browsers and two permitted destinations; shared choices converge with viewer authority intact; drafts and visited views survive destination switches; hidden first-use setup keeps navigation interactive; standalone Usage retries failed configuration and recovers the saved account pool. Choices never grant native permission. Separate synthetic RPC responses exercise independent folder-only readiness and refused execution, preview invalidation/refusal and cross-machine pin fences; no provider/native-runtime/consent proof claimed.");
}

await run();
