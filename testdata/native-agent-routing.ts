// Verify the generated overlay through OMP's public role-resolution API.
// Actual child retries are a separate upstream runtime regression.
import assert from "node:assert/strict";
import path from "node:path";
import { YAML } from "bun";

const [root, overlayPath] = process.argv.slice(2);
const src = path.join(root, "packages/coding-agent/src");
const { Settings } = await import(path.join(src, "config/settings.ts"));
const { resolveAgentModelSelection } = await import(path.join(src, "config/model-resolver.ts"));
const config = YAML.parse(await Bun.file(overlayPath).text());
const roles = config.modelRoles;
const overrides = config.task.agentModelOverrides;
assert.ok(Object.keys(overrides).length > 0, "no generated agents exercised");
const settings = Settings.isolated({
	modelRoles: roles,
	"task.agentModelOverrides": overrides,
	"retry.fallbackChains": config.retry.fallbackChains,
	"retry.modelFallback": config.retry.modelFallback,
	defaultThinkingLevel: config.defaultThinkingLevel,
});
for (const [agent, override] of Object.entries(overrides)) {
	const selected = resolveAgentModelSelection({
		settings, settingsOverride: override, agentModel: "@default", activeModelPattern: roles.default,
	});
	assert.equal(selected.role, agent, `${agent}: native selection lost role identity`);
	assert.deepEqual(selected.patterns, [roles[agent]], `${agent}: lead/thinking changed`);
	console.log(`${agent}: native role ${selected.role}, model ${selected.patterns[0]}`);
}
console.log("Native role selection passed; no provider call or retry execution.");
