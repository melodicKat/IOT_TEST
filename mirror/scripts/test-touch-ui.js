/* eslint-disable no-console */

const assert = require("node:assert/strict");
const { classifyGesture, isUserInteractionKind, isViewMode, sanitizeSettings } = require("../modules/MMM-ESP32Bridge/lib/ui-state");

assert.equal(classifyGesture({ x: 10, y: 10, time: 0 }, { x: 15, y: 12, time: 150 }), "tap");
assert.equal(classifyGesture({ x: 100, y: 100, time: 0 }, { x: 10, y: 105, time: 300 }), "swipeLeft");
assert.equal(classifyGesture({ x: 10, y: 100, time: 0 }, { x: 100, y: 96, time: 300 }), "swipeRight");
assert.equal(classifyGesture({ x: 100, y: 150, time: 0 }, { x: 96, y: 20, time: 300 }), "swipeUp");
assert.equal(classifyGesture({ x: 100, y: 20, time: 0 }, { x: 96, y: 150, time: 300 }), "swipeDown");
assert.equal(classifyGesture({ x: 10, y: 10, time: 0 }, { x: 12, y: 12, time: 1500 }), "longPress");

assert.equal(isViewMode("settings"), true);
assert.equal(isViewMode("admin"), false);
assert.equal(isUserInteractionKind("button"), true);
assert.equal(isUserInteractionKind("temperature"), false);
assert.equal(isUserInteractionKind("humidity"), false);
assert.equal(isUserInteractionKind("status"), false);
assert.equal(sanitizeSettings({}).autoMirrorSeconds, 60);

assert.deepEqual(sanitizeSettings({
	brightness: 5,
	units: "imperial",
	showWeather: false,
	showCalendar: false,
	compactMode: true,
	touchFeedback: false,
	autoMirrorSeconds: 60,
	timeFormat: 12,
	offlineAfterSeconds: 30
}), {
	brightness: 30,
	units: "imperial",
	showWeather: false,
	showCalendar: false,
	compactMode: true,
	touchFeedback: false,
	autoMirrorSeconds: 60,
	timeFormat: 12,
	offlineAfterSeconds: 30,
	autoBrightness: true,
	darkLuxThreshold: 80,
	presenceWake: true,
	presenceMirrorSeconds: 30,
	temperatureAlertC: 30,
	humidityAlertPct: 80,
	telegramAlerts: true,
	gmailAlerts: true,
	showHistory: true
});
const sanitizedInvalid = sanitizeSettings({
	brightness: 500,
	autoMirrorSeconds: 99,
	timeFormat: 18,
	offlineAfterSeconds: 99
});
assert.equal(sanitizedInvalid.brightness, 100);
assert.equal(sanitizedInvalid.autoMirrorSeconds, 60);
assert.equal(sanitizedInvalid.timeFormat, 24);
assert.equal(sanitizedInvalid.offlineAfterSeconds, 20);
assert.equal(sanitizedInvalid.darkLuxThreshold, 80);
assert.equal(sanitizeSettings({ temperatureAlertC: 90 }).temperatureAlertC, 50);
assert.equal(sanitizeSettings({ humidityAlertPct: 10 }).humidityAlertPct, 30);

console.log("Touch gestures and settings state tests passed");
