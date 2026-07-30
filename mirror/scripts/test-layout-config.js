/* eslint-disable no-console */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../config/config");

const clock = config.modules.find((item) => item.module === "clock");
const bridge = config.modules.find((item) => item.module === "MMM-ESP32Bridge");
const calendar = config.modules.find((item) => item.module === "calendar");
const calendarAgenda = config.modules.find((item) => item.module === "MMM-CalendarAgenda");
const currentWeather = config.modules.find((item) => item.module === "weather" && item.config.type === "current");
const forecastWeather = config.modules.find((item) => item.module === "weather" && item.config.type === "forecast");

assert.equal(clock.position, "top_left");
assert.equal(bridge.position, "top_left");
assert.equal(calendar.position, "bottom_left");
assert.equal(calendar.config.maximumEntries, 500);
assert.equal(calendar.config.maximumNumberOfDays, 370);
assert.equal(calendar.config.broadcastPastEvents, true);
assert.equal(calendar.config.animationSpeed, 0, "calendar refreshes must not fade the whole panel");
assert.match(calendar.classes, /calendar-source/);
assert.equal(calendarAgenda.position, "top_left");
assert.equal(calendarAgenda.config.maximumEntries, 1);
assert.match(calendarAgenda.classes, /calendar/);
assert.equal(currentWeather.position, "top_right");
assert.match(currentWeather.classes, /weather-current/);
assert.equal(forecastWeather.position, "top_right");
assert.match(forecastWeather.classes, /weather-forecast/);
assert.equal(config.modules.some((item) => item.position === "middle_center"), false);

const customCss = fs.readFileSync(path.resolve(__dirname, "../config/custom.css"), "utf8");
const bridgeCss = fs.readFileSync(path.resolve(__dirname, "../modules/MMM-ESP32Bridge/MMM-ESP32Bridge.css"), "utf8");
assert.match(customCss, /--mirror-side-width:\s*clamp\(330px,\s*28vw,\s*420px\)/);
assert.match(customCss, /--mirror-settings-width:\s*1080px/);
assert.match(customCss, /@media \(width <= 720px\)/);
assert.match(customCss, /\.region\.top\.left \.container > \.module/);
assert.match(
	customCss,
	/\.region\.top\.right \.container > \.module[\s\S]*?margin-bottom:\s*var\(--mirror-stack-gap\)/
);
assert.match(
	customCss,
	/body:not\(\.esp32-settings-mode\) \.region\.top\.left \.module\.MMM-ESP32Bridge[\s\S]*?margin-bottom:\s*var\(--mirror-edge-calendar-gap\)/
);
assert.match(customCss, /--mirror-stack-gap:\s*16px/);
assert.match(customCss, /--mirror-edge-calendar-gap:\s*28px/);
const stackGap = Number(customCss.match(/--mirror-stack-gap:\s*(\d+)px/)?.[1]);
const edgeCalendarGap = Number(customCss.match(/--mirror-edge-calendar-gap:\s*(\d+)px/)?.[1]);
assert.ok(edgeCalendarGap > stackGap * 1.5, "Edge-to-calendar spacing must be more than 50% larger than clock-to-Edge");
assert.match(customCss, /\.weather-current \.type-temp[\s\S]*?flex-wrap:\s*wrap/);
assert.match(customCss, /\.weather-forecast table[\s\S]*?table-layout:\s*fixed/);
assert.match(customCss, /\.module\.calendar\.calendar-source[\s\S]*?display:\s*none/);
assert.doesNotMatch(
	customCss,
	/@media \(width <= 1180px\), \(height <= 820px\)/,
	"overview flow and scrolling must not depend on a zoom-sensitive media query"
);
assert.match(customCss, /html[\s\S]*?height:\s*auto[\s\S]*?overflow-y:\s*auto[\s\S]*?scrollbar-width:\s*none/);
assert.match(
	customCss,
	/body[\s\S]*?position:\s*relative[\s\S]*?height:\s*auto[\s\S]*?min-height:\s*100vh[\s\S]*?overflow:\s*visible/
);
assert.match(
	customCss,
	/\.region\.top\.bar,[\s\S]*?\.region\.bottom\.bar[\s\S]*?display:\s*grid[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
);
assert.match(customCss, /\.region\.top\.left,[\s\S]*?\.region\.bottom\.left[\s\S]*?justify-self:\s*start/);
assert.match(customCss, /\.region\.top\.right,[\s\S]*?\.region\.bottom\.right[\s\S]*?justify-self:\s*end/);
assert.match(
	customCss,
	/@media \(width <= 720px\)[\s\S]*?body[\s\S]*?display:\s*grid[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/
);
assert.match(customCss, /@media \(width <= 720px\)[\s\S]*?\.region\.top\.bar,[\s\S]*?display:\s*contents/);
assert.match(customCss, /\.region\.top\.left[\s\S]*?order:\s*10/);
assert.match(customCss, /\.region\.bottom\.left[\s\S]*?order:\s*20/);
assert.match(customCss, /\.region\.top\.right[\s\S]*?order:\s*30/);
assert.match(customCss, /\.region\.bottom\.right[\s\S]*?order:\s*40/);
assert.match(
	customCss,
	/body:not\(\.esp32-settings-mode\):not\(\.esp32-calendar-mode\)::-webkit-scrollbar[\s\S]*?display:\s*none/
);
assert.match(
	customCss,
	/Use document flow at every zoom level[\s\S]*?\.region\.top\.bar,[\s\S]*?position:\s*relative/,
	"wide overview must use flow layout so tall columns contribute to page scroll"
);
assert.match(
	customCss,
	/body\.esp32-settings-mode \.region\.top\.left[\s\S]*?width:\s*min\(100%,\s*var\(--mirror-settings-width\)\)[\s\S]*?max-width:\s*var\(--mirror-settings-width\)/,
	"Settings must not inherit the 420px Edge column limit"
);
assert.match(
	customCss,
	/\.esp32-settings-panel[\s\S]*?max-height:\s*calc\(100dvh - var\(--mirror-responsive-gap\) - var\(--mirror-responsive-gap\)\)[\s\S]*?overflow-y:\s*auto/,
	"Settings must keep a viewport-bounded scroll container at every zoom level"
);
const bridgeScript = fs.readFileSync(path.resolve(__dirname, "../modules/MMM-ESP32Bridge/MMM-ESP32Bridge.js"), "utf8");
assert.match(
	bridgeScript,
	/window\.matchMedia\("\(max-width: 720px\)"\)/,
	"scroll reset should only follow the one-column layout transition"
);
assert.match(customCss, /body\.esp32-calendar-mode \.region\.bottom\.left[\s\S]*?display:\s*none/);
assert.match(
	customCss,
	/body\.esp32-hide-calendar:not\(\.esp32-calendar-mode\) \.module\.calendar/,
	"hiding the overview calendar must not hide the dedicated Calendar workspace"
);
assert.doesNotMatch(
	customCss,
	/body\.esp32-hide-calendar \.module\.calendar/,
	"do not apply the hidden-calendar setting unconditionally"
);
const agendaCss = fs.readFileSync(path.resolve(__dirname, "../modules/MMM-CalendarAgenda/MMM-CalendarAgenda.css"), "utf8");
assert.match(agendaCss, /\.calendar-workspace-portal[\s\S]*?position:\s*fixed/);
assert.match(agendaCss, /\.calendar-workspace-portal[\s\S]*?z-index:\s*1500/);
assert.match(
	agendaCss,
	/\.calendar-workspace-toolbar[\s\S]*?display:\s*grid[\s\S]*?grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto/
);
assert.match(agendaCss, /\.calendar-week-header[\s\S]*?position:\s*sticky/);
assert.match(agendaCss, /\.calendar-week-all-day[\s\S]*?position:\s*sticky/);
assert.match(bridgeCss, /\.esp32-card-title[\s\S]*?white-space:\s*normal/);
assert.match(bridgeCss, /\.esp32-panel[\s\S]*?container-name:\s*esp32-panel[\s\S]*?container-type:\s*inline-size/);
assert.match(bridgeCss, /\.esp32-settings-grid[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
assert.match(bridgeCss, /\.esp32-setting-row[\s\S]*?min-width:\s*0/);
assert.match(bridgeCss, /@container esp32-panel \(width <= 720px\)/);
assert.match(bridgeCss, /@container esp32-panel \(width <= 420px\)/);

const diagram = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../firmware/diagram.json"), "utf8"));
const oled = diagram.parts.find((part) => part.id === "oled");
const pir = diagram.parts.find((part) => part.id === "pir");
const ldr = diagram.parts.find((part) => part.id === "ldr");
const otherTop = Math.max(...diagram.parts.filter((part) => part.id !== "oled").map((part) => part.top));
assert.ok(oled);
assert.equal(pir?.type, "wokwi-pir-motion-sensor");
assert.equal(ldr?.type, "wokwi-photoresistor-sensor");
assert.ok(oled.top - otherTop >= 150, "OLED must stay in a separate bottom zone");
assert.equal(diagram.connections.some(([source, target]) => [source, target].includes("esp:27") && [source, target].includes("pir:OUT")), true);
assert.equal(diagram.connections.some(([source, target]) => [source, target].includes("esp:34") && [source, target].includes("ldr:AO")), true);

const oledConnections = diagram.connections.filter(([source]) => source.startsWith("oled:"));
assert.equal(oledConnections.length, 4);
for (const [, , , route] of oledConnections) {
	assert.equal(route.includes("*"), true, "OLED wire must route both source and target ends");
	assert.match(route[0], /^v-[1-9]\d*(?:\.\d+)?$/, "OLED wire must leave the top pins upward");
}

console.log("Left/right overview regions, responsive scroll, calendar UI and OLED wire corridor tests passed");
