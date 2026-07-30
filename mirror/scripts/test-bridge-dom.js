/* eslint-disable no-console */

const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost:8080" });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.ESP32UiState = require("../modules/MMM-ESP32Bridge/lib/ui-state");

global.MM = {
	getModules: () => ({
		withClass: () => ({ enumerate: () => {} })
	})
};

let definition;
global.Module = {
	register: (_name, moduleDefinition) => {
		definition = moduleDefinition;
	}
};
require("../modules/MMM-ESP32Bridge/MMM-ESP32Bridge");

const bridge = Object.create(definition);
bridge.config = {
	...definition.defaults,
	mqtt: {
		host: "demo.s1.eu.hivemq.cloud",
		port: "8884",
		path: "/mqtt",
		username: "**SECRET_MIRROR_MQTT_USERNAME**",
		password: "**SECRET_MIRROR_MQTT_PASSWORD**",
		topicPrefix: "smartmirror/test"
	},
	services: {}
};
bridge.identifier = "module_1_MMM-ESP32Bridge";
bridge.file = (file) => file;
bridge.sendSocketNotification = () => {};
const sentNotifications = [];
bridge.sendNotification = (name, payload) => {
	sentNotifications.push({ name, payload });
};
const domUpdates = [];
bridge.updateDom = (speed) => domUpdates.push(speed);
bridge.start();

try {
	bridge.bridgeConnected = true;
	bridge.deviceOnline = true;
	bridge.lastSeen = Date.now();
	bridge.temperature = 31.2;
	bridge.humidity = 82.4;
	bridge.presence = true;
	bridge.ambientLight = 42;
	bridge.history = [
		{ timestamp: Date.now() - 60_000, temperature: 28, humidity: 70 },
		{ timestamp: Date.now(), temperature: 31.2, humidity: 82.4 }
	];
	bridge.historyStats = {
		count: 2,
		temperatureMin: 28,
		temperatureMax: 31.2,
		humidityAverage: 76.2
	};
	bridge.activeAlerts = [
		{
			id: "temperature-high",
			severity: "warning",
			title: "Nhiệt độ phòng cao",
			message: "Nhiệt độ 31.2°C đã vượt ngưỡng 30.0°C.",
			timestamp: Date.now()
		}
	];

	const dashboard = bridge.getDom();
	document.body.appendChild(dashboard);
	assert.match(dashboard.textContent, /PIR · CÓ NGƯỜI/);
	assert.match(dashboard.textContent, /LDR · 42 LUX · DIM/);
	assert.match(dashboard.textContent, /ĐỘ ẨM TB 76\.2%/);
	assert.equal(dashboard.querySelectorAll(".esp32-history-line").length, 2);
	assert.equal(dashboard.querySelectorAll(".esp32-alert-banner").length, 1);

	const stablePanel = dashboard;
	bridge.socketNotificationReceived("ESP32_DATA", {
		id: bridge.identifier,
		kind: "temperature",
		value: 29.6,
		receivedAt: Date.now()
	});
	assert.equal(dashboard, stablePanel, "telemetry must preserve the mounted panel node");
	assert.equal(
		dashboard.querySelector(".esp32-metric.temperature .esp32-metric-reading").textContent,
		"29.6\u00B0C"
	);
	assert.deepEqual(domUpdates, [], "telemetry must not call MagicMirror updateDom");

	const previousHistory = dashboard.querySelector(".esp32-history");
	bridge.socketNotificationReceived("ESP32_HISTORY", {
		id: bridge.identifier,
		points: [
			{ timestamp: Date.now() - 60_000, temperature: 29.1, humidity: 72 },
			{ timestamp: Date.now(), temperature: 29.6, humidity: 74 }
		],
		stats: {
			count: 2,
			temperatureMin: 29.1,
			temperatureMax: 29.6,
			humidityAverage: 73
		}
	});
	assert.equal(dashboard, stablePanel);
	assert.notEqual(dashboard.querySelector(".esp32-history"), previousHistory);
	assert.deepEqual(domUpdates, [], "history updates must replace only the chart section");

	bridge.socketNotificationReceived("ESP32_ALERT_STATE", {
		id: bridge.identifier,
		alerts: [
			{
				id: "temperature-high",
				severity: "warning",
				title: "Nhiệt độ phòng cao",
				message: "Nhiệt độ hiện tại 30.8°C, vượt ngưỡng 30.0°C.",
				value: 30.8,
				threshold: 30,
				timestamp: Date.now()
			}
		]
	});
	assert.match(bridge.makeAlertBanner().textContent, /hiện tại 30\.8°C/);
	assert.match(dashboard.querySelector(".esp32-alert-banner").textContent, /hiện tại 30\.8°C/);
	bridge.lastAlert = {
		id: "temperature-high",
		severity: "warning",
		title: "Nhiệt độ phòng cao",
		message: "Cảnh báo cũ không được giữ lại.",
		timestamp: Date.now()
	};
	bridge.socketNotificationReceived("ESP32_ALERT_STATE", {
		id: bridge.identifier,
		alerts: []
	});
	assert.equal(bridge.makeAlertBanner(), null, "resolved environmental warnings must disappear immediately");
	assert.equal(bridge.lastAlert, null);
	assert.equal(dashboard.querySelector(".esp32-alert-banner"), null);
	assert.deepEqual(domUpdates, [], "live alert changes must preserve the panel without fade animation");

	document.documentElement.scrollTop = 120;
	document.body.scrollTop = 80;
	bridge.applyViewMode("settings");
	assert.equal(document.documentElement.scrollTop, 0);
	assert.equal(document.body.scrollTop, 0);
	assert.deepEqual(sentNotifications.at(-1), {
		name: "ESP32_VIEW_MODE_CHANGED",
		payload: { mode: "settings" }
	});
	const settings = bridge.getDom();
	assert.ok(settings.querySelectorAll(".esp32-settings-section").length >= 8);
	assert.ok(settings.querySelectorAll(".esp32-setting-row").length >= 18);
	assert.equal(settings.querySelectorAll(".esp32-service-status-card").length, 4);
	assert.match(settings.textContent, /GỬI CẢNH BÁO THỬ/);

	bridge.notificationReceived(
		"ESP32_VIEW_MODE_REQUEST",
		{ mode: "normal" },
		{ name: "MMM-CalendarAgenda" }
	);
	assert.equal(bridge.viewMode, "normal");

	console.log("PIR/LDR dashboard, view synchronization, alert and Settings DOM tests passed");
} finally {
	bridge.stop();
	dom.window.close();
}
