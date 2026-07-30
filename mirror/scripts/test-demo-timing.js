/* eslint-disable no-console, jsdoc/require-jsdoc */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

const workspace = path.resolve(__dirname, "../..");
const firmwareSource = fs.readFileSync(path.join(workspace, "firmware/src/main.cpp"), "utf8");
const mirrorConfig = fs.readFileSync(path.join(workspace, "mirror/config/config.js"), "utf8");
const diagram = JSON.parse(fs.readFileSync(path.join(workspace, "firmware/diagram.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(workspace, "mirror/package.json"), "utf8"));

function cppNumber (name) {
	const match = firmwareSource.match(new RegExp(`constexpr unsigned long ${name} = (\\d+);`));
	assert.ok(match, `Missing firmware constant ${name}`);
	return Number(match[1]);
}

function configNumber (name) {
	const match = mirrorConfig.match(new RegExp(`${name}:\\s*(\\d+)`));
	assert.ok(match, `Missing Mirror config ${name}`);
	return Number(match[1]);
}

function durationMs (value) {
	const match = String(value).match(/^(\d+(?:\.\d+)?)(ms|s)$/);
	assert.ok(match, `Invalid Wokwi delay: ${value}`);
	return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}

function loadScenario (name) {
	const file = path.join(workspace, "firmware/scenarios", `${name}.yaml`);
	const scenario = YAML.parse(fs.readFileSync(file, "utf8"));
	assert.equal(scenario.version, 1, `${name}: version must be 1`);
	assert.ok(Array.isArray(scenario.steps) && scenario.steps.length > 0, `${name}: missing steps`);
	return scenario;
}

function controls (scenario, partId, control) {
	return scenario.steps
		.map((step) => step["set-control"])
		.filter((item) => item?.["part-id"] === partId && item.control === control)
		.map((item) => Number(item.value));
}

function fixedDelayTotal (scenario) {
	return scenario.steps.reduce((total, step) => (
		step.delay === undefined ? total : total + durationMs(step.delay)
	), 0);
}

const dhtIntervalMs = cppNumber("DHT_INTERVAL_MS");
const ldrIntervalMs = cppNumber("LDR_INTERVAL_MS");
const animationMs = configNumber("animationSpeed");
const mqttAndSocketBudgetMs = 400;
const worstCaseDhtToMirrorMs = dhtIntervalMs + mqttAndSocketBudgetMs + animationMs;
const worstCaseLdrToMirrorMs = ldrIntervalMs + mqttAndSocketBudgetMs + animationMs;

assert.ok(dhtIntervalMs <= 2000, "DHT22 interval must be <= 2000ms");
assert.ok(ldrIntervalMs <= 500, "LDR interval must be <= 500ms");
assert.ok(worstCaseDhtToMirrorMs <= 3000, "DHT22 end-to-end timing budget exceeds 3 seconds");
assert.ok(worstCaseLdrToMirrorMs <= 3000, "LDR end-to-end timing budget exceeds 3 seconds");

const partIds = new Set(diagram.parts.map((part) => part.id));
for (const required of ["esp", "dht", "ldr", "pir", "oled", "button", "touch", "led"]) {
	assert.ok(partIds.has(required), `diagram.json is missing ${required}`);
}

const supportedControls = {
	dht: new Set(["temperature", "humidity"]),
	ldr: new Set(["lux"]),
	button: new Set(["pressed"]),
	touch: new Set(["pressed"])
};
const scenarioFiles = fs.readdirSync(path.join(workspace, "firmware/scenarios"))
	.filter((file) => file.endsWith(".yaml"));
for (const file of scenarioFiles) {
	const scenario = loadScenario(path.basename(file, ".yaml"));
	for (const [index, step] of scenario.steps.entries()) {
		const keys = Object.keys(step);
		assert.equal(keys.length, 1, `${file} step ${index + 1}: exactly one action is required`);
		assert.ok(["delay", "set-control", "wait-serial"].includes(keys[0]), `${file} step ${index + 1}: unsupported action`);
		if (step.delay !== undefined) durationMs(step.delay);
		if (step["wait-serial"] !== undefined) {
			assert.ok(String(step["wait-serial"]).length > 0, `${file} step ${index + 1}: empty wait-serial`);
		}
		const control = step["set-control"];
		if (control) {
			assert.ok(partIds.has(control["part-id"]), `${file} step ${index + 1}: missing diagram part`);
			assert.ok(
				supportedControls[control["part-id"]]?.has(control.control),
				`${file} step ${index + 1}: unsupported control ${control["part-id"]}.${control.control}`
			);
		}
	}
}

const realisticDay = loadScenario("realistic-day");
const sensorCheck = loadScenario("sensor-check");
const realisticParts = new Set(
	realisticDay.steps.map((step) => step["set-control"]?.["part-id"]).filter(Boolean)
);
assert.deepEqual([...realisticParts].sort(), ["dht", "ldr"], "realistic-day may only drive DHT22 and LDR");

const temperatures = controls(realisticDay, "dht", "temperature");
const humidities = controls(realisticDay, "dht", "humidity");
const lightLevels = controls(realisticDay, "ldr", "lux");
assert.equal(temperatures.length, 8, "realistic-day must contain 8 temperature stages");
assert.equal(humidities.length, temperatures.length, "every temperature stage needs humidity");
assert.equal(lightLevels.length, temperatures.length, "every temperature stage needs LDR input");
assert.ok(temperatures.some((value) => value > 30), "realistic-day must trigger temperature warning");
assert.ok(temperatures.some((value) => value > 32), "realistic-day must trigger limit + 2C escalation");
assert.ok(temperatures.at(-1) <= 30, "realistic-day must clear temperature warning at the safe threshold");
assert.ok(humidities.some((value) => value > 80), "realistic-day must trigger humidity warning");
assert.ok(humidities.at(-1) <= 80, "realistic-day must clear humidity warning at the safe threshold");
assert.ok(lightLevels.some((value) => value < 80), "realistic-day must demonstrate dim lighting");
assert.ok(lightLevels.some((value) => value >= 160), "realistic-day must demonstrate normal brightness");

const stageDelays = realisticDay.steps
	.filter((step) => step.delay !== undefined)
	.map((step) => durationMs(step.delay));
assert.equal(stageDelays.length, temperatures.length, "every realistic-day stage needs an observation delay");
assert.ok(stageDelays.every((delay) => delay >= 8000), "every realistic-day stage must remain visible for >= 8s");

const startupBudgetMs = 15_000;
const realisticWorstCaseMs = fixedDelayTotal(realisticDay) + temperatures.length * dhtIntervalMs + startupBudgetMs;
assert.ok(realisticWorstCaseMs <= 120_000, "realistic-day worst-case duration exceeds 2 minutes");

const sensorCheckDelays = sensorCheck.steps
	.filter((step) => step.delay !== undefined)
	.map((step) => durationMs(step.delay));
assert.ok(sensorCheckDelays.every((delay) => delay >= 7000), "sensor-check stages must remain visible for >= 7s");

assert.equal(packageJson.scripts["demo:data"], "node ./scripts/demo-wokwi.js");
assert.equal(packageJson.scripts["demo:cloud"], "node ./scripts/demo-data.js");
assert.equal(packageJson.scripts["demo:day"], "node ./scripts/demo-wokwi.js --scenario realistic-day");

console.log(JSON.stringify({
	ok: true,
	timingBudgetMs: {
		dht22ToMirror: worstCaseDhtToMirrorMs,
		ldrToMirror: worstCaseLdrToMirrorMs,
		target: 3000
	},
	realisticDay: {
		stages: temperatures.length,
		fixedObservationMs: fixedDelayTotal(realisticDay),
		worstCaseWithStartupMs: realisticWorstCaseMs
	},
	validatedWokwiScenarios: scenarioFiles.length
}, null, 2));
