/* eslint-disable no-console */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../config/config");

const weatherModules = config.modules.filter((item) => item.module === "weather");
assert.equal(weatherModules.length, 2);

const current = weatherModules.find((item) => item.config.type === "current");
const forecast = weatherModules.find((item) => item.config.type === "forecast");
assert.ok(current);
assert.ok(forecast);

for (const item of weatherModules) {
	assert.equal(item.config.weatherProvider, "openweathermap");
	assert.equal(item.config.animationSpeed, 0, "weather refreshes must not fade the whole panel");
	assert.equal(new URL(item.config.apiBase).protocol, "https:");
	assert.equal(new URL(item.config.apiBase).hostname, "api.openweathermap.org");
}

assert.equal(current.config.showHumidity, "below");
assert.equal(current.config.showFeelsLike, true);
assert.equal(current.config.showIndoorTemperature, true);
assert.equal(current.config.showIndoorHumidity, true);
assert.match(current.classes, /weather-current/);
assert.equal(current.position, "top_right");
assert.equal(forecast.config.showPrecipitationProbability, true);
assert.equal(forecast.config.maxNumberOfDays, 5);
assert.equal(forecast.config.colored, false);
assert.equal(forecast.header, "DỰ BÁO 5 NGÀY");
assert.match(forecast.classes, /weather-forecast/);
assert.equal(forecast.position, "top_right");

const currentTemplate = fs.readFileSync(path.resolve(__dirname, "../defaultmodules/weather/current.njk"), "utf8");
assert.match(currentTemplate, /class="weather-indoor-readings"/);
assert.match(currentTemplate, /class="small weather-indoor-temperature"/);
assert.match(currentTemplate, /class="small weather-indoor-humidity"/);
assert.doesNotMatch(currentTemplate, /style="[^"]*(?:display|position|text-align)/);

console.log("Weather HTTPS endpoint and display configuration tests passed");
