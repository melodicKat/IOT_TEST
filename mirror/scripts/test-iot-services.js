/* eslint-disable no-console */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { HistoryStore, historyPayload } = require("../modules/MMM-ESP32Bridge/lib/history-store");
const { RuleEngine } = require("../modules/MMM-ESP32Bridge/lib/rule-engine");

const nodeHelperSource = fs.readFileSync(
	path.resolve(__dirname, "../modules/MMM-ESP32Bridge/node_helper.js"),
	"utf8"
);
assert.match(
	nodeHelperSource,
	/for \(const alert of result\.recovered\)[\s\S]*?ESP32_ALERT_RECOVERY[\s\S]*?this\.deliverAlert\(context,\s*alert\)/,
	"recovery events must be forwarded to the UI state and external notifier"
);

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "smartmirror-history-"));
const historyFile = path.join(temporaryDirectory, "history.jsonl");
let now = Date.now() - 120_000;

try {
	const history = new HistoryStore({
		filePath: historyFile,
		sampleIntervalMs: 60_000,
		now: () => now
	});
	assert.ok(history.record({ temperature: 25, humidity: 60, lux: 400, presence: true }, now));
	now += 30_000;
	assert.equal(history.record({ temperature: 26, humidity: 62, lux: 200, presence: true }, now), null);
	now += 30_000;
	assert.ok(history.record({ temperature: 31, humidity: 82, lux: 40, presence: false }, now));
	const payload = history.getPayload();
	assert.equal(payload.stats.count, 2);
	assert.equal(payload.stats.humidityAverage, 71);
	assert.equal(payload.stats.temperatureMax, 31);

	const merged = historyPayload(history.samples, now, 24, 288);
	assert.equal(merged.points.length, 2);

	const engine = new RuleEngine({
		temperatureHighC: 30,
		humidityHighPct: 80,
		cooldownMs: 60_000
	});
	const first = engine.evaluate({ temperature: 31, humidity: 82 }, now);
	assert.deepEqual(first.triggered.map((alert) => alert.id).sort(), ["humidity-high", "temperature-high"]);
	assert.equal(first.active.length, 2);
	assert.equal(first.recovered.length, 0);

	const repeated = engine.evaluate({ temperature: 31.5, humidity: 81 }, now + 10_000);
	assert.equal(repeated.triggered.length, 0);
	const currentTemperatureAlert = repeated.active.find((alert) => alert.id === "temperature-high");
	assert.equal(currentTemperatureAlert.value, 31.5);
	assert.match(currentTemperatureAlert.message, /hiện tại 31\.5°C/);

	const exactlyTwoDegreesOver = engine.evaluate({ temperature: 32, humidity: 81 }, now + 20_000);
	assert.equal(exactlyTwoDegreesOver.triggered.length, 0, "exactly limit + 2C must not send an escalation");

	const escalated = engine.evaluate({ temperature: 32.1, humidity: 81 }, now + 20_001);
	assert.deepEqual(escalated.triggered.map((alert) => alert.id), ["temperature-high-escalated"]);
	assert.equal(escalated.triggered[0].event, "escalated");
	assert.match(escalated.triggered[0].message, /hiện tại 32\.1°C/);

	const escalationCooldown = engine.evaluate({ temperature: 33, humidity: 81 }, now + 30_000);
	assert.equal(escalationCooldown.triggered.length, 0);
	const escalationAfterCooldown = engine.evaluate({ temperature: 33, humidity: 81 }, now + 80_002);
	assert.deepEqual(escalationAfterCooldown.triggered.map((alert) => alert.id), ["temperature-high-escalated"]);

	const temperatureRecovered = engine.evaluate({ temperature: 29.9, humidity: 81 }, now + 90_000);
	assert.deepEqual(temperatureRecovered.recovered.map((alert) => alert.id), ["temperature-normal"]);
	assert.match(temperatureRecovered.recovered[0].message, /hiện tại 29\.9°C/);
	assert.deepEqual(temperatureRecovered.active.map((alert) => alert.id), ["humidity-high"]);

	const humidityRecovered = engine.evaluate({ temperature: 29.9, humidity: 80 }, now + 100_000);
	assert.deepEqual(humidityRecovered.recovered.map((alert) => alert.id), ["humidity-normal"]);
	assert.equal(humidityRecovered.active.length, 0);

	const stableNormal = engine.evaluate({ temperature: 28, humidity: 70 }, now + 110_000);
	assert.equal(stableNormal.recovered.length, 0, "recovery report must only be emitted once");

	const newIncident = engine.evaluate({ temperature: 30.5, humidity: 70 }, now + 120_000);
	assert.deepEqual(newIncident.triggered.map((alert) => alert.id), ["temperature-high"]);

	console.log("History store and environment rule engine tests passed");
} finally {
	fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
