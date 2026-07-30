/* eslint-disable no-console */

const assert = require("node:assert/strict");
const { parseMessage, validateMqttConfig, validateServiceConfig } = require("../modules/MMM-ESP32Bridge/lib/security");

const validConfig = {
	host: "demo.s1.eu.hivemq.cloud",
	port: "8884",
	path: "/mqtt",
	username: "mirror",
	password: "not-a-real-password",
	topicPrefix: "smartmirror/test01"
};

assert.equal(validateMqttConfig(validConfig).port, 8884);
assert.throws(() => validateMqttConfig({ ...validConfig, host: "broker.hivemq.com" }), /Blocked MQTT host/);
assert.throws(() => validateMqttConfig({ ...validConfig, port: "1883" }), /port 8884/);
assert.throws(() => validateMqttConfig({ ...validConfig, topicPrefix: "smartmirror/#" }), /forbidden/);

const prefix = validConfig.topicPrefix;
assert.deepEqual(parseMessage(`${prefix}/telemetry/temperature`, Buffer.from("25.6"), prefix), { kind: "temperature", value: 25.6 });
assert.deepEqual(parseMessage(`${prefix}/telemetry/humidity`, Buffer.from("61.2"), prefix), { kind: "humidity", value: 61.2 });
assert.deepEqual(parseMessage(`${prefix}/telemetry/presence`, Buffer.from("1"), prefix), { kind: "presence", value: true });
assert.deepEqual(parseMessage(`${prefix}/telemetry/ambient-light`, Buffer.from("42"), prefix), { kind: "ambientLight", value: 42 });
assert.equal(parseMessage(`${prefix}/status`, Buffer.from("{\"online\":true,\"led\":\"ON\"}"), prefix).value.online, true);
for (const view of ["normal", "calendar", "mirror"]) {
	assert.equal(
		parseMessage(`${prefix}/event/button`, Buffer.from(`{"event":"pressed","sequence":1,"view":"${view}"}`), prefix).value.view,
		view
	);
}
for (const [gesture, view] of [["tap", "calendar"], ["doubleTap", "settings"], ["longPress", "mirror"]]) {
	const parsed = parseMessage(
		`${prefix}/event/button`,
		Buffer.from(`{"event":"touch","source":"touch","gesture":"${gesture}","sequence":2,"view":"${view}"}`),
		prefix
	);
	assert.equal(parsed.value.source, "touch");
	assert.equal(parsed.value.gesture, gesture);
	assert.equal(parsed.value.view, view);
}
assert.throws(
	() => parseMessage(`${prefix}/event/button`, Buffer.from("{\"event\":\"pressed\",\"sequence\":1,\"view\":\"focus\"}"), prefix),
	/Invalid button/
);
assert.throws(
	() => parseMessage(
		`${prefix}/event/button`,
		Buffer.from("{\"event\":\"touch\",\"source\":\"button\",\"gesture\":\"doubleTap\",\"sequence\":2,\"view\":\"settings\"}"),
		prefix
	),
	/Invalid button/
);
assert.throws(() => parseMessage(`${prefix}/telemetry/humidity`, Buffer.from("120"), prefix), /Out-of-range/);
assert.throws(() => parseMessage(`${prefix}/telemetry/ambient-light`, Buffer.from("-1"), prefix), /Out-of-range/);
assert.equal(validateServiceConfig({}).history.sampleIntervalMs, 60_000);
assert.throws(
	() => validateServiceConfig({ alerts: { telegram: { enabled: true, token: "bad", chatId: "1" } } }),
	/Telegram bot token/
);

console.log("MMM-ESP32Bridge security and payload tests passed");
