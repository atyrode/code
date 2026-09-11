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

const HELP = `Usage: bun plugins/scripts/verify-browser.ts [bundle-directory]
Uses the five prepacked Code family bundles (default: plugins/dist), never Code source.
MANIFOLD_DIR selects the pinned SDK checkout; default: the sibling manifold directory.
Requires installed SDK dependencies and Chromium (MANIFOLD_CHROMIUM may select its binary).
MANIFOLD_GATE_DIST may supply an existing SDK web build; otherwise gate-dist builds a
throwaway web bundle. Missing Chromium or any failed assertion is a failure, not a skip.
Starts only a disposable loopback server and an isolated testkit machine transport/terminal
host. No native job owner, native setup, terminals, OMP, inference or providers are invoked.
Proves real viewer/writer controls, server denial and live initialization/preset convergence.
This is UI/authority proof, NOT provider or native execution/readiness proof.`;
if (process.argv.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}
if (process.argv.length > 3 || process.argv[2]?.startsWith("-")) throw new Error(HELP);

const pluginRoot = resolve(import.meta.dir, "..");
const manifold = resolve(process.env.MANIFOLD_DIR ?? join(pluginRoot, "../../manifold"));
const bundleDirectory = resolve(process.argv[2] ?? join(pluginRoot, "dist"));
const family = ["atyrode.code", "atyrode.code.accounts", "atyrode.code.gateway", "atyrode.code.generator", "atyrode.code.usage"];
const panel = ".plugin-atyrode_code_accounts";
const accounts = `${panel} .plugin-atyrode_code__accounts`;
const profile = `${accounts} > .plugin-atyrode_code__account-toolbar select`;
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
  await browser.send("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: code });
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: code });
}

type Target = { containerId: string; machineId: string };
type Configuration = {
  revision: number;
  updatedBy: string;
  accounts: { activePreset: string | null; presets: { id: string; name: string }[] };
};
type ConfigurationRead = { revision: number; configuration: Configuration | null };
async function readConfiguration(server: TestServer, grant: TokenGrant, target: Target): Promise<ConfigurationRead> {
  const outcome = await callAction(server, grant.token, "atyrode.code.readConfiguration", target);
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
  // This native affordance is only rendered with a live authoring handle. Never
  // press it: its presence is proof of the old false permission signal, not consent.
  await until(browser, "real authoring handle in both workspaces", `${element(`button[aria-label="New terminal on ${machineName}"]`)} !== null`);
  await until(browser, "permitted online workspace machine selected", `(() => {
    const select = ${element(`${panel} .plugin-atyrode_code_accounts__target select`)};
    return select instanceof HTMLSelectElement && select.value !== '' && select.selectedOptions[0]?.textContent.includes(${JSON.stringify(machineName)});
  })()`);
}

async function run(): Promise<void> {
  // Fail before allocating fixture state if prerequisites are absent. Never pack as
  // fallback: the positional argument is also how CI proves an older artifact fails.
  Browser.detect();
  const expectedRevision = readFileSync(join(pluginRoot, "MANIFOLD_REV"), "utf8").trim();
  const revision = Bun.spawnSync(["git", "-C", manifold, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  assert(revision.success && revision.stdout.toString().trim() === expectedRevision, "MANIFOLD_DIR must be checked out at plugins/MANIFOLD_REV");
  const bundles = family.map(id => {
    const file = join(bundleDirectory, `${id}.manifold-plugin.json`);
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
      await ownerAction(server, "engine.plugins.install", { source: bundle.file, sha256: bundle.sha256, hardened: false });
    }
    phase = "isolated fixture machine";
    const enrolled = await enrollMachine(server, machineName);
    // testkit owns/reaps transport and terminal host. No native job-owner config is
    // provided, no native installation is made, and no terminal is opened.
    agent = await startAgent({ serverUrl: server.url, machineToken: enrolled.machineToken, name: machineName,
      env: { HOME: home, XDG_STATE_HOME: join(home, "state"), XDG_CONFIG_HOME: join(home, "config") } });
    assert.equal(agent.machineId, enrolled.machineId, "Fixture machine enrollment must match the live transport");
    const container = await createContainer(server, "Code browser regression", "canvas");
    const target = { containerId: container.id, machineId: agent.machineId };
    const writer = await mintToken(server, { principal: { kind: "human", name: "Code writer", color: "#336699" }, caps: ["containers:read", "containers:write", "services:read"] });
    const viewer = await mintToken(server, { principal: { kind: "human", name: "Code viewer", color: "#996633" }, caps: ["containers:read", "services:read"] });
    assert.notEqual(writer.principal.id, viewer.principal.id, "Writer and viewer must be different native identities");
    phase = "opening two independent workspaces";
    const opened = await Promise.allSettled([openWorkspace(writerBrowser, server, writer, container.id), openWorkspace(viewerBrowser, server, viewer, container.id)]);
    for (const result of opened) if (result.status === "rejected") throw result.reason;
    const documentMarker = randomBytes(16).toString("hex");
    await viewerBrowser.evaluate(`globalThis.__codeBrowserDocument = ${JSON.stringify(documentMarker)}`);

    phase = "viewer authority boundary";
    const empty = await readConfiguration(server, viewer, target);
    assert.equal(empty.configuration, null, "Initialization must start from shared absent configuration");
    const denied = await callAction(server, viewer.token, "atyrode.code.initializeConfiguration", { ...target, expectedRevision: empty.revision });
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
    await control(writerBrowser, "writer save-as enabled", button("save as…"), false);
    await control(viewerBrowser, "viewer save-as disabled", button("save as…"), true);
    await click(writerBrowser, button("save as…"));
    const nameField = element(`${accounts} form[aria-label="Profile editor"] input[required]`);
    await control(writerBrowser, "profile name field ready", nameField, false);
    await click(writerBrowser, nameField);
    await writerBrowser.typeText(presetName);
    await control(writerBrowser, "writer Save profile enabled", button("Save profile"), false);
    await click(writerBrowser, button("Save profile"));
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
    await control(viewerBrowser, "viewer remains unable to edit shared profiles", button("save as…"), true);
    assert.equal(await viewerBrowser.evaluate("globalThis.__codeBrowserDocument"), documentMarker, "Viewer preset convergence must not reload the document");
    phase = "proof complete";
  } catch (error) {
    // Driver/server diagnostics can contain admission URLs. Keep their raw text and
    // page console buffers out of the report; the bounded failing phase is enough
    // to locate the assertion without disclosing any fixture token.
    failure = error instanceof assert.AssertionError || error instanceof ProofFailure
      ? new Error(error.message)
      : new Error(`Browser proof failed during ${phase}`);
  } finally {
    const cleanup = async (name: string, action: () => unknown | Promise<unknown>) => {
      try { await action(); } catch { cleanupFailures.push(name); }
    };
    await cleanup("writer browser", () => writerBrowser.close());
    await cleanup("viewer browser", () => viewerBrowser.close());
    await cleanup("fixture machine", () => agent?.stop());
    await cleanup("fixture server", () => server?.stop());
    await cleanup("fixture data", () => rmSync(directory, { recursive: true, force: true }));
    await cleanup("generated web bundle", () => dist?.cleanup());
  }
  if (cleanupFailures.length) throw new Error(`Cleanup failed: ${cleanupFailures.join(", ")}${failure ? `; proof failed during ${phase}` : ""}`);
  if (failure) throw failure;
  console.log("PASS: packed Code in two real browsers; viewer authoring handle is not write permission; direct viewer mutation forbidden; writer UI initialization, preset creation and activation converge without viewer reload. No provider/native-runtime proof claimed.");
}

await run();
