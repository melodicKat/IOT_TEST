/* eslint-disable jsdoc/require-param-description, jsdoc/require-param-type, jsdoc/require-returns, no-console */

const fs = require("node:fs");
const path = require("node:path");
const mqtt = require("mqtt");

const workspaceEnv = path.resolve(__dirname, "../../.env");
const scenarioDirectory = path.resolve(__dirname, "../../demo/data");
const topicNamePattern = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
let stopRequested = false;

if (fs.existsSync(workspaceEnv)) process.loadEnvFile(workspaceEnv);

/**
 *
 */
function usage () {
	console.log(`
Demo dữ liệu Smart Mirror

  npm run demo:cloud -- --scenario realistic-day
  npm run demo:cloud -- --scenario hot-humid-alert --speed 4
  npm run demo:cloud -- --scenario network-recovery --loop
  npm run demo:cloud -- --list
  npm run demo:validate

Tùy chọn:
  --scenario <tên>   File JSON trong demo/data, mặc định realistic-day
  --speed <hệ số>    2 = nhanh gấp đôi, 0.5 = chậm một nửa
  --interval-ms <n>  Ghi đè khoảng cách giữa hai mẫu
  --loop             Lặp kịch bản đến khi nhấn Ctrl+C
  --dry-run          Chỉ in dữ liệu, không kết nối MQTT
  --list             Liệt kê các kịch bản
  --validate         Kiểm tra schema của toàn bộ bộ dữ liệu
`);
}

/**
 *
 * @param arguments_
 * @param index
 * @param flag
 */
function readFlagValue (arguments_, index, flag) {
	const value = arguments_[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} cần một giá trị`);
	return value;
}

/**
 *
 * @param arguments_
 */
function parseArguments (arguments_) {
	const options = {
		scenario: "realistic-day",
		speed: 1,
		intervalMs: null,
		loop: false,
		dryRun: false,
		list: false,
		validate: false
	};

	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--scenario") {
			options.scenario = readFlagValue(arguments_, index, argument);
			index += 1;
		} else if (argument === "--speed") {
			options.speed = Number(readFlagValue(arguments_, index, argument));
			index += 1;
		} else if (argument === "--interval-ms") {
			options.intervalMs = Number(readFlagValue(arguments_, index, argument));
			index += 1;
		} else if (argument === "--loop") {
			options.loop = true;
		} else if (argument === "--dry-run") {
			options.dryRun = true;
		} else if (argument === "--list") {
			options.list = true;
		} else if (argument === "--validate") {
			options.validate = true;
		} else if (argument === "--help" || argument === "-h") {
			usage();
			process.exit(0);
		} else {
			throw new Error(`Tùy chọn không hỗ trợ: ${argument}`);
		}
	}

	if (!(/^[a-z0-9][a-z0-9-]*$/).test(options.scenario)) {
		throw new Error("Tên scenario chỉ được chứa chữ thường, số và dấu gạch ngang");
	}
	if (!Number.isFinite(options.speed) || options.speed <= 0 || options.speed > 100) {
		throw new Error("--speed phải lớn hơn 0 và không quá 100");
	}
	if (options.intervalMs !== null
	  && (!Number.isInteger(options.intervalMs) || options.intervalMs < 250 || options.intervalMs > 600000)) {
		throw new Error("--interval-ms phải là số nguyên trong khoảng 250..600000");
	}
	return options;
}

/**
 *
 */
function scenarioNames () {
	return fs.readdirSync(scenarioDirectory)
		.filter((fileName) => fileName.endsWith(".json"))
		.map((fileName) => fileName.slice(0, -5))
		.sort();
}

/**
 *
 * @param scenario
 * @param name
 */
function validateScenario (scenario, name) {
	if (!scenario || typeof scenario !== "object") throw new Error(`${name}: JSON root phải là object`);
	if (typeof scenario.name !== "string" || scenario.name.trim().length === 0) {
		throw new Error(`${name}: thiếu name`);
	}
	if (!Number.isInteger(scenario.intervalMs) || scenario.intervalMs < 250 || scenario.intervalMs > 600000) {
		throw new Error(`${name}: intervalMs phải là số nguyên trong khoảng 250..600000`);
	}
	if (!Array.isArray(scenario.samples) || scenario.samples.length === 0) {
		throw new Error(`${name}: samples phải là mảng không rỗng`);
	}

	for (const [index, sample] of scenario.samples.entries()) {
		const label = `${name}.samples[${index}]`;
		if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
			throw new Error(`${label}: sample phải là object`);
		}
		if (sample.temperature !== undefined
		  && (!Number.isFinite(sample.temperature) || sample.temperature < -40 || sample.temperature > 80)) {
			throw new Error(`${label}: temperature ngoài khoảng -40..80`);
		}
		if (sample.humidity !== undefined
		  && (!Number.isFinite(sample.humidity) || sample.humidity < 0 || sample.humidity > 100)) {
			throw new Error(`${label}: humidity ngoài khoảng 0..100`);
		}
		if (sample.ambientLight !== undefined
		  && (!Number.isFinite(sample.ambientLight) || sample.ambientLight < 0 || sample.ambientLight > 200_000)) {
			throw new Error(`${label}: ambientLight ngoài khoảng 0..200000 lux`);
		}
		if (sample.presence !== undefined && typeof sample.presence !== "boolean") {
			throw new Error(`${label}: presence phải là boolean`);
		}
		if (sample.online !== undefined && typeof sample.online !== "boolean") {
			throw new Error(`${label}: online phải là boolean`);
		}
		if (sample.button !== undefined && !["normal", "calendar", "mirror"].includes(sample.button)) {
			throw new Error(`${label}: button chỉ nhận normal, calendar hoặc mirror`);
		}
		if (sample.touch !== undefined && !["tap", "doubleTap", "longPress"].includes(sample.touch)) {
			throw new Error(`${label}: touch chỉ nhận tap, doubleTap hoặc longPress`);
		}
		if (sample.touch !== undefined && !["normal", "calendar", "mirror", "settings"].includes(sample.view)) {
			throw new Error(`${label}: touch cần view normal, calendar, mirror hoặc settings`);
		}
		if (sample.online !== false
		  && sample.temperature === undefined
		  && sample.humidity === undefined
		  && sample.ambientLight === undefined
		  && sample.presence === undefined
		  && sample.button === undefined
		  && sample.touch === undefined) {
			throw new Error(`${label}: sample online phải có telemetry hoặc button`);
		}
	}
	return scenario;
}

/**
 *
 * @param name
 */
function loadScenario (name) {
	if (!scenarioNames().includes(name)) throw new Error(`Không tìm thấy scenario "${name}"`);
	const filePath = path.join(scenarioDirectory, `${name}.json`);
	return validateScenario(JSON.parse(fs.readFileSync(filePath, "utf8")), name);
}

/**
 *
 */
function mqttSettings () {
	const host = String(process.env.SECRET_HIVEMQ_HOST || process.env.HIVEMQ_HOST || "").trim().toLowerCase();
	const username = String(process.env.SECRET_ESP32_MQTT_USERNAME || process.env.MQTT_USER || "").trim();
	const password = String(process.env.SECRET_ESP32_MQTT_PASSWORD || process.env.MQTT_PASS || "");
	const topicPrefix = String(
		process.env.SECRET_MQTT_TOPIC_PREFIX || process.env.MQTT_TOPIC_PREFIX || "smartmirror/team01"
	).trim().replace(/^\/+|\/+$/g, "");
	const port = Number(process.env.SECRET_HIVEMQ_WS_PORT || 8884);

	if (host !== "hivemq.cloud" && !host.endsWith(".hivemq.cloud")) {
		throw new Error("SECRET_HIVEMQ_HOST phải thuộc *.hivemq.cloud");
	}
	if (port !== 8884) throw new Error("Demo chỉ cho phép secure WebSocket port 8884");
	if (!username || !password) throw new Error("Thiếu credential MQTT publisher của ESP32 trong .env");
	if (!topicNamePattern.test(topicPrefix)) throw new Error("MQTT topic prefix không hợp lệ");
	return { host, username, password, topicPrefix, port };
}

/**
 *
 * @param settings
 */
function connectMqtt (settings) {
	const client = mqtt.connect(`wss://${settings.host}:${settings.port}/mqtt`, {
		clientId: `smartmirror-demo-${process.pid}-${Date.now().toString(36)}`,
		username: settings.username,
		password: settings.password,
		protocolVersion: 4,
		clean: true,
		connectTimeout: 10000,
		keepalive: 20,
		reconnectPeriod: 0,
		rejectUnauthorized: true
	});

	return new Promise((resolve, reject) => {
		const onConnect = () => {
			client.off("error", onError);
			client.on("error", (error) => console.error(`[MQTT] ${error.message}`));
			resolve(client);
		};
		const onError = (error) => {
			client.off("connect", onConnect);
			client.end(true);
			reject(error);
		};
		client.once("connect", onConnect);
		client.once("error", onError);
	});
}

/**
 *
 * @param client
 * @param topic
 * @param payload
 * @param retain
 */
function publish (client, topic, payload, retain) {
	return new Promise((resolve, reject) => {
		client.publish(topic, payload, { qos: 0, retain }, (error) => (error ? reject(error) : resolve()));
	});
}

/**
 *
 * @param client
 */
function closeMqtt (client) {
	return new Promise((resolve) => client.end(false, {}, resolve));
}

/**
 *
 * @param milliseconds
 */
async function wait (milliseconds) {
	const endAt = Date.now() + milliseconds;
	while (!stopRequested && Date.now() < endAt) {
		await new Promise((resolve) => setTimeout(resolve, Math.min(200, endAt - Date.now())));
	}
}

/**
 *
 * @param sample
 */
function sampleSummary (sample) {
	const fields = [];
	if (sample.online === false) fields.push("OFFLINE");
	if (sample.temperature !== undefined) fields.push(`${sample.temperature.toFixed(1)}°C`);
	if (sample.humidity !== undefined) fields.push(`${sample.humidity.toFixed(1)}%`);
	if (sample.ambientLight !== undefined) fields.push(`${sample.ambientLight.toFixed(0)} lux`);
	if (sample.presence !== undefined) fields.push(`PIR=${sample.presence ? "CÓ NGƯỜI" : "TRỐNG"}`);
	if (sample.button) fields.push(`button=${sample.button.toUpperCase()}`);
	if (sample.touch) fields.push(`touch=${sample.touch}→${sample.view.toUpperCase()}`);
	return fields.join(" · ");
}

/**
 *
 * @param client
 * @param settings
 * @param online
 * @param reason
 * @param dryRun
 */
async function emitStatus (client, settings, online, reason, dryRun) {
	const payload = JSON.stringify({ online, led: online ? "ON" : "OFF", reason });
	if (!dryRun) await publish(client, `${settings.topicPrefix}/status`, payload, true);
}

/**
 *
 * @param client
 * @param settings
 * @param scenario
 * @param options
 * @param state
 */
async function emitScenario (client, settings, scenario, options, state) {
	const intervalMs = (options.intervalMs ?? scenario.intervalMs) / options.speed;

	for (const [index, sample] of scenario.samples.entries()) {
		if (stopRequested) return;
		const expectedOnline = sample.online !== false;

		if (expectedOnline !== state.online) {
			await emitStatus(client, settings, expectedOnline, expectedOnline ? "demo-connected" : "demo-network-outage", options.dryRun);
			state.online = expectedOnline;
		}

		if (expectedOnline) {
			if (sample.temperature !== undefined && !options.dryRun) {
				await publish(client, `${settings.topicPrefix}/telemetry/temperature`, sample.temperature.toFixed(1), true);
			}
			if (sample.humidity !== undefined && !options.dryRun) {
				await publish(client, `${settings.topicPrefix}/telemetry/humidity`, sample.humidity.toFixed(1), true);
			}
			if (sample.ambientLight !== undefined && !options.dryRun) {
				await publish(client, `${settings.topicPrefix}/telemetry/ambient-light`, sample.ambientLight.toFixed(0), true);
			}
			if (sample.presence !== undefined && !options.dryRun) {
				await publish(client, `${settings.topicPrefix}/telemetry/presence`, sample.presence ? "1" : "0", true);
			}
			if (sample.button) {
				state.buttonSequence += 1;
				const payload = JSON.stringify({
					event: "pressed",
					source: "button",
					gesture: "tap",
					sequence: state.buttonSequence,
					view: sample.button,
					uptimeMs: Date.now() - state.startedAt
				});
				if (!options.dryRun) {
					await publish(client, `${settings.topicPrefix}/event/button`, payload, false);
				}
			}
			if (sample.touch) {
				state.buttonSequence += 1;
				const payload = JSON.stringify({
					event: "touch",
					source: "touch",
					gesture: sample.touch,
					sequence: state.buttonSequence,
					view: sample.view,
					uptimeMs: Date.now() - state.startedAt
				});
				if (!options.dryRun) {
					await publish(client, `${settings.topicPrefix}/event/button`, payload, false);
				}
			}
		}

		const time = sample.time ? `[${sample.time}] ` : "";
		const note = sample.note ? ` — ${sample.note}` : "";
		console.log(`${String(index + 1).padStart(2, "0")}/${scenario.samples.length} ${time}${sampleSummary(sample)}${note}`);
		if (!options.dryRun && (!stopRequested || index < scenario.samples.length - 1)) await wait(intervalMs);
	}
}

/**
 *
 */
async function main () {
	const options = parseArguments(process.argv.slice(2));
	const names = scenarioNames();
	console.warn("[CLOUD-ONLY] Script này publish MQTT trực tiếp; không kiểm tra sensor, firmware hoặc OLED Wokwi.");

	if (options.list) {
		for (const name of names) {
			const scenario = loadScenario(name);
			console.log(`${name.padEnd(20)} ${scenario.samples.length} mẫu · ${scenario.name}`);
		}
		return;
	}
	if (options.validate) {
		for (const name of names) {
			const scenario = loadScenario(name);
			console.log(`PASS ${name}: ${scenario.samples.length} mẫu`);
		}
		console.log(`Đã kiểm tra ${names.length} bộ dữ liệu.`);
		return;
	}

	const scenario = loadScenario(options.scenario);
	const settings = options.dryRun
		? { topicPrefix: process.env.SECRET_MQTT_TOPIC_PREFIX || "smartmirror/team01" }
		: mqttSettings();
	const client = options.dryRun ? null : await connectMqtt(settings);
	const state = { online: false, buttonSequence: 0, startedAt: Date.now() };

	console.log(`Scenario: ${scenario.name}`);
	console.log(`Nguồn: demo/data/${options.scenario}.json`);
	console.log(options.dryRun ? "Chế độ dry-run: không gửi MQTT." : `MQTT/WSS đã kết nối · topic ${settings.topicPrefix}/#`);

	try {
		do {
			await emitScenario(client, settings, scenario, options, state);
			if (options.loop && !stopRequested) console.log("Lặp lại scenario…");
		} while (options.loop && !stopRequested);
	} finally {
		if (client) {
			try {
				await emitStatus(client, settings, false, stopRequested ? "demo-stopped" : "demo-complete", false);
			} finally {
				await closeMqtt(client);
			}
		}
	}
}

process.on("SIGINT", () => {
	stopRequested = true;
	console.log("\nĐang dừng demo và gửi trạng thái offline…");
});

main().catch((error) => {
	console.error(`Demo thất bại: ${error.message}`);
	process.exitCode = 1;
});
